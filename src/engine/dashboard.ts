import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { plannedTasks, snapshot } from "../board.ts";
import {
  bindControl,
  controlDirectory,
  ensureControlDirectory,
} from "../control.ts";
import { sha256Hex } from "../hash.ts";
import { publishJson } from "../io.ts";
import {
  discoverProject,
  projectPolicy,
  validId,
  validTaskId,
} from "../project.ts";
import { main as coordination } from "./agents.mjs";
import { embeddedAssets } from "./assets.ts";
import { control } from "./control-policy.ts";
import { configView } from "./dashboard/config-view.ts";
import {
  controlLogView,
  parseControlLogQuery,
} from "./dashboard/control-log.ts";
import {
  evidenceArtifactHeaders,
  evidenceArtifactList,
  evidenceListDefaultLimit,
  evidenceListMaxLimit,
} from "./dashboard/evidence-view.ts";
import {
  createLiveHub,
  type LiveTimers,
  type SseSink,
} from "./dashboard/live.ts";
import { readRuntime } from "./dashboard/runtime-files.ts";
import { type TraceCoverage, usageView } from "./dashboard/usage-view.ts";
import { assetRoutes } from "./dashboard-assets.ts";
import { createEvidenceStore } from "./evidence/store.ts";
import { validHarness } from "./harness.ts";
import { createTraceStore, traceIdPattern } from "./operational-traces.ts";

export { headlessStatus, monitorStatus, parseTask } from "./read-model.ts";
export { plannedTasks, snapshot };

const tokenMatches = (given: unknown, expected: string) => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Fresh per-launch secret for dashboard read access. */
export const newSessionToken = () => randomBytes(32).toString("base64url");
const storeOf = async (root: string) =>
  ((await coordination(["init"], root)) as { store: string }).store;
/** Initialize once on first use; a failed initialization is retried on the next call. */
function lazyStore<T>(create: () => Promise<T>) {
  let value: Promise<T> | undefined;
  return () =>
    (value ??= create().catch((error) => {
      value = undefined;
      throw error;
    }));
}
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
    /** Live-update tuning; the defaults suit production, tests inject timers. */
    live?: {
      intervalMs?: number;
      heartbeatMs?: number;
      maxClients?: number;
      maxBufferedBytes?: number;
      slowClientMs?: number;
      timers?: LiveTimers;
    };
  } = {},
) {
  const getTraces = lazyStore(async () =>
    createTraceStore(join(await storeOf(root), "operational-traces")),
  );
  const getEvidence = lazyStore(async () =>
    createEvidenceStore(join(await storeOf(root), "evidence")),
  );
  const routes = assetRoutes();
  const unreadable =
    "Could not read coordination data. Check task cards and local board, then retry.";
  // One computation serves every event-stream client; it only runs while a
  // client is connected. The hash ignores `updatedAt` so an unchanged board
  // never produces a push.
  const live = createLiveHub({
    ...options.live,
    errorMessage: unreadable,
    compute: async () => {
      const full = await snapshot(root);
      const { updatedAt: _updatedAt, ...content } = full;
      return {
        hash: sha256Hex(JSON.stringify(content)),
        data: JSON.stringify(full),
      };
    },
  });
  const server = createServer(async (request, response) => {
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
        const identity = discoverProject(root);
        const controlDir = controlDirectory(identity.primary);
        await ensureControlDirectory(controlDir);
        await bindControl(
          identity.store,
          controlDir,
          {
            primaryRoot: identity.primary,
            gitCommon: identity.common,
          },
          { narrowing: true },
        );
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
      if (request.url === "/api/events") {
        const header = request.headers["last-event-id"];
        if (!live.canAdd()) {
          response
            .writeHead(503, {
              "Content-Type": "application/json; charset=utf-8",
              "Retry-After": "5",
            })
            .end(
              JSON.stringify({
                error:
                  "Too many live connections. Use /api/snapshot polling instead.",
              }),
            );
          return;
        }
        request.socket.setTimeout(0);
        request.socket.setNoDelay(true);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        live.add(
          response as unknown as SseSink,
          typeof header === "string" ? header : undefined,
        );
        return;
      }
      if (request.url?.startsWith("/api/")) {
        const url = new URL(request.url, `http://${expectedHost}`);
        const json = (value: unknown, status = 200) => {
          response.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify(value));
        };
        if (url.pathname === "/api/config") {
          if (url.search) return json({ error: "Invalid config request" }, 400);
          const identity = discoverProject(root);
          return json(
            await configView(root, {
              store: identity.store,
              policy: projectPolicy(root),
            }),
          );
        }
        if (url.pathname === "/api/control-log") {
          const query = parseControlLogQuery(url.searchParams);
          if (!query)
            return json({ error: "Invalid control-log request" }, 400);
          return json(controlLogView((await readRuntime(root)).state, query));
        }
        if (url.pathname === "/api/usage") {
          if (url.search) return json({ error: "Invalid usage request" }, 400);
          const { state, config } = await readRuntime(root);
          let traces: TraceCoverage | null = null;
          try {
            const store = await getTraces();
            const runs: TraceCoverage["runs"] = [];
            let before: string | undefined;
            let retentionLimited = false;
            let incomplete = false;
            // Bounded: the trace store retains at most 40 runs, 20 per page.
            for (let page = 0; page < 3; page++) {
              const result = await store.list({
                limit: 20,
                ...(before ? { before } : {}),
              });
              retentionLimited ||= result.retentionLimited;
              incomplete ||= result.incomplete;
              runs.push(
                ...result.runs.map((r) => ({
                  lane: r.lane,
                  startedAt: r.startedAt,
                })),
              );
              if (!result.nextCursor) break;
              before = result.nextCursor;
              if (page === 2) incomplete = true;
            }
            traces = { runs, retentionLimited, incomplete };
          } catch {
            traces = null;
          }
          return json(usageView(state, config, traces));
        }
      }
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
        const listParams = (allowed: string[]) => {
          for (const key of url.searchParams.keys())
            if (!allowed.includes(key)) return false;
          return allowed.every(
            (key) => url.searchParams.getAll(key).length < 2,
          );
        };
        const filters = () => {
          const task = url.searchParams.get("task");
          const run = url.searchParams.get("run");
          const cursor = url.searchParams.get("cursor");
          const rawLimit = url.searchParams.get("limit");
          if (
            (task && !validTaskId(task)) ||
            (run !== null && !/^qa_[a-f0-9]{32}$/.test(run)) ||
            (cursor !== null && !/^(?:qa|ev)_[a-f0-9]{32}$/.test(cursor)) ||
            (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit))
          )
            return null;
          return {
            task: task || undefined,
            run: run ?? undefined,
            cursor: cursor ?? undefined,
            limit: rawLimit === null ? undefined : Number(rawLimit),
          };
        };
        if (url.pathname === "/api/evidence") {
          const f = listParams(["task", "run", "limit", "cursor"])
            ? filters()
            : null;
          if (!f || (f.limit !== undefined && (f.limit < 1 || f.limit > 20))) {
            response.writeHead(400).end("Invalid request");
            return;
          }
          if (f.run) {
            // A single run by id, in the list shape (task filter still applies).
            const manifest = await store.manifest(f.run);
            result = {
              runs:
                manifest && (!f.task || manifest.task === f.task)
                  ? [manifest]
                  : [],
              nextCursor: null,
              retentionLimited: manifest?.truncated ?? false,
            };
          } else
            result = await store.list({
              ...(f.task ? { task: f.task } : {}),
              ...(f.cursor ? { cursor: f.cursor } : {}),
              ...(f.limit ? { limit: f.limit } : {}),
            });
        } else if (url.pathname === "/api/evidence/artifacts") {
          const f = listParams(["task", "run", "limit", "cursor"])
            ? filters()
            : null;
          if (
            !f ||
            (f.limit !== undefined &&
              (f.limit < 1 || f.limit > evidenceListMaxLimit)) ||
            (f.cursor !== undefined && !f.cursor.startsWith("ev_"))
          ) {
            response.writeHead(400).end("Invalid request");
            return;
          }
          // The store retains at most 20 runs, so one page covers them all.
          const all = f.run
            ? [await store.manifest(f.run)].filter(
                (m): m is NonNullable<typeof m> => m !== null,
              )
            : (await store.list({ ...(f.task ? { task: f.task } : {}) })).runs;
          const list = evidenceArtifactList(
            all.filter((m) => !f.task || m.task === f.task),
            {
              limit: f.limit ?? evidenceListDefaultLimit,
              ...(f.cursor ? { cursor: f.cursor } : {}),
            },
          );
          if (!list) {
            response.writeHead(400).end("Invalid request");
            return;
          }
          result = list;
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
          response.writeHead(
            200,
            evidenceArtifactHeaders(
              artifact.artifact.mime,
              artifact.artifact.artifactId,
              artifact.content.length,
            ),
          );
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
      const route = routes.get(request.url ?? "");
      if (!route) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.setHeader("Content-Type", `${route.type}; charset=utf-8`);
      response.end(embeddedAssets[route.name]);
    } catch {
      response
        .writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: unreadable }));
    }
  });
  // Event streams never end on their own: close them with the server, then
  // let idle keep-alive connections go, so `close()` completes promptly.
  const close = server.close.bind(server);
  server.close = (callback) => {
    live.close();
    const result = close(callback);
    server.closeIdleConnections();
    return result;
  };
  return server;
}
