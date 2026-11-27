import { processBadge, progressBadge } from "./badges.js";
import { laneControls } from "./controls.js";
import {
  closeLink,
  detailHeading,
  el,
  emptyState,
  fields,
  includesText,
  link,
  section,
} from "./dom.js";
import { clearButton, syncClear } from "./filters.js";
import { formatCount } from "./format.js";
import { instanceHoldNotice } from "./hold-notice.js";
import { PROCESS_ORDER, progressLabels } from "./labels.js";
import { taskLink } from "./links.js";
import { hrefFor } from "./route.js";
import { $, store } from "./store.js";
import { timeEl } from "./time.js";

export function agentRecords() {
  const lanes = store.data.headless?.lanes ?? [];
  const known = new Set(lanes.map((lane) => lane.lane));
  const owners = [
    ...new Set(
      store.data.tasks
        .map((task) => task.owner)
        .filter((owner) => owner !== "—" && !known.has(owner)),
    ),
  ].map((owner) => ({ lane: owner, status: null, ownerOnly: true }));
  const rank = (status) => {
    const index = PROCESS_ORDER.indexOf(status);
    return index === -1 ? PROCESS_ORDER.length : index;
  };
  return [...lanes, ...owners].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      a.lane.localeCompare(b.lane, undefined, { numeric: true }),
  );
}
function agentMatches(agent, params) {
  if (params.status) {
    if (params.status === "unknown") {
      if (agent.status) return false;
    } else if (agent.status !== params.status) return false;
  }
  return includesText(
    `${agent.lane} ${agent.task ?? ""} ${agent.configuredModel ?? ""} ${agent.observedModel ?? ""} ${agent.status ?? ""}`,
    params.q,
  );
}
function pairLine(label, value, field) {
  const line = el("div", undefined, "pair-line");
  line.dataset.field = field;
  const missing = value === null || value === undefined || value === "";
  line.append(
    el("span", label, "pair-label"),
    el(
      "span",
      missing ? "Not recorded" : String(value),
      missing ? "pair-value is-unknown" : "pair-value",
    ),
  );
  return line;
}
function pairCell(label, configured, observed, prefix) {
  const wrap = el("div", undefined, "pair");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", label);
  wrap.append(
    pairLine("Configured", configured, `configured-${prefix}`),
    pairLine("Observed", observed, `observed-${prefix}`),
  );
  return wrap;
}
function agentRow(agent) {
  const selected = store.route.params.agent === agent.lane;
  const row = el("tr", undefined, selected ? "is-selected" : undefined);
  row.setAttribute("role", "row");
  row.dataset.lane = agent.lane;
  const cell = (label, ...children) => {
    const node = el("td");
    node.setAttribute("role", "cell");
    node.dataset.label = label;
    node.append(...children);
    return node;
  };
  const name = link(
    hrefFor("agents", { ...store.route.params, agent: agent.lane }),
    agent.lane,
    "agent-name",
  );
  name.dataset.focusKey = `agent:${agent.lane}`;
  if (selected) name.setAttribute("aria-current", "true");
  row.append(
    cell("Agent", name),
    cell("Process", processBadge(agent.status)),
    cell(
      "Task progress",
      progressBadge(agent.taskStatus ?? null, Boolean(agent.task)),
    ),
    cell(
      "Task",
      agent.task
        ? taskLink(agent.task, "mono")
        : el("span", "None", "is-unknown"),
    ),
    cell(
      "Model",
      pairCell("Model", agent.configuredModel, agent.observedModel, "model"),
    ),
    cell(
      "Harness",
      pairCell(
        "Harness",
        agent.configuredHarness,
        agent.observedHarness,
        "harness",
      ),
    ),
  );
  return row;
}
export function renderAgents() {
  const params = store.route.params;
  const all = agentRecords();
  const rows = all.filter((agent) => agentMatches(agent, params));
  $("agent-count").textContent = `${rows.length} of ${all.length} agents`;
  syncClear("agents");
  const headless = store.data.headless;
  const budgets = headless?.budgets;
  $("agents-supervisor").textContent =
    `Supervisor ${headless?.state ?? "unknown"}${budgets ? ` · ${formatCount(budgets.maxParallel) ?? "not recorded"} concurrent lanes · ${formatCount(budgets.maxRunsPerHour) ?? "not recorded"} runs/lane/hour` : ""}`;
  $("agents-hold").replaceChildren(
    ...[instanceHoldNotice(headless)].filter(Boolean),
  );
  const host = $("headless-lanes");
  if (!all.length) {
    host.replaceChildren(
      emptyState(
        "No agents configured or assigned yet.",
        "Agents appear once a task is assigned or the supervisor is configured.",
      ),
    );
  } else if (!rows.length) {
    const empty = emptyState("No agents match these filters.");
    empty.append(clearButton("agents"));
    host.replaceChildren(empty);
  } else {
    const table = el("table", undefined, "agents-table");
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", "Agents");
    const head = el("thead");
    head.setAttribute("role", "rowgroup");
    const header = el("tr");
    header.setAttribute("role", "row");
    for (const label of [
      "Agent",
      "Process",
      "Task progress",
      "Task",
      "Model",
      "Harness",
    ]) {
      const th = el("th", label);
      th.setAttribute("role", "columnheader");
      th.scope = "col";
      header.append(th);
    }
    head.append(header);
    const body = el("tbody");
    body.setAttribute("role", "rowgroup");
    body.append(...rows.map(agentRow));
    table.append(head, body);
    host.replaceChildren(table);
  }
  renderAgentDetail(all);
}
function renderAgentDetail(all) {
  const pane = $("agent-detail");
  const split = $("agents-split");
  const id = store.route.params.agent;
  split.classList.toggle("has-detail", Boolean(id));
  pane.hidden = !id;
  if (!id) {
    pane.replaceChildren();
    return;
  }
  const closeHref = hrefFor("agents", {
    ...store.route.params,
    agent: undefined,
  });
  pane.setAttribute("aria-labelledby", "agent-detail-title");
  const agent = all.find((candidate) => candidate.lane === id);
  const links = el("div", undefined, "detail-actions");
  links.append(
    link(hrefFor("tasks", { agent: id }), "Tasks"),
    link(hrefFor("messages", { filter: "all", agent: id }), "Messages"),
    link(hrefFor("runs", { lane: id }), "Runs"),
  );
  if (!agent || agent.ownerOnly) {
    pane.replaceChildren(
      closeLink(closeHref, "Close agent details"),
      detailHeading(id, "agent-detail-title"),
      emptyState(
        "No process record for this agent.",
        "It is named in task or message data, but the supervisor has not recorded a run. Model and process state are unknown.",
      ),
      links,
    );
    return;
  }
  const alive =
    agent.processAlive === null
      ? "unknown"
      : agent.processAlive
        ? "observed alive"
        : "not alive";
  const usage = agent.usage ?? {};
  const assignments = el("ul", undefined, "link-list");
  for (const assignment of agent.assignments ?? []) {
    const row = el("li");
    row.append(
      taskLink(assignment.task, "mono"),
      ` · ${progressLabels[assignment.state] ?? assignment.state}`,
    );
    assignments.append(row);
  }
  const header = el("div", undefined, "detail-header");
  const tags = el("div", undefined, "detail-tags");
  tags.append(
    processBadge(agent.status),
    progressBadge(agent.taskStatus ?? null, Boolean(agent.task)),
  );
  header.append(tags, detailHeading(agent.lane, "agent-detail-title"));
  pane.replaceChildren(
    closeLink(closeHref, "Close agent details"),
    header,
    section("Quick links", links),
    ...[laneControls(agent.lane)].filter(Boolean),
    section(
      "Current task",
      fields([
        [
          "Task",
          agent.task ? taskLink(agent.task, "mono") : null,
          "No task / coordination",
        ],
        [
          "Task report",
          agent.taskStatus
            ? (progressLabels[agent.taskStatus] ?? agent.taskStatus)
            : null,
          "No report",
        ],
        [
          "Verified acceptance",
          agent.acceptedCommit,
          "None recorded for this task",
        ],
      ]),
      agent.assignments?.length
        ? assignments
        : el("p", "No open assignments.", "note"),
    ),
    section(
      "Model & harness",
      pairCell("Model", agent.configuredModel, agent.observedModel, "model"),
      pairCell(
        "Harness",
        agent.configuredHarness,
        agent.observedHarness,
        "harness",
      ),
      el("p", agent.harness, "note"),
    ),
    section(
      "Process",
      fields([
        ["PID", agent.pid, "unknown"],
        ["Liveness", alive],
        ["Reported status", agent.reportedProcessStatus, "none"],
        ["Last start", agent.startedAt ? timeEl(agent.startedAt) : null],
        ["Last finish", agent.finishedAt ? timeEl(agent.finishedAt) : null],
        [
          "Supervisor heartbeat",
          agent.heartbeatAt ? timeEl(agent.heartbeatAt) : null,
        ],
        ["Reason / pause / failure", agent.reason],
      ]),
    ),
    section(
      "Scheduling",
      fields([
        ["Code", agent.scheduling?.code, "Unknown"],
        ["Queue position", agent.scheduling?.position],
        [
          "Next slot",
          agent.scheduling?.nextEligibleAt
            ? timeEl(agent.scheduling.nextEligibleAt)
            : null,
        ],
      ]),
    ),
    section(
      "Workspace",
      fields([
        ["Worktree", agent.worktree, "No run recorded"],
        ["Branch", agent.branch, "Unknown"],
        ["Native session", agent.sessionId],
      ]),
    ),
    section(
      "Recorded usage (latest session)",
      fields([
        ["Input tokens", usage.inputTokens, "unknown"],
        ["Output tokens", usage.outputTokens, "unknown"],
        ["Runs in last hour", usage.runsLastHour, "unknown"],
      ]),
      el("p", "Retained counters; these are not billing totals.", "note"),
    ),
  );
}
