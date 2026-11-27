import { el } from "./dom.js";

function validTime(value) {
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(new Date(value).getTime())
  );
}
export function date(value) {
  if (!validTime(value)) return "not reported";
  return new Date(value).toLocaleString();
}
function relative(value) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < -60) return date(value);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
// The exact time is part of the text; inside links it is hidden from assistive
// technology so link names stay short (the detail pane repeats it in full).
export function timeEl(value, inLink = false) {
  if (!validTime(value)) return el("span", "not reported", "is-unknown");
  const node = el("time", undefined, "time");
  node.dateTime = new Date(value).toISOString();
  node.dataset.at = String(new Date(value).getTime());
  // The exact time is real text (not only a tooltip) so keyboard, touch and
  // screen-reader users can read it; touch devices also show it visibly.
  const exact = el("span", ` (${date(value)})`, "time-exact");
  if (inLink) exact.setAttribute("aria-hidden", "true");
  node.append(el("span", relative(value), "time-relative"), exact);
  return node;
}
export function refreshRelativeTimes() {
  for (const node of document.querySelectorAll("time[data-at]")) {
    const target = node.querySelector(".time-relative");
    if (!target) continue;
    const text = relative(Number(node.dataset.at));
    if (target.textContent !== text) target.textContent = text;
  }
}
