import { describe, expect, it } from "vitest";
import {
  buildIndex,
  displayText,
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
  it("folds accents of Latin, Greek and Cyrillic, including stacked and extended marks", () => {
    expect(fold("café")).toBe(fold("cafe"));
    expect(fold("Ελληνικά")).toBe("ελληνικα");
    expect(fold("Йога Ёлка")).toBe("иога елка");
    expect(fold("a\u1ab0b\u1dc0c\u20d0d\ufe20e")).toBe("abcde");
    expect(fold("e\u0301\u0302\u0303")).toBe("e");
  });
  it("keeps the marks that are part of a letter in other scripts", () => {
    // Devanagari vowel signs and the virama: "kitab" is not "katab".
    expect(fold("किताब")).not.toBe(fold("कतब"));
    expect(fold("किताब")).toBe("किताब");
    expect(fold("क्ष")).not.toBe(fold("कष"));
    expect(fold("ड़")).toBe("ड\u093c");
    // Bengali, Tamil and Kannada vowel signs.
    expect(fold("বাংলা")).not.toBe(fold("বলা"));
    expect(fold("தமிழ்")).not.toBe(fold("தமிழ"));
    expect(fold("ಕನ್ನಡ")).toBe("ಕನ್ನಡ");
    // Thai vowel and tone marks distinguish words.
    expect(fold("ไก่")).not.toBe(fold("ไก"));
    expect(fold("สวัสดี")).toBe("สวัสดี");
    // Arabic harakat are kept (documented): vocalized text is a different
    // string from unvocalized text.
    expect(fold("كَتَبَ")).not.toBe(fold("كتب"));
    // Hangul and CJK are unaffected.
    expect(fold("한국어").normalize("NFC")).toBe("한국어".normalize("NFC"));
    expect(fold("検索")).toBe("検索");
  });
  it("still drops joiners and non-joiners from the folded form, and searches through them", () => {
    expect(fold("می\u200cخواهم")).toBe("میخواهم");
    expect(fold("क्\u200dष")).toBe("क्ष");
    expect(fold("\u{1f468}\u200d\u{1f469}")).toBe("\u{1f468}\u{1f469}");
    const items = [entry("किताब पढ़ता"), entry("कतब")];
    expect(ranked(items, "किताब")).toEqual(["किताब पढ़ता"]);
    expect(ranked(items, "कतब")[0]).toBe("कतब");
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
      "\u202eevil",
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
    const queries = ["t-2999", "cafe 17", "deploy pipe", "zzzz", "q"];
    // Best of several runs: the first is cold (JIT) and contention only ever
    // slows a run, so the minimum is the stable figure.
    let built = Number.POSITIVE_INFINITY;
    let searched = Number.POSITIVE_INFINITY;
    let index = buildIndex(raw);
    for (let attempt = 0; attempt < 7; attempt++) {
      const started = performance.now();
      index = buildIndex(raw);
      built = Math.min(built, performance.now() - started);
      const searchStart = performance.now();
      for (const query of queries) search(index.entries, query);
      searched = Math.min(searched, (performance.now() - searchStart) / 5);
    }
    expect(index.entries).toHaveLength(6000);
    // Measured warm: about 10 ms to build 6,000 entries and 1.8 ms per query;
    // the budgets are about 10x that for shared CI machines. The operation
    // count test below is the exact check; these only catch gross slowdowns.
    expect(built).toBeLessThan(130);
    expect(searched).toBeLessThan(20);
  });
});

describe("format characters and spoofing", () => {
  const entry = (title: string, extra = {}) =>
    makeEntry({ kind: "task", id: title, title, href: "#/x", ...extra });
  it("fold removes every Unicode format character", () => {
    expect(
      fold("a\u200bb\u200cc\u200dd\u2060e\ufeff\u00adf\u202eg\u2066h\u2069"),
    ).toBe("abcdefgh");
    // Marks and case still fold as before.
    expect(fold("Édition")).toBe("edition");
  });
  it("a title with a right-to-left override matches what is displayed, not the logical order", () => {
    // Logically "\u202egnidaer": drawn as "reading" while the override applies.
    const spoof = entry("\u202egnidaer the plan");
    // What the palette shows has the override removed, so it reads as stored.
    expect(spoof.title).toBe("gnidaer the plan");
    const { results } = search([spoof], "gnidaer");
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("gnidaer the plan");
    // The word the override would have drawn is NOT a match.
    expect(search([spoof], "reading").results).toHaveLength(0);
  });
  it("zero-width characters cannot hide or fake a match", () => {
    const hidden = entry("pa\u200bss\u2060word reset");
    expect(search([hidden], "password").results).toHaveLength(1);
    expect(hidden.title).toBe("password reset");
    expect(search([entry("password")], "pa\u200bss").results).toHaveLength(1);
    // Subtitles and keys get the same treatment.
    const sub = entry("t", { subtitle: "a\u202db", keys: ["k\u200bey"] });
    expect(sub.subtitle).toBe("ab");
    expect(search([sub], "key").results).toHaveLength(1);
  });
  it("keeps joiners that shape real text", () => {
    const family = "\u{1f468}\u200d\u{1f469}";
    expect(displayText(family)).toBe(family);
    expect(displayText("می\u200cخواهم")).toContain("\u200c");
  });
});

describe("work grows linearly, counted rather than timed", () => {
  /** Reads of an entry's fields during one search, over `n` entries. */
  const reads = (n: number, query: string) => {
    let count = 0;
    const entries = Array.from({ length: n }, (_, i) => {
      const base = makeEntry({
        kind: "task",
        id: `T-${i}`,
        title: `T-${i} Implement feature ${i}`,
        keys: [`T-${i}`, "builder", "working"],
        href: "#/x",
      });
      return new Proxy(base, {
        get(target, key, receiver) {
          count++;
          return Reflect.get(target, key, receiver);
        },
      });
    });
    count = 0;
    search(entries, query);
    return count;
  };
  it("doubling the entries at most doubles the field reads for a search", () => {
    for (const query of ["feature 17", "t-9", "zzzz", ""]) {
      const small = reads(500, query);
      const large = reads(1000, query);
      expect(small, query).toBeGreaterThan(0);
      // Linear is 2.0 and sorting the matches adds a little; a per-entry
      // scan of every other entry would be 4.
      expect(large / small, query).toBeLessThanOrEqual(2.4);
    }
  });
  it("indexing counts each raw entry once", () => {
    const touched = (n: number) => {
      let count = 0;
      const raw = Array.from(
        { length: n },
        (_, i) =>
          new Proxy(
            {
              kind: "thread",
              id: `m${i}`,
              title: `Q ${i}`,
              keys: [],
              href: "#",
            },
            {
              get(target, key, receiver) {
                count++;
                return Reflect.get(target, key, receiver);
              },
            },
          ),
      );
      buildIndex(raw);
      return count;
    };
    expect(touched(2000) / touched(1000)).toBeLessThanOrEqual(2.05);
  });
});
