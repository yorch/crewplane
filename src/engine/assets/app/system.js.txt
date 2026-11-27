import { healthBadge } from "./badges.js";
import { supervisorControls } from "./controls.js";
import { el, fields, section } from "./dom.js";
import { instanceHoldNotice } from "./hold-notice.js";
import { $, store } from "./store.js";
import { date, timeEl } from "./time.js";

export function renderSystem() {
  const headless = store.data.headless;
  $("headless-status").replaceChildren(
    healthBadge(headless?.state ?? "not-started"),
  );
  const reload = headless?.configReload;
  const rows = headless?.checkedAt
    ? [
        ["Last check", timeEl(headless.checkedAt)],
        [
          "Held lanes",
          headless.instanceHeld
            ? "all lanes (instance hold)"
            : (headless.held ?? []).join(", "),
          "none",
        ],
        [
          "Disk config",
          headless.diskConfigAvailable ? "readable" : "unavailable",
        ],
        ["Loaded config", headless.configState, "unknown"],
        [
          "Reload",
          reload
            ? `${reload.outcome}${reload.errorCode ? ` (${reload.errorCode})` : ""} at ${date(reload.evaluatedAt)}`
            : null,
          "not reported",
        ],
      ]
    : [];
  const attention = headless?.attention;
  if (attention)
    rows.push(
      ["Backlog", attention.backlog, "unknown"],
      [
        "Oldest unhandled",
        attention.oldestUnhandledAt
          ? timeEl(attention.oldestUnhandledAt)
          : null,
        "none",
      ],
      [
        "Planning started",
        attention.planningSince ? timeEl(attention.planningSince) : null,
        "not planning",
      ],
    );
  $("headless-note").replaceChildren(
    headless?.checkedAt
      ? fields(rows)
      : el(
          "p",
          "Not started. Dedicated sessions require an exclusive ownership handover.",
          "note",
        ),
  );
  const budgets = headless?.budgets;
  $("headless-budgets").replaceChildren(
    budgets
      ? section(
          `Limits (${headless.budgetsSource ?? "unknown source"})`,
          fields([
            ["Concurrent lanes", budgets.maxParallel],
            ["Minutes per run", budgets.maxRunMinutes],
            ["Runs per lane per hour", budgets.maxRunsPerHour],
            ["Heartbeat interval", `${budgets.intervalSeconds}s`],
          ]),
        )
      : el("p", "Supervisor budgets unavailable", "note"),
  );
  const stop = supervisorControls();
  if (stop) $("headless-budgets").append(stop);
  const notice = instanceHoldNotice(headless);
  if (notice) $("headless-budgets").append(notice);
  const monitor = store.data.monitor;
  const watchdog = store.data.watchdog;
  $("monitor-status").replaceChildren(
    healthBadge(monitor?.state ?? "not-started"),
  );
  $("monitor-note").textContent = monitor?.checkedAt
    ? `Last watcher check: ${date(monitor.checkedAt)}. ${monitor.error ?? "Reports are observations; agents still post their own progress and answers."}`
    : "Start with crewplane monitor. The dashboard continues reading the live board independently.";
  const alertNode = (text) => el("p", text, "watch-alert");
  $("monitor-alerts").replaceChildren(
    ...(monitor?.alerts ?? []).map((alert) =>
      alertNode(`${alert.agent} · ${alert.task ?? "General"} · ${alert.text}`),
    ),
  );
  $("watchdog-status").replaceChildren(
    healthBadge(watchdog?.state ?? "unavailable"),
  );
  $("watchdog-note").replaceChildren(
    fields([
      ["Last check", watchdog?.checkedAt ? timeEl(watchdog.checkedAt) : null],
      ["Next check", watchdog?.nextCheck ? date(watchdog.nextCheck) : null],
      ["Recovery", "disabled"],
      [
        "Unavailable signals",
        watchdog?.unavailableSignals?.join(", "),
        watchdog?.unavailableSignals ? "none" : "unknown",
      ],
    ]),
  );
  $("watchdog-alerts").replaceChildren(
    ...(watchdog?.codes ?? []).map((code) =>
      alertNode(
        `WATCHDOG · ${code} · persistent observation; inspect before retry`,
      ),
    ),
  );
  const orphans = store.data.orphanAssignments ?? [];
  $("orphans-panel").hidden = !orphans.length;
  $("orphans-count").textContent = orphans.length ? String(orphans.length) : "";
  const orphanList = el("ul", undefined, "link-list");
  for (const orphan of orphans) {
    const row = el("li");
    row.append(
      el("span", orphan.task, "mono"),
      ` · owner ${orphan.assignment?.owner ?? "unknown"}`,
    );
    orphanList.append(row);
  }
  $("orphans").replaceChildren(orphanList);
  const notes = $("milestones");
  notes.textContent =
    store.data.milestoneStatus ||
    "No project status notes found at the configured path.";
  notes.classList.toggle("is-unknown", !store.data.milestoneStatus);
}
