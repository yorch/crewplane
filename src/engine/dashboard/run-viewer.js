import {
  comparable,
  compareRuns,
  downloadName,
  eventMatches,
  firstErrorIndex,
  formatSpan,
  kindCounts,
  MAX_EVENTS,
  toJson,
} from "./app/run-core.js";

(() => {
  const get = (id) => document.getElementById(id);
  const SESSION_MESSAGE =
    "Session missing or expired. Reopen the URL printed by crewplane dashboard.";
  const RUN_ID =
    /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const statusTones = {
    running: "info",
    succeeded: "success",
    finished: "neutral",
    paused: "warning",
    failed: "danger",
  };
  let selected = null;
  let cursor = 0;
  let before = null;
  let olderLoaded = false;
  let events = [];
  let busy = false;
  let pending = false;
  let pendingOlder = false;
  let generation = 0;
  let tailing = -1;
  let viewActive = false;
  let filterKey = null;
  let urlRun = null;
  const buttons = new Map();
  const runs = new Map();
  // Timeline tools: type chips, text search, the run header for exports and
  // the second run for a comparison. All of it works on loaded events only.
  const activeKinds = new Set();
  const chips = new Map();
  let meta = null;
  let query = "";
  let other = null;
  let otherToken = 0;

  const setText = (id, text) => {
    const node = get(id);
    if (node.textContent !== text) node.textContent = text;
  };
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const badge = (text, tone) => {
    const node = make("span", undefined, `badge tone-${tone}`);
    node.append(make("span", undefined, "badge-dot"), make("span", text));
    return node;
  };
  const anchor = (view, params, text, className) => {
    const node = make("a", text, className);
    node.href = window.crewplane.hrefFor(view, params);
    return node;
  };
  // One shared formatter (app/time.js, exposed as window.crewplane.formatTime) so every view prints the same text.
  const stamp = (value) => window.crewplane.formatTime(value);
  const timeNode = (value) => {
    const node = make("time", stamp(value), "time");
    const at = new Date(value);
    if (Number.isFinite(at.getTime())) node.dateTime = at.toISOString();
    return node;
  };
  const timelinePlaceholder = (text) => {
    get("run-events").replaceChildren(make("li", text, "timeline-empty"));
  };
  function copyLine(e) {
    return `${e.at} #${e.sequence} [${e.channel}] ${e.kind}${e.tool ? ` · ${e.tool}` : ""}${e.status ? ` · ${e.status}` : ""} · ${e.message}${e.model ? ` · model ${e.model}` : ""}${e.effort ? ` · effort ${e.effort}` : ""}${e.inputTokens !== null ? ` · input ${e.inputTokens}` : ""}${e.outputTokens !== null ? ` · output ${e.outputTokens}` : ""}`;
  }
  function eventRow(e) {
    const row = make("li", undefined, `timeline-row kind-${e.kind}`);
    row.dataset.sequence = String(e.sequence);
    row.dataset.kind = e.kind;
    const head = make("div", undefined, "timeline-head");
    const time = timeNode(e.at);
    head.append(
      make("span", `#${e.sequence}`, "mono timeline-seq"),
      make("span", e.kind, "timeline-kind"),
      make("span", e.channel, "timeline-channel"),
      time,
    );
    const details = [];
    if (e.tool) details.push(e.tool);
    if (e.status) details.push(e.status);
    if (e.model) details.push(`model ${e.model}`);
    if (e.effort) details.push(`effort ${e.effort}`);
    if (e.inputTokens !== null) details.push(`input ${e.inputTokens}`);
    if (e.outputTokens !== null) details.push(`output ${e.outputTokens}`);
    if (e.durationMs !== null && e.durationMs !== undefined)
      details.push(`${e.durationMs} ms`);
    row.append(head, make("p", e.message, "timeline-message"));
    if (details.length)
      row.append(make("p", details.join(" · "), "timeline-details"));
    return row;
  }
  function renderSummary(meta, incomplete) {
    const summary = get("run-summary");
    // Rebuild links only on change so polling never drops keyboard focus.
    const signature = JSON.stringify([
      meta.runId,
      meta.status,
      meta.finalState,
    ]);
    if (summary.dataset.signature !== signature) {
      const tags = make("div", undefined, "detail-tags");
      tags.append(
        anchor("agents", { agent: meta.lane }, meta.lane),
        meta.task
          ? anchor("tasks", { task: meta.task }, meta.task, "mono")
          : make("span", "coordination", "mono"),
        make("span", meta.harness, "badge tone-neutral"),
        badge(meta.status, statusTones[meta.status] ?? "unknown"),
        make("span", `final ${meta.finalState ?? "not recorded"}`, "count"),
      );
      // Evidence captured for this run's task (filtered gallery, with a count).
      const evidence = meta.task
        ? window.crewplane.evidenceLink?.(meta.task, "Task evidence")
        : null;
      if (evidence) tags.append(evidence);
      summary.replaceChildren(tags);
      summary.dataset.signature = signature;
      // The operator-controls layer (when enabled) offers actions per run.
      window.dispatchEvent(
        new CustomEvent("crewplane-run-selected", {
          detail: { lane: meta.lane, runId: meta.runId },
        }),
      );
    }
    let text = `${meta.runId} · ${meta.events} retained events`;
    if (meta.truncated) text += " · TRUNCATED at storage cap";
    if (meta.events > MAX_EVENTS) text += ` · showing the latest ${MAX_EVENTS}`;
    text += ". Payloads filtered; retention may remove older runs.";
    if (incomplete) text += " Partial or malformed records omitted.";
    setText("run-note", text);
  }
  function appendEvents(fresh) {
    const list = get("run-events");
    if (!fresh.length) return;
    const position = list.scrollTop;
    if (list.querySelector(".timeline-empty")) list.replaceChildren();
    list.append(...fresh.map(eventRow));
    while (list.children.length > MAX_EVENTS) list.firstElementChild.remove();
    list.scrollTop = get("run-follow").checked ? list.scrollHeight : position;
  }
  const text = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
  };
  // Hide rows that do not pass the chips and the search; the rows themselves
  // are the loaded events (at most 500), so this stays cheap.
  function applyFilter() {
    const list = get("run-events");
    const bySequence = new Map(events.map((event) => [event.sequence, event]));
    let shown = 0;
    for (const row of list.children) {
      const event = bySequence.get(Number(row.dataset.sequence));
      if (!event) continue;
      const visible = eventMatches(event, activeKinds, query);
      row.hidden = !visible;
      if (visible) shown++;
    }
    const filtering = activeKinds.size > 0 || query.trim() !== "";
    text(
      get("run-filter-status"),
      !events.length
        ? ""
        : filtering
          ? shown
            ? `Showing ${shown} of ${events.length} loaded events`
            : "No loaded events match this filter."
          : `${events.length} loaded events`,
    );
  }
  const visibleEvents = () =>
    events.filter((event) => eventMatches(event, activeKinds, query));
  function syncChips() {
    const container = get("run-kinds");
    const counts = kindCounts(events);
    for (const [kind, count] of counts) {
      let chip = chips.get(kind);
      if (!chip) {
        chip = make("button", undefined, "chip");
        chip.type = "button";
        chip.dataset.kind = kind;
        chip.append(make("span", kind), make("span", "", "chip-count"));
        chip.addEventListener("click", () => {
          if (activeKinds.has(kind)) activeKinds.delete(kind);
          else activeKinds.add(kind);
          chip.setAttribute("aria-pressed", String(activeKinds.has(kind)));
          applyFilter();
        });
        chip.setAttribute("aria-pressed", String(activeKinds.has(kind)));
        chips.set(kind, chip);
      }
      text(chip.lastElementChild, String(count));
    }
    // Chips follow the canonical order; add or move only what changed.
    counts.forEach(([kind], index) => {
      const chip = chips.get(kind);
      if (container.children[index] !== chip)
        container.insertBefore(chip, container.children[index] ?? null);
    });
  }
  function syncTools() {
    const has = events.length > 0;
    get("run-search").disabled = !has;
    get("run-copy-json").disabled = !has;
    get("run-download-json").disabled = !has;
    get("run-first-error").disabled = firstErrorIndex(events) === -1;
    get("run-compare-toggle").disabled = !selected || !meta;
    syncChips();
    applyFilter();
    if (!get("run-compare").hidden) renderCompare();
  }
  function jumpToFirstError() {
    const index = firstErrorIndex(events);
    if (index === -1) return;
    const target = events[index];
    // A filter that hides the error would make the jump land nowhere.
    if (!eventMatches(target, activeKinds, query)) {
      activeKinds.clear();
      for (const chip of chips.values())
        chip.setAttribute("aria-pressed", "false");
      get("run-search").value = "";
      query = "";
      applyFilter();
    }
    get("run-follow").checked = false;
    const row = get("run-events").querySelector(
      `[data-sequence="${target.sequence}"]`,
    );
    if (!row) return;
    for (const old of get("run-events").querySelectorAll(".is-target"))
      old.classList.remove("is-target");
    row.classList.add("is-target");
    row.tabIndex = -1;
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
    text(get("run-filter-status"), `Jumped to event #${target.sequence}`);
  }
  async function copyJson() {
    const shown = visibleEvents();
    const filter =
      activeKinds.size || query.trim() ? { kinds: activeKinds, query } : null;
    try {
      await navigator.clipboard.writeText(toJson(meta, shown, filter));
      text(get("run-filter-status"), `Copied ${shown.length} events as JSON`);
    } catch {
      text(get("run-filter-status"), "Copy unavailable; use Download JSON");
    }
  }
  function downloadJson() {
    const shown = visibleEvents();
    const filter =
      activeKinds.size || query.trim() ? { kinds: activeKinds, query } : null;
    const blob = new Blob([toJson(meta, shown, filter)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = make("a");
    anchor.href = url;
    anchor.download = downloadName(meta?.runId);
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    text(get("run-filter-status"), `Downloaded ${shown.length} events as JSON`);
  }

  // Comparison of the selected run with another one of the same task or agent.
  function closeCompare(restoreFocus) {
    other = null;
    otherToken++;
    get("run-compare").hidden = true;
    get("run-compare-toggle").setAttribute("aria-expanded", "false");
    get("run-compare-body").replaceChildren();
    text(get("run-compare-status"), "");
    if (restoreFocus) get("run-compare-toggle").focus();
  }
  function fillCompareChoices() {
    const select = get("run-compare-select");
    const current = runs.get(selected) ?? meta;
    const choices = comparable(current, [...runs.values()]);
    select.replaceChildren(new Option("Choose a run…", ""));
    for (const run of choices)
      select.add(
        new Option(
          `${run.lane} · ${run.task ?? "coordination"} · ${run.status} · ${stamp(run.startedAt)}`,
          run.runId,
        ),
      );
    text(
      get("run-compare-status"),
      choices.length
        ? "Choose another run. Only events the page can load are compared (at most 500 per run)."
        : "No other loaded run shares this task or agent. Use Older runs to load more.",
    );
  }
  async function loadOther(id) {
    const token = ++otherToken;
    other = null;
    get("run-compare-body").replaceChildren();
    if (!RUN_ID.test(id)) return;
    text(get("run-compare-status"), "Loading the other run…");
    const loaded = [];
    let after = 0;
    try {
      for (let page = 0; page < MAX_EVENTS / 100; page++) {
        const response = await window.crewplaneFetch(
          `/api/runs/${encodeURIComponent(id)}?after=${after}&limit=100`,
          { cache: "no-store", signal: AbortSignal.timeout(10000) },
        );
        if (!response.ok) throw Error("The other run is not available.");
        const value = await response.json();
        if (token !== otherToken) return;
        loaded.push(...value.events);
        if (!value.events.length || value.nextCursor === after) break;
        after = value.nextCursor;
      }
    } catch (error) {
      if (token === otherToken) text(get("run-compare-status"), error.message);
      return;
    }
    other = { id, events: loaded.slice(-MAX_EVENTS) };
    renderCompare();
  }
  const cell = (tag, value, className) => make(tag, String(value), className);
  function table(caption, heads, rows) {
    const node = make("table", undefined, "compare-table");
    node.append(make("caption", caption));
    const head = make("tr");
    for (const title of heads) {
      const th = make("th", title, "compare-cell");
      th.scope = "col";
      head.append(th);
    }
    const thead = make("thead");
    thead.append(head);
    node.append(thead);
    const body = make("tbody");
    for (const row of rows) {
      const tr = make("tr");
      if (!Array.isArray(row) && row.className) tr.className = row.className;
      (Array.isArray(row) ? row : row.cells).forEach((value, index) => {
        const td =
          index === 0
            ? make("th", String(value), "compare-cell")
            : cell("td", value, "compare-cell");
        if (index === 0) td.scope = "row";
        tr.append(td);
      });
      body.append(tr);
    }
    node.append(body);
    const scroller = make("div", undefined, "compare-scroll");
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", caption);
    scroller.append(node);
    return scroller;
  }
  function renderCompare() {
    if (!other) return;
    const result = compareRuns(events, other.events);
    const { a, b } = result.total;
    const sign = (value) => (value > 0 ? `+${value}` : String(value));
    const body = get("run-compare-body");
    const thisId = meta?.runId ?? "selected run";
    const summary = table(
      "Totals",
      ["Measure", "This run", "Other run", "Difference"],
      [
        ["Events", a.events, b.events, sign(b.events - a.events)],
        ["Errors", a.errors, b.errors, sign(b.errors - a.errors)],
        [
          "Time from first to last event",
          formatSpan(a.spanMs),
          formatSpan(b.spanMs),
          a.spanMs === null || b.spanMs === null
            ? "not recorded"
            : formatSpan(b.spanMs - a.spanMs),
        ],
        [
          "Tool time reported",
          formatSpan(a.toolMs),
          formatSpan(b.toolMs),
          formatSpan(b.toolMs - a.toolMs),
        ],
        [
          "Input tokens",
          a.inputTokens,
          b.inputTokens,
          sign(b.inputTokens - a.inputTokens),
        ],
        [
          "Output tokens",
          a.outputTokens,
          b.outputTokens,
          sign(b.outputTokens - a.outputTokens),
        ],
      ],
    );
    const kinds = table(
      "Events by type",
      ["Type", "This run", "Other run", "Difference"],
      result.byKind.map((row) => ({
        cells: [row.kind, row.a, row.b, sign(row.diff)],
        className: row.diff ? "is-different" : "",
      })),
    );
    const aligned = table(
      "Events side by side, by position",
      ["Position", "This run", "Other run", "Same type"],
      result.rows.map((row) => ({
        cells: [
          row.index + 1,
          row.a || "(none)",
          row.b || "(none)",
          row.same ? "yes" : "no",
        ],
        className: row.same ? "" : "is-different",
      })),
    );
    const first = make(
      "p",
      result.firstDifference === -1
        ? "The two runs have the same event types in the same order."
        : `The runs first differ at position ${result.firstDifference + 1}.`,
      "note",
    );
    body.replaceChildren(first, summary, kinds, aligned);
    text(
      get("run-compare-status"),
      `Comparing ${thisId} with ${other.id}: ${a.events} and ${b.events} loaded events.`,
    );
  }
  async function tail() {
    if (!selected || tailing === generation) return;
    const run = generation;
    const id = selected;
    tailing = run;
    try {
      const response = await window.crewplaneFetch(
        `/api/runs/${encodeURIComponent(id)}?after=${cursor}&limit=100`,
        { cache: "no-store", signal: AbortSignal.timeout(10000) },
      );
      if (response.status === 401) throw Error(SESSION_MESSAGE);
      if (!response.ok)
        throw Error("Selected run unavailable or no longer retained");
      const value = await response.json();
      if (run !== generation) return;
      events.push(...value.events);
      events = events.slice(-MAX_EVENTS);
      cursor = value.nextCursor;
      appendEvents(value.events);
      meta = value.meta;
      renderSummary(value.meta, value.incomplete);
      syncTools();
      if (!events.length)
        timelinePlaceholder("No events retained for this run.");
    } catch (error) {
      if (run === generation && !events.length)
        timelinePlaceholder(error.message);
      throw error;
    } finally {
      if (tailing === run) tailing = -1;
    }
  }
  function runRow(run) {
    const button = make("button", undefined, "run-row");
    button.type = "button";
    button.dataset.runId = run.runId;
    const title = make("span", undefined, "run-row-title");
    title.append(
      make("span", run.lane, "run-row-lane"),
      make("span", run.task ?? "coordination", "mono"),
    );
    const meta = make("span", undefined, "run-row-meta");
    meta.append(
      badge(run.status, statusTones[run.status] ?? "unknown"),
      make("span", run.harness),
      timeNode(run.startedAt),
    );
    button.append(title, meta);
    button.addEventListener("click", () => {
      const nav = window.crewplane;
      nav.navigate(
        nav.hrefFor("runs", { ...nav.route.params, run: run.runId }),
      );
    });
    return button;
  }
  function renderHistory() {
    const history = get("run-history");
    const ordered = [...runs.values()].sort((a, b) =>
      a.runId < b.runId ? 1 : -1,
    );
    if (!ordered.length) {
      if (!history.querySelector(".empty-state")) {
        const empty = make("div", undefined, "empty-state");
        const filtered = filterKey !== JSON.stringify(["", "", ""]);
        empty.append(
          make(
            "p",
            filtered ? "No runs match these filters." : "No runs recorded yet.",
            "empty-title",
          ),
        );
        history.replaceChildren(empty);
      }
      return;
    }
    history.querySelector(".empty-state")?.remove();
    ordered.forEach((run, index) => {
      let button = buttons.get(run.runId);
      if (!button) {
        button = runRow(run);
        buttons.set(run.runId, button);
      } else {
        const status = button.querySelector(".badge");
        status.className = `badge tone-${statusTones[run.status] ?? "unknown"}`;
        status.lastElementChild.textContent = run.status;
      }
      button.setAttribute("aria-pressed", String(selected === run.runId));
      if (history.children[index] !== button)
        history.insertBefore(button, history.children[index] ?? null);
    });
  }
  function resetTimeline() {
    generation++;
    cursor = 0;
    events = [];
    meta = null;
    tailing = -1;
    activeKinds.clear();
    chips.clear();
    get("run-kinds").replaceChildren();
    get("run-search").value = "";
    query = "";
    closeCompare(false);
    syncTools();
    get("run-summary").replaceChildren();
    get("run-summary").removeAttribute("data-signature");
    window.dispatchEvent(
      new CustomEvent("crewplane-run-selected", { detail: null }),
    );
    setText("run-note", "");
    timelinePlaceholder("Select a run to see its timeline.");
  }
  function resetList() {
    pendingOlder = false;
    selected = null;
    before = null;
    olderLoaded = false;
    buttons.clear();
    runs.clear();
    get("run-history").replaceChildren();
    resetTimeline();
  }
  function selectRun(id) {
    selected = id;
    resetTimeline();
    timelinePlaceholder("Loading run events…");
    renderHistory();
  }
  async function refresh(older = false) {
    if (busy) {
      pending = true;
      pendingOlder ||= older;
      return;
    }
    busy = true;
    pending = false;
    const startKey = filterKey;
    try {
      const query = new URLSearchParams({ limit: "20" });
      for (const [id, key] of [
        ["run-lane", "lane"],
        ["run-harness", "harness"],
        ["run-task", "task"],
      ])
        if (get(id).value) query.set(key, get(id).value);
      if (older && before) query.set("before", before);
      const response = await window.crewplaneFetch(`/api/runs?${query}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401) throw Error(SESSION_MESSAGE);
      if (!response.ok) throw Error("Run history unavailable; check filters");
      const value = await response.json();
      if (startKey !== filterKey) return;
      if (older || !olderLoaded) before = value.nextCursor;
      if (older) olderLoaded = true;
      get("run-more").disabled = !before;
      setText("run-more", before ? "Older runs" : "No older runs");
      for (const run of value.runs) runs.set(run.runId, run);
      if (viewActive && !selected && !urlRun && value.runs[0]) {
        const newest = value.runs[0].runId;
        selectRun(newest);
        // Reflect the automatic choice in the URL without a history entry,
        // but never while a navigation to another view is pending: the URL
        // already names that view and the hashchange event has not run yet,
        // so rewriting it would bounce the user back to Runs.
        if (window.location.hash.startsWith("#/runs")) {
          // urlRun is set first so the resulting route event is not a change.
          urlRun = newest;
          window.crewplane.setParams({ run: newest });
        }
      }
      renderHistory();
      let status = runs.size
        ? "Incremental private metadata"
        : "No normalized runs recorded yet";
      if (value.incomplete || value.retentionLimited)
        status += " · limited/retained history";
      setText("runs-status", status);
      if (!runs.size && !selected && !urlRun) {
        setText(
          "run-note",
          "The previous supervisor has no retroactive normalized history. New collection starts after safe native reload.",
        );
        timelinePlaceholder("No runs to show yet.");
      }
      await tail();
    } catch (error) {
      setText("runs-status", error.message);
    } finally {
      busy = false;
      if (pending) {
        const olderRequested = pendingOlder;
        pendingOlder = false;
        refresh(olderRequested);
      }
    }
  }
  function setControl(id, value) {
    const control = get(id);
    if (
      control.tagName === "SELECT" &&
      value &&
      ![...control.options].some((option) => option.value === value)
    )
      control.add(new Option(value, value));
    if (control.value !== value) control.value = value;
  }
  function syncRoute(route) {
    const wasActive = viewActive;
    viewActive = route.view === "runs";
    if (!viewActive) return;
    const { lane = "", harness = "", task = "", run = null } = route.params;
    setControl("run-lane", lane);
    setControl("run-harness", harness);
    setControl("run-task", task);
    const key = JSON.stringify([lane, harness, task]);
    const filtersChanged = key !== filterKey;
    const runChanged = run !== urlRun;
    if (filtersChanged) {
      filterKey = key;
      resetList();
    }
    if (filtersChanged || runChanged) {
      urlRun = run;
      if (run && RUN_ID.test(run)) selectRun(run);
      else if (runChanged) {
        selected = null;
        resetTimeline();
        if (run) timelinePlaceholder("Unknown run id");
        renderHistory();
      }
    }
    if (filtersChanged || runChanged || !wasActive) refresh();
  }
  for (const [id, key] of [
    ["run-lane", "lane"],
    ["run-harness", "harness"],
    ["run-task", "task"],
  ])
    get(id).addEventListener("change", () => {
      window.crewplane.setParams({ [key]: get(id).value, run: undefined });
    });
  get("run-more").addEventListener("click", () => refresh(true));
  get("run-follow").addEventListener("change", () => {
    if (get("run-follow").checked) {
      const list = get("run-events");
      list.scrollTop = list.scrollHeight;
    }
  });
  get("run-copy").addEventListener("click", () => {
    const text = events.map(copyLine).join("\n");
    if (!navigator.clipboard) {
      setText("run-copy-status", "Copy unavailable; select timeline text");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setText("run-copy-status", "Copied sanitized metadata excerpt");
      })
      .catch(() => {
        setText("run-copy-status", "Copy unavailable; select timeline text");
      });
  });
  get("run-search").addEventListener("input", () => {
    query = get("run-search").value;
    applyFilter();
  });
  get("run-first-error").addEventListener("click", jumpToFirstError);
  get("run-copy-json").addEventListener("click", copyJson);
  get("run-download-json").addEventListener("click", downloadJson);
  get("run-compare-toggle").addEventListener("click", () => {
    const section = get("run-compare");
    if (!section.hidden) {
      closeCompare(true);
      return;
    }
    section.hidden = false;
    get("run-compare-toggle").setAttribute("aria-expanded", "true");
    fillCompareChoices();
    get("run-compare-heading").focus();
  });
  get("run-compare-select").addEventListener("change", () => {
    const id = get("run-compare-select").value;
    if (id) loadOther(id);
    else {
      other = null;
      otherToken++;
      get("run-compare-body").replaceChildren();
    }
  });
  // The page-wide helper other views use to find loaded runs (palette).
  window.crewplane.loadedRuns = () => [...runs.values()];
  window.addEventListener("crewplane-route", (event) =>
    syncRoute(event.detail),
  );
  syncRoute(window.crewplane.route);
  setInterval(() => {
    if (viewActive && !document.hidden) refresh();
  }, 2500);
  document.addEventListener("visibilitychange", () => {
    if (viewActive && !document.hidden) refresh();
  });
})();
