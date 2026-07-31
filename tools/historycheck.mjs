#!/usr/bin/env node
/**
 * Dead-axis and shape check over `scores/history.jsonl`.
 *
 *   node tools/historycheck.mjs           # report; exit 1 only on a malformed row
 *   node tools/historycheck.mjs --strict  # also exit 1 on a stuck axis or an `n` change
 *
 * Why
 * ---
 * KNOWN_ISSUES §15: the `grade` axis "scored 0.00 in every run ever recorded, including
 * runs where it genuinely improved" — Wave E moved the underlying `hist` 0.889 -> 0.802 and
 * the axis showed nothing, because `band(hist, 0.25, 0.75)` returns 0 for the entire range
 * the project actually occupies. Nine runs were steered by a readout that was structurally
 * incapable of moving, and it was noticed by a human reading the column, not by a tool.
 *
 * A constant column across many runs is the signature of a broken instrument, and it is one
 * `Set(...).size === 1` away from being detected automatically.
 *
 * §26 adds a second thing worth watching: `n` is the number of poses that survived scoring.
 * `score.mjs` prints "missing reference" and *continues*, so a run that lost four references
 * still writes a row — with a different `n`, silently not comparable to the one above it.
 *
 * This reports. It deliberately does NOT re-band anything: changing an axis definition
 * changes what every historical number means.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const strict = process.argv.includes('--strict');
const FILE = join(ROOT, 'scores/history.jsonl');

if (!existsSync(FILE)) { console.log('no scores/history.jsonl yet — nothing to check'); process.exit(0); }

const raw = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
const rows = [];
let hard = 0;

raw.forEach((line, i) => {
  let r;
  try { r = JSON.parse(line); }
  catch { console.error(`FAIL history.jsonl:${i + 1} is not valid JSON`); hard++; return; }
  for (const k of ['tag', 'n', 'score', 'axes']) {
    if (r[k] === undefined) { console.error(`FAIL history.jsonl:${i + 1} (${r.tag ?? '?'}) missing "${k}"`); hard++; return; }
  }
  rows.push(r);
});

const soft = [];

// --- stuck axes ------------------------------------------------------------------
// Ignore the seeded `baseline-empty` row: an empty scene is legitimately zero everywhere.
// Also ignore MARKER rows — `{"tag": "== POSE REFIT LINE ==", "n": 0, "score": 0, ...}` was
// appended by the Wave I pose refit to record a discontinuity.  It is a note, not a run, and
// counting it produced a bogus "rows were scored over different pose counts (n = 9, 0)"
// warning that blamed score.mjs for skipping poses.  A marker is `== ... ==` by convention.
const MARKER = /^\s*==.*==\s*$/;
const markers = rows.filter((r) => MARKER.test(r.tag));
const scored = rows.filter((r) => r.tag !== 'baseline-empty' && !MARKER.test(r.tag));

// --- band epochs -------------------------------------------------------------------
// tools/metrics.py was re-banded and re-weighted 2026-07-31 (reports/metrics.md §4). Rows
// scored by the new metric carry `axes_legacy`; older rows do not.  Mixing them in one
// trend compares different units — see tools/axischeck.mjs, which now spans per epoch.
const epochOf = (r) => (r.axes_legacy ? 'new-2026-07-31' : 'legacy');
const epochsSeen = [...new Set(scored.map(epochOf))];
if (epochsSeen.length > 1) {
  soft.push(`history mixes ${epochsSeen.length} band epochs (${epochsSeen.join(', ')}): ` +
            `tools/metrics.py was re-banded and re-weighted, so axis and score columns are ` +
            `not in the same units above and below the boundary. Compare within an epoch ` +
            `(node tools/axischeck.mjs), or use score_legacy, not score, across it.`);
}
const WINDOW = 5;
if (scored.length >= WINDOW) {
  const axes = [...new Set(scored.flatMap((r) => Object.keys(r.axes)))];
  for (const a of axes) {
    const recent = scored.slice(-WINDOW).map((r) => r.axes[a] ?? 0);
    if (new Set(recent).size === 1) {
      // how far back does it go?
      let run = 0;
      for (let i = scored.length - 1; i >= 0 && (scored[i].axes[a] ?? 0) === recent[0]; i--) run++;
      soft.push(`axis "${a}" has been exactly ${recent[0]} for the last ${run} run(s) — it is a flat ` +
                `signal, not a measurement. Anyone tuning against it is tuning against nothing ` +
                `(KNOWN_ISSUES §15). Read the raw statistic instead, or have an owner re-band it ` +
                `as a deliberate re-baseline.`);
    }
  }
}

// --- pose-count drift ------------------------------------------------------------
const ns = [...new Set(scored.map((r) => r.n))];
if (ns.length > 1) {
  soft.push(`rows were scored over different pose counts (n = ${ns.join(', ')}). Rows with a ` +
            `different n are averages over different sets and are not directly comparable; ` +
            `score.mjs skips a pose whose reference is missing and still writes the row.`);
}

// --- duplicate tags ---------------------------------------------------------------
const tags = scored.map((r) => r.tag);
const dupes = [...new Set(tags.filter((t, i) => tags.indexOf(t) !== i))];
if (dupes.length) {
  soft.push(`duplicate run tag(s): ${dupes.join(', ')} — scores/<tag>.json was overwritten, so ` +
            `the per-pose detail behind the earlier row no longer exists.`);
}

console.log(`history: ${rows.length} row(s), ${hard} malformed` +
            (markers.length ? `, ${markers.length} marker row(s) not counted as runs` : ''));
for (const s of soft) console.error('warn  ' + s);
if (!soft.length && !hard) console.log('ok — no stuck axes, consistent pose count, unique tags');

process.exit(hard || (strict && soft.length) ? 1 : 0);
