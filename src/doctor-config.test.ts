import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { controlDirectory, ensureControlDirectory } from "./control.ts";
import { inspectConfiguration } from "./doctor-config.ts";
import { discoverProject } from "./project.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-inspect-")));
let store = "";
let controlDir = "";
beforeAll(async () => {
  writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: fixture");
  store = discoverProject(root).store;
  controlDir = controlDirectory(root);
  await ensureControlDirectory(controlDir);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const input = (
  limits?: Parameters<typeof inspectConfiguration>[0]["limits"],
) => ({
  root,
  store,
  controlDir,
  instructionsPath: "AGENTS.md",
  ...(limits ? { limits } : {}),
});
const config = (lanes: Record<string, unknown>) => ({
  version: 1,
  root,
  allowedTasks: [],
  maxParallel: 1,
  intervalSeconds: 5,
  maxRunMinutes: 5,
  maxRunsPerHour: 5,
  confirmedStoppedAt: "2026-01-01T00:00:00Z",
  lanes,
});
const invalidLanes = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `lane${String(i).padStart(3, "0")}`,
      { enabled: true, harness: "bogus" },
    ]),
  );

it("inspects every lane and reports every problem when no limits are given", async () => {
  const value = config(invalidLanes(100));
  const result = await inspectConfiguration(
    input({ readJson: async () => value }),
  );
  // An unbounded caller (crewplane doctor) is not limited by the endpoint's bounds.
  const doctorLike = await inspectConfiguration(input());
  expect(doctorLike.lanesTruncated).toBe(false);
  expect(doctorLike.problemsTruncated).toBe(false);
  expect(result.lanesTruncated).toBe(false);
  expect(
    result.binaryProblems.filter((p) => p.lane !== undefined),
  ).toHaveLength(100);
});

it("stops after a bounded number of lanes and a bounded number of problems", async () => {
  const value = config(invalidLanes(100));
  const lanes = await inspectConfiguration(
    input({ maxLanes: 10, readJson: async () => value }),
  );
  expect(lanes.lanesTruncated).toBe(true);
  expect(lanes.binaryProblems.filter((p) => p.lane !== undefined)).toHaveLength(
    10,
  );
  const problems = await inspectConfiguration(
    input({ maxProblems: 4, readJson: async () => value }),
  );
  expect(problems.problemsTruncated).toBe(true);
  expect(problems.configProblems.length + problems.binaryProblems.length).toBe(
    4,
  );
});

it("reads the configuration through the supplied reader, and an unreadable one is a problem", async () => {
  const missing = await inspectConfiguration(
    input({ readJson: async () => null }),
  );
  expect(missing.configProblems.map((p) => p.code)).toEqual(["CONFIG_MISSING"]);
  const broken = await inspectConfiguration(
    input({
      readJson: async () => {
        throw new Error("Invalid private state; inspect before recovery");
      },
    }),
  );
  expect(broken.configState).toBe("invalid");
  expect(broken.configProblems.map((p) => p.code)).toEqual(["CONFIG_INVALID"]);
});
