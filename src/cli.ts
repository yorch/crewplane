import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { snapshot } from "./board.ts";
import type { Config, State } from "./contracts.ts";
import {
  bindControl,
  checkBinding,
  checkControlDirectory,
  controlDirectory,
  ensureControlDirectory,
  legacySupervisorDirectory,
  rebindControl,
} from "./control.ts";
import { type DoctorProblem, failureMessage } from "./doctor.ts";
import { inspectConfiguration } from "./doctor-config.ts";
import { main as agents } from "./engine/agents.mjs";
import { control } from "./engine/control-policy.ts";
import { queueControl } from "./engine/control-queue.ts";
import { createDashboard, newSessionToken } from "./engine/dashboard.ts";
import type {
  EvidenceCaptureInput,
  EvidenceRunInput,
} from "./engine/evidence/contract.ts";
import { createEvidenceStore } from "./engine/evidence/store.ts";
import { serve, validateConfig } from "./engine/supervisor.ts";
import { monitorMain } from "./engine/watch.ts";
import { watchdogMain } from "./engine/watchdog/runner.ts";
import { standaloneBinary } from "./environment.ts";
import { help } from "./help.ts";
import { isProcessAlive } from "./liveness.ts";
import {
  describeAdoption,
  escapeJsonText,
  isLive,
  migrateControl,
  readBoundedJson,
  resolveControlTarget,
  supervisorLiveness,
} from "./migrate.ts";
import {
  defaultPolicy,
  discoverProject,
  type ProjectPolicy,
  ProjectVersionError,
  printablePath,
  projectPolicy,
  writeProjectPin,
} from "./project.ts";
import { runSetup, terminalIO } from "./setup/command.ts";
import { loadPrior } from "./setup/epochs.ts";
import { installConfig, stoppedProblem } from "./setup/install.ts";
import {
  compareVersions,
  dispatchTarget,
  isReleaseBuild,
  liveSupervisorRegistrations,
  readUpdateCache,
  releasesRoot,
  runUpdate,
  scheduleAutoUpdate,
  shouldScheduleUpdate,
  supervisorRunning,
  updateCachePath,
  updateTarget,
} from "./update.ts";

/**
 * Agent-controlled text can reach reports; JSON output never carries raw
 * bidirectional, zero-width, line-separator or C1 characters that could spoof
 * a terminal.
 */
const output = (value: unknown) =>
  console.log(
    typeof value === "string"
      ? value
      : escapeJsonText(JSON.stringify(value, null, 2)),
  );
const optional = async (path: string) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid private state; inspect before recovery");
  }
};
const readConfig = async (directory: string) => {
  const config = await optional(join(directory, "config.json"));
  if (config === null)
    throw new Error(
      "Project is not configured; run crewplane configure --file PATH",
    );
  return validateConfig(config as Config);
};
/** Read an operator-named input file, naming it when it does not exist. */
const readInput = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`file not found: ${printablePath(path)}`);
    throw error;
  }
};
function options(args: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!key || !allowed.includes(key))
      throw new Error(
        `Invalid command options: unexpected ${printablePath(String(key))}`,
      );
    if (value === undefined || value.startsWith("--"))
      throw new Error(`Invalid command options: ${key} requires a value`);
    if (key in result)
      throw new Error(`Invalid command options: ${key} given twice`);
    result[key] = value;
  }
  return result;
}
function flags(args: string[], allowed: string[]) {
  const result = new Set<string>();
  for (const arg of args) {
    if (!allowed.includes(arg))
      throw new Error(
        `Invalid command options: unexpected ${printablePath(arg)}`,
      );
    if (result.has(arg))
      throw new Error(`Invalid command options: ${arg} given twice`);
    result.add(arg);
  }
  return result;
}
const knownCommands = new Set([
  "init",
  "doctor",
  "configure",
  "setup",
  "agents",
  "task",
  "agent",
  "start",
  "status",
  "pause",
  "resume",
  "retry",
  "nudge",
  "stop",
  "rollout",
  "resolve",
  "cancel",
  "dashboard",
  "evidence",
  "monitor",
  "watchdog",
  "migrate",
]);
const projectCommands = new Set([...knownCommands, "pin"]);
/**
 * Best-effort background check. It never delays or fails a foreground command
 * and never replaces the executable while long-lived work or any live
 * supervisor is present.
 */
async function autoUpdate(command: string) {
  if (!knownCommands.has(command)) return;
  const environment = process.env,
    releaseMarked = isReleaseBuild(),
    execPath = process.execPath;
  const target = updateTarget(releaseMarked, execPath, environment);
  if (target === null) return;
  const now = new Date();
  const cache = await readUpdateCache(updateCachePath(environment));
  if (
    !shouldScheduleUpdate({
      command,
      environment,
      releaseMarked,
      execPath,
      cache,
      now,
      supervisorLive: false,
    })
  )
    return;
  if (await supervisorRunning(environment)) return;
  await scheduleAutoUpdate({ target, environment, now });
}
type ProjectContext = {
  store: string;
  gitCommonDir: string;
  projectRoot: string;
};
/**
 * Commands that must still run when the binary does not match the project pin:
 * every operator safety and authority verb (halting, cancelling, resolving a
 * decision, repointing a stale pin). Note every other project command stays
 * blocked. Queued verbs are interpreted by the running supervisor's release.
 */
const pinMismatchBypass = new Set([
  "pause",
  "resume",
  "stop",
  "cancel",
  "resolve",
  "pin",
]);
/** Why the last pin mismatch could not hand off, for the refusal to explain. */
let dispatchSkip: string | undefined;
/** The retained-release directory, or why it cannot be determined. */
const safeRoot = () => {
  try {
    return printablePath(releasesRoot());
  } catch (error) {
    return `(unavailable: ${error instanceof Error ? error.message : "invalid environment"})`;
  }
};
/**
 * Extra recovery lines for a pin mismatch. They are rendered by the CLI only:
 * the error message itself stays one line because the supervisor persists it.
 */
function versionPinHint(error: ProjectVersionError, skipped?: string): string {
  const order = compareVersions(error.running, error.required);
  const direction =
    order > 0
      ? "this project pins an OLDER release; `crewplane update` only installs the latest release"
      : `this project requires a NEWER release; \`crewplane update\` installs the latest, which may not be ${error.required}`;
  const retained = `${safeRoot()}/${error.required}`;
  const lines = [
    `  pin:     requiredVersion in ${printablePath(error.policyPath)} (primary checkout; applies to every worktree)`,
  ];
  if (standaloneBinary())
    lines.push(`  binary:  ${printablePath(process.execPath)}`);
  lines.push(`  ${direction}`, `  retained: ${retained}`);
  if (skipped !== undefined) lines.push(`  dispatch: ${skipped}`);
  lines.push(
    `  cure:    install release ${error.required} into that directory (see docs/USAGE.md "Project version pins")`,
    '  details: docs/USAGE.md "Project version pins"',
  );
  return lines.join("\n");
}
/**
 * Hand a pinned project to the retained copy of its release. Returns a reason
 * when it declined, so the refusal can explain itself instead of contradicting
 * the hints above it. A successful exec never returns.
 */
async function dispatchToPin(
  error: ProjectVersionError,
  command: string,
  requested: string,
): Promise<string | undefined> {
  // `pin` must repoint at this release, and one hop per release is enough.
  if (command === "pin") return undefined;
  if (process.env.CREWPLANE_DISPATCHED === error.required)
    return `already running on ${error.required}`;
  try {
    const identity = discoverProject(requested);
    let state: { running?: boolean; pid?: number; supervisorVersion?: string } =
      {};
    // A live owner may still be in the legacy directory of an older release.
    for (const directory of [
      controlDirectory(identity.primary),
      legacySupervisorDirectory(identity.store),
    ]) {
      try {
        // The legacy directory's mode is irrelevant to reading a version marker.
        if (directory !== legacySupervisorDirectory(identity.store))
          checkControlDirectory(directory);
        state = JSON.parse(
          await readFile(join(directory, "state.json"), "utf8"),
        ) as typeof state;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // A live newer release owns this store; an older one must not touch it.
    if (
      state.running === true &&
      isProcessAlive(state.pid) &&
      typeof state.supervisorVersion === "string" &&
      compareVersions(state.supervisorVersion, error.required) > 0
    )
      return `supervisor ${state.supervisorVersion} owns this store`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unreadable state";
    return `project state is unusable (${reason})`;
  }
  let path: string | null;
  try {
    path = await dispatchTarget(error.required);
  } catch (failure) {
    return `release directory unavailable (${failure instanceof Error ? failure.message : "unknown"})`;
  }
  if (path === null) return `no verified ${error.required} under ${safeRoot()}`;
  // SAFETY: Bun provides process.execve at runtime but @types does not declare
  // it, so the shape is asserted and re-checked with typeof before it is called.
  const execve = (
    process as unknown as {
      execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
    }
  ).execve;
  if (typeof execve !== "function")
    return "this runtime cannot replace its own process image";
  console.error(
    `crewplane: running ${error.required} from ${printablePath(path)} for this pinned project`,
  );
  try {
    execve(path, [path, ...process.argv.slice(2)], {
      ...process.env,
      CREWPLANE_DISPATCHED: error.required,
    });
  } catch (error) {
    return `exec failed (${error instanceof Error ? error.message : "unknown"})`;
  }
}
async function main() {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf("--project");
  let requested = process.cwd();
  if (projectIndex >= 0) {
    const path = args[projectIndex + 1];
    if (!path || path.startsWith("--"))
      throw new Error("--project requires a path");
    requested = resolve(path);
    args.splice(projectIndex, 2);
  }
  const [command = "--help", ...rest] = args;
  if (command === "--help" || command === "-h") return output(help);
  if (command === "--version" || command === "-v") return output(pkg.version);
  if (command === "help") return output(help);
  if (command !== "update" && !projectCommands.has(command))
    throw new Error("Unknown command. Run crewplane --help.");
  // A supervised child may only observe and use the board; every verb that
  // configures, starts, controls, migrates, pins or updates is refused.
  if (process.env.CREWPLANE_HEADLESS_LANE) {
    const observing =
      ["agents", "evidence", "monitor", "status", "doctor"].includes(command) ||
      (["task", "agent"].includes(command) &&
        rest.length === 1 &&
        rest[0] === "list");
    if (!observing)
      throw new Error("This command is unavailable to headless agents");
  }
  if (command === "update") {
    const set = flags(rest, ["--check", "--auto", "--force"]);
    if (set.has("--check") && set.has("--auto"))
      throw new Error("--check and --auto are mutually exclusive");
    if (set.has("--auto")) {
      await runUpdate({ current: pkg.version, auto: true }).catch(() => {});
      return;
    }
    try {
      return output(
        await runUpdate({
          current: pkg.version,
          checkOnly: set.has("--check"),
          ...(set.has("--force") ? { safeToReplace: async () => true } : {}),
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Update failed";
      console.error(`crewplane: ${reason}`);
      output({
        version: 1,
        status: "failed",
        current: pkg.version,
        checkedAt: new Date().toISOString(),
        reason,
      });
      process.exitCode = 1;
      return;
    }
  }
  let ctx: ProjectContext;
  let policy: ProjectPolicy;
  let bypassedPin = false;
  // A dry-run migration must not prepare the store or schedule an update.
  const dryMigration = command === "migrate" && rest.includes("--dry-run");
  try {
    if (dryMigration) {
      const found = discoverProject(requested);
      ctx = {
        store: found.store,
        gitCommonDir: found.common,
        projectRoot: found.primary,
      };
    } else ctx = (await agents(["init"], requested)) as ProjectContext;
    policy = projectPolicy(ctx.projectRoot);
  } catch (error) {
    if (error instanceof ProjectVersionError)
      dispatchSkip = await dispatchToPin(error, command, requested);
    // A replaced binary must never lock the operator out of halting live work,
    // and the pin command exists to resolve this exact state.
    if (
      !(error instanceof ProjectVersionError) ||
      !pinMismatchBypass.has(command)
    )
      throw error;
    const identity = discoverProject(requested);
    ctx = {
      store: identity.store,
      gitCommonDir: identity.common,
      projectRoot: identity.primary,
    };
    policy = projectPolicy(identity.primary, { checkVersion: false });
    bypassedPin = true;
    if (command !== "pin")
      console.error(
        `crewplane: queuing ${command} despite the release mismatch; every other project command stays blocked`,
      );
  }
  const common = ctx.gitCommonDir,
    root = ctx.projectRoot;
  // Control plane: private per-user directory, never inside the project store.
  // Derived lazily so a bad CREWPLANE_STATE_DIR cannot break `init`.
  const controlDir = command === "init" ? "" : controlDirectory(root);
  const identity = { primaryRoot: root, gitCommon: common };
  const halting = ["status", "stop", "pause", "cancel"].includes(command);
  // Resolved lazily: `directory` is only final after the control-target gate.
  const installTarget = {
    root,
    policy,
    store: ctx.store,
    get directory() {
      return directory;
    },
    identity,
  };
  let directory = controlDir;
  let also: string[] = [];
  let unverifiedLegacyDirectory: string | undefined;
  // Exempt: they never touch supervisor state, or they report/repair the layout.
  if (!["init", "migrate", "pin", "doctor"].includes(command)) {
    // Fails closed while an older in-store layout exists (halting verbs excepted).
    const target = resolveControlTarget(ctx.store, controlDir, command);
    directory = target.directory;
    also = target.also ?? [];
    unverifiedLegacyDirectory = target.unverifiedLegacy;
    if (target.warning) console.error(target.warning);
    if (directory === controlDir) {
      checkControlDirectory(directory);
      if (halting)
        for (const live of await liveSupervisorRegistrations())
          if (
            live.store === ctx.store &&
            live.control !== undefined &&
            live.control !== controlDir
          )
            console.error(
              `crewplane: a live supervisor (PID ${live.pid}) uses control directory ${printablePath(live.control)}, not ${printablePath(controlDir)}; rerun with the environment it was started with (CREWPLANE_STATE_DIR, XDG_STATE_HOME, HOME)`,
            );
      if (!["agents", "task", "evidence", "monitor"].includes(command)) {
        try {
          checkBinding(ctx.store, controlDir, identity, {
            narrowing: ["stop", "pause", "cancel"].includes(command),
          });
        } catch (error) {
          // Read-only status may report the mismatch; a verb that would queue
          // into a directory no supervisor reads must not pretend to halt.
          if (command !== "status") throw error;
          console.error(
            `crewplane: ${error instanceof Error ? error.message : "control binding mismatch"}`,
          );
        }
      }
    }
  }
  if (!policy.requiredVersion && !dryMigration)
    await autoUpdate(command).catch(() => {});
  if (command === "pin") {
    const opts = options(rest, ["--confirm"]);
    if (opts["--confirm"] !== undefined && opts["--confirm"] !== "true")
      throw new Error("Pin confirmation must be true");
    if (!policy.requiredVersion)
      throw new Error(
        "Project is not pinned; requiredVersion requires project policy version 2",
      );
    // The pin is exempt from the migration gate, so check both layouts.
    checkControlDirectory(controlDir);
    for (const candidate of [
      controlDir,
      legacySupervisorDirectory(ctx.store),
    ]) {
      const state = (await optional(join(candidate, "state.json"))) as {
        running?: boolean;
        supervisorVersion?: string;
      } | null;
      if (state?.running || isLive(supervisorLiveness(candidate)))
        throw new Error(
          `Stop the supervisor${state?.supervisorVersion ? ` (${state.supervisorVersion})` : ""} before changing the project pin`,
        );
    }
    if (policy.requiredVersion === pkg.version)
      return output({
        version: 1,
        file: join(root, "crewplane.json"),
        from: pkg.version,
        to: pkg.version,
        changed: false,
      });
    if (opts["--confirm"] !== "true")
      throw new Error(
        `Repinning this project from ${policy.requiredVersion} to ${pkg.version} rewrites committed policy; rerun with --confirm true`,
      );
    const change = writeProjectPin(root, pkg.version);
    return output({
      version: 1,
      ...change,
      to: pkg.version,
      next: [
        "commit crewplane.json",
        "crewplane doctor",
        "crewplane configure --file PATH",
      ],
    });
  }
  if (command === "migrate") {
    let dryRun = false,
      discardLegacy = false,
      rebind = false,
      acceptConfig: string | undefined;
    const ignorePids: number[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--dry-run" && !dryRun) dryRun = true;
      else if (arg === "--discard-legacy" && !discardLegacy)
        discardLegacy = true;
      else if (arg === "--rebind" && !rebind) rebind = true;
      else if (
        arg === "--ignore-pid" &&
        /^[1-9]\d{0,9}$/.test(rest[i + 1] ?? "") &&
        Number(rest[i + 1]) > 1
      ) {
        ignorePids.push(Number(rest[i + 1]));
        i++;
      } else if (
        arg === "--accept-config" &&
        /^[a-f0-9]{64}$/.test(rest[i + 1] ?? "") &&
        acceptConfig === undefined
      ) {
        acceptConfig = rest[i + 1];
        i++;
      } else
        throw new Error(
          `Invalid command options: unexpected ${printablePath(String(arg))}`,
        );
    }
    if (
      [discardLegacy, rebind, acceptConfig !== undefined].filter(Boolean)
        .length > 1
    )
      throw new Error(
        "--discard-legacy, --rebind and --accept-config are mutually exclusive",
      );
    for (const pid of ignorePids)
      console.error(
        `crewplane: treating PID ${pid} as not a supervisor (--ignore-pid)`,
      );
    if (rebind) {
      if (dryRun) throw new Error("--rebind has no dry run");
      return output({
        version: 1,
        status: await rebindControl(ctx.store, controlDir, identity),
        to: controlDir,
      });
    }
    const report = await migrateControl({
      store: ctx.store,
      control: controlDir,
      root,
      identity,
      dryRun,
      discardLegacy,
      ignorePids,
      acceptConfig,
    });
    for (const claim of report.ignoredLivenessClaims)
      console.error(`crewplane: ignoring legacy liveness claim: ${claim}`);
    if (dryRun && !discardLegacy && report.from) {
      console.error(
        `crewplane: review everything below; only these canonical files are adopted:\n${describeAdoption(report, { root, store: ctx.store })}`,
      );
      if (Object.keys(report.files).length)
        console.error(
          `crewplane: digest ${report.digest}; adopt exactly this with \`crewplane migrate --accept-config ${report.digest}\``,
        );
    }
    return output(report);
  }
  if (command === "init") {
    if (rest.length) throw new Error("init takes no options");
    try {
      await writeFile(
        join(root, "crewplane.json"),
        `${JSON.stringify(defaultPolicy, null, 2)}\n`,
        { flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await mkdir(join(root, policy.tasksPath), { recursive: true });
    const exclude = join(common, "info/exclude");
    await mkdir(dirname(exclude), { recursive: true });
    const prior = await readFile(exclude, "utf8").catch(() => "");
    const missing = ["/.crewplane-state/", "/.crewplane-local/"].filter(
      (line) => !prior.split("\n").includes(line),
    );
    if (missing.length)
      await appendFile(
        exclude,
        `${prior === "" || prior.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`,
      );
    return output({
      version: 1,
      root,
      store: ctx.store,
      configuration: "crewplane.json",
      running: false,
    });
  }
  if (command === "agents") return output(await agents(rest, requested));
  if (command === "task" && rest.length === 1 && rest[0] === "list")
    return output(await agents(["board"], root));
  if (command === "agent" && rest.length === 1 && rest[0] === "list")
    return output((await snapshot(root)).headless);
  if (command === "configure") {
    const opts = options(rest, ["--file"]);
    if (!opts["--file"]) throw new Error("configure requires --file PATH");
    const text = await readInput(resolve(requested, opts["--file"]));
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Configuration file is not valid JSON");
    }
    const config = await installConfig(value, installTarget);
    return output({
      configured: true,
      started: false,
      agents: Object.keys(config.lanes),
    });
  }
  if (command === "setup") {
    const report = await runSetup(rest, {
      requested,
      root,
      policy,
      env: process.env,
      tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      options,
      install: (value) =>
        installConfig(value, installTarget, { requireStopped: true }),
      stopped: () => stoppedProblem(directory),
      prior: () => loadPrior(directory),
      protectedPaths: [
        directory,
        controlDir,
        ctx.store,
        join(root, ".crewplane-state"),
        join(root, ".crewplane-local"),
      ],
      makeIO: () => terminalIO(process.stdin, process.stderr),
    });
    for (const problem of report.problems)
      console.error(
        `crewplane: ${problem.code}${problem.lane ? ` (${problem.lane})` : ""}: ${problem.message}`,
      );
    for (const note of report.notes) console.error(`crewplane: note: ${note}`);
    if (report.problems.length) process.exitCode = 2;
    return output(report);
  }
  if (command === "doctor") {
    if (rest.length) throw new Error("doctor takes no options");
    const inspection = await inspectConfiguration({
      root,
      store: ctx.store,
      controlDir,
      instructionsPath: policy.instructionsPath,
    });
    const problems: DoctorProblem[] = [...inspection.configProblems];
    const { legacyLayout, configState } = inspection;
    // Retention failures only reach the update cache; surface them here, since a
    // silently stalled self-update is otherwise invisible.
    let updateCache: Awaited<ReturnType<typeof readUpdateCache>> = {
      version: 1,
    };
    try {
      updateCache = await readUpdateCache(updateCachePath(process.env));
    } catch (error) {
      problems.push({
        code: "CACHE_DIR_INVALID",
        message: failureMessage(error, "Update cache directory is invalid"),
      });
    }
    let releases: string;
    try {
      releases = printablePath(releasesRoot());
    } catch (error) {
      releases = `(unavailable: ${error instanceof Error ? error.message : "invalid environment"})`;
      problems.push({
        code: "RELEASES_ROOT_INVALID",
        message: failureMessage(error, "Releases directory is invalid"),
      });
    }
    let git: string | null = null;
    try {
      git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      // Project discovery already ran git, so this is not expected to fail.
    }
    problems.push(...inspection.binaryProblems);
    const { harnesses, defaultBinary } = inspection;
    const globalProblem = inspection.globalInstructionsProblem;
    // A missing global file is reported at prompt time, not a hard failure.
    const warnings: DoctorProblem[] = globalProblem
      ? [{ code: "INSTRUCTIONS_GLOBAL_UNAVAILABLE", message: globalProblem }]
      : [];
    process.exitCode = problems.length ? 2 : 0;
    return output({
      version: 1,
      ok: problems.length === 0,
      problems,
      warnings,
      update: {
        latest: updateCache.latest ?? null,
        lastAttemptAt: updateCache.lastAttemptAt ?? null,
        error: updateCache.error ?? null,
        retainedReleases: releases,
      },
      root,
      git,
      runtime: standaloneBinary() ? "compiled" : "bun",
      controlDirectory: controlDir,
      legacyLayout: legacyLayout
        ? "present: run `crewplane migrate` (legacy state is not being used)"
        : "none",
      config: configState,
      defaultBinary,
      harnesses,
      globalInstructions: globalProblem ?? "ok",
      providerCredentials: "not-probed",
      servicesStarted: false,
    });
  }
  if (command === "status") {
    if (rest.length) throw new Error("status takes no options");
    const desired = (await optional(join(directory, "desired.json"))) as {
      desiredRunning?: boolean;
    } | null;
    const state = (await optional(
      join(directory, "state.json"),
    )) as State | null;
    const config = (await optional(
      join(directory, "config.json"),
    )) as Config | null;
    const pending: Array<{
      id: string;
      action: string;
      at: string | null;
      ageMs: number | null;
    }> = [];
    try {
      for (const file of await readdir(join(directory, "commands"))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        const id = file.slice(0, -5);
        try {
          const raw = JSON.parse(
            await readFile(join(directory, "commands", file), "utf8"),
          ) as { action?: unknown; at?: unknown };
          const at =
            typeof raw.at === "string" && Number.isFinite(Date.parse(raw.at))
              ? raw.at
              : null;
          pending.push({
            id,
            action: typeof raw.action === "string" ? raw.action : "invalid",
            at,
            ageMs: at ? Date.now() - Date.parse(at) : null,
          });
        } catch {
          pending.push({ id, action: "invalid", at: null, ageMs: null });
        }
      }
    } catch {
      /* no commands directory yet */
    }
    let view: unknown = null;
    if (state) {
      const lanes = Object.fromEntries(
        Object.keys(config?.lanes ?? {}).map((id) => {
          const records = Object.values(state.records ?? {}).filter(
            (record) => record.lane === id,
          );
          return [
            id,
            {
              intent: {
                held:
                  state.instanceHeld === true ||
                  (state.held ?? []).includes(id),
                rev: state.laneRev?.[id] ?? 0,
              },
              observed: records.map((record) => ({
                run: record.runId ?? null,
                task: record.task,
                phase: record.status,
                cancelRequested: record.cancelRequested === true,
              })),
              pauses: records
                .filter((record) => record.status === "paused")
                .map((record) => ({
                  kind: record.pauseKind ?? "failure",
                  reason: record.reason,
                  pauseId: record.pauseId ?? null,
                })),
            },
          ];
        }),
      );
      const heartbeat = Date.parse(state.checkedAt ?? "");
      view = {
        supervisor: {
          intent: desired?.desiredRunning === false ? "stopped" : "running",
          observed: state.running
            ? Number.isFinite(heartbeat) && Date.now() - heartbeat > 60000
              ? "stale"
              : "running"
            : "dead",
          heartbeatAgeMs: Number.isFinite(heartbeat)
            ? Date.now() - heartbeat
            : null,
          held: state.instanceHeld === true,
        },
        lanes,
        pendingControls: pending.sort((a, b) =>
          (a.at ?? "").localeCompare(b.at ?? ""),
        ),
        recentControls: (state.controlLog ?? []).slice(-10),
      };
    }
    let unverifiedLegacy: unknown;
    if (unverifiedLegacyDirectory)
      unverifiedLegacy = {
        unverified: true,
        note: "agent-writable legacy state; not used by this release",
        // Bounded, non-blocking: a FIFO or huge file is "unreadable".
        state:
          readBoundedJson(join(unverifiedLegacyDirectory, "state.json")) ??
          "unreadable",
      };
    return output({
      desired,
      state,
      view,
      ...(unverifiedLegacy === undefined ? {} : { unverifiedLegacy }),
    });
  }
  if (
    [
      "pause",
      "resume",
      "retry",
      "nudge",
      "stop",
      "rollout",
      "resolve",
      "cancel",
    ].includes(command)
  ) {
    const opts = options(rest, [
      "--lane",
      "--text",
      "--confirm-cleanup",
      "--task",
      "--new-session",
      "--expect-rev",
      "--expect-run",
      "--expect-session",
      "--wait",
      "--approve",
      "--deny",
      "--pause",
      "--all",
      "--run",
      "--cancel-active",
    ]);
    if (
      opts["--confirm-cleanup"] !== undefined &&
      opts["--confirm-cleanup"] !== "true"
    )
      throw new Error("Cleanup confirmation must be true");
    if (opts["--new-session"] !== undefined && opts["--new-session"] !== "true")
      throw new Error("New session selection must be true");
    // Files of an agent-writable legacy directory are only read bounded and
    // non-blocking; failure is "absent".
    const readIn = async (path: string): Promise<unknown> =>
      directory === controlDir && path.startsWith(`${controlDir}/`)
        ? await optional(path)
        : readBoundedJson(path);
    const state = (await readIn(join(directory, "state.json"))) as {
      generation?: string;
      laneRev?: Record<string, number>;
      records?: Record<
        string,
        {
          lane: string;
          task: string | null;
          sessionId?: string;
          runId?: string;
        }
      >;
      controlLog?: Array<{ id: string; outcome: string; code: string }>;
      running?: boolean;
      supervisorVersion?: string;
    } | null;
    // A queued verb is interpreted by the release that owns the live supervisor,
    // so a mismatched binary has to say when its own vocabulary may not apply.
    if (
      bypassedPin &&
      state?.running &&
      state.supervisorVersion !== pkg.version
    )
      console.error(
        state.supervisorVersion
          ? `crewplane: supervisor ${state.supervisorVersion} interprets queued commands; it may ignore ${command}. Queue it with that release's binary instead`
          : `crewplane: the running supervisor's release is unknown; it may ignore ${command}. Queue it with the pinned release's binary instead`,
      );
    const lane = opts["--lane"];
    const task = opts["--task"];
    const widening = ["retry", "resolve", "resume"].includes(command);
    if (
      opts["--expect-rev"] !== undefined &&
      !(
        /^\d+$/.test(opts["--expect-rev"]) &&
        Number.isSafeInteger(Number(opts["--expect-rev"]))
      )
    )
      throw new Error("--expect-rev must be a non-negative integer");
    const expectedRev =
      opts["--expect-rev"] !== undefined
        ? Number(opts["--expect-rev"])
        : widening && lane && state
          ? (state.laneRev?.[lane] ?? 0)
          : undefined;
    const targetRecords =
      state && lane && task
        ? Object.values(state.records ?? {}).filter(
            (record) => record.lane === lane && record.task === task,
          )
        : [];
    const targetRecord =
      targetRecords.length === 1 ? targetRecords[0] : undefined;
    const value = control({
      action: command,
      ...(opts["--confirm-cleanup"] === "true" ? { confirmCleanup: true } : {}),
      generation: state?.generation,
      ...(lane ? { lane } : {}),
      ...(task ? { task } : {}),
      ...(opts["--new-session"] === "true" ? { newSession: true } : {}),
      ...(opts["--text"] ? { text: opts["--text"] } : {}),
      ...(opts["--approve"] === "true"
        ? { resolution: "approve" as const }
        : {}),
      ...(opts["--deny"] === "true" ? { resolution: "deny" as const } : {}),
      ...(opts["--pause"] ? { pauseId: opts["--pause"] } : {}),
      ...(opts["--all"] === "true" ? { all: true } : {}),
      ...(opts["--run"] ? { run: opts["--run"] } : {}),
      ...(opts["--cancel-active"] === "true" ? { cancelActive: true } : {}),
      ...(expectedRev !== undefined ? { expectRev: expectedRev } : {}),
      ...(opts["--expect-run"]
        ? { expectRun: opts["--expect-run"] }
        : command === "retry" &&
            opts["--confirm-cleanup"] === "true" &&
            targetRecord?.runId
          ? { expectRun: targetRecord.runId }
          : {}),
      ...(opts["--expect-session"]
        ? { expectSession: opts["--expect-session"] }
        : command === "retry" &&
            opts["--new-session"] === "true" &&
            targetRecord?.sessionId
          ? { expectSession: targetRecord.sessionId }
          : {}),
      at: new Date().toISOString(),
    });
    if (command === "resolve") {
      const approve = opts["--approve"];
      const deny = opts["--deny"];
      if (
        (approve === undefined) === (deny === undefined) ||
        (approve !== undefined && approve !== "true") ||
        (deny !== undefined && deny !== "true")
      )
        throw new Error(
          "Resolve requires exactly one of --approve true or --deny true",
        );
    }
    if (value.action === "invalid")
      throw new Error("Invalid control; check the action, target and options");
    if (opts["--wait"] !== undefined) {
      const seconds = Number(opts["--wait"]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
        throw new Error("Wait must be an integer from 1 to 60 seconds");
    }
    if (value.lane) {
      if (["pause", "stop", "cancel"].includes(command)) {
        // Narrowing must never be blocked by a missing or foreign config: the
        // check applies only to the private config, and only when it exists.
        const known = (
          (await readIn(join(directory, "config.json")).catch(() => null)) as {
            lanes?: Record<string, unknown>;
          } | null
        )?.lanes;
        if (known && !(value.lane in known)) {
          if (directory === controlDir)
            throw new Error("Unknown configured agent");
          console.error(
            "crewplane: that agent is not in the (unverified) legacy configuration; queueing anyway",
          );
        }
      } else if (!(value.lane in (await readConfig(directory)).lanes))
        throw new Error("Unknown configured agent");
    }
    if (directory === controlDir) {
      await ensureControlDirectory(directory);
      await bindControl(ctx.store, directory, identity, {
        narrowing: ["stop", "pause", "cancel"].includes(command),
      });
    }
    const id = randomUUID();
    // Narrowing verbs are safe to apply late, so ambiguous legacy liveness
    // queues them in every candidate directory (shared with the dashboard).
    const { running: anyRunning } = await queueControl({
      id,
      value,
      controlDir,
      target: { directory, also },
      knownRunning: state?.running === true,
      warn: (message) => console.error(message),
    });
    if (!anyRunning)
      console.error(
        command === "pause"
          ? "crewplane: no supervisor is running; the pause applies when a supervisor starts"
          : `crewplane: no supervisor is running; this ${command} is bound to the current generation and will be refused as stale by the next start`,
      );
    if (opts["--wait"] !== undefined) {
      const seconds = Number(opts["--wait"]);
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        const current = (await readIn(join(directory, "state.json"))) as {
          controlLog?: Array<{ id: string; outcome: string; code: string }>;
        } | null;
        const entry = current?.controlLog?.find((item) => item.id === id);
        if (entry) {
          process.exitCode =
            entry.outcome === "applied" || entry.outcome === "noop"
              ? 0
              : entry.outcome === "refused" || entry.outcome === "invalid"
                ? 2
                : 3;
          return output({
            id,
            outcome: entry.outcome,
            code: entry.code,
            activation: false,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      process.exitCode = 124;
      return output({ id, outcome: "queued", activation: false });
    }
    return output({ queued: command, id, activation: false });
  }
  if (command === "evidence") {
    const [action, ...args] = rest;
    const opts = options(args, ["--input", "--file", "--run", "--task"]);
    const store = await createEvidenceStore(join(ctx.store, "evidence"));
    const metadata = async () => {
      if (!opts["--input"])
        throw new Error("Evidence mutation requires --input metadata.json");
      const text = await readInput(resolve(requested, opts["--input"]));
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Evidence metadata is not valid JSON");
      }
    };
    if (action === "list")
      return output(
        await store.list(opts["--task"] ? { task: opts["--task"] } : {}),
      );
    if (action === "create")
      return output(
        await store.createRun((await metadata()) as EvidenceRunInput),
      );
    if (action === "manifest" && opts["--run"])
      return output(await store.manifest(opts["--run"]));
    if (action === "append" && opts["--run"] && opts["--file"]) {
      const path = resolve(requested, opts["--file"]);
      const stat = await import("node:fs/promises")
        .then((fs) => fs.stat(path))
        .catch((error: NodeJS.ErrnoException) => {
          throw error.code === "ENOENT"
            ? new Error(`file not found: ${printablePath(path)}`)
            : error;
        });
      if (stat.size > 16 * 1024 * 1024)
        throw new Error("Evidence file exceeds artifact limit");
      return output(
        await store.append(
          opts["--run"],
          (await metadata()) as EvidenceCaptureInput,
          await readFile(path),
        ),
      );
    }
    throw new Error(
      "Use evidence list|create|append|manifest; see docs/USAGE.md for metadata contracts",
    );
  }
  if (command === "monitor") return monitorMain(rest, root);
  if (command === "watchdog") {
    if (rest.length !== 1)
      throw new Error("watchdog requires start, once or status");
    return watchdogMain(rest, { control: controlDir });
  }
  if (command === "dashboard") {
    const opts = options(rest, ["--port", "--controls"]);
    const rawPort = opts["--port"] ?? "4310";
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || port < 1024 || port > 65535)
      throw new Error("Invalid port");
    const controls =
      opts["--controls"] === "true" ? { token: randomUUID() } : undefined;
    const session = { token: newSessionToken() };
    const server = createDashboard(root, {
      session,
      ...(controls ? { controls } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    output(
      `Crewplane dashboard: http://127.0.0.1:${port}/#token=${session.token}${
        controls
          ? `\nControls enabled: send x-crewplane-token: ${controls.token} from an exact Origin\nControls URL (operator access; treat like a password): http://127.0.0.1:${port}/#token=${session.token}&controls=${controls.token}`
          : ""
      }`,
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => server.close());
    return;
  }
  if (command === "start") {
    if (!standaloneBinary())
      throw new Error(
        "Build and use dist/crewplane start so agents can invoke the same executable",
      );
    if (rest.length) throw new Error("start takes no options");
    const stored = await readConfig(directory);
    if (stored.root !== root)
      throw new Error("Configuration belongs to another project");
    // Roles come from committed policy, exactly as `configure` derives them.
    const config = validateConfig({
      ...stored,
      coordinator: policy.coordinator,
      reviewers: policy.reviewers,
      reviewerRoles: policy.reviewerRoles,
    } as unknown as Config);
    process.env.CREWPLANE_EXECUTABLE = process.execPath;
    const controller = new AbortController();
    // Stay handled until the drain finishes: a repeated signal must not fall
    // back to the default action and kill the supervisor mid-drain.
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        if (controller.signal.aborted) return;
        console.error(
          `crewplane: ${signal} received; draining and stopping (further signals are ignored)`,
        );
        controller.abort();
      });
    return serve(config, directory, controller.signal, {
      store: ctx.store,
      gitCommon: common,
    });
  }
  throw new Error("Unknown command. Run crewplane --help.");
}
await main().catch((error: unknown) => {
  console.error(
    `crewplane: ${error instanceof Error ? error.message : "Command failed"}`,
  );
  if (error instanceof ProjectVersionError)
    console.error(versionPinHint(error, dispatchSkip));
  process.exitCode = 1;
});
