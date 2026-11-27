import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlDirectory, ensureControlDirectory } from "../src/control.ts";
import { createDashboard, newSessionToken } from "../src/engine/dashboard.ts";
import { legacyRefusal } from "../src/migrate.ts";
import { cacheDirectory } from "../src/update.ts";

/**
 * The dashboard's POST /api/control and the real CLI must make the same
 * decision for the same intent on the same project: accept or refuse, and
 * queue the same command (ignoring id, timestamp, issuer and format version)
 * into the same directories. Run against a legacy in-store supervisor layout,
 * where the CLI fails closed for widening verbs and queues narrowing verbs
 * into the legacy and/or control directory.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-parity-")));
const previous = {
  state: process.env.CREWPLANE_STATE_DIR,
  cache: process.env.CREWPLANE_CACHE_DIR,
};
process.env.CREWPLANE_STATE_DIR = join(base, "state");
// Supervisor registrations (the fake supervisor below writes one) and every
// updater cache file land here, never in the real home directory. The CLI
// children inherit it through `env`.
process.env.CREWPLANE_CACHE_DIR = join(base, "cache");
const root = join(base, "project");
const store = join(root, ".crewplane-state");
const legacy = join(store, "supervisor");
const controls = { token: "22222222-2222-4222-8222-222222222222" };
const session = { token: newSessionToken() };
const run = "1794100000001-00000000-0000-4000-8000-000000000001";
const pauseId = "00000000-0000-4000-8000-000000000002";
const env = {
  ...process.env,
  CREWPLANE_COORD_DIR: "",
  CREWPLANE_NO_AUTO_UPDATE: "1",
  CREWPLANE_RELEASES_DIR: join(base, "releases-absent"),
};
/** Every fake supervisor started, so a timed-out scenario cannot leak one. */
const children = new Set<ChildProcess>();
const killChildren = () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
};
process.once("exit", killChildren);
let control = "";
let server: ReturnType<typeof createDashboard>;
let url = "";

const validState = (extra: object = {}) => ({
  version: 2,
  running: false,
  checkedAt: "2000-01-01T00:00:00.000Z",
  pid: 2 ** 22 + 12345,
  draining: false,
  held: [],
  commands: [],
  records: {},
  notices: {},
  generation: "gen-legacy",
  ...extra,
});
/** The private supervisor state: alive (this process) or a dead, stale one. */
const privateState = (alive: boolean) =>
  validState({
    running: alive,
    checkedAt: alive ? new Date().toISOString() : "2000-01-01T00:00:00.000Z",
    pid: alive ? process.pid : 2 ** 22 + 99,
    generation: "gen-current",
    laneRev: { builder: 4 },
  });
const cli = (...args: string[]) =>
  spawnSync("bun", [resolve("src/cli.ts"), "--project", root, ...args], {
    env,
    encoding: "utf8",
    timeout: 20000,
  });
/** A process that is credibly a supervisor to the liveness check. */
async function fakeSupervisor() {
  const script = join(base, "src", "cli.ts");
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(script, "setInterval(() => {}, 1e9);\n");
  const child = spawn("bun", [script, "start"], { stdio: "ignore" });
  children.add(child);
  await new Promise((r) => setTimeout(r, 400));
  const pid = child.pid as number;
  const file = join(cacheDirectory(), "supervisors", `${pid}.json`);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    JSON.stringify({ version: 1, pid, at: new Date().toISOString() }),
  );
  return {
    pid,
    stop: () => {
      rmSync(file, { force: true });
      child.kill("SIGKILL");
      children.delete(child);
    },
  };
}

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, stdio: "pipe", env });
  writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: parity fixture");
  control = controlDirectory(root);
  await ensureControlDirectory(control);
  mkdirSync(join(control, "commands"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(control, "config.json"),
    JSON.stringify({
      version: 1,
      root,
      binary: "/bin/true",
      allowedTasks: [],
      maxParallel: 2,
      intervalSeconds: 10,
      maxRunMinutes: 10,
      maxRunsPerHour: 10,
      confirmedStoppedAt: new Date().toISOString(),
      lanes: { builder: { enabled: true, harness: "codex" } },
    }),
    { mode: 0o600 },
  );
  server = createDashboard(root, {
    controls,
    session,
    controlGuard: { perMinute: 1000 },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  killChildren();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
  if (previous.state === undefined) delete process.env.CREWPLANE_STATE_DIR;
  else process.env.CREWPLANE_STATE_DIR = previous.state;
  if (previous.cache === undefined) delete process.env.CREWPLANE_CACHE_DIR;
  else process.env.CREWPLANE_CACHE_DIR = previous.cache;
});

const post = async (body: unknown) => {
  const response = await fetch(`${url}/api/control`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: url,
      "x-crewplane-token": controls.token,
      "x-crewplane-session": session.token,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};
/** Every queued command in the directory, without what legitimately differs. */
const queued = (directory: string) => {
  const commands = join(directory, "commands");
  let names: string[] = [];
  try {
    names = readdirSync(commands).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const {
        at: _at,
        v: _v,
        issuer: _issuer,
        ...rest
      } = JSON.parse(readFileSync(join(commands, name), "utf8"));
      return JSON.stringify(
        Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)),
      );
    })
    .sort();
};
const wipe = () => {
  for (const directory of [control, legacy])
    try {
      for (const name of readdirSync(join(directory, "commands")))
        rmSync(join(directory, "commands", name), { force: true });
    } catch {
      /* absent */
    }
};

// [name, CLI arguments, dashboard body, widening]
const verbs: Array<[string, string[], Record<string, unknown>, boolean]> = [
  [
    "pause lane",
    ["pause", "--lane", "builder"],
    { action: "pause", lane: "builder" },
    false,
  ],
  [
    "pause all",
    ["pause", "--all", "true"],
    { action: "pause", all: true },
    false,
  ],
  ["stop", ["stop"], { action: "stop" }, false],
  [
    "cancel run",
    ["cancel", "--lane", "builder", "--run", run],
    { action: "cancel", lane: "builder", run },
    false,
  ],
  [
    "resume lane",
    ["resume", "--lane", "builder"],
    { action: "resume", lane: "builder", expectRev: 4 },
    true,
  ],
  [
    "retry lane",
    ["retry", "--lane", "builder"],
    { action: "retry", lane: "builder", expectRev: 4 },
    true,
  ],
  [
    "resolve",
    [
      "resolve",
      "--lane",
      "builder",
      "--task",
      "CP-101",
      "--pause",
      pauseId,
      "--approve",
      "true",
      "--text",
      "ok",
    ],
    {
      action: "resolve",
      lane: "builder",
      task: "CP-101",
      pauseId,
      resolution: "approve",
      text: "ok",
      expectRev: 4,
    },
    true,
  ],
  [
    "nudge",
    ["nudge", "--lane", "builder", "--text", "hi"],
    { action: "nudge", lane: "builder", text: "hi" },
    true,
  ],
];

const scenarios: Array<
  [string, boolean, () => Promise<() => void>, string[]?]
> = [
  ["no legacy layout", true, async () => () => {}],
  [
    "legacy layout, live private supervisor",
    true,
    async () => {
      mkdirSync(join(legacy, "commands"), { recursive: true, mode: 0o700 });
      writeFileSync(join(legacy, "state.json"), JSON.stringify(validState()));
      return () => rmSync(legacy, { recursive: true, force: true });
    },
  ],
  [
    "legacy layout, nothing live",
    false,
    async () => {
      mkdirSync(join(legacy, "commands"), { recursive: true, mode: 0o700 });
      writeFileSync(join(legacy, "state.json"), JSON.stringify(validState()));
      return () => rmSync(legacy, { recursive: true, force: true });
    },
  ],
  [
    // The legacy state claims a fresh heartbeat but its pid is no registered
    // supervisor: the CLI cannot tell a live older release from a stale file,
    // so halting verbs go to the control directory and also to the legacy one.
    "legacy layout, ambiguous (fresh heartbeat, unregistered pid)",
    false,
    async () => {
      mkdirSync(join(legacy, "commands"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(legacy, "state.json"),
        JSON.stringify(
          validState({
            running: true,
            checkedAt: new Date().toISOString(),
            pid: 2 ** 22 + 12345,
          }),
        ),
      );
      return () => rmSync(legacy, { recursive: true, force: true });
    },
    [
      "pause lane: 1c/1l",
      "pause all: 1c/1l",
      "stop: 1c/1l",
      "cancel run: 1c/1l",
    ],
  ],
  [
    "legacy layout with a live older-release supervisor",
    false,
    async () => {
      const sup = await fakeSupervisor();
      mkdirSync(join(legacy, "commands"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(legacy, "state.json"),
        JSON.stringify(validState({ running: true, pid: sup.pid })),
      );
      return () => {
        sup.stop();
        rmSync(legacy, { recursive: true, force: true });
      };
    },
  ],
];

describe.each(scenarios)(
  "CLI and dashboard agree: %s",
  (_name, alive, setup, mirrored) => {
    it("accepts, refuses and queues identically for every verb", async () => {
      const teardown = await setup();
      const seen: string[] = [];
      try {
        for (const [name, args, body, widening] of verbs) {
          writeFileSync(
            join(control, "state.json"),
            JSON.stringify(privateState(alive)),
            {
              mode: 0o600,
            },
          );
          wipe();
          const result = cli(...args);
          const cliQueued = {
            control: queued(control),
            legacy: queued(legacy),
          };
          const cliAccepted = result.status === 0;
          wipe();
          const answer = await post({
            ...body,
            requestId: crypto.randomUUID(),
          });
          const dashboardQueued = {
            control: queued(control),
            legacy: queued(legacy),
          };
          const label = `${name}: cli=${result.status} (${result.stderr.split("\n")[0]}) dashboard=${answer.status} ${JSON.stringify(answer.body)}`;
          // Same accept/refuse.
          expect(answer.status === 200, label).toBe(cliAccepted);
          if (!cliAccepted) {
            expect(result.stderr, label).toContain(legacyRefusal);
            expect(answer.status, label).toBe(409);
            expect(answer.body.code, label).toBe("LEGACY_LAYOUT");
            expect(String(answer.body.error), label).toContain(
              "crewplane migrate",
            );
            expect(widening, label).toBe(true);
          }
          // Same queue location(s) and contents.
          expect(dashboardQueued, label).toEqual(cliQueued);
          if (cliAccepted)
            seen.push(
              `${name}: ${cliQueued.control.length}c/${cliQueued.legacy.length}l`,
            );
        }
      } finally {
        teardown();
        wipe();
      }
      // The scenario must actually exercise what it claims to.
      expect(seen.length).toBeGreaterThan(0);
      // The ambiguous branch queues every halting verb in both directories
      // and refuses every widening one; pin it so it cannot silently change.
      if (mirrored) expect(seen).toEqual(mirrored);
    }, 120000);
  },
);
