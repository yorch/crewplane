import { CLEARABLE, FILTER_CONTROLS } from "./config.js";
import { el } from "./dom.js";
import { setRouteParams } from "./router.js";
import { $, store } from "./store.js";

export function hasClearable(view) {
  return CLEARABLE[view].keys.some((key) => store.route.params[key]);
}
export function syncClear(view) {
  $(`${view}-clear`).hidden = !hasClearable(view);
}
function clearFilters(view) {
  const updates = {};
  for (const key of CLEARABLE[view].keys) updates[key] = undefined;
  setRouteParams(updates);
  applyControls();
  $(CLEARABLE[view].focus)?.focus({ preventScroll: true });
}
export function clearButton(view) {
  const button = el("button", "Clear filters", "text-button");
  button.type = "button";
  button.dataset.focusKey = `clear:${view}`;
  button.addEventListener("click", () => clearFilters(view));
  return button;
}
function setControl(control, value) {
  if (
    control.tagName === "SELECT" &&
    value &&
    ![...control.options].some((option) => option.value === value)
  )
    control.add(new Option(value, value));
  if (control.value !== value) control.value = value;
}
export function applyControls() {
  for (const [id, view, key] of FILTER_CONTROLS)
    if (view === store.route.view)
      setControl($(id), store.route.params[key] ?? "");
}
function fillSelect(select, allLabel, values, format = (value) => value) {
  const selected = select.value;
  const options =
    selected && !values.includes(selected) ? [...values, selected] : values;
  const signature = JSON.stringify([allLabel, options]);
  if (select.dataset.options === signature) return;
  select.replaceChildren(
    new Option(allLabel, ""),
    ...options.map((value) => new Option(format(value), value)),
  );
  select.value = selected;
  select.dataset.options = signature;
}
export function fillFilterOptions() {
  const agents = [
    ...new Set([
      ...(store.data.headless?.lanes ?? []).map((lane) => lane.lane),
      ...store.data.tasks.map((task) => task.owner).filter((id) => id !== "—"),
    ]),
  ].sort();
  fillSelect($("agent"), "All agents", agents);
  fillSelect($("run-lane"), "All agents", agents);
  const participants = [
    ...new Set([
      ...agents,
      ...store.data.messages.flatMap((message) => [message.from, message.to]),
    ]),
  ]
    .filter((id) => id !== "all")
    .sort();
  fillSelect($("message-agent"), "All agents", participants);
  const phases = [
    ...new Set(store.data.tasks.map((task) => task.phase)),
  ].sort();
  for (const id of ["phase", "message-phase"])
    fillSelect($(id), "All phases", phases, (phase) => `Phase ${phase}`);
}

// Filter inputs write through to the route; clear buttons reset a view.
export function wireFilters() {
  for (const [id, view, key] of FILTER_CONTROLS)
    $(id).addEventListener("input", () => {
      if (store.route.view === view) setRouteParams({ [key]: $(id).value });
    });
  for (const view of Object.keys(CLEARABLE))
    $(`${view}-clear`).addEventListener("click", () => clearFilters(view));
  for (const [id, filter] of [
    ["messages-open", "open"],
    ["messages-all", "all"],
  ])
    $(id).addEventListener("click", () => setRouteParams({ filter }));
}
