import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  chmod,
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
  bindControl,
  checkControlDirectory,
  ensureControlDirectory,
  legacySupervisorDirectory,
  legacyWatchdogDirectory,
} from "./control.ts";
import { control, validState } from "./engine/control-policy.ts";
import { validateConfig } from "./engine/supervisor.ts";
import { acquire } from "./engine/watch.ts";
import { syncDirectory } from "./io.ts";
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
const interpreted = new Set(["config.json", "state.json", "desired.json"]);
const maxInterpretedBytes = 2 * 1024 * 1024;

/** Terminal- and bidi-safe rendering of anything an agent could have written. */
export const visible = (value: string) =>
  value.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );
const printable = visible;
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
const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;

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
/**
 * A PID is only a credible supervisor if it is in the per-user supervisor
 * registry (older releases register too) or, where /proc exists, its command
 * line is a Crewplane supervisor. Any same-user PID can be named in a lease an
 * agent can edit, so being alive and ours is not enough.
 */
export const registeredSupervisor = (pid: number): boolean => {
  try {
    const directory = join(cacheDirectory(), "supervisors");
    if (existsSync(join(directory, `${pid}.json`))) return true;
  } catch {
    /* unreadable registry: fall through to the command line */
  }
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return (
      argv.includes("start") &&
      argv.some(
        (arg) =>
          /(^|[\\/])crewplane(\.ts)?$/.test(arg) || arg.endsWith("cli.ts"),
      )
    );
  } catch {
    return false;
  }
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
    if (!validPid(pid)) return;
    const who = owner(pid);
    if (who === "foreign")
      result.suspicious.push(`${label} PID ${pid} is not owned by you`);
    else if (who === "ours") {
      if (!supervisor) result.children ??= `${label} PID ${pid} is alive`;
      else if (isSupervisor(pid))
        result.credible ??= `${label} PID ${pid} is alive`;
      else
        result.suspicious.push(
          `${label} PID ${pid} is not a registered Crewplane supervisor`,
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

const watchdogLiveness = (
  directory: string,
  owner: Owner,
  isSupervisor: (pid: number) => boolean,
): string | null => {
  const lease = object(readJson(join(directory, "lease", "owner.json")));
  const pid = pidOf(lease?.pid);
  return validPid(pid) && owner(pid) === "ours" && isSupervisor(pid)
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
 * supervisor is addressed in the legacy directory (its state is unverified,
 * agent-writable data); ambiguous legacy liveness queues narrowing verbs into
 * both directories.
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
        warning: `crewplane: an older-release supervisor is live in the project store; ${command} is queued in its legacy directory and in the control directory${note}. Anything read from the legacy directory is unverified (agents can write it). Stop it, then run \`crewplane migrate\``,
      };
    if (isLive(old) || old.suspicious.length)
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
function scan(root: string, skip: ReadonlySet<string> = new Set()): Entry[] {
  const result: Entry[] = [];
  const visit = (relative: string) => {
    for (const item of readdirSync(join(root, relative), {
      withFileTypes: true,
    }) as Dirent[]) {
      const path = join(relative, item.name);
      if (path === journalName || skip.has(path)) continue;
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
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
async function treeDigest(root: string) {
  const hash = createHash("sha256");
  for (const entry of scan(root).sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(
      `${entry.kind}\0${entry.path}\0${entry.size}\0${
        entry.kind === "file" ? sha(await readFile(join(root, entry.path))) : ""
      }\n`,
    );
  return hash.digest("hex");
}
/** Sorted-key JSON so equal configurations print and hash identically. */
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
  /** Test hook: runs after the snapshot was staged, before it is validated. */
  afterSnapshot?: () => Promise<void>;
  /** Runs after the staged tree was published and before the source is retired. */
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
/** A previous run published its staged copy but did not retire the source. */
async function resumable(from: string, to: string): Promise<boolean> {
  const journal = readJournal(from);
  if (!journal || journal.destination !== to || !existsSync(to)) return false;
  return (await treeDigest(to)) === journal.digest;
}
/** Retire the legacy tree: delete it, or keep it inert when it holds late files. */
async function retire(from: string, keep: boolean) {
  const retired = join(
    dirname(from),
    `${basename(from)}.migrated-${randomUUID().slice(0, 8)}`,
  );
  await rename(from, retired);
  await syncDirectory(dirname(from));
  if (keep) return retired;
  try {
    await rm(retired, { recursive: true });
    return null;
  } catch {
    return retired;
  }
}

interface Staged {
  entries: Array<{
    path: string;
    kind: "file" | "directory";
    size: number;
    mtimeMs: number;
  }>;
  texts: Map<string, Buffer>;
  hardlinked: string[];
}
async function readRegular(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error(`Cannot migrate ${printable(path)}: not a regular file`);
    return { data: await handle.readFile(), info };
  } finally {
    await handle.close();
  }
}
/**
 * Snapshot a legacy tree into FRESH private files. Nothing is renamed or
 * hard-linked, so a hard link, an open descriptor or a working directory an
 * agent holds inside the old tree can never reach the new files. When `stage`
 * is null (dry run) the same reads happen without writing anything.
 */
async function snapshot(
  from: string,
  stage: string | null,
  skip: ReadonlySet<string>,
  hooks: MoveOptions,
): Promise<Staged> {
  const result: Staged = { entries: [], texts: new Map(), hardlinked: [] };
  if (stage) await mkdir(stage, { mode: 0o700 });
  for (const entry of scan(from, skip)) {
    if (entry.kind === "directory") {
      if (stage) await mkdir(join(stage, entry.path), { mode: 0o700 });
      const info = lstatSync(join(from, entry.path));
      result.entries.push({ ...entry, mtimeMs: info.mtimeMs });
      continue;
    }
    const { data, info } = await readRegular(join(from, entry.path));
    if (info.nlink > 1) result.hardlinked.push(entry.path);
    const digest = sha(data);
    result.entries.push({ ...entry, size: data.length, mtimeMs: info.mtimeMs });
    const name = entry.path;
    if (
      (interpreted.has(name) || dirname(name) === "commands") &&
      data.length <= maxInterpretedBytes
    )
      result.texts.set(name, data);
    if (stage) {
      const target = join(stage, entry.path);
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await hooks.afterStageFile?.(target);
      if (sha(await readFile(target)) !== digest)
        throw new Error(
          `Verification failed for ${printable(entry.path)}; nothing was removed`,
        );
    }
  }
  if (stage) await syncDirectory(stage);
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
  /** SHA-256 digest of the reviewed staged snapshot (from `migrate --dry-run`). */
  acceptConfig?: string | undefined;
  move?: MoveOptions;
  owner?: Owner;
  isSupervisor?: (pid: number) => boolean;
  now?: number;
  /** Test hook: runs after preflight, before leases and the snapshot. */
  afterPreflight?: () => Promise<void>;
}
export interface PendingCommand {
  id: string;
  action: string;
}
export interface AdoptedProcess {
  record: string;
  pid: number | null;
  processGroupId: number | null;
  alive: boolean;
}
export interface MigrateReport {
  version: 1;
  status: "migrated" | "dry-run" | "nothing-to-migrate" | "discarded";
  from: string | null;
  to: string;
  method: "staged-copy" | null;
  files: number;
  bytes: number;
  watchdog: boolean;
  rearmedCommands: PendingCommand[];
  quarantinedCommands: PendingCommand[];
  /** The complete validated configuration, canonical, every key. */
  config: Config | null;
  /** SHA-256 of the staged snapshot's interpreted content; pass to --accept-config. */
  digest: string | null;
  configAccepted: boolean;
  adoptedProcesses: AdoptedProcess[];
  hardlinkedSources: string[];
  lateFilesLeftBehind: string[];
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
const inside = (path: string, directory: string) => {
  const resolvedPath = (() => {
    try {
      return realpathSync(isAbsolute(path) ? path : join(directory, path));
    } catch {
      return resolve(isAbsolute(path) ? path : join(directory, path));
    }
  })();
  const base = (() => {
    try {
      return realpathSync(directory);
    } catch {
      return resolve(directory);
    }
  })();
  return resolvedPath === base || resolvedPath.startsWith(`${base}${sep}`);
};
/**
 * Review text for the operator: every effective binary, a marker on anything an
 * agent could edit, then the complete canonical configuration. Nothing an agent
 * wrote is rendered raw.
 */
export function describeConfig(
  config: Config,
  where: { root: string; store: string },
): string {
  const flag = (path: string) =>
    inside(path, where.root) || inside(path, where.store)
      ? "  [WARNING: inside the project; agents can modify it]"
      : "";
  const lines = ["Effective binary per agent:"];
  for (const [id, lane] of Object.entries(config.lanes)) {
    const harness = lane.harness ?? "codex";
    const binary =
      (config.binaries as Record<string, string> | undefined)?.[harness] ??
      config.binary;
    lines.push(
      `  ${id} (${harness}, ${lane.enabled ? "enabled" : "disabled"}): ${binary}${flag(binary)}`,
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

/** Decode and normalize one pending command; only narrowing ones are re-armed. */
function classifyCommand(
  data: Buffer | undefined,
  now: string,
): { action: string; rearm?: unknown } {
  if (!data) return { action: "invalid" };
  try {
    const value = control(JSON.parse(data.toString("utf8")));
    if (
      !narrowing.has(value.action) ||
      (value as { cancelActive?: unknown }).cancelActive === true
    )
      return { action: value.action };
    // Re-arm only the action and its selector; forged issuer, generation and
    // timestamps are dropped.
    const pick = (key: string) =>
      (value as unknown as Record<string, unknown>)[key] === undefined
        ? {}
        : { [key]: (value as unknown as Record<string, unknown>)[key] };
    const normalized = control({
      v: 2,
      action: value.action,
      ...pick("lane"),
      ...pick("all"),
      ...pick("run"),
      issuer: "migrate",
      at: now,
    });
    return normalized.action === "invalid"
      ? { action: "invalid" }
      : { action: value.action, rearm: normalized };
  } catch {
    return { action: "invalid" };
  }
}

interface Interpretation {
  config: Config | null;
  configText: string | null;
  stateText: string | null;
  rearm: Array<PendingCommand & { name: string; value: unknown }>;
  quarantine: Array<PendingCommand & { name: string }>;
  adopted: AdoptedProcess[];
  digest: string;
}
/** Validate and classify ONLY the staged snapshot; the legacy tree is never consulted. */
function interpret(
  staged: Staged,
  options: { root: string; owner: Owner; now: string },
): Interpretation {
  const discard =
    "inspect it or set the directory aside with `crewplane migrate --discard-legacy`";
  let config: Config | null = null;
  const rawConfig = staged.texts.get("config.json");
  if (staged.entries.some((e) => e.path === "config.json")) {
    try {
      if (!rawConfig) throw new Error("unreadable or too large");
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
  }
  let state: Record<string, unknown> | null = null;
  const adopted: AdoptedProcess[] = [];
  if (staged.entries.some((e) => e.path === "state.json")) {
    const raw = staged.texts.get("state.json");
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw.toString("utf8")) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !validState(parsed))
      throw new Error(
        `Legacy state.json failed structural validation; ${discard}`,
      );
    state = parsed as unknown as Record<string, unknown>;
    if (state.pid !== undefined && !validPid(state.pid))
      throw new Error(
        `Legacy state.json records an invalid supervisor pid; ${discard}`,
      );
    for (const [key, record] of Object.entries(object(state.records) ?? {})) {
      const entry = object(record) ?? {};
      for (const field of ["pid", "processGroupId"])
        if (entry[field] !== undefined && !validPid(entry[field]))
          throw new Error(
            `Legacy state.json record ${printable(key)} has an invalid ${field}; ${discard}`,
          );
      if (entry.pid !== undefined || entry.processGroupId !== undefined) {
        const pid = (entry.pid as number | undefined) ?? null;
        const group = (entry.processGroupId as number | undefined) ?? null;
        adopted.push({
          record: key,
          pid,
          processGroupId: group,
          alive:
            (pid !== null && options.owner(pid) !== "dead") ||
            (group !== null && options.owner(group) !== "dead"),
        });
      }
    }
  }
  let desired: unknown = null;
  if (staged.entries.some((e) => e.path === "desired.json")) {
    try {
      desired = JSON.parse(
        staged.texts.get("desired.json")?.toString("utf8") ?? "",
      );
    } catch {
      desired = null;
    }
    if (
      !object(desired) ||
      typeof object(desired)?.desiredRunning !== "boolean"
    )
      throw new Error(
        `Legacy desired.json failed structural validation; ${discard}`,
      );
  }
  const rearm: Interpretation["rearm"] = [];
  const quarantine: Interpretation["quarantine"] = [];
  const commandNames = staged.entries.filter(
    (e) => dirname(e.path) === "commands" || e.path === "commands",
  );
  for (const entry of commandNames) {
    if (entry.path === "commands") continue;
    const name = basename(entry.path);
    const id = name.endsWith(".json") ? name.slice(0, -5) : name;
    const valid =
      entry.kind === "file" &&
      /^[a-f0-9-]{36}\.json$/.test(name) &&
      entry.size <= 65536;
    const result = valid
      ? classifyCommand(staged.texts.get(entry.path), options.now)
      : { action: "invalid" };
    if ("rearm" in result && result.rearm)
      rearm.push({ id, action: result.action, name, value: result.rearm });
    else quarantine.push({ id, action: result.action, name });
  }
  const rearmed = new Set(rearm.flatMap((r) => [r.name, r.id]));
  let stateText: string | null = null;
  if (state) {
    const commands = Array.isArray(state.commands) ? state.commands : [];
    state = {
      ...state,
      commands: commands.filter(
        (c) => !(typeof c === "string" && rearmed.has(c)),
      ),
    };
    stateText = canonicalText(state);
  }
  const digest = sha(
    JSON.stringify({
      config: config ? canonicalText(config) : null,
      state: stateText,
      desired: desired === null ? null : canonicalText(desired),
      rearm: rearm
        .map((r) => {
          // The re-arm timestamp is not part of what the operator reviews.
          const { at: _at, ...stable } = r.value as Record<string, unknown>;
          return [r.id, canonicalText(stable)];
        })
        .sort(),
      quarantine: quarantine
        .map((q) => [
          q.id,
          q.action,
          sha(staged.texts.get(`commands/${q.name}`) ?? ""),
        ])
        .sort(),
    }),
  );
  return {
    config,
    configText: config ? canonicalText(config) : null,
    stateText,
    rearm,
    quarantine,
    adopted,
    digest,
  };
}

/**
 * Relocate pre-relocation control state into the private control directory.
 * The legacy tree is agent-writable, so nothing in it is moved: it is read once
 * into a private staging directory as fresh 0600 files, validated and
 * classified only there, shown to the operator with a digest and published
 * exactly as staged. Anything that arrives after the snapshot stays behind.
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
    method: null,
    files: 0,
    bytes: 0,
    watchdog: false,
    rearmedCommands: [],
    quarantinedCommands: [],
    config: null,
    digest: null,
    configAccepted: false,
    adoptedProcesses: [],
    hardlinkedSources: [],
    lateFilesLeftBehind: [],
    ignoredLivenessClaims: [],
    discardedTo: null,
    leftover: null,
  };
  if (!hasSupervisor && !hasWatchdog)
    return { ...report, status: "nothing-to-migrate", from: null };

  const liveness = (skipLease = false) =>
    supervisorLiveness(legacy, {
      owner,
      isSupervisor,
      skipLease,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

  if (options.discardLegacy) {
    if (!hasSupervisor) return { ...report, status: "nothing-to-migrate" };
    const found = liveness();
    report.ignoredLivenessClaims = evidence({ ...found, credible: null });
    if (found.credible)
      throw new Error(
        `Refusing to discard: ${found.credible}. Stop that supervisor first`,
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
  const blocking = (skipLease = false): string | null => {
    if (!hasSupervisor) return null;
    const found = liveness(skipLease);
    report.ignoredLivenessClaims = found.suspicious;
    return found.credible ?? found.heartbeat ?? found.children;
  };
  if (hasSupervisor) {
    const blocked = blocking();
    if (blocked)
      throw new Error(
        `Refusing to migrate: ${blocked}. Stop it first, or wait a minute if it only crashed${
          report.ignoredLivenessClaims.length
            ? ` (ignored claims: ${report.ignoredLivenessClaims.map(visible).join("; ")})`
            : ""
        }. A forged directory can be set aside with \`crewplane migrate --discard-legacy\``,
      );
    scan(legacy); // refuse special files up front
  }
  const dogResuming =
    hasWatchdog &&
    (await resumable(legacyDog, join(options.control, "watchdog")));
  if (hasWatchdog) {
    const bad = legacyProblem(legacyDog);
    if (bad)
      throw new Error(`Legacy watchdog directory ${bad}; inspect it manually`);
    const live = watchdogLiveness(legacyDog, owner, isSupervisor);
    if (live) throw new Error(`Refusing to migrate: ${live}. Stop it first`);
    scan(legacyDog);
  }
  const destinationBusy = () => {
    if (!checkControlDirectory(options.control)) return false;
    if (hasSupervisor && !resuming) return !isEmptyDirectory(options.control);
    return hasWatchdog && !dogResuming
      ? existsSync(join(options.control, "watchdog"))
      : false;
  };
  const busyMessage = () =>
    `Refusing to migrate: ${printable(options.control)} already has content. Inspect both locations; remove or rename the legacy ${printable(hasSupervisor ? legacy : legacyDog)} once it is confirmed stale`;
  if (destinationBusy()) throw new Error(busyMessage());

  const now = new Date(options.now ?? Date.now()).toISOString();
  const apply = (s: Staged, read: Interpretation | null) => {
    report.files += s.entries.filter((e) => e.kind === "file").length;
    report.bytes += s.entries.reduce((n, e) => n + e.size, 0);
    report.hardlinkedSources.push(...s.hardlinked);
    if (read) {
      report.config = read.config;
      report.digest = read.digest;
      report.adoptedProcesses = read.adopted;
      report.rearmedCommands = read.rearm.map(({ id, action }) => ({
        id,
        action,
      }));
      report.quarantinedCommands = read.quarantine.map(({ id, action }) => ({
        id,
        action,
      }));
    }
  };
  const ours = new Set<string>();
  const reviewConfig = (read: Interpretation) => {
    report.configAccepted = false;
    if (!read.config) return;
    if (options.dryRun) return;
    if (options.acceptConfig !== read.digest)
      throw new Error(
        `Legacy config.json was writable by agents and must be reviewed before it is adopted. The staged snapshot has digest ${read.digest}; review it with \`crewplane migrate --dry-run\` and rerun with \`--accept-config ${read.digest}\` only if it matches what you reviewed${
          options.acceptConfig
            ? " (the digest you supplied does not match)"
            : ""
        }`,
      );
    report.configAccepted = true;
  };

  if (options.dryRun) {
    if (hasSupervisor && !resuming) {
      const staged = await snapshot(legacy, null, ours, moves);
      const read = interpret(staged, { root: options.root, owner, now });
      apply(staged, read);
    }
    if (hasWatchdog && !dogResuming) {
      const staged = await snapshot(legacyDog, null, ours, moves);
      apply(staged, null);
    }
    report.watchdog = hasWatchdog;
    report.method = "staged-copy";
    return report;
  }

  await options.afterPreflight?.();
  // Hold both guards older releases honour for the whole critical section:
  // the supervisor lease (unless a lease file is already there, which is never
  // replaced) and recovery.lock, which stops an old start's stale-owner
  // recovery interleaving with the snapshot. Both are OUR files only.
  let release: (() => Promise<void>) | null = null;
  let recovery = false;
  const recoveryPath = join(legacy, "recovery.lock");
  if (hasSupervisor && !resuming) {
    if (!existsSync(join(legacy, "watcher.lock"))) {
      release = await acquire(legacy);
      ours.add("watcher.lock");
    }
    try {
      await writeFile(recoveryPath, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
      recovery = true;
      ours.add("recovery.lock");
    } catch (error) {
      await release?.().catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "Refusing to migrate: recovery.lock exists in the legacy directory (an older release may be recovering its lease); inspect it",
        );
      throw error;
    }
  }
  const staging = `${options.control}.staging-${process.pid}-${randomUUID().slice(0, 8)}`;
  const dogStaging = `${staging}-watchdog`;
  // Once a staged copy is published its journal must survive a crash, so a
  // rerun can finish retiring the source.
  let published = false;
  let dogPublished = false;
  let createdLeaf = false;
  try {
    if (hasSupervisor && !resuming) {
      const blocked = blocking(release !== null);
      if (blocked)
        throw new Error(
          `Refusing to migrate: ${blocked} (appeared during migration)`,
        );
    }
    if (hasWatchdog && !dogResuming) {
      const live = watchdogLiveness(legacyDog, owner, isSupervisor);
      if (live) throw new Error(`Refusing to migrate: ${live}. Stop it first`);
    }
    if (destinationBusy()) throw new Error(busyMessage());
    createdLeaf = !existsSync(options.control);
    await ensureControlDirectory(options.control);

    let supervisorSnapshot: Staged | null = null;
    if (hasSupervisor && !resuming) {
      supervisorSnapshot = await snapshot(legacy, staging, ours, moves);
      await moves.afterSnapshot?.();
      // From here on only the staged copy is consulted.
      const read = interpret(supervisorSnapshot, {
        root: options.root,
        owner,
        now,
      });
      apply(supervisorSnapshot, read);
      reviewConfig(read);
      if (read.configText)
        await writeFile(join(staging, "config.json"), read.configText, {
          mode: 0o600,
          flush: true,
        });
      if (read.stateText)
        await writeFile(join(staging, "state.json"), read.stateText, {
          mode: 0o600,
          flush: true,
        });
      const quarantineDirectory = join(staging, "quarantined-commands");
      for (const item of read.quarantine) {
        await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
        let target = join(quarantineDirectory, item.name);
        for (let n = 1; existsSync(target); n++)
          target = join(quarantineDirectory, `${item.name}.dup${n}`);
        await rename(join(staging, "commands", item.name), target);
      }
      for (const item of read.rearm)
        await writeFile(
          join(staging, "commands", `${item.id}.json`),
          canonicalText(item.value),
          { mode: 0o600, flush: true },
        );
      await writeFile(
        join(legacy, journalName),
        JSON.stringify({
          version: 1,
          destination: options.control,
          digest: await treeDigest(staging),
        }),
        { mode: 0o600, flush: true },
      );
      await rename(staging, options.control);
      published = true;
      await syncDirectory(dirname(options.control));
      await moves.afterPublish?.();
      report.method = "staged-copy";
      // Whatever appeared or changed after the snapshot was not published.
      const known = new Map(
        supervisorSnapshot.entries.map((e) => [e.path, e] as const),
      );
      for (const entry of scan(legacy, ours)) {
        const seen = known.get(entry.path);
        const info = lstatSync(join(legacy, entry.path));
        if (
          !seen ||
          seen.size !== entry.size ||
          (entry.kind === "file" && seen.mtimeMs !== info.mtimeMs)
        )
          report.lateFilesLeftBehind.push(entry.path);
      }
      report.leftover = await retire(
        legacy,
        report.lateFilesLeftBehind.length > 0,
      );
    } else if (hasSupervisor) {
      // A published copy awaiting retirement; keep the source inert.
      report.method = "staged-copy";
      report.leftover = await retire(legacy, true);
    }
    if (hasWatchdog) {
      const destination = join(options.control, "watchdog");
      if (dogResuming) report.leftover ??= await retire(legacyDog, true);
      else {
        const staged = await snapshot(legacyDog, dogStaging, new Set(), moves);
        apply(staged, null);
        await writeFile(
          join(legacyDog, journalName),
          JSON.stringify({
            version: 1,
            destination,
            digest: await treeDigest(dogStaging),
          }),
          { mode: 0o600, flush: true },
        );
        await rename(dogStaging, destination);
        dogPublished = true;
        await syncDirectory(options.control);
        await moves.afterPublish?.();
        const known = new Set(staged.entries.map((e) => e.path));
        const late = scan(legacyDog)
          .map((e) => e.path)
          .filter((path) => !known.has(path));
        report.lateFilesLeftBehind.push(...late.map((p) => `watchdog/${p}`));
        report.leftover ??= await retire(legacyDog, late.length > 0);
      }
      report.watchdog = true;
      report.method ??= "staged-copy";
    }
    // Fresh files are already private; assert the invariant for the whole tree.
    await chmod(options.control, 0o700);
    if (options.identity)
      await bindControl(options.store, options.control, options.identity);
    checkControlDirectory(options.control);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await rm(dogStaging, { recursive: true, force: true }).catch(() => {});
    // An empty leaf this run created is not left behind by a refusal.
    if (createdLeaf && !published && !dogPublished)
      await rmdir(options.control).catch(() => {});
    if (!published)
      await rm(join(legacy, journalName), { force: true }).catch(() => {});
    if (!dogPublished)
      await rm(join(legacyDog, journalName), { force: true }).catch(() => {});
    throw error;
  } finally {
    if (recovery) {
      // Only our own lock file is ever removed.
      const text = await readFile(recoveryPath, "utf8").catch(() => null);
      if (text === String(process.pid))
        await unlink(recoveryPath).catch(() => {});
    }
    await release?.().catch(() => {});
  }
  return report;
}
