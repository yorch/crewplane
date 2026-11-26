import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../contracts.ts";
import { defaultPolicy, type ProjectPolicy } from "../project.ts";
import { discoverTasks, runSetup, type SetupDeps } from "./command.ts";
import type { WizardIO } from "./wizard.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const policy: ProjectPolicy = {
  ...defaultPolicy,
  coordinator: "captain",
  reviewers: ["inspector", "visual"],
  reviewerRoles: { inspector: "code", visual: "visual" },
};
/** Same grammar as the CLI's `--key value` helper, kept local so tests need not import cli.ts. */
const options = (args: string[], allowed: string[]) => {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i] as string,
      value = args[i + 1];
    if (!allowed.includes(key) || value === undefined || key in result)
      throw new Error(`Invalid command options: ${key}`);
    result[key] = value;
  }
  return result;
};
function fixture(
  overrides: Partial<SetupDeps> = {},
  tools: string[] = ["codex", "claude", "opencode"],
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-setup-")));
  scratch.push(base);
  const root = join(base, "project");
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(join(root, "tasks/CP-101.md"), "# t\nOwner: builder.\n");
  writeFileSync(join(root, "tasks/CP-102.md"), "# t\nOwner lane: designer.\n");
  writeFileSync(join(root, "tasks/notes.txt"), "Owner: ignored.\n");
  const bin = join(base, "bin");
  mkdirSync(bin);
  const fake = (name: string, mode = 0o755) => {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nexit 9\n");
    chmodSync(path, mode);
    return path;
  };
  for (const tool of tools) fake(tool);
  const installed: Array<Record<string, unknown>> = [];
  const deps: SetupDeps = {
    requested: root,
    root,
    policy,
    env: { PATH: bin },
    tty: false,
    options,
    install: async (value) => {
      installed.push(value);
      return value as unknown as Config;
    },
    makeIO: () => {
      throw new Error("no terminal");
    },
    now: () => new Date("2026-11-08T12:00:00.000Z"),
    epoch: () => "setup-fixed",
    ...overrides,
  };
  return { base, root, bin, fake, deps, installed };
}
const ni = (...args: string[]) => ["--non-interactive", "true", ...args];

it("discovers task cards and their owners without trusting non-cards", async () => {
  const { root } = fixture();
  expect(await discoverTasks(root, "tasks", new Set(["captain"]))).toEqual({
    tasks: ["CP-101", "CP-102"],
    implementers: ["builder", "designer"],
  });
  expect(await discoverTasks(root, "absent", new Set())).toEqual({
    tasks: [],
    implementers: [],
  });
});

describe("non-interactive", () => {
  it("prints a config, writes nothing and installs nothing by default", async () => {
    const { root, deps, installed, bin } = fixture();
    const before = readdirSync(root).sort();
    const report = await runSetup(ni("--template", "codex"), deps);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(installed).toEqual([]);
    expect(report).toMatchObject({
      version: 1,
      mode: "non-interactive",
      template: "codex",
      confirmedStopped: false,
      written: null,
      installed: false,
      problems: [],
    });
    expect(report.config.binary).toBe(join(bin, "codex"));
    expect(Object.keys(report.config.lanes as object)).toEqual([
      "captain",
      "builder",
      "designer",
      "inspector",
      "visual",
    ]);
    expect(report.config.allowedTasks).toEqual(["CP-101", "CP-102"]);
    expect("confirmedStoppedAt" in report.config).toBe(false);
    expect(report.notes.join(" ")).toContain("confirmedStoppedAt is omitted");
  });

  it("records the stop time only with --confirm-stopped true", async () => {
    const { deps } = fixture();
    const report = await runSetup(
      ni("--template", "codex", "--confirm-stopped", "true"),
      deps,
    );
    expect(report.config.confirmedStoppedAt).toBe("2026-11-08T12:00:00.000Z");
    expect(report.confirmedStopped).toBe(true);
    await expect(
      runSetup(ni("--template", "codex", "--confirm-stopped", "yes"), deps),
    ).rejects.toThrow(/--confirm-stopped must be true/);
  });

  it("--out creates a 0600 file and refuses to overwrite", async () => {
    const { root, deps, installed } = fixture();
    const report = await runSetup(
      ni("--template", "codex", "--out", "runtime.json"),
      deps,
    );
    const path = join(root, "runtime.json");
    expect(report.written).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report.config);
    expect(installed).toEqual([]);
    const first = readFileSync(path, "utf8");
    await expect(
      runSetup(
        ni("--template", "claude", "--model", "opus", "--out", path),
        deps,
      ),
    ).rejects.toThrow(/Refusing to overwrite/);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("--install needs an explicit stop confirmation and then installs once", async () => {
    const { deps, installed } = fixture();
    await expect(
      runSetup(ni("--template", "codex", "--install", "true"), deps),
    ).rejects.toThrow(/--install requires --confirm-stopped true/);
    expect(installed).toEqual([]);
    const report = await runSetup(
      ni(
        "--template",
        "codex",
        "--install",
        "true",
        "--confirm-stopped",
        "true",
      ),
      deps,
    );
    expect(report.installed).toBe(true);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.confirmedStoppedAt).toBe("2026-11-08T12:00:00.000Z");
    expect(report.next).toEqual(["crewplane doctor"]);
  });

  it("--install and --out combine", async () => {
    const { root, deps, installed } = fixture();
    const report = await runSetup(
      ni(
        "--template",
        "codex",
        "--install",
        "true",
        "--confirm-stopped",
        "true",
        "--out",
        "both.json",
      ),
      deps,
    );
    expect(report.installed && report.written === join(root, "both.json")).toBe(
      true,
    );
    expect(installed).toHaveLength(1);
  });

  it("an install failure after validation surfaces and reports nothing installed", async () => {
    const { deps } = fixture({
      install: async () => {
        throw new Error(
          "Stop and inspect the existing supervisor before replacing configuration",
        );
      },
    });
    await expect(
      runSetup(
        ni(
          "--template",
          "codex",
          "--install",
          "true",
          "--confirm-stopped",
          "true",
        ),
        deps,
      ),
    ).rejects.toThrow(/Stop and inspect the existing supervisor/);
  });

  it("builds claude, opencode and mixed with explicit flags", async () => {
    const { deps, bin } = fixture();
    const claude = await runSetup(
      ni(
        "--template",
        "claude",
        "--model",
        "opus",
        "--tasks",
        "A-1,B_2",
        "--implementers",
        "dev",
        "--max-cost-usd",
        "1.25",
        "--claude-permission-mode",
        "auto",
        "--claude-setting-sources",
        "project,local",
        "--max-parallel",
        "1",
      ),
      deps,
    );
    expect((claude.config.lanes as Record<string, unknown>).dev).toEqual({
      enabled: true,
      harness: "claude",
      model: "opus",
      claudePermissionMode: "auto",
      claudeMcp: "strict",
      claudeSettingSources: ["project", "local"],
      maxCostUsdPerRun: 1.25,
    });
    expect(claude.config.maxParallel).toBe(1);
    expect(claude.config.allowedTasks).toEqual(["A-1", "B_2"]);
    const mixed = await runSetup(
      ni("--template", "mixed", "--model", "opus", "--reviewer-model", "p/m#v"),
      deps,
    );
    expect(mixed.config.binaries).toEqual({
      claude: join(bin, "claude"),
      opencode: join(bin, "opencode"),
    });
    const opencode = await runSetup(
      ni(
        "--template",
        "opencode",
        "--model",
        "prov/model",
        "--opencode-binary",
        join(bin, "opencode"),
      ),
      deps,
    );
    expect(
      (opencode.config.lanes as Record<string, { model: string }>).captain
        ?.model,
    ).toBe("prov/model");
  });

  it("supports Pi only as the mixed reviewer", async () => {
    const { deps, fake } = fixture({}, ["claude"]);
    const pi = fake("pi");
    const report = await runSetup(
      ni(
        "--template",
        "mixed",
        "--reviewer-harness",
        "pi",
        "--model",
        "opus",
        "--pi-binary",
        pi,
        "--pi-model",
        "prov/m1",
      ),
      deps,
    );
    const lanes = report.config.lanes as Record<
      string,
      Record<string, unknown>
    >;
    expect(lanes.inspector).toMatchObject({
      harness: "pi",
      piPermissions: "no-tools",
      sessionEpoch: "setup-fixed",
      piModel: { provider: "prov", id: "m1" },
    });
    await expect(
      runSetup(
        ni("--template", "claude", "--model", "opus", "--pi-binary", pi),
        deps,
      ),
    ).rejects.toThrow(/--pi-binary does not apply/);
    await expect(
      runSetup(ni("--template", "codex", "--reviewer-harness", "pi"), deps),
    ).rejects.toThrow(/only to the mixed template/);
  });

  it("refuses bad input", async () => {
    const { deps, fake, bin } = fixture();
    const cases: Array<[string[], RegExp]> = [
      [["--template", "nope"], /requires --template/],
      [[], /requires --template/],
      [["--template", "claude"], /claude requires a model/],
      [
        [
          "--template",
          "claude",
          "--model",
          "opus",
          "--claude-permission-mode",
          "bypassPermissions",
        ],
        /non-bypass|bypass and manual/,
      ],
      [
        ["--template", "claude", "--model", "bad model!"],
        /Claude requires an explicit model/,
      ],
      [["--template", "opencode", "--model", "haiku"], /provider\/model/],
      [
        ["--template", "mixed", "--model", "opus"],
        /requires a model: pass --reviewer-model/,
      ],
      [
        ["--template", "codex", "--binary", "relative/codex"],
        /must be absolute/,
      ],
      [
        ["--template", "codex", "--binary", fake("plain", 0o644)],
        /not an executable regular file/,
      ],
      [
        ["--template", "codex", "--binary", bin],
        /not an executable regular file/,
      ],
      [["--template", "codex", "--tasks", "A,A"], /duplicate/],
      [["--template", "codex", "--tasks", "../etc"], /invalid value/],
      [["--template", "codex", "--implementers", "captain"], /must differ/],
      [["--template", "codex", "--max-parallel", "9"], /maxParallel must be/],
      [["--template", "codex", "--model", "x y"], /Invalid Codex model/],
      [
        ["--template", "codex", "--claude-mcp", "strict"],
        /Claude flags do not apply/,
      ],
    ];
    for (const [args, pattern] of cases)
      await expect(runSetup(ni(...args), deps), args.join(" ")).rejects.toThrow(
        pattern,
      );
  });

  it("explains a missing harness instead of guessing a path", async () => {
    const { deps } = fixture({}, []);
    await expect(runSetup(ni("--template", "codex"), deps)).rejects.toThrow(
      /No codex executable found on PATH; pass --binary/,
    );
  });

  it("requires tasks when none are discoverable", async () => {
    const { deps, root } = fixture();
    rmSync(join(root, "tasks"), { recursive: true });
    await expect(runSetup(ni("--template", "codex"), deps)).rejects.toThrow(
      /No task cards found/,
    );
    const report = await runSetup(
      ni("--template", "codex", "--tasks", "X-1"),
      deps,
    );
    expect(Object.keys(report.config.lanes as object)).toContain("implementer");
  });

  it("never prints environment values", async () => {
    const { deps } = fixture();
    const report = await runSetup(ni("--template", "codex"), {
      ...deps,
      env: { ...deps.env, OPENAI_API_KEY: "sk-secret-value" },
    });
    expect(JSON.stringify(report)).not.toContain("sk-secret-value");
  });
});

describe("interactive gate", () => {
  it("fails without a terminal instead of reading stdin", async () => {
    const { deps } = fixture();
    await expect(runSetup([], deps)).rejects.toThrow(
      /needs an interactive terminal on stdin and stdout/,
    );
  });
  it("rejects option flags", async () => {
    const { deps } = fixture({ tty: true });
    await expect(runSetup(["--template", "codex"], deps)).rejects.toThrow(
      /require non-interactive mode/,
    );
  });
  it("requires an explicit true for --non-interactive", async () => {
    const { deps } = fixture();
    await expect(
      runSetup(["--non-interactive", "1", "--template", "codex"], deps),
    ).rejects.toThrow(/--non-interactive must be true/);
  });

  const scripted = (answers: Array<string | null>) => {
    const stderr: string[] = [];
    const queue = [...answers];
    let closed = 0;
    const io: WizardIO = {
      ask: async () => (queue.length ? (queue.shift() as string | null) : null),
      write: (text) => void stderr.push(text),
      close: () => void closed++,
    };
    return { io, stderr, closed: () => closed };
  };

  it("runs the wizard, installs on yes and keeps prompts off the report", async () => {
    const script = scripted([
      "codex",
      "",
      "", // template, binary, model
      "",
      "", // implementers, tasks (discovered)
      "",
      "",
      "",
      "", // limits
      "yes",
      "yes",
      "yes", // stopped, review, install
      "wizard.json", // out
    ]);
    const { deps, root, installed, bin } = fixture({
      tty: true,
      makeIO: () => script.io,
    });
    const report = await runSetup([], deps);
    expect(script.closed()).toBe(1);
    expect(report).toMatchObject({
      mode: "interactive",
      template: "codex",
      installed: true,
      written: join(root, "wizard.json"),
      confirmedStopped: true,
    });
    expect(report.config.binary).toBe(join(bin, "codex"));
    expect(installed).toHaveLength(1);
    expect(script.stderr.join("")).toContain("Review:");
    expect(JSON.stringify(report)).not.toContain("Review:");
  });

  it("EOF aborts and writes and installs nothing", async () => {
    for (let cut = 0; cut < 9; cut++) {
      const answers = ["codex", "", "", "", "", "", "", "", ""].slice(0, cut);
      const script = scripted(answers);
      const { deps, root, installed } = fixture({
        tty: true,
        makeIO: () => script.io,
      });
      const before = readdirSync(root).sort();
      await expect(runSetup([], deps)).rejects.toThrow(
        /Setup cancelled; nothing was written/,
      );
      expect(script.closed()).toBe(1);
      expect(readdirSync(root).sort()).toEqual(before);
      expect(installed).toEqual([]);
    }
  });
});
