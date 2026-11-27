import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  diffSnapshots,
  guardedDirectories,
  snapshotTree,
} from "./support/home-guard.ts";

it("detects added, changed and removed files under a guarded directory", () => {
  const root = mkdtempSync(join(tmpdir(), "crewplane-guard-"));
  try {
    mkdirSync(join(root, "supervisors"));
    writeFileSync(join(root, "supervisors", "1.json"), "{}");
    writeFileSync(join(root, "keep.json"), "{}");
    const before = snapshotTree(root);
    expect(diffSnapshots(before, snapshotTree(root))).toEqual([]);
    writeFileSync(join(root, "supervisors", "2.json"), "{}");
    writeFileSync(join(root, "keep.json"), "{ }");
    utimesSync(join(root, "keep.json"), new Date(0), new Date(0));
    rmSync(join(root, "supervisors", "1.json"));
    expect(diffSnapshots(before, snapshotTree(root)).sort()).toEqual(
      [
        `added ${join(root, "supervisors", "2.json")}`,
        `changed ${join(root, "keep.json")}`,
        `changed ${join(root, "supervisors")}`,
        `removed ${join(root, "supervisors", "1.json")}`,
      ].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("guards the state and cache directories the suite is meant to redirect", () => {
  // Inside the suite both are redirected to temporary directories, so what is
  // guarded by the global setup (computed from the runner's own environment)
  // is a different, real location.
  expect(process.env.CREWPLANE_STATE_DIR).toMatch(/crewplane-test-state-/);
  expect(process.env.CREWPLANE_CACHE_DIR).toMatch(/crewplane-test-cache-/);
  expect(guardedDirectories()).toHaveLength(2);
});
