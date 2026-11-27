import { expect, it } from "vitest";
import { createResource, ReadError, readErrorMessage } from "./resource.js";

function harness(fetchJson: (path: string) => Promise<unknown>) {
  let clock = 1_000_000;
  const timers: Array<{ at: number; run: () => void; id: number }> = [];
  let next = 1;
  const resource = createResource({
    path: "/api/x",
    fetchJson,
    now: () => clock,
    setTimer: (run: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: clock + ms, run, id });
      return id;
    },
    clearTimer: (id: number | null) => {
      const index = timers.findIndex((t) => t.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
    minIntervalMs: 15000,
    debounceMs: 1500,
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((t) => t.at <= clock)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  };
  return { resource, advance, timers, tick: (ms: number) => (clock += ms) };
}

it("maps failures to plain messages without echoing arbitrary bodies", () => {
  expect(readErrorMessage(401, null)).toMatch(/Session missing or expired/);
  expect(readErrorMessage(400, { error: "x" })).toMatch(/refused/);
  expect(readErrorMessage(503, { error: "Could not read" })).toBe(
    "Could not read",
  );
  expect(readErrorMessage(503, null)).toMatch(/could not read/);
  expect(readErrorMessage(500, null)).toBe("The request failed (500).");
  expect(readErrorMessage(503, { error: "y".repeat(500) })).toHaveLength(300);
});

it("loads once, keeps the data and reports listeners", async () => {
  const seen: string[] = [];
  const { resource } = harness(async () => ({ ok: 1 }));
  resource.onChange((s: { status: string }) => seen.push(s.status));
  await resource.load();
  expect(resource.state.data).toEqual({ ok: 1 });
  expect(resource.state.status).toBe("ready");
  expect(seen).toEqual(["loading", "ready"]);
});

it("keeps the last good data when a later read fails", async () => {
  let fail = false;
  const { resource } = harness(async () => {
    if (fail) throw new ReadError(503, "Could not read");
    return { n: 1 };
  });
  await resource.load();
  fail = true;
  await resource.load();
  expect(resource.state.status).toBe("error");
  expect(resource.state.data).toEqual({ n: 1 });
  expect(resource.state.error).toEqual({
    status: 503,
    message: "Could not read",
  });
});

it("never runs two requests at once and repeats a forced load once", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const { resource } = harness(async () => {
    calls += 1;
    await new Promise<void>((done) => {
      release = done;
    });
    return { calls };
  });
  const first = resource.load();
  resource.load();
  resource.load({ force: true });
  resource.load({ force: true });
  expect(calls).toBe(1);
  release();
  await first;
  await new Promise((done) => setTimeout(done, 0));
  expect(calls).toBe(2);
  release();
});

it("debounces a burst of snapshot changes into one throttled load", async () => {
  let calls = 0;
  const { resource, advance, timers, tick } = harness(async () => {
    calls += 1;
    return { calls };
  });
  resource.schedule();
  resource.schedule();
  resource.schedule();
  expect(timers).toHaveLength(1);
  await advance(1499);
  expect(calls).toBe(0);
  await advance(1);
  expect(calls).toBe(1);
  // A change right after a load waits out the minimum interval.
  tick(1000);
  resource.schedule();
  await advance(1500);
  expect(calls).toBe(1);
  await advance(13000);
  expect(calls).toBe(2);
});

it("cancels a pending scheduled load", async () => {
  const { resource, timers } = harness(async () => ({}));
  resource.schedule();
  resource.cancel();
  expect(timers).toHaveLength(0);
});
