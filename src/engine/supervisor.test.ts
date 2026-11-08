import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { snapshot } from "./dashboard.ts";
import {
  type Config,
  command,
  plan,
  type RecordState,
  type State,
  validateConfig,
} from "./supervisor.ts";

const config: Config = {
  version: 1,
  root: process.cwd(),
  binary: process.execPath,
  allowedTasks: ["P1-06", "P1-07"],
  maxParallel: 4,
  intervalSeconds: 10,
  maxRunMinutes: 25,
  maxRunsPerHour: 20,
  confirmedStoppedAt: "2026-11-07T00:00:00Z",
  lanes: {
    coordinator: { enabled: true },
    B: { enabled: true },
    E: { enabled: true },
    reviewer: { enabled: true },
  },
};
const state = (): State => ({
  version: 1,
  running: true,
  checkedAt: "",
  pid: 1,
  draining: false,
  held: [],
  commands: [],
  records: {},
  notices: {},
});
const board = (): Awaited<ReturnType<typeof snapshot>> =>
  ({
    tasks: [
      {
        id: "P1-06",
        live: {
          assignment: {
            owner: "B",
            at: "2026-11-07T00:00:00Z",
            baseCommit: "base",
            text: "scope",
          },
          claim: null,
          status: {
            state: "working",
            at: "2026-11-07T00:00:00Z",
            commit: null,
            text: "work",
          },
          accepted: null,
        },
      },
    ],
    messages: [],
    unanswered: [],
  }) as unknown as Awaited<ReturnType<typeof snapshot>>;
function record(
  key: string,
  lane: "coordinator" | "B" | "reviewer",
): RecordState {
  return {
    key,
    lane,
    task: "P1-06",
    cwd: process.cwd(),
    status: "idle",
    reason: "",
    seen: [],
    runs: [],
    noProgress: 0,
    inputTokens: 0,
    outputTokens: 0,
    finishedAt: new Date(0).toISOString(),
  };
}
it("starts only authorized assigned workers, with coordinator bootstrap and no idle review run", () => {
  const work = plan(board(), state(), config);
  expect(work.map((w) => w.lane)).toEqual(["coordinator", "B"]);
  const off = { ...config, allowedTasks: [] };
  expect(plan(board(), state(), off).map((w) => w.lane)).toEqual([
    "coordinator",
  ]);
});
it("does not overlap running or paused lanes and coalesces new answers for the next turn", () => {
  const b = board();
  const s = state();
  const w = plan(b, s, config).find((w) => w.lane === "B");
  if (!w) throw new Error("Missing fixture work");
  const r = record(w.key, "B");
  r.status = "running";
  r.seen = w.events;
  s.records[w.key] = r;
  b.messages.push({
    id: "answer",
    from: "coordinator",
    to: "B",
    kind: "answer",
    at: "2026-11-07T00:01:00Z",
    text: "approved",
    task: "P1-06",
    replyTo: "question",
  });
  expect(plan(b, s, config).some((w) => w.lane === "B")).toBe(false);
  r.status = "idle";
  expect(plan(b, s, config).find((w) => w.lane === "B")?.events).toContain(
    "message:answer",
  );
  r.status = "paused";
  expect(plan(b, s, config).some((w) => w.lane === "B")).toBe(false);
});
it("keeps ready authors frozen until an actual revision request", () => {
  const b = board();
  const live = b.tasks[0]?.live;
  if (!live?.status) throw new Error("Fixture");
  live.status.state = "ready";
  live.status.commit = "b".repeat(40);
  const s = state();
  expect(plan(b, s, config).some((w) => w.lane === "B")).toBe(false);
  const request = {
    id: "revision",
    assignmentId: live.assignment.at,
    reviewCommit: live.status.commit,
    from: "coordinator",
    to: "B",
    kind: "request",
    task: "P1-06",
    replyTo: null,
    at: "2026-11-07T00:02:00Z",
    text: "targeted revision",
  };
  b.messages.push(request);
  b.unanswered.push(request);
  expect(plan(b, s, config).some((w) => w.lane === "B")).toBe(true);
});
it("creates a fresh reviewer context per pinned request and respects run budgets and held lanes", () => {
  const b = board();
  const source = b.tasks[0]?.live;
  if (!source?.status) throw Error("Fixture");
  source.status.state = "ready";
  source.status.commit = "b".repeat(40);
  const request = {
    reviewCommit: "b".repeat(40),
    id: "review-one",
    from: "coordinator",
    to: "reviewer",
    kind: "request",
    task: "P1-06",
    replyTo: null,
    at: "2026-11-07T00:01:00Z",
    text: "pinned",
  };
  b.messages.push(request);
  b.unanswered.push(request);
  const s = state();
  const first = plan(b, s, config).find((w) => w.lane === "reviewer");
  expect(first?.key).toBe("reviewer:review-one");
  if (!first) throw new Error("Fixture");
  const r = record(first.key, "reviewer");
  r.runs = Array(20).fill(Date.now());
  s.records[first.key] = r;
  expect(plan(b, s, config).some((w) => w.lane === "reviewer")).toBe(false);
  b.unanswered = [];
  expect(plan(b, s, config).some((w) => w.lane === "reviewer")).toBe(false);
  r.runs = [];
  b.unanswered = [{ ...request, id: "review-two" }];
  expect(plan(b, s, config).find((w) => w.lane === "reviewer")?.key).toBe(
    "reviewer:review-two",
  );
  s.held = ["reviewer"];
  expect(plan(b, s, config).some((w) => w.lane === "reviewer")).toBe(false);
});
it("builds explicit-session resume arguments with automatic approval review and no bypass or latest flags", () => {
  const r = record("B:task", "B");
  r.sessionId = "00000000-0000-4000-8000-000000000001";
  const invocation = command(
    config,
    r,
    "/private/schema.json",
    "/private/result.json",
  );
  expect(invocation.args).toContain("--approve-for-me");
  expect(invocation.args).not.toContain("--sandbox"); // approve-for-me already selects workspace-write
  expect(invocation.args.slice(-3)).toEqual(["resume", r.sessionId, "-"]);
  expect(invocation.args).not.toContain("--last");
  expect(invocation.args.some((a) => a.includes("bypass"))).toBe(false);
  expect(() => validateConfig({ ...config, confirmedStoppedAt: "" })).toThrow(
    "Confirm",
  );
  expect(() => validateConfig({ ...config, maxParallel: 99 })).toThrow(
    "maxParallel",
  );
});

it.each(["codex", "pi"] as const)(
  "runs controlled %s, persists its native identity, resumes exactly and drains",
  async (harness) => {
    const { mkdtemp, mkdir, writeFile, readFile, rename, rm } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { serve } = await import("./supervisor.ts");
    const root = await mkdtemp(join(tmpdir(), "relay-headless-test-"));
    const old = process.env.CREWPLANE_COORD_DIR;
    process.env.CREWPLANE_COORD_DIR = "";
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    try {
      await mkdir(join(root, "tasks"), { recursive: true });
      await writeFile(join(root, "STATUS.md"), "Synthetic only");
      await writeFile(
        join(root, ".gitignore"),
        ".crewplane-state/\n.crewplane-local/\n",
      );
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "-q", "--initial-branch=main");
      git("config", "user.name", "Synthetic");
      git("config", "user.email", "synthetic@example.invalid");
      git("add", ".");
      git("commit", "-qm", "test: initialize headless fixture");
      const binary = join(root, "fake-codex.mjs");
      await writeFile(
        binary,
        `#!/usr/bin/env node
import {writeFileSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;
if(!/Crewplane agent (coordinator|reviewer)/.test(input))process.exit(2);
const args=process.argv.slice(2);const out=args[args.indexOf('--output-last-message')+1];
mkdirSync('.crewplane-local',{recursive:true});const file='.crewplane-local/args.json';const history=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];history.push(args);writeFileSync(file,JSON.stringify(history));
console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'PRIVATE_THOUGHT_SENTINEL'}}));
if (${JSON.stringify(harness)} === 'codex') {
writeFileSync(out,JSON.stringify({state:'waiting',summary:'Controlled fixture completed'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}));
} else {
console.log(JSON.stringify({type:'session',id:'00000000-0000-4000-8000-000000000001',cwd:process.cwd()}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',model:'synthetic',provider:'fixture',usage:{input:5,output:2},content:[{type:'text',text:JSON.stringify({state:'waiting',summary:'Controlled fixture completed'})}]}}));
console.log(JSON.stringify({type:'agent_settled',aborted:false}));
}
`,
        { mode: 0o700 },
      );
      const directory = join(root, ".crewplane-state/supervisor");
      const initial: Config = {
        ...config,
        root,
        binary,
        intervalSeconds: 1,
        binaries: { pi: binary },
        allowedTasks: [],
        lanes: {
          reviewer: { enabled: false },
          coordinator: {
            enabled: true,
            ...(harness === "pi"
              ? ({
                  harness: "pi",
                  piPermissions: "no-tools",
                  sessionEpoch: "fixture",
                } as const)
              : {}),
          },
        },
      };
      await mkdir(directory, { recursive: true });
      const replaceConfig = async (value: unknown) => {
        const temporary = join(directory, "candidate.json");
        await writeFile(temporary, JSON.stringify(value));
        await rename(temporary, join(directory, "config.json"));
      };
      await replaceConfig(initial);
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./agents.mjs", import.meta.url)),
          "send",
          "--agent",
          "coordinator",
          "--to",
          "reviewer",
          "--kind",
          "request",
          "--task",
          "P1-06",
          "--text",
          "Synthetic pinned review",
          "--commit",
          "HEAD",
        ],
        { cwd: root, stdio: "pipe" },
      );
      const { snapshot: readSnapshot } = await import("./read-model.ts");
      const pinned = git("rev-parse", "HEAD").toString().trim();
      running = serve(initial, directory, controller.signal, {
        readBoard: async (root) => {
          const actual = await readSnapshot(root);
          const synthetic = board().tasks[0];
          if (!synthetic?.live?.status) throw Error("Fixture");
          synthetic.live.status.state = "ready";
          synthetic.live.status.commit = pinned;
          actual.tasks.push(synthetic);
          return actual;
        },
      });
      const until = async (check: () => Promise<boolean>) => {
        const deadline = Date.now() + 7000;
        while (!(await check())) {
          if (Date.now() > deadline)
            throw new Error("Controlled supervisor transition timed out");
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      const load = async () =>
        JSON.parse(
          await readFile(join(directory, "state.json"), "utf8"),
        ) as State;
      await until(async () => {
        try {
          return Object.values((await load()).records).some(
            (r) => r.finishedAt,
          );
        } catch {
          return false;
        }
      });
      let first = Object.values((await load()).records)[0];
      expect(first?.sessionId).toBe("00000000-0000-4000-8000-000000000001");
      expect(first?.inputTokens).toBe(5);
      const traceDirectory = join(root, ".crewplane-state/operational-traces");
      const traceText = await readFile(
        join(traceDirectory, `${first?.runId}.events.jsonl`),
        "utf8",
      );
      expect(traceText).not.toContain("PRIVATE_THOUGHT_SENTINEL");
      expect(traceText).toContain('"kind":"started"');
      expect(traceText).toContain('"kind":"finished"');
      await writeFile(
        join(directory, "commands/00000000-0000-4000-8000-000000000002.json"),
        JSON.stringify({
          action: "nudge",
          lane: "coordinator",
          at: new Date().toISOString(),
          text: "Synthetic follow-up",
        }),
      );
      await until(async () => {
        first = Object.values((await load()).records)[0];
        return (first?.runs.length ?? 0) === 2 && first?.status !== "running";
      });
      const args = JSON.parse(
        await readFile(join(root, ".crewplane-local/args.json"), "utf8"),
      );
      expect(first?.harness).toBe(harness);
      if (harness === "codex")
        expect(args[1].slice(-3)).toEqual([
          "resume",
          "00000000-0000-4000-8000-000000000001",
          "-",
        ]);
      else
        expect(args[1].slice(-2)).toEqual([
          "--session",
          "00000000-0000-4000-8000-000000000001",
        ]);
      const before = await load();
      expect(
        Object.values(before.records).some((r) => r.lane === "reviewer"),
      ).toBe(false);
      const enabled: Config = {
        ...initial,
        allowedTasks: ["P1-06"],
        lanes: { ...initial.lanes, reviewer: { enabled: true } },
      };
      await replaceConfig(enabled);
      await until(async () =>
        Object.values((await load()).records).some(
          (r) => r.lane === "reviewer" && !!r.finishedAt,
        ),
      );
      expect((await load()).pid).toBe(before.pid);
      expect((await load()).scheduling?.allowedTasks).toEqual(["P1-06"]);
      await replaceConfig({ version: "invalid" });
      await until(
        async () => (await load()).configReload?.errorCode === "INVALID_CONFIG",
      );
      expect((await load()).scheduling?.allowedTasks).toEqual(["P1-06"]);
      await replaceConfig({ ...enabled, maxParallel: 3, allowedTasks: [] });
      await until(
        async () =>
          (await load()).configReload?.errorCode === "RESTART_REQUIRED",
      );
      expect((await load()).scheduling?.maxParallel).toBe(4);
      expect((await load()).scheduling?.allowedTasks).toEqual(["P1-06"]);
      expect(
        JSON.parse(await readFile(join(directory, "desired.json"), "utf8"))
          .desiredRunning,
      ).toBe(true);
      if (harness === "codex") {
        await writeFile(
          join(directory, "commands/00000000-0000-4000-8000-000000000003.json"),
          JSON.stringify({ action: "rollout", at: new Date().toISOString() }),
        );
      } else controller.abort();
      await running;
      expect(
        JSON.parse(await readFile(join(directory, "desired.json"), "utf8"))
          .desiredRunning,
      ).toBe(harness === "codex");
      expect((await load()).running).toBe(false);
    } finally {
      controller.abort();
      if (running) await running;
      if (old === undefined) delete process.env.CREWPLANE_COORD_DIR;
      else process.env.CREWPLANE_COORD_DIR = old;
      await rm(root, { recursive: true, force: true });
    }
  },
  22000,
);

it("schedules visual only for pinned coordinator requests, separately from reviewer within existing limits", () => {
  const cfg: Config = {
    ...config,
    lanes: { ...config.lanes, visual: { enabled: true } },
  };
  expect(validateConfig(cfg)).toBe(cfg);
  expect(() => validateConfig({ ...cfg, maxParallel: 5 })).toThrow();
  const b = board();
  const s = state();
  expect(plan(b, s, cfg).some((w) => w.lane === "visual")).toBe(false);
  const source = b.tasks[0]?.live;
  if (!source?.status) throw Error("Fixture");
  source.status.state = "ready";
  source.status.commit = "b".repeat(40);
  const request = {
    reviewCommit: "b".repeat(40),
    id: "visual-one",
    from: "coordinator",
    to: "visual",
    kind: "request",
    task: "P1-06",
    replyTo: null,
    at: "2026-11-07T00:00:00Z",
    text: "Exact synthetic commit/route brief",
  };
  b.messages.push(request);
  b.unanswered.push(request);
  expect(plan(b, s, cfg).find((w) => w.lane === "visual")?.key).toBe(
    "visual:visual-one",
  );
  expect(plan(b, s, cfg).some((w) => w.lane === "reviewer")).toBe(false);
  const codeRequest = { ...request, id: "code-one", to: "reviewer" };
  b.messages.push(codeRequest);
  b.unanswered.push(codeRequest);
  const parallel = plan(b, s, cfg).map((w) => w.lane);
  expect(parallel).toContain("reviewer");
  expect(parallel).toContain("visual");
  expect(parallel.indexOf("B")).toBeLessThan(parallel.indexOf("visual"));
  s.held = ["visual"];
  expect(plan(b, s, cfg).some((w) => w.lane === "visual")).toBe(false);
  s.held = [];
  const r: RecordState = {
    ...record("visual:visual-one", "reviewer"),
    lane: "visual",
    status: "running",
  };
  s.records[r.key] = r;
  expect(plan(b, s, cfg).some((w) => w.lane === "visual")).toBe(false);
  r.status = "idle";
  r.runs = Array(20).fill(Date.now());
  expect(plan(b, s, cfg).some((w) => w.lane === "visual")).toBe(false);
  r.runs = [];
  b.unanswered = [{ ...request, id: "visual-two" }];
  expect(plan(b, s, cfg).find((w) => w.lane === "visual")?.key).toBe(
    "visual:visual-two",
  );
  expect(
    plan(b, s, { ...cfg, allowedTasks: [] }).some((w) => w.lane === "visual"),
  ).toBe(false);
});

it("waits without repeat wake, wakes for fresh answer, preserves failure pause and holds", () => {
  const b = board();
  const s = state();
  const w = plan(b, s, config).find((item) => item.lane === "B");
  if (!w) throw Error("Missing fixture");
  const r = record(w.key, "B");
  r.waitingForEvent = true;
  r.seen = w.events;
  s.records[r.key] = r;
  expect(plan(b, s, config).some((item) => item.lane === "B")).toBe(false);
  b.messages.push({
    id: "fresh-answer",
    from: "coordinator",
    to: "B",
    kind: "answer",
    task: "P1-06",
    replyTo: "question",
    at: "2026-11-07T00:02:00Z",
    text: "Synthetic resolution",
  });
  expect(plan(b, s, config).some((item) => item.lane === "B")).toBe(true);
  r.seen.push("message:fresh-answer");
  expect(plan(b, s, config).some((item) => item.lane === "B")).toBe(false);
  r.seen = w.events;
  r.status = "paused";
  expect(plan(b, s, config).some((item) => item.lane === "B")).toBe(false);
  r.status = "idle";
  s.held = ["B"];
  expect(plan(b, s, config).some((item) => item.lane === "B")).toBe(false);
});
