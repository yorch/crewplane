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
import type { Config, State } from "./contracts.ts";
import { main as agents } from "./engine/agents.mjs";
import { control } from "./engine/control-policy.ts";
import { createDashboard } from "./engine/dashboard.ts";
import type {
  EvidenceCaptureInput,
  EvidenceRunInput,
} from "./engine/evidence/contract.ts";
import { createEvidenceStore } from "./engine/evidence/store.ts";
import {
  harnessCapabilities,
  instructionFileProblem,
} from "./engine/harness.ts";
import { snapshot } from "./engine/read-model.ts";
import { serve, validateConfig } from "./engine/supervisor.ts";
import { acquire, monitorMain } from "./engine/watch.ts";
import { watchdogMain } from "./engine/watchdog/runner.ts";
import { publishJson } from "./io.ts";
import {
  defaultPolicy,
  discoverProject,
  type ProjectPolicy,
  ProjectVersionError,
  projectPolicy,
  writeProjectPin,
} from "./project.ts";
import {
  compareVersions,
  isReleaseBuild,
  readUpdateCache,
  runUpdate,
  scheduleAutoUpdate,
  shouldScheduleUpdate,
  supervisorRunning,
  updateCachePath,
  updateTarget,
} from "./update.ts";

const help = `Crewplane — local orchestration for coding agents

Usage: crewplane [--project PATH] COMMAND
  init                         Create project policy and private file store
  pin --confirm true           Point the project's version pin at this release
  doctor                       Check project and configured harness prerequisites
  configure --file PATH        Validate and install an explicit supervisor config
  agents COMMAND [OPTIONS]     Assign/scope/claim/status/send/inbox/accept/release
  task list                    Show durable tasks and messages
  agent list                   Show configured agents and observed process state
  start                        Run the supervisor in the foreground
  status                       Show persisted supervisor state (never starts it)
  pause|resume|retry|nudge --lane ID [--text TEXT]
  retry --lane ID --confirm-cleanup true --text NOTE
                               Acknowledge inspected unverified descendants
  retry --lane ID --task ID --new-session true --text NOTE
                               Start a fresh native session for one task
  resolve --lane ID [--task ID] --pause UUID (--approve true|--deny true) --text NOTE
                               Record an operator decision for a decision pause
  pause|resume --all [--wait N] Hold/release every lane without stopping
  cancel (--run RUN | --all true) [--wait N]
                               Terminate one live run or every live run
  stop [--cancel-active true]  Request intentional stop and drain
  resolve --lane ID --task ID --pause UUID (--approve|--deny) --text NOTE
  rollout                      Request an authorized drain; no automatic restart
  dashboard [--port PORT]      Serve read-only dashboard on loopback (default 4310)
  evidence list|create|append|manifest  Manage bounded screenshot/video artifacts
  monitor [--once|--status]     Observe task progress and unanswered messages
  watchdog start|once|status    Independent notice-only health observer
  update [--check] [--force]   Replace this release binary with the latest one
  --help | --version

Git and configured harnesses are external dependencies. No automatic merge,
provider login, budget increase, legacy-state adoption or service activation.

Release builds check for updates at most once a day and replace themselves
only after SHA-256 and executable verification; the new version runs on the
next invocation. Automatic updates never run during long-lived commands or
while any supervisor is live. Disable with CREWPLANE_NO_AUTO_UPDATE=1 or
CREWPLANE_UPDATE=off; see docs/USAGE.md for the remaining update settings.
`;
const output = (value: unknown) =>
  console.log(
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
const optional = async (path: string) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid private state; inspect before recovery");
  }
};
const lanePermissions = (lane: Config["lanes"][string]) => {
  switch (lane.harness ?? "codex") {
    case "pi":
      return "no-tools";
    case "claude":
      return `permission-mode:${lane.claudePermissionMode}`;
    case "opencode":
      return lane.opencodeAuto === true ? "auto-approve" : "harness-configured";
    default:
      return "harness-controlled";
  }
};
const readConfig = async (directory: string) =>
  validateConfig((await optional(join(directory, "config.json"))) as Config);
function options(args: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !allowed.includes(key) ||
      value === undefined ||
      value.startsWith("--") ||
      key in result
    )
      throw new Error("Invalid command options");
    result[key] = value;
  }
  return result;
}
function flags(args: string[], allowed: string[]) {
  const result = new Set<string>();
  for (const arg of args) {
    if (!allowed.includes(arg) || result.has(arg))
      throw new Error("Invalid command options");
    result.add(arg);
  }
  return result;
}
const knownCommands = new Set([
  "init",
  "doctor",
  "configure",
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
  "dashboard",
  "evidence",
  "monitor",
  "watchdog",
]);
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
  const target = updateTarget(releaseMarked, execPath);
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
 * decision, repointing a stale pin). Node every other project command stays
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
const printable = (value: string) => value.replace(/\p{Cc}/gu, "?");
const standaloneBinary = () =>
  (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun
    ?.isStandaloneExecutable === true;
/**
 * Extra recovery lines for a pin mismatch. They are rendered by the CLI only:
 * the error message itself stays one line because the supervisor persists it.
 */
function versionPinHint(error: ProjectVersionError): string {
  const order = compareVersions(error.running, error.required);
  const direction =
    order > 0
      ? "this project pins an OLDER release; `crewplane update` only installs the latest release"
      : `this project requires a NEWER release; \`crewplane update\` installs the latest, which may not be ${error.required}`;
  const lines = [
    `  pin:     requiredVersion in ${printable(error.policyPath)} (primary checkout; applies to every worktree)`,
  ];
  if (standaloneBinary())
    lines.push(`  binary:  ${printable(process.execPath)}`);
  lines.push(
    `  ${direction}`,
    `  cure:    install ${error.required} into its own directory and invoke it by absolute path`,
    "  sticky:  release builds resume automatic update; set CREWPLANE_NO_AUTO_UPDATE=1",
    '  details: docs/USAGE.md "Project version pins"',
  );
  return lines.join("\n");
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
  if (command === "--version") return output(pkg.version);
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
      output({
        version: 1,
        status: "failed",
        current: pkg.version,
        checkedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : "Update failed",
      });
      process.exitCode = 1;
      return;
    }
  }
  let ctx: ProjectContext;
  let policy: ProjectPolicy;
  try {
    ctx = (await agents(["init"], requested)) as ProjectContext;
    policy = projectPolicy(ctx.projectRoot);
  } catch (error) {
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
    if (command !== "pin")
      console.error(
        `crewplane: queuing ${command} despite the release mismatch; every other project command stays blocked`,
      );
  }
  const common = ctx.gitCommonDir,
    root = ctx.projectRoot;
  const directory = join(ctx.store, "supervisor");
  if (!policy.requiredVersion) await autoUpdate(command).catch(() => {});
  if (command === "pin") {
    const opts = options(rest, ["--confirm"]);
    if (opts["--confirm"] !== undefined && opts["--confirm"] !== "true")
      throw new Error("Pin confirmation must be true");
    if (!policy.requiredVersion)
      throw new Error(
        "Project is not pinned; requiredVersion requires project policy version 2",
      );
    const state = (await optional(join(directory, "state.json"))) as {
      running?: boolean;
    } | null;
    if (state?.running)
      throw new Error("Stop the supervisor before changing the project pin");
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
    const lines = ["/.crewplane-state/", "/.crewplane-local/"];
    await appendFile(
      exclude,
      `\n${lines.filter((line) => !prior.split("\n").includes(line)).join("\n")}\n`,
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
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(
        await readFile(resolve(requested, opts["--file"]), "utf8"),
      );
    } catch {
      throw new Error("Configuration file is not valid JSON");
    }
    // SAFETY: validateConfig is the runtime decoder for untrusted JSON input.
    const config = validateConfig({
      ...value,
      root,
      coordinator: policy.coordinator,
      reviewers: policy.reviewers,
      reviewerRoles: policy.reviewerRoles,
    } as unknown as Config);
    for (const [laneId, lane] of Object.entries(config.lanes)) {
      if (!lane.instructionsPath) continue;
      const problem = instructionFileProblem(
        config.root,
        lane.instructionsPath,
      );
      if (problem)
        throw new Error(`Lane ${laneId} instructions unavailable: ${problem}`);
    }
    const release = await acquire(directory);
    try {
      const state = await optional(join(directory, "state.json"));
      if (state?.running)
        throw new Error(
          "Stop and inspect the existing supervisor before replacing configuration",
        );
      await publishJson(join(directory, "config.json"), config);
    } finally {
      await release();
    }

    return output({
      configured: true,
      started: false,
      agents: Object.keys(config.lanes),
    });
  }
  if (command === "doctor") {
    if (rest.length) throw new Error("doctor takes no options");
    const config = await optional(join(directory, "config.json"));
    if (config) validateConfig(config);
    return output({
      version: 1,
      root,
      git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
      runtime: "bun",
      config: config ? "valid" : "not-configured",
      harnesses: config
        ? Object.entries((config as Config).lanes).map(([id, lane]) => ({
            id,
            harness: lane.harness ?? "codex",
            capabilities: harnessCapabilities[lane.harness ?? "codex"],
            permissions: lanePermissions(lane),
            model: lane.piModel ?? lane.model ?? null,
            instructions: lane.instructionsPath
              ? (instructionFileProblem(root, lane.instructionsPath) ?? "ok")
              : "none",
            budgets: {
              maxRunsPerHour: lane.maxRunsPerHour ?? null,
              maxRunMinutes: lane.maxRunMinutes ?? null,
            },
            claude:
              lane.harness === "claude"
                ? {
                    mcp: lane.claudeMcp ?? null,
                    settingSources: lane.claudeSettingSources ?? null,
                    tools: lane.claudeTools ?? null,
                    allowedTools: lane.claudeAllowedTools ?? null,
                    disallowedTools: lane.claudeDisallowedTools ?? null,
                    maxCostUsdPerRun: lane.maxCostUsdPerRun ?? null,
                  }
                : null,
            opencode:
              lane.harness === "opencode"
                ? {
                    agent: lane.opencodeAgent ?? null,
                    auto: lane.opencodeAuto === true,
                  }
                : null,
          }))
        : [],
      globalInstructions: (() => {
        const problem = instructionFileProblem(
          root,
          projectPolicy(root).instructionsPath,
        );
        return problem ?? "ok";
      })(),
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
          observed: state.running ? "running" : "dead",
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
    return output({ desired, state, view });
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
    if (process.env.CREWPLANE_HEADLESS_LANE)
      throw new Error("Control commands are unavailable to headless agents");
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
    const state = (await optional(join(directory, "state.json"))) as {
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
    } | null;
    const lane = opts["--lane"];
    const task = opts["--task"];
    const widening = ["retry", "resolve", "resume"].includes(command);
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
    if (value.lane && !(value.lane in (await readConfig(directory)).lanes))
      throw new Error("Unknown configured agent");
    await mkdir(join(directory, "commands"), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    await publishJson(join(directory, "commands", `${id}.json`), value);
    if (opts["--wait"] !== undefined) {
      const seconds = Number(opts["--wait"]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
        throw new Error("Wait must be an integer from 1 to 60 seconds");
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        const current = (await optional(join(directory, "state.json"))) as {
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
      try {
        return JSON.parse(
          await readFile(resolve(requested, opts["--input"]), "utf8"),
        );
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
      const stat = await import("node:fs/promises").then((fs) => fs.stat(path));
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
    process.env.CREWPLANE_COORD_DIR = ctx.store;
    return watchdogMain(rest);
  }
  if (command === "dashboard") {
    const opts = options(rest, ["--port", "--controls"]);
    const port = Number(opts["--port"] ?? 4310);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid port");
    const controls =
      opts["--controls"] === "true" ? { token: randomUUID() } : undefined;
    const server = createDashboard(root, { ...(controls ? { controls } : {}) });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    output(
      `Crewplane dashboard: http://127.0.0.1:${port}${
        controls
          ? `\nControls enabled: send x-crewplane-token: ${controls.token} from an exact Origin`
          : ""
      }`,
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => server.close());
    return;
  }
  if (command === "start") {
    if (!Bun.isStandaloneExecutable)
      throw new Error(
        "Build and use dist/crewplane start so agents can invoke the same executable",
      );
    if (rest.length) throw new Error("start takes no options");
    const config = await readConfig(directory);
    if (config.root !== root)
      throw new Error("Configuration belongs to another project");
    process.env.CREWPLANE_EXECUTABLE = process.execPath;
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => controller.abort());
    return serve(config, directory, controller.signal);
  }
  throw new Error("Unknown command. Run crewplane --help.");
}
await main().catch((error: unknown) => {
  console.error(
    `crewplane: ${error instanceof Error ? error.message : "Command failed"}`,
  );
  if (error instanceof ProjectVersionError)
    console.error(versionPinHint(error));
  process.exitCode = 1;
});
