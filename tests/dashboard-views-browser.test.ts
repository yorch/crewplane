import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  buildViewsFixture,
  makePng,
  type ViewsFixture,
} from "./views-fixture.ts";

// The four views added on top of the read-only dashboard (Setup & config,
// Usage & cost, Evidence, Control log), in a real browser against the real HTTP
// server and a synthetic project with real PNG evidence. Edge states (a failing
// endpoint, hostile text, truncation, huge or unsupported artifacts) are
// produced by answering the API calls from the page itself, so every view is
// also exercised with data no real project would write.
declare global {
  interface Window {
    crewplane: {
      route: { view: string; params: Record<string, string> };
    };
  }
}
const shots = process.env.CREWPLANE_SHOTS;
let browser: Browser;
let fixture: ViewsFixture;
let bare: ViewsFixture;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  fixture = await buildViewsFixture();
  bare = await buildViewsFixture({
    noConfig: true,
    noEvidence: true,
    noState: true,
  });
  cleanup.push(fixture.stop, bare.stop);
  browser = await chromium.launch();
  if (shots) mkdirSync(shots, { recursive: true });
}, 90000);
afterAll(async () => {
  await browser?.close();
  for (const stop of cleanup) await stop();
});

// Counts object URLs the page creates and revokes, and the most it ever held.
const spies = () => {
  const urls = { created: 0, revoked: 0, held: new Set<string>(), max: 0 };
  const win = window as unknown as { __urls: typeof urls };
  win.__urls = urls;
  const make = URL.createObjectURL.bind(URL);
  const drop = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = make(blob);
    urls.created += 1;
    urls.held.add(url);
    urls.max = Math.max(urls.max, urls.held.size);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    urls.revoked += 1;
    urls.held.delete(url);
    drop(url);
  };
};
interface UrlStats {
  created: number;
  revoked: number;
  held: string[];
  max: number;
}
const urlStats = (page: Page) =>
  page.evaluate(() => {
    const u = (
      window as unknown as {
        __urls: {
          created: number;
          revoked: number;
          held: Set<string>;
          max: number;
        };
      }
    ).__urls;
    return {
      created: u.created,
      revoked: u.revoked,
      held: [...u.held],
      max: u.max,
    } as UrlStats;
  });

interface Opened {
  page: Page;
  errors: string[];
  context: BrowserContext;
}
async function open(
  hash: string,
  options: {
    width?: number;
    height?: number;
    on?: ViewsFixture;
    touch?: boolean;
    prepare?: (page: Page) => Promise<unknown>;
  } = {},
): Promise<Opened> {
  const target = options.on ?? fixture;
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    ...(options.touch ? { hasTouch: true, isMobile: true } : {}),
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript(spies);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security/.test(message.text()))
      errors.push(message.text());
  });
  await options.prepare?.(page);
  await page.goto(`${target.base}#token=${target.session}`);
  await page.locator("#loading").waitFor({ state: "hidden", timeout: 15000 });
  if (hash) {
    await page.evaluate((value) => {
      window.location.hash = value;
    }, hash);
  }
  return { page, errors, context };
}
const close = (opened: Opened) => opened.context.close();
const KNOWN_VIEWS = [
  "overview",
  "tasks",
  "agents",
  "messages",
  "runs",
  "system",
  "setup",
  "usage",
  "evidence",
  "audit",
];
/**
 * Writes the hash and waits until the app has applied that route. A write that
 * returns before the route was applied lets the next write collapse into it
 * (two quick hash changes only ever show the last one), so the second view
 * would never open.
 */
const go = async (page: Page, hash: string) => {
  const name = /^#\/([a-z]+)/.exec(hash)?.[1] ?? "";
  const view = KNOWN_VIEWS.includes(name) ? name : "overview";
  await page.evaluate((value) => {
    window.location.hash = value;
  }, hash);
  await page.waitForFunction(
    (expected) => window.crewplane.route.view === expected,
    view,
  );
};
const noOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
async function expectNoOverflow(page: Page, label: string) {
  const wide = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    offenders: [...document.querySelectorAll("main *")]
      .filter(
        (node) => node.getBoundingClientRect().right > window.innerWidth + 1,
      )
      .slice(0, 5)
      .map((node) => `${node.tagName}.${(node as HTMLElement).className}`),
  }));
  expect(
    wide.scroll,
    `${label}: ${wide.offenders.join(", ")}`,
  ).toBeLessThanOrEqual(wide.inner);
}
const shot = async (page: Page, name: string, fullPage = true) => {
  if (shots)
    await page.screenshot({ path: join(shots, `${name}.png`), fullPage });
};

/** Answers one API path from the page, with JSON built from the real answer. */
async function stubJson(
  page: Page,
  path: string,
  make: (real: Record<string, unknown>) => unknown,
  status = 200,
) {
  await page.route(`**${path}`, async (route) => {
    if (status !== 200) {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: "Could not read the configuration." }),
      });
      return;
    }
    try {
      const response = await route.fetch();
      const real = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make(real)),
      });
    } catch {
      // The page was closed while this read was in flight.
    }
  });
}
const waitText = (page: Page, selector: string, text: string | RegExp) =>
  page
    .locator(selector)
    .filter({ hasText: text })
    .first()
    .waitFor({ timeout: 15000 });
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  limit = 15000,
) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const names = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").trim()),
    );

// ---------------------------------------------------------------------------
// Shell: sidebar, routes and the unchanged strict policy
// ---------------------------------------------------------------------------
it("lists the four new views in the sidebar with hash routes, aria-current and focus on the heading", async () => {
  const opened = await open("#/overview");
  const { page } = opened;
  for (const [view, title] of [
    ["usage", "Usage & cost"],
    ["evidence", "Evidence"],
    ["audit", "Control log"],
    ["setup", "Setup & config"],
  ] as const) {
    const link = page.locator(`#primary-nav a[data-nav="${view}"]`);
    expect(await link.getAttribute("href")).toMatch(new RegExp(`^#/${view}`));
    await link.click();
    await page.locator(`#view-${view}`).waitFor({ state: "visible" });
    expect(await page.locator("#view-title").textContent()).toBe(title);
    expect(await link.getAttribute("aria-current")).toBe("page");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      "view-title",
    );
    expect(await page.title()).toBe(`${title} · Crewplane`);
  }
  // Unknown values in a known view are dropped, unknown views fall back.
  await go(page, "#/audit?outcome=bogus&seq=abc&lane=%3Cimg%3E");
  await page.locator("#view-audit").waitFor({ state: "visible" });
  await page.waitForFunction(() => window.crewplane.route.view === "audit");
  expect(await page.evaluate(() => window.crewplane.route.params)).toEqual({});
  await go(page, "#/evidence?artifact=nope&run=qa_x&task=%2e%2e");
  await page.waitForFunction(() => window.crewplane.route.view === "evidence");
  expect(await page.evaluate(() => window.crewplane.route.params)).toEqual({});
  await go(page, "#/nowhere");
  await page.locator("#view-overview").waitFor({ state: "visible" });
  expect(opened.errors).toEqual([]);
  await close(opened);
});

it("adds blob: to img-src and media-src only", async () => {
  const response = await fetch(fixture.base);
  const policy = response.headers.get("content-security-policy") ?? "";
  expect(policy).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  const directives = Object.fromEntries(
    policy.split("; ").map((part) => {
      const [name, ...values] = part.split(" ");
      return [name, values];
    }),
  );
  for (const name of Object.keys(directives))
    expect(directives[name]?.includes("blob:"), name).toBe(
      name === "img-src" || name === "media-src",
    );
  // The API answers carry the same policy.
  const api = await fetch(`${fixture.base}api/config`, {
    headers: { "x-crewplane-session": fixture.session },
  });
  expect(api.headers.get("content-security-policy")).toBe(policy);
});

// ---------------------------------------------------------------------------
// Setup & config
// ---------------------------------------------------------------------------
it("shows the installed configuration in plain language with problems, lanes, budgets and digest", async () => {
  const opened = await open("#/setup");
  const { page } = opened;
  await waitText(page, "#setup-body h2", "Installed configuration");
  const text = (await page.locator("#setup-body").innerText()).replace(
    /\s+/g,
    " ",
  );
  expect(text).toContain("Configured and valid");
  expect(text).toContain("The installed configuration is valid.");
  expect(text).toContain("Credentials are not probed");
  expect(text).toContain("Binaries are never executed");
  expect(text).toContain("Reload pending");
  // Lanes: one row each, with limits and binary status (found, never run).
  const rows = await page.locator("#setup-body .lanes-table tbody tr").count();
  expect(rows).toBe(3);
  const builder = page.locator('.lanes-table tr[data-row-key="builder"]');
  const builderText = (await builder.innerText()).replace(/\s+/g, " ");
  expect(builderText).toContain("sonnet");
  expect(builderText).toContain("claude");
  expect(builderText).toContain("Runs per hour: 4");
  expect(builderText).toContain("Minutes per run: 10 (default)");
  expect(builderText).toContain("Cost per run: $1");
  expect(builderText).toContain("Found, not executed");
  expect(builderText).toContain("Usage coverage: partial");
  expect(
    await page.locator('.lanes-table tr[data-row-key="captain"]').innerText(),
  ).toContain("Disabled");
  // Budgets: configured against loaded, with the difference called out.
  const budgets = (
    await page
      .locator('[aria-label="Budgets: installed and loaded"]')
      .innerText()
  ).replace(/\s+/g, " ");
  expect(budgets).toContain("Runs per agent per hour (default) 6 4 Differs");
  // Roles hint and digest.
  expect(text).toContain("differ from the project's committed policy");
  const digest = await (
    await fetch(`${fixture.base}api/config`, {
      headers: { "x-crewplane-session": fixture.session },
    })
  ).json();
  expect(text).toContain(digest.digest.slice(0, 12));
  expect(text).not.toContain(digest.digest);
  await page
    .getByRole("button", { name: "Copy full configuration digest" })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    digest.digest,
  );
  expect(await page.locator("#copy-status").textContent()).toMatch(/Copied/);
  expect(opened.errors).toEqual([]);
  await shot(page, "setup-desktop");
  await close(opened);
});

it("explains a project with no configuration and offers commands to copy, never to run", async () => {
  const opened = await open("#/setup", { on: bare });
  const { page } = opened;
  await waitText(page, "#setup-body", "No configuration is installed");
  const text = (await page.locator("#setup-body").innerText()).replace(
    /\s+/g,
    " ",
  );
  expect(text).toContain("Not configured");
  expect(text).toContain("CONFIG_MISSING");
  const commands = await names(page, ".command-text");
  expect(commands).toEqual(
    expect.arrayContaining([
      "crewplane setup",
      "crewplane configure --file PATH",
      "crewplane doctor",
    ]),
  );
  // Copy puts exactly the displayed text on the clipboard; nothing is sent.
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") requests.push(request.url());
  });
  await page
    .getByRole("button", { name: "Copy command crewplane setup" })
    .first()
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "crewplane setup",
  );
  expect(requests).toEqual([]);
  // Lanes are empty, and budgets, digest need an installed configuration.
  expect(text).toContain("No agents are configured.");
  expect(text).not.toContain("Fingerprint and roles");
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "setup-not-configured-desktop");
  await close(opened);
});

it("lists doctor-style problems with codes, the lane and reason, and escapes hostile text", async () => {
  const hostile = '<img src=x onerror="window.__pwned=1">';
  const opened = await open("#/setup", {
    prepare: (page) =>
      stubJson(page, "/api/config", (real) => ({
        ...real,
        ok: false,
        problems: [
          {
            code: "BINARY_UNSAFE",
            lane: "builder",
            message: `codex binary refused: directory /opt/${hostile} is world-writable`,
          },
          {
            code: "BINARY_MISSING",
            lane: "worker",
            message: "claude binary not found",
          },
          { code: `<b>NEW</b>${hostile}`, lane: hostile, message: hostile },
        ],
        problemsTruncated: true,
        lanesTruncated: true,
        warnings: [{ code: "DIGEST_UNAVAILABLE", lane: null, message: "x" }],
        lanes: (real.lanes as Array<Record<string, unknown>>).map(
          (lane, index) =>
            index === 0
              ? {
                  ...lane,
                  id: "builder",
                  model: hostile,
                  passEnv: ["PATH", hostile],
                  binary: {
                    path: "/opt/x",
                    ok: false,
                    code: "BINARY_UNSAFE",
                    problem: `codex binary refused: ${hostile}`,
                  },
                }
              : lane,
        ),
      })),
  });
  const { page } = opened;
  await waitText(page, ".problem-item", "BINARY_UNSAFE");
  const unsafe = page.locator('.problem-item[data-code="BINARY_UNSAFE"]');
  const unsafeText = (await unsafe.innerText()).replace(/\s+/g, " ");
  expect(unsafeText).toContain("builder");
  expect(unsafeText).toContain("is world-writable");
  expect(unsafeText).toContain("It was not run");
  expect(unsafeText).toContain("crewplane doctor");
  expect(await unsafe.locator("a").first().getAttribute("href")).toBe(
    "#/agents?agent=builder",
  );
  const text = (await page.locator("#setup-body").innerText()).replace(
    /\s+/g,
    " ",
  );
  expect(text).toContain("Unrecognised problem");
  expect(text).toContain("Only the first 100 problems are listed");
  expect(text).toContain("Only the first 64 agents are shown");
  expect(text).toContain("DIGEST_UNAVAILABLE");
  // Inert: the hostile markup is text, never an element or an executed handler.
  expect(await page.locator("#setup-body img").count()).toBe(0);
  expect(await page.locator("#setup-body b").count()).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned,
    ),
  ).toBeUndefined();
  expect(text).toContain(hostile);
  expect(opened.errors).toEqual([]);
  await shot(page, "setup-problems-desktop");
  await close(opened);
});

it("shows an error with a working retry when the endpoint fails, then recovers", async () => {
  let fail = true;
  const opened = await open("#/setup", {
    prepare: (page) =>
      page.route("**/api/config", async (route) => {
        if (fail)
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Could not read the configuration.",
            }),
          });
        else await route.continue();
      }),
  });
  const { page } = opened;
  const alert = page.locator("#setup-body [role=alert]");
  await alert.waitFor();
  expect(await alert.innerText()).toContain(
    "Could not load the configuration.",
  );
  expect(await alert.innerText()).toContain(
    "Could not read the configuration.",
  );
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await waitText(page, "#setup-body h2", "Installed configuration");
  expect(await page.locator("#setup-body [role=alert]").count()).toBe(0);
  await close(opened);
});

it("keeps the last answer and says so when a later read fails", async () => {
  let fail = false;
  const opened = await open("#/setup", {
    prepare: (page) =>
      page.route("**/api/config", async (route) => {
        if (fail)
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"Down for now."}',
          });
        else await route.continue();
      }),
  });
  const { page } = opened;
  await waitText(page, "#setup-body h2", "Installed configuration");
  fail = true;
  // Opening the view again reads again.
  await go(page, "#/tasks");
  await go(page, "#/setup");
  await waitText(
    page,
    "#setup-body .banner-inline",
    "refreshing failed: Down for now.",
  );
  expect(await page.locator("#setup-body .lanes-table").count()).toBe(1);
  await close(opened);
});

it("starts a fresh read every time a view opens, even while an earlier read is still in flight", async () => {
  const opened = await open("#/overview");
  const { page } = opened;
  await page.waitForFunction(() => document.querySelector("#attention"));
  // Let the background read that follows the first snapshot finish.
  await page.waitForTimeout(500);
  let reads = 0;
  await page.route("**/api/config", async (route) => {
    reads += 1;
    await new Promise((done) => setTimeout(done, 700));
    await route.continue();
  });
  await go(page, "#/setup");
  await until(() => reads === 1, "the first read starts when Setup opens");
  // Leave and reopen while that read is still in flight: it started before
  // the second opening, so the reopening needs a read of its own.
  await go(page, "#/tasks");
  await go(page, "#/setup");
  await until(() => reads === 2, "a second read after the reopening");
  await waitText(page, "#setup-body h2", "Installed configuration");
  expect(reads).toBe(2);
  await close(opened);
}, 30000);

it("reads /api/config when the view opens and when the snapshot changes, not on every poll", async () => {
  const opened = await open("#/setup");
  const { page } = opened;
  await waitText(page, "#setup-body h2", "Installed configuration");
  let configReads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/config")) configReads += 1;
  });
  // Ten seconds of unchanged board: polls or pushes may happen, config reads must not.
  await page.waitForTimeout(10000);
  expect(configReads).toBe(0);
  await close(opened);
}, 30000);

// ---------------------------------------------------------------------------
// Usage & cost
// ---------------------------------------------------------------------------
it("shows runs against caps as text and meters, durations, labelled counters, cost over cap and a chart with a table", async () => {
  const opened = await open("#/usage");
  const { page } = opened;
  await waitText(page, "#usage-body h2", "Runs started per hour");
  const builder = page.locator('.lane-usage[data-lane="builder"]');
  const text = (await builder.innerText()).replace(/\s+/g, " ");
  expect(text).toContain("3 of 4 runs this hour.");
  expect(text).toContain("Within cap");
  expect(text).toContain("1 left this hour");
  expect(text).toContain("using this agent's own cap");
  expect(text).toContain("3m 00s");
  expect(text).toContain("Within the limit");
  expect(text).toContain("Reported token counters");
  expect(text).toContain("1,200");
  expect(text).toContain("1 of 1 retained record reported it");
  expect(text).toContain("Reported counters, not billing totals");
  // Cost: observed $1.50 against a $1.00 cap.
  expect(text).toContain("Cap per run $1.00");
  expect(text).toContain("Highest observed $1.50");
  expect(text).toContain("Over cap");
  expect(text).toContain("not an invoice");
  // The meter has a name, a value and a text equivalent.
  const meter = builder.locator("meter");
  expect(await meter.getAttribute("aria-label")).toBe(
    "Runs this hour for builder",
  );
  expect(await meter.getAttribute("value")).toBe("3");
  expect(await meter.getAttribute("max")).toBe("4");
  // A lane without own cap uses the default and says so.
  const worker = (
    await page.locator('.lane-usage[data-lane="worker"]').innerText()
  ).replace(/\s+/g, " ");
  expect(worker).toContain("0 of 6 runs this hour.");
  expect(worker).toContain("using the per-agent default cap");
  expect(worker).toContain(
    "No cost cap is configured and no cost was reported",
  );
  // Caps notice: one source, a per-agent default and a different loaded value.
  const summary = (
    await page.locator("#usage-body").first().innerText()
  ).replace(/\s+/g, " ");
  expect(summary).toContain(
    "Every cap here comes from the installed configuration.",
  );
  expect(summary).toContain("not a total across agents");
  expect(summary).toContain(
    "The running supervisor loaded different caps (4 runs per hour",
  );
  // Chart: accessible name, 24 bars' worth of data in the table.
  const chart = page.locator("svg.chart");
  expect(await chart.getAttribute("role")).toBe("img");
  expect(await chart.getAttribute("aria-label")).toMatch(
    /^Runs started per hour, all agents, last 24 hours: 7 runs in 24 recorded hours; busiest hour \d\d:00 with 3\.$/,
  );
  await page
    .locator("summary", { hasText: "Show the same data as a table" })
    .click();
  const table = page.locator(
    '[aria-label^="Runs started per hour, all agents, as a table"]',
  );
  expect(await table.locator("tbody tr").count()).toBe(24);
  const values = await table
    .locator("tbody tr td:nth-child(2)")
    .allInnerTexts();
  expect(values.reduce((sum, v) => sum + Number(v), 0)).toBe(7);
  expect(await chart.locator(".chart-unknown").count()).toBe(0);
  // Coverage explanation is a disclosure.
  await page
    .locator("summary", { hasText: "How complete is this data?" })
    .click();
  expect(
    await page.locator("#usage-body .coverage-list").innerText(),
  ).toContain("not lifetime totals and not billing totals");
  expect(opened.errors).toEqual([]);
  await shot(page, "usage-desktop");
  await close(opened);
});

it("charts a chosen agent through the lane filter and keeps it in the URL", async () => {
  const opened = await open("#/usage");
  const { page } = opened;
  await waitText(page, "#usage-body h2", "Runs started per hour");
  await page.selectOption("#usage-lane", "builder");
  await page.waitForFunction(
    () => window.crewplane.route.params.lane === "builder",
  );
  expect(await page.locator("#usage-body .lane-usage").count()).toBe(1);
  expect(await page.locator("svg.chart").getAttribute("aria-label")).toContain(
    "agent builder",
  );
  expect(page.url()).toContain("#/usage?lane=builder");
  await close(opened);
});

it("never turns unknown usage into zero: dashed Not recorded hours, null counters and gaps", async () => {
  const opened = await open("#/usage", {
    prepare: (page) =>
      stubJson(page, "/api/usage", (real) => {
        const lanes = real.lanes as Array<Record<string, unknown>>;
        const unknownSeries = Array.from({ length: 24 }, (_, i) =>
          i < 20 ? null : i === 23 ? 0 : 2,
        );
        return {
          ...real,
          total: {
            ...(real.total as object),
            runsLastHour: null,
            tokens: { semantics: "x", input: null, output: null },
            series: unknownSeries,
          },
          caps: {
            source: null,
            perLaneDefault: null,
            loaded: null,
            loadedDiffers: null,
          },
          coverage: {
            ...(real.coverage as object),
            counters: { state: "unavailable" },
            series: {
              state: "available",
              complete: false,
              retainedRuns: 3,
              retentionLimited: true,
            },
          },
          lanes: lanes.map((lane) => ({
            ...lane,
            runs: {
              lastHour: null,
              cap: null,
              capSource: null,
              remaining: null,
            },
            durations: { maxRunMinutes: null, recent: [], recordedRuns: 0 },
            tokens: {
              semantics: "x",
              input: null,
              output: null,
              recordsReportingInput: 0,
              recordsReportingOutput: 0,
              retainedRecords: 0,
            },
            cost: {
              maxCostUsdPerRun: null,
              recent: [],
              maxObservedUsd: null,
              anyOverCap: null,
            },
          })),
        };
      }),
  });
  const { page } = opened;
  await waitText(page, "#usage-body h2", "Runs started per hour");
  const text = (await page.locator("#usage-body").innerText()).replace(
    /\s+/g,
    " ",
  );
  expect(text).toContain("No caps are known");
  expect(text).toContain("Runs this hour: not recorded. No cap known.");
  expect(text).toContain("Not recorded (supervisor state unreadable)");
  await page
    .locator("summary", { hasText: "How complete is this data?" })
    .click();
  expect(
    await page.locator("#usage-body .coverage-list").innerText(),
  ).toContain(
    "The supervisor state could not be read, so no counters are available.",
  );
  expect(text).not.toMatch(/\d+ of \d+ runs this hour/);
  expect(await page.locator("svg.chart .chart-unknown").count()).toBe(20);
  expect(await page.locator("svg.chart .chart-zero").count()).toBe(1);
  expect(await page.locator("svg.chart .chart-bar").count()).toBe(3);
  expect(await page.locator("#usage-body .chart-legend").innerText()).toContain(
    "not zero",
  );
  await page
    .locator("summary", { hasText: "Show the same data as a table" })
    .click();
  const notRecorded = await page
    .locator('[aria-label$="as a table"] tbody td:nth-child(2) .is-unknown')
    .allInnerTexts();
  expect(notRecorded).toHaveLength(20);
  expect(new Set(notRecorded)).toEqual(new Set(["Not recorded"]));
  expect(await page.locator("meter").count()).toBe(0);
  await shot(page, "usage-unknown-desktop");
  await close(opened);
});

it("shows an all-unknown series honestly, and a failing usage endpoint with retry", async () => {
  let fail = true;
  const opened = await open("#/usage", {
    prepare: (page) =>
      page.route("**/api/usage", async (route) => {
        if (fail)
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"Could not read usage."}',
          });
        else {
          const response = await route.fetch();
          const real = await response.json();
          real.total.series = real.total.series.map(() => null);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(real),
          });
        }
      }),
  });
  const { page } = opened;
  await page.locator("#usage-body [role=alert]").waitFor();
  expect(await page.locator("#usage-body").innerText()).toContain(
    "Could not read usage.",
  );
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await waitText(
    page,
    "#usage-body .chart-legend",
    "nothing is known, not even zero",
  );
  expect(await page.locator("svg.chart").getAttribute("aria-label")).toMatch(
    /not recorded for any of the last 24 hours/,
  );
  await close(opened);
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
it("shows the gallery with metadata, previews from blob URLs only and cross-links", async () => {
  const opened = await open("#/evidence");
  const { page } = opened;
  await page.locator(".evidence-card").first().waitFor();
  expect(await page.locator(".evidence-card").count()).toBe(4);
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card img").length === 4,
  );
  // No plain image URL: every preview is a blob, none points at the API.
  const sources = await page
    .locator(".evidence-card img")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLImageElement).src),
    );
  expect(sources.every((src) => src.startsWith("blob:"))).toBe(true);
  expect(
    await page
      .locator(".evidence-card img")
      .evaluateAll((nodes) =>
        nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0),
      ),
  ).toBe(true);
  const card = page.locator(".evidence-card", {
    hasText: "finding · dashboard",
  });
  const text = (await card.innerText()).replace(/\s+/g, " ");
  expect(text).toContain("Image");
  expect(text).toContain("image/png");
  expect(text).toContain("finding");
  expect(text).toContain("390 × 844");
  expect(text).toContain("CP-101");
  const artifacts = (
    await (
      await fetch(`${fixture.base}api/evidence/artifacts`, {
        headers: { "x-crewplane-session": fixture.session },
      })
    ).json()
  ).artifacts as Array<{ scenario: string; sha256: string; size: number }>;
  const finding = artifacts.find((item) => item.scenario === "finding");
  expect(text).toContain((finding?.sha256 ?? "").slice(0, 12));
  expect(text).not.toContain(finding?.sha256 ?? "unreachable");
  await card.getByRole("button", { name: /Copy SHA-256 digest/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    finding?.sha256,
  );
  // Cross navigation.
  expect(
    await card.getByRole("link", { name: "CP-101" }).getAttribute("href"),
  ).toBe("#/tasks?task=CP-101");
  expect(
    await card
      .getByRole("link", { name: "Runs for this task" })
      .getAttribute("href"),
  ).toBe("#/runs?task=CP-101");
  expect(
    await card
      .getByRole("link", { name: "Only this run" })
      .getAttribute("href"),
  ).toMatch(/^#\/evidence\?run=qa_[a-f0-9]{32}$/);
  expect(opened.errors).toEqual([]);
  await shot(page, "evidence-desktop");
  await close(opened);
});

it("filters by task and run, keeps the filters in the URL and remembers them per view", async () => {
  const opened = await open("#/evidence");
  const { page } = opened;
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 4,
  );
  await page.fill("#evidence-task", "CP-102");
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 1,
  );
  expect(page.url()).toContain("#/evidence?task=CP-102");
  expect(await page.locator("#evidence-count").textContent()).toBe(
    "1 artifact loaded",
  );
  // Leaving and returning through the sidebar restores the filter.
  await page.locator('#primary-nav a[data-nav="audit"]').click();
  await page.locator('#primary-nav a[data-nav="evidence"]').click();
  await page.waitForFunction(
    () => window.crewplane.route.params.task === "CP-102",
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 1,
  );
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 4,
  );
  const runOption = await page.locator("#evidence-run option").allInnerTexts();
  expect(runOption.length).toBe(3);
  await page.selectOption("#evidence-run", { index: 1 });
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length < 4,
  );
  // A task with nothing, and an invalid one that is ignored with a hint.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.fill("#evidence-task", "NOPE-1");
  await waitText(page, "#evidence-list", "No evidence matches these filters.");
  await page.fill("#evidence-task", "bad id!");
  await waitText(page, "#evidence-task-help", "Task ids use letters");
  await close(opened);
});

it("opens the lightbox from a card with focus, a trap, arrow keys and Escape, and returns focus", async () => {
  const opened = await open("#/evidence");
  const { page } = opened;
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card img").length === 4,
  );
  const first = page
    .locator(".evidence-card")
    .nth(0)
    .getByRole("link", { name: /^View larger/ });
  const label = await first.getAttribute("aria-label");
  expect(label).toMatch(/^View larger: (Screenshot|Recording) of dashboard/);
  await first.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog.lightbox");
  await dialog.waitFor({ state: "visible" });
  expect(page.url()).toMatch(/artifact=ev_[a-f0-9]{32}/);
  expect(await dialog.getAttribute("aria-labelledby")).toBe("lightbox-title");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "lightbox-title",
  );
  // The image is a blob with alt text built from capture metadata.
  const image = dialog.locator("img");
  await image.waitFor();
  expect((await image.getAttribute("src")) ?? "").toMatch(/^blob:/);
  expect(await image.getAttribute("alt")).toMatch(
    /^Screenshot of dashboard, scenario \w+, step \d+, \d+ by \d+ pixels, outcome \w+$/,
  );
  // Download: a blob URL with a fixed safe filename, never a navigation.
  const download = dialog.getByRole("link", { name: "Download file" });
  expect(await download.getAttribute("href")).toMatch(/^blob:/);
  expect(await download.getAttribute("download")).toMatch(
    /^crewplane-evidence-ev_[a-f0-9]{32}\.png$/,
  );
  // Focus trap: tabbing never leaves the dialog.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest("dialog.lightbox")),
      ),
    ).toBe(true);
  }
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest("dialog.lightbox")),
      ),
    ).toBe(true);
  }
  // Arrow keys step through the list (replacing the history entry).
  const idBefore = new URL(page.url()).hash.match(
    /artifact=(ev_[a-f0-9]+)/,
  )?.[1];
  const historyBefore = await page.evaluate(() => history.length);
  await dialog.locator("h2").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    (id) => !location.hash.includes(id ?? ""),
    idBefore,
  );
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  expect(await dialog.locator(".lightbox-head .count").innerText()).toMatch(
    /^2 of 4/,
  );
  await page.keyboard.press("ArrowLeft");
  expect(await dialog.locator(".lightbox-head .count").innerText()).toMatch(
    /^1 of 4/,
  );
  // Escape closes, the address no longer names an artifact and focus returns to the opener.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  expect(page.url()).not.toContain("artifact=");
  await page.waitForFunction(
    () =>
      document.activeElement
        ?.getAttribute("data-focus-key")
        ?.startsWith("artifact:") === true,
  );
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
    "View larger",
  );
  expect(opened.errors).toEqual([]);
  await close(opened);
});

it("supports deep links to an artifact, browser back and forward and reload", async () => {
  const id = fixture.artifacts[1];
  const opened = await open(`#/evidence?artifact=${id}`);
  const { page } = opened;
  const dialog = page.locator("dialog.lightbox");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("img").waitFor();
  expect(await dialog.locator("h2").innerText()).toBe(
    "interaction · dashboard",
  );
  expect(await dialog.innerText()).toContain("1440 × 900");
  await shot(page, "evidence-lightbox-desktop", false);
  // Close through the Close link (a history entry), then back reopens it.
  await dialog.getByRole("link", { name: "Close larger view" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.goBack();
  await dialog.waitFor({ state: "visible" });
  await page.goForward();
  await dialog.waitFor({ state: "hidden" });
  await page.goBack();
  await page.reload();
  await page.locator("dialog.lightbox").waitFor({ state: "visible" });
  await page.locator("dialog.lightbox img").waitFor();
  expect(opened.errors).toEqual([]);
  // An artifact that does not exist is reported, not guessed.
  await go(page, `#/evidence?artifact=ev_${"0".repeat(32)}`);
  await waitText(page, "dialog.lightbox", "This artifact is not available");
  await close(opened);
});

it("revokes every object URL it creates when leaving the view and keeps none in the page afterwards", async () => {
  const opened = await open("#/evidence");
  const { page } = opened;
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card img").length === 4,
  );
  const during = await urlStats(page);
  expect(during.created).toBe(4);
  expect(during.held).toHaveLength(4);
  await page.locator('#primary-nav a[data-nav="audit"]').click();
  await page.locator("#view-audit").waitFor({ state: "visible" });
  const after = await urlStats(page);
  expect(after.revoked).toBe(after.created);
  expect(after.held).toEqual([]);
  // Reopening creates new ones and the lightbox's download blob is revoked too.
  await page.locator('#primary-nav a[data-nav="evidence"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card img").length === 4,
  );
  await page
    .locator(".evidence-card")
    .first()
    .getByRole("link", { name: /^View larger/ })
    .click();
  await page.locator("dialog.lightbox img").waitFor();
  await page
    .locator('#primary-nav a[data-nav="audit"]')
    .click({ force: true })
    .catch(() => undefined);
  await page.keyboard.press("Escape");
  await go(page, "#/audit");
  await page.locator("#view-audit").waitFor({ state: "visible" });
  const end = await urlStats(page);
  expect(end.held).toEqual([]);
  expect(end.revoked).toBe(end.created);
  expect(opened.errors).toEqual([]);
  await close(opened);
});

/** A project-free gallery: the list is stubbed and artifact bytes are answered from the page. */
function galleryStub(
  items: Array<Record<string, unknown>>,
  bytes: (id: string) => { body: Buffer; type: string; status?: number },
  fetched: string[] = [],
) {
  return async (page: Page) => {
    await page.route("**/api/evidence/artifacts?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          artifacts: items,
          nextCursor: null,
          retentionLimited: true,
        }),
      });
    });
    await page.route("**/api/evidence/artifacts/ev_*", async (route) => {
      const id = route.request().url().split("/").pop() ?? "";
      fetched.push(id);
      const { body, type, status } = bytes(id);
      await route.fulfill({
        status: status ?? 200,
        headers: { "content-type": type },
        body,
      });
    });
  };
}
/** The bytes the stubbed gallery serves; recorded sizes must equal their length. */
const STUB_PNG = makePng(40, 25, [20, 120, 220]);
const fakeId = (n: number) => `ev_${n.toString(16).padStart(32, "0")}`;
const fakeArtifact = (n: number, extra: Record<string, unknown> = {}) => ({
  id: fakeId(n),
  kind: "image",
  mime: "image/png",
  size: STUB_PNG.length,
  createdAt: "2026-11-01T10:00:00.000Z",
  task: "CP-101",
  run: `qa_${"b".repeat(32)}`,
  lane: "visual",
  testedCommit: "c".repeat(40),
  sha256: "d".repeat(64),
  route: "dashboard",
  scenario: "initial",
  step: n,
  browser: "chromium",
  viewport: { width: 390, height: 844 },
  outcome: "captured",
  findingIds: [],
  recheckOf: null,
  url: `/api/evidence/artifacts/${fakeId(n)}`,
  ...extra,
});

it("never holds more than 12 object URLs: later previews release earlier ones to a Load button", async () => {
  const items = Array.from({ length: 20 }, (_, i) => fakeArtifact(i + 1));
  const png = makePng(40, 25, [20, 120, 220]);
  // A phone-sized screen shows a couple of cards, so the cap stays at 12.
  const opened = await open("#/evidence", {
    width: 390,
    height: 844,
    prepare: galleryStub(items, () => ({ body: png, type: "image/png" })),
  });
  const { page } = opened;
  await page.locator(".evidence-card").first().waitFor();
  // Scroll the whole gallery so every card becomes visible once.
  for (let y = 0; y < 20000; y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(800);
  const stats = await urlStats(page);
  expect(stats.created).toBeGreaterThan(12);
  expect(stats.max).toBeLessThanOrEqual(12);
  expect(stats.held.length).toBeLessThanOrEqual(12);
  expect(stats.revoked).toBe(stats.created - stats.held.length);
  expect(await page.locator(".evidence-card img").count()).toBeLessThanOrEqual(
    12,
  );
  const released = page.getByRole("button", { name: "Load preview" }).first();
  await released.waitFor();
  expect(await page.locator(".evidence-card").first().innerText()).toContain(
    "Preview released to keep memory use low.",
  );
  // Loading one again works and still respects the cap.
  await released.click();
  await page.waitForTimeout(300);
  expect((await urlStats(page)).max).toBeLessThanOrEqual(12);
  expect(opened.errors).toEqual([]);
  await close(opened);
}, 60000);

it("keeps every preview a large screen shows instead of evicting what is on screen", async () => {
  const items = Array.from({ length: 20 }, (_, i) => fakeArtifact(i + 1));
  const opened = await open("#/evidence", {
    width: 1600,
    height: 6000,
    prepare: galleryStub(items, () => ({ body: STUB_PNG, type: "image/png" })),
  });
  const { page } = opened;
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card img").length === 20,
  );
  await page.waitForTimeout(500);
  const stats = await urlStats(page);
  expect(stats.created).toBe(20);
  expect(stats.revoked).toBe(0);
  expect(stats.held).toHaveLength(20);
  expect(stats.max).toBeLessThanOrEqual(36);
  expect(await page.getByRole("button", { name: "Load preview" }).count()).toBe(
    0,
  );
  expect(opened.errors).toEqual([]);
  await close(opened);
}, 60000);

it("does not make a blob when the length it was sent differs from the recorded size", async () => {
  const items = [
    fakeArtifact(1, { size: STUB_PNG.length + 10 }),
    fakeArtifact(2),
  ];
  const opened = await open("#/evidence", {
    prepare: galleryStub(items, () => ({ body: STUB_PNG, type: "image/png" })),
  });
  const { page } = opened;
  const card = (n: number) =>
    page.locator(`.evidence-card[data-artifact-id="${fakeId(n)}"]`);
  await waitText(
    page,
    `.evidence-card[data-artifact-id="${fakeId(1)}"]`,
    "does not match what was recorded",
  );
  await card(2).locator("img").waitFor();
  expect(await card(1).locator("img").count()).toBe(0);
  // Only the honest artifact made a blob.
  expect((await urlStats(page)).created).toBe(1);
  await close(opened);
});

it("reloads from the start, with a notice and without rebuilding the cards, when Load more names a pruned cursor", async () => {
  const all = Array.from({ length: 6 }, (_, i) => fakeArtifact(i + 1));
  let pruned = false;
  let lists = 0;
  const opened = await open("#/evidence", {
    prepare: async (page) => {
      await page.route("**/api/evidence/artifacts?*", async (route) => {
        const url = new URL(route.request().url());
        const cursor = url.searchParams.get("cursor");
        lists += 1;
        if (cursor && !pruned) {
          pruned = true;
          await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: "Unknown cursor." }),
          });
          return;
        }
        // After the prune the store has lost its oldest item.
        const base = pruned ? all.slice(1) : all;
        const items = cursor ? base.slice(3) : base.slice(0, 3);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            version: 1,
            artifacts: items,
            nextCursor: cursor || base.length <= 3 ? null : base[2]?.id,
            retentionLimited: false,
          }),
        });
      });
      await page.route("**/api/evidence/artifacts/ev_*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "image/png" },
          body: STUB_PNG,
        }),
      );
    },
  });
  const { page } = opened;
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 3,
  );
  // Mark the second card: it must survive the recovery as the same element.
  await page.evaluate((id) => {
    const card = document.querySelector(`[data-artifact-id="${id}"]`);
    (card as unknown as { __kept: boolean }).__kept = true;
  }, fakeId(2));
  await page.getByRole("button", { name: "Load more" }).click();
  await waitText(
    page,
    "#evidence-list .banner",
    "The list changed while you were browsing",
  );
  // Read again from the start (the list had 3 loaded): 5 items remain, 3 shown.
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 3,
  );
  expect(
    await page.evaluate(
      (id) =>
        (
          document.querySelector(`[data-artifact-id="${id}"]`) as unknown as {
            __kept?: boolean;
          }
        )?.__kept === true,
      fakeId(2),
    ),
  ).toBe(true);
  // Load more works again from the fresh cursor.
  await page.getByRole("button", { name: "Load more" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 5,
  );
  expect(await page.locator("#evidence-list .banner").count()).toBe(0);
  expect(lists).toBe(4);
  expect(opened.errors).toEqual([]);
  await close(opened);
});

it("offers only the runs of the current result in the Run filter", async () => {
  const runA = `qa_${"a".repeat(32)}`;
  const runB = `qa_${"b".repeat(32)}`;
  const runC = `qa_${"c".repeat(32)}`;
  const items = [
    fakeArtifact(1, { task: "CP-101", run: runA }),
    fakeArtifact(2, { task: "CP-101", run: runB }),
    fakeArtifact(3, { task: "CP-102", run: runC }),
  ];
  const opened = await open("#/evidence?task=CP-101", {
    prepare: async (page) => {
      // Which elements an IntersectionObserver is watching right now.
      await page.addInitScript(() => {
        const watching = new Set<Element>();
        (window as unknown as { __watching: Set<Element> }).__watching =
          watching;
        const Real = window.IntersectionObserver;
        window.IntersectionObserver = class extends Real {
          observe(target: Element) {
            watching.add(target);
            super.observe(target);
          }
          unobserve(target: Element) {
            watching.delete(target);
            super.unobserve(target);
          }
          disconnect() {
            watching.clear();
            super.disconnect();
          }
        };
      });
      await page.route("**/api/evidence/artifacts?*", async (route) => {
        const task = new URL(route.request().url()).searchParams.get("task");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            version: 1,
            artifacts: items.filter((item) => !task || item.task === task),
            nextCursor: null,
            retentionLimited: false,
          }),
        });
      });
      await page.route("**/api/evidence/artifacts/ev_*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "image/png" },
          body: STUB_PNG,
        }),
      );
    },
  });
  const { page } = opened;
  const options = () =>
    page
      .locator("#evidence-run option")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLOptionElement).value),
      );
  await until(
    async () => (await options()).filter(Boolean).length === 2,
    "the two runs of CP-101",
  );
  await go(page, "#/evidence?task=CP-102");
  await until(
    async () => (await options()).filter(Boolean).join() === runC,
    "only the run of CP-102",
  );
  expect(await options()).not.toContain(runA);
  // Cards that left the grid are no longer observed (nothing detached is held).
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 1,
  );
  expect(
    await page.evaluate(
      () =>
        [
          ...(window as unknown as { __watching: Set<Element> }).__watching,
        ].filter((node) => !node.isConnected).length,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __watching: Set<Element> }).__watching.size,
    ),
  ).toBe(1);
  await close(opened);
}, 30000);

it("does not fetch large images, videos or unsupported types until asked, and treats unsupported types as download-only", async () => {
  const fetched: string[] = [];
  const png = makePng(40, 25, [20, 120, 220]);
  const items = [
    fakeArtifact(1),
    fakeArtifact(2, { size: 5 * 1024 * 1024 }),
    fakeArtifact(3, {
      kind: "video",
      mime: "video/webm",
      size: 90000,
      scenario: "responsive",
    }),
    fakeArtifact(4, {
      kind: null,
      mime: "application/octet-stream",
    }),
    fakeArtifact(5, { mime: "image/svg+xml" }),
    fakeArtifact(6, { size: 20 * 1024 * 1024 }),
  ];
  const opened = await open("#/evidence", {
    prepare: galleryStub(
      items,
      (id) =>
        id === fakeId(2)
          ? {
              // A large image is as long as its record says.
              body: Buffer.concat([
                png,
                Buffer.alloc(5 * 1024 * 1024 - png.length),
              ]),
              type: "image/png",
            }
          : { body: png, type: "text/html" },
      fetched,
    ),
  });
  const { page } = opened;
  await page.locator(".evidence-card").first().waitFor();
  await page.waitForTimeout(800);
  // Only the small image loaded by itself.
  expect(fetched).toEqual([fakeId(1)]);
  const card = (n: number) =>
    page.locator(`.evidence-card[data-artifact-id="${fakeId(n)}"]`);
  expect(await card(2).innerText()).toContain("Large image (5.0 MiB).");
  expect(await card(3).innerText()).toContain(
    "Open the larger view to load and play it.",
  );
  expect(await card(4).innerText()).toContain("Not previewed");
  expect(await card(5).innerText()).toContain("Not previewed");
  expect(await card(6).innerText()).toContain(
    "Too large to preview (20.0 MiB)",
  );
  expect(await card(6).getByRole("button").count()).toBe(1); // only the digest copy
  // The large image loads on request.
  await card(2).getByRole("button", { name: "Load preview" }).click();
  await card(2).locator("img").waitFor();
  expect(fetched).toEqual([fakeId(1), fakeId(2)]);
  // A video in the lightbox waits for a Load button too.
  await go(page, `#/evidence?artifact=${fakeId(3)}`);
  const dialog = page.locator("dialog.lightbox");
  await dialog
    .getByRole("button", { name: /^Load video \(87\.9 KiB\)$/ })
    .waitFor();
  expect(fetched).toEqual([fakeId(1), fakeId(2)]);
  // An unsupported type is not previewed; downloading prepares an octet-stream blob.
  await go(page, `#/evidence?artifact=${fakeId(4)}`);
  await waitText(
    page,
    "dialog.lightbox .media-warning",
    "This file type is not previewed.",
  );
  expect(await dialog.locator("img, video").count()).toBe(0);
  expect(await dialog.innerText()).toContain(
    "Recorded type: application/octet-stream",
  );
  await dialog.getByRole("button", { name: "Prepare download" }).click();
  const link = dialog.getByRole("link", { name: "Download file" });
  await link.waitFor();
  expect(await link.getAttribute("href")).toMatch(/^blob:/);
  expect(await link.getAttribute("download")).toBe(
    `crewplane-evidence-${fakeId(4)}.bin`,
  );
  await close(opened);
});

it("refuses to preview bytes whose response type disagrees with the recorded type", async () => {
  const png = makePng(40, 25, [20, 120, 220]);
  const opened = await open("#/evidence", {
    prepare: galleryStub([fakeArtifact(1)], () => ({
      body: png,
      type: "text/html",
    })),
  });
  const { page } = opened;
  await waitText(
    page,
    ".evidence-card",
    "The server sent a different type than recorded",
  );
  expect(await page.locator(".evidence-card img").count()).toBe(0);
  expect((await urlStats(page)).created).toBe(0);
  await close(opened);
});

it("renders hostile artifact metadata and lane text as inert text", async () => {
  const hostile = '<img src=x onerror="window.__pwned=1">';
  const png = makePng(40, 25, [20, 120, 220]);
  const opened = await open("#/evidence", {
    prepare: galleryStub(
      [
        fakeArtifact(1, {
          route: hostile,
          scenario: hostile,
          browser: hostile,
          lane: hostile,
          task: "CP-101",
          outcome: hostile,
          testedCommit: hostile,
        }),
      ],
      () => ({ body: png, type: "image/png" }),
    ),
  });
  const { page } = opened;
  await page.locator(".evidence-card img").waitFor();
  expect(await page.locator("#evidence-list img").count()).toBe(1);
  expect(
    await page.locator(".evidence-card img").getAttribute("alt"),
  ).toContain(hostile.slice(0, 20));
  expect(await page.locator(".evidence-card").innerText()).toContain(hostile);
  await page
    .locator(".evidence-card")
    .getByRole("link", { name: /^View larger/ })
    .click();
  await page.locator("dialog.lightbox img").waitFor();
  expect(await page.locator("dialog.lightbox h2").innerText()).toContain(
    hostile,
  );
  expect(await page.locator("dialog.lightbox img").count()).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned,
    ),
  ).toBeUndefined();
  expect(
    await page
      .locator("dialog.lightbox")
      .getByRole("link", { name: "Download file" })
      .getAttribute("download"),
  ).toMatch(/^crewplane-evidence-ev_[a-f0-9]{32}\.png$/);
  expect(opened.errors).toEqual([]);
  await close(opened);
});

it("handles an empty store, a failing list and paging with Load more", async () => {
  const empty = await open("#/evidence", { on: bare });
  await waitText(
    empty.page,
    "#evidence-list",
    "No evidence has been captured.",
  );
  expect(await empty.page.locator("#evidence-count").textContent()).toBe(
    "0 artifacts loaded",
  );
  await close(empty);
  const broken = await open("#/evidence", {
    prepare: (page) =>
      stubJson(page, "/api/evidence/artifacts?*", () => ({}), 503),
  });
  await broken.page.locator("#evidence-list [role=alert]").waitFor();
  expect(await broken.page.locator("#evidence-list").innerText()).toContain(
    "Could not load the evidence gallery.",
  );
  await close(broken);
  // Paging: the first page offers more, "Load more" appends the next.
  const png = makePng(40, 25, [20, 120, 220]);
  const all = Array.from({ length: 5 }, (_, i) => fakeArtifact(i + 1));
  const opened = await open("#/evidence", {
    prepare: async (page) => {
      await page.route("**/api/evidence/artifacts?*", async (route) => {
        const url = new URL(route.request().url());
        const cursor = url.searchParams.get("cursor");
        const items = cursor ? all.slice(3) : all.slice(0, 3);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            version: 1,
            artifacts: items,
            nextCursor: cursor ? null : all[2]?.id,
            retentionLimited: false,
          }),
        });
      });
      await page.route("**/api/evidence/artifacts/ev_*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "image/png" },
          body: png,
        }),
      );
    },
  });
  const { page } = opened;
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 3,
  );
  expect(await page.locator("#evidence-count").textContent()).toBe(
    "3 artifacts loaded, more available",
  );
  await page.getByRole("button", { name: "Load more" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 5,
  );
  expect(await page.getByRole("button", { name: "Load more" }).count()).toBe(0);
  expect(await page.locator("#evidence-note").textContent()).toBe("");
  await close(opened);
});

it("asks again for an Evidence (N) count only after a cooldown when the endpoint fails", async () => {
  let counts = 0;
  const opened = await open("#/tasks?task=CP-101", {
    prepare: (page) =>
      page.route("**/api/evidence/artifacts?*", async (route) => {
        counts += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Down."}',
        });
      }),
  });
  const { page } = opened;
  await page.locator("#task-detail a.evidence-link").waitFor();
  // Open, close and reopen the same pane many times: every render builds the link again.
  for (let round = 0; round < 6; round++) {
    await go(page, "#/tasks?task=CP-102");
    await page.locator("#task-detail a.evidence-link").waitFor();
    await go(page, "#/tasks?task=CP-101");
    await page.locator("#task-detail a.evidence-link").waitFor();
  }
  await page.waitForTimeout(500);
  // One failed read per task, not one per render.
  expect(counts).toBeLessThanOrEqual(2);
  expect(await page.locator("#task-detail a.evidence-link").textContent()).toBe(
    "Evidence",
  );
  await close(opened);
}, 30000);

it("adds a compact Evidence (N) link to task and run details", async () => {
  const opened = await open("#/tasks?task=CP-101");
  const { page } = opened;
  const link = page.locator("#task-detail a.evidence-link");
  await link.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("#task-detail a.evidence-link")?.textContent ===
      "Evidence (3)",
  );
  expect(await link.getAttribute("href")).toBe("#/evidence?task=CP-101");
  await link.click();
  await page.waitForFunction(
    () =>
      window.crewplane.route.view === "evidence" &&
      window.crewplane.route.params.task === "CP-101",
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".evidence-card").length === 3,
  );
  // Runs: the selected run's task has evidence too.
  const runs = (await (
    await fetch(`${fixture.base}api/runs?task=CP-101`, {
      headers: { "x-crewplane-session": fixture.session },
    })
  ).json()) as { runs: Array<{ runId: string }> };
  await go(page, `#/runs?run=${runs.runs[0]?.runId}`);
  const runLink = page.locator("#run-summary a.evidence-link");
  await runLink.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("#run-summary a.evidence-link")?.textContent ===
      "Task evidence (3)",
  );
  expect(await runLink.getAttribute("href")).toBe("#/evidence?task=CP-101");
  await close(opened);
});

// ---------------------------------------------------------------------------
// Control log
// ---------------------------------------------------------------------------
it("lists commands newest first with outcome badges, plain-language reasons and highlighted refusals", async () => {
  const opened = await open("#/audit");
  const { page } = opened;
  await page.locator(".audit-table tbody tr").first().waitFor();
  const rows = page.locator(".audit-table tbody tr");
  expect(await rows.count()).toBe(6);
  expect(await names(page, ".audit-table tbody tr td:first-child a")).toEqual([
    "#6",
    "#5",
    "#4",
    "#3",
    "#2",
    "#1",
  ]);
  // Outcome is text plus tone; refused, out-of-date and not-applied rows are marked.
  const attention = await page.locator(".audit-table tr.is-attention").count();
  expect(attention).toBe(4);
  const row3 = (await page.locator('tr[data-row-key="3"]').innerText()).replace(
    /\s+/g,
    " ",
  );
  expect(row3).toContain("Out of date");
  expect(row3).toContain("STALE_REVISION");
  expect(row3).toContain("The agent changed after you opened this");
  expect(row3).toContain("dashboard");
  const row2 = (await page.locator('tr[data-row-key="2"]').innerText()).replace(
    /\s+/g,
    " ",
  );
  expect(row2).toContain("No change");
  expect(await page.locator('tr[data-row-key="2"].is-attention').count()).toBe(
    0,
  );
  // Unknown codes show raw, as text, flagged as unknown.
  const row6 = (await page.locator('tr[data-row-key="6"]').innerText()).replace(
    /\s+/g,
    " ",
  );
  expect(row6).toContain("<img src=x onerror=alert(1)>");
  expect(row6).toContain("not one the dashboard knows");
  expect(await page.locator(".audit-table img").count()).toBe(0);
  // Cross links to the agent, task and run views.
  expect(
    await page
      .locator('tr[data-row-key="1"] a.cross-link')
      .getAttribute("href"),
  ).toBe("#/agents?agent=builder");
  expect(
    await page
      .locator('tr[data-row-key="5"] a.cross-link')
      .getAttribute("href"),
  ).toBe("#/tasks?task=CP-101");
  expect(
    await page
      .locator('tr[data-row-key="4"] a.cross-link')
      .getAttribute("href"),
  ).toMatch(/^#\/runs\?run=\d{13}-/);
  // Retention is stated, and the count is shown.
  expect(await page.locator("#audit-note").textContent()).toContain(
    "keeps only the latest 200 commands",
  );
  expect(await page.locator("#audit-count").textContent()).toBe(
    "6 of 6 retained commands",
  );
  expect(opened.errors).toEqual([]);
  await shot(page, "audit-desktop");
  await close(opened);
});

it("does not rebuild the table or re-announce the count when a read brings nothing new", async () => {
  const opened = await open("#/audit");
  const { page } = opened;
  await page.locator(".audit-table tbody tr").first().waitFor();
  await waitText(page, "#audit-count", "retained commands");
  await page.evaluate(() => {
    const row = document.querySelector(".audit-table tbody tr");
    (row as unknown as { __same: boolean }).__same = true;
    const seen: string[] = [];
    (window as unknown as { __mutations: string[] }).__mutations = seen;
    for (const id of ["audit-count", "audit-note", "audit-list"])
      new MutationObserver((records) => {
        for (const record of records) seen.push(`${id}:${record.type}`);
      }).observe(document.getElementById(id) as Node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
  });
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/control-log")) reads += 1;
  });
  // Following off and on again reads the log again; nothing in it changed.
  await page.getByLabel("Follow newer commands").uncheck();
  await page.getByLabel("Follow newer commands").check();
  await until(() => reads >= 1, "a read of the log");
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(
      () =>
        (
          document.querySelector(".audit-table tbody tr") as unknown as {
            __same?: boolean;
          }
        )?.__same === true,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as { __mutations: string[] }).__mutations,
    ),
  ).toEqual([]);
  await close(opened);
});

it("filters by outcome, issuer and agent, and offers a clear button", async () => {
  const opened = await open("#/audit");
  const { page } = opened;
  await page.locator(".audit-table tbody tr").first().waitFor();
  await page.selectOption("#audit-outcome", "stale");
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 1,
  );
  expect(page.url()).toContain("#/audit?outcome=stale");
  await page.selectOption("#audit-outcome", "");
  await page.selectOption("#audit-issuer", "dashboard");
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 2,
  );
  await page.selectOption("#audit-lane", "builder");
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 1,
  );
  await page.selectOption("#audit-outcome", "noop");
  await waitText(page, "#audit-list", "No commands match these filters.");
  await page
    .locator("#audit-list")
    .getByRole("button", { name: "Clear filters" })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 6,
  );
  expect(await page.locator("#audit-clear").isHidden()).toBe(true);
  // The outcome counts in the summary are links to the same filter.
  await page.locator(".audit-summary a", { hasText: "Refused" }).click();
  await page.waitForFunction(
    () => window.crewplane.route.params.outcome === "refused",
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 2,
  );
  await close(opened);
});

it("opens a command's details from a deep link, with explanation, keyboard close and focus return", async () => {
  const opened = await open("#/audit?seq=3");
  const { page } = opened;
  const pane = page.locator("#audit-detail");
  await pane.waitFor({ state: "visible" });
  expect(await pane.locator("h2").innerText()).toBe("Command #3");
  const text = (await pane.innerText()).replace(/\s+/g, " ");
  expect(text).toContain(
    "Out of date: The agent changed after you opened this",
  );
  expect(text).toContain("STALE_REVISION");
  expect(text).toContain("A stale command is never applied");
  expect(
    await page.locator('tr[data-row-key="3"] a[aria-current="true"]').count(),
  ).toBe(1);
  await pane.locator("h2").focus();
  await page.keyboard.press("Escape");
  await pane.waitFor({ state: "hidden" });
  expect(page.url()).not.toContain("seq=");
  await page.goBack();
  await pane.waitFor({ state: "visible" });
  // A sequence number that is not retained is said so.
  await go(page, "#/audit?seq=999");
  await waitText(page, "#audit-detail", "This command is no longer retained.");
  // Opening a row focuses the detail heading; closing returns to the row link.
  await go(page, "#/audit");
  await page
    .locator('tr[data-row-key="5"] a[data-focus-key="audit:5"]')
    .click();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-focus-key") ===
      "detail-heading",
  );
  await page.locator("#audit-detail [data-close-detail]").click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-focus-key") === "audit:5",
  );
  await close(opened);
});

it("follows newer commands by cursor and can pause following", async () => {
  const live = await buildViewsFixture({ noEvidence: true });
  cleanup.push(live.stop);
  const opened = await open("#/audit", { on: live });
  const { page } = opened;
  await page.locator(".audit-table tbody tr").first().waitFor();
  const append = (seq: number, outcome: string, code: string) => {
    const state = live.readState() as {
      controlLog: unknown[];
      controlSeq: number;
    };
    state.controlSeq = seq;
    state.controlLog.push({
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      seq,
      action: "nudge",
      scope: "lane",
      target: "worker",
      outcome,
      code,
      at: new Date().toISOString(),
      issuer: "cli",
    });
    live.writeState(state);
  };
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/control-log"))
      requests.push(new URL(request.url()).search);
  });
  append(7, "applied", "NOTICE_QUEUED");
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 7,
    undefined,
    { timeout: 20000 },
  );
  expect(requests.some((query) => query.startsWith("?after=6"))).toBe(true);
  expect(await names(page, ".audit-table tbody tr td:first-child a")).toEqual([
    "#7",
    "#6",
    "#5",
    "#4",
    "#3",
    "#2",
    "#1",
  ]);
  // Unfollow: new commands are counted, not inserted, until asked for.
  await page.getByLabel("Follow newer commands").uncheck();
  append(8, "refused", "HELD_REFUSED");
  await waitText(
    page,
    "#audit-list .banner-inline",
    "New commands were recorded while following was off.",
  );
  expect(await page.locator(".audit-table tbody tr").count()).toBe(7);
  await page.getByRole("button", { name: "Show 1 newer command" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 8,
  );
  expect(await page.getByLabel("Follow newer commands").isChecked()).toBe(true);
  await close(opened);
}, 60000);

it("pages older commands locally, says the log is capped, and reads an empty or unavailable log", async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
    seq: 100 + i,
    action: "pause",
    scope: "lane",
    target: "builder",
    outcome: "applied",
    code: "HELD",
    at: new Date().toISOString(),
    issuer: "cli",
  }));
  const big = await buildViewsFixture({ noEvidence: true, log: many });
  cleanup.push(big.stop);
  const opened = await open("#/audit", { on: big });
  const { page } = opened;
  await page.locator(".audit-table tbody tr").first().waitFor();
  expect(await page.locator(".audit-table tbody tr").count()).toBe(50);
  await page
    .getByRole("button", { name: /^Show older commands \(26 more\)$/ })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".audit-table tbody tr").length === 76,
  );
  await close(opened);
  const empty = await open("#/audit", { on: bare });
  await waitText(empty.page, "#audit-list", "The control log is unavailable.");
  await close(empty);
  const none = await open("#/audit", {
    prepare: (page) =>
      stubJson(page, "/api/control-log*", (real) => ({
        ...real,
        entries: [],
        retained: 0,
        retainedFrom: null,
        latestSeq: null,
        nextAfter: null,
      })),
  });
  await waitText(
    none.page,
    "#audit-list",
    "No operator commands have been recorded.",
  );
  await close(none);
  const failing = await open("#/audit", {
    prepare: (page) => stubJson(page, "/api/control-log*", () => ({}), 503),
  });
  await failing.page.locator("#audit-list [role=alert]").waitFor();
  expect(await failing.page.locator("#audit-list").innerText()).toContain(
    "Could not load the control log.",
  );
  await close(failing);
}, 60000);

it("reads a reset log again from the start even when it has grown past the cursor, and never holds more than the supervisor retains", async () => {
  const idOf = (epoch: string, n: number) =>
    `${epoch.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // A scripted /api/control-log: `current` is what the supervisor retains.
  const current = { epoch: "a", from: 1, to: 5 };
  const requests: string[] = [];
  const opened = await open("#/audit", {
    prepare: (page) =>
      page.route("**/api/control-log*", async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.search);
        const after = url.searchParams.get("after");
        const all = Array.from(
          { length: current.to - current.from + 1 },
          (_, i) => current.from + i,
        ).map((seq) => ({
          id: idOf(current.epoch, seq),
          seq,
          at: new Date().toISOString(),
          issuer: "cli",
          action: "pause",
          scope: "lane",
          target: "builder",
          lane: "builder",
          task: null,
          run: null,
          outcome: "applied",
          reason: "HELD",
        }));
        const newer =
          after === null ? all : all.filter((e) => e.seq > Number(after));
        const entries = newer.slice(-200);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            version: 1,
            available: true,
            entries,
            latestSeq: current.to,
            retainedFrom: current.from,
            retainedFromId: idOf(current.epoch, current.from),
            afterId:
              after === null
                ? null
                : (all.find((e) => e.seq === Number(after))?.id ?? null),
            retained: all.length,
            hasMore: false,
            nextAfter:
              entries.at(-1)?.seq ?? (after === null ? null : Number(after)),
          }),
        });
      }),
  });
  const { page } = opened;
  await waitText(page, "#audit-count", "5 of 5 retained commands");
  // Reset and grow past the cursor: sequence numbers alone look like progress.
  current.epoch = "b";
  current.from = 1;
  current.to = 8;
  await go(page, "#/tasks");
  await go(page, "#/audit?seq=3");
  await waitText(page, "#audit-count", "8 of 8 retained commands");
  await waitText(page, "#audit-detail", idOf("b", 3));
  expect(await page.locator("#audit-detail").innerText()).not.toContain(
    idOf("a", 3),
  );
  // The supervisor keeps 200: 250 recorded means 51..250 are retained, and
  // the page claims no more than that, whatever it held before.
  current.epoch = "b";
  current.from = 51;
  current.to = 250;
  await go(page, "#/tasks");
  await go(page, "#/audit?seq=40");
  await waitText(page, "#audit-count", "200 of 200 retained commands");
  await waitText(page, "#audit-detail", "This command is no longer retained.");
  expect(requests.some((query) => !query.includes("after="))).toBe(true);
  expect(opened.errors).toEqual([]);
  await close(opened);
}, 60000);

// ---------------------------------------------------------------------------
// Overview integration
// ---------------------------------------------------------------------------
it("adds configuration problems, refused commands and the new views to the overview", async () => {
  const opened = await open("#/overview", {
    prepare: (page) =>
      stubJson(page, "/api/config", (real) => ({
        ...real,
        ok: false,
        problems: [
          {
            code: "BINARY_UNSAFE",
            lane: "builder",
            message: "codex binary refused: x",
          },
        ],
      })),
  });
  const { page } = opened;
  await waitText(page, "#attention", "Configuration problems (1)");
  const setup = page.locator("#attention a", {
    hasText: "Configuration problems (1)",
  });
  expect(await setup.getAttribute("href")).toBe("#/setup");
  expect(await setup.innerText()).toContain("BINARY_UNSAFE on builder");
  // Fixture refusals are hours old at most, so they count as recent.
  await waitText(page, "#attention", /Commands that were not applied \(\d\)/);
  const audit = page.locator("#attention a", {
    hasText: "Commands that were not applied",
  });
  expect(await audit.getAttribute("href")).toBe("#/audit");
  const shortcuts = await names(page, "#shortcuts a");
  for (const label of [
    "Setup & config",
    "Usage & cost",
    "Evidence",
    "Control log",
  ])
    expect(
      shortcuts.some((text) => text.startsWith(label)),
      label,
    ).toBe(true);
  expect(await page.locator('[data-count="setup"]').innerText()).toContain("1");
  await shot(page, "overview-desktop");
  await close(opened);
});

// ---------------------------------------------------------------------------
// Layout and accessibility across widths
// ---------------------------------------------------------------------------
const hashes = ["#/setup", "#/usage", "#/evidence", "#/audit", "#/audit?seq=3"];
for (const width of [1440, 390]) {
  it(`has no horizontal overflow at ${width}px in any new view`, async () => {
    const opened = await open("#/overview", {
      width,
      height: width === 390 ? 844 : 900,
    });
    const { page } = opened;
    for (const hash of hashes) {
      await go(page, hash);
      await page.waitForFunction((h) => window.location.hash === h, hash);
      await page.waitForTimeout(700);
      await page.waitForFunction(
        () =>
          !document.querySelector("#view-evidence:not([hidden]) .loading-note"),
      );
      await expectNoOverflow(page, `${hash} @${width}`);
      await shot(
        page,
        `${hash.replace(/[#/?=]/g, "-").replace(/^-+/, "")}-${width}`,
      );
    }
    // The lightbox is a modal with no overflow either.
    await go(page, `#/evidence?artifact=${fixture.artifacts[0]}`);
    await page.locator("dialog.lightbox img").waitFor();
    await expectNoOverflow(page, `lightbox @${width}`);
    const box = await page.locator("dialog.lightbox").boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    await shot(page, `lightbox-${width}`, false);
    expect(opened.errors).toEqual([]);
    await close(opened);
  }, 60000);
}

it("gives every control and landmark in the new views an accessible name and valid structure", async () => {
  const opened = await open("#/setup");
  const { page } = opened;
  for (const hash of ["#/setup", "#/usage", "#/evidence", "#/audit?seq=3"]) {
    await go(page, hash);
    await page.waitForFunction((h) => window.location.hash === h, hash);
    await page.waitForTimeout(900);
    if (hash === "#/usage")
      await page.locator("summary", { hasText: "Show the same data" }).click();
    const problems = await page.evaluate(() => {
      const view = document.querySelector(".view:not([hidden])") as HTMLElement;
      const out: string[] = [];
      const nameOf = (node: Element) => {
        const labelled = node.getAttribute("aria-labelledby");
        if (labelled)
          return labelled
            .split(" ")
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();
        const label = node.getAttribute("aria-label");
        if (label) return label.trim();
        const labels = (node as HTMLInputElement).labels;
        if (labels?.length)
          return [...labels]
            .map((l) => l.textContent)
            .join(" ")
            .trim();
        return (
          (node.textContent ?? "").trim() ||
          (node.querySelector("img[alt]")?.getAttribute("alt") ?? "")
        );
      };
      for (const node of view.querySelectorAll(
        "button, a[href], input, select, textarea, meter, [role=img], table, details > summary",
      ))
        if (!nameOf(node))
          out.push(
            `unnamed ${node.tagName}.${(node as HTMLElement).className}`,
          );
      for (const img of view.querySelectorAll("img"))
        if (!img.getAttribute("alt")) out.push("img without alt");
      for (const th of view.querySelectorAll("th"))
        if (th.getAttribute("scope") !== "col") out.push("th without scope");
      const ids = [...document.querySelectorAll("[id]")].map((n) => n.id);
      for (const id of ids)
        if (ids.filter((other) => other === id).length > 1)
          out.push(`duplicate id ${id}`);
      for (const table of view.querySelectorAll("table"))
        if (!table.getAttribute("aria-label")) out.push("table without name");
      // Headings do not skip levels inside the view (the page h1 is outside it).
      let last = 1;
      for (const heading of view.querySelectorAll("h2, h3, h4")) {
        const level = Number(heading.tagName[1]);
        if (level > last + 1) out.push(`heading jump to ${heading.tagName}`);
        last = level;
      }
      return out;
    });
    expect(problems, hash).toEqual([]);
  }
  await close(opened);
});

it("meets touch target sizes and keeps selected state visible in forced colors", async () => {
  const opened = await open("#/setup", {
    width: 390,
    height: 844,
    touch: true,
  });
  const { page } = opened;
  // Every interactive element on screen, not a hand-picked list: links,
  // summaries, buttons, selects and inputs (a checkbox counts through its
  // label, the thing a finger actually hits). One evaluate queries and
  // measures, so a re-render cannot detach a node between the two steps.
  const smallTargets = () =>
    page.evaluate(() => {
      const roots = [
        document.querySelector(".view:not([hidden])"),
        document.querySelector("dialog[open]"),
        document.querySelector("#primary-nav"),
      ].filter(Boolean) as HTMLElement[];
      const found: string[] = [];
      for (const root of roots)
        for (const node of root.querySelectorAll(
          "a[href], summary, input, button, select, textarea",
        )) {
          const style = getComputedStyle(node);
          if (style.visibility === "hidden" || style.display === "none")
            continue;
          if (
            node.closest("[hidden]") ||
            (node as HTMLInputElement).type === "hidden"
          )
            continue;
          const target =
            node instanceof HTMLInputElement &&
            ["checkbox", "radio"].includes(node.type)
              ? (node.closest("label") ?? node)
              : node;
          const rect = target.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.height < 43.5)
            found.push(
              `${node.tagName.toLowerCase()}.${(node as HTMLElement).className}[${(node.textContent ?? "").trim().slice(0, 24)}]:${Math.round(rect.height)}`,
            );
        }
      return found;
    });
  for (const hash of [
    "#/setup",
    "#/usage",
    "#/evidence",
    `#/evidence?artifact=${fixture.artifacts[0]}`,
    "#/audit",
    "#/audit?seq=4",
    "#/tasks?task=CP-101",
  ]) {
    await go(page, hash);
    await page.waitForFunction((h) => window.location.hash === h, hash);
    await page.waitForTimeout(900);
    await expect.poll(smallTargets, { message: hash }).toEqual([]);
  }
  await close(opened);
  const forced = await open("#/audit?seq=4", {
    prepare: (page) => page.emulateMedia({ forcedColors: "active" }),
  });
  await forced.page.locator("#audit-detail").waitFor({ state: "visible" });
  await expect
    .poll(() =>
      forced.page.evaluate(() => {
        const row = document.querySelector("tr.is-selected");
        return row ? getComputedStyle(row).outlineStyle : null;
      }),
    )
    .toBe("solid");
  await shot(forced.page, "audit-forced-colors");
  await close(forced);
});

it("restores scroll and the open disclosure after a reload", async () => {
  const opened = await open("#/usage", { height: 500 });
  const { page } = opened;
  await waitText(page, "#usage-body h2", "Runs started per hour");
  await page
    .locator("summary", { hasText: "How complete is this data?" })
    .click();
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(200);
  await page.reload();
  await page.locator("#loading").waitFor({ state: "hidden" });
  await waitText(page, "#usage-body h2", "Runs started per hour");
  await page.waitForFunction(() => window.scrollY > 300);
  expect(
    await page
      .locator("details.info[data-key='info-usage-coverage']")
      .getAttribute("open"),
  ).not.toBeNull();
  await close(opened);
});

it("keeps keyboard focus and expanded details while snapshots update", async () => {
  const opened = await open("#/usage");
  const { page } = opened;
  await waitText(page, "#usage-body h2", "Runs started per hour");
  await page
    .locator("summary", { hasText: "Show the same data as a table" })
    .click();
  await page.locator("#usage-lane").focus();
  // Force a render (a finished resource read); focus and the open table stay.
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await page.waitForTimeout(800);
  expect(
    await page
      .locator("details[data-key='usage-chart-table']")
      .getAttribute("open"),
  ).not.toBeNull();
  await page.locator("#usage-lane").focus();
  await page.evaluate(() =>
    document.getElementById("refresh")?.dispatchEvent(new Event("click")),
  );
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "usage-lane",
  );
  await close(opened);
});
