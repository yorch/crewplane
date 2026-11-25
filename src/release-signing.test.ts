import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePrivateKey,
  parseReleaseTrust,
  parseSignature,
  type ReleaseKey,
  type ReleaseTrust,
  signatureRequired,
  signedMessage,
  signRelease,
  verifyReleaseSignature,
} from "./release-signing.ts";
import {
  assetName,
  downloadRelease,
  type FetchLike,
  platformTarget,
  type ReleaseTarget,
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
const asset100 = "crewplane-v1.0.0-linux-x86_64";
const trustOf = (keys: ReleaseKey[], signedSince: string | null = null) => ({
  keys,
  signedSince,
});
const sig = (
  priv: KeyObject,
  tag = "v1.0.0",
  asset = asset100,
  sha256 = h,
  keyId?: string,
) =>
  signRelease({
    privateKey: priv,
    tag,
    asset,
    sha256,
    ...(keyId === undefined ? {} : { keyId }),
  });

describe("release signatures", () => {
  it("binds the documented canonical message", () => {
    assert.equal(
      signedMessage("v1.2.3", "crewplane-v1.2.3-linux-x86_64", h).toString(),
      `crewplane-release-v1\nv1.2.3\ncrewplane-v1.2.3-linux-x86_64\n${h}\n`,
    );
  });

  it("refuses loose message inputs", () => {
    const asset = "crewplane-v1.2.3-macos-arm64";
    expect(() => signedMessage("1.2.3", asset, h)).toThrow(/tag/i);
    expect(() => signedMessage("v1.2.3\n", asset, h)).toThrow(/tag/i);
    expect(() => signedMessage("v1.2.3", "x", h)).toThrow(/asset name/);
    expect(() =>
      signedMessage("v1.2.3", "crewplane-v1.2.4-macos-arm64", h),
    ).toThrow(/asset name/);
    expect(() =>
      signedMessage("v1.2.3", "crewplane-v1.2.3-windows-arm64", h),
    ).toThrow(/asset name/);
    expect(() => signedMessage("v1.2.3", `${asset}\n`, h)).toThrow(
      /asset name/,
    );
    expect(() => signedMessage("v1.2.3", asset, h.toUpperCase())).toThrow(
      /sha256/,
    );
    expect(() => signedMessage("v1.2.3", asset, "ab")).toThrow(/sha256/);
    expect(() => signedMessage("v1.2.3", asset, `${h}\n`)).toThrow(/sha256/);
  });

  it("round-trips, with either public key encoding", () => {
    const a = pair("a");
    const text = sig(a.priv);
    assert.equal(text.endsWith("\n"), true);
    assert.equal(text.trim().length, 88);
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(a.key.publicKey, "base64"),
    ]).toString("base64");
    for (const publicKey of [a.key.publicKey, spki])
      expect(
        verifyReleaseSignature({
          keys: [{ id: "a", publicKey }],
          tag: "v1.0.0",
          asset: asset100,
          sha256: h,
          signatureText: text,
        }).keyId,
      ).toBe("a");
  });

  it("rejects a wrong key, tampered hash or signature, other tag or asset", () => {
    const a = pair("a");
    const other = pair("b");
    const base = { keys: [a.key], tag: "v1.0.0", asset: asset100, sha256: h };
    const text = sig(a.priv);
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
      verifyReleaseSignature({
        ...base,
        tag: "v1.0.1",
        asset: "crewplane-v1.0.1-linux-x86_64",
        signatureText: text,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({
        ...base,
        asset: "crewplane-v1.0.0-macos-arm64",
        signatureText: text,
      }),
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
    const oldKey = pair("old");
    const newKey = pair("new");
    const input = {
      keys: [oldKey.key, newKey.key],
      tag: "v1.0.0",
      asset: asset100,
      sha256: h,
    };
    expect(
      verifyReleaseSignature({ ...input, signatureText: sig(newKey.priv) })
        .keyId,
    ).toBe("new");
    expect(
      verifyReleaseSignature({ ...input, signatureText: sig(oldKey.priv) })
        .keyId,
    ).toBe("old");
    const prefixed = sig(newKey.priv, "v1.0.0", asset100, h, "new");
    expect(parseSignature(prefixed).keyId).toBe("new");
    expect(
      verifyReleaseSignature({ ...input, signatureText: prefixed }).keyId,
    ).toBe("new");
    const bare = sig(newKey.priv).trim();
    expect(() =>
      verifyReleaseSignature({ ...input, signatureText: `old:${bare}` }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({ ...input, signatureText: `nope:${bare}` }),
    ).toThrow(/unknown key/);
  });

  it("accepts a multi-line signature if any line verifies against any listed key", () => {
    const retired = pair("retired");
    const current = pair("current");
    const stranger = pair("stranger");
    const dual = sig(current.priv) + sig(retired.priv);
    // A binary that only knows the retired key still accepts the dual signature,
    // and so does one that only knows the current key.
    for (const keys of [
      [retired.key],
      [current.key],
      [retired.key, current.key],
    ])
      expect(
        verifyReleaseSignature({
          keys,
          tag: "v1.0.0",
          asset: asset100,
          sha256: h,
          signatureText: dual,
        }),
      ).toBeTruthy();
    const input = {
      keys: [current.key],
      tag: "v1.0.0",
      asset: asset100,
      sha256: h,
    };
    // Junk, unknown-id and blank lines are skipped, but one good line is needed.
    const noise = `\n!!!!\nzzz:${sig(stranger.priv).trim()}\n\n`;
    expect(
      verifyReleaseSignature({
        ...input,
        signatureText: noise + sig(current.priv),
      }).keyId,
    ).toBe("current");
    expect(() =>
      verifyReleaseSignature({
        ...input,
        signatureText: noise + sig(stranger.priv),
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({
        ...input,
        signatureText: `${sig(stranger.priv)}${sig(retired.priv)}`,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyReleaseSignature({ ...input, signatureText: "\n\n" }),
    ).toThrow(/empty/);
    expect(() =>
      verifyReleaseSignature({
        ...input,
        signatureText: sig(current.priv).repeat(9),
      }),
    ).toThrow(/too many/);
  });

  it("requires canonical base64 for keys and signatures", () => {
    const a = pair("a");
    const text = sig(a.priv).trim();
    const input = { keys: [a.key], tag: "v1.0.0", asset: asset100, sha256: h };
    // Non-canonical: same bytes, differently spelled (padding bits set, no padding, wrapped).
    const flipped = `${text.slice(0, 85)}${text[85] === "A" ? "B" : "C"}==`;
    expect(() =>
      verifyReleaseSignature({ ...input, signatureText: flipped }),
    ).toThrow();
    expect(() =>
      verifyReleaseSignature({ ...input, signatureText: text.slice(0, 86) }),
    ).toThrow();
    expect(() =>
      verifyReleaseSignature({
        ...input,
        signatureText: `${text.slice(0, 40)}\n${text.slice(40)}`,
      }),
    ).toThrow();
    const key = a.key.publicKey;
    const bad = `${key.slice(0, 42)}B=`;
    expect(() =>
      parseReleaseTrust({ keys: [{ id: "a", publicKey: bad }] }),
    ).toThrow(/canonical/);
    expect(() =>
      parseReleaseTrust({ keys: [{ id: "a", publicKey: key.slice(0, 43) }] }),
    ).toThrow();
  });

  it("parses private keys as base64 PKCS8 or PEM and validates key files", () => {
    const a = pair("a");
    const pem = a.priv.export({ format: "pem", type: "pkcs8" }).toString();
    for (const text of [a.pkcs8, pem])
      assert.equal(parsePrivateKey(text).asymmetricKeyType, "ed25519");
    expect(() => parsePrivateKey("garbage")).toThrow(/PKCS8/);
    expect(parseReleaseTrust({ keys: [] })).toEqual({
      keys: [],
      signedSince: null,
    });
    expect(() => parseReleaseTrust({})).toThrow();
    expect(() =>
      parseReleaseTrust({ keys: [{ id: "a", publicKey: "AAAA" }] }),
    ).toThrow();
    expect(() => parseReleaseTrust({ keys: [a.key, a.key] })).toThrow(
      /duplicate/,
    );
    expect(() =>
      parseReleaseTrust({ keys: [], signedSince: "0.7.0" }),
    ).toThrow();
    expect(
      parseReleaseTrust({ keys: [a.key], signedSince: "v0.7.0" }).signedSince,
    ).toBe("v0.7.0");
  });

  it("applies the signedSince floor numerically", () => {
    const keys = [pair("a").key];
    const since = (tag: string, floor: string | null) =>
      signatureRequired(trustOf(keys, floor), tag);
    expect(since("v0.6.9", "v0.7.0")).toBe(false);
    expect(since("v0.7.0", "v0.7.0")).toBe(true);
    expect(since("v0.10.0", "v0.9.0")).toBe(true);
    expect(since("v0.9.0", "v0.10.0")).toBe(false);
    expect(since("v1.0.0", "v0.10.0")).toBe(true);
    expect(since("v0.0.1", null)).toBe(true);
    expect(signatureRequired(trustOf([], "v0.7.0"), "v9.0.0")).toBe(false);
  });
});

const hostTarget = (() => {
  const t = platformTarget(process.platform, process.arch);
  if (t === null) throw new Error("unsupported host");
  return t;
})();
const tag = "v9.9.9";
const OLD = "#!/bin/sh\necho 0.0.1\n";
const allTargets = [
  { os: "linux", arch: "x86_64" },
  { os: "linux", arch: "arm64" },
  { os: "macos", arch: "x86_64" },
  { os: "macos", arch: "arm64" },
] as const;
const config = updateConfig({
  CREWPLANE_RELEASE_API: "https://example.test/latest",
  CREWPLANE_RELEASE_BASE: "https://example.test/download",
});

/** A release for one platform, independent of the machine running the tests. */
const world = (target: ReleaseTarget) => {
  const asset = assetName(tag, target);
  const payload = Buffer.concat([
    Buffer.from(
      target.os === "linux"
        ? [0x7f, 0x45, 0x4c, 0x46]
        : [0xcf, 0xfa, 0xed, 0xfe],
    ),
    Buffer.from("\nsigned release\n"),
  ]);
  /** In-memory release host; `signature` null means the .sig file is absent. */
  const host = (signature: string | null, bytes: Buffer = payload) => {
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
      if (input.endsWith(`${asset}.sig`)) return body(signature);
      if (input.endsWith(asset)) return body(bytes);
      return body(null);
    };
    return { fetchImpl, requested };
  };
  const signFor = (priv: KeyObject) => sig(priv, tag, asset, hex(payload));
  /** A valid asset name of a platform other than this release's. */
  const otherAsset =
    allTargets.map((t) => assetName(tag, t)).find((name) => name !== asset) ??
    "";
  return { target, asset, payload, host, signFor, otherAsset };
};
const { payload, host, signFor } = world(hostTarget);

describe.each(allTargets)("signed downloads for $os-$arch", (platform) => {
  const { target, asset, payload, host, signFor, otherAsset } = world(platform);
  it("reports signed integrity and the key when the signature verifies", async () => {
    const a = pair("2026-01");
    const result = await downloadRelease(
      tag,
      target,
      config,
      host(signFor(a.priv)).fetchImpl,
      trustOf([a.key]),
    );
    expect(result.integrity).toBe("signed");
    expect(result.signingKey).toBe("2026-01");
    expect(Buffer.from(result.bytes).equals(payload)).toBe(true);
  });

  it("accepts a dual-signed release for a binary with only one of the keys", async () => {
    const retired = pair("retired");
    const current = pair("current");
    const dual = signFor(current.priv) + signFor(retired.priv);
    for (const only of [retired, current]) {
      const result = await downloadRelease(
        tag,
        target,
        config,
        host(dual).fetchImpl,
        trustOf([only.key]),
      );
      expect(result.signingKey).toBe(only.key.id);
    }
  });

  it("refuses a missing signature when keys are configured", async () => {
    await expect(
      downloadRelease(
        tag,
        target,
        config,
        host(null).fetchImpl,
        trustOf([pair("a").key]),
      ),
    ).rejects.toThrow(/signature missing/);
  });

  it("refuses a signature from another key, another asset, other bytes or another tag", async () => {
    const a = pair("a");
    const stranger = pair("z");
    const cases = [
      signFor(stranger.priv),
      sig(a.priv, tag, otherAsset, hex(payload)),
      sig(a.priv, tag, asset, hex(Buffer.from("different"))),
      sig(a.priv, "v9.9.8", assetName("v9.9.8", target), hex(payload)),
    ];
    for (const signature of cases)
      await expect(
        downloadRelease(
          tag,
          target,
          config,
          host(signature).fetchImpl,
          trustOf([a.key]),
        ),
      ).rejects.toThrow(/signature invalid/);
  });

  it("with no keys stays sha256-only, silently, and does not request a signature", async () => {
    const served = host(null);
    const result = await downloadRelease(
      tag,
      target,
      config,
      served.fetchImpl,
      trustOf([]),
    );
    expect(result.integrity).toBe("sha256");
    expect(result.note).toBeUndefined();
    expect(served.requested.some((url) => url.endsWith(".sig"))).toBe(false);
  });

  it("applies the signedSince floor: older tags install on sha256 with a note, newer ones need a signature", async () => {
    const a = pair("a");
    const below = await downloadRelease(
      tag,
      target,
      config,
      host(null).fetchImpl,
      trustOf([a.key], "v10.0.0"),
    );
    expect(below.integrity).toBe("sha256");
    expect(below.note).toMatch(/predates signed releases/);
    await expect(
      downloadRelease(
        tag,
        target,
        config,
        host(null).fetchImpl,
        trustOf([a.key], "v9.9.9"),
      ),
    ).rejects.toThrow(/signature missing/);
    await expect(
      downloadRelease(
        tag,
        target,
        config,
        host(null).fetchImpl,
        trustOf([a.key], "v9.9.8"),
      ),
    ).rejects.toThrow(/signature missing/);
    // Numeric, not lexical: 9.9.9 is below 9.10.0 and above 9.9.8.
    const numeric = await downloadRelease(
      tag,
      target,
      config,
      host(null).fetchImpl,
      trustOf([a.key], "v9.10.0"),
    );
    expect(numeric.integrity).toBe("sha256");
  });
});

describe("signed updates", () => {
  const run = async (signature: string | null, releaseTrust: ReleaseTrust) => {
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
      fetch: host(signature).fetchImpl,
      releaseTrust,
    };
    return { directory, execPath, request };
  };

  it("installs and reports integrity signed", async () => {
    const a = pair("a");
    const { execPath, request } = await run(signFor(a.priv), trustOf([a.key]));
    const outcome = await runUpdate(request);
    expect(outcome.status).toBe("updated");
    expect(outcome.integrity).toBe("signed");
    expect(readFileSync(execPath).equals(payload)).toBe(true);
  });

  it("refuses without a signature: nothing staged, nothing retained, executable untouched", async () => {
    const { directory, execPath, request } = await run(
      null,
      trustOf([pair("a").key]),
    );
    await expect(runUpdate(request)).rejects.toThrow(/signature missing/);
    expect(readFileSync(execPath, "utf8")).toBe(OLD);
    expect(existsSync(join(directory, "releases"))).toBe(false);
    expect(readdirSync(directory).filter((n) => n !== "cache")).toEqual([
      "crewplane",
    ]);
  });

  it("in auto mode a bad signature is a failed outcome that names the reason", async () => {
    const a = pair("a");
    const { execPath, request } = await run(
      signFor(pair("b").priv),
      trustOf([a.key]),
    );
    const outcome = await runUpdate({ ...request, auto: true });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toMatch(/signature invalid/);
    expect(readFileSync(execPath, "utf8")).toBe(OLD);
  });

  it("with no keys installs on the checksum and says integrity sha256", async () => {
    const { execPath, request } = await run(null, trustOf([]));
    const outcome = await runUpdate(request);
    expect(outcome.status).toBe("updated");
    expect(outcome.integrity).toBe("sha256");
    expect(outcome.note).toBeUndefined();
    expect(readFileSync(execPath).equals(payload)).toBe(true);
  });

  it("below the signedSince floor installs on sha256 and carries the note", async () => {
    const { request } = await run(null, trustOf([pair("a").key], "v10.0.0"));
    const outcome = await runUpdate(request);
    expect(outcome.status).toBe("updated");
    expect(outcome.integrity).toBe("sha256");
    expect(outcome.note).toMatch(/predates signed releases/);
  });
});
