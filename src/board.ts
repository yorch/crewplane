/** Composition root for board reads: wires the profile registry into the core read model. */

import {
  plannedTasks as plannedTasksWith,
  snapshot as readSnapshot,
  type SnapshotOptions,
} from "./engine/read-model.ts";
import type { PlanParser } from "./ports.ts";
import { planParsers } from "./profiles/index.ts";

export const snapshot = (
  root: string,
  options: SnapshotOptions = { planParsers },
) => readSnapshot(root, options);

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
