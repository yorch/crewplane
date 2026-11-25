// Print a fresh Ed25519 release keypair. Writes no files.
//
//   bun scripts/gen-release-key.ts [--id 2026-01]
//
// stdout: the private key (PKCS8 DER, base64) to store as the repository
// secret RELEASE_SIGNING_KEY, then the entry to add to release-keys.json.
import { generateKeyPairSync } from "node:crypto";

const index = process.argv.indexOf("--id");
const id =
  (index === -1 ? undefined : process.argv[index + 1]) ??
  new Date().toISOString().slice(0, 7);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const secret = privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");
const raw = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");
console.log(
  "# RELEASE_SIGNING_KEY (store as a repository secret; never commit):",
);
console.log(secret);
console.log("");
console.log(
  '# Add to "keys" in release-keys.json, then run: bun scripts/sync-install-keys.ts',
);
console.log(JSON.stringify({ id, publicKey: raw }, null, 2));
