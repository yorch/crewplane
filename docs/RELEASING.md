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

The packaging step builds with `bun run build:release`, which inlines `CREWPLANE_RELEASE_BUILD=1`; only that build self-updates, so never publish a plain `bun run build` binary and never upload a renamed or compressed file under the asset name. The tag `vX.Y.Z` must equal `v$(package.json version)`; the build job already enforces that. `install.sh` maps `uname -m` (`x86_64`/`amd64` → `x86_64`, `arm64`/`aarch64` → `arm64`) and `crewplane update` derives the same names from `process.platform`/`process.arch`. Adding a platform means publishing both the asset and its `.sha256`; without the checksum every installer refuses to install. The asset name is also the file the updater executes, so never upload a compressed or renamed file under that name.
