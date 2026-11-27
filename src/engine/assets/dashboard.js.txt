// Dashboard entry point: a native ES module (served from 'self', so the strict
// content security policy is unchanged). It wires the modules in ./app/ and
// starts polling; the views live in their own modules.
import { adoptFragmentToken, refresh } from "./app/api.js";
import {
  applyControls,
  fillFilterOptions,
  wireFilters,
} from "./app/filters.js";
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

adoptFragmentToken();
store.route = parseHash(window.location.hash);
hooks.render = render;
hooks.commitSnapshot = (firstLoad) => {
  fillFilterOptions();
  if (firstLoad) {
    applyControls();
    showActiveView();
  }
  render();
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
setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
