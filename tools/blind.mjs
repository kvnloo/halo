#!/usr/bin/env node
/**
 * Blind A/B comparison harness.
 *
 * Builds side-by-side sheets in which the reference and our render are placed in a
 * randomised, unlabelled order, so a critic can be asked "which of these two frames
 * looks better?" without being told which one is the real game.
 *
 * The answer key is deliberately written OUTSIDE the repo, into a directory passed via
 * --keydir (default: the session scratchpad). A critic agent working in the repo has
 * no way to stumble on it. Reveal with --reveal after the verdicts are in.
 *
 *   node tools/blind.mjs --shots shots/phase2 --out shots/blind --keydir /tmp/keys
 *   node tools/blind.mjs --reveal --keydir /tmp/keys
 *   node tools/blind.mjs --score "ref_00000=A,ref_00450=B" --keydir /tmp/keys
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const KEYDIR = arg('keydir', '/tmp/claude-1000/-workspace-zer0-products-halo/39c41fd0-07f6-4104-85cb-913b19302333/scratchpad/blindkeys');
const KEYFILE = join(KEYDIR, 'key.json');

/* ------------------------------------------------------------------ reveal */
if (has('reveal') || has('score')) {
  if (!existsSync(KEYFILE)) { console.error('no key file at ' + KEYFILE); process.exit(1); }
  const key = JSON.parse(readFileSync(KEYFILE, 'utf8'));
  if (has('reveal')) { console.log(JSON.stringify(key, null, 2)); process.exit(0); }

  // --score "pose=A,pose=B"  -> did the critic pick our render or the reference?
  const picks = Object.fromEntries(arg('score').split(',').map((s) => s.trim().split('=')));
  let ours = 0, theirs = 0, n = 0;
  const rows = [];
  for (const [pose, pick] of Object.entries(picks)) {
    const k = key.pairs[pose];
    if (!k) { rows.push({ pose, result: 'unknown pose' }); continue; }
    n++;
    const chose = pick.trim().toUpperCase() === k.renderSide ? 'render' : 'reference';
    if (chose === 'render') ours++; else theirs++;
    rows.push({ pose, picked: pick, was: chose });
  }
  console.log(JSON.stringify({
    n, chose_render: ours, chose_reference: theirs,
    render_win_rate: n ? +(ours / n).toFixed(3) : 0,
    rows,
    verdict: n === 0 ? 'no data'
      : ours >= theirs ? 'RENDER held its own or won — this is the bar'
      : ours / n >= 0.35 ? 'render is close; the reference still wins more often than not'
      : 'reference wins clearly — keep going',
  }, null, 2));
  process.exit(0);
}

/* ------------------------------------------------------------------- build */
const SHOTS = arg('shots', 'shots/latest');
const OUT = arg('out', 'shots/blind');

const files = readdirSync(join(ROOT, SHOTS)).filter((f) => /^ref_\d+\.png$/.test(f)).sort();
if (!files.length) { console.error(`no ref_*.png in ${SHOTS}`); process.exit(1); }

mkdirSync(join(ROOT, OUT), { recursive: true });
mkdirSync(KEYDIR, { recursive: true });

const pairs = {};
for (const f of files) {
  const pose = f.replace('.png', '');
  const refFile = `ref/keyframes/kf_${pose.split('_')[1]}.png`;
  if (!existsSync(join(ROOT, refFile))) continue;

  const sheet = `${OUT}/${pose}.png`;
  const r = spawnSync(join(ROOT, '.venv/bin/python'),
    ['tools/sbs.py', refFile, `${SHOTS}/${f}`, sheet, '--blind'],
    { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr?.slice(0, 400)); continue; }

  // sbs.py writes "<sheet>.key" next to the sheet; move it out of the repo
  const sidecar = join(ROOT, sheet + '.key');
  const line = readFileSync(sidecar, 'utf8').trim();
  spawnSync('rm', ['-f', sidecar]);
  const renderSide = /A=render/.test(line) ? 'A' : 'B';
  pairs[pose] = { sheet, renderSide, refFile, render: `${SHOTS}/${f}` };
}

writeFileSync(KEYFILE, JSON.stringify({
  created: 'run-scoped', shots: SHOTS, pairs,
  digest: createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 16),
}, null, 2));

console.log(JSON.stringify({
  ok: true,
  n: Object.keys(pairs).length,
  sheets: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v.sheet])),
  keyfile: KEYFILE,
  note: 'Each sheet shows two frames labelled A and B in randomised order. One is the '
      + 'real game, one is this build. The key is outside the repo.',
}, null, 2));
