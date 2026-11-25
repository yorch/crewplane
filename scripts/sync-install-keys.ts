// Keep the key block in install.sh equal to release-keys.json.
//
//   bun scripts/sync-install-keys.ts          rewrite the block
//   bun scripts/sync-install-keys.ts --check  exit 1 if it differs
//   options: --keys FILE (default release-keys.json), --install FILE
import { readFileSync, writeFileSync } from "node:fs";
import { parseReleaseTrust } from "../src/release-signing.ts";

const begin =
  "# BEGIN RELEASE KEYS (generated from release-keys.json; do not edit)";
const end = "# END RELEASE KEYS";
const root = new URL("../", import.meta.url);
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};
const keysPath = option("--keys", new URL("release-keys.json", root).pathname);
const installPath = option("--install", new URL("install.sh", root).pathname);

const trust = parseReleaseTrust(JSON.parse(readFileSync(keysPath, "utf8")));
const block = `${begin}\nrelease_signed_since='${trust.signedSince ?? ""}'\nrelease_keys='${trust.keys.map((key) => `\n${key.id} ${key.publicKey}`).join("")}\n'\n${end}`;
const script = readFileSync(installPath, "utf8");
const from = script.indexOf(begin);
const to = script.indexOf(end);
if (from === -1 || to === -1)
  throw new Error("install.sh has no release key block");
const next = script.slice(0, from) + block + script.slice(to + end.length);
if (process.argv.includes("--check")) {
  if (next !== script) {
    console.error(
      "install.sh key block differs from release-keys.json; run: bun scripts/sync-install-keys.ts",
    );
    process.exit(1);
  }
  console.log("install.sh key block matches release-keys.json");
} else writeFileSync(installPath, next);
