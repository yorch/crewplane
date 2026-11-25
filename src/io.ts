import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  link,
  mkdir,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/** Persist directory entry changes before reporting publication complete. */
export async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Persist directory entries bottom-up through a known durable existing root.
 * Without a root, the nearest pre-existing ancestor is the durability boundary.
 * An explicit root also covers directories previously created by the caller.
 */
export async function durableMkdir(
  path: string,
  options: { root?: string | undefined } = {},
) {
  path = resolve(path);
  const root = options.root === undefined ? undefined : resolve(options.root);
  if (root !== undefined) {
    const child = relative(root, path);
    if (child === ".." || child.startsWith(`..${sep}`) || child.startsWith(sep))
      throw Error("Directory outside durability root");
    if (!(await stat(root)).isDirectory())
      throw Error("Invalid durability root");
  }
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  const boundary = root ?? (firstCreated ? dirname(firstCreated) : undefined);
  if (boundary === undefined) return;
  for (let current = path; ; current = dirname(current)) {
    await syncDirectory(current);
    if (current === boundary) break;
    if (dirname(current) === current)
      throw Error("Invalid durability boundary");
  }
}

/** Publish complete private JSON, durably; exclusive publication never replaces a target. */
export async function publishJson(
  path: string,
  value: unknown,
  options: { exclusive?: boolean; directoryRoot?: string } = {},
) {
  await durableMkdir(dirname(path), { root: options.directoryRoot });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (options.exclusive) await link(temporary, path);
    else await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Size cap for small private state files (watchdog and health records). */
export const PRIVATE_STATE_MAX_BYTES = 65536;

/**
 * A private file is a regular file owned by this user with no group or other
 * permission bits and no more than `maxBytes` bytes. A restored or copied store
 * owned by another user (including root) is rejected on POSIX by design.
 */
/** Ownership is POSIX-only: without getuid (Windows) it is not checked. */
const ownedByCurrentUser = (uid: number) => {
  const current = process.getuid?.();
  return current === undefined || uid === current;
};

/** Never block on open: a FIFO would otherwise hang until a writer appears. */
const readFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);

export function isPrivateFile(
  stat: { isFile(): boolean; size: number; uid: number; mode: number },
  maxBytes: number,
): boolean {
  return (
    stat.isFile() &&
    stat.size <= maxBytes &&
    ownedByCurrentUser(stat.uid) &&
    (stat.mode & 0o077) === 0
  );
}

/**
 * Read a private file without following a final symlink. Open errors
 * (ENOENT, ELOOP, ...) propagate unchanged; a file that fails the private-file
 * check throws Error(`invalid`) before any content is read.
 */
export async function readPrivateFile(
  path: string,
  maxBytes: number,
  invalid = "Invalid private file",
): Promise<string> {
  const handle = await open(path, readFlags);
  try {
    if (!isPrivateFile(await handle.stat(), maxBytes)) throw new Error(invalid);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Synchronous variant of readPrivateFile, returning the raw bytes. */
export function readPrivateFileSync(
  path: string,
  maxBytes: number,
  invalid = "Invalid private file",
): Buffer {
  const fd = openSync(path, readFlags);
  try {
    if (!isPrivateFile(fstatSync(fd), maxBytes)) throw new Error(invalid);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
