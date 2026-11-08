import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTraceStore } from "../src/engine/operational-traces.ts";

const bin = resolve("dist/crewplane");
const runId = "1794100000001-00000000-0000-4000-8000-000000000001";
const views = [
  "overview",
  "tasks",
  "agents",
  "messages",
  "runs",
  "relationships",
  "system",
];
let root = "";
let base = "";
let browser: Browser;
let child: ChildProcess | undefined;
let answeredQuestion = "";
let openQuestion = "";
const cli = (...args: string[]) =>
  execFileSync(bin, ["--project", root, ...args], { encoding: "utf8" });
const agents = (...args: string[]) =>
  JSON.parse(cli("agents", ...args)) as { id: string };

beforeAll(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "crewplane-dashboard-browser-")),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  cli("init");
  await writeFile(
    join(root, "crewplane.json"),
    JSON.stringify({
      version: 1,
      coordinator: "captain",
      reviewers: ["inspector"],
      tasksPath: "tickets",
    }),
  );
  await writeFile(join(root, "STATUS.md"), "Synthetic milestone M1 open\n");
  await mkdir(join(root, "tickets"));
  const cards: [string, string, string, string][] = [
    ["WEB-1", "custom-builder", "alpha", "Render the synthetic widget"],
    ["WEB-2", "captain", "alpha", "Resolve the synthetic blocker"],
    ["WEB-3", "custom-builder", "beta", "Plan the unassigned synthetic work"],
  ];
  for (const [id, owner, phase, goal] of cards)
    await writeFile(
      join(root, `tickets/${id}.md`),
      `# ${id} — ${goal}\nOwner: ${owner}.\nPhase: ${phase}\nGoal: ${goal}\n`,
    );
  git("add", ".");
  git("commit", "-qm", "test: initialize dashboard browser fixture");
  const configFile = join(root, "runtime.json");
  await writeFile(
    configFile,
    JSON.stringify({
      version: 1,
      root,
      binary: bin,
      allowedTasks: ["WEB-1", "WEB-2", "WEB-3"],
      maxParallel: 2,
      intervalSeconds: 5,
      maxRunMinutes: 10,
      maxRunsPerHour: 6,
      confirmedStoppedAt: new Date().toISOString(),
      lanes: {
        captain: { enabled: false },
        "custom-builder": { enabled: true, model: "configured-synth-model" },
      },
    }),
  );
  cli("configure", "--file", configFile);
  for (const [task, owner] of [
    ["WEB-1", "custom-builder"],
    ["WEB-2", "captain"],
  ] as const)
    agents(
      "assign",
      "--agent",
      "captain",
      "--task",
      task,
      "--owner",
      owner,
      "--ref",
      "HEAD",
      "--text",
      `Synthetic brief for ${task}`,
    );
  agents("claim", "--agent", "captain", "--task", "WEB-2");
  agents(
    "status",
    "--agent",
    "captain",
    "--task",
    "WEB-2",
    "--state",
    "blocked",
    "--text",
    "Synthetic blocker needs a decision",
  );
  answeredQuestion = agents(
    "send",
    "--agent",
    "custom-builder",
    "--to",
    "captain",
    "--kind",
    "question",
    "--task",
    "WEB-1",
    "--text",
    "Which synthetic API applies?",
  ).id;
  agents(
    "send",
    "--agent",
    "captain",
    "--to",
    "custom-builder",
    "--kind",
    "answer",
    "--reply-to",
    answeredQuestion,
    "--task",
    "WEB-1",
    "--text",
    "Use the synthetic read API.",
  );
  openQuestion = agents(
    "send",
    "--agent",
    "custom-builder",
    "--to",
    "captain",
    "--kind",
    "question",
    "--task",
    "WEB-1",
    "--text",
    "Open synthetic decision needed",
  ).id;
  agents(
    "send",
    "--agent",
    "captain",
    "--to",
    "all",
    "--kind",
    "update",
    "--text",
    "<img src=x onerror=window.pwned=true>",
  );
  const traces = await createTraceStore(
    join(root, ".crewplane-state/operational-traces"),
  );
  const writer = await traces.begin({
    runId,
    lane: "custom-builder",
    task: "WEB-1",
    harness: "codex",
  });
  await writer.emit({ kind: "started" });
  await writer.emit({ kind: "tool-start", tool: "read", status: "running" });
  await writer.finish("finished", "waiting");
  // A persisted observation with a real observed model; no process is started.
  await mkdir(join(root, ".crewplane-state/supervisor"), { recursive: true });
  await writeFile(
    join(root, ".crewplane-state/supervisor/state.json"),
    JSON.stringify({
      version: 1,
      running: false,
      checkedAt: new Date().toISOString(),
      pid: 1,
      draining: false,
      held: [],
      commands: [],
      notices: {},
      records: {
        "custom-builder:WEB-1": {
          key: "custom-builder:WEB-1",
          lane: "custom-builder",
          task: "WEB-1",
          cwd: root,
          harness: "codex",
          observedModel: "observed-synth-model",
          status: "idle",
          reason: "Synthetic idle observation",
          seen: [],
          runs: [],
          noProgress: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
    }),
  );
  const port = await new Promise<number>((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        done(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
  base = `http://127.0.0.1:${port}/`;
  child = spawn(bin, ["--project", root, "dashboard", "--port", String(port)], {
    stdio: "pipe",
  });
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((done) =>
      child?.once("exit", () => done()),
    );
    child.kill("SIGTERM");
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}, 30000);

async function open(hash = "", width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security/.test(message.text()))
      errors.push(message.text());
  });
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      await page.goto(`${base}${hash}`);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  await page.locator("#connection").filter({ hasText: "Live" }).waitFor();
  return { page, errors };
}
const title = (page: Page, text: string) =>
  page.locator("#view-title").filter({ hasText: text }).waitFor();
const hash = (page: Page) => page.evaluate(() => window.location.hash);
const noOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
const visibleCards = (page: Page) =>
  page
    .locator("#tasks .card")
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-task-id")),
    );
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

it("routes deep links, active state, back/forward, refresh and bad hashes", async () => {
  const { page, errors } = await open("#/tasks?state=blocked");
  await title(page, "Tasks");
  await page.locator('#tasks .card[data-task-id="WEB-2"]').waitFor();
  expect(await visibleCards(page)).toEqual(["WEB-2"]);
  expect(await page.locator("#state").inputValue()).toBe("blocked");
  expect(
    await page.locator('a[data-nav="tasks"]').getAttribute("aria-current"),
  ).toBe("page");
  expect(await page.title()).toContain("Tasks");
  expect(await page.locator("#view-overview").isVisible()).toBe(false);

  await page.locator('a[data-nav="overview"]').click();
  await title(page, "Overview");
  expect(await hash(page)).toBe("#/overview");
  // Sidebar links remember filters without recreating the drill-down.
  expect(await page.locator('a[data-nav="tasks"]').getAttribute("href")).toBe(
    "#/tasks?state=blocked",
  );
  await page.goBack();
  await title(page, "Tasks");
  expect(await page.locator("#state").inputValue()).toBe("blocked");
  await page.goForward();
  await title(page, "Overview");
  await page.goBack();
  await title(page, "Tasks");

  await page.reload();
  await page.locator('#tasks .card[data-task-id="WEB-2"]').waitFor();
  expect(await visibleCards(page)).toEqual(["WEB-2"]);

  for (const bad of ["#/nope", "#/__proto__", "#main", "#/tasks?q=%E0%A4%A"]) {
    await page.goto(`${base}${bad}`);
    await page.locator("#view-title").waitFor();
  }
  await title(page, "Tasks");
  expect(await hash(page)).toBe("#/tasks?q=%E0%A4%A");
  await page.goto(`${base}#/nope`);
  await title(page, "Overview");
  expect(await hash(page)).toBe("#/overview");
  expect(errors).toEqual([]);
  await page.close();
}, 45000);

it("cross-navigates from overview metrics through threads, tasks, agents and runs", async () => {
  const { page, errors } = await open("#/overview");
  await title(page, "Overview");
  await page.locator('#attention a:has-text("WEB-2")').first().waitFor();
  await page.locator('a.metric[href="#/messages?filter=open"]').click();
  await title(page, "Messages");
  const openRow = page.locator(`[data-message-id="${openQuestion}"]`);
  await openRow.waitFor();
  expect(
    await page.locator(`[data-message-id="${answeredQuestion}"]`).count(),
  ).toBe(0);
  await openRow.click();
  await page
    .locator("#thread-detail")
    .filter({ hasText: "Open synthetic decision needed" })
    .waitFor();

  await page.goto(`${base}#/messages?filter=all&thread=${answeredQuestion}`);
  const thread = page.locator("#thread-detail");
  await thread.filter({ hasText: "Use the synthetic read API." }).waitFor();
  expect(await thread.textContent()).toContain("Which synthetic API applies?");
  await page.locator(`#message-${answeredQuestion}`).waitFor();

  await thread.locator('a[href="#/tasks?task=WEB-1"]').click();
  await title(page, "Tasks");
  const detail = page.locator("#task-detail");
  await detail.filter({ hasText: "Render the synthetic widget" }).waitFor();
  await detail.locator('a[data-agent-link="custom-builder"]').first().click();
  await title(page, "Agents");
  await page
    .locator("#agent-detail")
    .filter({ hasText: "custom-builder" })
    .waitFor();

  await page.goto(`${base}#/tasks?task=WEB-1`);
  await detail.locator('a[href="#/runs?task=WEB-1"]').click();
  await title(page, "Runs");
  expect(await page.locator("#run-task").inputValue()).toBe("WEB-1");
  await page.locator(`[data-run-id="${runId}"]`).waitFor();
  const events = page.locator("#run-events");
  await events.filter({ hasText: "Native run started" }).waitFor();
  expect(await page.locator("#view-runs").textContent()).toContain(
    "Raw stdout/stderr, private reasoning and unclassified model/tool text are omitted",
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  await page.locator("#run-copy").click();
  const copied = await page.evaluate(
    () => (window as unknown as { copied?: string }).copied ?? "",
  );
  expect(copied).toContain("Native run started");
  expect(copied).toContain("· read");
  expect(errors).toEqual([]);
  await page.close();
}, 45000);

it("filters tasks, opens drill-down, and keeps configured and observed models distinct", async () => {
  const { page, errors } = await open("#/tasks");
  await title(page, "Tasks");
  await page.locator("#tasks .card").first().waitFor();
  expect(await visibleCards(page)).toEqual(["WEB-3", "WEB-1", "WEB-2"]);
  await page.locator("#agent").selectOption("custom-builder");
  expect((await visibleCards(page)).sort()).toEqual(["WEB-1", "WEB-3"]);
  expect(await hash(page)).toContain("agent=custom-builder");
  await page.locator("#search").fill("unassigned");
  expect(await visibleCards(page)).toEqual(["WEB-3"]);
  expect(await page.locator("#task-count").textContent()).toBe("1 of 3 tasks");
  await page.locator("#search").fill("no-such-synthetic-task");
  await page
    .locator("#tasks")
    .filter({ hasText: "No tasks match these filters." })
    .waitFor();
  await page.locator("#tasks-clear").click();
  expect((await visibleCards(page)).length).toBe(3);
  expect(await page.locator("#agent").inputValue()).toBe("");

  await page.locator("#layout-list").click();
  expect(await page.locator("#tasks.is-list").count()).toBe(1);
  await page.locator("#layout-board").click();
  await page.locator('#tasks .card[data-task-id="WEB-2"] .card-link').click();
  const detail = page.locator("#task-detail");
  await detail
    .filter({ hasText: "Synthetic blocker needs a decision" })
    .waitFor();
  expect(await hash(page)).toContain("task=WEB-2");
  await page.goBack();
  await until(async () => !(await detail.isVisible()), "detail closes on back");

  await page.goto(`${base}#/agents`);
  await title(page, "Agents");
  const builder = page.locator('[data-lane="custom-builder"]').last();
  await builder.waitFor();
  const text = (field: string, row = builder) =>
    row.locator(`[data-field="${field}"]`).first().textContent();
  expect(await text("configured-model")).toContain("configured-synth-model");
  expect(await text("configured-model")).toContain("Configured");
  expect(await text("observed-model")).toContain("observed-synth-model");
  expect(await text("observed-model")).toContain("Observed");
  const captain = page.locator('[data-lane="captain"]').last();
  expect(await text("observed-model", captain)).toContain("Not recorded");
  expect(await builder.textContent()).toContain("Idle");
  expect(await builder.textContent()).toContain("Assigned");
  await builder.locator(".agent-name").click();
  const agentDetail = page.locator("#agent-detail");
  await agentDetail.filter({ hasText: "Recorded usage" }).waitFor();
  expect(await agentDetail.textContent()).toContain("not billing totals");
  expect(await agentDetail.textContent()).toContain("unknown");
  expect(errors).toEqual([]);
  await page.close();
}, 45000);

it("fits every breakpoint and offers a usable compact navigation", async () => {
  const { page, errors } = await open("#/overview");
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of views) {
      await page.goto(`${base}#/${view}`);
      await page.locator(`#view-${view}`).waitFor();
      expect(await noOverflow(page)).toBe(true);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}#/overview`);
  await page.locator("#view-overview").waitFor();
  const agentsLink = page.locator('a[data-nav="agents"]');
  expect(await agentsLink.isVisible()).toBe(false);
  await page.locator("#nav-toggle").click();
  expect(await page.locator("#nav-toggle").getAttribute("aria-expanded")).toBe(
    "true",
  );
  await agentsLink.click();
  await title(page, "Agents");
  expect(await agentsLink.isVisible()).toBe(false);
  await page.goto(`${base}#/tasks`);
  await page.locator("#view-tasks").waitFor();
  await page.locator('#tasks .card[data-task-id="WEB-1"] .card-link').click();
  const detail = page.locator("#task-detail");
  await detail.locator("h2").waitFor();
  expect(await page.locator("#tasks").isVisible()).toBe(false);
  expect(await noOverflow(page)).toBe(true);
  await detail.locator("[data-close-detail]").click();
  await page.locator('#tasks .card[data-task-id="WEB-1"]').waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 60000);

it("preserves filters, focus and disclosure across polls and reports staleness", async () => {
  const { page, errors } = await open("#/tasks?task=WEB-1&q=synthetic");
  await title(page, "Tasks");
  const pane = page.locator("#task-detail");
  await pane.locator("details.disclosure > summary").first().click();
  const openCount = () => pane.locator("details[open]").count();
  expect(await openCount()).toBe(1);
  await page.locator("#search").focus();
  agents(
    "send",
    "--agent",
    "captain",
    "--to",
    "all",
    "--kind",
    "update",
    "--text",
    "Poll trigger synthetic update",
  );
  await page.waitForTimeout(5500);
  expect(await page.locator("#search").inputValue()).toBe("synthetic");
  expect(
    await page
      .locator("#search")
      .evaluate((node) => document.activeElement === node),
  ).toBe(true);
  expect(await openCount()).toBe(1);
  expect(await hash(page)).toContain("q=synthetic");
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);

  await page.goto(`${base}#/messages?filter=all`);
  const hostile = page
    .locator("#messages")
    .filter({ hasText: "<img src=x onerror=window.pwned=true>" });
  await hostile.waitFor();
  expect(await page.locator("#messages img").count()).toBe(0);
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);

  await page.route("**/api/snapshot", (route) => route.abort());
  await page.locator("#refresh").click();
  await page
    .locator("#connection")
    .filter({ hasText: "Disconnected" })
    .waitFor();
  const banner = page.locator("#error");
  await banner.filter({ hasText: "Showing the last snapshot" }).waitFor();
  expect(await hostile.isVisible()).toBe(true);
  await page.unroute("**/api/snapshot");
  await page.locator("#refresh").click();
  await page.locator("#connection").filter({ hasText: "Live" }).waitFor();
  expect(await banner.isVisible()).toBe(false);
  expect(errors).toEqual([]);
  await page.close();
}, 45000);

it("pages retained runs beyond two pages and keeps incremental events unique during polling", async () => {
  const { page, errors } = await open();
  const ids = Array.from(
    { length: 41 },
    (_, i) => `${1794100000100 - i}-00000000-0000-4000-8000-000000000001`,
  );
  const requests: string[] = [];
  let tailRequests = 0;
  await page.route("**/api/runs**", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.slice("/api/runs/".length);
    const meta = (runId: string) => ({
      version: 1,
      runId,
      lane: "custom-builder",
      task: "WEB-1",
      harness: "codex",
      sessionId: null,
      startedAt: "2026-11-08T00:00:00Z",
      status: "finished",
      events: 1,
      bytes: 100,
      truncated: false,
      omitted: 0,
      finalState: "waiting",
    });
    if (url.pathname === "/api/runs") {
      const before = url.searchParams.get("before");
      requests.push(before ?? "latest");
      const start = before ? ids.indexOf(before) + 1 : 0;
      const rows = ids.slice(start, start + 20);
      await route.fulfill({
        json: {
          runs: rows.map(meta),
          nextCursor: rows.length === 20 ? rows.at(-1) : null,
          incomplete: false,
        },
      });
    } else {
      tailRequests++;
      const after = Number(url.searchParams.get("after") ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await route.fulfill({
        json: {
          meta: meta(id),
          events:
            after === 0
              ? [
                  {
                    sequence: 1,
                    at: "2026-11-08T00:00:01Z",
                    channel: "system",
                    kind: "finished",
                    message: "Synthetic run completed",
                    tool: null,
                    status: "finished",
                    model: null,
                    effort: null,
                    inputTokens: null,
                    outputTokens: null,
                    durationMs: null,
                  },
                ]
              : [],
          nextCursor: 1,
          incomplete: false,
        },
      });
    }
  });
  await page.locator('[data-nav="runs"]').click();
  await until(
    async () => (await page.locator("#run-history .run-row").count()) === 20,
    "first run page",
  );
  await page.locator("#run-more").click();
  await until(
    async () => (await page.locator("#run-history .run-row").count()) === 40,
    "second run page",
  );
  await page.locator("#run-more").click();
  await until(
    async () => (await page.locator("#run-history .run-row").count()) === 41,
    "third run page",
  );
  expect(requests).toContain(ids[19]);
  expect(requests).toContain(ids[39]);
  expect(await page.locator("#run-more").isDisabled()).toBe(true);
  await until(async () => tailRequests >= 2, "incremental tail poll");
  expect(await page.locator('#run-events [data-sequence="1"]').count()).toBe(1);
  expect(await page.locator("#run-events").textContent()).toContain(
    "Synthetic run completed",
  );
  expect(errors).toEqual([]);
  await page.close();
}, 30000);
