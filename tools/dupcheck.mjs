#!/usr/bin/env node
/**
 * dupcheck — "this run measured exactly what the previous run measured."
 *
 *   node tools/dupcheck.mjs            # report; exit 1 only if the NEWEST pair is identical
 *   node tools/dupcheck.mjs --all      # exit 1 if any consecutive pair is identical
 *   node tools/dupcheck.mjs --warn     # never exit non-zero (CI advisory)
 *   node tools/dupcheck.mjs --json
 *
 * WHY
 * ---
 * The project's most expensive failures all share one signature: an arm that comes out
 * *byte-identical* to its baseline. A `--config` key nothing reads (KNOWN_ISSUES §9,
 * ledger S1), a pass that loaded but drew nothing (`ssao.js`/`ssr.js`, four waves), a
 * module that stopped parsing and was skipped in silence (§20). In every case the capture
 * exits 0, the integrity channels are clean, `n` is unchanged, and a number lands in
 * `scores/history.jsonl` that looks like a measurement of the fix.
 *
 * `tools/historycheck.mjs` watches two other shapes — an axis that never moves across the
 * whole file (§15's `grade`) and a change in `n` (§26). Neither sees this one: a duplicate
 * pair has six perfectly healthy, *moving* axes that simply did not move THIS time.
 *
 * It is already in the record three times, and nothing said so:
 *
 *   latest    -> latest         all six axes, all raw, score 22.24 identical
 *   waveE     -> waveE-fix      identical to 4 dp — and perf differs (fps 0 -> 207), so a
 *                               real re-capture happened; drawCalls 601 and tris
 *                               14,057,892 are identical too, i.e. the "fix" changed
 *                               nothing about the scene that was drawn.
 *   waveH     -> waveI-prefit   identical, fps 187 -> 109. Same story.
 *
 * Two of those three are explicitly named as fixes. A run whose image metrics are
 * bit-for-bit its predecessor's is not evidence that the fix is small; it is evidence that
 * the fix did not reach the image, and it needs to be said out loud at the moment it is
 * recorded rather than found by a human reading a column six waves later.
 *
 * This tool reads. It re-bands nothing and rewrites nothing.
 *
 * Exit codes:  0 ok  •  1 a duplicate that this invocation gates on  •  2 dupcheck broke
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const ALL = has('all');
const WARN = has('warn');
const AS_JSON = has('json');
const FILE = join(ROOT, 'scores/history.jsonl');

if (!existsSync(FILE)) {
  if (!AS_JSON) console.log('no scores/history.jsonl yet — nothing to check');
  process.exit(0);
}

/** The measured part of a row. Deliberately excludes `tag` and `perf`: the tag is a label,
 *  and fps/ms are timing noise that differ between two runs of the identical scene — which
 *  is exactly what makes them useful as corroboration below, not as part of the key. */
const MEASURED = ['score', 'score_comparative', 'score_geometric', 'score_legacy',
  'axes', 'axes_legacy', 'progress', 'raw'];
const sig = (r) => JSON.stringify(MEASURED.map((k) => r[k] ?? null));

const rows = [];
let bad = 0;
readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).forEach((line, i) => {
  try {
    const r = JSON.parse(line);
    // Marker rows (n = 0, no axes) are annotations, not runs. `== POSE REFIT LINE ==` is one.
    if (!r.n || !r.axes) return;
    rows.push({ ...r, _line: i + 1 });
  } catch { bad++; }
});

if (bad && !AS_JSON) console.error(`warn: ${bad} unparseable line(s) — that is historycheck's job, not this one`);

const dups = [];
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  if (sig(a) !== sig(b)) continue;
  const pa = a.perf || {}, pb = b.perf || {};
  const recaptured = (pa.fps !== pb.fps) || (pa.ms !== pb.ms);
  const sameScene = pa.drawCalls === pb.drawCalls && pa.tris === pb.tris;
  dups.push({
    prev: a.tag, tag: b.tag, line: b._line, score: b.score,
    recaptured, sameScene,
    note: recaptured
      ? (sameScene
        ? 'a real re-capture (perf differs) that drew the SAME scene (drawCalls/tris identical) — whatever changed did not reach the image'
        : 'a real re-capture (perf differs) whose every image metric is unchanged')
      : 'no perf difference either — possibly the same run recorded twice, or a --rescore of the same PNGs',
  });
}

const newestIsDup = dups.length > 0 && dups[dups.length - 1].line === rows[rows.length - 1]._line;

if (AS_JSON) {
  console.log(JSON.stringify({ ok: dups.length === 0, runs: rows.length, newestIsDup, duplicates: dups }, null, 2));
} else if (!dups.length) {
  console.log(`ok — ${rows.length} runs, no consecutive run repeats its predecessor's measurements`);
} else {
  console.error(`${dups.length} duplicate pair(s) in ${rows.length} runs — a run that measures exactly`);
  console.error('what the run before it measured is not a small improvement, it is a change that');
  console.error('did not reach the image (dead knob / dead pass / stale frames):\n');
  for (const d of dups) {
    console.error(`  ${d.prev}  ->  ${d.tag}   (history.jsonl line ${d.line}, score ${d.score})`);
    console.error(`      ${d.note}`);
  }
  console.error('\nWhat to do: before recording another run, prove the change reaches the image —');
  console.error('  node tools/ablate.mjs ...            switch the thing off, expect the frame to move');
  console.error('  node tools/knobcheck.mjs --ab k=a,k=b   byte-compare two config arms');
  console.error('  node tools/shotcheck.mjs shots/<tag>    the frames scored were all from one capture');
}

const gate = WARN ? false : (ALL ? dups.length > 0 : newestIsDup);
process.exit(gate ? 1 : 0);
