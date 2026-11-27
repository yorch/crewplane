// The one Preferences dialog (opened from the sidebar): theme, single key
// shortcuts, alerts and "reset saved view state". Every control has a visible
// label, nothing is requested without a click, and each change applies at once
// and is saved to localStorage when storage is available.

import { createModal } from "./dialog-kit.js";
import { el } from "./dom.js";
import {
  alertPrefs,
  notificationSupport,
  requestDesktopPermission,
  saveAlertPrefs,
} from "./notify.js";
import { CATEGORIES, CATEGORY_LABELS } from "./notify-core.js";
import { resetViewState, THEME_LABELS, THEMES } from "./prefs-core.js";
import {
  onSingleKeysChange,
  setSingleKeys,
  singleKeysEnabled,
} from "./shortcuts.js";
import { currentTheme, onThemeChange, setTheme } from "./theme.js";

let modal = null;
let refs = null;

function storages() {
  const get = (name) => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };
  return [get("localStorage"), get("sessionStorage")];
}
function permissionText() {
  const permission = notificationSupport();
  if (permission === "unsupported")
    return "This browser does not support desktop notifications. The tab title count still works.";
  if (permission === "granted")
    return "Desktop alerts are allowed in this browser.";
  if (permission === "denied")
    return "Desktop alerts are blocked in this browser. Change the site permission in the browser to allow them.";
  return "The browser will ask for permission when you choose Enable desktop alerts.";
}
/** Updates every control from the saved state (theme buttons are shared). */
export function syncPreferences() {
  const theme = currentTheme();
  for (const node of document.querySelectorAll("[data-theme-choice]")) {
    const on = node.dataset.themeChoice === theme;
    if (node.tagName === "INPUT") node.checked = on;
    else node.setAttribute("aria-pressed", String(on));
  }
  if (!refs) return;
  const prefs = alertPrefs();
  refs.shortcuts.checked = singleKeysEnabled();
  refs.badge.checked = prefs.badge;
  refs.desktop.checked = prefs.desktop && notificationSupport() === "granted";
  refs.desktop.disabled = notificationSupport() !== "granted";
  refs.enable.hidden = notificationSupport() === "granted";
  refs.enable.disabled = ["denied", "unsupported"].includes(
    notificationSupport(),
  );
  refs.visible.checked = prefs.whenVisible;
  for (const [name, box] of refs.categories)
    box.checked = prefs.categories[name];
  refs.permission.textContent = permissionText();
}
function checkbox(label, onChange) {
  const wrap = el("label", undefined, "check pref-check");
  const input = el("input");
  input.type = "checkbox";
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input, ` ${label}`);
  return [wrap, input];
}
function update(change) {
  const prefs = alertPrefs();
  change(prefs);
  saveAlertPrefs(prefs);
  syncPreferences();
}
function build() {
  modal = createModal({
    id: "preferences-dialog",
    title: "Preferences",
    className: "preferences-dialog",
  });
  refs = { categories: new Map() };

  const theme = el("fieldset", undefined, "pref-group");
  theme.append(el("legend", "Theme"));
  const radios = el("div", undefined, "pref-radios");
  for (const choice of THEMES) {
    const wrap = el("label", undefined, "check pref-check");
    const input = el("input");
    input.type = "radio";
    input.name = "pref-theme";
    input.dataset.themeChoice = choice;
    input.addEventListener("change", () => {
      setTheme(choice);
      syncPreferences();
    });
    wrap.append(input, ` ${THEME_LABELS[choice]}`);
    radios.append(wrap);
  }
  theme.append(
    radios,
    el(
      "p",
      "System follows your operating system setting. The choice is saved in this browser only.",
      "note",
    ),
  );

  const keys = el("fieldset", undefined, "pref-group");
  keys.append(el("legend", "Keyboard"));
  const [shortcutsWrap, shortcutsBox] = checkbox(
    "Single-key shortcuts",
    (on) => {
      setSingleKeys(on);
    },
  );
  refs.shortcuts = shortcutsBox;
  keys.append(
    shortcutsWrap,
    el(
      "p",
      "Turn these off if your assistive technology uses single keys. Ctrl or Cmd+K and the Search button keep working.",
      "note",
    ),
  );

  const alerts = el("fieldset", undefined, "pref-group");
  alerts.append(el("legend", "Alerts"));
  alerts.append(
    el(
      "p",
      "Alerts are off until you turn them on. They show counts and fixed phrases only, never message text, and they compare consecutive updates, so nothing is announced for what was already on screen when the page opened.",
      "note",
    ),
  );
  const [badgeWrap, badgeBox] = checkbox(
    "Show a count in the tab title",
    (on) =>
      update((prefs) => {
        prefs.badge = on;
      }),
  );
  refs.badge = badgeBox;
  const enable = el("button", "Enable desktop alerts", "text-button");
  enable.type = "button";
  enable.addEventListener("click", async () => {
    await requestDesktopPermission();
    if (notificationSupport() === "granted")
      update((prefs) => {
        prefs.desktop = true;
      });
    else syncPreferences();
  });
  refs.enable = enable;
  const [desktopWrap, desktopBox] = checkbox("Desktop alerts", (on) =>
    update((prefs) => {
      prefs.desktop = on;
    }),
  );
  refs.desktop = desktopBox;
  refs.permission = el("p", undefined, "note");
  refs.permission.setAttribute("role", "status");
  const [visibleWrap, visibleBox] = checkbox(
    "Also alert while this tab is open and focused",
    (on) =>
      update((prefs) => {
        prefs.whenVisible = on;
      }),
  );
  refs.visible = visibleBox;
  const what = el("fieldset", undefined, "pref-sub");
  what.append(el("legend", "Alert me when"));
  for (const name of CATEGORIES) {
    const [wrap, box] = checkbox(CATEGORY_LABELS[name], (on) =>
      update((prefs) => {
        prefs.categories[name] = on;
      }),
    );
    refs.categories.set(name, box);
    what.append(wrap);
  }
  alerts.append(
    badgeWrap,
    desktopWrap,
    enable,
    refs.permission,
    visibleWrap,
    what,
  );

  const reset = el("fieldset", undefined, "pref-group");
  reset.append(el("legend", "Saved view state"));
  const resetButton = el("button", "Reset saved view state", "text-button");
  resetButton.type = "button";
  const resetStatus = el("p", undefined, "note");
  resetStatus.setAttribute("role", "status");
  resetButton.addEventListener("click", () => {
    const [local, session] = storages();
    resetStatus.textContent = resetViewState(local, session)
      ? "Saved layout, scroll positions and open notes were cleared. Theme, shortcut and alert choices were kept."
      : "Some saved state could not be cleared (storage is not available).";
  });
  reset.append(
    resetButton,
    resetStatus,
    el(
      "p",
      "Forgets the remembered Tasks layout and the scroll and open-note memory kept for a reload.",
      "note",
    ),
  );
  modal.body.append(theme, keys, alerts, reset);
  onSingleKeysChange(syncPreferences);
}
export function openPreferences() {
  if (!modal) build();
  syncPreferences();
  modal.open();
}
export function initPreferences() {
  // A theme chosen in another tab must update the pressed state here too.
  onThemeChange(syncPreferences);
  document
    .getElementById("prefs-open")
    ?.addEventListener("click", openPreferences);
  for (const node of document.querySelectorAll("[data-theme-choice]"))
    if (node.tagName === "BUTTON")
      node.addEventListener("click", () => {
        setTheme(node.dataset.themeChoice);
        syncPreferences();
      });
  syncPreferences();
}
