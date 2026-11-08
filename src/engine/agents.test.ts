import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("./agents.mjs", import.meta.url));
const env = { ...process.env, CREWPLANE_COORD_DIR: "" };
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function cli(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { code: result.status, output: result.stdout, error: result.stderr };
}
function ok(cwd: string, ...args: string[]) {
  const result = cli(cwd, ...args);
  expect(result.error).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.output);
}
function race(
  cwd: string,
  ...args: string[]
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
async function fixture(
  test: (f: {
    root: string;
    b: string;
    b2: string;
    dir: string;
  }) => void | Promise<void>,
) {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-coord-test-")),
  );
  const root = join(dir, "repo"),
    b = join(dir, "B"),
    b2 = join(dir, "B2");
  try {
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
    writeFileSync(
      join(root, "tasks/P1-01.md"),
      "Owner lane: B.\nAllowed paths: example/**.\n",
    );
    writeFileSync(
      join(root, "tasks/P1-02.md"),
      "Owner lane: B.\nAllowed paths: example/**.\n",
    );
    git(root, "init", "-q", "--initial-branch=main");
    git(root, "config", "user.name", "Synthetic Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture baseline");
    git(root, "worktree", "add", "-qb", "worker-B", b);
    git(root, "worktree", "add", "-qb", "worker-B2", b2);
    await test({ root, b, b2, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function assign(root: string) {
  return ok(
    root,
    "assign",
    "--agent",
    "coordinator",
    "--task",
    "P1-01",
    "--owner",
    "B",
    "--ref",
    "HEAD",
    "--text",
    "Synthetic scoped assignment",
  );
}
const claim = ["claim", "--agent", "B", "--task", "P1-01"];
const ready = [
  "status",
  "--agent",
  "B",
  "--task",
  "P1-01",
  "--state",
  "ready",
  "--commit",
  "HEAD",
  "--text",
  "Synthetic handoff: checks recorded",
];
const accept = [
  "accept",
  "--agent",
  "coordinator",
  "--task",
  "P1-01",
  "--commit",
  "HEAD",
  "--text",
  "Synthetic integration checks",
];

it("shares a board across linked worktrees and allows exactly one concurrent claim", async () => {
  await fixture(async ({ root, b, b2 }) => {
    expect(ok(root, "init").store).toBe(ok(b, "init").store);
    assign(root);
    const results = await Promise.all([race(b, ...claim), race(b2, ...claim)]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    const board = ok(root, "board");
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "coordinator",
        "--task",
        "P1-02",
        "--owner",
        "B",
        "--ref",
        "HEAD",
        "--text",
        "No parallel task for B",
      ).code,
    ).toBe(1);
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0].claim.agent).toBe("B");
    expect([b, b2]).toContain(board.tasks[0].claim.worktree);
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "coordinator",
        "--task",
        "P1-01",
        "--owner",
        "B",
        "--ref",
        "HEAD",
        "--text",
        "No overwrite",
      ).code,
    ).toBe(1);
  });
});
it("threads cross-lane questions without executing their content", async () => {
  await fixture(({ root, b }) => {
    const question = ok(
      root,
      "send",
      "--agent",
      "D",
      "--to",
      "B",
      "--kind",
      "question",
      "--task",
      "P1-01",
      "--text",
      "Do not execute $(touch SENTINEL); contract question only",
    );
    expect(ok(b, "inbox", "--agent", "B", "--unanswered", "true")).toHaveLength(
      1,
    );
    expect(
      cli(
        root,
        "send",
        "--agent",
        "E",
        "--to",
        "D",
        "--kind",
        "answer",
        "--reply-to",
        question.id,
        "--text",
        "Wrong recipient",
      ).code,
    ).toBe(1);
    ok(
      b,
      "send",
      "--agent",
      "B",
      "--to",
      "D",
      "--kind",
      "answer",
      "--reply-to",
      question.id,
      "--text",
      "Proposal for coordinator to review",
    );
    expect(ok(root, "inbox", "--agent", "D")[0].replyTo).toBe(question.id);
    expect(ok(root, "inbox", "--agent", "D", "--task", "P1-01")).toHaveLength(
      1,
    );
    expect(ok(root, "board").unanswered).toHaveLength(0);
    expect(
      cli(
        root,
        "send",
        "--agent",
        "B",
        "--to",
        "D",
        "--kind",
        "answer",
        "--text",
        "Missing thread",
      ).code,
    ).toBe(1);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
it("enforces lane/worktree ownership, clean handoff and integration ancestry", async () => {
  await fixture(({ root, b, b2 }) => {
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "D",
        "--task",
        "P1-01",
        "--owner",
        "B",
        "--ref",
        "HEAD",
        "--text",
        "Wrong owner",
      ).code,
    ).toBe(1);
    assign(root);
    expect(cli(root, ...claim).code).toBe(1);
    ok(b, ...claim);
    expect(
      cli(
        b2,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-01",
        "--state",
        "working",
        "--text",
        "Wrong worktree",
      ).code,
    ).toBe(1);
    expect(cli(root, ...accept).code).toBe(1);
    writeFileSync(join(b, "example.txt"), "Synthetic change\n");
    expect(cli(b, ...ready).code).toBe(1);
    git(b, "add", "example.txt");
    git(b, "commit", "-qm", "synthetic task slice");
    const handoff = ok(b, ...ready);
    expect(cli(root, ...accept).code).toBe(1);
    git(root, "merge", "--ff-only", handoff.commit);
    expect(ok(root, ...accept).commit).toBe(handoff.commit);
    expect(
      cli(
        b,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-01",
        "--state",
        "working",
        "--text",
        "Already accepted",
      ).code,
    ).toBe(1);
  });
});
it("archives an abandoned task before reassignment and rejects its old worktree", async () => {
  await fixture(({ root, b, b2 }) => {
    assign(root);
    ok(b, ...claim);
    const released = ok(
      root,
      "release",
      "--agent",
      "coordinator",
      "--task",
      "P1-01",
      "--text",
      "Test session stopped; preserved old branch",
    );
    expect(
      JSON.parse(readFileSync(join(released.archive, "claim.json"), "utf8"))
        .worktree,
    ).toBe(b);
    assign(root);
    ok(b2, ...claim);
    expect(
      cli(
        b,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-01",
        "--state",
        "working",
        "--text",
        "Obsolete writer",
      ).code,
    ).toBe(1);
    expect(ok(root, "board").tasks[0].claim.worktree).toBe(b2);
  });
});
it("provides all six full prompts and supports multiline files without shell interpolation", async () => {
  await fixture(({ root, dir }) => {
    for (const agent of ["coordinator", "B", "C", "D", "E", "F"]) {
      const prompt = cli(root, "prompt", agent);
      expect(prompt.code).toBe(0);
      expect(prompt.output).toContain("Worker self-service setup");
      expect(prompt.output).toContain("Do not redefine shared interfaces");
      expect(prompt.output).toContain(`agent ${agent}`);
    }
    const note = join(dir, "note.md");
    writeFileSync(note, "Line one\nLiteral `command` and $(substitution)\n");
    const result = ok(
      root,
      "send",
      "--agent",
      "coordinator",
      "--to",
      "all",
      "--kind",
      "update",
      "--file",
      note,
    );
    expect(result.text).toBe(readFileSync(note, "utf8"));
    expect(cli(root, "claim", "--agent", "B", "--task", "../bad").code).toBe(1);
    unlinkSync(note);
  });
});

it.each(["squash", "rebase"])(
  "records equivalent %s integration and rejects unrelated changes",
  async (strategy) => {
    await fixture(({ root, b }) => {
      assign(root);
      ok(b, ...claim);
      writeFileSync(join(b, "example.txt"), "Synthetic source change\n");
      git(b, "add", ".");
      git(b, "commit", "-qm", "feat(test): add synthetic source");
      const source = ok(b, ...ready).commit;
      writeFileSync(join(root, "other.txt"), "Concurrent coordinator change\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "chore(test): add coordinator change");
      const base = git(root, "rev-parse", "HEAD");
      const options = ["--strategy", strategy, "--integration-base", base];
      expect(cli(root, ...accept, ...options).code).toBe(1);
      if (strategy === "squash") {
        git(root, "merge", "--squash", source);
        git(root, "commit", "-qm", "feat(test): integrate synthetic source");
      } else {
        git(root, "cherry-pick", source);
      }
      expect(cli(root, ...accept).code).toBe(1);
      const accepted = ok(root, ...accept, ...options);
      expect(accepted.sourceCommit).toBe(source);
      expect(accepted.strategy).toBe(strategy);
      expect(accepted.integrationBase).toBe(base);
      expect(accepted.commit).not.toBe(source);
    });
  },
);

it("rejects merge commits even when handoff ancestry is preserved", async () => {
  await fixture(({ root, b }) => {
    const base = assign(root).baseCommit;
    ok(b, ...claim);
    writeFileSync(join(b, "example.txt"), "Synthetic source change\n");
    git(b, "add", ".");
    git(b, "commit", "-qm", "feat(test): add synthetic source");
    const source = ok(b, ...ready).commit;
    git(root, "merge", "--no-ff", "-m", "Synthetic forbidden merge", source);
    const result = cli(root, ...accept, "--integration-base", base);
    expect(result.code).toBe(1);
    expect(result.error).toContain("must not introduce merge commits");
  });
});

it("supports a reusable reviewer inbox and threaded findings without implementation ownership", async () => {
  await fixture(({ root, b }) => {
    const request = ok(
      root,
      "send",
      "--agent",
      "coordinator",
      "--to",
      "reviewer",
      "--kind",
      "request",
      "--task",
      "P1-01",
      "--text",
      "Review exact synthetic base/tip in the tracked brief",
      "--commit",
      "HEAD",
    );
    const inbox = ok(
      root,
      "inbox",
      "--agent",
      "reviewer",
      "--unanswered",
      "true",
    );
    expect(inbox.map((m: { id: string }) => m.id)).toEqual([request.id]);
    ok(
      root,
      "send",
      "--agent",
      "reviewer",
      "--to",
      "coordinator",
      "--kind",
      "update",
      "--task",
      "P1-01",
      "--text",
      "Independent review started; no task claimed",
    );
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "coordinator",
        "--owner",
        "reviewer",
        "--task",
        "P1-01",
        "--ref",
        "HEAD",
        "--text",
        "Forbidden reviewer ownership",
      ).code,
    ).toBe(1);
    assign(root);
    expect(cli(b, "claim", "--agent", "reviewer", "--task", "P1-01").code).toBe(
      1,
    );
    expect(
      cli(
        root,
        "accept",
        "--agent",
        "reviewer",
        "--task",
        "P1-01",
        "--commit",
        "HEAD",
        "--text",
        "Forbidden reviewer acceptance",
      ).code,
    ).toBe(1);
    ok(
      root,
      "send",
      "--agent",
      "reviewer",
      "--to",
      "coordinator",
      "--kind",
      "answer",
      "--reply-to",
      request.id,
      "--text",
      "No actionable findings; exact SHA and limits recorded",
    );
    expect(
      ok(root, "inbox", "--agent", "reviewer", "--unanswered", "true"),
    ).toEqual([]);
    const board = ok(root, "board");
    expect(board.tasks[0].assignment.owner).toBe("B");
    expect(board.tasks[0].claim).toBeNull();
  });
  const prompt = cli(process.cwd(), "prompt", "reviewer");
  expect(prompt.code).toBe(0);
  expect(prompt.output).toContain("Verification-only reviewer");
  expect(prompt.output).toContain("exact requested commit");
  expect(prompt.output).not.toContain("# Worker self-service setup");
});

it("supports visual QA inbox/findings without implementation authority", async () => {
  await fixture(({ root, b }) => {
    const request = ok(
      root,
      "send",
      "--agent",
      "coordinator",
      "--to",
      "visual",
      "--kind",
      "request",
      "--task",
      "P1-01",
      "--text",
      "Review exact synthetic base/tip in the tracked brief",
      "--commit",
      "HEAD",
    );
    const inbox = ok(
      root,
      "inbox",
      "--agent",
      "visual",
      "--unanswered",
      "true",
    );
    expect(inbox.map((m: { id: string }) => m.id)).toEqual([request.id]);
    ok(
      root,
      "send",
      "--agent",
      "visual",
      "--to",
      "coordinator",
      "--kind",
      "update",
      "--task",
      "P1-01",
      "--text",
      "Independent review started; no task claimed",
    );
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "coordinator",
        "--owner",
        "visual",
        "--task",
        "P1-01",
        "--ref",
        "HEAD",
        "--text",
        "Forbidden reviewer ownership",
      ).code,
    ).toBe(1);
    assign(root);
    expect(cli(b, "claim", "--agent", "visual", "--task", "P1-01").code).toBe(
      1,
    );
    expect(
      cli(
        root,
        "accept",
        "--agent",
        "visual",
        "--task",
        "P1-01",
        "--commit",
        "HEAD",
        "--text",
        "Forbidden reviewer acceptance",
      ).code,
    ).toBe(1);
    for (const action of ["status", "release"]) {
      expect(
        cli(
          root,
          action,
          "--agent",
          "visual",
          "--task",
          "P1-01",
          "--state",
          "ready",
          "--text",
          "Forbidden visual ownership",
        ).code,
      ).toBe(1);
    }
    ok(
      root,
      "send",
      "--agent",
      "visual",
      "--to",
      "coordinator",
      "--kind",
      "answer",
      "--reply-to",
      request.id,
      "--text",
      "No actionable findings; exact SHA and limits recorded",
    );
    expect(
      ok(root, "inbox", "--agent", "visual", "--unanswered", "true"),
    ).toEqual([]);
    const board = ok(root, "board");
    expect(board.tasks[0].assignment.owner).toBe("B");
    expect(board.tasks[0].claim).toBeNull();
  });
  const prompt = cli(process.cwd(), "prompt", "visual");
  expect(prompt.code).toBe(0);
  expect(prompt.output).toContain("visual and interaction verifier");
  expect(prompt.output).toContain("actual screenshot inspection");
  expect(prompt.output).not.toContain("# Worker self-service setup");
});

it("offers a compact orchestration brief without replaying all historical message bodies", async () => {
  await fixture(({ root }) => {
    assign(root);
    const message = ok(
      root,
      "send",
      "--agent",
      "B",
      "--to",
      "coordinator",
      "--kind",
      "update",
      "--task",
      "P1-01",
      "--text",
      "Synthetic historical message body",
    );
    const brief = ok(root, "brief");
    expect(brief.tasks[0].state).toBe("assigned");
    expect(brief.recent[0].id).toBe(message.id);
    expect(JSON.stringify(brief)).not.toContain(
      "Synthetic historical message body",
    );
    expect(brief.messages).toBeUndefined();
  });
});

function scope(root: string, task: string, paths: string[]) {
  return ok(
    root,
    "scope",
    "--agent",
    "coordinator",
    "--task",
    task,
    "--paths-json",
    JSON.stringify(paths),
  );
}
function second(root: string, ref = "HEAD") {
  return cli(
    root,
    "assign",
    "--agent",
    "coordinator",
    "--task",
    "P1-02",
    "--owner",
    "B",
    "--ref",
    ref,
    "--text",
    "Independent synthetic slice",
  );
}
const claimSecond = ["claim", "--agent", "B", "--task", "P1-02"];
function revisionRequest(root: string, task = "P1-01") {
  return ok(
    root,
    "send",
    "--agent",
    "coordinator",
    "--to",
    "B",
    "--kind",
    "request",
    "--task",
    task,
    "--text",
    "Required synthetic review correction",
    "--commit",
    ok(root, "board").tasks.find(
      (entry: { task: string }) => entry.task === task,
    ).status.commit,
  );
}
const working = [
  "status",
  "--agent",
  "B",
  "--task",
  "P1-01",
  "--state",
  "working",
  "--text",
  "Required revision",
];

it("allows disjoint frozen submissions while preserving tips and original resources", async () => {
  await fixture(({ root, b, b2 }) => {
    assign(root);
    scope(root, "P1-01", ["packages/first/"]);
    scope(root, "P1-02", ["packages/second"]);
    ok(b, ...claim);
    writeFileSync(
      join(b, "first.txt"),
      "Independent authored synthetic work\n",
    );
    git(b, "add", ".");
    git(b, "commit", "-qm", "feat(test): freeze first submission");
    ok(b, ...ready);
    const frozen = ok(root, "board").tasks[0];
    expect(second(root).code).toBe(0);
    expect(cli(b, ...claimSecond).error).toContain("Worktree already claimed");
    ok(b2, ...claimSecond);
    expect(cli(b, ...working).error).toContain("already has active task P1-02");
    expect(ok(root, "board").tasks[0]).toEqual(frozen);
    ok(b2, ...ready.map((v) => (v === "P1-01" ? "P1-02" : v)));
    revisionRequest(root);
    ok(b, ...working);
    expect(
      cli(
        b2,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-02",
        "--state",
        "working",
        "--text",
        "Concurrent revision",
      ).code,
    ).toBe(1);
    expect(
      cli(
        root,
        "scope",
        "--agent",
        "coordinator",
        "--task",
        "P1-02",
        "--paths-json",
        '["packages/first/child"]',
      ).error,
    ).toContain("overlap");
  });
});

it.each(["assigned", "claimed", "working", "blocked"])(
  "refuses a second assignment while the first is %s",
  async (state) => {
    await fixture(({ root, b }) => {
      assign(root);
      scope(root, "P1-01", ["first"]);
      scope(root, "P1-02", ["second"]);
      if (state !== "assigned") ok(b, ...claim);
      if (["working", "blocked"].includes(state))
        ok(
          b,
          "status",
          "--agent",
          "B",
          "--task",
          "P1-01",
          "--state",
          state,
          "--text",
          "Synthetic state",
        );
      expect(second(root).error).toContain("already has active task");
    });
  },
);

it("fails closed for unknown scopes and segment overlaps, but permits similar names", async () => {
  await fixture(({ root, b }) => {
    assign(root);
    ok(b, ...claim);
    ok(b, ...ready);
    expect(second(root).error).toContain("Unknown coordinator scope");
    scope(root, "P1-02", ["packages/intake"]);
    expect(second(root).error).toContain("Unknown coordinator scope");
    scope(root, "P1-01", ["packages/intake/child"]);
    expect(second(root).error).toContain("overlap");
    scope(root, "P1-01", ["packages/intake"]);
    expect(second(root).error).toContain("overlap");
    scope(root, "P1-01", ["packages/intake-other"]);
    expect(second(root).code).toBe(0);
  });
});

it("validates coordinator-only normalized scope metadata without executing input", async () => {
  await fixture(({ root }) => {
    for (const agent of ["B", "reviewer", "visual"]) {
      expect(
        cli(
          root,
          "scope",
          "--agent",
          agent,
          "--task",
          "P1-01",
          "--paths-json",
          '["safe"]',
        ).error,
      ).toMatch(/Only the coordinator|Verification roles/);
    }
    for (const paths of [
      [],
      ["/absolute"],
      ["../escape"],
      ["a/../b"],
      ["a//b"],
      ["a\\b"],
      ["a/**"],
      ["."],
      ["a/./b"],
      ["C:drive"],
      ["x".repeat(257)],
      Array.from({ length: 65 }, (_, i) => `path${i}`),
    ]) {
      expect(
        cli(
          root,
          "scope",
          "--agent",
          "coordinator",
          "--task",
          "P1-01",
          "--paths-json",
          JSON.stringify(paths),
        ).code,
      ).toBe(1);
    }
    expect(scope(root, "P1-01", ["safe/", "safe", "safe/sub"]).paths).toEqual([
      "safe",
      "safe/sub",
    ]);
    expect(scope(root, "P1-01", ["other"]).version).toBe(1);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});

it("rejects an unaccepted author baseline even when its committed card matches", async () => {
  await fixture(({ root, b }) => {
    writeFileSync(join(b, "unaccepted.txt"), "Unaccepted synthetic source\n");
    git(b, "add", ".");
    git(b, "commit", "-qm", "feat(test): add unaccepted work");
    expect(second(root, git(b, "rev-parse", "HEAD")).error).toContain(
      "primary HEAD or its ancestor",
    );
    expect(second(root, git(root, "rev-parse", "HEAD")).code).toBe(0);
  });
});

it("refuses claims and revisions while a different native task is running", async () => {
  await fixture(({ root, b, b2 }) => {
    assign(root);
    scope(root, "P1-01", ["first"]);
    scope(root, "P1-02", ["second"]);
    ok(b, ...claim);
    ok(b, ...ready);
    expect(second(root).code).toBe(0);
    const directory = join(root, ".crewplane-state/supervisor");
    mkdirSync(directory, { recursive: true });
    const state = join(directory, "state.json");
    writeFileSync(
      state,
      JSON.stringify({
        records: {
          original: {
            lane: "B",
            task: "P1-01",
            cwd: b,
            status: "running",
          },
        },
      }),
    );
    expect(cli(b2, ...claimSecond).error).toContain("running native record");
    writeFileSync(
      state,
      JSON.stringify({
        records: {
          next: {
            lane: "B",
            task: "P1-02",
            cwd: b2,
            status: "running",
          },
        },
      }),
    );
    ok(b2, ...claimSecond);
    expect(cli(b, ...working).error).toContain("running native record");
  });
});

it("serializes concurrent different-task claims instead of allowing two writers", async () => {
  await fixture(async ({ root, b, b2 }) => {
    assign(root);
    scope(root, "P1-01", ["first"]);
    scope(root, "P1-02", ["second"]);
    ok(b, ...claim);
    ok(b, ...ready);
    expect(second(root).code).toBe(0);
    revisionRequest(root);
    const results = await Promise.all([
      race(b, ...working),
      race(b2, ...claimSecond),
    ]);
    expect(
      results.filter((result) => result.code === 0).length,
    ).toBeLessThanOrEqual(1);
    // The revision may see the queued assignment before the new claim wins the lock.
    if (results.every((result) => result.code !== 0)) ok(b2, ...claimSecond);
    const tasks = ok(root, "board").tasks;
    expect(
      tasks.filter(
        (entry: { status: { state: string } | null; claim: unknown }) =>
          entry.status?.state === "working" || (entry.claim && !entry.status),
      ).length,
    ).toBe(1);
  });
});

it("does not require pipeline scope for accepted tasks or ordinary ancestor assignments", async () => {
  await fixture(({ root, b, b2 }) => {
    assign(root);
    ok(b, ...claim);
    ok(b, ...ready);
    ok(root, ...accept);
    const ancestor = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "coordinator.txt"), "Synthetic approved update\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "chore(test): advance approved baseline");
    expect(second(root, ancestor).code).toBe(0);
    expect(cli(b, ...claimSecond).error).toContain("Worktree already claimed");
    ok(b2, ...claimSecond);
  });
});

it.each(["assigned", "claimed", "working", "native-running"])(
  "preserves a frozen tip against blocked and replacement-ready transitions with another task %s",
  async (state) => {
    await fixture(({ root, b, b2 }) => {
      assign(root);
      scope(root, "P1-01", ["first"]);
      scope(root, "P1-02", ["second"]);
      ok(b, ...claim);
      ok(b, ...ready);
      const frozen = ok(root, "board").tasks[0];
      expect(second(root).code).toBe(0);
      if (state !== "assigned") ok(b2, ...claimSecond);
      if (state === "working") {
        ok(
          b2,
          "status",
          "--agent",
          "B",
          "--task",
          "P1-02",
          "--state",
          "working",
          "--text",
          "Synthetic active task",
        );
      }
      if (state === "native-running") {
        // coordinator frozen newer submission can still have a native turn running.
        ok(b2, ...ready.map((value) => (value === "P1-01" ? "P1-02" : value)));
        const directory = join(root, ".crewplane-state/supervisor");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "state.json"),
          JSON.stringify({
            records: {
              next: { lane: "B", task: "P1-02", cwd: b2, status: "running" },
            },
          }),
        );
      }
      // Same-tip annotation is harmless even while another task executes.
      ok(b, ...ready);
      const annotated = ok(root, "board").tasks[0];
      expect(annotated.claim).toEqual(frozen.claim);
      expect(annotated.status.commit).toBe(frozen.status.commit);
      expect(
        cli(
          b,
          "status",
          "--agent",
          "B",
          "--task",
          "P1-01",
          "--state",
          "blocked",
          "--text",
          "Attempt to erase frozen submission",
        ).code,
      ).toBe(1);
      writeFileSync(join(b, "revision.txt"), "Synthetic replacement tip\n");
      git(b, "add", ".");
      git(b, "commit", "-qm", "fix(test): prepare synthetic revision");
      expect(cli(b, ...ready).code).toBe(1);
      expect(ok(root, "board").tasks[0]).toEqual(annotated);
      if (state === "working") {
        // The current owning task can finish while the older task stays frozen.
        ok(b2, ...ready.map((value) => (value === "P1-01" ? "P1-02" : value)));
        // Even after that checkpoint, changing a frozen tip requires working first.
        expect(cli(b, ...ready).error).toContain(
          "explicit working revision transition",
        );
        expect(
          cli(
            b,
            "status",
            "--agent",
            "B",
            "--task",
            "P1-01",
            "--state",
            "blocked",
            "--text",
            "Missing revision transition",
          ).error,
        ).toContain("explicit working revision transition");
        revisionRequest(root);
        ok(b, ...working);
        ok(
          b,
          "status",
          "--agent",
          "B",
          "--task",
          "P1-01",
          "--state",
          "blocked",
          "--text",
          "Ordinary active-task blocker",
        );
        ok(b, ...working);
        expect(ok(b, ...ready).commit).toBe(git(b, "rev-parse", "HEAD"));
      }
    });
  },
);

it("keeps the losing frozen submission intact after concurrent revision attempts", async () => {
  await fixture(async ({ root, b, b2 }) => {
    assign(root);
    scope(root, "P1-01", ["first"]);
    scope(root, "P1-02", ["second"]);
    ok(b, ...claim);
    ok(b, ...ready);
    expect(second(root).code).toBe(0);
    ok(b2, ...claimSecond);
    ok(b2, ...ready.map((value) => (value === "P1-01" ? "P1-02" : value)));
    const secondWorking = working.map((value) =>
      value === "P1-01" ? "P1-02" : value,
    );
    revisionRequest(root);
    revisionRequest(root, "P1-02");
    const results = await Promise.all([
      race(b, ...working),
      race(b2, ...secondWorking),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const losingIndex = results.findIndex((result) => result.code !== 0);
    const loser = losingIndex === 0 ? b : b2;
    const task = losingIndex === 0 ? "P1-01" : "P1-02";
    const frozen = ok(root, "board").tasks.find(
      (entry: { task: string }) => entry.task === task,
    );
    expect(
      cli(
        loser,
        "status",
        "--agent",
        "B",
        "--task",
        task,
        "--state",
        "blocked",
        "--text",
        "Concurrent frozen-tip bypass",
      ).code,
    ).toBe(1);
    writeFileSync(
      join(loser, "replacement.txt"),
      "Independently authored hostile replacement\n",
    );
    git(loser, "add", ".");
    git(loser, "commit", "-qm", "fix(test): attempt frozen-tip replacement");
    expect(
      cli(loser, ...ready.map((value) => (value === "P1-01" ? task : value)))
        .code,
    ).toBe(1);
    expect(
      ok(root, "board").tasks.find(
        (entry: { task: string }) => entry.task === task,
      ),
    ).toEqual(frozen);
  });
});

it("publishes coordinator-only versioned scheduling metadata with stable queue age", async () => {
  await fixture(({ root }) => {
    assign(root);
    const dependencies = [
      { taskId: "P1-02", require: "accepted", commit: null },
    ];
    const metadata = ok(
      root,
      "schedule",
      "--agent",
      "coordinator",
      "--task",
      "P1-01",
      "--priority",
      "gate-critical",
      "--dependencies-json",
      JSON.stringify(dependencies),
      "--enqueued-at",
      "1000",
    );
    expect(metadata).toEqual({
      version: 1,
      priority: "gate-critical",
      dependsOn: dependencies,
      reviewOf: null,
      enqueuedAt: 1000,
      updatedBy: "coordinator",
    });
    const reprioritized = ok(
      root,
      "schedule",
      "--agent",
      "coordinator",
      "--task",
      "P1-01",
      "--priority",
      "normal",
    );
    expect(reprioritized.enqueuedAt).toBe(1000);
    expect(reprioritized.dependsOn).toEqual(dependencies);
    expect(ok(root, "board").tasks[0].scheduling).toEqual(reprioritized);
    expect(ok(root, "brief").tasks[0].scheduling).toEqual(reprioritized);
    expect(
      cli(
        root,
        "schedule",
        "--agent",
        "coordinator",
        "--task",
        "P1-01",
        "--priority",
        "low",
        "--enqueued-at",
        "2000",
      ).error,
    ).toContain("enqueue time is immutable");
    expect(ok(root, "board").tasks[0].scheduling).toEqual(reprioritized);
    for (const agent of ["B", "C", "D", "E", "F", "reviewer", "visual"]) {
      expect(
        cli(
          root,
          "schedule",
          "--agent",
          agent,
          "--task",
          "P1-01",
          "--priority",
          "urgent-operational",
        ).code,
      ).toBe(1);
    }
  });
});

it("pins ready dependencies and refuses malformed or over-authoritative scheduling input", async () => {
  await fixture(({ root }) => {
    const base = git(root, "rev-parse", "HEAD");
    assign(root);
    const args = [
      "schedule",
      "--agent",
      "coordinator",
      "--task",
      "P1-01",
      "--priority",
      "normal",
    ];
    const valid = [{ taskId: "P1-02", require: "ready", commit: base }];
    const expected = ok(
      root,
      ...args,
      "--dependencies-json",
      JSON.stringify(valid),
    );
    for (const dependency of [
      { taskId: "P1-02", require: "ready", commit: null },
      { taskId: "P1-02", require: "ready", commit: "HEAD" },
      { taskId: "P1-02", require: "ready", commit: `--${base}` },
      { taskId: "P1-02", require: "accepted", commit: base, authorized: true },
      { taskId: "P1-01", require: "accepted", commit: null },
      { taskId: "../P1-02", require: "accepted", commit: null },
      { taskId: "P1-02", require: "working", commit: null },
      null,
    ])
      expect(
        cli(root, ...args, "--dependencies-json", JSON.stringify([dependency]))
          .code,
      ).toBe(1);
    for (const invalid of [{}, [valid[0], valid[0]], Array(65).fill(valid[0])])
      expect(
        cli(root, ...args, "--dependencies-json", JSON.stringify(invalid)).code,
      ).toBe(1);
    expect(cli(root, ...args, "--updated-by", "operator").error).toContain(
      "Unknown schedule option",
    );
    expect(ok(root, "board").tasks[0].scheduling).toEqual(expected);
  });
});

it("requires committed task cards and leaves scheduling absent until explicitly published", async () => {
  await fixture(({ root }) => {
    assign(root);
    expect(ok(root, "board").tasks[0].scheduling).toBeNull();
    expect(
      cli(
        root,
        "schedule",
        "--agent",
        "coordinator",
        "--task",
        "P1-99",
        "--priority",
        "normal",
      ).code,
    ).toBe(1);
    expect(
      cli(
        root,
        "schedule",
        "--agent",
        "coordinator",
        "--task",
        "P1-01",
        "--priority",
        "invented",
      ).error,
    ).toContain("Unknown scheduling priority");
    for (const timestamp of ["NaN", "-1", "1.2", `${Date.now() + 3600000}`])
      expect(
        cli(
          root,
          "schedule",
          "--agent",
          "coordinator",
          "--task",
          "P1-01",
          "--priority",
          "normal",
          "--enqueued-at",
          timestamp,
        ).code,
      ).toBe(1);
    const assignment = ok(root, "board").tasks[0].assignment;
    const metadata = ok(
      root,
      "schedule",
      "--agent",
      "coordinator",
      "--task",
      "P1-01",
      "--priority",
      "normal",
    );
    expect(metadata.enqueuedAt).toBe(Date.parse(assignment.at));
    expect(metadata.dependsOn).toEqual([]);
    expect(metadata.reviewOf).toBeNull();
  });
});

it("records exact coordinator review pins as data and rejects pins on other message types", async () => {
  await fixture(({ root }) => {
    const expected = git(root, "rev-parse", "HEAD");
    const message = ok(
      root,
      "send",
      "--agent",
      "coordinator",
      "--to",
      "reviewer",
      "--kind",
      "request",
      "--task",
      "P1-01",
      "--commit",
      "HEAD",
      "--text",
      "Synthetic exact-tip review",
    );
    expect(message.reviewCommit).toBe(expected);
    expect(ok(root, "board").messages[0].reviewCommit).toBe(expected);
    expect(ok(root, "inbox", "--agent", "reviewer")[0].reviewCommit).toBe(
      expected,
    );
    const legacy = cli(
      root,
      "send",
      "--agent",
      "coordinator",
      "--to",
      "visual",
      "--kind",
      "request",
      "--task",
      "P1-01",
      "--text",
      "Legacy text-only review",
    );
    expect(legacy.code).toBe(1);
    for (const [from, to, kind, task] of [
      ["B", "reviewer", "request", "P1-01"],
      ["coordinator", "visual", "update", "P1-01"],
    ] as const) {
      expect(
        cli(
          root,
          "send",
          "--agent",
          from,
          "--to",
          to,
          "--kind",
          kind,
          ...(task ? ["--task", task] : []),
          "--commit",
          "HEAD",
          "--text",
          "Synthetic invalid pin",
        ).error,
      ).toContain("Only coordinator task requests");
    }
    expect(
      cli(
        root,
        "send",
        "--agent",
        "coordinator",
        "--to",
        "reviewer",
        "--kind",
        "request",
        "--task",
        "P1-01",
        "--commit",
        "missing-ref",
        "--text",
        "Synthetic missing pin",
      ).code,
    ).toBe(1);
    expect(ok(root, "board").messages).toHaveLength(1);
  });
});

it("requires an outstanding task-specific coordinator request to unfreeze an author submission", async () => {
  await fixture(({ root, b }) => {
    assign(root);
    ok(b, ...claim);
    ok(b, ...ready);
    const frozen = ok(root, "board").tasks[0];
    expect(cli(b, ...working).error).toContain(
      "outstanding coordinator revision request",
    );
    expect(
      cli(
        b,
        "checkpoint",
        "--agent",
        "B",
        "--task",
        "P1-01",
        "--text",
        "Cannot checkpoint frozen work",
      ).code,
    ).toBe(1);
    expect(
      cli(
        root,
        "send",
        "--agent",
        "coordinator",
        "--to",
        "B",
        "--kind",
        "request",
        "--task",
        "P1-02",
        "--text",
        "Unassigned request",
      ).code,
    ).toBe(1);
    expect(cli(b, ...working).code).toBe(1);
    const request = revisionRequest(root);
    ok(
      b,
      "send",
      "--agent",
      "B",
      "--to",
      "coordinator",
      "--kind",
      "answer",
      "--reply-to",
      request.id,
      "--text",
      "Request was withdrawn before execution",
    );
    expect(cli(b, ...working).code).toBe(1);
    expect(ok(root, "board").tasks[0]).toEqual(frozen);
    revisionRequest(root);
    ok(b, ...working);
    expect(ok(root, "board").tasks[0].status.state).toBe("working");
  });
});

it("allows an authorized revision before an unclaimed assignment but not a claimed or unsafe blocked task", async () => {
  await fixture(({ root, b, b2 }) => {
    assign(root);
    scope(root, "P1-01", ["first"]);
    scope(root, "P1-02", ["second"]);
    ok(b, ...claim);
    ok(b, ...ready);
    expect(second(root).code).toBe(0);
    revisionRequest(root);
    ok(b, ...working);
    expect(cli(b2, ...claimSecond).error).toContain(
      "already has active task P1-01",
    );
    ok(b, ...ready);
    ok(b2, ...claimSecond);
    expect(cli(b, ...working).error).toContain("already has active task P1-02");
    ok(
      b2,
      "status",
      "--agent",
      "B",
      "--task",
      "P1-02",
      "--state",
      "blocked",
      "--text",
      "Uncheckpointed blocker",
    );
    expect(cli(b, ...working).error).toContain("already has active task P1-02");
  });
});

it("checkpoints the current task before routing a revision to its original worktree and session", async () => {
  await fixture(({ root, b, b2 }) => {
    assign(root);
    scope(root, "P1-01", ["first"]);
    scope(root, "P1-02", ["second"]);
    ok(b, ...claim);
    ok(b, ...ready);
    expect(second(root).code).toBe(0);
    ok(b2, ...claimSecond);
    const secondWorking = working.map((value) =>
      value === "P1-01" ? "P1-02" : value,
    );
    ok(b2, ...secondWorking);
    revisionRequest(root);
    const directory = join(root, ".crewplane-state/supervisor");
    mkdirSync(directory, { recursive: true });
    const state = join(directory, "state.json");
    writeFileSync(
      state,
      JSON.stringify({
        records: {
          newer: { lane: "B", task: "P1-02", cwd: b2, status: "running" },
        },
      }),
    );
    expect(cli(b, ...working).error).toContain("running native record");
    const checkpoint = ok(
      b2,
      "checkpoint",
      "--agent",
      "B",
      "--task",
      "P1-02",
      "--text",
      "Synthetic work saved; yielding only after this native turn finishes",
    );
    expect(checkpoint.state).toBe("blocked");
    expect(checkpoint.checkpointed).toBe(true);
    expect(ok(root, "board").tasks[1].status.checkpointed).toBe(true);
    expect(cli(b, ...working).error).toContain("running native record");
    writeFileSync(
      state,
      JSON.stringify({
        records: {
          newer: { lane: "B", task: "P1-02", cwd: b2, status: "idle" },
        },
      }),
    );
    ok(b, ...working);
    expect(cli(b2, ...secondWorking).error).toContain(
      "already has active task P1-01",
    );
    ok(b, ...ready);
    ok(b2, ...secondWorking);
    const rows = ok(root, "board").tasks;
    expect(rows[0].claim.worktree).toBe(b);
    expect(rows[1].claim.worktree).toBe(b2);
    expect(rows[0].status.state).toBe("ready");
    expect(rows[1].status.checkpointed).toBeUndefined();
  });
});

it("refuses known path overlap across lanes while permitting unknown legacy scopes", async () => {
  await fixture(({ root }) => {
    writeFileSync(
      join(root, "tasks/P1-02.md"),
      "Owner lane: C.\nAllowed paths: synthetic/**.\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-qm", "test: declare disjoint lane fixture");
    scope(root, "P1-01", ["shared"]);
    scope(root, "P1-02", ["shared/child"]);
    assign(root);
    const assignC = [
      "assign",
      "--agent",
      "coordinator",
      "--task",
      "P1-02",
      "--owner",
      "C",
      "--ref",
      "HEAD",
      "--text",
      "Synthetic C assignment",
    ];
    expect(cli(root, ...assignC).error).toContain("scopes overlap with P1-01");
    scope(root, "P1-02", ["separate"]);
    ok(root, ...assignC);
    expect(
      cli(
        root,
        "scope",
        "--agent",
        "coordinator",
        "--task",
        "P1-02",
        "--paths-json",
        '["shared"]',
      ).error,
    ).toContain("scopes overlap with P1-01");
  });
  await fixture(({ root }) => {
    writeFileSync(join(root, "tasks/P1-02.md"), "Owner lane: C.\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "test: retain legacy scope fixture");
    assign(root);
    expect(
      ok(
        root,
        "assign",
        "--agent",
        "coordinator",
        "--task",
        "P1-02",
        "--owner",
        "C",
        "--ref",
        "HEAD",
        "--text",
        "Legacy unknown scope retains protocol ownership",
      ).owner,
    ).toBe("C");
  });
});
it("closes serviced corrections and rejects stale reopening or releasing native work", async () => {
  await fixture(({ root, b }) => {
    assign(root);
    ok(b, ...claim);
    ok(b, ...ready);
    expect(
      cli(
        root,
        "send",
        "--agent",
        "coordinator",
        "--to",
        "B",
        "--kind",
        "request",
        "--task",
        "P1-01",
        "--text",
        "Unpinned correction",
      ).code,
    ).toBe(1);
    const request = revisionRequest(root);
    ok(b, ...ready);
    expect(
      ok(root, "board").unanswered.some(
        (m: { id: string }) => m.id === request.id,
      ),
    ).toBe(true);
    ok(b, ...working);
    writeFileSync(join(b, "correction.txt"), "Synthetic corrected content\n");
    git(b, "add", ".");
    git(b, "commit", "-qm", "fix(test): correct synthetic source");
    ok(b, ...ready);
    const board = ok(root, "board");
    expect(
      board.unanswered.some((m: { id: string }) => m.id === request.id),
    ).toBe(false);
    expect(cli(b, ...working).code).toBe(1);
    const store = ok(root, "init").store;
    mkdirSync(join(store, "supervisor"), { recursive: true });
    writeFileSync(
      join(store, "supervisor/state.json"),
      JSON.stringify({
        records: { old: { task: "P1-01", lane: "B", status: "running" } },
      }),
    );
    expect(
      cli(
        root,
        "release",
        "--agent",
        "coordinator",
        "--task",
        "P1-01",
        "--text",
        "Synthetic release",
      ).error,
    ).toContain("running native record");
    expect(ok(root, "board").tasks).toHaveLength(1);
  });
});
it("discovers explicit reviewer prompts from subdirectories and linked worktrees", async () => {
  await fixture(({ root, b }) => {
    writeFileSync(
      join(root, "crewplane.json"),
      JSON.stringify({
        version: 1,
        coordinator: "coordinator",
        reviewers: ["visual", "inspector"],
        reviewerRoles: { visual: "code", inspector: "visual" },
        tasksPath: "tasks",
      }),
    );
    mkdirSync(join(root, "nested"));
    mkdirSync(join(b, "nested"));
    for (const cwd of [join(root, "nested"), join(b, "nested")]) {
      expect(cli(cwd, "prompt", "inspector").output).toContain(
        "visual and interaction verifier",
      );
      expect(cli(cwd, "prompt", "visual").output).toContain(
        "exact requested commit",
      );
    }
  });
});
it("ignores inherited repository selectors for coordination Git commands", async () => {
  await fixture(({ root, b }) => {
    assign(root);
    const result = spawnSync(process.execPath, [script, ...claim], {
      cwd: b,
      env: { ...env, GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root },
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const claimed = JSON.parse(result.stdout);
    expect(claimed.worktree).toBe(b);
    expect(claimed.branch).toBe("worker-B");
  });
});
it("explicitly closes only current-assignment author and reviewer threads on release", async () => {
  await fixture(({ root, b }) => {
    const assigned = assign(root);
    ok(b, ...claim);
    ok(b, ...ready);
    const author = revisionRequest(root);
    const reviewer = ok(
      root,
      "send",
      "--agent",
      "coordinator",
      "--to",
      "reviewer",
      "--kind",
      "request",
      "--task",
      "P1-01",
      "--commit",
      "HEAD",
      "--text",
      "Synthetic exact review",
    );
    expect(reviewer.assignmentId).toBe(assigned.id);
    const generic = ok(
      root,
      "send",
      "--agent",
      "coordinator",
      "--to",
      "B",
      "--kind",
      "request",
      "--text",
      "Generic unrelated thread",
    );
    const store = ok(root, "init").store;
    const stale = {
      ...author,
      id: "00000000-0000-4000-8000-000000000001",
      assignmentId: "archived-assignment",
    };
    writeFileSync(
      join(store, "messages", `${stale.id}.json`),
      JSON.stringify(stale),
    );
    ok(
      root,
      "release",
      "--agent",
      "coordinator",
      "--task",
      "P1-01",
      "--text",
      "Synthetic abandonment",
    );
    const board = ok(root, "board");
    expect(board.tasks).toHaveLength(0);
    const pending = board.unanswered.map((m: { id: string }) => m.id);
    expect(pending).toContain(generic.id);
    expect(pending).toContain(stale.id);
    expect(pending).not.toContain(author.id);
    expect(pending).not.toContain(reviewer.id);
    for (const id of [author.id, reviewer.id]) {
      const closure = board.messages.find(
        (m: { replyTo: string }) => m.replyTo === id,
      );
      expect(closure.kind).toBe("answer");
      expect(closure.assignmentId).toBe(assigned.id);
      expect(closure.text).toContain(
        "No task completion or review is inferred",
      );
    }
  });
});
it("inherits threaded answer task and assignment scope while constraining recipients", async () => {
  await fixture(({ root, b }) => {
    const assignment = assign(root);
    ok(b, ...claim);
    const question = ok(
      b,
      "send",
      "--agent",
      "B",
      "--to",
      "C",
      "--kind",
      "question",
      "--task",
      "P1-01",
      "--text",
      "Synthetic peer dependency",
    );
    expect(question.assignmentId).toBe(assignment.id);
    const answer = ok(
      root,
      "send",
      "--agent",
      "C",
      "--to",
      "B",
      "--kind",
      "answer",
      "--reply-to",
      question.id,
      "--text",
      "Synthetic resolution",
    );
    expect(answer.task).toBe("P1-01");
    expect(answer.assignmentId).toBe(assignment.id);
    for (const extra of [
      ["--task", "P1-02"],
      ["--to", "all"],
    ]) {
      const args = [
        "send",
        "--agent",
        "C",
        "--to",
        "B",
        "--kind",
        "answer",
        "--reply-to",
        question.id,
        "--text",
        "Contradictory scope",
      ];
      if (extra[0] === "--to") args[4] = "all";
      else args.push(...extra);
      expect(cli(root, ...args).code).toBe(1);
    }
    const broadcast = ok(
      b,
      "send",
      "--agent",
      "B",
      "--to",
      "all",
      "--kind",
      "question",
      "--task",
      "P1-01",
      "--text",
      "Synthetic broadcast dependency",
    );
    expect(
      ok(
        root,
        "send",
        "--agent",
        "C",
        "--to",
        "all",
        "--kind",
        "answer",
        "--reply-to",
        broadcast.id,
        "--text",
        "Shared resolution",
      ).task,
    ).toBe("P1-01");
    expect(
      ok(
        root,
        "send",
        "--agent",
        "coordinator",
        "--to",
        "B",
        "--kind",
        "answer",
        "--task",
        "P1-01",
        "--text",
        "Task-specific coordinator decision",
      ).assignmentId,
    ).toBe(assignment.id);
    const generic = ok(
      b,
      "send",
      "--agent",
      "C",
      "--to",
      "D",
      "--kind",
      "question",
      "--text",
      "Generic unrelated question",
    );
    expect(
      cli(
        root,
        "send",
        "--agent",
        "D",
        "--to",
        "C",
        "--kind",
        "answer",
        "--reply-to",
        generic.id,
        "--task",
        "P1-01",
        "--text",
        "Invented task association",
      ).code,
    ).toBe(1);
    ok(
      root,
      "release",
      "--agent",
      "coordinator",
      "--task",
      "P1-01",
      "--text",
      "Synthetic reassignment",
    );
    const replacement = assign(root);
    const stale = ok(
      root,
      "send",
      "--agent",
      "C",
      "--to",
      "B",
      "--kind",
      "answer",
      "--reply-to",
      question.id,
      "--text",
      "Late old-assignment answer",
    );
    expect(stale.assignmentId).toBe(assignment.id);
    expect(stale.assignmentId).not.toBe(replacement.id);
  });
});
it("allows checkpoint and blocked resume with a third unclaimed or checkpointed sibling", async () => {
  for (const checkpointThird of [false, true])
    await fixture(({ root, b, b2, dir }) => {
      writeFileSync(
        join(root, "tasks/P1-03.md"),
        "Owner lane: B.\nSynthetic third independent slice.\n",
      );
      git(root, "add", ".");
      git(root, "commit", "-qm", "test(tasks): define third sibling");
      for (const worktree of [b, b2])
        git(worktree, "merge", "--ff-only", git(root, "rev-parse", "HEAD"));
      assign(root);
      scope(root, "P1-01", ["first"]);
      scope(root, "P1-02", ["second"]);
      scope(root, "P1-03", ["third"]);
      ok(b, ...claim);
      ok(b, ...ready);
      expect(second(root).code).toBe(0);
      ok(b2, ...claimSecond);
      ok(b2, ...ready.map((v) => (v === "P1-01" ? "P1-02" : v)));
      ok(
        root,
        "assign",
        "--agent",
        "coordinator",
        "--task",
        "P1-03",
        "--owner",
        "B",
        "--ref",
        "HEAD",
        "--text",
        "Synthetic third task",
      );
      if (checkpointThird) {
        const b3 = join(dir, "B3");
        git(root, "worktree", "add", "-qb", "worker-B3", b3, "HEAD");
        ok(b3, "claim", "--agent", "B", "--task", "P1-03");
        ok(
          b3,
          "checkpoint",
          "--agent",
          "B",
          "--task",
          "P1-03",
          "--text",
          "Safe third checkpoint",
        );
      }
      revisionRequest(root, "P1-02");
      ok(b2, ...working.map((v) => (v === "P1-01" ? "P1-02" : v)));
      ok(
        b2,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-02",
        "--state",
        "blocked",
        "--text",
        "Synthetic blocker",
      );
      revisionRequest(root);
      ok(
        b2,
        "checkpoint",
        "--agent",
        "B",
        "--task",
        "P1-02",
        "--text",
        "Yield second task",
      );
      ok(b, ...working);
      ok(b, ...ready);
      ok(b2, ...working.map((v) => (v === "P1-01" ? "P1-02" : v)));
    });
});
it("requires task owners to scope questions and refuses release for retained identities", async () => {
  await fixture(({ root, b }) => {
    assign(root);
    expect(
      cli(
        b,
        "send",
        "--agent",
        "B",
        "--to",
        "C",
        "--kind",
        "question",
        "--text",
        "Unscoped blocker",
      ).error,
    ).toContain("--task");
    expect(
      ok(
        b,
        "send",
        "--agent",
        "B",
        "--to",
        "C",
        "--kind",
        "question",
        "--task",
        "P1-01",
        "--text",
        "Scoped blocker",
      ).task,
    ).toBe("P1-01");
    const store = ok(root, "init").store;
    mkdirSync(join(store, "supervisor"), { recursive: true });
    for (const identity of [
      { pid: 123 },
      { processGroupId: 123 },
      { cleanupUnverified: true },
    ]) {
      writeFileSync(
        join(store, "supervisor/state.json"),
        JSON.stringify({
          records: {
            old: { task: "P1-01", lane: "B", status: "paused", ...identity },
          },
        }),
      );
      expect(
        cli(
          root,
          "release",
          "--agent",
          "coordinator",
          "--task",
          "P1-01",
          "--text",
          "Unsafe replacement",
        ).code,
      ).toBe(1);
      expect(ok(root, "board").tasks).toHaveLength(1);
    }
  });
});
it("respects a live board mutation owner and recovers a killed lock holder", async () => {
  await fixture(async ({ root }) => {
    const store = ok(root, "init").store;
    const lock = join(store, "board-mutation.lock");
    const module = new URL("../process-lock.ts", import.meta.url).href;
    const hold = async () => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { withProcessLock } from ${JSON.stringify(module)}; await withProcessLock(${JSON.stringify(lock)}, async () => { console.log("LOCKED"); await new Promise(resolve => process.stdin.once("data", resolve)); process.stdin.destroy(); });`,
        ],
        { cwd: root, env },
      );
      const closed = new Promise<number | null>((resolve) =>
        child.once("close", resolve),
      );
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      return { child, closed };
    };
    const live = await hold();
    try {
      let completed = false;
      const command = race(
        root,
        "scope",
        "--agent",
        "coordinator",
        "--task",
        "P1-01",
        "--paths-json",
        '["first"]',
      ).then((result) => {
        completed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completed).toBe(false);
      expect(readFileSync(lock, "utf8")).toContain(String(live.child.pid));
      live.child.stdin.write("release");
      expect(await live.closed).toBe(0);
      expect((await command).code).toBe(0);
    } finally {
      live.child.kill("SIGKILL");
    }
    const dead = await hold();
    dead.child.kill("SIGKILL");
    await dead.closed;
    expect(readFileSync(lock, "utf8")).toContain(String(dead.child.pid));
    expect(
      ok(
        root,
        "scope",
        "--agent",
        "coordinator",
        "--task",
        "P1-01",
        "--paths-json",
        '["second"]',
      ).paths,
    ).toEqual(["second"]);
  });
});
