// Pure helpers for the live (server-sent events) transport: an incremental
// event-stream parser and the reconnect backoff. No DOM, so both are unit tested.

export const MAX_EVENT_CHARS = 16 * 1024 * 1024;

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
