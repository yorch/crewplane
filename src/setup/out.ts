import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { link, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { printablePath } from "../project.ts";

export interface OutPlan {
  /** The final path, as the operator named it. */
  path: string;
  /** Atomically publish the prepared file; never replaces an existing path. */
  commit(): Promise<void>;
  /** Remove the temporary file, and the final file when this run created it. */
  discard(): Promise<void>;
}

const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};
const realOrResolved = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
};
const within = (path: string, directory: string) =>
  path === directory || path.startsWith(directory + sep);

/** Mutable only so tests can shorten the spawn timeout. */
export const gitLimits = { timeoutMs: 10_000 };
/** The only answer that means "outside every repository" (C locale, see gitEnv). */
const notARepository = /not a git repository \(or any (?:of the )?parent/;

/** No inherited GIT_* configuration, no prompts, no index refresh writes. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
  };
}
// A repository's own configuration must never run code during setup:
// core.fsmonitor is executed by index-reading commands, hooks never apply.
const gitArgs = (...args: string[]) => [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  ...args,
];

/** True when `.git` (directory or file) exists in `start` or any ancestor. */
function gitMarkerAbove(start: string): boolean | "unreadable" {
  for (let directory = start; ; directory = dirname(directory)) {
    try {
      lstatSync(join(directory, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return "unreadable";
    }
    if (dirname(directory) === directory) return false;
  }
}

function gitIgnoreProblem(parent: string, target: string): string | null {
  const env = gitEnv();
  const run = (cwd: string, ...args: string[]) =>
    spawnSync("git", gitArgs(...args), {
      cwd,
      env,
      encoding: "utf8",
      timeout: gitLimits.timeoutMs,
      killSignal: "SIGKILL",
    });
  const top = run(parent, "rev-parse", "--show-toplevel");
  if (top.error)
    return (top.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? "git timed out while checking whether the path is ignored"
      : "git could not be run to check whether the path is ignored";
  if (top.status === 128 && notARepository.test(top.stderr ?? "")) {
    // Genuinely outside a repository, as far as git can tell. Do not trust
    // that alone: any `.git` above the target means a repository git could not
    // use (broken gitdir, unreadable, other filesystem), so refuse.
    const marker = gitMarkerAbove(parent);
    if (marker === false) return null;
    return "a .git entry exists above the path but git cannot use it as a repository";
  }
  if (top.status !== 0 || !top.stdout.trim())
    return "git could not report the work tree for the path (broken, unreadable or differently owned repository?)";
  const tree = top.stdout.trim();
  const ignored = run(tree, "check-ignore", "-q", "--", target);
  if (ignored.error || (ignored.status !== 0 && ignored.status !== 1))
    return "git could not check whether the path is ignored";
  if (ignored.status === 1)
    return `it is inside the git work tree ${printablePath(tree)} and is not git-ignored; choose a git-ignored path or one outside the repository`;
  return null;
}

/**
 * Every refusal for an `--out` target, checked before anything is written.
 * `protectedPaths` are the private control directory and the Crewplane stores.
 */
export async function checkOut(
  path: string,
  protectedPaths: readonly string[],
): Promise<void> {
  const shown = printablePath(path);
  if (/\p{Cc}/u.test(path))
    throw new Error("--out path contains control characters");
  try {
    const info = await lstat(path);
    throw new Error(
      info.isDirectory()
        ? `--out names a directory, not a file: ${shown}`
        : `Refusing to overwrite existing file: ${shown}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR")
      throw new Error(`--out parent is not a directory: ${shown}`);
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw error;
  }
  let parent: string;
  try {
    parent = await realpath(dirname(path));
    if (!(await stat(parent)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(
      `--out parent directory does not exist or is not a directory: ${printablePath(dirname(path))}`,
    );
  }
  const target = join(parent, basename(path));
  if (target.split(sep).includes(".git"))
    throw new Error(`--out refuses a path inside a .git directory: ${shown}`);
  for (const protectedPath of protectedPaths)
    if (within(target, await realOrResolved(protectedPath)))
      throw new Error(
        `--out refuses a path inside the Crewplane control or state directory ${printablePath(protectedPath)}: ${shown}`,
      );
  const problem = gitIgnoreProblem(parent, target);
  if (problem) throw new Error(`--out refused: ${problem}: ${shown}`);
}

/**
 * Prepare an atomic, never-overwriting write: the content goes to a 0600
 * temporary file in the same directory and is fsynced; `commit` links it to the
 * final name (link fails if that name appeared meanwhile) and removes the
 * temporary name. Nothing is visible at the final path until `commit`.
 */
export async function prepareOut(
  path: string,
  text: string,
  protectedPaths: readonly string[],
): Promise<OutPlan> {
  await checkOut(path, protectedPaths);
  const temp = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  // SIGINT/SIGTERM/exit between here and commit/discard must not leave the
  // hidden temporary file behind. SIGKILL and power loss still can.
  const removeTemp = () => {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    removeTemp();
    release();
    process.kill(process.pid, signal);
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  function release() {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("exit", removeTemp);
  }
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("exit", removeTemp);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(temp, "wx", 0o600);
  } catch (error) {
    release();
    throw new Error(
      `--out could not create a temporary file: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
    );
  }
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    release();
    throw error;
  }
  await handle.close();
  let created = false;
  return {
    path,
    commit: async () => {
      try {
        await link(temp, path);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(
            `Refusing to overwrite existing file: ${printablePath(path)}`,
          );
        throw error;
      } finally {
        await unlink(temp).catch(() => {});
        release();
      }
      // Best effort: make the new directory entry durable.
      const directory = await open(dirname(path), "r").catch(() => null);
      await directory?.sync().catch(() => {});
      await directory?.close().catch(() => {});
    },
    discard: async () => {
      await unlink(temp).catch(() => {});
      release();
      if (created && (await exists(path))) await unlink(path).catch(() => {});
      created = false;
    },
  };
}
