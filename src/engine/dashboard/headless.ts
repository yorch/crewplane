import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, State } from "../../contracts.ts";
import { checkControlDirectory } from "../../control.ts";
import { probeProcess } from "../../liveness.ts";
import { readJsonStrict } from "./sanitize.ts";

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
// Persisted files are untrusted shapes: normalize every field the projection
// and the controls read, so one missing or mistyped array can never take the
// dashboard (or its controls, a halt included) down.
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const numbers = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => Number.isFinite(x)) : [];
const finiteOrUndefined = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? n : undefined;
// The loaded schedule is read by the scheduling explanation and the budgets
// projection: arrays are arrays of strings and a number is a finite number or
// absent, whatever the file held.
function normalizeScheduling(v: unknown): State["scheduling"] | undefined {
  if (!isObject(v)) return undefined;
  return {
    fingerprint: typeof v.fingerprint === "string" ? v.fingerprint : "",
    allowedTasks: strings(v.allowedTasks),
    enabledLanes: strings(v.enabledLanes),
    maxParallel: finiteOrUndefined(v.maxParallel),
    maxRunsPerHour: finiteOrUndefined(v.maxRunsPerHour),
    maxRunMinutes: finiteOrUndefined(v.maxRunMinutes),
    intervalSeconds: finiteOrUndefined(v.intervalSeconds),
  } as State["scheduling"];
}
export function normalizeState(v: unknown): State | null {
  if (!isObject(v)) return null;
  const records: Record<string, unknown> = {};
  if (isObject(v.records))
    for (const [key, record] of Object.entries(v.records))
      if (isObject(record))
        records[key] = {
          ...record,
          runs: numbers(record.runs),
          seen: strings(record.seen),
        };
  const retired: Record<string, number[]> = {};
  if (isObject(v.retiredRuns))
    for (const [lane, runs] of Object.entries(v.retiredRuns))
      retired[lane] = numbers(runs);
  return {
    ...v,
    held: strings(v.held),
    commands: strings(v.commands),
    controlLog: Array.isArray(v.controlLog)
      ? v.controlLog.filter(isObject)
      : undefined,
    notices: isObject(v.notices) ? v.notices : {},
    scheduling: normalizeScheduling(v.scheduling),
    records,
    ...(isObject(v.retiredRuns) ? { retiredRuns: retired } : {}),
  } as unknown as State;
}
export function normalizeConfig(v: unknown): Config | null {
  if (!isObject(v)) return null;
  return {
    ...v,
    lanes: isObject(v.lanes) ? v.lanes : {},
  } as unknown as Config;
}
const count = (n: number | undefined) =>
  Number.isSafeInteger(n) && (n ?? -1) >= 0 ? n : null;

// Explicit projection: never forward config, notices, summaries or raw run logs.
export function projectHeadless(
  config: Config | null,
  value: State | null,
  now = Date.now(),
  alive: (pid: number) => boolean | null = () => null,
  knownAgents: string[] = [],
) {
  const fresh =
    value &&
    Number.isFinite(Date.parse(value.checkedAt)) &&
    now - Date.parse(value.checkedAt) <=
      ((config?.intervalSeconds ?? 10) * 2 + 5) * 1000;
  const state = !value
    ? "not-started"
    : !value.running
      ? "stopped"
      : !fresh
        ? "stale"
        : value.draining
          ? "draining"
          : "running";
  const loaded = value?.scheduling;
  const hasLoadedBudgets =
    loaded &&
    [loaded.maxRunsPerHour, loaded.maxRunMinutes, loaded.intervalSeconds].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    );
  // A number, or null when the file does not record one (never undefined or
  // NaN: the page prints "not recorded" for null).
  const finite = (n: unknown): number | null =>
    typeof n === "number" && Number.isFinite(n) ? n : null;
  const budgets = hasLoadedBudgets
    ? {
        maxParallel: finite(loaded.maxParallel),
        maxRunsPerHour: loaded.maxRunsPerHour as number,
        maxRunMinutes: loaded.maxRunMinutes as number,
        intervalSeconds: loaded.intervalSeconds as number,
      }
    : config
      ? {
          maxParallel: finite(config.maxParallel),
          maxRunsPerHour: finite(config.maxRunsPerHour),
          maxRunMinutes: finite(config.maxRunMinutes),
          intervalSeconds: finite(config.intervalSeconds),
        }
      : null;
  return {
    state,
    budgetsSource: hasLoadedBudgets ? "loaded" : "configured-only",
    attention: value?.attention
      ? {
          backlog: count(value.attention.backlog),
          planningSince: count(value.attention.planningSince ?? undefined),
          oldestUnhandledAt: count(
            value.attention.oldestUnhandledAt ?? undefined,
          ),
        }
      : null,
    diskConfigAvailable: config !== null,
    checkedAt: value?.checkedAt ?? null,
    configReload:
      value?.configReload &&
      ["applied", "unchanged", "invalid", "deferred"].includes(
        value.configReload.outcome,
      )
        ? {
            outcome: value.configReload.outcome,
            errorCode: ["INVALID_CONFIG", "RESTART_REQUIRED"].includes(
              value.configReload.errorCode ?? "",
            )
              ? value.configReload.errorCode
              : null,
            evaluatedAt: Number.isFinite(
              Date.parse(value.configReload.evaluatedAt),
            )
              ? value.configReload.evaluatedAt
              : null,
          }
        : null,
    held: value?.held ?? [],
    instanceHeld: value?.instanceHeld === true,
    budgets,
    lanes: [
      ...new Set([
        ...Object.keys(config?.lanes ?? {}),
        ...knownAgents,
        ...Object.values(value?.records ?? {}).map((r) => r.lane),
      ]),
    ].map((lane) => {
      const records = Object.values(value?.records ?? {}).filter(
        (r) => r.lane === lane,
      );
      const r = records.sort((a, b) =>
        (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
      )[0];
      const enabled = config?.lanes[lane]?.enabled ?? false;
      const held =
        value?.instanceHeld === true || (value?.held?.includes(lane) ?? false);
      const processAlive = r?.pid ? alive(r.pid) : null;
      const runs = records
        .flatMap((r) => r.runs)
        .concat(value?.retiredRuns?.[lane] ?? [])
        .filter((at) => at <= now && at > now - 3600000)
        .sort((a, b) => a - b);
      const entry = value?.queue?.queue.find((q) => q.lane === lane);
      const code =
        entry?.reason && /^[A-Z_]{1,64}$/.test(entry.reason)
          ? entry.reason
          : null;
      const hourly = hasLoadedBudgets
        ? (budgets?.maxRunsPerHour ?? null)
        : null;
      const rateLimited = hourly !== null && runs.length >= hourly;
      const next = rateLimited ? runs[runs.length - hourly] : undefined;
      const status =
        r?.status === "running"
          ? fresh && value?.running && processAlive === true
            ? "running"
            : "stale"
          : held || r?.status === "paused"
            ? "paused"
            : !enabled
              ? "standby"
              : "idle";
      return {
        lane,
        enabled,
        status,
        reportedProcessStatus: r?.status ?? null,
        scheduling: {
          code: !value?.running
            ? "STOPPED"
            : held
              ? "LANE_HELD"
              : r?.status === "paused"
                ? "FAILURE_PAUSED"
                : rateLimited
                  ? "RATE_LIMITED"
                  : (code ?? "NO_PENDING_EVENT"),
          position: entry?.position ?? null,
          nextEligibleAt:
            next === undefined ? null : new Date(next + 3600000).toISOString(),
        },
        processAlive,
        task: r?.task ?? null,
        worktree: r?.cwd ?? null,
        harness: config
          ? `${config.lanes[lane]?.harness ?? "codex"} (configured); ${r ? `${r.harness ?? "codex"} recorded` : "no session recorded"}`
          : "Unknown (configuration unavailable)",
        configuredHarness:
          config?.lanes[lane]?.harness ?? (config ? "codex" : null),
        observedHarness: r ? (r.harness ?? "codex") : null,
        configuredModel:
          config?.lanes[lane]?.harness === "pi"
            ? config.lanes[lane]?.piModel
              ? `${config.lanes[lane].piModel.provider}/${config.lanes[lane].piModel.id}`
              : "Pi saved default (unspecified)"
            : (config?.lanes[lane]?.model ?? "CLI default (unspecified)"),
        observedModel: r?.observedModel ?? null,
        sessionId: r?.sessionId ?? null,
        pid: r?.pid ?? null,
        startedAt: r?.startedAt ?? null,
        finishedAt: r?.finishedAt ?? null,
        heartbeatAt: value?.checkedAt ?? null,
        reason: held
          ? `Operator hold${r?.reason ? ` · ${r.reason.slice(0, 500)}` : ""}`
          : (r?.reason?.slice(0, 500) ??
            (enabled ? "No run recorded" : "Lane disabled / on demand")),
        permissionDenials:
          r?.permissionDenialsKnown === true
            ? count(r.permissionDenials)
            : null,
        reportedCostUsd:
          r?.costKnown === true && typeof r.reportedCostUsd === "number"
            ? r.reportedCostUsd
            : null,
        lastSessionReset: r?.lastSessionReset ?? null,
        usage: {
          inputTokens:
            r?.inputTokensKnown === true ? count(r.inputTokens) : null,
          outputTokens:
            r?.outputTokensKnown === true ? count(r.outputTokens) : null,
          runsLastHour: runs.length,
        },
      };
    }),
  };
}

/** desired.json is a few dozen bytes; anything bigger is not the supervisor's. */
const desiredLimit = 4096;
/**
 * When the supervisor last recorded an intentional stop (a signal, Ctrl-C or a
 * stop command), or null: no file, unsafe or oversized file, a start/rollout
 * record, or an unparseable time. Only the validated time is returned.
 */
export async function readIntentionalStop(
  control: string,
): Promise<{ at: string } | null> {
  try {
    const desired = await readJsonStrict(
      join(control, "desired.json"),
      desiredLimit,
    );
    if (
      !isObject(desired) ||
      desired.desiredRunning !== false ||
      desired.reason !== "intentional-stop" ||
      typeof desired.at !== "string" ||
      desired.at.length > 64
    )
      return null;
    const time = Date.parse(desired.at);
    return Number.isFinite(time) ? { at: new Date(time).toISOString() } : null;
  } catch {
    return null;
  }
}

export async function readHeadless(
  control: string,
  knownAgents: string[] = [],
) {
  async function read<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(control, file), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  try {
    checkControlDirectory(control);
    const [config, state] = await Promise.all([
      read<Config>("config.json").catch(() => null),
      read<State>("state.json"),
    ]);
    return {
      ...projectHeadless(
        normalizeConfig(config),
        normalizeState(state),
        Date.now(),
        (pid) => {
          const state = probeProcess(pid);
          return state === "unknown" ? null : state === "alive";
        },
        knownAgents,
      ),
      intentionalStop: await readIntentionalStop(control),
    };
  } catch {
    return {
      ...projectHeadless(null, null),
      state: "unavailable",
      intentionalStop: null as { at: string } | null,
    };
  }
}
