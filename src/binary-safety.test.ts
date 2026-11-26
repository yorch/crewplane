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
import {
  binarySafetyProblem,
  type Entry,
  type Identity,
  type SafetyFs,
} from "./binary-safety.ts";

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
  // Directories inherit their parent's group on some systems (macOS /tmp is
  // wheel), so state the group explicitly: ours, then group-writable.
  chownSync(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
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
// The identity of whoever runs the tests: the directories these tests create
// are owned by it, which is root locally but an ordinary user in CI.
const me: Identity = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  groups: process.getgroups?.() ?? [],
};

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
  expect(await binarySafetyProblem(join(r, "a", "codex"), me)).toMatch(
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
  expect(await binarySafetyProblem(join(r, "lnk"), me)).toBeNull();
  chmodSync(real, 0o777);
  expect(await binarySafetyProblem(join(r, "lnk"), me)).toMatch(
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

// Synthetic layer: every rule of docs/USAGE.md "Binary safety checks" against
// invented lstat results. No chown, no root, no real files, so each case runs
// identically unprivileged, as root, on Linux and on macOS.
type Node = Entry & { target?: string };
const dir = (uid: number, gid: number, mode: number): Node => ({
  kind: "directory",
  uid,
  gid,
  mode,
});
const file = (uid: number, gid: number, mode = 0o755): Node => ({
  kind: "file",
  uid,
  gid,
  mode,
});
const link = (target: string, uid = 1000, gid = 1000): Node => ({
  kind: "symlink",
  uid,
  gid,
  mode: 0o777,
  target,
});
const tree = (nodes: Record<string, Node>, unreadable: string[] = []) => {
  const calls: string[] = [];
  const fs: SafetyFs = {
    async lstat(path) {
      calls.push(path);
      const node = nodes[path];
      if (!node) throw new Error("ENOENT");
      return node;
    },
    async readlink(path) {
      const node = nodes[path];
      if (!node?.target || unreadable.includes(path)) throw new Error("EINVAL");
      return node.target;
    },
  };
  return { fs, calls };
};
const alice = asUser(1000, 1000);
// A conventional private layout: root-owned / and /home, alice's own tree.
const base0 = (): Record<string, Node> => ({
  "/": dir(0, 0, 0o755),
  "/home": dir(0, 0, 0o755),
  "/home/alice": dir(1000, 1000, 0o755),
  "/home/alice/bin": dir(1000, 1000, 0o755),
  "/home/alice/bin/codex": file(1000, 1000),
});
const check = (
  nodes: Record<string, Node>,
  path: string,
  who: Identity = alice,
) => binarySafetyProblem(path, who, tree(nodes).fs);

it("synthetic: accepts a private layout and inspects only lstat/readlink", async () => {
  const { fs, calls } = tree(base0());
  expect(
    await binarySafetyProblem("/home/alice/bin/codex", alice, fs),
  ).toBeNull();
  expect([...new Set(calls)]).toEqual([
    "/",
    "/home",
    "/home/alice",
    "/home/alice/bin",
    "/home/alice/bin/codex",
  ]);
});

it("synthetic: refuses a file owned by another user in a directory the user owns", async () => {
  const n = base0();
  n["/home/alice/bin/codex"] = file(2000, 2000);
  expect(await check(n, "/home/alice/bin/codex")).toBe(
    "it is owned by another user",
  );
});

it("synthetic: accepts a root-owned file and refuses group- or world-writable files", async () => {
  const n = base0();
  n["/home/alice/bin/codex"] = file(0, 0, 0o755);
  expect(await check(n, "/home/alice/bin/codex")).toBeNull();
  n["/home/alice/bin/codex"] = file(1000, 1000, 0o757);
  expect(await check(n, "/home/alice/bin/codex")).toBe(
    "it is group- or world-writable",
  );
  n["/home/alice/bin/codex"] = file(1000, 1000, 0o777);
  expect(await check(n, "/home/alice/bin/codex")).toBe(
    "it is group- or world-writable",
  );
});

it("synthetic: a group-writable file is refused only when its group is not the user's", async () => {
  const n = base0();
  // umask 002 installs (npm, cargo): 0775 alice:alice is the user's own group.
  n["/home/alice/bin/codex"] = file(1000, 1000, 0o775);
  expect(await check(n, "/home/alice/bin/codex")).toBeNull();
  // A supplementary group counts too.
  n["/home/alice/bin/codex"] = file(1000, 80, 0o775);
  expect(
    await check(n, "/home/alice/bin/codex", asUser(1000, 1000, 80)),
  ).toBeNull();
  // A foreign group does not, for the user's own file or a root-owned one.
  for (const owner of [1000, 0]) {
    n["/home/alice/bin/codex"] = file(owner, 4242, 0o775);
    expect(await check(n, "/home/alice/bin/codex")).toBe(
      "it is group- or world-writable",
    );
  }
  // World-writable stays refused even in the user's own group.
  n["/home/alice/bin/codex"] = file(1000, 1000, 0o772);
  expect(await check(n, "/home/alice/bin/codex")).toBe(
    "it is group- or world-writable",
  );
  // A group-writable file with a foreign group that has no group bit is fine.
  n["/home/alice/bin/codex"] = file(1000, 4242, 0o755);
  expect(await check(n, "/home/alice/bin/codex")).toBeNull();
});

it("synthetic: a sticky group-writable directory is judged by ownership only (multi-user Nix /nix/store 1775 root:nixbld)", async () => {
  const n: Record<string, Node> = {
    "/": dir(0, 0, 0o755),
    "/nix": dir(0, 0, 0o755),
    "/nix/store": dir(0, 30000, 0o1775),
    "/nix/store/abc-codex": dir(0, 0, 0o555),
    "/nix/store/abc-codex/bin": dir(0, 0, 0o555),
    "/nix/store/abc-codex/bin/codex": file(0, 0, 0o555),
    "/home": dir(0, 0, 0o755),
    "/home/alice": dir(1000, 1000, 0o755),
    "/home/alice/.nix-profile": link("/nix/store/abc-codex"),
  };
  expect(
    await check(n, "/home/alice/.nix-profile/bin/codex", asUser(1000, 1000)),
  ).toBeNull();
  // The same sticky directory owned by a foreign user is still refused.
  n["/nix/store"] = dir(2000, 30000, 0o1775);
  expect(
    await check(n, "/home/alice/.nix-profile/bin/codex", asUser(1000, 1000)),
  ).toMatch(/directory on its path .*store.* is owned by another user/);
  // Without the sticky bit the group rule still applies to a non-member.
  n["/nix/store"] = dir(0, 30000, 0o2775);
  expect(
    await check(n, "/home/alice/.nix-profile/bin/codex", asUser(1000, 1000)),
  ).toMatch(/group-writable by a group the current user is not in/);
  // ...and a member passes.
  expect(
    await check(
      n,
      "/home/alice/.nix-profile/bin/codex",
      asUser(1000, 1000, 30000),
    ),
  ).toBeNull();
});

it("synthetic: refuses a foreign-owned file inside a sticky world-writable directory", async () => {
  const n: Record<string, Node> = {
    "/": dir(0, 0, 0o755),
    "/tmp": dir(0, 0, 0o1777),
    "/tmp/x": dir(1000, 1000, 0o1777),
    "/tmp/x/codex": file(2000, 2000),
  };
  expect(await check(n, "/tmp/x/codex")).toBe("it is owned by another user");
  n["/tmp/x/codex"] = file(1000, 1000);
  expect(await check(n, "/tmp/x/codex")).toBeNull();
});

it("synthetic: sticky world-writable directories are judged by ownership only", async () => {
  const n = base0();
  n["/home/alice/bin"] = dir(1000, 4242, 0o1777);
  // Group rule is not applied to an open sticky directory: gid 4242 is not ours.
  expect(await check(n, "/home/alice/bin/codex")).toBeNull();
  n["/home/alice/bin"] = dir(2000, 1000, 0o1777);
  expect(await check(n, "/home/alice/bin/codex")).toMatch(
    /directory on its path .* is owned by another user/,
  );
});

it("synthetic: refuses a world-writable directory without sticky, as holder and as ancestor", async () => {
  const n = base0();
  n["/home/alice/bin"] = dir(1000, 1000, 0o777);
  expect(await check(n, "/home/alice/bin/codex")).toMatch(
    /world-writable without the sticky bit/,
  );
  n["/home/alice/bin"] = dir(1000, 1000, 0o755);
  n["/home/alice"] = dir(1000, 1000, 0o702);
  expect(await check(n, "/home/alice/bin/codex")).toMatch(
    /directory on its path .*alice.* is world-writable without the sticky bit/,
  );
});

it("synthetic: refuses a group-writable directory whose group is not the user's (2775 root:other)", async () => {
  const n = base0();
  n["/home/alice/bin"] = dir(0, 777, 0o2775);
  expect(await check(n, "/home/alice/bin/codex")).toMatch(
    /group-writable by a group the current user is not in/,
  );
});

it("synthetic: group-writable directories are accepted by membership (Homebrew user:admin 775, root:staff 2775)", async () => {
  const n = base0();
  for (const key of ["/home/alice", "/home/alice/bin"])
    n[key] = dir(0, 80, key.endsWith("bin") ? 0o775 : 0o755);
  n["/home/alice/bin/codex"] = file(0, 0);
  expect(
    await check(n, "/home/alice/bin/codex", asUser(501, 20, 20, 80)),
  ).toBeNull();
  // The same layout owned for a user outside admin.
  expect(await check(n, "/home/alice/bin/codex", asUser(501, 20, 20))).toMatch(
    /group-writable by a group the current user is not in/,
  );
  // As an ancestor rather than the holder.
  const m: Record<string, Node> = {
    "/": dir(0, 0, 0o755),
    "/usr": dir(0, 0, 0o755),
    "/usr/local": dir(0, 50, 0o2775),
    "/usr/local/bin": dir(0, 0, 0o755),
    "/usr/local/bin/codex": file(0, 0),
  };
  expect(
    await check(m, "/usr/local/bin/codex", asUser(1000, 1000, 50)),
  ).toBeNull();
  expect(await check(m, "/usr/local/bin/codex", asUser(1000, 1000))).toMatch(
    /directory on its path .*local.* group-writable by a group the current user is not in/,
  );
  // Primary group counts as membership.
  expect(await check(m, "/usr/local/bin/codex", asUser(1000, 50))).toBeNull();
});

it("synthetic: refuses a foreign-owned ancestor and a foreign-owned symlink hop", async () => {
  const n = base0();
  n["/home/alice"] = dir(2000, 2000, 0o755);
  expect(await check(n, "/home/alice/bin/codex")).toMatch(
    /directory on its path .* is owned by another user/,
  );
  const m = base0();
  m["/home/alice/link"] = link("/home/alice/bin/codex", 2000, 2000);
  expect(await check(m, "/home/alice/link")).toBe(
    "it is owned by another user",
  );
  // A root-owned link is as trusted as our own.
  m["/home/alice/link"] = link("/home/alice/bin/codex", 0, 0);
  expect(await check(m, "/home/alice/link")).toBeNull();
});

it("synthetic: refuses a foreign symlinked directory in the path as named (sticky tmp/evil -> bin)", async () => {
  const n = base0();
  n["/tmp"] = dir(0, 0, 0o1777);
  n["/tmp/evil"] = link("/home/alice/bin", 2000, 2000);
  expect(await check(n, "/tmp/evil/codex", root)).toBe(
    "it is owned by another user",
  );
});

it("synthetic: refuses a foreign directory holding a symlink to the user's bin", async () => {
  const n = base0();
  n["/srv"] = dir(2000, 2000, 0o755);
  n["/srv/bin"] = link("/home/alice/bin", 0, 0);
  // Even with a root-owned link, the foreign holding directory is refused.
  expect(await check(n, "/srv/bin/codex", root)).toMatch(
    /directory on its path .*srv.* is owned by another user/,
  );
  n["/srv"] = dir(0, 0, 0o755);
  n["/srv/bin"] = link("/home/alice/bin", 2000, 2000);
  expect(await check(n, "/srv/bin/codex", root)).toBe(
    "it is owned by another user",
  );
});

it("synthetic: inspects directories reached through a trusted symlink target and its ancestors", async () => {
  const n = base0();
  n["/home/alice/alias"] = link("/home/alice/hole/inner");
  n["/home/alice/hole"] = dir(1000, 1000, 0o777);
  n["/home/alice/hole/inner"] = dir(1000, 1000, 0o755);
  n["/home/alice/hole/inner/codex"] = file(1000, 1000);
  expect(await check(n, "/home/alice/alias/codex")).toMatch(
    /world-writable without the sticky bit/,
  );
  n["/home/alice/hole"] = dir(1000, 1000, 0o755);
  expect(await check(n, "/home/alice/alias/codex")).toBeNull();
});

it("synthetic: a world-writable directory elsewhere in a link chain is refused", async () => {
  const n = base0();
  n["/home/alice/open"] = dir(1000, 1000, 0o777);
  n["/home/alice/open/middle"] = link("/home/alice/bin/codex");
  n["/home/alice/first"] = link("/home/alice/open/middle");
  expect(await check(n, "/home/alice/first")).toMatch(
    /world-writable without the sticky bit/,
  );
});

it("synthetic: refuses loops and chains over the 40-hop limit, accepts exactly 40", async () => {
  const n = base0();
  n["/home/alice/a"] = link("/home/alice/b");
  n["/home/alice/b"] = link("/home/alice/a");
  expect(await check(n, "/home/alice/a")).toMatch(/too long or loops/);
  const chain = (links: number) => {
    const m = base0();
    for (let i = 1; i <= links; i++)
      m[`/home/alice/l${i}`] = link(
        i === links ? "/home/alice/bin/codex" : `/home/alice/l${i + 1}`,
      );
    return m;
  };
  expect(await check(chain(40), "/home/alice/l1")).toBeNull();
  expect(await check(chain(41), "/home/alice/l1")).toMatch(/too long or loops/);
});

it("synthetic: resolves .. and relative targets the way the kernel does", async () => {
  const n = base0();
  n["/home/alice/real"] = dir(1000, 1000, 0o755);
  n["/home/alice/real/deep"] = dir(1000, 1000, 0o755);
  n["/home/alice/real/bin"] = dir(1000, 1000, 0o755);
  n["/home/alice/real/bin/codex"] = file(1000, 1000);
  n["/home/alice/to-deep"] = link("/home/alice/real/deep");
  // to-deep/.. is real (the link target's parent), not /home/alice.
  n["/home/alice/lnk"] = link("to-deep/../bin/codex");
  expect(await check(n, "/home/alice/lnk")).toBeNull();
  n["/home/alice/real"] = dir(1000, 1000, 0o777);
  expect(await check(n, "/home/alice/lnk")).toMatch(/world-writable/);
  // A literal .. in the named path also moves up one directory.
  expect(await check(base0(), "/home/alice/bin/../bin/codex")).toBeNull();
});

it("synthetic: refuses anything under /proc without inspecting it", async () => {
  const { fs, calls } = tree({ "/": dir(0, 0, 0o755) });
  expect(await binarySafetyProblem("/proc/self/exe", alice, fs)).toMatch(
    /\/proc/,
  );
  expect(calls).toEqual(["/", "/proc"].slice(0, 1));
  const n = base0();
  n["/home/alice/p"] = link("/proc/self/exe");
  expect(await check(n, "/home/alice/p")).toMatch(/\/proc/);
});

it("synthetic: refuses a missing component, an unreadable link and a non-file or non-directory", async () => {
  expect(await check(base0(), "/home/alice/bin/missing")).toBe(
    "it cannot be inspected",
  );
  expect(await check({ "/home": dir(0, 0, 0o755) }, "/home/x")).toBe(
    "its directory cannot be inspected",
  );
  const n = base0();
  n["/home/alice/l"] = link("/home/alice/bin/codex");
  const { fs } = tree(n, ["/home/alice/l"]);
  expect(await binarySafetyProblem("/home/alice/l", alice, fs)).toBe(
    "it cannot be inspected",
  );
  n["/home/alice/bin/codex"] = { ...file(1000, 1000), kind: "other" };
  expect(await check(n, "/home/alice/bin/codex")).toBe(
    "it is not a regular file",
  );
  n["/home/alice/bin/codex"] = dir(1000, 1000, 0o755);
  expect(await check(n, "/home/alice/bin/codex")).toBe(
    "it is not a regular file",
  );
  n["/home/alice/bin"] = file(1000, 1000);
  expect(await check(n, "/home/alice/bin/codex")).toBe(
    "its directory cannot be inspected",
  );
});

it("synthetic: without a uid (Windows) ownership and group rules are skipped but world-writable still refuses", async () => {
  const none: Identity = { uid: null, gid: null, groups: [] };
  const n = base0();
  n["/home/alice/bin"] = dir(2000, 2000, 0o775);
  n["/home/alice/bin/codex"] = file(3000, 3000);
  expect(await check(n, "/home/alice/bin/codex", none)).toBeNull();
  n["/home/alice/bin"] = dir(2000, 2000, 0o777);
  expect(await check(n, "/home/alice/bin/codex", none)).toMatch(
    /world-writable without the sticky bit/,
  );
});
