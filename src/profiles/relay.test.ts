import { expect, it } from "vitest";
import { planParsers } from "./index.ts";
import { relayPlannedTasks } from "./relay.ts";

const plan = (line: string) => `Intro\nIllustrative task IDs: ${line}\nTail`;

it("registers the relay parser under its roadmap format key", () => {
  expect(Object.keys(planParsers)).toEqual(["relay"]);
  expect(planParsers.relay).toBe(relayPlannedTasks);
});

it("skips ids that already have cards and yields placeholder markdown", () => {
  const cards = relayPlannedTasks(
    plan("P1-01 auth; P4-01 matching/corrections."),
    new Set(["P1-01"]),
  );
  expect(cards.map((c) => c.id)).toEqual(["P4-01"]);
  expect(cards[0]?.markdown.split("\n")[0]).toBe(
    "# P4-01 — matching/corrections",
  );
});

it("returns nothing without an illustrative id line", () => {
  expect(relayPlannedTasks("No ids here", new Set())).toEqual([]);
});
