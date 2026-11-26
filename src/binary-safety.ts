import { lstat, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { printablePath } from "./project.ts";

/**
 * Reports why an executable must not be recorded in a generated configuration,
 * or null when it looks safe. Nothing is executed. Shared by `setup` (which
 * only records safe binaries) and `doctor` (which reports `BINARY_UNSAFE`).
 *
 * The path is resolved the way the kernel does, one component at a time from
 * `/`: every directory entered (as named, through symlinks, and the ancestors
 * of those) and every symlink followed is inspected with lstat. Checked, on
 * POSIX only (owner and group checks are skipped where there is no uid):
 * - every symlink on the path and the final file is owned by the current user
 *   or root;
 * - the final file is not world-writable, and not group-writable unless its
 *   group is one the current user belongs to (umask-002 installs are 0775);
 * - a sticky directory (/tmp, multi-user Nix /nix/store) is judged by
 *   ownership only: the current user or root must own it;
 * - every other directory is not world-writable, is owned by the current user
 *   or root, and, when group-writable, has a group the current user belongs
 *   to (primary group included). Members of the user's own groups are inside the trust
 *   boundary; users outside them cannot replace the binary or anything on its
 *   path.
 * Not checked: ACLs, extended attributes, mounts, capabilities, and anything
 * that changes after the check (a race remains between setup and launch).
 * The as-named path is what gets recorded, and only when this whole chain passes.
 */
export type SafetyCheck = (path: string) => Promise<string | null>;

/** What the walk needs to know about one path component (an lstat result). */
export interface Entry {
  kind: "file" | "directory" | "symlink" | "other";
  uid: number;
  gid: number;
  mode: number;
}

/**
 * The file system primitives the walk uses. The default is the real one;
 * tests inject synthetic entries so ownership cases need no chown or root.
 */
export interface SafetyFs {
  lstat(path: string): Promise<Entry>;
  readlink(path: string): Promise<string>;
}

export const realFs: SafetyFs = {
  async lstat(path) {
    const info = await lstat(path);
    return {
      kind: info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other",
      uid: info.uid,
      gid: info.gid,
      mode: info.mode,
    };
  },
  readlink: (path) => readlink(path),
};

/** The identity the probe judges ownership and group membership against. */
export interface Identity {
  uid: number | null;
  gid: number | null;
  /** Every group the user belongs to, including the primary group. */
  groups: number[];
}

export function currentIdentity(): Identity {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  const groups =
    typeof process.getgroups === "function" ? process.getgroups() : [];
  if (gid !== null && !groups.includes(gid)) groups.push(gid);
  return { uid, gid, groups };
}

const maxHops = 40;

const trusted = (info: Entry, who: Identity) =>
  who.uid === null || info.uid === who.uid || info.uid === 0;
const worldOpen = (info: Entry) => (info.mode & 0o002) !== 0;
const sticky = (info: Entry) => (info.mode & 0o1000) !== 0;

function directoryProblem(
  directory: string,
  info: Entry,
  who: Identity,
): string | null {
  const name = printablePath(directory);
  if (sticky(info)) {
    // Only an entry's owner or the directory's owner can rename or remove
    // entries in a sticky directory, so group/world write bits (/tmp 1777,
    // multi-user Nix /nix/store 1775 root:nixbld) do not matter: ownership only.
    return trusted(info, who)
      ? null
      : `a directory on its path (${name}) is owned by another user`;
  }
  if (worldOpen(info))
    return `a directory on its path (${name}) is world-writable without the sticky bit`;
  if (!trusted(info, who))
    return `a directory on its path (${name}) is owned by another user`;
  if (
    (info.mode & 0o020) !== 0 &&
    who.uid !== null &&
    !who.groups.includes(info.gid)
  )
    return `a directory on its path (${name}) is group-writable by a group the current user is not in`;
  return null;
}

export const binarySafetyProblem = async (
  path: string,
  who: Identity = currentIdentity(),
  fs: SafetyFs = realFs,
): Promise<string | null> => {
  const queue = resolve(path).split("/").filter(Boolean);
  let current = "/";
  const checked = new Set<string>();
  const enter = async (directory: string): Promise<string | null> => {
    if (checked.has(directory)) return null;
    let info: Entry;
    try {
      info = await fs.lstat(directory);
    } catch {
      return "its directory cannot be inspected";
    }
    if (info.kind !== "directory") return "its directory cannot be inspected";
    const problem = directoryProblem(directory, info, who);
    if (problem === null) checked.add(directory);
    return problem;
  };
  let problem = await enter(current);
  if (problem) return problem;
  let hops = 0;
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (name === ".") continue;
    if (name === "..") {
      current = dirname(current);
      continue;
    }
    const full = join(current, name);
    // /proc magic links read back as text that is not their real target.
    if (full === "/proc" || full.startsWith("/proc/"))
      return "it is under /proc, whose links do not name their real target";
    let info: Entry;
    try {
      info = await fs.lstat(full);
    } catch {
      return "it cannot be inspected";
    }
    if (info.kind === "symlink") {
      if (!trusted(info, who)) return "it is owned by another user";
      if (++hops > maxHops) return "its symlink chain is too long or loops";
      let target: string;
      try {
        target = await fs.readlink(full);
      } catch {
        return "it cannot be inspected";
      }
      if (target.startsWith("/")) current = "/";
      queue.unshift(...target.split("/").filter(Boolean));
      continue;
    }
    if (queue.length === 0) {
      if (info.kind !== "file") return "it is not a regular file";
      if (!trusted(info, who)) return "it is owned by another user";
      if (
        (info.mode & 0o002) !== 0 ||
        ((info.mode & 0o020) !== 0 &&
          who.uid !== null &&
          !who.groups.includes(info.gid))
      )
        return "it is group- or world-writable";
      return null;
    }
    current = full;
    problem = await enter(current);
    if (problem) return problem;
  }
  return "it is not a regular file";
};

/** Injected `check` functions stand in for the file system, so they get no safety probe. */
export const noSafety: SafetyCheck = async () => null;
