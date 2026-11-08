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

Codex and restrictive no-tools pi adapters are extracted and covered with synthetic native events. Real harness/provider acceptance is separate; Claude/OpenCode, Windows, signing and automatic updates are not delivered. Detailed cache/provider usage integration and SQLite migration remain follow-ups.

See [architecture](docs/ARCHITECTURE.md), [contracts](docs/CONTRACTS.md), [extraction provenance](docs/PROVENANCE.md), and [plan](docs/PLAN.md). See [operating guide](docs/USAGE.md) for configuration and workflow examples, and [validation status](docs/STATUS.md) for evidence and limits.

Native Linux and macOS executables with SHA-256 checksums are uploaded as artifacts of successful [Verify runs](https://github.com/yorch/crewplane/actions). Signed releases and installers are deferred.
