export const stateLabels = {
  todo: "To do",
  assigned: "Assigned",
  working: "In progress",
  blocked: "Blocked",
  review: "Awaiting review",
  completed: "Completed",
};
export const stateTones = {
  todo: "neutral",
  assigned: "neutral",
  working: "info",
  blocked: "danger",
  review: "warning",
  completed: "success",
};
export const STATE_GROUPS = {
  active: ["working", "assigned"],
  attention: ["blocked", "review"],
};
export const BOARD_COLUMNS = [
  ["To do", ["todo"]],
  ["Assigned", ["assigned"]],
  ["In progress", ["working", "blocked"]],
  ["Awaiting review", ["review"]],
  ["Completed", ["completed"]],
];
export const processLabels = {
  running: "Running",
  stale: "Stale",
  paused: "Paused",
  idle: "Idle",
  standby: "Standby",
};
export const processTones = {
  running: "success",
  stale: "danger",
  paused: "warning",
  idle: "neutral",
  standby: "neutral",
};
export const PROCESS_ORDER = ["stale", "paused", "running", "idle", "standby"];
export const progressLabels = {
  working: "In progress",
  ready: "Awaiting review",
  blocked: "Blocked",
  assigned: "Assigned",
  accepted: "Accepted",
};
export const progressTones = {
  working: "info",
  ready: "warning",
  blocked: "danger",
  assigned: "neutral",
  accepted: "success",
};
export const healthTones = {
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
