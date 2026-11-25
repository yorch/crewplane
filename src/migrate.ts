import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  checkControlDirectory,
  ensureControlDirectory,
  legacySupervisorDirectory,
  legacyWatchdogDirectory,
} from "./control.ts";
import { syncDirectory } from "./io.ts";
import { isProcessAlive } from "./update.ts";

/** The one stable refusal for every command while an older layout exists. */
export const legacyRefusal =
  'Legacy supervisor state detected in the project store; run `crewplane migrate` before any other command (see docs/USAGE.md "Control directory")';

/** Operator verbs that may still halt live work while a legacy layout exists. */
const haltingCommands = new Set(["status", "stop", "pause", "cancel"]);
const heartbeatFreshMs = 60000;

const printable = (value: string) => value.replace(/\p{Cc}/gu, "?");
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const pidOf = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const groupAlive = (pid: number | undefined) => {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/**
 * Why a supervisor directory (either layout) must be treated as live, or null.
 * Conservative: a live lease owner, a live recorded supervisor pid, a fresh
 * heartbeat while running, or any live recorded child blocks.
 */
export function supervisorLiveness(
  directory: string,
  now = Date.now(),
): string | null {
  const lease = object(readJson(join(directory, "watcher.lock")));
  if (lease && isProcessAlive(pidOf(lease.pid)))
    return `supervisor lease is held by live PID ${pidOf(lease.pid)}`;
  const state = object(readJson(join(directory, "state.json")));
  if (!state) return null;
  const heartbeat = Date.parse(String(state.checkedAt ?? ""));
  if (state.running === true) {
    if (isProcessAlive(pidOf(state.pid)))
      return `state records running supervisor PID ${pidOf(state.pid)}`;
    if (Number.isFinite(heartbeat) && now - heartbeat <= heartbeatFreshMs)
      return "supervisor heartbeat is fresh";
  }
  for (const record of Object.values(object(state.records) ?? {})) {
    const entry = object(record);
    if (!entry) continue;
    const child = pidOf(entry.processGroupId) ?? pidOf(entry.pid);
    if (
      (state.running === true || entry.status === "running") &&
      (groupAlive(child) || isProcessAlive(pidOf(entry.pid)))
    )
      return `recorded child process ${child} is alive`;
  }
  return null;
}
const watchdogLiveness = (directory: string): string | null => {
  const owner = object(readJson(join(directory, "lease", "owner.json")));
  return owner && isProcessAlive(pidOf(owner.pid))
    ? `watchdog lease is held by live PID ${pidOf(owner.pid)}`
    : null;
};

export interface ControlTarget {
  directory: string;
  warning?: string;
}
/**
 * Resolve which directory a command operates on. Without a legacy layout it is
 * the control directory. With one, every command refuses with the stable
 * message, except the halting verbs, which stay able to stop live work: against
 * the legacy directory while an old-release supervisor owns it, or against the
 * control directory while a new one does, each with a warning.
 */
export function resolveControlTarget(
  store: string,
  control: string,
  command: string,
): ControlTarget {
  const legacy = legacySupervisorDirectory(store);
  if (!existsSync(legacy) && !isSymlink(legacy)) return { directory: control };
  if (haltingCommands.has(command)) {
    if (supervisorLiveness(legacy) !== null)
      return {
        directory: legacy,
        warning: `crewplane: an older-release supervisor is live in the project store; ${command} operates on that legacy directory. Stop it, then run \`crewplane migrate\``,
      };
    if (supervisorLiveness(control) !== null)
      return {
        directory: control,
        warning: `crewplane: an unexpected legacy supervisor directory exists in the project store and is being ignored for ${command}; inspect it, then run \`crewplane migrate\``,
      };
  }
  throw new Error(legacyRefusal);
}
function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

interface Entry {
  path: string;
  kind: "file" | "directory";
  size: number;
}
/** Regular files and directories only; anything else is refused by name. */
function scan(root: string): Entry[] {
  const result: Entry[] = [];
  const visit = (relative: string) => {
    for (const item of readdirSync(join(root, relative), {
      withFileTypes: true,
    }) as Dirent[]) {
      const path = join(relative, item.name);
      const info = lstatSync(join(root, path));
      if (info.isDirectory()) {
        result.push({ path, kind: "directory", size: 0 });
        visit(path);
      } else if (info.isFile())
        result.push({ path, kind: "file", size: info.size });
      else
        throw new Error(
          `Cannot migrate ${printable(path)}: only regular files and directories are moved`,
        );
    }
  };
  visit("");
  return result;
}
async function sha256(path: string) {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
async function syncFile(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface MoveOptions {
  /** Injectable for the cross-device path; defaults to fs rename. */
  rename?: typeof rename;
}
/**
 * Move a verified tree: rename when possible; across filesystems copy, verify
 * every file by size and SHA-256, fsync, publish atomically, and only then
 * retire the source. Never leaves two populated copies behind.
 */
async function moveTree(
  from: string,
  to: string,
  entries: Entry[],
  options: MoveOptions,
): Promise<{ method: "rename" | "copy"; cleanup: string | null }> {
  const move = options.rename ?? rename;
  await chmod(from, 0o700);
  try {
    await move(from, to);
    await syncDirectory(dirname(to));
    await syncDirectory(dirname(from));
    return { method: "rename", cleanup: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const staging = `${to}.migrating-${process.pid}-${randomUUID().slice(0, 8)}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const entry of entries.filter((e) => e.kind === "directory"))
      await mkdir(join(staging, entry.path), { mode: 0o700 });
    for (const entry of entries.filter((e) => e.kind === "file")) {
      const target = join(staging, entry.path);
      await copyFile(join(from, entry.path), target);
      await chmod(target, 0o600);
      await syncFile(target);
    }
    for (const entry of entries) {
      const source = join(from, entry.path);
      const copy = join(staging, entry.path);
      if (entry.kind === "directory") {
        await syncDirectory(copy);
        continue;
      }
      if (
        (await stat(copy)).size !== entry.size ||
        (await stat(source)).size !== entry.size ||
        (await sha256(copy)) !== (await sha256(source))
      )
        throw new Error(
          `Verification failed for ${printable(entry.path)}; nothing was removed`,
        );
    }
    await syncDirectory(staging);
    // Destination may be an existing empty directory; rename replaces it.
    await rename(staging, to);
    await syncDirectory(dirname(to));
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // Retire the source atomically first so it can never be mistaken for live
  // legacy state, then delete it. A failed delete leaves an inert leftover.
  const retired = join(
    dirname(from),
    `${basename(from)}.migrated-${randomUUID().slice(0, 8)}`,
  );
  await rename(from, retired);
  await syncDirectory(dirname(from));
  try {
    await rm(retired, { recursive: true });
    return { method: "copy", cleanup: null };
  } catch {
    return { method: "copy", cleanup: retired };
  }
}

export interface MigrateOptions {
  store: string;
  control: string;
  dryRun?: boolean;
  move?: MoveOptions;
}
export interface MigrateReport {
  version: 1;
  status: "migrated" | "dry-run" | "nothing-to-migrate";
  from: string | null;
  to: string;
  method: "rename" | "copy" | null;
  files: number;
  bytes: number;
  watchdog: boolean;
  quarantinedCommands: number;
  leftover: string | null;
}

function legacyProblem(path: string): string | null {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    return "is not a plain directory";
  const uid = process.getuid?.();
  return uid !== undefined && info.uid !== uid
    ? "is not owned by the current user"
    : null;
}
const isEmptyDirectory = (path: string) => {
  try {
    return readdirSync(path).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};

/**
 * Relocate pre-relocation control state into the private control directory.
 * Refuses while anything is live, never deletes lease files, refuses a
 * non-empty destination, and is idempotent. Pending commands in the old
 * directory are agent-writable and unauthenticated, so they are quarantined
 * (kept, never applied) rather than re-armed.
 */
export async function migrateControl(
  options: MigrateOptions,
): Promise<MigrateReport> {
  const legacy = legacySupervisorDirectory(options.store);
  const legacyDog = legacyWatchdogDirectory(options.store);
  const hasSupervisor = existsSync(legacy) || isSymlink(legacy);
  const hasWatchdog = existsSync(legacyDog) || isSymlink(legacyDog);
  const report: MigrateReport = {
    version: 1,
    status: options.dryRun ? "dry-run" : "migrated",
    from: hasSupervisor ? legacy : null,
    to: options.control,
    method: null,
    files: 0,
    bytes: 0,
    watchdog: false,
    quarantinedCommands: 0,
    leftover: null,
  };
  if (!hasSupervisor && !hasWatchdog)
    return { ...report, status: "nothing-to-migrate", from: null };

  // Preconditions: nothing is changed until every one holds.
  const entries: Entry[] = [];
  if (hasSupervisor) {
    const bad = legacyProblem(legacy);
    if (bad)
      throw new Error(
        `Legacy supervisor directory ${bad}; inspect it manually`,
      );
    const live = supervisorLiveness(legacy);
    if (live) throw new Error(`Refusing to migrate: ${live}. Stop it first`);
    entries.push(...scan(legacy));
    if (entries.some((e) => e.path === "watchdog"))
      throw new Error(
        "Legacy supervisor directory contains an unexpected watchdog entry; inspect it manually",
      );
  }
  const dogEntries: Entry[] = [];
  if (hasWatchdog) {
    const bad = legacyProblem(legacyDog);
    if (bad)
      throw new Error(`Legacy watchdog directory ${bad}; inspect it manually`);
    const live = watchdogLiveness(legacyDog);
    if (live) throw new Error(`Refusing to migrate: ${live}. Stop it first`);
    dogEntries.push(...scan(legacyDog));
  }
  if (checkControlDirectory(options.control)) {
    const destinationBusy = hasSupervisor
      ? !isEmptyDirectory(options.control)
      : existsSync(join(options.control, "watchdog"));
    if (destinationBusy)
      throw new Error(
        `Refusing to migrate: ${printable(options.control)} already has content. Inspect both locations; remove or rename the legacy ${printable(hasSupervisor ? legacy : legacyDog)} once it is confirmed stale`,
      );
  }
  const commands = entries.filter(
    (e) => e.kind === "file" && dirname(e.path) === "commands",
  );
  report.files = [...entries, ...dogEntries].filter(
    (e) => e.kind === "file",
  ).length;
  report.bytes = [...entries, ...dogEntries].reduce((n, e) => n + e.size, 0);
  report.watchdog = hasWatchdog;
  report.quarantinedCommands = commands.length;
  if (options.dryRun) return report;

  if (hasSupervisor) {
    // Pending commands cannot be authenticated: park them before the move.
    if (commands.length) {
      await rename(
        join(legacy, "commands"),
        join(legacy, "quarantined-commands"),
      );
    }
    // Creates and verifies the parents; the move replaces the empty leaf.
    await ensureControlDirectory(options.control);
    const moved = await moveTree(
      legacy,
      options.control,
      scan(legacy),
      options.move ?? {},
    );
    report.method = moved.method;
    report.leftover = moved.cleanup;
    checkControlDirectory(options.control);
  } else await ensureControlDirectory(options.control);
  if (hasWatchdog) {
    const moved = await moveTree(
      legacyDog,
      join(options.control, "watchdog"),
      scan(legacyDog),
      options.move ?? {},
    );
    report.method ??= moved.method;
    report.leftover ??= moved.cleanup;
  }
  return report;
}
