# Crewplane engineering and coordination

Read docs/ARCHITECTURE.md, docs/EXTRACTION.md, docs/PLAN.md and the assigned task before editing. Implement only an explicitly assigned slice. Do not start real agent harnesses or adopt a live project's coordination store during tests.

Use Bun as the application runtime and package manager. Pin and test compatibility before changing dependencies. TypeScript strict; Biome for formatting/lint and Vitest for tests when the quality toolchain is introduced. Do not add ESLint or Prettier. Runtime choice does not imply changing test frameworks.

Keep core policy independent of CLI, dashboard, storage and harness adapters. Harness capabilities and usage coverage must be explicit. No project-specific lane names, document paths, commands or phase policy in core. A stopped supervisor stays stopped. Never bypass holds, budgets, failed-run recovery or exclusive writer ownership. Persist completion before releasing process ownership.

Use temporary repositories, fake harnesses and independently authored expected results. Test both source execution and the compiled executable without access to source or dependencies. Never store secrets, raw private reasoning or sensitive provider payloads in normalized telemetry.

Each implementation task uses its own branch/worktree with bounded paths. Coordinate shared interfaces before changing consumers. No subagents unless explicitly requested or delegated by a task. Handoffs report scope, validation, compatibility and unresolved limits.

Use Conventional Commits. Keep Git history linear: rebase and fast-forward, or squash based on branch scope. Never create merge commits. Do not modify Volunteer Relay during extraction; project adoption is a separate reviewed change.
