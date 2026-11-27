import { expect, it } from "vitest";
import {
  distinct,
  emptyLog,
  entryLinks,
  entrySummary,
  explainReason,
  filterEntries,
  KEEP,
  laneChoices,
  logPath,
  logWasReset,
  mergeLog,
  needsAttention,
  outcomeCounts,
  outcomeInfo,
  retentionNote,
  scopeLabel,
} from "./audit-core.js";

const entry = (seq: number, extra: Record<string, unknown> = {}) => ({
  id: null,
  seq,
  at: "2026-11-01T10:00:00.000Z",
  issuer: "cli",
  action: "pause",
  scope: "lane",
  target: "builder",
  lane: "builder",
  task: null,
  run: null,
  outcome: "applied",
  reason: "HELD",
  ...extra,
});

it("labels every outcome with tone and text, and flags the ones needing attention", () => {
  expect(outcomeInfo("applied")).toMatchObject({
    label: "Applied",
    tone: "success",
  });
  expect(outcomeInfo("noop").label).toBe("No change");
  expect(outcomeInfo("refused").tone).toBe("danger");
  expect(outcomeInfo("stale").tone).toBe("warning");
  expect(outcomeInfo("invalid").label).toBe("Not applied");
  expect(outcomeInfo("<img onerror=x>")).toMatchObject({
    label: "Unknown",
    tone: "unknown",
  });
  expect(["applied", "noop"].some((o) => needsAttention({ outcome: o }))).toBe(
    false,
  );
  for (const o of ["refused", "stale", "invalid", "weird"])
    expect(needsAttention({ outcome: o })).toBe(true);
});

it("explains the reason codes the supervisor and the dashboard record", () => {
  for (const code of [
    "STALE_REVISION",
    "STALE_GENERATION",
    "STALE_RUN",
    "CLI_ONLY",
    "LEGACY_LAYOUT",
    "UNKNOWN_AGENT",
    "PIN_REQUIRED",
    "INVALID_CONTROL",
    "STOP_WINS",
    "ROLLOUT",
    "CLEANUP_UNVERIFIED",
    "LIVE_OWNERSHIP",
  ])
    expect(
      explainReason({ reason: code, outcome: "refused" }),
      code,
    ).toMatchObject({ code, known: true });
  expect(explainReason({ reason: "STALE_REVISION" }).text).toMatch(
    /agent changed/,
  );
  // HELD reads differently when it was not applied.
  expect(explainReason({ reason: "HELD", outcome: "applied" }).text).toMatch(
    /now on hold/,
  );
  expect(explainReason({ reason: "HELD", outcome: "refused" }).text).toMatch(
    /resume it first/,
  );
});

it("shows unknown or hostile codes raw, never as a known explanation", () => {
  const hostile = explainReason({ reason: "<img src=x onerror=alert(1)>" });
  expect(hostile.known).toBe(false);
  expect(hostile.code).toBe("<img src=x onerror=alert(1)>");
  expect(hostile.text).toMatch(/not one the dashboard knows/);
  const other = explainReason({ reason: "SOMETHING_NEW" });
  expect(other).toMatchObject({ code: "SOMETHING_NEW", known: false });
  expect(explainReason({ reason: null }).text).toMatch(/No reason code/);
  // Prototype keys are not codes.
  expect(explainReason({ reason: "constructor" }).known).toBe(false);
  expect(explainReason({ reason: "__PROTO__" }).known).toBe(false);
});

it("summarizes and scopes entries", () => {
  expect(entrySummary(entry(1))).toBe("pause on builder · Applied");
  expect(entrySummary({})).toBe("command · Unknown");
  expect(scopeLabel("instance")).toBe("Whole supervisor");
  expect(scopeLabel("nope")).toBe("Not recorded");
  expect(entryLinks(entry(1))).toEqual([
    { view: "agents", params: { agent: "builder" } },
  ]);
  expect(
    entryLinks(entry(2, { scope: "task", lane: null, task: "CP-1" })),
  ).toEqual([{ view: "tasks", params: { task: "CP-1" } }]);
  expect(entryLinks(entry(3, { scope: "run", lane: null, run: "r1" }))).toEqual(
    [{ view: "runs", params: { run: "r1" } }],
  );
  expect(entryLinks(entry(4, { scope: "instance", lane: null }))).toEqual([]);
});

it("merges pages ascending, without duplicates, and replaces on a fresh read", () => {
  const first = mergeLog(
    emptyLog(),
    {
      available: true,
      entries: [entry(2), entry(1)],
      latestSeq: 2,
      retainedFrom: 1,
      retained: 2,
      nextAfter: 2,
    },
    { replace: true },
  );
  expect(first.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
  expect(first.cursor).toBe(2);
  const next = mergeLog(
    first,
    {
      available: true,
      entries: [entry(2, { outcome: "stale" }), entry(3)],
      latestSeq: 3,
      retainedFrom: 1,
      retained: 3,
      nextAfter: 3,
    },
    { replace: false },
  );
  expect(next.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
  expect(next.entries[1]?.outcome).toBe("stale");
  expect(next.cursor).toBe(3);
  const replaced = mergeLog(
    next,
    { available: true, entries: [entry(9)], latestSeq: 9 },
    { replace: true },
  );
  expect(replaced.entries.map((e: { seq: number }) => e.seq)).toEqual([9]);
});

it("ignores malformed entries and bounds the list", () => {
  const bad = mergeLog(
    emptyLog(),
    {
      available: true,
      entries: [null, 5, { seq: "x" }, { seq: -1 }, entry(1)],
    },
    { replace: true },
  );
  expect(bad.entries).toHaveLength(1);
  const many = mergeLog(
    emptyLog(),
    {
      available: true,
      entries: Array.from({ length: KEEP + 50 }, (_, i) => entry(i + 1)),
    },
    { replace: true },
  );
  expect(many.entries).toHaveLength(KEEP);
  expect(many.entries[0]?.seq).toBe(51);
  const unavailable = mergeLog(
    emptyLog(),
    { available: false, entries: [] },
    {
      replace: true,
    },
  );
  expect(unavailable.available).toBe(false);
  expect(mergeLog(emptyLog(), null, { replace: true }).entries).toEqual([]);
});

it("builds the follow path and detects a reset log", () => {
  expect(logPath(emptyLog())).toBe("/api/control-log?limit=200");
  const model = { ...emptyLog(), cursor: 7 };
  expect(logPath(model)).toBe("/api/control-log?after=7&limit=200");
  expect(logWasReset(model, { latestSeq: 3 })).toBe(true);
  expect(logWasReset(model, { latestSeq: 7 })).toBe(false);
  expect(logWasReset(emptyLog(), { latestSeq: 0 })).toBe(false);
  expect(logWasReset(model, {})).toBe(false);
});

it("filters by outcome, issuer and lane, newest first", () => {
  const all = [
    entry(1),
    entry(2, {
      outcome: "stale",
      reason: "STALE_REVISION",
      issuer: "dashboard",
    }),
    entry(3, { lane: "worker", target: "worker", outcome: "refused" }),
    entry(4, { scope: "run", lane: null, target: "run-1", outcome: "applied" }),
  ];
  expect(filterEntries(all).map((e: { seq: number }) => e.seq)).toEqual([
    4, 3, 2, 1,
  ]);
  expect(
    filterEntries(all, { outcome: "stale" }).map((e: { seq: number }) => e.seq),
  ).toEqual([2]);
  expect(
    filterEntries(all, { issuer: "dashboard" }).map(
      (e: { seq: number }) => e.seq,
    ),
  ).toEqual([2]);
  expect(
    filterEntries(all, { lane: "worker" }).map((e: { seq: number }) => e.seq),
  ).toEqual([3]);
  expect(
    filterEntries(all, { lane: "builder", outcome: "applied" }).map(
      (e: { seq: number }) => e.seq,
    ),
  ).toEqual([1]);
  expect(filterEntries(all, { lane: "nobody" })).toEqual([]);
  expect(distinct(all, "issuer")).toEqual(["cli", "dashboard"]);
  expect(laneChoices(all)).toEqual(["builder", "worker"]);
});

it("counts outcomes and attention items, keeping unknown outcomes visible", () => {
  const counts = outcomeCounts([
    entry(1),
    entry(2, { outcome: "stale" }),
    entry(3, { outcome: "refused" }),
    entry(4, { outcome: "mystery" }),
  ]);
  expect(counts).toMatchObject({
    applied: 1,
    stale: 1,
    refused: 1,
    unknown: 1,
    attention: 3,
  });
});

it("says plainly that the log is bounded and when it is unavailable", () => {
  expect(
    retentionNote({ available: false, entries: [], retainedFrom: null }),
  ).toMatch(/could not be read/);
  expect(retentionNote({ available: true, entries: [] })).toBeNull();
  expect(
    retentionNote({ available: true, entries: [entry(5)], retainedFrom: 5 }),
  ).toMatch(/latest 200 commands; entries before #5 are no longer retained/);
  expect(
    retentionNote({ available: true, entries: [entry(1)], retainedFrom: 1 }),
  ).toMatch(/not a complete history/);
});
