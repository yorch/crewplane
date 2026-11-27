import { expect, it } from "vitest";
import {
  AUTO_LOAD_MAX_BYTES,
  altText,
  BLOB_TYPES,
  baseType,
  blobKind,
  blobTypeFor,
  createObjectUrlCache,
  ID_PATTERNS,
  listPath,
  loadPolicy,
  MAX_OBJECT_URLS,
  MAX_VIEW_BYTES,
  mergeArtifacts,
  neighbor,
  outcomeTone,
  safeFilename,
  stepAvailability,
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
