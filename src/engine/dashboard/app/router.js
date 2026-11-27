import { SELECTION_PARAM } from "./config.js";
import { hrefFor } from "./route.js";
import { hooks, store } from "./store.js";

export function navigate(href) {
  if (href === window.location.hash) return;
  store.internalNavigation = true;
  window.location.hash = href;
}

export function rememberFilters() {
  const selection = SELECTION_PARAM[store.route.view];
  store.filterMemory[store.route.view] = Object.fromEntries(
    Object.entries(store.route.params).filter(([key]) => key !== selection),
  );
}
export function updateNavLinks() {
  for (const anchor of document.querySelectorAll("[data-nav]")) {
    const view = anchor.dataset.nav;
    anchor.setAttribute("href", hrefFor(view, store.filterMemory[view]));
    if (view === store.route.view) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");
  }
}
export function announceRoute() {
  window.dispatchEvent(
    new CustomEvent("crewplane-route", {
      detail: { view: store.route.view, params: store.route.params },
    }),
  );
}

export function setRouteParams(updates) {
  const params = Object.fromEntries(
    Object.entries({ ...store.route.params, ...updates }).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
  const href = hrefFor(store.route.view, params);
  if (href !== window.location.hash)
    window.history.replaceState(null, "", href);
  store.route = { view: store.route.view, params, valid: true };
  rememberFilters();
  updateNavLinks();
  hooks.render();
  announceRoute();
}
