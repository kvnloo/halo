#!/usr/bin/env node
/**
 * provcheck — join `scores/provenance.jsonl` to `scores/history.jsonl` and refuse to let
 * two rows be read as one series when the thing that produced them changed.
 *
 *   node tools/provcheck.mjs            # table + warnings, exit 0 (advisory)
 *   node tools/provcheck.mjs --strict   # exit 1 if any adjacent pair is incomparable
 *   node tools/provcheck.mjs --json
 *
 * WHY THIS EXISTS
 * ---------------
 * `tools/capture.mjs` already stamps every capture with the sha256 of `src/world/poses.js`,
 * the sha256 of `capture.mjs` / `metrics.py` / `score.mjs`, the git SHA, the settle count and
 * the resolution, and mirrors one line per capture into `scores/provenance.jsonl` keyed by
 * `outdir` — and `score.mjs` writes its frames to `shots/<tag>/`, so the tag is the join key
 * back to the matching row of `scores/history.jsonl`.
 *
 * Nothing reads it. `grep -rn provenance.jsonl tools/` returns exactly one file: the writer.
 * A provenance record nobody joins is a receipt in a drawer.
 *
 * What it would have caught, from the record as it stands today:
 *
 *   • The last three history rows — `waveI-posefit`, `waveI-fitstand`, `waveI-handstand` —
 *     were each captured under a DIFFERENT `poses.js` (19ebfe59d18e0da6, 9eaf76fa87dcda0c,
 *     0f4f314680b198d8) and a DIFFERENT `metrics.py` (507bfe35…, 05fcf4e4…, 85c1f653…).
 *     They sit adjacent in one series and the last two are read against each other as a
 *     fit-vs-hand comparison. Neither the camera framing nor the instrument was held still.
 *   • The discontinuity WAS eventually noticed — by a human, after the fact, who hand-typed a
 *     `{"tag": "== POSE REFIT LINE =="}` row into `history.jsonl` saying "do not compare
 *     across either". That marker is the manual version of this check, and it was written
 *     once, below all three rows, so it does not separate them from each other.
 *   • KNOWN_ISSUES §3 / `ba09973`: "applying a fit invalidates every previously recorded
 *     score", with nothing on a score saying which pose set it used.
 *   • KNOWN_ISSUES §26: `waveG` and `waveG-settle96` are identical code and differ by 0.52 on
 *     `--settle` alone; the history row records no settle. This prints it.
 *
 * It also checks the LIVE tree: if `src/world/poses.js` has changed since the last recorded
 * run, the next score you take is already on a different framing than the row above it.
 *
 * This re-bands nothing, edits nothing, and never runs at capture time.
 * Exit: 0 advisory • 1 with --strict and an incomparable adjacent pair • 2 malformed input.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');
const quiet = argv.includes('--quiet');

const HIST = join(ROOT, 'scores/history.jsonl');
const PROV = join(ROOT, 'scores/provenance.jsonl');

const out = (s) => { if (!asJson && !quiet) console.log(s); };

function readJsonl(file) {
  if (!existsSync(file)) return null;
  const rows = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try { rows.push(JSON.parse(l)); }
    catch { rows.push({ __malformed: i + 1 }); }
  });
  return rows;
}

const hist = readJsonl(HIST);
const prov = readJsonl(PROV);

if (!hist) { out('no scores/history.jsonl — nothing to check'); process.exit(0); }
if (!prov) {
  out('no scores/provenance.jsonl yet — every capture from tools/capture.mjs appends one.');
  out('Until then no history row can be tied to the tree that produced it.');
  process.exit(0);
}

const malformed = [...hist, ...prov].filter((r) => r.__malformed);
if (malformed.length) {
  console.error(`FAIL ${malformed.length} malformed line(s) in the score record — a truncated ` +
                `append corrupts the longitudinal series for everyone.`);
}

/* latest provenance record per `shots/<tag>` outdir — that is score.mjs's capture dir. */
const byTag = new Map();
for (const p of prov) {
  if (p.__malformed || typeof p.outdir !== 'string') continue;
  const m = /^shots\/(.+?)\/?$/.exec(p.outdir);
  if (!m) continue;                                  // /tmp probes, ablations, knobcheck runs
  const prev = byTag.get(m[1]);
  if (!prev || String(p.ts) > String(prev.ts)) byTag.set(m[1], p);
}

/* the fingerprint that has to hold still for two rows to be one series */
const fp = (p) => (p ? {
  poses: p.poses?.sha256 ?? null,
  metrics: p.tools?.metrics ?? null,
  capture: p.tools?.capture ?? null,
  score: p.tools?.score ?? null,
  settle: p.opts?.settle ?? null,
  res: p.opts?.w && p.opts?.h ? `${p.opts.w}x${p.opts.h}` : null,
  git: p.git?.sha ? String(p.git.sha).slice(0, 8) : null,
  dirtySrc: p.git?.dirtySrc ?? null,
  ts: p.ts ?? null,
} : null);

const LABEL = {
  poses: 'the camera pose table (src/world/poses.js) — a refit moves the camera, so the two ' +
         'runs are not looking at the same thing (§3)',
  metrics: 'the measuring instrument (tools/metrics.py) — the axes were recomputed by ' +
           'different code',
  score: 'the scoring/banding code (tools/score.mjs)',
  capture: 'the capture harness (tools/capture.mjs)',
  settle: 'the settle count — §26: waveG vs waveG-settle96 is 0.52 points of pure settle',
  res: 'the capture resolution',
};
/* Which changes make two rows incomparable, vs. merely worth knowing. */
const HARD = new Set(['poses', 'metrics', 'score', 'settle', 'res']);

const rowsOut = [];
const warn = [];
const scored = hist.filter((r) => !r.__malformed && r.tag && r.n !== 0);

for (const r of scored) rowsOut.push({ tag: r.tag, n: r.n, score: r.score, prov: fp(byTag.get(r.tag)) });

/* --- adjacent pairs -------------------------------------------------------------- */
let incomparable = 0;
for (let i = 1; i < rowsOut.length; i++) {
  const a = rowsOut[i - 1], b = rowsOut[i];
  if (!a.prov || !b.prov) continue;
  const changed = Object.keys(LABEL).filter((k) => a.prov[k] !== b.prov[k] && a.prov[k] != null && b.prov[k] != null);
  const hard = changed.filter((k) => HARD.has(k));
  if (hard.length) incomparable++;
  if (changed.length) {
    warn.push(`${a.tag} -> ${b.tag}: ${changed.length} thing(s) changed between these two runs:\n` +
      changed.map((k) => `      - ${k}: ${a.prov[k]} -> ${b.prov[k]}\n        ${LABEL[k]}`).join('\n') +
      (hard.length ? `\n      => these rows are NOT one series. Comparing them measures the harness, not the render.` : ''));
  }
}

/* --- unprovenanced rows ---------------------------------------------------------- */
const noProv = rowsOut.filter((r) => !r.prov).map((r) => r.tag);
if (noProv.length) {
  warn.push(`${noProv.length} history row(s) have no provenance record and cannot be tied to a ` +
            `tree, a pose set or a tool version: ${noProv.join(', ')}.\n` +
            `      (Rows recorded before the stamp landed are unrecoverable; new ones are not — ` +
            `capture through tools/capture.mjs and the record writes itself.)`);
}

/* --- the live tree vs the last recorded run --------------------------------------- */
let live = null;
try {
  live = createHash('sha256').update(readFileSync(join(ROOT, 'src/world/poses.js'))).digest('hex').slice(0, 16);
} catch { }
const lastProv = [...rowsOut].reverse().find((r) => r.prov);
if (live && lastProv && lastProv.prov.poses && lastProv.prov.poses !== live) {
  warn.push(`the working tree's src/world/poses.js (${live}) is NOT the one that produced the ` +
            `last recorded run "${lastProv.tag}" (${lastProv.prov.poses}).\n` +
            `      Any score you take now is on a different camera framing than every row in ` +
            `history.jsonl. Say so next to the number, or re-capture the baseline.`);
}

/* --- output ----------------------------------------------------------------------- */
if (asJson) {
  console.log(JSON.stringify({ ok: incomparable === 0 && !malformed.length, incomparable, rows: rowsOut, warnings: warn }, null, 2));
} else if (!quiet) {
  const c = (s, w) => String(s ?? '-').slice(0, w).padEnd(w);
  console.log([c('tag', 22), c('n', 3), c('score', 7), c('poses', 17), c('metrics.py', 17), c('settle', 7), c('git', 9)].join(' '));
  for (const r of rowsOut) {
    console.log([c(r.tag, 22), c(r.n, 3), c(r.score, 7), c(r.prov?.poses, 17),
      c(r.prov?.metrics, 17), c(r.prov?.settle, 7), c(r.prov?.git, 9)].join(' '));
  }
  console.log('');
  for (const w of warn) console.error('warn  ' + w);
  if (!warn.length) console.log('ok — every adjacent pair of scored runs shares one pose set and one instrument');
  else console.error(`\n${incomparable} adjacent pair(s) are not comparable.`);
}

if (malformed.length) process.exit(2);
process.exit(strict && incomparable ? 1 : 0);
