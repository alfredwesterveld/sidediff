export type Side = "a" | "b";

export interface Config {
  a: string;
  b: string;
  paths: string[];
  outDir: string;
  viewports: Viewport[];
  concurrency: number;
  threshold: number;
  /** Per-page diff % under which a page is treated as unchanged. */
  tolerance: number;
  maskSelectors: string[];
  hideSelectors: string[];
  blockHosts: string[];
  navTimeout: number;
  settleMs: number;
  headless: boolean;
  hideFixed: boolean;
  freezeTime: string | null;
}

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

/** Result of loading one URL on one side, before any diffing. */
export interface CaptureResult {
  ok: boolean;
  status: number | null;
  /** Final URL after redirects, normalised to a path. */
  finalPath: string | null;
  redirected: boolean;
  screenshot: string | null;
  error: string | null;
}

export type DiffOutcome =
  | { kind: "match" }
  | { kind: "diff"; percentage: number; pixels: number; diffImage: string }
  | { kind: "layout"; percentage: number | null; diffImage: string | null }
  | { kind: "skipped"; reason: string };

export interface PageResult {
  path: string;
  viewport: string;
  a: CaptureResult;
  b: CaptureResult;
  diff: DiffOutcome;
}

export interface Report {
  a: string;
  b: string;
  generatedAt: string;
  results: PageResult[];
}
