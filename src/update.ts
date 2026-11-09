import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { syncDirectory } from "./io.ts";

/**
 * Self-update support for release binaries. The release contract is one asset
 * per platform plus a `<asset>.sha256` line. Nothing here touches project
 * state, the supervisor, holds, budgets or queued controls.
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
  downloadTimeoutMs: number;
  maxAssetBytes: number;
};

export type UpdateCache = {
  version: 1;
  target?: string;
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
  releaseMarked?: boolean;
  now?: Date;
  fetch?: FetchLike;
  /** Re-checked immediately before the executable is replaced. */
  safeToReplace?: () => Promise<boolean>;
  /** Used to prove the staged binary runs and reports the released version. */
  runVersion?: (path: string) => Promise<string>;
};

export type AutoUpdateRequest = {
  target: string;
  environment?: UpdateEnvironment;
  now?: Date;
  spawnProcess?: (file: string, args: string[]) => void;
};

export type InstallOptions = {
  expectedVersion?: string;
  runVersion?: (path: string) => Promise<string>;
};

const tagPattern =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z.-]+)?$/;
const machOMagic = [
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
];
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const maxMetadataBytes = 1024 * 1024;
const lockExpiryMs = 3_600_000;
const staleTemporaryMs = 3_600_000;

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
    const checksum = match[1] ?? "",
      name = match[2];
    if (name !== undefined && name !== asset) continue;
    return checksum.toLowerCase();
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

/** Custom sources must be encrypted, except for explicit loopback test servers. */
function releaseUrl(value: string | undefined, fallback: string): string {
  const text = value === undefined || value === "" ? fallback : value;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Release URL is invalid");
  }
  if (parsed.protocol === "https:") return text;
  if (parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname))
    return text;
  throw new Error("Release URL must use https");
}

export function updateConfig(
  environment: UpdateEnvironment = process.env,
): UpdateConfig {
  return {
    api: releaseUrl(environment.CREWPLANE_RELEASE_API, defaultReleaseApi),
    base: releaseUrl(
      environment.CREWPLANE_RELEASE_BASE,
      defaultReleaseBase,
    ).replace(/\/+$/, ""),
    timeoutMs: positiveInteger(environment.CREWPLANE_UPDATE_TIMEOUT_MS, 20_000),
    downloadTimeoutMs: positiveInteger(
      environment.CREWPLANE_UPDATE_DOWNLOAD_TIMEOUT_MS,
      300_000,
    ),
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

export function cacheDirectory(
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
  return join(base, "crewplane");
}

export function updateCachePath(
  environment: UpdateEnvironment = process.env,
  home: string = homedir(),
  platform: string = process.platform,
): string {
  return join(cacheDirectory(environment, home, platform), "update.json");
}

function validCache(value: unknown): UpdateCache {
  if (typeof value !== "object" || value === null) return { version: 1 };
  const record = value as Record<string, unknown>;
  const cache: UpdateCache = { version: 1 };
  for (const key of [
    "target",
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

/**
 * A due check needs no record, an elapsed interval, or a record from a
 * different install path. Future timestamps are treated as due so a clock
 * jump or edited cache cannot suppress updates forever.
 */
export function updateDue(
  cache: UpdateCache,
  now: Date,
  intervalMs: number,
  target?: string,
): boolean {
  if (
    target !== undefined &&
    cache.target !== undefined &&
    cache.target !== target
  )
    return true;
  const attempted = Date.parse(cache.lastAttemptAt ?? "");
  if (!Number.isFinite(attempted)) return true;
  if (attempted > now.getTime()) return true;
  return now.getTime() - attempted >= intervalMs;
}

/**
 * Release builds compile with
 * `--define 'process.env.CREWPLANE_RELEASE_BUILD="1"'`, so this returns true
 * without reading the environment. Local builds keep the runtime lookup.
 */
export function isReleaseBuild(): boolean {
  return process.env.CREWPLANE_RELEASE_BUILD === "1";
}

/** Only a compiled, release-marked binary replaces itself. */
export function updateTarget(
  releaseMarked: boolean,
  execPath: string,
): string | null {
  return releaseMarked && execPath !== "" ? execPath : null;
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

export const longRunningCommands = [
  "start",
  "dashboard",
  "watchdog",
  "monitor",
] as const;

export type ScheduleDecision = {
  command: string;
  environment: UpdateEnvironment;
  releaseMarked: boolean;
  execPath: string;
  cache: UpdateCache;
  now?: Date;
  supervisorLive: boolean;
};

/** Read-only decision used before a detached update is scheduled. */
export function shouldScheduleUpdate(input: ScheduleDecision): boolean {
  if (input.supervisorLive) return false;
  if ((longRunningCommands as readonly string[]).includes(input.command))
    return false;
  if (autoUpdateDisabled(input.environment)) return false;
  const target = updateTarget(input.releaseMarked, input.execPath);
  if (target === null) return false;
  return updateDue(
    input.cache,
    input.now ?? new Date(),
    updateIntervalMs(input.environment),
    target,
  );
}

function lockOwnerFor(path: string) {
  return readFile(path, "utf8")
    .then((value) => {
      let record: unknown;
      try {
        record = JSON.parse(value);
      } catch {
        return null;
      }
      if (typeof record !== "object" || record === null) return null;
      const { pid, token, at } = record as {
        pid?: unknown;
        token?: unknown;
        at?: unknown;
      };
      if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return null;
      return {
        pid,
        token: typeof token === "string" ? token : "",
        at: typeof at === "string" ? at : "",
      };
    })
    .catch(() => null);
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

/** A lock with no readable timestamp is never salvaged by age alone. */
function lockExpired(at: string, now: Date): boolean {
  const written = Date.parse(at);
  if (!Number.isFinite(written)) return false;
  return now.getTime() - written >= lockExpiryMs;
}

async function acquireUpdateLock(
  cacheFile: string,
  now: Date,
): Promise<(() => Promise<void>) | null> {
  const directory = dirname(cacheFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "update.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token, at: now.toISOString() })}\n`,
        );
      } finally {
        await handle.close();
      }
      return async () => {
        const owner = await lockOwnerFor(path);
        if (owner === null || owner.token !== token) return;
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await lockOwnerFor(path);
      if (
        owner !== null &&
        isProcessAlive(owner.pid) &&
        !lockExpired(owner.at, now)
      )
        return null;
      if (owner === null && (await recentlyWritten(path, now))) return null;
      await unlink(path).catch(() => {});
    }
  }
  return null;
}

/**
 * Announce a running supervisor so the per-user updater never replaces the
 * executable under it. Registrations are best effort and PID-based.
 */
export async function registerSupervisor(
  environment: UpdateEnvironment = process.env,
): Promise<() => Promise<void>> {
  const directory = join(cacheDirectory(environment), "supervisors");
  const path = join(directory, `${process.pid}.json`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      `${JSON.stringify({ version: 1, pid: process.pid, at: new Date().toISOString() })}\n`,
      { mode: 0o600, flush: true },
    );
  } catch {
    return async () => {};
  }
  return async () => {
    await unlink(path).catch(() => {});
  };
}

/** Any live registration, from any project, blocks automatic replacement. */
export async function supervisorRunning(
  environment: UpdateEnvironment = process.env,
): Promise<boolean> {
  const directory = join(cacheDirectory(environment), "supervisors");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return false;
  }
  let running = false;
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    const path = join(directory, entry);
    const owner = await lockOwnerFor(path);
    const pid = owner?.pid ?? Number(entry.slice(0, -".json".length));
    if (isProcessAlive(pid)) running = true;
    else await unlink(path).catch(() => {});
  }
  return running;
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
    const url = new URL(api);
    if (url.protocol !== "https:" || url.host !== "api.github.com")
      return headers;
  } catch {
    return headers;
  }
  headers.authorization = `Bearer ${token}`;
  return headers;
}

async function readBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error("Release response exceeds the size limit");
  const body = response.body;
  if (body === null) return new Uint8Array(await response.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Release response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchText(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  headers: Record<string, string>,
  options: { redirect?: RequestRedirect; maxBytes?: number } = {},
): Promise<string> {
  const response = (await fetchImpl(url, {
    headers,
    // The release API answers directly; asset metadata redirects to storage.
    redirect: options.redirect ?? "manual",
    signal: AbortSignal.timeout(timeoutMs),
  })) as Response;
  if (!response.ok)
    throw new Error(`Release request failed: ${url} (HTTP ${response.status})`);
  return new TextDecoder().decode(
    await readBody(response, options.maxBytes ?? maxMetadataBytes),
  );
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
  return readBody(response, maxBytes);
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
    { redirect: "follow" },
  );
  const expected = expectedDigest(checksums, asset);
  const bytes = await fetchBytes(
    `${base}/${asset}`,
    fetchImpl,
    config.downloadTimeoutMs,
    config.maxAssetBytes,
  );
  assertDigest(bytes, expected, asset);
  if (!looksExecutable(bytes, target.os))
    throw new Error(`Downloaded ${asset} is not a ${target.os} executable`);
  return { asset, bytes };
}

function runVersion(path: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      path,
      ["--version"],
      { timeout: 15_000, encoding: "utf8", env: {}, windowsHide: true },
      (error, stdout) => {
        if (error)
          fail(new Error(`Downloaded binary failed to run: ${error.message}`));
        else done(stdout.trim());
      },
    );
  });
}

async function removeStaleTemporaries(directory: string, name: string) {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - staleTemporaryMs;
  for (const entry of entries) {
    if (!entry.startsWith(`.${name}.`) || !entry.endsWith(".tmp")) continue;
    const path = join(directory, entry);
    try {
      const info = await lstat(path);
      if (info.isFile() && info.mtimeMs <= cutoff) await unlink(path);
    } catch {
      /* best effort */
    }
  }
}

/** Replace the executable atomically inside its own directory. */
export async function installBinary(
  target: string,
  bytes: Uint8Array,
  options: InstallOptions = {},
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
  const uid = process.getuid?.();
  if (existing !== null && uid !== undefined && existing.uid !== uid)
    throw new Error(
      `Refusing to replace a file owned by another user: ${target}`,
    );
  const mode = existing === null ? 0o755 : existing.mode & 0o777;
  await removeStaleTemporaries(directory, basename(target));
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
    await chmod(temporary, mode);
    if (options.expectedVersion !== undefined) {
      const reported = await (options.runVersion ?? runVersion)(temporary);
      if (reported !== options.expectedVersion)
        throw new Error(
          `Downloaded binary reports ${reported === "" ? "nothing" : reported} but ${options.expectedVersion} was requested`,
        );
    }
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function mergeCache(
  previous: UpdateCache,
  patch: Partial<Omit<UpdateCache, "version">>,
): UpdateCache {
  const { error: _error, ...rest } = previous;
  return { ...rest, ...patch, version: 1 };
}

/** Keep only the variables a detached updater needs; never inherit tokens. */
function childEnvironment(environment: UpdateEnvironment): NodeJS.ProcessEnv {
  const kept = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "SystemRoot",
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (kept.has(key) || key.startsWith("CREWPLANE_")) result[key] = value;
  }
  return result;
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
    request.releaseMarked ?? isReleaseBuild(),
    request.execPath ?? process.execPath,
  );
  if (targetPlatform === null || target === null)
    return outcome({
      status: "unsupported",
      reason: "Not an installed Linux or macOS release binary",
    });

  const safeToReplace =
    request.safeToReplace ??
    (async () => !(await supervisorRunning(environment)));
  const perform = async (): Promise<UpdateOutcome> => {
    if (request.checkOnly !== true && !(await safeToReplace()))
      throw new Error(
        "A supervisor is running; stop it before replacing the executable",
      );
    const config = updateConfig(environment);
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
    if (!(await safeToReplace()))
      throw new Error(
        "A supervisor started during the update; the executable was not replaced",
      );
    try {
      await installBinary(target, download.bytes, {
        expectedVersion: latest,
        ...(request.runVersion === undefined
          ? {}
          : { runVersion: request.runVersion }),
      });
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

  if (request.checkOnly === true) return perform();

  const cacheFile = updateCachePath(environment);
  let previous = await readUpdateCache(cacheFile);
  if (request.auto === true && autoUpdateDisabled(environment)) {
    await writeUpdateCache(
      cacheFile,
      mergeCache(previous, {
        target,
        lastAttemptAt: checkedAt,
        error: "Disabled by environment",
      }),
    );
    return outcome({ status: "unsupported", reason: "Disabled" });
  }
  const release = await acquireUpdateLock(cacheFile, now);
  if (release === null) {
    const reason = "Another update is already running";
    if (request.auto !== true) throw new Error(reason);
    await writeUpdateCache(
      cacheFile,
      mergeCache(previous, { target, lastAttemptAt: checkedAt, error: reason }),
    );
    return outcome({ status: "failed", reason });
  }
  try {
    // Another command may have written the cache while this lock was pending.
    previous = await readUpdateCache(cacheFile);
    const result = await perform();
    if (request.auto === true)
      await writeUpdateCache(
        cacheFile,
        mergeCache(previous, {
          target,
          lastAttemptAt: checkedAt,
          ...(result.latest === undefined ? {} : { latest: result.latest }),
          ...(result.status === "updated" ? { updatedAt: checkedAt } : {}),
        }),
      );
    return result;
  } catch (error) {
    if (request.auto !== true) throw error;
    const reason = error instanceof Error ? error.message : "Update failed";
    await writeUpdateCache(
      cacheFile,
      mergeCache(previous, { target, lastAttemptAt: checkedAt, error: reason }),
    );
    return outcome({ status: "failed", reason });
  } finally {
    await release();
  }
}

function defaultDetachedSpawn(
  file: string,
  args: string[],
  environment: UpdateEnvironment,
): void {
  const child = spawn(file, args, {
    detached: true,
    stdio: "ignore",
    cwd: tmpdir(),
    env: childEnvironment(environment),
  });
  child.on("error", () => {});
  child.unref();
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
  if (!updateDue(previous, now, updateIntervalMs(environment), request.target))
    return false;
  await writeUpdateCache(
    cacheFile,
    mergeCache(previous, {
      target: request.target,
      lastAttemptAt: now.toISOString(),
    }),
  );
  if (request.spawnProcess !== undefined)
    request.spawnProcess(request.target, ["update", "--auto"]);
  else defaultDetachedSpawn(request.target, ["update", "--auto"], environment);
  return true;
}
