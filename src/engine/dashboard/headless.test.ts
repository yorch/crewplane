import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Config, State } from "../supervisor.ts";
import { projectHeadless, readHeadless } from "./headless.ts";

const now = Date.parse("2026-11-08T01:00:00Z");
const config: Config = {
  version: 1,
  root: "/synthetic",
  binary: "/synthetic/codex",
  allowedTasks: ["P1-06"],
  maxParallel: 4,
  intervalSeconds: 10,
  maxRunMinutes: 25,
  maxRunsPerHour: 20,
  confirmedStoppedAt: "2026-11-08T00:00:00Z",
  lanes: {
    coordinator: { enabled: true },
    B: { enabled: true, model: "configured-test-model" },
  },
};
const state: State = {
  version: 1,
  running: true,
  checkedAt: new Date(now).toISOString(),
  pid: 100,
  draining: false,
  held: ["coordinator"],
  commands: ["private-command"],
  notices: { coordinator: ["private-notice"] },
  records: {
    b: {
      key: "b",
      lane: "B",
      task: "P1-06",
      cwd: "/synthetic/b",
      sessionId: "synthetic-session",
      status: "running",
      reason: "Verification",
      pid: 101,
      seen: ["private-event"],
      startedAt: new Date(now - 60000).toISOString(),
      runs: [now - 7200000, now - 60000],
      noProgress: 0,
      inputTokens: 120,
      outputTokens: 30,
      inputTokensKnown: true,
      outputTokensKnown: true,
      summary: "private-summary",
    },
  },
};
it("projects standby/configuration, live process observations and bounded usage without private state", () => {
  const result = projectHeadless(config, state, now, () => true);
  expect(result.lanes).toHaveLength(2);
  expect(result.lanes.find((r) => r.lane === "coordinator")?.status).toBe(
    "paused",
  );
  expect(result.lanes.some((r) => r.lane === "C")).toBe(false);
  expect(result.lanes.some((r) => r.lane === "visual")).toBe(false);
  const b = result.lanes.find((r) => r.lane === "B");
  expect(b).toMatchObject({
    status: "running",
    configuredModel: "configured-test-model",
    observedModel: null,
    sessionId: "synthetic-session",
    usage: { inputTokens: 120, outputTokens: 30, runsLastHour: 1 },
  });
  expect(result.lanes[0]?.configuredModel).toBe("CLI default (unspecified)");
  expect(JSON.stringify(result)).not.toMatch(
    /private-|allowedTasks|binary|confirmedStopped/,
  );
  expect(result.budgets?.maxParallel).toBe(4);
});
it("does not claim model/process activity from stale heartbeats, dead or inaccessible PIDs", () => {
  for (const alive of [false, null]) {
    expect(
      projectHeadless(config, state, now, () => alive).lanes[1]?.status,
    ).toBe("stale");
  }
  const stale = projectHeadless(config, state, now + 60000, () => true);
  expect(stale.state).toBe("stale");
  expect(stale.lanes[1]?.status).toBe("stale");
  expect(
    projectHeadless(config, { ...state, running: false }, now, () => true)
      .lanes[1]?.status,
  ).toBe("stale");
  expect(projectHeadless(config, null, now).lanes[1]?.status).toBe("idle");
  expect(projectHeadless(null, null, now).state).toBe("not-started");
});

it("keeps an intentionally stopped supervisor stopped after its final heartbeat ages", () => {
  const stopped = { ...state, running: false, draining: true, records: {} };
  for (const elapsed of [0, 60000, 86400000])
    expect(projectHeadless(config, stopped, now + elapsed).state).toBe(
      "stopped",
    );
  expect(
    projectHeadless(config, { ...stopped, running: true }, now + 60000).state,
  ).toBe("stale");
});

it("distinguishes absent supervisor state from unreadable or corrupt private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-sessions-"));
  try {
    expect((await readHeadless(root)).state).toBe("not-started");
    await mkdir(join(root, "supervisor"));
    await writeFile(
      join(root, "supervisor/config.json"),
      JSON.stringify(config),
    );
    expect((await readHeadless(root)).lanes[1]?.configuredModel).toBe(
      "configured-test-model",
    );
    await writeFile(
      join(root, "supervisor/state.json"),
      "private-invalid-json",
    );
    const broken = await readHeadless(root);
    expect(broken.state).toBe("unavailable");
    expect(JSON.stringify(broken)).not.toContain("private-invalid-json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("labels configured harness/model separately from legacy native observations", () => {
  const changed: Config = {
    ...config,
    lanes: {
      B: {
        enabled: true,
        harness: "pi",
        piPermissions: "no-tools",
        sessionEpoch: "new",
        piModel: { provider: "synthetic", id: "fixture" },
      },
    },
  };
  const b = projectHeadless(changed, state, now, () => true).lanes.find(
    (r) => r.lane === "B",
  );
  expect(b).toMatchObject({
    configuredHarness: "pi",
    observedHarness: "codex",
    configuredModel: "synthetic/fixture",
    observedModel: null,
  });
});

it("projects only fixed reload outcomes and safe error codes", () => {
  const observed = {
    ...state,
    configReload: {
      outcome: "invalid" as const,
      errorCode: "INVALID_CONFIG",
      evaluatedAt: new Date(now).toISOString(),
      private: "SECRET_SENTINEL",
    },
  };
  expect(projectHeadless(config, observed, now).configReload).toEqual({
    outcome: "invalid",
    errorCode: "INVALID_CONFIG",
    evaluatedAt: new Date(now).toISOString(),
  });
  observed.configReload.errorCode = "SECRET_SENTINEL";
  expect(
    JSON.stringify(projectHeadless(config, observed, now).configReload),
  ).not.toContain("SECRET_SENTINEL");
});

it("retains runtime reload errors while disk JSON is malformed and recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-reload-reader-"));
  try {
    await mkdir(join(root, "supervisor"));
    const checkedAt = new Date().toISOString();
    await writeFile(
      join(root, "supervisor/state.json"),
      JSON.stringify({
        ...state,
        checkedAt,
        configReload: {
          outcome: "invalid",
          errorCode: "INVALID_CONFIG",
          evaluatedAt: checkedAt,
        },
      }),
    );
    await writeFile(
      join(root, "supervisor/config.json"),
      "{PRIVATE_INVALID_SENTINEL",
    );
    const broken = await readHeadless(root);
    expect(broken.state).toBe("running");
    expect(broken.checkedAt).toBe(checkedAt);
    expect(broken.diskConfigAvailable).toBe(false);
    expect(broken.configReload?.errorCode).toBe("INVALID_CONFIG");
    expect(broken.lanes.find((lane) => lane.lane === "B")?.task).toBe("P1-06");
    expect(JSON.stringify(broken)).not.toContain("PRIVATE_INVALID_SENTINEL");
    await writeFile(
      join(root, "supervisor/config.json"),
      JSON.stringify(config),
    );
    const recovered = await readHeadless(root);
    expect(recovered.diskConfigAvailable).toBe(true);
    expect(recovered.checkedAt).toBe(checkedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("shows loaded budgets and a precise hourly wait instead of implying the configured limit is active", () => {
  const now = Date.now();
  const cfg = structuredClone(config);
  const runtime = structuredClone(state);
  runtime.checkedAt = new Date(now).toISOString();
  runtime.held = [];
  runtime.scheduling = {
    fingerprint: "a".repeat(64),
    allowedTasks: [],
    enabledLanes: ["coordinator"],
    maxParallel: 4,
    maxRunsPerHour: 2,
    maxRunMinutes: 25,
    intervalSeconds: 10,
  };
  const base = Object.values(runtime.records)[0];
  if (!base) throw Error("Fixture");
  runtime.records = {
    coordinator: {
      ...base,
      key: "coordinator",
      lane: "coordinator",
      status: "idle",
      runs: [now - 20000, now - 10000],
    },
  };
  const projected = projectHeadless(
    { ...cfg, maxRunsPerHour: 60 },
    runtime,
    now,
    () => false,
  );
  expect(projected.budgetsSource).toBe("loaded");
  expect(projected.budgets?.maxRunsPerHour).toBe(2);
  expect(
    projected.lanes.find((l) => l.lane === "coordinator")?.scheduling,
  ).toMatchObject({
    code: "RATE_LIMITED",
    nextEligibleAt: new Date(now - 20000 + 3600000).toISOString(),
  });
});

it("keeps unreported and legacy usage unknown while preserving explicitly reported zero", () => {
  const missing = structuredClone(state);
  const record = missing.records.b;
  if (!record) throw Error("Missing fixture");
  delete record.inputTokensKnown;
  delete record.outputTokensKnown;
  record.inputTokens = 0;
  record.outputTokens = 0;
  const unknown = projectHeadless(config, missing, now, () => true).lanes.find(
    (r) => r.lane === "B",
  );
  expect(unknown?.usage).toMatchObject({
    inputTokens: null,
    outputTokens: null,
  });
  record.inputTokensKnown = true;
  record.outputTokensKnown = true;
  expect(
    projectHeadless(config, missing, now, () => true).lanes.find(
      (r) => r.lane === "B",
    )?.usage,
  ).toMatchObject({ inputTokens: 0, outputTokens: 0 });
});
