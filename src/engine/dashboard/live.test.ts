import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createLiveHub, type LiveTimers } from "./live.ts";

/** Manually driven timers: nothing runs until a test fires it. */
function fakeTimers() {
  let next = 1;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const timers: LiveTimers = {
    setTimeout: (fn) => {
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
