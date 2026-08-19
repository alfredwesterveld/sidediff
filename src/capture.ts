import type { Browser, BrowserContext, Page } from "playwright";
import { extractText } from "./text.ts";
import type { CaptureResult, Config, Viewport } from "./types.ts";

/**
 * Rendering nondeterminism is the whole game here. Everything in this module
 * exists to make two different servers produce byte-comparable pixels.
 */

const STABILISE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
video, [class*="carousel"] [class*="autoplay"] { visibility: hidden !important; }
`;

export async function makeContext(
  browser: Browser,
  cfg: Config,
  viewport: Viewport,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    // Pin these: locale and timezone leak into rendered dates and number formats.
    locale: "en-US",
    timezoneId: "UTC",
  });

  if (cfg.blockHosts.length) {
    await context.route("**/*", (route) => {
      const host = safeHost(route.request().url());
      if (host && cfg.blockHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        return route.abort();
      }
      return route.continue();
    });
  }

  if (cfg.freezeTime) {
    const frozen = Date.parse(cfg.freezeTime);
    if (Number.isNaN(frozen)) throw new Error(`--freeze-time is not a parseable date: ${cfg.freezeTime}`);
    await context.addInitScript(freezeScript, frozen);
  }

  return context;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Runs before any page script. Freezes the clock and makes Math.random
 * deterministic so client-rendered timestamps and shuffles stop diffing.
 *
 * A Proxy rather than a subclass: plenty of libraries call `Date()` without
 * `new`, which a class constructor rejects with a TypeError. That throw would
 * break rendering on *both* sides identically — two broken pages screenshot the
 * same and get reported as a match, which is the worst failure this tool has.
 */
function freezeScript(frozen: number): void {
  const RealDate = Date;
  const FrozenDate = new Proxy(RealDate, {
    apply: () => new RealDate(frozen).toString(),
    construct: (_target, args: unknown[]) =>
      args.length === 0
        ? new RealDate(frozen)
        : Reflect.construct(RealDate, args as ConstructorParameters<typeof Date>),
    get: (target, prop, receiver) => (prop === "now" ? () => frozen : Reflect.get(target, prop, receiver)),
  });
  window.Date = FrozenDate;

  let seed = 0x2f6e2b1;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  // Monotonic but deterministic. A constant clock stalls rAF-driven easings
  // mid-animation, which can leave entrance-animated content stuck invisible.
  if (typeof performance !== "undefined") {
    let ticks = 0;
    performance.now = () => (ticks += 16);
  }
}

export async function capture(
  context: BrowserContext,
  origin: string,
  path: string,
  outFile: string,
  cfg: Config,
): Promise<CaptureResult> {
  const page: Page = await context.newPage();
  const target = new URL(path, origin).href;

  try {
    const response = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: cfg.navTimeout,
    });

    const status = response?.status() ?? null;
    const finalUrl = page.url();
    const finalPath = pathOf(finalUrl);
    const redirected = pathOf(target) !== finalPath;

    if (status === null || status >= 400) {
      return { ok: false, status, finalPath, redirected, screenshot: null, text: null, error: `HTTP ${status ?? "no response"}` };
    }

    await stabilise(page, cfg);

    // Cheap while the page is already open, and immune to the height mismatches
    // that make pixel percentages hard to read.
    const text = cfg.collectText ? await extractText(page) : null;

    await page.screenshot({
      path: outFile,
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      mask: cfg.maskSelectors.map((sel) => page.locator(sel)),
      timeout: cfg.navTimeout,
    });

    return { ok: true, status, finalPath, redirected, screenshot: outFile, text, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      finalPath: null,
      redirected: false,
      screenshot: null,
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function pathOf(url: string): string | null {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return p + u.search;
  } catch {
    return null;
  }
}

async function stabilise(page: Page, cfg: Config): Promise<void> {
  await page.addStyleTag({ content: STABILISE_CSS }).catch(() => {});

  // Consent banners differ between the two sites, so without this every page diffs.
  for (const sel of cfg.hideSelectors) {
    await page
      .locator(sel)
      .evaluateAll((els) => {
        for (const el of els) (el as HTMLElement).style.setProperty("display", "none", "important");
      })
      .catch(() => {});
  }

  await autoScroll(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: cfg.navTimeout }).catch(() => {});
  await page.waitForTimeout(cfg.settleMs);

  // Last, so late-hydrating elements don't reinstate themselves afterwards.
  await unstick(page, cfg.hideFixed);
}

/**
 * Sticky elements are pinned to static: captured at scroll-top they can occlude
 * content ambiguously. Fixed elements are left alone by default — modern Chromium
 * renders them once in a full-page shot, and fixed navs and CTAs are exactly what
 * a redesign changes, so hiding them by default would blind the diff to real work.
 */
async function unstick(page: Page, hideFixed: boolean): Promise<void> {
  await page
    .evaluate((shouldHideFixed: boolean) => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const pos = getComputedStyle(el).position;
        if (pos === "sticky") el.style.setProperty("position", "static", "important");
        else if (pos === "fixed" && shouldHideFixed) el.style.setProperty("visibility", "hidden", "important");
      }
    }, hideFixed)
    .catch(() => {});
}

/** Scroll to the bottom in viewport steps to trigger lazy-loading, then return to top. */
async function autoScroll(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const scroller = document.scrollingElement ?? document.documentElement;
      const step = window.innerHeight;
      const maxSteps = 100;
      for (let i = 0; i < maxSteps; i++) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + step;
        await new Promise((r) => setTimeout(r, 120));
        const atBottom = scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 2;
        if (scroller.scrollTop === before || atBottom) break;
      }
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 120));
    })
    .catch(() => {});
}
