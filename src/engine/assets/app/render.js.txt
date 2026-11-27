import { renderAgents } from "./agents.js";
import { openAudit, renderAudit } from "./audit.js";
import { configResource } from "./aux.js";
import { el } from "./dom.js";
import { leaveEvidence, openEvidence, renderEvidence } from "./evidence.js";
import { renderMessages } from "./messages.js";
import { renderOverview } from "./overview.js";
import { renderRelationships } from "./relationships.js";
import { applyLateScroll } from "./reload-state.js";
import { openSetup, renderSetup } from "./setup.js";
import { store } from "./store.js";
import { renderSystem } from "./system.js";
import { renderTasks } from "./tasks.js";
import { captureUi, restoreUi } from "./ui-state.js";
import { openUsage, renderUsage } from "./usage.js";

function renderChrome() {
  const setCount = (view, count, label, tone) => {
    const node = document.querySelector(`[data-count="${view}"]`);
    if (!node) return;
    node.hidden = !count;
    node.className = `nav-count${tone ? ` nav-count-${tone}` : ""}`;
    node.replaceChildren();
    if (count) node.append(String(count), el("span", ` ${label}`, "sr-only"));
  };
  const blocked = store.data.tasks.filter((t) => t.state === "blocked").length;
  setCount("tasks", blocked, "blocked", blocked ? "danger" : "");
  setCount("messages", store.data.unanswered.length, "open", "warning");
  const running = (store.data.headless?.lanes ?? []).filter(
    (lane) => lane.status === "running",
  ).length;
  setCount("agents", running, "running", "");
  const problems = configResource.state.data?.problems?.length ?? 0;
  setCount("setup", problems, "problems", "danger");
}

// Views that read their own data load it when they open, and the gallery
// releases its object URLs when it is left.
const opened = {
  setup: openSetup,
  usage: openUsage,
  audit: openAudit,
  evidence: openEvidence,
};
let lastView = null;
function trackView() {
  const view = store.route.view;
  if (view === lastView) return;
  if (lastView === "evidence") leaveEvidence();
  lastView = view;
  opened[view]?.();
}
export function render() {
  if (!store.data) return;
  trackView();
  const ui = captureUi();
  renderChrome();
  const renderer = viewRenderers[store.route.view];
  if (renderer) renderer();
  restoreUi(ui);
  applyLateScroll();
}

const viewRenderers = {
  overview: renderOverview,
  tasks: renderTasks,
  agents: renderAgents,
  messages: renderMessages,
  relationships: renderRelationships,
  system: renderSystem,
  setup: renderSetup,
  usage: renderUsage,
  evidence: renderEvidence,
  audit: renderAudit,
};
