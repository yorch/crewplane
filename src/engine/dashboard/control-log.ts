import type { State } from "../../contracts.ts";
import { clean, count, instant } from "./sanitize.ts";

export const controlLogDefaultLimit = 50;
export const controlLogMaxLimit = 200;
const outcomes = ["applied", "noop", "refused", "stale", "invalid"] as const;
const scopes = ["instance", "lane", "task", "run"] as const;

export interface ControlLogQuery {
  limit: number;
  after: number | null;
}

/** Strict parameter parsing: unknown names and malformed or oversized values are rejected (null). */
export function parseControlLogQuery(
  params: URLSearchParams,
): ControlLogQuery | null {
  for (const key of params.keys())
    if (key !== "limit" && key !== "after") return null;
  if (params.getAll("limit").length > 1 || params.getAll("after").length > 1)
    return null;
  const rawLimit = params.get("limit");
  const rawAfter = params.get("after");
  if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) return null;
  if (rawAfter !== null && !/^\d{1,9}$/.test(rawAfter)) return null;
  const limit = rawLimit === null ? controlLogDefaultLimit : Number(rawLimit);
  if (limit < 1 || limit > controlLogMaxLimit) return null;
  return { limit, after: rawAfter === null ? null : Number(rawAfter) };
}

/**
 * Allowlisted projection of `state.controlLog`. Entries are ascending by `seq`.
 * Without `after` the newest `limit` entries are returned; with it, the first
 * `limit` entries newer than that sequence. The log is bounded (200) by the
 * supervisor, so older entries may no longer exist (`retainedFrom`).
 */
export function controlLogView(state: State | null, query: ControlLogQuery) {
  const raw = Array.isArray(state?.controlLog) ? state.controlLog : [];
  const entries = raw
    .flatMap((item) => {
      const seq = count(item?.seq);
      if (seq === null || typeof item !== "object") return [];
      const scope = scopes.find((s) => s === item.scope) ?? null;
      const target = clean(item.target, 128);
      const outcome = outcomes.find((o) => o === item.outcome) ?? "invalid";
      return [
        {
          id:
            typeof item.id === "string" && /^[a-f0-9-]{36}$/.test(item.id)
              ? item.id
              : null,
          seq,
          at: instant(item.at),
          issuer: clean(item.issuer, 64),
          action: clean(item.action, 32),
          scope,
          target,
          lane: scope === "lane" ? target : null,
          task: scope === "task" ? target : null,
          run: scope === "run" ? target : null,
          outcome,
          reason: clean(item.code, 96),
        },
      ];
    })
    .sort((a, b) => a.seq - b.seq);
  const newer =
    query.after === null
      ? entries
      : entries.filter((entry) => entry.seq > (query.after as number));
  const page =
    query.after === null
      ? newer.slice(-query.limit)
      : newer.slice(0, query.limit);
  const last = page.at(-1)?.seq ?? query.after;
  return {
    version: 1,
    available: state !== null,
    entries: page,
    latestSeq: count(state?.controlSeq) ?? entries.at(-1)?.seq ?? null,
    retainedFrom: entries[0]?.seq ?? null,
    /** Id of the oldest retained entry, so a client can tell a reset log from a pruned one. */
    retainedFromId: entries[0]?.id ?? null,
    /** Id of the entry at `after` when it is still retained (a restarted log has other ids). */
    afterId:
      query.after === null
        ? null
        : (entries.find((entry) => entry.seq === query.after)?.id ?? null),
    retained: entries.length,
    hasMore: query.after === null ? false : newer.length > page.length,
    nextAfter: last ?? null,
  };
}
