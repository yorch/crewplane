import { expect, it } from "vitest";
import { backoffDelay, createSseParser } from "./live-core.js";

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
