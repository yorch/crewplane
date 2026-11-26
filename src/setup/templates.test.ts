import { describe, expect, it } from "vitest";
import { decodeConfig } from "./install.ts";
import {
  acceptModel,
  acceptPiModel,
  buildConfig,
  defaultClaudeSettings,
  defaultLimits,
  parseCost,
  parseLimit,
  parsePermissionMode,
  parseTaskIds,
  roleHarnesses,
  type SetupAnswers,
  SetupError,
  type SetupPolicy,
  type Template,
} from "./templates.ts";

// Any real absolute executable satisfies validateConfig's existence check.
const exe = process.execPath;
const policy: SetupPolicy = {
  coordinator: "captain",
  reviewers: ["inspector", "visual"],
  reviewerRoles: { inspector: "code", visual: "visual" },
};
const answers = (
  template: Template,
  extra: Partial<SetupAnswers> = {},
): SetupAnswers => {
  const roles = roleHarnesses(template);
  const used = [...new Set(Object.values(roles))];
  return {
    roles,
    binaries: Object.fromEntries(used.map((h) => [h, exe])),
    models: {
      claude: "opus",
      opencode: "opencode-go/claude-haiku-5-5#high",
    },
    claude: { ...defaultClaudeSettings },
    allowedTasks: ["CP-101", "CP-102"],
    implementers: ["builder"],
    limits: defaultLimits(),
    confirmedStoppedAt: "2026-11-08T00:00:00.000Z",
    ...extra,
  };
};
const decode = (config: Record<string, unknown>) =>
  decodeConfig(config, { root: process.cwd(), policy });

describe("every template yields a configuration validateConfig accepts", () => {
  for (const template of ["codex", "claude", "opencode", "mixed"] as const)
    it(template, () => {
      const { config } = buildConfig(answers(template), policy);
      const decoded = decode(config);
      expect(Object.keys(decoded.lanes)).toEqual([
        "captain",
        "builder",
        "inspector",
        "visual",
      ]);
      // Enablement: only the visual reviewer starts disabled.
      expect(
        Object.entries(decoded.lanes).map(([id, l]) => [id, l.enabled]),
      ).toEqual([
        ["captain", true],
        ["builder", true],
        ["inspector", true],
        ["visual", false],
      ]);
      expect(decoded.allowedTasks).toEqual(["CP-101", "CP-102"]);
    });
});

it("codex emits only the legacy binary and bare lanes", () => {
  const { config } = buildConfig(
    answers("codex", { models: { codex: "gpt-x.1" } }),
    policy,
  );
  expect(config.binary).toBe(exe);
  expect("binaries" in config).toBe(false);
  expect(config.lanes).toEqual({
    captain: { enabled: true, harness: "codex", model: "gpt-x.1" },
    builder: { enabled: true, harness: "codex", model: "gpt-x.1" },
    inspector: { enabled: true, harness: "codex", model: "gpt-x.1" },
    visual: { enabled: false, harness: "codex", model: "gpt-x.1" },
  });
});

it("claude emits explicit isolation and a cost cap on every lane", () => {
  const { config } = buildConfig(answers("claude"), policy);
  const lanes = config.lanes as Record<string, Record<string, unknown>>;
  expect(lanes.builder).toEqual({
    enabled: true,
    harness: "claude",
    model: "opus",
    claudePermissionMode: "acceptEdits",
    claudeMcp: "strict",
    claudeSettingSources: ["project"],
    maxCostUsdPerRun: 2,
  });
  expect(lanes.captain?.claudePermissionMode).toBe("plan");
  expect(lanes.inspector?.claudePermissionMode).toBe("plan");
  expect(config.binaries).toEqual({ claude: exe });
});

it("mixed puts Claude on coordinator and implementers and OpenCode on reviewers", () => {
  const { config, notes } = buildConfig(answers("mixed"), policy);
  const lanes = config.lanes as Record<string, Record<string, unknown>>;
  expect(lanes.captain?.harness).toBe("claude");
  expect(lanes.builder?.harness).toBe("claude");
  expect(lanes.inspector).toEqual({
    enabled: true,
    harness: "opencode",
    model: "opencode-go/claude-haiku-5-5#high",
  });
  expect(config.binaries).toEqual({ claude: exe, opencode: exe });
  expect(notes.join("\n")).toContain("OpenCode lanes use");
});

it("mixed with Pi reviewers emits no-tools lanes with a fresh epoch", () => {
  const roles = roleHarnesses("mixed", "pi");
  const { config } = buildConfig(
    answers("mixed", {
      roles,
      binaries: { claude: exe, pi: exe },
      sessionEpoch: "setup-abc123",
      piModel: { provider: "prov", id: "m1" },
    }),
    policy,
  );
  expect((config.lanes as Record<string, unknown>).inspector).toEqual({
    enabled: true,
    harness: "pi",
    piPermissions: "no-tools",
    sessionEpoch: "setup-abc123",
    piModel: { provider: "prov", id: "m1" },
  });
  decode(config);
});

it("omits confirmedStoppedAt unless confirmed and says what to do", () => {
  const { confirmedStoppedAt: _drop, ...rest } = answers("codex");
  const { config, notes } = buildConfig(rest, policy);
  expect("confirmedStoppedAt" in config).toBe(false);
  expect(notes[0]).toMatch(/confirmedStoppedAt is omitted/);
  // The engine itself requires the field, so an unconfirmed file is not yet installable.
  expect(() => decode(config)).toThrow(/Confirm old harnesses stopped/);
});

describe("negative cases", () => {
  it("rejects bypass permission modes", () => {
    expect(() => parsePermissionMode("bypassPermissions")).toThrow(
      /bypass and manual modes are unavailable/,
    );
    expect(() => parsePermissionMode("default")).toThrow(SetupError);
  });
  it("rejects a missing Claude or OpenCode model", () => {
    expect(() =>
      buildConfig(answers("claude", { models: {} }), policy),
    ).toThrow(/Claude requires an explicit model/);
    expect(() =>
      buildConfig(answers("opencode", { models: {} }), policy),
    ).toThrow(/explicit provider\/model/);
  });
  it("rejects malformed OpenCode models", () => {
    for (const bad of ["haiku", "a/", "/b", "a b/c", "a/b#"])
      expect(() => acceptModel("opencode", bad), bad).toThrow(
        /provider\/model/,
      );
    expect(acceptModel("opencode", "p/m#v")).toBe("p/m#v");
  });
  it("rejects Pi as coordinator or implementer", () => {
    const roles = { ...roleHarnesses("mixed"), implementer: "pi" as const };
    expect(() =>
      buildConfig(
        answers("mixed", { roles, binaries: { claude: exe, pi: exe } }),
        policy,
      ),
    ).toThrow(/Pi may only be a reviewer/);
    expect(() =>
      buildConfig(
        answers("mixed", {
          roles: { ...roleHarnesses("mixed"), coordinator: "pi" },
          binaries: { claude: exe, pi: exe },
        }),
        policy,
      ),
    ).toThrow(/Pi may only be a reviewer/);
  });
  it("rejects relative binaries", () => {
    expect(() =>
      buildConfig(
        answers("codex", { binaries: { codex: "bin/codex" } }),
        policy,
      ),
    ).toThrow(/absolute codex binary/);
  });
  it("rejects duplicate or invalid task IDs", () => {
    expect(() => parseTaskIds("CP-1,CP-1")).toThrow(/duplicate/);
    expect(() => parseTaskIds("CP-1,../x")).toThrow(/invalid value/);
    expect(() => parseTaskIds(" , ")).toThrow(/at least one/);
    expect(() =>
      buildConfig(answers("codex", { allowedTasks: ["A", "A"] }), policy),
    ).toThrow(/valid and distinct/);
  });
  it("rejects implementer IDs that collide with policy lanes", () => {
    expect(() =>
      buildConfig(answers("codex", { implementers: ["inspector"] }), policy),
    ).toThrow(/must differ/);
    expect(() =>
      buildConfig(answers("codex", { implementers: ["__proto__x!"] }), policy),
    ).toThrow(/Invalid implementer lane ID/);
  });
  it("enforces limit and cost bounds", () => {
    expect(() => parseLimit("maxParallel", "5")).toThrow(/1-4/);
    expect(() => parseLimit("maxRunMinutes", "61")).toThrow(/1-60/);
    expect(() => parseLimit("intervalSeconds", "0")).toThrow(/1-60/);
    expect(parseLimit("maxRunsPerHour", "60")).toBe(60);
    expect(() => parseCost("0.001")).toThrow(/0.01-100/);
    expect(() => parseCost("101")).toThrow(/0.01-100/);
    expect(parseCost("2.5")).toBe(2.5);
  });
});

it("a claude setup is exactly this hand-written runtime file", () => {
  // Expected value authored from the documented contract, not from the code
  // under test: roles from policy, bounded limits, claude isolation fields.
  const { config } = buildConfig(
    answers("claude", {
      implementers: ["dev"],
      allowedTasks: ["T-1"],
      claude: {
        implementerMode: "auto",
        mcp: "strict",
        settingSources: ["project"],
        maxCostUsdPerRun: 2,
      },
    }),
    policy,
  );
  const claudeLane = (mode: string, enabled = true) => ({
    enabled,
    harness: "claude",
    model: "opus",
    claudePermissionMode: mode,
    claudeMcp: "strict",
    claudeSettingSources: ["project"],
    maxCostUsdPerRun: 2,
  });
  expect(config).toEqual({
    version: 1,
    binary: exe,
    binaries: { claude: exe },
    allowedTasks: ["T-1"],
    maxParallel: 2,
    intervalSeconds: 10,
    maxRunMinutes: 25,
    maxRunsPerHour: 20,
    confirmedStoppedAt: "2026-11-08T00:00:00.000Z",
    lanes: {
      captain: claudeLane("plan"),
      dev: claudeLane("auto"),
      inspector: claudeLane("plan"),
      visual: claudeLane("plan", false),
    },
  });
  // And the engine accepts it unchanged.
  expect(() => decode(config)).not.toThrow();
});

it("validates a Pi model through the engine and rejects what it would reject", () => {
  expect(acceptPiModel("prov/m-1")).toEqual({ provider: "prov", id: "m-1" });
  for (const bad of ["nomodel", "/m", "p/", "p/has space", "p/$(x)"])
    expect(() => acceptPiModel(bad), bad).toThrow();
});
