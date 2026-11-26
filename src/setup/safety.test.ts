import {
  chmodSync,
  chownSync,
  existsSync,
  lchownSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { binarySafetyProblem } from "./safety.ts";

const scratch: string[] = [];
const markers: string[] = [];
afterEach(() => {
  // A fake harness writes a marker if executed; the probe must never run it.
  const ran = markers.splice(0).filter((marker) => existsSync(marker));
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
  expect(ran).toEqual([]);
});
function base() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-safety-")));
  scratch.push(dir);
  return dir;
}
const executable = (directory: string, name = "codex") => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  const marker = `${directory}.ran`;
  markers.push(marker);
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
};
// Foreign ownership can only be arranged when this process may chown.
const other = 65534;
const canChown = (() => {
  if (process.getuid?.() !== 0) return false;
  const dir = base();
  try {
    chownSync(dir, other, other);
    return true;
  } catch {
    return false;
  }
})();

it("accepts a plain file in a private directory", async () => {
  const path = executable(join(base(), "bin"));
  expect(await binarySafetyProblem(path)).toBeNull();
});

it.skipIf(!canChown)(
  "refuses a file owned by another user even in a directory we own",
  async () => {
    const path = executable(join(base(), "bin"));
    chownSync(path, other, other);
    expect(await binarySafetyProblem(path)).toBe("it is owned by another user");
  },
);

it.skipIf(!canChown)(
  "refuses a foreign-owned file inside a sticky world-writable directory",
  async () => {
    const dir = join(base(), "sticky");
    const path = executable(dir);
    chmodSync(dir, 0o1777);
    chownSync(path, other, other);
    expect(await binarySafetyProblem(path)).toBe("it is owned by another user");
  },
);

it.skipIf(!canChown)(
  "refuses a group-writable directory whose group is not ours (2775 root:other)",
  async () => {
    const dir = join(base(), "shared");
    const path = executable(dir);
    chownSync(dir, 0, other);
    chmodSync(dir, 0o2775);
    expect(await binarySafetyProblem(path)).toMatch(/group-writable/);
  },
);

it("refuses a group-writable directory unless it is ours with our own group", async () => {
  const dir = join(base(), "mine");
  const path = executable(dir);
  chmodSync(dir, 0o775);
  // The directory is owned by us with our primary group: accepted.
  expect(await binarySafetyProblem(path)).toBeNull();
});

it("refuses a world-writable directory elsewhere in a symlink chain", async () => {
  const root = base();
  const real = executable(join(root, "real"));
  const open = join(root, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  const middle = join(open, "middle");
  symlinkSync(real, middle);
  const first = join(root, "safe-bin");
  mkdirSync(first);
  const link = join(first, "codex");
  symlinkSync(middle, link);
  // The final file and the first link's directory are fine; the middle hop's
  // directory is not.
  expect(await binarySafetyProblem(link)).toMatch(
    /world-writable without the sticky bit/,
  );
});

it("refuses a world-writable ancestor of the binary's directory", async () => {
  const root = base();
  const wide = join(root, "wide");
  mkdirSync(wide);
  const path = executable(join(wide, "inner", "bin"));
  chmodSync(wide, 0o777);
  expect(await binarySafetyProblem(path)).toMatch(
    /parent directory .* is world-writable without the sticky bit/,
  );
  // A sticky ancestor (like /tmp) is allowed.
  chmodSync(wide, 0o1777);
  expect(await binarySafetyProblem(path)).toBeNull();
});

it.skipIf(!canChown)(
  "refuses a foreign-owned ancestor and a foreign-owned symlink hop",
  async () => {
    const root = base();
    const outer = join(root, "outer");
    const path = executable(join(outer, "inner"));
    chownSync(outer, other, other);
    expect(await binarySafetyProblem(path)).toMatch(
      /parent directory .* is owned by another user/,
    );
    chownSync(outer, 0, 0);
    const link = join(root, "link");
    symlinkSync(path, link);
    // lchown: the link itself belongs to someone else.
    lchownSync(link, other, other);
    expect(await binarySafetyProblem(link)).toBe("it is owned by another user");
  },
);
