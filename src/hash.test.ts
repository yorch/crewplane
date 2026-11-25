import { expect, it } from "vitest";
import { sha256Hex, sha256Json } from "./hash.ts";

// Vectors computed with the coreutils `sha256sum` tool, not with this module.
it("hashes raw bytes and strings (UTF-8) to lowercase hex", () => {
  expect(sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
});

it("hashes the JSON serialization, so strings are hashed in quoted form", () => {
  expect(sha256Json("abc")).toBe(sha256Hex('"abc"'));
  expect(sha256Json("abc")).toBe(
    "6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25",
  );
  expect(sha256Json({ a: [1, null] })).toBe(
    "a290b55a84a4e851c13e570346d396a0ff58e13e3b458112237484f9ed3b8950",
  );
});
