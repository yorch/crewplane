import { randomBytes } from "node:crypto";

/** The slice of `http.ServerResponse` the hub needs; tests substitute a fake. */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  destroy(): void;
  readonly writableLength: number;
  once(event: "drain", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

export interface LiveTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Real timers that never keep the process alive on their own. */
export const realTimers: LiveTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Largest serialized `snapshot` event body (UTF-8 bytes of the data line) the
 * stream will carry. A bigger board is never sent: the stream says `resync`
 * and the page keeps polling `/api/snapshot`. The client's parser limit
 * (`MAX_EVENT_CHARS` in app/live-core.js) is derived from this value and
 * is always larger, so a valid event can never trip it.
 */
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
/** Upper bound the adaptive recomputation interval grows to. */
export const MAX_INTERVAL_MS = 30000;
/** The recomputation interval is at least this many times the last compute duration. */
export const INTERVAL_PER_COMPUTE = 5;

export interface LiveOptions {
  /** One shared computation. `hash` identifies content; `data` is the JSON text sent. */
  compute: () => Promise<{ hash: string; data: string }>;
  /** Safe message sent in an `error` event when `compute` fails. */
  errorMessage: string;
  /** Minimum time between computations; grows with the compute duration. */
  intervalMs?: number;
  /** Ceiling for the adaptive interval (never below `intervalMs`). */
  maxIntervalMs?: number;
  heartbeatMs?: number;
  maxClients?: number;
  /** A snapshot whose serialized `data` is larger is replaced by a `resync` event. */
  maxEventBytes?: number;
  /**
   * A client whose unflushed socket buffer exceeds this, checked around every
   * write, is dropped. Defaults to twice the largest event so one legitimate
   * frame to a slow reader never trips it.
   */
  maxBufferedBytes?: number;
  /** A client that cannot accept writes for this long is dropped. */
  slowClientMs?: number;
  retryMs?: number;
  timers?: LiveTimers;
  now?: () => number;
}

interface Client {
  sink: SseSink;
  /** Id of the last snapshot/error event this client has (or was sent). */
  lastId: string | null;
  blockedSince: number | null;
  /** Whether this connection has been told the current state (event or state ping). */
  synced: boolean;
}
interface Latest {
  id: string;
  kind: "snapshot" | "error" | "resync";
  hash: string;
  data: string;
  at: number;
}

/** Last-Event-ID values this hub could have issued; anything else is ignored. */
export const eventIdPattern = /^[a-f0-9]{8}-\d{1,12}$/;

/**
 * Server-sent-event fan-out. While at least one client is connected, one
 * computation runs on a bounded interval (sequentially, never overlapping) and
 * its result goes to every client, but only when its content hash changed.
 * With no clients there are no timers and no work.
 */
export function createLiveHub(options: LiveOptions) {
  const intervalMs = options.intervalMs ?? 1000;
  const maxIntervalMs = Math.max(
    intervalMs,
    options.maxIntervalMs ?? MAX_INTERVAL_MS,
  );
  const heartbeatMs = options.heartbeatMs ?? 15000;
  const maxClients = options.maxClients ?? 8;
  const maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
  const maxBuffered = options.maxBufferedBytes ?? 2 * MAX_EVENT_BYTES;
  const slowMs = options.slowClientMs ?? 10000;
  const retryMs = options.retryMs ?? 3000;
  const timers = options.timers ?? realTimers;
  const now = options.now ?? Date.now;
  const boot = randomBytes(4).toString("hex");
  const clients = new Set<Client>();
  let counter = 0;
  let latest: Latest | null = null;
  /** Time of the last successful computation; what heartbeats report. */
  let lastGoodAt: number | null = null;
  /** True only for a computation made while at least one client was connected throughout. */
  let fresh = false;
  /** Bumped whenever the last client leaves; a computation spanning a bump is stale. */
  let generation = 0;
  let running = false;
  let closed = false;
  let cycleTimer: unknown;
  let heartbeatTimer: unknown;

  const drop = (client: Client) => {
    if (!clients.delete(client)) return;
    client.sink.destroy();
    idleCheck();
  };
  /** Writes one frame; false when the client was dropped or is blocked. */
  const send = (client: Client, text: string) => {
    if (client.blockedSince !== null || !clients.has(client)) return false;
    // Backlog from earlier frames, then what this frame added: one frame can
    // put megabytes in the socket buffer in a single call while `write` still
    // reports success, so the length is checked after the write as well.
    if (client.sink.writableLength > maxBuffered) {
      drop(client);
      return false;
    }
    const accepted = client.sink.write(text);
    if (client.sink.writableLength > maxBuffered) {
      drop(client);
      return false;
    }
    if (!accepted) {
      client.blockedSince = now();
      client.sink.once("drain", () => {
        client.blockedSince = null;
      });
      return false;
    }
    return true;
  };
  const frame = (event: string, data: string, id?: string) =>
    `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${data}\n\n`;
  /**
   * Heartbeat. `at` is when the board was last read successfully, never the
   * time the ping was sent, so a stuck or failing computation cannot make
   * stale data look current. `id`/`kind` say which event is current so a
   * client can tell whether it already has it; they are null until the hub
   * holds a computation made while a client was connected.
   */
  const pingFrame = () =>
    frame(
      "ping",
      JSON.stringify({
        at:
          fresh && lastGoodAt !== null
            ? new Date(lastGoodAt).toISOString()
            : null,
        id: fresh && latest && latest.kind !== "resync" ? latest.id : null,
        kind: fresh && latest ? latest.kind : null,
      }),
    );
  const deliver = (client: Client) => {
    if (!latest || client.blockedSince !== null) return;
    if (client.lastId === latest.id) {
      // Nothing new, but a reconnecting client has not been told that yet.
      if (!client.synced) {
        client.synced = true;
        send(client, pingFrame());
      }
      return;
    }
    client.lastId = latest.id;
    client.synced = true;
    // A resync carries no id: a reconnect must not present it as progress.
    send(
      client,
      frame(
        latest.kind,
        latest.data,
        latest.kind === "resync" ? undefined : latest.id,
      ),
    );
  };
  const reapSlow = () => {
    for (const client of [...clients])
      if (client.blockedSince !== null && now() - client.blockedSince > slowMs)
        drop(client);
  };
  const cycle = async () => {
    if (running || closed) return;
    running = true;
    cycleTimer = undefined;
    const startedAt = now();
    const startedGeneration = generation;
    let result: { hash: string; data: string } | null;
    try {
      result = await options.compute();
    } catch {
      result = null;
    }
    running = false;
    if (closed) return;
    if (startedGeneration !== generation) {
      // Every client left while this ran, so it may predate whoever is here
      // now. Discard it and read again instead of serving it as current.
      if (clients.size > 0) void cycle();
      return;
    }
    const finishedAt = now();
    if (result === null) {
      if (latest?.kind !== "error")
        latest = {
          id: `${boot}-${++counter}`,
          kind: "error",
          hash: "error",
          data: JSON.stringify({ error: options.errorMessage }),
          at: finishedAt,
        };
      else latest.at = finishedAt;
    } else {
      lastGoodAt = finishedAt;
      if (Buffer.byteLength(result.data) > maxEventBytes) {
        // Too large to push: tell clients to keep polling. One event per
        // episode, whatever the content does while it stays too large.
        if (latest?.kind !== "resync")
          latest = {
            id: `${boot}-${++counter}`,
            kind: "resync",
            hash: "resync",
            data: JSON.stringify({
              reason: "snapshot-too-large",
              limitBytes: maxEventBytes,
            }),
            at: finishedAt,
          };
        else latest.at = finishedAt;
      } else if (latest?.kind !== "snapshot" || latest.hash !== result.hash)
        latest = {
          id: `${boot}-${++counter}`,
          kind: "snapshot",
          hash: result.hash,
          data: result.data,
          at: finishedAt,
        };
      else latest.at = finishedAt;
    }
    fresh = clients.size > 0;
    reapSlow();
    for (const client of [...clients]) deliver(client);
    if (clients.size > 0 && !closed) {
      // Slow boards are read less often: at least five times as long as the
      // last read took, within a ceiling.
      const delay = Math.min(
        maxIntervalMs,
        Math.max(intervalMs, INTERVAL_PER_COMPUTE * (finishedAt - startedAt)),
      );
      cycleTimer = timers.setTimeout(() => void cycle(), delay);
    }
  };
  const heartbeat = () => {
    reapSlow();
    const text = pingFrame();
    for (const client of [...clients]) send(client, text);
  };
  function idleCheck() {
    if (clients.size > 0) return;
    fresh = false;
    generation += 1;
    if (cycleTimer !== undefined) timers.clearTimeout(cycleTimer);
    cycleTimer = undefined;
    if (heartbeatTimer !== undefined) timers.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  return {
    get clients() {
      return clients.size;
    },
    /** False when the server is closing or at capacity (the caller answers 503). */
    canAdd: () => !closed && clients.size < maxClients,
    /** Registers an open event-stream response. Returns false when it was refused. */
    add(sink: SseSink, lastEventId?: string): boolean {
      if (!this.canAdd()) return false;
      const client: Client = {
        sink,
        lastId:
          lastEventId !== undefined && eventIdPattern.test(lastEventId)
            ? lastEventId
            : null,
        blockedSince: null,
        synced: false,
      };
      clients.add(client);
      sink.once("close", () => drop(client));
      send(client, `retry: ${retryMs}\n\n${pingFrame()}`);
      if (!clients.has(client)) return true;
      heartbeatTimer ??= timers.setInterval(heartbeat, heartbeatMs);
      // After an idle period the cache is stale: wait for a fresh computation,
      // which also tells a reconnecting client whether it missed anything.
      if (fresh && clients.has(client)) deliver(client);
      if (!running && cycleTimer === undefined) void cycle();
      return true;
    },
    /** Ends every stream and stops all timers; later `add` calls are refused. */
    close() {
      closed = true;
      for (const client of [...clients]) {
        clients.delete(client);
        client.sink.destroy();
      }
      idleCheck();
    },
  };
}
