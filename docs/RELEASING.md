# Releasing

Releases are automated by [Release Please](https://github.com/googleapis/release-please) from Conventional Commits.

1. Push commits to `main` as usual. `feat` bumps the minor version (pre-1.0), `fix` bumps the patch, and `!` or `BREAKING CHANGE` bumps the minor until 1.0. `docs`, `test`, `chore` and `ci` do not trigger a release.
2. The Release workflow keeps one open "chore(main): release X.Y.Z" PR with the version bump and `CHANGELOG.md` entry.
3. Review it and merge with **rebase** or **squash** (never a merge commit). Merging creates tag `vX.Y.Z` and the GitHub release.
4. In the same workflow run, Linux and macOS binaries are built and verified (`bun run verify`) from the tag, then attached with `.sha256` files. `install.sh` installs them.

`--version` reads `package.json`, which Release Please updates. To force a version, add a `Release-As: x.y.z` footer to a commit. The release PR is created with `GITHUB_TOKEN`, so CI checks do not run on it; `main` is already verified, and the build job verifies again before publishing.

## Release contract for installers and self-update

`install.sh` and `crewplane update` consume the same published files. Keep both attached to a published (not draft) release so the latest-release API resolves it:

- `crewplane-vX.Y.Z-linux-x86_64`, `crewplane-vX.Y.Z-linux-arm64`, `crewplane-vX.Y.Z-macos-x86_64`, `crewplane-vX.Y.Z-macos-arm64`
- a sibling `<asset>.sha256` containing `<sha256>  <asset>` (the format `shasum -a 256` and `sha256sum` write)
- once signing is enabled, a sibling `<asset>.sig`: one or more lines, each base64 of a raw 64-byte Ed25519 signature (optionally `<key id>:` first); see Release signing

The packaging step builds with `bun run build:release`, which inlines `CREWPLANE_RELEASE_BUILD=1`; only that build self-updates, so never publish a plain `bun run build` binary and never upload a renamed or compressed file under the asset name. The tag `vX.Y.Z` must equal `v$(package.json version)`; the build job already enforces that. `install.sh` maps `uname -m` (`x86_64`/`amd64` → `x86_64`, `arm64`/`aarch64` → `arm64`) and `crewplane update` derives the same names from `process.platform`/`process.arch`. Adding a platform means publishing the asset, its `.sha256` and (when signing is enabled) its `.sig`; without them every installer refuses to install. The asset name is also the file the updater executes, so never upload a compressed or renamed file under that name.

## Release signing

The checksum is published next to the binary, so anyone who can replace release assets can replace both. Signing closes that: the updater and installer trust only keys compiled into the binary or embedded in `install.sh` from the repository, never anything fetched from the release.

**What is signed.** UTF-8 bytes `crewplane-release-v1\n<tag>\n<asset file name>\n<sha256 hex of the asset>\n`. Tag, platform file name and content are all bound, so a signature cannot be moved to another tag or platform, and an old release cannot be replayed as a new tag. Signing refuses a tag that is not `vMAJOR.MINOR.PATCH[-pre][+build]`, an asset name that is not `crewplane-<tag>-(linux|macos)-(x86_64|arm64)`, and a hash that is not 64 lowercase hex digits.

**The `.sig` file.** One or more lines, each `[<key id>:]<base64 of the raw 64-byte signature>` in canonical form (88 characters ending `==`). It is valid if ANY line verifies against ANY listed key; a line with an id prefix is tried only against that key and is skipped when the id is unknown to the verifier, malformed lines are skipped, and at most 8 lines are read. Several lines are how a release is signed by two keys at once (rotation, below).

**`release-keys.json`.**

```json
{
  "signedSince": "v0.7.0",
  "keys": [{ "id": "2026-01", "publicKey": "<base64 raw 32-byte key>" }]
}
```

- `keys` is empty today, so nothing is enforced: releases carry only the same-origin checksum and the updater reports `integrity: "sha256"`.
- `signedSince` is the first tag that must carry a valid signature, compared as numeric semver (`v0.10.0` is above `v0.9.0`). Older tags install and update on the checksum alone, with a warning (installer, stderr) or a `note` in the outcome JSON (updater), so pinned older installs keep working. With keys listed and `signedSince` absent or `null` every release must be signed (strict). It is not a minimum-version floor: it never refuses an older release, it only decides whether that release needs a signature (see the trust model).
- `install.sh` carries a copy between `# BEGIN/END RELEASE KEYS`. `bun scripts/sync-install-keys.ts` rewrites it and `--check` (run by `verify.yml` and the publish job, and asserted by a test) fails if they differ.

**Enabling it (one time).**

1. `bun scripts/gen-release-key.ts --id 2026-01` prints a private key (PKCS8, base64) and a public key entry. It writes no files.
2. Store the private key as the repository secret `RELEASE_SIGNING_KEY` (base64 PKCS8 or PEM both work).
3. Add the public entry to `keys` in `release-keys.json` and set `signedSince` to the tag of the first release that will be signed (the next release you are about to cut), so older pinned installs keep working. Run `bun scripts/sync-install-keys.ts` and commit both files.
4. From that release the publish job signs every platform asset with `scripts/sign-release.ts`, self-verifies every signature line against `release-keys.json` (a secret that does not match a listed key fails the job), and uploads the `.sig` files. With keys listed and no secret the job fails: there are no unsigned releases once signing is enabled. With `keys: []` it prints a notice and signs nothing.

The first signed release is the first binary that enforces signatures. Earlier binaries have no key and keep updating on the checksum alone; they start enforcing once they update to a release that carries the key. Check that release with `bun scripts/sign-release.ts --verify --tag vX.Y.Z <assets>` before announcing it.

**Rotation (dual signing).** A binary only trusts the keys it was built with, and a `.sig` can carry several signatures. So rotation is an overlap, not a switch:

1. Generate the new key. Add it to `keys` alongside the old one and commit. Binaries built from here know both.
2. Store the new key as `RELEASE_SIGNING_KEY` and move the old one to `RELEASE_SIGNING_KEY_PREVIOUS`. The publish job then writes two lines per asset (new, then old) and verifies each against the listed keys; an unlisted key fails the job. Every release in the overlap is accepted by binaries that know only the old key (they find the old line), only the new key, or both.
3. Keep dual signing for a long overlap: until essentially every machine you care about has updated to a binary that lists the new key. Auto-updating machines move on their first successful update; machines pinned by `CREWPLANE_NO_AUTO_UPDATE` or an installed pin move only when someone updates them.
4. Remove the old key from `release-keys.json`, drop `RELEASE_SIGNING_KEY_PREVIOUS`, and sign with the new key alone.

If the overlap is too short, a binary that knows only the old key sees releases signed only by the new key, refuses them as "signature invalid", and is stranded: it can no longer self-update and must be reinstalled with `install.sh` (which carries the current key block) after verifying the install script's origin. That is the cost of retiring a key early, so err long.

**Compromise.** If the private key leaks, treat every release signed since as suspect. Remove the key from `release-keys.json`, publish a release signed with a fresh key, and tell operators to reinstall with `install.sh` and to verify the checksum out of band. Machines that still list the compromised key accept anything signed by it until they update, and a release signed only by the new key looks invalid to them (the stranded case above), so rotation cannot repair them remotely. If a release asset was replaced, delete that release and cut a new version; a tag is never reused.

**Immutable assets.** `gh release upload` no longer uses `--clobber`, so the workflow itself never overwrites a published asset: a re-run of a partially failed publish job fails on files that already exist. This only constrains the workflow. Anyone with `contents: write` can still delete an asset and upload another, so also enable GitHub's immutable releases setting for the repository, which blocks changing assets and tags after publication. To recover from a partial publish, delete the incomplete release assets by hand and re-run, or cut a new patch release. Never overwrite a published asset, because machines may already have trusted its hash.

**The build and signing jobs.** Release binaries are built in a separate job from a fresh checkout of the tag with `bun install --frozen-lockfile --ignore-scripts`, which runs no tests, no browser install and no dependency lifecycle scripts, so the bytes that get signed were not produced in the workspace that ran the test suite. The signing step runs only in the publish job, which holds the secret and runs this repository's `scripts/sign-release.ts` at the tag.

**Trust model.**

- Protected: an attacker who can modify or replace release assets (or the release page) cannot get a binary accepted by a signing-enabled installer or updater without a listed key, and cannot move a signature across tags or platforms.
- Not protected, rollback and freeze: nothing signed says which release is the newest. An attacker with release write access can mark an older, validly signed release as latest (rollback to a known-vulnerable build) or keep serving an old one (freeze); signatures have no expiry. `signedSince` is not a defense: it decides which releases need a signature, not which are acceptable. The real fix is signed release metadata (a signed "latest" with a monotonic version and expiry); that is a future design and is not implemented.
- Not protected, compromise of the signing key, of the repository (whoever can change `release-keys.json`, `signedSince` or `install.sh` on `main` controls what future builds and `curl | sh` trust, and can move `signedSince` up to exempt a release), of the workflow or its secrets, or of the build job's toolchain and dependencies (frozen lockfile, but not audited).
- Not protected, the first install: `curl | sh` is only as trustworthy as the channel serving `install.sh`. With no keys configured, below `signedSince`, or with `--allow-unverified`, only the same-origin checksum applies.
- The installer's known-answer test trusts the `openssl` on `PATH`. A hostile openssl can fool it, but control of `PATH` is already code execution.
- Binaries are not notarized.

Local checks: `bun scripts/sign-release.ts --verify --tag vX.Y.Z crewplane-vX.Y.Z-linux-x86_64` (needs the `.sig` beside the file).
