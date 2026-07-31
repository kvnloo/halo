/**
 * Collider contract probe for src/world/structures.js (KNOWN_ISSUES §12).
 *
 * Builds the module against a stub ctx, then applies `physics.validCollider`'s exact
 * predicate to every collider it emits and drops a point onto the deck. No renderer,
 * no GPU — the thing under test is the collider list, so that is what it tests.
 *
 *   node tools/_stcollide.mjs
 */
import * as THREE from 'three';
import { create } from '../src/world/structures.js';

/* physics.js:107, verbatim */
const validCollider = (c) => {
  if (!c || typeof c !== 'object') return false;
  switch (c.type) {
    case 'sphere': return !!c.center?.isVector3 && Number.isFinite(c.radius);
    case 'box': return !!c.box?.isBox3 && !!c.box.min && !!c.box.max;
    case 'capsule':
    case 'cylinder': return !!c.a?.isVector3 && !!c.b?.isVector3 && Number.isFinite(c.radius);
    default: return false;
  }
};

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const api = { next: f, range: (lo, hi) => lo + f() * (hi - lo), fork: (s) => mulberry(seed + [...String(s)].reduce((p, c) => p * 31 + c.charCodeAt(0) | 0, 7)) };
  return api;
}

const ctx = {
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(),
  rand: mulberry(1337),
  config: {},
  clock: { t: 0 },
  get: () => null,
};

const mod = create();
await mod.init(ctx);

const cs = mod.colliders;
const bad = cs.filter((c) => !validCollider(c));
console.log(`colliders: ${cs.length}  (${cs.filter((c) => c.type === 'box').length} box, ${cs.filter((c) => c.type === 'capsule').length} capsule)`);
console.log(`malformed by physics.validCollider: ${bad.length}`);

/* Drop test: bridge-local (0, y, 60) is mid-deck. */
const g = mod.bridge;
g.updateMatrixWorld(true);
const p = new THREE.Vector3(0, 21.4, 60).applyMatrix4(g.matrixWorld);
const hits = cs.filter((c) => c.type === 'box' && c.box.containsPoint(p));
console.log(`point ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} (deck local 0,60) inside ${hits.length} deck box(es)`);
let top = -Infinity;
for (const h of hits) top = Math.max(top, h.box.max.y);
console.log(`deck collider top at that point: y=${top.toFixed(3)}   (deck walking surface is ${mod.deckY})`);

/* Width error of the AABB chain against the true 15.5 m deck. */
const yaw = g.rotation.y;
const across = 15.5 * Math.abs(Math.cos(yaw));   // the true deck width, projected on X
let worstX = 0, sumX = 0, n = 0;
for (const c of cs) {
  if (c.type !== 'box') continue;
  const s = c.box.getSize(new THREE.Vector3());
  worstX = Math.max(worstX, s.x); sumX += s.x; n++;
}
console.log(`AABB X extent: max ${worstX.toFixed(2)} m, mean ${(sumX / n).toFixed(2)} m; `
  + `deck width projected on X = ${across.toFixed(2)} m -> ${((worstX - across) / 2).toFixed(2)} m of solid air per side`);
console.log(`(one un-segmented AABB would be ${(across + 132.8 * Math.abs(Math.sin(yaw))).toFixed(1)} m wide)`);
console.log(`walkableSurfaces: ${mod.walkableSurfaces.length}, halfU=${mod.walkableSurfaces[0].halfU}, halfV=${mod.walkableSurfaces[0].halfV.toFixed(2)}`);
