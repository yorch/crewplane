import { embeddedAssets } from "./assets.ts";

export type AssetRoute = { name: string; type: string };

const contentTypes: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
};
/** Historical public path of the run viewer script. */
const aliases: Record<string, string> = { "/runs.js": "run-viewer.js" };

/**
 * Exact-match route table for the embedded dashboard: the page at `/` and
 * every other embedded file at `/<name>`. Only names that exist in the
 * embedded set are routable, so there is nothing to traverse: any other path
 * (including `..`, encoded or doubled separators, or a query string) misses.
 */
export function assetRoutes(
  assets: Record<string, string> = embeddedAssets,
): Map<string, AssetRoute> {
  const routes = new Map<string, AssetRoute>();
  for (const name of Object.keys(assets)) {
    const type = contentTypes[name.slice(name.lastIndexOf(".") + 1)];
    if (!type) continue;
    if (name === "index.html") routes.set("/", { name, type });
    else routes.set(`/${name}`, { name, type });
  }
  for (const [path, name] of Object.entries(aliases)) {
    const target = routes.get(`/${name}`);
    if (target) routes.set(path, target);
  }
  return routes;
}
