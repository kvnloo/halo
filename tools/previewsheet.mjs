#!/usr/bin/env node
/**
 * Showcase contact sheet.
 *
 * A curated tour of the level — one shot per thing worth looking at — rather than nine
 * variations of the same reference-matched pose. Dark surround, a caption bar under each
 * cell, monospace labels.
 *
 *   node tools/previewsheet.mjs                  # capture + build
 *   node tools/previewsheet.mjs --no-capture     # rebuild from existing frames
 *   node tools/previewsheet.mjs --cols 3 --cell 1280
 *
 * Every shot is captured in ONE page load via the capture daemon, so twelve frames cost
 * one module init rather than twelve.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const OUT = 'shots/preview';
const PY = join(ROOT, '.venv/bin/python');
const COLS = Number(arg('cols', 3));
const CELL_W = Number(arg('cell', 1280));       // per-cell width in the sheet
const sh = (c, a, o = {}) => spawnSync(c, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6, ...o });

/**
 * The tour. Order is the reading order of the sheet.
 * `pose` is a named pose in src/world/poses.js; `caption` is what appears under the cell.
 */
const SHOTS = [
  { pose: 'shot_beach_establishing', caption: '01 beach — establishing' },
  { pose: 'ref_00000',               caption: '02 opening shot (reference-matched)' },
  { pose: 'shot_forerunner_bridge',  caption: '03 forerunner bridge' },
  { pose: 'shot_bridge_underside',   caption: '04 bridge underside — light shafts' },
  { pose: 'shot_hero_stack',         caption: '05 hero sea stack + tree' },
  { pose: 'shot_stack_gauntlet',     caption: '06 stack gauntlet' },
  { pose: 'shot_shoreline',          caption: '07 shoreline — foam + wet sand' },
  { pose: 'shot_water_edge',         caption: '08 waterline — refraction + caustics' },
  { pose: 'shot_tide_pools',         caption: '09 tide pools' },
  { pose: 'shot_cliff_vegetation',   caption: '10 cliff + vegetation' },
  { pose: 'shot_sky_ring',           caption: '11 halo ring + threshold' },
  { pose: 'shot_weapon_detail',      caption: '12 MA5B viewmodel' },
];

mkdirSync(join(ROOT, OUT), { recursive: true });

/* ------------------------------------------------------------------- capture */
if (!has('no-capture')) {
  process.stderr.write(`[sheet] capturing ${SHOTS.length} showcase poses...\n`);
  // One daemon request, one page init, every pose.
  const port = existsSync('/tmp/halo-captured.port')
    ? readFileSync('/tmp/halo-captured.port', 'utf8').trim() : null;

  let served = false;
  if (port) {
    const body = JSON.stringify({
      poses: SHOTS.map((s) => s.pose), w: 1920, h: 1080,
      settle: Number(arg('settle', 48)), time: 12.0, seed: 1337,
    });
    const r = sh('curl', ['-s', '--max-time', '2400', '-X', 'POST',
      '-H', 'content-type: application/json', '-d', body,
      `http://127.0.0.1:${port}/capture`]);
    try {
      const out = JSON.parse(r.stdout);
      if (out.ok) {
        for (const [pose, urls] of Object.entries(out.shots)) {
          writeFileSync(join(ROOT, OUT, `${pose}.png`), Buffer.from(urls[0].split(',')[1], 'base64'));
        }
        if (out.stats) process.stderr.write(`[sheet] ${out.stats.drawCalls} draws, ${out.stats.triangles} tris\n`);
        if (out.missing?.length) process.stderr.write(`[sheet] not loaded: ${out.missing.join(' | ')}\n`);
        served = true;
      } else {
        process.stderr.write(`[sheet] daemon: ${String(out.err).slice(0, 300)}\n`);
      }
    } catch { }
  }
  if (!served) {
    process.stderr.write('[sheet] daemon unavailable — falling back to one capture per pose\n');
    for (const s of SHOTS) {
      sh('node', ['tools/capture.mjs', '--pose', s.pose, '--out', `${OUT}/${s.pose}.png`,
        '--settle', String(arg('settle', 48))], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
  }
}

/* --------------------------------------------------------------- composite */
const spec = SHOTS.map((s) => ({ ...s, file: join(OUT, `${s.pose}.png`) }))
  .filter((s) => existsSync(join(ROOT, s.file)));
if (!spec.length) { console.error('[sheet] nothing captured'); process.exit(2); }

const composite = `
import cv2, numpy as np, json, os, sys
spec  = json.loads(sys.argv[1])
COLS  = ${COLS}
CELLW = ${CELL_W}
CELLH = int(round(CELLW * 9 / 16))
CAP   = 46          # caption bar height
PAD   = 14          # gutter
BG    = (14, 13, 12)
BAR   = (26, 24, 23)
FG    = (205, 205, 200)
DIM   = (120, 150, 175)

rows = (len(spec) + COLS - 1) // COLS
SW = PAD + COLS * (CELLW + PAD)
SH_ = PAD + rows * (CELLH + CAP + PAD)
sheet = np.full((SH_, SW, 3), BG, np.uint8)

for i, s in enumerate(spec):
    im = cv2.imread(s['file'], cv2.IMREAD_COLOR)
    if im is None:
        continue
    im = cv2.resize(im, (CELLW, CELLH), interpolation=cv2.INTER_AREA)
    r, c = divmod(i, COLS)
    x = PAD + c * (CELLW + PAD)
    y = PAD + r * (CELLH + CAP + PAD)
    sheet[y:y+CELLH, x:x+CELLW] = im
    # caption bar under the cell
    cv2.rectangle(sheet, (x, y+CELLH), (x+CELLW, y+CELLH+CAP), BAR, -1)
    cap = s['caption']
    num, rest = cap.split(' ', 1)
    cv2.putText(sheet, num, (x+14, y+CELLH+31), cv2.FONT_HERSHEY_DUPLEX, 0.62, DIM, 1, cv2.LINE_AA)
    cv2.putText(sheet, rest, (x+14+34, y+CELLH+31), cv2.FONT_HERSHEY_DUPLEX, 0.62, FG, 1, cv2.LINE_AA)

path = os.path.join('${OUT}', 'preview.png')
cv2.imwrite(path, sheet, [cv2.IMWRITE_PNG_COMPRESSION, 6])
print(json.dumps({'path': path, 'size': [sheet.shape[1], sheet.shape[0]],
                  'cells': len(spec), 'cols': COLS}))
`;
const g = sh(PY, ['-c', composite, JSON.stringify(spec)]);
if (g.status !== 0) { console.error(g.stderr?.slice(0, 1500)); process.exit(3); }
process.stdout.write(g.stdout);
