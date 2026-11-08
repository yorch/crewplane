import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchdogInput, WatchdogSettings } from "./policy.ts";
import type { WatchdogOptions } from "./service.ts";
import { checkWatchdog, startWatchdog } from "./service.ts";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "relay-watchdog-fixture-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const settings: WatchdogSettings = {
  version: 1,
  intervalMs: 180000,
  startupGraceMs: 0,
  stallMs: 360000,
  cooldownMs: 540000,
  backoffMs: 180000,
  maxBackoffMs: 720000,
};
function snapshot(now: number): WatchdogInput {
  return {
    version: 1,
    now,
    desiredRunning: true,
    supervisor: { pid: 555, alive: "dead", heartbeatAt: 0, draining: false },
    config: { loaded: "fixture-config", disk: "fixture-config" },
    children: [],
    queue: [],
    coordinator: { turnStartedAt: null, oldestUnhandledAt: null },
    availableCapacity: null,
  };
}
async function setup() {
  let now = 900000;
  const controller = new AbortController();
  const options: WatchdogOptions = {
    directory: await directory(),
    settings,
    readInput: async () => snapshot(now),
    notify: vi.fn(async () => {}),
    requestRecovery: vi.fn(async () => {}),
    signal: controller.signal,
    clock: {
      now: () => now,
      sleep: async () => {
        throw new Error("Unexpected sleep");
      },
    },
  };
  return {
    options,
    controller,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function latest(path: string) {
  return JSON.parse(await readFile(join(path, "latest.json"), "utf8"));
}
describe("private watchdog service", () => {
  it("checks once, projects notice only, persists private bounded state and releases lease", async () => {
    const { options } = await setup();
    const result = await checkWatchdog(options);
    expect(result?.notice).toEqual({
      key: "supervisor-dead",
      codes: ["supervisor-dead"],
    });
    expect(options.notify).toHaveBeenCalledExactlyOnceWith({
      key: "supervisor-dead",
      codes: ["supervisor-dead"],
    });
    expect(options.requestRecovery).not.toHaveBeenCalled();
    expect(await latest(options.directory)).toMatchObject({
      checkedAt: 900000,
      nextCheck: 1080000,
      delivery: "complete",
    });
    expect((await stat(options.directory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(options.directory, "latest.json"))).mode & 0o777,
    ).toBe(0o600);
    await expect(stat(join(options.directory, "lease"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await stat(join(options.directory, "latest.json"))).size,
    ).toBeLessThan(65536);
  });
  it("uses180s fake-clock cadence and stops gracefully without another observation", async () => {
    const { options, controller, advance } = await setup();
    const sleeps: number[] = [];
    if (!options.clock) throw new Error("Missing fixture clock");
    options.clock.sleep = async (ms) => {
      sleeps.push(ms);
      advance(ms);
      if (sleeps.length === 3) controller.abort();
    };
    await startWatchdog(options);
    expect(sleeps).toEqual([180000, 180000, 180000]);
    expect(options.notify).toHaveBeenCalledTimes(1);
    expect(await latest(options.directory)).toMatchObject({
      checkedAt: 1260000,
      nextCheck: 1440000,
    });
    await expect(stat(join(options.directory, "lease"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("honors persisted nextCheck/cooldown across stop and resume", async () => {
    const { options, advance } = await setup();
    await checkWatchdog(options);
    expect(await checkWatchdog(options)).toBeNull();
    advance(180000);
    await checkWatchdog(options);
    expect(options.notify).toHaveBeenCalledTimes(1);
    advance(360000);
    await checkWatchdog(options);
    expect(options.notify).toHaveBeenCalledTimes(2);
  });
  it("persists callback failures without raw error strings, repeated notices or mutation", async () => {
    const { options, advance } = await setup();
    options.notify = vi.fn(async (notice) => {
      notice.codes.push("PRIVATE_SOURCE_TEXT");
      throw new Error("PRIVATE_SOURCE_TEXT");
    });
    await checkWatchdog(options);
    expect(await latest(options.directory)).toMatchObject({
      delivery: "callback-failed",
    });
    expect(
      await readFile(join(options.directory, "latest.json"), "utf8"),
    ).not.toContain("PRIVATE_SOURCE_TEXT");
    advance(180000);
    await checkWatchdog(options);
    expect(options.notify).toHaveBeenCalledTimes(1);
  });
  it("persists restart request backoff even on controller failure", async () => {
    const { options, advance } = await setup();
    options.settings = { ...settings, recoveryEnabled: true };
    options.requestRecovery = vi.fn(async () => {
      throw new Error("private-controller-error");
    });
    await checkWatchdog(options);
    expect(options.requestRecovery).toHaveBeenCalledExactlyOnceWith(
      "request-restart",
    );
    expect(await latest(options.directory)).toMatchObject({
      delivery: "callback-failed",
      state: { restartAttempts: 1 },
    });
    advance(180000);
    await checkWatchdog(options);
    expect(options.requestRecovery).toHaveBeenCalledTimes(1);
    advance(180000);
    await checkWatchdog(options);
    expect(options.requestRecovery).toHaveBeenCalledTimes(2);
  });
  it("refuses concurrent owners, recording a verifiable PID and unique owner identity", async () => {
    const { options } = await setup();
    const entered = deferred();
    const release = deferred();
    options.readInput = async () => {
      entered.resolve();
      await release.promise;
      return snapshot(900000);
    };
    const first = checkWatchdog(options);
    await entered.promise;
    try {
      const owner = JSON.parse(
        await readFile(join(options.directory, "lease", "owner.json"), "utf8"),
      );
      expect(owner.pid).toBe(process.pid);
      expect(owner.identity).toMatch(/^[a-f0-9-]{36}$/);
      await expect(checkWatchdog(options)).rejects.toThrow(
        "Watchdog lease unavailable",
      );
    } finally {
      release.resolve();
      await first;
    }
  });
  it.each(["dead", "unknown", "incomplete"])(
    "never automatically steals a %s lease",
    async (kind) => {
      const { options } = await setup();
      const lease = join(options.directory, "lease");
      await mkdir(lease, { mode: 0o700 });
      if (kind !== "incomplete")
        await writeFile(
          join(lease, "owner.json"),
          JSON.stringify({
            pid: kind === "dead" ? 2147483647 : null,
            identity: kind,
          }),
          { mode: 0o600 },
        );
      await expect(checkWatchdog(options)).rejects.toThrow(
        "Watchdog lease unavailable",
      );
      expect(options.notify).not.toHaveBeenCalled();
      expect((await stat(lease)).isDirectory()).toBe(true);
    },
  );
  it("aborts during input without invoking effects and stops an outstanding real sleep", async () => {
    const { options, controller } = await setup();
    options.readInput = async () => {
      controller.abort();
      return snapshot(900000);
    };
    await startWatchdog(options);
    expect(options.notify).not.toHaveBeenCalled();
    const second = await setup();
    delete second.options.clock;
    second.options.readInput = async () => snapshot(Date.now());
    const running = startWatchdog(second.options);
    await vi.waitFor(async () =>
      expect(await latest(second.options.directory)).toMatchObject({
        delivery: "complete",
      }),
    );
    second.controller.abort();
    await running;
    await expect(
      stat(join(second.options.directory, "lease")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses oversized, corrupt, public or symlink state without following it", async () => {
    for (const body of ["{", "x".repeat(65537), '{"state":{}}']) {
      const { options } = await setup();
      await writeFile(join(options.directory, "latest.json"), body, {
        mode: 0o600,
      });
      await expect(checkWatchdog(options)).rejects.toThrow(/Invalid watchdog/);
    }
    const { options } = await setup();
    const external = join(await directory(), "external");
    await writeFile(external, "do not overwrite", { mode: 0o600 });
    await symlink(external, join(options.directory, "latest.json"));
    await expect(checkWatchdog(options)).rejects.toThrow(
      "Invalid watchdog state",
    );
    expect(await readFile(external, "utf8")).toBe("do not overwrite");
    const publicState = await setup();
    await writeFile(join(publicState.options.directory, "latest.json"), "{}", {
      mode: 0o644,
    });
    await expect(checkWatchdog(publicState.options)).rejects.toThrow(
      "Invalid watchdog state",
    );
  });
  it("rejects stale snapshots and masks adapter error payloads while releasing its lease", async () => {
    const { options } = await setup();
    options.readInput = async () => snapshot(0);
    await expect(checkWatchdog(options)).rejects.toThrow(
      "Watchdog observation time mismatch",
    );
    options.readInput = async () => {
      throw new Error("PRIVATE_SOURCE_TEXT");
    };
    await expect(checkWatchdog(options)).rejects.toThrow(
      "Watchdog input unavailable",
    );
    await expect(stat(join(options.directory, "lease"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("anchors accepted180s-old snapshots to real check time on every tick", async () => {
    const { options, controller, advance } = await setup();
    const clock = options.clock;
    if (!clock) throw new Error("Missing fixture clock");
    const checkedAt: number[] = [];
    options.readInput = async () => {
      checkedAt.push(clock.now());
      return snapshot(clock.now() - 180000);
    };
    const sleeps: number[] = [];
    clock.sleep = async (ms) => {
      sleeps.push(ms);
      advance(ms);
      if (sleeps.length === 3) controller.abort();
    };
    await startWatchdog(options);
    expect(checkedAt).toEqual([900000, 1080000, 1260000]);
    expect(sleeps).toEqual([180000, 180000, 180000]);
    expect(await latest(options.directory)).toMatchObject({
      checkedAt: 1260000,
      nextCheck: 1440000,
      state: { startedAt: 900000, lastCheckAt: 1260000, nextCheckAt: 1440000 },
    });
    expect(options.notify).toHaveBeenCalledTimes(1);
  });
  it("waits180s after a boundary cached snapshot and then rejects an expired cache", async () => {
    const { options, advance } = await setup();
    options.readInput = vi.fn(async () => snapshot(720000));
    const clock = options.clock;
    if (!clock) throw new Error("Missing fixture clock");
    const sleeps: number[] = [];
    clock.sleep = async (ms) => {
      sleeps.push(ms);
      advance(ms);
    };
    await expect(startWatchdog(options)).rejects.toThrow(
      "Watchdog observation time mismatch",
    );
    expect(sleeps).toEqual([180000]);
    expect(options.readInput).toHaveBeenCalledTimes(2);
    expect(await latest(options.directory)).toMatchObject({
      checkedAt: 900000,
      nextCheck: 1080000,
    });
    await expect(stat(join(options.directory, "lease"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("uses the post-read check clock and accounts for callback time in cadence", async () => {
    const { options, controller, advance } = await setup();
    options.readInput = async () => {
      advance(1000);
      return snapshot(900000);
    };
    options.notify = vi.fn(async () => {
      advance(4000);
    });
    const clock = options.clock;
    if (!clock) throw new Error("Missing fixture clock");
    const sleeps: number[] = [];
    clock.sleep = async (ms) => {
      sleeps.push(ms);
      controller.abort();
    };
    await startWatchdog(options);
    expect(sleeps).toEqual([176000]);
    expect(await latest(options.directory)).toMatchObject({
      checkedAt: 901000,
      nextCheck: 1081000,
    });
  });
});
