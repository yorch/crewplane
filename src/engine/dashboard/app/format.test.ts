import { expect, it } from "vitest";
import {
  excerpt,
  formatBytes,
  formatCount,
  formatDuration,
  formatUsd,
  meterLevel,
  percent,
  shortHash,
} from "./format.js";

it("formats counts with grouping and refuses unknown values instead of printing 0", () => {
  expect(formatCount(0)).toBe("0");
  expect(formatCount(1234567)).toBe("1,234,567");
  expect(formatCount(999)).toBe("999");
  for (const bad of [null, undefined, Number.NaN, -1, "5", Infinity])
    expect(formatCount(bad)).toBeNull();
});

it("formats bytes in binary units", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KiB");
  expect(formatBytes(1536)).toBe("1.5 KiB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  expect(formatBytes(200 * 1024 * 1024)).toBe("200 MiB");
  expect(formatBytes(3 * 1024 ** 4)).toBe("3072 GiB");
  expect(formatBytes(null)).toBeNull();
  expect(formatBytes(-5)).toBeNull();
});

it("formats durations", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(400)).toBe("<1s");
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(192_000)).toBe("3m 12s");
  expect(formatDuration(3_900_000)).toBe("1h 05m");
  expect(formatDuration(null)).toBeNull();
});

it("formats dollars without hiding small amounts", () => {
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatUsd(0.42)).toBe("$0.42");
  expect(formatUsd(12.5)).toBe("$12.50");
  expect(formatUsd(0.0042)).toBe("$0.0042");
  expect(formatUsd(null)).toBeNull();
});

it("shortens only real hex digests", () => {
  const digest = "0123456789abcdef".repeat(4);
  expect(shortHash(digest)).toBe("0123456789ab");
  expect(shortHash(digest, 8)).toBe("01234567");
  expect(shortHash("<img onerror=x>")).toBeNull();
  expect(shortHash(null)).toBeNull();
});

it("computes percentages and meter levels, treating unknown as unknown", () => {
  expect(percent(3, 6)).toBe(50);
  expect(percent(9, 6)).toBe(100);
  expect(percent(0, 6)).toBe(0);
  expect(percent(1, 0)).toBeNull();
  expect(percent(null, 6)).toBeNull();
  expect(percent(1, null)).toBeNull();
  expect(meterLevel(0, 6)).toBe("ok");
  expect(meterLevel(4, 6)).toBe("ok");
  expect(meterLevel(5, 6)).toBe("near");
  expect(meterLevel(6, 6)).toBe("full");
  expect(meterLevel(7, 6)).toBe("over");
  expect(meterLevel(1, 0)).toBe("unknown");
  expect(meterLevel(null, 6)).toBe("unknown");
  expect(meterLevel(2, null)).toBe("unknown");
});

it("excerpts to one bounded line", () => {
  expect(excerpt("a\nb\tc")).toBe("a b c");
  expect(excerpt("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  expect(excerpt(null)).toBe("");
  expect(excerpt("<img src=x onerror=alert(1)>")).toBe(
    "<img src=x onerror=alert(1)>",
  );
});
