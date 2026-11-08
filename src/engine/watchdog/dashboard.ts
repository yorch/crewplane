import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const faults = new Set([
  "supervisor-dead",
  "supervisor-stale",
  "supervisor-unknown",
  "heartbeat-unknown",
  "config-mismatch",
  "steering-stalled",
  "coordinator-long-turn",
  "pause-failure",
  "pause-unknown",
  "operation-stalled",
  "orphan-or-unknown-child",
  "task-failed",
  "review-stalled",
  "eligible-stalled",
]);
export async function watchdogHealth(store: string, now = Date.now()) {
  try {
    const handle = await open(
      join(store, "watchdog/latest.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let value: unknown;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > 65536 ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw Error("Unavailable");
      value = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
    const v = value as {
      checkedAt?: unknown;
      nextCheck?: unknown;
      observations?: unknown;
      availableSignals?: unknown;
      codes?: unknown;
      notice?: unknown;
    };
    if (
      !v ||
      typeof v.checkedAt !== "number" ||
      !Number.isFinite(v.checkedAt) ||
      typeof v.nextCheck !== "number" ||
      !Number.isFinite(v.nextCheck) ||
      !Array.isArray(v.observations)
    )
      throw Error("Unavailable");
    const observationCodes = v.observations
      .slice(0, 64)
      .flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        "code" in entry &&
        typeof entry.code === "string" &&
        faults.has(entry.code)
          ? [entry.code]
          : [],
      );
    const notice =
      v.notice !== null && typeof v.notice === "object"
        ? (v.notice as { codes?: unknown })
        : null;
    const safeCodes = (codes: unknown) =>
      Array.isArray(codes)
        ? codes
            .slice(0, 64)
            .filter(
              (code): code is string =>
                typeof code === "string" && faults.has(code),
            )
        : [];
    // Fault summaries are independent of capped detail observations and notice
    // cooldown. Older persisted checks may contain only notice.codes.
    const codes = [
      ...observationCodes,
      ...safeCodes(v.codes),
      ...safeCodes(notice?.codes),
    ];
    return {
      state:
        now - v.checkedAt > 365000
          ? "stale"
          : codes.length
            ? "alert"
            : "observing",
      checkedAt: new Date(v.checkedAt).toISOString(),
      nextCheck: new Date(v.nextCheck).toISOString(),
      codes: [...new Set(codes)],
      unavailableSignals: [
        "queue",
        "oldest steering",
        "capacity",
        "operations",
      ].filter(
        (signal) =>
          !Array.isArray(v.availableSignals) ||
          !v.availableSignals.includes(signal),
      ),
      recovery: "disabled",
    };
  } catch {
    return {
      state: "unavailable",
      checkedAt: null,
      nextCheck: null,
      codes: [] as string[],
      unavailableSignals: [
        "queue",
        "oldest steering",
        "capacity",
        "operations",
      ],
      recovery: "disabled",
    };
  }
}
