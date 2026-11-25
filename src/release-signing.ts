import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { compareVersions, parseTag } from "./update.ts";

/**
 * Release signing. A release is trusted when a listed Ed25519 key signed the
 * canonical message below. The tag, asset name and content hash are all bound,
 * so a signature cannot be replayed onto another tag, platform or file.
 */
export const signatureContext = "crewplane-release-v1";

export type ReleaseKey = { id: string; publicKey: string };
/**
 * `signedSince` is the first release tag that must carry a valid signature;
 * null with keys listed means every release must (strict). It is not a
 * minimum-version floor: older releases are still accepted on SHA-256.
 */
export type ReleaseTrust = { keys: ReleaseKey[]; signedSince: string | null };

/** Fixed DER prefix that turns a raw 32-byte Ed25519 key into SPKI. */
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const idPattern = /^[A-Za-z0-9._-]{1,64}$/;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The canonical message; every input is checked strictly, never normalized. */
export function signedMessage(
  tag: string,
  asset: string,
  sha256Hex: string,
): Buffer {
  parseTag(tag);
  if (
    !new RegExp(
      `^crewplane-${escapeRegExp(tag)}-(linux|macos)-(x86_64|arm64)$`,
    ).test(asset)
  )
    throw new Error(`asset name ${asset} is not a ${tag} release asset`);
  if (!/^[0-9a-f]{64}$/.test(sha256Hex))
    throw new Error("sha256 must be 64 lowercase hex characters");
  return Buffer.from(
    `${signatureContext}\n${tag}\n${asset}\n${sha256Hex}\n`,
    "utf8",
  );
}

/** True when base64 text is the canonical encoding of its bytes. */
function canonicalBase64(text: string): boolean {
  return (
    base64Pattern.test(text) &&
    Buffer.from(text, "base64").toString("base64") === text
  );
}

/** Validate the shape of `release-keys.json`; malformed content throws. */
export function parseReleaseTrust(value: unknown): ReleaseTrust {
  const object =
    typeof value === "object" && value !== null
      ? (value as { keys?: unknown; signedSince?: unknown })
      : {};
  const list = object.keys;
  if (!Array.isArray(list))
    throw new Error('release keys must be an object with a "keys" array');
  const seen = new Set<string>();
  const keys = list.map((entry: unknown) => {
    const { id, publicKey } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !idPattern.test(id))
      throw new Error("release key id must be 1-64 of [A-Za-z0-9._-]");
    if (seen.has(id)) throw new Error(`duplicate release key id ${id}`);
    seen.add(id);
    if (typeof publicKey !== "string")
      throw new Error(`release key ${id} has no base64 publicKey`);
    publicKeyObject(publicKey);
    return { id, publicKey };
  });
  const since = object.signedSince;
  if (since !== undefined && since !== null) parseTag(since);
  return { keys, signedSince: typeof since === "string" ? since : null };
}

export function parseReleaseKeys(value: unknown): ReleaseKey[] {
  return parseReleaseTrust(value).keys;
}

/** Whether a release at `tag` must carry a valid signature. */
export function signatureRequired(trust: ReleaseTrust, tag: string): boolean {
  if (trust.keys.length === 0) return false;
  if (trust.signedSince === null) return true;
  return compareVersions(tag, trust.signedSince) >= 0;
}

/** Accept a raw 32-byte key or an SPKI DER key, both base64. */
export function publicKeyObject(publicKey: string): KeyObject {
  if (
    (publicKey.length !== 44 && publicKey.length !== 60) ||
    !canonicalBase64(publicKey)
  )
    throw new Error("release public key is not canonical base64");
  const bytes = Buffer.from(publicKey, "base64");
  const der = bytes.length === 32 ? Buffer.concat([spkiPrefix, bytes]) : bytes;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("release public key is not a valid Ed25519 key");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("release public key is not an Ed25519 key");
  return key;
}

/** Parse one signature line: base64 of 64 raw bytes, optionally `<id>:` first. */
export function parseSignature(line: string): {
  keyId?: string;
  signature: Buffer;
} {
  const text = line.trim();
  const colon = text.indexOf(":");
  const keyId = colon === -1 ? undefined : text.slice(0, colon);
  const encoded = colon === -1 ? text : text.slice(colon + 1);
  if (keyId !== undefined && !idPattern.test(keyId))
    throw new Error("signature key id is malformed");
  if (
    encoded.length !== 88 ||
    !encoded.endsWith("==") ||
    !canonicalBase64(encoded)
  )
    throw new Error("signature must be a 64-byte Ed25519 signature");
  const signature = Buffer.from(encoded, "base64");
  return keyId === undefined ? { signature } : { keyId, signature };
}

const maxSignatureLines = 8;

/**
 * Verify against the listed keys. A `.sig` file holds one signature per line
 * (so a release can be signed by an old and a new key at once); it is valid if
 * ANY line verifies against ANY listed key. A line with an `<id>:` prefix is
 * tried only against that key and is skipped when the id is unknown here;
 * malformed lines are skipped. Throws a reason on failure.
 */
export function verifyReleaseSignature(input: {
  keys: readonly ReleaseKey[];
  tag: string;
  asset: string;
  sha256: string;
  signatureText: string;
}): { keyId: string } {
  if (input.keys.length === 0)
    throw new Error("no release keys are configured");
  const lines = input.signatureText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) throw new Error("signature file is empty");
  if (lines.length > maxSignatureLines)
    throw new Error("signature file has too many lines");
  const message = signedMessage(input.tag, input.asset, input.sha256);
  let firstError: Error | undefined;
  let tried = false;
  let unknown: string | undefined;
  for (const line of lines) {
    let parsed: ReturnType<typeof parseSignature>;
    try {
      parsed = parseSignature(line);
    } catch (error) {
      firstError ??= error as Error;
      continue;
    }
    const candidates =
      parsed.keyId === undefined
        ? input.keys
        : input.keys.filter((key) => key.id === parsed.keyId);
    if (candidates.length === 0) unknown ??= parsed.keyId;
    for (const key of candidates) {
      tried = true;
      if (
        verify(null, message, publicKeyObject(key.publicKey), parsed.signature)
      )
        return { keyId: key.id };
    }
  }
  if (tried)
    throw new Error("signature does not match any trusted release key");
  if (unknown !== undefined)
    throw new Error(`signature names unknown key ${unknown}`);
  throw firstError ?? new Error("signature file has no usable line");
}

/** PKCS8 PEM or base64 PKCS8 DER. */
export function parsePrivateKey(text: string): KeyObject {
  const trimmed = text.trim();
  try {
    const key = trimmed.includes("-----BEGIN")
      ? createPrivateKey(trimmed)
      : createPrivateKey({
          key: Buffer.from(trimmed.replace(/\s+/g, ""), "base64"),
          format: "der",
          type: "pkcs8",
        });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return key;
  } catch {
    throw new Error("signing key is not a PKCS8 Ed25519 private key");
  }
}

/** Return one signature line (`[<id>:]<base64>\n`); join lines to dual-sign. */
export function signRelease(input: {
  privateKey: KeyObject;
  tag: string;
  asset: string;
  sha256: string;
  keyId?: string;
}): string {
  const raw = sign(
    null,
    signedMessage(input.tag, input.asset, input.sha256),
    input.privateKey,
  ).toString("base64");
  return `${input.keyId === undefined ? "" : `${input.keyId}:`}${raw}\n`;
}
