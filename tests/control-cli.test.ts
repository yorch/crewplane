import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlDirectory } from "../src/control.ts";
import { legacyRefusal } from "../src/migrate.ts";

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
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-ctl-cli-")));
  scratch.push(base);
  const root = join(base, "project");
  mkdirSync(root);
  const env = {
    ...process.env,
    CREWPLANE_COORD_DIR: "",
    CREWPLANE_STATE_DIR: join(base, "state"),
    CREWPLANE_NO_AUTO_UPDATE: "1",
    CREWPLANE_RELEASES_DIR: join(base, "releases-absent"),
  };
  execFileSync("git", ["init", "-q", "--initial-branch=main"], {
    cwd: root,
    env,
  });
  const store = join(root, ".crewplane-state");
  return {
    base,
    root,
    store,
    env,
    legacy: join(store, "supervisor"),
    control: controlDirectory(root, env),
    run: (runner: string[], ...args: string[]) =>
      spawnSync(
        runner[0] as string,
        [...runner.slice(1), "--project", root, ...args],
        {
          env,
          encoding: "utf8",
          timeout: 20000,
        },
      ),
  };
}
const validState = (extra: object = {}) => ({
  version: 2,
  running: false,
  checkedAt: "2000-01-01T00:00:00.000Z",
  pid: 2 ** 22 + 12345,
  draining: false,
  held: [],
  commands: [],
  records: {},
  notices: {},
  ...extra,
});
const seedLegacy = (legacy: string, state: object = validState()) => {
  mkdirSync(join(legacy, "commands"), { recursive: true, mode: 0o700 });
  writeFileSync(join(legacy, "state.json"), JSON.stringify(state));
};

describe.each(runners)("%s CLI", (_name, runner) => {
  it("refuses every state-touching command while a legacy layout exists", () => {
    const p = project();
    expect(p.run(runner, "init").status).toBe(0);
    seedLegacy(p.legacy);
    for (const args of [
      ["status"],
      ["configure", "--file", "x.json"],
      ["pause", "--all", "true"],
      ["resume", "--all", "true"],
      ["retry", "--lane", "a"],
      ["start"],
      ["agents", "board"],
      ["task", "list"],
      ["agent", "list"],
      ["evidence", "list"],
      ["monitor", "--status"],
      ["watchdog", "status"],
    ]) {
      const result = p.run(runner, ...args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr.split("\n")[0], args.join(" ")).toBe(
        `crewplane: ${legacyRefusal}`,
      );
    }
    // doctor is read-only, exempt from the gate, and reports the layout.
    const doctor = p.run(runner, "doctor");
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout).legacyLayout).toContain(
      "crewplane migrate",
    );
    // Commands that never touch supervisor state keep working.
    expect(p.run(runner, "--version").status).toBe(0);
    expect(p.run(runner, "--help").stdout).toContain("migrate [--dry-run]");
    expect(p.run(runner, "help").status).toBe(0);
    expect(p.run(runner, "init").status).toBe(0);
    // Nothing was created in the control location by the refusals.
    expect(existsSync(p.control)).toBe(false);
  });

  it("migrates, then serves status from the private directory", () => {
    const p = project();
    p.run(runner, "init");
    seedLegacy(p.legacy, validState({ marker: "legacy" }));
    const dry = JSON.parse(p.run(runner, "migrate", "--dry-run").stdout);
    expect(dry).toMatchObject({ status: "dry-run", to: p.control });
    expect(existsSync(p.control)).toBe(false);
    const done = JSON.parse(p.run(runner, "migrate").stdout);
    expect(done).toMatchObject({ status: "migrated", method: "rename" });
    expect(existsSync(p.legacy)).toBe(false);
    const status = JSON.parse(p.run(runner, "status").stdout);
    expect(status.state.marker).toBe("legacy");
    expect(JSON.parse(p.run(runner, "migrate").stdout).status).toBe(
      "nothing-to-migrate",
    );
    expect(p.run(runner, "migrate", "--bogus").status).toBe(1);
  });

  it("refuses to migrate under a live legacy supervisor and keeps halting it possible", () => {
    const p = project();
    p.run(runner, "init");
    seedLegacy(p.legacy, validState({ running: true, pid: process.pid }));
    const refused = p.run(runner, "migrate");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Refusing to migrate");
    expect(existsSync(join(p.legacy, "state.json"))).toBe(true);
    const stop = p.run(runner, "stop");
    expect(stop.status).toBe(0);
    expect(stop.stderr).toContain("older-release supervisor is live");
    // Narrowing verbs are queued in both candidate directories.
    expect(readdirSync(join(p.legacy, "commands"))).toHaveLength(1);
    expect(readdirSync(join(p.control, "commands"))).toHaveLength(1);
    const resume = p.run(runner, "resume", "--all", "true");
    expect(resume.status).toBe(1);
    expect(resume.stderr).toContain(legacyRefusal);
  });

  it("queues control verbs in the private directory, never in the store", () => {
    const p = project();
    p.run(runner, "init");
    const queued = JSON.parse(p.run(runner, "pause", "--all", "true").stdout);
    expect(readdirSync(join(p.control, "commands"))).toEqual([
      `${queued.id}.json`,
    ]);
    expect(existsSync(p.legacy)).toBe(false);
    // The directory is private to the user and not inside the project.
    expect(p.control.startsWith(p.root)).toBe(false);
  });

  it("refuses every verb a supervised child must not run", () => {
    const p = project();
    p.run(runner, "init");
    const child = { ...p.env, CREWPLANE_HEADLESS_LANE: "builder" };
    const run = (...args: string[]) =>
      spawnSync(
        runner[0] as string,
        [...runner.slice(1), "--project", p.root, ...args],
        { env: child, encoding: "utf8", timeout: 20000 },
      );
    for (const args of [
      ["configure", "--file", "x.json"],
      ["start"],
      ["dashboard", "--controls", "true"],
      ["pin", "--confirm", "true"],
      ["migrate"],
      ["migrate", "--dry-run"],
      ["update", "--check"],
      ["init"],
      ["pause", "--all", "true"],
      ["resume", "--all", "true"],
      ["stop"],
      ["cancel", "--all", "true"],
      ["retry", "--lane", "a"],
      ["nudge", "--lane", "a", "--text", "x"],
      ["rollout"],
      ["resolve", "--lane", "a"],
      ["watchdog", "start"],
      ["task", "create"],
      ["agent", "create"],
    ]) {
      const result = run(...args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr.split("\n")[0], args.join(" ")).toBe(
        "crewplane: This command is unavailable to headless agents",
      );
    }
    for (const args of [
      ["task", "list"],
      ["agent", "list"],
      ["doctor"],
      ["status"],
      ["agents", "board"],
      ["evidence", "list"],
    ])
      expect(run(...args).status, args.join(" ")).toBe(0);
    expect(existsSync(p.control)).toBe(false);
  });

  it("reviews a legacy configuration before adopting it and can set a forged directory aside", () => {
    const p = project();
    p.run(runner, "init");
    seedLegacy(p.legacy);
    const harness = join(p.base, "harness");
    writeFileSync(harness, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(
      join(p.legacy, "config.json"),
      JSON.stringify({
        version: 1,
        root: p.root,
        binary: harness,
        allowedTasks: ["EVIL-1"],
        maxParallel: 1,
        intervalSeconds: 5,
        maxRunMinutes: 5,
        maxRunsPerHour: 5,
        confirmedStoppedAt: new Date().toISOString(),
        lanes: { attacker: { enabled: true } },
      }),
    );
    const refused = p.run(runner, "migrate");
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("--accept-config true");
    expect(refused.stderr).toContain("EVIL-1");
    expect(refused.stderr).toContain("attacker");
    expect(existsSync(p.control)).toBe(false);
    const dry = p.run(runner, "migrate", "--dry-run");
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout).config.allowedTasks).toEqual(["EVIL-1"]);
    expect(dry.stderr).toContain("EVIL-1");
    const mixed = p.run(
      runner,
      "migrate",
      "--discard-legacy",
      "--accept-config",
      "true",
    );
    expect(mixed.status).toBe(1);
    const discarded = JSON.parse(
      p.run(runner, "migrate", "--discard-legacy").stdout,
    );
    expect(discarded.status).toBe("discarded");
    expect(existsSync(p.legacy)).toBe(false);
    expect(existsSync(discarded.discardedTo)).toBe(true);
    expect(p.run(runner, "status").status).toBe(0);
  });

  it("migrates with explicit acceptance and re-arms a pending narrowing command", () => {
    const p = project();
    p.run(runner, "init");
    seedLegacy(p.legacy);
    const id = "22222222-2222-4222-8222-222222222222";
    writeFileSync(
      join(p.legacy, "commands", `${id}.json`),
      JSON.stringify({
        action: "pause",
        all: true,
        at: new Date().toISOString(),
      }),
    );
    const report = JSON.parse(p.run(runner, "migrate").stdout);
    expect(report.rearmedCommands).toEqual([{ id, action: "pause" }]);
    expect(readdirSync(join(p.control, "commands"))).toEqual([`${id}.json`]);
    const status = JSON.parse(p.run(runner, "status").stdout);
    expect(status.view.pendingControls[0].action).toBe("pause");
  });

  it("binds the control directory to the project and fails closed on a mismatch", () => {
    const p = project();
    p.run(runner, "init");
    expect(p.run(runner, "pause", "--all", "true").status).toBe(0);
    expect(existsSync(join(p.store, "control-binding.json"))).toBe(true);
    expect(existsSync(join(p.control, "identity.json"))).toBe(true);
    // Different environment between start and later commands.
    const other = {
      ...p.env,
      CREWPLANE_STATE_DIR: join(p.base, "state-other"),
    };
    const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
      spawnSync(
        runner[0] as string,
        [...runner.slice(1), "--project", p.root, ...args],
        { env, encoding: "utf8", timeout: 20000 },
      );
    const differing = run(other, "configure", "--file", "x.json");
    expect(differing.status).toBe(1);
    expect(differing.stderr).toContain("records prior supervision");
    // A halt must not pretend to reach a supervisor that listens elsewhere.
    const halt = run(other, "stop");
    expect(halt.status).toBe(1);
    expect(halt.stderr).toContain("records prior supervision");
    expect(existsSync(controlDirectory(p.root, other))).toBe(false);
    const status = run(other, "status");
    expect(status.status).toBe(0);
    expect(status.stderr).toContain("records prior supervision");
    // A re-clone at the same path (fresh store) must not inherit the old control state.
    rmSync(join(p.store, "control-binding.json"));
    const reclone = p.run(runner, "pause", "--all", "true");
    expect(reclone.status).toBe(1);
    expect(reclone.stderr).toContain("different checkout");
    expect(p.run(runner, "start").status).toBe(1);
  });

  it("does not let a bad CREWPLANE_STATE_DIR break init", () => {
    const p = project();
    const result = spawnSync(
      runner[0] as string,
      [...runner.slice(1), "--project", p.root, "init"],
      { env: { ...p.env, CREWPLANE_STATE_DIR: "relative" }, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });

  it("refuses an unsafe control directory and a relative state override", () => {
    const p = project();
    p.run(runner, "init");
    p.run(runner, "pause", "--all", "true");
    chmodSync(p.control, 0o770);
    const unsafe = p.run(runner, "status");
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain("Unsafe control directory");
    chmodSync(p.control, 0o700);
    const relative = spawnSync(
      runner[0] as string,
      [...runner.slice(1), "--project", p.root, "status"],
      { env: { ...p.env, CREWPLANE_STATE_DIR: "relative" }, encoding: "utf8" },
    );
    expect(relative.status).toBe(1);
    expect(relative.stderr).toContain(
      "CREWPLANE_STATE_DIR must be an absolute path",
    );
  });
});
