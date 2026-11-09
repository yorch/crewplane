import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Config } from "../contracts.ts";
import { serve } from "./supervisor.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewplane-controls-"));
  await writeFile(join(root, ".gitignore"), ".crewplane-state/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: control fixture");
  const directory = join(root, ".crewplane-state/supervisor");
  await mkdir(join(directory, "commands"), { recursive: true });
  const load = async () => {
    try {
      return JSON.parse(
        await readFile(join(directory, "state.json"), "utf8"),
      ) as {
        instanceHeld?: boolean;
        records: Record<
          string,
          {
            status: string;
            pauseKind?: string;
            pauseId?: string;
            reason: string;
          }
        >;
        notices: Record<string, string[]>;
      };
    } catch {
      return undefined;
    }
  };
  const config = (lanes: Config["lanes"]): Config => ({
    version: 1,
    root,
    binary: process.execPath,
    allowedTasks: [],
    maxParallel: 4,
    intervalSeconds: 1,
    maxRunMinutes: 1,
    maxRunsPerHour: 20,
    confirmedStoppedAt: new Date().toISOString(),
    lanes,
  });
  return { root, directory, git, load, config };
}
const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 7000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Control fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

it("never launches work while an instance hold is set", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify({
        version: 2,
        running: false,
        checkedAt: new Date().toISOString(),
        pid: process.pid,
        draining: false,
        held: [],
        instanceHeld: true,
        commands: [],
        notices: {},
        records: {},
      }),
    );
    const value = f.config({ coordinator: { enabled: true } });
    await writeFile(join(f.directory, "config.json"), JSON.stringify(value));
    const running = serve(value, f.directory, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await f.load())?.records).toEqual({});
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("resolves a decision pause by pause id and records the decision note", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const session = "00000000-0000-4000-8000-000000000001";
  const pauseId = "00000000-0000-4000-8000-000000000002";
  try {
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify({
        version: 2,
        running: false,
        checkedAt: new Date().toISOString(),
        pid: process.pid,
        draining: false,
        held: [],
        commands: [],
        notices: {},
        laneRev: { builder: 4 },
        records: {
          "builder:CP-101": {
            key: "builder:CP-101",
            lane: "builder",
            task: "CP-101",
            cwd: f.root,
            harness: "codex",
            sessionId: session,
            status: "paused",
            pauseKind: "decision",
            pauseId,
            reason: "Operator decision needed",
            seen: [],
            runs: [],
            noProgress: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
      }),
    );
    const value = f.config({
      coordinator: { enabled: false },
      builder: { enabled: true, harness: "codex" },
    });
    await writeFile(join(f.directory, "config.json"), JSON.stringify(value));
    await writeFile(
      join(f.directory, "commands/00000000-0000-4000-8000-000000000003.json"),
      JSON.stringify({
        v: 2,
        action: "resolve",
        lane: "builder",
        task: "CP-101",
        pauseId,
        resolution: "approve",
        expectRev: 4,
        text: "Approved with evidence",
        at: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    const running = serve(value, f.directory, controller.signal);
    await until(
      async () =>
        (await f.load())?.records["builder:CP-101"]?.status === "idle",
    );
    const state = await f.load();
    expect(state?.records["builder:CP-101"]?.pauseKind).toBeUndefined();
    expect(state?.notices.builder?.at(-1)).toContain("[task:CP-101]");
    expect(state?.notices.builder?.at(-1)).toContain("Approved");
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
}, 25000);
