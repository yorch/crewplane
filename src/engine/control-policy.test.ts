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

it("binds each control action to a truthful target and rejects unused fields", () => {
  expect(
    control({ v: 2, action: "stop", at: new Date().toISOString() }).action,
  ).toBe("stop");
  for (const invalid of [
    { v: 2, action: "stop", lane: "builder" },
    { v: 2, action: "rollout", text: "x" },
    { v: 2, action: "pause", lane: "builder", text: "x" },
    { v: 2, action: "pause", lane: "builder", all: true },
    { v: 2, action: "resume" },
    { v: 2, action: "nudge", lane: "builder" },
    { v: 2, action: "cancel", lane: "builder" },
    { v: 2, action: "cancel", all: true, lane: "builder" },
    {
      v: 2,
      action: "resolve",
      lane: "reviewer",
      task: "T1",
      text: "ok",
      resolution: "approve",
    },
    {
      v: 2,
      action: "retry",
      lane: "builder",
      task: "T1",
      newSession: true,
    },
    { v: 2, action: "retry", lane: "builder", confirmCleanup: true },
    { v: 2, action: "pause", lane: "builder", at: "tomorrow" },
    { v: 2, action: "retry", lane: "builder", expectRev: -1 },
  ])
    expect(control(invalid).action).toBe("invalid");
  expect(
    control({
      v: 2,
      action: "resolve",
      lane: "reviewer",
      task: "T1",
      text: "Approved with evidence",
      resolution: "approve",
      pauseId: "00000000-0000-4000-8000-000000000001",
      expectRev: 3,
      at: new Date().toISOString(),
    }),
  ).toMatchObject({ action: "resolve", resolution: "approve", expectRev: 3 });
  expect(
    control({
      v: 1,
      action: "nudge",
      lane: "builder",
      text: "Legacy nudge",
    }).action,
  ).toBe("nudge");
});
it("validates v2 control logs, holds and revisions", () => {
  const value = state();
  value.version = 2;
  value.instanceHeld = true;
  value.laneRev = { builder: 2 };
  value.controlSeq = 1;
  value.controlLog = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      action: "pause",
      scope: "lane",
      target: "builder",
      outcome: "applied",
      code: "HELD",
      at: new Date().toISOString(),
      issuer: "operator",
    },
  ];
  expect(validState(value)).toBe(true);
  const entry = value.controlLog?.[0];
  if (!entry) throw new Error("Missing control log fixture");
  entry.outcome = "unknown" as never;
  expect(validState(value)).toBe(false);
  entry.outcome = "applied";
  value.laneRev = { builder: -1 };
  expect(validState(value)).toBe(false);
});

it("accepts instance holds, run cancellation and hard stop only with a target", () => {
  expect(control({ v: 2, action: "pause", all: true }).action).toBe("pause");
  expect(control({ v: 2, action: "resume", all: true }).action).toBe("resume");
  expect(control({ v: 2, action: "cancel", all: true }).action).toBe("cancel");
  expect(
    control({
      v: 2,
      action: "cancel",
      lane: "builder",
      run: "1794100000001-00000000-0000-4000-8000-000000000001",
    }).action,
  ).toBe("cancel");
  expect(control({ v: 2, action: "stop", cancelActive: true }).action).toBe(
    "stop",
  );
  for (const bad of [
    { v: 2, action: "stop", cancelActive: false },
    { v: 2, action: "cancel" },
    { v: 2, action: "cancel", run: "not-a-run" },
    { v: 2, action: "pause", all: true, lane: "builder" },
    { v: 2, action: "resolve", lane: "reviewer", task: "T1" },
  ])
    expect(control(bad).action).toBe("invalid");
});
