import { createHash } from "node:crypto";
import type { Config, Lane, State } from "../../contracts.ts";
import { validId, validTaskId } from "../../project.ts";
import { type Control, control } from "../control-policy.ts";
import { clean } from "./sanitize.ts";

/**
 * Dashboard operator controls. Nothing here applies a command: a request is
 * validated by the very `control()` the CLI uses, written to the control
 * directory and later consumed (or refused) by the supervisor, which records
 * exactly one outcome in `state.controlLog`.
 */

/** Verbs the dashboard may queue, in display order. */
export const dashboardVerbs = [
  "pause",
  "resume",
  "retry",
  "resolve",
  "nudge",
  "cancel",
  "stop",
] as const;
export type DashboardVerb = (typeof dashboardVerbs)[number];
/** Verbs and options that stay CLI-only, with the reason shown to operators. */
export const cliOnly = [
  {
    verb: "rollout",
    reason:
      "A release hand-over restarts supervision; it needs the CLI and the pinned executable.",
  },
  {
    verb: "stop --cancel-active",
    reason:
      "It terminates running agent processes while stopping; use cancel on one run, or the CLI.",
  },
  {
    verb: "resume --all",
    reason:
      "It lifts the instance hold for every agent and cannot be pinned to one revision.",
  },
] as const;
/** Lifting a hold, pause or failure; these must be pinned like the CLI pins them. */
export const wideningVerbs = new Set<string>(["retry", "resolve", "resume"]);
/** Narrowing verbs are always safe to apply late and may be queued without config. */
const narrowing = new Set<string>(["pause", "stop", "cancel"]);

export const maxNoteChars = 2000;
const requestIdPattern = /^[a-f0-9-]{36}$/;
const runPattern = /^\d{13}-[a-f0-9-]{36}$/;
const sessionPattern = /^[A-Za-z0-9_-]{1,80}$/;
const allowedKeys = new Set([
  "action",
  "lane",
  "task",
  "run",
  "all",
  "confirmCleanup",
  "newSession",
  "resolution",
  "pauseId",
  "text",
  "expectRev",
  "expectRun",
  "expectSession",
  "requestId",
]);

export type ControlRequest =
  | { ok: true; value: Control; requestId: string | null }
  | { ok: false; code: string; message: string };
const fail = (code: string, message: string): ControlRequest => ({
  ok: false,
  code,
  message,
});

/**
 * Validate a dashboard request. `lanes` are the configured agents (null when
 * no configuration is readable), `generation` the supervisor generation the
 * operator was looking at, exactly as the CLI binds it.
 */
export function parseControlRequest(
  body: unknown,
  context: {
    generation?: string | undefined;
    lanes: string[] | null;
    at: string;
  },
): ControlRequest {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return fail(
      "INVALID_CONTROL",
      "The control request must be a JSON object.",
    );
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!allowedKeys.has(key))
      return key === "cancelActive"
        ? fail(
            "CLI_ONLY",
            "stop --cancel-active is CLI-only; cancel a single run instead.",
          )
        : fail(
            "UNKNOWN_FIELD",
            `Unknown field ${JSON.stringify(key.slice(0, 40))}.`,
          );
  const action = raw.action;
  if (action === "rollout") return fail("CLI_ONLY", "rollout is CLI-only.");
  if (
    typeof action !== "string" ||
    !(dashboardVerbs as readonly string[]).includes(action)
  )
    return fail(
      "UNSUPPORTED_ACTION",
      "This action is not offered by the dashboard.",
    );
  const input: Record<string, unknown> = {};
  for (const key of [
    "lane",
    "task",
    "run",
    "resolution",
    "pauseId",
    "text",
    "expectRun",
    "expectSession",
  ])
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string")
        return fail("INVALID_CONTROL", `${key} must be a string.`);
      input[key] = raw[key];
    }
  for (const key of ["all", "confirmCleanup", "newSession"])
    if (raw[key] !== undefined) {
      if (raw[key] !== true)
        return fail("INVALID_CONTROL", `${key} must be true when present.`);
      input[key] = true;
    }
  if (raw.expectRev !== undefined) {
    if (!Number.isSafeInteger(raw.expectRev) || (raw.expectRev as number) < 0)
      return fail(
        "INVALID_CONTROL",
        "expectRev must be a non-negative integer.",
      );
    input.expectRev = raw.expectRev;
  }
  let requestId: string | null = null;
  if (raw.requestId !== undefined) {
    if (
      typeof raw.requestId !== "string" ||
      !requestIdPattern.test(raw.requestId)
    )
      return fail("INVALID_CONTROL", "requestId must be a UUID.");
    requestId = raw.requestId;
  }
  if (typeof input.text === "string" && input.text.length > maxNoteChars)
    return fail(
      "NOTE_TOO_LONG",
      `The note is limited to ${maxNoteChars} characters.`,
    );
  // Same pins the CLI applies automatically; the dashboard has no state of its
  // own to pin from, so the operator's observed revision must be sent.
  if (action === "resume" && input.all === true)
    return fail(
      "CLI_ONLY",
      "resume --all is CLI-only: it cannot be pinned to a revision.",
    );
  if (wideningVerbs.has(action) && input.expectRev === undefined)
    return fail(
      "PIN_REQUIRED",
      `${action} requires expectRev, the lane revision you were looking at.`,
    );
  if (action === "retry" && input.confirmCleanup === true) {
    if (input.task === undefined || input.expectRun === undefined)
      return fail(
        "PIN_REQUIRED",
        "retry with confirmCleanup requires task and expectRun.",
      );
  }
  if (
    action === "retry" &&
    input.newSession === true &&
    input.expectSession === undefined
  )
    return fail(
      "PIN_REQUIRED",
      "retry with newSession requires expectSession.",
    );
  const noteRequired =
    action === "nudge" ||
    action === "resolve" ||
    (action === "retry" &&
      (input.newSession === true || input.confirmCleanup === true));
  if (noteRequired && !(typeof input.text === "string" && input.text.trim()))
    return fail(
      "NOTE_REQUIRED",
      `${action} requires a non-empty operator note.`,
    );
  if ((action === "nudge" || wideningVerbs.has(action)) && requestId === null)
    return fail(
      "REQUEST_ID_REQUIRED",
      `${action} requires a requestId (UUID) for replay protection.`,
    );
  const lane = input.lane as string | undefined;
  if (lane !== undefined) {
    // Mirrors the CLI: narrowing verbs only check lanes against a readable
    // configuration; every other verb needs the lane to be configured.
    const known = context.lanes?.includes(lane) ?? false;
    if (context.lanes ? !known : !narrowing.has(action))
      return fail("UNKNOWN_AGENT", "Unknown configured agent.");
  }
  const value = control({
    v: 2,
    action,
    ...input,
    ...(context.generation ? { generation: context.generation } : {}),
    issuer: "dashboard",
    at: context.at,
  });
  if (value.action === "invalid")
    return fail(
      "INVALID_CONTROL",
      "Invalid control; check the action, target and options.",
    );
  return { ok: true, value, requestId };
}

/** What a request means, independent of when it was made or who bound it. */
export const fingerprint = (value: Control) => {
  const { at: _at, generation: _generation, ...rest } = value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
};

/**
 * Bounded in-memory guards for the HTTP endpoint: a sliding-window rate limit
 * on queued commands and a short replay cache keyed by the client's request id.
 */
export function createControlGuard(
  options: {
    perMinute?: number;
    replayMs?: number;
    maxReplay?: number;
    maxPending?: number;
    now?: () => number;
  } = {},
) {
  const perMinute = options.perMinute ?? 20;
  const replayMs = options.replayMs ?? 10 * 60_000;
  const maxReplay = options.maxReplay ?? 256;
  const now = options.now ?? Date.now;
  const stamps: number[] = [];
  const seen = new Map<
    string,
    { at: number; fingerprint: string; body: unknown }
  >();
  const prune = () => {
    const t = now();
    while (stamps.length && (stamps[0] as number) <= t - 60_000) stamps.shift();
    for (const [key, entry] of seen)
      if (entry.at <= t - replayMs) seen.delete(key);
  };
  return {
    perMinute,
    maxPending: options.maxPending ?? 50,
    /** Reserve one slot synchronously; the caller releases it if queuing fails. */
    reserve(): { ok: true } | { ok: false; retryAfter: number } {
      prune();
      if (stamps.length >= perMinute)
        return {
          ok: false,
          retryAfter: Math.max(
            1,
            Math.ceil(((stamps[0] as number) + 60_000 - now()) / 1000),
          ),
        };
      stamps.push(now());
      return { ok: true };
    },
    release() {
      stamps.pop();
    },
    recall(id: string) {
      prune();
      return seen.get(id);
    },
    remember(id: string, fingerprintValue: string, body: unknown) {
      prune();
      seen.set(id, { at: now(), fingerprint: fingerprintValue, body });
      while (seen.size > maxReplay) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    },
  };
}

interface TaskControls {
  task: string | null;
  runId: string | null;
  sessionId: string | null;
  status: string;
  pauseKind: string | null;
  pauseId: string | null;
  cleanupUnverified: boolean;
  verbs: string[];
}
/**
 * Advisory capability block derived from the same persisted state the
 * supervisor decides from. It carries the revisions and identifiers a request
 * must pin; the supervisor still decides, and may answer stale or refused.
 */
export function controlsView(
  enabled: boolean,
  state: State | null,
  config: Config | null,
  supervisor: { running: boolean },
) {
  if (!enabled) return { version: 1, enabled: false };
  const heldLanes = new Set(Array.isArray(state?.held) ? state.held : []);
  const instanceHeld = state?.instanceHeld === true;
  const records = Object.values(state?.records ?? {});
  const names = [
    ...new Set([
      ...Object.keys(config?.lanes ?? {}),
      ...records.map((r) => r.lane),
      ...heldLanes,
    ]),
  ]
    .filter((lane) => validId(lane))
    .sort()
    .slice(0, 100);
  const live = (r: (typeof records)[number]) =>
    r.status === "running" || !!r.pid || !!r.processGroupId;
  const lanes = names.map((lane) => {
    const configured = config === null || Object.hasOwn(config.lanes, lane);
    const laneRecords = records.filter((r) => r.lane === lane);
    const held = heldLanes.has(lane);
    const blocked = laneRecords.some((r) => live(r) || r.cleanupUnverified);
    const verbs = new Set<string>();
    if (configured) {
      verbs.add("nudge");
      if (!held && !instanceHeld) verbs.add("pause");
      if (held) verbs.add("resume");
      if (
        !held &&
        !instanceHeld &&
        !blocked &&
        laneRecords.some(
          (r) =>
            r.status === "paused" &&
            (!r.pauseKind || ["failure", "no-progress"].includes(r.pauseKind)),
        )
      )
        verbs.add("retry");
    }
    const tasks: TaskControls[] = laneRecords.slice(0, 50).map((r) => {
      const task =
        typeof r.task === "string" && validTaskId(r.task) ? r.task : null;
      const runId =
        typeof r.runId === "string" && runPattern.test(r.runId)
          ? r.runId
          : null;
      const sessionId =
        typeof r.sessionId === "string" && sessionPattern.test(r.sessionId)
          ? r.sessionId
          : null;
      const pauseId =
        typeof r.pauseId === "string" && requestIdPattern.test(r.pauseId)
          ? r.pauseId
          : null;
      const recordVerbs: string[] = [];
      if (configured) {
        if (
          r.status === "running" &&
          !r.finishedAt &&
          runId &&
          !r.cancelRequested
        )
          recordVerbs.push("cancel");
        if (
          r.status === "paused" &&
          r.pauseKind === "decision" &&
          pauseId &&
          (r.task === null || task)
        )
          recordVerbs.push("resolve");
        if (!held && !instanceHeld && task && !live(r)) {
          if (r.cleanupUnverified && runId)
            recordVerbs.push("retry-confirm-cleanup");
          if (
            sessionId &&
            !blocked &&
            r.pauseKind !== "decision" &&
            r.pauseKind !== "operator"
          )
            recordVerbs.push("retry-new-session");
        }
      }
      return {
        task,
        runId,
        sessionId,
        status: clean(r.status, 16) ?? "unknown",
        pauseKind: clean(r.pauseKind, 16),
        pauseId,
        cleanupUnverified: r.cleanupUnverified === true,
        verbs: recordVerbs,
      };
    });
    const rev = state?.laneRev?.[lane as Lane];
    return {
      lane,
      rev: Number.isSafeInteger(rev) && (rev as number) >= 0 ? rev : 0,
      held,
      verbs: [...verbs],
      tasks,
    };
  });
  return {
    version: 1,
    enabled: true,
    verbs: [...dashboardVerbs],
    cliOnly,
    supervisor: {
      running: supervisor.running,
      draining: state?.draining === true,
    },
    instanceHeld,
    stopAvailable: supervisor.running && state?.draining !== true,
    limits: { maxNoteChars },
    lanes,
  };
}
