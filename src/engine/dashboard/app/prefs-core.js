// Preferences kept in localStorage: theme, single key shortcuts and alerts.
// Every access is wrapped, because storage can be blocked, full or disabled,
// and each value read back is validated, so a corrupt or hostile string falls
// back to the default. Nothing here touches the DOM.
import { LAYOUT_KEY } from "./config.js";
import { DEFAULT_ALERT_PREFS, sanitizeAlertPrefs } from "./notify-core.js";
import { UI_STATE_KEY } from "./persist.js";

export const THEME_KEY = "crewplane.theme";
export const SHORTCUTS_KEY = "crewplane.shortcuts";
export const ALERTS_KEY = "crewplane.alerts";
export const THEMES = ["system", "light", "dark"];
export const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function drop(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function readTheme(storage) {
  const value = read(storage, THEME_KEY);
  return THEMES.includes(value) ? value : "system";
}
export function writeTheme(storage, theme) {
  if (!THEMES.includes(theme)) return false;
  // "system" is the absence of a choice.
  return theme === "system"
    ? drop(storage, THEME_KEY)
    : write(storage, THEME_KEY, theme);
}

/** Single key shortcuts default to on. */
export function readShortcuts(storage) {
  return read(storage, SHORTCUTS_KEY) !== "off";
}
export function writeShortcuts(storage, enabled) {
  return enabled
    ? drop(storage, SHORTCUTS_KEY)
    : write(storage, SHORTCUTS_KEY, "off");
}

export function readAlerts(storage) {
  const text = read(storage, ALERTS_KEY);
  if (!text) return sanitizeAlertPrefs(null);
  try {
    return sanitizeAlertPrefs(JSON.parse(text));
  } catch {
    return sanitizeAlertPrefs(null);
  }
}
export function writeAlerts(storage, prefs) {
  return write(storage, ALERTS_KEY, JSON.stringify(sanitizeAlertPrefs(prefs)));
}

/**
 * "Reset saved view state": forgets the remembered Tasks layout, the reload
 * memory (scroll and open notes) and nothing else. Theme, shortcut and alert
 * choices are separate controls and are kept.
 */
export function resetViewState(local, session) {
  const results = [drop(local, LAYOUT_KEY)];
  results.push(drop(session, UI_STATE_KEY));
  return results.every(Boolean);
}

export { DEFAULT_ALERT_PREFS };
