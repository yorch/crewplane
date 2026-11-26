import { expect, it } from "vitest";
import { control } from "./engine/control-policy.ts";
import { help } from "./help.ts";
import { setupOptions } from "./setup/command.ts";

/**
 * Every control form printed by --help, with the option set the CLI builds for
 * it. `--help` is the operator's only grammar reference, so a form that is
 * documented but refused is a safety defect, not a documentation nit.
 */
const documented: Array<{
  form?: string;
  input: Record<string, unknown>;
}> = [
  {
    form: "pause|resume --lane ID",
    input: { action: "pause", lane: "builder" },
  },
  {
    form: "pause|resume --lane ID",
    input: { action: "resume", lane: "builder" },
  },
  { form: "pause|resume --all true", input: { action: "pause", all: true } },
  { form: "pause|resume --all true", input: { action: "resume", all: true } },
  {
    form: "nudge --lane ID --text TEXT",
    input: { action: "nudge", lane: "builder", text: "update" },
  },
  { form: "retry --lane ID", input: { action: "retry", lane: "builder" } },
  {
    form: "retry --lane ID --confirm-cleanup true --text NOTE",
    input: {
      action: "retry",
      lane: "builder",
      confirmCleanup: true,
      text: "inspected",
    },
  },
  {
    form: "retry --lane ID --task ID --new-session true --text NOTE",
    input: {
      action: "retry",
      lane: "builder",
      task: "CP-101",
      newSession: true,
      text: "fresh session",
    },
  },
  {
    form: "resolve --lane ID [--task ID] --pause UUID (--approve true|--deny true) --text NOTE",
    input: {
      action: "resolve",
      lane: "builder",
      pauseId: "11111111-1111-1111-1111-111111111111",
      resolution: "approve",
      text: "approved",
    },
  },
  {
    form: "cancel --lane ID --run RUN",
    input: {
      action: "cancel",
      lane: "builder",
      run: "1700000000000-11111111-1111-1111-1111-111111111111",
    },
  },
  { form: "cancel --all true", input: { action: "cancel", all: true } },
  {
    form: "stop [--cancel-active true]",
    input: { action: "stop", cancelActive: true },
  },
  { input: { action: "stop" } },
  { form: "rollout", input: { action: "rollout" } },
];

const occurrences = (needle: string) => help.split(needle).length - 1;

it("accepts every control form printed by --help", () => {
  for (const { form, input } of documented) {
    if (form !== undefined)
      expect(help, `--help omits the documented form: ${form}`).toContain(form);
    expect(
      control(input),
      `refused: ${form ?? String(input.action)}`,
    ).toMatchObject({ action: input.action });
  }
});

it("documents each control verb once, with an explicit boolean value", () => {
  for (const needle of [
    "  pause|resume --lane",
    "  cancel --lane",
    "  resolve --lane",
  ])
    expect(occurrences(needle), needle).toBe(1);
  for (const bare of [
    "--all [",
    "--all --",
    "(--approve|--deny)",
    "--run RUN |",
    "--new-session --",
  ])
    expect(
      occurrences(bare),
      `--help shows a form the parser refuses: ${bare}`,
    ).toBe(0);
});

it("documents the dashboard controls opt-in and the agents help pointer", () => {
  expect(help).toContain("dashboard [--port PORT] [--controls true]");
  expect(help).toContain("crewplane agents help");
});

it("documents what doctor probes and its exit code", () => {
  expect(help).toMatch(/doctor\s+Diagnose config and harness binaries/);
  expect(help).toContain("exit 2 on problems");
});

it("documents the setup grammar and accepts every flag it prints", () => {
  expect(help).toMatch(/\n {2}setup {2,}Guided setup wizard/);
  expect(help).toContain(
    "setup --non-interactive true --template codex|claude|opencode|mixed",
  );
  const block = help.slice(
    help.indexOf("  setup --non-interactive"),
    help.indexOf("  agents COMMAND"),
  );
  const printed = new Set(block.match(/--[a-z-]+/g));
  // Every flag printed in the setup block is one the command parses, and vice versa.
  expect([...printed].sort()).toEqual([...setupOptions].sort());
  // Boolean flags are documented with an explicit true.
  for (const flag of [
    "--non-interactive true",
    "--confirm-stopped true",
    "--install true",
  ])
    expect(help, flag).toContain(flag);
  // Each documented form parses without error under the command's own grammar.
  const forms: string[][] = [
    ["--non-interactive", "true", "--template", "codex"],
    [
      "--non-interactive",
      "true",
      "--template",
      "mixed",
      "--binary",
      "/a",
      "--claude-binary",
      "/b",
      "--opencode-binary",
      "/c",
      "--pi-binary",
      "/d",
      "--model",
      "opus",
      "--tasks",
      "A-1,B-2",
      "--out",
      "/o.json",
      "--install",
      "true",
      "--confirm-stopped",
      "true",
    ],
  ];
  const allowed = new Set(setupOptions);
  for (const form of forms)
    for (let i = 0; i < form.length; i += 2)
      expect(allowed.has(form[i] as string), form[i]).toBe(true);
});
