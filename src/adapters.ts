import {
  consumeEvent,
  type Harness,
  harnessCapabilities,
  harnessCommand,
  validFinal,
} from "./engine/harness.ts";
import type { HarnessAdapter } from "./ports.ts";

const adapter = (id: Harness): HarnessAdapter => ({
  id,
  capabilities: harnessCapabilities[id],
  invoke: (config, lane, session, schema, output) =>
    harnessCommand(config, { ...lane, harness: id }, session, schema, output),
  consume: (stream, event) => consumeEvent(id, stream, event),
  validateResult: validFinal,
});
export const adapters = { codex: adapter("codex"), pi: adapter("pi") };
