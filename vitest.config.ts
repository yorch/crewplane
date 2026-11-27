import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const cacheDirectory = mkdtempSync(join(tmpdir(), "crewplane-test-cache-"));
const stateDirectory = mkdtempSync(join(tmpdir(), "crewplane-test-state-"));
// Remove both scratch directories when the runner process ends.
process.once("exit", () => {
  for (const path of [cacheDirectory, stateDirectory])
    rmSync(path, { recursive: true, force: true });
});
export default defineConfig({
  plugins: [
    {
      name: "embedded-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".txt"))
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
  test: {
    // Fails the run if it changed the real state or cache directories.
    globalSetup: ["tests/support/home-guard.ts"],
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Keep updater caches and supervisor registrations out of $HOME.
    env: {
      CREWPLANE_CACHE_DIR: cacheDirectory,
      // Control directories land here, never in the real home directory.
      CREWPLANE_STATE_DIR: stateDirectory,
    },
    environment: "node",
    testTimeout: 30000,
    maxWorkers: 4,
  },
});
