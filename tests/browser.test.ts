import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

it("renders the embedded dashboard with custom agents, narrow layouts and safe refresh", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewplane-browser-")),
  );
  const bin = resolve("dist/crewplane");
  const cli = (...args: string[]) =>
    execFileSync(bin, ["--project", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, CREWPLANE_NO_AUTO_UPDATE: "1" },
    });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  let child: ReturnType<typeof spawn> | undefined;
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  try {
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
    await mkdir(join(root, "tickets"));
    await writeFile(
      join(root, "tickets/WEB-1.md"),
      "# WEB-1 — Synthetic browser task\nOwner: custom-builder.\nGoal: browser layout and safe refresh\n",
    );
    git("add", ".");
    git("commit", "-qm", "test: initialize browser fixture");
    cli(
      "agents",
      "assign",
      "--agent",
      "captain",
      "--task",
      "WEB-1",
      "--owner",
      "custom-builder",
      "--ref",
      "HEAD",
      "--text",
      "Synthetic browser scope",
    );
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        server.close(() => resolve(typeof a === "object" && a ? a.port : 0));
      });
    });
    child = spawn(
      bin,
      ["--project", root, "dashboard", "--port", String(port)],
      { stdio: "pipe" },
    );
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        await page.goto(`http://127.0.0.1:${port}/`);
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await page.locator("#connection").filter({ hasText: "Live" }).waitFor();
    // Tasks is a separate view now; the old single-page layout showed it up front.
    await page.locator('a[data-nav="tasks"]').click();
    await page.locator("#view-title").filter({ hasText: "Tasks" }).waitFor();
    await page.locator("#tasks .card").first().waitFor();
    const options = await page.locator("#agent option").allTextContents();
    expect(options).toContain("custom-builder");
    expect(options).not.toContain("A");
    const shots = resolve(".crewplane-local/qa");
    await mkdir(shots, { recursive: true });
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: join(shots, `dashboard-${width}.png`),
        fullPage: true,
      });
    }
    await page.locator("#search").fill("Synthetic");
    await page.locator("#search").focus();
    cli(
      "agents",
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
    await page.waitForTimeout(5500);
    expect(await page.locator("#search").inputValue()).toBe("Synthetic");
    expect(
      await page
        .locator("#search")
        .evaluate((node) => document.activeElement === node),
    ).toBe(true);
    expect(await page.evaluate(() => "pwned" in window)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        child?.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
