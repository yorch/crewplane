import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { watchdogHealth } from "./dashboard.ts";
import type { WatchdogInput } from "./policy.ts";
import { readHealth, settings } from "./runner.ts";
import { checkWatchdog } from "./service.ts";

it("delivers synthetic dead/paused/mismatch faults visibly without controlling live processes", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-visible-watchdog-"));
  try {
    let notices = 0;
    const input: WatchdogInput = {
      version: 1,
      now: 900000,
      desiredRunning: true,
      supervisor: {
        pid: 999999,
        alive: "dead",
        heartbeatAt: 0,
        draining: false,
      },
      children: [],
      config: { loaded: "a", disk: "b" },
      queue: [],
      coordinator: { turnStartedAt: null, oldestUnhandledAt: null },
      availableCapacity: null,
      lanePauses: [{ lane: "coordinator", reason: "failure" }],
    };
    await checkWatchdog({
      directory: join(store, "watchdog"),
      readInput: async () => input,
      settings: { ...settings, startupGraceMs: 0 },
      signal: new AbortController().signal,
      notify: async () => {
        notices++;
      },
      requestRecovery: async () => {
        throw Error("Must not restart");
      },
      clock: { now: () => 900000, sleep: async () => {} },
    });
    const health = await watchdogHealth(store, 900000);
    expect(notices).toBe(1);
    expect(health.state).toBe("alert");
    expect(health.codes).toEqual(
      expect.arrayContaining([
        "supervisor-dead",
        "config-mismatch",
        "pause-failure",
      ]),
    );
    await writeFile(
      join(store, "watchdog/latest.json"),
      JSON.stringify({
        checkedAt: 900000,
        nextCheck: 1080000,
        observations: [{ code: "PRIVATE_SENTINEL" }],
      }),
      { mode: 0o600 },
    );
    expect(JSON.stringify(await watchdogHealth(store, 900000))).not.toContain(
      "PRIVATE_SENTINEL",
    );
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("keeps failed rollout observable while protecting a live drain and intentional stop", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-rollout-health-"));
  try {
    const supervisor = join(store, "supervisor");
    await (await import("node:fs/promises")).mkdir(supervisor, { mode: 0o700 });
    await writeFile(
      join(supervisor, "desired.json"),
      JSON.stringify({ desiredRunning: true }),
      { mode: 0o600 },
    );
    await writeFile(
      join(supervisor, "state.json"),
      JSON.stringify({
        pid: 123,
        running: false,
        draining: true,
        checkedAt: new Date(0).toISOString(),
        held: [],
        records: {},
      }),
      { mode: 0o600 },
    );
    let input = await readHealth(store, 900000, () => "dead");
    expect(input.supervisor.draining).toBe(false);
    await checkWatchdog({
      directory: join(store, "watchdog"),
      readInput: async () => input,
      settings: { ...settings, startupGraceMs: 0 },
      signal: new AbortController().signal,
      notify: async () => {},
      requestRecovery: async () => {
        throw Error("Recovery disabled");
      },
      clock: { now: () => 900000, sleep: async () => {} },
    });
    expect((await watchdogHealth(store, 900000)).codes).toContain(
      "supervisor-dead",
    );
    await writeFile(
      join(supervisor, "state.json"),
      JSON.stringify({
        pid: 123,
        running: true,
        draining: true,
        held: [],
        records: {},
      }),
      { mode: 0o600 },
    );
    input = await readHealth(store, 900000, () => "alive");
    expect(input.supervisor.draining).toBe(true);
    await writeFile(
      join(supervisor, "desired.json"),
      JSON.stringify({ desiredRunning: false }),
      { mode: 0o600 },
    );
    expect((await readHealth(store, 900000, () => "dead")).desiredRunning).toBe(
      false,
    );
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it("keeps actionable summaries visible beyond capped detail and notice cooldown without leaking unknown codes", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-watchdog-summary-"));
  try {
    await (await import("node:fs/promises")).mkdir(join(store, "watchdog"), {
      mode: 0o700,
    });
    const details = Array.from({ length: 64 }, () => ({
      code: "wait-dependency",
    }));
    const path = join(store, "watchdog/latest.json");
    const save = async (extra: object) =>
      writeFile(
        path,
        JSON.stringify({
          checkedAt: 900000,
          nextCheck: 1080000,
          observations: details,
          ...extra,
        }),
        { mode: 0o600 },
      );
    await save({ notice: { codes: ["steering-stalled", "PRIVATE_SENTINEL"] } });
    const legacy = await watchdogHealth(store, 900000);
    expect(legacy).toMatchObject({
      state: "alert",
      codes: ["steering-stalled"],
    });
    expect(JSON.stringify(legacy)).not.toContain("PRIVATE_SENTINEL");
    await save({
      codes: ["steering-stalled", "pause-failure", "PRIVATE_SENTINEL"],
      notice: null,
    });
    expect(await watchdogHealth(store, 900000)).toMatchObject({
      state: "alert",
      codes: ["steering-stalled", "pause-failure"],
    });
    await save({ codes: [], notice: null, observations: [] });
    expect(await watchdogHealth(store, 900000)).toMatchObject({
      state: "observing",
      codes: [],
    });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
