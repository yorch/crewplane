// A small cached, throttled reader for one read-only JSON route (/api/config,
// /api/usage, /api/control-log). The dependencies (fetch, clock, timers) are
// injectable, so the load / debounce / coalescing rules are unit tested without
// a DOM. Views read `resource.state` and subscribe with `onChange`.

/** What the operator is told when a read fails; never echoes server text beyond its sanitized `error` string. */
export function readErrorMessage(status, body) {
  if (status === 401)
    return "Session missing or expired. Reopen the URL printed by crewplane dashboard.";
  if (status === 400) return "The dashboard refused this request.";
  if (typeof body?.error === "string" && body.error)
    return body.error.slice(0, 300);
  if (status === 503)
    return "The dashboard could not read this data right now.";
  return `The request failed (${status}).`;
}

export class ReadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Authenticated GET returning parsed JSON, or throwing a ReadError. */
export async function readJson(path, options = {}) {
  let response;
  try {
    response = await window.crewplaneFetch(path, {
      cache: "no-store",
      signal: options.signal ?? AbortSignal.timeout(10000),
    });
  } catch {
    throw new ReadError(0, "The dashboard server did not answer.");
  }
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    // Non-JSON answers are described by status alone.
  }
  if (!response.ok)
    throw new ReadError(
      response.status,
      readErrorMessage(response.status, body),
    );
  if (body === null)
    throw new ReadError(response.status, "The answer was not readable.");
  return body;
}

/**
 * @param {{
 *   path: string | (() => string),
 *   fetchJson?: (path: string) => Promise<any>,
 *   now?: () => number,
 *   setTimer?: (run: () => void, ms: number) => any,
 *   clearTimer?: (timer: any) => void,
 *   minIntervalMs?: number,
 *   debounceMs?: number,
 * }} options
 */
export function createResource({
  path,
  fetchJson = readJson,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  minIntervalMs = 15000,
  debounceMs = 1500,
}) {
  const state = {
    status: "idle",
    data: null,
    error: null,
    loadedAt: null,
    attemptedAt: null,
  };
  const listeners = new Set();
  let timer = null;
  let loading = null;
  let again = false;
  const notify = () => {
    for (const listener of [...listeners]) listener(state);
  };
  const currentPath = () => (typeof path === "function" ? path() : path);

  async function run() {
    state.status = "loading";
    state.attemptedAt = now();
    notify();
    try {
      state.data = await fetchJson(currentPath());
      state.error = null;
      state.loadedAt = now();
      state.status = "ready";
    } catch (error) {
      // Keep the last good data on screen; the view says it may be stale.
      state.error = {
        status: error?.status ?? 0,
        message: error?.message ?? "The request failed.",
      };
      state.status = "error";
    }
    notify();
  }
  function load({ force = false } = {}) {
    if (loading) {
      // One request at a time; a forced load asks for one more afterwards.
      if (force) again = true;
      return loading;
    }
    clearTimer(timer);
    timer = null;
    loading = run().finally(() => {
      loading = null;
      if (again) {
        again = false;
        load({ force: true });
      }
    });
    return loading;
  }
  /**
   * Debounced, throttled refresh for "the snapshot changed": waits `debounceMs`
   * for a burst to settle and never loads more often than `minIntervalMs`.
   */
  function schedule() {
    if (timer !== null) return;
    const wait = Math.max(
      debounceMs,
      state.attemptedAt === null
        ? 0
        : state.attemptedAt + minIntervalMs - now(),
    );
    timer = setTimer(() => {
      timer = null;
      load();
    }, wait);
  }
  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function cancel() {
    clearTimer(timer);
    timer = null;
  }
  return { state, load, schedule, onChange, cancel };
}
