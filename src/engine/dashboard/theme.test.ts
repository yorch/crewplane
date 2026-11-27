import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const theme = read("theme.css");

/** The declarations inside the block that starts with `opener`. */
function block(css: string, opener: string) {
  const start = css.indexOf(opener);
  expect(start, `missing ${opener}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let from = -1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") {
      depth++;
      if (depth === 1) from = i + 1;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(from, i);
    }
  }
  throw new Error(`unterminated ${opener}`);
}
const tokens = (body: string) =>
  new Map(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [
      m[1] as string,
      (m[2] as string).trim(),
    ]),
  );
const light = tokens(block(theme, ":root {"));
const darkAttr = tokens(block(theme, ':root[data-theme="dark"]'));
const darkMedia = tokens(block(theme, ':root:not([data-theme="light"])'));

// An independent WCAG 2.x implementation (sRGB relative luminance).
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function luminance(hex: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
};

it("measures contrast the way WCAG defines it", () => {
  expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(ratio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  expect(ratio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
});

it("defines the same tokens in light and dark, and the two dark blocks agree", () => {
  expect([...darkAttr.keys()].sort()).toEqual([...light.keys()].sort());
  expect([...darkMedia.entries()]).toEqual([...darkAttr.entries()]);
  expect(light.get("color-scheme")).toBeUndefined();
});

/** [foreground, background, minimum]. 4.5 for text, 3 for graphics. */
const TEXT = 4.5;
const GRAPHIC = 3;
const pairs: [string, string, number][] = [
  ["--text", "--bg", TEXT],
  ["--text", "--surface", TEXT],
  ["--text", "--surface-2", TEXT],
  ["--muted", "--bg", TEXT],
  ["--muted", "--surface", TEXT],
  ["--muted", "--surface-2", TEXT],
  ["--muted", "--accent-weak", TEXT],
  ["--text", "--accent-weak", TEXT],
  ["--accent-strong", "--surface", TEXT],
  ["--accent-strong", "--bg", TEXT],
  ["--accent-strong", "--surface-2", TEXT],
  ["--accent-strong", "--accent-weak", TEXT],
  ["--on-accent", "--accent-solid", TEXT],
  ["--on-accent", "--accent-solid-hover", TEXT],
  ["--on-accent", "--danger-solid", TEXT],
  ["--text", "--graph-task-fill", TEXT],
  ["--sidebar-text", "--sidebar", TEXT],
  ["--sidebar-text", "--sidebar-2", TEXT],
  ["--sidebar-text", "--sidebar-active", TEXT],
  ["--sidebar-text", "--sidebar-border", TEXT],
  ["--sidebar-muted", "--sidebar", TEXT],
  ["--sidebar-muted", "--sidebar-2", TEXT],
  ["--sidebar-strong", "--sidebar-active", TEXT],
  ["--count-danger-text", "--count-danger-bg", TEXT],
  ["--count-warn-text", "--count-warn-bg", TEXT],
  ["--tone-neutral-text", "--tone-neutral-bg", TEXT],
  ["--tone-info-text", "--tone-info-bg", TEXT],
  ["--tone-success-text", "--tone-success-bg", TEXT],
  ["--tone-warning-text", "--tone-warning-bg", TEXT],
  ["--tone-danger-text", "--tone-danger-bg", TEXT],
  ["--danger-text", "--surface", TEXT],
  ["--danger-text", "--surface-2", TEXT],
  ["--danger-text", "--bg", TEXT],
  ["--danger-text", "--danger-row", TEXT],
  ["--danger-text", "--tone-danger-bg", TEXT],
  ["--danger-text-strong", "--danger-bg", TEXT],
  ["--warn-text", "--surface", TEXT],
  ["--warn-text", "--surface-2", TEXT],
  ["--warn-text", "--warn-soft-bg", TEXT],
  ["--warn-soft-text", "--warn-soft-bg", TEXT],
  ["--text", "--danger-row", TEXT],
  ["--text", "--warn-soft-bg", TEXT],
  ["--text", "--danger-bg", TEXT],
  // Graphics and focus indicators need 3:1 against what they sit on.
  ["--focus", "--surface", GRAPHIC],
  ["--focus", "--bg", GRAPHIC],
  ["--focus-dark", "--sidebar", GRAPHIC],
  ["--accent", "--surface", GRAPHIC],
  ["--accent", "--surface-2", GRAPHIC],
  ["--accent", "--accent-weak", GRAPHIC],
  ["--sidebar-accent", "--sidebar", GRAPHIC],
  ["--sidebar-accent", "--sidebar-active", GRAPHIC],
  ["--dot-ok", "--sidebar-2", GRAPHIC],
  ["--dot-bad", "--sidebar-2", GRAPHIC],
  ["--danger-edge", "--surface", GRAPHIC],
  ["--danger-edge", "--danger-row", GRAPHIC],
  ["--warn-edge", "--surface", GRAPHIC],
  ["--warn-edge", "--warn-soft-bg", GRAPHIC],
  ["--success-edge", "--surface", GRAPHIC],
  ["--graph-edge", "--surface-2", GRAPHIC],
  ["--graph-edge-open", "--surface-2", GRAPHIC],
  ["--seg-neutral-edge", "--surface", GRAPHIC],
  ["--seg-info", "--surface", GRAPHIC],
  ["--seg-success", "--surface", GRAPHIC],
  ["--seg-warning", "--surface", GRAPHIC],
  ["--seg-danger", "--surface", GRAPHIC],
  ["--meter-good", "--surface", GRAPHIC],
  ["--meter-warn", "--surface", GRAPHIC],
  ["--meter-bad", "--surface", GRAPHIC],
];

for (const [name, set] of [
  ["light", light],
  ["dark", darkAttr],
] as const) {
  it(`keeps every foreground and background pair legible in the ${name} theme`, () => {
    const failures: string[] = [];
    for (const [fg, bg, min] of pairs) {
      const a = set.get(fg);
      const b = set.get(bg);
      if (!a || !b) {
        failures.push(`${fg} / ${bg}: token missing`);
        continue;
      }
      const value = ratio(a, b);
      if (value < min)
        failures.push(`${fg} on ${bg}: ${value.toFixed(2)} < ${min}`);
    }
    expect(failures).toEqual([]);
  });
}

it("uses only defined tokens and no raw colours outside theme.css", () => {
  const defined = new Set([
    ...light.keys(),
    "--font-sans",
    "--font-mono",
    "--radius",
    "--radius-sm",
    "--topbar-height",
  ]);
  for (const name of ["dashboard.css", "graph-renderer.css"]) {
    const css = read(name);
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(
      (m) => m[1] as string,
    );
    // Locally declared custom properties are fine.
    const local = new Set(
      [...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1] as string),
    );
    for (const token of used)
      expect(
        defined.has(token) || local.has(token),
        `${name} uses undefined ${token}`,
      ).toBe(true);
    const literals = css
      .replace(/var\([^)]*\)/g, "")
      .match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g);
    expect(literals, `${name} has raw colours`).toBeNull();
  }
});

it("declares both colour schemes and applies the saved theme before paint", () => {
  const html = read("index.html");
  expect(html).toContain('<meta name="color-scheme" content="light dark" />');
  // A blocking external classic script, ahead of the stylesheets, not inline.
  const boot = html.indexOf('<script src="/theme-boot.js"></script>');
  expect(boot).toBeGreaterThan(0);
  expect(boot).toBeLessThan(html.indexOf('href="/dashboard.css"'));
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  expect(block(theme, ':root[data-theme="dark"]')).toContain(
    "color-scheme: dark",
  );
  expect(block(theme, ":root {")).toContain("color-scheme: light");
  expect(theme).toContain(':root[data-theme="dark"]');
  expect(theme).toContain("@media (prefers-color-scheme: dark)");
});
