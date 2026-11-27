import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { snapshot } from "../board.ts";
import type { Config, State } from "../contracts.ts";
import { controlDirectory } from "../control.ts";
import { serve } from "./supervisor.ts";

// Control directories and supervisor registrations never touch the real home.
const isolated = {
  state: process.env.CREWPLANE_STATE_DIR,
  cache: process.env.CREWPLANE_CACHE_DIR,
};
const isolation = mkdtempSync(join(tmpdir(), "crewplane-rev-iso-"));
process.env.CREWPLANE_STATE_DIR = join(isolation, "state");
process.env.CREWPLANE_CACHE_DIR = join(isolation, "cache");
afterAll(() => {
  rmSync(isolation, { recursive: true, force: true });
  if (isolated.state === undefined) delete process.env.CREWPLANE_STATE_DIR;
  else process.env.CREWPLANE_STATE_DIR = isolated.state;
  if (isolated.cache === undefined) delete process.env.CREWPLANE_CACHE_DIR;
  else process.env.CREWPLANE_CACHE_DIR = isolated.cache;
});

/**
 * The lane revision is the pin every widening control carries: any transition
 * that creates or changes a record's status or pause kind must move it, so a
 * lane-wide retry pinned before the transition is answered stale.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewplane-rev-"));
  await writeFile(join(root, ".gitignore"), ".crewplane-state/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: revision fixture");
  const directory = controlDirectory(root);
  await mkdir(join(directory, "commands"), { recursive: true, mode: 0o700 });
  const load = async () => {
    try {
      return JSON.parse(
        await readFile(join(directory, "state.json"), "utf8"),
      ) as State;
    } catch {
      return undefined;
    }
  };
  const config: Config = {
    version: 1,
    root,
    binary: process.execPath,
    allowedTasks: [],
    maxParallel: 2,
    intervalSeconds: 1,
    maxRunMinutes: 1,
    maxRunsPerHour: 20,
    confirmedStoppedAt: new Date().toISOString(),
    lanes: { coordinator: { enabled: false }, builder: { enabled: true } },
  } as unknown as Config;
  return { root, directory, load, config };
}
const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 9000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Revision fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const record = (cwd: string, extra: object) => ({
  key: "builder:CP-101",
  lane: "builder",
  task: "CP-101",
  cwd,
  harness: "codex",
  status: "paused",
  reason: "x",
  seen: [],
  runs: [],
  noProgress: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...extra,
});
const baseState = (extra: object) => ({
  version: 2,
  running: false,
  checkedAt: new Date().toISOString(),
  pid: process.pid,
  draining: false,
  held: [],
  commands: [],
  notices: {},
  laneRev: { builder: 4 },
  ...extra,
});

it("a retry pinned before startup recovery created a paused failure is stale", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  try {
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify(
        baseState({
          // Left "running" without a child identity by an earlier supervisor.
          records: { "builder:CP-101": record(f.root, { status: "running" }) },
        }),
      ),
    );
    await writeFile(join(f.directory, "config.json"), JSON.stringify(f.config));
    // The operator pinned revision 4, which they saw before the restart.
    await writeFile(
      join(f.directory, "commands", `${id}.json`),
      JSON.stringify({
        v: 2,
        action: "retry",
        lane: "builder",
        expectRev: 4,
        issuer: "dashboard",
        at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const running = serve(f.config, f.directory, controller.signal);
    await until(async () =>
      ((await f.load())?.controlLog ?? []).some((e) => e.id === id),
    );
    const state = (await f.load()) as State;
    expect(state.controlLog?.find((e) => e.id === id)).toMatchObject({
      outcome: "stale",
      code: "STALE_REVISION",
    });
    expect(state.records["builder:CP-101"]).toMatchObject({
      status: "paused",
      pauseKind: "failure",
    });
    expect(state.laneRev?.builder).toBeGreaterThan(4);
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("a pinned retry applies when nothing changed after the pin", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  try {
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify(
        baseState({
          records: {
            "builder:CP-101": record(f.root, { pauseKind: "failure" }),
          },
        }),
      ),
    );
    await writeFile(join(f.directory, "config.json"), JSON.stringify(f.config));
    await writeFile(
      join(f.directory, "commands", `${id}.json`),
      JSON.stringify({
        v: 2,
        action: "retry",
        lane: "builder",
        expectRev: 4,
        issuer: "dashboard",
        at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const running = serve(f.config, f.directory, controller.signal);
    await until(async () =>
      ((await f.load())?.controlLog ?? []).some((e) => e.id === id),
    );
    expect(
      ((await f.load()) as State).controlLog?.find((e) => e.id === id),
    ).toMatchObject({ outcome: "applied", code: "RETRY" });
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

const boardWith = (extra: object) => async (root: string) => {
  const board = await snapshot(root);
  board.tasks.push({
    id: "T2",
    title: "x",
    owner: "builder",
    phase: "test",
    state: "assigned",
    documentedStatus: "assigned",
    goal: "x",
    dependencies: "",
    scheduling: { code: "ready", label: "ready" },
    markdown: "x",
    live: {
      task: "T2",
      assignment: {
        owner: "builder",
        baseCommit: "b".repeat(40),
        at: new Date().toISOString(),
        text: "x",
      },
      claim: null,
      status: null,
      accepted: null,
      ...extra,
    },
  } as never);
  return board;
};
const send = async (
  f: Awaited<ReturnType<typeof fixture>>,
  body: object,
): Promise<string> => {
  const id = crypto.randomUUID();
  await writeFile(
    join(f.directory, "commands", `${id}.json`),
    JSON.stringify({ v: 2, ...body, at: new Date().toISOString() }),
  );
  return id;
};
const outcomeOf = async (
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
) => {
  await until(async () =>
    ((await f.load())?.controlLog ?? []).some((e) => e.id === id),
  );
  return ((await f.load()) as State).controlLog?.find((e) => e.id === id);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("a lane blocked by retained process ownership keeps a stable revision across scheduling passes and a pinned confirm-cleanup retry applies", async () => {
  const f = await fixture();
  delete process.env.CREWPLANE_COORD_DIR;
  const controller = new AbortController();
  try {
    const config = { ...f.config, allowedTasks: ["T2"], maxParallel: 4 };
    await writeFile(join(f.directory, "config.json"), JSON.stringify(config));
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify(
        baseState({
          laneRev: {},
          records: {
            "builder:T1": record(f.root, {
              key: "builder:T1",
              task: "T1",
              pauseKind: "failure",
              reason: "Unverified descendants",
              cleanupUnverified: true,
            }),
          },
        }),
      ),
    );
    const running = serve(config, f.directory, controller.signal, {
      readBoard: boardWith({}),
    } as never);
    const revisions: number[] = [];
    for (let i = 0; i < 7; i++) {
      await wait(500);
      revisions.push((await f.load())?.laneRev?.builder ?? 0);
    }
    // Startup may move the revision once; idle passes must not.
    const settled = revisions.slice(2);
    expect(new Set(settled).size, `revisions ${revisions}`).toBe(1);
    const pinned = settled[0] as number;
    await wait(2500);
    const state = (await f.load()) as State;
    expect(state.laneRev?.builder ?? 0).toBe(pinned);
    const id = await send(f, {
      action: "retry",
      lane: "builder",
      task: "T1",
      confirmCleanup: true,
      text: "inspected",
      expectRev: pinned,
      generation: state.generation,
    });
    expect(await outcomeOf(f, id)).toMatchObject({ outcome: "applied" });
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
}, 40_000);

it("a lane whose task checkout cannot be validated keeps a stable revision across scheduling passes", async () => {
  const f = await fixture();
  delete process.env.CREWPLANE_COORD_DIR;
  const controller = new AbortController();
  try {
    const config = { ...f.config, allowedTasks: ["T2"], maxParallel: 4 };
    await writeFile(join(f.directory, "config.json"), JSON.stringify(config));
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify(baseState({ laneRev: {}, records: {} })),
    );
    const running = serve(config, f.directory, controller.signal, {
      // The assignment's base commit does not exist, so checkout setup fails.
      readBoard: boardWith({}),
    } as never);
    await until(
      async () => Object.keys((await f.load())?.records ?? {}).length > 0,
    );
    const revisions: number[] = [];
    for (let i = 0; i < 6; i++) {
      await wait(500);
      revisions.push((await f.load())?.laneRev?.builder ?? 0);
    }
    expect(new Set(revisions).size, `revisions ${revisions}`).toBe(1);
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
}, 40_000);
