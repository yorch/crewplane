import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const src = resolve(fileURLToPath(new URL("../src", import.meta.url)));
const board = join(src, "board.ts");
const specifier = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path)
      : /\.(ts|mjs)$/.test(name) && !/\.test\.ts$/.test(name)
        ? [path]
        : [];
  });

/** Relative imports of a module; the composition root board.ts is a deliberate seam, not a dependency. */
const imports = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(specifier)]
    .map((match) => resolve(dirname(file), match[1] ?? ""))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .filter((path) => path !== board);

function reachable(start: string) {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...imports(file));
  }
  return seen;
}

it("keeps profile parsers out of core: engine, project and ports never reach src/profiles", () => {
  const profiles = join(src, "profiles");
  const core = [
    ...files(join(src, "engine")),
    join(src, "project.ts"),
    join(src, "ports.ts"),
  ];
  expect(core.length).toBeGreaterThan(20);
  const leaks = core.flatMap((file) =>
    [...reachable(file)]
      .filter((path) => path.startsWith(`${profiles}/`))
      .map((path) => `${relative(src, file)} -> ${relative(src, path)}`),
  );
  expect(leaks).toEqual([]);
  // The composition root is where profiles are wired.
  expect([...reachable(board)].some((p) => p.startsWith(profiles))).toBe(true);
});
