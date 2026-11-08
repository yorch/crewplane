import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      expect(args[2]).toMatchObject({ flush: true });
      calls.push("flush-file");
      return fs.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      calls.push("rename");
      return fs.rename(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      return {
        sync: async () => {
          calls.push("sync-directory");
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
});

import { publishJson } from "./io.ts";

it("flushes the file before rename and fsyncs its parent; exclusive publication preserves the winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-json-"));
  try {
    const path = join(root, "state.json");
    calls.length = 0;
    await publishJson(path, { revision: 1 });
    expect(calls).toEqual(["flush-file", "rename", "sync-directory"]);
    await expect(
      publishJson(path, { revision: 2 }, { exclusive: true }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ revision: 1 });
    await publishJson(
      join(root, "new.json"),
      { revision: 3 },
      { exclusive: true },
    );
    expect(calls.at(-1)).toBe("sync-directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
