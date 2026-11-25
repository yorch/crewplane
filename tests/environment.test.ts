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
import {
  gitEnvironment,
  harnessEnvironment,
  validPassEnvName,
} from "../src/environment.ts";
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
it("passes Git config location selectors but not counted or parameter overrides", () => {
  expect(
    gitEnvironment({
      GIT_CONFIG_GLOBAL: "/home/x/.gitconfig",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_PARAMETERS: "'core.worktree=/foreign'",
      GIT_CONFIG_COUNT: "0",
    }),
  ).toEqual({
    GIT_CONFIG_GLOBAL: "/home/x/.gitconfig",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
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

const secrets = {
  GITHUB_TOKEN: "synthetic",
  GH_TOKEN: "synthetic",
  AWS_ACCESS_KEY_ID: "synthetic",
  NPM_TOKEN: "synthetic",
  GIT_ASKPASS: "/usr/bin/askpass",
  GIT_TOKEN: "synthetic",
  GIT_SSH_COMMAND: "ssh -i /key",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  GNUPGHOME: "/home/synthetic/.gnupg",
  CLAUDE_CODE_MESSAGING_TOKEN: "synthetic",
  CLAUDE_CODE_SESSION_ID: "synthetic",
  CODEX_SANDBOX_NETWORK_DISABLED: "1",
  CREWPLANE_RELEASE_API: "http://127.0.0.1:1",
  CREWPLANE_DISPATCHED: "v1",
};
const common = {
  PATH: "/tools",
  HOME: "/home/synthetic",
  LC_ALL: "C",
  HTTPS_PROXY: "http://proxy.invalid",
  XDG_CONFIG_HOME: "/home/synthetic/.config",
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_DIR: "/foreign",
  CREWPLANE_RELEASES_DIR: "/releases",
};
it("forwards only the base, the harness's provider variables and explicit passEnv to harness children", () => {
  const input = {
    ...common,
    ...secrets,
    OPENAI_API_KEY: "synthetic",
    ANTHROPIC_API_KEY: "synthetic",
    CLAUDE_CONFIG_DIR: "/home/synthetic/.claude",
    CODEX_HOME: "/home/synthetic/.codex",
    OPENROUTER_API_KEY: "synthetic",
    EXTRA_OK: "yes",
  };
  const base = [
    "PATH",
    "HOME",
    "LC_ALL",
    "HTTPS_PROXY",
    "XDG_CONFIG_HOME",
    "GIT_AUTHOR_NAME",
    "CREWPLANE_RELEASES_DIR",
  ];
  expect(Object.keys(harnessEnvironment("codex", { input })).sort()).toEqual(
    [...base, "OPENAI_API_KEY", "CODEX_HOME"].sort(),
  );
  expect(Object.keys(harnessEnvironment("claude", { input })).sort()).toEqual(
    [...base, "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"].sort(),
  );
  const opted = harnessEnvironment("claude", {
    input,
    passEnv: ["AWS_ACCESS_KEY_ID", "EXTRA_OK", "SSH_AUTH_SOCK"],
  });
  expect(opted.AWS_ACCESS_KEY_ID).toBe("synthetic");
  expect(opted.EXTRA_OK).toBe("yes");
  expect(opted.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
  for (const name of Object.keys(secrets))
    if (name !== "SSH_AUTH_SOCK" && name !== "AWS_ACCESS_KEY_ID")
      expect(opted[name]).toBeUndefined();
});
it("derives a Pi or OpenCode provider key from the configured provider only", () => {
  const input = {
    ...common,
    OPENROUTER_API_KEY: "synthetic",
    GROQ_API_KEY: "synthetic",
  };
  expect(
    harnessEnvironment("pi", { input, provider: "openrouter" })
      .OPENROUTER_API_KEY,
  ).toBe("synthetic");
  expect(
    harnessEnvironment("pi", { input, provider: "openrouter" }).GROQ_API_KEY,
  ).toBeUndefined();
  expect(
    harnessEnvironment("codex", { input, provider: "openrouter" })
      .OPENROUTER_API_KEY,
  ).toBeUndefined();
});
it("matches names case-insensitively on Windows without letting repository selectors through", () => {
  const input = {
    Path: "C:\\tools",
    git_dir: "C:\\foreign",
    Github_Token: "x",
  };
  const env = harnessEnvironment("codex", { input, platform: "win32" });
  expect(env).toEqual({ PATH: "C:\\tools" });
});
it("validates passEnv names, including case variants of refused names", () => {
  for (const ok of [
    "AWS_PROFILE",
    "_X",
    "a1",
    "SSH_AUTH_SOCK",
    "CREWPLANE_FIXTURE_MODE",
  ])
    expect(validPassEnvName(ok)).toBe(true);
  for (const bad of [
    "",
    "1X",
    "A-B",
    "A=B",
    "NODE_OPTIONS",
    "node_options",
    "ld_preload",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PYTHONPATH",
    "CREWPLANE_COORD_DIR",
    "CREWPLANE_RELEASE_API",
    "crewplane_dispatched",
    "BASH_ENV",
    "BASH_FUNC_x",
    42,
  ])
    expect(validPassEnvName(bad)).toBe(false);
});
