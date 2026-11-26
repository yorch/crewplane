import type { PlannedCard, PlanParser } from "../ports.ts";
/** Optional legacy plan import; never grants execution authority. */
export const relayPlannedTasks: PlanParser = (plan, existingIds) => {
  const line = plan.match(/^Illustrative task IDs:\s*(.+)$/m)?.[1] ?? "";
  const seen = new Set(existingIds);
  const cards: PlannedCard[] = [];
  for (const match of line.matchAll(/(P\d-\d{2})\s+([^;.]+)/g)) {
    const id = match[1] ?? "";
    const title = (match[2] ?? "").trim();
    // First mention wins; later repeats of an id in the same line are dropped.
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push({
      id,
      markdown: `# ${id} — ${title}\nStatus: planning placeholder; no scoped card or assignment.\nGoal: Needs scoping — ${title}. This roadmap item is not authorized for implementation.\nDependencies: coordinator task definition and phase gates.\n`,
    });
  }
  return cards;
};
