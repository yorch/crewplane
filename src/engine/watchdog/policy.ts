export type Liveness = "alive" | "dead" | "unknown";
export interface WatchdogInput {
  availableSignals?: string[];
  version: 1;
  now: number;
  desiredRunning: boolean | null;
  supervisor: {
    pid: number | null;
    alive: Liveness;
    heartbeatAt: number | null;
    draining: boolean;
  };
  children: Array<{ pid: number; alive: Liveness }>;
  config: { loaded: string | null; disk: string | null };
  queue: Array<{
    id: string;
    lane: string;
    state:
      | "eligible"
      | "dependency"
      | "phase"
      | "capacity"
      | "rate"
      | "hold"
      | "config"
      | "paused"
      | "failed"
      | "review";
    since: number | null;
    lastProgressAt: number | null;
  }>;
  coordinator: {
    turnStartedAt: number | null;
    oldestUnhandledAt: number | null;
  };
  availableCapacity: number | null;
  lanePauses?: Array<{
    lane: string;
    reason: "operator" | "failure" | "waiting" | "unknown";
  }>;
  pendingOperations?: Array<{
    id: string;
    kind: "rollout" | "restart" | "stop";
    requestedAt: number;
    state: "queued" | "handled" | "blocked";
  }>;
}
export interface WatchdogSettings {
  version: 1;
  intervalMs: 180000;
  startupGraceMs: number;
  stallMs: number;
  cooldownMs: number;
  backoffMs: number;
  maxBackoffMs: number;
  recoveryEnabled?: boolean;
}
export interface WatchdogState {
  version: 1;
  startedAt: number;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  lastNoticeAt: number | null;
  lastNoticeKey: string | null;
  restartAttempts: number;
  lastRecoveryAt: number | null;
}
export interface Observation {
  code: string;
  subject: string | null;
  since: number | null;
}
export interface WatchdogNotice {
  key: string;
  codes: string[];
}
export type Recovery = "none" | "escalate" | "request-restart";
export interface WatchdogResult {
  availableSignals?: string[];
  codes: string[];
  state: WatchdogState;
  observations: Observation[];
  notice: WatchdogNotice | null;
  recovery: Recovery;
}
const validTime = (n: unknown): boolean =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
const nullableTime = (n: unknown): boolean => n === null || validTime(n);
const live = (n: unknown): boolean =>
  ["alive", "dead", "unknown"].includes(n as string);
const text = (n: unknown): boolean =>
  typeof n === "string" && /^[\w.:/-]{1,256}$/.test(n);
export function evaluateWatchdog(
  input: WatchdogInput,
  previous: WatchdogState | null,
  settings: WatchdogSettings,
): WatchdogResult {
  try {
    if (
      settings.version !== 1 ||
      settings.intervalMs !== 180000 ||
      ![
        settings.startupGraceMs,
        settings.stallMs,
        settings.cooldownMs,
        settings.backoffMs,
        settings.maxBackoffMs,
      ].every(validTime) ||
      settings.maxBackoffMs < settings.backoffMs ||
      (settings.recoveryEnabled !== undefined &&
        typeof settings.recoveryEnabled !== "boolean")
    )
      throw 0;
    if (
      input.version !== 1 ||
      !validTime(input.now) ||
      ![true, false, null].includes(input.desiredRunning) ||
      !live(input.supervisor.alive) ||
      !(
        input.supervisor.pid === null ||
        (Number.isInteger(input.supervisor.pid) && input.supervisor.pid > 0)
      ) ||
      !nullableTime(input.supervisor.heartbeatAt) ||
      typeof input.supervisor.draining !== "boolean" ||
      !nullableTime(input.availableCapacity)
    )
      throw 0;
    if (
      ![input.config.loaded, input.config.disk].every(
        (v) => v === null || text(v),
      ) ||
      ![
        input.coordinator.turnStartedAt,
        input.coordinator.oldestUnhandledAt,
      ].every(nullableTime)
    )
      throw 0;
    if (
      !Array.isArray(input.children) ||
      input.children.length > 64 ||
      input.children.some(
        (c) => !Number.isInteger(c.pid) || c.pid <= 0 || !live(c.alive),
      )
    )
      throw 0;
    if (
      !Array.isArray(input.queue) ||
      input.queue.length > 64 ||
      input.queue.some(
        (q) =>
          !text(q.id) ||
          !text(q.lane) ||
          ![
            "eligible",
            "dependency",
            "phase",
            "capacity",
            "rate",
            "hold",
            "config",
            "paused",
            "failed",
            "review",
          ].includes(q.state) ||
          !nullableTime(q.since) ||
          !nullableTime(q.lastProgressAt),
      )
    )
      throw 0;
    if (
      input.lanePauses &&
      (input.lanePauses.length > 64 ||
        input.lanePauses.some(
          (p) =>
            !text(p.lane) ||
            !["operator", "failure", "waiting", "unknown"].includes(p.reason),
        ))
    )
      throw 0;
    if (
      input.pendingOperations &&
      (input.pendingOperations.length > 64 ||
        input.pendingOperations.some(
          (p) =>
            !text(p.id) ||
            !["rollout", "restart", "stop"].includes(p.kind) ||
            !["queued", "handled", "blocked"].includes(p.state) ||
            !validTime(p.requestedAt),
        ))
    )
      throw 0;
    if (
      previous &&
      (previous.version !== 1 ||
        !validTime(previous.startedAt) ||
        ![
          previous.lastCheckAt,
          previous.nextCheckAt,
          previous.lastNoticeAt,
          previous.lastRecoveryAt,
        ].every(nullableTime) ||
        !Number.isSafeInteger(previous.restartAttempts) ||
        previous.restartAttempts < 0 ||
        !(
          previous.lastNoticeKey === null ||
          (typeof previous.lastNoticeKey === "string" &&
            previous.lastNoticeKey.length <= 256)
        ) ||
        input.now < (previous.lastCheckAt ?? previous.startedAt))
    )
      throw 0;
  } catch {
    throw new Error("Invalid watchdog input");
  }
  const state: WatchdogState = previous
    ? {
        version: 1,
        startedAt: previous.startedAt,
        lastCheckAt: previous.lastCheckAt,
        nextCheckAt: previous.nextCheckAt,
        lastNoticeAt: previous.lastNoticeAt,
        lastNoticeKey: previous.lastNoticeKey,
        restartAttempts: previous.restartAttempts,
        lastRecoveryAt: previous.lastRecoveryAt,
      }
    : {
        version: 1,
        startedAt: input.now,
        lastCheckAt: null,
        nextCheckAt: null,
        lastNoticeAt: null,
        lastNoticeKey: null,
        restartAttempts: 0,
        lastRecoveryAt: null,
      };
  const observations: Observation[] = [];
  const actionableCodes = new Set<string>();
  const add = (
    code: string,
    subject: string | null = null,
    since: number | null = null,
  ) => {
    // Summary health must include every fixed fault code even when bounded
    // detail records have already filled with legitimate queue waits.
    if (
      !code.startsWith("wait-") &&
      ![
        "intentional-stop",
        "draining",
        "desired-unknown",
        "pause-waiting",
        "pause-operator",
      ].includes(code)
    )
      actionableCodes.add(code);
    if (observations.length < 64) observations.push({ code, subject, since });
  };
  const old = (t: number | null) =>
    t !== null && input.now - t >= settings.stallMs;
  const active = input.desiredRunning === true && !input.supervisor.draining;
  const grace = input.now - state.startedAt < settings.startupGraceMs;
  if (!active)
    add(
      input.supervisor.draining
        ? "draining"
        : input.desiredRunning === false
          ? "intentional-stop"
          : "desired-unknown",
    );
  if (active && !grace) {
    if (input.supervisor.alive === "unknown" || input.supervisor.pid === null)
      add("supervisor-unknown");
    else if (input.supervisor.alive === "dead") add("supervisor-dead");
    else if (input.supervisor.heartbeatAt === null) add("heartbeat-unknown");
    else if (old(input.supervisor.heartbeatAt))
      add("supervisor-stale", null, input.supervisor.heartbeatAt);
    if (
      input.supervisor.alive === "dead" &&
      input.children.some((c) => c.alive !== "dead")
    )
      add("orphan-or-unknown-child");
    if (
      input.config.loaded !== null &&
      input.config.disk !== null &&
      input.config.loaded !== input.config.disk
    )
      add("config-mismatch");
    for (const q of input.queue) {
      if (!["eligible", "review", "failed"].includes(q.state))
        add(`wait-${q.state}`, q.id, q.since);
      else if (q.state === "failed") add("task-failed", q.id, q.since);
      else if (
        old(q.lastProgressAt ?? q.since) &&
        (q.state === "review" ||
          (input.availableCapacity !== null && input.availableCapacity > 0))
      )
        add(
          q.state === "review" ? "review-stalled" : "eligible-stalled",
          q.id,
          q.lastProgressAt ?? q.since,
        );
    }
    if (old(input.coordinator.oldestUnhandledAt))
      add("steering-stalled", null, input.coordinator.oldestUnhandledAt);
    if (old(input.coordinator.turnStartedAt))
      add("coordinator-long-turn", null, input.coordinator.turnStartedAt);
    for (const p of input.lanePauses ?? []) add(`pause-${p.reason}`, p.lane);
    for (const p of input.pendingOperations ?? [])
      if (p.state !== "handled" && old(p.requestedAt))
        add("operation-stalled", p.id, p.requestedAt);
  }
  const codes = [...actionableCodes].sort();
  const key = codes.join(",").slice(0, 256);
  const notice =
    codes.length > 0 &&
    (state.lastNoticeAt === null ||
      input.now - state.lastNoticeAt >= settings.cooldownMs)
      ? { key, codes }
      : null;
  let recovery: Recovery = codes.length ? "escalate" : "none";
  const backoff = Math.min(
    settings.maxBackoffMs,
    settings.backoffMs * 2 ** Math.min(state.restartAttempts, 52),
  );
  const stopping =
    input.pendingOperations?.some(
      (p) => p.kind === "stop" && p.state !== "handled",
    ) || input.lanePauses?.some((p) => p.reason === "operator");
  if (
    active &&
    !grace &&
    settings.recoveryEnabled === true &&
    !stopping &&
    input.supervisor.pid !== null &&
    input.config.loaded !== null &&
    input.config.loaded === input.config.disk &&
    input.supervisor.alive === "dead" &&
    input.children.every((c) => c.alive === "dead") &&
    (state.lastRecoveryAt === null ||
      input.now - state.lastRecoveryAt >= backoff)
  ) {
    recovery = "request-restart";
    state.lastRecoveryAt = input.now;
    state.restartAttempts = Math.min(state.restartAttempts + 1, 53);
  }
  if (notice) {
    state.lastNoticeAt = input.now;
    state.lastNoticeKey = key;
  }
  state.lastCheckAt = input.now;
  state.nextCheckAt = input.now + settings.intervalMs;
  return {
    state,
    observations,
    notice,
    recovery,
    codes,
    availableSignals: (input.availableSignals ?? []).filter((signal) =>
      ["queue", "capacity", "oldest steering", "operations"].includes(signal),
    ),
  };
}
