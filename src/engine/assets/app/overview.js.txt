import { agentRecords } from "./agents.js";
import { needsAttention } from "./audit-core.js";
import { configResource, logResource } from "./aux.js";
import { badge, healthBadge, processBadge, taskBadge } from "./badges.js";
import { decisionBlock } from "./controls.js";
import { el, emptyState, firstLine, link } from "./dom.js";
import { instanceHoldNotice } from "./hold-notice.js";
import { stateLabels, stateTones } from "./labels.js";
import { agentLink, taskLink, taskTitle } from "./links.js";
import { hrefFor } from "./route.js";
import { $, store } from "./store.js";
import { date } from "./time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Refused, out-of-date and invalid commands from the last day, newest first. */
function recentRefusals(now = Date.now()) {
  return [...(logResource.state.data?.entries ?? [])]
    .filter(
      (entry) =>
        needsAttention(entry) &&
        Number.isFinite(Date.parse(entry.at ?? "")) &&
        now - Date.parse(entry.at) <= DAY_MS,
    )
    .sort((a, b) => b.seq - a.seq);
}
function attentionItems() {
  const items = [];
  const add = (weight, tone, type, title, note, href) =>
    items.push({ weight, tone, type, title, note, href });
  const system = hrefFor("system");
  const headless = store.data.headless;
  if (headless?.state === "stale")
    add(
      0,
      "danger",
      "Supervisor",
      "Supervisor heartbeat is stale",
      `Last check ${date(headless.checkedAt)}`,
      system,
    );
  if (headless?.state === "unavailable")
    add(
      1,
      "warning",
      "Supervisor",
      "Supervisor state is unavailable",
      "Process observations cannot be read.",
      system,
    );
  if (/reload required/.test(headless?.configState ?? ""))
    add(
      1,
      "warning",
      "Supervisor",
      "Disk configuration differs from runtime",
      "A reload is required before the new configuration applies.",
      system,
    );
  if (headless?.configReload?.outcome === "invalid")
    add(
      1,
      "warning",
      "Supervisor",
      "Configuration reload was rejected",
      headless.configReload.errorCode ?? "Invalid configuration",
      system,
    );
  for (const code of store.data.watchdog?.codes ?? [])
    add(
      0,
      "danger",
      "Watchdog",
      `Watchdog reported ${code}`,
      "The watchdog keeps reporting this. Check it before you retry.",
      system,
    );
  if (store.data.watchdog?.state === "stale")
    add(
      1,
      "warning",
      "Watchdog",
      "Watchdog check is stale",
      `Last check ${date(store.data.watchdog.checkedAt)}`,
      system,
    );
  for (const alert of store.data.monitor?.alerts ?? [])
    add(
      2,
      "warning",
      "Monitor",
      `${alert.agent}: ${firstLine(alert.text, 120)}`,
      alert.task ?? "General",
      alert.task ? hrefFor("tasks", { task: alert.task }) : system,
    );
  for (const lane of headless?.lanes ?? []) {
    if (lane.status === "stale")
      add(
        1,
        "danger",
        "Agent",
        `${lane.lane} process is stale`,
        firstLine(lane.reason, 120),
        hrefFor("agents", { agent: lane.lane }),
      );
    else if (lane.status === "paused")
      add(
        2,
        "warning",
        "Agent",
        `${lane.lane} is paused`,
        firstLine(lane.reason, 120),
        hrefFor("agents", { agent: lane.lane }),
      );
  }
  for (const task of store.data.tasks) {
    if (task.state === "blocked")
      add(
        3,
        "danger",
        "Blocked",
        `${task.id} · ${taskTitle(task)}`,
        firstLine(task.live?.status?.text, 120) || `Owner ${task.owner}`,
        hrefFor("tasks", { task: task.id }),
      );
  }
  for (const message of store.data.unanswered)
    add(
      4,
      "warning",
      message.kind === "request" ? "Request" : "Question",
      `${message.from} → ${message.to}: ${firstLine(message.text, 120)}`,
      message.task ?? "General",
      hrefFor("messages", { filter: "open", thread: message.id }),
    );
  for (const task of store.data.tasks) {
    if (task.state === "review")
      add(
        5,
        "info",
        "Awaiting review",
        `${task.id} · ${taskTitle(task)}`,
        task.scheduling?.label ?? "Awaiting coordinator disposition",
        hrefFor("tasks", { task: task.id }),
      );
  }
  const config = configResource.state.data;
  if (config?.problems?.length)
    add(
      1,
      "danger",
      "Setup",
      `Configuration problems (${config.problems.length}${config.problemsTruncated ? "+" : ""})`,
      `${config.problems[0].code}${config.problems[0].lane ? ` on ${config.problems[0].lane}` : ""}${config.problems.length > 1 ? " and more" : ""}`,
      hrefFor("setup"),
    );
  const recent = recentRefusals();
  if (recent.length)
    add(
      3,
      "warning",
      "Control log",
      `Commands that were not applied (${recent.length})`,
      `Latest: ${recent[0].action ?? "command"} · ${recent[0].reason ?? recent[0].outcome} in the last 24 hours`,
      hrefFor("audit"),
    );
  for (const orphan of store.data.orphanAssignments ?? [])
    add(
      6,
      "warning",
      "Orphan",
      `${orphan.task} has an assignment but no task card`,
      `Owner ${orphan.assignment?.owner ?? "unknown"}`,
      system,
    );
  return items.sort((a, b) => a.weight - b.weight);
}
function attentionRow(item) {
  const row = el("li", undefined, "attention-row");
  const anchor = link(item.href, undefined, "attention-link");
  const body = el("span", undefined, "attention-body");
  body.append(
    el("span", item.title, "attention-title"),
    el("span", item.note, "attention-note"),
  );
  anchor.append(badge(item.type, item.tone), body);
  row.append(anchor);
  return row;
}
function renderAttention() {
  const items = attentionItems();
  $("attention-count").textContent = items.length ? String(items.length) : "";
  const host = $("attention");
  const decisions = decisionBlock();
  if (!items.length) {
    host.replaceChildren(
      ...(decisions ? [decisions] : []),
      emptyState(
        "Nothing needs attention in this snapshot.",
        "No blocked tasks, open questions, submissions or health alerts were reported.",
      ),
    );
    return;
  }
  const list = el("ol", undefined, "attention-list");
  list.append(...items.slice(0, 8).map(attentionRow));
  const nodes = [...(decisions ? [decisions] : []), list];
  if (items.length > 8) {
    const more = el("details", undefined, "disclosure");
    more.dataset.key = "attention-more";
    const rest = el("ol", undefined, "attention-list");
    rest.append(...items.slice(8).map(attentionRow));
    more.append(el("summary", `${items.length - 8} more`), rest);
    nodes.push(more);
  }
  host.replaceChildren(...nodes);
}
function renderMetrics() {
  const states = (...names) =>
    store.data.tasks.filter((t) => names.includes(t.state)).length;
  const lanes = store.data.headless?.lanes ?? [];
  const running = lanes.filter((lane) => lane.status === "running").length;
  $("metrics").replaceChildren(
    ...[
      [store.data.tasks.length, "Tracked tasks", hrefFor("tasks")],
      [
        states("working", "assigned"),
        "Active assignments",
        hrefFor("tasks", { state: "active" }),
      ],
      [
        states("blocked", "review"),
        "Blocked or awaiting review",
        hrefFor("tasks", { state: "attention" }),
      ],
      [
        states("completed"),
        "Completed",
        hrefFor("tasks", { state: "completed" }),
      ],
      [
        store.data.unanswered.length,
        "Open questions / requests",
        hrefFor("messages", { filter: "open" }),
      ],
      [running, "Running processes", hrefFor("agents", { status: "running" })],
    ].map(([count, label, href]) => {
      const tile = link(href, undefined, "metric");
      tile.append(el("strong", String(count)), el("span", label));
      return tile;
    }),
  );
}
function renderHealthSummary() {
  const headless = store.data.headless;
  const rows = [
    ["Supervisor", headless?.state ?? "unknown"],
    ["Watcher", store.data.monitor?.state ?? "unknown"],
    ["Watchdog", store.data.watchdog?.state ?? "unknown"],
  ];
  const list = el("ul", undefined, "health-list");
  for (const [label, state] of rows) {
    const row = el("li");
    row.append(el("span", label), healthBadge(state));
    list.append(row);
  }
  const held = headless?.instanceHeld
    ? ["all lanes (instance hold)"]
    : (headless?.held ?? []);
  const nodes = [list];
  if (held.length) nodes.push(el("p", `Held: ${held.join(", ")}`, "note"));
  const notice = instanceHoldNotice(headless);
  if (notice) nodes.push(notice);
  $("health-summary").replaceChildren(...nodes);
}
function renderTaskSummary() {
  const total = store.data.tasks.length;
  const host = $("task-summary");
  if (!total) {
    host.replaceChildren(
      emptyState(
        "No task cards found.",
        "Add Markdown task cards to the configured tasks path.",
      ),
    );
    return;
  }
  const counts = Object.keys(stateLabels).map((state) => [
    state,
    store.data.tasks.filter((t) => t.state === state).length,
  ]);
  const bar = el("div", undefined, "stack");
  bar.setAttribute("role", "img");
  bar.setAttribute(
    "aria-label",
    counts.map(([s, n]) => `${stateLabels[s]}: ${n}`).join(", "),
  );
  for (const [state, count] of counts) {
    if (!count) continue;
    const segment = el(
      "span",
      undefined,
      `stack-segment tone-${stateTones[state]}`,
    );
    segment.style.flexGrow = String(count);
    bar.append(segment);
  }
  const legend = el("ul", undefined, "legend");
  for (const [state, count] of counts) {
    const row = el("li");
    const anchor = link(hrefFor("tasks", { state }), undefined, "legend-link");
    anchor.append(taskBadge(state), el("strong", String(count)));
    row.append(anchor);
    legend.append(row);
  }
  host.replaceChildren(bar, legend);
}
function renderAgentSummary() {
  const agents = agentRecords();
  const host = $("agent-summary");
  if (!agents.length) {
    host.replaceChildren(
      emptyState(
        "No agents configured or assigned yet.",
        "Agents appear once a task is assigned or the supervisor is configured.",
      ),
    );
    return;
  }
  const list = el("ul", undefined, "agent-glance");
  for (const agent of agents.slice(0, 8)) {
    const row = el("li");
    row.dataset.lane = agent.lane;
    row.append(
      agentLink(agent.lane, "agent-glance-name"),
      processBadge(agent.status),
      agent.task
        ? taskLink(agent.task, "mono agent-glance-task")
        : el("span", "No task", "agent-glance-task is-unknown"),
    );
    list.append(row);
  }
  const nodes = [list];
  if (agents.length > 8)
    nodes.push(
      link(hrefFor("agents"), `All ${agents.length} agents`, "panel-link"),
    );
  host.replaceChildren(...nodes);
}
function renderShortcuts() {
  const count = (...names) =>
    store.data.tasks.filter((t) => names.includes(t.state)).length;
  const links = [
    [
      "Open questions",
      store.data.unanswered.length,
      hrefFor("messages", { filter: "open" }),
    ],
    ["Blocked tasks", count("blocked"), hrefFor("tasks", { state: "blocked" })],
    [
      "Awaiting disposition",
      count("review"),
      hrefFor("tasks", { state: "review" }),
    ],
    ["Run history", null, hrefFor("runs")],
    ["Relationships", null, hrefFor("relationships")],
    ["Project notes", null, hrefFor("system")],
    [
      "Setup & config",
      configResource.state.data
        ? configResource.state.data.problems.length
        : null,
      hrefFor("setup"),
    ],
    ["Usage & cost", null, hrefFor("usage")],
    ["Evidence", null, hrefFor("evidence")],
    ["Control log", null, hrefFor("audit")],
  ];
  $("shortcuts").replaceChildren(
    ...links.map(([label, value, href]) => {
      const row = el("li");
      const anchor = link(href, undefined, "shortcut");
      anchor.append(el("span", label));
      if (value !== null) anchor.append(el("strong", String(value)));
      row.append(anchor);
      return row;
    }),
  );
}
export function renderOverview() {
  renderMetrics();
  renderAttention();
  renderHealthSummary();
  renderTaskSummary();
  renderAgentSummary();
  renderShortcuts();
}
