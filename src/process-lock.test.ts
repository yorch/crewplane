import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { withProcessLock } from "./process-lock.ts";

it("recovers only a dead lock owner and serializes a live owner's critical section", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "process-lock-"));
  const path = join(root, "lock");
  try {
    await writeFile(
      path,
      JSON.stringify({ pid: 2147483647, token: randomUUID() }),
      { mode: 0o600 },
    );
    await withProcessLock(path, async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid),
    );
    let release = () => {};
    let entered = false;
    let acquired = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = withProcessLock(path, async () => {
      acquired();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const second = withProcessLock(path, async () => {
      entered = true;
    });
    await setTimeout(40);
    expect(entered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(entered).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
