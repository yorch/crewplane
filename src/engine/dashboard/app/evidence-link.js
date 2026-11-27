// A compact "Evidence (N)" link for the Task and Run panes. The count comes from
// the gallery's own route, cached for a short time and shared by every link for
// the same task, so opening panes does not fetch repeatedly. Before the answer
// (or when it fails) the link just says "Evidence".
import { link } from "./dom.js";
import { ID_PATTERNS, listPath } from "./evidence-core.js";
import { readJson } from "./resource.js";
import { hrefFor } from "./route.js";

const TTL_MS = 30000;
const counts = new Map(); // task -> { text, at }
const inflight = new Set();

function paint(task) {
  const text = counts.get(task)?.text ?? "Evidence";
  for (const node of document.querySelectorAll("a[data-evidence-task]"))
    if (node.dataset.evidenceTask === task && node.textContent !== text)
      node.textContent = text;
}
async function fetchCount(task) {
  if (inflight.has(task)) return;
  inflight.add(task);
  try {
    const page = await readJson(listPath({ task, limit: 200 }));
    const n = Array.isArray(page.artifacts) ? page.artifacts.length : 0;
    counts.set(task, {
      text: `Evidence (${n}${page.nextCursor ? "+" : ""})`,
      at: Date.now(),
    });
    paint(task);
  } catch {
    // Keep whatever is shown; the gallery itself explains failures.
  } finally {
    inflight.delete(task);
  }
}

/** A link to the gallery filtered to `task`, or null when the id is not a task id. */
export function evidenceLink(task) {
  if (typeof task !== "string" || !ID_PATTERNS.task.test(task)) return null;
  const known = counts.get(task);
  const node = link(
    hrefFor("evidence", { task }),
    known?.text ?? "Evidence",
    "evidence-link",
  );
  node.dataset.evidenceTask = task;
  node.dataset.focusKey = `evidence-link:${task}`;
  if (!known || Date.now() - known.at > TTL_MS) fetchCount(task);
  return node;
}
