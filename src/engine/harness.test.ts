import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { adapters } from "../adapters.ts";
import {
  assertSwitch,
  consumeEvent,
  finalResult,
  type HarnessStream,
  harnessCommand,
  harnessKey,
  validateHarness,
  validFinal,
  validSessionId,
} from "./harness.ts";

const config = {
  root: process.cwd(),
  binary: process.execPath,
  binaries: { pi: process.execPath },
  piSessionDirectory: "/private/synthetic/pi-sessions",
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
  expect(pi.args[pi.args.indexOf("--session-dir") + 1]).toBe(
    config.piSessionDirectory,
  );
  expect(() =>
    harnessCommand(
      { ...config, piSessionDirectory: undefined } as never,
      lane,
      { harness: "pi", sessionEpoch: "test" },
      "/schema",
      "/unrelated/runs/pi-sessions/run.result.json",
    ),
  ).toThrow("explicit absolute session directory");
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
const extended = {
  root: process.cwd(),
  binary: process.execPath,
  binaries: {
    claude: process.execPath,
    opencode: process.execPath,
    pi: process.execPath,
  },
  piSessionDirectory: "/private/synthetic/pi-sessions",
};
const schemaFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "crewplane-schema-"));
  const path = join(directory, "schema.json");
  writeFileSync(path, JSON.stringify({ type: "object" }));
  return { directory, path };
};
const emptyStream = (expectedCwd?: string): HarnessStream => ({
  ...(expectedCwd ? { expectedCwd } : {}),
  inputTokens: 0,
  outputTokens: 0,
  settled: false,
  invalid: false,
});
it("binds fresh Claude UUIDs, resumes exactly and rejects bypass or foreign sessions", () => {
  const { directory, path } = schemaFixture();
  try {
    const lane = {
      harness: "claude" as const,
      model: "opus",
      claudePermissionMode: "plan" as const,
      claudeMcp: "strict" as const,
      claudeSettingSources: ["project"] as ("user" | "project" | "local")[],
      claudeTools: ["Bash", "Read"],
      claudeAllowedTools: ["Bash(git *)"],
      claudeDisallowedTools: ["WebSearch"],
      maxCostUsdPerRun: 1,
      sessionEpoch: "claude-one",
    };
    const fresh = harnessCommand(
      extended,
      lane,
      {},
      path,
      "/private/result.json",
    );
    expect(fresh.args.slice(0, 9)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify({ type: "object" }),
      "--add-dir",
      process.cwd(),
      "--model",
    ]);
    expect(fresh.args[fresh.args.indexOf("--model") + 1]).toBe("opus");
    expect(fresh.args[fresh.args.indexOf("--permission-mode") + 1]).toBe(
      "plan",
    );
    expect(fresh.args).toContain("--strict-mcp-config");
    for (const [flag, value] of [
      ["--setting-sources", "project"],
      ["--tools", "Bash,Read"],
      ["--allowedTools", "Bash(git *)"],
      ["--disallowedTools", "WebSearch"],
      ["--max-budget-usd", "1"],
    ] as const)
      expect(fresh.args[fresh.args.indexOf(flag) + 1]).toBe(value);
    const session = fresh.args[fresh.args.indexOf("--session-id") + 1];
    expect(validSessionId("claude", session)).toBe(true);
    expect(fresh.expectedSessionId).toBe(session);
    for (const forbidden of [
      "--dangerously-skip-permissions",
      "--resume",
      "--continue",
      "--fork-session",
      "--no-session-persistence",
    ])
      expect(fresh.args).not.toContain(forbidden);
    const resumed = harnessCommand(
      extended,
      lane,
      { harness: "claude", sessionId: id, sessionEpoch: "claude-one" },
      path,
      "/private/result.json",
    );
    expect(resumed.args.slice(-2)).toEqual(["--resume", id]);
    expect(resumed.args).not.toContain("--session-id");
    expect(() =>
      harnessCommand(
        extended,
        lane,
        {
          harness: "claude",
          sessionId: "ses_foreign",
          sessionEpoch: "claude-one",
        },
        path,
        "/private/result.json",
      ),
    ).toThrow("Invalid stored");
    expect(() =>
      harnessCommand(
        extended,
        lane,
        { harness: "claude", sessionId: id, sessionEpoch: "other" },
        path,
        "/private/result.json",
      ),
    ).toThrow("cross-epoch");
    expect(() =>
      harnessCommand(
        extended,
        lane,
        {},
        join(directory, "missing.json"),
        "/private/result.json",
      ),
    ).toThrow("readable JSON result schema");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("runs OpenCode standalone JSON with explicit model, opt-in auto and prefixed resume", () => {
  const lane = {
    harness: "opencode" as const,
    model: "provider/model#variant",
    sessionEpoch: "opencode-one",
  };
  const fresh = harnessCommand(extended, lane, {}, "/schema", "/output");
  expect(fresh.args).toEqual([
    "run",
    "--standalone",
    "--format",
    "json",
    "-m",
    "provider/model#variant",
  ]);
  const auto = harnessCommand(
    extended,
    { ...lane, opencodeAuto: true },
    {},
    "/schema",
    "/output",
  );
  expect(auto.args.slice(-1)).toEqual(["--auto"]);
  const resumed = harnessCommand(
    extended,
    lane,
    {
      harness: "opencode",
      sessionId: "ses_00000000000000000000000000",
      sessionEpoch: "opencode-one",
    },
    "/schema",
    "/output",
  );
  expect(resumed.args.slice(-2)).toEqual([
    "--session",
    "ses_00000000000000000000000000",
  ]);
  expect(() =>
    harnessCommand(
      extended,
      lane,
      { harness: "opencode", sessionId: id, sessionEpoch: "opencode-one" },
      "/schema",
      "/output",
    ),
  ).toThrow("Invalid stored");
});
it("fails closed on new harness models, permissions and foreign settings", () => {
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      claudePermissionMode: "plan",
    } as never),
  ).toThrow("explicit model");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
    } as never),
  ).toThrow("permission mode");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "provider/model",
      claudePermissionMode: "plan",
    } as never),
  ).toThrow("explicit model");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "bypassPermissions",
    } as never),
  ).toThrow("permission mode");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      opencodeAuto: true,
    } as never),
  ).toThrow("Harness-specific");
  expect(() =>
    validateHarness(extended, { harness: "opencode" } as never),
  ).toThrow("provider/model");
  expect(() =>
    validateHarness(extended, {
      harness: "opencode",
      model: "unqualified",
    } as never),
  ).toThrow("provider/model");
  expect(() =>
    validateHarness(extended, {
      harness: "opencode",
      model: "provider/model",
      opencodeAuto: "yes",
    } as never),
  ).toThrow("boolean");
  expect(() =>
    validateHarness(extended, {
      harness: "opencode",
      model: "provider/model",
      claudePermissionMode: "plan",
    } as never),
  ).toThrow("Harness-specific");
  expect(() =>
    validateHarness(extended, { harness: "codex", opencodeAuto: true }),
  ).toThrow("Harness-specific");
  expect(() =>
    validateHarness(extended, {
      harness: "pi",
      piPermissions: "no-tools",
      sessionEpoch: "fixture",
      claudePermissionMode: "plan",
    } as never),
  ).toThrow("Harness-specific");
  expect(() =>
    validateHarness(
      { root: process.cwd(), binary: process.execPath },
      { harness: "claude", model: "opus", claudePermissionMode: "plan" },
    ),
  ).toThrow("Missing absolute claude binary");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeSettingSources: ["project"],
    } as never),
  ).toThrow("claudeMcp");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
    } as never),
  ).toThrow("claudeSettingSources");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["user", "user"],
    } as never),
  ).toThrow("duplicates");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["bogus"],
    } as never),
  ).toThrow("user, project or local");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["project"],
      claudeTools: ["Read"],
    } as never),
  ).toThrow("include Bash");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["project"],
      claudeDisallowedTools: ["Bash"],
    } as never),
  ).toThrow("blanket-deny");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["project"],
      claudeTools: ["-x"],
    } as never),
  ).toThrow("tool name");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["project"],
      claudeAllowedTools: ["a,b"],
    } as never),
  ).toThrow("invalid rule");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["project"],
      maxCostUsdPerRun: 0.001,
    } as never),
  ).toThrow("0.01-100");
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "opus",
      claudePermissionMode: "plan",
      claudeMcp: "strict",
      claudeSettingSources: ["project"],
      maxRunsPerHour: 61,
    } as never),
  ).toThrow("1 to 60");
  expect(() =>
    validateHarness(extended, {
      harness: "opencode",
      model: "provider/model",
      opencodeAgent: "-x",
    } as never),
  ).toThrow("agent identifier");
  expect(() =>
    validateHarness(extended, {
      harness: "opencode",
      model: "provider/model",
      maxCostUsdPerRun: 1,
    } as never),
  ).toThrow("Harness-specific");
  for (const bad of [
    "/absolute",
    "../escape",
    "a/../b",
    ".git/config",
    ".crewplane-state/x",
    "a\\b",
    "",
  ])
    expect(() =>
      validateHarness(extended, { harness: "codex", instructionsPath: bad }),
    ).toThrow("instructionsPath");
  expect(
    validateHarness(extended, {
      harness: "codex",
      instructionsPath: "docs/guide.md",
    }),
  ).toBeTruthy();
  expect(validSessionId("opencode", "ses_abc123")).toBe(true);
  expect(validSessionId("opencode", id)).toBe(false);
  expect(validSessionId("claude", "ses_abc123")).toBe(false);
  expect(validSessionId("claude", id)).toBe(true);
  expect(validSessionId("claude", "-".repeat(36))).toBe(false);
  expect(() =>
    validateHarness(extended, {
      harness: "claude",
      model: "--dangerously-skip-permissions",
      claudePermissionMode: "plan",
    }),
  ).toThrow("explicit model");
  expect(() =>
    validateHarness(extended, {
      harness: "opencode",
      model: "-x/y",
    }),
  ).toThrow("provider/model");
  expect(() =>
    validateHarness(extended, { harness: "codex", model: "--sandbox" }),
  ).toThrow("Codex model");
  for (const model of [
    "openrouter/anthropic/x",
    "ollama/llama3:8b",
    "provider/model#variant",
  ])
    expect(validateHarness(extended, { harness: "opencode", model })).toBe(
      process.execPath,
    );
});
it("normalizes probed Claude init, assistant and structured result events", () => {
  const stream = emptyStream(process.cwd());
  consumeEvent("claude", stream, {
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: id,
    model: "claude-opus-5-5",
  });
  consumeEvent("claude", stream, {
    type: "assistant",
    message: {
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", name: "Bash", input: { command: "true" } }],
    },
  });
  consumeEvent("claude", stream, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    usage: { input_tokens: 2, output_tokens: 75, cache_read_input_tokens: 9 },
    structured_output: { state: "waiting", summary: "Synthetic Claude" },
  });
  expect(stream).toMatchObject({
    sessionId: id,
    observedModel: "claude-opus-5-5",
    inputTokensKnown: true,
    outputTokensKnown: true,
    inputTokens: 2,
    outputTokens: 75,
    settled: true,
    invalid: false,
    final: { state: "waiting", summary: "Synthetic Claude" },
  });
  const foreign = emptyStream(process.cwd());
  consumeEvent("claude", foreign, {
    type: "system",
    subtype: "init",
    cwd: "/foreign/checkout",
    session_id: id,
  });
  expect(foreign.invalid).toBe(true);
  const changed = emptyStream();
  consumeEvent("claude", changed, {
    type: "system",
    subtype: "init",
    session_id: id,
  });
  consumeEvent("claude", changed, {
    type: "result",
    subtype: "success",
    session_id: "00000000-0000-4000-8000-000000000002",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  expect(changed.invalid).toBe(true);
  const failed = emptyStream();
  consumeEvent("claude", failed, {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    session_id: id,
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { state: "ready", summary: "Must not count" },
  });
  expect(failed.invalid).toBe(true);
  expect(failed.final).toBeUndefined();
  const malformed = emptyStream();
  consumeEvent("claude", malformed, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { state: ["ready"], summary: "Malformed" },
  });
  expect(malformed.settled).toBe(true);
  expect(malformed.final).toBeUndefined();
});
it("normalizes probed OpenCode steps, strict prompted results, usage and error events", () => {
  const session = "ses_00000000000000000000000000";
  const stream = emptyStream();
  consumeEvent("opencode", stream, {
    type: "step_start",
    sessionID: session,
    part: { type: "step-start" },
  });
  consumeEvent("opencode", stream, {
    type: "text",
    sessionID: session,
    part: { type: "text", text: '{"state":"ready",' },
  });
  consumeEvent("opencode", stream, {
    type: "text",
    sessionID: session,
    part: { type: "text", text: '"summary":"Synthetic OpenCode"}' },
  });
  expect(stream.final).toBeUndefined();
  consumeEvent("opencode", stream, {
    type: "step_finish",
    sessionID: session,
    part: {
      type: "step-finish",
      reason: "stop",
      tokens: { input: 4, output: 5, cache: { read: 12009, write: 84 } },
    },
  });
  expect(stream).toMatchObject({
    sessionId: session,
    inputTokensKnown: true,
    outputTokensKnown: true,
    inputTokens: 4,
    outputTokens: 5,
    settled: true,
    invalid: false,
    final: { state: "ready", summary: "Synthetic OpenCode" },
  });
  expect(stream.observedModel).toBeUndefined();
  const multi = emptyStream();
  consumeEvent("opencode", multi, { type: "step_start", sessionID: session });
  consumeEvent("opencode", multi, {
    type: "text",
    sessionID: session,
    part: { type: "text", text: "not the final result" },
  });
  consumeEvent("opencode", multi, {
    type: "step_finish",
    sessionID: session,
    part: { reason: "tool-calls", tokens: { input: 3, output: 2 } },
  });
  expect(multi.settled).toBe(false);
  expect(multi.final).toBeUndefined();
  consumeEvent("opencode", multi, { type: "step_start", sessionID: session });
  consumeEvent("opencode", multi, {
    type: "text",
    sessionID: session,
    part: { type: "text", text: '{"state":"working","summary":"Synthetic"}' },
  });
  consumeEvent("opencode", multi, {
    type: "step_finish",
    sessionID: session,
    part: { reason: "stop", tokens: { input: 1, output: 2 } },
  });
  expect(multi).toMatchObject({
    inputTokens: 4,
    outputTokens: 4,
    settled: true,
    final: { state: "working", summary: "Synthetic" },
  });
  const failed = emptyStream();
  consumeEvent("opencode", failed, {
    type: "error",
    sessionID: session,
    error: { type: "provider.no-route", message: "Model unavailable" },
  });
  expect(failed.invalid).toBe(true);
  expect(failed.final).toBeUndefined();
  const fenced = emptyStream();
  consumeEvent("opencode", fenced, { type: "step_start", sessionID: session });
  consumeEvent("opencode", fenced, {
    type: "text",
    sessionID: session,
    part: {
      type: "text",
      text: '```json\n{"state":"ready","summary":"Fenced"}\n```',
    },
  });
  consumeEvent("opencode", fenced, {
    type: "step_finish",
    sessionID: session,
    part: { reason: "stop", tokens: { input: 1, output: 1 } },
  });
  expect(fenced.settled).toBe(true);
  expect(fenced.final).toBeUndefined();
  const changed = emptyStream();
  consumeEvent("opencode", changed, { type: "step_start", sessionID: session });
  consumeEvent("opencode", changed, {
    type: "step_start",
    sessionID: "ses_00000000000000000000000001",
  });
  expect(changed.invalid).toBe(true);
});
it("resolves Codex results from its output file and stream harnesses from native events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewplane-final-"));
  try {
    const output = join(directory, "result.json");
    writeFileSync(
      output,
      JSON.stringify({ state: "ready", summary: "Synthetic Codex" }),
    );
    expect(await finalResult("codex", emptyStream(), output)).toEqual({
      final: { state: "ready", summary: "Synthetic Codex" },
      persist: false,
    });
    expect(
      await finalResult("codex", emptyStream(), join(directory, "absent")),
    ).toEqual({ final: undefined, persist: false });
    const settled: HarnessStream = {
      ...emptyStream(),
      sessionId: "ses_00000000000000000000000000",
      settled: true,
      final: { state: "waiting", summary: "Synthetic" },
    };
    for (const harness of ["pi", "claude", "opencode"] as const)
      expect(await finalResult(harness, settled, output)).toEqual({
        final: { state: "waiting", summary: "Synthetic" },
        persist: true,
      });
    expect(
      await finalResult("opencode", { ...settled, invalid: true }, output),
    ).toEqual({ final: undefined, persist: true });
    expect(
      await finalResult("claude", { ...settled, settled: false }, output),
    ).toEqual({ final: undefined, persist: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("fails closed on missing Claude init, unpinned sessions and post-stop work", () => {
  const noInit = emptyStream(process.cwd());
  consumeEvent("claude", noInit, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { state: "ready", summary: "No init" },
  });
  expect(noInit.invalid).toBe(true);
  expect(noInit.final).toBeUndefined();
  const unpinned = emptyStream();
  unpinned.expectedSessionId = "00000000-0000-4000-8000-000000000009";
  consumeEvent("claude", unpinned, {
    type: "system",
    subtype: "init",
    session_id: id,
    cwd: process.cwd(),
  });
  expect(unpinned.invalid).toBe(true);
  const missingErrorFlag = emptyStream();
  consumeEvent("claude", missingErrorFlag, {
    type: "result",
    subtype: "success",
    session_id: id,
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { state: "ready", summary: "No flag" },
  });
  expect(missingErrorFlag.invalid).toBe(true);
  const subagent = emptyStream();
  consumeEvent("claude", subagent, {
    type: "system",
    subtype: "init",
    session_id: id,
    model: "claude-opus-5-5",
  });
  consumeEvent("claude", subagent, {
    type: "assistant",
    parent_tool_use_id: "toolu_1",
    message: { model: "claude-haiku-5-5" },
  });
  expect(subagent.observedModel).toBe("claude-opus-5-5");
  const usageOnce = emptyStream();
  consumeEvent("claude", usageOnce, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    usage: { input_tokens: 10, output_tokens: 4 },
    structured_output: { state: "working", summary: "One" },
  });
  consumeEvent("claude", usageOnce, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    usage: {},
    structured_output: { state: "ready", summary: "Two" },
  });
  expect(usageOnce.inputTokens).toBe(10);
  expect(usageOnce.outputTokens).toBe(4);
  consumeEvent("claude", usageOnce, {
    type: "assistant",
    message: { model: "claude-opus-5-5", content: [] },
  });
  expect(usageOnce.settled).toBe(false);
  expect(usageOnce.final).toBeUndefined();
  const resumed = emptyStream();
  consumeEvent("opencode", resumed, {
    type: "step_start",
    sessionID: "ses_00000000000000000000000000",
  });
  consumeEvent("opencode", resumed, {
    type: "text",
    sessionID: "ses_00000000000000000000000000",
    part: { type: "text", text: '{"state":"ready","summary":"Early"}' },
  });
  consumeEvent("opencode", resumed, {
    type: "step_finish",
    sessionID: "ses_00000000000000000000000000",
    part: { reason: "stop", tokens: { input: 1, output: 1 } },
  });
  expect(resumed.final).toEqual({ state: "ready", summary: "Early" });
  consumeEvent("opencode", resumed, {
    type: "step_start",
    sessionID: "ses_00000000000000000000000000",
  });
  expect(resumed.settled).toBe(false);
  expect(resumed.final).toBeUndefined();
  consumeEvent("opencode", resumed, {
    type: "text",
    sessionID: "ses_00000000000000000000000000",
    part: { type: "text", text: '{"state":"working","summary":"More"}' },
  });
  expect(resumed.settled).toBe(false);
  expect(resumed.final).toBeUndefined();
  const anonymous = emptyStream();
  consumeEvent("opencode", anonymous, {
    type: "text",
    part: { type: "text", text: '{"state":"ready","summary":"Anonymous"}' },
  });
  expect(anonymous.invalid).toBe(true);
  expect(anonymous.sessionId).toBeUndefined();
});
it("declares native versus prompted results consistently with prompt suffixes", () => {
  expect(adapters.codex.capabilities.structuredResult).toBe("native");
  expect(adapters.claude.capabilities.structuredResult).toBe("native");
  expect(adapters.pi.capabilities.structuredResult).toBe("prompted");
  expect(adapters.opencode.capabilities.structuredResult).toBe("prompted");
  expect(adapters.codex.promptSuffix).toBeUndefined();
  expect(adapters.claude.promptSuffix).toBeUndefined();
  expect(adapters.pi.promptSuffix).toContain("Return ONLY");
  expect(adapters.opencode.promptSuffix).toContain("Return ONLY");
  expect(adapters.claude.strictStream).toBe(true);
  expect(adapters.opencode.strictStream).toBe(true);
  expect(adapters.codex.strictStream).toBeUndefined();
  expect(adapters.claude.capabilities.observedCwd).toBe(true);
  expect(adapters.opencode.capabilities.observedModel).toBe(false);
});
it("records Claude denials, per-invocation cost and the native budget error", () => {
  const stream = emptyStream();
  consumeEvent("claude", stream, {
    type: "system",
    subtype: "init",
    session_id: id,
    cwd: process.cwd(),
  });
  consumeEvent("claude", stream, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    usage: { input_tokens: 2, output_tokens: 3 },
    permission_denials: [{ tool_name: "Bash" }, { tool_name: "Edit" }],
    total_cost_usd: 0.42,
    structured_output: { state: "ready", summary: "Denied" },
  });
  expect(stream.permissionDenialsKnown).toBe(true);
  expect(stream.permissionDenials).toBe(2);
  expect(stream.costKnown).toBe(true);
  expect(stream.reportedCostUsd).toBe(0.42);
  const budget = emptyStream();
  consumeEvent("claude", budget, {
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: true,
    session_id: id,
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0.06,
  });
  expect(budget.budgetExceeded).toBe(true);
  expect(budget.invalid).toBe(true);
  expect(budget.costKnown).toBe(true);
  expect(budget.reportedCostUsd).toBe(0.06);
  const missing = emptyStream();
  consumeEvent("claude", missing, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: id,
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { state: "ready", summary: "Unknown denials" },
  });
  expect(missing.permissionDenialsKnown).toBeUndefined();
  expect(missing.permissionDenials).toBeUndefined();
});
it("sums OpenCode per-step reported cost without treating it as billing", () => {
  const session = "ses_00000000000000000000000000";
  const stream = emptyStream();
  consumeEvent("opencode", stream, { type: "step_start", sessionID: session });
  consumeEvent("opencode", stream, {
    type: "step_finish",
    sessionID: session,
    part: {
      reason: "tool-calls",
      tokens: { input: 1, output: 1 },
      cost: 0.25,
    },
  });
  consumeEvent("opencode", stream, {
    type: "step_finish",
    sessionID: session,
    part: { reason: "stop", tokens: { input: 1, output: 1 }, cost: 0.5 },
  });
  expect(stream.costKnown).toBe(true);
  expect(stream.reportedCostUsd).toBeCloseTo(0.75);
  expect(stream.reportedCostUsd).toBeLessThan(1e6);
});
