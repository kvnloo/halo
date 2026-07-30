import * as THREE from 'three';
import { LAYER } from '../render/RenderPipeline.js';
import { applyWorldMaterial } from '../gfx/materialCommon.js';
import { patchForGBuffer, MAT_ID } from '../gfx/GBufferMaterial.js';

/**
 * `ai` — Covenant actors: procedural bodies, procedural animation, real behaviour.
 *
 * Design notes that matter to anyone reading this later:
 *
 *  - **One SkinnedMesh per actor.** Bodies are generated as triangle soup in a bind
 *    pose whose bones carry positions only (no bind rotations), so a limb's rest
 *    direction is simply `normalize(childBone.position)`. That makes aiming a bone
 *    at a world direction a single `setFromUnitVectors`, and makes analytic two-bone
 *    IK trivial. Posture (the Grunt's hunch, the Elite's digitigrade crouch) is a
 *    per-frame base rotation, not baked into the bind — so the mesh never has to be
 *    authored bent.
 *  - **Own FK.** `wp[]/wq[]` hold each bone's world transform, computed parent-first
 *    as the pose is built. IK needs the hip's world transform before the thigh is
 *    posed, and asking three for it mid-pose would mean a matrix flush per joint.
 *  - **Feet are world-locked during stance.** A planted foot keeps its world position
 *    until its leg re-enters swing. That, not a sine wave, is what removes foot slide.
 *  - **Everything is seeded.** `ctx.rand.fork()` per actor; animation phase comes from
 *    accumulated `dt`, never from a wall clock.
 *
 * Cross-module calls are all guarded: `terrain`, `physics`, `player`, `hud`, `audio`
 * and `ocean` may be absent or half-built, and this module must still load and run.
 */

/* ------------------------------------------------------------------ constants */

const FACTION = { COVENANT: 'covenant', UNSC: 'unsc' };
const GRAVITY = -19.6;                 // must match physics.gravity
const DEG = Math.PI / 180;

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));
const angWrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/* module-scope scratch — no allocation in the frame loop */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _eu = new THREE.Euler(0, 0, 0, 'YXZ');
/** Set a bone's local rotation from YXZ Euler angles without allocating. */
const setEuler = (b, x, y, z) => { _eu.set(x, y, z, 'YXZ'); b.quaternion.setFromEuler(_eu); };

/* ------------------------------------------------------------------- geometry */

/**
 * Superellipse cross-section on the unit circle. `e = 2` is a circle, `e >= 5`
 * reads as a rounded armour plate. One primitive covers every shape here.
 */
function section(n, e = 2) {
  const pts = [];
  const k = 2 / e;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([Math.sign(c) * Math.pow(Math.abs(c), k), Math.sign(s) * Math.pow(Math.abs(s), k)]);
  }
  return pts;
}

/** Accumulates procedural body geometry, in bind-pose model space. */
class Builder {
  constructor() {
    this.pos = []; this.col = []; this.fx = [];
    this.si = []; this.sw = []; this.idx = [];
  }
  vert(p, bi, col, fx) {
    this.pos.push(p.x, p.y, p.z);
    this.col.push(col.r, col.g, col.b);
    this.fx.push(fx[0], fx[1], fx[2]);
    this.si.push(bi, 0, 0, 0);
    this.sw.push(1, 0, 0, 0);
    return this.pos.length / 3 - 1;
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  tri(a, b, c) { this.idx.push(a, b, c); }

  /**
   * A tapered tube from `p0` to `p1`.
   * `profile` is [[t, rx, rz], ...] with t in 0..1 along the segment.
   * `flat` duplicates vertices per face so computeVertexNormals facets it.
   */
  limb(bi, p0, p1, profile, o = {}) {
    const sides = o.sides ?? 8, e = o.e ?? 2, col = o.col, fx = o.fx || [0, 0, 0.6];
    const sec = section(sides, e);
    const ax = _a.copy(p1).sub(p0);
    const len = ax.length() || 1e-4;
    ax.divideScalar(len);
    const ref = Math.abs(ax.y) > 0.92 ? _up.clone().set(0, 0, 1) : _up.clone();
    const u = _b.copy(ref).cross(ax).normalize();
    const v = _c.copy(ax).cross(u).normalize();
    if (o.roll) { const cr = Math.cos(o.roll), sr = Math.sin(o.roll);
      const ux = u.x * cr + v.x * sr, uy = u.y * cr + v.y * sr, uz = u.z * cr + v.z * sr;
      v.set(v.x * cr - u.x * sr, v.y * cr - u.y * sr, v.z * cr - u.z * sr); u.set(ux, uy, uz); }

    const rings = [];
    for (const [t, rx, rz] of profile) {
      const ring = [];
      const cx = (o.bow ? o.bow[0] * Math.sin(t * Math.PI) : 0);
      const cz = (o.bow ? o.bow[1] * Math.sin(t * Math.PI) : 0);
      for (let i = 0; i < sides; i++) {
        const [sx, sz] = sec[i];
        _d.copy(p0)
          .addScaledVector(ax, len * t)
          .addScaledVector(u, sx * rx + cx)
          .addScaledVector(v, sz * rz + cz);
        ring.push(_d.clone());
      }
      rings.push(ring);
    }

    if (o.flat) {
      for (let r = 0; r < rings.length - 1; r++) {
        for (let i = 0; i < sides; i++) {
          const j = (i + 1) % sides;
          const a = this.vert(rings[r][i], bi, col, fx);
          const b = this.vert(rings[r][j], bi, col, fx);
          const c = this.vert(rings[r + 1][j], bi, col, fx);
          const d = this.vert(rings[r + 1][i], bi, col, fx);
          this.quad(a, b, c, d);
        }
      }
    } else {
      const base = [];
      for (let r = 0; r < rings.length; r++) {
        const row = [];
        for (let i = 0; i < sides; i++) row.push(this.vert(rings[r][i], bi, col, fx));
        base.push(row);
      }
      for (let r = 0; r < rings.length - 1; r++)
        for (let i = 0; i < sides; i++) {
          const j = (i + 1) % sides;
          this.quad(base[r][i], base[r][j], base[r + 1][j], base[r + 1][i]);
        }
    }

    if (o.cap !== false) {
      for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]]) {
        _d.set(0, 0, 0);
        for (const p of ring) _d.add(p);
        _d.divideScalar(ring.length);
        const cIdx = this.vert(_d, bi, col, fx);
        const r2 = ring.map((p) => this.vert(p, bi, col, fx));
        for (let i = 0; i < sides; i++) {
          const j = (i + 1) % sides;
          if (flip) this.tri(cIdx, r2[j], r2[i]); else this.tri(cIdx, r2[i], r2[j]);
        }
      }
    }
  }

  /** Ellipsoid — heads, methane tanks, joints. */
  blob(bi, ctr, rx, ry, rz, o = {}) {
    const seg = o.seg ?? 10, rows = o.rows ?? 7, col = o.col, fx = o.fx || [0, 0, 0.6];
    const sq = o.squash || null;   // [yFrom, scaleXZ] pinch, for beaks/snouts
    const grid = [];
    for (let r = 0; r <= rows; r++) {
      const phi = (r / rows) * Math.PI;
      const row = [];
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        let sx = Math.sin(phi) * Math.cos(th), sy = Math.cos(phi), sz = Math.sin(phi) * Math.sin(th);
        let k = 1;
        if (sq && sy > sq[0]) k = 1 - (1 - sq[1]) * ((sy - sq[0]) / (1 - sq[0]));
        _d.set(ctr.x + sx * rx * k, ctr.y + sy * ry, ctr.z + sz * rz * k);
        if (o.shear) _d.z += o.shear * sy;
        row.push(this.vert(_d, bi, col, fx));
      }
      grid.push(row);
    }
    for (let r = 0; r < rows; r++)
      for (let i = 0; i < seg; i++)
        this.quad(grid[r][i], grid[r][i + 1], grid[r + 1][i + 1], grid[r + 1][i]);
  }

  /** Flat-shaded box, optionally tapered — armour plates, weapon bodies. */
  plate(bi, ctr, half, o = {}) {
    const col = o.col, fx = o.fx || [0, 0, 0.5];
    const t = o.taper ?? 1, sh = o.shear || [0, 0];
    const P = (sx, sy, sz) => {
      const k = sy > 0 ? t : 1;
      return _d.set(ctr.x + sx * half[0] * k + sh[0] * sy,
        ctr.y + sy * half[1],
        ctr.z + sz * half[2] * k + sh[1] * sy).clone();
    };
    const c = [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1),
      P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)];
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    for (const f of faces) {
      const v = f.map((i) => this.vert(c[i], bi, col, fx));
      this.quad(v[0], v[1], v[2], v[3]);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFx', new THREE.Float32BufferAttribute(this.fx, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.boundingSphere.center.set(0, 1, 0);
    g.boundingSphere.radius = 3.2;
    return g;
  }
}

/* --------------------------------------------------------------- rig assembly */

/** Bone table -> THREE.Bone hierarchy with identity bind rotations. */
function makeRig(table) {
  const bones = [], byName = {}, parentIdx = [], world = [];
  for (let i = 0; i < table.length; i++) {
    const t = table[i];
    const b = new THREE.Bone();
    b.name = t.n;
    b.position.set(t.p[0], t.p[1], t.p[2]);
    bones.push(b); byName[t.n] = b;
    const pi = t.parent ? table.findIndex((x) => x.n === t.parent) : -1;
    parentIdx.push(pi);
    const wp = new THREE.Vector3(t.p[0], t.p[1], t.p[2]);
    if (pi >= 0) { wp.add(world[pi]); bones[pi].add(b); }
    world.push(wp);
  }
  return { bones, byName, parentIdx, bindWorld: world, index: (n) => bones.indexOf(byName[n]) };
}

/* ------------------------------------------------------------ actor palettes */

const PAL = {
  gruntSkin: srgb(0x6f7d8c), gruntArmor: srgb(0xc9541b), gruntArmorHi: srgb(0xe8752f),
  gruntMajor: srgb(0x8d2415), gruntTank: srgb(0x454b54), gruntMask: srgb(0x2f333b),
  eliteBlue: srgb(0x2d4c9e), eliteBlueHi: srgb(0x4a70cf), eliteGold: srgb(0xb08a2a),
  eliteGoldHi: srgb(0xd9b352), eliteSuit: srgb(0x24262c), eliteSkin: srgb(0x5c5348),
  jackalPlate: srgb(0x6a4a2d), jackalSkin: srgb(0xa8977a), jackalDark: srgb(0x3b3128),
  glowCyan: srgb(0x8ef2ff), glowGreen: srgb(0x9dff7a), glowViolet: srgb(0xc98cff),
  metal: srgb(0x54585f),
};

/* ------------------------------------------------------------------ the actors */

/* fx attribute = [emissive, metalness, roughness] */
const FX_SUIT = [0, 0.05, 0.62];
const FX_PLATE = [0, 0.45, 0.34];
const FX_METAL = [0, 0.85, 0.28];
const FX_GLOW = [4.0, 0.0, 0.9];
const FX_GLOW_SOFT = [1.6, 0.0, 0.9];

function buildGrunt(major) {
  const T = [
    { n: 'pelvis', parent: null, p: [0, 0.58, 0] },
    { n: 'spine', parent: 'pelvis', p: [0, 0.15, -0.01] },
    { n: 'chest', parent: 'spine', p: [0, 0.16, -0.02] },
    { n: 'neck', parent: 'chest', p: [0, 0.14, -0.07] },
    { n: 'head', parent: 'neck', p: [0, 0.08, -0.05] },
    { n: 'tank', parent: 'chest', p: [0, -0.01, 0.17] },
    { n: 'clavL', parent: 'chest', p: [0.13, 0.09, -0.01] },
    { n: 'uarmL', parent: 'clavL', p: [0.07, -0.03, 0] },
    { n: 'farmL', parent: 'uarmL', p: [0.05, -0.19, 0.02] },
    { n: 'handL', parent: 'farmL', p: [0.03, -0.16, 0.03] },
    { n: 'clavR', parent: 'chest', p: [-0.13, 0.09, -0.01] },
    { n: 'uarmR', parent: 'clavR', p: [-0.07, -0.03, 0] },
    { n: 'farmR', parent: 'uarmR', p: [-0.05, -0.19, 0.02] },
    { n: 'handR', parent: 'farmR', p: [-0.03, -0.16, 0.03] },
    { n: 'thighL', parent: 'pelvis', p: [0.10, -0.04, 0] },
    { n: 'shinL', parent: 'thighL', p: [0.01, -0.24, -0.02] },
    { n: 'footL', parent: 'shinL', p: [0, -0.22, 0.02] },
    { n: 'toeL', parent: 'footL', p: [0, -0.05, -0.10] },
    { n: 'thighR', parent: 'pelvis', p: [-0.10, -0.04, 0] },
    { n: 'shinR', parent: 'thighR', p: [-0.01, -0.24, -0.02] },
    { n: 'footR', parent: 'shinR', p: [0, -0.22, 0.02] },
    { n: 'toeR', parent: 'footR', p: [0, -0.05, -0.10] },
  ];
  const rig = makeRig(T);
  const B = new Builder();
  const W = rig.bindWorld, I = rig.index;
  const armor = major ? PAL.gruntMajor : PAL.gruntArmor;
  const armorHi = major ? srgb(0xb2361f) : PAL.gruntArmorHi;

  // torso: squat, barrel chested, wide hips
  B.limb(I('pelvis'), W[I('pelvis')].clone().add(_a.set(0, -0.06, 0)),
    W[I('chest')], [[0, 0.155, 0.14], [0.4, 0.175, 0.155], [1, 0.145, 0.135]],
    { sides: 10, e: 3.0, col: PAL.gruntSkin, fx: FX_SUIT });
  // chest plate
  B.plate(I('chest'), W[I('chest')].clone().add(_a.set(0, 0.02, -0.10)), [0.155, 0.13, 0.07],
    { col: armor, fx: FX_PLATE, taper: 0.9 });
  // shoulder pads
  for (const s of [1, -1]) {
    B.plate(I(s > 0 ? 'clavL' : 'clavR'), W[I(s > 0 ? 'clavL' : 'clavR')].clone().add(_a.set(s * 0.03, 0.02, 0)),
      [0.075, 0.07, 0.085], { col: armorHi, fx: FX_PLATE, taper: 0.65 });
  }

  // methane backpack: two tanks + a regulator block
  for (const s of [1, -1]) {
    B.limb(I('tank'), W[I('tank')].clone().add(_a.set(s * 0.075, -0.13, 0.02)),
      W[I('tank')].clone().add(_a.set(s * 0.085, 0.16, 0.03)),
      [[0, 0.055, 0.055], [0.12, 0.072, 0.072], [0.88, 0.072, 0.072], [1, 0.05, 0.05]],
      { sides: 10, col: PAL.gruntTank, fx: FX_METAL });
  }
  B.plate(I('tank'), W[I('tank')].clone().add(_a.set(0, 0.02, -0.03)), [0.085, 0.10, 0.05],
    { col: PAL.gruntMask, fx: FX_METAL });
  B.plate(I('tank'), W[I('tank')].clone().add(_a.set(0, 0.15, 0.03)), [0.04, 0.018, 0.04],
    { col: PAL.glowCyan, fx: FX_GLOW_SOFT });

  // head: small skull under a conical mask with a glowing intake
  B.blob(I('head'), W[I('head')].clone().add(_a.set(0, 0.03, 0.02)), 0.105, 0.105, 0.10,
    { col: PAL.gruntSkin, fx: FX_SUIT, seg: 10, rows: 7 });
  B.limb(I('head'), W[I('head')].clone().add(_a.set(0, 0.055, 0.05)),
    W[I('head')].clone().add(_a.set(0, -0.045, -0.155)),
    [[0, 0.11, 0.115], [0.45, 0.095, 0.10], [1, 0.045, 0.045]],
    { sides: 10, e: 2.4, col: PAL.gruntMask, fx: FX_METAL });
  B.blob(I('head'), W[I('head')].clone().add(_a.set(0, -0.045, -0.155)), 0.042, 0.042, 0.03,
    { col: PAL.glowCyan, fx: FX_GLOW, seg: 8, rows: 5 });
  // mask hoses back to the tanks
  for (const s of [1, -1])
    B.limb(I('head'), W[I('head')].clone().add(_a.set(s * 0.075, -0.02, -0.06)),
      W[I('head')].clone().add(_a.set(s * 0.06, -0.06, 0.10)),
      [[0, 0.022, 0.022], [1, 0.022, 0.022]],
      { sides: 6, col: PAL.gruntMask, fx: FX_SUIT });

  // arms
  for (const s of [1, -1]) {
    const U = s > 0 ? 'uarmL' : 'uarmR', F = s > 0 ? 'farmL' : 'farmR', H = s > 0 ? 'handL' : 'handR';
    B.limb(I(U), W[I(U)], W[I(F)], [[0, 0.055, 0.055], [0.5, 0.05, 0.05], [1, 0.042, 0.042]],
      { sides: 7, col: PAL.gruntSkin, fx: FX_SUIT });
    B.limb(I(F), W[I(F)], W[I(H)], [[0, 0.05, 0.05], [1, 0.038, 0.038]],
      { sides: 7, col: armor, fx: FX_PLATE });
    B.blob(I(H), W[I(H)].clone().add(_a.set(0, -0.02, 0)), 0.042, 0.05, 0.045,
      { col: PAL.gruntSkin, fx: FX_SUIT, seg: 7, rows: 5 });
  }

  // legs
  for (const s of [1, -1]) {
    const TH = s > 0 ? 'thighL' : 'thighR', SH = s > 0 ? 'shinL' : 'shinR';
    const FO = s > 0 ? 'footL' : 'footR', TO = s > 0 ? 'toeL' : 'toeR';
    B.limb(I(TH), W[I(TH)], W[I(SH)], [[0, 0.085, 0.085], [1, 0.062, 0.062]],
      { sides: 8, col: PAL.gruntSkin, fx: FX_SUIT });
    B.limb(I(SH), W[I(SH)], W[I(FO)], [[0, 0.062, 0.062], [1, 0.05, 0.05]],
      { sides: 8, col: armor, fx: FX_PLATE });
    B.plate(I(FO), W[I(FO)].clone().add(_a.set(0, -0.035, -0.045)), [0.055, 0.035, 0.105],
      { col: PAL.gruntMask, fx: FX_PLATE });
    void TO;
  }

  // plasma pistol in the right hand
  const hp = W[I('handR')].clone().add(_a.set(0, -0.03, -0.06));
  B.limb(I('handR'), hp.clone().add(_a.set(0, 0.02, 0.06)), hp.clone().add(_a.set(0, 0.02, -0.16)),
    [[0, 0.045, 0.055], [0.35, 0.055, 0.07], [1, 0.028, 0.04]],
    { sides: 8, e: 3, col: srgb(0x3f5a46), fx: FX_METAL });
  B.plate(I('handR'), hp.clone().add(_a.set(0, 0.075, -0.02)), [0.012, 0.035, 0.06],
    { col: srgb(0x3f5a46), fx: FX_METAL });
  B.blob(I('handR'), hp.clone().add(_a.set(0, 0.02, -0.16)), 0.026, 0.026, 0.02,
    { col: PAL.glowGreen, fx: FX_GLOW, seg: 7, rows: 4 });

  return { rig, geom: B.build(), muzzle: hp.clone().add(_a.set(0, 0.02, -0.20)).sub(W[I('handR')]) };
}

function buildElite(major) {
  const T = [
    { n: 'pelvis', parent: null, p: [0, 1.10, 0] },
    { n: 'spine', parent: 'pelvis', p: [0, 0.20, 0] },
    { n: 'chest', parent: 'spine', p: [0, 0.24, -0.02] },
    { n: 'neck', parent: 'chest', p: [0, 0.19, -0.02] },
    { n: 'head', parent: 'neck', p: [0, 0.10, -0.02] },
    { n: 'jawUL', parent: 'head', p: [0.045, -0.02, -0.10] },
    { n: 'jawUR', parent: 'head', p: [-0.045, -0.02, -0.10] },
    { n: 'jawLL', parent: 'head', p: [0.055, -0.07, -0.08] },
    { n: 'jawLR', parent: 'head', p: [-0.055, -0.07, -0.08] },
    { n: 'clavL', parent: 'chest', p: [0.16, 0.10, 0] },
    { n: 'uarmL', parent: 'clavL', p: [0.14, -0.01, 0] },
    { n: 'farmL', parent: 'uarmL', p: [0.04, -0.33, 0.02] },
    { n: 'handL', parent: 'farmL', p: [0.02, -0.29, 0.03] },
    { n: 'clavR', parent: 'chest', p: [-0.16, 0.10, 0] },
    { n: 'uarmR', parent: 'clavR', p: [-0.14, -0.01, 0] },
    { n: 'farmR', parent: 'uarmR', p: [-0.04, -0.33, 0.02] },
    { n: 'handR', parent: 'farmR', p: [-0.02, -0.29, 0.03] },
    { n: 'thighL', parent: 'pelvis', p: [0.15, -0.06, 0] },
    { n: 'shinL', parent: 'thighL', p: [0.02, -0.44, -0.11] },
    { n: 'metaL', parent: 'shinL', p: [-0.01, -0.44, 0.17] },
    { n: 'footL', parent: 'metaL', p: [0, -0.16, -0.20] },
    { n: 'thighR', parent: 'pelvis', p: [-0.15, -0.06, 0] },
    { n: 'shinR', parent: 'thighR', p: [-0.02, -0.44, -0.11] },
    { n: 'metaR', parent: 'shinR', p: [0.01, -0.44, 0.17] },
    { n: 'footR', parent: 'metaR', p: [0, -0.16, -0.20] },
  ];
  const rig = makeRig(T);
  const B = new Builder();
  const W = rig.bindWorld, I = rig.index;
  const armor = major ? PAL.eliteGold : PAL.eliteBlue;
  const armorHi = major ? PAL.eliteGoldHi : PAL.eliteBlueHi;

  // torso: narrow waist, broad plated chest
  B.limb(I('pelvis'), W[I('pelvis')].clone().add(_a.set(0, -0.08, 0)), W[I('spine')],
    [[0, 0.19, 0.16], [1, 0.155, 0.13]], { sides: 10, e: 3, col: PAL.eliteSuit, fx: FX_SUIT });
  B.limb(I('spine'), W[I('spine')], W[I('chest')],
    [[0, 0.155, 0.13], [1, 0.20, 0.15]], { sides: 10, e: 3, col: PAL.eliteSuit, fx: FX_SUIT });
  B.plate(I('chest'), W[I('chest')].clone().add(_a.set(0, -0.02, -0.10)), [0.215, 0.20, 0.095],
    { col: armor, fx: FX_PLATE, taper: 1.06, shear: [0, -0.02] });
  B.plate(I('chest'), W[I('chest')].clone().add(_a.set(0, 0.05, 0.12)), [0.19, 0.17, 0.075],
    { col: armorHi, fx: FX_PLATE, taper: 0.85 });
  B.plate(I('pelvis'), W[I('pelvis')].clone().add(_a.set(0, -0.10, -0.10)), [0.155, 0.13, 0.07],
    { col: armor, fx: FX_PLATE, taper: 0.7 });

  // pauldrons — the Elite's read at distance is almost entirely this silhouette
  for (const s of [1, -1]) {
    const C = s > 0 ? 'clavL' : 'clavR';
    B.limb(I(C), W[I(C)].clone().add(_a.set(s * 0.02, 0.06, 0)), W[I(C)].clone().add(_a.set(s * 0.20, -0.10, 0)),
      [[0, 0.115, 0.13], [0.5, 0.135, 0.155], [1, 0.075, 0.09]],
      { sides: 8, e: 3.6, col: armorHi, fx: FX_PLATE, flat: true });
    B.plate(I(C), W[I(C)].clone().add(_a.set(s * 0.11, 0.04, 0)), [0.10, 0.055, 0.135],
      { col: armor, fx: FX_PLATE, taper: 0.75 });
  }

  // head: elongated helm, four mandibles
  B.blob(I('head'), W[I('head')].clone().add(_a.set(0, 0.03, 0.02)), 0.115, 0.135, 0.15,
    { col: armor, fx: FX_PLATE, seg: 10, rows: 8, shear: -0.03 });
  B.plate(I('head'), W[I('head')].clone().add(_a.set(0, 0.10, 0.05)), [0.055, 0.055, 0.14],
    { col: armorHi, fx: FX_PLATE, taper: 0.4 });
  B.blob(I('head'), W[I('head')].clone().add(_a.set(0, -0.035, -0.08)), 0.085, 0.075, 0.08,
    { col: PAL.eliteSkin, fx: FX_SUIT, seg: 8, rows: 6 });
  for (const [n, sx, sy] of [['jawUL', 1, 1], ['jawUR', -1, 1], ['jawLL', 1, -1], ['jawLR', -1, -1]]) {
    const o = W[I(n)];
    B.limb(I(n), o, o.clone().add(_a.set(sx * 0.035, sy * 0.02 - 0.03, -0.115)),
      [[0, 0.032, 0.036], [0.6, 0.026, 0.03], [1, 0.010, 0.012]],
      { sides: 6, col: PAL.eliteSkin, fx: FX_SUIT });
  }
  // helmet mandible guards
  for (const s of [1, -1])
    B.plate(I('head'), W[I('head')].clone().add(_a.set(s * 0.10, -0.015, -0.06)), [0.032, 0.075, 0.085],
      { col: armorHi, fx: FX_PLATE, taper: 0.7 });

  // arms
  for (const s of [1, -1]) {
    const U = s > 0 ? 'uarmL' : 'uarmR', F = s > 0 ? 'farmL' : 'farmR', H = s > 0 ? 'handL' : 'handR';
    B.limb(I(U), W[I(U)], W[I(F)], [[0, 0.085, 0.085], [0.6, 0.072, 0.072], [1, 0.058, 0.058]],
      { sides: 8, col: PAL.eliteSuit, fx: FX_SUIT });
    B.limb(I(F), W[I(F)], W[I(H)], [[0, 0.075, 0.075], [0.45, 0.085, 0.085], [1, 0.05, 0.05]],
      { sides: 8, e: 3, col: armor, fx: FX_PLATE });
    B.blob(I(H), W[I(H)].clone().add(_a.set(0, -0.035, 0)), 0.055, 0.07, 0.06,
      { col: PAL.eliteSuit, fx: FX_SUIT, seg: 7, rows: 5 });
  }

  // digitigrade legs
  for (const s of [1, -1]) {
    const TH = s > 0 ? 'thighL' : 'thighR', SH = s > 0 ? 'shinL' : 'shinR';
    const ME = s > 0 ? 'metaL' : 'metaR', FO = s > 0 ? 'footL' : 'footR';
    B.limb(I(TH), W[I(TH)], W[I(SH)], [[0, 0.125, 0.13], [0.55, 0.115, 0.12], [1, 0.075, 0.08]],
      { sides: 8, col: PAL.eliteSuit, fx: FX_SUIT });
    B.limb(I(SH), W[I(SH)], W[I(ME)], [[0, 0.08, 0.085], [0.35, 0.09, 0.095], [1, 0.05, 0.055]],
      { sides: 8, e: 2.6, col: armor, fx: FX_PLATE });
    B.limb(I(ME), W[I(ME)], W[I(FO)], [[0, 0.055, 0.06], [1, 0.045, 0.05]],
      { sides: 7, col: PAL.eliteSuit, fx: FX_SUIT });
    // three-toed foot
    for (const t of [-1, 0, 1])
      B.limb(I(FO), W[I(FO)].clone().add(_a.set(0, 0.015, 0.01)),
        W[I(FO)].clone().add(_a.set(t * 0.05, -0.01, -0.115)),
        [[0, 0.032, 0.032], [1, 0.020, 0.020]], { sides: 6, col: PAL.eliteSuit, fx: FX_SUIT });
    // knee plate
    B.plate(I(SH), W[I(SH)].clone().add(_a.set(0, -0.02, -0.06)), [0.075, 0.085, 0.045],
      { col: armorHi, fx: FX_PLATE, taper: 0.8 });
  }

  // plasma rifle
  const hp = W[I('handR')].clone().add(_a.set(0, -0.04, -0.06));
  B.plate(I('handR'), hp.clone().add(_a.set(0, 0.05, -0.05)), [0.05, 0.075, 0.19],
    { col: srgb(0x3a4472), fx: FX_METAL, taper: 0.8 });
  for (const s of [1, -1])
    B.limb(I('handR'), hp.clone().add(_a.set(s * 0.035, 0.06, -0.20)),
      hp.clone().add(_a.set(s * 0.055, 0.045, -0.34)),
      [[0, 0.028, 0.03], [1, 0.016, 0.018]], { sides: 6, col: srgb(0x2f3760), fx: FX_METAL });
  B.plate(I('handR'), hp.clone().add(_a.set(0, 0.115, -0.02)), [0.028, 0.03, 0.10],
    { col: PAL.glowCyan, fx: FX_GLOW_SOFT });
  B.blob(I('handR'), hp.clone().add(_a.set(0, 0.052, -0.30)), 0.024, 0.024, 0.03,
    { col: PAL.glowCyan, fx: FX_GLOW, seg: 7, rows: 4 });

  return { rig, geom: B.build(), muzzle: hp.clone().add(_a.set(0, 0.052, -0.36)).sub(W[I('handR')]) };
}

function buildJackal() {
  const T = [
    { n: 'pelvis', parent: null, p: [0, 0.90, 0] },
    { n: 'spine', parent: 'pelvis', p: [0, 0.17, -0.05] },
    { n: 'chest', parent: 'spine', p: [0, 0.17, -0.08] },
    { n: 'neck', parent: 'chest', p: [0, 0.13, -0.05] },
    { n: 'head', parent: 'neck', p: [0, 0.10, -0.06] },
    { n: 'clavL', parent: 'chest', p: [0.13, 0.08, 0] },
    { n: 'uarmL', parent: 'clavL', p: [0.09, -0.02, 0] },
    { n: 'farmL', parent: 'uarmL', p: [0.03, -0.24, 0.02] },
    { n: 'handL', parent: 'farmL', p: [0.02, -0.22, 0.02] },
    { n: 'clavR', parent: 'chest', p: [-0.13, 0.08, 0] },
    { n: 'uarmR', parent: 'clavR', p: [-0.09, -0.02, 0] },
    { n: 'farmR', parent: 'uarmR', p: [-0.03, -0.24, 0.02] },
    { n: 'handR', parent: 'farmR', p: [-0.02, -0.22, 0.02] },
    { n: 'thighL', parent: 'pelvis', p: [0.12, -0.05, 0] },
    { n: 'shinL', parent: 'thighL', p: [0.01, -0.34, -0.09] },
    { n: 'metaL', parent: 'shinL', p: [-0.01, -0.34, 0.13] },
    { n: 'footL', parent: 'metaL', p: [0, -0.13, -0.16] },
    { n: 'thighR', parent: 'pelvis', p: [-0.12, -0.05, 0] },
    { n: 'shinR', parent: 'thighR', p: [-0.01, -0.34, -0.09] },
    { n: 'metaR', parent: 'shinR', p: [0.01, -0.34, 0.13] },
    { n: 'footR', parent: 'metaR', p: [0, -0.13, -0.16] },
  ];
  const rig = makeRig(T);
  const B = new Builder();
  const W = rig.bindWorld, I = rig.index;

  B.limb(I('pelvis'), W[I('pelvis')].clone().add(_a.set(0, -0.07, 0)), W[I('chest')],
    [[0, 0.14, 0.13], [0.5, 0.155, 0.14], [1, 0.13, 0.125]],
    { sides: 9, e: 3, col: PAL.jackalSkin, fx: FX_SUIT });
  B.plate(I('chest'), W[I('chest')].clone().add(_a.set(0, 0, -0.08)), [0.13, 0.12, 0.06],
    { col: PAL.jackalPlate, fx: FX_PLATE, taper: 0.85 });

  // long beaked head with a bony crest
  B.blob(I('head'), W[I('head')].clone().add(_a.set(0, 0.02, 0.01)), 0.078, 0.085, 0.10,
    { col: PAL.jackalSkin, fx: FX_SUIT, seg: 9, rows: 7 });
  B.limb(I('head'), W[I('head')].clone().add(_a.set(0, 0, -0.03)),
    W[I('head')].clone().add(_a.set(0, -0.035, -0.24)),
    [[0, 0.062, 0.055], [0.5, 0.04, 0.035], [1, 0.014, 0.012]],
    { sides: 7, col: PAL.jackalSkin, fx: FX_SUIT });
  B.plate(I('head'), W[I('head')].clone().add(_a.set(0, 0.10, 0.02)), [0.012, 0.075, 0.10],
    { col: PAL.jackalDark, fx: FX_SUIT, taper: 0.5, shear: [0, 0.05] });

  for (const s of [1, -1]) {
    const U = s > 0 ? 'uarmL' : 'uarmR', F = s > 0 ? 'farmL' : 'farmR', H = s > 0 ? 'handL' : 'handR';
    B.limb(I(U), W[I(U)], W[I(F)], [[0, 0.055, 0.055], [1, 0.042, 0.042]],
      { sides: 7, col: PAL.jackalSkin, fx: FX_SUIT });
    B.limb(I(F), W[I(F)], W[I(H)], [[0, 0.048, 0.048], [1, 0.036, 0.036]],
      { sides: 7, col: PAL.jackalPlate, fx: FX_PLATE });
    B.blob(I(H), W[I(H)].clone().add(_a.set(0, -0.02, 0)), 0.036, 0.045, 0.04,
      { col: PAL.jackalSkin, fx: FX_SUIT, seg: 6, rows: 4 });
  }

  for (const s of [1, -1]) {
    const TH = s > 0 ? 'thighL' : 'thighR', SH = s > 0 ? 'shinL' : 'shinR';
    const ME = s > 0 ? 'metaL' : 'metaR', FO = s > 0 ? 'footL' : 'footR';
    B.limb(I(TH), W[I(TH)], W[I(SH)], [[0, 0.095, 0.10], [1, 0.058, 0.062]],
      { sides: 8, col: PAL.jackalSkin, fx: FX_SUIT });
    B.limb(I(SH), W[I(SH)], W[I(ME)], [[0, 0.062, 0.065], [1, 0.038, 0.042]],
      { sides: 7, col: PAL.jackalPlate, fx: FX_PLATE });
    B.limb(I(ME), W[I(ME)], W[I(FO)], [[0, 0.042, 0.045], [1, 0.034, 0.036]],
      { sides: 6, col: PAL.jackalSkin, fx: FX_SUIT });
    for (const t of [-1, 0, 1])
      B.limb(I(FO), W[I(FO)], W[I(FO)].clone().add(_a.set(t * 0.04, -0.005, -0.10)),
        [[0, 0.024, 0.024], [1, 0.014, 0.014]], { sides: 5, col: PAL.jackalSkin, fx: FX_SUIT });
  }

  // point-defence gauntlet: a curved plate on the left forearm with a firing gap
  const gp = W[I('farmL')].clone().add(_a.set(0.05, -0.10, -0.16));
  B.limb(I('farmL'), gp.clone().add(_a.set(-0.02, 0.42, 0.05)), gp.clone().add(_a.set(0.02, -0.42, -0.05)),
    [[0, 0.05, 0.02], [0.18, 0.20, 0.035], [0.5, 0.245, 0.04], [0.82, 0.20, 0.035], [1, 0.05, 0.02]],
    { sides: 12, e: 2.2, col: srgb(0x7a4a1c), fx: [0.5, 0.1, 0.35], bow: [0, 0.05] });
  B.plate(I('farmL'), gp.clone().add(_a.set(0, 0.30, 0.02)), [0.055, 0.045, 0.035],
    { col: PAL.jackalDark, fx: FX_METAL });

  const hp = W[I('handR')].clone().add(_a.set(0, -0.02, -0.05));
  B.limb(I('handR'), hp.clone().add(_a.set(0, 0.02, 0.05)), hp.clone().add(_a.set(0, 0.02, -0.15)),
    [[0, 0.04, 0.05], [0.35, 0.05, 0.065], [1, 0.025, 0.035]],
    { sides: 8, e: 3, col: srgb(0x3f5a46), fx: FX_METAL });
  B.blob(I('handR'), hp.clone().add(_a.set(0, 0.02, -0.15)), 0.024, 0.024, 0.02,
    { col: PAL.glowGreen, fx: FX_GLOW, seg: 7, rows: 4 });

  return { rig, geom: B.build(), muzzle: hp.clone().add(_a.set(0, 0.02, -0.19)).sub(W[I('handR')]) };
}

/* ------------------------------------------------------------- actor archetypes */

const TYPES = {
  grunt: {
    build: (major) => buildGrunt(major), height: 1.30, eye: 1.12, hip: 0.55, radius: 0.33,
    hp: 42, shield: 0, walk: 1.5, run: 3.6, stride: 0.42, hipWidth: 0.11, hunch: -0.18,
    fov: 100 * DEG, sight: 48, hearing: 26, accuracy: 0.30, reaction: 0.55,
    burst: [3, 5], rof: 5.5, boltSpeed: 34, boltDamage: 5.5, boltColor: PAL.glowGreen,
    range: [6, 22], morale: 0.55, waddle: 1.0, mass: 90,
  },
  elite: {
    build: (major) => buildElite(major), height: 2.28, eye: 2.02, hip: 1.10, radius: 0.45,
    hp: 110, shield: 70, walk: 2.1, run: 5.4, stride: 0.78, hipWidth: 0.16, hunch: -0.08,
    fov: 130 * DEG, sight: 78, hearing: 44, accuracy: 0.72, reaction: 0.30,
    burst: [4, 8], rof: 8.5, boltSpeed: 52, boltDamage: 8.0, boltColor: PAL.glowCyan,
    range: [8, 34], morale: 1.0, waddle: 0.15, mass: 190,
  },
  jackal: {
    build: () => buildJackal(), height: 1.86, eye: 1.60, hip: 0.90, radius: 0.36,
    hp: 55, shield: 0, walk: 1.9, run: 4.6, stride: 0.60, hipWidth: 0.13, hunch: -0.38,
    fov: 115 * DEG, sight: 64, hearing: 32, accuracy: 0.58, reaction: 0.38,
    burst: [2, 4], rof: 4.5, boltSpeed: 36, boltDamage: 6.5, boltColor: PAL.glowGreen,
    range: [10, 28], morale: 0.8, waddle: 0.4, mass: 110,
  },
};

/* --------------------------------------------------------------- the encounter */

/** Beach encounter: the tide-pool shelf under the bridge tip. See docs/WORLD.md. */
const ENCOUNTER = [
  { t: 'elite', x: -30.5, z: -11.0, sq: 'A', major: true },
  { t: 'grunt', x: -27.0, z: -12.8, sq: 'A' },
  { t: 'grunt', x: -33.6, z: -13.2, sq: 'A' },
  { t: 'grunt', x: -29.6, z: -15.0, sq: 'A', major: true },
  { t: 'grunt', x: -36.0, z: -8.6, sq: 'A' },
  { t: 'elite', x: -41.5, z: -16.0, sq: 'B' },
  { t: 'grunt', x: -44.0, z: -18.0, sq: 'B' },
  { t: 'grunt', x: -38.8, z: -18.4, sq: 'B' },
  { t: 'jackal', x: -21.5, z: -9.5, sq: 'C' },
  { t: 'jackal', x: -24.0, z: -12.0, sq: 'C' },
  { t: 'grunt', x: -19.0, z: -12.5, sq: 'C' },
  { t: 'jackal', x: -25.5, z: -16.0, sq: 'C' },
];

/* ------------------------------------------------------------------ the module */

export function create(opts = {}) {
  let ctx = null;
  let rand = null;
  const actors = [];
  const squads = new Map();
  const shared = { geom: new Map(), proto: new Map() };
  let baseMaterial = null;
  let root = null;
  let bolts = null;
  let losBudgetIdx = 0;
  let coverBudgetIdx = 0;
  let simTime = 0;
  let nextId = 1;

  const api = {
    name: 'ai',
    order: 80,
    enabled: true,
    actors,
    stats: { cpuMs: 0, actors: 0, alive: 0, bolts: 0 },

    async init(c) { await init(c); },
    update(dt, c) { tick(dt, c); },
    prerender(c) { void c; },
    resize() {},
    dispose(c) { disposeAll(c); },

    spawn(type, position) { return spawnActor(type, position, {}); },
    damage(actorId, amount, hitPoint, direction) { return applyDamage(actorId, amount, hitPoint, direction); },
    nearestTo(point, faction) {
      let best = null, bd = Infinity;
      for (const a of actors) {
        if (!a.alive) continue;
        if (faction && a.faction !== faction) continue;
        const d = a.position.distanceToSquared(point);
        if (d < bd) { bd = d; best = a; }
      }
      return best;
    },
    /** Hitscan against actor hit zones. Returns {actor, point, normal, t, zone} | null. */
    raycast(origin, dir, maxDist = 200) { return raycastActors(origin, dir, maxDist); },
    /** Splash damage helper for grenades / rockets fired by anyone. */
    explode(point, radius, damage) { return explodeAt(point, radius, damage, null); },
  };

  /* ------------------------------------------------------------------- init */

  async function init(c) {
    ctx = c;
    rand = ctx.rand.fork(0x415f01);

    root = new THREE.Group();
    root.name = 'ai_actors';
    ctx.scene.add(root);

    baseMaterial = makeActorMaterial(ctx);
    bolts = makeBoltSystem(ctx, root);

    for (const e of ENCOUNTER) {
      const p = new THREE.Vector3(e.x, 0, e.z);
      spawnActor(e.t, p, { squad: e.sq, major: !!e.major });
    }

    // squad leaders: the highest-ranking Elite, else the toughest member
    for (const [, sq] of squads) {
      let lead = null;
      for (const m of sq.members) if (!lead || m.def.hp * (1 + m.def.shield) > lead.def.hp * (1 + lead.def.shield)) lead = m;
      sq.leader = lead;
      if (lead) lead.isLeader = true;
    }

    ctx.on('weapon:fired', onWeaponFired);
    ctx.on('player:footstep', onFootstep);
    ctx.on('camera:teleport', onTeleport);

    // Pose everyone once so the very first captured frame is not a T-pose.
    for (const a of actors) { poseActor(a, 0, 0); a.mesh.updateMatrixWorld(true); }
  }

  function disposeAll(c) {
    c?.off?.('weapon:fired', onWeaponFired);
    c?.off?.('player:footstep', onFootstep);
    c?.off?.('camera:teleport', onTeleport);
    for (const a of actors) { a.mesh.geometry.dispose?.(); a.material.dispose?.(); a.shield?.material?.dispose?.(); }
    for (const g of shared.geom.values()) g.dispose?.();
    bolts?.dispose?.();
    if (root && c) c.scene.remove(root);
    actors.length = 0;
  }

  /* --------------------------------------------------------------- materials */

  function makeActorMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.1,
      emissive: 0x000000, side: THREE.FrontSide, dithering: true,
    });
    return m;
  }

  /** Per-actor clone so glow pulse / hit flash are per-actor uniforms; one program. */
  function actorMaterial() {
    const m = baseMaterial.clone();
    const u = {
      uGlow: { value: 1.0 },
      uHitFlash: { value: 0.0 },
      uMuzzle: { value: 0.0 },
      uShieldTint: { value: new THREE.Color(0, 0, 0) },
    };
    applyWorldMaterial(m, ctx, {
      matId: MAT_ID.SKIN,
      inject: {
        key: 'ai_actor',
        uniforms: u,
        vertexPars: 'attribute vec3 aFx;\nvarying vec3 vFx;',
        vertex: 'vFx = aFx;',
        pars: 'varying vec3 vFx;\nuniform float uGlow;\nuniform float uHitFlash;\nuniform float uMuzzle;\nuniform vec3 uShieldTint;',
        // NOTE: <lights_physical_fragment> has already packed roughnessFactor /
        // metalnessFactor into `material` by the time this block runs, so the
        // per-vertex surface parameters have to be written into `material` itself.
        fragment: `
          float aiRough = clamp( vFx.z, 0.04, 1.0 );
          float aiMetal = clamp( vFx.y, 0.0, 1.0 );
          material.roughness = clamp( aiRough, 0.0525, 1.0 );
          material.metalness = aiMetal;
          material.diffuseContribution = diffuseColor.rgb * ( 1.0 - aiMetal );
          material.specularColorBlended = mix( vec3( 0.04 ), diffuseColor.rgb, aiMetal );
          float em = vFx.x * ( uGlow + uMuzzle * 2.5 );
          totalEmissiveRadiance += diffuseColor.rgb * em;
          totalEmissiveRadiance += uShieldTint;
          totalEmissiveRadiance += vec3( 1.8, 0.6, 0.30 ) * uHitFlash;
        `,
      },
    });
    m.userData.aiUniforms = u;
    return m;
  }

  /* ----------------------------------------------------------------- spawning */

  function spawnActor(type, position, o = {}) {
    const def = TYPES[type] || TYPES.grunt;
    // Bones cannot be shared between SkinnedMeshes, so each actor is rebuilt. The
    // generators are pure and cheap (a few ms for the whole encounter, at init only).
    const built = TYPES[type] ? TYPES[type].build(!!o.major) : buildGrunt(false);
    const rig = built.rig;
    const geom = built.geom;

    const mat = actorMaterial();
    const mesh = new THREE.SkinnedMesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.OPAQUE);
    mesh.frustumCulled = true;

    mesh.add(rig.bones[0]);
    rig.bones[0].updateMatrixWorld(true);
    const skel = new THREE.Skeleton(rig.bones);
    mesh.bind(skel, new THREE.Matrix4());

    patchForGBuffer(mesh, { roughness: 0.55, matId: MAT_ID.SKIN, skip: false });

    const group = new THREE.Group();
    group.add(mesh);
    root.add(group);

    const r = rand.fork(nextId * 7919);
    const gy = groundAt(position.x, position.z);

    const a = {
      id: nextId++, type: TYPES[type] ? type : 'grunt', faction: FACTION.COVENANT,
      def, major: !!o.major, isLeader: false,
      position: new THREE.Vector3(position.x, gy, position.z),
      velocity: new THREE.Vector3(),
      home: new THREE.Vector3(position.x, gy, position.z),
      yaw: r.range(-Math.PI, Math.PI), aimYaw: 0, aimPitch: 0, desiredYaw: 0,
      health: 1, shield: def.shield > 0 ? 1 : 0, alive: true,
      maxHp: def.hp, maxShield: def.shield,
      group, mesh, material: mat, rig, muzzleLocal: built.muzzle.clone(),
      wp: rig.bones.map(() => new THREE.Vector3()),
      wq: rig.bones.map(() => new THREE.Quaternion()),
      bi: {},                            // cached bone indices
      legs: null, gaitPhase: r.next(), speed: 0, stepTimer: 0,
      lean: 0, bob: 0, breath: r.next() * 6.28,
      flinch: new THREE.Vector3(), flinchV: new THREE.Vector3(),
      hitFlash: 0, muzzleFlash: 0, glowPulse: r.next() * 6.28,
      state: 'idle', stateT: 0, prevState: '',
      awareness: 0, canSee: false, lkp: new THREE.Vector3(), lkpAge: 99, losTimer: r.next() * 0.3,
      reactT: 0, fireT: 0, burstLeft: 0, reloadT: 0, grenadeT: r.range(6, 14),
      cover: null, coverT: 0, strafeDir: r.next() < 0.5 ? 1 : -1, strafeT: 0,
      morale: def.morale, panic: 0, berserk: false, retreatT: 0,
      squad: o.squad || 'X', rand: r, lod: 0, distToCam: 0,
      ragdoll: null, body: null, deathT: 0, tankRupture: 0,
      shieldMesh: null, shieldFlash: 0, impacts: [],
      shieldRegenT: 0, desiredSpeed: 0, moveDir: new THREE.Vector3(0, 0, -1),
      rootQ: new THREE.Quaternion(),
    };

    for (const n of ['pelvis', 'spine', 'chest', 'neck', 'head', 'handR', 'handL',
      'thighL', 'shinL', 'metaL', 'footL', 'thighR', 'shinR', 'metaR', 'footR',
      'clavL', 'clavR', 'uarmL', 'farmL', 'uarmR', 'farmR', 'tank', 'toeL', 'toeR',
      'jawUL', 'jawUR', 'jawLL', 'jawLR']) {
      const i = rig.index(n);
      if (i >= 0) a.bi[n] = i;
    }
    // Watch posture: posted toward the beach, where the player comes from.
    a.yaw = angWrap(Math.PI + r.sym(0.7));
    a.desiredYaw = a.yaw;
    a.legs = [makeLeg(a, 1), makeLeg(a, -1)];
    for (const leg of a.legs) {
      neutralFoot(a, leg, leg.plant);
      leg.from.copy(leg.plant); leg.target.copy(leg.plant); leg.init = true;
    }

    if (def.shield > 0) attachShield(a);

    const sq = squads.get(a.squad) || { id: a.squad, members: [], leader: null, alertT: 99, lkp: new THREE.Vector3(), slots: 0 };
    sq.members.push(a);
    squads.set(a.squad, sq);

    group.position.copy(a.position);
    actors.push(a);
    api.stats.actors = actors.length;
    return a;
  }

  function makeLeg(a, side) {
    const S = side > 0 ? 'L' : 'R';
    const has = a.bi['meta' + S] !== undefined;
    const bones = a.rig.bones;
    const thigh = a.bi['thigh' + S], shin = a.bi['shin' + S];
    const meta = has ? a.bi['meta' + S] : -1, foot = a.bi['foot' + S];
    // Ankle offset is derived from the actual bone lengths, not hard-coded — the
    // three body plans have very different metatarsals and a fixed number
    // over-extends the IK chain and locks the leg straight.
    const metaLen = has ? bones[meta].position.length() : 0;
    const footLen = foot >= 0 ? bones[foot].position.length() : 0.1;
    const leg = {
      side,
      thigh, shin, meta, foot, digit: has,
      l1: bones[shin].position.length(),
      l2: has ? bones[meta].position.length() : bones[foot].position.length(),
      ankleUp: has ? footLen * 0.80 : Math.max(0.09, footLen * 0.85),
      ankleBack: has ? footLen * 0.55 : 0,
      plant: new THREE.Vector3(), from: new THREE.Vector3(), target: new THREE.Vector3(),
      swinging: false, init: false,
      phase: side > 0 ? 0 : 0.5,
    };
    void metaLen;
    return leg;
  }

  /** Neutral stance position for a leg, in world space. */
  function neutralFoot(a, leg, out) {
    const rgtX = Math.cos(a.yaw), rgtZ = -Math.sin(a.yaw);
    const x = a.position.x + rgtX * leg.side * a.def.hipWidth;
    const z = a.position.z + rgtZ * leg.side * a.def.hipWidth;
    return out.set(x, groundAt(x, z), z);
  }

  /* ------------------------------------------------------------ Elite shields */

  function attachShield(a) {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uFlash: { value: 0 }, uColor: { value: new THREE.Color(0.35, 0.75, 1.0) },
        uImpacts: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uBreak: { value: 0 },
      },
      vertexShader: `
        varying vec3 vLocal; varying vec3 vN; varying vec3 vView;
        void main(){
          vLocal = position; vN = normalize( normalMatrix * normal );
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          vView = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uFlash; uniform float uBreak; uniform vec3 uColor;
        uniform vec4 uImpacts[3];
        varying vec3 vLocal; varying vec3 vN; varying vec3 vView;
        float hexd( vec2 p ){
          p = abs(p);
          return max( dot(p, normalize(vec2(1.0,1.732))), p.x );
        }
        void main(){
          vec3 n = normalize( vN );
          float fres = pow( 1.0 - clamp( dot( n, normalize( vView ) ), 0.0, 1.0 ), 2.4 );
          // hex cells over a cylindrical parameterisation of the shell
          vec2 uv = vec2( atan( vLocal.z, vLocal.x ) * 2.2, vLocal.y * 6.5 );
          vec2 r = vec2( 1.0, 1.732 );
          vec2 h = r * 0.5;
          vec2 a1 = mod( uv, r ) - h;
          vec2 a2 = mod( uv - h, r ) - h;
          vec2 gv = dot( a1, a1 ) < dot( a2, a2 ) ? a1 : a2;
          float cell = hexd( gv );
          float edge = smoothstep( 0.72, 0.86, cell );
          float energy = 0.0;
          for ( int i = 0; i < 3; i++ ){
            vec4 im = uImpacts[i];
            if ( im.w <= 0.0 ) continue;
            float d = distance( vLocal, im.xyz );
            float ring = exp( -pow( ( d - im.w * 2.2 ) * 3.0, 2.0 ) );
            energy += ring * ( 1.0 - im.w ) * 2.4;
            energy += exp( -d * 4.0 ) * ( 1.0 - im.w ) * 1.2;
          }
          float amt = uFlash * ( 0.28 + edge * 1.0 ) + energy * ( 0.35 + edge * 1.35 );
          amt += uBreak * ( 0.5 + fres * 2.0 );
          amt *= 0.35 + fres * 1.4;
          if ( amt < 0.004 ) discard;
          gl_FragColor = vec4( uColor * amt * 2.2, clamp( amt, 0.0, 1.0 ) );
        }`,
    });
    const m = new THREE.Mesh(g, mat);
    m.layers.set(LAYER.TRANSPARENT);
    m.frustumCulled = true;
    m.visible = false;
    const d = a.def;
    m.scale.set(d.radius + 0.30, d.height * 0.56, d.radius + 0.36);
    m.position.set(0, d.height * 0.52, 0);
    a.group.add(m);
    a.shieldMesh = m;
  }

  /* ------------------------------------------------------------ plasma bolts */

  function makeBoltSystem(c, parent) {
    const MAX = 96;
    const g = new THREE.SphereGeometry(1, 7, 5);
    // `color_fragment` only applies vColor under USE_COLOR, so an instanced-colour
    // mesh still needs a (white) vertex colour attribute or every bolt renders black.
    const nv = g.getAttribute('position').count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(nv * 3).fill(1), 3));
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(3.2, 3.2, 3.2), vertexColors: true,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      toneMapped: false, side: THREE.DoubleSide,
    });
    const im = new THREE.InstancedMesh(g, mat, MAX);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.layers.set(LAYER.EFFECTS);
    im.count = MAX;
    im.castShadow = false;
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    im.instanceColor = colors;
    parent.add(im);

    const list = [];
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
    const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) im.setMatrixAt(i, ZERO);

    return {
      mesh: im,
      get count() { return list.length; },
      spawn(origin, vel, o) {
        if (list.length >= MAX) list.shift();
        list.push({
          p: origin.clone(), v: vel.clone(), life: o.life ?? 3.0,
          col: o.color || PAL.glowCyan, dmg: o.damage ?? 6, owner: o.owner || null,
          grav: o.grav ?? 0, r: o.radius ?? 0.055, len: o.len ?? 0.42, grenade: !!o.grenade,
          fuse: o.fuse ?? 0,
        });
      },
      step(dt, onImpact) {
        for (let i = list.length - 1; i >= 0; i--) {
          const b = list[i];
          b.life -= dt;
          if (b.grav) b.v.y += GRAVITY * b.grav * dt;
          _a.copy(b.v).multiplyScalar(dt);
          const dist = _a.length();
          if (dist > 1e-5) {
            const hit = worldRay(b.p, _b.copy(_a).divideScalar(dist), dist + b.r);
            if (hit) {
              onImpact(b, hit.point, hit.normal);
              list.splice(i, 1);
              continue;
            }
          }
          b.p.add(_a);
          if (b.grenade && b.fuse > 0) { b.fuse -= dt; if (b.fuse <= 0) { onImpact(b, b.p, _up, true); list.splice(i, 1); continue; } }
          if (b.life <= 0) { list.splice(i, 1); continue; }
        }
        // upload
        const n = Math.min(list.length, MAX);
        for (let i = 0; i < n; i++) {
          const b = list[i];
          const sp = b.v.length();
          _c.copy(b.v).divideScalar(sp || 1);
          Q.setFromUnitVectors(_up, _c);
          S.set(b.r, b.grenade ? b.r : Math.max(b.r, b.len * clamp(sp / 40, 0.25, 1.6)), b.r);
          M.compose(b.p, Q, S);
          im.setMatrixAt(i, M);
          colors.setXYZ(i, b.col.r, b.col.g, b.col.b);
        }
        im.count = Math.max(1, n);
        if (n === 0) im.setMatrixAt(0, ZERO);
        im.instanceMatrix.needsUpdate = true;
        colors.needsUpdate = true;
        return list.length;
      },
      clear() { list.length = 0; },
      dispose() { g.dispose(); mat.dispose(); },
    };
  }

  /* ----------------------------------------------------- world query helpers */

  function terrainMod() { const t = ctx?.get('terrain'); return t && typeof t.height === 'function' ? t : null; }
  function physicsMod() { const p = ctx?.get('physics'); return p && typeof p.raycast === 'function' ? p : null; }

  function groundAt(x, z) {
    const t = terrainMod();
    if (!t) return 0;
    const y = t.height(x, z);
    return Number.isFinite(y) ? y : 0;
  }

  /** Ray against the static world only (never against actors). */
  function worldRay(origin, dir, maxDist) {
    const p = physicsMod();
    if (p) return p.raycast(origin, dir, maxDist, p.MASK ? p.MASK.WORLD : undefined);
    // Fallback: analytic terrain march so LOS still means something without physics.
    const t = terrainMod();
    if (!t) return null;
    let step = Math.max(0.25, maxDist / 120), prev = 0;
    if (origin.y - t.height(origin.x, origin.z) < 0) return null;
    for (let s = step; s <= maxDist; s += step) {
      const y = origin.y + dir.y * s;
      if (y - t.height(origin.x + dir.x * s, origin.z + dir.z * s) < 0) {
        let lo = prev, hi = s;
        for (let i = 0; i < 16; i++) {
          const mid = (lo + hi) * 0.5;
          const h = (origin.y + dir.y * mid) - t.height(origin.x + dir.x * mid, origin.z + dir.z * mid);
          if (h < 0) hi = mid; else lo = mid;
        }
        const point = origin.clone().addScaledVector(dir, hi);
        const normal = t.normal ? t.normal(point.x, point.z, new THREE.Vector3()) : new THREE.Vector3(0, 1, 0);
        return { point, normal, t: hi, body: null, surface: 'sand' };
      }
      prev = s;
      step = Math.min(step * 1.08, 5);
    }
    return null;
  }

  /** Player facade — falls back to the camera so the encounter is alive in captures. */
  const targetFacade = {
    position: new THREE.Vector3(), eye: new THREE.Vector3(), velocity: new THREE.Vector3(),
    health: 1, shield: 1, real: false, valid: false,
  };
  function resolveTarget() {
    const pl = ctx.get('player');
    const T = targetFacade;
    if (pl && pl.position && pl.position.isVector3 && Number.isFinite(pl.position.x)) {
      T.position.copy(pl.position);
      T.eye.copy(pl.eye && pl.eye.isVector3 ? pl.eye : _a.copy(pl.position).add(_b.set(0, 1.72, 0)));
      if (pl.velocity && pl.velocity.isVector3) T.velocity.copy(pl.velocity); else T.velocity.set(0, 0, 0);
      T.health = Number.isFinite(pl.health) ? pl.health : 1;
      T.shield = Number.isFinite(pl.shield) ? pl.shield : 0;
      T.real = true; T.valid = true;
      return T;
    }
    const cam = ctx.camera;
    if (!cam) { T.valid = false; return T; }
    T.eye.copy(cam.position);
    T.position.set(cam.position.x, cam.position.y - 1.72, cam.position.z);
    T.velocity.set(0, 0, 0);
    T.health = 1; T.shield = 1; T.real = false; T.valid = true;
    return T;
  }

  /* ------------------------------------------------------------- hit volumes */

  /** Hit zones in world space, rebuilt from position+yaw (cheap, no FK needed). */
  function zonesOf(a, out) {
    out.length = 0;
    const s = Math.sin(a.yaw), c = Math.cos(a.yaw);
    const fx = -s, fz = -c;          // forward
    const rx = c, rz = -s;           // right
    const P = (up, fwd, right) => new THREE.Vector3(
      a.position.x + fx * fwd + rx * right,
      a.position.y + up,
      a.position.z + fz * fwd + rz * right);
    const d = a.def;
    if (a.type === 'grunt') {
      out.push({ k: 'head', c: P(1.14, -0.04, 0), r: 0.17, mult: 3.0 });
      out.push({ k: 'tank', c: P(0.98, 0.22, 0), r: 0.20, mult: 1.4 });
      out.push({ k: 'body', a: P(0.60, 0, 0), b: P(1.00, -0.02, 0), r: 0.25, mult: 1.0 });
      out.push({ k: 'legs', a: P(0.06, 0, 0), b: P(0.58, 0, 0), r: 0.17, mult: 0.7 });
    } else if (a.type === 'elite') {
      out.push({ k: 'head', c: P(2.00, -0.03, 0), r: 0.21, mult: 2.6 });
      out.push({ k: 'body', a: P(1.14, 0, 0), b: P(1.78, -0.02, 0), r: 0.34, mult: 1.0 });
      out.push({ k: 'legs', a: P(0.08, 0, 0), b: P(1.12, 0, 0), r: 0.23, mult: 0.7 });
    } else {
      out.push({ k: 'gauntlet', c: P(1.24, 0.34, 0.22), r: 0.46, disc: true, n: new THREE.Vector3(fx, 0, fz), mult: 0 });
      out.push({ k: 'head', c: P(1.66, -0.06, 0), r: 0.16, mult: 2.8 });
      out.push({ k: 'body', a: P(0.98, 0, 0), b: P(1.52, -0.04, 0), r: 0.26, mult: 1.0 });
      out.push({ k: 'legs', a: P(0.06, 0, 0), b: P(0.96, 0, 0), r: 0.19, mult: 0.7 });
    }
    void d;
    return out;
  }

  const _zones = [];
  function raySphereT(ro, rd, cc, r) {
    const ox = ro.x - cc.x, oy = ro.y - cc.y, oz = ro.z - cc.z;
    const bq = ox * rd.x + oy * rd.y + oz * rd.z;
    const q = ox * ox + oy * oy + oz * oz - r * r;
    const h = bq * bq - q;
    if (h < 0) return -1;
    const s = Math.sqrt(h), t0 = -bq - s;
    if (t0 >= 0) return t0;
    const t1 = -bq + s;
    return t1 >= 0 ? t1 : -1;
  }
  function rayCapsuleT(ro, rd, A, Bp, r) {
    _a.subVectors(Bp, A); _b.subVectors(ro, A);
    const baba = _a.dot(_a), bard = _a.dot(rd), baoa = _a.dot(_b);
    const rdoa = rd.dot(_b), oaoa = _b.dot(_b);
    const A2 = baba - bard * bard;
    const B2 = baba * rdoa - baoa * bard;
    const C2 = baba * oaoa - baoa * baoa - r * r * baba;
    const h = B2 * B2 - A2 * C2;
    if (h >= 0 && Math.abs(A2) > 1e-9) {
      const t = (-B2 - Math.sqrt(h)) / A2;
      const y = baoa + t * bard;
      if (t >= 0 && y > 0 && y < baba) return t;
    }
    let best = -1;
    for (const p of [A, Bp]) { const t = raySphereT(ro, rd, p, r); if (t >= 0 && (best < 0 || t < best)) best = t; }
    return best;
  }

  function raycastActors(origin, dir, maxDist) {
    const d = _d.copy(dir).normalize();
    let best = null;
    for (const a of actors) {
      if (!a.alive) continue;
      if (a.position.distanceToSquared(origin) > (maxDist + 3) * (maxDist + 3)) continue;
      zonesOf(a, _zones);
      for (const z of _zones) {
        let t = -1;
        if (z.disc) {
          const denom = d.dot(z.n);
          if (denom < -0.15) {
            const tt = _e.subVectors(z.c, origin).dot(z.n) / denom;
            if (tt > 0) {
              _f.copy(origin).addScaledVector(d, tt);
              const rr = _f.distanceTo(z.c);
              // firing gap: a notch on the inboard upper quadrant
              const rel = _f.clone().sub(z.c);
              const gap = rel.y > 0.04 && Math.abs(rel.y) < 0.22 && rr > 0.16 && rr < 0.34;
              if (rr < z.r && !gap) t = tt;
            }
          }
        } else if (z.c) t = raySphereT(origin, d, z.c, z.r);
        else t = rayCapsuleT(origin, d, z.a, z.b, z.r);
        if (t >= 0 && t <= maxDist && (!best || t < best.t)) {
          const point = origin.clone().addScaledVector(d, t);
          const nrm = z.c ? point.clone().sub(z.c).normalize() : d.clone().negate();
          best = { actor: a, point, normal: nrm, t, zone: z.k, mult: z.mult };
        }
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ damage */

  function applyDamage(actorId, amount, hitPoint, direction) {
    const a = typeof actorId === 'object' ? actorId : actors.find((x) => x.id === actorId);
    if (!a || !a.alive || !Number.isFinite(amount) || amount <= 0) return;
    const hp = hitPoint && hitPoint.isVector3 ? hitPoint : a.position.clone().add(_a.set(0, a.def.height * 0.6, 0));
    const dir = direction && direction.isVector3 ? _b.copy(direction).normalize() : _b.set(0, 0, 1);

    // zone lookup from the hit point
    zonesOf(a, _zones);
    let zone = 'body', mult = 1;
    let bd = Infinity;
    for (const z of _zones) {
      let dist;
      if (z.c) dist = hp.distanceTo(z.c) - z.r;
      else {
        _c.subVectors(z.b, z.a);
        const t = clamp(_e.subVectors(hp, z.a).dot(_c) / Math.max(1e-6, _c.lengthSq()), 0, 1);
        dist = hp.distanceTo(_f.copy(z.a).addScaledVector(_c, t)) - z.r;
      }
      if (dist < bd) { bd = dist; zone = z.k; mult = z.mult; }
    }
    if (zone === 'gauntlet') {
      a.shieldFlash = 1;
      ctx.get('hud')?.setHitMarker?.('shield');
      ctx.emit('actor:damaged', { actor: a, amount: 0, point: hp.clone(), zone, blocked: true });
      return;
    }

    let dmg = amount * mult;
    let shieldHit = false;

    if (a.shield > 0) {
      shieldHit = true;
      const sAbs = Math.min(a.shield * a.maxShield, dmg);
      a.shield -= sAbs / a.maxShield;
      dmg -= sAbs;
      a.shieldFlash = 1;
      a.shieldRegenT = 5.0;
      pushImpact(a, hp);
      if (a.shield <= 0.0005) { a.shield = 0; a.shieldFlash = 2.2; a.shieldBreak = 0.9; }
    }

    // Grunt methane tank: a back hit ruptures it — a kill and a jet of gas.
    if (zone === 'tank' && a.type === 'grunt' && dmg > 0) dmg = a.maxHp * 2;

    if (dmg > 0) {
      a.health -= dmg / a.maxHp;
      a.hitFlash = Math.min(1, a.hitFlash + 0.55);
      // hit reaction: angular impulse into the flinch spring
      const s = Math.sin(a.yaw), c = Math.cos(a.yaw);
      const local = _c.set(dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c);
      const k = clamp(dmg / 22, 0.05, 1.0);
      a.flinchV.x += -local.z * k * 9;
      a.flinchV.y += local.x * k * 5;
      a.flinchV.z += local.x * k * 4;
    }

    ctx.get('hud')?.setHitMarker?.(a.health <= 0 ? 'kill' : (shieldHit && dmg <= 0 ? 'shield' : 'hit'));
    ctx.emit('actor:damaged', { actor: a, amount, point: hp.clone(), zone, shield: shieldHit });
    ctx.get('audio')?.play?.(shieldHit && dmg <= 0 ? 'shield_hit' : 'flesh_hit', { position: hp.clone() });

    // morale: being shot degrades a Grunt's nerve
    if (a.type === 'grunt') a.morale -= 0.10;

    if (a.health <= 0) killActor(a, hp, dir, zone);
    else {
      // suppression: getting hit tells the whole squad where the shooter is
      const sq = squads.get(a.squad);
      if (sq) {
        sq.alertT = 0;
        sq.lkp.copy(hp).addScaledVector(dir, -12);
      }
      if (a.awareness < 1) a.awareness = 1;
      a.lkp.copy(hp).addScaledVector(dir, -12);
      a.lkpAge = 0;
    }
  }

  function pushImpact(a, worldPoint) {
    if (!a.shieldMesh) return;
    _a.copy(worldPoint).sub(a.group.position);
    _a.applyAxisAngle(_up, -a.yaw);
    _a.y -= a.shieldMesh.position.y;
    _a.divide(a.shieldMesh.scale);
    if (_a.lengthSq() > 1e-6) _a.normalize();
    a.impacts.push({ p: _a.clone(), t: 0 });
    if (a.impacts.length > 3) a.impacts.shift();
  }

  function killActor(a, point, dir, zone) {
    if (!a.alive) return;
    a.alive = false;
    a.health = 0;
    a.state = 'dead';
    a.deathT = 0;
    a.tankRupture = (zone === 'tank' && a.type === 'grunt') ? 1 : 0;
    a.mesh.castShadow = true;
    if (a.shieldMesh) a.shieldMesh.visible = false;

    // Ragdoll: a physics body carries the core (world collision, friction, sleep),
    // verlet particles carry the limbs off it.
    const impulse = _a.copy(dir).multiplyScalar(a.tankRupture ? 8.5 : 2.6);
    impulse.y += a.tankRupture ? 5.5 : 1.6;
    startRagdoll(a, impulse);

    ctx.emit('actor:killed', { actor: a, point: point.clone(), zone });
    ctx.get('audio')?.play?.(a.type + '_death', { position: point.clone() });

    // morale shock — Grunts break when their Elite dies
    const sq = squads.get(a.squad);
    if (sq) {
      const leaderDown = sq.leader === a;
      for (const m of sq.members) {
        if (!m.alive || m === a) continue;
        if (leaderDown && m.type === 'grunt') { m.morale -= 0.95; m.panic = 1; }
        else if (leaderDown) m.morale -= 0.30;
        else m.morale -= m.type === 'grunt' ? 0.22 : 0.05;
        m.awareness = Math.max(m.awareness, 0.9);
        if (m.lkpAge > 2) { m.lkp.copy(point); m.lkpAge = 0; }
      }
      if (leaderDown) {
        // promote the next best survivor
        let lead = null;
        for (const m of sq.members) if (m.alive && (!lead || m.def.hp > lead.def.hp)) lead = m;
        sq.leader = lead;
        if (lead) lead.isLeader = true;
      }
    }
    api.stats.alive = actors.reduce((n, x) => n + (x.alive ? 1 : 0), 0);
  }

  function explodeAt(point, radius, damage, owner) {
    for (const a of actors) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(point);
      if (d > radius) continue;
      const k = 1 - d / radius;
      applyDamage(a, damage * k * k, point.clone(), _a.copy(a.position).sub(point).normalize().clone());
    }
    const T = resolveTarget();
    if (T.valid && T.real) {
      const d = T.position.distanceTo(point);
      if (d < radius) {
        const k = 1 - d / radius;
        hurtPlayer(damage * k * k, _a.copy(T.position).sub(point).normalize());
      }
    }
    void owner;
    ctx.emit('weapon:impact', { point: point.clone(), normal: _up.clone(), material: 0, surface: 'explosion' });
  }

  function hurtPlayer(amount, dir) {
    const pl = ctx.get('player');
    if (pl && typeof pl.damage === 'function') pl.damage(amount, dir.clone());
    ctx.emit('player:damaged', { amount, direction: dir.clone() });
    ctx.get('hud')?.flashDamage?.(dir.clone());
  }

  /* ------------------------------------------------------------ event hooks */

  function onWeaponFired(p) {
    if (!p || !p.origin) return;
    if (p.faction === FACTION.COVENANT) return;      // our own fire is not an alarm
    for (const a of actors) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(p.origin);
      if (d > a.def.hearing * 2.2) continue;
      a.awareness = Math.min(1.2, a.awareness + clamp(1.6 - d / (a.def.hearing * 2.2), 0.15, 1.0));
      a.lkp.copy(p.origin);
      a.lkpAge = 0;
      const sq = squads.get(a.squad);
      if (sq && sq.alertT > 0.5) { sq.alertT = 0; sq.lkp.copy(p.origin); }
    }
  }

  function onFootstep(p) {
    if (!p || !p.position) return;
    const rangeK = p.running ? 20 : 9;
    for (const a of actors) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(p.position);
      if (d > rangeK) continue;
      a.awareness = Math.min(1.2, a.awareness + 0.35 * (1 - d / rangeK));
      if (a.awareness > 0.4) { a.lkp.copy(p.position); a.lkpAge = 0; }
    }
  }

  function onTeleport() {
    // A camera cut is not a stimulus — reset perception so a capture starts neutral.
    for (const a of actors) {
      if (!a.alive) continue;
      a.awareness = 0; a.canSee = false; a.lkpAge = 99;
      a.reactT = a.def.reaction; a.burstLeft = 0;
      a.state = 'idle'; a.stateT = 0;
    }
    for (const [, sq] of squads) sq.alertT = 99;
    bolts?.clear?.();
  }

  /* ------------------------------------------------------------------- tick */

  function tick(dt, c) {
    ctx = c;
    if (!api.enabled || !root) return;
    if (c.config.frozen) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.05);
    const t0 = performance.now();

    simTime += dt;
    const T = resolveTarget();
    const camPos = c.camera ? c.camera.position : T.eye;

    // Hard per-frame query budgets: at most 3 LOS rays and 1 cover search.
    losBudgetIdx = 0;
    coverBudgetIdx = 0;

    for (const [, sq] of squads) sq.alertT += dt;

    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      a.distToCam = a.position.distanceTo(camPos);
      a.lod = a.distToCam < 26 ? 0 : a.distToCam < 62 ? 1 : a.distToCam < 130 ? 2 : 3;
      a.mesh.castShadow = a.lod <= 1;

      if (!a.alive) { updateRagdoll(a, dt); continue; }

      const behaveEvery = a.lod === 0 ? 1 : a.lod === 1 ? 2 : a.lod === 2 ? 5 : 12;
      if (((c.clock.frame + a.id) % behaveEvery) === 0) {
        perceive(a, T, dt * behaveEvery);
        behave(a, T, dt * behaveEvery);
      }
      locomote(a, dt);
      poseActor(a, dt, simTime);
      updateFx(a, dt);
    }

    api.stats.bolts = bolts.step(dt, onBoltImpact);
    api.stats.cpuMs = api.stats.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  function onBoltImpact(b, point, normal, detonated) {
    if (b.grenade || detonated) {
      explodeAt(point, 5.2, 58, b.owner);
      return;
    }
    ctx.emit('weapon:impact', { point: point.clone(), normal: normal.clone(), material: 0, surface: 'plasma' });
  }

  /* -------------------------------------------------------------- perception */

  function perceive(a, T, dt) {
    a.lkpAge += dt;
    a.losTimer -= dt;
    if (!T.valid || ctx.config.aiPassive) { a.awareness = Math.max(0, a.awareness - dt * 0.4); a.canSee = false; return; }

    const d = a.position.distanceTo(T.position);
    const eye = _a.copy(a.position); eye.y += a.def.eye;
    _b.copy(T.eye).sub(eye);
    const dist = _b.length();
    _b.divideScalar(Math.max(dist, 1e-4));
    const fwd = _c.set(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
    const cosA = fwd.x * _b.x + fwd.z * _b.z;
    const inCone = cosA > Math.cos(a.def.fov * 0.5);
    const inRange = d < a.def.sight;

    // LOS is the expensive part: at most a couple of rays a frame, round-robin.
    if (inCone && inRange && a.losTimer <= 0 && losBudgetIdx < 3) {
      losBudgetIdx++;
      a.losTimer = a.lod === 0 ? 0.12 : 0.35;
      const hit = worldRay(eye, _b, dist - 0.35);
      a.canSee = !hit;
    } else if (!inCone || !inRange) {
      a.canSee = false;
    }

    const closeness = clamp(1 - d / a.def.sight, 0, 1);
    if (a.canSee) {
      const gain = (0.9 + closeness * 2.4) * (0.45 + 0.55 * clamp((cosA - 0.2) / 0.8, 0, 1));
      a.awareness = Math.min(1.25, a.awareness + gain * dt);
      a.lkp.copy(T.position);
      a.lkpAge = 0;
      const sq = squads.get(a.squad);
      if (sq && a.awareness >= 1) { sq.alertT = 0; sq.lkp.copy(T.position); }
    } else {
      a.awareness = Math.max(0, a.awareness - dt * (a.lkpAge > 6 ? 0.28 : 0.10));
    }

    // squad comms: a squadmate's contact reaches everyone after a short delay
    const sq = squads.get(a.squad);
    if (sq && sq.alertT > 0.45 && sq.alertT < 25 && a.awareness < 0.85) {
      a.awareness = Math.min(1.0, a.awareness + dt * 1.4);
      if (a.lkpAge > 1.5) { a.lkp.copy(sq.lkp); a.lkpAge = 0.5; }
    }
  }

  /* ---------------------------------------------------------------- behaviour */

  function setState(a, s) {
    if (a.state === s) return;
    a.prevState = a.state;
    a.state = s;
    a.stateT = 0;
  }

  function behave(a, T, dt) {
    a.stateT += dt;
    a.reloadT = Math.max(0, a.reloadT - dt);
    a.fireT = Math.max(0, a.fireT - dt);
    a.grenadeT -= dt;
    a.coverT -= dt;
    a.strafeT -= dt;
    a.retreatT = Math.max(0, a.retreatT - dt);
    a.reactT = Math.max(0, a.reactT - dt);
    a.shieldRegenT = Math.max(0, a.shieldRegenT - dt);
    a.panic = Math.max(0, a.panic - dt * 0.12);

    // Elite shields recharge out of contact
    if (a.maxShield > 0 && a.shieldRegenT <= 0 && a.shield < 1) {
      a.shield = Math.min(1, a.shield + dt * 0.45);
      a.shieldFlash = Math.max(a.shieldFlash, 0.12);
    }

    // ---- morale / berserk gates -------------------------------------------
    const weakPlayer = T.real ? (T.health + T.shield) * 0.5 < 0.35 : false;
    if (a.type === 'elite') {
      a.berserk = a.health < 0.28 && (a.shield <= 0.01) && (a.awareness >= 1);
      if (weakPlayer && a.health > 0.5) a.berserk = a.berserk || a.rand.next() < 0.02;
    }
    if (a.type === 'grunt' && a.morale < 0.25) a.panic = Math.max(a.panic, 1);

    const engaged = a.awareness >= 1 && T.valid && !ctx.config.aiPassive;
    const dist = T.valid ? a.position.distanceTo(T.position) : 999;

    // ---- state selection (utility over a small, legible set) ---------------
    if (a.panic > 0.35 && a.type !== 'elite') setState(a, 'panic');
    else if (!engaged && a.awareness > 0.35) setState(a, 'alert');
    else if (!engaged) setState(a, a.stateT > 6 && a.state === 'idle' ? 'patrol' : (a.state === 'patrol' ? 'patrol' : 'idle'));
    else if (a.berserk) setState(a, 'berserk');
    else if (a.type === 'elite' && a.shield <= 0.02 && a.health < 0.55 && a.retreatT <= 0) { setState(a, 'retreat'); a.retreatT = 4.0; }
    else if (a.state === 'retreat' && a.retreatT > 0) { /* stay */ }
    else if (dist < a.def.range[0] * 0.7) setState(a, 'reposition');
    else setState(a, 'combat');

    switch (a.state) {
      case 'idle': doIdle(a, dt); break;
      case 'patrol': doPatrol(a, dt); break;
      case 'alert': doAlert(a, dt); break;
      case 'combat': doCombat(a, T, dt, dist); break;
      case 'reposition': doReposition(a, T, dt); break;
      case 'retreat': doRetreat(a, T, dt); break;
      case 'berserk': doBerserk(a, T, dt, dist); break;
      case 'panic': doPanic(a, T, dt); break;
      default: doIdle(a, dt);
    }
  }

  function moveToward(a, x, z, speed) {
    const dx = x - a.position.x, dz = z - a.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) { a.desiredSpeed = 0; return true; }
    a.moveDir = a.moveDir || new THREE.Vector3();
    a.moveDir.set(dx / d, 0, dz / d);
    a.desiredSpeed = Math.min(speed, d * 2.2);
    return false;
  }

  function faceDir(a, x, z) {
    a.desiredYaw = Math.atan2(-x, -z);
  }

  function doIdle(a, dt) {
    a.desiredSpeed = 0;
    if (a.stateT > 3.5 + a.rand.next() * 3) {
      a.desiredYaw = a.yaw + a.rand.sym(1.1);
      a.stateT = 0;
    }
    void dt;
  }

  function doPatrol(a, dt) {
    if (!a.patrolTarget || a.stateT > 9) {
      const ang = a.rand.range(0, Math.PI * 2), r = a.rand.range(2, 7);
      a.patrolTarget = new THREE.Vector3(a.home.x + Math.cos(ang) * r, 0, a.home.z + Math.sin(ang) * r);
      a.stateT = 0;
    }
    const done = moveToward(a, a.patrolTarget.x, a.patrolTarget.z, a.def.walk * 0.7);
    if (!done) faceDir(a, a.moveDir.x, a.moveDir.z);
    else if (a.stateT > 4) setState(a, 'idle');
    void dt;
  }

  function doAlert(a, dt) {
    // move to the last known position, scanning
    const d = Math.hypot(a.lkp.x - a.position.x, a.lkp.z - a.position.z);
    if (a.lkpAge < 9 && d > 2.5) {
      moveToward(a, a.lkp.x, a.lkp.z, a.def.walk);
      faceDir(a, a.moveDir.x, a.moveDir.z);
    } else {
      a.desiredSpeed = 0;
      a.desiredYaw = a.yaw + Math.sin(simTime * 0.9 + a.id) * 0.02;
      if (a.lkpAge > 12) a.awareness = Math.max(0, a.awareness - dt * 0.5);
    }
  }

  function doCombat(a, T, dt, dist) {
    const [near, far] = a.def.range;
    // flank slot: the leader holds centre, the rest fan out around the target
    const sq = squads.get(a.squad);
    let slot = 0;
    if (sq) {
      const idx = sq.members.indexOf(a);
      slot = a.isLeader ? 0 : ((idx % 2 === 0 ? 1 : -1) * (0.35 + 0.22 * Math.floor(idx / 2)));
    }
    const want = clamp((near + far) * 0.5, near, far);
    const toA = _a.subVectors(a.position, T.position);
    toA.y = 0;
    const cur = toA.length() || 1;
    toA.divideScalar(cur);
    const ang = Math.atan2(toA.x, toA.z) + slot * 0.9;
    const gx = T.position.x + Math.sin(ang) * want;
    const gz = T.position.z + Math.cos(ang) * want;

    // strafe oscillation on top of the slot, so they never stand still
    if (a.strafeT <= 0) { a.strafeDir = -a.strafeDir; a.strafeT = a.rand.range(0.9, 2.2); }
    const sx = Math.cos(ang) * a.strafeDir * 1.6, sz = -Math.sin(ang) * a.strafeDir * 1.6;

    // cover scoring, throttled to one actor per frame
    if (a.coverT <= 0 && coverBudgetIdx < 1 && a.lod <= 1) {
      coverBudgetIdx++;
      a.cover = findCover(a, T, want);
      a.coverT = a.rand.range(2.4, 4.5);
    }

    let tx = gx + sx, tz = gz + sz;
    if (a.cover && a.health < 0.75) { tx = a.cover.x; tz = a.cover.z; }

    const err = Math.hypot(tx - a.position.x, tz - a.position.z);
    if (err > 1.1) { moveToward(a, tx, tz, dist > far ? a.def.run : a.def.walk); }
    else a.desiredSpeed = 0;

    faceDir(a, T.position.x - a.position.x, T.position.z - a.position.z);
    aimAt(a, T, dt);
    tryFire(a, T, dist, dt);
    tryGrenade(a, T, dist);
  }

  function doReposition(a, T, dt) {
    // too close: back off while still facing the target
    _a.subVectors(a.position, T.position); _a.y = 0;
    if (_a.lengthSq() < 1e-4) _a.set(1, 0, 0);
    _a.normalize();
    moveToward(a, a.position.x + _a.x * 4, a.position.z + _a.z * 4, a.def.walk);
    faceDir(a, T.position.x - a.position.x, T.position.z - a.position.z);
    aimAt(a, T, dt);
    tryFire(a, T, a.position.distanceTo(T.position), dt);
  }

  function doRetreat(a, T, dt) {
    // break line of sight and let the shield come back
    _a.subVectors(a.position, T.position); _a.y = 0; _a.normalize();
    const tx = a.position.x + _a.x * 7 + Math.sin(a.id) * 2;
    const tz = a.position.z + _a.z * 7 + Math.cos(a.id) * 2;
    moveToward(a, tx, tz, a.def.run);
    faceDir(a, a.moveDir ? a.moveDir.x : _a.x, a.moveDir ? a.moveDir.z : _a.z);
    a.aimPitch = damp(a.aimPitch, 0, 4, dt);
    if (a.shield > 0.7) a.retreatT = 0;
  }

  function doBerserk(a, T, dt, dist) {
    moveToward(a, T.position.x, T.position.z, a.def.run * 1.12);
    faceDir(a, T.position.x - a.position.x, T.position.z - a.position.z);
    aimAt(a, T, dt);
    if (dist > 3.2) tryFire(a, T, dist, dt);
    else if (a.fireT <= 0) {
      a.fireT = 1.05;
      a.meleeSwing = 1;
      if (dist < 2.6) hurtPlayer(26, _a.subVectors(T.position, a.position).normalize());
      ctx.get('audio')?.play?.('elite_melee', { position: a.position.clone() });
    }
  }

  function doPanic(a, T, dt) {
    // flee directly away, no aiming, arms up
    _a.subVectors(a.position, T.valid ? T.position : a.home); _a.y = 0;
    if (_a.lengthSq() < 1e-4) _a.set(1, 0, 0);
    _a.normalize();
    const wob = Math.sin(simTime * 5.5 + a.id) * 0.55;
    const tx = a.position.x + _a.x * 8 + wob, tz = a.position.z + _a.z * 8 - wob;
    moveToward(a, tx, tz, a.def.run * 1.05);
    if (a.moveDir) faceDir(a, a.moveDir.x, a.moveDir.z);
    a.aimPitch = damp(a.aimPitch, -0.15, 5, dt);
    if (a.stateT > 7) a.panic *= 0.6;
  }

  /** Ring-sampled cover scoring: blocked LOS to the target beats everything else. */
  function findCover(a, T, want) {
    const p = physicsMod();
    if (!p) return null;
    let best = null, bs = -Infinity;
    const eyeY = a.def.eye * 0.8;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + a.id * 0.37;
      for (const r of [2.6, 5.4]) {
        const x = a.position.x + Math.cos(ang) * r;
        const z = a.position.z + Math.sin(ang) * r;
        const y = groundAt(x, z);
        _a.set(x, y + eyeY, z);
        _b.subVectors(T.eye, _a);
        const d = _b.length();
        _b.divideScalar(Math.max(d, 1e-4));
        const hit = worldRay(_a, _b, d - 0.4);
        const blocked = hit ? 1 : 0;
        const distErr = Math.abs(_a.distanceTo(T.position) - want);
        let s = blocked * 6 - distErr * 0.35 - r * 0.08;
        for (const m of actors) if (m !== a && m.alive && m.position.distanceToSquared(_a) < 4) s -= 2.5;
        if (s > bs) { bs = s; best = new THREE.Vector3(x, y, z); }
      }
    }
    return bs > 0.5 ? best : null;
  }

  /* ------------------------------------------------------------------ firing */

  function aimAt(a, T, dt) {
    const muz = muzzleWorld(a, _a);
    const speed = a.def.boltSpeed;
    const d = muz.distanceTo(T.eye);
    const lead = d / speed;
    _b.copy(T.eye).addScaledVector(T.velocity, lead);
    _b.y -= 0.25;                                  // aim centre-mass, not the eye
    _c.subVectors(_b, muz);
    const horiz = Math.hypot(_c.x, _c.z);
    const wantYaw = Math.atan2(-_c.x, -_c.z);
    const wantPitch = Math.atan2(_c.y, horiz);
    a.aimYaw = angWrap(a.aimYaw + angWrap(wantYaw - a.yaw - a.aimYaw) * Math.min(1, dt * 9));
    a.aimPitch = damp(a.aimPitch, clamp(wantPitch, -0.9, 0.9), 8, dt);
    a.aimTarget = a.aimTarget || new THREE.Vector3();
    a.aimTarget.copy(_b);
  }

  function muzzleWorld(a, out) {
    const i = a.bi.handR;
    if (i !== undefined && a.wp[i]) {
      return out.copy(a.muzzleLocal).applyQuaternion(a.wq[i]).add(a.wp[i]);
    }
    const s = Math.sin(a.yaw), c = Math.cos(a.yaw);
    return out.set(a.position.x - s * 0.45 + c * 0.2, a.position.y + a.def.eye - 0.12, a.position.z - c * 0.45 - s * 0.2);
  }

  function tryFire(a, T, dist, dt) {
    void dt;
    if (ctx.config.aiPassive) return;
    if (a.reactT > 0) return;
    if (!a.canSee && a.lkpAge > 1.2) return;
    if (dist > a.def.range[1] * 1.35) return;
    if (a.reloadT > 0 || a.fireT > 0) return;

    if (a.burstLeft <= 0) {
      a.burstLeft = a.rand.int(a.def.burst[0], a.def.burst[1]);
      a.reloadT = a.rand.range(0.5, 1.4) * (a.type === 'elite' ? 0.7 : 1.0);
      return;
    }

    a.burstLeft--;
    a.fireT = 1 / a.def.rof;
    a.muzzleFlash = 1;

    const muz = muzzleWorld(a, _a).clone();
    const aim = a.aimTarget || T.eye;
    _b.subVectors(aim, muz).normalize();

    // accuracy: a cone that widens with distance, panic and recent damage
    const acc = clamp(a.def.accuracy * (a.berserk ? 0.75 : 1) * (1 - a.panic * 0.5), 0.05, 1);
    const spread = (1 - acc) * 0.085 + clamp(dist / 90, 0, 1) * 0.02;
    _b.x += a.rand.sym(spread); _b.y += a.rand.sym(spread * 0.8); _b.z += a.rand.sym(spread);
    _b.normalize();

    bolts.spawn(muz, _b.clone().multiplyScalar(a.def.boltSpeed), {
      color: a.def.boltColor, damage: a.def.boltDamage, owner: a,
      life: 3.0, radius: a.type === 'elite' ? 0.055 : 0.048, len: 0.5,
    });

    ctx.emit('weapon:fired', {
      weapon: a.type === 'grunt' ? 'plasma_pistol' : a.type === 'elite' ? 'plasma_rifle' : 'plasma_pistol',
      origin: muz.clone(), direction: _b.clone(), actor: a, faction: FACTION.COVENANT,
    });
    ctx.get('audio')?.play?.('plasma_fire', { position: muz.clone(), pitch: a.type === 'elite' ? 1 : 1.25 });

    // player hit test — the bolt system only collides with the world
    if (T.valid) {
      const toP = _c.subVectors(T.position, muz);
      const along = toP.dot(_b);
      if (along > 0 && along < 90) {
        const perp = toP.addScaledVector(_b, -along).length();
        if (perp < 0.45) {
          const tof = along / a.def.boltSpeed;
          scheduleHit(a, tof, a.def.boltDamage, _b.clone());
        }
      }
    }
  }

  const pendingHits = [];
  function scheduleHit(a, delay, dmg, dir) { pendingHits.push({ t: simTime + delay, dmg, dir, a }); }
  function flushHits() {
    for (let i = pendingHits.length - 1; i >= 0; i--) {
      if (pendingHits[i].t <= simTime) { hurtPlayer(pendingHits[i].dmg, pendingHits[i].dir); pendingHits.splice(i, 1); }
    }
  }

  /** Ballistic solve with the same gravity physics uses, low arc preferred. */
  function tryGrenade(a, T, dist) {
    if (a.grenadeT > 0 || a.type === 'jackal') return;
    if (dist < 7 || dist > 26 || !a.canSee) return;
    if (a.rand.next() > 0.35) { a.grenadeT = a.rand.range(3, 7); return; }
    a.grenadeT = a.rand.range(11, 20);

    const from = muzzleWorld(a, _a).clone();
    _b.copy(T.position).addScaledVector(T.velocity, 0.8).sub(from);
    const gy = _b.y;
    const gx = Math.hypot(_b.x, _b.z);
    const g = -GRAVITY;
    const v = clamp(Math.sqrt(g * gx / Math.sin(2 * (45 * DEG))) * 1.06, 8, 26);
    const disc = v * v * v * v - g * (g * gx * gx + 2 * gy * v * v);
    if (disc < 0) return;
    const ang = Math.atan2(v * v - Math.sqrt(disc), g * gx);
    const dirH = _c.set(_b.x / (gx || 1), 0, _b.z / (gx || 1));
    const vel = new THREE.Vector3(dirH.x * Math.cos(ang) * v, Math.sin(ang) * v, dirH.z * Math.cos(ang) * v);

    bolts.spawn(from, vel, {
      color: PAL.glowCyan, damage: 58, owner: a, life: 4.2, radius: 0.09,
      grav: 1, grenade: true, fuse: 2.4,
    });
    ctx.emit('weapon:fired', { weapon: 'plasma_grenade', origin: from.clone(), direction: vel.clone().normalize(), actor: a, faction: FACTION.COVENANT });
  }

  /* --------------------------------------------------------------- locomotion */

  function locomote(a, dt) {
    const want = a.desiredSpeed || 0;
    const dir = a.moveDir;
    const accel = want > a.speed ? 9 : 13;
    a.speed = damp(a.speed, want, accel, dt);
    if (a.speed > 0.02 && dir) {
      a.velocity.set(dir.x * a.speed, 0, dir.z * a.speed);
      const nx = a.position.x + a.velocity.x * dt;
      const nz = a.position.z + a.velocity.z * dt;
      // separation from squadmates so they never stack
      let px = 0, pz = 0;
      for (const m of actors) {
        if (m === a || !m.alive) continue;
        const dx = nx - m.position.x, dz = nz - m.position.z;
        const d2 = dx * dx + dz * dz;
        const rr = (a.def.radius + m.def.radius) * 1.15;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          px += (dx / d) * (rr - d) * 0.6; pz += (dz / d) * (rr - d) * 0.6;
        }
      }
      a.position.x = nx + px;
      a.position.z = nz + pz;
    } else {
      a.velocity.multiplyScalar(Math.max(0, 1 - dt * 8));
    }
    a.position.y = damp(a.position.y, groundAt(a.position.x, a.position.z), 12, dt);

    // yaw: turn toward desired, faster when moving
    const rate = (a.state === 'panic' || a.berserk ? 7 : 4.5) + a.speed * 0.8;
    a.yaw += angWrap(a.desiredYaw - a.yaw) * Math.min(1, dt * rate);
    a.yaw = angWrap(a.yaw);
    // desiredSpeed intentionally persists: behaviour runs on an LOD stride and the
    // actor must keep walking on the frames in between.
  }

  /* ---------------------------------------------------------------- animation */

  /** Forward kinematics for one bone, parent-first. */
  function fk(a, i) {
    const b = a.rig.bones[i], p = a.rig.parentIdx[i];
    if (p < 0) {
      a.wq[i].copy(a.rootQ).multiply(b.quaternion);
      a.wp[i].copy(b.position).applyQuaternion(a.rootQ).add(a.group.position);
    } else {
      a.wq[i].copy(a.wq[p]).multiply(b.quaternion);
      a.wp[i].copy(b.position).applyQuaternion(a.wq[p]).add(a.wp[p]);
    }
  }

  /** Aim a bone's rest axis at a world direction, with optional axial twist. */
  function aimBone(a, i, worldDir, twist) {
    const b = a.rig.bones[i], p = a.rig.parentIdx[i];
    const rest = b.userData.rest || (b.userData.rest = restDir(a, i));
    _q.copy(p < 0 ? a.rootQ : a.wq[p]).invert();
    _d.copy(worldDir).normalize().applyQuaternion(_q);
    b.quaternion.setFromUnitVectors(rest, _d);
    if (twist) b.quaternion.multiply(_q2.setFromAxisAngle(rest, twist));
    fk(a, i);
  }

  function restDir(a, i) {
    const b = a.rig.bones[i];
    const child = b.children.find((c) => c.isBone);
    const v = child ? child.position.clone() : new THREE.Vector3(0, -1, 0);
    if (v.lengthSq() < 1e-9) v.set(0, -1, 0);
    return v.normalize();
  }

  /** Analytic two-bone IK. Returns the joint position in `out`. */
  function ik2(hip, target, l1, l2, pole, out) {
    _a.subVectors(target, hip);
    let d = _a.length();
    const maxD = (l1 + l2) * 0.998, minD = Math.abs(l1 - l2) + 1e-3;
    d = clamp(d, minD, maxD);
    _a.normalize();
    const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
    _b.copy(pole).addScaledVector(_a, -pole.dot(_a));
    if (_b.lengthSq() < 1e-8) _b.set(0, 0, 1).addScaledVector(_a, -_a.z);
    _b.normalize();
    out.copy(hip).addScaledVector(_a, x).addScaledVector(_b, h);
    return out;
  }

  const _foot = new THREE.Vector3(), _knee = new THREE.Vector3(), _ankle = new THREE.Vector3();

  function poseActor(a, dt, t) {
    if (!a.alive) return;
    if (a.lod >= 3) { a.group.position.copy(a.position); a.group.rotation.y = a.yaw; return; }

    const rig = a.rig, bi = a.bi;
    a.group.position.copy(a.position);
    a.group.rotation.set(0, a.yaw, 0);
    a.rootQ = a.rootQ || new THREE.Quaternion();
    a.rootQ.setFromAxisAngle(_up, a.yaw);

    const def = a.def;
    const spd = a.speed;
    const cycleLen = def.stride * 2;
    a.gaitPhase = (a.gaitPhase + (spd > 0.06 ? (spd / cycleLen) * dt : 0)) % 1;
    if (a.gaitPhase < 0) a.gaitPhase += 1;

    // flinch spring (hit reactions)
    const k = 90, c2 = 13;
    a.flinchV.addScaledVector(a.flinch, -k * dt).multiplyScalar(Math.max(0, 1 - c2 * dt));
    a.flinch.addScaledVector(a.flinchV, dt);
    a.flinch.clampScalar(-0.6, 0.6);

    a.breath += dt * (1.5 + spd * 0.5);
    const breathe = Math.sin(a.breath) * 0.012;

    // ---- pelvis ------------------------------------------------------------
    const moving = spd > 0.06;
    const ph = a.gaitPhase * Math.PI * 2;
    const bob = moving ? -Math.abs(Math.sin(ph)) * 0.035 * (0.5 + spd / def.run) : breathe;
    const sway = moving ? Math.sin(ph) * 0.035 * def.waddle : 0;
    const roll = moving ? Math.sin(ph) * 0.10 * def.waddle : 0;
    const lean = clamp(spd / def.run, 0, 1) * (a.state === 'panic' ? 0.30 : 0.16);
    a.lean = damp(a.lean, lean, 6, dt);

    const pelvis = rig.bones[bi.pelvis];
    const groundY = groundAt(a.position.x, a.position.z);
    pelvis.position.set(sway, def.hip + bob + (groundY - a.position.y), 0);
    setEuler(pelvis, -a.lean * 0.5 + a.flinch.x * 0.35, 0, roll + a.flinch.z * 0.3);
    fk(a, bi.pelvis);

    // ---- spine chain + additive aim ---------------------------------------
    // Sign convention: a NEGATIVE X rotation leans a bone forward (toward -Z, the
    // facing direction); a POSITIVE X rotation on the head looks up.
    const aimY = clamp(a.aimYaw, -1.25, 1.25);
    const aimP = clamp(a.aimPitch, -0.9, 0.9);
    const posture = def.hunch ?? -0.12;
    const chainW = [[bi.spine, 0.16, posture * 0.35], [bi.chest, 0.26, posture * 0.5], [bi.neck, 0.20, posture * 0.15]];
    for (const [idx, w, base] of chainW) {
      if (idx === undefined) continue;
      setEuler(rig.bones[idx],
        base + aimP * w * 0.55 + a.flinch.x * w * 0.9 + (moving ? Math.sin(ph * 2) * 0.012 : breathe * 0.4),
        aimY * w, a.flinch.z * w * 0.7 + (moving ? -Math.sin(ph) * 0.02 : 0));
      fk(a, idx);
    }
    if (bi.head !== undefined) {
      const scan = (a.state === 'idle' || a.state === 'patrol') ? Math.sin(t * 0.55 + a.id) * 0.30 : 0;
      setEuler(rig.bones[bi.head],
        -posture * 0.60 + aimP * 0.42 + a.flinch.x * 0.9,
        aimY * 0.40 + scan, a.flinch.y * 0.5);
      fk(a, bi.head);
    }
    // Elite mandibles: flare when berserk or roaring
    if (bi.jawUL !== undefined) {
      const open = a.berserk ? 0.55 : (a.state === 'combat' ? 0.10 + Math.sin(t * 2.1 + a.id) * 0.06 : 0.05);
      for (const [n, sx, sy] of [['jawUL', 1, 1], ['jawUR', -1, 1], ['jawLL', 1, -1], ['jawLR', -1, -1]]) {
        setEuler(rig.bones[bi[n]], sy * open * 0.7, sx * open * 0.9, 0);
        fk(a, bi[n]);
      }
    }

    // ---- arms: weapon hand tracks the aim, support hand braces -------------
    poseArms(a, aimP, aimY, dt, t);

    // ---- legs --------------------------------------------------------------
    poseLegs(a, dt, spd, moving, ph);

    // remaining bones (tank, toes, clavicles already handled) keep bind pose
    if (bi.tank !== undefined) fk(a, bi.tank);
  }

  function poseArms(a, aimP, aimY, dt, t) {
    const rig = a.rig, bi = a.bi;
    const gunUp = a.state === 'combat' || a.state === 'reposition' || a.state === 'berserk' || a.awareness > 0.6;
    const panic = a.state === 'panic';
    const swing = a.speed > 0.08 ? Math.sin(a.gaitPhase * Math.PI * 2) * clamp(a.speed / a.def.run, 0, 1) * 0.55 : 0;

    for (const side of [1, -1]) {
      const S = side > 0 ? 'L' : 'R';
      const clav = bi['clav' + S], uarm = bi['uarm' + S], farm = bi['farm' + S], hand = bi['hand' + S];
      if (uarm === undefined) continue;
      if (clav !== undefined) {
        setEuler(rig.bones[clav], a.flinch.x * 0.25, 0, side * (gunUp ? -0.06 : 0));
        fk(a, clav);
      }
      // Arms hang along -Y in bind, so +X rotation swings them forward and up.
      const weaponSide = side < 0;   // right hand carries the gun
      let ex, ey, ez;
      if (panic) {
        ex = 2.55 + Math.sin(t * 9 + a.id + side) * 0.30; ey = 0; ez = side * -0.55;
      } else if (weaponSide && gunUp) {
        ex = 0.66 + aimP * 0.80 + a.flinch.x * 0.5;
        ey = aimY * 0.30;
        ez = 0.14;
      } else if (!weaponSide && gunUp) {
        ex = 0.60 + aimP * 0.72; ey = -aimY * 0.12; ez = -0.50;
      } else {
        ex = swing * (weaponSide ? -1 : 1) * 0.9 + 0.10;
        ey = 0; ez = side * -0.16;
      }
      setEuler(rig.bones[uarm], ex, ey, ez);
      fk(a, uarm);
      if (farm !== undefined) {
        const bend = panic ? 0.85 : gunUp ? (weaponSide ? 0.62 : 1.05) : 0.32 + Math.abs(swing) * 0.4;
        setEuler(rig.bones[farm], bend, 0, weaponSide ? -0.18 : 0.28);
        fk(a, farm);
      }
      if (hand !== undefined) {
        setEuler(rig.bones[hand], gunUp ? 0.18 : 0, 0, 0);
        fk(a, hand);
      }
    }
    void dt;
  }

  function poseLegs(a, dt, spd, moving, ph) {
    const rig = a.rig, bi = a.bi, def = a.def;
    const fwdX = -Math.sin(a.yaw), fwdZ = -Math.cos(a.yaw);
    const rgtX = Math.cos(a.yaw), rgtZ = -Math.sin(a.yaw);
    const stride = def.stride * (0.55 + 0.55 * clamp(spd / def.run, 0, 1));
    const STANCE = 0.58;

    for (const leg of a.legs) {
      const lp = (a.gaitPhase + leg.phase) % 1;
      const lateral = leg.side * def.hipWidth;

      // predicted plant: half a stride ahead, on the ground
      const px = a.position.x + fwdX * stride * 0.55 + rgtX * lateral + a.velocity.x * 0.12;
      const pz = a.position.z + fwdZ * stride * 0.55 + rgtZ * lateral + a.velocity.z * 0.12;

      if (!moving) {
        // settle to a neutral stance under the hips
        neutralFoot(a, leg, _a);
        _a.x += fwdX * leg.side * 0.03; _a.z += fwdZ * leg.side * 0.03;
        leg.plant.lerp(_a, Math.min(1, dt * 8));
        _foot.copy(leg.plant);
        leg.swinging = false;
      } else if (lp < STANCE) {
        if (leg.swinging) { leg.swinging = false; leg.plant.copy(leg.target); }
        // a plant more than a stride from the hips is stale: re-seat it
        if (leg.plant.distanceToSquared(a.position) > 9) leg.plant.set(px, groundAt(px, pz), pz);
        _foot.copy(leg.plant);
      } else {
        if (!leg.swinging) { leg.swinging = true; leg.from.copy(leg.plant); }
        leg.target.set(px, groundAt(px, pz), pz);
        const s = smooth((lp - STANCE) / (1 - STANCE));
        _foot.lerpVectors(leg.from, leg.target, s);
        _foot.y += Math.sin(s * Math.PI) * (0.09 + 0.10 * clamp(spd / def.run, 0, 1));
      }

      // ankle from the toe contact point
      const hip = a.wp[leg.thigh];
      _ankle.set(_foot.x - fwdX * leg.ankleBack, _foot.y + leg.ankleUp, _foot.z - fwdZ * leg.ankleBack);

      _e.set(fwdX, 0.35, fwdZ).normalize();     // knee pole: forward
      ik2(hip, _ankle, leg.l1, leg.l2, _e, _knee);

      aimBone(a, leg.thigh, _d.subVectors(_knee, hip));
      aimBone(a, leg.shin, _d.subVectors(_ankle, _knee));

      if (leg.digit) {
        aimBone(a, leg.meta, _d.subVectors(_foot, _ankle));
        if (leg.foot !== undefined && leg.foot >= 0) {
          setEuler(rig.bones[leg.foot], 0.45, 0, 0);
          fk(a, leg.foot);
        }
      } else if (leg.foot >= 0) {
        // plantigrade: keep the sole level with the ground
        aimBone(a, leg.foot, _d.set(fwdX * 0.35, -1, fwdZ * 0.35).normalize());
      }
    }
    void ph;
  }

  /* ------------------------------------------------------------------ ragdoll */

  function startRagdoll(a, impulse) {
    const def = a.def;
    const pts = [];
    const P = (up, fwd) => new THREE.Vector3(
      a.position.x - Math.sin(a.yaw) * fwd, a.position.y + up, a.position.z - Math.cos(a.yaw) * fwd);
    const h = def.height;
    pts.push({ p: P(h * 0.48, 0), o: null, r: 0.22 });                      // 0 pelvis
    pts.push({ p: P(h * 0.72, -0.02), o: null, r: 0.20 });                  // 1 chest
    pts.push({ p: P(h * 0.93, -0.04), o: null, r: 0.16 });                  // 2 head
    pts.push({ p: P(h * 0.62, -0.10), o: null, r: 0.10 });                  // 3 handL
    pts.push({ p: P(h * 0.62, -0.10), o: null, r: 0.10 });                  // 4 handR
    pts.push({ p: P(0.06, 0.06), o: null, r: 0.10 });                       // 5 footL
    pts.push({ p: P(0.06, -0.06), o: null, r: 0.10 });                      // 6 footR
    pts[3].p.x += Math.cos(a.yaw) * 0.32; pts[3].p.z -= Math.sin(a.yaw) * 0.32;
    pts[4].p.x -= Math.cos(a.yaw) * 0.32; pts[4].p.z += Math.sin(a.yaw) * 0.32;
    pts[5].p.x += Math.cos(a.yaw) * def.hipWidth; pts[5].p.z -= Math.sin(a.yaw) * def.hipWidth;
    pts[6].p.x -= Math.cos(a.yaw) * def.hipWidth; pts[6].p.z += Math.sin(a.yaw) * def.hipWidth;
    for (const pt of pts) { pt.o = pt.p.clone().addScaledVector(impulse, -1 / 60); }

    const links = [[0, 1], [1, 2], [1, 3], [1, 4], [0, 5], [0, 6], [0, 2], [5, 6], [3, 4]];
    const rest = links.map(([i, j]) => pts[i].p.distanceTo(pts[j].p));

    const phys = ctx.get('physics');
    let body = null;
    if (phys && typeof phys.addBody === 'function') {
      body = phys.addBody({
        position: pts[0].p.clone(),
        velocity: impulse.clone(),
        radius: 0.28, mass: def.mass, restitution: 0.12, friction: 0.9, drag: 0.06,
        mask: phys.MASK ? phys.MASK.DEBRIS : 8, life: Infinity,
      });
    }
    a.body = body;
    a.ragdoll = { pts, links, rest, settled: 0, t: 0, vel: impulse.clone() };
    a.ragdollSpin = new THREE.Vector3(a.rand.sym(3), a.rand.sym(2), a.rand.sym(3));
  }

  function updateRagdoll(a, dt) {
    const rd = a.ragdoll;
    if (!rd) return;
    if (rd.settled > 1.6) return;
    rd.t += dt;
    a.hitFlash = Math.max(0, a.hitFlash - dt * 3);

    const pts = rd.pts;
    // core: physics body if we have one, else integrate it here
    if (a.body) {
      pts[0].o.copy(pts[0].p);
      pts[0].p.copy(a.body.position);
      if (a.body.sleeping) rd.settled += dt;
    } else {
      const v = _a.copy(pts[0].p).sub(pts[0].o);
      pts[0].o.copy(pts[0].p);
      v.y += GRAVITY * dt * dt;
      pts[0].p.add(v.multiplyScalar(0.985));
    }

    // methane rupture: a jet that shoves the corpse for the first second
    if (a.tankRupture > 0 && rd.t < 1.1) {
      const push = _b.set(-Math.sin(a.yaw), 0.55, -Math.cos(a.yaw)).multiplyScalar(dt * 26 * (1 - rd.t / 1.1));
      if (a.body) a.body.velocity.add(push); else pts[0].p.add(push.multiplyScalar(dt));
    }

    for (let i = 1; i < pts.length; i++) {
      const pt = pts[i];
      _a.copy(pt.p).sub(pt.o).multiplyScalar(0.978);
      pt.o.copy(pt.p);
      _a.y += GRAVITY * dt * dt;
      pt.p.add(_a);
    }
    for (let it = 0; it < 4; it++) {
      for (let li = 0; li < rd.links.length; li++) {
        const [i, j] = rd.links[li];
        const A = pts[i], Bp = pts[j];
        _a.subVectors(Bp.p, A.p);
        const d = _a.length() || 1e-5;
        const diff = (d - rd.rest[li]) / d * 0.5;
        const wi = i === 0 ? 0 : 1, wj = j === 0 ? 0 : 1;
        const wsum = wi + wj || 1;
        if (wi) A.p.addScaledVector(_a, diff * (wi / wsum) * 2 * (wj ? 0.5 : 1));
        if (wj) Bp.p.addScaledVector(_a, -diff * (wj / wsum) * 2 * (wi ? 0.5 : 1));
      }
      for (let i = 1; i < pts.length; i++) {
        const g = groundAt(pts[i].p.x, pts[i].p.z) + pts[i].r;
        if (pts[i].p.y < g) {
          pts[i].p.y = g;
          pts[i].o.x += (pts[i].p.x - pts[i].o.x) * 0.4;      // friction
          pts[i].o.z += (pts[i].p.z - pts[i].o.z) * 0.4;
        }
      }
    }

    let motion = 0;
    for (const pt of pts) motion += pt.p.distanceToSquared(pt.o);
    if (motion < 1e-6) rd.settled += dt; else rd.settled = Math.max(0, rd.settled - dt * 0.5);

    // drive the skeleton from the particles
    a.position.copy(pts[0].p);
    a.position.y -= a.def.height * 0.48;
    a.group.position.copy(pts[0].p);
    a.group.position.y -= a.def.hip;
    a.group.rotation.set(0, a.yaw, 0);
    a.rootQ = a.rootQ || new THREE.Quaternion();
    a.rootQ.setFromAxisAngle(_up, a.yaw);

    const rig = a.rig, bi = a.bi;
    const pel = rig.bones[bi.pelvis];
    pel.position.set(0, a.def.hip, 0);
    _d.subVectors(pts[1].p, pts[0].p).normalize();
    _q.setFromUnitVectors(_up, _d);
    _q2.copy(a.rootQ).invert();
    pel.quaternion.copy(_q2).multiply(_q);
    fk(a, bi.pelvis);

    if (bi.spine !== undefined) { aimBone(a, bi.spine, _d.subVectors(pts[2].p, pts[1].p)); }
    if (bi.chest !== undefined) { aimBone(a, bi.chest, _d.subVectors(pts[2].p, pts[1].p)); }
    if (bi.neck !== undefined) { aimBone(a, bi.neck, _d.subVectors(pts[2].p, pts[1].p)); }
    if (bi.head !== undefined) { rig.bones[bi.head].quaternion.identity(); fk(a, bi.head); }
    for (const [S, hp] of [['L', 3], ['R', 4]]) {
      const cl = bi['clav' + S], ua = bi['uarm' + S], fa = bi['farm' + S], hd = bi['hand' + S];
      if (cl !== undefined) { rig.bones[cl].quaternion.identity(); fk(a, cl); }
      if (ua !== undefined) {
        aimBone(a, ua, _d.subVectors(pts[hp].p, a.wp[ua]));
        if (fa !== undefined) { aimBone(a, fa, _d.subVectors(pts[hp].p, a.wp[fa])); }
        if (hd !== undefined) { rig.bones[hd].quaternion.identity(); fk(a, hd); }
      }
    }
    for (const [leg, fp] of [[a.legs[0], 5], [a.legs[1], 6]]) {
      const hip = a.wp[leg.thigh];
      _e.set(-Math.sin(a.yaw), 0.3, -Math.cos(a.yaw)).normalize();
      ik2(hip, pts[fp].p, leg.l1, leg.l2, _e, _knee);
      aimBone(a, leg.thigh, _d.subVectors(_knee, hip));
      aimBone(a, leg.shin, _d.subVectors(pts[fp].p, _knee));
      if (leg.digit && leg.meta >= 0) aimBone(a, leg.meta, _d.set(0, -1, 0));
    }

    if (rd.settled > 1.6 && a.body) {
      const phys = ctx.get('physics');
      phys?.removeBody?.(a.body.id);
      a.body = null;
    }
  }

  /* --------------------------------------------------------------------- fx */

  function updateFx(a, dt) {
    a.hitFlash = Math.max(0, a.hitFlash - dt * 4.5);
    a.muzzleFlash = Math.max(0, a.muzzleFlash - dt * 14);
    a.shieldFlash = Math.max(0, a.shieldFlash - dt * 3.2);
    a.glowPulse += dt;

    const u = a.material.userData.aiUniforms;
    if (u) {
      u.uHitFlash.value = a.hitFlash;
      u.uMuzzle.value = a.muzzleFlash;
      u.uGlow.value = 0.85 + Math.sin(a.glowPulse * 1.7 + a.id) * 0.10 + (a.panic > 0.3 ? 0.5 : 0);
      const s = a.shield;
      u.uShieldTint.value.setRGB(0.02 * s * a.shieldFlash, 0.06 * s * a.shieldFlash, 0.10 * s * a.shieldFlash);
    }

    const sm = a.shieldMesh;
    if (sm) {
      for (const im of a.impacts) im.t += dt * 1.6;
      while (a.impacts.length && a.impacts[0].t > 1) a.impacts.shift();
      const vis = a.alive && (a.shieldFlash > 0.02 || a.impacts.length > 0);
      sm.visible = vis;
      if (vis) {
        sm.material.uniforms.uFlash.value = Math.min(1.4, a.shieldFlash) * (0.35 + a.shield * 0.9);
        sm.material.uniforms.uBreak.value = a.shield <= 0.001 ? Math.max(0, a.shieldFlash - 1.0) : 0;
        const arr = sm.material.uniforms.uImpacts.value;
        for (let i = 0; i < 3; i++) {
          const im = a.impacts[i];
          if (im) arr[i].set(im.p.x, im.p.y, im.p.z, 1 - im.t);
          else arr[i].set(0, 0, 0, 0);
        }
      }
    }
  }

  return api;
}
