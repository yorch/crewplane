import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectBinary } from "./doctor.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
// A fake harness that leaves a marker if anything ever runs it.
const fake = (mode = 0o755) => {
  const dir = mkdtempSync(join(tmpdir(), "crewplane-inspect-"));
  scratch.push(dir);
  const marker = join(dir, "ran");
  const path = join(dir, "harness");
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(path, mode);
  return { path, marker };
};

it("passes a usable binary when the injected safety check accepts it", async () => {
  const { path, marker } = fake();
  const seen: string[] = [];
  const result = await inspectBinary(path, "codex", async (p) => {
    seen.push(p);
    return null;
  });
  expect(result).toEqual({ probe: { path, ok: true } });
  expect(seen).toEqual([path]);
  expect(existsSync(marker)).toBe(false);
});

it("reports BINARY_UNSAFE with the check's reason and ok false", async () => {
  const { path, marker } = fake();
  const result = await inspectBinary(path, "claude", async () => "because");
  expect(result).toEqual({
    code: "BINARY_UNSAFE",
    probe: {
      path,
      ok: false,
      problem: "claude binary refused: because",
    },
  });
  expect(existsSync(marker)).toBe(false);
});

it("never runs the safety check when the probe already failed", async () => {
  const seen: string[] = [];
  const safety = async (p: string) => {
    seen.push(p);
    return "unsafe";
  };
  expect((await inspectBinary(undefined, "codex", safety)).code).toBe(
    "BINARY_MISSING",
  );
  expect((await inspectBinary("relative", "codex", safety)).code).toBe(
    "BINARY_INVALID",
  );
  const plain = fake(0o644);
  expect((await inspectBinary(plain.path, "codex", safety)).code).toBe(
    "BINARY_NOT_EXECUTABLE",
  );
  expect(seen).toEqual([]);
});

it("applies the real safety walk by default: a group- or world-writable file is refused", async () => {
  const { path, marker } = fake(0o757);
  const result = await inspectBinary(path, "codex");
  expect(result.code).toBe("BINARY_UNSAFE");
  expect(result.probe.problem).toBe(
    "codex binary refused: it is group- or world-writable",
  );
  expect(existsSync(marker)).toBe(false);
});
