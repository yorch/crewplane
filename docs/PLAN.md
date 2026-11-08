# Extraction plan and status

Foundation: complete — separate repository, MIT license, engineering rules, architecture proposal, inventory and minimal compilable CLI. No orchestration functionality has been extracted yet.

1. Freeze extraction contracts and source provenance. Define project identity, configuration, tasks/claims/messages, agent roles, lifecycle, storage and harness capability interfaces. Introduce strict TypeScript, Biome, Vitest and CI with verified dependency versions.
2. Extract existing file-store coordination and pure scheduler with regression tests. Use a Relay project profile, temporary repositories and fake harnesses. Preserve behavior before changing storage.
3. Extract runtime and adapters, including process ownership, checkpoint/correction routing, budget enforcement and stop/recovery tests. Codex/pi capability limitations remain explicit.
4. Extract dashboard, telemetry and independent watchdog through shared services. Embed assets. Retain loopback access controls and bounded private artifacts.
5. Prove standalone operation: clean fixture project, no source/dependencies/Node/Bun installation; two independent tasks, worktrees, question/answer, review/correction, linear integration, intentional stop and simulated crash recovery. Test native macOS/Linux binaries.
6. Adopt in Volunteer Relay through a separate PR; only then retire duplicate scripts. No automatic legacy-state migration or supervisor restart.
7. Follow-ups: SQLite migration, more harnesses, native usage integration and global project overview. Each requires a scoped design and acceptance tests.

Next assignment: step 1 only. Do not mix storage redesign or new UX with behavioral extraction. Maintain a runnable baseline after each step. Initial skeleton is not evidence of scheduler or harness compatibility.
