import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlDirectory } from "../src/control.ts";
import { PtyProcess, ptyUnavailable, removeLeakedPtyDirs } from "./pty.ts";

/**
 * The real CLI (source and compiled) driven through a genuine pseudo-terminal
 * on stdin and stdout, with stderr a separate pipe: prompts and echo go to
 * stderr, the one JSON report to stdout. Fake harness binaries write a marker
 * if they are ever executed; every test asserts they never were.
 */
const scratch: string[] = [];
const skipReason = ptyUnavailable();
// On CI an unusable pty must fail loudly, not silently drop the coverage;
// locally the tests skip with a warning.
const failWithoutPty = skipReason !== null && Boolean(process.env.CI);
if (skipReason && !failWithoutPty)
  console.warn(`setup pty tests skipped: ${skipReason}`);
// Directories leaked by earlier interrupted runs (older than a day).
if (!skipReason) removeLeakedPtyDirs();

it.runIf(failWithoutPty)("has a usable python3 pty on CI", () => {
  expect.fail(`pty tests cannot run on CI: ${skipReason}`);
});

describe("leaked crewplane-pty directory cleanup", () => {
  it("removes only old real crewplane-pty-* directories we own", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-cleanup-")));
    scratch.push(dir);
    const make = (name: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "inner"), "x");
    };
    for (const name of [
      "crewplane-pty-old",
      "crewplane-pty-young",
      "other-pty-old",
      "crewplane-out-old",
    ])
      make(name);
    writeFileSync(join(dir, "crewplane-pty-file"), "x");
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "crewplane-pty-link"));
    const day = 24 * 60 * 60 * 1000;
    // The clock is injected for "old": ctime cannot be backdated.
    const removed = removeLeakedPtyDirs(dir, day, Date.now() + 2 * day);
    expect(removed.sort()).toEqual([
      "crewplane-pty-old",
      "crewplane-pty-young",
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      "crewplane-out-old",
      "crewplane-pty-file",
      "crewplane-pty-link",
      "elsewhere",
      "other-pty-old",
    ]);
    // With the real clock nothing is a day old.
    make("crewplane-pty-fresh");
    expect(removeLeakedPtyDirs(dir, day)).toEqual([]);
    expect(removeLeakedPtyDirs(join(dir, "missing"))).toEqual([]);
  });
});

const live: PtyProcess[] = [];
afterEach(async () => {
  for (const proc of live.splice(0)) await proc.close();
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const runners: Array<[string, string[]]> = [
  ["source", ["bun", resolve("src/cli.ts")]],
  ["compiled", [resolve("dist/crewplane")]],
];

function project() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-pty-")));
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
    TERM: "xterm",
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
  const tools = join(base, "tools");
  mkdirSync(tools);
  const ranMarker = join(base, "harness-ran");
  const fake = join(tools, "codex");
  writeFileSync(fake, `#!/bin/sh\ntouch '${ranMarker}'\nexit 0\n`);
  chmodSync(fake, 0o755);
  return {
    root,
    env,
    fake,
    ranMarker,
    control: controlDirectory(root, env),
    /** A plain, non-terminal run, for init and doctor. */
    plain: (runner: string[], args: string[]) =>
      spawnSync(
        runner[0] as string,
        [...runner.slice(1), "--project", root, ...args],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    /** The wizard on a pseudo-terminal. */
    wizard: (runner: string[]) => {
      const proc = new PtyProcess([...runner, "--project", root, "setup"], {
        cwd: root,
        env,
      });
      live.push(proc);
      return proc;
    },
  };
}
type Project = ReturnType<typeof project>;

/** Wait for a prompt line on stderr, then type the answer. */
class Driver {
  offset = 0;
  constructor(readonly proc: PtyProcess) {}
  async answer(prompt: RegExp, text: string) {
    this.offset = await this.proc.expectStderr(
      new RegExp(`${prompt.source}[^\\n]*?: `),
      this.offset,
    );
    this.proc.send(`${text}\n`);
  }
  /** Wait for a prompt without answering it. */
  async reach(prompt: RegExp) {
    this.offset = await this.proc.expectStderr(
      new RegExp(`${prompt.source}[^\\n]*?: `),
      this.offset,
    );
  }
  /** Every prompt of the codex template up to, not including, the review. */
  async answerUntilReview(p: Project) {
    await this.answer(/Choice \(number or name\)/, "codex");
    await this.answer(/Absolute path to the codex executable/, p.fake);
    await this.answer(/Codex model/, "");
    await this.answer(/Implementer lane IDs/, "builder");
    await this.answer(/Allowed task IDs/, "CP-101");
    for (const limit of [
      "maxParallel",
      "intervalSeconds",
      "maxRunMinutes",
      "maxRunsPerHour",
    ])
      await this.answer(new RegExp(`${limit} \\(\\d+-\\d+\\)`), "");
    await this.answer(/Is the supervisor stopped\?/, "yes");
    await this.reach(/Looks right\? \(yes\/no\)/);
  }
}

const reportOf = (proc: PtyProcess) => JSON.parse(proc.tty.trim());
const nothingInstalled = (p: Project) => {
  expect(existsSync(join(p.control, "config.json"))).toBe(false);
  expect(existsSync(p.ranMarker)).toBe(false);
};

describe.skipIf(skipReason !== null).each(runners)(
  "setup wizard on a real pseudo-terminal (%s)",
  (_name, runner) => {
    const setup = (p: Project) => {
      expect(p.plain(runner, ["init"]).status).toBe(0);
      const proc = p.wizard(runner);
      return { proc, driver: new Driver(proc) };
    };

    it.each([
      [
        "an unsafe binary",
        (p: Project) => chmodSync(p.fake, 0o757),
        /^BINARY_INVALID$/,
      ],
      [
        "a removed binary",
        (p: Project) => unlinkSync(p.fake),
        /^BINARY_MISSING$/,
      ],
    ] as const)(
      "exits 2 with a BINARY_ problem on stdout when %s appears after the review and writes nothing",
      async (_label, spoil, code) => {
        const p = project();
        const { proc, driver } = setup(p);
        await driver.answerUntilReview(p);
        // The operator has seen the review; now the binary goes bad.
        spoil(p);
        proc.send("yes\n");
        await driver.answer(
          /Install into the private control directory now\?/,
          "yes",
        );
        await driver.answer(/Also write the JSON to a new file/, "");
        const exit = await proc.waitExit();
        expect(exit).toEqual({ code: 2, signal: null });
        // stdout (the terminal) is exactly one JSON document, no prompts.
        const report = reportOf(proc);
        expect(report).toMatchObject({
          version: 1,
          mode: "interactive",
          installed: false,
          written: null,
        });
        expect(report.problems.length).toBeGreaterThan(0);
        for (const problem of report.problems)
          expect(problem.code).toMatch(code);
        expect(proc.tty).not.toMatch(/Looks right|Crewplane guided setup/);
        // Prompts, the review and the problem lines are on stderr.
        expect(proc.stderr).toContain("Crewplane guided setup");
        expect(proc.stderr).toMatch(/crewplane: BINARY_[A-Z]+/);
        expect(proc.stderr).toContain(
          "nothing was written because verification found problems",
        );
        nothingInstalled(p);
        expect(existsSync(p.control)).toBe(false);
      },
      120000,
    );

    it.each([
      ["the first prompt", null],
      ["the review confirmation", true],
    ] as const)(
      "Ctrl+C at %s exits 1, says nothing was written, and writes nothing",
      async (_label, at) => {
        const p = project();
        const { proc, driver } = setup(p);
        if (at) {
          await driver.answerUntilReview(p); // stops at the review prompt
        } else await driver.reach(/Choice \(number or name\)/);
        proc.send("\u0003");
        const exit = await proc.waitExit();
        expect(exit).toEqual({ code: 1, signal: null });
        expect(proc.stderr).toContain("Setup cancelled; nothing was written");
        // No report: stdout carries nothing but terminal control sequences.
        expect(proc.tty.trim()).toBe("");
        expect(existsSync(p.control)).toBe(false);
        nothingInstalled(p);
      },
      120000,
    );

    it("a full wizard run installs, prints one JSON report on stdout, and doctor exits 0", async () => {
      const p = project();
      const { proc, driver } = setup(p);
      await driver.answerUntilReview(p);
      proc.send("yes\n");
      await driver.answer(
        /Install into the private control directory now\?/,
        "yes",
      );
      await driver.answer(/Also write the JSON to a new file/, "");
      expect(await proc.waitExit()).toEqual({ code: 0, signal: null });
      const report = reportOf(proc);
      expect(report).toMatchObject({
        version: 1,
        mode: "interactive",
        template: "codex",
        installed: true,
        confirmedStopped: true,
        written: null,
        problems: [],
      });
      expect(proc.tty).not.toMatch(/Looks right|Choice \(number/);
      expect(proc.stderr).toContain("Crewplane guided setup");
      const stored = JSON.parse(
        readFileSync(join(p.control, "config.json"), "utf8"),
      );
      expect(stored.binary).toBe(p.fake);
      expect(stored.allowedTasks).toEqual(["CP-101"]);
      const doctor = p.plain(runner, ["doctor"]);
      expect(doctor.status, doctor.stdout).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        ok: true,
        config: "valid",
      });
      expect(existsSync(p.ranMarker)).toBe(false);
    }, 120000);
  },
);
