// Keeps scroll position and "How to read…" disclosures across a FULL page
// reload, using sessionStorage (per tab, optional, validated on read). Polls
// already preserve both without this; see ui-state.js. Restoration happens once,
// after the first render of the snapshot, because the content does not exist
// before then.

import { readUiState, restoresPosition, writeUiState } from "./persist.js";
import { routeScrollKey } from "./route.js";
import { store } from "./store.js";

let pending = null;
let late = null;
let lateOpen = new Set();
let lateOpenTries = 0;

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
function navigationType() {
  try {
    return performance.getEntriesByType("navigation")[0]?.type;
  } catch {
    return undefined;
  }
}

/** What to remember about the tab right now. */
export function captureReloadState() {
  const scroll = Object.fromEntries(store.scrollMemory);
  scroll[routeScrollKey(store.route)] = window.scrollY;
  const panes = {};
  for (const node of document.querySelectorAll("[data-scroll-key]"))
    panes[node.dataset.scrollKey] = [node.scrollLeft, node.scrollTop];
  const open = [
    ...document.querySelectorAll("details.info[data-key][open]"),
  ].map((node) => node.dataset.key);
  return { view: store.route.view, scroll, panes, open };
}
function save() {
  const target = storage();
  if (target && store.data) writeUiState(target, captureReloadState());
}

/**
 * Call once at startup, before the first route change. Seeds the per-view
 * scroll memory (so back/forward after a reload still lands where you were)
 * and remembers what to restore once the first render exists.
 */
export function startReloadPersistence() {
  const target = storage();
  if (target && restoresPosition(navigationType())) {
    const saved = readUiState(target);
    if (saved) {
      pending = saved;
      for (const [key, y] of Object.entries(saved.scroll))
        store.scrollMemory.set(key, y);
    }
  }
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) save();
  });
}

/** Call after the first successful render of a snapshot; applies at most once. */
export function restoreAfterFirstRender() {
  const saved = pending;
  pending = null;
  if (!saved) return;
  for (const key of saved.open) {
    const node = document.querySelector(
      `details.info[data-key="${CSS.escape(key)}"]`,
    );
    if (node) node.open = true;
  }
  // Pane offsets belong to the view they were captured in.
  if (saved.view === store.route.view)
    for (const node of document.querySelectorAll("[data-scroll-key]")) {
      const key = node.dataset.scrollKey;
      const position = Object.hasOwn(saved.panes, key)
        ? saved.panes[key]
        : undefined;
      if (position) [node.scrollLeft, node.scrollTop] = position;
    }
  // Disclosures of views that load their own data do not exist yet either.
  lateOpen = new Set(saved.open);
  for (const type of ["wheel", "touchstart", "keydown", "mousedown"])
    window.addEventListener(
      type,
      () => {
        late = null;
        lateOpen = new Set();
      },
      { once: true, passive: true },
    );
  const y = saved.scroll[routeScrollKey(store.route)];
  if (y === undefined) return;
  window.scrollTo(0, y);
  // A view that loads its own data (Setup, Usage, Evidence, Control log) is
  // still short at this point; keep trying while its content arrives, until
  // the position is reached or the reader scrolls.
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (y > max + 2) {
    late = { y, tries: 0 };
  }
}

/** Called after every render: completes a scroll restore that was waiting for content. */
export function applyLateScroll() {
  if (lateOpen.size && ++lateOpenTries <= 12)
    for (const key of [...lateOpen]) {
      const node = document.querySelector(
        `details.info[data-key="${CSS.escape(key)}"]`,
      );
      if (!node) continue;
      node.open = true;
      lateOpen.delete(key);
    }
  else lateOpen = new Set();
  if (!late) return;
  window.scrollTo(0, late.y);
  late.tries += 1;
  if (window.scrollY >= late.y - 2 || late.tries >= 12) late = null;
}
