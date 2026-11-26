import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlDirectory } from "../src/control.ts";
import { assertSwitch } from "../src/engine/harness.ts";

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
    // A card on disk names a different task and owner; neither may authorize anything.
    mkdirSync(join(p.root, "tasks"), { recursive: true });
    writeFileSync(join(p.root, "tasks/CP-999.md"), "# t\nOwner: sneaky.\n");
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
    expect(stored.allowedTasks).toEqual(["CP-101"]);
    expect(Object.keys(stored.lanes)).toEqual([
      "coordinator",
      "implementer",
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

  it("requires --tasks and fails closed without it", () => {
    const p = project();
    p.run(runner, ["init"]);
    mkdirSync(join(p.root, "tasks"), { recursive: true });
    writeFileSync(join(p.root, "tasks/CP-101.md"), "# t\nOwner: builder.\n");
    const result = p.run(runner, [
      "setup",
      "--non-interactive",
      "true",
      "--template",
      "codex",
      "--binary",
      p.fake,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/requires --tasks ID,ID/);
    expect(existsSync(p.control)).toBe(false);
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
    // The pre-check refuses to stamp a confirmation while the state says running.
    expect(refused.stderr).toMatch(
      /Refusing --confirm-stopped true: the control state says a supervisor is running/,
    );
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

  const base = (p: ReturnType<typeof project>) => [
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

  it("refuses --confirm-stopped while the state says running or a supervisor is live", () => {
    const p = project();
    p.run(runner, ["init"]);
    const args = [...base(p), "--confirm-stopped", "true"];
    expect(p.run(runner, args).status).toBe(0);
    mkdirSync(dirname(p.control), { recursive: true, mode: 0o700 });
    mkdirSync(p.control, { mode: 0o700 });
    writeFileSync(
      join(p.control, "state.json"),
      JSON.stringify({ running: true }),
    );
    const running = p.run(runner, args);
    expect(running.status).toBe(1);
    expect(running.stdout).toBe("");
    expect(running.stderr).toMatch(
      /Refusing --confirm-stopped true: the control state says a supervisor is running/,
    );
    // Not running by flag, but a recorded child process of ours is alive.
    const child = spawnSync("sleep", ["0"]); // ensure sleep exists
    expect(child.status).toBe(0);
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(
        join(p.control, "state.json"),
        JSON.stringify({
          running: false,
          records: {
            r: { lane: "coordinator", status: "running", pid: sleeper.pid },
          },
        }),
      );
      const live = p.run(runner, args);
      expect(live.status).toBe(1);
      expect(live.stderr).toMatch(/appears to be live/);
      // Without a confirmation setup still prints and stamps nothing.
      const printed = p.run(runner, base(p));
      expect(printed.status, printed.stderr).toBe(0);
      expect(JSON.parse(printed.stdout).confirmedStopped).toBe(false);
    } finally {
      sleeper.kill();
    }
  });

  it("a refused --install with --out leaves no file and a retry then succeeds", () => {
    const p = project();
    p.run(runner, ["init"]);
    const out = join(p.base, "runtime.json");
    const args = [
      ...base(p),
      "--confirm-stopped",
      "true",
      "--install",
      "true",
      "--out",
      out,
    ];
    expect(p.run(runner, args.slice(0, -2)).status).toBe(0);
    writeFileSync(
      join(p.control, "state.json"),
      JSON.stringify({ running: true }),
    );
    const refused = p.run(runner, args);
    expect(refused.status).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(p.base).filter((n) => n.includes("runtime"))).toEqual(
      [],
    );
    writeFileSync(
      join(p.control, "state.json"),
      JSON.stringify({ running: false }),
    );
    const retry = p.run(runner, args);
    expect(retry.status, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({
      installed: true,
      written: out,
    });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("--out refuses directories, missing parents, the control directory and tracked paths", () => {
    const p = project();
    p.run(runner, ["init"]);
    mkdirSync(dirname(p.control), { recursive: true, mode: 0o700 });
    mkdirSync(p.control, { mode: 0o700 });
    const cases: Array<[string, RegExp]> = [
      [p.base, /--out names a directory/],
      [join(p.base, "missing", "x.json"), /parent directory does not exist/],
      [join(p.control, "x.json"), /inside the Crewplane control or state/],
      [
        join(p.root, ".crewplane-state", "x.json"),
        /inside the Crewplane control or state/,
      ],
      [join(p.root, "runtime.json"), /not git-ignored/],
    ];
    for (const [out, pattern] of cases) {
      const result = p.run(runner, [...base(p), "--out", out]);
      expect(result.status, out).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr, out).toMatch(pattern);
    }
    expect(existsSync(join(p.root, "runtime.json"))).toBe(false);
    // A git-ignored path inside the repository is allowed, resolved against --project.
    writeFileSync(join(p.root, ".gitignore"), "/ignored.json\n");
    const ok = p.run(runner, [...base(p), "--out", "ignored.json"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).written).toBe(join(p.root, "ignored.json"));
  });

  it("rejects an unsafe explicit binary and never carries environment secrets anywhere", () => {
    const p = project();
    p.run(runner, ["init"]);
    chmodSync(p.fake, 0o775);
    const refused = p.run(runner, base(p));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(
      /codex binary refused: it is group- or world-writable/,
    );
    chmodSync(p.fake, 0o755);
    const secrets = {
      OPENAI_API_KEY: "sentinel-openai-0f1e",
      ANTHROPIC_API_KEY: "sentinel-anthropic-7a2b",
    };
    const out = join(p.base, "env.json");
    const result = p.run(
      runner,
      [
        ...base(p),
        "--confirm-stopped",
        "true",
        "--install",
        "true",
        "--out",
        out,
      ],
      secrets,
    );
    expect(result.status, result.stderr).toBe(0);
    const everything = [
      result.stdout,
      result.stderr,
      readFileSync(out, "utf8"),
      readFileSync(join(p.control, "config.json"), "utf8"),
    ].join("\n");
    for (const value of Object.values(secrets))
      expect(everything).not.toContain(value);
  });

  it("a rerun with a different harness installs lanes that pass the engine's assertSwitch via a fresh sessionEpoch", () => {
    const p = project();
    p.run(runner, ["init"]);
    const install = [
      ...base(p),
      "--confirm-stopped",
      "true",
      "--install",
      "true",
    ];
    expect(p.run(runner, install).status).toBe(0);
    // A drained idle record from the codex run exists in the state.
    writeFileSync(
      join(p.control, "state.json"),
      JSON.stringify({
        running: false,
        records: {
          r: {
            key: "k",
            lane: "coordinator",
            task: null,
            cwd: p.root,
            harness: "codex",
            status: "idle",
            reason: "",
            seen: [],
            runs: [],
            noProgress: 0,
          },
        },
      }),
    );
    const claude = join(p.base, "tools", "claude");
    writeFileSync(claude, `#!/bin/sh\ntouch '${p.ranMarker}'\nexit 0\n`);
    chmodSync(claude, 0o755);
    const switched = p.run(runner, [
      "setup",
      "--non-interactive",
      "true",
      "--template",
      "claude",
      "--claude-binary",
      claude,
      "--model",
      "opus",
      "--tasks",
      "CP-101",
      "--confirm-stopped",
      "true",
      "--install",
      "true",
    ]);
    expect(switched.status, switched.stderr).toBe(0);
    expect(switched.stderr).toMatch(
      /lane coordinator switches harness from codex to claude/,
    );
    const stored = JSON.parse(
      readFileSync(join(p.control, "config.json"), "utf8"),
    );
    expect(stored.lanes.coordinator.sessionEpoch).toMatch(
      /^setup-[0-9a-f]{12}$/,
    );
    expect(stored.lanes.coordinator.harness).toBe("claude");
    // The supervisor's own switch check (what `serve` applies) on the drained
    // idle codex record: accepted for the new lane, refused for a bare one.
    const previous = { harness: "codex", status: "idle" } as never;
    expect(() =>
      assertSwitch(stored.lanes.coordinator, previous, false),
    ).not.toThrow();
    expect(() =>
      assertSwitch(
        { ...stored.lanes.coordinator, sessionEpoch: undefined },
        previous,
        false,
      ),
    ).toThrow(/fresh explicit sessionEpoch/);
    // Printed once on stderr, not again by a second reporter.
    expect(
      switched.stderr.match(/lane coordinator switches harness/g),
    ).toHaveLength(1);
    expect(existsSync(p.ranMarker)).toBe(false);
    expect(p.run(runner, ["doctor"]).status).toBe(0);
  });
});
