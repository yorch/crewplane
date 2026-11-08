// Compiled synthetic adapter: no provider, network, Node or Bun installation needed.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const input = await new Response(Bun.stdin.stream()).text();
const task = input.match(/Current task: ([A-Za-z0-9_-]+)/)?.[1];
const lane = process.env.CREWPLANE_HEADLESS_LANE;
const executable = process.env.CREWPLANE_EXECUTABLE;
if (!lane || !executable || !task)
  throw Error("Synthetic harness missing context");
const cli = (...args: string[]) => {
  for (let i = 0; i < 30; i++) {
    const result = spawnSync(executable, ["agents", ...args], {
      encoding: "utf8",
    });
    if (result.status === 0) return JSON.parse(result.stdout);
    if (
      !result.stderr.includes(
        "Process lock unavailable; inspect ownership before retry",
      )
    )
      throw Error(result.stderr);
    awaitDelay(20);
  }
  throw Error("Synthetic CLI contention timeout");
};
function awaitDelay(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
if (lane === "inspector") {
  const requests = cli("inbox", "--agent", lane);
  const request = requests
    .filter(
      (m: { kind: string; task: string }) =>
        m.kind === "request" && m.task === task,
    )
    .at(-1);
  if (request)
    cli(
      "send",
      "--agent",
      lane,
      "--to",
      "captain",
      "--task",
      task,
      "--kind",
      "answer",
      "--reply-to",
      request.id,
      "--text",
      "Synthetic review: one correction required in first.txt",
    );
} else {
  const assignment = cli("board").tasks.find(
    (t: { task: string }) => t.task === task,
  );
  if (!assignment?.claim) cli("claim", "--agent", lane, "--task", task);
  cli(
    "status",
    "--agent",
    lane,
    "--task",
    task,
    "--state",
    "working",
    "--text",
    "Synthetic implementation",
  );
  const path = lane === "builder" ? "first.txt" : "second.txt";
  const revised = existsSync(path);
  writeFileSync(
    path,
    revised
      ? "first corrected\n"
      : lane === "builder"
        ? "first draft\n"
        : "second complete\n",
  );
  git("add", path);
  git(
    "commit",
    "-qm",
    revised ? "fix: apply synthetic review" : "feat: implement synthetic task",
  );
  cli(
    "status",
    "--agent",
    lane,
    "--task",
    task,
    "--state",
    "ready",
    "--commit",
    "HEAD",
    "--text",
    "Synthetic clean handoff",
  );
}
const args = process.argv.slice(2),
  out = args[args.indexOf("--output-last-message") + 1];
if (!out) throw Error("Missing result path");
writeFileSync(
  out,
  JSON.stringify({ state: "ready", summary: "Synthetic handoff complete" }),
);
console.log(
  JSON.stringify({
    type: "thread.started",
    thread_id:
      lane === "builder"
        ? "11111111-1111-4111-8111-111111111111"
        : lane === "designer"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
  }),
);
console.log(
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 17, output_tokens: 5 },
  }),
);
