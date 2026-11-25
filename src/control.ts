import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { syncDirectory } from "./io.ts";

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
): string {
  const key = createHash("sha256")
    .update(realpathSync(primaryRoot))
    .digest("hex")
    .slice(0, 24);
  return join(controlStateBase(env, home), "crewplane", "projects", key);
}

/** The pre-relocation location: inside the project store, agent-writable. */
export const legacySupervisorDirectory = (store: string) =>
  join(store, "supervisor");
export const legacyWatchdogDirectory = (store: string) =>
  join(store, "watchdog");

/** Directories this module owns: `<base>/crewplane/projects/<key>` is checked whole. */
function chain(path: string): string[] {
  const parent = dirname(path);
  const grand = dirname(parent);
  return basename(parent) === "projects" && basename(grand) === "crewplane"
    ? [grand, parent, path]
    : [path];
}

function problem(path: string): string | "absent" | null {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (info.isSymbolicLink()) return "is a symbolic link";
  if (!info.isDirectory()) return "is not a directory";
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    return "is not owned by the current user";
  if ((info.mode & 0o022) !== 0) return "is group or world writable";
  return null;
}

/**
 * Verify an existing control directory without creating it. Returns false when
 * it does not exist yet; throws when it exists and is unsafe (symlink, wrong
 * owner, group/world writable). Readers call this before trusting any file.
 */
export function checkControlDirectory(path: string): boolean {
  let present = false;
  for (const entry of chain(path)) {
    const found = problem(entry);
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
