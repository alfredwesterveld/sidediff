# sidediff

Visually compare **two different live sites** across many paths — old vs redesigned,
staging vs prod, migration source vs target. Playwright for capture, odiff for pixels,
one static HTML report with a slide/side-by-side/diff viewer.

This is not baseline-vs-rerun visual regression. Both sides are live URLs.

## Use

```sh
bun install
bunx playwright install chromium

bun run compare --a https://old.example --b https://new.example
```

Report lands in `sidediff-out/index.html`. Exit code is 1 if anything changed or failed to load.

## How paths are found

Sitemap first (`robots.txt` `Sitemap:` lines + `/sitemap.xml`, following sitemap indexes),
then a depth-2 link crawl of site A, unioned. Then: non-HTML assets dropped, query strings
stripped, and paths collapsed to templates two ways — by shape (`/product/1234` → `/product/:num`,
hyphenated segments → `:slug`) and by sibling count (a parent with 8+ distinct children at one
depth is a listing, so that segment becomes `:slug` whatever it looks like). 3 samples per
template, 200 paths overall; both caps are flags.

The count-based pass is what keeps coverage honest: a bare `--limit 200` fills breadth-first
with 200 near-identical doc pages and never samples the site's other templates.

Pass `--paths-file` to skip discovery — the crawler reads server-rendered HTML only, so a
client-rendered SPA yields nothing.

## What it does to make two servers produce comparable pixels

- animations, transitions, carets, smooth scroll disabled
- `position: sticky` made static before capture: pinned at scroll-top it occludes content
  ambiguously. `position: fixed` elements are **kept** — fixed navs and CTAs are exactly what a
  redesign changes. `--hide-fixed` drops them when they are pure noise (chat widgets)
- `Date` and `Math.random` frozen via init script (`--freeze-time`, default 2020-01-01)
- locale `en-US`, timezone UTC pinned
- analytics/ad hosts aborted at the network layer
- common cookie-consent containers hidden (`--hide` to override)
- waits on `document.fonts.ready` + network idle, scrolls to the bottom to trigger
  lazy-loading, then back to the top
- `--mask` paints over selectors you know will never match

## Text and meta diffing

Alongside the pixels, each page's **rendered text** (`innerText`, not markup) is diffed
GitHub-style, plus a table of `<title>`, description, canonical, robots, `og:*`, and the
heading and link inventories.

Rendered text, not HTML, on purpose: class hashes, build ids and attribute order churn on
every build, so a raw markup diff reports everything as changed on a visually identical page.
Text diffing is also immune to the height mismatches that make pixel percentages hard to read,
and it catches the migration failure pixels are worst at — a nav item or whole section quietly
missing on the new site.

It does not replace the pixel diff: a pure restyle with identical copy produces a clean text
diff. That is why both live in one report. `--no-text` skips it.

## Reading the report

Rows sort worst-first: `error` (one side failed) → `layout` (different image dimensions) →
`diff` (% of pixels) → `text` → `skipped` → `match`. A `text` row is a page whose pixels
matched but whose copy or meta tags changed — those must never be filed under `match`. Redirect targets are recorded per side — redirect
parity is half the value of a migration audit.

`layout` means the two screenshots have different dimensions. Read those first: odiff counts
the whole non-overlapping region as changed, so the percentage on a `layout` row is inflated
by the height delta and is not comparable to a `diff` row's. Tolerance never applies to them.

A page counts as `match` only if it is under the tolerance percentage **and** under 20k
changed pixels — on a 20 000px-tall page a percentage alone would let a swapped logo through.

## Known limits

- `--exclude` / `--hide` / `--mask` / `--block` split on commas, so values containing a comma
  (`\d{2,4}`, `:is(.a, .b)`) can't be expressed yet.
- The crawler reads server-rendered HTML with plain `fetch` — no JS, no browser UA. Bot-protected
  sites will refuse it while capture still works; use `--paths-file` there.

## Flags

`bun run compare --help`

## License

MIT.
