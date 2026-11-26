import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../contracts.ts";
import { assertSwitch } from "../engine/harness.ts";
import { defaultPolicy, type ProjectPolicy } from "../project.ts";
import {
  checkGenerated,
  discoverTasks,
  runSetup,
  type SetupDeps,
} from "./command.ts";
import type { WizardIO } from "./wizard.ts";

const scratch: string[] = [];
afterEach(() => {
  // Fake harnesses write a marker if executed; setup must never run them.
  const ran = scratch.filter((path) => existsSync(join(path, "harness-ran")));
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
  expect(ran).toEqual([]);
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
    writeFileSync(
      path,
      `#!/bin/sh\ntouch '${join(base, "harness-ran")}'\nexit 9\n`,
    );
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
/** Non-interactive args; `--tasks` is mandatory, so default it unless given. */
const ni = (...args: string[]) => [
  "--non-interactive",
  "true",
  ...(args.includes("--tasks") ? [] : ["--tasks", "CP-101"]),
  ...args,
];
const rawNi = (...args: string[]) => ["--non-interactive", "true", ...args];
const git = (cwd: string, ...args: string[]) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  return execFileSync("git", args, { cwd, env, stdio: "pipe" });
};

it("discovers task cards and their owners without trusting non-cards", async () => {
  const { root } = fixture();
  writeFileSync(join(root, "tasks/CP-103.md"), "Status: Done\nOwner: old.\n");
  writeFileSync(join(root, "tasks/CP-104.md"), "Status: completed.\n");
  writeFileSync(join(root, "tasks/bad id.md"), "Owner: x.\n");
  expect(await discoverTasks(root, "tasks", new Set(["captain"]))).toEqual({
    tasks: ["CP-101", "CP-102"],
    implementers: ["builder", "designer"],
  });
  // Bounded: never more than the cap, however many cards exist.
  for (let i = 0; i < 260; i++)
    writeFileSync(
      join(root, `tasks/N-${String(i).padStart(3, "0")}.md`),
      "x\n",
    );
  expect(
    (await discoverTasks(root, "tasks", new Set())).tasks.length,
  ).toBeLessThanOrEqual(200);
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
    // Cards on disk (CP-102, owners builder/designer) authorize nothing: only
    // --tasks and the single documented default implementer lane count.
    expect(Object.keys(report.config.lanes as object)).toEqual([
      "captain",
      "implementer",
      "inspector",
      "visual",
    ]);
    expect(report.config.allowedTasks).toEqual(["CP-101"]);
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

  it("--out creates a 0600 file atomically and refuses to overwrite", async () => {
    const { base, deps, installed } = fixture();
    const path = join(base, "out", "runtime.json");
    mkdirSync(join(base, "out"));
    const report = await runSetup(
      ni("--template", "codex", "--out", path),
      deps,
    );
    expect(report.written).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report.config);
    // No temporary file is left next to it.
    expect(readdirSync(join(base, "out"))).toEqual(["runtime.json"]);
    expect(installed).toEqual([]);
    expect(report.next).toEqual([
      "verify the supervisor is stopped, then record confirmedStoppedAt",
      `crewplane configure --file ${path}`,
      "crewplane doctor",
    ]);
    const first = readFileSync(path, "utf8");
    await expect(
      runSetup(
        ni("--template", "claude", "--model", "opus", "--out", path),
        deps,
      ),
    ).rejects.toThrow(/Refusing to overwrite/);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(readdirSync(join(base, "out"))).toEqual(["runtime.json"]);
  });

  it("--out refuses a directory, a missing parent and unsafe locations before writing", async () => {
    const { base, root, deps } = fixture({});
    const control = join(base, "control");
    const store = join(root, ".crewplane-state");
    mkdirSync(control);
    mkdirSync(store);
    deps.protectedPaths = [control, store];
    const outside = join(base, "outside");
    mkdirSync(outside);
    const link = join(base, "link-to-control");
    symlinkSync(control, link);
    const cases: Array<[string, RegExp]> = [
      [outside, /--out names a directory/],
      [join(base, "missing", "x.json"), /parent directory does not exist/],
      [join(control, "config.json"), /inside the Crewplane control or state/],
      [join(link, "config.json"), /inside the Crewplane control or state/],
      [join(store, "x.json"), /inside the Crewplane control or state/],
      [
        join(root, ".crewplane-local", "x.json"),
        /parent directory does not exist/,
      ],
      [join(base, "has\nnewline.json"), /control characters/],
      [join(base, ".git", "x.json"), /parent directory does not exist|\.git/],
    ];
    for (const [out, pattern] of cases)
      await expect(
        runSetup(ni("--template", "codex", "--out", out), deps),
        out,
      ).rejects.toThrow(pattern);
    expect(readdirSync(control)).toEqual([]);
    expect(readdirSync(store)).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("--out refuses git-tracked locations unless the path is git-ignored", async () => {
    const { root, deps } = fixture();
    git(root, "init", "-q", "--initial-branch=main");
    await expect(
      runSetup(ni("--template", "codex", "--out", "runtime.json"), deps),
    ).rejects.toThrow(/not git-ignored/);
    expect(existsSync(join(root, "runtime.json"))).toBe(false);
    expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    writeFileSync(join(root, ".gitignore"), "/ignored-runtime.json\n");
    const report = await runSetup(
      ni("--template", "codex", "--out", "ignored-runtime.json"),
      deps,
    );
    expect(report.written).toBe(join(root, "ignored-runtime.json"));
    // A nested repository's own ignore rules decide for paths inside it.
    const nested = join(root, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q");
    await expect(
      runSetup(ni("--template", "codex", "--out", "nested/x.json"), deps),
    ).rejects.toThrow(/not git-ignored/);
  });

  it("shell-quotes the --out path in the next hint", async () => {
    const { base, deps } = fixture();
    mkdirSync(join(base, "o"));
    const odd = join(base, "o", "it's a file.json");
    const report = await runSetup(
      ni("--template", "codex", "--out", odd),
      deps,
    );
    expect(report.next[1]).toBe(
      `crewplane configure --file '${odd.replace(/'/g, "'\\''")}'`,
    );
  });

  it("cleans its temporary file when publishing fails", async () => {
    const { base, deps } = fixture();
    const outDir = join(base, "o");
    mkdirSync(outDir);
    const path = join(outDir, "race.json");
    // Someone creates the target after the checks passed (here: during install).
    const racing = {
      ...deps,
      install: async (value: Record<string, unknown>) => {
        writeFileSync(path, "theirs\n");
        return value as unknown as Config;
      },
    };
    await expect(
      runSetup(
        ni(
          "--template",
          "codex",
          "--confirm-stopped",
          "true",
          "--install",
          "true",
          "--out",
          path,
        ),
        racing,
      ),
    ).rejects.toThrow(
      /WAS installed, but --out was not written: Refusing to overwrite/,
    );
    expect(readdirSync(outDir)).toEqual(["race.json"]);
    expect(readFileSync(path, "utf8")).toBe("theirs\n");
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

  it("--install and --out combine, installing before the file appears", async () => {
    const { base, deps, installed } = fixture();
    mkdirSync(join(base, "o"));
    const path = join(base, "o", "both.json");
    const seen: boolean[] = [];
    const report = await runSetup(
      ni(
        "--template",
        "codex",
        "--install",
        "true",
        "--confirm-stopped",
        "true",
        "--out",
        path,
      ),
      {
        ...deps,
        install: async (value) => {
          seen.push(existsSync(path));
          installed.push(value);
          return value as unknown as Config;
        },
      },
    );
    expect(report.installed).toBe(true);
    expect(report.written).toBe(path);
    expect(seen).toEqual([false]);
    expect(installed).toHaveLength(1);
  });

  it("a refused install leaves no --out file and a retry works", async () => {
    const { base, deps, installed } = fixture();
    mkdirSync(join(base, "o"));
    const path = join(base, "o", "retry.json");
    const args = ni(
      "--template",
      "codex",
      "--install",
      "true",
      "--confirm-stopped",
      "true",
      "--out",
      path,
    );
    await expect(
      runSetup(args, {
        ...deps,
        install: async () => {
          throw new Error("Stop and inspect the existing supervisor");
        },
      }),
    ).rejects.toThrow(/Stop and inspect/);
    expect(readdirSync(join(base, "o"))).toEqual([]);
    const retry = await runSetup(args, deps);
    expect(retry).toMatchObject({ installed: true, written: path });
    expect(installed).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toContain("confirmedStoppedAt");
  });

  it("refuses --confirm-stopped while the control state says a supervisor runs", async () => {
    const { base, deps, installed } = fixture({
      stopped: async () => "the control state says a supervisor is running",
    });
    mkdirSync(join(base, "o"));
    for (const extra of [
      [],
      ["--install", "true"],
      ["--out", join(base, "o", "x.json")],
    ])
      await expect(
        runSetup(
          ni("--template", "codex", "--confirm-stopped", "true", ...extra),
          deps,
        ),
      ).rejects.toThrow(
        /Refusing --confirm-stopped true: the control state says/,
      );
    expect(installed).toEqual([]);
    expect(readdirSync(join(base, "o"))).toEqual([]);
    // Without the confirmation nothing is stamped, so printing still works.
    const printed = await runSetup(ni("--template", "codex"), deps);
    expect(printed.confirmedStopped).toBe(false);
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

  it("never carries environment values into the report or any written file", async () => {
    const { base, deps } = fixture();
    mkdirSync(join(base, "o"));
    const path = join(base, "o", "env.json");
    const secrets = {
      OPENAI_API_KEY: "sentinel-openai-0f1e",
      ANTHROPIC_API_KEY: "sentinel-anthropic-7a2b",
      CREWPLANE_TOKEN: "sentinel-token-93cd",
      HOME: "/sentinel-home-5d6e",
    };
    const report = await runSetup(ni("--template", "codex", "--out", path), {
      ...deps,
      env: { ...deps.env, ...secrets },
    });
    const seen = [JSON.stringify(report), readFileSync(path, "utf8")].join(
      "\n",
    );
    for (const value of Object.values(secrets))
      expect(seen).not.toContain(value);
  });

  it("requires --tasks and never authorizes tasks from cards on disk", async () => {
    const { deps } = fixture();
    await expect(runSetup(rawNi("--template", "codex"), deps)).rejects.toThrow(
      /requires --tasks ID,ID/,
    );
    await expect(
      runSetup(rawNi("--template", "codex", "--tasks", "NOT-A-CARD"), deps),
    ).resolves.toMatchObject({
      config: { allowedTasks: ["NOT-A-CARD"] },
    });
    const report = await runSetup(
      ni("--template", "codex", "--implementers", "dev,ops"),
      deps,
    );
    expect(Object.keys(report.config.lanes as object)).toEqual([
      "captain",
      "dev",
      "ops",
      "inspector",
      "visual",
    ]);
  });

  it("refuses binaries other users could replace", async () => {
    const { base, bin, fake, deps } = fixture();
    const loose = fake("loose", 0o775);
    const wide = join(base, "wide");
    mkdirSync(wide);
    chmodSync(wide, 0o777);
    const inWide = join(wide, "codex");
    writeFileSync(inWide, "#!/bin/sh\n");
    chmodSync(inWide, 0o755);
    const link = join(bin, "viaLink");
    symlinkSync(inWide, link);
    for (const [path, pattern] of [
      [loose, /group- or world-writable/],
      [inWide, /world-writable without the sticky bit/],
      [link, /world-writable without the sticky bit/],
    ] as const)
      await expect(
        runSetup(ni("--template", "codex", "--binary", path), deps),
        path,
      ).rejects.toThrow(pattern);
    // A sticky world-writable directory (like /tmp) is allowed.
    chmodSync(wide, 0o1777);
    const ok = await runSetup(
      ni("--template", "codex", "--binary", inWide),
      deps,
    );
    expect(ok.config.binary).toBe(inWide);
  });

  it("skips unsafe PATH candidates, lists them and uses the next safe one", async () => {
    const { base, bin, deps } = fixture();
    const wide = join(base, "wide");
    mkdirSync(wide);
    writeFileSync(join(wide, "codex"), "#!/bin/sh\n");
    chmodSync(join(wide, "codex"), 0o755);
    chmodSync(wide, 0o777);
    const report = await runSetup(ni("--template", "codex"), {
      ...deps,
      env: { PATH: `${wide}:${bin}` },
    });
    expect(report.config.binary).toBe(join(bin, "codex"));
    expect(report.notes).toContain(
      `rejected ${join(wide, "codex")}: its directory is world-writable without the sticky bit`,
    );
    // With only the unsafe candidate the error names it.
    await expect(
      runSetup(ni("--template", "codex"), { ...deps, env: { PATH: wide } }),
    ).rejects.toThrow(
      /No codex executable found on PATH \(rejected .*world-writable/,
    );
  });

  it.runIf(process.getuid?.() === 0)(
    "refuses a binary whose directory belongs to another user",
    async () => {
      const { base, deps } = fixture();
      const foreign = join(base, "foreign");
      mkdirSync(foreign);
      const path = join(foreign, "codex");
      writeFileSync(path, "#!/bin/sh\n");
      chmodSync(path, 0o755);
      chownSync(foreign, 4242, 4242);
      await expect(
        runSetup(ni("--template", "codex", "--binary", path), deps),
      ).rejects.toThrow(/directory is owned by another user/);
      const report = await runSetup(ni("--template", "codex"), {
        ...deps,
        env: { PATH: `${foreign}:${deps.env.PATH}` },
      });
      expect(report.notes.join("\n")).toMatch(
        /rejected .*foreign\/codex: its directory is owned by another user/,
      );
    },
  );

  it("emits a fresh sessionEpoch for lanes whose harness changed and keeps prior epochs", async () => {
    const { deps } = fixture({
      prior: async () => ({
        config: {
          captain: { harness: "codex" },
          implementer: { harness: "claude", sessionEpoch: "kept-1" },
        },
        records: {
          captain: { harness: "codex", busy: false },
          inspector: { harness: "codex", busy: true },
        },
      }),
    });
    const report = await runSetup(
      ni("--template", "claude", "--model", "opus"),
      deps,
    );
    const lanes = report.config.lanes as Record<
      string,
      { sessionEpoch?: string }
    >;
    expect(lanes.captain?.sessionEpoch).toBe("setup-fixed");
    expect(lanes.inspector?.sessionEpoch).toBe("setup-fixed");
    expect(lanes.implementer?.sessionEpoch).toBe("kept-1");
    expect(lanes.visual?.sessionEpoch).toBeUndefined();
    expect(report.notes.join("\n")).toMatch(
      /lane captain switches harness from codex to claude/,
    );
    expect(report.notes.join("\n")).toMatch(
      /lane inspector has a prior record that is not idle/,
    );
    // The supervisor's own switch check accepts the generated lane.
    expect(() =>
      assertSwitch(
        lanes.captain as never,
        { harness: "codex", status: "idle" } as never,
        false,
      ),
    ).not.toThrow();
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

  const scripted = (
    answers: Array<string | null>,
    onAsk: (prompt: string) => void = () => {},
  ) => {
    const stderr: string[] = [];
    const queue = [...answers];
    let closed = 0;
    const io: WizardIO = {
      ask: async (prompt) => {
        onAsk(prompt);
        return queue.length ? (queue.shift() as string | null) : null;
      },
      write: (text) => void stderr.push(text),
      close: () => void closed++,
    };
    return {
      io,
      stderr,
      closed: () => closed,
      replace: (from: string, to: string) => {
        for (const [i, value] of queue.entries())
          if (value !== null) queue[i] = value.replace(from, to);
      },
    };
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
      "OUTDIR", // out (an existing directory is refused and re-prompted)
      "OUTDIR/wizard.json",
    ]);
    const { deps, base, installed, bin } = fixture({
      tty: true,
      makeIO: () => script.io,
    });
    mkdirSync(join(base, "o"));
    script.replace("OUTDIR", join(base, "o"));
    const report = await runSetup([], deps);
    expect(script.closed()).toBe(1);
    expect(report).toMatchObject({
      mode: "interactive",
      template: "codex",
      installed: true,
      written: join(base, "o", "wizard.json"),
      confirmedStopped: true,
    });
    expect(script.stderr.join("")).toContain("--out names a directory");
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

  const wizardAnswers = (stopped: string) => [
    "codex",
    "",
    "", // template, binary, model
    "",
    "", // implementers, tasks (discovered)
    "",
    "",
    "",
    "", // limits
    stopped,
    "yes", // review
    ...(stopped === "yes" ? ["no"] : []), // install?
    "", // out
  ];

  it("the wizard refuses a stop confirmation the control state contradicts", async () => {
    const script = scripted(wizardAnswers("yes"));
    const { deps, root, installed } = fixture({
      tty: true,
      makeIO: () => script.io,
      stopped: async () => "a supervisor appears to be live (PID 1 is alive)",
    });
    const before = readdirSync(root).sort();
    await expect(runSetup([], deps)).rejects.toThrow(
      /Refusing to record the stop confirmation: a supervisor appears to be live/,
    );
    expect(script.closed()).toBe(1);
    expect(installed).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("reports a binary that became unusable between acceptance and the final check (exit 2 path)", async () => {
    const { deps, bin, base, installed } = fixture({ tty: true });
    const target = join(bin, "codex");
    mkdirSync(join(base, "o"));
    // The operator takes a while at the review prompt; meanwhile the binary
    // becomes writable by others. Nothing may then be written or installed.
    const script = scripted(
      [...wizardAnswers("yes").slice(0, 11), "yes", join(base, "o", "x.json")],
      (prompt) => {
        if (prompt.startsWith("Looks right")) chmodSync(target, 0o777);
      },
    );
    deps.makeIO = () => script.io;
    const report = await runSetup([], deps);
    expect(report.problems).toEqual([
      {
        code: "BINARY_INVALID",
        lane: "captain",
        message: "codex binary refused: it is group- or world-writable",
      },
    ]);
    expect(report).toMatchObject({ installed: false, written: null });
    expect(installed).toEqual([]);
    expect(readdirSync(join(base, "o"))).toEqual([]);
    expect(report.notes).toContain(
      "nothing was written because verification found problems",
    );
    // The same detection also covers a binary that vanished.
    rmSync(target);
    const gone = await checkGenerated({
      root: "/",
      binary: target,
      lanes: { a: { enabled: true } },
    } as unknown as Config);
    expect(gone.map((p) => p.code)).toEqual(["BINARY_MISSING"]);
  });

  it("a binary removed before the final check is a BINARY_MISSING problem (exit 2), not a thrown error", async () => {
    const { deps, bin, base, installed } = fixture({ tty: true });
    const target = join(bin, "codex");
    mkdirSync(join(base, "o"));
    const script = scripted(
      [...wizardAnswers("yes").slice(0, 11), "yes", join(base, "o", "x.json")],
      (prompt) => {
        if (prompt.startsWith("Looks right")) rmSync(target);
      },
    );
    deps.makeIO = () => script.io;
    const report = await runSetup([], deps);
    expect(report.problems.map((p) => p.code)).toEqual(["BINARY_MISSING"]);
    expect(report).toMatchObject({ installed: false, written: null });
    expect(installed).toEqual([]);
    expect(readdirSync(join(base, "o"))).toEqual([]);
  });

  it("prints a harness-switch epoch note exactly once in an interactive run", async () => {
    const script = scripted(wizardAnswers("no"));
    const { deps } = fixture({
      tty: true,
      makeIO: () => script.io,
      prior: async () => ({
        config: {},
        records: { captain: { harness: "claude", busy: false } },
      }),
    });
    const report = await runSetup([], deps);
    const shown = script.stderr
      .join("")
      .match(/lane captain switches harness/g);
    expect(shown).toHaveLength(1);
    // The CLI echoes report.notes to stderr, so none may repeat the wizard's.
    expect(
      report.notes.filter((n) => /lane captain switches harness/.test(n)),
    ).toEqual([]);
  });

  it("never prints environment values while prompting either", async () => {
    const script = scripted(wizardAnswers("no"));
    const { deps } = fixture({ tty: true, makeIO: () => script.io });
    deps.env = {
      ...deps.env,
      OPENAI_API_KEY: "sentinel-openai-0f1e",
      ANTHROPIC_API_KEY: "sentinel-anthropic-7a2b",
    };
    const report = await runSetup([], deps);
    const seen = JSON.stringify(report) + script.stderr.join("");
    expect(seen).not.toContain("sentinel-");
  });
});
