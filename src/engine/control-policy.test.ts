import { expect, it } from "vitest";
import type { State } from "../contracts.ts";
import { control, validState } from "./control-policy.ts";

const state = (): State => ({
  version: 1,
  running: false,
  checkedAt: new Date().toISOString(),
  pid: 1,
  draining: false,
  held: [],
  commands: [],
  notices: {},
  records: {},
});

it("accepts a new-session retry only with a task, note and no cleanup acknowledgement", () => {
  expect(
    control({
      action: "retry",
      lane: "builder",
      task: "CP-101",
      newSession: true,
      text: "Reset the native session",
    }),
  ).toMatchObject({
    action: "retry",
    lane: "builder",
    task: "CP-101",
    newSession: true,
    text: "Reset the native session",
  });
  for (const invalid of [
    { action: "retry", lane: "builder", newSession: true, text: "x" },
    {
      action: "retry",
      lane: "builder",
      task: "CP-101",
      newSession: true,
    },
    {
      action: "retry",
      lane: "builder",
      task: "CP-101",
      newSession: true,
      text: "x",
      confirmCleanup: true,
    },
    {
      action: "pause",
      lane: "builder",
      task: "CP-101",
      newSession: true,
      text: "x",
    },
    { action: "retry", lane: "builder", task: "CP-101", text: "x" },
  ])
    expect(control(invalid).action).toBe("invalid");
});
it("validates control outcomes and per-record denial/cost/reset metadata", () => {
  const value = state();
  value.controlOutcome = {
    builder: {
      action: "retry-new-session",
      outcome: "applied",
      reason: "Fresh native session will be created",
      at: new Date().toISOString(),
    },
  };
  value.records.builder = {
    key: "builder",
    lane: "builder",
    task: "CP-101",
    cwd: "/synthetic",
    status: "idle",
    reason: "",
    seen: [],
    runs: [],
    noProgress: 0,
    inputTokens: 0,
    outputTokens: 0,
    permissionDenials: 2,
    permissionDenialsKnown: true,
    reportedCostUsd: 0.5,
    costKnown: true,
    lastSessionReset: {
      at: new Date().toISOString(),
      previousSessionId: "00000000-0000-4000-8000-000000000001",
      note: "Synthetic reset",
    },
  };
  expect(validState(value)).toBe(true);
  value.records.builder.reportedCostUsd = Number.POSITIVE_INFINITY;
  expect(validState(value)).toBe(false);
});
