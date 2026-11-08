import { expect, it } from "vitest";
import { evaluateSchedulingReload } from "./config-reload.ts";
import type { Config } from "./supervisor.ts";

const base = (): Config => ({
  version: 1,
  root: "/synthetic/relay",
  binary: "/synthetic/codex",
  allowedTasks: ["P0-24", "P1-06"],
  maxParallel: 4,
  intervalSeconds: 10,
  maxRunMinutes: 25,
  maxRunsPerHour: 20,
  confirmedStoppedAt: "2026-11-07T00:00:00Z",
  lanes: { coordinator: { enabled: true }, C: { enabled: false } },
});
// Controlled validator: production filesystem validation belongs to coordinator's composition.
const validate = (value: unknown): Config => {
  if (!value || typeof value !== "object" || !("version" in value))
    throw new Error("PRIVATE_SENTINEL");
  return value as Config;
};

it("applies task additions, removal, enable/disable and new default lanes", () => {
  const current = base();
  const candidate = base();
  candidate.allowedTasks = ["P0-24", "P0-21"];
  candidate.lanes = {
    coordinator: { enabled: false },
    C: { enabled: true },
    D: { enabled: true },
  };
  const result = evaluateSchedulingReload(current, candidate, validate);
  expect(result).toEqual({
    config: candidate,
    outcome: "applied",
    errorCode: null,
  });
  expect(current).toEqual(base());
  expect(result.config).not.toBe(candidate);
});

it("ignores key/task reordering, duplicate tasks and absent disabled default lanes", () => {
  const current = base();
  const candidate = {
    ...base(),
    allowedTasks: ["P1-06", "P0-24", "P0-24"],
    lanes: { coordinator: { enabled: true } },
  };
  const result = evaluateSchedulingReload(current, candidate, validate);
  expect(result).toEqual({
    config: current,
    outcome: "unchanged",
    errorCode: null,
  });
  expect(result.config).toBe(current);
});

it.each([
  { binary: "/other/codex" },
  { root: "/other/root" },
  { binaries: { codex: "/other/codex" } },
  { maxParallel: 3 },
  { intervalSeconds: 20 },
  { maxRunMinutes: 30 },
  { maxRunsPerHour: 30 },
  { confirmedStoppedAt: "2026-11-08T00:00:00Z" },
  { lanes: { C: { enabled: true, model: "other" } } },
  { lanes: { C: { enabled: true, harness: "codex" as const } } },
  { lanes: { C: { enabled: true, sessionEpoch: "fresh" } } },
  { lanes: { C: { enabled: true, piPermissions: "no-tools" as const } } },
  {
    lanes: {
      C: { enabled: true, piModel: { provider: "synthetic", id: "other" } },
    },
  },
])(
  "defers immutable differences without partially applying scheduling: %j",
  (change) => {
    const current = base();
    const candidate = { ...base(), ...change, allowedTasks: ["P0-21"] };
    const result = evaluateSchedulingReload(current, candidate, validate);
    expect(result).toEqual({
      config: current,
      outcome: "deferred",
      errorCode: "RESTART_REQUIRED",
    });
    expect(result.config).toBe(current);
  },
);

it("preserves configured identity when a lane is removed", () => {
  const current = base();
  current.lanes.C = { enabled: true, model: "synthetic" };
  expect(evaluateSchedulingReload(current, base(), validate).outcome).toBe(
    "deferred",
  );
});

it("isolates nested validator and later result mutations from both inputs", () => {
  const current = base();
  const candidate = base();
  candidate.binaries = { codex: "/synthetic/codex" };
  current.binaries = { codex: "/synthetic/codex" };
  const before = structuredClone({ current, candidate });
  const result = evaluateSchedulingReload(current, candidate, (value) => {
    const config = validate(value);
    config.allowedTasks.push("P0-21");
    config.lanes.C = { enabled: true };
    return config;
  });
  expect(result.outcome).toBe("applied");
  if (result.config.binaries) result.config.binaries.codex = "/changed";
  expect({ current, candidate }).toEqual(before);
});

it("retains exact last-good on malformed input or private validator failures, then recovers", () => {
  const current = base();
  for (const candidate of [null, "broken", {}, { version: 1 }]) {
    const result = evaluateSchedulingReload(current, candidate, validate);
    expect(result).toEqual({
      config: current,
      outcome: "invalid",
      errorCode: "INVALID_CONFIG",
    });
    expect(result.config).toBe(current);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  }
  const result = evaluateSchedulingReload(current, base(), () => {
    throw new Error("PRIVATE_SENTINEL");
  });
  expect(result.errorCode).toBe("INVALID_CONFIG");
  const candidate = base();
  candidate.lanes.C = { enabled: true };
  expect(evaluateSchedulingReload(current, candidate, validate).outcome).toBe(
    "applied",
  );
});
