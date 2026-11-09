import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
const script = (version: string) =>
  `#!/bin/sh\n[ "\${1:-}" = "--version" ] && printf '%s\\n' ${version}\nexit 0\n`;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const installer = resolve("install.sh");

type Release = {
  tag: string;
  payload: string;
  checksum: string | null;
  checksumName: string;
  checksumEol: string;
  apiStatus: number;
  missingAsset: boolean;
};

let release: Release;
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  const binary = `/download/v${patch}/${asset}`;
  if (url === "/latest") {
    response.writeHead(release.apiStatus, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ tag_name: `v${release.tag}` }));
    return;
  }
  if (url === binary && !release.missingAsset) {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(release.payload);
    return;
  }
  if (url === `${binary}.sha256` && release.checksum !== null) {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(
      `${release.checksum}  ${release.checksumName}${release.checksumEol}`,
    );
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
beforeEach(() => {
  release = {
    tag: patch,
    payload: script(patch),
    checksum: sha256(script(patch)),
    checksumName: asset,
    checksumEol: "\n",
    apiStatus: 200,
    missingAsset: false,
  };
});

const install = async (
  directory: string,
  args: string[] = [],
  env: Record<string, string> = {},
) => {
  try {
    const result = await run("sh", [installer, ...args], {
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
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};
const temporary = () => mkdtempSync(join(tmpdir(), "crewplane-install-"));

describe("install.sh", () => {
  it("installs a verified binary and reports reinstallation", async () => {
    const directory = join(temporary(), "bin");
    const first = await install(directory);
    assert.equal(first.status, 0, first.stderr);
    const target = join(directory, "crewplane");
    assert.equal(readFileSync(target, "utf8"), script(patch));
    assert.notEqual(statSync(target).mode & 0o111, 0);
    assert.match(first.stdout, /Installed crewplane 9\.9\.9/);
    assert.match(first.stderr, /install: downloading crewplane v9\.9\.9/);
    assert.match(
      first.stderr,
      /install: downloaded \d+(\.\d+)? (B|KB|MB) in \d+s/,
    );
    assert.match(first.stderr, /install: verifying the checksum/);
    assert.match(first.stderr, /install: checking the downloaded binary/);
    assert.match(first.stderr, /install: installing to /);
    assert.doesNotMatch(first.stdout, /install: downloading/);

    const again = await install(directory);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Reinstalled crewplane 9\.9\.9/);
  });

  it("reports the upgrade from the previously installed version", async () => {
    const directory = join(temporary(), "bin");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "crewplane"), script("0.1.0"), {
      mode: 0o755,
    });
    const result = await install(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated crewplane 0\.1\.0 -> 9\.9\.9/);
  });

  it("accepts a pinned version without the leading v", async () => {
    const directory = join(temporary(), "bin");
    const pinned = await install(directory, ["--version", patch]);
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.match(pinned.stdout, /Installed crewplane 9\.9\.9/);
    const fromEnvironment = await install(directory, [], {
      CREWPLANE_VERSION: `v${patch}`,
    });
    assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
    assert.match(fromEnvironment.stdout, /Reinstalled crewplane 9\.9\.9/);
  });

  it("refuses a checksum mismatch and leaves the existing binary intact", async () => {
    release.checksum = "0".repeat(64);
    const directory = join(temporary(), "bin");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "crewplane"), script("0.1.0"), {
      mode: 0o755,
    });
    const result = await install(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
    assert.match(readFileSync(join(directory, "crewplane"), "utf8"), /0\.1\.0/);
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.includes(".tmp")),
      [],
    );
  });

  it("refuses a binary whose reported version differs from the tag", async () => {
    release.payload = script("0.0.0");
    release.checksum = sha256(release.payload);
    const directory = join(temporary(), "bin");
    const result = await install(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reports 0\.0\.0 but v9\.9\.9 was requested/);
    assert(!existsSync(join(directory, "crewplane")));
  });

  it("fails clearly when the platform asset is not published", async () => {
    release.missingAsset = true;
    const result = await install(join(temporary(), "bin"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no published binary for/);
    assert.match(result.stderr, /attempt 1\/3\), retrying/);
    assert.match(result.stderr, /attempt 3\/3\)/);
  });

  it("fails clearly when the release lookup fails", async () => {
    release.apiStatus = 500;
    const result = await install(join(temporary(), "bin"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not reach/);
  });

  it("rejects an unwritable install directory without sudo", async () => {
    if (process.getuid?.() === 0) return;
    const directory = join(temporary(), "bin");
    mkdirSync(directory, { recursive: true, mode: 0o500 });
    const result = await install(directory, ["--dir", directory]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not writable/);
  });

  it("prints the plan without writing on --dry-run", async () => {
    const directory = join(temporary(), "bin");
    const result = await install(directory, ["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would install crewplane v9\.9\.9/);
    assert(!existsSync(directory));
  });

  it("accepts --version=, --dir= and --prefix= forms without hanging", async () => {
    const equalsTarget = join(temporary(), "target-equals");
    const versioned = await install(equalsTarget, [`--version=${patch}`]);
    assert.equal(versioned.status, 0, versioned.stderr);
    assert(existsSync(join(equalsTarget, "crewplane")));

    const dirTarget = join(temporary(), "target-dir");
    const dirFlag = await install(join(temporary(), "unused"), [
      `--dir=${dirTarget}`,
    ]);
    assert.equal(dirFlag.status, 0, dirFlag.stderr);
    assert(existsSync(join(dirTarget, "crewplane")));

    const prefixTarget = join(temporary(), "target-prefix");
    const prefix = await install(join(temporary(), "unused"), [
      `--prefix=${prefixTarget}`,
    ]);
    assert.equal(prefix.status, 0, prefix.stderr);
    assert(existsSync(join(prefixTarget, "crewplane")));
  });

  it("installs into a directory containing spaces", async () => {
    const directory = join(temporary(), "bin dir");
    const result = await install(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed crewplane 9\.9\.9/);
    assert(existsSync(join(directory, "crewplane")));
  });

  it("ignores CRLF checksum files", async () => {
    release.checksumEol = "\r\n";
    const result = await install(join(temporary(), "bin"));
    assert.equal(result.status, 0, result.stderr);
  });

  it("refuses a checksum file naming another asset", async () => {
    release.checksumName = "crewplane-v9.9.9-other-platform";
    const result = await install(join(temporary(), "bin"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unreadable checksum/);
  });

  it("documents usage and rejects invalid arguments", async () => {
    const help = await install(join(temporary(), "bin"), ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: install\.sh/);
    const unknown = await install(join(temporary(), "bin"), ["--bogus"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown option/);
    const invalid = await install(join(temporary(), "bin"), [
      "--version",
      "latest-ish",
    ]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid version/);
  });

  it("rejects a missing checksum publication", async () => {
    release.checksum = null;
    const result = await install(join(temporary(), "bin"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no checksum published/);
  });

  it("leaves no staged file behind when the checksum is missing", async () => {
    release.checksum = null;
    const directory = join(temporary(), "bin");
    const result = await install(directory);
    assert.notEqual(result.status, 0);
    assert(existsSync(directory));
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.includes("tmp")),
      [],
    );
    assert(!existsSync(join(directory, "crewplane")));
    rmSync(directory, { recursive: true, force: true });
  });
});
