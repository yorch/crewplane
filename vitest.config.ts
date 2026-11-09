import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
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
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Keep updater caches and supervisor registrations out of $HOME.
    env: {
      CREWPLANE_CACHE_DIR: mkdtempSync(join(tmpdir(), "crewplane-test-cache-")),
    },
    environment: "node",
    testTimeout: 30000,
    maxWorkers: 4,
  },
});
