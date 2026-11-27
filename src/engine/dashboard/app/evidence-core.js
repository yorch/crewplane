// Pure rules for the Evidence gallery: which bytes may become a blob, when they
// load by themselves, the bounded object-URL cache and alt text. No DOM and no
// network (the cache takes create/revoke functions), so each rule is unit
// tested. Artifact bytes need the session header, so the page fetches them and
// shows them from a blob: URL; the type of that blob comes from the allowlist
// below and the artifact's own metadata, never from a header alone.
import { excerpt } from "./format.js";

/** The only types a blob is ever created with (mirrors the server's four-value allowlist). */
export const BLOB_TYPES = Object.freeze({
  "image/png": { kind: "image", extension: "png" },
  "image/jpeg": { kind: "image", extension: "jpg" },
  "image/webp": { kind: "image", extension: "webp" },
  "video/webm": { kind: "video", extension: "webm" },
});
/** Most object URLs held at once; older ones are revoked first. */
export const MAX_OBJECT_URLS = 12;
/** Images up to this size load as they scroll into view; larger ones wait for a click. */
export const AUTO_LOAD_MAX_BYTES = 2 * 1024 * 1024;
/** Nothing larger than the store's own per-artifact limit is fetched. */
export const MAX_VIEW_BYTES = 16 * 1024 * 1024;

export const ID_PATTERNS = Object.freeze({
  task: /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/,
  run: /^qa_[a-f0-9]{32}$/,
  artifact: /^ev_[a-f0-9]{32}$/,
});

const allowed = (mime) =>
  typeof mime === "string" && Object.hasOwn(BLOB_TYPES, mime)
    ? BLOB_TYPES[mime]
    : null;
export const blobKind = (mime) => allowed(mime)?.kind ?? null;

/** The media type string without parameters, lower-cased. */
export const baseType = (header) =>
  String(header ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

/**
 * The type to give a Blob. The artifact's recorded mime must be allowlisted and
 * the response must say the same thing; any disagreement, an octet-stream or an
 * unknown type is refused rather than guessed, and is then download-only.
 */
export function blobTypeFor(artifactMime, responseHeader) {
  if (!allowed(artifactMime))
    return { ok: false, reason: "This file type cannot be previewed." };
  if (baseType(responseHeader) !== artifactMime)
    return {
      ok: false,
      reason:
        "The server sent a different type than recorded, so it was not previewed.",
    };
  return { ok: true, type: artifactMime };
}

/**
 * How an artifact is offered: `auto` (an image small enough to load when it
 * scrolls into view), `manual` (a Load button: a video or a large image),
 * `download-only` (a type that is never previewed) or `blocked` (over the
 * store's size limit or of unknown size).
 */
export function loadPolicy(artifact) {
  const kind = blobKind(artifact?.mime);
  if (!kind) return "download-only";
  const size = artifact?.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_VIEW_BYTES)
    return "blocked";
  if (kind === "image" && size <= AUTO_LOAD_MAX_BYTES) return "auto";
  return "manual";
}

/** A fixed, safe download name; never anything the artifact's text supplied. */
export function safeFilename(artifact) {
  const spec = allowed(artifact?.mime);
  const id = ID_PATTERNS.artifact.test(artifact?.id ?? "")
    ? artifact.id
    : "artifact";
  return `crewplane-evidence-${id}.${spec?.extension ?? "bin"}`;
}

/** Alternative text from the capture's own metadata (rendered with textContent only). */
export function altText(artifact) {
  const kind =
    blobKind(artifact?.mime) === "video" ? "Recording" : "Screenshot";
  const parts = [];
  if (artifact?.route) parts.push(`of ${artifact.route}`);
  if (artifact?.scenario) parts.push(`scenario ${artifact.scenario}`);
  if (Number.isSafeInteger(artifact?.step)) parts.push(`step ${artifact.step}`);
  const view = artifact?.viewport;
  if (Number.isSafeInteger(view?.width) && Number.isSafeInteger(view?.height))
    parts.push(`${view.width} by ${view.height} pixels`);
  if (artifact?.outcome) parts.push(`outcome ${artifact.outcome}`);
  return excerpt(`${kind} ${parts.join(", ")}`.trim(), 200);
}

const OUTCOME_TONES = {
  captured: "neutral",
  finding: "danger",
  recheck: "info",
};
export const outcomeTone = (outcome) =>
  Object.hasOwn(OUTCOME_TONES, outcome) ? OUTCOME_TONES[outcome] : "unknown";

/**
 * Object URLs held for artifacts, bounded and revoked deterministically.
 * `create` and `revoke` are URL.createObjectURL / revokeObjectURL in the page.
 * Pinned keys (the open lightbox) are never evicted; the least recently used
 * other key is revoked first and reported through `onEvict` so its card can go
 * back to a Load button.
 */
/**
 * @param {{
 *   create: (blob: unknown) => string,
 *   revoke: (url: string) => void,
 *   max?: number,
 *   onEvict?: (key: string) => void,
 * }} options
 */
export function createObjectUrlCache({
  create,
  revoke,
  max = MAX_OBJECT_URLS,
  onEvict = () => {},
}) {
  const held = new Map(); // key -> url, oldest first
  const pinned = new Set();
  function drop(key) {
    const url = held.get(key);
    if (url === undefined) return false;
    held.delete(key);
    pinned.delete(key);
    revoke(url);
    return true;
  }
  function makeRoom() {
    while (held.size >= max) {
      const victim = [...held.keys()].find((key) => !pinned.has(key));
      if (victim === undefined) return false;
      drop(victim);
      onEvict(victim);
    }
    return true;
  }
  return {
    /** Stores a blob and returns its URL, or null when every slot is pinned. */
    acquire(key, blob) {
      if (held.has(key)) {
        const url = held.get(key);
        held.delete(key);
        held.set(key, url);
        return url;
      }
      if (!makeRoom()) return null;
      const url = create(blob);
      held.set(key, url);
      return url;
    },
    get(key) {
      const url = held.get(key);
      if (url === undefined) return null;
      held.delete(key);
      held.set(key, url);
      return url;
    },
    has: (key) => held.has(key),
    release: drop,
    pin: (key) => {
      if (held.has(key)) pinned.add(key);
    },
    unpin: (key) => pinned.delete(key),
    /** Revokes everything (navigation away, teardown). */
    clear() {
      for (const key of [...held.keys()]) drop(key);
    },
    get size() {
      return held.size;
    },
    keys: () => [...held.keys()],
  };
}

/**
 * Query string for /api/evidence/artifacts from validated filters; an invalid value is dropped.
 * @param {{ task?: string, run?: string, cursor?: string, limit?: number }} [filters]
 */
export function listPath({ task, run, cursor, limit = 40 } = {}) {
  const query = new URLSearchParams();
  if (task && ID_PATTERNS.task.test(task)) query.set("task", task);
  if (run && ID_PATTERNS.run.test(run)) query.set("run", run);
  if (cursor && ID_PATTERNS.artifact.test(cursor)) query.set("cursor", cursor);
  query.set("limit", String(Math.min(200, Math.max(1, limit))));
  return `/api/evidence/artifacts?${query}`;
}

/** Appends a page, replacing a repeated id instead of duplicating it. */
export function mergeArtifacts(previous, page, { append }) {
  const incoming = (
    Array.isArray(page?.artifacts) ? page.artifacts : []
  ).filter((item) => ID_PATTERNS.artifact.test(item?.id ?? ""));
  const base = append ? previous : [];
  const seen = new Map(base.map((item) => [item.id, item]));
  for (const item of incoming) seen.set(item.id, item);
  return [...seen.values()];
}

/** The id one step before or after `id` (clamped, not wrapping); null when `id` is not listed. */
export function neighbor(list, id, delta) {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const next = list[index + delta];
  return next ? next.id : null;
}

/** Whether the lightbox can step in each direction. */
export function stepAvailability(list, id) {
  return {
    previous: neighbor(list, id, -1) !== null,
    next: neighbor(list, id, 1) !== null,
  };
}
