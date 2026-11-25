import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDashboard, newSessionToken } from "./dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "crewplane-auth-"));
const token = newSessionToken();
let server: ReturnType<typeof createDashboard>;
let url = "";
let port = 0;
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { headers, redirect: "manual" });
beforeAll(async () => {
  writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: auth fixture");
  server = createDashboard(root, { session: { token } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  port = address.port;
  url = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
it("generates distinct unguessable session tokens", () => {
  const a = newSessionToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(newSessionToken()).not.toBe(a);
});
it("refuses every read without the session, including pages, snapshot, runs and evidence", async () => {
  for (const path of [
    "/",
    "/dashboard.js",
    "/api/snapshot",
    "/api/runs",
    "/api/evidence",
  ]) {
    const response = await get(path);
    expect(response.status, path).toBe(401);
    expect(await response.text()).not.toContain("tasks");
  }
  expect((await get("/", { cookie: "crewplane_session=wrong" })).status).toBe(
    401,
  );
  expect((await get("/?token=wrong")).status).toBe(401);
  expect((await get("/api/snapshot?token=" + token)).status).toBe(401);
  expect(
    (await get("/api/snapshot", { "x-crewplane-token": "x" })).status,
  ).toBe(401);
});
it("trades the token for an HttpOnly SameSite=Strict cookie and a clean redirect", async () => {
  const response = await get(`/?token=${token}`);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/");
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain(`crewplane_session_${port}=${token}`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
  const pair = cookie.split(";")[0] ?? "";
  const page = await get("/", { cookie: pair });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<html");
  const snapshot = await get("/api/snapshot", { cookie: pair });
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toHaveProperty("tasks");
});
it("accepts the token in a header for scripts and keeps the Host and Origin checks first", async () => {
  expect(
    (await get("/api/snapshot", { "x-crewplane-token": token })).status,
  ).toBe(200);
  expect(
    (
      await get("/api/snapshot", {
        "x-crewplane-token": token,
        origin: "http://foreign.invalid",
      })
    ).status,
  ).toBe(403);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/snapshot",
        headers: { host: "evil.example", "x-crewplane-token": token },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
  expect(status).toBe(403);
});
