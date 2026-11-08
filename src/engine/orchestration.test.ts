import { expect, it } from "vitest";
import type { snapshot } from "./dashboard.ts";
import { evaluateOrchestration } from "./orchestration.ts";
import type { Config, RecordState, State } from "./supervisor.ts";

type Board = Awaited<ReturnType<typeof snapshot>>;
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing synthetic fixture");
  return value;
}
const now = Date.parse("2026-11-08T00:00:00Z");
const config: Config = {
  version: 1,
  root: process.cwd(),
  binary: process.execPath,
  allowedTasks: ["P1-01", "P1-02", "P1-03"],
  maxParallel: 4,
  intervalSeconds: 1,
  maxRunMinutes: 1,
  maxRunsPerHour: 20,
  confirmedStoppedAt: new Date(now).toISOString(),
  lanes: {
    coordinator: { enabled: true },
    B: { enabled: true },
    C: { enabled: true },
    reviewer: { enabled: true },
    visual: { enabled: true },
  },
};
const state = (): State => ({
  version: 1,
  running: true,
  pid: 1,
  checkedAt: new Date(now).toISOString(),
  draining: false,
  held: [],
  commands: [],
  records: {},
  notices: {},
});
const task = (id: string, owner = "B", status = "assigned") => ({
  id,
  state: status === "ready" ? "review" : status,
  live: {
    task: id,
    assignment: {
      owner,
      baseCommit: "a".repeat(40),
      at: new Date(now - 100000).toISOString(),
      text: "fixture",
    },
    claim: null,
    status:
      status === "assigned"
        ? null
        : {
            state: status,
            commit: status === "ready" ? "b".repeat(40) : null,
            at: new Date(now - 50000).toISOString(),
            text: "fixture",
          },
    accepted: null,
  },
});
const board = (tasks: unknown[]): Board =>
  ({ tasks, messages: [], unanswered: [] }) as unknown as Board;
const message = (id: string, task: string, to = "B", kind = "request") => ({
  id,
  task,
  from: "coordinator",
  to,
  kind,
  replyTo: null,
  at: new Date(now - 20000).toISOString(),
  text: "Synthetic controlled request",
});
const remember = (
  s: State,
  w: NonNullable<ReturnType<typeof evaluateOrchestration>["work"][number]>,
  extra: Partial<RecordState> = {},
) => {
  s.records[w.key] = {
    key: w.key,
    lane: w.lane,
    task: w.task,
    cwd: process.cwd(),
    status: "idle",
    reason: "",
    seen: w.events,
    runs: [],
    finishedAt: new Date(now - 20000).toISOString(),
    noProgress: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...extra,
  };
};
it("starts an independent new assignment behind an older frozen submission and never consumes its messages in the wrong session", () => {
  const b = board([task("P1-01", "B", "ready"), task("P1-02")]);
  b.messages.push(message("new-only", "P1-02", "B", "answer"));
  const r = evaluateOrchestration(b, state(), config, now);
  const w = r.work.find((w) => w.lane === "B");
  expect(w?.task).toBe("P1-02");
  expect(w?.events).toContain("message:new-only");
  b.messages.push(message("old-fix", "P1-01"));
  b.unanswered.push(must(b.messages[1]));
  const revision = evaluateOrchestration(b, state(), config, now).work.find(
    (w) => w.lane === "B",
  );
  expect(revision?.task).toBe("P1-01");
  expect(revision?.events).not.toContain("message:new-only");
});
it("asks a working task to checkpoint before an older revision, then resumes the original task key without overlap", () => {
  const old = task("P1-01", "B", "ready");
  const current = task("P1-02", "B", "working");
  const b = board([old, current]);
  const request = message("old-fix", "P1-01");
  b.messages.push(request);
  b.unanswered.push(request);
  let r = evaluateOrchestration(b, state(), config, now);
  expect(r.work.find((w) => w.lane === "B")?.task).toBe("P1-02");
  expect(r.work.find((w) => w.lane === "B")?.reason).toContain(
    "safe checkpoint",
  );
  must(must(must(b.tasks[1]).live).status).state = "blocked";
  must(must(must(b.tasks[1]).live).status).checkpointed = true;
  r = evaluateOrchestration(b, state(), config, now);
  expect(r.work.find((w) => w.lane === "B")?.task).toBe("P1-01");
  const s = state();
  remember(s, must(r.work.find((w) => w.lane === "B")), {
    status: "running",
    pid: 1,
  });
  expect(
    evaluateOrchestration(b, s, config, now).work.some((w) => w.lane === "B"),
  ).toBe(false);
  b.unanswered = [];
  r = evaluateOrchestration(b, state(), config, now);
  expect(r.work.find((w) => w.lane === "B")?.task).toBe("P1-02");
});
it("wakes blocked authors only for a fresh task-specific coordinator answer", () => {
  const b = board([task("P1-01", "B", "blocked")]);
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  b.messages.push(message("unrelated", "P1-02", "B", "answer"));
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  b.messages.push(message("resolution", "P1-01", "B", "answer"));
  const s = state();
  const w = evaluateOrchestration(b, s, config, now).work.find(
    (w) => w.lane === "B",
  );
  expect(w?.task).toBe("P1-01");
  remember(s, must(w));
  expect(
    evaluateOrchestration(b, s, config, now).work.some((w) => w.lane === "B"),
  ).toBe(false);
});
it("sends one coordinator planning event per backlog/acceptance revision, without auto-authorizing backlog work", () => {
  const backlog = {
    id: "P2-03",
    state: "todo",
    documentedStatus: "queued",
    live: null,
  };
  const b = board([backlog]);
  const s = state();
  const r = evaluateOrchestration(b, s, config, now);
  expect(r.work.map((w) => w.lane)).toEqual(["coordinator"]);
  expect(r.planning?.taskIds).toEqual(["P2-03"]);
  remember(s, must(r.work[0]), { finalState: "ready" });
  expect(evaluateOrchestration(b, s, config, now).work).toEqual([]);
  const accepted = task("P1-01");
  const row = accepted as unknown as Board["tasks"][number];
  must(row.live).accepted = {
    commit: "c".repeat(40),
    at: new Date(now).toISOString(),
    text: "accepted",
  };
  b.tasks.push(row);
  expect(
    evaluateOrchestration(b, s, config, now).work.map((w) => w.lane),
  ).toEqual(["coordinator"]);
  s.held = ["coordinator"];
  expect(evaluateOrchestration(b, s, config, now).work).toEqual([]);
});
it("enforces explicit dependencies, deterministic priority and actual hourly budgets through composed scheduling", () => {
  const b = board([task("P1-01"), task("P1-02", "C")]);
  must(must(b.tasks[0]).live).scheduling = {
    version: 1,
    priority: "urgent-operational",
    dependsOn: [{ taskId: "P1-03", require: "accepted", commit: null }],
    reviewOf: null,
    enqueuedAt: now - 1000,
    updatedBy: "coordinator",
  };
  let r = evaluateOrchestration(b, state(), config, now);
  expect(r.queue.queue.find((q) => q.taskId === "P1-01")?.reason).toBe(
    "DEPENDENCY_MISSING",
  );
  expect(r.work.some((w) => w.lane === "C")).toBe(true);
  const dep = task("P1-03") as unknown as Board["tasks"][number];
  must(dep.live).accepted = {
    commit: "c".repeat(40),
    at: new Date(now).toISOString(),
    text: "accepted",
  };
  b.tasks.push(dep);
  r = evaluateOrchestration(b, state(), config, now);
  expect(r.work.map((w) => w.lane).indexOf("B")).toBeLessThan(
    r.work.map((w) => w.lane).indexOf("C"),
  );
  const s = state();
  remember(s, must(r.work.find((w) => w.lane === "B")), {
    runs: Array(20).fill(now),
  });
  r = evaluateOrchestration(b, s, config, now);
  expect(r.queue.queue.find((q) => q.taskId === "P1-01")?.reason).toBe(
    "RATE_LIMITED",
  );
});
it("preserves failure holds, honors fresh broadcasts and caps simultaneous native lanes", () => {
  const b = board([task("P1-01")]);
  const s = state();
  const w = must(
    evaluateOrchestration(b, s, config, now).work.find((w) => w.lane === "B"),
  );
  remember(s, w, { waitingForEvent: true });
  b.messages.push({
    ...message("broadcast", "P1-01"),
    to: "all",
    kind: "answer",
  });
  expect(
    evaluateOrchestration(b, s, config, now).work.some((w) => w.lane === "B"),
  ).toBe(true);
  must(s.records[w.key]).status = "paused";
  expect(
    evaluateOrchestration(b, s, config, now).work.some((w) => w.lane === "B"),
  ).toBe(false);
  must(s.records[w.key]).status = "running";
  must(s.records[w.key]).pid = 1;
  expect(
    evaluateOrchestration(b, s, { ...config, maxParallel: 1 }, now).work,
  ).toEqual([]);
});
it("rejects stale typed review pins but keeps legacy brief provenance explicitly unknown", () => {
  const b = board([task("P1-01", "B", "ready")]);
  const request = {
    ...message("review", "P1-01", "reviewer"),
    reviewCommit: "c".repeat(40),
  };
  b.messages.push(request);
  b.unanswered.push(request);
  expect(
    evaluateOrchestration(b, state(), config, now).queue.queue.find(
      (q) => q.lane === "reviewer",
    )?.reason,
  ).toBe("REVIEW_PIN_INVALID");
  delete (request as { reviewCommit?: string }).reviewCommit;
  const w = evaluateOrchestration(b, state(), config, now).work.find(
    (w) => w.lane === "reviewer",
  );
  expect(w?.reason).toContain("scheduler pin unavailable");
});

it("does not rerun a completed correction or let its stale request block the checkpointed task", () => {
  const b = board([task("P1-01", "B", "ready"), task("P1-02", "B", "blocked")]);
  must(must(must(b.tasks[1]).live).status).checkpointed = true;
  const request = message("fix", "P1-01");
  b.messages.push(request);
  b.unanswered.push(request);
  const s = state();
  const initial = evaluateOrchestration(b, s, config, now).work.find(
    (w) => w.task === "P1-01",
  );
  remember(s, must(initial), { finalState: "ready" });
  const next = evaluateOrchestration(b, s, config, now);
  expect(next.work.find((w) => w.lane === "B")?.task).toBe("P1-02");
  expect(next.work.some((w) => w.task === "P1-01")).toBe(false);
});
it("does not let fresh answers or urgent priority on a checkpoint bypass an outstanding original correction", () => {
  const b = board([task("P1-01", "B", "ready"), task("P1-02", "B", "blocked")]);
  must(must(must(b.tasks[1]).live).status).checkpointed = true;
  must(must(b.tasks[1]).live).scheduling = {
    version: 1,
    priority: "urgent-operational",
    dependsOn: [],
    reviewOf: null,
    enqueuedAt: now - 100000,
    updatedBy: "coordinator",
  };
  const request = message("fix", "P1-01");
  b.messages.push(request, message("fresh", "P1-02", "B", "answer"));
  b.unanswered.push(request);
  expect(
    evaluateOrchestration(b, state(), config, now).work.find(
      (w) => w.lane === "B",
    )?.task,
  ).toBe("P1-01");
});
it("legacy reviewers cannot consume the slot reserved for coordinator when coordinator has no pending turn", () => {
  const b = board([task("P1-01")]);
  const s = state();
  const initial = evaluateOrchestration(b, s, config, now);
  remember(s, must(initial.work.find((w) => w.lane === "coordinator")), {
    finalState: "ready",
  });
  // Three reviews share only two reviewer lanes and one author; with an extra author,
  // the fourth worker must wait even though legacy reviews have kind control.
  const request = message("review", "P1-01", "reviewer");
  b.messages.push(request);
  b.unanswered.push(request);
  b.tasks.push(task("P1-02", "C") as unknown as Board["tasks"][number]);
  s.records.external = {
    ...must(s.records["coordinator:control"]),
    key: "external",
    lane: "visual",
    task: "P1-03",
    status: "running",
    pid: 1,
  };
  const next = evaluateOrchestration(b, s, config, now);
  expect(next.work.length).toBe(2);
  expect(
    next.queue.queue.some((q) => q.reason === "COORDINATOR_RESERVED"),
  ).toBe(true);
});

it("serializes known overlapping delegated scopes across lanes and refuses overlap with an active writer", () => {
  const b = board([task("P1-01"), task("P1-02", "C")]);
  must(must(b.tasks[0]).live).scope = { version: 1, paths: ["scripts/shared"] };
  must(must(b.tasks[1]).live).scope = {
    version: 1,
    paths: ["scripts/shared/file.ts"],
  };
  const s = state();
  let r = evaluateOrchestration(b, s, config, now);
  expect(r.work.filter((w) => w.lane === "B" || w.lane === "C")).toHaveLength(
    1,
  );
  expect(r.queue.queue.some((q) => q.reason === "PATH_OVERLAP")).toBe(true);
  remember(s, must(r.work.find((w) => w.lane === "B")), {
    status: "running",
    pid: 1,
  });
  r = evaluateOrchestration(b, s, config, now);
  expect(r.work.some((w) => w.lane === "C")).toBe(false);
  expect(r.queue.queue.find((q) => q.taskId === "P1-02")?.reason).toBe(
    "PATH_OVERLAP",
  );
});
