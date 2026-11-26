import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { binarySafetyProblem, type SafetyCheck } from "./binary-safety.ts";

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
  | "BINARY_UNSAFE"
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
 * `probeBinary`, then the binary safety walk (src/binary-safety.ts) when the
 * probe passed: a binary that users outside the current user's groups could
 * replace, or whose path they could redirect, fails as `BINARY_UNSAFE`. The
 * binary is never run. `safety` is injectable for tests.
 */
export async function inspectBinary(
  path: string | undefined,
  harness: string,
  safety: SafetyCheck = binarySafetyProblem,
): Promise<{ probe: BinaryProbe; code?: DoctorProblemCode }> {
  const result = await probeBinary(path, harness);
  if (result.code !== undefined || result.probe.path === null) return result;
  const reason = await safety(result.probe.path);
  if (reason === null) return result;
  return {
    probe: {
      path: result.probe.path,
      ok: false,
      problem: `${harness} binary refused: ${reason}`,
    },
    code: "BINARY_UNSAFE",
  };
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
