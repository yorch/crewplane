// Records the landing-page demo: the real compiled binary driving a throwaway Git project with the
// repository's synthetic test harness (no real agent, provider or network). Output is committed:
//   public/demo.cast       asciicast v2 of the commands and their captured output
//   public/shots/*.png     dashboard screenshots of the same project
// Usage: bun run build (repo root) && bun site/scripts/record-demo.ts
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const REPO = resolve(import.meta.dir, "../..");
const OUT = resolve(import.meta.dir, "../public");
const DEBUG = process.argv.includes("--debug");

const parent = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-demo-")));
const tools = join(parent, "tools");
const root = join(parent, "acme-api");
mkdirSync(tools);
mkdirSync(root);
copyFileSync(join(REPO, "dist/crewplane"), join(tools, "crewplane"));
symlinkSync(
  execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
  join(tools, "git"),
);
const harness = join(tools, "agent-harness");
const built = await Bun.build({
  entrypoints: [join(REPO, "tests/fixtures/harness.ts")],
  compile: { outfile: harness },
});
if (!built.success) throw Error("harness build failed");

const env = {
  ...process.env,
  PATH: tools,
  HOME: join(parent, "home"),
  CREWPLANE_COORD_DIR: "",
  CREWPLANE_EXECUTABLE: join(tools, "crewplane"),
  NO_COLOR: "1",
};
mkdirSync(env.HOME);
const run = (cmd: string, args: string[], cwd = root) =>
  spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
const git = (...a: string[]) => {
  const r = run("git", a);
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
};
const cp = (...a: string[]) => run("crewplane", ["--project", root, ...a]);

// --- project setup (unrecorded) -------------------------------------------------------------
git("init", "-q", "--initial-branch=main");
git("config", "user.name", "Demo");
git("config", "user.email", "demo@example.invalid");
cp("init");
writeFileSync(
  join(root, "crewplane.json"),
  JSON.stringify({
    version: 1,
    coordinator: "captain",
    reviewers: ["inspector"],
    tasksPath: "tasks",
  }),
);
mkdirSync(join(root, "tasks"), { recursive: true });
const cards: Array<[string, string, string]> = [
  ["API-101", "builder", "Add per-key rate limiting to the public API"],
  ["API-102", "designer", "Redesign the account settings page"],
];
for (const [id, owner, title] of cards)
  writeFileSync(
    join(root, `tasks/${id}.md`),
    `# ${id}: ${title}\nOwner: ${owner}.\nStatus: todo\nGoal: ${title}.\n`,
  );
writeFileSync(
  join(root, "AGENTS.md"),
  "Demo project. Only assigned files may change.\n",
);
git("add", ".");
git("commit", "-qm", "chore: initial project");
const base = git("rev-parse", "HEAD");
const configFile = join(parent, "runtime.json");
writeFileSync(
  configFile,
  JSON.stringify({
    version: 1,
    root,
    binary: harness,
    allowedTasks: cards.map((c) => c[0]),
    maxParallel: 2,
    intervalSeconds: 1,
    maxRunMinutes: 1,
    maxRunsPerHour: 20,
    confirmedStoppedAt: new Date().toISOString(),
    lanes: {
      captain: { enabled: false },
      builder: { enabled: true },
      designer: { enabled: true },
      inspector: { enabled: true },
    },
  }),
);

// --- recorder ---------------------------------------------------------------------------------
type Event = [number, "o", string];
const events: Event[] = [];
let clock = 0.4;
const emit = (text: string, gap = 0) => {
  clock += gap;
  events.push([
    Math.round(clock * 1000) / 1000,
    "o",
    text.replace(/\n/g, "\r\n"),
  ]);
};
const PROMPT = "\x1b[38;5;78m❯\x1b[0m ";
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const type = (cmd: string) => {
  emit(PROMPT, 0.2);
  for (const ch of cmd) emit(ch, 0.025 + ((ch.charCodeAt(0) * 7) % 5) * 0.012);
  emit("\n", 0.35);
};
const show = (text: string, perLine = 0.012) => {
  for (const line of text.replace(/\s+$/, "").split("\n"))
    emit(`${line}\n`, perLine);
};
const note = (text: string) => emit(`${dim(`# ${text}`)}\n`, 0.5);
const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
const shorten = (s: string) =>
  s.replaceAll(root, "~/acme-api").replaceAll(harness, "agent-harness");
/** Run a real command; show it as typed with `display` and print what it actually returned. */
const step = (
  display: string,
  args: string[],
  opts: { lines?: number; keep?: (s: string) => string } = {},
) => {
  type(display);
  const r = cp(...args);
  if (r.status !== 0) throw Error(`${display}: ${r.stderr}`);
  let out = shorten(pretty(r.stdout)).split("\n");
  if (opts.lines && out.length > opts.lines)
    out = [...out.slice(0, opts.lines), dim("  …")];
  show(out.join("\n"));
  return r.stdout;
};

// --- the recorded session -------------------------------------------------------------------
const pad = (s: string, n: number) => s.padEnd(n);
const table = (head: string[], rows: string[][]) => {
  const w = head.map(
    (h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)) + 2,
  );
  return [head, ...rows]
    .map((r, k) => {
      const line = r
        .map((c, i) => pad(c, w[i] ?? 0))
        .join("")
        .trimEnd();
      return k === 0 ? dim(line) : line;
    })
    .join("\n");
};
const cli = (...a: string[]) => JSON.parse(cp(...a).stdout);

note("an ordinary Git repository with two committed task cards");
type("ls tasks");
show(cards.map((c) => `${c[0]}.md`).join("  "));
step(
  "crewplane configure --file runtime.json",
  ["configure", "--file", configFile],
  { lines: 8 },
);
type("crewplane doctor | jq -c '{config, harnesses: [.harnesses[].id]}'");
const doctor = cli("doctor");
show(
  JSON.stringify({
    config: doctor.config,
    harnesses: doctor.harnesses.map((h: { id: string }) => h.id),
  }),
);

note("nothing runs until the coordinator scopes, approves and schedules it");
for (const [id, owner] of cards) {
  const path = id === "API-101" ? "first.txt" : "second.txt";
  cp(
    "agents",
    "scope",
    "--agent",
    "captain",
    "--task",
    id,
    "--paths-json",
    JSON.stringify([path]),
  );
  const assigned = cp(
    "agents",
    "assign",
    "--agent",
    "captain",
    "--task",
    id,
    "--owner",
    owner,
    "--ref",
    base,
    "--text",
    "Approved scope",
  );
  cp(
    "agents",
    "schedule",
    "--agent",
    "captain",
    "--task",
    id,
    "--priority",
    "normal",
  );
  if (id === "API-101") {
    type(`crewplane agents assign --task ${id} --owner ${owner} --ref main`);
    const a = JSON.parse(assigned.stdout);
    show(
      JSON.stringify(
        {
          task: a.task,
          owner: a.owner,
          baseCommit: String(a.baseCommit).slice(0, 7),
        },
        null,
        2,
      ),
    );
  } else emit(dim("# …and API-102 → designer\n"), 0.4);
}
const q = cli(
  "agents",
  "send",
  "--agent",
  "builder",
  "--to",
  "designer",
  "--kind",
  "question",
  "--task",
  "API-101",
  "--text",
  "Should rate-limit errors reuse the toast component?",
);
cli(
  "agents",
  "send",
  "--agent",
  "designer",
  "--to",
  "builder",
  "--kind",
  "answer",
  "--reply-to",
  q.id,
  "--task",
  "API-101",
  "--text",
  "Yes — toast, 6s, with a retry-after countdown.",
);

note("start the supervisor: agents get isolated worktrees and run in parallel");
type("crewplane start");
const sup = spawn(join(tools, "crewplane"), ["--project", root, "start"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const lines: Array<[number, string]> = [];
const began = Date.now();
const collect = (b: Buffer) => {
  for (const l of String(b).split("\n"))
    if (l.trim() && !l.startsWith("fatal: 'refs/heads/"))
      lines.push([Date.now() - began, l]); // git ref-probe noise
};
sup.stdout.on("data", collect);
sup.stderr.on("data", collect);
type Board = {
  tasks: Array<{
    task: string;
    assignment?: { owner: string };
    status?: { state: string; commit?: string } | null;
  }>;
};
const board = () => cli("task", "list") as Board;
while (!board().tasks.every((t) => t.status?.state === "ready")) {
  if (Date.now() - began > 90000) throw Error("supervisor timeout");
  await Bun.sleep(250);
}
let prev = 0;
for (const [at, l] of lines) {
  emit(`${shorten(l)}\n`, Math.min(Math.max((at - prev) / 1000, 0.05), 0.9));
  prev = at;
}
await Bun.sleep(1500); // let completion persist before the observation commands below
note("meanwhile, in another terminal");
type(
  "crewplane task list | jq -r '.tasks[] | [.task, .assignment.owner, .status.state, .status.commit[0:7]] | @tsv'",
);
const tasks = board();
show(
  table(
    ["TASK", "OWNER", "STATE", "COMMIT"],
    tasks.tasks.map((t) => [
      t.task,
      t.assignment?.owner ?? "-",
      t.status?.state ?? "-",
      String(t.status?.commit ?? "-").slice(0, 7),
    ]),
  ),
);
type(
  "crewplane agent list | jq -r '.lanes[] | [.lane, .status, .configuredHarness] | @tsv'",
);
const lanes = (cli("agent", "list").lanes ?? []) as Array<{
  lane: string;
  status: string;
  configuredHarness: string;
}>;
show(
  table(
    ["LANE", "STATUS", "HARNESS"],
    lanes.map((l) => [l.lane, l.status, l.configuredHarness]),
  ),
);
note("stopping is explicit, and a stopped supervisor stays stopped");
type("crewplane stop");
const stopped = cp("stop");
show(shorten(pretty(stopped.stdout)).split("\n").slice(0, 6).join("\n"));
emit(`${PROMPT}`, 0.6);
emit("", 2.5);
await new Promise((r) => {
  sup.once("exit", r);
  setTimeout(() => {
    sup.kill("SIGTERM");
    r(null);
  }, 15000);
});

writeFileSync(
  join(OUT, "demo.cast"),
  `${JSON.stringify({ version: 2, width: 104, height: 30, title: "Crewplane demo", env: { TERM: "xterm-256color" } })}\n${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
);
if (DEBUG)
  console.error(
    events
      .map((e) => e[2])
      .join("")
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), ""),
  );

// --- dashboard screenshots ------------------------------------------------------------------
mkdirSync(join(OUT, "shots"), { recursive: true });
const dash = spawn(
  join(tools, "crewplane"),
  ["--project", root, "dashboard", "--port", "4399"],
  { env, stdio: "ignore" },
);
await Bun.sleep(1500);
const browser = await chromium.launch();
try {
  for (const [scheme, suffix] of [["light", ""]] as const) {
    const page = await (
      await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      })
    ).newPage();
    for (const view of ["overview", "tasks", "agents", "messages"]) {
      await page.goto(`http://127.0.0.1:4399/#/${view}`);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(OUT, `shots/${view}${suffix}.png`) });
    }
  }
} finally {
  await browser.close();
  dash.kill("SIGTERM");
}
console.error(
  `recorded ${events.length} events (${clock.toFixed(1)}s) from ${root}`,
);
