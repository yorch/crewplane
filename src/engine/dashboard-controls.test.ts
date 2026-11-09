import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDashboard } from "./dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "crewplane-controls-"));
const token = "11111111-1111-4111-8111-111111111111";
let server: ReturnType<typeof createDashboard>;
let url = "";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
const post = (body: unknown, headers: Record<string, string>) =>
  fetch(`${url}/api/control`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
beforeAll(async () => {
  writeFileSync(join(root, ".gitignore"), ".crewplane-state/\n");
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "test: controls fixture");
  server = createDashboard(root, { controls: { token } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
const origin = () => ({ origin: url, "x-crewplane-token": token });
it("requires exact Origin, token and JSON for hold/cancel only", async () => {
  expect(
    (
      await post(
        { action: "pause", lane: "builder" },
        {
          "x-crewplane-token": token,
        },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await post(
        { action: "pause", lane: "builder" },
        {
          origin: "http://foreign.invalid",
          "x-crewplane-token": token,
        },
      )
    ).status,
  ).toBe(403);
  expect(
    (await post({ action: "pause", lane: "builder" }, { origin: url })).status,
  ).toBe(403);
  expect(
    (
      await post(
        { action: "pause", lane: "builder" },
        {
          ...origin(),
          "x-crewplane-token": "wrong",
        },
      )
    ).status,
  ).toBe(403);
  expect(
    (await post({ action: "retry", lane: "builder" }, { ...origin() })).status,
  ).toBe(400);
  expect(
    (await post({ action: "pause", lane: "builder" }, { ...origin() })).status,
  ).toBe(200);
  expect(
    (
      await post(
        {
          action: "cancel",
          lane: "builder",
          run: "1794100000001-00000000-0000-4000-8000-000000000001",
        },
        { ...origin() },
      )
    ).status,
  ).toBe(200);
  const directory = join(root, ".crewplane-state/supervisor/commands");
  const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  const commands = files.map(
    (file) =>
      JSON.parse(readFileSync(join(directory, file), "utf8")) as {
        action: string;
      },
  );
  expect(commands.map((command) => command.action).sort()).toEqual([
    "cancel",
    "pause",
  ]);
});
