import type { Config } from "../../contracts.ts";
import { controlDirectory } from "../../control.ts";
import type { DoctorProblem } from "../../doctor.ts";
import {
  type ConfigInspection,
  inspectConfiguration,
} from "../../doctor-config.ts";
import {
  coordinatorOf,
  type ProjectPolicy,
  type ReviewerRole,
  reviewerRoleOf,
  reviewersOf,
} from "../../project.ts";
import {
  claudeMcpModes,
  claudePermissionModes,
  claudeSettingSourceValues,
} from "../harness.ts";
import { schedulingFingerprint } from "../scheduling.ts";
import { readRuntime } from "./runtime-files.ts";
import { amount, clean, count, readJsonStrict } from "./sanitize.ts";

/** Lanes inspected (and probed) and problems returned for one request. */
export const maxLanes = 64;
export const maxProblems = 100;
/** The installed configuration is a few KiB; a file this large is not one. */
const maxConfigBytes = 1024 * 1024;
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A value from a closed set, else null: nothing configured is echoed outside it. */
const oneOf = (value: unknown, allowed: readonly string[]) =>
  typeof value === "string" && allowed.includes(value) ? value : null;
const listOf = (value: unknown, allowed: readonly string[]) =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && allowed.includes(item),
      )
    : null;
/** Short list of names (tools, patterns): strings only, cleaned and bounded. */
const names = (value: unknown) =>
  Array.isArray(value)
    ? value
        .slice(0, 64)
        .map((item) => clean(item, 200))
        .filter((item): item is string => item !== null)
    : null;
const safePermissions = (value: unknown) => {
  const text = clean(value, 64);
  if (
    text === "no-tools" ||
    text === "auto-approve" ||
    text === "harness-configured" ||
    text === "harness-controlled"
  )
    return text;
  if (
    text?.startsWith("permission-mode:") &&
    (claudePermissionModes as readonly string[]).includes(
      text.slice("permission-mode:".length),
    )
  )
    return text;
  return "invalid";
};

const problem = (p: Omit<DoctorProblem, "code"> & { code: string }) => ({
  code: p.code,
  lane: p.lane === undefined ? null : clean(p.lane, 64),
  message: clean(p.message, 400) ?? "",
});

/**
 * Read-only effective configuration, built from the same inspection as
 * `crewplane doctor` (src/doctor-config.ts). Names and statuses only: no
 * environment values, no file contents, and no binary is ever executed.
 */
export async function configView(
  root: string,
  input: { store: string; policy: ProjectPolicy },
) {
  const inspection: ConfigInspection = await inspectConfiguration({
    root,
    store: input.store,
    controlDir: controlDirectory(root),
    instructionsPath: input.policy.instructionsPath,
    // The page is served from a request: bound the work and refuse symlinks
    // and oversized files. `crewplane doctor` applies no such bounds.
    limits: {
      maxLanes,
      maxProblems,
      readJson: (path) => readJsonStrict(path, maxConfigBytes),
    },
  });
  const { config: rawConfig } = inspection;
  // Anything that is not a JSON object is "installed but unusable": doctor
  // reports why, and nothing below reads fields from it.
  const config = isRecord(rawConfig) ? (rawConfig as Config) : null;
  const usable = config !== null;
  const lanesConfig: Record<string, unknown> =
    usable && isRecord(config.lanes) ? config.lanes : {};
  const { state } = await readRuntime(root);
  const loaded = state?.scheduling;
  const hasLoaded =
    loaded !== undefined &&
    [loaded.maxRunsPerHour, loaded.maxRunMinutes, loaded.intervalSeconds].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    );
  const budgetsOf = (source: {
    maxParallel?: unknown;
    maxRunsPerHour?: unknown;
    maxRunMinutes?: unknown;
    intervalSeconds?: unknown;
  }) => ({
    maxParallel: count(source.maxParallel),
    maxRunsPerHour: count(source.maxRunsPerHour),
    maxRunMinutes: count(source.maxRunMinutes),
    intervalSeconds: count(source.intervalSeconds),
  });
  // One source for every effective cap: the installed configuration, which is
  // what a lane's own value and the global default both come from. The loaded
  // values (what the running supervisor enforces until it reloads) are shown
  // beside them; the supervisor does not persist per-lane loaded caps, so they
  // cannot be mixed into a lane's effective value.
  const configuredBudgets = usable ? budgetsOf(config) : null;
  const loadedBudgets = hasLoaded && loaded ? budgetsOf(loaded) : null;
  // Role fields of a malformed configuration fall back to the defaults
  // (doctor already reports the malformation).
  const roleSource = (value: unknown) => ({
    ...(isRecord(value) && typeof value.coordinator === "string"
      ? { coordinator: value.coordinator }
      : {}),
    ...(isRecord(value) && Array.isArray(value.reviewers)
      ? {
          reviewers: value.reviewers.filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
    ...(isRecord(value) && isRecord(value.reviewerRoles)
      ? {
          reviewerRoles: Object.fromEntries(
            Object.entries(value.reviewerRoles).filter(
              (entry): entry is [string, ReviewerRole] =>
                entry[1] === "code" || entry[1] === "visual",
            ),
          ),
        }
      : {}),
  });
  const roles = roleSource(config);
  const policyRoles = roleSource(input.policy);
  const coordinator = coordinatorOf(roles);
  const reviewers = reviewersOf(roles);
  let digest: string | null = null;
  let digestProblem: string | null = null;
  if (usable)
    try {
      digest = schedulingFingerprint(config);
    } catch {
      // A malformed allowlist cannot be fingerprinted; the problems list says why.
      digestProblem = "The configuration cannot be fingerprinted.";
    }
  const sorted = (list: string[]) => JSON.stringify([...list].sort());
  const policyReviewers = reviewersOf(policyRoles);
  const rolesStale =
    usable &&
    (coordinator !== coordinatorOf(policyRoles) ||
      sorted(reviewers) !== sorted(policyReviewers) ||
      policyReviewers.some(
        (id) => reviewerRoleOf(roles, id) !== reviewerRoleOf(policyRoles, id),
      ));
  const byId = new Map(inspection.harnesses.map((h) => [h.id, h]));
  const binaryOf = (harness: string) =>
    inspection.binaries.find((b) => b.harness === harness) ?? null;
  const lanes = Object.entries(lanesConfig)
    .slice(0, maxLanes)
    .map(([id, raw]) => {
      const lane = isRecord(raw) ? raw : {};
      const report = byId.get(id);
      const reviewer = reviewers.includes(id);
      const effective = (own: number | null, global: number | null) =>
        own ?? global;
      const ownRuns = count(lane.maxRunsPerHour);
      const ownMinutes = count(lane.maxRunMinutes);
      const configured = configuredBudgets;
      const base = {
        id: clean(id, 64) ?? "",
        enabled: lane.enabled === true,
        valid: report !== undefined,
        role:
          id === coordinator
            ? "coordinator"
            : reviewer
              ? "reviewer"
              : "implementer",
        reviewerRole: reviewer ? reviewerRoleOf(roles, id) : null,
      };
      if (!report) return base;
      const bin = binaryOf(report.harness);
      const model = report.model;
      return {
        ...base,
        harness: report.harness,
        model: isRecord(model)
          ? `${clean(model.provider, 64) ?? ""}/${clean(model.id, 100) ?? ""}`
          : clean(model, 128),
        permissions: safePermissions(report.permissions),
        capabilities: report.capabilities,
        instructions: {
          configured: typeof lane.instructionsPath === "string",
          status:
            report.instructions === "none" || report.instructions === "ok"
              ? report.instructions
              : "invalid",
        },
        budgets: {
          maxRunsPerHour: ownRuns,
          maxRunMinutes: ownMinutes,
          maxCostUsdPerRun: amount(lane.maxCostUsdPerRun),
          effectiveMaxRunsPerHour: effective(
            ownRuns,
            configured?.maxRunsPerHour ?? null,
          ),
          effectiveMaxRunMinutes: effective(
            ownMinutes,
            configured?.maxRunMinutes ?? null,
          ),
        },
        passEnv: (Array.isArray(report.passEnv) ? report.passEnv : [])
          .filter((n): n is string => typeof n === "string" && envName.test(n))
          .slice(0, 64),
        binary: bin
          ? {
              path: clean(bin.path, 512),
              ok: bin.ok,
              code: bin.code,
              problem: clean(bin.problem, 400),
            }
          : null,
        claude: report.claude
          ? {
              mcp: oneOf(report.claude.mcp, claudeMcpModes),
              settingSources: listOf(
                report.claude.settingSources,
                claudeSettingSourceValues,
              ),
              tools: names(report.claude.tools),
              allowedTools: names(report.claude.allowedTools),
              disallowedTools: names(report.claude.disallowedTools),
              maxCostUsdPerRun: amount(report.claude.maxCostUsdPerRun),
            }
          : null,
        opencode: report.opencode
          ? {
              agent: clean(report.opencode.agent, 100),
              auto: report.opencode.auto === true,
            }
          : null,
      };
    });
  const problems = [
    ...inspection.configProblems,
    ...inspection.binaryProblems,
  ].map(problem);
  const warnings = [
    ...(inspection.globalInstructionsProblem
      ? [
          problem({
            code: "INSTRUCTIONS_GLOBAL_UNAVAILABLE",
            message: inspection.globalInstructionsProblem,
          }),
        ]
      : []),
    ...(digestProblem
      ? [problem({ code: "DIGEST_UNAVAILABLE", message: digestProblem })]
      : []),
  ];
  return {
    version: 1,
    installed: usable,
    state: inspection.configState,
    digest,
    loadedDigest:
      typeof state?.scheduling?.fingerprint === "string"
        ? clean(state.scheduling.fingerprint, 64)
        : null,
    digestsMatch:
      digest !== null && typeof state?.scheduling?.fingerprint === "string"
        ? state.scheduling.fingerprint === digest
        : null,
    ok: problems.length === 0,
    problems,
    warnings,
    problemsTruncated: inspection.problemsTruncated,
    legacyLayout: inspection.legacyLayout,
    roles: usable
      ? {
          coordinator: clean(coordinator, 64),
          reviewers: reviewers.map((r) => clean(r, 64) ?? ""),
          stale: rolesStale,
        }
      : null,
    budgets: {
      effectiveFrom: "configured",
      configured: configuredBudgets,
      loaded: loadedBudgets,
      reloadPending:
        digest !== null && typeof state?.scheduling?.fingerprint === "string"
          ? state.scheduling.fingerprint !== digest
          : null,
    },
    lanes,
    lanesTruncated:
      inspection.lanesTruncated || Object.keys(lanesConfig).length > maxLanes,
    binaries: inspection.binaries.map((b) => ({
      harness: clean(b.harness, 32) ?? "",
      path: clean(b.path, 512),
      ok: b.ok,
      code: b.code,
      problem: clean(b.problem, 400),
    })),
    credentials: "not-probed",
    binariesExecuted: false,
  };
}
