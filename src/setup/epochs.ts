import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Harness, validHarness } from "../engine/harness.ts";

/** What an already installed configuration and its supervisor records say per lane. */
export interface PriorLane {
  harness: Harness;
  sessionEpoch?: string;
  /** From the latest state record only: true when that run is not drained and idle. */
  busy?: boolean;
}
export interface Prior {
  config: Record<string, PriorLane>;
  records: Record<string, PriorLane>;
}
export const noPrior: Prior = { config: {}, records: {} };

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const epochOf = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : undefined;
const harnessOf = (value: unknown): Harness | null => {
  const name = value === undefined ? "codex" : value;
  return validHarness(name) ? (name as Harness) : null;
};

async function readOptional(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid private state; inspect before recovery");
  }
}

/**
 * Read-only view of the installed `config.json` and `state.json`. Unreadable
 * files fail closed (the supervisor would refuse them too); lanes with an
 * unknown harness are ignored because nothing can be compared against them.
 */
export async function loadPrior(directory: string): Promise<Prior> {
  const prior: Prior = { config: {}, records: {} };
  const config = object(await readOptional(join(directory, "config.json")));
  for (const [id, raw] of Object.entries(object(config?.lanes) ?? {})) {
    const lane = object(raw);
    const harness = lane ? harnessOf(lane.harness) : null;
    if (!lane || !harness) continue;
    const epoch = epochOf(lane.sessionEpoch);
    prior.config[id] = { harness, ...(epoch ? { sessionEpoch: epoch } : {}) };
  }
  const state = object(await readOptional(join(directory, "state.json")));
  const latest = new Map<string, { at: string; lane: PriorLane }>();
  for (const raw of Object.values(object(state?.records) ?? {})) {
    const record = object(raw);
    const harness = record ? harnessOf(record.harness) : null;
    if (!record || !harness || typeof record.lane !== "string") continue;
    const at = typeof record.startedAt === "string" ? record.startedAt : "";
    const epoch = epochOf(record.sessionEpoch);
    const lane: PriorLane = {
      harness,
      ...(epoch ? { sessionEpoch: epoch } : {}),
      busy: record.status !== "idle" || Boolean(record.pid),
    };
    // Same ordering the supervisor uses: the last record by start time wins.
    const seen = latest.get(record.lane);
    if (!seen || at >= seen.at) latest.set(record.lane, { at, lane });
  }
  for (const [id, entry] of latest) prior.records[id] = entry.lane;
  return prior;
}

export interface EpochPlan {
  /** Lane id -> epoch to write; only lanes that need one appear. */
  epochs: Record<string, string>;
  notes: string[];
}

/**
 * The supervisor refuses to start (`assertSwitch`) when a lane's harness or
 * session epoch differs from its latest state record unless the new lane
 * carries a fresh explicit `sessionEpoch`, and it refuses a lane that dropped
 * an epoch the record still holds. `sessionEpoch` is accepted for every
 * harness, so setup emits a fresh one for each lane whose harness changed
 * (against the installed configuration or the latest record) and reuses the
 * prior epoch for an unchanged lane that already has one. Pi lanes always get
 * a fresh epoch from the answers and are not planned here.
 */
export function planEpochs(
  lanes: Record<string, Harness>,
  prior: Prior,
  mint: () => string,
): EpochPlan {
  const plan: EpochPlan = { epochs: {}, notes: [] };
  for (const [id, harness] of Object.entries(lanes)) {
    if (harness === "pi") continue;
    const sources = [prior.records[id], prior.config[id]].filter(
      (lane): lane is PriorLane => lane !== undefined,
    );
    const changed = sources.find((lane) => lane.harness !== harness);
    if (changed) {
      plan.epochs[id] = mint();
      plan.notes.push(
        `lane ${id} switches harness from ${changed.harness} to ${harness}: a fresh sessionEpoch (${plan.epochs[id]}) was generated; \`serve\` only accepts the switch when the lane is drained and idle and retains the prior records, so stop and drain ${id} before starting the supervisor`,
      );
      if (prior.records[id]?.busy)
        plan.notes.push(
          `lane ${id} has a prior record that is not idle; \`serve\` will refuse the switch until it is drained`,
        );
      continue;
    }
    const kept = sources.find((lane) => lane.sessionEpoch)?.sessionEpoch;
    if (kept) plan.epochs[id] = kept;
  }
  return plan;
}
