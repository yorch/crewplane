import { afterEach, expect, it, vi } from "vitest";
import {
  isProcessAlive,
  probeDetail,
  probeProcess,
  validPid,
} from "./liveness.ts";

afterEach(() => vi.restoreAllMocks());

const failWith = (code: string) =>
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(code), { code });
  });

it("classifies signal-0 outcomes: only ESRCH is dead; EPERM and others are unknown", () => {
  failWith("ESRCH");
  expect(probeProcess(4242)).toBe("dead");
  expect(isProcessAlive(4242)).toBe(false);
  failWith("EPERM");
  expect(probeProcess(4242)).toBe("unknown");
  expect(probeDetail(4242)).toEqual({ state: "unknown", code: "EPERM" });
  // Conservative callers keep treating an unprovable process as possibly alive.
  expect(isProcessAlive(4242)).toBe(true);
  failWith("EINVAL");
  expect(probeProcess(4242)).toBe("unknown");
  expect(isProcessAlive(4242)).toBe(true);
});

it("reports the running process alive and never signals invalid pids", () => {
  expect(probeProcess(process.pid)).toBe("alive");
  const kill = vi.spyOn(process, "kill");
  for (const pid of [undefined, 0, -1, 1.5, Number.NaN])
    expect(isProcessAlive(pid)).toBe(false);
  expect(validPid(process.pid)).toBe(true);
  expect(kill).not.toHaveBeenCalled();
});
