import { describe, expect, it } from "vitest";
import {
  describeScale,
  EDGE_CAP,
  expandModel,
  MAX_HOPS,
  NODE_CAP,
  neighbourhood,
  projectGraph,
} from "./graph-scale.js";

type Model = Record<string, unknown>;
const taskNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "task",
  label: id,
  taskStatus: "working",
  ...extra,
});
const dep = (from: string, to: string): unknown[] => [
  from,
  to,
  0,
  "requires accepted",
  null,
  null,
  0,
];
/** n tasks in a chain t0 <- t1 <- t2 ..., split over `lanes` owners. */
function chain(n: number, lanes = 4): Model {
  return {
    version: 1,
    view: "dependencies",
    nodes: Array.from({ length: n }, (_, i) =>
      taskNode(`t${i}`, { owner: `lane${i % lanes}`, phase: String(i % 3) }),
    ),
    edges: Array.from({ length: n - 1 }, (_, i) => dep(`t${i + 1}`, `t${i}`)),
    hidden: { nodes: 0, edges: 0 },
    truncated: { nodes: 0, edges: 0 },
  };
}
const expanded = (model: Model) => expandModel(model);
const ids = (snapshot: { nodes: { id: string }[] }) =>
  snapshot.nodes.map((n) => n.id);

describe("model expansion", () => {
  it("fills defaults, drops malformed rows and keeps edges unique", () => {
    const model = expanded({
      view: "communication",
      nodes: [
        { id: "a", kind: "lane", label: "A", processStatus: "running" },
        { id: "a", kind: "lane", label: "dup" },
        { id: "", kind: "lane", label: "bad" },
        null,
        { id: "b", kind: "lane" },
      ],
      edges: [
        ["a", "b", 1, "question", "thread", "2026-01-01T00:00:00Z", 1],
        ["a", "b", 1, "question", "thread", "2026-01-01T00:00:00Z", 1],
        ["a", "", 3, "x", null, null, 0],
        "nope",
      ],
    });
    expect(model.nodes.map((n: { id: string }) => n.id)).toEqual(["a", "b"]);
    expect(model.nodes[1]).toMatchObject({ label: "b", role: null });
    expect(model.edges).toHaveLength(2);
    expect(new Set(model.edges.map((e: { id: string }) => e.id)).size).toBe(2);
    expect(model.edges[0]).toMatchObject({
      kind: "awaiting-answer",
      unanswered: true,
    });
    expect(expandModel(null).nodes).toEqual([]);
  });
  it("bounds a hostile model", () => {
    const huge = {
      view: "dependencies",
      nodes: Array.from({ length: 20_000 }, (_, i) => taskNode(`n${i}`)),
      edges: Array.from({ length: 50_000 }, (_, i) => dep(`n${i}`, "n0")),
    };
    const model = expandModel(huge);
    expect(model.nodes.length).toBeLessThanOrEqual(1100);
    expect(model.edges.length).toBeLessThanOrEqual(3000);
  });
});

describe("paging by priority", () => {
  it("never shows more than the cap and puts trouble first", () => {
    const model = chain(200);
    (model.nodes as Record<string, unknown>[])[137] = taskNode("t137", {
      taskStatus: "blocked",
    });
    const snapshot = projectGraph(expanded(model), {});
    expect(snapshot.nodes).toHaveLength(NODE_CAP);
    expect(snapshot.edges.length).toBeLessThanOrEqual(EDGE_CAP);
    expect(ids(snapshot)[0]).toBe("t137");
    expect(snapshot.scale).toMatchObject({
      page: 0,
      pages: 4,
      totalItems: 200,
      first: 1,
      last: 50,
    });
    expect(snapshot.truncated.nodes).toBe(150);
  });
  it("pages without overlap or gaps and clamps the page", () => {
    const model = expanded(chain(130));
    const seen: string[] = [];
    for (let page = 0; page < 3; page++) {
      const snap = projectGraph(model, { page });
      expect(snap.nodes.length).toBeLessThanOrEqual(NODE_CAP);
      seen.push(...ids(snap));
    }
    expect(new Set(seen).size).toBe(130);
    expect(projectGraph(model, { page: 99 }).scale.page).toBe(2);
    expect(projectGraph(model, { page: -4 }).scale.page).toBe(0);
    expect(projectGraph(model, { page: Number.NaN }).scale.page).toBe(0);
  });
  it("only draws edges whose two ends are on the page", () => {
    const snap = projectGraph(expanded(chain(130)), { page: 1 });
    const shown = new Set(ids(snap));
    for (const edge of snap.edges) {
      expect(shown.has(edge.from)).toBe(true);
      expect(shown.has(edge.to)).toBe(true);
    }
    expect(snap.truncated.edges).toBeGreaterThan(0);
  });
  it("is deterministic", () => {
    const model = expanded(chain(120));
    expect(JSON.stringify(projectGraph(model, { page: 1 }))).toBe(
      JSON.stringify(projectGraph(model, { page: 1 })),
    );
  });
});

describe("focus mode", () => {
  it("shows exactly the 1, 2 and 3 hop neighbourhood", () => {
    const model = expanded(chain(100));
    const reach = (hops: number) =>
      ids(projectGraph(model, { focus: "t50", hops })).sort();
    expect(reach(1)).toEqual(["t49", "t50", "t51"].sort());
    expect(reach(2)).toEqual(["t48", "t49", "t50", "t51", "t52"].sort());
    expect(reach(3)).toHaveLength(7);
    // Hops are clamped to 1..3.
    expect(reach(9)).toHaveLength(7);
    expect(reach(0)).toHaveLength(3);
    expect(
      projectGraph(model, { focus: "t50", hops: 2 }).scale.focus,
    ).toMatchObject({
      id: "t50",
      hops: 2,
      reach: 5,
    });
    expect(MAX_HOPS).toBe(3);
  });
  it("lists the focused node first, then by distance", () => {
    const snap = projectGraph(expanded(chain(100)), { focus: "t50", hops: 2 });
    expect(ids(snap)[0]).toBe("t50");
    expect(ids(snap).slice(1, 3).sort()).toEqual(["t49", "t51"]);
  });
  it("walks edges in both directions and survives cycles", () => {
    const model = expanded({
      view: "dependencies",
      nodes: ["a", "b", "c", "d"].map((id) => taskNode(id)),
      edges: [dep("a", "b"), dep("b", "c"), dep("c", "a"), dep("d", "a")],
    });
    expect(neighbourhood(model, "a", 1)?.size).toBe(4);
    expect(neighbourhood(model, "b", 1)?.size).toBe(3);
  });
  it("keeps a huge neighbourhood inside the cap", () => {
    const star = {
      view: "dependencies",
      nodes: Array.from({ length: 400 }, (_, i) => taskNode(`s${i}`)),
      edges: Array.from({ length: 399 }, (_, i) => dep(`s${i + 1}`, "s0")),
    };
    const snap = projectGraph(expanded(star), { focus: "s0", hops: 3 });
    expect(snap.nodes).toHaveLength(NODE_CAP);
    expect(snap.scale.poolSize).toBe(400);
    expect(snap.scale.pages).toBe(8);
  });
  it("reports a focus that is not in the model and shows everything", () => {
    const snap = projectGraph(expanded(chain(10)), { focus: "nope" });
    expect(snap.scale.focusMissing).toBe(true);
    expect(snap.nodes).toHaveLength(10);
    expect(describeScale(snap)).toContain("not in the graph model");
  });
});

describe("clusters", () => {
  const model = () => expanded(chain(120, 4));
  it("collapses a group into one item and counts it", () => {
    const snap = projectGraph(model(), { group: "owner" });
    expect(snap.nodes).toHaveLength(4);
    for (const node of snap.nodes) {
      expect(node).toMatchObject({
        kind: "cluster",
        clusterCount: 30,
        clusterOpen: false,
      });
      expect(node.id).toMatch(/^cluster:owner:lane\d$/);
    }
    // Every task-to-task edge here crosses lanes, so each becomes one merged edge.
    expect(snap.edges.length).toBeLessThanOrEqual(EDGE_CAP);
    expect(snap.edges.every((e) => e.kind === "dependency")).toBe(true);
    expect(snap.edges.some((e) => /relationships$/.test(e.label))).toBe(true);
  });
  it("expands a cluster into a header and its members, capped", () => {
    const open = projectGraph(model(), {
      group: "owner",
      expanded: ["cluster:owner:lane1"],
    });
    expect(open.nodes.filter((n) => n.kind === "cluster")).toHaveLength(4);
    expect(open.nodes.filter((n) => n.kind === "task")).toHaveLength(30);
    expect(
      open.nodes.find((n) => n.id === "cluster:owner:lane1"),
    ).toMatchObject({
      clusterOpen: true,
    });
    const all = projectGraph(model(), {
      group: "owner",
      expanded: [0, 1, 2, 3].map((i) => `cluster:owner:lane${i}`),
    });
    expect(all.nodes).toHaveLength(NODE_CAP);
    expect(all.scale.pages).toBe(Math.ceil(124 / NODE_CAP));
  });
  it("keeps edges inside a collapsed cluster out of the drawing", () => {
    const flat = expanded({
      view: "dependencies",
      nodes: [
        taskNode("a", { phase: "1" }),
        taskNode("b", { phase: "1" }),
        taskNode("c", { phase: "2" }),
      ],
      edges: [dep("a", "b"), dep("b", "c")],
    });
    const snap = projectGraph(flat, { group: "phase" });
    expect(snap.scale.internalEdges).toBe(1);
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]).toMatchObject({
      from: "cluster:phase:1",
      to: "c",
    });
  });
  it("labels unknown groups plainly, counts trouble, ignores unknown modes", () => {
    const m = expanded({
      view: "dependencies",
      nodes: [
        taskNode("a", { taskStatus: "blocked" }),
        taskNode("b"),
        taskNode("c", { owner: "x" }),
      ],
      edges: [],
    });
    const snap = projectGraph(m, { group: "owner" });
    const cluster = snap.nodes.find((n) => n.kind === "cluster");
    expect(cluster).toMatchObject({
      label: "Agent: Unassigned",
      clusterTrouble: 1,
      clusterNoun: "tasks",
    });
    // A single member is shown as itself, not as a cluster of one.
    expect(snap.nodes.some((n) => n.id === "c")).toBe(true);
    expect(projectGraph(m, { group: "role" }).scale.group).toBe("none");
    expect(projectGraph(m, { group: "__proto__" }).scale.group).toBe("none");
  });
  it("groups communication nodes by role and harness", () => {
    const m = expanded({
      view: "communication",
      nodes: ["a", "b", "c"].map((id) => ({
        id,
        kind: "lane",
        label: id,
        role: id === "c" ? "Coordinator" : "Implementation",
        harness: "claude",
      })),
      edges: [["a", "b", 3, "update", null, null, 0]],
    });
    expect(projectGraph(m, { group: "role" }).nodes).toHaveLength(2);
    expect(projectGraph(m, { group: "harness" }).nodes).toHaveLength(1);
    expect(projectGraph(m, { group: "owner" }).scale.group).toBe("none");
  });
});

describe("messages and bounds", () => {
  it("states what is on screen and what is not", () => {
    const snap = projectGraph(expanded(chain(130)), {});
    const text = describeScale(snap);
    expect(text).toContain("Showing 1 to 50 of 130 nodes");
    expect(text).toContain("page 1 of 3");
    expect(text).toContain("Not drawn on this page: 80 nodes");
  });
  it("carries the model's own truncation into the counts", () => {
    const m = chain(10);
    m.truncated = { nodes: 7, edges: 11 };
    const snap = projectGraph(expanded(m), {});
    expect(snap.truncated).toEqual({ nodes: 7, edges: 11 });
  });
  it("projects a 2000 node, 5000 edge input within the cap and a budget", () => {
    // The server model stops at 1100 nodes and 3000 edges; a hostile or future
    // producer may send more, and the projection must still be bounded.
    const nodes = Array.from({ length: 2000 }, (_, i) =>
      taskNode(`n${i}`, {
        owner: `lane${i % 25}`,
        phase: String(i % 9),
        taskStatus: i % 17 === 0 ? "blocked" : "working",
      }),
    );
    const edges: unknown[] = [];
    for (let i = 0; i < 5000; i++)
      edges.push(dep(`n${(i * 7) % 2000}`, `n${(i * 13 + 1) % 2000}`));
    const started = performance.now();
    const model = expandModel({ view: "dependencies", nodes, edges });
    const built = performance.now() - started;
    const t1 = performance.now();
    const runs = [
      projectGraph(model, {}),
      projectGraph(model, { page: 7 }),
      projectGraph(model, { group: "owner" }),
      projectGraph(model, { group: "phase", expanded: ["cluster:phase:3"] }),
      projectGraph(model, { focus: "n100", hops: 3 }),
    ];
    const projected = (performance.now() - t1) / runs.length;
    for (const snap of runs) {
      expect(snap.nodes.length).toBeLessThanOrEqual(NODE_CAP);
      expect(snap.edges.length).toBeLessThanOrEqual(EDGE_CAP);
    }
    expect(model.nodes.length).toBe(1100);
    // Generous budgets for shared machines; they catch quadratic regressions.
    expect(built).toBeLessThan(1500);
    expect(projected).toBeLessThan(500);
  });
});
