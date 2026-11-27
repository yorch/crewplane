import { expect, it } from "vitest";
import {
  backoffDelay,
  createLiveSession,
  createSseParser,
  hiddenPollDelay,
  liveTuning,
  RenderFailure,
} from "./live-core.js";

it("parses events split across arbitrary chunks and line endings", () => {
  const parser = createSseParser();
  const text =
    'retry: 3000\r\n\r\nid: a-1\nevent: snapshot\ndata: {"x":1}\n\n: comment\n\ndata: one\ndata: two\n\n';
  const events = [];
  // Feed one character at a time, including a split CRLF.
  for (const char of text) events.push(...parser.feed(char));
  expect(events).toEqual([
    { event: "snapshot", data: '{"x":1}', id: "a-1" },
    { event: "message", data: "one\ntwo", id: "a-1" },
  ]);
});

it("ignores unknown fields and refuses an oversized event", () => {
  const parser = createSseParser(16);
  expect(parser.feed("foo: bar\nevent: ping\ndata: {}\n\n")).toEqual([
    { event: "ping", data: "{}", id: null },
  ]);
  expect(() => parser.feed(`data: ${"x".repeat(32)}`)).toThrow("too large");
});

it("backs off exponentially with a cap and bounded jitter", () => {
  const mid = () => 0.5;
  expect(backoffDelay(1, mid)).toBe(1000);
  expect(backoffDelay(2, mid)).toBe(2000);
  expect(backoffDelay(4, mid)).toBe(8000);
  expect(backoffDelay(50, mid)).toBe(60000);
  expect(backoffDelay(3, () => 0)).toBe(3000);
  expect(backoffDelay(3, () => 1)).toBe(5000);
  expect(backoffDelay(0, mid)).toBe(1000);
});

function session(options: { failRender?: () => boolean } = {}) {
  const log: string[] = [];
  const live = createLiveSession({
    applySnapshot: (value: { n: number }) => {
      if (options.failRender?.()) throw new Error("boom");
      log.push(`apply:${value.n}`);
    },
    markFresh: (at: string) => log.push(`fresh:${at}`),
    showDisconnected: (message: string) => log.push(`banner:${message}`),
    setMode: (mode: string) => log.push(`mode:${mode}`),
  });
  const send = (event: string, data: unknown, id: string | null = null) =>
    live.handle({ event, data: JSON.stringify(data), id });
  return { live, log, send };
}

it("is live only after a snapshot rendered, never because the stream opened or a ping arrived", () => {
  const { log, send } = session();
  send("ping", { at: "2026-01-01T00:00:00Z", id: null, kind: null });
  expect(log).toEqual([]);
  expect(send("snapshot", { n: 1 }, "a-1")).toBe("applied");
  expect(log).toEqual(["apply:1", "mode:live"]);
});

it("keeps a failed render outstanding: no advance, no fresh ping, retry from scratch", () => {
  let fail = false;
  const { live, log, send } = session({ failRender: () => fail });
  send("snapshot", { n: 1 }, "a-1");
  send("snapshot", { n: 2 }, "a-2");
  expect(live.lastEventId).toBe("a-2");
  fail = true;
  expect(() => send("snapshot", { n: 3 }, "a-3")).toThrow(RenderFailure);
  expect(live.failed).toBe(true);
  // The failed event is not remembered: a reconnect asks for everything again.
  expect(live.lastEventId).toBeNull();
  expect(log.at(-2)).toBe("mode:polling");
  expect(log.at(-1)).toMatch(/^banner:Render failed: boom/);
  const before = log.length;
  // Heartbeats naming the failed event (or any event) must not hide the banner.
  send("ping", { at: "2026-01-01T00:00:15Z", id: "a-3", kind: "snapshot" });
  send("ping", { at: "2026-01-01T00:00:15Z", id: "a-2", kind: "snapshot" });
  expect(log.length).toBe(before);
  fail = false;
  send("snapshot", { n: 3 }, "a-3");
  expect(live.failed).toBe(false);
  send("ping", { at: "2026-01-01T00:00:30Z", id: "a-3", kind: "snapshot" });
  expect(log.at(-1)).toBe("fresh:2026-01-01T00:00:30Z");
});

it("accepts a heartbeat only for the event it already shows", () => {
  const { log, send } = session();
  send("snapshot", { n: 1 }, "a-1");
  log.length = 0;
  send("ping", { at: "t1", id: "a-9", kind: "snapshot" });
  send("ping", { at: "t1", id: null, kind: null });
  send("ping", { at: null, id: "a-1", kind: "snapshot" });
  expect(log).toEqual([]);
  send("ping", { at: "t1", id: "a-1", kind: "snapshot" });
  expect(log).toEqual(["mode:live", "fresh:t1"]);
});

it("returns to live on a reconnect whose heartbeat confirms the shown snapshot", () => {
  const { log, send } = session();
  send("snapshot", { n: 1 }, "a-1");
  send("resync", { reason: "snapshot-too-large" });
  expect(log.at(-1)).toBe("mode:polling");
  send("ping", { at: "t", id: "a-1", kind: "snapshot" });
  expect(log.slice(-2)).toEqual(["mode:live", "fresh:t"]);
});

it("treats resync as stay-in-polling and an error event as an outstanding failure", () => {
  const { live, log, send } = session();
  send("snapshot", { n: 1 }, "a-1");
  send("resync", { reason: "snapshot-too-large", limitBytes: 1 });
  send("ping", { at: "t", id: null, kind: "resync" });
  expect(log.filter((l) => l === "mode:polling")).toHaveLength(2);
  expect(live.lastEventId).toBe("a-1"); // resync is not progress
  send("error", { error: "Could not read." }, "a-2");
  expect(live.failed).toBe(true);
  expect(live.lastEventId).toBe("a-2");
  const before = log.length;
  send("ping", { at: "t", id: "a-2", kind: "error" });
  expect(log.length).toBe(before);
});

it("rejects malformed events and clamps injected timings", () => {
  const { send } = session();
  expect(() =>
    createLiveSession({} as never).handle({
      event: "ping",
      data: "{",
      id: null,
    }),
  ).toThrow("Malformed");
  expect(send("message", {})).toBe("other");
  expect(liveTuning(undefined)).toMatchObject({
    stableMs: 30000,
    hiddenGraceMs: 30000,
    backoffBaseMs: 1000,
  });
  expect(
    liveTuning({ stableMs: 1e9, backoffBaseMs: "x", hiddenGraceMs: -5 }),
  ).toMatchObject({ stableMs: 30000, backoffBaseMs: 1000, hiddenGraceMs: 0 });
});

it("spreads the hidden-tab alert poll over +-20% of a 60 second default", () => {
  expect(liveTuning(undefined).hiddenPollMs).toBe(60000);
  expect(liveTuning({ hiddenPollMs: 1 }).hiddenPollMs).toBe(100);
  expect(hiddenPollDelay(60000, () => 0)).toBe(48000);
  expect(hiddenPollDelay(60000, () => 1)).toBe(72000);
  expect(hiddenPollDelay(60000, () => 0.5)).toBe(60000);
  expect(hiddenPollDelay(60000, () => Number.NaN)).toBe(48000);
  expect(hiddenPollDelay(60000, () => 9)).toBe(72000);
});
