#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPaths } from "./discover.ts";
import { run } from "./run.ts";
import type { Config, Viewport } from "./types.ts";

const USAGE = `sidediff — visually compare two live sites across many paths

  bun run compare --a https://old.example --b https://new.example [options]

Path discovery (default: sitemap + crawl depth 2)
  --paths-file <file>   newline-separated paths; skips discovery entirely
  --paths <a,b,c>       explicit comma-separated paths
  --no-sitemap          don't read robots.txt / sitemap.xml
  --crawl-depth <n>     link-crawl depth from / on site A (default 2, 0 disables)
  --limit <n>           max paths overall (default 200; "none" for uncapped)
  --per-template <n>    max sample paths per URL template (default 3)
  --keep-query          treat ?query strings as distinct paths
  --exclude <re,re>     regexes; paths matching any are dropped

Capture
  --viewports <list>    name:wxh,... (default desktop:1280x800,mobile:390x844)
  --concurrency <n>     parallel path comparisons (default 4)
  --hide <sel,sel>      selectors to display:none (cookie banners, chat widgets)
  --mask <sel,sel>      selectors to paint over before diffing (ads, carousels)
  --block <host,host>   request hosts to abort (default: common analytics/ads)
  --freeze-time <iso>   pin Date/Math.random; "none" to disable
  --settle <ms>         extra wait after load (default 400)
  --timeout <ms>        navigation timeout (default 30000)
  --hide-fixed          hide position:fixed elements (chat widgets, floating CTAs)
  --headed              run a visible browser (helps past bot protection)
  --no-text             skip the rendered-text and meta-tag diff

Diff
  --threshold <0-1>     per-pixel colour threshold (default 0.1)
  --tolerance <pct>     page diff % below which a page counts as identical (default 0.05)
  --out <dir>           output directory (default ./sidediff-out)
`;

const DEFAULT_BLOCK = [
  "google-analytics.com", "googletagmanager.com", "doubleclick.net", "googlesyndication.com",
  "facebook.net", "connect.facebook.net", "hotjar.com", "clarity.ms", "segment.com",
  "intercom.io", "sentry.io", "newrelic.com", "adservice.google.com",
];

const DEFAULT_HIDE = [
  "#onetrust-consent-sdk", "#CybotCookiebotDialog", ".cookie-banner", "#cookie-banner",
  "[id*='cookie-consent']", "[class*='cookie-consent']", "#usercentrics-root",
];

function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

const str = (m: Map<string, string | true>, k: string): string | null => {
  const v = m.get(k);
  return typeof v === "string" ? v : null;
};
const list = (m: Map<string, string | true>, k: string): string[] =>
  (str(m, k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function num(m: Map<string, string | true>, k: string, fallback: number): number {
  const raw = str(m, k);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${k} must be a number, got "${raw}"`);
  return parsed;
}

function parseViewports(raw: string): Viewport[] {
  return raw.split(",").map((entry) => {
    const match = /^([\w-]+):(\d+)x(\d+)$/.exec(entry.trim());
    if (!match) throw new Error(`bad viewport "${entry}", expected name:WIDTHxHEIGHT`);
    return { name: match[1]!, width: Number(match[2]), height: Number(match[3]) };
  });
}

function normaliseOrigin(raw: string, flag: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw new Error(`--${flag} is not a valid URL: ${raw}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const wantsHelp = args.has("help") || args.has("h") || process.argv.includes("-h");
  if (wantsHelp || !args.has("a") || !args.has("b")) {
    console.log(USAGE);
    return wantsHelp ? 0 : 1;
  }

  const a = normaliseOrigin(str(args, "a") ?? "", "a");
  const b = normaliseOrigin(str(args, "b") ?? "", "b");

  let paths: string[];
  const pathsFile = str(args, "paths-file");
  if (pathsFile) {
    paths = (await readFile(pathsFile, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } else if (args.has("paths")) {
    paths = list(args, "paths");
  } else {
    const limitRaw = str(args, "limit");
    const discovered = await discoverPaths(a, {
      useSitemap: !args.has("no-sitemap"),
      crawlDepth: num(args, "crawl-depth", 2),
      limit: limitRaw === "none" ? null : num(args, "limit", 200),
      perTemplate: num(args, "per-template", 3),
      keepQuery: args.has("keep-query"),
      exclude: list(args, "exclude").map((re) => new RegExp(re)),
    });
    paths = discovered.paths;
    if (discovered.dropped > 0) {
      console.log(`discovery: kept ${paths.length} paths, dropped ${discovered.dropped} (template cap / limit)`);
    }
  }

  if (paths.length === 0) {
    console.error("no paths to compare — try --paths-file, or --crawl-depth 3, or check the sitemap");
    return 1;
  }

  const freezeRaw = str(args, "freeze-time");
  const cfg: Config = {
    a,
    b,
    paths,
    outDir: resolve(str(args, "out") ?? "sidediff-out"),
    viewports: parseViewports(str(args, "viewports") ?? "desktop:1280x800,mobile:390x844"),
    concurrency: num(args, "concurrency", 4),
    threshold: num(args, "threshold", 0.1),
    tolerance: num(args, "tolerance", 0.05),
    maskSelectors: list(args, "mask"),
    hideSelectors: args.has("hide") ? list(args, "hide") : DEFAULT_HIDE,
    blockHosts: args.has("block") ? list(args, "block") : DEFAULT_BLOCK,
    navTimeout: num(args, "timeout", 30_000),
    settleMs: num(args, "settle", 400),
    headless: !args.has("headed"),
    hideFixed: args.has("hide-fixed"),
    collectText: !args.has("no-text"),
    freezeTime: freezeRaw === "none" ? null : (freezeRaw ?? "2020-01-01T00:00:00Z"),
  };

  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  console.log(`comparing ${cfg.paths.length} paths × ${cfg.viewports.length} viewports\n  A ${cfg.a}\n  B ${cfg.b}`);

  const results = await run(cfg, (done, total) => {
    process.stdout.write(`\r  ${done}/${total}`);
  });
  process.stdout.write("\n");

  const changed = results.filter((r) => r.diff.kind === "diff" || r.diff.kind === "layout").length;
  const failed = results.filter((r) => !r.a.ok || !r.b.ok).length;
  console.log(`\n${changed} changed · ${failed} failed to load · report: ${cfg.outDir}/index.html`);

  return changed > 0 || failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
