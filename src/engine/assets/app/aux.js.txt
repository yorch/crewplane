// The read-only data routes behind Setup, Usage and the Control log, held as
// shared resources so the Overview can use the same answers (configuration
// problem count, refused commands) without a second request. They load when a
// view opens and when the snapshot content changes (debounced and throttled),
// never on every poll.
import { emptyLog, logPath, logWasReset, mergeLog } from "./audit-core.js";
import { createResource, readJson } from "./resource.js";
import { store } from "./store.js";

export const configResource = createResource({
  path: "/api/config",
  minIntervalMs: 15000,
});
export const usageResource = createResource({
  path: "/api/usage",
  minIntervalMs: 20000,
});

// The control log is read from the start once, then by cursor: each answer is
// folded into one ascending list (see audit-core.js).
let log = emptyLog();
export const logResource = createResource({
  path: "/api/control-log",
  minIntervalMs: 8000,
  fetchJson: async () => {
    let body = await readJson(logPath(log));
    let replace = log.cursor === null;
    if (logWasReset(log, body)) {
      body = await readJson(logPath(emptyLog()));
      replace = true;
    }
    // A cursor read can have more than one page of news.
    let model = mergeLog(log, body, { replace });
    for (let page = 0; body?.hasMore === true && page < 4; page++) {
      body = await readJson(logPath(model));
      model = mergeLog(model, body, { replace: false });
    }
    log = model;
    return model;
  },
});

/** Called when a snapshot with new content was applied. */
export function refreshAux() {
  for (const resource of [configResource, logResource]) {
    if (resource.state.status === "idle") resource.load();
    else resource.schedule();
  }
  if (store.route.view === "usage") usageResource.schedule();
}
