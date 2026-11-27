import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { plannedTasks, snapshot } from "../board.ts";
import {
  bindControl,
  controlDirectory,
  ensureControlDirectory,
} from "../control.ts";
import { sha256Hex } from "../hash.ts";
import {
  type ControlTarget,
  isLive,
  legacyRefusal,
  readBoundedJson,
  resolveControlTarget,
  supervisorLiveness,
} from "../migrate.ts";
import {
  discoverProject,
  projectPolicy,
  validId,
  validTaskId,
} from "../project.ts";
import { main as coordination } from "./agents.mjs";
import { embeddedAssets } from "./assets.ts";
import { type Control, control } from "./control-policy.ts";
import { queueControl } from "./control-queue.ts";
import { configView } from "./dashboard/config-view.ts";
import {
  controlLogView,
  parseControlLogQuery,
} from "./dashboard/control-log.ts";
import {
  controlsView,
  createControlGuard,
  dashboardVerbs,
  fingerprint,
  isHalting,
  parseControlRequest,
  pendingDuplicate,
  pendingWidening,
  sameRecordedSubject,
  wideningVerbs,
} from "./dashboard/controls.ts";
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
import { createEvidenceStore, evidenceRejected } from "./evidence/store.ts";
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
    /** Controls rate limit and replay window (tests inject a clock). */
    controlGuard?: Parameters<typeof createControlGuard>[0];
    /** Live-update tuning; the defaults suit production, tests inject timers. */
    live?: {
      intervalMs?: number;
      maxIntervalMs?: number;
      heartbeatMs?: number;
      maxClients?: number;
      maxEventBytes?: number;
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
  const guard = createControlGuard(options.controlGuard);
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
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
      // Authority: the controls token, the exact Origin, JSON, and (when read
      // access is gated, as it always is for a launched dashboard) the
      // per-launch read session, exactly as the page sends all of them.
      if (
        !controls ||
        request.headers.origin !== `http://${expectedHost}` ||
        !tokenMatches(request.headers["x-crewplane-token"], controls.token) ||
        (options.session &&
          !tokenMatches(
            request.headers["x-crewplane-session"],
            options.session.token,
          )) ||
        request.headers["content-type"] !== "application/json"
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const reply = (status: number, body: unknown, headers = {}) => {
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          ...headers,
        });
        response.end(JSON.stringify(body));
      };
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
          return reply(400, { error: "Invalid JSON", code: "INVALID_JSON" });
        }
        // The CLI's fail-closed layout gate: while an older in-store
        // supervisor layout exists, widening verbs are refused and narrowing
        // verbs go where the CLI would queue them (legacy and/or control).
        const identity = discoverProject(root);
        const controlDir = controlDirectory(identity.primary);
        const requested =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as { action?: unknown }).action
            : undefined;
        let target: ControlTarget = { directory: controlDir };
        if (
          typeof requested === "string" &&
          (dashboardVerbs as readonly string[]).includes(requested)
        )
          try {
            target = resolveControlTarget(
              identity.store,
              controlDir,
              requested,
            );
          } catch (error) {
            if ((error as Error).message !== legacyRefusal) throw error;
            return reply(409, { error: legacyRefusal, code: "LEGACY_LAYOUT" });
          }
        const viaControl = target.directory === controlDir;
        // The same read model the CLI consults for the directory it uses: the
        // supervisor generation the operator is bound to and the configured
        // agents. A legacy directory's own files are unverified and read
        // bounded; its configuration never refuses a halt.
        const runtime = await readRuntime(root);
        const generation = viaControl
          ? runtime.state?.generation
          : ((
              readBoundedJson(join(target.directory, "state.json")) as {
                generation?: unknown;
              } | null
            )?.generation as string | undefined);
        const parsed = parseControlRequest(body, {
          generation: typeof generation === "string" ? generation : undefined,
          lanes:
            viaControl && runtime.config
              ? Object.keys(runtime.config.lanes)
              : null,
          at: new Date().toISOString(),
        });
        if (!parsed.ok)
          return reply(400, { error: parsed.message, code: parsed.code });
        const value = parsed.value;
        const halting = isHalting(value.action);
        const id = parsed.requestId ?? randomUUID();
        const print = fingerprint(value);
        const notes = (running: boolean) =>
          [
            running
              ? ""
              : value.action === "pause"
                ? "No supervisor is running; the pause applies when a supervisor starts."
                : `No supervisor is running; this ${value.action} is bound to the current generation and will be refused as stale by the next start.`,
            target.warning ?? "",
          ]
            .filter(Boolean)
            .join(" ");
        const answer = (
          replay: boolean,
          afterSeq: number,
          running: boolean,
          queuedId = id,
        ) => ({
          queued: value.action,
          id: queuedId,
          status: "queued",
          outcome: null,
          afterSeq,
          supervisor: running ? "running" : "not-running",
          ...(notes(running) ? { warning: notes(running) } : {}),
          ...(target.also?.length || !viaControl ? { legacy: true } : {}),
          ...(replay ? { replay: true } : {}),
        });
        const liveness = () => {
          try {
            return isLive(supervisorLiveness(target.directory));
          } catch {
            return false;
          }
        };
        const cached = guard.recall(id);
        if (cached) {
          if (cached.fingerprint !== print)
            return reply(409, {
              error: "This requestId was already used for a different command.",
              code: "REQUEST_ID_REUSED",
            });
          return reply(200, { ...(cached.body as object), replay: true });
        }
        const afterSeq = runtime.state?.controlSeq ?? 0;
        // The supervisor remembers consumed command ids: a replay of one is
        // answered without queuing again. Its control-log entry keeps the
        // verb and target (not the payload), so a different verb or target
        // under the same id is a conflict; a differing note or pin is not
        // knowable and replays by id.
        if (runtime.state?.commands.includes(`${id}.json`)) {
          const entry = (runtime.state.controlLog ?? []).find(
            (e) => e.id === id,
          );
          if (entry && !sameRecordedSubject(entry, value))
            return reply(409, {
              error: "This requestId was already used for a different command.",
              code: "REQUEST_ID_REUSED",
            });
          return reply(200, answer(true, 0, liveness()));
        }
        // Commands are authority: they go to the private control directory
        // (and, for halting verbs, the legacy one the CLI would also use).
        await ensureControlDirectory(controlDir);
        if (viaControl)
          await bindControl(
            identity.store,
            controlDir,
            {
              primaryRoot: identity.primary,
              gitCommon: identity.common,
            },
            { narrowing: !wideningVerbs.has(value.action) },
          );
        const directory = join(controlDir, "commands");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let reserved = false;
        if (halting) {
          // Halting is never refused: no rate limit, no queue cap. It is
          // idempotent, so a repeat of a still-pending halt adds no file.
          const duplicate = await pendingDuplicate(
            directory,
            value,
            runtime.state?.commands ?? [],
          );
          if (duplicate) {
            const result = answer(true, afterSeq, liveness(), duplicate);
            guard.remember(id, print, result);
            return reply(200, result);
          }
        } else {
          // Halting files do not count: they are never refused, so they must
          // not be able to fill the cap and block recovery.
          const pending = await pendingWidening(
            directory,
            runtime.state?.commands ?? [],
          );
          if (pending >= guard.maxPending)
            return reply(
              429,
              {
                error:
                  "Too many commands are waiting for the supervisor. Wait for them to be recorded.",
                code: "QUEUE_FULL",
              },
              { "Retry-After": "10" },
            );
          const slot = guard.reserve();
          if (!slot.ok)
            return reply(
              429,
              {
                error: "Too many controls in the last minute. Retry shortly.",
                code: "RATE_LIMITED",
              },
              { "Retry-After": String(slot.retryAfter) },
            );
          reserved = true;
        }
        let running = false;
        try {
          running = (
            await queueControl({
              id,
              value,
              controlDir,
              target,
              exclusive: true,
              warn: () => {},
            })
          ).running;
        } catch (error) {
          if (reserved) guard.release();
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Another request (or process) already queued this id: same
          // command, same answer; a different command under it is a conflict.
          let existing: Control | null = null;
          try {
            existing = control(
              JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")),
            );
          } catch {
            existing = null;
          }
          // The control copy carries the control directory's own generation.
          if (!existing || fingerprint(existing) !== print)
            return reply(409, {
              error: "This requestId was already used for a different command.",
              code: "REQUEST_ID_REUSED",
            });
          return reply(200, answer(true, afterSeq, liveness()));
        }
        const result = answer(false, afterSeq, running);
        guard.remember(id, print, result);
        return reply(200, result);
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
        if (url.pathname === "/api/controls") {
          if (url.search)
            return json({ error: "Invalid controls request" }, 400);
          if (!options.controls)
            return json(controlsView(false, null, null, { running: false }));
          const { state, config } = await readRuntime(root);
          const fresh =
            state?.running === true &&
            Number.isFinite(Date.parse(state.checkedAt)) &&
            Date.now() - Date.parse(state.checkedAt) <=
              ((config?.intervalSeconds ?? 10) * 2 + 5) * 1000;
          return json(controlsView(true, state, config, { running: fresh }));
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
        // Opening the store failing is a read failure (503), not a bad request.
        const store = await getEvidence();
        try {
          const url = new URL(request.url, `http://${expectedHost}`);
          const parts = url.pathname.split("/");
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
            // Run pages are cursored by run id only.
            if (
              !f ||
              (f.limit !== undefined && (f.limit < 1 || f.limit > 20)) ||
              (f.cursor !== undefined && !f.cursor.startsWith("qa_"))
            ) {
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
              : (await store.list({ ...(f.task ? { task: f.task } : {}) }))
                  .runs;
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
        } catch (error) {
          // A request the store refuses (an unknown cursor, say) is the
          // client's error everywhere; a failure to read is not.
          if (!evidenceRejected(error)) throw error;
          response.writeHead(400).end("Invalid request");
          return;
        }
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
      // Browsers ask for /favicon.ico on every first load; the page has no
      // icon, so say so without an error in the console.
      if (request.url === "/favicon.ico") {
        response.writeHead(204).end();
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
