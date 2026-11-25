import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { controlDirectory } from "./control.ts";
import {
  describeConfig,
  legacyRefusal,
  type MigrateOptions,
  migrateControl,
  type Owner,
  processOwner,
  registeredSupervisor,
  resolveControlTarget,
} from "./migrate.ts";
import { cacheDirectory } from "./update.ts";

const scratch: string[] = [];
const deadPid = 2 ** 22 + 12345;
const trusted = (pid: number) => pid === process.pid;
const realSupervisor = registeredSupervisor;
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
  const options = (extra: Partial<MigrateOptions> = {}): MigrateOptions => ({
    store,
    control,
    root,
    identity: { primaryRoot: root },
    isSupervisor: trusted,
    ...extra,
  });
  /** Dry-run first, then adopt exactly the reviewed digest unless told otherwise. */
  const migrate = async (extra: Partial<MigrateOptions> = {}) => {
    const full = options(extra);
    if (
      !full.dryRun &&
      !full.discardLegacy &&
      full.acceptConfig === undefined
    ) {
      const reviewed = await migrateControl({
        ...full,
        dryRun: true,
        ...(full.afterPreflight ? { afterPreflight: async () => {} } : {}),
      });
      full.acceptConfig = reviewed.digest ?? undefined;
    }
    return migrateControl(full);
  };
  return {
    base,
    root,
    store,
    control,
    legacy,
    binary,
    seed,
    write,
    migrate,
    config,
    options,
  };
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

it("stages fresh private copies, publishes them, binds the directory and is idempotent", async () => {
  const p = project();
  p.seed();
  const report = await p.migrate();
  expect(report).toMatchObject({
    status: "migrated",
    from: p.legacy,
    to: p.control,
    method: "staged-copy",
    leftover: null,
    configAccepted: true,
    lateFilesLeftBehind: [],
  });
  expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(p.legacy)).toBe(false);
  expect(readFileSync(join(p.control, "desired.json"), "utf8")).toBe(
    '{"desiredRunning":false}',
  );
  for (const entry of tree(p.control))
    expect(mode(join(p.control, entry)) & 0o077, entry).toBe(0);
  expect(mode(p.control)).toBe(0o700);
  expect(existsSync(join(p.control, "identity.json"))).toBe(true);
  expect(existsSync(join(p.store, "control-binding.json"))).toBe(true);
  expect(
    readdirSync(join(p.control, "..")).filter((e) => e.includes("staging")),
  ).toEqual([]);
  expect((await p.migrate()).status).toBe("nothing-to-migrate");
});

it("dry-run prints the complete configuration and a digest and changes nothing", async () => {
  const p = project();
  p.seed();
  const before = tree(p.legacy);
  const report = await p.migrate({ dryRun: true });
  expect(report).toMatchObject({ status: "dry-run", configAccepted: false });
  expect(report.config).toMatchObject({
    allowedTasks: ["T-1"],
    lanes: { builder: { enabled: true } },
  });
  expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(tree(p.legacy)).toEqual(before);
  expect(existsSync(join(p.base, "state"))).toBe(false);
  // The digest is stable for unchanged content.
  expect((await p.migrate({ dryRun: true })).digest).toBe(report.digest);
});

it("adopts a configuration only when its reviewed digest matches the staged snapshot", async () => {
  const p = project();
  p.seed();
  const reviewed = await p.migrate({ dryRun: true });
  const none = await p
    .migrate({ acceptConfig: "" })
    .catch((e: Error) => e.message);
  expect(none).toContain(reviewed.digest);
  expect(none).toContain("--accept-config");
  const wrong = await p
    .migrate({ acceptConfig: "0".repeat(64) })
    .catch((e: Error) => e.message);
  expect(wrong).toContain("does not match");
  expect(existsSync(p.control)).toBe(false);
  expect(existsSync(join(p.legacy, "config.json"))).toBe(true);
  expect(
    readdirSync(join(p.control, "..")).filter((e) => e.includes("staging")),
  ).toEqual([]);
  expect(
    (await p.migrate({ acceptConfig: reviewed.digest as string })).status,
  ).toBe("migrated");
});

it("shows every effective binary, passEnv and Claude setting of a planted configuration, flagged and escaped", async () => {
  const p = project();
  p.seed();
  const evil = join(p.store, "evidence-evil.sh");
  writeFileSync(evil, "#!/bin/sh\n", { mode: 0o755 });
  const bidi = join(p.base, "codex‮txt");
  writeFileSync(bidi, "#!/bin/sh\n", { mode: 0o755 });
  p.write(
    join(p.legacy, "config.json"),
    JSON.stringify(
      p.config({
        binary: bidi,
        binaries: { claude: evil },
        lanes: {
          builder: {
            enabled: true,
            harness: "claude",
            model: "opus",
            claudePermissionMode: "acceptEdits",
            claudeMcp: "inherit",
            claudeSettingSources: ["user", "project", "local"],
            passEnv: ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"],
            instructionsPath: "GUIDE.md",
          },
        },
      }),
    ),
  );
  const dry = await p.migrate({ dryRun: true });
  const text = describeConfig(dry.config as never, {
    root: p.root,
    store: p.store,
  });
  expect(text).toContain(evil);
  expect(text).toContain("builder (claude, enabled)");
  expect(text).toMatch(/evidence-evil\.sh\s+\[WARNING: inside the project/);
  expect(text).toContain("GITHUB_TOKEN");
  expect(text).toContain("AWS_SECRET_ACCESS_KEY");
  expect(text).toContain("acceptEdits");
  expect(text).toContain('"claudeMcp": "inherit"');
  expect(text).toContain("GUIDE.md");
  expect(text).toMatch(/GUIDE\.md\s+\[WARNING: inside the project/);
  expect(text).toContain("maxParallel");
  // Bidi controls are shown as escapes, never rendered.
  expect(text).not.toContain("‮");
  expect(text).toContain("\\u{202e}");
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
        "invalid supervisor pid",
        (p) =>
          p.write(
            join(p.legacy, "state.json"),
            JSON.stringify(validState({ pid: -4 })),
          ),
        "invalid supervisor pid",
      ],
      [
        "invalid record pid",
        (p) =>
          p.write(
            join(p.legacy, "state.json"),
            JSON.stringify(
              validState({
                records: {
                  a: {
                    key: "a",
                    lane: "builder",
                    task: null,
                    cwd: p.root,
                    status: "idle",
                    processGroupId: 0,
                    seen: [],
                    runs: [],
                    noProgress: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                  },
                },
              }),
            ),
          ),
        "invalid processGroupId",
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
    await expect(
      p.migrate({ acceptConfig: "0".repeat(64) }),
      label,
    ).rejects.toThrow(message);
    expect(existsSync(p.control), label).toBe(false);
    expect(existsSync(p.legacy), label).toBe(true);
  }
});

it("adopts crash-recovery state, lists its processes and drops re-armed ids from the command log", async () => {
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
  p.seed(
    validState({
      running: true,
      records,
      // A forged log would make the supervisor skip the re-armed pause.
      commands: [`${uuid(1)}.json`, "other.json"],
    }),
  );
  p.write(
    join(p.legacy, "watcher.lock"),
    JSON.stringify({ pid: deadPid, token: "dead" }),
  );
  const report = await p.migrate();
  expect(report.adoptedProcesses).toEqual([
    {
      record: "builder:T-1",
      pid: deadPid,
      processGroupId: deadPid,
      alive: false,
    },
  ]);
  const adopted = JSON.parse(
    readFileSync(join(p.control, "state.json"), "utf8"),
  );
  expect(adopted.records["builder:T-1"].processGroupId).toBe(deadPid);
  expect(adopted.commands).toEqual(["other.json"]);
  expect(readFileSync(join(p.control, "watcher.lock"), "utf8")).toContain(
    "dead",
  );
});

it("re-arms only a normalized narrowing command and quarantines everything else", async () => {
  const p = project();
  p.seed(validState(), false);
  const at = new Date().toISOString();
  const put = (n: number, value: unknown) =>
    p.write(join(p.legacy, `commands/${uuid(n)}.json`), JSON.stringify(value));
  put(1, {
    action: "pause",
    all: true,
    issuer: "root",
    generation: "forged-generation",
    at: "2099-01-01T00:00:00.000Z",
  });
  put(2, { action: "stop", at });
  put(3, { action: "cancel", all: true, at });
  put(4, { action: "resume", all: true, at: "2099-01-01T00:00:00.000Z" });
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
  p.write(join(p.legacy, `quarantined-commands/${uuid(5)}.json`), "old");
  const report = await p.migrate();
  expect(report.rearmedCommands.map((c) => c.action).sort()).toEqual([
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
  const pause = JSON.parse(
    readFileSync(join(p.control, "commands", `${uuid(1)}.json`), "utf8"),
  );
  expect(pause).toMatchObject({
    action: "pause",
    all: true,
    issuer: "migrate",
  });
  expect(pause.generation).toBeUndefined();
  expect(Date.parse(pause.at)).toBeLessThanOrEqual(Date.now() + 1000);
});

it("never arms a widening command that arrives or is swapped after the snapshot or preflight", async () => {
  // A resume with a future timestamp arrives before the snapshot: it is staged,
  // classified and changes the digest, so the earlier acceptance no longer holds.
  const early = project();
  early.seed();
  const reviewed = await early.migrate({ dryRun: true });
  await expect(
    early.migrate({
      acceptConfig: reviewed.digest as string,
      afterPreflight: async () => {
        writeFileSync(
          join(early.legacy, "commands", `${uuid(33)}.json`),
          JSON.stringify({
            action: "resume",
            all: true,
            at: "2099-01-01T00:00:00.000Z",
          }),
        );
      },
    }),
  ).rejects.toThrow("does not match");
  expect(existsSync(early.control)).toBe(false);

  // After the snapshot nothing is published any more: the late file and the
  // swapped config stay behind in an inert directory.
  const late = project();
  late.seed();
  const evil = join(late.store, "evil.sh");
  writeFileSync(evil, "#!/bin/sh\n", { mode: 0o755 });
  const report = await late.migrate({
    move: {
      afterSnapshot: async () => {
        writeFileSync(
          join(late.legacy, "commands", `${uuid(34)}.json`),
          JSON.stringify({
            action: "resume",
            all: true,
            at: "2099-01-01T00:00:00.000Z",
          }),
        );
        writeFileSync(
          join(late.legacy, "config.json"),
          JSON.stringify(late.config({ binary: evil })),
        );
        writeFileSync(join(late.legacy, "state.json"), "{ not json");
      },
    },
  });
  expect(report.status).toBe("migrated");
  expect(report.lateFilesLeftBehind.sort()).toEqual([
    `commands/${uuid(34)}.json`,
    "config.json",
    "state.json",
  ]);
  expect(
    existsSync(join(report.leftover as string, "commands", `${uuid(34)}.json`)),
  ).toBe(true);
  expect(readdirSync(join(late.control, "commands"))).toEqual([
    `${uuid(1)}.json`,
  ]);
  expect(
    JSON.parse(readFileSync(join(late.control, "config.json"), "utf8")).binary,
  ).toBe(late.binary);
  expect(() =>
    JSON.parse(readFileSync(join(late.control, "state.json"), "utf8")),
  ).not.toThrow();
});

it("a hard link or an open descriptor into the legacy tree cannot reach the migrated files", async () => {
  const p = project();
  p.seed();
  linkSync(join(p.legacy, "config.json"), join(p.store, "config-link.json"));
  const fd = openSync(join(p.legacy, "state.json"), "r+");
  const configBefore = readFileSync(join(p.legacy, "config.json"), "utf8");
  try {
    const report = await p.migrate();
    expect(report.hardlinkedSources).toContain("config.json");
    // The agent keeps writing through its link and its descriptor.
    writeFileSync(
      join(p.store, "config-link.json"),
      '{"allowedTasks":["*EVIL*"]}',
    );
    writeSync(fd, "X".repeat(40), 0);
  } finally {
    closeSync(fd);
  }
  const adopted = readFileSync(join(p.control, "config.json"), "utf8");
  expect(JSON.parse(adopted).allowedTasks).toEqual(["T-1"]);
  expect(JSON.parse(adopted)).toEqual(JSON.parse(configBefore));
  expect(statSync(join(p.control, "config.json")).nlink).toBe(1);
  expect(
    JSON.parse(readFileSync(join(p.control, "state.json"), "utf8")).version,
  ).toBe(2);
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

it("does not take a same-user process for a supervisor unless it is registered or runs as one", async () => {
  const p = project();
  p.seed();
  const daemon = spawn("sleep", ["30"], { stdio: "ignore" });
  const registration = join(
    cacheDirectory(),
    "supervisors",
    `${daemon.pid}.json`,
  );
  try {
    // An agent plants a lease naming any long-lived process of the same user.
    p.write(
      join(p.legacy, "watcher.lock"),
      JSON.stringify({ pid: daemon.pid, token: "x" }),
    );
    const target = resolveControlTarget(p.store, p.control, "stop");
    expect(target.directory).toBe(p.control);
    expect(target.also).toEqual([p.legacy]);
    expect(target.warning).toContain("not a registered Crewplane supervisor");
    expect(() => resolveControlTarget(p.store, p.control, "start")).toThrow(
      legacyRefusal,
    );
    const dry = await p.migrate({
      dryRun: true,
      isSupervisor: realSupervisor,
    });
    expect(dry.ignoredLivenessClaims.join()).toContain("not a registered");
    // Registered: now it is credible and blocks.
    mkdirSync(join(registration, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(registration, "{}");
    await expect(p.migrate({ isSupervisor: realSupervisor })).rejects.toThrow(
      "Refusing to migrate",
    );
    rmSync(registration);
    const done = await p.migrate({ isSupervisor: realSupervisor });
    expect(done.status).toBe("migrated");
  } finally {
    rmSync(registration, { force: true });
    daemon.kill();
  }
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

it("holds the legacy lease and recovery.lock for the whole critical section and re-checks afterwards", async () => {
  const held = project();
  held.seed();
  let seen: string[] = [];
  await held.migrate({
    move: {
      afterSnapshot: async () => {
        seen = [
          existsSync(join(held.legacy, "watcher.lock")) ? "lease" : "",
          existsSync(join(held.legacy, "recovery.lock")) ? "recovery" : "",
        ];
      },
    },
  });
  expect(seen).toEqual(["lease", "recovery"]);
  expect(existsSync(held.legacy)).toBe(false);
  // Our guards are never part of the snapshot.
  expect(existsSync(join(held.control, "recovery.lock"))).toBe(false);
  expect(existsSync(join(held.control, "watcher.lock"))).toBe(false);

  // A failed run removes only its own recovery lock.
  const failed = project();
  failed.seed();
  await expect(
    failed.migrate({ acceptConfig: "0".repeat(64) }),
  ).rejects.toThrow("digest");
  expect(existsSync(join(failed.legacy, "recovery.lock"))).toBe(false);
  expect(existsSync(join(failed.legacy, "watcher.lock"))).toBe(false);

  // Someone else's recovery lock is never touched, and blocks us.
  const other = project();
  other.seed();
  other.write(join(other.legacy, "recovery.lock"), "424242");
  await expect(
    other.migrate({ dryRun: false, acceptConfig: "0".repeat(64) }),
  ).rejects.toThrow("recovery.lock exists");
  expect(readFileSync(join(other.legacy, "recovery.lock"), "utf8")).toBe(
    "424242",
  );

  const late = project();
  late.seed();
  await expect(
    late.migrate({
      afterPreflight: async () => {
        writeFileSync(
          join(late.legacy, "state.json"),
          JSON.stringify(validState({ running: true, pid: process.pid })),
        );
      },
    }),
  ).rejects.toThrow(/appeared during migration|does not match/);
  expect(existsSync(late.legacy)).toBe(true);
  expect(existsSync(join(late.legacy, "recovery.lock"))).toBe(false);

  const started = project();
  started.seed();
  await expect(
    started.migrate({
      afterPreflight: async () => {
        mkdirSync(started.control, { recursive: true, mode: 0o700 });
        writeFileSync(join(started.control, "state.json"), "{}", {
          mode: 0o600,
        });
      },
    }),
  ).rejects.toThrow("already has content");
  expect(existsSync(join(started.legacy, "state.json"))).toBe(true);
});

it("verifies every staged file and cleans up after a mismatch", async () => {
  const p = project();
  p.seed();
  await expect(
    p.migrate({
      move: {
        afterStageFile: async (path) => {
          if (path.endsWith("desired.json")) writeFileSync(path, "tampered");
        },
      },
    }),
  ).rejects.toThrow("Verification failed");
  expect(existsSync(join(p.legacy, "state.json"))).toBe(true);
  expect(existsSync(join(p.legacy, ".migrating-to"))).toBe(false);
  expect(
    readdirSync(join(p.control, "..")).filter((e) => e.includes("staging")),
  ).toEqual([]);
  expect(existsSync(join(p.control, "state.json"))).toBe(false);
});

it("finishes retiring the source after a crash between publication and retirement", async () => {
  const p = project();
  p.seed();
  const dead: Owner = () => "dead";
  await expect(
    p.migrate({
      owner: dead,
      move: {
        afterPublish: async () => {
          throw new Error("simulated crash");
        },
      },
    }),
  ).rejects.toThrow("simulated crash");
  expect(existsSync(join(p.legacy, ".migrating-to"))).toBe(true);
  expect(existsSync(join(p.control, "state.json"))).toBe(true);
  const rerun = await p.migrate({ owner: dead });
  expect(rerun.status).toBe("migrated");
  expect(existsSync(join(p.legacy))).toBe(false);
  expect(existsSync(join(p.control, "state.json"))).toBe(true);
  expect(existsSync(join(p.control, ".migrating-to"))).toBe(false);

  const tampered = project();
  tampered.seed();
  await expect(
    tampered.migrate({
      owner: dead,
      move: {
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

it("moves the watchdog tree and resumes after a crash in its publish window", async () => {
  const p = project();
  p.seed();
  p.write(join(p.store, "watchdog/latest.json"), "{}");
  const report = await p.migrate();
  expect(report.watchdog).toBe(true);
  expect(existsSync(join(p.store, "watchdog"))).toBe(false);
  expect(mode(join(p.control, "watchdog/latest.json"))).toBe(0o600);

  const crashed = project();
  crashed.seed();
  crashed.write(join(crashed.store, "watchdog/latest.json"), "{}");
  let calls = 0;
  await expect(
    crashed.migrate({
      move: {
        afterPublish: async () => {
          if (++calls === 2) throw new Error("simulated crash");
        },
      },
    }),
  ).rejects.toThrow("simulated crash");
  expect(existsSync(join(crashed.store, "watchdog/.migrating-to"))).toBe(true);
  expect(existsSync(join(crashed.control, "watchdog/latest.json"))).toBe(true);
  const rerun = await crashed.migrate();
  expect(rerun.watchdog).toBe(true);
  expect(existsSync(join(crashed.store, "watchdog"))).toBe(false);

  const live = project();
  live.seed();
  live.write(
    join(live.store, "watchdog/lease/owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, identity: "x" }),
  );
  await expect(live.migrate()).rejects.toThrow("watchdog lease");
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

it("fails closed on a legacy layout and routes halting verbs without trusting forged state", () => {
  const options = { isSupervisor: trusted };
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
      resolveControlTarget(dead.store, dead.control, command, options),
    ).toThrow(legacyRefusal);

  const old = project();
  old.seed(validState({ running: true, pid: process.pid }));
  for (const command of ["status", "stop", "pause", "cancel"]) {
    const target = resolveControlTarget(
      old.store,
      old.control,
      command,
      options,
    );
    expect(target.directory).toBe(old.legacy);
    expect(target.also).toEqual([old.control]);
    expect(target.warning).toContain("older-release supervisor");
    expect(target.warning).toContain("unverified");
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
    expect(() =>
      resolveControlTarget(old.store, old.control, command, options),
    ).toThrow(legacyRefusal);

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
    const o = owner ? { ...options, owner } : options;
    for (const command of ["stop", "pause", "cancel", "status"]) {
      const target = resolveControlTarget(p.store, p.control, command, o);
      expect(target.directory, `${label}/${command}`).toBe(p.control);
      expect(target.also, `${label}/${command}`).toBeUndefined();
      expect(target.warning).toContain("ignored");
    }
    expect(() => resolveControlTarget(p.store, p.control, "resume", o)).toThrow(
      legacyRefusal,
    );
  }

  const ambiguous = project();
  ambiguous.seed(validState({ running: true, pid: 1 }));
  const target = resolveControlTarget(
    ambiguous.store,
    ambiguous.control,
    "stop",
    { ...options, owner: foreign(1) },
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
