import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export type Harness = "codex" | "pi";
export interface LaneHarness {
  harness?: Harness;
  // Legacy model is Codex-only. Pi IDs/providers must not be reinterpreted.
  model?: string;
  piModel?: { provider: string; id: string };
  piPermissions?: "no-tools";
  sessionEpoch?: string;
}
export interface HarnessConfig {
  root: string;
  binary: string;
  binaries?: Partial<Record<Harness, string>>;
  piSessionDirectory?: string;
}
export interface NativeSession {
  harness?: Harness;
  sessionId?: string;
  sessionEpoch?: string;
}
export interface FinalResult {
  state: "working" | "waiting" | "ready" | "needs_operator";
  summary: string;
}
export function validFinal(value: unknown): value is FinalResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((k) => ["state", "summary"].includes(k)) &&
    typeof v.state === "string" &&
    ["working", "waiting", "ready", "needs_operator"].includes(v.state) &&
    typeof v.summary === "string" &&
    v.summary.length <= 2000
  );
}
export const harnessName = (lane?: LaneHarness): Harness =>
  lane?.harness ?? "codex";
export function validateHarness(config: HarnessConfig, lane: LaneHarness) {
  const harness = harnessName(lane);
  if (!["codex", "pi"].includes(harness))
    throw new Error("Unsupported harness");
  const binary =
    config.binaries?.[harness] ??
    (harness === "codex" ? config.binary : undefined);
  if (!binary || !isAbsolute(binary) || !existsSync(binary))
    throw new Error(`Missing absolute ${harness} binary`);
  if (
    lane.sessionEpoch !== undefined &&
    !/^[A-Za-z0-9_-]{1,64}$/.test(lane.sessionEpoch)
  )
    throw new Error("Invalid explicit session epoch");
  if (harness === "pi") {
    if (lane.model || lane.piPermissions !== "no-tools")
      throw new Error(
        "Pi requires explicit no-tools policy and no Codex model field; native tool sandbox is unsupported",
      );
    if (!lane.sessionEpoch)
      throw new Error("Pi requires a fresh explicit session epoch");
    if (
      lane.piModel &&
      (!lane.piModel.provider ||
        !lane.piModel.id ||
        [lane.piModel.provider, lane.piModel.id].some((v) => /[\r\n]/.test(v)))
    )
      throw new Error("Invalid explicit Pi provider/model");
  } else if (lane.piModel || lane.piPermissions)
    throw new Error("Pi settings cannot apply to Codex");
  return binary;
}
export function harnessKey(lane: LaneHarness | undefined) {
  return lane?.sessionEpoch
    ? `:harness:${harnessName(lane)}:epoch:${lane.sessionEpoch}`
    : "";
}
export function assertSwitch(
  lane: LaneHarness,
  previous: NativeSession & { status: string; pid?: number },
  supervisorWasRunning: boolean,
) {
  if (
    harnessName(lane) === (previous.harness ?? "codex") &&
    lane.sessionEpoch === previous.sessionEpoch
  )
    return;
  if (
    supervisorWasRunning ||
    previous.status !== "idle" ||
    previous.pid ||
    !lane.sessionEpoch ||
    lane.sessionEpoch === previous.sessionEpoch
  )
    throw new Error(
      "Harness/session switch requires a drained idle lane and a fresh explicit sessionEpoch; retain prior records",
    );
}
export function harnessCommand(
  config: HarnessConfig,
  lane: LaneHarness,
  record: NativeSession,
  schema: string,
  output: string,
) {
  const harness = harnessName(lane);
  const binary = validateHarness(config, lane);
  if (
    record.sessionId &&
    ((record.harness ?? "codex") !== harness ||
      record.sessionEpoch !== lane.sessionEpoch)
  )
    throw new Error("Cross-harness or cross-epoch resume rejected");
  if (record.sessionId && !/^[a-f0-9-]{36}$/i.test(record.sessionId))
    throw new Error("Invalid stored explicit session ID");
  if (harness === "codex") {
    const args = [
      "exec",
      "--approve-for-me",
      "--add-dir",
      config.root,
      "--json",
      "--output-schema",
      schema,
      "--output-last-message",
      output,
    ];
    if (lane.model) args.push("--model", lane.model);
    if (record.sessionId) args.push("resume", record.sessionId);
    args.push("-");
    return { binary, args, harness };
  }
  if (!config.piSessionDirectory || !isAbsolute(config.piSessionDirectory))
    throw new Error("Pi requires an explicit absolute session directory");
  const args = [
    "--mode",
    "json",
    "--print",
    "--offline",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "--no-context-files",
    "--no-approve",
    "--session-dir",
    config.piSessionDirectory,
  ];
  if (lane.piModel)
    args.push("--provider", lane.piModel.provider, "--model", lane.piModel.id);
  if (record.sessionId) args.push("--session", record.sessionId);
  return { binary, args, harness };
}

export interface HarnessStream {
  sessionId?: string;
  expectedCwd?: string;
  observedModel?: string;
  inputTokensKnown?: boolean;
  outputTokensKnown?: boolean;
  inputTokens: number;
  outputTokens: number;
  final?: FinalResult;
  settled: boolean;
  invalid: boolean;
}
const tokens = (n: unknown) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
export function consumeEvent(
  harness: Harness,
  stream: HarnessStream,
  event: Record<string, unknown>,
) {
  const sessionId =
    harness === "codex" && event.type === "thread.started"
      ? event.thread_id
      : harness === "pi" && event.type === "session"
        ? event.id
        : undefined;
  if (
    harness === "pi" &&
    event.type === "session" &&
    stream.expectedCwd &&
    event.cwd !== stream.expectedCwd
  ) {
    let matches = false;
    try {
      matches =
        typeof event.cwd === "string" &&
        realpathSync(event.cwd) === realpathSync(stream.expectedCwd);
    } catch {
      /* unknown checkout is not authority */
    }
    if (!matches) {
      stream.invalid = true;
      return;
    }
  }
  if (typeof sessionId === "string") {
    if (
      !/^[a-f0-9-]{36}$/i.test(sessionId) ||
      (stream.sessionId && stream.sessionId !== sessionId)
    ) {
      stream.invalid = true;
      return;
    }
    stream.sessionId = sessionId;
  }
  if (harness === "codex" && event.type === "turn.completed") {
    const usage = event.usage as Record<string, unknown> | undefined;
    stream.inputTokensKnown ||=
      Number.isSafeInteger(usage?.input_tokens) &&
      (usage?.input_tokens as number) >= 0;
    stream.outputTokensKnown ||=
      Number.isSafeInteger(usage?.output_tokens) &&
      (usage?.output_tokens as number) >= 0;
    stream.inputTokens += tokens(usage?.input_tokens);
    stream.outputTokens += tokens(usage?.output_tokens);
  }
  if (harness === "pi" && event.type === "message_end") {
    const message = event.message as
      | {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
          usage?: { input?: number; output?: number };
          model?: string;
          provider?: string;
          stopReason?: string;
        }
      | undefined;
    if (message?.role !== "assistant") return;
    stream.inputTokensKnown ||=
      Number.isSafeInteger(message.usage?.input) &&
      (message.usage?.input as number) >= 0;
    stream.outputTokensKnown ||=
      Number.isSafeInteger(message.usage?.output) &&
      (message.usage?.output as number) >= 0;
    stream.inputTokens += tokens(message.usage?.input);
    stream.outputTokens += tokens(message.usage?.output);
    if (message.model) {
      const observed = `${message.provider ?? "unknown"}/${message.model}`;
      if (
        /^[A-Za-z0-9_./:-]{1,100}$/.test(observed) &&
        !/(sk-|token|secret|password|https?:)/i.test(observed)
      )
        stream.observedModel = observed;
    }
    delete stream.final;
    try {
      const value: unknown = JSON.parse(
        message.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("") ?? "",
      );
      if (message.stopReason === "stop" && validFinal(value))
        stream.final = value;
    } catch {
      /* invalid JSON must not become a successful result */
    }
  }
  if (harness === "pi" && event.type === "agent_settled")
    stream.settled = event.aborted === false;
}

export const harnessCapabilities = {
  codex: {
    resume: true,
    structuredResult: true,
    nativeTools: "harness-controlled",
    usage: "partial",
    screenshots: "external",
  },
  pi: {
    resume: true,
    structuredResult: true,
    nativeTools: "disabled",
    usage: "partial",
    screenshots: "external",
  },
} as const;
