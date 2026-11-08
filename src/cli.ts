import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./contracts.ts";
import { main as agents } from "./engine/agents.mjs";
import { control } from "./engine/control-policy.ts";
import { createDashboard } from "./engine/dashboard.ts";
import type {
  EvidenceCaptureInput,
  EvidenceRunInput,
} from "./engine/evidence/contract.ts";
import { createEvidenceStore } from "./engine/evidence/store.ts";
import { harnessCapabilities } from "./engine/harness.ts";
import { snapshot } from "./engine/read-model.ts";
import { serve, validateConfig } from "./engine/supervisor.ts";
import { acquire, monitorMain } from "./engine/watch.ts";
import { watchdogMain } from "./engine/watchdog/runner.ts";
import { publishJson } from "./io.ts";
import { defaultPolicy, projectPolicy } from "./project.ts";

const help = `Crewplane — local orchestration for coding agents

Usage: crewplane [--project PATH] COMMAND
  init                         Create project policy and private file store
  doctor                       Check project and configured harness prerequisites
  configure --file PATH        Validate and install an explicit supervisor config
  agents COMMAND [OPTIONS]     Assign/scope/claim/status/send/inbox/accept/release
  task list                    Show durable tasks and messages
  agent list                   Show configured agents and observed process state
  start                        Run the supervisor in the foreground
  status                       Show persisted supervisor state (never starts it)
  pause|resume|retry|nudge --lane ID [--text TEXT]
  stop                         Request intentional stop and drain
  rollout                      Request an authorized drain; no automatic restart
  dashboard [--port PORT]      Serve read-only dashboard on loopback (default 4310)
  evidence list|create|append|manifest  Manage bounded screenshot/video artifacts
  monitor [--once|--status]     Observe task progress and unanswered messages
  watchdog start|once|status    Independent notice-only health observer
  --help | --version

Git and configured harnesses are external dependencies. No automatic merge,
provider login, budget increase, legacy-state adoption or service activation.
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
  if (command === "--version") return output("0.1.0");
  const ctx = (await agents(["init"], requested)) as {
    store: string;
    gitCommonDir: string;
    projectRoot: string;
  };
  const common = ctx.gitCommonDir,
    root = ctx.projectRoot;
  const directory = join(ctx.store, "supervisor");
  const policy = projectPolicy(root);
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
    const value = JSON.parse(
      await readFile(resolve(requested, opts["--file"]), "utf8"),
    );
    const config = validateConfig({
      ...value,
      root,
      coordinator: policy.coordinator,
      reviewers: policy.reviewers,
      reviewerRoles: policy.reviewerRoles,
    });
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
            permissions:
              lane.harness === "pi" ? "no-tools" : "harness-controlled",
            model: lane.piModel ?? lane.model ?? null,
          }))
        : [],
      providerCredentials: "not-probed",
      servicesStarted: false,
    });
  }
  if (command === "status") {
    if (rest.length) throw new Error("status takes no options");
    return output({
      desired: await optional(join(directory, "desired.json")),
      state: await optional(join(directory, "state.json")),
    });
  }
  if (
    ["pause", "resume", "retry", "nudge", "stop", "rollout"].includes(command)
  ) {
    const opts = options(rest, ["--lane", "--text"]);
    const value = control({
      action: command,
      ...(opts["--lane"] ? { lane: opts["--lane"] } : {}),
      ...(opts["--text"] ? { text: opts["--text"] } : {}),
      at: new Date().toISOString(),
    });
    if (value.action === "invalid")
      throw new Error("Invalid control; specify --lane ID for agent controls");
    if (value.lane && !(value.lane in (await readConfig(directory)).lanes))
      throw new Error("Unknown configured agent");
    await mkdir(join(directory, "commands"), { recursive: true, mode: 0o700 });
    await publishJson(
      join(directory, "commands", `${randomUUID()}.json`),
      value,
    );
    return output({ queued: command, activation: false });
  }
  if (command === "evidence") {
    const [action, ...args] = rest;
    const opts = options(args, ["--input", "--file", "--run", "--task"]);
    const store = await createEvidenceStore(join(ctx.store, "evidence"));
    const metadata = async () => {
      if (!opts["--input"])
        throw new Error("Evidence mutation requires --input metadata.json");
      return JSON.parse(
        await readFile(resolve(requested, opts["--input"]), "utf8"),
      );
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
    const opts = options(rest, ["--port"]);
    const port = Number(opts["--port"] ?? 4310);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid port");
    const server = createDashboard(root);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    output(`Crewplane dashboard: http://127.0.0.1:${port}`);
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
  process.exitCode = 1;
});
