import { badge } from "./badges.js";
import { fields } from "./dom.js";
import { $, store } from "./store.js";

export function renderRelationships() {
  const coverage = store.data.graphCoverage ?? {};
  const fraction = (included, total) =>
    `${included ?? "unknown"} of ${total ?? "unknown"}`;
  $("graph-state").replaceChildren(
    badge(
      coverage.state ?? "unknown",
      coverage.state === "available" ? "success" : "unknown",
    ),
  );
  const list = fields(
    [
      ["Tasks", fraction(coverage.tasksIncluded, coverage.tasksTotal)],
      ["Agents", fraction(coverage.lanesIncluded, coverage.lanesTotal)],
      ["Events", fraction(coverage.messagesIncluded, coverage.messagesTotal)],
      ["Dependency metadata", coverage.dependencyMetadata, "unknown"],
    ],
    "fields-inline",
  );
  $("graph-coverage").replaceChildren(...list.children);
}
