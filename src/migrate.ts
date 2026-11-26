import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Config } from "./contracts.ts";
import {
  type BindingIdentity,
  checkControlDirectory,
  completeBinding,
  ensureControlDirectory,
  identityText,
  legacySupervisorDirectory,
  legacyWatchdogDirectory,
  storeMarkerId,
} from "./control.ts";
import { control, validState } from "./engine/control-policy.ts";
import { validHarness } from "./engine/harness.ts";
import { validateConfig } from "./engine/supervisor.ts";
import { acquire } from "./engine/watch.ts";
import { sha256Hex } from "./hash.ts";
import { syncDirectory } from "./io.ts";
import { probeProcess } from "./liveness.ts";
import { validId, validTaskId } from "./project.ts";
import { cacheDirectory } from "./update.ts";

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
/** Bounds on what migration will read from an agent-writable tree. */
export const limits = {
  file: 1024 * 1024,
  command: 64 * 1024,
  total: 8 * 1024 * 1024,
  commands: 256,
  inventory: 512,
  count: 10000,
  timeoutMs: 30000,
};

/** Terminal- and bidi-safe rendering: Cc (incl. C1), Cf, Zl and Zp are escaped. */
export const visible = (value: string) =>
  value.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );
/** Escape format, separator and C1 characters inside JSON text; ordinary JSON whitespace is untouched. */
export const escapeJsonText = (value: string) =>
  value.replace(/[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu, (c) => {
    let out = "";
    for (let i = 0; i < c.length; i++)
      out += `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`;
    return out;
  });
const printable = visible;
/** Bounded, non-blocking JSON read: a FIFO, symlink or huge file is simply null. */
const readBoundedBuffer = (path: string, cap: number): Buffer | null => {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        constants.O_NOCTTY,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > cap) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
export const readBoundedJson = (path: string): unknown => readJson(path);
const readJson = (path: string): unknown => {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        constants.O_NOCTTY,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limits.file) return null;
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const pidOf = (value: unknown) =>
  typeof value === "number" ? value : undefined;
/** Real child/supervisor identities are never PID 0 or 1. */
const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
const sha = sha256Hex;

/** Whether a PID is dead, ours, or someone else's (so it cannot be our supervisor). */
export type Owner = (pid: number) => "dead" | "ours" | "foreign";
export const processOwner: Owner = (pid) => {
  const state = probeProcess(pid);
  if (state === "dead") return "dead";
  // EPERM (or any other probe failure): a process we may not signal is not ours.
  if (state === "unknown") return "foreign";
  try {
    // Where /proc exists, the process must also be owned by this user.
    if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) return "foreign";
  } catch {
    /* no /proc: a successful signal probe already implies our uid */
  }
  return "ours";
};

let cachedTicks: number | undefined;
const clockTicks = () => {
  if (cachedTicks === undefined)
    try {
      cachedTicks =
        Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" })) ||
        100;
    } catch {
      cachedTicks = 100;
    }
  return cachedTicks;
};

interface ProcessInfo {
  start: number | null;
  exe: string | null;
  argv: string[] | null;
}
/** Start time (epoch ms), executable and command line of a process, best effort. */
export function processInfo(pid: number): ProcessInfo {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const btime = Number(
      /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1],
    );
    const hz = clockTicks();
    let exe: string | null = null;
    try {
      exe = realpathSync(readlinkSync(`/proc/${pid}/exe`));
    } catch {
      /* not readable */
    }
    return {
      start:
        Number.isFinite(ticks) && Number.isFinite(btime)
          ? btime * 1000 + (ticks / hz) * 1000
          : null,
      exe,
      argv: readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean),
    };
  } catch {
    /* no /proc: fall back to ps */
  }
  try {
    const ps = (field: string) =>
      execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    const start = Date.parse(ps("lstart"));
    return {
      start: Number.isFinite(start) ? start : null,
      exe: ps("comm") || null,
      argv: ps("args").split(/\s+/).filter(Boolean),
    };
  } catch {
    return { start: null, exe: null, argv: null };
  }
}
const describeProcess = (pid: number) => {
  const info = processInfo(pid);
  return visible(
    `${info.exe ?? "unknown executable"}: ${(info.argv ?? []).join(" ")}`.slice(
      0,
      300,
    ),
  );
};
/**
 * A PID is only a credible supervisor if BOTH hold: the per-user registry has an
 * entry whose registration time fits this very process (it registered shortly
 * after this process started, so a recycled PID or a later forgery does not
 * match) AND the executable is crewplane or bun running a start command that
 * is not an inline script. Any same-user PID can be named in a lease an agent
 * can edit.
 */
export const registeredSupervisor = (pid: number): boolean => {
  const info = processInfo(pid);
  if (info.start === null || info.argv === null) return false;
  try {
    const entry = object(
      readJson(join(cacheDirectory(), "supervisors", `${pid}.json`)),
    );
    const at = Date.parse(String(entry?.at ?? ""));
    if (!entry || !Number.isFinite(at)) return false;
    if (at < info.start - 2000 || at - info.start > 300000) return false;
  } catch {
    return false;
  }
  const exe = basename(info.exe ?? info.argv[0] ?? "");
  const inline = info.argv.some((arg) =>
    ["-e", "--eval", "-p", "--print"].includes(arg),
  );
  if (inline || !info.argv.includes("start")) return false;
  if (exe === "crewplane") return true;
  return (
    exe === "bun" &&
    info.argv.some(
      (arg) => basename(arg) === "cli.ts" && dirname(arg).endsWith("src"),
    )
  );
};

/**
 * What a supervisor directory (either layout) says about liveness. `credible`
 * is a registered Crewplane supervisor we own; `heartbeat` is a fresh running
 * heartbeat; `children` is a recorded child process we own; `suspicious` is
 * claimed liveness that cannot be ours or cannot be true, named and not obeyed.
 */
export interface Liveness {
  credible: string | null;
  heartbeat: string | null;
  children: string | null;
  suspicious: string[];
}
export interface LivenessOptions {
  now?: number;
  owner?: Owner;
  isSupervisor?: (pid: number) => boolean;
  /** Our own migration lease is not evidence of a supervisor. */
  skipLease?: boolean;
  /** PIDs the operator explicitly declared irrelevant (`--ignore-pid`). */
  ignorePids?: ReadonlySet<number>;
}
export function supervisorLiveness(
  directory: string,
  options: LivenessOptions = {},
): Liveness {
  const now = options.now ?? Date.now();
  const owner = options.owner ?? processOwner;
  const isSupervisor = options.isSupervisor ?? registeredSupervisor;
  const result: Liveness = {
    credible: null,
    heartbeat: null,
    children: null,
    suspicious: [],
  };
  const probe = (
    pid: number | undefined,
    label: string,
    supervisor: boolean,
  ) => {
    if (!validPid(pid) || options.ignorePids?.has(pid)) return;
    const who = owner(pid);
    if (who === "foreign")
      result.suspicious.push(`${label} PID ${pid} is not owned by you`);
    else if (who === "ours") {
      const what = describeProcess(pid);
      if (!supervisor)
        result.children ??= `${label} PID ${pid} is alive (${what})`;
      else if (isSupervisor(pid))
        result.credible ??= `${label} PID ${pid} is alive (${what})`;
      else
        result.suspicious.push(
          `${label} PID ${pid} is not a registered Crewplane supervisor (${what})`,
        );
    }
  };
  const lease = object(readJson(join(directory, "watcher.lock")));
  if (lease && !options.skipLease)
    probe(pidOf(lease.pid), "supervisor lease", true);
  const state = object(readJson(join(directory, "state.json")));
  if (!state) return result;
  const heartbeat = Date.parse(String(state.checkedAt ?? ""));
  if (state.running === true) {
    probe(pidOf(state.pid), "recorded supervisor", true);
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
      probe(pidOf(entry.pid), "recorded child", false);
      probe(pidOf(entry.processGroupId), "recorded child process group", false);
    }
  }
  return result;
}
export const isLive = (value: Liveness) =>
  value.credible !== null ||
  value.heartbeat !== null ||
  value.children !== null;
const evidence = (value: Liveness): string[] =>
  [value.credible, value.heartbeat, value.children, ...value.suspicious].filter(
    (item): item is string => typeof item === "string",
  );

export interface ControlTarget {
  /** Where the command reads and (first) writes. */
  directory: string;
  /** Narrowing verbs are also queued here, since late application is safe. */
  also?: string[];
  warning?: string;
  /** Legacy state is never routed to as truth; status shows it as unverified. */
  unverifiedLegacy?: string;
}
/**
 * Resolve which directory(ies) a command operates on. Without a legacy layout
 * it is the control directory. With one, state-touching commands refuse with
 * the stable message; the halting verbs stay usable. A live NEW supervisor
 * always wins (forged legacy state cannot divert a halt); a credibly live OLD
 * supervisor is addressed in the legacy directory for narrowing verbs only;
 * ambiguous legacy liveness queues narrowing verbs into both directories.
 * `status` always reads the control directory and shows legacy state only as
 * unverified.
 */
export function resolveControlTarget(
  store: string,
  control: string,
  command: string,
  options: LivenessOptions = {},
): ControlTarget {
  const legacy = legacySupervisorDirectory(store);
  // An empty or inert directory (no regular file anywhere in it) is not state.
  if (!legacyPresent(legacy)) return { directory: control };
  if (haltingCommands.has(command)) {
    const old = supervisorLiveness(legacy, options);
    const note = evidence(old).length
      ? ` (legacy claims: ${evidence(old).join("; ")})`
      : "";
    if (command === "status")
      return {
        directory: control,
        unverifiedLegacy: legacy,
        warning: `crewplane: a legacy supervisor directory exists in the project store; its state is shown as unverified (agents can write it)${note}. Run \`crewplane migrate\``,
      };
    if (isLive(supervisorLiveness(control, options)))
      return {
        directory: control,
        warning: `crewplane: a legacy supervisor directory exists in the project store and is being ignored for ${command}${note}; inspect it, then run \`crewplane migrate\``,
      };
    if (old.credible !== null)
      return {
        directory: legacy,
        also: [control],
        warning: `crewplane: an older-release supervisor is live in the project store; ${command} is queued in its legacy directory and in the control directory${note}. Anything read from the legacy directory is unverified (agents can write it). Stop it, then run \`crewplane migrate\``,
      };
    if (isLive(old) || old.suspicious.length)
      return {
        directory: control,
        also: [legacy],
        warning: `crewplane: legacy supervisor liveness is ambiguous${note}; ${command} is queued in both the control and legacy directories`,
      };
    // Halting must never be refused: with nothing live anywhere, the verb is
    // simply queued in the control directory.
    return {
      directory: control,
      warning: `crewplane: legacy supervisor state exists in the project store and is not used; ${command} is queued in the control directory. Run \`crewplane migrate\``,
    };
  }
  throw new Error(legacyRefusal);
}
/** Whether a legacy directory holds anything at all (a symlink always counts). */
export function legacyPresent(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return true;
    let budget = limits.count;
    const walk = (directory: string): boolean => {
      for (const name of readdirSync(directory)) {
        if (budget-- <= 0) return true;
        const child = join(directory, name);
        const entry = lstatSync(child);
        if (!entry.isDirectory() || walk(child)) return true;
      }
      return false;
    };
    return walk(path);
  } catch {
    return false;
  }
}
function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Sorted-key JSON so equal values print and hash identically. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const canonicalText = (value: unknown) =>
  `${JSON.stringify(canonical(value), null, 2)}\n`;

export interface MoveOptions {
  /** Test hook: runs after each fresh staged file is written, before verification. */
  afterStageFile?: (path: string) => Promise<void>;
  /** Test hook: runs after the snapshot was read, before it is interpreted. */
  afterSnapshot?: () => Promise<void>;
  /** Runs after the staged tree was published and before the source is retired. */
  afterPublish?: () => Promise<void>;
}
interface Journal {
  version: 1;
  destination: string;
  digest: string;
}
/**
 * The journal lives in the private control parent, never in the agent-writable
 * legacy tree, so a forged journal can never mark a migration as resumable.
 */
const journalPath = (control: string) =>
  join(dirname(control), `${basename(control)}.migrating.json`);
const readJournal = (control: string): Journal | null => {
  const value = object(readJson(journalPath(control)));
  return value &&
    typeof value.destination === "string" &&
    typeof value.digest === "string"
    ? (value as unknown as Journal)
    : null;
};
async function treeDigest(root: string) {
  const hash = createHash("sha256");
  const visit = async (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = join(relative, name);
      const info = lstatSync(join(root, path));
      if (info.isDirectory()) {
        hash.update(`d\0${path}\n`);
        await visit(path);
      } else if (info.isFile())
        hash.update(`f\0${path}\0${sha(await readFile(join(root, path)))}\n`);
      else hash.update(`x\0${path}\n`);
    }
  };
  await visit("");
  return hash.digest("hex");
}
/** A previous run published its staged copy but did not retire the source. */
async function resumable(to: string): Promise<boolean> {
  const journal = readJournal(to);
  if (!journal || journal.destination !== to || !existsSync(to)) return false;
  return (await treeDigest(to)) === journal.digest;
}
/** Retire a legacy tree: renamed aside and KEPT, never deleted, for inspection. */
async function retire(from: string) {
  const retired = join(
    dirname(from),
    `${basename(from)}.migrated-${randomUUID().slice(0, 8)}`,
  );
  await rename(from, retired);
  await syncDirectory(dirname(from));
  return retired;
}

type Read = { data: Buffer } | { left: string };
/**
 * Bounded read of one named file from an agent-writable tree: opened without
 * following symlinks, without blocking on FIFOs and without becoming a
 * controlling terminal; size is checked on the descriptor BEFORE reading.
 */
async function boundedRead(path: string, cap: number): Promise<Read> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        constants.O_NOCTTY,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { left: "absent" };
    return { left: `not openable (${code ?? "error"})` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { left: "not a regular file" };
    if (info.size > cap) return { left: `larger than ${cap} bytes` };
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        info.size - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { data: buffer.subarray(0, offset) };
  } finally {
    await handle.close();
  }
}

export interface LeftBehind {
  name: string;
  class: string;
  files: number;
}
const classOf = (name: string): string =>
  /^(watcher\.lock|recovery\.lock|lease|lease-acquire\.lock)$/.test(name)
    ? "lease or lock"
    : name === "identity.json" || /binding/.test(name)
      ? "identity or binding"
      : name === "pi-sessions"
        ? "native session files"
        : name === "runs"
          ? "run logs"
          : name === "result-schema.json"
            ? "regenerated result schema"
            : name === "quarantined-commands"
              ? "earlier quarantine"
              : name === journalName
                ? "migration journal"
                : name === "commands"
                  ? "pending commands beyond the cap"
                  : "unknown";
const countFiles = (path: string, budget = { left: limits.count }): number => {
  let total = 0;
  try {
    const info = lstatSync(path);
    if (!info.isDirectory()) return 1;
    for (const name of readdirSync(path)) {
      if (budget.left-- <= 0) return total;
      total += countFiles(join(path, name), budget);
    }
  } catch {
    /* unreadable: counted as nothing */
  }
  return total;
};

interface Snapshot {
  texts: Map<string, Buffer>;
  /** Commands that could not be read at all (listed, never published). */
  unreadable: Array<{ name: string; reason: string }>;
  commandNames: string[];
  commandsBeyondCap: number;
  leftBehind: LeftBehind[];
}
const adoptableNames = new Set(["config.json", "state.json", "desired.json"]);
/**
 * Read only what can be adopted: the three known files and a flat commands/
 * directory. Everything else is merely inventoried. Directory identity is
 * re-checked afterwards, so a swap cannot make the reads leave the tree.
 */
async function snapshot(
  legacy: string,
  ours: ReadonlySet<string>,
  deadline: () => void,
): Promise<Snapshot> {
  const result: Snapshot = {
    texts: new Map(),
    unreadable: [],
    commandNames: [],
    commandsBeyondCap: 0,
    leftBehind: [],
  };
  const identity = (path: string) => {
    const info = lstatSync(path);
    return `${info.dev}:${info.ino}:${info.isDirectory() ? "d" : "x"}`;
  };
  const rootId = identity(legacy);
  let total = 0;
  const names = readdirSync(legacy);
  if (names.length > limits.inventory)
    throw new Error(
      `Legacy directory has more than ${limits.inventory} entries; set it aside with \`crewplane migrate --discard-legacy\``,
    );
  for (const name of names.sort()) {
    deadline();
    if (ours.has(name)) continue;
    if (adoptableNames.has(name)) {
      const read = await boundedRead(join(legacy, name), limits.file);
      if ("data" in read) {
        total += read.data.length;
        result.texts.set(name, read.data);
      } else
        result.leftBehind.push({
          name,
          class: `not adopted: ${read.left}`,
          files: 1,
        });
      continue;
    }
    if (name === "commands") {
      const commands = join(legacy, "commands");
      const before = identity(commands);
      const listed = before.endsWith(":d") ? readdirSync(commands).sort() : [];
      if (!before.endsWith(":d"))
        result.leftBehind.push({
          name,
          class: "commands is not a plain directory",
          files: 1,
        });
      result.commandsBeyondCap = Math.max(0, listed.length - limits.commands);
      for (const file of listed.slice(0, limits.commands)) {
        deadline();
        result.commandNames.push(file);
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) {
          result.unreadable.push({
            name: file,
            reason: "not a command file name",
          });
          continue;
        }
        const read = await boundedRead(join(commands, file), limits.command);
        if ("data" in read) {
          total += read.data.length;
          if (total > limits.total)
            throw new Error(
              `Legacy files exceed ${limits.total} bytes; set it aside with \`crewplane migrate --discard-legacy\``,
            );
          result.texts.set(`commands/${file}`, read.data);
        } else result.unreadable.push({ name: file, reason: read.left });
      }
      if (before.endsWith(":d") && identity(commands) !== before)
        throw new Error(
          "The legacy commands directory changed while it was read; nothing was published",
        );
      continue;
    }
    result.leftBehind.push({
      name,
      class: classOf(name),
      files: countFiles(join(legacy, name)),
    });
  }
  if (total > limits.total)
    throw new Error(
      `Legacy files exceed ${limits.total} bytes; set it aside with \`crewplane migrate --discard-legacy\``,
    );
  if (identity(legacy) !== rootId)
    throw new Error(
      "The legacy directory was replaced while it was read; nothing was published",
    );
  return result;
}

export interface MigrateOptions {
  store: string;
  control: string;
  /** Canonical primary root; a legacy configuration must belong to it. */
  root: string;
  identity?: BindingIdentity;
  dryRun?: boolean;
  discardLegacy?: boolean;
  /** PIDs the operator declared irrelevant to `--discard-legacy`. */
  ignorePids?: readonly number[];
  /** SHA-256 digest of the reviewed adopted files (from `migrate --dry-run`). */
  acceptConfig?: string | undefined;
  move?: MoveOptions;
  owner?: Owner;
  isSupervisor?: (pid: number) => boolean;
  now?: number;
  timeoutMs?: number;
  /** Test hook: runs after preflight, before leases and the snapshot. */
  afterPreflight?: () => Promise<void>;
}
export interface PendingCommand {
  id: string;
  action: string;
  reason?: string;
}
export interface MigrateReport {
  version: 1;
  status: "migrated" | "dry-run" | "nothing-to-migrate" | "discarded";
  from: string | null;
  to: string;
  /** Canonical text of every file that will be published (besides identity.json). */
  files: Record<string, string>;
  /** SHA-256 over the sorted (path, sha256) pairs of `files`; what `--accept-config` binds. */
  digest: string | null;
  /** The validated configuration, canonical, every key. */
  config: Config | null;
  configAccepted: boolean;
  rearmedCommands: PendingCommand[];
  quarantinedCommands: PendingCommand[];
  leftBehind: LeftBehind[];
  ignoredLivenessClaims: string[];
  ignoredPids: number[];
  discardedTo: string | null;
  /** The retired legacy directory, kept for inspection. */
  leftover: string | null;
  watchdogSetAside: string | null;
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

export interface PathProbe {
  realpath?: (path: string) => string;
  caseInsensitive?: boolean;
}
const probeCase = (directory: string): boolean => {
  try {
    const name = basename(directory);
    const flipped =
      name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
    if (flipped === name) return false;
    const a = statSync(directory);
    const b = statSync(join(dirname(directory), flipped));
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
};
/** Whether `path` (symlinks resolved, case folded on insensitive volumes) lies under `directory`. */
export const insideDirectory = (
  path: string,
  directory: string,
  probe: PathProbe = {},
) => {
  const real = probe.realpath ?? ((p: string) => realpathSync.native(p));
  const settle = (p: string) => {
    const absolute = isAbsolute(p) ? p : join(directory, p);
    try {
      return real(absolute);
    } catch {
      return resolve(absolute);
    }
  };
  const fold = probe.caseInsensitive ?? probeCase(settle(directory));
  const norm = (p: string) => (fold ? p.toLowerCase() : p);
  const target = norm(settle(path));
  const base = norm(settle(directory));
  return target === base || target.startsWith(`${base}${sep}`);
};
/**
 * Review text for the operator: the effective binary for every agent exactly
 * as the supervisor resolves it (only codex falls back to the top-level
 * `binary`), a marker on anything inside the project, then the complete
 * canonical configuration. Nothing an agent wrote is rendered raw.
 */
export function describeConfig(
  config: Config,
  where: { root: string; store: string } & PathProbe,
): string {
  const flag = (path: string) =>
    insideDirectory(path, where.root, where) ||
    insideDirectory(path, where.store, where)
      ? "  [WARNING: inside the project; agents can modify it]"
      : "";
  const lines = ["Effective binary per agent:"];
  for (const [id, lane] of Object.entries(config.lanes)) {
    const harness = lane.harness ?? "codex";
    const binary =
      (config.binaries as Record<string, string> | undefined)?.[harness] ??
      (harness === "codex" ? config.binary : undefined);
    lines.push(
      `  ${id} (${harness}, ${lane.enabled ? "enabled" : "disabled"}): ${
        binary === undefined
          ? "NONE CONFIGURED (the harness would not start)"
          : `${binary}${flag(binary)}`
      }`,
    );
  }
  const guidance = Object.entries(config.lanes).filter(
    ([, lane]) => lane.instructionsPath,
  );
  if (guidance.length) lines.push("Agent instruction files:");
  for (const [id, lane] of guidance)
    lines.push(
      `  ${id}: ${lane.instructionsPath}${flag(join(where.root, lane.instructionsPath as string))}`,
    );
  lines.push("Complete configuration (canonical, every key):");
  lines.push(...canonicalText(config).trimEnd().split("\n"));
  return lines.map(visible).join("\n");
}
/** Everything the operator must read before accepting a digest. */
export function describeAdoption(
  report: MigrateReport,
  where: { root: string; store: string } & PathProbe,
): string {
  const lines: string[] = [];
  if (report.config) lines.push(describeConfig(report.config, where));
  for (const [path, text] of Object.entries(report.files))
    if (path !== "config.json")
      lines.push(
        `--- ${path} (canonical, adopted exactly as shown) ---`,
        text.trimEnd(),
      );
  for (const command of report.rearmedCommands)
    lines.push(`re-armed: ${command.action} ${command.id}`);
  for (const command of report.quarantinedCommands)
    lines.push(
      `NOT armed: ${command.action} ${command.id}${command.reason ? ` (${command.reason})` : ""}`,
    );
  for (const item of report.leftBehind)
    lines.push(
      `left behind (not adopted): ${item.name} - ${item.class}, ${item.files} file(s)`,
    );
  return lines.map(visible).join("\n");
}

/** Record fields adopted into state, and nothing prompt-bearing or free text. */
const recordStatus = new Set(["running", "idle", "paused"]);
const pauseKinds = new Set(["failure", "operator", "decision", "no-progress"]);
const shortReason = (value: unknown) =>
  typeof value === "string"
    ? visible(value.replace(/\s+/g, " ").slice(0, 200))
    : "";
const counter = (n: unknown) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;

interface Interpretation {
  config: Config | null;
  files: Map<string, string>;
  rearm: PendingCommand[];
  quarantine: PendingCommand[];
}
/**
 * Validate the snapshot and build the canonical bytes that will be published.
 * Nothing is copied raw: every adopted file is re-serialized from validated
 * values, and the digest covers exactly those bytes.
 */
function interpret(
  snap: Snapshot,
  options: { root: string; owner: Owner },
): Interpretation {
  const discard =
    "inspect it or set the directory aside with `crewplane migrate --discard-legacy`";
  const files = new Map<string, string>();
  let config: Config | null = null;
  const rawConfig = snap.texts.get("config.json");
  if (rawConfig) {
    try {
      config = validateConfig(JSON.parse(rawConfig.toString("utf8")));
    } catch (error) {
      throw new Error(
        `Legacy config.json failed validation (${printable(error instanceof Error ? error.message : "unreadable")}); ${discard}`,
      );
    }
    if (config.root !== options.root)
      throw new Error(
        `Legacy config.json belongs to another project root (${printable(config.root)}); refusing to adopt it`,
      );
    files.set("config.json", canonicalText(config));
  }
  const rawDesired = snap.texts.get("desired.json");
  if (rawDesired) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDesired.toString("utf8"));
    } catch {
      parsed = null;
    }
    const desired = object(parsed);
    if (!desired || typeof desired.desiredRunning !== "boolean")
      throw new Error(
        `Legacy desired.json failed structural validation; ${discard}`,
      );
    files.set(
      "desired.json",
      canonicalText({
        version: 1,
        desiredRunning: desired.desiredRunning,
        reason: shortReason(desired.reason),
        at: new Date(
          typeof desired.at === "string" &&
            Number.isFinite(Date.parse(desired.at))
            ? Date.parse(desired.at)
            : 0,
        ).toISOString(),
      }),
    );
  }
  const rawState = snap.texts.get("state.json");
  if (rawState) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawState.toString("utf8"));
    } catch {
      parsed = null;
    }
    if (!parsed || !validState(parsed))
      throw new Error(
        `Legacy state.json failed structural validation; ${discard}`,
      );
    const state = parsed as unknown as Record<string, unknown>;
    const records: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(object(state.records) ?? {})) {
      const entry = object(raw) ?? {};
      // Dead process identities are dropped: a recycled pid must never make a
      // later start refuse permanently. A record that had a run is paused.
      const hadRun =
        entry.status === "running" ||
        entry.pid !== undefined ||
        entry.processGroupId !== undefined;
      for (const candidate of [entry.pid, entry.processGroupId])
        if (
          typeof candidate === "number" &&
          options.owner(candidate) !== "dead"
        )
          throw new Error(
            `Legacy record ${printable(key)} carries live process ${candidate}; stop that process (the old supervisor and its children must be gone) and rerun`,
          );
      records[key] = {
        key,
        lane: entry.lane,
        task:
          typeof entry.task === "string" && validTaskId(entry.task)
            ? entry.task
            : null,
        cwd:
          typeof entry.cwd === "string" && isAbsolute(entry.cwd)
            ? entry.cwd.slice(0, 4096)
            : options.root,
        status: hadRun
          ? "paused"
          : recordStatus.has(String(entry.status))
            ? entry.status
            : "idle",
        reason: hadRun
          ? "Prior run interrupted; inspect the worktree and retry explicitly"
          : shortReason(entry.reason),
        ...(hadRun
          ? { pauseKind: "failure" }
          : pauseKinds.has(String(entry.pauseKind))
            ? { pauseKind: entry.pauseKind }
            : {}),
        ...(typeof entry.pauseId === "string" &&
        /^[a-f0-9-]{36}$/.test(entry.pauseId)
          ? { pauseId: entry.pauseId }
          : {}),
        ...(entry.cleanupUnverified === true || hadRun
          ? { cleanupUnverified: true }
          : {}),
        ...(validHarness(entry.harness) ? { harness: entry.harness } : {}),
        // Structural event ids, not free text: without them every old message,
        // review and planning event would count as new and burn budget.
        seen: (Array.isArray(entry.seen) ? entry.seen : [])
          .filter(
            (id): id is string =>
              typeof id === "string" &&
              /^(message|review|planning|checkpoint|assignment|failure|resume|work):[A-Za-z0-9._:-]{1,200}$/.test(
                id,
              ),
          )
          .slice(-2000),
        ...(typeof entry.seenMessagesThrough === "string" &&
        Number.isFinite(Date.parse(entry.seenMessagesThrough))
          ? {
              seenMessagesThrough: new Date(
                Date.parse(entry.seenMessagesThrough),
              ).toISOString(),
            }
          : {}),
        ...(Array.isArray(entry.seenMessagesAtBoundary)
          ? {
              seenMessagesAtBoundary: entry.seenMessagesAtBoundary
                .filter(
                  (id): id is string =>
                    typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
                )
                .slice(-2000),
            }
          : {}),
        runs: Array.isArray(entry.runs)
          ? entry.runs.map(counter).slice(-120)
          : [],
        noProgress: counter(entry.noProgress),
        inputTokens: counter(entry.inputTokens),
        outputTokens: counter(entry.outputTokens),
      };
    }
    const lanes = (value: unknown) =>
      Array.isArray(value) ? value.filter((l) => validId(l)).slice(0, 64) : [];
    const laneRev = Object.fromEntries(
      Object.entries(object(state.laneRev) ?? {})
        .filter(([lane]) => validId(lane))
        .map(([lane, n]) => [lane, counter(n)]),
    );
    const retiredRuns = Object.fromEntries(
      Object.entries(object(state.retiredRuns) ?? {})
        .filter(([lane]) => validId(lane))
        .map(([lane, runs]) => [
          lane,
          Array.isArray(runs) ? runs.map(counter).slice(-60) : [],
        ]),
    );
    files.set(
      "state.json",
      canonicalText({
        version: 2,
        running: state.running === true,
        checkedAt: new Date(
          Number.isFinite(Date.parse(String(state.checkedAt)))
            ? Date.parse(String(state.checkedAt))
            : 0,
        ).toISOString(),
        pid: 0,
        draining: false,
        held: lanes(state.held),
        ...(state.instanceHeld === true ? { instanceHeld: true } : {}),
        laneRev,
        controlSeq: counter(state.controlSeq),
        retiredRuns,
        commands: [],
        notices: {},
        records,
      }),
    );
  }
  // Pending commands: only decoded narrowing controls naming a configured
  // lane are re-armed, reduced to action and selector, without a timestamp.
  const rearm: PendingCommand[] = [];
  const quarantine: PendingCommand[] = [];
  for (const file of snap.commandNames) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : file;
    const data = snap.texts.get(`commands/${file}`);
    const unreadable = snap.unreadable.find((u) => u.name === file);
    const refuse = (action: string, reason: string) =>
      quarantine.push({ id, action, reason });
    if (unreadable || !data) {
      refuse("invalid", unreadable?.reason ?? "unreadable");
      continue;
    }
    let value: ReturnType<typeof control>;
    try {
      value = control(JSON.parse(data.toString("utf8")));
    } catch {
      refuse("invalid", "undecodable");
      continue;
    }
    if (value.action === "invalid") {
      refuse("invalid", "not a valid control");
      continue;
    }
    if (
      !narrowing.has(value.action) ||
      (value as { cancelActive?: unknown }).cancelActive === true
    ) {
      refuse(value.action, "widening or cancelling control");
      continue;
    }
    const fields = value as unknown as Record<string, unknown>;
    if (
      typeof fields.lane === "string" &&
      !(config && Object.hasOwn(config.lanes, fields.lane))
    ) {
      refuse(value.action, "names an agent the adopted configuration lacks");
      continue;
    }
    const pick = (key: string) =>
      fields[key] === undefined ? {} : { [key]: fields[key] };
    const normalized = control({
      v: 2,
      action: value.action,
      ...pick("lane"),
      ...pick("all"),
      ...pick("run"),
      issuer: "migrate",
    });
    if (normalized.action === "invalid") {
      refuse(value.action, "selector did not validate");
      continue;
    }
    files.set(`commands/${id}.json`, canonicalText(normalized));
    rearm.push({ id, action: value.action });
  }
  return { config, files, rearm, quarantine };
}
const digestOf = (files: Map<string, string>) =>
  sha(
    JSON.stringify(
      [...files.entries()]
        .map(([path, text]) => [path, sha(text)])
        .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    ),
  );

async function writeFresh(
  path: string,
  text: string,
  hook?: (path: string) => Promise<void>,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await hook?.(path);
  if (sha(await readFile(path)) !== sha(text))
    throw new Error(
      `Verification failed for ${printable(path)}; nothing was removed`,
    );
}

/**
 * Relocate pre-relocation control state into the private control directory.
 * The legacy tree is agent-writable, so only an allowlist is adopted and every
 * adopted file is re-serialized from validated values: config.json,
 * desired.json, a minimal subset of state.json and re-armable narrowing
 * commands. Leases, identity, native sessions, run logs, the watchdog tree and
 * anything unknown stay behind in the retired legacy directory. The digest
 * covers exactly the bytes published.
 */
export async function migrateControl(
  options: MigrateOptions,
): Promise<MigrateReport> {
  const owner = options.owner ?? processOwner;
  const isSupervisor = options.isSupervisor ?? registeredSupervisor;
  const moves = options.move ?? {};
  const legacy = legacySupervisorDirectory(options.store);
  const legacyDog = legacyWatchdogDirectory(options.store);
  const hasSupervisor = existsSync(legacy) || isSymlink(legacy);
  const hasWatchdog = existsSync(legacyDog) || isSymlink(legacyDog);
  const report: MigrateReport = {
    version: 1,
    status: options.dryRun ? "dry-run" : "migrated",
    from: hasSupervisor ? legacy : null,
    to: options.control,
    files: {},
    digest: null,
    config: null,
    configAccepted: false,
    rearmedCommands: [],
    quarantinedCommands: [],
    leftBehind: [],
    ignoredLivenessClaims: [],
    ignoredPids: [...(options.ignorePids ?? [])],
    discardedTo: null,
    leftover: null,
    watchdogSetAside: null,
  };
  if (!hasSupervisor && !hasWatchdog)
    return { ...report, status: "nothing-to-migrate", from: null };

  const ignore = new Set(options.ignorePids ?? []);
  const liveness = (skipLease = false) =>
    supervisorLiveness(legacy, {
      owner,
      isSupervisor,
      skipLease,
      ignorePids: ignore,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const setAside = async (path: string, stamp: string) => {
    const target = `${path}.discarded-${stamp}`;
    await rename(path, target);
    await syncDirectory(dirname(path));
    return target;
  };

  if (options.discardLegacy) {
    const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "");
    if (hasSupervisor) {
      const found = liveness();
      report.ignoredLivenessClaims = evidence({ ...found, credible: null });
      if (found.credible)
        throw new Error(
          `Refusing to discard: ${found.credible}. Stop that supervisor, or pass \`--ignore-pid PID\` if you have verified that PID is not a supervisor`,
        );
      report.discardedTo = `${legacy}.discarded-${stamp}`;
    }
    if (hasWatchdog)
      report.watchdogSetAside = `${legacyDog}.discarded-${stamp}`;
    report.status = options.dryRun ? "dry-run" : "discarded";
    if (!options.dryRun) {
      if (hasSupervisor) await setAside(legacy, stamp);
      if (hasWatchdog) await setAside(legacyDog, stamp);
    }
    return report;
  }

  // The watchdog tree is never adopted: its state is regenerated and its lease
  // belongs to a process that no longer exists in this layout.
  const asideWatchdog = async () => {
    if (hasWatchdog && existsSync(legacyDog))
      report.watchdogSetAside = await retire(legacyDog);
  };
  if (!hasSupervisor) {
    if (!options.dryRun) await asideWatchdog();
    else if (hasWatchdog)
      report.watchdogSetAside = `${legacyDog}.migrated-<id>`;
    return report;
  }

  // Preconditions: nothing is changed until every one holds.
  const bad = legacyProblem(legacy);
  if (bad)
    throw new Error(`Legacy supervisor directory ${bad}; inspect it manually`);
  const resuming = await resumable(options.control);
  const blocking = (skipLease = false): string | null => {
    const found = liveness(skipLease);
    report.ignoredLivenessClaims = found.suspicious;
    return found.credible ?? found.heartbeat ?? found.children;
  };
  const blocked = blocking();
  if (blocked)
    throw new Error(
      `Refusing to migrate: ${blocked}. Stop it first, or wait a minute if it only crashed${
        report.ignoredLivenessClaims.length
          ? ` (ignored claims: ${report.ignoredLivenessClaims.map(visible).join("; ")})`
          : ""
      }. A forged directory can be set aside with \`crewplane migrate --discard-legacy\``,
    );
  /**
   * The destination may already hold a matching identity.json and validated
   * narrowing commands (halts queued before migrating); those are carried into
   * the staged set. Anything else makes it busy.
   */
  const inspectDestination = () => {
    const carried = new Map<string, string>();
    const carriedCommands: PendingCommand[] = [];
    if (!checkControlDirectory(options.control))
      return { busy: false, carried, carriedCommands, bindingId: null };
    let bindingId: string | null = null;
    for (const name of readdirSync(options.control)) {
      if (name === "identity.json") {
        const found = object(readJson(join(options.control, name)));
        if (
          !found ||
          found.primaryRoot !==
            (options.identity ?? { primaryRoot: options.root }).primaryRoot
        )
          return { busy: true, carried, carriedCommands, bindingId };
        bindingId =
          typeof found.bindingId === "string" ? found.bindingId : null;
      } else if (name === "commands") {
        const directory = join(options.control, name);
        if (!lstatSync(directory).isDirectory())
          return { busy: true, carried, carriedCommands, bindingId };
        for (const file of readdirSync(directory)) {
          const raw = /^[a-f0-9-]{36}\.json$/.test(file)
            ? readBoundedBuffer(join(directory, file), limits.command)
            : null;
          let value: ReturnType<typeof control> | null = null;
          try {
            value = raw ? control(JSON.parse(raw.toString("utf8"))) : null;
          } catch {
            value = null;
          }
          if (
            !value ||
            !narrowing.has(value.action) ||
            (value as { cancelActive?: unknown }).cancelActive === true
          )
            return { busy: true, carried, carriedCommands, bindingId };
          carried.set(`commands/${file}`, canonicalText(value));
          carriedCommands.push({
            id: file.slice(0, -5),
            action: value.action,
            reason: "already queued in the control directory",
          });
        }
      } else return { busy: true, carried, carriedCommands, bindingId };
    }
    return { busy: false, carried, carriedCommands, bindingId };
  };
  const destinationBusy = () => !resuming && inspectDestination().busy;
  const busyMessage = () =>
    `Refusing to migrate: ${printable(options.control)} already has content. Inspect both locations; remove or rename the legacy ${printable(legacy)} once it is confirmed stale`;
  if (destinationBusy()) throw new Error(busyMessage());

  const timeout = options.timeoutMs ?? limits.timeoutMs;
  const started = Date.now();
  const deadline = () => {
    if (Date.now() - started > timeout)
      throw new Error(
        `Migration timed out after ${timeout} ms; nothing was published and its locks were released`,
      );
  };
  const identity = options.identity ?? { primaryRoot: options.root };
  const ours = new Set<string>();

  const review = async () => {
    const snap = await snapshot(legacy, ours, deadline);
    await moves.afterSnapshot?.();
    deadline();
    const read = interpret(snap, { root: options.root, owner });
    // Halts already queued in the control directory are part of the reviewed set.
    const existing = inspectDestination();
    for (const [path, text] of existing.carried)
      if (!read.files.has(path)) read.files.set(path, text);
    read.rearm.push(...existing.carriedCommands);
    report.config = read.config;
    report.files = Object.fromEntries(read.files);
    report.digest = digestOf(read.files);
    report.rearmedCommands = read.rearm;
    report.quarantinedCommands = read.quarantine;
    report.leftBehind = [
      ...snap.leftBehind,
      ...(snap.commandsBeyondCap
        ? [
            {
              name: "commands",
              class: `entries beyond the first ${limits.commands}`,
              files: snap.commandsBeyondCap,
            },
          ]
        : []),
    ];
    return read;
  };
  const needsReview = (read: Interpretation) => read.files.size > 0;
  const requireDigest = (read: Interpretation) => {
    report.configAccepted = false;
    if (!needsReview(read)) return;
    if (options.acceptConfig !== report.digest)
      throw new Error(
        `The legacy state was writable by agents and must be reviewed before anything is adopted. The adopted files have digest ${report.digest}; review them with \`crewplane migrate --dry-run\` and rerun with \`--accept-config ${report.digest}\` only if they match what you reviewed${
          options.acceptConfig
            ? " (the digest you supplied does not match)"
            : ""
        }`,
      );
    report.configAccepted = true;
  };

  if (options.dryRun) {
    if (!resuming) await review();
    if (hasWatchdog) report.watchdogSetAside = `${legacyDog}.migrated-<id>`;
    return report;
  }

  await options.afterPreflight?.();
  // Hold both guards older releases honour for the whole critical section:
  // the supervisor lease (unless a lease file is already there, which is never
  // replaced) and recovery.lock (so an old start's stale-owner recovery cannot
  // interleave). Both are OUR files; only our own are ever removed.
  let release: (() => Promise<void>) | null = null;
  let recoveryOwned = false;
  const recoveryPath = join(legacy, "recovery.lock");
  const recoveryToken = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  });
  const takeRecovery = async () => {
    for (let attempt = 0; attempt < 2; attempt++)
      try {
        await writeFile(recoveryPath, recoveryToken, {
          flag: "wx",
          mode: 0o600,
        });
        recoveryOwned = true;
        ours.add("recovery.lock");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A recovery lock whose owner is dead is stale and safe to replace.
        const text = await readFile(recoveryPath, "utf8").catch(() => "");
        let pid: number | undefined;
        try {
          const parsed = JSON.parse(text) as unknown;
          pid =
            typeof parsed === "number" ? parsed : pidOf(object(parsed)?.pid);
        } catch {
          pid = undefined;
        }
        if (attempt === 0 && pid !== undefined && owner(pid) === "dead") {
          await unlink(recoveryPath).catch(() => {});
          continue;
        }
        throw new Error(
          "Refusing to migrate: recovery.lock exists in the legacy directory (an older release may be recovering its lease, or a crashed migration left it); inspect it and remove it by hand once its owner is gone",
        );
      }
  };
  const dropLocks = async () => {
    if (recoveryOwned) {
      recoveryOwned = false;
      const text = await readFile(recoveryPath, "utf8").catch(() => null);
      if (text === recoveryToken) await unlink(recoveryPath).catch(() => {});
    }
    const held = release;
    release = null;
    await held?.().catch(() => {});
  };
  const staging = `${options.control}.staging-${process.pid}-${randomUUID().slice(0, 8)}`;
  let published = false;
  let createdLeaf = false;
  try {
    if (!resuming) {
      if (!existsSync(join(legacy, "watcher.lock"))) {
        release = await acquire(legacy);
        ours.add("watcher.lock");
      }
      await takeRecovery();
      const again = blocking(release !== null);
      if (again)
        throw new Error(
          `Refusing to migrate: ${again} (appeared during migration)`,
        );
      if (destinationBusy()) throw new Error(busyMessage());
    }
    deadline();
    createdLeaf = !existsSync(options.control);
    await ensureControlDirectory(options.control);

    if (!resuming) {
      const read = await review();
      requireDigest(read);
      deadline();
      await mkdir(staging, { mode: 0o700 });
      for (const [path, text] of read.files)
        await writeFresh(join(staging, path), text, moves.afterStageFile);
      // identity.json comes from the current project, never from the legacy
      // tree, and is checked against the store marker BEFORE anything is
      // published.
      const bindingId =
        storeMarkerId(options.store) ??
        inspectDestination().bindingId ??
        randomUUID();
      await writeFresh(
        join(staging, "identity.json"),
        identityText(bindingId, identity),
      );
      if (
        storeMarkerId(options.store) !== null &&
        storeMarkerId(options.store) !== bindingId
      )
        throw new Error("The store marker changed during migration");
      await writeFile(
        journalPath(options.control),
        JSON.stringify({
          version: 1,
          destination: options.control,
          digest: await treeDigest(staging),
        }),
        { mode: 0o600, flush: true },
      );
      deadline();
      // A destination holding only carried halts is replaced by the staged set,
      // which already contains them; the old copy is removed afterwards.
      let prior: string | null = null;
      if (!isEmptyDirectory(options.control)) {
        prior = `${options.control}.prior-${randomUUID().slice(0, 8)}`;
        await rename(options.control, prior);
      }
      await rename(staging, options.control);
      published = true;
      if (prior)
        await rm(prior, { recursive: true, force: true }).catch(() => {});
      await syncDirectory(dirname(options.control));
      await moves.afterPublish?.();
    }
    // Bind (write the missing store marker, verify both sides) and only then
    // retire the legacy tree.
    await completeBinding(options.store, options.control, identity);
    checkControlDirectory(options.control);
    // Our own guards go first; the inert directory then carries no live lock.
    await dropLocks();
    report.leftover = await retire(legacy);
    await rm(journalPath(options.control), { force: true }).catch(() => {});
    await asideWatchdog();
    if (resuming) report.configAccepted = true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (createdLeaf && !published) await rmdir(options.control).catch(() => {});
    if (!published)
      await rm(journalPath(options.control), { force: true }).catch(() => {});
    throw error;
  } finally {
    await dropLocks();
  }
  return report;
}
