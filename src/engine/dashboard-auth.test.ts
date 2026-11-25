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
it("serves the public embedded page and scripts but refuses every data route without the session", async () => {
  for (const path of ["/", "/dashboard.js", "/runs.js", "/dashboard.css"])
    expect((await get(path)).status, path).toBe(200);
  for (const path of [
    "/api/snapshot",
    "/api/runs",
    "/api/runs/tr_00000000000000000000000000000000",
    "/api/evidence",
    "/api/evidence/artifacts/ev_00000000000000000000000000000000",
  ]) {
    const response = await get(path);
    expect(response.status, path).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Session missing or expired");
  }
  for (const headers of [
    { "x-crewplane-session": "wrong" },
    { "x-crewplane-session": "" },
    { "x-crewplane-token": token },
    { cookie: `crewplane_session_${port}=${token}` },
  ])
    expect((await get("/api/snapshot", headers)).status).toBe(401);
  // The token in a query string is never an accepted credential.
  expect((await get(`/api/snapshot?token=${token}`)).status).toBe(401);
  expect((await get(`/?token=${token}`)).headers.get("set-cookie")).toBeNull();
});
it("returns data to a request carrying the session header", async () => {
  const snapshot = await get("/api/snapshot", {
    "x-crewplane-session": token,
  });
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toHaveProperty("tasks");
  expect(
    (await get("/api/runs", { "x-crewplane-session": token })).status,
  ).toBe(200);
});
it("answers odd request targets without hanging and keeps the Host and Origin checks first", async () => {
  const raw = (path: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port, path, headers },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.setTimeout(3000, () => request.destroy(new Error("hung")));
      request.on("error", reject);
      request.end();
    });
  expect(await raw("//")).toBe(404);
  expect(await raw("//?token=x")).toBe(404);
  expect(await raw("/api/%2e%2e/snapshot")).toBe(401);
  expect(
    await raw("/api/snapshot", {
      host: "evil.example",
      "x-crewplane-session": token,
    }),
  ).toBe(403);
  expect(
    (
      await get("/api/snapshot", {
        "x-crewplane-session": token,
        origin: "http://foreign.invalid",
      })
    ).status,
  ).toBe(403);
});
