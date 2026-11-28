/** Dependency-free terminal styling for the interactive setup wizard (stderr). */

export interface Style {
  color: boolean;
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  error(text: string): string;
}

const identity = (text: string) => text;

export const plainStyle: Style = {
  color: false,
  bold: identity,
  dim: identity,
  accent: identity,
  ok: identity,
  warn: identity,
  error: identity,
};

/** Matches SGR sequences only (ESC [ params m). */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function stripAnsi(text: string): string {
  return text.replace(SGR, "");
}

const visibleWidth = (text: string) => stripAnsi(text).length;

export function makeStyle(color: boolean): Style {
  if (!color) return plainStyle;
  const paint =
    (open: number, close: number) =>
    (text: string): string =>
      `\u001b[${open}m${text}\u001b[${close}m`;
  return {
    color: true,
    bold: paint(1, 22),
    dim: paint(2, 22),
    accent: paint(36, 39),
    ok: paint(32, 39),
    warn: paint(33, 39),
    error: paint(31, 39),
  };
}

/**
 * NO_COLOR (non-empty) disables; otherwise FORCE_COLOR (non-empty, not "0")
 * enables; otherwise TERM=dumb disables; otherwise the stream decides.
 */
export function shouldColor(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

/** Step header: leading newline, dim counter, bold title, dim rule as wide as the header, trailing newline. */
export function section(
  style: Style,
  step: number,
  total: number,
  title: string,
): string {
  const rule = "-".repeat(`[${step}/${total}] `.length + visibleWidth(title));
  return `\n${style.dim(`[${step}/${total}]`)} ${style.bold(title)}\n${style.dim(rule)}\n`;
}

/** Aligned "label  value" lines; labels are padded by visible width. */
export function table(
  style: Style,
  rows: ReadonlyArray<readonly [string, string]>,
  indent = 2,
): string {
  const pad = " ".repeat(indent);
  const labelWidth = Math.max(0, ...rows.map(([label]) => visibleWidth(label)));
  return rows
    .map(([label, value]) => {
      const gap = " ".repeat(labelWidth - visibleWidth(label) + 2);
      return `${pad}${style.dim(label)}${gap}${value}\n`;
    })
    .join("");
}

/**
 * Greedy word wrap. `width` is the text column budget (indent is added on top).
 * Words longer than `width` get their own line. Whitespace runs collapse to
 * single spaces; empty or blank input yields "".
 */
export function wrap(text: string, width = 76, indent = 2): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((text) => `${pad}${text}\n`).join("");
}
