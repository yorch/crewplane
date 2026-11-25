/** Registry of roadmap formats a project policy may select. Core never names a format. */
import type { PlanParser } from "../ports.ts";
import { relayPlannedTasks } from "./relay.ts";

export const planParsers: Record<string, PlanParser> = {
  relay: relayPlannedTasks,
};
