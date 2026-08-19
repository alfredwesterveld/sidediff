import type { Page } from "playwright";
import type { MetaChange, PageText, TextDiff, TextDiffOp } from "./types.ts";

/** Meta tags worth reporting on a migration. Order here is the display order. */
const META_KEYS = [
  "title",
  "description",
  "canonical",
  "robots",
  "og:title",
  "og:description",
  "og:image",
  "twitter:card",
] as const;

/** Guard against pathological pages; the LCS below is O(n*m). */
const MAX_LINES = 3000;

/**
 * Pull the *rendered* text, not the markup. Class hashes, build ids and
 * attribute order churn on every build, so a raw HTML diff reports 100% changed
 * on a visually identical page. innerText survives all of that.
 */
export async function extractText(page: Page): Promise<PageText | null> {
  try {
    return await page.evaluate(() => {
      const attr = (sel: string, name: string): string =>
        document.querySelector(sel)?.getAttribute(name)?.trim() ?? "";

      const meta: Record<string, string> = {
        title: document.title.trim(),
        description: attr('meta[name="description"]', "content"),
        canonical: attr('link[rel="canonical"]', "href"),
        robots: attr('meta[name="robots"]', "content"),
        "og:title": attr('meta[property="og:title"]', "content"),
        "og:description": attr('meta[property="og:description"]', "content"),
        "og:image": attr('meta[property="og:image"]', "content"),
        "twitter:card": attr('meta[name="twitter:card"]', "content"),
      };

      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
        .map((h) => `${h.tagName.toLowerCase()}  ${(h.textContent ?? "").replace(/\s+/g, " ").trim()}`)
        .filter((h) => h.length > 4);

      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((a) => `${(a.textContent ?? "").replace(/\s+/g, " ").trim()} → ${a.getAttribute("href") ?? ""}`)
        .filter((l) => l.length > 3);

      const raw = (document.body?.innerText ?? "").replace(/ /g, " ");
      const lines = raw
        .split("\n")
        .map((l) => l.replace(/[ \t]+/g, " ").trim())
        .filter((l) => l.length > 0);

      return { lines, meta, headings, links: Array.from(new Set(links)) };
    });
  } catch {
    return null;
  }
}

/**
 * Longest common subsequence over lines, rendered as GitHub-style hunks.
 * Plain DP: page text is hundreds of lines, not hundreds of thousands.
 */
function lcsOps(a: string[], b: string[]): TextDiffOp[] {
  const n = Math.min(a.length, MAX_LINES);
  const m = Math.min(b.length, MAX_LINES);

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: TextDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++]! });
  while (j < m) ops.push({ type: "add", text: b[j++]! });
  return ops;
}

/** Collapse long runs of unchanged lines, keeping `context` on each side. */
function toHunks(ops: TextDiffOp[], context = 3): TextDiffOp[][] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === "ctx") return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) {
      keep[k] = true;
    }
  });

  const hunks: TextDiffOp[][] = [];
  let current: TextDiffOp[] = [];
  ops.forEach((op, index) => {
    if (keep[index]) current.push(op);
    else if (current.length) {
      hunks.push(current);
      current = [];
    }
  });
  if (current.length) hunks.push(current);
  return hunks;
}

function diffList(label: string, a: string[], b: string[]): MetaChange[] {
  const removed = a.filter((x) => !b.includes(x));
  const added = b.filter((x) => !a.includes(x));
  if (!removed.length && !added.length) return [];
  return [{ key: label, a: `${a.length} items`, b: `${b.length} items`, detail: [
    ...removed.slice(0, 20).map((x) => `- ${x}`),
    ...added.slice(0, 20).map((x) => `+ ${x}`),
  ] }];
}

export function diffText(a: PageText, b: PageText): TextDiff {
  const ops = lcsOps(a.lines, b.lines);
  const added = ops.filter((o) => o.type === "add").length;
  const removed = ops.filter((o) => o.type === "del").length;

  const meta: MetaChange[] = [];
  for (const key of META_KEYS) {
    const av = a.meta[key] ?? "";
    const bv = b.meta[key] ?? "";
    if (av !== bv) meta.push({ key, a: av, b: bv, detail: [] });
  }
  meta.push(...diffList("headings", a.headings, b.headings));
  meta.push(...diffList("links", a.links, b.links));

  return {
    added,
    removed,
    changed: added + removed,
    metaChanged: meta.length,
    hunks: added + removed > 0 ? toHunks(ops) : [],
    meta,
  };
}
