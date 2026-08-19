import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { capture, makeContext } from "./capture.ts";
import { diffPair } from "./diff.ts";
import { writeReport } from "./report.ts";
import type { Config, PageResult } from "./types.ts";

/**
 * Filename-safe stem for a path. The hash suffix matters: slugging is lossy
 * (and truncating), so /a/b and /a_b would otherwise share a filename and
 * silently overwrite each other's screenshots — diffing the wrong pair.
 */
export function slug(path: string): string {
  const cleaned = path.replace(/^\//, "").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 6);
  return `${cleaned === "" ? "root" : cleaned}_${hash}`;
}

/** Bounded-concurrency map; keeps browser memory flat on large path lists. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function run(cfg: Config, onProgress: (done: number, total: number) => void): Promise<PageResult[]> {
  const shotDir = join(cfg.outDir, "shots");
  await mkdir(shotDir, { recursive: true });

  const browser = await chromium.launch({ headless: cfg.headless });
  const results: PageResult[] = [];
  const total = cfg.paths.length * cfg.viewports.length;
  let done = 0;

  try {
    for (const viewport of cfg.viewports) {
      // One context per side per viewport: separate origins, separate storage.
      const ctxA = await makeContext(browser, cfg, viewport);
      const ctxB = await makeContext(browser, cfg, viewport);

      try {
        const viewportResults = await pool(cfg.paths, cfg.concurrency, async (path) => {
          const base = `${slug(path)}__${viewport.name}`;
          const aFile = join(shotDir, `${base}__a.png`);
          const bFile = join(shotDir, `${base}__b.png`);
          const dFile = join(shotDir, `${base}__diff.png`);

          const [a, b] = await Promise.all([
            capture(ctxA, cfg.a, path, aFile, cfg),
            capture(ctxB, cfg.b, path, bFile, cfg),
          ]);

          let diff: PageResult["diff"];
          if (!a.ok || !b.ok) {
            diff = { kind: "skipped", reason: a.ok ? "b failed to load" : "a failed to load" };
          } else {
            try {
              diff = await diffPair(aFile, bFile, dFile, { threshold: cfg.threshold, tolerance: cfg.tolerance });
            } catch (err) {
              diff = { kind: "skipped", reason: err instanceof Error ? err.message : String(err) };
            }
          }

          onProgress(++done, total);
          return { path, viewport: viewport.name, a, b, diff } satisfies PageResult;
        });

        results.push(...viewportResults);
      } finally {
        await ctxA.close().catch(() => {});
        await ctxB.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  await writeReport(
    { a: cfg.a, b: cfg.b, generatedAt: new Date().toISOString(), results },
    join(cfg.outDir, "index.html"),
  );

  return results;
}
