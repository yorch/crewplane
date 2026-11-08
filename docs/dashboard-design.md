# Dashboard design

The dashboard is a read-only operations cockpit for one Crewplane project. The redesign changes presentation, navigation and client-side state only. HTTP routes, the shared read model, polling endpoints and contracts are unchanged, and all displayed data comes from the existing `/api/snapshot` and `/api/runs` responses.

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
- Polling re-renders only the active view and preserves filters, focus, expanded disclosures, and window and pane scroll. Static filter controls are never rebuilt while typing.
- Connection state lives in the shell. A failed poll shows a banner that names the age of the retained snapshot, and data stays on screen.
- Above 1100px, details sit beside the list. Below that, the detail replaces the list with a Back link. Below 860px, the sidebar becomes a top bar with a menu button. The board scrolls horizontally inside its own labelled region, and phones default to the list layout.
- Accessibility: skip link, `aria-current`, focus moved to the view heading or detail heading on navigation, focus returned to the originating row on close, Escape closes panes and the mobile menu, visible focus, reduced-motion and forced-colors handling.

## Safe client state

Hash values are parsed with `URLSearchParams`, restricted to a per-view allowlist, checked against enumerations where applicable, and length-limited. Unknown views fall back to Overview. Untrusted text is rendered only through `textContent`; the dashboard does not use `innerHTML`. `localStorage` holds only the board/list preference, is validated on read and is optional.

## Limitations

- The dashboard remains read-only: there are no execution, reply or control actions.
- Browser reload restores the view, filters and open item, but not pixel scroll or expanded disclosures. Those are preserved across polls, not across a full page load.
- Run timelines keep the latest 500 events client-side, and tailing fetches 100 events per poll.
- The all-messages list renders 100 rows at a time, with a button to show more.
- The relationship diagram is an aid, bounded by the same 50-node and 100-edge graph limits. Missing references appear only in the table. Keyboard and screen-reader users use the node list and table.
- Evidence artifacts served by `/api/evidence` are not surfaced in this redesign.
- Usage figures are retained counters, not billing totals. Coverage stays limited to what the read model supplies.

## Verification

The interface was implemented with explicitly requested Claude CLI 2.1.319 and exact claude-opus-5-5; sanitized provenance is in dashboard-opus.receipt.json. The coordinator rebuilt embedded assets, corrected semantic filter groups and CSS ordering, then inspected screenshots of the compiled executable using an isolated synthetic busy project. All seven views were checked at 1440, 1024, 390 and 320 pixels with no document overflow, page errors or CSP errors. The browser suite checks navigation, filters, drill-down, model labels, polling and safe text rendering. A separate delayed-response run test covers three-page history and unique incremental timeline events; pagination intent is queued when a poll is already in flight. No live provider or project supervisor was started.

Final verification: 324 tests across 33 files, Biome, strict TypeScript, compiled build and standalone/native acceptance passed locally. [Ubuntu/macOS CI at 975f07a](https://github.com/yorch/crewplane/actions/runs/42522166856) passed the same gate and uploaded executable/checksum artifacts.
