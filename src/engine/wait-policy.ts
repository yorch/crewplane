/** Pure turn policy. The caller proves explicit waits and retains pause provenance. */
export type TurnWaitInput = {
  previousNoProgress: number;
  progressChanged: boolean;
  finalState: "working" | "waiting" | "ready" | "needs_operator";
  failure: "cli" | "timeout" | "invalid" | "trace" | null;
  operatorHeld: boolean;
  pendingEventIds: string[];
  seenEventIds: string[];
  explicitWait: boolean;
};

export type TurnWaitResult = {
  noProgress: number;
  disposition: "idle" | "waiting" | "paused";
  reason: "failure" | "operator" | "no-progress" | "await-event" | null;
  wake: boolean;
};

function validIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 512,
    )
  );
}

export function evaluateTurnWait(input: TurnWaitInput): TurnWaitResult {
  if (
    !input ||
    !Number.isSafeInteger(input.previousNoProgress) ||
    input.previousNoProgress < 0 ||
    typeof input.progressChanged !== "boolean" ||
    typeof input.operatorHeld !== "boolean" ||
    typeof input.explicitWait !== "boolean" ||
    !["working", "waiting", "ready", "needs_operator"].includes(
      input.finalState,
    ) ||
    ![null, "cli", "timeout", "invalid", "trace"].includes(input.failure) ||
    !validIds(input.pendingEventIds) ||
    !validIds(input.seenEventIds)
  ) {
    throw new TypeError("WAIT_POLICY_INVALID_INPUT");
  }

  const noProgress = input.progressChanged ? 0 : input.previousNoProgress;
  if (input.failure !== null) {
    return {
      noProgress,
      disposition: "paused",
      reason: "failure",
      wake: false,
    };
  }
  if (input.operatorHeld || input.finalState === "needs_operator") {
    return {
      noProgress,
      disposition: "paused",
      reason: "operator",
      wake: false,
    };
  }
  if (input.finalState === "waiting" && input.explicitWait) {
    const seen = new Set(input.seenEventIds);
    return {
      noProgress,
      disposition: "waiting",
      reason: "await-event",
      wake: input.pendingEventIds.some((id) => !seen.has(id)),
    };
  }
  if (input.finalState === "ready") {
    return { noProgress, disposition: "idle", reason: null, wake: false };
  }
  const next = input.progressChanged
    ? 0
    : Math.min(Number.MAX_SAFE_INTEGER, noProgress + 1);
  return {
    noProgress: next,
    disposition: next >= 2 ? "paused" : "idle",
    reason: next >= 2 ? "no-progress" : null,
    wake: false,
  };
}
