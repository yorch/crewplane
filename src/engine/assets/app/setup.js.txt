// Setup & config (#/setup): what /api/config says is installed, in plain
// language, with a doctor-style problem list and the exact commands to run in a
// terminal. Everything here is read-only: the commands are shown (and can be
// copied) but the page never runs them, and no binary is executed by the
// server either. All server text is set with textContent.

import { configResource } from "./aux.js";
import { badge } from "./badges.js";
import {
  budgetRows,
  describeProblem,
  describeWarning,
  digestFacts,
  laneRows,
  nextSteps,
  reloadNote,
  rolesNote,
  stateInfo,
  truncationNotes,
} from "./config-core.js";
import { copyButton } from "./copy.js";
import { el, emptyState, fields, link } from "./dom.js";
import { hrefFor } from "./route.js";
import { $ } from "./store.js";
import { dataTable } from "./tables.js";
import { timeEl } from "./time.js";
import {
  errorPanel,
  loadingNote,
  noteList,
  panel,
  staleNote,
} from "./view-parts.js";

const retry = () => configResource.load({ force: true });

function commandItem(step, scope) {
  const item = el("li", undefined, "command-item");
  const body = el("div", undefined, "command-body");
  body.append(
    el("strong", step.label),
    el("code", step.command, "command-text"),
    el("span", step.why, "note"),
  );
  item.append(
    body,
    copyButton(step.command, {
      key: `${scope}:${step.command}`,
      what: `command ${step.command}`,
    }),
  );
  return item;
}
function commandList(steps, scope) {
  const list = el("ul", undefined, "command-list");
  list.append(...steps.map((step) => commandItem(step, scope)));
  return list;
}

function statusPanel(config) {
  const info = stateInfo(config);
  const steps = nextSteps(config);
  const head = badge(info.label, info.tone);
  const nodes = [
    el("p", info.headline, "setup-headline"),
    el("p", info.text, "note"),
  ];
  if (config.legacyLayout === true)
    nodes.push(
      el(
        "p",
        "An older supervisor layout is present in the project store (LEGACY_LAYOUT).",
        "text-warning",
      ),
    );
  if (steps.length) {
    const heading = el("h3", "What to do next", "subheading");
    nodes.push(
      heading,
      el(
        "p",
        "Run these yourself in a terminal in the project. The dashboard never runs them.",
        "note",
      ),
      commandList(steps, "next"),
    );
  }
  return panel("setup-status-heading", "Installed configuration", nodes, head);
}

function problemItem(problem) {
  const info = describeProblem(problem);
  const item = el("li", undefined, "problem-item");
  item.dataset.code = info.code;
  const head = el("div", undefined, "problem-head");
  head.append(badge(info.code, info.known ? "danger" : "warning"));
  head.lastElementChild?.classList.add("mono");
  if (info.lane)
    head.append(
      el("span", "Agent", "count"),
      link(hrefFor("agents", { agent: info.lane }), info.lane, "agent-name"),
    );
  const body = el("div", undefined, "problem-body");
  body.append(el("strong", info.title));
  if (info.message) body.append(el("p", info.message, "problem-message"));
  if (info.advice) body.append(el("p", info.advice, "note"));
  const run = el("p", undefined, "problem-run");
  run.append(el("span", "Then run ", "note"));
  info.commands.forEach((step, index) => {
    if (index) run.append(el("span", " or ", "note"));
    run.append(el("code", step.command, "command-text"));
  });
  body.append(run);
  item.append(head, body);
  return item;
}
function problemsPanel(config) {
  const problems = config.problems ?? [];
  const warnings = (config.warnings ?? []).map(describeWarning);
  const nodes = [];
  if (!problems.length)
    nodes.push(
      config.state === "valid"
        ? el(
            "p",
            "No problems found by the same checks as crewplane doctor.",
            "note",
          )
        : el("p", "No individual problems were listed.", "note"),
    );
  else {
    const list = el("ol", undefined, "problem-list");
    list.append(...problems.map(problemItem));
    nodes.push(list);
  }
  for (const text of truncationNotes(config).filter((n) => /problems/.test(n)))
    nodes.push(el("p", text, "text-warning"));
  for (const warning of warnings)
    nodes.push(el("p", `${warning.code}: ${warning.text}`, "note"));
  return panel(
    "setup-problems-heading",
    "Problems",
    nodes,
    el(
      "span",
      problems.length
        ? `${problems.length}${config.problemsTruncated ? "+" : ""}`
        : "None",
      "count",
    ),
  );
}

function laneCells(row) {
  const name = el("div", undefined, "lane-name");
  name.append(
    link(hrefFor("agents", { agent: row.id }), row.id, "agent-name"),
    row.valid
      ? badge(
          row.enabled ? "Enabled" : "Disabled",
          row.enabled ? "success" : "neutral",
        )
      : badge("Invalid", "danger"),
  );
  const harness = el("div", undefined, "pair");
  for (const [label, value] of [
    ["Harness", row.harness],
    ["Model", row.model],
  ]) {
    const line = el("div", undefined, "pair-line");
    line.append(
      el("span", label, "pair-label"),
      el(
        "span",
        value ?? "Not recorded",
        value ? "pair-value" : "pair-value is-unknown",
      ),
    );
    harness.append(line);
  }
  const limits = row.caps.length
    ? (() => {
        const list = el("ul", undefined, "mini-list");
        for (const [label, value] of row.caps)
          list.append(el("li", `${label}: ${value}`));
        return list;
      })()
    : null;
  const env = row.valid
    ? row.passEnv.length
      ? el("span", row.passEnv.join(", "), "mono env-names")
      : el("span", "None", "is-unknown")
    : null;
  const binary = el("div", undefined, "binary-status");
  binary.append(badge(row.binary.text, row.binary.tone));
  if (row.binary.detail)
    binary.append(el("span", row.binary.detail, "binary-detail mono"));
  const coverage = row.usageCoverage
    ? el("span", `Usage coverage: ${row.usageCoverage}`, "note")
    : null;
  if (coverage) binary.append(coverage);
  return [
    name,
    row.role,
    row.valid ? harness : null,
    row.permissions,
    row.instructions,
    limits,
    env,
    binary,
  ];
}
function lanesPanel(config) {
  const rows = laneRows(config);
  const nodes = [];
  if (!rows.length)
    nodes.push(
      emptyState(
        "No agents are configured.",
        "Lanes appear here once a configuration with agents is installed.",
      ),
    );
  else
    nodes.push(
      dataTable({
        label: "Configured agents",
        columns: [
          "Agent",
          "Role",
          "Harness and model",
          "Permissions",
          "Instructions",
          "Effective limits",
          "Passed env names",
          "Binary",
        ],
        rows: rows.map((row) => ({ key: row.id, cells: laneCells(row) })),
        className: "lanes-table",
      }),
      el(
        "p",
        "Environment variables are listed by name only; values are never read or shown. Limits show the effective value from the installed configuration; “(default)” means the agent uses the shared default.",
        "note",
      ),
    );
  for (const text of truncationNotes(config).filter((n) => /agents/.test(n)))
    nodes.push(el("p", text, "text-warning"));
  return panel(
    "setup-lanes-heading",
    "Agents",
    nodes,
    el(
      "span",
      rows.length ? `${rows.length}${config.lanesTruncated ? "+" : ""}` : "",
      "count",
    ),
  );
}

function budgetsPanel(config) {
  const budgets = config.budgets;
  const rows = budgetRows(budgets);
  const nodes = [
    dataTable({
      label: "Budgets: installed and loaded",
      columns: [
        "Setting",
        "Installed configuration",
        "Running supervisor",
        "Status",
      ],
      rows: rows.map((row) => ({
        key: row.label,
        cells: [
          row.label,
          row.configured,
          row.loaded,
          row.differs === null
            ? el("span", "Cannot compare", "is-unknown")
            : row.differs
              ? badge("Differs", "warning")
              : badge("Same", "success"),
        ],
      })),
    }),
  ];
  const note = reloadNote(budgets);
  if (note)
    nodes.push(
      el("p", note, budgets.reloadPending === true ? "text-warning" : "note"),
    );
  nodes.push(
    el(
      "p",
      "Every effective limit in the agents table comes from the installed configuration. The running supervisor does not record per-agent values, so the loaded column shows shared defaults only.",
      "note",
    ),
  );
  return panel("setup-budgets-heading", "Budgets", nodes);
}

function digestPanel(config) {
  const facts = digestFacts(config);
  const roles = config.roles;
  const digestCell = facts.short
    ? (() => {
        const wrap = el("span", undefined, "digest-line");
        wrap.append(
          el("code", facts.short, "mono"),
          copyButton(facts.digest, {
            key: "digest",
            what: "full configuration digest",
          }),
        );
        return wrap;
      })()
    : null;
  const nodes = [
    fields([
      ["Digest (short)", digestCell, "Not available"],
      [
        "Loaded by supervisor",
        facts.loadedShort ? el("code", facts.loadedShort, "mono") : null,
        "Not recorded",
      ],
      ["Comparison", facts.match],
    ]),
    el(
      "p",
      "The digest fingerprints the scheduling fields of the installed configuration. It is not a secret and not a signature.",
      "note",
    ),
  ];
  if (roles) {
    nodes.push(
      fields([
        ["Coordinator", roles.coordinator],
        [
          "Reviewers",
          roles.reviewers?.length ? roles.reviewers.join(", ") : null,
          "None",
        ],
      ]),
    );
    const hint = rolesNote(roles);
    if (hint) nodes.push(el("p", hint, "text-warning"));
  }
  return panel("setup-digest-heading", "Fingerprint and roles", nodes);
}

function noticesPanel(config) {
  const items = [
    config.credentials === "not-probed"
      ? "Credentials are not probed. This page cannot tell whether a harness is signed in or has an API key; the first run will show that."
      : "Credential checks are not reported.",
    config.binariesExecuted === false
      ? "Binaries are never executed. Checks look only at the file system (existence, type, permissions and who can write to the path), so “found” does not prove the program works."
      : "Whether binaries were executed is not reported.",
    "This page is read-only. Install or change a configuration from a terminal.",
  ];
  return panel("setup-notices-heading", "What this page does not check", [
    noteList(items),
  ]);
}

export function renderSetup() {
  const host = $("setup-body");
  const { status, data, error, loadedAt } = configResource.state;
  if (!data) {
    host.replaceChildren(
      status === "error"
        ? errorPanel("the configuration", error, retry)
        : loadingNote("Reading the installed configuration…"),
    );
    return;
  }
  const nodes = [];
  if (status === "error") nodes.push(staleNote(error, loadedAt, retry));
  nodes.push(statusPanel(data), problemsPanel(data), lanesPanel(data));
  if (data.installed) nodes.push(budgetsPanel(data), digestPanel(data));
  nodes.push(noticesPanel(data));
  if (loadedAt) {
    const stamp = el("p", "Read ", "note");
    stamp.append(timeEl(loadedAt));
    nodes.push(stamp);
  }
  host.replaceChildren(...nodes);
}

export function openSetup() {
  // A view opening always starts a read that begins after it opens; a request
  // already in flight may have started before (see resource.load).
  configResource.load({ force: true });
}
