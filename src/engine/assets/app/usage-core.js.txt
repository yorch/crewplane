// Pure view models for Usage & cost: meters, the 24-hour series geometry, the
// table alternative and the wording of caps and coverage. No DOM. Every figure
// comes from /api/usage; unknown (null) is carried through as null and never
// drawn or counted as 0.
import {
  formatCount,
  formatDuration,
  formatUsd,
  meterLevel,
  percent,
} from "./format.js";

const known = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Runs this hour against the lane's cap, as text plus numbers for a <meter>. */
export function laneMeter(lane) {
  const used = known(lane?.runs?.lastHour) ? lane.runs.lastHour : null;
  const cap =
    known(lane?.runs?.cap) && lane.runs.cap > 0 ? lane.runs.cap : null;
  const level = meterLevel(used, cap);
  const source =
    lane?.runs?.capSource === "lane"
      ? "this agent's own cap"
      : lane?.runs?.capSource === "default"
        ? "the per-agent default cap"
        : null;
  let text;
  if (used === null && cap === null)
    text = "Runs this hour: not recorded. No cap known.";
  else if (used === null)
    text = `Runs this hour: not recorded. Cap ${formatCount(cap)} per hour.`;
  else if (cap === null)
    text = `${formatCount(used)} ${used === 1 ? "run" : "runs"} this hour. No cap known.`;
  else
    text = `${formatCount(used)} of ${formatCount(cap)} runs this hour${
      level === "full"
        ? " (at the cap)"
        : level === "over"
          ? " (over the cap)"
          : ""
    }.`;
  const remaining = known(lane?.runs?.remaining) ? lane.runs.remaining : null;
  return {
    used,
    cap,
    level,
    percent: percent(used, cap),
    remaining,
    source,
    text,
    // <meter> thresholds: lower is better; "near" starts at 80% and "full" at the cap.
    meter:
      used !== null && cap !== null
        ? {
            min: 0,
            max: cap,
            value: Math.min(used, cap),
            low: Math.round(cap * 80) / 100,
            high: cap - 0.01,
            optimum: 0,
          }
        : null,
  };
}

/** Recent durations against the run-time cap. */
export function durationRows(lane) {
  const limit = known(lane?.durations?.maxRunMinutes)
    ? lane.durations.maxRunMinutes * 60000
    : null;
  return (lane?.durations?.recent ?? []).map((run) => ({
    task: run.task ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    duration: formatDuration(run.durationMs),
    status: run.status ?? null,
    overLimit:
      limit === null || !known(run.durationMs) ? null : run.durationMs > limit,
  }));
}

/** Input/output counters, labelled as reported counters, with how many records reported each. */
export function tokenFacts(tokens) {
  const line = (value, reporting, retained) => ({
    value: formatCount(value),
    coverage:
      reporting === null || retained === null
        ? null
        : `${reporting} of ${retained} retained ${retained === 1 ? "record" : "records"} reported it`,
  });
  const count = (value) => (known(value) ? value : null);
  const retained = count(tokens?.retainedRecords);
  return {
    input: line(tokens?.input, count(tokens?.recordsReportingInput), retained),
    output: line(
      tokens?.output,
      count(tokens?.recordsReportingOutput),
      retained,
    ),
  };
}

/** Claude cost observations against maxCostUsdPerRun. */
export function costFacts(cost) {
  const cap = known(cost?.maxCostUsdPerRun) ? cost.maxCostUsdPerRun : null;
  const rows = (cost?.recent ?? []).map((item) => ({
    task: item.task ?? null,
    at: item.at ?? null,
    cost: formatUsd(item.costUsd),
    overCap:
      item.overCap === true ? true : item.overCap === false ? false : null,
  }));
  return {
    cap: cap === null ? null : formatUsd(cap),
    maxObserved: formatUsd(cost?.maxObservedUsd),
    anyOverCap:
      cost?.anyOverCap === true
        ? true
        : cost?.anyOverCap === false
          ? false
          : null,
    rows,
    hasData: rows.length > 0,
  };
}

/** A y-axis maximum from a short ladder (4, 8, 10, 20, 40, 50, 100, ...), so the middle tick is a whole number. */
export function niceMax(value) {
  if (!known(value) || value <= 0) return 4;
  if (value <= 4) return 4;
  if (value <= 8) return 8;
  for (let decade = 10; decade <= 1e9; decade *= 10)
    for (const step of [1, 2, 4, 5])
      if (decade * step >= value) return decade * step;
  return Math.ceil(value / 2) * 2;
}

/** "14:00" in the viewer's local time. */
export function hourLabel(iso) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:00`;
}

/**
 * Geometry for the 24-hour bar chart in a fixed viewBox. A bucket whose value is
 * null (history does not cover it) is `known: false` and gets no bar, so it
 * cannot be read as zero; the view draws it dashed.
 */
export function chartModel(series, bucketStarts, dims = {}) {
  const width = dims.width ?? 720;
  const height = dims.height ?? 200;
  const left = dims.left ?? 34;
  const right = dims.right ?? 8;
  const top = dims.top ?? 10;
  const bottom = dims.bottom ?? 26;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const values = Array.isArray(series) ? series : [];
  const starts = Array.isArray(bucketStarts) ? bucketStarts : [];
  const measured = values.filter(known);
  const max = niceMax(measured.length ? Math.max(...measured) : 0);
  const slot = values.length ? plotW / values.length : 0;
  const barWidth = Math.min(24, Math.max(2, slot - 6));
  const bars = values.map((raw, index) => {
    const value = known(raw) ? raw : null;
    const x = left + index * slot + (slot - barWidth) / 2;
    const barHeight = value === null ? 0 : (value / max) * plotH;
    return {
      index,
      start: starts[index] ?? null,
      label: hourLabel(starts[index]),
      value,
      known: value !== null,
      x,
      width: barWidth,
      y: top + plotH - barHeight,
      height: barHeight,
      slotX: left + index * slot,
      slotWidth: slot,
    };
  });
  const ticks = [0, max / 2, max].map((value) => ({
    value,
    y: top + plotH - (value / max) * plotH,
  }));
  const peak = bars
    .filter((bar) => bar.known && bar.value > 0)
    .reduce(
      (best, bar) => (best && best.value >= bar.value ? best : bar),
      null,
    );
  const total = measured.length ? measured.reduce((a, b) => a + b, 0) : null;
  return {
    width,
    height,
    left,
    top,
    plotW,
    plotH,
    baseline: top + plotH,
    max,
    bars,
    ticks,
    peak,
    total,
    measured: measured.length,
    unknown: values.length - measured.length,
    allUnknown: values.length > 0 && measured.length === 0,
  };
}

/** One sentence for the chart's accessible name. */
export function chartLabel(model, title) {
  if (!model.bars.length) return `${title}: no data.`;
  if (model.allUnknown)
    return `${title}: not recorded for any of the last ${model.bars.length} hours.`;
  const parts = [
    `${title}, last ${model.bars.length} hours: ${formatCount(model.total)} runs in ${model.measured} recorded hours`,
  ];
  if (model.peak)
    parts.push(`busiest hour ${model.peak.label} with ${model.peak.value}`);
  if (model.unknown) parts.push(`${model.unknown} hours not recorded`);
  return `${parts.join("; ")}.`;
}

/** Rows for the data table that stands in for the chart. */
export function seriesRows(series, bucketStarts) {
  return (Array.isArray(series) ? series : []).map((raw, index) => ({
    start: bucketStarts?.[index] ?? null,
    label: hourLabel(bucketStarts?.[index]),
    value: known(raw) ? raw : null,
  }));
}

/** Wording for where caps come from (one source) and how they relate to what the supervisor loaded. */
export function capsNotice(caps) {
  const lines = [];
  const perHour = caps?.perLaneDefault?.maxRunsPerHour;
  const minutes = caps?.perLaneDefault?.maxRunMinutes;
  if (!caps || caps.source === null || caps.source === undefined)
    return [
      "No caps are known: the installed configuration is unreadable and the supervisor has not recorded the caps it loaded.",
    ];
  lines.push(
    caps.source === "configured"
      ? "Every cap here comes from the installed configuration."
      : "The installed configuration could not be read, so these are the caps the running supervisor loaded. Per-agent caps are unknown; only the default applies.",
  );
  if (known(perHour))
    lines.push(
      `Default: ${formatCount(perHour)} runs per hour for each agent without its own cap. This is a per-agent default, not a total across agents.`,
    );
  if (known(minutes))
    lines.push(`Default run limit: ${formatCount(minutes)} minutes per run.`);
  if (caps.source === "configured") {
    const loaded = caps.loaded;
    if (caps.loadedDiffers === true)
      lines.push(
        `The running supervisor loaded different caps (${formatCount(loaded?.maxRunsPerHour) ?? "unknown"} runs per hour, ${formatCount(loaded?.maxRunMinutes) ?? "unknown"} minutes). The installed values apply only after the supervisor reloads.`,
      );
    else if (caps.loadedDiffers === false)
      lines.push("These match what the running supervisor loaded.");
    else
      lines.push(
        "What the supervisor loaded is unknown (it is not running or has not recorded it).",
      );
  }
  return lines;
}

/** Plain-language coverage facts from the response's `coverage` block. */
export function coverageNotes(coverage, windowSize = 24) {
  const notes = [];
  const counters = coverage?.counters;
  notes.push({
    title: "Token and cost counters",
    text:
      counters?.state === "unavailable"
        ? "The supervisor state could not be read, so no counters are available."
        : `Taken from ${formatCount(counters?.retainedRecords) ?? "an unknown number of"} retained supervisor records, and only where the provider reported the value. Finished records are compacted away, so these are not lifetime totals and not billing totals.`,
  });
  const series = coverage?.series;
  let seriesText;
  if (series?.state === "unavailable")
    seriesText =
      "The operational trace store could not be read, so the hourly series is not recorded.";
  else if (series?.complete === true)
    seriesText = `All ${windowSize} hours are covered by retained run history.`;
  else {
    seriesText =
      "Hours the retained run history does not cover are shown as Not recorded, never as zero. ";
    if (series?.retainedRuns === 0)
      seriesText += "No run has been recorded yet, so no hour can be measured.";
    else if (series?.incomplete === true)
      seriesText += "Some trace pages could not be read.";
    else if (series?.retentionLimited === true)
      seriesText += "Older runs have been pruned from the retained history.";
    else
      seriesText +=
        "The project's first retained run is more recent than the earlier hours.";
  }
  notes.push({ title: "Hourly run series", text: seriesText });
  notes.push({
    title: "Recent run durations",
    text: "Only the latest run of each retained record is listed, so this is a sample, not every run.",
  });
  notes.push({
    title: "Detailed usage ledger",
    text:
      coverage?.ledger?.connected === false
        ? "Not connected: the runtime does not write the detailed ledger, so it is not read."
        : "Connection state not reported.",
  });
  return notes;
}
