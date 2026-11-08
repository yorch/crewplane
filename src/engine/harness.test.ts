import { expect, it } from "vitest";
import {
  assertSwitch,
  consumeEvent,
  type HarnessStream,
  harnessCommand,
  harnessKey,
  validateHarness,
  validFinal,
} from "./harness.ts";

const config = {
  root: process.cwd(),
  binary: process.execPath,
  binaries: { pi: process.execPath },
};
const id = "00000000-0000-4000-8000-000000000001";
const lane = {
  harness: "pi" as const,
  piPermissions: "no-tools" as const,
  sessionEpoch: "test",
  piModel: { provider: "synthetic", id: "local" },
};
it("requires literal final-state strings instead of coercing malformed native JSON", () => {
  for (const state of ["working", "waiting", "ready", "needs_operator"]) {
    expect(validFinal({ state, summary: "Synthetic" })).toBe(true);
    for (const invalid of [[state], { state }, null, false, 0])
      expect(validFinal({ state: invalid, summary: "Synthetic" })).toBe(false);
  }
  const stream: HarnessStream = {
    inputTokens: 0,
    outputTokens: 0,
    settled: false,
    invalid: false,
  };
  consumeEvent("pi", stream, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: '{"state":["needs_operator"],"summary":"Synthetic"}',
        },
      ],
    },
  });
  expect(stream.final).toBeUndefined();
});
it("preserves Codex legacy argv and binds exact native resume to harness and epoch", () => {
  const legacy = harnessCommand(
    config,
    {},
    { sessionId: id },
    "/schema",
    "/output",
  );
  expect(legacy.args.slice(-3)).toEqual(["resume", id, "-"]);
  expect(legacy.args).toContain("--approve-for-me");
  expect(() =>
    harnessCommand(config, lane, { sessionId: id }, "/schema", "/output"),
  ).toThrow("Cross-harness");
  expect(() =>
    harnessCommand(
      config,
      {},
      { harness: "pi", sessionId: id, sessionEpoch: "test" },
      "/schema",
      "/output",
    ),
  ).toThrow("Cross-harness");
  const pi = harnessCommand(
    config,
    lane,
    { harness: "pi", sessionId: id, sessionEpoch: "test" },
    "/schema",
    "/output",
  );
  expect(pi.args.slice(-2)).toEqual(["--session", id]);
  for (const forbidden of [
    "--continue",
    "--resume",
    "--approve-for-me",
    "--approve",
    "--output-schema",
    "--output-last-message",
  ])
    expect(pi.args).not.toContain(forbidden);
  for (const safe of [
    "--no-tools",
    "--no-extensions",
    "--no-mcp",
    "--no-approve",
    "--offline",
  ])
    expect(pi.args).toContain(safe);
});
it("fails closed on unsupported permissions/models and requires drained fresh switches", () => {
  expect(() =>
    validateHarness(config, { ...lane, piPermissions: undefined } as never),
  ).toThrow();
  expect(() =>
    validateHarness(config, { ...lane, model: "codex-model" }),
  ).toThrow();
  expect(() =>
    validateHarness(config, { harness: "unknown" } as never),
  ).toThrow();
  expect(() =>
    validateHarness(config, { ...lane, sessionEpoch: "../path" }),
  ).toThrow();
  expect(() =>
    validateHarness(config, { ...lane, sessionEpoch: undefined } as never),
  ).toThrow();
  const previous = { harness: "codex" as const, status: "idle", sessionId: id };
  expect(() => assertSwitch(lane, previous, true)).toThrow("drained");
  expect(() =>
    assertSwitch(lane, { ...previous, status: "running" }, false),
  ).toThrow();
  expect(() => assertSwitch(lane, previous, false)).not.toThrow();
  expect(harnessKey(lane)).toBe(":harness:pi:epoch:test");
  expect(harnessKey({})).toBe("");
});
it("normalizes real Pi JSON event shapes, usage, model and strict settled result", () => {
  const stream: HarnessStream = {
    inputTokens: 0,
    outputTokens: 0,
    settled: false,
    invalid: false,
  };
  consumeEvent("pi", stream, { type: "session", id });
  consumeEvent("pi", stream, {
    type: "message_end",
    message: { role: "user", content: "ignore" },
  });
  consumeEvent("pi", stream, {
    type: "message_end",
    message: {
      role: "assistant",
      model: "local",
      provider: "synthetic",
      stopReason: "stop",
      usage: { input: 12, output: 8 },
      content: [
        { type: "text", text: '{"state":"waiting","summary":"Synthetic"}' },
      ],
    },
  });
  expect(stream).toMatchObject({
    sessionId: id,
    inputTokens: 12,
    outputTokens: 8,
    observedModel: "synthetic/local",
    settled: false,
    final: { state: "waiting", summary: "Synthetic" },
  });
  consumeEvent("pi", stream, { type: "agent_settled", aborted: false });
  expect(stream.settled).toBe(true);
  consumeEvent("pi", stream, {
    type: "session",
    id: "00000000-0000-4000-8000-000000000002",
  });
  expect(stream.invalid).toBe(true);
  expect(validFinal({ state: "invented", summary: "no" })).toBe(false);
  expect(validFinal({ state: "ready", summary: "ok", token: "private" })).toBe(
    false,
  );
  const codex: HarnessStream = {
    inputTokens: 0,
    outputTokens: 0,
    settled: false,
    invalid: false,
  };
  consumeEvent("codex", codex, { type: "thread.started", thread_id: id });
  consumeEvent("codex", codex, {
    type: "turn.completed",
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  expect(codex).toMatchObject({
    sessionId: id,
    inputTokens: 5,
    outputTokens: 2,
  });
});

it("rejects changed cwd/session and discards unstructured or aborted Pi results", () => {
  const stream: HarnessStream = {
    expectedCwd: "/synthetic/checkout",
    inputTokens: 0,
    outputTokens: 0,
    settled: false,
    invalid: false,
  };
  consumeEvent("pi", stream, { type: "session", id, cwd: "/foreign/checkout" });
  expect(stream.invalid).toBe(true);
  const other: HarnessStream = {
    inputTokens: 0,
    outputTokens: 0,
    settled: false,
    invalid: false,
  };
  consumeEvent("pi", other, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "not JSON" }],
    },
  });
  expect(other.final).toBeUndefined();
  consumeEvent("pi", other, { type: "agent_settled", aborted: true });
  expect(other.settled).toBe(false);
  expect(() =>
    harnessCommand(
      config,
      { ...lane, sessionEpoch: "new" },
      { harness: "pi", sessionEpoch: "test", sessionId: id },
      "/schema",
      "/output",
    ),
  ).toThrow("cross-epoch");
});
