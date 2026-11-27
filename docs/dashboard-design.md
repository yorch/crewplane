# Dashboard design

The dashboard is a read-only operations cockpit for one Crewplane project. The redesign changes presentation, navigation and client-side state only. HTTP routes, the shared read model, polling endpoints and contracts are unchanged by the redesign itself (later hardening added a per-launch session header on `/api/*`; see docs/USAGE.md), and its views display data from `/api/snapshot` and `/api/runs`. The transport and read-only data routes added afterwards are described under Transport.

## Information architecture

Each destination is a separate view inside a responsive shell, addressed by URL hash.

| View           | Hash                                      | Purpose                                                                                                |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Overview       | `#/overview`                              | Clickable metrics, a prioritized attention list, health, task distribution, agent glance and shortcuts |
| Tasks          | `#/tasks?q&agent&phase&state&layout&task` | Board or list with search and filters; `task` opens the drill-down                                     |
| Agents         | `#/agents?q&status&agent`                 | Compact table, with full process, model, workspace, scheduling and usage facts in the detail pane      |
| Messages       | `#/messages?filter&q&agent&phase&thread`  | Open questions or all messages beside full thread context                                              |
| Runs           | `#/runs?lane&harness&task&run`            | Run history beside a sanitized event timeline, with follow, copy and older-run paging                  |
| Relationships  | `#/relationships?graph`                   | Communication and dependency diagram, node list, accessible relationship table and coverage metadata   |
| System & notes | `#/system`                                | Supervisor, budgets, watcher, watchdog, assignments without task cards and milestone notes             |

Primary facts sit in lists and tables. Secondary metadata moves to a detail pane or disclosure, so scanning a view does not require reading every field.

## Design choices

- **Calm cockpit.** A restrained dark sidebar, light workspace, crisp 1px borders and system fonts. No external fonts, images, CDNs or dependencies.
- **One badge vocabulary.** Tone plus text in every state; colour is never the only signal. Unknown data uses a dashed italic style, so it cannot be mistaken for a measured or healthy value.
- **Separate concerns stay separate.** Agents shows process and task progress in different columns. Configured and observed model and harness values are labelled line by line. An observed value that was never recorded reads "Not recorded". An agent named only in task data appears with no process record rather than with invented state.
- **Notices stay, in context.** Trace-safety text stays visible under the run timeline. Interpretation notes sit in "How to read…" disclosures or beside the relevant fact.
- **Inline SVG only.** Icons and the relationship diagram are inline SVG built from constant paths or `textContent`. The strict content security policy is unchanged: no inline style attributes or scripts.

## Usability changes

- Hash routing covers deep links, refresh, back and forward. Filter edits replace the history entry; opening a view or drill-down adds one.
- Sidebar links remember each view's filters but not its open item, so a section link returns to the list.
- Overview metrics and legends route to filtered views. Task, agent, thread and run links cross-navigate, and relationship selections open the matching view.
- Open questions link to their real thread, including the original question and replies.
- Snapshot updates (live or polled) re-render only the active view and preserves filters, focus, expanded disclosures, and window and pane scroll. Static filter controls are never rebuilt while typing.
- Connection state lives in the shell. A failed poll (or a stream error event) shows a banner that names the age of the retained snapshot, and data stays on screen.
- Above 1100px, details sit beside the list. Below that, the detail replaces the list with a Back link. Below 860px, the sidebar becomes a top bar with a menu button. The board scrolls horizontally inside its own labelled region, and phones default to the list layout.
- Accessibility: skip link, `aria-current`, focus moved to the view heading or detail heading on navigation, focus returned to the originating row on close, Escape closes panes and the mobile menu, visible focus, reduced-motion and forced-colors handling.
- Plain labels. Task states read To do, Assigned, In progress, Blocked, Awaiting review and Completed ("Accepted" appears only where an acceptance record exists, such as the task detail). The status filter offers "Blocked or awaiting review" for `state=attention`; filter values and URL parameters are unchanged, so existing links keep working.
- Exact times are text, not tooltips. In the dashboard, every `<time>` has a `datetime` attribute, the relative text and the exact value in a visually hidden span, so screen-reader users hear it; there is no `title` tooltip. Inside links (message rows) the exact span is `aria-hidden` to keep link names short, and the thread and detail panes carry the full value. On devices without hover (`hover: none`), the exact value is also shown as an extra visible line in cards, rows and detail fields. The run viewer emits `<time datetime>` elements whose text is the absolute formatted time, and the relationship table prints the formatted text without a `<time>` element. All of them use one formatter (`window.crewplane.formatTime`, defined in `app/time.js` and published by `dashboard.js`; the graph receives it through the `formatTime` option).
- Forced colors: selected cards, rows, run buttons, graph nodes, task-progress segments and the connection dot use `Highlight`/`CanvasText` outlines and borders instead of background or shadow cues.
- Touch: with `pointer: coarse`, buttons (including icon buttons), inputs, selects, the skip link, navigation, shortcuts and legend links are at least 44px tall. Other widths and layouts are unchanged.
- Viewport: full-height shells use `100vh` with a `100dvh` override where supported, and `scroll-padding-top` (tied to `--topbar-height`) keeps focused elements clear of the sticky mobile top bar.
- A task card shows its focus ring around the whole card (`:has(.card-link:focus-visible)`); browsers without `:has` keep the ring on the link text.
- The task-progress bar separates adjacent segments with a 1px divider and gives the neutral (To do) segment a visible border; the legend and `aria-label` still carry the counts.
- Runs: an automatically selected newest run is written to the URL with `replaceState` (no extra history entry), "Older runs" starts disabled until the first response, and a `run=` value that is not a well-formed run id shows "Unknown run id" in the timeline. A well-formed id that is not retained shows the "unavailable" message instead.
- Messages: the "show older messages" limit resets whenever the search, agent or phase filter changes. The Agent filter keeps the accessible name "Agent" and its help text ("Also shows messages sent to everyone") is attached with `aria-describedby`.
- Relationships: the live status line stays short ("12 nodes, 9 relationships"); coverage, truncation and missing-reference detail sits in a static paragraph linked from the filter input with `aria-describedby`.

## Transport

Snapshots reach the page by one of two transports, and the page always works with the weaker one.

- **Live (preferred).** `app/live.js` reads `GET /api/events` with `fetch()` and a `ReadableStream` (`EventSource` cannot send the `x-crewplane-session` header; the token never goes in a URL). `app/live-core.js` holds the pure parts, an incremental `text/event-stream` parser and the backoff function, which are unit tested. Events: `snapshot` (the `/api/snapshot` body, sent when its content hash changes), `error` (the same safe message `/api/snapshot` returns with 503; the stream stays open) and `ping` (a heartbeat every 15 seconds that also refreshes the "Checked" time). A stream silent for 45 seconds, any non-200 or non-`text/event-stream` answer, a malformed event or a network failure ends it.
- **Polling (fallback).** The unchanged 5-second `/api/snapshot` poll. It runs whenever `store.mode` is not `live`, starts at once when a live stream drops, and the retained-snapshot banner, "Disconnected" status and "Retrying every 5s" text are exactly as before. Reconnection to the stream uses exponential backoff from 1s capped at 60s with +-25% jitter, reset by the first event of a connection. A refused ninth stream (`503`) simply stays on polling.
- **Server.** One shared computation (`dashboard/live.ts`), run sequentially about every second only while a client is connected and hashed without `updatedAt`, fans out to at most 8 clients. Event ids are `<boot>-<n>`; `Last-Event-ID` avoids re-sending an unchanged snapshot after a reconnect. A client that is behind gets only the latest event; one whose socket buffer passes 4 MiB or stays blocked for 10 seconds is closed. Closing the server destroys every stream and clears every timer.
- **Indicator.** `#connection` keeps "Live" / "Disconnected"; `#connection-time` reads "Checked 10:00:01 · live updates" or "Checked 10:00:01 · polling", and `#connection-wrap` carries `data-mode="live|polling"`.

The data routes `/api/config`, `/api/control-log`, `/api/usage` and the evidence list and artifact-metadata routes exist for later views (setup and configuration, control audit, usage, evidence gallery); this phase adds no view for them. All are authenticated `GET` projections; see docs/CONTRACTS.md. An evidence gallery has to fetch artifacts with the session header and show them from `blob:` URLs, which needs `img-src` and `media-src` to admit `blob:` in the page CSP: a deliberate, separate decision.

## Safe client state

Hash values are parsed with `URLSearchParams`, restricted to a per-view allowlist, checked against enumerations where applicable, and length-limited. Unknown views fall back to Overview. Untrusted text is rendered only through `textContent`; the dashboard does not use `innerHTML`. `localStorage` holds only the board/list preference. `sessionStorage` holds, besides the per-launch session, one small reload record (see Reload persistence). Both are validated on read and optional.

## Reload persistence

A full page reload (or history traversal back to the page) restores, once, after the first snapshot has been rendered and the relationship graph (a separate module that draws on the `crewplane-graphs` event) has drawn, so the page has its final height: the window scroll position of each view, the scroll offsets of marked panes (the task board and detail panes) and the open or closed state of the static "How to read…" disclosures. `app/reload-state.js` saves the record to `sessionStorage` under `crewplane-ui-state` on `pagehide` and when the tab is hidden; `app/persist.js` rebuilds it on read from an allowlist (known views, bounded numbers and key shapes, bounded counts), so a corrupt or hostile value is ignored (pane offsets are kept in a null-prototype object, so a stored `__proto__` key is plain data). Restored: scroll of the current view (Relationships included, for both the communication and task-dependency graphs), pane offsets only when the saved view is the current view, and open disclosures. Not restored: scroll inside the graph canvas itself, text selection, focus, and the state of disclosures that are not static "How to read…" notes. It is per tab, optional (blocked storage changes nothing), and not used after a fresh navigation, which starts at the top with disclosures closed.

## Module layout

`index.html` loads `dashboard.js` as `<script type="module">`, so the page needs no inline script and the content security policy (`script-src 'self'`) is unchanged. `dashboard.js` is only the entry: it wires the modules below and starts polling. Modules live in `app/` and import each other with relative specifiers; there are no import cycles. Lower layers reach the renderer through late-bound hooks in `store.js` (`render`, `commitSnapshot`, and `afterGraphs`, which runs after the graph event and performs the one-time reload restore) instead of importing it.

| Layer         | Modules                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| State         | `store.js` (shared state, hooks, media queries), `config.js` (routes and allowlists), `labels.js` (labels and tones)       |
| Routing       | `route.js` (pure hash parsing, `hrefFor`, scroll keys), `router.js` (history, filter memory, nav links)                    |
| Data          | `api.js` (session token, authenticated fetch, polling, retained-snapshot banner), `live.js`, `live-core.js` (event stream) |
| DOM helpers   | `dom.js`, `badges.js`, `time.js` (formatter and relative times), `links.js`                                                |
| Rendering     | `render.js` (view dispatch and nav counts), `ui-state.js` (focus, disclosure and scroll capture across polls)              |
| Views         | `overview.js`, `tasks.js`, `agents.js`, `messages.js`, `relationships.js`, `system.js`                                     |
| Shell         | `shell.js` (view switch, mobile menu, focus and scroll placement, Escape), `filters.js` (controls and clear buttons)       |
| Reload memory | `persist.js` (pure, unit tested), `reload-state.js` (DOM glue)                                                             |

The Runs view (`run-viewer.js`) and the relationship diagram (`graph-viewer.js`, `graph-renderer.js`) remain separate scripts that talk to the shell through `window.crewplane`, `window.crewplaneFetch` and the `crewplane-route` and `crewplane-graphs` events, which are unchanged.

## Embedding

`scripts/embed.ts` scans `src/engine/dashboard` recursively for `.html`, `.js` and `.css` files (never `*.test.*` or server-side TypeScript such as `graph-builder.ts`), sorts the names, copies each to `src/engine/assets/<name>.txt` and writes `src/engine/assets.ts` (a generated file, excluded from Biome). The assets directory is rebuilt from scratch on every run, so removed files do not linger. Adding a module is just adding a file. The server routes `/` to `index.html` and `/<name>` to each embedded name (plus `/runs.js` for the run viewer) by exact match against that set, with the content type taken from the extension (`text/javascript` for modules) and `nosniff` kept; every other path, including traversal attempts and query strings, is a 404. Tests check that the embedded set equals the directory scan, that every import specifier in an embedded script resolves to an embedded file, and that the server serves or refuses paths accordingly. CI reruns the embed script and fails if `git status --porcelain` shows anything under `src/engine/assets` or `assets.ts`: stale or hand-edited copies (modified), copies never committed for a new source (untracked), missing copies, and orphan copies whose source is gone (deleted by the rebuild).

## Limitations

- The dashboard remains read-only: there are no execution, reply or control actions.
- Browser reload restores the view, filters and open item, plus scroll and the "How to read…" disclosures (see Reload persistence). Other disclosures, such as the task card text, are preserved across polls but start closed after a full page load. The run timeline loads after the first render, so its scroll position after a reload is best effort.
- Run timelines keep the latest 500 events client-side, and tailing fetches 100 events per poll.
- The all-messages list renders 100 rows at a time, with a button to show more.
- The relationship diagram is an aid, bounded by the same 50-node and 100-edge graph limits. Missing references appear only in the table. Keyboard and screen-reader users use the node list and table.
- Evidence artifacts served by `/api/evidence` are not surfaced in this redesign.
- Usage figures are retained counters, not billing totals. Coverage stays limited to what the read model supplies.

## Verification

The interface was implemented with explicitly requested Claude CLI 2.1.319 and exact claude-opus-5-5; sanitized provenance is in dashboard-opus.receipt.json. The coordinator rebuilt embedded assets, corrected semantic filter groups and CSS ordering, then inspected screenshots of the compiled executable using an isolated synthetic busy project. All seven views were checked at 1440, 1024, 390 and 320 pixels with no document overflow, page errors or CSP errors. The browser suite checks navigation, filters, drill-down, model labels, polling and safe text rendering. A separate delayed-response run test covers three-page history and unique incremental timeline events; pagination intent is queued when a poll is already in flight. No live provider or project supervisor was started.

Final verification: 324 tests across 33 files, Biome, strict TypeScript, compiled build and standalone/native acceptance passed locally. [Ubuntu/macOS CI at 975f07a](https://github.com/yorch/crewplane/actions/runs/42522166856) passed the same gate and uploaded executable/checksum artifacts.
