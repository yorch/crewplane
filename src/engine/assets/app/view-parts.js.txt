// Small building blocks shared by the Setup, Usage, Evidence and Audit views.
import { el } from "./dom.js";
import { date } from "./time.js";

/** A titled panel; `id` names its heading for aria-labelledby. */
export function panel(id, title, children, extra) {
  const node = el("section", undefined, "panel");
  node.setAttribute("aria-labelledby", id);
  const head = el("div", undefined, "panel-head");
  const heading = el("h2", title);
  heading.id = id;
  head.append(heading);
  if (extra) head.append(extra);
  node.append(head, ...children);
  return node;
}

export function loadingNote(text) {
  const node = el("p", text, "loading-note");
  node.setAttribute("role", "status");
  return node;
}

/** The read failed and there is nothing to show yet. */
export function errorPanel(what, error, retry) {
  const node = el("div", undefined, "empty-state is-error");
  node.setAttribute("role", "alert");
  node.append(
    el("p", `Could not load ${what}.`, "empty-title"),
    el("p", error?.message ?? "The request failed.", "empty-hint"),
  );
  const button = el("button", "Try again", "text-button");
  button.type = "button";
  button.dataset.focusKey = `retry:${what}`;
  button.addEventListener("click", retry);
  node.append(button);
  return node;
}

/** The last answer is still shown, but the latest read failed. */
export function staleNote(error, loadedAt, retry) {
  const node = el("div", undefined, "banner banner-inline");
  node.setAttribute("role", "status");
  node.append(
    el(
      "span",
      `Showing the last answer${loadedAt ? ` from ${date(loadedAt)}` : ""}; refreshing failed: ${error?.message ?? "the request failed"}`,
    ),
  );
  const button = el("button", "Try again", "text-button");
  button.type = "button";
  button.dataset.focusKey = "retry:stale";
  button.addEventListener("click", retry);
  node.append(button);
  return node;
}

/** A labelled definition list entry whose value may be a Node. */
export function noteList(items) {
  const list = el("ul", undefined, "note-list");
  for (const item of items) list.append(el("li", item, "note-item"));
  return list;
}
