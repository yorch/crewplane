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
  plainStyle,
  type Style,
  section,
  stripAnsi,
  table,
  wrap,
} from "./style.ts";
import {
  acceptModel,
  acceptPiModel,
  type BuiltSetup,
  buildConfig,
  type ClaudeSettings,
  defaultClaudeSettings,
  defaultImplementerId,
  defaultLimits,
  enabledLaneCount,
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
  /** Redacted human summary for the confirmation step. */
  review: (answers: SetupAnswers) => string;
  /** Terminal styling; plain text when absent. */
  style?: Style;
  /** Task card directory from crewplane.json, named in guidance only. */
  tasksPath?: string;
}

export interface WizardResult {
  answers: SetupAnswers;
  template: Template | "custom";
  install: boolean;
  out?: string;
}

async function prompt<T>(
  io: WizardIO,
  style: Style,
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
        `  ${style.error("invalid:")} ${error instanceof Error ? error.message : "invalid answer"}${attempt < maxAttempts ? " (try again)" : ""}\n`,
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

/** Dim, wrapped, one-purpose explanation shown before a prompt. */
const explainer = (io: WizardIO, style: Style) => (text: string) =>
  io.write(
    wrap(text)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => `${style.dim(line)}\n`)
      .join(""),
  );

async function choose<T extends string>(
  io: WizardIO,
  style: Style,
  question: string,
  options: readonly T[],
  fallback: T,
  hintFor: (option: T) => string = () => "",
): Promise<T> {
  io.write(`${question}\n`);
  const names = options.map(
    (option) => option + (option === fallback ? " (default)" : ""),
  );
  const width = Math.max(...names.map((name) => name.length));
  for (const [index, option] of options.entries()) {
    const plain = names[index] as string;
    const name =
      option === fallback ? `${option} ${style.accent("(default)")}` : option;
    const hint = hintFor(option);
    io.write(
      `  ${index + 1}) ${name}${hint ? `${" ".repeat(width - plain.length + 2)}${style.dim(hint)}` : ""}\n`,
    );
  }
  return prompt(
    io,
    style,
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

const templateHint: Record<Template | "custom", string> = {
  codex: "every lane runs Codex",
  claude: "every lane runs Claude Code",
  opencode: "every lane runs OpenCode",
  mixed: "Claude Code plans and implements; reviewers run on OpenCode or Pi",
  custom: "pick a harness for the coordinator, implementers and reviewers",
};

const permissionHint: Record<string, string> = {
  acceptEdits: "edits files without asking; other risky tools still blocked",
  auto: "Claude Code's automatic permission mode",
  dontAsk:
    "tools not already allowed by your Claude settings are denied, not prompted",
  plan: "read-only: the agent can plan but not edit files",
};

const rule = (style: Style, text: string) =>
  `${style.bold(text)}\n${style.dim("-".repeat(text.length))}\n`;

/** Aligned plain-text grid; cells may carry styling (padding uses visible width). */
function grid(rows: string[][], indent = 2): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  return rows
    .map(
      (row) =>
        `${" ".repeat(indent)}${row
          .map((cell, i) =>
            i === row.length - 1
              ? cell
              : cell +
                " ".repeat((widths[i] as number) - stripAnsi(cell).length + 2),
          )
          .join("")}\n`,
    )
    .join("");
}

/**
 * Human review of what would be written. Shows lanes, limits, tasks and
 * executable paths; never environment values and never the raw JSON (the
 * full file is available through `--out` and in the stdout report).
 */
export function reviewSummary(
  style: Style,
  answers: SetupAnswers,
  policy: SetupPolicy,
  built: BuiltSetup = buildConfig(answers, policy),
): string {
  const lanes = built.config.lanes as Record<
    string,
    {
      enabled: boolean;
      harness?: string;
      model?: string;
      piModel?: { provider: string; id: string };
      claudePermissionMode?: string;
      piPermissions?: string;
    }
  >;
  const roleOf = (id: string) =>
    id === policy.coordinator
      ? "coordinator"
      : answers.implementers.includes(id)
        ? "implementer"
        : policy.reviewerRoles[id] === "visual"
          ? "reviewer (visual)"
          : "reviewer";
  const rows: string[][] = [
    ["Lane", "Role", "Harness", "Model", "Permissions", "State"].map((h) =>
      style.dim(h),
    ),
  ];
  for (const [id, lane] of Object.entries(lanes))
    rows.push([
      id,
      roleOf(id),
      lane.harness ?? "codex",
      lane.model ??
        (lane.piModel
          ? `${lane.piModel.provider}/${lane.piModel.id}`
          : style.dim("harness default")),
      lane.claudePermissionMode ?? lane.piPermissions ?? style.dim("-"),
      lane.enabled ? style.ok("enabled") : style.warn("disabled"),
    ]);
  let text = `${rule(style, "Lanes")}${grid(rows)}`;
  if (harnessesUsed(answers.roles).includes("claude"))
    text += table(
      style,
      [
        [
          "Claude",
          `MCP ${answers.claude.mcp}, settings ${answers.claude.settingSources.join("+")}, max $${answers.claude.maxCostUsdPerRun} per run`,
        ],
      ],
      2,
    );
  text += `\n${rule(style, "Limits")}${table(style, [
    ["Parallel runs", String(answers.limits.maxParallel)],
    ["Check interval", `${answers.limits.intervalSeconds}s`],
    ["Run time limit", `${answers.limits.maxRunMinutes} min`],
    ["Runs per hour", `${answers.limits.maxRunsPerHour} per lane`],
  ])}`;
  text += `\n${rule(style, "Allowed tasks")}  ${answers.allowedTasks.join(", ")}\n`;
  text += `\n${rule(style, "Executables")}${table(
    style,
    Object.entries(answers.binaries).map(([harness, path]) => [
      harness,
      printablePath(path as string),
    ]),
  )}`;
  text += `\n${style.dim("Supervisor stopped:")} ${
    answers.confirmedStoppedAt
      ? `recorded ${answers.confirmedStoppedAt}`
      : "not recorded (the file cannot be installed yet)"
  }\n`;
  if (built.notes.length)
    text += `\n${built.notes.map((n) => style.warn(`! ${n}`)).join("\n")}\n`;
  return text;
}

export async function runWizard(
  io: WizardIO,
  context: WizardContext,
): Promise<WizardResult> {
  const { policy, detection } = context;
  const style = context.style ?? plainStyle;
  const explain = explainer(io, style);
  const ask = <T>(
    question: string,
    parse: (text: string) => T | Promise<T>,
    fallback?: string,
    display?: (value: string) => string,
  ) => prompt(io, style, question, parse, fallback, display);

  io.write(`\n${style.bold("Crewplane guided setup")}\n`);
  io.write(
    wrap(
      "This writes a private configuration that says which agent harness runs each lane of your project. Nothing is run: only executables on PATH are looked up. Nothing is written until you confirm at the end.",
    ),
  );
  io.write(`\n${style.bold("Roles")}\n`);
  io.write(
    table(style, [
      ["coordinator", "plans the work and assigns tasks"],
      ["implementers", "write code, each in their own worktree"],
      ["reviewers", "check submissions; the visual reviewer validates UI"],
    ]),
  );
  const visualIds = policy.reviewers.filter(
    (id) => policy.reviewerRoles[id] === "visual",
  );
  io.write(`\n${style.bold("Lane IDs from crewplane.json")}\n`);
  io.write(
    table(style, [
      ["Coordinator", policy.coordinator],
      ["Implementers", style.dim("named below")],
      [
        "Reviewers",
        policy.reviewers.length
          ? policy.reviewers
              .map(
                (id) =>
                  id + (visualIds.includes(id) ? " (starts disabled)" : ""),
              )
              .join(", ")
          : "(none)",
      ],
    ]),
  );
  io.write(`\n${style.bold("Harnesses found on PATH")}\n`);
  io.write(
    table(
      style,
      (["codex", "claude", "opencode", "pi"] as const).map((harness) => [
        harness,
        detection[harness]
          ? style.ok(printablePath(detection[harness]))
          : style.dim("not found"),
      ]),
    ),
  );
  for (const rejection of context.rejected ?? [])
    io.write(`  ${style.warn(`! ${describeRejection(rejection)}`)}\n`);
  io.write(`\n${style.bold("Choose harnesses")}\n`);
  explain(
    "A template assigns a harness to each role. Pick custom to choose per role.",
  );

  // Template / per-role harness.
  const pick = await choose(
    io,
    style,
    "Template:",
    [...templates, "custom"] as const,
    detection.claude && detection.opencode ? "mixed" : "codex",
    (option) => templateHint[option],
  );
  let roles: RoleHarnesses;
  let template: Template | "custom" = pick;
  if (pick === "mixed") {
    explain(
      "Reviewers can run with full tools (opencode) or advisory-only (pi).",
    );
    const reviewer = await choose(
      io,
      style,
      "Reviewer harness:",
      ["opencode", "pi"] as const,
      "opencode",
      (option) =>
        option === "pi"
          ? "advisory only: every review pauses for you to relay with `crewplane resolve`"
          : "full reviewer with tools",
    );
    roles = roleHarnesses("mixed", reviewer);
  } else if (pick === "custom") {
    const pickHarness = (role: string, list: readonly Harness[]) =>
      choose(io, style, `Harness for ${role}:`, list, list[0] as Harness);
    const main = ["codex", "claude", "opencode"] as const;
    roles = {
      coordinator: await pickHarness("the coordinator", main),
      implementer: await pickHarness("implementers", main),
      reviewer: await pickHarness("reviewers", [...main, "pi"] as const),
    };
  } else roles = roleHarnesses(pick);
  if (isTemplate(pick)) template = pick;

  const used = harnessesUsed(roles);
  const usesClaude = used.includes("claude");
  const total = 5 + (usesClaude ? 1 : 0);
  let step = 0;
  const open = (title: string) =>
    io.write(section(style, ++step, total, title));

  // Binaries.
  open("Executables");
  explain(
    "Absolute path to each harness program. It is only checked, never run, and must not be replaceable by other users.",
  );
  const binaries: SetupAnswers["binaries"] = {};
  for (const harness of used) {
    const found = detection[harness];
    binaries[harness] = await ask(
      `Absolute path to the ${harness} executable`,
      (text) => acceptBinary(text, harness, context.check, context.safety),
      found ?? undefined,
      printablePath,
    );
  }

  // Models.
  open("Models");
  const models: SetupAnswers["models"] = {};
  let piModel: SetupAnswers["piModel"];
  for (const harness of used) {
    if (harness === "pi") {
      explain(
        "Pi model as PROVIDER/MODEL, for example anthropic/claude-sonnet-5-5. Leave blank to use Pi's own default.",
      );
      const text = await ask(
        "Pi model as PROVIDER/MODEL (blank for the harness default)",
        (value) => (value === "" ? null : acceptPiModel(value)),
        "",
      );
      if (text) piModel = text;
      continue;
    }
    if (harness === "claude")
      explain(
        "Claude model: an alias such as sonnet or opus, or a full ID like claude-opus-5-5. Required.",
      );
    else if (harness === "opencode")
      explain(
        "OpenCode model as provider/model, optionally with #variant, for example anthropic/claude-sonnet-5-5. Required.",
      );
    else explain("Codex model name. Leave blank to use Codex's own default.");
    const label =
      harness === "opencode"
        ? "OpenCode model (provider/model[#variant], required)"
        : harness === "claude"
          ? "Claude model (alias or full identifier, required)"
          : "Codex model (blank for the harness default)";
    const model = await ask(
      label,
      (text) => acceptModel(harness, text),
      harness === "codex" ? "" : undefined,
    );
    if (model) models[harness] = model;
  }

  // Claude safety fields.
  let claude: ClaudeSettings = { ...defaultClaudeSettings };
  if (usesClaude) {
    open("Claude Code safety");
    io.write(
      `${style.dim("Claude Code isolation (bypass and manual permission modes are not offered).")}\n`,
    );
    explain(
      "Coordinator and reviewers always run in plan mode. Choose what implementers may do.",
    );
    const implementerMode = await choose(
      io,
      style,
      "Permission mode for implementer lanes (coordinator and reviewers use plan):",
      claudePermissionModes,
      defaultClaudeSettings.implementerMode,
      (mode) => permissionHint[mode] ?? "",
    );
    explain(
      "MCP servers for Claude lanes: strict ignores your own MCP servers (it passes --strict-mcp-config); inherit lets Claude use the ones you have configured. [claudeMcp]",
    );
    const mcp = await ask(
      "MCP servers: strict or inherit",
      parseMcp,
      defaultClaudeSettings.mcp,
    );
    explain(
      "Which Claude settings files apply: any of user, project, local, comma separated. [claudeSettingSources]",
    );
    const settingSources = await ask(
      "Settings sources (comma list of user,project,local)",
      parseSettingSources,
      defaultClaudeSettings.settingSources.join(","),
    );
    explain(
      "Max spend per Claude run in USD, enforced by Claude Code. [maxCostUsdPerRun]",
    );
    const maxCostUsdPerRun = await ask(
      "Max spend per Claude run, USD (0.01-100)",
      parseCost,
      String(defaultClaudeSettings.maxCostUsdPerRun),
    );
    claude = { implementerMode, mcp, settingSources, maxCostUsdPerRun };
  }

  // Lanes and tasks.
  open("Lanes & tasks");
  const reserved = new Set([policy.coordinator, ...policy.reviewers]);
  explain(
    "Implementer lane IDs: the lanes that write code. Each task card names its owner with `Owner: <lane id>.`, so these must match.",
  );
  const implementers = await ask(
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
  const tasksPath = context.tasksPath ?? "tasks";
  if (context.discoveredTasks.length) {
    io.write(
      `\nTask cards found: ${context.discoveredTasks.slice(0, 20).join(", ")}${context.discoveredTasks.length > 20 ? ", ..." : ""}\n`,
    );
    explain(
      "Allowed task IDs are an allowlist: only these may ever run. Edit the list to add or remove tasks.",
    );
  } else {
    io.write(`\nNo task cards were found in ${tasksPath}/.\n`);
    explain(
      `Allowed task IDs are an allowlist: only these tasks may ever run. Each needs a committed task card in ${tasksPath}/ (for example ${tasksPath}/t1.md) with a line like \`Owner: ${implementers[0]}.\`. The IDs can be placeholders you create cards for later.`,
    );
    explain("Example: t1,t2");
  }
  const allowedTasks = await ask(
    "Allowed task IDs (comma list; only these may ever run)",
    parseTaskIds,
    context.discoveredTasks.length
      ? context.discoveredTasks.join(",")
      : undefined,
  );

  // Limits.
  open("Limits");
  const limits = defaultLimits();
  const enabledLanes = enabledLaneCount(policy, implementers);
  const limitHint: Record<LimitName, string> = {
    maxParallel: `total agent runs at once. Each lane runs one task at a time, so more than ${enabledLanes} (your enabled lanes) cannot help.`,
    intervalSeconds: "how often the supervisor checks for work, in seconds.",
    maxRunMinutes: "a single run is stopped after this many minutes.",
    maxRunsPerHour: "per-lane cap on runs started each hour.",
  };
  for (const name of Object.keys(limitBounds) as LimitName[]) {
    const bounds = limitBounds[name];
    explain(`${name}: ${limitHint[name]}`);
    limits[name] = await ask(
      `${name} (${bounds.min}-${bounds.max})`,
      (text) => parseLimit(name, text),
      String(
        name === "maxParallel"
          ? Math.min(bounds.default, enabledLanes)
          : bounds.default,
      ),
    );
  }

  // Stopped confirmation: recorded only on an explicit yes.
  open("Confirm");
  explain(
    "Configuring requires that every old harness and supervisor for this project is stopped, because two supervisors writing the same project would conflict. For a first setup, if nothing Crewplane-managed has run, yes is correct.",
  );
  explain(
    "Without yes the configuration cannot be installed now; write it with --out and install it later with `crewplane configure --file`.",
  );
  const stopped = await ask(
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
  for (const note of plan.notes) io.write(`${style.warn(`! ${note}`)}\n`);

  io.write(`\n${style.bold("Review")}\n${context.review(answers)}\n`);
  if (!(await ask("Looks right? (yes/no)", yesNo, "no")))
    throw new SetupAborted();

  let install = false;
  if (stopped)
    install = await ask(
      "Install into the private control directory now? (yes/no)",
      yesNo,
      "no",
    );
  else
    io.write(
      "Installing is unavailable until the stopped confirmation is recorded.\n",
    );
  explain(
    "Optionally also save the full JSON to a new file (mode 0600, never overwrites).",
  );
  const out = await ask(
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
