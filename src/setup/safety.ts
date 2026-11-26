import type { Stats } from "node:fs";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { printablePath } from "../project.ts";

/**
 * Reports why an executable must not be recorded in a generated configuration,
 * or null when it looks safe. Nothing is executed. This is setup-only policy:
 * `doctor` (probeBinary) deliberately does not apply it, so a configuration
 * written by hand keeps its documented behaviour.
 *
 * Checked, on POSIX only (owner checks are skipped where there is no uid):
 * - every hop of the symlink chain (each link and the final file) is owned by
 *   the current user or root;
 * - the final file is not group- or world-writable;
 * - the directory holding each hop (strict): not world-writable without the
 *   sticky bit, owned by the current user or root, and, when group-writable,
 *   owned by the current user with the current user's primary group;
 * - every directory on the way to each hop, and each of their ancestors up to
 *   the root (lenient): not world-writable without the sticky bit and owned by
 *   the current user or root. Group-writable ancestors are NOT refused (for
 *   example /usr/local on Debian), nor are ACLs, mounts, attributes or
 *   capabilities examined.
 * Not checked: anything that changes after the check (a race remains between
 * setup and the supervisor launching the file).
 */
export type SafetyCheck = (path: string) => Promise<string | null>;

const currentUid = () =>
  typeof process.getuid === "function" ? process.getuid() : null;
const currentGid = () =>
  typeof process.getgid === "function" ? process.getgid() : null;
const maxHops = 40;

type Info = Stats;
const trusted = (info: Info) => {
  const uid = currentUid();
  return uid === null || info.uid === uid || info.uid === 0;
};
const open = (info: Info) =>
  (info.mode & 0o002) !== 0 && (info.mode & 0o1000) === 0;

/** Each hop of the chain: the symlinks followed and then the final file. */
async function chain(path: string): Promise<string[] | string> {
  const hops: string[] = [];
  let current = resolve(path);
  for (let i = 0; i < maxHops; i++) {
    let full: string;
    try {
      full = join(await realpath(dirname(current)), basename(current));
    } catch {
      return "its directory cannot be inspected";
    }
    hops.push(full);
    let info: Stats;
    try {
      info = await lstat(full);
    } catch {
      return "it cannot be inspected";
    }
    if (!info.isSymbolicLink()) return hops;
    try {
      current = resolve(dirname(full), await readlink(full));
    } catch {
      return "it cannot be inspected";
    }
  }
  return "its symlink chain is too long";
}

async function strictDirectory(directory: string): Promise<string | null> {
  let info: Info;
  try {
    info = await stat(directory);
  } catch {
    return "its directory cannot be inspected";
  }
  if (open(info))
    return "its directory is world-writable without the sticky bit";
  if (!trusted(info)) return "its directory is owned by another user";
  const gid = currentGid();
  if ((info.mode & 0o020) !== 0 && gid !== null && info.gid !== gid)
    return "its directory is group-writable by a group that is not the current user's primary group";
  return null;
}

async function lenientDirectory(directory: string): Promise<string | null> {
  let info: Info;
  try {
    info = await stat(directory);
  } catch {
    return `a parent directory cannot be inspected: ${printablePath(directory)}`;
  }
  if (open(info))
    return `a parent directory (${printablePath(directory)}) is world-writable without the sticky bit`;
  if (!trusted(info))
    return `a parent directory (${printablePath(directory)}) is owned by another user`;
  return null;
}

export const binarySafetyProblem: SafetyCheck = async (path) => {
  const hops = await chain(path);
  if (typeof hops === "string") return hops;
  const strict = new Set<string>();
  const lenient = new Set<string>();
  for (const hop of hops) {
    strict.add(dirname(hop));
    // Every lexical component can redirect resolution, so the real directory
    // that holds each one, and all of its ancestors, are examined as well.
    let prefix = hop;
    while (dirname(prefix) !== prefix) {
      let directory: string;
      try {
        directory = await realpath(dirname(prefix));
      } catch {
        return "its directory cannot be inspected";
      }
      for (let d = directory; ; d = dirname(d)) {
        lenient.add(d);
        if (dirname(d) === d) break;
      }
      prefix = dirname(prefix);
    }
  }
  for (const hop of hops) {
    let info: Info;
    try {
      info = await lstat(hop);
    } catch {
      return "it cannot be inspected";
    }
    if (!trusted(info)) return "it is owned by another user";
  }
  let target: Info;
  try {
    target = await stat(hops[hops.length - 1] as string);
  } catch {
    return "it cannot be inspected";
  }
  if ((target.mode & 0o022) !== 0) return "it is group- or world-writable";
  for (const directory of strict) {
    const problem = await strictDirectory(directory);
    if (problem) return problem;
  }
  for (const directory of lenient) {
    if (strict.has(directory)) continue;
    const problem = await lenientDirectory(directory);
    if (problem) return problem;
  }
  return null;
};

/** Injected `check` functions stand in for the file system, so they get no safety probe. */
export const noSafety: SafetyCheck = async () => null;
