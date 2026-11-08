import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const harnesses = ["codex", "pi", "claude", "opencode"] as const;
export type Harness = (typeof harnesses)[number];
export const validHarness = (value: unknown): value is Harness =>
  typeof value === "string" && (harnesses as readonly string[]).includes(value);

export const claudePermissionModes = [
  "acceptEdits",
  "auto",
  "dontAsk",
  "plan",
] as const;
export type ClaudePermissionMode = (typeof claudePermissionModes)[number];

const uuidSessionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openCodeSessionId = /^ses_[A-Za-z0-9]{1,64}$/;
export const validSessionId = (
  harness: Harness,
  value: unknown,
): value is string =>
  typeof value === "string" &&
  (harness === "opencode" ? openCodeSessionId : uuidSessionId).test(value);

const codexModelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const claudeModelId = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,119}$/;
const openCodeModelId =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)+[A-Za-z0-9][A-Za-z0-9._:-]{0,95}(?:#[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const safeModel = (value: unknown) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_./:#[\]-]{1,120}$/.test(value) &&
  !/(sk-|token|secret|password|https?:)/i.test(value)
    ? value
    : undefined;

export interface LaneHarness {
  harness?: Harness;
  // Native model identifier for Codex, Claude Code or OpenCode. Pi IDs/providers must not be reinterpreted.
  model?: string;
  claudePermissionMode?: ClaudePermissionMode;
  opencodeAuto?: boolean;
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
const foreignSettings = (harness: string) =>
  `Harness-specific settings cannot apply to ${harness}`;
export function validateHarness(config: HarnessConfig, lane: LaneHarness) {
  const harness = harnessName(lane);
  if (!validHarness(harness)) throw new Error("Unsupported harness");
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
    if (
      lane.claudePermissionMode !== undefined ||
      lane.opencodeAuto !== undefined
    )
      throw new Error(foreignSettings("Pi"));
  } else if (harness === "claude") {
    if (lane.piModel || lane.piPermissions)
      throw new Error(foreignSettings("Claude"));
    if (lane.opencodeAuto !== undefined)
      throw new Error(foreignSettings("Claude"));
    if (typeof lane.model !== "string" || !claudeModelId.test(lane.model))
      throw new Error(
        "Claude requires an explicit model (alias or full model identifier)",
      );
    if (
      !lane.claudePermissionMode ||
      !(claudePermissionModes as readonly string[]).includes(
        lane.claudePermissionMode,
      )
    )
      throw new Error(
        `Claude requires an explicit non-bypass permission mode: ${claudePermissionModes.join(", ")}`,
      );
  } else if (harness === "opencode") {
    if (lane.piModel || lane.piPermissions)
      throw new Error(foreignSettings("OpenCode"));
    if (lane.claudePermissionMode !== undefined)
      throw new Error(foreignSettings("OpenCode"));
    if (typeof lane.model !== "string" || !openCodeModelId.test(lane.model))
      throw new Error(
        "OpenCode requires an explicit provider/model identifier",
      );
    if (
      lane.opencodeAuto !== undefined &&
      typeof lane.opencodeAuto !== "boolean"
    )
      throw new Error("OpenCode auto-approval must be boolean");
  } else if (
    lane.piModel ||
    lane.piPermissions ||
    lane.claudePermissionMode !== undefined ||
    lane.opencodeAuto !== undefined
  )
    throw new Error(foreignSettings("Codex"));
  else if (lane.model !== undefined && !codexModelId.test(lane.model))
    throw new Error("Invalid Codex model identifier");
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
  if (record.sessionId && !validSessionId(harness, record.sessionId))
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
  if (harness === "pi") {
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
      args.push(
        "--provider",
        lane.piModel.provider,
        "--model",
        lane.piModel.id,
      );
    if (record.sessionId) args.push("--session", record.sessionId);
    return { binary, args, harness };
  }
  if (harness === "claude") {
    if (lane.model === undefined || lane.claudePermissionMode === undefined)
      throw new Error(
        "Claude invocation requires an explicit model and permissions",
      );
    let resultSchema: unknown;
    try {
      resultSchema = JSON.parse(readFileSync(schema, "utf8"));
    } catch {
      throw new Error("Claude requires a readable JSON result schema");
    }
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(resultSchema),
      "--add-dir",
      config.root,
      "--model",
      lane.model,
      "--permission-mode",
      lane.claudePermissionMode,
    ];
    if (record.sessionId) args.push("--resume", record.sessionId);
    // Fresh runs bind a UUID we own; Claude rejects reusing an existing id.
    else {
      const expectedSessionId = randomUUID();
      args.push("--session-id", expectedSessionId);
      return { binary, args, harness, expectedSessionId };
    }
    return { binary, args, harness };
  }
  if (lane.model === undefined)
    throw new Error("OpenCode invocation requires an explicit provider/model");
  const args = ["run", "--standalone", "--format", "json", "-m", lane.model];
  if (lane.opencodeAuto === true) args.push("--auto");
  if (record.sessionId) args.push("--session", record.sessionId);
  return { binary, args, harness };
}

export interface HarnessStream {
  sessionId?: string;
  expectedSessionId?: string;
  expectedCwd?: string;
  cwdVerified?: boolean;
  observedModel?: string;
  inputTokensKnown?: boolean;
  outputTokensKnown?: boolean;
  inputTokens: number;
  outputTokens: number;
  pendingText?: string;
  final?: FinalResult;
  settled: boolean;
  invalid: boolean;
}
const tokens = (n: unknown) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
const sameCwd = (actual: unknown, expected: string) => {
  if (typeof actual !== "string") return false;
  try {
    return realpathSync(actual) === realpathSync(expected);
  } catch {
    /* unknown checkout is not authority */
    return false;
  }
};
export function consumeEvent(
  harness: Harness,
  stream: HarnessStream,
  event: Record<string, unknown>,
) {
  if (harness === "claude") {
    if (event.type === "system" && event.subtype === "init") {
      if (stream.expectedCwd && !sameCwd(event.cwd, stream.expectedCwd)) {
        stream.invalid = true;
        return;
      }
      if (stream.expectedCwd) stream.cwdVerified = true;
      if (
        !validSessionId("claude", event.session_id) ||
        (stream.sessionId && stream.sessionId !== event.session_id) ||
        (stream.expectedSessionId &&
          stream.expectedSessionId !== event.session_id)
      ) {
        stream.invalid = true;
        return;
      }
      stream.sessionId = event.session_id;
      const observed = safeModel(event.model);
      if (observed) stream.observedModel = observed;
      return;
    }
    if (event.type === "assistant") {
      // Work after a result means the run is no longer settled.
      if (stream.settled) {
        stream.settled = false;
        delete stream.final;
      }
      const message = event.message as { model?: unknown } | undefined;
      const observed =
        event.parent_tool_use_id === undefined ||
        event.parent_tool_use_id === null
          ? safeModel(message?.model)
          : undefined;
      if (observed) stream.observedModel = observed;
      return;
    }
    if (event.type !== "result") return;
    if (
      !validSessionId("claude", event.session_id) ||
      (stream.sessionId && stream.sessionId !== event.session_id) ||
      (stream.expectedSessionId &&
        stream.expectedSessionId !== event.session_id)
    ) {
      stream.invalid = true;
      return;
    }
    // A result without the verified init event cannot prove its checkout.
    if (stream.expectedCwd && !stream.cwdVerified) {
      stream.invalid = true;
      return;
    }
    stream.sessionId = event.session_id;
    const usage = event.usage as Record<string, unknown> | undefined;
    stream.inputTokensKnown ||=
      Number.isSafeInteger(usage?.input_tokens) &&
      (usage?.input_tokens as number) >= 0;
    stream.outputTokensKnown ||=
      Number.isSafeInteger(usage?.output_tokens) &&
      (usage?.output_tokens as number) >= 0;
    // Claude reports cumulative usage; a partial/duplicate result must not decrease it.
    stream.inputTokens = Math.max(
      stream.inputTokens,
      tokens(usage?.input_tokens),
    );
    stream.outputTokens = Math.max(
      stream.outputTokens,
      tokens(usage?.output_tokens),
    );
    delete stream.final;
    stream.settled = false;
    if (event.is_error !== false || event.subtype !== "success") {
      stream.invalid = true;
      return;
    }
    stream.settled = true;
    if (validFinal(event.structured_output))
      stream.final = event.structured_output;
    return;
  }
  if (harness === "opencode") {
    if (
      !validSessionId("opencode", event.sessionID) ||
      (stream.sessionId && stream.sessionId !== event.sessionID)
    ) {
      stream.invalid = true;
      return;
    }
    stream.sessionId = event.sessionID;
    if (event.type === "error") {
      stream.invalid = true;
      stream.settled = false;
      delete stream.final;
      return;
    }
    if (event.type === "step_start") {
      stream.pendingText = "";
      stream.settled = false;
      delete stream.final;
      return;
    }
    const part = event.part as
      | {
          text?: unknown;
          reason?: unknown;
          tokens?: { input?: unknown; output?: unknown };
        }
      | undefined;
    if (event.type === "tool_use") {
      if (stream.settled) {
        stream.settled = false;
        delete stream.final;
      }
      return;
    }
    if (event.type === "text" && typeof part?.text === "string") {
      if (stream.settled) {
        stream.settled = false;
        delete stream.final;
      }
      stream.pendingText = (stream.pendingText ?? "") + part.text;
      return;
    }
    if (event.type !== "step_finish") return;
    stream.inputTokensKnown ||=
      Number.isSafeInteger(part?.tokens?.input) &&
      (part?.tokens?.input as number) >= 0;
    stream.outputTokensKnown ||=
      Number.isSafeInteger(part?.tokens?.output) &&
      (part?.tokens?.output as number) >= 0;
    stream.inputTokens += tokens(part?.tokens?.input);
    stream.outputTokens += tokens(part?.tokens?.output);
    delete stream.final;
    stream.settled = part?.reason === "stop";
    if (stream.settled) {
      try {
        const value: unknown = JSON.parse((stream.pendingText ?? "").trim());
        if (validFinal(value)) stream.final = value;
      } catch {
        /* invalid JSON must not become a successful result */
      }
    }
    stream.pendingText = "";
    return;
  }
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
    !sameCwd(event.cwd, stream.expectedCwd)
  ) {
    stream.invalid = true;
    return;
  }
  if (typeof sessionId === "string") {
    if (
      !validSessionId(harness, sessionId) ||
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
      const observed = safeModel(
        `${message.provider ?? "unknown"}/${message.model}`,
      );
      if (observed) stream.observedModel = observed;
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

export const jsonResultInstruction =
  "\nReturn ONLY a JSON object with state (working/waiting/ready/needs_operator) and summary (max 2000 characters); no markdown or extra keys.";

export interface FinalOutcome {
  final?: unknown;
  persist: boolean;
}
export async function finalResult(
  harness: Harness,
  stream: HarnessStream,
  output: string,
): Promise<FinalOutcome> {
  if (harness === "codex") {
    try {
      return {
        final: JSON.parse(await readFile(output, "utf8")),
        persist: false,
      };
    } catch {
      return { final: undefined, persist: false };
    }
  }
  return {
    final: stream.settled && !stream.invalid ? stream.final : undefined,
    persist: true,
  };
}

export interface HarnessCapabilities {
  resume: boolean;
  structuredResult: "native" | "prompted";
  nativeTools: "harness-controlled" | "disabled";
  observedModel: boolean;
  observedCwd: boolean;
  usage: "partial";
  screenshots: "external";
}
export const harnessCapabilities: Record<Harness, HarnessCapabilities> = {
  codex: {
    resume: true,
    structuredResult: "native",
    nativeTools: "harness-controlled",
    observedModel: false,
    observedCwd: false,
    usage: "partial",
    screenshots: "external",
  },
  pi: {
    resume: true,
    structuredResult: "prompted",
    nativeTools: "disabled",
    observedModel: true,
    observedCwd: true,
    usage: "partial",
    screenshots: "external",
  },
  claude: {
    resume: true,
    structuredResult: "native",
    nativeTools: "harness-controlled",
    observedModel: true,
    observedCwd: true,
    usage: "partial",
    screenshots: "external",
  },
  opencode: {
    resume: true,
    structuredResult: "prompted",
    nativeTools: "harness-controlled",
    observedModel: false,
    observedCwd: false,
    usage: "partial",
    screenshots: "external",
  },
};
