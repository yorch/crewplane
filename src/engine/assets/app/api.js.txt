import { $, hooks, store } from "./store.js";
import { date, refreshRelativeTimes } from "./time.js";

// Per-launch session: the printed URL carries `#token=…` (a fragment, so no
// server, log or Referer ever sees it). Keep it in sessionStorage (scoped to
// this origin, unlike a cookie), strip it from the URL and send it as a header.
// The optional operator-controls URL also carries `controls=…`; it is handled
// the same way, kept apart from the read session, and only ever sent to
// POST /api/control.
const SESSION_KEY = "crewplane-session";
const CONTROLS_KEY = "crewplane-controls";
let sessionToken = null;
let controlsToken = null;
try {
  sessionToken = window.sessionStorage.getItem(SESSION_KEY);
  controlsToken = window.sessionStorage.getItem(CONTROLS_KEY);
} catch {
  // Storage may be blocked; the in-memory tokens below still work for this tab.
}
const paramPattern = (name) =>
  new RegExp(`(^#|[?&])${name}=([A-Za-z0-9_-]{16,128})(?=&|$)`);
// Removes `name=value` from a fragment, keeping the rest of the route.
function stripParam(hash, name) {
  return hash
    .slice(1)
    .replace(
      new RegExp(`(^|[?&])${name}=[A-Za-z0-9_-]{16,128}(&|$)`),
      (_all, pre, post) =>
        pre === "" ? "" : pre === "?" ? (post ? "?" : "") : post ? "&" : "",
    );
}
// Adopts `token=` and `controls=` fragment parameters (`#token=T`,
// `#token=T&controls=C`, `#token=T&/tasks`, `#/tasks&token=T`,
// `#/tasks?q=x&token=T`), removes them from the URL and keeps the rest of the
// route. Returns true when a session token was adopted.
export function adoptFragmentToken() {
  const hash = window.location.hash;
  const match = paramPattern("token").exec(hash);
  const controls = paramPattern("controls").exec(hash);
  if (!match && !controls) return false;
  if (match) {
    sessionToken = match[2];
    try {
      window.sessionStorage.setItem(SESSION_KEY, sessionToken);
    } catch {
      // Memory only.
    }
  }
  if (controls) {
    controlsToken = controls[2];
    try {
      window.sessionStorage.setItem(CONTROLS_KEY, controlsToken);
    } catch {
      // Memory only.
    }
  }
  let rest = hash;
  if (match) rest = `#${stripParam(rest, "token")}`;
  if (controls) rest = `#${stripParam(rest, "controls")}`;
  rest = rest.slice(1);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`,
  );
  if (controls) window.dispatchEvent(new Event("crewplane-controls-token"));
  return Boolean(match);
}
adoptFragmentToken();
export const hasControlsToken = () => controlsToken !== null;
// The controls token leaves this module only inside the header of a request to
// the control endpoint; it is never written to the DOM, URL or the log.
export function controlFetch(body, options = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-crewplane-token": controlsToken ?? "",
  });
  if (sessionToken) headers.set("x-crewplane-session", sessionToken);
  return fetch("/api/control", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    ...options,
  });
}
window.crewplaneFetch = (url, options = {}) => {
  const headers = new Headers(options.headers);
  if (sessionToken) headers.set("x-crewplane-session", sessionToken);
  return fetch(url, { ...options, headers });
};

async function snapshotError(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Non-JSON failures fall back to the status code below.
  }
  return `Dashboard data unavailable (${response.status}).`;
}
function setConnection(state, text) {
  $("connection-wrap").dataset.state = state;
  if ($("connection").textContent !== text) $("connection").textContent = text;
}
// The transport shows beside the check time ("Checked 10:00:01 · live updates"),
// so the primary "Live" / "Disconnected" status and its banner are unchanged.
const modeLabel = { live: "live updates", polling: "polling" };
let checkedAt = null;
function paintChecked() {
  if (checkedAt === null) return;
  $("connection-time").textContent =
    `Checked ${checkedAt} · ${modeLabel[store.mode]}`;
}
export function setMode(mode) {
  store.mode = mode;
  $("connection-wrap").dataset.mode = mode;
  if ($("connection-wrap").dataset.state === "live") paintChecked();
}
// A stream heartbeat proves the retained snapshot is still current.
export function markFresh(at) {
  if (!store.data) return;
  const ms = Date.parse(at);
  if (Number.isFinite(ms)) {
    if (ms < store.appliedAt) return;
    store.appliedAt = ms;
  }
  store.lastSuccess = Date.now();
  setConnection("live", "Live");
  checkedAt = date(at);
  paintChecked();
  $("error").hidden = true;
}
/**
 * Applies a snapshot. A pushed one (`stream`) older than what the page already
 * shows (a newer poll answered first) is dropped, so "Checked" never goes back
 * in time. Returns false when it was dropped.
 */
export function applySnapshot(next, { stream = false } = {}) {
  const at = Date.parse(next?.updatedAt);
  if (stream && store.data && Number.isFinite(at) && at < store.appliedAt)
    return false;
  store.applied += 1;
  const { updatedAt, ...content } = next;
  const signature = JSON.stringify(content);
  const firstLoad = !store.data;
  const previous = store.data;
  if (signature !== store.fingerprint) {
    store.data = next;
    try {
      hooks.commitSnapshot(firstLoad);
    } catch (error) {
      // Keep the last good snapshot as the source of truth and force the next
      // successful snapshot to re-render, even if its content matches.
      store.data = previous;
      store.fingerprint = undefined;
      if (previous) {
        try {
          hooks.render();
        } catch {
          // The original error is more useful than a secondary render failure.
        }
      }
      throw error;
    }
    window.crewplaneGraphSnapshot = {
      graphs: store.data.graphs,
      models: store.data.graphModels,
      coverage: store.data.graphCoverage,
    };
    window.dispatchEvent(
      new CustomEvent("crewplane-graphs", {
        detail: window.crewplaneGraphSnapshot,
      }),
    );
    store.fingerprint = signature;
    // The graph viewer (a separate module) draws synchronously in the event
    // above, so anything that depends on final page height belongs here.
    hooks.afterGraphs?.(firstLoad);
  }
  if (Number.isFinite(at)) store.appliedAt = Math.max(store.appliedAt, at);
  store.lastSuccess = Date.now();
  refreshRelativeTimes();
  setConnection("live", "Live");
  checkedAt = date(updatedAt);
  paintChecked();
  $("error").hidden = true;
  return true;
}
export function showDisconnected(message, retry = "every 5s") {
  setConnection("disconnected", "Disconnected");
  $("connection-time").textContent = `Retrying ${retry}`;
  const context = store.lastSuccess
    ? `Showing the last snapshot from ${date(store.lastSuccess)}; it may be out of date.`
    : "No snapshot has been received yet.";
  const text = `${message} ${context} Retrying ${retry}.`;
  if ($("error").textContent !== text) $("error").textContent = text;
  $("error").hidden = false;
  if (!store.data)
    $("loading").textContent =
      `Waiting for the dashboard server. Retrying ${retry}.`;
}
export async function refresh() {
  if (store.busy) return;
  store.busy = true;
  $("refresh").setAttribute("aria-busy", "true");
  // A snapshot pushed while this request was in flight is newer than its
  // answer: the answer (or failure) is dropped instead of overwriting it.
  const started = store.applied;
  let next;
  try {
    const response = await window.crewplaneFetch("/api/snapshot", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(await snapshotError(response));
    next = await response.json();
  } catch (error) {
    if (store.applied === started) showDisconnected(error.message);
    return;
  } finally {
    store.busy = false;
    $("refresh").removeAttribute("aria-busy");
  }
  if (store.applied !== started) return;
  try {
    applySnapshot(next);
  } catch (error) {
    showDisconnected(`Render failed: ${error.message}`);
  }
}
