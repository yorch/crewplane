// Control log (#/audit): the supervisor's bounded audit trail of operator
// commands (/api/control-log). Read-only. Refused, out-of-date and invalid
// commands are highlighted with text as well as colour; reason codes are
// explained in plain language where known and shown raw (as text) otherwise.

import {
  distinct,
  entryLinks,
  explainReason,
  filterEntries,
  laneChoices,
  needsAttention,
  outcomeCounts,
  outcomeInfo,
  PAGE,
  retentionNote,
  scopeLabel,
} from "./audit-core.js";
import { logResource } from "./aux.js";
import { badge } from "./badges.js";
import {
  closeLink,
  detailHeading,
  el,
  emptyState,
  fields,
  link,
} from "./dom.js";
import { clearButton, fillSelect, syncClear } from "./filters.js";
import { hrefFor } from "./route.js";
import { $, store } from "./store.js";
import { dataTable } from "./tables.js";
import { timeEl } from "./time.js";
import { errorPanel, loadingNote, staleNote } from "./view-parts.js";

const retry = () => logResource.load({ force: true });
const view = { follow: true, frozenAt: null, shown: PAGE, filterKey: "" };

export const isFollowing = () => view.follow;
export function setFollow(on) {
  view.follow = on;
  // Unfollowing freezes the list at what is on screen; newer commands are
  // counted, not inserted under the reader.
  view.frozenAt = on
    ? null
    : (logResource.state.data?.entries.at(-1)?.seq ?? 0);
  if (on) logResource.load({ force: true });
}

const reasonCell = (entry) => {
  const reason = explainReason(entry);
  const cell = el("div", undefined, "reason-cell");
  if (reason.code) cell.append(el("code", reason.code, "mono reason-code"));
  cell.append(
    el("span", reason.text, reason.known ? "reason-text" : "reason-text note"),
  );
  return cell;
};
const targetCell = (entry) => {
  const cell = el("div", undefined, "target-cell");
  cell.append(el("span", scopeLabel(entry.scope), "count"));
  if (entry.target) cell.append(el("span", entry.target, "mono target-name"));
  for (const target of entryLinks(entry)) {
    const text = { agents: "Agent", tasks: "Task", runs: "Run" }[target.view];
    cell.append(link(hrefFor(target.view, target.params), text, "cross-link"));
  }
  return cell;
};
const outcomeBadge = (entry) => {
  const info = outcomeInfo(entry.outcome);
  return badge(info.label, info.tone);
};

function entryRow(entry) {
  const selected = store.route.params.seq === String(entry.seq);
  const open = link(
    hrefFor("audit", { ...store.route.params, seq: String(entry.seq) }),
    `#${entry.seq}`,
    "agent-name mono",
  );
  open.dataset.focusKey = `audit:${entry.seq}`;
  open.setAttribute("aria-label", `Open command ${entry.seq}`);
  if (selected) open.setAttribute("aria-current", "true");
  return {
    key: String(entry.seq),
    selected,
    className: needsAttention(entry) ? "is-attention" : undefined,
    cells: [
      open,
      entry.at ? timeEl(entry.at) : null,
      entry.issuer,
      entry.action,
      targetCell(entry),
      outcomeBadge(entry),
      reasonCell(entry),
    ],
  };
}

function summaryLine(model) {
  const counts = outcomeCounts(model.entries);
  const line = el("div", undefined, "audit-summary");
  for (const key of ["applied", "noop", "refused", "stale", "invalid"]) {
    if (!counts[key]) continue;
    const info = outcomeInfo(key);
    const anchor = link(
      hrefFor("audit", { ...store.route.params, outcome: key, seq: undefined }),
      undefined,
      "legend-link",
    );
    anchor.append(
      badge(info.label, info.tone),
      el("strong", String(counts[key])),
    );
    line.append(anchor);
  }
  if (counts.unknown)
    line.append(
      badge(`${counts.unknown} with an unrecognised outcome`, "unknown"),
    );
  return line;
}

function detailPane(model) {
  const pane = $("audit-detail");
  const split = $("audit-split");
  const seq = store.route.params.seq;
  split.classList.toggle("has-detail", Boolean(seq));
  pane.hidden = !seq;
  if (!seq) {
    pane.replaceChildren();
    return;
  }
  const closeHref = hrefFor("audit", { ...store.route.params, seq: undefined });
  pane.setAttribute("aria-labelledby", "audit-detail-title");
  const entry = model?.entries.find(
    (candidate) => String(candidate.seq) === seq,
  );
  if (!entry) {
    pane.replaceChildren(
      closeLink(closeHref, "Close command details"),
      detailHeading(`Command #${seq}`, "audit-detail-title"),
      emptyState(
        model
          ? "This command is no longer retained."
          : "The control log is not loaded.",
        model
          ? "The supervisor keeps only the latest 200 commands, so older entries disappear. It may also be a sequence number that never existed."
          : "Try again in a moment.",
      ),
    );
    return;
  }
  const reason = explainReason(entry);
  const info = outcomeInfo(entry.outcome);
  const header = el("div", undefined, "detail-header");
  const tags = el("div", undefined, "detail-tags");
  tags.append(outcomeBadge(entry), el("span", `#${entry.seq}`, "mono"));
  header.append(
    tags,
    detailHeading(`Command #${entry.seq}`, "audit-detail-title"),
  );
  const links = el("div", undefined, "detail-actions");
  for (const target of entryLinks(entry))
    links.append(
      link(
        hrefFor(target.view, target.params),
        { agents: "Open agent", tasks: "Open task", runs: "Open run" }[
          target.view
        ],
      ),
    );
  const nodes = [
    closeLink(closeHref, "Close command details"),
    header,
    el(
      "p",
      `${info.label}: ${reason.text}`,
      needsAttention(entry) ? "detail-outcome is-attention" : "detail-outcome",
    ),
    fields([
      ["Time", entry.at ? timeEl(entry.at) : null],
      ["Issued by", entry.issuer],
      ["Action", entry.action],
      ["Scope", scopeLabel(entry.scope)],
      ["Target", entry.target],
      ["Outcome", info.label],
      [
        "Reason code",
        reason.code ? el("code", reason.code, "mono") : null,
        "None recorded",
      ],
      ["Command id", entry.id ? el("code", entry.id, "mono") : null],
    ]),
  ];
  if (links.children.length) nodes.push(links);
  if (entry.outcome === "stale")
    nodes.push(
      el(
        "p",
        "A stale command is never applied. Open the agent, check its current state and issue the command again if it is still needed.",
        "note",
      ),
    );
  pane.replaceChildren(...nodes);
}

export function renderAudit() {
  const host = $("audit-list");
  const { status, data: model, error, loadedAt } = logResource.state;
  const params = store.route.params;
  syncClear("audit");
  $("audit-follow").checked = view.follow;
  if (!model) {
    $("audit-count").textContent = "";
    $("audit-note").textContent = "";
    host.replaceChildren(
      status === "error"
        ? errorPanel("the control log", error, retry)
        : loadingNote("Reading the control log…"),
    );
    detailPane(null);
    return;
  }
  fillSelect(
    $("audit-issuer"),
    "All issuers",
    distinct(model.entries, "issuer"),
  );
  fillSelect($("audit-lane"), "All agents", laneChoices(model.entries));
  for (const [id, key] of [
    ["audit-outcome", "outcome"],
    ["audit-issuer", "issuer"],
    ["audit-lane", "lane"],
  ])
    if ($(id).value !== (params[key] ?? "")) $(id).value = params[key] ?? "";
  const key = JSON.stringify([params.outcome, params.issuer, params.lane]);
  if (key !== view.filterKey) {
    view.filterKey = key;
    view.shown = PAGE;
  }
  const visibleEntries =
    view.frozenAt === null
      ? model.entries
      : model.entries.filter((entry) => entry.seq <= view.frozenAt);
  const newer = model.entries.length - visibleEntries.length;
  const filtered = filterEntries(visibleEntries, params);
  const page = filtered.slice(0, view.shown);
  $("audit-count").textContent =
    `${filtered.length} of ${visibleEntries.length} retained commands`;
  const note = retentionNote(model);
  $("audit-note").textContent = note ?? "";
  const nodes = [];
  if (status === "error") nodes.push(staleNote(error, loadedAt, retry));
  if (newer > 0) {
    const bar = el("div", undefined, "banner banner-inline");
    bar.setAttribute("role", "status");
    const button = el(
      "button",
      `Show ${newer} newer ${newer === 1 ? "command" : "commands"}`,
      "text-button",
    );
    button.type = "button";
    button.dataset.focusKey = "audit-newer";
    button.addEventListener("click", () => {
      setFollow(true);
      $("audit-follow").checked = true;
      renderAudit();
    });
    bar.append(
      el("span", "New commands were recorded while following was off."),
      button,
    );
    nodes.push(bar);
  }
  if (model.available === false)
    nodes.push(
      emptyState(
        "The control log is unavailable.",
        "The supervisor state could not be read, so no commands can be listed.",
      ),
    );
  else if (!visibleEntries.length)
    nodes.push(
      emptyState(
        "No operator commands have been recorded.",
        "Pause, resume, retry, nudge, cancel and stop commands appear here once the supervisor records their outcome.",
      ),
    );
  else if (!filtered.length) {
    const empty = emptyState("No commands match these filters.");
    empty.append(clearButton("audit"));
    nodes.push(empty);
  } else {
    nodes.push(summaryLine({ entries: visibleEntries }));
    nodes.push(
      dataTable({
        label: "Control log",
        columns: [
          "Command",
          "Time",
          "Issued by",
          "Action",
          "Target",
          "Outcome",
          "Reason",
        ],
        rows: page.map(entryRow),
        className: "audit-table",
      }),
    );
    if (filtered.length > page.length) {
      const older = el(
        "button",
        `Show older commands (${filtered.length - page.length} more)`,
        "more-button",
      );
      older.type = "button";
      older.dataset.focusKey = "audit-older";
      older.addEventListener("click", () => {
        view.shown += PAGE;
        renderAudit();
      });
      nodes.push(older);
    }
  }
  host.replaceChildren(...nodes);
  detailPane(model);
}

export function openAudit() {
  logResource.load();
}
