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
  };
}

export function createAlertState() {
  return {
    known: Object.fromEntries(CATEGORIES.map((name) => [name, false])),
    present: Object.fromEntries(CATEGORIES.map((name) => [name, new Set()])),
    alerted: Object.fromEntries(CATEGORIES.map((name) => [name, []])),
    supervisor: null,
  };
}

const UP = new Set(["running"]);
const DOWN = new Set(["stopped", "stale"]);
/**
 * Compares `facts` with the previous observation. The first call never alerts
 * (everything on screen at load is already known). An id alerts once: while it
 * stays present, and for a bounded while after it disappears (a flapping
 * snapshot does not repeat it). Categories switched off still update the
 * memory, so turning one on later does not announce old items.
 */
export function observe(state, facts, prefs = DEFAULT_ALERT_PREFS) {
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
  if (typeof facts.supervisor === "string") {
    if (
      state.known.supervisor &&
      UP.has(state.supervisor ?? "") &&
      DOWN.has(facts.supervisor) &&
      prefs.categories?.supervisor !== false
    )
      events.push({
        category: "supervisor",
        id: `supervisor:${facts.supervisor}`,
      });
    // "draining" is a requested stop in progress, so it is never "unexpected".
    state.supervisor = facts.supervisor;
    state.known.supervisor = true;
  }
  return events;
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
