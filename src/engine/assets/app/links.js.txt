import { el, link } from "./dom.js";
import { hrefFor } from "./route.js";

export function agentLink(name, className) {
  if (name === "—" || !name) return el("span", "Unassigned", "is-unknown");
  if (name === "all") return el("span", "all agents", className);
  const node = link(hrefFor("agents", { agent: name }), name, className);
  node.dataset.agentLink = name;
  return node;
}
export function taskLink(id, className, text = id) {
  return link(hrefFor("tasks", { task: id }), text, className);
}
export function taskTitle(task) {
  const title = String(task.title ?? task.id);
  if (!title.startsWith(task.id)) return title;
  const trimmed = title.slice(task.id.length).replace(/^[\s:—–-]+/u, "");
  return trimmed || title;
}
