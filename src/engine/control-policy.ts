import type { Lane, State } from "../contracts.ts";
import { validId, validTaskId } from "../project.ts";

export interface Control {
  action: string;
  generation?: string;
  confirmCleanup?: boolean;
  lane?: Lane;
  at?: string;
  text?: string;
  task?: string;
  newSession?: boolean;
}
export function control(value: unknown): Control {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { action: "invalid" };
  const c = value as Record<string, unknown>;
  if (
    typeof c.action !== "string" ||
    !["pause", "resume", "retry", "nudge", "stop", "rollout"].includes(c.action)
  )
    return { action: "invalid" };
  if (!["stop", "rollout"].includes(c.action) && !validId(c.lane as string))
    return { action: "invalid" };
  if (
    c.text !== undefined &&
    (typeof c.text !== "string" || c.text.length > 32768)
  )
    return { action: "invalid" };
  if (
    c.at !== undefined &&
    (typeof c.at !== "string" || !Number.isFinite(Date.parse(c.at)))
  )
    return { action: "invalid" };
  if (
    c.confirmCleanup !== undefined &&
    (c.confirmCleanup !== true ||
      c.action !== "retry" ||
      typeof c.text !== "string" ||
      !c.text.trim())
  )
    return { action: "invalid" };
  if (
    c.newSession !== undefined &&
    (c.newSession !== true ||
      c.action !== "retry" ||
      !validTaskId(c.task as string) ||
      c.confirmCleanup === true ||
      typeof c.text !== "string" ||
      !c.text.trim())
  )
    return { action: "invalid" };
  if (c.task !== undefined && c.newSession !== true)
    return { action: "invalid" };
  return {
    action: c.action,
    ...(c.confirmCleanup === true ? { confirmCleanup: true } : {}),
    ...(typeof c.generation === "string" ? { generation: c.generation } : {}),
    ...(typeof c.lane === "string" ? { lane: c.lane as Lane } : {}),
    ...(typeof c.text === "string" ? { text: c.text } : {}),
    ...(typeof c.task === "string" ? { task: c.task } : {}),
    ...(c.newSession === true ? { newSession: true } : {}),
    ...(typeof c.at === "string" ? { at: c.at } : {}),
  };
}
export function validState(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const s = value as State;
  if (
    s.version !== 1 ||
    !s.records ||
    typeof s.records !== "object" ||
    Array.isArray(s.records) ||
    !Array.isArray(s.held) ||
    s.held.some((l) => !validId(l)) ||
    !Array.isArray(s.commands) ||
    !s.commands.every((x) => typeof x === "string") ||
    !s.notices ||
    typeof s.notices !== "object"
  )
    return false;
  if (
    s.retiredRuns !== undefined &&
    (!s.retiredRuns ||
      typeof s.retiredRuns !== "object" ||
      Array.isArray(s.retiredRuns) ||
      Object.entries(s.retiredRuns).some(
        ([lane, runs]) =>
          !validId(lane) ||
          !Array.isArray(runs) ||
          runs.length > 60 ||
          runs.some((n) => !Number.isSafeInteger(n) || n < 0),
      ))
  )
    return false;
  for (const [key, r] of Object.entries(s.records))
    if (
      !r ||
      r.key !== key ||
      !validId(r.lane) ||
      !["running", "idle", "paused"].includes(r.status) ||
      typeof r.cwd !== "string" ||
      !Array.isArray(r.seen) ||
      !r.seen.every((x) => typeof x === "string") ||
      !Array.isArray(r.runs) ||
      !r.runs.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      ![r.noProgress, r.inputTokens, r.outputTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      (r.permissionDenials !== undefined &&
        (!Number.isSafeInteger(r.permissionDenials) ||
          r.permissionDenials < 0)) ||
      (r.permissionDenialsKnown !== undefined &&
        typeof r.permissionDenialsKnown !== "boolean") ||
      (r.reportedCostUsd !== undefined &&
        (typeof r.reportedCostUsd !== "number" ||
          !Number.isFinite(r.reportedCostUsd) ||
          r.reportedCostUsd < 0 ||
          r.reportedCostUsd > 1e6)) ||
      (r.costKnown !== undefined && typeof r.costKnown !== "boolean") ||
      (r.lastSessionReset !== undefined &&
        (!r.lastSessionReset ||
          typeof r.lastSessionReset !== "object" ||
          typeof r.lastSessionReset.at !== "string" ||
          !Number.isFinite(Date.parse(r.lastSessionReset.at)) ||
          typeof r.lastSessionReset.previousSessionId !== "string" ||
          typeof r.lastSessionReset.note !== "string" ||
          r.lastSessionReset.note.length > 32768))
    )
      return false;
  if (
    s.controlOutcome !== undefined &&
    (!s.controlOutcome ||
      typeof s.controlOutcome !== "object" ||
      Array.isArray(s.controlOutcome) ||
      Object.entries(s.controlOutcome).some(
        ([lane, outcome]) =>
          !validId(lane) ||
          !outcome ||
          typeof outcome.action !== "string" ||
          !["applied", "refused"].includes(outcome.outcome) ||
          typeof outcome.reason !== "string" ||
          outcome.reason.length > 2000 ||
          typeof outcome.at !== "string" ||
          !Number.isFinite(Date.parse(outcome.at)),
      ))
  )
    return false;
  return Object.entries(s.notices).every(
    ([l, notes]) =>
      validId(l) &&
      Array.isArray(notes) &&
      notes.length <= 100 &&
      notes.every((n) => typeof n === "string" && n.length <= 32768),
  );
}
