// Operator controls. This layer exists only when the server reports controls
// enabled (GET /api/controls) AND the page holds the controls token from the
// printed controls URL; otherwise nothing here renders and nothing is sent.
// Every button opens a confirmation dialog, posts to POST /api/control and then
// shows the single outcome the supervisor records in the control log. All text
// is set with textContent; the server stays the authority.
import { controlFetch, hasControlsToken, refresh } from "./api.js";
import {
  errorText,
  explainOutcome,
  formProblem,
  NOTE_MAX,
  newRequestId,
  plan,
  requestBody,
} from "./controls-core.js";
import { el, section } from "./dom.js";
import { $, hooks } from "./store.js";

const view = { enabled: false, data: null, signature: "", loading: false };
let checked = false;
let currentRun = null;

/** Controls exist only with server support and the controls token. */
export const controlsActive = () => view.enabled && hasControlsToken();

const laneEntry = (lane) => view.data?.lanes?.find((l) => l.lane === lane);
const taskEntry = (lane, task, runId) =>
  laneEntry(lane)?.tasks.find((t) =>
    runId ? t.runId === runId : (t.task ?? null) === (task ?? null),
  );
function context(lane, task, runId) {
  const l = laneEntry(lane);
  if (!l) return null;
  const t = task !== undefined || runId ? taskEntry(lane, task, runId) : null;
  return {
    lane,
    rev: l.rev,
    ...(t?.task ? { task: t.task } : {}),
    ...(t?.runId ? { runId: t.runId } : {}),
    ...(t?.sessionId ? { sessionId: t.sessionId } : {}),
    ...(t?.pauseId ? { pauseId: t.pauseId } : {}),
  };
}

/** Per-snapshot refresh; a server without controls is asked only once. */
export const refreshControls = () => loadControls(false);
export async function loadControls(force = false) {
  if (view.loading || (checked && !view.enabled && !force)) return;
  view.loading = true;
  try {
    const response = await window.crewplaneFetch("/api/controls", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("controls unavailable");
    const next = await response.json();
    checked = true;
    view.enabled = next?.enabled === true && Array.isArray(next.lanes);
    view.data = view.enabled ? next : null;
  } catch {
    // Keep the previous capability; the server decides on every request.
    return;
  } finally {
    view.loading = false;
  }
  const signature = JSON.stringify(view.data);
  const changed = signature !== view.signature;
  view.signature = signature;
  paintFoot();
  if (changed) {
    hooks.render();
    syncRunActions();
  }
}

function paintFoot() {
  const foot = document.querySelector(".sidebar-foot");
  if (!foot) return;
  foot.textContent = !view.enabled
    ? "Read-only · local only"
    : hasControlsToken()
      ? "Operator controls on · local only"
      : "Read-only here · open the controls URL for controls";
}

const button = (label, key, handler, className) => {
  const node = el(
    "button",
    label,
    `control-button${className ? ` ${className}` : ""}`,
  );
  node.type = "button";
  node.dataset.focusKey = `control:${key}`;
  node.addEventListener("click", handler);
  return node;
};
const open = (kind, lane, task, runId, key) => {
  const ctx = context(lane, task, runId);
  if (!ctx) return;
  openDialog(plan(kind, ctx), `control:${key}`);
};
const label = (text, task) => (task ? `${text} (${task})` : text);

/** Contextual controls for one agent, inside its detail pane. */
export function laneControls(lane) {
  if (!controlsActive()) return null;
  const entry = laneEntry(lane);
  if (!entry) return null;
  const actions = el("div", undefined, "control-actions");
  const add = (text, kind, task, runId, className) =>
    actions.append(
      button(
        text,
        `${kind}:${lane}:${task ?? ""}:${runId ?? ""}`,
        () =>
          open(
            kind,
            lane,
            task,
            runId,
            `${kind}:${lane}:${task ?? ""}:${runId ?? ""}`,
          ),
        className,
      ),
    );
  for (const [verb, text] of [
    ["pause", "Pause"],
    ["resume", "Resume"],
    ["retry", "Retry"],
    ["nudge", "Nudge"],
  ])
    if (entry.verbs.includes(verb)) add(text, verb, undefined);
  const nodes = [actions];
  const rows = entry.tasks.filter((t) => t.verbs.length);
  if (rows.length) {
    const list = el("ul", undefined, "control-tasks");
    for (const t of rows) {
      const row = el("li", undefined, "control-row");
      row.append(
        el(
          "span",
          `${t.task ?? "Coordination"} · ${t.status}${t.pauseKind ? ` (${t.pauseKind})` : ""}`,
          "control-task",
        ),
      );
      const buttons = el("span", undefined, "control-actions");
      const addTask = (text, kind, className) =>
        buttons.append(
          button(
            text,
            `${kind}:${lane}:${t.task ?? ""}:${t.runId ?? ""}`,
            () =>
              open(
                kind,
                lane,
                t.task,
                t.runId,
                `${kind}:${lane}:${t.task ?? ""}:${t.runId ?? ""}`,
              ),
            className,
          ),
        );
      if (t.verbs.includes("resolve")) {
        addTask("Approve", "resolve-approve");
        addTask("Deny", "resolve-deny");
      }
      if (t.verbs.includes("retry-new-session"))
        addTask("Retry with new session", "retry-new-session");
      if (t.verbs.includes("retry-confirm-cleanup"))
        addTask("Confirm cleanup and retry", "retry-confirm-cleanup");
      if (t.verbs.includes("cancel")) addTask("Cancel run", "cancel", "danger");
      row.append(buttons);
      list.append(row);
    }
    nodes.push(list);
  }
  if (!actions.children.length && !rows.length)
    nodes.push(el("p", "No controls apply to this agent right now.", "note"));
  nodes.push(
    el(
      "p",
      "Each control asks for confirmation, is queued for the supervisor and then shows the outcome it recorded. The supervisor can still refuse it.",
      "note",
    ),
  );
  return section("Operator controls", ...nodes);
}

/** Decisions waiting for the operator (Overview attention and Messages). */
export function decisionBlock() {
  if (!controlsActive()) return null;
  const rows = [];
  for (const lane of view.data.lanes)
    for (const t of lane.tasks)
      if (t.verbs.includes("resolve")) rows.push([lane.lane, t]);
  if (!rows.length) return null;
  const box = el("div", undefined, "decision-block");
  box.append(el("h3", "Decisions waiting for you"));
  const list = el("ul", undefined, "control-tasks");
  for (const [lane, t] of rows) {
    const row = el("li", undefined, "control-row");
    row.append(
      el(
        "span",
        `${lane} · ${t.task ?? "coordination"} needs an approval or denial`,
        "control-task",
      ),
    );
    const buttons = el("span", undefined, "control-actions");
    for (const [text, kind] of [
      ["Approve", "resolve-approve"],
      ["Deny", "resolve-deny"],
    ]) {
      buttons.append(
        button(
          label(text, t.task),
          `${kind}:${lane}:${t.task ?? ""}:${t.runId ?? ""}:block`,
          () =>
            open(
              kind,
              lane,
              t.task,
              t.runId,
              `${kind}:${lane}:${t.task ?? ""}:${t.runId ?? ""}:block`,
            ),
        ),
      );
    }
    row.append(buttons);
    list.append(row);
  }
  box.append(list);
  return box;
}

/** Stop control for the System view. */
export function supervisorControls() {
  if (!controlsActive() || view.data.stopAvailable !== true) return null;
  const box = el("div", undefined, "control-actions");
  box.append(
    button(
      "Stop supervisor",
      "stop:supervisor",
      () => {
        openDialog(plan("stop", {}), "control:stop:supervisor");
      },
      "danger",
    ),
  );
  return box;
}

// The Runs view keeps its own script; it announces the selected run here.
function syncRunActions() {
  const host = $("run-actions");
  if (!host) return;
  host.replaceChildren();
  if (!controlsActive() || !currentRun) return;
  const t = taskEntry(currentRun.lane, undefined, currentRun.runId);
  if (!t?.verbs.includes("cancel")) return;
  host.append(
    button(
      "Cancel run",
      `cancel:${currentRun.lane}:run`,
      () =>
        open(
          "cancel",
          currentRun.lane,
          undefined,
          currentRun.runId,
          `cancel:${currentRun.lane}:run`,
        ),
      "danger",
    ),
  );
}
window.addEventListener("crewplane-run-selected", (event) => {
  currentRun = event.detail;
  syncRunActions();
});

// ---- Confirmation dialog ---------------------------------------------------
let dialog = null;
let returnKey = null;
let returnTo = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = el("dialog", undefined, "control-dialog");
  dialog.id = "control-dialog";
  dialog.setAttribute("aria-labelledby", "control-title");
  dialog.setAttribute("aria-describedby", "control-effect");
  dialog.addEventListener("close", () => {
    // The trigger may have been rebuilt by a snapshot; find it again by key.
    const target =
      (returnTo?.isConnected ? returnTo : null) ??
      (returnKey
        ? document.querySelector(`[data-focus-key="${CSS.escape(returnKey)}"]`)
        : null) ??
      $("view-title");
    target?.focus({ preventScroll: true });
    returnTo = null;
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [
      ...dialog.querySelectorAll("button, input, textarea, [href]"),
    ].filter((n) => !n.disabled && !n.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.append(dialog);
  return dialog;
}

const factRows = (c) =>
  [
    ["Agent", c.lane],
    ["Task", c.task],
    ["Run", c.runId],
    ["Session", c.sessionId],
    ["Lane revision pinned", c.rev === undefined ? null : String(c.rev)],
  ].filter(([, value]) => value);

function openDialog(p, key) {
  const d = ensureDialog();
  if (d.open) return;
  returnKey = key;
  returnTo = document.activeElement;
  const title = el("h2", p.title);
  title.id = "control-title";
  const effect = el("p", p.effect);
  effect.id = "control-effect";
  const facts = el("dl", undefined, "control-facts");
  for (const [term, value] of factRows(p.context))
    facts.append(el("dt", term), el("dd", value));
  const nodes = [title, effect];
  if (facts.children.length) nodes.push(facts);
  let note = null;
  let ack = null;
  let typed = null;
  if (p.noteAllowed) {
    const wrap = el("div", undefined, "control-field");
    const lab = el(
      "label",
      p.noteRequired ? "Note (required)" : "Note (optional)",
    );
    lab.htmlFor = "control-note";
    note = el("textarea");
    note.id = "control-note";
    note.rows = 4;
    note.maxLength = NOTE_MAX;
    note.setAttribute("aria-describedby", "control-note-help control-error");
    const help = el(
      "p",
      "The note is recorded and shown to the agent. Do not paste secrets.",
      "field-help",
    );
    help.id = "control-note-help";
    wrap.append(lab, note, help);
    nodes.push(wrap);
  }
  if (p.ack) {
    const wrap = el("label", undefined, "control-check");
    ack = el("input");
    ack.type = "checkbox";
    ack.id = "control-ack";
    wrap.append(ack, el("span", p.ack));
    nodes.push(wrap);
  }
  if (p.confirmWord) {
    const wrap = el("div", undefined, "control-field");
    const lab = el("label", `Type ${p.confirmWord} to confirm`);
    lab.htmlFor = "control-typed";
    typed = el("input");
    typed.id = "control-typed";
    typed.type = "text";
    typed.autocomplete = "off";
    typed.spellcheck = false;
    wrap.append(lab, typed);
    nodes.push(wrap);
  }
  const error = el("p", undefined, "control-error");
  error.id = "control-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const cancel = el("button", "Keep as is", "control-button");
  cancel.type = "button";
  const confirm = el(
    "button",
    p.verb,
    `control-button ${p.destructive ? "danger" : "primary"}`,
  );
  confirm.type = "button";
  const buttons = el("div", undefined, "control-dialog-actions");
  buttons.append(cancel, confirm);
  nodes.push(error, buttons);
  d.replaceChildren(...nodes);
  const fail = (text, field) => {
    error.textContent = text;
    error.hidden = false;
    field?.setAttribute("aria-invalid", "true");
    field?.focus();
  };
  cancel.addEventListener("click", () => d.close());
  confirm.addEventListener("click", async () => {
    const form = {
      note: note?.value ?? "",
      ack: ack?.checked === true,
      typed: typed?.value ?? "",
    };
    const problem = formProblem(p, form);
    for (const field of [note, ack, typed])
      field?.removeAttribute("aria-invalid");
    if (problem) {
      const field =
        p.noteRequired && !form.note.trim()
          ? note
          : p.ack && !form.ack
            ? ack
            : typed;
      return fail(problem, field ?? note);
    }
    error.hidden = true;
    confirm.disabled = true;
    confirm.setAttribute("aria-busy", "true");
    try {
      const body = requestBody(p, form, newRequestId());
      const response = await controlFetch(body);
      let answer = null;
      try {
        answer = await response.json();
      } catch {
        // Non-JSON bodies are described by status alone.
      }
      if (!response.ok) return fail(errorText(response.status, answer), null);
      d.close();
      track(p, answer);
    } catch {
      fail(
        "The dashboard could not be reached. Nothing was queued; try again.",
        null,
      );
    } finally {
      confirm.disabled = false;
      confirm.removeAttribute("aria-busy");
    }
  });
  d.showModal();
  (note ?? ack ?? typed ?? cancel).focus();
}

// ---- Queued -> recorded outcome ----------------------------------------------
function feedbackHost() {
  let host = $("control-feedback");
  if (host) return host;
  host = el("div", undefined, "control-feedback");
  host.id = "control-feedback";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  document.body.append(host);
  return host;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const subject = (p) =>
  [p.verb, p.context.lane, p.context.task].filter(Boolean).join(" · ");

async function track(p, answer) {
  const host = feedbackHost();
  const item = el("div", undefined, "control-item");
  const text = el("span", undefined, "control-item-text");
  const dismiss = el("button", "Dismiss", "control-button");
  dismiss.type = "button";
  dismiss.addEventListener("click", () => item.remove());
  item.append(text, dismiss);
  host.append(item);
  while (host.children.length > 4) host.firstElementChild.remove();
  const waiting = `Queued: ${subject(p)}. Waiting for the supervisor to record the outcome…`;
  text.textContent = answer?.warning ? `${waiting} ${answer.warning}` : waiting;
  const id = answer?.id;
  const deadline = Date.now() + 30000;
  let after = Number.isSafeInteger(answer?.afterSeq) ? answer.afterSeq : 0;
  while (id && Date.now() < deadline && item.isConnected) {
    await sleep(600);
    try {
      for (let page = 0; page < 3; page++) {
        const response = await window.crewplaneFetch(
          `/api/control-log?after=${after}&limit=200`,
          { cache: "no-store", signal: AbortSignal.timeout(8000) },
        );
        if (!response.ok) break;
        const log = await response.json();
        const entry = log.entries.find((e) => e.id === id);
        if (entry) {
          text.textContent = `${subject(p)} — ${explainOutcome(entry)}`;
          item.dataset.outcome = entry.outcome;
          loadControls(true);
          refresh();
          return;
        }
        if (!log.hasMore) break;
        after = log.nextAfter ?? after;
      }
    } catch {
      // Keep polling until the deadline.
    }
  }
  if (item.isConnected)
    text.textContent = `${subject(p)} — still queued after 30 seconds. The supervisor may not be running; if it is started later this command is refused as out of date.`;
}

/** Wire once from the dashboard entry point. */
export function startControls() {
  window.addEventListener("crewplane-controls-token", () => loadControls(true));
  return loadControls(true);
}
