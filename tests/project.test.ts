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
import { main as coordination } from "../src/engine/agents.mjs";
import {
  discoverProject,
  projectPolicy,
  validId,
  validTaskId,
} from "../src/project.ts";

it("keeps configured roles and document paths explicit and rejects traversal/prototype IDs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-policy-")));
  try {
    expect(projectPolicy(root).coordinator).toBe("coordinator");
    for (const value of [
      "../x",
      "/absolute",
      "__proto__",
      "constructor",
      "all",
      "bad\nvalue",
    ])
      expect(validId(value)).toBe(false);
    expect(validTaskId("ISSUE-120")).toBe(true);
    expect(validTaskId("../ISSUE-120")).toBe(false);
    const valid = {
      version: 1,
      coordinator: "captain",
      reviewers: ["inspector"],
      tasksPath: "tickets",
    };
    writeFileSync(join(root, "crewplane.json"), JSON.stringify(valid));
    expect(projectPolicy(root)).toMatchObject(valid);
    for (const invalid of [
      { ...valid, reviewers: ["captain"] },
      { ...valid, coordinator: ["captain"] },
      { ...valid, tasksPath: "../private" },
      { ...valid, statusPath: "/etc/passwd" },
      { ...valid, roadmapFormat: "execute" },
    ]) {
      writeFileSync(join(root, "crewplane.json"), JSON.stringify(invalid));
      expect(() => projectPolicy(root)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("discovers one private store across linked worktrees and separate Git directories", async () => {
  const parent = realpathSync(
      mkdtempSync(join(tmpdir(), "crewplane-discovery-")),
    ),
    root = join(parent, "project"),
    other = join(parent, "worker");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  try {
    mkdirSync(root);
    git(
      root,
      "init",
      "-q",
      "--initial-branch=main",
      "--separate-git-dir",
      join(parent, "metadata"),
    );
    git(root, "config", "user.name", "Synthetic");
    git(root, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(root, "baseline.txt"), "Synthetic\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "test: baseline");
    git(root, "worktree", "add", "-qb", "worker", other);
    await coordination(["init"], root);
    const primary = discoverProject(root),
      linked = discoverProject(other);
    expect(linked.primary).toBe(root);
    expect(linked.store).toBe(primary.store);
    expect(linked.common).toBe(join(parent, "metadata"));
    const init = (await coordination(["init"], other)) as {
      projectRoot: string;
      store: string;
    };
    expect(init.projectRoot).toBe(root);
    expect(init.store).toBe(join(root, ".crewplane-state"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
it("refuses a legacy store with a matching repository identity but no Crewplane namespace", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-namespace-")),
  );
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const identity = discoverProject(root);
    mkdirSync(identity.store);
    writeFileSync(
      join(identity.store, "repository.json"),
      JSON.stringify({ schemaVersion: 1, gitCommonDir: identity.common }),
    );
    await expect(coordination(["init"], root)).rejects.toThrow(
      "different Git repository or protocol version",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
