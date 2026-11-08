import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEvidenceStore } from "./store.ts";

it("retains forty independent-process appends alongside independent list readers", async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "evidence-process-"),
  );
  try {
    const store = await createEvidenceStore(root);
    const run = await store.createRun({
      task: "CP-06",
      lane: "F",
      testedCommit: "a".repeat(40),
    });
    await Promise.all(
      ["writer", "writer", "writer", "writer", "reader", "reader"].map(
        (role) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              "bun",
              [
                new URL("./concurrency-fixture.ts", import.meta.url).pathname,
                root,
                run.runId,
                role,
              ],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            let errors = "";
            child.stderr.on("data", (data) => {
              errors += data;
            });
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0 ? resolve() : reject(Error(errors)),
            );
          }),
      ),
    );
    const reopened = await createEvidenceStore(root);
    const manifest = await reopened.manifest(run.runId);
    expect(manifest?.artifacts).toHaveLength(40);
    expect(new Set(manifest?.artifacts.map((a) => a.artifactId)).size).toBe(40);
    for (const artifact of manifest?.artifacts ?? [])
      expect((await reopened.read(artifact.artifactId))?.content.length).toBe(
        68,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
