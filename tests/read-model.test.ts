import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { controlDirectory } from "../src/control.ts";
import { main } from "../src/engine/agents.mjs";
import { evaluateOrchestration } from "../src/engine/orchestration.ts";
import { parseTask, snapshot } from "../src/engine/read-model.ts";
import { projectPolicy } from "../src/project.ts";

it("keeps real snapshots available when task history exceeds graph input limits", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-large-snapshot-")),
  );
  const previous = process.env.CREWPLANE_COORD_DIR;
  delete process.env.CREWPLANE_COORD_DIR;
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], {
      cwd: root,
      stdio: "pipe",
    });
    const { store } = (await main(["init"], root)) as { store: string };
    mkdirSync(join(root, "tasks"));
    for (let i = 0; i < 1002; i++) {
      const id = `HISTORY-${String(i).padStart(4, "0")}`,
        path = join(store, "tasks", id);
      mkdirSync(path);
      writeFileSync(
        join(root, "tasks", `${id}.md`),
        `# ${id}\nOwner: builder-${i}.\n`,
      );
      writeFileSync(
        join(path, "assignment.json"),
        JSON.stringify({
          task: id,
          owner: `builder-${i}`,
          baseCommit: "a".repeat(40),
          at: "2026-11-08T00:00:00.000Z",
          text: "Synthetic history",
        }),
      );
      if (i % 2 === 0)
        writeFileSync(
          join(path, "accepted.json"),
          JSON.stringify({
            commit: "a".repeat(40),
            at: "2026-11-08T00:01:00.000Z",
            text: "Synthetic accepted history",
          }),
        );
    }
    const view = await snapshot(root);
    expect(view.tasks).toHaveLength(1002);
    expect(view.graphCoverage).toMatchObject({
      tasksTotal: 1002,
      tasksIncluded: 1000,
      lanesTotal: 501,
      lanesIncluded: 64,
    });
    expect(view.graphs.dependencies.nodes.length).toBeLessThanOrEqual(1000);
  } finally {
    if (previous === undefined) delete process.env.CREWPLANE_COORD_DIR;
    else process.env.CREWPLANE_COORD_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it("uses task IDs for blank headings", () => {
  for (const markdown of [
    "\nOwner: builder",
    "#\nOwner: builder",
    "#   \nOwner: builder",
  ])
    expect(parseTask("T1", markdown).title).toBe("T1");
});
it("isolates invalid graph display data and inherited Git context from board reads", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-display-isolation-")),
  );
  const previous = process.env.GIT_DIR;
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    const { store } = (await main(["init"], root)) as { store: string };
    mkdirSync(join(root, "tasks"));
    mkdirSync(join(store, "tasks", "T1"));
    writeFileSync(join(root, "tasks/T1.md"), "\nOwner: builder\n");
    writeFileSync(
      join(store, "tasks/T1/assignment.json"),
      JSON.stringify({
        task: "T1",
        owner: "builder",
        baseCommit: "a".repeat(40),
        at: "2026-11-08T00:00:00Z",
        text: "Synthetic",
      }),
    );
    process.env.GIT_DIR = join(root, "missing-git-directory");
    let view = await snapshot(root);
    expect(view.tasks[0]?.title).toBe("T1");
    expect(view.graphCoverage.state).toBe("available");
    const scheduled = () =>
      evaluateOrchestration(
        view,
        {
          version: 1,
          running: true,
          checkedAt: new Date().toISOString(),
          pid: 1,
          draining: false,
          held: [],
          commands: [],
          notices: {},
          records: {},
        },
        {
          version: 1,
          root,
          binary: process.execPath,
          allowedTasks: ["T1"],
          maxParallel: 2,
          intervalSeconds: 1,
          maxRunMinutes: 1,
          maxRunsPerHour: 10,
          confirmedStoppedAt: new Date().toISOString(),
          lanes: { coordinator: { enabled: true }, builder: { enabled: true } },
        },
      );
    expect(scheduled().work.some((w) => w.task === "T1")).toBe(true);
    // Persisted legacy display metadata can fail graph validation without losing the board.
    mkdirSync(join(store, "messages"), { recursive: true });
    writeFileSync(
      join(store, "messages", "11111111-1111-4111-8111-111111111111.json"),
      JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        from: "builder",
        to: "captain",
        kind: "update",
        task: null,
        replyTo: null,
        at: "",
        text: "Synthetic legacy display",
      }),
    );
    view = await snapshot(root);
    expect(view.tasks).toHaveLength(1);
    expect(view.graphCoverage.state).toBe("unavailable");
    expect(view.graphs.dependencies.nodes).toEqual([]);
    expect(scheduled().work.some((w) => w.task === "T1")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses project documents that escape the root, are special files or exceed the read cap", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-read-hardening-")),
  );
  const outside = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-read-outside-")),
  );
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    mkdirSync(join(root, "tasks"));
    writeFileSync(join(outside, "secret.md"), "OUTSIDE_SENTINEL");
    symlinkSync(join(outside, "secret.md"), join(root, "tasks/ESC.md"));
    let view = await snapshot(root);
    expect(JSON.stringify(view)).not.toContain("OUTSIDE_SENTINEL");
    expect(view.documentProblems.map((p) => p.path)).toEqual(["tasks/ESC.md"]);
    rmSync(join(root, "tasks/ESC.md"));
    writeFileSync(join(root, "tasks/BIG.md"), "x".repeat(2 * 1024 * 1024));
    view = await snapshot(root);
    expect(view.documentProblems[0]?.reason).toContain("bounded regular file");
    expect(view.tasks.find((t) => t.id === "BIG")?.markdown).toBe("");
    rmSync(join(root, "tasks/BIG.md"));
    writeFileSync(join(root, "tasks/OK.md"), "# OK\n");
    symlinkSync(join(root, "tasks/OK.md"), join(root, "tasks/LINK.md"));
    expect((await snapshot(root)).tasks.map((task) => task.id)).toEqual([
      "LINK",
      "OK",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

it("does not fail the board snapshot for a symlinked-out or oversized status document", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-status-bad-")),
  );
  const outside = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-status-out-")),
  );
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    const statusPath = projectPolicy(root).statusPath;
    writeFileSync(join(outside, "s.md"), "OUTSIDE_SENTINEL");
    symlinkSync(join(outside, "s.md"), join(root, statusPath));
    let view = await snapshot(root);
    expect(view.milestoneStatus).toBe("");
    expect(view.documentProblems.map((p) => p.path)).toEqual([statusPath]);
    rmSync(join(root, statusPath));
    writeFileSync(join(root, statusPath), "x".repeat(2 * 1024 * 1024));
    view = await snapshot(root);
    expect(view.milestoneStatus).toBe("");
    expect(view.documentProblems).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

it("tolerates wrongly shaped supervisor state and config files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-shape-")));
  const previous = process.env.CREWPLANE_COORD_DIR;
  delete process.env.CREWPLANE_COORD_DIR;
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    await main(["init"], root);
    const control = controlDirectory(root);
    mkdirSync(control, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(control, "state.json"),
      JSON.stringify({ running: true, records: [], held: "x" }),
    );
    writeFileSync(join(control, "config.json"), "[]");
    const view = await snapshot(root);
    expect(view.headless.lanes).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CREWPLANE_COORD_DIR;
    else process.env.CREWPLANE_COORD_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it("adds planned cards only through an injected parser for the policy's roadmap format", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-plan-")));
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    writeFileSync(join(root, projectPolicy(root).planPath), "plan body");
    writeFileSync(
      join(root, "crewplane.json"),
      JSON.stringify({ ...projectPolicy(root), roadmapFormat: "relay" }),
    );
    const custom = (text: string, existing: Set<string>) =>
      text === "plan body" && !existing.has("X-1")
        ? [{ id: "X-1", markdown: "# X-1\nGoal: parsed\n" }]
        : [];
    expect((await snapshot(root)).tasks).toEqual([]);
    expect(
      (await snapshot(root, { planParsers: { other: custom } })).tasks,
    ).toEqual([]);
    const view = await snapshot(root, { planParsers: { relay: custom } });
    expect(view.tasks.map((task) => [task.id, task.goal])).toEqual([
      ["X-1", "parsed"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
