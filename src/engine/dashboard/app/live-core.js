// Pure helpers for the live (server-sent events) transport: an incremental
// event-stream parser and the reconnect backoff. No DOM, so both are unit tested.

// Larger than the server's MAX_EVENT_BYTES (src/engine/dashboard/live.ts, 8 MiB;
// a unit test keeps them ordered): the server never sends a bigger event, it
// sends `resync`, so this limit only guards against a misbehaving peer.
export const MAX_EVENT_CHARS = 8 * 1024 * 1024 + 64 * 1024;

/**
 * Incremental parser for the text/event-stream wire format. `feed(text)` takes
 * decoded text in arbitrary chunks and returns the complete events it
 * produced: `{ event, data, id }`. Comments and unknown fields are ignored.
 * Throws when a single event grows beyond `limit` characters.
 */
export function createSseParser(limit = MAX_EVENT_CHARS) {
  let buffer = "";
  let event = "";
  let data = [];
  let size = 0;
  let id = null;
  const line = (text, out) => {
    if (text === "") {
      if (data.length > 0)
        out.push({ event: event || "message", data: data.join("\n"), id });
      event = "";
      data = [];
      size = 0;
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      size += value.length + 1;
      if (size > limit) throw new Error("Event too large");
      data.push(value);
    } else if (field === "id" && !value.includes("\0")) id = value;
  };
  return {
    feed(chunk) {
      buffer += chunk;
      const out = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== "\n" && c !== "\r") continue;
        // A trailing CR may be the first half of CRLF; wait for the next chunk.
        if (c === "\r" && i === buffer.length - 1) break;
        line(buffer.slice(start, i), out);
        if (c === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      if (buffer.length + size > limit) throw new Error("Event too large");
      return out;
    },
  };
}

/**
 * Capped exponential backoff with +-25% jitter, in milliseconds. `attempt`
 * counts consecutive failures starting at 1.
 */
export function backoffDelay(
  attempt,
  random = Math.random,
  base = 1000,
  cap = 60000,
) {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 16);
  const raw = Math.min(cap, base * 2 ** exponent);
  return Math.round(raw * (0.75 + random() * 0.5));
}

/** A snapshot was received but could not be rendered. */
export class RenderFailure extends Error {}

/**
 * Applies the stream's events to the page. All page effects are injected
 * (`applySnapshot`, `markFresh`, `showDisconnected`, `setMode`), so the rules
 * are unit tested without a DOM:
 *
 * - `lastEventId` advances only for an event that was fully handled, so a
 *   snapshot that failed to render is asked for again on reconnect.
 * - The transport is "live" only once a snapshot was applied (or a heartbeat
 *   confirms the one already applied is current), never merely because the
 *   stream opened. `resync` means the board is too large to push: polling.
 * - A heartbeat refreshes "Checked" and hides the banner only when it names
 *   the event the page already shows and nothing is outstanding (an error
 *   event or a render failure).
 *
 * `handle` returns "applied" after a rendered snapshot and throws
 * `RenderFailure` after a failed render (the caller drops the stream).
 */
export function createLiveSession({
  applySnapshot,
  markFresh,
  showDisconnected,
  setMode,
}) {
  let lastEventId = null;
  let failed = false;
  return {
    get lastEventId() {
      return lastEventId;
    },
    get failed() {
      return failed;
    },
    handle(event) {
      let value;
      try {
        value = JSON.parse(event.data);
      } catch {
        throw new Error("Malformed live event");
      }
      if (event.event === "snapshot") {
        try {
          applySnapshot(value);
        } catch (error) {
          failed = true;
          lastEventId = null;
          setMode("polling");
          showDisconnected(`Render failed: ${error.message}`, "automatically");
          throw new RenderFailure(error.message);
        }
        failed = false;
        if (event.id) lastEventId = event.id;
        setMode("live");
        return "applied";
      }
      if (event.event === "error") {
        failed = true;
        if (event.id) lastEventId = event.id;
        showDisconnected(
          typeof value?.error === "string"
            ? value.error
            : "Dashboard data unavailable.",
          "automatically",
        );
      } else if (event.event === "resync") setMode("polling");
      else if (event.event === "ping") {
        if (value?.kind === "resync") setMode("polling");
        else if (
          value?.kind === "snapshot" &&
          !failed &&
          typeof value.id === "string" &&
          value.id === lastEventId &&
          typeof value.at === "string"
        ) {
          setMode("live");
          markFresh(value.at);
        }
      }
      return "other";
    },
  };
}

const bounded = (value, min, max, fallback) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

/**
 * Timings for the stream, overridable only through `window.crewplaneLiveTuning`
 * (tests inject short ones before the page script runs); values are clamped.
 */
export function liveTuning(override) {
  const o = override && typeof override === "object" ? override : {};
  return {
    idleMs: bounded(o.idleMs, 50, 45000, 45000),
    backoffBaseMs: bounded(o.backoffBaseMs, 10, 1000, 1000),
    backoffCapMs: bounded(o.backoffCapMs, 10, 60000, 60000),
    stableMs: bounded(o.stableMs, 100, 30000, 30000),
    hiddenGraceMs: bounded(o.hiddenGraceMs, 0, 30000, 30000),
  };
}
