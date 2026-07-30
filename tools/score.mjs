#!/usr/bin/env node
/**
 * Capture -> measure -> record. This is the instrument the /loop steers by.
 *
 *   node tools/score.mjs                       # all ref poses, append to history
 *   node tools/score.mjs --pose ref_00450
 *   node tools/score.mjs --tag "clouds-v3"
 *   node tools/score.mjs --history             # print the trend and exit
 *
 * Writes:
 *   shots/<tag>/<pose>.png        the captured frames
 *   scores/<tag>.json             full per-pose metrics for this run
 *   scores/history.jsonl          one line per run: the proof the loop is improving
 *   shots/<tag>/sbs_<pose>.png    reference | render side-by-side, for the critic
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
const PY = join(ROOT, '.venv/bin/python');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

function printHistory() {
  const f = join(ROOT, 'scores/history.jsonl');
  if (!existsSync(f)) return console.log('no history yet');
  const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const w = ['structure', 'grade', 'perceptual', 'detail', 'geometry', 'spectrum'];
  console.log(['#'.padStart(4), 'tag'.padEnd(22), 'SCORE'.padStart(7), ...w.map((k) => k.slice(0, 6).padStart(7))].join(' '));
  rows.forEach((r, i) => {
    console.log([String(i + 1).padStart(4), String(r.tag).slice(0, 22).padEnd(22),
      r.score.toFixed(2).padStart(7), ...w.map((k) => (r.axes[k] ?? 0).toFixed(1).padStart(7))].join(' '));
  });
  const first = rows[0], last = rows[rows.length - 1];
  if (rows.length > 1) {
    console.log(`\ndelta since first: ${(last.score - first.score >= 0 ? '+' : '')}${(last.score - first.score).toFixed(2)}`);
    const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
    console.log(`best: ${best.tag} @ ${best.score.toFixed(2)}`);
  }
}

if (has('history')) { printHistory(); process.exit(0); }

// ---------------------------------------------------------------- capture
const outdir = `shots/${TAG}`;
mkdirSync(join(ROOT, outdir), { recursive: true });
const capArgs = ['tools/capture.mjs', '--outdir', outdir, '--settle', SETTLE];
if (POSE) capArgs.push('--pose', POSE); else capArgs.push('--all');
if (has('verbose')) capArgs.push('--verbose');

process.stderr.write(`[score] capturing (${TAG})...\n`);
const cap = sh('node', capArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
if (cap.status !== 0) { console.error('capture failed'); process.exit(2); }
let capInfo = {};
try { capInfo = JSON.parse(cap.stdout); } catch { }

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
const AXES = ['structure', 'grade', 'perceptual', 'detail', 'geometry', 'spectrum'];
const summary = {
  tag: TAG,
  n: rows.length,
  score: +mean((r) => r.score).toFixed(2),
  axes: Object.fromEntries(AXES.map((k) => [k, +mean((r) => r.axes[k]).toFixed(2)])),
  raw: Object.fromEntries(['ssim', 'ms_ssim', 'hist', 'lpips', 'lap_ratio', 'edge_ratio']
    .map((k) => [k, +mean((r) => r[k] ?? 0).toFixed(4)])),
  render_stats: Object.fromEntries(['lum_mean', 'lum_std', 'sat_mean', 'lap_var', 'edge_density', 'local_contrast', 'shadow_frac', 'highlight_frac']
    .map((k) => [k, +mean((r) => r.test_stats[k]).toFixed(4)])),
  ref_stats: Object.fromEntries(['lum_mean', 'lum_std', 'sat_mean', 'lap_var', 'edge_density', 'local_contrast', 'shadow_frac', 'highlight_frac']
    .map((k) => [k, +mean((r) => r.ref_stats[k]).toFixed(4)])),
  spectral: { ref: +mean((r) => r.spectral_slope_ref).toFixed(3), test: +mean((r) => r.spectral_slope_test).toFixed(3) },
  perf: capInfo.stats ? { fps: Math.round(capInfo.stats.fps || 0), ms: +(capInfo.stats.ms || 0).toFixed(2), drawCalls: capInfo.stats.drawCalls, tris: capInfo.stats.triangles } : null,
  worst: rows.slice().sort((a, b) => a.score - b.score).slice(0, 3).map((r) => ({ pose: r.tag, score: r.score, axes: r.axes })),
  per_pose: rows.map((r) => ({ pose: r.tag, score: r.score, axes: r.axes })),
};

mkdirSync(join(ROOT, 'scores'), { recursive: true });
writeFileSync(join(ROOT, `scores/${TAG}.json`), JSON.stringify(summary, null, 2));
appendFileSync(join(ROOT, 'scores/history.jsonl'),
  JSON.stringify({ tag: TAG, n: summary.n, score: summary.score, axes: summary.axes, perf: summary.perf }) + '\n');

console.log(JSON.stringify(summary, null, 2));
console.error('\n--- history ---');
printHistory();
