import { delimiter, isAbsolute, join, normalize } from "node:path";
import { probeBinary } from "../doctor.ts";
import { harnesses as allHarnesses, type Harness } from "../engine/harness.ts";

/**
 * Reports whether `path` is an absolute regular file the current user may
 * execute. The file is never run. Injectable so tests need no real binaries.
 */
export type ExecutableCheck = (path: string) => Promise<boolean>;
export const isUsableExecutable: ExecutableCheck = async (path) =>
  (await probeBinary(path, "harness")).code === undefined;

/** Executable file names searched for each harness. */
export const harnessCommands: Record<Harness, string> = {
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
  pi: "pi",
};

/**
 * First usable executable named `name` on PATH. Relative PATH entries (an empty
 * entry or `.`) are skipped: a generated configuration only holds absolute
 * paths. Symlinks are kept as found (never rewritten to their target) because
 * wrappers may dispatch on their own name; the target is still checked to be a
 * regular, executable file.
 */
export async function findOnPath(
  name: string,
  pathVariable: string | undefined,
  check: ExecutableCheck = isUsableExecutable,
): Promise<string | null> {
  if (!pathVariable || /[\\/]/.test(name)) return null;
  for (const entry of pathVariable.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(normalize(entry), name);
    if (await check(candidate)) return candidate;
  }
  return null;
}

export type Detection = Record<Harness, string | null>;

export async function detectHarnesses(
  pathVariable: string | undefined,
  check: ExecutableCheck = isUsableExecutable,
): Promise<Detection> {
  const found = {} as Detection;
  for (const harness of allHarnesses)
    found[harness] = await findOnPath(
      harnessCommands[harness],
      pathVariable,
      check,
    );
  return found;
}

/**
 * Validate an operator-supplied binary path: absolute, normalized, a regular
 * file, executable. Returns the normalized path or throws a stable message.
 */
export async function acceptBinary(
  path: string,
  harness: Harness,
  check: ExecutableCheck = isUsableExecutable,
): Promise<string> {
  if (!isAbsolute(path))
    throw new Error(`${harness} binary path must be absolute`);
  if (/\p{Cc}/u.test(path))
    throw new Error(`${harness} binary path contains control characters`);
  const normalized = normalize(path);
  if (!(await check(normalized)))
    throw new Error(
      `${harness} binary is not an executable regular file: ${normalized}`,
    );
  return normalized;
}
