import { isAbsolute } from "node:path";
import {
  type ClaudePermissionMode,
  claudeMcpModes,
  claudePermissionModes,
  claudeSettingSourceValues,
  type Harness,
  type LaneHarness,
  validateHarness,
} from "../engine/harness.ts";
import { type ReviewerRole, validId, validTaskId } from "../project.ts";

/** Preset role-to-harness mappings. `custom` is wizard-only. */
export const templates = ["codex", "claude", "opencode", "mixed"] as const;
export type Template = (typeof templates)[number];
export const isTemplate = (value: unknown): value is Template =>
  typeof value === "string" && (templates as readonly string[]).includes(value);

export const templateSummary: Record<Template, string> = {
  codex: "every lane runs Codex",
  claude: "every lane runs Claude Code",
  opencode: "every lane runs OpenCode",
  mixed:
    "Claude Code coordinator and implementers, reviewers on OpenCode (or no-tools Pi)",
};

export type SetupRole = "coordinator" | "implementer" | "reviewer";
export type RoleHarnesses = Record<SetupRole, Harness>;

/** Template presets; `reviewerHarness` only varies for `mixed`. */
export function roleHarnesses(
  template: Template,
  reviewerHarness: Harness = "opencode",
): RoleHarnesses {
  switch (template) {
    case "codex":
      return all("codex");
    case "claude":
      return all("claude");
    case "opencode":
      return all("opencode");
    case "mixed":
      return {
        coordinator: "claude",
        implementer: "claude",
        reviewer: reviewerHarness,
      };
  }
}
const all = (harness: Harness): RoleHarnesses => ({
  coordinator: harness,
  implementer: harness,
  reviewer: harness,
});

/** Documentation-level default only; real projects name implementers in task cards. */
export const defaultImplementerId = "implementer";

export const limitBounds = {
  maxParallel: { min: 1, max: 4, default: 2 },
  intervalSeconds: { min: 1, max: 60, default: 10 },
  maxRunMinutes: { min: 1, max: 60, default: 25 },
  maxRunsPerHour: { min: 1, max: 60, default: 20 },
} as const;
export type LimitName = keyof typeof limitBounds;
export const defaultMaxCostUsdPerRun = 2;

export interface ClaudeSettings {
  /** Permission mode for implementer lanes; coordinator and reviewers use `plan`. */
  implementerMode: ClaudePermissionMode;
  mcp: (typeof claudeMcpModes)[number];
  settingSources: (typeof claudeSettingSourceValues)[number][];
  maxCostUsdPerRun: number;
}
export const defaultClaudeSettings: ClaudeSettings = {
  implementerMode: "acceptEdits",
  mcp: "strict",
  settingSources: ["project"],
  maxCostUsdPerRun: defaultMaxCostUsdPerRun,
};

export interface SetupPolicy {
  coordinator: string;
  reviewers: string[];
  reviewerRoles: Record<string, ReviewerRole>;
}

export interface SetupAnswers {
  roles: RoleHarnesses;
  /** Absolute executables per harness actually used. */
  binaries: Partial<Record<Harness, string>>;
  /** claude/opencode: required; codex: optional. Keyed by harness. */
  models: Partial<Record<Harness, string>>;
  piModel?: { provider: string; id: string };
  claude: ClaudeSettings;
  allowedTasks: string[];
  implementers: string[];
  limits: Record<LimitName, number>;
  /** ISO time the operator confirmed the supervisor stopped; never invented. */
  confirmedStoppedAt?: string;
  /** Pi lanes require a fresh explicit epoch. */
  sessionEpoch?: string;
  /** Lane id -> epoch for non-Pi lanes that switch harness or keep a prior epoch. */
  laneEpochs?: Record<string, string>;
}

export const defaultLimits = (): Record<LimitName, number> => ({
  maxParallel: limitBounds.maxParallel.default,
  intervalSeconds: limitBounds.intervalSeconds.default,
  maxRunMinutes: limitBounds.maxRunMinutes.default,
  maxRunsPerHour: limitBounds.maxRunsPerHour.default,
});

export class SetupError extends Error {}
const fail = (message: string): never => {
  throw new SetupError(message);
};

/** Parse a comma list; every item must satisfy `valid`, none may repeat. */
export function parseList(
  text: string,
  label: string,
  valid: (value: string) => boolean,
): string[] {
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (!items.length) return fail(`${label}: at least one value is required`);
  for (const item of items)
    if (!valid(item))
      return fail(
        `${label}: invalid value ${JSON.stringify(item.slice(0, 40))}`,
      );
  if (new Set(items).size !== items.length)
    return fail(`${label}: duplicate values`);
  return items;
}
export const parseTaskIds = (text: string) =>
  parseList(text, "task IDs", validTaskId);
export const parseImplementers = (text: string) =>
  parseList(text, "implementer lane IDs", (id) => validId(id));

export function parseLimit(name: LimitName, text: string): number {
  const bounds = limitBounds[name];
  const value = /^\d{1,3}$/.test(text.trim())
    ? Number(text.trim())
    : Number.NaN;
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max)
    return fail(`${name} must be an integer ${bounds.min}-${bounds.max}`);
  return value;
}
export function parseCost(text: string): number {
  const value = /^\d{1,3}(\.\d{1,2})?$/.test(text.trim())
    ? Number(text.trim())
    : Number.NaN;
  if (!Number.isFinite(value) || value < 0.01 || value > 100)
    return fail("maxCostUsdPerRun must be 0.01-100 with at most two decimals");
  return value;
}
export function parsePermissionMode(text: string): ClaudePermissionMode {
  const mode = claudePermissionModes.find((m) => m === text.trim());
  return (
    mode ??
    fail(
      `Claude permission mode must be one of ${claudePermissionModes.join(", ")} (bypass and manual modes are unavailable)`,
    )
  );
}
export function parseMcp(text: string): ClaudeSettings["mcp"] {
  const mode = claudeMcpModes.find((m) => m === text.trim());
  return mode ?? fail(`claudeMcp must be one of ${claudeMcpModes.join(", ")}`);
}
export function parseSettingSources(
  text: string,
): ClaudeSettings["settingSources"] {
  const items = parseList(text, "claudeSettingSources", (value) =>
    (claudeSettingSourceValues as readonly string[]).includes(value),
  );
  return items as ClaudeSettings["settingSources"];
}
export function parsePiModel(text: string): { provider: string; id: string } {
  const at = text.indexOf("/");
  const provider = text.slice(0, at),
    id = text.slice(at + 1);
  if (at <= 0 || !id) return fail("Pi model must be PROVIDER/MODEL");
  return { provider, id };
}

const lanePolicyOf = (policy: SetupPolicy, id: string): SetupRole =>
  id === policy.coordinator ? "coordinator" : "reviewer";

/** Which harnesses a role map uses. */
export const harnessesUsed = (roles: RoleHarnesses): Harness[] => [
  ...new Set(Object.values(roles)),
];

/** Lane enablement: visual reviewers start disabled until an operator opts in. */
const laneEnabled = (policy: SetupPolicy, id: string, role: SetupRole) =>
  !(role === "reviewer" && policy.reviewerRoles[id] === "visual");

export function laneFor(
  harness: Harness,
  role: SetupRole,
  id: string,
  policy: SetupPolicy,
  answers: SetupAnswers,
): LaneHarness & { enabled: boolean } {
  const enabled = laneEnabled(policy, id, role);
  const epoch = answers.laneEpochs?.[id];
  const withEpoch = epoch ? { sessionEpoch: epoch } : {};
  switch (harness) {
    case "codex": {
      const model = answers.models.codex;
      return {
        enabled,
        harness,
        ...(model ? { model } : {}),
        ...withEpoch,
      };
    }
    case "claude":
      return {
        enabled,
        harness,
        model: answers.models.claude as string,
        claudePermissionMode:
          role === "implementer" ? answers.claude.implementerMode : "plan",
        claudeMcp: answers.claude.mcp,
        claudeSettingSources: [...answers.claude.settingSources],
        maxCostUsdPerRun: answers.claude.maxCostUsdPerRun,
        ...withEpoch,
      };
    case "opencode":
      return {
        enabled,
        harness,
        model: answers.models.opencode as string,
        ...withEpoch,
      };
    case "pi":
      return {
        enabled,
        harness,
        piPermissions: "no-tools",
        sessionEpoch: answers.sessionEpoch as string,
        ...(answers.piModel ? { piModel: answers.piModel } : {}),
      };
  }
}

export interface BuiltSetup {
  /** Runtime JSON for `configure --file`; root and roles come from the project. */
  config: Record<string, unknown>;
  notes: string[];
}

/**
 * Pure builder: answers + committed policy -> runtime configuration. It checks
 * structural preconditions and every lane through the engine's validateHarness
 * so the generated file cannot drift from what `configure` accepts.
 */
/** Lane id -> harness for every lane a setup would write, in config order. */
export function laneHarnesses(
  answers: Pick<SetupAnswers, "roles" | "implementers">,
  policy: SetupPolicy,
): Record<string, Harness> {
  const lanes: Record<string, Harness> = {
    [policy.coordinator]: answers.roles.coordinator,
  };
  for (const id of answers.implementers) lanes[id] = answers.roles.implementer;
  for (const id of policy.reviewers)
    lanes[id] = answers.roles[lanePolicyOf(policy, id)];
  return lanes;
}

export function buildConfig(
  answers: SetupAnswers,
  policy: SetupPolicy,
): BuiltSetup {
  if (answers.roles.coordinator === "pi" || answers.roles.implementer === "pi")
    fail("Pi may only be a reviewer lane");
  const ids = [
    policy.coordinator,
    ...answers.implementers,
    ...policy.reviewers,
  ];
  if (new Set(ids).size !== ids.length)
    fail(
      "Implementer lane IDs must differ from each other, the coordinator and the reviewers",
    );
  for (const id of answers.implementers)
    if (!validId(id)) fail("Invalid implementer lane ID");
  if (!answers.allowedTasks.length)
    fail("At least one allowed task is required");
  if (
    answers.allowedTasks.some((id) => !validTaskId(id)) ||
    new Set(answers.allowedTasks).size !== answers.allowedTasks.length
  )
    fail("Allowed task IDs must be valid and distinct");
  if (!answers.implementers.length)
    fail("At least one implementer lane is required");
  for (const harness of harnessesUsed(answers.roles)) {
    const path = answers.binaries[harness];
    if (!path || !isAbsolute(path))
      fail(`An absolute ${harness} binary path is required`);
  }
  for (const [name, bounds] of Object.entries(limitBounds)) {
    const value = answers.limits[name as LimitName];
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max)
      fail(`Invalid ${name}`);
  }

  const lanes: Record<string, LaneHarness & { enabled: boolean }> = {};
  const binaries: Partial<Record<Harness, string>> = {};
  for (const harness of harnessesUsed(answers.roles)) {
    const path = answers.binaries[harness] as string;
    binaries[harness] = path;
  }
  const entries: Array<[string, SetupRole]> = [
    [policy.coordinator, "coordinator"],
    ...answers.implementers.map((id): [string, SetupRole] => [
      id,
      "implementer",
    ]),
    ...policy.reviewers.map((id): [string, SetupRole] => [
      id,
      lanePolicyOf(policy, id),
    ]),
  ];
  for (const [id, role] of entries) {
    const harness = answers.roles[role];
    if (harness === "pi" && !answers.sessionEpoch)
      fail("Pi lanes require a session epoch");
    const lane = laneFor(harness, role, id, policy, answers);
    try {
      validateHarness({ root: "/", binary: "/", binaries }, lane, {
        checkBinary: false,
      });
    } catch (error) {
      return fail(
        `Lane ${id}: ${error instanceof Error ? error.message : "invalid lane"}`,
      );
    }
    lanes[id] = lane;
  }
  const primary = answers.roles.coordinator;
  const config: Record<string, unknown> = {
    version: 1,
    // The engine requires a top-level binary; only Codex lanes ever fall back to it.
    binary: binaries[primary] as string,
    ...(Object.keys(binaries).length > 1 || binaries.codex === undefined
      ? { binaries }
      : {}),
    allowedTasks: answers.allowedTasks,
    maxParallel: answers.limits.maxParallel,
    intervalSeconds: answers.limits.intervalSeconds,
    maxRunMinutes: answers.limits.maxRunMinutes,
    maxRunsPerHour: answers.limits.maxRunsPerHour,
    ...(answers.confirmedStoppedAt
      ? { confirmedStoppedAt: answers.confirmedStoppedAt }
      : {}),
    lanes,
  };
  const notes: string[] = [];
  if (!answers.confirmedStoppedAt)
    notes.push(
      "confirmedStoppedAt is omitted: stop every old harness and supervisor for this project, then add the field with the real UTC time (or rerun with --confirm-stopped true) before `crewplane configure --file`",
    );
  const visual = entries.filter(([id, role]) => !laneEnabled(policy, id, role));
  if (visual.length)
    notes.push(
      `visual reviewer lane(s) ${visual.map(([id]) => id).join(", ")} are disabled; set enabled to true to use them`,
    );
  if (answers.roles.reviewer === "pi")
    notes.push(
      "Pi reviewers run no-tools; their turns end as paused advisory decisions for operator relay",
    );
  if (harnessesUsed(answers.roles).includes("opencode"))
    notes.push(
      "OpenCode lanes use the harness's own permission configuration (opencodeAuto is not set)",
    );
  if (primary !== "codex")
    notes.push(
      `top-level binary is the ${primary} executable because the engine requires one; only Codex lanes fall back to it`,
    );
  return { config, notes };
}

/** Parse a Pi model and validate it through the engine's own lane validator. */
export function acceptPiModel(text: string): { provider: string; id: string } {
  const piModel = parsePiModel(text.trim());
  try {
    validateHarness(
      { root: "/", binary: "/" },
      {
        harness: "pi",
        piPermissions: "no-tools",
        sessionEpoch: "setup-check",
        piModel,
      },
      { checkBinary: false },
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid Pi model");
  }
  return piModel;
}

/**
 * Validate one model identifier for a harness through the engine's own lane
 * validator; returns the accepted value (`undefined` for an optional blank).
 */
export function acceptModel(
  harness: Harness,
  text: string,
): string | undefined {
  const model = text.trim();
  if (harness === "codex" && model === "") return undefined;
  const lane: LaneHarness =
    harness === "claude"
      ? {
          harness,
          model,
          claudePermissionMode: "plan",
          claudeMcp: "strict",
          claudeSettingSources: ["project"],
        }
      : { harness, model };
  try {
    validateHarness({ root: "/", binary: "/" }, lane, { checkBinary: false });
  } catch (error) {
    return fail(
      harness === "opencode"
        ? "OpenCode model must be provider/model or provider/model#variant"
        : error instanceof Error
          ? error.message
          : "Invalid model",
    );
  }
  return model;
}
