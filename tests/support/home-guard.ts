import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { controlStateBase } from "../../src/control.ts";
import { cacheDirectory } from "../../src/update.ts";

/**
 * A suite-wide guard: the real per-user state and cache directories must be
 * byte-for-byte unchanged by a test run. Every test points CREWPLANE_STATE_DIR
 * and CREWPLANE_CACHE_DIR at temporary directories (see vitest.config.ts); a
 * test, a spawned CLI or a fake supervisor that forgets to is caught here
 * instead of silently leaving files in the developer's home.
 *
 * Limit: it cannot tell a leak from a real Crewplane the developer runs
 * concurrently during the suite; run the suite while nothing else is using
 * the real directories.
 */
export type Snapshot = Map<string, string>;

export function snapshotTree(root: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (directory: string) => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(directory, name);
      try {
        const info = statSync(path);
        out.set(
          path,
          `${info.isDirectory() ? "d" : "f"}:${info.size}:${info.mtimeMs}`,
        );
        if (info.isDirectory()) walk(path);
      } catch {
        // Removed while walking.
      }
    }
  };
  walk(root);
  return out;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const [path, stamp] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push(`added ${path}`);
    else if (old !== stamp) changes.push(`changed ${path}`);
  }
  for (const path of before.keys())
    if (!after.has(path)) changes.push(`removed ${path}`);
  return changes;
}

/** The directories a leaking test would write into, from the real environment. */
export const guardedDirectories = () => [
  join(controlStateBase(), "crewplane"),
  cacheDirectory(),
];

let before: Array<[string, Snapshot]> = [];
export function setup() {
  before = guardedDirectories().map((d) => [d, snapshotTree(d)]);
}
export function teardown() {
  const changes = before.flatMap(([directory, snapshot]) =>
    diffSnapshots(snapshot, snapshotTree(directory)),
  );
  if (changes.length)
    throw new Error(
      `The test run changed the real Crewplane state or cache directories:\n${changes.slice(0, 20).join("\n")}`,
    );
}
