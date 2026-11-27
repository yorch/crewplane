export const VIEW_META = {
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
  setup: {
    title: "Setup & config",
    subtitle: "What is installed, whether it is valid and what to do next.",
  },
  usage: {
    title: "Usage & cost",
    subtitle: "Runs against caps, durations and reported counters.",
  },
  evidence: {
    title: "Evidence",
    subtitle: "Screenshots and recordings captured for review.",
  },
  audit: {
    title: "Control log",
    subtitle: "Recent operator commands and how the supervisor answered.",
  },
};
export const ROUTE_PARAMS = {
  overview: [],
  tasks: ["q", "agent", "phase", "state", "layout", "task"],
  agents: ["q", "status", "agent"],
  messages: ["filter", "q", "agent", "phase", "thread"],
  runs: ["lane", "harness", "task", "run"],
  relationships: ["graph", "focus", "hops", "group"],
  system: [],
  setup: [],
  usage: ["lane"],
  evidence: ["task", "run", "artifact"],
  audit: ["outcome", "issuer", "lane", "seq"],
};
export const ENUM_PARAMS = {
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
  harness: ["codex", "pi", "claude", "opencode"],
  graph: ["communication", "dependencies"],
  hops: ["1", "2", "3"],
  group: ["none", "owner", "phase", "role", "harness"],
  outcome: ["applied", "noop", "refused", "stale", "invalid"],
};
// Shapes for parameters whose values are identifiers, per view (the key `run`
// means a trace run in Runs and an evidence run in Evidence).
export const PARAM_PATTERNS = {
  evidence: {
    task: /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/,
    run: /^qa_[a-f0-9]{32}$/,
    artifact: /^ev_[a-f0-9]{32}$/,
  },
  audit: {
    seq: /^\d{1,9}$/,
    issuer: /^[A-Za-z0-9._:-]{1,64}$/,
    lane: /^[A-Za-z0-9._:-]{1,64}$/,
  },
};
PARAM_PATTERNS.usage = { lane: /^[A-Za-z0-9._:-]{1,64}$/ };
PARAM_PATTERNS.relationships = { focus: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ };
// Evidence opens artifacts in a modal; its selection never scrolls or focuses a pane.
export const MODAL_VIEWS = ["evidence"];
export const SELECTION_PARAM = {
  tasks: "task",
  agents: "agent",
  messages: "thread",
  runs: "run",
  evidence: "artifact",
  audit: "seq",
};
export const FILTER_CONTROLS = [
  ["search", "tasks", "q"],
  ["agent", "tasks", "agent"],
  ["phase", "tasks", "phase"],
  ["state", "tasks", "state"],
  ["agent-search", "agents", "q"],
  ["agent-status", "agents", "status"],
  ["message-search", "messages", "q"],
  ["message-agent", "messages", "agent"],
  ["message-phase", "messages", "phase"],
  ["evidence-task", "evidence", "task"],
  ["evidence-run", "evidence", "run"],
  ["audit-outcome", "audit", "outcome"],
  ["audit-issuer", "audit", "issuer"],
  ["audit-lane", "audit", "lane"],
  ["usage-lane", "usage", "lane"],
];
export const CLEARABLE = {
  tasks: { keys: ["q", "agent", "phase", "state"], focus: "search" },
  agents: { keys: ["q", "status"], focus: "agent-search" },
  messages: { keys: ["q", "agent", "phase"], focus: "message-search" },
  evidence: { keys: ["task", "run"], focus: "evidence-task" },
  audit: { keys: ["outcome", "issuer", "lane"], focus: "audit-outcome" },
};
export const MAX_PARAM_LENGTH = 256;
export const MAX_HASH_LENGTH = 2048;
export const LAYOUT_KEY = "crewplane.tasks.layout";
