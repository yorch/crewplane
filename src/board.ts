/** Composition root for board reads: wires the profile registry into the core read model. */

import {
  plannedTasks as plannedTasksWith,
  snapshot as readSnapshot,
  type SnapshotOptions,
} from "./engine/read-model.ts";
import type { PlanParser } from "./ports.ts";
import { planParsers } from "./profiles/index.ts";
import { projectPolicy } from "./project.ts";

/** Reject a well-formed but unregistered roadmap format with an actionable error. */
export function assertRoadmapFormat(format: string | undefined) {
  const name = format ?? "none";
  if (name !== "none" && !Object.hasOwn(planParsers, name))
    throw new Error(
      `Unsupported roadmapFormat "${name}"; use "none" or one of: ${Object.keys(planParsers).join(", ")}`,
    );
}

export async function snapshot(root: string, options: SnapshotOptions = {}) {
  assertRoadmapFormat(projectPolicy(root).roadmapFormat);
  return readSnapshot(root, { planParsers, ...options });
}

/** Placeholder cards for a roadmap format registered in the profile registry (default `relay`). */
export function plannedTasks(
  plan: string,
  existingIds: Set<string>,
  format = "relay",
) {
  const parser: PlanParser | undefined = Object.hasOwn(planParsers, format)
    ? planParsers[format]
    : undefined;
  return parser ? plannedTasksWith(parser, plan, existingIds) : [];
}
