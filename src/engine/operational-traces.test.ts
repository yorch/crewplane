import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTraceStore, nativeTrace } from "./operational-traces.ts";

const run = (n = 1) => `179410000000${n}-00000000-0000-4000-8000-000000000001`;
it("projects both native adapters without collecting reasoning, credentials or arbitrary tool payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-traces-"));
  try {
    const store = await createTraceStore(root);
    const writer = await store.begin({
      runId: run(),
      lane: "coordinator",
      task: "P1-08",
      harness: "codex",
    });
    await writer.emit({ kind: "started" });
    const reasoning = nativeTrace("codex", {
      type: "item.completed",
      item: {
        type: "reasoning",
        text: "PRIVATE_THOUGHT password=synthetic-secret",
      },
    });
    expect(reasoning).toEqual([]);
    for (const event of nativeTrace("codex", {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "echo AUTHORIZATION=private",
        aggregated_output: "sensitive mail body",
        exit_code: 1,
      },
    }))
      await writer.emit(event);
    for (const event of nativeTrace("pi", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE_THOUGHT" },
          { type: "text", text: "cookie=private token=secret" },
        ],
        model: "synthetic",
        provider: "fixture",
        thinkingLevel: "high",
        usage: { input: 10, output: 2 },
      },
    }))
      await writer.emit(event);
    await writer.finish("finished", "waiting");
    const tail = await store.tail(run());
    const text = JSON.stringify(tail);
    for (const secret of [
      "PRIVATE_THOUGHT",
      "private",
      "secret",
      "AUTHORIZATION",
      "mail body",
    ])
      expect(text).not.toContain(secret);
    expect(
      tail.events.some(
        (e) => e.kind === "tool-finish" && e.status === "failed",
      ),
    ).toBe(true);
    expect(
      tail.events.some(
        (e) => e.model === "fixture/synthetic" && e.effort === "high",
      ),
    ).toBe(true);
    for (const name of await readdir(root))
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps partial active tails, caps events and prunes bounded finished runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-traces-"));
  try {
    const store = await createTraceStore(root, { maxEvents: 2, maxRuns: 1 });
    const writer = await store.begin({
      runId: run(),
      lane: "visual",
      task: "P1-07",
      harness: "pi",
    });
    await writer.emit({ kind: "started" });
    expect((await store.tail(run())).meta.status).toBe("running");
    await writer.emit({ kind: "omitted", channel: "stderr" });
    await writer.emit({ kind: "assistant" });
    await writer.finish("finished", "ready");
    expect((await store.tail(run())).meta.truncated).toBe(true);
    expect((await store.tail(run())).events).toHaveLength(2);
    await store.begin({
      runId: run(2),
      lane: "visual",
      task: "P1-07",
      harness: "pi",
    });
    expect((await store.list()).runs.map((r) => r.runId)).toEqual([run(2)]);
    await expect(store.tail(run())).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects traversal/symlink reads and safely reports corrupted/oversize partial input", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-traces-"));
  const foreign = join(tmpdir(), `relay-foreign-${Date.now()}`);
  try {
    const store = await createTraceStore(root);
    await expect(store.tail("../secret")).rejects.toThrow();
    await writeFile(foreign, "never-read-private");
    await symlink(foreign, join(root, `${run()}.meta.json`));
    await expect(store.tail(run())).rejects.toThrow();
    const w = await store.begin({
      runId: run(2),
      lane: "coordinator",
      task: null,
      harness: "codex",
    });
    await w.emit({ kind: "started" });
    const path = join(root, `${run(2)}.events.jsonl`);
    const prior = await readFile(path, "utf8");
    await writeFile(
      path,
      prior +
        '{"partial":\n' +
        JSON.stringify({
          sequence: 2,
          at: new Date().toISOString(),
          kind: "assistant",
          message: "raw-secret",
          model: "sk-private",
        }) +
        "\n" +
        "X".repeat(5000) +
        "\n",
    );
    const tail = await store.tail(run(2));
    expect(tail.incomplete).toBe(true);
    expect(JSON.stringify(tail)).not.toContain("raw-secret");
    expect(JSON.stringify(tail)).not.toContain("sk-private");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { force: true });
  }
});

it("reconciles abandoned running traces after restart so retention cannot strand new runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-trace-recovery-"));
  try {
    const original = await createTraceStore(root, { maxRuns: 1 });
    const writer = await original.begin({
      runId: run(),
      lane: "coordinator",
      task: null,
      harness: "codex",
    });
    await writer.emit({ kind: "started" });
    await writeFile(join(root, `${run()}.meta.tmp`), "partial-crash", {
      mode: 0o600,
    });
    const recovered = await createTraceStore(root, { maxRuns: 1 });
    expect(await recovered.reconcile([])).toEqual({
      reconciled: 1,
      incomplete: false,
    });
    const partial = await recovered.tail(run());
    expect(partial.meta).toMatchObject({ status: "paused", finalState: null });
    expect(partial.events.map((event) => event.kind)).toEqual(["started"]);
    expect((await stat(join(root, `${run()}.meta.json`))).mode & 0o777).toBe(
      0o600,
    );
    expect(await recovered.reconcile([])).toEqual({
      reconciled: 0,
      incomplete: false,
    });
    await recovered.begin({
      runId: run(2),
      lane: "coordinator",
      task: null,
      harness: "codex",
    });
    expect((await recovered.list()).runs.map((meta) => meta.runId)).toEqual([
      run(2),
    ]);
    await expect(recovered.reconcile(["../foreign"])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("protects active runs and recovers a private first-rename crash without following temporary symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-trace-partial-recovery-"));
  try {
    const store = await createTraceStore(root);
    for (const id of [run(), run(2), run(3)]) {
      const writer = await store.begin({
        runId: id,
        lane: "coordinator",
        task: null,
        harness: "codex",
      });
      await writer.emit({ kind: "started" });
    }
    const active = join(root, `${run()}.meta.tmp`);
    await writeFile(active, "active-writer-temporary", { mode: 0o600 });
    await rename(
      join(root, `${run(2)}.meta.json`),
      join(root, `${run(2)}.meta.tmp`),
    );
    const foreign = join(root, "foreign-file");
    await writeFile(foreign, "PRIVATE_SENTINEL", { mode: 0o600 });
    await symlink(foreign, join(root, `${run(3)}.meta.tmp`));
    await symlink(foreign, join(root, `${run(4)}.meta.json`));
    expect(await store.reconcile([run()])).toEqual({
      reconciled: 2,
      incomplete: true,
    });
    expect((await store.tail(run())).meta.status).toBe("running");
    expect(await readFile(active, "utf8")).toBe("active-writer-temporary");
    for (const id of [run(2), run(3)])
      expect((await store.tail(id)).meta).toMatchObject({
        status: "paused",
        finalState: null,
      });
    expect(await readFile(foreign, "utf8")).toBe("PRIVATE_SENTINEL");
    await expect(store.tail(run(4))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
