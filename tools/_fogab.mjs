#!/usr/bin/env node
/**
 * Back-to-back A/B harness for the fog pass. Runs N capture.mjs invocations in sequence
 * (never in parallel — the frame moves under you when other agents save) and prints one
 * table of whole-frame + ROI stats for every arm.
 *
 *   node tools/_fogab.mjs --pose ref_00000 --arms "base=;noaerial=aerialDensity=0" \
 *        --rois rock,horizon,sky,water,sand,cliff,weapon --dir shots/fogH
 *
 * Arms are `label=configstring` separated by ';'. An empty config string is the shipped
 * build. Everything is captured with --settle 48.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const pose = arg('pose', 'ref_00000');
const dir = arg('dir', 'shots/fogH');
const settle = arg('settle', '48');
const rois = arg('rois', 'rock,horizon,sky,water,sand,cliff,weapon').split(',').filter(Boolean);
const arms = arg('arms', 'base=').split(';').map((s) => {
  const i = s.indexOf('=');
  return { label: s.slice(0, i), cfg: s.slice(i + 1) };
});
const refPng = `ref/keyframes/kf_${pose.replace('ref_', '')}.png`;

mkdirSync(resolve(ROOT, dir), { recursive: true });

const py = resolve(ROOT, '.venv/bin/python');
const stats = (png) => JSON.parse(execFileSync(py, [resolve(ROOT, 'tools/metrics.py'), '--stats', png], { cwd: ROOT, maxBuffer: 1 << 26 }).toString());

const rows = [];
for (const a of arms) {
  const out = `${dir}/${pose}_${a.label}.png`;
  const args = ['tools/capture.mjs', '--pose', pose, '--out', out, '--settle', settle];
  if (a.cfg) args.push('--config', a.cfg);
  const t0 = Date.now();
  const res = execFileSync('node', args, { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const j = JSON.parse(res);
  const warn = (j.warnings || []).filter((w) => !/^\s*$/.test(w));
  const row = { label: a.label, cfg: a.cfg, png: out, ms: Date.now() - t0, warnings: warn };
  // whole-frame comparison against the keyframe
  if (existsSync(resolve(ROOT, refPng))) {
    const m = JSON.parse(execFileSync(py, [resolve(ROOT, 'tools/metrics.py'), refPng, out], { cwd: ROOT, maxBuffer: 1 << 26 }).toString());
    row.full = m.test_stats; row.score = m.score; row.axes = m.axes; row.ref = m.ref_stats;
  } else {
    row.full = stats(out);
  }
  row.roi = {};
  for (const r of rois) {
    const rp = `${dir}/${pose}_${a.label}__${r}.png`;
    execFileSync(py, [resolve(ROOT, 'tools/roi.py'), out, r, rp], { cwd: ROOT });
    row.roi[r] = stats(rp);
    if (!rows.length) {
      const rr = `${dir}/ref_${r}.png`;
      if (existsSync(resolve(ROOT, refPng))) {
        execFileSync(py, [resolve(ROOT, 'tools/roi.py'), refPng, r, rr], { cwd: ROOT });
        row.roi['REF_' + r] = stats(rr);
      }
    }
  }
  rows.push(row);
  process.stderr.write(`[fogab] ${a.label} done in ${row.ms} ms${warn.length ? ' WARN:' + warn.join('|') : ''}\n`);
}

const f = (x, n = 2) => (typeof x === 'number' ? x.toFixed(n).padStart(8) : String(x).padStart(8));
let outStr = `pose ${pose}  settle ${settle}\n\n`;
outStr += 'arm'.padEnd(16) + ['lum', 'sat', 'lab_b', 'lap_var', 'score'].map((s) => s.padStart(8)).join('') + '\n';
for (const r of rows) outStr += r.label.padEnd(16) + f(r.full.lum_mean) + f(r.full.sat_mean) + f(r.full.lab_b) + f(r.full.lap_var, 1) + f(r.score ?? 0) + '\n';
if (rows[0].ref) outStr += 'REFERENCE'.padEnd(16) + f(rows[0].ref.lum_mean) + f(rows[0].ref.sat_mean) + f(rows[0].ref.lab_b) + f(rows[0].ref.lap_var, 1) + '\n';
for (const roi of rois) {
  outStr += `\nROI ${roi}\n`;
  outStr += 'arm'.padEnd(16) + ['lum', 'sat', 'lab_b', 'lap_var'].map((s) => s.padStart(8)).join('') + '\n';
  for (const r of rows) outStr += r.label.padEnd(16) + f(r.roi[roi].lum_mean) + f(r.roi[roi].sat_mean) + f(r.roi[roi].lab_b) + f(r.roi[roi].lap_var, 1) + '\n';
  const rr = rows[0].roi['REF_' + roi];
  if (rr) outStr += 'REFERENCE'.padEnd(16) + f(rr.lum_mean) + f(rr.sat_mean) + f(rr.lab_b) + f(rr.lap_var, 1) + '\n';
}
console.log(outStr);
console.log(JSON.stringify(rows.map((r) => ({ label: r.label, cfg: r.cfg, score: r.score, axes: r.axes, warnings: r.warnings })), null, 1));
