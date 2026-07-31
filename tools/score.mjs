#!/usr/bin/env node
/**
 * Capture -> measure -> record. This is the instrument the /loop steers by.
 *
 *   node tools/score.mjs                       # all ref poses, append to history
 *   node tools/score.mjs --pose ref_00450
 *   node tools/score.mjs --tag "clouds-v3"
 *   node tools/score.mjs --history             # print the trend and exit
 *   node tools/score.mjs --rescore shots/waveE --tag waveE   # measure PNGs already on
 *                                              # disk, no capture, no history append
 *
 * Writes:
 *   shots/<tag>/<pose>.png        the captured frames
 *   scores/<tag>.json             full per-pose metrics for this run
 *   scores/history.jsonl          one line per run: the proof the loop is improving
 *   shots/<tag>/sbs_<pose>.png    reference | render side-by-side, for the critic
 *
 * READING THE OUTPUT (changed 2026-07-31, see reports/metrics.md)
 *
 *   score        0..100, re-banded against ground truth measured off the reference
 *                clip itself. NOT comparable to any score recorded before that date.
 *   score_legacy the old banding, still computed, so history stays readable.
 *   score_geometric  tamper check: the same axes as a weighted geometric mean, so it
 *                collapses if any one axis does. If `score` rises and this does not,
 *                the gain came from the axes that were already strong.
 *   progress     the number to actually tune against. Signed and linear:
 *                  0   = no closer than an unrelated shot of the real game
 *                  100 = as close as the real game's own adjacent frames
 *                Constant derivative everywhere, so a real gain always shows.
 *   raw.*        the underlying distances. If an axis ever looks stuck, read these.
 *                They are also written into history.jsonl so any future re-banding
 *                can be applied to old runs instead of discarding them.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const TAG = arg('tag', 'latest');
const POSE = arg('pose', null);
const SETTLE = arg('settle', '48');
const RESCORE = arg('rescore', null);   // measure an existing shots dir, do not capture
const PY = join(ROOT, '.venv/bin/python');
const AXES = ['structure', 'grade', 'perceptual', 'detail', 'geometry', 'spectrum'];

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

function printHistory() {
  const f = join(ROOT, 'scores/history.jsonl');
  if (!existsSync(f)) return console.log('no history yet');
  const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const w = AXES;
  const num = (v, d = 1) => (v == null ? '-' : v.toFixed(d));
  // Runs recorded before the 2026-07-31 re-band carry only the legacy numbers; runs
  // after it carry both. Show whichever exists rather than pretending they are one series.
  console.log(['#'.padStart(4), 'tag'.padEnd(22), 'SCORE'.padStart(7), 'legacy'.padStart(7),
    ...w.map((k) => k.slice(0, 6).padStart(7))].join(' '));
  rows.forEach((r, i) => {
    const post = r.score_legacy != null;         // post-re-band row
    const sc = post ? r.score : null;
    const lg = post ? r.score_legacy : r.score;  // pre-re-band rows recorded legacy as `score`
    const ax = post ? r.axes : r.axes_legacy ?? r.axes;
    console.log([String(i + 1).padStart(4), String(r.tag).slice(0, 22).padEnd(22),
      num(sc, 2).padStart(7), num(lg, 2).padStart(7),
      ...w.map((k) => num(ax?.[k]).padStart(7))].join(' '));
  });
  const scored = rows.filter((r) => r.score_legacy != null);
  if (scored.length > 1) {
    const a = scored[0], b = scored[scored.length - 1];
    console.log(`\ndelta since first re-banded run: ${(b.score - a.score >= 0 ? '+' : '')}${(b.score - a.score).toFixed(2)}`);
    const best = scored.reduce((x, y) => (y.score > x.score ? y : x));
    console.log(`best: ${best.tag} @ ${best.score.toFixed(2)}`);
  }
  if (scored.length < rows.length) {
    console.log(`\n${rows.length - scored.length} run(s) predate the 2026-07-31 re-band and carry only a legacy score.`);
    console.log('They cannot be re-scored from history.jsonl (no raw values were stored).');
    console.log('Where the PNGs survive:  node tools/score.mjs --rescore shots/<tag> --tag <tag>');
  }
}

if (has('history')) { printHistory(); process.exit(0); }

// ---------------------------------------------------------------- capture
const outdir = RESCORE || `shots/${TAG}`;
let capInfo = {};
if (RESCORE) {
  if (!existsSync(join(ROOT, outdir))) { console.error(`no such shots dir: ${outdir}`); process.exit(2); }
  process.stderr.write(`[score] rescoring existing PNGs in ${outdir} (no capture)\n`);
} else {
  mkdirSync(join(ROOT, outdir), { recursive: true });
  const capArgs = ['tools/capture.mjs', '--outdir', outdir, '--settle', SETTLE];
  if (POSE) capArgs.push('--pose', POSE); else capArgs.push('--all');
  if (has('verbose')) capArgs.push('--verbose');

  process.stderr.write(`[score] capturing (${TAG})...\n`);
  const cap = sh('node', capArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
  if (cap.status !== 0) { console.error('capture failed'); process.exit(2); }
  try { capInfo = JSON.parse(cap.stdout); } catch { }
}

// ---------------------------------------------------------------- measure
const shots = readdirSync(join(ROOT, outdir)).filter((f) => /^ref_\d+\.png$/.test(f));
if (!shots.length) { console.error('no ref_* shots produced'); process.exit(3); }

const rows = [];
for (const s of shots) {
  const pose = s.replace('.png', '');
  const idx = pose.split('_')[1];
  const ref = `ref/keyframes/kf_${idx}.png`;
  if (!existsSync(join(ROOT, ref))) { console.error(`missing reference ${ref}`); continue; }
  const r = sh(PY, ['tools/metrics.py', ref, `${outdir}/${s}`, '--tag', pose, '--quiet',
    '--json', `scores/_tmp_${pose}.json`]);
  if (r.status !== 0) { console.error(r.stderr.slice(0, 800)); continue; }
  rows.push(JSON.parse(readFileSync(join(ROOT, `scores/_tmp_${pose}.json`), 'utf8')));

  // side-by-side for the critic
  sh(PY, ['tools/sbs.py', ref, `${outdir}/${s}`, `${outdir}/sbs_${pose}.png`]);
}

const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / Math.max(rows.length, 1);
// Mean over the poses where the value exists. An axis that could not be computed must
// come out `null`, never 0 - a 0 is a score, a null is a broken measurement.
const meanOf = (f) => {
  const v = rows.map(f).filter((x) => x != null && Number.isFinite(x));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
};
const perAxis = (field) => Object.fromEntries(AXES.map((k) => [k, meanOf((r) => r[field]?.[k])]));

const warnings = [...new Set(rows.flatMap((r) => r.warnings || []))];
const summary = {
  tag: TAG,
  n: rows.length,
  rescored_from: RESCORE || undefined,
  score: +mean((r) => r.score).toFixed(2),
  score_comparative: +mean((r) => r.score_comparative).toFixed(2),
  score_geometric: +mean((r) => r.score_geometric).toFixed(2),
  score_legacy: +mean((r) => r.score_legacy).toFixed(2),
  axes: perAxis('axes'),
  progress: perAxis('progress'),
  axes_legacy: perAxis('axes_legacy'),
  // Raw distances, per axis and per underlying metric. history.jsonl carries these so
  // any future re-banding can be applied to this run instead of discarding it.
  raw: {
    ...Object.fromEntries(AXES.map((k) => [k, meanOf((r) => r.raw?.[k])])),
    ...Object.fromEntries(['ssim', 'ms_ssim', 'hist', 'hist_smooth', 'grad_hist', 'lpips', 'lap_ratio', 'edge_ratio']
      .map((k) => [k, meanOf((r) => r.raw?.[k] ?? r[k])])),
  },
  render_stats: Object.fromEntries(['lum_mean', 'lum_std', 'sat_mean', 'lap_var', 'edge_density', 'local_contrast', 'shadow_frac', 'highlight_frac']
    .map((k) => [k, +mean((r) => r.test_stats[k]).toFixed(4)])),
  ref_stats: Object.fromEntries(['lum_mean', 'lum_std', 'sat_mean', 'lap_var', 'edge_density', 'local_contrast', 'shadow_frac', 'highlight_frac']
    .map((k) => [k, +mean((r) => r.ref_stats[k]).toFixed(4)])),
  spectral: { ref: +mean((r) => r.spectral_slope_ref).toFixed(3), test: +mean((r) => r.spectral_slope_test).toFixed(3) },
  perf: capInfo.stats ? { fps: Math.round(capInfo.stats.fps || 0), ms: +(capInfo.stats.ms || 0).toFixed(2), drawCalls: capInfo.stats.drawCalls, tris: capInfo.stats.triangles } : null,
  warnings,
  worst: rows.slice().sort((a, b) => a.score - b.score).slice(0, 3).map((r) => ({ pose: r.tag, score: r.score, axes: r.axes })),
  per_pose: rows.map((r) => ({ pose: r.tag, score: r.score, axes: r.axes, progress: r.progress })),
};

mkdirSync(join(ROOT, 'scores'), { recursive: true });
writeFileSync(join(ROOT, `scores/${TAG}.json`), JSON.stringify(summary, null, 2));
if (RESCORE) {
  process.stderr.write('[score] --rescore: not appending to history.jsonl (this is a re-measurement, not a run)\n');
} else {
  appendFileSync(join(ROOT, 'scores/history.jsonl'),
    JSON.stringify({
      tag: TAG, n: summary.n, score: summary.score, score_comparative: summary.score_comparative,
      score_geometric: summary.score_geometric,
      score_legacy: summary.score_legacy, axes: summary.axes, progress: summary.progress,
      axes_legacy: summary.axes_legacy, raw: summary.raw, perf: summary.perf,
      warnings: warnings.length ? warnings : undefined,
    }) + '\n');
}

if (warnings.length) {
  console.error('\n!! MEASUREMENT WARNINGS - some axis is not being measured:');
  warnings.forEach((w) => console.error('   ' + w));
}
console.log(JSON.stringify(summary, null, 2));
console.error('\n--- history ---');
printHistory();
