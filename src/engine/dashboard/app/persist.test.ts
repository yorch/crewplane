import { expect, it } from "vitest";
import {
  readUiState,
  restoresPosition,
  sanitizeUiState,
  UI_STATE_KEY,
  writeUiState,
} from "./persist.js";
import { hrefFor, parseHash, routeScrollKey } from "./route.js";

const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};
const good = {
  v: 1,
  view: "tasks",
  scroll: { tasks: 420, "tasks:detail": 12.4, overview: 0 },
  panes: { "task-board": [30, 5], "task-detail": [0, 99] },
  open: ["info-tasks", "info-agents"],
};

it("round-trips scroll offsets, pane offsets and open disclosures", () => {
  const storage = memory();
  expect(writeUiState(storage, good)).toBe(true);
  expect(readUiState(storage)).toEqual({
    ...good,
    scroll: { tasks: 420, "tasks:detail": 12, overview: 0 },
  });
});

it("rebuilds hostile or malformed stored values from an allowlist", () => {
  expect(sanitizeUiState(null)).toBeNull();
  expect(sanitizeUiState([])).toBeNull();
  expect(sanitizeUiState({ ...good, v: 2 })).toBeNull();
  expect(sanitizeUiState({ ...good, view: "__proto__" })).toBeNull();
  expect(sanitizeUiState({ ...good, view: "nope" })).toBeNull();
  const clean = sanitizeUiState({
    v: 1,
    view: "agents",
    scroll: {
      agents: -5,
      "agents:detail": Number.POSITIVE_INFINITY,
      messages: "7",
      "evil key": 1,
      nope: 1,
      __proto__: 3,
      runs: 1e12,
    },
    panes: {
      ok: [1, 2],
      "bad key!": [1, 2],
      short: [1],
      text: ["a", "b"],
      nan: [Number.NaN, 1],
    },
    open: ["info-tasks", "info-tasks", "<img>", 5, "info-", "x".repeat(99)],
    extra: "dropped",
  });
  expect(clean).toEqual({
    v: 1,
    view: "agents",
    scroll: { agents: 0, runs: 10000000 },
    panes: { ok: [1, 2] },
    open: ["info-tasks"],
  });
  expect(Object.getPrototypeOf(clean?.scroll)).toBe(Object.prototype);
  const many = sanitizeUiState({
    v: 1,
    view: "tasks",
    panes: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`p${i}`, [i, i]]),
    ),
    open: Array.from(
      { length: 100 },
      (_, i) =>
        `info-${"a".repeat(1)}${i > 25 ? "" : String.fromCharCode(97 + i)}`,
    ),
  });
  expect(Object.keys(many?.panes ?? {})).toHaveLength(40);
  expect(many?.open.length).toBeLessThanOrEqual(20);
});

it("treats missing, blocked, unparsable and failing storage as no state", () => {
  expect(readUiState(null)).toBeNull();
  expect(readUiState(memory())).toBeNull();
  const broken = memory();
  broken.map.set(UI_STATE_KEY, "{not json");
  expect(readUiState(broken)).toBeNull();
  broken.map.set(UI_STATE_KEY, '{"v":1,"view":"nope"}');
  expect(readUiState(broken)).toBeNull();
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  expect(readUiState(throwing)).toBeNull();
  expect(writeUiState(throwing, good)).toBe(false);
  expect(writeUiState(memory(), { ...good, view: "nope" })).toBe(false);
});

it("restores only after a reload or history traversal", () => {
  expect(restoresPosition("reload")).toBe(true);
  expect(restoresPosition("back_forward")).toBe(true);
  expect(restoresPosition("navigate")).toBe(false);
  expect(restoresPosition(undefined)).toBe(false);
});

it("derives per-view scroll keys and parses routes with allowlists", () => {
  expect(routeScrollKey({ view: "tasks", params: {} })).toBe("tasks");
  expect(routeScrollKey({ view: "tasks", params: { task: "A-1" } })).toBe(
    "tasks:detail",
  );
  expect(routeScrollKey({ view: "overview", params: { task: "A-1" } })).toBe(
    "overview",
  );
  expect(parseHash("#/tasks?state=blocked&evil=1&layout=grid")).toEqual({
    view: "tasks",
    params: { state: "blocked" },
    valid: true,
  });
  expect(parseHash("#/__proto__").valid).toBe(false);
  expect(parseHash("").view).toBe("overview");
  expect(hrefFor("tasks", { state: "blocked", evil: "x" })).toBe(
    "#/tasks?state=blocked",
  );
});

it('treats a stored "__proto__" pane key as plain data, never as a prototype', () => {
  // An object literal would not create this key; JSON.parse does.
  const hostile = JSON.parse(
    '{"v":1,"view":"tasks","panes":{"__proto__":[7,8],"ok":[1,2]}}',
  );
  expect(Object.hasOwn(hostile.panes, "__proto__")).toBe(true);
  const clean = sanitizeUiState(hostile);
  const panes = clean?.panes as Record<string, unknown>;
  expect(Object.getPrototypeOf(panes)).toBeNull();
  expect(Object.hasOwn(panes, "__proto__")).toBe(true);
  expect(Object.hasOwn(panes, "ok")).toBe(true);
  // No array behaviour leaks in through the prototype chain.
  expect("length" in panes).toBe(false);
  expect("map" in panes).toBe(false);
  expect(({} as Record<string, unknown>).length).toBeUndefined();
  expect(Object.keys(panes).sort()).toEqual(["__proto__", "ok"]);
  // Survives a storage round trip as ordinary data.
  const storage = memory();
  expect(writeUiState(storage, clean)).toBe(true);
  const back = readUiState(storage);
  expect(Object.getPrototypeOf(back?.panes)).toBeNull();
  expect(Object.keys(back?.panes ?? {}).sort()).toEqual(["__proto__", "ok"]);
});
