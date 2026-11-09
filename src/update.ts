import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { syncDirectory } from "./io.ts";

/**
 * Self-update support for released binaries. The release contract is one
 * asset per platform plus a `<asset>.sha256` line; nothing here touches
 * project state, the supervisor or queued controls.
 */
export const releaseRepository = "yorch/crewplane";
export const defaultReleaseApi = `https://api.github.com/repos/${releaseRepository}/releases/latest`;
export const defaultReleaseBase = `https://github.com/${releaseRepository}/releases/download`;

export type UpdateEnvironment = Record<string, string | undefined>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<unknown>;
export type ReleaseTarget = { os: "linux" | "macos"; arch: "x86_64" | "arm64" };

export type UpdateConfig = {
  api: string;
  base: string;
  timeoutMs: number;
  maxAssetBytes: number;
};

export type UpdateCache = {
  version: 1;
  lastAttemptAt?: string;
  latest?: string;
  updatedAt?: string;
  error?: string;
};

export type UpdateStatus =
  | "current"
  | "available"
  | "updated"
  | "unsupported"
  | "failed";

export type UpdateOutcome = {
  version: 1;
  status: UpdateStatus;
  current: string;
  checkedAt: string;
  latest?: string;
  tag?: string;
  asset?: string;
  target?: string;
  reason?: string;
};

export type UpdateRequest = {
  current: string;
  checkOnly?: boolean;
  auto?: boolean;
  environment?: UpdateEnvironment;
  platform?: string;
  arch?: string;
  execPath?: string;
  standalone?: boolean;
  now?: Date;
  fetch?: FetchLike;
};

export type AutoUpdateRequest = {
  target: string;
  environment?: UpdateEnvironment;
  now?: Date;
  spawnProcess?: (file: string, args: string[]) => void;
};

const tagPattern =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z.-]+)?$/;
const machOMagic = [
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
];

export function platformTarget(
  platform: string = process.platform,
  machine: string = process.arch,
): ReleaseTarget | null {
  const os =
    platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const arch =
    machine === "x64" || machine === "x86_64" || machine === "amd64"
      ? "x86_64"
      : machine === "arm64" || machine === "aarch64"
        ? "arm64"
        : null;
  return os !== null && arch !== null ? { os, arch } : null;
}

export function releaseTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function parseTag(value: unknown): string {
  if (typeof value !== "string" || !tagPattern.test(value))
    throw new Error("Release tag is not a supported version");
  return value;
}

type ParsedVersion = { parts: [number, number, number]; pre: string };

function parseVersion(value: string): ParsedVersion {
  const stripped = value.replace(/^v/, "").split("+")[0] ?? "";
  const dash = stripped.indexOf("-");
  const core = dash < 0 ? stripped : stripped.slice(0, dash);
  const pre = dash < 0 ? "" : stripped.slice(dash + 1);
  const parts = core.split(".").map((part) => Number(part));
  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  )
    throw new Error(`Invalid version: ${value}`);
  return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre };
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split("."),
    b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index],
      y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x),
      yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (xNumeric) return -1;
    else if (yNumeric) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver ordering for release tags and package versions, ignoring a leading v. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left),
    b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return comparePrerelease(a.pre, b.pre);
}

export function assetName(tag: string, target: ReleaseTarget): string {
  return `crewplane-${parseTag(tag)}-${target.os}-${target.arch}`;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parse a published checksum file and require the expected asset name. */
export function expectedDigest(value: string, asset: string): string {
  for (const line of value.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})(?:\s+\*?(\S+))?\s*$/.exec(line.trim());
    if (!match) continue;
    const [, checksum, name] = match;
    if (name !== undefined && name !== asset) continue;
    return checksum ? checksum.toLowerCase() : "";
  }
  throw new Error(`Missing SHA-256 checksum for ${asset}`);
}

export function assertDigest(
  bytes: Uint8Array,
  expected: string,
  asset: string,
): void {
  if (digest(bytes) !== expected)
    throw new Error(`Checksum mismatch for ${asset}`);
}

export function looksExecutable(
  bytes: Uint8Array,
  os: ReleaseTarget["os"],
): boolean {
  if (os === "linux")
    return (
      bytes[0] === 0x7f &&
      bytes[1] === 0x45 &&
      bytes[2] === 0x4c &&
      bytes[3] === 0x46
    );
  return machOMagic.some((magic) =>
    magic.every((value, index) => bytes[index] === value),
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function updateConfig(
  environment: UpdateEnvironment = process.env,
): UpdateConfig {
  return {
    api: environment.CREWPLANE_RELEASE_API || defaultReleaseApi,
    base: (environment.CREWPLANE_RELEASE_BASE || defaultReleaseBase).replace(
      /\/+$/,
      "",
    ),
    timeoutMs: positiveInteger(environment.CREWPLANE_UPDATE_TIMEOUT_MS, 20_000),
    maxAssetBytes: positiveInteger(
      environment.CREWPLANE_UPDATE_MAX_BYTES,
      256 * 1024 * 1024,
    ),
  };
}

export function updateIntervalMs(
  environment: UpdateEnvironment = process.env,
): number {
  const hours = Number(environment.CREWPLANE_UPDATE_INTERVAL_HOURS ?? "");
  return Number.isFinite(hours) && hours > 0
    ? hours * 3_600_000
    : 24 * 3_600_000;
}

/** Automatic checking is opt-out; an explicit `crewplane update` always runs. */
export function autoUpdateDisabled(
  environment: UpdateEnvironment = process.env,
): boolean {
  const flag = (environment.CREWPLANE_NO_AUTO_UPDATE ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  const mode = (environment.CREWPLANE_UPDATE ?? "").trim().toLowerCase();
  return ["off", "never", "manual"].includes(mode);
}

export function updateCachePath(
  environment: UpdateEnvironment = process.env,
  home: string = homedir(),
  platform: string = process.platform,
): string {
  const explicit = environment.CREWPLANE_CACHE_DIR;
  const base =
    explicit !== undefined && explicit !== ""
      ? explicit
      : platform === "darwin"
        ? join(home, "Library", "Caches")
        : join(environment.XDG_CACHE_HOME || join(home, ".cache"));
  return join(base, "crewplane", "update.json");
}

function validCache(value: unknown): UpdateCache {
  if (typeof value !== "object" || value === null) return { version: 1 };
  const record = value as Record<string, unknown>;
  const cache: UpdateCache = { version: 1 };
  for (const key of [
    "lastAttemptAt",
    "latest",
    "updatedAt",
    "error",
  ] as const) {
    const item = record[key];
    if (typeof item === "string" && item !== "") cache[key] = item;
  }
  return cache;
}

export async function readUpdateCache(path: string): Promise<UpdateCache> {
  try {
    return validCache(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { version: 1 };
  }
}

export async function writeUpdateCache(
  path: string,
  cache: UpdateCache,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function updateDue(
  cache: UpdateCache,
  now: Date,
  intervalMs: number,
): boolean {
  const attempted = Date.parse(cache.lastAttemptAt ?? "");
  return !Number.isFinite(attempted) || now.getTime() - attempted >= intervalMs;
}

export function isStandaloneExecutable(): boolean {
  return typeof Bun !== "undefined" && Bun.isStandaloneExecutable === true;
}

/** Only a compiled release binary replaces itself; source runs are left alone. */
export function updateTarget(
  standalone: boolean,
  execPath: string,
): string | null {
  return standalone && execPath !== "" ? execPath : null;
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function apiHeaders(
  api: string,
  environment: UpdateEnvironment,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "crewplane-updater",
  };
  const token = environment.GITHUB_TOKEN || environment.GH_TOKEN;
  if (token === undefined || token === "") return headers;
  try {
    if (new URL(api).host !== "api.github.com") return headers;
  } catch {
    return headers;
  }
  headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchText(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = response as Response;
  if (!value.ok)
    throw new Error(`Release request failed: ${url} (HTTP ${value.status})`);
  return value.text();
}

async function fetchBytes(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const response = (await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  })) as Response;
  if (!response.ok)
    throw new Error(`Release request failed: ${url} (HTTP ${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`Release asset exceeds the size limit: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new Error(`Release asset exceeds the size limit: ${url}`);
  return bytes;
}

export async function resolveLatest(
  config: UpdateConfig,
  environment: UpdateEnvironment = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const text = await fetchText(
    config.api,
    fetchImpl,
    config.timeoutMs,
    apiHeaders(config.api, environment),
  );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Release lookup returned invalid JSON");
  }
  const tagName =
    typeof body === "object" && body !== null
      ? (body as { tag_name?: unknown }).tag_name
      : undefined;
  return parseTag(tagName);
}

export async function downloadRelease(
  tag: string,
  target: ReleaseTarget,
  config: UpdateConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ asset: string; bytes: Uint8Array }> {
  const asset = assetName(tag, target),
    base = `${config.base}/${tag}`,
    headers = { "user-agent": "crewplane-updater" };
  const checksums = await fetchText(
    `${base}/${asset}.sha256`,
    fetchImpl,
    config.timeoutMs,
    headers,
  );
  const expected = expectedDigest(checksums, asset);
  const bytes = await fetchBytes(
    `${base}/${asset}`,
    fetchImpl,
    config.timeoutMs,
    config.maxAssetBytes,
  );
  assertDigest(bytes, expected, asset);
  if (!looksExecutable(bytes, target.os))
    throw new Error(`Downloaded ${asset} is not a ${target.os} executable`);
  return { asset, bytes };
}

/** Replace the executable atomically inside its own directory. */
export async function installBinary(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  const directory = dirname(target);
  await access(directory, constants.W_OK).catch(() => {
    throw new Error(`Install directory is not writable: ${directory}`);
  });
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink())
    throw new Error(`Refusing to replace a symbolic link: ${target}`);
  if (existing !== null && !existing.isFile())
    throw new Error(`Refusing to replace a non-file: ${target}`);
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o700, flush: true });
    await chmod(temporary, 0o755);
    await syncDirectory(directory);
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function lockOwner(path: string): Promise<number | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const pid =
      typeof value === "object" && value !== null
        ? (value as { pid?: unknown }).pid
        : undefined;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/** A lock written moments ago may still be mid-publication; treat it as busy. */
async function recentlyWritten(path: string, now: Date): Promise<boolean> {
  try {
    const info = await stat(path);
    return now.getTime() - info.mtimeMs < 5_000;
  } catch {
    return false;
  }
}

async function acquireUpdateLock(
  cacheFile: string,
  now: Date,
): Promise<(() => Promise<void>) | null> {
  const directory = dirname(cacheFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "update.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, at: now.toISOString() })}\n`,
        );
      } finally {
        await handle.close();
      }
      return async () => {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await lockOwner(path);
      if (owner !== null && isProcessAlive(owner)) return null;
      if (owner === null && (await recentlyWritten(path, now))) return null;
      await unlink(path).catch(() => {});
    }
  }
  return null;
}

function mergeCache(
  previous: UpdateCache,
  patch: Partial<Omit<UpdateCache, "version">>,
): UpdateCache {
  const { error: _error, ...rest } = previous;
  return { ...rest, ...patch, version: 1 };
}

/**
 * Run an explicit or automatic update. Automatic runs are best-effort: any
 * failure is recorded in the cache instead of thrown.
 */
export async function runUpdate(
  request: UpdateRequest,
): Promise<UpdateOutcome> {
  const environment = request.environment ?? process.env,
    now = request.now ?? new Date(),
    checkedAt = now.toISOString(),
    config = updateConfig(environment),
    fetchImpl = request.fetch ?? fetch;
  const outcome = (
    values: Partial<Omit<UpdateOutcome, "version" | "current" | "checkedAt">>,
  ): UpdateOutcome => ({
    version: 1,
    current: request.current,
    checkedAt,
    status: values.status ?? "failed",
    ...values,
  });
  const targetPlatform = platformTarget(
    request.platform ?? process.platform,
    request.arch ?? process.arch,
  );
  const target = updateTarget(
    request.standalone ?? isStandaloneExecutable(),
    request.execPath ?? process.execPath,
  );
  if (targetPlatform === null || target === null)
    return outcome({
      status: "unsupported",
      reason: "Not an installed Linux or macOS release binary",
    });

  const perform = async (): Promise<UpdateOutcome> => {
    const tag = await resolveLatest(config, environment, fetchImpl);
    const latest = tag.slice(1);
    if (compareVersions(latest, request.current) <= 0)
      return outcome({ status: "current", latest, tag, target });
    if (request.checkOnly === true)
      return outcome({
        status: "available",
        latest,
        tag,
        target,
        asset: assetName(tag, targetPlatform),
      });
    const download = await downloadRelease(
      tag,
      targetPlatform,
      config,
      fetchImpl,
    );
    try {
      await installBinary(target, download.bytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Install failed";
      throw new Error(`${reason} (target: ${target})`);
    }
    return outcome({
      status: "updated",
      latest,
      tag,
      target,
      asset: download.asset,
    });
  };

  if (request.auto !== true) return perform();

  const cacheFile = updateCachePath(environment);
  const previous = await readUpdateCache(cacheFile);
  if (autoUpdateDisabled(environment)) {
    const result = outcome({ status: "unsupported", reason: "Disabled" });
    await writeUpdateCache(
      cacheFile,
      mergeCache(previous, {
        lastAttemptAt: checkedAt,
        error: "Disabled by environment",
      }),
    );
    return result;
  }
  const release = await acquireUpdateLock(cacheFile, now);
  if (release === null) {
    const result = outcome({
      status: "failed",
      reason: "Another update is already running",
    });
    await writeUpdateCache(
      cacheFile,
      mergeCache(previous, {
        lastAttemptAt: checkedAt,
        error: "Another update is already running",
      }),
    );
    return result;
  }
  try {
    const result = await perform();
    await writeUpdateCache(
      cacheFile,
      mergeCache(previous, {
        lastAttemptAt: checkedAt,
        ...(result.latest === undefined ? {} : { latest: result.latest }),
        ...(result.status === "updated" ? { updatedAt: checkedAt } : {}),
      }),
    );
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Update failed";
    await writeUpdateCache(
      cacheFile,
      mergeCache(previous, { lastAttemptAt: checkedAt, error: reason }),
    );
    return outcome({ status: "failed", reason });
  } finally {
    await release();
  }
}

function defaultDetachedSpawn(file: string, args: string[]): void {
  spawn(file, args, { detached: true, stdio: "ignore" }).unref();
}

/**
 * Start the detached updater at most once per interval. The record is written
 * before spawning so concurrent commands do not each start a download.
 */
export async function scheduleAutoUpdate(
  request: AutoUpdateRequest,
): Promise<boolean> {
  const environment = request.environment ?? process.env;
  const cacheFile = updateCachePath(environment);
  const now = request.now ?? new Date();
  const previous = await readUpdateCache(cacheFile);
  if (!updateDue(previous, now, updateIntervalMs(environment))) return false;
  await writeUpdateCache(
    cacheFile,
    mergeCache(previous, { lastAttemptAt: now.toISOString() }),
  );
  (request.spawnProcess ?? defaultDetachedSpawn)(request.target, [
    "update",
    "--auto",
  ]);
  return true;
}
