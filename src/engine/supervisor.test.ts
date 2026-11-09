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

it("rejects a retained native session when a disabled lane switches harness without a fresh epoch", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serve } = await import("./supervisor.ts");
  const root = await mkdtemp(join(tmpdir(), "relay-switch-"));
  try {
    const directory = join(root, ".crewplane-state/supervisor");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        version: 1,
        running: false,
        checkedAt: new Date().toISOString(),
        pid: process.pid,
        draining: false,
        held: [],
        commands: [],
        notices: {},
        records: {
          coordinator: {
            key: "coordinator",
            lane: "coordinator",
            task: null,
            cwd: root,
            harness: "codex",
            sessionId: "00000000-0000-4000-8000-000000000001",
            status: "idle",
            reason: "",
            seen: [],
            runs: [],
            noProgress: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
      }),
    );
    const switched: Config = {
      ...config,
      root,
      binaries: { claude: process.execPath },
      allowedTasks: [],
      intervalSeconds: 1,
      lanes: {
        coordinator: {
          enabled: false,
          harness: "claude",
          model: "opus",
          claudePermissionMode: "plan",
          claudeMcp: "strict",
          claudeSettingSources: ["project"],
        },
      },
    };
    await expect(
      serve(switched, directory, new AbortController().signal),
    ).rejects.toThrow("drained idle lane");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
it.each(["codex", "claude", "opencode"] as const)(
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
const harness=${JSON.stringify(harness)};
const args=process.argv.slice(2);const out=args[args.indexOf('--output-last-message')+1];
if (harness === 'pi') {const dir=args[args.indexOf('--session-dir')+1];if(dir!==${JSON.stringify(join(root, ".crewplane-state/supervisor/pi-sessions"))}||!existsSync(dir))process.exit(9);}
if (harness === 'pi' || harness === 'opencode') {if(!input.includes('Return ONLY a JSON object'))process.exit(7);}
mkdirSync('.crewplane-local',{recursive:true});const file='.crewplane-local/args.json';const history=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];history.push(args);writeFileSync(file,JSON.stringify(history));
const result={state:'waiting',summary:'Controlled fixture completed'};
const uuid='00000000-0000-4000-8000-000000000001';
if (harness === 'codex') {
console.log(JSON.stringify({type:'thread.started',thread_id:uuid}));
console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'PRIVATE_THOUGHT_SENTINEL'}}));
writeFileSync(out,JSON.stringify(result));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}));
} else if (harness === 'pi') {
console.log(JSON.stringify({type:'session',id:uuid,cwd:process.cwd()}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',model:'synthetic',provider:'fixture',usage:{input:5,output:2},content:[{type:'thinking',thinking:'PRIVATE_THOUGHT_SENTINEL'},{type:'text',text:JSON.stringify(result)}]}}));
console.log(JSON.stringify({type:'agent_settled',aborted:false}));
} else if (harness === 'claude') {
if(args[args.indexOf('--permission-mode')+1]!=='acceptEdits')process.exit(6);
if(typeof JSON.parse(args[args.indexOf('--json-schema')+1])!=='object')process.exit(5);
const fresh=args.includes('--session-id')?args[args.indexOf('--session-id')+1]:undefined;
const resume=args.includes('--resume')?args[args.indexOf('--resume')+1]:undefined;
const sid=fresh||resume;
if(!/^[a-f0-9-]{36}$/.test(sid))process.exit(8);
console.log(JSON.stringify({type:'system',subtype:'init',session_id:sid,cwd:process.cwd(),model:'claude-opus-5-5'}));
console.log(JSON.stringify({type:'assistant',message:{model:'claude-opus-5-5',content:[{type:'thinking',thinking:'PRIVATE_THOUGHT_SENTINEL'},{type:'text',text:'ignored'}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:sid,usage:{input_tokens:5,output_tokens:2},structured_output:result}));
} else {
const session=args.includes('--session')?args[args.indexOf('--session')+1]:'ses_fixture00000000000000000000';
if(!/^ses_[A-Za-z0-9]+$/.test(session))process.exit(4);
console.log(JSON.stringify({type:'step_start',sessionID:session,part:{type:'step-start'}}));
console.log(JSON.stringify({type:'tool_use',sessionID:session,part:{tool:'shell',state:{status:'completed',input:{command:'echo PRIVATE_THOUGHT_SENTINEL'},output:'PRIVATE_THOUGHT_SENTINEL'}}}));
console.log(JSON.stringify({type:'text',sessionID:session,part:{type:'text',text:JSON.stringify(result)}}));
console.log(JSON.stringify({type:'step_finish',sessionID:session,part:{type:'step-finish',reason:'stop',tokens:{input:5,output:2}}}));
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
        binaries: { pi: binary, claude: binary, opencode: binary },
        allowedTasks: [],
        lanes: {
          reviewer: { enabled: false },
          coordinator: {
            enabled: true,
            ...(harness === "claude"
              ? {
                  harness: "claude" as const,
                  model: "opus",
                  claudePermissionMode: "acceptEdits" as const,
                  claudeMcp: "strict" as const,
                  claudeSettingSources: ["project"] as (
                    | "user"
                    | "project"
                    | "local"
                  )[],
                }
              : harness === "opencode"
                ? { harness: "opencode" as const, model: "fixture/model" }
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
          const record = Object.values((await load()).records).find(
            (r) => r.finishedAt && r.status !== "running",
          );
          if (!record?.runId) return false;
          const trace = JSON.parse(
            await readFile(
              join(
                root,
                ".crewplane-state/operational-traces",
                `${record.runId}.meta.json`,
              ),
              "utf8",
            ),
          );
          return trace.status === "finished";
        } catch {
          return false;
        }
      });
      let first = Object.values((await load()).records)[0];
      const nativeSession = first?.sessionId;
      if (harness === "claude")
        expect(nativeSession).toMatch(/^[a-f0-9-]{36}$/);
      else
        expect(nativeSession).toBe(
          harness === "opencode"
            ? "ses_fixture00000000000000000000"
            : "00000000-0000-4000-8000-000000000001",
        );
      expect(first?.inputTokens).toBe(5);
      expect(first?.observedModel).toBe(
        harness === "claude" ? "claude-opus-5-5" : undefined,
      );
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
      else if (harness === "claude") {
        expect(args[1].slice(-2)).toEqual(["--resume", nativeSession]);
        expect(args[1]).not.toContain("--session-id");
        expect(args[1]).not.toContain("--dangerously-skip-permissions");
      } else expect(args[1].slice(-2)).toEqual(["--session", nativeSession]);
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

it.each([
  ["claude", "session-mismatch"],
  ["claude", "malformed"],
  ["opencode", "malformed"],
] as const)(
  "fails closed and pauses when %s emits %s native output",
  async (harness, mode) => {
    const { mkdtemp, mkdir, readFile, rm, writeFile } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { serve } = await import("./supervisor.ts");
    const root = await mkdtemp(join(tmpdir(), "relay-strict-"));
    const old = process.env.CREWPLANE_COORD_DIR;
    process.env.CREWPLANE_COORD_DIR = "";
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    try {
      await mkdir(join(root, "tasks"), { recursive: true });
      await writeFile(join(root, "STATUS.md"), "Synthetic strict fixture");
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
      git("commit", "-qm", "test: initialize strict fixture");
      const binary = join(root, "fake-strict.mjs");
      await writeFile(
        binary,
        `#!/usr/bin/env node
let input='';for await(const chunk of process.stdin)input+=chunk;
const harness=${JSON.stringify(harness)},mode=${JSON.stringify(mode)};
const args=process.argv.slice(2);
const result={state:'waiting',summary:'Synthetic strict fixture'};
if (harness === 'claude') {
  const expected=args.includes('--session-id')?args[args.indexOf('--session-id')+1]:args[args.indexOf('--resume')+1];
  const sid=mode === 'session-mismatch' ? '00000000-0000-4000-8000-000000000002' : expected;
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:sid,cwd:process.cwd(),model:'claude-opus-5-5'}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:sid,usage:{input_tokens:5,output_tokens:2},structured_output:result}));
} else {
  const session='ses_00000000000000000000000000';
  console.log(JSON.stringify({type:'step_start',sessionID:session}));
  console.log(JSON.stringify({type:'text',sessionID:session,part:{type:'text',text:JSON.stringify(result)}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:session,part:{reason:'stop',tokens:{input:5,output:2}}}));
}
if (mode === 'malformed') process.stdout.write('{"type":"broken');
`,
        { mode: 0o700 },
      );
      const directory = join(root, ".crewplane-state/supervisor");
      const lane =
        harness === "claude"
          ? {
              enabled: true,
              harness: "claude" as const,
              model: "opus",
              claudePermissionMode: "acceptEdits" as const,
              claudeMcp: "strict" as const,
              claudeSettingSources: ["project"] as (
                | "user"
                | "project"
                | "local"
              )[],
            }
          : {
              enabled: true,
              harness: "opencode" as const,
              model: "fixture/model",
            };
      const strict: Config = {
        ...config,
        root,
        binary,
        intervalSeconds: 1,
        binaries: { [harness]: binary },
        allowedTasks: [],
        lanes: { coordinator: lane },
      };
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "config.json"), JSON.stringify(strict));
      running = serve(strict, directory, controller.signal);
      const load = async (): Promise<State | undefined> => {
        try {
          return JSON.parse(
            await readFile(join(directory, "state.json"), "utf8"),
          ) as State;
        } catch {
          return undefined;
        }
      };
      const until = async (check: () => Promise<boolean>) => {
        const deadline = Date.now() + 7000;
        while (!(await check())) {
          if (Date.now() > deadline)
            throw new Error("Strict fixture timed out");
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      await until(async () => {
        const record = Object.values((await load())?.records ?? {})[0];
        return !!record?.finishedAt && record.status !== "running";
      });
      const record = Object.values((await load())?.records ?? {})[0];
      expect(record?.status).toBe("paused");
      expect(record?.finalState).toBeUndefined();
      expect(record?.reason).toContain("No valid final result");
      expect(record?.inputTokens).toBe(mode === "malformed" ? 5 : 0);
      expect(!!record?.sessionId).toBe(mode === "malformed");
      if (record?.runId) {
        const trace = JSON.parse(
          await readFile(
            join(
              root,
              ".crewplane-state/operational-traces",
              `${record.runId}.meta.json`,
            ),
            "utf8",
          ),
        );
        expect(trace.status).toBe("paused");
      }
    } finally {
      controller.abort();
      if (running) await running;
      if (old === undefined) delete process.env.CREWPLANE_COORD_DIR;
      else process.env.CREWPLANE_COORD_DIR = old;
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
it("rejects no-tools lanes outside review, loose budgets and unknown lane fields", () => {
  const base = {
    ...config,
    root: process.cwd(),
    binaries: { pi: process.execPath },
    lanes: { coordinator: { enabled: true } },
  };
  expect(() =>
    validateConfig({
      ...base,
      lanes: {
        coordinator: {
          enabled: true,
          harness: "pi",
          piPermissions: "no-tools",
          piModel: { provider: "synthetic", id: "local" },
          sessionEpoch: "pi",
        },
      },
    }),
  ).toThrow("reviewer lanes");
  expect(() =>
    validateConfig({
      ...base,
      lanes: {
        coordinator: { enabled: true },
        builder: {
          enabled: true,
          harness: "pi",
          piPermissions: "no-tools",
          piModel: { provider: "synthetic", id: "local" },
          sessionEpoch: "pi",
        },
      },
    }),
  ).toThrow("reviewer lanes");
  expect(() =>
    validateConfig({
      ...base,
      lanes: { coordinator: { enabled: true, bogusField: true } as never },
    }),
  ).toThrow("Unknown lane field");
  expect(() =>
    validateConfig({
      ...base,
      lanes: { coordinator: { enabled: true, maxRunsPerHour: 21 } },
    }),
  ).toThrow("must not exceed");
  expect(() =>
    validateConfig({
      ...base,
      lanes: { coordinator: { enabled: true, maxRunMinutes: 26 } },
    }),
  ).toThrow("must not exceed");
});
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

it("applies or refuses an audited new-session reset atomically", async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { serve } = await import("./supervisor.ts");
  const root = await mkdtemp(join(tmpdir(), "relay-reset-"));
  try {
    await writeFile(join(root, ".gitignore"), ".crewplane-state/\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "synthetic@example.invalid");
    git("add", ".");
    git("commit", "-qm", "test: reset fixture");
    const directory = join(root, ".crewplane-state/supervisor");
    await mkdir(directory, { recursive: true });
    const session = "00000000-0000-4000-8000-000000000001";
    const base = {
      version: 1,
      checkedAt: new Date().toISOString(),
      pid: process.pid,
      draining: false,
      commands: [],
      notices: {},
      records: {
        "builder:CP-101": {
          key: "builder:CP-101",
          lane: "builder",
          task: "CP-101",
          cwd: root,
          harness: "codex",
          sessionId: session,
          status: "paused",
          pauseKind: "failure",
          reason: "Synthetic failure",
          seen: [],
          runs: [],
          noProgress: 1,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
    };
    const writeConfig = async () => {
      const value: Config = {
        ...config,
        root,
        binary: process.execPath,
        allowedTasks: [],
        intervalSeconds: 1,
        lanes: {
          coordinator: { enabled: false },
          builder: { enabled: true, harness: "codex" },
        },
      };
      await writeFile(join(directory, "config.json"), JSON.stringify(value));
      return value;
    };
    const writeState = async (held: string[] = []) =>
      writeFile(
        join(directory, "state.json"),
        JSON.stringify({ ...base, running: false, held }),
      );
    const writeCommand = async () =>
      writeFile(
        join(directory, "commands/00000000-0000-4000-8000-000000000201.json"),
        JSON.stringify({
          action: "retry",
          lane: "builder",
          task: "CP-101",
          newSession: true,
          text: "Reset after inspected transcript",
          at: new Date(Date.now() + 60000).toISOString(),
        }),
      );
    const load = async () =>
      JSON.parse(
        await readFile(join(directory, "state.json"), "utf8"),
      ) as State;
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 7000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("Reset fixture timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    await writeState();
    const applied = await writeConfig();
    await mkdir(join(directory, "commands"), { recursive: true });
    await writeCommand();
    const controller = new AbortController();
    const running = serve(applied, directory, controller.signal);
    await until(async () => !!(await load()).controlOutcome?.builder);
    const state = await load();
    expect(state.controlOutcome?.builder).toMatchObject({
      outcome: "applied",
      action: "retry",
      reason: "NEW_SESSION",
    });
    expect(state.records["builder:CP-101"]?.sessionId).toBeUndefined();
    expect(
      state.records["builder:CP-101"]?.lastSessionReset?.previousSessionId,
    ).toBe(session);
    expect(state.notices.builder?.at(-1)).toContain("inspected transcript");
    controller.abort();
    await running;

    await writeState(["builder"]);
    const refusedConfig = await writeConfig();
    await writeCommand();
    const second = new AbortController();
    const secondRun = serve(refusedConfig, directory, second.signal);
    await until(
      async () => (await load()).controlOutcome?.builder?.outcome === "refused",
    );
    const refused = await load();
    expect(refused.controlOutcome?.builder?.reason).toBe("HELD");
    expect(refused.records["builder:CP-101"]?.sessionId).toBe(session);
    expect(refused.notices.builder).toBeUndefined();
    second.abort();
    await secondRun;
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, 25000);

it("runs a no-tools reviewer as a bounded advisory turn that cannot relaunch", async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { serve } = await import("./supervisor.ts");
  const root = await mkdtemp(join(tmpdir(), "relay-advisory-"));
  const old = process.env.CREWPLANE_COORD_DIR;
  process.env.CREWPLANE_COORD_DIR = "";
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
    await mkdir(join(root, "tasks"), { recursive: true });
    await writeFile(join(root, "tasks/T1.md"), "# T1\nOwner: builder.\n");
    await writeFile(join(root, ".gitignore"), ".crewplane-state/\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "synthetic@example.invalid");
    git("add", ".");
    git("commit", "-qm", "test: advisory fixture");
    const base = git("rev-parse", "HEAD").toString().trim();
    const cli = fileURLToPath(new URL("./agents.mjs", import.meta.url));
    const agents = (...args: string[]) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd: root,
        stdio: "pipe",
      });
    agents(
      "assign",
      "--agent",
      "coordinator",
      "--task",
      "T1",
      "--owner",
      "builder",
      "--ref",
      base,
      "--text",
      "Synthetic assignment",
    );
    agents(
      "send",
      "--agent",
      "coordinator",
      "--to",
      "reviewer",
      "--kind",
      "request",
      "--task",
      "T1",
      "--commit",
      base,
      "--text",
      "Synthetic pinned review",
    );
    const binary = join(root, "fake-pi.mjs");
    await writeFile(
      binary,
      `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;
if(!input.includes('You have no tools'))process.exit(3);
if(!input.includes('Committed task card (JSON-encoded data'))process.exit(4);
const args=process.argv.slice(2);
const dir=args[args.indexOf('--session-dir')+1];
if(!dir)process.exit(5);
writeFileSync('.advisory-input',input);
console.log(JSON.stringify({type:'session',id:'00000000-0000-4000-8000-000000000001',cwd:process.cwd()}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',model:'synthetic',provider:'fixture',usage:{input:1,output:1},content:[{type:'text',text:JSON.stringify({state:'ready',summary:'Advisory findings recorded'})}]}}));
console.log(JSON.stringify({type:'agent_settled',aborted:false}));
`,
      { mode: 0o700 },
    );
    const directory = join(root, ".crewplane-state/supervisor");
    const value: Config = {
      ...config,
      root,
      binary: process.execPath,
      binaries: { pi: binary },
      allowedTasks: ["T1"],
      intervalSeconds: 1,
      lanes: {
        coordinator: { enabled: false },
        reviewer: {
          enabled: true,
          harness: "pi",
          piPermissions: "no-tools",
          piModel: { provider: "synthetic", id: "local" },
          sessionEpoch: "pi-advisory",
        },
      },
    };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.json"), JSON.stringify(value));
    const { snapshot: readSnapshot } = await import("./read-model.ts");
    running = serve(value, directory, controller.signal, {
      readBoard: async (projectRoot) => {
        const actual = await readSnapshot(projectRoot);
        const task = actual.tasks.find((candidate) => candidate.id === "T1");
        if (task?.live) {
          task.live.status = {
            state: "ready",
            at: new Date().toISOString(),
            commit: base,
            text: "Synthetic ready submission",
          };
        }
        return actual;
      },
    });
    const load = async (): Promise<State | undefined> => {
      try {
        return JSON.parse(
          await readFile(join(directory, "state.json"), "utf8"),
        ) as State;
      } catch {
        return undefined;
      }
    };
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 7000;
      while (!(await check())) {
        if (Date.now() > deadline)
          throw new Error("Advisory fixture timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    await until(async () =>
      Object.values((await load())?.records ?? {}).some(
        (r) => r.lane === "reviewer" && r.status === "paused",
      ),
    );
    const record = Object.values((await load())?.records ?? {}).find(
      (r) => r.lane === "reviewer",
    );
    expect(record?.pauseKind).toBe("decision");
    expect(record?.reason).toContain("Advisory output recorded");
    expect(record?.summary).toBe("Advisory findings recorded");
    expect(record?.sessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(record?.seenMessagesThrough).toBeTruthy();
    const input = await readFile(
      join(root, ".crewplane-local/headless/control/reviewer/.advisory-input"),
      "utf8",
    );
    expect(input).not.toContain("agents inbox/brief");
    expect(input).toContain("JSON-encoded data");
    const recordKey = record?.key ?? "";
    const before = (await load())?.records[recordKey]?.runs.length ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await load())?.records[recordKey]?.runs.length ?? 0).toBe(before);
  } finally {
    controller.abort();
    if (running) await running;
    if (old === undefined) delete process.env.CREWPLANE_COORD_DIR;
    else process.env.CREWPLANE_COORD_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
