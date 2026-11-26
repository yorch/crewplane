import { expect, it } from "vitest";
import { buildConfig, type SetupPolicy } from "./templates.ts";
import { runWizard, SetupAborted, type WizardIO } from "./wizard.ts";

const policy: SetupPolicy = {
  coordinator: "captain",
  reviewers: ["inspector"],
  reviewerRoles: { inspector: "code" },
};
const scripted = (answers: Array<string | null>) => {
  const prompts: string[] = [];
  const text: string[] = [];
  const queue = [...answers];
  const io: WizardIO = {
    ask: async (prompt) => {
      prompts.push(prompt);
      return queue.length ? (queue.shift() as string | null) : null;
    },
    write: (value) => void text.push(value),
  };
  return { io, prompts, text, left: () => queue.length };
};
const context = () => ({
  policy,
  detection: {
    codex: "/fake/codex",
    claude: "/fake/claude",
    opencode: "/fake/opencode",
    pi: null,
  },
  discoveredTasks: ["CP-101", "CP-102"],
  discoveredImplementers: ["builder"],
  check: async (path: string) => path.startsWith("/fake/"),
  now: () => new Date("2026-11-08T12:00:00.000Z"),
  epoch: () => "setup-epoch1",
  review: (a: Parameters<typeof buildConfig>[0]) =>
    JSON.stringify(buildConfig(a, policy).config),
});

it("walks the mixed template with defaults, one invalid model and a stop confirmation", async () => {
  const { io, text, left } = scripted([
    "mixed", // template
    "", // reviewer harness -> opencode
    "", // claude binary (detected)
    "", // opencode binary (detected)
    "opus", // claude model
    "haiku", // invalid opencode model
    "prov/model#fast", // retried
    "plan", // implementer permission mode by name
    "", // claudeMcp default
    "project,local", // setting sources
    "3.5", // cost
    "", // implementers default (discovered)
    "", // tasks default (discovered)
    "3",
    "",
    "",
    "",
    "yes", // stopped
    "yes", // review ok
    "no", // install
    "", // out
  ]);
  const result = await runWizard(io, context());
  expect(left()).toBe(0);
  expect(text.join("")).toContain(
    "invalid: OpenCode model must be provider/model",
  );
  expect(result.template).toBe("mixed");
  expect(result.install).toBe(false);
  expect(result.out).toBeUndefined();
  expect(result.answers).toMatchObject({
    roles: {
      coordinator: "claude",
      implementer: "claude",
      reviewer: "opencode",
    },
    binaries: { claude: "/fake/claude", opencode: "/fake/opencode" },
    models: { claude: "opus", opencode: "prov/model#fast" },
    allowedTasks: ["CP-101", "CP-102"],
    implementers: ["builder"],
    confirmedStoppedAt: "2026-11-08T12:00:00.000Z",
    limits: {
      maxParallel: 3,
      intervalSeconds: 10,
      maxRunMinutes: 25,
      maxRunsPerHour: 20,
    },
    claude: {
      implementerMode: "plan",
      mcp: "strict",
      settingSources: ["project", "local"],
      maxCostUsdPerRun: 3.5,
    },
  });
});

it("never records the stop time on anything but an explicit yes", async () => {
  const { io } = scripted([
    "codex",
    "", // codex binary
    "", // model blank
    "", // implementers
    "", // tasks
    "",
    "",
    "",
    "",
    "", // stopped -> default no
    "yes",
    "", // out
  ]);
  const result = await runWizard(io, context());
  expect("confirmedStoppedAt" in result.answers).toBe(false);
  expect(result.install).toBe(false);
});

it("offers no bypass permission mode", async () => {
  const { io, text } = scripted([
    "claude",
    "",
    "opus",
    "bypassPermissions",
    "bypassPermissions",
    "bypassPermissions",
    null,
  ]);
  await expect(runWizard(io, context())).rejects.toThrow(
    /Too many invalid answers/,
  );
  const shown = text.join("");
  expect(shown).toContain("acceptEdits");
  expect(shown).not.toMatch(/\d\) bypass/);
  expect(shown).toContain("bypass and manual permission modes are not offered");
  expect(shown).toContain("choose one of: acceptEdits, auto, dontAsk, plan");
});

it("gives up after a bounded number of invalid answers", async () => {
  const { io, prompts } = scripted(["nope", "nope", "nope", "nope"]);
  await expect(runWizard(io, context())).rejects.toThrow(
    /Too many invalid answers/,
  );
  expect(prompts.length).toBe(3);
});

it("aborts cleanly on end of input at any prompt", async () => {
  for (let n = 0; n < 6; n++) {
    const answers = ["mixed", "", "", "", "opus", "p/m"].slice(0, n);
    const { io } = scripted(answers);
    await expect(runWizard(io, context())).rejects.toBeInstanceOf(SetupAborted);
  }
});

it("rejects implementer IDs that clash with policy lanes and re-prompts", async () => {
  const { io, text } = scripted([
    "codex",
    "",
    "",
    "captain", // clash
    "builder",
    "CP-9",
    "",
    "",
    "",
    "",
    "yes",
    "yes",
    "yes",
    "",
  ]);
  const result = await runWizard(io, context());
  expect(text.join("")).toContain("captain is already the coordinator");
  expect(result.answers.implementers).toEqual(["builder"]);
  expect(result.install).toBe(true);
});

it("declining the final review aborts", async () => {
  const { io } = scripted([
    "codex",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "yes",
    "no",
  ]);
  await expect(runWizard(io, context())).rejects.toBeInstanceOf(SetupAborted);
});

it("custom lets only reviewers choose Pi", async () => {
  const { io, text } = scripted(["custom", "pi", "claude", "claude"]);
  // pi is not offered for the coordinator: the first menu lists three harnesses.
  await runWizard(io, context()).catch(() => undefined);
  const firstMenu = text.join("").split("Harness for implementers")[0] ?? "";
  expect(firstMenu).not.toMatch(/\d\) pi/);
});
