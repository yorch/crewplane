// Pure rules for the opt-in alerts: derive "what is new" by comparing the
// facts of consecutive snapshots, and word it. No DOM, no Notification API, no
// storage. The page decides whether anything is shown; this module only says
// what changed and what a safe message looks like.
//
// What may appear in a message: counts and short fixed phrases. Never message
// bodies, task titles, reasons, paths or any other text from the project.

export const CATEGORIES = [
  "questions",
  "blocked",
  "paused",
  "control",
  "supervisor",
];
export const CATEGORY_LABELS = {
  questions: "New open question or request",
  blocked: "Task becomes blocked",
  paused: "Agent paused after a failure or decision",
  control: "Command refused, out of date or not applied",
  supervisor: "Supervisor stopped unexpectedly",
};
/** Most ids read from one snapshot per category, and the dedupe memory. */
export const MAX_FACT_IDS = 1000;
export const MAX_ALERTED = 200;

export const DEFAULT_ALERT_PREFS = {
  badge: false,
  desktop: false,
  whenVisible: false,
  categories: Object.fromEntries(CATEGORIES.map((name) => [name, true])),
};

const ID = /^[\w.:-]{1,128}$/;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rebuilds stored alert preferences; anything unusable falls back to off. */
export function sanitizeAlertPrefs(raw) {
  const prefs = {
    ...DEFAULT_ALERT_PREFS,
    categories: { ...DEFAULT_ALERT_PREFS.categories },
  };
  if (!isRecord(raw)) return prefs;
  for (const key of ["badge", "desktop", "whenVisible"])
    if (typeof raw[key] === "boolean") prefs[key] = raw[key];
  if (isRecord(raw.categories))
    for (const name of CATEGORIES)
      if (typeof raw.categories[name] === "boolean")
        prefs.categories[name] = raw.categories[name];
  return prefs;
}

/**
 * Reads the facts the rules need from a snapshot (and the control log
 * entries, when loaded). Ids only; everything is bounded and validated, so a
 * hostile value cannot grow memory or reach a message.
 */
export function factsFromSnapshot(data, logEntries) {
  const ids = (list, pick) => {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const id = pick(item);
      if (typeof id === "string" && ID.test(id)) out.push(id);
      else if (typeof id === "number" && Number.isSafeInteger(id))
        out.push(String(id));
      if (out.length >= MAX_FACT_IDS) break;
    }
    return out;
  };
  const list = (value) => (Array.isArray(value) ? value : []);
  const headless = data?.headless;
  const held = new Set(list(headless?.held));
  const lanes = Array.isArray(headless?.lanes) ? headless.lanes : [];
  return {
    questions: ids(data?.unanswered, (message) => message?.id),
    blocked: ids(
      list(data?.tasks).filter((task) => task?.state === "blocked"),
      (task) => task.id,
    ),
    // A pause the operator asked for (a hold) is not news.
    paused: ids(
      lanes.filter(
        (lane) =>
          lane?.status === "paused" &&
          !held.has(lane.lane) &&
          headless?.instanceHeld !== true,
      ),
      (lane) =>
        `${lane.lane}:${lane.startedAt ?? ""}`.replace(/[^\w.:-]/g, "_"),
    ),
    // null until the control log has been read: nothing is known yet, so
    // nothing may be announced when it first arrives.
    control: Array.isArray(logEntries)
      ? ids(
          logEntries.filter((entry) =>
            ["refused", "stale", "invalid"].includes(entry?.outcome),
          ),
          (entry) => entry.seq,
        )
      : null,
    supervisor:
      typeof headless?.state === "string" ? headless.state : "unknown",
    // The newest stop command the operator got applied; null until the log
    // has been read. It tells a requested stop from a crash.
    stopSeq: Array.isArray(logEntries)
      ? logEntries.reduce(
          (top, entry) =>
            entry?.action === "stop" &&
            entry?.outcome === "applied" &&
            Number.isSafeInteger(entry.seq) &&
            entry.seq > top
              ? entry.seq
              : top,
          0,
        )
      : null,
  };
}

export function createAlertState() {
  return {
    known: Object.fromEntries(CATEGORIES.map((name) => [name, false])),
    present: Object.fromEntries(CATEGORIES.map((name) => [name, new Set()])),
    alerted: Object.fromEntries(CATEGORIES.map((name) => [name, []])),
    supervisor: createSupervisorWatch(),
  };
}

/** A supervisor must look down this long apart in two observations to alert. */
export const SUPERVISOR_CONFIRM_MS = 3000;
/** After a supervisor alert, another one waits this long (a flapping process). */
export const SUPERVISOR_COOLDOWN_MS = 10 * 60 * 1000;
function createSupervisorWatch() {
  return {
    // Seen running since the last alert or clean stop: only then can it "stop
    // unexpectedly".
    armed: false,
    // A stop was requested (a "draining" snapshot, or a stop command in the
    // control log newer than the last running snapshot).
    requested: false,
    // The highest applied stop command seen while it was running.
    stopBase: 0,
    // When the current unbroken run of down snapshots began, and how many.
    downSince: null,
    downCount: 0,
    lastAlert: null,
  };
}
/** True while a down supervisor waits for its second, later observation. */
export function supervisorPending(state) {
  return state.supervisor.armed && state.supervisor.downCount === 1;
}

function observeSupervisor(state, facts, prefs, now, events) {
  if (typeof facts.supervisor !== "string") return;
  const watch = state.supervisor;
  const status = facts.supervisor;
  const stopSeq = Number.isSafeInteger(facts.stopSeq) ? facts.stopSeq : null;
  if (status === "running") {
    watch.armed = true;
    watch.requested = false;
    watch.downSince = null;
    watch.downCount = 0;
    if (stopSeq !== null) watch.stopBase = Math.max(watch.stopBase, stopSeq);
    state.known.supervisor = true;
    return;
  }
  // "draining" is a requested stop in progress, so it is never "unexpected".
  if (status === "draining") {
    watch.requested = true;
    watch.downSince = null;
    watch.downCount = 0;
    state.known.supervisor = true;
    return;
  }
  if (status !== "stopped" && status !== "stale") {
    watch.downSince = null;
    watch.downCount = 0;
    return;
  }
  state.known.supervisor = true;
  if (!watch.armed) return;
  // A stop the operator asked for through the dashboard is in the control log.
  // An unread log (null) proves nothing either way, so nothing is announced
  // from "stopped" until it is read; "stale" needs no log (a stop does not
  // leave a process looking stale).
  if (stopSeq !== null && stopSeq > watch.stopBase) watch.requested = true;
  if (watch.requested || (status === "stopped" && stopSeq === null)) {
    if (watch.requested) watch.armed = false;
    return;
  }
  if (watch.downCount === 0) watch.downSince = now;
  watch.downCount++;
  if (
    watch.downCount < 2 ||
    now - (watch.downSince ?? now) < SUPERVISOR_CONFIRM_MS
  )
    return;
  watch.armed = false;
  const cooled =
    watch.lastAlert === null || now - watch.lastAlert >= SUPERVISOR_COOLDOWN_MS;
  if (cooled && prefs.categories?.supervisor !== false) {
    watch.lastAlert = now;
    events.push({ category: "supervisor", id: `supervisor:${status}` });
  }
}

/**
 * Compares `facts` with the previous observation. The first call never alerts
 * (everything on screen at load is already known). An id alerts once: while it
 * stays present, and for a bounded while after it disappears (a flapping
 * snapshot does not repeat it). Categories switched off still update the
 * memory, so turning one on later does not announce old items.
 *
 * The supervisor is judged differently, because "not running" is often what
 * the operator asked for: it alerts only after being seen running, only when
 * no stop command (control log, `facts.stopSeq`) explains it, only when it
 * still looks down at a second observation at least SUPERVISOR_CONFIRM_MS
 * later, and at most once per SUPERVISOR_COOLDOWN_MS.
 */
export function observe(
  state,
  facts,
  prefs = DEFAULT_ALERT_PREFS,
  now = Date.now(),
) {
  const events = [];
  for (const category of CATEGORIES.filter((name) => name !== "supervisor")) {
    // Not read yet (null): nothing is known, so the next read is the baseline.
    if (!Array.isArray(facts[category])) continue;
    const first = !state.known[category];
    const current = new Set(facts[category].slice(0, MAX_FACT_IDS));
    const memory = state.alerted[category];
    for (const id of current) {
      if (state.present[category].has(id) || memory.includes(id)) continue;
      memory.push(id);
      if (memory.length > MAX_ALERTED)
        memory.splice(0, memory.length - MAX_ALERTED);
      if (!first && prefs.categories?.[category] !== false)
        events.push({ category, id });
    }
    state.present[category] = current;
    state.known[category] = true;
  }
  observeSupervisor(state, facts, prefs, now, events);
  return events;
}

/**
 * Where clicking an alert goes: a fixed view and filter per category (the
 * page builds the hash with hrefFor). Never derived from snapshot data.
 */
export const ALERT_TARGETS = {
  questions: { view: "messages", params: { filter: "open" } },
  blocked: { view: "tasks", params: { state: "blocked" } },
  paused: { view: "agents", params: { status: "paused" } },
  control: { view: "audit", params: { outcome: "refused" } },
  supervisor: { view: "overview", params: {} },
};
/** The target of the first event whose category has one (fixed order). */
export function alertTarget(events) {
  for (const category of CATEGORIES)
    if (events.some((event) => event.category === category))
      return ALERT_TARGETS[category];
  return ALERT_TARGETS.supervisor;
}

/** Counts per category, in the fixed category order. */
export function countEvents(events) {
  const counts = Object.fromEntries(CATEGORIES.map((name) => [name, 0]));
  for (const event of events)
    if (Object.hasOwn(counts, event.category)) counts[event.category]++;
  return counts;
}

const plural = (count, one, many) => (count === 1 ? one : many);
/** Fixed phrases and counts only. Returns { title, body } or null. */
export function describeAlerts(events) {
  const counts = countEvents(events);
  const parts = [];
  if (counts.questions)
    parts.push(
      `${counts.questions} new open ${plural(counts.questions, "question", "questions")}`,
    );
  if (counts.blocked)
    parts.push(
      `${counts.blocked} ${plural(counts.blocked, "task", "tasks")} blocked`,
    );
  if (counts.paused)
    parts.push(
      `${counts.paused} ${plural(counts.paused, "agent", "agents")} paused`,
    );
  if (counts.control)
    parts.push(
      `${counts.control} ${plural(counts.control, "command", "commands")} not applied`,
    );
  if (counts.supervisor) parts.push("Supervisor stopped");
  if (!parts.length) return null;
  return { title: "Crewplane needs a look", body: `${parts.join(", ")}.` };
}

/** `(3) Overview · Crewplane` for a positive count, otherwise the plain title. */
export function titleWithBadge(base, count) {
  const safe = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return safe ? `(${safe > 99 ? "99+" : safe}) ${base}` : base;
}

/**
 * Whether to show a desktop notification now. Alerts stay quiet while the
 * tab is visible and focused, unless the person asked for them there.
 */
export function shouldNotify(prefs, { permission, visible, focused }) {
  if (!prefs.desktop || permission !== "granted") return false;
  return !(visible && focused) || prefs.whenVisible;
}
/** Whether new events add to the tab-title count right now. */
export function shouldCount(prefs, { visible, focused }) {
  if (!prefs.badge) return false;
  return !(visible && focused) || prefs.whenVisible;
}
