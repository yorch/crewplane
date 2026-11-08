# Crewplane whole-project review at `eb246ed`

**Reviewer:** Claude Opus 5.5 (`claude-opus-5-5`), read-only Read/Glob/Grep. Nothing was edited or run, and no tests or services were started, so every finding comes from static tracing. No model was substituted.

**Verdict:** 28 findings: no P0, 4 P1, 12 P2, 12 P3. The main weaknesses are correction and recovery routing, process-group ownership, and persistence ordering around launch and shutdown. Safety checks mostly fail closed, but several documented recovery paths don't actually recover.

## Scope reviewed

- **Contracts:** `AGENTS.md`, `docs/tasks/CP-06.md`, `ARCHITECTURE`, `PLAN`, `CONTRACTS`, `STATUS`, `USAGE`.
- **Read in full:** `cli`, `project`, `io`, `adapters`, `ports`, `contracts`, `prompts`, `profiles/relay`, and engine modules `supervisor`, `orchestration`, `fair-scheduler`, `scheduling`, `wait-policy`, `control-policy`, `config-reload`, `harness`, `watch`, `agents.mjs`, `read-model`, `dashboard.ts`, `dashboard/headless.ts`, `assets.ts`, `operational-traces`, `evidence/store`, `evidence/contract`, `watchdog/*` (non-test).
- **Build and CI:** `scripts/embed.ts`, `package.json`, the workflow, Vitest/TS/Biome config, Dockerfile.
- **Tests read in full:** `supervisor.test`, `supervisor.lifecycle.test`, `orchestration.test`, `tests/binary.ts`, the harness fixture, `tests/project.test`, `tests/browser.test`. Others were sampled; see Coverage.

## P1 findings

### 1. [P1] A failed correction or resume turn is consumed, and `retry` cannot bring it back

- **Location:** `src/engine/supervisor.ts:~613, ~849`; `src/engine/orchestration.ts:~59-61, ~234-240, ~256`
- **Scenario:** Task T is `ready`, so its record has `finalState: "ready"`. The coordinator sends correction R. The turn starts, then fails before the author's `status working` (provider error, spawn failure, early timeout, interrupted run). The operator runs `retry`.
- **Consequence:** `pendingRevision` sees `finalState === "ready"` and R in `seen`, so T has no requests. Line ~256 skips it before `add()`, so the retry notice can't wake it, and R is never serviced. The same applies to a blocked task resumed by an answer: `freshAnswer` is false after the failed turn.
- **Root cause:** Events are marked seen before launch, and `finalState` survives failed runs.
- **Fix:** Clear `finalState` at launch, and mark events consumed only after a valid completed turn (or keep a separate delivered/serviced distinction).
- **Regression:** For both correction and blocked-answer cases: fail the turn, `retry`, assert the same key and session run again.

### 2. [P1] A correction deadlocks when the author has an uncheckpointed blocked task

- **Location:** `src/engine/orchestration.ts:~241-264, ~303-306`; `src/engine/agents.mjs:~332-339`
- **Scenario:** Author has A `ready` and later B `blocked` with no checkpoint. Review of A returns a correction.
- **Consequence:** B counts as competing, so A gets `OWNERSHIP_INVALID`. B gets no candidate, because `anyRevision` suppresses `resumeBlocked` and line ~256 skips it. Even a fresh answer to B can't help. No turn can ever run the required checkpoint, which leaves only a manual checkpoint from B's worktree or abandoning B.
- **Root cause:** The checkpoint request is only delivered to non-frozen siblings, while `blocked` counts as frozen.
- **Fix:** Schedule a checkpoint-only turn for an uncheckpointed blocked sibling.
- **Regression:** Extend `orchestration.test` (which only covers checkpointed siblings) to assert B checkpoints, then A's correction runs.

### 3. [P1] Process-group members survive completion, and restart checks only the leader

- **Location:** `src/engine/supervisor.ts:~343-351, ~755-785`; `src/engine/watchdog/runner.ts:~354-359`
- **Scenario A:** A harness tool leaves a background writer in the group with stdio redirected, and the leader exits. `close` fires and nothing sweeps the group, so a later turn runs alongside it.
- **Scenario B:** At the deadline SIGTERM goes to the group and the leader exits. `finish` clears `killTimer`, so a SIGTERM-ignoring member never gets SIGKILL.
- **Scenario C:** After a crash the leader is dead but group members live. Startup sees `ESRCH`, marks the run interrupted, and `retry` can launch alongside them.
- **Consequence:** Violates "child cleanup precede lease release" and "a live or unverified old child prevents replacement".
- **Root cause:** Liveness and cleanup are keyed to the leader PID, and `record.pid` is deleted at the start of `finish`.
- **Fix:** Keep the process-group identity until the group is empty. Add a bounded TERM→KILL sweep before persisting completion, and refuse startup on `kill(-pgid, 0)` success.
- **Regression:** Compiled-fixture tests for a background child after normal exit, a TERM-ignoring child at timeout, and dead leader with live group.

### 4. [P1] A checkout failure permanently wedges the task record

- **Location:** `src/engine/supervisor.ts:~49-55, ~204-213, ~558-580, ~595-602`
- **Scenario:** `git worktree add` exceeds the 10-second helper timeout, or a transient Git failure hits validation of a claimed worktree. The failure path stores `cwd: config.root`. After `retry`, `workdir` succeeds but `old.cwd !== cwd`, so the record pauses as "Native session checkout changed". Every later `retry` repeats this. An agent claiming a worktree other than the supervisor-created path hits the same permanent pause.
- **Consequence:** The only documented recovery can't succeed. The escape is `release` and reassignment, which discards the assignment and session binding.
- **Root cause:** The failure path overwrites session-bound `cwd` with a placeholder, and setup isn't idempotent.
- **Fix:** Never overwrite an existing `cwd`; leave it unset for a first-run failure. Remove or extend the timeout for `worktree add`, and resume partial setup safely.
- **Regression:** Inject first-run and claimed-worktree Git failures, `retry`, assert launch in the correct checkout.

## P2 findings

### 5. [P2] Launch identity is not durable before the child can start work

- **Location:** `src/engine/supervisor.ts:~608-686, ~724-727, ~922`
- **Scenario:** The supervisor is SIGKILLed after `spawn` and before the first save at ~922. Disk still shows `idle`, the detached child keeps running, and a new `start` relaunches the same session. Separately, `sessionId` isn't saved on capture, so a crash within one interval makes `retry` start a new session in the same checkout.
- **Root cause:** No write-ahead launch record, and the prompt is written before identity is persisted.
- **Fix:** Persist launch intent before spawn, and send the prompt only after the PID is durably saved. Save on session capture.
- **Regression:** Barrier the save after spawn, kill the supervisor, assert the restart refuses or pauses.

### 6. [P2] One failed state write poisons all later saves, and the lease is released anyway

- **Location:** `src/engine/supervisor.ts:~314-320, ~943-952`
- **Scenario:** A transient ENOSPC or EIO rejects one `atomic`. `saving.then(...)` then skips every later write, including completions and the final `running: false`, and `finally` still releases the lease.
- **Consequence:** State stays stale after the lease is released, violating "persist completion before releasing process ownership".
- **Root cause:** The rejected promise stays in the chain.
- **Fix:** Isolate failures with `saving.catch(...).then(...)`, retry the final save, and define behaviour when persistence is impossible.
- **Regression:** Inject one write failure, assert later saves are attempted and a final state is written.

### 7. [P2] Completion depends only on `close`, so a stdio-holding descendant hangs the drain

- **Location:** `src/engine/supervisor.ts:~755-768, ~905-906, ~940-941`
- **Scenario:** A descendant in a new session inherits stdout. The leader exits or is killed, but `close` never fires and SIGKILL to the old group can't reach the descendant. The `children` entry stays forever, so `stop` never finishes and the lease is held.
- **Consequence:** Contradicts `USAGE`: "run deadlines bound misbehaving children".
- **Root cause:** There is no `exit` handling or bounded post-exit wait.
- **Fix:** After `exit` or deadline, wait a bounded grace, destroy the pipes, and settle as a failure that still marks the unverified descendant.
- **Regression:** Fixture with a detached descendant holding stdout; assert drain completes in bounded time and reports a failure.

### 8. [P2] Codex failures and timeouts are misreported as "Result handling failed"

- **Location:** `src/engine/supervisor.ts:~56-62, ~625, ~786-791, ~888-897`; `supervisor.lifecycle.test.ts:~207-228`
- **Scenario:** Codex exits non-zero or times out before writing a result. The output file was pre-created empty, so `JSON.parse("")` throws and the error path runs.
- **Consequence:** "CLI run failed" and "Time budget reached" are effectively unreachable for typical failures. `noProgress`, `progress` and `waitingForEvent` aren't updated, and the finish log and log pruning are skipped. The existing test pins the misleading reason for malformed output, and no test covers those two reasons.
- **Root cause:** Parse failure is treated as a storage fault instead of an invalid result.
- **Fix:** Treat unreadable or empty output as an invalid result inside normal classification.
- **Regression:** Assert exact reasons for non-zero with empty output, timeout with empty output, and malformed output.

### 9. [P2] A coordinator `request` on a blocked task never launches

- **Location:** `src/engine/orchestration.ts:~231-256, ~300`; `src/engine/fair-scheduler.ts:~285-286`; `src/engine/agents.mjs:~508-528, ~923`
- **Scenario:** An author reports `blocked` with no question, which emits only an `update`. `answer` needs a question or request to reply to, so the coordinator sends `request`. The candidate is `revision` on a non-ready task and stays `REVISION_NOT_READY`.
- **Consequence:** The author is never woken. Watchdog `queueState` doesn't map this reason, so the row is dropped from its queue and `queue` is marked unavailable.
- **Root cause:** Only `answer` or a checkpoint can resume a blocked task.
- **Fix:** Treat an unserviced, task-specific coordinator request as a resume trigger.
- **Regression:** Orchestration test: blocked, no question, coordinator request, `resume` selected.

### 10. [P2] `release` ignores a running native turn, and `accept`/`release` bypass the board lock

- **Location:** `src/engine/agents.mjs:~396-403, ~733-755`; `src/engine/orchestration.ts:~332-337`
- **Scenario:** The coordinator releases task X while its owner's turn runs, then reassigns X to another lane. The overlap check excludes `r.task === candidate.taskId`, so both native sessions write X's scope concurrently. Separately, a `release` racing `status` can recreate a task directory containing a stale `status.json`, which a later assignment inherits.
- **Consequence:** Bypasses the exclusive-writer and "live old child prevents replacement" invariants.
- **Root cause:** `release` doesn't check runtime ownership, and both commands are outside the mutation lock.
- **Fix:** Reject `release` while a record runs for that task, compare overlap by run key, and lock both commands.
- **Regression:** Release during a running record is rejected; the same task under another lane is serialized.

### 11. [P2] Author corrections have no revision identity, so a stale request can reopen a frozen submission

- **Location:** `src/engine/agents.mjs:~238-250, ~531-538, ~872-879`; `tests/binary.ts:~280-292`
- **Scenario:** C1 gets correction R1, then C2 is submitted. R1 stays unanswered, as in the acceptance run. `outstandingRevision` is still true, so `status working` can reopen C2 with no new request. Requests also match by task ID only, so R1 can carry across `release` and reassignment.
- **Consequence:** Contradicts "corrections return to the author with exact revision identity". Stale requests also keep the coordinator's `outboundWait` true and raise permanent monitor alerts.
- **Root cause:** `--commit` is restricted to reviewer requests, and matching ignores the current commit and assignment.
- **Fix:** Pin author corrections to `status.commit` and assignment, and close them on the next submission.
- **Regression:** After C2, reopening without a new C2-pinned request fails; a request from a released assignment is ignored.

### 12. [P2] Evidence reads mutate the store across processes and can brick it

- **Location:** `src/engine/evidence/store.ts:~198-199, ~250-252, ~264-272, ~349-356, ~448, ~524-526`; `src/engine/dashboard.ts:~19-33`
- **Scenario:** During `append`, between writing the artifact and saving the manifest, another process opens the store (`evidence list`, a second `append`, or `/api/evidence`). `load()` deletes the "unreferenced" artifact. The writer then saves a manifest referencing it.
- **Consequence:** Every later `load()` throws, so all evidence commands and store opens fail until manual repair. The dashboard also memoizes a rejected store promise until restart. Concurrent appends can lose manifest updates, and each load re-hashes every artifact synchronously.
- **Root cause:** The "one writer process owns a root" assumption isn't enforced, and the CLI and dashboard are separate processes.
- **Fix:** Make reads non-mutating, add a per-root writer lock with cleanup only under it, isolate damaged runs, and don't cache rejections.
- **Regression:** Multi-process append with concurrent list; assert no artifact loss and the store remains usable.

### 13. [P2] Valid but large inputs permanently fault the supervisor

- **Location:** `src/engine/fair-scheduler.ts:~82-83, ~103-122`; `src/engine/orchestration.ts:~65-76, ~229`; `src/engine/supervisor.ts:~505, ~935-942`
- **Scenario A:** Accepted tasks remain in the `tasks` input, so more than 1000 live tasks throws `INVALID_SCHEDULE_INPUT`.
- **Scenario B:** A 12-character lane, 96-character task ID and 64-character epoch produce a 219-character key against a 200-character limit.
- **Consequence:** `evaluateOrchestration` isn't guarded, so every loop and restart faults.
- **Root cause:** Scheduler limits are narrower than identifier limits and include completed history.
- **Fix:** Exclude resolved accepted tasks where possible, align or hash keys, and fail the affected candidate instead of the supervisor.
- **Regression:** Maximum-length identifiers and more than 1000 accepted tasks still schedule.

### 14. [P2] Two legitimate idle coordinator wake-ups pause all coordination

- **Location:** `src/engine/wait-policy.ts:~65-85`; `src/engine/supervisor.ts:~803-830`; `src/engine/orchestration.ts:~139-145`
- **Scenario:** Two separate events (a `failure:` notice, then a blocked or planning notice) arrive with nothing for the coordinator to do. It ends `waiting` with no outstanding question or request from itself, so it isn't an explicit wait. Two such turns hit the threshold and the coordinator lane pauses, stopping question handling and reviews routing until an operator retries.
- **Root cause:** The counter is meant for workers looping on the same work, but it spans distinct coordinator events. `wait-policy.test` pins the general counting.
- **Fix:** Reset or exclude the coordinator's counter when a turn consumed a fresh event.
- **Regression:** Two distinct no-action events stay idle; repeated same-event no-progress still pauses.

### 15. [P2] Watchdog reports an `operations` signal for a directory production never writes

- **Location:** `src/engine/watchdog/runner.ts:~72-122, ~335`; `src/cli.ts:~207-211`; `src/engine/watchdog/dashboard.ts:~99-108`
- **Scenario:** Operator commands go to `supervisor/commands`, but the watchdog reads `<store>/operations`, created only by test fixtures. ENOENT yields `[]`, and `operations` is marked available.
- **Consequence:** A stuck `stop` or `rollout` never raises `operation-stalled`, while the dashboard implies coverage.
- **Fix:** Observe the real command queue, or report the signal as unavailable.
- **Regression:** Queue an aged command through the production CLI path; assert detection and correct signal coverage.

### 16. [P2] Native acceptance doesn't cover the lifecycle risks the architecture requires

- **Location:** `docs/ARCHITECTURE.md:31`; `tests/binary.ts:~153, ~459-487`
- **Evidence:** The architecture requires native tests for signals, process groups, leases, durability and recovery. The binary run disables the coordinator lane, sends no signal to the supervisor, exercises no timeout or group cleanup, and simulates only identity-less recovery. The "orphan detection" named in `STATUS` exists only as watchdog policy over recorded leader PIDs.
- **Consequence:** A green run gives no evidence about findings 3, 5, 6 or 7.
- **Fix and regression:** Add compiled tests with an enabled coordinator, SIGTERM drain, deadline kill, live-child restart refusal, and group cleanup. Narrow the `STATUS` wording until they exist.

## P3 findings

### 17. [P3] Hard-coded lane `A` in attention tracking

- **Location:** `src/engine/supervisor.ts:~512-513`
- **Scenario:** With coordinator `captain`, queued coordinator notices are ignored. A non-coordinator lane named `A` can raise false steering alerts.
- **Root cause:** A leftover project-specific lane name, against the core rule.
- **Fix:** Use `coordinatorOf(config)`.
- **Regression:** Custom-coordinator attention test.

### 18. [P3] Unknown token usage is shown as measured zero

- **Location:** `src/engine/harness.ts:~163-164`; `src/engine/supervisor.ts:~582-594`; `src/engine/dashboard/headless.ts:~170-172`
- **Scenario:** A run that emits no usage displays `0 input / 0 output`.
- **Root cause:** Violates "missing dimensions are unknown, not zero".
- **Fix:** Use nullable counters or per-field coverage.
- **Regression:** A no-usage run projects `null` and renders "unknown".

### 19. [P3] Scheduling freshness ignores the configured interval

- **Location:** `src/engine/scheduling.ts:~65-66, ~77`
- **Scenario:** With `intervalSeconds` of 46-60 (allowed up to 60), tasks repeatedly show `unknown` between checks.
- **Root cause:** Hard-coded 45-second staleness.
- **Fix:** Derive it from the loaded interval, as `projectHeadless` does.
- **Regression:** Interval 60 at 50 seconds remains fresh.

### 20. [P3] Supervisor state grows without bound and eventually blinds the watchdog

- **Location:** `src/engine/supervisor.ts:~384, ~589, ~613`; `src/engine/watchdog/runner.ts:~24, ~165`
- **Scenario:** Records are never pruned and each new record copies all historical message IDs. Past 2 MiB, `privateJson` returns null and the watchdog reports `supervisor-unknown`, then nudges the coordinator.
- **Fix:** Prune resolved records and store a compact high-water mark instead of `historical`.
- **Regression:** Large-history state stays under the read limit.

### 21. [P3] Stale queued controls replay into a later explicit `start`

- **Location:** `src/cli.ts:~207-212`; `src/engine/supervisor.ts:~396-428`; `src/engine/watchdog/runner.ts:~461-471`
- **Scenario:** A second `stop` issued after the final drain poll makes the next `start` exit immediately. Watchdog nudges written while the supervisor is dead accumulate and replay too.
- **Fix:** Bind commands to a supervisor generation, or expire or report them at startup.
- **Regression:** A stale stop doesn't cancel a new `start`.

### 22. [P3] SIGTERM doesn't wake the idle wait

- **Location:** `src/engine/supervisor.ts:~927-933`
- **Scenario:** An idle supervisor can take up to `intervalSeconds` to begin draining and may be force-killed by a service manager. `watch.ts:~292-301` already has the abortable pattern.
- **Fix:** Wake on abort.
- **Regression:** Abort during a 60-second interval returns promptly.

### 23. [P3] Atomic state writes aren't directory-durable

- **Location:** `src/io.ts`; `src/engine/supervisor.ts:~64-79`; `src/engine/agents.mjs:~43-59`; `src/engine/operational-traces.ts:~316-320`
- **Scenario:** Power loss can roll back a claim, message or state update after it was reported complete. Trace metadata also skips file flush. `evidence/store.ts:~156-161` shows the correct pattern.
- **Fix:** Share one helper that fsyncs the file and parent directory.
- **Regression:** Assert the fsync sequence through an injected filesystem seam.

### 24. [P3] `agents prompt` reads policy from the invocation directory, and the visual role is positional

- **Location:** `src/engine/agents.mjs:~366-373`; `src/engine/read-model.ts:~217-222`
- **Scenario:** From a repository subdirectory, a configured reviewer falls back to default policy and receives the implementation prompt. The second reviewer is always treated as visual.
- **Fix:** Use the discovered primary policy and an explicit role field.
- **Regression:** Prompt test from a subdirectory and a linked worktree.

### 25. [P3] Unpinned reviewer requests are still accepted in new stores

- **Location:** `src/engine/agents.mjs:~531-544`; `src/engine/orchestration.ts:~204-222`
- **Scenario:** `send --kind request --to inspector` without `--commit` runs as kind `control`, skipping pin validation. Legacy adoption is explicitly out of scope, so this compatibility path has no current need. The behaviour is deliberate and tested at `orchestration.test.ts:~266-270`.
- **Fix:** Require a pin for new reviewer requests, with any legacy path explicitly gated.
- **Regression:** Unpinned request rejected.

### 26. [P3] Git discovery trusts inherited repository environment

- **Location:** `src/project.ts:~77-82`; `src/engine/supervisor.ts:~49-55, ~675-679`
- **Scenario:** With an absolute `GIT_DIR` or `GIT_WORK_TREE` set, discovery and child commands can target a repository other than `--project`.
- **Fix:** Strip repository-selecting `GIT_*` variables before discovery and spawn.
- **Regression:** Discovery ignores a foreign `GIT_DIR`.

### 27. [P3] A crashed watchdog's lease has no safe recovery

- **Location:** `src/engine/watchdog/service.ts:~91-96`; `docs/USAGE.md:98`
- **Scenario:** After SIGKILL the lease directory remains forever, while the docs say never to delete leases to force startup.
- **Fix:** Add liveness-verified recovery like `acquire`, or a documented inspection command.
- **Regression:** Dead-owner recovery works; a live owner is refused.

### 28. [P3] Result-log pruning crosses lane boundaries

- **Location:** `src/engine/supervisor.ts:~624, ~877-881`
- **Scenario:** With lanes `impl` and `impl-1`, the `impl-` prefix also matches `impl-1-*` files, which sort first. Once `impl` has 40 results, each of its completions removes `impl-1`'s retained results, including an in-flight file.
- **Fix:** Use per-lane directories or an exact parsed lane match.
- **Regression:** Prefix-related lanes retain independent logs.

## Coverage and limitations

**Checked with no defect found:**

- Dashboard Host/Origin validation, CSP, GET-only API, and no HTML-injection sinks in dashboard scripts.
- Trace payload sanitization and strict evidence ID and route validation.
- Exclusive claims, cross-lane overlap checks at scope and assign, trailing-slash normalization.
- Ready-to-working frozen transitions, scheduler review pins, holds and hourly budgets.
- Supervisor lease recovery, config-reload restrictions, and watchdog notice-only behaviour.

**Observation:** the cross-harness guard in `harnessCommand` is inert at its production caller because `supervisor.ts:~604-607` assigns the identity first. I found no reachable failure, since session keys carry harness and epoch. Its unit test still doesn't prove that production path.

**Limitations:**

- Static review only. Bun's `close`, `detached` and signal behaviour was reasoned from the Node-compatible API and needs runtime confirmation with the regressions above.
- Hosted CI results and the test counts in `STATUS` were not verified.
- Embedded assets were compared by line count, not content. `build` regenerates them.
- `usage-ledger`, `evidence/capture`, `graph-builder`, `graph-renderer` and most of `dashboard.js` got import or pattern checks only, because the first two aren't wired into production paths and the others are presentation code.
- `agents.test`, `fair-scheduler.test` and the watchdog, trace and evidence tests were sampled rather than read in full.
- `docs/EXTRACTION.md`, `README` and `examples/` were not read. They weren't in the requested contract set.
