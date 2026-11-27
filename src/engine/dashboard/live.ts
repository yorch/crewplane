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

export interface LiveOptions {
  /** One shared computation. `hash` identifies content; `data` is the JSON text sent. */
  compute: () => Promise<{ hash: string; data: string }>;
  /** Safe message sent in an `error` event when `compute` fails. */
  errorMessage: string;
  intervalMs?: number;
  heartbeatMs?: number;
  maxClients?: number;
  /** A client whose socket buffer exceeds this is dropped. */
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
}
interface Latest {
  id: string;
  kind: "snapshot" | "error";
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
  const heartbeatMs = options.heartbeatMs ?? 15000;
  const maxClients = options.maxClients ?? 8;
  const maxBuffered = options.maxBufferedBytes ?? 4 * 1024 * 1024;
  const slowMs = options.slowClientMs ?? 10000;
  const retryMs = options.retryMs ?? 3000;
  const timers = options.timers ?? realTimers;
  const now = options.now ?? Date.now;
  const boot = randomBytes(4).toString("hex");
  const clients = new Set<Client>();
  let counter = 0;
  let latest: Latest | null = null;
  let fresh = false;
  let running = false;
  let closed = false;
  let cycleTimer: unknown;
  let heartbeatTimer: unknown;

  const drop = (client: Client) => {
    if (!clients.delete(client)) return;
    client.sink.destroy();
    idleCheck();
  };
  const send = (client: Client, text: string) => {
    if (client.blockedSince !== null) return;
    if (client.sink.writableLength > maxBuffered) return drop(client);
    if (!client.sink.write(text)) {
      client.blockedSince = now();
      client.sink.once("drain", () => {
        client.blockedSince = null;
      });
    }
  };
  const frame = (event: string, data: string, id?: string) =>
    `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${data}\n\n`;
  const deliver = (client: Client) => {
    if (!latest || client.lastId === latest.id || client.blockedSince !== null)
      return;
    client.lastId = latest.id;
    send(client, frame(latest.kind, latest.data, latest.id));
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
    try {
      const result = await options.compute();
      if (!latest || latest.kind === "error" || latest.hash !== result.hash)
        latest = {
          id: `${boot}-${++counter}`,
          kind: "snapshot",
          hash: result.hash,
          data: result.data,
          at: now(),
        };
      else latest.at = now();
    } catch {
      if (latest?.kind !== "error")
        latest = {
          id: `${boot}-${++counter}`,
          kind: "error",
          hash: "error",
          data: JSON.stringify({ error: options.errorMessage }),
          at: now(),
        };
      else latest.at = now();
    }
    running = false;
    fresh = true;
    reapSlow();
    for (const client of [...clients]) deliver(client);
    if (clients.size > 0 && !closed)
      cycleTimer = timers.setTimeout(() => void cycle(), intervalMs);
  };
  const heartbeat = () => {
    reapSlow();
    const text = frame(
      "ping",
      JSON.stringify({ at: new Date(now()).toISOString() }),
    );
    for (const client of [...clients]) send(client, text);
  };
  function idleCheck() {
    if (clients.size > 0) return;
    fresh = false;
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
      };
      clients.add(client);
      sink.once("close", () => drop(client));
      send(
        client,
        `retry: ${retryMs}\n\n${frame("ping", JSON.stringify({ at: new Date(now()).toISOString() }))}`,
      );
      heartbeatTimer ??= timers.setInterval(heartbeat, heartbeatMs);
      // After an idle period the cache is stale: wait for a fresh computation,
      // which also tells a reconnecting client whether it missed anything.
      if (fresh) deliver(client);
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
