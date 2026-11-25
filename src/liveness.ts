/**
 * Process liveness via signal 0. The probe never delivers a signal.
 *
 * Rule: ESRCH means the process (or group, for a negative pid) is gone.
 * EPERM means it exists but belongs to someone we may not signal, so it is
 * alive. Any other failure leaves liveness unknown.
 */
export type Liveness = "alive" | "dead" | "unknown";

export function probeProcess(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return code === "EPERM" ? "alive" : "unknown";
  }
}

/** Positive, safe-integer pids only: 0 and negatives address process groups. */
export const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isSafeInteger(pid) && pid >= 1;

/** Conservative: only a definite ESRCH, or an invalid pid, counts as not alive. */
export function isProcessAlive(pid: number | undefined): boolean {
  return validPid(pid) && probeProcess(pid) !== "dead";
}
