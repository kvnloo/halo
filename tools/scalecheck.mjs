#!/usr/bin/env node
/**
 * SCALECHECK — is the AAA ceiling every target is quoted against still in the units the
 * scorer prints today?
 *
 * The failure this exists for
 * ---------------------------
 * `tools/metrics.py` was re-banded and re-weighted on 2026-07-31 (`reports/metrics.md` §4).
 * It now carries `LEGACY_BANDS` / `LEGACY_WEIGHTS` verbatim and emits `axes_legacy` beside
 * `axes`, so the *scorer* knows there are two scales. Nothing else does:
 *
 *   * `ref/baseline.json` — 91 reference-vs-reference pairs, the honest ceiling — was written
 *     2026-07-29 and has never been regenerated. Its `axes_mean` block is in old-band units
 *     and carries no field saying so.
 *   * `docs/TARGETS.md` §"Calibration: what AAA scores" quotes that block verbatim and turns
 *     it into a pass criterion: *"detail, geometry and spectrum above ~80/88/95 means the
 *     render carries the same texture and edge statistics as the real game."*
 *   * `docs/ARCHITECTURE.md`'s axis table sets floors of `structure > 45 … spectrum > 92`.
 *
 * On the SAME PNGs, `waveH` reads detail 76.86 / geometry 80.81 / spectrum 94.15 under the
 * old bands and `rescore_waveH` reads 32.74 / 18.45 / 11.36 under the new ones. An agent who
 * reads `docs/TARGETS.md` today and then runs `npm run score` concludes the render collapsed.
 * `reports/metrics.md` §7 ("Documents that are now wrong, owned by someone else") named both
 * documents when it landed the re-band — and, exactly as with `reports/fog.md`'s
 * `HALO_NO_DAEMON=1` (KNOWN_ISSUES §19), a correction that stops at the report that wrote it
 * does not reach the readers. This is the mechanical version of that note.
 *
 * What it checks — stateless, so it cannot go stale itself
 * -------------------------------------------------------
 *  1. Does `tools/metrics.py` carry a legacy band block?  If it does, a re-band is on record.
 *  2. Does `ref/baseline.json` say which banding produced it?  (Any of `bands`, `band_version`,
 *     `metrics_sha256`, `metrics_md5`, `scale`.)  If not, its axis numbers are unattributable.
 *  3. If (1) and not (2): every document quoting that ceiling is quoting the old scale.
 *     Prints the sites it can find, with line numbers.
 *
 * It goes green the moment `ref/baseline.json` is regenerated with a stamp, or an owner
 * records the decision in `scores/scale_stamp.json` (see --help). It re-bands nothing, edits
 * nothing, reads only, and never runs at capture time.
 *
 * Usage
 *   node tools/scalecheck.mjs            # exit 1 if the ceiling is on a dead scale
 *   node tools/scalecheck.mjs --warn     # always exit 0 (how preflight/CI call it)
 *   node tools/scalecheck.mjs --json
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const warnOnly = argv.includes('--warn');
const asJson = argv.includes('--json');

if (argv.includes('--help')) {
  console.log(`scalecheck — is ref/baseline.json in the same band units as tools/metrics.py?

  node tools/scalecheck.mjs           exit 1 when the ceiling is on a superseded scale
  node tools/scalecheck.mjs --warn    always exit 0
  node tools/scalecheck.mjs --json    machine-readable

To clear it, either:
  (a) regenerate ref/baseline.json under the current bands and add a field naming them, e.g.
      "band_version": "2026-07-31", or "metrics_sha256": "<sha256 of tools/metrics.py>"; or
  (b) if the ceiling is deliberately being kept on the old scale, record that decision in
      scores/scale_stamp.json:
        {"baseline_scale":"legacy","acknowledged":"<who/when>","why":"<one line>"}
      scalecheck then reports it as an accepted, attributed state instead of a defect.

It never edits anything and it is advisory wherever preflight or CI calls it.`);
  process.exit(0);
}

const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; } };

const METRICS = 'tools/metrics.py';
const BASELINE = 'ref/baseline.json';
const STAMP = 'scores/scale_stamp.json';

const findings = [];
const notes = [];

const metricsSrc = read(METRICS);
if (metricsSrc === null) {
  // Never invent a reason to pass. If the instrument is not readable, say so and stop.
  console.error(`scalecheck: cannot read ${METRICS} — nothing checked`);
  process.exit(warnOnly ? 0 : 2);
}

/* 1. Is a re-band on record?  The legacy block is kept verbatim in metrics.py precisely so
 *    old runs stay readable, so its presence IS the evidence that the scale moved. */
const rebanded = /^\s*LEGACY_(BANDS|WEIGHTS)\s*=/m.test(metricsSrc);
const emitsLegacy = /axes_legacy|score_legacy/.test(metricsSrc);

/* 2. Does the ceiling say which banding produced it? */
const baselineSrc = read(BASELINE);
let baselineStamped = false, baselineParsed = null;
if (baselineSrc !== null) {
  try { baselineParsed = JSON.parse(baselineSrc); } catch { }
  baselineStamped = !!baselineParsed && ['bands', 'band_version', 'metrics_sha256',
    'metrics_md5', 'scale'].some((k) => baselineParsed[k] !== undefined);
} else {
  // ref/ is gitignored licensed material; absent on a fresh clone. Not a defect.
  notes.push(`${BASELINE} is not on this disk (ref/ is gitignored) — ceiling not checked here.`);
}

/* An owner may have accepted the mismatch deliberately. That is a different state. */
let ack = null;
const stampSrc = read(STAMP);
if (stampSrc !== null) { try { ack = JSON.parse(stampSrc); } catch { notes.push(`${STAMP} is not valid JSON — ignored.`); } }

/* 3. Where is the ceiling quoted?  Report line numbers so the fix is a two-minute edit. */
const AXIS = /\b(structure|grade|perceptual|detail|geometry|spectrum)\b/;
// A THRESHOLD is an explicit comparison, not any nearby number: `sat_mean ... near 69` in
// TARGETS.md is a region statistic, not an axis floor, and must not be listed here.
const THRESHOLD = /(>=|>|≥|above|at least)\s*~?\d{2,3}(\.\d+)?/;
const quoteSites = [];
for (const rel of ['docs/TARGETS.md', 'docs/ARCHITECTURE.md']) {
  const src = read(rel);
  if (src === null) continue;
  src.split('\n').forEach((line, i) => {
    if (AXIS.test(line) && THRESHOLD.test(line) && /\d/.test(line)) {
      quoteSites.push({ file: rel, line: i + 1, text: line.trim().slice(0, 110) });
    }
  });
}

if (rebanded && baselineSrc !== null && !baselineStamped) {
  findings.push(
    `${BASELINE} carries no band stamp, but ${METRICS} carries a LEGACY_BANDS block — so a ` +
    `re-band is on record and the ceiling predates it. Its axes_mean/axes_p25 are in the ` +
    `superseded units; every document quoting them states a pass criterion no current score ` +
    `can meet.`);
}
if (rebanded && !emitsLegacy) {
  findings.push(
    `${METRICS} has a legacy band block but no axes_legacy/score_legacy output — old runs in ` +
    `scores/history.jsonl cannot be re-read on the current scale at all.`);
}

const accepted = ack && (ack.baseline_scale || ack.acknowledged);
const status = findings.length === 0 ? 'ok' : (accepted ? 'accepted' : 'stale');

if (asJson) {
  console.log(JSON.stringify({ status, rebanded, emitsLegacy, baselineStamped, findings, notes,
    quoteSites, acknowledgement: ack }, null, 2));
  process.exit(status === 'stale' && !warnOnly ? 1 : 0);
}

for (const n of notes) console.log(`note  ${n}`);
if (!findings.length) {
  console.log('ok — the reference ceiling and the current bands are on the same scale.');
  process.exit(0);
}
for (const f of findings) console.error(`SCALE  ${f}`);
if (quoteSites.length) {
  console.error(`\n       quoted as a pass criterion at ${quoteSites.length} site(s):`);
  for (const q of quoteSites) console.error(`         ${q.file}:${q.line}  ${q.text}`);
}
console.error(`\n       Evidence it matters: on the same PNGs, waveH reads detail 76.86 /`);
console.error(`       geometry 80.81 / spectrum 94.15 and rescore_waveH reads 32.74 / 18.45 /`);
console.error(`       11.36. reports/metrics.md §7 already names both documents as now wrong.`);
console.error(`       Fix: regenerate ${BASELINE} under the current bands and stamp it, or`);
console.error(`       record the decision in ${STAMP}. See --help.`);
if (accepted) {
  console.log(`\naccepted: ${STAMP} records this as a deliberate, attributed state.`);
  process.exit(0);
}
process.exit(warnOnly ? 0 : 1);
