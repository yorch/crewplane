import { describe, expect, it } from "vitest";
import { evaluateTurnWait, type TurnWaitInput } from "./wait-policy.ts";

const waiting: TurnWaitInput = {
  previousNoProgress: 1,
  progressChanged: false,
  finalState: "waiting",
  failure: null,
  operatorHeld: false,
  pendingEventIds: [],
  seenEventIds: [],
  explicitWait: true,
};

const evaluate = (patch: Partial<TurnWaitInput> = {}) =>
  evaluateTurnWait({ ...waiting, ...patch });

describe("turn waiting policy", () => {
  it("preserves explicit waits across repeated turns without a no-progress pause", () => {
    let count = 2;
    for (let turn = 0; turn < 5; turn++) {
      const result = evaluate({ previousNoProgress: count });
      expect(result).toEqual({
        noProgress: 2,
        disposition: "waiting",
        reason: "await-event",
        wake: false,
      });
      count = result.noProgress;
    }
  });

  it("wakes on a fresh answer and stops waking after caller consumption, including restart", () => {
    expect(
      evaluate({ pendingEventIds: ["answer-2"], seenEventIds: ["answer-1"] })
        .wake,
    ).toBe(true);
    const persisted = {
      pendingEventIds: ["answer-2", "answer-2"],
      seenEventIds: ["answer-1", "answer-2"],
    };
    expect(evaluate(persisted).wake).toBe(false);
    expect(evaluate(JSON.parse(JSON.stringify(persisted))).wake).toBe(false);
    expect(
      evaluate({ pendingEventIds: ["answer-1"], seenEventIds: ["answer-1"] })
        .wake,
    ).toBe(false);
  });

  it("counts active no-progress turns and unproven waits toward threshold two", () => {
    expect(evaluate({ finalState: "working", previousNoProgress: 0 })).toEqual({
      noProgress: 1,
      disposition: "idle",
      reason: null,
      wake: false,
    });
    for (const finalState of ["working", "waiting"] as const) {
      expect(evaluate({ finalState, explicitWait: false })).toEqual({
        noProgress: 2,
        disposition: "paused",
        reason: "no-progress",
        wake: false,
      });
    }
  });

  it("resets on actual progress and does not count ready as active work", () => {
    expect(evaluate({ progressChanged: true }).noProgress).toBe(0);
    expect(evaluate({ finalState: "working", progressChanged: true })).toEqual({
      noProgress: 0,
      disposition: "idle",
      reason: null,
      wake: false,
    });
    expect(evaluate({ finalState: "ready" })).toEqual({
      noProgress: 1,
      disposition: "idle",
      reason: null,
      wake: false,
    });
  });

  it.each(["cli", "timeout", "invalid", "trace"] as const)(
    "preserves %s failure over fresh events",
    (failure) => {
      expect(evaluate({ failure, pendingEventIds: ["new"] })).toEqual({
        noProgress: 1,
        disposition: "paused",
        reason: "failure",
        wake: false,
      });
    },
  );

  it.each([{ operatorHeld: true }, { finalState: "needs_operator" as const }])(
    "preserves operator pause %j",
    (patch) => {
      expect(evaluate({ ...patch, pendingEventIds: ["new"] })).toEqual({
        noProgress: 1,
        disposition: "paused",
        reason: "operator",
        wake: false,
      });
    },
  );

  it("gives failure precedence and never wakes active or completed turns", () => {
    expect(evaluate({ failure: "cli", operatorHeld: true }).reason).toBe(
      "failure",
    );
    for (const finalState of ["working", "ready"] as const) {
      expect(
        evaluate({
          finalState,
          progressChanged: true,
          pendingEventIds: ["new"],
        }).wake,
      ).toBe(false);
    }
  });

  it("does not mutate inputs and saturates safe counters", () => {
    const input = structuredClone(waiting);
    evaluateTurnWait(input);
    expect(input).toEqual(waiting);
    expect(
      evaluate({
        finalState: "working",
        previousNoProgress: Number.MAX_SAFE_INTEGER,
      }).noProgress,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    { previousNoProgress: -1 },
    { previousNoProgress: 1.5 },
    { previousNoProgress: Infinity },
    { previousNoProgress: Number.MAX_SAFE_INTEGER + 1 },
    { pendingEventIds: [""] },
    { pendingEventIds: ["x".repeat(513)] },
    { seenEventIds: Array(10_001).fill("event") },
    { failure: "private text" },
    { finalState: "other" },
    { explicitWait: "yes" },
    { operatorHeld: null },
    { progressChanged: 1 },
    { pendingEventIds: null },
  ])("rejects malformed bounds with a fixed safe error", (patch) => {
    expect(() =>
      evaluateTurnWait({ ...waiting, ...patch } as TurnWaitInput),
    ).toThrow("WAIT_POLICY_INVALID_INPUT");
  });
});
