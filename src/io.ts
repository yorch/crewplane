import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Persist directory entry changes before reporting publication complete. */
export async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Publish complete private JSON, durably; exclusive publication never replaces a target. */
export async function publishJson(
  path: string,
  value: unknown,
  options: { exclusive?: boolean } = {},
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
