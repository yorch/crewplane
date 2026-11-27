import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Control } from "../control-policy.ts";
import { pendingDuplicate, pendingWidening } from "./controls.ts";

const run = "1794100000001-00000000-0000-4000-8000-000000000001";
const otherRun = "1794100000002-00000000-0000-4000-8000-000000000002";
let directory = "";
let tick = 0;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "crewplane-dup-"));
  await mkdir(directory, { recursive: true });
  tick = 0;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const when = () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)).toISOString();
/** Queue a command the way the CLI or dashboard does, returning its id. */
const queue = async (body: object) => {
  const id = crypto.randomUUID();
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({ v: 2, at: when(), ...body }),
  );
  return id;
};
const asked = (body: object) => ({ v: 2, at: when(), ...body }) as Control;

it("dedupes only onto an identical pending halt", async () => {
  const id = await queue({ action: "pause", lane: "builder" });
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "pause", lane: "builder" }),
    ),
  ).toBe(id);
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "pause", lane: "other" }),
    ),
  ).toBeNull();
});

it("a halt pinned differently is a different command", async () => {
  await queue({ action: "cancel", lane: "builder", run, expectRev: 3 });
  const base = { action: "cancel", lane: "builder", run };
  expect(
    await pendingDuplicate(directory, asked({ ...base, expectRev: 4 })),
  ).toBeNull();
  expect(
    await pendingDuplicate(directory, asked({ ...base, expectRun: otherRun })),
  ).toBeNull();
  expect(await pendingDuplicate(directory, asked(base))).toBeNull();
  expect(
    await pendingDuplicate(directory, asked({ ...base, expectRev: 3 })),
  ).not.toBeNull();
});

it("stop and cancel stay bound to a generation, a pause is not", async () => {
  await queue({ action: "stop", generation: "g1" });
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "stop", generation: "g2" }),
    ),
  ).toBeNull();
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "stop", generation: "g1" }),
    ),
  ).not.toBeNull();
  await queue({ action: "pause", all: true, generation: "g1" });
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "pause", all: true, generation: "g2" }),
    ),
  ).not.toBeNull();
});

it("pause --all, resume --all, pause --all queues the second pause", async () => {
  await queue({ action: "pause", all: true });
  await queue({ action: "resume", all: true });
  expect(
    await pendingDuplicate(directory, asked({ action: "pause", all: true })),
  ).toBeNull();
});

it("dedupes onto the latest identical pause when nothing overlapping follows it", async () => {
  await queue({ action: "pause", all: true });
  await queue({ action: "resume", all: true });
  const later = await queue({ action: "pause", all: true });
  expect(
    await pendingDuplicate(directory, asked({ action: "pause", all: true })),
  ).toBe(later);
});

it("a later command on another lane does not block deduplication", async () => {
  const id = await queue({ action: "pause", lane: "builder" });
  await queue({ action: "resume", lane: "reviewer" });
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "pause", lane: "builder" }),
    ),
  ).toBe(id);
});

it("a later instance-wide or all-lane command blocks deduplication of a lane pause", async () => {
  await queue({ action: "pause", lane: "builder" });
  await queue({ action: "resume", all: true });
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "pause", lane: "builder" }),
    ),
  ).toBeNull();
});

it("never dedupes onto a file whose id the supervisor already consumed", async () => {
  const id = await queue({ action: "pause", all: true });
  expect(
    await pendingDuplicate(directory, asked({ action: "pause", all: true }), [
      `${id}.json`,
    ]),
  ).toBeNull();
  const other = await queue({ action: "pause", all: true });
  expect(
    await pendingDuplicate(directory, asked({ action: "pause", all: true }), [
      `${id}.json`,
    ]),
  ).toBe(other);
});

it("widening verbs are never deduplicated", async () => {
  await queue({ action: "retry", lane: "builder", expectRev: 1 });
  expect(
    await pendingDuplicate(
      directory,
      asked({ action: "retry", lane: "builder", expectRev: 1 }),
    ),
  ).toBeNull();
});

it("only non-halting files count toward the widening cap", async () => {
  for (let i = 0; i < 5; i++) await queue({ action: "pause", lane: `l${i}` });
  await queue({ action: "stop" });
  await queue({ action: "retry", lane: "builder", expectRev: 1 });
  await writeFile(join(directory, `${crypto.randomUUID()}.json`), "not json");
  const consumed = await queue({ action: "resume", all: true });
  expect(await pendingWidening(directory)).toBe(3);
  expect(await pendingWidening(directory, [`${consumed}.json`])).toBe(2);
});
