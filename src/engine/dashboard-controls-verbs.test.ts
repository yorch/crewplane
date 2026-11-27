import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlDirectory, ensureControlDirectory } from "../control.ts";
import { type Control, control } from "./control-policy.ts";
import { parseControlRequest } from "./dashboard/controls.ts";
import { createDashboard, newSessionToken } from "./dashboard.ts";
import { serve } from "./supervisor.ts";

/**
 * Operator verbs over `POST /api/control`. The CLI's own input shape (see the
 * control block in src/cli.ts) is the independent expectation: both sides must
 * end in the same `control()` value.
 */
const previousState = process.env.CREWPLANE_STATE_DIR;
const stateBase = mkdtempSync(join(tmpdir(), "crewplane-verbs-state-"));
process.env.CREWPLANE_STATE_DIR = stateBase;
const root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-verbs-")));
const controls = { token: "22222222-2222-4222-8222-222222222222" };
const session = { token: newSessionToken() };
const run = "1794100000001-00000000-0000-4000-8000-000000000001";
const pauseId = "00000000-0000-4000-8000-000000000002";
const sessionId = "sess_0123456789";
let server: ReturnType<typeof createDashboard>;
let url = "";
let dir = "";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
const uuid = () => crypto.randomUUID();
const headers = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  origin: url,
  "x-crewplane-token": controls.token,
  "x-crewplane-session": session.token,
  ...extra,
});
const post = (body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${url}/api/control`, {
    method: "POST",
    headers: headers(extra),
    body: JSON.stringify(body),
  });
const read = (path: string) =>
  fetch(`${url}${path}`, { headers: { "x-crewplane-session": session.token } });
const queued = () =>
  readdirSync(join(dir, "commands"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      id: name.replace(/\.json$/, ""),
      value: JSON.parse(
        readFileSync(join(dir, "commands", name), "utf8"),
      ) as Control,
    }));
const clear = () => {
  for (const name of readdirSync(join(dir, "commands")))
    rmSync(join(dir, "commands", name), { force: true });
};
const lane = (extra: object = {}) => ({
  enabled: true,
  harness: "codex",
  ...extra,
});
const writeRuntime = (state: object | null) => {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      version: 1,
      root,
      binary: "/bin/true",
      allowedTasks: [],
      maxParallel: 2,
      intervalSeconds: 10,
      maxRunMinutes: 10,
      maxRunsPerHour: 10,
      lanes: { builder: lane(), reviewer: lane(), idle: lane() },
    }),
  );
  if (state)
    writeFileSync(join(dir, "state.json"), JSON.stringify(state), {
      mode: 0o600,
    });
};
const record = (extra: object) => ({
  key: "builder:CP-101",
  lane: "builder",
  task: "CP-101",
  cwd: root,
  harness: "codex",
  status: "paused",
  reason: "x",
  seen: [],
  runs: [],
  noProgress: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...extra,
});
const state = (extra: object = {}) => ({
  version: 2,
  running: true,
  checkedAt: new Date().toISOString(),
  pid: process.pid,
  generation: "gen-current",
  draining: false,
  held: [],
  commands: [],
  notices: {},
  laneRev: { builder: 4 },
  records: {},
  ...extra,
});

beforeAll(async () => {
  writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: verbs fixture");
  dir = controlDirectory(root);
  await ensureControlDirectory(dir);
  mkdirSync(join(dir, "commands"), { recursive: true, mode: 0o700 });
  writeRuntime(state());
  server = createDashboard(root, { controls, session });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(stateBase, { recursive: true, force: true });
  if (previousState === undefined) delete process.env.CREWPLANE_STATE_DIR;
  else process.env.CREWPLANE_STATE_DIR = previousState;
});

// [name, dashboard request, the control() input the CLI builds for the same intent]
const accepted: Array<
  [string, Record<string, unknown>, Record<string, unknown>]
> = [
  [
    "pause lane",
    { action: "pause", lane: "builder" },
    { action: "pause", lane: "builder" },
  ],
  [
    "resume lane",
    { action: "resume", lane: "builder", expectRev: 4, requestId: uuid() },
    { action: "resume", lane: "builder", expectRev: 4 },
  ],
  [
    "retry lane",
    { action: "retry", lane: "builder", expectRev: 4, requestId: uuid() },
    { action: "retry", lane: "builder", expectRev: 4 },
  ],
  [
    "retry lane with note",
    {
      action: "retry",
      lane: "builder",
      expectRev: 4,
      text: "fixed the fixture",
      requestId: uuid(),
    },
    {
      action: "retry",
      lane: "builder",
      expectRev: 4,
      text: "fixed the fixture",
    },
  ],
  [
    "retry confirm cleanup",
    {
      action: "retry",
      lane: "builder",
      task: "CP-101",
      confirmCleanup: true,
      text: "worktree inspected",
      expectRev: 4,
      expectRun: run,
      requestId: uuid(),
    },
    {
      action: "retry",
      lane: "builder",
      task: "CP-101",
      confirmCleanup: true,
      text: "worktree inspected",
      expectRev: 4,
      expectRun: run,
    },
  ],
  [
    "retry new session",
    {
      action: "retry",
      lane: "builder",
      task: "CP-101",
      newSession: true,
      text: "stuck in a loop",
      expectRev: 4,
      expectSession: sessionId,
      requestId: uuid(),
    },
    {
      action: "retry",
      lane: "builder",
      task: "CP-101",
      newSession: true,
      text: "stuck in a loop",
      expectRev: 4,
      expectSession: sessionId,
    },
  ],
  [
    "resolve approve",
    {
      action: "resolve",
      lane: "builder",
      task: "CP-101",
      pauseId,
      resolution: "approve",
      text: "go ahead",
      expectRev: 4,
      requestId: uuid(),
    },
    {
      action: "resolve",
      lane: "builder",
      task: "CP-101",
      pauseId,
      resolution: "approve",
      text: "go ahead",
      expectRev: 4,
    },
  ],
  [
    "resolve deny without task",
    {
      action: "resolve",
      lane: "builder",
      pauseId,
      resolution: "deny",
      text: "not now",
      expectRev: 4,
      requestId: uuid(),
    },
    {
      action: "resolve",
      lane: "builder",
      pauseId,
      resolution: "deny",
      text: "not now",
      expectRev: 4,
    },
  ],
  [
    "nudge",
    {
      action: "nudge",
      lane: "builder",
      text: "look at CP-102",
      requestId: uuid(),
    },
    { action: "nudge", lane: "builder", text: "look at CP-102" },
  ],
  [
    "nudge task",
    {
      action: "nudge",
      lane: "builder",
      task: "CP-101",
      text: "look",
      requestId: uuid(),
    },
    { action: "nudge", lane: "builder", task: "CP-101", text: "look" },
  ],
  [
    "cancel run",
    { action: "cancel", lane: "builder", run },
    { action: "cancel", lane: "builder", run },
  ],
  ["stop", { action: "stop" }, { action: "stop" }],
];

describe("verb parity with the CLI path", () => {
  it.each(accepted)(
    "%s queues exactly what control() accepts",
    async (_n, body, cli) => {
      clear();
      const response = await post(body);
      expect(response.status).toBe(200);
      const answer = (await response.json()) as Record<string, unknown>;
      // Queued, never applied: the supervisor alone records an outcome.
      expect(answer.status).toBe("queued");
      expect(answer.outcome).toBeNull();
      expect(answer.queued).toBe(body.action);
      const [file] = queued();
      expect(file?.id).toBe(answer.id);
      const expected = control({
        ...cli,
        v: 2,
        generation: "gen-current",
        issuer: "dashboard",
        at: file?.value.at,
      });
      expect(expected.action).not.toBe("invalid");
      expect(file?.value).toEqual(expected);
    },
  );
  it("is the same validator the CLI uses: every dashboard-valid request is control()-valid", () => {
    for (const [, body] of accepted) {
      const parsed = parseControlRequest(body, {
        lanes: ["builder"],
        generation: undefined,
        at: new Date().toISOString(),
      });
      expect(parsed.ok).toBe(true);
    }
  });
});

describe("pins and notes", () => {
  const refused: Array<[string, Record<string, unknown>, number, string]> = [
    [
      "resume without expectRev",
      { action: "resume", lane: "builder", requestId: uuid() },
      400,
      "PIN_REQUIRED",
    ],
    [
      "retry without expectRev",
      { action: "retry", lane: "builder", requestId: uuid() },
      400,
      "PIN_REQUIRED",
    ],
    [
      "resolve without expectRev",
      {
        action: "resolve",
        lane: "builder",
        pauseId,
        resolution: "approve",
        text: "ok",
        requestId: uuid(),
      },
      400,
      "PIN_REQUIRED",
    ],
    [
      "cleanup without expectRun",
      {
        action: "retry",
        lane: "builder",
        task: "CP-101",
        confirmCleanup: true,
        text: "n",
        expectRev: 4,
        requestId: uuid(),
      },
      400,
      "PIN_REQUIRED",
    ],
    [
      "new session without expectSession",
      {
        action: "retry",
        lane: "builder",
        task: "CP-101",
        newSession: true,
        text: "n",
        expectRev: 4,
        requestId: uuid(),
      },
      400,
      "PIN_REQUIRED",
    ],
    [
      "new session without note",
      {
        action: "retry",
        lane: "builder",
        task: "CP-101",
        newSession: true,
        expectRev: 4,
        expectSession: sessionId,
        requestId: uuid(),
      },
      400,
      "NOTE_REQUIRED",
    ],
    [
      "cleanup with blank note",
      {
        action: "retry",
        lane: "builder",
        task: "CP-101",
        confirmCleanup: true,
        text: "  ",
        expectRev: 4,
        expectRun: run,
        requestId: uuid(),
      },
      400,
      "NOTE_REQUIRED",
    ],
    [
      "resolve without note",
      {
        action: "resolve",
        lane: "builder",
        pauseId,
        resolution: "deny",
        expectRev: 4,
        requestId: uuid(),
      },
      400,
      "NOTE_REQUIRED",
    ],
    [
      "nudge without note",
      { action: "nudge", lane: "builder", requestId: uuid() },
      400,
      "NOTE_REQUIRED",
    ],
    [
      "nudge without requestId",
      { action: "nudge", lane: "builder", text: "x" },
      400,
      "REQUEST_ID_REQUIRED",
    ],
    [
      "resume without requestId",
      { action: "resume", lane: "builder", expectRev: 4 },
      400,
      "REQUEST_ID_REQUIRED",
    ],
    [
      "resume all",
      { action: "resume", all: true, expectRev: 4, requestId: uuid() },
      400,
      "CLI_ONLY",
    ],
    ["rollout", { action: "rollout" }, 400, "CLI_ONLY"],
    [
      "stop with cancelActive",
      { action: "stop", cancelActive: true },
      400,
      "CLI_ONLY",
    ],
    ["unknown action", { action: "format-disk" }, 400, "UNSUPPORTED_ACTION"],
    [
      "unknown field",
      { action: "pause", lane: "builder", issuer: "cli" },
      400,
      "UNKNOWN_FIELD",
    ],
    [
      "unknown agent",
      { action: "nudge", lane: "ghost", text: "x", requestId: uuid() },
      400,
      "UNKNOWN_AGENT",
    ],
    ["wrong type", { action: "pause", lane: 7 }, 400, "INVALID_CONTROL"],
    [
      "confirmCleanup with newSession",
      {
        action: "retry",
        lane: "builder",
        task: "CP-101",
        confirmCleanup: true,
        newSession: true,
        text: "n",
        expectRev: 4,
        expectRun: run,
        expectSession: sessionId,
        requestId: uuid(),
      },
      400,
      "INVALID_CONTROL",
    ],
    [
      "bad requestId",
      { action: "nudge", lane: "builder", text: "x", requestId: "nope" },
      400,
      "INVALID_CONTROL",
    ],
    [
      "bad resolution",
      {
        action: "resolve",
        lane: "builder",
        pauseId,
        resolution: "maybe",
        text: "x",
        expectRev: 4,
        requestId: uuid(),
      },
      400,
      "INVALID_CONTROL",
    ],
    [
      "oversized note",
      {
        action: "nudge",
        lane: "builder",
        text: "x".repeat(2001),
        requestId: uuid(),
      },
      400,
      "NOTE_TOO_LONG",
    ],
  ];
  it.each(refused)("refuses %s", async (_n, body, status, code) => {
    clear();
    const response = await post(body);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { code: string }).code).toBe(code);
    expect(queued()).toEqual([]);
  });
  it("refuses malformed and oversized bodies", async () => {
    clear();
    const bad = await fetch(`${url}/api/control`, {
      method: "POST",
      headers: headers(),
      body: "{nope",
    });
    expect(bad.status).toBe(400);
    const big = await fetch(`${url}/api/control`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ action: "nudge", text: "x".repeat(5000) }),
    });
    expect(big.status).toBe(413);
    expect(queued()).toEqual([]);
  });
});

describe("authority", () => {
  const body = { action: "nudge", lane: "builder", text: "x" };
  it("needs the controls token, exact Origin and JSON; the session token alone is not enough", async () => {
    clear();
    const withToken = { ...body, requestId: uuid() };
    expect((await post(withToken, { "x-crewplane-token": "" })).status).toBe(
      403,
    );
    expect(
      (await post(withToken, { "x-crewplane-token": session.token })).status,
    ).toBe(403);
    expect(
      (await post(withToken, { origin: "http://evil.invalid" })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/control`, {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            origin: url,
            "x-crewplane-token": controls.token,
          },
          body: JSON.stringify(withToken),
        })
      ).status,
    ).toBe(403);
    expect(queued()).toEqual([]);
  });
  it("is disabled without --controls: no queueing, no capability, no token", async () => {
    clear();
    const off = createDashboard(root, { session });
    await new Promise<void>((resolve) => off.listen(0, "127.0.0.1", resolve));
    const address = off.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const refused = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { ...headers(), origin: base },
        body: JSON.stringify({ action: "pause", lane: "builder" }),
      });
      expect(refused.status).toBe(403);
      const view = await fetch(`${base}/api/controls`, {
        headers: { "x-crewplane-session": session.token },
      });
      expect(await view.json()).toEqual({ version: 1, enabled: false });
      expect(queued()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => off.close(() => resolve()));
    }
  });
  it("requires the read session for the capability block and never leaks the controls token", async () => {
    expect((await fetch(`${url}/api/controls`)).status).toBe(401);
    const response = await read("/api/controls");
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(controls.token);
    expect((await read("/api/controls?x=1")).status).toBe(400);
  });
});

describe("replay and rate limit", () => {
  it("answers a repeated requestId from one queued command", async () => {
    clear();
    const body = {
      action: "nudge",
      lane: "builder",
      text: "once",
      requestId: uuid(),
    };
    const first = (await (await post(body)).json()) as Record<string, unknown>;
    const second = (await (await post(body)).json()) as Record<string, unknown>;
    expect(second.id).toBe(first.id);
    expect(second.replay).toBe(true);
    expect(first.replay).toBeUndefined();
    expect(queued()).toHaveLength(1);
    const clash = await post({ ...body, text: "different" });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { code: string }).code).toBe(
      "REQUEST_ID_REUSED",
    );
    expect(queued()).toHaveLength(1);
  });
  it("detects a replay by another process through the exclusive create", async () => {
    clear();
    const id = uuid();
    const body = {
      action: "nudge",
      lane: "builder",
      text: "shared",
      requestId: id,
    };
    expect((await post(body)).status).toBe(200);
    // A fresh dashboard has no memory of the first request.
    const other = createDashboard(root, { controls, session });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const address = other.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const again = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { ...headers(), origin: base },
        body: JSON.stringify(body),
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { replay: boolean }).replay).toBe(true);
      expect(queued()).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
  it("does not requeue an id the supervisor already consumed", async () => {
    clear();
    const id = uuid();
    writeRuntime(state({ commands: [`${id}.json`] }));
    try {
      const response = await post({
        action: "nudge",
        lane: "builder",
        text: "late",
        requestId: id,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { replay: boolean }).replay).toBe(
        true,
      );
      expect(queued()).toEqual([]);
    } finally {
      writeRuntime(state());
    }
  });
  it("limits queued commands per minute and caps the pending queue", async () => {
    clear();
    let now = 1_000_000;
    const limited = createDashboard(root, {
      controls,
      session,
      controlGuard: { perMinute: 2, maxPending: 5, now: () => now },
    });
    await new Promise<void>((resolve) =>
      limited.listen(0, "127.0.0.1", resolve),
    );
    const address = limited.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    const send = () =>
      fetch(`${base}/api/control`, {
        method: "POST",
        headers: { ...headers(), origin: base },
        body: JSON.stringify({ action: "pause", lane: "builder" }),
      });
    try {
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      const limitedResponse = await send();
      expect(limitedResponse.status).toBe(429);
      expect(
        Number(limitedResponse.headers.get("retry-after")),
      ).toBeGreaterThan(0);
      expect(((await limitedResponse.json()) as { code: string }).code).toBe(
        "RATE_LIMITED",
      );
      expect(queued()).toHaveLength(2);
      now += 61_000;
      expect((await send()).status).toBe(200);
      for (let i = 0; i < 3; i++)
        writeFileSync(join(dir, "commands", `${uuid()}.json`), "{}");
      now += 61_000;
      const full = await send();
      expect(full.status).toBe(429);
      expect(((await full.json()) as { code: string }).code).toBe("QUEUE_FULL");
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });
});

describe("no supervisor", () => {
  it("queues bound to the generation, warns, and never starts or writes supervision state", async () => {
    clear();
    writeRuntime(
      state({
        running: false,
        checkedAt: "2000-01-01T00:00:00.000Z",
        pid: 2 ** 22 + 99,
      }),
    );
    const before = readFileSync(join(dir, "state.json"), "utf8");
    try {
      const response = await post({
        action: "retry",
        lane: "builder",
        expectRev: 4,
        requestId: uuid(),
      });
      expect(response.status).toBe(200);
      const answer = (await response.json()) as {
        supervisor: string;
        warning: string;
      };
      expect(answer.supervisor).toBe("not-running");
      expect(answer.warning).toContain("refused as stale by the next start");
      expect(queued()[0]?.value.generation).toBe("gen-current");
      expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
      expect(readdirSync(dir)).not.toContain("desired.json");
      const pause = (await (
        await post({ action: "pause", lane: "builder" })
      ).json()) as { warning: string };
      expect(pause.warning).toContain("pause applies when a supervisor starts");
    } finally {
      writeRuntime(state());
    }
  });
});

describe("capability block", () => {
  it("derives per-lane verbs and pins from the persisted state", async () => {
    writeRuntime(
      state({
        held: ["reviewer"],
        records: {
          "builder:CP-101": record({
            status: "paused",
            pauseKind: "decision",
            pauseId,
            sessionId,
            runId: run,
          }),
          "builder:CP-102": record({
            key: "builder:CP-102",
            task: "CP-102",
            status: "running",
            pid: process.pid,
            runId: "1794100000002-00000000-0000-4000-8000-000000000001",
          }),
        },
      }),
    );
    try {
      const view = (await (await read("/api/controls")).json()) as {
        enabled: boolean;
        verbs: string[];
        cliOnly: Array<{ verb: string }>;
        supervisor: { running: boolean };
        lanes: Array<{
          lane: string;
          rev: number;
          verbs: string[];
          tasks: Array<{
            task: string;
            verbs: string[];
            pauseId: string | null;
          }>;
        }>;
      };
      expect(view.enabled).toBe(true);
      expect(view.verbs).toEqual([
        "pause",
        "resume",
        "retry",
        "resolve",
        "nudge",
        "cancel",
        "stop",
      ]);
      expect(view.cliOnly.map((c) => c.verb)).toContain("rollout");
      expect(view.supervisor.running).toBe(true);
      const builder = view.lanes.find((l) => l.lane === "builder");
      const reviewer = view.lanes.find((l) => l.lane === "reviewer");
      expect(builder?.rev).toBe(4);
      expect(builder?.verbs).toContain("pause");
      expect(builder?.verbs).not.toContain("resume");
      expect(reviewer?.verbs).toContain("resume");
      expect(reviewer?.verbs).not.toContain("pause");
      expect(builder?.tasks.find((t) => t.task === "CP-101")?.verbs).toEqual([
        "resolve",
      ]);
      expect(builder?.tasks.find((t) => t.task === "CP-102")?.verbs).toEqual([
        "cancel",
      ]);
    } finally {
      writeRuntime(state());
    }
  });
});

describe("through a real supervisor", () => {
  it("records exactly one outcome per command: applied, then stale for the replayed pin", async () => {
    clear();
    const controller = new AbortController();
    const config = {
      version: 1 as const,
      root,
      binary: process.execPath,
      allowedTasks: [],
      maxParallel: 2,
      intervalSeconds: 1,
      maxRunMinutes: 1,
      maxRunsPerHour: 20,
      confirmedStoppedAt: new Date().toISOString(),
      lanes: { coordinator: { enabled: false }, builder: lane() },
    };
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify(
        state({
          running: false,
          generation: undefined,
          records: {
            "builder:CP-101": record({
              status: "paused",
              pauseKind: "decision",
              pauseId,
              sessionId,
            }),
          },
        }),
      ),
    );
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const supervisor = serve(
      config as unknown as Parameters<typeof serve>[0],
      dir,
      controller.signal,
    );
    const log = async () =>
      (
        (await (await read("/api/control-log?limit=200")).json()) as {
          entries: Array<{ id: string; outcome: string; reason: string }>;
        }
      ).entries;
    const until = async <T>(check: () => Promise<T | undefined>) => {
      const deadline = Date.now() + 9000;
      for (;;) {
        const value = await check();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error("supervisor did not answer");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      const generation = await until(async () => {
        const current = JSON.parse(
          readFileSync(join(dir, "state.json"), "utf8"),
        ) as {
          generation?: string;
          running?: boolean;
        };
        return current.running && current.generation
          ? current.generation
          : undefined;
      });
      expect(generation).toBeTruthy();
      const rev = (
        (await (await read("/api/controls")).json()) as {
          lanes: Array<{ lane: string; rev: number }>;
        }
      ).lanes.find((l) => l.lane === "builder")?.rev as number;
      const stale = await post({
        action: "resolve",
        lane: "builder",
        task: "CP-101",
        pauseId,
        resolution: "approve",
        text: "too late",
        expectRev: rev + 5,
        requestId: uuid(),
      });
      const staleId = ((await stale.json()) as { id: string }).id;
      const good = await post({
        action: "resolve",
        lane: "builder",
        task: "CP-101",
        pauseId,
        resolution: "approve",
        text: "approved after review",
        expectRev: rev,
        requestId: uuid(),
      });
      const goodId = ((await good.json()) as { id: string }).id;
      const staleEntry = await until(async () =>
        (await log()).find((e) => e.id === staleId),
      );
      const goodEntry = await until(async () =>
        (await log()).find((e) => e.id === goodId),
      );
      expect(staleEntry).toMatchObject({
        outcome: "stale",
        reason: "STALE_REVISION",
      });
      expect(goodEntry).toMatchObject({
        outcome: "applied",
        reason: "APPROVED",
      });
      // The same pin cannot lift anything twice: the revision moved.
      const again = await post({
        action: "resolve",
        lane: "builder",
        task: "CP-101",
        pauseId,
        resolution: "approve",
        text: "again",
        expectRev: rev,
        requestId: uuid(),
      });
      const againId = ((await again.json()) as { id: string }).id;
      const againEntry = await until(async () =>
        (await log()).find((e) => e.id === againId),
      );
      expect(againEntry.outcome).toBe("stale");
      expect((await log()).filter((e) => e.id === goodId)).toHaveLength(1);
    } finally {
      controller.abort();
      await supervisor.catch(() => {});
    }
  }, 30000);
});
