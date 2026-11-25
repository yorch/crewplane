import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of raw bytes, or of a string's UTF-8 encoding. */
export const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

/**
 * SHA-256 of `JSON.stringify(value)`. Persisted keys depend on this exact
 * serialization, so a string input is hashed in its quoted JSON form.
 */
export const sha256Json = (value: unknown): string =>
  sha256Hex(JSON.stringify(value));
