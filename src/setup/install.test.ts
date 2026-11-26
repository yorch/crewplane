import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installConfig, stoppedProblem } from "./install.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function target() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-install-")));
  scratch.push(base);
  const bin = join(base, "codex");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  const directory = join(base, "control");
  const store = join(base, "store");
  mkdirSync(store);
  const value = {
    version: 1,
    binary: bin,
    allowedTasks: ["T-1"],
    maxParallel: 1,
    intervalSeconds: 10,
    maxRunMinutes: 5,
    maxRunsPerHour: 5,
    confirmedStoppedAt: "2026-11-08T00:00:00.000Z",
    lanes: { captain: { enabled: true } },
  };
  return {
    base,
    directory,
    value,
    target: {
      root: base,
      policy: { coordinator: "captain", reviewers: [], reviewerRoles: {} },
      store,
      directory,
      identity: { primaryRoot: base, gitCommon: join(base, ".git") },
    },
  };
}
/** A recorded child that is alive and ours, while `running` is false. */
const liveChild = (directory: string) =>
  writeFileSync(
    join(directory, "state.json"),
    JSON.stringify({
      running: false,
      records: { r: { lane: "captain", status: "running", pid: process.pid } },
    }),
  );

it("setup's install refuses on supervisor liveness inside the lock; configure's does not", async () => {
  const t = target();
  await installConfig(t.value, t.target);
  const before = readFileSync(join(t.directory, "config.json"), "utf8");
  liveChild(t.directory);
  await expect(
    installConfig(t.value, t.target, { requireStopped: true }),
  ).rejects.toThrow(/Stop and inspect the existing supervisor.*is alive/);
  expect(readFileSync(join(t.directory, "config.json"), "utf8")).toBe(before);
  // configure keeps its documented behaviour: only the recorded flag counts.
  await expect(installConfig(t.value, t.target)).resolves.toBeDefined();
});

it("stoppedProblem reports the running flag and live evidence, and nothing otherwise", async () => {
  const t = target();
  mkdirSync(t.directory);
  expect(await stoppedProblem(t.directory)).toBeNull();
  writeFileSync(join(t.directory, "state.json"), '{"running":true}');
  expect(await stoppedProblem(t.directory)).toMatch(
    /control state says a supervisor is running/,
  );
  liveChild(t.directory);
  expect(await stoppedProblem(t.directory)).toMatch(/appears to be live/);
  writeFileSync(join(t.directory, "state.json"), "{broken");
  await expect(stoppedProblem(t.directory)).rejects.toThrow(
    /Invalid private state/,
  );
});
