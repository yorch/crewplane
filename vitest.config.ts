import { readFileSync } from "node:fs";
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
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    maxWorkers: 4,
  },
});
