import { el } from "./dom.js";
import {
  healthTones,
  processLabels,
  processTones,
  progressLabels,
  progressTones,
  stateLabels,
  stateTones,
} from "./labels.js";

export function badge(text, tone = "neutral") {
  const node = el("span", undefined, `badge tone-${tone}`);
  node.append(el("span", undefined, "badge-dot"), el("span", text));
  return node;
}
export function taskBadge(state) {
  return badge(stateLabels[state] ?? state, stateTones[state] ?? "unknown");
}
export function processBadge(status) {
  if (!status) return badge("No record", "unknown");
  return badge(processLabels[status] ?? status, processTones[status]);
}
export function progressBadge(status, hasTask) {
  if (!status) return badge(hasTask ? "No report" : "No task", "unknown");
  return badge(progressLabels[status] ?? status, progressTones[status]);
}
export function healthBadge(state) {
  const text = String(state ?? "unknown");
  return badge(text.replace("-", " "), healthTones[text] ?? "unknown");
}
