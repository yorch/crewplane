// Generates Starlight pages from ../docs at build time. The markdown in docs/ stays the single
// source of truth: output lands in a gitignored directory and is never committed.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = "https://github.com/yorch/crewplane";
const SOURCE = resolve(import.meta.dir, "../../docs");
const OUT = resolve(import.meta.dir, "../src/content/docs/docs");

/** Published docs: source file -> route slug, sidebar label and one-line description. */
export const PAGES = [
  [
    "USAGE.md",
    "usage",
    "Operating guide",
    "Initialize a project, configure execution, assign tasks and observe runs.",
  ],
  [
    "dashboard-design.md",
    "dashboard",
    "Dashboard",
    "The read-only operations cockpit: views, design choices and coverage limits.",
  ],
  [
    "ARCHITECTURE.md",
    "architecture",
    "Architecture",
    "Defaults, boundaries and deferred capabilities.",
  ],
  [
    "CONTRACTS.md",
    "contracts",
    "Contracts",
    "Stable interfaces between core policy, storage, adapters and the dashboard.",
  ],
  ["DECISIONS.md", "decisions", "Decisions", "Architecture decision records."],
  [
    "STATUS.md",
    "status",
    "Validation status",
    "What is implemented, how it was verified and what remains.",
  ],
  [
    "RELEASING.md",
    "releasing",
    "Releasing",
    "How versions, changelogs and binaries are published.",
  ],
] as const;

const routes = new Map<string, string>(
  PAGES.map(([file, slug]) => [file, `/crewplane/docs/${slug}/`]),
);

/** Rewrite relative markdown links: published pages become site routes, everything else GitHub. */
function rewriteLinks(text: string): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
    const [path = "", hash = ""] = target.split("#");
    const name = path.replace(/^(\.\/|\.\.\/)*(docs\/)?/, "");
    const route = routes.get(name);
    if (route) return `](${route}${hash ? `#${hash}` : ""})`;
    const repoPath =
      path.startsWith("docs/") || path.startsWith("../")
        ? path.replace(/^\.\.\//, "")
        : `docs/${path}`;
    return `](${REPO}/blob/main/${repoPath}${hash ? `#${hash}` : ""})`;
  });
}

export function syncDocs(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const [file, slug, label, description] of PAGES) {
    const raw = readFileSync(join(SOURCE, file), "utf8");
    const heading = raw.match(/^# (.+)$/m);
    const body = rewriteLinks(
      heading ? raw.replace(heading[0], "").trimStart() : raw,
    );
    const front = [
      "---",
      `title: ${JSON.stringify(heading?.[1] ?? label)}`,
      `description: ${JSON.stringify(description)}`,
      `sidebar:\n  label: ${JSON.stringify(label)}`,
      `editUrl: ${REPO}/edit/main/docs/${file}`,
      "---",
      "",
    ].join("\n");
    writeFileSync(join(OUT, `${slug}.md`), front + body);
  }
}

if (import.meta.main) syncDocs();
