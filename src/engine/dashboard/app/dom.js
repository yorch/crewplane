const ICONS = {
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  alert: "M12 4l9 16H3zM12 10v4M12 17.5v.01",
  check: "M5 13l4 4 10-11",
};

export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function link(href, text, className) {
  const node = el("a", text, className);
  node.href = href;
  node.dataset.focusKey ??= `href:${href}:${text ?? ""}`;
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

export function detail(title, text, key) {
  const node = el("details", undefined, "disclosure");
  if (key) node.dataset.key = key;
  const body = el("pre", text);
  if (key) body.dataset.scrollKey = `pre-${key}`;
  node.append(el("summary", title), body);
  return node;
}

export function fields(rows, className) {
  const list = el(
    "dl",
    undefined,
    className ? `fields ${className}` : "fields",
  );
  for (const [label, value, unknownText] of rows) {
    const term = el("dt", label);
    const description = el("dd");
    if (value === null || value === undefined || value === "") {
      description.textContent = unknownText ?? "Not recorded";
      description.classList.add("is-unknown");
    } else if (value instanceof Node) description.append(value);
    else description.textContent = String(value);
    list.append(term, description);
  }
  return list;
}
export function section(title, ...children) {
  const node = el("section", undefined, "detail-section");
  node.append(el("h3", title), ...children);
  return node;
}
export function emptyState(title, hint) {
  const node = el("div", undefined, "empty-state");
  node.append(el("p", title, "empty-title"));
  if (hint) node.append(el("p", hint, "empty-hint"));
  return node;
}
export function firstLine(text, limit = 160) {
  return String(text ?? "")
    .split("\n")[0]
    .slice(0, limit);
}

export function includesText(text, query) {
  return !query || text.toLowerCase().includes(query.toLowerCase());
}
export function closeLink(href, label) {
  const node = el("a", undefined, "close-link");
  node.href = href;
  node.dataset.closeDetail = "true";
  node.setAttribute("aria-label", label);
  node.append(
    icon("back"),
    el("span", "Back", "narrow-only"),
    icon("close"),
    el("span", "Close", "wide-only"),
  );
  return node;
}
export function detailHeading(text, id) {
  const heading = el("h2", text, "detail-title");
  heading.id = id;
  heading.tabIndex = -1;
  heading.dataset.focusKey = "detail-heading";
  return heading;
}
