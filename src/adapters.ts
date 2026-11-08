import {
  consumeEvent,
  finalResult,
  type Harness,
  harnessCapabilities,
  harnessCommand,
  jsonResultInstruction,
  validFinal,
} from "./engine/harness.ts";
import type { HarnessAdapter } from "./ports.ts";

const adapter = (id: Harness): HarnessAdapter => {
  const capabilities = harnessCapabilities[id];
  return {
    id,
    capabilities,
    ...(capabilities.structuredResult === "prompted"
      ? { promptSuffix: jsonResultInstruction }
      : {}),
    sessionDirectory: id === "pi",
    ...(id === "claude" || id === "opencode" ? { strictStream: true } : {}),
    invoke: (config, lane, session, schema, output) =>
      harnessCommand(config, { ...lane, harness: id }, session, schema, output),
    consume: (stream, event) => consumeEvent(id, stream, event),
    finalize: (stream, output) => finalResult(id, stream, output),
    validateResult: validFinal,
  };
};
export const adapters: Record<Harness, HarnessAdapter> = {
  codex: adapter("codex"),
  pi: adapter("pi"),
  claude: adapter("claude"),
  opencode: adapter("opencode"),
};
