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
import { binarySafetyProblem, type Identity } from "./safety.ts";

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
    expect(await binarySafetyProblem(path)).toMatch(
      /group-writable by a group the current user is not in/,
    );
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
    /directory on its path .* is world-writable without the sticky bit/,
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
      /directory on its path .* is owned by another user/,
    );
    chownSync(outer, 0, 0);
    const link = join(root, "link");
    symlinkSync(path, link);
    // lchown: the link itself belongs to someone else.
    lchownSync(link, other, other);
    expect(await binarySafetyProblem(link)).toBe("it is owned by another user");
  },
);

// Deterministic identities: no wrapper faking getuid/getgid is needed.
const asUser = (uid: number, gid: number, ...groups: number[]): Identity => ({
  uid,
  gid,
  groups: [gid, ...groups],
});
const root = asUser(0, 0);

it.skipIf(!canChown)(
  "refuses a foreign symlinked directory in the path as named (sticky tmp/evil -> bin)",
  async () => {
    const r = base();
    const path = executable(join(r, "user-bin"));
    const tmp = join(r, "tmp");
    mkdirSync(tmp);
    chmodSync(tmp, 0o1777);
    const evil = join(tmp, "evil");
    symlinkSync(join(r, "user-bin"), evil);
    lchownSync(evil, 2000, 2000);
    expect(path).toBeTruthy();
    expect(await binarySafetyProblem(join(evil, "codex"), root)).toBe(
      "it is owned by another user",
    );
  },
);

it.skipIf(!canChown)(
  "refuses a foreign directory holding a symlink to the user's bin (foreign/bin -> bin)",
  async () => {
    const r = base();
    executable(join(r, "real"));
    const foreign = join(r, "foreign");
    mkdirSync(foreign);
    chownSync(foreign, 2000, 2000);
    const bin = join(foreign, "bin");
    symlinkSync(join(r, "real"), bin);
    lchownSync(bin, 2000, 2000);
    expect(await binarySafetyProblem(join(bin, "codex"), root)).toMatch(
      /owned by another user/,
    );
    // Even with an own-owned link, the foreign holding directory is refused.
    lchownSync(bin, 0, 0);
    expect(await binarySafetyProblem(join(bin, "codex"), root)).toMatch(
      /directory on its path .* is owned by another user/,
    );
  },
);

it.skipIf(!canChown)(
  "inspects directories reached through a trusted symlink target and its ancestors",
  async () => {
    const r = base();
    const hole = join(r, "hole");
    const path = executable(join(hole, "inner"));
    chmodSync(hole, 0o777);
    const link = join(r, "alias");
    symlinkSync(join(hole, "inner"), link);
    expect(await binarySafetyProblem(join(link, "codex"), root)).toMatch(
      /world-writable without the sticky bit/,
    );
    expect(path).toBeTruthy();
  },
);

it("refuses a symlink loop without hanging", async () => {
  const r = base();
  symlinkSync(join(r, "b"), join(r, "a"));
  symlinkSync(join(r, "a"), join(r, "b"));
  expect(await binarySafetyProblem(join(r, "a", "codex"), root)).toMatch(
    /too long or loops/,
  );
});

it("follows .. the way the kernel does (through a symlinked directory)", async () => {
  const r = base();
  const real = join(r, "real");
  mkdirSync(join(real, "deep"), { recursive: true });
  const path = executable(join(real, "bin"));
  symlinkSync(join(real, "deep"), join(r, "to-deep"));
  // The link's target to-deep/../bin/codex is real/bin/codex, not r/bin/codex.
  symlinkSync("to-deep/../bin/codex", join(r, "lnk"));
  expect(await binarySafetyProblem(join(r, "lnk"), root)).toBeNull();
  chmodSync(real, 0o777);
  expect(await binarySafetyProblem(join(r, "lnk"), root)).toMatch(
    /world-writable/,
  );
  expect(path).toBeTruthy();
});

it.skipIf(!canChown)(
  "group-writable user:admin 775 is accepted only when the user is in admin (Homebrew)",
  async () => {
    const dir = join(base(), "homebrew-bin");
    const path = executable(dir);
    chownSync(dir, 0, 80);
    chmodSync(dir, 0o775);
    expect(await binarySafetyProblem(path, asUser(501, 20, 20, 80))).toBeNull();
    expect(await binarySafetyProblem(path, asUser(501, 20, 20))).toMatch(
      /group-writable by a group the current user is not in/,
    );
  },
);

it.skipIf(!canChown)(
  "group-writable root:staff 2775 is accepted only by membership, as a directory and as an ancestor",
  async () => {
    const outer = join(base(), "local");
    const path = executable(join(outer, "bin"));
    chownSync(outer, 0, 50);
    chmodSync(outer, 0o2775);
    expect(await binarySafetyProblem(path, asUser(1000, 1000, 50))).toBeNull();
    expect(await binarySafetyProblem(path, asUser(1000, 1000))).toMatch(
      /directory on its path .* group-writable by a group the current user is not in/,
    );
    const direct = join(base(), "usr-local-bin");
    const file = executable(direct);
    chownSync(direct, 0, 50);
    chmodSync(direct, 0o2775);
    expect(await binarySafetyProblem(file, asUser(1000, 1000, 50))).toBeNull();
    expect(await binarySafetyProblem(file, asUser(1000, 1000))).toMatch(
      /group-writable/,
    );
  },
);

it("defaults the identity to the process's own", async () => {
  const path = executable(join(base(), "bin"));
  expect(await binarySafetyProblem(path)).toBeNull();
});

it("refuses a directory as the final component", async () => {
  const dir = base();
  executable(join(dir, "bin"));
  expect(await binarySafetyProblem(join(dir, "bin"))).toMatch(
    /not a regular file/,
  );
});

it("refuses paths under /proc", async () => {
  expect(await binarySafetyProblem("/proc/self/exe")).toMatch(/\/proc/);
});
