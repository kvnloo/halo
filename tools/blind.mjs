#!/usr/bin/env node
/**
 * BLIND — the only instrument in this project that has ever told the truth.
 *
 * It was run once, at the very end of wave H, and reported 0/9. Everything else the
 * loop measures had been saying "22 -> 30, improving". This file exists to make the
 * blind test cheap enough that it runs EVERY wave instead of once.
 *
 * Three modes, cheapest first:
 *
 *   node tools/blind.mjs --auto                  ~30 s, no judge, no capture
 *       Machine discriminator (tools/discriminate.py). Reports how many standard
 *       deviations of the REFERENCE CLIP'S OWN frame-to-frame variation separate our
 *       render from the reference. ONE-WAY: a high number proves we lose; a low
 *       number proves nothing. Run it after every subsystem change.
 *
 *   node tools/blind.mjs --capture --contact     capture + one sheet
 *       Builds ONE contact sheet with every pair on it, so a judge spends one look
 *       instead of nine. Per-pose sheets are still written for detail work.
 *
 *   node tools/blind.mjs --score "ref_00000=A,..."
 *       Reveal and tally. Appends to scores/blind.jsonl so the honest number becomes
 *       a trend line rather than a one-off ceremony.
 *
 * The answer key is written OUTSIDE the repo (--keydir). Side assignment comes from
 * node:crypto per run — NOT from a hash of the render file, which is what
 * `sbs.py --blind` used and which any agent standing in the repo could recompute.
 *
 *   node tools/blind.mjs --reveal
 *   node tools/blind.mjs --history
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { randomInt, createHash } from 'node:crypto';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);
const PY = join(ROOT, '.venv/bin/python');

const KEYDIR = arg('keydir', '/tmp/claude-1000/-workspace-zer0-products-halo/39c41fd0-07f6-4104-85cb-913b19302333/scratchpad/blindkeys');
const KEYFILE = join(KEYDIR, 'key.json');
const LOG = join(ROOT, 'scores/blind.jsonl');

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

function logRow(row) {
  mkdirSync(join(ROOT, 'scores'), { recursive: true });
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString().slice(0, 19), ...row }) + '\n');
}

/* ---------------------------------------------------------------- history */
if (has('history')) {
  if (!existsSync(LOG)) { console.log('no blind history yet — run `node tools/blind.mjs --auto`'); process.exit(0); }
  const rows = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(['when'.padEnd(20), 'tag'.padEnd(16), 'kind'.padEnd(6), 'result'].join(' '));
  for (const r of rows) {
    const result = r.kind === 'auto'
      ? `separability ${r.separability}  (${r.detectable}/pose detectable)  top: ${r.top_tell}`
      : `${r.chose_render}/${r.n} render wins   rate ${r.render_win_rate}`;
    console.log([String(r.at).replace('T', ' ').padEnd(20), String(r.tag ?? '-').slice(0, 16).padEnd(16),
      String(r.kind).padEnd(6), result].join(' '));
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ auto */
if (has('auto')) {
  const shots = arg('shots', 'shots/blindcap');
  const a = ['tools/discriminate.py', '--shots', shots, '--quiet',
    '--json', 'scores/_blind_auto.json'];
  if (has('rebuild-null')) a.push('--rebuild-null');
  if (has('verbose')) a.push('--verbose');
  const r = sh(PY, a, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error('discriminate failed'); process.exit(1); }
  const out = JSON.parse(readFileSync(join(ROOT, 'scores/_blind_auto.json'), 'utf8'));
  console.log(JSON.stringify(out, null, 2));
  logRow({
    kind: 'auto', tag: arg('tag', basename(shots)), shots,
    separability: out.separability, detectable: out.detectable_features_per_pose,
    top_tell: out.top_tells?.[0]?.feature ?? null, verdict: out.verdict,
  });
  console.error('\nlogged to scores/blind.jsonl — `node tools/blind.mjs --history` for the trend');
  console.error('NOTE: low separability is not a pass. It only means THESE features stopped '
    + 'catching us. Only the human blind test can certify a pass.');
  process.exit(0);
}

/* ---------------------------------------------------------------- reveal */
if (has('reveal') || has('score') || has('picks')) {
  if (!existsSync(KEYFILE)) { console.error('no key file at ' + KEYFILE); process.exit(1); }
  const key = JSON.parse(readFileSync(KEYFILE, 'utf8'));
  if (has('reveal')) { console.log(JSON.stringify(key, null, 2)); process.exit(0); }

  const raw = has('picks') ? readFileSync(resolve(ROOT, arg('picks')), 'utf8') : arg('score');
  const picks = Object.fromEntries(
    raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
      .map((s) => s.split('=').map((t) => t.trim())));

  let ours = 0, theirs = 0, n = 0;
  const rows = [];
  for (const [pose, pick] of Object.entries(picks)) {
    const k = key.pairs[pose];
    if (!k) { rows.push({ pose, result: 'unknown pose' }); continue; }
    n++;
    const chose = pick.toUpperCase() === k.renderSide ? 'render' : 'reference';
    if (chose === 'render') ours++; else theirs++;
    rows.push({ pose, picked: pick, was: chose });
  }
  const rate = n ? +(ours / n).toFixed(3) : 0;
  const out = {
    n, chose_render: ours, chose_reference: theirs, render_win_rate: rate, rows,
    verdict: n === 0 ? 'no data'
      : ours >= theirs ? 'RENDER held its own or won — this is the bar'
        : rate >= 0.35 ? 'render is close; the reference still wins more often than not'
          : 'reference wins clearly — keep going',
  };
  console.log(JSON.stringify(out, null, 2));
  logRow({ kind: 'human', tag: key.tag ?? null, shots: key.shots, n, chose_render: ours, render_win_rate: rate });
  process.exit(0);
}

/* --------------------------------------------------------------- capture */
let SHOTS = arg('shots', 'shots/blindcap');
if (has('capture')) {
  SHOTS = arg('shots', `shots/blind_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
  mkdirSync(join(ROOT, SHOTS), { recursive: true });
  const pc = sh('node', ['tools/parsecheck.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (pc.status !== 0) {
    console.error('parsecheck FAILED — a module that does not parse is skipped silently and '
      + 'its subsystem vanishes from the frame with no error. Refusing to capture.');
    console.error(pc.stdout || pc.stderr); process.exit(2);
  }
  process.stderr.write(`[blind] parsecheck ok; capturing into ${SHOTS} ...\n`);
  const cap = sh('node', ['tools/capture.mjs', '--all', '--outdir', SHOTS,
    '--settle', arg('settle', '48')], { stdio: ['ignore', 'pipe', 'inherit'] });
  if (cap.status !== 0) { console.error('capture failed'); process.exit(2); }
  try {
    const info = JSON.parse(cap.stdout);
    if (info.failedModules?.length) {
      console.error('REFUSING: capture reported failedModules ' + JSON.stringify(info.failedModules)
        + ' — a blind test with a missing subsystem is not a fair fight.');
      process.exit(2);
    }
  } catch { /* capture printed something else; the parsecheck above is the real guard */ }
}

/* ----------------------------------------------------------------- build */
const OUT = arg('out', 'shots/blind');
let files = readdirSync(join(ROOT, SHOTS)).filter((f) => /^ref_\d+\.png$/.test(f)).sort();
if (!files.length) { console.error(`no ref_*.png in ${SHOTS}`); process.exit(1); }

const N = parseInt(arg('n', '0'), 10);
if (N > 0 && N < files.length) {
  const step = files.length / N;
  files = Array.from({ length: N }, (_, i) => files[Math.floor(i * step)]);
}

mkdirSync(join(ROOT, OUT), { recursive: true });
mkdirSync(KEYDIR, { recursive: true });

const pairs = {}, spec = [];
for (const f of files) {
  const pose = f.replace('.png', '');
  const refFile = `ref/keyframes/kf_${pose.split('_')[1]}.png`;
  if (!existsSync(join(ROOT, refFile))) continue;
  const renderSide = randomInt(2) ? 'A' : 'B';       // CSPRNG, per run, not derivable
  pairs[pose] = { sheet: `${OUT}/${pose}.png`, renderSide, refFile, render: `${SHOTS}/${f}` };
  spec.push({ pose, ref: refFile, render: `${SHOTS}/${f}`, renderSide });
}
if (!spec.length) { console.error('no pose had a matching ref/keyframes/kf_*.png'); process.exit(1); }

const specFile = join(KEYDIR, 'pairs.json');        // outside the repo: it carries the key
writeFileSync(specFile, JSON.stringify(spec));
const sheetArgs = ['tools/blindsheet.py', '--pairs', specFile, '--out', OUT];
if (!has('contact')) sheetArgs.push('--no-contact');
const sr = sh(PY, sheetArgs);
if (sr.status !== 0) { console.error(sr.stderr?.slice(0, 800)); process.exit(1); }
const sheets = JSON.parse(sr.stdout);

writeFileSync(KEYFILE, JSON.stringify({
  created: new Date().toISOString(), tag: arg('tag', basename(SHOTS)), shots: SHOTS, pairs,
  digest: createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 16),
}, null, 2));

console.log(JSON.stringify({
  ok: true,
  n: Object.keys(pairs).length,
  shots: SHOTS,
  contact: sheets.contact_pages ?? null,
  sheets: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v.sheet])),
  keyfile: KEYFILE,
  judge: sheets.contact_pages
    ? `Read the ${sheets.contact_pages.length} contact page(s) above — that is the whole `
      + 'judgement. For each row pick the frame that looks like the real game. Open a '
      + 'per-pose sheet only where you are unsure. Then: '
      + 'node tools/blind.mjs --score "ref_00000=A,..."'
    : 'Judge each sheet, then: node tools/blind.mjs --score "ref_00000=A,..."',
  rule: 'Do not read the key, stat the reference files, or run --reveal until every '
      + 'verdict is written down.',
}, null, 2));
