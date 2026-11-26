import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../contracts.ts";
import { bindControl, ensureControlDirectory } from "../control.ts";
import { instructionFileProblem } from "../engine/harness.ts";
import { validateConfig } from "../engine/supervisor.ts";
import { acquire } from "../engine/watch.ts";
import { publishJson } from "../io.ts";
import { isLive, supervisorLiveness } from "../migrate.ts";
import type { ProjectPolicy } from "../project.ts";

export interface InstallTarget {
  /** Primary project root; always overrides any `root` in the input. */
  root: string;
  /** Committed policy; its roles always override any roles in the input. */
  policy: Pick<ProjectPolicy, "coordinator" | "reviewers" | "reviewerRoles">;
  store: string;
  /** Verified private control directory. */
  directory: string;
  identity: { primaryRoot: string; gitCommon: string };
}

/**
 * Decode untrusted runtime JSON exactly as `configure` always has: the project
 * supplies root and roles, validateConfig is the only decoder.
 */
export const decodeConfig = (
  value: Record<string, unknown>,
  target: Pick<InstallTarget, "root" | "policy">,
  options: { checkBinary?: boolean } = {},
) =>
  validateConfig(
    {
      ...value,
      root: target.root,
      coordinator: target.policy.coordinator,
      reviewers: target.policy.reviewers,
      reviewerRoles: target.policy.reviewerRoles,
    } as unknown as Config,
    options,
  );

/**
 * The single install path shared by `configure --file` and `setup --install`:
 * validate, check lane instruction files, then publish under the private
 * control-directory lock, refusing while a supervisor state says it is running.
 */
export async function installConfig(
  value: Record<string, unknown>,
  target: InstallTarget,
  options: { requireStopped?: boolean } = {},
): Promise<Config> {
  const config = decodeConfig(value, target);
  for (const [laneId, lane] of Object.entries(config.lanes)) {
    if (!lane.instructionsPath) continue;
    const problem = instructionFileProblem(config.root, lane.instructionsPath);
    if (problem)
      throw new Error(`Lane ${laneId} instructions unavailable: ${problem}`);
  }
  await ensureControlDirectory(target.directory);
  await bindControl(target.store, target.directory, target.identity);
  const release = await acquire(target.directory);
  try {
    const state = await readState(join(target.directory, "state.json"));
    if (state?.running)
      throw new Error(
        "Stop and inspect the existing supervisor before replacing configuration",
      );
    // `setup --install` additionally refuses on supervisor liveness evidence
    // (the same oracle `pin` uses); `configure` keeps its recorded-state check.
    // Our own lock lease is not evidence of a supervisor.
    if (options.requireStopped) {
      const live = supervisorLiveness(target.directory, { skipLease: true });
      if (isLive(live))
        throw new Error(
          `Stop and inspect the existing supervisor before replacing configuration (${[live.credible, live.heartbeat, live.children].filter(Boolean).join("; ")})`,
        );
    }
    await publishJson(join(target.directory, "config.json"), config);
  } finally {
    await release();
  }
  return config;
}

/**
 * Why the stop confirmation cannot be recorded, or null when nothing says a
 * supervisor is running. Read-only; uses the recorded `running` flag and the
 * shared liveness oracle exactly as `pin` does.
 */
export async function stoppedProblem(
  directory: string,
): Promise<string | null> {
  const state = await readState(join(directory, "state.json"));
  if (state?.running) return "the control state says a supervisor is running";
  const live = supervisorLiveness(directory);
  if (isLive(live))
    return `a supervisor appears to be live (${[live.credible, live.heartbeat, live.children].filter(Boolean).join("; ")})`;
  return null;
}

async function readState(path: string): Promise<{ running?: boolean } | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid private state; inspect before recovery");
  }
}
