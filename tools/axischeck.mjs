#!/usr/bin/env node
/**
 * AXISCHECK — how far has each scoring axis moved across the whole project, and what did
 * the raw statistic underneath it do?
 *
 * Relationship to `tools/historycheck.mjs`
 * ----------------------------------------
 * `historycheck` tests whether an axis is *exactly constant over the last 5 rows* of
 * `scores/history.jsonl`. On the current data that test fires on nothing: `grade` reads
 * 0, 0, 0, 1.40, 1.40 over the last five runs and `structure` reads 4.43, 4.39, 4.43,
 * 3.42, 3.42 — neither is constant, and both are dead. This checks *span over every
 * scored run* instead, and reads the per-wave `scores/<tag>.json` files rather than
 * `history.jsonl`, because the history row drops the one column §15 tells you to read.
 * Run both; they fail on different things.
 *
 * Why this exists
 * ---------------
 * KNOWN_ISSUES §15: `grade` scored **0.00 in every run ever recorded** — nine runs — while
 * the quantity underneath it, `raw.hist`, moved 0.8892 -> 0.802 -> 0.7934 -> 0.7876 -> 0.754.
 * Real progress, rendered completely invisible, because the band `band(hist, 0.25, 0.75)`
 * returns 0 for any distance >= 0.75 and the project has never been inside that band.
 * It took nine runs and a human reading `scores/*.json` by hand to notice. Nothing in the
 * loop watches for an axis that cannot move.
 *
 * `grade` is not the only one. `structure` has sat between 3.42 and 5.13 across all ten
 * recorded runs while the composite went 22.24 -> 30.30 — a 1.7-point span on a 100-point
 * axis, i.e. a second near-dead readout that no section of KNOWN_ISSUES mentions. Two of
 * six axes carrying no gradient is a third of the objective function, and a wave steering
 * by the composite cannot tell.
 *
 * Second thing this surfaces: **`scores/history.jsonl` throws away `raw`.** Each per-wave
 * `scores/<tag>.json` carries `raw` (ssim, ms_ssim, hist, lpips, lap_ratio, edge_ratio),
 * `render_stats` and `ref_stats`; the history row keeps only the banded axes and the perf
 * block. So the longitudinal record retains exactly the numbers §15 says are dead and
 * discards exactly the ones it says to read instead. This tool reconstructs the raw series
 * from the per-wave files so that history is recoverable without re-running anything.
 *
 * Usage
 * -----
 *   node tools/axischeck.mjs                 # table + flags, exit 1 if an axis is dead
 *   node tools/axischeck.mjs --span 5        # "dead" threshold, points of range (default 2)
 *   node tools/axischeck.mjs --json          # machine-readable
 *
 * Reads only. Changes no measurement, no band, and no score — re-banding an axis would
 * change what every historical number means and is deliberately out of scope here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const SPAN = +arg('span', 2);
const asJson = argv.includes('--json');

/* Order runs by history.jsonl (the only record of sequence), then append any per-wave
 * file that history never got a row for. */
const histPath = join(ROOT, 'scores/history.jsonl');
let order = [];
try {
  order = readFileSync(histPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l).tag; } catch { return null; } }).filter(Boolean);
} catch { }

const files = readdirSync(join(ROOT, 'scores'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''));

const seen = new Set();
const tags = [...order, ...files].filter((t) => files.includes(t) && !seen.has(t) && seen.add(t));

/* The empty-scene baseline scores 0 on every axis. Leaving it in gives every axis a
 * free span equal to its first real value, which is exactly how a dead axis hides.
 * `--with-empty` puts it back. */
const withEmpty = argv.includes('--with-empty');
const runs = [];
for (const tag of tags) {
  try {
    const d = JSON.parse(readFileSync(join(ROOT, 'scores', `${tag}.json`), 'utf8'));
    if (!withEmpty && !(d.score > 0)) continue;
    runs.push({ tag, score: d.score, axes: d.axes || {}, raw: d.raw || {}, legacy: !!d.axes_legacy });
  } catch { }
}
if (runs.length < 2) { console.error('axischeck: need at least two scored runs'); process.exit(2); }

/* --- band epochs -------------------------------------------------------------------
 * `tools/metrics.py` was re-banded and re-weighted on 2026-07-31 (see the
 * "== POSE REFIT LINE ==" note in scores/history.jsonl and reports/metrics.md §4).
 * A span computed across that boundary measures the band change, not the work: on the
 * same PNGs `waveH` reads spectrum 94.15 under the old bands and `rescore_waveH` reads
 * 11.36 under the new ones.  Before this split the tool spanned all 17 runs and printed
 * "all axes have moved" — an all-clear produced entirely by the re-band, in the one
 * instrument whose job is to notice an axis that cannot move.
 *
 * Discriminator: a run scored by the new metric carries `axes_legacy` (the old bands
 * recomputed); a run scored by the old metric has no such key.  Nothing is inferred from
 * dates or tags.  This adds no band and changes no number — it only refuses to subtract
 * two numbers that are in different units. */
for (const r of runs) r.epoch = r.legacy ? 'new-2026-07-31' : 'legacy';
const epochNames = [...new Set(runs.map((r) => r.epoch))];

const axisNames = [...new Set(runs.flatMap((r) => Object.keys(r.axes)))];
const rawNames = [...new Set(runs.flatMap((r) => Object.keys(r.raw)))];

const range = (vals) => {
  const v = vals.filter((x) => typeof x === 'number');
  return v.length ? { min: Math.min(...v), max: Math.max(...v), span: Math.max(...v) - Math.min(...v) } : null;
};

/* Span is computed WITHIN an epoch only.  An epoch with fewer than two runs cannot show
 * a span at all and is reported as such rather than counted as dead. */
const statsFor = (rs) => Object.fromEntries(axisNames.map((a) => [a, range(rs.map((r) => r.axes[a]))]));
const epochs = epochNames.map((e) => {
  const rs = runs.filter((r) => r.epoch === e);
  const axisStats = statsFor(rs);
  const dead = rs.length >= 2 ? axisNames.filter((a) => axisStats[a] && axisStats[a].span < SPAN) : [];
  return { epoch: e, runs: rs, axisStats, dead, comparable: rs.length >= 2 };
});
const axisStats = statsFor(runs);          // kept for --json back-compat; see crossEpoch below
const rawStats = Object.fromEntries(rawNames.map((a) => [a, range(runs.map((r) => r.raw[a]))]));
const crossEpoch = epochNames.length > 1;
/* An axis is dead only if it is dead in EVERY epoch that can show a span.  `grade` is
 * (1.74 legacy, 1.69 new) and qualifies; `spectrum` looks like a 95-point mover only
 * because the two epochs are in different units. */
const comparable = epochs.filter((e) => e.comparable);
const dead = comparable.length
  ? axisNames.filter((a) => comparable.every((e) => e.dead.includes(a)))
  : [];

if (asJson) {
  console.log(JSON.stringify({
    runs, epochs: epochs.map(({ epoch, dead, axisStats, comparable }) =>
      ({ epoch, dead, axisStats, comparable })),
    axisStats_ACROSS_EPOCHS_DO_NOT_USE: crossEpoch ? axisStats : undefined,
    rawStats, dead, span: SPAN, crossEpoch,
  }, null, 2));
  process.exit(dead.length ? 1 : 0);
}

const pad = (s, n) => String(s).padStart(n);
const W = 18 + 8 + 11 * axisNames.length;
console.log(`\n${runs.length} scored runs, oldest first`);
if (crossEpoch) {
  console.log(`\n!! ${epochNames.length} BAND EPOCHS on record — tools/metrics.py was re-banded and`);
  console.log(`   re-weighted 2026-07-31. Axis numbers either side of the line are in DIFFERENT`);
  console.log(`   UNITS; a span across it measures the re-band. Spans below are per-epoch only.`);
}
console.log('');
for (const e of epochs) {
  if (crossEpoch) console.log(`--- band epoch: ${e.epoch}  (${e.runs.length} run(s)) ---`);
  console.log('run'.padEnd(18) + pad('score', 8) + axisNames.map((a) => pad(a.slice(0, 9), 11)).join(''));
  for (const r of e.runs) {
    console.log(r.tag.padEnd(18) + pad((r.score ?? 0).toFixed(2), 8) +
      axisNames.map((a) => pad(r.axes[a] == null ? '-' : r.axes[a].toFixed(2), 11)).join(''));
  }
  console.log('-'.repeat(W));
  console.log((e.comparable ? 'span' : 'span (n<2)').padEnd(18) + pad('', 8) +
    axisNames.map((a) => pad(e.comparable && e.axisStats[a] ? e.axisStats[a].span.toFixed(2) : '-', 11)).join(''));
  console.log('');
}

console.log(`\nraw statistics — the numbers history.jsonl does not keep\n`);
console.log('run'.padEnd(18) + rawNames.map((a) => pad(a.slice(0, 10), 12)).join(''));
for (const r of runs) {
  console.log(r.tag.padEnd(18) + rawNames.map((a) => pad(r.raw[a] == null ? '-' : r.raw[a], 12)).join(''));
}

if (dead.length) {
  const where = comparable.map((e) => `${e.epoch} (${e.runs.length} runs)`).join(' and ');
  console.error(`\nDEAD AXES (range < ${SPAN} points within EVERY band epoch — ${where}): ${dead.join(', ')}`);
  console.error('An axis that never moves is not measuring this project. Steer by the raw');
  console.error('column instead (KNOWN_ISSUES §15), and do not credit or blame a wave for it.');
  for (const e of comparable) {
    const only = e.dead.filter((a) => !dead.includes(a));
    if (only.length) console.error(`note  dead in ${e.epoch} only: ${only.join(', ')}`);
  }
  process.exit(1);
}
console.log(crossEpoch
  ? 'all axes have moved within every band epoch that has two or more runs.'
  : 'all axes have moved.');
