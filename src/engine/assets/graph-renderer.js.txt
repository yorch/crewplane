const selectableKinds = new Set(["task", "lane"]);
const svgNamespace = "http://www.w3.org/2000/svg";
const pill = { width: 128, height: 34 };

/** Layered positions: prerequisites to the left; cycles are cut by a visit guard. */
function layeredLayout(nodes, edges) {
  const dependsOn = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges)
    if (dependsOn.has(edge.from) && dependsOn.has(edge.to))
      dependsOn.get(edge.from).push(edge.to);
  const depth = new Map();
  const visit = (id, trail) => {
    if (depth.has(id)) return depth.get(id);
    if (trail.has(id)) return 0;
    trail.add(id);
    let value = 0;
    for (const target of dependsOn.get(id))
      value = Math.max(value, visit(target, trail) + 1);
    trail.delete(id);
    depth.set(id, value);
    return value;
  };
  const layers = new Map();
  for (const node of nodes) {
    const layer = visit(node.id, new Set());
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const positions = new Map();
  let height = 0;
  for (const [layer, members] of layers) {
    for (const [index, node] of members.entries())
      positions.set(node.id, { x: 90 + layer * 180, y: 36 + index * 56 });
    height = Math.max(height, 36 + members.length * 56);
  }
  const width = 180 + Math.max(0, ...layers.keys()) * 180;
  return { positions, width, height };
}
function circularLayout(nodes) {
  const radius = Math.max(70, (nodes.length * 150) / (2 * Math.PI));
  const centerX = radius + 90;
  const centerY = radius + 40;
  const positions = new Map();
  nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / nodes.length - Math.PI / 2;
    positions.set(node.id, {
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    });
  });
  return { positions, width: centerX * 2, height: centerY * 2 };
}
function pillEdge(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const scale = Math.min(
    dx ? (pill.width / 2 + 6) / Math.abs(dx) : Number.POSITIVE_INFINITY,
    dy ? (pill.height / 2 + 6) / Math.abs(dy) : Number.POSITIVE_INFINITY,
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}
function shorten(label) {
  const text = String(label);
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

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
  const svgElement = (tag, attributes, parent) => {
    const element = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes))
      element.setAttribute(name, String(value));
    parent?.append(element);
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
    ["lane", "Agents"],
    ["task", "Tasks"],
  ]) {
    const option = make("option", label, kind);
    option.value = value;
  }
  const summary = make("p");
  summary.className = "relay-graph-summary";
  summary.setAttribute("role", "status");
  // The diagram is a visual aid; node buttons and the table carry the same data.
  const canvas = make("div");
  canvas.className = "relay-graph-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const svg = svgElement("svg", { class: "relay-graph-svg" }, canvas);
  const nodesHost = make("div");
  nodesHost.className = "relay-graph-nodes";
  const details = make("details");
  details.open = true;
  make("summary", "Relationship table (accessible graph fallback)", details);
  const tableScroller = make("div", undefined, details);
  tableScroller.className = "relay-graph-table";
  const table = make("table", undefined, tableScroller);
  make("caption", "Explicit directed relationships", table);
  const head = make("thead", undefined, table);
  const header = make("tr", undefined, head);
  for (const text of ["Source → target", "Kind / state", "Select thread"])
    make("th", text, header).scope = "col";
  const body = make("tbody", undefined, table);
  host.append(root);
  const nodeElements = new Map();
  const nodeParts = new Map();
  const edgeElements = new Map();
  let snapshot;
  let selected = null;
  let drawn = { nodes: [], edges: [], view: "communication" };
  const draw = () => {
    const { nodes, edges, view } = drawn;
    canvas.hidden = nodes.length === 0;
    svg.replaceChildren();
    if (!nodes.length) return;
    const { positions, width, height } =
      view === "dependencies"
        ? layeredLayout(nodes, edges)
        : circularLayout(nodes);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const defs = svgElement("defs", {}, svg);
    for (const [id, className] of [
      ["relay-arrow", "relay-arrow"],
      ["relay-arrow-open", "relay-arrow relay-arrow-open"],
    ]) {
      const marker = svgElement(
        "marker",
        {
          id,
          viewBox: "0 0 10 10",
          refX: 9,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: "auto-start-reverse",
        },
        defs,
      );
      svgElement("path", { d: "M0 0L10 5L0 10z", class: className }, marker);
    }
    const pairs = new Map();
    for (const edge of edges) {
      if (
        edge.from === edge.to ||
        !positions.has(edge.from) ||
        !positions.has(edge.to)
      )
        continue;
      const key = JSON.stringify([edge.from, edge.to]);
      const pair = pairs.get(key) ?? {
        from: edge.from,
        to: edge.to,
        count: 0,
        open: false,
      };
      pair.count++;
      pair.open ||= edge.unanswered;
      pairs.set(key, pair);
    }
    for (const pair of pairs.values()) {
      const from = positions.get(pair.from);
      const to = positions.get(pair.to);
      const start = pillEdge(from, to);
      const end = pillEdge(to, from);
      // Bend each direction to its own side so A→B and B→A stay readable.
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy) || 1;
      const controlX = (start.x + end.x) / 2 - (dy / length) * 18;
      const controlY = (start.y + end.y) / 2 + (dx / length) * 18;
      svgElement(
        "path",
        {
          d: `M${start.x} ${start.y}Q${controlX} ${controlY} ${end.x} ${end.y}`,
          class: pair.open ? "relay-edge relay-edge-open" : "relay-edge",
          "marker-end": pair.open
            ? "url(#relay-arrow-open)"
            : "url(#relay-arrow)",
        },
        svg,
      );
      if (pair.count > 1) {
        const label = svgElement(
          "text",
          { x: controlX, y: controlY, class: "relay-edge-count" },
          svg,
        );
        label.textContent = `×${pair.count}`;
      }
    }
    for (const node of nodes) {
      const position = positions.get(node.id);
      const isSelected =
        selected?.kind === node.kind && selected.id === node.id;
      const group = svgElement(
        "g",
        {
          class: `relay-node relay-node-${node.kind}${isSelected ? " is-selected" : ""}`,
          "data-node-id": node.id,
          "data-node-kind": node.kind,
        },
        svg,
      );
      svgElement("title", {}, group).textContent = node.label;
      svgElement(
        "rect",
        {
          x: position.x - pill.width / 2,
          y: position.y - pill.height / 2,
          width: pill.width,
          height: pill.height,
          rx: 8,
        },
        group,
      );
      svgElement(
        "text",
        { x: position.x, y: position.y + 4 },
        group,
      ).textContent = shorten(node.label);
    }
  };
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
    draw();
    options.onSelect?.({ ...value });
  };
  svg.addEventListener("click", (event) => {
    const group = event.target.closest?.("[data-node-id]");
    if (!group || !selectableKinds.has(group.dataset.nodeKind)) return;
    choose({ kind: group.dataset.nodeKind, id: group.dataset.nodeId });
  });
  const syncOrder = (parent, elements) => {
    elements.forEach((element, index) => {
      if (parent.children[index] !== element)
        parent.insertBefore(element, parent.children[index] ?? null);
    });
  };
  const createNodeButton = (id) => {
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () =>
      choose({ kind: button.dataset.kind, id }),
    );
    const heading = make("span", undefined, button);
    heading.className = "relay-node-heading";
    const label = make("span", undefined, heading);
    label.className = "relay-node-label";
    const nodeKind = make("span", undefined, heading);
    nodeKind.className = "relay-node-kind";
    const primary = make("span", undefined, button);
    primary.className = "relay-node-line";
    const secondary = make("span", undefined, button);
    secondary.className = "relay-node-line relay-node-muted";
    nodeParts.set(id, { label, nodeKind, primary, secondary });
    return button;
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
        button = createNodeButton(node.id);
        nodeElements.set(node.id, button);
      }
      button.dataset.kind = node.kind;
      button.disabled = !selectableKinds.has(node.kind);
      const parts = nodeParts.get(node.id);
      parts.label.textContent = node.label;
      parts.nodeKind.textContent = node.kind === "lane" ? "Agent" : node.kind;
      if (node.kind === "task") {
        parts.primary.textContent = `Task status: ${node.taskStatus ?? "unknown"}`;
        parts.secondary.textContent = `Accepted: ${node.accepted ? "yes" : "no"}`;
      } else {
        parts.primary.textContent = `Process: ${node.processStatus ?? "unknown"} · Task status: ${node.taskStatus ?? "unknown"}`;
        parts.secondary.textContent = `Role: ${node.role ?? "unknown"} · Harness: ${node.harness ?? "unknown"} · Observed model: ${node.observedModel ?? "unknown"} · Task: ${node.taskId ?? "unknown"} · Accepted: ${node.accepted ? "yes" : "no"}`;
      }
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
        nodeParts.delete(id);
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
    summary.textContent = `${visible.length} nodes; ${edges.length} relationships. Archived/hidden upstream: ${next.hidden.nodes} nodes, ${next.hidden.edges} edges. Truncated: ${(next.truncated?.nodes ?? 0) + Math.max(0, next.nodes.length - 50)} nodes, ${(next.truncated?.edges ?? 0) + Math.max(0, next.edges.length - 100)} edges. Filtered/view hidden: ${suppliedNodes.length - visible.length} nodes, ${suppliedEdges.length - edges.length} edges. Missing-reference relationships: ${missing}.${visible.length === 0 ? " No matching nodes." : ""}`;
    drawn = { nodes: visible, edges, view: next.view };
    draw();
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
      nodeParts.clear();
      edgeElements.clear();
    },
  };
}
