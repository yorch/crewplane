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
  compareVersions,
  digest,
  downloadRelease,
  expectedDigest,
  installBinary,
  looksExecutable,
  parseTag,
  platformTarget,
  readUpdateCache,
  releaseTag,
  runUpdate,
  scheduleAutoUpdate,
  updateCachePath,
  updateConfig,
  updateDue,
  updateIntervalMs,
  updateTarget,
  writeUpdateCache,
} from "../src/update.ts";

const temporary = () => mkdtempSync(join(tmpdir(), "crewplane-update-"));
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
    assert.equal(releaseTag("0.2.0"), "v0.2.0");
    assert.equal(releaseTag("v0.2.0"), "v0.2.0");
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
    assert.notEqual(statSync(path).mode & 0o077, 0o077);
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
    writeFileSync(target, "old", { mode: 0o755 });
    const outcome = await runUpdate({
      current: "0.2.0",
      checkOnly: true,
      environment: environment(join(directory, "cache")),
      standalone: true,
      execPath: target,
      platform: process.platform,
      arch: process.arch,
    });
    expect(outcome.status).toBe("available");
    expect(outcome.latest).toBe(patch);
    expect(outcome.target).toBe(target);
    assert.equal(readFileSync(target, "utf8"), "old");
  });

  it("reports current when the local version is not older", async () => {
    const directory = temporary();
    const outcome = await runUpdate({
      current: "10.0.0",
      environment: environment(join(directory, "cache")),
      standalone: true,
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
      standalone: false,
      execPath: "/usr/bin/bun",
    });
    expect(source.status).toBe("unsupported");
    const foreign = await runUpdate({
      current: "0.2.0",
      environment: environment(join(directory, "cache")),
      standalone: true,
      execPath: join(directory, "crewplane"),
      platform: "win32",
      arch: "x64",
    });
    expect(foreign.status).toBe("unsupported");
  });

  it("replaces the running executable atomically after verification", async () => {
    const directory = temporary();
    const target = join(directory, "crewplane");
    writeFileSync(target, "old", { mode: 0o755 });
    const outcome = await runUpdate({
      current: "0.2.0",
      environment: environment(join(directory, "cache")),
      standalone: true,
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
    writeFileSync(target, "old", { mode: 0o755 });
    await assert.rejects(
      runUpdate({
        current: "0.2.0",
        environment: environment(join(directory, "cache")),
        standalone: true,
        execPath: target,
        platform: process.platform,
        arch: process.arch,
      }),
      /Checksum mismatch/,
    );
    assert.equal(readFileSync(target, "utf8"), "old");
  });

  it("refuses an asset that is not a platform executable", async () => {
    release.bytes = Buffer.from("<html>not a binary</html>");
    release.checksum = sha256(release.bytes);
    const directory = temporary();
    await assert.rejects(
      runUpdate({
        current: "0.2.0",
        environment: environment(join(directory, "cache")),
        standalone: true,
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
        standalone: true,
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
    writeFileSync(target, "old", { mode: 0o755 });
    const updated = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      standalone: true,
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

    writeFileSync(target, "old", { mode: 0o755 });
    release.checksum = "c".repeat(64);
    const failed = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      standalone: true,
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
    assert.equal(readFileSync(target, "utf8"), "old");
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
      standalone: true,
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
      standalone: true,
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
      standalone: true,
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
    writeFileSync(target, "old", { mode: 0o755 });
    mkdirSync(join(cacheDirectory, "crewplane"), { recursive: true });
    writeFileSync(
      join(cacheDirectory, "crewplane", "update.lock"),
      JSON.stringify({ pid: 999_999_999 }),
    );
    const outcome = await runUpdate({
      current: "0.2.0",
      auto: true,
      environment: environment(cacheDirectory),
      standalone: true,
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
