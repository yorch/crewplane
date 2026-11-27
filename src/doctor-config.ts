import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./contracts.ts";
import { checkControlDirectory, legacySupervisorDirectory } from "./control.ts";
import {
  type BinaryProbe,
  type DoctorProblem,
  type DoctorProblemCode,
  effectiveBinary,
  failureMessage,
  inspectBinary,
} from "./doctor.ts";
import {
  harnessCapabilities,
  instructionFileProblem,
  validHarness,
} from "./engine/harness.ts";
import { validateConfig } from "./engine/supervisor.ts";
import { legacyPresent } from "./migrate.ts";

/**
 * The configuration half of `crewplane doctor`, shared with the dashboard's
 * `/api/config` so the two cannot drift. Reads the private control directory
 * and probes binaries (never runs them); every failure becomes a problem.
 */
export const lanePermissions = (lane: Config["lanes"][string]) => {
  switch (lane.harness ?? "codex") {
    case "pi":
      return "no-tools";
    case "claude":
      return `permission-mode:${lane.claudePermissionMode}`;
    case "opencode":
      return lane.opencodeAuto === true ? "auto-approve" : "harness-configured";
    default:
      return "harness-controlled";
  }
};

export interface DoctorLaneReport {
  id: string;
  harness: string;
  binary: BinaryProbe;
  capabilities: unknown;
  permissions: string;
  model: unknown;
  instructions: string;
  passEnv: unknown;
  budgets: { maxRunsPerHour: number | null; maxRunMinutes: number | null };
  claude: Record<string, unknown> | null;
  opencode: Record<string, unknown> | null;
}

/** One probed binary: a harness's effective binary, or the top-level default. */
export interface BinaryStatus {
  harness: string;
  path: string | null;
  ok: boolean;
  code: DoctorProblemCode | null;
  problem: string | null;
}

export interface ConfigInspection {
  config: Config | null;
  configState: "valid" | "invalid" | "not-configured";
  legacyLayout: boolean;
  /** Legacy-layout and configuration problems, in doctor's order. */
  configProblems: DoctorProblem[];
  /** Per-lane instruction and binary problems, then the default binary. */
  binaryProblems: DoctorProblem[];
  harnesses: DoctorLaneReport[];
  defaultBinary: BinaryProbe | null;
  binaries: BinaryStatus[];
  /** Why the global instructions file is unusable, or null. */
  globalInstructionsProblem: string | null;
  /** True when `limits.maxLanes` stopped the per-lane inspection short. */
  lanesTruncated: boolean;
  /** True when `limits.maxProblems` dropped later problems. */
  problemsTruncated: boolean;
}

/**
 * Optional bounds for callers that serve this inspection to a client (the
 * dashboard). `crewplane doctor` passes none, so it inspects everything and
 * reads files exactly as before.
 */
export interface InspectionLimits {
  /** Lanes inspected (and binaries probed for); later lanes are skipped. */
  maxLanes?: number;
  /** Problems returned, configuration problems first. */
  maxProblems?: number;
  /**
   * Reads the stored configuration: parsed JSON, `null` when the file does not
   * exist, a throw for anything unreadable (symlink, oversized, malformed).
   */
  readJson?: (path: string) => Promise<unknown>;
}

async function optionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid private state; inspect before recovery");
  }
}

export async function inspectConfiguration(input: {
  root: string;
  store: string;
  controlDir: string;
  instructionsPath: string;
  limits?: InspectionLimits;
}): Promise<ConfigInspection> {
  const { root, store, controlDir } = input;
  const limits = input.limits ?? {};
  const maxLanes = limits.maxLanes ?? Number.POSITIVE_INFINITY;
  const readJson = limits.readJson ?? optionalJson;
  let lanesTruncated = false;
  const configProblems: DoctorProblem[] = [];
  const binaryProblems: DoctorProblem[] = [];
  let config: Config | null = null;
  let configState: ConfigInspection["configState"] = "not-configured";
  const legacyLayout = legacyPresent(legacySupervisorDirectory(store));
  if (legacyLayout)
    configProblems.push({
      code: "LEGACY_LAYOUT",
      message:
        "Legacy supervisor state is in the project store and is not used; run `crewplane migrate`",
    });
  try {
    checkControlDirectory(controlDir);
    config = (await readJson(join(controlDir, "config.json"))) as Config | null;
  } catch (error) {
    configState = "invalid";
    configProblems.push({
      code: "CONFIG_INVALID",
      message: failureMessage(error, "Configuration is unreadable"),
    });
  }
  if (config) {
    try {
      // Binaries are probed per lane below, so a missing one must not hide
      // the first other configuration error.
      validateConfig(config, { checkBinary: false });
      configState = "valid";
    } catch (error) {
      configState = "invalid";
      configProblems.push({
        code: "CONFIG_INVALID",
        message: failureMessage(error, "Configuration is invalid"),
      });
    }
  } else if (configState === "not-configured")
    configProblems.push({
      code: "CONFIG_MISSING",
      message: "Project is not configured; run crewplane configure --file PATH",
    });
  const reportedPaths = new Set<string>();
  const binaries: BinaryStatus[] = [];
  const probeFor = async (harness: string, path?: string, lane?: string) => {
    const { probe, code } = await inspectBinary(path, harness);
    if (code && !(probe.path !== null && reportedPaths.has(probe.path))) {
      binaryProblems.push({
        code,
        ...(lane === undefined ? {} : { lane }),
        message: probe.problem ?? "binary unusable",
      });
      if (probe.path !== null) reportedPaths.add(probe.path);
    }
    if (!binaries.some((b) => b.harness === harness))
      binaries.push({
        harness,
        path: probe.path,
        ok: probe.ok,
        code: code ?? null,
        problem: probe.problem ?? null,
      });
    return probe;
  };
  const harnesses: DoctorLaneReport[] = [];
  let laneFailures = 0;
  if (config && typeof config.lanes === "object" && config.lanes)
    for (const [id, lane] of Object.entries(config.lanes)) {
      if (harnesses.length + laneFailures >= maxLanes) {
        lanesTruncated = true;
        break;
      }
      try {
        if (typeof lane !== "object" || lane === null || Array.isArray(lane))
          throw new Error("Lane is invalid");
        const harness = lane.harness ?? "codex";
        if (!validHarness(harness)) throw new Error("Unsupported harness");
        const instructions = lane.instructionsPath
          ? (instructionFileProblem(root, lane.instructionsPath) ?? "ok")
          : "none";
        if (instructions !== "none" && instructions !== "ok")
          binaryProblems.push({
            code: "INSTRUCTIONS_INVALID",
            lane: id,
            message: instructions,
          });
        harnesses.push({
          id,
          harness,
          binary: await probeFor(
            harness,
            effectiveBinary(config ?? {}, harness),
            id,
          ),
          capabilities: harnessCapabilities[harness],
          permissions: lanePermissions(lane),
          model: lane.piModel ?? lane.model ?? null,
          instructions,
          passEnv: lane.passEnv ?? [],
          budgets: {
            maxRunsPerHour: lane.maxRunsPerHour ?? null,
            maxRunMinutes: lane.maxRunMinutes ?? null,
          },
          claude:
            lane.harness === "claude"
              ? {
                  mcp: lane.claudeMcp ?? null,
                  settingSources: lane.claudeSettingSources ?? null,
                  tools: lane.claudeTools ?? null,
                  allowedTools: lane.claudeAllowedTools ?? null,
                  disallowedTools: lane.claudeDisallowedTools ?? null,
                  maxCostUsdPerRun: lane.maxCostUsdPerRun ?? null,
                }
              : null,
          opencode:
            lane.harness === "opencode"
              ? {
                  agent: lane.opencodeAgent ?? null,
                  auto: lane.opencodeAuto === true,
                }
              : null,
        });
      } catch (error) {
        laneFailures += 1;
        binaryProblems.push({
          code: "CONFIG_INVALID",
          lane: id,
          message: failureMessage(error, "Lane is invalid"),
        });
      }
    }
  // The top-level binary is probed itself, even when no lane resolves to it;
  // a failure already reported for the same path by a lane is not repeated.
  const defaultBinary = config?.binary
    ? await probeFor("default", config.binary)
    : null;
  let problemsTruncated = false;
  if (limits.maxProblems !== undefined) {
    const room = Math.max(0, limits.maxProblems - configProblems.length);
    if (configProblems.length > limits.maxProblems) {
      configProblems.length = limits.maxProblems;
      problemsTruncated = true;
    }
    if (binaryProblems.length > room) {
      binaryProblems.length = room;
      problemsTruncated = true;
    }
  }
  return {
    config,
    configState,
    legacyLayout,
    configProblems,
    binaryProblems,
    harnesses,
    defaultBinary,
    binaries,
    globalInstructionsProblem: instructionFileProblem(
      root,
      input.instructionsPath,
    ),
    lanesTruncated,
    problemsTruncated,
  };
}
