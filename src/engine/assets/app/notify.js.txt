// Opt-in alerts. Every snapshot is compared with the previous one by the pure
// rules in notify-core.js; this module only applies the result: a count in the
// tab title and, when the person enabled and allowed them, a browser
// notification. Nothing is requested or shown until an explicit choice, and the
// notification permission is asked for only from a click on "Enable desktop
// alerts" (see requestDesktopPermission).
import { logResource } from "./aux.js";
import {
  createAlertState,
  describeAlerts,
  factsFromSnapshot,
  observe,
  sanitizeAlertPrefs,
  shouldCount,
  shouldNotify,
} from "./notify-core.js";
import { readAlerts, writeAlerts } from "./prefs-core.js";
import { store } from "./store.js";
import { setUnseen, unseenCount } from "./title.js";

const state = createAlertState();
let prefs = readAlerts(safeStorage());
const listeners = new Set();

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
export function alertPrefs() {
  return {
    ...prefs,
    categories: { ...prefs.categories },
  };
}
export function saveAlertPrefs(next) {
  prefs = sanitizeAlertPrefs(next);
  writeAlerts(safeStorage(), prefs);
  if (!prefs.badge) setUnseen(0);
  for (const listener of listeners) listener();
}
export function onAlertPrefsChange(listener) {
  listeners.add(listener);
}
export function notificationSupport() {
  try {
    return typeof Notification === "function"
      ? Notification.permission
      : "unsupported";
  } catch {
    return "unsupported";
  }
}
/** Must be called from a click handler; it is the only place permission is asked. */
export async function requestDesktopPermission() {
  if (notificationSupport() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationSupport();
  }
}
function looking() {
  return {
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
  };
}
function show(events) {
  const message = describeAlerts(events);
  if (!message) return;
  const situation = { permission: notificationSupport(), ...looking() };
  if (shouldNotify(prefs, situation)) {
    try {
      // A fixed tag replaces the previous alert instead of stacking them.
      new Notification(message.title, {
        body: message.body,
        tag: "crewplane-alert",
      });
    } catch {
      // Some browsers refuse the constructor; the title count still works.
    }
  }
  if (shouldCount(prefs, looking())) {
    setUnseen(unseenCount() + events.length);
  }
}
/** Compare the current snapshot (and control log, once read) with the last. */
export function checkAlerts() {
  if (!store.data) return;
  const facts = factsFromSnapshot(
    store.data,
    logResource.state.data?.entries ?? undefined,
  );
  const events = observe(state, facts, prefs);
  if (events.length) show(events);
}
function clearUnseen() {
  if (document.visibilityState === "visible" && document.hasFocus()) {
    if (unseenCount() !== 0) setUnseen(0);
  }
}
export function initNotify() {
  window.addEventListener("focus", clearUnseen);
  document.addEventListener("visibilitychange", clearUnseen);
}
