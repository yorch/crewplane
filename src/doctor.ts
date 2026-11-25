import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/**
 * Closed set of `doctor` problem codes. Scripts may gate on these; adding a
 * code is a documented contract change (docs/CONTRACTS.md).
 */
export type DoctorProblemCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "BINARY_MISSING"
  | "BINARY_INVALID"
  | "BINARY_NOT_EXECUTABLE"
  | "INSTRUCTIONS_INVALID"
  | "RELEASES_ROOT_INVALID"
  | "CACHE_DIR_INVALID"
  | "LEGACY_LAYOUT"
  | "INSTRUCTIONS_GLOBAL_UNAVAILABLE";

export interface DoctorProblem {
  code: DoctorProblemCode;
  lane?: string;
  message: string;
}

export interface BinaryProbe {
  path: string | null;
  ok: boolean;
  problem?: string;
}

/**
 * Mirrors validateHarness: the harness-specific entry wins, and only Codex
 * falls back to the legacy top-level `binary`.
 */
export function effectiveBinary(
  config: { binary?: string; binaries?: Partial<Record<string, string>> },
  harness: string,
): string | undefined {
  return (
    config.binaries?.[harness] ??
    (harness === "codex" ? config.binary : undefined)
  );
}

/**
 * Checks that a harness binary could be launched without launching it: the
 * path is absolute, resolves to a regular file and is executable by the current
 * user. The binary is never run, so no harness is started.
 */
export async function probeBinary(
  path: string | undefined,
  harness: string,
): Promise<{ probe: BinaryProbe; code?: DoctorProblemCode }> {
  const fail = (code: DoctorProblemCode, problem: string) => ({
    probe: { path: typeof path === "string" ? path : null, ok: false, problem },
    code,
  });
  if (path === undefined || path === "")
    return fail("BINARY_MISSING", `no ${harness} binary is configured`);
  if (typeof path !== "string")
    return fail("BINARY_INVALID", `${harness} binary path must be a string`);
  if (!isAbsolute(path))
    return fail("BINARY_INVALID", `${harness} binary path must be absolute`);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return fail("BINARY_MISSING", `${harness} binary does not exist`);
  }
  if (!info.isFile())
    return fail("BINARY_INVALID", `${harness} binary is not a regular file`);
  try {
    // POSIX only: on Windows X_OK behaves like F_OK.
    await access(path, constants.X_OK);
  } catch {
    return fail(
      "BINARY_NOT_EXECUTABLE",
      `${harness} binary is not executable by the current user`,
    );
  }
  return { probe: { path, ok: true } };
}

/**
 * The message of a deliberate validation failure (a plain Error). Anything else
 * (TypeError, RangeError, ...) is an engine fault whose text may echo
 * configuration, so it gets the generic fallback.
 */
export const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error &&
  Object.getPrototypeOf(error) === Error.prototype &&
  error.message
    ? error.message
    : fallback;
