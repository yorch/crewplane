import { mkdir, readFile, writeFile } from "node:fs/promises";

const names = [
  "index.html",
  "dashboard.js",
  "run-viewer.js",
  "graph-viewer.js",
  "graph-renderer.js",
  "graph-renderer.css",
  "dashboard.css",
];
await mkdir(new URL("../src/engine/assets/", import.meta.url), {
  recursive: true,
});
for (const name of names)
  await writeFile(
    new URL(`../src/engine/assets/${name}.txt`, import.meta.url),
    await readFile(new URL(`../src/engine/dashboard/${name}`, import.meta.url)),
  );
