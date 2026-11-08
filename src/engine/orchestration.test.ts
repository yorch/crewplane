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
  assignmentId: new Date(now - 100000).toISOString(),
  reviewCommit: "b".repeat(40),
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
  expect(w).toBeUndefined();
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
  const request: Board["messages"][number] = {
    ...message("review", "P1-01", "reviewer"),
  };
  delete request.reviewCommit;
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
  expect(next.work.some((w) => w.lane === "reviewer")).toBe(false);
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
it("checkpoints an uncheckpointed blocked sibling before required corrections", () => {
  const b = board([task("P1-01", "B", "ready"), task("P1-02", "B", "blocked")]);
  const request = message("fix", "P1-01");
  b.messages.push(request);
  b.unanswered.push(request);
  const first = evaluateOrchestration(b, state(), config, now);
  expect(first.work.find((w) => w.lane === "B")?.task).toBe("P1-02");
  expect(first.work.find((w) => w.lane === "B")?.reason).toContain(
    "checkpoint",
  );
  must(must(must(b.tasks[1]).live).status).checkpointed = true;
  expect(
    evaluateOrchestration(b, state(), config, now).work.find(
      (w) => w.lane === "B",
    )?.task,
  ).toBe("P1-01");
});
it("resumes blocked work from an assignment-bound coordinator request", () => {
  const b = board([task("P1-01", "B", "blocked")]);
  const request: Board["messages"][number] = { ...message("resume", "P1-01") };
  delete request.reviewCommit;
  b.messages.push(request);
  b.unanswered.push(request);
  expect(
    evaluateOrchestration(b, state(), config, now).work.find(
      (w) => w.lane === "B",
    )?.reason,
  ).toContain("Resume this task");
});
it("does not reuse requests across assignment or frozen revision identities", () => {
  const b = board([task("P1-01", "B", "ready")]);
  const request = { ...message("old", "P1-01"), assignmentId: "previous" };
  b.messages.push(request);
  b.unanswered.push(request);
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  request.assignmentId = new Date(now - 100000).toISOString();
  request.reviewCommit = "c".repeat(40);
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
});
it("schedules maximum identity lengths and large accepted history", () => {
  const id = `T${"x".repeat(95)}`,
    lane = `W${"x".repeat(63)}`;
  const history = Array.from({ length: 1001 }, (_, i) => ({
    ...task(`T-${i}`),
    live: { ...task(`T-${i}`).live, accepted: { commit: "a".repeat(40) } },
  }));
  const b = board([...history, task(id, lane)]);
  const c = {
    ...config,
    allowedTasks: [id],
    lanes: {
      coordinator: { enabled: true },
      [lane]: { enabled: true, sessionEpoch: "e".repeat(64) },
    },
  };
  const work = evaluateOrchestration(b, state(), c, now).work.find(
    (w) => w.lane === lane,
  );
  expect(work?.task).toBe(id);
  expect(work?.key).toMatch(/^work:[a-f0-9]{64}$/);
});
it("serializes a reassigned task against a running prior native key", () => {
  const b = board([task("P1-01", "C")]);
  must(must(b.tasks[0]).live).scope = {
    version: 1,
    paths: ["src"],
  };
  const s = state();
  s.records.old = {
    key: "old",
    lane: "B",
    task: "P1-01",
    cwd: "/old",
    status: "running",
    reason: "",
    seen: [],
    runs: [],
    noProgress: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  expect(
    evaluateOrchestration(b, s, config, now).queue.queue.find(
      (q) => q.lane === "C",
    )?.reason,
  ).toBe("PATH_OVERLAP");
});
it("retains accepted dependency truth when dropping unrelated accepted history", () => {
  const accepted = task("P1-01");
  const b = board([
    {
      ...accepted,
      live: {
        ...accepted.live,
        accepted: { commit: "a".repeat(40), sourceCommit: "b".repeat(40) },
      },
    },
    task("P1-02"),
  ]);
  must(must(b.tasks[1]).live).scheduling = {
    version: 1,
    priority: "normal",
    dependsOn: [
      { taskId: "P1-01", require: "accepted", commit: "b".repeat(40) },
    ],
    reviewOf: null,
    enqueuedAt: now - 1000,
    updatedBy: "coordinator",
  };
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.task === "P1-02",
    ),
  ).toBe(true);
  must(must(must(b.tasks[0]).live).accepted).sourceCommit = "c".repeat(40);
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.task === "P1-02",
    ),
  ).toBe(false);
});
it("preserves more than 1000 relevant accepted dependency records without a controller fault", () => {
  const metadata = (
    dependsOn: { taskId: string; require: "accepted"; commit: null }[],
  ) => ({
    version: 1 as const,
    priority: "normal" as const,
    dependsOn,
    reviewOf: null,
    enqueuedAt: now - 1000,
    updatedBy: "coordinator",
  });
  const dependency = (taskId: string) => ({
    taskId,
    require: "accepted" as const,
    commit: null,
  });
  const accepted = (
    id: string,
    dependsOn: ReturnType<typeof dependency>[] = [],
  ) => ({
    ...task(id),
    live: {
      ...task(id).live,
      accepted: { commit: "a".repeat(40) },
      scheduling: metadata(dependsOn),
    },
  });
  const leaves = Array.from({ length: 1024 }, (_, i) => accepted(`leaf-${i}`));
  const parents = Array.from({ length: 64 }, (_, i) =>
    accepted(
      `parent-${i}`,
      Array.from({ length: 16 }, (_, j) => dependency(`leaf-${i * 16 + j}`)),
    ),
  );
  const b = board([...leaves, ...parents, task("P1-01")]);
  must(must(b.tasks.at(-1)).live).scheduling = metadata(
    parents.map((t) => dependency(t.id)),
  );
  const result = evaluateOrchestration(b, state(), config, now);
  expect(result.work.some((work) => work.task === "P1-01")).toBe(false);
  expect(result.queue.queue.find((row) => row.taskId === "P1-01")?.reason).toBe(
    "SCHEDULE_INPUT_OVERFLOW",
  );
});
it("uses compact message boundaries without dropping unseen messages at the same timestamp", () => {
  const b = board([task("P1-01"), task("P1-02", "C", "ready")]);
  const old = message("old", "P1-01", "coordinator", "answer");
  b.messages.push(old);
  const s = state();
  const initial = evaluateOrchestration(b, s, config, now).work.find(
    (w) => w.lane === "coordinator",
  );
  remember(s, must(initial), {
    seen: must(initial).events.filter((event) => !event.startsWith("message:")),
    seenMessagesThrough: old.at,
    seenMessagesAtBoundary: [old.id],
    finalState: "waiting",
    waitingForEvent: true,
  });
  expect(
    evaluateOrchestration(b, s, config, now).work.some(
      (w) => w.lane === "coordinator",
    ),
  ).toBe(false);
  const earlier = {
    ...old,
    id: "earlier",
    at: new Date(Date.parse(old.at) - 1).toISOString(),
  };
  b.messages.push(earlier);
  expect(
    evaluateOrchestration(b, s, config, now).work.some(
      (w) => w.lane === "coordinator",
    ),
  ).toBe(false);
  b.messages.push({ ...old, id: "same-time-new" });
  const next = evaluateOrchestration(b, s, config, now).work.find(
    (w) => w.lane === "coordinator",
  );
  expect(next?.events).toContain("message:same-time-new");
  expect(next?.events).toContain(`ready:P1-02:${"b".repeat(40)}`);
  expect(next?.events).not.toContain("message:old");
  expect(next?.events).not.toContain("message:earlier");
});
it("does not resume blocked work from a compacted answer but permits a new same-time answer", () => {
  const b = board([task("P1-01", "B", "blocked")]);
  const answer = message("old-answer", "P1-01", "B", "answer");
  b.messages.push(answer);
  const s = state();
  const first = must(
    evaluateOrchestration(b, s, config, now).work.find((w) => w.lane === "B"),
  );
  remember(s, first, {
    seen: [],
    seenMessagesThrough: answer.at,
    seenMessagesAtBoundary: [answer.id],
    waitingForEvent: true,
    finalState: "waiting",
  });
  expect(
    evaluateOrchestration(b, s, config, now).work.some((w) => w.lane === "B"),
  ).toBe(false);
  b.messages.push({ ...answer, id: "new-answer" });
  expect(
    evaluateOrchestration(b, s, config, now).work.find((w) => w.lane === "B")
      ?.events,
  ).toContain("message:new-answer");
});
it("bounds active frozen submissions without letting excluded old work fault authorized scheduling", () => {
  const frozen = Array.from({ length: 1100 }, (_, i) =>
    task(`old-${i}`, "B", "ready"),
  );
  const b = board([...frozen, task("P1-01", "C")]);
  for (const old of frozen) {
    const request = message(`fix-${old.id}`, old.id);
    b.messages.push(request);
    b.unanswered.push(request);
  }
  const result = evaluateOrchestration(
    b,
    state(),
    { ...config, allowedTasks: ["P1-01"] },
    now,
  );
  expect(result.work.some((work) => work.task === "P1-01")).toBe(true);
  expect(result.work.some((work) => work.lane === "B")).toBe(false);
  expect(
    result.queue.queue.some((row) => row.reason === "SCHEDULE_INPUT_OVERFLOW"),
  ).toBe(true);
});
it("bounds more than 1000 exact review requests with explicit overflow coverage", () => {
  const b = board([task("P1-01", "B", "ready")]);
  for (let i = 0; i < 1100; i++) {
    const request = message(`review-${i}`, "P1-01", "reviewer");
    b.messages.push(request);
    b.unanswered.push(request);
  }
  const result = evaluateOrchestration(b, state(), config, now);
  expect(result.work.filter((work) => work.lane === "reviewer")).toHaveLength(
    1,
  );
  expect(
    result.queue.queue.filter((row) => row.lane === "reviewer"),
  ).toHaveLength(1100);
  expect(
    result.queue.queue.some((row) => row.reason === "SCHEDULE_INPUT_OVERFLOW"),
  ).toBe(true);
});
it("counts retained and compacted hourly runs without deduplicating same-time turns", () => {
  const b = board([task("P1-01")]);
  const s = state();
  const work = must(
    evaluateOrchestration(b, s, config, now).work.find((w) => w.lane === "B"),
  );
  remember(s, work, { seen: [], runs: [now - 1000] });
  s.retiredRuns = { B: [now - 1000, now - 1000, now - 3600000, now + 1] };
  const limited = { ...config, maxRunsPerHour: 3 };
  expect(
    evaluateOrchestration(b, s, limited, now).queue.queue.find(
      (row) => row.lane === "B",
    )?.reason,
  ).toBe("RATE_LIMITED");
  s.retiredRuns.B = [now - 1000, now - 3600000, now + 1];
  expect(
    evaluateOrchestration(b, s, limited, now).work.some(
      (work) => work.lane === "B",
    ),
  ).toBe(true);
});
it("resumes a blocked owner only from a valid scoped peer answer or coordinator decision", () => {
  const b = board([task("P1-01", "B", "blocked")]);
  const assignmentId = new Date(now - 100000).toISOString();
  const question = {
    ...message("peer-question", "P1-01", "C", "question"),
    from: "B",
    assignmentId,
  };
  const answer = {
    ...message("peer-answer", "P1-01", "B", "answer"),
    from: "C",
    replyTo: question.id,
    assignmentId,
  };
  b.messages.push(question, answer);
  expect(
    evaluateOrchestration(b, state(), config, now).work.find(
      (w) => w.lane === "B",
    )?.reason,
  ).toContain("Resume this task");
  answer.assignmentId = "old-assignment";
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  answer.assignmentId = assignmentId;
  question.assignmentId = "old-assignment";
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  question.assignmentId = assignmentId;
  answer.replyTo = "unrelated";
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  answer.replyTo = question.id;
  question.from = "C";
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  question.from = "B";
  answer.to = "all";
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(false);
  question.to = "all";
  expect(
    evaluateOrchestration(b, state(), config, now).work.some(
      (w) => w.lane === "B",
    ),
  ).toBe(true);
});
it("routes an unanswered peer dependency question to coordinator triage without authorizing peer work", () => {
  const b = board([task("P1-01", "B", "blocked")]);
  const s = state();
  remember(
    s,
    must(
      evaluateOrchestration(b, s, config, now).work.find(
        (work) => work.lane === "coordinator",
      ),
    ),
    { finalState: "waiting", waitingForEvent: true },
  );
  const question = {
    ...message("peer-blocker", "P1-01", "C", "question"),
    from: "B",
  };
  b.messages.push(question);
  b.unanswered.push(question);
  const result = evaluateOrchestration(b, s, config, now);
  expect(
    result.work.find((work) => work.lane === "coordinator")?.events,
  ).toContain("message:peer-blocker");
  expect(result.work.some((work) => work.lane === "C")).toBe(false);
  question.assignmentId = "previous-assignment";
  expect(
    evaluateOrchestration(b, s, config, now).work.some(
      (work) => work.lane === "coordinator",
    ),
  ).toBe(false);
});
it("blocks task replacement and overlapping scopes for retained process ownership", () => {
  for (const identity of [
    { pid: 123 },
    { processGroupId: 123 },
    { cleanupUnverified: true },
  ]) {
    for (const sameTask of [false, true]) {
      const b = board([task("P1-01", "C")]);
      if (!sameTask) {
        b.tasks.push(
          task("P1-02", "B", "ready") as unknown as Board["tasks"][number],
        );
        must(must(b.tasks[1]).live).scope = { version: 1, paths: ["src"] };
      }
      must(must(b.tasks[0]).live).scope = { version: 1, paths: ["src"] };
      const s = state();
      s.records.old = {
        key: "old",
        lane: "B",
        task: sameTask ? "P1-01" : "P1-02",
        cwd: "/old",
        status: "paused",
        reason: "cleanup pending",
        seen: [],
        runs: [],
        noProgress: 0,
        inputTokens: 0,
        outputTokens: 0,
        ...identity,
      };
      expect(
        evaluateOrchestration(b, s, config, now).queue.queue.find(
          (row) => row.lane === "C",
        )?.reason,
      ).toBe("PATH_OVERLAP");
    }
  }
});
it("checkpoints the blocked writer ahead of a correction with a third unclaimed or checkpointed sibling", () => {
  for (const checkpointed of [false, true]) {
    const third = task("P1-03", "B", checkpointed ? "blocked" : "assigned");
    if (third.live.status)
      third.live.status = {
        ...third.live.status,
        checkpointed: true,
      } as typeof third.live.status;
    const b = board([
      task("P1-01", "B", "ready"),
      task("P1-02", "B", "blocked"),
      third,
    ]);
    const request = message("three-sibling-correction", "P1-01");
    b.messages.push(request);
    b.unanswered.push(request);
    expect(
      evaluateOrchestration(b, state(), config, now).work.find(
        (work) => work.lane === "B",
      )?.task,
    ).toBe("P1-02");
    must(must(must(b.tasks[1]).live).status).checkpointed = true;
    expect(
      evaluateOrchestration(b, state(), config, now).work.find(
        (work) => work.lane === "B",
      )?.task,
    ).toBe("P1-01");
  }
});
