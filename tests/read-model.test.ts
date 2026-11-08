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
import { snapshot } from "../src/engine/read-model.ts";

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
