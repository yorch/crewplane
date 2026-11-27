import { expect, it } from "vitest";
import {
  AUTO_LOAD_MAX_BYTES,
  altText,
  BLOB_TYPES,
  baseType,
  blobKind,
  blobTypeFor,
  createFetchQueue,
  createObjectUrlCache,
  HARD_MAX_OBJECT_URLS,
  ID_PATTERNS,
  lengthProblem,
  listPath,
  loadPolicy,
  MAX_OBJECT_BYTES,
  MAX_OBJECT_URLS,
  MAX_OBJECT_VIDEOS,
  MAX_VIEW_BYTES,
  mergeArtifacts,
  neighbor,
  outcomeTone,
  safeFilename,
  stepAvailability,
  urlCapFor,
} from "./evidence-core.js";

const id = (n: number) => `ev_${n.toString(16).padStart(32, "0")}`;
const art = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  mime: "image/png",
  size: 1000,
  route: "dashboard",
  scenario: "initial",
  step: 0,
  viewport: { width: 390, height: 844 },
  outcome: "captured",
  ...extra,
});

it("allows exactly the four server types and no others", () => {
  expect(Object.keys(BLOB_TYPES).sort()).toEqual([
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/webm",
  ]);
  expect(blobKind("image/png")).toBe("image");
  expect(blobKind("video/webm")).toBe("video");
  for (const bad of [
    "image/svg+xml",
    "text/html",
    "application/octet-stream",
    "image/gif",
    "constructor",
    "__proto__",
    null,
    undefined,
    "IMAGE/PNG",
  ])
    expect(blobKind(bad)).toBeNull();
});

it("gives a blob its allowlisted type only when the response agrees", () => {
  expect(baseType("Image/PNG; charset=binary")).toBe("image/png");
  expect(blobTypeFor("image/png", "image/png")).toEqual({
    ok: true,
    type: "image/png",
  });
  expect(blobTypeFor("image/webp", "image/webp; foo=bar")).toEqual({
    ok: true,
    type: "image/webp",
  });
  // The response header alone never decides.
  expect(blobTypeFor("image/png", "text/html").ok).toBe(false);
  expect(blobTypeFor("image/png", "application/octet-stream").ok).toBe(false);
  expect(blobTypeFor("image/png", null).ok).toBe(false);
  // A recorded type outside the allowlist is refused even if the header matches.
  expect(blobTypeFor("image/svg+xml", "image/svg+xml").ok).toBe(false);
  expect(blobTypeFor("text/html", "text/html").ok).toBe(false);
  expect(
    blobTypeFor("application/octet-stream", "application/octet-stream").ok,
  ).toBe(false);
  expect(blobTypeFor("image/png", "image/jpeg").reason).toMatch(
    /different type/,
  );
});

it("decides how an artifact is offered by type and size", () => {
  expect(loadPolicy(art(1))).toBe("auto");
  expect(loadPolicy(art(1, { size: AUTO_LOAD_MAX_BYTES }))).toBe("auto");
  expect(loadPolicy(art(1, { size: AUTO_LOAD_MAX_BYTES + 1 }))).toBe("manual");
  expect(loadPolicy(art(1, { mime: "video/webm", size: 10 }))).toBe("manual");
  expect(loadPolicy(art(1, { size: MAX_VIEW_BYTES }))).toBe("manual");
  expect(loadPolicy(art(1, { size: MAX_VIEW_BYTES + 1 }))).toBe("blocked");
  expect(loadPolicy(art(1, { size: null }))).toBe("blocked");
  expect(loadPolicy(art(1, { size: -1 }))).toBe("blocked");
  expect(loadPolicy(art(1, { mime: "application/octet-stream" }))).toBe(
    "download-only",
  );
  expect(loadPolicy(art(1, { mime: "image/svg+xml" }))).toBe("download-only");
  expect(loadPolicy(null)).toBe("download-only");
});

it("names downloads with a fixed safe filename", () => {
  expect(safeFilename(art(5))).toBe(`crewplane-evidence-${id(5)}.png`);
  expect(safeFilename(art(5, { mime: "image/jpeg" }))).toMatch(/\.jpg$/);
  expect(safeFilename(art(5, { mime: "video/webm" }))).toMatch(/\.webm$/);
  const hostile = safeFilename({
    id: '../../x"><img src=x onerror=alert(1)>',
    mime: "text/html",
  });
  expect(hostile).toBe("crewplane-evidence-artifact.bin");
  expect(hostile).toMatch(/^[A-Za-z0-9._-]+$/);
});

it("builds alt text from capture metadata and keeps it bounded", () => {
  expect(altText(art(1))).toBe(
    "Screenshot of dashboard, scenario initial, step 0, 390 by 844 pixels, outcome captured",
  );
  expect(altText(art(1, { mime: "video/webm" }))).toMatch(/^Recording of/);
  expect(altText({ mime: "image/png" })).toBe("Screenshot");
  const hostile = altText(
    art(1, {
      route: "<img src=x onerror=alert(1)>",
      scenario: "x".repeat(500),
    }),
  );
  expect(hostile.length).toBeLessThanOrEqual(200);
  expect(hostile).toContain("<img src=x onerror=alert(1)>");
  expect(outcomeTone("finding")).toBe("danger");
  expect(outcomeTone("captured")).toBe("neutral");
  expect(outcomeTone("recheck")).toBe("info");
  expect(outcomeTone("constructor")).toBe("unknown");
});

it("holds at most the cap of object URLs and revokes the least recently used", () => {
  let next = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const evicted: string[] = [];
  const cache = createObjectUrlCache({
    create: () => {
      const url = `blob:test/${next++}`;
      created.push(url);
      return url;
    },
    revoke: (url: string) => revoked.push(url),
    onEvict: (key: string) => evicted.push(key),
    max: 3,
  });
  expect(MAX_OBJECT_URLS).toBe(12);
  cache.acquire("a", {});
  cache.acquire("b", {});
  cache.acquire("c", {});
  expect(cache.size).toBe(3);
  // Touching "a" makes "b" the oldest.
  expect(cache.get("a")).toBe("blob:test/0");
  cache.acquire("d", {});
  expect(revoked).toEqual(["blob:test/1"]);
  expect(evicted).toEqual(["b"]);
  expect(cache.size).toBe(3);
  expect(cache.has("b")).toBe(false);
  // Re-acquiring a held key does not create another URL.
  expect(cache.acquire("a", {})).toBe("blob:test/0");
  expect(created).toHaveLength(4);
  cache.clear();
  expect(cache.size).toBe(0);
  expect(revoked.sort()).toEqual(created.sort());
});

it("never evicts pinned keys and refuses to exceed the cap when all are pinned", () => {
  let next = 0;
  const revoked: string[] = [];
  const cache = createObjectUrlCache({
    create: () => `blob:p/${next++}`,
    revoke: (url: string) => revoked.push(url),
    max: 2,
  });
  cache.acquire("a", {});
  cache.acquire("b", {});
  cache.pin("a");
  cache.pin("b");
  expect(cache.acquire("c", {})).toBeNull();
  expect(cache.size).toBe(2);
  expect(revoked).toEqual([]);
  cache.unpin("b");
  expect(cache.acquire("c", {})).toBe("blob:p/2");
  expect(revoked).toEqual(["blob:p/1"]);
  expect(cache.keys()).toEqual(["a", "c"]);
  expect(cache.release("a")).toBe(true);
  expect(cache.release("a")).toBe(false);
  cache.pin("missing");
  expect(cache.has("missing")).toBe(false);
});

it("revokes every URL exactly once", () => {
  let next = 0;
  const revoked: string[] = [];
  const cache = createObjectUrlCache({
    create: () => `blob:q/${next++}`,
    revoke: (url: string) => revoked.push(url),
    max: 2,
  });
  for (const key of ["a", "b", "c", "d", "e"]) cache.acquire(key, {});
  cache.clear();
  cache.clear();
  expect(next).toBe(5);
  expect(new Set(revoked).size).toBe(5);
  expect(revoked).toHaveLength(5);
});

it("validates filters before building the list path", () => {
  expect(ID_PATTERNS.run.test(`qa_${"a".repeat(32)}`)).toBe(true);
  expect(listPath({})).toBe("/api/evidence/artifacts?limit=40");
  expect(
    listPath({
      task: "CP-101",
      run: `qa_${"b".repeat(32)}`,
      cursor: id(9),
      limit: 500,
    }),
  ).toBe(
    `/api/evidence/artifacts?task=CP-101&run=qa_${"b".repeat(32)}&cursor=${id(9)}&limit=200`,
  );
  expect(
    listPath({ task: "../x", run: "qa_nope", cursor: `qa_${"a".repeat(32)}` }),
  ).toBe("/api/evidence/artifacts?limit=40");
  expect(listPath({ limit: 0 })).toBe("/api/evidence/artifacts?limit=1");
});

it("merges pages without duplicating ids and ignores malformed items", () => {
  const first = mergeArtifacts(
    [],
    { artifacts: [art(1), art(2)] },
    { append: false },
  );
  const more = mergeArtifacts(
    first,
    { artifacts: [art(2, { size: 5 }), art(3), { id: "<x>" }, null] },
    { append: true },
  );
  expect(more.map((a) => a.id)).toEqual([id(1), id(2), id(3)]);
  expect(more[1]?.size).toBe(5);
  expect(
    mergeArtifacts(more, { artifacts: [art(7)] }, { append: false }),
  ).toHaveLength(1);
  expect(mergeArtifacts([], null, { append: false })).toEqual([]);
});

it("steps through the list for the lightbox arrows", () => {
  const list = [art(1), art(2), art(3)];
  expect(neighbor(list, id(2), 1)).toBe(id(3));
  expect(neighbor(list, id(2), -1)).toBe(id(1));
  expect(neighbor(list, id(1), -1)).toBeNull();
  expect(neighbor(list, id(3), 1)).toBeNull();
  expect(neighbor(list, id(9), 1)).toBeNull();
  expect(stepAvailability(list, id(1))).toEqual({
    previous: false,
    next: true,
  });
  expect(stepAvailability(list, id(3))).toEqual({
    previous: true,
    next: false,
  });
  expect(stepAvailability(list, id(9))).toEqual({
    previous: false,
    next: false,
  });
});

it("holds at most two videos and a byte budget, whatever the count", () => {
  let next = 0;
  const revoked: string[] = [];
  const cache = createObjectUrlCache({
    create: () => `blob:v/${next++}`,
    revoke: (url: string) => revoked.push(url),
    max: 12,
  });
  expect(MAX_OBJECT_VIDEOS).toBe(2);
  const video = { size: 16 * 1024 * 1024, type: "video/webm" };
  cache.acquire("v1", video);
  cache.acquire("i1", { size: 1000, type: "image/png" });
  cache.acquire("v2", video);
  cache.acquire("v3", video);
  // The oldest video went, an image stayed.
  expect(cache.keys().sort()).toEqual(["i1", "v2", "v3"]);
  expect(revoked).toEqual(["blob:v/0"]);
  // Twelve videos' worth of bytes can never be held: the budget evicts first.
  const images = createObjectUrlCache({
    create: () => `blob:b/${next++}`,
    revoke: () => {},
    max: 36,
  });
  for (let i = 0; i < 12; i++)
    images.acquire(`k${i}`, { size: 16 * 1024 * 1024, type: "image/png" });
  expect(images.bytes).toBeLessThanOrEqual(MAX_OBJECT_BYTES);
  expect(images.size).toBe(MAX_OBJECT_BYTES / (16 * 1024 * 1024));
  images.clear();
  expect(images.bytes).toBe(0);
});

it("evicts what is off screen before what is on screen, within a cap that follows the screen", () => {
  let next = 0;
  const visible = new Set(["a", "b"]);
  const evicted: string[] = [];
  const cache = createObjectUrlCache({
    create: () => `blob:s/${next++}`,
    revoke: () => {},
    max: 3,
    isVisible: (key: string) => visible.has(key),
    onEvict: (key: string) => evicted.push(key),
  });
  for (const key of ["a", "b", "c"]) cache.acquire(key, {});
  cache.acquire("d", {});
  // "a" is the least recently used but on screen; "c" is not.
  expect(evicted).toEqual(["c"]);
  expect(urlCapFor(0)).toBe(12);
  expect(urlCapFor(20)).toBe(22);
  expect(urlCapFor(500)).toBe(HARD_MAX_OBJECT_URLS);
  let cap = 2;
  const grow = createObjectUrlCache({
    create: () => `blob:g/${next++}`,
    revoke: () => {},
    max: () => cap,
  });
  grow.acquire("x", {});
  grow.acquire("y", {});
  cap = 4;
  grow.acquire("z", {});
  expect(grow.size).toBe(3);
});

it("compares declared and read lengths with the recorded size before a blob is made", () => {
  expect(
    lengthProblem({ declared: "1000", size: 1000, read: 1000 }),
  ).toBeNull();
  // Not declared is not zero: only the bytes read count.
  expect(lengthProblem({ declared: null, size: 1000, read: 1000 })).toBeNull();
  expect(lengthProblem({ declared: null, size: 1000, read: 999 })).toMatch(
    /does not match/,
  );
  expect(lengthProblem({ declared: "0", size: 1000 })).toMatch(
    /does not match/,
  );
  expect(lengthProblem({ declared: "abc", size: 1000 })).toMatch(
    /does not match/,
  );
  expect(lengthProblem({ declared: "999", size: 1000 })).toMatch(
    /does not match/,
  );
  expect(lengthProblem({ declared: "1000", size: 1000, read: 1001 })).toMatch(
    /does not match/,
  );
  expect(lengthProblem({ declared: "99999999999", size: 1000 })).toMatch(
    /larger/,
  );
  expect(lengthProblem({ declared: null, size: 17 * 1024 * 1024 })).toMatch(
    /larger/,
  );
  expect(lengthProblem({ declared: null, size: Number.NaN })).toMatch(/larger/);
});

it("never runs more jobs than its limit, even when aborted jobs finish after a reset", async () => {
  const queue = createFetchQueue(2);
  const finish = new Map<string, () => void>();
  let active = 0;
  let peak = 0;
  const job = (name: string) => () =>
    new Promise<void>((done) => {
      active += 1;
      peak = Math.max(peak, active);
      finish.set(name, () => {
        active -= 1;
        done();
      });
    });
  const settled: string[] = [];
  const run = (name: string) =>
    queue.schedule(job(name)).then(() => settled.push(name));
  const old = ["old1", "old2", "old3", "old4"].map(run);
  expect(queue.running).toBe(2);
  expect(queue.queued).toBe(2);
  // Leaving the view: queued jobs settle without running; running ones are aborted.
  queue.reset();
  await Promise.all(old.slice(2));
  expect(settled).toEqual(["old3", "old4"]);
  expect(queue.running).toBe(0);
  // A new view schedules while the aborted jobs are still winding down.
  const fresh = ["new1", "new2", "new3"].map(run);
  expect(queue.running).toBe(2);
  finish.get("old1")?.();
  finish.get("old2")?.();
  await Promise.all(old.slice(0, 2));
  // The old ones did not free slots they no longer held.
  expect(queue.running).toBe(2);
  expect(queue.queued).toBe(1);
  expect(finish.has("new3")).toBe(false);
  finish.get("new1")?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(finish.has("new3")).toBe(true);
  expect(queue.running).toBe(2);
  finish.get("new2")?.();
  finish.get("new3")?.();
  await Promise.all(fresh);
  expect(queue.running).toBe(0);
  expect(queue.queued).toBe(0);
  // At most the limit were ever live among jobs of one view: old and new
  // overlapped only while the old ones were already aborted.
  expect(peak).toBeLessThanOrEqual(4);
});
