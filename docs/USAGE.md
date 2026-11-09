# Running Crewplane

Build with Bun 1.4.1 (`bun run build`), then place `dist/crewplane` on PATH or invoke it by absolute path. Bun and Node are not needed to run that executable. Git and the configured harness executables remain external. Initial platforms are macOS and Linux; Windows is not accepted.

## Install and update the CLI

The installer resolves a GitHub release, downloads the asset for the host platform, and verifies it before replacing anything:

```sh
curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh -s -- --version v0.2.0 --dir "$HOME/bin"
```

| Option          | Environment              | Meaning                                                         |
| --------------- | ------------------------ | --------------------------------------------------------------- |
| `--version TAG` | `CREWPLANE_VERSION`      | Exact release, e.g. `v0.2.0`; default is the latest tag         |
| `--dir DIR`     | `CREWPLANE_INSTALL_DIR`  | Install directory; default `~/.local/bin` (aliases `--prefix`)  |
| `--dry-run`     | —                        | Print the resolved asset, source and target without downloading |
| —               | `CREWPLANE_RELEASE_API`  | Latest-release JSON, default the GitHub API                     |
| —               | `CREWPLANE_RELEASE_BASE` | Release download base URL                                       |

Progress goes to stderr: one step line per phase (`resolving`, `downloading`, `downloaded 60.0 MB in 10s`, `verifying the checksum`, `checking the downloaded binary`, `installing to`), plus curl's progress bar when stderr is a terminal. Stdout keeps only the final result and PATH advice.

Custom release sources must use `https`, except loopback test servers (`127.0.0.1`, `localhost`, `::1`). The installer stages the download inside the target directory, verifies the published checksum, runs the staged file with `--version`, requires that version to match the tag, and only then renames it into place. It never invokes `sudo`, never skips verification, and leaves an existing installation untouched when any check fails. A symlinked target is replaced by a real file after a warning. Linux assets are built against glibc; musl/Alpine is not verified. Windows is unsupported.

A pinned install is not sticky: see below for how to stay on a version.

### Automatic updates

Release-marked binaries update themselves. A local `bun run build` binary is not release-marked and reports `unsupported`; `bun run build:release` is the marker `install.sh` installs. At most once every 24 hours an eligible project command starts a detached check; when a newer release is published and verifies, the updater replaces the running executable and the new version takes effect on the next invocation.

The check never delays or fails the foreground command, and no project state, hold, budget, lease or queued control is read or written. Automatic replacement is skipped when:

- the command is `start`, `dashboard`, `watchdog` or `monitor`;
- any supervisor reports running through its per-user registration (files under `$CREWPLANE_CACHE_DIR/crewplane/supervisors`, keyed by PID);
- a recent check is recorded for the same executable;
- automatic updates are disabled.

Registration is best effort and PID-based, so a reused PID can postpone an automatic update but never force one. The updater re-checks immediately before the rename; a supervisor that starts during the download cancels the replacement. A supervisor that is already running keeps the binary it started with, but its later CLI child invocations use the updated file.

### Explicit updates

```sh
crewplane update           # apply now; prints a JSON outcome
crewplane update --check   # report without downloading or replacing
crewplane update --force   # replace even while a supervisor is running
```

The outcome is one of `current`, `available`, `updated`, `unsupported` (source run, foreign platform, or disabled) or `failed`. Failures still print a JSON outcome and exit non-zero with the reason on stderr. `update` refuses while any supervisor is registered unless `--force` is given; explicit updates keep the caller's environment, including `GITHUB_TOKEN`. Automatic checks run with a filtered environment and never inherit credentials. Updates verify the published SHA-256, the platform executable header, and the staged binary's reported version, then rename a verified copy inside the install directory; running processes keep the binary they started with. Downgrades are not automatic: install a pin with `install.sh --version TAG` and set `CREWPLANE_NO_AUTO_UPDATE=1` to keep it.

| Environment                            | Meaning                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CREWPLANE_NO_AUTO_UPDATE=1`           | Disable automatic checks and swaps                                                                                             |
| `CREWPLANE_UPDATE=off`                 | Same opt-out, by mode                                                                                                          |
| `CREWPLANE_UPDATE_INTERVAL_HOURS`      | Minimum hours between automatic checks (default 24)                                                                            |
| `CREWPLANE_CACHE_DIR`                  | Directory for `crewplane/update.json`, its lock and supervisor registrations (default `$XDG_CACHE_HOME` or `~/Library/Caches`) |
| `CREWPLANE_UPDATE_TIMEOUT_MS`          | Timeout for release metadata requests (default 20000)                                                                          |
| `CREWPLANE_UPDATE_DOWNLOAD_TIMEOUT_MS` | Timeout for the asset download (default 300000)                                                                                |
| `CREWPLANE_UPDATE_MAX_BYTES`           | Streamed asset download limit (default 256 MiB; metadata is capped at 1 MiB)                                                   |
| `CREWPLANE_RELEASE_BUILD=1`            | Treat this binary as a release build (used by acceptance tests)                                                                |
| `GITHUB_TOKEN` / `GH_TOKEN`            | Optional; sent only to `https://api.github.com` for explicit release lookups                                                   |

The update cache records `target`, `lastAttemptAt`, `latest`, `updatedAt` and the last `error`. Release metadata and checksums are unsigned: verification proves transport integrity and the published release contents, not publisher identity. Code signing and notarization are deferred, so this assumes the GitHub release account and storage are not compromised.

## Initialize a project

Run `crewplane --project /path/to/repo init` in a non-bare Git project. This creates a `crewplane.json` policy if absent, a task directory and private shared file store. It adds private runtime directories to Git's local exclude file. Existing instructions and configuration are preserved. Commit policy and task cards; never commit runtime state.

Linked worktrees discover the same primary project and store through Git. `CREWPLANE_COORD_DIR` optionally selects an absolute shared private store. Repository identity and the Crewplane namespace are checked before use; Relay state is never implicitly adopted.

```json
{
  "version": 1,
  "coordinator": "captain",
  "reviewers": ["inspector", "visual"],
  "reviewerRoles": { "inspector": "code", "visual": "visual" },
  "tasksPath": "tasks",
  "planPath": "PLAN.md",
  "statusPath": "STATUS.md",
  "instructionsPath": "AGENTS.md",
  "roadmapFormat": "none"
}
```

Agent IDs are safe identifiers, not fixed letters; prototype-property names are rejected. Reviewer type is explicitly configured in reviewerRoles, never inferred from array position. Task IDs accept letters/numbers plus hyphens/underscores, maximum 96 characters. Every assignment requires an approved committed task card and base SHA. A card starts with a title and `Owner: builder.` (or `Owner lane: builder.`); add goal, allowed paths, dependencies and verification requirements. Optional `Phase:` is a display grouping; the coordinator must explicitly authorize phase gates. Reading a plan never grants execution authority.

`examples/relay/crewplane.json` is an optional mapping for Relay documents and agent IDs. Copying this profile does not migrate state, authorize adoption, or start services.

## Configure explicit execution

Create a private JSON file with this shape; replace the executable and stopped-confirmation timestamp with values you have actually verified:

```json
{
  "version": 1,
  "binary": "/absolute/path/to/codex",
  "allowedTasks": ["CP-101", "CP-102"],
  "maxParallel": 4,
  "intervalSeconds": 10,
  "maxRunMinutes": 25,
  "maxRunsPerHour": 20,
  "confirmedStoppedAt": "2026-11-08T00:00:00Z",
  "lanes": {
    "captain": { "enabled": true, "harness": "codex" },
    "builder": { "enabled": true, "harness": "codex" },
    "inspector": { "enabled": true, "harness": "codex" },
    "visual": { "enabled": false, "harness": "codex" }
  }
}
```

```sh
crewplane configure --file /private/path/runtime.json
crewplane doctor
```

`configure` installs a private configuration, overriding its root and roles from the selected project; it does not launch anything. Reconfiguration requires stopped state. Configured models are optional and remain distinct from observed models. Existing harness credentials and permissions apply; Crewplane does not log in or act as an OS sandbox. `doctor` validates configuration and binary presence; it does not certify credentials, provider operation or harness-version compatibility.

The retained Codex adapter uses the extracted native exec/schema/resume protocol. Pi is explicitly restricted to `no-tools`, requires a fresh `sessionEpoch`, separate provider/model fields and a configured absolute `binaries.pi` path. Because a no-tools turn cannot read files, run the board CLI or inspect a SHA, Pi lanes are accepted only for configured reviewers: their prompt inlines bounded JSON-encoded global/lane instructions and the task card pinned at the assignment base commit, and the turn ends as a paused advisory decision whose summary is surfaced for operator relay. Pi is neither an implementer nor a code reviewer under this policy.

Claude Code (probed with CLI 2.1.319) requires an explicit `model`, a non-bypass `claudePermissionMode` (`acceptEdits`, `auto`, `dontAsk` or `plan`), `claudeMcp` (`strict` or `inherit`) and `claudeSettingSources` (for example `["project"]`). `strict` adds `--strict-mcp-config`; the sources select `--setting-sources`. Optional `claudeTools` is the availability allowlist (`--tools`, must include `Bash` for board operations), `claudeAllowedTools`/`claudeDisallowedTools` pass approval and denial rules, and `maxCostUsdPerRun` passes `--max-budget-usd`. It receives the result schema as inline `--json-schema`, binds a generated UUID with `--session-id` on a fresh run and resumes with `--resume`; bypass and manual permission modes remain unavailable. OpenCode (probed with CLI 2.2.5) requires an explicit `model` in `provider/model` or `provider/model#variant` form and runs `opencode run --standalone --format json`. Its JSON stream has no schema-enforced result, so the agent receives the JSON-only instruction; the server-generated `ses_...` session is captured and resumed with `--session`. Because that flag also creates a missing session, OpenCode resume is best-effort identity continuity, not proof the prior context survived. `opencodeAuto: true` is the only auto-approval opt-in and is off by default.

Both new adapters require an explicit absolute `binaries.claude` or `binaries.opencode` entry; only Codex falls back to the legacy `binary` path. A mixed configuration can look like this fragment inside the full shape above:

```json
{
  "binary": "/absolute/path/to/codex",
  "binaries": {
    "claude": "/absolute/path/to/claude",
    "opencode": "/absolute/path/to/opencode"
  },
  "lanes": {
    "captain": {
      "enabled": true,
      "harness": "claude",
      "model": "opus",
      "claudePermissionMode": "plan",
      "claudeMcp": "strict",
      "claudeSettingSources": ["project"],
      "instructionsPath": "docs/captain.md"
    },
    "builder": {
      "enabled": true,
      "harness": "claude",
      "model": "claude-opus-5-5",
      "claudePermissionMode": "acceptEdits",
      "claudeMcp": "strict",
      "claudeSettingSources": ["project"],
      "claudeTools": ["Bash", "Read", "Edit", "Write"],
      "maxRunsPerHour": 10,
      "maxRunMinutes": 20,
      "maxCostUsdPerRun": 2
    },
    "inspector": {
      "enabled": true,
      "harness": "opencode",
      "model": "opencode-go/claude-haiku-5-5",
      "opencodeAuto": true,
      "opencodeAgent": "review"
    }
  }
}
```

Harness settings never cross harnesses: Pi, Claude and OpenCode fields on the wrong harness are rejected. Reported input/output counters are harness-reported fields only: Claude excludes cache creation/read tokens from `input_tokens`, OpenCode reports cache and reasoning separately, and neither is a billing total. Live native harness compatibility is limited to the probed CLI protocols above and must be rechecked before real activation; acceptance uses synthetic events and lifecycle fixtures, not live provider calls.

### Lane guidance and isolation

- Global policy is `crewplane.json` → `instructionsPath` (default `AGENTS.md`); a missing global file is reported by `doctor` and at prompt time, not treated as a hard failure.
- `lanes.<id>.instructionsPath` adds per-lane guidance. It must be a safe relative path to an existing regular file under the primary project root, at most 32 KiB, and cannot use `.git`, `.crewplane-state` or `.crewplane-local` segments. Tool-capable agents are given the absolute live path; no-tools agents receive its JSON-encoded content.
- Task cards are read from the assignment's pinned base commit with `git show`, not the mutable working tree.
- Claude isolation is explicit: `claudeMcp` and `claudeSettingSources` are required; `claudeTools` restricts availability, while allow/deny lists only affect approval. `project` settings are agent-writable in the checkout and are not a least-privilege boundary.
- OpenCode loads its own configuration, plugins and MCP servers; `opencodeAgent` selects an agent profile but Crewplane does not sandbox OpenCode.

### Budgets, denials and session recovery

- Per-lane `maxRunsPerHour` and `maxRunMinutes` may only tighten the global values. `maxCostUsdPerRun` is Claude-only, applies per invocation (so hourly overshoot is possible) and is not a billing total. Reported cost is per invocation for Claude and per step for OpenCode; unknown stays unknown.
- Claude `permission_denials` are counted. A task-owning turn that returns `ready` with known denials pauses as a failure without recording completion evidence; coordinator turns record the count only. This pauses the lane but cannot retract a board `ready` the agent may have published; inspect the board before accepting. Denial and budget pauses remain failures even when the lane is held.
- `crewplane retry --lane ID --task ID --new-session true --text NOTE` clears exactly one native session after atomic checks (single matching record, no live or unverified process, matching harness/epoch, lane not held) and records the outcome in `state.controlOutcome`. Ambiguous matches are refused. It never lifts a hold and cannot be combined with `--confirm-cleanup`.

## Assign and supervise

After committing a card owned by `builder`:

```sh
crewplane agents scope --agent captain --task CP-101 --paths-json '["src/feature"]'
crewplane agents assign --agent captain --task CP-101 --owner builder --ref HEAD --text 'Approved bounded implementation'
crewplane agents schedule --agent captain --task CP-101 --priority normal --dependencies-json '[]'
crewplane start
```

`start` runs the supervisor in the foreground. Use the compiled executable for startup so every agent can invoke the same binary. Each implementation task gets a branch/worktree at its approved base; agents claim it themselves and use project-specific setup/verification. Reviewer turns use separate control directories and inspect the exact requested SHA. The coordinator currently runs in the primary project; it is not a second concurrent primary writer.

The scheduler retains a four-process ceiling, reserves coordinator capacity when enabled, and applies holds/dependencies/authorization before priority and FIFO/aging. Scoped overlap is serialized. Unknown scopes remain protocol-governed: publish known scope before pipelining. Global budgets are run/time limits; per-lane overrides may only tighten them, and `maxCostUsdPerRun` is a native Claude invocation cap rather than a dollar budget.

```sh
crewplane task list
crewplane agent list
crewplane agents inbox --agent builder
crewplane agents send --agent builder --to captain --kind question --task CP-101 --text 'Precise blocking question'
crewplane agents send --agent captain --to builder --kind answer --reply-to UUID --text 'Explicit decision'
```

A clean committed `ready` submission is frozen. Send an exact-SHA request to the configured reviewer; findings return to the coordinator, which requests a task-specific correction from the original author using `--commit CURRENT_READY_SHA`. Both review and author correction requests bind the current assignment identity. New unpinned reviewer requests are rejected; serviced corrections are closed on the next submission and cannot reopen a newer frozen SHA. A disjoint task can proceed while a submission waits. Checkpoint a different active task before routing a required correction. Code review is not integration acceptance.

Integration remains an explicit coordinator Git operation: rebase and fast-forward, or squash. `agents accept` verifies source/integrated ancestry or patch equivalence and rejects merge commits in the integration range; it does not perform a merge. Use `agents help` for acceptance arguments.

## Controls and observation

```sh
crewplane pause --lane builder
crewplane nudge --lane builder --text 'Informational update'
crewplane resume --lane builder
crewplane retry --lane builder
# Only after inspecting and terminating escaped descendants:
crewplane retry --lane builder --confirm-cleanup true --text "Inspected and terminated escaped descendants"
crewplane stop
crewplane status
```

Pause drains future turns. Nudge does not lift holds or failures. Resume lifts an operator hold, preserving failures/decisions. Retry is explicit failure recovery. Unverified escaped-process cleanup requires the explicit acknowledgement above; it cannot clear retained/live process-group identity or operator holds. Commands are tied to their supervisor generation so old queued controls cannot stop a later explicit start. Stop queues intentional drain; wait for `running:false`, settled children/traces and lease release before starting a replacement. A queued command is not a completed action. SIGTERM/SIGINT also request intentional drain; run deadlines bound misbehaving children. Never delete leases to force startup.

`rollout` requests a drain preserving running intent; it does not launch a replacement. Interrupted or identity-less runs pause on restart. A live or unverified old child prevents replacement. A stopped supervisor stays stopped until an explicit `start`.

Run these independently in separate terminals:

```sh
crewplane dashboard --port 4310
crewplane watchdog start
```

The read-only dashboard binds to 127.0.0.1 and enforces Host/Origin checks. It displays task reports, agent process observations, models, budgets, dependency/message graphs and sanitized operational runs. Inspection does not activate agents. The independent watchdog checks every 180 seconds, reports signal coverage and queues bounded informational nudges only under explicit running intent. It cannot restart a controller, clear holds, retry failures or raise budgets.

## Screenshots and videos

Browser tooling remains external. The extracted capture helpers accept an existing Playwright page/context; video requires explicit recording. The binary can ingest already captured files with bounded metadata and independently verify content signatures/digests:

```sh
crewplane evidence create --input run.json
crewplane evidence append --run qa_OPAQUE_ID --input capture.json --file screenshot.png
crewplane evidence list --task CP-101
crewplane evidence manifest --run qa_OPAQUE_ID
```

Run metadata: `{ "task":"CP-101", "lane":"visual", "testedCommit":"FULL_40_CHARACTER_SHA" }`.
Capture metadata: `{ "route":"dashboard", "scenario":"initial", "step":0, "browser":"chromium", "viewport":{"width":390,"height":844}, "mime":"image/png", "outcome":"captured", "findingIds":[], "recheckOf":null }`.

Route values are logical lowercase aliases, never raw URLs, query strings or tokens. PNG/JPEG/WebP/WebM are bounded by store policy (16 MiB per artifact by default); manifests retain task/commit/viewport/recheck provenance. Read-only APIs are `/api/evidence`, `/api/evidence/runs/:opaqueRunId` and `/api/evidence/artifacts/:opaqueArtifactId`. No arbitrary filesystem routes or automatic recording exist.

Normalized traces omit raw stdout/stderr, private reasoning and unclassified model/tool payloads. Token counters cover reported fields only; missing provider dimensions are not certified zero or billing totals. The extracted detailed usage ledger remains a separately tested module, not automatic cache/provider accounting in the runtime or UI.

Peer questions from task owners require `--task ID`. Unanswered questions addressed to another worker notify the coordinator for triage; they do not authorize that peer to claim the sender's task. A reply inherits its original thread task. Board locks recover only verifiably dead PID/token holders; legacy directory locks and invalid ownership require manual inspection.

## Dashboard navigation

The read-only dashboard opens on Overview, with attention items and metrics linking to filtered views. Use the sidebar (or the menu button on mobile) for Tasks, Agents, Messages, Runs, Relationships and System & notes. Tasks offer board/list layouts and a detail pane; agent details separate configured models from observed values. Open conversations and run timelines have direct links. The URL retains the view, filters and selected item across reloads and supports browser back/forward. Polls preserve focus and expanded context; a disconnected banner marks retained data as potentially stale. No reply or execution controls are introduced. See docs/dashboard-design.md for layout, keyboard behavior and coverage limits.

## Project-owned pins and full agent prompts

Projects need no launcher adapter. Opt into project policy version 2 in crewplane.json:

```json
{
  "version": 2,
  "requiredVersion": "0.5.1",
  "coordinator": "captain",
  "reviewers": ["inspector"],
  "promptFiles": {
    "builder": ["docs/agents/common.md", "docs/agents/builder.md"],
    "inspector": ["docs/agents/reviewer.md"]
  }
}
```

The optional requiredVersion is an exact release version, not a range; the example above must equal the release the project was validated against, so raise it whenever the project adopts a newer release. Project commands check the primary checkout's policy before preparing store files; mismatches explain the required and running versions. A pinned project does not schedule automatic self-update. Global --help/--version/update remain available for installation recovery; explicit global update is independent of project pins, so use the upstream installer with CREWPLANE_VERSION to select an exact release. Existing version-1 policies keep their defaults; the new fields require version 2 so older binaries reject them rather than silently skipping enforcement. Policy version is independent of store/config/message schema versions; no store migration occurs.

## Project version pins

A pin mismatch prints one stable error line followed by indented recovery context: the absolute crewplane.json that declares the pin, the running executable, the direction (older pin versus newer requirement), and a pointer to this section. The error message itself stays a single line because the supervisor persists it as a lane pause reason; the extra context is rendered by the CLI only. No executable install command is printed, because lanes read CLI stderr and a cloned repository controls its own pin.

Recovery steps:

1. Confirm the pin is intended. It is read from the primary checkout's working tree, so editing a linked worktree's crewplane.json changes nothing, and every worktree of the project shares the primary's pin.
2. Run the project command at all: if a retained copy of the pinned release exists and verifies, the command is handed to it automatically and no error is printed. Self-update retains the release it replaces as `<releasesRoot>/<version>/crewplane`, where the root is `CREWPLANE_RELEASES_DIR` when set (it must be absolute), else `XDG_DATA_HOME/crewplane`, else `~/.local/share/crewplane`. A mismatch dispatches to the copy whose `--version` matches the pin. Dispatch refuses a copy that is a symlink, a non-file, owned by another user, group/world writable, inside a release directory with those problems, or reporting any other version.
3. Install the pinned release when no retained copy exists yet: after lowering a pin, cloning onto a fresh machine, or when the pinned release predates this feature. Install into the retained layout so dispatch finds it:

   ```sh
   root="${CREWPLANE_RELEASES_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/crewplane}"
   curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh \
     | sh -s -- --version v0.5.1 --dir "$root/0.5.1"
   ```

4. Stop live supervisors before replacing any executable. `update` refuses while a supervisor is registered, but the installer has no such guard; a swapped binary leaves running lanes calling a release they were not started with. Dispatch also refuses to hand a project to an older release while a live, newer supervisor owns the store (a recorded `supervisorVersion` on a running state).

Retention only covers releases replaced by a binary that already has this feature, and only self-update retains: `install.sh`, package managers and manual copies do not. So a 0.5.1 installation updated to the next release is retained from then on, while releases before this feature are not, and every pin needs step 3 once.

Retention is also fail-closed. If the running release cannot be retained (unwritable data directory, full disk, root-owned `XDG_DATA_HOME`), the swap is refused rather than silently breaking a pin; the reason lands in the update cache, `crewplane doctor` reports it, and `CREWPLANE_RELEASES_DIR` is the escape hatch. Each retained release costs one binary on disk and nothing prunes them yet.

`crewplane update` only moves forward to the latest release and never downgrades, so it cannot satisfy a pin by itself: a newer binary in an older-pinned project dispatches to the retained release, and in the newer-pin direction `update` may overshoot the required version entirely. Under a mismatch that cannot dispatch — `pin` itself, a second hop for the same version, failed verification, no usable `execve`, unusable project state, or a store owned by a live newer supervisor — the operator verbs `stop`, `pause`, `resume`, `cancel`, `resolve` and `pin` still run so live work can always be halted, a decision pause can be answered and a stale pin can be repointed; every other project command stays blocked. Queued verbs are interpreted by the release that owns the live supervisor, so the CLI warns when that release differs from the one you are running: a release that does not know a verb ignores it silently. Supervisors record their release in the supervisor state (`supervisorVersion`); a supervisor old enough to predate that field cannot be named, and the CLI says so instead of guessing. Prefer the pinned release's binary for any decision the running release may not understand. Switching a project between releases is not field-neutral: an older release ignores lane settings it does not know, such as cost caps, MCP/tool allowlists or opencode automation, so re-run `crewplane doctor` and `crewplane configure` after the switch and treat the pin as the validated capability set.

## Upgrading a pinned project

`crewplane pin --confirm true` repoints the primary checkout's `requiredVersion` at the release that is running, rewriting only that value so the commit diff stays one line. It is deliberately narrow: it cannot install a release, it cannot pin to a version other than the running one, and it relaxes nothing for any other command. It refuses when the project is not pinned (policy version 1, or version 2 without `requiredVersion`), when a supervisor is running, and unless `--confirm true` is given; when the pin already matches it reports `changed: false` and writes nothing. Because it edits committed policy, treat it as an operator action rather than something an agent runs mid-task: it binds every worktree, machine and CI runner to that release.

Upgrade a pinned project in this order:

```sh
crewplane stop                       # a live supervisor keeps the old binary
# install the target release into its own directory, then invoke it by absolute path
crewplane pin --confirm true         # rewrites requiredVersion to the running release
crewplane doctor                     # validates the project under the new release
crewplane configure --file PATH      # re-materializes lane settings the old one ignored
crewplane start
git commit crewplane.json             # other machines and worktrees move with the pin
```

Order matters. Repinning before installing the target release locks every command out, including the ones needed to fix it. Repinning while a supervisor runs makes each lane's next turn fail prompt preparation and pause as a failure, rather than restarting cleanly. Skipping `configure` leaves lane capabilities the previous release ignored, such as cost caps and tool allowlists, unapplied. `pin` reports `from`, `to`, `file` and a `next` checklist, and running it from a linked worktree still rewrites the primary checkout's file.

crewplane agents prompt builder always supplies built-in role guidance and appends the ordered configured files. Paths and policy come from the canonical primary even when invoked in a linked worker checkout. Each file must be regular valid UTF-8 without NUL, at most 32 KiB; total rendered context is bounded to 64 KiB. Paths must stay inside the project, including resolved symlinks, and cannot read .git or Crewplane private state. Missing, malformed, escaping or oversized files fail explicitly. Empty/absent lists preserve built-in prompts. The files are instructions/data, never automatic command execution or task authority.

Keep engineering instructions, lane guidance and task cards in the project. A supervised tool-capable agent reads the configured AGENTS instructions, which can direct it to run this same native prompt command; this change does not alter supervisor prompts, harness isolation or no-tools capabilities. Runtime per-lane guidance is a separate configured capability. Legacy cutover warnings and rollback steps belong in project documentation, not in an adapter every project must copy. Normal shell/package/just aliases may call the installed crewplane executable directly. No Node/Bun wrapper is required to run it.

### Control plane semantics

Operator controls are queued as private command files and applied only by the supervisor loop. Every command records exactly one outcome (`applied`, `noop`, `refused`, `stale` or `invalid`) in `state.controlLog` with a monotonic `seq`; `--wait N` reports the outcome and exits 0 for applied/noop, 2 for refused/invalid and 3 for stale.

- `pause --lane ID` holds one lane; `pause --all true` holds the whole instance without draining or stopping it. `resume` releases only the requested hold and clears operator pauses, never failures or decisions.
- `cancel --lane ID --run RUN_ID` or `cancel --all true` terminates live runs with SIGTERM, then SIGKILL after the cleanup grace. Cancellation never resets budgets and always leaves a paused failure when cleanup is unverified.
- `retry` clears only failure/no-progress pauses; `retry --confirm-cleanup true --text NOTE` acknowledges cleanup (lane-wide, or one task with `--task`); `retry --lane ID --task ID --new-session true --text NOTE` clears exactly one native session.
- `resolve --lane ID [--task ID] --pause UUID (--approve true|--deny true) --text NOTE` resolves one decision pause by id. It never accepts work or grants permissions.
- `stop` drains and stops; `stop --cancel-active true` also cancels live runs. `rollout` preserves running intent and is refused once a stop is recorded.
- Wide actions are bound to the observed state (`expectRev`/`expectRun`/`expectSession` auto-filled by the CLI). Stale generation or revision is refused, not applied. State is written as v2; v1 state remains readable.
- `status` keeps raw `desired`/`state` and adds `view`: supervisor intent versus observed phase (including stale heartbeats), per-lane holds/revisions/runs/pauses, pending controls and recent control outcomes.
- The dashboard is read-only unless started with `dashboard --controls`; that opt-in exposes only hold and cancel through `POST /api/control` with an exact `Origin`, per-launch `x-crewplane-token`, JSON body and a 4 KiB bound.
