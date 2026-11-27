import { adoptFragmentToken, refresh } from "./api.js";
import { MODAL_VIEWS, SELECTION_PARAM, VIEW_META } from "./config.js";
import { applyControls } from "./filters.js";
import { hrefFor, parseHash, routeScrollKey } from "./route.js";
import { announceRoute, rememberFilters, updateNavLinks } from "./router.js";
import { $, hooks, stackedLayout, store } from "./store.js";
import { activeView } from "./ui-state.js";

export function showActiveView() {
  const meta = VIEW_META[store.route.view];
  for (const view of document.querySelectorAll(".view"))
    view.hidden = !store.data || view.id !== `view-${store.route.view}`;
  $("view-title").textContent = meta.title;
  $("view-subtitle").textContent = meta.subtitle;
  document.title = `${meta.title} · Crewplane`;
  $("loading").hidden = Boolean(store.data);
}

function closeNav(returnFocus = false) {
  $("sidebar").classList.remove("nav-open");
  $("nav-toggle").setAttribute("aria-expanded", "false");
  $("nav-toggle").setAttribute("aria-label", "Open navigation menu");
  if (returnFocus) $("nav-toggle").focus();
}
function placeFocus(previous, focusTarget) {
  const selection = SELECTION_PARAM[store.route.view];
  const before = previous.params[selection];
  const after = store.route.params[selection];
  if (store.route.view === "runs" && previous.view === "runs") return;
  // A modal view manages its own focus when an item opens or closes.
  if (
    MODAL_VIEWS.includes(store.route.view) &&
    previous.view === store.route.view
  )
    return;
  if (previous.view !== store.route.view) {
    $("view-title").focus({ preventScroll: true });
    return;
  }
  if (!selection || before === after) return;
  if (after && focusTarget) {
    activeView()
      .querySelector("[data-focus-key='detail-heading']")
      ?.focus({ preventScroll: true });
  } else if (before) {
    const prefix = {
      tasks: "task",
      agents: "agent",
      messages: "message",
      audit: "audit",
    }[store.route.view];
    const target = activeView().querySelector(
      `[data-focus-key="${CSS.escape(`${prefix}:${before}`)}"]`,
    );
    (target ?? $("view-title")).focus({ preventScroll: true });
  }
}
function placeScroll(previous, traversal) {
  if (traversal) {
    window.scrollTo(
      0,
      store.scrollMemory.get(routeScrollKey(store.route)) ?? 0,
    );
    return;
  }
  const selection = MODAL_VIEWS.includes(store.route.view)
    ? undefined
    : SELECTION_PARAM[store.route.view];
  if (previous.view !== store.route.view) window.scrollTo(0, 0);
  else if (
    stackedLayout.matches &&
    selection &&
    store.route.params[selection] &&
    store.route.params[selection] !== previous.params[selection]
  )
    window.scrollTo(0, 0);
}
function highlightTarget(previous) {
  if (store.route.view !== "messages") return;
  const id = store.route.params.thread;
  if (!id || id === previous.params.thread) return;
  document
    .getElementById(`message-${id}`)
    ?.scrollIntoView({ block: "nearest" });
}
export function onRouteChange() {
  // Reopening the printed URL in this tab is only a hash change.
  const adopted = adoptFragmentToken();
  const previous = store.route;
  const traversal = !store.internalNavigation;
  store.internalNavigation = false;
  store.scrollMemory.set(routeScrollKey(previous), window.scrollY);
  const next = parseHash(window.location.hash);
  if (!next.valid) window.history.replaceState(null, "", hrefFor("overview"));
  store.route = next;
  rememberFilters();
  closeNav();
  applyControls();
  updateNavLinks();
  showActiveView();
  hooks.render();
  announceRoute();
  placeScroll(previous, traversal);
  placeFocus(previous, !traversal);
  highlightTarget(previous);
  if (adopted) refresh();
}

// Navigation chrome: skip link, mobile menu, Escape and link bookkeeping.
export function wireShell() {
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
      store.internalNavigation = true;
    if (event.target.closest?.("#primary-nav a")) closeNav();
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
}
