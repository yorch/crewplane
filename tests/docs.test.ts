import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * Release pins are exact strings, so a documented example that names a release
 * rots on the next bump: it either lies to the reader or blocks the release PR,
 * because release-please does not rewrite docs. The pin sections therefore name
 * no concrete release — they teach `crewplane --version` and `crewplane pin`.
 * This test fails if a literal creeps back in, or if the sections disappear.
 */
const pinDocs = readFileSync(resolve("docs/USAGE.md"), "utf8")
  .split(/^## /m)
  .filter((section) => /pin/i.test(section.split("\n", 1)[0] ?? ""))
  .join("\n");

it("documents release pins without naming a release", () => {
  expect(pinDocs).not.toBe("");
  // Guard the guard: the pin sections must still exist to be checked.
  expect(pinDocs).toMatch(/requiredVersion/);
  const literals = [
    ...pinDocs.matchAll(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g),
  ].map((match) => match[0]);
  expect(literals).toEqual([]);
});
