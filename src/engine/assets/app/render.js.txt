import { renderAgents } from "./agents.js";
import { el } from "./dom.js";
import { renderMessages } from "./messages.js";
import { renderOverview } from "./overview.js";
import { renderRelationships } from "./relationships.js";
import { store } from "./store.js";
import { renderSystem } from "./system.js";
import { renderTasks } from "./tasks.js";
import { captureUi, restoreUi } from "./ui-state.js";

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
}
export function render() {
  if (!store.data) return;
  const ui = captureUi();
  renderChrome();
  const renderer = viewRenderers[store.route.view];
  if (renderer) renderer();
  restoreUi(ui);
}

const viewRenderers = {
  overview: renderOverview,
  tasks: renderTasks,
  agents: renderAgents,
  messages: renderMessages,
  relationships: renderRelationships,
  system: renderSystem,
};
