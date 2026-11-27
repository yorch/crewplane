import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Config, State } from "../contracts.ts";
import { controlDirectory } from "../control.ts";
import { serve } from "./supervisor.ts";

/**
 * The lane revision is the pin every widening control carries: any transition
 * that creates or changes a record's status or pause kind must move it, so a
 * lane-wide retry pinned before the transition is answered stale.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewplane-rev-"));
  await writeFile(join(root, ".gitignore"), ".crewplane-state/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: revision fixture");
  const directory = controlDirectory(root);
  await mkdir(join(directory, "commands"), { recursive: true, mode: 0o700 });
  const load = async () => {
    try {
      return JSON.parse(
        await readFile(join(directory, "state.json"), "utf8"),
      ) as State;
    } catch {
      return undefined;
    }
  };
  const config: Config = {
    version: 1,
    root,
    binary: process.execPath,
    allowedTasks: [],
    maxParallel: 2,
    intervalSeconds: 1,
    maxRunMinutes: 1,
    maxRunsPerHour: 20,
    confirmedStoppedAt: new Date().toISOString(),
    lanes: { coordinator: { enabled: false }, builder: { enabled: true } },
  } as unknown as Config;
  return { root, directory, load, config };
}
const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 9000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Revision fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const record = (cwd: string, extra: object) => ({
  key: "builder:CP-101",
  lane: "builder",
  task: "CP-101",
  cwd,
  harness: "codex",
  status: "paused",
  reason: "x",
  seen: [],
  runs: [],
  noProgress: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...extra,
});
const baseState = (extra: object) => ({
  version: 2,
  running: false,
  checkedAt: new Date().toISOString(),
  pid: process.pid,
  draining: false,
  held: [],
  commands: [],
  notices: {},
  laneRev: { builder: 4 },
  ...extra,
});

it("a retry pinned before startup recovery created a paused failure is stale", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  try {
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify(
        baseState({
          // Left "running" without a child identity by an earlier supervisor.
          records: { "builder:CP-101": record(f.root, { status: "running" }) },
        }),
      ),
    );
    await writeFile(join(f.directory, "config.json"), JSON.stringify(f.config));
    // The operator pinned revision 4, which they saw before the restart.
    await writeFile(
      join(f.directory, "commands", `${id}.json`),
      JSON.stringify({
        v: 2,
        action: "retry",
        lane: "builder",
        expectRev: 4,
        issuer: "dashboard",
        at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const running = serve(f.config, f.directory, controller.signal);
    await until(async () =>
      ((await f.load())?.controlLog ?? []).some((e) => e.id === id),
    );
    const state = (await f.load()) as State;
    expect(state.controlLog?.find((e) => e.id === id)).toMatchObject({
      outcome: "stale",
      code: "STALE_REVISION",
    });
    expect(state.records["builder:CP-101"]).toMatchObject({
      status: "paused",
      pauseKind: "failure",
    });
    expect(state.laneRev?.builder).toBeGreaterThan(4);
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("a pinned retry applies when nothing changed after the pin", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  try {
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify(
        baseState({
          records: {
            "builder:CP-101": record(f.root, { pauseKind: "failure" }),
          },
        }),
      ),
    );
    await writeFile(join(f.directory, "config.json"), JSON.stringify(f.config));
    await writeFile(
      join(f.directory, "commands", `${id}.json`),
      JSON.stringify({
        v: 2,
        action: "retry",
        lane: "builder",
        expectRev: 4,
        issuer: "dashboard",
        at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const running = serve(f.config, f.directory, controller.signal);
    await until(async () =>
      ((await f.load())?.controlLog ?? []).some((e) => e.id === id),
    );
    expect(
      ((await f.load()) as State).controlLog?.find((e) => e.id === id),
    ).toMatchObject({ outcome: "applied", code: "RETRY" });
    controller.abort();
    await running;
  } finally {
    controller.abort();
    await rm(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("never assigns a record's status or pause kind outside the one revision-bumping helper", async () => {
  const source = await readFile(
    new URL("./supervisor.ts", import.meta.url),
    "utf8",
  );
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.includes("const transition = "));
  expect(start, "the transition helper exists").toBeGreaterThan(-1);
  // The helper body ends at the first line that closes it at the same indent.
  const indent = (lines[start] as string).match(/^\s*/)?.[0] ?? "";
  let end = start + 1;
  while (end < lines.length && lines[end] !== `${indent}};`) end++;
  const offenders = lines
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(
      ({ text, line }) =>
        (line <= start + 1 || line > end + 1) &&
        (/\.(status|pauseKind)\s*=[^=]/.test(text) ||
          /delete\s+\S*\.pauseKind/.test(text) ||
          /\bstatus:\s*"(paused|running)"/.test(text) ||
          /\bpauseKind:\s*"/.test(text)),
    );
  expect(offenders, "route these through transition()").toEqual([]);
});
