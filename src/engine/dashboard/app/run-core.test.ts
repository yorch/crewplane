import { describe, expect, it } from "vitest";
import {
  comparable,
  compareRuns,
  downloadName,
  eventMatches,
  exportEvent,
  exportRun,
  filterEvents,
  firstErrorIndex,
  formatSpan,
  KIND_ORDER,
  kindCounts,
  MAX_EVENTS,
  toJson,
} from "./run-core.js";

const at = (n: number) =>
  new Date(Date.UTC(2026, 10, 1, 10, 0, n)).toISOString();
const ev = (
  sequence: number,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  sequence,
  at: at(sequence),
  kind,
  channel: "system",
  message: `message ${sequence}`,
  tool: null,
  status: null,
  model: null,
  effort: null,
  inputTokens: null,
  outputTokens: null,
  durationMs: null,
  sessionId: "SECRET-SESSION",
  runId: "run",
  lane: "builder",
  ...extra,
});
const run = [
  ev(1, "started"),
  ev(2, "tool-start", { tool: "bash" }),
  ev(3, "tool-finish", { tool: "bash", durationMs: 1200 }),
  ev(4, "usage", { inputTokens: 100, outputTokens: 20 }),
  ev(5, "error", { message: "Native run failed", status: "failed" }),
];

describe("filters and counts", () => {
  it("counts by type in the canonical order, unknown types last", () => {
    expect(kindCounts([...run, ev(6, "tool-start"), ev(7, "zzz")])).toEqual([
      ["started", 1],
      ["tool-start", 2],
      ["tool-finish", 1],
      ["usage", 1],
      ["error", 1],
      ["zzz", 1],
    ]);
    expect(kindCounts([])).toEqual([]);
    expect(KIND_ORDER[0]).toBe("started");
  });
  it("filters by chip and text with folding", () => {
    expect(
      filterEvents(run, new Set(["error"]), "").map(
        (e: { sequence: number }) => e.sequence,
      ),
    ).toEqual([5]);
    expect(
      filterEvents(run, new Set(), "BASH").map(
        (e: { sequence: number }) => e.sequence,
      ),
    ).toEqual([2, 3]);
    expect(
      filterEvents(run, new Set(["tool-start"]), "bash").map(
        (e: { sequence: number }) => e.sequence,
      ),
    ).toEqual([2]);
    expect(
      filterEvents(run, new Set(), "message 4 usage").map(
        (e: { sequence: number }) => e.sequence,
      ),
    ).toEqual([4]);
    expect(filterEvents(run, new Set(), "nothing like this")).toEqual([]);
    expect(filterEvents(run, new Set(), "   ")).toHaveLength(5);
    expect(
      eventMatches(ev(9, "usage", { message: "Café" }), new Set(), "cafe"),
    ).toBe(true);
  });
  it("treats hostile search text as plain text", () => {
    for (const query of [
      "(",
      "[a-",
      ".*",
      "\\",
      "<script>",
      "__proto__",
      "x".repeat(10_000),
    ])
      expect(() => filterEvents(run, new Set(), query)).not.toThrow();
    expect(filterEvents(run, new Set(), ".*")).toEqual([]);
  });
  it("finds the first error by kind or failed status", () => {
    expect(firstErrorIndex(run)).toBe(4);
    expect(
      firstErrorIndex([
        ev(1, "started"),
        ev(2, "finished", { status: "failed" }),
      ]),
    ).toBe(1);
    expect(firstErrorIndex([ev(1, "started")])).toBe(-1);
    expect(firstErrorIndex([])).toBe(-1);
  });
});

describe("export", () => {
  it("rebuilds each event from the displayed fields only", () => {
    const out = exportEvent(run[2]);
    expect(Object.keys(out).sort()).toEqual(
      [
        "at",
        "channel",
        "durationMs",
        "effort",
        "inputTokens",
        "kind",
        "message",
        "model",
        "outputTokens",
        "sequence",
        "status",
        "tool",
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
  it("includes only what was passed, bounded, with no session or storage detail", () => {
    const meta = {
      runId: "1700000000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      lane: "builder",
      task: "CP-1",
      harness: "claude",
      status: "failed",
      finalState: null,
      sessionId: "SECRET",
      bytes: 99,
    };
    const json = toJson(meta, run);
    const parsed = JSON.parse(json);
    expect(parsed.events).toHaveLength(5);
    expect(parsed).toMatchObject({ lane: "builder", exportedEvents: 5 });
    expect(json).not.toMatch(/SECRET|bytes/);
    const many = Array.from({ length: 900 }, (_, i) => ev(i, "assistant"));
    expect(exportRun(meta, many).events).toHaveLength(MAX_EVENTS);
    expect(exportRun(meta, many).events[0]?.sequence).toBe(400);
  });
  it("records an active filter and drops hostile types of values", () => {
    const parsed = exportRun(
      { runId: 1 },
      [ev(1, "started", { message: { x: 1 }, inputTokens: "7" })],
      { kinds: new Set(["started"]), query: "q" },
    );
    expect(parsed.filter).toEqual({ types: ["started"], query: "q" });
    expect(parsed.runId).toBeNull();
    expect(parsed.events[0]).toMatchObject({
      message: null,
      inputTokens: null,
    });
  });
  it("names the download from a fixed pattern", () => {
    const id = "1700000000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(downloadName(id)).toBe(`crewplane-run-${id}.json`);
    for (const bad of [
      "../../etc/passwd",
      "a b",
      "",
      null,
      undefined,
      "x".repeat(300),
    ])
      expect(downloadName(bad)).toBe("crewplane-run-unknown.json");
  });
});

describe("comparison", () => {
  const other = [
    ev(1, "started"),
    ev(2, "tool-start", { tool: "grep" }),
    ev(3, "assistant"),
    ev(4, "usage", { inputTokens: 40, outputTokens: 5 }),
    ev(5, "finished"),
    ev(6, "finished"),
  ];
  it("totals, counts per type and aligns by position", () => {
    const result = compareRuns(run, other);
    expect(result.total.a).toMatchObject({
      events: 5,
      errors: 1,
      inputTokens: 100,
      outputTokens: 20,
      toolMs: 1200,
      spanMs: 4000,
    });
    expect(result.total.b).toMatchObject({
      events: 6,
      errors: 0,
      inputTokens: 40,
      spanMs: 5000,
    });
    expect(result.byKind.find((r) => r.kind === "error")).toEqual({
      kind: "error",
      a: 1,
      b: 0,
      diff: -1,
    });
    expect(result.byKind.find((r) => r.kind === "finished")).toEqual({
      kind: "finished",
      a: 0,
      b: 2,
      diff: 2,
    });
    expect(result.rows).toHaveLength(6);
    expect(result.rows[0]).toMatchObject({ index: 0, same: true });
    expect(result.rows[2]).toMatchObject({
      same: false,
      a: "tool-finish · bash",
      b: "assistant",
    });
    expect(result.rows[5]).toMatchObject({ a: "", b: "finished", same: false });
    expect(result.firstDifference).toBe(2);
  });
  it("reports identical runs and empty runs", () => {
    expect(compareRuns(run, run).firstDifference).toBe(-1);
    const empty = compareRuns([], []);
    expect(empty.rows).toEqual([]);
    expect(empty.total.a.spanMs).toBeNull();
  });
  it("is bounded to 500 events each", () => {
    const big = Array.from({ length: 800 }, (_, i) => ev(i, "assistant"));
    const result = compareRuns(big, big);
    expect(result.rows).toHaveLength(MAX_EVENTS);
    expect(result.total.a.events).toBe(MAX_EVENTS);
  });
  it("offers runs of the same task or agent, newest first", () => {
    const runs = [
      { runId: "3", lane: "a", task: "T" },
      { runId: "1", lane: "a", task: "U" },
      { runId: "2", lane: "b", task: "T" },
      { runId: "4", lane: "c", task: "Z" },
    ];
    expect(
      comparable({ runId: "9", lane: "a", task: "T" }, runs).map(
        (r) => r.runId,
      ),
    ).toEqual(["3", "2", "1"]);
    expect(
      comparable({ runId: "3", lane: "a", task: null }, runs).map(
        (r) => r.runId,
      ),
    ).toEqual(["1"]);
    expect(comparable(null, runs)).toEqual([]);
  });
  it("formats spans", () => {
    expect(formatSpan(null)).toBe("not recorded");
    expect(formatSpan(340)).toBe("340 ms");
    expect(formatSpan(1200)).toBe("1.2 s");
    expect(formatSpan(125000)).toBe("2 min 5 s");
    expect(formatSpan(-1500)).toBe("-1.5 s");
    expect(formatSpan(Number.NaN)).toBe("not recorded");
  });
});
