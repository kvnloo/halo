#!/usr/bin/env node
/**
 * shotcheck — "were the frames you scored all taken by the same capture?"
 *
 *   node tools/shotcheck.mjs                    # every shots/<tag> that has a scores/<tag>.json
 *   node tools/shotcheck.mjs shots/latest       # one directory
 *   node tools/shotcheck.mjs --spread 900       # allowed mtime spread, seconds (default 900)
 *   node tools/shotcheck.mjs --warn             # never exit non-zero
 *   node tools/shotcheck.mjs --json
 *
 * WHY
 * ---
 * `tools/capture.mjs` never clears its `--outdir`, and `tools/score.mjs:110` measures
 * *every* `ref_*.png` it finds there:
 *
 *     const shots = readdirSync(join(ROOT, outdir)).filter((f) => /^ref_\d+\.png$/.test(f));
 *
 * So a capture that writes some of the nine poses into a directory that already holds nine
 * leaves the rest behind, and they are scored as if they were part of this run. The default
 * tag is `latest`, and `node tools/score.mjs --pose ref_00450` — the second invocation in
 * score.mjs's own docblock — captures ONE pose into `shots/latest` and then averages it with
 * eight frames from whenever that directory was last full.
 *
 * Every existing gate passes while this happens. The capture exits 0. All three integrity
 * channels are clean — the stale frames came from a build that was also complete. `n` is
 * still 9, so `historycheck.mjs`'s pose-count check is satisfied. The row in history.jsonl
 * is indistinguishable from a real one.
 *
 * It is in the tree right now:
 *
 *     shots/latest/ref_00000.png   2026-07-30 17:02
 *     shots/latest/ref_00120.png   2026-07-30 11:49   (and the other seven)
 *
 * Five hours and an unknown number of `src/` edits apart. `scores/rescore_latest.json` was
 * written from that mixture at 02:11 on 07-31 with `"n": 9`.
 *
 * This tool reads mtimes and `_capture.json`. It moves and deletes nothing — a stale frame
 * is evidence, and the fix is to re-capture the directory, not to have it quietly removed.
 *
 * Exit codes:  0 ok  •  1 a directory holds frames from more than one capture  •  2 broke
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const WARN = has('warn');
const AS_JSON = has('json');
const SPREAD = Number(arg('spread', '900')) * 1000;
const dirs = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Default target set: only directories that were actually *scored*. shots/ is also full of
 *  ad-hoc probe directories with deliberately mixed contents; those are not measurements and
 *  flagging them would be noise. A `scores/<tag>.json` is the proof a directory was used as
 *  the basis for a recorded number. */
function scoredDirs() {
  const out = [];
  const sdir = join(ROOT, 'scores');
  if (!existsSync(sdir)) return out;
  for (const f of readdirSync(sdir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const tag = f.slice(0, -5);
    let d = join('shots', tag);
    try {
      const j = JSON.parse(readFileSync(join(sdir, f), 'utf8'));
      if (j.rescored_from) d = j.rescored_from;      // --rescore names its own directory
    } catch { continue; }
    if (existsSync(join(ROOT, d))) out.push(d);
  }
  return [...new Set(out)];
}

function checkDir(rel) {
  const abs = join(ROOT, rel);
  let files;
  try { files = readdirSync(abs).filter((f) => /^ref_\d+\.png$/.test(f)); }
  catch { return { dir: rel, ok: true, skipped: 'not a directory' }; }
  if (files.length < 2) return { dir: rel, ok: true, skipped: `${files.length} ref_ frame(s)` };

  const st = files.map((f) => ({ f, m: statSync(join(abs, f)).mtimeMs })).sort((a, b) => a.m - b.m);
  const spread = st[st.length - 1].m - st[0].m;

  // A side-by-side older than the frame it is supposed to show is the same hazard one step
  // downstream: the critic reviews last wave's image and reports on it in good faith.
  const staleSbs = [];
  for (const { f, m } of st) {
    const sbs = join(abs, `sbs_${f}`);
    try { if (statSync(sbs).mtimeMs + 1000 < m) staleSbs.push(`sbs_${f}`); } catch { }
  }

  // `_capture.json` (the G2 provenance stamp) names the files that capture actually wrote.
  // Anything else present is a leftover, whatever its mtime says.
  let unstamped = [];
  const cj = join(abs, '_capture.json');
  if (existsSync(cj)) {
    try {
      const rec = JSON.parse(readFileSync(cj, 'utf8'));
      const written = new Set((rec.files || []).map((x) => basename(typeof x === 'string' ? x : (x.file || x.path || ''))));
      if (written.size) unstamped = files.filter((f) => !written.has(f));
    } catch { }
  }

  const ok = spread <= SPREAD && unstamped.length === 0;
  return {
    dir: rel, ok, n: files.length,
    spreadSec: Math.round(spread / 1000),
    oldest: `${st[0].f} ${fmt(st[0].m)}`,
    newest: `${st[st.length - 1].f} ${fmt(st[st.length - 1].m)}`,
    outliers: st.filter((x) => x.m - st[0].m > SPREAD || st[st.length - 1].m - x.m > SPREAD).map((x) => `${x.f} ${fmt(x.m)}`),
    unstamped, staleSbs,
    hasCaptureStamp: existsSync(cj),
  };
}

const targets = dirs.length ? dirs : scoredDirs();
const results = targets.map(checkDir);
const fails = results.filter((r) => !r.ok);

if (AS_JSON) {
  console.log(JSON.stringify({ ok: fails.length === 0, checked: results.length, results }, null, 2));
} else {
  for (const r of results) {
    if (r.skipped) { console.log(`skip ${r.dir} — ${r.skipped}`); continue; }
    if (r.ok) {
      console.log(`ok   ${r.dir} — ${r.n} frames, captured within ${r.spreadSec}s of each other` +
        (r.hasCaptureStamp ? '' : ' (no _capture.json: pre-dates the provenance stamp)'));
      if (r.staleSbs.length) console.error(`warn ${r.dir} — side-by-side older than its frame: ${r.staleSbs.join(' ')}`);
      continue;
    }
    console.error(`FAIL ${r.dir} — ${r.n} frames span ${r.spreadSec}s; this is not one capture.`);
    console.error(`       oldest ${r.oldest}`);
    console.error(`       newest ${r.newest}`);
    if (r.outliers.length) console.error(`       odd one(s) out: ${r.outliers.join(', ')}`);
    if (r.unstamped.length) console.error(`       present but not written by the last capture: ${r.unstamped.join(' ')}`);
    if (r.staleSbs.length) console.error(`       side-by-side older than its frame: ${r.staleSbs.join(' ')}`);
  }
  if (fails.length) {
    console.error(`\n${fails.length} scored directory(ies) hold frames from more than one capture.`);
    console.error('Any score taken over them is an average across two builds. Re-capture the whole');
    console.error('set into a FRESH tag before recording a number:');
    console.error('  node tools/score.mjs --tag <new-tag>          # never reuse a tag dir');
  } else if (results.length) {
    console.log(`\nok — ${results.length} scored shots directory(ies), each from a single capture`);
  } else {
    console.log('no scored shots directories found (shots/ is gitignored; nothing to check here)');
  }
}

process.exit(!WARN && fails.length ? 1 : 0);
