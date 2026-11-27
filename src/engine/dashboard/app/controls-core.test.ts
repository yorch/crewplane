import { expect, it } from "vitest";
import { parseControlRequest } from "../controls.ts";
import {
  errorText,
  explainOutcome,
  formProblem,
  kinds,
  plan,
  requestBody,
} from "./controls-core.js";

const run = "1794100000001-00000000-0000-4000-8000-000000000001";
const ctx = {
  lane: "builder",
  task: "CP-101",
  rev: 4,
  runId: run,
  sessionId: "sess_1",
  pauseId: "00000000-0000-4000-8000-000000000002",
};
const rid = "00000000-0000-4000-8000-000000000009";
const filled = { note: "because", ack: true, typed: "" };

it("builds a request the server accepts for every dialog kind", () => {
  for (const kind of kinds) {
    const p = plan(kind, ctx);
    const form = { ...filled, typed: p.confirmWord ?? "" };
    expect(formProblem(p, form), kind).toBeNull();
    const parsed = parseControlRequest(requestBody(p, form, rid), {
      lanes: ["builder"],
      generation: undefined,
      at: new Date().toISOString(),
    });
    expect(parsed.ok, `${kind}: ${JSON.stringify(parsed)}`).toBe(true);
  }
});

it("pins what the operator saw and never sends the pins of other kinds", () => {
  expect(requestBody(plan("resume", ctx), filled, rid)).toEqual({
    action: "resume",
    lane: "builder",
    expectRev: 4,
    requestId: rid,
  });
  const session = requestBody(plan("retry-new-session", ctx), filled, rid);
  expect(session).toMatchObject({ newSession: true, expectSession: "sess_1" });
  expect(session).not.toHaveProperty("expectRun");
  expect(
    requestBody(plan("retry-confirm-cleanup", ctx), filled, rid),
  ).toMatchObject({
    confirmCleanup: true,
    expectRun: run,
    expectRev: 4,
  });
  expect(requestBody(plan("cancel", ctx), filled, rid)).toEqual({
    action: "cancel",
    lane: "builder",
    run,
  });
});

it("requires the note, the acknowledgement and the typed word where the action does", () => {
  const empty = { note: "  ", ack: false, typed: "" };
  expect(formProblem(plan("nudge", ctx), empty)).toMatch(/note is required/);
  expect(formProblem(plan("resolve-deny", ctx), empty)).toMatch(
    /note is required/,
  );
  expect(formProblem(plan("retry", ctx), empty)).toBeNull();
  const cleanup = plan("retry-confirm-cleanup", ctx);
  expect(formProblem(cleanup, { ...empty, note: "ok" })).toMatch(
    /Confirm the statement/,
  );
  expect(formProblem(cleanup, { note: "ok", ack: true, typed: "" })).toBeNull();
  const cancel = plan("cancel", ctx);
  expect(formProblem(cancel, { ...empty, typed: "nope" })).toMatch(
    /Type builder/,
  );
  expect(formProblem(cancel, { ...empty, typed: "builder" })).toBeNull();
  expect(
    formProblem(plan("stop", ctx), { ...empty, typed: "stop" }),
  ).toBeNull();
  expect(
    formProblem(plan("nudge", ctx), {
      note: "x".repeat(2001),
      ack: false,
      typed: "",
    }),
  ).toMatch(/under 2000/);
});

it("restates exactly what will happen", () => {
  expect(plan("resume", ctx).effect).toContain("revision 4");
  expect(plan("cancel", ctx).effect).toContain(run);
  expect(plan("stop", ctx).destructive).toBe(true);
  expect(plan("nudge", ctx).destructive).toBe(false);
});

it("explains recorded outcomes and refusals in plain language", () => {
  expect(
    explainOutcome({ outcome: "stale", reason: "STALE_REVISION" }),
  ).toMatch(/changed after you opened this/);
  expect(
    explainOutcome({ outcome: "invalid", reason: "STALE_REVISION" }),
  ).toMatch(/Not applied: .*not applied/);
  expect(
    explainOutcome({ outcome: "refused", reason: "RUN_NOT_ACTIVE" }),
  ).toMatch(/no longer active/);
  expect(explainOutcome({ outcome: "invalid", reason: "HELD" })).toMatch(
    /resume it first/,
  );
  expect(explainOutcome({ outcome: "applied", reason: "HELD" })).toMatch(
    /now on hold/,
  );
  expect(explainOutcome({ outcome: "applied", reason: "weird<script>" })).toBe(
    "Applied: The supervisor applied it.",
  );
  expect(errorText(429, { code: "RATE_LIMITED" })).toMatch(/last minute/);
  expect(errorText(400, { error: "nope" })).toBe("nope");
});
