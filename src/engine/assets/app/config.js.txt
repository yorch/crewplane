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
};
export const ROUTE_PARAMS = {
  overview: [],
  tasks: ["q", "agent", "phase", "state", "layout", "task"],
  agents: ["q", "status", "agent"],
  messages: ["filter", "q", "agent", "phase", "thread"],
  runs: ["lane", "harness", "task", "run"],
  relationships: ["graph"],
  system: [],
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
};
export const SELECTION_PARAM = {
  tasks: "task",
  agents: "agent",
  messages: "thread",
  runs: "run",
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
];
export const CLEARABLE = {
  tasks: { keys: ["q", "agent", "phase", "state"], focus: "search" },
  agents: { keys: ["q", "status"], focus: "agent-search" },
  messages: { keys: ["q", "agent", "phase"], focus: "message-search" },
};
export const MAX_PARAM_LENGTH = 256;
export const MAX_HASH_LENGTH = 2048;
export const LAYOUT_KEY = "crewplane.tasks.layout";
