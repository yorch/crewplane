// Pure helpers for the operator-controls layer: what each action means, the
// request it sends and how recorded outcomes read. No DOM and no network, so
// the rules can be unit tested. The server (and the supervisor behind it)
// remain the authority; everything here is advisory wording and request shape.

export const NOTE_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A request id the server uses for replay protection; one per dialog open. */
export function newRequestId(random = globalThis.crypto) {
  return random.randomUUID();
}

// kind -> how the dialog presents it. `destructive` kinds need typed confirmation.
const KINDS = {
  pause: {
    verb: "Pause",
    note: "none",
    effect: (c) =>
      `Places ${c.lane} on hold. No new run starts for it; a run already in progress is not interrupted.`,
  },
  resume: {
    verb: "Resume",
    note: "none",
    effect: (c) =>
      `Lifts the operator hold on ${c.lane} so the supervisor may schedule it again. It applies only if the agent is still at revision ${c.rev}.`,
  },
  retry: {
    verb: "Retry",
    note: "optional",
    effect: (c) =>
      `Clears the failure or no-progress pause on every paused task of ${c.lane} so they can run again with their existing sessions. It applies only if the agent is still at revision ${c.rev}.`,
  },
  "retry-new-session": {
    verb: "Retry with new session",
    note: "required",
    effect: (c) =>
      `Discards the native session ${c.sessionId} for ${c.task} on ${c.lane} and starts the next run with a fresh one. Your note is recorded and queued to the agent. It applies only if that session and revision are unchanged.`,
  },
  "retry-confirm-cleanup": {
    verb: "Confirm cleanup and retry",
    note: "required",
    ack: "I inspected the worktree and the earlier process is gone; its leftovers are safe to build on.",
    effect: (c) =>
      `Records that you verified the cleanup of run ${c.runId} for ${c.task} on ${c.lane} and clears its pause so it can run again. It applies only if that run is still the latest one.`,
  },
  "resolve-approve": {
    verb: "Approve",
    note: "required",
    effect: (c) =>
      `Approves the decision ${c.lane} is waiting on${c.task ? ` for ${c.task}` : ""}. Your note is sent to the agent as the approval and it resumes. It applies only if the agent is still at revision ${c.rev}.`,
  },
  "resolve-deny": {
    verb: "Deny",
    note: "required",
    effect: (c) =>
      `Denies the decision ${c.lane} is waiting on${c.task ? ` for ${c.task}` : ""}. Your note is sent to the agent as the reason and it resumes. It applies only if the agent is still at revision ${c.rev}.`,
  },
  nudge: {
    verb: "Nudge",
    note: "required",
    effect: (c) =>
      `Queues your note for ${c.lane}${c.task ? ` (${c.task})` : ""}. The agent reads it at its next run; nothing is interrupted or released.`,
  },
  cancel: {
    verb: "Cancel run",
    note: "none",
    destructive: true,
    effect: (c) =>
      `Asks the supervisor to terminate run ${c.runId} of ${c.lane} now. The work in progress is lost.`,
    confirmWord: (c) => c.lane,
  },
  stop: {
    verb: "Stop supervisor",
    note: "none",
    destructive: true,
    effect: () =>
      "Tells the supervisor to drain and stop. Running agents finish their current run, nothing new starts, and it stays stopped until someone starts it from the command line.",
    confirmWord: () => "stop",
  },
};
export const kinds = Object.keys(KINDS);

/** The dialog plan for an action, from what the operator was looking at. */
export function plan(kind, context) {
  const k = KINDS[kind];
  if (!k) throw new Error(`Unknown control ${kind}`);
  return {
    kind,
    verb: k.verb,
    title: k.destructive ? `${k.verb}?` : k.verb,
    effect: k.effect(context),
    noteRequired: k.note === "required",
    noteAllowed: k.note !== "none",
    ack: k.ack ?? null,
    destructive: k.destructive === true,
    confirmWord: k.confirmWord ? k.confirmWord(context) : null,
    context,
  };
}

/**
 * Whether the dialog may be submitted. `form` is { note, ack, typed }.
 * Returns null when valid, else a plain sentence for the operator.
 */
export function formProblem(p, form) {
  const note = (form.note ?? "").trim();
  if (p.noteRequired && !note) return "A note is required for this action.";
  if ((form.note ?? "").length > NOTE_MAX)
    return `Keep the note under ${NOTE_MAX} characters.`;
  if (p.ack && form.ack !== true)
    return "Confirm the statement above to continue.";
  if (p.confirmWord && (form.typed ?? "").trim() !== p.confirmWord)
    return `Type ${p.confirmWord} to confirm.`;
  return null;
}

/** The exact JSON body for POST /api/control; pins come from the context. */
export function requestBody(p, form, requestId) {
  const c = p.context;
  const note = (form.note ?? "").trim();
  const withNote = note ? { text: note } : {};
  switch (p.kind) {
    case "pause":
      return { action: "pause", lane: c.lane, requestId };
    case "resume":
      return { action: "resume", lane: c.lane, expectRev: c.rev, requestId };
    case "retry":
      return {
        action: "retry",
        lane: c.lane,
        ...withNote,
        expectRev: c.rev,
        requestId,
      };
    case "retry-new-session":
      return {
        action: "retry",
        lane: c.lane,
        task: c.task,
        newSession: true,
        ...withNote,
        expectRev: c.rev,
        expectSession: c.sessionId,
        requestId,
      };
    case "retry-confirm-cleanup":
      return {
        action: "retry",
        lane: c.lane,
        task: c.task,
        confirmCleanup: true,
        ...withNote,
        expectRev: c.rev,
        expectRun: c.runId,
        requestId,
      };
    case "resolve-approve":
    case "resolve-deny":
      return {
        action: "resolve",
        lane: c.lane,
        ...(c.task ? { task: c.task } : {}),
        pauseId: c.pauseId,
        resolution: p.kind === "resolve-approve" ? "approve" : "deny",
        ...withNote,
        expectRev: c.rev,
        requestId,
      };
    case "nudge":
      return {
        action: "nudge",
        lane: c.lane,
        ...(c.task ? { task: c.task } : {}),
        ...withNote,
        requestId,
      };
    case "cancel":
      return { action: "cancel", lane: c.lane, run: c.runId, requestId };
    case "stop":
      return { action: "stop", requestId };
    default:
      throw new Error(`Unknown control ${p.kind}`);
  }
}

// Reason codes the supervisor records, in plain language. Outcomes can repeat a
// code under another class (an unmet precondition is recorded as "invalid"), so
// the code is the primary key and the outcome the fallback.
const CODES = {
  HELD: "The agent is now on hold.",
  ALREADY_HELD: "It was already on hold; nothing changed.",
  RELEASED: "The hold was lifted.",
  RETRY: "The pause was cleared; the agent can run again.",
  NEW_SESSION: "A fresh native session will be used for the next run.",
  CLEANUP_ACKNOWLEDGED: "Cleanup was recorded and the pause cleared.",
  APPROVED: "The decision was approved and the agent was told.",
  DENIED: "The decision was denied and the agent was told.",
  NOTICE_QUEUED: "The note was queued for the agent.",
  CANCEL_REQUESTED: "Cancellation was requested for the run.",
  DRAINING: "The supervisor is draining and will stop.",
  STOP_CANCEL: "The supervisor is stopping.",
  NOTHING_TO_RECOVER: "There was nothing to recover; nothing changed.",
  RUN_NOT_ACTIVE:
    "That run is no longer active, so there was nothing to cancel.",
  UNKNOWN_TARGET: "The supervisor does not know that agent or task any more.",
  AMBIGUOUS_TARGET:
    "More than one record matched, so the supervisor refused to guess.",
  STALE_GENERATION:
    "The supervisor restarted, or was not running, after you opened this page. The command was not applied.",
  STALE_REVISION:
    "The agent changed after you opened this, so the command was not applied. Review it and try again.",
  STALE_RUN:
    "A newer run replaced the one you were looking at, so the command was not applied.",
  HELD_REFUSED: "The agent is on hold; resume it first.",
  LIVE_OWNERSHIP:
    "A process still owns this work, so it cannot be retried yet.",
  CLEANUP_UNVERIFIED:
    "An earlier process has not been verified as gone. Confirm cleanup first.",
  DECISION_NEEDS_RESOLVE:
    "This pause is a decision. Approve or deny it instead of retrying.",
  INVALID: "The supervisor could not read the command.",
  ROLLOUT: "A rollout drain was requested; the supervisor will drain.",
  STOP_WINS:
    "The operator stop is in force, so the rollout was refused. Start the supervisor from the command line first.",
  // Rejected before queueing (the dashboard's own refusals; they can also be
  // read back from an entry written by the CLI).
  INVALID_CONTROL: "The command was malformed and was not queued.",
  UNKNOWN_AGENT: "The agent is not configured, so the command was refused.",
  CLI_ONLY:
    "This action is only available from the command line; the dashboard refuses it.",
  PIN_REQUIRED:
    "The command did not say which revision, run or session it applies to, so it was refused.",
  LEGACY_LAYOUT:
    "An older supervisor layout is still present, so a command that could widen what runs was refused. Resolve it from the command line.",
  UNSUPPORTED_ACTION: "That action is not supported.",
  REQUEST_ID_REUSED: "The request id was already used for a different command.",
};
const OUTCOME = {
  applied: "Applied",
  noop: "No change",
  refused: "Refused",
  stale: "Out of date",
  invalid: "Not applied",
};
export function outcomeLabel(outcome) {
  return OUTCOME[outcome] ?? "Unknown";
}
/** Plain-language reason for a recorded code, or null when the code is not one this page knows. */
export function reasonText(code, outcome) {
  if (typeof code !== "string" || !/^[A-Z_]{1,64}$/.test(code)) return null;
  const key = code === "HELD" && outcome !== "applied" ? "HELD_REFUSED" : code;
  return Object.hasOwn(CODES, key) ? CODES[key] : null;
}
/** Plain-language explanation of a recorded outcome. */
export function explainOutcome(entry) {
  const code = /^[A-Z_]{1,64}$/.test(entry?.reason ?? "") ? entry.reason : null;
  const key =
    code === "HELD" && entry.outcome !== "applied" ? "HELD_REFUSED" : code;
  const text =
    (key && CODES[key]) ||
    (entry?.outcome === "applied"
      ? "The supervisor applied it."
      : "The supervisor did not apply it.");
  return `${outcomeLabel(entry?.outcome)}: ${text}${code ? ` (${code})` : ""}`;
}

/** The server's refusal, in words; the body's message is already sanitised text. */
export function errorText(status, body) {
  const code = typeof body?.code === "string" ? body.code : "";
  if (status === 429)
    return code === "QUEUE_FULL"
      ? "Too many commands are waiting for the supervisor. Wait until they are recorded, then try again."
      : "Too many controls in the last minute. Wait a moment and try again.";
  if (status === 403)
    return "The dashboard refused this control. Open the controls URL printed by crewplane dashboard again.";
  if (status === 409)
    return "That request was already used for a different command. Close this and start again.";
  if (typeof body?.error === "string") return body.error.slice(0, 300);
  return `The control could not be queued (${status}). Try again.`;
}

/** Only identifiers shaped like the server's are ever put into a request. */
export const safeId = (value) =>
  typeof value === "string" && UUID.test(value) ? value : null;
