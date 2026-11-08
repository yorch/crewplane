/** Stable extraction ports. Implementations remain local and explicitly authorized. */
import type { Board, Config, RecordState, Work } from "./contracts.ts";
import type {
  FinalResult,
  Harness,
  HarnessStream,
  LaneHarness,
  NativeSession,
} from "./engine/harness.ts";
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
export interface HarnessCapabilities {
  resume: boolean;
  structuredResult: boolean;
  nativeTools: "harness-controlled" | "disabled";
  usage: "partial";
  screenshots: "external";
}
export interface HarnessAdapter {
  id: Harness;
  capabilities: HarnessCapabilities;
  invoke(
    config: Config,
    lane: LaneHarness,
    session: NativeSession,
    schema: string,
    output: string,
  ): { binary: string; args: string[]; harness: Harness };
  consume(stream: HarnessStream, event: Record<string, unknown>): void;
  validateResult(value: unknown): value is FinalResult;
}
export interface RunObserver {
  record(run: Readonly<RecordState>): Promise<void>;
}
