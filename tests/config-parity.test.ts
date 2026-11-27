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
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlDirectory } from "../src/control.ts";
import { createDashboard, newSessionToken } from "../src/engine/dashboard.ts";

// `crewplane doctor` (the compiled executable) and GET /api/config share one
// inspection (src/doctor-config.ts). These tests keep that true end to end:
// the dashboard's problems and binary statuses must equal doctor's for the
// same project, in the same order.
const bin = resolve("dist/crewplane");
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { recursive: true, force: true });
});

interface DoctorReport {
  problems: Array<{ code: string; lane?: string; message: string }>;
  config: string;
  defaultBinary: { path: string | null; ok: boolean; problem?: string } | null;
  harnesses: Array<{
    id: string;
    binary: { path: string | null; ok: boolean; problem?: string };
    passEnv: string[];
  }>;
}

function project() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-parity-")));
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
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  Object.assign(env, {
    HOME: join(outer, "home"),
    XDG_CACHE_HOME: join(outer, "xdg-cache"),
    XDG_DATA_HOME: join(outer, "xdg-data"),
    CREWPLANE_CACHE_DIR: join(outer, "cache"),
    CREWPLANE_RELEASES_DIR: join(outer, "rel"),
    CREWPLANE_COORD_DIR: "",
    CREWPLANE_NO_AUTO_UPDATE: "1",
  });
  const run = (args: string[]) =>
    spawnSync(bin, ["--project", root, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    });
  const fake = (name: string, mode = 0o755) => {
    const path = join(tools, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, mode);
    return path;
  };
  const config = (binary: string, lanes: Record<string, unknown>) => ({
    version: 1,
    root,
    binary,
    allowedTasks: ["CP-1"],
    maxParallel: 1,
    intervalSeconds: 1,
    maxRunMinutes: 5,
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
  const init = () =>
    JSON.parse(run(["init"]).stdout) as { root: string; store: string };
  const storedConfig = () => join(controlDirectory(init().root), "config.json");
  // biome-ignore lint/suspicious/noExplicitAny: fixtures edit arbitrary config shapes.
  const edit = (change: (stored: Record<string, any>) => void) => {
    const path = storedConfig();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    change(stored);
    writeFileSync(path, JSON.stringify(stored));
  };
  /** Both views of the same project, in one environment. */
  const compare = async () => {
    const doctor = JSON.parse(run(["doctor"]).stdout) as DoctorReport;
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    const token = newSessionToken();
    const server = createDashboard(root, { session: { token } });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { "x-crewplane-session": token },
      });
      expect(response.status).toBe(200);
      const view = (await response.json()) as {
        state: string;
        problems: Array<{ code: string; lane: string | null; message: string }>;
        lanes: Array<{
          id: string;
          binary: {
            path: string | null;
            ok: boolean;
            problem: string | null;
          } | null;
        }>;
        binaries: Array<{
          harness: string;
          path: string | null;
          ok: boolean;
          code: string | null;
        }>;
      };
      return { doctor, view };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  };
  const same = ({ doctor, view }: Awaited<ReturnType<typeof compare>>) => {
    // Update-cache and releases-directory problems are about the CLI's own
    // environment, not the project's configuration; the dashboard omits them.
    const expected = doctor.problems
      .filter(
        (p) => !["CACHE_DIR_INVALID", "RELEASES_ROOT_INVALID"].includes(p.code),
      )
      .map((p) => ({ code: p.code, lane: p.lane ?? null, message: p.message }));
    expect(view.problems).toEqual(expected);
    expect(view.state).toBe(doctor.config);
    for (const lane of doctor.harnesses) {
      const mine = view.lanes.find((l) => l.id === lane.id);
      expect(mine?.binary).toMatchObject({
        path: lane.binary.path,
        ok: lane.binary.ok,
        problem: lane.binary.problem ?? null,
      });
    }
    const fallback = view.binaries.find((b) => b.harness === "default");
    if (doctor.defaultBinary)
      expect(fallback).toMatchObject({
        path: doctor.defaultBinary.path,
        ok: doctor.defaultBinary.ok,
      });
    return expected;
  };
  return {
    outer,
    root,
    tools,
    fake,
    config,
    configure,
    init,
    edit,
    compare,
    same,
  };
}

describe("GET /api/config matches crewplane doctor", () => {
  it("not configured: CONFIG_MISSING", async () => {
    const p = project();
    const codes = p.same(await p.compare()).map((item) => item.code);
    expect(codes).toEqual(["CONFIG_MISSING"]);
  });

  it("healthy configuration: no problems", async () => {
    const p = project();
    p.configure(
      p.config(p.fake("good"), {
        builder: { enabled: true, passEnv: ["AWS_PROFILE"] },
      }),
    );
    expect(p.same(await p.compare())).toEqual([]);
  });

  it("missing, non-executable, directory and unsafe binaries per lane", async () => {
    const p = project();
    const good = p.fake("good");
    const open = join(p.outer, "open");
    mkdirSync(open);
    const risky = join(open, "risky");
    writeFileSync(risky, "#!/bin/sh\nexit 0\n");
    chmodSync(risky, 0o755);
    chmodSync(open, 0o777);
    const dir = join(p.tools, "dir");
    mkdirSync(dir);
    p.configure(
      p.config(good, {
        a: { enabled: true },
        b: { enabled: true },
        c: { enabled: true },
        d: { enabled: true },
      }),
    );
    p.edit((stored) => {
      const claude = {
        model: "sonnet",
        claudePermissionMode: "plan",
        claudeMcp: "strict",
        claudeSettingSources: ["project"],
      };
      Object.assign(stored.lanes.b, { harness: "claude", ...claude });
      Object.assign(stored.lanes.c, { harness: "opencode", model: "x/y" });
      stored.lanes.d.harness = "pi";
      stored.lanes.d.piModel = { provider: "p", id: "m" };
      stored.lanes.d.sessionEpoch = "e";
      stored.binaries = {
        codex: risky,
        claude: join(p.tools, "gone"),
        opencode: p.fake("plain", 0o644),
        pi: dir,
      };
    });
    const result = await p.compare();
    const codes = p.same(result).map((item) => item.code);
    expect(codes).toContain("BINARY_UNSAFE");
    expect(codes).toContain("BINARY_MISSING");
    expect(codes).toContain("BINARY_NOT_EXECUTABLE");
    expect(codes).toContain("BINARY_INVALID");
    const unsafe = result.view.binaries.find((b) => b.code === "BINARY_UNSAFE");
    expect(unsafe?.path).toBe(risky);
    expect(unsafe?.ok).toBe(false);
  });

  it("invalid configuration and malformed lanes", async () => {
    const p = project();
    p.configure(
      p.config(p.fake("good"), { a: { enabled: true }, b: { enabled: true } }),
    );
    p.edit((stored) => {
      stored.lanes.a = null;
      stored.lanes.b.harness = "constructor";
    });
    const codes = p.same(await p.compare()).map((item) => item.code);
    expect(codes).toContain("CONFIG_INVALID");
  });

  it("unreadable configuration file", async () => {
    const p = project();
    p.configure(p.config(p.fake("good"), { a: { enabled: true } }));
    p.edit(() => {});
    const path = join(controlDirectory(p.init().root), "config.json");
    writeFileSync(path, "{ not json");
    const found = p.same(await p.compare());
    expect(found.map((item) => item.code)).toEqual(["CONFIG_INVALID"]);
  });

  it("legacy layout is reported first, alongside a valid configuration", async () => {
    const p = project();
    p.configure(p.config(p.fake("good"), { a: { enabled: true } }));
    const { store } = p.init();
    mkdirSync(join(store, "supervisor"), { recursive: true });
    writeFileSync(join(store, "supervisor", "state.json"), "{}");
    const found = p.same(await p.compare());
    expect(found.map((item) => item.code)).toEqual(["LEGACY_LAYOUT"]);
  });
});
