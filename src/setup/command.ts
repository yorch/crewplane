import { randomBytes } from "node:crypto";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Config } from "../contracts.ts";
import { type DoctorProblem, effectiveBinary, probeBinary } from "../doctor.ts";
import { type Harness, instructionFileProblem } from "../engine/harness.ts";
import {
  type ProjectPolicy,
  printablePath,
  validId,
  validTaskId,
} from "../project.ts";
import {
  acceptBinary,
  detectHarnesses,
  type ExecutableCheck,
  isUsableExecutable,
} from "./detect.ts";
import { decodeConfig } from "./install.ts";
import {
  acceptModel,
  buildConfig,
  type ClaudeSettings,
  defaultClaudeSettings,
  defaultImplementerId,
  defaultLimits,
  harnessesUsed,
  isTemplate,
  type LimitName,
  parseCost,
  parseImplementers,
  parseLimit,
  parseMcp,
  parsePermissionMode,
  parsePiModel,
  parseSettingSources,
  parseTaskIds,
  roleHarnesses,
  type SetupAnswers,
  SetupError,
  type SetupPolicy,
  type Template,
  templates,
} from "./templates.ts";
import { runWizard, SetupAborted, type WizardIO } from "./wizard.ts";

export const setupOptions = [
  "--non-interactive",
  "--template",
  "--binary",
  "--claude-binary",
  "--opencode-binary",
  "--pi-binary",
  "--model",
  "--reviewer-model",
  "--reviewer-harness",
  "--pi-model",
  "--tasks",
  "--implementers",
  "--out",
  "--install",
  "--confirm-stopped",
  "--claude-permission-mode",
  "--claude-mcp",
  "--claude-setting-sources",
  "--max-cost-usd",
  "--max-parallel",
  "--interval-seconds",
  "--max-run-minutes",
  "--max-runs-per-hour",
];
const limitFlags: Record<string, LimitName> = {
  "--max-parallel": "maxParallel",
  "--interval-seconds": "intervalSeconds",
  "--max-run-minutes": "maxRunMinutes",
  "--max-runs-per-hour": "maxRunsPerHour",
};

export interface SetupReport {
  version: 1;
  mode: "interactive" | "non-interactive";
  template: Template | "custom";
  config: Record<string, unknown>;
  confirmedStopped: boolean;
  written: string | null;
  installed: boolean;
  problems: DoctorProblem[];
  notes: string[];
  next: string[];
}

export interface SetupDeps {
  /** Base for relative `--out` paths (the invocation directory). */
  requested: string;
  root: string;
  policy: ProjectPolicy;
  env: Record<string, string | undefined>;
  /** True only when both stdin and stdout are terminals. */
  tty: boolean;
  options: (args: string[], allowed: string[]) => Record<string, string>;
  /** Shared with `configure`; receives the generated runtime JSON. */
  install: (value: Record<string, unknown>) => Promise<Config>;
  makeIO: () => WizardIO;
  check?: ExecutableCheck;
  now?: () => Date;
  epoch?: () => string;
}

const bool = (opts: Record<string, string>, flag: string) => {
  const value = opts[flag];
  if (value === undefined) return false;
  if (value !== "true") throw new Error(`${flag} must be true`);
  return true;
};

const maxCardBytes = 8192;
const ownerPattern = /^Owner(?: lane)?:\s*([A-Za-z][A-Za-z0-9_-]{0,63})\b/m;
/** Cheap, bounded discovery of task IDs and card owners; failures mean "none". */
export async function discoverTasks(
  root: string,
  tasksPath: string,
  reserved: ReadonlySet<string>,
): Promise<{ tasks: string[]; implementers: string[] }> {
  const tasks: string[] = [];
  const owners = new Set<string>();
  try {
    const directory = join(root, tasksPath);
    const names = (await readdir(directory)).sort().slice(0, 500);
    for (const name of names) {
      const id = name.endsWith(".md") ? name.slice(0, -3) : "";
      if (!validTaskId(id)) continue;
      const path = join(directory, name);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      tasks.push(id);
      const handle = await open(path, "r").catch(() => null);
      if (!handle) continue;
      try {
        const buffer = Buffer.alloc(maxCardBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxCardBytes, 0);
        const owner = buffer
          .toString("utf8", 0, bytesRead)
          .match(ownerPattern)?.[1];
        if (owner && validId(owner) && !reserved.has(owner)) owners.add(owner);
      } finally {
        await handle.close();
      }
    }
  } catch {
    // No task directory: nothing to suggest.
  }
  return { tasks, implementers: [...owners].sort() };
}

/**
 * Doctor-equivalent verification of a generated configuration using the same
 * primitives doctor uses (validateConfig without the binary check, then
 * probeBinary per lane and the instruction-file check). Nothing is executed.
 */
export async function checkGenerated(config: Config): Promise<DoctorProblem[]> {
  const problems: DoctorProblem[] = [];
  const reported = new Set<string>();
  for (const [id, lane] of Object.entries(config.lanes)) {
    const harness = lane.harness ?? "codex";
    const { probe, code } = await probeBinary(
      effectiveBinary(config, harness),
      harness,
    );
    if (code && !(probe.path && reported.has(probe.path))) {
      problems.push({
        code,
        lane: id,
        message: probe.problem ?? "binary unusable",
      });
      if (probe.path) reported.add(probe.path);
    }
    if (lane.instructionsPath) {
      const problem = instructionFileProblem(
        config.root,
        lane.instructionsPath,
      );
      if (problem)
        problems.push({
          code: "INSTRUCTIONS_INVALID",
          lane: id,
          message: problem,
        });
    }
  }
  return problems;
}

const policyOf = (policy: ProjectPolicy): SetupPolicy => ({
  coordinator: policy.coordinator as string,
  reviewers: [...(policy.reviewers ?? [])],
  reviewerRoles: { ...(policy.reviewerRoles ?? {}) },
});

/** Build the answers for a non-interactive run from flags and PATH detection. */
async function nonInteractiveAnswers(
  opts: Record<string, string>,
  deps: SetupDeps,
  discovered: { tasks: string[]; implementers: string[] },
  confirmed: boolean,
): Promise<{ answers: SetupAnswers; template: Template }> {
  const check = deps.check ?? isUsableExecutable;
  const template = opts["--template"];
  if (!isTemplate(template))
    throw new Error(`setup requires --template ${templates.join("|")}`);
  const reviewerHarness = opts["--reviewer-harness"] ?? "opencode";
  if (opts["--reviewer-harness"] !== undefined && template !== "mixed")
    throw new Error("--reviewer-harness applies only to the mixed template");
  if (reviewerHarness !== "opencode" && reviewerHarness !== "pi")
    throw new Error("--reviewer-harness must be opencode or pi");
  const roles = roleHarnesses(template, reviewerHarness);
  const used = harnessesUsed(roles);

  const flagFor: Record<Harness, string> = {
    codex: "--binary",
    claude: "--claude-binary",
    opencode: "--opencode-binary",
    pi: "--pi-binary",
  };
  for (const harness of ["codex", "claude", "opencode", "pi"] as const)
    if (opts[flagFor[harness]] !== undefined && !used.includes(harness))
      throw new Error(
        `${flagFor[harness]} does not apply to the ${template} template`,
      );
  const detection = await detectHarnesses(deps.env.PATH, check);
  const binaries: SetupAnswers["binaries"] = {};
  for (const harness of used) {
    const given = opts[flagFor[harness]];
    const path = given ?? detection[harness];
    if (!path)
      throw new Error(
        `No ${harness} executable found on PATH; pass ${flagFor[harness]} ABSOLUTE_PATH`,
      );
    binaries[harness] = await acceptBinary(path, harness, check);
  }

  const models: SetupAnswers["models"] = {};
  let piModel: SetupAnswers["piModel"];
  const modelOwner: Harness =
    template === "mixed" ? "claude" : (used[0] as Harness);
  if (opts["--model"] !== undefined) {
    const model = acceptModel(modelOwner, opts["--model"]);
    if (model) models[modelOwner] = model;
  }
  if (opts["--reviewer-model"] !== undefined) {
    if (template !== "mixed" || reviewerHarness !== "opencode")
      throw new Error(
        "--reviewer-model applies only to the mixed template with opencode reviewers",
      );
    const reviewerModel = acceptModel("opencode", opts["--reviewer-model"]);
    if (reviewerModel) models.opencode = reviewerModel;
  }
  if (opts["--pi-model"] !== undefined) {
    if (!(template === "mixed" && reviewerHarness === "pi"))
      throw new Error("--pi-model applies only to mixed with pi reviewers");
    piModel = parsePiModel(opts["--pi-model"]);
  }
  for (const harness of used)
    if (harness !== "codex" && harness !== "pi" && !models[harness])
      throw new Error(
        `${harness} requires a model: pass ${harness === modelOwner ? "--model ID" : "--reviewer-model ID"}`,
      );

  const claude: ClaudeSettings = { ...defaultClaudeSettings };
  const claudeFlags = [
    "--claude-permission-mode",
    "--claude-mcp",
    "--claude-setting-sources",
    "--max-cost-usd",
  ];
  if (
    !used.includes("claude") &&
    claudeFlags.some((f) => opts[f] !== undefined)
  )
    throw new Error(`Claude flags do not apply to the ${template} template`);
  if (opts["--claude-permission-mode"] !== undefined)
    claude.implementerMode = parsePermissionMode(
      opts["--claude-permission-mode"],
    );
  if (opts["--claude-mcp"] !== undefined)
    claude.mcp = parseMcp(opts["--claude-mcp"]);
  if (opts["--claude-setting-sources"] !== undefined)
    claude.settingSources = parseSettingSources(
      opts["--claude-setting-sources"],
    );
  if (opts["--max-cost-usd"] !== undefined)
    claude.maxCostUsdPerRun = parseCost(opts["--max-cost-usd"]);

  const allowedTasks =
    opts["--tasks"] !== undefined
      ? parseTaskIds(opts["--tasks"])
      : discovered.tasks;
  if (!allowedTasks.length)
    throw new Error("No task cards found; pass --tasks ID,ID");
  const implementers =
    opts["--implementers"] !== undefined
      ? parseImplementers(opts["--implementers"])
      : discovered.implementers.length
        ? discovered.implementers
        : [defaultImplementerId];
  const limits = defaultLimits();
  for (const [flag, name] of Object.entries(limitFlags))
    if (opts[flag] !== undefined) limits[name] = parseLimit(name, opts[flag]);
  return {
    template,
    answers: {
      roles,
      binaries,
      models,
      ...(piModel ? { piModel } : {}),
      claude,
      allowedTasks,
      implementers,
      limits,
      ...(confirmed
        ? {
            confirmedStoppedAt: (
              deps.now ?? (() => new Date())
            )().toISOString(),
          }
        : {}),
      ...(roles.reviewer === "pi"
        ? { sessionEpoch: (deps.epoch ?? defaultEpoch)() }
        : {}),
    },
  };
}
const defaultEpoch = () => `setup-${randomBytes(6).toString("hex")}`;

async function writeNew(path: string, text: string) {
  try {
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Refusing to overwrite existing file: ${printablePath(path)}`,
      );
    throw error;
  }
}

export async function runSetup(
  args: string[],
  deps: SetupDeps,
): Promise<SetupReport> {
  const opts = deps.options(args, setupOptions);
  const nonInteractive = bool(opts, "--non-interactive");
  if (!nonInteractive) {
    if (Object.keys(opts).length)
      throw new Error(
        "setup options other than --non-interactive true require non-interactive mode",
      );
    if (!deps.tty)
      throw new Error(
        "setup needs an interactive terminal on stdin and stdout; use `setup --non-interactive true --template NAME` in scripts",
      );
  }
  const setup = policyOf(deps.policy);
  const reserved = new Set([setup.coordinator, ...setup.reviewers]);
  const discovered = await discoverTasks(
    deps.root,
    deps.policy.tasksPath,
    reserved,
  );
  const check = deps.check ?? isUsableExecutable;
  const now = deps.now ?? (() => new Date());

  let answers: SetupAnswers;
  let template: Template | "custom";
  let install = false;
  let out: string | undefined;
  if (nonInteractive) {
    const confirmed = bool(opts, "--confirm-stopped");
    install = bool(opts, "--install");
    out = opts["--out"];
    if (install && !confirmed)
      throw new Error(
        "--install requires --confirm-stopped true after you have verified the supervisor is stopped",
      );
    ({ answers, template } = await nonInteractiveAnswers(
      opts,
      deps,
      discovered,
      confirmed,
    ));
  } else {
    const io = deps.makeIO();
    try {
      const result = await runWizard(io, {
        policy: setup,
        detection: await detectHarnesses(deps.env.PATH, check),
        discoveredTasks: discovered.tasks,
        discoveredImplementers: discovered.implementers,
        check,
        now,
        epoch: deps.epoch ?? defaultEpoch,
        review: (a) => {
          const built = buildConfig(a, setup);
          return `${JSON.stringify(built.config, null, 2)}\n${built.notes.map((n) => `note: ${n}`).join("\n")}`;
        },
      });
      answers = result.answers;
      template = result.template;
      install = result.install;
      out = result.out;
    } finally {
      io.close?.();
    }
  }

  const built = buildConfig(answers, setup);
  // Validate exactly as `configure` will; the stop confirmation is only a
  // placeholder here so every other field is still checked when it is absent.
  const decoded = decodeConfig(
    {
      ...built.config,
      confirmedStoppedAt: answers.confirmedStoppedAt ?? now().toISOString(),
    },
    { root: deps.root, policy: deps.policy },
  );
  const problems = await checkGenerated(decoded);
  const text = `${JSON.stringify(built.config, null, 2)}\n`;
  const outPath = out === undefined ? null : resolve(deps.requested, out);
  const notes = [...built.notes];
  if (problems.length) {
    if (install || outPath)
      notes.push("nothing was written because verification found problems");
  } else {
    if (outPath) await writeNew(outPath, text);
    if (install) await deps.install(built.config);
  }
  const written = problems.length ? null : outPath;
  const installed = install && !problems.length;
  const next: string[] = [];
  if (installed) next.push("crewplane doctor");
  else {
    if (!answers.confirmedStoppedAt)
      next.push(
        "verify the supervisor is stopped, then record confirmedStoppedAt",
      );
    next.push(
      `crewplane configure --file ${written ?? "PATH"}`,
      "crewplane doctor",
    );
  }
  return {
    version: 1,
    mode: nonInteractive ? "non-interactive" : "interactive",
    template,
    config: built.config,
    confirmedStopped: answers.confirmedStoppedAt !== undefined,
    written: written === null ? null : written,
    installed,
    problems,
    notes,
    next,
  };
}

/** Prompts and echo go to stderr so stdout stays a single JSON document. */
export function terminalIO(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): WizardIO {
  const rl = createInterface({ input, output, terminal: true });
  let closed = false;
  let waiting: ((value: null) => void) | null = null;
  rl.once("close", () => {
    closed = true;
    waiting?.(null);
    waiting = null;
  });
  rl.on("SIGINT", () => rl.close());
  return {
    ask: (question) =>
      new Promise((resolveAnswer) => {
        if (closed) return resolveAnswer(null);
        waiting = resolveAnswer as (value: null) => void;
        rl.question(question, (answer) => {
          waiting = null;
          resolveAnswer(answer);
        });
      }),
    write: (text) => void output.write(text),
    close: () => rl.close(),
  };
}

export { SetupAborted, SetupError };
