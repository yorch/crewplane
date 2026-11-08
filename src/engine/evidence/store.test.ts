import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { EvidenceCaptureInput, EvidenceManifest } from "./contract.ts";
import { createEvidenceStore } from "./store.ts";

const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(realpathSync(tmpdir()), "evidence-"));
  roots.push(p);
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const run = { task: "P0-20", lane: "F" as const, testedCommit: "a".repeat(40) };
const capture: EvidenceCaptureInput = {
  route: "synthetic",
  scenario: "initial",
  step: 0,
  browser: "chromium",
  viewport: { width: 390, height: 844 },
  mime: "image/png",
  outcome: "captured",
  findingIds: [],
  recheckOf: null,
};
// Independently specified minimal PNG fixture, never derived from store output.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=",
  "base64",
);
const manifestPath = (p: string, m: EvidenceManifest) =>
  join(p, m.task, m.runId, m.testedCommit, "manifest.json");
const artifactPath = (p: string, m: EvidenceManifest, id: string) =>
  join(
    p,
    m.task,
    m.runId,
    m.testedCommit,
    "initial",
    "chromium",
    "390x844",
    id,
  );
it("persists progressive atomic manifests, concurrent appends, opaque pagination and original rechecks across restart", async () => {
  const p = root();
  const store = await createEvidenceStore(p);
  const m = await store.createRun(run);
  expect((await store.manifest(m.runId))?.artifacts).toEqual([]);
  const artifacts = await Promise.all(
    Array.from({ length: 8 }, (_, step) =>
      store.append(m.runId, { ...capture, step }, png),
    ),
  );
  expect((await store.manifest(m.runId))?.artifacts).toHaveLength(8);
  const first = artifacts[0];
  if (!first) throw Error("missing");
  const second = await store.append(
    m.runId,
    {
      ...capture,
      scenario: "recheck",
      recheckOf: first.artifactId,
      outcome: "recheck",
    },
    png,
  );
  expect(second.recheckOf).toBe(first.artifactId);
  expect(first.sha256).toBe(createHash("sha256").update(png).digest("hex"));
  const reopened = await createEvidenceStore(p);
  expect((await reopened.read(first.artifactId))?.content).toEqual(png);
  expect(statSync(manifestPath(p, m)).mode & 0o777).toBe(0o600);
  expect(statSync(join(p, m.task)).mode & 0o777).toBe(0o700);
  await store.createRun(run);
  const page = await store.list({ limit: 1 });
  expect(page.nextCursor).toMatch(/^qa_/);
  expect(
    (await store.list({ limit: 1, cursor: page.nextCursor ?? "" })).runs,
  ).toHaveLength(1);
});
it("rejects untrusted metadata, paths, MIME and overlarge bytes without manifest changes", async () => {
  const store = await createEvidenceStore(root(), { maxArtifactBytes: 100 });
  const m = await store.createRun(run);
  for (const route of ["../secret", "/sign-in?token=secret"])
    await expect(
      store.append(m.runId, { ...capture, route } as EvidenceCaptureInput, png),
    ).rejects.toThrow("Evidence rejected");
  await expect(store.append("../secret", capture, png)).rejects.toThrow();
  await expect(
    store.append(m.runId, { ...capture, mime: "video/webm" }, png),
  ).rejects.toThrow();
  await expect(
    store.append(m.runId, capture, Buffer.alloc(101)),
  ).rejects.toThrow();
  await expect(
    store.append(
      m.runId,
      { ...capture, recheckOf: `ev_${"b".repeat(32)}` },
      png,
    ),
  ).rejects.toThrow();
  await expect(store.list({ cursor: "../../secret" })).rejects.toThrow();
  await expect(store.read("../secret")).rejects.toThrow();
  expect((await store.manifest(m.runId))?.artifacts).toHaveLength(0);
});
it("records run cap truncation and bounds global run retention", async () => {
  const store = await createEvidenceStore(root(), {
    maxArtifactsPerRun: 1,
    maxRuns: 1,
  });
  const m = await store.createRun(run);
  await store.append(m.runId, capture, png);
  await expect(store.append(m.runId, capture, png)).rejects.toThrow();
  expect((await store.manifest(m.runId))?.retention).toEqual({
    omittedArtifacts: 1,
    reason: "run-cap",
  });
  const next = await store.createRun(run);
  expect(await store.manifest(m.runId)).toBeNull();
  expect(next.truncated).toBe(true);
  expect((await store.list()).retentionLimited).toBe(true);
});
it("prefers pruning successful video and keeps finding evidence under disk cap", async () => {
  const webm = Buffer.concat([
    Buffer.from([26, 69, 223, 163]),
    Buffer.from("webm synthetic"),
  ]);
  const store = await createEvidenceStore(root(), {
    maxTotalBytes: png.length * 2,
    maxRunBytes: png.length * 2,
  });
  const m = await store.createRun(run);
  const video = await store.append(
    m.runId,
    { ...capture, mime: "video/webm" },
    webm,
  );
  const finding = await store.append(
    m.runId,
    { ...capture, outcome: "finding" },
    png,
  );
  const n = await store.createRun(run);
  await store.append(n.runId, capture, png);
  expect(await store.read(video.artifactId)).toBeNull();
  expect(await store.read(finding.artifactId)).not.toBeNull();
  expect((await store.manifest(m.runId))?.truncated).toBe(true);
});
it("rejects symlink roots, ancestors, manifest and artifact files, tampered hashes and unsafe persisted metadata", async () => {
  const p = root();
  const external = root();
  symlinkSync(external, join(p, "link"));
  await expect(createEvidenceStore(join(p, "link"))).rejects.toThrow();
  await expect(createEvidenceStore(join(p, "link", "child"))).rejects.toThrow();
  rmSync(join(p, "link"));
  const store = await createEvidenceStore(p);
  const m = await store.createRun(run);
  const a = await store.append(m.runId, capture, png);
  const ap = artifactPath(p, m, a.artifactId);
  writeFileSync(ap, Buffer.alloc(png.length));
  await expect(store.read(a.artifactId)).rejects.toThrow();
  rmSync(ap);
  symlinkSync(join(external, "private"), ap);
  await expect(store.read(a.artifactId)).rejects.toThrow();
  rmSync(ap);
  writeFileSync(ap, png, { mode: 0o600 });
  const mp = manifestPath(p, m);
  const original = readFileSync(mp);
  const bad = JSON.parse(original.toString());
  bad.artifacts[0].scenario = "../../private";
  writeFileSync(mp, JSON.stringify(bad));
  await expect(createEvidenceStore(p)).rejects.toThrow();
  writeFileSync(mp, original);
  chmodSync(mp, 0o644);
  await expect(createEvidenceStore(p)).rejects.toThrow();
  chmodSync(mp, 0o600);
  rmSync(mp);
  symlinkSync(join(external, "manifest"), mp);
  await expect(createEvidenceStore(p)).rejects.toThrow();
});
it("ignores crash partial files and orphan bytes while rejecting oversized or malformed manifests", async () => {
  const p = root();
  const store = await createEvidenceStore(p);
  const m = await store.createRun(run);
  const mp = manifestPath(p, m);
  writeFileSync(
    join(
      p,
      m.task,
      m.runId,
      m.testedCommit,
      ".partial-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ),
    "partial",
    { mode: 0o600 },
  );
  expect(
    (await (await createEvidenceStore(p)).manifest(m.runId))?.artifacts,
  ).toHaveLength(0);
  expect(readdirSync(join(p, m.task, m.runId, m.testedCommit))).not.toContain(
    ".partial-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  writeFileSync(mp, "{");
  await expect(createEvidenceStore(p)).rejects.toThrow();
  writeFileSync(mp, Buffer.alloc(1024 * 1024 + 1));
  await expect(createEvidenceStore(p)).rejects.toThrow();
});

it("rejects a first recheck under global byte pressure while preserving its original video", async () => {
  const store = await createEvidenceStore(root(), {
    maxTotalBytes: 80,
    maxRunBytes: 100,
  });
  const m = await store.createRun(run);
  const webm = Buffer.concat([
    Buffer.from([26, 69, 223, 163]),
    Buffer.from("webm original"),
  ]);
  expect(webm.length).toBe(17);
  expect(png.length).toBe(68);
  const original = await store.append(
    m.runId,
    { ...capture, mime: "video/webm" },
    webm,
  );
  await expect(
    store.append(
      m.runId,
      { ...capture, outcome: "recheck", recheckOf: original.artifactId },
      png,
    ),
  ).rejects.toThrow("Evidence rejected");
  expect((await store.read(original.artifactId))?.content).toEqual(webm);
  const manifest = await store.manifest(m.runId);
  expect(manifest?.artifacts.map((a) => a.artifactId)).toEqual([
    original.artifactId,
  ]);
  expect(manifest?.truncated).toBe(true);
  expect(manifest?.retention).toEqual({
    omittedArtifacts: 1,
    reason: "global-cap",
  });
});
