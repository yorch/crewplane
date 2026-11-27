import { describe, expect, it } from "vitest";
import {
  buildGraph,
  buildGraphModel,
  EDGE_KINDS,
  type GraphInput,
  type Lane,
  type Message,
  MODEL_MAX_EDGES,
  MODEL_MAX_NODES,
  type Task,
} from "./graph-builder.js";

const task = (id: string, accepted = false): Task => ({
  id,
  label: id,
  accepted,
  status: null,
  dependsOn: [],
});
const lane = (id: string): Lane => ({
  id,
  role: id === "reviewer" || id === "visual" ? "review" : null,
  harness: null,
  observedModel: null,
  taskId: null,
  processStatus: null,
  taskStatus: null,
  accepted: false,
});
const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  from: "coordinator",
  to: "F",
  kind: "update",
  task: null,
  replyTo: null,
  at: "2026-11-08T00:00:00Z",
  ...extra,
});
const input = (extra: Partial<GraphInput> = {}): GraphInput => ({
  version: 1,
  tasks: [],
  lanes: [],
  messages: [],
  unansweredIds: [],
  ...extra,
});
describe("GRAPH-V1 builder", () => {
  it("uses explicit prerequisites, preserves missing refs and omits archive", () => {
    const a = task("coordinator");
    a.dependsOn = [
      { taskId: "B", require: "accepted" },
      { taskId: "missing", require: "ready" },
    ];
    const graph = buildGraph(
      input({ tasks: [task("archive", true), task("B", true), a] }),
      "dependencies",
    );
    expect(graph.nodes.map((n) => n.id)).toEqual(["B", "coordinator"]);
    expect(graph.edges.map((e) => [e.from, e.to, e.label])).toEqual([
      ["coordinator", "B", "requires accepted"],
      ["coordinator", "missing", "requires ready"],
    ]);
    expect(graph.hidden).toEqual({ nodes: 1, edges: 0 });
    expect(graph.nodes[0]).toMatchObject({
      processStatus: null,
      observedModel: null,
      taskStatus: null,
    });
    expect(
      buildGraph(input({ tasks: [task("legacy")] }), "dependencies").edges,
    ).toEqual([]);
  });
  it("bounds cycles and keeps explicit reply roots, review association and unanswered IDs", () => {
    const graph = buildGraph(
      input({
        lanes: [lane("coordinator"), lane("reviewer")],
        messages: [
          message("q", { kind: "question" }),
          message("r", { kind: "request", to: "reviewer" }),
          message("a", { kind: "answer", replyTo: "q" }),
          message("x", { replyTo: "y" }),
          message("y", { replyTo: "x" }),
          message("m", { replyTo: "absent" }),
        ],
        unansweredIds: ["q"],
      }),
      "communication",
    );
    const edge = (key: string) =>
      graph.edges.find(
        (e) =>
          e.id ===
          JSON.stringify(["message", key, key === "r" ? "reviewer" : "F"]),
      );
    expect(edge("q")).toMatchObject({
      kind: "awaiting-answer",
      threadId: "q",
      unanswered: true,
    });
    expect(edge("a")).toMatchObject({ threadId: "q", unanswered: false });
    expect(edge("r")).toMatchObject({ kind: "review-handoff", threadId: "r" });
    expect(edge("x")?.threadId).toBe("x");
    expect(edge("y")?.threadId).toBe("x");
    expect(edge("m")?.threadId).toBe("absent");
  });
  it("resolves incoming prefixes to cycle members regardless of ID order", () => {
    const source = input({
      messages: [
        message("x", { replyTo: "y" }),
        message("y", { replyTo: "x" }),
        message("a", { replyTo: "x" }),
        message("b", { replyTo: "y" }),
        message("0", { replyTo: "a" }),
        message("z", { replyTo: "b" }),
        message("self", { replyTo: "self" }),
        message("before-self", { replyTo: "self" }),
      ],
    });
    const graph = buildGraph(source, "communication");
    expect(graph.edges.map((e) => [JSON.parse(e.id)[1], e.threadId])).toEqual([
      ["0", "x"],
      ["a", "x"],
      ["b", "x"],
      ["before-self", "self"],
      ["self", "self"],
      ["x", "x"],
      ["y", "x"],
      ["z", "x"],
    ]);
    expect(
      buildGraph(
        { ...source, messages: [...source.messages].reverse() },
        "communication",
      ),
    ).toEqual(graph);
  });
  it("counts fanout truncation and selects newest deterministically", () => {
    const source = input({
      lanes: Array.from({ length: 64 }, (_, i) => lane(`L${i}`)),
      messages: [
        message("old", { to: "all", at: "2026-01-01" }),
        message("new", { to: "all", at: "2026-02-01" }),
      ],
    });
    const graph = buildGraph(source, "communication");
    expect(graph.nodes).toHaveLength(50);
    expect(graph.edges).toHaveLength(100);
    expect(graph.hidden).toEqual({ nodes: 0, edges: 0 });
    expect(graph.truncated).toEqual({ nodes: 14, edges: 28 });
    expect(graph.edges[0]?.id).toBe(JSON.stringify(["message", "new", "L0"]));
    expect(
      buildGraph(
        {
          ...source,
          lanes: [...source.lanes].reverse(),
          messages: [...source.messages].reverse(),
        },
        "communication",
      ),
    ).toEqual(graph);
  });
  it("separates archived tasks from truncation without false missing-reference edges", () => {
    const tasks = Array.from({ length: 60 }, (_, i) =>
      task(`T${String(i).padStart(2, "0")}`),
    );
    const first = tasks[0];
    if (!first) throw Error("Synthetic fixture missing");
    first.dependsOn = [
      { taskId: "T59", require: "ready" },
      { taskId: "missing", require: "ready" },
    ];
    const graph = buildGraph(
      input({ tasks: [...tasks, task("archive", true)] }),
      "dependencies",
    );
    expect(graph.hidden).toEqual({ nodes: 1, edges: 0 });
    expect(graph.truncated).toEqual({ nodes: 10, edges: 1 });
    expect(graph.edges.map((e) => e.to)).toEqual(["missing"]);
  });
  it("preserves hostile display text and never mutates input", () => {
    const source = input({
      tasks: [{ ...task("__proto__"), label: "<img src=x onerror=alert(1)>" }],
    });
    const before = JSON.stringify(source);
    Object.freeze(source.tasks[0]);
    Object.freeze(source.tasks);
    Object.freeze(source);
    expect(buildGraph(source, "dependencies").nodes[0]?.label).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(JSON.stringify(source)).toBe(before);
  });
  it("rejects unsafe shapes, unknown kinds, duplicates and oversized inputs with fixed errors", () => {
    const bad = [
      null,
      { ...input(), tasks: [task("x"), task("x")] },
      input({
        messages: [message("x", { kind: "unknown" as Message["kind"] })],
      }),
      input({ tasks: Array.from({ length: 1001 }, (_, i) => task(String(i))) }),
      input({ tasks: [{ ...task("x"), label: "x".repeat(257) }] }),
      Object.defineProperty({}, "version", {
        get: () => {
          throw new Error("secret");
        },
        enumerable: true,
      }),
    ];
    for (const value of bad)
      expect(() => buildGraph(value as GraphInput, "dependencies")).toThrow(
        "Invalid graph input",
      );
  });
});

describe("graph model for clusters, focus and paging", () => {
  it("keeps the capped display graph unchanged and adds the larger model beside it", () => {
    const tasks = Array.from({ length: 80 }, (_, i) => ({
      ...task(`T${String(i).padStart(3, "0")}`),
      phase: String(i % 4),
      owner: `lane${i % 3}`,
      dependsOn: i
        ? [
            {
              taskId: `T${String(i - 1).padStart(3, "0")}`,
              require: "accepted" as const,
            },
          ]
        : [],
    }));
    const data = input({ tasks });
    const display = buildGraph(data, "dependencies");
    const model = buildGraphModel(data, "dependencies");
    expect(display.nodes).toHaveLength(50);
    expect(display.truncated).toEqual({ nodes: 30, edges: expect.any(Number) });
    expect(model.nodes).toHaveLength(80);
    expect(model.edges).toHaveLength(79);
    expect(model.truncated).toEqual({ nodes: 0, edges: 0 });
    expect(model.nodes[3]).toMatchObject({
      id: "T003",
      phase: "3",
      owner: "lane0",
      kind: "task",
    });
    // Grouping hints are model only; the display nodes are exactly as before.
    expect(Object.keys(display.nodes[0] ?? {})).not.toContain("phase");
    // Null fields are left out to keep the model small.
    expect(Object.keys(model.nodes[0] ?? {})).not.toContain("role");
    const [from, to, kind, label] = model.edges[0] ?? [];
    expect([from, to, EDGE_KINDS[kind as number], label]).toEqual([
      "T001",
      "T000",
      "dependency",
      "requires accepted",
    ]);
  });
  it("rejects bad grouping hints with the same fixed error", () => {
    const bad = input({ tasks: [{ ...task("x"), phase: "p".repeat(300) }] });
    expect(() => buildGraphModel(bad, "dependencies")).toThrow(
      "Invalid graph input",
    );
    expect(() =>
      buildGraphModel(
        input({ tasks: [{ ...task("x"), owner: 5 as unknown as string }] }),
        "dependencies",
      ),
    ).toThrow("Invalid graph input");
  });
  it("carries communication edges as tuples with thread links and open questions", () => {
    const model = buildGraphModel(
      input({
        lanes: [lane("coordinator"), lane("F")],
        messages: [
          message("q", { kind: "question" }),
          message("a", {
            kind: "answer",
            replyTo: "q",
            from: "F",
            to: "coordinator",
          }),
        ],
        unansweredIds: ["q"],
      }),
      "communication",
    );
    expect(model.nodes.map((n) => n.id)).toEqual(["F", "coordinator"]);
    const open = model.edges.find(
      (e) => e[2] === EDGE_KINDS.indexOf("awaiting-answer"),
    );
    expect(open?.[6]).toBe(1);
    expect(open?.[4]).toBe("q");
  });
  it("bounds the model and counts what it left out", () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      ...task(`T${String(i).padStart(4, "0")}`),
      dependsOn: [0, 1, 2, 3].map((k) => ({
        taskId: `T${String((i + k + 1) % 1000).padStart(4, "0")}`,
        require: "ready" as const,
      })),
    }));
    const lanes = Array.from({ length: 64 }, (_, i) => lane(`lane${i}`));
    const model = buildGraphModel(input({ tasks, lanes }), "dependencies");
    expect(model.nodes.length).toBeLessThanOrEqual(MODEL_MAX_NODES);
    expect(model.edges.length).toBe(MODEL_MAX_EDGES);
    expect(model.truncated.edges).toBe(4000 - MODEL_MAX_EDGES);
  });
  it("builds the largest accepted input within a generous budget", () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      ...task(`T${i}`),
      phase: String(i % 5),
      owner: `lane${i % 64}`,
      dependsOn: i
        ? [{ taskId: `T${i - 1}`, require: "accepted" as const }]
        : [],
    }));
    const lanes = Array.from({ length: 64 }, (_, i) => lane(`lane${i}`));
    const messages = Array.from({ length: 1000 }, (_, i) =>
      message(`m${i}`, {
        to: i % 2 ? "all" : "lane3",
        from: `lane${i % 64}`,
        at: `2026-11-08T00:${String(i % 60).padStart(2, "0")}:00Z`,
      }),
    );
    const data = input({ tasks, lanes, messages, unansweredIds: ["m1", "m2"] });
    const started = performance.now();
    for (const view of ["dependencies", "communication"] as const) {
      const display = buildGraph(data, view);
      const model = buildGraphModel(data, view);
      expect(display.nodes.length).toBeLessThanOrEqual(50);
      expect(display.edges.length).toBeLessThanOrEqual(100);
      expect(model.nodes.length).toBeLessThanOrEqual(MODEL_MAX_NODES);
      expect(model.edges.length).toBeLessThanOrEqual(MODEL_MAX_EDGES);
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
