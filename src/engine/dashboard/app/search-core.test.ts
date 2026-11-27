import { describe, expect, it } from "vitest";
import {
  buildIndex,
  fold,
  INDEX_LIMITS,
  MAX_RESULTS,
  makeEntry,
  parseQuery,
  scoreField,
  search,
} from "./search-core.js";

const entry = (title: string, extra: Record<string, unknown> = {}) =>
  makeEntry({ kind: "task", id: title, title, href: "#/x", ...extra });
const ranked = (entries: ReturnType<typeof entry>[], query: string) =>
  search(entries, query).results.map((e) => e.title);

describe("folding", () => {
  it("folds case, diacritics and whitespace", () => {
    expect(fold("  ÉDITION\tdu   Café ")).toBe("edition du cafe");
    expect(fold("Straße")).toBe("straße");
    expect(fold("ｆｕｌｌｗｉｄｔｈ")).toBe("fullwidth");
  });
  it("bounds hostile input", () => {
    expect(fold("a".repeat(1_000_000)).length).toBeLessThanOrEqual(160);
    expect(parseQuery("x ".repeat(500)).length).toBeLessThanOrEqual(1);
    expect(parseQuery("a b c d e f g h i j").length).toBe(6);
    expect(parseQuery("   ")).toEqual([]);
    expect(parseQuery("\u0000a\u0007b")).toEqual(["a", "b"]);
  });
});

describe("ranking", () => {
  it("orders exact > prefix > word prefix > substring > subsequence", () => {
    expect(scoreField("cat", "cat")).toBeGreaterThan(scoreField("cat", "cats"));
    expect(scoreField("cat", "cats")).toBeGreaterThan(
      scoreField("cat", "big cat"),
    );
    expect(scoreField("cat", "big cat")).toBeGreaterThan(
      scoreField("cat", "bobcat"),
    );
    expect(scoreField("cat", "bobcat")).toBeGreaterThan(
      scoreField("cat", "c a t x"),
    );
    expect(scoreField("cat", "c a t x")).toBeGreaterThan(0);
    expect(scoreField("cat", "dog")).toBe(0);
    expect(scoreField("", "dog")).toBe(0);
  });
  it("puts prefix before substring before subsequence in results", () => {
    const entries = [
      entry("xx login xx"),
      entry("l-o-g-i-n subsystem"),
      entry("login page"),
      entry("Épilogin"),
    ];
    expect(ranked(entries, "login")).toEqual([
      "login page",
      "xx login xx",
      "Épilogin",
      "l-o-g-i-n subsystem",
    ]);
  });
  it("matches across diacritics and case", () => {
    const entries = [entry("Café Réseau"), entry("unrelated")];
    expect(ranked(entries, "CAFE reseau")).toEqual(["Café Réseau"]);
    expect(ranked(entries, "réseau")).toEqual(["Café Réseau"]);
  });
  it("requires every term and ranks on keys below the title", () => {
    const a = entry("Alpha", { keys: ["CP-1"] });
    const b = entry("CP-1 notes");
    expect(ranked([a, b], "cp-1")).toEqual(["CP-1 notes", "Alpha"]);
    expect(ranked([a, b], "alpha cp-1")).toEqual(["Alpha"]);
    expect(ranked([a, b], "alpha zzz")).toEqual([]);
  });
  it("is stable: equal scores keep the supplied order and kind order", () => {
    const entries = ["a1", "a2", "a3", "a4"].map((t) => entry(`item ${t}`));
    expect(ranked(entries, "item")).toEqual(entries.map((e) => e.title));
    expect(ranked([...entries].reverse(), "item")).toEqual(
      [...entries].reverse().map((e) => e.title),
    );
    const mixed = [
      makeEntry({ kind: "run", id: "r", title: "same", href: "#/r" }),
      makeEntry({ kind: "task", id: "t", title: "same", href: "#/t" }),
      makeEntry({ kind: "action", id: "a", title: "same", href: "#/a" }),
    ];
    expect(search(mixed, "same").results.map((e) => e.kind)).toEqual([
      "action",
      "task",
      "run",
    ]);
  });
  it("shows views and commands for an empty query", () => {
    const entries = [
      entry("a task"),
      makeEntry({ kind: "view", id: "v", title: "Tasks", href: "#/tasks" }),
      makeEntry({ kind: "action", id: "c", title: "Do", href: "#/x" }),
    ];
    expect(search(entries, "").results.map((e) => e.kind)).toEqual([
      "action",
      "view",
    ]);
  });
  it("never returns more than the limit", () => {
    const many = Array.from({ length: 500 }, (_, i) => entry(`task ${i}`));
    expect(search(many, "task").results).toHaveLength(MAX_RESULTS);
    expect(search(many, "task").total).toBe(500);
    expect(search(many, "task", 5).results).toHaveLength(5);
    expect(search(many, "task", 10_000).results).toHaveLength(MAX_RESULTS);
  });
  it("treats hostile strings as plain text", () => {
    const hostile = [
      "<img src=x onerror=alert(1)>",
      "__proto__",
      "constructor",
      "(?:a+)+$",
      "\\",
      "‮evil",
      "'; DROP TABLE tasks;--",
      "🙂".repeat(100),
    ];
    const entries = hostile.map((t) => entry(t));
    for (const text of hostile) {
      const out = search(entries, text);
      expect(out.results.length).toBeGreaterThan(0);
      expect(out.results.length).toBeLessThanOrEqual(MAX_RESULTS);
    }
    expect(ranked(entries, "(?:a+)+$")).toEqual(["(?:a+)+$"]);
    expect(ranked(entries, ".*")).toEqual([]);
    expect(ranked(entries, "__proto__")).toEqual(["__proto__"]);
  });
});

describe("index bounds", () => {
  it("applies per kind limits and reports the omission", () => {
    const raw = Array.from({ length: INDEX_LIMITS.run + 25 }, (_, i) => ({
      kind: "run",
      id: `r${i}`,
      title: `run ${i}`,
      href: "#/runs",
    }));
    const index = buildIndex(raw);
    expect(index.entries).toHaveLength(INDEX_LIMITS.run);
    expect(index.omitted).toBe(25);
  });
  it("builds and searches a large board within a generous budget", () => {
    const raw: Record<string, unknown>[] = [];
    for (let i = 0; i < 3000; i++)
      raw.push({
        kind: "task",
        id: `T-${i}`,
        title: `T-${i} · Implement the feature number ${i} for the café`,
        subtitle: "In progress · Phase 3 · builder",
        keys: [`T-${i}`, "builder", "3", "working"],
        href: `#/tasks?task=T-${i}`,
      });
    for (let i = 0; i < 3000; i++)
      raw.push({
        kind: "thread",
        id: `m${i}`,
        title: `Question ${i} about the deployment pipeline`,
        keys: ["T-1", "coordinator", "builder", "question"],
        href: `#/messages?thread=m${i}`,
      });
    const started = performance.now();
    const index = buildIndex(raw);
    const built = performance.now() - started;
    const searchStart = performance.now();
    for (const query of ["t-2999", "cafe 17", "deploy pipe", "zzzz", "q"])
      search(index.entries, query);
    const searched = (performance.now() - searchStart) / 5;
    expect(index.entries).toHaveLength(6000);
    // Budgets are deliberately loose (shared CI machines); a regression to a
    // quadratic or unbounded algorithm still fails by orders of magnitude.
    expect(built).toBeLessThan(1500);
    expect(searched).toBeLessThan(300);
  });
});
