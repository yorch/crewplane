import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlDirectory } from "../src/control.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const runners: Array<[string, string[]]> = [
  ["source", ["bun", resolve("src/cli.ts")]],
  ["compiled", [resolve("dist/crewplane")]],
];

function project() {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "crewplane-setup-e2e-")),
  );
  scratch.push(base);
  const root = join(base, "project");
  mkdirSync(root);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  Object.assign(env, {
    HOME: join(base, "home"),
    CREWPLANE_COORD_DIR: "",
    CREWPLANE_STATE_DIR: join(base, "state"),
    CREWPLANE_NO_AUTO_UPDATE: "1",
    CREWPLANE_CACHE_DIR: join(base, "cache"),
    CREWPLANE_RELEASES_DIR: join(base, "releases-absent"),
  });
  delete env.CREWPLANE_HEADLESS_LANE;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-qm", "test: seed");
  // Fake harness: records any execution; setup and doctor must never run it.
  const tools = join(base, "tools");
  mkdirSync(tools);
  const ranMarker = join(base, "harness-ran");
  const fake = join(tools, "codex");
  writeFileSync(fake, `#!/bin/sh\ntouch '${ranMarker}'\nexit 0\n`);
  chmodSync(fake, 0o755);
  return {
    base,
    root,
    env,
    fake,
    ranMarker,
    control: controlDirectory(root, env),
    run: (
      runner: string[],
      args: string[],
      extra: Record<string, string> = {},
    ) =>
      spawnSync(
        runner[0] as string,
        [...runner.slice(1), "--project", root, ...args],
        {
          cwd: root,
          env: { ...env, ...extra },
          encoding: "utf8",
          timeout: 30000,
          // Not a TTY: never lets a wizard wait for input.
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
  };
}

describe.each(runners)("setup (%s)", (_name, runner) => {
  it("installs a generated config that doctor accepts, without running the harness", () => {
    const p = project();
    expect(p.run(runner, ["init"]).status).toBe(0);
    mkdirSync(join(p.root, "tasks"), { recursive: true });
    writeFileSync(join(p.root, "tasks/CP-101.md"), "# t\nOwner: builder.\n");
    const setup = p.run(runner, [
      "setup",
      "--non-interactive",
      "true",
      "--template",
      "codex",
      "--binary",
      p.fake,
      "--tasks",
      "CP-101",
      "--confirm-stopped",
      "true",
      "--install",
      "true",
    ]);
    expect(setup.status, setup.stderr).toBe(0);
    // stdout is exactly one JSON document; human text is on stderr.
    const report = JSON.parse(setup.stdout);
    expect(report).toMatchObject({
      version: 1,
      installed: true,
      confirmedStopped: true,
      problems: [],
    });
    expect(setup.stderr).toContain("note:");
    const stored = JSON.parse(
      readFileSync(join(p.control, "config.json"), "utf8"),
    );
    expect(stored.binary).toBe(p.fake);
    expect(stored.root).toBe(p.root);
    expect(Object.keys(stored.lanes)).toEqual([
      "coordinator",
      "builder",
      "reviewer",
      "visual",
    ]);
    expect(Date.parse(stored.confirmedStoppedAt)).toBeGreaterThan(
      Date.now() - 60000,
    );
    const doctor = p.run(runner, ["doctor"]);
    expect(doctor.status, doctor.stdout).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      ok: true,
      config: "valid",
    });
    expect(existsSync(p.ranMarker)).toBe(false);
  });

  it("without a terminal or --non-interactive it fails instead of waiting", () => {
    const p = project();
    const result = p.run(runner, ["setup"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /crewplane: setup needs an interactive terminal/,
    );
  });

  it("prints by default and writes --out as a new 0600 file", () => {
    const p = project();
    p.run(runner, ["init"]);
    const args = [
      "setup",
      "--non-interactive",
      "true",
      "--template",
      "codex",
      "--binary",
      p.fake,
      "--tasks",
      "CP-101",
    ];
    const printed = p.run(runner, args);
    expect(printed.status, printed.stderr).toBe(0);
    expect(JSON.parse(printed.stdout).written).toBeNull();
    expect(existsSync(p.control)).toBe(false);
    const out = join(p.base, "runtime.json");
    const written = p.run(runner, [...args, "--out", out]);
    expect(written.status, written.stderr).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const again = p.run(runner, [...args, "--out", out]);
    expect(again.status).toBe(1);
    expect(again.stdout).toBe("");
    expect(again.stderr).toMatch(/Refusing to overwrite/);
    // The file is a valid input for configure (needs the stop time added).
    const file = JSON.parse(readFileSync(out, "utf8"));
    writeFileSync(
      out,
      JSON.stringify({ ...file, confirmedStoppedAt: new Date().toISOString() }),
    );
    expect(p.run(runner, ["configure", "--file", out]).status).toBe(0);
  });

  it("--install refuses while a supervisor is running and leaves the config alone", () => {
    const p = project();
    p.run(runner, ["init"]);
    const args = [
      "setup",
      "--non-interactive",
      "true",
      "--template",
      "codex",
      "--binary",
      p.fake,
      "--tasks",
      "CP-101",
      "--confirm-stopped",
      "true",
      "--install",
      "true",
    ];
    expect(p.run(runner, args).status).toBe(0);
    const before = readFileSync(join(p.control, "config.json"), "utf8");
    writeFileSync(
      join(p.control, "state.json"),
      JSON.stringify({ running: true }),
    );
    const refused = p.run(
      runner,
      args.map((a) => (a === "CP-101" ? "CP-102" : a)),
    );
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/Stop and inspect the existing supervisor/);
    expect(readFileSync(join(p.control, "config.json"), "utf8")).toBe(before);
  });

  it("is unavailable to headless agents, even with --install", () => {
    const p = project();
    p.run(runner, ["init"]);
    for (const args of [
      ["setup"],
      [
        "setup",
        "--non-interactive",
        "true",
        "--template",
        "codex",
        "--binary",
        p.fake,
        "--tasks",
        "A-1",
        "--confirm-stopped",
        "true",
        "--install",
        "true",
      ],
    ]) {
      const result = p.run(runner, args, {
        CREWPLANE_HEADLESS_LANE: "builder",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "crewplane: This command is unavailable to headless agents",
      );
    }
    expect(existsSync(p.control)).toBe(false);
  });
});
