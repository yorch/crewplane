import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  createAlertState,
  DEFAULT_ALERT_PREFS,
  describeAlerts,
  factsFromSnapshot,
  MAX_ALERTED,
  MAX_FACT_IDS,
  observe,
  sanitizeAlertPrefs,
  shouldCount,
  shouldNotify,
  titleWithBadge,
} from "./notify-core.js";

const facts = (extra: Record<string, unknown> = {}) => ({
  questions: [],
  blocked: [],
  paused: [],
  control: [],
  supervisor: "running",
  ...extra,
});
const all = { ...DEFAULT_ALERT_PREFS };

describe("diffing snapshots", () => {
  it("never alerts on the first observation", () => {
    const state = createAlertState();
    expect(
      observe(
        state,
        facts({ questions: ["q1"], blocked: ["T-1"], control: ["4"] }),
        all,
      ),
    ).toEqual([]);
  });
  it("alerts once for each new item and not for items already present", () => {
    const state = createAlertState();
    observe(state, facts({ questions: ["q1"], blocked: ["T-1"] }), all);
    expect(
      observe(state, facts({ questions: ["q1", "q2"], blocked: ["T-1"] }), all),
    ).toEqual([{ category: "questions", id: "q2" }]);
    // The same snapshot again, and again, announces nothing.
    for (let i = 0; i < 3; i++)
      expect(
        observe(
          state,
          facts({ questions: ["q1", "q2"], blocked: ["T-1"] }),
          all,
        ),
      ).toEqual([]);
  });
  it("does not repeat an item that briefly disappears", () => {
    const state = createAlertState();
    observe(state, facts(), all);
    expect(observe(state, facts({ blocked: ["T-9"] }), all)).toHaveLength(1);
    observe(state, facts({ blocked: [] }), all);
    expect(observe(state, facts({ blocked: ["T-9"] }), all)).toEqual([]);
  });
  it("covers every category", () => {
    const state = createAlertState();
    observe(state, facts(), all);
    const events = observe(
      state,
      facts({
        questions: ["q"],
        blocked: ["T"],
        paused: ["lane:1"],
        control: ["7"],
        supervisor: "stopped",
      }),
      all,
    );
    expect(events.map((e) => e.category).sort()).toEqual(
      [...CATEGORIES].sort(),
    );
  });
  it("respects a per category switch yet still learns what is present", () => {
    const state = createAlertState();
    const off = {
      ...all,
      categories: { ...all.categories, questions: false },
    };
    observe(state, facts(), off);
    expect(observe(state, facts({ questions: ["q1"] }), off)).toEqual([]);
    // Turning it on later does not announce what was already there.
    expect(observe(state, facts({ questions: ["q1"] }), all)).toEqual([]);
    expect(
      observe(state, facts({ questions: ["q1", "q2"] }), all),
    ).toHaveLength(1);
  });
  it("treats a control log that has not been read as unknown, not empty", () => {
    const state = createAlertState();
    observe(state, facts({ control: null }), all);
    // The log arriving with old entries is the baseline, not news.
    expect(observe(state, facts({ control: ["1", "2"] }), all)).toEqual([]);
    expect(observe(state, facts({ control: ["1", "2", "3"] }), all)).toEqual([
      { category: "control", id: "3" },
    ]);
  });
  it("announces the supervisor stopping only from running", () => {
    const state = createAlertState();
    observe(state, facts({ supervisor: "running" }), all);
    expect(observe(state, facts({ supervisor: "draining" }), all)).toEqual([]);
    expect(observe(state, facts({ supervisor: "stopped" }), all)).toEqual([]);
    expect(observe(state, facts({ supervisor: "stopped" }), all)).toEqual([]);
    observe(state, facts({ supervisor: "running" }), all);
    expect(observe(state, facts({ supervisor: "stale" }), all)).toHaveLength(1);
    // Starting up in a stopped state is not an event.
    const cold = createAlertState();
    observe(cold, facts({ supervisor: "stopped" }), all);
    expect(observe(cold, facts({ supervisor: "stopped" }), all)).toEqual([]);
  });
  it("keeps its memory bounded", () => {
    const state = createAlertState();
    observe(state, facts(), all);
    for (let round = 0; round < 20; round++)
      observe(
        state,
        facts({
          blocked: Array.from({ length: 100 }, (_, i) => `T-${round}-${i}`),
        }),
        all,
      );
    expect(state.alerted.blocked?.length).toBeLessThanOrEqual(MAX_ALERTED);
    expect(state.present.blocked?.size).toBeLessThanOrEqual(MAX_FACT_IDS);
    const huge = Array.from({ length: 50_000 }, (_, i) => `x${i}`);
    observe(state, facts({ questions: huge }), all);
    expect(state.present.questions?.size).toBeLessThanOrEqual(MAX_FACT_IDS);
  });
});

describe("facts from a snapshot", () => {
  const data = {
    unanswered: [{ id: "q1", text: "SECRET BODY" }, { id: "bad id!" }],
    tasks: [
      { id: "T-1", state: "blocked", title: "SECRET TITLE" },
      { id: "T-2", state: "working" },
    ],
    headless: {
      state: "running",
      held: ["held-lane"],
      instanceHeld: false,
      lanes: [
        { lane: "a", status: "paused", startedAt: "2026-01-01T00:00:00Z" },
        { lane: "held-lane", status: "paused", startedAt: "x" },
        { lane: "b", status: "running" },
      ],
    },
  };
  it("takes ids only, skips operator holds and invalid ids", () => {
    const out = factsFromSnapshot(data, [
      { seq: 3, outcome: "refused" },
      { seq: 4, outcome: "applied" },
      { seq: 5, outcome: "stale" },
    ]);
    expect(out.questions).toEqual(["q1"]);
    expect(out.blocked).toEqual(["T-1"]);
    expect(out.paused).toEqual(["a:2026-01-01T00:00:00Z"]);
    expect(out.control).toEqual(["3", "5"]);
    expect(out.supervisor).toBe("running");
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
  it("uses null for an unread log and survives odd data", () => {
    expect(factsFromSnapshot(data, undefined).control).toBeNull();
    const odd = factsFromSnapshot({ tasks: "no", unanswered: 3 }, []);
    expect(odd.questions).toEqual([]);
    expect(odd.supervisor).toBe("unknown");
    expect(factsFromSnapshot(null, null).blocked).toEqual([]);
  });
  it("treats an instance hold as not news", () => {
    const held = {
      ...data,
      headless: { ...data.headless, instanceHeld: true },
    };
    expect(factsFromSnapshot(held, []).paused).toEqual([]);
  });
});

describe("messages", () => {
  it("contains only counts and fixed phrases", () => {
    const message = describeAlerts([
      { category: "questions", id: "SECRET-ID-1" },
      { category: "questions", id: "SECRET-ID-2" },
      { category: "blocked", id: "SECRET-TASK" },
      { category: "paused", id: "lane:2026" },
      { category: "control", id: "9" },
      { category: "supervisor", id: "supervisor:stopped" },
    ]);
    expect(message).toEqual({
      title: "Crewplane needs a look",
      body: "2 new open questions, 1 task blocked, 1 agent paused, 1 command not applied, Supervisor stopped.",
    });
    expect(JSON.stringify(message)).not.toMatch(/SECRET|lane:2026/);
    expect(describeAlerts([])).toBeNull();
    expect(describeAlerts([{ category: "bogus", id: "x" }])).toBeNull();
  });
  it("formats the tab title badge", () => {
    expect(titleWithBadge("Overview · Crewplane", 0)).toBe(
      "Overview · Crewplane",
    );
    expect(titleWithBadge("Crewplane", 2)).toBe("(2) Crewplane");
    expect(titleWithBadge("Crewplane", 250)).toBe("(99+) Crewplane");
    for (const bad of [-1, Number.NaN, 1.5, "3", null])
      expect(titleWithBadge("Crewplane", bad as number)).toBe("Crewplane");
  });
});

describe("when to show", () => {
  const prefs = { ...all, badge: true, desktop: true };
  const hidden = { visible: false, focused: false };
  const looking = { visible: true, focused: true };
  it("is off by default", () => {
    expect(DEFAULT_ALERT_PREFS.badge).toBe(false);
    expect(DEFAULT_ALERT_PREFS.desktop).toBe(false);
    expect(shouldCount(DEFAULT_ALERT_PREFS, hidden)).toBe(false);
    expect(
      shouldNotify(DEFAULT_ALERT_PREFS, { permission: "granted", ...hidden }),
    ).toBe(false);
  });
  it("needs permission and stays quiet while the tab is in use", () => {
    expect(shouldNotify(prefs, { permission: "default", ...hidden })).toBe(
      false,
    );
    expect(shouldNotify(prefs, { permission: "denied", ...hidden })).toBe(
      false,
    );
    expect(shouldNotify(prefs, { permission: "granted", ...hidden })).toBe(
      true,
    );
    expect(shouldNotify(prefs, { permission: "granted", ...looking })).toBe(
      false,
    );
    expect(
      shouldNotify(
        { ...prefs, whenVisible: true },
        { permission: "granted", ...looking },
      ),
    ).toBe(true);
    expect(shouldCount(prefs, looking)).toBe(false);
    expect(shouldCount(prefs, hidden)).toBe(true);
    expect(shouldCount({ ...prefs, whenVisible: true }, looking)).toBe(true);
    // Visible but not focused counts as away.
    expect(shouldCount(prefs, { visible: true, focused: false })).toBe(true);
  });
  it("rebuilds stored preferences from an allowlist", () => {
    expect(sanitizeAlertPrefs(null)).toEqual(DEFAULT_ALERT_PREFS);
    expect(sanitizeAlertPrefs("x")).toEqual(DEFAULT_ALERT_PREFS);
    const clean = sanitizeAlertPrefs({
      badge: true,
      desktop: "yes",
      evil: 1,
      categories: { questions: false, __proto__: { x: 1 }, bogus: false },
    });
    expect(clean.badge).toBe(true);
    expect(clean.desktop).toBe(false);
    expect(clean.categories.questions).toBe(false);
    expect(Object.keys(clean.categories).sort()).toEqual(
      [...CATEGORIES].sort(),
    );
    expect(Object.keys(clean)).not.toContain("evil");
  });
});
