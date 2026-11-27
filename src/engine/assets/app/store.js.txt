// Shared mutable dashboard state and the few late-bound hooks that let lower
// modules (router, api, filters) ask for a render without importing the view
// layer, which would create import cycles. dashboard.js wires the hooks once.
export const $ = (id) => document.getElementById(id);

export const store = {
  data: undefined,
  route: { view: "overview", params: {}, valid: true },
  fingerprint: undefined,
  busy: false,
  /** Transport: "polling" until the event stream delivers, then "live". */
  mode: "polling",
  lastSuccess: null,
  /** Counts snapshots applied (polled or pushed); a poll started before a newer one is discarded. */
  applied: 0,
  /** Server time (ms) of the newest snapshot applied or confirmed; older pushed ones are ignored. */
  appliedAt: 0,
  internalNavigation: false,
  messageLimit: 100,
  messageLimitKey: "",
  filterMemory: {},
  scrollMemory: new Map(),
};
export const hooks = {
  render: () => {},
  commitSnapshot: (_firstLoad) => {},
  afterGraphs: (_firstLoad) => {},
};
export const compactLayout = window.matchMedia("(max-width: 860px)");
export const stackedLayout = window.matchMedia("(max-width: 1100px)");
