// Frozen v1 coordinator interface. F implements store/capture; A serves IDs only.
export const EVIDENCE_VERSION = 1 as const;
export const evidenceRoutes = ["dashboard", "synthetic"] as const;
export const evidenceScenarios = [
  "initial",
  "interaction",
  "pending",
  "error",
  "success",
  "responsive",
  "finding",
  "recheck",
] as const;
export type EvidenceRoute = string;
export type EvidenceScenario = (typeof evidenceScenarios)[number];
export type EvidenceMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "video/webm";
export interface EvidenceRunInput {
  task: string;
  lane: string;
  testedCommit: string;
}
export interface EvidenceCaptureInput {
  route: EvidenceRoute; // fixed key, never raw URL/query/token
  scenario: EvidenceScenario;
  step: number; // 0..999, no arbitrary sensitive label
  browser: "chromium" | "chrome";
  viewport: { width: number; height: number };
  mime: EvidenceMime;
  outcome: "captured" | "finding" | "recheck";
  findingIds: readonly string[]; // opaque IDs only, no copied finding prose
  recheckOf: string | null; // original artifact ID, preserve original
}
export interface EvidenceArtifact
  extends EvidenceRunInput,
    EvidenceCaptureInput {
  version: 1;
  artifactId: string;
  runId: string;
  capturedAt: string;
  bytes: number;
  sha256: string;
}
export interface EvidenceManifest extends EvidenceRunInput {
  version: 1;
  runId: string;
  createdAt: string;
  artifacts: EvidenceArtifact[];
  truncated: boolean;
  retention: {
    omittedArtifacts: number;
    reason: "none" | "run-cap" | "global-cap" | "retention";
  };
}
export interface EvidenceLimits {
  maxArtifactBytes: number;
  maxRunBytes: number;
  maxTotalBytes: number;
  maxRuns: number;
  maxArtifactsPerRun: number;
}
export const defaultEvidenceLimits: Readonly<EvidenceLimits> = {
  maxArtifactBytes: 16 * 1024 * 1024,
  maxRunBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRuns: 20,
  maxArtifactsPerRun: 100,
};
export interface EvidenceStore {
  createRun(input: EvidenceRunInput): Promise<EvidenceManifest>;
  append(
    runId: string,
    input: EvidenceCaptureInput,
    content: Uint8Array,
  ): Promise<EvidenceArtifact>;
  list(options?: { task?: string; cursor?: string; limit?: number }): Promise<{
    runs: EvidenceManifest[];
    nextCursor: string | null;
    retentionLimited: boolean;
  }>;
  manifest(runId: string): Promise<EvidenceManifest | null>;
  read(
    artifactId: string,
  ): Promise<{ artifact: EvidenceArtifact; content: Uint8Array } | null>;
}
// Factory implemented by F: createEvidenceStore(root:string, limits?:Partial<EvidenceLimits>): Promise<EvidenceStore>.
// Capture helper receives an existing Playwright Page/BrowserContext plus this
// store/run/input, never arbitrary filesystem destinations. Video is opt-in and
// bounded per scenario; no trace.zip/desktop recorder or automatic external URL.
export const evidenceIdPattern = /^(?:ev|qa|finding)_[a-f0-9]{32}$/;
export const evidenceTaskPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
export const evidenceCommitPattern = /^[a-f0-9]{40}$/;
