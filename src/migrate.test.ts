import {
  chmodSync,
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
import { copyFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { controlDirectory } from "./control.ts";
import {
  legacyRefusal,
  type MigrateOptions,
  migrateControl,
  type Owner,
  processOwner,
  resolveControlTarget,
} from "./migrate.ts";

const scratch: string[] = [];
const deadPid = 2 ** 22 + 12345;
const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const validState = (extra: Record<string, unknown> = {}) => ({
  version: 2,
  running: false,
  checkedAt: "2000-01-01T00:00:00.000Z",
  pid: deadPid,
  draining: false,
  held: [],
  commands: [],
  records: {},
  notices: {},
  ...extra,
});
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
  const binary = join(base, "harness");
  writeFileSync(binary, "#!/bin/sh\n", { mode: 0o700 });
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o644 });
  };
  const config = (extra: Record<string, unknown> = {}) => ({
    version: 1,
    root,
    binary,
    allowedTasks: ["T-1"],
    maxParallel: 2,
    intervalSeconds: 5,
    maxRunMinutes: 5,
    maxRunsPerHour: 5,
    confirmedStoppedAt: new Date().toISOString(),
    lanes: { builder: { enabled: true } },
    ...extra,
  });
  const seed = (
    state: Record<string, unknown> = validState(),
    commands = true,
  ) => {
    mkdirSync(legacy, { recursive: true, mode: 0o700 });
    write(join(legacy, "state.json"), JSON.stringify(state));
    write(join(legacy, "config.json"), JSON.stringify(config()));
    write(join(legacy, "desired.json"), '{"desiredRunning":false}');
    write(join(legacy, "runs/builder/r1.result.json"), "x".repeat(5000));
    if (commands)
      write(
        join(legacy, `commands/${uuid(1)}.json`),
        JSON.stringify({
          action: "pause",
          all: true,
          at: new Date().toISOString(),
        }),
      );
  };
  const migrate = (extra: Partial<MigrateOptions> = {}) =>
    migrateControl({
      store,
      control,
      root,
      acceptConfig: true,
      identity: { primaryRoot: root },
      ...extra,
    });
  return { base, root, store, control, legacy, seed, write, migrate, config };
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
const mode = (path: string) => statSync(path).mode & 0o777;
/** Owner oracle: the given PIDs belong to somebody else. */
const foreign =
  (...pids: number[]): Owner =>
  (pid) =>
    pids.includes(pid) ? "foreign" : processOwner(pid);

it("moves the legacy directory by rename, privatizes it, binds it and is idempotent", async () => {
  const p = project();
  p.seed();
  const report = await p.migrate();
  expect(report).toMatchObject({
    status: "migrated",
    from: p.legacy,
    to: p.control,
    method: "rename",
    leftover: null,
    configAccepted: true,
  });
  expect(existsSync(p.legacy)).toBe(false);
  expect(readFileSync(join(p.control, "desired.json"), "utf8")).toBe(
    '{"desiredRunning":false}',
  );
  // Whatever the old modes were, everything migrated is private.
  for (const entry of tree(p.control))
    expect(mode(join(p.control, entry)) & 0o077, entry).toBe(0);
  expect(mode(p.control)).toBe(0o700);
  expect(existsSync(join(p.control, "identity.json"))).toBe(true);
  expect(existsSync(join(p.store, "control-binding.json"))).toBe(true);
  expect((await p.migrate()).status).toBe("nothing-to-migrate");
});

it("dry-run reports the plan and the configuration and changes nothing", async () => {
  const p = project();
  p.seed();
  const before = tree(p.legacy);
  const report = await p.migrate({ dryRun: true, acceptConfig: false });
  expect(report).toMatchObject({
    status: "dry-run",
    method: null,
    configAccepted: false,
  });
  expect(report.config).toMatchObject({
    allowedTasks: ["T-1"],
    lanes: { builder: { enabled: true, harness: "codex" } },
  });
  expect(tree(p.legacy)).toEqual(before);
  expect(existsSync(join(p.base, "state"))).toBe(false);
});

it("shows a planted configuration and adopts it only with explicit acceptance", async () => {
  const p = project();
  p.seed();
  p.write(
    join(p.legacy, "config.json"),
    JSON.stringify(
      p.config({
        allowedTasks: ["EVIL-1"],
        lanes: { attacker: { enabled: true } },
      }),
    ),
  );
  const refusal = await p
    .migrate({ acceptConfig: false })
    .catch((error: Error) => error.message);
  expect(refusal).toContain("--accept-config true");
  expect(refusal).toContain("EVIL-1");
  expect(refusal).toContain("attacker");
  expect(refusal).toContain(join(p.base, "harness"));
  expect(existsSync(join(p.legacy, "config.json"))).toBe(true);
  expect(existsSync(p.control)).toBe(false);
  expect((await p.migrate()).status).toBe("migrated");
});

it("refuses an invalid, foreign-root or structurally broken legacy payload", async () => {
  const bad: Array<[string, (p: ReturnType<typeof project>) => void, string]> =
    [
      [
        "invalid config",
        (p) => p.write(join(p.legacy, "config.json"), '{"version":1}'),
        "failed validation",
      ],
      [
        "non-JSON config",
        (p) => p.write(join(p.legacy, "config.json"), "{nope"),
        "failed validation",
      ],
      [
        "foreign root",
        (p) =>
          p.write(
            join(p.legacy, "config.json"),
            JSON.stringify(p.config({ root: "/somewhere/else" })),
          ),
        "another project root",
      ],
      [
        "invalid state",
        (p) => p.write(join(p.legacy, "state.json"), '{"running":true}'),
        "state.json failed structural validation",
      ],
      [
        "invalid desired",
        (p) => p.write(join(p.legacy, "desired.json"), '{"desiredRunning":1}'),
        "desired.json failed structural validation",
      ],
    ];
  for (const [label, corrupt, message] of bad) {
    const p = project();
    p.seed();
    corrupt(p);
    await expect(p.migrate(), label).rejects.toThrow(message);
    expect(existsSync(p.control), label).toBe(false);
    expect(existsSync(p.legacy), label).toBe(true);
  }
});

it("adopts crash-recovery state structurally and keeps its dead lease file", async () => {
  const p = project();
  const records = {
    "builder:T-1": {
      key: "builder:T-1",
      lane: "builder",
      task: "T-1",
      cwd: p.root,
      status: "running",
      pid: deadPid,
      processGroupId: deadPid,
      seen: [],
      runs: [],
      noProgress: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
  };
  p.seed(validState({ running: true, records }));
  p.write(
    join(p.legacy, "watcher.lock"),
    JSON.stringify({ pid: deadPid, token: "dead" }),
  );
  await p.migrate();
  const adopted = JSON.parse(
    readFileSync(join(p.control, "state.json"), "utf8"),
  );
  expect(adopted.records["builder:T-1"].processGroupId).toBe(deadPid);
  expect(readFileSync(join(p.control, "watcher.lock"), "utf8")).toContain(
    "dead",
  );
});

it("re-arms narrowing commands and quarantines widening, hostile or undecodable ones", async () => {
  const p = project();
  p.seed(validState(), false);
  const at = new Date().toISOString();
  const put = (n: number, value: unknown) =>
    p.write(join(p.legacy, `commands/${uuid(n)}.json`), JSON.stringify(value));
  put(1, { action: "pause", all: true, at });
  put(2, { action: "stop", at });
  put(3, { action: "cancel", all: true, at });
  put(4, { action: "resume", all: true, at });
  put(5, { action: "retry", lane: "builder", at });
  put(6, {
    action: "resolve",
    lane: "builder",
    pauseId: uuid(7),
    resolution: "approve",
    text: "ok",
    at,
  });
  put(7, { action: "rollout", at });
  put(8, { action: "nudge", lane: "builder", text: "x", at });
  put(9, { action: "stop", cancelActive: true, at });
  put(10, { action: "delete-everything" });
  p.write(join(p.legacy, "commands/not-a-uuid.json"), "{}");
  // A previous interrupted attempt left quarantine content behind.
  p.write(join(p.legacy, `quarantined-commands/${uuid(5)}.json`), "old");
  const dry = await p.migrate({ dryRun: true });
  expect(dry.rearmedCommands.map((c) => c.action).sort()).toEqual([
    "cancel",
    "pause",
    "stop",
  ]);
  const report = await p.migrate();
  expect(report.rearmedCommands.map((c) => `${c.action}`).sort()).toEqual([
    "cancel",
    "pause",
    "stop",
  ]);
  expect(report.quarantinedCommands.map((c) => c.action).sort()).toEqual(
    [
      "invalid",
      "invalid",
      "nudge",
      "resolve",
      "resume",
      "retry",
      "rollout",
      "stop",
    ].sort(),
  );
  expect(readdirSync(join(p.control, "commands")).sort()).toEqual([
    `${uuid(1)}.json`,
    `${uuid(2)}.json`,
    `${uuid(3)}.json`,
  ]);
  const parked = readdirSync(join(p.control, "quarantined-commands"));
  expect(parked).toHaveLength(9);
  expect(parked).toContain(`${uuid(5)}.json.dup1`);
  expect(
    JSON.parse(
      readFileSync(join(p.control, "commands", `${uuid(1)}.json`), "utf8"),
    ),
  ).toMatchObject({ action: "pause", all: true });
});

it("refuses on credible liveness but ignores forged claims, naming them", async () => {
  const live: Array<[string, Record<string, unknown>, boolean]> = [
    ["live supervisor pid", { running: true, pid: process.pid }, false],
    [
      "fresh heartbeat",
      { running: true, pid: deadPid, checkedAt: new Date().toISOString() },
      false,
    ],
    [
      "live child",
      {
        running: true,
        records: { a: { status: "running", pid: process.pid } },
      },
      false,
    ],
    ["live lease", {}, true],
  ];
  for (const [label, extra, lease] of live) {
    const p = project();
    p.seed(validState(extra));
    if (lease)
      p.write(
        join(p.legacy, "watcher.lock"),
        JSON.stringify({ pid: process.pid, token: "t" }),
      );
    const before = tree(p.legacy);
    await expect(p.migrate(), label).rejects.toThrow("Refusing to migrate");
    await expect(p.migrate({ dryRun: true }), label).rejects.toThrow(
      "Refusing to migrate",
    );
    expect(tree(p.legacy), label).toEqual(before);
    expect(existsSync(p.control), label).toBe(false);
  }
  // Forged: a lease and supervisor owned by pid 1 (not ours), a heartbeat from 2099.
  const forged = project();
  forged.seed(
    validState({
      running: true,
      pid: 1,
      checkedAt: "2099-01-01T00:00:00.000Z",
    }),
  );
  forged.write(
    join(forged.legacy, "watcher.lock"),
    JSON.stringify({ pid: 1, token: "forged" }),
  );
  const report = await forged.migrate({ owner: foreign(1) });
  expect(report.status).toBe("migrated");
  expect(report.ignoredLivenessClaims.join("\n")).toContain(
    "PID 1 is not owned by you",
  );
  expect(report.ignoredLivenessClaims.join("\n")).toContain("in the future");
});

it("sets a forged legacy directory aside only when nothing credible is live", async () => {
  const forged = project();
  forged.seed(validState({ running: true, pid: 1 }));
  forged.write(
    join(forged.legacy, "watcher.lock"),
    JSON.stringify({ pid: 1, token: "x" }),
  );
  const dry = await forged.migrate({
    discardLegacy: true,
    dryRun: true,
    owner: foreign(1),
  });
  expect(dry.status).toBe("dry-run");
  expect(existsSync(forged.legacy)).toBe(true);
  const done = await forged.migrate({ discardLegacy: true, owner: foreign(1) });
  expect(done.status).toBe("discarded");
  expect(done.discardedTo).toContain("supervisor.discarded-");
  expect(existsSync(forged.legacy)).toBe(false);
  expect(existsSync(join(done.discardedTo as string, "state.json"))).toBe(true);
  expect(existsSync(forged.control)).toBe(false);

  const real = project();
  real.seed(validState({ running: true, pid: process.pid }));
  await expect(real.migrate({ discardLegacy: true })).rejects.toThrow(
    "Refusing to discard",
  );
  expect(existsSync(real.legacy)).toBe(true);
});

it("re-checks liveness and the destination after the preflight and holds the legacy lease", async () => {
  const late = project();
  late.seed();
  await expect(
    late.migrate({
      afterPreflight: async () => {
        // A supervisor of an older release comes alive between check and move.
        writeFileSync(
          join(late.legacy, "state.json"),
          JSON.stringify(validState({ running: true, pid: process.pid })),
        );
      },
    }),
  ).rejects.toThrow("appeared during migration");
  expect(existsSync(late.legacy)).toBe(true);
  expect(existsSync(join(late.legacy, "watcher.lock"))).toBe(false);

  const started = project();
  started.seed();
  await expect(
    started.migrate({
      afterPreflight: async () => {
        // A new supervisor creates the destination between check and move.
        mkdirSync(started.control, { recursive: true, mode: 0o700 });
        writeFileSync(join(started.control, "state.json"), "{}", {
          mode: 0o600,
        });
      },
    }),
  ).rejects.toThrow("already has content");
  expect(existsSync(join(started.legacy, "state.json"))).toBe(true);
});

it("falls back to verified copy across filesystems", async () => {
  const p = project();
  p.seed();
  p.write(join(p.legacy, "pi-sessions/s1.jsonl"), "line\n".repeat(1000));
  let attempts = 0;
  const report = await p.migrate({
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
  expect(readFileSync(join(p.control, "pi-sessions/s1.jsonl"), "utf8")).toBe(
    "line\n".repeat(1000),
  );
  expect(existsSync(join(p.control, ".migrating-to"))).toBe(false);
  for (const entry of tree(p.control))
    expect(mode(join(p.control, entry)) & 0o077, entry).toBe(0);
});

const crossDevice = {
  rename: (async (from: string, to: string) => {
    if (!String(from).includes(".migrating-"))
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    return rename(from, to);
  }) as typeof rename,
};
it("cleans up and keeps the source when a copy fails verification", async () => {
  const p = project();
  p.seed();
  await expect(
    p.migrate({
      move: {
        ...crossDevice,
        copyFile: (async (from: string, to: string) => {
          await copyFile(from, to);
          if (String(from).endsWith("desired.json"))
            writeFileSync(to, "tampered");
        }) as typeof copyFile,
      },
    }),
  ).rejects.toThrow("Verification failed");
  expect(existsSync(join(p.legacy, "state.json"))).toBe(true);
  expect(existsSync(join(p.legacy, ".migrating-to"))).toBe(false);
  expect(
    readdirSync(join(p.control, "..")).filter((e) => e.includes("migrating")),
  ).toEqual([]);
  expect(existsSync(join(p.control, "state.json"))).toBe(false);
});

it("finishes retiring the source after a crash between publication and retirement", async () => {
  const p = project();
  p.seed();
  // Only the migrating process's own lease is "dead" for the rerun.
  const dead: Owner = () => "dead";
  await expect(
    p.migrate({
      owner: dead,
      move: {
        ...crossDevice,
        afterPublish: async () => {
          throw new Error("simulated crash");
        },
      },
    }),
  ).rejects.toThrow("simulated crash");
  // Both are populated, exactly the window the journal exists for.
  expect(existsSync(join(p.legacy, ".migrating-to"))).toBe(true);
  expect(existsSync(join(p.control, "state.json"))).toBe(true);
  const rerun = await p.migrate({ owner: dead });
  expect(rerun.status).toBe("migrated");
  expect(existsSync(p.legacy)).toBe(false);
  expect(existsSync(join(p.control, "state.json"))).toBe(true);
  expect(existsSync(join(p.control, ".migrating-to"))).toBe(false);

  // A destination that differs from the journal is never trusted.
  const tampered = project();
  tampered.seed();
  await expect(
    tampered.migrate({
      owner: dead,
      move: {
        ...crossDevice,
        afterPublish: async () => {
          throw new Error("simulated crash");
        },
      },
    }),
  ).rejects.toThrow("simulated crash");
  writeFileSync(join(tampered.control, "state.json"), "{}");
  await expect(tampered.migrate({ owner: dead })).rejects.toThrow(
    "already has content",
  );
  expect(existsSync(join(tampered.legacy, "state.json"))).toBe(true);
});

it("refuses a non-empty destination, a symlinked source and unexpected entry types", async () => {
  const busy = project();
  busy.seed();
  busy.write(join(busy.control, "state.json"), "{}");
  await expect(busy.migrate()).rejects.toThrow("already has content");

  const linked = project();
  const elsewhere = join(linked.base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, linked.legacy);
  await expect(linked.migrate()).rejects.toThrow("not a plain directory");

  const odd = project();
  odd.seed();
  symlinkSync("/etc/passwd", join(odd.legacy, "runs/escape"));
  await expect(odd.migrate()).rejects.toThrow(
    "only regular files and directories",
  );
  expect(existsSync(odd.control)).toBe(false);

  const empty = project();
  empty.seed();
  mkdirSync(empty.control, { recursive: true, mode: 0o700 });
  expect((await empty.migrate()).status).toBe("migrated");
});

it("moves the watchdog directory and refuses a live watchdog lease", async () => {
  const p = project();
  p.seed();
  p.write(join(p.store, "watchdog/latest.json"), "{}");
  const report = await p.migrate();
  expect(report.watchdog).toBe(true);
  expect(existsSync(join(p.store, "watchdog"))).toBe(false);
  expect(existsSync(join(p.control, "watchdog/latest.json"))).toBe(true);
  expect(mode(join(p.control, "watchdog/latest.json"))).toBe(0o600);
  const live = project();
  live.seed();
  live.write(
    join(live.store, "watchdog/lease/owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, identity: "x" }),
  );
  await expect(live.migrate()).rejects.toThrow("watchdog lease");
});

it("fails closed on a legacy layout and routes halting verbs without trusting forged state", () => {
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
    "agents",
    "dashboard",
  ])
    expect(() =>
      resolveControlTarget(dead.store, dead.control, command),
    ).toThrow(legacyRefusal);

  // A credibly live old supervisor: legacy primary, control mirrored.
  const old = project();
  old.seed(validState({ running: true, pid: process.pid }));
  for (const command of ["status", "stop", "pause", "cancel"]) {
    const target = resolveControlTarget(old.store, old.control, command);
    expect(target.directory).toBe(old.legacy);
    expect(target.also).toEqual([old.control]);
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

  // Forged legacy state next to a live NEW supervisor must never divert a halt.
  const forgeries: Array<[string, Record<string, unknown>, Owner?]> = [
    ["pid 1 owned by someone else", { running: true, pid: 1 }, foreign(1)],
    [
      "heartbeat from the future",
      { running: true, pid: deadPid, checkedAt: "2099-01-01T00:00:00.000Z" },
    ],
    [
      "fresh heartbeat",
      { running: true, pid: deadPid, checkedAt: new Date().toISOString() },
    ],
  ];
  for (const [label, forged, owner] of forgeries) {
    const p = project();
    p.seed(validState(forged));
    p.write(
      join(p.legacy, "watcher.lock"),
      JSON.stringify({ pid: 1, token: "f" }),
    );
    p.write(
      join(p.control, "state.json"),
      JSON.stringify(validState({ running: true, pid: process.pid })),
    );
    chmodSync(p.control, 0o700);
    for (const command of ["stop", "pause", "cancel", "status"]) {
      const target = resolveControlTarget(
        p.store,
        p.control,
        command,
        owner ? { owner } : {},
      );
      expect(target.directory, `${label}/${command}`).toBe(p.control);
      expect(target.also, `${label}/${command}`).toBeUndefined();
      expect(target.warning).toContain("ignored");
    }
    expect(() =>
      resolveControlTarget(
        p.store,
        p.control,
        "resume",
        owner ? { owner } : {},
      ),
    ).toThrow(legacyRefusal);
  }

  // No live new supervisor and ambiguous legacy claims: queue in both.
  const ambiguous = project();
  ambiguous.seed(validState({ running: true, pid: 1 }));
  const target = resolveControlTarget(
    ambiguous.store,
    ambiguous.control,
    "stop",
    { owner: foreign(1) },
  );
  expect(target.directory).toBe(ambiguous.control);
  expect(target.also).toEqual([ambiguous.legacy]);
  expect(target.warning).toContain("PID 1 is not owned by you");
});

it("states one stable refusal line that names the migrate command", () => {
  expect(legacyRefusal).not.toContain("\n");
  expect(legacyRefusal).toContain("`crewplane migrate`");
  expect(legacyRefusal).not.toContain("any other command");
});
