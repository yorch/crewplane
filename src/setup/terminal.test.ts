import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { terminalIO } from "./command.ts";

/** Injected streams stand in for a terminal; prompts and echo go to `output` only. */
const streams = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk) => written.push(String(chunk)));
  return { input, output, text: () => written.join("") };
};

it("reads answers line by line and writes prompts and text to the output stream", async () => {
  const { input, output, text } = streams();
  const io = terminalIO(input, output);
  const first = io.ask("Name? ");
  input.write("alpha\n");
  expect(await first).toBe("alpha");
  const second = io.ask("Again? ");
  input.write("  beta  \n");
  expect(await second).toBe("  beta  ");
  io.write("hello\n");
  expect(text()).toContain("Name? ");
  expect(text()).toContain("Again? ");
  expect(text()).toContain("hello\n");
  io.close?.();
});

it("end of input and Ctrl+C both answer null, including a pending question", async () => {
  const eof = streams();
  const ended = terminalIO(eof.input, eof.output);
  const pending = ended.ask("Q? ");
  eof.input.end();
  expect(await pending).toBeNull();
  // Asking again after the stream closed never hangs.
  expect(await ended.ask("Q2? ")).toBeNull();

  const sig = streams();
  const interrupted = terminalIO(sig.input, sig.output);
  const waiting = interrupted.ask("Q? ");
  sig.input.write("\u0003");
  expect(await waiting).toBeNull();
  expect(await interrupted.ask("Q2? ")).toBeNull();
});

it("close is idempotent and unblocks a pending question", async () => {
  const { input, output } = streams();
  const io = terminalIO(input, output);
  const pending = io.ask("Q? ");
  io.close?.();
  io.close?.();
  expect(await pending).toBeNull();
});
