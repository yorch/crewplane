import type {
  EvidenceArtifact,
  EvidenceManifest,
} from "../evidence/contract.ts";

const kinds: Record<string, { kind: "image" | "video"; extension: string }> = {
  "image/png": { kind: "image", extension: "png" },
  "image/jpeg": { kind: "image", extension: "jpg" },
  "image/webp": { kind: "image", extension: "webp" },
  "video/webm": { kind: "video", extension: "webm" },
};

/**
 * Response headers for stored evidence bytes. The type is an allowlist (the
 * store only accepts these four, verified by magic bytes); anything else is
 * served as an opaque download. `sandbox` plus `default-src 'none'` and
 * `nosniff` mean a hostile artifact opened directly can run no script and
 * cannot be sniffed into HTML in the dashboard's origin.
 */
export function evidenceArtifactHeaders(
  mime: string,
  artifactId: string,
  bytes: number,
) {
  const known = Object.hasOwn(kinds, mime) ? kinds[mime] : undefined;
  return {
    "Content-Type": known ? mime : "application/octet-stream",
    "Content-Length": String(bytes),
    "Content-Disposition": `${known ? "inline" : "attachment"}; filename="${artifactId}.${known?.extension ?? "bin"}"`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export const evidenceListDefaultLimit = 100;
export const evidenceListMaxLimit = 200;

const flat = (m: EvidenceManifest, a: EvidenceArtifact) => ({
  id: a.artifactId,
  kind: kinds[a.mime]?.kind ?? null,
  mime: a.mime,
  size: a.bytes,
  createdAt: a.capturedAt,
  task: m.task,
  run: m.runId,
  lane: m.lane,
  testedCommit: m.testedCommit,
  sha256: a.sha256,
  route: a.route,
  scenario: a.scenario,
  step: a.step,
  browser: a.browser,
  viewport: a.viewport,
  outcome: a.outcome,
  findingIds: a.findingIds,
  recheckOf: a.recheckOf,
  url: `/api/evidence/artifacts/${a.artifactId}`,
});

/**
 * Flat, gallery-ready artifact metadata (no content), newest run first,
 * paged by the last artifact id returned.
 */
export function evidenceArtifactList(
  runs: EvidenceManifest[],
  options: { limit: number; cursor?: string },
) {
  const all = runs.flatMap((m) => m.artifacts.map((a) => flat(m, a)));
  const start =
    options.cursor === undefined
      ? 0
      : all.findIndex((a) => a.id === options.cursor) + 1;
  if (options.cursor !== undefined && start === 0) return null;
  const page = all.slice(start, start + options.limit);
  return {
    version: 1,
    artifacts: page,
    nextCursor:
      start + options.limit < all.length ? (page.at(-1)?.id ?? null) : null,
    retentionLimited: runs.some((m) => m.truncated),
  };
}
