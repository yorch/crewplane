import { expect, it } from "vitest";
import { ROUTE_PARAMS } from "./config.js";
import { ACTIONS, entriesFromData } from "./palette-core.js";
import { parseHash } from "./route.js";
import { buildIndex, search } from "./search-core.js";

const data = {
  tasks: [
    {
      id: "CP-101",
      title: "CP-101 Fix the login <b>form</b>",
      state: "working",
      phase: "2",
      owner: "builder",
    },
    { id: "CP-102", title: "Café", state: "blocked", phase: "2", owner: "—" },
  ],
  headless: { lanes: [{ lane: "builder", status: "running" }] },
  messages: [
    {
      id: "m1",
      from: "builder",
      to: "all",
      kind: "question",
      text: "Which db?\nsecond line",
      task: "CP-101",
      replyTo: null,
    },
    {
      id: "m2",
      from: "coordinator",
      to: "builder",
      kind: "answer",
      text: "reply",
      task: "CP-101",
      replyTo: "m1",
    },
  ],
};
const find = (query: string, extra = {}) => {
  const { entries } = buildIndex(entriesFromData({ data, ...extra }));
  return search(entries, query).results;
};

it("offers every view and only navigation or dialog actions", () => {
  const entries = entriesFromData({ data: undefined });
  expect(entries.filter((e) => e.kind === "view")).toHaveLength(
    Object.keys(ROUTE_PARAMS).length,
  );
  for (const action of ACTIONS) {
    expect(Boolean(action.href) !== Boolean(action.command)).toBe(true);
    if (action.href) {
      const route = parseHash(action.href);
      expect(route.valid).toBe(true);
      expect(Object.keys(route.params).length).toBeGreaterThan(0);
    }
  }
});
it("finds tasks, agents, threads, runs and artifacts from loaded data only", () => {
  expect(find("cp-101")[0]).toMatchObject({ kind: "task", id: "CP-101" });
  expect(find("builder").some((e) => e.kind === "agent")).toBe(true);
  expect(find("which db")[0]).toMatchObject({ kind: "thread", id: "m1" });
  // Replies are part of their thread, not separate hits.
  expect(find("reply").some((e) => e.id === "m2")).toBe(false);
  const runs = [
    {
      runId: "1700000000000-abc",
      lane: "builder",
      task: "CP-101",
      status: "failed",
      harness: "claude",
    },
  ];
  expect(find("failed", { runs })[0]).toMatchObject({ kind: "run" });
  const artifacts = [
    {
      id: `ev_${"a".repeat(32)}`,
      scenario: "Checkout",
      route: "/pay",
      task: "CP-101",
      outcome: "passed",
    },
  ];
  expect(find("checkout", { artifacts })[0]).toMatchObject({
    kind: "artifact",
  });
  expect(find("cafe")[0]).toMatchObject({ id: "CP-102" });
});
it("links through the existing router and keeps untrusted text as text", () => {
  const hit = find("login")[0];
  expect(hit?.href).toBe("#/tasks?task=CP-101");
  expect(hit?.title).toContain("<b>form</b>");
  expect(parseHash(hit?.href ?? "").params).toEqual({ task: "CP-101" });
});
it("shows views and commands before anything is typed", () => {
  const kinds = new Set(find("").map((e) => e.kind));
  expect([...kinds].sort()).toEqual(["action", "view"]);
});
it("indexes a large board within a budget", () => {
  const big = {
    ...data,
    tasks: Array.from({ length: 3000 }, (_, i) => ({
      id: `T-${i}`,
      title: `T-${i} Task ${i}`,
      state: "todo",
      phase: "1",
      owner: `lane${i % 40}`,
    })),
    messages: Array.from({ length: 3000 }, (_, i) => ({
      id: `m${i}`,
      from: "a",
      to: "b",
      kind: "update",
      text: `Update ${i}`,
      task: `T-${i}`,
      replyTo: null,
    })),
  };
  const started = performance.now();
  const { entries } = buildIndex(entriesFromData({ data: big }));
  const result = search(entries, "update 2999");
  const took = performance.now() - started;
  expect(entries.length).toBeGreaterThan(6000);
  expect(result.results[0]?.id).toBe("m2999");
  expect(took).toBeLessThan(2000);
});
