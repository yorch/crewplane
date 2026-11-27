// Evidence gallery (#/evidence?task&run&artifact), from /api/evidence/artifacts.
//
// Artifact bytes need the session header, so a plain <img src> cannot fetch
// them. The page fetches the bytes, wraps them in a Blob whose type comes from
// the artifact's allowlisted metadata (and must agree with the response), and
// shows them from a blob: URL. Every object URL is held by one bounded cache
// (12 URLs, more when more cards are on screen up to a hard maximum; at most
// 64 MiB and two videos), evicting off-screen cards first, revoked when
// evicted, when the view is left and on page hide. The declared Content-Length
// and the bytes read must both equal the recorded size before a blob is made.
// Large images, videos and anything not previewable never load by themselves.
// The page never navigates to a blob URL: downloads use an <a download> with a
// fixed safe filename. All artifact text is rendered with textContent.
import { badge } from "./badges.js";
import { copyButton } from "./copy.js";
import { el, emptyState, fields, link } from "./dom.js";
import {
  altText,
  blobKind,
  blobTypeFor,
  createFetchQueue,
  createObjectUrlCache,
  ID_PATTERNS,
  lengthProblem,
  listPath,
  loadPolicy,
  mergeArtifacts,
  neighbor,
  outcomeTone,
  safeFilename,
  stepAvailability,
  urlCapFor,
} from "./evidence-core.js";
import { clearButton, fillSelect, syncClear } from "./filters.js";
import { formatBytes, shortHash } from "./format.js";
import { readJson } from "./resource.js";
import { hrefFor } from "./route.js";
import { setRouteParams } from "./router.js";
import { $, hooks, store } from "./store.js";
import { timeEl } from "./time.js";
import { errorPanel, loadingNote, staleNote } from "./view-parts.js";

const PAGE_LIMIT = 40;
const MORE_LIMIT = 100;
const SEEK_LIMIT = 200;
const MAX_FETCHES = 3;

const gallery = {
  status: "idle",
  artifacts: [],
  nextCursor: null,
  retentionLimited: false,
  queryKey: null,
  error: null,
  loadedAt: null,
  generation: 0,
  seeks: 0,
  notice: null,
};
const runs = new Map(); // run id -> task, for the runs in the current result only
const blobs = new Map(); // artifact id -> { status, message }
const cards = new Map(); // artifact id -> card element
const inflight = new Map(); // artifact id -> AbortController
const queue = createFetchQueue(MAX_FETCHES);
const visible = new Set(); // artifact ids whose card is (nearly) on screen
let listTimer = null;
let listController = null;
let observer = null;
let lastGridKey = "";
let opener = null;
let lightbox = null;
let lightboxKey = "";
let shownId = null;

const downloadKey = (id) => `${id}#download`;
const idOf = (key) => key.replace(/#download$/, "");

const cache = createObjectUrlCache({
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
  max: () => urlCapFor(visible.size),
  isVisible: (key) => visible.has(idOf(key)),
  onEvict: (key) => {
    const id = idOf(key);
    const state = blobs.get(id) ?? { status: "idle", message: "" };
    blobs.set(
      id,
      key === downloadKey(id)
        ? { ...state, download: "idle" }
        : {
            ...state,
            status: "released",
            message: "Preview released to keep memory use low.",
          },
    );
    paintCard(id);
    paintLightbox();
  },
});

const stateOf = (id) => blobs.get(id) ?? { status: "idle", message: "" };
const find = (id) => gallery.artifacts.find((item) => item.id === id) ?? null;
const routeQuery = () => ({
  task: store.route.params.task,
  run: store.route.params.run,
});
const queryKey = () => JSON.stringify(routeQuery());
const mediaKind = (artifact) => blobKind(artifact.mime);

// ---- Fetching bytes ---------------------------------------------------------
const schedule = (job) => queue.schedule(job);

/** Reads a body, stopping as soon as it grows past `limit` bytes. */
async function readBounded(response, limit) {
  if (!response.body?.getReader) {
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > limit ? null : bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function fetchBytes(artifact, signal) {
  const response = await window.crewplaneFetch(
    `/api/evidence/artifacts/${artifact.id}`,
    { cache: "no-store", signal },
  );
  if (response.status === 404)
    throw new Error("This artifact is no longer retained.");
  if (!response.ok) throw new Error("The artifact could not be read.");
  // The declared length (when there is one) must equal the recorded size
  // before a byte is read; the bytes read must equal it afterwards.
  const declared = response.headers.get("content-length");
  const before = lengthProblem({ declared, size: artifact.size });
  if (before) {
    await response.body?.cancel().catch(() => {});
    throw new Error(before);
  }
  const bytes = await readBounded(response, artifact.size);
  const after = lengthProblem({
    declared,
    size: artifact.size,
    read: bytes === null ? artifact.size + 1 : bytes.byteLength,
  });
  if (after) throw new Error(after);
  return { bytes, type: response.headers.get("content-type") };
}

/** Loads a preview (or, with `download`, a download-only copy) into the bounded cache. */
function loadBlob(artifact, { download = false } = {}) {
  const id = artifact.id;
  const current = stateOf(id);
  const policy = loadPolicy(artifact);
  if (policy === "blocked") {
    blobs.set(id, {
      status: "blocked",
      message: `Too large to preview (${formatBytes(artifact.size) ?? "unknown size"}). Nothing was loaded.`,
    });
    paintCard(id);
    return Promise.resolve();
  }
  if (!download && policy === "download-only") return Promise.resolve();
  if (download ? current.download === "loading" : current.status === "loading")
    return Promise.resolve();
  if (!download && current.status === "ready" && cache.has(id))
    return Promise.resolve();
  blobs.set(
    id,
    download
      ? { ...current, download: "loading" }
      : { ...current, status: "loading", message: "" },
  );
  paintCard(id);
  paintLightbox();
  const controller = new AbortController();
  inflight.set(`${id}:${download}`, controller);
  return schedule(async () => {
    try {
      const { bytes, type } = await fetchBytes(artifact, controller.signal);
      let blobType = "application/octet-stream";
      if (!download) {
        // The recorded type must be allowlisted and the response must agree.
        const decision = blobTypeFor(artifact.mime, type);
        if (!decision.ok) {
          blobs.set(id, {
            ...stateOf(id),
            status: "unsupported",
            message: decision.reason,
          });
          return;
        }
        blobType = decision.type;
      }
      const key = download ? downloadKey(id) : id;
      const url = cache.acquire(key, new Blob([bytes], { type: blobType }));
      if (url === null) throw new Error("Too many items are open at once.");
      blobs.set(
        id,
        download
          ? { ...stateOf(id), download: "ready" }
          : { status: "ready", message: "" },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      const failed = download
        ? { ...stateOf(id), download: "error" }
        : {
            status: "error",
            message: error?.message || "The artifact could not be loaded.",
          };
      blobs.set(id, failed);
    } finally {
      inflight.delete(`${id}:${download}`);
      paintCard(id);
      paintLightbox();
    }
  });
}

// ---- Gallery data -----------------------------------------------------------
async function loadList({ append = false, limit, notice = null } = {}) {
  clearTimeout(listTimer);
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  gallery.notice = notice;
  if (!append) {
    gallery.generation += 1;
    gallery.seeks = 0;
  }
  const generation = gallery.generation;
  gallery.status = "loading";
  gallery.queryKey = queryKey();
  try {
    const page = await readJson(
      listPath({
        ...routeQuery(),
        ...(append && gallery.nextCursor ? { cursor: gallery.nextCursor } : {}),
        limit: limit ?? (append ? MORE_LIMIT : PAGE_LIMIT),
      }),
      { signal: controller.signal },
    );
    if (generation !== gallery.generation) return;
    gallery.artifacts = mergeArtifacts(gallery.artifacts, page, { append });
    // The Run filter offers the runs of what is listed now, not of every
    // query this page has ever made.
    runs.clear();
    for (const item of gallery.artifacts)
      if (ID_PATTERNS.run.test(item.run ?? "")) runs.set(item.run, item.task);
    gallery.nextCursor =
      typeof page.nextCursor === "string" &&
      ID_PATTERNS.artifact.test(page.nextCursor)
        ? page.nextCursor
        : null;
    gallery.retentionLimited = page.retentionLimited === true;
    gallery.status = "ready";
    gallery.error = null;
    gallery.loadedAt = Date.now();
  } catch (error) {
    if (controller.signal.aborted || generation !== gallery.generation) return;
    if (append && error?.status === 400 && gallery.nextCursor) {
      // The cursor named an artifact the store has since pruned. What is on
      // screen stays (and keeps its place) while the list is read again from
      // the start, far enough to cover what was already loaded.
      gallery.nextCursor = null;
      return loadList({
        limit: Math.min(
          SEEK_LIMIT,
          Math.max(PAGE_LIMIT, gallery.artifacts.length),
        ),
        notice:
          "The list changed while you were browsing (older evidence was removed), so it was loaded again from the start.",
      });
    }
    gallery.status = "error";
    gallery.error = { status: error?.status ?? 0, message: error?.message };
  }
  seekDeepLink();
  paintAll();
}

// A deep link to an artifact outside the first page: keep paging (bounded)
// until it shows up or the list ends.
function seekDeepLink() {
  const id = store.route.params.artifact;
  if (
    !id ||
    find(id) ||
    gallery.status !== "ready" ||
    !gallery.nextCursor ||
    gallery.seeks >= 10
  )
    return;
  gallery.seeks += 1;
  loadList({ append: true, limit: SEEK_LIMIT });
}

function ensureList() {
  const key = queryKey();
  if (gallery.queryKey === key && gallery.status !== "idle") return;
  const first = gallery.queryKey === null;
  gallery.queryKey = key;
  gallery.status = "loading";
  gallery.artifacts = [];
  gallery.nextCursor = null;
  gallery.generation += 1;
  clearTimeout(listTimer);
  // A task being typed is debounced; opening the view or picking a run is not.
  listTimer = setTimeout(() => loadList(), first ? 0 : 300);
}

// ---- Card -------------------------------------------------------------------
const kindName = (artifact) =>
  mediaKind(artifact) === "video"
    ? "Video"
    : mediaKind(artifact) === "image"
      ? "Image"
      : "File";
const viewportText = (artifact) =>
  Number.isSafeInteger(artifact.viewport?.width) &&
  Number.isSafeInteger(artifact.viewport?.height)
    ? `${artifact.viewport.width} × ${artifact.viewport.height}`
    : null;
const openHref = (id) =>
  hrefFor("evidence", { ...store.route.params, artifact: id });

function loadButton(artifact, label, focusPrefix = "load") {
  const button = el("button", label, "text-button");
  button.type = "button";
  button.dataset.focusKey = `${focusPrefix}:${artifact.id}`;
  button.addEventListener("click", () => loadBlob(artifact));
  return button;
}

function paintMedia(artifact, host) {
  const state = stateOf(artifact.id);
  const policy = loadPolicy(artifact);
  const kind = mediaKind(artifact);
  const url = state.status === "ready" ? cache.get(artifact.id) : null;
  let content;
  if (policy === "download-only") {
    content = el("div", undefined, "media-note");
    content.append(
      el("strong", "Not previewed"),
      el(
        "span",
        "This file type is not one the dashboard previews. It can only be downloaded, from the larger view.",
      ),
    );
  } else if (policy === "blocked") {
    content = el(
      "p",
      `Too large to preview (${formatBytes(artifact.size) ?? "unknown size"}). Nothing was loaded.`,
      "media-note",
    );
  } else if (kind === "video") {
    content = el("div", undefined, "media-note");
    content.append(
      el("strong", "Video"),
      el(
        "span",
        `${formatBytes(artifact.size) ?? "Unknown size"}. Open the larger view to load and play it.`,
      ),
    );
  } else if (url) {
    const anchor = link(openHref(artifact.id), undefined, "thumb-link");
    anchor.tabIndex = -1;
    anchor.dataset.focusKey = `thumb:${artifact.id}`;
    const image = document.createElement("img");
    image.alt = altText(artifact);
    image.decoding = "async";
    image.src = url;
    image.addEventListener("error", () => {
      blobs.set(artifact.id, {
        status: "error",
        message: "The image could not be displayed.",
      });
      cache.release(artifact.id);
      paintCard(artifact.id);
    });
    anchor.append(image);
    content = anchor;
  } else if (state.status === "loading")
    content = loadingNote("Loading preview…");
  else if (state.status === "error" || state.status === "unsupported")
    content = (() => {
      const box = el("div", undefined, "media-note");
      box.append(el("span", state.message));
      if (state.status === "error")
        box.append(loadButton(artifact, "Try again", "retry-load"));
      return box;
    })();
  else if (state.status === "released")
    content = (() => {
      const box = el("div", undefined, "media-note");
      box.append(
        el("span", state.message),
        loadButton(artifact, "Load preview"),
      );
      return box;
    })();
  else if (policy === "auto") {
    content = el(
      "p",
      "Preview loads when this card is visible.",
      "media-note is-unknown",
    );
    content.dataset.autoLoad = artifact.id;
  } else
    content = (() => {
      const box = el("div", undefined, "media-note");
      box.append(
        el(
          "span",
          `Large image (${formatBytes(artifact.size) ?? "unknown size"}).`,
        ),
        loadButton(artifact, "Load preview"),
      );
      return box;
    })();
  const hadFocus = host.contains(document.activeElement);
  host.replaceChildren(content);
  if (hadFocus)
    host.parentElement
      ?.querySelector(
        `[data-focus-key="${CSS.escape(`artifact:${artifact.id}`)}"]`,
      )
      ?.focus({ preventScroll: true });
}

function buildCard(artifact) {
  const card = el("li", undefined, "evidence-card");
  card.dataset.artifactId = artifact.id;
  const media = el("div", undefined, "evidence-media");
  const meta = el("div", undefined, "evidence-meta");
  const tags = el("div", undefined, "detail-tags");
  tags.append(
    badge(kindName(artifact), "neutral"),
    badge(artifact.outcome ?? "unknown", outcomeTone(artifact.outcome)),
    el("span", artifact.mime ?? "unknown type", "mono count"),
  );
  const title = el(
    "h2",
    [artifact.scenario, artifact.route].filter(Boolean).join(" · ") ||
      "Artifact",
    "evidence-title",
  );
  const hash = shortHash(artifact.sha256);
  const hashCell = hash
    ? (() => {
        const wrap = el("span", undefined, "digest-line");
        wrap.append(
          el("code", hash, "mono"),
          copyButton(artifact.sha256, {
            key: `sha:${artifact.id}`,
            what: "SHA-256 digest",
          }),
        );
        return wrap;
      })()
    : null;
  const facts = fields(
    [
      [
        "Task",
        artifact.task
          ? link(
              hrefFor("tasks", { task: artifact.task }),
              artifact.task,
              "mono",
            )
          : null,
      ],
      ["Captured", artifact.createdAt ? timeEl(artifact.createdAt) : null],
      ["Size", formatBytes(artifact.size)],
      ["Viewport", viewportText(artifact)],
      [
        "Run",
        artifact.run ? shortHash(artifact.run.replace(/^qa_/, ""), 8) : null,
      ],
      ["SHA-256", hashCell],
    ],
    "fields-inline",
  );
  const actions = el("div", undefined, "detail-actions");
  const view = link(openHref(artifact.id), "View larger", "evidence-open");
  view.dataset.focusKey = `artifact:${artifact.id}`;
  view.setAttribute("aria-label", `View larger: ${altText(artifact)}`);
  actions.append(view);
  if (artifact.run)
    actions.append(
      link(hrefFor("evidence", { run: artifact.run }), "Only this run"),
    );
  if (artifact.task)
    actions.append(
      link(hrefFor("runs", { task: artifact.task }), "Runs for this task"),
    );
  meta.append(tags, title, facts, actions);
  card.append(media, meta);
  return card;
}
function paintCard(id) {
  const card = cards.get(id);
  const artifact = find(id);
  if (!card || !artifact) return;
  paintMedia(artifact, card.querySelector(".evidence-media"));
}

// ---- Lightbox ---------------------------------------------------------------
function trapTab(event, root) {
  if (event.key !== "Tab") return;
  const focusable = [
    ...root.querySelectorAll(
      "button, a[href], video[controls], [tabindex='0']",
    ),
  ].filter((node) => !node.disabled && !node.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (
    event.shiftKey &&
    (document.activeElement === first ||
      document.activeElement === root ||
      document.activeElement?.id === "lightbox-title")
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
function closeHref() {
  return hrefFor("evidence", { ...store.route.params, artifact: undefined });
}
function stepTo(delta) {
  const next = neighbor(gallery.artifacts, store.route.params.artifact, delta);
  if (next) setRouteParams({ artifact: next });
}

function ensureLightbox() {
  if (lightbox) return lightbox;
  lightbox = el("dialog", undefined, "lightbox");
  lightbox.id = "lightbox";
  lightbox.setAttribute("aria-labelledby", "lightbox-title");
  lightbox.addEventListener("cancel", (event) => {
    event.preventDefault();
    window.crewplane.navigate(closeHref());
  });
  lightbox.addEventListener("close", () => {
    const id = shownId;
    shownId = null;
    lightboxKey = "";
    if (id) cache.unpin(id);
    if (store.route.view !== "evidence") {
      opener = null;
      return;
    }
    const target =
      (opener?.isConnected ? opener : null) ??
      document.querySelector(
        `[data-focus-key="${CSS.escape(`artifact:${id}`)}"]`,
      ) ??
      $("view-title");
    target?.focus({ preventScroll: true });
    opener = null;
  });
  lightbox.addEventListener("keydown", (event) => {
    trapTab(event, lightbox);
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !["VIDEO", "INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)
    ) {
      event.preventDefault();
      stepTo(event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  document.body.append(lightbox);
  return lightbox;
}

function lightboxMedia(artifact) {
  const state = stateOf(artifact.id);
  const policy = loadPolicy(artifact);
  const kind = mediaKind(artifact);
  const url = state.status === "ready" ? cache.get(artifact.id) : null;
  const box = el("div", undefined, "lightbox-media");
  if (policy === "download-only") {
    box.append(
      el("p", "This file type is not previewed.", "media-warning"),
      el(
        "p",
        `Recorded type: ${artifact.mime ?? "unknown"}. It is offered as a download only; open it only if you trust where it came from.`,
        "note",
      ),
    );
  } else if (policy === "blocked") {
    box.append(
      el(
        "p",
        `Too large to preview (${formatBytes(artifact.size) ?? "unknown size"}). Nothing was loaded.`,
        "media-warning",
      ),
    );
  } else if (url && kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = url;
    video.setAttribute("aria-label", altText(artifact));
    box.append(video);
  } else if (url) {
    const image = document.createElement("img");
    image.alt = altText(artifact);
    image.src = url;
    box.append(image);
  } else if (state.status === "loading") box.append(loadingNote("Loading…"));
  else if (state.status === "unsupported")
    box.append(el("p", state.message, "media-warning"));
  else {
    if (state.status === "error" || state.status === "released")
      box.append(el("p", state.message, "media-warning"));
    const label =
      state.status === "error"
        ? "Try again"
        : `Load ${kind === "video" ? "video" : "image"} (${formatBytes(artifact.size) ?? "unknown size"})`;
    const button = el("button", label, "control-button primary");
    button.type = "button";
    button.dataset.focusKey = "lightbox-load";
    button.addEventListener("click", () => loadBlob(artifact));
    box.append(button);
  }
  return box;
}

function lightboxContent(artifact) {
  const nodes = [];
  const state = stateOf(artifact.id);
  const policy = loadPolicy(artifact);
  const head = el("div", undefined, "lightbox-head");
  const title = el(
    "h2",
    [artifact.scenario, artifact.route].filter(Boolean).join(" · ") ||
      "Evidence artifact",
  );
  title.id = "lightbox-title";
  title.tabIndex = -1;
  title.dataset.focusKey = "lightbox-title";
  const position =
    gallery.artifacts.findIndex((item) => item.id === artifact.id) + 1;
  head.append(
    title,
    el(
      "span",
      `${position} of ${gallery.artifacts.length}${gallery.nextCursor ? "+" : ""}`,
      "count",
    ),
  );
  const close = link(closeHref(), "Close", "control-button");
  close.dataset.focusKey = "lightbox-close";
  close.setAttribute("aria-label", "Close larger view");
  head.append(close);
  nodes.push(head, lightboxMedia(artifact));
  const steps = stepAvailability(gallery.artifacts, artifact.id);
  const bar = el("div", undefined, "lightbox-actions");
  for (const [label, delta, enabled] of [
    ["Previous", -1, steps.previous],
    ["Next", 1, steps.next],
  ]) {
    const button = el("button", label, "control-button");
    button.type = "button";
    button.disabled = !enabled;
    button.dataset.focusKey = `lightbox-${label.toLowerCase()}`;
    button.addEventListener("click", () => stepTo(delta));
    bar.append(button);
  }
  // Downloads go through a blob: URL and a fixed filename, never a navigation.
  const downloadUrl =
    state.status === "ready" && policy !== "download-only"
      ? cache.get(artifact.id)
      : state.download === "ready"
        ? cache.get(downloadKey(artifact.id))
        : null;
  if (downloadUrl) {
    const anchor = el("a", "Download file", "control-button");
    anchor.href = downloadUrl;
    anchor.download = safeFilename(artifact);
    anchor.dataset.focusKey = "lightbox-download";
    bar.append(anchor);
  } else if (policy !== "blocked") {
    const prepare = el(
      "button",
      state.download === "loading" ? "Preparing download…" : "Prepare download",
      "control-button",
    );
    prepare.type = "button";
    prepare.disabled = state.download === "loading";
    prepare.dataset.focusKey = "lightbox-prepare";
    prepare.addEventListener("click", () =>
      loadBlob(artifact, { download: true }),
    );
    bar.append(prepare);
  }
  nodes.push(bar);
  if (state.download === "error")
    nodes.push(el("p", "The download could not be prepared.", "media-warning"));
  const hash = shortHash(artifact.sha256, 64);
  nodes.push(
    fields([
      [
        "Kind and type",
        `${kindName(artifact)} · ${artifact.mime ?? "unknown"}`,
      ],
      ["Size", formatBytes(artifact.size)],
      ["Captured", artifact.createdAt ? timeEl(artifact.createdAt) : null],
      ["Scenario", artifact.scenario],
      ["Route", artifact.route],
      [
        "Step",
        Number.isSafeInteger(artifact.step) ? String(artifact.step) : null,
      ],
      ["Viewport", viewportText(artifact)],
      ["Browser", artifact.browser],
      ["Outcome", artifact.outcome],
      [
        "Task",
        artifact.task
          ? link(
              hrefFor("tasks", { task: artifact.task }),
              artifact.task,
              "mono",
            )
          : null,
      ],
      ["Agent", artifact.lane],
      ["Tested commit", shortHash(artifact.testedCommit, 12)],
      [
        "Findings",
        Array.isArray(artifact.findingIds) && artifact.findingIds.length
          ? `${artifact.findingIds.length} recorded`
          : null,
        "None",
      ],
      [
        "Recheck of",
        artifact.recheckOf
          ? shortHash(artifact.recheckOf.replace(/^ev_/, ""), 12)
          : null,
        "Not a recheck",
      ],
      [
        "SHA-256",
        hash
          ? (() => {
              const wrap = el("span", undefined, "digest-line");
              wrap.append(
                el("code", hash, "mono digest-full"),
                copyButton(artifact.sha256, {
                  key: `lbsha:${artifact.id}`,
                  what: "SHA-256 digest",
                }),
              );
              return wrap;
            })()
          : null,
      ],
    ]),
  );
  return nodes;
}

function paintLightbox() {
  const id = store.route.params.artifact;
  if (store.route.view !== "evidence" || !id) return;
  const dialog = ensureLightbox();
  const artifact = find(id);
  const state = artifact ? stateOf(id) : null;
  const signature = JSON.stringify([
    id,
    Boolean(artifact),
    state?.status,
    state?.download,
    state?.message,
    gallery.artifacts.length,
    gallery.nextCursor,
    gallery.status,
    cache.has(id),
  ]);
  if (dialog.open && signature === lightboxKey) return;
  lightboxKey = signature;
  const previous = document.activeElement;
  const firstOpen = !dialog.open;
  const focusKey = dialog.contains(previous)
    ? previous.dataset?.focusKey
    : null;
  if (shownId && shownId !== id) cache.unpin(shownId);
  shownId = id;
  if (!dialog.open) {
    opener = document.activeElement;
    dialog.showModal();
  }
  if (!artifact) {
    const missing =
      gallery.status === "loading" ||
      (gallery.status === "ready" && gallery.nextCursor);
    const title = el("h2", "Evidence artifact");
    title.id = "lightbox-title";
    title.tabIndex = -1;
    title.dataset.focusKey = "lightbox-title";
    const close = link(closeHref(), "Close", "control-button");
    close.dataset.focusKey = "lightbox-close";
    close.setAttribute("aria-label", "Close larger view");
    dialog.replaceChildren(
      title,
      missing
        ? loadingNote("Looking for this artifact…")
        : el(
            "p",
            gallery.status === "error"
              ? "The gallery could not be loaded, so this artifact cannot be shown."
              : "This artifact is not available. It may have been removed by retention or it does not match the current filters.",
            "media-warning",
          ),
      close,
    );
  } else {
    // A pinned preview is never evicted, so the open item stays loaded.
    cache.pin(id);
    dialog.replaceChildren(...lightboxContent(artifact));
    if (loadPolicy(artifact) === "auto" && stateOf(id).status === "idle")
      loadBlob(artifact);
  }
  const target =
    (focusKey &&
      dialog.querySelector(
        `[data-focus-key="${CSS.escape(focusKey)}"]:not(:disabled)`,
      )) ||
    dialog.querySelector("#lightbox-title");
  if (firstOpen || focusKey) target?.focus({ preventScroll: true });
}
function closeLightbox() {
  if (lightbox?.open) lightbox.close();
}

// ---- View -------------------------------------------------------------------
// Every card's media box stays observed while it is in the grid: that tells the
// object-URL cache which previews are on screen (evicted last, and the cap
// grows with them) and loads an image that scrolls into view.
function ensureObserver() {
  if (observer || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id =
          entry.target.closest("[data-artifact-id]")?.dataset.artifactId;
        if (!id) continue;
        if (!entry.isIntersecting) {
          visible.delete(id);
          continue;
        }
        visible.add(id);
        const artifact = find(id);
        if (
          artifact &&
          loadPolicy(artifact) === "auto" &&
          stateOf(id).status === "idle"
        )
          loadBlob(artifact);
      }
    },
    { rootMargin: "200px" },
  );
}
const mediaOf = (card) => card.querySelector(".evidence-media");
/** Stops observing cards that left the grid (their nodes may be gone). */
function forgetCards(keep) {
  for (const [id, card] of cards) {
    if (keep?.has(id)) continue;
    observer?.unobserve(mediaOf(card));
    visible.delete(id);
  }
}

function fillRunFilter() {
  const select = $("evidence-run");
  const ids = [...runs.keys()];
  fillSelect(select, "All runs", ids, (id) => {
    const task = runs.get(id);
    return `${shortHash(id.replace(/^qa_/, ""), 8) ?? id}${task ? ` · ${task}` : ""}`;
  });
}

function renderGrid() {
  const host = $("evidence-list");
  const params = store.route.params;
  const filtered = Boolean(params.task || params.run);
  const key = JSON.stringify([
    gallery.status,
    gallery.artifacts.map((item) => item.id),
    gallery.nextCursor,
    gallery.error?.message,
    gallery.notice,
    params.task,
    params.run,
  ]);
  if (key === lastGridKey && host.firstElementChild) return;
  lastGridKey = key;
  const nodes = [];
  if (gallery.notice) {
    const bar = el("div", gallery.notice, "banner banner-inline");
    bar.setAttribute("role", "status");
    nodes.push(bar);
  }
  if (gallery.status === "error" && gallery.artifacts.length)
    nodes.push(staleNote(gallery.error, gallery.loadedAt, () => loadList()));
  if (!gallery.artifacts.length) {
    if (gallery.status === "error")
      nodes.push(
        errorPanel("the evidence gallery", gallery.error, () => loadList()),
      );
    else if (gallery.status !== "ready")
      nodes.push(loadingNote("Loading evidence…"));
    else {
      const empty = emptyState(
        filtered
          ? "No evidence matches these filters."
          : "No evidence has been captured.",
        filtered
          ? undefined
          : "Screenshots and recordings appear here after they are added with crewplane evidence append.",
      );
      if (filtered) empty.append(clearButton("evidence"));
      nodes.push(empty);
    }
    host.replaceChildren(...nodes);
    forgetCards();
    cards.clear();
    return;
  }
  const grid = el("ul", undefined, "evidence-grid");
  const next = new Map();
  for (const artifact of gallery.artifacts) {
    const card = cards.get(artifact.id) ?? buildCard(artifact);
    next.set(artifact.id, card);
    grid.append(card);
  }
  forgetCards(next);
  const added = [...next].filter(([id]) => !cards.has(id));
  cards.clear();
  for (const [id, card] of next) cards.set(id, card);
  for (const [, card] of added) observer?.observe(mediaOf(card));
  nodes.push(grid);
  if (gallery.nextCursor) {
    const more = el("button", "Load more", "more-button");
    more.type = "button";
    more.dataset.focusKey = "evidence-more";
    more.addEventListener("click", () => loadList({ append: true }));
    nodes.push(more);
  }
  host.replaceChildren(...nodes);
  for (const id of next.keys()) paintCard(id);
}

function paintAll() {
  if (store.route.view === "evidence") hooks.render();
}

export function renderEvidence() {
  ensureObserver();
  ensureList();
  syncClear("evidence");
  fillRunFilter();
  for (const [id, key] of [
    ["evidence-task", "task"],
    ["evidence-run", "run"],
  ]) {
    const value = store.route.params[key] ?? "";
    const control = $(id);
    if (document.activeElement !== control && control.value !== value)
      control.value = value;
  }
  const taskText = $("evidence-task").value;
  const invalid = taskText !== "" && !ID_PATTERNS.task.test(taskText);
  $("evidence-task").setAttribute("aria-invalid", String(invalid));
  $("evidence-task-help").textContent = invalid
    ? "Task ids use letters, digits, hyphen and underscore. This filter is ignored."
    : "";
  $("evidence-count").textContent =
    gallery.status === "loading" && !gallery.artifacts.length
      ? ""
      : `${gallery.artifacts.length} ${gallery.artifacts.length === 1 ? "artifact" : "artifacts"} loaded${gallery.nextCursor ? ", more available" : ""}`;
  $("evidence-note").textContent = gallery.retentionLimited
    ? "The evidence store keeps a limited number of runs, so older captures may have been removed."
    : "";
  renderGrid();
  if (store.route.params.artifact) {
    paintLightbox();
    seekDeepLink();
  } else closeLightbox();
}

/** Leaving the view releases every object URL and cancels pending loads. */
export function leaveEvidence() {
  closeLightbox();
  cache.clear();
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
  queue.reset();
  listController?.abort();
  clearTimeout(listTimer);
  observer?.disconnect();
  visible.clear();
  for (const [id, state] of blobs)
    blobs.set(id, {
      status: "idle",
      message: "",
      download: state.download && "idle",
    });
  cards.clear();
  lastGridKey = "";
  if (gallery.status === "loading") gallery.status = "idle";
  gallery.queryKey = gallery.status === "idle" ? null : gallery.queryKey;
}

export function openEvidence() {
  // Always read the list again when the view opens.
  gallery.queryKey = null;
  gallery.status = "idle";
}

export function refreshEvidence() {
  loadList();
}

window.addEventListener("pagehide", () => cache.clear());
