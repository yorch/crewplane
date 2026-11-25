import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Config } from "./contracts.ts";
import {
  type BindingIdentity,
  bindControl,
  checkControlDirectory,
  ensureControlDirectory,
  legacySupervisorDirectory,
  legacyWatchdogDirectory,
} from "./control.ts";
import { control, validState } from "./engine/control-policy.ts";
import { validateConfig } from "./engine/supervisor.ts";
import { acquire } from "./engine/watch.ts";
import { publishJson, syncDirectory } from "./io.ts";

/** The one stable refusal for state-touching commands while an older layout exists. */
export const legacyRefusal =
  'Legacy supervisor state detected in the project store; run `crewplane migrate` before using this release (see docs/USAGE.md "Control directory")';

/** Operator verbs that may still halt live work while a legacy layout exists. */
const haltingCommands = new Set(["status", "stop", "pause", "cancel"]);
/** Narrowing controls are safe to apply late, so migration may re-arm them. */
const narrowing = new Set(["pause", "stop", "cancel"]);
const heartbeatFreshMs = 60000;
const heartbeatSkewMs = 5000;
const journalName = ".migrating-to";

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

/** Whether a PID is dead, ours, or someone else's (so it cannot be our supervisor). */
export type Owner = (pid: number) => "dead" | "ours" | "foreign";
export const processOwner: Owner = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "dead"
      : "foreign"; // EPERM: a process we may not signal is not ours
  }
  try {
    // Where /proc exists, the process must also be owned by this user.
    if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) return "foreign";
  } catch {
    /* no /proc: a successful signal probe already implies our uid */
  }
  return "ours";
};
const validPid = (pid: number | undefined): pid is number =>
  pid !== undefined && Number.isSafeInteger(pid) && pid > 0;

/**
 * What a supervisor directory (either layout) says about liveness. `credible`
 * is a process we own; `heartbeat` is a fresh running heartbeat without one
 * (a crash in the last minute looks identical); `suspicious` is claimed
 * liveness that cannot be ours or cannot be true and is named, not obeyed.
 */
export interface Liveness {
  credible: string | null;
  heartbeat: string | null;
  suspicious: string[];
}
export interface LivenessOptions {
  now?: number;
  owner?: Owner;
  /** Our own migration lease is not evidence of a supervisor. */
  skipLease?: boolean;
}
export function supervisorLiveness(
  directory: string,
  options: LivenessOptions = {},
): Liveness {
  const now = options.now ?? Date.now();
  const owner = options.owner ?? processOwner;
  const result: Liveness = { credible: null, heartbeat: null, suspicious: [] };
  const probe = (pid: number | undefined, label: string) => {
    if (!validPid(pid)) return;
    const who = owner(pid);
    if (who === "ours") result.credible ??= `${label} PID ${pid} is alive`;
    else if (who === "foreign")
      result.suspicious.push(`${label} PID ${pid} is not owned by you`);
  };
  const lease = object(readJson(join(directory, "watcher.lock")));
  if (lease && !options.skipLease) probe(pidOf(lease.pid), "supervisor lease");
  const state = object(readJson(join(directory, "state.json")));
  if (!state) return result;
  const heartbeat = Date.parse(String(state.checkedAt ?? ""));
  if (state.running === true) {
    probe(pidOf(state.pid), "recorded supervisor");
    if (Number.isFinite(heartbeat)) {
      if (heartbeat - now > heartbeatSkewMs)
        result.suspicious.push(
          "supervisor heartbeat is in the future (forged or clock skew)",
        );
      else if (now - heartbeat <= heartbeatFreshMs)
        result.heartbeat = "supervisor heartbeat is fresh";
    }
  }
  for (const record of Object.values(object(state.records) ?? {})) {
    const entry = object(record);
    if (!entry) continue;
    if (state.running === true || entry.status === "running") {
      probe(pidOf(entry.pid), "recorded child");
      probe(pidOf(entry.processGroupId), "recorded child process group");
    }
  }
  return result;
}
export const isLive = (value: Liveness) =>
  value.credible !== null || value.heartbeat !== null;
const evidence = (value: Liveness) =>
  [value.credible, value.heartbeat, ...value.suspicious].filter(Boolean);

const watchdogLiveness = (directory: string, owner: Owner): string | null => {
  const lease = object(readJson(join(directory, "lease", "owner.json")));
  const pid = pidOf(lease?.pid);
  return validPid(pid) && owner(pid) === "ours"
    ? `watchdog lease is held by live PID ${pid}`
    : null;
};

export interface ControlTarget {
  /** Where the command reads and (first) writes. */
  directory: string;
  /** Narrowing verbs are also queued here, since late application is safe. */
  also?: string[];
  warning?: string;
}
/**
 * Resolve which directory(ies) a command operates on. Without a legacy layout
 * it is the control directory. With one, state-touching commands refuse with
 * the stable message; the halting verbs stay usable. A live NEW supervisor
 * always wins (forged legacy state cannot divert a halt); a credibly live OLD
 * supervisor is addressed in the legacy directory; ambiguous legacy liveness
 * queues narrowing verbs into both directories.
 */
export function resolveControlTarget(
  store: string,
  control: string,
  command: string,
  options: LivenessOptions = {},
): ControlTarget {
  const legacy = legacySupervisorDirectory(store);
  if (!existsSync(legacy) && !isSymlink(legacy)) return { directory: control };
  if (haltingCommands.has(command)) {
    const old = supervisorLiveness(legacy, options);
    const note = evidence(old).length
      ? ` (legacy claims: ${evidence(old).join("; ")})`
      : "";
    if (isLive(supervisorLiveness(control, options)))
      return {
        directory: control,
        warning: `crewplane: a legacy supervisor directory exists in the project store and is being ignored for ${command}${note}; inspect it, then run \`crewplane migrate\``,
      };
    if (old.credible !== null)
      return {
        directory: legacy,
        also: [control],
        warning: `crewplane: an older-release supervisor is live in the project store; ${command} is queued in its legacy directory and in the control directory${note}. Stop it, then run \`crewplane migrate\``,
      };
    if (old.heartbeat !== null || old.suspicious.length)
      return {
        directory: control,
        also: [legacy],
        warning: `crewplane: legacy supervisor liveness is ambiguous${note}; ${command} is queued in both the control and legacy directories`,
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
      if (path === journalName) continue;
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
async function treeDigest(root: string) {
  const hash = createHash("sha256");
  for (const entry of scan(root).sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(
      `${entry.kind}\0${entry.path}\0${entry.size}\0${
        entry.kind === "file" ? await sha256(join(root, entry.path)) : ""
      }\n`,
    );
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
/** Every migrated entry is private to the user, whatever the old modes were. */
async function privatize(root: string) {
  await chmod(root, 0o700);
  for (const entry of scan(root))
    await chmod(
      join(root, entry.path),
      entry.kind === "directory" ? 0o700 : 0o600,
    );
}

export interface MoveOptions {
  /** Injectable for the cross-device path; defaults to fs rename. */
  rename?: typeof rename;
  /** Injectable copy, to simulate corruption. */
  copyFile?: typeof copyFile;
  /** Runs after the copy was published and before the source is retired. */
  afterPublish?: () => Promise<void>;
}
interface Journal {
  version: 1;
  destination: string;
  digest: string;
}
const readJournal = (from: string): Journal | null => {
  const value = object(readJson(join(from, journalName)));
  return value &&
    typeof value.destination === "string" &&
    typeof value.digest === "string"
    ? (value as unknown as Journal)
    : null;
};
/** A previous copy was published but the source was not yet retired. */
async function resumable(from: string, to: string): Promise<boolean> {
  const journal = readJournal(from);
  if (!journal || journal.destination !== to || !existsSync(to)) return false;
  return (await treeDigest(to)) === journal.digest;
}
async function retire(from: string) {
  const retired = join(
    dirname(from),
    `${basename(from)}.migrated-${randomUUID().slice(0, 8)}`,
  );
  await rename(from, retired);
  await syncDirectory(dirname(from));
  try {
    await rm(retired, { recursive: true });
    return null;
  } catch {
    return retired;
  }
}
/**
 * Move a verified tree: rename when possible; across filesystems journal the
 * source digest, copy, verify every file by size and SHA-256, fsync, publish
 * atomically and retire the source. A crash between publication and retirement
 * leaves the journal, so a rerun finishes retiring once the digests match; the
 * source is never removed on a mismatch.
 */
async function moveTree(
  from: string,
  to: string,
  options: MoveOptions,
): Promise<{ method: "rename" | "copy"; cleanup: string | null }> {
  const move = options.rename ?? rename;
  if (await resumable(from, to))
    return { method: "copy", cleanup: await retire(from) };
  await rm(join(from, journalName), { force: true });
  await chmod(from, 0o700);
  try {
    await move(from, to);
    await syncDirectory(dirname(to));
    await syncDirectory(dirname(from));
    return { method: "rename", cleanup: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const entries = scan(from);
  await writeFile(
    join(from, journalName),
    JSON.stringify({
      version: 1,
      destination: to,
      digest: await treeDigest(from),
    }),
    { mode: 0o600, flush: true },
  );
  const staging = `${to}.migrating-${process.pid}-${randomUUID().slice(0, 8)}`;
  const copy = options.copyFile ?? copyFile;
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const entry of entries.filter((e) => e.kind === "directory"))
      await mkdir(join(staging, entry.path), { mode: 0o700 });
    for (const entry of entries.filter((e) => e.kind === "file")) {
      const target = join(staging, entry.path);
      await copy(join(from, entry.path), target);
      await chmod(target, 0o600);
      await syncFile(target);
    }
    for (const entry of entries) {
      const source = join(from, entry.path);
      const duplicate = join(staging, entry.path);
      if (entry.kind === "directory") {
        await syncDirectory(duplicate);
        continue;
      }
      if (
        (await stat(duplicate)).size !== entry.size ||
        (await stat(source)).size !== entry.size ||
        (await sha256(duplicate)) !== (await sha256(source))
      )
        throw new Error(
          `Verification failed for ${printable(entry.path)}; nothing was removed`,
        );
    }
    await syncDirectory(staging);
    // The destination may be an existing empty directory; rename replaces it.
    await rename(staging, to);
    await syncDirectory(dirname(to));
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await rm(join(from, journalName), { force: true }).catch(() => {});
    throw error;
  }
  await options.afterPublish?.();
  return { method: "copy", cleanup: await retire(from) };
}

export interface MigrateOptions {
  store: string;
  control: string;
  /** Canonical primary root; a legacy configuration must belong to it. */
  root: string;
  identity?: BindingIdentity;
  dryRun?: boolean;
  discardLegacy?: boolean;
  /** Adopt the legacy configuration after the operator reviewed it. */
  acceptConfig?: boolean;
  move?: MoveOptions;
  owner?: Owner;
  now?: number;
  /** Test hook: runs after preflight, before leases are taken. */
  afterPreflight?: () => Promise<void>;
}
export interface PendingCommand {
  id: string;
  action: string;
}
export interface ConfigPreview {
  root: string;
  binary: string;
  allowedTasks: string[];
  maxParallel: number;
  lanes: Record<string, { enabled: boolean; harness: string }>;
}
export interface MigrateReport {
  version: 1;
  status: "migrated" | "dry-run" | "nothing-to-migrate" | "discarded";
  from: string | null;
  to: string;
  method: "rename" | "copy" | null;
  files: number;
  bytes: number;
  watchdog: boolean;
  rearmedCommands: PendingCommand[];
  quarantinedCommands: PendingCommand[];
  config: ConfigPreview | null;
  configAccepted: boolean;
  ignoredLivenessClaims: string[];
  discardedTo: string | null;
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
const previewOf = (config: Config): ConfigPreview => ({
  root: config.root,
  binary: config.binary,
  allowedTasks: [...config.allowedTasks],
  maxParallel: config.maxParallel,
  lanes: Object.fromEntries(
    Object.entries(config.lanes).map(([id, lane]) => [
      id,
      { enabled: lane.enabled, harness: lane.harness ?? "codex" },
    ]),
  ),
});
/** Review text for the operator; also the continuation of the refusal. */
export const describeConfig = (preview: ConfigPreview) =>
  [
    `  root:         ${printable(preview.root)}`,
    `  binary:       ${printable(preview.binary)}`,
    `  allowedTasks: ${preview.allowedTasks.map(printable).join(", ") || "(none)"}`,
    ...Object.entries(preview.lanes).map(
      ([id, lane]) =>
        `  agent ${printable(id)}: ${lane.enabled ? "enabled" : "disabled"}, ${lane.harness}`,
    ),
  ].join("\n");

/** Classify pending legacy commands; only narrowing ones are safe to re-arm. */
function classify(legacy: string) {
  const rearm: Array<PendingCommand & { value: unknown }> = [];
  const quarantine: Array<PendingCommand & { name: string }> = [];
  const directory = join(legacy, "commands");
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return { rearm, quarantine };
  }
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : name;
    let action = "invalid";
    try {
      const info = lstatSync(join(directory, name));
      if (
        info.isFile() &&
        /^[a-f0-9-]{36}\.json$/.test(name) &&
        info.size <= 65536
      ) {
        const value = control(
          JSON.parse(readFileSync(join(directory, name), "utf8")),
        );
        action = value.action;
        const cancelActive =
          (value as { cancelActive?: unknown }).cancelActive === true;
        if (narrowing.has(value.action) && !cancelActive) {
          rearm.push({ id, action, value });
          continue;
        }
      }
    } catch {
      /* undecodable: quarantined as invalid */
    }
    quarantine.push({ id, action, name });
  }
  return { rearm, quarantine };
}

/**
 * Relocate pre-relocation control state into the private control directory.
 * Refuses while anything credibly live, never deletes lease files, refuses a
 * non-empty destination, validates and previews the legacy configuration
 * before adopting it, and is idempotent. Pending narrowing commands are
 * re-armed after decoding; widening or undecodable ones are quarantined.
 */
export async function migrateControl(
  options: MigrateOptions,
): Promise<MigrateReport> {
  const owner = options.owner ?? processOwner;
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
    rearmedCommands: [],
    quarantinedCommands: [],
    config: null,
    configAccepted: false,
    ignoredLivenessClaims: [],
    discardedTo: null,
    leftover: null,
  };
  if (!hasSupervisor && !hasWatchdog)
    return { ...report, status: "nothing-to-migrate", from: null };

  const supervisorBlock = (skipLease = false): string | null => {
    if (!hasSupervisor) return null;
    const liveness = supervisorLiveness(legacy, {
      owner,
      skipLease,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    report.ignoredLivenessClaims = liveness.suspicious;
    return liveness.credible ?? liveness.heartbeat;
  };
  if (options.discardLegacy) {
    if (!hasSupervisor) return { ...report, status: "nothing-to-migrate" };
    const liveness = supervisorLiveness(legacy, {
      owner,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    report.ignoredLivenessClaims = liveness.suspicious;
    if (liveness.credible)
      throw new Error(
        `Refusing to discard: ${liveness.credible}. Stop that supervisor first`,
      );
    const target = `${legacy}.discarded-${new Date().toISOString().replace(/[^0-9A-Za-z]/g, "")}`;
    report.status = options.dryRun ? "dry-run" : "discarded";
    report.discardedTo = target;
    if (!options.dryRun) {
      await rename(legacy, target);
      await syncDirectory(dirname(legacy));
    }
    return report;
  }

  // Preconditions: nothing is changed until every one holds.
  if (hasSupervisor) {
    const bad = legacyProblem(legacy);
    if (bad)
      throw new Error(
        `Legacy supervisor directory ${bad}; inspect it manually`,
      );
  }
  const resuming = hasSupervisor && (await resumable(legacy, options.control));
  const entries: Entry[] = [];
  let classified = {
    rearm: [] as ReturnType<typeof classify>["rearm"],
    quarantine: [] as ReturnType<typeof classify>["quarantine"],
  };
  if (hasSupervisor) {
    const blocked = supervisorBlock();
    if (blocked)
      throw new Error(
        `Refusing to migrate: ${blocked}. Stop it first, or wait a minute if it only crashed${
          report.ignoredLivenessClaims.length
            ? ` (ignored claims: ${report.ignoredLivenessClaims.join("; ")})`
            : ""
        }. A forged directory can be set aside with \`crewplane migrate --discard-legacy\``,
      );
    entries.push(...scan(legacy));
    if (entries.some((e) => e.path === "watchdog"))
      throw new Error(
        "Legacy supervisor directory contains an unexpected watchdog entry; inspect it manually",
      );
    // Structural adoption: state and desired intent must decode; the
    // configuration is shown to the operator and adopted only on request.
    const rawState = readJson(join(legacy, "state.json"));
    if (
      existsSync(join(legacy, "state.json")) &&
      !(rawState !== null && validState(rawState))
    )
      throw new Error(
        "Legacy state.json failed structural validation; inspect it or set the directory aside with `crewplane migrate --discard-legacy`",
      );
    if (existsSync(join(legacy, "desired.json"))) {
      const desired = object(readJson(join(legacy, "desired.json")));
      if (!desired || typeof desired.desiredRunning !== "boolean")
        throw new Error(
          "Legacy desired.json failed structural validation; inspect it or set the directory aside with `crewplane migrate --discard-legacy`",
        );
    }
    if (existsSync(join(legacy, "config.json"))) {
      let config: Config;
      try {
        config = validateConfig(
          JSON.parse(readFileSync(join(legacy, "config.json"), "utf8")),
        );
      } catch (error) {
        throw new Error(
          `Legacy config.json failed validation (${printable(error instanceof Error ? error.message : "unreadable")}); inspect it or set the directory aside with \`crewplane migrate --discard-legacy\``,
        );
      }
      if (config.root !== options.root)
        throw new Error(
          `Legacy config.json belongs to another project root (${printable(config.root)}); refusing to adopt it`,
        );
      report.config = previewOf(config);
      report.configAccepted = options.acceptConfig === true;
      if (!options.dryRun && !options.acceptConfig)
        throw new Error(
          `Legacy config.json was writable by agents and must be reviewed before it is adopted. Rerun with \`--accept-config true\` if these values are what you configured:\n${describeConfig(report.config)}`,
        );
    }
    classified = classify(legacy);
  }
  const dogEntries: Entry[] = [];
  if (hasWatchdog) {
    const bad = legacyProblem(legacyDog);
    if (bad)
      throw new Error(`Legacy watchdog directory ${bad}; inspect it manually`);
    const live = watchdogLiveness(legacyDog, owner);
    if (live) throw new Error(`Refusing to migrate: ${live}. Stop it first`);
    dogEntries.push(...scan(legacyDog));
  }
  const destinationBusy = () => {
    if (!checkControlDirectory(options.control)) return false;
    return hasSupervisor && !resuming
      ? !isEmptyDirectory(options.control)
      : existsSync(join(options.control, "watchdog"));
  };
  const busyMessage = () =>
    `Refusing to migrate: ${printable(options.control)} already has content. Inspect both locations; remove or rename the legacy ${printable(hasSupervisor ? legacy : legacyDog)} once it is confirmed stale`;
  if (destinationBusy()) throw new Error(busyMessage());
  report.files = [...entries, ...dogEntries].filter(
    (e) => e.kind === "file",
  ).length;
  report.bytes = [...entries, ...dogEntries].reduce((n, e) => n + e.size, 0);
  report.watchdog = hasWatchdog;
  report.rearmedCommands = classified.rearm.map(({ id, action }) => ({
    id,
    action,
  }));
  report.quarantinedCommands = classified.quarantine.map(({ id, action }) => ({
    id,
    action,
  }));
  if (options.dryRun) return report;

  await options.afterPreflight?.();
  // Hold the lease older releases honour (unless a lease file is already
  // there: it is never replaced), then re-check everything that could have
  // changed since the preflight. A destination that appears later still makes
  // the final rename fail rather than merge.
  let release: (() => Promise<void>) | null = null;
  if (hasSupervisor && !resuming && !existsSync(join(legacy, "watcher.lock")))
    release = await acquire(legacy);
  try {
    if (hasSupervisor && !resuming) {
      const blocked = supervisorBlock(release !== null);
      if (blocked)
        throw new Error(
          `Refusing to migrate: ${blocked} (appeared during migration)`,
        );
    }
    if (hasWatchdog) {
      const live = watchdogLiveness(legacyDog, owner);
      if (live) throw new Error(`Refusing to migrate: ${live}. Stop it first`);
    }
    if (destinationBusy()) throw new Error(busyMessage());

    if (hasSupervisor) {
      if (!resuming) {
        const quarantineDirectory = join(legacy, "quarantined-commands");
        for (const item of classified.quarantine) {
          await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
          let target = join(quarantineDirectory, item.name);
          for (let n = 1; existsSync(target); n++)
            target = join(quarantineDirectory, `${item.name}.dup${n}`);
          await rename(join(legacy, "commands", item.name), target);
        }
        // Re-armed commands are rewritten from their decoded form.
        for (const item of classified.rearm)
          await publishJson(
            join(legacy, "commands", `${item.id}.json`),
            item.value,
          );
      }
      await ensureControlDirectory(options.control);
      const moved = await moveTree(legacy, options.control, options.move ?? {});
      report.method = moved.method;
      report.leftover = moved.cleanup;
      // Our own migration lease travelled with the tree; it is ours to drop.
      const lease = object(readJson(join(options.control, "watcher.lock")));
      if (lease?.pid === process.pid)
        await unlink(join(options.control, "watcher.lock")).catch(() => {});
    } else await ensureControlDirectory(options.control);
    if (hasWatchdog) {
      const moved = await moveTree(
        legacyDog,
        join(options.control, "watchdog"),
        options.move ?? {},
      );
      report.method ??= moved.method;
      report.leftover ??= moved.cleanup;
    }
    await privatize(options.control);
    if (options.identity)
      await bindControl(options.store, options.control, options.identity);
    checkControlDirectory(options.control);
  } finally {
    await release?.().catch(() => {});
  }
  return report;
}
