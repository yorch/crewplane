import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { main } from "../src/engine/agents.mjs";
import { gitEnvironment } from "../src/environment.ts";
import { discoverProject, validId } from "../src/project.ts";

it("does not accept agent names that collide with prototype-backed runtime dictionaries", () => {
  for (const id of [
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "constructor",
    "prototype",
  ])
    expect(validId(id)).toBe(false);
  expect(validId("builder-2")).toBe(true);
});
it("keeps transport/identity environment but strips Git repository selectors and injected config", () => {
  expect(
    gitEnvironment({
      PATH: "/tools",
      GIT_DIR: "/foreign",
      GIT_WORK_TREE: "/foreign",
      GIT_INDEX_FILE: "/foreign/index",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: "/foreign",
      GIT_AUTHOR_NAME: "Synthetic",
      GIT_SSH_COMMAND: "ssh",
    }),
  ).toEqual({
    PATH: "/tools",
    GIT_AUTHOR_NAME: "Synthetic",
    GIT_SSH_COMMAND: "ssh",
  });
});
it("discovers the explicitly selected project despite a foreign inherited Git directory", () => {
  const parent = realpathSync(
      mkdtempSync(join(tmpdir(), "crewplane-git-env-")),
    ),
    root = join(parent, "project"),
    foreign = join(parent, "foreign");
  const prior = process.env.GIT_DIR;
  try {
    for (const cwd of [root, foreign]) {
      mkdirSync(cwd);
      execFileSync("git", ["init", "-q"], {
        cwd,
        env: gitEnvironment(),
        stdio: "pipe",
      });
    }
    process.env.GIT_DIR = join(foreign, ".git");
    expect(discoverProject(root).root).toBe(root);
    expect(discoverProject(root).primary).toBe(root);
  } finally {
    if (prior === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prior;
    rmSync(parent, { recursive: true, force: true });
  }
});

it("canonicalizes trailing separators and symlinked ancestors for shared stores before CLI mutation", async () => {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-store-path-")),
  );
  const root = join(parent, "project"),
    actual = join(parent, "actual"),
    alias = join(parent, "alias");
  const previous = process.env.CREWPLANE_COORD_DIR;
  try {
    mkdirSync(root);
    mkdirSync(actual);
    symlinkSync(actual, alias, "dir");
    execFileSync("git", ["init", "-q"], {
      cwd: root,
      env: gitEnvironment(),
      stdio: "pipe",
    });
    for (const path of [
      `${join(actual, "store")}/`,
      `${join(alias, "nested", "store")}/`,
    ]) {
      process.env.CREWPLANE_COORD_DIR = path;
      const selected = discoverProject(root).store;
      expect(selected.endsWith("/")).toBe(false);
      expect(selected.startsWith(`${actual}/`)).toBe(true);
      const initialized = (await main(["init"], root)) as { store: string };
      expect(initialized.store).toBe(selected);
      await expect(
        main(
          [
            "send",
            "--agent",
            "coordinator",
            "--to",
            "all",
            "--kind",
            "update",
            "--text",
            "Synthetic canonical path",
          ],
          root,
        ),
      ).resolves.toMatchObject({ kind: "update" });
    }
  } finally {
    if (previous === undefined) delete process.env.CREWPLANE_COORD_DIR;
    else process.env.CREWPLANE_COORD_DIR = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});
