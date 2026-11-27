import { describe, expect, it } from "vitest";
import {
  ALERT_TARGETS,
  alertTarget,
  CATEGORIES,
  createAlertState,
  DEFAULT_ALERT_PREFS,
  describeAlerts,
  factsFromSnapshot,
  MAX_ALERTED,
  MAX_FACT_IDS,
  observe,
  SUPERVISOR_CONFIRM_MS,
  SUPERVISOR_COOLDOWN_MS,
  sanitizeAlertPrefs,
  shouldCount,
  shouldNotify,
  supervisorPending,
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
    observe(state, facts({ stopSeq: 0 }), all, 0);
    const down = facts({
      questions: ["q"],
      blocked: ["T"],
      paused: ["lane:1"],
      control: ["7"],
      supervisor: "stopped",
      stopSeq: 0,
    });
    const first = observe(state, down, all, 1000);
    expect(first.map((e) => e.category)).not.toContain("supervisor");
    const events = [
      ...first,
      ...observe(state, down, all, 1000 + SUPERVISOR_CONFIRM_MS),
    ];
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
  it("never announces a supervisor that was not seen running", () => {
    const cold = createAlertState();
    observe(cold, facts({ supervisor: "stopped", stopSeq: 0 }), all, 0);
    expect(
      observe(cold, facts({ supervisor: "stopped", stopSeq: 0 }), all, 10_000),
    ).toEqual([]);
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

describe("supervisor alerts: crash, clean stop and flapping", () => {
  const sup = (supervisor: string, stopSeq: number | null = 0) =>
    facts({ supervisor, stopSeq });
  const T = SUPERVISOR_CONFIRM_MS;
  it("a crash (stopped, no stop command) alerts once, on the second observation", () => {
    const state = createAlertState();
    observe(state, sup("running"), all, 0);
    expect(observe(state, sup("stopped"), all, 1000)).toEqual([]);
    expect(supervisorPending(state)).toBe(true);
    // The second look too soon (the log update right behind the snapshot).
    expect(observe(state, sup("stopped"), all, 1500)).toEqual([]);
    expect(observe(state, sup("stopped"), all, 1000 + T)).toEqual([
      { category: "supervisor", id: "supervisor:stopped" },
    ]);
    for (let i = 1; i < 5; i++)
      expect(observe(state, sup("stopped"), all, 1000 + T + i * 5000)).toEqual(
        [],
      );
  });
  it("a clean stop with a stop command in the log never alerts", () => {
    const state = createAlertState();
    observe(state, sup("running", 3), all, 0);
    // The stop command (seq 4) is in the log when the snapshot shows stopped.
    for (const at of [1000, 6000, 12000])
      expect(observe(state, sup("stopped", 4), all, at)).toEqual([]);
  });
  it("a stop command that reaches the log a moment after the snapshot still suppresses it", () => {
    const state = createAlertState();
    observe(state, sup("running", 3), all, 0);
    expect(observe(state, sup("stopped", 3), all, 1000)).toEqual([]);
    for (const at of [6000, 12000])
      expect(observe(state, sup("stopped", 4), all, at)).toEqual([]);
  });
  it("a requested stop through draining never alerts", () => {
    const state = createAlertState();
    observe(state, sup("running"), all, 0);
    observe(state, sup("draining"), all, 1000);
    for (const at of [2000, 9000, 20000])
      expect(observe(state, sup("stopped"), all, at)).toEqual([]);
  });
  it("a refused or older stop does not excuse a crash", () => {
    const state = createAlertState();
    // The log entry (seq 2) predates the running snapshot.
    observe(state, sup("running", 2), all, 0);
    observe(state, sup("stopped", 2), all, 1000);
    expect(observe(state, sup("stopped", 2), all, 1000 + T)).toHaveLength(1);
  });
  describe("a signal stop (SIGTERM, Ctrl-C) leaves only desired.json", () => {
    const withMarker = (
      supervisor: string,
      marker: number | null,
      checkedAt: number | null,
    ) => facts({ supervisor, stopSeq: 0, stopMarkerAt: marker, checkedAt });
    it("running to stopped with a newer marker and no log entry never alerts", () => {
      const state = createAlertState();
      observe(state, withMarker("running", null, 900), all, 1000);
      for (const at of [2000, 6000, 12000])
        expect(
          observe(state, withMarker("stopped", 1500, 900), all, at),
        ).toEqual([]);
      expect(supervisorPending(state)).toBe(false);
    });
    it("a genuine crash (no marker) still alerts", () => {
      const state = createAlertState();
      observe(state, withMarker("running", null, 900), all, 1000);
      observe(state, withMarker("stopped", null, 900), all, 2000);
      expect(
        observe(state, withMarker("stale", null, 900), all, 2000 + T),
      ).toHaveLength(1);
    });
    it("a marker older than the last running snapshot does not explain a later stop", () => {
      const state = createAlertState();
      // Stopped earlier, restarted, observed running at 5000: the old marker
      // (at 1500) is history.
      observe(state, withMarker("running", 1500, 5000), all, 5100);
      observe(state, withMarker("stopped", 1500, 5000), all, 6000);
      expect(
        observe(state, withMarker("stopped", 1500, 5000), all, 6000 + T),
      ).toHaveLength(1);
    });
    it("ignores a marker that is not a finite number", () => {
      const state = createAlertState();
      observe(state, withMarker("running", null, 900), all, 1000);
      for (const bad of [Number.NaN, "x" as unknown as number, Infinity]) {
        observe(state, withMarker("stopped", bad, 900), all, 2000);
      }
      expect(
        observe(state, withMarker("stopped", Number.NaN, 900), all, 2000 + T),
      ).toHaveLength(1);
    });
  });
  it("reads the intentional-stop marker and heartbeat from the snapshot", () => {
    const at = "2026-11-08T01:00:00.000Z";
    const data = {
      headless: {
        state: "stopped",
        checkedAt: "2026-11-08T00:59:55.000Z",
        intentionalStop: { at },
      },
    };
    const out = factsFromSnapshot(data, []);
    expect(out.stopMarkerAt).toBe(Date.parse(at));
    expect(out.checkedAt).toBe(Date.parse("2026-11-08T00:59:55.000Z"));
    const none = factsFromSnapshot({ headless: { state: "running" } }, []);
    expect(none.stopMarkerAt).toBeNull();
    expect(none.checkedAt).toBeNull();
    expect(
      factsFromSnapshot(
        { headless: { intentionalStop: { at: { evil: 1 } } } },
        [],
      ).stopMarkerAt,
    ).toBeNull();
  });
  it("does not announce a stop while the control log is unread", () => {
    const state = createAlertState();
    observe(state, sup("running", null), all, 0);
    for (const at of [1000, 9000, 20000])
      expect(observe(state, sup("stopped", null), all, at)).toEqual([]);
  });
  it("stale needs two observations apart and no log", () => {
    const state = createAlertState();
    observe(state, sup("running", null), all, 0);
    expect(observe(state, sup("stale", null), all, 1000)).toEqual([]);
    expect(observe(state, sup("stale", null), all, 1000 + T)).toHaveLength(1);
  });
  it("a flapping supervisor does not alert on every flip", () => {
    const state = createAlertState();
    let at = 0;
    let alerts = 0;
    observe(state, sup("running"), all, at);
    // running, stale, running ... one stale observation at a time.
    for (let i = 0; i < 20; i++) {
      at += 5000;
      alerts += observe(state, sup("stale"), all, at).length;
      at += 5000;
      alerts += observe(state, sup("running"), all, at).length;
    }
    expect(alerts).toBe(0);
  });
  it("a long flap with two stale looks each time alerts at most once per cooldown", () => {
    const state = createAlertState();
    let at = 0;
    const times: number[] = [];
    observe(state, sup("running"), all, at);
    for (let i = 0; i < 40; i++) {
      for (const _ of [0, 1]) {
        at += T;
        if (observe(state, sup("stale"), all, at).length) times.push(at);
      }
      at += 5000;
      observe(state, sup("running"), all, at);
    }
    expect(times.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < times.length; i++)
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        SUPERVISOR_COOLDOWN_MS,
      );
    // 40 flips over about 7 minutes: one alert.
    expect(times).toHaveLength(1);
  });
  it("respects the category switch and stays armed state clean", () => {
    const state = createAlertState();
    const off = {
      ...all,
      categories: { ...all.categories, supervisor: false },
    };
    observe(state, sup("running"), off, 0);
    observe(state, sup("stale"), off, 1000);
    expect(observe(state, sup("stale"), off, 1000 + T)).toEqual([]);
  });
  it("reads the newest applied stop from the control log", () => {
    const data = { headless: { state: "running" } };
    const entries = [
      { seq: 2, action: "stop", outcome: "applied" },
      { seq: 7, action: "stop", outcome: "refused" },
      { seq: 5, action: "pause", outcome: "applied" },
    ];
    expect(factsFromSnapshot(data, entries).stopSeq).toBe(2);
    expect(factsFromSnapshot(data, []).stopSeq).toBe(0);
    expect(factsFromSnapshot(data, undefined).stopSeq).toBeNull();
  });
});

describe("alert click targets", () => {
  it("are fixed, valid hashes for every category", async () => {
    const { parseHash, hrefFor } = await import("./route.js");
    for (const name of CATEGORIES) {
      const target = ALERT_TARGETS[name as keyof typeof ALERT_TARGETS];
      const parsed = parseHash(hrefFor(target.view, target.params));
      expect(parsed.valid).toBe(true);
      expect(parsed.view).toBe(target.view);
      expect(parsed.params).toEqual(target.params);
    }
  });
  it("picks the first category present and ignores event ids", () => {
    expect(
      alertTarget([
        { category: "control", id: "#/evil" },
        { category: "blocked", id: "x" },
      ]),
    ).toBe(ALERT_TARGETS.blocked);
    expect(alertTarget([])).toBe(ALERT_TARGETS.supervisor);
  });
});
