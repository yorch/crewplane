/**
 * Process liveness via signal 0. The probe never delivers a signal.
 *
 * Rule: only ESRCH proves the process (or group, for a negative pid) is gone.
 * EPERM means something exists that we may not signal, which proves neither
 * that it is ours nor that it is dead, so it is "unknown", like any other
 * failure. Safety callers compare against "dead" and therefore treat unknown
 * as possibly alive; monitors surface it as unknown/stale rather than alive.
 */
export type Liveness = "alive" | "dead" | "unknown";

/** The probe outcome with the errno code (never a path) of a failed signal 0. */
export function probeDetail(pid: number): {
  state: Liveness;
  code: string | null;
} {
  try {
    process.kill(pid, 0);
    return { state: "alive", code: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return { state: code === "ESRCH" ? "dead" : "unknown", code };
  }
}

export const probeProcess = (pid: number): Liveness => probeDetail(pid).state;

/** Positive, safe-integer pids only: 0 and negatives address process groups. */
export const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isSafeInteger(pid) && pid >= 1;

/** Conservative: unknown counts as alive; only a definite ESRCH, or an invalid pid, is not. */
export function isProcessAlive(pid: number | undefined): boolean {
  return validPid(pid) && probeProcess(pid) !== "dead";
}
