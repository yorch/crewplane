// Theme control: "system" follows the operating system (no attribute), while
// "light" and "dark" set html[data-theme]. theme-boot.js has already applied a
// saved choice before the first paint; this module changes it afterwards and
// saves it. The attribute is the only thing JavaScript touches: every colour
// comes from the tokens in theme.css.
import { readTheme, writeTheme } from "./prefs-core.js";

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
let current = "system";
const listeners = new Set();

/** Called after the theme changes here or in another tab. */
export function onThemeChange(listener) {
  listeners.add(listener);
}

export function currentTheme() {
  return current;
}
export function applyTheme(theme) {
  current = theme;
  if (theme === "light" || theme === "dark")
    document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  for (const listener of listeners) listener(theme);
}
export function setTheme(theme) {
  applyTheme(theme);
  return writeTheme(storage(), theme);
}
/** The theme actually showing, resolved against the system preference. */
export function effectiveTheme() {
  if (current !== "system") return current;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
export function initTheme() {
  applyTheme(readTheme(storage()));
  // Another tab changing the choice applies here too.
  window.addEventListener("storage", (event) => {
    if (event.key === "crewplane.theme" || event.key === null)
      applyTheme(readTheme(storage()));
  });
}
