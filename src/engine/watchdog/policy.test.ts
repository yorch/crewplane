import { describe, expect, it } from "vitest";
import type {
  WatchdogInput,
  WatchdogSettings,
  WatchdogState,
} from "./policy.ts";
import { evaluateWatchdog } from "./policy.ts";

const settings: WatchdogSettings = {
  version: 1,
  intervalMs: 180000,
  startupGraceMs: 180000,
  stallMs: 360000,
  cooldownMs: 540000,
  backoffMs: 180000,
  maxBackoffMs: 720000,
};
function fixture(now = 900000): WatchdogInput {
  return {
    version: 1,
    now,
    desiredRunning: true,
    supervisor: { pid: 123, alive: "alive", heartbeatAt: now, draining: false },
    children: [],
    config: { loaded: "fixture-v1", disk: "fixture-v1" },
    queue: [],
    coordinator: { turnStartedAt: null, oldestUnhandledAt: null },
    availableCapacity: null,
  };
}
function prior(): WatchdogState {
  return {
    version: 1,
    startedAt: 0,
    lastCheckAt: 720000,
    nextCheckAt: 900000,
    lastNoticeAt: null,
    lastNoticeKey: null,
    restartAttempts: 0,
    lastRecoveryAt: null,
  };
}
const codes = (input: WatchdogInput) =>
  evaluateWatchdog(input, prior(), settings).observations.map((o) => o.code);
describe("watchdog independent expectations", () => {
  it("keeps healthy snapshots quiet and sets the exact180s next check", () => {
    const result = evaluateWatchdog(fixture(), prior(), settings);
    expect(result).toMatchObject({
      observations: [],
      notice: null,
      recovery: "none",
      state: { lastCheckAt: 900000, nextCheckAt: 1080000 },
    });
    expect(prior().lastCheckAt).toBe(720000);
  });
  it("observes grace then live-stale at the exact stall boundary without restart", () => {
    const input = fixture();
    input.supervisor.heartbeatAt = 540000;
    expect(
      evaluateWatchdog(input, null, { ...settings, recoveryEnabled: true })
        .observations,
    ).toEqual([]);
    expect(codes(input)).toEqual(["supervisor-stale"]);
    expect(
      evaluateWatchdog(input, prior(), { ...settings, recoveryEnabled: true })
        .recovery,
    ).toBe("escalate");
    input.supervisor.heartbeatAt = 540001;
    expect(codes(input)).toEqual([]);
  });
  it.each([
    "dependency",
    "phase",
    "capacity",
    "rate",
    "hold",
    "config",
    "paused",
  ] as const)("preserves %s wait without a stall notice", (state) => {
    const input = fixture();
    input.queue = [
      { id: "job", lane: "B", state, since: 0, lastProgressAt: 0 },
    ];
    expect(evaluateWatchdog(input, prior(), settings)).toMatchObject({
      observations: [{ code: `wait-${state}`, subject: "job", since: 0 }],
      notice: null,
      recovery: "none",
    });
  });
  it("does not infer progress or capacity from live processes", () => {
    const input = fixture();
    input.children = [{ pid: 432, alive: "alive" }];
    input.queue = [
      { id: "job", lane: "B", state: "eligible", since: 0, lastProgressAt: 0 },
    ];
    expect(codes(input)).toEqual([]);
    input.availableCapacity = 0;
    expect(codes(input)).toEqual([]);
    input.availableCapacity = 1;
    expect(codes(input)).toEqual(["eligible-stalled"]);
    const queued = input.queue[0];
    if (!queued) throw new Error("Missing fixture");
    queued.lastProgressAt = 890000;
    expect(codes(input)).toEqual([]);
  });
  it("coalesces review, steering, turn, failure and operation warnings without exposing subjects in notices", () => {
    const input = fixture();
    input.queue = [
      {
        id: "review-1",
        lane: "reviewer",
        state: "review",
        since: 0,
        lastProgressAt: null,
      },
      {
        id: "failure-1",
        lane: "B",
        state: "failed",
        since: 0,
        lastProgressAt: null,
      },
    ];
    input.coordinator = { turnStartedAt: 0, oldestUnhandledAt: 0 };
    input.pendingOperations = [
      { id: "rollout-1", kind: "rollout", requestedAt: 0, state: "blocked" },
    ];
    expect(evaluateWatchdog(input, prior(), settings).notice?.codes).toEqual([
      "coordinator-long-turn",
      "operation-stalled",
      "review-stalled",
      "steering-stalled",
      "task-failed",
    ]);
  });
  it("dedupes every tick through cooldown, including changed failure sets", () => {
    const input = fixture();
    input.supervisor.alive = "dead";
    const first = evaluateWatchdog(input, prior(), settings);
    input.now += 180000;
    expect(evaluateWatchdog(input, first.state, settings).notice).toBeNull();
    input.config.disk = "new-config";
    expect(evaluateWatchdog(input, first.state, settings).notice).toBeNull();
    input.now = 1440000;
    expect(
      evaluateWatchdog(input, first.state, settings).notice?.codes,
    ).toEqual(["config-mismatch", "supervisor-dead"]);
  });
  it.each(["alive", "unknown"] as const)(
    "never restarts a dead supervisor with %s children",
    (alive) => {
      const input = fixture();
      input.supervisor.alive = "dead";
      input.children = [{ pid: 432, alive }];
      expect(
        evaluateWatchdog(input, prior(), {
          ...settings,
          recoveryEnabled: true,
        }),
      ).toMatchObject({
        recovery: "escalate",
        observations: [
          { code: "supervisor-dead" },
          { code: "orphan-or-unknown-child" },
        ],
      });
    },
  );
  it("requires opt-in and known consistent config; caps exponential backoff", () => {
    const input = fixture();
    input.supervisor.alive = "dead";
    expect(evaluateWatchdog(input, prior(), settings).recovery).toBe(
      "escalate",
    );
    const enabled = { ...settings, recoveryEnabled: true };
    const first = evaluateWatchdog(input, prior(), enabled);
    expect(first.recovery).toBe("request-restart");
    input.now = 1259999;
    expect(evaluateWatchdog(input, first.state, enabled).recovery).toBe(
      "escalate",
    );
    input.now = 1260000;
    const second = evaluateWatchdog(input, first.state, enabled);
    expect(second.recovery).toBe("request-restart");
    expect(second.state.restartAttempts).toBe(2);
    const capped = { ...second.state, restartAttempts: 50 };
    input.now = 1979999;
    expect(evaluateWatchdog(input, capped, enabled).recovery).toBe("escalate");
    input.now = 1980000;
    expect(evaluateWatchdog(input, capped, enabled).recovery).toBe(
      "request-restart",
    );
    input.config.disk = null;
    expect(evaluateWatchdog(input, second.state, enabled).recovery).toBe(
      "escalate",
    );
    input.config.disk = "mismatch";
    expect(evaluateWatchdog(input, second.state, enabled).recovery).toBe(
      "escalate",
    );
  });
  it.each([false, null] as const)(
    "keeps desiredRunning=%s stopped",
    (desiredRunning) => {
      const input = fixture();
      input.desiredRunning = desiredRunning;
      input.supervisor.alive = "dead";
      expect(
        evaluateWatchdog(input, prior(), {
          ...settings,
          recoveryEnabled: true,
        }),
      ).toMatchObject({ notice: null, recovery: "none" });
    },
  );
  it("respects drain, operator pauses and queued stop operations", () => {
    const input = fixture();
    input.supervisor.alive = "dead";
    input.supervisor.draining = true;
    const enabled = { ...settings, recoveryEnabled: true };
    expect(evaluateWatchdog(input, prior(), enabled).recovery).toBe("none");
    input.supervisor.draining = false;
    input.lanePauses = [{ lane: "coordinator", reason: "operator" }];
    expect(evaluateWatchdog(input, prior(), enabled).recovery).toBe("escalate");
    input.lanePauses = [];
    input.pendingOperations = [
      { id: "stop-1", kind: "stop", requestedAt: input.now, state: "queued" },
    ];
    expect(evaluateWatchdog(input, prior(), enabled).recovery).toBe("escalate");
  });
  it("keeps unknown identities and timestamps explicit", () => {
    const input = fixture();
    input.supervisor.alive = "unknown";
    expect(codes(input)).toEqual(["supervisor-unknown"]);
    input.supervisor.alive = "alive";
    input.supervisor.pid = null;
    expect(codes(input)).toEqual(["supervisor-unknown"]);
    input.supervisor.pid = 123;
    input.supervisor.heartbeatAt = null;
    expect(codes(input)).toEqual(["heartbeat-unknown"]);
  });
  it("bounds observations to64 and rejects invalid times, metadata and oversized arrays with a fixed error", () => {
    const input = fixture();
    input.queue = Array.from({ length: 64 }, (_, i) => ({
      id: `job-${i}`,
      lane: "B",
      state: "failed",
      since: 0,
      lastProgressAt: null,
    }));
    input.coordinator.oldestUnhandledAt = 0;
    expect(
      evaluateWatchdog(input, prior(), settings).observations,
    ).toHaveLength(64);
    input.queue.push({
      id: "overflow",
      lane: "B",
      state: "failed",
      since: 0,
      lastProgressAt: null,
    });
    expect(() => codes(input)).toThrow("Invalid watchdog input");
    for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => codes({ ...fixture(), now })).toThrow(
        "Invalid watchdog input",
      );
    expect(() =>
      evaluateWatchdog(fixture(), prior(), { ...settings, cooldownMs: -1 }),
    ).toThrow("Invalid watchdog input");
    expect(() =>
      evaluateWatchdog(
        fixture(),
        { ...prior(), lastCheckAt: 999999 },
        settings,
      ),
    ).toThrow("Invalid watchdog input");
    expect(() =>
      codes({
        ...fixture(),
        config: { loaded: "sensitive raw text", disk: null },
      }),
    ).toThrow("Invalid watchdog input");
  });
  it("keeps every later actionable code when64 dependency details saturate output", () => {
    const input = fixture();
    input.queue = Array.from({ length: 64 }, (_, i) => ({
      id: `wait-${i}`,
      lane: "B",
      state: "dependency",
      since: 0,
      lastProgressAt: null,
    }));
    input.coordinator = { oldestUnhandledAt: 0, turnStartedAt: 0 };
    input.lanePauses = [
      { lane: "C", reason: "failure" },
      { lane: "E", reason: "unknown" },
    ];
    input.pendingOperations = [
      { id: "rollout-1", kind: "rollout", state: "blocked", requestedAt: 0 },
    ];
    const result = evaluateWatchdog(input, prior(), settings);
    expect(result.observations).toHaveLength(64);
    expect(result.observations.every((o) => o.code === "wait-dependency")).toBe(
      true,
    );
    expect(result.recovery).toBe("escalate");
    expect(result.notice?.codes).toEqual([
      "coordinator-long-turn",
      "operation-stalled",
      "pause-failure",
      "pause-unknown",
      "steering-stalled",
    ]);
    const unsaturated = evaluateWatchdog(
      { ...input, queue: [] },
      prior(),
      settings,
    );
    expect(result.notice).toEqual(unsaturated.notice);
    expect(
      evaluateWatchdog(
        { ...input, now: input.now + 180000 },
        result.state,
        settings,
      ).notice,
    ).toBeNull();
  });
  it.each(["steering", "turn", "pause", "operation"])(
    "surfaces %s alone despite64 benign waits",
    (fault) => {
      const input = fixture();
      input.queue = Array.from({ length: 64 }, (_, i) => ({
        id: `wait-${i}`,
        lane: "B",
        state: "dependency",
        since: 0,
        lastProgressAt: null,
      }));
      const expected = {
        steering: "steering-stalled",
        turn: "coordinator-long-turn",
        pause: "pause-failure",
        operation: "operation-stalled",
      };
      if (fault === "steering") input.coordinator.oldestUnhandledAt = 0;
      if (fault === "turn") input.coordinator.turnStartedAt = 0;
      if (fault === "pause")
        input.lanePauses = [{ lane: "coordinator", reason: "failure" }];
      if (fault === "operation")
        input.pendingOperations = [
          { id: "restart-1", kind: "restart", state: "queued", requestedAt: 0 },
        ];
      expect(evaluateWatchdog(input, prior(), settings)).toMatchObject({
        recovery: "escalate",
        notice: { codes: [expected[fault as keyof typeof expected]] },
      });
    },
  );
});
