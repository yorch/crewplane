// The one place keyboard shortcuts are defined, and a pure resolver that turns
// key events into actions. No DOM access: the caller describes the situation
// (what has focus, whether a dialog is open, whether single keys are on) and
// gets back an action name or null. The overlay table is generated from the
// same list, so the documentation cannot drift from the behaviour.
//
// Design rules (each is asserted by a test):
//   - A bare key (no Ctrl, Meta or Alt) is only ever bound when focus is not in
//     a text field, select, editable region or composite widget, and never
//     while a dialog is open.
//   - The only modified binding is Ctrl/Cmd+K, which also works while typing
//     (it is how most apps open a palette) but never over another dialog.
//   - Key repeat and IME composition are ignored and cancel a pending chord.
//   - Navigation is a two key chord: "g" then a letter within 1.5 seconds.
//   - Single key shortcuts can be turned off (assistive technology often needs
//     the keys); Ctrl/Cmd+K and the visible Search button keep working.

export const CHORD_TIMEOUT_MS = 1500;
export const CHORD_PREFIX = "g";

/** View chords: "g" then the key. Every dashboard view has exactly one. */
export const NAV_CHORDS = {
  o: ["overview", "Overview"],
  t: ["tasks", "Tasks"],
  a: ["agents", "Agents"],
  m: ["messages", "Messages"],
  r: ["runs", "Runs"],
  l: ["relationships", "Relationships"],
  u: ["usage", "Usage & cost"],
  e: ["evidence", "Evidence"],
  c: ["audit", "Control log"],
  s: ["setup", "Setup & config"],
  n: ["system", "System & notes"],
};

/**
 * Every binding. `keys` is the sequence shown in the overlay; `mod` marks the
 * one modified binding; `bare` bindings obey the single key switch.
 */
export const BINDINGS = [
  {
    id: "palette-mod",
    group: "Anywhere",
    keys: ["Ctrl", "K"],
    alt: "Cmd K on macOS",
    description: "Open search and commands",
    action: "palette",
    mod: true,
  },
  {
    id: "palette-slash",
    group: "Anywhere",
    keys: ["/"],
    description: "Open search and commands",
    action: "palette",
    bare: true,
  },
  {
    id: "help",
    group: "Anywhere",
    keys: ["?"],
    description: "Show this list of shortcuts",
    action: "help",
    bare: true,
  },
  ...Object.entries(NAV_CHORDS).map(([key, [view, label]]) => ({
    id: `go-${view}`,
    group: "Go to a view",
    keys: [CHORD_PREFIX, key],
    description: label,
    action: `go:${view}`,
    bare: true,
    chord: true,
  })),
];

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION"]);
const WIDGET_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "grid",
  "tree",
  "slider",
  "spinbutton",
]);
/** True when letter keys belong to the focused element, not to shortcuts. */
export function isTypingTarget(node) {
  if (!node || typeof node !== "object") return false;
  if (TYPING_TAGS.has(String(node.tagName ?? "").toUpperCase())) return true;
  if (node.isContentEditable) return true;
  for (let current = node, depth = 0; current && depth < 12; depth++) {
    const role = current.getAttribute?.("role");
    if (role && WIDGET_ROLES.has(role)) return true;
    const editable = current.getAttribute?.("contenteditable");
    if (editable === "" || editable === "true" || editable === "plaintext-only")
      return true;
    current = current.parentElement ?? null;
  }
  return false;
}

/**
 * A resolver with the chord state inside. `situation` per event:
 *   typing        focus is in an editable or composite element
 *   dialogOpen    a modal dialog is open
 *   singleKeys    single key shortcuts are enabled
 * Returns { action, preventDefault } or null.
 */
export function createKeymap(options = {}) {
  const timeout = options.timeout ?? CHORD_TIMEOUT_MS;
  let pendingSince = null;
  const reset = () => {
    pendingSince = null;
  };
  const chordTargets = new Map(
    BINDINGS.filter((binding) => binding.chord).map((binding) => [
      binding.keys[1],
      binding.action,
    ]),
  );
  return {
    /** True while a chord prefix is waiting for its second key. */
    get pending() {
      return pendingSince !== null;
    },
    reset,
    handle(event, situation, now = Date.now()) {
      if (
        event.isComposing ||
        event.key === "Process" ||
        event.key === "Dead" ||
        event.keyCode === 229
      ) {
        reset();
        return null;
      }
      if (event.repeat) {
        reset();
        return null;
      }
      const key = event.key;
      if (typeof key !== "string" || key.length === 0) return null;
      // Modifier keys on their own are neither a shortcut nor a cancel.
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(key))
        return null;

      if (event.ctrlKey || event.metaKey) {
        reset();
        if (
          key.toLowerCase() === "k" &&
          !event.altKey &&
          !event.shiftKey &&
          !(event.ctrlKey && event.metaKey)
        ) {
          // Over another dialog the key belongs to that dialog.
          if (situation.dialogOpen && !situation.paletteOpen) return null;
          return { action: "palette", preventDefault: true };
        }
        return null;
      }
      if (event.altKey) {
        reset();
        return null;
      }

      const bareAllowed =
        situation.singleKeys && !situation.typing && !situation.dialogOpen;
      if (!bareAllowed) {
        reset();
        return null;
      }

      if (pendingSince !== null) {
        const fresh = now - pendingSince <= timeout;
        reset();
        if (fresh && !event.shiftKey) {
          const action = chordTargets.get(key);
          if (action) return { action, preventDefault: true };
          // Any other key cancels the chord and is not reinterpreted.
          return null;
        }
        // Timed out: fall through and treat this key as a new first key.
      }
      if (key === CHORD_PREFIX && !event.shiftKey) {
        pendingSince = now;
        return { action: "chord-start", preventDefault: false };
      }
      if (key === "/" && !event.shiftKey)
        return { action: "palette", preventDefault: true };
      if (key === "?") return { action: "help", preventDefault: true };
      return null;
    },
  };
}
