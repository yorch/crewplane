import { expect, it } from "vitest";
import { loadedScheduling, schedulingReason } from "./scheduling.ts";
import type { Config, State } from "./supervisor.ts";

const cfg: Config = {
  version: 1,
  root: "/synthetic",
  binary: "/synthetic/codex",
  allowedTasks: ["P0-20"],
  maxParallel: 4,
  intervalSeconds: 10,
  maxRunMinutes: 25,
  maxRunsPerHour: 20,
  confirmedStoppedAt: "2026-11-08T00:00:00Z",
  lanes: { F: { enabled: true } },
};
const now = Date.parse("2026-11-08T02:00:00Z");
const state = (): State => ({
  version: 1,
  running: true,
  checkedAt: new Date(now).toISOString(),
  pid: 1,
  draining: false,
  held: [],
  commands: [],
  records: {},
  notices: {},
  scheduling: loadedScheduling(cfg),
});
const task = { id: "P0-20", owner: "F", state: "assigned" };
it("distinguishes assignment from queue/capacity/explicit holds or dependency blocks", () => {
  const s = state();
  expect(schedulingReason(task, s, cfg, now).code).toBe("queued");
  s.held = ["F"];
  expect(schedulingReason(task, s, cfg, now).code).toBe("paused");
  s.held = [];
  expect(
    schedulingReason({ ...task, state: "blocked" }, s, cfg, now).code,
  ).toBe("dependency-blocked");
  for (const [i, lane] of ["coordinator", "B", "D", "E"].entries())
    s.records[String(i)] = {
      key: String(i),
      lane: lane as "coordinator",
      task: null,
      cwd: "/synthetic",
      status: "running",
      reason: "",
      seen: [],
      runs: [],
      noProgress: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  expect(schedulingReason(task, s, cfg, now).code).toBe("waiting-capacity");
  expect(schedulingReason(task, s, cfg, now + 60000).code).toBe("unknown");
});
it("never treats on-disk config as loaded or PID as productive work", () => {
  const s = state();
  delete s.scheduling;
  expect(schedulingReason(task, s, cfg, now).code).toBe("unknown");
  s.scheduling = loadedScheduling({ ...cfg, allowedTasks: [] });
  expect(schedulingReason(task, s, cfg, now).code).toBe("reload-required");
  expect(
    schedulingReason(task, s, { ...cfg, allowedTasks: [] }, now).code,
  ).toBe("unsupported");
  s.scheduling = loadedScheduling({ ...cfg, lanes: { F: { enabled: false } } });
  expect(schedulingReason(task, s, cfg, now).code).toBe("reload-required");
  s.scheduling = loadedScheduling(cfg);
  s.records.f = {
    key: "f",
    lane: "F",
    task: "P0-20",
    cwd: "/synthetic",
    status: "running",
    reason: "",
    seen: [],
    runs: [],
    noProgress: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const r = schedulingReason(task, s, cfg, now);
  expect(r.code).toBe("scheduled");
  expect(r.label).toContain("productive work is not inferred");
});

it("canonicalizes equivalent config order and distinguishes submitted work from unscheduled execution", () => {
  const a = { ...cfg, allowedTasks: ["P0-20", "P1-01"] };
  const b = { ...cfg, allowedTasks: ["P1-01", "P0-20"] };
  expect(loadedScheduling(a).fingerprint).toBe(loadedScheduling(b).fingerprint);
  expect(
    schedulingReason({ ...task, state: "review" }, state(), cfg, now).code,
  ).toBe("coordinator-disposition");
  const s = state();
  s.queue = {
    version: 1,
    evaluatedAt: now,
    selected: [],
    queue: [
      {
        key: "F:task",
        lane: "F",
        taskId: "P0-20",
        status: "blocked",
        reason: "RATE_LIMITED",
        position: null,
        dependencyIds: [],
        components: {
          priority: 2,
          aging: 0,
          unblocks: 0,
          review: false,
          enqueue: now,
        },
      },
    ],
  };
  expect(schedulingReason(task, s, cfg, now).code).toBe("rate-limited");
  s.running = false;
  expect(schedulingReason(task, s, cfg, now).code).toBe("draining");
});
