import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = resolve("dist/crewplane");
const baseEnv = {
  ...process.env,
  CREWPLANE_COORD_DIR: "",
  CREWPLANE_NO_AUTO_UPDATE: "1",
};
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { recursive: true, force: true });
});

interface Report {
  ok: boolean;
  runtime: string;
  config: string;
  problems: Array<{ code: string; lane?: string; message: string }>;
  defaultBinary: { path: string | null; ok: boolean; problem?: string } | null;
  globalInstructions: string;
  update: { retainedReleases: string };
  harnesses: Array<{
    id: string;
    instructions: string;
    passEnv: string[];
    binary: { path: string | null; ok: boolean; problem?: string };
  }>;
}

function project(options: { configure?: boolean; agentsFile?: boolean } = {}) {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-doctor-")));
  cleanup.push(outer);
  const root = join(outer, "project");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  if (options.agentsFile !== false)
    writeFileSync(join(root, "AGENTS.md"), "Synthetic guidance.\n");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-qm", "test: seed");
  const tools = join(outer, "tools");
  mkdirSync(tools);
  const fake = (name: string, mode = 0o755) => {
    const path = join(tools, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, mode);
    return path;
  };
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(bin, ["--project", root, ...args], {
      cwd: root,
      env: { ...baseEnv, CREWPLANE_RELEASES_DIR: join(outer, "rel"), ...env },
      encoding: "utf8",
    });
  const config = (binary: string, lanes: Record<string, unknown>) => ({
    version: 1,
    root,
    binary,
    allowedTasks: ["CP-1"],
    maxParallel: 1,
    intervalSeconds: 1,
    maxRunMinutes: 1,
    maxRunsPerHour: 20,
    confirmedStoppedAt: "2026-01-01T00:00:00Z",
    lanes,
  });
  const configure = (value: unknown) => {
    const file = join(outer, "runtime.json");
    writeFileSync(file, JSON.stringify(value));
    const result = run(["configure", "--file", file]);
    expect(result.status, result.stderr).toBe(0);
  };
  const storedConfig = () => {
    const store = (JSON.parse(run(["init"]).stdout) as { store: string }).store;
    return join(store, "supervisor", "config.json");
  };
  const doctor = (env: Record<string, string> = {}) => {
    const result = run(["doctor"], env);
    return {
      status: result.status,
      stderr: result.stderr,
      report: JSON.parse(result.stdout) as Report,
    };
  };
  return {
    outer,
    root,
    tools,
    fake,
    run,
    config,
    configure,
    storedConfig,
    doctor,
  };
}

describe("crewplane doctor", () => {
  it("reports a healthy project as ok with exit 0 and the real runtime", () => {
    const p = project();
    const good = p.fake("good-harness");
    p.configure(
      p.config(good, {
        builder: { enabled: true, passEnv: ["AWS_PROFILE"] },
      }),
    );
    const { status, report } = p.doctor();
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.runtime).toBe("compiled");
    expect(report.config).toBe("valid");
    expect(report.defaultBinary).toEqual({ path: good, ok: true });
    expect(report.harnesses[0]).toMatchObject({
      id: "builder",
      binary: { path: good, ok: true },
      passEnv: ["AWS_PROFILE"],
      instructions: "none",
    });
  });

  it("exits 2 with a stable code when the project is not configured", () => {
    const p = project();
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.config).toBe("not-configured");
    expect(report.problems.map((item) => item.code)).toEqual([
      "CONFIG_MISSING",
    ]);
    expect(report.problems[0]?.message).toContain("configure --file PATH");
  });

  it("probes each lane's binary without running it", () => {
    const p = project();
    const marker = join(p.outer, "ran");
    const good = p.fake("good");
    p.configure(
      p.config(good, {
        ok: { enabled: true },
        gone: { enabled: true },
        plain: { enabled: true },
        folder: { enabled: true },
      }),
    );
    // Replace the configured binary after validation: one lane per failure.
    const path = p.storedConfig();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    const missing = join(p.tools, "missing");
    const plain = p.fake("plain", 0o644);
    const dir = join(p.tools, "dir");
    mkdirSync(dir);
    // A script that records execution proves nothing ran it.
    writeFileSync(good, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(good, 0o755);
    stored.lanes.gone.harness = "claude";
    stored.lanes.plain.harness = "opencode";
    stored.lanes.folder.harness = "pi";
    stored.binaries = { claude: missing, opencode: plain, pi: dir };
    writeFileSync(path, JSON.stringify(stored));
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.ok).toBe(false);
    const byLane = Object.fromEntries(
      report.problems.map((item) => [item.lane ?? "-", item.code]),
    );
    expect(byLane).toMatchObject({
      gone: "BINARY_MISSING",
      plain: "BINARY_NOT_EXECUTABLE",
      folder: "BINARY_INVALID",
    });
    const lanes = Object.fromEntries(report.harnesses.map((h) => [h.id, h]));
    expect(lanes.ok?.binary).toEqual({ path: good, ok: true });
    expect(lanes.gone?.binary).toMatchObject({ path: missing, ok: false });
    expect(lanes.gone?.binary.problem).toContain("does not exist");
    expect(lanes.plain?.binary.ok).toBe(false);
    expect(lanes.folder?.binary.problem).toContain("regular file");
    expect(() => readFileSync(marker)).toThrow();
  });

  it("flags a relative binary path and falls back to config.binary only for codex", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { builder: { enabled: true } }));
    const path = p.storedConfig();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.binaries = { codex: "relative/codex" };
    stored.binary = "also-relative";
    writeFileSync(path, JSON.stringify(stored));
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.problems).toContainEqual({
      code: "BINARY_INVALID",
      lane: "builder",
      message: "codex binary path must be absolute",
    });
    expect(report.harnesses[0]?.binary.path).toBe("relative/codex");
    // The per-lane failure is not repeated for the shared default binary.
    expect(
      report.problems.filter((item) => item.code === "BINARY_INVALID"),
    ).toHaveLength(1);
  });

  it("reports unusable instruction files per lane and globally", () => {
    const p = project({ agentsFile: false });
    const good = p.fake("good");
    writeFileSync(join(p.root, "lane.md"), "lane guidance\n");
    p.configure(
      p.config(good, {
        builder: { enabled: true, instructionsPath: "lane.md" },
      }),
    );
    rmSync(join(p.root, "lane.md"));
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    const instructions = report.problems.filter(
      (item) => item.code === "INSTRUCTIONS_INVALID",
    );
    expect(instructions.map((item) => item.lane)).toEqual([
      "builder",
      undefined,
    ]);
    expect(report.harnesses[0]?.instructions).not.toBe("ok");
    expect(report.globalInstructions).not.toBe("ok");
  });

  it("turns an invalid releases directory into a problem instead of aborting", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { builder: { enabled: true } }));
    const { status, report } = p.doctor({
      CREWPLANE_RELEASES_DIR: "relative/dir",
    });
    expect(status).toBe(2);
    expect(report.problems).toEqual([
      expect.objectContaining({ code: "RELEASES_ROOT_INVALID" }),
    ]);
    expect(report.update.retainedReleases).toContain("(unavailable:");
    expect(report.config).toBe("valid");
  });

  it("turns an unreadable configuration into CONFIG_INVALID", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { builder: { enabled: true } }));
    writeFileSync(p.storedConfig(), "{not json");
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.config).toBe("invalid");
    expect(report.problems.map((item) => item.code)).toEqual([
      "CONFIG_INVALID",
    ]);
  });
});
