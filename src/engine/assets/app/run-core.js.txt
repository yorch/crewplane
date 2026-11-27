// Pure helpers for the run timeline extras: filtering the loaded events,
// counting by type, finding the first error, exporting exactly what the page
// shows, and comparing two runs. No DOM and no network. Events are already
// sanitized by the server; these helpers never widen that: an export is rebuilt
// field by field from the same fields the timeline prints, and everything is
// bounded to the 500 events the page keeps per run.

export const MAX_EVENTS = 500;
export const KIND_ORDER = [
  "started",
  "session",
  "assistant",
  "tool-start",
  "tool-finish",
  "usage",
  "omitted",
  "finished",
  "paused",
  "error",
];
const RUN_ID =
  /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const str = (value, limit = 600) =>
  typeof value === "string" ? value.slice(0, limit) : null;
const num = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** One event reduced to the fields the timeline displays. */
export function exportEvent(event) {
  return {
    sequence: num(event?.sequence),
    at: str(event?.at, 64),
    kind: str(event?.kind, 32),
    channel: str(event?.channel, 16),
    tool: str(event?.tool, 64),
    status: str(event?.status, 32),
    model: str(event?.model, 128),
    effort: str(event?.effort, 32),
    inputTokens: num(event?.inputTokens),
    outputTokens: num(event?.outputTokens),
    durationMs: num(event?.durationMs),
    message: str(event?.message),
  };
}
/** The run header the page shows beside the timeline. */
export function exportRun(meta, events, filter) {
  return {
    runId: str(meta?.runId, 64),
    lane: str(meta?.lane, 64),
    task: str(meta?.task, 96),
    harness: str(meta?.harness, 32),
    status: str(meta?.status, 32),
    finalState: str(meta?.finalState, 32),
    exportedEvents: Math.min(events.length, MAX_EVENTS),
    ...(filter
      ? {
          filter: {
            types: [...filter.kinds].slice(0, 12).map((kind) => str(kind, 32)),
            query: str(filter.query, 100),
          },
        }
      : {}),
    note: "Sanitized operational metadata as shown in the dashboard timeline. Payloads are filtered; at most the latest 500 events.",
    events: events.slice(-MAX_EVENTS).map(exportEvent),
  };
}
export const toJson = (meta, events, filter) =>
  JSON.stringify(exportRun(meta, events, filter), null, 2);
/** A fixed name; the id is only used when it has the run id shape. */
export const downloadName = (runId) =>
  `crewplane-run-${RUN_ID.test(String(runId)) ? runId : "unknown"}.json`;

/** [kind, count] in the canonical order, unknown kinds last, zero counts out. */
export function kindCounts(events) {
  const counts = new Map();
  for (const event of events)
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  const known = KIND_ORDER.filter((kind) => counts.has(kind));
  const other = [...counts.keys()]
    .filter((kind) => !KIND_ORDER.includes(kind))
    .sort()
    .slice(0, 12);
  return [...known, ...other].map((kind) => [kind, counts.get(kind)]);
}

const fold = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
/** The text a search looks at, for one event. */
export function searchText(event) {
  return fold(
    [
      event.sequence,
      event.kind,
      event.channel,
      event.tool,
      event.status,
      event.model,
      event.effort,
      event.message,
    ]
      .filter((value) => value !== null && value !== undefined)
      .join(" "),
  );
}
/** Whether an event passes the type chips (none selected means all) and text. */
export function eventMatches(event, kinds, query) {
  if (kinds.size && !kinds.has(event.kind)) return false;
  const terms = fold(String(query ?? "").slice(0, 100))
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (!terms.length) return true;
  const text = searchText(event);
  return terms.every((term) => text.includes(term));
}
export const filterEvents = (events, kinds, query) =>
  events.filter((event) => eventMatches(event, kinds, query));

export const isError = (event) =>
  event.kind === "error" || event.status === "failed";
/** Index of the first failing event in the loaded events, or -1. */
export function firstErrorIndex(events) {
  return events.findIndex(isError);
}

function summarize(events) {
  let first = null;
  let last = null;
  let input = 0;
  let output = 0;
  let toolMs = 0;
  let errors = 0;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isFinite(at)) {
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
    }
    input += num(event.inputTokens) ?? 0;
    output += num(event.outputTokens) ?? 0;
    toolMs += num(event.durationMs) ?? 0;
    if (isError(event)) errors++;
  }
  return {
    events: events.length,
    errors,
    spanMs: first !== null && last !== null ? last - first : null,
    toolMs,
    inputTokens: input,
    outputTokens: output,
  };
}
const label = (event) =>
  event
    ? [event.kind, event.tool, event.status].filter(Boolean).join(" · ")
    : "";
/**
 * Compares two runs' loaded events: totals, counts per type and an alignment
 * by position (event 1 with event 1, and so on) that marks where the two first
 * differ in type. Both inputs are cut to the latest 500 events (the same
 * window on both sides); `totals` ({ a, b }) are the events each run holds,
 * so the result can say how much of each was left out.
 */
export function compareRuns(a, b, totals = {}) {
  const left = a.slice(-MAX_EVENTS);
  const right = b.slice(-MAX_EVENTS);
  const side = (shown, total, atLeast = false) => {
    const known = Number.isSafeInteger(total) && total >= shown.length;
    return {
      shown: shown.length,
      total: known ? total : shown.length,
      cut: known && total > shown.length,
      atLeast: known && atLeast,
    };
  };
  const sizes = {
    a: side(left, totals.a),
    b: side(right, totals.b, totals.bAtLeast === true),
  };
  const total = {
    a: summarize(left),
    b: summarize(right),
  };
  const kinds = [
    ...new Set([...left, ...right].map((event) => event.kind)),
  ].sort(
    (x, y) =>
      (KIND_ORDER.indexOf(x) === -1 ? 99 : KIND_ORDER.indexOf(x)) -
        (KIND_ORDER.indexOf(y) === -1 ? 99 : KIND_ORDER.indexOf(y)) ||
      (x < y ? -1 : 1),
  );
  const count = (events, kind) =>
    events.filter((event) => event.kind === kind).length;
  const byKind = kinds.map((kind) => {
    const first = count(left, kind);
    const second = count(right, kind);
    return { kind, a: first, b: second, diff: second - first };
  });
  const rows = [];
  let firstDifference = -1;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    const same = Boolean(x && y && x.kind === y.kind);
    if (!same && firstDifference === -1) firstDifference = index;
    rows.push({
      index,
      a: x ? label(x) : "",
      b: y ? label(y) : "",
      aDuration: num(x?.durationMs),
      bDuration: num(y?.durationMs),
      same,
    });
  }
  return { total, byKind, rows, firstDifference, window: sizes };
}

/** "1.2 s", "340 ms", "2 min 5 s": a readable duration, or "not recorded". */
export function formatSpan(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms))
    return "not recorded";
  const value = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (value < 1000) return `${sign}${Math.round(value)} ms`;
  if (value < 60000) return `${sign}${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60000);
  return `${sign}${minutes} min ${Math.round((value % 60000) / 1000)} s`;
}
/** Runs the person can compare with: the same task or the same agent. */
export function comparable(selected, runs) {
  if (!selected) return [];
  return [...runs]
    .filter(
      (run) =>
        run.runId !== selected.runId &&
        ((selected.task && run.task === selected.task) ||
          run.lane === selected.lane),
    )
    .sort((x, y) => (x.runId < y.runId ? 1 : -1))
    .slice(0, 40);
}

const count = (value) => value.toLocaleString("en-US");
/** One sentence naming exactly what was compared. */
export function describeWindow(window) {
  const part = (label, side) =>
    side.cut
      ? `${label} ${count(side.shown)} of ${side.atLeast ? "at least " : ""}${count(side.total)} events (older ${count(side.total - side.shown)}${side.atLeast ? " or more" : ""} left out)`
      : `${label} all ${count(side.total)} ${side.total === 1 ? "event" : "events"}`;
  return `Compared: the latest ${MAX_EVENTS} events of each run. ${part("This run:", window.a)}; ${part("other run:", window.b)}.`;
}
