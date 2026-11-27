import {
  applySnapshot,
  markFresh,
  refresh,
  setMode,
  showDisconnected,
} from "./api.js";
import {
  backoffDelay,
  createLiveSession,
  createSseParser,
  liveTuning,
} from "./live-core.js";

// Live updates over GET /api/events. EventSource cannot send the per-launch
// session header, so this reads the stream with fetch(). Any failure drops the
// page back to the existing 5s polling (the retained-snapshot banner behaves as
// before) while reconnecting with capped exponential backoff and jitter.
//
// Reconnecting is deliberately slow to speed up: the backoff counter resets
// only after a snapshot was rendered or a stream stayed up for `stableMs`,
// never because a connection opened or a heartbeat arrived. A board too large
// to push (`resync`) keeps the stream open and the page polling. A tab hidden
// for `hiddenGraceMs` closes its stream (the server serves at most 8) and
// reopens it when the tab is shown again.
const tuning = liveTuning(window.crewplaneLiveTuning);
const session = createLiveSession({
  applySnapshot: (value) => applySnapshot(value, { stream: true }),
  markFresh,
  showDisconnected,
  setMode,
});
let started = false;
let attempt = 0;
let connecting = false;
let suspended = false;
let current = null;
let reconnectTimer;
let hiddenTimer;

async function connect() {
  if (connecting || suspended) return;
  connecting = true;
  const controller = new AbortController();
  current = controller;
  const openedAt = Date.now();
  let idle;
  const watch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), tuning.idleMs);
  };
  try {
    watch();
    const lastEventId = session.lastEventId;
    const response = await window.crewplaneFetch("/api/events", {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "text/event-stream",
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
    });
    if (
      !response.ok ||
      !response.body ||
      !/^text\/event-stream/i.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("Live updates unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch();
      for (const event of parser.feed(decoder.decode(value, { stream: true })))
        if (session.handle(event) === "applied") attempt = 0;
    }
  } catch {
    // Fall through to polling; the reason is not user-actionable.
  } finally {
    clearTimeout(idle);
    controller.abort();
    connecting = false;
    current = null;
  }
  if (suspended) return;
  setMode("polling");
  const stable = Date.now() - openedAt >= tuning.stableMs;
  if (stable) attempt = 0;
  attempt += 1;
  reconnectTimer = setTimeout(
    connect,
    backoffDelay(
      attempt,
      Math.random,
      tuning.backoffBaseMs,
      tuning.backoffCapMs,
    ),
  );
  // The 5s poll takes over by itself. Only a stream that had been healthy for
  // a while is worth an immediate catch-up; a flapping one must not turn into
  // a request per drop.
  if (stable) refresh();
}

function suspend() {
  suspended = true;
  clearTimeout(reconnectTimer);
  current?.abort();
  setMode("polling");
}

function resume() {
  clearTimeout(hiddenTimer);
  if (!suspended) return;
  suspended = false;
  attempt = 0;
  refresh();
  if (document.hidden) hiddenTimer = setTimeout(suspend, tuning.hiddenGraceMs);
  connect();
}

export function startLive() {
  if (started) return;
  started = true;
  if (
    typeof ReadableStream === "undefined" ||
    typeof TextDecoder === "undefined" ||
    typeof AbortController === "undefined"
  )
    return;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(suspend, tuning.hiddenGraceMs);
    } else resume();
  });
  if (document.hidden) hiddenTimer = setTimeout(suspend, tuning.hiddenGraceMs);
  connect();
}
