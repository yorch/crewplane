import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertSwitch, type Harness } from "../engine/harness.ts";
import { validateConfig } from "../engine/supervisor.ts";
import { loadPrior, noPrior, planEpochs } from "./epochs.ts";
import {
  buildConfig,
  defaultClaudeSettings,
  defaultLimits,
  laneHarnesses,
  roleHarnesses,
  type SetupAnswers,
  type SetupPolicy,
} from "./templates.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), "crewplane-epochs-"));
  scratch.push(path);
  return path;
};
const policy: SetupPolicy = {
  coordinator: "captain",
  reviewers: ["inspector"],
  reviewerRoles: { inspector: "code" },
};
let n = 0;
const mint = () => `e${++n}`;

it("reads the installed config and the latest record per lane, read-only", async () => {
  const directory = dir();
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({
      lanes: {
        captain: { harness: "claude", sessionEpoch: "old-1" },
        builder: {},
        weird: { harness: "no-such" },
      },
    }),
  );
  writeFileSync(
    join(directory, "state.json"),
    JSON.stringify({
      running: false,
      records: {
        a: {
          lane: "builder",
          harness: "opencode",
          startedAt: "2026-01-01T00:00:00Z",
          status: "idle",
        },
        b: {
          lane: "builder",
          harness: "claude",
          sessionEpoch: "rec-2",
          startedAt: "2026-02-01T00:00:00Z",
          status: "running",
          pid: 12,
        },
      },
    }),
  );
  expect(await loadPrior(directory)).toEqual({
    config: {
      captain: { harness: "claude", sessionEpoch: "old-1" },
      builder: { harness: "codex" },
    },
    records: {
      builder: { harness: "claude", sessionEpoch: "rec-2", busy: true },
    },
  });
  expect(await loadPrior(join(directory, "absent"))).toEqual(noPrior);
  writeFileSync(join(directory, "state.json"), "{not json");
  await expect(loadPrior(directory)).rejects.toThrow(/Invalid private state/);
});

it("plans a fresh epoch only for lanes whose harness changed and keeps prior epochs", () => {
  n = 0;
  const lanes: Record<string, Harness> = {
    captain: "claude",
    builder: "claude",
    inspector: "pi",
    fresh: "codex",
  };
  const plan = planEpochs(
    lanes,
    {
      config: {
        captain: { harness: "codex" },
        builder: { harness: "claude", sessionEpoch: "keep-1" },
        inspector: { harness: "claude" },
      },
      records: { captain: { harness: "codex", busy: true } },
    },
    mint,
  );
  // Pi lanes are planned like any other; unknown lanes need nothing.
  expect(plan.epochs).toEqual({
    captain: "e1",
    builder: "keep-1",
    inspector: "e2",
  });
  expect(plan.notes).toHaveLength(3);
  expect(plan.notes[2]).toMatch(
    /lane inspector switches harness from claude to pi/,
  );
  expect(plan.notes[0]).toMatch(
    /lane captain switches harness from codex to claude/,
  );
  expect(plan.notes[1]).toMatch(
    /lane captain has a prior record that is not idle/,
  );
});

it("a rerun with a different harness yields lanes the supervisor's own switch check accepts", () => {
  // The real engine contract: assertSwitch (used by serve) and validateConfig.
  for (const target of ["codex", "claude", "opencode"] as const) {
    const roles = roleHarnesses(target);
    const answers: SetupAnswers = {
      roles,
      binaries: { [target]: process.execPath },
      models: { claude: "opus", opencode: "p/m" },
      claude: { ...defaultClaudeSettings },
      allowedTasks: ["T-1"],
      implementers: ["dev"],
      limits: defaultLimits(),
      confirmedStoppedAt: "2026-11-08T00:00:00.000Z",
    };
    const previous: Harness = target === "codex" ? "claude" : "codex";
    const prior = {
      config: {},
      records: {
        captain: { harness: previous },
        dev: { harness: previous },
        inspector: { harness: previous },
      },
    };
    const plan = planEpochs(laneHarnesses(answers, policy), prior, mint);
    const { config } = buildConfig(
      { ...answers, laneEpochs: plan.epochs },
      policy,
    );
    const decoded = validateConfig({
      ...config,
      root: process.cwd(),
      coordinator: "captain",
      reviewers: ["inspector"],
    } as never);
    for (const lane of Object.values(decoded.lanes))
      expect(() =>
        assertSwitch(
          lane,
          { harness: previous, status: "idle" } as never,
          false,
        ),
      ).not.toThrow();
    // Without the plan the very same lanes are refused: the finding.
    const bare = buildConfig(answers, policy).config as {
      lanes: Record<string, never>;
    };
    expect(() =>
      assertSwitch(
        bare.lanes.dev as never,
        { harness: previous, status: "idle" } as never,
        false,
      ),
    ).toThrow(/fresh explicit sessionEpoch/);
  }
});

const rec = (harness: Harness, sessionEpoch?: string, status = "idle") =>
  ({
    harness,
    status,
    ...(sessionEpoch ? { sessionEpoch } : {}),
  }) as never;
const laneOf = (harness: Harness, sessionEpoch?: string) =>
  ({ harness, ...(sessionEpoch ? { sessionEpoch } : {}) }) as never;

it("compares only against the latest record: codex -> claude (never served) -> codex after a crashed run", () => {
  n = 0;
  // The installed config says claude with an epoch, but the supervisor only
  // ever ran codex (no epoch) and that run crashed (status is not idle).
  const plan = planEpochs(
    { captain: "codex" },
    {
      config: { captain: { harness: "claude", sessionEpoch: "never-served" } },
      records: { captain: { harness: "codex", busy: true } },
    },
    mint,
  );
  expect(plan.epochs).toEqual({});
  expect(plan.notes).toEqual([]);
  // The engine's own check: same harness, same (absent) epoch, crashed record.
  expect(() =>
    assertSwitch(laneOf("codex"), rec("codex", undefined, "failed"), false),
  ).not.toThrow();
  // Before the fix a fresh epoch was minted and the very same record refused it.
  expect(() =>
    assertSwitch(
      laneOf("codex", "e-minted"),
      rec("codex", undefined, "failed"),
      false,
    ),
  ).toThrow(/fresh explicit sessionEpoch/);
  // With a record that has an epoch, that epoch (not the config's) is reused.
  const reuse = planEpochs(
    { captain: "claude" },
    {
      config: { captain: { harness: "claude", sessionEpoch: "config-1" } },
      records: { captain: { harness: "claude", sessionEpoch: "rec-1" } },
    },
    mint,
  );
  expect(reuse.epochs).toEqual({ captain: "rec-1" });
  // Without any record the installed config decides.
  const configOnly = planEpochs(
    { captain: "codex", other: "claude" },
    {
      config: {
        captain: { harness: "claude", sessionEpoch: "c-1" },
        other: { harness: "claude", sessionEpoch: "c-2" },
      },
      records: {},
    },
    mint,
  );
  expect(configOnly.epochs).toEqual({ captain: "e1", other: "c-2" });
});

it("plans Pi lanes: notes and the not-idle note on a switch, no new epoch for an unchanged lane", () => {
  n = 0;
  const switched = planEpochs(
    { inspector: "pi" },
    { config: {}, records: { inspector: { harness: "codex", busy: true } } },
    mint,
  );
  expect(switched.epochs).toEqual({ inspector: "e1" });
  expect(switched.notes[0]).toMatch(
    /lane inspector switches harness from codex to pi/,
  );
  expect(switched.notes[1]).toMatch(/not idle/);
  const unchanged = planEpochs(
    { inspector: "pi" },
    {
      config: { inspector: { harness: "pi", sessionEpoch: "cfg" } },
      records: {
        inspector: { harness: "pi", sessionEpoch: "pi-1", busy: true },
      },
    },
    mint,
  );
  expect(unchanged.epochs).toEqual({ inspector: "pi-1" });
  expect(unchanged.notes).toEqual([]);
});

it("a Pi rerun reuses the record's epoch so serve accepts it even after a crashed run", () => {
  const answers: SetupAnswers = {
    roles: roleHarnesses("mixed", "pi"),
    binaries: { claude: process.execPath, pi: process.execPath },
    models: { claude: "opus" },
    claude: { ...defaultClaudeSettings },
    allowedTasks: ["T-1"],
    implementers: ["dev"],
    limits: defaultLimits(),
    confirmedStoppedAt: "2026-11-08T00:00:00.000Z",
    sessionEpoch: "fresh-from-answers",
  };
  const plan = planEpochs(
    laneHarnesses(answers, policy),
    {
      config: {},
      records: {
        inspector: { harness: "pi", sessionEpoch: "pi-1", busy: true },
      },
    },
    mint,
  );
  const { config } = buildConfig(
    { ...answers, laneEpochs: plan.epochs },
    policy,
  );
  const lanes = (config as { lanes: Record<string, { sessionEpoch?: string }> })
    .lanes;
  expect(lanes.inspector?.sessionEpoch).toBe("pi-1");
  expect(() =>
    assertSwitch(lanes.inspector as never, rec("pi", "pi-1", "failed"), false),
  ).not.toThrow();
  // Without the plan the generated fresh epoch is refused for the crashed run.
  const bare = buildConfig(answers, policy).config as {
    lanes: Record<string, never>;
  };
  expect(() =>
    assertSwitch(
      bare.lanes.inspector as never,
      rec("pi", "pi-1", "failed"),
      false,
    ),
  ).toThrow(/fresh explicit sessionEpoch/);
});
