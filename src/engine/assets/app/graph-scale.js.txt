// Pure projection for the relationship graph at scale. The server sends a
// compact model (up to 1100 nodes and 3000 edges, see buildGraphModel in
// graph-builder.ts). This module turns it, on request, into the small
// snapshot the renderer draws: at most NODE_CAP items and EDGE_CAP edges at a
// time, however large the model is. Three tools reach the rest:
//   clusters  group nodes (by owner, phase, role or harness); a collapsed
//             cluster is one item, an expanded one shows its members;
//   focus     one node and everything within 1 to 3 hops of it;
//   paging    the items ranked by priority, NODE_CAP per page.
// No DOM and no network. Nothing here grants authority: it only chooses what
// to draw from explicit, already supplied relationships.

export const NODE_CAP = 50;
export const EDGE_CAP = 100;
export const MAX_HOPS = 3;
// 1000 tasks and 64 lanes: the most a validated input can hold (graph-builder.ts).
const MODEL_NODES = 1064;
const MODEL_EDGES = 3000;
const EDGE_KINDS = [
  "dependency",
  "awaiting-answer",
  "review-handoff",
  "message",
];
export const GROUP_MODES = {
  dependencies: ["none", "owner", "phase"],
  communication: ["none", "role", "harness"],
};
export const GROUP_LABELS = {
  none: "No grouping",
  owner: "Agent",
  phase: "Phase",
  role: "Role",
  harness: "Harness",
};
const EMPTY_KEY = {
  owner: "Unassigned",
  phase: "No phase",
  role: "No role",
  harness: "No harness",
};
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const orNull = (value) => (text(value) ? value : null);

/**
 * Fills defaults, drops malformed rows and indexes neighbours. Bounded.
 * Reads the compact version 2 model (edges `[from, to, kind, ref, unanswered]`
 * with node indexes and a `refs` table) and, for older servers, the version 1
 * edge tuples `[from, to, kind, label, threadId, at, unanswered]` by id.
 */
export function expandModel(model) {
  const view =
    model?.view === "dependencies" ? "dependencies" : "communication";
  const nodeKind = view === "dependencies" ? "task" : "lane";
  const nodes = [];
  const byId = new Map();
  // Edge endpoints index the rows as sent, so a dropped row leaves a hole.
  const slots = [];
  for (const raw of Array.isArray(model?.nodes)
    ? model.nodes.slice(0, MODEL_NODES)
    : []) {
    if (!raw || !text(raw.id) || byId.has(raw.id)) {
      slots.push(null);
      continue;
    }
    const kind =
      raw.kind === "task" || raw.kind === "lane" ? raw.kind : nodeKind;
    const node = {
      id: raw.id,
      kind,
      label: text(raw.label) ? raw.label : raw.id,
      role: orNull(raw.role),
      harness: orNull(raw.harness),
      observedModel: orNull(raw.observedModel),
      taskId: orNull(raw.taskId) ?? (kind === "task" ? raw.id : null),
      processStatus: orNull(raw.processStatus),
      taskStatus: orNull(raw.taskStatus),
      accepted: raw.accepted === true,
      phase: orNull(raw.phase),
      owner: orNull(raw.owner),
    };
    byId.set(node.id, node);
    nodes.push(node);
    slots.push(node);
  }
  const refs = Array.isArray(model?.refs) ? model.refs : [];
  const endpoint = (value) =>
    Number.isInteger(value) ? (slots[value]?.id ?? null) : value;
  const edges = [];
  const seen = new Map();
  const neighbours = new Map(nodes.map((node) => [node.id, new Set()]));
  const open = new Map(nodes.map((node) => [node.id, 0]));
  for (const raw of Array.isArray(model?.edges)
    ? model.edges.slice(0, MODEL_EDGES)
    : []) {
    if (!Array.isArray(raw)) continue;
    let from;
    let to;
    let kindIndex;
    let label;
    let threadId;
    let at;
    let unanswered;
    if (raw.length >= 7) {
      [from, to, kindIndex, label, threadId, at, unanswered] = raw;
    } else {
      [from, to, kindIndex, , unanswered] = raw;
      const row = refs[raw[3]];
      if (!Array.isArray(row)) continue;
      [label, threadId, at] = row;
      from = endpoint(from);
      to = endpoint(to);
    }
    if (!text(from) || !text(to)) continue;
    const kind = EDGE_KINDS[kindIndex] ?? "message";
    const base = `${kind}\u0000${from}\u0000${to}\u0000${label}\u0000${threadId ?? ""}\u0000${at ?? ""}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    edges.push({
      id: count ? `${base}\u0000${count}` : base,
      from,
      to,
      kind,
      label: text(label) ? label : kind,
      threadId: orNull(threadId),
      at: orNull(at),
      unanswered: unanswered === 1 || unanswered === true,
    });
    neighbours.get(from)?.add(to);
    neighbours.get(to)?.add(from);
    if (unanswered === 1 || unanswered === true) {
      if (open.has(from)) open.set(from, (open.get(from) ?? 0) + 1);
      if (open.has(to)) open.set(to, (open.get(to) ?? 0) + 1);
    }
  }
  return {
    view,
    nodes,
    byId,
    edges,
    neighbours,
    open,
    hidden: {
      nodes: Number(model?.hidden?.nodes) || 0,
      edges: Number(model?.hidden?.edges) || 0,
    },
    truncated: {
      nodes: Number(model?.truncated?.nodes) || 0,
      edges: Number(model?.truncated?.edges) || 0,
    },
  };
}

/** Higher means more worth showing first: trouble, then open questions. */
export function priority(expanded, node) {
  let score = 0;
  if (node.kind === "task") {
    if (node.taskStatus === "blocked") score += 1000;
    else if (node.taskStatus === "review") score += 450;
    else if (node.taskStatus === "working") score += 250;
    if (!node.accepted) score += 100;
  } else {
    if (node.processStatus === "stale") score += 900;
    else if (node.processStatus === "paused") score += 800;
    else if (node.processStatus === "running") score += 300;
    if (node.taskStatus === "blocked") score += 600;
  }
  score += Math.min(expanded.open.get(node.id) ?? 0, 3) * 500;
  score += Math.min(expanded.neighbours.get(node.id)?.size ?? 0, 50);
  return score;
}

/** Distances from `focus`, up to `hops`. Ids not in the model give null. */
export function neighbourhood(expanded, focus, hops) {
  if (!expanded.byId.has(focus)) return null;
  const limit = Math.max(1, Math.min(MAX_HOPS, Math.trunc(hops) || 1));
  const distance = new Map([[focus, 0]]);
  let frontier = [focus];
  for (let step = 1; step <= limit && frontier.length; step++) {
    const next = [];
    for (const id of frontier)
      for (const other of expanded.neighbours.get(id) ?? [])
        if (!distance.has(other) && expanded.byId.has(other)) {
          distance.set(other, step);
          next.push(other);
        }
    frontier = next;
  }
  return distance;
}

function groupKey(node, mode) {
  const value = node[mode];
  return text(value) ? value : null;
}
const clusterId = (mode, key) => `cluster:${mode}:${key ?? "\u0000"}`;
const troubled = (node) =>
  node.taskStatus === "blocked" ||
  node.processStatus === "stale" ||
  node.processStatus === "paused";

/**
 * The snapshot to draw. Options: group ("none" or a mode of the view), focus
 * (a node id), hops (1 to 3), page (0 based), expanded (cluster ids).
 */
export function projectGraph(expanded, options = {}) {
  const cap = NODE_CAP;
  const mode = GROUP_MODES[expanded.view].includes(options.group)
    ? options.group
    : "none";
  const open = new Set(options.expanded ?? []);
  const distance = options.focus
    ? neighbourhood(expanded, options.focus, options.hops ?? 1)
    : null;
  const pool = distance
    ? expanded.nodes.filter((node) => distance.has(node.id))
    : expanded.nodes;
  const rank = new Map(pool.map((node) => [node.id, priority(expanded, node)]));
  const near = (node) => distance?.get(node.id) ?? 0;

  // Items: plain nodes, collapsed clusters, and expanded clusters (a header
  // followed by its members as plain nodes).
  const itemOf = new Map();
  const items = [];
  const plain = (node) => ({
    type: "node",
    id: node.id,
    node,
    rank: rank.get(node.id) ?? 0,
    near: near(node),
  });
  if (mode === "none") {
    for (const node of pool) {
      const item = plain(node);
      items.push(item);
      itemOf.set(node.id, item);
    }
  } else {
    const groups = new Map();
    for (const node of pool) {
      const key = groupKey(node, mode);
      const list = groups.get(key);
      if (list) list.push(node);
      else groups.set(key, [node]);
    }
    for (const [key, members] of groups) {
      if (members.length < 2) {
        const item = plain(members[0]);
        items.push(item);
        itemOf.set(item.id, item);
        continue;
      }
      const id = clusterId(mode, key);
      const isOpen = open.has(id);
      let top = 0;
      let nearest = Infinity;
      for (const node of members) {
        top = Math.max(top, rank.get(node.id) ?? 0);
        nearest = Math.min(nearest, near(node));
      }
      const header = {
        type: "cluster",
        id,
        key,
        mode,
        members,
        open: isOpen,
        // The header sorts just ahead of its own members.
        rank: top + 1,
        near: nearest,
      };
      items.push(header);
      if (isOpen)
        for (const node of members) {
          const item = { ...plain(node), clusterId: id };
          items.push(item);
          itemOf.set(node.id, item);
        }
      else for (const node of members) itemOf.set(node.id, header);
    }
  }
  items.sort(
    (a, b) => a.near - b.near || b.rank - a.rank || compare(a.id, b.id),
  );
  const pages = Math.max(1, Math.ceil(items.length / cap));
  const page = Math.max(0, Math.min(Math.trunc(options.page) || 0, pages - 1));
  const shown = items.slice(page * cap, (page + 1) * cap);
  const shownIds = new Set(shown.map((item) => item.id));

  // Edges between items. Plain-to-plain edges keep their thread links; any
  // edge touching a collapsed cluster is merged into one count.
  const merged = new Map();
  const direct = [];
  const endpoint = (id) =>
    itemOf.get(id) ??
    (expanded.byId.has(id) ? undefined : { type: "missing", id });
  let internal = 0;
  let offPage = 0;
  for (const edge of expanded.edges) {
    // A reference to something that is not a model node (an archived or
    // never recorded task, a recipient that is not a lane) stays visible, as
    // it does in the server's own graph: it becomes a pass-through endpoint
    // the renderer labels as a missing reference. A node merely outside the
    // focus neighbourhood is different: it is not drawn, so neither is its
    // edge.
    const from = endpoint(edge.from);
    const to = endpoint(edge.to);
    if (!from || !to) continue;
    if (from === to && from.type === "cluster") {
      internal++;
      continue;
    }
    if (
      (from.type !== "missing" && !shownIds.has(from.id)) ||
      (to.type !== "missing" && !shownIds.has(to.id))
    ) {
      offPage++;
      continue;
    }
    if (from.type === "cluster" || to.type === "cluster") {
      const key = `${from.id}\u0001${to.id}`;
      const row = merged.get(key) ?? {
        id: `merged\u0000${key}`,
        from: from.id,
        to: to.id,
        kind: expanded.view === "dependencies" ? "dependency" : "message",
        label: "relationships",
        threadId: null,
        at: null,
        unanswered: false,
        count: 0,
      };
      row.count++;
      row.unanswered ||= edge.unanswered;
      merged.set(key, row);
    } else direct.push(edge);
  }
  const combined = [
    ...direct,
    ...[...merged.values()].map((row) => ({
      ...row,
      label: `${row.count} ${row.count === 1 ? "relationship" : "relationships"}`,
    })),
  ];
  // Open questions first, then the order the server gave (newest first).
  const ordered = [
    ...combined.filter((edge) => edge.unanswered),
    ...combined.filter((edge) => !edge.unanswered),
  ];
  const edges = ordered.slice(0, EDGE_CAP);

  const nodes = shown.map((item) => {
    if (item.type === "node")
      // A member of an expanded cluster says which, so it can be drawn
      // beside its header.
      return item.clusterId
        ? { ...item.node, clusterId: item.clusterId }
        : item.node;
    const members = item.members;
    const blocked = members.filter(troubled).length;
    const noun = members.every((node) => node.kind === "task")
      ? "tasks"
      : members.every((node) => node.kind === "lane")
        ? "agents"
        : "nodes";
    return {
      id: item.id,
      kind: "cluster",
      label: `${GROUP_LABELS[item.mode]}: ${item.key ?? EMPTY_KEY[item.mode]}`,
      role: null,
      harness: null,
      observedModel: null,
      taskId: null,
      processStatus: null,
      taskStatus: null,
      accepted: false,
      clusterOpen: item.open,
      clusterCount: members.length,
      clusterNoun: noun,
      clusterTrouble: blocked,
    };
  });
  const focusNode = options.focus ? expanded.byId.get(options.focus) : null;
  return {
    version: 1,
    view: expanded.view,
    nodes,
    edges,
    hidden: expanded.hidden,
    truncated: {
      nodes: items.length - shown.length + expanded.truncated.nodes,
      edges: ordered.length - edges.length + offPage + expanded.truncated.edges,
    },
    scale: {
      group: mode,
      page,
      pages,
      totalItems: items.length,
      shownItems: shown.length,
      first: shown.length ? page * cap + 1 : 0,
      last: page * cap + shown.length,
      poolSize: pool.length,
      modelNodes: expanded.nodes.length,
      modelEdges: expanded.edges.length,
      internalEdges: internal,
      edgesOffPage: offPage,
      focus: focusNode
        ? {
            id: focusNode.id,
            label: focusNode.label,
            hops: Math.max(
              1,
              Math.min(MAX_HOPS, Math.trunc(options.hops) || 1),
            ),
            reach: pool.length,
          }
        : null,
      focusMissing: Boolean(options.focus) && !focusNode,
    },
  };
}

const fmt = (value) => value.toLocaleString("en-US");
/** One sentence about what part of the model is on screen. */
export function describeScale(snapshot) {
  const scale = snapshot.scale;
  if (!scale) return "";
  const parts = [];
  if (scale.focus)
    parts.push(
      `Focused on ${scale.focus.label} and everything within ${scale.focus.hops} ${scale.focus.hops === 1 ? "hop" : "hops"} (${fmt(scale.poolSize)} ${scale.poolSize === 1 ? "node" : "nodes"}).`,
    );
  if (scale.focusMissing)
    parts.push(
      "The focused node is not in the graph model, so all nodes show.",
    );
  const unit = scale.group === "none" ? "nodes" : "items";
  parts.push(
    scale.totalItems === 0
      ? "Nothing to show."
      : `Showing ${fmt(scale.first)} to ${fmt(scale.last)} of ${fmt(scale.totalItems)} ${unit} by priority (blocked and paused work and open questions first), page ${scale.page + 1} of ${scale.pages}.`,
  );
  if (scale.internalEdges)
    parts.push(
      scale.internalEdges === 1
        ? "1 relationship stays inside a collapsed cluster."
        : `${fmt(scale.internalEdges)} relationships stay inside collapsed clusters.`,
    );
  if (snapshot.truncated.nodes || snapshot.truncated.edges)
    parts.push(
      `Not drawn on this page: ${fmt(snapshot.truncated.nodes)} ${snapshot.truncated.nodes === 1 ? "node" : "nodes"}, ${fmt(snapshot.truncated.edges)} ${snapshot.truncated.edges === 1 ? "relationship" : "relationships"}.`,
    );
  return parts.join(" ");
}
