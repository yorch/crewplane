import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  openUsageLedger,
  type UsageEvent,
  validateUsageEvent,
} from "./usage-ledger.ts";

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    version: 1,
    id: "one",
    lane: "E",
    task: "P0-27",
    run: "run",
    session: "session",
    turn: "turn",
    harness: "codex",
    provider: "synthetic",
    observedModel: "model-a",
    configuredModel: "model-config",
    at: "2026-11-08T00:00:00Z",
    durationMs: 100,
    provenance: "synthetic-v1",
    semantics: "delta",
    series: "series-a",
    input: 100,
    output: 20,
    cacheRead: 40,
    cacheWrite: null,
    reasoning: 5,
    cacheReadRelation: "input-subset",
    reasoningRelation: "output-subset",
    partial: false,
    ...overrides,
  };
}
describe("verified usage", () => {
  it("keeps subsets separate, zero reported and unknown unavailable", () => {
    const a = aggregateUsage([
      event(),
      event({
        id: "two",
        input: 0,
        output: null,
        cacheRead: 0,
        reasoning: null,
        durationMs: null,
        partial: true,
      }),
    ]);
    expect(a.totals).toEqual({
      input: 100,
      output: 20,
      cacheRead: 40,
      cacheWrite: 0,
      reasoning: 5,
    });
    expect(a.coverage.output).toEqual({ reported: 1, unavailable: 1 });
    expect(a.coverage.input).toEqual({ reported: 2, unavailable: 0 });
    expect(a.cacheHitRatio).toEqual({
      value: 0.4,
      numerator: 40,
      denominator: 100,
      eligible: 2,
      unavailable: 0,
    });
    expect(a.partialEvents).toBe(1);
    expect(a.durationMs).toBe(100);
  });
  it("deduplicates, rejects conflicts, reconciles late snapshots and reset series", () => {
    const a = event({ semantics: "cumulative" });
    const b = event({
      id: "later",
      semantics: "cumulative",
      input: 160,
      output: 30,
      cacheRead: 60,
      durationMs: 150,
    });
    const late = event({
      id: "late",
      semantics: "cumulative",
      input: 120,
      output: 25,
      cacheRead: 50,
    });
    const reset = event({
      id: "reset",
      semantics: "cumulative",
      series: "reset",
      input: 10,
      output: 2,
      cacheRead: 0,
      reasoning: 0,
    });
    expect(aggregateUsage([b, a, late, a, reset]).totals).toEqual({
      input: 170,
      output: 32,
      cacheRead: 60,
      cacheWrite: 0,
      reasoning: 5,
    });
    expect(() =>
      aggregateUsage([a, event({ semantics: "cumulative", input: 101 })]),
    ).toThrow("Conflicting");
    expect(() =>
      aggregateUsage([
        a,
        event({ id: "bad", semantics: "cumulative", observedModel: "other" }),
      ]),
    ).toThrow("dimensions");
  });
  it("filters half-open windows and observed model without configured fallback", () => {
    const events = [
      event(),
      event({
        id: "two",
        observedModel: "model-b",
        at: "2026-11-09T00:00:00Z",
        run: "other",
      }),
    ];
    expect(
      aggregateUsage(events, {
        from: "2026-11-08T00:00:00Z",
        to: "2026-11-09T00:00:00Z",
      }).totals.input,
    ).toBe(100);
    expect(aggregateUsage(events, { model: "model-b" }).uniqueRuns).toBe(1);
    expect(aggregateUsage(events, { model: "model-config" }).events).toBe(0);
    expect(
      aggregateUsage(events, { provider: "absent" }).cacheHitRatio.value,
    ).toBeNull();
  });
  it("rejects unsafe/unbounded/raw input and overflow", () => {
    for (const bad of [
      { ...event(), input: -1 },
      { ...event(), input: NaN },
      { ...event(), cacheRead: 101 },
      { ...event(), reasoning: 21 },
      { ...event(), prompt: "private" },
      { ...event(), id: "x".repeat(257) },
      { ...event(), at: "tomorrow" },
      { ...event(), at: "2026-02-30T00:00:00Z" },
    ])
      expect(() => validateUsageEvent(bad)).toThrow();
    expect(() =>
      aggregateUsage([
        event({ input: Number.MAX_SAFE_INTEGER }),
        event({ id: "two" }),
      ]),
    ).toThrow("safe integer");
  });
  it("persists replay identity across reopen, bounds retention and protects permissions", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "usage-test-"));
    try {
      let ledger = await openUsageLedger(root, { maxEvents: 2 });
      await expect(openUsageLedger(root)).rejects.toThrow();
      await ledger.append(event());
      expect(await ledger.append(event())).toEqual({ duplicate: true });
      await ledger.close();
      ledger = await openUsageLedger(root, { maxEvents: 2 });
      expect(await ledger.append(event())).toEqual({ duplicate: true });
      await ledger.append(event({ id: "two", observedModel: "model-b" }));
      await expect(ledger.append(event({ id: "third" }))).rejects.toThrow(
        "capacity",
      );
      expect((await ledger.query()).totals.input).toBe(200);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "ledger.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(root, "ledger.json"), "utf8")).not.toContain(
        "prompt",
      );
      await ledger.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects symlink directories and ledger files", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "usage-links-"));
    try {
      await symlink(root, join(root, "link"));
      await expect(openUsageLedger(join(root, "link"))).rejects.toThrow(
        "Unsafe",
      );
      await symlink(join(root, "target"), join(root, "ledger.json"));
      await expect(openUsageLedger(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recovers a dead writer and ignores an uncommitted pending snapshot", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "usage-recovery-"),
    );
    try {
      const first = await openUsageLedger(root);
      await first.append(event());
      await first.close();
      const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      expect(exited.status).toBe(0);
      await writeFile(join(root, "writer.lock"), String(exited.pid), {
        mode: 0o600,
      });
      await writeFile(join(root, "pending.json"), "uncommitted", {
        mode: 0o600,
      });
      const reopened = await openUsageLedger(root);
      expect((await reopened.query()).totals.input).toBe(100);
      expect(await reopened.append(event())).toEqual({ duplicate: true });
      await reopened.close();
      const tiny = await openUsageLedger(root, { maxBytes: 4096 });
      await expect(
        tiny.append(event({ id: "new", provenance: "x".repeat(256) })),
      ).resolves.toEqual({ duplicate: false });
      await tiny.close();
      await expect(openUsageLedger(root, { maxBytes: 2 })).rejects.toThrow(
        "capacity",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
