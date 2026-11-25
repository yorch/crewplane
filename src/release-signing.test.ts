import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePrivateKey,
  parseReleaseKeys,
  parseSignature,
  type ReleaseKey,
  signedMessage,
  signRelease,
  verifyReleaseSignature,
} from "./release-signing.ts";
import {
  assetName,
  downloadRelease,
  type FetchLike,
  platformTarget,
  runUpdate,
  updateConfig,
} from "./update.ts";

type Pair = { priv: KeyObject; key: ReleaseKey; pkcs8: string };
const pair = (id: string): Pair => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey,
    pkcs8: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    key: {
      id,
      publicKey: publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
    },
  };
};
const hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const h = "ab".repeat(32);

describe("release signatures", () => {
  it("binds the documented canonical message", () => {
    assert.equal(
      signedMessage("v1.2.3", "crewplane-v1.2.3-linux-x86_64", h).toString(),
      `crewplane-release-v1\nv1.2.3\ncrewplane-v1.2.3-linux-x86_64\n${h}\n`,
    );
  });

  it("round-trips, with either public key encoding", () => {
    const a = pair("a");
    const text = signRelease({
      privateKey: a.priv,
      tag: "v1.0.0",
      asset: "x",
      sha256: h,
    });
    assert.equal(text.endsWith("\n"), true);
    assert.equal(Buffer.from(text.trim(), "base64").length, 64);
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(a.key.publicKey, "base64"),
    ]).toString("base64");
    for (const publicKey of [a.key.publicKey, spki])
      expect(
        verifyReleaseSignature({
          keys: [{ id: "a", publicKey }],
          tag: "v1.0.0",
          asset: "x",
          sha256: h,
          signatureText: text,
        }).keyId,
      ).toBe("a");
  });

  it("rejects a wrong key, tampered hash, tampered signature, other tag or asset", () => {
    const a = pair("a"),
      other = pair("b");
    const base = { keys: [a.key], tag: "v1.0.0", asset: "x", sha256: h };
    const text = signRelease({
      privateKey: a.priv,
      tag: "v1.0.0",
      asset: "x",
      sha256: h,
    });
    expect(() =>
      verifyReleaseSignature({
        ...base,
        keys: [other.key],
        signatureText: text,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({
        ...base,
        sha256: "cd".repeat(32),
        signatureText: text,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({ ...base, tag: "v1.0.1", signatureText: text }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({ ...base, asset: "y", signatureText: text }),
    ).toThrow(/does not match/);
    const raw = Buffer.from(text.trim(), "base64");
    raw[5] = (raw[5] ?? 0) ^ 1;
    expect(() =>
      verifyReleaseSignature({
        ...base,
        signatureText: raw.toString("base64"),
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({ ...base, signatureText: "AAAA" }),
    ).toThrow(/64-byte/);
    expect(() =>
      verifyReleaseSignature({ ...base, keys: [], signatureText: text }),
    ).toThrow(/no release keys/);
  });

  it("accepts any listed key (rotation) and honors a key id prefix", () => {
    const oldKey = pair("old"),
      newKey = pair("new");
    const keys = [oldKey.key, newKey.key];
    const input = { keys, tag: "v2.0.0", asset: "x", sha256: h };
    const byNew = signRelease({
      privateKey: newKey.priv,
      tag: "v2.0.0",
      asset: "x",
      sha256: h,
    });
    const byOld = signRelease({
      privateKey: oldKey.priv,
      tag: "v2.0.0",
      asset: "x",
      sha256: h,
    });
    expect(
      verifyReleaseSignature({ ...input, signatureText: byNew }).keyId,
    ).toBe("new");
    expect(
      verifyReleaseSignature({ ...input, signatureText: byOld }).keyId,
    ).toBe("old");
    const prefixed = signRelease({
      privateKey: newKey.priv,
      tag: "v2.0.0",
      asset: "x",
      sha256: h,
      keyId: "new",
    });
    expect(parseSignature(prefixed).keyId).toBe("new");
    expect(
      verifyReleaseSignature({ ...input, signatureText: prefixed }).keyId,
    ).toBe("new");
    // The prefix pins the key: naming the wrong one fails even if another verifies.
    expect(() =>
      verifyReleaseSignature({
        ...input,
        signatureText: `old:${byNew.trim()}`,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({
        ...input,
        signatureText: `nope:${byNew.trim()}`,
      }),
    ).toThrow(/unknown key/);
  });

  it("parses private keys as base64 PKCS8 or PEM and validates key files", () => {
    const a = pair("a");
    const pem = a.priv.export({ format: "pem", type: "pkcs8" }).toString();
    for (const text of [a.pkcs8, pem])
      assert.equal(parsePrivateKey(text).asymmetricKeyType, "ed25519");
    expect(() => parsePrivateKey("garbage")).toThrow(/PKCS8/);
    expect(parseReleaseKeys({ keys: [] })).toEqual([]);
    expect(() => parseReleaseKeys({})).toThrow();
    expect(() =>
      parseReleaseKeys({ keys: [{ id: "a", publicKey: "AAAA" }] }),
    ).toThrow();
    expect(() => parseReleaseKeys({ keys: [a.key, a.key] })).toThrow(
      /duplicate/,
    );
  });
});

const target = (() => {
  const t = platformTarget(process.platform, process.arch);
  if (t === null) throw new Error("unsupported host");
  return t;
})();
const OLD = "#!/bin/sh\necho 0.0.1\n";
const tag = "v9.9.9";
const asset = assetName(tag, target);
const payload = Buffer.concat([
  Buffer.from(
    target.os === "linux" ? [0x7f, 0x45, 0x4c, 0x46] : [0xcf, 0xfa, 0xed, 0xfe],
  ),
  Buffer.from("\nsigned release\n"),
]);

/** In-memory release host; `sig` null means the signature file is absent. */
const host = (sig: string | null, bytes: Buffer = payload) => {
  const requested: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    requested.push(input);
    const body = (value: string | Uint8Array | null) =>
      value === null
        ? new Response("nope", { status: 404 })
        : new Response(value as BodyInit, { status: 200 });
    if (input.endsWith("/latest"))
      return body(JSON.stringify({ tag_name: tag }));
    if (input.endsWith(`${asset}.sha256`))
      return body(`${hex(bytes)}  ${asset}\n`);
    if (input.endsWith(`${asset}.sig`)) return body(sig);
    if (input.endsWith(asset)) return body(bytes);
    return body(null);
  };
  return { fetchImpl, requested };
};
const config = updateConfig({
  CREWPLANE_RELEASE_API: "https://example.test/latest",
  CREWPLANE_RELEASE_BASE: "https://example.test/download",
});

describe("signed downloads", () => {
  it("reports signed integrity and the key when the signature verifies", async () => {
    const a = pair("2026-01");
    const sig = signRelease({
      privateKey: a.priv,
      tag,
      asset,
      sha256: hex(payload),
    });
    const result = await downloadRelease(
      tag,
      target,
      config,
      host(sig).fetchImpl,
      [a.key],
    );
    expect(result.integrity).toBe("signed");
    expect(result.signingKey).toBe("2026-01");
    expect(Buffer.from(result.bytes).equals(payload)).toBe(true);
  });

  it("refuses a missing signature when keys are configured", async () => {
    await expect(
      downloadRelease(tag, target, config, host(null).fetchImpl, [
        pair("a").key,
      ]),
    ).rejects.toThrow(/signature missing/);
  });

  it("refuses a signature from another key, another asset, or over other bytes", async () => {
    const a = pair("a"),
      stranger = pair("z");
    const sign = (privateKey: KeyObject, name = asset, bytes = payload) =>
      signRelease({ privateKey, tag, asset: name, sha256: hex(bytes) });
    const cases = [
      sign(stranger.priv),
      sign(a.priv, "crewplane-v9.9.9-other-arm64"),
      sign(a.priv, asset, Buffer.from("different")),
    ];
    for (const sig of cases)
      await expect(
        downloadRelease(tag, target, config, host(sig).fetchImpl, [a.key]),
      ).rejects.toThrow(/signature invalid/);
    // A replay from another tag is refused too.
    const replay = signRelease({
      privateKey: a.priv,
      tag: "v9.9.8",
      asset,
      sha256: hex(payload),
    });
    await expect(
      downloadRelease(tag, target, config, host(replay).fetchImpl, [a.key]),
    ).rejects.toThrow(/signature invalid/);
  });

  it("with no keys stays sha256-only and does not request a signature", async () => {
    const served = host(null);
    const result = await downloadRelease(
      tag,
      target,
      config,
      served.fetchImpl,
      [],
    );
    expect(result.integrity).toBe("sha256");
    expect(served.requested.some((url) => url.endsWith(".sig"))).toBe(false);
  });
});

describe("signed updates", () => {
  const run = async (sig: string | null, keys: ReleaseKey[]) => {
    const directory = mkdtempSync(join(tmpdir(), "crewplane-sig-"));
    const execPath = join(directory, "crewplane");
    writeFileSync(execPath, OLD, { mode: 0o755 });
    const request = {
      current: "0.0.1",
      environment: {
        CREWPLANE_RELEASE_API: "https://example.test/latest",
        CREWPLANE_RELEASE_BASE: "https://example.test/download",
        CREWPLANE_CACHE_DIR: join(directory, "cache"),
        CREWPLANE_RELEASES_DIR: join(directory, "releases"),
      },
      releaseMarked: true,
      execPath,
      platform: process.platform,
      arch: process.arch,
      safeToReplace: async () => true,
      runVersion: async () => "9.9.9",
      fetch: host(sig).fetchImpl,
      releaseKeys: keys,
    };
    return { directory, execPath, request };
  };

  it("installs and reports integrity signed", async () => {
    const a = pair("a");
    const { execPath, request } = await run(
      signRelease({ privateKey: a.priv, tag, asset, sha256: hex(payload) }),
      [a.key],
    );
    const outcome = await runUpdate(request);
    expect(outcome.status).toBe("updated");
    expect(outcome.integrity).toBe("signed");
    expect(readFileSync(execPath).equals(payload)).toBe(true);
  });

  it("refuses without a signature: nothing staged, nothing retained, executable untouched", async () => {
    const { directory, execPath, request } = await run(null, [pair("a").key]);
    await expect(runUpdate(request)).rejects.toThrow(/signature missing/);
    expect(readFileSync(execPath, "utf8")).toBe(OLD);
    expect(existsSync(join(directory, "releases"))).toBe(false);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(directory).filter((n) => n !== "cache")).toEqual([
      "crewplane",
    ]);
  });

  it("in auto mode a bad signature is a failed outcome that names the reason", async () => {
    const a = pair("a"),
      other = pair("b");
    const { execPath, request } = await run(
      signRelease({ privateKey: other.priv, tag, asset, sha256: hex(payload) }),
      [a.key],
    );
    const outcome = await runUpdate({ ...request, auto: true });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toMatch(/signature invalid/);
    expect(readFileSync(execPath, "utf8")).toBe(OLD);
  });

  it("with no keys installs on the checksum and says integrity sha256", async () => {
    const { execPath, request } = await run(null, []);
    const outcome = await runUpdate(request);
    expect(outcome.status).toBe("updated");
    expect(outcome.integrity).toBe("sha256");
    expect(readFileSync(execPath).equals(payload)).toBe(true);
  });
});
