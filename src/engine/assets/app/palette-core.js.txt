// What the command palette can find, built from data the page already holds
// (the snapshot, the runs the Runs view loaded, the artifacts the gallery
// loaded). No request is made here and nothing is read from the DOM. Titles are
// untrusted text and stay text: the palette renders them with textContent.
import { VIEW_META } from "./config.js";
import { stateLabels } from "./labels.js";
import { hrefFor } from "./route.js";

const firstLine = (text, limit = 120) =>
  String(text ?? "")
    .split("\n")[0]
    .slice(0, limit);

/** Commands that only navigate (a filtered view) or open a dialog. */
export const ACTIONS = [
  {
    id: "open-questions",
    title: "Show open questions",
    keys: ["messages open unanswered questions requests"],
    href: hrefFor("messages", { filter: "open" }),
  },
  {
    id: "blocked-tasks",
    title: "Show blocked tasks",
    keys: ["tasks blocked attention"],
    href: hrefFor("tasks", { state: "blocked" }),
  },
  {
    id: "review-tasks",
    title: "Show tasks awaiting review",
    keys: ["tasks review submissions"],
    href: hrefFor("tasks", { state: "review" }),
  },
  {
    id: "running-agents",
    title: "Show running agents",
    keys: ["agents running processes"],
    href: hrefFor("agents", { status: "running" }),
  },
  {
    id: "stale-agents",
    title: "Show stale agents",
    keys: ["agents stale heartbeat"],
    href: hrefFor("agents", { status: "stale" }),
  },
  {
    id: "refused-commands",
    title: "Show refused commands",
    keys: ["control log refused rejected"],
    href: hrefFor("audit", { outcome: "refused" }),
  },
  {
    id: "dependency-graph",
    title: "Show the task dependency graph",
    keys: ["relationships dependencies graph"],
    href: hrefFor("relationships", { graph: "dependencies" }),
  },
  {
    id: "all-messages",
    title: "Show all messages",
    keys: ["messages all threads"],
    href: hrefFor("messages", { filter: "all" }),
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    keys: ["help keys keyboard ? shortcuts"],
    command: "help",
  },
  {
    id: "preferences",
    title: "Preferences",
    keys: ["settings theme dark light alerts notifications"],
    command: "preferences",
  },
];

/**
 * Entries for every kind. `runs` and `artifacts` are whatever the other views
 * have loaded (possibly nothing); `data` is the latest snapshot or undefined.
 */
export function entriesFromData({ data, runs = [], artifacts = [] }) {
  const out = [];
  for (const action of ACTIONS)
    out.push({
      kind: "action",
      id: action.id,
      title: action.title,
      subtitle: action.command
        ? "Opens a dialog"
        : "Shortcut to a filtered view",
      keys: action.keys,
      href: action.href,
      command: action.command,
    });
  for (const [view, meta] of Object.entries(VIEW_META))
    out.push({
      kind: "view",
      id: view,
      title: meta.title,
      subtitle: meta.subtitle,
      keys: [view],
      href: hrefFor(view),
    });
  if (!data) return out;
  for (const task of data.tasks ?? [])
    out.push({
      kind: "task",
      id: task.id,
      title: `${task.id} · ${firstLine(task.title ?? task.id)}`,
      subtitle: [
        stateLabels[task.state] ?? task.state,
        task.phase ? `Phase ${task.phase}` : null,
        task.owner && task.owner !== "—" ? task.owner : null,
      ]
        .filter(Boolean)
        .join(" · "),
      keys: [task.id, task.owner, task.phase, task.state],
      href: hrefFor("tasks", { task: task.id }),
    });
  const seen = new Set();
  const lanes = [
    ...(data.headless?.lanes ?? []).map((lane) => [lane.lane, lane.status]),
    ...(data.tasks ?? []).map((task) => [task.owner, null]),
  ];
  for (const [name, status] of lanes) {
    if (!name || name === "—" || name === "all" || seen.has(name)) continue;
    seen.add(name);
    out.push({
      kind: "agent",
      id: name,
      title: name,
      subtitle: status ? `Agent · ${status}` : "Agent",
      keys: [status],
      href: hrefFor("agents", { agent: name }),
    });
  }
  // Newest messages first, so a tie prefers a recent thread.
  const messages = data.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.replyTo) continue;
    out.push({
      kind: "thread",
      id: message.id,
      title: firstLine(message.text) || `${message.kind} ${message.id}`,
      subtitle: `${message.from} → ${message.to}${message.task ? ` · ${message.task}` : ""}`,
      keys: [message.task, message.from, message.to, message.kind],
      href: hrefFor("messages", { filter: "all", thread: message.id }),
    });
  }
  for (const run of runs)
    out.push({
      kind: "run",
      id: run.runId,
      title: `${run.lane} · ${run.task ?? "coordination"}`,
      subtitle:
        `Run · ${run.status ?? "unknown"} · ${run.harness ?? ""}`.trim(),
      keys: [run.runId, run.harness, run.status],
      href: hrefFor("runs", { run: run.runId }),
    });
  for (const artifact of artifacts)
    out.push({
      kind: "artifact",
      id: artifact.id,
      title:
        [artifact.scenario, artifact.route].filter(Boolean).join(" · ") ||
        "Captured artifact",
      subtitle: `Evidence${artifact.task ? ` · ${artifact.task}` : ""}`,
      keys: [artifact.task, artifact.outcome, artifact.id],
      href: hrefFor("evidence", { artifact: artifact.id }),
    });
  return out;
}

export const KIND_LABELS = {
  action: "Command",
  view: "View",
  task: "Task",
  agent: "Agent",
  thread: "Thread",
  run: "Run",
  artifact: "Evidence",
};
