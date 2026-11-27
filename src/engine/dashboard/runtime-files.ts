import { join } from "node:path";
import type { Config, State } from "../../contracts.ts";
import { checkControlDirectory, controlDirectory } from "../../control.ts";
import { normalizeConfig, normalizeState } from "./headless.ts";
import { readJsonFile } from "./sanitize.ts";

/**
 * Persisted supervisor state and installed configuration, read-only from the
 * private control directory. Anything unreadable, unsafe or oversized is null.
 */
export async function readRuntime(
  root: string,
): Promise<{ state: State | null; config: Config | null }> {
  const control = controlDirectory(root);
  try {
    checkControlDirectory(control);
  } catch {
    return { state: null, config: null };
  }
  const [state, config] = await Promise.all([
    readJsonFile(join(control, "state.json")),
    readJsonFile(join(control, "config.json")),
  ]);
  return { state: normalizeState(state), config: normalizeConfig(config) };
}
