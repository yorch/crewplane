import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlDirectory, ensureControlDirectory } from "../control.ts";
import { discoverProject } from "../project.ts";
import { evidenceArtifactHeaders } from "./dashboard/evidence-view.ts";
import { createDashboard, newSessionToken } from "./dashboard.ts";
import { createEvidenceStore } from "./evidence/store.ts";
import { createTraceStore } from "./operational-traces.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-api-")));
const token = newSessionToken();
const secretValue = "TOP-SECRET-ENV-VALUE-12345";
let server: ReturnType<typeof createDashboard>;
let url = "";
let port = 0;
let controlDir = "";
let store = "";
const auth = { "x-crewplane-session": token };
const get = (path: string, headers: Record<string, string> = auth) =>
  fetch(`${url}${path}`, { headers, redirect: "manual" });
// biome-ignore lint/suspicious/noExplicitAny: tests probe arbitrary response shapes.
type Body = any;
const json = async (path: string) => {
  const response = await get(path);
  return { status: response.status, body: (await response.json()) as Body };
};
const writeControl = (name: string, value: unknown) =>
  writeFileSync(join(controlDir, name), JSON.stringify(value), { mode: 0o600 });
const fakeBinary = (name: string) => {
  const path = join(root, "tools", name);
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
};
// Independently specified minimal PNG (signature + IHDR), as in the store tests.
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.alloc(13),
  Buffer.alloc(4),
]);
const raw = (path: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error("hung")));
    req.on("error", reject);
    req.end();
  });

beforeAll(async () => {
  writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: api fixture");
  store = discoverProject(root).store;
  controlDir = controlDirectory(root);
  await ensureControlDirectory(controlDir);
  server = createDashboard(root, {
    session: { token },
    live: { intervalMs: 40, heartbeatMs: 120, maxClients: 2 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const routes = [
  "/api/events",
  "/api/config",
  "/api/control-log",
  "/api/usage",
  "/api/evidence/artifacts",
];

describe("access control on every new route", () => {
  it("refuses a missing or wrong session with 401 and never accepts a query token", async () => {
    for (const path of routes) {
      for (const headers of [
        {},
        { "x-crewplane-session": "wrong" },
        { "x-crewplane-token": token },
      ]) {
        const response = await get(path, headers);
        expect(response.status, path).toBe(401);
        expect(((await response.json()) as { error: string }).error).toContain(
          "Session missing or expired",
        );
      }
      expect((await get(`${path}?token=${token}`, {})).status, path).toBe(401);
    }
  });
  it("refuses a foreign Host or Origin with 403 before the session check", async () => {
    for (const path of routes) {
      expect(await raw(path, { host: "evil.example", ...auth }), path).toBe(
        403,
      );
      expect(
        (await get(path, { ...auth, origin: "http://evil.example" })).status,
        path,
      ).toBe(403);
    }
  });
  it("answers only GET", async () => {
    for (const path of routes)
      expect(
        (await fetch(`${url}${path}`, { method: "POST", headers: auth }))
          .status,
        path,
      ).toBe(405);
  });
});

describe("GET /api/config", () => {
  it("reports an unconfigured project without guessing", async () => {
    const { status, body } = await json("/api/config");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      version: 1,
      installed: false,
      state: "not-configured",
      digest: null,
      ok: false,
      lanes: [],
      credentials: "not-probed",
      binariesExecuted: false,
    });
    expect(body.problems.map((p: { code: string }) => p.code)).toEqual([
      "CONFIG_MISSING",
    ]);
  });

  it("describes lanes, budgets and binaries; exposes env names, never values", async () => {
    process.env.CP_API_TEST_SECRET = secretValue;
    try {
      const good = fakeBinary("codex");
      const claude = fakeBinary("claude");
      writeFileSync(
        join(root, "lane.md"),
        "# lane guidance\nTOP-SECRET-FILE-CONTENT\n",
      );
      writeControl("config.json", {
        version: 1,
        root,
        binary: good,
        binaries: { claude },
        allowedTasks: ["CP-1"],
        maxParallel: 2,
        intervalSeconds: 5,
        maxRunMinutes: 30,
        maxRunsPerHour: 12,
        confirmedStoppedAt: "2026-01-01T00:00:00Z",
        coordinator: "captain",
        reviewers: ["inspector"],
        reviewerRoles: { inspector: "visual" },
        lanes: {
          captain: { enabled: true },
          builder: {
            enabled: true,
            passEnv: ["CP_API_TEST_SECRET"],
            maxRunsPerHour: 4,
            instructionsPath: "lane.md",
          },
          inspector: {
            enabled: false,
            harness: "claude",
            model: "sonnet",
            claudePermissionMode: "plan",
            claudeMcp: "strict",
            claudeSettingSources: ["project"],
            maxCostUsdPerRun: 1.5,
          },
        },
      });
      const response = await get("/api/config");
      const text = await response.text();
      expect(text).not.toContain(secretValue);
      expect(text).not.toContain("TOP-SECRET-FILE-CONTENT");
      const body = JSON.parse(text);
      expect(body.problems).toEqual([]);
      expect(body).toMatchObject({
        installed: true,
        state: "valid",
        digestsMatch: null,
        roles: {
          coordinator: "captain",
          reviewers: ["inspector"],
          stale: true,
        },
        budgets: {
          effectiveFrom: "configured",
          configured: {
            maxParallel: 2,
            maxRunsPerHour: 12,
            maxRunMinutes: 30,
            intervalSeconds: 5,
          },
          loaded: null,
          reloadPending: null,
        },
      });
      expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
      const lane = (id: string) =>
        body.lanes.find((l: { id: string }) => l.id === id);
      expect(lane("builder")).toMatchObject({
        enabled: true,
        role: "implementer",
        harness: "codex",
        passEnv: ["CP_API_TEST_SECRET"],
        instructions: { configured: true, status: "ok" },
        budgets: {
          maxRunsPerHour: 4,
          effectiveMaxRunsPerHour: 4,
          effectiveMaxRunMinutes: 30,
        },
        binary: { path: good, ok: true, code: null },
      });
      expect(lane("captain").role).toBe("coordinator");
      expect(lane("inspector")).toMatchObject({
        enabled: false,
        role: "reviewer",
        reviewerRole: "visual",
        harness: "claude",
        permissions: "permission-mode:plan",
        claude: { mcp: "strict", maxCostUsdPerRun: 1.5 },
        binary: { path: claude, ok: true },
      });
      expect(lane("builder").instructions).not.toHaveProperty("path");
      expect(
        body.binaries.map((b: { harness: string }) => b.harness).sort(),
      ).toEqual(["claude", "codex", "default"]);
    } finally {
      delete process.env.CP_API_TEST_SECRET;
    }
  });

  it("filters hostile environment names even when the configuration is invalid", async () => {
    writeControl("config.json", {
      version: 1,
      root,
      binary: fakeBinary("codex"),
      allowedTasks: [],
      maxParallel: 1,
      intervalSeconds: 5,
      maxRunMinutes: 5,
      maxRunsPerHour: 5,
      confirmedStoppedAt: "2026-01-01T00:00:00Z",
      lanes: {
        a: {
          enabled: true,
          passEnv: ["GOOD_NAME", "bad name; rm -rf /", "<img>"],
        },
      },
    });
    const { body } = await json("/api/config");
    expect(body.state).toBe("invalid");
    expect(body.problems[0].code).toBe("CONFIG_INVALID");
    expect(body.lanes[0].passEnv).toEqual(["GOOD_NAME"]);
  });

  it("reports an unreadable configuration instead of failing", async () => {
    writeFileSync(join(controlDir, "config.json"), "{ nope", { mode: 0o600 });
    const { status, body } = await json("/api/config");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      installed: false,
      state: "invalid",
      ok: false,
    });
    expect(body.problems[0].code).toBe("CONFIG_INVALID");
  });

  it("rejects parameters", async () => {
    expect((await get("/api/config?x=1")).status).toBe(400);
  });

  const validConfig = (extra: Record<string, unknown> = {}) => ({
    version: 1,
    root,
    binary: fakeBinary("codex"),
    allowedTasks: ["CP-1"],
    maxParallel: 2,
    intervalSeconds: 5,
    maxRunMinutes: 30,
    maxRunsPerHour: 12,
    confirmedStoppedAt: "2026-01-01T00:00:00Z",
    lanes: { a: { enabled: true }, b: { enabled: true, maxRunsPerHour: 3 } },
    ...extra,
  });

  it("computes every effective cap from the installed configuration and labels the loaded values beside them", async () => {
    writeControl("config.json", validConfig());
    writeControl("state.json", {
      version: 2,
      running: true,
      scheduling: {
        fingerprint: "f".repeat(64),
        allowedTasks: ["CP-1"],
        enabledLanes: ["a"],
        maxParallel: 1,
        maxRunsPerHour: 99,
        maxRunMinutes: 7,
        intervalSeconds: 9,
      },
    });
    const pending = (await json("/api/config")).body;
    expect(pending.budgets).toEqual({
      effectiveFrom: "configured",
      configured: {
        maxParallel: 2,
        maxRunsPerHour: 12,
        maxRunMinutes: 30,
        intervalSeconds: 5,
      },
      loaded: {
        maxParallel: 1,
        maxRunsPerHour: 99,
        maxRunMinutes: 7,
        intervalSeconds: 9,
      },
      reloadPending: true,
    });
    const lane = (id: string) =>
      pending.lanes.find((l: { id: string }) => l.id === id).budgets;
    // Neither lane's effective cap borrows the loaded global (99 / 7).
    expect(lane("a")).toMatchObject({
      effectiveMaxRunsPerHour: 12,
      effectiveMaxRunMinutes: 30,
    });
    expect(lane("b")).toMatchObject({
      maxRunsPerHour: 3,
      effectiveMaxRunsPerHour: 3,
      effectiveMaxRunMinutes: 30,
    });
    expect(pending.digestsMatch).toBe(false);
    writeControl("state.json", {
      version: 2,
      running: true,
      scheduling: {
        fingerprint: pending.digest,
        allowedTasks: ["CP-1"],
        enabledLanes: ["a"],
        maxParallel: 2,
        maxRunsPerHour: 12,
        maxRunMinutes: 30,
        intervalSeconds: 5,
      },
    });
    expect((await json("/api/config")).body.budgets.reloadPending).toBe(false);
    rmSync(join(controlDir, "state.json"), { force: true });
  });

  it("inspects a bounded number of lanes and says so", async () => {
    const lanes = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        `lane${String(i).padStart(3, "0")}`,
        { enabled: true },
      ]),
    );
    writeControl("config.json", validConfig({ lanes }));
    const { status, body } = await json("/api/config");
    expect(status).toBe(200);
    expect(body.lanes).toHaveLength(64);
    expect(body.lanesTruncated).toBe(true);
    expect(body.problemsTruncated).toBe(false);
  });

  it("refuses a symlinked or oversized configuration file instead of reading it", async () => {
    const target = join(root, "elsewhere.json");
    writeFileSync(target, JSON.stringify(validConfig()), { mode: 0o600 });
    rmSync(join(controlDir, "config.json"), { force: true });
    symlinkSync(target, join(controlDir, "config.json"));
    let { status, body } = await json("/api/config");
    expect(status).toBe(200);
    expect(body).toMatchObject({ installed: false, state: "invalid" });
    expect(body.problems[0].code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(body)).not.toContain("elsewhere");
    rmSync(join(controlDir, "config.json"), { force: true });
    writeControl(
      "config.json",
      validConfig({ padding: "x".repeat(2 * 1024 * 1024) }),
    );
    ({ status, body } = await json("/api/config"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ installed: false, state: "invalid" });
  });

  it("gives no digest, with a warning, for a configuration that cannot be fingerprinted", async () => {
    writeControl("config.json", validConfig({ allowedTasks: 5 }));
    const { status, body } = await json("/api/config");
    expect(status).toBe(200);
    expect(body).toMatchObject({ digest: null, digestsMatch: null });
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain(
      "DIGEST_UNAVAILABLE",
    );
    expect(body.problems[0].code).toBe("CONFIG_INVALID");
  });
});

describe("GET /api/control-log", () => {
  const entry = (seq: number, extra: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    seq,
    action: "pause",
    scope: "lane",
    target: "builder",
    outcome: "applied",
    code: "HELD",
    at: "2026-11-08T12:00:00.000Z",
    issuer: "dashboard",
    ...extra,
  });
  it("is empty and marked unavailable without supervisor state", async () => {
    rmSync(join(controlDir, "state.json"), { force: true });
    const { status, body } = await json("/api/control-log");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      available: false,
      entries: [],
      latestSeq: null,
      nextAfter: null,
    });
  });
  it("pages by seq in ascending order within bounds", async () => {
    writeControl("state.json", {
      version: 2,
      running: true,
      controlSeq: 7,
      controlLog: Array.from({ length: 7 }, (_, i) => entry(i + 1)),
    });
    const tail = (await json("/api/control-log?limit=3")).body;
    expect(tail.entries.map((e: { seq: number }) => e.seq)).toEqual([5, 6, 7]);
    expect(tail).toMatchObject({
      latestSeq: 7,
      retainedFrom: 1,
      retained: 7,
      hasMore: false,
      nextAfter: 7,
    });
    const first = (await json("/api/control-log?after=0&limit=3")).body;
    expect(first.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    expect(first).toMatchObject({ hasMore: true, nextAfter: 3 });
    const rest = (await json("/api/control-log?after=3&limit=200")).body;
    expect(rest.entries.map((e: { seq: number }) => e.seq)).toEqual([
      4, 5, 6, 7,
    ]);
    expect(rest.hasMore).toBe(false);
    expect((await json("/api/control-log?after=7")).body).toMatchObject({
      entries: [],
      nextAfter: 7,
    });
    expect((await json("/api/control-log")).body.entries).toHaveLength(7);
    expect((await json("/api/control-log")).body.entries[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      at: "2026-11-08T12:00:00.000Z",
      issuer: "dashboard",
      action: "pause",
      scope: "lane",
      target: "builder",
      lane: "builder",
      task: null,
      run: null,
      outcome: "applied",
      reason: "HELD",
    });
  });
  it("rejects unknown, repeated, malformed and oversized parameters", async () => {
    for (const query of [
      "?limit=0",
      "?limit=201",
      "?limit=abc",
      "?limit=-1",
      "?limit=1&limit=2",
      "?after=-1",
      "?after=1.5",
      "?after=1234567890",
      "?after=%3Cscript%3E",
      "?cursor=1",
      "?limit=",
    ]) {
      const response = await get(`/api/control-log${query}`);
      expect(response.status, query).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: "Invalid control-log request",
      });
    }
  });
  it("sanitizes hostile persisted values and never echoes them raw", async () => {
    const hostile =
      '<img src=x onerror="alert(1)">\u0000\u001b[31m\n' + "x".repeat(500);
    writeControl("state.json", {
      version: 2,
      controlSeq: 2,
      controlLog: [
        entry(1, {
          code: hostile,
          issuer: hostile,
          target: hostile,
          outcome: "exploded",
          scope: "galaxy",
        }),
        entry(2, { seq: 2, at: "not a date", action: 42 }),
      ],
    });
    const text = await (await get("/api/control-log")).text();
    const body = JSON.parse(text);
    expect(body.entries[0].outcome).toBe("invalid");
    expect(body.entries[0].scope).toBeNull();
    expect(body.entries[0].lane).toBeNull();
    for (const field of ["reason", "issuer", "target"])
      expect(body.entries[0][field].length).toBeLessThanOrEqual(128);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\\u0000|\\u001b|\\n/);
    expect(body.entries[1]).toMatchObject({ at: null, action: null });
  });
});

describe("GET /api/usage", () => {
  it("returns null, not 0, for unknown data and states what it covers", async () => {
    rmSync(join(controlDir, "state.json"), { force: true });
    rmSync(join(controlDir, "config.json"), { force: true });
    const { status, body } = await json("/api/usage");
    expect(status).toBe(200);
    expect(body.total.runsLastHour).toBeNull();
    expect(body.total).not.toHaveProperty("maxRunsPerHour");
    expect(body.caps).toMatchObject({ source: null, perLaneDefault: null });
    expect(body.total.series.every((v: unknown) => v === null)).toBe(true);
    expect(body.total.tokens).toMatchObject({
      semantics: "reported-counters-not-billing-totals",
      input: null,
      output: null,
    });
    expect(body.coverage.counters.state).toBe("unavailable");
    expect(body.coverage.ledger.connected).toBe(false);
    expect(body.window.bucketStarts).toHaveLength(24);
  });
  it("derives per-lane figures only from retained records", async () => {
    const now = Date.now();
    writeControl("config.json", {
      version: 1,
      root,
      binary: fakeBinary("codex"),
      maxRunsPerHour: 10,
      maxRunMinutes: 20,
      lanes: {
        builder: { enabled: true, maxRunsPerHour: 3 },
        claudey: { enabled: true, harness: "claude", maxCostUsdPerRun: 1 },
      },
    });
    writeControl("state.json", {
      version: 2,
      running: true,
      held: [],
      records: {
        a: {
          key: "a",
          lane: "builder",
          task: "CP-1",
          status: "idle",
          runs: [now - 60000, now - 120000],
          startedAt: new Date(now - 600000).toISOString(),
          finishedAt: new Date(now - 300000).toISOString(),
          inputTokensKnown: true,
          inputTokens: 1200,
          outputTokens: 0,
        },
        b: {
          key: "b",
          lane: "claudey",
          task: "CP-2",
          status: "idle",
          runs: [now - 30000],
          startedAt: new Date(now - 90000).toISOString(),
          finishedAt: new Date(now - 30000).toISOString(),
          costKnown: true,
          reportedCostUsd: 2.5,
          inputTokens: 999,
          outputTokens: 999,
        },
      },
      retiredRuns: { builder: [now - 1000, now - 7200000] },
    });
    const { body } = await json("/api/usage");
    const lane = (id: string) =>
      body.lanes.find((l: { lane: string }) => l.lane === id);
    expect(lane("builder")).toMatchObject({
      runs: { lastHour: 3, cap: 3, capSource: "lane", remaining: 0 },
      durations: { maxRunMinutes: 20, recordedRuns: 1 },
      tokens: {
        input: 1200,
        output: null,
        recordsReportingInput: 1,
        recordsReportingOutput: 0,
      },
    });
    expect(lane("builder").durations.recent[0]).toMatchObject({
      task: "CP-1",
      durationMs: 300000,
    });
    // Counters without a "known" flag are unknown, not zero or 999.
    expect(lane("claudey").tokens).toMatchObject({ input: null, output: null });
    expect(lane("claudey").cost).toMatchObject({
      maxCostUsdPerRun: 1,
      maxObservedUsd: 2.5,
      anyOverCap: true,
    });
    expect(lane("claudey").cost.recent[0]).toMatchObject({
      task: "CP-2",
      costUsd: 2.5,
      overCap: true,
    });
    expect(lane("claudey").runs).toMatchObject({
      lastHour: 1,
      cap: 10,
      capSource: "default",
    });
    expect(body.total).toMatchObject({ runsLastHour: 4 });
    expect(body.caps).toMatchObject({
      source: "configured",
      perLaneDefault: { maxRunsPerHour: 10, maxRunMinutes: 20 },
      loaded: null,
    });
    expect(body.total.tokens).toMatchObject({ input: 1200, output: null });
    expect(body.coverage.counters.state).toBe("available");
  });
  it("covers the hourly series from retained operational traces", async () => {
    const traces = await createTraceStore(join(store, "operational-traces"));
    const writer = await traces.begin({
      runId: "1794100000001-00000000-0000-4000-8000-000000000001",
      lane: "builder",
      task: "CP-1",
      harness: "codex",
    });
    await writer.emit({ kind: "started" });
    const { body } = await json("/api/usage");
    expect(body.coverage.series).toMatchObject({
      state: "available",
      retainedRuns: 1,
      retentionLimited: false,
      complete: false,
    });
    expect(body.total.series).toHaveLength(24);
    // The only retained run is the oldest one: no bucket has a run older than
    // it, so nothing is measured (a new install reports no data, not zeros).
    expect(body.total.series.every((v: unknown) => v === null)).toBe(true);
    expect(
      body.lanes
        .find((l: { lane: string }) => l.lane === "builder")
        .series.every((v: unknown) => v === null),
    ).toBe(true);
    expect((await get("/api/usage?x=1")).status).toBe(400);
  });
});

describe("evidence additions", () => {
  let runA = "";
  let runB = "";
  let artifactA = "";
  beforeAll(async () => {
    const evidence = await createEvidenceStore(join(store, "evidence"));
    const input = (task: string) => ({
      task,
      lane: "visual",
      testedCommit: "a".repeat(40),
    });
    const capture = {
      route: "dashboard",
      scenario: "initial" as const,
      step: 0,
      browser: "chromium" as const,
      viewport: { width: 390, height: 844 },
      mime: "image/png" as const,
      outcome: "captured" as const,
      findingIds: [],
      recheckOf: null,
    };
    runA = (await evidence.createRun(input("CP-1"))).runId;
    runB = (await evidence.createRun(input("CP-2"))).runId;
    artifactA = (await evidence.append(runA, capture, png)).artifactId;
    await evidence.append(runB, { ...capture, step: 1 }, png);
    await evidence.append(runB, { ...capture, step: 2 }, png);
  });
  it("filters the run list by run, task and page size", async () => {
    const all = (await json("/api/evidence")).body;
    expect(all.runs).toHaveLength(2);
    expect(
      (await json(`/api/evidence?run=${runA}`)).body.runs.map(
        (r: { runId: string }) => r.runId,
      ),
    ).toEqual([runA]);
    expect(
      (await json(`/api/evidence?run=${runA}&task=CP-2`)).body.runs,
    ).toEqual([]);
    expect(
      (await json(`/api/evidence?run=qa_${"0".repeat(32)}`)).body.runs,
    ).toEqual([]);
    const page = (await json("/api/evidence?limit=1")).body;
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).toMatch(/^qa_/);
    const next = (await json(`/api/evidence?limit=1&cursor=${page.nextCursor}`))
      .body;
    expect(next.runs).toHaveLength(1);
    expect(next.runs[0].runId).not.toBe(page.runs[0].runId);
  });
  it("rejects malformed filters without echoing them", async () => {
    for (const query of [
      "?limit=0",
      "?limit=21",
      "?limit=x",
      "?run=nope",
      "?cursor=nope",
      "?cursor=",
      `?cursor=ev_${"0".repeat(32)}`,
      `?cursor=qa_${"0".repeat(32)}`,
      `?cursor=qa_${"G".repeat(32)}`,
      `?cursor=${"qa_".repeat(40)}`,
      "?task=../x",
      "?bogus=1",
      "?limit=1&limit=2",
    ]) {
      const response = await get(`/api/evidence${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.text()).not.toContain("nope");
    }
  });
  it("lists flat artifact metadata with a cursor", async () => {
    const list = (await json("/api/evidence/artifacts")).body;
    expect(list.artifacts).toHaveLength(3);
    expect(list.artifacts[0]).toMatchObject({
      kind: "image",
      mime: "image/png",
      size: png.length,
      lane: "visual",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      createdAt: expect.any(String),
      url: expect.stringMatching(
        /^\/api\/evidence\/artifacts\/ev_[a-f0-9]{32}$/,
      ),
    });
    expect(list.artifacts.map((a: { run: string }) => a.run)).toContain(runA);
    const first = (await json("/api/evidence/artifacts?limit=2")).body;
    expect(first.artifacts).toHaveLength(2);
    const second = (
      await json(`/api/evidence/artifacts?limit=2&cursor=${first.nextCursor}`)
    ).body;
    expect(second.artifacts).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      (await json(`/api/evidence/artifacts?run=${runA}`)).body.artifacts.map(
        (a: { id: string }) => a.id,
      ),
    ).toEqual([artifactA]);
    expect(
      (await json("/api/evidence/artifacts?task=CP-2")).body.artifacts,
    ).toHaveLength(2);
    for (const query of [
      "?limit=0",
      "?limit=201",
      "?cursor=ev_" + "0".repeat(32),
      "?cursor=qa_" + "0".repeat(32),
      "?x=1",
    ])
      expect((await get(`/api/evidence/artifacts${query}`)).status, query).toBe(
        400,
      );
  });
  it("serves artifacts with sandboxing headers and exact bytes", async () => {
    const response = await get(`/api/evidence/artifacts/${artifactA}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="${artifactA}.png"`,
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    expect(
      (await get(`/api/evidence/artifacts/ev_${"0".repeat(32)}`)).status,
    ).toBe(404);
  });
  it("never serves an unrecognised type as anything but an opaque download", () => {
    for (const mime of [
      "text/html",
      "image/svg+xml",
      "application/javascript",
      "image/png; x=<script>",
      "__proto__",
    ]) {
      const headers = evidenceArtifactHeaders(mime, `ev_${"a".repeat(32)}`, 10);
      expect(headers["Content-Type"], mime).toBe("application/octet-stream");
      expect(headers["Content-Disposition"]).toMatch(/^attachment; /);
      expect(headers["Content-Security-Policy"]).toContain("sandbox");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });
});

/** A minimal event-stream reader over node:http, so headers and raw bytes are visible. */
function openStream(headers: Record<string, string> = auth) {
  return new Promise<{
    status: number;
    headers: IncomingMessage["headers"];
    text: () => string;
    events: (name: string) => string[];
    waitFor: (
      predicate: (text: string) => boolean,
      ms?: number,
    ) => Promise<void>;
    close: () => void;
  }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/events", headers },
      (res) => {
        let buffer = "";
        const watchers = new Set<() => void>();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          for (const watcher of [...watchers]) watcher();
        });
        res.on("error", () => {});
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => buffer,
          events: (name) =>
            buffer
              .split("\n\n")
              .filter((frame) => frame.includes(`event: ${name}\n`)),
          waitFor: (predicate, ms = 4000) =>
            new Promise<void>((done, fail) => {
              const timer = setTimeout(
                () => fail(new Error(`timed out; got ${buffer.slice(0, 300)}`)),
                ms,
              );
              const check = () => {
                if (!predicate(buffer)) return;
                clearTimeout(timer);
                watchers.delete(check);
                done();
              };
              watchers.add(check);
              check();
            }),
          close: () => {
            req.destroy();
            res.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/events", () => {
  it("streams an initial snapshot, then only real changes, with heartbeats", async () => {
    await rm_tasks();
    const stream = await openStream();
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers["content-type"]).toBe(
        "text/event-stream; charset=utf-8",
      );
      expect(stream.headers["cache-control"]).toContain("no-store");
      expect(stream.headers["content-security-policy"]).toContain(
        "default-src 'none'",
      );
      await stream.waitFor((t) => t.includes("event: snapshot"));
      expect(stream.text()).toMatch(/^retry: 3000\n\nevent: ping\n/);
      const first = stream.events("snapshot")[0] ?? "";
      expect(first).toMatch(/^id: [a-f0-9]{8}-1\n/);
      expect(
        JSON.parse(/^data: (.*)$/m.exec(first)?.[1] ?? "null"),
      ).toHaveProperty("tasks");
      // Unchanged board: heartbeats arrive, snapshots do not repeat.
      await stream.waitFor((t) => t.split("event: ping").length > 3);
      expect(stream.events("snapshot")).toHaveLength(1);
      // A real change produces exactly one more snapshot.
      mkdirSync(join(root, "tasks"), { recursive: true });
      writeFileSync(
        join(root, "tasks/P1-01.md"),
        "# P1-01 — Live change\nOwner lane: B. Status: queued\nGoal: x\n",
      );
      await stream.waitFor((t) => t.includes("Live change"));
      expect(stream.events("snapshot")).toHaveLength(2);
      expect(stream.events("snapshot")[1]).toMatch(/^id: [a-f0-9]{8}-2\n/);
    } finally {
      stream.close();
    }
  });

  it("replaces a snapshot above the size limit with a data-free resync event", async () => {
    const small = createDashboard(root, {
      session: { token },
      live: { intervalMs: 40, heartbeatMs: 120, maxEventBytes: 300 },
    });
    await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", resolve));
    const smallPort = (small.address() as AddressInfo).port;
    const received = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: smallPort,
          path: "/api/events",
          headers: auth,
        },
        (res) => {
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            if (buffer.split("event: ping").length > 3) {
              req.destroy();
              resolve(buffer);
            }
          });
          res.on("error", () => {});
        },
      );
      req.on("error", () => {});
      req.setTimeout(5000, () => reject(new Error("timed out")));
      req.end();
    });
    await new Promise<void>((resolve) => small.close(() => resolve()));
    expect(received).not.toContain("event: snapshot");
    const resyncs = received
      .split("\n\n")
      .filter((frame) => frame.includes("event: resync\n"));
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).not.toMatch(/^id:/m);
    expect(resyncs[0]).toContain("snapshot-too-large");
    expect(received).not.toContain('"tasks"');
  });

  it("honours Last-Event-ID and ignores a malformed one", async () => {
    const one = await openStream();
    let id = "";
    try {
      await one.waitFor((t) => t.includes("event: snapshot"));
      id = /^id: (.+)$/m.exec(one.events("snapshot").at(-1) ?? "")?.[1] ?? "";
    } finally {
      one.close();
    }
    const current = await openStream({ ...auth, "last-event-id": id });
    try {
      await current.waitFor((t) => t.includes("event: ping"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(current.events("snapshot")).toHaveLength(0);
    } finally {
      current.close();
    }
    const junk = await openStream({ ...auth, "last-event-id": "<script>" });
    try {
      await junk.waitFor((t) => t.includes("event: snapshot"));
    } finally {
      junk.close();
    }
  });

  it("emits a safe error event for an unreadable board, keeps the stream and recovers", async () => {
    const blocked = join(root, "tasks");
    rmSync(blocked, { recursive: true, force: true });
    writeFileSync(blocked, "not a directory");
    const stream = await openStream();
    try {
      await stream.waitFor((t) => t.includes("event: error"));
      const frame = stream.events("error")[0] ?? "";
      expect(JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "null")).toEqual({
        error:
          "Could not read coordination data. Check task cards and local board, then retry.",
      });
      expect(stream.text()).not.toContain(root);
      rmSync(blocked);
      await stream.waitFor((t) => t.includes("event: snapshot"));
      expect(stream.events("error")).toHaveLength(1);
    } finally {
      stream.close();
    }
  });

  it("limits concurrent streams and accepts new ones after a disconnect", async () => {
    const a = await openStream();
    const b = await openStream();
    try {
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const c = await openStream();
      expect(c.status).toBe(503);
      expect(c.headers["retry-after"]).toBe("5");
      c.close();
      a.close();
      let status = 0;
      for (let i = 0; i < 40 && status !== 200; i++) {
        const d = await openStream();
        status = d.status;
        d.close();
        if (status !== 200)
          await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(status).toBe(200);
    } finally {
      a.close();
      b.close();
    }
  });

  it("closes promptly with a stream open, ending the stream and its timers", async () => {
    const other = createDashboard(root, {
      session: { token },
      live: { intervalMs: 20, heartbeatMs: 40 },
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = (other.address() as AddressInfo).port;
    const ended = new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: otherPort,
          path: "/api/events",
          headers: auth,
        },
        (res) => {
          res.resume();
          res.on("close", () => resolve());
          res.on("error", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.setTimeout(5000, () => reject(new Error("never connected")));
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await new Promise<void>((resolve) => other.close(() => resolve()));
    await ended;
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("takes no query parameters", async () => {
    expect(await raw("/api/events?x=1", auth)).toBe(404);
  });
});

async function rm_tasks() {
  rmSync(join(root, "tasks"), { recursive: true, force: true });
}
