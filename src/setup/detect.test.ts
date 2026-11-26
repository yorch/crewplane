import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  acceptBinary,
  describeRejection,
  detectHarnesses,
  findOnPath,
  type Rejection,
} from "./detect.ts";
import { binarySafetyProblem } from "./safety.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const temp = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-detect-")));
  scratch.push(path);
  return path;
};
const fake = (dir: string, name: string, mode = 0o755) => {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho SHOULD-NEVER-RUN >&2; exit 9\n");
  chmodSync(path, mode);
  return path;
};

it("detects fake binaries on a temp PATH without running them", async () => {
  const dir = temp();
  const codex = fake(dir, "codex");
  const claude = fake(dir, "claude");
  fake(dir, "opencode", 0o644); // not executable
  const found = await detectHarnesses(dir);
  expect(found).toEqual({
    codex,
    claude,
    opencode: null,
    pi: null,
  });
});

it("honors PATH order, skips relative entries and keeps symlinks as found", async () => {
  const a = temp(),
    b = temp();
  const real = fake(b, "pi-real");
  symlinkSync(real, join(a, "pi"));
  const path = ["", ".", "relative/dir", a, b].join(delimiter);
  expect(await findOnPath("pi", path)).toBe(join(a, "pi"));
  expect(await findOnPath("pi", "")).toBeNull();
  expect(await findOnPath("../pi", a)).toBeNull();
});

it("ignores directories and dangling symlinks named like a harness", async () => {
  const dir = temp();
  mkdirSync(join(dir, "codex"));
  symlinkSync(join(dir, "nowhere"), join(dir, "claude"));
  expect(await detectHarnesses(dir)).toEqual({
    codex: null,
    claude: null,
    opencode: null,
    pi: null,
  });
});

it("accepts only absolute executable regular files", async () => {
  const dir = temp();
  const good = fake(dir, "claude");
  expect(await acceptBinary(good, "claude")).toBe(good);
  await expect(acceptBinary("claude", "claude")).rejects.toThrow(
    /must be absolute/,
  );
  await expect(acceptBinary("./claude", "claude")).rejects.toThrow(
    /must be absolute/,
  );
  await expect(
    acceptBinary(fake(dir, "plain", 0o644), "claude"),
  ).rejects.toThrow(/not an executable regular file/);
  await expect(acceptBinary(dir, "claude")).rejects.toThrow(
    /not an executable regular file/,
  );
  await expect(acceptBinary(join(dir, "missing"), "claude")).rejects.toThrow(
    /not an executable/,
  );
});

it("uses an injected checker instead of the file system", async () => {
  const seen: string[] = [];
  const found = await findOnPath("codex", "/one:/two", async (path) => {
    seen.push(path);
    return path === "/two/codex";
  });
  expect(found).toBe("/two/codex");
  expect(seen).toEqual(["/one/codex", "/two/codex"]);
});

it("skips group/world-writable files and unsafe directories, listing each reason", async () => {
  const good = temp(),
    loose = temp(),
    wide = temp();
  fake(good, "codex");
  fake(loose, "codex", 0o775);
  fake(wide, "codex");
  chmodSync(wide, 0o777);
  const rejected: Rejection[] = [];
  const path = [loose, wide, good].join(delimiter);
  expect(await findOnPath("codex", path, undefined, undefined, rejected)).toBe(
    join(good, "codex"),
  );
  expect(rejected).toEqual([
    { path: join(loose, "codex"), reason: "it is group- or world-writable" },
    {
      path: join(wide, "codex"),
      reason: "its directory is world-writable without the sticky bit",
    },
  ]);
  expect(describeRejection(rejected[0] as Rejection)).toBe(
    `rejected ${join(loose, "codex")}: it is group- or world-writable`,
  );
  // Sticky world-writable directories (/tmp style) are protected.
  chmodSync(wide, 0o1777);
  expect(await binarySafetyProblem(join(wide, "codex"))).toBeNull();
  // acceptBinary applies the same policy to explicit paths.
  await expect(acceptBinary(join(loose, "codex"), "codex")).rejects.toThrow(
    /codex binary refused: it is group- or world-writable/,
  );
});

it("judges a symlink by its resolved target and the directory it was named in", async () => {
  const home = temp(),
    wide = temp(),
    safe = temp();
  fake(safe, "real");
  chmodSync(wide, 0o777);
  symlinkSync(join(safe, "real"), join(wide, "pi"));
  expect(await binarySafetyProblem(join(wide, "pi"))).toMatch(
    /world-writable without the sticky bit/,
  );
  symlinkSync(join(safe, "real"), join(home, "pi"));
  expect(await binarySafetyProblem(join(home, "pi"))).toBeNull();
  expect(await binarySafetyProblem(join(home, "missing"))).toBe(
    "it cannot be inspected",
  );
});
