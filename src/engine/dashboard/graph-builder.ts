/** Pure bounded GRAPH-V1 projection. No authority is inferred from display data. */
export type View = "dependencies" | "communication";
export type Task = {
  id: string;
  label: string;
  status: string | null;
  accepted: boolean;
  dependsOn: { taskId: string; require: "accepted" | "ready" }[];
};
export type Lane = {
  id: string;
  role: string | null;
  harness: string | null;
  observedModel: string | null;
  taskId: string | null;
  processStatus: string | null;
  taskStatus: string | null;
  accepted: boolean;
};
export type Message = {
  id: string;
  from: string;
  to: string;
  kind: "question" | "request" | "answer" | "update" | "handoff";
  task: string | null;
  replyTo: string | null;
  at: string;
};
export type GraphInput = {
  version: 1;
  tasks: Task[];
  lanes: Lane[];
  messages: Message[];
  unansweredIds: string[];
};
export type GraphNode = Omit<Lane, "id"> & {
  id: string;
  kind: "task" | "lane";
  label: string;
};
export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "dependency" | "awaiting-answer" | "review-handoff" | "message";
  label: string;
  threadId: string | null;
  at: string | null;
  unanswered: boolean;
};
export type GraphSnapshot = {
  version: 1;
  view: View;
  nodes: GraphNode[];
  edges: GraphEdge[];
  hidden: { nodes: number; edges: number };
  truncated: { nodes: number; edges: number };
};
function fail(): never {
  throw new Error("Invalid graph input");
}
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;
const nullable = (v: unknown) => v === null || text(v);
function record(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(v)).every(
    (d) => "value" in d,
  );
}
function array(v: unknown, max: number): v is unknown[] {
  return (
    Array.isArray(v) && v.length <= max && Object.keys(v).length === v.length
  );
}
function validate(v: unknown): asserts v is GraphInput {
  if (
    !record(v) ||
    v.version !== 1 ||
    !array(v.tasks, 1000) ||
    !array(v.lanes, 64) ||
    !array(v.messages, 1000) ||
    !array(v.unansweredIds, 1000)
  )
    fail();
  const unique = (
    rows: unknown[],
    check: (r: Record<string, unknown>) => boolean,
  ) => {
    const ids = new Set();
    for (const row of rows) {
      if (!record(row) || !text(row.id) || ids.has(row.id) || !check(row))
        fail();
      ids.add(row.id);
    }
  };
  unique(
    v.tasks,
    (r) =>
      text(r.label) &&
      nullable(r.status) &&
      typeof r.accepted === "boolean" &&
      array(r.dependsOn, 1000) &&
      r.dependsOn.every(
        (d) =>
          record(d) &&
          text(d.taskId) &&
          ["accepted", "ready"].includes(d.require as string),
      ),
  );
  unique(
    v.lanes,
    (r) =>
      [
        "role",
        "harness",
        "observedModel",
        "taskId",
        "processStatus",
        "taskStatus",
      ].every((k) => nullable(r[k])) && typeof r.accepted === "boolean",
  );
  unique(
    v.messages,
    (r) =>
      text(r.from) &&
      text(r.to) &&
      ["question", "request", "answer", "update", "handoff"].includes(
        r.kind as string,
      ) &&
      nullable(r.task) &&
      nullable(r.replyTo) &&
      text(r.at),
  );
  if (!v.unansweredIds.every(text)) fail();
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const id = (...parts: string[]) => JSON.stringify(parts);
export function buildGraph(input: GraphInput, view: View): GraphSnapshot {
  try {
    validate(input);
    if (view !== "dependencies" && view !== "communication") fail();
  } catch {
    fail();
  }
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  let omitted = 0;
  let omittedEdges = 0;
  if (view === "dependencies") {
    const active = input.tasks.filter((t) => !t.accepted);
    const included = new Set(active.map((t) => t.id));
    // Follow only explicit metadata, including prerequisites of referenced prerequisites.
    const byId = new Map(input.tasks.map((t) => [t.id, t]));
    const queue = [...included];
    for (let n = 0; n < queue.length; n++)
      for (const dep of byId.get(queue[n] ?? "")?.dependsOn ?? []) {
        if (!included.has(dep.taskId)) {
          included.add(dep.taskId);
          queue.push(dep.taskId);
        }
      }
    for (const task of input.tasks) {
      if (!included.has(task.id)) {
        omitted++;
        omittedEdges += new Set(
          task.dependsOn.map((d) => id(task.id, d.taskId, d.require)),
        ).size;
        continue;
      }
      nodes.push({
        id: task.id,
        kind: "task",
        label: task.label,
        role: null,
        harness: null,
        observedModel: null,
        taskId: task.id,
        processStatus: null,
        taskStatus: task.status,
        accepted: task.accepted,
      });
      for (const dep of task.dependsOn)
        edges.push({
          id: id("dependency", task.id, dep.taskId, dep.require),
          from: task.id,
          to: dep.taskId,
          kind: "dependency",
          label: `requires ${dep.require}`,
          threadId: null,
          at: null,
          unanswered: false,
        });
    }
    edges = [...new Map(edges.map((e) => [e.id, e])).values()].sort((a, b) =>
      compare(a.id, b.id),
    );
  } else {
    nodes = input.lanes.map((l) => ({
      id: l.id,
      kind: "lane",
      label: l.id,
      role: l.role,
      harness: l.harness,
      observedModel: l.observedModel,
      taskId: l.taskId,
      processStatus: l.processStatus,
      taskStatus: l.taskStatus,
      accepted: l.accepted,
    }));
    const byId = new Map(input.messages.map((m) => [m.id, m]));
    const unanswered = new Set(input.unansweredIds);
    const root = (message: Message): string | null => {
      let current = message;
      const positions = new Map<string, number>();
      const path: string[] = [];
      while (true) {
        const cycleStart = positions.get(current.id);
        if (cycleStart !== undefined)
          return path.slice(cycleStart).sort(compare)[0] ?? null;
        positions.set(current.id, path.length);
        path.push(current.id);
        if (!current.replyTo)
          return current.kind === "question" || current.kind === "request"
            ? current.id
            : current.id === message.id
              ? null
              : current.id;
        const parent = byId.get(current.replyTo);
        if (!parent) return current.replyTo;
        current = parent;
      }
    };
    const lanes = input.lanes.map((l) => l.id).sort(compare);
    const messages = [...input.messages].sort(
      (a, b) => compare(b.at, a.at) || compare(a.id, b.id),
    );
    for (const m of messages)
      for (const to of m.to === "all"
        ? lanes.filter((l) => l !== m.from)
        : [m.to]) {
        edges.push({
          id: id("message", m.id, to),
          from: m.from,
          to,
          kind:
            m.kind === "question"
              ? "awaiting-answer"
              : m.kind === "request" &&
                  input.lanes.some(
                    (l) =>
                      l.id === to &&
                      /review|qa|visual|validator/i.test(l.role ?? ""),
                  )
                ? "review-handoff"
                : "message",
          label: m.kind,
          threadId: root(m),
          at: m.at,
          unanswered: unanswered.has(m.id),
        });
      }
  }
  nodes.sort((a, b) => compare(a.id, b.id));
  const displayedNodes = nodes.slice(0, 50);
  const truncatedIds = new Set(nodes.slice(50).map((node) => node.id));
  // Missing references remain visible; references to intentionally clipped nodes do not.
  const eligibleEdges = edges.filter(
    (edge) => !truncatedIds.has(edge.from) && !truncatedIds.has(edge.to),
  );
  return {
    version: 1,
    view,
    nodes: displayedNodes,
    edges: eligibleEdges.slice(0, 100),
    hidden: { nodes: omitted, edges: omittedEdges },
    truncated: {
      nodes: Math.max(0, nodes.length - 50),
      edges: edges.length - Math.min(100, eligibleEdges.length),
    },
  };
}
