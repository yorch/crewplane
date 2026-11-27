// Pure helpers for the optional full-reload memory kept in sessionStorage:
// scroll position per view, scroll position of marked panes, and which static
// "How to read…" disclosures are open. Everything read back is untrusted (the
// storage may hold anything), so it is rebuilt field by field from an
// allowlist. Nothing here touches the DOM, so it is unit-tested directly.
import { ROUTE_PARAMS } from "./config.js";

export const UI_STATE_KEY = "crewplane-ui-state";
const VERSION = 1;
const MAX_SCROLL = 10_000_000;
const MAX_PANES = 40;
const MAX_OPEN = 20;
const SCROLL_KEY = /^([a-z]{1,20})(:detail)?$/;
const PANE_KEY = /^[A-Za-z0-9_.:-]{1,120}$/;
const DISCLOSURE_KEY = /^info-[a-z-]{1,40}$/;

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function offset(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_SCROLL, Math.max(0, Math.round(value)));
}

/** Rebuilds a stored value into a safe shape, or null when it is unusable. */
export function sanitizeUiState(raw) {
  if (!isRecord(raw) || raw.v !== VERSION) return null;
  if (typeof raw.view !== "string" || !Object.hasOwn(ROUTE_PARAMS, raw.view))
    return null;
  const scroll = {};
  if (isRecord(raw.scroll))
    for (const [key, value] of Object.entries(raw.scroll)) {
      const match = SCROLL_KEY.exec(key);
      const y = offset(value);
      if (match?.[1] && Object.hasOwn(ROUTE_PARAMS, match[1]) && y !== null)
        scroll[key] = y;
    }
  // Null prototype: a stored key such as "__proto__" is then an ordinary own
  // property, never the prototype setter.
  const panes = Object.create(null);
  if (isRecord(raw.panes))
    for (const [key, value] of Object.entries(raw.panes)) {
      if (Object.keys(panes).length >= MAX_PANES) break;
      if (!PANE_KEY.test(key) || !Array.isArray(value)) continue;
      const x = offset(value[0]);
      const y = offset(value[1]);
      if (x !== null && y !== null) panes[key] = [x, y];
    }
  const open = Array.isArray(raw.open)
    ? [
        ...new Set(
          raw.open.filter(
            (key) => typeof key === "string" && DISCLOSURE_KEY.test(key),
          ),
        ),
      ].slice(0, MAX_OPEN)
    : [];
  return { v: VERSION, view: raw.view, scroll, panes, open };
}

/** The persisted state for this tab, or null (missing, blocked or invalid). */
export function readUiState(storage) {
  try {
    const text = storage?.getItem(UI_STATE_KEY);
    return text ? sanitizeUiState(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Best effort: storage may be blocked or full, and nothing depends on it. */
export function writeUiState(storage, state) {
  const clean = sanitizeUiState({ ...state, v: VERSION });
  if (!clean) return false;
  try {
    storage.setItem(UI_STATE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** Only a reload or history traversal may restore; a fresh navigation starts at the top. */
export function restoresPosition(navigationType) {
  return navigationType === "reload" || navigationType === "back_forward";
}
