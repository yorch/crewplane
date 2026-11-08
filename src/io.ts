import { randomUUID } from "node:crypto";
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
