import { renderGraph } from "/graph-renderer.js";

const host = document.getElementById("graph-host");
const view = document.getElementById("graph-view");
const note = document.getElementById("graph-note");
let latest;
let renderer;
function select({ kind, id }) {
  const nav = window.crewplane;
  if (!nav) return;
  if (kind === "thread")
    nav.navigate(nav.hrefFor("messages", { filter: "all", thread: id }));
  if (kind === "task") nav.navigate(nav.hrefFor("tasks", { task: id }));
  if (kind === "lane") nav.navigate(nav.hrefFor("agents", { agent: id }));
}
function update(value) {
  latest = value;
  const graph = value?.graphs?.[view.value];
  if (!graph) {
    note.textContent = "Graph data unavailable.";
    return;
  }
  note.textContent = `Explicit recorded relationships only. Process status is an observation, not productive work. ${value.coverage?.messagesIncluded ?? 0} of ${value.coverage?.messagesTotal ?? 0} events supplied. Task dependency metadata: ${value.coverage?.dependencyMetadata ?? "unknown"}.`;
  if (renderer) renderer.update(graph);
  else renderer = renderGraph(document, host, graph, { onSelect: select });
}
view.addEventListener("change", () => {
  window.crewplane?.setParams({ graph: view.value });
  update(latest);
});
window.addEventListener("crewplane-graphs", (event) => update(event.detail));
window.addEventListener("crewplane-route", (event) => {
  if (event.detail.view !== "relationships") return;
  const next = event.detail.params.graph ?? "communication";
  if (view.value === next) return;
  view.value = next;
  update(latest);
});
if (window.crewplaneGraphSnapshot) update(window.crewplaneGraphSnapshot);
