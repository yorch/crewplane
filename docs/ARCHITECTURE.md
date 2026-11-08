# Architecture proposal

Status: proposed extraction boundaries; implementation decisions below distinguish defaults from unproven capabilities.

## Defaults

- A separate MIT project with a Bun-powered CLI and embedded dashboard distributed as one executable per OS/architecture. Git, harness executables and browsers remain external capabilities.
- One project per supervisor initially. Project identity resolves through the Git common directory so linked worktrees share coordination without sharing application databases.
- Configurable agent IDs and roles: coordinator, implementer, reviewer and visual validator are policy, not fixed A–V lanes.
- Deterministic eligibility and authority checks precede priority, age and fairness. A model may propose work; it cannot bypass authorization, holds, dependencies, scope or budgets.
- Supervisor and independent watchdog are separate processes launched through the same executable. Dashboard inspection does not activate execution.
- Preserve the existing file-store behavior during extraction. SQLite is the preferred follow-up proposal for transactional state, contingent on concurrency, crash-recovery and migration tests. Artifacts remain files.
- Version configuration, persisted records, commands, events and adapter contracts. Never silently adopt or mutate legacy Relay state. Migration is explicit and reversible through export/backups.
- Configuration is data. Project commands are explicit argv arrays and execute only under declared authority; no implicit shell interpolation.

## Boundaries

CLI -> application services -> core policy and ports.
Runtime, Git workspaces, persistence, harness adapters and HTTP/dashboard implement ports. Core does not import dashboard code. Dashboard reads a shared projection and sends validated commands; it does not directly mutate state.

Harness adapters expose capability discovery, invocation, stream normalization, resume identity, termination and result validation. Report configured and observed models separately. Missing usage/cache dimensions are unknown, not zero; provider counters are not certified billing.

Private project state, worktrees and artifacts live outside embedded assets. Embedded files are immutable distribution assets. Separate executable location, selected repository root, invocation cwd and state root.

## Lifecycle invariants

One writer per agent/workspace; overlap checks across declared scopes; frozen submissions can await review while disjoint work proceeds. Corrections return to the author with exact revision identity. Review is not integration acceptance. Completion persistence, trace settlement and child cleanup precede lease release. Shutdown and crash recovery must not duplicate native sessions. Watchdog observes independently and cannot silently restart, retry, raise budgets or lift holds.

## Compatibility proof

Bun supports standalone compilation, runtime embedding and static assets: https://bun.sh/docs/compiler/executables . This establishes packaging feasibility, not compatibility of Relay's process lifecycle. Native executable tests must cover signals, process groups, leases, file durability, embedded assets, harness streams and recovery. Start with macOS/Linux; Windows is deferred pending equivalent tests.
