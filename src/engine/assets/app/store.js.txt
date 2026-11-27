// Shared mutable dashboard state and the few late-bound hooks that let lower
// modules (router, api, filters) ask for a render without importing the view
// layer, which would create import cycles. dashboard.js wires the hooks once.
export const $ = (id) => document.getElementById(id);

export const store = {
  data: undefined,
  route: { view: "overview", params: {}, valid: true },
  fingerprint: undefined,
  busy: false,
  lastSuccess: null,
  internalNavigation: false,
  messageLimit: 100,
  messageLimitKey: "",
  filterMemory: {},
  scrollMemory: new Map(),
};
export const hooks = {
  render: () => {},
  commitSnapshot: (_firstLoad) => {},
};
export const compactLayout = window.matchMedia("(max-width: 860px)");
export const stackedLayout = window.matchMedia("(max-width: 1100px)");
