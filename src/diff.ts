import { compare } from "odiff-bin";
import { open } from "node:fs/promises";
import type { DiffOutcome } from "./types.ts";

/**
 * Read width/height straight out of the PNG IHDR chunk. odiff will happily diff
 * mismatched images, but it counts the entire non-overlapping area as changed —
 * so we need our own size check to label those results honestly.
 */
export async function pngSize(file: string): Promise<{ width: number; height: number } | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buf = Buffer.alloc(24);
    const { bytesRead } = await handle.read(buf, 0, 24, 0);
    if (bytesRead < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface DiffOptions {
  threshold: number;
  tolerance: number;
}

/**
 * A change smaller than the tolerance percentage still matters if it is large in
 * absolute terms — on a 20 000px-tall page, 0.05% is ~100k pixels, enough to hide
 * a whole swapped button. 20k pixels is roughly a 100×100 CSS-px element at dsf 2.
 */
const MIN_ABSOLUTE_PIXELS = 20_000;

export async function diffPair(
  aFile: string,
  bFile: string,
  diffFile: string,
  opts: DiffOptions,
): Promise<DiffOutcome> {
  const [aSize, bSize] = await Promise.all([pngSize(aFile), pngSize(bFile)]);

  const result = await compare(aFile, bFile, diffFile, {
    threshold: opts.threshold,
    antialiasing: true,
    // Keep going when the two pages are different heights; we classify the result
    // as "layout" ourselves below rather than bailing with no information.
    failOnLayoutDiff: false,
    diffColor: "#ff00ff",
    reduceRamUsage: true,
  });

  if (result.match) return { kind: "match" };

  if (result.reason === "layout-diff") return { kind: "layout", percentage: null, diffImage: null };
  if (result.reason === "file-not-exists") throw new Error(`odiff: missing file ${result.file}`);

  // The odiff wrapper drops these fields when it cannot parse the binary's stdout.
  // Treating that as 0% would report a known-different page as identical.
  const { diffPercentage, diffCount } = result as { diffPercentage?: number; diffCount?: number };
  if (diffPercentage === undefined || diffCount === undefined) {
    return { kind: "skipped", reason: "odiff produced unparsable output" };
  }

  const sizeMismatch =
    aSize !== null && bSize !== null && (aSize.width !== bSize.width || aSize.height !== bSize.height);

  // Size mismatches always surface: tolerance is meaningless when the percentage
  // is dominated by the non-overlapping region.
  if (sizeMismatch) return { kind: "layout", percentage: diffPercentage, diffImage: diffFile };

  if (diffPercentage < opts.tolerance && diffCount < MIN_ABSOLUTE_PIXELS) return { kind: "match" };

  return { kind: "diff", percentage: diffPercentage, pixels: diffCount, diffImage: diffFile };
}
