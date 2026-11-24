import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishJson } from "../io.ts";
import { coordinatorOf } from "../project.ts";
import { main as coordination } from "./agents.mjs";
import { monitorStatus, snapshot } from "./read-model.ts";

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
interface Settings {
  intervalSeconds: number;
  staleMinutes: number;
  unansweredMinutes: number;
}
export interface Alert {
  key: string;
  kind: string;
  agent: string;
  task: string | null;
  text: string;
}
interface Observation {
  schemaVersion: 1;
  pid: number;
  running: boolean;
  checkedAt: string;
  lastChangedAt: string;
  intervalSeconds: number;
  snapshotHash: string;
  messageIds: string[];
  messageCount: number;
  unansweredCount: number;
  activeTasks: Array<{
    task: string;
    owner: string;
    state: string;
    lastReportAt: string;
  }>;
  alerts: Alert[];
  error: string | null;
}
const defaults: Settings = {
  intervalSeconds: 30,
  staleMinutes: 20,
  unansweredMinutes: 5,
};

export function summarize(data: Snapshot, settings: Settings, now: Date) {
  const alerts: Alert[] = [];
  const activeTasks: Observation["activeTasks"] = [];
  const old = (at: string, minutes: number) =>
    now.getTime() - Date.parse(at) >= minutes * 60000;
  for (const task of data.tasks) {
    const live = task.live;
    if (!live || live.accepted) continue;
    const lastReportAt =
      live.status?.at ?? live.claim?.at ?? live.assignment.at;
    const state = live.status?.state ?? (live.claim ? "claimed" : "assigned");
    activeTasks.push({
      task: task.id,
      owner: live.assignment.owner,
      state,
      lastReportAt,
    });
    const add = (kind: string, text: string) =>
      alerts.push({
        key: `${task.id}:${kind}`,
        kind,
        agent:
          kind === "review"
            ? (data.coordinator ?? coordinatorOf())
            : live.assignment.owner,
        task: task.id,
        text,
      });
    if (!live.claim)
      add(
        "unclaimed",
        "Assignment has no claim. Resume the owning harness if needed.",
      );
    else if (state === "ready")
      add("review", "Ready handoff needs coordinator review.");
    else if (state === "blocked")
      add(
        "blocked",
        "Owner reports blocked work. Check its latest status and questions.",
      );
    else if (old(lastReportAt, settings.staleMinutes))
      add(
        "stale",
        `No task progress report for at least ${settings.staleMinutes} minutes. Check the owner; do not infer it stopped.`,
      );
  }
  for (const message of data.unanswered) {
    const overdue = old(message.at, settings.unansweredMinutes);
    alerts.push({
      key: `message:${message.id}`,
      kind: overdue ? "overdue-answer" : "needs-answer",
      agent: message.to,
      task: message.task,
      text: `${message.kind} from ${message.from} ${overdue ? `has waited at least ${settings.unansweredMinutes} minutes` : "needs a response"}. Open the original thread.`,
    });
  }
  return {
    activeTasks,
    alerts,
    snapshotHash: createHash("sha256")
      .update(
        JSON.stringify({
          tasks: data.tasks,
          messages: data.messages,
          unanswered: data.unanswered,
          milestoneStatus: data.milestoneStatus,
        }),
      )
      .digest("hex"),
    messageIds: data.messages.map((message) => message.id),
    messageCount: data.messages.length,
    unansweredCount: data.unanswered.length,
  };
}

async function json<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const atomic = (path: string, data: unknown) => publishJson(path, data);
// A torn or empty lock file is never guessed at; the operator must inspect it.
async function lockJson<T>(path: string): Promise<T | null> {
  try {
    return await json<T>(path);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Invalid watcher lock; inspect it manually");
    throw error;
  }
}
// A corrupt observation is replaced by the next poll rather than killing it.
async function readObservation(path: string): Promise<Observation | null> {
  try {
    return await json<Observation>(path);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
export async function acquire(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "watcher.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, token }), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      return async () => {
        const lock = await lockJson<{ token: string }>(path);
        if (lock?.token === token) await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = await lockJson<{ pid: number; token: string }>(path);
      if (!lock) continue;
      if (!Number.isInteger(lock.pid) || lock.pid < 1 || !lock.token)
        throw new Error("Invalid watcher lock; inspect it manually");
      // Serialize stale-owner recovery so two starters cannot remove a new owner's lock.
      const recovery = join(directory, "recovery.lock");
      try {
        await writeFile(recovery, String(process.pid), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(
            "Watcher recovery is in progress or was interrupted; inspect recovery.lock manually",
          );
        throw e;
      }
      try {
        const current = await lockJson<{ pid: number; token: string }>(path);
        if (current?.token !== lock.token) continue;
        let alive = true;
        try {
          process.kill(current.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive)
          throw new Error(
            `Watcher already owns this store (PID ${current.pid})`,
          );
        // Never reclaim a live owner on a heartbeat timeout.
        await unlink(path);
      } finally {
        await unlink(recovery);
      }
    }
  }
  throw new Error(
    "Watcher ownership changed concurrently; retry after inspecting status",
  );
}

export async function poll(
  root: string,
  directory: string,
  settings = defaults,
  now = new Date(),
  running = true,
) {
  const path = join(directory, "latest.json");
  const previous = await readObservation(path);
  const summary = summarize(await snapshot(root), settings, now);
  const checkedAt = now.toISOString();
  const changed =
    summary.snapshotHash !== previous?.snapshotHash ||
    JSON.stringify(summary.alerts) !== JSON.stringify(previous?.alerts) ||
    Boolean(previous?.error);
  const observation: Observation = {
    schemaVersion: 1,
    pid: process.pid,
    running,
    checkedAt,
    lastChangedAt: changed ? checkedAt : previous.lastChangedAt,
    intervalSeconds: settings.intervalSeconds,
    ...summary,
    error: null,
  };
  if (changed) {
    const known = new Set(previous?.messageIds ?? summary.messageIds);
    const event = {
      at: checkedAt,
      kind: previous ? "changed" : "baseline",
      activeTasks: summary.activeTasks,
      messageCount: summary.messageCount,
      newMessageIds: summary.messageIds.filter((id) => !known.has(id)),
      alerts: summary.alerts,
    };
    const events = join(directory, "events");
    await mkdir(events, { recursive: true, mode: 0o700 });
    await atomic(
      join(events, `${checkedAt.replaceAll(":", "-")}-${randomUUID()}.json`),
      event,
    );
    const files = (await readdir(events))
      .filter((name) => /^\d{4}-.*\.json$/.test(name))
      .sort();
    for (const file of files.slice(0, -200)) await unlink(join(events, file));
  }
  await atomic(path, observation);
  return { observation, changed };
}

export async function run(
  root: string,
  directory: string,
  settings: Settings,
  once: boolean,
  signal: AbortSignal,
) {
  const release = await acquire(directory);
  let last: Observation | null = null;
  try {
    do {
      try {
        const result = await poll(root, directory, settings, new Date(), !once);
        last = result.observation;
        if (result.changed)
          console.log(
            JSON.stringify({
              at: last.checkedAt,
              messages: last.messageCount,
              activeTasks: last.activeTasks,
              alerts: last.alerts,
            }),
          );
      } catch (cause) {
        // Retain the last successful snapshot, but never present it as current.
        if (!last)
          throw new Error(
            "Cannot read board; inspect coordination records and retry",
            { cause },
          );
        last = {
          ...last,
          checkedAt: new Date().toISOString(),
          error: "Board read failed; showing last successful observation",
        };
        await atomic(join(directory, "latest.json"), last);
        console.error(last.error);
      }
      if (once || signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, settings.intervalSeconds * 1000);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    } while (!signal.aborted);
  } finally {
    try {
      if (last)
        await atomic(join(directory, "latest.json"), {
          ...last,
          running: false,
        });
    } finally {
      await release();
    }
  }
}

export async function monitorMain(
  args = process.argv.slice(2),
  cwd = process.cwd(),
) {
  const settings = { ...defaults };
  let once = false;
  let status = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--once") once = true;
    else if (arg === "--status") status = true;
    else {
      const keys: Record<string, keyof Settings> = {
        "--interval": "intervalSeconds",
        "--stale-minutes": "staleMinutes",
        "--unanswered-minutes": "unansweredMinutes",
      };
      const key = Object.hasOwn(keys, arg ?? "") ? keys[arg ?? ""] : undefined;
      const value = Number(args[++i]);
      if (!key || !Number.isInteger(value) || value < 1 || value > 3600)
        throw new Error(
          "Use --once, --status, --interval N, --stale-minutes N or --unanswered-minutes N (1–3600)",
        );
      settings[key] = value;
    }
  }
  const ctx = (await coordination(["init"], cwd)) as {
    store: string;
    gitCommonDir: string;
    projectRoot: string;
  };
  const directory = join(ctx.store, "monitor");
  if (status) {
    const current = await readObservation(join(directory, "latest.json"));
    console.log(
      JSON.stringify(
        {
          health: (await monitorStatus(ctx.store)).state,
          pid: current?.pid ?? null,
          checkedAt: current?.checkedAt ?? null,
          lastChangedAt: current?.lastChangedAt ?? null,
          messageCount: current?.messageCount ?? 0,
          unansweredCount: current?.unansweredCount ?? 0,
          activeTasks: current?.activeTasks ?? [],
          alerts: current?.alerts ?? [],
          error: current?.error ?? null,
        },
        null,
        2,
      ),
    );
  } else {
    const controller = new AbortController();
    for (const s of ["SIGINT", "SIGTERM"] as const)
      process.once(s, () => controller.abort());
    console.log(
      `Watching coordination every ${settings.intervalSeconds}s; PID ${process.pid}; ${directory}`,
    );
    await run(ctx.projectRoot, directory, settings, once, controller.signal);
  }
}
if (import.meta.main)
  monitorMain().catch((error: unknown) => {
    console.error(
      `watcher: ${error instanceof Error ? error.message : "Unavailable"}`,
    );
    process.exitCode = 1;
  });
