import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Board, LiveTask } from "../contracts.ts";
import { checkControlDirectory, controlDirectory } from "../control.ts";
import { gitEnvironment } from "../environment.ts";
import type { PlanParser } from "../ports.ts";
import {
  coordinatorOf,
  projectPolicy,
  reviewerRoleOf,
  reviewersOf,
} from "../project.ts";
import { main as coordination } from "./agents.mjs";
import { buildGraph, type GraphInput } from "./dashboard/graph-builder.ts";
import {
  normalizeConfig,
  normalizeState,
  readHeadless,
} from "./dashboard/headless.ts";
import { schedulingFingerprint, schedulingReason } from "./scheduling.ts";
import { watchdogHealth } from "./watchdog/dashboard.ts";

export type { Board, LiveTask, Message } from "../contracts.ts";

const projectReadLimit = 1024 * 1024;
/** Read a project document without following a final symlink, escaping the project, or reading unbounded/special files. */
async function readProjectFile(root: string, path: string): Promise<string> {
  const real = await realpath(join(root, path));
  const within = relative(await realpath(root), real);
  if (within.startsWith("..") || isAbsolute(within))
    throw new Error("Project document escapes the project root");
  const handle = await open(
    real,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > projectReadLimit)
      throw new Error("Project document is not a bounded regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export interface DocumentProblem {
  path: string;
  reason: string;
}

/** Never throws for a bad document: a missing file is empty, anything else is reported as a problem. */
async function readProjectDocument(
  root: string,
  path: string,
  problems: DocumentProblem[],
): Promise<string> {
  try {
    return await readProjectFile(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    problems.push({
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

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
    title: markdown.split("\n")[0]?.replace(/^#\s*/, "").trim() || id,
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

export function plannedTasks(
  parser: PlanParser,
  plan: string,
  existingIds: Set<string>,
) {
  return parser(plan, existingIds).map((card) =>
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

export interface SnapshotOptions {
  /** Roadmap-format parsers keyed by policy `roadmapFormat`; none are built in. */
  planParsers?: Readonly<Record<string, PlanParser>>;
}

export async function snapshot(root: string, options: SnapshotOptions = {}) {
  const board = (await coordination(["board"], root)) as Board;
  const documentProblems: DocumentProblem[] = [];
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
        await readProjectDocument(
          root,
          join(policy.tasksPath, file),
          documentProblems,
        ),
        board.tasks.find((t) => t.task === id),
      );
    }),
  );
  const plan = await readProjectDocument(
    root,
    policy.planPath,
    documentProblems,
  );
  const parser = Object.hasOwn(
    options.planParsers ?? {},
    policy.roadmapFormat ?? "none",
  )
    ? options.planParsers?.[policy.roadmapFormat ?? "none"]
    : undefined;
  if (parser)
    tasks.push(
      ...plannedTasks(parser, plan, new Set(tasks.map((task) => task.id))),
    );
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  // Control state is read from the private per-user directory, never the store.
  const control = controlDirectory(root);
  const usable = (() => {
    try {
      checkControlDirectory(control);
      return true;
    } catch {
      return false; // unsafe control directory: treated as unavailable
    }
  })();
  const [runtime, configured] = await Promise.all([
    usable
      ? readFile(join(control, "state.json"), "utf8")
          .then((s) => normalizeState(JSON.parse(s)))
          .catch(() => null)
      : null,
    usable
      ? readFile(join(control, "config.json"), "utf8")
          .then((s) => normalizeConfig(JSON.parse(s)))
          .catch(() => null)
      : null,
  ]);
  for (const task of tasks)
    task.scheduling = schedulingReason(task, runtime, configured);
  const headless = await headlessStatus(
    control,
    board.tasks.filter((t) => !t.accepted).map((t) => t.assignment.owner),
  );
  // Branch names are decoration: a slow or failing git must not fail the snapshot.
  let worktreeList = "";
  try {
    worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      env: gitEnvironment(),
      encoding: "utf8",
      timeout: 10000,
    });
  } catch {
    worktreeList = "";
  }
  const worktrees = worktreeList.split("\n\n").map((entry) => ({
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
  // Display validation must never take down the authoritative board read.
  let graphState = "available";
  let graphs: {
    dependencies: ReturnType<typeof buildGraph>;
    communication: ReturnType<typeof buildGraph>;
  };
  try {
    graphs = {
      dependencies: buildGraph(graphInput, "dependencies"),
      communication: buildGraph(graphInput, "communication"),
    };
  } catch {
    graphState = "unavailable";
    graphs = {
      dependencies: buildGraph(
        { version: 1, tasks: [], lanes: [], messages: [], unansweredIds: [] },
        "dependencies",
      ),
      communication: buildGraph(
        { version: 1, tasks: [], lanes: [], messages: [], unansweredIds: [] },
        "communication",
      ),
    };
  }
  return {
    graphs,
    graphCoverage: {
      state: graphState,
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
    watchdog: await watchdogHealth(control),
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
    milestoneStatus: await readProjectDocument(
      root,
      policy.statusPath,
      documentProblems,
    ),
    documentProblems,
  };
}
