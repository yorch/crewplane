/** Native lifecycle acceptance: real signals/groups, compiled controlled adapters only. */
import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin" && process.platform !== "linux")
  throw Error("Lifecycle acceptance requires macOS/Linux");
const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-native-life-")),
  ),
  tools = join(parent, "tools"),
  bin = join(tools, "crewplane"),
  harness = join(tools, "fixture-harness");
mkdirSync(tools);
copyFileSync(resolve("dist/crewplane"), bin);
const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
symlinkSync(gitPath, join(tools, "git"));
assert(
  (
    await Bun.build({
      entrypoints: [resolve("tests/fixtures/lifecycle-harness.ts")],
      compile: { outfile: harness },
    })
  ).success,
);
const controllers: ChildProcess[] = [],
  groups = new Set<number>(),
  escaped = new Set<number>();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const until = async (check: () => boolean, label: string, limit = 20000) => {
  const end = Date.now() + limit;
  while (!check()) {
    if (Date.now() > end) throw Error(`Native lifecycle timeout: ${label}`);
    await Bun.sleep(30);
  }
};
const exit = async (child: ChildProcess, limit = 15000) => {
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "controller exit",
    limit,
  );
};
let logs = "";
function setup(name: string, mode: string, interval = 1) {
  const root = join(parent, name);
  mkdirSync(root);
  const env = {
    ...process.env,
    PATH: tools,
    HOME: join(parent, "home"),
    CREWPLANE_COORD_DIR: "",
    CREWPLANE_FIXTURE_MODE: mode,
    CREWPLANE_FIXTURE_PID_FILE: join(
      root,
      ".crewplane-local/fixture-pids.json",
    ),
  };
  mkdirSync(env.HOME, { recursive: true });
  const cli = (...args: string[]) => {
    const r = spawnSync(bin, ["--project", root, ...args], {
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      stdio: "pipe",
    });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  cli("init");
  mkdirSync(join(root, ".crewplane-local"));
  writeFileSync(
    join(root, "crewplane.json"),
    JSON.stringify({
      version: 1,
      coordinator: "captain",
      reviewers: [],
      reviewerRoles: {},
    }),
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "Synthetic lifecycle fixture, no real workflows.\n",
  );
  git("add", ".");
  git("commit", "-qm", "test: synthetic lifecycle baseline");
  const config = join(root, ".crewplane-local/config.json");
  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      binary: harness,
      allowedTasks: [],
      maxParallel: 1,
      intervalSeconds: interval,
      maxRunMinutes: 1,
      maxRunsPerHour: 10,
      confirmedStoppedAt: new Date().toISOString(),
      lanes: { captain: { enabled: true } },
    }),
  );
  cli("configure", "--file", config);
  const state = () => {
    try {
      return JSON.parse(
        readFileSync(
          join(root, ".crewplane-state/supervisor/state.json"),
          "utf8",
        ),
      );
    } catch {
      return null;
    }
  };
  const records = () =>
    Object.values(state()?.records ?? {}) as Array<{
      pid?: number;
      processGroupId?: number;
      status: string;
      sessionId?: string;
      cleanupUnverified?: boolean;
      reason?: string;
    }>;
  const start = () => {
    const child = spawn(bin, ["--project", root, "start"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    controllers.push(child);
    child.stdout?.on("data", (b) => (logs += b));
    child.stderr?.on("data", (b) => (logs += b));
    return child;
  };
  const pids = () => {
    try {
      return JSON.parse(
        readFileSync(env.CREWPLANE_FIXTURE_PID_FILE, "utf8"),
      ) as { leader: number; child: number };
    } catch {
      return null;
    }
  };
  const collect = () => {
    const pid = pids();
    if (pid) {
      groups.add(pid.leader);
      if (mode === "escaped-stdio") escaped.add(pid.child);
    }
    for (const r of records())
      if (r.processGroupId) groups.add(r.processGroupId);
  };
  return { root, cli, state, records, start, pids, collect };
}
try {
  // An enabled coordinator receives a prompt only after durable launch identity.
  const idle = setup("idle", "idle", 60),
    idleController = idle.start();
  await until(
    () => idle.records().some((r) => r.status === "idle" && !!r.sessionId),
    "enabled coordinator session persistence",
  );
  const stoppedAt = Date.now();
  idleController.kill("SIGTERM");
  await exit(idleController, 5000);
  assert(
    Date.now() - stoppedAt < 5000,
    "idle SIGTERM must wake the 60-second wait",
  );
  assert.equal(idle.cli("status").desired.desiredRunning, false);
  assert(
    !existsSync(join(idle.root, ".crewplane-state/supervisor/watcher.lock")),
  );
  // A normal leader exit must not leave its background group writing behind it.
  const background = setup("background", "normal-background"),
    bgController = background.start();
  await until(() => !!background.pids(), "normal child identity");
  background.collect();
  const bg = background.pids();
  assert(bg);
  await until(
    () =>
      background.records().some((r) => r.status !== "running") &&
      !alive(-bg.leader),
    "normal process-group cleanup",
  );
  background.cli("stop");
  await exit(bgController);
  // The leader may be dead after a crash while its detached native group lives.
  const orphan = setup("orphan", "hold"),
    orphanController = orphan.start();
  await until(
    () => !!orphan.pids() && orphan.records().some((r) => !!r.sessionId),
    "live child and captured session",
  );
  orphan.collect();
  const old = orphan.pids();
  assert(old);
  orphanController.kill("SIGKILL");
  await exit(orphanController);
  process.kill(old.leader, "SIGKILL");
  await until(() => !alive(old.leader), "dead native leader");
  assert(alive(-old.leader), "fixture must leave live group member");
  const refused = orphan.start();
  await exit(refused, 5000);
  assert.notEqual(refused.exitCode, 0, "restart must refuse a live old group");
  assert.equal(orphan.pids()?.leader, old.leader);
  process.kill(-old.leader, "SIGKILL");
  // An escaped stdio holder is unverified, never silently accepted as clean completion.
  const stdio = setup("stdio", "escaped-stdio"),
    stdioController = stdio.start();
  await until(() => !!stdio.pids(), "escaped stdio child");
  stdio.collect();
  await until(
    () =>
      stdio
        .records()
        .some((r) => r.status === "paused" && r.cleanupUnverified === true),
    "bounded stdio failure",
    25000,
  );
  stdio.cli("stop");
  await exit(stdioController);
  const stray = stdio.pids();
  if (stray && alive(stray.child)) process.kill(stray.child, "SIGKILL");
  // Exercise the actual one-minute production deadline and retained TERM→KILL group cleanup.
  const deadline = setup("deadline", "deadline"),
    deadlineController = deadline.start();
  await until(() => !!deadline.pids(), "deadline child identity");
  deadline.collect();
  const timed = deadline.pids();
  assert(timed);
  await until(
    () =>
      deadline
        .records()
        .some(
          (r) => r.status === "paused" && /Time budget/i.test(r.reason ?? ""),
        ),
    "timeout classification",
    85000,
  );
  await until(
    () => !alive(-timed.leader),
    "SIGTERM-ignoring group killed",
    20000,
  );
  deadline.cli("stop");
  await exit(deadlineController);
  console.log(
    "Native lifecycle acceptance passed: enabled coordinator, durable prompt/PID/session handshake, prompt SIGTERM drain, process-group cleanup, live-group restart refusal, bounded escaped-stdio failure and real production deadline.",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  for (const child of controllers)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  for (const group of groups)
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
  for (const pid of escaped)
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  await Promise.all(
    controllers.map((child) => exit(child, 5000).catch(() => {})),
  );
  rmSync(parent, { recursive: true, force: true });
}
