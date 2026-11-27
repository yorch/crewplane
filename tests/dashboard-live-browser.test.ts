import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { main as coordination } from "../src/engine/agents.mjs";
import { createDashboard, newSessionToken } from "../src/engine/dashboard.ts";

// Live-update behaviour that needs a real browser against a real HTTP server
// (source execution; tests/dashboard-browser.test.ts covers the compiled
// executable). Timings the page would otherwise take from a user (reconnect
// backoff, the hidden-tab grace period) are injected through
// window.crewplaneLiveTuning before the page script runs.
const bin = resolve("dist/crewplane");
let browser: Browser;
let root = "";
let base = "";
let token = "";
let server: ReturnType<typeof createDashboard>;
const cleanup: string[] = [];

const send = (text: string) =>
  coordination(
    [
      "send",
      "--agent",
      "captain",
      "--to",
      "all",
      "--kind",
      "update",
      "--text",
      text,
    ],
    root,
  );

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-live-browser-")));
  cleanup.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-qm", "test: seed");
  await coordination(["init"], root);
  await send("first synthetic message");
  token = newSessionToken();
  server = createDashboard(root, {
    session: { token },
    live: { intervalMs: 200 },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => {
    if (!server) return done();
    server.close(() => done());
  });
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

interface Tuning {
  backoffBaseMs?: number;
  backoffCapMs?: number;
  hiddenGraceMs?: number;
  hiddenPollMs?: number;
  stableMs?: number;
}
async function open(tuning: Tuning = {}, hash = "") {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  await page.addInitScript((value) => {
    (
      window as unknown as { crewplaneLiveTuning: unknown }
    ).crewplaneLiveTuning = value;
  }, tuning);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}#token=${token}`);
  if (hash) await page.goto(`${base}${hash}`);
  return { page, errors };
}
const mode = (page: Page) =>
  page.locator("#connection-wrap").getAttribute("data-mode");
const modeIs = (page: Page, value: string, timeout = 15000) =>
  page.locator(`#connection-wrap[data-mode="${value}"]`).waitFor({ timeout });
async function until(check: () => Promise<boolean>, label: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
const snapshotBody = async () =>
  (
    await fetch(`${base}api/snapshot`, {
      headers: { "x-crewplane-session": token },
    })
  ).text();

it("ignores a pushed snapshot older than the one already shown", async () => {
  // A poll answered before the stream's first event; the stream then carries
  // an earlier read of the board. "Checked" must not go back in time.
  const real = JSON.parse(await snapshotBody()) as Record<string, unknown>;
  const old = new Date(Date.parse(String(real.updatedAt)) - 3600_000);
  const stale = JSON.stringify({ ...real, updatedAt: old.toISOString() });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  let served = 0;
  await page.route("**/api/events", async (route) => {
    served += 1;
    if (served > 1) return route.abort();
    await new Promise((done) => setTimeout(done, 1500));
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `retry: 60000\n\nid: aaaaaaaa-1\nevent: snapshot\ndata: ${stale}\n\n`,
    });
  });
  // Every text "Checked" ever shows is recorded.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    addEventListener("DOMContentLoaded", () => {
      const node = document.getElementById("connection-time");
      if (node)
        new MutationObserver(() => seen.push(node.textContent ?? "")).observe(
          node,
          { childList: true, characterData: true, subtree: true },
        );
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}#token=${token}`);
  await page.locator("#connection").filter({ hasText: "Live" }).waitFor();
  // The stream has delivered its snapshot once the page asks again.
  await until(
    async () => served >= 2,
    "the stream to be delivered and reopened",
  );
  const oldTime = await page.evaluate(
    (iso) =>
      (
        window as unknown as {
          crewplane: { formatTime: (value: string) => string };
        }
      ).crewplane.formatTime(iso),
    old.toISOString(),
  );
  const seen = await page.evaluate(
    () => (window as unknown as { __seen: string[] }).__seen,
  );
  expect(seen.length).toBeGreaterThan(0);
  for (const text of seen) expect(text).not.toContain(oldTime);
  expect(errors).toEqual([]);
  await page.close();
}, 30000);

/**
 * The compiled executable serving a project, as `crewplane dashboard` does.
 * (Reading tens of thousands of files at once exhausts descriptors under
 * Node, which the executable's Bun runtime does not.)
 */
async function launch(project: string) {
  const port = await new Promise<number>((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
  let output = "";
  const child = spawn(
    bin,
    ["--project", project, "dashboard", "--port", String(port)],
    {
      env: { ...process.env, CREWPLANE_NO_AUTO_UPDATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const deadline = Date.now() + 15000;
  while (!/#token=[A-Za-z0-9_-]+/.test(output)) {
    if (Date.now() > deadline) throw new Error("dashboard did not start");
    await new Promise((done) => setTimeout(done, 50));
  }
  const url = /http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/.exec(
    output,
  )?.[0] as string;
  return {
    url,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      child.kill("SIGTERM");
      await exited;
    },
  };
}

it("a board too large to push keeps one stream and bounded polling, truthfully labelled, then returns to live", async () => {
  // 32k messages of ~600 bytes: a snapshot of well over 16 MiB.
  const big = realpathSync(mkdtempSync(join(tmpdir(), "crewplane-live-big-")));
  cleanup.push(big);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: big, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(big, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-qm", "test: seed");
  const bigStore = ((await coordination(["init"], big)) as { store: string })
    .store;
  const dir = join(bigStore, "messages");
  const added: string[] = [];
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < 32000; i++) {
    const id = randomUUID();
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id,
        at: new Date(t0 + i * 1000).toISOString(),
        from: "captain",
        to: "all",
        kind: "update",
        task: null,
        replyTo: null,
        text: `bulk ${i} ${"y".repeat(560)}`,
      }),
    );
    added.push(join(dir, `${id}.json`));
  }
  const dashboard = await launch(big);
  const page = await browser.newPage();
  try {
    const counts = { events: 0, snapshots: 0 };
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === "/api/events") counts.events += 1;
      if (pathname === "/api/snapshot") counts.snapshots += 1;
    });
    await page.goto(dashboard.url);
    await page.locator("#connection").filter({ hasText: "Live" }).waitFor();
    // "Live" comes from the first poll; the mode is only settled once the
    // stream's resync has been read, which on a loaded machine (a snapshot of
    // over 16 MiB is built first) can be well after. Sample the window from
    // there, so only a later claim of live updates counts as a failure.
    await modeIs(page, "polling", 60000);
    // Over 20 seconds the page never claims live updates, and neither the
    // stream nor the snapshot is requested in a loop.
    const seen = new Set<string | null>();
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      seen.add(await mode(page));
      await new Promise((done) => setTimeout(done, 250));
    }
    // The attribute is set a moment after "Live" first shows (a busy machine
    // can sample it before then): "not set yet" is not a claim of live updates.
    seen.delete(null);
    expect([...seen]).toEqual(["polling"]);
    expect(counts.events).toBeLessThanOrEqual(2);
    expect(counts.snapshots).toBeLessThanOrEqual(8);
    expect(await page.locator("#connection").textContent()).toBe("Live");
    expect(await page.locator("#error").isVisible()).toBe(false);
    // The board shrinks: the same stream pushes a snapshot and the page is live.
    for (const file of added) unlinkSync(file);
    await modeIs(page, "live", 60000);
    expect(counts.events).toBeLessThanOrEqual(3);
  } finally {
    await page.close();
    await dashboard.stop();
  }
}, 180000);

it("a snapshot that fails to render keeps the banner, is asked for again from scratch and clears once it renders", async () => {
  const good = JSON.parse(await snapshotBody()) as Record<string, unknown>;
  const stream = (id: string, snapshot: unknown, ping?: unknown) =>
    `retry: 3000\n\n${ping === undefined ? "" : `event: ping\ndata: ${JSON.stringify(ping)}\n\n`}id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  const seenIds: Array<string | undefined> = [];
  let calls = 0;
  const { page } = await open({ backoffBaseMs: 100, backoffCapMs: 200 });
  await page.close();
  const fresh = await browser.newPage();
  await fresh.addInitScript(() => {
    (
      window as unknown as { crewplaneLiveTuning: unknown }
    ).crewplaneLiveTuning = { backoffBaseMs: 100, backoffCapMs: 200 };
  });
  await fresh.route("**/api/events", (route) => {
    calls += 1;
    seenIds.push(route.request().headers()["last-event-id"]);
    const n = calls;
    // 1: renders. 2: fails to render (and is followed by a heartbeat naming
    // it). 3 and later: renders again.
    const body =
      n === 2
        ? stream(
            "aaaaaaaa-2",
            { ...good, tasks: 5, lanes: null },
            {
              at: new Date().toISOString(),
              id: "aaaaaaaa-2",
              kind: "snapshot",
            },
          )
        : stream(`aaaaaaaa-${n}`, good);
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body,
    });
  });
  await fresh.goto(`${base}#token=${token}`);
  await fresh.locator("#error").filter({ hasText: "Render failed" }).waitFor();
  expect(await fresh.locator("#connection").textContent()).toBe("Disconnected");
  await until(async () => calls >= 3, "stream retried");
  // The failed event was never remembered: the retry presents no id.
  expect(seenIds[2]).toBeUndefined();
  await fresh.locator("#error").waitFor({ state: "hidden", timeout: 15000 });
  await fresh.close();
}, 60000);

it("a poll that began before a pushed snapshot cannot overwrite it", async () => {
  const { page, errors } = await open({}, "#/messages?filter=all");
  await modeIs(page, "live");
  await page
    .locator("#messages")
    .filter({ hasText: "first synthetic message" })
    .waitFor();
  let release: (() => void) | undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let captured = false;
  await page.route("**/api/snapshot", async (route) => {
    // Take the board as it is now, then hold the answer back.
    const response = await route.fetch();
    const body = await response.text();
    captured = true;
    await held;
    await route.fulfill({ response, body });
  });
  await page.locator("#refresh").click();
  await until(async () => captured, "poll started");
  await send("pushed after the poll began");
  await page
    .locator("#messages")
    .filter({ hasText: "pushed after the poll began" })
    .waitFor();
  release?.();
  await new Promise((done) => setTimeout(done, 500));
  expect(await page.locator("#messages").textContent()).toContain(
    "pushed after the poll began",
  );
  expect(errors).toEqual([]);
  await page.close();
}, 60000);

it("a tab hidden past the grace period closes its stream, polls nothing while hidden and reopens with a refresh when shown", async () => {
  const { page, errors } = await open({ hiddenGraceMs: 300 });
  await modeIs(page, "live");
  const log: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === "/api/events" || pathname === "/api/snapshot")
      log.push(pathname);
  });
  let streamClosed = false;
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/api/events") streamClosed = true;
  });
  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => value,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  // A short absence is not enough to give up the slot, and returning to a
  // live page does not poll.
  await setHidden(true);
  await new Promise((done) => setTimeout(done, 100));
  await setHidden(false);
  await new Promise((done) => setTimeout(done, 600));
  expect(streamClosed).toBe(false);
  expect(log).toEqual([]);
  expect(await mode(page)).toBe("live");
  // A long one closes the stream.
  await setHidden(true);
  await until(async () => streamClosed, "stream closed while hidden");
  expect(await mode(page)).toBe("polling");
  await new Promise((done) => setTimeout(done, 1500));
  expect(log).toEqual([]); // no reconnect, no poll while hidden
  await setHidden(false);
  await until(async () => log.includes("/api/events"), "stream reopened");
  expect(log).toContain("/api/snapshot"); // immediate refresh
  await modeIs(page, "live");
  expect(errors).toEqual([]);
  await page.close();
}, 60000);

it("hidden tabs: alerts on keep a slow snapshot poll that stops when alerts go off; alerts off adds no requests", async () => {
  const run = async (alerts: boolean) => {
    const { page, errors } = await open({
      hiddenGraceMs: 200,
      hiddenPollMs: 300,
    });
    if (alerts)
      await page.evaluate(() =>
        window.localStorage.setItem(
          "crewplane.alerts",
          JSON.stringify({ badge: true }),
        ),
      );
    await page.reload();
    await modeIs(page, "live");
    const snapshots: number[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/snapshot")
        snapshots.push(Date.now());
    });
    const setHidden = (hidden: boolean) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => value,
        });
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => (value ? "hidden" : "visible"),
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setHidden(true);
    await modeIs(page, "polling");
    return { page, errors, snapshots, setHidden };
  };
  // Alerts off: a hidden tab asks for nothing, however long it waits.
  const off = await run(false);
  await new Promise((done) => setTimeout(done, 1800));
  expect(off.snapshots).toEqual([]);
  expect(off.errors).toEqual([]);
  await off.page.close();
  // Alerts on: it keeps reading, about every hiddenPollMs (+-20%).
  const on = await run(true);
  await until(async () => on.snapshots.length >= 3, "hidden alert polls");
  // Switching alerts off (in the Preferences dialog) stops the poll.
  await on.setHidden(false);
  await on.page.locator("#prefs-open").click();
  await on.page.getByLabel("Show a count in the tab title").uncheck();
  await on.page.keyboard.press("Escape");
  await on.setHidden(true);
  await new Promise((done) => setTimeout(done, 400));
  const before = on.snapshots.length;
  await new Promise((done) => setTimeout(done, 1500));
  expect(on.snapshots.length).toBe(before);
  expect(on.errors).toEqual([]);
  await on.page.close();
}, 60000);

it("clicking a desktop alert focuses the tab and opens the fixed view for its category", async () => {
  const { page, errors } = await open();
  await page.evaluate(() => {
    window.localStorage.setItem(
      "crewplane.alerts",
      JSON.stringify({ desktop: true, whenVisible: true }),
    );
  });
  await page.reload();
  await modeIs(page, "live");
  await page.evaluate(() => {
    const made: unknown[] = [];
    class FakeNotification {
      static permission = "granted";
      closed = false;
      onclick: null | (() => void) = null;
      constructor() {
        made.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    Object.assign(window, { Notification: FakeNotification, made });
  });
  await coordination(
    [
      "send",
      "--agent",
      "captain",
      "--to",
      "all",
      "--kind",
      "question",
      "--text",
      "a synthetic question for the alert click test",
    ],
    root,
  );
  await until(
    async () =>
      (await page.evaluate(
        () => (window as unknown as { made: unknown[] }).made.length,
      )) > 0,
    "a desktop alert",
  );
  await page.evaluate(() => {
    const made = (window as unknown as { made: { onclick: () => void }[] })
      .made;
    made[0]?.onclick();
  });
  await until(
    async () =>
      (await page.evaluate(() => window.location.hash)) ===
      "#/messages?filter=open",
    "navigation to the open questions",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { made: { closed: boolean }[] }).made[0]?.closed,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 60000);
