// A compact "Evidence (N)" link for the Task pane ("Task evidence (N)" in the
// Run pane, since it is the run's task whose evidence is listed). The count comes from
// the gallery's own route, cached for a short time and shared by every link for
// the same task, so opening panes does not fetch repeatedly. Before the answer
// (or when it fails) the link just says "Evidence".
import { link } from "./dom.js";
import { ID_PATTERNS, listPath } from "./evidence-core.js";
import { readJson } from "./resource.js";
import { hrefFor } from "./route.js";

const TTL_MS = 30000; // also the cooldown after a failed read
const counts = new Map(); // task -> { label: "(3)" | "(200+)" | null, at }
const inflight = new Set();

const textFor = (prefix, known) =>
  known?.count ? `${prefix} (${known.count})` : prefix;
function paint(task) {
  const known = counts.get(task);
  for (const node of document.querySelectorAll("a[data-evidence-task]")) {
    if (node.dataset.evidenceTask !== task) continue;
    const text = textFor(node.dataset.evidencePrefix ?? "Evidence", known);
    if (node.textContent !== text) node.textContent = text;
  }
}
async function fetchCount(task) {
  if (inflight.has(task)) return;
  inflight.add(task);
  try {
    const page = await readJson(listPath({ task, limit: 200 }));
    const n = Array.isArray(page.artifacts) ? page.artifacts.length : 0;
    counts.set(task, {
      count: `${n}${page.nextCursor ? "+" : ""}`,
      at: Date.now(),
    });
    paint(task);
  } catch {
    // Keep whatever is shown (the gallery itself explains failures), and
    // remember the failure for a full TTL so a failing endpoint is asked
    // again only after the cooldown, not on every render of every pane.
    const known = counts.get(task);
    counts.set(task, { count: known?.count ?? null, at: Date.now() });
  } finally {
    inflight.delete(task);
  }
}

/**
 * A link to the gallery filtered to `task`, or null when the id is not a task
 * id. `prefix` is the link text before the count ("Task evidence" in the run
 * pane, where the gallery is filtered by the run's task, not by the run).
 */
export function evidenceLink(task, prefix = "Evidence") {
  if (typeof task !== "string" || !ID_PATTERNS.task.test(task)) return null;
  const known = counts.get(task);
  const node = link(
    hrefFor("evidence", { task }),
    textFor(prefix, known),
    "evidence-link",
  );
  node.dataset.evidenceTask = task;
  node.dataset.evidencePrefix = prefix;
  node.dataset.focusKey = `evidence-link:${task}`;
  if (!known || Date.now() - known.at > TTL_MS) fetchCount(task);
  return node;
}
