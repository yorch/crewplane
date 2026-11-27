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

it("reports every bucket measured only when nothing was pruned, and none when traces are unreadable", () => {
  const complete = usageView(
    null,
    null,
    { runs: [], retentionLimited: false, incomplete: false },
    now,
  );
  expect(complete.total.series.every((v) => v === 0)).toBe(true);
  expect(complete.coverage.series.complete).toBe(true);
  const unreadable = usageView(null, null, null, now);
  expect(unreadable.total.series.every((v) => v === null)).toBe(true);
  expect(unreadable.coverage.series).toMatchObject({
    state: "unavailable",
    complete: false,
  });
  const partial = usageView(
    null,
    null,
    { runs: [], retentionLimited: false, incomplete: true },
    now,
  );
  expect(partial.total.series.every((v) => v === null)).toBe(true);
});

it("takes the cap from the loaded scheduling, then the lane, and ignores invalid numbers", () => {
  const state = {
    version: 2,
    running: true,
    scheduling: {
      maxRunsPerHour: 8,
      maxRunMinutes: 15,
      maxParallel: 1,
      fingerprint: "x",
    },
    records: {
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
        reportedCostUsd: Number.NaN,
        costKnown: true,
      },
    },
  } as unknown as State;
  const config = {
    lanes: { a: { enabled: true, maxRunsPerHour: 0 } },
    maxRunsPerHour: 99,
  } as unknown as Config;
  const view = usageView(state, config, null, now);
  const lane = view.lanes[0];
  expect(lane?.runs).toMatchObject({
    lastHour: 1,
    cap: 8,
    capSource: "global",
  });
  // finishedAt before startedAt is not a duration; negative counters are unknown.
  expect(lane?.durations.recent).toEqual([]);
  expect(lane?.tokens.input).toBeNull();
  expect(lane?.cost.recent).toEqual([]);
});
