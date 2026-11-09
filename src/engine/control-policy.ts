import type { Lane, State } from "../contracts.ts";
import { validId, validTaskId } from "../project.ts";

export type ControlAction =
  | "pause"
  | "resume"
  | "stop"
  | "rollout"
  | "cancel"
  | "retry"
  | "resolve"
  | "nudge";
export interface Control {
  v: 1 | 2;
  action: ControlAction | "invalid";
  generation?: string;
  issuer?: string;
  lane?: Lane;
  task?: string;
  run?: string;
  all?: boolean;
  confirmCleanup?: boolean;
  newSession?: boolean;
  resolution?: "approve" | "deny";
  pauseId?: string;
  text?: string;
  at?: string;
  expectRev?: number;
  expectRun?: string;
  expectSession?: string;
}
const actions = [
  "pause",
  "resume",
  "stop",
  "rollout",
  "cancel",
  "retry",
  "resolve",
  "nudge",
] as const;
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const optionalText = (value: unknown) =>
  value === undefined || (typeof value === "string" && value.length <= 32768);
const optionalIdentifier = (value: unknown, pattern: RegExp) =>
  value === undefined || (typeof value === "string" && pattern.test(value));
const rev = (value: unknown) =>
  value === undefined ||
  (Number.isSafeInteger(value) && (value as number) >= 0);
export function control(value: unknown): Control {
  const invalid = { v: 2, action: "invalid" } as Control;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid;
  const c = value as Record<string, unknown>;
  const v = c.v === undefined ? 1 : c.v;
  if (v !== 1 && v !== 2) return invalid;
  if (
    typeof c.action !== "string" ||
    !(actions as readonly string[]).includes(c.action)
  )
    return invalid;
  const action = c.action as ControlAction;
  if (!optionalText(c.text)) return invalid;
  if (c.at !== undefined && !iso(c.at)) return invalid;
  if (!rev(c.expectRev)) return invalid;
  if (
    !optionalIdentifier(c.expectRun, /^\d{13}-[a-f0-9-]{36}$/) ||
    !optionalIdentifier(c.expectSession, /^[A-Za-z0-9_-]{1,80}$/)
  )
    return invalid;
  if (
    c.issuer !== undefined &&
    (typeof c.issuer !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(c.issuer))
  )
    return invalid;
  const lane = typeof c.lane === "string" ? (c.lane as Lane) : undefined;
  const task = typeof c.task === "string" ? c.task : undefined;
  const run = typeof c.run === "string" ? c.run : undefined;
  const all = c.all === true;
  const text = typeof c.text === "string" ? c.text : undefined;
  const textRequired = () => typeof text === "string" && !!text.trim();
  if (c.confirmCleanup !== undefined && c.confirmCleanup !== true)
    return invalid;
  if (c.newSession !== undefined && c.newSession !== true) return invalid;
  if (c.all !== undefined && c.all !== true) return invalid;
  switch (action) {
    case "pause":
    case "resume":
      if ((lane !== undefined) === all || text !== undefined) return invalid;
      break;
    case "stop":
    case "rollout":
      if (lane || task || run || all || text !== undefined) return invalid;
      break;
    case "cancel":
      if (all) {
        if (lane || run || task) return invalid;
      } else if (!lane || !run || !/^\d{13}-[a-f0-9-]{36}$/.test(run) || task)
        return invalid;
      if (text !== undefined) return invalid;
      break;
    case "retry":
      if (!lane || all || !optionalText(text)) return invalid;
      if (c.newSession === true) {
        if (!task || !validTaskId(task) || !textRequired()) return invalid;
        if (c.confirmCleanup === true) return invalid;
      } else if (c.confirmCleanup === true) {
        if (!textRequired()) return invalid;
        if (task !== undefined && !validTaskId(task)) return invalid;
      } else if (task !== undefined || c.resolution !== undefined)
        return invalid;
      break;
    case "resolve":
      if (
        !lane ||
        all ||
        !task ||
        !validTaskId(task) ||
        !textRequired() ||
        !c.pauseId ||
        typeof c.pauseId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(c.pauseId) ||
        (c.resolution !== "approve" && c.resolution !== "deny")
      )
        return invalid;
      break;
    case "nudge":
      if (!lane || all || !textRequired()) return invalid;
      if (task !== undefined && !validTaskId(task)) return invalid;
      break;
  }
  if (lane && !validId(lane)) return invalid;
  if (run && !/^\d{13}-[a-f0-9-]{36}$/.test(run)) return invalid;
  return {
    v,
    action,
    ...(typeof c.generation === "string" ? { generation: c.generation } : {}),
    ...(typeof c.issuer === "string" ? { issuer: c.issuer } : {}),
    ...(lane ? { lane } : {}),
    ...(task ? { task } : {}),
    ...(run ? { run } : {}),
    ...(all ? { all: true } : {}),
    ...(c.confirmCleanup === true ? { confirmCleanup: true } : {}),
    ...(c.newSession === true ? { newSession: true } : {}),
    ...(c.resolution === "approve" || c.resolution === "deny"
      ? { resolution: c.resolution }
      : {}),
    ...(typeof c.pauseId === "string" ? { pauseId: c.pauseId } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(typeof c.at === "string" ? { at: c.at } : {}),
    ...(typeof c.expectRev === "number" ? { expectRev: c.expectRev } : {}),
    ...(typeof c.expectRun === "string" ? { expectRun: c.expectRun } : {}),
    ...(typeof c.expectSession === "string"
      ? { expectSession: c.expectSession }
      : {}),
  };
}
export function validState(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const s = value as State;
  if (
    ![1, 2].includes(s.version) ||
    !s.records ||
    typeof s.records !== "object" ||
    Array.isArray(s.records) ||
    !Array.isArray(s.held) ||
    s.held.some((l) => !validId(l)) ||
    !Array.isArray(s.commands) ||
    !s.commands.every((x) => typeof x === "string") ||
    !s.notices ||
    typeof s.notices !== "object" ||
    (s.instanceHeld !== undefined && typeof s.instanceHeld !== "boolean") ||
    (s.laneRev !== undefined &&
      (!s.laneRev ||
        typeof s.laneRev !== "object" ||
        Array.isArray(s.laneRev) ||
        Object.entries(s.laneRev).some(
          ([lane, revision]) => !validId(lane) || !rev(revision),
        ))) ||
    (s.controlSeq !== undefined && !rev(s.controlSeq)) ||
    (s.controlLog !== undefined &&
      (!Array.isArray(s.controlLog) ||
        s.controlLog.length > 200 ||
        s.controlLog.some(
          (entry) =>
            !entry ||
            typeof entry.id !== "string" ||
            !/^[a-f0-9-]{36}$/.test(entry.id) ||
            !rev(entry.seq) ||
            typeof entry.action !== "string" ||
            !["instance", "lane", "task", "run"].includes(entry.scope) ||
            (entry.target !== null && typeof entry.target !== "string") ||
            !["applied", "noop", "refused", "stale", "invalid"].includes(
              entry.outcome,
            ) ||
            typeof entry.code !== "string" ||
            !iso(entry.at) ||
            (entry.issuer !== null && typeof entry.issuer !== "string"),
        )))
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
      (r.pauseId !== undefined &&
        (typeof r.pauseId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(r.pauseId))) ||
      (r.cancelRequested !== undefined &&
        typeof r.cancelRequested !== "boolean") ||
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
