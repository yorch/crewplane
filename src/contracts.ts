import type { ScheduleResult } from "./engine/fair-scheduler.ts";
import type { Harness, LaneHarness } from "./engine/harness.ts";
import type { LoadedScheduling } from "./engine/scheduling.ts";
export type Lane = string;
export interface Config {
  coordinator?: string;
  reviewers?: string[];
  reviewerRoles?: Record<string, import("./project.ts").ReviewerRole>;
  version: 1;
  root: string;
  binary: string;
  binaries?: Partial<Record<Harness, string>>;
  allowedTasks: string[];
  maxParallel: number;
  intervalSeconds: number;
  maxRunMinutes: number;
  maxRunsPerHour: number;
  confirmedStoppedAt: string;
  lanes: Record<Lane, LaneHarness & { enabled: boolean }>;
}
export interface RecordState {
  key: string;
  lane: Lane;
  task: string | null;
  cwd: string;
  sessionId?: string;
  harness?: Harness;
  sessionEpoch?: string;
  observedModel?: string;
  runId?: string;
  traceLimited?: boolean;
  status: "running" | "idle" | "paused";
  reason: string;
  summary?: string;
  pid?: number;
  processGroupId?: number;
  cleanupUnverified?: boolean;
  inputTokensKnown?: boolean;
  outputTokensKnown?: boolean;
  permissionDenials?: number;
  permissionDenialsKnown?: boolean;
  reportedCostUsd?: number;
  costKnown?: boolean;
  lastSessionReset?: {
    at: string;
    previousSessionId: string;
    note: string;
  };
  seen: string[];
  seenMessagesThrough?: string;
  seenMessagesAtBoundary?: string[];
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  runs: number[];
  progress?: string;
  noProgress: number;
  waitingForEvent?: boolean;
  finalState?: "working" | "waiting" | "ready" | "needs_operator";
  pauseKind?: "failure" | "operator" | "decision" | "no-progress";
  inputTokens: number;
  outputTokens: number;
}
export interface State {
  version: 1;
  running: boolean;
  generation?: string;
  checkedAt: string;
  pid: number;
  draining: boolean;
  held: Lane[];
  commands: string[];
  records: Record<string, RecordState>;
  retiredRuns?: Partial<Record<Lane, number[]>>;
  notices: Partial<Record<Lane, string[]>>;
  controlOutcome?: Partial<
    Record<
      Lane,
      {
        action: string;
        outcome: "applied" | "refused";
        reason: string;
        at: string;
      }
    >
  >;
  attention?: {
    oldestUnhandledAt: number | null;
    planningSince: number | null;
    backlog: number;
    oldestReadyAt?: number | null;
  };
  noticeQueuedAt?: Partial<Record<Lane, string>>;
  scheduling?: LoadedScheduling;
  queue?: ScheduleResult;
  planning?: { event: string; taskIds: string[]; needed: boolean } | null;
  configReload?: {
    outcome: "applied" | "unchanged" | "invalid" | "deferred";
    errorCode: string | null;
    evaluatedAt: string;
  };
}
export interface Work {
  lane: Lane;
  key: string;
  task: string | null;
  events: string[];
  reason: string;
}

export interface Message {
  reviewCommit?: string;
  assignmentId?: string;
  id: string;
  at: string;
  from: string;
  to: string;
  kind: string;
  task: string | null;
  replyTo: string | null;
  text: string;
}
export interface LiveTask {
  scope?: { version: 1; paths: string[] } | null;
  scheduling?: import("./engine/fair-scheduler.ts").Metadata | null;
  task: string;
  assignment: {
    id?: string;
    owner: string;
    baseCommit: string;
    at: string;
    text: string;
  };
  claim: { branch: string; worktree: string; at: string } | null;
  status: {
    state: string;
    text: string;
    at: string;
    commit: string | null;
    checkpointed?: boolean;
    revisionRequestId?: string;
    revisionCommit?: string;
  } | null;
  accepted: {
    commit: string;
    sourceCommit?: string;
    at: string;
    text: string;
  } | null;
}
export interface Board {
  store: string;
  tasks: LiveTask[];
  messages: Message[];
  unanswered: Message[];
}
