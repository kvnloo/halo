#!/usr/bin/env node
/**
 * refcheck — is the ground truth the shape every score assumes, and can anyone rebuild it?
 *
 *   node tools/refcheck.mjs            # geometry + inventory + rebuild-recipe audit
 *   node tools/refcheck.mjs --json
 *   node tools/refcheck.mjs --warn     # always exit 0 (what preflight uses)
 *   node tools/refcheck.mjs --res 1920x1080     # override the expected capture geometry
 *
 * WHY THIS EXISTS
 * ---------------
 * Every number in `scores/history.jsonl`, `docs/TARGETS.md` and 30 reports is a comparison
 * against `ref/`. `ref/` is gitignored, was extracted by hand, and the README says so:
 * "No script survives for this — the extraction was done by hand early on and never got
 * written down." What the README *does* print is a rebuild recipe, and that recipe is the
 * only instruction any second machine will ever have. Nothing has ever checked it.
 *
 * T3 (`tools/refstamp.mjs`) fingerprints whatever is on disk. That is the right tool for
 * "did MY reference drift". It structurally cannot catch this one: on a fresh machine you
 * generate the manifest *from your own rebuilt `ref/`*, and it certifies itself green.
 *
 * MEASURED, 2026-07-31 — the README recipe does not reproduce this reference set:
 *
 *   $ ffmpeg -i reference.mp4 -vf "select='not(mod(n,15))'" -vsync 0 \
 *            -frame_pts 1 -frames:v 2 <scratch>/kf_%05d.png       # README.md verbatim
 *     -> kf_00000.png  3840x2160, 6.0 MB
 *   $ ref/keyframes/kf_00000.png
 *     -> 1920x1080, 2.5 MB
 *
 * That is not a cosmetic difference. `tools/metrics.py:298` resizes the *test* image to the
 * *reference's* size:
 *
 *     test = load(test_path, size=(ref.shape[1], ref.shape[0]))
 *
 * so a 4K `ref/` silently upscales every 1080p render 2x before scoring. `lap_ratio`,
 * `edge_ratio`, `ms_ssim` and `detail` all move, nothing errors, nothing warns, and the
 * resulting numbers are quietly incomparable to every row already in the history. This is
 * the §26 shape (`--settle` worth 0.52 points and recorded nowhere) with a much bigger lever.
 *
 * Two more, same block, same measurement session:
 *   * `.venv/bin/python tools/roi.py --all ref/keyframes ref/rois` — `roi.py --all` takes an
 *     IMAGE, not a directory (`cv2.imread(<dir>)` returns None ->
 *     `AttributeError: 'NoneType' object has no attribute 'shape'`), and writes to
 *     `ref/rois` while the tree has `ref/roi`. Run verbatim, it crashes.
 *   * That line is captioned "regenerate signatures", but `roi.py` writes crops, not
 *     signatures. `grep -rn roi_signatures tools/` returns three READERS
 *     (`_pfx.py`, `nullcheck.py`, `refstamp.mjs`) and no writer: `ref/roi_signatures.json`
 *     has no generator in this repository at all. Neither does `ref/baseline.json` — the
 *     AAA ceiling `docs/TARGETS.md` and `docs/ARCHITECTURE.md` quote as a pass criterion.
 *
 * So the honest status of the reference set is: MEASURED for the tree on this disk,
 * UNREPRODUCIBLE anywhere else. This tool states that mechanically instead of in prose,
 * because prose corrections do not propagate (§19, and the whole of docs/META_LEDGER.md).
 *
 * Read-only: it opens PNG headers (26 bytes each) and reads text. No GPU, no browser, no
 * capture, no ffmpeg, ~100 ms. It never writes to `ref/` and never regenerates anything.
 *
 * Exit: 0 clean (or --warn) • 1 geometry mismatch or a required artifact missing
 *       • 2 refcheck itself broke
 */
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const warnOnly = argv.includes('--warn');
const resArg = (() => { const i = argv.indexOf('--res'); return i >= 0 ? argv[i + 1] : null; })();

/* ------------------------------------------------- what geometry is a capture, really? */
function captureGeometry() {
  if (resArg) {
    const m = /^(\d+)x(\d+)$/.exec(resArg);
    if (m) return { w: +m[1], h: +m[2], from: '--res' };
  }
  // G2 stamps opts.w/opts.h on every capture. Newest stamp wins; it is the live answer.
  let best = null;
  try {
    for (const d of readdirSync(join(ROOT, 'shots'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(ROOT, 'shots', d.name, '_capture.json');
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    }
  } catch { }
  if (best) {
    try {
      const j = JSON.parse(readFileSync(best.p, 'utf8'));
      if (j?.opts?.w && j?.opts?.h) {
        return { w: +j.opts.w, h: +j.opts.h, from: best.p.slice(ROOT.length + 1) };
      }
    } catch { }
  }
  // fall back to capture.mjs's own defaults, parsed out of the source
  try {
    const cap = readFileSync(join(ROOT, 'tools/capture.mjs'), 'utf8');
    const w = /\bw:\s*\+arg\('w',\s*(\d+)\)/.exec(cap);
    const h = /\bh:\s*\+arg\('h',\s*(\d+)\)/.exec(cap);
    if (w && h) return { w: +w[1], h: +h[1], from: 'tools/capture.mjs defaults' };
  } catch { }
  return { w: 1920, h: 1080, from: 'built-in default' };
}

/** PNG geometry from the IHDR, without decoding the image or importing anything. */
function pngSize(path) {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(24);
    if (readSync(fd, b, 0, 24, 0) < 24) return null;
    if (b.readUInt32BE(0) !== 0x89504e47) return null;      // not a PNG
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } finally { closeSync(fd); }
}

/* ------------------------------------------------------------ the reference inventory
 * Hand-maintained on purpose (same reasoning as tools/contracts.json): the value is the
 * named mapping surviving across agents, not the glob. `rebuild` is the command that
 * regenerates the artifact — null means NOTHING IN THIS REPO PRODUCES IT. */
const REQUIRED = [
  { path: 'ref/keyframes', kind: 'dir', glob: /^kf_\d{5}\.png$/, geometry: 'capture',
    reads: 'tools/metrics.py (every score)', rebuild: 'ffmpeg (README.md) — but see geometry below' },
  { path: 'ref/roi', kind: 'dir', glob: /\.png$/, geometry: null,
    reads: 'tools/_pfx.py, per-subsystem ROI scoring', rebuild: 'tools/roi.py --all <image> <outdir>' },
  { path: 'ref/detail', kind: 'dir', glob: /_4k\.png$/, geometry: null,
    reads: 'detail crops quoted in reports/', rebuild: null },
  { path: 'ref/roi_signatures.json', kind: 'file', geometry: null,
    reads: 'tools/_pfx.py:15, tools/nullcheck.py:222', rebuild: null },
  { path: 'ref/baseline.json', kind: 'file', geometry: null,
    reads: 'docs/TARGETS.md + docs/ARCHITECTURE.md axis floors, tools/scalecheck.mjs', rebuild: null },
];

/* --------------------------------------------------------------------------- run it */
const geom = captureGeometry();
const problems = [];
const inventory = [];

for (const r of REQUIRED) {
  const abs = join(ROOT, r.path);
  if (!existsSync(abs)) {
    problems.push({ kind: 'missing', path: r.path, detail: `required by ${r.reads}` });
    inventory.push({ ...r, present: false });
    continue;
  }
  const row = { path: r.path, present: true, reads: r.reads, rebuild: r.rebuild, n: null, geometry: null };
  if (r.kind === 'dir') {
    const files = readdirSync(abs).filter((f) => (r.glob ? r.glob.test(f) : true));
    row.n = files.length;
    if (r.geometry === 'capture') {
      const sizes = new Map();
      const wrong = [];
      for (const f of files) {
        const s = pngSize(join(abs, f));
        if (!s) continue;
        const key = `${s.w}x${s.h}`;
        sizes.set(key, (sizes.get(key) || 0) + 1);
        if (s.w !== geom.w || s.h !== geom.h) wrong.push(`${f} ${key}`);
      }
      row.geometry = [...sizes.entries()].map(([k, v]) => `${k} x${v}`).join(', ');
      if (wrong.length) {
        problems.push({
          kind: 'geometry', path: r.path,
          detail: `${wrong.length} of ${files.length} keyframe(s) are not ${geom.w}x${geom.h} ` +
                  `(capture geometry, from ${geom.from}): ${wrong.slice(0, 3).join(', ')}` +
                  `${wrong.length > 3 ? ' …' : ''}`,
        });
      }
    }
  }
  inventory.push(row);
}

/* ----------------------------------------------- does the README recipe match the tree?
 * Two directions, both mechanical:
 *   a. every ref/ path the README names must exist   (catches `ref/rois` vs `ref/roi`)
 *   b. every REQUIRED artifact must be named there   (catches ref/baseline.json, absent
 *      from the recipe and quoted as a pass criterion by two documents) */
const readmeIssues = [];
const README = join(ROOT, 'README.md');
if (existsSync(README)) {
  const txt = readFileSync(README, 'utf8');
  const named = new Set();
  for (const m of txt.matchAll(/\bref\/[A-Za-z0-9_./*%-]+/g)) {
    named.add(m[0].replace(/[.,)]+$/, ''));
  }
  for (const p of named) {
    // strip a filename pattern (kf_%05d.png, kf_NNNNN.png, *_4k.png) down to its directory
    const probe = /[*%]|N{3,}/.test(p) ? p.slice(0, p.lastIndexOf('/')) : p;
    if (!probe || existsSync(join(ROOT, probe))) continue;
    readmeIssues.push({ kind: 'readme-path', path: p,
      detail: 'named in README.md but not on disk — the documented rebuild writes somewhere nothing reads' });
  }
  for (const r of REQUIRED) {
    if ([...named].some((n) => n === r.path || n.startsWith(r.path + '/'))) continue;
    readmeIssues.push({ kind: 'readme-omission', path: r.path,
      detail: `required (read by ${r.reads}) but the README rebuild section never mentions it` });
  }
}

const unreproducible = REQUIRED.filter((r) => r.rebuild === null).map((r) => r.path);
const hard = problems.length;

/* ------------------------------------------------------------------------- report */
if (asJson) {
  console.log(JSON.stringify({
    ok: hard === 0, geometry: geom, inventory, problems, readmeIssues, unreproducible,
  }, null, 2));
} else {
  console.log(`capture geometry ${geom.w}x${geom.h}  (from ${geom.from})`);
  for (const row of inventory) {
    if (!row.present) { console.error(`  MISSING  ${row.path} — required by ${row.reads}`); continue; }
    console.log(`  ok       ${row.path}${row.n !== null ? `  ${row.n} file(s)` : ''}` +
                `${row.geometry ? `  ${row.geometry}` : ''}`);
  }
  for (const p of problems) console.error(`\nFAIL ${p.kind} — ${p.path}\n     ${p.detail}` +
    (p.kind === 'geometry'
      ? '\n     tools/metrics.py resizes the TEST image to the REFERENCE size, so this does not\n' +
        '     error — it silently rescales every render and every axis before scoring.'
      : ''));
  if (readmeIssues.length) {
    console.error(`\n${readmeIssues.length} rebuild-recipe defect(s) in README.md ` +
                  `(advisory — the tree on this disk is unaffected):`);
    for (const r of readmeIssues) console.error(`  ${r.path} — ${r.detail}`);
  }
  if (unreproducible.length) {
    console.error(`\nNo command in this repository regenerates: ${unreproducible.join(', ')}.\n` +
      `  These are UNREPRODUCIBLE, not merely undocumented. Treat any score measured against\n` +
      `  a re-extracted reference as a new series (tools/refstamp.mjs --verify pins the bytes\n` +
      `  you have; it cannot tell you they are the right ones).`);
  }
  if (!hard) console.log(`\nrefcheck ok — reference geometry matches capture geometry` +
                         `${readmeIssues.length || unreproducible.length ? ' (advisory notes above)' : ''}`);
}

process.exit(warnOnly ? 0 : (hard ? 1 : 0));
