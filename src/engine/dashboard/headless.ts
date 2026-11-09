import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, State } from "../../contracts.ts";

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
  const budgets = hasLoadedBudgets
    ? {
        maxParallel: loaded.maxParallel,
        maxRunsPerHour: loaded.maxRunsPerHour as number,
        maxRunMinutes: loaded.maxRunMinutes as number,
        intervalSeconds: loaded.intervalSeconds as number,
      }
    : config
      ? {
          maxParallel: config.maxParallel,
          maxRunsPerHour: config.maxRunsPerHour,
          maxRunMinutes: config.maxRunMinutes,
          intervalSeconds: config.intervalSeconds,
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
        value?.instanceHeld === true || (value?.held.includes(lane) ?? false);
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
      const rateLimited =
        hasLoadedBudgets && budgets && runs.length >= budgets.maxRunsPerHour;
      const next = rateLimited
        ? runs[runs.length - budgets.maxRunsPerHour]
        : undefined;
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

export async function readHeadless(store: string, knownAgents: string[] = []) {
  async function read<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(
        await readFile(join(store, "supervisor", file), "utf8"),
      ) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  try {
    const [config, state] = await Promise.all([
      read<Config>("config.json").catch(() => null),
      read<State>("state.json"),
    ]);
    return projectHeadless(
      config,
      state,
      Date.now(),
      (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH"
            ? false
            : null;
        }
      },
      knownAgents,
    );
  } catch {
    return { ...projectHeadless(null, null), state: "unavailable" };
  }
}
