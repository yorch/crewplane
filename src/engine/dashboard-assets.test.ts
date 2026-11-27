import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  renderAssetsModule,
  scanDashboardAssets,
} from "../../scripts/dashboard-assets.ts";
import { embeddedAssets } from "./assets.ts";
import { createDashboard } from "./dashboard.ts";
import { assetRoutes } from "./dashboard-assets.ts";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "dashboard");
const scanned = scanDashboardAssets(dashboardDir);
const read = (name: string) => readFileSync(join(dashboardDir, name), "utf8");

it("embeds exactly the runtime files found under src/engine/dashboard, so a new module cannot be forgotten", () => {
  expect(Object.keys(embeddedAssets).sort()).toEqual(scanned);
  // Nested modules are included; server-side TypeScript and tests never are.
  expect(scanned).toEqual(
    expect.arrayContaining(["index.html", "dashboard.js", "app/store.js"]),
  );
  expect(scanned.filter((name) => !/\.(html|js|css)$/.test(name))).toEqual([]);
  expect(scanned.filter((name) => /\.test\./.test(name))).toEqual([]);
  expect(scanned).not.toContain("headless.ts");
  for (const name of scanned)
    expect(embeddedAssets[name], name).toBe(read(name));
});

it("keeps the generated module and text copies in step with a fresh scan", () => {
  const generated = readFileSync(join(dashboardDir, "../assets.ts"), "utf8");
  expect(generated).toBe(renderAssetsModule(scanned));
  // Deterministic: sorted names, stable output.
  expect(scanned).toEqual([...scanned].sort());
  expect(renderAssetsModule(scanned)).toBe(renderAssetsModule(scanned));
});

const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
/** Resolves a module specifier written in an embedded script to an embedded name. */
const resolveSpecifier = (from: string, value: string) =>
  value.startsWith("/")
    ? value.slice(1)
    : posix.normalize(posix.join(posix.dirname(from), value));

it("serves every module that any dashboard script imports", () => {
  let checked = 0;
  for (const name of scanned.filter((n) => n.endsWith(".js"))) {
    const code = read(name).replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(specifier)) {
      const target = resolveSpecifier(name, match[1] ?? "");
      expect(
        Object.hasOwn(embeddedAssets, target),
        `${name} -> ${target}`,
      ).toBe(true);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(30);
});

it("serves every script and stylesheet the page references", () => {
  const routes = assetRoutes();
  const page = read("index.html");
  const references = [...page.matchAll(/\b(?:src|href)="(\/[^"#]*)"/g)].map(
    (match) => match[1] ?? "",
  );
  expect(references).toEqual(
    expect.arrayContaining(["/dashboard.css", "/dashboard.js"]),
  );
  for (const path of references) expect(routes.has(path), path).toBe(true);
  // The entry is a module, so its relative imports resolve against /.
  expect(page).toContain('<script type="module" src="/dashboard.js"></script>');
  expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/);
});

let server: ReturnType<typeof createDashboard>;
let port = 0;
const root = mkdtempSync(join(tmpdir(), "crewplane-assets-"));
beforeAll(async () => {
  server = createDashboard(root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  port = address.port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
/** Sends the path unnormalized, which fetch() would not. */
const raw = (path: string) =>
  new Promise<{ status: number; type: string | undefined; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path, method: "GET" },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              type: response.headers["content-type"],
              body,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );

it("serves each embedded file with its content type, nosniff and the unchanged strict policy", async () => {
  for (const name of scanned) {
    const path = name === "index.html" ? "/" : `/${name}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(response.status, path).toBe(200);
    const expected = name.endsWith(".js")
      ? "text/javascript"
      : name.endsWith(".css")
        ? "text/css"
        : "text/html";
    expect(response.headers.get("content-type"), path).toBe(
      `${expected}; charset=utf-8`,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'; script-src 'self'; style-src 'self';",
    );
    expect(await response.text(), path).toBe(embeddedAssets[name]);
  }
  expect((await raw("/runs.js")).body).toBe(embeddedAssets["run-viewer.js"]);
});

it("refuses unknown, traversing and decorated asset paths", async () => {
  for (const path of [
    "/app/nope.js",
    "/app",
    "/app/",
    "/app/store.js/",
    "/app//store.js",
    "//app/store.js",
    "/app/../dashboard.js",
    "/app/%2e%2e/dashboard.js",
    "/app/%2E%2E%2Fdashboard.js",
    "/app\\store.js",
    "/../package.json",
    "/..%2fpackage.json",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/src/engine/dashboard/dashboard.js",
    "/headless.ts",
    "/graph-builder.ts",
    "/dashboard.js?v=1",
    "/dashboard.js#x",
    "/index.html",
    "/__proto__",
    "/constructor",
    "/app/__proto__",
    "/app/store.js%00.css",
  ]) {
    const result = await raw(path);
    expect(result.status, path).toBe(404);
    expect(result.body, path).toBe("Not found");
  }
});

it("only routes names that are embedded", () => {
  const routes = assetRoutes({
    "index.html": "",
    "app/x.js": "",
    "notes.txt": "",
  });
  expect([...routes.keys()].sort()).toEqual(["/", "/app/x.js"]);
  expect(routes.get("/app/x.js")?.type).toBe("text/javascript");
});
