import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { sha256Hex } from "./hash.ts";
import { publishJson, syncDirectory } from "./io.ts";

/**
 * The control plane (supervisor commands, configuration, state, leases, run
 * logs and watchdog state) lives in a private per-user directory outside the
 * project, so it is not inside any root a harness is handed. The board (tasks,
 * messages, evidence, traces, monitor) stays in the project store.
 *
 * This is defense in depth, not a sandbox: an agent running as the same user
 * can still reach any file the user can. See docs/USAGE.md "Control directory".
 */
const printable = (value: string) => value.replace(/\p{Cc}/gu, "?");

/** Base directory for per-user Crewplane state (before `crewplane/projects/...`). */
export function controlStateBase(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.CREWPLANE_STATE_DIR;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override))
      throw new Error("CREWPLANE_STATE_DIR must be an absolute path");
    return override;
  }
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return xdg;
  if (!isAbsolute(home))
    throw new Error(
      "HOME must be an absolute path to locate the control directory",
    );
  return join(home, ".local", "state");
}

/**
 * Pure derivation of the control directory for a project; nothing is created.
 * The key is the canonical primary root, so symlinked paths and every linked
 * worktree of one project agree on a single directory.
 */
export function controlDirectory(
  primaryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  realpath: (path: string) => string = realpathSync.native,
): string {
  // The native realpath returns the filesystem's own spelling, so a
  // case-insensitive volume yields one key for every spelling of the root.
  const key = sha256Hex(realpath(primaryRoot)).slice(0, 24);
  return join(controlStateBase(env, home), "crewplane", "projects", key);
}

/** The pre-relocation location: inside the project store, agent-writable. */
export const legacySupervisorDirectory = (store: string) =>
  join(store, "supervisor");
export const legacyWatchdogDirectory = (store: string) =>
  join(store, "watchdog");

/**
 * Directories this module owns: `<base>/crewplane/projects/<key>` is checked
 * whole. Ancestors above `crewplane/` (for example `~/.local/state`) belong to
 * the user and are not checked.
 */
function chain(path: string): string[] {
  const parent = dirname(path);
  const grand = dirname(parent);
  return basename(parent) === "projects" && basename(grand) === "crewplane"
    ? [grand, parent, path]
    : [path];
}

function problem(
  path: string,
  expectedUid: number | undefined = process.getuid?.(),
): string | "absent" | null {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (info.isSymbolicLink()) return "is a symbolic link";
  if (!info.isDirectory()) return "is not a directory";
  const uid = expectedUid;
  if (uid === undefined)
    throw new Error(
      "The private control directory is unsupported on this platform (no POSIX ownership checks)",
    );
  if (info.uid !== uid) return "is not owned by the current user";
  if ((info.mode & 0o022) !== 0) return "is group or world writable";
  if ((info.mode & 0o007) !== 0) return "is accessible by other users";
  return null;
}

/**
 * Verify an existing control directory without creating it. Returns false when
 * it does not exist yet; throws when it exists and is unsafe (symlink, wrong
 * owner, group/world writable). Readers call this before trusting any file.
 */
export function checkControlDirectory(
  path: string,
  options: { uid?: number } = {},
): boolean {
  let present = false;
  for (const entry of chain(path)) {
    const found = problem(entry, options.uid ?? process.getuid?.());
    if (found === "absent") return false;
    if (found !== null)
      throw new Error(`Unsafe control directory: ${printable(entry)} ${found}`);
    present = true;
  }
  return present;
}

/** Create (mode 0700) and verify the control directory before any write. */
export async function ensureControlDirectory(path: string): Promise<void> {
  for (const [index, entry] of chain(path).entries()) {
    if (problem(entry) === "absent") {
      // The first component also creates any missing ancestors (e.g. ~/.local/state).
      await mkdir(entry, { mode: 0o700, recursive: index === 0 }).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        },
      );
      await syncDirectory(dirname(entry)).catch(() => {});
    }
    const found = problem(entry);
    if (found !== null)
      throw new Error(
        `Unsafe control directory: ${printable(entry)} ${found === "absent" ? "could not be created" : found}`,
      );
  }
}

/**
 * Binding between a project store and its control directory. The store keeps a
 * marker with a random id and the control key; the control directory keeps the
 * same id and the project identity. A mismatch means the repository moved, the
 * environment selecting the base differs, or a different checkout would inherit
 * an old configuration; every one of those fails closed rather than starting
 * fresh or adopting foreign state.
 */
export interface BindingIdentity {
  primaryRoot: string;
  gitCommon?: string | undefined;
}
const markerPath = (store: string) => join(store, "control-binding.json");
const identityPath = (control: string) => join(control, "identity.json");
/**
 * Bounded, non-blocking read of a small binding file: a FIFO, symlink or huge
 * file is "unreadable" and never hangs the caller.
 */
function readBindingFile(
  path: string,
): { text: string } | "absent" | "unreadable" {
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
    if (!info.isFile() || info.size > 65536) return "unreadable";
    return { text: readFileSync(fd, "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "unreadable";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
/** Strict: unreadable or invalid content is an error. Lenient: it is absent. */
function readBinding(
  path: string,
  lenient = false,
): Record<string, unknown> | null {
  const read = readBindingFile(path);
  if (read === "absent") return null;
  try {
    if (read === "unreadable") throw new Error("unreadable");
    const value = JSON.parse(read.text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    if (lenient) return null;
    throw new Error(`Invalid ${printable(path)}; inspect it before continuing`);
  }
}
export function checkBinding(
  store: string,
  control: string,
  identity: BindingIdentity,
  options: { narrowing?: boolean } = {},
): void {
  // The store marker is agent-writable: on the narrowing path an unreadable
  // or invalid one counts as absent, and identity.json in the private
  // directory is the authority.
  const marker = readBinding(markerPath(store), options.narrowing === true);
  const present = existsSync(control);
  const ident = present ? readBinding(identityPath(control)) : null;
  const populated =
    present && readdirSync(control).some((name) => name !== "identity.json");
  if (ident) {
    if (
      ident.primaryRoot !== identity.primaryRoot ||
      (identity.gitCommon !== undefined &&
        ident.gitCommon !== undefined &&
        ident.gitCommon !== identity.gitCommon)
    )
      throw new Error(
        `Control directory ${printable(control)} is bound to a different project identity (${printable(String(ident.primaryRoot))}); the repository was moved or its identity changed`,
      );
    // Narrowing into a directory bound to this very project is safe even when
    // the store marker was lost or rewritten; widening and start are not.
    if (!options.narrowing && (!marker || marker.id !== ident.bindingId))
      throw new Error(
        `Control directory ${printable(control)} belongs to a different checkout of this path (the project store has no matching control-binding.json); refusing to inherit its configuration. If this is intended, move that directory aside`,
      );
  } else if (marker && !populated)
    throw new Error(
      `The project store records prior supervision (control directory ${printable(String(marker.controlDirectory ?? "unknown"))}) but ${printable(control)} has no matching state. The repository may have moved, or HOME, XDG_STATE_HOME or CREWPLANE_STATE_DIR differ from the original start. Restore the environment or the directory; to start fresh deliberately, remove ${printable(markerPath(store))}`,
    );
}
/** Verify, then record the binding on both sides if it is not yet recorded. */
export async function bindControl(
  store: string,
  control: string,
  identity: BindingIdentity,
  options: { narrowing?: boolean } = {},
): Promise<void> {
  checkBinding(store, control, identity, options);
  // A narrowing write into an already bound directory records nothing.
  if (options.narrowing && readBinding(identityPath(control))) return;
  let marker = readBinding(markerPath(store), options.narrowing === true);
  if (!marker && options.narrowing && existsSync(markerPath(store))) {
    // A damaged marker is left for the operator (`migrate --rebind`); the
    // identity is still recorded so the halt can proceed.
    marker = { id: randomUUID() };
  } else if (!marker) {
    marker = {
      version: 1,
      id: randomUUID(),
      key: basename(control),
      controlDirectory: control,
    };
    await publishJson(markerPath(store), marker, { exclusive: true }).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      },
    );
    marker = readBinding(markerPath(store), options.narrowing === true);
  }
  if (!readBinding(identityPath(control)))
    await publishJson(identityPath(control), {
      version: 1,
      bindingId: marker?.id,
      primaryRoot: identity.primaryRoot,
      ...(identity.gitCommon === undefined
        ? {}
        : { gitCommon: identity.gitCommon }),
    });
  checkBinding(store, control, identity, options);
}

/**
 * Rewrite the store marker from the control directory's identity, for an
 * operator who lost or damaged control-binding.json. Only when the identity
 * names this very project.
 */
export async function rebindControl(
  store: string,
  control: string,
  identity: BindingIdentity,
): Promise<"rebound" | "unchanged"> {
  const ident = readBinding(identityPath(control));
  if (!ident)
    throw new Error(
      `${printable(control)} has no identity.json to rebind from; nothing to do`,
    );
  if (
    ident.primaryRoot !== identity.primaryRoot ||
    (identity.gitCommon !== undefined &&
      ident.gitCommon !== undefined &&
      ident.gitCommon !== identity.gitCommon)
  )
    throw new Error(
      "The control directory is bound to a different project identity; refusing to rebind",
    );
  const marker = readBinding(markerPath(store), true);
  if (marker && marker.id === ident.bindingId) return "unchanged";
  await publishJson(markerPath(store), {
    version: 1,
    id: ident.bindingId,
    key: basename(control),
    controlDirectory: control,
  });
  return "rebound";
}

/** The store marker's id, when the store has one. */
export const storeMarkerId = (store: string): string | null => {
  const marker = readBinding(markerPath(store));
  return typeof marker?.id === "string" ? marker.id : null;
};
/** identity.json content for a project, bound to a store marker id. */
export const identityText = (bindingId: string, identity: BindingIdentity) =>
  `${JSON.stringify(
    {
      version: 1,
      bindingId,
      primaryRoot: identity.primaryRoot,
      ...(identity.gitCommon === undefined
        ? {}
        : { gitCommon: identity.gitCommon }),
    },
    null,
    2,
  )}\n`;
/**
 * Finish a binding whose identity.json was published first: write the missing
 * store marker from it, then verify both sides agree.
 */
export async function completeBinding(
  store: string,
  control: string,
  identity: BindingIdentity,
): Promise<void> {
  const ident = readBinding(identityPath(control));
  if (!ident)
    throw new Error("The published control directory has no identity.json");
  if (!readBinding(markerPath(store)))
    await publishJson(
      markerPath(store),
      {
        version: 1,
        id: ident.bindingId,
        key: basename(control),
        controlDirectory: control,
      },
      { exclusive: true },
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  checkBinding(store, control, identity);
}
