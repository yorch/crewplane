import {
  describeScale,
  expandModel,
  GROUP_LABELS,
  GROUP_MODES,
  NODE_CAP,
  projectGraph,
} from "/app/graph-scale.js";
import { renderGraph } from "/graph-renderer.js";

const host = document.getElementById("graph-host");
const view = document.getElementById("graph-view");
const note = document.getElementById("graph-note");
const scaleBar = document.getElementById("graph-scale");
const groupSelect = document.getElementById("graph-group");
const hopsSelect = document.getElementById("graph-hops");
const focusState = document.getElementById("graph-focus-state");
const focusClear = document.getElementById("graph-focus-clear");
const prev = document.getElementById("graph-prev");
const next = document.getElementById("graph-next");
const pageState = document.getElementById("graph-page-state");
let latest;
let renderer;
// The model is expanded once per snapshot, however often the view changes.
const expandedModels = new WeakMap();
// Page and expanded clusters are view memory, not part of the URL.
let page = 0;
let open = new Set();
let scaleKey = "";

function select({ kind, id }) {
  const nav = window.crewplane;
  if (!nav) return;
  if (kind === "thread")
    nav.navigate(nav.hrefFor("messages", { filter: "all", thread: id }));
  if (kind === "task") nav.navigate(nav.hrefFor("tasks", { task: id }));
  if (kind === "lane") nav.navigate(nav.hrefFor("agents", { agent: id }));
}
function scaleParams() {
  const params = window.crewplane?.route?.params ?? {};
  const group = GROUP_MODES[view.value]?.includes(params.group)
    ? params.group
    : "none";
  return {
    group,
    focus: params.focus ?? null,
    hops: Number(params.hops) || 1,
  };
}
function fillGroups(group) {
  const modes = GROUP_MODES[view.value] ?? ["none"];
  const signature = modes.join(",");
  if (groupSelect.dataset.modes !== signature) {
    groupSelect.replaceChildren(
      ...modes.map((mode) => {
        const option = document.createElement("option");
        option.value = mode;
        option.textContent =
          mode === "none"
            ? GROUP_LABELS.none
            : `By ${GROUP_LABELS[mode].toLowerCase()}`;
        return option;
      }),
    );
    groupSelect.dataset.modes = signature;
  }
  if (groupSelect.value !== group) groupSelect.value = group;
}
function snapshotFor(value, graph) {
  const model = value?.models?.[view.value];
  if (!model) return null;
  let expanded = expandedModels.get(model);
  if (!expanded) {
    expanded = expandModel(model);
    expandedModels.set(model, expanded);
  }
  // A malformed model that decodes to nothing must not hide a valid plain
  // graph: fall back to the capped `graphs` view.
  if (
    !expanded.nodes.length &&
    Array.isArray(graph?.nodes) &&
    graph.nodes.length
  )
    return null;
  const params = scaleParams();
  return { expanded, params };
}
function update(value) {
  latest = value;
  const graph = value?.graphs?.[view.value];
  if (!graph) {
    note.textContent = "Graph data unavailable.";
    scaleBar.hidden = true;
    return;
  }
  const scaled = snapshotFor(value, graph);
  let drawn = graph;
  let scaleText = "";
  if (scaled) {
    const { expanded, params } = scaled;
    const key = JSON.stringify([
      view.value,
      params.group,
      params.focus,
      params.hops,
    ]);
    if (key !== scaleKey) {
      scaleKey = key;
      page = 0;
      open = new Set();
    }
    drawn = projectGraph(expanded, { ...params, page, expanded: [...open] });
    // The page may have shrunk (data changed); keep it inside the range.
    page = drawn.scale.page;
    scaleText = describeScale(drawn);
    scaleBar.hidden = false;
    fillGroups(params.group);
    hopsSelect.value = String(drawn.scale.focus?.hops ?? params.hops);
    hopsSelect.disabled = !drawn.scale.focus;
    const label = drawn.scale.focus?.label;
    focusState.textContent = label
      ? `Focused on ${label}`
      : drawn.scale.focusMissing
        ? "The focused node is not in this graph."
        : "No node focused. Use Focus on a node in the list.";
    focusClear.hidden = !params.focus;
    const pages = drawn.scale.pages;
    prev.disabled = page <= 0;
    next.disabled = page >= pages - 1;
    prev.textContent = `Previous ${NODE_CAP}`;
    next.textContent = `Next ${NODE_CAP}`;
    const status = pages > 1 ? `Page ${page + 1} of ${pages}` : "";
    if (pageState.textContent !== status) pageState.textContent = status;
  } else scaleBar.hidden = true;
  note.textContent = `Explicit recorded relationships only. Process status is an observation, not productive work. ${value.coverage?.messagesIncluded ?? 0} of ${value.coverage?.messagesTotal ?? 0} events supplied. Task dependency metadata: ${value.coverage?.dependencyMetadata ?? "unknown"}.${scaleText ? ` ${scaleText}` : ""}`;
  if (renderer) renderer.update(drawn);
  else
    renderer = renderGraph(document, host, drawn, {
      onSelect: select,
      // Shared formatter from dashboard.js; raw value until it has loaded.
      formatTime: (at) => window.crewplane?.formatTime?.(at) ?? String(at),
      focusAction: {
        onFocus: (id) => {
          const params = scaleParams();
          window.crewplane?.setParams({
            focus: params.focus === id ? undefined : id,
          });
        },
      },
      onToggleCluster: (id) => {
        if (open.has(id)) open.delete(id);
        else open.add(id);
        update(latest);
      },
    });
}
view.addEventListener("change", () => {
  window.crewplane?.setParams({
    graph: view.value,
    group: undefined,
    focus: undefined,
    hops: undefined,
  });
  update(latest);
});
groupSelect.addEventListener("change", () =>
  window.crewplane?.setParams({
    group: groupSelect.value === "none" ? undefined : groupSelect.value,
  }),
);
hopsSelect.addEventListener("change", () =>
  window.crewplane?.setParams({
    hops: hopsSelect.value === "1" ? undefined : hopsSelect.value,
  }),
);
focusClear.addEventListener("click", () =>
  window.crewplane?.setParams({ focus: undefined, hops: undefined }),
);
prev.addEventListener("click", () => {
  page = Math.max(0, page - 1);
  update(latest);
});
next.addEventListener("click", () => {
  page += 1;
  update(latest);
});
window.addEventListener("crewplane-graphs", (event) => update(event.detail));
window.addEventListener("crewplane-route", (event) => {
  if (event.detail.view !== "relationships") return;
  const nextView = event.detail.params.graph ?? "communication";
  const changed = view.value !== nextView;
  view.value = nextView;
  const key = JSON.stringify([
    view.value,
    event.detail.params.group ?? "none",
    event.detail.params.focus ?? null,
    event.detail.params.hops ?? "1",
  ]);
  if (changed || key !== scaleKey) update(latest);
});
if (window.crewplaneGraphSnapshot) update(window.crewplaneGraphSnapshot);
