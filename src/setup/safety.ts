import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Reports why an executable must not be recorded in a generated configuration,
 * or null when it looks safe. Nothing is executed. This is setup-only policy:
 * `doctor` (probeBinary) deliberately does not apply it, so a configuration
 * written by hand keeps its documented behaviour.
 *
 * A file is refused when group- or world-writable (anyone with that access can
 * replace what the supervisor will launch). Its directory, and the directory of
 * the symlink that was named, are refused when world-writable without the sticky
 * bit, or when owned by a user other than the current user or root.
 */
export type SafetyCheck = (path: string) => Promise<string | null>;

const currentUid = () =>
  typeof process.getuid === "function" ? process.getuid() : null;

async function directoryProblem(directory: string): Promise<string | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(directory);
  } catch {
    return "its directory cannot be inspected";
  }
  if ((info.mode & 0o002) !== 0 && (info.mode & 0o1000) === 0)
    return "its directory is world-writable without the sticky bit";
  const uid = currentUid();
  if (uid !== null && info.uid !== uid && info.uid !== 0)
    return "its directory is owned by another user";
  return null;
}

export const binarySafetyProblem: SafetyCheck = async (path) => {
  let target: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    target = await realpath(path);
    info = await stat(target);
  } catch {
    return "it cannot be inspected";
  }
  if ((info.mode & 0o022) !== 0) return "it is group- or world-writable";
  const directories = new Set([dirname(target)]);
  try {
    directories.add(await realpath(dirname(path)));
  } catch {
    return "its directory cannot be inspected";
  }
  for (const directory of directories) {
    const problem = await directoryProblem(directory);
    if (problem) return problem;
  }
  return null;
};

/** Injected `check` functions stand in for the file system, so they get no safety probe. */
export const noSafety: SafetyCheck = async () => null;
