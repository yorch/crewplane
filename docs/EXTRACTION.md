# Volunteer Relay extraction inventory

Source repository: /Users/yorch/code/volunteer-relay. Record an exact source commit in each extraction handoff. Preserve MIT license and provenance. Do not copy ignored coordination state, secrets, traces, screenshots or application data.

| Source family | Destination boundary | Required change |
| --- | --- | --- |
| scripts/agents.mjs | coordination services and CLI | Remove fixed lanes, Markdown paths and script subprocess assumptions |
| scripts/supervisor.ts | runtime | Replace Volunteer Relay prompts, fixed roles, Node checks and source-path invocation |
| scripts/fair-scheduler.ts, scheduling.ts, orchestration.ts, wait-policy.ts | core policy | Preserve regression oracles; configure roles and constraints |
| scripts/harness.ts | harness adapters | Preserve tested Codex/pi behavior and expose restrictions; no unsupported parity claims |
| scripts/watch.ts, config-reload.ts, control-policy.ts | lifecycle and configuration | Define versioned state and ownership contracts |
| scripts/watchdog/** | independent health observer | Retain explicit intent, bounded alerts and signal coverage |
| scripts/dashboard.ts, dashboard/** | HTTP and embedded dashboard | Separate shared read model; embed explicit assets; eliminate CLI subprocess reads |
| operational-traces, evidence and usage modules | telemetry/artifact ports | Preserve privacy, retention, provenance and unknown coverage |
| docs/agents/** | project templates | Move ownership/phase rules into a Relay profile; preserve user instructions |
| orchestration test suites | regression harness | Remove hardcoded paths and run compiled-binary scenarios |

Blocking coupling: process.execPath currently launches script files; compiled execution must use internal services or self-subcommands. import.meta.url asset paths and Node version guards require explicit adaptation. The supervisor currently imports dashboard snapshot logic; extract a shared projection before adding UI features.

Keep application code, PostgreSQL/Drizzle/Better Auth, product fixtures, deployment infrastructure and domain contracts in Volunteer Relay. Git history integration policy is configurable but linear-history defaults remain.
