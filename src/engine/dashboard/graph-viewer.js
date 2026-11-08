import { renderGraph } from "/graph-renderer.js";

const host = document.getElementById("graph-host");
const view = document.getElementById("graph-view");
const note = document.getElementById("graph-note");
let latest;
let renderer;
function select({ kind, id }) {
  let target;
  if (kind === "thread") target = document.getElementById(`message-${id}`);
  if (kind === "task")
    target = [...document.querySelectorAll("[data-task-id]")].find(
      (node) => node.dataset.taskId === id,
    );
  if (kind === "lane")
    target = [...document.querySelectorAll("[data-lane]")].find(
      (node) => node.dataset.lane === id,
    );
  if (target) {
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
  } else
    note.textContent =
      "Selected context is outside the current task/message filters. Clear filters to locate it.";
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
view.addEventListener("change", () => update(latest));
window.addEventListener("crewplane-graphs", (event) => update(event.detail));
if (window.crewplaneGraphSnapshot) update(window.crewplaneGraphSnapshot);
