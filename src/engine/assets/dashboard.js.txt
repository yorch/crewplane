const $ = (id) => document.getElementById(id);
const labels = {
  todo: "To do",
  assigned: "Assigned",
  working: "In progress",
  blocked: "Blocked",
  review: "Submitted / disposition",
  completed: "Completed / accepted slice",
};
let data;
let fingerprint;
let busy = false;
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function detail(title, text, key) {
  const node = el("details");
  if (key) node.dataset.key = key;
  node.append(el("summary", title), el("pre", text));
  return node;
}
function date(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(new Date(value).getTime())
  )
    return "not reported";
  return new Date(value).toLocaleString();
}
function matches(text) {
  return text.toLowerCase().includes($("search").value.toLowerCase());
}
function visibleMessage(message) {
  return (
    (!$("agent").value ||
      [message.from, message.to].includes($("agent").value) ||
      message.to === "all") &&
    (!$("phase").value ||
      data.tasks.find((t) => t.id === message.task)?.phase ===
        $("phase").value) &&
    matches(
      `${message.text} ${message.task ?? ""} ${message.from} ${message.to}`,
    )
  );
}
function messageCard(message, threaded = true) {
  const card = el("article", undefined, "message");
  card.id = `message-${message.id}`;
  const meta = el("div", undefined, "meta");
  meta.append(
    el("span", message.kind, "pill"),
    el(
      "span",
      `${message.from} → ${message.to} · ${message.task ?? "General"} · ${date(message.at)}`,
    ),
  );
  card.append(
    meta,
    detail(message.text.split("\n")[0].slice(0, 160), message.text, message.id),
  );
  if (message.replyTo) {
    const parent = data.messages.find((m) => m.id === message.replyTo);
    if (parent)
      card.append(
        detail(
          `Reply to ${parent.from}: ${parent.text.slice(0, 90)}`,
          parent.text,
          `parent-${message.id}`,
        ),
      );
  }
  if (threaded) {
    for (const reply of data.messages.filter((m) => m.replyTo === message.id)) {
      const child = el("div", undefined, "reply");
      child.append(
        el("p", `${reply.from} · ${reply.kind} · ${date(reply.at)}`),
        detail(
          reply.text.split("\n")[0].slice(0, 120),
          reply.text,
          `reply-${reply.id}`,
        ),
      );
      card.append(child);
    }
  }
  return card;
}
function render() {
  if (!data) return;
  const activeControl = document.activeElement;
  const focusedDetail =
    activeControl?.tagName === "SUMMARY"
      ? activeControl.parentElement?.dataset.key
      : null;
  const scrollPosition = { x: window.scrollX, y: window.scrollY };
  const detailScroll = new Map(
    [...document.querySelectorAll("details[data-key]")].map((n) => [
      n.dataset.key,
      n.querySelector("pre")?.scrollTop ?? 0,
    ]),
  );
  const open = new Set(
    [...document.querySelectorAll("details[open][data-key]")].map(
      (n) => n.dataset.key,
    ),
  );
  const headless = data.headless;
  $("headless-status").textContent = headless?.state ?? "not-started";
  $("headless-note").textContent = headless?.checkedAt
    ? `Checked ${date(headless.checkedAt)} · Held lanes: ${headless.held.join(", ") || "none"} · Disk config: ${headless.diskConfigAvailable ? "readable" : "unavailable"} · Loaded config: ${headless.configState ?? "unknown"} · Reload: ${headless.configReload ? `${headless.configReload.outcome}${headless.configReload.errorCode ? ` (${headless.configReload.errorCode})` : ""} at ${date(headless.configReload.evaluatedAt)}` : "not reported"}`
    : "Not started. Dedicated sessions require an exclusive ownership handover.";
  const budgets = headless?.budgets;
  $("headless-budgets").textContent = budgets
    ? `Limits (${headless.budgetsSource ?? "unknown source"}): ${budgets.maxParallel} concurrent lanes · ${budgets.maxRunMinutes} minutes/run · ${budgets.maxRunsPerHour} runs/lane/hour · heartbeat interval ${budgets.intervalSeconds}s`
    : "Supervisor budgets unavailable";
  $("headless-lanes").replaceChildren(
    ...(headless?.lanes ?? []).map((lane) => {
      const card = el("article", undefined, "agent-card");
      card.dataset.lane = lane.lane;
      card.append(el("h3", `Agent ${lane.lane} · ${lane.status}`));
      const rows = [
        ["Harness", lane.harness],
        [
          "Scheduling",
          `${lane.scheduling?.code ?? "Unknown"}${lane.scheduling?.nextEligibleAt ? ` · next slot ${date(lane.scheduling.nextEligibleAt)}` : ""}`,
        ],
        [
          "Open assignments",
          (lane.assignments ?? [])
            .map((t) => `${t.task} · ${t.state}`)
            .join(", ") || "None",
        ],
        ["Configured model", lane.configuredModel],
        ["Observed model", lane.observedModel ?? "Not recorded"],
        [
          "Task report",
          `${lane.task ?? "No task / coordination"} · ${lane.taskStatus ?? "No report"}`,
        ],
        [
          "Verified acceptance",
          lane.acceptedCommit ?? "None recorded for this task",
        ],
        ["Worktree", lane.worktree ?? "No run recorded"],
        ["Branch", lane.branch ?? "Unknown"],
        ["Native session", lane.sessionId ?? "Not recorded"],
        [
          "Process",
          `PID ${lane.pid ?? "unknown"} · liveness ${lane.processAlive === null ? "unknown" : lane.processAlive ? "observed alive" : "not alive"} · reported ${lane.reportedProcessStatus ?? "none"}`,
        ],
        ["Last start", lane.startedAt ? date(lane.startedAt) : "Not recorded"],
        [
          "Last finish",
          lane.finishedAt ? date(lane.finishedAt) : "Not recorded",
        ],
        [
          "Supervisor heartbeat",
          lane.heartbeatAt ? date(lane.heartbeatAt) : "Not recorded",
        ],
        ["Reason / pause / failure", lane.reason],
        [
          "Recorded usage (latest session)",
          `${lane.usage.inputTokens ?? "unknown"} input / ${lane.usage.outputTokens ?? "unknown"} output tokens · ${lane.usage.runsLastHour} runs in last hour`,
        ],
      ];
      const list = el("dl");
      for (const [label, value] of rows)
        list.append(el("dt", label), el("dd", value));
      card.append(list);
      return card;
    }),
  );
  if (data.graphCoverage)
    $("graph-note").textContent =
      `Graph ${data.graphCoverage.state ?? "available"}. Input: ${data.graphCoverage.tasksIncluded ?? "unknown"}/${data.graphCoverage.tasksTotal ?? "unknown"} tasks, ${data.graphCoverage.lanesIncluded ?? "unknown"}/${data.graphCoverage.lanesTotal ?? "unknown"} agents. Full task board remains available. Display data grants no execution authority.`;
  window.crewplaneGraphSnapshot = {
    graphs: data.graphs,
    coverage: data.graphCoverage,
  };
  window.dispatchEvent(
    new CustomEvent("crewplane-graphs", {
      detail: window.crewplaneGraphSnapshot,
    }),
  );
  const monitor = data.monitor;
  $("monitor-status").textContent = monitor?.state ?? "not-started";
  $("monitor-note").textContent = monitor?.checkedAt
    ? `Last watcher check: ${date(monitor.checkedAt)}. ${monitor.error ?? "Reports are observations; agents still post their own progress and answers."}`
    : "Start with crewplane monitor. The dashboard continues reading the live board independently.";
  const watchdog = data.watchdog;
  $("monitor-note").textContent +=
    ` Watchdog: ${watchdog?.state ?? "unavailable"}; last ${date(watchdog?.checkedAt)}, next ${date(watchdog?.nextCheck)}; recovery disabled. Unavailable signals: ${watchdog?.unavailableSignals?.join(", ") ?? "unknown"}.`;
  $("monitor-alerts").replaceChildren(
    ...(watchdog?.codes ?? []).map((code) =>
      el(
        "p",
        `WATCHDOG · ${code} · persistent observation; inspect before retry`,
        "watch-alert",
      ),
    ),
    ...(monitor?.alerts ?? []).map((alert) =>
      el(
        "p",
        `${alert.agent} · ${alert.task ?? "General"} · ${alert.text}`,
        "watch-alert",
      ),
    ),
  );
  const states = (state) => data.tasks.filter((t) => t.state === state).length;
  $("metrics").replaceChildren(
    ...[
      [data.tasks.length, "Tracked tasks"],
      [states("completed"), "Completed / accepted"],
      [states("working") + states("assigned"), "Active assignments"],
      [states("blocked") + states("review"), "Blocked / awaiting review"],
      [data.unanswered.length, "Open questions / requests"],
    ].map(([count, label]) => {
      const node = el("div", undefined, "metric");
      node.append(el("strong", String(count)), el("span", label));
      return node;
    }),
  );
  const filtered = data.tasks.filter(
    (t) =>
      (!$("agent").value || t.owner === $("agent").value) &&
      (!$("phase").value || t.phase === $("phase").value) &&
      (!$("state").value || t.state === $("state").value) &&
      matches(`${t.id} ${t.title} ${t.goal} ${t.live?.status?.text ?? ""}`),
  );
  $("task-count").textContent = `${filtered.length} of ${data.tasks.length}`;
  $("tasks").replaceChildren(
    ...[
      ["To do", ["todo"]],
      ["Assigned", ["assigned"]],
      ["In progress", ["working", "blocked"]],
      ["Review", ["review"]],
      ["Completed", ["completed"]],
    ].map(([name, states]) => {
      const column = el("div", undefined, "column");
      const tasks = filtered.filter((t) => states.includes(t.state));
      column.append(el("h3", `${name} · ${tasks.length}`));
      for (const task of tasks) {
        const card = el("article", undefined, "card");
        card.dataset.taskId = task.id;
        const meta = el("div", undefined, "meta");
        meta.append(
          el("span", `Agent ${task.owner}`, "pill"),
          el("span", labels[task.state], `pill ${task.state}`),
        );
        card.append(meta, el("h4", task.title), el("p", task.goal));
        if (task.live && !task.live.accepted && task.scheduling)
          card.append(el("p", task.scheduling.label, "note"));
        if (task.live?.status)
          card.append(
            detail(
              `Latest update · ${date(task.live.status.at)}`,
              task.live.status.text,
              `status-${task.id}`,
            ),
          );
        if (task.live?.accepted)
          card.append(
            detail(
              `Accepted · ${task.live.accepted.commit.slice(0, 8)}`,
              task.live.accepted.text,
              `accept-${task.id}`,
            ),
          );
        const context = [
          task.documentedStatus,
          `Dependencies: ${task.dependencies}`,
          task.live?.claim
            ? `Branch: ${task.live.claim.branch}\nWorktree: ${task.live.claim.worktree}`
            : "",
          task.markdown,
        ].join("\n\n");
        card.append(
          detail("Scope, dependencies & task card", context, task.id),
        );
        column.append(card);
      }
      if (!tasks.length) column.append(el("p", "No tasks", "empty"));
      return column;
    }),
  );
  const questions = data.unanswered.filter(visibleMessage);
  $("question-count").textContent = String(questions.length);
  $("questions").replaceChildren(...questions.map((m) => messageCard(m)));
  if (!questions.length)
    $("questions").append(el("p", "No open questions in this view.", "empty"));
  const messages = data.messages.filter(visibleMessage).toReversed();
  $("message-count").textContent = String(messages.length);
  $("messages").replaceChildren(...messages.map((m) => messageCard(m, false)));
  if (!messages.length)
    $("messages").append(el("p", "No messages in this view.", "empty"));
  $("milestones").textContent = data.milestoneStatus;
  for (const node of document.querySelectorAll("details[data-key]")) {
    node.open = open.has(node.dataset.key);
    const pre = node.querySelector("pre");
    if (pre) pre.scrollTop = detailScroll.get(node.dataset.key) ?? 0;
  }
  if (focusedDetail && activeControl && !activeControl.isConnected) {
    [...document.querySelectorAll("details[data-key]")]
      .find((n) => n.dataset.key === focusedDetail)
      ?.querySelector("summary")
      ?.focus({ preventScroll: true });
  }
  window.scrollTo(scrollPosition.x, scrollPosition.y);
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok)
      throw new Error(`Dashboard data unavailable (${response.status}).`);
    const next = await response.json();
    const { updatedAt, ...content } = next;
    const signature = JSON.stringify(content);
    data = next;
    if (signature !== fingerprint) {
      const agents = [
        ...new Set([
          ...(next.headless?.lanes ?? []).map((a) => a.lane),
          ...next.tasks.map((t) => t.owner).filter((id) => id !== "—"),
        ]),
      ].sort();
      for (const id of ["agent", "run-lane"]) {
        const select = $(id),
          selected = select.value;
        const signature = JSON.stringify(agents);
        if (select.dataset.options !== signature) {
          select.replaceChildren(
            new Option("All agents", ""),
            ...agents.map((agent) => new Option(agent, agent)),
          );
          select.value = selected;
          select.dataset.options = signature;
        }
      }
      const phases = [...new Set(next.tasks.map((t) => t.phase))].sort();
      const current = $("phase").value;
      $("phase").replaceChildren(
        new Option("All phases", ""),
        ...phases.map((p) => new Option(`Phase ${p}`, p)),
      );
      $("phase").value = current;
      render();
      fingerprint = signature;
    }
    $("connection").textContent = `Live · checked ${date(updatedAt)}`;
    $("error").hidden = true;
  } catch (error) {
    $("connection").textContent = "Disconnected · retrying every 5s";
    $("error").hidden = false;
    $("error").textContent =
      `${error.message} Showing the last successful snapshot, if available.`;
  } finally {
    busy = false;
  }
}
for (const id of ["search", "agent", "phase", "state"])
  $(id).addEventListener("input", render);
$("refresh").addEventListener("click", refresh);
refresh();
setInterval(refresh, 5000);
