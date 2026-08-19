/**
 * Path discovery: sitemap first (cheap, already deduped), crawl as fallback,
 * then normalise + collapse templates so 800 blog posts don't become 800 diffs.
 */

const SITEMAP_CAP = 50_000;
const SITEMAP_INDEX_DEPTH = 3;

export interface DiscoverOptions {
  useSitemap: boolean;
  crawlDepth: number;
  limit: number | null;
  perTemplate: number;
  keepQuery: boolean;
  exclude: RegExp[];
}

/** Hosts differing only by a www. prefix are the same site for our purposes. */
const sameSite = (h1: string, h2: string): boolean =>
  h1 === h2 || h1.replace(/^www\./, "") === h2.replace(/^www\./, "");

/**
 * Strip hash, optionally query, drop trailing slash. Relative hrefs resolve
 * against `base` (the page that contained them), but the host check is always
 * against `origin`, so cross-host links still get dropped.
 */
export function normalisePath(
  raw: string,
  origin: string,
  keepQuery: boolean,
  base: string = origin,
): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!sameSite(url.hostname.toLowerCase(), new URL(origin).hostname.toLowerCase())) return null;

  url.hash = "";
  if (!keepQuery) url.search = "";
  else url.searchParams.sort();

  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";

  // Non-HTML assets are never worth screenshotting.
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|woff2?|ttf|eot|mp4|webm|mp3)$/i.test(path)) {
    return null;
  }
  return path + url.search;
}

/**
 * Collapse a path to a template key so we can cap samples per template.
 * /blog/my-post -> /blog/:slug ; /product/1234 -> /product/:num
 * Shape-based only; see positionalKey below for the count-based pass.
 */
export function templateKey(path: string): string {
  const [bare = "/"] = path.split("?");
  const segments = bare.split("/").filter(Boolean).map((seg) => {
    if (/^\d+$/.test(seg)) return ":num";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hash";
    // A hyphenated segment is almost always a content slug.
    if (seg.split("-").length >= 2) return ":slug";
    return seg.toLowerCase();
  });
  return "/" + segments.join("/");
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function sitemapUrls(origin: string): Promise<string[]> {
  const seeds = new Set<string>([new URL("/sitemap.xml", origin).href]);

  const robots = await fetchText(new URL("/robots.txt", origin).href);
  if (robots) {
    for (const line of robots.split(/\r?\n/)) {
      const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
      if (match?.[1]) seeds.add(match[1]);
    }
  }

  const found: string[] = [];
  const seen = new Set<string>();
  let frontier = [...seeds];

  for (let depth = 0; depth < SITEMAP_INDEX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const sm of frontier) {
      if (seen.has(sm) || found.length >= SITEMAP_CAP) continue;
      seen.add(sm);
      const xml = await fetchText(sm);
      if (!xml) continue;
      const isIndex = /<sitemapindex/i.test(xml);
      for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        const loc = decodeXml(m[1] ?? "");
        if (!loc) continue;
        if (isIndex) next.push(loc);
        else found.push(loc);
      }
    }
    frontier = next;
  }
  return found;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Breadth-first crawl over raw HTML. Server-rendered links only — a fully
 * client-rendered SPA will yield nothing here, use --paths-file for those.
 */
async function crawl(
  origin: string,
  depth: number,
  keepQuery: boolean,
  cap: number,
): Promise<string[]> {
  const seen = new Set<string>(["/"]);
  let frontier = ["/"];

  for (let d = 0; d < depth && frontier.length && seen.size < cap; d++) {
    const next: string[] = [];
    for (const path of frontier) {
      if (seen.size >= cap) break;
      const pageUrl = new URL(path, origin).href;
      const html = await fetchText(pageUrl);
      if (!html) continue;
      for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
        const norm = normalisePath(m[1] ?? "", origin, keepQuery, pageUrl);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        next.push(norm);
        if (seen.size >= cap) break;
      }
    }
    frontier = next;
  }
  return [...seen];
}

/**
 * Count-based collapse, complementing the shape-based templateKey: when one
 * parent has many distinct children at the same depth, that segment is a slug
 * whatever it looks like. This is what actually tames /docs/api/{500 pages},
 * while leaving the handful of top-level pages (/about, /pricing) alone.
 */
const SIBLING_COLLAPSE = 8;

export function positionalCollapser(templatedPaths: string[]): (templated: string) => string {
  const childrenOf = new Map<string, Set<string>>();
  for (const p of templatedPaths) {
    const segs = segmentsOf(p);
    for (let i = 0; i < segs.length; i++) {
      const parent = "/" + segs.slice(0, i).join("/");
      let bucket = childrenOf.get(parent);
      if (!bucket) {
        bucket = new Set<string>();
        childrenOf.set(parent, bucket);
      }
      bucket.add(segs[i]!);
    }
  }

  return (templated: string): string => {
    const segs = segmentsOf(templated);
    const collapsed = segs.map((seg, i) => {
      const parent = "/" + segs.slice(0, i).join("/");
      return (childrenOf.get(parent)?.size ?? 0) >= SIBLING_COLLAPSE ? ":slug" : seg;
    });
    return "/" + collapsed.join("/");
  };
}

function segmentsOf(path: string): string[] {
  return (path.split("?")[0] ?? "/").split("/").filter(Boolean);
}

export async function discoverPaths(
  origin: string,
  opts: DiscoverOptions,
): Promise<{ paths: string[]; dropped: number }> {
  const raw = new Set<string>();

  if (opts.useSitemap) {
    const locs = await sitemapUrls(origin);
    let accepted = 0;
    for (const loc of locs) {
      const norm = normalisePath(loc, origin, opts.keepQuery);
      if (norm) {
        raw.add(norm);
        accepted++;
      }
    }
    if (locs.length > 0 && accepted === 0) {
      console.warn(
        `sitemap: found ${locs.length} entries but none matched ${new URL(origin).hostname} — different host? falling back to crawl`,
      );
    }
  }
  if (opts.crawlDepth > 0) {
    // Crawl cap is generous here; the real trimming happens per-template below.
    const crawlCap = (opts.limit ?? 500) * 10;
    for (const path of await crawl(origin, opts.crawlDepth, opts.keepQuery, crawlCap)) {
      raw.add(path);
    }
  }
  raw.add("/");

  const kept = [...raw]
    .filter((p) => !opts.exclude.some((re) => re.test(p)))
    .sort((x, y) => x.split("/").length - y.split("/").length || x.localeCompare(y));

  const templated = kept.map(templateKey);
  const collapse = positionalCollapser(templated);

  const perTemplate = new Map<string, number>();
  const paths: string[] = [];
  for (const [index, path] of kept.entries()) {
    const key = collapse(templated[index]!);
    const count = perTemplate.get(key) ?? 0;
    if (count >= opts.perTemplate) continue;
    perTemplate.set(key, count + 1);
    paths.push(path);
    if (opts.limit !== null && paths.length >= opts.limit) break;
  }

  return { paths, dropped: kept.length - paths.length };
}
