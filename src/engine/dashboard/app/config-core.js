// Pure view models for Setup & config: what the installed state means, the
// doctor-style problem list with what to do next, and the lane and budget
// tables. No DOM. The suggested commands are fixed text the operator runs in a
// terminal; nothing in the page ever executes them, and none is built from
// data the server returned.
import { formatCount, formatUsd, shortHash } from "./format.js";

/** Commands the page may suggest. Static strings only. */
export const COMMANDS = {
  setup: {
    command: "crewplane setup",
    label: "Guided setup",
    why: "Walks through choosing harnesses, models and roles, and installs a validated configuration.",
  },
  configure: {
    command: "crewplane configure --file PATH",
    label: "Install a configuration file",
    why: "Validates and installs a configuration you wrote. Replace PATH with your file.",
  },
  doctor: {
    command: "crewplane doctor",
    label: "Check the setup",
    why: "Runs the same checks as this page from the terminal, without starting any agent.",
  },
};

const STATES = {
  "not-configured": {
    tone: "warning",
    label: "Not configured",
    headline: "No configuration is installed for this project.",
    text: "Crewplane has nothing to supervise yet: no agents are defined, so the supervisor cannot run. Set one up from a terminal; this page only reports what is installed.",
  },
  invalid: {
    tone: "danger",
    label: "Installed, invalid",
    headline: "A configuration is installed, but it cannot be used.",
    text: "The installed configuration file failed validation (or could not be read safely). The problems below say why. Fix the file and install it again.",
  },
  valid: {
    tone: "success",
    label: "Configured and valid",
    headline: "The installed configuration is valid.",
    text: "The configuration passes validation. Binary checks below are stat-only: no harness program has been run.",
  },
};

/** Installed / valid / not-configured state, in plain words. */
export function stateInfo(config) {
  const base = STATES[config?.state] ?? {
    tone: "unknown",
    label: "Unknown",
    headline: "The configuration state is not reported.",
    text: "The dashboard could not tell whether a configuration is installed.",
  };
  if (config?.state === "valid" && config.ok === false)
    return {
      ...base,
      tone: "warning",
      label: "Valid, with problems",
      headline: "The configuration is valid, but some checks failed.",
      text: "The file is structurally valid, but at least one lane has a problem (for example a harness binary that is missing or unsafe) that will stop it from running.",
    };
  return base;
}

const PROBLEMS = {
  CONFIG_MISSING: {
    title: "No configuration installed",
    next: ["setup", "configure"],
  },
  CONFIG_INVALID: {
    title: "Configuration invalid",
    next: ["doctor", "configure"],
  },
  BINARY_MISSING: {
    title: "Harness binary not found",
    advice:
      "Install the harness, or point the lane at the right path, then check again.",
    next: ["setup", "doctor"],
  },
  BINARY_INVALID: {
    title: "Harness binary not usable",
    advice:
      "The path is not a regular file. Point the lane at the real binary.",
    next: ["setup", "doctor"],
  },
  BINARY_NOT_EXECUTABLE: {
    title: "Harness binary not executable",
    advice: "The file exists but is not marked executable for you.",
    next: ["doctor"],
  },
  BINARY_UNSAFE: {
    title: "Harness binary refused as unsafe",
    advice:
      "Crewplane refuses a binary that other users could replace or whose path they could redirect (for example group- or world-writable files or folders, or an untrusted symlink). It was not run. Make the binary and its folders writable only by you or root, or install the harness somewhere safe.",
    next: ["doctor", "setup"],
  },
  INSTRUCTIONS_INVALID: {
    title: "Instructions file unusable",
    advice:
      "The lane's instructions file could not be read as configured. Fix the path or file, then install again.",
    next: ["configure", "doctor"],
  },
  LEGACY_LAYOUT: {
    title: "Older supervisor layout present",
    advice:
      "An older release's supervisor directory still exists inside the project store. Resolve it from the command line before using controls that widen what runs.",
    next: ["doctor"],
  },
};
const WARNINGS = {
  INSTRUCTIONS_GLOBAL_UNAVAILABLE: "Global instructions could not be read.",
  DIGEST_UNAVAILABLE:
    "The configuration could not be fingerprinted, so it cannot be compared with what the supervisor loaded.",
};

/** One problem with its title, advice and the exact commands to run next. */
export function describeProblem(problem) {
  const known = Object.hasOwn(PROBLEMS, problem?.code)
    ? PROBLEMS[problem.code]
    : null;
  return {
    code: typeof problem?.code === "string" ? problem.code : "UNKNOWN",
    lane:
      typeof problem?.lane === "string" && problem.lane ? problem.lane : null,
    message: typeof problem?.message === "string" ? problem.message : "",
    title: known?.title ?? "Unrecognised problem",
    advice: known?.advice ?? null,
    known: known !== null,
    commands: (known?.next ?? ["doctor"]).map((key) => COMMANDS[key]),
  };
}
export const describeWarning = (warning) => ({
  code: warning?.code ?? "UNKNOWN",
  text:
    (Object.hasOwn(WARNINGS, warning?.code) ? WARNINGS[warning.code] : null) ??
    (typeof warning?.message === "string" ? warning.message : ""),
});

/** The suggested next steps for the whole configuration (deduplicated, in order). */
export function nextSteps(config) {
  if (!config) return [];
  if (config.state === "invalid") return [COMMANDS.doctor, COMMANDS.configure];
  if (config.state === "not-configured")
    return [COMMANDS.setup, COMMANDS.configure, COMMANDS.doctor];
  const steps = [];
  for (const problem of config.problems ?? [])
    for (const step of describeProblem(problem).commands)
      if (!steps.includes(step)) steps.push(step);
  if (!steps.length) steps.push(COMMANDS.doctor);
  return steps;
}

const PERMISSIONS = {
  "no-tools": "No tools",
  "auto-approve": "Auto-approve",
  "harness-configured": "Set by the harness's own configuration",
  "harness-controlled": "Controlled by the harness",
  invalid: "Invalid",
};
export function permissionsLabel(value) {
  if (typeof value !== "string") return null;
  if (Object.hasOwn(PERMISSIONS, value)) return PERMISSIONS[value];
  return value.startsWith("permission-mode:")
    ? `Claude permission mode ${value.slice("permission-mode:".length)}`
    : "Invalid";
}

const ROLE = {
  coordinator: "Coordinator",
  reviewer: "Reviewer",
  implementer: "Implementer",
};
export const roleLabel = (lane) =>
  `${ROLE[lane?.role] ?? "Not recorded"}${lane?.reviewerRole ? ` (${lane.reviewerRole})` : ""}`;

function binaryStatus(lane) {
  if (lane?.valid === false || !lane?.binary)
    return { tone: "unknown", text: "Not inspected", detail: null };
  if (lane.binary.ok)
    return {
      tone: "success",
      text: "Found, not executed",
      detail: lane.binary.path ?? null,
    };
  return {
    tone: "danger",
    text: lane.binary.code ?? "Problem",
    detail: lane.binary.problem ?? null,
  };
}

const cap = (own, effective, unit) =>
  effective === null || effective === undefined
    ? "No cap"
    : `${formatCount(effective)}${unit}${own === null || own === undefined ? " (default)" : ""}`;

/** One row per lane for the lanes table; unknown fields stay null. */
export function laneRows(config) {
  return (config?.lanes ?? []).map((lane) => {
    const budgets = lane.budgets ?? null;
    return {
      id: lane.id ?? "",
      enabled: lane.enabled === true,
      valid: lane.valid !== false,
      harness: lane.harness ?? null,
      model: lane.model ?? null,
      role: roleLabel(lane),
      permissions: permissionsLabel(lane.permissions),
      instructions: !lane.instructions
        ? null
        : lane.instructions.status === "invalid"
          ? "Invalid"
          : lane.instructions.configured
            ? "Configured"
            : "None",
      caps: budgets
        ? [
            [
              "Runs per hour",
              cap(budgets.maxRunsPerHour, budgets.effectiveMaxRunsPerHour, ""),
            ],
            [
              "Minutes per run",
              cap(budgets.maxRunMinutes, budgets.effectiveMaxRunMinutes, ""),
            ],
            [
              "Cost per run",
              budgets.maxCostUsdPerRun === null ||
              budgets.maxCostUsdPerRun === undefined
                ? "No cap"
                : (formatUsd(budgets.maxCostUsdPerRun) ?? "Not recorded"),
            ],
          ]
        : [],
      passEnv: Array.isArray(lane.passEnv) ? lane.passEnv : [],
      usageCoverage:
        typeof lane.capabilities?.usage === "string"
          ? lane.capabilities.usage
          : null,
      binary: binaryStatus(lane),
    };
  });
}

/** Configured vs loaded budgets, row by row, with whether they differ. */
export function budgetRows(budgets) {
  const configured = budgets?.configured ?? null;
  const loaded = budgets?.loaded ?? null;
  return [
    ["maxParallel", "Concurrent agents"],
    ["maxRunsPerHour", "Runs per agent per hour (default)"],
    ["maxRunMinutes", "Minutes per run (default)"],
    ["intervalSeconds", "Check interval (seconds)"],
  ].map(([key, label]) => {
    const a = configured?.[key] ?? null;
    const b = loaded?.[key] ?? null;
    return {
      label,
      configured: a === null ? null : formatCount(a),
      loaded: b === null ? null : formatCount(b),
      differs: a !== null && b !== null ? a !== b : null,
    };
  });
}
/** The reload indication in words. */
export function reloadNote(budgets) {
  if (!budgets?.configured) return null;
  if (budgets.reloadPending === true)
    return "Reload pending: the running supervisor has loaded a different configuration than the one installed. Installed values apply once it reloads.";
  if (budgets.reloadPending === false)
    return "The running supervisor has loaded the installed configuration.";
  return budgets.loaded
    ? "Whether the supervisor has loaded the installed configuration is unknown."
    : "The supervisor has not recorded a loaded configuration (it may not be running).";
}

/** Digest facts: short form for reading, full form for copying. */
export function digestFacts(config) {
  const digest = config?.digest ?? null;
  const loaded = config?.loadedDigest ?? null;
  return {
    digest,
    short: shortHash(digest),
    loadedShort: shortHash(loaded),
    match:
      config?.digestsMatch === true
        ? "Matches the running supervisor."
        : config?.digestsMatch === false
          ? "Differs from what the running supervisor loaded."
          : digest === null
            ? config?.state === "not-configured"
              ? "No configuration is installed, so there is no digest to compare."
              : "No digest: the configuration cannot be fingerprinted."
            : "Unknown: the supervisor has not recorded a loaded digest.",
  };
}

/** The "stale roles" hint (installed roles differ from the committed project policy). */
export function rolesNote(roles) {
  if (!roles) return null;
  return roles.stale === true
    ? "The installed roles differ from the project's committed policy (crewplane.json). Re-run guided setup or install an updated configuration to bring them back in line."
    : null;
}

/** Notices about bounded output. */
export function truncationNotes(config) {
  const notes = [];
  if (config?.lanesTruncated === true)
    notes.push(
      "Only the first 64 agents are shown and checked. Others in the configuration are not listed here; run crewplane doctor for the full check.",
    );
  if (config?.problemsTruncated === true)
    notes.push(
      "Only the first 100 problems are listed. Fix these and check again to see the rest.",
    );
  return notes;
}
