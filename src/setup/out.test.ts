import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkOut,
  gitLimits,
  prepareOut,
  staleTempAgeMs,
  sweepStaleOut,
} from "./out.ts";

const scratch: string[] = [];
afterEach(() => {
  gitLimits.timeoutMs = 10_000;
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const base = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-out-")));
  scratch.push(dir);
  return dir;
};
const cleanEnv = () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  return env;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: cleanEnv(), stdio: "pipe" });
const repo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--initial-branch=main");
  git(dir, "config", "user.name", "Synthetic");
  git(dir, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "test: seed");
};
const canChown = (() => {
  if (process.getuid?.() !== 0) return false;
  const dir = base();
  try {
    chownSync(dir, 65534, 65534);
    return true;
  } catch {
    return false;
  }
})();

it("accepts a path outside any repository", async () => {
  const dir = base();
  await expect(checkOut(join(dir, "out.json"), [])).resolves.toBeUndefined();
});

it("refuses when a .git file points to a gitdir that does not exist", async () => {
  const dir = base();
  writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "missing")}\n`);
  mkdirSync(join(dir, "sub"));
  await expect(checkOut(join(dir, "sub", "out.json"), [])).rejects.toThrow(
    /--out refused: git could not/,
  );
});

it("refuses when a .git entry exists but is not a usable repository", async () => {
  const dir = base();
  mkdirSync(join(dir, ".git"));
  await expect(checkOut(join(dir, "out.json"), [])).rejects.toThrow(
    /--out refused/,
  );
});

it.skipIf(!canChown)(
  "refuses a repository owned by another user (dubious ownership)",
  async () => {
    const dir = base();
    repo(join(dir, "r"));
    execFileSync("chown", ["-R", "65534:65534", join(dir, "r")]);
    await expect(checkOut(join(dir, "r", "out.json"), [])).rejects.toThrow(
      /--out refused: git could not/,
    );
  },
);

it("never runs a repository-configured core.fsmonitor", async () => {
  const dir = base();
  const marker = join(dir, "fsmonitor-ran");
  const script = join(dir, "fsm.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(script, 0o755);
  repo(join(dir, "r"));
  writeFileSync(join(dir, "r", ".gitignore"), "/out.json\n");
  git(join(dir, "r"), "config", "core.fsmonitor", script);
  await expect(
    checkOut(join(dir, "r", "out.json"), []),
  ).resolves.toBeUndefined();
  expect(existsSync(marker)).toBe(false);
});

it("refuses when git times out and kills git itself (helper processes git spawns are not tracked)", async () => {
  const dir = base();
  const tools = join(dir, "tools");
  mkdirSync(tools);
  const marker = join(dir, "git-started");
  // exec: the process that records its pid is the one that sleeps, so the kill
  // of the direct child is observable.
  writeFileSync(
    join(tools, "git"),
    `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 20\n`,
  );
  chmodSync(join(tools, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${tools}:${saved}`;
  gitLimits.timeoutMs = 300;
  try {
    await expect(checkOut(join(dir, "out.json"), [])).rejects.toThrow(
      /timed out/,
    );
  } finally {
    process.env.PATH = saved;
  }
  expect(existsSync(marker)).toBe(true);
  const pid = Number(readFileSync(marker, "utf8").trim());
  expect(pid).toBeGreaterThan(1);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(alive()).toBe(false);
});

const childScript = (dir: string, tail: string) => {
  const script = join(dir, "child.ts");
  writeFileSync(
    script,
    `import { prepareOut } from ${JSON.stringify(resolve("src/setup/out.ts"))};
await prepareOut(${JSON.stringify(join(dir, "out", "x.json"))}, "{}", []);
${tail}
`,
  );
  mkdirSync(join(dir, "out"));
  return script;
};
const leftovers = (dir: string) => readdirSync(join(dir, "out"));

for (const signal of ["SIGINT", "SIGTERM"] as const)
  it(`removes the hidden temporary file on ${signal} before commit`, () => {
    const dir = base();
    const script = childScript(
      dir,
      `process.kill(process.pid, ${JSON.stringify(signal)});\nawait new Promise((r) => setTimeout(r, 5000));`,
    );
    const result = spawnSync("bun", [script], {
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.signal).toBe(signal);
    expect(leftovers(dir)).toEqual([]);
  });

it("removes the hidden temporary file when the process exits before commit", () => {
  const dir = base();
  const script = childScript(dir, "process.exit(3);");
  const result = spawnSync("bun", [script], {
    encoding: "utf8",
    timeout: 20000,
  });
  expect(result.status).toBe(3);
  expect(leftovers(dir)).toEqual([]);
});

describe("stale temporary file sweep", () => {
  const hex = "0123456789ab";
  const tempName = (target = "x.json", id = hex) => `.${target}.${id}.tmp`;
  const plant = (dir: string, name: string, mode = 0o600) => {
    const file = join(dir, name);
    writeFileSync(file, "{}");
    chmodSync(file, mode);
    return file;
  };
  // Files are created now; "later" is the injected clock, since ctime cannot be set.
  const later = () => Date.now() + 2 * staleTempAgeMs;
  const names = (dir: string) => readdirSync(dir).sort();

  it("removes an old matching 0600 regular file and reports it", async () => {
    const dir = base();
    plant(dir, tempName());
    const removed = await sweepStaleOut(join(dir, "x.json"), { now: later });
    expect(removed).toEqual([tempName()]);
    expect(names(dir)).toEqual([]);
  });

  it("keeps a young file, including at exactly the age, and a clock before the file", async () => {
    const dir = base();
    const file = plant(dir, tempName());
    const born = Math.max(statSync(file).mtimeMs, statSync(file).ctimeMs);
    for (const at of [born, born + staleTempAgeMs, born - 10 * staleTempAgeMs])
      expect(
        await sweepStaleOut(join(dir, "x.json"), { now: () => at }),
      ).toEqual([]);
    expect(names(dir)).toEqual([tempName()]);
    // The age is configurable.
    expect(
      await sweepStaleOut(join(dir, "x.json"), {
        now: () => born + 11,
        maxAgeMs: 10,
      }),
    ).toEqual([tempName()]);
  });

  it("never removes a live concurrent setup's temp file through prepareOut", async () => {
    const dir = base();
    const live = await prepareOut(join(dir, "x.json"), "{}", []);
    const second = await prepareOut(join(dir, "x.json"), "{}", []);
    expect(names(dir)).toHaveLength(2);
    await live.discard();
    await second.discard();
    expect(names(dir)).toEqual([]);
  });

  it("keeps everything that is not exactly this target's own temp file", async () => {
    const dir = base();
    const keep: string[] = [];
    const add = (name: string, mode?: number) => {
      plant(dir, name, mode);
      keep.push(name);
    };
    add(tempName("y.json")); // different basename
    add(tempName("x.json", "0123456789AB")); // upper-case hex
    add(tempName("x.json", "0123456789a")); // short id
    add(tempName("x.json", "0123456789abc")); // long id
    add(`${tempName()}.bak`);
    add(`x${tempName()}`);
    add("x.json.0123456789ab.tmp"); // not hidden
    add(`.x.json.${hex}`); // no suffix
    add(`..x.json.${hex}.tmp`); // extra dot
    add(`.x.json.${hex}.tmp`.replace("x.json", "x.jsonn")); // longer basename
    add(".x.json..tmp");
    add(tempName("x.json", "1111111111ab"), 0o644);
    add(tempName("x.json", "2222222222ab"), 0o400);
    add(tempName("x.json", "3333333333ab"), 0o700);
    add(tempName("x.json", "4444444444ab"), 0o660);
    // A directory with a matching name, with content that must survive.
    mkdirSync(join(dir, tempName("x.json", "5555555555ab")));
    writeFileSync(join(dir, tempName("x.json", "5555555555ab"), "inner"), "i");
    // A symlink with a matching name to an old 0600 file elsewhere.
    const outside = base();
    const victim = plant(outside, "victim", 0o600);
    symlinkSync(victim, join(dir, tempName("x.json", "6666666666ab")));
    // A dangling symlink.
    symlinkSync(
      join(outside, "gone"),
      join(dir, tempName("x.json", "7777777777ab")),
    );
    // A hard-linked file (a commit in progress has two names).
    const linked = plant(dir, tempName("x.json", "8888888888ab"));
    linkSync(linked, join(outside, "second-name"));
    const before = names(dir);
    const removed = await sweepStaleOut(join(dir, "x.json"), { now: later });
    expect(removed).toEqual([]);
    expect(names(dir)).toEqual(before);
    expect(existsSync(victim)).toBe(true);
    expect(
      existsSync(join(dir, tempName("x.json", "5555555555ab"), "inner")),
    ).toBe(true);
    for (const name of keep) expect(existsSync(join(dir, name))).toBe(true);
  });

  it("sweeps only the target's directory, not subdirectories or other directories", async () => {
    const dir = base();
    mkdirSync(join(dir, "sub"));
    plant(join(dir, "sub"), tempName());
    const other = base();
    plant(other, tempName());
    plant(dir, tempName());
    expect(
      await sweepStaleOut(join(dir, "x.json"), { now: later }),
    ).toHaveLength(1);
    expect(names(join(dir, "sub"))).toEqual([tempName()]);
    expect(names(other)).toEqual([tempName()]);
  });

  it.skipIf(!canChown)("keeps an old file owned by another user", async () => {
    const dir = base();
    const file = plant(dir, tempName());
    chownSync(file, 65534, 65534);
    expect(await sweepStaleOut(join(dir, "x.json"), { now: later })).toEqual(
      [],
    );
    expect(existsSync(file)).toBe(true);
  });

  it("ignores failures: a missing directory, a throwing clock and an unreadable directory", async () => {
    const dir = base();
    expect(
      await sweepStaleOut(join(dir, "missing", "x.json"), { now: later }),
    ).toEqual([]);
    plant(dir, tempName());
    expect(
      await sweepStaleOut(join(dir, "x.json"), {
        now: () => {
          throw new Error("clock");
        },
      }),
    ).toEqual([]);
    expect(names(dir)).toEqual([tempName()]);
  });

  it("a failing sweep does not fail preparing --out, and a working one sweeps then writes", async () => {
    const dir = base();
    plant(dir, tempName());
    const failing = await prepareOut(join(dir, "x.json"), '{"a":1}', [], {
      now: () => {
        throw new Error("clock");
      },
    });
    await failing.commit();
    expect(readFileSync(join(dir, "x.json"), "utf8")).toBe('{"a":1}');
    expect(names(dir)).toEqual([tempName(), "x.json"]);
    const other = base();
    plant(other, tempName());
    const plan = await prepareOut(join(other, "x.json"), "{}", [], {
      now: later,
    });
    // The stale file is gone and only this run's own hidden file exists.
    expect(names(other)).toHaveLength(1);
    expect(names(other)[0]).not.toBe(tempName());
    await plan.commit();
    expect(names(other)).toEqual(["x.json"]);
  });

  it("never sweeps for a refused path", async () => {
    const dir = base();
    plant(dir, tempName());
    writeFileSync(join(dir, "x.json"), "existing");
    await expect(
      prepareOut(join(dir, "x.json"), "{}", [], { now: later }),
    ).rejects.toThrow(/Refusing to overwrite/);
    await expect(
      prepareOut(join(dir, "x.json"), "{}", [dir], { now: later }),
    ).rejects.toThrow();
    const guarded = base();
    plant(guarded, tempName("y.json"));
    await expect(
      prepareOut(join(guarded, "y.json"), "{}", [guarded], { now: later }),
    ).rejects.toThrow(/control or state directory/);
    const git = join(base(), ".git");
    mkdirSync(git);
    plant(git, tempName());
    await expect(
      prepareOut(join(git, "x.json"), "{}", [], { now: later }),
    ).rejects.toThrow();
    expect(names(dir)).toEqual([tempName(), "x.json"]);
    expect(names(guarded)).toEqual([tempName("y.json")]);
    expect(names(git)).toEqual([tempName()]);
  });
});
