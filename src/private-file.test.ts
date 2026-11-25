import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  PRIVATE_STATE_MAX_BYTES,
  readPrivateFile,
  readPrivateFileSync,
} from "./io.ts";

const dir = mkdtempSync(join(tmpdir(), "crewplane-private-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("names the private state cap", () => {
  expect(PRIVATE_STATE_MAX_BYTES).toBe(65536);
});

it("reads an owner-only regular file, sync and async", async () => {
  const path = join(dir, "ok.json");
  await writeFile(path, '{"a":1}', { mode: 0o600 });
  expect(await readPrivateFile(path, 100)).toBe('{"a":1}');
  expect(readPrivateFileSync(path, 100).toString()).toBe('{"a":1}');
});

it("rejects group or world access, oversize files and non-files with the given message", async () => {
  const open = join(dir, "open.json");
  await writeFile(open, "x", { mode: 0o600 });
  chmodSync(open, 0o640);
  await expect(readPrivateFile(open, 100, "bad mode")).rejects.toThrow(
    "bad mode",
  );
  expect(() => readPrivateFileSync(open, 100, "bad mode")).toThrow("bad mode");
  const big = join(dir, "big.json");
  await writeFile(big, "x".repeat(11), { mode: 0o600 });
  await expect(readPrivateFile(big, 10, "too big")).rejects.toThrow("too big");
  expect(() => readPrivateFileSync(big, 10, "too big")).toThrow("too big");
  expect(await readPrivateFile(big, 11)).toHaveLength(11);
  await expect(readPrivateFile(dir, 10)).rejects.toThrow(
    "Invalid private file",
  );
});

it("does not follow a final symlink and propagates open errors", async () => {
  const target = join(dir, "target.json");
  await writeFile(target, "x", { mode: 0o600 });
  const link = join(dir, "link.json");
  symlinkSync(target, link);
  await expect(readPrivateFile(link, 10)).rejects.toMatchObject({
    code: "ELOOP",
  });
  expect(() => readPrivateFileSync(link, 10)).toThrow();
  await expect(readPrivateFile(join(dir, "missing"), 10)).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});
