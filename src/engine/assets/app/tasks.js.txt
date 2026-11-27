import { progressBadge, taskBadge } from "./badges.js";
import { LAYOUT_KEY } from "./config.js";
import {
  closeLink,
  detail,
  detailHeading,
  el,
  emptyState,
  fields,
  firstLine,
  includesText,
  link,
  section,
} from "./dom.js";
import { clearButton, syncClear } from "./filters.js";
import { BOARD_COLUMNS, STATE_GROUPS } from "./labels.js";
import { agentLink, taskLink, taskTitle } from "./links.js";
import { hrefFor } from "./route.js";
import { $, compactLayout, store } from "./store.js";
import { timeEl } from "./time.js";

function storedLayout() {
  try {
    const value = window.localStorage.getItem(LAYOUT_KEY);
    return value === "board" || value === "list" ? value : null;
  } catch {
    return null;
  }
}
export function storeLayout(value) {
  try {
    window.localStorage.setItem(LAYOUT_KEY, value);
  } catch {
    // Storage can be disabled; the layout still applies through the URL.
  }
}

function taskLayout() {
  if (store.route.params.layout) return store.route.params.layout;
  return storedLayout() ?? (compactLayout.matches ? "list" : "board");
}
function taskMatches(task, params) {
  if (params.agent && task.owner !== params.agent) return false;
  if (params.phase && task.phase !== params.phase) return false;
  if (params.state) {
    const states = STATE_GROUPS[params.state] ?? [params.state];
    if (!states.includes(task.state)) return false;
  }
  return includesText(
    `${task.id} ${task.title} ${task.goal} ${task.live?.status?.text ?? ""}`,
    params.q,
  );
}
function taskCard(task) {
  const selected = store.route.params.task === task.id;
  const card = el(
    "article",
    undefined,
    `card${selected ? " is-selected" : ""}`,
  );
  card.dataset.taskId = task.id;
  const head = el("div", undefined, "card-head");
  head.append(el("span", task.id, "mono card-id"), taskBadge(task.state));
  const body = el("div", undefined, "card-body");
  const title = el("h3", undefined, "card-title");
  const anchor = link(
    hrefFor("tasks", { ...store.route.params, task: task.id }),
    taskTitle(task),
    "card-link",
  );
  anchor.dataset.focusKey = `task:${task.id}`;
  if (selected) anchor.setAttribute("aria-current", "true");
  title.append(anchor);
  body.append(title, el("p", task.goal, "card-goal"));
  if (task.live && !task.live.accepted && task.scheduling)
    body.append(el("p", task.scheduling.label, "card-note"));
  const foot = el("div", undefined, "card-foot");
  foot.append(agentLink(task.owner, "card-owner"));
  if (task.live?.status?.at) foot.append(timeEl(task.live.status.at));
  card.append(head, body, foot);
  return card;
}
export function renderTasks() {
  const params = store.route.params;
  const layout = taskLayout();
  for (const [id, value] of [
    ["layout-board", "board"],
    ["layout-list", "list"],
  ])
    $(id).setAttribute("aria-pressed", String(layout === value));
  const filtered = store.data.tasks.filter((task) => taskMatches(task, params));
  $("task-count").textContent =
    `${filtered.length} of ${store.data.tasks.length} tasks`;
  syncClear("tasks");
  const board = $("tasks");
  board.classList.toggle("is-list", layout === "list");
  if (layout === "board") {
    board.setAttribute("role", "region");
    board.setAttribute(
      "aria-label",
      "Task board, scrolls horizontally when columns do not fit",
    );
    board.tabIndex = 0;
    board.dataset.scrollKey = "task-board";
  } else {
    board.removeAttribute("role");
    board.removeAttribute("aria-label");
    board.removeAttribute("tabindex");
    board.removeAttribute("data-scroll-key");
  }
  if (!store.data.tasks.length)
    board.replaceChildren(
      emptyState(
        "No task cards found.",
        "Add Markdown task cards to the configured tasks path to populate the board.",
      ),
    );
  else if (!filtered.length) {
    const empty = emptyState("No tasks match these filters.");
    empty.append(clearButton("tasks"));
    board.replaceChildren(empty);
  } else
    board.replaceChildren(
      ...BOARD_COLUMNS.flatMap(([name, states]) => {
        const tasks = filtered
          .filter((task) => states.includes(task.state))
          .sort(
            (a, b) =>
              Number(b.state === "blocked") - Number(a.state === "blocked"),
          );
        if (layout === "list" && !tasks.length) return [];
        const column = el("section", undefined, "column");
        const heading = el("h2", undefined, "column-title");
        heading.append(
          el("span", name),
          el("span", String(tasks.length), "count"),
        );
        column.append(heading);
        if (tasks.length) column.append(...tasks.map(taskCard));
        else column.append(el("p", "No tasks", "column-empty"));
        return [column];
      }),
    );
  renderTaskDetail();
}
function relatedMessages(taskId) {
  return store.data.messages.filter((message) => message.task === taskId);
}
function renderTaskDetail() {
  const pane = $("task-detail");
  const split = $("tasks-split");
  const id = store.route.params.task;
  split.classList.toggle("has-detail", Boolean(id));
  pane.hidden = !id;
  if (!id) {
    pane.replaceChildren();
    return;
  }
  const closeHref = hrefFor("tasks", {
    ...store.route.params,
    task: undefined,
  });
  pane.setAttribute("aria-labelledby", "task-detail-title");
  const task = store.data.tasks.find((candidate) => candidate.id === id);
  if (!task) {
    pane.replaceChildren(
      closeLink(closeHref, "Close task details"),
      detailHeading(id, "task-detail-title"),
      emptyState(
        "This task is not in the current snapshot.",
        "It may have been renamed or removed from the configured tasks path.",
      ),
    );
    return;
  }
  const nodes = [closeLink(closeHref, "Close task details")];
  const header = el("div", undefined, "detail-header");
  const titleLine = el("div", undefined, "detail-tags");
  titleLine.append(
    el("span", task.id, "mono"),
    taskBadge(task.state),
    el("span", `Phase ${task.phase}`, "badge tone-neutral"),
  );
  header.append(
    titleLine,
    detailHeading(taskTitle(task), "task-detail-title"),
    fields([["Owner", agentLink(task.owner)]], "fields-inline"),
  );
  nodes.push(header, section("Goal", el("p", task.goal)));

  const live = task.live;
  const progress = el("div");
  if (live?.status) {
    progress.append(
      fields([
        ["Reported", progressBadge(live.status.state, true)],
        ["Updated", timeEl(live.status.at)],
        ["Commit", live.status.commit],
      ]),
      el("p", live.status.text, "prose"),
    );
    if (live.status.checkpointed)
      progress.append(el("p", "Checkpointed for a safe handover.", "note"));
    if (live.status.revisionRequestId)
      progress.append(
        el(
          "p",
          `Revision request ${live.status.revisionRequestId}${live.status.revisionCommit ? ` · ${live.status.revisionCommit}` : ""}`,
          "note",
        ),
      );
  } else
    progress.append(
      el("p", `Documented status: ${task.documentedStatus}`, "prose"),
    );
  if (task.scheduling?.label)
    progress.append(el("p", task.scheduling.label, "note"));
  progress.append(
    el(
      "p",
      "Updates reflect reported progress; they do not prove a harness is running.",
      "note",
    ),
  );
  nodes.push(section("Progress", progress));

  if (live?.accepted) {
    nodes.push(
      section(
        "Acceptance",
        fields([
          ["Commit", live.accepted.commit],
          ["Source commit", live.accepted.sourceCommit],
          ["Accepted", timeEl(live.accepted.at)],
        ]),
        el("p", live.accepted.text, "prose"),
        el(
          "p",
          "Acceptance can cover a bounded slice; task notes retain the remaining scope.",
          "note",
        ),
      ),
    );
  }

  const messages = relatedMessages(task.id);
  const open = store.data.unanswered.filter(
    (message) => message.task === task.id,
  );
  const conversations = el("div");
  if (open.length) {
    const list = el("ul", undefined, "link-list");
    for (const message of open) {
      const row = el("li");
      row.append(
        link(
          hrefFor("messages", { filter: "open", thread: message.id }),
          `${message.from}: ${firstLine(message.text, 100)}`,
        ),
      );
      list.append(row);
    }
    conversations.append(list);
  } else conversations.append(el("p", "No open questions.", "note"));
  const actions = el("div", undefined, "detail-actions");
  actions.append(
    link(
      hrefFor("messages", { filter: "all", q: task.id }),
      `All messages (${messages.length})`,
    ),
    link(hrefFor("runs", { task: task.id }), "Runs for this task"),
  );
  conversations.append(actions);
  nodes.push(section("Conversations & runs", conversations));

  const dependencies = el("div");
  dependencies.append(el("p", task.dependencies, "prose"));
  if (live?.scheduling?.dependsOn?.length) {
    const list = el("ul", undefined, "link-list");
    for (const dep of live.scheduling.dependsOn) {
      const row = el("li");
      row.append(taskLink(dep.taskId, "mono"), ` requires ${dep.require}`);
      list.append(row);
    }
    dependencies.append(list);
  }
  nodes.push(section("Dependencies", dependencies));

  const workspaceRows = [
    ["Base commit", live?.assignment?.baseCommit],
    ["Assigned", live?.assignment ? timeEl(live.assignment.at) : null],
    ["Claim branch", live?.claim?.branch],
    ["Worktree", live?.claim?.worktree],
  ];
  const workspace = el("div");
  workspace.append(fields(workspaceRows));
  if (live?.scope?.paths?.length) {
    const scope = el("ul", undefined, "path-list");
    scope.append(...live.scope.paths.map((path) => el("li", path, "mono")));
    workspace.append(el("p", "Scope paths", "field-heading"), scope);
  }
  if (live?.assignment?.text)
    workspace.append(
      detail("Assignment brief", live.assignment.text, `assign-${task.id}`),
    );
  nodes.push(section("Assignment & workspace", workspace));

  nodes.push(
    section(
      "Task card",
      detail("Scope, dependencies & task card", task.markdown, task.id),
    ),
  );
  pane.replaceChildren(...nodes);
}
