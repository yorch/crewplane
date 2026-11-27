import type { Config, RecordState, State } from "../../contracts.ts";
import { validTaskId } from "../../project.ts";
import { amount, clean, count, instant } from "./sanitize.ts";

const hour = 3600000;
const bucketCount = 24;
const maxLanes = 64;
const recentLimit = 10;

/** Retained operational-trace summaries, or null when the store is unreadable. */
export interface TraceCoverage {
  runs: Array<{ lane: string; startedAt: string }>;
  retentionLimited: boolean;
  incomplete: boolean;
}

const sum = (values: Array<number | null>) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
const positive = (value: unknown) => {
  const n = count(value);
  return n !== null && n > 0 ? n : null;
};

/**
 * Per-lane and total usage derived only from what the runtime retains:
 * supervisor state records (run timestamps for the last hour, latest-run
 * timing, reported token and cost counters) and operational-trace metadata
 * (run starts, for the 24h series). The detailed usage ledger is not written
 * by the runtime, so it is not read. Unknown is null, never 0.
 */
export function usageView(
  state: State | null,
  config: Config | null,
  traces: TraceCoverage | null,
  now = Date.now(),
) {
  const records: RecordState[] = Object.values(state?.records ?? {}).filter(
    (r): r is RecordState => typeof r === "object" && r !== null,
  );
  const loaded = state?.scheduling;
  const globalRuns =
    positive(loaded?.maxRunsPerHour) ?? positive(config?.maxRunsPerHour);
  const globalMinutes =
    positive(loaded?.maxRunMinutes) ?? positive(config?.maxRunMinutes);
  const lanes = [
    ...new Set([
      ...Object.keys(config?.lanes ?? {}),
      ...records.map((r) => r.lane),
      ...Object.keys(state?.retiredRuns ?? {}),
    ]),
  ]
    .filter((lane) => typeof lane === "string" && lane.length > 0)
    .sort()
    .slice(0, maxLanes);
  const start0 = Math.floor(now / hour) * hour - (bucketCount - 1) * hour;
  const bucketStarts = Array.from(
    { length: bucketCount },
    (_, i) => start0 + i * hour,
  );
  const oldestTrace = traces?.runs.length
    ? Math.min(...traces.runs.map((r) => Date.parse(r.startedAt)))
    : null;
  // A bucket is trustworthy when no retention pruning was observed, or when it
  // starts after the oldest retained run (newer runs are never pruned first).
  const covered = (start: number) =>
    traces !== null &&
    !traces.incomplete &&
    (!traces.retentionLimited || (oldestTrace !== null && start > oldestTrace));
  const seriesFor = (lane: string | null) =>
    bucketStarts.map((start) =>
      covered(start)
        ? (traces?.runs ?? []).filter(
            (r) =>
              (lane === null || r.lane === lane) &&
              Date.parse(r.startedAt) >= start &&
              Date.parse(r.startedAt) < start + hour,
          ).length
        : null,
    );
  const laneViews = lanes.map((lane) => {
    const own = records.filter((r) => r.lane === lane);
    const laneConfig = config?.lanes?.[lane];
    const stamps = own
      .flatMap((r) => (Array.isArray(r.runs) ? r.runs : []))
      .concat(state?.retiredRuns?.[lane] ?? [])
      .filter((at) => typeof at === "number" && at <= now && at > now - hour);
    const laneRuns = positive(laneConfig?.maxRunsPerHour);
    const cap = laneRuns ?? globalRuns;
    const laneMinutes = positive(laneConfig?.maxRunMinutes);
    const finished = own
      .flatMap((r) => {
        const started = Date.parse(r.startedAt ?? "");
        const ended = Date.parse(r.finishedAt ?? "");
        if (!Number.isFinite(started) || !Number.isFinite(ended)) return [];
        if (ended < started) return [];
        return [
          {
            task: validTaskId(r.task ?? "") ? r.task : null,
            startedAt: instant(r.startedAt),
            finishedAt: instant(r.finishedAt),
            durationMs: ended - started,
            status: ["running", "idle", "paused"].includes(r.status)
              ? r.status
              : null,
          },
        ];
      })
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
      .slice(0, recentLimit);
    const input = own.filter((r) => r.inputTokensKnown === true);
    const output = own.filter((r) => r.outputTokensKnown === true);
    const costCap = amount(laneConfig?.maxCostUsdPerRun);
    const costs = own
      .flatMap((r) => {
        const costUsd = r.costKnown === true ? amount(r.reportedCostUsd) : null;
        if (costUsd === null) return [];
        return [
          {
            task: validTaskId(r.task ?? "") ? r.task : null,
            at: instant(r.finishedAt) ?? instant(r.startedAt),
            costUsd,
            overCap: costCap === null ? null : costUsd > costCap,
          },
        ];
      })
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .slice(0, recentLimit);
    return {
      lane: clean(lane, 64) ?? "",
      enabled: laneConfig ? laneConfig.enabled === true : null,
      runs: {
        lastHour: state ? stamps.length : null,
        cap,
        capSource: laneRuns !== null ? "lane" : cap !== null ? "global" : null,
        remaining:
          state && cap !== null ? Math.max(0, cap - stamps.length) : null,
      },
      durations: {
        maxRunMinutes: laneMinutes ?? globalMinutes,
        recent: finished,
        recordedRuns: finished.length,
      },
      tokens: {
        semantics: "reported-counters-not-billing-totals",
        input: sum(input.map((r) => count(r.inputTokens))),
        output: sum(output.map((r) => count(r.outputTokens))),
        recordsReportingInput: input.length,
        recordsReportingOutput: output.length,
        retainedRecords: own.length,
      },
      cost: {
        semantics: "reported-per-invocation-observations-not-billing-totals",
        maxCostUsdPerRun: costCap,
        recent: costs,
        maxObservedUsd: costs.length
          ? Math.max(...costs.map((c) => c.costUsd))
          : null,
        anyOverCap:
          costCap === null || !costs.length
            ? null
            : costs.some((c) => c.overCap === true),
      },
      series: seriesFor(lane),
    };
  });
  const tokensIn = sum(laneViews.map((l) => l.tokens.input));
  const tokensOut = sum(laneViews.map((l) => l.tokens.output));
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    window: {
      runsLastHourMs: hour,
      bucket: "hour",
      bucketStarts: bucketStarts.map((t) => new Date(t).toISOString()),
    },
    total: {
      runsLastHour: state
        ? (sum(laneViews.map((l) => l.runs.lastHour)) ?? 0)
        : null,
      maxRunsPerHour: globalRuns,
      tokens: {
        semantics: "reported-counters-not-billing-totals",
        input: tokensIn,
        output: tokensOut,
      },
      series: seriesFor(null),
    },
    lanes: laneViews,
    coverage: {
      counters: {
        source: "supervisor state records",
        state: state ? "available" : "unavailable",
        retainedRecords: records.length,
        note: "Token counters and costs exist only for retained records whose provider reported them; terminal records are compacted away by the supervisor, so these are not lifetime totals.",
      },
      durations: {
        source: "supervisor state records (latest run of each record)",
        complete: false,
      },
      series: {
        source: "operational traces",
        state: traces ? "available" : "unavailable",
        retainedRuns: traces?.runs.length ?? null,
        oldestRetainedAt:
          oldestTrace === null ? null : new Date(oldestTrace).toISOString(),
        retentionLimited: traces?.retentionLimited ?? null,
        incomplete: traces?.incomplete ?? null,
        complete: traces
          ? !traces.retentionLimited && !traces.incomplete
          : false,
        note: "A bucket is null when retained trace history does not cover it; zero is only reported for covered buckets.",
      },
      ledger: {
        connected: false,
        note: "The detailed usage ledger is a separate module that the runtime does not write; it is not read here.",
      },
    },
  };
}
