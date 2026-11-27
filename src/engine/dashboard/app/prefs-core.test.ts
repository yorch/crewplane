import { expect, it } from "vitest";
import {
  ALERTS_KEY,
  readAlerts,
  readShortcuts,
  readTheme,
  resetViewState,
  SHORTCUTS_KEY,
  THEME_KEY,
  writeAlerts,
  writeShortcuts,
  writeTheme,
} from "./prefs-core.js";

const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};
const blocked = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

it("defaults without storage and survives blocked storage", () => {
  for (const storage of [null, undefined, blocked]) {
    expect(readTheme(storage)).toBe("system");
    expect(readShortcuts(storage)).toBe(true);
    expect(readAlerts(storage).badge).toBe(false);
    expect(writeTheme(storage, "dark")).toBe(false);
    expect(writeShortcuts(storage, false)).toBe(false);
    expect(writeAlerts(storage, { badge: true })).toBe(false);
  }
  expect(resetViewState(blocked, blocked)).toBe(false);
});
it("round-trips the theme and treats system as no choice", () => {
  const storage = memory();
  expect(writeTheme(storage, "dark")).toBe(true);
  expect(storage.map.get(THEME_KEY)).toBe("dark");
  expect(readTheme(storage)).toBe("dark");
  writeTheme(storage, "system");
  expect(storage.map.has(THEME_KEY)).toBe(false);
  expect(writeTheme(storage, "purple")).toBe(false);
  expect(readTheme(memory({ [THEME_KEY]: "<script>" }))).toBe("system");
});
it("stores the shortcut switch as absence when on", () => {
  const storage = memory();
  writeShortcuts(storage, false);
  expect(storage.map.get(SHORTCUTS_KEY)).toBe("off");
  expect(readShortcuts(storage)).toBe(false);
  writeShortcuts(storage, true);
  expect(readShortcuts(storage)).toBe(true);
  expect(readShortcuts(memory({ [SHORTCUTS_KEY]: "garbage" }))).toBe(true);
});
it("validates stored alert preferences", () => {
  const storage = memory();
  writeAlerts(storage, { badge: true, categories: { control: false } });
  const read = readAlerts(storage);
  expect(read.badge).toBe(true);
  expect(read.categories.control).toBe(false);
  expect(read.categories.questions).toBe(true);
  expect(readAlerts(memory({ [ALERTS_KEY]: "{not json" })).badge).toBe(false);
  expect(readAlerts(memory({ [ALERTS_KEY]: "[1,2]" })).desktop).toBe(false);
});
it("resets only the view memory", () => {
  const local = memory({
    "crewplane.tasks.layout": "list",
    [THEME_KEY]: "dark",
    [ALERTS_KEY]: "{}",
  });
  const session = memory({
    "crewplane-ui-state": "{}",
    "crewplane-session": "keep",
  });
  expect(resetViewState(local, session)).toBe(true);
  expect(local.map.has("crewplane.tasks.layout")).toBe(false);
  expect(local.map.get(THEME_KEY)).toBe("dark");
  expect(session.map.has("crewplane-ui-state")).toBe(false);
  expect(session.map.get("crewplane-session")).toBe("keep");
});
