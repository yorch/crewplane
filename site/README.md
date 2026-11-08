# Crewplane website

Astro + Starlight, deployed to GitHub Pages by `.github/workflows/pages.yml`.

```sh
cd site && bun install --frozen-lockfile
bun run dev       # syncs docs, serves with hot reload
bun run build     # static output in dist/
```

- **Docs are not duplicated.** `scripts/sync-docs.ts` generates the Starlight pages from `../docs/*.md` at build time (title from the first heading, links rewritten) into a gitignored directory. Edit `docs/`, never the generated pages. Publish another doc by adding a row to `PAGES` and the sidebar in `astro.config.mjs`.
- **Demo and screenshots are generated, then committed.** After `bun run build` at the repo root, `bun site/scripts/record-demo.ts` drives the compiled binary against a throwaway project using the synthetic test harness (no real agent or provider) and rewrites `public/demo.cast` and `public/shots/*.png`. Re-record when CLI output or the dashboard changes.
