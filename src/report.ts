import { writeFile } from "node:fs/promises";
import { relative, dirname } from "node:path";
import type { PageResult, Report } from "./types.ts";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function rel(from: string, to: string | null): string {
  return to === null ? "" : relative(dirname(from), to).split("\\").join("/");
}

function pctOf(r: PageResult): number {
  if (r.diff.kind === "diff") return r.diff.percentage;
  if (r.diff.kind === "layout") return r.diff.percentage ?? 0;
  return 0;
}

/** A page whose pixels match but whose copy changed must not be filed under "match". */
function textOnly(r: PageResult): boolean {
  return r.diff.kind === "match" && (r.text?.changed ?? 0) + (r.text?.metaChanged ?? 0) > 0;
}

function severity(r: PageResult): number {
  if (!r.a.ok || !r.b.ok) return 4;
  if (r.diff.kind === "layout") return 3;
  if (r.diff.kind === "diff") return 2;
  if (textOnly(r)) return 1;
  return 0;
}

export async function writeReport(report: Report, file: string): Promise<void> {
  const rows = [...report.results].sort((x, y) => {
    const bySeverity = severity(y) - severity(x);
    if (bySeverity !== 0) return bySeverity;
    const px = pctOf(x);
    const py = pctOf(y);
    return py - px;
  });

  const counts = {
    errors: rows.filter((r) => !r.a.ok || !r.b.ok).length,
    layout: rows.filter((r) => r.a.ok && r.b.ok && r.diff.kind === "layout").length,
    diffs: rows.filter((r) => r.diff.kind === "diff").length,
    text: rows.filter(textOnly).length,
    match: rows.filter((r) => r.diff.kind === "match" && !textOnly(r)).length,
    skipped: rows.filter((r) => r.a.ok && r.b.ok && r.diff.kind === "skipped").length,
  };

  const data = rows.map((r) => ({
    path: r.path,
    viewport: r.viewport,
    status: `${r.a.status ?? "—"} / ${r.b.status ?? "—"}`,
    redirect: r.a.redirected || r.b.redirected ? `${r.a.finalPath ?? "?"} / ${r.b.finalPath ?? "?"}` : "",
    error: r.a.error ?? r.b.error ?? (r.diff.kind === "skipped" ? r.diff.reason : ""),
    kind: !r.a.ok || !r.b.ok ? "error" : textOnly(r) ? "text" : r.diff.kind,
    textChanged: r.text?.changed ?? 0,
    metaChanged: r.text?.metaChanged ?? 0,
    // Cap the embedded diff: a handful of runaway pages shouldn't bloat the report.
    hunks: (r.text?.hunks ?? []).slice(0, 40).map((h) => h.slice(0, 60)),
    meta: r.text?.meta ?? [],
    pct: r.diff.kind === "diff" || r.diff.kind === "layout" ? r.diff.percentage : null,
    aImg: rel(file, r.a.screenshot),
    bImg: rel(file, r.b.screenshot),
    dImg: r.diff.kind === "diff" || r.diff.kind === "layout" ? rel(file, r.diff.diffImage) : "",
  }));

  await writeFile(file, page(report, counts, data), "utf8");
}

function page(report: Report, counts: Record<string, number>, data: unknown[]): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>sidediff — ${esc(report.a)} vs ${esc(report.b)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#131316; --fg:#e8e8ea; --muted:#9a9aa2; --line:#2b2b31; --card:#1b1b20; } }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--muted); margin-bottom:16px; }
  .tags span { display:inline-block; padding:3px 9px; border:1px solid var(--line); border-radius:99px; margin-right:6px; }
  table { border-collapse:collapse; width:100%; margin-top:16px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { position:sticky; top:0; background:var(--bg); cursor:pointer; user-select:none; }
  tr[data-kind] { cursor:pointer; }
  tr:hover td { background:var(--card); }
  .pill { font-size:12px; padding:1px 7px; border-radius:4px; }
  .error { background:#c0392b; color:#fff; } .layout { background:#c07a00; color:#fff; }
  .diff { background:#8e44ad; color:#fff; } .match { background:#2d7a35; color:#fff; }
  .skipped { background:#555; color:#fff; } .text { background:#0b6b8f; color:#fff; }
  .tdiff { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; line-height:1.55; }
  .tdiff .h { padding:6px 12px; color:var(--muted); border-top:1px solid var(--line); background:var(--bg); }
  .tdiff div.l { padding:1px 12px; white-space:pre-wrap; word-break:break-word; }
  .tdiff .add { background:#1b5e2033; border-left:3px solid #2d7a35; }
  .tdiff .del { background:#8b1e1e33; border-left:3px solid #c0392b; }
  .tdiff .ctx { border-left:3px solid transparent; color:var(--muted); }
  .mtab { width:100%; border-collapse:collapse; font-size:12.5px; }
  .mtab td, .mtab th { border-bottom:1px solid var(--line); padding:6px 12px; vertical-align:top; text-align:left; }
  .mtab td.k { font-family:ui-monospace,monospace; color:var(--muted); white-space:nowrap; }
  .mtab .was { color:#c0392b; } .mtab .now { color:#2d7a35; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  dialog { width:min(96vw,1400px); border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--fg); padding:0; }
  dialog::backdrop { background:#000c; }
  .head { display:flex; gap:12px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
  .head .mono { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .modes button { margin-left:6px; }
  .stage { position:relative; overflow:auto; max-height:78vh; background:var(--card); }
  .stage img { display:block; width:100%; }
  .wrap { position:relative; }
  .wrap .over { position:absolute; inset:0; }
  .over img { position:absolute; top:0; left:0; }
  #clip { overflow:hidden; }
  input[type=range] { width:220px; }
</style>
<h1>${esc(report.a)} <span style="color:var(--muted)">vs</span> ${esc(report.b)}</h1>
<div class="sub">${esc(report.generatedAt)} · ${report.results.length} comparisons</div>
<div class="tags">
  <span class="pill error">errors ${counts.errors}</span>
  <span class="pill layout">size mismatch ${counts.layout}</span>
  <span class="pill diff">changed ${counts.diffs}</span>
  <span class="pill text">text only ${counts.text}</span>
  <span class="pill match">identical ${counts.match}</span>
  <span class="pill skipped">skipped ${counts.skipped}</span>
</div>
<table id="t">
  <thead><tr><th data-k="kind">status</th><th data-k="path">path</th><th data-k="viewport">viewport</th><th data-k="pct">diff %</th><th data-k="textChanged">text ±</th><th data-k="status">HTTP a/b</th><th data-k="error">notes</th></tr></thead>
  <tbody></tbody>
</table>

<dialog id="dlg">
  <div class="head">
    <strong id="dpath" class="mono"></strong>
    <span class="modes">
      <input type="range" id="slider" min="0" max="100" value="50">
      <button data-mode="slide">slide</button>
      <button data-mode="side">side by side</button>
      <button data-mode="diff">diff</button>
      <button data-mode="text">text</button>
      <button id="close">close</button>
    </span>
  </div>
  <div class="stage" id="stage"></div>
</dialog>

<script>
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ROWS = ${JSON.stringify(data).replace(/</g, "\\u003c")};
const tbody = document.querySelector('#t tbody');
let sortKey = null, sortDir = 1;

function render(rows) {
  tbody.innerHTML = rows.map((r, i) => \`<tr data-i="\${i}" data-kind="\${r.kind}">
    <td><span class="pill \${esc(r.kind)}">\${esc(r.kind)}</span></td>
    <td class="mono">\${esc(r.path)}</td>
    <td>\${esc(r.viewport)}</td>
    <td>\${r.pct === null ? '' : r.pct.toFixed(2) + '%'}</td>
    <td>\${r.textChanged ? r.textChanged : ''}\${r.metaChanged ? ' · meta ' + r.metaChanged : ''}</td>
    <td>\${esc(r.status)}</td>
    <td>\${esc([r.error, r.redirect && 'redirect: ' + r.redirect].filter(Boolean).join(' · '))}</td>
  </tr>\`).join('');
}
render(ROWS);

document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : 1;
  sortKey = k;
  const sorted = [...ROWS].sort((a, b) => {
    const empty = k === 'pct' ? -Infinity : '';
    const x = a[k] ?? empty, y = b[k] ?? empty;
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
  });
  render(sorted);
  window.CURRENT = sorted;
});
window.CURRENT = ROWS;

const dlg = document.getElementById('dlg');
const stage = document.getElementById('stage');
const slider = document.getElementById('slider');
let mode = 'slide', row = null;

tbody.onclick = (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  row = window.CURRENT[+tr.dataset.i];
  if (!row.aImg && !row.bImg) return;
  document.getElementById('dpath').textContent = row.path + '  ·  ' + row.viewport;
  draw();
  dlg.showModal();
};
document.getElementById('close').onclick = () => dlg.close();
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; draw(); });
slider.oninput = () => { const c = document.getElementById('clip'); if (c) c.style.width = slider.value + '%'; };

function draw() {
  if (!row) return;
  if (mode === 'side') {
    stage.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      \`<img src="\${esc(row.aImg)}" alt="A"><img src="\${esc(row.bImg)}" alt="B">\` + '</div>';
  } else if (mode === 'text') {
    const meta = (row.meta || []).map(m => m.detail && m.detail.length
      ? \`<tr><td class="k">\${esc(m.key)}</td><td colspan="2">\${m.detail.map(d =>
          \`<div class="\${d[0] === '+' ? 'now' : 'was'}">\${esc(d)}</div>\`).join('')}</td></tr>\`
      : \`<tr><td class="k">\${esc(m.key)}</td><td class="was">\${esc(m.a) || '<em>empty</em>'}</td><td class="now">\${esc(m.b) || '<em>empty</em>'}</td></tr>\`).join('');
    const hunks = (row.hunks || []).map((h, i) =>
      '<div class="h">@@ hunk ' + (i + 1) + ' @@</div>' +
      h.map(op => \`<div class="l \${op.type}">\${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '} \${esc(op.text)}</div>\`).join('')
    ).join('');
    stage.innerHTML =
      (meta ? '<table class="mtab"><thead><tr><th>tag</th><th>A</th><th>B</th></tr></thead><tbody>' + meta + '</tbody></table>' : '') +
      (hunks ? '<div class="tdiff">' + hunks + '</div>' : '') ||
      '<p style="padding:16px">no text differences</p>';
  } else if (mode === 'diff') {
    stage.innerHTML = row.dImg ? \`<img src="\${esc(row.dImg)}" alt="diff">\` : '<p style="padding:16px">no diff image</p>';
  } else {
    stage.innerHTML = \`<div class="wrap"><img src="\${esc(row.bImg)}" alt="B">
      <div class="over"><div id="clip" style="width:\${slider.value}%"><img src="\${esc(row.aImg)}" alt="A"></div></div></div>\`;
    const wrap = stage.querySelector('.wrap');
    const clip = stage.querySelector('#clip');
    const under = wrap.querySelector('img');
    const set = () => { const w = under.getBoundingClientRect().width; clip.firstElementChild.style.width = w + 'px'; };
    under.complete ? set() : under.addEventListener('load', set);
  }
}
</script>`;
}
