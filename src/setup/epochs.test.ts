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
  // pi lanes are never planned here; unknown lanes need nothing.
  expect(plan.epochs).toEqual({ captain: "e1", builder: "keep-1" });
  expect(plan.notes).toHaveLength(2);
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
