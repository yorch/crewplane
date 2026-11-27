// Dashboard entry point: a native ES module (served from 'self', so the strict
// content security policy is unchanged). It wires the modules in ./app/ and
// starts polling; the views live in their own modules.
import { refresh } from "./app/api.js";
import {
  applyControls,
  fillFilterOptions,
  wireFilters,
} from "./app/filters.js";
import { startLive } from "./app/live.js";
import {
  restoreAfterFirstRender,
  startReloadPersistence,
} from "./app/reload-state.js";
import { render } from "./app/render.js";
import { hrefFor, parseHash } from "./app/route.js";
import {
  announceRoute,
  navigate,
  rememberFilters,
  setRouteParams,
  updateNavLinks,
} from "./app/router.js";
import { showActiveView, wireShell } from "./app/shell.js";
import { $, compactLayout, hooks, stackedLayout, store } from "./app/store.js";
import { storeLayout } from "./app/tasks.js";
import { date } from "./app/time.js";

// The fragment token is adopted when ./app/api.js loads (before this body runs).
store.route = parseHash(window.location.hash);
hooks.render = render;
hooks.commitSnapshot = (firstLoad) => {
  fillFilterOptions();
  if (firstLoad) {
    applyControls();
    showActiveView();
  }
  render();
};
// Runs after the crewplane-graphs event, so the graph viewer has drawn and the
// page has its final height before the saved scroll position is applied.
hooks.afterGraphs = (firstLoad) => {
  if (firstLoad) restoreAfterFirstRender();
};

window.crewplane = {
  formatTime: date,
  hrefFor,
  navigate,
  setParams: setRouteParams,
  get route() {
    return { view: store.route.view, params: { ...store.route.params } };
  },
};
wireFilters();
wireShell();
for (const [id, layout] of [
  ["layout-board", "board"],
  ["layout-list", "list"],
])
  $(id).addEventListener("click", () => {
    storeLayout(layout);
    setRouteParams({ layout });
  });
for (const query of [compactLayout, stackedLayout])
  query.addEventListener("change", render);
$("refresh").addEventListener("click", refresh);
window.history.scrollRestoration = "manual";

if (!store.route.valid)
  window.history.replaceState(null, "", hrefFor("overview"));
startReloadPersistence();
rememberFilters();
updateNavLinks();
showActiveView();
announceRoute();
refresh();
startLive();
// Polling is the fallback transport: it pauses only while the event stream is
// delivering (see app/live.js).
setInterval(() => {
  if (!document.hidden && store.mode !== "live") refresh();
}, 5000);
document.addEventListener("visibilitychange", () => {
  // While the stream delivers, a poll on return could only race a newer push.
  if (!document.hidden && store.mode !== "live") refresh();
});
