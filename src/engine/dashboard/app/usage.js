// Usage & cost (#/usage), from /api/usage. Figures are retained counters and
// observations, never billing totals, and anything the retained history does
// not cover is shown as Not recorded (dashed), never as zero. The 24-hour chart
// is inline SVG with a data table beside it as the accessible alternative.

import { usageResource } from "./aux.js";
import { badge } from "./badges.js";
import { el, emptyState, fields, link } from "./dom.js";
import { formatCount } from "./format.js";
import { hrefFor } from "./route.js";
import { $, store } from "./store.js";
import { dataTable } from "./tables.js";
import { date, timeEl } from "./time.js";
import {
  capsNotice,
  chartLabel,
  chartModel,
  costFacts,
  coverageNotes,
  durationRows,
  laneMeter,
  seriesRows,
  tokenFacts,
} from "./usage-core.js";
import {
  errorPanel,
  loadingNote,
  noteList,
  panel,
  staleNote,
} from "./view-parts.js";

const retry = () => usageResource.load({ force: true });
const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
const unknownValue = (text = "Not recorded") => el("span", text, "is-unknown");

// A column with a 4px rounded end and a square base (marks spec).
function barPath(bar, baseline) {
  const { x, y, width, height } = bar;
  const r = Math.min(4, width / 2, height);
  return `M${x} ${baseline}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${width - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${baseline}Z`;
}

const levelText = {
  ok: ["Within cap", "success"],
  near: ["Near cap", "warning"],
  full: ["At cap", "danger"],
  over: ["Over cap", "danger"],
  unknown: ["Unknown", "unknown"],
};

export function chartElement(series, bucketStarts, title) {
  const model = chartModel(series, bucketStarts);
  const root = svg("svg", {
    class: "chart",
    viewBox: `0 0 ${model.width} ${model.height}`,
    role: "img",
    "aria-label": chartLabel(model, title),
    preserveAspectRatio: "xMidYMid meet",
  });
  for (const tick of model.ticks) {
    root.append(
      svg("line", {
        class: "chart-grid",
        x1: model.left,
        x2: model.left + model.plotW,
        y1: tick.y,
        y2: tick.y,
      }),
      svg(
        "text",
        {
          class: "chart-axis",
          x: model.left - 6,
          y: tick.y + 4,
          "text-anchor": "end",
        },
        formatCount(tick.value),
      ),
    );
  }
  for (const bar of model.bars) {
    const hourText = bar.label || "this hour";
    if (!bar.known) {
      const unknown = svg("rect", {
        class: "chart-unknown",
        x: bar.x,
        y: model.top,
        width: bar.width,
        height: model.plotH,
        rx: 3,
      });
      unknown.append(svg("title", {}, `${hourText}: not recorded`));
      root.append(unknown);
    } else if (bar.value > 0) {
      const column = svg("path", {
        class: "chart-bar",
        d: barPath(bar, model.baseline),
      });
      column.append(
        svg(
          "title",
          {},
          `${hourText}: ${bar.value} ${bar.value === 1 ? "run" : "runs"}`,
        ),
      );
      root.append(column);
    } else {
      // A measured zero is a short tick on the baseline, distinct from the dashed unknown.
      const zero = svg("rect", {
        class: "chart-zero",
        x: bar.x,
        y: model.baseline - 2,
        width: bar.width,
        height: 2,
      });
      zero.append(svg("title", {}, `${hourText}: 0 runs`));
      root.append(zero);
    }
    if (bar.index % 3 === 0)
      root.append(
        svg(
          "text",
          {
            class: "chart-axis",
            x: bar.x + bar.width / 2,
            y: model.height - 8,
            "text-anchor": "middle",
          },
          bar.label,
        ),
      );
  }
  if (model.peak)
    root.append(
      svg(
        "text",
        {
          class: "chart-value",
          x: model.peak.x + model.peak.width / 2,
          y: Math.max(10, model.peak.y - 4),
          "text-anchor": "middle",
        },
        String(model.peak.value),
      ),
    );
  root.append(
    svg("line", {
      class: "chart-base",
      x1: model.left,
      x2: model.left + model.plotW,
      y1: model.baseline,
      y2: model.baseline,
    }),
  );
  return { svg: root, model };
}

function chartPanel(data, laneId) {
  const lane = laneId
    ? (data.lanes ?? []).find((candidate) => candidate.lane === laneId)
    : null;
  const series = (lane ? lane.series : data.total?.series) ?? [];
  const scope = lane ? `agent ${lane.lane}` : "all agents";
  const title = `Runs started per hour, ${scope}`;
  const nodes = [];
  if (laneId && !lane)
    nodes.push(
      el(
        "p",
        `No usage record exists for an agent named “${laneId}”. Showing all agents.`,
        "text-warning",
      ),
    );
  const { svg: chart, model } = chartElement(
    series,
    data.window?.bucketStarts,
    title,
  );
  const frame = el("div", undefined, "chart-frame");
  frame.append(chart);
  nodes.push(frame);
  if (model.unknown > 0) {
    const legend = el("p", undefined, "chart-legend");
    legend.append(
      el("span", undefined, "legend-swatch is-unknown-swatch"),
      el(
        "span",
        model.allUnknown
          ? "Dashed: not recorded. No retained run history covers these hours yet, so nothing is known, not even zero."
          : "Dashed: not recorded. Retained run history does not cover these hours; they are not zero.",
      ),
    );
    nodes.push(legend);
  }
  const rows = seriesRows(series, data.window?.bucketStarts);
  const table = el("details", undefined, "disclosure");
  table.dataset.key = "usage-chart-table";
  table.append(
    el("summary", "Show the same data as a table"),
    dataTable({
      label: `${title}, as a table`,
      columns: ["Hour starting", "Runs started"],
      rows: rows.map((row) => ({
        key: row.start ?? "",
        cells: [
          row.start ? timeEl(row.start) : null,
          row.value === null ? null : String(row.value),
        ],
      })),
    }),
  );
  nodes.push(table);
  return panel("usage-chart-heading", title, nodes);
}

function meterBlock(lane, meter) {
  const [text, tone] = levelText[meter.level];
  const wrap = el("div", undefined, "meter-block");
  const line = el("div", undefined, "meter-line");
  if (meter.meter) {
    const node = document.createElement("meter");
    node.className = `meter meter-${meter.level}`;
    node.min = meter.meter.min;
    node.max = meter.meter.max;
    node.low = meter.meter.low;
    node.high = meter.meter.high;
    node.optimum = meter.meter.optimum;
    node.value = meter.meter.value;
    node.setAttribute("aria-label", `Runs this hour for ${lane.lane}`);
    node.setAttribute("aria-valuetext", meter.text);
    node.textContent = `${meter.used} of ${meter.cap}`;
    line.append(node);
  } else line.append(el("span", undefined, "meter meter-unknown"));
  line.append(badge(text, tone));
  wrap.append(line, el("p", meter.text, "meter-text"));
  const detail = [];
  if (meter.remaining !== null)
    detail.push(`${formatCount(meter.remaining)} left this hour`);
  if (meter.source) detail.push(`using ${meter.source}`);
  if (detail.length) wrap.append(el("p", detail.join(" · "), "note"));
  return wrap;
}

function durationsBlock(lane) {
  const rows = durationRows(lane);
  const limit = lane.durations?.maxRunMinutes;
  const block = el("div", undefined, "usage-block");
  block.append(el("h4", "Recent run durations"));
  if (!rows.length) {
    block.append(
      el("p", "No finished run is retained for this agent.", "note"),
    );
    return block;
  }
  block.append(
    dataTable({
      label: `Recent run durations for ${lane.lane}`,
      columns: ["Task", "Finished", "Duration", "Against the limit"],
      rows: rows.map((row, index) => ({
        key: String(index),
        cells: [
          row.task
            ? link(hrefFor("tasks", { task: row.task }), row.task, "mono")
            : el("span", "Coordination", "is-unknown"),
          row.finishedAt ? timeEl(row.finishedAt) : null,
          row.duration,
          row.overLimit === null
            ? unknownValue("No limit known")
            : row.overLimit
              ? badge("Over the limit", "danger")
              : badge("Within the limit", "success"),
        ],
      })),
    }),
  );
  if (limit)
    block.append(el("p", `Run limit: ${formatCount(limit)} minutes.`, "note"));
  return block;
}

function tokensBlock(lane) {
  const facts = tokenFacts(lane.tokens);
  const block = el("div", undefined, "usage-block");
  block.append(
    el("h4", "Reported token counters"),
    fields([
      [
        "Input tokens",
        facts.input.value === null ? null : facts.input.value,
        "Not recorded",
      ],
      ["Input coverage", facts.input.coverage, "Not recorded"],
      ["Output tokens", facts.output.value, "Not recorded"],
      ["Output coverage", facts.output.coverage, "Not recorded"],
    ]),
    el(
      "p",
      "Reported counters, not billing totals. Only records whose provider reported the value are counted.",
      "note",
    ),
  );
  return block;
}

function costBlock(lane) {
  const facts = costFacts(lane.cost);
  const block = el("div", undefined, "usage-block");
  block.append(el("h4", "Cost (Claude, per invocation)"));
  if (!facts.hasData && facts.cap === null) {
    block.append(
      el(
        "p",
        "No cost cap is configured and no cost was reported. Cost appears only for harnesses that report it.",
        "note",
      ),
    );
    return block;
  }
  const status =
    facts.anyOverCap === true
      ? badge("Over cap", "danger")
      : facts.anyOverCap === false
        ? badge("Within cap", "success")
        : null;
  block.append(
    fields([
      ["Cap per run", facts.cap, "No cap configured"],
      ["Highest observed", facts.maxObserved, "Not recorded"],
      ["Against the cap", status, "Cannot compare: no cap or no observation"],
    ]),
  );
  if (facts.rows.length)
    block.append(
      dataTable({
        label: `Recent reported costs for ${lane.lane}`,
        columns: ["Task", "When", "Reported cost", "Against the cap"],
        rows: facts.rows.map((row, index) => ({
          key: String(index),
          cells: [
            row.task
              ? link(hrefFor("tasks", { task: row.task }), row.task, "mono")
              : el("span", "Coordination", "is-unknown"),
            row.at ? timeEl(row.at) : null,
            row.cost,
            row.overCap === null
              ? unknownValue("No cap")
              : row.overCap
                ? badge("Over cap", "danger")
                : badge("Within cap", "success"),
          ],
        })),
      }),
    );
  block.append(
    el(
      "p",
      "Per-invocation observations reported by the harness, not an invoice.",
      "note",
    ),
  );
  return block;
}

function laneCard(lane) {
  const meter = laneMeter(lane);
  const card = el("article", undefined, "panel lane-usage");
  card.dataset.lane = lane.lane;
  const head = el("div", undefined, "lane-usage-head");
  const heading = el("h3");
  heading.append(
    link(hrefFor("agents", { agent: lane.lane }), lane.lane, "agent-name"),
  );
  head.append(heading);
  if (lane.enabled !== null)
    head.append(
      badge(
        lane.enabled ? "Enabled" : "Disabled",
        lane.enabled ? "success" : "neutral",
      ),
    );
  card.append(
    head,
    meterBlock(lane, meter),
    durationsBlock(lane),
    tokensBlock(lane),
    costBlock(lane),
  );
  return card;
}

function summaryPanel(data) {
  const total = data.total ?? {};
  return panel("usage-summary-heading", "This hour and in total", [
    fields([
      [
        "Runs started in the last hour",
        total.runsLastHour === null || total.runsLastHour === undefined
          ? null
          : formatCount(total.runsLastHour),
        "Not recorded (supervisor state unreadable)",
      ],
      [
        "Input tokens (reported counters)",
        formatCount(total.tokens?.input),
        "Not recorded",
      ],
      [
        "Output tokens (reported counters)",
        formatCount(total.tokens?.output),
        "Not recorded",
      ],
    ]),
    el(
      "p",
      "Token figures are reported counters, not billing totals. A missing figure means no retained record reported it.",
      "note",
    ),
    noteList(capsNotice(data.caps)),
  ]);
}

function coveragePanel(data) {
  const details = el("details", undefined, "info");
  details.dataset.key = "info-usage-coverage";
  const list = el("dl", undefined, "coverage-list");
  for (const note of coverageNotes(
    data.coverage,
    data.window?.bucketStarts?.length ?? 24,
  ))
    list.append(el("dt", note.title), el("dd", note.text));
  details.append(el("summary", "How complete is this data?"), list);
  return details;
}

export function fillUsageLanes(data) {
  const select = $("usage-lane");
  const selected = select.value;
  const lanes = (data?.lanes ?? []).map((lane) => lane.lane);
  const options =
    selected && !lanes.includes(selected) ? [...lanes, selected] : lanes;
  const signature = JSON.stringify(options);
  if (select.dataset.options === signature) return;
  select.replaceChildren(
    new Option("All agents", ""),
    ...options.map((lane) => new Option(lane, lane)),
  );
  select.value = selected;
  select.dataset.options = signature;
}

export function renderUsage() {
  const host = $("usage-body");
  const { status, data, error, loadedAt } = usageResource.state;
  if (!data) {
    host.replaceChildren(
      status === "error"
        ? errorPanel("usage", error, retry)
        : loadingNote("Reading usage…"),
    );
    return;
  }
  fillUsageLanes(data);
  const laneId = store.route.params.lane ?? "";
  if ($("usage-lane").value !== laneId) $("usage-lane").value = laneId;
  const nodes = [];
  if (status === "error") nodes.push(staleNote(error, loadedAt, retry));
  nodes.push(summaryPanel(data), chartPanel(data, laneId), coveragePanel(data));
  const lanes = data.lanes ?? [];
  if (!lanes.length)
    nodes.push(
      emptyState(
        "No agents have usage yet.",
        "Agents appear once they are configured or have run.",
      ),
    );
  else {
    const grid = el("div", undefined, "usage-grid");
    grid.append(
      ...lanes.filter((lane) => !laneId || lane.lane === laneId).map(laneCard),
    );
    nodes.push(grid);
  }
  const stamp = el("p", `Generated ${date(data.generatedAt)}.`, "note");
  nodes.push(stamp);
  host.replaceChildren(...nodes);
}

export function openUsage() {
  usageResource.load();
}
