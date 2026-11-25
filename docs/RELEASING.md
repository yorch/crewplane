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
- once signing is enabled, a sibling `<asset>.sig`: one line, base64 of the raw 64-byte Ed25519 signature (optionally `<key id>:` first)

The packaging step builds with `bun run build:release`, which inlines `CREWPLANE_RELEASE_BUILD=1`; only that build self-updates, so never publish a plain `bun run build` binary and never upload a renamed or compressed file under the asset name. The tag `vX.Y.Z` must equal `v$(package.json version)`; the build job already enforces that. `install.sh` maps `uname -m` (`x86_64`/`amd64` → `x86_64`, `arm64`/`aarch64` → `arm64`) and `crewplane update` derives the same names from `process.platform`/`process.arch`. Adding a platform means publishing the asset, its `.sha256` and (when signing is enabled) its `.sig`; without them every installer refuses to install. The asset name is also the file the updater executes, so never upload a compressed or renamed file under that name.

## Release signing

The checksum is published next to the binary, so anyone who can replace release assets can replace both. Signing closes that: the updater and installer trust only keys compiled or embedded from the repository, never anything fetched from the release.

**What is signed.** UTF-8 bytes `crewplane-release-v1\n<tag>\n<asset file name>\n<sha256 hex of the asset>\n`. Tag, platform file name and content are all bound, so a signature cannot be moved to another tag or platform, and an old release cannot be replayed as a new tag.

**Enabling it (one time).**

1. `bun scripts/gen-release-key.ts --id 2026-01` prints a private key (PKCS8, base64) and a public key entry. It writes no files.
2. Store the private key as the repository secret `RELEASE_SIGNING_KEY` (base64 PKCS8 or PEM both work). Keep no other copy outside your secret manager.
3. Add the public entry to `keys` in `release-keys.json`, run `bun scripts/sync-install-keys.ts` to refresh the block in `install.sh`, and commit both. A test and CI (`verify.yml` and the publish job) fail if they disagree.
4. From the next release, the publish job signs every platform asset with `scripts/sign-release.ts`, self-verifies each signature against `release-keys.json` (so a secret that does not match the listed key fails the job), and uploads `.sig` files. With keys listed and no secret, the job fails: no unsigned releases once signing is enabled. With `keys: []` it prints a notice and signs nothing.

The first signed release is the first binary that enforces signatures. Earlier binaries have no key and keep updating on the checksum alone; they start enforcing once they update to a release that carries the key. Check that release with `bun scripts/sign-release.ts --verify --tag vX.Y.Z <assets>` before announcing.

**Rotation.** A signature is valid if any listed key verifies it (a `<id>:` prefix pins one key). To rotate: (1) generate a new key and add it to `release-keys.json` alongside the old one; (2) ship a release that is still signed with the old key, so existing binaries accept it and learn the new key; (3) switch `RELEASE_SIGNING_KEY` to the new key; (4) once users have moved past that release, remove the old key. A binary only trusts the keys it was built with, so do not remove a key before the release that adds its replacement has been adopted.

**Compromise.** If the private key leaks, treat every release signed since as suspect. Remove the key from `release-keys.json` and publish a release signed with a fresh key. Machines that have the compromised key built in will accept a release signed by it until they update, and cannot learn the replacement from a release signed only by the new key, so tell operators to reinstall with `install.sh` (which fetches the current key block from the repository) and verify the checksum out of band. If a release asset was replaced, delete the release and cut a new version: published assets are immutable and a tag is never reused.

**Immutable assets.** `gh release upload` no longer uses `--clobber`, so a re-run of the publish job after a partial upload fails on the files that already exist instead of overwriting them. To recover, delete the incomplete GitHub release assets by hand and re-run, or cut a new patch release; never overwrite a published asset, because installed machines may already have trusted its hash.

**Trust model.** Protected: an attacker who can modify or replace release assets (or the release page) cannot get a binary accepted without the signing key, and cannot swap assets across tags or platforms. Not protected: compromise of the signing key, the repository (an attacker who can change `release-keys.json` or `install.sh` on `main` controls what future builds and `curl | sh` trust), or the build itself (the job that builds and signs); the first install via `curl | sh` is only as trustworthy as the channel serving `install.sh`; with no keys configured, or `--allow-unverified`, only the same-origin checksum applies. Binaries are not notarized.

Local checks: `bun scripts/sign-release.ts --verify --tag vX.Y.Z crewplane-vX.Y.Z-linux-x86_64` (needs the `.sig` beside the file).
