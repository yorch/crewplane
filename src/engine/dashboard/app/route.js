import {
  ENUM_PARAMS,
  MAX_HASH_LENGTH,
  MAX_PARAM_LENGTH,
  MODAL_VIEWS,
  PARAM_PATTERNS,
  ROUTE_PARAMS,
  SELECTION_PARAM,
} from "./config.js";

function cleanParam(view, key, value) {
  if (value.length > MAX_PARAM_LENGTH || /\p{Cc}/u.test(value)) return null;
  const pattern = PARAM_PATTERNS[view]?.[key];
  if (pattern && !pattern.test(value)) return null;
  const allowed = ENUM_PARAMS[key];
  return allowed && !allowed.includes(value) ? null : value;
}
export function parseHash(hash) {
  const fallback = { view: "overview", params: {}, valid: false };
  if (hash === "" || hash === "#") return { ...fallback, valid: true };
  if (
    typeof hash !== "string" ||
    !hash.startsWith("#/") ||
    hash.length > MAX_HASH_LENGTH
  )
    return fallback;
  const body = hash.slice(2);
  const split = body.indexOf("?");
  const view = split === -1 ? body : body.slice(0, split);
  if (!Object.hasOwn(ROUTE_PARAMS, view)) return fallback;
  // URLSearchParams tolerates malformed percent escapes without throwing.
  const query = new URLSearchParams(split === -1 ? "" : body.slice(split + 1));
  const params = {};
  for (const key of ROUTE_PARAMS[view]) {
    const value = query.get(key);
    if (value === null || value === "") continue;
    const clean = cleanParam(view, key, value);
    if (clean !== null) params[key] = clean;
  }
  return { view, params, valid: true };
}
export function hrefFor(view, params = {}) {
  const query = new URLSearchParams();
  for (const key of ROUTE_PARAMS[view] ?? [])
    if (params[key]) query.set(key, params[key]);
  const suffix = query.toString();
  return `#/${view}${suffix ? `?${suffix}` : ""}`;
}
export function routeScrollKey(value) {
  const selection = MODAL_VIEWS.includes(value.view)
    ? undefined
    : SELECTION_PARAM[value.view];
  return `${value.view}${selection && value.params[selection] ? ":detail" : ""}`;
}
