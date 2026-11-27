import { constants } from "node:fs";
import { open } from "node:fs/promises";

const unprintable = (code: number) =>
  code < 32 ||
  (code >= 127 && code <= 159) ||
  code === 0x2028 ||
  code === 0x2029;
const printable = (text: string) =>
  Array.from(text, (ch) =>
    unprintable(ch.codePointAt(0) ?? 0) ? " " : ch,
  ).join("");
/** Printable, bounded text for untrusted persisted strings; null when not text. */
export const clean = (value: unknown, max = 200): string | null =>
  typeof value === "string"
    ? printable(value.slice(0, max * 2))
        .trim()
        .slice(0, max)
    : null;
/** A non-negative safe integer, else null (unknown is never 0). */
export const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
/** A finite non-negative number, else null. */
export const amount = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1e9
    ? value
    : null;
/** An ISO-like timestamp that parses, else null. */
export const instant = (value: unknown): string | null => {
  const text = clean(value, 40);
  return text !== null && Number.isFinite(Date.parse(text)) ? text : null;
};
/** Scalars and short scalar lists only; anything structured becomes null. */
export const scalar = (value: unknown, max = 200): unknown => {
  if (typeof value === "string") return clean(value, max);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value
      .slice(0, 64)
      .map((item) =>
        typeof item === "string" ? clean(item, max) : scalar(item, max),
      )
      .filter((item) => item !== null && typeof item !== "object");
  return null;
};

const maxJsonBytes = 16 * 1024 * 1024;
/**
 * Reads a control-plane JSON file without following a final symlink or reading
 * more than `limit` bytes: the parsed value, `null` when the file does not
 * exist, and a throw for anything else (not a regular file, too large,
 * unreadable, not JSON).
 */
export async function readJsonStrict(
  path: string,
  limit = maxJsonBytes,
): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error("Invalid private state; inspect before recovery");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid private state; inspect before recovery");
  } finally {
    await handle?.close();
  }
}
/** Like `readJsonStrict`, but anything unusable (missing included) is null. */
export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return await readJsonStrict(path);
  } catch {
    return null;
  }
}
