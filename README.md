# Crewplane

Local orchestration for coding agents across harnesses: tasks, isolated worktrees, messages, review, supervision and a dashboard in one executable.

Status: architecture and extraction foundation. The executable currently provides help and version only. No agent processes or services are launched.

## Development

Use Bun 1.4.1 for the initial reproducible build. No dependencies are required for this bootstrap.

```sh
bun run dev --help
bun run build
./dist/crewplane --version
```

The compiled executable embeds its runtime; Bun is needed to build, not to run it. Future agent execution will require Git and the configured external harnesses. Initial supported targets are macOS and Linux; platform support requires native lifecycle tests.

See [architecture](docs/ARCHITECTURE.md), [extraction inventory](docs/EXTRACTION.md), and [implementation plan](docs/PLAN.md).

MIT licensed. Extracted source will retain provenance from Volunteer Relay.
