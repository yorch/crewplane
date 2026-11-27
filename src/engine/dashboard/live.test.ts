import { EventEmitter } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { MAX_EVENT_CHARS } from "./app/live-core.js";
import {
  createLiveHub,
  type LiveTimers,
  MAX_EVENT_BYTES,
  MAX_INTERVAL_MS,
} from "./live.ts";

/** Manually driven timers: nothing runs until a test fires it. */
function fakeTimers() {
  let next = 1;
  const timeouts = new Map<number, () => void>();
  const delays: number[] = [];
  const intervals = new Map<number, () => void>();
  const timers: LiveTimers = {
    setTimeout: (fn, ms) => {
      delays.push(ms);
      timeouts.set(next, fn);
      return next++;
    },
    clearTimeout: (h) => void timeouts.delete(h as number),
    setInterval: (fn) => {
      intervals.set(next, fn);
      return next++;
    },
    clearInterval: (h) => void intervals.delete(h as number),
  };
  return {
    timers,
    delays,
    active: () => timeouts.size + intervals.size,
    fireTimeouts: () => {
      for (const [id, fn] of [...timeouts]) {
        timeouts.delete(id);
        fn();
      }
    },
    fireIntervals: () => {
      for (const fn of [...intervals.values()]) fn();
    },
  };
}

class FakeSink extends EventEmitter {
  chunks: string[] = [];
  writableLength = 0;
  destroyed = false;
  accept = true;
  write(chunk: string) {
    this.chunks.push(chunk);
    return this.accept;
  }
  end() {
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
  text() {
    return this.chunks.join("");
  }
  events(name: string) {
    return this.text()
      .split("\n\n")
      .filter((frame) => frame.includes(`event: ${name}\n`));
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(
  overrides: {
    values?: Array<string | Error>;
    maxClients?: number;
    slowClientMs?: number;
    maxBufferedBytes?: number;
  } = {},
) {
  const clock = fakeTimers();
  let now = 1_000_000;
  const values = overrides.values ?? ["a"];
  let calls = 0;
  const hub = createLiveHub({
    timers: clock.timers,
    now: () => now,
    errorMessage: "Could not read coordination data.",
    maxClients: overrides.maxClients ?? 8,
    ...(overrides.slowClientMs ? { slowClientMs: overrides.slowClientMs } : {}),
    ...(overrides.maxBufferedBytes
      ? { maxBufferedBytes: overrides.maxBufferedBytes }
      : {}),
    compute: async () => {
      const value = values[Math.min(calls++, values.length - 1)] as
        | string
        | Error;
      if (value instanceof Error) throw value;
      return { hash: value, data: JSON.stringify({ content: value }) };
    },
  });
  return {
    hub,
    clock,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
    setValues: (next: Array<string | Error>) => {
      values.splice(0, values.length, ...next);
      calls = 0;
    },
  };
}

describe("live hub", () => {
  it("sends a retry hint, an immediate ping and the first snapshot with an id", async () => {
    const h = harness();
    const sink = new FakeSink();
    expect(h.hub.add(sink)).toBe(true);
    await settle();
    expect(sink.text()).toMatch(/^retry: 3000\n\nevent: ping\ndata: \{"at":/);
    const [snapshot] = sink.events("snapshot");
    expect(snapshot).toMatch(/^id: [a-f0-9]{8}-1\n/);
    expect(snapshot).toContain('data: {"content":"a"}');
  });

  it("computes once for many clients and pushes only when content changes", async () => {
    const h = harness({ values: ["a", "a", "b", "b"] });
    const one = new FakeSink();
    const two = new FakeSink();
    h.hub.add(one);
    h.hub.add(two);
    await settle();
    expect(h.calls()).toBe(1);
    h.clock.fireTimeouts();
    await settle();
    expect(h.calls()).toBe(2);
    expect(one.events("snapshot")).toHaveLength(1); // unchanged: no push
    h.clock.fireTimeouts();
    await settle();
    expect(one.events("snapshot")).toHaveLength(2);
    expect(two.events("snapshot")).toHaveLength(2);
    expect(one.events("snapshot")[1]).toContain('"content":"b"');
    h.clock.fireTimeouts();
    await settle();
    expect(one.events("snapshot")).toHaveLength(2);
  });

  it("gives a late joiner the cached snapshot without recomputing", async () => {
    const h = harness();
    h.hub.add(new FakeSink());
    await settle();
    const late = new FakeSink();
    h.hub.add(late);
    expect(late.events("snapshot")).toHaveLength(1);
    expect(h.calls()).toBe(1);
  });

  it("sends heartbeats from one shared interval", async () => {
    const h = harness();
    const sink = new FakeSink();
    h.hub.add(sink);
    await settle();
    const before = sink.events("ping").length;
    h.clock.fireIntervals();
    h.clock.fireIntervals();
    expect(sink.events("ping").length).toBe(before + 2);
  });

  it("skips the snapshot when Last-Event-ID is current and resends when it is not", async () => {
    const h = harness();
    const first = new FakeSink();
    h.hub.add(first);
    await settle();
    const id = /^id: (.+)$/m.exec(first.events("snapshot")[0] ?? "")?.[1] ?? "";
    first.destroy();
    expect(h.clock.active()).toBe(0);
    const reconnect = new FakeSink();
    h.hub.add(reconnect, id);
    await settle();
    expect(reconnect.events("snapshot")).toHaveLength(0);
    expect(reconnect.events("ping").length).toBeGreaterThan(0);
    const stale = new FakeSink();
    h.hub.add(stale, "deadbeef-1");
    expect(stale.events("snapshot")).toHaveLength(1);
    const junk = new FakeSink();
    h.hub.add(junk, "<script>");
    expect(junk.events("snapshot")).toHaveLength(1);
  });

  it("refuses clients beyond the limit and accepts again after a disconnect", async () => {
    const h = harness({ maxClients: 2 });
    const sinks = [new FakeSink(), new FakeSink(), new FakeSink()];
    expect(h.hub.add(sinks[0] as FakeSink)).toBe(true);
    expect(h.hub.add(sinks[1] as FakeSink)).toBe(true);
    expect(h.hub.canAdd()).toBe(false);
    expect(h.hub.add(sinks[2] as FakeSink)).toBe(false);
    expect(sinks[2]?.chunks).toEqual([]);
    sinks[0]?.destroy();
    expect(h.hub.add(sinks[2] as FakeSink)).toBe(true);
    await settle();
  });

  it("keeps the stream and reports a safe error event, then recovers", async () => {
    const secret = new Error("EACCES /home/someone/secret-path");
    const h = harness({ values: ["a", secret, secret, "a"] });
    const sink = new FakeSink();
    h.hub.add(sink);
    await settle();
    h.clock.fireTimeouts();
    await settle();
    h.clock.fireTimeouts();
    await settle();
    const errors = sink.events("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Could not read coordination data.");
    expect(sink.text()).not.toContain("secret-path");
    expect(sink.destroyed).toBe(false);
    h.clock.fireTimeouts();
    await settle();
    // Recovery re-sends the (unchanged) snapshot so the client clears its banner.
    expect(sink.events("snapshot")).toHaveLength(2);
  });

  it("drops a client whose buffer overflows and one that stays blocked too long", async () => {
    const h = harness({
      values: ["a", "b", "c", "d"],
      slowClientMs: 5000,
      maxBufferedBytes: 100,
    });
    const flooded = new FakeSink();
    h.hub.add(flooded);
    await settle();
    flooded.writableLength = 1000;
    h.clock.fireTimeouts();
    await settle();
    expect(flooded.destroyed).toBe(true);
    expect(h.hub.clients).toBe(0);
    expect(h.clock.active()).toBe(0);

    const slow = new FakeSink();
    slow.accept = false; // write() reports backpressure and never drains
    const healthy = new FakeSink();
    h.setValues(["e", "f", "g"]);
    h.hub.add(slow);
    h.hub.add(healthy);
    await settle();
    expect(slow.destroyed).toBe(false);
    const writesWhileBlocked = slow.chunks.length;
    h.clock.fireTimeouts();
    await settle();
    expect(slow.chunks.length).toBe(writesWhileBlocked); // coalesced, not queued
    h.advance(6000);
    h.clock.fireIntervals();
    expect(slow.destroyed).toBe(true);
    expect(healthy.destroyed).toBe(false);
    expect(h.hub.clients).toBe(1);
  });

  it("resumes a blocked client after drain with only the latest event", async () => {
    const h = harness({ values: ["a", "b", "c"] });
    const sink = new FakeSink();
    sink.accept = false;
    h.hub.add(sink);
    await settle();
    h.clock.fireTimeouts();
    await settle();
    h.clock.fireTimeouts();
    await settle();
    sink.accept = true;
    sink.emit("drain");
    h.clock.fireTimeouts();
    await settle();
    // The missed intermediate snapshots were coalesced into the latest one.
    expect(sink.events("snapshot")).toHaveLength(1);
    expect(sink.events("snapshot")[0]).toContain('"content":"c"');
  });

  it("leaves no timers when the last client leaves or the hub closes", async () => {
    const h = harness();
    const one = new FakeSink();
    const two = new FakeSink();
    h.hub.add(one);
    h.hub.add(two);
    await settle();
    expect(h.clock.active()).toBeGreaterThan(0);
    one.destroy();
    expect(h.clock.active()).toBeGreaterThan(0);
    two.destroy();
    expect(h.clock.active()).toBe(0);
    const three = new FakeSink();
    h.hub.add(three);
    await settle();
    h.hub.close();
    expect(three.destroyed).toBe(true);
    expect(h.clock.active()).toBe(0);
    expect(h.hub.add(new FakeSink())).toBe(false);
  });

  it("does not start work while no client is connected", async () => {
    const h = harness();
    await settle();
    expect(h.calls()).toBe(0);
    expect(h.clock.active()).toBe(0);
  });
});

const pings = (sink: FakeSink) =>
  sink.events("ping").map(
    (f) =>
      JSON.parse(/^data: (.+)$/m.exec(f)?.[1] ?? "null") as {
        at: string | null;
        id: string | null;
        kind: string | null;
      },
  );

/** A hub whose computation the test resolves by hand. */
function manual() {
  const clock = fakeTimers();
  let now = 5_000_000;
  const waiting: Array<(value: { hash: string; data: string }) => void> = [];
  const failing: Array<(error: Error) => void> = [];
  let calls = 0;
  const hub = createLiveHub({
    timers: clock.timers,
    now: () => now,
    errorMessage: "unreadable",
    compute: () =>
      new Promise((resolve, reject) => {
        calls += 1;
        waiting.push(resolve);
        failing.push(reject);
      }),
  });
  return {
    hub,
    clock,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    resolve: async (hash: string, data = JSON.stringify({ hash })) => {
      waiting.shift()?.({ hash, data });
      failing.shift();
      await settle();
    },
    reject: async () => {
      failing.shift()?.(new Error("boom"));
      waiting.shift();
      await settle();
    },
  };
}

describe("live hub: stale cache after idle", () => {
  it("never serves a computation that spans the last client leaving to a later joiner", async () => {
    const h = manual();
    const first = new FakeSink();
    h.hub.add(first);
    await h.resolve("v1");
    first.destroy(); // idle: cache must not be trusted any more
    const second = new FakeSink();
    h.hub.add(second); // starts a computation that has not finished
    expect(h.calls()).toBe(2);
    second.destroy(); // idle again while it is in flight
    await h.resolve("v2"); // finishes after everyone left: must not become fresh
    const late = new FakeSink();
    h.hub.add(late);
    // Nothing from before the last client left may be served as current.
    expect(late.events("snapshot")).toHaveLength(0);
    expect(h.calls()).toBe(3);
    await h.resolve("v3");
    expect(late.events("snapshot")).toHaveLength(1);
    expect(late.events("snapshot")[0]).toContain('"hash":"v3"');
  });

  it("re-reads when a client joined during a computation that predates it", async () => {
    const h = manual();
    const first = new FakeSink();
    h.hub.add(first);
    first.destroy();
    const joined = new FakeSink();
    h.hub.add(joined);
    expect(h.calls()).toBe(1);
    await h.resolve("old"); // started before `joined` could have been counted... but after idle
    expect(joined.events("snapshot")).toHaveLength(0);
    expect(h.calls()).toBe(2);
    await h.resolve("new");
    expect(joined.events("snapshot")[0]).toContain('"hash":"new"');
  });
});

describe("live hub: replayed snapshot body", () => {
  it("replays the newest body for unchanged content, so a joiner never gets an earlier read time", async () => {
    const h = manual();
    const first = new FakeSink();
    h.hub.add(first);
    await h.resolve("same", JSON.stringify({ updatedAt: "T1" }));
    h.clock.fireTimeouts();
    await h.resolve("same", JSON.stringify({ updatedAt: "T2" }));
    // Same content: no second event for the connected client.
    expect(first.events("snapshot")).toHaveLength(1);
    const joined = new FakeSink();
    h.hub.add(joined);
    expect(joined.events("snapshot")).toHaveLength(1);
    expect(joined.events("snapshot")[0]).toContain('"updatedAt":"T2"');
  });
});

describe("live hub: heartbeat semantics", () => {
  it("reports the time of the last successful read, not the time of the ping", async () => {
    const h = manual();
    const sink = new FakeSink();
    h.hub.add(sink);
    const readAt = h.now();
    await h.resolve("a");
    h.advance(60_000);
    h.clock.fireTimeouts(); // next read starts and never finishes
    h.advance(60_000);
    h.clock.fireIntervals();
    const beat = pings(sink).at(-1);
    expect(beat?.at).toBe(new Date(readAt).toISOString());
    expect(beat?.kind).toBe("snapshot");
    expect(beat?.id).toMatch(/^[a-f0-9]{8}-1$/);
  });

  it("carries no time before the first successful read and none for a failing board", async () => {
    const h = manual();
    const sink = new FakeSink();
    h.hub.add(sink);
    expect(pings(sink)[0]).toEqual({ at: null, id: null, kind: null });
    h.clock.fireIntervals();
    expect(pings(sink).at(-1)?.at).toBeNull();
    await h.reject();
    h.clock.fireIntervals();
    expect(pings(sink).at(-1)).toMatchObject({ at: null, kind: "error" });
  });

  it("tells a reconnecting client that it is current once the first read confirms it", async () => {
    const h = manual();
    const first = new FakeSink();
    h.hub.add(first);
    await h.resolve("a");
    const id = /^id: (.+)$/m.exec(first.events("snapshot")[0] ?? "")?.[1];
    first.destroy();
    const again = new FakeSink();
    h.hub.add(again, id);
    expect(pings(again).at(-1)?.kind).toBeNull();
    await h.resolve("a");
    expect(again.events("snapshot")).toHaveLength(0);
    expect(pings(again).at(-1)).toMatchObject({ id, kind: "snapshot" });
    expect(pings(again).at(-1)?.at).toEqual(expect.any(String));
  });
});

describe("live hub: adaptive interval", () => {
  it("waits at least five times as long as the last read took, up to a ceiling", async () => {
    const h = manual();
    h.hub.add(new FakeSink());
    h.advance(3000); // the read took 3s
    await h.resolve("a");
    expect(h.clock.delays.at(-1)).toBe(15000);
    h.clock.fireTimeouts();
    h.advance(100); // fast read: back to the configured 1s
    await h.resolve("a");
    expect(h.clock.delays.at(-1)).toBe(1000);
    h.clock.fireTimeouts();
    h.advance(60_000);
    await h.resolve("a");
    expect(h.clock.delays.at(-1)).toBe(MAX_INTERVAL_MS);
  });
});

describe("live hub: oversized snapshots", () => {
  const big = (n: number) => JSON.stringify({ pad: "x".repeat(n) });
  it("sends one data-free resync instead of the snapshot, then recovers when it fits", async () => {
    const clock = fakeTimers();
    const sizes = [20, 200, 300, 20];
    let calls = 0;
    const hub = createLiveHub({
      timers: clock.timers,
      errorMessage: "x",
      maxEventBytes: 100,
      compute: async () => {
        const n = sizes[Math.min(calls++, sizes.length - 1)] as number;
        return { hash: `h${calls}`, data: big(n) };
      },
    });
    const sink = new FakeSink();
    hub.add(sink);
    await settle();
    expect(sink.events("snapshot")).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      clock.fireTimeouts();
      await settle();
    }
    expect(sink.events("snapshot")).toHaveLength(1);
    const resyncs = sink.events("resync");
    expect(resyncs).toHaveLength(1); // once per episode, not per change
    expect(resyncs[0]).not.toMatch(/^id:/m);
    expect(resyncs[0]).toContain("snapshot-too-large");
    expect(sink.text()).not.toContain("x".repeat(100));
    expect(pings(sink).length).toBeGreaterThan(0);
    expect(sink.destroyed).toBe(false);
    clock.fireTimeouts();
    await settle();
    expect(sink.events("snapshot")).toHaveLength(2);
  });

  it("answers a late joiner and a reconnect with resync while the board stays too large", async () => {
    const clock = fakeTimers();
    const hub = createLiveHub({
      timers: clock.timers,
      errorMessage: "x",
      maxEventBytes: 100,
      compute: async () => ({ hash: "h", data: big(500) }),
    });
    hub.add(new FakeSink());
    await settle();
    const late = new FakeSink();
    hub.add(late, "deadbeef-1");
    expect(late.events("resync")).toHaveLength(1);
    expect(late.events("snapshot")).toHaveLength(0);
  });

  it("keeps the client parser limit above the largest event the server sends", () => {
    expect(MAX_EVENT_CHARS).toBeGreaterThan(MAX_EVENT_BYTES);
  });
});

describe("live hub: buffered-bytes limit on a real socket", () => {
  it("closes a client whose unflushed frame exceeds the limit, long before the slow-client timeout", async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    const client = connect(port, "127.0.0.1");
    client.pause(); // never reads: the kernel buffers fill, the rest queues in node
    client.on("error", () => {});
    await new Promise((done) => client.once("connect", done));
    while (sockets.length === 0) await settle();
    const [socket] = sockets as [Socket];
    const clock = fakeTimers();
    const hub = createLiveHub({
      timers: clock.timers,
      errorMessage: "x",
      maxBufferedBytes: 256 * 1024,
      slowClientMs: 3_600_000,
      compute: async () => ({
        hash: "big",
        data: JSON.stringify({ pad: "x".repeat(32 * 1024 * 1024) }),
      }),
      maxEventBytes: 64 * 1024 * 1024,
    });
    try {
      hub.add(socket);
      for (let i = 0; i < 100 && hub.clients > 0; i++)
        await new Promise((done) => setTimeout(done, 20));
      expect(hub.clients).toBe(0);
      expect(socket.destroyed).toBe(true);
    } finally {
      hub.close();
      client.destroy();
      server.close();
    }
  });
});
