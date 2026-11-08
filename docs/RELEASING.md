# Releasing

Releases are automated by [Release Please](https://github.com/googleapis/release-please) from Conventional Commits.

1. Push commits to `main` as usual. `feat` bumps the minor version (pre-1.0), `fix` bumps the patch, and `!` or `BREAKING CHANGE` bumps the minor until 1.0. `docs`, `test`, `chore` and `ci` do not trigger a release.
2. The Release workflow keeps one open "chore(main): release X.Y.Z" PR with the version bump and `CHANGELOG.md` entry.
3. Review it and merge with **rebase** or **squash** (never a merge commit). Merging creates tag `vX.Y.Z` and the GitHub release.
4. In the same workflow run, Linux and macOS binaries are built and verified (`bun run verify`) from the tag, then attached with `.sha256` files. `install.sh` installs them.

`--version` reads `package.json`, which Release Please updates. To force a version, add a `Release-As: x.y.z` footer to a commit. The release PR is created with `GITHUB_TOKEN`, so CI checks do not run on it; `main` is already verified, and the build job verifies again before publishing.
