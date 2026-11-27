import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAssetsModule, scanDashboardAssets } from "./dashboard-assets.ts";

// Every runtime file under src/engine/dashboard is embedded; adding a module
// needs no list edit. The generated directory is rebuilt from scratch so a
// removed or renamed source cannot leave a stale copy behind.
const source = new URL("../src/engine/dashboard/", import.meta.url);
const target = new URL("../src/engine/assets/", import.meta.url);
const names = scanDashboardAssets(fileURLToPath(source));
await rm(target, { recursive: true, force: true });
for (const name of names) {
  const file = new URL(`${name}.txt`, target);
  await mkdir(dirname(fileURLToPath(file)), { recursive: true });
  await writeFile(file, await readFile(new URL(name, source)));
}
await writeFile(
  new URL("../src/engine/assets.ts", import.meta.url),
  renderAssetsModule(names),
);
