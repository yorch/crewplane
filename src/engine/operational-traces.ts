import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { durableMkdir, publishJson } from "../io.ts";
import { withProcessLock } from "../process-lock.ts";
import { validId, validTaskId } from "../project.ts";
import { type Harness, validHarness, validSessionId } from "./harness.ts";

export const traceIdPattern =
  /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const kinds = [
  "started",
  "session",
  "assistant",
  "tool-start",
  "tool-finish",
  "usage",
  "omitted",
  "finished",
  "error",
] as const;
type Kind = (typeof kinds)[number];
const messages: Record<Kind, string> = {
  started: "Native run started",
  session: "Native session captured",
  assistant: "User-facing message emitted; unclassified text omitted",
  "tool-start": "Tool started; arguments omitted",
  "tool-finish": "Tool finished; payload omitted",
  usage: "Observed usage metadata",
  omitted: "Native payload omitted by collection policy",
  finished: "Native run finished",
  error: "Native run failed",
};
const tools = new Set([
  "exec_command",
  "apply_patch",
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "other-tool",
]);
const statuses = ["running", "succeeded", "failed", "finished", "paused"];
const states = ["working", "waiting", "ready", "needs_operator"];
export interface TraceInput {
  kind: Kind;
  channel?: "system" | "stdout" | "stderr";
  tool?: string | null;
  status?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  model?: string | null;
  effort?: string | null;
  artifactIds?: string[];
}
export interface TraceMeta {
  version: 1;
  runId: string;
  lane: string;
  task: string | null;
  harness: Harness;
  sessionId: string | null;
  startedAt: string;
  status: string;
  events: number;
  bytes: number;
  truncated: boolean;
  omitted: number;
  finalState: string | null;
}
export interface TraceEvent {
  version: 1;
  runId: string;
  lane: string;
  task: string | null;
  harness: Harness;
  sessionId: string | null;
  sequence: number;
  at: string;
  kind: Kind;
  channel: "system" | "stdout" | "stderr";
  message: string;
  tool: string | null;
  status: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  model: string | null;
  effort: string | null;
  artifactIds: string[];
}
const bounded = (v: unknown, max = 1e12) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max
    ? v
    : null;
const model = (v: unknown) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_./:-]{1,100}$/.test(v) &&
  !/(?:sk-|token|secret|password|https?:)/i.test(v)
    ? v
    : null;
function project(
  meta: TraceMeta,
  input: TraceInput,
  sequence: number,
  at = new Date().toISOString(),
): TraceEvent {
  const kind = kinds.includes(input.kind) ? input.kind : "omitted";
  return {
    version: 1,
    runId: meta.runId,
    lane: meta.lane,
    task: meta.task,
    harness: meta.harness,
    sessionId: meta.sessionId,
    sequence,
    at,
    kind,
    channel: ["system", "stdout", "stderr"].includes(input.channel ?? "")
      ? (input.channel ?? "system")
      : "system",
    message: messages[kind],
    tool: input.tool
      ? tools.has(input.tool)
        ? input.tool
        : "other-tool"
      : null,
    status: statuses.includes(input.status ?? "")
      ? (input.status ?? null)
      : null,
    inputTokens: bounded(input.inputTokens),
    outputTokens: bounded(input.outputTokens),
    durationMs: bounded(input.durationMs, 86400000),
    model: model(input.model),
    effort: [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ].includes(input.effort ?? "")
      ? (input.effort ?? null)
      : null,
    artifactIds: (input.artifactIds ?? [])
      .filter((id) => /^ev_[a-f0-9]{32}$/.test(id))
      .slice(0, 8),
  };
}
const traceTools: Record<string, string> = {
  bash: "bash",
  shell: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  patch: "apply_patch",
  apply_patch: "apply_patch",
  grep: "grep",
  glob: "find",
  find: "find",
  ls: "ls",
  list: "ls",
};
const traceTool = (value: unknown) =>
  typeof value === "string"
    ? (traceTools[value.toLowerCase()] ?? "other-tool")
    : "other-tool";
export function nativeTrace(
  harness: Harness,
  event: Record<string, unknown>,
): TraceInput[] {
  const channel = "stdout" as const;
  if (
    (harness === "codex" && event.type === "thread.started") ||
    (harness === "pi" && event.type === "session") ||
    (harness === "claude" &&
      event.type === "system" &&
      event.subtype === "init") ||
    (harness === "opencode" && event.type === "step_start")
  )
    return [{ kind: "session", channel }];
  if (harness === "claude") {
    if (event.type === "assistant" || event.type === "user") {
      const message = event.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const out: TraceInput[] = [];
      for (const block of message?.content ?? []) {
        if (block.type === "tool_use")
          out.push({
            kind: "tool-start",
            channel,
            tool: traceTool(block.name),
            status: "running",
          });
        else if (block.type === "tool_result")
          out.push({
            kind: "tool-finish",
            channel,
            tool: "other-tool",
            status: block.is_error === true ? "failed" : "succeeded",
          });
        else if (block.type === "text" && event.type === "assistant")
          out.push({ kind: "assistant", channel });
      }
      return out;
    }
    if (event.type === "result") {
      const u = event.usage as Record<string, unknown> | undefined;
      const usage: TraceInput[] = [
        {
          kind: "usage",
          channel,
          ...(typeof u?.input_tokens === "number"
            ? { inputTokens: u.input_tokens }
            : {}),
          ...(typeof u?.output_tokens === "number"
            ? { outputTokens: u.output_tokens }
            : {}),
        },
      ];
      if (event.is_error === true || event.subtype !== "success")
        usage.push({ kind: "error", channel });
      return usage;
    }
    return [];
  }
  if (harness === "opencode") {
    const part = event.part as Record<string, unknown> | undefined;
    if (event.type === "text") return [{ kind: "assistant", channel }];
    if (event.type === "tool_use") {
      const state = part?.state as Record<string, unknown> | undefined;
      const status = state?.status;
      if (status === "completed")
        return [
          {
            kind: "tool-finish",
            channel,
            tool: traceTool(part?.tool),
            status: "succeeded",
          },
        ];
      if (status === "error" || status === "failed")
        return [
          {
            kind: "tool-finish",
            channel,
            tool: traceTool(part?.tool),
            status: "failed",
          },
        ];
      // Running, pending and unknown states must not read as a success.
      return [
        {
          kind: "tool-start",
          channel,
          tool: traceTool(part?.tool),
          status: "running",
        },
      ];
    }
    if (event.type === "step_finish") {
      const t = part?.tokens as Record<string, unknown> | undefined;
      return [
        {
          kind: "usage",
          channel,
          ...(typeof t?.input === "number" ? { inputTokens: t.input } : {}),
          ...(typeof t?.output === "number" ? { outputTokens: t.output } : {}),
        },
      ];
    }
    if (event.type === "error") return [{ kind: "error", channel }];
    return [];
  }
  if (harness === "pi") {
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    )
      return [
        {
          kind:
            event.type === "tool_execution_start"
              ? "tool-start"
              : "tool-finish",
          channel,
          tool:
            typeof event.toolName === "string" ? event.toolName : "other-tool",
          status:
            event.type === "tool_execution_start"
              ? "running"
              : event.isError === true
                ? "failed"
                : "succeeded",
          ...(typeof event.durationMs === "number"
            ? { durationMs: event.durationMs }
            : {}),
        },
      ];
    const m = event.message as Record<string, unknown> | undefined;
    if (event.type === "message_end" && m?.role === "assistant") {
      const u = m.usage as Record<string, unknown> | undefined;
      return [
        { kind: "assistant", channel },
        {
          kind: "usage",
          channel,
          ...(typeof u?.input === "number" ? { inputTokens: u.input } : {}),
          ...(typeof u?.output === "number" ? { outputTokens: u.output } : {}),
          ...(typeof m.model === "string"
            ? {
                model: `${typeof m.provider === "string" ? m.provider : "unknown"}/${m.model}`,
              }
            : {}),
          ...(typeof m.thinkingLevel === "string"
            ? { effort: m.thinkingLevel }
            : {}),
        },
      ];
    }
  } else {
    if (event.type === "turn.completed") {
      const u = event.usage as Record<string, unknown> | undefined;
      return [
        {
          kind: "usage",
          channel,
          ...(typeof u?.input_tokens === "number"
            ? { inputTokens: u.input_tokens }
            : {}),
          ...(typeof u?.output_tokens === "number"
            ? { outputTokens: u.output_tokens }
            : {}),
        },
      ];
    }
    const item = event.item as Record<string, unknown> | undefined;
    if (
      (event.type === "item.started" || event.type === "item.completed") &&
      item
    ) {
      if (item.type === "reasoning") return [];
      if (item.type === "agent_message")
        return event.type === "item.completed"
          ? [{ kind: "assistant", channel }]
          : [];
      if (
        ["command_execution", "file_change", "mcp_tool_call"].includes(
          String(item.type),
        )
      )
        return [
          {
            kind: event.type === "item.started" ? "tool-start" : "tool-finish",
            channel,
            tool:
              item.type === "command_execution"
                ? "exec_command"
                : item.type === "file_change"
                  ? "edit"
                  : "other-tool",
            status:
              event.type === "item.started"
                ? "running"
                : typeof item.exit_code === "number" && item.exit_code !== 0
                  ? "failed"
                  : "succeeded",
          },
        ];
    }
  }
  // Streaming text/reasoning and all arbitrary args/stdout/stderr are excluded.
  return [];
}
export interface TraceLimits {
  maxEvents: number;
  maxRunBytes: number;
  maxRuns: number;
  maxTotalBytes: number;
}
export const traceLimits: Readonly<TraceLimits> = {
  maxEvents: 500,
  maxRunBytes: 2 * 1024 * 1024,
  maxRuns: 40,
  maxTotalBytes: 32 * 1024 * 1024,
};
export async function createTraceStore(
  directory: string,
  overrides: Partial<TraceLimits> = {},
) {
  let root = resolve(directory);
  const limits = { ...traceLimits, ...overrides };
  for (const [k, v] of Object.entries(limits))
    if (
      !Number.isSafeInteger(v) ||
      v < 1 ||
      v > traceLimits[k as keyof TraceLimits]
    )
      throw Error("Invalid trace limit");
  await durableMkdir(root);
  if ((await lstat(root)).isSymbolicLink()) throw Error("Unsafe trace root");
  root = await realpath(root);
  const path = (id: string, suffix: string) => {
    if (!traceIdPattern.test(id)) throw Error("Invalid run ID");
    return join(root, `${id}.${suffix}`);
  };
  async function read(id: string, suffix: string, max: number) {
    const h = await open(
      path(id, suffix),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const s = await h.stat();
      if (!s.isFile() || s.size > max) throw Error("Trace exceeds read limit");
      return await h.readFile("utf8");
    } finally {
      await h.close();
    }
  }
  async function atomic(meta: TraceMeta) {
    await publishJson(path(meta.runId, "meta.json"), meta, {
      directoryRoot: root,
    });
  }
  function cleanMeta(v: unknown): TraceMeta {
    const m = v as TraceMeta;
    if (
      m?.version !== 1 ||
      !traceIdPattern.test(m.runId) ||
      !validId(m.lane) ||
      !(m.task === null || validTaskId(m.task)) ||
      !validHarness(m.harness) ||
      !statuses.includes(m.status) ||
      !Number.isFinite(Date.parse(m.startedAt))
    )
      throw Error("Invalid trace metadata");
    return {
      version: 1,
      runId: m.runId,
      lane: m.lane,
      task: m.task,
      harness: m.harness,
      sessionId: validSessionId(m.harness, m.sessionId) ? m.sessionId : null,
      startedAt: m.startedAt,
      status: m.status,
      events: bounded(m.events, limits.maxEvents) ?? 0,
      bytes: bounded(m.bytes, limits.maxRunBytes) ?? 0,
      truncated: m.truncated === true,
      omitted: bounded(m.omitted) ?? 0,
      finalState: states.includes(m.finalState ?? "") ? m.finalState : null,
    };
  }
  async function list(
    options: {
      lane?: string;
      task?: string;
      harness?: string;
      before?: string;
      limit?: number;
    } = {},
  ) {
    if (options.before && !traceIdPattern.test(options.before))
      throw Error("Invalid cursor");
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw Error("Invalid page size");
    const names = (await readdir(root))
      .filter(
        (n) => n.endsWith(".meta.json") && traceIdPattern.test(n.slice(0, -10)),
      )
      .map((n) => n.slice(0, -10))
      .sort()
      .reverse();
    const runs: TraceMeta[] = [];
    let incomplete = false;
    for (const id of names) {
      if (options.before && id >= options.before) continue;
      try {
        const m = cleanMeta(JSON.parse(await read(id, "meta.json", 8192)));
        if (m.runId !== id) throw Error("Mismatched run");
        if (
          (!options.lane || m.lane === options.lane) &&
          (!options.task || m.task === options.task) &&
          (!options.harness || m.harness === options.harness)
        )
          runs.push(m);
      } catch {
        incomplete = true;
      }
      if (runs.length === limit) break;
    }
    return {
      version: 1,
      runs,
      nextCursor: runs.length === limit ? (runs.at(-1)?.runId ?? null) : null,
      incomplete,
      retentionLimited: names.length >= limits.maxRuns,
      nativePayloadsExcluded: true,
    };
  }
  async function prune(reserve = 0) {
    const names = (await readdir(root))
      .filter(
        (n) => n.endsWith(".meta.json") && traceIdPattern.test(n.slice(0, -10)),
      )
      .map((n) => n.slice(0, -10))
      .sort();
    let total = 0;
    const all: TraceMeta[] = [];
    for (const id of names) {
      try {
        const m = cleanMeta(JSON.parse(await read(id, "meta.json", 8192)));
        all.push(m);
        total += m.bytes + 8192;
      } catch {
        /* never follow unknown files */
      }
    }
    while (
      all.length + reserve > limits.maxRuns ||
      total > limits.maxTotalBytes
    ) {
      const i = all.findIndex((m) => m.status !== "running");
      if (i < 0) break;
      const m = all.splice(i, 1)[0];
      if (!m) break;
      for (const suffix of ["events.jsonl", "meta.json"])
        await unlink(path(m.runId, suffix)).catch(() => {});
      total -= m.bytes + 8192;
    }
    return { bytes: total, runs: all.length };
  }
  return {
    list,
    /**
     * Startup recovery for the exclusive supervisor, after checking prior native
     * children. The caller supplies its verified live run IDs; this store never
     * infers process ownership from a timestamp or prunes a protected live run.
     */
    async reconcile(activeRunIds: string[]) {
      if (
        !Array.isArray(activeRunIds) ||
        activeRunIds.some(
          (id) => typeof id !== "string" || !traceIdPattern.test(id),
        )
      )
        throw Error("Invalid active run IDs");
      const active = new Set(activeRunIds);
      const ids = new Set(
        (await readdir(root)).flatMap((name) => {
          const suffix = name.endsWith(".meta.json")
            ? ".meta.json"
            : name.endsWith(".meta.tmp")
              ? ".meta.tmp"
              : null;
          const id = suffix ? name.slice(0, -suffix.length) : "";
          return traceIdPattern.test(id) ? [id] : [];
        }),
      );
      let reconciled = 0;
      let incomplete = false;
      for (const id of ids) {
        if (active.has(id)) continue;
        try {
          let meta: TraceMeta;
          let fromTemporary = false;
          try {
            meta = cleanMeta(JSON.parse(await read(id, "meta.json", 8192)));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // A crash before the first atomic rename may leave only this file.
            // read() rejects symlinks and oversized/nonregular files.
            meta = cleanMeta(JSON.parse(await read(id, "meta.tmp", 8192)));
            fromTemporary = true;
          }
          if (meta.runId !== id) throw Error("Mismatched run");
          // unlink removes only this reserved leaf (including a stale symlink),
          // never its target. A live writer's temporary file is protected above.
          await unlink(path(id, "meta.tmp")).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
          if (meta.status === "running" || fromTemporary) {
            meta.status = "paused";
            meta.finalState = null;
            await atomic(meta);
            reconciled++;
          }
        } catch {
          incomplete = true;
        }
      }
      return { reconciled, incomplete };
    },
    async tail(id: string, after = 0, limit = 100) {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw Error("Invalid trace cursor");
      const meta = cleanMeta(JSON.parse(await read(id, "meta.json", 8192)));
      if (meta.runId !== id) throw Error("Mismatched run");
      const text = await read(id, "events.jsonl", limits.maxRunBytes);
      const events: TraceEvent[] = [];
      let incomplete = false;
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          if (Buffer.byteLength(line) > 4096) throw Error("Oversize event");
          const e = JSON.parse(line) as TraceEvent;
          if (
            !Number.isSafeInteger(e.sequence) ||
            e.sequence < 1 ||
            e.sequence > limits.maxEvents ||
            !Number.isFinite(Date.parse(e.at))
          )
            throw Error("Malformed event");
          if (e.sequence > after && events.length < limit)
            events.push(project(meta, e, e.sequence, e.at));
        } catch {
          incomplete = true;
        }
      }
      return {
        version: 1,
        meta,
        events,
        nextCursor: events.at(-1)?.sequence ?? after,
        incomplete,
        nativePayloadsExcluded: true,
      };
    },
    async begin(input: {
      runId: string;
      lane: string;
      task: string | null;
      harness: Harness;
    }) {
      return await withProcessLock(`${root}.lock`, async () => {
        const meta = cleanMeta({
          ...input,
          version: 1,
          sessionId: null,
          startedAt: new Date().toISOString(),
          status: "running",
          events: 0,
          bytes: 0,
          truncated: false,
          omitted: 0,
          finalState: null,
        });
        const capacity = await prune(1);
        if (
          capacity.runs >= limits.maxRuns ||
          capacity.bytes + 8192 > limits.maxTotalBytes
        )
          throw Error("Trace capacity unavailable");
        await writeFile(path(meta.runId, "events.jsonl"), "", {
          flag: "wx",
          mode: 0o600,
        });
        await atomic(meta);
        await prune();
        let queue = Promise.resolve();
        const emit = (event: TraceInput) => {
          queue = queue
            .catch(() => {})
            .then(() =>
              withProcessLock(`${root}.lock`, async () => {
                const e = project(meta, event, meta.events + 1);
                const line = `${JSON.stringify(e)}\n`;
                const capacity = await prune();
                if (
                  capacity.bytes + Buffer.byteLength(line) >
                    limits.maxTotalBytes ||
                  meta.events >= limits.maxEvents ||
                  meta.bytes + Buffer.byteLength(line) > limits.maxRunBytes ||
                  Buffer.byteLength(line) > 4096
                ) {
                  meta.truncated = true;
                  meta.omitted++;
                  await atomic(meta);
                  return;
                }
                const h = await open(
                  path(meta.runId, "events.jsonl"),
                  constants.O_APPEND |
                    constants.O_WRONLY |
                    constants.O_NOFOLLOW,
                );
                try {
                  await h.writeFile(line);
                  await h.sync();
                } finally {
                  await h.close();
                }
                meta.events++;
                meta.bytes += Buffer.byteLength(line);
                await atomic(meta);
              }),
            );
          return queue;
        };
        return {
          emit,
          session(id: string) {
            if (validSessionId(meta.harness, id)) meta.sessionId = id;
          },
          async finish(status: "finished" | "paused", finalState: unknown) {
            await emit({
              kind: status === "paused" ? "error" : "finished",
              status,
            });
            await queue;
            await withProcessLock(`${root}.lock`, async () => {
              meta.status = status;
              meta.finalState =
                typeof finalState === "string" && states.includes(finalState)
                  ? finalState
                  : null;
              await atomic(meta);
              await prune();
            });
          },
        };
      });
    },
  };
}
