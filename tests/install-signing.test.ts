import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const run = promisify(execFile);
const patch = "9.9.9";
const assetOs = process.platform === "darwin" ? "macos" : "linux";
const assetArch = process.arch === "x64" ? "x86_64" : "arm64";
const asset = `crewplane-v${patch}-${assetOs}-${assetArch}`;
const payload = `#!/bin/sh\n[ "\${1:-}" = "--version" ] && printf '%s\\n' ${patch}\nexit 0\n`;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const installer = resolve("install.sh");
const temporary = () => mkdtempSync(join(tmpdir(), "crewplane-signing-"));

let signature: string | null = null;
let checksum = sha256(payload);
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  const binary = `/download/v${patch}/${asset}`;
  const send = (body: string | null) => {
    response.writeHead(body === null ? 404 : 200);
    response.end(body ?? "not found");
  };
  if (url === "/latest") send(JSON.stringify({ tag_name: `v${patch}` }));
  else if (url === binary) send(payload);
  else if (url === `${binary}.sha256`) send(`${checksum}  ${asset}\n`);
  else if (url === `${binary}.sig`) send(signature);
  else send(null);
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
beforeEach(() => {
  signature = null;
  checksum = sha256(payload);
});

// The same RFC 8032 test 2 vector the installer probes with, authored here
// independently as hex.
const opensslEd25519 = (() => {
  const dir = temporary();
  try {
    writeFileSync(join(dir, "m"), "r");
    writeFileSync(
      join(dir, "k.pem"),
      `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(
          "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
          "hex",
        ),
      ]).toString("base64")}\n-----END PUBLIC KEY-----\n`,
    );
    writeFileSync(
      join(dir, "s"),
      Buffer.from(
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
        "hex",
      ),
    );
    execFileSync(
      "openssl",
      [
        "pkeyutl",
        "-verify",
        "-pubin",
        "-inkey",
        join(dir, "k.pem"),
        "-rawin",
        "-in",
        join(dir, "m"),
        "-sigfile",
        join(dir, "s"),
      ],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
})();

type Pair = { privateKey: KeyObject; publicKey: string };
const keypair = (): Pair => {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
  };
};
const signed = (key: KeyObject, tag: string, name: string) =>
  sign(
    null,
    Buffer.from(`crewplane-release-v1\n${tag}\n${name}\n${sha256(payload)}\n`),
    key,
  ).toString("base64");

/** Copy install.sh with its key block replaced by throwaway test keys. */
const installerWithKeys = (
  keys: { id: string; publicKey: string }[],
  signedSince = "",
) => {
  const source = readFileSync(installer, "utf8");
  const begin = source.indexOf("# BEGIN RELEASE KEYS");
  const endMarker = "# END RELEASE KEYS";
  const end = source.indexOf(endMarker);
  assert(begin > 0 && end > begin);
  const path = join(temporary(), "install.sh");
  const body = keys.map((k) => `\n${k.id} ${k.publicKey}`).join("");
  writeFileSync(
    path,
    `${source.slice(0, begin)}# BEGIN RELEASE KEYS\nrelease_signed_since='${signedSince}'\nrelease_keys='${body}\n'\n${source.slice(end)}`,
  );
  return path;
};

const installWith = async (
  script: string,
  directory: string,
  args: string[] = [],
  env: Record<string, string> = {},
) => {
  try {
    const result = await run("sh", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CREWPLANE_RELEASE_API: `${base}/latest`,
        CREWPLANE_RELEASE_BASE: `${base}/download`,
        CREWPLANE_INSTALL_DIR: directory,
        ...env,
      },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const f = error as { code?: number; stdout?: string; stderr?: string };
    return {
      status: f.code ?? 1,
      stdout: f.stdout ?? "",
      stderr: f.stderr ?? "",
    };
  }
};

/** A directory placed first on PATH holding a stand-in `openssl`. */
const fakeOpenssl = (body: string) => {
  const bin = join(temporary(), "fakebin");
  mkdirSync(bin);
  writeFileSync(join(bin, "openssl"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
};
const tag = `v${patch}`;
const bin = () => join(temporary(), "bin");

describe("install.sh signing", () => {
  beforeAll(() => {
    // Never let a CI machine silently skip the verification tests.
    if (process.env.CI && !opensslEd25519)
      throw new Error(
        "CI requires an openssl that verifies Ed25519 (pkeyutl -verify -rawin)",
      );
  });

  it("embeds exactly the keys and signedSince in release-keys.json", () => {
    const source = readFileSync(installer, "utf8");
    const block = /release_keys='([^']*)'/.exec(source)?.[1] ?? "";
    const since = /release_signed_since='([^']*)'/.exec(source)?.[1];
    const embedded = block
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [id, publicKey] = line.trim().split(/\s+/);
        return { id, publicKey };
      });
    const configured = JSON.parse(
      readFileSync("release-keys.json", "utf8"),
    ) as {
      signedSince?: string | null;
      keys: { id: string; publicKey: string }[];
    };
    assert.deepEqual(embedded, configured.keys);
    assert.equal(since, configured.signedSince ?? "");
  });

  it("with no keys installs on the checksum and says so", async () => {
    const result = await installWith(installerWithKeys([]), bin());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no release signing keys are configured/);
  });

  it.skipIf(!opensslEd25519)(
    "installs a release with a valid signature",
    async () => {
      const a = keypair();
      signature = `${signed(a.privateKey, tag, asset)}\n`;
      const directory = bin();
      const result = await installWith(
        installerWithKeys([{ id: "k1", publicKey: a.publicKey }]),
        directory,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /signature verified \(key k1\)/);
      assert.equal(readFileSync(join(directory, "crewplane"), "utf8"), payload);
    },
  );

  it.skipIf(!opensslEd25519)(
    "accepts any listed key and an id-prefixed signature",
    async () => {
      const retired = keypair();
      const current = keypair();
      signature = `current:${signed(current.privateKey, tag, asset)}\n`;
      const result = await installWith(
        installerWithKeys([
          { id: "retired", publicKey: retired.publicKey },
          { id: "current", publicKey: current.publicKey },
        ]),
        bin(),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /key current/);
    },
  );

  it.skipIf(!opensslEd25519)(
    "accepts a dual-signed .sig for an installer that knows either key",
    async () => {
      const retired = keypair();
      const current = keypair();
      signature = `${signed(current.privateKey, tag, asset)}\n${signed(retired.privateKey, tag, asset)}\n`;
      for (const known of [retired, current]) {
        const result = await installWith(
          installerWithKeys([{ id: "only", publicKey: known.publicKey }]),
          bin(),
        );
        assert.equal(result.status, 0, result.stderr);
      }
      // Unusable lines are skipped; a good line still counts. A last line
      // without a newline is read too.
      const stranger = keypair();
      signature = `\n!!!!\nzzz:${signed(stranger.privateKey, tag, asset)}\n${signed(stranger.privateKey, tag, asset)}\n${signed(current.privateKey, tag, asset)}`;
      const mixed = await installWith(
        installerWithKeys([{ id: "only", publicKey: current.publicKey }]),
        bin(),
      );
      assert.equal(mixed.status, 0, mixed.stderr);
    },
  );

  it.skipIf(!opensslEd25519)(
    "refuses a multi-line .sig where no line verifies",
    async () => {
      const trusted = keypair();
      const one = keypair();
      const two = keypair();
      signature = `${signed(one.privateKey, tag, asset)}\n${signed(two.privateKey, tag, asset)}\n`;
      const directory = bin();
      const result = await installWith(
        installerWithKeys([{ id: "k1", publicKey: trusted.publicKey }]),
        directory,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /verification failed/);
      assert.equal(existsSync(join(directory, "crewplane")), false);
    },
  );

  it.skipIf(!opensslEd25519)(
    "refuses bad, foreign, replayed, non-canonical or missing signatures and installs nothing",
    async () => {
      const trusted = keypair();
      const stranger = keypair();
      const keys = [{ id: "k1", publicKey: trusted.publicKey }];
      const good = signed(trusted.privateKey, tag, asset);
      const cases: [string, string | null, RegExp][] = [
        [
          "foreign key",
          signed(stranger.privateKey, tag, asset),
          /verification failed/,
        ],
        [
          "other tag",
          signed(trusted.privateKey, "v9.9.8", asset),
          /verification failed/,
        ],
        [
          "other asset",
          signed(trusted.privateKey, tag, "crewplane-v9.9.9-linux-other"),
          /verification failed/,
        ],
        ["garbage", "!!!!", /verification failed/],
        ["non-canonical", `${good.slice(0, 85)}B==`, /verification failed/],
        ["unpadded", good.slice(0, 86), /verification failed/],
        ["missing", null, /no signature published/],
      ];
      for (const [label, value, expected] of cases) {
        signature = value;
        const directory = bin();
        const result = await installWith(installerWithKeys(keys), directory);
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, expected, label);
        assert.equal(existsSync(join(directory, "crewplane")), false, label);
        assert.deepEqual(readdirSync(directory), [], label);
      }
    },
  );

  it.skipIf(!opensslEd25519)(
    "--allow-unverified never skips verification when openssl can verify",
    async () => {
      const a = keypair();
      const stranger = keypair();
      const script = installerWithKeys([{ id: "k1", publicKey: a.publicKey }]);
      signature = `${signed(stranger.privateKey, tag, asset)}\n`;
      const directory = bin();
      const bad = await installWith(script, directory, ["--allow-unverified"]);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /verification failed/);
      assert.doesNotMatch(bad.stderr, /WARNING/);
      assert.equal(existsSync(join(directory, "crewplane")), false);
      signature = null;
      const missing = await installWith(script, bin(), ["--allow-unverified"]);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /no signature published/);
      signature = `${signed(a.privateKey, tag, asset)}\n`;
      const good = await installWith(script, bin(), ["--allow-unverified"]);
      assert.equal(good.status, 0, good.stderr);
      assert.match(good.stderr, /signature verified/);
    },
  );

  it("refuses when openssl cannot verify Ed25519, unless --allow-unverified", async () => {
    const a = keypair();
    const script = installerWithKeys([{ id: "k1", publicKey: a.publicKey }]);
    // An openssl that verifies nothing, like macOS's LibreSSL.
    const env = fakeOpenssl("exit 1");
    const directory = bin();
    const refused = await installWith(script, directory, [], env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /openssl cannot verify Ed25519/);
    assert.match(refused.stderr, /brew install openssl/);
    assert.match(refused.stderr, /brew --prefix openssl@3\)\/bin/);
    assert.match(
      refused.stderr,
      /only if that is impossible|Only if that is impossible/,
    );
    assert.match(refused.stderr, /--allow-unverified/);
    assert.equal(existsSync(join(directory, "crewplane")), false);

    const allowed = await installWith(
      script,
      directory,
      ["--allow-unverified"],
      env,
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(
      allowed.stderr,
      /WARNING: this machine's openssl cannot verify/,
    );
    assert.equal(readFileSync(join(directory, "crewplane"), "utf8"), payload);
  });

  it("refuses an openssl that accepts everything (negative known-answer check)", async () => {
    const a = keypair();
    const script = installerWithKeys([{ id: "k1", publicKey: a.publicKey }]);
    signature = `${signed(a.privateKey, tag, asset)}\n`;
    const directory = bin();
    const result = await installWith(
      script,
      directory,
      [],
      fakeOpenssl("exit 0"),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /openssl cannot verify Ed25519/);
    assert.equal(existsSync(join(directory, "crewplane")), false);
  });

  it("--allow-unverified still enforces the checksum", async () => {
    const a = keypair();
    checksum = "0".repeat(64);
    const result = await installWith(
      installerWithKeys([{ id: "k1", publicKey: a.publicKey }]),
      bin(),
      ["--allow-unverified"],
      fakeOpenssl("exit 1"),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
  });

  it("version_ge compares numerically", () => {
    const source = readFileSync(installer, "utf8");
    const start = source.indexOf("version_ge() {");
    const fn = source.slice(start, source.indexOf("\n}\n", start) + 3);
    const ge = (a: string, b: string) =>
      spawnSync("sh", ["-c", `${fn}\nversion_ge "${a}" "${b}"`]).status === 0;
    assert.equal(ge("v0.10.0", "v0.9.0"), true);
    assert.equal(ge("v0.9.0", "v0.10.0"), false);
    assert.equal(ge("v1.0.0", "v0.99.99"), true);
    assert.equal(ge("v0.7.0", "v0.7.0"), true);
    assert.equal(ge("v0.6.9", "v0.7.0"), false);
    assert.equal(ge("v0.7.1", "v0.7.0"), true);
    assert.equal(ge("v0.7.0", "v0.7.0-rc.1"), true);
    assert.equal(ge("v0.7.0-rc.1", "v0.7.0"), false);
    assert.equal(ge("v0.7.0+build", "v0.7.0"), true);
  });

  it("the signedSince floor: older releases install on SHA-256 with a warning, newer ones need a signature", async () => {
    const a = keypair();
    const keys = [{ id: "k1", publicKey: a.publicKey }];
    signature = null;
    // 9.9.9 is below each of these floors, numerically (9.10.0 > 9.9.9).
    for (const floor of ["v9.9.10", "v9.10.0", "v10.0.0"]) {
      const directory = bin();
      const result = await installWith(
        installerWithKeys(keys, floor),
        directory,
        [],
        fakeOpenssl("exit 1"),
      );
      assert.equal(result.status, 0, `${floor}: ${result.stderr}`);
      assert.match(result.stderr, /WARNING: v9\.9\.9 predates signed releases/);
      assert.equal(readFileSync(join(directory, "crewplane"), "utf8"), payload);
    }
    // At or above the floor a signature is required (no .sig is published).
    for (const floor of ["v9.9.9", "v9.9.8", "v9.8.99", "v0.10.0", ""]) {
      const directory = bin();
      const result = await installWith(
        installerWithKeys(keys, floor),
        directory,
      );
      assert.notEqual(result.status, 0, floor);
      assert.equal(existsSync(join(directory, "crewplane")), false, floor);
    }
  });

  it.skipIf(!opensslEd25519)(
    "every key written by sync-install-keys round-trips through the installer",
    async () => {
      const keys = ["a", "b", "c"].map((id) => ({ id, ...keypair() }));
      const dir = temporary();
      const keysFile = join(dir, "keys.json");
      writeFileSync(
        keysFile,
        JSON.stringify({
          signedSince: "v9.9.9",
          keys: keys.map((k) => ({ id: k.id, publicKey: k.publicKey })),
        }),
      );
      const copy = join(dir, "install.sh");
      writeFileSync(copy, readFileSync(installer, "utf8"));
      const sync = (extra: string[]) =>
        spawnSync(
          process.env.BUN ?? "bun",
          [
            resolve("scripts/sync-install-keys.ts"),
            "--keys",
            keysFile,
            "--install",
            copy,
            ...extra,
          ],
          { encoding: "utf8" },
        );
      assert.notEqual(sync(["--check"]).status, 0);
      assert.equal(sync([]).status, 0);
      assert.equal(sync(["--check"]).status, 0);
      assert.match(
        readFileSync(copy, "utf8"),
        /release_signed_since='v9\.9\.9'/,
      );
      for (const key of keys) {
        signature = `${signed(key.privateKey, tag, asset)}\n`;
        const result = await installWith(copy, bin());
        assert.equal(result.status, 0, `${key.id}: ${result.stderr}`);
        assert.match(result.stderr, new RegExp(`key ${key.id}\\)`));
      }
    },
  );
});
