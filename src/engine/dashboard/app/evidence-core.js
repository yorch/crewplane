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
/**
 * Object URLs held at once; older ones are revoked first. The cap follows the
 * number of cards on screen (so a large viewport does not evict what it is
 * showing) but never exceeds HARD_MAX_OBJECT_URLS.
 */
export const MAX_OBJECT_URLS = 12;
export const HARD_MAX_OBJECT_URLS = 36;
/** Bytes held by object URLs at most (the blobs live in memory), videos included. */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
/** Videos can be large; only this many are held at once. */
export const MAX_OBJECT_VIDEOS = 2;
/** How many object URLs to hold for `visible` cards on screen. */
export const urlCapFor = (visible) =>
  Math.min(
    HARD_MAX_OBJECT_URLS,
    Math.max(
      MAX_OBJECT_URLS,
      (Number.isSafeInteger(visible) ? visible : 0) + 2,
    ),
  );
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
 * Bounded three ways: a count (`max`, a number or a function so it can follow
 * the cards on screen), the bytes held (`maxBytes`) and the videos held
 * (`maxVideos`). Pinned keys (the open lightbox) are never evicted; among the
 * others, keys `isVisible` reports are evicted last, then the least recently
 * used first. Evictions are reported through `onEvict` so a card can go back
 * to a Load button.
 */
/**
 * @param {{
 *   create: (blob: any) => string,
 *   revoke: (url: string) => void,
 *   max?: number | (() => number),
 *   maxBytes?: number,
 *   maxVideos?: number,
 *   isVisible?: (key: string) => boolean,
 *   onEvict?: (key: string) => void,
 * }} options
 */
export function createObjectUrlCache({
  create,
  revoke,
  max = MAX_OBJECT_URLS,
  maxBytes = MAX_OBJECT_BYTES,
  maxVideos = MAX_OBJECT_VIDEOS,
  isVisible = () => false,
  onEvict = () => {},
}) {
  const held = new Map(); // key -> { url, bytes, video }, oldest first
  const pinned = new Set();
  const limit = () => (typeof max === "function" ? max() : max);
  let bytes = 0;
  const videos = () => [...held.values()].filter((item) => item.video).length;
  function drop(key) {
    const item = held.get(key);
    if (item === undefined) return false;
    held.delete(key);
    pinned.delete(key);
    bytes -= item.bytes;
    revoke(item.url);
    return true;
  }
  const victim = (only) => {
    const candidates = [...held.keys()].filter(
      (key) => !pinned.has(key) && (!only || held.get(key)?.video),
    );
    return (
      candidates.find((key) => !isVisible(key)) ?? candidates[0] ?? undefined
    );
  };
  function makeRoom(size, video) {
    while (
      held.size >= limit() ||
      (held.size > 0 && bytes + size > maxBytes) ||
      (video && videos() >= maxVideos)
    ) {
      const overVideos = video && videos() >= maxVideos;
      const key = victim(overVideos);
      if (key === undefined) return false;
      drop(key);
      onEvict(key);
    }
    return true;
  }
  return {
    /** Stores a blob and returns its URL, or null when everything held is pinned. */
    acquire(key, blob) {
      const existing = held.get(key);
      if (existing) {
        held.delete(key);
        held.set(key, existing);
        return existing.url;
      }
      const size = Number.isSafeInteger(blob?.size) ? blob.size : 0;
      const video = String(blob?.type ?? "").startsWith("video/");
      if (!makeRoom(size, video)) return null;
      const url = create(blob);
      held.set(key, { url, bytes: size, video });
      bytes += size;
      return url;
    },
    get(key) {
      const item = held.get(key);
      if (item === undefined) return null;
      held.delete(key);
      held.set(key, item);
      return item.url;
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
    get bytes() {
      return bytes;
    },
    keys: () => [...held.keys()],
  };
}

/**
 * Whether a response may become a blob: its declared length (when present) and
 * the bytes actually read must both equal the size recorded for the artifact
 * and stay within the viewing limit. A missing or unreadable Content-Length is
 * not a length of 0; it is simply not declared, and only the bytes read count.
 * Returns an error message, or null when acceptable.
 * @param {{ declared: string | null, size: number, read?: number }} lengths
 */
export function lengthProblem({ declared, size, read }) {
  const tooLarge = "The artifact is larger than the viewing limit.";
  const mismatch = "The artifact's length does not match what was recorded.";
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_VIEW_BYTES)
    return tooLarge;
  if (declared !== null && declared !== undefined && declared !== "") {
    const length = /^\d{1,12}$/.test(String(declared).trim())
      ? Number(declared)
      : Number.NaN;
    if (!Number.isSafeInteger(length)) return mismatch;
    if (length > MAX_VIEW_BYTES) return tooLarge;
    if (length !== size) return mismatch;
  }
  if (read !== undefined) {
    if (read > MAX_VIEW_BYTES) return tooLarge;
    if (read !== size) return mismatch;
  }
  return null;
}

/**
 * A queue that runs at most `limit` jobs at once. `reset()` (leaving the view)
 * forgets the running jobs (they were aborted and may finish whenever) and
 * settles every queued job without running it: a generation counter keeps a
 * finishing old job from freeing a slot it no longer holds, which would drive
 * the running count negative and let more than `limit` jobs run.
 */
export function createFetchQueue(limit) {
  let generation = 0;
  let running = 0;
  const waiting = [];
  return {
    schedule(job) {
      return new Promise((resolve) => {
        const start = () => {
          const mine = generation;
          running += 1;
          let work;
          try {
            work = Promise.resolve(job());
          } catch {
            work = Promise.resolve();
          }
          work
            .catch(() => {})
            .finally(() => {
              if (mine === generation) {
                running -= 1;
                waiting.shift()?.start();
              }
              resolve();
            });
        };
        if (running < limit) start();
        else waiting.push({ start, resolve });
      });
    },
    reset() {
      generation += 1;
      running = 0;
      for (const item of waiting.splice(0)) item.resolve();
    },
    get running() {
      return running;
    },
    get queued() {
      return waiting.length;
    },
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
