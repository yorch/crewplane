import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { controlDirectory } from "./control.ts";
import {
  legacyRefusal,
  migrateControl,
  resolveControlTarget,
} from "./migrate.ts";

const scratch: string[] = [];
const deadPid = 2 ** 22 + 12345;
function project() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-migrate-")));
  scratch.push(base);
  const root = join(base, "project");
  const store = join(root, ".crewplane-state");
  mkdirSync(store, { recursive: true });
  const control = controlDirectory(root, {
    CREWPLANE_STATE_DIR: join(base, "state"),
  });
  const legacy = join(store, "supervisor");
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  };
  const seed = (state: Record<string, unknown> = { running: false }) => {
    mkdirSync(legacy, { recursive: true, mode: 0o700 });
    write(join(legacy, "state.json"), JSON.stringify(state));
    write(join(legacy, "config.json"), JSON.stringify({ lanes: {} }));
    write(join(legacy, "desired.json"), '{"desiredRunning":false}');
    write(join(legacy, "runs/coordinator/r1.result.json"), "x".repeat(5000));
    write(
      join(legacy, "commands/11111111-1111-4111-8111-111111111111.json"),
      '{"action":"resume"}',
    );
  };
  return { base, root, store, control, legacy, seed, write };
}
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const tree = (path: string, prefix = ""): string[] =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? [
          `${prefix}${entry.name}/`,
          ...tree(join(path, entry.name), `${prefix}${entry.name}/`),
        ]
      : [`${prefix}${entry.name}`],
  );

it("moves the whole legacy directory by rename and is idempotent", async () => {
  const p = project();
  p.seed();
  const report = await migrateControl({ store: p.store, control: p.control });
  expect(report).toMatchObject({
    status: "migrated",
    from: p.legacy,
    to: p.control,
    method: "rename",
    files: 5,
    quarantinedCommands: 1,
    leftover: null,
  });
  expect(existsSync(p.legacy)).toBe(false);
  expect(statSync(p.control).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(p.control, "desired.json"), "utf8")).toBe(
    '{"desiredRunning":false}',
  );
  expect(
    readFileSync(join(p.control, "runs/coordinator/r1.result.json"), "utf8"),
  ).toHaveLength(5000);
  // Unauthenticated pending commands are parked, never re-armed.
  expect(existsSync(join(p.control, "commands"))).toBe(false);
  expect(readdirSync(join(p.control, "quarantined-commands"))).toEqual([
    "11111111-1111-4111-8111-111111111111.json",
  ]);
  const again = await migrateControl({ store: p.store, control: p.control });
  expect(again.status).toBe("nothing-to-migrate");
  expect(readFileSync(join(p.control, "state.json"), "utf8")).toBe(
    '{"running":false}',
  );
});

it("dry-run reports the plan and changes nothing", async () => {
  const p = project();
  p.seed();
  const before = tree(p.legacy);
  const report = await migrateControl({
    store: p.store,
    control: p.control,
    dryRun: true,
  });
  expect(report).toMatchObject({ status: "dry-run", method: null, files: 5 });
  expect(tree(p.legacy)).toEqual(before);
  expect(existsSync(p.control)).toBe(false);
  expect(existsSync(join(p.base, "state"))).toBe(false);
});

it("refuses while a lease, heartbeat or recorded child is live, and never touches lease files", async () => {
  const live: Array<[string, Record<string, unknown>, string?]> = [
    ["live lease", { running: false }, "lease"],
    ["live supervisor pid", { running: true, pid: process.pid }],
    [
      "fresh heartbeat",
      { running: true, pid: deadPid, checkedAt: new Date().toISOString() },
    ],
    [
      "live child",
      {
        running: true,
        pid: deadPid,
        checkedAt: "2000-01-01T00:00:00.000Z",
        records: { a: { status: "running", pid: process.pid } },
      },
    ],
  ];
  for (const [label, state, lease] of live) {
    const p = project();
    p.seed(state);
    if (lease)
      p.write(
        join(p.legacy, "watcher.lock"),
        JSON.stringify({ pid: process.pid, token: "t" }),
      );
    const before = tree(p.legacy);
    await expect(
      migrateControl({ store: p.store, control: p.control }),
      label,
    ).rejects.toThrow("Refusing to migrate");
    await expect(
      migrateControl({ store: p.store, control: p.control, dryRun: true }),
      `${label} (dry-run)`,
    ).rejects.toThrow("Refusing to migrate");
    expect(tree(p.legacy), label).toEqual(before);
    expect(existsSync(p.control), label).toBe(false);
  }
});

it("migrates a crashed supervisor's state and keeps its dead lease file intact", async () => {
  const p = project();
  p.seed({
    running: true,
    pid: deadPid,
    checkedAt: "2000-01-01T00:00:00.000Z",
    records: {},
  });
  p.write(
    join(p.legacy, "watcher.lock"),
    JSON.stringify({ pid: deadPid, token: "dead" }),
  );
  await migrateControl({ store: p.store, control: p.control });
  expect(readFileSync(join(p.control, "watcher.lock"), "utf8")).toContain(
    "dead",
  );
});

it("falls back to verified copy across filesystems and leaves one populated copy", async () => {
  const p = project();
  p.seed();
  p.write(join(p.legacy, "pi-sessions/s1.jsonl"), "line\n".repeat(1000));
  const expected = tree(p.legacy).filter((e) => !e.startsWith("commands"));
  let attempts = 0;
  const report = await migrateControl({
    store: p.store,
    control: p.control,
    move: {
      rename: (async (from: string, to: string) => {
        if (attempts++ === 0)
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        return rename(from, to);
      }) as typeof rename,
    },
  });
  expect(report.method).toBe("copy");
  expect(report.leftover).toBeNull();
  expect(existsSync(p.legacy)).toBe(false);
  expect(
    readdirSync(join(p.control, "..")).filter((e) => e.includes("migrat")),
  ).toEqual([]);
  expect(
    readdirSync(join(p.store)).filter((e) => e.startsWith("supervisor")),
  ).toEqual([]);
  expect(tree(p.control).filter((e) => !e.startsWith("quarantined"))).toEqual(
    expected,
  );
  expect(readFileSync(join(p.control, "pi-sessions/s1.jsonl"), "utf8")).toBe(
    "line\n".repeat(1000),
  );
  expect(statSync(join(p.control, "state.json")).mode & 0o077).toBe(0);
  expect(statSync(p.control).mode & 0o777).toBe(0o700);
});

it("refuses a non-empty destination, a symlinked source and unexpected entry types", async () => {
  const busy = project();
  busy.seed();
  busy.write(join(busy.control, "state.json"), "{}");
  await expect(
    migrateControl({ store: busy.store, control: busy.control }),
  ).rejects.toThrow("already has content");
  expect(existsSync(join(busy.legacy, "state.json"))).toBe(true);

  const linked = project();
  const elsewhere = join(linked.base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, linked.legacy);
  await expect(
    migrateControl({ store: linked.store, control: linked.control }),
  ).rejects.toThrow("not a plain directory");

  const odd = project();
  odd.seed();
  symlinkSync("/etc/passwd", join(odd.legacy, "runs/escape"));
  await expect(
    migrateControl({ store: odd.store, control: odd.control }),
  ).rejects.toThrow("only regular files and directories");
  expect(existsSync(odd.control)).toBe(false);

  // An existing but empty destination is acceptable.
  const empty = project();
  empty.seed();
  mkdirSync(empty.control, { recursive: true, mode: 0o700 });
  expect(
    (await migrateControl({ store: empty.store, control: empty.control }))
      .status,
  ).toBe("migrated");
});

it("moves the watchdog directory with the control state", async () => {
  const p = project();
  p.seed();
  const dog = join(p.store, "watchdog");
  p.write(join(dog, "latest.json"), "{}");
  const report = await migrateControl({ store: p.store, control: p.control });
  expect(report.watchdog).toBe(true);
  expect(existsSync(dog)).toBe(false);
  expect(existsSync(join(p.control, "watchdog/latest.json"))).toBe(true);
  // A live watchdog lease blocks the move.
  const live = project();
  live.seed();
  live.write(
    join(live.store, "watchdog/lease/owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, identity: "x" }),
  );
  await expect(
    migrateControl({ store: live.store, control: live.control }),
  ).rejects.toThrow("watchdog lease");
});

it("fails closed on a legacy layout except for halting verbs against a live owner", () => {
  const none = project();
  expect(resolveControlTarget(none.store, none.control, "status")).toEqual({
    directory: none.control,
  });

  const dead = project();
  dead.seed();
  for (const command of [
    "status",
    "start",
    "stop",
    "pause",
    "configure",
    "doctor",
    "agents",
    "dashboard",
  ])
    expect(() =>
      resolveControlTarget(dead.store, dead.control, command),
    ).toThrow(legacyRefusal);

  const old = project();
  old.seed({ running: true, pid: process.pid });
  for (const command of ["status", "stop", "pause", "cancel"]) {
    const target = resolveControlTarget(old.store, old.control, command);
    expect(target.directory).toBe(old.legacy);
    expect(target.warning).toContain("older-release supervisor");
  }
  for (const command of [
    "resume",
    "resolve",
    "retry",
    "nudge",
    "rollout",
    "start",
    "configure",
  ])
    expect(() => resolveControlTarget(old.store, old.control, command)).toThrow(
      legacyRefusal,
    );

  // A planted legacy directory must not stop an operator halting the real one.
  const planted = project();
  planted.seed();
  planted.write(
    join(planted.control, "state.json"),
    JSON.stringify({ running: true, pid: process.pid }),
  );
  expect(
    resolveControlTarget(planted.store, planted.control, "stop"),
  ).toMatchObject({
    directory: planted.control,
  });
  expect(() =>
    resolveControlTarget(planted.store, planted.control, "resume"),
  ).toThrow(legacyRefusal);
});

it("states one stable refusal line that names the migrate command", () => {
  expect(legacyRefusal).not.toContain("\n");
  expect(legacyRefusal).toContain("`crewplane migrate`");
});
