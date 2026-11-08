/** Optional legacy plan import; never grants execution authority. */
export function relayPlannedTasks(plan: string, existingIds: Set<string>) {
  const line = plan.match(/^Illustrative task IDs:\s*(.+)$/m)?.[1] ?? "";
  return [...line.matchAll(/(P\d-\d{2})\s+([^;.]+)/g)]
    .filter((match) => !existingIds.has(match[1] ?? ""))
    .map((match) => ({
      id: match[1] ?? "",
      markdown: `# ${match[1]} — ${match[2]}\nStatus: planning placeholder; no scoped card or assignment.\nGoal: Needs scoping — ${match[2]}. This roadmap item is not authorized for implementation.\nDependencies: coordinator task definition and phase gates.\n`,
    }));
}
