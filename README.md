# Crewplane

Local orchestration for coding agents across harnesses: tasks, isolated worktrees, messages, review, supervision and a dashboard in one executable.

Crewplane extracts the audited Volunteer Relay orchestration tooling into a separate MIT project. It uses configurable agent roles, task IDs and document paths. Git and agent harness executables remain external; the compiled application includes its Bun runtime and dashboard assets.

## Build and verify

Use Bun 1.4.1. Development verification also uses Node 26.11.1 for Vitest, and Playwright Chromium for browser checks. Running the resulting executable requires neither Node nor Bun installed.

```sh
bun install --frozen-lockfile
node node_modules/@playwright/test/cli.js install chromium
bun run verify
./dist/crewplane --help
```

`bun run build` produces a local binary that does not self-update. Published assets are built with `bun run build:release`, which also inlines the release marker; only those binaries update themselves.

## Use in a project

```sh
crewplane --project /path/to/repo init
crewplane configure --file /private/path/runtime.json
crewplane doctor
crewplane task list
crewplane start
```

Configure committed task cards and explicitly approved assignments before execution. `start` runs in the foreground. Start observation independently:

```sh
crewplane dashboard --port 4310
crewplane monitor
crewplane watchdog start
```

`crewplane stop` requests intentional drain; `status` reports persistence and process observations. Inspection does not launch agents. No automatic integration, controller replacement, budget increase or legacy-state adoption occurs.

Codex, restrictive no-tools pi, Claude Code and OpenCode adapters are covered with synthetic native events and lifecycle fixtures. Claude/OpenCode compatibility is limited to the locally probed CLI protocols; real provider acceptance, Windows and signing remain separate. Detailed cache/provider usage integration and SQLite migration remain follow-ups.

See [architecture](docs/ARCHITECTURE.md), [contracts](docs/CONTRACTS.md), [extraction provenance](docs/PROVENANCE.md), and [plan](docs/PLAN.md). See [operating guide](docs/USAGE.md) for configuration and workflow examples, and [validation status](docs/STATUS.md) for evidence and limits.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh
```

This downloads the latest [release](https://github.com/yorch/crewplane/releases) binary for Linux or macOS, verifies its published SHA-256 checksum, then renames it into place at `~/.local/bin`. Use `--dry-run` to preview, `--dir DIR` (or `CREWPLANE_INSTALL_DIR`) to install elsewhere, and `--version v0.2.0` (or `CREWPLANE_VERSION`) to pin. The installer never uses sudo and leaves an existing binary untouched when verification fails. Binaries are published by the Release workflow when the Release Please PR is merged (see [releasing](docs/RELEASING.md)).

Release-marked binaries keep themselves current. A project command checks for a newer release at most once a day, and a detached updater replaces the executable only after the published checksum, executable header and staged binary version match; the new version applies to the next invocation. Long-running commands (`start`, `dashboard`, `watchdog`, `monitor`) and any registered live supervisor are never updated in place; the updater also re-checks immediately before the rename. Apply or inspect immediately with `crewplane update`, `crewplane update --check` or `crewplane update --force`; disable automatic updates with `CREWPLANE_NO_AUTO_UPDATE=1` or `CREWPLANE_UPDATE=off`. See the [operating guide](docs/USAGE.md) for every update setting. Releases are not signed or notarized yet, Windows remains unsupported, and `install.sh --version TAG` pins only until the next automatic check unless automatic updates are disabled.
