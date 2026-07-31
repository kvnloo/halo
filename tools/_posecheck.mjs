#!/usr/bin/env node
/**
 * Pose ground-clearance audit (KNOWN_ISSUES §17.1).
 *
 * Boots `src/world/terrain.js` headlessly — no GPU, no renderer — so that
 * `terrain.height(x,z)` is the SAME analytic field the shipped shader and
 * `physics.raycast` use, then runs `auditPoses()` from `src/world/poses.js`
 * against it.
 *
 *   node tools/_posecheck.mjs            # table + non-zero exit on any FAIL
 *   node tools/_posecheck.mjs --rebake   # print fresh groundY annotations
 *
 * Exit 1 if any pose is below terrain or under its minimum clearance.
 */
import * as THREE from 'three';
import { auditPoses, POSES } from '../src/world/poses.js';

/* ctx.rand contract, copied from tools/_stcollide.mjs */
function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return { next: f, range: (lo, hi) => lo + f() * (hi - lo), fork: (s) => mulberry(seed + [...String(s)].reduce((p, c) => p * 31 + c.charCodeAt(0) | 0, 7)) };
}

const ctx = {
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(),
  renderer: null,
  rand: mulberry(1337),
  config: {},
  clock: { t: 0 },
  get: () => null,
};

const { create } = await import('../src/world/terrain.js');
const terrain = create();
try {
  await terrain.init(ctx);
} catch (e) {
  // init also bakes GPU textures and builds meshes; those need a renderer we do not
  // have. The 1-D LUTs + buildTables() run first, so height() is live regardless.
  // Fail loudly only if height() is actually unusable.
  if (!Number.isFinite(terrain.height(0, 0))) {
    console.error('terrain.height() unusable after init error:', e.message);
    process.exit(2);
  }
  if (process.argv.includes('--verbose')) console.error('[note] terrain.init partial:', e.message);
}

const rows = auditPoses(terrain);

if (process.argv.includes('--rebake')) {
  for (const r of rows) console.log(`  ${r.name}: groundY ${r.groundY.toFixed(2)}`);
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('pose', 26)} ${pad('eyeY', 8)} ${pad('groundY', 9)} ${pad('clear', 8)} ${pad('min', 6)} status`);
let fails = 0, warns = 0;
for (const r of rows) {
  if (r.status === 'FAIL') fails++;
  else if (r.status === 'WARN') warns++;
  console.log(
    `${pad(r.name, 26)} ${pad(r.eyeY.toFixed(2), 8)} ${pad(r.groundY.toFixed(2), 9)} ` +
    `${pad(r.clearance.toFixed(2), 8)} ${pad(r.minClearance.toFixed(2), 6)} ${r.status}` +
    (r.note ? `  ${r.note}` : ''));
}
console.log(`\n${rows.length} poses: ${fails} FAIL, ${warns} WARN, ${rows.length - fails - warns} ok`);
process.exit(fails ? 1 : 0);
