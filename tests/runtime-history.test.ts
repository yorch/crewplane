import { expect, it } from "vitest";
import type { Config, RecordState, State } from "../src/contracts.ts";
import { evaluateOrchestration } from "../src/engine/orchestration.ts";
import { compactHistory } from "../src/engine/supervisor.ts";

const now = Date.parse("2026-11-08T12:00:00Z");
const record = (lane: string, run: number): RecordState => ({
  key: `${lane}:resolved-${run}`,
  lane,
  task: `resolved-${lane}-${run}`,
  cwd: "/synthetic/checkout",
  sessionId: "00000000-0000-4000-8000-000000000001",
  status: run % 2 ? "paused" : "idle",
  reason: "Synthetic terminal history",
  seen: [],
  runs: [now - 1000],
  finishedAt: new Date(now - run).toISOString(),
  noProgress: 0,
  inputTokens: 0,
  outputTokens: 0,
});
function state(): State {
  return {
    version: 1,
    running: true,
    pid: 1,
    checkedAt: "",
    draining: false,
    held: [],
    commands: [],
    records: {},
    notices: {},
  };
}
it("bounds terminal history from 64 full-budget lanes and preserves same-millisecond run counts", () => {
  const value = state();
  for (let lane = 0; lane < 64; lane++)
    for (let run = 0; run < 60; run++) {
      const item = record(`lane${lane}`, run);
      value.records[item.key] = item;
    }
  const config: Config = {
    version: 1,
    coordinator: "lane0",
    reviewers: [],
    root: "/synthetic",
    binary: process.execPath,
    allowedTasks: [],
    maxParallel: 4,
    intervalSeconds: 1,
    maxRunMinutes: 1,
    maxRunsPerHour: 60,
    confirmedStoppedAt: new Date(now).toISOString(),
    lanes: { lane0: { enabled: true } },
  };
  const board = {
    tasks: [],
    messages: [],
    unanswered: [],
  } as unknown as Parameters<typeof evaluateOrchestration>[0];
  value.notices.lane0 = ["Synthetic budget check"];
  const refusal = () =>
    evaluateOrchestration(board, value, config, now).queue.queue.find(
      (row) => row.lane === "lane0",
    )?.reason;
  expect(refusal()).toBe("RATE_LIMITED");
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1_000_000);
  compactHistory(value, new Set(), now);
  expect(Object.keys(value.records)).toHaveLength(100);
  expect(refusal()).toBe("RATE_LIMITED");
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(150_000);
  for (let lane = 0; lane < 64; lane++) {
    const id = `lane${lane}`;
    const retained = Object.values(value.records)
      .filter((item) => item.lane === id)
      .flatMap((item) => item.runs);
    expect(retained.length + (value.retiredRuns?.[id]?.length ?? 0)).toBe(60);
  }
  const once = JSON.stringify(value);
  compactHistory(value, new Set(), now);
  expect(JSON.stringify(value)).toBe(once);
  compactHistory(value, new Set(), now + 3600000);
  expect(value.retiredRuns).toEqual({});
});
it("preserves unresolved failures, cleanup flags, live ownership and null-task controls", () => {
  const value = state();
  for (let run = 0; run < 120; run++) {
    const item = record("worker", run);
    value.records[item.key] = item;
  }
  const unresolved = record("unresolved", 0);
  const pid = { ...record("pid", 0), pid: 42 };
  const group = { ...record("group", 0), processGroupId: 43 };
  const cleanup = { ...record("cleanup", 0), cleanupUnverified: true };
  const running = { ...record("running", 0), status: "running" as const };
  const control = { ...record("captain", 0), task: null };
  for (const item of [unresolved, pid, group, cleanup, running, control])
    value.records[item.key] = item;
  compactHistory(value, new Set([unresolved.task ?? ""]), now);
  for (const item of [unresolved, pid, group, cleanup, running, control])
    expect(value.records[item.key]).toEqual(item);
  expect(Object.keys(value.records)).toHaveLength(106);
});
