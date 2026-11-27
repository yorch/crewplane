import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("./graph-renderer.js", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("./graph-renderer.css", import.meta.url),
  "utf8",
);
const node = (id: string) => ({
  id,
  kind: "lane",
  label: id,
  role: null,
  harness: null,
  observedModel: null,
  taskId: null,
  processStatus: null,
  taskStatus: null,
  accepted: false,
});
const edge = (
  id: string,
  from: string,
  to: string,
  kind = "awaiting-answer",
) => ({
  id,
  from,
  to,
  kind,
  label: id,
  threadId: `opaque:${id}`,
  at: null,
  unanswered: true,
});

test("synthetic graph: bounded fanout, cycles, hostile text, missing references, filters and stable keyboard updates across viewports", async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent('<main id="host"></main>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({
      type: "module",
      content: `${source}\nwindow.renderGraph = renderGraph;`,
    });
    await page.waitForFunction("typeof window.renderGraph === 'function'");
    const snapshot = {
      version: 1,
      view: "communication",
      nodes: [
        node("D"),
        node("coordinator"),
        node('<img src=x onerror="window.pwned=true">'),
      ],
      edges: [
        edge("question", "D", "coordinator"),
        edge("cycle", "coordinator", "D", "review-handoff"),
        edge("missing", "D", "absent"),
        edge("dependency", "coordinator", "D", "dependency"),
      ],
      hidden: { nodes: 4, edges: 8 },
    };
    await page.evaluate((data) => {
      const runtime = window as unknown as {
        renderGraph: (
          document: Document,
          host: Element,
          snapshot: unknown,
          options: unknown,
        ) => unknown;
        graph: unknown;
        selected: unknown;
      };
      runtime.graph = runtime.renderGraph(
        document,
        document.querySelector("#host") ?? document.body,
        data,
        {
          onSelect: (selection: unknown) => {
            runtime.selected = selection;
          },
        },
      );
    }, snapshot);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator("tbody tr").count()).toBe(3);
    // The live region stays short; coverage detail is static, not live.
    expect(await page.locator('[role="status"]').textContent()).toBe(
      "3 nodes, 3 relationships",
    );
    expect(await page.locator(".relay-graph-detail").getAttribute("role")).toBe(
      null,
    );
    await expectText(
      page.locator(".relay-graph-detail"),
      "Missing-reference relationships: 1",
    );
    // The filter input is linked to the static detail, which is not a live region.
    const describedBy = await page
      .locator(".relay-graph input")
      .getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(
      await page.locator(`[id="${describedBy}"]`).getAttribute("class"),
    ).toBe("relay-graph-detail");
    const first = page.locator(".relay-graph-nodes button").first();
    await first.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate("window.selected")).toEqual({
      kind: "lane",
      id: "D",
    });
    await page.evaluate(
      (data) => {
        (
          window as unknown as { graph: { update: (value: unknown) => void } }
        ).graph.update(data);
      },
      {
        ...snapshot,
        nodes: [
          { ...snapshot.nodes[0], processStatus: "running" },
          ...snapshot.nodes.slice(1),
        ],
      },
    );
    expect(
      await first.evaluate((element) => element === document.activeElement),
    ).toBe(true);
    expect(await first.getAttribute("aria-pressed")).toBe("true");
    await page.locator("tbody button").first().focus();
    await page.keyboard.press("Space");
    expect(await page.evaluate("window.selected")).toEqual({
      kind: "thread",
      id: "opaque:question",
    });
    await page.locator("details").evaluate((element) => {
      (element as HTMLDetailsElement).open = false;
    });
    await page.evaluate((data) => {
      (
        window as unknown as { graph: { update: (value: unknown) => void } }
      ).graph.update(data);
    }, snapshot);
    expect(await page.locator("details").getAttribute("open")).toBe(null);
    await page.locator("details").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    // Both reorder paths must retain the same focused DOM control and scroll.
    await page.locator("#host").evaluate((element) => {
      const host = element as HTMLElement;
      host.style.height = "240px";
      host.style.overflow = "auto";
      host.style.marginTop = "1000px";
    });
    for (const target of ["node", "thread"]) {
      const result = await page.evaluate(
        ({ data, target }) => {
          const runtime = window as unknown as {
            graph: { update: (value: unknown) => void };
          };
          runtime.graph.update(data);
          const control = document.querySelector<HTMLButtonElement>(
            target === "node"
              ? ".relay-graph-nodes button:nth-child(2)"
              : "tbody tr:nth-child(2) button",
          );
          const host = document.querySelector<HTMLElement>("#host");
          if (!control || !host) throw new Error("Missing synthetic control");
          control.focus({ preventScroll: true });
          host.scrollTop = 75;
          window.scrollTo(0, 200);
          const before = { hostTop: host.scrollTop, pageTop: window.scrollY };
          runtime.graph.update({
            ...data,
            nodes: [data.nodes[1], data.nodes[0], data.nodes[2]],
            edges: [data.edges[1], data.edges[0], ...data.edges.slice(2)],
          });
          return {
            focused: document.activeElement === control,
            sameControl:
              control ===
              document.querySelector(
                target === "node"
                  ? ".relay-graph-nodes button"
                  : "tbody tr button",
              ),
            before,
            after: { hostTop: host.scrollTop, pageTop: window.scrollY },
          };
        },
        { data: snapshot, target },
      );
      expect(result.focused).toBe(true);
      expect(result.sameControl).toBe(true);
      expect(result.after).toEqual(result.before);
      await page.keyboard.press("Enter");
      expect(await page.evaluate("window.selected")).toEqual(
        target === "node"
          ? { kind: "lane", id: "coordinator" }
          : { kind: "thread", id: "opaque:cycle" },
      );
    }
    await page
      .locator("#host")
      .evaluate((element) => element.removeAttribute("style"));
    await page.evaluate((data) => {
      (
        window as unknown as { graph: { update: (value: unknown) => void } }
      ).graph.update(data);
      window.scrollTo(0, 0);
    }, snapshot);
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: join(tmpdir(), `relay-D-P0-21-${width}.png`),
        fullPage: true,
      });
    }
    await page.getByRole("searchbox").fill("no match");
    expect(await page.locator(".relay-graph-nodes button").count()).toBe(0);
    await expectText(page.locator('[role="status"]'), "No matching nodes");
    await page.getByRole("searchbox").fill("");
    const fanout = {
      ...snapshot,
      view: "dependencies",
      nodes: Array.from({ length: 55 }, (_, index) => node(`n${index}`)),
      edges: Array.from({ length: 105 }, (_, index) =>
        edge(`e${index}`, "n0", `n${index % 55}`, "dependency"),
      ),
    };
    await page.evaluate((data) => {
      (
        window as unknown as { graph: { update: (value: unknown) => void } }
      ).graph.update(data);
    }, fanout);
    expect(await page.locator(".relay-graph-nodes button").count()).toBe(50);
    expect(await page.locator("tbody tr").count()).toBe(100);
    await expectText(
      page.locator(".relay-graph-detail"),
      "Truncated: 5 nodes, 5 edges",
    );
    expect(await page.locator('[role="status"]').textContent()).toBe(
      "50 nodes, 100 relationships",
    );
    await page.getByRole("combobox").selectOption("task");
    expect(await page.locator(".relay-graph-nodes button").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.evaluate(() => {
      (window as unknown as { graph: { destroy: () => void } }).graph.destroy();
    });
    expect(await page.locator("#host").textContent()).toBe("");
  } finally {
    await browser.close();
  }
}, 30000);

test("relationship table uses the supplied shared time formatter instead of raw ISO text", async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="host"></main>');
    await page.addScriptTag({
      type: "module",
      content: `${source}\nwindow.renderGraph = renderGraph;`,
    });
    await page.waitForFunction("typeof window.renderGraph === 'function'");
    await page.evaluate(
      (data) => {
        const render = (
          window as unknown as {
            renderGraph: (...args: unknown[]) => unknown;
          }
        ).renderGraph;
        render(document, document.querySelector("#host"), data, {
          formatTime: (value: string) => `formatted<${value.slice(0, 4)}>`,
        });
      },
      {
        version: 1,
        view: "communication",
        nodes: [node("A"), node("B")],
        edges: [{ ...edge("q", "A", "B"), at: "2026-01-02T03:04:05.000Z" }],
        hidden: { nodes: 0, edges: 0 },
      },
    );
    const row = await page.locator("tbody tr").textContent();
    expect(row).toContain("Recorded: formatted<2026>");
    expect(row).not.toContain("T03:04:05");
  } finally {
    await browser.close();
  }
}, 30000);

async function expectText(
  locator: { textContent(): Promise<string | null> },
  text: string,
) {
  expect(await locator.textContent()).toContain(text);
}

test("renderer never draws more than the cap, even for a 2000 node, 5000 edge snapshot; clusters and focus buttons are keyboard operable", async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent('<main id="host"></main>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({
      type: "module",
      content: `${source}\nwindow.renderGraph = renderGraph;`,
    });
    await page.waitForFunction("typeof window.renderGraph === 'function'");
    const result = await page.evaluate(() => {
      const nodes = Array.from({ length: 2000 }, (_, i) => ({
        id: `n${i}`,
        kind: "task",
        label: `n${i}`,
        taskStatus: "working",
        accepted: false,
      }));
      const edges = Array.from({ length: 5000 }, (_, i) => ({
        id: `e${i}`,
        from: `n${i % 2000}`,
        to: `n${(i * 7 + 1) % 2000}`,
        kind: "dependency",
        label: "requires accepted",
        threadId: null,
        at: null,
        unanswered: false,
      }));
      const started = performance.now();
      const win = window as unknown as {
        renderGraph: (...args: unknown[]) => unknown;
      };
      win.renderGraph(document, document.getElementById("host"), {
        version: 1,
        view: "dependencies",
        nodes,
        edges,
        hidden: { nodes: 0, edges: 0 },
        truncated: { nodes: 0, edges: 0 },
      });
      return {
        ms: performance.now() - started,
        svg: document.querySelectorAll(".relay-node").length,
        list: document.querySelectorAll(".relay-graph-nodes > *").length,
        rows: document.querySelectorAll("tbody tr").length,
      };
    });
    expect(result.svg).toBeLessThanOrEqual(50);
    expect(result.list).toBeLessThanOrEqual(50);
    expect(result.rows).toBeLessThanOrEqual(100);
    expect(result.ms).toBeLessThan(5000);
    // Clusters toggle in place and focus buttons call back.
    await page.evaluate(() => {
      document.getElementById("host")?.replaceChildren();
      const win = window as unknown as {
        renderGraph: (...args: unknown[]) => unknown;
        calls: string[];
      };
      win.calls = [];
      const base = {
        role: null,
        harness: null,
        observedModel: null,
        taskId: null,
        processStatus: null,
        taskStatus: "blocked",
        accepted: false,
      };
      win.renderGraph(
        document,
        document.getElementById("host"),
        {
          version: 1,
          view: "dependencies",
          nodes: [
            {
              ...base,
              id: "cluster:owner:a",
              kind: "cluster",
              label: "Agent: <b>a</b>",
              clusterCount: 3,
              clusterNoun: "tasks",
              clusterTrouble: 1,
              clusterOpen: false,
            },
            { ...base, id: "t1", kind: "task", label: "t1" },
          ],
          edges: [],
          hidden: { nodes: 0, edges: 0 },
          truncated: { nodes: 0, edges: 0 },
          scale: { focus: null },
        },
        {
          onToggleCluster: (id: string) => win.calls.push(`toggle:${id}`),
          focusAction: {
            onFocus: (id: string) => win.calls.push(`focus:${id}`),
          },
          onSelect: (value: { id: string }) =>
            win.calls.push(`select:${value.id}`),
        },
      );
    });
    const cluster = page.locator("button[aria-expanded]");
    expect(await cluster.getAttribute("aria-expanded")).toBe("false");
    expect(await cluster.textContent()).toContain("<b>a</b>");
    expect(await page.locator("b").count()).toBe(0);
    await cluster.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Focus on t1" }).click();
    expect(
      await page.evaluate(
        () => (window as unknown as { calls: string[] }).calls,
      ),
    ).toEqual(["toggle:cluster:owner:a", "focus:t1"]);
    // A cluster has no Focus button of its own.
    expect(await page.locator("button.relay-node-focus:visible").count()).toBe(
      1,
    );
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 60000);
