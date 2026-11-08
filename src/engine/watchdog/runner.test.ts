import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { evaluateWatchdog } from "./policy.ts";
import { readHealth, settings } from "./runner.ts";
import { checkWatchdog } from "./service.ts";

it("projects private health without raw notices, tolerates missing config and checks notice-only", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-health-input-"));
  try {
    await mkdir(join(store, "supervisor"), { mode: 0o700, recursive: true });
    const now = Date.now();
    await writeFile(
      join(store, "supervisor/state.json"),
      JSON.stringify({
        pid: process.pid,
        running: true,
        checkedAt: new Date(now).toISOString(),
        held: [],
        notices: { coordinator: ["PRIVATE_SENTINEL"] },
        records: {
          a: {
            lane: "coordinator",
            status: "running",
            pid: process.pid,
            startedAt: new Date(now).toISOString(),
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(store, "supervisor/desired.json"),
      JSON.stringify({ desiredRunning: false }),
      { mode: 0o600 },
    );
    const input = await readHealth(store, now);
    expect(input.supervisor.alive).toBe("alive");
    expect(input.children).toEqual([{ pid: process.pid, alive: "alive" }]);
    expect(input.desiredRunning).toBe(false);
    expect(input.config).toEqual({ loaded: null, disk: null });
    expect(input.coordinator.oldestUnhandledAt).toBeNull();
    expect(JSON.stringify(input)).not.toContain("PRIVATE_SENTINEL");
    let recoveryCalls = 0;
    const result = await checkWatchdog({
      directory: join(store, "watchdog"),
      settings,
      signal: new AbortController().signal,
      readInput: async () => input,
      notify: async () => {},
      requestRecovery: async () => {
        recoveryCalls++;
      },
    });
    expect(result?.recovery).toBe("none");
    expect(recoveryCalls).toBe(0);
    const persisted = JSON.parse(
      await readFile(join(store, "watchdog/latest.json"), "utf8"),
    );
    expect(persisted.nextCheck - persisted.checkedAt).toBe(180000);
    await writeFile(join(store, "supervisor/state.json"), "{PRIVATE_SENTINEL", {
      mode: 0o600,
    });
    const missing = await readHealth(store, now);
    expect(missing.supervisor.alive).toBe("unknown");
    expect(missing.children).toEqual([]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("keeps partially shaped private snapshots unknown-safe", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-invalid-health-"));
  try {
    await mkdir(join(store, "supervisor"), { mode: 0o700, recursive: true });
    for (const decoded of [
      null,
      [],
      "bad",
      { records: { bad: null } },
      { records: { p: { lane: "B", status: "paused" } } },
      {
        pid: "secret",
        held: "secret",
        scheduling: { fingerprint: "PRIVATE_SENTINEL" },
        records: { p: { lane: "INVALID", status: "running", pid: -1 } },
      },
    ]) {
      await writeFile(
        join(store, "supervisor/state.json"),
        JSON.stringify(decoded),
        { mode: 0o600 },
      );
      const result = await readHealth(store);
      expect(result.supervisor.alive).toBe("unknown");
      expect(result.config.loaded).toBeNull();
      expect(result.children).toEqual(
        typeof decoded === "object" && decoded !== null && "pid" in decoded
          ? [{ pid: null, alive: "unknown" }]
          : [],
      );
      expect(
        result.lanePauses?.every((pause) => pause.reason === "unknown"),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("observes new running sessions beyond historical prefixes and ignores superseded lane pauses", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-health-history-"));
  try {
    await mkdir(join(store, "supervisor"), { mode: 0o700, recursive: true });
    const now = 900000;
    const records: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [
        `review-${index}`,
        {
          lane: "reviewer",
          status: "idle",
          startedAt: new Date(index).toISOString(),
        },
      ]),
    );
    records.oldA = {
      lane: "coordinator",
      status: "paused",
      startedAt: new Date(1000).toISOString(),
    };
    records.currentA = {
      lane: "coordinator",
      status: "running",
      pid: 501,
      startedAt: new Date(800000).toISOString(),
    };
    records.currentB = {
      lane: "B",
      status: "paused",
      startedAt: new Date(810000).toISOString(),
    };
    // Enumeration order is not a reliable proxy for the newest session.
    records.oldB = {
      lane: "B",
      status: "idle",
      startedAt: new Date(2000).toISOString(),
    };
    await writeFile(
      join(store, "supervisor/state.json"),
      JSON.stringify({
        pid: 500,
        running: true,
        checkedAt: new Date(now).toISOString(),
        held: ["B"],
        records,
      }),
      { mode: 0o600 },
    );
    const input = await readHealth(store, now, () => "alive");
    expect(input.children).toEqual([{ pid: 501, alive: "alive" }]);
    expect(input.coordinator.turnStartedAt).toBe(800000);
    expect(input.lanePauses).toEqual([{ lane: "B", reason: "operator" }]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("projects real queue, planning, steering and operation ages while preserving budget waits and intentional stop", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-watchdog-orchestration-"));
  try {
    await mkdir(join(store, "supervisor"), { mode: 0o700, recursive: true });
    await mkdir(join(store, "supervisor/commands"), {
      mode: 0o700,
      recursive: true,
    });
    const now = 900000;
    const state = {
      running: true,
      pid: 500,
      checkedAt: new Date(now).toISOString(),
      held: [],
      records: {
        b: {
          lane: "B",
          task: "P1-12",
          status: "running",
          pid: 501,
          startedAt: new Date(850000).toISOString(),
        },
      },
      scheduling: { maxParallel: 4 },
      attention: { oldestUnhandledAt: 0, planningSince: 0, backlog: 2 },
      queue: {
        version: 1,
        queue: [
          {
            key: "reviewer:review",
            lane: "reviewer",
            taskId: "P1-12",
            status: "eligible",
            reason: "ELIGIBLE",
            components: { enqueue: 0 },
          },
          {
            key: "coordinator:control",
            lane: "coordinator",
            taskId: "coordinator:control",
            status: "blocked",
            reason: "RATE_LIMITED",
            components: { enqueue: 0 },
          },
          {
            key: "B:dependent",
            lane: "B",
            taskId: "P1-12",
            status: "blocked",
            reason: "DEPENDENCY_WAITING",
            components: { enqueue: 0 },
          },
        ],
      },
    };
    const saveState = () =>
      writeFile(join(store, "supervisor/state.json"), JSON.stringify(state), {
        mode: 0o600,
      });
    await saveState();
    const desired = join(store, "supervisor/desired.json");
    await writeFile(desired, JSON.stringify({ desiredRunning: true }), {
      mode: 0o600,
    });
    for (const [id, operationState] of [
      ["00000000-0000-4000-8000-000000000001", "queued"],
    ])
      await writeFile(
        join(store, "supervisor/commands", `${id}.json`),
        JSON.stringify({
          version: 1,
          id,
          action: "rollout",
          state: operationState,
          at: new Date(0).toISOString(),
          text: "PRIVATE_SENTINEL",
        }),
        { mode: 0o600 },
      );
    let input = await readHealth(store, now, () => "alive");
    expect(input.availableCapacity).toBe(3);
    expect(input.availableSignals).toEqual([
      "queue",
      "capacity",
      "oldest steering",
      "operations",
    ]);
    expect(
      input.queue.find((entry) => entry.id === "coordinator:planning")?.state,
    ).toBe("rate");
    expect(
      input.queue.find((entry) => entry.id === "coordinator:control")?.state,
    ).toBe("rate");
    expect(
      input.queue.find((entry) => entry.id === "B:dependent"),
    ).toMatchObject({ state: "dependency", lastProgressAt: 850000 });
    expect(
      input.pendingOperations?.map((operation) => operation.state),
    ).toEqual(["queued"]);
    expect(JSON.stringify(input)).not.toContain("PRIVATE_SENTINEL");
    let result = evaluateWatchdog(input, null, {
      ...settings,
      startupGraceMs: 0,
    });
    expect(result.observations.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "review-stalled",
        "steering-stalled",
        "operation-stalled",
        "wait-rate",
      ]),
    );
    expect(result.observations.map((entry) => entry.code)).not.toContain(
      "eligible-stalled",
    );
    state.queue.queue = state.queue.queue.filter(
      (entry) => entry.lane !== "coordinator",
    );
    await saveState();
    input = await readHealth(store, now, () => "alive");
    result = evaluateWatchdog(input, null, { ...settings, startupGraceMs: 0 });
    expect(result.observations).toContainEqual({
      code: "eligible-stalled",
      subject: "coordinator:planning",
      since: 0,
    });
    await writeFile(desired, JSON.stringify({ desiredRunning: false }), {
      mode: 0o600,
    });
    result = evaluateWatchdog(
      await readHealth(store, now, () => "alive"),
      null,
      { ...settings, startupGraceMs: 0 },
    );
    expect(result.notice).toBeNull();
    expect(result.recovery).toBe("none");
    expect(result.observations).toEqual([
      { code: "intentional-stop", subject: null, since: null },
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("keeps malformed or unsafe health sources unavailable instead of inventing queue authority", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-watchdog-unknown-"));
  try {
    await mkdir(join(store, "supervisor"), { mode: 0o700, recursive: true });
    await writeFile(
      join(store, "supervisor/state.json"),
      JSON.stringify({
        scheduling: { maxParallel: "4" },
        records: {},
        attention: {
          oldestUnhandledAt: "PRIVATE_SENTINEL",
          planningSince: -1,
          backlog: 1,
        },
        queue: {
          version: 1,
          queue: [
            null,
            {
              key: "bad",
              lane: "B",
              taskId: "P1-01",
              status: "blocked",
              reason: "PRIVATE_SENTINEL",
              components: { enqueue: 0 },
            },
          ],
        },
      }),
      { mode: 0o600 },
    );
    const foreign = join(store, "foreign");
    await mkdir(foreign, { mode: 0o700, recursive: true });
    await symlink(foreign, join(store, "supervisor/commands"));
    const input = await readHealth(store, 900000, () => "unknown");
    expect(input.queue).toEqual([]);
    expect(input.availableCapacity).toBeNull();
    expect(input.coordinator.oldestUnhandledAt).toBeNull();
    expect(input.pendingOperations).toBeUndefined();
    expect(input.availableSignals).toEqual([]);
    expect(JSON.stringify(input)).not.toContain("PRIVATE_SENTINEL");
    await rm(join(store, "supervisor/commands"));
    await mkdir(join(store, "supervisor/commands"), {
      mode: 0o700,
      recursive: true,
    });
    const id = "00000000-0000-4000-8000-000000000001";
    const target = join(foreign, "private-operation.json");
    await writeFile(
      target,
      JSON.stringify({
        version: 1,
        id,
        action: "rollout",
        state: "queued",
        at: new Date(0).toISOString(),
        text: "PRIVATE_SENTINEL",
      }),
      { mode: 0o600 },
    );
    await symlink(target, join(store, "supervisor/commands", `${id}.json`));
    const symlinked = await readHealth(store, 900000, () => "unknown");
    expect(symlinked.pendingOperations).toBeUndefined();
    expect(symlinked.availableSignals).not.toContain("operations");
    expect(await readFile(target, "utf8")).toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("does not silently project a completed-operation prefix when bounded operation coverage overflows", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-watchdog-operation-cap-"));
  try {
    await mkdir(join(store, "supervisor/commands"), {
      mode: 0o700,
      recursive: true,
    });
    for (let index = 0; index < 65; index++) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      await writeFile(
        join(store, "supervisor/commands", `${id}.json`),
        JSON.stringify({
          version: 1,
          id,
          action: "rollout",
          state: index === 64 ? "queued" : "completed",
          at: new Date(0).toISOString(),
        }),
        { mode: 0o600 },
      );
    }
    const input = await readHealth(store, 900000, () => "unknown");
    expect(input.pendingOperations).toBeUndefined();
    expect(input.availableSignals).not.toContain("operations");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

import { execFileSync, spawnSync } from "node:child_process";

it("resolves CLI health from the shared Git common directory or explicit absolute override", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-watchdog-cli-store-"));
  try {
    const primary = join(root, "primary");
    const linked = join(root, "linked");
    const environment = { ...process.env };
    delete environment.CREWPLANE_COORD_DIR;
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...environment,
          GIT_AUTHOR_NAME: "Synthetic",
          GIT_COMMITTER_NAME: "Synthetic",
          GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
          GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
        },
      });
    git("init", "--initial-branch=main", primary);
    git(
      "-C",
      primary,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "chore: synthetic fixture",
    );
    git(
      "-C",
      primary,
      "worktree",
      "add",
      "-b",
      "synthetic-linked",
      linked,
      "HEAD",
    );
    const expectedStore = join(primary, ".crewplane-state");
    const override = join(root, "explicit-store");
    for (const [directory, source] of [
      [expectedStore, "git-common"],
      [override, "explicit-override"],
      [join(linked, ".crewplane-state"), "wrong-worktree-local"],
    ] as const) {
      await mkdir(join(directory, "watchdog"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(directory, "watchdog/latest.json"),
        JSON.stringify({ source }),
        { mode: 0o600 },
      );
    }
    const script = fileURLToPath(new URL("./runner.ts", import.meta.url));
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [script, "status"], {
        cwd: linked,
        env,
        encoding: "utf8",
      });
    const shared = run(environment);
    expect(shared.status).toBe(0);
    expect(JSON.parse(shared.stdout)).toEqual({ source: "git-common" });
    const explicit = run({ ...environment, CREWPLANE_COORD_DIR: override });
    expect(explicit.status).toBe(0);
    expect(JSON.parse(explicit.stdout)).toEqual({
      source: "explicit-override",
    });
    const invalid = run({
      ...environment,
      CREWPLANE_COORD_DIR: "relative-store",
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("delivers only safe fault metadata and a bounded nudge, respects intentional stops and refuses symlinked control directories", async () => {
  const { deliverNotice } = await import("./runner.ts");
  const { readdir } = await import("node:fs/promises");
  const store = await mkdtemp(join(tmpdir(), "relay-watchdog-delivery-"));
  try {
    await mkdir(join(store, "supervisor"), { mode: 0o700, recursive: true });
    await writeFile(
      join(store, "supervisor/desired.json"),
      JSON.stringify({ desiredRunning: false }),
      { mode: 0o600 },
    );
    await deliverNotice(store, {
      key: "PRIVATE_SENTINEL",
      codes: ["eligible-stalled", "PRIVATE_SENTINEL"],
    });
    expect(
      await readFile(join(store, "watchdog/notice.json"), "utf8"),
    ).not.toContain("PRIVATE_SENTINEL");
    await expect(readdir(join(store, "supervisor/commands"))).rejects.toThrow();
    await writeFile(
      join(store, "supervisor/desired.json"),
      JSON.stringify({ desiredRunning: true }),
      { mode: 0o600 },
    );
    await writeFile(
      join(store, "supervisor/state.json"),
      JSON.stringify({ running: true, generation: "test-generation" }),
      { mode: 0o600 },
    );
    await deliverNotice(store, { key: "ignored", codes: ["eligible-stalled"] });
    const files = await readdir(join(store, "supervisor/commands"));
    expect(files).toHaveLength(1);
    const command = JSON.parse(
      await readFile(
        join(store, "supervisor/commands", String(files[0])),
        "utf8",
      ),
    );
    expect(command).toMatchObject({ action: "nudge", lane: "coordinator" });
    expect(command.text).not.toMatch(/PRIVATE|retry --|resume --/);
    await rm(join(store, "supervisor/commands"), { recursive: true });
    await mkdir(join(store, "outside"));
    await symlink(join(store, "outside"), join(store, "supervisor/commands"));
    await expect(
      deliverNotice(store, { key: "ignored", codes: ["eligible-stalled"] }),
    ).rejects.toThrow("Unsafe");
    expect(await readdir(join(store, "outside"))).toEqual([]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("detects quiescent ready handoffs awaiting coordinator disposition without inventing a task assignment", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-disposition-health-"));
  try {
    await mkdir(join(store, "supervisor"));
    await writeFile(
      join(store, "supervisor/state.json"),
      JSON.stringify({
        pid: process.pid,
        running: true,
        checkedAt: new Date(900000).toISOString(),
        held: [],
        records: {},
        scheduling: { maxParallel: 4 },
        attention: {
          oldestUnhandledAt: null,
          planningSince: null,
          backlog: 0,
          oldestReadyAt: 0,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(store, "supervisor/desired.json"),
      JSON.stringify({ desiredRunning: true }),
      { mode: 0o600 },
    );
    const input = await readHealth(store, 900000, () => "alive");
    expect(
      evaluateWatchdog(input, null, { ...settings, startupGraceMs: 0 }).codes,
    ).toContain("review-stalled");
    expect(
      input.queue.find((q) => q.id === "coordinator:disposition")?.state,
    ).toBe("review");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("projects schedule overflow as configuration blocked while retaining real command and partial coverage", async () => {
  const store = await mkdtemp(join(tmpdir(), "watchdog-schedule-overflow-"));
  try {
    await mkdir(join(store, "supervisor/commands"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(
        store,
        "supervisor/commands/00000000-0000-4000-8000-000000000001.json",
      ),
      JSON.stringify({ action: "stop", at: new Date(0).toISOString() }),
      { mode: 0o600 },
    );
    const row = {
      key: "B:overflow",
      lane: "B",
      taskId: "CP-06",
      status: "blocked",
      reason: "SCHEDULE_INPUT_OVERFLOW",
      components: { enqueue: 0 },
    };
    const save = (rows: unknown[]) =>
      writeFile(
        join(store, "supervisor/state.json"),
        JSON.stringify({ queue: { version: 1, queue: rows } }),
        { mode: 0o600 },
      );
    await save([row]);
    const complete = await readHealth(store, 900000, () => "dead");
    expect(complete.queue).toEqual([
      {
        id: "B:overflow",
        lane: "B",
        state: "config",
        since: 0,
        lastProgressAt: null,
      },
    ]);
    expect(complete.availableSignals).toEqual(["queue", "operations"]);
    expect(complete.pendingOperations).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "stop",
        state: "queued",
        requestedAt: 0,
      },
    ]);
    await save([
      row,
      { ...row, key: "B:unknown", reason: "FUTURE_UNKNOWN_REASON" },
    ]);
    const partial = await readHealth(store, 900000, () => "dead");
    expect(partial.queue).toEqual(complete.queue);
    expect(partial.availableSignals).not.toContain("queue");
    expect(partial.availableSignals).toContain("operations");
    await save(
      Array.from({ length: 65 }, (_, index) => ({
        ...row,
        key: `B:overflow-${index}`,
      })),
    );
    const bounded = await readHealth(store, 900000, () => "dead");
    expect(bounded.queue).toHaveLength(64);
    expect(bounded.queue.every((entry) => entry.state === "config")).toBe(true);
    expect(bounded.availableSignals).not.toContain("queue");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("reports paused retained process groups and identity-free unverified cleanup as orphan risks", async () => {
  const store = await mkdtemp(join(tmpdir(), "watchdog-retained-child-"));
  try {
    await mkdir(join(store, "supervisor"), { recursive: true, mode: 0o700 });
    const now = 900000;
    await writeFile(
      join(store, "supervisor/desired.json"),
      JSON.stringify({ desiredRunning: true }),
      { mode: 0o600 },
    );
    await writeFile(
      join(store, "supervisor/state.json"),
      JSON.stringify({
        pid: 500,
        checkedAt: new Date(now).toISOString(),
        records: {
          group: { lane: "B", status: "paused", pid: 501, processGroupId: 502 },
          leader: { lane: "C", status: "paused", pid: 503 },
          unknown: { lane: "D", status: "paused", cleanupUnverified: true },
          unverifiedDead: {
            lane: "E",
            status: "paused",
            pid: 504,
            cleanupUnverified: true,
          },
          normal: { lane: "F", status: "running", pid: 505 },
        },
      }),
      { mode: 0o600 },
    );
    const observed: Array<number | null> = [];
    const input = await readHealth(store, now, (pid) => {
      observed.push(pid);
      return pid === -502 || pid === 500 || pid === 505 ? "alive" : "dead";
    });
    expect(observed).toContain(-502);
    expect(observed).not.toContain(501);
    expect(input.children).toEqual([
      { pid: 501, alive: "alive", retained: true },
      { pid: 503, alive: "dead", retained: true },
      { pid: null, alive: "unknown", retained: true },
      { pid: 504, alive: "unknown", retained: true },
      { pid: 505, alive: "alive" },
    ]);
    const result = evaluateWatchdog(input, null, {
      ...settings,
      startupGraceMs: 0,
    });
    expect(result.codes).toContain("orphan-or-unknown-child");
    expect(result.codes).not.toContain("input-unavailable");
    const healthy = evaluateWatchdog(
      { ...input, children: [{ pid: 505, alive: "alive" }] },
      null,
      { ...settings, startupGraceMs: 0 },
    );
    expect(healthy.codes).not.toContain("orphan-or-unknown-child");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
