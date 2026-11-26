import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

function gitIgnoreProblem(parent: string, target: string): string | null {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: parent,
    env,
    encoding: "utf8",
  });
  if (top.error)
    return "git could not be run to check whether the path is ignored";
  // 128: not inside a work tree, so nothing is tracked here.
  if (top.status === 128) return null;
  if (top.status !== 0 || !top.stdout.trim())
    return "git could not report the work tree for the path";
  const tree = top.stdout.trim();
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", target], {
    cwd: tree,
    env,
    encoding: "utf8",
  });
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
  const handle = await open(temp, "wx", 0o600).catch((error) => {
    throw new Error(
      `--out could not create a temporary file: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
    );
  });
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
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
      }
      // Best effort: make the new directory entry durable.
      const directory = await open(dirname(path), "r").catch(() => null);
      await directory?.sync().catch(() => {});
      await directory?.close().catch(() => {});
    },
    discard: async () => {
      await unlink(temp).catch(() => {});
      if (created && (await exists(path))) await unlink(path).catch(() => {});
      created = false;
    },
  };
}
