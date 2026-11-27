import { expect, it } from "vitest";
import {
  capsNotice,
  chartLabel,
  chartModel,
  costFacts,
  coverageNotes,
  durationRows,
  hourLabel,
  laneMeter,
  niceMax,
  seriesRows,
  tokenFacts,
} from "./usage-core.js";

const starts = Array.from({ length: 24 }, (_, i) =>
  new Date(Date.UTC(2026, 10, 1, i)).toISOString(),
);

it("builds a meter from runs against the cap with text that does not depend on colour", () => {
  const meter = laneMeter({
    runs: { lastHour: 3, cap: 6, capSource: "lane", remaining: 3 },
  });
  expect(meter).toMatchObject({
    used: 3,
    cap: 6,
    level: "ok",
    percent: 50,
    remaining: 3,
    source: "this agent's own cap",
    text: "3 of 6 runs this hour.",
  });
  expect(meter.meter).toEqual({
    min: 0,
    max: 6,
    value: 3,
    low: 4.8,
    high: 5.99,
    optimum: 0,
  });
  expect(
    laneMeter({ runs: { lastHour: 6, cap: 6, capSource: "default" } }),
  ).toMatchObject({
    level: "full",
    text: "6 of 6 runs this hour (at the cap).",
    source: "the per-agent default cap",
  });
  const over = laneMeter({ runs: { lastHour: 9, cap: 6 } });
  expect(over.level).toBe("over");
  expect(over.text).toMatch(/over the cap/);
  expect(over.meter?.value).toBe(6);
});

it("never turns unknown usage into zero", () => {
  expect(laneMeter({ runs: { lastHour: null, cap: 6 } })).toMatchObject({
    used: null,
    level: "unknown",
    meter: null,
    text: "Runs this hour: not recorded. Cap 6 per hour.",
  });
  expect(laneMeter({ runs: { lastHour: 2, cap: null } })).toMatchObject({
    cap: null,
    meter: null,
    text: "2 runs this hour. No cap known.",
  });
  expect(laneMeter({ runs: { lastHour: 1, cap: null } }).text).toBe(
    "1 run this hour. No cap known.",
  );
  expect(laneMeter({}).text).toBe(
    "Runs this hour: not recorded. No cap known.",
  );
  expect(laneMeter({ runs: { lastHour: 0, cap: 6 } }).used).toBe(0);
});

it("lists recent durations and flags those over the run limit", () => {
  const rows = durationRows({
    durations: {
      maxRunMinutes: 10,
      recent: [
        { task: "CP-1", durationMs: 125000, status: "idle" },
        { task: null, durationMs: 700000, status: null },
        { task: "CP-3", durationMs: null },
      ],
    },
  });
  expect(rows.map((r: Record<string, unknown>) => r.duration)).toEqual([
    "2m 05s",
    "11m 40s",
    null,
  ]);
  expect(rows.map((r: Record<string, unknown>) => r.overLimit)).toEqual([
    false,
    true,
    null,
  ]);
  expect(
    durationRows({
      durations: { maxRunMinutes: null, recent: [{ durationMs: 5 }] },
    })[0]?.overLimit,
  ).toBeNull();
  expect(durationRows({})).toEqual([]);
});

it("reports token counters with how many records reported them", () => {
  expect(
    tokenFacts({
      input: 1200,
      output: null,
      recordsReportingInput: 2,
      recordsReportingOutput: 0,
      retainedRecords: 3,
    }),
  ).toEqual({
    input: { value: "1,200", coverage: "2 of 3 retained records reported it" },
    output: { value: null, coverage: "0 of 3 retained records reported it" },
  });
  expect(tokenFacts(undefined).input).toEqual({ value: null, coverage: null });
  expect(
    tokenFacts({ retainedRecords: 1, recordsReportingInput: 1 }).input.coverage,
  ).toBe("1 of 1 retained record reported it");
});

it("reads cost against the per-run cap, three-valued", () => {
  const facts = costFacts({
    maxCostUsdPerRun: 1,
    maxObservedUsd: 1.5,
    anyOverCap: true,
    recent: [
      { task: "A", at: "x", costUsd: 1.5, overCap: true },
      { task: "B", at: "y", costUsd: 0.25, overCap: false },
      { task: "C", at: "z", costUsd: 0.1, overCap: null },
    ],
  });
  expect(facts).toMatchObject({
    cap: "$1.00",
    maxObserved: "$1.50",
    anyOverCap: true,
    hasData: true,
  });
  expect(facts.rows.map((r: Record<string, unknown>) => r.overCap)).toEqual([
    true,
    false,
    null,
  ]);
  expect(costFacts({ recent: [], anyOverCap: null })).toMatchObject({
    cap: null,
    maxObserved: null,
    anyOverCap: null,
    hasData: false,
  });
});

it("picks whole-number y-axis maxima from a short ladder", () => {
  expect(
    [0, 1, 4, 5, 8, 9, 10, 11, 20, 21, 41, 51, 101, 450].map(niceMax),
  ).toEqual([4, 4, 4, 8, 8, 10, 10, 20, 20, 40, 50, 100, 200, 500]);
  expect(niceMax(null as unknown as number)).toBe(4);
  expect(niceMax(-3)).toBe(4);
  for (const v of [4, 8, 10, 20, 40, 50, 100, 200, 400, 500])
    expect(Number.isInteger(niceMax(v) / 2)).toBe(true);
});

it("turns a series into bar geometry and keeps unknown hours out of the bars", () => {
  const series = Array.from({ length: 24 }, () => null) as Array<number | null>;
  series[20] = 0;
  series[21] = 3;
  series[22] = 6;
  series[23] = 2;
  const model = chartModel(series, starts);
  expect(model.bars).toHaveLength(24);
  expect(model.max).toBe(8);
  expect(model.measured).toBe(4);
  expect(model.unknown).toBe(20);
  expect(model.total).toBe(11);
  expect(model.peak?.index).toBe(22);
  expect(model.allUnknown).toBe(false);
  const unknown = model.bars[0];
  expect(unknown).toMatchObject({ known: false, value: null, height: 0 });
  const zero = model.bars[20];
  expect(zero).toMatchObject({ known: true, value: 0, height: 0 });
  const six = model.bars[22];
  expect(six?.height).toBeCloseTo((6 / 8) * model.plotH, 5);
  expect((six?.y ?? 0) + (six?.height ?? 0)).toBeCloseTo(model.baseline, 5);
  for (const bar of model.bars) {
    expect(bar.width).toBeLessThanOrEqual(24);
    expect(bar.x).toBeGreaterThanOrEqual(model.left);
    expect(bar.x + bar.width).toBeLessThanOrEqual(
      model.left + model.plotW + 0.001,
    );
  }
  expect(model.ticks.map((t) => t.value)).toEqual([0, 4, 8]);
  expect(model.ticks[0]?.y).toBe(model.baseline);
});

it("handles an all-unknown, empty and malformed series", () => {
  const unknown = chartModel(
    Array.from({ length: 24 }, () => null),
    starts,
  );
  expect(unknown.allUnknown).toBe(true);
  expect(unknown.total).toBeNull();
  expect(unknown.peak).toBeNull();
  expect(chartLabel(unknown, "Runs per hour")).toMatch(
    /not recorded for any of the last 24 hours/,
  );
  expect(chartModel(undefined, undefined).bars).toEqual([]);
  expect(chartLabel(chartModel([], []), "Runs")).toBe("Runs: no data.");
  const odd = chartModel(
    [1, -2, "x", Number.NaN] as unknown as number[],
    starts,
  );
  expect(odd.bars.map((b) => b.known)).toEqual([true, false, false, false]);
});

it("describes the chart in one accessible sentence", () => {
  const series = Array.from({ length: 24 }, () => null) as Array<number | null>;
  series[22] = 6;
  series[23] = 2;
  const label = chartLabel(chartModel(series, starts), "Runs per hour");
  expect(label).toMatch(
    /^Runs per hour, last 24 hours: 8 runs in 2 recorded hours;/,
  );
  expect(label).toMatch(/busiest hour \d\d:00 with 6/);
  expect(label).toMatch(/22 hours not recorded\.$/);
});

it("gives the table alternative the same values, with null kept as null", () => {
  const rows = seriesRows([null, 0, 4], starts);
  expect(rows.map((r: Record<string, unknown>) => r.value)).toEqual([
    null,
    0,
    4,
  ]);
  expect(rows[0]?.start).toBe(starts[0]);
  expect(hourLabel("not a date")).toBe("");
  expect(hourLabel(starts[0])).toMatch(/^\d\d:00$/);
  expect(seriesRows(undefined, undefined)).toEqual([]);
});

it("explains where caps come from and when the loaded values differ", () => {
  expect(capsNotice(null)[0]).toMatch(/No caps are known/);
  expect(capsNotice({ source: null })[0]).toMatch(/No caps are known/);
  const configured = capsNotice({
    source: "configured",
    perLaneDefault: { maxRunsPerHour: 6, maxRunMinutes: 10 },
    loaded: { maxRunsPerHour: 4, maxRunMinutes: 10 },
    loadedDiffers: true,
  });
  expect(configured.join(" ")).toMatch(/installed configuration/);
  expect(configured.join(" ")).toMatch(/6 runs per hour for each agent/);
  expect(configured.join(" ")).toMatch(/not a total across agents/);
  expect(configured.join(" ")).toMatch(/different caps \(4 runs per hour/);
  expect(
    capsNotice({
      source: "configured",
      perLaneDefault: { maxRunsPerHour: 6, maxRunMinutes: 10 },
      loadedDiffers: false,
    }).join(" "),
  ).toMatch(/match what the running supervisor loaded/);
  expect(
    capsNotice({
      source: "configured",
      perLaneDefault: { maxRunsPerHour: 6, maxRunMinutes: null },
      loadedDiffers: null,
    }).join(" "),
  ).toMatch(/loaded is unknown/);
  expect(
    capsNotice({
      source: "loaded",
      perLaneDefault: { maxRunsPerHour: 6, maxRunMinutes: 10 },
    })[0],
  ).toMatch(/could not be read.*Per-agent caps are unknown/);
});

it("states coverage honestly", () => {
  const complete = coverageNotes({
    counters: { state: "available", retainedRecords: 3 },
    series: { state: "available", complete: true },
    ledger: { connected: false },
  });
  expect(complete[0]?.text).toMatch(/3 retained supervisor records/);
  expect(complete[0]?.text).toMatch(
    /not lifetime totals and not billing totals/,
  );
  expect(complete[1]?.text).toMatch(/All 24 hours are covered/);
  expect(complete[3]?.text).toMatch(/Not connected/);
  const gaps = coverageNotes({
    counters: { state: "unavailable" },
    series: { state: "available", complete: false, retainedRuns: 0 },
  });
  expect(gaps[0]?.text).toMatch(/could not be read/);
  expect(gaps[1]?.text).toMatch(/never as zero.*No run has been recorded/);
  expect(
    coverageNotes({
      series: { complete: false, retentionLimited: true, retainedRuns: 5 },
    })[1]?.text,
  ).toMatch(/pruned/);
  expect(
    coverageNotes({
      series: { complete: false, incomplete: true, retainedRuns: 5 },
    })[1]?.text,
  ).toMatch(/could not be read/);
  expect(coverageNotes({ series: { state: "unavailable" } })[1]?.text).toMatch(
    /could not be read/,
  );
  expect(coverageNotes(undefined)[3]?.text).toMatch(/not reported/);
});
