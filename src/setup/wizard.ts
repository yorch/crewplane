import type { SafetyCheck } from "../binary-safety.ts";
import { claudePermissionModes, type Harness } from "../engine/harness.ts";
import { printablePath } from "../project.ts";
import {
  acceptBinary,
  type Detection,
  describeRejection,
  type ExecutableCheck,
  type Rejection,
} from "./detect.ts";
import { noPrior, type Prior, planEpochs } from "./epochs.ts";
import {
  acceptModel,
  acceptPiModel,
  type ClaudeSettings,
  defaultClaudeSettings,
  defaultImplementerId,
  defaultLimits,
  harnessesUsed,
  isTemplate,
  type LimitName,
  laneHarnesses,
  limitBounds,
  parseCost,
  parseImplementers,
  parseLimit,
  parseMcp,
  parseSettingSources,
  parseTaskIds,
  type RoleHarnesses,
  roleHarnesses,
  type SetupAnswers,
  SetupError,
  type SetupPolicy,
  type Template,
  templateSummary,
  templates,
} from "./templates.ts";

/** Operator I/O seam: tests drive the wizard with scripted answers. */
export interface WizardIO {
  /** One line of input, or null at end of input / Ctrl+C. */
  ask(prompt: string): Promise<string | null>;
  /** Human-facing text; always stderr in the CLI so stdout stays JSON. */
  write(text: string): void;
  close?(): void;
}

/** Ctrl+C or end of input: the operator abandoned setup. */
export class SetupAborted extends Error {
  constructor() {
    super("Setup cancelled; nothing was written");
  }
}

export const maxAttempts = 3;

export interface WizardContext {
  policy: SetupPolicy;
  detection: Detection;
  discoveredTasks: string[];
  discoveredImplementers: string[];
  check: ExecutableCheck;
  /** Binary safety probe applied to every accepted executable. */
  safety: SafetyCheck;
  /** PATH candidates refused as unsafe, listed with their reason. */
  rejected?: Rejection[];
  /** Installed configuration and records, read-only, for harness switches. */
  prior?: Prior;
  /** Why a stop confirmation cannot be recorded now, or null. */
  verifyStopped?: () => Promise<string | null>;
  /** Throws a clear error when the `--out` path would be refused. */
  checkOut?: (path: string) => Promise<void>;
  now: () => Date;
  /** Fresh Pi session epoch. */
  epoch: () => string;
  /** Redacted review text for the confirmation step. */
  review: (answers: SetupAnswers) => string;
}

export interface WizardResult {
  answers: SetupAnswers;
  template: Template | "custom";
  install: boolean;
  out?: string;
}

async function prompt<T>(
  io: WizardIO,
  question: string,
  parse: (text: string) => T | Promise<T>,
  fallback?: string,
  /** What to show for the default when it must not be echoed verbatim. */
  display: (value: string) => string = (value) => value,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await io.ask(
      `${question}${fallback !== undefined && fallback !== "" ? ` [${display(fallback)}]` : ""}: `,
    );
    if (raw === null) throw new SetupAborted();
    const text =
      raw.trim() === "" && fallback !== undefined ? fallback : raw.trim();
    try {
      return await parse(text);
    } catch (error) {
      io.write(
        `  invalid: ${error instanceof Error ? error.message : "invalid answer"}${attempt < maxAttempts ? " (try again)" : ""}\n`,
      );
    }
  }
  throw new SetupError("Too many invalid answers; nothing was written");
}

const yesNo = (text: string) => {
  if (/^(y|yes)$/i.test(text)) return true;
  if (/^(n|no)$/i.test(text)) return false;
  throw new SetupError("answer yes or no");
};

async function choose<T extends string>(
  io: WizardIO,
  question: string,
  options: readonly T[],
  fallback: T,
  label: (option: T) => string = (option) => option,
): Promise<T> {
  io.write(`${question}\n`);
  for (const [index, option] of options.entries())
    io.write(`  ${index + 1}) ${label(option)}\n`);
  return prompt(
    io,
    "Choice (number or name)",
    (text) => {
      const byName = options.find((option) => option === text);
      if (byName) return byName;
      const index = /^\d{1,2}$/.test(text) ? Number(text) - 1 : -1;
      const byNumber = options[index];
      if (byNumber !== undefined) return byNumber;
      throw new SetupError(`choose one of: ${options.join(", ")}`);
    },
    fallback,
  );
}

export async function runWizard(
  io: WizardIO,
  context: WizardContext,
): Promise<WizardResult> {
  const { policy, detection } = context;
  io.write("Crewplane guided setup. Nothing is written until you confirm.\n");
  io.write(
    "No harness is started; only executables on PATH are looked up.\n\n",
  );
  for (const harness of ["codex", "claude", "opencode", "pi"] as const)
    io.write(
      `  ${harness}: ${detection[harness] ? printablePath(detection[harness]) : "not found on PATH"}\n`,
    );
  for (const rejection of context.rejected ?? [])
    io.write(`  ${describeRejection(rejection)}\n`);
  io.write(
    `\nProject lanes: coordinator ${policy.coordinator}; reviewers ${policy.reviewers.join(", ") || "(none)"}\n\n`,
  );

  // Template / per-role harness.
  const pick = await choose(
    io,
    "Template:",
    [...templates, "custom"] as const,
    detection.claude && detection.opencode ? "mixed" : "codex",
    (option) =>
      option === "custom"
        ? "custom: choose a harness for coordinator, implementers and reviewers"
        : `${option}: ${templateSummary[option]}`,
  );
  let roles: RoleHarnesses;
  let template: Template | "custom" = pick;
  if (pick === "mixed") {
    const reviewer = await choose(
      io,
      "Reviewer harness:",
      ["opencode", "pi"] as const,
      "opencode",
      (option) =>
        option === "pi" ? "pi: no-tools advisory reviewers" : "opencode",
    );
    roles = roleHarnesses("mixed", reviewer);
  } else if (pick === "custom") {
    const pickHarness = (role: string, list: readonly Harness[]) =>
      choose(io, `Harness for ${role}:`, list, list[0] as Harness);
    const main = ["codex", "claude", "opencode"] as const;
    roles = {
      coordinator: await pickHarness("the coordinator", main),
      implementer: await pickHarness("implementers", main),
      reviewer: await pickHarness("reviewers", [...main, "pi"] as const),
    };
  } else roles = roleHarnesses(pick);
  if (isTemplate(pick)) template = pick;

  // Binaries.
  const binaries: SetupAnswers["binaries"] = {};
  for (const harness of harnessesUsed(roles)) {
    const found = detection[harness];
    binaries[harness] = await prompt(
      io,
      `Absolute path to the ${harness} executable`,
      (text) => acceptBinary(text, harness, context.check, context.safety),
      found ?? undefined,
      printablePath,
    );
  }

  // Models.
  const models: SetupAnswers["models"] = {};
  let piModel: SetupAnswers["piModel"];
  for (const harness of harnessesUsed(roles)) {
    if (harness === "pi") {
      const text = await prompt(
        io,
        "Pi model as PROVIDER/MODEL (blank for the harness default)",
        (value) => (value === "" ? null : acceptPiModel(value)),
        "",
      );
      if (text) piModel = text;
      continue;
    }
    const label =
      harness === "opencode"
        ? "OpenCode model (provider/model[#variant], required)"
        : harness === "claude"
          ? "Claude model (alias or full identifier, required)"
          : "Codex model (blank for the harness default)";
    const model = await prompt(
      io,
      label,
      (text) => acceptModel(harness, text),
      harness === "codex" ? "" : undefined,
    );
    if (model) models[harness] = model;
  }

  // Claude safety fields.
  let claude: ClaudeSettings = { ...defaultClaudeSettings };
  if (harnessesUsed(roles).includes("claude")) {
    io.write(
      "\nClaude Code isolation (bypass and manual permission modes are not offered).\n",
    );
    const implementerMode = await choose(
      io,
      "Permission mode for implementer lanes (coordinator and reviewers use plan):",
      claudePermissionModes,
      defaultClaudeSettings.implementerMode,
    );
    const mcp = await prompt(
      io,
      "claudeMcp (strict adds --strict-mcp-config; inherit uses your MCP servers)",
      parseMcp,
      defaultClaudeSettings.mcp,
    );
    const settingSources = await prompt(
      io,
      "claudeSettingSources (comma list of user,project,local)",
      parseSettingSources,
      defaultClaudeSettings.settingSources.join(","),
    );
    const maxCostUsdPerRun = await prompt(
      io,
      "Cost cap per Claude invocation in USD (0.01-100)",
      parseCost,
      String(defaultClaudeSettings.maxCostUsdPerRun),
    );
    claude = { implementerMode, mcp, settingSources, maxCostUsdPerRun };
  }

  // Lanes and tasks.
  const reserved = new Set([policy.coordinator, ...policy.reviewers]);
  const implementers = await prompt(
    io,
    "Implementer lane IDs (comma list; must match task card owners)",
    (text) => {
      const ids = parseImplementers(text);
      const clash = ids.find((id) => reserved.has(id));
      if (clash)
        throw new SetupError(
          `${clash} is already the coordinator or a reviewer lane`,
        );
      return ids;
    },
    (context.discoveredImplementers.length
      ? context.discoveredImplementers
      : [defaultImplementerId]
    ).join(","),
  );
  if (context.discoveredTasks.length)
    io.write(
      `\nTask cards found: ${context.discoveredTasks.slice(0, 20).join(", ")}${context.discoveredTasks.length > 20 ? ", ..." : ""}\n`,
    );
  const allowedTasks = await prompt(
    io,
    "Allowed task IDs (comma list; only these may ever run)",
    parseTaskIds,
    context.discoveredTasks.length
      ? context.discoveredTasks.join(",")
      : undefined,
  );

  // Limits.
  const limits = defaultLimits();
  for (const name of Object.keys(limitBounds) as LimitName[]) {
    const bounds = limitBounds[name];
    limits[name] = await prompt(
      io,
      `${name} (${bounds.min}-${bounds.max})`,
      (text) => parseLimit(name, text),
      String(bounds.default),
    );
  }

  // Stopped confirmation: recorded only on an explicit yes.
  io.write(
    "\nConfiguring requires that every old harness and supervisor for this project is stopped.\n",
  );
  const stopped = await prompt(
    io,
    "Is the supervisor stopped? Type yes to record the current UTC time",
    yesNo,
    "no",
  );

  if (stopped) {
    // Fail closed: never stamp a confirmation the control state contradicts.
    const problem = await context.verifyStopped?.();
    if (problem)
      throw new SetupError(
        `Refusing to record the stop confirmation: ${problem}. Stop the supervisor, then rerun setup`,
      );
  }

  const answers: SetupAnswers = {
    roles,
    binaries,
    models,
    ...(piModel ? { piModel } : {}),
    claude,
    allowedTasks,
    implementers,
    limits,
    ...(stopped ? { confirmedStoppedAt: context.now().toISOString() } : {}),
    ...(roles.reviewer === "pi" ? { sessionEpoch: context.epoch() } : {}),
  };

  const plan = planEpochs(
    laneHarnesses(answers, policy),
    context.prior ?? noPrior,
    context.epoch,
  );
  if (Object.keys(plan.epochs).length) answers.laneEpochs = plan.epochs;
  for (const note of plan.notes) io.write(`note: ${note}\n`);

  io.write(`\nReview:\n${context.review(answers)}\n`);
  if (!(await prompt(io, "Looks right? (yes/no)", yesNo, "no")))
    throw new SetupAborted();

  let install = false;
  if (stopped)
    install = await prompt(
      io,
      "Install into the private control directory now? (yes/no)",
      yesNo,
      "no",
    );
  else
    io.write(
      "Installing is unavailable until the stopped confirmation is recorded.\n",
    );
  const out = await prompt(
    io,
    "Also write the JSON to a new file? Path, or blank to skip",
    async (text) => {
      if (text) await context.checkOut?.(text);
      return text;
    },
    "",
  );
  return {
    answers,
    template,
    install,
    ...(out ? { out } : {}),
  };
}
