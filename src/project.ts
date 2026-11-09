import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { gitEnvironment } from "./environment.ts";

/** Canonicalize existing ancestors without creating a store during discovery. */
function canonicalStore(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}
export const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) &&
  !Object.hasOwn(Object.prototype, value) &&
  !["prototype", "all"].includes(value);
export const validTaskId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
/** Terminal-safe rendering: untrusted paths never carry control bytes out. */
export const printablePath = (value: string) => value.replace(/\p{Cc}/gu, "?");
export type ReviewerRole = "code" | "visual";
export const reviewerRoleOf = (
  config: Roles | null | undefined,
  id: string,
): ReviewerRole => config?.reviewerRoles?.[id] ?? "code";
export interface Roles {
  reviewerRoles?: Record<string, ReviewerRole>;
  coordinator?: string;
  reviewers?: string[];
}
export const coordinatorOf = (config?: Roles | null) =>
  config?.coordinator ?? "coordinator";
export const reviewersOf = (config?: Roles | null) =>
  config?.reviewers ?? ["reviewer", "visual"];
export interface ProjectPolicy extends Roles {
  version: 1 | 2;
  requiredVersion?: string;
  promptFiles?: Record<string, string[]>;
  tasksPath: string;
  planPath: string;
  statusPath: string;
  instructionsPath: string;
  roadmapFormat?: "none" | "relay";
}
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
/** A project pinned to a release this executable is not, with where to look. */
export class ProjectVersionError extends Error {
  readonly required: string;
  readonly running: string;
  readonly policyPath: string;
  constructor(pin: {
    required: string;
    running: string;
    policyPath: string;
  }) {
    super(
      `Project requires Crewplane ${pin.required}; running ${pin.running}. Install the required release before running project commands.`,
    );
    this.name = "ProjectVersionError";
    this.required = pin.required;
    this.running = pin.running;
    this.policyPath = pin.policyPath;
  }
}
export const defaultPolicy: ProjectPolicy = {
  version: 1,
  roadmapFormat: "none",
  coordinator: "coordinator",
  reviewers: ["reviewer", "visual"],
  reviewerRoles: { visual: "visual" },
  tasksPath: "tasks",
  planPath: "PLAN.md",
  statusPath: "STATUS.md",
  instructionsPath: "AGENTS.md",
};
export function projectPolicy(
  root: string,
  options: { checkVersion?: boolean } = {},
): ProjectPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(`${root}/crewplane.json`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...defaultPolicy };
    throw new Error("Invalid crewplane.json");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid project policy");
  const p = { ...defaultPolicy, ...raw } as ProjectPolicy;
  if (!("reviewerRoles" in raw))
    p.reviewerRoles = Object.fromEntries(
      Object.entries(defaultPolicy.reviewerRoles ?? {}).filter(
        ([id]) => Array.isArray(p.reviewers) && p.reviewers.includes(id),
      ),
    );
  if (p.version === 1 && ("requiredVersion" in raw || "promptFiles" in raw))
    throw new Error(
      "requiredVersion and promptFiles require project policy version 2",
    );
  // The pin is decoded before roles and schema version so a project owned by a
  // newer release names the pin instead of an unrelated policy error.
  if (p.requiredVersion !== undefined) {
    if (
      typeof p.requiredVersion !== "string" ||
      !exactVersion.test(p.requiredVersion)
    )
      throw new Error("requiredVersion must be an exact release version");
    if (p.requiredVersion !== pkg.version && options.checkVersion !== false)
      throw new ProjectVersionError({
        required: p.requiredVersion,
        running: pkg.version,
        policyPath: join(root, "crewplane.json"),
      });
  }
  if (![1, 2].includes(p.version))
    throw new Error("Unsupported project policy version");
  if (
    !["none", "relay"].includes(p.roadmapFormat ?? "none") ||
    !validId(p.coordinator) ||
    !Array.isArray(p.reviewers) ||
    !p.reviewers.every(validId) ||
    new Set([p.coordinator, ...p.reviewers]).size !== p.reviewers.length + 1
  )
    throw new Error("Invalid project roles");
  if (
    !p.reviewerRoles ||
    typeof p.reviewerRoles !== "object" ||
    Array.isArray(p.reviewerRoles) ||
    Object.entries(p.reviewerRoles).some(
      ([id, role]) =>
        !p.reviewers?.includes(id) || !["code", "visual"].includes(role),
    )
  )
    throw new Error("Invalid reviewer roles");
  for (const path of [
    p.tasksPath,
    p.planPath,
    p.statusPath,
    p.instructionsPath,
  ])
    validateProjectPath(path);
  if (p.promptFiles !== undefined) {
    if (
      !p.promptFiles ||
      typeof p.promptFiles !== "object" ||
      Array.isArray(p.promptFiles) ||
      Object.keys(p.promptFiles).length > 64
    )
      throw new Error("Invalid project promptFiles");
    for (const [agent, files] of Object.entries(p.promptFiles)) {
      if (
        !validId(agent) ||
        !Array.isArray(files) ||
        files.length > 16 ||
        new Set(files).size !== files.length
      )
        throw new Error("Invalid agent prompt file list");
      for (const path of files) validateProjectPath(path, true);
    }
  }
  return p;
}

/**
 * Repoint the primary checkout's pin at `version`, preserving every other key
 * and the file's formatting. Pins are policy, so callers keep the guards
 * (policy version, no live supervisor) and confirmation in the CLI.
 */
export function writeProjectPin(
  root: string,
  version: string,
): { file: string; from: string; changed: boolean } {
  const file = join(root, "crewplane.json");
  let original: string;
  let parsed: unknown;
  try {
    original = readFileSync(file, "utf8");
    parsed = JSON.parse(original);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Project has no crewplane.json to pin");
    throw new Error("Invalid crewplane.json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid crewplane.json");
  const policy = parsed as Record<string, unknown>;
  if (policy.version !== 2)
    throw new Error("requiredVersion requires project policy version 2");
  const from = policy.requiredVersion;
  if (typeof from !== "string" || !exactVersion.test(from))
    throw new Error(
      "Project is not pinned; add requiredVersion under project policy version 2",
    );
  if (!exactVersion.test(version))
    throw new Error("Pin target must be an exact release version");
  if (from === version) return { file, from, changed: false };
  const stat = lstatSync(file);
  if (!stat.isFile())
    throw new Error("crewplane.json must be a regular file to be repinned");
  const temporary = join(root, `.crewplane.json.${process.pid}.tmp`);
  // Rewrite only the pinned value so the commit diff is one line; fall back to a
  // full re-serialize when the file does not hold exactly one pin field.
  const field = /("requiredVersion"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
  const content =
    [...original.matchAll(field)].length === 1
      ? original.replace(
          field,
          (_match, head: string) => `${head}${JSON.stringify(version)}`,
        )
      : `${JSON.stringify({ ...policy, requiredVersion: version }, null, 2)}\n`;
  try {
    writeFileSync(temporary, content, { mode: stat.mode & 0o777 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { file, from, changed: true };
}

export function validateProjectPath(
  path: unknown,
  promptFile = false,
): asserts path is string {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some((x) =>
        (promptFile
          ? ["", ".", "..", ".git", ".crewplane-state", ".crewplane-local"]
          : [".", "..", ".git"]
        ).includes(x),
      ) ||
    /[\p{Cc}]/u.test(path)
  )
    throw new Error("Project document paths must be safe relative paths");
}

export function discoverProject(cwd: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: gitEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("rev-parse", "--is-bare-repository") === "true")
    throw new Error("Crewplane requires a non-bare Git project");
  const root = realpathSync(git("rev-parse", "--show-toplevel"));
  const common = realpathSync(
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const gitDir = realpathSync(git("rev-parse", "--absolute-git-dir"));
  const reportedPrimary = git("worktree", "list", "--porcelain", "-z")
    .split("\0")[0]
    ?.slice("worktree ".length);
  let primary = gitDir === common ? root : reportedPrimary;
  if (reportedPrimary === common && gitDir !== common) {
    try {
      const binding = JSON.parse(
        readFileSync(join(common, "crewplane-project.json"), "utf8"),
      ) as { version: number; root: string; common: string };
      if (
        binding.version !== 1 ||
        binding.common !== common ||
        typeof binding.root !== "string"
      )
        throw new Error("Invalid primary binding");
      primary = realpathSync(binding.root);
      const actualCommon = execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: primary, env: gitEnvironment(), encoding: "utf8" },
      ).trim();
      if (realpathSync(actualCommon) !== common)
        throw new Error("Primary binding belongs to another repository");
    } catch {
      throw new Error(
        "Initialize Crewplane in the primary checkout before using a linked worktree with a separate Git directory",
      );
    }
  }
  if (!primary || !isAbsolute(primary))
    throw new Error("Cannot resolve primary worktree");
  if (
    process.env.CREWPLANE_COORD_DIR &&
    !isAbsolute(process.env.CREWPLANE_COORD_DIR)
  )
    throw new Error("CREWPLANE_COORD_DIR must be an absolute shared path");
  return {
    root,
    common,
    primary: realpathSync(primary),
    store: canonicalStore(
      process.env.CREWPLANE_COORD_DIR ||
        join(realpathSync(primary), ".crewplane-state"),
    ),
  };
}
