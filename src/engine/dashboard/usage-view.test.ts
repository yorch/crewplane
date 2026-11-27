import { expect, it } from "vitest";
import type { Config, State } from "../../contracts.ts";
import { usageView } from "./usage-view.ts";

const hour = 3600000;
const now = Date.parse("2026-11-08T12:30:00Z");
const at = (hoursAgo: number, extra = 0) =>
  new Date(
    Math.floor(now / hour) * hour - hoursAgo * hour + extra,
  ).toISOString();

it("marks buckets outside retained trace history as null and covered ones as measured counts", () => {
  const view = usageView(
    null,
    null,
    {
      runs: [
        { lane: "a", startedAt: at(2, 60000) },
        { lane: "b", startedAt: at(2, 120000) },
        { lane: "a", startedAt: at(0, 60000) },
      ],
      retentionLimited: true,
      incomplete: false,
    },
    now,
  );
  const total = view.total.series;
  expect(total).toHaveLength(24);
  // The bucket holding the oldest retained run is only partly covered: unknown.
  expect(total.slice(0, 22).every((v) => v === null)).toBe(true);
  expect(total[21]).toBeNull();
  expect(total[22]).toBe(0); // newer than the oldest retained run: a measured zero
  expect(total[23]).toBe(1);
  expect(view.coverage.series).toMatchObject({
    retentionLimited: true,
    complete: false,
    retainedRuns: 3,
  });
});

it("reports a bucket as measured only when some retained run is older than it", () => {
  // A store with no run yet (a new install, or no store at all) predates every
  // bucket: nothing is measured, in particular no zero.
  const empty = usageView(
    null,
    null,
    { runs: [], retentionLimited: false, incomplete: false },
    now,
  );
  expect(empty.total.series.every((v) => v === null)).toBe(true);
  expect(empty.coverage.series).toMatchObject({
    state: "available",
    complete: false,
    oldestRetainedAt: null,
  });
  // Without pruning, buckets from the one after the oldest run onward count.
  const some = usageView(
    null,
    null,
    {
      runs: [
        { lane: "a", startedAt: at(5, 60000) },
        { lane: "a", startedAt: at(1, 60000) },
      ],
      retentionLimited: false,
      incomplete: false,
    },
    now,
  );
  const series = some.total.series;
  expect(series.slice(0, 19).every((v) => v === null)).toBe(true);
  expect(series[18]).toBeNull(); // holds the oldest run: its earlier part is unknown
  expect(series.slice(19, 22)).toEqual([0, 0, 0]);
  expect(series[22]).toBe(1);
  expect(series[23]).toBe(0);
  expect(some.coverage.series.complete).toBe(false);
  // A history older than the whole window is complete.
  const old = usageView(
    null,
    null,
    {
      runs: [{ lane: "a", startedAt: at(40) }],
      retentionLimited: false,
      incomplete: false,
    },
    now,
  );
  expect(old.total.series.every((v) => v === 0)).toBe(true);
  expect(old.coverage.series.complete).toBe(true);
  const unreadable = usageView(null, null, null, now);
  expect(unreadable.total.series.every((v) => v === null)).toBe(true);
  expect(unreadable.coverage.series).toMatchObject({
    state: "unavailable",
    complete: false,
  });
  const partial = usageView(
    null,
    null,
    {
      runs: [{ lane: "a", startedAt: at(40) }],
      retentionLimited: false,
      incomplete: true,
    },
    now,
  );
  expect(partial.total.series.every((v) => v === null)).toBe(true);
});

const stateWith = (scheduling: unknown, records: unknown = {}) =>
  ({
    version: 2,
    running: true,
    scheduling,
    records,
  }) as unknown as State;

it("takes every cap from the installed configuration and shows the loaded values beside it", () => {
  const state = stateWith({
    maxRunsPerHour: 8,
    maxRunMinutes: 15,
    maxParallel: 1,
    fingerprint: "x",
  });
  const config = {
    lanes: {
      a: { enabled: true, maxRunsPerHour: 0 },
      b: { enabled: true, maxRunsPerHour: 3, maxRunMinutes: 4 },
    },
    maxRunsPerHour: 99,
    maxRunMinutes: 60,
  } as unknown as Config;
  const view = usageView(state, config, null, now);
  expect(view.caps).toEqual({
    source: "configured",
    perLaneDefault: { maxRunsPerHour: 99, maxRunMinutes: 60 },
    loaded: { maxRunsPerHour: 8, maxRunMinutes: 15 },
    loadedDiffers: true,
  });
  // The old, misleading name for a per-lane default is gone.
  expect(view.total).not.toHaveProperty("maxRunsPerHour");
  const lane = (id: string) => view.lanes.find((l) => l.lane === id);
  // Not 8 or 15: the loaded numbers are never mixed into the effective ones.
  expect(lane("a")?.runs).toMatchObject({ cap: 99, capSource: "default" });
  expect(lane("a")?.durations.maxRunMinutes).toBe(60);
  expect(lane("b")?.runs).toMatchObject({ cap: 3, capSource: "lane" });
  expect(lane("b")?.durations.maxRunMinutes).toBe(4);
});

it("falls back to the loaded values only as the sole source, with no lane-own caps", () => {
  const state = stateWith(
    { maxRunsPerHour: 8, maxRunMinutes: 15, fingerprint: "x" },
    { r: { key: "r", lane: "a", status: "idle", runs: [now - 1000] } },
  );
  const view = usageView(state, null, null, now);
  expect(view.caps).toMatchObject({
    source: "loaded",
    perLaneDefault: { maxRunsPerHour: 8, maxRunMinutes: 15 },
    loadedDiffers: null,
  });
  expect(view.lanes[0]?.runs).toMatchObject({
    lastHour: 1,
    cap: 8,
    capSource: "default",
  });
  // A readable configuration without a usable default does not borrow one.
  const config = { lanes: { a: { enabled: true } } } as unknown as Config;
  const none = usageView(state, config, null, now);
  expect(none.caps.source).toBe("configured");
  expect(none.caps.perLaneDefault).toEqual({
    maxRunsPerHour: null,
    maxRunMinutes: null,
  });
  expect(none.lanes[0]?.runs).toMatchObject({ cap: null, capSource: null });
  expect(usageView(null, null, null, now).caps).toMatchObject({
    source: null,
    perLaneDefault: null,
  });
});

it("ignores invalid numbers and counts only records with a usable counter as reporting", () => {
  const state = stateWith(undefined, {
    r: {
      key: "r",
      lane: "a",
      task: "T-1",
      status: "idle",
      runs: [now - 1000, "x", -5],
      startedAt: at(1),
      finishedAt: at(2),
      inputTokensKnown: true,
      inputTokens: -3,
      outputTokensKnown: true,
      outputTokens: "7",
      reportedCostUsd: Number.NaN,
      costKnown: true,
    },
    s: {
      key: "s",
      lane: "a",
      task: "T-2",
      status: "idle",
      runs: [],
      inputTokensKnown: true,
      inputTokens: 40,
      outputTokensKnown: true,
      outputTokens: 5,
    },
  });
  const config = { lanes: { a: { enabled: true } } } as unknown as Config;
  const lane = usageView(state, config, null, now).lanes[0];
  expect(lane?.runs.lastHour).toBe(1);
  // finishedAt before startedAt is not a duration; negative counters are unknown.
  expect(lane?.durations.recent).toEqual([]);
  expect(lane?.cost.recent).toEqual([]);
  expect(lane?.tokens).toMatchObject({
    input: 40,
    output: 5,
    recordsReportingInput: 1,
    recordsReportingOutput: 1,
    retainedRecords: 2,
  });
});
