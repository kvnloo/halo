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
 *   band_version which banding produced `score`. Only rows at the current version are one
 *                series; --history shows the rest as legacy-only. Bump it in metrics.py
 *                whenever CALIB, WEIGHTS or an axis's underlying metric changes.
 *   incomplete   set when a pose failed to measure or an axis came back null. Such a run
 *                is a mean over a different set, is excluded from the trend, and makes
 *                this tool exit non-zero.
 *
 * The composite cannot resolve a wave smaller than ~4 points on nine poses
 * (reports/metrics.md 13b). Steer by `progress` per axis and by the blind A/B gate.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
// Must match metrics.py's BAND_VERSION. A run scored under a different band version is a
// different quantity wearing the same name, so it is not on this trend. Asserted below
// against what metrics.py actually reports, so the two cannot drift silently.
const BAND_VERSION = 2;

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
    // Only rows scored under the CURRENT band version carry a comparable `score`. Rows from
    // band version 1 (2026-07-31 first pass) measured `structure` as 1-MS_SSIM, which §9 of
    // reports/metrics.md shows is won by rendering a flat grey rectangle; their composites
    // are not on this scale and must not be plotted as if they were.
    const post = r.score_legacy != null && (r.band_version ?? 1) === BAND_VERSION;
    const sc = post ? r.score : null;
    // Rows from before 2026-07-31 have no `score_legacy` because their `score` *was* the
    // legacy composite. Rows from band v1 have a real one. Never fall back to `score` when
    // `score_legacy` exists, or a v1 composite gets printed in the legacy column.
    const lg = r.score_legacy ?? r.score;
    const ax = post ? r.axes : r.axes_legacy ?? r.axes;
    // `!` = incomplete: fewer poses measured than captured, or an axis came back null.
    // Such a row is a mean over a different set than its neighbours and is not on the trend.
    const mark = r.incomplete ? '!' : ' ';
    console.log([String(i + 1).padStart(4), (mark + String(r.tag).slice(0, 21)).padEnd(22),
      num(sc, 2).padStart(7), num(lg, 2).padStart(7),
      ...w.map((k) => num(ax?.[k]).padStart(7))].join(' '));
  });
  const scored = rows.filter((r) => r.score_legacy != null && !r.incomplete
    && (r.band_version ?? 1) === BAND_VERSION);
  const superseded = rows.filter((r) => r.score_legacy != null && (r.band_version ?? 1) !== BAND_VERSION);
  if (superseded.length) {
    console.log(`\n${superseded.length} run(s) were scored under an older band version and show `
      + 'legacy only; their composites are a different quantity. Re-measure with --rescore.');
  }
  if (rows.some((r) => r.incomplete)) {
    console.log('\n! = incomplete measurement (see that run\'s warnings); excluded from the trend below.');
  }
  if (scored.length > 1) {
    const a = scored[0], b = scored[scored.length - 1];
    console.log(`\ndelta since first re-banded run: ${(b.score - a.score >= 0 ? '+' : '')}${(b.score - a.score).toFixed(2)}`);
    const best = scored.reduce((x, y) => (y.score > x.score ? y : x));
    console.log(`best: ${best.tag} @ ${best.score.toFixed(2)}`);
  }
  const preband = rows.filter((r) => r.score_legacy == null);
  if (preband.length) {
    console.log(`\n${preband.length} run(s) predate the 2026-07-31 re-band and carry only a legacy score.`);
    console.log('They cannot be re-scored from history.jsonl (no raw values were stored).');
  }
  if (preband.length || superseded.length) {
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

// --rescore reads someone else's shot dir; write the side-by-sides somewhere else so a
// re-measurement never modifies the directory it is measuring.
const sbsdir = RESCORE ? `shots/_rescore_${TAG}` : outdir;
if (RESCORE) mkdirSync(join(ROOT, sbsdir), { recursive: true });

// Per-pose measurements used to land in `scores/_tmp_<pose>.json` - a fixed path with no
// tag and no pid in it. Several agents run this tool at once, so two runs measuring the
// same pose raced on that file and each could read back the OTHER run's frame. It happened
// during the 2026-07-31 second pass: shots/waveF scored 19.91 once and 20.08 on every
// re-run, differing only at ref_00000, from identical pixels and a metric that is exactly
// deterministic. A wrong number that looks plausible is the whole subject of this report.
const tmpdir = `scores/.tmp-${process.pid}`;
mkdirSync(join(ROOT, tmpdir), { recursive: true });

const rows = [];
const failed = [];
for (const s of shots) {
  const pose = s.replace('.png', '');
  const idx = pose.split('_')[1];
  const ref = `ref/keyframes/kf_${idx}.png`;
  if (!existsSync(join(ROOT, ref))) { console.error(`missing reference ${ref}`); failed.push(`${pose} (no reference ${ref})`); continue; }
  const r = sh(PY, ['tools/metrics.py', ref, `${outdir}/${s}`, '--tag', pose, '--quiet',
    '--json', `${tmpdir}/${pose}.json`]);
  if (r.status !== 0) { console.error(r.stderr.slice(0, 800)); failed.push(`${pose} (metrics.py exit ${r.status})`); continue; }
  const got = JSON.parse(readFileSync(join(ROOT, `${tmpdir}/${pose}.json`), 'utf8'));
  // belt and braces: prove the file we read is the measurement we asked for
  if (got.tag !== pose || got.test !== s) {
    console.error(`temp file mismatch: asked for ${pose}/${s}, got ${got.tag}/${got.test}`);
    failed.push(`${pose} (temp file mismatch)`); continue;
  }
  rows.push(got);

  // side-by-side for the critic
  sh(PY, ['tools/sbs.py', ref, `${outdir}/${s}`, `${sbsdir}/sbs_${pose}.png`]);
}

try { rmSync(join(ROOT, tmpdir), { recursive: true, force: true }); } catch { }

const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / Math.max(rows.length, 1);
// Mean over the poses where the value exists. An axis that could not be computed must
// come out `null`, never 0 - a 0 is a score, a null is a broken measurement.
const meanOf = (f) => {
  const v = rows.map(f).filter((x) => x != null && Number.isFinite(x));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
};
const perAxis = (field) => Object.fromEntries(AXES.map((k) => [k, meanOf((r) => r[field]?.[k])]));

const warnings = [...new Set(rows.flatMap((r) => r.warnings || []))];

// A run that measured fewer poses than it captured, or that lost an axis, is NOT
// comparable to one that measured everything: the composite is a mean over poses, and the
// nine poses differ from each other by far more than any wave has ever moved the score
// (per-pose spread on waveH is 6..33 against a 2.5-point wave delta). Both cases used to
// arrive downstream as an ordinary number with a smaller `n` that nothing read.
// preflight.mjs:68 documents the pose half of this and could not fix it from there.
if (failed.length) {
  warnings.push(`${failed.length} of ${shots.length} pose(s) failed to measure: ${failed.join(', ')}. ` +
    'The composite is a mean over the survivors and is NOT comparable to a full run.');
}
const nullAxes = AXES.filter((k) => rows.some((r) => r.axes?.[k] == null));
if (nullAxes.length) {
  warnings.push(`axis unmeasured on some poses: ${nullAxes.join(', ')}. The composite is ` +
    'renormalised over the remaining axes and is NOT comparable to a full run.');
}
const incomplete = failed.length > 0 || nullAxes.length > 0;

// Fail loudly if metrics.py's banding moved without this file being updated: every recorded
// score would silently become a different quantity under the same name.
const seenBand = [...new Set(rows.map((r) => r.band_version ?? 1))];
if (seenBand.length && !(seenBand.length === 1 && seenBand[0] === BAND_VERSION)) {
  console.error(`metrics.py reports band_version ${seenBand.join('/')} but score.mjs expects `
    + `${BAND_VERSION}. Update BAND_VERSION in tools/score.mjs and re-measure the history.`);
  process.exit(5);
}

const summary = {
  tag: TAG,
  n: rows.length,
  n_expected: shots.length,
  band_version: BAND_VERSION,
  incomplete: incomplete || undefined,
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
      tag: TAG, n: summary.n, n_expected: shots.length, band_version: BAND_VERSION,
      incomplete: incomplete || undefined,
      score: summary.score, score_comparative: summary.score_comparative,
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
// Exit non-zero on an incomplete measurement. A metric that fails open is worse than one
// that fails: the whole point of the 2026-07-31 audit was that unmeasured things were
// arriving as scores. The JSON is still on stdout, so nothing that wants the partial
// result loses it - it just has to acknowledge the status.
if (incomplete) process.exit(4);
