# Extraction plan and status

Steps 1–5 are implemented. See [status and verification](STATUS.md) and [operating guide](USAGE.md). This is a standalone extraction baseline with synthetic acceptance, not certification of live harnesses/providers or production operation.

| Step | Task  | Status      | Delivered                                                                                                                                                                           |
| ---- | ----- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | CP-01 | Complete    | Shared project/run/board/adapter contracts, strict TypeScript, verified toolchain pins, Biome/Vitest and native macOS/Linux CI                                                      |
| 2    | CP-02 | Complete    | File-store coordination, configurable roles/task paths/IDs, scope/dependency scheduling, claims, messages and frozen submissions                                                    |
| 3    | CP-03 | Complete    | Supervisor, Codex/restricted pi adapters, worktrees, per-task sessions, controls, completion ownership and crash recovery                                                           |
| 4    | CP-04 | Complete    | Embedded dashboard through a shared read model, monitor/watchdog, sanitized traces and bounded evidence storage/API                                                                 |
| 5    | CP-05 | Complete    | Standalone binary acceptance on macOS ARM64 and Linux ARM64, 254 source/browser tests, desktop/mobile visual checks; hosted Ubuntu/macOS gates and binary/checksum artifacts passed |
| 6    | —     | Not started | Adopt Crewplane in Volunteer Relay through a separate explicitly authorized change; only then retire duplicate scripts                                                              |
| 7    | —     | Deferred    | SQLite migration, additional harnesses, native cache/provider usage integration, global project overview and distribution signing                                                   |

All work uses one isolated extraction branch/worktree and explicit operator scope. No subagents, live models, application databases, legacy board adoption or production supervisor activation were required. Integration uses Conventional Commits and fast-forward only; the operator requested direct main publication.
