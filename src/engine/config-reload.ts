import type { Config } from "../contracts.ts";

// Canonicalize JSON configuration without depending on property insertion order.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

function immutable(config: Config) {
  const { allowedTasks: _tasks, lanes, ...rest } = config;
  return {
    ...rest,
    lanes: Object.fromEntries(
      Object.entries(lanes).flatMap(([name, lane]) => {
        const { enabled: _enabled, ...identity } = lane;
        return canonical(identity) === "{}" ? [] : [[name, identity]];
      }),
    ),
  };
}

function scheduling(config: Config) {
  return {
    allowedTasks: [...new Set(config.allowedTasks)].sort(),
    enabled: Object.entries(config.lanes)
      .filter(([, lane]) => lane.enabled)
      .map(([name]) => name)
      .sort(),
  };
}

export function evaluateSchedulingReload(
  current: Config,
  candidate: unknown,
  validate: (value: unknown) => Config,
): {
  config: Config;
  outcome: "applied" | "unchanged" | "invalid" | "deferred";
  errorCode: null | "INVALID_CONFIG" | "RESTART_REQUIRED";
} {
  let next: Config;
  try {
    // Isolate callers from validators which normalize or mutate their input.
    next = structuredClone(validate(structuredClone(candidate)));
    if (canonical(immutable(current)) !== canonical(immutable(next)))
      return {
        config: current,
        outcome: "deferred",
        errorCode: "RESTART_REQUIRED",
      };
    if (canonical(scheduling(current)) === canonical(scheduling(next)))
      return { config: current, outcome: "unchanged", errorCode: null };
  } catch {
    return { config: current, outcome: "invalid", errorCode: "INVALID_CONFIG" };
  }
  return { config: next, outcome: "applied", errorCode: null };
}
