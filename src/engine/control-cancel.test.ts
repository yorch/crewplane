import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Config } from "../contracts.ts";
import { serve } from "./supervisor.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewplane-cancel-"));
  await writeFile(join(root, ".gitignore"), ".crewplane-state/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: cancel fixture");
  const binary = join(root, "ignore-term.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
process.on("SIGTERM", () => {});
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({type:"thread.started",thread_id:"00000000-0000-4000-8000-000000000001"}));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 60000);
`,
    { mode: 0o700 },
  );
  const directory = join(root, ".crewplane-state/supervisor");
  await mkdir(join(directory, "commands"), { recursive: true });
  const config: Config = {
    version: 1,
    root,
    binary,
    allowedTasks: [],
    maxParallel: 4,
    intervalSeconds: 1,
    maxRunMinutes: 1,
    maxRunsPerHour: 20,
    confirmedStoppedAt: new Date().toISOString(),
    lanes: { coordinator: { enabled: true } },
  };
  await writeFile(join(directory, "config.json"), JSON.stringify(config));
  const load = async () => {
    try {
      return JSON.parse(
        await readFile(join(directory, "state.json"), "utf8"),
      ) as {
        running: boolean;
        records: Record<
          string,
          {
            status: string;
            runId?: string;
            pid?: number;
            finishedAt?: string;
            cancelRequested?: boolean;
          }
        >;
      };
    } catch {
      return undefined;
    }
  };
  return { root, directory, config, load };
}
const until = async (check: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
it("cancels a SIGTERM-ignoring run and preserves the lane", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const running = serve(f.config, f.directory, controller.signal);
    await until(
      async () =>
        Object.values((await f.load())?.records ?? {}).some(
          (record) => record.status === "running" && record.runId,
        ),
      "run never started",
    );
    const record = Object.values((await f.load())?.records ?? {})[0];
    await writeFile(
      join(f.directory, "commands/00000000-0000-4000-8000-000000000010.json"),
      JSON.stringify({
        v: 2,
        action: "cancel",
        lane: "coordinator",
        run: record?.runId,
        at: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    await until(
      async () =>
        Object.values((await f.load())?.records ?? {}).some(
          (item) => item.status === "paused" && item.finishedAt,
        ),
      "cancel did not settle the run",
    );
    const settled = Object.values((await f.load())?.records ?? {})[0];
    expect(settled?.cancelRequested).toBeUndefined();
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30000);
it("stop --cancel-active drains and terminates a live run", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const running = serve(f.config, f.directory, controller.signal);
    await until(
      async () =>
        Object.values((await f.load())?.records ?? {}).some(
          (record) => record.status === "running",
        ),
      "run never started",
    );
    await writeFile(
      join(f.directory, "commands/00000000-0000-4000-8000-000000000011.json"),
      JSON.stringify({
        v: 2,
        action: "stop",
        cancelActive: true,
        at: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    await running;
    expect((await f.load())?.running).toBe(false);
    await until(
      async () =>
        Object.values((await f.load())?.records ?? {}).every(
          (record) => !record.pid,
        ),
      "child identity retained after hard stop",
    );
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30000);
