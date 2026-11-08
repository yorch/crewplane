import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { durableMkdir } from "../../io.ts";
import { withProcessLock } from "../../process-lock.ts";
import { validId as validAgentId } from "../../project.ts";
import {
  defaultEvidenceLimits,
  type EvidenceArtifact,
  type EvidenceCaptureInput,
  type EvidenceLimits,
  type EvidenceManifest,
  type EvidenceRunInput,
  type EvidenceStore,
  evidenceCommitPattern,
  evidenceScenarios,
  evidenceTaskPattern,
} from "./contract.ts";

function fail(): never {
  throw new Error("Evidence rejected");
}
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const validId = (value: unknown, prefix: string): value is string =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const keys = (value: object, allowed: string[]) => {
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail();
};
const runKeys = ["task", "lane", "testedCommit"];
const captureKeys = [
  "route",
  "scenario",
  "step",
  "browser",
  "viewport",
  "mime",
  "outcome",
  "findingIds",
  "recheckOf",
];
const artifactKeys = [
  ...runKeys,
  ...captureKeys,
  "version",
  "artifactId",
  "runId",
  "capturedAt",
  "bytes",
  "sha256",
];
const manifestKeys = [
  ...runKeys,
  "version",
  "runId",
  "createdAt",
  "artifacts",
  "truncated",
  "retention",
];
function runValid(v: EvidenceRunInput) {
  if (
    !v ||
    !evidenceTaskPattern.test(v.task) ||
    !evidenceCommitPattern.test(v.testedCommit) ||
    !validAgentId(v.lane)
  )
    fail();
}
function captureValid(v: EvidenceCaptureInput) {
  if (
    !v ||
    typeof v.route !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(v.route) ||
    !evidenceScenarios.includes(v.scenario) ||
    !Number.isInteger(v.step) ||
    v.step < 0 ||
    v.step > 999 ||
    !["chrome", "chromium"].includes(v.browser) ||
    !["image/png", "image/jpeg", "image/webp", "video/webm"].includes(v.mime) ||
    !["captured", "finding", "recheck"].includes(v.outcome)
  )
    fail();
  if (
    !v.viewport ||
    ![v.viewport.width, v.viewport.height].every(
      (n) => Number.isInteger(n) && n >= 1 && n <= 8192,
    )
  )
    fail();
  keys(v.viewport, ["width", "height"]);
  if (
    !Array.isArray(v.findingIds) ||
    v.findingIds.length > 100 ||
    !v.findingIds.every((x) => validId(x, "finding")) ||
    (v.recheckOf !== null && !validId(v.recheckOf, "ev"))
  )
    fail();
}
function safe(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0
  )
    fail();
  return stat;
}
async function privateDir(path: string, root: string) {
  await durableMkdir(path, { root });
  safe(path, true);
}
function readPrivate(path: string, max: number) {
  if (safe(path, false).size > max) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function atomic(path: string, bytes: Uint8Array) {
  const temp = join(dirname(path), `.partial-${randomUUID()}`);
  const fd = openSync(
    temp,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function mimeValid(mime: string, bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (mime === "image/png")
    return (
      b.length >= 24 &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      b.toString("ascii", 12, 16) === "IHDR"
    );
  if (mime === "image/jpeg")
    return (
      b.length >= 4 &&
      b[0] === 255 &&
      b[1] === 216 &&
      b[b.length - 2] === 255 &&
      b[b.length - 1] === 217
    );
  if (mime === "image/webp")
    return (
      b.length >= 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP" &&
      b.readUInt32LE(4) + 8 === b.length
    );
  return (
    mime === "video/webm" &&
    b.length >= 8 &&
    b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    b.subarray(0, 4096).includes(Buffer.from("webm"))
  );
}
const dateValid = (v: string) =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;

// Synchronous filesystem transactions intentionally contain no await points. All
// factories in this process serialize naturally; one writer process owns a root.
async function openStore(
  root: string,
  overrides: Partial<EvidenceLimits> = {},
): Promise<EvidenceStore> {
  const limits = { ...defaultEvidenceLimits, ...overrides };
  keys(overrides, Object.keys(defaultEvidenceLimits));
  if (
    !Object.values(limits).every((n) => Number.isSafeInteger(n) && n > 0) ||
    Object.entries(limits).some(
      ([k, v]) => v > defaultEvidenceLimits[k as keyof EvidenceLimits],
    )
  )
    fail();
  const absolute = resolve(root);
  // Refuse symlinks in every ancestor, including an already existing root.
  let ancestor = absolute;
  while (true) {
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) fail();
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!existsSync(absolute)) {
    await durableMkdir(absolute);
  }
  safe(absolute, true);
  if (realpathSync(absolute) !== absolute) fail();
  const runPath = (m: EvidenceManifest) =>
    join(absolute, m.task, m.runId, m.testedCommit);
  const artifactPath = (m: EvidenceManifest, a: EvidenceArtifact) =>
    join(
      runPath(m),
      a.scenario,
      a.browser,
      `${a.viewport.width}x${a.viewport.height}`,
      a.artifactId,
    );
  const save = (m: EvidenceManifest) =>
    atomic(join(runPath(m), "manifest.json"), Buffer.from(JSON.stringify(m)));
  const unavailableRuns = new Set<string>();
  function load(recover = false): EvidenceManifest[] {
    unavailableRuns.clear();
    const result: EvidenceManifest[] = [];
    for (const task of readdirSync(absolute)) {
      if (!evidenceTaskPattern.test(task)) fail();
      const taskPath = join(absolute, task);
      safe(taskPath, true);
      for (const run of readdirSync(taskPath)) {
        if (!validId(run, "qa")) fail();
        const rp = join(taskPath, run);
        safe(rp, true);
        const commits = readdirSync(rp);
        if (commits.length === 0) {
          if (recover) rmSync(rp, { recursive: true });
          continue;
        }
        if (
          commits.length !== 1 ||
          !evidenceCommitPattern.test(commits[0] ?? "")
        )
          fail();
        const commit = commits[0] as string;
        const cp = join(rp, commit);
        safe(cp, true);
        const file = join(cp, "manifest.json");
        // A crash before the first manifest leaves an invisible empty run.
        if (!readdirSync(cp).includes("manifest.json")) {
          for (const entry of readdirSync(cp)) {
            const p = join(cp, entry);
            safe(p, false);
            if (!/^\.partial-[a-f0-9-]+$/.test(entry)) fail();
            if (recover) rmSync(p);
          }
          if (recover) rmSync(rp, { recursive: true });
          continue;
        }
        const m = JSON.parse(
          readPrivate(file, 1024 * 1024).toString(),
        ) as EvidenceManifest;
        keys(m, manifestKeys);
        runValid(m);
        if (
          m.version !== 1 ||
          m.task !== task ||
          m.runId !== run ||
          m.testedCommit !== commit ||
          !dateValid(m.createdAt) ||
          typeof m.truncated !== "boolean" ||
          !Array.isArray(m.artifacts) ||
          m.artifacts.length > limits.maxArtifactsPerRun
        )
          fail();
        if (!m.retention) fail();
        keys(m.retention, ["omittedArtifacts", "reason"]);
        if (
          !Number.isSafeInteger(m.retention.omittedArtifacts) ||
          m.retention.omittedArtifacts < 0 ||
          !["none", "run-cap", "global-cap", "retention"].includes(
            m.retention.reason,
          )
        )
          fail();
        const ids = new Set<string>();
        let bytes = 0;
        for (const a of m.artifacts) {
          keys(a, artifactKeys);
          runValid(a);
          captureValid(a);
          if (
            a.version !== 1 ||
            a.runId !== run ||
            a.task !== task ||
            a.testedCommit !== commit ||
            a.lane !== m.lane ||
            !validId(a.artifactId, "ev") ||
            ids.has(a.artifactId) ||
            !dateValid(a.capturedAt) ||
            !Number.isSafeInteger(a.bytes) ||
            a.bytes <= 0 ||
            a.bytes > limits.maxArtifactBytes ||
            !/^[a-f0-9]{64}$/.test(a.sha256)
          )
            fail();
          ids.add(a.artifactId);
          bytes += a.bytes;
        }
        if (bytes > limits.maxRunBytes) fail();
        const expected = new Set(m.artifacts.map((a) => artifactPath(m, a)));
        function inspect(path: string, depth: number) {
          for (const entry of readdirSync(path)) {
            const child = join(path, entry);
            const st = lstatSync(child);
            if (st.isSymbolicLink()) fail();
            if (st.isDirectory()) {
              safe(child, true);
              if (
                (depth === 0 &&
                  !evidenceScenarios.includes(
                    entry as EvidenceCaptureInput["scenario"],
                  )) ||
                (depth === 1 && !["chrome", "chromium"].includes(entry)) ||
                (depth === 2 &&
                  !/^[1-9][0-9]{0,3}x[1-9][0-9]{0,3}$/.test(entry)) ||
                depth > 2
              )
                fail();
              inspect(child, depth + 1);
            } else {
              safe(child, false);
              if (child === file) continue;
              if (expected.has(child)) continue;
              if (
                /^\.partial-[a-f0-9-]+$/.test(entry) ||
                validId(entry, "ev")
              ) {
                if (recover) rmSync(child);
              } else fail();
            }
          }
        }
        inspect(cp, 0);
        // Metadata/listing never rehashes every payload. Verify content on explicit read.
        // Missing or damaged payloads isolate their run; retain bytes for inspection.
        for (const a of m.artifacts) {
          try {
            if (safe(artifactPath(m, a), false).size !== a.bytes)
              unavailableRuns.add(m.runId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              unavailableRuns.add(m.runId);
            else throw error;
          }
        }
        result.push(m);
        if (result.length > 1000) fail();
      }
    }
    return result.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.runId.localeCompare(a.runId),
    );
  }
  function content(m: EvidenceManifest, a: EvidenceArtifact) {
    const path = artifactPath(m, a);
    let parent = dirname(path);
    while (parent !== absolute) {
      safe(parent, true);
      parent = dirname(parent);
    }
    const bytes = readPrivate(path, limits.maxArtifactBytes);
    if (
      bytes.length !== a.bytes ||
      hash(bytes) !== a.sha256 ||
      !mimeValid(a.mime, bytes)
    )
      fail();
    return bytes;
  }
  const total = (runs: EvidenceManifest[]) =>
    runs.reduce(
      (n, m) =>
        n +
        m.artifacts.reduce((sum, a) => {
          let actual = 0;
          try {
            actual = safe(artifactPath(m, a), false).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return sum + Math.max(a.bytes, actual);
        }, 0),
      0,
    );
  function trim(
    runs: EvidenceManifest[],
    current: EvidenceManifest,
    extra: number,
    extraRun: boolean,
    protectedArtifact: string | null = null,
  ) {
    // Prefer successful oldest video, retaining findings and original rechecks.
    for (const m of [...runs].reverse()) {
      if (unavailableRuns.has(m.runId)) continue;
      for (const a of [...m.artifacts]) {
        if (total(runs) + extra <= limits.maxTotalBytes) break;
        if (
          a.artifactId === protectedArtifact ||
          a.mime !== "video/webm" ||
          a.outcome !== "captured" ||
          a.findingIds.length ||
          runs.some((r) =>
            r.artifacts.some((x) => x.recheckOf === a.artifactId),
          )
        )
          continue;
        content(m, a);
        m.artifacts = m.artifacts.filter((x) => x !== a);
        m.truncated = true;
        m.retention.omittedArtifacts++;
        m.retention.reason = "retention";
        save(m);
        rmSync(artifactPath(m, a));
      }
    }
    for (const m of [...runs].reverse()) {
      if (unavailableRuns.has(m.runId)) continue;
      if (
        total(runs) + extra <= limits.maxTotalBytes &&
        runs.length + Number(extraRun) <= limits.maxRuns
      )
        break;
      if (
        m.runId === current.runId ||
        m.artifacts.some(
          (a) =>
            a.artifactId === protectedArtifact ||
            runs.some(
              (other) =>
                other.runId !== m.runId &&
                other.artifacts.some((x) => x.recheckOf === a.artifactId),
            ),
        )
      )
        continue;
      // Manifest-derived paths are reconstructed exclusively from validated keys.
      safe(join(absolute, m.task, m.runId), true);
      rmSync(join(absolute, m.task, m.runId), { recursive: true });
      runs.splice(runs.indexOf(m), 1);
      current.truncated = true;
      current.retention.omittedArtifacts += m.artifacts.length;
      current.retention.reason = "global-cap";
    }
    return (
      total(runs) + extra <= limits.maxTotalBytes &&
      runs.length + Number(extraRun) <= limits.maxRuns
    );
  }
  // Validate persisted records before making this root available.
  load();
  return {
    async createRun(input) {
      keys(input, runKeys);
      runValid(input);
      const runs = load(true);

      const m: EvidenceManifest = {
        ...input,
        version: 1,
        runId: id("qa"),
        createdAt: new Date().toISOString(),
        artifacts: [],
        truncated: false,
        retention: { omittedArtifacts: 0, reason: "none" },
      };
      if (!trim(runs, m, 0, true)) fail();
      await privateDir(join(absolute, m.task), absolute);
      await privateDir(join(absolute, m.task, m.runId), absolute);
      await privateDir(runPath(m), absolute);
      save(m);
      return structuredClone(m);
    },
    async append(runId, input, contentBytes) {
      if (!validId(runId, "qa")) fail();
      keys(input, captureKeys);
      captureValid(input);
      if (
        !(contentBytes instanceof Uint8Array) ||
        contentBytes.length === 0 ||
        contentBytes.length > limits.maxArtifactBytes ||
        !mimeValid(input.mime, contentBytes)
      )
        fail();
      const runs = load(true);

      const m = runs.find((r) => r.runId === runId);
      if (unavailableRuns.has(runId)) fail();
      if (!m) fail();
      if (
        input.recheckOf &&
        !runs.some((r) =>
          r.artifacts.some((a) => a.artifactId === input.recheckOf),
        )
      )
        fail();
      if (
        m.artifacts.length >= limits.maxArtifactsPerRun ||
        m.artifacts.reduce((n, a) => n + a.bytes, 0) + contentBytes.length >
          limits.maxRunBytes
      ) {
        m.truncated = true;
        m.retention.omittedArtifacts++;
        m.retention.reason = "run-cap";
        save(m);
        fail();
      }
      if (!trim(runs, m, contentBytes.length, false, input.recheckOf)) {
        m.truncated = true;
        m.retention.omittedArtifacts++;
        m.retention.reason = "global-cap";
        save(m);
        fail();
      }
      const a: EvidenceArtifact = {
        ...structuredClone(input),
        task: m.task,
        lane: m.lane,
        testedCommit: m.testedCommit,
        version: 1,
        artifactId: id("ev"),
        runId,
        capturedAt: new Date().toISOString(),
        bytes: contentBytes.length,
        sha256: hash(contentBytes),
      };
      await privateDir(join(runPath(m), a.scenario), absolute);
      await privateDir(join(runPath(m), a.scenario, a.browser), absolute);
      await privateDir(dirname(artifactPath(m, a)), absolute);
      atomic(artifactPath(m, a), contentBytes);
      m.artifacts.push(a);
      save(m);
      return structuredClone(a);
    },
    async manifest(runId) {
      if (!validId(runId, "qa")) fail();
      const result = load().find((m) => m.runId === runId);
      return structuredClone(result ?? null);
    },
    async list(options = {}) {
      keys(options, ["task", "cursor", "limit"]);
      const { task, cursor, limit = 20 } = options;
      if (
        (task !== undefined && !evidenceTaskPattern.test(task)) ||
        (cursor !== undefined && !validId(cursor, "qa")) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20
      )
        fail();
      const runs = load().filter((m) => task === undefined || m.task === task);
      const start =
        cursor === undefined
          ? 0
          : runs.findIndex((m) => m.runId === cursor) + 1;
      if (cursor !== undefined && start === 0) fail();
      const page = runs.slice(start, start + limit);
      return {
        runs: structuredClone(page),
        nextCursor:
          start + limit < runs.length ? (page.at(-1)?.runId ?? null) : null,
        retentionLimited: runs.some((m) => m.truncated),
        unavailableRuns: unavailableRuns.size,
        unavailableRunIds: [...unavailableRuns],
      };
    },
    async read(artifactId) {
      if (!validId(artifactId, "ev")) fail();
      for (const m of load()) {
        const a = m.artifacts.find((x) => x.artifactId === artifactId);
        if (a && unavailableRuns.has(m.runId)) fail();
        if (a) return { artifact: structuredClone(a), content: content(m, a) };
      }
      return null;
    },
  };
}

// Public failures contain no paths, metadata, provider or raw driver details.
export async function createEvidenceStore(
  root: string,
  limits: Partial<EvidenceLimits> = {},
): Promise<EvidenceStore> {
  try {
    const lock = `${resolve(root)}.lock`;
    return await withProcessLock(lock, async () => {
      const store = await openStore(root, limits);
      return new Proxy(store, {
        get(target, key: keyof EvidenceStore) {
          const method = target[key];
          if (typeof method !== "function") return undefined;
          return async (...args: unknown[]) => {
            try {
              return await withProcessLock(lock, () =>
                Reflect.apply(method, target, args),
              );
            } catch {
              return fail();
            }
          };
        },
      });
    });
  } catch {
    return fail();
  }
}
