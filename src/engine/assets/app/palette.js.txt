// Command palette: a modal dialog with a combobox over a listbox. It searches
// only what the page already holds (see palette-core.js), ranks it with the
// pure rules in search-core.js and navigates through the normal hash router,
// so every result is also an ordinary link target. Text is set with
// textContent only.

import { createModal } from "./dialog-kit.js";
import { el } from "./dom.js";
import { loadedArtifacts } from "./evidence.js";
import { entriesFromData, KIND_LABELS } from "./palette-core.js";
import { buildIndex, MAX_QUERY, MAX_RESULTS, search } from "./search-core.js";
import { store } from "./store.js";

let modal = null;
let input = null;
let list = null;
let status = null;
let index = { entries: [], omitted: 0 };
let shown = [];
let active = -1;
let commands = {};

function loadedRuns() {
  try {
    const runs = window.crewplane?.loadedRuns?.();
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}
function build() {
  index = buildIndex(
    entriesFromData({
      data: store.data,
      runs: loadedRuns(),
      artifacts: loadedArtifacts(),
    }),
  );
}
function optionId(position) {
  return `palette-option-${position}`;
}
function setActive(position, scroll = true) {
  active = shown.length
    ? Math.max(0, Math.min(position, shown.length - 1))
    : -1;
  for (const [at, node] of [...list.children].entries()) {
    const on = at === active;
    node.setAttribute("aria-selected", String(on));
    node.classList.toggle("is-active", on);
  }
  if (active >= 0) {
    input.setAttribute("aria-activedescendant", optionId(active));
    if (scroll) list.children[active]?.scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
}
function choose(position) {
  const entry = shown[position];
  if (!entry) return;
  modal.close();
  if (entry.command) commands[entry.command]?.();
  else if (entry.href) window.crewplane.navigate(entry.href);
}
function renderResults() {
  const { results, total } = search(index.entries, input.value);
  shown = results;
  list.replaceChildren(
    ...results.map((entry, position) => {
      const option = el("li", undefined, "palette-option");
      option.id = optionId(position);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.dataset.kind = entry.kind;
      option.append(
        el("span", KIND_LABELS[entry.kind] ?? entry.kind, "palette-kind"),
        el("span", entry.title, "palette-title"),
      );
      if (entry.subtitle)
        option.append(el("span", entry.subtitle, "palette-sub"));
      option.addEventListener("click", () => choose(position));
      return option;
    }),
  );
  const typed = input.value.trim() !== "";
  status.textContent = !results.length
    ? typed
      ? "No matches"
      : "Nothing to show yet"
    : typed
      ? `${total > results.length ? `Showing ${results.length} of ${total}` : total} ${total === 1 ? "match" : "matches"}`
      : `${results.length} views and commands. Type to search tasks, agents, threads and runs.`;
  input.setAttribute("aria-expanded", String(results.length > 0));
  setActive(results.length ? 0 : -1, false);
}
function ensure() {
  if (modal) return;
  modal = createModal({
    id: "palette",
    title: "Search and commands",
    className: "palette",
    onClose: () => {
      input.value = "";
    },
  });
  modal.heading.classList.add("sr-only");
  const box = el("div", undefined, "palette-box");
  input = el("input", undefined, "palette-input");
  input.type = "text";
  input.id = "palette-input";
  input.setAttribute("role", "combobox");
  input.setAttribute(
    "aria-label",
    "Search tasks, agents, threads, runs and commands",
  );
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-haspopup", "listbox");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = MAX_QUERY;
  input.placeholder = "Search tasks, agents, threads, runs…";
  list = el("ul", undefined, "palette-list");
  list.id = "palette-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Results");
  status = el("p", undefined, "palette-status");
  status.id = "palette-status";
  status.setAttribute("role", "status");
  const hint = el(
    "p",
    "Up and Down to move, Enter to open, Esc to close.",
    "palette-hint",
  );
  box.append(input, list, status, hint);
  modal.body.append(box);
  input.addEventListener("input", renderResults);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const last = shown.length - 1;
    const moves = {
      ArrowDown: () => setActive(active >= last ? 0 : active + 1),
      ArrowUp: () => setActive(active <= 0 ? last : active - 1),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => choose(active),
    };
    const move = moves[event.key];
    if (!move) return;
    // Home and End edit the text unless the list is being navigated.
    if (
      (event.key === "Home" || event.key === "End") &&
      !event.ctrlKey &&
      input.value !== ""
    )
      return;
    event.preventDefault();
    move();
  });
}
export function paletteOpen() {
  return Boolean(modal?.isOpen);
}
export function openPalette() {
  ensure();
  if (modal.isOpen) return;
  build();
  input.value = "";
  renderResults();
  modal.open(input);
}
export function closePalette() {
  modal?.close();
}
export function initPalette(handlers) {
  commands = handlers;
  document
    .getElementById("palette-open")
    ?.addEventListener("click", openPalette);
}
export const PALETTE_LIMIT = MAX_RESULTS;
