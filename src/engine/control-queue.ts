import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureControlDirectory } from "../control.ts";
import { publishJson } from "../io.ts";
import {
  type ControlTarget,
  isLive,
  readBoundedJson,
  supervisorLiveness,
} from "../migrate.ts";
import { printablePath } from "../project.ts";
import { type Control, control } from "./control-policy.ts";

/** Verbs that only ever narrow what runs; they are queued in every candidate directory. */
export const narrowingActions = ["pause", "stop", "cancel"] as const;
export const isNarrowingAction = (action: string) =>
  (narrowingActions as readonly string[]).includes(action);

/**
 * The one place a control command is written to the supervisor queue, shared
 * by the CLI and the dashboard so they cannot drift. The control directory
 * copy is queued FIRST and unconditionally; narrowing verbs are also queued in
 * each `target.also` directory (legacy layouts), best effort, never following a
 * symlinked legacy directory or `commands/`, and each copy is bound to THAT
 * directory's own supervisor generation. Returns whether any supervisor looks
 * live in the directories used.
 */
export async function queueControl(options: {
  id: string;
  value: Control;
  /** The private control directory of this project. */
  controlDir: string;
  target: ControlTarget;
  /** Whether the caller already knows the target directory's state says running. */
  knownRunning?: boolean;
  /** Fail with EEXIST rather than replace an existing control-directory copy. */
  exclusive?: boolean;
  warn?: (message: string) => void;
}): Promise<{ running: boolean }> {
  const { id, value, controlDir, target } = options;
  const warn = options.warn ?? (() => {});
  const directory = target.directory;
  let running = options.knownRunning === true;
  const targets = [
    directory,
    ...(isNarrowingAction(value.action) ? (target.also ?? []) : []),
  ].sort((a, b) => Number(b === controlDir) - Number(a === controlDir));
  for (const dir of targets) {
    let queued = value;
    if (dir !== directory) {
      const own = readBoundedJson(join(dir, "state.json")) as {
        generation?: string;
        running?: boolean;
      } | null;
      running ||= own?.running === true;
      queued = control({
        ...value,
        generation:
          typeof own?.generation === "string" ? own.generation : undefined,
      });
    }
    if (dir === controlDir) {
      await ensureControlDirectory(dir);
      await mkdir(join(dir, "commands"), { recursive: true, mode: 0o700 });
    } else {
      // Never follow a symlinked legacy directory or commands/ into somewhere
      // else, and never fail the halt because of it.
      try {
        if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
        const commands = join(dir, "commands");
        try {
          if (!lstatSync(commands).isDirectory())
            throw new Error("not a directory");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await mkdir(commands, { mode: 0o700 });
        }
      } catch {
        warn(
          `crewplane: ${printablePath(dir)} is not a plain directory; not queued there`,
        );
        continue;
      }
    }
    await publishJson(join(dir, "commands", `${id}.json`), queued, {
      exclusive: options.exclusive === true && dir === controlDir,
    }).catch((error) => {
      if (dir === controlDir) throw error;
      warn(`crewplane: could not queue in ${printablePath(dir)}; continuing`);
    });
  }
  running ||= isLive(supervisorLiveness(directory));
  return { running };
}
