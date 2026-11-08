const $ = (id) => document.getElementById(id);

const VIEW_META = {
  overview: {
    title: "Overview",
    subtitle: "What needs attention now, and how the crew is doing.",
  },
  tasks: {
    title: "Tasks",
    subtitle: "Reported progress and accepted work.",
  },
  agents: {
    title: "Agents",
    subtitle: "Process observations, kept separate from task progress.",
  },
  messages: {
    title: "Messages",
    subtitle: "Open questions and full thread context.",
  },
  runs: {
    title: "Runs",
    subtitle: "Sanitized run history and event timelines.",
  },
  relationships: {
    title: "Relationships",
    subtitle: "Recorded communication and task dependencies.",
  },
  system: {
    title: "System & notes",
    subtitle: "Supervisor, watchers, budgets and project notes.",
  },
};
const ROUTE_PARAMS = {
  overview: [],
  tasks: ["q", "agent", "phase", "state", "layout", "task"],
  agents: ["q", "status", "agent"],
  messages: ["filter", "q", "agent", "phase", "thread"],
  runs: ["lane", "harness", "task", "run"],
  relationships: ["graph"],
  system: [],
};
const ENUM_PARAMS = {
  state: [
    "active",
    "attention",
    "todo",
    "assigned",
    "working",
    "blocked",
    "review",
    "completed",
  ],
  layout: ["board", "list"],
  filter: ["open", "all"],
  status: ["running", "stale", "paused", "idle", "standby", "unknown"],
  harness: ["codex", "pi"],
  graph: ["communication", "dependencies"],
};
const SELECTION_PARAM = {
  tasks: "task",
  agents: "agent",
  messages: "thread",
  runs: "run",
};
const FILTER_CONTROLS = [
  ["search", "tasks", "q"],
  ["agent", "tasks", "agent"],
  ["phase", "tasks", "phase"],
  ["state", "tasks", "state"],
  ["agent-search", "agents", "q"],
  ["agent-status", "agents", "status"],
  ["message-search", "messages", "q"],
  ["message-agent", "messages", "agent"],
  ["message-phase", "messages", "phase"],
];
const CLEARABLE = {
  tasks: { keys: ["q", "agent", "phase", "state"], focus: "search" },
  agents: { keys: ["q", "status"], focus: "agent-search" },
  messages: { keys: ["q", "agent", "phase"], focus: "message-search" },
};
const MAX_PARAM_LENGTH = 256;
const MAX_HASH_LENGTH = 2048;
const LAYOUT_KEY = "crewplane.tasks.layout";

const stateLabels = {
  todo: "To do",
  assigned: "Assigned",
  working: "In progress",
  blocked: "Blocked",
  review: "Submitted",
  completed: "Completed",
};
const stateTones = {
  todo: "neutral",
  assigned: "neutral",
  working: "info",
  blocked: "danger",
  review: "warning",
  completed: "success",
};
const STATE_GROUPS = {
  active: ["working", "assigned"],
  attention: ["blocked", "review"],
};
const BOARD_COLUMNS = [
  ["To do", ["todo"]],
  ["Assigned", ["assigned"]],
  ["In progress", ["working", "blocked"]],
  ["Submitted", ["review"]],
  ["Completed", ["completed"]],
];
const processLabels = {
  running: "Running",
  stale: "Stale",
  paused: "Paused",
  idle: "Idle",
  standby: "Standby",
};
const processTones = {
  running: "success",
  stale: "danger",
  paused: "warning",
  idle: "neutral",
  standby: "neutral",
};
const PROCESS_ORDER = ["stale", "paused", "running", "idle", "standby"];
const progressLabels = {
  working: "In progress",
  ready: "Submitted",
  blocked: "Blocked",
  assigned: "Assigned",
  accepted: "Accepted",
};
const progressTones = {
  working: "info",
  ready: "warning",
  blocked: "danger",
  assigned: "neutral",
  accepted: "success",
};
const healthTones = {
  running: "success",
  observing: "success",
  current: "success",
  draining: "warning",
  alert: "danger",
  stale: "danger",
  error: "danger",
  stopped: "neutral",
  "not-started": "neutral",
  unavailable: "unknown",
  unknown: "unknown",
};
const ICONS = {
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  alert: "M12 4l9 16H3zM12 10v4M12 17.5v.01",
  check: "M5 13l4 4 10-11",
};

let data;
let fingerprint;
let busy = false;
let lastSuccess = null;
let internalNavigation = false;
let messageLimit = 100;
const filterMemory = {};
const scrollMemory = new Map();
const compactLayout = window.matchMedia("(max-width: 860px)");
const stackedLayout = window.matchMedia("(max-width: 1100px)");
let route = parseHash(window.location.hash);

function cleanParam(key, value) {
  if (value.length > MAX_PARAM_LENGTH || /\p{Cc}/u.test(value)) return null;
  const allowed = ENUM_PARAMS[key];
  return allowed && !allowed.includes(value) ? null : value;
}
function parseHash(hash) {
  const fallback = { view: "overview", params: {}, valid: false };
  if (hash === "" || hash === "#") return { ...fallback, valid: true };
  if (
    typeof hash !== "string" ||
    !hash.startsWith("#/") ||
    hash.length > MAX_HASH_LENGTH
  )
    return fallback;
  const body = hash.slice(2);
  const split = body.indexOf("?");
  const view = split === -1 ? body : body.slice(0, split);
  if (!Object.hasOwn(ROUTE_PARAMS, view)) return fallback;
  // URLSearchParams tolerates malformed percent escapes without throwing.
  const query = new URLSearchParams(split === -1 ? "" : body.slice(split + 1));
  const params = {};
  for (const key of ROUTE_PARAMS[view]) {
    const value = query.get(key);
    if (value === null || value === "") continue;
    const clean = cleanParam(key, value);
    if (clean !== null) params[key] = clean;
  }
  return { view, params, valid: true };
}
function hrefFor(view, params = {}) {
  const query = new URLSearchParams();
  for (const key of ROUTE_PARAMS[view] ?? [])
    if (params[key]) query.set(key, params[key]);
  const suffix = query.toString();
  return `#/${view}${suffix ? `?${suffix}` : ""}`;
}
function navigate(href) {
  if (href === window.location.hash) return;
  internalNavigation = true;
  window.location.hash = href;
}
function storedLayout() {
  try {
    const value = window.localStorage.getItem(LAYOUT_KEY);
    return value === "board" || value === "list" ? value : null;
  } catch {
    return null;
  }
}
function storeLayout(value) {
  try {
    window.localStorage.setItem(LAYOUT_KEY, value);
  } catch {
    // Storage can be disabled; the layout still applies through the URL.
  }
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(href, text, className) {
  const node = el("a", text, className);
  node.href = href;
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
function badge(text, tone = "neutral") {
  const node = el("span", undefined, `badge tone-${tone}`);
  node.append(el("span", undefined, "badge-dot"), el("span", text));
  return node;
}
function taskBadge(state) {
  return badge(stateLabels[state] ?? state, stateTones[state] ?? "unknown");
}
function processBadge(status) {
  if (!status) return badge("No record", "unknown");
  return badge(processLabels[status] ?? status, processTones[status]);
}
function progressBadge(status, hasTask) {
  if (!status) return badge(hasTask ? "No report" : "No task", "unknown");
  return badge(progressLabels[status] ?? status, progressTones[status]);
}
function healthBadge(state) {
  const text = String(state ?? "unknown");
  return badge(text.replace("-", " "), healthTones[text] ?? "unknown");
}
function detail(title, text, key) {
  const node = el("details", undefined, "disclosure");
  if (key) node.dataset.key = key;
  const body = el("pre", text);
  if (key) body.dataset.scrollKey = `pre-${key}`;
  node.append(el("summary", title), body);
  return node;
}
function validTime(value) {
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(new Date(value).getTime())
  );
}
function date(value) {
  if (!validTime(value)) return "not reported";
  return new Date(value).toLocaleString();
}
function relative(value) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < -60) return date(value);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function timeEl(value) {
  if (!validTime(value)) return el("span", "not reported", "is-unknown");
  const node = el("time", relative(value), "time");
  node.dateTime = new Date(value).toISOString();
  node.title = date(value);
  node.dataset.at = String(new Date(value).getTime());
  return node;
}
function refreshRelativeTimes() {
  for (const node of document.querySelectorAll("time[data-at]")) {
    const text = relative(Number(node.dataset.at));
    if (node.textContent !== text) node.textContent = text;
  }
}
function fields(rows, className) {
  const list = el(
    "dl",
    undefined,
    className ? `fields ${className}` : "fields",
  );
  for (const [label, value, unknownText] of rows) {
    const term = el("dt", label);
    const description = el("dd");
    if (value === null || value === undefined || value === "") {
      description.textContent = unknownText ?? "Not recorded";
      description.classList.add("is-unknown");
    } else if (value instanceof Node) description.append(value);
    else description.textContent = String(value);
    list.append(term, description);
  }
  return list;
}
function section(title, ...children) {
  const node = el("section", undefined, "detail-section");
  node.append(el("h3", title), ...children);
  return node;
}
function emptyState(title, hint) {
  const node = el("div", undefined, "empty-state");
  node.append(el("p", title, "empty-title"));
  if (hint) node.append(el("p", hint, "empty-hint"));
  return node;
}
function firstLine(text, limit = 160) {
  return String(text ?? "")
    .split("\n")[0]
    .slice(0, limit);
}
function agentLink(name, className) {
  if (name === "—" || !name) return el("span", "Unassigned", "is-unknown");
  if (name === "all") return el("span", "all agents", className);
  const node = link(hrefFor("agents", { agent: name }), name, className);
  node.dataset.agentLink = name;
  return node;
}
function taskLink(id, className, text = id) {
  return link(hrefFor("tasks", { task: id }), text, className);
}
function taskTitle(task) {
  const title = String(task.title ?? task.id);
  if (!title.startsWith(task.id)) return title;
  const trimmed = title.slice(task.id.length).replace(/^[\s:—–-]+/u, "");
  return trimmed || title;
}
function includesText(text, query) {
  return !query || text.toLowerCase().includes(query.toLowerCase());
}
function closeLink(href, label) {
  const node = el("a", undefined, "close-link");
  node.href = href;
  node.dataset.closeDetail = "true";
  node.setAttribute("aria-label", label);
  node.append(
    icon("back"),
    el("span", "Back", "narrow-only"),
    icon("close"),
    el("span", "Close", "wide-only"),
  );
  return node;
}
function detailHeading(text, id) {
  const heading = el("h2", text, "detail-title");
  heading.id = id;
  heading.tabIndex = -1;
  heading.dataset.focusKey = "detail-heading";
  return heading;
}

// ---- Rendering state ------------------------------------------------------

function activeView() {
  return $(`view-${route.view}`);
}
function captureUi() {
  const active = document.activeElement;
  let focusKey = null;
  let summaryKey = null;
  if (active && active !== document.body) {
    focusKey = active.dataset?.focusKey ?? null;
    if (active.tagName === "SUMMARY")
      summaryKey = active.parentElement?.dataset.key ?? null;
  }
  return {
    active,
    focusKey,
    summaryKey,
    x: window.scrollX,
    y: window.scrollY,
    open: new Set(
      [...document.querySelectorAll("details[open][data-key]")].map(
        (node) => node.dataset.key,
      ),
    ),
    scroll: new Map(
      [...document.querySelectorAll("[data-scroll-key]")].map((node) => [
        node.dataset.scrollKey,
        [node.scrollLeft, node.scrollTop],
      ]),
    ),
  };
}
function restoreUi(ui) {
  for (const node of document.querySelectorAll("details[data-key]"))
    node.open = ui.open.has(node.dataset.key);
  for (const node of document.querySelectorAll("[data-scroll-key]")) {
    const position = ui.scroll.get(node.dataset.scrollKey);
    if (position) [node.scrollLeft, node.scrollTop] = position;
  }
  if (ui.active && !ui.active.isConnected) {
    const view = activeView();
    let target = null;
    if (ui.focusKey)
      target = view.querySelector(
        `[data-focus-key="${CSS.escape(ui.focusKey)}"]`,
      );
    else if (ui.summaryKey)
      target = view.querySelector(
        `details[data-key="${CSS.escape(ui.summaryKey)}"] > summary`,
      );
    target?.focus({ preventScroll: true });
  }
  window.scrollTo(ui.x, ui.y);
}
function renderChrome() {
  const setCount = (view, count, label, tone) => {
    const node = document.querySelector(`[data-count="${view}"]`);
    if (!node) return;
    node.hidden = !count;
    node.className = `nav-count${tone ? ` nav-count-${tone}` : ""}`;
    node.replaceChildren();
    if (count) node.append(String(count), el("span", ` ${label}`, "sr-only"));
  };
  const blocked = data.tasks.filter((t) => t.state === "blocked").length;
  setCount("tasks", blocked, "blocked", blocked ? "danger" : "");
  setCount("messages", data.unanswered.length, "open", "warning");
  const running = (data.headless?.lanes ?? []).filter(
    (lane) => lane.status === "running",
  ).length;
  setCount("agents", running, "running", "");
}
function render() {
  if (!data) return;
  const ui = captureUi();
  renderChrome();
  const renderer = viewRenderers[route.view];
  if (renderer) renderer();
  restoreUi(ui);
}

// ---- Overview --------------------------------------------------------------

function attentionItems() {
  const items = [];
  const add = (weight, tone, type, title, note, href) =>
    items.push({ weight, tone, type, title, note, href });
  const system = hrefFor("system");
  const headless = data.headless;
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
  for (const code of data.watchdog?.codes ?? [])
    add(
      0,
      "danger",
      "Watchdog",
      `Watchdog reported ${code}`,
      "Persistent observation; inspect before retry.",
      system,
    );
  if (data.watchdog?.state === "stale")
    add(
      1,
      "warning",
      "Watchdog",
      "Watchdog check is stale",
      `Last check ${date(data.watchdog.checkedAt)}`,
      system,
    );
  for (const alert of data.monitor?.alerts ?? [])
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
  for (const task of data.tasks) {
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
  for (const message of data.unanswered)
    add(
      4,
      "warning",
      message.kind === "request" ? "Request" : "Question",
      `${message.from} → ${message.to}: ${firstLine(message.text, 120)}`,
      message.task ?? "General",
      hrefFor("messages", { filter: "open", thread: message.id }),
    );
  for (const task of data.tasks) {
    if (task.state === "review")
      add(
        5,
        "info",
        "Submitted",
        `${task.id} · ${taskTitle(task)}`,
        task.scheduling?.label ?? "Awaiting coordinator disposition",
        hrefFor("tasks", { task: task.id }),
      );
  }
  for (const orphan of data.orphanAssignments ?? [])
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
  if (!items.length) {
    host.replaceChildren(
      emptyState(
        "Nothing needs attention in this snapshot.",
        "No blocked tasks, open questions, submissions or health alerts were reported.",
      ),
    );
    return;
  }
  const list = el("ol", undefined, "attention-list");
  list.append(...items.slice(0, 8).map(attentionRow));
  const nodes = [list];
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
    data.tasks.filter((t) => names.includes(t.state)).length;
  const lanes = data.headless?.lanes ?? [];
  const running = lanes.filter((lane) => lane.status === "running").length;
  $("metrics").replaceChildren(
    ...[
      [data.tasks.length, "Tracked tasks", hrefFor("tasks")],
      [
        states("working", "assigned"),
        "Active assignments",
        hrefFor("tasks", { state: "active" }),
      ],
      [
        states("blocked", "review"),
        "Blocked / submitted",
        hrefFor("tasks", { state: "attention" }),
      ],
      [
        states("completed"),
        "Completed / accepted",
        hrefFor("tasks", { state: "completed" }),
      ],
      [
        data.unanswered.length,
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
  const headless = data.headless;
  const rows = [
    ["Supervisor", headless?.state ?? "unknown"],
    ["Watcher", data.monitor?.state ?? "unknown"],
    ["Watchdog", data.watchdog?.state ?? "unknown"],
  ];
  const list = el("ul", undefined, "health-list");
  for (const [label, state] of rows) {
    const row = el("li");
    row.append(el("span", label), healthBadge(state));
    list.append(row);
  }
  const held = headless?.held ?? [];
  const nodes = [list];
  if (held.length) nodes.push(el("p", `Held: ${held.join(", ")}`, "note"));
  $("health-summary").replaceChildren(...nodes);
}
function renderTaskSummary() {
  const total = data.tasks.length;
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
    data.tasks.filter((t) => t.state === state).length,
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
    data.tasks.filter((t) => names.includes(t.state)).length;
  const links = [
    [
      "Open questions",
      data.unanswered.length,
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
function renderOverview() {
  renderMetrics();
  renderAttention();
  renderHealthSummary();
  renderTaskSummary();
  renderAgentSummary();
  renderShortcuts();
}

// ---- Tasks -----------------------------------------------------------------

function taskLayout() {
  if (route.params.layout) return route.params.layout;
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
  const selected = route.params.task === task.id;
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
    hrefFor("tasks", { ...route.params, task: task.id }),
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
function renderTasks() {
  const params = route.params;
  const layout = taskLayout();
  for (const [id, value] of [
    ["layout-board", "board"],
    ["layout-list", "list"],
  ])
    $(id).setAttribute("aria-pressed", String(layout === value));
  const filtered = data.tasks.filter((task) => taskMatches(task, params));
  $("task-count").textContent =
    `${filtered.length} of ${data.tasks.length} tasks`;
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
  if (!data.tasks.length)
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
  return data.messages.filter((message) => message.task === taskId);
}
function renderTaskDetail() {
  const pane = $("task-detail");
  const split = $("tasks-split");
  const id = route.params.task;
  split.classList.toggle("has-detail", Boolean(id));
  pane.hidden = !id;
  if (!id) {
    pane.replaceChildren();
    return;
  }
  const closeHref = hrefFor("tasks", { ...route.params, task: undefined });
  pane.setAttribute("aria-labelledby", "task-detail-title");
  const task = data.tasks.find((candidate) => candidate.id === id);
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
  const open = data.unanswered.filter((message) => message.task === task.id);
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

// ---- Agents ----------------------------------------------------------------

function agentRecords() {
  const lanes = data.headless?.lanes ?? [];
  const known = new Set(lanes.map((lane) => lane.lane));
  const owners = [
    ...new Set(
      data.tasks
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
  const selected = route.params.agent === agent.lane;
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
    hrefFor("agents", { ...route.params, agent: agent.lane }),
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
function renderAgents() {
  const params = route.params;
  const all = agentRecords();
  const rows = all.filter((agent) => agentMatches(agent, params));
  $("agent-count").textContent = `${rows.length} of ${all.length} agents`;
  syncClear("agents");
  const headless = data.headless;
  const budgets = headless?.budgets;
  $("agents-supervisor").textContent =
    `Supervisor ${headless?.state ?? "unknown"}${budgets ? ` · ${budgets.maxParallel} concurrent lanes · ${budgets.maxRunsPerHour} runs/lane/hour` : ""}`;
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
  const id = route.params.agent;
  split.classList.toggle("has-detail", Boolean(id));
  pane.hidden = !id;
  if (!id) {
    pane.replaceChildren();
    return;
  }
  const closeHref = hrefFor("agents", { ...route.params, agent: undefined });
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

// ---- Messages --------------------------------------------------------------

function buildThreadIndex() {
  const byId = new Map(data.messages.map((message) => [message.id, message]));
  const children = new Map();
  for (const message of data.messages) {
    if (!message.replyTo) continue;
    const list = children.get(message.replyTo) ?? [];
    list.push(message);
    children.set(message.replyTo, list);
  }
  return { byId, children };
}
function threadRootId(index, message) {
  const seen = new Set();
  let current = message;
  while (
    current.replyTo &&
    index.byId.has(current.replyTo) &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    current = index.byId.get(current.replyTo);
  }
  return current.id;
}
function resolveThreadRoot(index, id) {
  const message = index.byId.get(id) ?? index.children.get(id)?.[0];
  return message ? threadRootId(index, message) : null;
}
function collectThread(index, rootId) {
  const ordered = [];
  const visited = new Set();
  const stack = [[rootId, 0]];
  while (stack.length) {
    const [id, depth] = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const message = index.byId.get(id);
    if (message) ordered.push({ message, depth });
    for (const child of (index.children.get(id) ?? []).toReversed())
      stack.push([child.id, depth + 1]);
  }
  return ordered;
}
function visibleMessage(message, params) {
  if (
    params.agent &&
    ![message.from, message.to].includes(params.agent) &&
    message.to !== "all"
  )
    return false;
  if (
    params.phase &&
    data.tasks.find((task) => task.id === message.task)?.phase !== params.phase
  )
    return false;
  return includesText(
    `${message.text} ${message.task ?? ""} ${message.from} ${message.to}`,
    params.q,
  );
}
function messageRow(message, open, index) {
  const row = el("li");
  const selected = route.params.thread === message.id;
  const anchor = link(
    hrefFor("messages", { ...route.params, thread: message.id }),
    undefined,
    `message-row${selected ? " is-selected" : ""}`,
  );
  anchor.dataset.focusKey = `message:${message.id}`;
  anchor.dataset.messageId = message.id;
  if (selected) anchor.setAttribute("aria-current", "true");
  const head = el("span", undefined, "message-row-head");
  head.append(
    badge(message.kind, open ? "warning" : "neutral"),
    el("span", `${message.from} → ${message.to}`, "message-route"),
    timeEl(message.at),
  );
  const replies = (index.children.get(message.id) ?? []).length;
  const meta = el("span", undefined, "message-row-meta");
  meta.append(el("span", message.task ?? "General", "mono"));
  if (replies)
    meta.append(
      el("span", `${replies} ${replies === 1 ? "reply" : "replies"}`),
    );
  if (open) meta.append(el("span", "Awaiting answer", "text-warning"));
  anchor.append(
    head,
    el("span", firstLine(message.text), "message-row-text"),
    meta,
  );
  row.append(anchor);
  return row;
}
function renderMessageList(index) {
  const params = route.params;
  const showOpen = (params.filter ?? "open") === "open";
  const openIds = new Set(data.unanswered.map((message) => message.id));
  const questions = data.unanswered.filter((m) => visibleMessage(m, params));
  const messages = data.messages
    .filter((m) => visibleMessage(m, params))
    .toReversed();
  $("question-count").textContent = String(questions.length);
  $("message-count").textContent = String(messages.length);
  $("messages-open").setAttribute("aria-pressed", String(showOpen));
  $("messages-all").setAttribute("aria-pressed", String(!showOpen));
  $("questions").hidden = !showOpen;
  $("messages").hidden = showOpen;
  const emptyNode = (title, hint) => {
    const node = emptyState(title, hint);
    if (hasClearable("messages")) node.append(clearButton("messages"));
    return node;
  };
  if (showOpen) {
    const list = el("ol", undefined, "message-rows");
    list.append(...questions.map((m) => messageRow(m, true, index)));
    $("questions").replaceChildren(
      questions.length
        ? list
        : emptyNode(
            "No open questions in this view.",
            "Questions and requests appear here until they receive an answer.",
          ),
    );
    $("messages").replaceChildren();
  } else {
    const visible = messages.slice(0, messageLimit);
    const list = el("ol", undefined, "message-rows");
    list.append(...visible.map((m) => messageRow(m, openIds.has(m.id), index)));
    const nodes = [
      messages.length ? list : emptyNode("No messages in this view."),
    ];
    if (messages.length > visible.length) {
      const more = el("button", "Show older messages", "more-button");
      more.type = "button";
      more.dataset.focusKey = "messages-more";
      more.addEventListener("click", () => {
        messageLimit += 100;
        render();
      });
      nodes.push(more);
    }
    $("messages").replaceChildren(...nodes);
    $("questions").replaceChildren();
  }
}
function renderThreadDetail(index) {
  const pane = $("thread-detail");
  const split = $("messages-split");
  const id = route.params.thread;
  split.classList.toggle("has-detail", Boolean(id));
  if (!id) {
    pane.removeAttribute("aria-labelledby");
    pane.replaceChildren(
      emptyState(
        "Select a conversation",
        "Pick a message to read its full thread and context.",
      ),
    );
    return;
  }
  const closeHref = hrefFor("messages", { ...route.params, thread: undefined });
  const close = closeLink(closeHref, "Close thread");
  const rootId = resolveThreadRoot(index, id);
  pane.setAttribute("aria-labelledby", "thread-detail-title");
  if (!rootId) {
    pane.replaceChildren(
      close,
      detailHeading("Thread unavailable", "thread-detail-title"),
      emptyState(
        "This conversation is not in the current snapshot.",
        "It may be older than the retained message history.",
      ),
    );
    return;
  }
  const thread = collectThread(index, rootId);
  const openIds = new Set(data.unanswered.map((message) => message.id));
  const openCount = thread.filter(({ message }) =>
    openIds.has(message.id),
  ).length;
  const root = thread[0]?.message;
  const header = el("div", undefined, "detail-header");
  const tags = el("div", undefined, "detail-tags");
  if (root?.task) tags.append(taskLink(root.task, "mono"));
  else tags.append(el("span", "General", "mono"));
  tags.append(
    badge(
      `${thread.length} ${thread.length === 1 ? "message" : "messages"}`,
      "neutral",
    ),
  );
  if (openCount) tags.append(badge(`${openCount} open`, "warning"));
  header.append(tags, detailHeading("Thread", "thread-detail-title"));
  const list = el("ol", undefined, "thread");
  for (const { message, depth } of thread) {
    const item = el("li", undefined, `thread-item depth-${Math.min(depth, 2)}`);
    const card = el(
      "article",
      undefined,
      `thread-message${message.id === id ? " is-target" : ""}`,
    );
    card.id = `message-${message.id}`;
    const meta = el("div", undefined, "thread-meta");
    meta.append(
      badge(message.kind, openIds.has(message.id) ? "warning" : "neutral"),
      agentLink(message.from),
      el("span", "→", "thread-arrow"),
      agentLink(message.to),
      timeEl(message.at),
    );
    card.append(meta);
    if (openIds.has(message.id))
      card.append(el("p", "Awaiting answer", "text-warning"));
    if (message.replyTo && !index.byId.has(message.replyTo))
      card.append(
        el("p", "Replies to a message that is no longer retained.", "note"),
      );
    card.append(el("p", message.text, "prose"));
    const extras = [];
    if (message.reviewCommit)
      extras.push(`Review commit ${message.reviewCommit}`);
    if (message.assignmentId) extras.push(`Assignment ${message.assignmentId}`);
    if (extras.length) card.append(el("p", extras.join(" · "), "note mono"));
    item.append(card);
    list.append(item);
  }
  pane.replaceChildren(close, header, list);
}
function renderMessages() {
  syncClear("messages");
  const index = buildThreadIndex();
  renderMessageList(index);
  renderThreadDetail(index);
}

// ---- Relationships & System ------------------------------------------------

function renderRelationships() {
  const coverage = data.graphCoverage ?? {};
  const fraction = (included, total) =>
    `${included ?? "unknown"} of ${total ?? "unknown"}`;
  $("graph-state").replaceChildren(
    badge(
      coverage.state ?? "unknown",
      coverage.state === "available" ? "success" : "unknown",
    ),
  );
  const list = fields(
    [
      ["Tasks", fraction(coverage.tasksIncluded, coverage.tasksTotal)],
      ["Agents", fraction(coverage.lanesIncluded, coverage.lanesTotal)],
      ["Events", fraction(coverage.messagesIncluded, coverage.messagesTotal)],
      ["Dependency metadata", coverage.dependencyMetadata, "unknown"],
    ],
    "fields-inline",
  );
  $("graph-coverage").replaceChildren(...list.children);
}
function renderSystem() {
  const headless = data.headless;
  $("headless-status").replaceChildren(
    healthBadge(headless?.state ?? "not-started"),
  );
  const reload = headless?.configReload;
  const rows = headless?.checkedAt
    ? [
        ["Last check", timeEl(headless.checkedAt)],
        ["Held lanes", (headless.held ?? []).join(", "), "none"],
        [
          "Disk config",
          headless.diskConfigAvailable ? "readable" : "unavailable",
        ],
        ["Loaded config", headless.configState, "unknown"],
        [
          "Reload",
          reload
            ? `${reload.outcome}${reload.errorCode ? ` (${reload.errorCode})` : ""} at ${date(reload.evaluatedAt)}`
            : null,
          "not reported",
        ],
      ]
    : [];
  const attention = headless?.attention;
  if (attention)
    rows.push(
      ["Backlog", attention.backlog, "unknown"],
      [
        "Oldest unhandled",
        attention.oldestUnhandledAt
          ? timeEl(attention.oldestUnhandledAt)
          : null,
        "none",
      ],
      [
        "Planning since",
        attention.planningSince ? timeEl(attention.planningSince) : null,
        "not planning",
      ],
    );
  $("headless-note").replaceChildren(
    headless?.checkedAt
      ? fields(rows)
      : el(
          "p",
          "Not started. Dedicated sessions require an exclusive ownership handover.",
          "note",
        ),
  );
  const budgets = headless?.budgets;
  $("headless-budgets").replaceChildren(
    budgets
      ? section(
          `Limits (${headless.budgetsSource ?? "unknown source"})`,
          fields([
            ["Concurrent lanes", budgets.maxParallel],
            ["Minutes per run", budgets.maxRunMinutes],
            ["Runs per lane per hour", budgets.maxRunsPerHour],
            ["Heartbeat interval", `${budgets.intervalSeconds}s`],
          ]),
        )
      : el("p", "Supervisor budgets unavailable", "note"),
  );
  const monitor = data.monitor;
  const watchdog = data.watchdog;
  $("monitor-status").replaceChildren(
    healthBadge(monitor?.state ?? "not-started"),
  );
  $("monitor-note").textContent = monitor?.checkedAt
    ? `Last watcher check: ${date(monitor.checkedAt)}. ${monitor.error ?? "Reports are observations; agents still post their own progress and answers."}`
    : "Start with crewplane monitor. The dashboard continues reading the live board independently.";
  const alertNode = (text) => el("p", text, "watch-alert");
  $("monitor-alerts").replaceChildren(
    ...(monitor?.alerts ?? []).map((alert) =>
      alertNode(`${alert.agent} · ${alert.task ?? "General"} · ${alert.text}`),
    ),
  );
  $("watchdog-status").replaceChildren(
    healthBadge(watchdog?.state ?? "unavailable"),
  );
  $("watchdog-note").replaceChildren(
    fields([
      ["Last check", watchdog?.checkedAt ? timeEl(watchdog.checkedAt) : null],
      ["Next check", watchdog?.nextCheck ? date(watchdog.nextCheck) : null],
      ["Recovery", "disabled"],
      [
        "Unavailable signals",
        watchdog?.unavailableSignals?.join(", "),
        watchdog?.unavailableSignals ? "none" : "unknown",
      ],
    ]),
  );
  $("watchdog-alerts").replaceChildren(
    ...(watchdog?.codes ?? []).map((code) =>
      alertNode(
        `WATCHDOG · ${code} · persistent observation; inspect before retry`,
      ),
    ),
  );
  const orphans = data.orphanAssignments ?? [];
  $("orphans-panel").hidden = !orphans.length;
  $("orphans-count").textContent = orphans.length ? String(orphans.length) : "";
  const orphanList = el("ul", undefined, "link-list");
  for (const orphan of orphans) {
    const row = el("li");
    row.append(
      el("span", orphan.task, "mono"),
      ` · owner ${orphan.assignment?.owner ?? "unknown"}`,
    );
    orphanList.append(row);
  }
  $("orphans").replaceChildren(orphanList);
  const notes = $("milestones");
  notes.textContent =
    data.milestoneStatus ||
    "No project status notes found at the configured path.";
  notes.classList.toggle("is-unknown", !data.milestoneStatus);
}

const viewRenderers = {
  overview: renderOverview,
  tasks: renderTasks,
  agents: renderAgents,
  messages: renderMessages,
  relationships: renderRelationships,
  system: renderSystem,
};

// ---- Filters ---------------------------------------------------------------

function hasClearable(view) {
  return CLEARABLE[view].keys.some((key) => route.params[key]);
}
function syncClear(view) {
  $(`${view}-clear`).hidden = !hasClearable(view);
}
function clearFilters(view) {
  const updates = {};
  for (const key of CLEARABLE[view].keys) updates[key] = undefined;
  setRouteParams(updates);
  applyControls();
  $(CLEARABLE[view].focus)?.focus({ preventScroll: true });
}
function clearButton(view) {
  const button = el("button", "Clear filters", "text-button");
  button.type = "button";
  button.dataset.focusKey = `clear:${view}`;
  button.addEventListener("click", () => clearFilters(view));
  return button;
}
function setControl(control, value) {
  if (
    control.tagName === "SELECT" &&
    value &&
    ![...control.options].some((option) => option.value === value)
  )
    control.add(new Option(value, value));
  if (control.value !== value) control.value = value;
}
function applyControls() {
  for (const [id, view, key] of FILTER_CONTROLS)
    if (view === route.view) setControl($(id), route.params[key] ?? "");
}
function fillSelect(select, allLabel, values, format = (value) => value) {
  const selected = select.value;
  const options =
    selected && !values.includes(selected) ? [...values, selected] : values;
  const signature = JSON.stringify([allLabel, options]);
  if (select.dataset.options === signature) return;
  select.replaceChildren(
    new Option(allLabel, ""),
    ...options.map((value) => new Option(format(value), value)),
  );
  select.value = selected;
  select.dataset.options = signature;
}
function fillFilterOptions() {
  const agents = [
    ...new Set([
      ...(data.headless?.lanes ?? []).map((lane) => lane.lane),
      ...data.tasks.map((task) => task.owner).filter((id) => id !== "—"),
    ]),
  ].sort();
  fillSelect($("agent"), "All agents", agents);
  fillSelect($("run-lane"), "All agents", agents);
  const participants = [
    ...new Set([
      ...agents,
      ...data.messages.flatMap((message) => [message.from, message.to]),
    ]),
  ]
    .filter((id) => id !== "all")
    .sort();
  fillSelect($("message-agent"), "All agents", participants);
  const phases = [...new Set(data.tasks.map((task) => task.phase))].sort();
  for (const id of ["phase", "message-phase"])
    fillSelect($(id), "All phases", phases, (phase) => `Phase ${phase}`);
}

// ---- Routing ---------------------------------------------------------------

function rememberFilters() {
  const selection = SELECTION_PARAM[route.view];
  filterMemory[route.view] = Object.fromEntries(
    Object.entries(route.params).filter(([key]) => key !== selection),
  );
}
function updateNavLinks() {
  for (const anchor of document.querySelectorAll("[data-nav]")) {
    const view = anchor.dataset.nav;
    anchor.setAttribute("href", hrefFor(view, filterMemory[view]));
    if (view === route.view) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");
  }
}
function announceRoute() {
  window.dispatchEvent(
    new CustomEvent("crewplane-route", {
      detail: { view: route.view, params: route.params },
    }),
  );
}
function showActiveView() {
  const meta = VIEW_META[route.view];
  for (const view of document.querySelectorAll(".view"))
    view.hidden = !data || view.id !== `view-${route.view}`;
  $("view-title").textContent = meta.title;
  $("view-subtitle").textContent = meta.subtitle;
  document.title = `${meta.title} · Crewplane`;
  $("loading").hidden = Boolean(data);
}
function setRouteParams(updates) {
  const params = Object.fromEntries(
    Object.entries({ ...route.params, ...updates }).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
  const href = hrefFor(route.view, params);
  if (href !== window.location.hash)
    window.history.replaceState(null, "", href);
  route = { view: route.view, params, valid: true };
  rememberFilters();
  updateNavLinks();
  render();
  announceRoute();
}
function closeNav(returnFocus = false) {
  $("sidebar").classList.remove("nav-open");
  $("nav-toggle").setAttribute("aria-expanded", "false");
  $("nav-toggle").setAttribute("aria-label", "Open navigation menu");
  if (returnFocus) $("nav-toggle").focus();
}
function routeScrollKey(value) {
  const selection = SELECTION_PARAM[value.view];
  return `${value.view}${selection && value.params[selection] ? ":detail" : ""}`;
}
function placeFocus(previous, focusTarget) {
  const selection = SELECTION_PARAM[route.view];
  const before = previous.params[selection];
  const after = route.params[selection];
  if (route.view === "runs" && previous.view === "runs") return;
  if (previous.view !== route.view) {
    $("view-title").focus({ preventScroll: true });
    return;
  }
  if (!selection || before === after) return;
  if (after && focusTarget) {
    activeView()
      .querySelector("[data-focus-key='detail-heading']")
      ?.focus({ preventScroll: true });
  } else if (before) {
    const prefix = { tasks: "task", agents: "agent", messages: "message" }[
      route.view
    ];
    const target = activeView().querySelector(
      `[data-focus-key="${CSS.escape(`${prefix}:${before}`)}"]`,
    );
    (target ?? $("view-title")).focus({ preventScroll: true });
  }
}
function placeScroll(previous, traversal) {
  if (traversal) {
    window.scrollTo(0, scrollMemory.get(routeScrollKey(route)) ?? 0);
    return;
  }
  const selection = SELECTION_PARAM[route.view];
  if (previous.view !== route.view) window.scrollTo(0, 0);
  else if (
    stackedLayout.matches &&
    selection &&
    route.params[selection] &&
    route.params[selection] !== previous.params[selection]
  )
    window.scrollTo(0, 0);
}
function highlightTarget(previous) {
  if (route.view !== "messages") return;
  const id = route.params.thread;
  if (!id || id === previous.params.thread) return;
  document
    .getElementById(`message-${id}`)
    ?.scrollIntoView({ block: "nearest" });
}
function onRouteChange() {
  const previous = route;
  const traversal = !internalNavigation;
  internalNavigation = false;
  scrollMemory.set(routeScrollKey(previous), window.scrollY);
  const next = parseHash(window.location.hash);
  if (!next.valid) window.history.replaceState(null, "", hrefFor("overview"));
  route = next;
  rememberFilters();
  closeNav();
  applyControls();
  updateNavLinks();
  showActiveView();
  render();
  announceRoute();
  placeScroll(previous, traversal);
  placeFocus(previous, !traversal);
  highlightTarget(previous);
}

// ---- Snapshot polling ------------------------------------------------------

async function snapshotError(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Non-JSON failures fall back to the status code below.
  }
  return `Dashboard data unavailable (${response.status}).`;
}
function setConnection(state, text) {
  $("connection-wrap").dataset.state = state;
  if ($("connection").textContent !== text) $("connection").textContent = text;
}
function applySnapshot(next) {
  const { updatedAt, ...content } = next;
  const signature = JSON.stringify(content);
  const firstLoad = !data;
  data = next;
  lastSuccess = Date.now();
  if (signature !== fingerprint) {
    fillFilterOptions();
    window.crewplaneGraphSnapshot = {
      graphs: data.graphs,
      coverage: data.graphCoverage,
    };
    window.dispatchEvent(
      new CustomEvent("crewplane-graphs", {
        detail: window.crewplaneGraphSnapshot,
      }),
    );
    if (firstLoad) {
      applyControls();
      showActiveView();
    }
    render();
    fingerprint = signature;
  }
  refreshRelativeTimes();
  setConnection("live", "Live");
  $("connection-time").textContent = `Checked ${date(updatedAt)}`;
  $("error").hidden = true;
}
function showDisconnected(message) {
  setConnection("disconnected", "Disconnected");
  $("connection-time").textContent = "Retrying every 5s";
  const context = lastSuccess
    ? `Showing the last snapshot from ${date(lastSuccess)}; it may be out of date.`
    : "No snapshot has been received yet.";
  $("error").textContent = `${message} ${context} Retrying every 5s.`;
  $("error").hidden = false;
  if (!data)
    $("loading").textContent =
      "Waiting for the dashboard server. Retrying every 5s.";
}
async function refresh() {
  if (busy) return;
  busy = true;
  $("refresh").setAttribute("aria-busy", "true");
  let next;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(await snapshotError(response));
    next = await response.json();
  } catch (error) {
    showDisconnected(error.message);
    return;
  } finally {
    busy = false;
    $("refresh").removeAttribute("aria-busy");
  }
  applySnapshot(next);
}

// ---- Wiring ----------------------------------------------------------------

window.crewplane = {
  hrefFor,
  navigate,
  setParams: setRouteParams,
  get route() {
    return { view: route.view, params: { ...route.params } };
  },
};
for (const [id, view, key] of FILTER_CONTROLS)
  $(id).addEventListener("input", () => {
    if (route.view === view) setRouteParams({ [key]: $(id).value });
  });
for (const view of Object.keys(CLEARABLE))
  $(`${view}-clear`).addEventListener("click", () => clearFilters(view));
for (const [id, layout] of [
  ["layout-board", "board"],
  ["layout-list", "list"],
])
  $(id).addEventListener("click", () => {
    storeLayout(layout);
    setRouteParams({ layout });
  });
for (const [id, filter] of [
  ["messages-open", "open"],
  ["messages-all", "all"],
])
  $(id).addEventListener("click", () => setRouteParams({ filter }));
for (const query of [compactLayout, stackedLayout])
  query.addEventListener("change", render);
$("refresh").addEventListener("click", refresh);
$("skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  $("main").focus();
});
$("nav-toggle").addEventListener("click", () => {
  const open = $("sidebar").classList.toggle("nav-open");
  $("nav-toggle").setAttribute("aria-expanded", String(open));
  $("nav-toggle").setAttribute(
    "aria-label",
    open ? "Close navigation menu" : "Open navigation menu",
  );
  if (open) document.querySelector("#primary-nav a")?.focus();
});
document.addEventListener("click", (event) => {
  const anchor = event.target.closest?.('a[href^="#/"]');
  if (
    anchor &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    anchor.getAttribute("href") !== window.location.hash
  )
    internalNavigation = true;
  if (
    $("sidebar").classList.contains("nav-open") &&
    !event.target.closest?.("#sidebar")
  )
    closeNav();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if ($("sidebar").classList.contains("nav-open")) {
    closeNav(true);
    return;
  }
  event.target
    .closest?.(".detail-pane")
    ?.querySelector("[data-close-detail]")
    ?.click();
});
window.addEventListener("hashchange", onRouteChange);
window.history.scrollRestoration = "manual";

if (!route.valid) window.history.replaceState(null, "", hrefFor("overview"));
rememberFilters();
updateNavLinks();
showActiveView();
announceRoute();
refresh();
setInterval(refresh, 5000);
