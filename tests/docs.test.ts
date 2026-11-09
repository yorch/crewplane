import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

/**
 * Release pins are exact strings, so a documented example that names another
 * release is a trap: copying it locks a project out of every command until the
 * reader repairs it by hand. The docs are not generated, and release-please
 * does not rewrite them, so this test is the forcing function that keeps the
 * pin examples equal to the release being cut.
 */
const pinDocs = readFileSync(resolve("docs/USAGE.md"), "utf8")
  .split(/^## /m)
  .filter((section) => /pin/i.test(section.split("\n", 1)[0] ?? ""))
  .join("\n");

it("documents release pins with the release this package is", () => {
  expect(pinDocs).not.toBe("");
  const pins = [...pinDocs.matchAll(/"requiredVersion":\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  const installs = [...pinDocs.matchAll(/--version v(\S+)/g)].map(
    (match) => match[1],
  );
  const directories = [...pinDocs.matchAll(/crewplane\/([^"/\s]+)"/g)].map(
    (match) => match[1],
  );
  // Guard the guard: a silently withdrawn example must not pass vacuously.
  expect(pins.length).toBeGreaterThan(0);
  expect(installs.length).toBeGreaterThan(0);
  expect(directories.length).toBeGreaterThan(0);
  expect(new Set([...pins, ...installs, ...directories])).toEqual(
    new Set([pkg.version]),
  );
});
