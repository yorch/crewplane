/** Stable extraction ports. Implementations remain local and explicitly authorized. */
import type { Board, Config, RecordState, Work } from "./contracts.ts";
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
export interface ProjectIdentity {
  version: 1;
  root: string;
  gitCommonDir: string;
  store: string;
}
export interface CoordinationPort {
  execute(args: string[], cwd: string): Promise<unknown>;
}
export interface BoardReader {
  snapshot(root: string): Promise<Board>;
}
export interface WorkspacePort {
  prepare(work: Work): Promise<string>;
  inspect(path: string): Promise<{ commit: string; dirty: boolean }>;
}
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
export interface RunObserver {
  record(run: Readonly<RecordState>): Promise<void>;
}
