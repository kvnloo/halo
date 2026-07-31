#!/usr/bin/env node
/**
 * roicheck — before you quote a region number, find out what is in the crop.
 *
 *   node tools/roicheck.mjs                      # every region, its rect, its caveats
 *   node tools/roicheck.mjs sky_sun              # one region
 *   node tools/roicheck.mjs sky_sun ref_00720    # one region at one pose  (exit 1 if flagged)
 *   node tools/roicheck.mjs --drift              # the four REGIONS tables must agree
 *   node tools/roicheck.mjs --audit              # caveats no report has ever cited
 *   node tools/roicheck.mjs --json
 *
 * WHY THIS EXISTS
 * ---------------
 * The ROI regions are FIXED SCREEN RECTANGLES, not semantic masks. That caveat is written
 * down three times — docs/TARGETS.md:47, docs/LOOP.md:171, docs/KNOWN_ISSUES.md:110 — and
 * attached to nothing, so four agents rediscovered it independently, one report at a time:
 *
 *   reports/sky.md:17        "`sky_sun` at ref_00720 is not sky."
 *   reports/clouds.md:310    "That crop is not sky. At ref_00000 it contains sea stacks
 *                             and cliff."
 *   reports/weapons.md:279   "Do NOT tune to ref/roi_signatures.json's `weapon` row. It is
 *                             a clip mean over a screen rectangle that is ~65% sand."
 *   reports/ocean.md:115     "This is the THIRD TIME in this file's history that a number
 *                             was measured against something that was not water."
 *
 * That is the §19 / R9b shape — a correction that stops at the report that wrote it — in
 * the measurement every subsystem report is built on. Nothing computes this: an outlier
 * scan over the reference keyframes was tried and does NOT reproduce any of the four
 * findings above (sky@ref_00000 is a 0.5-sigma reading, sky_sun@ref_00720 is 2.2), so a
 * statistical gate here would fire on the wrong crops and miss every documented one. The
 * honest instrument is a registry of what agents actually measured, same shape as
 * tools/tells.mjs and tools/contracts.mjs.
 *
 * The one part that IS mechanical is --drift, and it runs on every invocation: the REGIONS
 * rect table is duplicated verbatim in four files (tools/roi.py, tools/_imdiff.py,
 * tools/_cloudstat.py, tools/_vegmask.py) and ref/roi_signatures.json + docs/TARGETS.md's
 * published targets were computed from tools/roi.py's copy. If a copy drifts, every number
 * measured through it silently stops being comparable to the published target and nothing
 * says so.
 *
 * SAFETY
 * Read-only. No capture, no GPU, no src/ edit, no measurement changed. Not wired into
 * preflight, postflight, npm or CI — it cannot block a wave.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const flag = (k) => argv.includes('--' + k);
const positional = argv.filter((a) => !a.startsWith('--'));

/* ------------------------------------------------------------------ the rect tables --- */
const RECT_FILES = ['tools/roi.py', 'tools/_imdiff.py', 'tools/_cloudstat.py', 'tools/_vegmask.py'];

/** Pull `'name': (a, b, c, d)` pairs out of a python REGIONS literal. */
function parseRegions(src) {
  const start = src.indexOf('REGIONS');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(open, end + 1);
  const out = {};
  for (const m of body.matchAll(/'([A-Za-z0-9_]+)'\s*:\s*\(([^)]*)\)/g)) {
    const nums = m[2].split(',').map((s) => Number(s.trim()));
    if (nums.length === 4 && nums.every(Number.isFinite)) out[m[1]] = nums;
  }
  return out;
}

const tables = {};
for (const rel of RECT_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const t = parseRegions(readFileSync(p, 'utf8'));
  if (t) tables[rel] = t;
}
const CANON_FILE = 'tools/roi.py';
const CANON = tables[CANON_FILE] || {};

/* Only a DISAGREEMENT on a shared key is drift. A copy that defines an extra region of its
 * own (tools/_cloudstat.py's `zenith`) is an extension, not a conflict: nothing published
 * is measured through it, so failing on it would be the round-4 lesson again — the gate's
 * loudest line being the one that does not matter. It is reported, and it is not a failure. */
const localOnly = [];
function driftReport() {
  const problems = [];
  localOnly.length = 0;
  for (const [rel, t] of Object.entries(tables)) {
    if (rel === CANON_FILE) continue;
    for (const [name, rect] of Object.entries(t)) {
      const c = CANON[name];
      if (!c) { localOnly.push(`${rel}: '${name}' is local to that tool (not in ${CANON_FILE})`); continue; }
      if (rect.some((v, i) => Math.abs(v - c[i]) > 1e-9)) {
        problems.push(`${rel}: '${name}' is (${rect.join(', ')}) but ${CANON_FILE} says (${c.join(', ')})`);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------- the registry --- */
let REG = { regions: {} };
try { REG = JSON.parse(readFileSync(join(ROOT, 'tools/roi_notes.json'), 'utf8')); } catch { }
const NOTES = REG.regions || {};

const applies = (note, pose) => !pose || note.poses.includes('*') || note.poses.includes(pose);

function printRegion(name, pose) {
  const rect = CANON[name];
  console.log(`\n${name}${pose ? `  @  ${pose}` : ''}`);
  if (rect) console.log(`  rect (fractional x0,y0,x1,y1): ${rect.join(', ')}   [${CANON_FILE}]`);
  else console.log(`  NOT a known region. Known: ${Object.keys(CANON).join(' ')}`);
  const notes = (NOTES[name]?.notes || []).filter((n) => applies(n, pose));
  if (!notes.length) {
    console.log('  no recorded caveat at this pose. That is NOT a clearance — it means nobody');
    console.log('  has looked yet. The crop is a screen rectangle, not a semantic mask');
    console.log('  (docs/TARGETS.md:47). Look at the crop before you quote the target.');
    return 0;
  }
  for (const n of notes) {
    console.log(`  !! ${n.poses.includes('*') ? 'ALL POSES' : n.poses.join(', ')}`);
    console.log(`     ${n.says}`);
    console.log(`     source: ${n.source}`);
  }
  return notes.length;
}

/* ------------------------------------------------------------------------- modes --- */
if (flag('json')) {
  console.log(JSON.stringify({ rects: CANON, notes: NOTES, drift: driftReport() }, null, 2));
  process.exit(0);
}

const drift = driftReport();

if (flag('drift')) {
  for (const l of localOnly) console.log(`  note: ${l}`);
  if (!drift.length) {
    console.log(`ok — ${Object.keys(tables).length} REGIONS tables agree with ${CANON_FILE} ` +
      `on every shared region.`);
    process.exit(0);
  }
  console.error(`REGION RECT DRIFT — ${drift.length} disagreement(s):`);
  for (const p of drift) console.error('  ' + p);
  console.error('');
  console.error(`ref/roi_signatures.json and docs/TARGETS.md's published per-region targets were`);
  console.error(`computed through ${CANON_FILE}'s rects. A tool measuring a different rectangle is`);
  console.error('not comparable to them, and the difference is invisible in the number.');
  process.exit(1);
}

if (flag('audit')) {
  let reports = [];
  try { reports = readdirSync(join(ROOT, 'reports')).filter((f) => f.endsWith('.md')); } catch { }
  const text = new Map(reports.map((f) => [f, readFileSync(join(ROOT, 'reports', f), 'utf8')]));
  console.log(`caveat audit over ${reports.length} file(s) in reports/`);
  console.log('For each region with a recorded caveat: which reports quote that region, and');
  console.log('do they point their reader at the caveat? (Same technique as tools/tells.mjs.)\n');
  for (const [name, entry] of Object.entries(NOTES)) {
    const sourceFiles = new Set(entry.notes.flatMap((n) =>
      n.source.split(',').map((s) => s.trim().split(':')[0].replace(/^reports\//, ''))));
    const quoting = [...text.entries()]
      .filter(([f, t]) => new RegExp('`' + name + '`').test(t))
      .map(([f]) => f);
    const uninformed = quoting.filter((f) => !sourceFiles.has(f)
      && !/roi_notes\.json|roicheck|not semantic|screen rectangle/.test(text.get(f)));
    console.log(`  ${name}: quoted by ${quoting.length} report(s); ` +
      `${uninformed.length} of them cite neither the caveat nor the screen-rectangle warning`);
    if (uninformed.length) console.log(`      ${uninformed.join(' ')}`);
  }
  console.log('\nA report in the second list may be perfectly correct — it may simply have used');
  console.log('the region at a pose where the crop is honest. The point is that its reader');
  console.log('cannot tell, which is how the same crop gets rediscovered by the next agent');
  console.log('(reports/ocean.md:115: "the third time in this file\'s history").');
  process.exit(0);
}

if (positional.length) {
  const [name, pose] = positional;
  const n = printRegion(name, pose || null);
  if (drift.length) { console.error(`\nWARNING: ${drift.length} rect drift(s); run --drift.`); }
  console.log('');
  process.exit(n > 0 ? 1 : 0);
}

console.log(`roicheck — ${Object.keys(CANON).length} region(s) from ${CANON_FILE}, ` +
  `${Object.keys(NOTES).length} with recorded caveats (tools/roi_notes.json)\n`);
console.log(`rect tables parsed: ${Object.keys(tables).join(' ')}`);
console.log(drift.length ? `DRIFT: ${drift.length} — run --drift` : 'rect tables agree.');
for (const name of Object.keys(CANON)) if (NOTES[name]) printRegion(name, null);
console.log('\nRun `node tools/roicheck.mjs <region> <pose>` before quoting a region target.');
console.log('Found a crop that is not what it is named? Add it to tools/roi_notes.json.');
process.exit(0);
