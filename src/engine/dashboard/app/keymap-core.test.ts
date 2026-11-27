import { describe, expect, it } from "vitest";
import { ROUTE_PARAMS } from "./config.js";
import {
  BINDINGS,
  CHORD_PREFIX,
  CHORD_TIMEOUT_MS,
  createKeymap,
  isTypingTarget,
  NAV_CHORDS,
} from "./keymap-core.js";

type Ev = Record<string, unknown>;
type Binding = {
  id: string;
  keys: string[];
  mod?: boolean;
  chord?: boolean;
};
const bindings: Binding[] = BINDINGS;
const open = { typing: false, dialogOpen: false, singleKeys: true };
const press = (
  map: ReturnType<typeof createKeymap>,
  key: string,
  extra: Ev = {},
  situation: Record<string, unknown> = open,
  at = 0,
) => map.handle({ key, ...extra }, situation, at);

describe("binding table", () => {
  it("has no duplicate key sequences or actions per sequence", () => {
    const sequences = bindings.map((b) => b.keys.join(" ").toLowerCase());
    expect(new Set(sequences).size).toBe(sequences.length);
    const ids = bindings.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("binds a bare key only as one of the documented sets", () => {
    for (const b of bindings) {
      if (b.mod) expect(b.keys).toEqual(["Ctrl", "K"]);
      else if (b.chord) {
        expect(b.keys).toHaveLength(2);
        expect(b.keys[0]).toBe(CHORD_PREFIX);
        expect(b.keys[1]).toMatch(/^[a-z]$/);
      } else expect(["/", "?"]).toContain(b.keys[0]);
    }
  });
  it("never uses a key that browsers or screen readers reserve", () => {
    // Letters here are second keys of a chord that only starts after "g".
    const reserved = ["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown"];
    for (const b of bindings)
      for (const key of b.keys) expect(reserved).not.toContain(key);
    // No chord letter equals the prefix, so "g g" cannot be ambiguous.
    expect(Object.keys(NAV_CHORDS)).not.toContain(CHORD_PREFIX);
    // Only one binding uses a modifier.
    expect(bindings.filter((b) => b.mod)).toHaveLength(1);
  });
  it("reaches every dashboard view with exactly one chord", () => {
    const views = Object.values(NAV_CHORDS).map(([view]) => view);
    expect([...views].sort()).toEqual(Object.keys(ROUTE_PARAMS).sort());
    expect(new Set(views).size).toBe(views.length);
  });
});

describe("resolver", () => {
  it("opens the palette with / and help with ? when idle", () => {
    const map = createKeymap();
    expect(press(map, "/")?.action).toBe("palette");
    expect(press(map, "?", { shiftKey: true })?.action).toBe("help");
    expect(press(map, "x")).toBeNull();
  });
  it("completes g then a letter and rejects everything else", () => {
    const map = createKeymap();
    expect(press(map, "g", {}, open, 0)?.action).toBe("chord-start");
    expect(map.pending).toBe(true);
    expect(press(map, "t", {}, open, 100)?.action).toBe("go:tasks");
    expect(map.pending).toBe(false);
    press(map, "g", {}, open, 0);
    expect(press(map, "q", {}, open, 10)).toBeNull();
    // A cancelled chord does not leave the next key half bound.
    expect(press(map, "t", {}, open, 20)).toBeNull();
  });
  it("times a chord out after 1.5 seconds", () => {
    const map = createKeymap();
    press(map, "g", {}, open, 0);
    expect(press(map, "t", {}, open, CHORD_TIMEOUT_MS + 1)).toBeNull();
    press(map, "g", {}, open, 0);
    expect(press(map, "t", {}, open, CHORD_TIMEOUT_MS)?.action).toBe(
      "go:tasks",
    );
  });
  it("ignores bare keys while typing, in dialogs and when switched off", () => {
    for (const situation of [
      { ...open, typing: true },
      { ...open, dialogOpen: true },
      { ...open, singleKeys: false },
    ]) {
      const map = createKeymap();
      expect(press(map, "/", {}, situation)).toBeNull();
      expect(press(map, "?", {}, situation)).toBeNull();
      expect(press(map, "g", {}, situation)).toBeNull();
      expect(map.pending).toBe(false);
    }
  });
  it("drops a pending chord when the situation stops allowing it", () => {
    const map = createKeymap();
    press(map, "g", {}, open, 0);
    expect(press(map, "t", {}, { ...open, typing: true }, 5)).toBeNull();
    expect(press(map, "t", {}, open, 10)).toBeNull();
  });
  it("ignores modified keys except Ctrl or Cmd+K", () => {
    const map = createKeymap();
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
    ]) {
      expect(press(map, "/", extra)).toBeNull();
      expect(press(map, "g", extra)).toBeNull();
      expect(press(map, "?", extra)).toBeNull();
    }
    expect(press(map, "k", { ctrlKey: true })?.action).toBe("palette");
    expect(press(map, "K", { metaKey: true })?.action).toBe("palette");
    expect(press(map, "k", { altKey: true })).toBeNull();
    expect(press(map, "k", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press(map, "k", { ctrlKey: true, metaKey: true })).toBeNull();
    expect(press(map, "g", { ctrlKey: true, altKey: true })).toBeNull();
    // Shifted or capitalised letters never act as a chord key.
    press(map, "g", {}, open, 0);
    expect(press(map, "T", { shiftKey: true }, open, 10)).toBeNull();
    expect(press(map, "G", { shiftKey: true })).toBeNull();
  });
  it("lets Ctrl or Cmd+K work while typing and when single keys are off", () => {
    const map = createKeymap();
    expect(
      press(map, "k", { ctrlKey: true }, { ...open, typing: true }),
    ).toMatchObject({ action: "palette", preventDefault: true });
    expect(
      press(map, "k", { ctrlKey: true }, { ...open, singleKeys: false })
        ?.action,
    ).toBe("palette");
  });
  it("leaves Ctrl+K to another open dialog but lets the palette toggle", () => {
    const map = createKeymap();
    const dialog = { ...open, dialogOpen: true };
    expect(press(map, "k", { ctrlKey: true }, dialog)).toBeNull();
    expect(
      press(map, "k", { ctrlKey: true }, { ...dialog, paletteOpen: true })
        ?.action,
    ).toBe("palette");
  });
  it("ignores key repeat and IME composition, and they cancel a chord", () => {
    const map = createKeymap();
    press(map, "g", {}, open, 0);
    expect(press(map, "t", { repeat: true }, open, 1)).toBeNull();
    expect(map.pending).toBe(false);
    press(map, "g", {}, open, 0);
    expect(press(map, "t", { isComposing: true }, open, 1)).toBeNull();
    expect(map.pending).toBe(false);
    expect(press(map, "/", { isComposing: true })).toBeNull();
    expect(press(map, "/", { keyCode: 229 })).toBeNull();
    expect(press(map, "Process")).toBeNull();
    expect(press(map, "/", { repeat: true })).toBeNull();
  });
  it("does not treat modifier presses as chord input", () => {
    const map = createKeymap();
    press(map, "g", {}, open, 0);
    expect(press(map, "Shift", { shiftKey: true }, open, 5)).toBeNull();
    expect(map.pending).toBe(true);
    expect(press(map, "o", {}, open, 6)?.action).toBe("go:overview");
  });
});

describe("typing targets", () => {
  const node = (props: Record<string, unknown>, parent: unknown = null) => ({
    tagName: "DIV",
    isContentEditable: false,
    parentElement: parent,
    getAttribute: (name: string) =>
      (props.attrs as Record<string, string> | undefined)?.[name] ?? null,
    ...props,
  });
  it("treats form fields, editable regions and widgets as typing", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"])
      expect(isTypingTarget(node({ tagName }))).toBe(true);
    expect(isTypingTarget(node({ isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(node({ attrs: { role: "combobox" } }))).toBe(true);
    expect(isTypingTarget(node({ attrs: { role: "listbox" } }))).toBe(true);
    const editable = node({ attrs: { contenteditable: "true" } });
    expect(isTypingTarget(node({ tagName: "SPAN" }, editable))).toBe(true);
  });
  it("does not treat buttons, links, the body or nothing as typing", () => {
    expect(isTypingTarget(node({ tagName: "BUTTON" }))).toBe(false);
    expect(isTypingTarget(node({ tagName: "A" }))).toBe(false);
    expect(isTypingTarget(node({ tagName: "BODY" }))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget("input")).toBe(false);
  });
});
