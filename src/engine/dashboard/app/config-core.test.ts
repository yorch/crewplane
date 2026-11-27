import { expect, it } from "vitest";
import {
  budgetRows,
  COMMANDS,
  describeProblem,
  describeWarning,
  digestFacts,
  laneRows,
  nextSteps,
  permissionsLabel,
  reloadNote,
  rolesNote,
  stateInfo,
  truncationNotes,
} from "./config-core.js";

const lane = (extra: Record<string, unknown> = {}) => ({
  id: "builder",
  enabled: true,
  valid: true,
  role: "implementer",
  reviewerRole: null,
  harness: "codex",
  model: "gpt-x",
  permissions: "harness-controlled",
  capabilities: { usage: "partial" },
  instructions: { configured: true, status: "ok" },
  budgets: {
    maxRunsPerHour: null,
    maxRunMinutes: 5,
    maxCostUsdPerRun: null,
    effectiveMaxRunsPerHour: 6,
    effectiveMaxRunMinutes: 5,
  },
  passEnv: ["PATH", "HOME"],
  binary: { path: "/usr/bin/codex", ok: true, code: null, problem: null },
  ...extra,
});

it("explains installed, valid, invalid and not-configured states", () => {
  expect(stateInfo({ state: "not-configured" })).toMatchObject({
    label: "Not configured",
    tone: "warning",
  });
  expect(stateInfo({ state: "invalid" })).toMatchObject({
    label: "Installed, invalid",
    tone: "danger",
  });
  expect(stateInfo({ state: "valid", ok: true })).toMatchObject({
    label: "Configured and valid",
    tone: "success",
  });
  expect(stateInfo({ state: "valid", ok: false })).toMatchObject({
    label: "Valid, with problems",
    tone: "warning",
  });
  expect(stateInfo({ state: "<img onerror=x>" })).toMatchObject({
    label: "Unknown",
    tone: "unknown",
  });
  expect(stateInfo(null).label).toBe("Unknown");
});

it("gives each known problem code a title and the exact commands to run next", () => {
  const unsafe = describeProblem({
    code: "BINARY_UNSAFE",
    lane: "builder",
    message: "codex binary refused: directory is world-writable",
  });
  expect(unsafe).toMatchObject({
    code: "BINARY_UNSAFE",
    lane: "builder",
    known: true,
    title: "Harness binary refused as unsafe",
  });
  expect(unsafe.advice).toMatch(/was not run/);
  expect(unsafe.message).toMatch(/world-writable/);
  expect(unsafe.commands.map((c: { command: string }) => c.command)).toEqual([
    "crewplane doctor",
    "crewplane setup",
  ]);
  for (const code of [
    "CONFIG_MISSING",
    "CONFIG_INVALID",
    "BINARY_MISSING",
    "BINARY_INVALID",
    "BINARY_NOT_EXECUTABLE",
    "INSTRUCTIONS_INVALID",
    "LEGACY_LAYOUT",
  ])
    expect(describeProblem({ code, message: "m" }).known, code).toBe(true);
});

it("treats unknown or hostile problem codes as plain text with the safe default command", () => {
  const odd = describeProblem({
    code: "<img src=x onerror=alert(1)>",
    lane: "<b>x</b>",
    message: "<script>1</script>",
  });
  expect(odd.known).toBe(false);
  expect(odd.title).toBe("Unrecognised problem");
  expect(odd.code).toBe("<img src=x onerror=alert(1)>");
  expect(odd.commands).toEqual([COMMANDS.doctor]);
  expect(describeProblem({ code: "constructor" }).known).toBe(false);
  expect(describeProblem(null)).toMatchObject({ code: "UNKNOWN", lane: null });
  expect(describeWarning({ code: "DIGEST_UNAVAILABLE" }).text).toMatch(
    /fingerprinted/,
  );
  expect(describeWarning({ code: "X", message: "raw" }).text).toBe("raw");
});

it("only ever suggests the three fixed commands", () => {
  const all = Object.values(COMMANDS).map(
    (c: { command: string }) => c.command,
  );
  expect(all).toEqual([
    "crewplane setup",
    "crewplane configure --file PATH",
    "crewplane doctor",
  ]);
  expect(
    nextSteps({ state: "not-configured" }).map(
      (c: { command: string }) => c.command,
    ),
  ).toEqual(all);
  expect(
    nextSteps({ state: "invalid" }).map((c: { command: string }) => c.command),
  ).toEqual(["crewplane doctor", "crewplane configure --file PATH"]);
  expect(
    nextSteps({
      state: "valid",
      problems: [{ code: "BINARY_UNSAFE" }, { code: "BINARY_MISSING" }],
    }).map((c: { command: string }) => c.command),
  ).toEqual(["crewplane doctor", "crewplane setup"]);
  expect(
    nextSteps({ state: "valid", problems: [] }).map(
      (c: { command: string }) => c.command,
    ),
  ).toEqual(["crewplane doctor"]);
  expect(nextSteps(null)).toEqual([]);
});

it("labels permissions without echoing unknown values", () => {
  expect(permissionsLabel("no-tools")).toBe("No tools");
  expect(permissionsLabel("permission-mode:acceptEdits")).toBe(
    "Claude permission mode acceptEdits",
  );
  expect(permissionsLabel("something else")).toBe("Invalid");
  expect(permissionsLabel("constructor")).toBe("Invalid");
  expect(permissionsLabel(null)).toBeNull();
});

it("builds lane rows with effective caps, env names and binary status", () => {
  const [row] = laneRows({ lanes: [lane()] });
  expect(row).toMatchObject({
    id: "builder",
    enabled: true,
    harness: "codex",
    model: "gpt-x",
    role: "Implementer",
    permissions: "Controlled by the harness",
    instructions: "Configured",
    passEnv: ["PATH", "HOME"],
    usageCoverage: "partial",
  });
  expect(row?.caps).toEqual([
    ["Runs per hour", "6 (default)"],
    ["Minutes per run", "5"],
    ["Cost per run", "No cap"],
  ]);
  expect(row?.binary).toEqual({
    tone: "success",
    text: "Found, not executed",
    detail: "/usr/bin/codex",
  });
});

it("formats the per-run cost cap like every other dollar amount", () => {
  const cost = (value: number) =>
    laneRows({
      lanes: [
        lane({ budgets: { ...lane().budgets, maxCostUsdPerRun: value } }),
      ],
    })[0]?.caps.find(([label]: string[]) => label === "Cost per run")?.[1];
  expect(cost(5)).toBe("$5.00");
  expect(cost(0.5)).toBe("$0.50");
  expect(cost(0.004)).toBe("$0.0040");
});

it("shows unsafe binaries with the lane's reason and unvalidated lanes as not inspected", () => {
  const rows = laneRows({
    lanes: [
      lane({
        id: "reviewer",
        role: "reviewer",
        reviewerRole: "visual",
        binary: {
          path: "/opt/x",
          ok: false,
          code: "BINARY_UNSAFE",
          problem: "codex binary refused: directory is group-writable",
        },
      }),
      { id: "broken", enabled: false, valid: false, role: "implementer" },
    ],
  });
  expect(rows[0]?.role).toBe("Reviewer (visual)");
  expect(rows[0]?.binary).toEqual({
    tone: "danger",
    text: "BINARY_UNSAFE",
    detail: "codex binary refused: directory is group-writable",
  });
  expect(rows[1]).toMatchObject({
    valid: false,
    enabled: false,
    harness: null,
    model: null,
    permissions: null,
    instructions: null,
    caps: [],
    passEnv: [],
  });
  expect(rows[1]?.binary.text).toBe("Not inspected");
  expect(laneRows(null)).toEqual([]);
});

it("compares configured and loaded budgets and says when a reload is pending", () => {
  const rows = budgetRows({
    configured: {
      maxParallel: 2,
      maxRunsPerHour: 6,
      maxRunMinutes: 10,
      intervalSeconds: 5,
    },
    loaded: {
      maxParallel: 2,
      maxRunsPerHour: 4,
      maxRunMinutes: 10,
      intervalSeconds: 5,
    },
  });
  expect(rows.map((r) => r.differs)).toEqual([false, true, false, false]);
  expect(rows[1]).toMatchObject({ configured: "6", loaded: "4" });
  const unknown = budgetRows({ configured: { maxParallel: 1 }, loaded: null });
  expect(unknown[0]).toEqual({
    label: "Concurrent agents",
    configured: "1",
    loaded: null,
    differs: null,
  });
  expect(unknown[1]?.configured).toBeNull();
  expect(reloadNote({ configured: {}, reloadPending: true })).toMatch(
    /Reload pending/,
  );
  expect(reloadNote({ configured: {}, reloadPending: false })).toMatch(
    /has loaded the installed/,
  );
  expect(
    reloadNote({ configured: {}, reloadPending: null, loaded: null }),
  ).toMatch(/may not be running/);
  expect(
    reloadNote({ configured: {}, reloadPending: null, loaded: {} }),
  ).toMatch(/unknown/);
  expect(reloadNote({ configured: null })).toBeNull();
});

it("shortens the digest for reading while keeping the full one for copying", () => {
  const digest = "a1b2c3d4".repeat(8);
  expect(
    digestFacts({ digest, loadedDigest: digest, digestsMatch: true }),
  ).toMatchObject({
    digest,
    short: "a1b2c3d4a1b2",
    loadedShort: "a1b2c3d4a1b2",
    match: "Matches the running supervisor.",
  });
  expect(digestFacts({ digest, digestsMatch: false }).match).toMatch(/Differs/);
  expect(digestFacts({ digest, digestsMatch: null }).match).toMatch(/Unknown/);
  expect(digestFacts({ digest: null }).match).toMatch(
    /cannot be fingerprinted/,
  );
  expect(digestFacts({ digest: null, state: "invalid" }).match).toMatch(
    /cannot be fingerprinted/,
  );
  expect(digestFacts({ digest: "<x>" }).short).toBeNull();
  // Nothing installed is not a failure to fingerprint.
  expect(digestFacts({ digest: null, state: "not-configured" }).match).toBe(
    "No configuration is installed, so there is no digest to compare.",
  );
});

it("surfaces the stale-roles hint and truncation markers", () => {
  expect(
    rolesNote({ coordinator: "captain", reviewers: [], stale: true }),
  ).toMatch(/differ from the project's committed policy/);
  expect(rolesNote({ stale: false })).toBeNull();
  expect(rolesNote(null)).toBeNull();
  expect(
    truncationNotes({ lanesTruncated: true, problemsTruncated: true }),
  ).toHaveLength(2);
  expect(
    truncationNotes({ lanesTruncated: false, problemsTruncated: false }),
  ).toEqual([]);
});
