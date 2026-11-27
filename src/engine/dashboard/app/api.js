import { $, hooks, store } from "./store.js";
import { date, refreshRelativeTimes } from "./time.js";

// Per-launch session: the printed URL carries `#token=…` (a fragment, so no
// server, log or Referer ever sees it). Keep it in sessionStorage (scoped to
// this origin, unlike a cookie), strip it from the URL and send it as a header.
const SESSION_KEY = "crewplane-session";
let sessionToken = null;
try {
  sessionToken = window.sessionStorage.getItem(SESSION_KEY);
} catch {
  // Storage may be blocked; the in-memory token below still works for this tab.
}
// Adopts a `token=` fragment parameter (`#token=T`, `#token=T&/tasks`,
// `#/tasks&token=T`, `#/tasks?q=x&token=T`), removes it from the URL and keeps
// the rest of the route. Returns true when a token was adopted.
export function adoptFragmentToken() {
  const hash = window.location.hash;
  const match = /(^#|[?&])token=([A-Za-z0-9_-]{16,128})(?=&|$)/.exec(hash);
  if (!match) return false;
  sessionToken = match[2];
  try {
    window.sessionStorage.setItem(SESSION_KEY, sessionToken);
  } catch {
    // Memory only.
  }
  const rest = hash
    .slice(1)
    .replace(/(^|[?&])token=[A-Za-z0-9_-]{16,128}(&|$)/, (_all, pre, post) =>
      pre === "" ? "" : pre === "?" ? (post ? "?" : "") : post ? "&" : "",
    );
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`,
  );
  return true;
}
adoptFragmentToken();
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
export function applySnapshot(next) {
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
  store.lastSuccess = Date.now();
  refreshRelativeTimes();
  setConnection("live", "Live");
  $("connection-time").textContent = `Checked ${date(updatedAt)}`;
  $("error").hidden = true;
}
function showDisconnected(message) {
  setConnection("disconnected", "Disconnected");
  $("connection-time").textContent = "Retrying every 5s";
  const context = store.lastSuccess
    ? `Showing the last snapshot from ${date(store.lastSuccess)}; it may be out of date.`
    : "No snapshot has been received yet.";
  const text = `${message} ${context} Retrying every 5s.`;
  if ($("error").textContent !== text) $("error").textContent = text;
  $("error").hidden = false;
  if (!store.data)
    $("loading").textContent =
      "Waiting for the dashboard server. Retrying every 5s.";
}
export async function refresh() {
  if (store.busy) return;
  store.busy = true;
  $("refresh").setAttribute("aria-busy", "true");
  let next;
  try {
    const response = await window.crewplaneFetch("/api/snapshot", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(await snapshotError(response));
    next = await response.json();
  } catch (error) {
    showDisconnected(error.message);
    return;
  } finally {
    store.busy = false;
    $("refresh").removeAttribute("aria-busy");
  }
  try {
    applySnapshot(next);
  } catch (error) {
    showDisconnected(`Render failed: ${error.message}`);
  }
}
