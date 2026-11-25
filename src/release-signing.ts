import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";

/**
 * Release signing. A release is trusted when a listed Ed25519 key signed the
 * canonical message below. The tag, asset name and content hash are all bound,
 * so a signature cannot be replayed onto another tag, platform or file.
 */
export const signatureContext = "crewplane-release-v1";

export type ReleaseKey = { id: string; publicKey: string };

/** Fixed DER prefix that turns a raw 32-byte Ed25519 key into SPKI. */
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const idPattern = /^[A-Za-z0-9._-]{1,64}$/;

export function signedMessage(
  tag: string,
  asset: string,
  sha256Hex: string,
): Buffer {
  return Buffer.from(
    `${signatureContext}\n${tag}\n${asset}\n${sha256Hex.toLowerCase()}\n`,
    "utf8",
  );
}

/** Validate the shape of `release-keys.json`; malformed content throws. */
export function parseReleaseKeys(value: unknown): ReleaseKey[] {
  const list =
    typeof value === "object" && value !== null
      ? (value as { keys?: unknown }).keys
      : undefined;
  if (!Array.isArray(list))
    throw new Error('release keys must be an object with a "keys" array');
  const seen = new Set<string>();
  return list.map((entry: unknown) => {
    const { id, publicKey } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !idPattern.test(id))
      throw new Error("release key id must be 1-64 of [A-Za-z0-9._-]");
    if (seen.has(id)) throw new Error(`duplicate release key id ${id}`);
    seen.add(id);
    if (typeof publicKey !== "string" || !base64Pattern.test(publicKey))
      throw new Error(`release key ${id} has no base64 publicKey`);
    publicKeyObject(publicKey);
    return { id, publicKey };
  });
}

/** Accept a raw 32-byte key or an SPKI DER key, both base64. */
export function publicKeyObject(publicKey: string): KeyObject {
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

/** Parse a `.sig` file: base64 of 64 raw bytes, optionally `<id>:` first. */
export function parseSignature(text: string): {
  keyId?: string;
  signature: Buffer;
} {
  const line = text.trim();
  if (line === "" || /[\r\n]/.test(line))
    throw new Error("signature file must hold exactly one line");
  const colon = line.indexOf(":");
  const keyId = colon === -1 ? undefined : line.slice(0, colon);
  const encoded = colon === -1 ? line : line.slice(colon + 1);
  if (keyId !== undefined && !idPattern.test(keyId))
    throw new Error("signature key id is malformed");
  if (!base64Pattern.test(encoded)) throw new Error("signature is not base64");
  const signature = Buffer.from(encoded, "base64");
  if (signature.length !== 64)
    throw new Error("signature must be a 64-byte Ed25519 signature");
  return keyId === undefined ? { signature } : { keyId, signature };
}

/**
 * Verify against the listed keys. With a key id prefix only that key is tried;
 * otherwise any key may verify. Throws a reason on failure, never returns false.
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
  const { keyId, signature } = parseSignature(input.signatureText);
  const candidates =
    keyId === undefined
      ? input.keys
      : input.keys.filter((key) => key.id === keyId);
  if (candidates.length === 0)
    throw new Error(`signature names unknown key ${keyId}`);
  const message = signedMessage(input.tag, input.asset, input.sha256);
  for (const key of candidates)
    if (verify(null, message, publicKeyObject(key.publicKey), signature))
      return { keyId: key.id };
  throw new Error("signature does not match any trusted release key");
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

/** Return the single-line `.sig` content for an asset. */
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
