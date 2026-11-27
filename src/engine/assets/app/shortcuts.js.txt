// Keyboard shortcuts: one document listener driven by the pure keymap in
// keymap-core.js, and the overlay that lists every binding (generated from the
// same table). Single key shortcuts can be switched off (kept in localStorage)
// for people whose assistive technology uses those keys.

import { anyDialogOpen, createModal } from "./dialog-kit.js";
import { el } from "./dom.js";
import { BINDINGS, createKeymap, isTypingTarget } from "./keymap-core.js";
import { closePalette, openPalette, paletteOpen } from "./palette.js";
import { readShortcuts, writeShortcuts } from "./prefs-core.js";
import { hrefFor } from "./route.js";

const keymap = createKeymap();
let singleKeys = true;
let help = null;
let helpToggle = null;
const listeners = new Set();

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
export function singleKeysEnabled() {
  return singleKeys;
}
export function setSingleKeys(enabled) {
  singleKeys = enabled;
  writeShortcuts(storage(), enabled);
  keymap.reset();
  if (helpToggle) helpToggle.checked = enabled;
  for (const listener of listeners) listener(enabled);
}
export function onSingleKeysChange(listener) {
  listeners.add(listener);
}

function keyCaps(keys) {
  const wrap = el("span", undefined, "keys");
  keys.forEach((key, position) => {
    if (position > 0 && keys[0] === "g")
      wrap.append(el("span", "then", "keys-then"));
    wrap.append(el("kbd", key));
  });
  return wrap;
}
function buildHelp() {
  help = createModal({
    id: "shortcuts-dialog",
    title: "Keyboard shortcuts",
    className: "shortcuts-dialog",
  });
  const toggle = el("label", undefined, "check shortcuts-toggle");
  helpToggle = el("input");
  helpToggle.type = "checkbox";
  helpToggle.checked = singleKeys;
  helpToggle.addEventListener("change", () =>
    setSingleKeys(helpToggle.checked),
  );
  toggle.append(helpToggle, " Single-key shortcuts");
  const note = el(
    "p",
    "Turn single-key shortcuts off if your screen reader or other assistive technology uses those keys. Ctrl or Cmd+K and the Search button keep working. Shortcuts never apply while you are typing or while a dialog is open.",
    "note",
  );
  const groups = new Map();
  for (const binding of BINDINGS) {
    groups.set(binding.group, [...(groups.get(binding.group) ?? []), binding]);
  }
  const sections = [];
  for (const [group, bindings] of groups) {
    const section = el("section", undefined, "shortcut-group");
    section.append(el("h3", group));
    const table = el("dl", undefined, "shortcut-list");
    for (const binding of bindings) {
      const term = el("dt");
      term.append(keyCaps(binding.keys));
      const description = el("dd", binding.description);
      if (binding.alt)
        description.append(el("span", ` (${binding.alt})`, "count"));
      table.append(term, description);
    }
    section.append(table);
    sections.push(section);
  }
  help.body.append(
    el(
      "p",
      "Press g, then a letter within a second and a half, to go to a view.",
      "note",
    ),
    ...sections,
    toggle,
    note,
  );
}
export function openHelp() {
  if (!help) buildHelp();
  helpToggle.checked = singleKeys;
  help.open();
}
export function helpOpen() {
  return Boolean(help?.isOpen);
}

function onKey(event) {
  const palette = paletteOpen();
  const result = keymap.handle(event, {
    typing: isTypingTarget(event.target),
    dialogOpen: anyDialogOpen(),
    paletteOpen: palette,
    singleKeys,
  });
  if (!result) return;
  if (result.preventDefault) event.preventDefault();
  const { action } = result;
  if (action === "palette") {
    if (palette) closePalette();
    else openPalette();
  } else if (action === "help") openHelp();
  else if (action.startsWith("go:"))
    window.crewplane.navigate(hrefFor(action.slice(3)));
}
export function initShortcuts() {
  singleKeys = readShortcuts(storage());
  document.addEventListener("keydown", onKey);
  // A chord left half typed must not survive a focus change.
  window.addEventListener("blur", () => keymap.reset());
}
