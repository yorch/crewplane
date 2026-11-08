/** FAIR-V1: pure scheduling policy. Authority and durable session routing belong to A. */
export type Priority =
  | "urgent-operational"
  | "gate-critical"
  | "normal"
  | "low";
export interface Metadata {
  version: 1;
  priority: Priority;
  dependsOn: {
    taskId: string;
    require: "accepted" | "ready";
    commit: string | null;
  }[];
  reviewOf: { taskId: string; commit: string } | null;
  enqueuedAt: number;
  updatedBy: string;
}
export interface ScheduleTask {
  id: string;
  state: "assigned" | "working" | "blocked" | "ready" | "accepted";
  readyCommit: string | null;
  acceptedCommit: string | null;
  acceptedSourceCommit: string | null;
  metadata: Metadata | null;
}
export interface ScheduleCandidate {
  key: string;
  lane: string;
  taskId: string;
  kind: "control" | "implementation" | "revision" | "resume" | "review";
  enqueuedAt: number;
  authorized: boolean;
  phaseAllowed: boolean;
  ownershipValid: boolean;
  pathsDisjoint: boolean;
  acceptedBase: boolean;
  configLoaded: boolean;
  blocksAcceptance: boolean;
}
export interface ScheduleInput {
  version: 1;
  now: number;
  maxParallel: number;
  coordinatorReserved: boolean;
  coordinatorLane?: string;
  active: { key: string; lane: string }[];
  lanes: {
    lane: string;
    enabled: boolean;
    held: boolean;
    failurePaused: boolean;
    runsLastHour: number;
    maxRunsPerHour: number;
  }[];
  tasks: ScheduleTask[];
  candidates: ScheduleCandidate[];
}
export interface ScheduleEntry {
  key: string;
  lane: string;
  taskId: string;
  status: "eligible" | "selected" | "blocked" | "capacity";
  reason: string;
  position: number | null;
  components: {
    priority: number;
    aging: number;
    unblocks: number;
    review: boolean;
    enqueue: number;
  };
  dependencyIds: string[];
}
export interface ScheduleResult {
  version: 1;
  evaluatedAt: number;
  selected: string[];
  queue: ScheduleEntry[];
}
const priorities = ["urgent-operational", "gate-critical", "normal", "low"];
const id = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,199}$/.test(x);
const count = (x: unknown): x is number =>
  Number.isSafeInteger(x) && (x as number) >= 0;
const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
function validate(value: unknown): asserts value is ScheduleInput {
  const fail = () => {
    throw new Error("INVALID_SCHEDULE_INPUT");
  };
  if (!object(value)) return fail();
  const v = value;
  if (
    v.version !== 1 ||
    !count(v.now) ||
    !count(v.maxParallel) ||
    v.maxParallel < 1 ||
    v.maxParallel > 4 ||
    typeof v.coordinatorReserved !== "boolean"
  )
    return fail();
  for (const [field, limit] of [
    ["active", 4],
    ["lanes", 64],
    ["tasks", 1000],
    ["candidates", 1000],
  ] as const)
    if (!Array.isArray(v[field]) || v[field].length > limit) return fail();
  const unique = (items: unknown[], field: string) => {
    const seen = new Set();
    for (const item of items) {
      if (!object(item) || !id(item[field]) || seen.has(item[field]))
        return fail();
      seen.add(item[field]);
    }
  };
  const a = v as unknown as ScheduleInput;
  unique(a.active, "key");
  unique(a.lanes, "lane");
  unique(a.tasks, "id");
  unique(a.candidates, "key");
  for (const r of a.active) if (!id(r.lane)) return fail();
  if (new Set(a.active.map((r) => r.lane)).size !== a.active.length)
    return fail();
  for (const l of a.lanes) {
    if (
      ![l.enabled, l.held, l.failurePaused].every(
        (x) => typeof x === "boolean",
      ) ||
      !count(l.runsLastHour) ||
      !count(l.maxRunsPerHour)
    )
      return fail();
  }
  for (const t of a.tasks) {
    if (
      !["assigned", "working", "blocked", "ready", "accepted"].includes(
        t.state,
      ) ||
      ![t.readyCommit, t.acceptedCommit, t.acceptedSourceCommit].every(
        (x) => x === null || id(x),
      )
    )
      return fail();
    const m = t.metadata;
    if (m === null) continue;
    if (
      !object(m) ||
      m.version !== 1 ||
      !priorities.includes(m.priority) ||
      !count(m.enqueuedAt) ||
      !id(m.updatedBy) ||
      !Array.isArray(m.dependsOn) ||
      m.dependsOn.length > 64
    )
      return fail();
    for (const d of m.dependsOn)
      if (
        !object(d) ||
        !id(d.taskId) ||
        !["accepted", "ready"].includes(d.require) ||
        !(d.commit === null || id(d.commit))
      )
        return fail();
    if (
      m.reviewOf !== null &&
      (!object(m.reviewOf) || !id(m.reviewOf.taskId) || !id(m.reviewOf.commit))
    )
      return fail();
  }
  for (const c of a.candidates) {
    if (
      !id(c.lane) ||
      !id(c.taskId) ||
      !["control", "implementation", "revision", "resume", "review"].includes(
        c.kind,
      ) ||
      !count(c.enqueuedAt) ||
      ![
        c.authorized,
        c.phaseAllowed,
        c.ownershipValid,
        c.pathsDisjoint,
        c.acceptedBase,
        c.configLoaded,
        c.blocksAcceptance,
      ].every((x) => typeof x === "boolean")
    )
      return fail();
  }
}
export function evaluateSchedule(input: ScheduleInput): ScheduleResult {
  validate(input);
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));
  const lanes = new Map(input.lanes.map((l) => [l.lane, l]));
  const activeLanes = new Set(input.active.map((a) => a.lane));
  const pinned = (t: ScheduleTask, commit: string) =>
    (t.state === "ready" && t.readyCommit === commit) ||
    (t.state === "accepted" && t.acceptedSourceCommit === commit);
  const dependencyCache = new Map<string, string | null>();
  const dependencyReason = (
    taskId: string,
    path = new Set<string>(),
  ): string | null => {
    if (path.has(taskId)) return "DEPENDENCY_CYCLE";
    if (dependencyCache.has(taskId)) return dependencyCache.get(taskId) ?? null;
    const result = inspectDependencies(taskId, path);
    dependencyCache.set(taskId, result);
    return result;
  };
  const inspectDependencies = (
    taskId: string,
    path: Set<string>,
  ): string | null => {
    const t = tasks.get(taskId);
    if (!t) return "DEPENDENCY_MISSING";
    const next = new Set(path).add(taskId);
    for (const d of t.metadata?.dependsOn ?? []) {
      const nested = dependencyReason(d.taskId, next);
      if (nested) return nested;
      const ref = tasks.get(d.taskId);
      if (!ref) return "DEPENDENCY_MISSING";
      if (
        d.require === "accepted"
          ? !(
              ref.state === "accepted" &&
              (d.commit === null ||
                d.commit === ref.acceptedCommit ||
                d.commit === ref.acceptedSourceCommit)
            )
          : !(d.commit !== null && pinned(ref, d.commit))
      )
        return "DEPENDENCY_WAITING";
    }
    return null;
  };
  const rows = input.candidates.map((c) => {
    const t = tasks.get(c.taskId),
      l = lanes.get(c.lane);
    const m = t?.metadata;
    const priority = m ? priorities.indexOf(m.priority) : 2;
    const enqueue = m?.enqueuedAt ?? c.enqueuedAt;
    const aging = Math.min(
      2,
      Math.floor(Math.max(0, input.now - enqueue) / 1800000),
    );
    const review = c.kind === "review" && c.blocksAcceptance;
    const unblocks = input.tasks.filter((other) =>
      other.metadata?.dependsOn.some(
        (d) => d.taskId === c.taskId && d.require === "accepted",
      ),
    ).length;
    const entry: ScheduleEntry = {
      key: c.key,
      lane: c.lane,
      taskId: c.taskId,
      status: "eligible",
      reason: "ELIGIBLE",
      position: null,
      components: { priority, aging, unblocks, review, enqueue },
      dependencyIds: (m?.dependsOn ?? []).map((d) => d.taskId),
    };
    let reason: string | null = null;
    if (!c.authorized) reason = "UNAUTHORIZED";
    else if (!c.phaseAllowed) reason = "PHASE_DISALLOWED";
    else if (!c.ownershipValid) reason = "OWNERSHIP_INVALID";
    else if (!c.pathsDisjoint) reason = "PATH_OVERLAP";
    else if (!c.acceptedBase) reason = "BASE_UNACCEPTED";
    else if (!c.configLoaded) reason = "CONFIG_NOT_LOADED";
    else if (!l?.enabled) reason = "LANE_DISABLED";
    else if (l.held) reason = "LANE_HELD";
    else if (l.failurePaused) reason = "FAILURE_PAUSED";
    else if (l.runsLastHour >= l.maxRunsPerHour) reason = "RATE_LIMITED";
    else if (activeLanes.has(c.lane)) reason = "LANE_ACTIVE";
    else if (!t && c.kind !== "control") reason = "TASK_MISSING";
    else if (
      c.kind === "implementation" &&
      t &&
      !["assigned", "working"].includes(t.state)
    )
      reason = "TASK_FROZEN";
    else if (c.kind === "resume" && t?.state !== "blocked")
      reason = "RESUME_NOT_BLOCKED";
    else if (c.kind === "revision" && t?.state !== "ready")
      reason = "REVISION_NOT_READY";
    else if (
      c.kind === "review" &&
      (!m?.reviewOf ||
        !tasks.has(m.reviewOf.taskId) ||
        !pinned(
          tasks.get(m.reviewOf.taskId) as ScheduleTask,
          m.reviewOf.commit,
        ))
    )
      reason = "REVIEW_PIN_INVALID";
    else if (t) reason = dependencyReason(t.id);
    if (reason) {
      entry.status = "blocked";
      entry.reason = reason;
    }
    const effective = Math.min(
      review ? 1 : 3,
      priority === 0 ? 0 : Math.max(1, priority - aging),
    );
    return { c, entry, effective };
  });
  // Only an authorized correction of a ready task can hold competing work.
  // Genuine corrections retain precedence while waiting on dependencies.
  for (const row of rows)
    if (
      row.entry.status === "eligible" &&
      ["implementation", "resume"].includes(row.c.kind) &&
      rows.some(
        ({ c }) =>
          c.lane === row.c.lane &&
          c.kind === "revision" &&
          c.authorized &&
          c.phaseAllowed &&
          c.ownershipValid &&
          c.pathsDisjoint &&
          c.acceptedBase &&
          c.configLoaded &&
          tasks.get(c.taskId)?.state === "ready",
      )
    ) {
      row.entry.status = "blocked";
      row.entry.reason = "REVISION_PENDING";
    }
  const ascii = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort(
    (a, b) =>
      a.effective - b.effective ||
      b.entry.components.unblocks - a.entry.components.unblocks ||
      a.entry.components.enqueue - b.entry.components.enqueue ||
      ascii(a.c.key, b.c.key),
  );
  const selected: string[] = [];
  const used = new Set(activeLanes);
  let control = input.active.some(
    (a) => a.lane === (input.coordinatorLane ?? "coordinator"),
  );
  let position = 0;
  for (const { c, entry } of rows) {
    if (entry.status === "blocked") continue;
    entry.position = ++position;
    if (used.has(c.lane)) {
      entry.status = "capacity";
      entry.reason = "LANE_SELECTED";
      continue;
    }
    const reserve =
      input.coordinatorReserved &&
      !control &&
      !(
        c.kind === "control" &&
        c.lane === (input.coordinatorLane ?? "coordinator")
      )
        ? 1
        : 0;
    if (input.active.length + selected.length >= input.maxParallel - reserve) {
      entry.status = "capacity";
      entry.reason = reserve ? "COORDINATOR_RESERVED" : "CAPACITY";
      continue;
    }
    selected.push(c.key);
    used.add(c.lane);
    if (
      c.kind === "control" &&
      c.lane === (input.coordinatorLane ?? "coordinator")
    )
      control = true;
    entry.status = "selected";
    entry.reason = "SELECTED";
  }
  return {
    version: 1,
    evaluatedAt: input.now,
    selected,
    queue: rows.map((r) => r.entry),
  };
}
