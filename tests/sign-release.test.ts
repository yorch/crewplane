import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

const bun = process.env.BUN ?? "bun";
const sign = resolve("scripts/sign-release.ts");
const gen = resolve("scripts/gen-release-key.ts");

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    secret: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
  };
};
const workspace = (keys: { id: string; publicKey: string }[]) => {
  const dir = mkdtempSync(join(tmpdir(), "crewplane-sign-"));
  const keysFile = join(dir, "keys.json");
  writeFileSync(keysFile, JSON.stringify({ keys }));
  const file = join(dir, "crewplane-v1.0.0-linux-x86_64");
  writeFileSync(file, "binary bytes");
  return { dir, keysFile, file };
};
const cli = (args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(bun, [sign, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
};

describe("scripts/sign-release.ts", () => {
  it("signs with a base64 or PEM key, then verifies and detects tampering", () => {
    for (const style of ["secret", "pem"] as const) {
      const a = pair();
      const w = workspace([{ id: "k", publicKey: a.publicKey }]);
      const signed = cli(["--keys", w.keysFile, "--tag", "v1.0.0", w.file], {
        RELEASE_SIGNING_KEY: a[style],
      });
      assert.equal(signed.status, 0, signed.err);
      assert.equal(
        Buffer.from(readFileSync(`${w.file}.sig`, "utf8").trim(), "base64")
          .length,
        64,
      );
      const ok = cli([
        "--verify",
        "--keys",
        w.keysFile,
        "--tag",
        "v1.0.0",
        w.file,
      ]);
      assert.equal(ok.status, 0, ok.err);
      assert.match(ok.out, /ok crewplane-v1.0.0-linux-x86_64 \(key k\)/);
      assert.notEqual(
        cli(["--verify", "--keys", w.keysFile, "--tag", "v1.0.1", w.file])
          .status,
        0,
      );
      writeFileSync(w.file, "tampered");
      assert.notEqual(
        cli(["--verify", "--keys", w.keysFile, "--tag", "v1.0.0", w.file])
          .status,
        0,
      );
    }
  });

  it("skips with a notice when no keys are configured", () => {
    const w = workspace([]);
    const result = cli(["--keys", w.keysFile, "--tag", "v1.0.0", w.file]);
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /signing skipped/);
    assert.equal(existsSync(`${w.file}.sig`), false);
  });

  it("fails when keys are configured but the secret is missing or foreign", () => {
    const a = pair();
    const w = workspace([{ id: "k", publicKey: a.publicKey }]);
    const missing = cli(["--keys", w.keysFile, "--tag", "v1.0.0", w.file]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.err, /RELEASE_SIGNING_KEY is not set/);
    const foreign = cli(["--keys", w.keysFile, "--tag", "v1.0.0", w.file], {
      RELEASE_SIGNING_KEY: pair().secret,
    });
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.err, /does not match any key/);
  });
});

describe("scripts/gen-release-key.ts", () => {
  it("prints a usable keypair and writes no files", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewplane-gen-"));
    const result = spawnSync(bun, [gen, "--id", "2030-01"], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n");
    const secret = lines[1] ?? "";
    const entry = JSON.parse(lines.slice(4).join("\n")) as {
      id: string;
      publicKey: string;
    };
    assert.equal(entry.id, "2030-01");
    const w = workspace([entry]);
    const signed = cli(["--keys", w.keysFile, "--tag", "v1.0.0", w.file], {
      RELEASE_SIGNING_KEY: secret,
    });
    assert.equal(signed.status, 0, signed.err);
    assert.equal(existsSync(join(dir, "release-keys.json")), false);
  });
});
