import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board, Config, LiveTask, State } from "../contracts.ts";
import { relayPlannedTasks } from "../profiles/relay.ts";
import {
  coordinatorOf,
  projectPolicy,
  reviewerRoleOf,
  reviewersOf,
} from "../project.ts";
import { main as coordination } from "./agents.mjs";
import { buildGraph, type GraphInput } from "./dashboard/graph-builder.ts";
import { readHeadless } from "./dashboard/headless.ts";
import { schedulingFingerprint, schedulingReason } from "./scheduling.ts";
import { watchdogHealth } from "./watchdog/dashboard.ts";

export type { Board, LiveTask, Message } from "../contracts.ts";

export function parseTask(id: string, markdown: string, live?: LiveTask) {
  const documentedStatus =
    markdown.match(/Status:\s*([^\n]+)/)?.[1] ?? "Not started";
  const documentedComplete =
    /^(complete\b|accepted\b|reviewed\/integrated\b)/i.test(documentedStatus);
  const state = live?.accepted
    ? "completed"
    : live?.status?.state === "ready"
      ? "review"
      : live?.status?.state === "blocked"
        ? "blocked"
        : live?.status?.state === "working"
          ? "working"
          : live?.assignment
            ? "assigned"
            : documentedComplete
              ? "completed"
              : /^in progress\b/i.test(documentedStatus)
                ? "working"
                : "todo";
  return {
    id,
    title: markdown.split("\n")[0]?.replace(/^#\s*/, "") ?? id,
    owner:
      live?.assignment.owner ??
      markdown.match(
        /Owner(?: lane)?:\s*([A-Za-z][A-Za-z0-9_-]{0,63})\b/,
      )?.[1] ??
      "—",
    phase:
      markdown.match(/^Phase:\s*([A-Za-z0-9_-]+)/m)?.[1] ??
      id.match(/^P(\d+)-/)?.[1] ??
      "unphased",
    state,
    documentedStatus,
    goal: markdown.match(/^Goal:\s*(.+)/m)?.[1] ?? "See task card",
    dependencies:
      markdown.match(/^(?:Prerequisites|Dependencies):\s*(.+)/m)?.[1] ??
      "See task card",
    scheduling: {
      code: "unknown",
      label: "Scheduling observation unavailable",
    },
    markdown,
    live: live ?? null,
  };
}

export function plannedTasks(plan: string, existingIds: Set<string>) {
  return relayPlannedTasks(plan, existingIds).map((card) =>
    parseTask(card.id, card.markdown),
  );
}

export async function monitorStatus(store: string, now = new Date()) {
  try {
    const value = JSON.parse(
      await readFile(join(store, "monitor/latest.json"), "utf8"),
    ) as {
      running: boolean;
      checkedAt: string;
      intervalSeconds: number;
      alerts: Array<{
        key: string;
        kind: string;
        agent: string;
        task: string | null;
        text: string;
      }>;
      error: string | null;
    };
    if (
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      !Number.isFinite(value.intervalSeconds) ||
      value.intervalSeconds < 1 ||
      !Array.isArray(value.alerts)
    )
      throw new Error("Invalid monitor snapshot");
    const stale =
      now.getTime() - Date.parse(value.checkedAt) >
      (value.intervalSeconds * 2 + 5) * 1000;
    return {
      ...value,
      state: !value.running
        ? "stopped"
        : stale
          ? "stale"
          : value.error
            ? "error"
            : "running",
    };
  } catch (error) {
    return {
      state:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not-started"
          : "unavailable",
      checkedAt: null,
      alerts: [],
      error: null,
    };
  }
}

export const headlessStatus = readHeadless;

export async function snapshot(root: string) {
  const board = (await coordination(["board"], root)) as Board;
  const policy = projectPolicy(root);
  const cards = (
    await readdir(join(root, policy.tasksPath)).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  )
    .filter((f) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.md$/.test(f))
    .sort();
  const tasks = await Promise.all(
    cards.map(async (file) => {
      const id = file.slice(0, -3);
      return parseTask(
        id,
        await readFile(join(root, policy.tasksPath, file), "utf8"),
        board.tasks.find((t) => t.task === id),
      );
    }),
  );
  const plan = await readFile(join(root, policy.planPath), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (policy.roadmapFormat === "relay")
    tasks.push(...plannedTasks(plan, new Set(tasks.map((task) => task.id))));
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  const [runtime, configured] = await Promise.all([
    readFile(join(board.store, "supervisor/state.json"), "utf8")
      .then((s) => JSON.parse(s) as State)
      .catch(() => null),
    readFile(join(board.store, "supervisor/config.json"), "utf8")
      .then((s) => JSON.parse(s) as Config)
      .catch(() => null),
  ]);
  for (const task of tasks)
    task.scheduling = schedulingReason(task, runtime, configured);
  const headless = await headlessStatus(
    board.store,
    board.tasks.filter((t) => !t.accepted).map((t) => t.assignment.owner),
  );
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n\n")
    .map((entry) => ({
      path: entry.match(/^worktree (.+)$/m)?.[1],
      branch: entry.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "detached",
    }));
  const agents = headless.lanes.map((lane) => {
    const task =
      board.tasks.find((t) => t.task === lane.task) ??
      board.tasks.find((t) => t.assignment.owner === lane.lane && !t.accepted);
    const worktree = lane.worktree ?? task?.claim?.worktree ?? null;
    return {
      ...lane,
      task: lane.task ?? task?.task ?? null,
      worktree,
      branch: worktrees.find((w) => w.path === worktree)?.branch ?? null,
      taskStatus: task?.accepted
        ? "accepted"
        : (task?.status?.state ?? (task ? "assigned" : null)),
      reason:
        task?.accepted && lane.status === "idle"
          ? "Last task accepted; no active native run"
          : lane.reason,
      assignments: board.tasks
        .filter((t) => t.assignment.owner === lane.lane && !t.accepted)
        .map((t) => ({ task: t.task, state: t.status?.state ?? "assigned" })),
      acceptedCommit: task?.accepted?.commit ?? null,
    };
  });
  const graphInput: GraphInput = {
    version: 1,
    tasks: tasks
      .filter((t) => t.live?.assignment)
      .sort(
        (a, b) =>
          Number(Boolean(a.live?.accepted)) -
            Number(Boolean(b.live?.accepted)) || a.id.localeCompare(b.id),
      )
      .slice(0, 1000)
      .map((t) => ({
        id: t.id,
        label: t.title.slice(0, 256),
        status: t.live?.accepted
          ? "accepted"
          : (t.live?.status?.state ?? "assigned"),
        accepted: Boolean(t.live?.accepted),
        dependsOn:
          t.live?.scheduling?.dependsOn.map((dep) => ({
            taskId: dep.taskId,
            require: dep.require,
          })) ?? [],
      })),
    lanes: [...agents]
      .sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          Number(Boolean(configured?.lanes[b.lane])) -
            Number(Boolean(configured?.lanes[a.lane])),
      )
      .slice(0, 64)
      .map((lane) => ({
        id: lane.lane,
        role:
          lane.lane === coordinatorOf(configured ?? policy)
            ? "Coordinator"
            : reviewersOf(configured ?? policy).includes(lane.lane)
              ? reviewerRoleOf(configured ?? policy, lane.lane) === "visual"
                ? "Browser QA"
                : "Code review"
              : "Implementation",
        harness: lane.observedHarness,
        observedModel: lane.observedModel,
        taskId: lane.task,
        processStatus: lane.status,
        taskStatus: lane.taskStatus,
        accepted: Boolean(lane.acceptedCommit),
      })),
    messages: board.messages
      .slice(-1000)
      .filter((m) =>
        ["question", "request", "answer", "update", "handoff"].includes(m.kind),
      )
      .map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        kind: m.kind as GraphInput["messages"][number]["kind"],
        task: m.task,
        replyTo: m.replyTo,
        at: m.at,
      })),
    unansweredIds: board.unanswered.slice(-1000).map((m) => m.id),
  };
  return {
    graphs: {
      dependencies: buildGraph(graphInput, "dependencies"),
      communication: buildGraph(graphInput, "communication"),
    },
    graphCoverage: {
      lanesTotal: agents.length,
      lanesIncluded: graphInput.lanes.length,
      tasksTotal: tasks.filter((t) => t.live?.assignment).length,
      tasksIncluded: graphInput.tasks.length,
      messagesTotal: board.messages.length,
      messagesIncluded: graphInput.messages.length,
      dependencyMetadata: `${tasks.filter((t) => t.live?.scheduling).length} structured schedules; legacy dependencies unavailable`,
    },
    coordinator: coordinatorOf(configured ?? policy),
    updatedAt: new Date().toISOString(),
    monitor: await monitorStatus(board.store),
    watchdog: await watchdogHealth(board.store),
    headless: {
      ...headless,
      configState:
        !runtime?.scheduling || !configured
          ? "unknown (runtime provenance unavailable)"
          : runtime.scheduling.fingerprint === schedulingFingerprint(configured)
            ? "current"
            : "reload required (disk config differs from runtime)",
      lanes: agents,
    },
    tasks,
    messages: board.messages,
    unanswered: board.unanswered,
    orphanAssignments: board.tasks.filter(
      (t) => !tasks.some((card) => card.id === t.task),
    ),
    milestoneStatus: await readFile(
      join(root, policy.statusPath),
      "utf8",
    ).catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    }),
  };
}
