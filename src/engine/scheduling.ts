import { createHash } from "node:crypto";
import type { Config, Lane, State } from "../contracts.ts";
export interface LoadedScheduling {
  fingerprint: string;
  allowedTasks: string[];
  enabledLanes: Lane[];
  maxParallel: number;
  maxRunsPerHour?: number;
  maxRunMinutes?: number;
  intervalSeconds?: number;
}
export const schedulingFingerprint = (config: Config) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        { ...config, allowedTasks: [...new Set(config.allowedTasks)].sort() },
        (_key, value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
              )
            : value,
      ),
    )
    .digest("hex");
export function loadedScheduling(config: Config): LoadedScheduling {
  return {
    fingerprint: schedulingFingerprint(config),
    allowedTasks: [...config.allowedTasks],
    enabledLanes: Object.entries(config.lanes)
      .filter(([, v]) => v.enabled)
      .map(([lane]) => lane as Lane),
    maxParallel: config.maxParallel,
    maxRunsPerHour: config.maxRunsPerHour,
    maxRunMinutes: config.maxRunMinutes,
    intervalSeconds: config.intervalSeconds,
  };
}
export interface SchedulingTask {
  id: string;
  owner: string;
  state: string;
}
export function schedulingReason(
  task: SchedulingTask,
  state: State | null,
  config: Config | null,
  now = Date.now(),
) {
  const result = (code: string, label: string) => ({ code, label });
  if (task.state === "completed")
    return result("accepted", "Accepted task slice; not a process observation");
  if (task.state === "review")
    return result(
      "coordinator-disposition",
      "Submitted; coordinator review/integration disposition is pending",
    );
  if (task.state === "blocked")
    return result(
      "dependency-blocked",
      "Owner explicitly reported blocked; see its task update",
    );
  const freshness = Math.max(
    45000,
    (state?.scheduling?.intervalSeconds ?? 0) * 3000,
  );
  if (
    !state ||
    !Number.isFinite(Date.parse(state.checkedAt)) ||
    now - Date.parse(state.checkedAt) > freshness
  )
    return result("unknown", "Scheduling observation unavailable or stale");
  if (state.draining || !state.running)
    return result("draining", "Supervisor is draining or stopped");
  const queue = state.queue;
  const entry = queue?.queue.find((entry) => entry.taskId === task.id);
  if (
    entry &&
    queue &&
    Date.parse(state.checkedAt) >= queue.evaluatedAt &&
    now - queue.evaluatedAt < freshness
  ) {
    const labels: Record<string, string> = {
      RATE_LIMITED: "Hourly run budget exhausted",
      SCHEDULE_INPUT_OVERFLOW:
        "Scheduling window exceeded; task remains blocked with dependencies preserved",
      DEPENDENCY_WAITING: "Waiting for explicit task dependencies",
      DEPENDENCY_CYCLE: "Dependency cycle requires coordinator correction",
      DEPENDENCY_MISSING: "Missing dependency metadata",
      REVISION_PENDING: "Required author correction takes precedence",
      COORDINATOR_RESERVED: "Waiting for capacity reserved for coordination",
      CAPACITY: "Waiting for model capacity",
      LANE_SELECTED: "Another task in this lane was selected",
      OWNERSHIP_INVALID: "Task needs a safe checkpoint or ownership correction",
      REVIEW_PIN_INVALID: "Review SHA is not the current frozen submission",
    };
    if (labels[entry.reason])
      return result(
        entry.reason.toLowerCase().replaceAll("_", "-"),
        labels[entry.reason] as string,
      );
  }
  const records = Object.values(state.records).filter(
    (r) => r.lane === task.owner,
  );
  const current = records.find((r) => r.status === "running");
  if (current?.task === task.id)
    return result(
      "scheduled",
      "Native process reported running; productive work is not inferred",
    );
  if (
    state.held.includes(task.owner as Lane) ||
    records.some((r) => r.task === task.id && r.status === "paused")
  )
    return result("paused", "Lane/task is explicitly held or paused");
  if (state.draining || !state.running)
    return result("draining", "Supervisor is draining or stopped");
  const loaded = state.scheduling;
  if (!loaded)
    return result(
      "unknown",
      "Loaded scheduling configuration not recorded; on-disk config is not proof of reload",
    );
  const changed = config
    ? schedulingFingerprint(config) !== loaded.fingerprint
    : false;
  if (!loaded.allowedTasks.includes(task.id))
    return result(
      changed && config?.allowedTasks.includes(task.id)
        ? "reload-required"
        : "unsupported",
      changed && config?.allowedTasks.includes(task.id)
        ? "Task configured on disk but not loaded; safe supervisor reload required"
        : "Task excluded by loaded allowlist",
    );
  if (!loaded.enabledLanes.includes(task.owner as Lane))
    return result(
      changed && config?.lanes[task.owner as Lane]?.enabled
        ? "reload-required"
        : "disabled",
      changed && config?.lanes[task.owner as Lane]?.enabled
        ? "Lane enabled on disk but not loaded; safe supervisor reload required"
        : "Lane disabled in loaded configuration",
    );
  if (current)
    return result(
      "lane-busy",
      "Lane has another recorded native task/control run",
    );
  if (
    Object.values(state.records).filter((r) => r.status === "running").length >=
    loaded.maxParallel
  )
    return result(
      "waiting-capacity",
      `Waiting for one of ${loaded.maxParallel} total model slots`,
    );
  return result(
    "queued",
    "Queued for supervisor scheduling/setup; task progress is reported separately",
  );
}
