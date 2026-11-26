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
import { controlDirectory } from "../src/control.ts";

const bin = resolve("dist/crewplane");
const cleanup: string[] = [];
/** A hermetic environment: no real HOME, caches, or inherited git context. */
const isolatedEnv = (outer: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  return {
    ...env,
    HOME: join(outer, "home"),
    XDG_CACHE_HOME: join(outer, "xdg-cache"),
    XDG_DATA_HOME: join(outer, "xdg-data"),
    CREWPLANE_CACHE_DIR: join(outer, "cache"),
    CREWPLANE_RELEASES_DIR: join(outer, "rel"),
    CREWPLANE_COORD_DIR: "",
    CREWPLANE_NO_AUTO_UPDATE: "1",
  };
};
afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { recursive: true, force: true });
});

interface Report {
  ok: boolean;
  runtime: string;
  config: string;
  problems: Array<{ code: string; lane?: string; message: string }>;
  warnings: Array<{ code: string; lane?: string; message: string }>;
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

function project() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-doctor-")));
  cleanup.push(outer);
  const root = join(outer, "project");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
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
      env: { ...isolatedEnv(outer), ...env },
      encoding: "utf8",
    });
  const runSource = (env: Record<string, string> = {}) =>
    spawnSync("bun", [resolve("src/cli.ts"), "--project", root, "doctor"], {
      cwd: root,
      env: { ...isolatedEnv(outer), ...env },
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
    const root = (JSON.parse(run(["init"]).stdout) as { root: string }).root;
    return join(controlDirectory(root), "config.json");
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
    runSource,
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
    // A missing global instructions file is a warning, never a failure.
    expect(report.warnings.map((item) => item.code)).toEqual([
      "INSTRUCTIONS_GLOBAL_UNAVAILABLE",
    ]);
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
    stored.lanes.gone.model = "sonnet";
    stored.lanes.gone.claudePermissionMode = "plan";
    stored.lanes.gone.claudeMcp = "strict";
    stored.lanes.gone.claudeSettingSources = ["project"];
    stored.lanes.plain.harness = "opencode";
    stored.lanes.plain.model = "anthropic/claude-sonnet-4";
    stored.lanes.folder.harness = "codex";
    stored.binaries = { claude: missing, opencode: plain, codex: dir };
    writeFileSync(path, JSON.stringify(stored));
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.config).toBe("valid");
    expect(report.problems.map((item) => item.code)).not.toContain(
      "CONFIG_INVALID",
    );
    const byLane = Object.fromEntries(
      report.problems.map((item) => [item.lane ?? "-", item.code]),
    );
    expect(byLane).toMatchObject({
      gone: "BINARY_MISSING",
      plain: "BINARY_NOT_EXECUTABLE",
      folder: "BINARY_INVALID",
    });
    const lanes = Object.fromEntries(report.harnesses.map((h) => [h.id, h]));
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
    // The top-level binary is probed itself, not through binaries.codex.
    expect(report.defaultBinary).toMatchObject({
      path: "also-relative",
      ok: false,
    });
    expect(report.problems).toContainEqual({
      code: "BINARY_INVALID",
      message: "default binary path must be absolute",
    });
  });

  it("reports unusable instruction files per lane and globally", () => {
    const p = project();
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
    expect(
      report.problems.filter((item) => item.code === "INSTRUCTIONS_INVALID"),
    ).toEqual([expect.objectContaining({ lane: "builder" })]);
    expect(report.harnesses[0]?.instructions).not.toBe("ok");
    expect(report.globalInstructions).not.toBe("ok");
    expect(report.warnings).toHaveLength(1);
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

  it("reports a missing binary together with other configuration errors", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(
      p.config(good, { builder: { enabled: true }, other: { enabled: true } }),
    );
    const path = p.storedConfig();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.lanes.builder.harness = "claude";
    stored.binaries = { claude: join(p.tools, "missing") };
    stored.lanes.other.maxRunsPerHour = 21;
    writeFileSync(path, JSON.stringify(stored));
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.config).toBe("invalid");
    const codes = report.problems.map((item) => item.code);
    expect(codes).toContain("BINARY_MISSING");
    expect(codes).toContain("CONFIG_INVALID");
  });

  it("probes the top-level binary even when binaries.codex is valid", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { builder: { enabled: true } }));
    const path = p.storedConfig();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.binaries = { codex: good };
    stored.binary = join(p.tools, "gone");
    stored.lanes = {};
    writeFileSync(path, JSON.stringify(stored));
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.defaultBinary).toMatchObject({ ok: false });
    expect(report.problems).toEqual([
      expect.objectContaining({ code: "BINARY_MISSING" }),
    ]);
    expect(report.problems[0]?.lane).toBeUndefined();
  });

  it("neither leaks engine errors nor aborts on a malformed lane", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { a: { enabled: true }, b: { enabled: true } }));
    const path = p.storedConfig();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.lanes.a = null;
    stored.lanes.b.harness = "constructor";
    writeFileSync(path, JSON.stringify(stored));
    const result = p.run(["doctor"]);
    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.problems).toContainEqual({
      code: "CONFIG_INVALID",
      lane: "a",
      message: "Lane is invalid",
    });
    expect(report.problems).toContainEqual({
      code: "CONFIG_INVALID",
      lane: "b",
      message: "Unsupported harness",
    });
    expect(result.stdout).not.toContain("evaluating");
    expect(result.stdout).not.toContain("BINARY_MISSING");
  });

  it("turns an invalid cache directory into a problem", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { builder: { enabled: true } }));
    const { status, report } = p.doctor({ CREWPLANE_CACHE_DIR: "relative" });
    expect(status).toBe(2);
    expect(report.problems).toEqual([
      expect.objectContaining({ code: "CACHE_DIR_INVALID" }),
    ]);
  });

  it("reports BINARY_UNSAFE per lane for a binary others could replace, never running it", () => {
    const p = project();
    const marker = join(p.outer, "ran");
    const good = p.fake("good");
    const open = join(p.outer, "open");
    mkdirSync(open);
    const risky = join(open, "risky");
    writeFileSync(risky, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(risky, 0o755);
    // World-writable without the sticky bit: any user could swap the file.
    chmodSync(open, 0o777);
    p.configure(
      p.config(good, { builder: { enabled: true }, safe: { enabled: true } }),
    );
    const path = p.storedConfig();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.lanes.safe.harness = "claude";
    stored.lanes.safe.model = "sonnet";
    stored.lanes.safe.claudePermissionMode = "plan";
    stored.lanes.safe.claudeMcp = "strict";
    stored.lanes.safe.claudeSettingSources = ["project"];
    stored.binaries = { codex: risky, claude: good };
    writeFileSync(path, JSON.stringify(stored));
    for (const { status, report } of [
      p.doctor(),
      (() => {
        const result = p.runSource();
        return {
          status: result.status,
          report: JSON.parse(result.stdout) as Report,
        };
      })(),
    ]) {
      expect(status).toBe(2);
      expect(report.ok).toBe(false);
      expect(report.config).toBe("valid");
      const unsafe = report.problems.filter(
        (item) => item.code === "BINARY_UNSAFE",
      );
      expect(unsafe).toEqual([
        {
          code: "BINARY_UNSAFE",
          lane: "builder",
          message: expect.stringMatching(
            /^codex binary refused: a directory on its path .* is world-writable without the sticky bit$/,
          ),
        },
      ]);
      expect(report.problems.map((item) => item.code)).toEqual([
        "BINARY_UNSAFE",
      ]);
      const lanes = Object.fromEntries(report.harnesses.map((h) => [h.id, h]));
      expect(lanes.builder?.binary).toMatchObject({ path: risky, ok: false });
      expect(lanes.safe?.binary).toEqual({ path: good, ok: true });
      // The top-level binary is safe and is probed on its own.
      expect(report.defaultBinary).toEqual({ path: good, ok: true });
    }
    expect(() => readFileSync(marker)).toThrow();
  });

  it("reports an unsafe top-level binary without a lane, once", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { builder: { enabled: true } }));
    chmodSync(good, 0o757);
    const { status, report } = p.doctor();
    expect(status).toBe(2);
    expect(report.problems).toEqual([
      {
        code: "BINARY_UNSAFE",
        lane: "builder",
        message: "codex binary refused: it is group- or world-writable",
      },
    ]);
    // The default binary names the same path, so it is not repeated.
    expect(report.defaultBinary).toMatchObject({ path: good, ok: false });
    const solo = project();
    const bin = solo.fake("good");
    solo.configure(solo.config(bin, { builder: { enabled: true } }));
    const stored = JSON.parse(readFileSync(solo.storedConfig(), "utf8"));
    const other = solo.fake("other");
    chmodSync(other, 0o757);
    stored.lanes = {};
    stored.binary = other;
    writeFileSync(solo.storedConfig(), JSON.stringify(stored));
    const alone = solo.doctor();
    expect(alone.status).toBe(2);
    expect(alone.report.problems).toEqual([
      {
        code: "BINARY_UNSAFE",
        message: "default binary refused: it is group- or world-writable",
      },
    ]);
  });

  it("reports runtime bun when run from source", () => {
    const p = project();
    const good = p.fake("good");
    p.configure(p.config(good, { builder: { enabled: true } }));
    const result = p.runSource();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.runtime).toBe("bun");
    expect(report.ok).toBe(true);
  });
});
