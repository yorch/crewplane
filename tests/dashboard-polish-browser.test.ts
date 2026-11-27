import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { failOnConsoleErrors } from "./support/console-errors.ts";
import { buildViewsFixture, type ViewsFixture } from "./views-fixture.ts";

// Phase 5 polish: command palette, shortcuts, theme, preferences, graph at
// scale and run timeline tools, in a real browser against the real server.
const shots = process.env.CREWPLANE_SHOTS;
let browser: Browser;
let fixture: ViewsFixture;

beforeAll(async () => {
  fixture = await buildViewsFixture();
  browser = await chromium.launch();
  if (shots) mkdirSync(shots, { recursive: true });
}, 90000);
afterAll(async () => {
  await browser?.close();
  await fixture?.stop();
});

async function open(
  hash = "#/overview",
  options: {
    width?: number;
    height?: number;
    colorScheme?: "light" | "dark";
    init?: () => void;
    prepare?: (page: Page) => Promise<unknown>;
    forcedColors?: boolean;
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    colorScheme: options.colorScheme ?? "light",
    ...(options.forcedColors ? { forcedColors: "active" as const } : {}),
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  failOnConsoleErrors(page, errors);
  if (options.init) await page.addInitScript(options.init);
  await options.prepare?.(page);
  await page.goto(`${fixture.base}#token=${fixture.session}`);
  await page.locator("#loading").waitFor({ state: "hidden", timeout: 15000 });
  await page.evaluate((value) => {
    window.location.hash = value;
  }, hash);
  return { page, errors, close: () => context.close() };
}
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};
const noOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
const hash = (page: Page) => page.evaluate(() => window.location.hash);

it("command palette: opens from keyboard and button, searches loaded data, navigates, returns focus", async () => {
  const { page, errors, close } = await open();
  await page.keyboard.press("Control+k");
  const dialog = page.locator("#palette");
  await dialog.waitFor();
  expect(await dialog.getAttribute("aria-labelledby")).toBe("palette-title");
  const input = page.locator("#palette-input");
  expect(await input.getAttribute("role")).toBe("combobox");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "palette-input",
  );
  await input.fill("cp-102");
  const first = page.locator("#palette-list [role=option]").first();
  await first.waitFor();
  expect(await first.textContent()).toContain("CP-102");
  expect(await input.getAttribute("aria-activedescendant")).toBe(
    await first.getAttribute("id"),
  );
  await shot(page, "palette-light-1440");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    window.location.hash.includes("task=CP-102"),
  );
  await dialog.waitFor({ state: "hidden" });
  // Escape closes and returns focus to what opened it.
  await page.locator("#palette-open").focus();
  await page.locator("#palette-open").click();
  await dialog.waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "palette-open",
  );
  // Slash opens it when not typing, but not from a text field.
  await page.evaluate(() => {
    window.location.hash = "#/tasks";
  });
  await page.locator("#search").focus();
  await page.keyboard.type("/");
  expect(await page.locator("#palette").isVisible()).toBe(false);
  expect(await page.locator("#search").inputValue()).toBe("/");
  await page
    .locator("#search")
    .evaluate((node) => (node as HTMLElement).blur());
  await page.keyboard.press("/");
  await dialog.waitFor();
  // Hostile text stays inert and an empty result says so.
  await input.fill("<img src=x onerror=window.pwned=1>");
  expect(await page.locator("#palette-status").textContent()).toContain(
    "No matches",
  );
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  // Focus stays inside the dialog.
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => document.activeElement?.closest("#palette") !== null,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await close();
}, 45000);

it("shortcuts: chords navigate, the overlay lists them, single keys can be turned off and stay off", async () => {
  const { page, errors, close } = await open();
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  expect(await hash(page)).toContain("#/agents");
  await page.keyboard.press("?");
  const help = page.locator("#shortcuts-dialog");
  await help.waitFor();
  expect(await help.locator("kbd").count()).toBeGreaterThan(15);
  await shot(page, "shortcuts-light-1440");
  // Bare keys are ignored while a dialog is open.
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  expect(await hash(page)).toContain("#/agents");
  await help.getByLabel("Single-key shortcuts").uncheck();
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  expect(await hash(page)).toContain("#/agents");
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("crewplane.shortcuts"),
    ),
  ).toBe("off");
  // Ctrl+K and the Search button keep working.
  await page.keyboard.press("Control+k");
  await page.locator("#palette").waitFor();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator("#loading").waitFor({ state: "hidden" });
  await page.keyboard.press("/");
  expect(
    await page
      .locator("#palette")
      .isVisible()
      .catch(() => false),
  ).toBe(false);
  expect(errors).toEqual([]);
  await close();
}, 45000);

it("shortcuts: a pending chord times out and typing fields are left alone", async () => {
  const { page, close } = await open("#/tasks");
  await page.locator("#search").focus();
  await page.keyboard.type("ga");
  expect(await hash(page)).toContain("#/tasks");
  await page
    .locator("#search")
    .evaluate((node) => (node as HTMLElement).blur());
  await page.keyboard.press("g");
  await page.waitForTimeout(1700);
  await page.keyboard.press("a");
  expect(await hash(page)).toContain("#/tasks");
  await close();
}, 30000);

it("theme: three states, persisted, applied before first paint, readable in both, works without storage", async () => {
  const { page, errors, close } = await open("#/overview", {
    colorScheme: "light",
  });
  const bg = () =>
    page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
  const light = await bg();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBeUndefined();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  expect(await bg()).not.toBe(light);
  expect(
    await page
      .getByRole("button", { name: "Dark", exact: true })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    await page.evaluate(() => window.localStorage.getItem("crewplane.theme")),
  ).toBe("dark");
  // Reload: the attribute is set by a blocking script before the body exists.
  await page.addInitScript(() => {
    document.addEventListener("readystatechange", () => {
      const w = window as unknown as { __early?: string | undefined };
      w.__early ??= document.documentElement.dataset.theme;
    });
  });
  await page.reload();
  await page.locator("#loading").waitFor({ state: "hidden" });
  expect(
    await page.evaluate(
      () => (window as unknown as { __early?: string }).__early,
    ),
  ).toBe("dark");
  await shot(page, "theme-dark-1440");
  await page.getByRole("button", { name: "System", exact: true }).click();
  expect(
    await page.evaluate(() => window.localStorage.getItem("crewplane.theme")),
  ).toBeNull();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  expect(await bg()).toBe(light);
  expect(errors).toEqual([]);
  await close();

  // System dark with no saved choice follows the OS.
  const system = await open("#/overview", { colorScheme: "dark" });
  expect(
    await system.page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
  ).not.toBe(light);
  await system.close();

  // Blocked storage: no errors, the choice still applies for the session.
  const blocked = await open("#/overview", {
    init: () => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("blocked");
        },
      });
    },
  });
  await blocked.page.getByRole("button", { name: "Dark", exact: true }).click();
  expect(
    await blocked.page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  expect(blocked.errors).toEqual([]);
  await blocked.close();
}, 60000);

it("themes: every view fits 1440 and 390 in both themes, with no overflow", async () => {
  for (const colorScheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const { page, errors, close } = await open("#/overview", {
        colorScheme,
        width,
      });
      for (const view of [
        "overview",
        "tasks",
        "agents",
        "messages",
        "runs",
        "relationships",
        "usage",
        "evidence",
        "audit",
        "setup",
        "system",
      ]) {
        await page.evaluate((v) => {
          window.location.hash = `#/${v}`;
        }, view);
        await page.locator(`#view-${view}`).waitFor();
        expect(await noOverflow(page), `${view} ${colorScheme} ${width}`).toBe(
          true,
        );
      }
      expect(errors).toEqual([]);
      await close();
    }
}, 120000);

it("preferences: one dialog for theme, shortcuts, alerts and reset; permission only on a click", async () => {
  const { page, errors, close } = await open("#/tasks?layout=list", {
    init: () => {
      const w = window as unknown as { __asked: number };
      w.__asked = 0;
      const Fake = {
        permission: "default",
        requestPermission() {
          w.__asked++;
          Fake.permission = "granted";
          return Promise.resolve("granted");
        },
      };
      // Notification is called as a constructor only when an alert shows.
      const Ctor = Object.assign(function Notification() {}, Fake);
      Object.defineProperty(Ctor, "permission", {
        get: () => Fake.permission,
      });
      Ctor.requestPermission = Fake.requestPermission;
      (window as unknown as { Notification: unknown }).Notification = Ctor;
    },
  });
  await page.locator("#prefs-open").click();
  const dialog = page.locator("#preferences-dialog");
  await dialog.waitFor();
  expect(await dialog.getAttribute("aria-labelledby")).toBe(
    "preferences-dialog-title",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { __asked: number }).__asked,
    ),
  ).toBe(0);
  await dialog.getByLabel("Show a count in the tab title").check();
  expect(
    await page.evaluate(
      () => (window as unknown as { __asked: number }).__asked,
    ),
  ).toBe(0);
  await shot(page, "preferences-light-1440");
  await dialog.getByRole("button", { name: "Enable desktop alerts" }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __asked: number }).__asked,
    ),
  ).toBe(1);
  await dialog.getByLabel("Dark").check();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("crewplane.alerts") ?? "{}"),
  );
  expect(stored).toMatchObject({ badge: true, desktop: true });
  await dialog.getByRole("button", { name: "Reset saved view state" }).click();
  expect(await dialog.textContent()).toContain(
    "Theme, shortcut and alert choices were kept",
  );
  expect(
    await page.evaluate(() => window.localStorage.getItem("crewplane.theme")),
  ).toBe("dark");
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("crewplane.tasks.layout"),
    ),
  ).toBeNull();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "prefs-open",
  );
  expect(errors).toEqual([]);
  await close();
}, 45000);

it("dialogs fit a phone, have 44px targets on touch and respect forced colors", async () => {
  const { page, close } = await open("#/overview", { width: 390 });
  await page.locator("#palette-open").click();
  await page.locator("#palette").waitFor();
  const box = await page
    .locator("#palette-list [role=option]")
    .first()
    .boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "palette-light-390");
  await page.keyboard.press("Escape");
  await page.locator("#nav-toggle").click();
  await page.locator("#prefs-open").click();
  await page.locator("#preferences-dialog").waitFor();
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "preferences-light-390");
  await close();
  const forced = await open("#/overview", { forcedColors: true });
  await forced.page.keyboard.press("Control+k");
  await forced.page.locator("#palette").waitFor();
  expect(
    await forced.page.evaluate(
      () => matchMedia("(forced-colors: active)").matches,
    ),
  ).toBe(true);
  await forced.close();
}, 45000);

/** A 1000 task model, stubbed into the real snapshot. */
async function bigGraph(page: Page) {
  // An empty, finished stream (the page polls); an aborted request would be
  // a console error, and no console error is allowed.
  await page.route("**/api/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "retry: 60000\n\n",
    }),
  );
  await page.route("**/api/snapshot", async (route) => {
    const response = await route.fetch();
    const real = (await response.json()) as Record<string, unknown>;
    const nodes = Array.from({ length: 1000 }, (_, i) => ({
      id: `T${i}`,
      kind: "task",
      label: i === 5 ? "<img src=x onerror=window.pwned=1>" : `T${i}`,
      taskStatus: i % 50 === 0 ? "blocked" : "working",
      owner: `lane${i % 8}`,
      phase: String(i % 4),
    }));
    const edges = Array.from({ length: 999 }, (_, i) => [
      `T${i + 1}`,
      `T${i}`,
      0,
      "requires accepted",
      null,
      null,
      0,
    ]);
    const model = {
      version: 1,
      view: "dependencies",
      nodes,
      edges,
      hidden: { nodes: 0, edges: 0 },
      truncated: { nodes: 0, edges: 0 },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...real,
        graphModels: { ...(real.graphModels as object), dependencies: model },
      }),
    });
  });
}
const drawn = (page: Page) =>
  page.evaluate(() => ({
    svg: document.querySelectorAll("#graph-host .relay-node").length,
    list: document.querySelectorAll("#graph-host .relay-graph-nodes > *")
      .length,
    rows: document.querySelectorAll("#graph-host tbody tr").length,
  }));

it("relationship graph at scale: never more than the cap in the DOM; focus, clusters and paging work from the keyboard", async () => {
  const { page, errors, close } = await open(
    "#/relationships?graph=dependencies",
    { prepare: bigGraph },
  );
  await page.locator("#graph-scale").waitFor();
  await page.locator(".relay-graph-nodes button").first().waitFor();
  let counts = await drawn(page);
  expect(counts.svg).toBeLessThanOrEqual(50);
  expect(counts.list).toBeLessThanOrEqual(50);
  expect(counts.rows).toBeLessThanOrEqual(100);
  expect(await page.locator("#graph-note").textContent()).toContain(
    "of 1,000 nodes",
  );
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  // Paging
  expect(await page.locator("#graph-page-state").textContent()).toBe(
    "Page 1 of 20",
  );
  await page.locator("#graph-next").click();
  expect(await page.locator("#graph-page-state").textContent()).toBe(
    "Page 2 of 20",
  );
  await page.locator("#graph-prev").click();
  // Clusters
  await page.locator("#graph-group").selectOption("owner");
  await page.waitForFunction(() =>
    window.location.hash.includes("group=owner"),
  );
  const cluster = page
    .locator(".relay-graph-nodes button[aria-expanded]")
    .first();
  await cluster.waitFor();
  expect(await cluster.getAttribute("aria-expanded")).toBe("false");
  await cluster.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".relay-graph-nodes button[aria-expanded=true]"),
  );
  counts = await drawn(page);
  expect(counts.list).toBeLessThanOrEqual(50);
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-expanded"),
    ),
  ).toBe("true");
  await shot(page, "graph-clusters-light-1440");
  await page.locator("#graph-group").selectOption("none");
  // Focus
  await page.goto(
    `${fixture.base}#/relationships?graph=dependencies&focus=T500&hops=2`,
  );
  await page.waitForFunction(() =>
    document.querySelector("#graph-focus-state")?.textContent?.includes("T500"),
  );
  counts = await drawn(page);
  expect(counts.list).toBe(5);
  expect(await page.locator("#graph-focus-clear").isVisible()).toBe(true);
  await page.locator("#graph-focus-clear").click();
  await page.waitForFunction(() => !window.location.hash.includes("focus="));
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
  await close();
}, 60000);

it("a state file lacking optional fields never prints undefined, NaN or null on any of the 11 views", async () => {
  const original = fixture.readState();
  const bare = structuredClone(original) as Record<string, unknown>;
  // The supervisor's own loaded schedule and run records, reduced to what
  // the file must hold: everything optional is absent.
  bare.scheduling = {};
  delete bare.attention;
  delete bare.configReload;
  delete bare.queue;
  delete bare.retiredRuns;
  // Control log entries that hold little more than their number.
  bare.controlLog = [{ seq: 1 }, { seq: 2, action: "stop" }, {}];
  bare.records = Object.fromEntries(
    Object.entries(
      (original.records ?? {}) as Record<
        string,
        { lane: string; task: string; status: string }
      >,
    ).map(([key, record]) => [
      key,
      { key, lane: record.lane, task: record.task, status: record.status },
    ]),
  );
  const views = [
    "overview",
    "tasks",
    "agents",
    "messages",
    "runs",
    "relationships",
    "usage",
    "evidence",
    "audit",
    "setup",
    "system",
  ];
  const bad = /\b(undefined|NaN|null)\b/;
  try {
    for (const [label, state] of [
      [
        "no maxParallel",
        {
          ...original,
          scheduling: {
            ...((original.scheduling as object) ?? {}),
            maxParallel: undefined,
          },
        },
      ],
      ["bare state", bare],
    ] as const) {
      fixture.writeState(state);
      for (const width of [1440, 390]) {
        const { page, errors, close } = await open("#/overview", { width });
        for (const view of views) {
          await page.evaluate((name) => {
            window.location.hash = `#/${name}`;
          }, view);
          await page.waitForFunction(
            (name) => window.crewplane.route.view === name,
            view,
          );
          await page.waitForTimeout(250);
          await page.waitForFunction(
            () => !document.querySelector("#loading:not([hidden])"),
          );
          // biome-ignore lint/performance/useDomNodeTextContent: the text a person sees
          const body = await page.evaluate(() => document.body.innerText);
          expect(body, `${label} ${width}px ${view}`).not.toMatch(bad);
        }
        expect(errors).toEqual([]);
        await close();
      }
    }
  } finally {
    fixture.writeState(original);
  }
}, 120000);

it("a malformed graph model that decodes to nothing does not hide the valid plain graph", async () => {
  let plain = 0;
  const { page, errors, close } = await open(
    "#/relationships?graph=communication",
    {
      prepare: async (page) => {
        await page.route("**/api/events", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: "retry: 60000\n\n",
          }),
        );
        await page.route("**/api/snapshot", async (route) => {
          const real = (await (await route.fetch()).json()) as {
            graphs: { communication: { nodes: unknown[] } };
          };
          plain = real.graphs.communication.nodes.length;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...real,
              graphModels: {
                dependencies: { version: 2, nodes: "garbage", edges: 7 },
                communication: { version: 2, nodes: [null, 3], edges: [] },
              },
            }),
          });
        });
      },
    },
  );
  await page.locator("#graph-note").waitFor();
  await page.locator(".relay-graph-nodes button").first().waitFor();
  expect(plain).toBeGreaterThan(0);
  expect((await drawn(page)).list).toBe(plain);
  expect(await page.locator("#graph-note").textContent()).not.toContain(
    "Graph data unavailable",
  );
  expect(errors).toEqual([]);
  await close();
}, 30000);

it("relationship graph at scale on a phone", async () => {
  const { page, errors, close } = await open(
    "#/relationships?graph=dependencies&group=phase",
    { width: 390, colorScheme: "dark", prepare: bigGraph },
  );
  await page.locator("#graph-scale").waitFor();
  await page.locator(".relay-graph-nodes button").first().waitFor();
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "graph-scale-dark-390");
  expect(errors).toEqual([]);
  await close();
}, 45000);

it("run timeline tools: filter, search, jump, JSON copy and download, comparison", async () => {
  const { page, errors, close } = await open("#/runs");
  await page.locator("#run-history .run-row").first().waitFor();
  await page.locator("#run-events .timeline-row").first().waitFor();
  await page.waitForFunction(
    () =>
      !(document.getElementById("run-copy-json") as HTMLButtonElement).disabled,
  );
  const chip = page.locator("#run-kinds .chip").first();
  expect(await chip.getAttribute("aria-pressed")).toBe("false");
  await chip.click();
  expect(await chip.getAttribute("aria-pressed")).toBe("true");
  expect(await page.locator("#run-filter-status").textContent()).toContain(
    "Showing 1 of",
  );
  await page.locator("#run-search").fill("zzz-nothing");
  expect(await page.locator("#run-filter-status").textContent()).toContain(
    "No loaded events match",
  );
  expect(
    await page.locator("#run-events .timeline-row:not([hidden])").count(),
  ).toBe(0);
  await page.locator("#run-search").fill("");
  await chip.click();
  // Download: fixed file name, only displayed fields.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#run-download-json").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^crewplane-run-\d{13}-[a-f0-9-]+\.json$/,
  );
  const stream = await download.createReadStream();
  let text = "";
  for await (const part of stream) text += part;
  const parsed = JSON.parse(text);
  expect(Object.keys(parsed.events[0]).sort()).toEqual(
    [
      "at",
      "channel",
      "durationMs",
      "effort",
      "inputTokens",
      "kind",
      "message",
      "model",
      "outputTokens",
      "sequence",
      "status",
      "tool",
    ].sort(),
  );
  expect(text).not.toMatch(/sessionId/);
  await page.locator("#run-copy-json").click();
  expect(
    JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).events
      .length,
  ).toBe(parsed.events.length);
  // Nothing failed in the fixture run, so there is nothing to jump to.
  expect(await page.locator("#run-first-error").isDisabled()).toBe(true);
  // Compare: open, choose another run, read the result, close and return focus.
  await page.locator("#run-compare-toggle").click();
  const compare = page.locator("#run-compare");
  await compare.waitFor();
  expect(
    await page.locator("#run-compare-toggle").getAttribute("aria-expanded"),
  ).toBe("true");
  const options = page.locator("#run-compare-select option");
  expect(await options.count()).toBeGreaterThan(1);
  await page.locator("#run-compare-select").selectOption({ index: 1 });
  await compare.locator("table").first().waitFor();
  expect(await compare.textContent()).toContain("Events by type");
  await shot(page, "runs-compare-light-1440");
  expect(await noOverflow(page)).toBe(true);
  await page.locator("#run-compare-toggle").click();
  await compare.waitFor({ state: "hidden" });
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "run-compare-toggle",
  );
  expect(errors).toEqual([]);
  await close();
}, 60000);

it("a comparison still being read stops requesting when the Runs view is left, or the panel closed", async () => {
  // The other run is endless (100 events a page, slowly): every request the
  // page sends for it is counted.
  let requests = 0;
  let otherId = "";
  const { page, errors, close } = await open("#/runs", {
    prepare: async (p) => {
      await p.route("**/api/runs/**", async (route) => {
        const url = new URL(route.request().url());
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        if (!otherId || id !== otherId) return route.fallback();
        requests += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        const after = Number(url.searchParams.get("after") ?? 0);
        const events = Array.from({ length: 100 }, (_, i) => ({
          sequence: after + i + 1,
          at: "2026-01-01T00:00:00Z",
          kind: "message",
          channel: "assistant",
          message: `event ${after + i + 1}`,
        }));
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ events, nextCursor: after + 100 }),
          })
          .catch(() => undefined);
      });
    },
  });
  await page.locator("#run-history .run-row").first().waitFor();
  await page.locator("#run-events .timeline-row").first().waitFor();
  const select = page.locator("#run-compare-select");
  const settle = async () => {
    let last = -1;
    while (last !== requests) {
      last = requests;
      await page.waitForTimeout(600);
    }
    return requests;
  };
  for (const leave of ["view", "panel"] as const) {
    await page.locator("#run-compare-toggle").click();
    expect(await select.locator("option").count()).toBeGreaterThan(1);
    otherId =
      (await select.locator("option").nth(1).getAttribute("value")) ?? "";
    requests = 0;
    await select.selectOption({ index: 1 });
    await expect.poll(() => requests, { timeout: 5000 }).toBeGreaterThan(1);
    if (leave === "view")
      await page.evaluate(() => {
        window.location.hash = "#/overview";
      });
    else await page.locator("#run-compare-toggle").click();
    const stopped = await settle();
    // It would otherwise go on for 60 pages (7 s and more).
    expect(stopped, leave).toBeLessThan(10);
    await page.waitForTimeout(1500);
    expect(requests, leave).toBe(stopped);
    if (leave === "view") {
      await page.evaluate(() => {
        window.location.hash = "#/runs";
      });
      await page.locator("#run-compare-toggle").waitFor();
    }
  }
  expect(errors).toEqual([]);
  await close();
}, 60000);

it("run timeline tools: jump to the first error and inert hostile text, on a phone", async () => {
  const { page, errors, close } = await open("#/runs", {
    width: 390,
    prepare: async (p) => {
      await p.route("**/api/runs/*?*", async (route) => {
        const response = await route.fetch();
        const real = (await response.json()) as {
          events: Record<string, unknown>[];
          nextCursor: number;
        };
        const base = real.events[0] ?? {
          sequence: 1,
          at: new Date().toISOString(),
          kind: "started",
          channel: "system",
          message: "x",
          tool: null,
          status: null,
          inputTokens: null,
          outputTokens: null,
        };
        const events = [
          { ...base, sequence: 1, kind: "started" },
          {
            ...base,
            sequence: 2,
            kind: "assistant",
            message: "<img src=x onerror=window.pwned=1>",
          },
          {
            ...base,
            sequence: 3,
            kind: "error",
            status: "failed",
            message: "Native run failed",
          },
        ];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...real, events, nextCursor: 3 }),
        });
      });
    },
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#run-events .timeline-row").length === 3,
  );
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  await page.locator("#run-search").fill("img");
  expect(
    await page.locator("#run-events .timeline-row:not([hidden])").count(),
  ).toBe(1);
  await page.locator("#run-first-error").click();
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-sequence"),
    ),
  ).toBe("3");
  expect(
    await page.locator("#run-events .timeline-row:not([hidden])").count(),
  ).toBe(3);
  expect(await page.locator("#run-follow").isChecked()).toBe(false);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "runs-tools-light-390");
  expect(errors).toEqual([]);
  await close();
}, 45000);

it("palette dialog commands: Preferences and Keyboard shortcuts open their dialogs", async () => {
  const { page, errors, close } = await open();
  for (const [query, dialogId] of [
    ["preferences", "#preferences-dialog"],
    ["keyboard shortcuts", "#shortcuts-dialog"],
  ] as const) {
    await page.keyboard.press("Control+k");
    await page.locator("#palette").waitFor();
    await page.locator("#palette-input").fill(query);
    await page.locator("#palette-list [role=option]").first().waitFor();
    await page.keyboard.press("Enter");
    await page.locator("#palette").waitFor({ state: "hidden" });
    await page.locator(dialogId).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator(dialogId).waitFor({ state: "hidden" });
  }
  expect(errors).toEqual([]);
  await close();
}, 30000);

it("run compare: both runs use the latest 500 events and the page says so, with per-side totals", async () => {
  const totals = new Map<string, number>();
  const { page, errors, close } = await open("#/runs", {
    prepare: async (p) => {
      await p.route("**/api/runs/*?*", async (route) => {
        const url = new URL(route.request().url());
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        if (!totals.has(id)) totals.set(id, totals.size === 0 ? 700 : 1300);
        const total = totals.get(id) ?? 0;
        const after = Number(url.searchParams.get("after") ?? 0);
        const real = (await (await route.fetch()).json()) as {
          meta: Record<string, unknown>;
        };
        const events = Array.from(
          { length: Math.max(0, Math.min(100, total - after)) },
          (_, i) => ({
            sequence: after + i + 1,
            at: new Date(1_700_000_000_000 + (after + i) * 1000).toISOString(),
            kind: "tool",
            channel: "system",
            message: "x",
            tool: `e${after + i + 1}`,
            status: null,
            inputTokens: null,
            outputTokens: null,
          }),
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...real,
            meta: { ...real.meta, events: total },
            events,
            nextCursor: after + events.length,
          }),
        });
      });
    },
  });
  await page.locator("#run-history .run-row").first().click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#run-events .timeline-row:last-child")
        ?.textContent?.includes("e700"),
    undefined,
    { timeout: 30000 },
  );
  await page.locator("#run-compare-toggle").click();
  await page.locator("#run-compare-select").selectOption({ index: 1 });
  const note = page.locator("#run-compare-window");
  await note.waitFor({ timeout: 20000 });
  const label = (await note.textContent()) ?? "";
  expect(label).toContain("latest 500 events of each run");
  expect(label).toContain("This run: 500 of 700");
  expect(label).toContain("other run: 500 of 1,300");
  const first = page.locator("#run-compare tbody tr").filter({
    hasText: "e201",
  });
  expect(await first.count()).toBeGreaterThan(0);
  expect(await first.first().textContent()).toContain("e801");
  expect(errors).toEqual([]);
  await close();
}, 60000);

it("theme chosen in another tab updates the pressed state here (storage event)", async () => {
  const { page, errors, close } = await open("#/overview");
  const second = await page.context().newPage();
  await second.goto(`${fixture.base}#token=${fixture.session}`);
  await second.locator("#loading").waitFor({ state: "hidden", timeout: 15000 });
  const pressed = (name: string) =>
    page
      .getByRole("button", { name, exact: true })
      .getAttribute("aria-pressed");
  expect(await pressed("System")).toBe("true");
  await second.getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  expect(await pressed("Dark")).toBe("true");
  expect(await pressed("System")).toBe("false");
  await second.getByRole("button", { name: "Light", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  expect(await pressed("Light")).toBe("true");
  expect(await pressed("Dark")).toBe("false");
  expect(errors).toEqual([]);
  await close();
}, 30000);

it("print: light colours even in the dark theme, chrome hidden, tables kept", async () => {
  const { page, errors, close } = await open("#/agents", {
    colorScheme: "dark",
  });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  const screenBg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  await page.emulateMedia({ media: "print" });
  const state = await page.evaluate(() => {
    const display = (selector: string) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node).display : "absent";
    };
    return {
      bg: getComputedStyle(document.body).backgroundColor,
      color: getComputedStyle(document.body).color,
      sidebar: display("#sidebar"),
      skip: display("#skip-link"),
      toolbar: display("#view-agents .toolbar"),
      table: display("#view-agents table"),
      scheme: getComputedStyle(document.documentElement).colorScheme,
    };
  });
  expect(screenBg).not.toBe(state.bg);
  expect(state.bg).toBe("rgb(244, 245, 248)");
  expect(state.scheme).toBe("light");
  expect(state.sidebar).toBe("none");
  expect(state.skip).toBe("none");
  expect(state.toolbar).toBe("none");
  expect(state.table).not.toBe("none");
  if (shots) await page.pdf({ path: join(shots, "print-agents.pdf") });
  expect(errors).toEqual([]);
  await close();
}, 30000);

/** Where the diagram's nodes sit relative to its scrolling canvas. */
const diagram = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(".relay-graph-canvas") as HTMLElement;
    const svg = document.querySelector(".relay-graph-svg") as SVGElement;
    const box = canvas.getBoundingClientRect();
    const nodes = [...svg.querySelectorAll(".relay-node")].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-node-id") ?? "",
        kind: node.getAttribute("data-node-kind") ?? "",
        inside:
          r.left >= box.left - 1 &&
          r.right <= box.right + 1 &&
          r.top >= box.top - 1 &&
          r.bottom <= box.bottom + 1,
      };
    });
    return {
      scrollsSideways: canvas.scrollWidth > canvas.clientWidth + 1,
      canvasWidth: canvas.clientWidth,
      svgWidth: Number(svg.getAttribute("width")),
      nodes,
    };
  });

it("cluster layout: collapsed clusters wrap inside the canvas and expanded members are drawn beside their header, dark 1440 and phone", async () => {
  const { page, errors, close } = await open(
    "#/relationships?graph=dependencies&group=owner",
    { colorScheme: "dark", prepare: bigGraph },
  );
  await page.locator("#graph-scale").waitFor();
  const cluster = page
    .locator(".relay-graph-nodes button[aria-expanded]")
    .first();
  await cluster.waitFor();
  let state = await diagram(page);
  expect(state.nodes.length).toBe(8);
  expect(state.scrollsSideways).toBe(false);
  expect(state.svgWidth).toBeLessThanOrEqual(state.canvasWidth);
  await shot(page, "graph-cluster-collapsed-dark-1440");
  await cluster.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".relay-graph-nodes button[aria-expanded=true]"),
  );
  await page.locator(".relay-graph-canvas").scrollIntoViewIfNeeded();
  state = await diagram(page);
  const members = state.nodes.filter((node) => node.kind === "task");
  expect(members.length).toBeGreaterThan(5);
  expect(state.scrollsSideways).toBe(false);
  // The header and its members are all visible without scrolling the canvas.
  const header = state.nodes.find((node) => node.kind === "cluster");
  expect(header?.inside).toBe(true);
  expect(members.slice(0, 12).every((node) => node.inside)).toBe(true);
  await shot(page, "graph-cluster-expanded-dark-1440");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
  await close();
  // A phone: fewer columns, same rules.
  const phone = await open("#/relationships?graph=dependencies&group=owner", {
    width: 390,
    colorScheme: "dark",
    prepare: bigGraph,
  });
  await phone.page
    .locator(".relay-graph-nodes button[aria-expanded]")
    .first()
    .waitFor();
  const small = await diagram(phone.page);
  expect(small.svgWidth).toBeLessThanOrEqual(small.canvasWidth + 1);
  expect(small.scrollsSideways).toBe(false);
  if (shots)
    await phone.page
      .locator(".relay-graph-canvas")
      .screenshot({ path: join(shots, "graph-cluster-canvas-dark-390.png") });
  expect(await noOverflow(phone.page)).toBe(true);
  expect(phone.errors).toEqual([]);
  await phone.close();
}, 60000);

/** Rows of the Runs history: none may be shorter than its own content or overlap the next. */
const historyRows = (page: Page) =>
  page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll<HTMLElement>("#run-history .run-row"),
    ];
    return rows.map((row, index) => {
      const box = row.getBoundingClientRect();
      const meta = row.querySelector(".run-row-meta")?.getBoundingClientRect();
      const next = rows[index + 1]?.getBoundingClientRect();
      return {
        height: Math.round(box.height),
        metaInside: meta ? meta.bottom <= box.bottom + 0.5 : false,
        clear: next ? next.top >= box.bottom - 0.5 : true,
        contentFits: row.scrollHeight <= row.clientHeight + 1,
      };
    });
  });
for (const [name, options] of [
  // A short window caps the history (58vh), the case that cut rows to 36px.
  ["light 1440", { width: 1440, height: 700 }],
  ["dark 1440", { width: 1440, height: 700, colorScheme: "dark" as const }],
  ["light 390", { width: 390 }],
  ["dark 390", { width: 390, colorScheme: "dark" as const }],
  ["forced colors 1440", { width: 1440, height: 700, forcedColors: true }],
  ["forced colors 390", { width: 390, forcedColors: true }],
] as const)
  it(`runs history rows fit their content and never overlap: ${name}`, async () => {
    const { page, errors, close } = await open("#/runs", options);
    await page.locator("#run-history .run-row").nth(2).waitFor();
    const rows = await historyRows(page);
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(row.metaInside).toBe(true);
      expect(row.clear).toBe(true);
      expect(row.contentFits).toBe(true);
      // Title line plus status line plus padding: well over the 36px minimum.
      expect(row.height).toBeGreaterThanOrEqual(56);
    }
    await shot(page, `runs-history-${name.replace(/ /g, "-")}`);
    expect(await noOverflow(page)).toBe(true);
    expect(errors).toEqual([]);
    await close();
  }, 30000);
