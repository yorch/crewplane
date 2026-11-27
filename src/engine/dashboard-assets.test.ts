import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  modulePaths,
  renderAssetsModule,
  scanDashboardAssets,
  withModulePreload,
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

/** Removes block and line comments (a line comment must not follow a colon, as in a URL). */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
/**
 * Module specifiers written in a script: static `import`/`export ... from`,
 * side-effect imports and dynamic `import(...)` with a string or template
 * literal. A dynamic import whose argument is computed is reported as such.
 */
const specifiers = (source: string) => {
  const code = stripComments(source);
  const found: string[] = [];
  const quoted = /["'`]((?:[^"'`\\\n]|\\.)*)["'`]/;
  for (const match of code.matchAll(
    /(?:\bfrom\s*|\bimport\s*)(["'])([^"'\n]+)\1/g,
  ))
    found.push(match[2] ?? "");
  for (const match of code.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const argument = (match[1] ?? "").trim();
    const literal = quoted.exec(argument);
    if (
      literal &&
      argument.length === (literal[0]?.length ?? -1) &&
      !argument.includes("${")
    )
      found.push(literal[1] ?? "");
    else found.push(`<dynamic: ${argument}>`);
  }
  return found;
};
/** Resolves a module specifier written in an embedded script to an embedded name. */
const resolveSpecifier = (from: string, value: string) => {
  // Browsers accept only relative (./, ../) and absolute-path (/) specifiers.
  if (!/^(?:\.\.?\/|\/)/.test(value))
    throw new Error(
      `${from}: "${value}" is not a browser-resolvable specifier`,
    );
  return value.startsWith("/")
    ? value.slice(1)
    : posix.normalize(posix.join(posix.dirname(from), value));
};

it("serves every module that any dashboard script imports", () => {
  let checked = 0;
  for (const name of scanned.filter((n) => n.endsWith(".js"))) {
    for (const value of specifiers(read(name))) {
      const target = resolveSpecifier(name, value);
      expect(
        Object.hasOwn(embeddedAssets, target),
        `${name} -> ${target}`,
      ).toBe(true);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(30);
});

it("finds every import form and ignores commented-out ones", () => {
  const source = [
    'import a from "./a.js";',
    "import { b } from '../b.js';",
    'import "/side.js";',
    'export * from "./re.js";',
    'const c = await import("./dyn.js");',
    "const d = import(`./tpl.js`);",
    `const e = import(\`./x/${"$"}{name}.js\`);`,
    "const f = import(computed);",
    '/* import x from "./block.js"; */',
    '/* multi\nline import y from "./multi.js"; */',
    '// import z from "./line.js";',
    'const url = "https://example.test/x"; import w from "./after-url.js";',
  ].join("\n");
  expect(specifiers(source)).toEqual([
    "./a.js",
    "../b.js",
    "/side.js",
    "./re.js",
    "./after-url.js",
    "./dyn.js",
    "./tpl.js",
    `<dynamic: \`./x/${"$"}{name}.js\`>`,
    "<dynamic: computed>",
  ]);
});

it("rejects specifiers a browser cannot resolve", () => {
  for (const bad of ["lodash", "app/store.js", "node:fs", "store.js", ""])
    expect(() => resolveSpecifier("dashboard.js", bad), bad).toThrow(
      /not a browser-resolvable/,
    );
  expect(resolveSpecifier("app/a.js", "./b.js")).toBe("app/b.js");
  expect(resolveSpecifier("app/a.js", "../dashboard.js")).toBe("dashboard.js");
  expect(resolveSpecifier("app/a.js", "/graph-renderer.js")).toBe(
    "graph-renderer.js",
  );
  // A dynamic import with a computed argument is surfaced, never silently skipped.
  expect(() =>
    resolveSpecifier("a.js", specifiers("import(x)")[0] ?? ""),
  ).toThrow();
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

it("serves each embedded file with its content type, nosniff and the strict policy (blob: only for images and media)", async () => {
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
    // Only img-src and media-src admit blob: (the evidence gallery shows
    // fetched artifacts from object URLs); everything else is unchanged.
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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

it("index.html preloads exactly the module graph, generated, ordered and up to date", () => {
  const page = read("index.html");
  // Up to date: regenerating changes nothing (CI also checks this file).
  expect(withModulePreload(dashboardDir, page)).toBe(page);
  const linked = [
    ...page.matchAll(/<link rel="modulepreload" href="(\/[^"]+)" \/>/g),
  ].map((match) => match[1] ?? "");
  expect(linked.length).toBeGreaterThan(50);
  expect(new Set(linked).size).toBe(linked.length);
  // Independently: walk the imports with this file's own parser from the
  // module scripts the page names, and compare as sets.
  const entries = [
    ...page.matchAll(/<script type="module" src="(\/[^"]+)"><\/script>/g),
  ].map((match) => match[1] ?? "");
  expect(entries).toEqual(["/graph-viewer.js", "/dashboard.js", "/runs.js"]);
  const reach = new Set<string>();
  const walk = (path: string) => {
    if (reach.has(path)) return;
    reach.add(path);
    const file = path === "/runs.js" ? "run-viewer.js" : path.slice(1);
    for (const value of specifiers(read(file)))
      walk(`/${resolveSpecifier(file, value)}`);
  };
  for (const entry of entries) walk(entry);
  expect(new Set(linked)).toEqual(reach);
  // Every linked path is served, same origin, and listed before the scripts.
  const routes = assetRoutes();
  for (const path of linked) expect(routes.has(path), path).toBe(true);
  expect(page.lastIndexOf("modulepreload")).toBeLessThan(
    page.indexOf('<script type="module"'),
  );
  expect(modulePaths(dashboardDir, page)).toEqual(linked);
  // No inline script or handler was added for it (the policy forbids them).
  expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/);
});

it("regenerates a stale or missing preload block deterministically", () => {
  const page = read("index.html");
  const stripped = page.replace(
    /<!-- modulepreload:start[\s\S]*?<!-- modulepreload:end -->\n\s*/,
    "",
  );
  expect(stripped).not.toContain("modulepreload");
  const first = withModulePreload(dashboardDir, stripped);
  expect(first).toBe(page);
  const stale = page.replace(
    '<link rel="modulepreload" href="/app/store.js" />',
    '<link rel="modulepreload" href="/app/gone.js" />',
  );
  expect(withModulePreload(dashboardDir, stale)).toBe(page);
  expect(() =>
    withModulePreload(
      dashboardDir,
      page.replace("<!-- modulepreload:end -->", ""),
    ),
  ).toThrow(/unterminated/);
});
