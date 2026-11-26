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
 * session epoch differs from its latest state record unless the lane is drained
 * and idle and carries a fresh explicit `sessionEpoch`. `assertSwitch` compares
 * only against that latest record, so that is all setup compares against when
 * the lane has one: an unchanged harness reuses the record's epoch (or none),
 * a changed harness gets a fresh epoch. The installed configuration is
 * consulted only for a lane with no record at all (nothing has run there yet,
 * so `serve` has nothing to refuse; the config just keeps the epoch stable).
 * Pi lanes are planned the same way; a Pi lane that needs no reuse and has no
 * switch falls back to the fresh Pi epoch from the answers.
 */
export function planEpochs(
  lanes: Record<string, Harness>,
  prior: Prior,
  mint: () => string,
): EpochPlan {
  const plan: EpochPlan = { epochs: {}, notes: [] };
  for (const [id, harness] of Object.entries(lanes)) {
    const record = prior.records[id];
    const reference = record ?? prior.config[id];
    if (reference && reference.harness !== harness) {
      plan.epochs[id] = mint();
      plan.notes.push(
        `lane ${id} switches harness from ${reference.harness} to ${harness}: a fresh sessionEpoch (${plan.epochs[id]}) was generated; \`serve\` only accepts the switch when the lane is drained and idle and retains the prior records, so stop and drain ${id} before starting the supervisor`,
      );
      if (record?.busy)
        plan.notes.push(
          `lane ${id} has a prior record that is not idle; \`serve\` will refuse the switch until it is drained`,
        );
      continue;
    }
    const installed = prior.config[id];
    if (
      record &&
      installed?.harness === harness &&
      installed.sessionEpoch &&
      installed.sessionEpoch !== record.sessionEpoch
    )
      plan.notes.push(
        `lane ${id}: the installed configuration's sessionEpoch (${installed.sessionEpoch}) was discarded because the latest state record ${record.sessionEpoch ? `has sessionEpoch ${record.sessionEpoch}` : "has none"}; \`serve\` will resume the recorded session`,
      );
    if (reference?.sessionEpoch) plan.epochs[id] = reference.sessionEpoch;
  }
  return plan;
}
