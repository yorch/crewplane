import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { durableMkdir } from "./io.ts";

interface Owner {
  pid: number;
  token: string;
}
async function owner(path: string): Promise<Owner | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw Error("Unsafe process lock");
    const value = JSON.parse(await handle.readFile("utf8")) as Owner;
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.token)
    )
      throw Error("Invalid process lock");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Remove temp publications orphaned by a crash; young ones may be in flight. */
async function sweepOrphans(path: string, now = Date.now()) {
  const prefix = `${basename(path)}.`;
  for (const name of await readdir(dirname(path)).catch(() => [] as string[])) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const file = join(dirname(path), name);
    const info = await stat(file).catch(() => null);
    if (info !== null && now - info.mtimeMs >= 60_000)
      await unlink(file).catch(() => undefined);
  }
}
/** Cross-process exclusion; recover only a verifiably dead owner, never by age. */
export async function withProcessLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  path = resolve(path);
  let current = "/";
  for (const part of dirname(path).split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error("Unsafe lock ancestor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await durableMkdir(dirname(path));
  const lease: Owner = { pid: process.pid, token: randomUUID() },
    deadline = Date.now() + 10000;
  while (true) {
    // Publish a complete owner file atomically so no empty lock is ever visible.
    const temp = `${path}.${lease.token}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(lease), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await link(temp, path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    let previous: Owner | null = null;
    try {
      previous = await owner(path);
    } catch {
      /* A just-created owner file may not be flushed yet. Never remove unverified data. */
    }
    if (previous && !alive(previous.pid)) {
      const recovery = `${path}.recovery`;
      let recoveryHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        recoveryHandle = await open(recovery, "wx", 0o600);
        const latest = await owner(path);
        if (latest?.token === previous.token && !alive(latest.pid)) {
          await unlink(path);
          await sweepOrphans(path);
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
      } finally {
        if (recoveryHandle) {
          await recoveryHandle.close();
          await unlink(recovery);
        }
      }
    }
    if (Date.now() >= deadline)
      throw Error("Process lock unavailable; inspect ownership before retry");
    await delay(10);
  }
  try {
    return await operation();
  } finally {
    try {
      if ((await owner(path))?.token === lease.token) await unlink(path);
    } catch {
      /* Release is best-effort; it must not mask the operation result or error. */
    }
  }
}
