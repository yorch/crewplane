import { controlDirectory } from "../../control.ts";
import type { DoctorProblem } from "../../doctor.ts";
import {
  type ConfigInspection,
  inspectConfiguration,
} from "../../doctor-config.ts";
import {
  coordinatorOf,
  type ProjectPolicy,
  reviewerRoleOf,
  reviewersOf,
} from "../../project.ts";
import { schedulingFingerprint } from "../scheduling.ts";
import { readRuntime } from "./runtime-files.ts";
import { amount, clean, count, scalar } from "./sanitize.ts";

const maxLanes = 64;
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const problem = (p: DoctorProblem) => ({
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
  });
  const { config } = inspection;
  const usable = config !== null && typeof config === "object";
  const lanesConfig =
    usable && config.lanes && typeof config.lanes === "object"
      ? config.lanes
      : {};
  const { state } = await readRuntime(root);
  const loaded = state?.scheduling;
  const hasLoaded =
    loaded !== undefined &&
    [loaded.maxRunsPerHour, loaded.maxRunMinutes, loaded.intervalSeconds].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    );
  const globalBudgets = hasLoaded
    ? {
        maxParallel: count(loaded.maxParallel),
        maxRunsPerHour: count(loaded.maxRunsPerHour),
        maxRunMinutes: count(loaded.maxRunMinutes),
        intervalSeconds: count(loaded.intervalSeconds),
      }
    : usable
      ? {
          maxParallel: count(config.maxParallel),
          maxRunsPerHour: count(config.maxRunsPerHour),
          maxRunMinutes: count(config.maxRunMinutes),
          intervalSeconds: count(config.intervalSeconds),
        }
      : null;
  const coordinator = coordinatorOf(config);
  const reviewers = reviewersOf(config);
  const digest = usable ? schedulingFingerprint(config) : null;
  const sorted = (list: string[]) => JSON.stringify([...list].sort());
  const policyReviewers = reviewersOf(input.policy);
  const rolesStale =
    usable &&
    (coordinator !== coordinatorOf(input.policy) ||
      sorted(reviewers) !== sorted(policyReviewers) ||
      policyReviewers.some(
        (id) => reviewerRoleOf(config, id) !== reviewerRoleOf(input.policy, id),
      ));
  const byId = new Map(inspection.harnesses.map((h) => [h.id, h]));
  const binaryOf = (harness: string) =>
    inspection.binaries.find((b) => b.harness === harness) ?? null;
  const lanes = Object.entries(lanesConfig)
    .slice(0, maxLanes)
    .map(([id, raw]) => {
      const lane = (
        typeof raw === "object" && raw !== null ? raw : {}
      ) as Record<string, unknown>;
      const report = byId.get(id);
      const reviewer = reviewers.includes(id);
      const effective = (own: number | null, global: number | null) =>
        own ?? global;
      const ownRuns = count(lane.maxRunsPerHour);
      const ownMinutes = count(lane.maxRunMinutes);
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
        reviewerRole: reviewer ? reviewerRoleOf(config, id) : null,
      };
      if (!report) return base;
      const bin = binaryOf(report.harness);
      const model = report.model;
      return {
        ...base,
        harness: report.harness,
        model:
          typeof model === "object" && model !== null
            ? `${clean((model as { provider?: unknown }).provider, 64) ?? ""}/${clean((model as { id?: unknown }).id, 100) ?? ""}`
            : clean(model, 128),
        permissions: clean(report.permissions, 64),
        capabilities: report.capabilities,
        instructions: {
          configured: typeof lane.instructionsPath === "string",
          status:
            report.instructions === "none" || report.instructions === "ok"
              ? report.instructions
              : "invalid",
        },
        budgets: {
          maxRunsPerHour: report.budgets.maxRunsPerHour,
          maxRunMinutes: report.budgets.maxRunMinutes,
          maxCostUsdPerRun: amount(lane.maxCostUsdPerRun),
          effectiveMaxRunsPerHour: effective(
            ownRuns,
            globalBudgets?.maxRunsPerHour ?? null,
          ),
          effectiveMaxRunMinutes: effective(
            ownMinutes,
            globalBudgets?.maxRunMinutes ?? null,
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
          ? Object.fromEntries(
              Object.entries(report.claude).map(([k, v]) => [k, scalar(v)]),
            )
          : null,
        opencode: report.opencode
          ? Object.fromEntries(
              Object.entries(report.opencode).map(([k, v]) => [k, scalar(v)]),
            )
          : null,
      };
    });
  const problems = [
    ...inspection.configProblems,
    ...inspection.binaryProblems,
  ].map(problem);
  return {
    version: 1,
    installed: usable,
    state: inspection.configState,
    digest,
    loadedDigest: state?.scheduling?.fingerprint ?? null,
    digestsMatch:
      digest !== null && typeof state?.scheduling?.fingerprint === "string"
        ? state.scheduling.fingerprint === digest
        : null,
    ok: problems.length === 0,
    problems,
    warnings: inspection.globalInstructionsProblem
      ? [
          problem({
            code: "INSTRUCTIONS_GLOBAL_UNAVAILABLE",
            message: inspection.globalInstructionsProblem,
          }),
        ]
      : [],
    legacyLayout: inspection.legacyLayout,
    roles: usable
      ? {
          coordinator: clean(coordinator, 64),
          reviewers: reviewers.map((r) => clean(r, 64) ?? ""),
          stale: rolesStale,
        }
      : null,
    budgets: globalBudgets
      ? { ...globalBudgets, source: hasLoaded ? "loaded" : "configured-only" }
      : null,
    lanes,
    lanesTruncated: Object.keys(lanesConfig).length > maxLanes,
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
