import { $, store } from "./store.js";

export function activeView() {
  return $(`view-${store.route.view}`);
}
export function captureUi() {
  const active = document.activeElement;
  let focusKey = null;
  let summaryKey = null;
  if (active && active !== document.body) {
    focusKey = active.dataset?.focusKey ?? null;
    if (active.tagName === "SUMMARY")
      summaryKey = active.parentElement?.dataset.key ?? null;
  }
  return {
    active,
    focusKey,
    summaryKey,
    x: window.scrollX,
    y: window.scrollY,
    open: new Set(
      [...document.querySelectorAll("details[open][data-key]")].map(
        (node) => node.dataset.key,
      ),
    ),
    scroll: new Map(
      [...document.querySelectorAll("[data-scroll-key]")].map((node) => [
        node.dataset.scrollKey,
        [node.scrollLeft, node.scrollTop],
      ]),
    ),
  };
}
export function restoreUi(ui) {
  for (const node of document.querySelectorAll("details[data-key]"))
    node.open = ui.open.has(node.dataset.key);
  for (const node of document.querySelectorAll("[data-scroll-key]")) {
    const position = ui.scroll.get(node.dataset.scrollKey);
    if (position) [node.scrollLeft, node.scrollTop] = position;
  }
  if (ui.active && !ui.active.isConnected) {
    const view = activeView();
    let target = null;
    if (ui.focusKey) {
      // Keys are not guaranteed unique (for example, repeated agent links), so
      // only restore focus when exactly one element matches.
      const matches = view.querySelectorAll(
        `[data-focus-key="${CSS.escape(ui.focusKey)}"]`,
      );
      if (matches.length === 1) target = matches[0];
    } else if (ui.summaryKey)
      target = view.querySelector(
        `details[data-key="${CSS.escape(ui.summaryKey)}"] > summary`,
      );
    target?.focus({ preventScroll: true });
  }
  window.scrollTo(ui.x, ui.y);
}
