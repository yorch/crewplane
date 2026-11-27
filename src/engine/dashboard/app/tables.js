import { el } from "./dom.js";

// A data table that stacks into labelled rows on narrow screens (the CSS turns
// cells into blocks, so explicit ARIA roles keep the table semantics). Cells
// are Nodes or plain strings (set with textContent); null is "Not recorded".
// `rows[i].key` makes row elements findable; `selected` marks the open row.
export function dataTable({ label, columns, rows, className = "" }) {
  const table = el("table", undefined, `agents-table data-table ${className}`);
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", label);
  const head = el("thead");
  head.setAttribute("role", "rowgroup");
  const header = el("tr");
  header.setAttribute("role", "row");
  for (const column of columns) {
    const th = el("th", column);
    th.setAttribute("role", "columnheader");
    th.scope = "col";
    header.append(th);
  }
  head.append(header);
  const body = el("tbody");
  body.setAttribute("role", "rowgroup");
  for (const row of rows) {
    const tr = el("tr", undefined, row.selected ? "is-selected" : undefined);
    tr.setAttribute("role", "row");
    if (row.key !== undefined) tr.dataset.rowKey = row.key;
    if (row.className) tr.classList.add(row.className);
    row.cells.forEach((value, index) => {
      const td = el("td");
      td.setAttribute("role", "cell");
      td.dataset.label = columns[index] ?? "";
      if (value === null || value === undefined || value === "")
        td.append(el("span", "Not recorded", "is-unknown"));
      else if (value instanceof Node) td.append(value);
      else td.textContent = String(value);
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(head, body);
  return table;
}
