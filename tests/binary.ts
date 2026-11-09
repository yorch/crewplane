import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  version: string;
};
const temp = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-binary-")));
const root = join(temp, "project"),
  tools = join(temp, "tools"),
  bin = join(tools, "crewplane"),
  fixture = join(tools, "synthetic-harness");
const children: ChildProcess[] = [];
let nativeLogs = "";
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const build = await Bun.build({
  entrypoints: [resolve("tests/fixtures/harness.ts")],
  compile: { outfile: fixture },
});
assert(build.success);
const env = {
  ...process.env,
  PATH: tools,
  HOME: join(temp, "home"),
  CREWPLANE_COORD_DIR: "",
  CREWPLANE_EXECUTABLE: bin,
  CREWPLANE_NO_AUTO_UPDATE: "1",
};
const command = (...args: string[]) => {
  const result = spawnSync(bin, ["--project", root, ...args], {
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
};
const json = (...args: string[]) => JSON.parse(command(...args));
const until = async (
  check: () => boolean | Promise<boolean>,
  label: string,
) => {
  const deadline = Date.now() + 25000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw Error(`Timed out: ${label}\n${nativeLogs}`);
    await Bun.sleep(30);
  }
};
const start = (...args: string[]) => {
  const child = spawn(bin, ["--project", root, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (b) => (nativeLogs += b.toString()));
  child.stderr?.on("data", (b) => (nativeLogs += b.toString()));
  return child;
};
const state = () => json("status").state;
const board = () => json("task", "list");
const closed = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(
      () => reject(Error(`Child did not stop\n${nativeLogs}`)),
      10000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
try {
  mkdirSync(root, { recursive: true });
  mkdirSync(tools, { recursive: true });
  mkdirSync(env.HOME, { recursive: true });
  copyFileSync(resolve("dist/crewplane"), bin);
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  symlinkSync(gitPath, join(tools, "git"));
  assert.equal(
    (spawnSync("node", ["--version"], { env }).error as NodeJS.ErrnoException)
      ?.code,
    "ENOENT",
  );
  assert.equal(
    (spawnSync("bun", ["--version"], { env }).error as NodeJS.ErrnoException)
      ?.code,
    "ENOENT",
  );
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  json("init");
  writeFileSync(
    join(root, "crewplane.json"),
    JSON.stringify({
      version: 1,
      coordinator: "captain",
      reviewers: ["inspector"],
      tasksPath: "tickets",
      planPath: "ROADMAP.md",
      statusPath: "PROGRESS.md",
      instructionsPath: "GUIDELINES.md",
    }),
  );
  mkdirSync(join(root, "tickets"));
  for (const [id, owner] of [
    ["CP-101", "builder"],
    ["CP-102", "designer"],
  ])
    writeFileSync(
      join(root, `tickets/${id}.md`),
      `# ${id}\nOwner: ${owner}.\nStatus: todo\nGoal: synthetic isolated task\n`,
    );
  writeFileSync(
    join(root, "GUIDELINES.md"),
    "Synthetic project. Only assigned text files may change.\n",
  );
  git("add", ".");
  git("commit", "-qm", "test: initialize synthetic project");
  const base = git("rev-parse", "HEAD");
  const config = {
    version: 1,
    root,
    binary: fixture,
    allowedTasks: ["CP-101", "CP-102"],
    maxParallel: 3,
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
  };
  const configFile = join(temp, "runtime.json");
  writeFileSync(configFile, JSON.stringify(config));
  json("configure", "--file", configFile);
  assert.equal(json("doctor").config, "valid");
  assert.equal(json("status").state, null);
  const agents = (...args: string[]) => json("agents", ...args);
  for (const [id, owner, path] of [
    ["CP-101", "builder", "first.txt"],
    ["CP-102", "designer", "second.txt"],
  ] as const) {
    agents(
      "scope",
      "--agent",
      "captain",
      "--task",
      id,
      "--paths-json",
      JSON.stringify([path]),
    );
    agents(
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
      "Synthetic approved scope",
    );
    agents(
      "schedule",
      "--agent",
      "captain",
      "--task",
      id,
      "--priority",
      "normal",
    );
  }
  const q = agents(
    "send",
    "--agent",
    "builder",
    "--to",
    "designer",
    "--kind",
    "question",
    "--task",
    "CP-101",
    "--text",
    "Synthetic question",
  );
  agents(
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
    "CP-101",
    "--text",
    "Synthetic answer",
  );
  const supervisor = start("start");
  await until(
    () =>
      board().tasks.every(
        (t: { status?: { state: string } }) => t.status?.state === "ready",
      ),
    "two independent ready submissions",
  );
  await until(
    () =>
      Object.values(state().records).every(
        (r: unknown) => (r as { status: string }).status !== "running",
      ),
    "completion persistence",
  );
  const first = board().tasks.find(
    (t: { task: string }) => t.task === "CP-101",
  );
  const firstSession = Object.values(state().records).find(
    (r: unknown) => (r as { lane: string }).lane === "builder",
  ) as { sessionId: string; cwd: string };
  agents(
    "send",
    "--agent",
    "captain",
    "--to",
    "inspector",
    "--kind",
    "request",
    "--task",
    "CP-101",
    "--commit",
    first.status.commit,
    "--text",
    "Review exact synthetic submission",
  );
  await until(
    () =>
      board().messages.some(
        (m: { from: string; kind: string }) =>
          m.from === "inspector" && m.kind === "answer",
      ),
    "pinned review",
  );
  await until(
    () =>
      Object.values(state().records).every(
        (r: unknown) => (r as { status: string }).status !== "running",
      ),
    "review completion",
  );
  agents(
    "send",
    "--agent",
    "captain",
    "--to",
    "builder",
    "--kind",
    "request",
    "--task",
    "CP-101",
    "--commit",
    first.status.commit,
    "--text",
    "Apply the synthetic correction",
  );
  await until(() => {
    const t = board().tasks.find((t: { task: string }) => t.task === "CP-101");
    return (
      t?.status?.state === "ready" &&
      !!t.status.commit &&
      t.status.commit !== first.status.commit
    );
  }, "author correction");
  await until(
    () =>
      Object.values(state().records).every(
        (r: unknown) => (r as { status: string }).status !== "running",
      ),
    "correction completion",
  );
  const after = Object.values(state().records).find(
    (r: unknown) => (r as { lane: string }).lane === "builder",
  ) as { sessionId: string; cwd: string };
  assert.equal(after.cwd, firstSession.cwd);
  assert.equal(after.sessionId, firstSession.sessionId);
  const tasks = board().tasks;
  const one = tasks.find((t: { task: string }) => t.task === "CP-101"),
    two = tasks.find((t: { task: string }) => t.task === "CP-102");
  git("merge", "--ff-only", one.status.commit);
  agents(
    "accept",
    "--agent",
    "captain",
    "--task",
    "CP-101",
    "--commit",
    one.status.commit,
    "--text",
    "Synthetic integration checked",
  );
  const integrationBase = git("rev-parse", "HEAD");
  git("cherry-pick", two.status.commit);
  agents(
    "accept",
    "--agent",
    "captain",
    "--task",
    "CP-102",
    "--commit",
    "HEAD",
    "--strategy",
    "rebase",
    "--integration-base",
    integrationBase,
    "--text",
    "Synthetic linear integration checked",
  );
  assert.equal(
    board().tasks.filter((t: { accepted: unknown }) => t.accepted).length,
    2,
  );
  assert.equal(git("log", "--merges", "--format=%H"), "");
  assert.equal(
    readFileSync(join(root, "first.txt"), "utf8"),
    "first corrected\n",
  );
  assert.equal(
    readFileSync(join(root, "second.txt"), "utf8"),
    "second complete\n",
  );
  json("stop");
  await closed(supervisor);
  assert.equal(json("status").desired.desiredRunning, false);
  const runInput = join(temp, "evidence-run.json"),
    captureInput = join(temp, "evidence-capture.json"),
    pngPath = join(temp, "synthetic.png");
  writeFileSync(
    runInput,
    JSON.stringify({
      task: "CP-101",
      lane: "vision",
      testedCommit: one.status.commit,
    }),
  );
  const evidenceRun = json("evidence", "create", "--input", runInput);
  writeFileSync(
    captureInput,
    JSON.stringify({
      route: "dashboard",
      scenario: "initial",
      step: 0,
      browser: "chromium",
      viewport: { width: 390, height: 844 },
      mime: "image/png",
      outcome: "captured",
      findingIds: [],
      recheckOf: null,
    }),
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(pngPath, png);
  const artifact = json(
    "evidence",
    "append",
    "--run",
    evidenceRun.runId,
    "--input",
    captureInput,
    "--file",
    pngPath,
  );
  assert.equal(
    json("evidence", "manifest", "--run", evidenceRun.runId).artifacts[0]
      .artifactId,
    artifact.artifactId,
  );
  // Embedded dashboard survives source-free execution; Host and Origin remain restricted.
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
  const dashboard = start("dashboard", "--port", String(port));
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).ok;
    } catch {
      return false;
    }
  }, "embedded dashboard");
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert(html.includes("Crewplane"));
  assert(
    (
      await (await fetch(`http://127.0.0.1:${port}/dashboard.js`)).text()
    ).includes("fetch"),
  );
  const snap = (await (
    await fetch(`http://127.0.0.1:${port}/api/snapshot`)
  ).json()) as { headless: { state: string }; tasks: unknown[] };
  assert.equal(snap.headless.state, "stopped");
  assert.equal(snap.tasks.length, 2);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
        headers: { Origin: "https://example.invalid" },
      })
    ).status,
    403,
  );
  const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
  assert(JSON.stringify(runs).includes("builder"));
  const image = await fetch(
    `http://127.0.0.1:${port}/api/evidence/artifacts/${artifact.artifactId}`,
  );
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/evidence/artifacts/not-an-id`))
      .status,
    404,
  );
  dashboard.kill("SIGTERM");
  await closed(dashboard);
  command("watchdog", "once");
  assert.equal(JSON.parse(command("watchdog", "status")).recovery, "none");
  // Simulate a dead supervisor's persisted running-without-child state and lease.
  const directory = join(root, ".crewplane-state/supervisor");
  const old = state();
  old.running = true;
  old.records.interrupted = {
    ...(Object.values(old.records)[0] as object),
    key: "interrupted",
    lane: "builder",
    task: "CP-101",
    cwd: firstSession.cwd,
    status: "running",
    pid: undefined,
  };
  writeFileSync(join(directory, "state.json"), JSON.stringify(old));
  const dead = spawnSync(bin, ["--version"], { env });
  assert.equal(dead.status, 0);
  writeFileSync(
    join(directory, "watcher.lock"),
    JSON.stringify({ pid: dead.pid, token: "synthetic-dead-owner" }),
  );
  const recovered = start("start");
  await until(
    () => state().running && state().records.interrupted?.status === "paused",
    "crash recovery fails closed",
  );
  assert.equal(state().records.interrupted.pauseKind, "failure");
  json("stop");
  await closed(recovered);
  assert.equal(json("status").desired.desiredRunning, false);
  assert(!existsSync(join(directory, "watcher.lock")));

  // Self-update acceptance: only a compiled binary replaces itself, and only
  // after the published checksum and executable header are verified.
  const updateDirectory = join(temp, "update");
  mkdirSync(updateDirectory, { recursive: true });
  const updateBin = join(updateDirectory, "crewplane");
  copyFileSync(bin, updateBin);
  const releaseEntry = join(temp, "release-version.ts");
  writeFileSync(releaseEntry, 'console.log("9.9.9");\n');
  const releasePayload = join(temp, "release-payload");
  const releaseBuild = await Bun.build({
    entrypoints: [releaseEntry],
    compile: { outfile: releasePayload },
  });
  assert(releaseBuild.success);
  const releaseBytes = readFileSync(releasePayload);
  const releaseOs = process.platform === "darwin" ? "macos" : "linux",
    releaseArch = process.arch === "x64" ? "x86_64" : "arm64",
    releaseAsset = `crewplane-v9.9.9-${releaseOs}-${releaseArch}`,
    releaseHash = createHash("sha256").update(releaseBytes).digest("hex");
  const releaseServer = createHttpServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/latest") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tag_name: "v9.9.9" }));
      return;
    }
    if (url === `/download/v9.9.9/${releaseAsset}`) {
      response.writeHead(200);
      response.end(releaseBytes);
      return;
    }
    if (url === `/download/v9.9.9/${releaseAsset}.sha256`) {
      response.writeHead(200);
      response.end(`${releaseHash}  ${releaseAsset}\n`);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  try {
    await new Promise<void>((done) =>
      releaseServer.listen(0, "127.0.0.1", done),
    );
    const { port } = releaseServer.address() as AddressInfo;
    const updateEnv = {
      ...env,
      CREWPLANE_RELEASE_API: `http://127.0.0.1:${port}/latest`,
      CREWPLANE_RELEASE_BASE: `http://127.0.0.1:${port}/download`,
      CREWPLANE_CACHE_DIR: join(temp, "update-cache"),
      CREWPLANE_NO_AUTO_UPDATE: "1",
      // The plain build is release-marked at runtime for this acceptance.
      CREWPLANE_RELEASE_BUILD: "1",
    };
    // Async execution keeps this process's release server responsive.
    const update = (args: string[]) =>
      new Promise<{ status: number; stdout: string; stderr: string }>((done) =>
        execFile(
          updateBin,
          args,
          { env: updateEnv, encoding: "utf8", timeout: 120000 },
          (error, stdout, stderr) => {
            const code =
              error && typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : error
                  ? 1
                  : 0;
            done({ status: code, stdout, stderr });
          },
        ),
      );
    const version = () => update(["--version"]);
    const checked = await update(["update", "--check"]);
    assert.equal(checked.status, 0, checked.stderr);
    const available = JSON.parse(checked.stdout) as {
      status: string;
      current: string;
      latest: string;
    };
    assert.equal(available.status, "available");
    assert.equal(available.current, pkg.version);
    assert.equal(available.latest, "9.9.9");
    assert.equal((await version()).stdout.trim(), pkg.version);

    const updated = await update(["update"]);
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(
      (JSON.parse(updated.stdout) as { status: string }).status,
      "updated",
    );
    assert.equal(readFileSync(updateBin).equals(releaseBytes), true);
    assert.notEqual(statSync(updateBin).mode & 0o111, 0);
    assert.equal((await version()).stdout.trim(), "9.9.9");

    // A plain project command must schedule the detached updater, which then
    // replaces the stale binary without the foreground command waiting.
    const autoBin = join(updateDirectory, "auto", "crewplane");
    mkdirSync(join(updateDirectory, "auto"), { recursive: true });
    copyFileSync(bin, autoBin);
    const autoEnv = {
      ...env,
      CREWPLANE_RELEASE_API: updateEnv.CREWPLANE_RELEASE_API,
      CREWPLANE_RELEASE_BASE: updateEnv.CREWPLANE_RELEASE_BASE,
      CREWPLANE_CACHE_DIR: join(temp, "auto-cache"),
      CREWPLANE_RELEASE_BUILD: "1",
      CREWPLANE_NO_AUTO_UPDATE: "",
    };
    // A project .env must not be able to disable or redirect the updater.
    const dotenvDirectory = join(temp, "dotenv-project");
    mkdirSync(dotenvDirectory, { recursive: true });
    writeFileSync(
      join(dotenvDirectory, ".env"),
      "CREWPLANE_NO_AUTO_UPDATE=1\n",
    );
    const ran = await new Promise<{ status: number; stderr: string }>((done) =>
      execFile(
        autoBin,
        ["--project", root, "status"],
        {
          env: autoEnv,
          cwd: dotenvDirectory,
          encoding: "utf8",
          timeout: 30000,
        },
        (error, _stdout, stderr) =>
          done({
            status: error
              ? typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : 1
              : 0,
            stderr,
          }),
      ),
    );
    assert.equal(ran.status, 0, ran.stderr);
    const replaced = () => {
      try {
        return readFileSync(autoBin).equals(releaseBytes);
      } catch {
        return false;
      }
    };
    await until(replaced, "detached automatic update replaces the executable");
    const autoVersion = await new Promise<string>((done) => {
      execFile(
        autoBin,
        ["--version"],
        { env: autoEnv, encoding: "utf8", timeout: 120000 },
        (_error, stdout) => done(stdout.trim()),
      );
    });
    assert.equal(autoVersion, "9.9.9");
  } finally {
    await new Promise<void>((done) => releaseServer.close(() => done()));
  }

  console.log(
    "Standalone acceptance passed: no Node/Bun on PATH; two worktrees, messages, pinned review, author correction/session reuse, linear integration, embedded assets/traces, intentional stop, crash recovery and checksum-verified self-update.",
  );
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  await Promise.all(
    children.map((child) => closed(child).catch(() => child.kill("SIGKILL"))),
  );
  rmSync(temp, { recursive: true, force: true });
}
