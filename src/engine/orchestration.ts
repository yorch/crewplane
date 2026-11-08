import { createHash } from "node:crypto";
import type { Config, Lane, State, Work } from "../contracts.ts";
import { coordinatorOf, reviewersOf } from "../project.ts";
import {
  evaluateSchedule,
  type Metadata,
  type ScheduleCandidate,
  type ScheduleTask,
} from "./fair-scheduler.ts";
import { harnessKey } from "./harness.ts";
import type { snapshot } from "./read-model.ts";

type Board = Awaited<ReturnType<typeof snapshot>>;

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const instant = (value: string | undefined, fallback: number) =>
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : fallback;
export function evaluateOrchestration(
  board: Board,
  state: State,
  config: Config,
  now = Date.now(),
) {
  const coordinator = coordinatorOf(config);
  const laneNames = Object.keys(config.lanes);
  const active = board.tasks.filter((t) => t.live && !t.live.accepted);
  const backlog = board.tasks
    .filter(
      (t) =>
        !t.live &&
        t.state === "todo" &&
        !t.documentedStatus?.startsWith("planning placeholder"),
    )
    .map((t) => t.id)
    .sort();
  // A planning request never authorizes a task or bypasses a phase gate. It is acknowledged
  // once per backlog/acceptance revision, rather than polling the model every interval.
  const planningId = backlog.length
    ? `planning:${digest({ backlog, accepted: board.tasks.filter((t) => t.live?.accepted).map((t) => [t.id, t.live?.accepted?.commit]) })}`
    : null;
  const pendingRevision = (
    m: Board["messages"][number],
    lane: Lane,
    task: string,
  ) => {
    if (
      m.from !== coordinator ||
      m.to !== lane ||
      m.task !== task ||
      m.kind !== "request"
    )
      return false;
    const t = active.find((t) => t.id === task);
    const prior =
      state.records[
        `${lane}:${task}:${t?.live?.assignment.at}${harnessKey(config.lanes[lane])}`
      ];
    return !(
      prior?.finalState === "ready" && prior.seen.includes(`message:${m.id}`)
    );
  };
  const works: Work[] = [];
  const candidates: ScheduleCandidate[] = [];
  const tasks: ScheduleTask[] = board.tasks
    .filter((t) => t.live)
    .map((t) => ({
      id: t.id,
      state: t.live?.accepted
        ? "accepted"
        : ((t.live?.status?.state ?? "assigned") as ScheduleTask["state"]),
      readyCommit: t.live?.status?.commit ?? null,
      acceptedCommit: t.live?.accepted?.commit ?? null,
      acceptedSourceCommit: t.live?.accepted?.sourceCommit ?? null,
      metadata: t.live?.scheduling ?? null,
    }));
  const add = (
    work: Work,
    kind: ScheduleCandidate["kind"],
    enqueuedAt: number,
    schedulerTask = work.task ?? `${coordinator}:control`,
  ) => {
    const old = state.records[work.key];
    // Never change a persisted native session's checkout or harness by choosing another task.
    if (old?.status === "running" || old?.status === "paused") return;
    const fresh = work.events.some((event) => !old?.seen.includes(event));
    const outboundWait = board.unanswered.some(
      (m) => m.from === work.lane && (!work.task || m.task === work.task),
    );
    const unfinished =
      (work.lane === coordinator && old?.finalState === "working") ||
      kind === "review" ||
      kind === "revision" ||
      kind === "resume" ||
      (kind === "implementation" &&
        !["ready", "blocked"].includes(
          active.find((t) => t.id === work.task)?.live?.status?.state ??
            "assigned",
        ));
    if (
      old &&
      !fresh &&
      !state.notices[work.lane]?.length &&
      !(
        unfinished &&
        !old.waitingForEvent &&
        !outboundWait &&
        now - instant(old.finishedAt, 0) > 15000
      )
    )
      return;
    works.push(work);
    candidates.push({
      key: work.key,
      lane: work.lane,
      taskId: schedulerTask,
      kind,
      enqueuedAt,
      authorized: !work.task || config.allowedTasks.includes(work.task),
      phaseAllowed: true,
      ownershipValid: true,
      pathsDisjoint: true,
      acceptedBase: true,
      configLoaded: true,
      blocksAcceptance: kind === "review",
    });
  };
  for (const lane of laneNames) {
    const suffix = harnessKey(config.lanes[lane]);
    const incoming = board.messages.filter(
      (m) =>
        (m.to === lane || m.to === "all") &&
        ["question", "request", "answer", "handoff"].includes(m.kind),
    );
    if (lane === coordinator) {
      const events = incoming.map((m) => `message:${m.id}`);
      for (const t of active)
        if (["ready", "blocked"].includes(t.live?.status?.state ?? ""))
          events.push(
            `${t.live?.status?.state}:${t.id}:${t.live?.status?.commit ?? t.live?.status?.at}`,
          );
      for (const r of Object.values(state.records))
        if (r.lane !== coordinator && r.status === "paused")
          events.push(`failure:${r.key}:${r.finishedAt}:${r.reason}`);
      if (planningId) events.push(planningId);
      tasks.push({
        id: `${coordinator}:control`,
        state: "assigned",
        readyCommit: null,
        acceptedCommit: null,
        acceptedSourceCommit: null,
        metadata: {
          version: 1,
          priority: "urgent-operational",
          dependsOn: [],
          reviewOf: null,
          enqueuedAt: now,
          updatedBy: coordinator,
        },
      });
      add(
        {
          lane,
          key: `${coordinator}:control${suffix}`,
          task: null,
          events,
          reason: planningId
            ? "Triage actionable events and scope the next gate-eligible backlog; no task is automatically authorized"
            : "Handle questions, ready handoffs and lane failures",
        },
        "control",
        now,
      );
    } else if (reviewersOf(config).includes(lane)) {
      for (const request of board.unanswered.filter(
        (m) =>
          m.from === coordinator &&
          m.to === lane &&
          m.kind === "request" &&
          m.task &&
          config.allowedTasks.includes(m.task),
      )) {
        const key = `${lane}:${request.id}${suffix}`;
        const virtualId = `review:${request.id}`;
        const source = tasks.find((t) => t.id === request.task);
        const metadata: Metadata = {
          version: 1,
          priority: source?.metadata?.priority ?? "gate-critical",
          dependsOn: [],
          reviewOf: request.reviewCommit
            ? { taskId: request.task as string, commit: request.reviewCommit }
            : null,
          enqueuedAt: instant(request.at, now),
          updatedBy: coordinator,
        };
        tasks.push({
          id: virtualId,
          state: "assigned",
          readyCommit: null,
          acceptedCommit: null,
          acceptedSourceCommit: null,
          metadata,
        });
        // Legacy text-only briefs remain executable, but are explicitly unverified by
        // the scheduler; never infer a reviewed SHA from a moving ready branch.
        const work = {
          lane,
          key,
          task: request.task,
          events: [
            `review:${request.id}`,
            ...incoming
              .filter((m) => m.task === request.task)
              .map((m) => `message:${m.id}`),
          ],
          reason: request.reviewCommit
            ? "Complete the exact pinned review and answer its original thread"
            : "Legacy review brief: verify the exact SHA in the original request; scheduler pin unavailable",
        };
        add(
          work,
          request.reviewCommit ? "review" : "control",
          instant(request.at, now),
          virtualId,
        );
      }
    } else {
      for (const t of active.filter((t) => t.live?.assignment.owner === lane)) {
        const key = `${lane}:${t.id}:${t.live?.assignment.at}${suffix}`;
        const status = t.live?.status?.state;
        const requests = board.unanswered.filter((m) =>
          pendingRevision(m, lane, t.id),
        );
        const freshAnswer = incoming.some(
          (m) =>
            m.from === coordinator &&
            m.kind === "answer" &&
            m.task === t.id &&
            !state.records[key]?.seen.includes(`message:${m.id}`),
        );
        const anyRevision = board.unanswered.some(
          (m) =>
            m.task !== null &&
            pendingRevision(m, lane, m.task) &&
            m.task !== t.id &&
            active.some(
              (other) =>
                other.id === m.task && other.live?.status?.state === "ready",
            ),
        );
        const resumeBlocked =
          status === "blocked" &&
          !anyRevision &&
          (freshAnswer || !!t.live?.status?.checkpointed);
        const frozen = status === "ready" || status === "blocked";
        if (frozen && !requests.length && !resumeBlocked) continue;
        const competing = active.filter(
          (other) =>
            other.id !== t.id &&
            other.live?.assignment.owner === lane &&
            !["ready"].includes(other.live?.status?.state ?? "assigned") &&
            !(!other.live?.claim && !other.live?.status) &&
            !other.live?.status?.checkpointed,
        );
        const checkpointRequests = board.unanswered.filter(
          (m) =>
            m.task !== null &&
            pendingRevision(m, lane, m.task) &&
            m.task !== t.id &&
            active.some(
              (other) =>
                other.id === m.task && other.live?.status?.state === "ready",
            ),
        );
        add(
          {
            lane,
            key,
            task: t.id,
            events: [
              `assignment:${key}`,
              ...(resumeBlocked
                ? [
                    `resume:${digest(active.filter((t) => t.live?.assignment.owner === lane).map((t) => [t.id, t.live?.status?.commit, t.live?.status?.state]))}`,
                  ]
                : []),
              ...checkpointRequests.map((m) => `checkpoint:${m.id}`),
              ...incoming
                .filter((m) => m.task === t.id)
                .map((m) => `message:${m.id}`),
            ],
            reason: resumeBlocked
              ? "Resume this task in its original checkout after a safe checkpoint or coordinator resolution"
              : frozen
                ? "Address the required correction in this original task checkout/session"
                : checkpointRequests.length
                  ? "A required correction is pending for an earlier submitted task. Finish a safe checkpoint, run agents checkpoint for THIS task, and end waiting; do not edit the other task from this session."
                  : "Continue this independent explicit assignment",
          },
          resumeBlocked ? "resume" : frozen ? "revision" : "implementation",
          instant(requests[0]?.at ?? t.live?.assignment.at, now),
        );
        if (frozen && !resumeBlocked && competing.length) {
          const candidate = candidates.find((c) => c.key === key);
          if (candidate) candidate.ownershipValid = false;
        }
      }
    }
  }
  const scope = (taskId: string | null) => {
    const s = board.tasks.find((t) => t.id === taskId)?.live?.scope;
    return s?.version === 1 &&
      Array.isArray(s.paths) &&
      s.paths.every(
        (p) =>
          typeof p === "string" &&
          p.length > 0 &&
          !p.startsWith("/") &&
          !p.split("/").includes(".."),
      )
      ? s.paths
      : null;
  };
  const overlaps = (a: string[] | null, b: string[] | null) =>
    !!a &&
    !!b &&
    a.some((p) =>
      b.some((q) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)),
    );
  for (const candidate of candidates)
    if (
      Object.values(state.records).some(
        (r) =>
          r.status === "running" &&
          r.task !== candidate.taskId &&
          overlaps(scope(r.task), scope(candidate.taskId)),
      )
    )
      candidate.pathsDisjoint = false;
  const result = evaluateSchedule({
    version: 1,
    now,
    maxParallel: config.maxParallel,
    coordinatorLane: coordinator,
    coordinatorReserved:
      !!config.lanes[coordinator]?.enabled && config.maxParallel > 1,
    active: Object.values(state.records)
      .filter((r) => r.status === "running")
      .map((r) => ({ key: r.key, lane: r.lane })),
    lanes: laneNames.map((lane) => ({
      lane,
      enabled: config.lanes[lane]?.enabled ?? false,
      held: state.held.includes(lane),
      failurePaused: Object.values(state.records).some(
        (r) =>
          r.lane === lane &&
          r.status === "paused" &&
          (!r.task || active.some((t) => t.id === r.task)),
      ),
      runsLastHour: Object.values(state.records)
        .filter((r) => r.lane === lane)
        .flatMap((r) => r.runs)
        .filter((t) => t <= now && now - t < 3600000).length,
      maxRunsPerHour: config.maxRunsPerHour,
    })),
    tasks,
    candidates,
  });
  const selectedScopes: (string[] | null)[] = [];
  result.selected = result.selected.filter((key) => {
    const candidate = candidates.find((c) => c.key === key);
    if (!candidate) return false;
    const paths = scope(candidate.taskId);
    if (selectedScopes.some((existing) => overlaps(existing, paths))) {
      const row = result.queue.find((q) => q.key === key);
      if (row) {
        row.status = "blocked";
        row.reason = "PATH_OVERLAP";
        row.position = null;
      }
      return false;
    }
    selectedScopes.push(paths);
    return true;
  });
  return {
    work: result.selected.flatMap((key) => works.filter((w) => w.key === key)),
    queue: result,
    planning: planningId
      ? {
          event: planningId,
          taskIds: backlog,
          needed:
            !state.records[
              `${coordinator}:control${harnessKey(config.lanes[coordinator])}`
            ]?.seen.includes(planningId),
        }
      : null,
  };
}
