// Pure ranking for the command palette. No DOM, no storage, no network: the
// palette hands in entries built from data the page already holds and renders
// what comes back with textContent. Everything here is bounded, because the
// text it ranks (task titles, message bodies, run lanes) is untrusted.
//
// Ranking, per query term, best field wins:
//   exact value > prefix > word prefix > substring > subsequence
// Every term must match something (AND). Ties keep a stable order: score,
// then the kind order, then the order entries were supplied.

export const MAX_RESULTS = 50;
export const MAX_QUERY = 100;
export const MAX_TERMS = 6;
const MAX_TERM = 48;
const MAX_FIELD = 160;
/** Per kind ceilings, so an index over a huge board stays cheap to build. */
export const INDEX_LIMITS = {
  view: 40,
  action: 40,
  task: 3000,
  agent: 200,
  thread: 3000,
  run: 500,
  artifact: 500,
};
export const KIND_ORDER = [
  "action",
  "view",
  "task",
  "agent",
  "thread",
  "run",
  "artifact",
];
const KIND_RANK = new Map(KIND_ORDER.map((kind, index) => [kind, index]));

const MARKS = /\p{M}+/gu;
const SPACES = /[\s\p{Cc}]+/gu;

/**
 * Case and diacritic folding: "Édition" and "edition" compare equal. Output is
 * capped, so a hostile megabyte string costs a bounded amount of work.
 */
export function fold(value, limit = MAX_FIELD) {
  const text = String(value ?? "").slice(0, limit * 2);
  return text
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(SPACES, " ")
    .trim()
    .slice(0, limit);
}

/** The query as folded terms (at most MAX_TERMS, each at most MAX_TERM). */
export function parseQuery(query) {
  const folded = fold(query, MAX_QUERY);
  if (!folded) return [];
  return [...new Set(folded.split(" "))]
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((term) => term.slice(0, MAX_TERM));
}

function isSubsequence(term, field) {
  if (term.length < 2 || term.length > field.length) return false;
  let at = 0;
  for (let index = 0; index < field.length && at < term.length; index++)
    if (field.charCodeAt(index) === term.charCodeAt(at)) at++;
  return at === term.length;
}
const WORD_START = /[\s\-_./:]/;
/** 0 for no match, otherwise a score: higher is better. */
export function scoreField(term, field) {
  if (!field || !term) return 0;
  if (field === term) return 1000;
  if (field.startsWith(term)) return 800;
  const index = field.indexOf(term);
  if (index > 0) {
    const before = field.charAt(index - 1);
    // A match that starts a word beats one buried inside a word.
    return WORD_START.test(before) ? 600 : 400;
  }
  if (field.length <= 80 && isSubsequence(term, field)) return 100;
  return 0;
}

/**
 * Builds a searchable entry once. `keys` are extra fields (ids, owner, phase)
 * that rank below the title; `href` is where activating the entry goes.
 */
export function makeEntry(input) {
  const title = String(input.title ?? "").slice(0, MAX_FIELD);
  return {
    kind: input.kind,
    id: String(input.id ?? title).slice(0, 128),
    title,
    subtitle: String(input.subtitle ?? "").slice(0, MAX_FIELD),
    href: input.href,
    boost: input.boost ?? 0,
    foldedTitle: fold(title),
    foldedKeys: (input.keys ?? []).slice(0, 6).map((key) => fold(key)),
  };
}

/**
 * Builds the index from groups of raw entries, applying the per kind limits.
 * Returns the entries and how many were left out, so the palette can say so.
 */
export function buildIndex(groups) {
  const entries = [];
  let omitted = 0;
  const seen = new Map();
  for (const raw of groups) {
    const kind = raw.kind;
    const limit = INDEX_LIMITS[kind] ?? 100;
    const used = seen.get(kind) ?? 0;
    if (used >= limit) {
      omitted++;
      continue;
    }
    seen.set(kind, used + 1);
    entries.push(makeEntry(raw));
  }
  return { entries, omitted };
}

function scoreEntry(terms, entry) {
  let total = 0;
  for (const term of terms) {
    let best = scoreField(term, entry.foldedTitle) * 1.5;
    for (const key of entry.foldedKeys) {
      const score = scoreField(term, key);
      if (score > best) best = score;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total + entry.boost;
}

/**
 * Ranks entries for a query. An empty query returns the leading `views` and
 * `actions` so the palette is useful before typing. Always at most `limit`.
 */
export function search(entries, query, limit = MAX_RESULTS) {
  const cap = Math.max(1, Math.min(limit, MAX_RESULTS));
  const terms = parseQuery(query);
  const scored = [];
  if (terms.length === 0) {
    entries.forEach((entry, order) => {
      if (entry.kind === "view" || entry.kind === "action")
        scored.push({ entry, score: 1, order });
    });
  } else {
    entries.forEach((entry, order) => {
      const score = scoreEntry(terms, entry);
      if (score > 0) scored.push({ entry, score, order });
    });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (KIND_RANK.get(a.entry.kind) ?? 99) -
        (KIND_RANK.get(b.entry.kind) ?? 99) ||
      a.order - b.order,
  );
  return {
    results: scored.slice(0, cap).map((item) => item.entry),
    total: scored.length,
  };
}
