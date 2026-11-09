import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assetName,
  autoUpdateDisabled,
  cacheDirectory,
  compareVersions,
  digest,
  dispatchTarget,
  downloadRelease,
  expectedDigest,
  type FetchLike,
  installBinary,
  isReleaseBuild,
  isRetained,
  longRunningCommands,
  looksExecutable,
  parseTag,
  platformTarget,
  readUpdateCache,
  registerSupervisor,
  releasesRoot,
  resolveLatest,
  retainedReleasePath,
  runUpdate,
  scheduleAutoUpdate,
  shouldScheduleUpdate,
  supervisorRunning,
  updateCachePath,
  updateConfig,
  updateDue,
  updateIntervalMs,
  updateTarget,
  writeUpdateCache,
} from "../src/update.ts";

const releaseRun = { runVersion: async () => patch };

const temporary = () => mkdtempSync(join(tmpdir(), "crewplane-update-"));
/** A stand-in release that reports its own version when retained. */
const fakeRelease = (version: string) => `#!/bin/sh\necho ${version}\n`;
const patch = "9.9.9";
const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const payloadFor = (os: "linux" | "macos", text = `fake ${patch}`) =>
  Buffer.concat([os === "linux" ? elf : machO, Buffer.from(`\n${text}\n`)]);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type Release = {
  tag: string;
  bytes: Buffer;
  checksum: string | null;
  apiBody: string;
};

let release: Release;
let base = "";
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  const binary = `/download/v${patch}/${assetName(`v${patch}`, targetForTest())}`;
  if (url.startsWith("/redirect/")) {
    response.writeHead(302, { location: url.slice("/redirect".length) });
    response.end();
    return;
  }
  if (url === "/latest") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(release.apiBody);
    return;
  }
  if (url === binary) {
    response.writeHead(200);
    response.end(release.bytes);
    return;
  }
  if (url === `${binary}.sha256` && release.checksum !== null) {
    response.writeHead(200);
    response.end(
      `${release.checksum}  ${assetName(`v${patch}`, targetForTest())}\n`,
    );
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

function targetForTest() {
  const target = platformTarget(process.platform, process.arch);
  if (target === null) throw new Error("Unsupported test host");
  return target;
}

const environment = (cache: string) => ({
  CREWPLANE_RELEASE_API: `${base}/latest`,
  CREWPLANE_RELEASE_BASE: `${base}/download`,
  CREWPLANE_CACHE_DIR: cache,
  CREWPLANE_RELEASES_DIR: join(cache, "releases"),
});

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
beforeEach(() => {
  const bytes = payloadFor(targetForTest().os);
  release = {
    tag: patch,
    bytes,
    checksum: sha256(bytes),
    apiBody: JSON.stringify({ tag_name: `v${patch}` }),
  };
});

describe("release metadata", () => {
  it("maps supported hosts and rejects the rest", () => {
    assert.deepEqual(platformTarget("linux", "x64"), {
      os: "linux",
      arch: "x86_64",
    });
    assert.deepEqual(platformTarget("darwin", "arm64"), {
      os: "macos",
      arch: "arm64",
    });
    assert.deepEqual(platformTarget("linux", "aarch64"), {
      os: "linux",
      arch: "arm64",
    });
    assert.equal(platformTarget("win32", "x64"), null);
    assert.equal(platformTarget("linux", "ppc64"), null);
  });

  it("names assets and validates tags", () => {
    assert.equal(
      assetName("v1.2.3", { os: "linux", arch: "x86_64" }),
      "crewplane-v1.2.3-linux-x86_64",
    );
    assert.equal(parseTag("v1.2.3"), "v1.2.3");
    assert.equal(parseTag("v1.2.3-rc.1"), "v1.2.3-rc.1");
    for (const value of ["1.2.3", "v1.2", "vnext", "", "v1.2.3; rm -rf /"])
      expect(() => parseTag(value)).toThrow(/not a supported version/);
  });

  it("orders versions numerically, including prereleases", () => {
    assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
    assert.equal(compareVersions("v0.2.0", "0.10.0"), -1);
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
    expect(() => compareVersions("latest", "1.0.0")).toThrow(/Invalid version/);
  });

  it("parses published checksums for the expected asset only", () => {
    const hash = "a".repeat(64);
    assert.equal(expectedDigest(`${hash}  crewplane-x\n`, "crewplane-x"), hash);
    assert.equal(
      expectedDigest(`${hash.toUpperCase()} *crewplane-x`, "crewplane-x"),
      hash,
    );
    assert.equal(expectedDigest(`${hash}\n`, "crewplane-x"), hash);
    expect(() => expectedDigest(`${hash}  other\n`, "crewplane-x")).toThrow(
      /Missing SHA-256 checksum/,
    );
    expect(() => expectedDigest("abc  crewplane-x\n", "crewplane-x")).toThrow(
      /Missing SHA-256 checksum/,
    );
    expect(() =>
      expectedDigest(`${hash}  crewplane-x\n`, "crewplane-y"),
    ).toThrow();
    assert.equal(digest(Buffer.from("x")), sha256(Buffer.from("x")));
  });

  it("recognizes platform executable headers", () => {
    assert.equal(looksExecutable(elf, "linux"), true);
    assert.equal(looksExecutable(machO, "macos"), true);
    assert.equal(looksExecutable(Buffer.from("<html>"), "linux"), false);
    assert.equal(looksExecutable(Buffer.from("<html>"), "macos"), false);
    assert.equal(looksExecutable(elf, "macos"), false);
  });

  it("reads environment overrides and defaults", () => {
    const config = updateConfig({
      CREWPLANE_RELEASE_API: "https://example.test/a",
    });
    assert.equal(config.api, "https://example.test/a");
    assert.equal(
      config.base,
      "https://github.com/yorch/crewplane/releases/download",
    );
    assert.equal(updateConfig({}).timeoutMs, 20_000);
    assert.equal(
      updateConfig({ CREWPLANE_UPDATE_TIMEOUT_MS: "0" }).timeoutMs,
      20_000,
    );
    assert.equal(
      updateConfig({ CREWPLANE_UPDATE_TIMEOUT_MS: "500" }).timeoutMs,
      500,
    );
    assert.equal(updateIntervalMs({}), 86_400_000);
    assert.equal(
      updateIntervalMs({ CREWPLANE_UPDATE_INTERVAL_HOURS: "2" }),
      7_200_000,
    );
  });

  it("treats automatic updates as opt-out", () => {
    assert.equal(autoUpdateDisabled({}), false);
    assert.equal(autoUpdateDisabled({ CREWPLANE_NO_AUTO_UPDATE: "1" }), true);
    assert.equal(
      autoUpdateDisabled({ CREWPLANE_NO_AUTO_UPDATE: "true" }),
      true,
    );
    assert.equal(autoUpdateDisabled({ CREWPLANE_UPDATE: "off" }), true);
    assert.equal(autoUpdateDisabled({ CREWPLANE_UPDATE: "auto" }), false);
    assert.equal(autoUpdateDisabled({ CREWPLANE_NO_AUTO_UPDATE: "0" }), false);
  });

  it("only self-updates a compiled binary path", () => {
    assert.equal(
      updateTarget(true, "/usr/local/bin/crewplane"),
      "/usr/local/bin/crewplane",
    );
    assert.equal(updateTarget(false, "/usr/bin/bun"), null);
    assert.equal(updateTarget(true, ""), null);
  });
  it("never offers to update a retained copy", () => {
    const root = "/tmp/crewplane-releases";
    const env = { CREWPLANE_RELEASES_DIR: root };
    assert.equal(
      updateTarget(true, join(root, "0.2.0", "crewplane"), env),
      null,
    );
    assert.equal(updateTarget(true, join(root, "other"), env), null);
    assert.equal(
      updateTarget(true, "/usr/local/bin/crewplane", env),
      "/usr/local/bin/crewplane",
    );
    assert.equal(isRetained(join(root, "0.2.0", "crewplane"), env), true);
    assert.equal(isRetained("/usr/local/bin/crewplane", env), false);
  });
  it("resolves a retained release by its layout and verified version", async () => {
    const directory = temporary();
    const env = { CREWPLANE_RELEASES_DIR: join(directory, "releases") };
    assert.equal(releasesRoot(env), join(directory, "releases"));
    assert.equal(
      retainedReleasePath("1.2.3", env),
      join(directory, "releases", "1.2.3", "crewplane"),
    );
    assert.equal(await dispatchTarget("1.2.3", env), null);

    const install = (version: string, mode = 0o755) => {
      const path = retainedReleasePath(version, env);
      mkdirSync(join(directory, "releases", version), { recursive: true });
      writeFileSync(path, `#!/bin/sh\necho ${version}\n`, { mode });
      chmodSync(path, mode);
      return path;
    };
    const path = install("1.2.3");
    assert.equal(await dispatchTarget("1.2.3", env), path);
    // A directory named after another version must not be trusted.
    assert.equal(await dispatchTarget("1.2.4", env), null);

    const tampered = install("1.2.5");
    writeFileSync(tampered, "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
    assert.equal(await dispatchTarget("1.2.5", env), null);

    const writable = install("1.2.6", 0o777);
    assert.equal(await dispatchTarget("1.2.6", env), null);

    mkdirSync(join(directory, "releases", "1.2.7"), { recursive: true });
    symlinkSync(writable, retainedReleasePath("1.2.7", env));
    assert.equal(await dispatchTarget("1.2.7", env), null);
  });
});

describe("cache", () => {
  it("resolves a per-user cache path with overrides", () => {
    assert.equal(
      updateCachePath(
        { CREWPLANE_CACHE_DIR: "/tmp/cache" },
        "/home/a",
        "linux",
      ),
      "/tmp/cache/crewplane/update.json",
    );
    assert.equal(
      updateCachePath({ XDG_CACHE_HOME: "/xdg" }, "/home/a", "linux"),
      "/xdg/crewplane/update.json",
    );
    assert.equal(
      updateCachePath({}, "/home/a", "linux"),
      "/home/a/.cache/crewplane/update.json",
    );
    assert.equal(
      updateCachePath({}, "/home/a", "darwin"),
      "/home/a/Library/Caches/crewplane/update.json",
    );
  });

  it("round-trips and tolerates missing or corrupt records", async () => {
    const path = join(temporary(), "nested", "update.json");
    assert.deepEqual(await readUpdateCache(path), { version: 1 });
    await writeUpdateCache(path, {
      version: 1,
      lastAttemptAt: "2026-01-01T00:00:00.000Z",
      latest: "0.3.0",
    });
    assert.deepEqual(await readUpdateCache(path), {
      version: 1,
      lastAttemptAt: "2026-01-01T00:00:00.000Z",
      latest: "0.3.0",
    });
    assert.equal(statSync(path).mode & 0o077, 0);
    writeFileSync(path, "{not json");
    assert.deepEqual(await readUpdateCache(path), { version: 1 });
  });

  it("only reports due after the interval elapses", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    assert.equal(updateDue({ version: 1 }, now, 86_400_000), true);
    assert.equal(
      updateDue(
        { version: 1, lastAttemptAt: "2026-01-01T12:00:00.000Z" },
        now,
        86_400_000,
      ),
      false,
    );
    assert.equal(
      updateDue(
        { version: 1, lastAttemptAt: "2025-12-31T23:00:00.000Z" },
        now,
        86_400_000,
      ),
      true,
    );
    assert.equal(
      updateDue(
        { version: 1, lastAttemptAt: "2026-01-01T23:00:00.000Z" },
        now,
        86_400_000,
      ),
      false,
    );
  });
});

describe("update runs", () => {
  it("reports an available update in check mode without writing", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const outcome = await runUpdate({
      current: "0.2.0",
      checkOnly: true,
      environment: environment(join(directory, "cache")),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("available");
    expect(outcome.latest).toBe(patch);
    expect(outcome.target).toBe(target);
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
  });

  it("reports current when the local version is not older", async () => {
    const directory = temporary();
    const outcome = await runUpdate({
      current: "10.0.0",
      environment: environment(join(directory, "cache")),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: join(directory, "crewplane"),
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("current");
    assert.equal(existsSync(join(directory, "crewplane")), false);
  });

  it("reports unsupported for source runs and foreign platforms", async () => {
    const directory = temporary();
    const source = await runUpdate({
      current: "0.2.0",
      environment: environment(join(directory, "cache")),
      releaseMarked: false,
      execPath: "/usr/bin/bun",
    });
    expect(source.status).toBe("unsupported");
    const foreign = await runUpdate({
      current: "0.2.0",
      environment: environment(join(directory, "cache")),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: join(directory, "crewplane"),
      platform: "win32",
      arch: "x64",
    });
    expect(foreign.status).toBe("unsupported");
  });

  it("retains the replaced binary so a pin can still be served", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const env = environment(join(directory, "cache"));
    const outcome = await runUpdate({
      current: "0.2.0",
      environment: env,
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("updated");
    const retained = retainedReleasePath("0.2.0", env);
    assert.equal(readFileSync(retained, "utf8"), fakeRelease("0.2.0"));
    assert.equal(statSync(retained).mode & 0o111, 0o111);
    // A retained copy is never a self-update target.
    assert.equal(updateTarget(true, retained, env), null);
  });
  it("refuses to swap when the replaced release cannot be retained", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "not a directory");
    const outcome = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: {
        ...environment(join(directory, "cache")),
        CREWPLANE_RELEASES_DIR: join(blocked, "releases"),
      },
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("CREWPLANE_RELEASES_DIR");
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
    // An explicit update fails loudly for the same reason instead of swapping.
    await expect(
      runUpdate({
        current: "0.2.0",
        environment: {
          ...environment(join(directory, "cache-2")),
          CREWPLANE_RELEASES_DIR: join(blocked, "releases"),
        },
        releaseMarked: true,
        runVersion: async () => patch,
        execPath: target,
        platform: process.platform,
        arch: process.arch,
      }),
    ).rejects.toThrow("CREWPLANE_RELEASES_DIR");
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
  });
  it("leaves a retained copy that already verifies untouched", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const env = environment(join(directory, "cache"));
    const retained = retainedReleasePath("0.2.0", env);
    mkdirSync(join(retained, ".."), { recursive: true });
    writeFileSync(retained, `${fakeRelease("0.2.0")}# kept\n`, { mode: 0o755 });
    const outcome = await runUpdate({
      current: "0.2.0",
      environment: env,
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("updated");
    assert.match(readFileSync(retained, "utf8"), /# kept/);
  });
  it("repairs a retained copy that fails verification", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const env = environment(join(directory, "cache"));
    const retained = retainedReleasePath("0.2.0", env);
    mkdirSync(join(retained, ".."), { recursive: true });
    // A corrupt or wrong-version slot must not be trusted forever.
    writeFileSync(retained, "broken", { mode: 0o755 });
    const outcome = await runUpdate({
      current: "0.2.0",
      environment: env,
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("updated");
    assert.equal(readFileSync(retained, "utf8"), fakeRelease("0.2.0"));
  });
  it("replaces the running executable atomically after verification", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const outcome = await runUpdate({
      current: "0.2.0",
      environment: environment(join(directory, "cache")),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("updated");
    expect(outcome.asset).toBe(assetName(`v${patch}`, targetForTest()));
    assert.deepEqual(readFileSync(target), release.bytes);
    assert.equal(statSync(target).mode & 0o111, 0o111);
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.includes(".tmp")),
      [],
    );
  });

  it("refuses a checksum mismatch and keeps the current binary", async () => {
    release.checksum = "b".repeat(64);
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    await assert.rejects(
      runUpdate({
        current: "0.2.0",
        environment: environment(join(directory, "cache")),
        releaseMarked: true,
        runVersion: async () => patch,
        execPath: target,
        platform: process.platform,
        arch: process.arch,
      }),
      /Checksum mismatch/,
    );
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
  });

  it("refuses an asset that is not a platform executable", async () => {
    release.bytes = Buffer.from("<html>not a binary</html>");
    release.checksum = sha256(release.bytes);
    const directory = temporary();
    await assert.rejects(
      runUpdate({
        current: "0.2.0",
        environment: environment(join(directory, "cache")),
        releaseMarked: true,
        runVersion: async () => patch,
        execPath: join(directory, "crewplane"),
        platform: process.platform,
        arch: process.arch,
      }),
      /is not a .* executable/,
    );
  });

  it("rejects a release lookup that is not a version tag", async () => {
    release.apiBody = JSON.stringify({ tag_name: "latest" });
    const directory = temporary();
    await assert.rejects(
      runUpdate({
        current: "0.2.0",
        environment: environment(join(directory, "cache")),
        releaseMarked: true,
        runVersion: async () => patch,
        execPath: join(directory, "crewplane"),
        platform: process.platform,
        arch: process.arch,
      }),
      /not a supported version/,
    );
  });

  it("records automatic results and errors in the cache", async () => {
    const directory = temporary();
    const cacheDirectory = join(directory, "cache");
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const updated = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(updated.status).toBe("updated");
    const record = await readUpdateCache(
      updateCachePath({ CREWPLANE_CACHE_DIR: cacheDirectory }),
    );
    expect(record.latest).toBe(patch);
    expect(record.updatedAt).toBeDefined();
    assert.equal(record.error, undefined);

    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    release.checksum = "c".repeat(64);
    const failed = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(failed.status).toBe("failed");
    assert.match(failed.reason ?? "", /Checksum mismatch/);
    const failure = await readUpdateCache(
      updateCachePath({ CREWPLANE_CACHE_DIR: cacheDirectory }),
    );
    assert.match(failure.error ?? "", /Checksum mismatch/);
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
  });

  it("does not contact the network when automatic updates are disabled", async () => {
    const directory = temporary();
    const cacheDirectory = join(directory, "cache");
    const outcome = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: {
        ...environment(cacheDirectory),
        CREWPLANE_NO_AUTO_UPDATE: "1",
      },
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: join(directory, "crewplane"),
      platform: process.platform,
      arch: process.arch,
      fetch: () => {
        throw new Error("network must not be used");
      },
    });
    expect(outcome.status).toBe("unsupported");
    expect(outcome.reason).toBe("Disabled");
  });

  it("refuses to run while another updater owns the lock", async () => {
    const directory = temporary();
    const cacheDirectory = join(directory, "cache");
    mkdirSync(join(cacheDirectory, "crewplane"), { recursive: true });
    writeFileSync(
      join(cacheDirectory, "crewplane", "update.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    const outcome = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: join(directory, "crewplane"),
      platform: process.platform,
      arch: process.arch,
      fetch: () => {
        throw new Error("network must not be used");
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("Another update is already running");
  });

  it("treats a freshly written but unreadable lock as busy", async () => {
    const directory = temporary();
    const cacheDirectory = join(directory, "cache");
    mkdirSync(join(cacheDirectory, "crewplane"), { recursive: true });
    writeFileSync(join(cacheDirectory, "crewplane", "update.lock"), "");
    const outcome = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: join(directory, "crewplane"),
      platform: process.platform,
      arch: process.arch,
      fetch: () => {
        throw new Error("network must not be used");
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("Another update is already running");
  });

  it("recovers a lock left by a dead process", async () => {
    const directory = temporary();
    const cacheDirectory = join(directory, "cache");
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    mkdirSync(join(cacheDirectory, "crewplane"), { recursive: true });
    writeFileSync(
      join(cacheDirectory, "crewplane", "update.lock"),
      JSON.stringify({ pid: 999_999_999 }),
    );
    const outcome = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      releaseMarked: true,
      runVersion: async () => patch,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("updated");
    assert.equal(
      existsSync(join(cacheDirectory, "crewplane", "update.lock")),
      false,
    );
  });

  it("schedules at most one detached updater per interval", async () => {
    const directory = temporary();
    const cacheDirectory = join(directory, "cache");
    const calls: string[][] = [];
    const spawnProcess = (file: string, args: string[]) => {
      calls.push([file, ...args]);
    };
    const environment = { CREWPLANE_CACHE_DIR: cacheDirectory };
    const launch = (at: string) =>
      scheduleAutoUpdate({
        target: "/opt/crewplane",
        environment,
        now: new Date(at),
        spawnProcess,
      });
    expect(await launch("2026-01-01T00:00:00.000Z")).toBe(true);
    expect(await launch("2026-01-01T12:00:00.000Z")).toBe(false);
    expect(await launch("2026-01-02T01:00:00.000Z")).toBe(true);
    assert.deepEqual(calls, [
      ["/opt/crewplane", "update", "--auto"],
      ["/opt/crewplane", "update", "--auto"],
    ]);
  });
});

describe("security boundaries", () => {
  it("accepts only https sources or explicit loopback servers", () => {
    assert.equal(
      updateConfig({ CREWPLANE_RELEASE_API: "https://example.test/latest" })
        .api,
      "https://example.test/latest",
    );
    assert.equal(
      updateConfig({ CREWPLANE_RELEASE_API: "http://127.0.0.1:9/latest" }).api,
      "http://127.0.0.1:9/latest",
    );
    expect(() =>
      updateConfig({ CREWPLANE_RELEASE_API: "http://example.test/latest" }),
    ).toThrow(/https/);
    expect(() =>
      updateConfig({ CREWPLANE_RELEASE_BASE: "ftp://example.test/x" }),
    ).toThrow(/https/);
    expect(() => updateConfig({ CREWPLANE_RELEASE_API: "not a url" })).toThrow(
      /invalid/,
    );
  });

  it("sends GitHub credentials only to the https API host", async () => {
    const seen: Record<string, string>[] = [];
    const spy: FetchLike = async (_url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }), {
        status: 200,
      });
    };
    await resolveLatest(
      updateConfig({
        CREWPLANE_RELEASE_API:
          "https://api.github.com/repos/x/y/releases/latest",
      }),
      { GITHUB_TOKEN: "secret" },
      spy,
    );
    await resolveLatest(
      updateConfig({ CREWPLANE_RELEASE_API: "https://example.test/latest" }),
      { GITHUB_TOKEN: "secret" },
      spy,
    );
    assert.equal(seen[0]?.authorization, "Bearer secret");
    assert.equal(seen[1]?.authorization, undefined);
  });

  it("follows storage redirects for published assets", async () => {
    const environment = {
      CREWPLANE_RELEASE_API: `${base}/latest`,
      CREWPLANE_RELEASE_BASE: `${base}/redirect/download`,
      CREWPLANE_CACHE_DIR: temporary(),
    };
    const download = await downloadRelease(
      `v${patch}`,
      targetForTest(),
      updateConfig(environment),
    );
    assert.deepEqual(Buffer.from(download.bytes), release.bytes);
  });

  it("refuses an asset larger than the configured limit", async () => {
    const config = {
      ...updateConfig(environment(temporary())),
      maxAssetBytes: 8,
    };
    await assert.rejects(
      downloadRelease(`v${patch}`, targetForTest(), config),
      /exceeds the size limit/,
    );
  });

  it("refuses oversized metadata even without a content-length", async () => {
    const chunked = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      for (let index = 0; index < 20; index += 1) response.write(chunk);
      response.end();
    });
    await new Promise<void>((done) => chunked.listen(0, "127.0.0.1", done));
    try {
      const { port } = chunked.address() as AddressInfo;
      await assert.rejects(
        resolveLatest({
          ...updateConfig({}),
          api: `http://127.0.0.1:${port}/latest`,
          timeoutMs: 10_000,
        }),
        /exceeds the size limit/,
      );
    } finally {
      chunked.closeAllConnections();
      await new Promise<void>((done) => chunked.close(() => done()));
    }
  });

  it("refuses a staged binary that reports another version", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    await assert.rejects(
      runUpdate({
        current: "0.2.0",
        environment: environment(join(directory, "cache")),
        releaseMarked: true,
        execPath: target,
        platform: process.platform,
        arch: process.arch,
        runVersion: async () => "0.0.0",
      }),
      /reports 0\.0\.0 but 9\.9\.9 was requested/,
    );
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
  });

  it("refuses to replace the binary while a supervisor is live", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    const cache = join(directory, "cache");
    const unregister = await registerSupervisor({ CREWPLANE_CACHE_DIR: cache });
    try {
      await assert.rejects(
        runUpdate({
          current: "0.2.0",
          environment: environment(cache),
          releaseMarked: true,
          execPath: target,
          platform: process.platform,
          arch: process.arch,
          runVersion: async () => patch,
        }),
        /supervisor is running/,
      );
      assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
    } finally {
      await unregister();
    }
  });

  it("reports availability while a supervisor is live", async () => {
    const directory = temporary();
    const cache = join(directory, "cache");
    const unregister = await registerSupervisor({ CREWPLANE_CACHE_DIR: cache });
    try {
      const outcome = await runUpdate({
        current: "0.2.0",
        checkOnly: true,
        environment: environment(cache),
        releaseMarked: true,
        execPath: join(directory, "crewplane"),
        platform: process.platform,
        arch: process.arch,
      });
      expect(outcome.status).toBe("available");
    } finally {
      await unregister();
    }
  });

  it("re-checks the guard after downloading", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    let calls = 0;
    await assert.rejects(
      runUpdate({
        current: "0.2.0",
        environment: environment(join(directory, "cache")),
        releaseMarked: true,
        execPath: target,
        platform: process.platform,
        arch: process.arch,
        runVersion: async () => patch,
        safeToReplace: async () => {
          calls += 1;
          return calls === 1;
        },
      }),
      /supervisor started during the update/,
    );
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
  });
});

describe("supervisor registry", () => {
  it("reports live registrations and prunes dead ones", async () => {
    const directory = temporary();
    const environment = { CREWPLANE_CACHE_DIR: directory };
    assert.equal(cacheDirectory(environment), join(directory, "crewplane"));
    assert.equal(await supervisorRunning(environment), false);
    const unregister = await registerSupervisor(environment);
    assert.equal(await supervisorRunning(environment), true);
    await unregister();
    assert.equal(await supervisorRunning(environment), false);

    const supervisors = join(directory, "crewplane", "supervisors");
    mkdirSync(supervisors, { recursive: true });
    writeFileSync(
      join(supervisors, "999999999.json"),
      JSON.stringify({ version: 1, pid: 999_999_999 }),
    );
    assert.equal(await supervisorRunning(environment), false);
    assert.deepEqual(readdirSync(supervisors), []);
  });
});

describe("schedule decisions", () => {
  const base = {
    command: "status",
    environment: {} as Record<string, string | undefined>,
    releaseMarked: true,
    execPath: "/opt/crewplane",
    now: new Date("2026-01-02T00:00:00.000Z"),
    supervisorLive: false,
  };
  it("requires a due release build, an allowed command and no live supervisor", () => {
    assert.equal(
      shouldScheduleUpdate({ ...base, cache: { version: 1 } }),
      true,
    );
    assert.equal(
      shouldScheduleUpdate({
        ...base,
        cache: { version: 1 },
        supervisorLive: true,
      }),
      false,
    );
    for (const command of longRunningCommands)
      assert.equal(
        shouldScheduleUpdate({ ...base, cache: { version: 1 }, command }),
        false,
      );
    assert.equal(
      shouldScheduleUpdate({
        ...base,
        cache: { version: 1 },
        environment: { CREWPLANE_NO_AUTO_UPDATE: "1" },
      }),
      false,
    );
    assert.equal(
      shouldScheduleUpdate({
        ...base,
        cache: { version: 1 },
        releaseMarked: false,
      }),
      false,
    );
    assert.equal(
      shouldScheduleUpdate({
        ...base,
        cache: {
          version: 1,
          lastAttemptAt: "2026-01-01T23:00:00.000Z",
          target: "/opt/crewplane",
        },
      }),
      false,
    );
    assert.equal(
      shouldScheduleUpdate({
        ...base,
        cache: { version: 1, lastAttemptAt: "2026-01-01T00:00:00.000Z" },
      }),
      true,
    );
    assert.equal(
      shouldScheduleUpdate({
        ...base,
        cache: {
          version: 1,
          lastAttemptAt: "2026-01-01T23:00:00.000Z",
          target: "/other/crewplane",
        },
      }),
      true,
    );
  });

  it("treats future timestamps as due instead of stalled", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    assert.equal(
      updateDue(
        { version: 1, lastAttemptAt: "2026-06-01T00:00:00.000Z" },
        now,
        86_400_000,
      ),
      true,
    );
    assert.equal(isReleaseBuild(), false);
  });
});

describe("installBinary", () => {
  it("refuses symlink targets and leaves no temporary files", async () => {
    const directory = temporary();
    const link = join(directory, "crewplane");
    writeFileSync(join(directory, "real"), "old");
    symlinkSync(join(directory, "real"), link);
    await assert.rejects(installBinary(link, elf), /symbolic link/);
    assert.equal(readFileSync(join(directory, "real"), "utf8"), "old");
  });

  it("refuses a non-writable directory", async () => {
    if (process.getuid?.() === 0) return;
    const directory = temporary();
    chmodSync(directory, 0o500);
    await assert.rejects(
      installBinary(join(directory, "crewplane"), elf),
      /not writable/,
    );
    chmodSync(directory, 0o700);
  });

  it("refuses to replace a directory", async () => {
    const directory = temporary();
    mkdirSync(join(directory, "crewplane"));
    await assert.rejects(
      installBinary(join(directory, "crewplane"), elf),
      /non-file/,
    );
  });

  it("preserves the existing file mode", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o700 });
    await installBinary(target, elf);
    assert.equal(statSync(target).mode & 0o777, 0o700);
  });

  it("removes stale staging files but keeps a concurrent one", async () => {
    const directory = temporary();
    const stale = join(directory, ".crewplane.old.tmp");
    const active = join(directory, ".crewplane.active.tmp");
    writeFileSync(stale, "stale");
    writeFileSync(active, "active");
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(stale, old, old);
    await installBinary(join(directory, "crewplane"), elf);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(active), true);
  });

  it("proves the staged binary runs before replacing anything", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, fakeRelease("0.2.0"), { mode: 0o755 });
    await assert.rejects(
      installBinary(target, elf, {
        expectedVersion: "9.9.9",
        runVersion: async () => "8.8.8",
      }),
      /reports 8\.8\.8/,
    );
    assert.equal(readFileSync(target, "utf8"), fakeRelease("0.2.0"));
    await installBinary(target, elf, releaseRun);
    assert.deepEqual(readFileSync(target), elf);
  });

  it("downloads only published, checksummed assets", async () => {
    const target = targetForTest();
    const config = updateConfig(environment(temporary()));
    const download = await downloadRelease(`v${patch}`, target, config);
    assert.deepEqual(Buffer.from(download.bytes), release.bytes);
    release.checksum = null;
    await assert.rejects(
      downloadRelease(`v${patch}`, target, config),
      /HTTP 404/,
    );
  });
});
