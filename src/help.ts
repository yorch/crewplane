/**
 * Operator-facing command grammar. The control forms printed here are normative:
 * `help.test.ts` asserts every one of them is accepted by `control()`.
 */
export const help = `Crewplane — local orchestration for coding agents

Usage: crewplane [--project PATH] COMMAND
  init                         Create project policy and private file store
  pin --confirm true           Point the project's version pin at this release
  doctor                       Check project and configured harness prerequisites
  configure --file PATH        Validate and install an explicit supervisor config
  agents COMMAND [OPTIONS]     Assign/scope/claim/status/send/inbox/accept/release
  task list                    Show durable tasks and messages
  agent list                   Show configured agents and observed process state
  start                        Run the supervisor in the foreground
  status                       Show persisted supervisor state (never starts it)
  pause|resume --lane ID       Hold/release one lane without stopping it
  pause|resume --all true      Hold/release every lane without stopping
  nudge --lane ID --text TEXT  Prompt a lane without starting a new run
  retry --lane ID [--text TEXT]
                               Requeue one lane after a failure pause
  retry --lane ID --confirm-cleanup true --text NOTE
                               Acknowledge inspected unverified descendants
  retry --lane ID --task ID --new-session true --text NOTE
                               Start a fresh native session for one task
  resolve --lane ID [--task ID] --pause UUID (--approve true|--deny true) --text NOTE
                               Record an operator decision for a decision pause
  cancel --lane ID --run RUN   Terminate one live run
  cancel --all true            Terminate every live run
  stop [--cancel-active true]  Request intentional stop and drain
  rollout                      Request an authorized drain; no automatic restart
  dashboard [--port PORT]      Serve read-only dashboard on loopback (default 4310)
  evidence list|create|append|manifest  Manage bounded screenshot/video artifacts
  monitor [--once|--status]     Observe task progress and unanswered messages
  watchdog start|once|status    Independent notice-only health observer
  update [--check] [--force]   Replace this release binary with the latest one
  --help | --version

Control verbs also accept --wait N (1-60) to await the supervisor outcome, and
--expect-rev N, --expect-run RUN or --expect-session ID to pin the observed
state a widening verb must match. Boolean flags take an explicit true; the
forms above are the accepted grammar, not shorthand.

Git and configured harnesses are external dependencies. No automatic merge,
provider login, budget increase, legacy-state adoption or service activation.

Release builds check for updates at most once a day and replace themselves
only after SHA-256 and executable verification; the new version runs on the
next invocation. Automatic updates never run during long-lived commands or
while any supervisor is live. Disable with CREWPLANE_NO_AUTO_UPDATE=1 or
CREWPLANE_UPDATE=off; see docs/USAGE.md for the remaining update settings.
`;
