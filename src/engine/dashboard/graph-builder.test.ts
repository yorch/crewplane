import { describe, expect, it } from "vitest";
import {
  buildGraph,
  type GraphInput,
  type Lane,
  type Message,
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
    expect(graph.hidden).toEqual({ nodes: 14, edges: 28 });
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
