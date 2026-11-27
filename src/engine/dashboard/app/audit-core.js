// Pure rules for the Control log view: how outcomes and reason codes read, how
// pages of /api/control-log merge into one ascending list, and the filters.
// No DOM and no network. The server stays the authority on what the log holds
// (it is a bounded audit trail, at most the latest 200 entries).
import { reasonText } from "./controls-core.js";

export const LOG_CAP = 200;
/**
 * Entries kept client-side: exactly what the supervisor retains, so "N of M
 * retained" and a `?seq=` detail never claim more than the server still holds.
 */
export const KEEP = LOG_CAP;
export const PAGE = 50;

const OUTCOMES = {
  applied: { label: "Applied", tone: "success", attention: false },
  noop: { label: "No change", tone: "neutral", attention: false },
  refused: { label: "Refused", tone: "danger", attention: true },
  stale: { label: "Out of date", tone: "warning", attention: true },
  invalid: { label: "Not applied", tone: "danger", attention: true },
};
export const OUTCOME_KEYS = Object.keys(OUTCOMES);

export function outcomeInfo(outcome) {
  return Object.hasOwn(OUTCOMES, outcome)
    ? OUTCOMES[outcome]
    : { label: "Unknown", tone: "unknown", attention: true };
}
/** Refused, stale and invalid commands are the ones an operator should look at. */
export const needsAttention = (entry) => outcomeInfo(entry?.outcome).attention;

const SCOPES = {
  instance: "Whole supervisor",
  lane: "Agent",
  task: "Task",
  run: "Run",
};
export const scopeLabel = (scope) => SCOPES[scope] ?? "Not recorded";

/**
 * Plain-language reason. A known code reads as a sentence; an unknown one is
 * shown raw (it is plain text and is only ever rendered through textContent),
 * and a missing one says nothing was recorded.
 */
export function explainReason(entry) {
  const code = typeof entry?.reason === "string" ? entry.reason : null;
  if (!code)
    return { code: null, text: "No reason code was recorded.", known: false };
  const text = reasonText(code, entry.outcome);
  return text
    ? { code, text, known: true }
    : {
        code,
        text: "This reason code is not one the dashboard knows; the raw code is shown.",
        known: false,
      };
}

/** One sentence: what happened, to what. */
export function entrySummary(entry) {
  const action = entry?.action ?? "command";
  const target = entry?.target ? ` on ${entry.target}` : "";
  return `${action}${target} · ${outcomeInfo(entry?.outcome).label}`;
}

const validEntry = (item) =>
  typeof item === "object" &&
  item !== null &&
  Number.isSafeInteger(item.seq) &&
  item.seq >= 0;

/** Empty model, before the first answer. */
export const emptyLog = () => ({
  available: null,
  entries: [],
  latestSeq: null,
  retainedFrom: null,
  retained: null,
  cursor: null,
});

/**
 * Folds an answer into the model. Without a cursor the answer is the newest
 * window and replaces the list; with one it holds only newer entries and is
 * appended (a repeated seq is replaced, never duplicated). The list stays
 * ascending and bounded.
 */
export function mergeLog(previous, body, { replace }) {
  const incoming = (Array.isArray(body?.entries) ? body.entries : []).filter(
    validEntry,
  );
  const base = replace ? [] : previous.entries;
  const bySeq = new Map(base.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  // What the supervisor no longer retains is dropped, not kept as "extra".
  const from = Number.isSafeInteger(body?.retainedFrom)
    ? body.retainedFrom
    : null;
  const entries = [...bySeq.values()]
    .filter((entry) => from === null || entry.seq >= from)
    .sort((a, b) => a.seq - b.seq)
    .slice(-KEEP);
  const last = entries.at(-1)?.seq ?? null;
  const cursor = Number.isSafeInteger(body?.nextAfter)
    ? Math.max(body.nextAfter, last ?? 0)
    : last;
  return {
    available: body?.available === true,
    entries,
    latestSeq: Number.isSafeInteger(body?.latestSeq) ? body.latestSeq : last,
    retainedFrom: Number.isSafeInteger(body?.retainedFrom)
      ? body.retainedFrom
      : (entries[0]?.seq ?? null),
    retained: Number.isSafeInteger(body?.retained) ? body.retained : null,
    cursor,
  };
}

/** The path for the next read: everything retained at first, then only what is newer. */
export function logPath(model) {
  return model.cursor === null
    ? `/api/control-log?limit=${LOG_CAP}`
    : `/api/control-log?after=${model.cursor}&limit=${LOG_CAP}`;
}
/**
 * Whether the log is no longer the one the held entries came from, so it must
 * be read again from the start. A cursor read only returns newer entries, so a
 * reset is recognised from what the answer says about the log itself:
 * - the latest sequence is behind the cursor (restarted and not yet past it);
 * - the oldest retained sequence is beyond the cursor + 1 (entries were lost
 *   unseen: a gap) or before the oldest entry held (older than anything read);
 * - the entry the server holds at the cursor or at its oldest retained
 *   sequence has a different id than the one held (restarted and grew past the
 *   cursor, which sequence numbers alone cannot show).
 */
export function logWasReset(model, body) {
  if (model.cursor === null) return false;
  if (Number.isSafeInteger(body?.latestSeq) && body.latestSeq < model.cursor)
    return true;
  const from = body?.retainedFrom;
  if (Number.isSafeInteger(from)) {
    if (from > model.cursor + 1) return true;
    const oldest = model.entries[0]?.seq;
    if (oldest !== undefined && from < oldest) return true;
    if (typeof body.retainedFromId === "string") {
      const held = model.entries.find((entry) => entry.seq === from);
      if (typeof held?.id === "string" && held.id !== body.retainedFromId)
        return true;
    }
  }
  if (typeof body?.afterId === "string") {
    const held = model.entries.find((entry) => entry.seq === model.cursor);
    if (typeof held?.id === "string" && held.id !== body.afterId) return true;
  }
  return false;
}

/** Filters (all optional, exact match) newest first. */
export function filterEntries(entries, params = {}) {
  return entries
    .filter(
      (entry) =>
        (!params.outcome || entry.outcome === params.outcome) &&
        (!params.issuer || entry.issuer === params.issuer) &&
        (!params.lane ||
          entry.lane === params.lane ||
          entry.target === params.lane),
    )
    .sort((a, b) => b.seq - a.seq);
}
export const distinct = (entries, key) =>
  [
    ...new Set(
      entries
        .map((entry) => entry[key])
        .filter((value) => typeof value === "string" && value),
    ),
  ].sort();
export const laneChoices = (entries) =>
  [
    ...new Set(
      entries.flatMap((entry) =>
        [entry.lane, entry.scope === "lane" ? entry.target : null].filter(
          (value) => typeof value === "string" && value,
        ),
      ),
    ),
  ].sort();

export function outcomeCounts(entries) {
  const counts = Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0]));
  let unknown = 0;
  for (const entry of entries)
    if (Object.hasOwn(counts, entry.outcome)) counts[entry.outcome] += 1;
    else unknown += 1;
  return {
    ...counts,
    unknown,
    attention: entries.filter(needsAttention).length,
  };
}

/** What the log can and cannot tell the operator about its own completeness. */
export function retentionNote(model) {
  if (model.available === false)
    return "The supervisor state could not be read, so no log is available.";
  if (!model.entries.length) return null;
  const first = model.retainedFrom;
  return `The supervisor keeps only the latest ${LOG_CAP} commands${
    first !== null && first > 1
      ? `; entries before #${first} are no longer retained`
      : ""
  }. This is an audit trail of recent commands, not a complete history.`;
}

/** Links an entry offers to other views (only for ids the entry itself names). */
export function entryLinks(entry) {
  const links = [];
  if (entry.lane) links.push({ view: "agents", params: { agent: entry.lane } });
  if (entry.task) links.push({ view: "tasks", params: { task: entry.task } });
  if (entry.run) links.push({ view: "runs", params: { run: entry.run } });
  return links;
}
