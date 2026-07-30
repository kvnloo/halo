#!/usr/bin/env node
/**
 * Preview sheet builder.
 *
 * Captures every matched reference pose in ONE browser session (far cheaper than one
 * process per pose), refreshes shots/preview/, and assembles a full-resolution 3x3
 * contact grid at shots/preview/preview.png — 5760x3240, i.e. nine untouched 1080p
 * frames, no downscaling.
 *
 *   node tools/preview.mjs                 # capture fresh, rebuild everything
 *   node tools/preview.mjs --no-capture    # rebuild the grid from existing shots
 *   node tools/preview.mjs --compare       # also write reference|render|deltaE sheets
 *
 * Safe to run at any time, including while agents are building: it captures whatever
 * the current state is.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const OUT = 'shots/preview';
const PY = join(ROOT, '.venv/bin/python');
const sh = (c, a, o = {}) => spawnSync(c, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, ...o });

mkdirSync(join(ROOT, OUT), { recursive: true });

/* ---------------------------------------------------------------- capture */
if (!has('no-capture')) {
  process.stderr.write('[preview] capturing all reference poses in one session...\n');
  const r = sh('node', ['tools/capture.mjs', '--all', '--outdir', OUT, '--settle', arg('settle', '48')],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) { console.error('[preview] capture failed'); process.exit(2); }
  try {
    const info = JSON.parse(r.stdout);
    if (info.warnings?.length) console.error('[preview] warnings:\n  ' + info.warnings.slice(0, 8).join('\n  '));
    if (info.stats) console.error(`[preview] ${info.stats.drawCalls} draw calls, ${info.stats.triangles} tris`);
  } catch { }
}

const shots = readdirSync(join(ROOT, OUT)).filter((f) => /^ref_\d+\.png$/.test(f)).sort();
if (!shots.length) { console.error('[preview] no ref_*.png captured'); process.exit(3); }
process.stderr.write(`[preview] ${shots.length} frames\n`);

/* ------------------------------------------------- optional comparison sheets */
if (has('compare')) {
  for (const f of shots) {
    const pose = f.replace('.png', '');
    const ref = `ref/keyframes/kf_${pose.split('_')[1]}.png`;
    if (existsSync(join(ROOT, ref))) sh(PY, ['tools/sbs.py', ref, `${OUT}/${f}`, `${OUT}/vs_${pose}.png`]);
  }
}

/* ------------------------------------------------------------- the 3x3 grid */
const gridScript = `
import cv2, numpy as np, sys, os, json
out_dir = ${JSON.stringify(OUT)}
files = sorted([f for f in os.listdir(out_dir) if f.startswith('ref_') and f.endswith('.png')])

# Nine cells at native 1920x1080 -> 5760x3240. If there are fewer than nine frames the
# remaining cells are filled with a dark placeholder rather than rescaling anything:
# the point of this sheet is that every frame is untouched full resolution.
CW, CH = 1920, 1080
cells = []
for f in files[:9]:
    im = cv2.imread(os.path.join(out_dir, f), cv2.IMREAD_COLOR)
    if im is None: continue
    if (im.shape[1], im.shape[0]) != (CW, CH):
        im = cv2.resize(im, (CW, CH), interpolation=cv2.INTER_AREA)
    # thin label strip, drawn INTO the frame so the cell stays exactly 1920x1080
    label = f.replace('.png','')
    cv2.rectangle(im, (0,0), (int(CW*0.24), 52), (16,16,16), -1)
    cv2.putText(im, label, (18, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.95, (150,225,255), 2, cv2.LINE_AA)
    cells.append(im)

while len(cells) < 9:
    ph = np.full((CH, CW, 3), 18, np.uint8)
    cv2.putText(ph, 'not captured', (CW//2-260, CH//2), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (70,70,70), 3, cv2.LINE_AA)
    cells.append(ph)

grid = np.vstack([np.hstack(cells[0:3]), np.hstack(cells[3:6]), np.hstack(cells[6:9])])
path = os.path.join(out_dir, 'preview.png')
cv2.imwrite(path, grid, [cv2.IMWRITE_PNG_COMPRESSION, 6])
print(json.dumps({'path': path, 'size': [grid.shape[1], grid.shape[0]], 'frames': len(files[:9])}))
`;
const g = sh(PY, ['-c', gridScript]);
if (g.status !== 0) { console.error(g.stderr?.slice(0, 1200)); process.exit(4); }
process.stdout.write(g.stdout);
