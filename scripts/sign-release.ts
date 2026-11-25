// Sign (or verify) release assets with the Ed25519 release key.
//
//   RELEASE_SIGNING_KEY=... bun scripts/sign-release.ts --tag vX.Y.Z FILE...
//   bun scripts/sign-release.ts --verify --tag vX.Y.Z FILE...
//
// Signing writes `<FILE>.sig`. If release-keys.json lists no keys, signing is
// skipped with a notice. If it lists keys, a missing secret is an error, and
// every signature is verified against the listed keys before this exits, so a
// secret that does not match a published public key fails the release.
import { createHash, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  parsePrivateKey,
  parseReleaseKeys,
  signRelease,
  verifyReleaseSignature,
} from "../src/release-signing.ts";

function fail(message: string): never {
  console.error(`sign-release: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let tag = "";
let verifyOnly = false;
let keyId: string | undefined;
let keysPath = new URL("../release-keys.json", import.meta.url).pathname;
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "--verify") verifyOnly = true;
  else if (arg === "--tag") tag = args[++i] ?? "";
  else if (arg === "--key-id") keyId = args[++i];
  else if (arg === "--keys") keysPath = args[++i] ?? keysPath;
  else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
  else files.push(arg);
}

if (!/^v\d+\.\d+\.\d+/.test(tag)) fail("--tag vX.Y.Z is required");
if (files.length === 0) fail("no asset files given");
const keys = parseReleaseKeys(JSON.parse(readFileSync(keysPath, "utf8")));
const sha256 = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

function check(file: string): string {
  return verifyReleaseSignature({
    keys,
    tag,
    asset: basename(file),
    sha256: sha256(file),
    signatureText: readFileSync(`${file}.sig`, "utf8"),
  }).keyId;
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

if (verifyOnly) {
  if (keys.length === 0) fail("release-keys.json lists no keys to verify with");
  for (const file of files) {
    try {
      console.log(`ok ${basename(file)} (key ${check(file)})`);
    } catch (error) {
      fail(`${basename(file)}: ${reason(error)}`);
    }
  }
  process.exit(0);
}

if (keys.length === 0) {
  console.log(
    "sign-release: no keys in release-keys.json; signing skipped (assets stay SHA-256 only)",
  );
  process.exit(0);
}
const secret = process.env.RELEASE_SIGNING_KEY ?? "";
if (secret.trim() === "")
  fail(
    "release-keys.json lists keys but RELEASE_SIGNING_KEY is not set; refusing to publish unsigned assets",
  );
let privateKey: KeyObject;
try {
  privateKey = parsePrivateKey(secret);
} catch (error) {
  fail(reason(error));
}
for (const file of files) {
  const asset = basename(file);
  writeFileSync(
    `${file}.sig`,
    signRelease({
      privateKey,
      tag,
      asset,
      sha256: sha256(file),
      ...(keyId === undefined ? {} : { keyId }),
    }),
  );
  try {
    console.log(`signed ${asset} (verified with key ${check(file)})`);
  } catch (error) {
    fail(
      `${asset}: signing key does not match any key in release-keys.json (${reason(error)})`,
    );
  }
}
