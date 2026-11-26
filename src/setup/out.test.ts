import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkOut, gitLimits } from "./out.ts";

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
