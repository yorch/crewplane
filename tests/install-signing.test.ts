import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
const installerWithKeys = (keys: { id: string; publicKey: string }[]) => {
  const source = readFileSync(installer, "utf8");
  const begin = source.indexOf("release_keys='");
  const end = source.indexOf("'\n", begin + 14);
  assert(begin > 0 && end > begin);
  const path = join(temporary(), "install.sh");
  const body = keys.map((k) => `\n${k.id} ${k.publicKey}`).join("");
  writeFileSync(
    path,
    `${source.slice(0, begin)}release_keys='${body}\n${source.slice(end)}`,
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

describe("install.sh signing", () => {
  it("embeds exactly the keys in release-keys.json", () => {
    const block =
      /release_keys='([^']*)'/.exec(readFileSync(installer, "utf8"))?.[1] ?? "";
    const embedded = block
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [id, publicKey] = line.trim().split(/\s+/);
        return { id, publicKey };
      });
    const configured = JSON.parse(
      readFileSync("release-keys.json", "utf8"),
    ) as { keys: { id: string; publicKey: string }[] };
    assert.deepEqual(embedded, configured.keys);
  });

  it("with no keys installs on the checksum and says so", async () => {
    const directory = join(temporary(), "bin");
    const result = await installWith(installerWithKeys([]), directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no release signing keys are configured/);
  });

  it.skipIf(!opensslEd25519)(
    "installs a release with a valid signature",
    async () => {
      const a = keypair();
      signature = `${signed(a.privateKey, `v${patch}`, asset)}\n`;
      const directory = join(temporary(), "bin");
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
      signature = `current:${signed(current.privateKey, `v${patch}`, asset)}\n`;
      const result = await installWith(
        installerWithKeys([
          { id: "retired", publicKey: retired.publicKey },
          { id: "current", publicKey: current.publicKey },
        ]),
        join(temporary(), "bin"),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /key current/);
    },
  );

  it.skipIf(!opensslEd25519)(
    "refuses bad, foreign, replayed or missing signatures and installs nothing",
    async () => {
      const trusted = keypair();
      const stranger = keypair();
      const keys = [{ id: "k1", publicKey: trusted.publicKey }];
      const cases: [string, string | null, RegExp][] = [
        [
          "foreign key",
          signed(stranger.privateKey, `v${patch}`, asset),
          /verification failed/,
        ],
        [
          "other tag",
          signed(trusted.privateKey, "v9.9.8", asset),
          /verification failed/,
        ],
        [
          "other asset",
          signed(
            trusted.privateKey,
            `v${patch}`,
            "crewplane-v9.9.9-linux-other",
          ),
          /verification failed/,
        ],
        ["garbage", "!!!!", /verification failed/],
        ["missing", null, /no signature published/],
      ];
      for (const [label, value, expected] of cases) {
        signature = value;
        const directory = join(temporary(), "bin");
        const result = await installWith(installerWithKeys(keys), directory);
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, expected, label);
        assert.equal(existsSync(join(directory, "crewplane")), false, label);
        assert.deepEqual(readdirSync(directory), [], label);
      }
    },
  );

  it("refuses when openssl cannot verify Ed25519, unless --allow-unverified", async () => {
    const a = keypair();
    const script = installerWithKeys([{ id: "k1", publicKey: a.publicKey }]);
    // An openssl that verifies nothing, like macOS's LibreSSL.
    const bin = join(temporary(), "fakebin");
    mkdirSync(bin);
    writeFileSync(join(bin, "openssl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    const directory = join(temporary(), "bin");
    const refused = await installWith(script, directory, [], env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /no openssl here can verify Ed25519/);
    assert.match(refused.stderr, /brew install openssl/);
    assert.match(refused.stderr, /--allow-unverified/);
    assert.equal(existsSync(join(directory, "crewplane")), false);

    const allowed = await installWith(
      script,
      directory,
      ["--allow-unverified"],
      env,
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stderr, /WARNING: --allow-unverified/);
    assert.equal(readFileSync(join(directory, "crewplane"), "utf8"), payload);
  });

  it("--allow-unverified still enforces the checksum", async () => {
    const a = keypair();
    checksum = "0".repeat(64);
    const result = await installWith(
      installerWithKeys([{ id: "k1", publicKey: a.publicKey }]),
      join(temporary(), "bin"),
      ["--allow-unverified"],
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
  });
});
