import { expect, it } from "vitest";
import { makeStyle } from "./style.ts";
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
  safety: async () => null,
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
  const { io, text, left } = scripted([
    "custom",
    "pi", // coordinator: rejected, pi is not offered
    "claude",
    "pi", // implementers: rejected
    "claude",
    "pi", // reviewers: accepted
    "", // claude binary (detected)
    "/fake/pi", // pi has no detected default
    "opus", // claude model
    "", // pi model (harness default)
    "", // implementer permission mode default
    "",
    "",
    "", // claudeMcp, sources, cost
    "",
    "", // implementers, tasks
    "",
    "",
    "",
    "", // limits
    "no", // stopped
    "yes", // review
    "", // out
  ]);
  const result = await runWizard(io, context());
  expect(left()).toBe(0);
  expect(result.template).toBe("custom");
  expect(result.answers.roles).toEqual({
    coordinator: "claude",
    implementer: "claude",
    reviewer: "pi",
  });
  expect(result.answers.sessionEpoch).toBe("setup-epoch1");
  const shown = text.join("");
  // The two menus for coordinator and implementers offer exactly three
  // harnesses and reject a typed pi; only the reviewer menu lists it.
  expect(
    shown.match(
      /invalid: choose one of: codex, claude, opencode \(try again\)/g,
    ),
  ).toHaveLength(2);
  const [coordinatorMenu, rest = ""] = shown.split("Harness for implementers:");
  const [implementerMenu, reviewerMenu = ""] = rest.split(
    "Harness for reviewers:",
  );
  expect(coordinatorMenu).not.toMatch(/\d\) pi/);
  expect(implementerMenu).not.toMatch(/\d\) pi/);
  expect(reviewerMenu).toMatch(/4\) pi/);
});

it("re-prompts a bad Pi model instead of failing at the end", async () => {
  const { io, text, left } = scripted([
    "custom",
    "claude",
    "claude",
    "pi",
    "",
    "/fake/pi",
    "opus",
    "prov/bad model", // engine rejects: space
    "prov/ok-model",
    "", // permission mode
    "",
    "",
    "", // claudeMcp, sources, cost
    "",
    "", // implementers, tasks
    "",
    "",
    "",
    "", // limits
    "no",
    "yes",
    "",
  ]);
  const result = await runWizard(io, context());
  expect(left()).toBe(0);
  expect(text.join("")).toContain(
    "invalid: Invalid explicit Pi provider/model",
  );
  expect(result.answers.piModel).toEqual({ provider: "prov", id: "ok-model" });
});

it("shows a detected binary default through printablePath and still refuses it", async () => {
  const ctx = { ...context(), detection: { ...context().detection } };
  ctx.detection.codex = "/fake/co\ndex\u001b[31m";
  const { io, prompts } = scripted([
    "codex",
    "", // blank accepts the (control-character) default: refused
    "/fake/codex",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "no",
    "yes",
    "",
  ]);
  const result = await runWizard(io, ctx);
  const binaryPrompts = prompts.filter((p) => p.includes("executable"));
  expect(binaryPrompts).toHaveLength(2);
  for (const prompt of binaryPrompts) {
    expect(prompt).not.toMatch(/\p{Cc}/u);
    expect(prompt).toContain("[/fake/co?dex?[31m]");
  }
  expect(result.answers.binaries.codex).toBe("/fake/codex");
});

it("refuses to record a stop confirmation the control state contradicts", async () => {
  const answers = [
    "codex",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "yes", // stopped
  ];
  const { io } = scripted(answers);
  await expect(
    runWizard(io, {
      ...context(),
      verifyStopped: async () =>
        "the control state says a supervisor is running",
    }),
  ).rejects.toThrow(
    /Refusing to record the stop confirmation: the control state/,
  );
  // A "no" never consults the control state.
  let asked = 0;
  const declined = scripted([...answers.slice(0, 9), "no", "yes", ""]);
  const result = await runWizard(declined.io, {
    ...context(),
    verifyStopped: async () => {
      asked++;
      return "running";
    },
  });
  expect(asked).toBe(0);
  expect("confirmedStoppedAt" in result.answers).toBe(false);
});

it("emits a fresh epoch for a lane whose harness changed since the installed config", async () => {
  const { io, text } = scripted([
    "codex",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "no",
    "yes",
    "",
  ]);
  const result = await runWizard(io, {
    ...context(),
    prior: {
      config: { captain: { harness: "claude" } },
      records: { builder: { harness: "opencode", busy: false } },
    },
  });
  expect(result.answers.laneEpochs).toEqual({
    captain: "setup-epoch1",
    builder: "setup-epoch1",
  });
  expect(text.join("")).toContain("! lane captain switches harness");
  expect(text.join("")).toContain("! lane builder switches harness");
});

const walk = ["codex", "", "", "", "", "", "", "", "", "no", "yes", ""];

it("numbers steps with a total that drops the Claude safety step when unused", async () => {
  const plain = scripted(walk);
  await runWizard(plain.io, context());
  const shown = plain.text.join("");
  expect(shown).toContain("[1/5] Executables");
  expect(shown).toContain("[5/5] Confirm");
  expect(shown).not.toContain("Claude Code safety");
  const claude = scripted([
    "claude",
    "",
    "opus",
    ...Array(10).fill(""),
    "no",
    "yes",
    "",
  ]);
  await runWizard(claude.io, context());
  const withClaude = claude.text.join("");
  expect(withClaude).toContain("[3/6] Claude Code safety");
  expect(withClaude).toContain("[6/6] Confirm");
});

it("defaults maxParallel to at most 2 and explains the lane ceiling", async () => {
  const { io, prompts, text } = scripted(walk);
  await runWizard(io, context());
  expect(prompts.find((p) => p.startsWith("maxParallel"))).toBe(
    "maxParallel (1-4) [2]: ",
  );
  expect(text.join("")).toContain("more than 3 (your enabled lanes)");
});

it("explains the allowlist and shows an example when no task cards exist", async () => {
  const { io, text } = scripted([
    "codex",
    "",
    "",
    "",
    "t1,t2",
    "",
    "",
    "",
    "",
    "no",
    "yes",
    "",
  ]);
  const result = await runWizard(io, {
    ...context(),
    discoveredTasks: [],
    discoveredImplementers: [],
  });
  const shown = text.join("");
  expect(shown).toContain("No task cards were found in tasks/");
  expect(shown).toContain("Owner: implementer.");
  expect(shown).toContain("Example: t1,t2");
  expect(result.answers.allowedTasks).toEqual(["t1", "t2"]);
});

it("renders invalid answers with the error style and uses color only when asked", async () => {
  const colored = scripted([
    "nope",
    "codex",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "no",
    "yes",
    "",
  ]);
  await runWizard(colored.io, { ...context(), style: makeStyle(true) });
  expect(colored.text.join("")).toContain("\u001b[31minvalid:\u001b[39m");
  const plain = scripted([
    "nope",
    "codex",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "no",
    "yes",
    "",
  ]);
  await runWizard(plain.io, context());
  expect(plain.text.join("")).not.toContain("\u001b");
});
