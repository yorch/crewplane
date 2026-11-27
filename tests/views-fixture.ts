import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { controlDirectory, ensureControlDirectory } from "../src/control.ts";
import { main as coordination } from "../src/engine/agents.mjs";
import { createDashboard, newSessionToken } from "../src/engine/dashboard.ts";
import { createEvidenceStore } from "../src/engine/evidence/store.ts";
import { createTraceStore } from "../src/engine/operational-traces.ts";
import { discoverProject } from "../src/project.ts";

/**
 * An independently written PNG encoder (signature, IHDR, one IDAT, IEND), so the
 * evidence fixtures are real, decodable images and no expected value is derived
 * from the code under test. The picture is a flat colour with a diagonal stripe.
 */
export function makePng(width: number, height: number, rgb: number[]) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const stripe = Math.abs(x - Math.floor((y * width) / height)) < 3;
      for (let c = 0; c < 3; c++)
        row[1 + x * 3 + c] = stripe ? 255 - (rgb[c] ?? 0) : (rgb[c] ?? 0);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hour = 3600000;
const traceId = (n: number, at: number) =>
  `${at}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface ViewsFixture {
  root: string;
  controlDir: string;
  session: string;
  base: string;
  artifacts: string[];
  runs: string[];
  stateFile: string;
  readState: () => Record<string, unknown>;
  writeState: (value: unknown) => void;
  stop: () => Promise<void>;
}

export interface FixtureOptions {
  /** Install no configuration (the not-configured state). */
  noConfig?: boolean;
  /** Skip evidence artifacts. */
  noEvidence?: boolean;
  /** Skip the state file (no records, no log). */
  noState?: boolean;
  /** Extra control-log entries to append. */
  log?: Array<Record<string, unknown>>;
  /** Live tuning for the dashboard server. */
  liveMs?: number;
}

/**
 * A synthetic project for the four views: a valid configuration with three
 * lanes (one disabled, one with a cost cap), supervisor state with usage
 * counters and a control log, operational traces spread over 30 hours, and
 * real PNG evidence. Nothing starts a harness or a supervisor.
 */
export async function buildViewsFixture(
  options: FixtureOptions = {},
): Promise<ViewsFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-views-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
  writeFileSync(
    join(root, "crewplane.json"),
    JSON.stringify({
      version: 1,
      coordinator: "captain",
      reviewers: ["inspector"],
      tasksPath: "tickets",
    }),
  );
  mkdirSync(join(root, "tickets"));
  for (const [id, owner] of [
    ["CP-101", "builder"],
    ["CP-102", "worker"],
  ])
    writeFileSync(
      join(root, `tickets/${id}.md`),
      `# ${id} — Synthetic work\nOwner: ${owner}.\nPhase: alpha\nGoal: Synthetic goal for ${id}\n`,
    );
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-qm", "test: seed");
  await coordination(["init"], root);
  const controlDir = controlDirectory(root);
  await ensureControlDirectory(controlDir);
  mkdirSync(join(controlDir, "commands"), { recursive: true, mode: 0o700 });
  const store = discoverProject(root).store;

  if (!options.noConfig) {
    const binary = join(root, "tools", "fake-harness");
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    writeFileSync(
      join(controlDir, "config.json"),
      JSON.stringify({
        version: 1,
        root,
        binary,
        binaries: { claude: binary },
        allowedTasks: [],
        maxParallel: 2,
        intervalSeconds: 10,
        maxRunMinutes: 10,
        maxRunsPerHour: 6,
        confirmedStoppedAt: new Date().toISOString(),
        lanes: {
          builder: {
            enabled: true,
            harness: "claude",
            model: "sonnet",
            claudePermissionMode: "plan",
            claudeMcp: "strict",
            claudeSettingSources: ["project"],
            maxRunsPerHour: 4,
            maxCostUsdPerRun: 1,
          },
          worker: { enabled: true, harness: "codex" },
          captain: { enabled: false, harness: "codex" },
        },
      }),
      { mode: 0o600 },
    );
  }

  const now = Date.now();
  const stateFile = join(controlDir, "state.json");
  const readState = () =>
    JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  const writeState = (value: unknown) =>
    writeFileSync(stateFile, JSON.stringify(value), { mode: 0o600 });
  if (!options.noState) {
    const record = (lane: string, task: string, extra: object) => ({
      key: `${lane}:${task}`,
      lane,
      task,
      cwd: root,
      harness: "codex",
      status: "idle",
      reason: "x",
      seen: [],
      runs: [],
      noProgress: 0,
      inputTokens: 0,
      outputTokens: 0,
      ...extra,
    });
    const entry = (
      seq: number,
      minutesAgo: number,
      extra: Record<string, unknown>,
    ) => ({
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      seq,
      action: "pause",
      scope: "lane",
      target: "builder",
      outcome: "applied",
      code: "HELD",
      at: new Date(now - minutesAgo * 60000).toISOString(),
      issuer: "cli",
      ...extra,
    });
    writeState({
      version: 2,
      running: true,
      checkedAt: new Date(now).toISOString(),
      pid: process.pid,
      generation: "gen-views",
      draining: false,
      held: [],
      commands: [],
      notices: {},
      laneRev: { builder: 3, worker: 1 },
      scheduling: {
        maxRunsPerHour: 4,
        maxRunMinutes: 10,
        intervalSeconds: 10,
        allowedTasks: [],
        fingerprint: "f".repeat(64),
      },
      controlSeq: 6,
      controlLog: [
        entry(1, 300, {}),
        entry(2, 200, {
          action: "resume",
          outcome: "noop",
          code: "NOTHING_TO_RECOVER",
        }),
        entry(3, 120, {
          action: "retry",
          issuer: "dashboard",
          outcome: "stale",
          code: "STALE_REVISION",
        }),
        entry(4, 60, {
          action: "cancel",
          scope: "run",
          target: traceId(1, now - 4 * hour),
          issuer: "dashboard",
          outcome: "refused",
          code: "RUN_NOT_ACTIVE",
        }),
        entry(5, 30, {
          action: "nudge",
          scope: "task",
          target: "CP-101",
          outcome: "invalid",
          code: "UNKNOWN_TARGET",
        }),
        entry(6, 5, {
          action: "stop",
          scope: "instance",
          target: null,
          outcome: "refused",
          code: "<img src=x onerror=alert(1)>",
        }),
        ...(options.log ?? []),
      ],
      records: {
        "builder:CP-101": record("builder", "CP-101", {
          runs: [now - 10 * 60000, now - 25 * 60000, now - 40 * 60000],
          startedAt: new Date(now - 30 * 60000).toISOString(),
          finishedAt: new Date(now - 27 * 60000).toISOString(),
          inputTokens: 1200,
          inputTokensKnown: true,
          outputTokens: 300,
          outputTokensKnown: true,
          costKnown: true,
          reportedCostUsd: 1.5,
        }),
        "worker:CP-102": record("worker", "CP-102", {
          runs: [],
          startedAt: new Date(now - 90 * 60000).toISOString(),
          finishedAt: new Date(now - 20 * 60000).toISOString(),
        }),
      },
    });
    // Operational traces: an old run (so every bucket is covered) and runs in
    // recent hours, with backdated start times.
    const traces = await createTraceStore(join(store, "operational-traces"));
    const offsets = [30, 5, 5, 4, 2, 2, 2, 1];
    for (const [index, hoursAgo] of offsets.entries()) {
      const at = now - hoursAgo * hour - index * 1000;
      const id = traceId(index + 1, at);
      const writer = await traces.begin({
        runId: id,
        lane: index % 2 ? "worker" : "builder",
        task: index % 2 ? "CP-102" : "CP-101",
        harness: "codex",
      });
      await writer.emit({ kind: "started" });
      const metaPath = join(store, "operational-traces", `${id}.meta.json`);
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.startedAt = new Date(at).toISOString();
      writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
    }
  }

  const artifacts: string[] = [];
  const runs: string[] = [];
  if (!options.noEvidence) {
    const evidence = await createEvidenceStore(join(store, "evidence"));
    const capture = (step: number, extra: object = {}) => ({
      route: "dashboard",
      scenario: "initial" as const,
      step,
      browser: "chromium" as const,
      viewport: { width: 390, height: 844 },
      mime: "image/png" as const,
      outcome: "captured" as const,
      findingIds: [] as string[],
      recheckOf: null,
      ...extra,
    });
    const commit = "a".repeat(40);
    const first = await evidence.createRun({
      task: "CP-101",
      lane: "visual",
      testedCommit: commit,
    });
    const second = await evidence.createRun({
      task: "CP-102",
      lane: "visual",
      testedCommit: commit,
    });
    runs.push(first.runId, second.runId);
    const palette = [
      [30, 90, 200],
      [200, 90, 30],
      [40, 160, 90],
      [150, 60, 170],
    ];
    const shots: Array<[string, string, number, number, number[], object]> = [
      [first.runId, "initial", 390, 844, palette[0] ?? [], {}],
      [first.runId, "interaction", 1440, 900, palette[1] ?? [], { step: 1 }],
      [
        first.runId,
        "finding",
        390,
        844,
        palette[2] ?? [],
        {
          step: 2,
          outcome: "finding",
          findingIds: [`finding_${"a".repeat(32)}`],
        },
      ],
      [second.runId, "responsive", 1440, 900, palette[3] ?? [], {}],
    ];
    for (const [run, scenario, width, height, rgb, extra] of shots) {
      const stored = await evidence.append(
        run,
        capture(0, {
          scenario,
          viewport: { width, height },
          ...extra,
        }),
        makePng(width, height, rgb),
      );
      artifacts.push(stored.artifactId);
    }
  }

  const session = newSessionToken();
  const server = createDashboard(root, {
    session: { token: session },
    live: { intervalMs: options.liveMs ?? 200 },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    root,
    controlDir,
    session,
    base,
    artifacts,
    runs,
    stateFile,
    readState,
    writeState,
    stop: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
