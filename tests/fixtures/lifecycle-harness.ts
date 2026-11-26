import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (process.argv[2] === "child") {
  if (process.argv[3] === "ignore-term") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), 150000);
} else {
  await new Response(Bun.stdin.stream()).text();
  const store = process.env.CREWPLANE_COORD_DIR;
  const pidFile = process.env.CREWPLANE_FIXTURE_PID_FILE;
  const mode = process.env.CREWPLANE_FIXTURE_MODE;
  if (!store || !pidFile || !mode)
    throw Error("Synthetic lifecycle context absent");
  // The child is only given the board. Derive the control directory
  // independently of the product code: the primary root is the parent of the
  // Git common directory, and the key is the first 24 hex of its SHA-256.
  const common = realpathSync(
    execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim(),
  );
  const key = createHash("sha256")
    .update(dirname(common))
    .digest("hex")
    .slice(0, 24);
  const state = JSON.parse(
    readFileSync(
      join(
        process.env.CREWPLANE_STATE_DIR ?? "",
        "crewplane/projects",
        key,
        "state.json",
      ),
      "utf8",
    ),
  ) as { records: Record<string, { pid?: number; status: string }> };
  if (
    !Object.values(state.records).some(
      (record) => record.pid === process.pid && record.status === "running",
    )
  )
    throw Error("Prompt arrived before native PID was durable");
  console.log(
    JSON.stringify({
      type: "thread.started",
      thread_id: "11111111-1111-4111-8111-111111111111",
    }),
  );
  const args = process.argv.slice(2),
    output = args[args.indexOf("--output-last-message") + 1];
  if (!output) throw Error("Synthetic output absent");
  const result = () =>
    writeFileSync(
      output,
      JSON.stringify({
        state: "waiting",
        summary: "Synthetic lifecycle fixture",
      }),
    );
  if (mode === "recovery-idle") {
    const resume = args.indexOf("resume");
    if (
      resume < 0 ||
      args[resume + 1] !== "11111111-1111-4111-8111-111111111111"
    )
      throw Error("Recovery did not explicitly resume the preserved session");
    result();
  } else if (mode === "idle") {
    result();
  } else if (mode === "drain") {
    writeFileSync(
      pidFile,
      JSON.stringify({ leader: process.pid, child: process.pid }),
    );
    setTimeout(() => {
      result();
      process.exit(0);
    }, 2000);
  } else if (mode === "hold-nochild") {
    writeFileSync(
      pidFile,
      JSON.stringify({ leader: process.pid, child: process.pid }),
    );
    setInterval(() => {}, 1000);
  } else {
    const escaped = mode === "escaped-stdio";
    const child = spawn(
      process.execPath,
      ["child", mode === "deadline" ? "ignore-term" : "normal"],
      {
        detached: escaped,
        stdio: escaped ? ["ignore", "inherit", "ignore"] : "ignore",
      },
    );
    if (!child.pid) throw Error("Synthetic child not launched");
    writeFileSync(
      pidFile,
      JSON.stringify({ child: child.pid, leader: process.pid }),
    );
    if (mode === "normal-background" || escaped) {
      result();
      process.exit(0);
    } else setInterval(() => {}, 1000);
  }
}
