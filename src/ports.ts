/** Stable extraction ports. Implementations remain local and explicitly authorized. */
import type { Config } from "./contracts.ts";
import type {
  FinalOutcome,
  FinalResult,
  Harness,
  HarnessCapabilities,
  HarnessStream,
  LaneHarness,
  NativeSession,
} from "./engine/harness.ts";

export type { HarnessCapabilities } from "./engine/harness.ts";
/** A planning card derived from a roadmap document; never grants execution authority. */
export interface PlannedCard {
  id: string;
  markdown: string;
}
/** Derives placeholder cards from a plan, skipping ids that already have a card. */
export type PlanParser = (
  plan: string,
  existingIds: Set<string>,
) => PlannedCard[];
export interface HarnessAdapter {
  id: Harness;
  capabilities: HarnessCapabilities;
  /** Appended to the operator prompt when the harness has no native result schema. */
  promptSuffix?: string;
  /** The harness needs a private native session directory created before launch. */
  sessionDirectory?: boolean;
  /** Non-JSON or oversized stdout is a protocol failure, not ignorable noise. */
  strictStream?: boolean;
  invoke(
    config: Config,
    lane: LaneHarness,
    session: NativeSession,
    schema: string,
    output: string,
  ): {
    binary: string;
    args: string[];
    harness: Harness;
    expectedSessionId?: string;
  };
  consume(stream: HarnessStream, event: Record<string, unknown>): void;
  /** Resolve the normalized final result and whether to persist it to the run log. */
  finalize(stream: HarnessStream, output: string): Promise<FinalOutcome>;
  validateResult(value: unknown): value is FinalResult;
}
