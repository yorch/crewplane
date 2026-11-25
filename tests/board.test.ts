import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { snapshot as wired } from "../src/board.ts";
import { snapshot as unwired } from "../src/engine/read-model.ts";
import { projectPolicy } from "../src/project.ts";

function project(roadmapFormat: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-board-")));
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  const policy = projectPolicy(root);
  writeFileSync(
    join(root, policy.planPath),
    "Intro\nIllustrative task IDs: P1-01 Auth; P1-02 Cache\n",
  );
  writeFileSync(
    join(root, "crewplane.json"),
    JSON.stringify({ ...policy, roadmapFormat }),
  );
  return root;
}

it("adds relay placeholder cards through the wired snapshot only", async () => {
  const root = project("relay");
  try {
    const view = await wired(root);
    expect(view.tasks.map((task) => [task.id, task.state])).toEqual([
      ["P1-01", "todo"],
      ["P1-02", "todo"],
    ]);
    expect(view.tasks[0]?.markdown).toContain("# P1-01 — Auth\n");
    // The core read model alone knows no profile.
    expect((await unwired(root)).tasks).toEqual([]);
    // Caller options never drop the registry.
    expect((await wired(root, {})).tasks).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a well-formed but unregistered roadmap format where the board is read", async () => {
  const root = project("execute");
  try {
    expect(projectPolicy(root).roadmapFormat).toBe("execute");
    await expect(wired(root)).rejects.toThrow(
      'Unsupported roadmapFormat "execute"; use "none" or one of: relay',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
