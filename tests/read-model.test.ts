import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { main } from "../src/engine/agents.mjs";
import { evaluateOrchestration } from "../src/engine/orchestration.ts";
import { parseTask, snapshot } from "../src/engine/read-model.ts";

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
