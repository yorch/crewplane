import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createDashboard, parseTask, plannedTasks } from "./dashboard.ts";
import { createTraceStore } from "./operational-traces.ts";

it("keeps task scope notes while distinguishing acceptance, review and blocked work", () => {
  const markdown =
    "# P1-01 — Synthetic task\nOwner lane: B. Status: queued / unclaimed.\nGoal: scoped goal\nPrerequisites: M0\n";
  const live = {
    task: "P1-01",
    assignment: { owner: "B", baseCommit: "base", at: "date", text: "scope" },
    claim: null,
    status: {
      state: "blocked",
      text: "Need a contract",
      at: "date",
      commit: null,
    },
    accepted: null,
  };
  expect(parseTask("P1-01", markdown).state).toBe("todo");
  expect(
    parseTask("P1-01", markdown, {
      ...live,
      status: null,
      claim: { branch: "synthetic", worktree: "/synthetic", at: "date" },
    }).state,
  ).toBe("assigned");
  expect(parseTask("P1-01", markdown, live).state).toBe("blocked");
  expect(
    parseTask("P1-01", markdown, {
      ...live,
      status: { ...live.status, state: "ready" },
    }).state,
  ).toBe("review");
  const accepted = parseTask("P1-01", markdown, {
    ...live,
    accepted: { commit: "sha", at: "date", text: "Only a bounded slice" },
  });
  expect(accepted.state).toBe("completed");
  expect(accepted.documentedStatus).toBe("queued / unclaimed.");
  expect(accepted.live?.accepted?.text).toContain("bounded slice");
  expect(
    parseTask(
      "P0-01",
      "Owner: coordinator. Phase: 0. Status: complete; baseline only",
    ).state,
  ).toBe("completed");
});

it("serves fresh tasks/messages without exposing files or allowing mutations/cross-origin reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-dashboard-"));
  const cli = fileURLToPath(new URL("./agents.mjs", import.meta.url));
  const env = { ...process.env, CREWPLANE_COORD_DIR: "" };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  const server = createDashboard(root);
  const previousStore = process.env.CREWPLANE_COORD_DIR;
  process.env.CREWPLANE_COORD_DIR = "";
  try {
    await mkdir(join(root, "tasks"), { recursive: true });
    await writeFile(join(root, "STATUS.md"), "M0 complete; M1 open");
    await writeFile(
      join(root, "tasks/P1-01.md"),
      "# P1-01 — Synthetic\nOwner lane: B. Status: queued\nGoal: test\n",
    );
    git("init", "-q", "--initial-branch=main");
    git("config", "user.email", "synthetic@example.invalid");
    git("config", "user.name", "Synthetic Test");
    git("add", ".");
    git("commit", "-qm", "test: add synthetic task");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(url)).headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect((await fetch(`${url}/.env.local`)).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect(
      (
        await fetch(`${url}/api/snapshot`, {
          headers: { Origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(403);
    const foreignHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(url, { headers: { Host: "example.invalid" } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on("error", reject);
      },
    );
    expect(foreignHostStatus).toBe(403);
    const initial = await (await fetch(`${url}/api/snapshot`)).json();
    expect(initial.tasks).toHaveLength(1);
    expect(initial.messages).toEqual([]);
    expect(initial.graphs.dependencies.version).toBe(1);
    expect(initial.graphs.dependencies.edges).toEqual([]);
    expect(initial.graphCoverage.dependencyMetadata).toContain("unavailable");
    for (const asset of [
      "graph-viewer.js",
      "graph-renderer.js",
      "graph-renderer.css",
    ])
      expect((await fetch(`${url}/${asset}`)).status).toBe(200);
    const traceId = "1794100000001-00000000-0000-4000-8000-000000000001";
    const evidenceRoot = join(root, ".crewplane-state/evidence");
    await writeFile(evidenceRoot, "synthetic initialization obstruction", {
      mode: 0o600,
    });
    expect((await fetch(`${url}/api/evidence`)).status).toBe(503);
    await rm(evidenceRoot);
    const evidenceResponse = await fetch(`${url}/api/evidence`);
    expect(evidenceResponse.status).toBe(200);
    expect((await evidenceResponse.json()).runs).toEqual([]);
    const traces = await createTraceStore(
      join(root, ".crewplane-state/operational-traces"),
    );
    const writer = await traces.begin({
      runId: traceId,
      lane: "coordinator",
      task: "P1-08",
      harness: "codex",
    });
    await writer.emit({ kind: "started" });
    const history = await (
      await fetch(`${url}/api/runs?lane=coordinator&limit=1`)
    ).json();
    expect(history.runs[0].runId).toBe(traceId);
    expect(
      (await (await fetch(`${url}/api/runs?harness=codex`)).json()).runs[0]
        .runId,
    ).toBe(traceId);
    for (const harness of ["claude", "opencode", "pi"])
      expect(
        (await (await fetch(`${url}/api/runs?harness=${harness}`)).json()).runs,
      ).toEqual([]);
    expect((await fetch(`${url}/api/runs?harness=unknown`)).status).toBe(400);
    const tail = await (
      await fetch(`${url}/api/runs/${traceId}?after=0&limit=10`)
    ).json();
    expect(tail.meta.status).toBe("running");
    expect(tail.events[0].kind).toBe("started");
    expect((await fetch(`${url}/api/runs/${traceId}?limit=1000`)).status).toBe(
      400,
    );
    expect((await fetch(`${url}/api/runs/%2e%2e%2fsecret`)).status).toBe(404);
    expect((await fetch(`${url}/api/runs`, { method: "POST" })).status).toBe(
      405,
    );
    expect(
      (
        await fetch(`${url}/api/runs`, {
          headers: { Origin: "https://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${url}/.crewplane-state/supervisor/runs/raw.jsonl`)).status,
    ).toBe(404);
    await writer.finish("finished", "waiting");
    await writeFile(
      join(root, "tasks/P1-01.md"),
      "# P1-01 — Synthetic\nOwner lane: B. Status: complete; scope only\n",
    );
    const hostile = '<img src=x onerror="alert(1)">';
    execFileSync(
      process.execPath,
      [
        cli,
        "send",
        "--agent",
        "B",
        "--to",
        "coordinator",
        "--kind",
        "question",
        "--task",
        "P1-01",
        "--text",
        hostile,
      ],
      { cwd: root, env },
    );
    const updated = await (await fetch(`${url}/api/snapshot`)).json();
    expect(updated.tasks[0].state).toBe("completed");
    expect(updated.messages[0].text).toBe(hostile);
    expect(updated.unanswered).toHaveLength(1);
    expect(updated.graphs.communication.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "B",
          to: "coordinator",
          kind: "awaiting-answer",
          unanswered: true,
        }),
      ]),
    );
    expect(JSON.stringify(updated.graphs)).not.toContain(hostile);
    expect((await fetch(`${url}/dashboard.js`)).status).toBe(200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousStore === undefined) delete process.env.CREWPLANE_COORD_DIR;
    else process.env.CREWPLANE_COORD_DIR = previousStore;
    await rm(root, { recursive: true, force: true });
  }
});

it("includes unscoped roadmap items without duplicating cards or inventing ownership", () => {
  const tasks = plannedTasks(
    "Illustrative task IDs: P1-01 auth; P4-01 matching/corrections; P7-01 deployment. Split after M0.",
    new Set(["P1-01"]),
  );
  expect(tasks.map((t) => t.id)).toEqual(["P4-01", "P7-01"]);
  expect(tasks[0]?.owner).toBe("—");
  expect(tasks[0]?.state).toBe("todo");
  expect(tasks[0]?.goal).toContain("not authorized");
});
