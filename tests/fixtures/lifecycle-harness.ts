import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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
  const state = JSON.parse(
    readFileSync(`${store}/supervisor/state.json`, "utf8"),
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
  if (mode === "idle") {
    result();
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
