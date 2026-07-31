#!/usr/bin/env node
/** Recompute the whole-frame + ROI table from PNGs already on disk (no captures).
 *  node tools/_fogstats.mjs --pose ref_00000 --dir shots/fogH --arms base,noWm,noFog,neither */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const pose = arg('pose', 'ref_00000');
const dir = arg('dir', 'shots/fogH');
const arms = arg('arms', 'base').split(',');
const rois = arg('rois', 'rock,horizon,sky,water,sand,cliff,weapon').split(',').filter(Boolean);
const refPng = `ref/keyframes/kf_${pose.replace('ref_', '')}.png`;
const py = resolve(ROOT, '.venv/bin/python');
const stats = (p) => JSON.parse(execFileSync(py, [resolve(ROOT, 'tools/metrics.py'), '--stats', p], { cwd: ROOT, maxBuffer: 1 << 26 }));
const rows = [];
for (const a of [...arms, 'REF']) {
  const png = a === 'REF' ? refPng : `${dir}/${pose}_${a}.png`;
  if (!existsSync(resolve(ROOT, png))) { console.error('missing ' + png); continue; }
  const row = { label: a, full: stats(png), roi: {} };
  if (a !== 'REF') {
    const m = JSON.parse(execFileSync(py, [resolve(ROOT, 'tools/metrics.py'), refPng, png], { cwd: ROOT, maxBuffer: 1 << 26 }));
    row.score = m.score; row.axes = m.axes;
  }
  for (const r of rois) {
    const rp = `${dir}/_roi_${a}__${r}.png`;
    execFileSync(py, [resolve(ROOT, 'tools/roi.py'), png, r, rp], { cwd: ROOT });
    row.roi[r] = stats(rp);
  }
  rows.push(row);
}
const f = (x, n = 2) => (typeof x === 'number' ? x.toFixed(n).padStart(8) : String(x).padStart(8));
let s = `pose ${pose}\n\nWHOLE FRAME\n` + 'arm'.padEnd(12) + ['lum', 'sat', 'lab_b', 'lap_var', 'score'].map((x) => x.padStart(8)).join('') + '\n';
for (const r of rows) s += r.label.padEnd(12) + f(r.full.lum_mean) + f(r.full.sat_mean) + f(r.full.lab_b) + f(r.full.lap_var, 1) + f(r.score ?? 0) + '\n';
for (const roi of rois) {
  s += `\n${roi}\n` + 'arm'.padEnd(12) + ['lum', 'sat', 'lab_b', 'lap_var'].map((x) => x.padStart(8)).join('') + '\n';
  for (const r of rows) s += r.label.padEnd(12) + f(r.roi[roi].lum_mean) + f(r.roi[roi].sat_mean) + f(r.roi[roi].lab_b) + f(r.roi[roi].lap_var, 1) + '\n';
}
console.log(s);
for (const r of rows) if (r.axes) console.log(r.label, JSON.stringify(r.axes));
