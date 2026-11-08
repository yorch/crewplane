import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { publishJson } from "../../io.ts";
import { withProcessLock } from "../../process-lock.ts";
import type {
  WatchdogInput,
  WatchdogNotice,
  WatchdogResult,
  WatchdogSettings,
  WatchdogState,
} from "./policy.ts";
import { evaluateWatchdog } from "./policy.ts";
export interface WatchdogOptions {
  directory: string;
  readInput(): Promise<WatchdogInput>;
  settings: WatchdogSettings;
  notify(notice: WatchdogNotice): Promise<void>;
  requestRecovery(recovery: "request-restart"): Promise<void>;
  signal: AbortSignal;
  clock?: {
    now(): number;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
  };
}
const systemClock = {
  now: Date.now,
  sleep: async (ms: number, signal: AbortSignal) => {
    await setTimeout(ms, undefined, { signal });
  },
};
async function readPrivate(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Invalid watchdog state");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
async function atomic(path: string, value: unknown): Promise<void> {
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data) > 65536)
    throw new Error("Watchdog state too large");
  await publishJson(path, value);
}
async function run(
  options: WatchdogOptions,
  once: boolean,
): Promise<WatchdogResult | null> {
  const clock = options.clock ?? systemClock;
  if (options.signal.aborted) return null;
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(options.directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid?.()
  )
    throw new Error("Invalid watchdog directory");
  await chmod(options.directory, 0o700);
  const lease = join(options.directory, "lease");
  const owner = { version: 1, pid: process.pid, identity: randomUUID() };
  const ownerPath = join(lease, "owner.json");
  await withProcessLock(
    join(await realpath(options.directory), "lease-acquire.lock"),
    async () => {
      try {
        await mkdir(lease, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const leaseStat = await lstat(lease);
        if (
          !leaseStat.isDirectory() ||
          leaseStat.isSymbolicLink() ||
          leaseStat.uid !== process.getuid?.() ||
          (leaseStat.mode & 0o077) !== 0
        )
          throw Error("Watchdog lease unavailable");
        const previous = await readPrivate(ownerPath)
          .then(JSON.parse)
          .catch(() => {
            throw Error("Watchdog lease unavailable");
          });
        if (
          !Number.isSafeInteger(previous.pid) ||
          previous.pid < 1 ||
          typeof previous.identity !== "string"
        )
          throw Error("Watchdog lease unavailable");
        try {
          process.kill(previous.pid, 0);
          throw Error("Watchdog lease unavailable");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await unlink(ownerPath);
        await rmdir(lease);
        await mkdir(lease, { mode: 0o700 });
      }
      await atomic(ownerPath, owner);
    },
  );
  let ownsLease = false;
  try {
    ownsLease = true;
    let previous: WatchdogState | null = null;
    const latestPath = join(options.directory, "latest.json");
    try {
      const persisted = JSON.parse(await readPrivate(latestPath)) as {
        state: WatchdogState;
      };
      if (!persisted.state) throw new Error("Invalid watchdog state");
      previous = persisted.state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Invalid watchdog state");
    }
    let result: WatchdogResult | null = null;
    while (!options.signal.aborted) {
      let input: WatchdogInput;
      try {
        input = await options.readInput();
      } catch {
        throw new Error("Watchdog input unavailable");
      }
      if (options.signal.aborted) break;
      const now = clock.now();
      if (!Number.isFinite(now) || now < 0)
        throw new Error("Invalid watchdog clock");
      if (
        !Number.isFinite(input.now) ||
        input.now < 0 ||
        input.now > now ||
        now - input.now > options.settings.intervalMs
      )
        throw new Error("Watchdog observation time mismatch");
      // Snapshot freshness is distinct from evaluation/scheduling time. Keep all
      // observed event timestamps intact, but never schedule from cached input.now.
      result = evaluateWatchdog({ ...input, now }, previous, options.settings);
      if (
        previous?.nextCheckAt !== null &&
        previous?.nextCheckAt !== undefined &&
        now < previous.nextCheckAt
      ) {
        if (once) return null;
        await clock.sleep(previous.nextCheckAt - now, options.signal);
        continue;
      }
      // Persist attempted effects before calling the controller. A crash never resets cooldown/backoff.
      await atomic(latestPath, {
        ...result,
        checkedAt: now,
        nextCheck: result.state.nextCheckAt,
        delivery: "pending",
      });
      previous = result.state;
      let callbackFailed = false;
      if (result.notice && !options.signal.aborted) {
        try {
          await options.notify(structuredClone(result.notice));
        } catch {
          callbackFailed = true;
        }
      }
      if (result.recovery === "request-restart" && !options.signal.aborted) {
        try {
          await options.requestRecovery("request-restart");
        } catch {
          callbackFailed = true;
        }
      }
      await atomic(latestPath, {
        ...result,
        checkedAt: now,
        nextCheck: result.state.nextCheckAt,
        delivery: callbackFailed
          ? "callback-failed"
          : options.signal.aborted
            ? "aborted"
            : "complete",
      });
      if (once) return result;
      await clock.sleep(
        Math.max(0, (result.state.nextCheckAt ?? clock.now()) - clock.now()),
        options.signal,
      );
    }
    return result;
  } catch (error) {
    if (!options.signal.aborted) throw error;
    return null;
  } finally {
    if (ownsLease) {
      const current = JSON.parse(
        await readFile(ownerPath, "utf8"),
      ) as typeof owner;
      if (current.pid === owner.pid && current.identity === owner.identity) {
        await unlink(ownerPath);
        await rmdir(lease);
      }
    }
  }
}
export async function startWatchdog(options: WatchdogOptions): Promise<void> {
  await run(options, false);
}
export async function checkWatchdog(
  options: WatchdogOptions,
): Promise<WatchdogResult | null> {
  return await run(options, true);
}
