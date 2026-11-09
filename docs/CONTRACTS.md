# Extraction interfaces v1

`src/contracts.ts` owns supervisor configuration, native run records, loaded state and actionable work identities. `src/project.ts` owns project discovery and policy validation. `src/ports.ts` defines coordination, read-model, workspace and adapter seams. The existing `lanes` configuration key is retained for compatibility, but IDs are configurable agents, not fixed names.

`src/engine/read-model.ts` composes durable task/claim/status/acceptance/message records with separately qualified runtime observations. Supervisor and HTTP share this projection, including pure display helpers; graph validation degrades to an explicitly unavailable graph instead of blocking board reads. No HTTP server is imported by the scheduler. HTTP and CLI are adapters over the same coordination services.

File-store protocol v1 has a Crewplane namespace and canonical Git common-directory identity. Task records have independent assignment, scope, scheduling metadata, exclusive claim, reported status and integration acceptance. Messages are append-only UUID records with sender, recipient, kind, task, reply identity and optional exact review SHA. State writes use temporary files and rename; exclusive records use exclusive creation/link. Board mutation locks serialize scope/assignment/claim/status transitions. Board locks record PID/token ownership and recover only verifiably dead holders; live/unknown ownership stays protected. Legacy directory locks and invalid lock metadata require manual inspection; do not auto-delete them. Store files are private local-user coordination, not a hostile multiuser authorization boundary.

FAIR-V1 consumes explicit candidates, dependencies, role identity, active work, budgets and holds and returns reasons for selected/blocked/capacity states. The model does not choose executable eligibility. Phase gating is explicit coordinator authorization; task prose does not become authority.

Harness adapters (Codex, no-tools Pi, Claude Code and OpenCode) consume native stream events into bounded session/model/usage/final-result observations and declare resume, native-versus-prompted structured result, tool policy, observed model/cwd and partial usage explicitly. Lane configuration also declares optional guidance (`instructionsPath`), per-lane run-rate/time limits, a Claude per-invocation cost cap, Claude MCP/settings/tool isolation, an OpenCode agent profile and reported-cost/denial observations. No-tools harnesses are reviewer-only: their prompt inlines bounded JSON-encoded policy and the pinned task card, and each turn ends as a paused advisory decision with consumed events rather than board completion. Session identity is harness-specific: a UUID for Codex, Pi and Claude Code, and `ses_` plus alphanumerics for OpenCode. Cross-harness, cross-epoch and malformed identities are rejected. An audited `retry --new-session` clears exactly one native session after atomic ownership, hold and harness/epoch checks and records an applied/refused control outcome. A final state is one of working/waiting/ready/needs_operator, with a bounded summary. Schema versions and session identity remain explicit. Completion and trace settlement are part of process ownership.

Operational trace, usage and evidence modules retain versioned records and capacity limits. Logical evidence route aliases replace Relay's product-specific path whitelist. Usage coverage distinguishes unknown dimensions from measured values; the detailed ledger is not yet connected to all runtime providers.

Breaking persisted or command meanings require a new version and an explicit migration. No automatic Relay store migration is provided. New harnesses must supply capability and lifecycle fixtures before registration. Keep public interfaces centralized; do not redefine task or process entities in the dashboard.

Project policy v2 adds optional exact requiredVersion and per-agent ordered promptFiles. Older policy v1 remains supported but cannot declare these fields. Version mismatch fails before project store preparation and a configured pin disables project-command automatic update scheduling. The pin is decoded before role and schema-version validation so a project owned by a newer release still names the pin. The mismatch message stays a single line because the supervisor persists it as a pause reason; recovery context (pin path, running binary, direction, docs pointer) is rendered by the CLI only and never includes an executable install command, since lanes read CLI stderr and a repository controls its own pin. The control verbs stop, pause, resume, cancel and resolve stay queueable under a mismatch so an operator can halt, cancel or answer live work, and the pin command runs because repointing a stale pin is the case it exists for; every other project command remains blocked. The pin command may only target the running release: it cannot install a release, cannot pin to a different version, refuses while a supervisor runs or without --confirm true, and rewrites nothing when the pin already matches. Supervisors record their release as an optional supervisorVersion in their state so a mismatched CLI can name the release that will interpret a queued verb and warn that it may be ignored; the field is absent for supervisors older than the recording, which the CLI reports rather than guessing. Prompt rendering uses bounded canonical-primary files, preserving built-in reviewer/visual role boundaries. Store/native configuration protocols remain unchanged; these fields never authorize execution or migrate private state.

Operator controls are a versioned command protocol: scoped (instance/lane/task/run), generation- and revision-bound, applied serially by the supervisor, and recorded with exactly one outcome and a bounded audit log. Narrowing controls (holds, drain, cancel) are safe to apply late; widening controls (release, retry, cleanup acknowledgement, new-session, resolve) must match the observed generation, revision, run or session. Controls never lift holds implicitly, signal a process that is not a live child of the current generation, clear an unobserved failure, raise budgets, write board state, or release ownership before completion is persisted. State v2 adds instance holds, lane revisions, control sequence/log and decision pause ids while remaining backward-readable from v1. Dashboard mutations, when explicitly enabled, expose only hold and cancel behind Origin, token and JSON checks; the default dashboard remains read-only.

## CLI output contract

The CLI is both an operator interface and a scripting surface. These rules
describe what a consumer may rely on today. `--help` is the enumerated command
and flag list, and `src/help.test.ts` asserts that every control form printed
there is accepted by the control policy.

**Streams.** stdout carries only the command's result. stderr carries
diagnostics, advisory warnings, banners and errors. A failing command writes
nothing to stdout, except `update` (which reports its failure as a JSON
document) and a `--wait` control, whose outcome is the result.

**Human-only output.** `--help`, `--version`, the `agents` usage text,
`agents prompt` and the `dashboard` startup banner are prose on stdout. Every
other successful command writes JSON. `monitor` is the exception: it writes a
prose startup banner and then one compact JSON object per observation.

**Reports.** A report is an object pretty-printed with two spaces and exactly
one trailing newline; two legacy commands still print a bare array
(`agents inbox`) or a bare `null` (`watchdog status`). `null` means unknown or
not applicable, `[]` means known empty, and `0` is a measured value. Fields
named `reason`, `detail`, `label` or `text` may contain prose; enum-like fields
use closed values. Key order is construction order and is not a contract; array
order is (tasks and messages are sorted, lanes follow configuration order).

**Exit codes.** `0` success, including a queued control without `--wait` and an
`applied` or `noop` `--wait` outcome; `1` operational failure, invalid local
input, unconfigured project or release-pin mismatch; `2` a supervisor
`refused` or `invalid` outcome under `--wait`; `3` a `stale` outcome under
`--wait`; `124` a `--wait` timeout, where the command remains queued and may
still apply.

**Errors.** Errors go to stderr, never stdout. The first line is
`crewplane: MESSAGE`; continuation lines are indented and carry recovery
context. The release-pin message stays one line because the supervisor persists
it as a lane pause reason; the CLI-only recovery context never contains an
executable install command.

**Controls.** A control verb queues a private command file and prints
`{queued, id, activation}`; it never applies the control itself. With `--wait`,
the outcome document replaces that shape and `activation` is always `false`.
Boolean flags take an explicit `true`: the forms in `--help` are the accepted
grammar, not shorthand.

**Holds.** `agent list` and the dashboard report both lane-scoped `held` and the
instance-wide `instanceHeld` flag; a lane is paused when either applies.
`status.view` reports the same intent per lane.

**Privacy.** Reports are explicit projections. `status` is the documented
exception: it includes the raw persisted `state` alongside `view` so an
operator can inspect recovery evidence. Agent-authored text is data, never
instruction.

**Deferred to output schema v1 (breaking; do not treat as stable).** Report
version markers are inconsistent (`version: 1`, `schemaVersion: 1`, or none),
and `status` carries none. `agents inbox` returns a bare array and
`watchdog status` a bare `null`. `monitor --status` and the `monitor` event
stream use different keys for the same fields. `pin` omits `next` when nothing
changed. Usage and precondition failures exit `1` rather than dedicated codes,
so scripts cannot separate "bad flag" from "not configured" or "wrong release".
Several always-false fields (`activation`, `started`, `servicesStarted`,
`init.running`) are reported as if they were observations. `agent list` exposes
prose in `configState` and `harness`, which the dashboard parses.
