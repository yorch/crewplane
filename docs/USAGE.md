# Running Crewplane

Build with Bun 1.4.1 (`bun run build`), then place `dist/crewplane` on PATH or invoke it by absolute path. Bun and Node are not needed to run that executable. Git and the configured harness executables remain external. Initial platforms are macOS and Linux; Windows is not accepted.

## Install and update the CLI

The installer resolves a GitHub release, downloads the asset for the host platform, and verifies its published SHA-256 before replacing anything:

```sh
curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh -s -- --version v0.2.0 --dir "$HOME/bin"
```

| Option          | Environment              | Meaning                                                         |
| --------------- | ------------------------ | --------------------------------------------------------------- |
| `--version TAG` | `CREWPLANE_VERSION`      | Exact release, e.g. `v0.2.0`; default is the latest tag         |
| `--dir DIR`     | `CREWPLANE_INSTALL_DIR`  | Install directory; default `~/.local/bin`                       |
| `--dry-run`     | —                        | Print the resolved asset, source and target without downloading |
| —               | `CREWPLANE_RELEASE_API`  | Latest-release JSON, default the GitHub API                     |
| —               | `CREWPLANE_RELEASE_BASE` | Release download base URL                                       |

The installer downloads into the target directory, verifies the checksum and the reported `--version` of the staged file, then renames it into place. It never runs under sudo, never skips verification, and leaves an existing installation untouched when any check fails. Linux assets are built against glibc; musl/Alpine is not verified. Windows is unsupported.

An installed release binary updates itself. At most once every 24 hours a project command starts a detached check; when a newer release is published and verified it replaces the running executable, and the new version takes effect on the next invocation. The swap is skipped for `start`, `dashboard`, `watchdog` and `monitor`, and while this project's supervisor reports running, so long-lived coordination is never affected. The check never delays or fails the foreground command, and no project state, hold, budget or queued control is touched.

```sh
crewplane update           # apply now; prints a JSON outcome
crewplane update --check   # report without downloading or replacing
```

The outcome is one of `current`, `available`, `updated`, `unsupported` (source run, foreign platform, or disabled) or `failed`. Updates verify the published SHA-256 and the platform executable header, then rename a verified copy atomically inside the install directory; running processes keep the binary they started with. Downgrades are not automatic: install a pin with `install.sh --version TAG`.

| Environment                       | Meaning                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CREWPLANE_NO_AUTO_UPDATE=1`      | Disable automatic checks and swaps                                                                   |
| `CREWPLANE_UPDATE=off`            | Same opt-out, by mode                                                                                |
| `CREWPLANE_UPDATE_INTERVAL_HOURS` | Minimum hours between automatic checks (default 24)                                                  |
| `CREWPLANE_CACHE_DIR`             | Directory for `crewplane/update.json` and its lock (default `$XDG_CACHE_HOME` or `~/Library/Caches`) |
| `CREWPLANE_UPDATE_TIMEOUT_MS`     | Per-request timeout for release requests (default 20000)                                             |
| `CREWPLANE_UPDATE_MAX_BYTES`      | Download size limit (default 256 MiB)                                                                |
| `GITHUB_TOKEN` / `GH_TOKEN`       | Optional; sent only to `api.github.com` for release lookups                                          |

The update cache records `lastAttemptAt`, `latest`, `updatedAt` and the last `error`. Releases are not signed or notarized yet, so checksum verification assumes the GitHub release account and file storage are not compromised.

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

The retained Codex adapter uses the extracted native exec/schema/resume protocol. Pi is explicitly restricted to `no-tools`, requires a fresh `sessionEpoch`, separate provider/model fields and a configured absolute `binaries.pi` path. Pi is not an implementation-capable substitute under this policy.

Claude Code (probed with CLI 2.1.319) requires an explicit `model` and a non-bypass `claudePermissionMode` (`acceptEdits`, `auto`, `dontAsk` or `plan`). It receives the result schema as inline `--json-schema`, binds a generated UUID with `--session-id` on a fresh run and resumes with `--resume`; it exposes tool permissions to the harness and never enables `bypassPermissions`. OpenCode (probed with CLI 2.2.5) requires an explicit `model` in `provider/model` or `provider/model#variant` form and runs `opencode run --standalone --format json`. Its JSON stream has no schema-enforced result, so the agent receives the JSON-only instruction; the server-generated `ses_...` session is captured and resumed with `--session`. Because that flag also creates a missing session, OpenCode resume is best-effort identity continuity, not proof the prior context survived. `opencodeAuto: true` is the only auto-approval opt-in and is off by default.

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
      "claudePermissionMode": "plan"
    },
    "builder": {
      "enabled": true,
      "harness": "claude",
      "model": "claude-opus-5-5",
      "claudePermissionMode": "acceptEdits"
    },
    "inspector": {
      "enabled": true,
      "harness": "opencode",
      "model": "opencode-go/claude-haiku-5-5",
      "opencodeAuto": true
    }
  }
}
```

Harness settings never cross harnesses: Pi, Claude and OpenCode fields on the wrong harness are rejected. Reported input/output counters are harness-reported fields only: Claude excludes cache creation/read tokens from `input_tokens`, OpenCode reports cache and reasoning separately, and neither is a billing total. Live native harness compatibility is limited to the probed CLI protocols above and must be rechecked before real activation; acceptance uses synthetic events and lifecycle fixtures, not live provider calls.

## Assign and supervise

After committing a card owned by `builder`:

```sh
crewplane agents scope --agent captain --task CP-101 --paths-json '["src/feature"]'
crewplane agents assign --agent captain --task CP-101 --owner builder --ref HEAD --text 'Approved bounded implementation'
crewplane agents schedule --agent captain --task CP-101 --priority normal --dependencies-json '[]'
crewplane start
```

`start` runs the supervisor in the foreground. Use the compiled executable for startup so every agent can invoke the same binary. Each implementation task gets a branch/worktree at its approved base; agents claim it themselves and use project-specific setup/verification. Reviewer turns use separate control directories and inspect the exact requested SHA. The coordinator currently runs in the primary project; it is not a second concurrent primary writer.

The scheduler retains a four-process ceiling, reserves coordinator capacity when enabled, and applies holds/dependencies/authorization before priority and FIFO/aging. Scoped overlap is serialized. Unknown scopes remain protocol-governed: publish known scope before pipelining. Budgets are run/time limits, not a dollar or provider-token cap.

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
