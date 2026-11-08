import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type UsageEvent = {
  version: 1;
  id: string;
  lane: string;
  task: string | null;
  run: string;
  session: string;
  turn: string;
  harness: "codex" | "pi";
  provider: string | null;
  observedModel: string | null;
  configuredModel: string | null;
  at: string;
  durationMs: number | null;
  provenance: string;
  semantics: "delta" | "cumulative";
  series: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  cacheReadRelation: "input-subset" | "unknown";
  reasoningRelation: "output-subset" | "unknown";
  partial: boolean;
};
export type UsageFilter = {
  from?: string;
  to?: string;
  lane?: string;
  task?: string;
  run?: string;
  session?: string;
  model?: string;
  provider?: string;
  harness?: "codex" | "pi";
};
const fields = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
] as const;
const strings = [
  "id",
  "lane",
  "run",
  "session",
  "turn",
  "harness",
  "at",
  "provenance",
  "semantics",
  "series",
  "cacheReadRelation",
  "reasoningRelation",
] as const;
const nullableStrings = [
  "task",
  "provider",
  "observedModel",
  "configuredModel",
] as const;
const keys = [
  "version",
  ...strings,
  ...nullableStrings,
  ...fields,
  "durationMs",
  "partial",
];
function fail(): never {
  throw new Error("Invalid usage event");
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
export function validateUsageEvent(value: unknown): UsageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    fail();
  for (const k of strings)
    if (
      typeof v[k] !== "string" ||
      !(v[k] as string).length ||
      (v[k] as string).length > 256 ||
      [...(v[k] as string)].some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      )
    )
      fail();
  for (const k of nullableStrings)
    if (
      v[k] !== null &&
      (typeof v[k] !== "string" ||
        !(v[k] as string).length ||
        (v[k] as string).length > 256 ||
        [...(v[k] as string)].some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        ))
    )
      fail();
  for (const k of [...fields, "durationMs"])
    if (v[k] !== null && (!Number.isSafeInteger(v[k]) || (v[k] as number) < 0))
      fail();
  if (
    v.version !== 1 ||
    !["codex", "pi"].includes(v.harness as string) ||
    !["delta", "cumulative"].includes(v.semantics as string) ||
    !["input-subset", "unknown"].includes(v.cacheReadRelation as string) ||
    !["output-subset", "unknown"].includes(v.reasoningRelation as string) ||
    typeof v.partial !== "boolean" ||
    !timestamp(v.at)
  )
    fail();
  if (
    v.cacheReadRelation === "input-subset" &&
    v.input !== null &&
    v.cacheRead !== null &&
    (v.cacheRead as number) > (v.input as number)
  )
    fail();
  if (
    v.reasoningRelation === "output-subset" &&
    v.output !== null &&
    v.reasoning !== null &&
    (v.reasoning as number) > (v.output as number)
  )
    fail();
  return Object.fromEntries(keys.map((k) => [k, v[k]])) as UsageEvent;
}
function canonical(event: UsageEvent) {
  return JSON.stringify(validateUsageEvent(event));
}
function unique(events: readonly UsageEvent[]) {
  const map = new Map<string, UsageEvent>();
  for (const raw of events) {
    const e = validateUsageEvent(raw);
    const prior = map.get(e.id);
    if (prior && canonical(prior) !== canonical(e))
      throw new Error("Conflicting usage identity");
    map.set(e.id, e);
  }
  return [...map.values()];
}
function add(a: number, b: number) {
  const n = a + b;
  if (!Number.isSafeInteger(n))
    throw new Error("Usage total exceeds safe integer");
  return n;
}
/** Cumulative series must have stable dimensions. Filter windows select snapshots, then take field maxima; they are not interval consumption estimates. */
export function aggregateUsage(
  events: readonly UsageEvent[],
  filter: UsageFilter = {},
) {
  for (const [key, value] of Object.entries(filter))
    if (
      ![
        "from",
        "to",
        "lane",
        "task",
        "run",
        "session",
        "model",
        "provider",
        "harness",
      ].includes(key) ||
      typeof value !== "string" ||
      value.length > 256
    )
      throw new Error("Invalid usage filter");
  if (
    (filter.from && !timestamp(filter.from)) ||
    (filter.to && !timestamp(filter.to))
  )
    throw new Error("Invalid usage filter timestamp");
  const all = unique(events);
  const groups = new Map<string, UsageEvent[]>();
  for (const e of all) {
    const identity = JSON.stringify([
      e.lane,
      e.task,
      e.run,
      e.session,
      e.turn,
      e.harness,
      e.provider,
      e.observedModel,
      e.configuredModel,
      e.provenance,
      e.cacheReadRelation,
      e.reasoningRelation,
    ]);
    if (e.semantics === "cumulative") {
      const group = groups.get(e.series) ?? [];
      if (
        group[0] &&
        JSON.stringify([
          group[0].lane,
          group[0].task,
          group[0].run,
          group[0].session,
          group[0].turn,
          group[0].harness,
          group[0].provider,
          group[0].observedModel,
          group[0].configuredModel,
          group[0].provenance,
          group[0].cacheReadRelation,
          group[0].reasoningRelation,
        ]) !== identity
      )
        throw new Error("Cumulative series dimensions changed");
      group.push(e);
      groups.set(e.series, group);
    }
  }
  const selected = all.filter(
    (e) =>
      (!filter.from || Date.parse(e.at) >= Date.parse(filter.from)) &&
      (!filter.to || Date.parse(e.at) < Date.parse(filter.to)) &&
      Object.entries(filter).every(
        ([k, v]) =>
          k === "from" ||
          k === "to" ||
          (k === "model"
            ? e.observedModel === v
            : e[k as keyof UsageEvent] === v),
      ),
  );
  const units = new Map<string, UsageEvent[]>();
  for (const e of selected) {
    const k = JSON.stringify([
      e.semantics,
      e.semantics === "delta" ? e.id : e.series,
    ]);
    const g = units.get(k) ?? [];
    g.push(e);
    units.set(k, g);
  }
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  const coverage = Object.fromEntries(
    fields.map((f) => [f, { reported: 0, unavailable: 0 }]),
  ) as Record<
    (typeof fields)[number],
    { reported: number; unavailable: number }
  >;
  let numerator = 0,
    denominator = 0,
    eligible = 0,
    durationMs = 0,
    durationReported = 0;
  for (const group of units.values()) {
    const maxima = (f: (typeof fields)[number] | "durationMs") => {
      const values = group
        .map((e) => e[f])
        .filter((n): n is number => n !== null);
      return values.length ? values.reduce((a, b) => Math.max(a, b), 0) : null;
    };
    for (const f of fields) {
      const n = maxima(f);
      if (n === null) coverage[f].unavailable++;
      else {
        coverage[f].reported++;
        totals[f] = add(totals[f], n);
      }
    }
    const duration = maxima("durationMs");
    if (duration !== null) {
      durationMs = add(durationMs, duration);
      durationReported++;
    }
    // Only co-reported numerator/denominator snapshots provide a defensible ratio.
    const pairs = group.filter(
      (e) =>
        e.cacheReadRelation === "input-subset" &&
        e.cacheRead !== null &&
        e.input !== null,
    );
    if (pairs.length === group.length) {
      numerator = add(
        numerator,
        Math.max(...pairs.map((e) => e.cacheRead ?? 0)),
      );
      denominator = add(
        denominator,
        Math.max(...pairs.map((e) => e.input ?? 0)),
      );
      eligible++;
    }
  }
  return {
    totals,
    coverage,
    events: selected.length,
    units: units.size,
    partialEvents: selected.filter((e) => e.partial).length,
    uniqueRuns: new Set(selected.map((e) => JSON.stringify([e.lane, e.run])))
      .size,
    durationMs: durationReported ? durationMs : null,
    durationReported,
    cacheHitRatio: {
      value: denominator ? numerator / denominator : null,
      numerator,
      denominator,
      eligible,
      unavailable: units.size - eligible,
    },
    windowSemantics: "selected-snapshot-maxima" as const,
  };
}
export type UsageLimits = { maxEvents?: number; maxBytes?: number };
/** Single writer, atomic fsync+rename snapshots; hard capacity refusal retains every dedupe key. Defaults: 10000 events / 16MiB. */
export async function openUsageLedger(
  directory: string,
  limits: UsageLimits = {},
) {
  const maxEvents = limits.maxEvents ?? 10000,
    maxBytes = limits.maxBytes ?? 16 * 1024 * 1024;
  if (
    ![maxEvents, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
    maxEvents > 100000 ||
    maxBytes > 64 * 1024 * 1024
  )
    throw new Error("Invalid usage limits");
  const root = resolve(directory);
  // Reject symlinks at every existing ancestor, including the requested directory.
  let part = "/";
  for (const segment of root.split("/").filter(Boolean)) {
    part = join(part, segment);
    try {
      const s = await lstat(part);
      if (s.isSymbolicLink() || !s.isDirectory())
        throw new Error("Unsafe ledger directory");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await mkdir(part, { mode: 0o700 });
    }
  }
  await chmod(root, 0o700);
  const lockPath = join(root, "writer.lock");
  const acquire = () =>
    open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await acquire();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const recoveryPath = join(root, "recovery.lock");
    const recovery = await open(
      recoveryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const old = await open(
        lockPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let pid: number;
      try {
        if ((await old.stat()).size > 32)
          throw new Error("Invalid writer lock");
        pid = Number(await old.readFile("utf8"));
      } finally {
        await old.close();
      }
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Invalid writer lock");
      try {
        process.kill(pid, 0);
        throw new Error("Usage writer active");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await unlink(lockPath);
      lock = await acquire();
    } finally {
      await recovery.close();
      await unlink(recoveryPath);
    }
  }
  await lock.writeFile(String(process.pid));
  await lock.sync();
  // Only the committed ledger is authoritative; a dead writer's pending snapshot is discarded.
  try {
    const pending = join(root, "pending.json");
    const info = await lstat(pending);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Unsafe pending ledger");
    await unlink(pending);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      await lock.close();
      await unlink(lockPath);
      throw e;
    }
  }
  const file = join(root, "ledger.json");
  let events: UsageEvent[] = [];
  let closed = false;
  let queue = Promise.resolve();
  try {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Ledger capacity or file violation");
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!Array.isArray(parsed) || parsed.length > maxEvents)
        throw new Error("Invalid ledger");
      events = unique(parsed);
      aggregateUsage(events);
      await handle.chmod(0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    } finally {
      await handle?.close();
    }
  } catch (e) {
    await lock.close();
    await unlink(lockPath);
    throw e;
  }
  async function persist(next: UsageEvent[]) {
    const data = JSON.stringify(next);
    if (next.length > maxEvents || Buffer.byteLength(data) > maxBytes)
      throw new Error("Usage ledger capacity reached");
    const temp = join(root, "pending.json");
    const h = await open(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(temp, file);
    const d = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }
  return {
    append(event: UsageEvent): Promise<{ duplicate: boolean }> {
      const snapshot = validateUsageEvent(event);
      const action = queue.then(async () => {
        if (closed) throw new Error("Ledger closed");
        const prior = events.find((e) => e.id === snapshot.id);
        if (prior) {
          if (canonical(prior) !== canonical(snapshot))
            throw new Error("Conflicting usage identity");
          return { duplicate: true };
        }
        const next = [...events, snapshot];
        aggregateUsage(next);
        await persist(next);
        events = next;
        return { duplicate: false };
      });
      queue = action.then(
        () => {},
        () => {},
      );
      return action;
    },
    async query(filter?: UsageFilter) {
      await queue;
      if (closed) throw new Error("Ledger closed");
      return aggregateUsage(events, filter);
    },
    async close() {
      await queue;
      if (!closed) {
        closed = true;
        await lock.close();
        await unlink(lockPath);
      }
    },
  };
}
