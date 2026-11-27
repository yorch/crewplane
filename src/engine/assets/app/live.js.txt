import {
  applySnapshot,
  markFresh,
  refresh,
  setMode,
  showDisconnected,
} from "./api.js";
import { backoffDelay, createSseParser } from "./live-core.js";

// Live updates over GET /api/events. EventSource cannot send the per-launch
// session header, so this reads the stream with fetch(). Any failure drops the
// page back to the existing 5s polling (the retained-snapshot banner behaves as
// before) while reconnecting with capped exponential backoff and jitter.
const IDLE_MS = 45000; // three missed 15s heartbeats
let started = false;
let attempt = 0;
let lastEventId = null;
let failed = false;

function handle(event) {
  if (event.id) lastEventId = event.id;
  let value;
  try {
    value = JSON.parse(event.data);
  } catch {
    throw new Error("Malformed live event");
  }
  if (event.event === "snapshot") {
    failed = false;
    try {
      applySnapshot(value);
    } catch (error) {
      showDisconnected(`Render failed: ${error.message}`, "automatically");
    }
  } else if (event.event === "error") {
    failed = true;
    showDisconnected(
      typeof value?.error === "string"
        ? value.error
        : "Dashboard data unavailable.",
      "automatically",
    );
  } else if (event.event === "ping" && !failed && typeof value?.at === "string")
    markFresh(value.at);
}

async function connect() {
  const controller = new AbortController();
  let idle;
  const watch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_MS);
  };
  let received = false;
  try {
    watch();
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
      for (const event of parser.feed(
        decoder.decode(value, { stream: true }),
      )) {
        if (!received) {
          received = true;
          attempt = 0;
          failed = false;
          setMode("live");
        }
        handle(event);
      }
    }
  } catch {
    // Fall through to polling; the reason is not user-actionable.
  } finally {
    clearTimeout(idle);
    controller.abort();
  }
  setMode("polling");
  attempt += 1;
  setTimeout(connect, backoffDelay(attempt));
  // Polling takes over at once, so the banner and snapshot stay current.
  if (received) refresh();
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
  connect();
}
