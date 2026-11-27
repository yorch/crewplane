import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
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
    colorScheme?: "light" | "dark";
    init?: () => void;
    prepare?: (page: Page) => Promise<unknown>;
    forcedColors?: boolean;
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: 900 },
    colorScheme: options.colorScheme ?? "light",
    ...(options.forcedColors ? { forcedColors: "active" as const } : {}),
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security/.test(message.text()))
      errors.push(message.text());
  });
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
  await page.route("**/api/events", (route) => route.abort());
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
