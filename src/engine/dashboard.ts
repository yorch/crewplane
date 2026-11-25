import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ensureControlDirectory } from "../control.ts";
import { publishJson } from "../io.ts";
import { discoverProject, validId, validTaskId } from "../project.ts";
import { main as coordination } from "./agents.mjs";
import { embeddedAssets } from "./assets.ts";
import { control } from "./control-policy.ts";
import { createEvidenceStore } from "./evidence/store.ts";
import { validHarness } from "./harness.ts";
import { createTraceStore, traceIdPattern } from "./operational-traces.ts";
import { snapshot } from "./read-model.ts";

export {
  headlessStatus,
  monitorStatus,
  parseTask,
  plannedTasks,
  snapshot,
} from "./read-model.ts";

const tokenMatches = (given: unknown, expected: string) => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Fresh per-launch secret for dashboard read access. */
export const newSessionToken = () => randomBytes(32).toString("base64url");
export function createDashboard(
  root: string,
  options: {
    controls?: { token: string };
    /**
     * Require a per-launch session on every `/api/*` read, presented in the
     * `x-crewplane-session` header. The dashboard page takes it from the
     * `#token=…` URL fragment (never sent to a server) into sessionStorage.
     * Omitting it disables read auth entirely, which is only appropriate for
     * in-process tests: any listener on 127.0.0.1 is reachable by other local
     * users.
     */
    session?: { token: string };
  } = {},
) {
  let traces: ReturnType<typeof createTraceStore> | undefined;
  const getTraces = () =>
    (traces ??= (async () => {
      const { store } = (await coordination(["init"], root)) as {
        store: string;
      };
      return createTraceStore(join(store, "operational-traces"));
    })().catch((error) => {
      traces = undefined;
      throw error;
    }));
  let evidence: ReturnType<typeof createEvidenceStore> | undefined;
  const getEvidence = () =>
    (evidence ??= (async () => {
      const { store } = (await coordination(["init"], root)) as {
        store: string;
      };
      return createEvidenceStore(join(store, "evidence"));
    })().catch((error) => {
      evidence = undefined;
      throw error;
    }));
  return createServer(async (request, response) => {
    const address = response.socket?.localPort;
    const expectedHost = `127.0.0.1:${address}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (
      request.headers.host !== expectedHost ||
      (request.headers.origin &&
        request.headers.origin !== `http://${expectedHost}`)
    ) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (request.method === "POST" && request.url === "/api/control") {
      const controls = options.controls;
      if (
        !controls ||
        request.headers.origin !== `http://${expectedHost}` ||
        !tokenMatches(request.headers["x-crewplane-token"], controls.token) ||
        request.headers["content-type"] !== "application/json"
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += (chunk as Buffer).length;
          if (size > 4096) {
            response.writeHead(413).end("Too large");
            return;
          }
          chunks.push(chunk as Buffer);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          response.writeHead(400).end("Invalid JSON");
          return;
        }
        const raw = (body ?? {}) as Record<string, unknown>;
        if (raw.action !== "pause" && raw.action !== "cancel") {
          response.writeHead(400).end("Unsupported control");
          return;
        }
        const value = control({
          v: 2,
          action: raw.action,
          ...(typeof raw.lane === "string" ? { lane: raw.lane } : {}),
          ...(typeof raw.run === "string" ? { run: raw.run } : {}),
          ...(raw.all === true ? { all: true } : {}),
          ...(typeof raw.expectRev === "number"
            ? { expectRev: raw.expectRev }
            : {}),
          issuer: "dashboard",
          at: new Date().toISOString(),
        });
        if (value.action === "invalid") {
          response.writeHead(400).end("Invalid control");
          return;
        }
        // Commands are authority: they go to the private control directory.
        const controlDir = discoverProject(root).control;
        await ensureControlDirectory(controlDir);
        const directory = join(controlDir, "commands");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const id = randomUUID();
        await publishJson(join(directory, `${id}.json`), value);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ queued: value.action, id }));
      } catch {
        if (!response.headersSent)
          response.writeHead(503, { "Content-Type": "application/json" });
        if (!response.writableEnded)
          response.end(
            JSON.stringify({ error: "Control could not be queued. Retry." }),
          );
      }
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    const session = options.session;
    // Static pages and scripts are public embedded assets; only data routes
    // need the per-launch session, which the page keeps in sessionStorage
    // (origin-scoped, unlike a cookie) and sends as a header.
    if (
      session &&
      request.url?.startsWith("/api/") &&
      !tokenMatches(request.headers["x-crewplane-session"], session.token)
    ) {
      response
        .writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
        .end(
          JSON.stringify({
            error:
              "Session missing or expired. Reopen the URL printed by crewplane dashboard.",
          }),
        );
      return;
    }
    try {
      if (request.url === "/api/snapshot") {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(await snapshot(root)));
        return;
      }
      if (request.url?.startsWith("/api/evidence")) {
        const url = new URL(request.url, `http://${expectedHost}`);
        const parts = url.pathname.split("/");
        const store = await getEvidence();
        let result: unknown;
        if (url.pathname === "/api/evidence") {
          const task = url.searchParams.get("task");
          if (task && !validTaskId(task)) {
            response.writeHead(400).end("Invalid task");
            return;
          }
          result = await store.list(task ? { task } : {});
        } else if (
          parts.length === 5 &&
          /^qa_[a-f0-9]{32}$/.test(parts[4] ?? "") &&
          parts[3] === "runs"
        ) {
          result = await store.manifest(parts[4] ?? "");
        } else if (
          parts.length === 5 &&
          /^ev_[a-f0-9]{32}$/.test(parts[4] ?? "") &&
          parts[3] === "artifacts"
        ) {
          const artifact = await store.read(parts[4] ?? "");
          if (!artifact) {
            response.writeHead(404).end("Not found");
            return;
          }
          response.setHeader("Content-Type", artifact.artifact.mime);
          response.end(artifact.content);
          return;
        } else {
          response.writeHead(404).end("Not found");
          return;
        }
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(result));
        return;
      }
      if (request.url?.startsWith("/api/runs")) {
        const url = new URL(request.url, `http://${expectedHost}`);
        const parts = url.pathname.split("/");
        const number = (name: string, fallback: number) => {
          const v = url.searchParams.get(name);
          if (v !== null && !/^\d{1,8}$/.test(v)) throw Error("Invalid cursor");
          return v === null ? fallback : Number(v);
        };
        try {
          const store = await getTraces();
          let value: unknown;
          if (url.pathname === "/api/runs") {
            const task = url.searchParams.get("task");
            if (task && !validTaskId(task)) throw Error("Invalid task");
            const lane = url.searchParams.get("lane"),
              harness = url.searchParams.get("harness"),
              before = url.searchParams.get("before");
            if ((lane && !validId(lane)) || (harness && !validHarness(harness)))
              throw Error("Invalid filter");
            value = await store.list({
              ...(lane ? { lane } : {}),
              ...(task ? { task } : {}),
              ...(harness ? { harness } : {}),
              ...(before ? { before } : {}),
              limit: number("limit", 20),
            });
          } else if (parts.length === 4 && traceIdPattern.test(parts[3] ?? ""))
            value = await store.tail(
              parts[3] ?? "",
              number("after", 0),
              number("limit", 100),
            );
          else {
            response.writeHead(404).end("Not found");
            return;
          }
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify(value));
        } catch {
          response
            .writeHead(400, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({ error: "Run unavailable or invalid request" }),
            );
        }
        return;
      }
      const routes: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/dashboard.js": ["dashboard.js", "text/javascript"],
        "/runs.js": ["run-viewer.js", "text/javascript"],
        "/graph-viewer.js": ["graph-viewer.js", "text/javascript"],
        "/graph-renderer.js": ["graph-renderer.js", "text/javascript"],
        "/graph-renderer.css": ["graph-renderer.css", "text/css"],
        "/dashboard.css": ["dashboard.css", "text/css"],
      };
      const route = routes[request.url ?? ""];
      if (!route) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.setHeader("Content-Type", `${route[1]}; charset=utf-8`);
      response.end(embeddedAssets[route[0]]);
    } catch {
      response.writeHead(503, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error:
            "Could not read coordination data. Check task cards and local board, then retry.",
        }),
      );
    }
  });
}
