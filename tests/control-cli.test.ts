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
const seedLegacy = (legacy: string, state: object = { running: false }) => {
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
      ["doctor"],
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
    seedLegacy(p.legacy, { running: false, marker: "legacy" });
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
    seedLegacy(p.legacy, { running: true, pid: process.pid });
    const refused = p.run(runner, "migrate");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Refusing to migrate");
    expect(existsSync(join(p.legacy, "state.json"))).toBe(true);
    const stop = p.run(runner, "stop");
    expect(stop.status).toBe(0);
    expect(stop.stderr).toContain("older-release supervisor is live");
    expect(readdirSync(join(p.legacy, "commands"))).toHaveLength(1);
    expect(existsSync(p.control)).toBe(false);
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
