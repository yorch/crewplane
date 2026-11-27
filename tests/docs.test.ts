import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/**
 * The dashboard design notes list every module, so the table cannot drift:
 * every script under src/engine/dashboard is named in "Module layout", and
 * everything that section names as a script exists.
 */
it("names every dashboard module in the design notes and nothing that does not exist", () => {
  const root = resolve("src/engine/dashboard");
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(directory, entry.name))
        : entry.name.endsWith(".js")
          ? [entry.name]
          : [],
    );
  const files = walk(root);
  expect(files.length).toBeGreaterThan(55);
  const notes = readFileSync(resolve("docs/dashboard-design.md"), "utf8");
  const section =
    notes.split(/^## /m).find((part) => part.startsWith("Module layout")) ?? "";
  expect(section).not.toBe("");
  const mentioned = new Set(
    [...section.matchAll(/`([A-Za-z0-9_-]+\.js)`/g)].map((m) => m[1] as string),
  );
  const missing = files.filter((name) => !mentioned.has(name));
  expect(missing).toEqual([]);
  // The public alias /runs.js is written with its slash and is not a file.
  const unknown = [...mentioned].filter((name) => !files.includes(name));
  expect(unknown).toEqual([]);
});

it("keeps the dashboard verification notes free of counts and commit ids that go stale", () => {
  const notes = readFileSync(resolve("docs/dashboard-design.md"), "utf8");
  const verification =
    notes.split(/^## /m).find((p) => p.startsWith("Verification")) ?? "";
  expect(verification).not.toBe("");
  expect(verification).not.toMatch(
    /\b\d+ tests\b|\b[0-9a-f]{7,40}\b|actions\/runs/,
  );
});
