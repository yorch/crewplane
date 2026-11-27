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

Release integrity has two layers. Every release publishes `<asset>.sha256`; once signing is enabled it also publishes `<asset>.sig`, an Ed25519 signature over `crewplane-release-v1`, the tag, the asset name and the SHA-256 (see docs/RELEASING.md). Signing is enabled by listing a public key in `release-keys.json`, which is compiled into the binary and mirrored in `install.sh`; its `signedSince` tag is the first release that must be signed. With no key listed, only the same-origin SHA-256 is checked (it detects corruption, not a replaced release) and the installer says so. With a key listed, a release at or after `signedSince` (every release when it is unset) needs a valid signature and the installer fails closed: it needs an `openssl` that verifies Ed25519 (`pkeyutl -verify -rawin`, OpenSSL 3.x). macOS ships LibreSSL, which cannot, so run `brew install openssl` and put its keg-only bin first on `PATH`: `export PATH="$(brew --prefix openssl@3)/bin:$PATH"`. A built-in known-answer test proves the local openssl works. A capable openssl always verifies. Only when this machine's openssl cannot, `--allow-unverified` proceeds on the SHA-256 alone after a loud warning; it has no effect otherwise, and never skips the checksum. Releases older than `signedSince` install on the SHA-256 with a warning. A hostile `openssl` earlier on `PATH` could fool the known-answer test; control of `PATH` is already code execution.

Custom release sources must use `https`, except loopback test servers (`127.0.0.1`, `localhost`, `::1`). The installer stages the download inside the target directory, verifies the published checksum, runs the staged file with `--version`, requires that version to match the tag, and only then renames it into place. It never invokes `sudo`, never skips the checksum, skips signature checking only through the explicit `--allow-unverified` case above, and leaves an existing installation untouched when any check fails. A symlinked target is replaced by a real file after a warning. Linux assets are built against glibc; musl/Alpine is not verified. Windows is unsupported.

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

A successful `updated` outcome reports `integrity`: `"signed"` (with `signingKey`, the id of the key that verified) or `"sha256"` (no keys configured, or the release predates `signedSince`; in the second case a `note` says so). The outcome is one of `current`, `available`, `updated`, `unsupported` (source run, foreign platform, or disabled) or `failed`. Failures still print a JSON outcome and exit non-zero with the reason on stderr. `update` refuses while any supervisor is registered unless `--force` is given; explicit updates keep the caller's environment, including `GITHUB_TOKEN`. Automatic checks run with a filtered environment and never inherit credentials. Updates verify the published SHA-256, the Ed25519 signature when release keys are configured (a missing or invalid signature is refused with outcome `failed` and never falls back to the checksum; verification happens before anything is staged), the platform executable header, and the staged binary's reported version, then rename a verified copy inside the install directory; running processes keep the binary they started with. Downgrades are not automatic: install a pin with `install.sh --version TAG` and set `CREWPLANE_NO_AUTO_UPDATE=1` to keep it.

| Environment                            | Meaning                                                                                                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREWPLANE_NO_AUTO_UPDATE=1`           | Disable automatic checks and swaps                                                                                                                                                                                                             |
| `CREWPLANE_UPDATE=off`                 | Same opt-out, by mode                                                                                                                                                                                                                          |
| `CREWPLANE_UPDATE_INTERVAL_HOURS`      | Minimum hours between automatic checks (default 24)                                                                                                                                                                                            |
| `CREWPLANE_CACHE_DIR`                  | Directory for `crewplane/update.json`, its lock and supervisor registrations (default `$XDG_CACHE_HOME` or `~/Library/Caches`); never forwarded to supervised children, because anything that can write it can forge a supervisor registration |
| `CREWPLANE_UPDATE_TIMEOUT_MS`          | Timeout for release metadata requests (default 20000)                                                                                                                                                                                          |
| `CREWPLANE_UPDATE_DOWNLOAD_TIMEOUT_MS` | Timeout for the asset download (default 300000)                                                                                                                                                                                                |
| `CREWPLANE_UPDATE_MAX_BYTES`           | Streamed asset download limit (default 256 MiB; metadata is capped at 1 MiB)                                                                                                                                                                   |
| `CREWPLANE_RELEASE_BUILD=1`            | Treat this binary as a release build (used by acceptance tests)                                                                                                                                                                                |
| `CREWPLANE_STATE_DIR`                  | Absolute base for the private control directory (see "Control directory"); default `$XDG_STATE_HOME` or `~/.local/state`                                                                                                                       |
| `GITHUB_TOKEN` / `GH_TOKEN`            | Optional; sent only to `https://api.github.com` for explicit release lookups                                                                                                                                                                   |

The update cache records `target`, `lastAttemptAt`, `latest`, `updatedAt` and the last `error`. A signed release is not a freshness guarantee: someone with release write access can still point `latest` at an older, validly signed release, and signatures do not expire (see docs/RELEASING.md, trust model). Until a release key is configured, checksums come from the same release as the binary: verification proves transport integrity, not publisher identity, and assumes the GitHub release account and storage are not compromised. Once a key is configured, a release must carry a valid signature from a key compiled into the running binary, so replacing release assets is no longer enough to ship a binary to auto-updating machines. Notarization is still not done.

## Initialize a project

Run `crewplane --project /path/to/repo init` in a non-bare Git project. This creates a `crewplane.json` policy if absent, a task directory and private shared file store. It adds private runtime directories to Git's local exclude file. Existing instructions and configuration are preserved. Commit policy and task cards; never commit runtime state.

Linked worktrees discover the same primary project and store through Git. `CREWPLANE_COORD_DIR` optionally selects an absolute shared board store. Repository identity and the Crewplane namespace are checked before use; Relay state is never implicitly adopted.

### Control directory

Two kinds of state are kept apart:

- The **board** (tasks, messages, assignments, claims, evidence, operational traces, monitor output) stays in the project store, `<primary>/.crewplane-state` or `CREWPLANE_COORD_DIR`. Agents read and write it through `crewplane agents`; it is the only location supervised children are told about.
- The **control plane** lives in a private per-user directory outside the project: `<base>/crewplane/projects/<key>`, where `<base>` is `$CREWPLANE_STATE_DIR` (must be absolute, otherwise the command fails), else an absolute `$XDG_STATE_HOME`, else `~/.local/state`, and `<key>` is the first 24 hex digits of the SHA-256 of the canonical (symlink-resolved) primary root, so every linked worktree and symlinked path of one project agrees. It holds `config.json` (including `allowedTasks` and lane enablement), `state.json`, `desired.json`, the `commands/` queue, supervisor and watchdog leases, run logs, native session files and the watchdog's own state and notices. `crewplane doctor` prints the exact `controlDirectory`.

The directory is created with mode 0700 and verified on every use: it must be a real directory (not a symlink), owned by the current user and neither group- or world-writable nor readable by other users, including its `crewplane` and `projects` parents; otherwise the command fails with `Unsafe control directory`. Platforms without POSIX ownership checks (Windows) are refused with an explicit message. The supervisor, `configure`, control verbs, the dashboard's control endpoint and the watchdog write only here. Children keep `CREWPLANE_COORD_DIR=<store>`; the control directory is never placed in a child's environment. A child running `crewplane agents ...` derives the same directory from the project root (forwarding `HOME`, `XDG_STATE_HOME` and, if you set it, `CREWPLANE_STATE_DIR`) to read run state for its `claim`/`release` guards. Under a supervised child (`CREWPLANE_HEADLESS_LANE`) a missing control directory or state file refuses those guards instead of passing them. The guard is advisory: without an OS sandbox a same-user agent can still edit the board directly, and a sandbox, not Crewplane, is what would make the control directory read-only.

A supervised child may run only `agents`, `task list`, `agent list`, `evidence`, `monitor`, `status` and `doctor` (plus help and version). Every other verb (`configure`, `start`, `dashboard`, `pin`, `migrate`, `update`, `init`, `watchdog` and every control verb) fails with `crewplane: This command is unavailable to headless agents`. This allowlist, and the `claim`/`release` guards that need control state, depend on environment variables (`CREWPLANE_HEADLESS_LANE`, `HOME`, `XDG_STATE_HOME`, `CREWPLANE_STATE_DIR`) that a child can unset or change: they are advisory guard rails against accidents and prompt-injected mistakes, not enforcement. Only an operating-system sandbox that denies writes to the control directory actually blocks a deliberate same-user agent.

**Project binding.** The first write records a random id in `<store>/control-binding.json` and the same id plus the canonical primary root in `<control>/identity.json`. Commands that use the control directory check both. They refuse, with a message naming the likely cause, when the store records prior supervision but the derived directory is absent or empty (the repository moved or was renamed, or `HOME`, `XDG_STATE_HOME` or `CREWPLANE_STATE_DIR` differ from the original start); when the directory is bound to a different project identity; and, for `start`, `configure` and the widening verbs, when it holds an identity the store does not recognize (a re-clone at the same path would otherwise inherit an old configuration). `stop`, `pause` and `cancel`, and the dashboard's hold and cancel, skip the store-marker comparison (an unreadable, invalid or FIFO marker counts as absent for them, read without blocking, since `identity.json` in the private directory is the authority) when `identity.json` names this very project, because narrowing a directory bound to the same root is safe and a lost marker must not stop an operator halting a live supervisor; they still refuse a directory bound to another project. If the marker was deleted or rewritten, `crewplane migrate --rebind` rewrites it from `identity.json` (operator only, refused for supervised children, only when the roots match). `status` only warns. A halt that cannot reach the supervisor (environment differs) refuses rather than queue into a directory nobody reads, and warns when the update registry shows a live supervisor using a different control directory. To start fresh on purpose, move the control directory aside; this discards its holds and state.

**This is defense in depth, not a sandbox.** Without an operating-system sandbox, an agent running as the same user can still read or write any file that user can reach, including this directory. The relocation protects against harnesses that enforce directory-scoped writes (for example Codex workspace-write, which is handed the project root, or Claude `acceptEdits`) and against prompt-injected accidental writes: a forged `commands/*.json` or `config.json` in the project store no longer reaches the supervisor, and the supervisor no longer hot-reloads `allowedTasks` or lane enablement from a location an agent can edit.

#### Migrating from an older release

Releases before this change kept the control plane in `<store>/supervisor` (and the watchdog in `<store>/watchdog`). While `<store>/supervisor` exists, state-touching project commands refuse with one stable line and exit code 1:

```text
crewplane: Legacy supervisor state detected in the project store; run `crewplane migrate` before using this release (see docs/USAGE.md "Control directory")
```

Exempt from the gate: `--help`, `-h`, `help`, `--version`, `-v`, `update`, `init` (policy and board directories only), `migrate`, `pin` (which checks both layouts for a running supervisor before editing policy) and `doctor` (read-only; it reports `legacyLayout`). Halting verbs have their own rules, below.

```sh
crewplane migrate --dry-run                   # read, validate, print everything adoptable and its digest; changes nothing
crewplane migrate --accept-config DIGEST      # adopt exactly the snapshot you reviewed
crewplane migrate --discard-legacy            # set a forged legacy directory aside (--ignore-pid PID to override one PID)
crewplane migrate --rebind                    # repair a lost store marker from identity.json
```

The legacy directory was writable by agents, so `migrate` treats everything in it as untrusted input and adopts only an allowlist, each file re-serialized from validated values (raw bytes are never copied):

- **Adopted.** `config.json` (validated by the same decoder `configure` uses, and required to name this project's root); `desired.json` (re-written as canonical `desiredRunning`, a short escaped reason and a timestamp); a minimal subset of `state.json` (held agents, `instanceHeld`, agent revisions, control sequence, retired run counters, and per record only its key, agent, task, working directory, status, pause kind and id, escaped short reason, harness name, `cleanupUnverified`, run counters and token counters; the structural event cursor (`seen` ids of the fixed `message:`, `review:`, `planning:` and similar forms, `seenMessagesThrough` as an ISO date and `seenMessagesAtBoundary` as UUIDs, so old history is not replayed); process ids are never adopted: a record that had a run, or a process id, becomes a failure pause with `cleanupUnverified` for explicit retry); and narrowing pending commands (below). Session ids, summaries, notices, the control log, attention and scheduling data, and any other free text are dropped. A record that names a live process refuses the migration and names it.
- **Left behind, never adopted.** Every lease and lock (`watcher.lock`, `recovery.lock`, lease directories), `identity.json` and binding files (identity is regenerated for this project), `pi-sessions/`, `runs/`, `result-schema.json` (regenerated at start), an earlier `quarantined-commands/`, the journal, any unknown file, commands beyond the first 256, and anything that is not a regular file or exceeds 1 MiB (8 MiB in total). The retired legacy directory is kept as `supervisor.migrated-<id>` for inspection and the `<store>/watchdog` tree is set aside the same way, never deleted. The dry run lists every left-behind name with its class and file count.
- **Bounded, non-blocking reads.** Each adopted file is opened without following symlinks and without blocking (so a FIFO cannot hang the command), its size is checked on the descriptor before reading, and the `commands/` directory is read flat. The legacy directory's identity is re-checked afterwards, and the whole run is abandoned cleanly after 30 seconds. Nothing is ever renamed or hard-linked into the new directory, so a hard link, an open descriptor or a working directory an agent holds in the old tree cannot reach the published files.
- **Review everything.** `crewplane migrate --dry-run` prints, on stderr, the effective binary for every agent exactly as the supervisor resolves it (`binaries.<harness>`, and only codex falls back to the top-level `binary`) with a `[WARNING: inside the project; agents can modify it]` marker on any binary or `instructionsPath` inside the project root or store (symlinks are resolved, and case is folded on case-insensitive volumes); the complete canonical configuration with every key (`passEnv`, Claude permission mode, MCP and setting sources, tool lists, OpenCode automation, model, budgets, `maxParallel`, `allowedTasks` and so on); the complete canonical state subset and desired text; every re-armed and not-armed command; and the left-behind list. Control, format, separator and C1 characters are shown as `\u{...}` escapes, and the JSON on stdout escapes the same classes. Any listed binary will run as you when you `start`.
- **Digest-bound acceptance.** If anything is adoptable (a config, a desired file, any state, any re-armable command), `crewplane migrate --accept-config <digest>` is required, even without a `config.json`, where the digest is the one the dry run printed. The digest covers exactly the canonical bytes that will be published (a SHA-256 over the sorted path and content hash of each adopted file) and nothing else is published except a freshly written `identity.json` for this project, so content that arrives after your dry run, opaque or otherwise, is either left behind or changes the digest and refuses. `start` additionally re-derives coordinator and reviewer roles from the committed project policy, as `configure` does.
- **Pending commands.** Each staged command file is decoded. Only narrowing controls (`pause`, `stop` without `cancelActive`, `cancel`) that name an agent the adopted configuration has (or none) are re-armed, reduced to the action and its lane, run or all selector with `issuer: "migrate"` and no timestamp or generation. Everything else (`resume`, `retry`, `resolve`, `rollout`, `nudge`, `stop --cancel-active true`, unknown agents, undecodable or misnamed files) is listed under `quarantinedCommands` with its reason and left behind; it is never published and can never lift a hold.

`migrate` prints a JSON summary (`status`: `migrated`, `dry-run`, `nothing-to-migrate` or `discarded`, plus `from`, `to`, `files`, `digest`, `config`, `configAccepted`, `rearmedCommands`, `quarantinedCommands`, `leftBehind`, `ignoredLivenessClaims`, `ignoredPids`, `discardedTo`, `leftover`, `watchdogSetAside`). While it works it holds the lease older releases honour (`watcher.lock` in the legacy directory, unless a lease file is already there, which it never replaces) and `recovery.lock` (a small JSON file with the pid and start time, so an older release's stale-owner recovery cannot interleave and so a later `migrate` can tell a dead owner's lock from a live one), and it re-checks liveness and the destination after the preflight. Only its own lock files are ever removed. A recovery lock left by a crashed migration whose owner is dead is replaced; one whose owner is alive, or that an older release holds, refuses with a message, and you remove it by hand only once its owner is gone (while it exists an older release's start will refuse too). A destination that appears later makes the final rename fail instead of merging. It refuses, changing nothing, while:

- a supervisor lease or recorded supervisor PID is alive, owned by you and **credibly a Crewplane supervisor**: any same-user PID can be written into a lease an agent can edit, so a PID counts only when the per-user supervisor registry has an entry that fits that very process (it registered shortly after the process started) **and** its executable is `crewplane` or `bun` running a `start` command that is not an inline script (`-e`, `--eval`, `-p`, `--print`). Refusals print the executable and the escaped command line. Other PIDs, and PIDs another user owns, are reported in `ignoredLivenessClaims` and ignored;
- a recorded child process you own is alive, or a running heartbeat from the last 60 seconds exists (heartbeats more than five seconds in the future are ignored as forged); `--discard-legacy` is the way past these;
- the destination already has content other than a matching `identity.json` and validated narrowing commands (halts you queued before migrating are carried into the reviewed set and listed), or the old directory is a symlink or is owned by another user.

A PID you have verified is not a supervisor can be declared with `--ignore-pid PID` on a normal `migrate` as well as on `--discard-legacy`; the PID is echoed. The supervisor registry lives in your per-user cache directory, so it is advisory: anything that can write it can forge a registration, which is why `CREWPLANE_CACHE_DIR` is never forwarded to supervised children.

It never deletes lease files. Before publication the published tree's digest is journaled in a private file beside the control directory (`<key>.migrating.json`), never in the agent-writable legacy tree, so a forged journal can never make a run skip the review; identity is written into the staged tree and checked against the store marker before anything is published, and the old directory is retired only after the binding completed. Both copies exist briefly between publication and retirement; if the process dies there, rerunning `migrate` finishes the binding and the retirement once the destination digest matches the journal and refuses otherwise. Rerunning is harmless.

**What the review does and does not guarantee.** The digest-bound review guarantees that what is adopted is exactly the canonical text you read, and that nothing an agent changes afterwards (or holds a handle to) reaches the new files. It does not prove the legacy content was benign: a malicious configuration is kept out only if you notice it in the printed values. A same-user agent with no OS sandbox can still read and write everything you can, including the new directory.

If a forged or unusable legacy directory wedges the project (for example a fresh heartbeat that keeps being rewritten, a recorded child that is not a real child, or a planted `recovery.lock`), `crewplane migrate --discard-legacy` renames it, and any `<store>/watchdog` tree, to `<name>.discarded-<timestamp>` next to it and reports the paths; nothing is deleted, so you can inspect it. It refuses only on a credible live supervisor (see above) and is unavailable to supervised children. If you have verified that a PID the refusal names is not a supervisor, `--discard-legacy --ignore-pid PID` (repeatable) sets it aside anyway and echoes the PID. Then run `crewplane configure --file PATH` as usual.

While a legacy directory holds state, the halting verbs stay usable and never refuse, so live work can always be stopped (an empty or file-less legacy directory is not state at all and blocks nothing). With nothing live anywhere the verb is simply queued in the control directory; the control copy is always queued first, legacy copies are best effort, legacy files are read without blocking and bounded, and a symlinked legacy `commands/` is never written through. A live **new** supervisor always wins: `status`, `stop`, `pause` and `cancel` operate on the control directory and warn about the legacy one, whatever it claims. With no live new supervisor, a credibly live older-release supervisor is addressed in its legacy directory and the narrowing verb is also queued in the control directory (each copy carries its own directory's supervisor generation, and anything read from the legacy directory is flagged unverified; `status` never reads it as truth and shows it only as `unverifiedLegacy`); when the legacy claims are only ambiguous (a fresh heartbeat or a foreign PID), the verb is queued in both directories and the warning names the claims. Every other verb (`resume`, `resolve`, `retry`, `nudge`, `rollout`, `start`, `configure`) keeps refusing. Stop the old supervisor, wait for `running:false`, then run `crewplane migrate`.

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

## Guided setup

`crewplane setup` generates the runtime configuration that `configure --file` installs, so you do not have to write the JSON by hand. Run `init` first. Then use the wizard in a terminal, or pass flags from a script.

Setup never starts a harness and never runs a harness executable: each binary is only checked to be an absolute, executable regular file that users outside your own groups cannot replace, nor any directory or link on its path (ACLs, mounts, attributes, capabilities and check-to-use races are not covered; `doctor` applies the same check; see [Binary safety checks](#binary-safety-checks)).

By default it writes no configuration. See [Default runs and files](#default-runs-and-files) for the exact effects.

### Interactive wizard

Run `crewplane --project /path/to/repo setup` in a terminal. Both stdin and stdout must be terminals; otherwise setup fails with exit 1 and suggests `--non-interactive true`.

- Prompts and echoed text go to stderr. The final JSON report goes to stdout, so it appears on the terminal too.
- The wizard lists the executables it found on PATH (and any candidates it rejected, with the reason), then asks for a template, binaries, models, Claude safety fields, implementer lane IDs, allowed task IDs and the four limits.
- `custom` (wizard only) chooses a harness for the coordinator, the implementers and the reviewers separately. Pi is offered only for reviewers.
- An invalid answer is re-asked up to three times, then setup stops with exit 1.
- Ctrl+C or end of input aborts with `Setup cancelled; nothing was written`.
- The review asks `yes` or `no`. Answering `no` aborts with nothing written. Anything else is re-asked, up to the same three attempts.
- Installing is offered only if you answer `yes` to "Is the supervisor stopped?". A `yes` is refused with exit 1 (nothing is written) when the control state says a supervisor is running or supervisor liveness evidence says one is live. An optional `--out` path is offered last; a path that would be refused (see [Default runs and files](#default-runs-and-files)) is re-asked.
- Task cards on disk only seed the defaults for implementer lane IDs (from `Owner:` lines) and allowed task IDs. Cards whose `Status:` says done, complete(d), closed, cancelled, abandoned, accepted or merged are skipped, at most 200 cards are read, and every ID is validated. You must confirm or edit the defaults; nothing is authorized without your answer.
- A bad Pi model is re-asked, because it is checked by the same engine validator as every other lane field.

### Non-interactive mode

Scripts and automation use `--non-interactive true` (the value must be exactly `true`) with `--template` and `--tasks`. Passing any other option without it is an error. `--tasks` is required: task cards on disk are never trusted to decide which tasks may run, so without `--tasks` setup fails with exit 1 and writes nothing.

```sh
crewplane --project /path/to/repo setup --non-interactive true --template codex --binary /usr/local/bin/codex --tasks CP-101
```

Templates produce these configurations. Every template's output is accepted by the same validator `configure` uses.

- `codex`: every lane runs Codex. The executable goes in the top-level `binary` field only, with no `binaries` map. `--model` is optional.
- `claude`: every lane runs Claude Code, with `binaries.claude`. `--model` is required. Lanes carry explicit `claudePermissionMode`, `claudeMcp`, `claudeSettingSources` and `maxCostUsdPerRun`.
- `opencode`: every lane runs OpenCode, with `binaries.opencode`. `--model` is required, as `provider/model` or `provider/model#variant`.
- `mixed`: the coordinator and implementers run Claude Code. Reviewers run OpenCode, or Pi with `--reviewer-harness pi`. It needs `--model` for Claude, and `--reviewer-model` for OpenCode reviewers. The top-level `binary` is the Claude executable.

Lane IDs come from the committed `crewplane.json`. By default the coordinator is `coordinator`, and the reviewers are `reviewer` and `visual`. Implementer IDs come only from `--implementers`, or default to the single ID `implementer`; `Owner:` lines in task cards are not read in non-interactive mode. The `visual` reviewer starts disabled (`"enabled": false`); the notes say so.

Coordinator and reviewer lanes always use Claude's `plan` mode. Only implementer lanes take `--claude-permission-mode`. Bypass and manual modes are not offered.

### Flags

| Flag                              | Applies to                                  | Meaning and default                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--non-interactive true`          | all                                         | Required for scripts. The value must be `true`.                                                                                                                                                                                      |
| `--template NAME`                 | all                                         | `codex`, `claude`, `opencode` or `mixed`. Required in non-interactive mode.                                                                                                                                                          |
| `--binary PATH`                   | `codex`                                     | Absolute Codex executable. Default: `codex` on PATH. Rejected for other templates.                                                                                                                                                   |
| `--claude-binary PATH`            | `claude`, `mixed`                           | Absolute Claude executable. Default: `claude` on PATH.                                                                                                                                                                               |
| `--opencode-binary PATH`          | `opencode`, `mixed` with OpenCode reviewers | Absolute OpenCode executable. Default: `opencode` on PATH.                                                                                                                                                                           |
| `--pi-binary PATH`                | `mixed` with Pi reviewers                   | Absolute Pi executable. Default: `pi` on PATH.                                                                                                                                                                                       |
| `--model ID`                      | `claude`, `opencode`, `mixed`, `codex`      | Required for Claude and OpenCode. Omitted for Codex means the harness default. For `mixed`, it sets the Claude model.                                                                                                                |
| `--reviewer-model ID`             | `mixed` with OpenCode reviewers             | Required OpenCode model for reviewers.                                                                                                                                                                                               |
| `--reviewer-harness opencode\|pi` | `mixed`                                     | Reviewer harness. Default `opencode`.                                                                                                                                                                                                |
| `--pi-model PROVIDER/MODEL`       | `mixed` with Pi reviewers                   | Optional. Omitted means Pi's own default.                                                                                                                                                                                            |
| `--tasks ID,ID`                   | all                                         | Task IDs that may ever run. Required in non-interactive mode; there is no default.                                                                                                                                                   |
| `--implementers ID,ID`            | all                                         | Implementer lane IDs. Default: the single ID `implementer`. Must not match the coordinator or a reviewer.                                                                                                                            |
| `--confirm-stopped true`          | all                                         | Records the current UTC time as `confirmedStoppedAt`. Refused while a supervisor is running or live. See below.                                                                                                                      |
| `--install true`                  | all                                         | Installs the configuration as `configure` does. Requires `--confirm-stopped true`.                                                                                                                                                   |
| `--out PATH`                      | all                                         | Writes the JSON to a new file with mode 0600, atomically, never overwriting. Relative paths resolve from the `--project` directory when you pass `--project`, otherwise from the current directory. See below for refused locations. |
| `--claude-permission-mode MODE`   | Claude lanes                                | Implementer mode: `acceptEdits` (default), `auto`, `dontAsk` or `plan`.                                                                                                                                                              |
| `--claude-mcp strict\|inherit`    | Claude lanes                                | Default `strict`.                                                                                                                                                                                                                    |
| `--claude-setting-sources LIST`   | Claude lanes                                | Comma list of `user`, `project`, `local`. Default `project`.                                                                                                                                                                         |
| `--max-cost-usd N`                | Claude lanes                                | Cap per Claude invocation: 0.01 to 100, at most two decimals. Default `2`.                                                                                                                                                           |
| `--max-parallel N`                | all                                         | 1 to 4. Default `2`.                                                                                                                                                                                                                 |
| `--interval-seconds N`            | all                                         | 1 to 60. Default `10`.                                                                                                                                                                                                               |
| `--max-run-minutes N`             | all                                         | 1 to 60. Default `25`.                                                                                                                                                                                                               |
| `--max-runs-per-hour N`           | all                                         | 1 to 60. Default `20`.                                                                                                                                                                                                               |

Claude flags are rejected unless the template uses Claude. Flags for a harness the template does not use are rejected too.

### Default runs and files

A run without `--out` or `--install` writes no configuration. Like every project command, the first run also creates the board store `.crewplane-state/` if it is missing. It does not create the control directory.

`--out` writes a new file atomically: the content goes to a 0600 temporary file in the same directory, is fsynced, and is then linked to the final name, which cannot replace anything that exists. The temporary file is removed on every failure and on SIGINT, SIGTERM or process exit before the file is published; a SIGKILL or power loss in that window can still leave the hidden `.NAME.<12 hex>.tmp` file (0600). The next `--out` to the same target, after every refusal below has passed, sweeps such leftovers once they are older than one hour, and only entries in the target's own directory whose name is exactly `.NAME.<12 lowercase hex>.tmp` for the same `NAME`, that are regular files (not symlinks, not directories), owned by you, mode exactly 0600, with a single link and neither modification nor change time within the hour; a younger file (a live concurrent setup) and everything else are left alone, and a sweep error never fails setup. Until a later `--out` to the same target runs, a leftover stays (safe to delete by hand). Every refusal is checked before anything is written, with exit 1:

- the path names a directory, or an existing file or symlink (no overwrite);
- the parent directory does not exist or is not a directory;
- the path is inside the private control directory, the Crewplane store (`.crewplane-state`, including a `CREWPLANE_COORD_DIR` store) or `.crewplane-local`, or inside a `.git` directory;
- the path is inside a git work tree and is not git-ignored (`git check-ignore`; a nested repository's own rules decide). Only git's genuine "not a git repository" answer, with no `.git` entry (directory or file) in the target's directory or any ancestor, counts as outside a repository. Any other git failure refuses the path: a repository owned by another user (dubious ownership), a `.git` file pointing to a missing gitdir, an unreadable `.git`, a bare repository, a `.git` above a filesystem boundary, a missing `git`, or a 10 second timeout. Git runs with `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, a C locale and no inherited `GIT_*` variables, so repository configuration cannot run code. Inside a work tree, add the file to `.gitignore` (or `.git/info/exclude`) first.

The file can be given to `configure --file` once you add `confirmedStoppedAt`, or once you rerun with `--confirm-stopped true`. The report's `next` hint shell-quotes the path.

`--install true` runs the same install path as `configure`, plus one extra refusal: under the install lock it also refuses when supervisor liveness evidence says one is live, not only when the state records `running`. With `--install` and `--out`, the file is prepared first but published only after the install succeeds, so a refused install leaves no file. If the install succeeded and publishing the file then fails (for example the name appeared meanwhile), the command exits 1 saying the configuration was installed but `--out` was not written; no file is created.

### Rerunning with a different harness

The supervisor refuses to start a lane whose harness differs from its latest recorded run unless the lane carries a fresh explicit `sessionEpoch`. `sessionEpoch` is accepted for every harness, so setup reads the installed `config.json` and `state.json` (read-only). The supervisor compares a lane only with its latest state record, so setup does too: when the lane has a record, an unchanged harness reuses that record's `sessionEpoch` (or none, if the record has none) and a changed harness gets a fresh one; the installed configuration is consulted only for a lane with no record at all. This keeps a codex, then claude (never served), then codex sequence from inventing an epoch the crashed codex record lacks. Pi lanes are planned the same way as every other lane (a rerun of an unchanged Pi lane keeps its recorded epoch instead of minting a new one). When an unchanged lane's installed configuration carries a `sessionEpoch` that its latest record lacks or differs from, that epoch is discarded and a note names the lane and says `serve` will resume the recorded session. Each switch is reported as a note naming the lane, printed once on stderr (in the wizard, before the review prompt), and another note appears when the lane's latest record is not idle. The supervisor still only accepts the switch when the lane is drained and idle, and it keeps the prior records; stop and drain first. An unreadable `config.json` or `state.json` fails setup closed.

### Binary safety checks

Beyond being an absolute executable regular file, a binary that setup records, and that `doctor` accepts, must not be replaceable by other users:

The path is resolved the way the kernel does, one component at a time from `/`, and each step is inspected with `lstat` without being executed. That covers every directory entered (as named, through each symlink, and the ancestors of those) and every symlink followed, including links in the middle of the path and relative `..` in link targets (hop limit 40; a loop is refused). Anything under `/proc` is refused, because its magic links read back as text that is not their real target. The path as named is what gets recorded, and only when this whole walk passes.

Checked (POSIX; ownership and group checks are skipped where there is no uid):

- Every symlink on the path and the final file is refused when owned by a user other than the current user or root, even inside a directory you own or a sticky directory.
- The final file is refused when world-writable, or when group-writable by a group the current user is not in (a umask-002 `0775 user:user` binary from npm or cargo is accepted; the same file with a foreign group is refused).
- Every directory (the one holding the binary, each directory or link holding a symlink, and every ancestor up to `/`) with the sticky bit is judged by ownership only: it must be owned by the current user or root, whatever its group and world write bits, because only an entry's owner or the directory's owner can rename or remove entries in it (`/tmp` `1777`, and multi-user Nix `/nix/store` `1775 root:nixbld`, are accepted for a user outside `nixbld`). Every other directory is refused when world-writable, or owned by a user other than the current user or root, or group-writable by a group the current user is not in. Group membership is the user's primary group plus supplementary groups, so a `user:admin 775` Homebrew directory is accepted for a member of `admin` and refused otherwise, and a `root:staff 2775` `/usr/local/bin` is accepted for a member of `staff` and refused otherwise.

Trust boundary: other members of your own groups are inside it. The guarantee is only that users outside your own groups cannot replace the binary or any directory or link on its path.

Not checked: ACLs, extended attributes, mounts (a read-write bind or network mount), capabilities, or anything that changes after the check (check-to-use races): the file may still be replaced between setup and launch.

The walk splits POSIX paths, so it is not meaningful on Windows (an unsupported platform). The same refusal carries different codes by command: `doctor` reports `BINARY_UNSAFE`, while `setup` keeps its report contract and reports `BINARY_INVALID` (see docs/CONTRACTS.md).

PATH candidates that fail are skipped and listed as `rejected /full/path/to/binary: reason` (in the wizard's listing and in the notes on stderr), and the next PATH entry is tried; if none passes, the error lists the rejected ones. An explicit `--binary` style flag or wizard answer that fails is refused. `doctor` applies the same check to each lane's effective binary and the top-level `binary` once the existing probes pass, reporting a failure as `BINARY_UNSAFE` with the reason (it never runs the binary). The check is not a sandbox (a same-user attacker is out of scope). The final verification also repeats it.

### Stopped confirmation

`confirmedStoppedAt` is an operator assertion. Setup does not prove that old harnesses or supervisors have stopped.

- In the wizard, answer `yes` only after everything is stopped. The time is then recorded.
- In non-interactive mode, `--confirm-stopped true` records the time the command runs. Use it only after stopping.
- Without it, the field is omitted, a note explains what to do, and `configure` rejects the file until the field is added.
- `--install true` cannot run without it.
- Setup refuses to record it, with exit 1 and nothing written, while the control state says a supervisor is running or supervisor liveness evidence (the check `pin` uses) says one is live. This applies to `--confirm-stopped true` and to a wizard `yes`. It cannot prove that unrelated harnesses are stopped.

### Report and exit codes

Stdout is one JSON report on success. Notes and problems go to stderr as `crewplane: note: ...` and `crewplane: CODE (lane): message`.

The report has these fields:

- `version`: always `1`.
- `mode`: `interactive` or `non-interactive`.
- `template`: the template, or `custom` in the wizard.
- `config`: the runtime JSON `configure --file` accepts. It has no `root` or roles, which come from the project.
- `confirmedStopped`: whether `config` contains `confirmedStoppedAt`.
- `written`: the absolute `--out` path, or `null`.
- `installed`: whether the configuration was installed.
- `problems`: verification findings as `{code, lane?, message}`. Empty when valid.
- `notes`: advice, such as disabled reviewers or the Pi no-tools reminder. Harness-switch epoch notes appear here in non-interactive runs; the wizard prints them once before the review prompt and does not repeat them.
- `next`: the suggested next commands.

Exit codes:

- `0`: the report was printed and verification found no problems. This includes a plain preview.
- `1`: nothing on stdout. Causes include invalid or conflicting flags or answers, a missing `--tasks`, no usable or an unsafe executable, no terminal, headless refusal, a cancelled wizard, a refused `--out` path, a refused stop confirmation, a refused install and a failed install.
- `2`: the report was printed with `problems`, and nothing was written or installed. Verification repeats the binary and instruction-file checks on the final configuration, so it only happens when something changed after an answer was accepted: typically a wizard session where the binary was replaced, removed or made writable while the review prompt waited (a removed binary is reported as `BINARY_MISSING`).

### Pi reviewers

Pi appears only as a reviewer, never as coordinator or implementer. Pi lanes are no-tools: `piPermissions` is `no-tools`, a Pi lane gets a fresh `sessionEpoch` on the first setup run and whenever its harness switches, and keeps its recorded epoch on a rerun (see above), and each turn ends as a paused advisory decision for operator relay. Pi is also available in the wizard's `custom` template, with the same reviewer-only limit.

### Headless agents

A supervised child (`CREWPLANE_HEADLESS_LANE` set) cannot run `setup`. Both modes fail with exit 1 before anything is read, including `--install true`.

### Examples

Wizard, with a report on the terminal:

```sh
crewplane --project /path/to/repo setup
```

Preview a mixed configuration. Nothing is written:

```sh
crewplane --project /path/to/repo setup --non-interactive true --template mixed \
  --model opus --reviewer-model opencode-go/claude-haiku-5-5 \
  --claude-binary /usr/local/bin/claude --opencode-binary /usr/local/bin/opencode \
  --tasks CP-101,CP-102 > preview.json
```

Install a Claude configuration after stopping everything. This is the only form that changes the control directory:

```sh
crewplane --project /path/to/repo setup --non-interactive true --template claude \
  --model opus --claude-binary /usr/local/bin/claude --tasks CP-101 \
  --confirm-stopped true --install true
crewplane --project /path/to/repo doctor
```

## Configure explicit execution

`crewplane setup` can generate this file; see [Guided setup](#guided-setup). The hand-written shape below is still accepted by `configure --file`.

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

`configure` installs a private configuration, overriding its root and roles from the selected project; it does not launch anything. Reconfiguration requires stopped state. Configured models are optional and remain distinct from observed models. Existing harness credentials and permissions apply; Crewplane does not log in or act as an OS sandbox. Harness children do not inherit the whole operator environment. They receive a safe base (`PATH`, `HOME`, locale, temp, proxy and CA variables, `XDG_*` directories, git author/committer identity and `GIT_SSL_*`/`GIT_CONFIG_*` locations, Crewplane location settings such as `CREWPLANE_RELEASES_DIR`, and the Windows process basics), the provider variables that harness reads (`OPENAI_*` and `CODEX_HOME` for Codex; `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR` and the `CLAUDE_CODE_USE_*`/OAuth/Bedrock/Vertex switches for Claude Code; `OPENCODE_*` plus `OPENAI_*`/`ANTHROPIC_*` for OpenCode; `PI_*` plus `OPENAI_*`/`ANTHROPIC_*` for Pi) and, for Pi and OpenCode, the conventional `<PROVIDER>_API_KEY` of the lane's configured provider. Everything else is withheld, including `GITHUB_TOKEN`, cloud and registry credentials, git credential helpers (`GIT_ASKPASS`), `SSH_AUTH_SOCK`, `GNUPGHOME` and host-session variables of an enclosing Claude Code or Codex session. A lane opts in to more with an optional `passEnv` array of variable names (at most 32, no duplicates), for example `"passEnv": ["AWS_PROFILE", "AWS_REGION"]` for Claude Code on Bedrock, or `["SSH_AUTH_SOCK"]` when agents must sign commits or use ssh remotes. Runtime- and update-steering names (`NODE_OPTIONS`, `BUN_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`, interpreter startup variables, TLS-weakening variables, `CREWPLANE_RELEASE_*`/`CREWPLANE_UPDATE*`) are refused. Only environment variables are withheld: files under `HOME` and `XDG_*` (for example `~/.aws/credentials`) stay readable by the agent. `doctor` lists each lane's `passEnv`. This tightens earlier behaviour: a lane whose provider key is not covered above must now list it in `passEnv`. `doctor` diagnoses the project without launching anything: it validates the stored configuration (a missing binary does not hide other configuration errors), probes each lane's effective harness binary and the top-level `binary` (absolute path, regular file, executable by the current user, then the [binary safety check](#binary-safety-checks); the binary is never run, so versions are not checked, and on Windows the executable check cannot tell shims apart), checks lane instruction files, the retained-releases and update-cache directories, and reports each lane's `passEnv`. The report carries `ok` and a `problems` list of `{code, lane?, message}` with stable codes (`CONFIG_MISSING`, `CONFIG_INVALID`, `BINARY_MISSING`, `BINARY_INVALID`, `BINARY_NOT_EXECUTABLE`, `BINARY_UNSAFE`, `INSTRUCTIONS_INVALID`, `RELEASES_ROOT_INVALID`, `CACHE_DIR_INVALID`, `LEGACY_LAYOUT`); the exit code is `0` when `ok` and `2` when problems exist, with the JSON still on stdout, so scripts can gate on it (`crewplane doctor >/dev/null || exit 1`). A missing global instructions file is only a `warnings` entry and does not affect `ok`. An unconfigured project reports `CONFIG_MISSING` with the `crewplane configure --file PATH` hint. `runtime` is `compiled` for the standalone executable and `bun` when run from source. Outside a git repository, or without `git`, `doctor` fails like every project command (exit 1, message on stderr). Change note: `doctor` now exits `2` on an unconfigured project (it used to exit `0`) and on any diagnosed problem, and `runtime` is no longer always `bun`. Compatibility change: scripts that gate on `doctor`'s exit code can now see exit `2` (`BINARY_UNSAFE`) for an existing, previously accepted configuration whose binary other users could replace, for example in a world-writable directory without the sticky bit, a directory owned by another user, or a file group-writable by a group you are not in. `configure` and `start` still accept such a configuration; only `doctor` reports it. Fix the permissions or reinstall the binary in a private location. It does not certify credentials, provider operation or harness-version compatibility.

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

The read-only dashboard binds to 127.0.0.1, enforces Host/Origin checks and requires a per-launch session header on every `/api/*` read (see the dashboard navigation notes below). It displays task reports, agent process observations, models, budgets, dependency/message graphs and sanitized operational runs. Inspection does not activate agents. The independent watchdog checks every 180 seconds, reports signal coverage and queues bounded informational nudges only under explicit running intent. It cannot restart a controller, clear holds, retry failures or raise budgets.

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

`crewplane dashboard` binds to 127.0.0.1 and prints a URL whose fragment carries a per-launch session token (`http://127.0.0.1:PORT/#token=…`). The page moves the token into `sessionStorage` (scoped to that origin and port, unlike a cookie), strips it from the address bar and sends it as an `x-crewplane-session` header on every data request; the fragment is never sent to a server or in a `Referer`. The page and scripts are public embedded assets, but every `/api/*` read without the header is refused with 401, so other local users on a shared machine, and web pages or other local servers, cannot read the board, traces or evidence even though the Host and Origin checks pass for them. Scripts can send the same header. The token changes on every launch; Crewplane never writes it to disk (your browser's session restore, or stdout redirected to a file, might). The session lasts for that browser tab: a new tab, a typed address or a bookmark of the stripped URL needs the printed URL again. Pasting the new URL into a tab that already shows the dashboard re-adopts the token without a reload. Treat the printed URL like a password in shared terminal logs, and note that a browser keeps the URL you typed or clicked in its history until you clear it; a new launch invalidates it. A tab left open across a restart shows a "Session missing or expired" banner until you reopen the new URL. The read-only dashboard opens on Overview, with attention items and metrics linking to filtered views. Use the sidebar (or the menu button on mobile) for Tasks, Agents, Messages, Runs, Relationships and System & notes. Tasks offer board/list layouts and a detail pane; agent details separate configured models from observed values. Open conversations and run timelines have direct links. The URL retains the view, filters and selected item across reloads and supports browser back/forward; a reload also restores scroll position and the open "How to read…" notes for that tab. Updates and banners preserve focus and expanded context; a disconnected banner marks retained data as potentially stale. No reply or execution controls are introduced.

Live updates: the page opens `GET /api/events`, a server-sent event stream that carries the session header (read with `fetch`, since `EventSource` cannot send headers). The server recomputes the board about once a second at best, only while a browser is connected, waiting at least five times as long as the last computation took (up to 30 seconds) so a slow board is not read back to back, and pushes a snapshot only when its content changed, plus a heartbeat every 15 seconds. The heartbeat carries the time of the last successful read, which is what "Checked" shows, so a stuck read shows an old time instead of looking current. At most 8 streams are served at once, so a tab hidden for 30 seconds closes its stream and reopens it, with an immediate refresh, when you return to it. A snapshot is pushed only when it is at most 8 MiB serialized (roughly 20,000 board messages); a larger board is never sent, the stream stays open and says so, and the page keeps polling `/api/snapshot` (indicator: "polling") until the board shrinks, without reconnecting in a loop. Message history is not pruned by the dashboard. The connection indicator keeps its "Live" / "Disconnected" status and shows the transport beside the check time: "live updates" while the stream delivers, "polling" otherwise. If the stream cannot be opened (blocked, a ninth viewer, an older proxy in between) or drops, the page falls back to the previous 5-second polling of `/api/snapshot`, with the same retained-snapshot banner, and keeps reconnecting with capped exponential backoff and jitter. Run timelines still poll `/api/runs`. Nothing about the stream starts or controls an agent.

Read-only data routes for the setup, control and usage views: `/api/config` (the effective configuration with the same per-binary checks and problem codes as `crewplane doctor`; environment variable names only, never values, and no binary is run), `/api/control-log` (the bounded operator-control audit trail), `/api/usage` (runs per hour against caps, recent run durations, reported token counters and Claude cost observations, and a 24-hour run series). Usage figures are reported counters, not billing totals, and a series bucket that retained history does not cover is `null`, not zero; on a new install the series stays `null` until a run older than a bucket exists. Caps in `/api/usage` and `/api/config` come from the installed configuration, with the values the running supervisor loaded shown beside them and a `reloadPending`/`loadedDiffers` flag; the global `maxRunsPerHour` is a per-lane default, not a total. `/api/config` inspects at most 64 lanes and reads `config.json` with the size-capped, symlink-refusing reader. `/api/evidence` gained `run`, `limit` and `cursor` filters and `/api/evidence/artifacts` lists artifact metadata; artifact bytes are served with a fixed content type allowlist and a sandboxing content security policy. Every route is `GET` only and needs the session header; the full contract is in docs/CONTRACTS.md (Dashboard HTTP API). The only write route is the opt-in `POST /api/control` described under Control plane semantics. See docs/dashboard-design.md for layout, keyboard behavior and coverage limits.

## Project-owned pins and full agent prompts

Projects need no launcher adapter. Opt into project policy version 2 in crewplane.json:

```json
{
  "version": 2,
  "requiredVersion": "<release you run: crewplane --version>",
  "coordinator": "captain",
  "reviewers": ["inspector"],
  "promptFiles": {
    "builder": ["docs/agents/common.md", "docs/agents/builder.md"],
    "inspector": ["docs/agents/reviewer.md"]
  }
}
```

The optional requiredVersion is an exact release version, not a range, so the placeholder above must be replaced with the release you run (`crewplane --version`); `crewplane pin --confirm true` writes it for you and keeps the diff to one line. Project commands check the primary checkout's policy before preparing store files; mismatches explain the required and running versions. A pinned project does not schedule automatic self-update. Global --help/--version/update remain available for installation recovery; explicit global update is independent of project pins, so use the upstream installer with CREWPLANE_VERSION to select an exact release. Existing version-1 policies keep their defaults; the new fields require version 2 so older binaries reject them rather than silently skipping enforcement. Policy version is independent of store/config/message schema versions; no store migration occurs.

## Project version pins

A pin mismatch prints one stable error line followed by indented recovery context: the absolute crewplane.json that declares the pin, the running executable, the direction (older pin versus newer requirement), and a pointer to this section. The error message itself stays a single line because the supervisor persists it as a lane pause reason; the extra context is rendered by the CLI only. No executable install command is printed, because lanes read CLI stderr and a cloned repository controls its own pin.

Recovery steps:

1. Confirm the pin is intended. It is read from the primary checkout's working tree, so editing a linked worktree's crewplane.json changes nothing, and every worktree of the project shares the primary's pin.
2. Run the project command at all: if a retained copy of the pinned release exists and verifies, the command is handed to it automatically and no error is printed. Self-update retains the release it replaces as `<releasesRoot>/<version>/crewplane`, where the root is `CREWPLANE_RELEASES_DIR` when set (it must be absolute), else `XDG_DATA_HOME/crewplane`, else `~/.local/share/crewplane`. A mismatch dispatches to the copy whose `--version` matches the pin. Dispatch refuses a copy that is a symlink, a non-file, owned by another user, group/world writable, inside a release directory with those problems, or reporting any other version.
3. Install the pinned release when no retained copy exists yet: after lowering a pin, cloning onto a fresh machine, or when the pinned release predates this feature. Install into the retained layout so dispatch finds it:

   ```sh
   root="${CREWPLANE_RELEASES_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/crewplane}"
   version=$(crewplane --version)   # the release the project pins
   curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh \
     | sh -s -- --version "v$version" --dir "$root/$version"
   ```

4. Stop live supervisors before replacing any executable. `update` refuses while a supervisor is registered, but the installer has no such guard; a swapped binary leaves running lanes calling a release they were not started with. Dispatch also refuses to hand a project to an older release while a live, newer supervisor owns the store (a recorded `supervisorVersion` on a running state).

Retention only covers releases replaced by a binary that already has this feature, and only self-update retains: `install.sh`, package managers and manual copies do not. So an installation updated to the next release after adopting this feature is retained from then on, while earlier releases are not, and every pin needs step 3 once.

Retention is also fail-closed. If the running release cannot be retained (unwritable data directory, full disk, root-owned `XDG_DATA_HOME`), the swap is refused rather than silently breaking a pin; the reason lands in the update cache, `crewplane doctor` reports it, and `CREWPLANE_RELEASES_DIR` is the escape hatch. Each retained release costs one binary on disk and nothing prunes them yet.

`crewplane update` only moves forward to the latest release and never downgrades, so it cannot satisfy a pin by itself: a newer binary in an older-pinned project dispatches to the retained release, and in the newer-pin direction `update` may overshoot the required version entirely. Under a mismatch that cannot dispatch — `pin` itself, a second hop for the same version, failed verification, no usable `execve`, unusable project state, or a store owned by a live newer supervisor — the operator verbs `stop`, `pause`, `resume`, `cancel`, `resolve` and `pin` still run so live work can always be halted, a decision pause can be answered and a stale pin can be repointed; every other project command stays blocked. The migration gate (see "Control directory") applies on top of this: under a mismatch these verbs still need no legacy `<store>/supervisor` directory, except that `stop`, `pause` and `cancel` keep halting a live older-release supervisor. Queued verbs are interpreted by the release that owns the live supervisor, so the CLI warns when that release differs from the one you are running: a release that does not know a verb ignores it silently. Supervisors record their release in the supervisor state (`supervisorVersion`); a supervisor old enough to predate that field cannot be named, and the CLI says so instead of guessing. Prefer the pinned release's binary for any decision the running release may not understand. Switching a project between releases is not field-neutral: an older release ignores lane settings it does not know, such as cost caps, MCP/tool allowlists or opencode automation, so re-run `crewplane doctor` and `crewplane configure` after the switch and treat the pin as the validated capability set.

## Pins older than the control-directory relocation

Releases before the control-directory relocation keep their supervisor state in `<store>/supervisor`. Pinning a project to such a release dispatches commands to a binary that uses that layout again, and every newer binary then meets the legacy-layout gate until you migrate or discard it. Treat crossing the relocation in either direction as a stop-the-supervisor operation: stop, run `crewplane migrate` with the newer binary before moving forward, and do not run both generations against one project. Dispatch reads the legacy `state.json` without a permission check, so a group-writable legacy directory does not by itself make the project state look unusable.

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

Operator controls are queued as private command files in the control directory and applied only by the supervisor loop. Every command records exactly one outcome (`applied`, `noop`, `refused`, `stale` or `invalid`) in `state.controlLog` with a monotonic `seq`; `--wait N` reports the outcome and exits 0 for applied/noop, 2 for refused/invalid and 3 for stale.

- `pause --lane ID` holds one lane; `pause --all true` holds the whole instance without draining or stopping it. `resume` releases only the requested hold and clears operator pauses, never failures or decisions.
- `cancel --lane ID --run RUN_ID` or `cancel --all true` terminates live runs with SIGTERM, then SIGKILL after the cleanup grace. Cancellation never resets budgets and always leaves a paused failure when cleanup is unverified.
- `retry` clears only failure/no-progress pauses; `retry --confirm-cleanup true --text NOTE` acknowledges cleanup (lane-wide, or one task with `--task`); `retry --lane ID --task ID --new-session true --text NOTE` clears exactly one native session.
- `resolve --lane ID [--task ID] --pause UUID (--approve true|--deny true) --text NOTE` resolves one decision pause by id. It never accepts work or grants permissions.
- `stop` drains and stops; `stop --cancel-active true` also cancels live runs. `rollout` preserves running intent and is refused once a stop is recorded.
- Wide actions are bound to the observed state (`expectRev`/`expectRun`/`expectSession` auto-filled by the CLI). Stale generation or revision is refused, not applied. State is written as v2; v1 state remains readable.
- `status` keeps raw `desired`/`state` and adds `view`: supervisor intent versus observed phase (including stale heartbeats), per-lane holds/revisions/runs/pauses, pending controls and recent control outcomes.
- The dashboard is read-only unless started with `dashboard --controls`; that opt-in exposes only hold and cancel through `POST /api/control` with an exact `Origin`, a separate per-launch controls `x-crewplane-token` (distinct from the read session token), JSON body and a 4 KiB bound.
