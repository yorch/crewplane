import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { controlDirectory, ensureControlDirectory } from "../src/control.ts";
import { main as coordination } from "../src/engine/agents.mjs";
import { createDashboard, newSessionToken } from "../src/engine/dashboard.ts";
import { createTraceStore } from "../src/engine/operational-traces.ts";

// UI tests only: operator controls in a real browser against the real HTTP
// server. A fake supervisor stands in for the process that consumes commands
// and records the outcome the test chooses in state.controlLog, exactly where
// the real one does. These tests prove what the page renders, sends and
// reconciles; they say nothing about what a supervisor applies. The real
// supervisor is exercised by src/engine/dashboard-controls-verbs.test.ts and
// src/engine/supervisor-revision.test.ts, and the real CLI by
// tests/dashboard-controls-cli-parity.test.ts.
const previousState = process.env.CREWPLANE_STATE_DIR;
const stateBase = mkdtempSync(join(tmpdir(), "crewplane-controls-ui-state-"));
process.env.CREWPLANE_STATE_DIR = stateBase;
// Updater caches and supervisor registrations stay out of the real home too.
const previousCache = process.env.CREWPLANE_CACHE_DIR;
process.env.CREWPLANE_CACHE_DIR = join(stateBase, "cache");
const run = "1794100000001-00000000-0000-4000-8000-000000000001";
const decision = "00000000-0000-4000-8000-0000000000d1";
const session = newSessionToken();
const controls = { token: "33333333-3333-4333-8333-333333333333" };
let browser: Browser;
let root = "";
let dir = "";
let withControls: ReturnType<typeof createDashboard>;
let readOnly: ReturnType<typeof createDashboard>;
let on = "";
let off = "";
let ticker: ReturnType<typeof setInterval> | undefined;
let nextOutcome = { outcome: "applied", code: "RELEASED" };
const seen: Array<{ action: string; body: Record<string, unknown> }> = [];

const record = (lane: string, task: string, extra: object) => ({
  key: `${lane}:${task}`,
  lane,
  task,
  cwd: root,
  harness: "codex",
  status: "paused",
  reason: "x",
  seen: [],
  runs: [],
  noProgress: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...extra,
});
const state = () => ({
  version: 2,
  running: true,
  checkedAt: new Date().toISOString(),
  pid: process.pid,
  generation: "gen-ui",
  draining: false,
  held: ["reviewer"],
  commands: [] as string[],
  notices: {},
  laneRev: { builder: 4, reviewer: 2, worker: 1, runner: 7 },
  controlSeq: 0,
  controlLog: [] as unknown[],
  records: {
    "builder:CP-101": record("builder", "CP-101", {
      pauseKind: "decision",
      pauseId: decision,
      sessionId: "sess_builder",
    }),
    "worker:CP-201": record("worker", "CP-201", {
      pauseKind: "failure",
      sessionId: "sess_worker",
      runId: "1794100000009-00000000-0000-4000-8000-000000000009",
    }),
    "runner:CP-301": record("runner", "CP-301", {
      status: "running",
      pid: process.pid,
      runId: run,
    }),
  },
});
const stateFile = () => join(dir, "state.json");
const load = () =>
  JSON.parse(readFileSync(stateFile(), "utf8")) as ReturnType<typeof state>;
const save = (value: unknown) =>
  writeFileSync(stateFile(), JSON.stringify(value), { mode: 0o600 });

/** Records one outcome per queued command, like the supervisor does. */
function fakeSupervisor() {
  const commands = join(dir, "commands");
  for (const name of readdirSync(commands)) {
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(join(commands, name), "utf8"));
    seen.push({ action: value.action, body: value });
    const current = load();
    current.controlSeq += 1;
    current.controlLog.push({
      id: name.replace(/\.json$/, ""),
      seq: current.controlSeq,
      action: value.action,
      scope: value.run ? "run" : value.lane ? "lane" : "instance",
      target: value.run ?? value.lane ?? null,
      outcome: nextOutcome.outcome,
      code: nextOutcome.code,
      at: new Date().toISOString(),
      issuer: "dashboard",
    });
    current.commands.push(name);
    save(current);
    unlinkSync(join(commands, name));
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-controls-ui-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-qm", "test: seed");
  await coordination(["init"], root);
  const traces = await createTraceStore(
    join(root, ".crewplane-state/operational-traces"),
  );
  const writer = await traces.begin({
    runId: run,
    lane: "runner",
    task: "CP-301",
    harness: "codex",
  });
  await writer.emit({ kind: "started" });
  dir = controlDirectory(root);
  await ensureControlDirectory(dir);
  mkdirSync(join(dir, "commands"), { recursive: true, mode: 0o700 });
  const lane = { enabled: true, harness: "codex" };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      version: 1,
      root,
      binary: process.execPath,
      allowedTasks: [],
      maxParallel: 2,
      intervalSeconds: 10,
      maxRunMinutes: 10,
      maxRunsPerHour: 10,
      lanes: { builder: lane, reviewer: lane, worker: lane, runner: lane },
    }),
  );
  save(state());
  withControls = createDashboard(root, {
    session: { token: session },
    controls,
    live: { intervalMs: 200 },
  });
  readOnly = createDashboard(root, { session: { token: session } });
  for (const server of [withControls, readOnly])
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  on = `http://127.0.0.1:${(withControls.address() as AddressInfo).port}/`;
  off = `http://127.0.0.1:${(readOnly.address() as AddressInfo).port}/`;
  ticker = setInterval(fakeSupervisor, 80);
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  if (ticker) clearInterval(ticker);
  await browser?.close();
  for (const server of [withControls, readOnly])
    await new Promise<void>((done) => server?.close(() => done()));
  rmSync(root, { recursive: true, force: true });
  rmSync(stateBase, { recursive: true, force: true });
  if (previousState === undefined) delete process.env.CREWPLANE_STATE_DIR;
  else process.env.CREWPLANE_STATE_DIR = previousState;
  if (previousCache === undefined) delete process.env.CREWPLANE_CACHE_DIR;
  else process.env.CREWPLANE_CACHE_DIR = previousCache;
});

async function open(base: string, fragment: string, view?: string) {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  const errors: string[] = [];
  const posts: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await page.goto(`${base}#${fragment}`);
  await page.locator("#loading").waitFor({ state: "hidden", timeout: 15000 });
  if (view) await go(page, view);
  return { page, errors, posts };
}
async function go(page: Page, hash: string) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}
const agentHash = (lane: string) => `/agents?agent=${lane}`;
const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

it("adds no controls UI, token handling or requests without server support", async () => {
  const { page, errors, posts } = await open(
    off,
    `token=${session}`,
    agentHash("builder"),
  );
  await page.locator("#agent-detail h2").waitFor();
  expect(
    await page.locator(".control-button, dialog, #control-feedback").count(),
  ).toBe(0);
  expect(await page.locator(".sidebar-foot").textContent()).toBe(
    "Read-only · local only",
  );
  expect(posts).toEqual([]);
  expect(errors).toEqual([]);
  await page.close();
});

it("stays read-only when the page was opened without the controls token", async () => {
  const { page, posts } = await open(
    on,
    `token=${session}`,
    agentHash("builder"),
  );
  await page.locator("#agent-detail h2").waitFor();
  await page
    .locator(".sidebar-foot")
    .getByText(/open the controls URL/)
    .waitFor();
  expect(await page.locator(".control-button").count()).toBe(0);
  expect(posts).toEqual([]);
  await page.close();
});

it("keeps the controls token out of the address bar, history and DOM", async () => {
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
  );
  expect(page.url()).not.toContain(controls.token);
  expect(page.url()).not.toContain(session);
  expect(await page.content()).not.toContain(controls.token);
  await page.close();
});

it("offers only the verbs that apply to each agent", async () => {
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("builder"),
  );
  await button(page, "Pause").waitFor();
  expect(await button(page, "Resume").count()).toBe(0);
  expect(await button(page, "Approve (CP-101)").count()).toBe(0);
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await page.getByRole("button", { name: "Deny", exact: true }).waitFor();
  await go(page, agentHash("reviewer"));
  await button(page, "Resume").waitFor();
  expect(await button(page, "Pause").count()).toBe(0);
  await go(page, agentHash("worker"));
  await button(page, "Retry").first().waitFor();
  await button(page, "Retry with new session").waitFor();
  await go(page, agentHash("runner"));
  await button(page, "Cancel run").waitFor();
  expect(await button(page, "Approve").count()).toBe(0);
  await page.close();
});

it("says on Overview, Agents and System that an instance hold is lifted from the CLI, with a copyable command", async () => {
  const before = load();
  save({ ...before, instanceHeld: true });
  try {
    // Read-only and controls-enabled pages both say it: lifting is CLI-only.
    for (const [base, fragment] of [
      [off, `token=${session}`],
      [on, `token=${session}&controls=${controls.token}`],
    ] as const) {
      const { page, errors, posts } = await open(base, fragment);
      for (const view of ["/", "/agents", "/system"]) {
        await go(page, view);
        const hint = page.locator(
          `#view-${view === "/" ? "overview" : view.slice(1)} .instance-hold`,
        );
        await hint.waitFor({ timeout: 15000 });
        expect(await hint.locator("code").textContent()).toBe(
          "crewplane resume --all true",
        );
        expect(await hint.textContent()).toContain("cannot lift it");
        await hint.getByRole("button", { name: "Copy command" }).click();
        await hint
          .locator("[role=status]")
          .getByText(/Copied|copy it/)
          .waitFor();
      }
      expect(posts).toEqual([]);
      expect(errors).toEqual([]);
      await page.close();
    }
    // Without a hold there is no hint.
    save({ ...before, instanceHeld: false });
    const { page } = await open(off, `token=${session}`, "/agents");
    await page
      .locator("#agent-count")
      .getByText(/agents/)
      .waitFor();
    expect(await page.locator(".instance-hold").count()).toBe(0);
    await page.close();
  } finally {
    save(before);
  }
});

it("shows decisions on Overview and Messages", async () => {
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
  );
  await page.locator("#attention .decision-block").waitFor();
  await page
    .locator("#attention")
    .getByRole("button", { name: /Approve/ })
    .waitFor();
  await go(page, "/messages");
  await page.locator("#questions .decision-block").waitFor();
  await page.close();
});

it("confirms in an accessible dialog, requires the note and returns focus", async () => {
  const { page, posts } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("builder"),
  );
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await approve.focus();
  await approve.press("Enter");
  const dialog = page.locator("dialog.control-dialog");
  await dialog.waitFor({ state: "visible" });
  expect(await dialog.getAttribute("aria-labelledby")).toBe("control-title");
  expect(await page.locator("#control-title").textContent()).toBe("Approve");
  expect(await page.locator("#control-effect").textContent()).toContain(
    "revision 4",
  );
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "control-note",
  );
  // 44px touch targets
  for (const control of await dialog.locator("button, textarea").all()) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  // Focus never leaves the dialog while tabbing in either direction.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  // Note is required: refused locally, nothing sent.
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .locator("#control-error")
    .getByText("A note is required")
    .waitFor();
  expect(posts).toEqual([]);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
    "Approve",
  );
  await page.close();
});

it("queues, then shows the recorded outcome with its reason", async () => {
  nextOutcome = { outcome: "applied", code: "APPROVED" };
  seen.length = 0;
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("builder"),
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.locator("#control-note").fill("looks right <b>to me</b>");
  // Hold the supervisor back so the Queued state is observable.
  const hold = ticker;
  clearInterval(hold);
  ticker = undefined;
  await page
    .locator("dialog")
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  const feedback = page.locator("#control-feedback");
  await feedback.getByText(/^Queued: Approve/).waitFor();
  expect(await feedback.textContent()).toContain("Waiting for the supervisor");
  ticker = setInterval(fakeSupervisor, 80);
  await feedback
    .getByText(/Applied: The decision was approved/)
    .waitFor({ timeout: 15000 });
  expect(await feedback.textContent()).toContain("(APPROVED)");
  const sent = seen.at(-1)?.body as Record<string, unknown>;
  expect(sent).toMatchObject({
    action: "resolve",
    lane: "builder",
    task: "CP-101",
    resolution: "approve",
    pauseId: decision,
    expectRev: 4,
    issuer: "dashboard",
    text: "looks right <b>to me</b>",
  });
  expect(await feedback.locator("b").count()).toBe(0);
  await page.close();
});

it("explains stale and refused outcomes in plain language", async () => {
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("worker"),
  );
  nextOutcome = { outcome: "stale", code: "STALE_REVISION" };
  await button(page, "Retry with new session").click();
  await page.locator("#control-note").fill("stuck");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Retry with new session" })
    .click();
  await page
    .locator("#control-feedback")
    .getByText(/The agent changed after you opened this/)
    .waitFor({ timeout: 15000 });
  nextOutcome = { outcome: "refused", code: "RUN_NOT_ACTIVE" };
  await go(page, agentHash("runner"));
  await button(page, "Cancel run").click();
  const dialog = page.locator("dialog");
  // Destructive: typed confirmation, not just a click.
  await dialog.getByRole("button", { name: "Cancel run" }).click();
  await page
    .locator("#control-error")
    .getByText("Type runner to confirm")
    .waitFor();
  await page.locator("#control-typed").fill("runner");
  await dialog.getByRole("button", { name: "Cancel run" }).click();
  await page
    .locator("#control-feedback")
    .getByText(/no longer active, so there was nothing to cancel/)
    .waitFor({ timeout: 15000 });
  await page.close();
});

it("requires the explicit acknowledgement for confirm-cleanup and a long note is bounded", async () => {
  const value = load();
  value.records["worker:CP-201"] = record("worker", "CP-201", {
    cleanupUnverified: true,
    runId: "1794100000009-00000000-0000-4000-8000-000000000009",
    sessionId: "sess_worker",
  });
  save(value);
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("worker"),
  );
  await button(page, "Confirm cleanup and retry").click();
  await page.locator("#control-note").fill("inspected");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Confirm cleanup and retry" })
    .click();
  await page
    .locator("#control-error")
    .getByText(/Confirm the statement/)
    .waitFor();
  expect(await page.locator("#control-ack").getAttribute("aria-invalid")).toBe(
    "true",
  );
  expect(await page.locator("#control-note").getAttribute("maxlength")).toBe(
    "2000",
  );
  await page.close();
});

it("offers Cancel run in the Runs view and Stop in System with strong confirmation", async () => {
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    `/runs?run=${run}`,
  );
  await page
    .locator("#run-actions")
    .getByRole("button", { name: "Cancel run" })
    .waitFor({ timeout: 15000 });
  await go(page, "/system");
  const stop = page.getByRole("button", { name: "Stop supervisor" });
  await stop.waitFor();
  await stop.click();
  expect(await page.locator("#control-effect").textContent()).toContain(
    "stays stopped",
  );
  await page
    .locator("dialog")
    .getByRole("button", { name: "Stop supervisor" })
    .click();
  await page
    .locator("#control-error")
    .getByText("Type stop to confirm")
    .waitFor();
  await page.keyboard.press("Escape");
  await page.close();
});

it("renders hostile persisted text as text", async () => {
  const value = load();
  value.records["worker:CP-201"] = record("worker", "CP-201", {
    pauseKind: "<img src=x onerror=window.pwned=1>",
    sessionId: "sess_worker",
  });
  save(value);
  const { page, errors } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("worker"),
  );
  await page
    .locator(".control-task")
    .getByText(/<img src=x/)
    .waitFor();
  expect(await page.locator("#agent-detail img").count()).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
  expect(errors).toEqual([]);
  await page.close();
});

it("reuses one request id after a network failure, so a resubmit queues once", async () => {
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("builder"),
  );
  // Hold the supervisor back so the first command stays pending.
  clearInterval(ticker);
  ticker = undefined;
  const commands = join(dir, "commands");
  const pending = () =>
    readdirSync(commands).filter((n) => n.endsWith(".json"));
  for (const name of pending()) unlinkSync(join(commands, name));
  const sentIds: string[] = [];
  let failures = 1;
  await page.route("**/api/control", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    sentIds.push(body.requestId);
    if (failures-- > 0) {
      // The server gets it; the answer never reaches the page.
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  try {
    await button(page, "Nudge").click();
    await page.locator("#control-note").fill("look again");
    const dialog = page.locator("dialog");
    await dialog.getByRole("button", { name: "Nudge", exact: true }).click();
    await page
      .locator("#control-error")
      .getByText(/The request may not have been queued/)
      .waitFor();
    // The dialog stays open and nothing was recorded, so a retry is offered.
    expect(await dialog.isVisible()).toBe(true);
    expect(pending()).toHaveLength(1);
    const answer = page.waitForResponse(
      (r) => r.url().endsWith("/api/control") && r.status() === 200,
    );
    await dialog.getByRole("button", { name: "Nudge", exact: true }).click();
    expect(((await (await answer).json()) as { replay?: boolean }).replay).toBe(
      true,
    );
    expect(sentIds).toHaveLength(2);
    expect(sentIds[0]).toBe(sentIds[1]);
    expect(sentIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(pending()).toHaveLength(1);
  } finally {
    await page.unroute("**/api/control");
    ticker = setInterval(fakeSupervisor, 80);
    await page.close();
  }
});

it("checks the control log after a network failure and does not offer a second attempt when it was recorded", async () => {
  nextOutcome = { outcome: "applied", code: "NOTICE_QUEUED" };
  const { page } = await open(
    on,
    `token=${session}&controls=${controls.token}`,
    agentHash("builder"),
  );
  let posts = 0;
  await page.route("**/api/control", async (route) => {
    posts += 1;
    // Queued, and the supervisor records it, but the answer is lost.
    await route.fetch();
    await page.waitForTimeout(500);
    await route.abort("connectionreset");
  });
  try {
    await button(page, "Nudge").click();
    await page.locator("#control-note").fill("recorded anyway");
    await page
      .locator("dialog")
      .getByRole("button", { name: "Nudge", exact: true })
      .click();
    await page
      .locator("#control-feedback")
      .getByText(/Applied: The note was queued/)
      .waitFor({ timeout: 15000 });
    expect(await page.locator("dialog").isVisible()).toBe(false);
    expect(posts).toBe(1);
  } finally {
    await page.unroute("**/api/control");
    await page.close();
  }
});
