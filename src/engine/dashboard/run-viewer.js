(() => {
  const get = (id) => document.getElementById(id);
  const MAX_EVENTS = 500;
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
  const stamp = (value) => {
    const time = new Date(value);
    return Number.isFinite(time.getTime())
      ? time.toLocaleString()
      : "not reported";
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
    const head = make("div", undefined, "timeline-head");
    const time = make("time", stamp(e.at), "time");
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
      summary.replaceChildren(tags);
      summary.dataset.signature = signature;
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
  async function tail() {
    if (!selected || tailing === generation) return;
    const run = generation;
    const id = selected;
    tailing = run;
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(id)}?after=${cursor}&limit=100`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw Error("Selected run unavailable or no longer retained");
      const value = await response.json();
      if (run !== generation) return;
      events.push(...value.events);
      events = events.slice(-MAX_EVENTS);
      cursor = value.nextCursor;
      appendEvents(value.events);
      renderSummary(value.meta, value.incomplete);
      if (!events.length)
        timelinePlaceholder("No events retained for this run.");
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
      make("span", stamp(run.startedAt)),
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
    tailing = -1;
    get("run-summary").replaceChildren();
    get("run-summary").removeAttribute("data-signature");
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
      const response = await fetch(`/api/runs?${query}`, { cache: "no-store" });
      if (!response.ok) throw Error("Run history unavailable; check filters");
      const value = await response.json();
      if (startKey !== filterKey) return;
      if (older || !olderLoaded) before = value.nextCursor;
      if (older) olderLoaded = true;
      get("run-more").disabled = !before;
      setText("run-more", before ? "Older runs" : "No older runs");
      for (const run of value.runs) runs.set(run.runId, run);
      if (!selected && value.runs[0]) selectRun(value.runs[0].runId);
      renderHistory();
      let status = runs.size
        ? "Incremental private metadata"
        : "No normalized runs recorded yet";
      if (value.incomplete || value.retentionLimited)
        status += " · limited/retained history";
      setText("runs-status", status);
      if (!runs.size && !selected) {
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
      setText("runs-status", "Copy unavailable; select timeline text");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setText("runs-status", "Copied sanitized metadata excerpt");
      })
      .catch(() => {
        setText("runs-status", "Copy unavailable; select timeline text");
      });
  });
  window.addEventListener("crewplane-route", (event) =>
    syncRoute(event.detail),
  );
  syncRoute(window.crewplane.route);
  setInterval(() => {
    if (viewActive) refresh();
  }, 2500);
})();
