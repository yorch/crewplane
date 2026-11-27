// Pure formatters shared by the Setup, Usage, Evidence and Audit views. No DOM,
// no locale: output is the same on every machine, so it can be unit tested.
// Unknown (null, undefined, NaN, a negative count) is never turned into 0: each
// function answers null and the caller decides how to say "Not recorded".

const isCount = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** 1234567 -> "1,234,567"; null when not a non-negative number. */
export function formatCount(value) {
  if (!isCount(value)) return null;
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Bytes in binary units: 512 B, 1.5 KiB, 3.2 MiB. */
export function formatBytes(value) {
  if (!isCount(value)) return null;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/** Milliseconds as "45s", "3m 12s" or "1h 05m". */
export function formatDuration(ms) {
  if (!isCount(ms)) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return ms < 1 ? "0s" : "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Dollars: $0.42, $12.50, $0.0042 (small amounts keep their digits). */
export function formatUsd(value) {
  if (!isCount(value)) return null;
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toPrecision(2)}`;
  return `$${value.toFixed(2)}`;
}

/** First characters of a hex digest, for display next to a copy button. */
export function shortHash(value, length = 12) {
  return typeof value === "string" && /^[a-f0-9]{8,128}$/i.test(value)
    ? value.slice(0, length)
    : null;
}

/** used/cap as a whole percentage clamped to 0..100; null when either is unknown or the cap is 0. */
export function percent(used, cap) {
  if (!isCount(used) || !isCount(cap) || cap === 0) return null;
  return Math.min(100, Math.round((used / cap) * 100));
}

/**
 * Severity of a usage meter. Text always accompanies it in the UI, so this is
 * never the only signal: unknown, ok (< 80%), near (>= 80%), full (at the cap)
 * and over (past it, which a retained counter can show after a cap was lowered).
 */
export function meterLevel(used, cap) {
  if (!isCount(used) || !isCount(cap) || cap === 0) return "unknown";
  if (used > cap) return "over";
  if (used === cap) return "full";
  return used / cap >= 0.8 ? "near" : "ok";
}

/** A single-line, bounded excerpt for table cells and alt text. */
export function excerpt(value, limit = 120) {
  const text = String(value ?? "")
    .replace(/\p{Cc}/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
