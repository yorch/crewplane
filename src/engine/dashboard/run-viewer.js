(() => {
  const get = (id) => document.getElementById(id);
  let selected = null;
  let cursor = 0;
  let before = null;
  let events = [];
  let busy = false;
  const buttons = new Map();
  function renderEvents(meta) {
    const node = get("run-events"),
      position = node.scrollTop;
    node.value = events
      .map(
        (e) =>
          `${e.at} #${e.sequence} [${e.channel}] ${e.kind}${e.tool ? ` · ${e.tool}` : ""}${e.status ? ` · ${e.status}` : ""} · ${e.message}${e.model ? ` · model ${e.model}` : ""}${e.effort ? ` · effort ${e.effort}` : ""}${e.inputTokens !== null ? ` · input ${e.inputTokens}` : ""}${e.outputTokens !== null ? ` · output ${e.outputTokens}` : ""}`,
      )
      .join("\n");
    node.scrollTop = get("run-follow").checked ? node.scrollHeight : position;
    get("run-note").textContent =
      `${meta.runId} · ${meta.lane} · ${meta.task ?? "coordination"} · ${meta.harness} · ${meta.status} · final ${meta.finalState ?? "not recorded"} · ${meta.events} retained events${meta.truncated ? " · TRUNCATED at storage cap" : ""}. Payloads filtered; retention may remove older runs.`;
  }
  async function tail() {
    if (!selected) return;
    const id = selected;
    const response = await fetch(
      `/api/runs/${encodeURIComponent(id)}?after=${cursor}&limit=100`,
      { cache: "no-store" },
    );
    if (!response.ok)
      throw Error("Selected run unavailable or no longer retained");
    const value = await response.json();
    if (selected !== id) return;
    events.push(...value.events);
    events = events.slice(-500);
    cursor = value.nextCursor;
    renderEvents(value.meta);
    if (value.incomplete)
      get("run-note").textContent += " Partial or malformed records omitted.";
  }
  async function refresh(older = false) {
    if (busy) return;
    busy = true;
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
      before = value.nextCursor;
      get("run-more").disabled = !before;
      for (const run of value.runs) {
        let button = buttons.get(run.runId);
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.addEventListener("click", () => {
            selected = run.runId;
            cursor = 0;
            events = [];
            get("run-events").value = "";
            tail().catch((e) => {
              get("runs-status").textContent = e.message;
            });
          });
          buttons.set(run.runId, button);
          get("run-history").append(button);
        }
        button.textContent = `${run.lane} · ${run.task ?? "coordination"} · ${run.harness} · ${run.status} · ${run.startedAt}`;
        button.setAttribute("aria-pressed", String(selected === run.runId));
      }
      if (!selected && value.runs[0]) selected = value.runs[0].runId;
      get("runs-status").textContent = value.runs.length
        ? "Incremental private metadata"
        : "No normalized runs recorded yet";
      if (!value.runs.length)
        get("run-note").textContent =
          "The previous supervisor has no retroactive normalized history. New collection starts after safe native reload.";
      if (value.incomplete || value.retentionLimited)
        get("runs-status").textContent += " · limited/retained history";
      await tail();
    } catch (error) {
      get("runs-status").textContent = error.message;
    } finally {
      busy = false;
    }
  }
  for (const id of ["run-lane", "run-harness", "run-task"])
    get(id).addEventListener("change", () => {
      selected = null;
      cursor = 0;
      before = null;
      events = [];
      buttons.clear();
      get("run-history").replaceChildren();
      get("run-events").value = "";
      refresh();
    });
  get("run-more").addEventListener("click", () => refresh(true));
  get("run-copy").addEventListener("click", () => {
    navigator.clipboard
      ?.writeText(get("run-events").value ?? "")
      .then(() => {
        get("runs-status").textContent = "Copied sanitized metadata excerpt";
      })
      .catch(() => {
        get("runs-status").textContent =
          "Copy unavailable; select timeline text";
      });
  });
  refresh();
  setInterval(refresh, 2500);
})();
