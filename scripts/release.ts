#!/usr/bin/env bun
// Usage: bun run release <patch|minor|major|x.y.z> [--dry-run] [--skip-verify] [--no-push]
// Bumps package.json, commits, tags vX.Y.Z and pushes main + tag. The tag push
// triggers .github/workflows/release.yml, which builds and publishes binaries.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { nextVersion } from "./version.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const request = args.find((a) => !a.startsWith("--"));
const dry = flags.has("--dry-run");

function run(cmd: string, argv: string[], capture = false): string {
  const r = spawnSync(cmd, argv, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed`);
  return (r.stdout ?? "").trim();
}
const git = (...a: string[]) => run("git", a, true);

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

if (!request)
  fail("usage: bun run release <patch|minor|major|x.y.z> [--dry-run]");

const pkgPath = new URL("../package.json", import.meta.url);
const raw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(raw) as { version: string };
let version: string;
try {
  version = nextVersion(pkg.version, request);
} catch (e) {
  fail((e as Error).message);
}
const tag = `v${version}`;

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main")
  fail("must be on main");
if (git("status", "--porcelain")) fail("working tree is not clean");
git("fetch", "origin", "main", "--tags");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main"))
  fail("local main differs from origin/main; pull or push first");
if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);

const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n");
const last = tags[0] ?? "";
console.log(`release ${pkg.version} -> ${version} (${tag})`);
console.log(
  git("log", "--oneline", last ? `${last}..HEAD` : "HEAD") || "(no commits)",
);
if (dry) {
  console.log("dry run: nothing changed");
  process.exit(0);
}

if (!flags.has("--skip-verify")) run("bun", ["run", "verify"]);

writeFileSync(
  pkgPath,
  raw.replace(/"version": "[^"]+"/, `"version": "${version}"`),
);
run("git", ["add", "package.json"]);
run("git", ["commit", "-m", `chore(release): ${tag}`]);
run("git", ["tag", "-a", tag, "-m", `Crewplane ${version}`]);

if (flags.has("--no-push")) {
  console.log(`tagged ${tag} locally; push with: git push origin main ${tag}`);
} else {
  run("git", ["push", "origin", "main", tag]);
  console.log(`pushed ${tag}; the Release workflow will publish binaries`);
}
