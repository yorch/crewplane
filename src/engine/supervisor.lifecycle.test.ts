import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { snapshot } from "./dashboard.ts";
import { type Config, type State, serve } from "./supervisor.ts";

const initialState = (): State => ({
  version: 1,
  running: false,
  checkedAt: new Date().toISOString(),
  pid: process.pid,
  draining: false,
  held: [],
  commands: [],
  records: {},
  notices: {},
});
async function fixture(mode = "ready") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-audit-")));
  const directory = join(root, ".crewplane-state/supervisor");
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, "tasks"), { recursive: true });
  await writeFile(join(root, "STATUS.md"), "Synthetic audit fixture");
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
  git("commit", "-qm", "test: initialize audit fixture");
  const binary = join(root, "fake.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
for await(const chunk of process.stdin){}
const args=process.argv.slice(2),out=args[args.indexOf('--output-last-message')+1];
console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));
writeFileSync(out,${JSON.stringify(mode === "malformed" ? "PRIVATE_SECRET_SENTINEL" : JSON.stringify({ state: mode, summary: "Synthetic fixture completed" }))});
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
    { mode: 0o700 },
  );
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
  const load = async () =>
    JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as State;
  const command = async (
    action: string,
    lane = "coordinator",
    text = "Synthetic operator note",
  ) => {
    await mkdir(join(directory, "commands"), { recursive: true });
    await writeFile(
      join(
        directory,
        `commands/00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}.json`,
      ),
      JSON.stringify({
        action,
        lane,
        text,
        at: new Date().toISOString(),
      }),
    );
  };
  return { root, directory, config, load, command };
}
let sequence = 0;
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > end) throw Error("Audit fixture timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function withEnv(run: () => Promise<void>) {
  const old = process.env.CREWPLANE_COORD_DIR;
  delete process.env.CREWPLANE_COORD_DIR;
  try {
    await run();
  } finally {
    if (old === undefined) delete process.env.CREWPLANE_COORD_DIR;
    else process.env.CREWPLANE_COORD_DIR = old;
  }
}
it(
  "nudge preserves a hold and failure pause; resume lifts only the hold; explicit retry clears the failure",
  () =>
    withEnv(async () => {
      const f = await fixture();
      const state = initialState();
      state.held = ["B"];
      state.records.B = {
        key: "B",
        lane: "B",
        task: null,
        cwd: f.root,
        status: "paused",
        pauseKind: "failure",
        reason: "CLI failure",
        seen: [],
        runs: [],
        noProgress: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      const c = new AbortController();
      const running = serve(f.config, f.directory, c.signal);
      try {
        await until(async () => {
          try {
            return (
              (await f.load()).records["coordinator:control"]?.status === "idle"
            );
          } catch {
            return false;
          }
        });
        await f.command("nudge", "B");
        await until(async () => !!(await f.load()).notices.B?.length);
        expect((await f.load()).held).toContain("B");
        expect((await f.load()).records.B?.status).toBe("paused");
        await f.command("resume", "B");
        await until(async () => !(await f.load()).held.includes("B"));
        expect((await f.load()).records.B?.status).toBe("paused");
        await f.command("retry", "B");
        await until(async () => (await f.load()).records.B?.status === "idle");
      } finally {
        c.abort();
        await running;
        await rm(f.root, { recursive: true, force: true });
      }
    }),
  15000,
);
it(
  "drain retains ownership until asynchronous result/trace/state completion settles",
  () =>
    withEnv(async () => {
      const f = await fixture();
      const c = new AbortController();
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      let entered = false;
      let calls = 0;
      const running = serve(f.config, f.directory, c.signal, {
        readBoard: async (root) => {
          if (++calls === 3) {
            entered = true;
            await barrier;
          }
          return snapshot(root);
        },
      });
      try {
        await until(async () => entered);
        c.abort();
        await new Promise((r) => setTimeout(r, 1100));
        await expect(
          access(join(f.directory, "watcher.lock")),
        ).resolves.toBeUndefined();
        expect((await f.load()).running).toBe(true);
        expect((await f.load()).records["coordinator:control"]?.status).toBe(
          "running",
        );
        release();
        await running;
        expect((await f.load()).running).toBe(false);
        expect((await f.load()).records["coordinator:control"]?.status).toBe(
          "idle",
        );
        await expect(
          access(join(f.directory, "watcher.lock")),
        ).rejects.toThrow();
      } finally {
        release();
        c.abort();
        await running;
        await rm(f.root, { recursive: true, force: true });
      }
    }),
  15000,
);
it(
  "malformed native result fails closed without leaking its content and remains a persisted paused run",
  () =>
    withEnv(async () => {
      const f = await fixture("malformed");
      const c = new AbortController();
      const running = serve(f.config, f.directory, c.signal);
      try {
        await until(async () => {
          try {
            return (
              (await f.load()).records["coordinator:control"]?.status ===
              "paused"
            );
          } catch {
            return false;
          }
        });
        const s = await f.load();
        expect(s.records["coordinator:control"]?.reason).toContain(
          "No valid final result",
        );
        expect(JSON.stringify(s)).not.toContain("PRIVATE_SECRET_SENTINEL");
        expect(s.records["coordinator:control"]?.pid).toBeUndefined();
      } finally {
        c.abort();
        await running;
        expect((await f.load()).running).toBe(false);
        await rm(f.root, { recursive: true, force: true });
      }
    }),
  15000,
);
it(
  "releases startup lease on invalid state and pauses interrupted records even without a stored PID",
  () =>
    withEnv(async () => {
      const f = await fixture();
      try {
        await writeFile(join(f.directory, "state.json"), "{");
        await expect(
          serve(f.config, f.directory, new AbortController().signal),
        ).rejects.toThrow();
        await expect(
          access(join(f.directory, "watcher.lock")),
        ).rejects.toThrow();
        const s = initialState();
        s.records.B = {
          key: "B",
          lane: "B",
          task: null,
          cwd: f.root,
          status: "running",
          reason: "interrupted",
          seen: [],
          runs: [],
          noProgress: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        await writeFile(join(f.directory, "state.json"), JSON.stringify(s));
        const c = new AbortController();
        const running = serve(f.config, f.directory, c.signal);
        try {
          await until(async () => {
            try {
              return (await f.load()).records.B?.status === "paused";
            } catch {
              return false;
            }
          });
          expect((await f.load()).records.B?.reason).toContain(
            "no child identity",
          );
        } finally {
          c.abort();
          await running;
        }
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    }),
  15000,
);

it(
  "isolates malformed control files and invalid persisted record shapes without leaking or abandoning the lease",
  () =>
    withEnv(async () => {
      const f = await fixture();
      const c = new AbortController();
      await mkdir(join(f.directory, "commands"));
      await writeFile(
        join(f.directory, "commands/11111111-1111-4111-8111-111111111111.json"),
        "{PRIVATE_SECRET_SENTINEL",
      );
      const running = serve(f.config, f.directory, c.signal);
      try {
        await until(async () => {
          try {
            return (
              (await f.load()).records["coordinator:control"]?.status === "idle"
            );
          } catch {
            return false;
          }
        });
        expect((await f.load()).running).toBe(true);
        expect(JSON.stringify(await f.load())).not.toContain(
          "PRIVATE_SECRET_SENTINEL",
        );
      } finally {
        c.abort();
        await running;
      }
      await writeFile(
        join(f.directory, "state.json"),
        JSON.stringify({ ...initialState(), records: { invalid: null } }),
      );
      await expect(
        serve(f.config, f.directory, new AbortController().signal),
      ).rejects.toThrow("Invalid supervisor state");
      await expect(access(join(f.directory, "watcher.lock"))).rejects.toThrow();
      await rm(f.root, { recursive: true, force: true });
    }),
  15000,
);
it(
  "does not let unrelated task activity mask a stalled worker, and notices changes to its own untracked files",
  () =>
    withEnv(async () => {
      const f = await fixture();
      try {
        const { progress } = await import("./supervisor.ts");
        const b = await snapshot(f.root);
        const before = await progress(b, f.root, { lane: "B", task: "P1-01" });
        b.messages.push({
          id: "other",
          from: "C",
          to: "coordinator",
          kind: "handoff",
          task: "P1-02",
          at: new Date().toISOString(),
          replyTo: null,
          text: "Synthetic unrelated",
        });
        expect(await progress(b, f.root, { lane: "B", task: "P1-01" })).toBe(
          before,
        );
        await writeFile(
          join(f.root, "new-owned-file.ts"),
          "export const synthetic = true;",
        );
        expect(
          await progress(b, f.root, { lane: "B", task: "P1-01" }),
        ).not.toBe(before);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    }),
  15000,
);

it("wakes an idle long interval immediately on abort", async () => {
  const { idleWait } = await import("./supervisor.ts");
  const controller = new AbortController();
  const started = Date.now();
  const waiting = idleWait(60000, controller.signal);
  controller.abort();
  await waiting;
  expect(Date.now() - started).toBeLessThan(500);
});

it("recovers a transient state write failure without abandoning final persistence", () =>
  withEnv(async () => {
    const f = await fixture();
    const { publishJson } = await import("../io.ts");
    const controller = new AbortController();
    let writes = 0;
    const running = serve(f.config, f.directory, controller.signal, {
      writeState: async (path, value) => {
        if (++writes === 2) throw new Error("Synthetic EIO");
        await publishJson(path, value);
      },
    });
    await expect(running).rejects.toThrow("Synthetic EIO");
    expect(writes).toBeGreaterThan(2);
    expect((await f.load()).running).toBe(false);
    await expect(access(join(f.directory, "watcher.lock"))).rejects.toThrow();
    await rm(f.root, { recursive: true, force: true });
  }));

it("classifies an empty nonzero native result as CLI failure", () =>
  withEnv(async () => {
    const f = await fixture();
    await writeFile(
      f.config.binary,
      "#!/usr/bin/env node\nfor await (const chunk of process.stdin) {}\nprocess.exit(7);\n",
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const running = serve(f.config, f.directory, controller.signal);
    try {
      await until(async () => {
        try {
          return (
            (await f.load()).records["coordinator:control"]?.status === "paused"
          );
        } catch {
          return false;
        }
      });
      const record = (await f.load()).records["coordinator:control"];
      expect(record?.reason).toBe(
        "CLI run failed; inspect private log and retry",
      );
      expect(record?.noProgress).toBe(0);
      expect(record?.finalState).toBeUndefined();
      expect(record?.inputTokensKnown).toBe(false);
    } finally {
      controller.abort();
      await running;
      await rm(f.root, { recursive: true, force: true });
    }
  }));

it("classifies deadline with no result as timeout", () =>
  withEnv(async () => {
    const f = await fixture();
    await writeFile(
      f.config.binary,
      "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n",
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const running = serve(f.config, f.directory, controller.signal, {
      runTimeoutMs: 100,
      cleanupGraceMs: 100,
    });
    try {
      await until(async () => {
        try {
          return (
            (await f.load()).records["coordinator:control"]?.status === "paused"
          );
        } catch {
          return false;
        }
      });
      expect((await f.load()).records["coordinator:control"]?.reason).toBe(
        "Time budget reached",
      );
    } finally {
      controller.abort();
      await running;
      await rm(f.root, { recursive: true, force: true });
    }
  }));

it("persists child identity before delivering any prompt", () =>
  withEnv(async () => {
    const f = await fixture();
    await writeFile(
      f.config.binary,
      `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
for await(const chunk of process.stdin){}
const state=JSON.parse(readFileSync(${JSON.stringify(join(f.directory, "state.json"))},'utf8'));
const record=state.records['coordinator:control'];
if(record.status!=='running'||record.pid!==process.pid||record.processGroupId!==process.pid)process.exit(9);
console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));
const args=process.argv.slice(2);writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({state:'ready',summary:'Durable launch confirmed'}));
`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const running = serve(f.config, f.directory, controller.signal);
    try {
      await until(async () => {
        try {
          return (
            (await f.load()).records["coordinator:control"]?.status === "idle"
          );
        } catch {
          return false;
        }
      });
      expect((await f.load()).records["coordinator:control"]?.summary).toBe(
        "Durable launch confirmed",
      );
      expect((await f.load()).records["coordinator:control"]?.sessionId).toBe(
        "00000000-0000-4000-8000-000000000001",
      );
    } finally {
      controller.abort();
      await running;
      await rm(f.root, { recursive: true, force: true });
    }
  }));

it("ignores a stop queued for an earlier supervisor generation", () =>
  withEnv(async () => {
    const f = await fixture();
    await mkdir(join(f.directory, "commands"), { recursive: true });
    await writeFile(
      join(f.directory, "commands/11111111-1111-4111-8111-111111111111.json"),
      JSON.stringify({
        action: "stop",
        generation: "previous-generation",
        at: new Date().toISOString(),
      }),
    );
    const controller = new AbortController();
    const running = serve(f.config, f.directory, controller.signal);
    try {
      await until(async () => {
        try {
          return (
            (await f.load()).records["coordinator:control"]?.status === "idle"
          );
        } catch {
          return false;
        }
      });
      expect((await f.load()).running).toBe(true);
      expect((await f.load()).draining).toBe(false);
    } finally {
      controller.abort();
      await running;
      await rm(f.root, { recursive: true, force: true });
    }
  }));

it("requires explicit inspected-cleanup acknowledgement across every task in a lane", () =>
  withEnv(async () => {
    const f = await fixture();
    const state = initialState();
    state.records.old = {
      key: "old",
      lane: "coordinator",
      task: null,
      cwd: f.root,
      status: "paused",
      pauseKind: "failure",
      reason: "Unverified descendants",
      cleanupUnverified: true,
      seen: [],
      runs: [],
      noProgress: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    const controller = new AbortController();
    const running = serve(f.config, f.directory, controller.signal);
    try {
      await until(async () => {
        try {
          return (await f.load()).running;
        } catch {
          return false;
        }
      });
      await f.command("retry");
      await until(async () => !!(await f.load()).notices.coordinator?.length);
      expect((await f.load()).records.old?.cleanupUnverified).toBe(true);
      expect((await f.load()).records["coordinator:control"]).toBeUndefined();
      await writeFile(
        join(f.directory, "commands/22222222-2222-4222-8222-222222222222.json"),
        JSON.stringify({
          action: "retry",
          lane: "coordinator",
          confirmCleanup: true,
          text: "Synthetic operator inspected and terminated escaped descendants",
          generation: (await f.load()).generation,
          at: new Date().toISOString(),
        }),
      );
      await until(
        async () =>
          (await f.load()).records["coordinator:control"]?.status === "idle",
      );
      expect((await f.load()).records.old?.cleanupUnverified).toBeUndefined();
    } finally {
      controller.abort();
      await running;
      await rm(f.root, { recursive: true, force: true });
    }
  }));

it("retries failed claimed checkout setup without binding the session to the primary checkout", () =>
  withEnv(async () => {
    const f = await fixture();
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: f.root,
      encoding: "utf8",
    }).trim();
    const checkout = join(f.root, ".crewplane-local", "claimed");
    f.config.allowedTasks = ["T1"];
    f.config.lanes = {
      coordinator: { enabled: false },
      worker: { enabled: true },
    };
    await writeFile(join(f.directory, "config.json"), JSON.stringify(f.config));
    const synthetic = {
      id: "T1",
      title: "Synthetic setup",
      owner: "worker",
      phase: "test",
      state: "assigned",
      documentedStatus: "assigned",
      goal: "Retry setup",
      dependencies: "",
      scheduling: { code: "ready", label: "ready" },
      markdown: "Synthetic",
      live: {
        task: "T1",
        assignment: {
          owner: "worker",
          baseCommit: base,
          at: new Date().toISOString(),
          text: "Synthetic setup retry",
        },
        claim: {
          branch: "synthetic-claimed",
          worktree: checkout,
          at: new Date().toISOString(),
        },
        status: null,
        accepted: null,
      },
    };
    const controller = new AbortController();
    const running = serve(f.config, f.directory, controller.signal, {
      readBoard: async (root) => {
        const actual = await snapshot(root);
        actual.tasks.push(synthetic);
        return actual;
      },
    });
    try {
      await until(async () => {
        try {
          return Object.values((await f.load()).records).some(
            (r) => r.lane === "worker" && r.status === "paused",
          );
        } catch {
          return false;
        }
      });
      const failed = Object.values((await f.load()).records).find(
        (r) => r.lane === "worker",
      );
      expect(failed?.cwd).toBe("");
      await mkdir(join(f.root, ".crewplane-local"), { recursive: true });
      execFileSync(
        "git",
        ["worktree", "add", "-b", "synthetic-claimed", checkout, base],
        { cwd: f.root, stdio: "pipe" },
      );
      await f.command("retry", "worker");
      await until(async () =>
        Object.values((await f.load()).records).some(
          (r) => r.lane === "worker" && r.status === "idle" && !!r.sessionId,
        ),
      );
      const resumed = Object.values((await f.load()).records).find(
        (r) => r.lane === "worker",
      );
      expect(resumed?.key).toBe(failed?.key);
      expect(resumed?.cwd).toBe(checkout);
      expect(resumed?.sessionId).toBe("00000000-0000-4000-8000-000000000001");
    } finally {
      controller.abort();
      await running;
      await rm(f.root, { recursive: true, force: true });
    }
  }));

it("keeps distinct notice-only coordinator waiting turns idle", () =>
  withEnv(async () => {
    const f = await fixture("waiting");
    const controller = new AbortController();
    const running = serve(f.config, f.directory, controller.signal);
    try {
      await until(async () => {
        try {
          return (
            (await f.load()).records["coordinator:control"]?.status === "idle"
          );
        } catch {
          return false;
        }
      });
      for (const [index, text] of [
        "Synthetic operator routing notice",
        "Synthetic watchdog attention notice",
      ].entries()) {
        await f.command("nudge", "coordinator", text);
        await until(async () => {
          const record = (await f.load()).records["coordinator:control"];
          return (
            (record?.runs.length ?? 0) === index + 2 &&
            record?.status !== "running"
          );
        });
        const record = (await f.load()).records["coordinator:control"];
        expect(record?.status).toBe("idle");
        expect(record?.noProgress).toBe(1);
        expect(record?.pauseKind).toBeUndefined();
        expect(record?.finalState).toBe("waiting");
      }
    } finally {
      controller.abort();
      await running;
      await rm(f.root, { recursive: true, force: true });
    }
  }));
