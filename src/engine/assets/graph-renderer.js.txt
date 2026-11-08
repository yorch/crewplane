const selectableKinds = new Set(["task", "lane"]);

/** Render only the supplied bounded graph projection. Selection IDs are opaque. */
export function renderGraph(document, host, initialSnapshot, options = {}) {
  const root = document.createElement("section");
  root.className = "relay-graph";
  root.setAttribute("aria-label", "Operational relationships");
  const make = (tag, text, parent = root) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent.append(element);
    return element;
  };
  const title = make("h2");
  const legend = make(
    "p",
    "Arrows run from source to target. Dependency and communication views use explicit supplied relationships only.",
  );
  legend.className = "relay-graph-legend";
  const controls = make("div");
  controls.className = "relay-graph-controls";
  const searchLabel = make("label", "Filter text ", controls);
  const search = make("input", undefined, searchLabel);
  search.type = "search";
  const kindLabel = make("label", "Node kind ", controls);
  const kind = make("select", undefined, kindLabel);
  for (const [value, label] of [
    ["", "All nodes"],
    ["lane", "Lanes"],
    ["task", "Tasks"],
  ]) {
    const option = make("option", label, kind);
    option.value = value;
  }
  const summary = make("p");
  summary.setAttribute("role", "status");
  const nodesHost = make("div");
  nodesHost.className = "relay-graph-nodes";
  const details = make("details");
  details.open = true;
  make("summary", "Relationship table (accessible graph fallback)", details);
  const table = make("table", undefined, details);
  make("caption", "Explicit directed relationships", table);
  const head = make("thead", undefined, table);
  const header = make("tr", undefined, head);
  for (const text of ["Source → target", "Kind / state", "Select thread"])
    make("th", text, header).scope = "col";
  const body = make("tbody", undefined, table);
  host.append(root);
  const nodeElements = new Map();
  const edgeElements = new Map();
  let snapshot;
  let selected = null;
  const choose = (value) => {
    selected = value;
    for (const [id, button] of nodeElements)
      button.setAttribute(
        "aria-pressed",
        String(selected.kind === button.dataset.kind && selected.id === id),
      );
    for (const row of edgeElements.values()) {
      const button = row.querySelector("button");
      if (button)
        button.setAttribute(
          "aria-pressed",
          String(
            selected.kind === "thread" && selected.id === button.dataset.thread,
          ),
        );
    }
    options.onSelect?.({ ...value });
  };
  const syncOrder = (parent, elements) => {
    elements.forEach((element, index) => {
      if (parent.children[index] !== element)
        parent.insertBefore(element, parent.children[index] ?? null);
    });
  };
  function update(next) {
    snapshot = next;
    const activeControl = root.contains(document.activeElement)
      ? document.activeElement
      : null;
    const scrollTop = host.scrollTop;
    const scrollLeft = host.scrollLeft;
    title.textContent =
      next.view === "dependencies"
        ? "Task dependencies"
        : "Communication threads";
    const suppliedNodes = next.nodes.slice(0, 50);
    const suppliedEdges = next.edges.slice(0, 100);
    const known = new Map(suppliedNodes.map((node) => [node.id, node]));
    const query = search.value.toLocaleLowerCase();
    const visible = suppliedNodes.filter(
      (node) =>
        (!kind.value || node.kind === kind.value) &&
        [
          node.label,
          node.role,
          node.taskId,
          node.harness,
          node.observedModel,
          node.processStatus,
          node.taskStatus,
        ].some((value) =>
          String(value ?? "")
            .toLocaleLowerCase()
            .includes(query),
        ),
    );
    const ids = new Set(visible.map((node) => node.id));
    const nodeOrder = [];
    for (const node of visible) {
      let button = nodeElements.get(node.id);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.addEventListener("click", () =>
          choose({ kind: button.dataset.kind, id: node.id }),
        );
        nodeElements.set(node.id, button);
      }
      button.dataset.kind = node.kind;
      button.disabled = !selectableKinds.has(node.kind);
      button.textContent = `${node.label} · ${node.kind} · Role: ${node.role ?? "unknown"} · Harness: ${node.harness ?? "unknown"} · Observed model: ${node.observedModel ?? "unknown"} · Task: ${node.taskId ?? "unknown"} · Process: ${node.processStatus ?? "unknown"} · Task status: ${node.taskStatus ?? "unknown"} · Accepted: ${node.accepted ? "yes" : "no"}`;
      button.setAttribute(
        "aria-pressed",
        String(selected?.kind === node.kind && selected?.id === node.id),
      );
      nodeOrder.push(button);
    }
    for (const [id, element] of nodeElements)
      if (!ids.has(id)) {
        element.remove();
        nodeElements.delete(id);
      }
    syncOrder(nodesHost, nodeOrder);
    const edges = suppliedEdges.filter(
      (edge) =>
        (next.view === "dependencies"
          ? edge.kind === "dependency"
          : edge.kind !== "dependency") &&
        (!known.has(edge.from) || ids.has(edge.from)) &&
        (!known.has(edge.to) || ids.has(edge.to)),
    );
    const edgeIds = new Set(edges.map((edge) => edge.id));
    const edgeOrder = [];
    for (const edge of edges) {
      let row = edgeElements.get(edge.id);
      if (!row) {
        row = document.createElement("tr");
        for (let index = 0; index < 3; index++)
          row.append(document.createElement("td"));
        edgeElements.set(edge.id, row);
      }
      row.children[0].textContent = `${known.get(edge.from)?.label ?? `[Missing reference: ${edge.from}]`} → ${known.get(edge.to)?.label ?? `[Missing reference: ${edge.to}]`}`;
      row.children[1].textContent = `${edge.kind}: ${edge.label} · ${edge.unanswered ? "unanswered" : "not marked unanswered"}${edge.at ? ` · Recorded: ${edge.at}` : ""}`;
      const cell = row.children[2];
      if (edge.threadId !== null) {
        let button = cell.querySelector("button");
        if (!button) {
          cell.textContent = "";
          button = document.createElement("button");
          button.type = "button";
          button.addEventListener("click", () =>
            choose({ kind: "thread", id: button.dataset.thread }),
          );
          cell.append(button);
        }
        button.dataset.thread = edge.threadId;
        button.textContent = `Open thread: ${edge.label}`;
        button.setAttribute(
          "aria-pressed",
          String(selected?.kind === "thread" && selected?.id === edge.threadId),
        );
      } else cell.textContent = "No thread reference";
      edgeOrder.push(row);
    }
    for (const [id, row] of edgeElements)
      if (!edgeIds.has(id)) {
        row.remove();
        edgeElements.delete(id);
      }
    syncOrder(body, edgeOrder);
    const missing = edges.filter(
      (edge) => !known.has(edge.from) || !known.has(edge.to),
    ).length;
    summary.textContent = `${visible.length} nodes; ${edges.length} relationships. Archived/hidden upstream: ${next.hidden.nodes} nodes, ${next.hidden.edges} edges. Truncated: ${Math.max(0, next.nodes.length - 50)} nodes, ${Math.max(0, next.edges.length - 100)} edges. Filtered/view hidden: ${suppliedNodes.length - visible.length} nodes, ${suppliedEdges.length - edges.length} edges. Missing-reference relationships: ${missing}.${visible.length === 0 ? " No matching nodes." : ""}`;
    if (activeControl?.isConnected && root.contains(activeControl)) {
      activeControl.focus({ preventScroll: true });
    }
    host.scrollTop = scrollTop;
    host.scrollLeft = scrollLeft;
  }
  const filter = () => update(snapshot);
  search.addEventListener("input", filter);
  kind.addEventListener("change", filter);
  update(initialSnapshot);
  return {
    update,
    destroy() {
      search.removeEventListener("input", filter);
      kind.removeEventListener("change", filter);
      root.remove();
      nodeElements.clear();
      edgeElements.clear();
    },
  };
}
