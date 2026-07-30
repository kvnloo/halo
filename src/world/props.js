import * as THREE from 'three';
import { applyWorldMaterial } from '../gfx/materialCommon.js';
import { patchForGBuffer, MAT_ID } from '../gfx/GBufferMaterial.js';
import { LAYER } from '../render/RenderPipeline.js';
import { SURFACE_GLSL } from '../gfx/glsl/noise.js';
import { gradNoise2, valueNoise2 } from '../core/Rand.js';

/**
 * `props` — debris, wreckage and small set dressing.
 *
 * The reference frames are dense with incidental objects, and their absence is a large
 * part of why an empty procedural beach reads as procedural. What lives here:
 *
 *   cobble / rubble beds   the biggest single contributor. kf_01500's foreground is a
 *                          continuous bed of dark wet cobbles half-buried in sand, and
 *                          that is most of the `sand` region's 521 lap_var / 0.120
 *                          edge_density.
 *   beach litter           driftwood and bleached branches above the swash line, kelp
 *                          mats *in* it, shells, and small crabs on the tide-pool shelf.
 *   Forerunner alloy       broken panels sanded over, pooling under the bridge tip.
 *   pickups                three MA5B mags and a plasma pistol on the sand.
 *   a Pelican              distant, slow, well silhouetted. One draw call, high value.
 *
 * ## Two engine details this file has to work around
 *
 * **LOD is done on the CPU, by rewriting `instanceMatrix`** — not by scaling in the
 * vertex shader. The G-buffer pre-pass draws this geometry through
 * `scene.overrideMaterial`, so any vertex displacement the lit material applied and the
 * override did not would z-fight against the pre-pass depth (see the warning in
 * `src/gfx/GBufferMaterial.js`). `instanceMatrix` is consumed identically by both.
 *
 * **Surface authoring is injected before `<lights_physical_fragment>`, not at
 * `applyWorldMaterial`'s `inject.fragment` hook.** In three r0.185 the chunk order is
 * `... roughnessmap_fragment, metalnessmap_fragment, normal_fragment_begin,
 * lights_physical_fragment, lights_fragment_begin ...` — `lights_physical_fragment` is
 * what freezes `diffuseColor` / `roughnessFactor` / `metalnessFactor` into the
 * `PhysicalMaterial` struct, and nothing downstream of it reads `diffuseColor.rgb`
 * again (`opaque_fragment` uses only `diffuseColor.a`). So the documented hook, one
 * chunk later, can still change emissive but silently cannot change albedo or
 * roughness. This module chains its own `onBeforeCompile` ahead of
 * `applyWorldMaterial`'s (which calls the previous handler first) and injects at the
 * earlier point. See the report — this affects every module using that hook.
 */

/* ========================================================== small geometry kit */

/** Concatenate a list of {geo, mat} into one non-indexed pos/normal/uv buffer. */
function mergeGeos(parts) {
  const tmp = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.mat) g.applyMatrix4(p.mat);
    tmp.push(g);
  }
  let n = 0;
  for (const g of tmp) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of tmp) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += c;
    g.dispose();
  }
  for (const p of parts) p.geo.dispose?.();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

const _e = new THREE.Euler();
const _tq = new THREE.Quaternion();
const _tv = new THREE.Vector3();
const _tv2 = new THREE.Vector3();
function trs(px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(
    _tv.set(px, py, pz),
    _tq.setFromEuler(_e.set(rx, ry, rz)),
    _tv2.set(sx, sy, sz));
}

/**
 * Smooth deterministic 3D lump field: a sum of plane waves with random directions.
 * Better behaved than displacing in UV space, which seams at the poles of a sphere.
 */
function lumpField(rand, n, ampLo, ampHi, freqLo, freqHi) {
  const w = [];
  for (let i = 0; i < n; i++) {
    const [dx, dy, dz] = rand.onSphere();
    w.push([dx, dy, dz, rand.range(freqLo, freqHi), rand.range(0, Math.PI * 2), rand.range(ampLo, ampHi)]);
  }
  return (x, y, z) => {
    let s = 0;
    for (let i = 0; i < w.length; i++) {
      const t = w[i];
      s += t[5] * Math.sin((x * t[0] + y * t[1] + z * t[2]) * t[3] + t[4]);
    }
    return s;
  };
}

/**
 * An irregular stone. `cuts` slices flat faces off it, which is what separates a
 * water-worn cobble (0 cuts, rounded) from broken talus rubble (3-5 cuts, angular).
 */
function makeStone(rand, { detail = 1, lumps = 7, amp = 0.20, cuts = 0, flatten = 1, faceted = false } = {}) {
  const src = new THREE.IcosahedronGeometry(1, detail);
  const g = src.index ? src.toNonIndexed() : src;
  const f = lumpField(rand, lumps, amp * 0.35, amp, 0.9, 3.4);
  const planes = [];
  for (let i = 0; i < cuts; i++) {
    const [nx, ny, nz] = rand.onSphere();
    // shallow cuts: deeper ones turn an 80-triangle icosphere into a cut gem
    planes.push([nx, ny, nz, rand.range(0.70, 0.95)]);
  }
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(Math.max(0.34, 1 + f(v.x, v.y, v.z)));
    v.y *= flatten;
    for (const [nx, ny, nz, d] of planes) {
      const dot = v.x * nx + v.y * ny + v.z * nz;
      if (dot > d) { v.x -= nx * (dot - d); v.y -= ny * (dot - d); v.z -= nz * (dot - d); }
    }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();                     // non-indexed => per-face normals
  if (!faceted) {
    // Soften toward the radial direction: water-worn stones read rounded, and the
    // facets of a 80-triangle icosphere otherwise show as obvious flat plates.
    const nrm = g.attributes.normal;
    const a = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      a.fromBufferAttribute(nrm, i);
      v.fromBufferAttribute(p, i).normalize();
      a.lerp(v, 0.60).normalize();
      nrm.setXYZ(i, a.x, a.y, a.z);
    }
  }
  g.computeBoundingSphere();
  return g;
}

/** A bent, tapered log. Also serves as a bleached branch under a thin non-uniform scale. */
function makeDriftwood(rand, { seg = 7, radial = 7, bend = 0.22, taper = 0.55, knots = 2 } = {}) {
  const pos = [], nor = [], uv = [];
  const bendAxis = rand.range(0, Math.PI * 2);
  const bx = Math.cos(bendAxis), bz = Math.sin(bendAxis);
  const wob = lumpField(rand, 4, 0.05, 0.16, 1.4, 5.0);
  const ring = (t) => {
    const x = -1 + 2 * t;
    const c = bend * (1 - x * x);
    return [x, c * bx * 0.6, c * bz];
  };
  const rad = (t) => {
    const x = -1 + 2 * t;
    return (1 - taper * x * x) * (1 + wob(x * 2.2, 0, 0));
  };
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg, t1 = (i + 1) / seg;
    const c0 = ring(t0), c1 = ring(t1), r0 = rad(t0), r1 = rad(t1);
    for (let j = 0; j < radial; j++) {
      const a0 = (j / radial) * Math.PI * 2, a1 = ((j + 1) / radial) * Math.PI * 2;
      const q = [
        [c0[0], c0[1] + Math.cos(a0) * r0, c0[2] + Math.sin(a0) * r0],
        [c1[0], c1[1] + Math.cos(a0) * r1, c1[2] + Math.sin(a0) * r1],
        [c1[0], c1[1] + Math.cos(a1) * r1, c1[2] + Math.sin(a1) * r1],
        [c0[0], c0[1] + Math.cos(a1) * r0, c0[2] + Math.sin(a1) * r0],
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        pos.push(q[k][0], q[k][1], q[k][2]); nor.push(0, 0, 0); uv.push(t0 * 4, j / radial);
      }
    }
  }
  for (const e of [0, 1]) {                       // torn end caps
    const c = ring(e), r = rad(e) * 0.92, sgn = e === 0 ? -1 : 1;
    for (let j = 0; j < radial; j++) {
      const a0 = (j / radial) * Math.PI * 2, a1 = ((j + 1) / radial) * Math.PI * 2;
      const tip = [c[0] + sgn * rand.range(0.02, 0.12), c[1], c[2]];
      const p0 = [c[0], c[1] + Math.cos(a0) * r, c[2] + Math.sin(a0) * r];
      const p1 = [c[0], c[1] + Math.cos(a1) * r, c[2] + Math.sin(a1) * r];
      for (const k of (e === 0 ? [tip, p1, p0] : [tip, p0, p1])) {
        pos.push(k[0], k[1], k[2]); nor.push(0, 0, 0); uv.push(0, 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.computeVertexNormals();
  if (knots <= 0) { g.computeBoundingSphere(); return g; }

  const parts = [{ geo: g }];
  for (let i = 0; i < knots; i++) {
    const t = rand.range(-0.7, 0.7);
    const a = rand.range(0, Math.PI * 2);
    // cone points +Y; rotating +Y about +X by `a` aims it at (0, cos a, sin a),
    // which is radially outward from the log's +X axis.
    parts.push({ geo: new THREE.ConeGeometry(rand.range(0.16, 0.30), rand.range(0.25, 0.55), 5, 1),
      mat: trs(t, Math.cos(a) * 0.5, Math.sin(a) * 0.5, a, 0, 0) });
  }
  const out = mergeGeos(parts);
  out.computeBoundingSphere();
  return out;
}

/** A limp kelp mat: a flattened ragged disc with a few fronds trailing off it. */
function makeKelpMat(rand, { ring = 13, rings = 3, fronds = 5 } = {}) {
  const pos = [], nor = [], uv = [];
  const lob = lumpField(rand, 5, 0.10, 0.34, 1.2, 4.0);
  const R = (a, k) => k * (1 + lob(Math.cos(a) * 2.0, k * 1.5, Math.sin(a) * 2.0));
  const H = (k) => 0.16 * (1 - k * k);
  for (let r = 0; r < rings; r++) {
    const k0 = r / rings, k1 = (r + 1) / rings;
    for (let j = 0; j < ring; j++) {
      const a0 = (j / ring) * Math.PI * 2, a1 = ((j + 1) / ring) * Math.PI * 2;
      const pt = (a, k) => [Math.cos(a) * R(a, k), H(k), Math.sin(a) * R(a, k)];
      const q = [pt(a0, k0), pt(a0, k1), pt(a1, k1), pt(a1, k0)];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        pos.push(q[i][0], q[i][1], q[i][2]); nor.push(0, 1, 0);
        uv.push(q[i][0] * 0.5 + 0.5, q[i][2] * 0.5 + 0.5);
      }
    }
  }
  for (let i = 0; i < fronds; i++) {
    const a = rand.range(0, Math.PI * 2);
    const len = rand.range(0.9, 2.1), w = rand.range(0.05, 0.13);
    const ca = Math.cos(a), sa = Math.sin(a);
    const px = -sa * w, pz = ca * w;
    const x0 = ca * 0.85, z0 = sa * 0.85;
    for (let s = 0; s < 4; s++) {
      const l0 = s / 4, l1 = (s + 1) / 4;
      const cx0 = x0 + ca * len * l0, cz0 = z0 + sa * len * l0;
      const cx1 = x0 + ca * len * l1, cz1 = z0 + sa * len * l1;
      const y0 = 0.05 - 0.04 * l0, y1 = 0.05 - 0.04 * l1;
      const q = [[cx0 - px, y0, cz0 - pz], [cx1 - px, y1, cz1 - pz],
        [cx1 + px, y1, cz1 + pz], [cx0 + px, y0, cz0 + pz]];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        pos.push(q[k][0], q[k][1], q[k][2]); nor.push(0, 1, 0); uv.push(l0, 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** A ribbed bivalve shell — a shallow fluted dome. */
function makeShell(rand) {
  const g = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42).toNonIndexed();
  const p = g.attributes.position, v = new THREE.Vector3();
  const ribs = rand.int(7, 11);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const a = Math.atan2(v.z, v.x);
    const rr = Math.hypot(v.x, v.z);
    const flute = 1 + 0.075 * Math.cos(a * ribs);
    v.x *= flute; v.z *= flute;
    v.y = (v.y - 1) * 0.55 + 0.34 * (1 - rr * rr);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** A small crab: carapace, two claws, a suggestion of legs. */
function makeCrab(rand) {
  const parts = [{ geo: new THREE.SphereGeometry(1, 9, 5), mat: trs(0, 0.34, 0, 0, 0, 0, 1.0, 0.42, 0.78) }];
  for (const s of [-1, 1]) {
    parts.push({ geo: new THREE.SphereGeometry(0.42, 6, 4),
      mat: trs(s * 0.72, 0.30, -0.86, 0, 0, 0, 1.0, 0.55, 1.5) });
    for (let i = 0; i < 3; i++) {
      parts.push({ geo: new THREE.BoxGeometry(0.10, 0.08, 1.0),
        mat: trs(s * 0.85, 0.18, 0.25 + i * 0.34, 0, s * (0.5 + i * 0.28), 0) });
    }
  }
  const g = mergeGeos(parts);
  const p = g.attributes.position, v = new THREE.Vector3();
  const f = lumpField(rand, 3, 0.01, 0.04, 2.0, 6.0);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + f(v.x, v.y, v.z));
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** A broken Forerunner alloy panel: a ribbed slab snapped along a jagged line. */
function makeAlloyPanel(rand) {
  const w = 1, h = 0.075, d = 0.7;
  const parts = [{ geo: new THREE.BoxGeometry(w, h, d) }];
  for (let i = -1; i <= 1; i++) {          // machined underside ribs
    parts.push({ geo: new THREE.BoxGeometry(w * 0.94, h * 0.55, 0.06), mat: trs(0, -h * 0.5, i * 0.20) });
  }
  parts.push({ geo: new THREE.BoxGeometry(w * 0.16, h * 1.6, d * 0.9), mat: trs(w * 0.36, h * 0.2, 0) });
  const g = mergeGeos(parts);
  const p = g.attributes.position, v = new THREE.Vector3();
  const jag = lumpField(rand, 3, 0.02, 0.09, 3.0, 9.0);
  const edge = rand.range(0.30, 0.46);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const cut = edge + jag(0, v.y * 6, v.z * 4);
    if (v.x > cut) v.x = cut;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** MA5B magazine: a boxy mag with a feed lip and a spine rib. */
function makeMag() {
  const g = mergeGeos([
    { geo: new THREE.BoxGeometry(0.076, 0.20, 0.030) },
    { geo: new THREE.BoxGeometry(0.080, 0.024, 0.034), mat: trs(0, 0.098, 0) },
    { geo: new THREE.BoxGeometry(0.060, 0.010, 0.036), mat: trs(0, -0.098, 0) },
    { geo: new THREE.BoxGeometry(0.014, 0.16, 0.036), mat: trs(0.030, -0.01, 0) },
  ]);
  g.computeBoundingSphere();
  return g;
}

/** Plasma pistol: a fat teardrop shell with a claw and a grip. */
function makePistol() {
  const g = mergeGeos([
    { geo: new THREE.SphereGeometry(0.075, 10, 7), mat: trs(0, 0.058, 0, 0, 0, 0, 1.0, 0.72, 1.9) },
    { geo: new THREE.BoxGeometry(0.05, 0.09, 0.05), mat: trs(0, 0.03, 0.07, 0.30, 0, 0) },
    { geo: new THREE.ConeGeometry(0.045, 0.11, 6), mat: trs(0, 0.062, -0.16, Math.PI * 0.5, 0, 0) },
    { geo: new THREE.BoxGeometry(0.018, 0.020, 0.09), mat: trs(-0.035, 0.088, -0.13) },
    { geo: new THREE.BoxGeometry(0.018, 0.020, 0.09), mat: trs(0.035, 0.088, -0.13) },
  ]);
  g.computeBoundingSphere();
  return g;
}

/**
 * Pelican dropship. It only ever reads as a silhouette at 500-900 m, so it is built for
 * outline: slab fuselage, dropped tail ramp, twin canted nacelles, stub wings.
 * ~700 triangles, one draw call, ~1.9 units long before the instance scale.
 */
function makePelican() {
  const parts = [];
  parts.push({ geo: new THREE.BoxGeometry(0.30, 0.26, 1.02) });
  parts.push({ geo: new THREE.BoxGeometry(0.24, 0.19, 0.34), mat: trs(0, 0.02, -0.62, 0.10, 0, 0) });
  parts.push({ geo: new THREE.BoxGeometry(0.20, 0.12, 0.16), mat: trs(0, -0.02, -0.80, 0.28, 0, 0) });
  parts.push({ geo: new THREE.BoxGeometry(0.28, 0.22, 0.30), mat: trs(0, -0.02, 0.60) });
  parts.push({ geo: new THREE.BoxGeometry(0.24, 0.03, 0.30), mat: trs(0, -0.14, 0.86, -0.55, 0, 0) });
  parts.push({ geo: new THREE.BoxGeometry(0.04, 0.34, 0.30), mat: trs(0, 0.24, 0.66, -0.18, 0, 0) });
  parts.push({ geo: new THREE.BoxGeometry(0.62, 0.03, 0.16), mat: trs(0, 0.38, 0.70) });
  for (const s of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(0.46, 0.05, 0.30), mat: trs(s * 0.36, 0.06, 0.06, 0, 0, s * 0.09) });
    parts.push({ geo: new THREE.CylinderGeometry(0.115, 0.10, 0.46, 8), mat: trs(s * 0.60, 0.10, 0.02, Math.PI * 0.5, 0, 0) });
    parts.push({ geo: new THREE.BoxGeometry(0.09, 0.20, 0.20), mat: trs(s * 0.60, 0.24, 0.06, 0.2, 0, 0) });
    parts.push({ geo: new THREE.BoxGeometry(0.06, 0.16, 0.10), mat: trs(s * 0.24, -0.10, 0.10) });
  }
  const g = mergeGeos(parts);
  g.computeBoundingSphere();
  return g;
}

/* =========================================================== ground sampling */

/** Beach cross-section from docs/WORLD.md, used only when `terrain` is absent. */
const PROFILE = [
  [-340, -26], [-180, -11.0], [-70, -4.2], [-26, -1.15], [-6.5, 0.0],
  [0, 0.35], [9, 1.30], [22, 2.75], [38, 5.40], [48, 9.0], [58, 26], [72, 58],
];

function profileY(x, z) {
  // The beach is widest near X = -20 and pinches against the headland at X = +95.
  const zz = z + Math.max(0, (x - 20) / 75) * 14 + Math.max(0, (-x - 120) / 60) * 8;
  if (zz <= PROFILE[0][0]) return PROFILE[0][1];
  const last = PROFILE[PROFILE.length - 1];
  if (zz >= last[0]) return last[1];
  for (let i = 1; i < PROFILE.length; i++) {
    if (zz <= PROFILE[i][0]) {
      const a = PROFILE[i - 1], b = PROFILE[i];
      const y = a[1] + (b[1] - a[1]) * ((zz - a[0]) / (b[0] - a[0]));
      return y + gradNoise2(x * 0.035, zz * 0.05, 91) * 0.28
               + gradNoise2(x * 0.16, zz * 0.19, 17) * 0.06;
    }
  }
  return last[1];
}

/* =============================================================== the module */

export function create(opts = {}) {
  const group = new THREE.Group();
  group.name = 'props';

  const scatters = [];
  const colliders = [];
  const materials = [];
  const geometries = [];

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  let pelican = null;
  let pelicanPath = null;
  const lastRefresh = new THREE.Vector3(1e9, 1e9, 1e9);
  let frozenT = null;
  const counts = { meshes: 0, instances: 0, live: 0, colliders: 0, terrainReal: false };

  /* ---------------------------------------------------------- instanced set */

  class Scatter {
    /**
     * @param {THREE.BufferGeometry[]} geos  one InstancedMesh is built per entry
     * @param {object} o  { castShadow: bool|bool[], matId, roughness }
     */
    constructor(key, geos, material, o = {}) {
      this.key = key;
      this.geos = geos;
      this.material = material;
      this.o = Object.assign({ castShadow: false, matId: MAT_ID.DEFAULT, roughness: 0.7 }, o);
      this.items = [];
      this.meshes = [];
      this.buckets = [];
    }

    /** item: { x, y, z, q:Quaternion, sx, sy, sz, gi, fadeEnd } */
    push(it) { this.items.push(it); }

    build(parent) {
      const per = this.geos.map(() => []);
      for (const it of this.items) per[it.gi].push(it);
      this.buckets = per;
      for (let i = 0; i < this.geos.length; i++) {
        const n = per[i].length;
        if (!n) { this.meshes.push(null); continue; }
        const m = new THREE.InstancedMesh(this.geos[i], this.material, n);
        m.name = `props.${this.key}.${i}`;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Instances span the whole beach, so a bounding-sphere test would never
        // reject the mesh and recomputing it on every LOD rebuild is pure cost.
        // The per-instance distance cull below is the real culling.
        m.frustumCulled = false;
        m.castShadow = Array.isArray(this.o.castShadow) ? !!this.o.castShadow[i] : !!this.o.castShadow;
        m.receiveShadow = true;
        m.layers.set(LAYER.OPAQUE);
        m.count = 0;
        patchForGBuffer(m, { matId: this.o.matId, roughness: this.o.roughness });
        parent.add(m);
        this.meshes.push(m);
        counts.meshes++;
      }
      counts.instances += this.items.length;
    }

    /**
     * Rewrite instance matrices for the current camera. Instances shrink smoothly to
     * nothing across [0.72*fadeEnd, fadeEnd] and are then dropped from the draw, so
     * small props fade out instead of popping.
     */
    refresh(cam) {
      let live = 0;
      for (let i = 0; i < this.meshes.length; i++) {
        const m = this.meshes[i];
        if (!m) continue;
        const arr = m.instanceMatrix.array;
        const bucket = this.buckets[i];
        let n = 0;
        for (let k = 0; k < bucket.length; k++) {
          const it = bucket[k];
          const dx = it.x - cam.x, dy = it.y - cam.y, dz = it.z - cam.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const fe = it.fadeEnd, fs = fe * 0.72;
          let f = 1;
          if (d > fs) {
            if (d >= fe) continue;
            f = (fe - d) / (fe - fs);
            f = f * f * (3 - 2 * f);
          }
          _p.set(it.x, it.y, it.z);
          _s.set(it.sx * f, it.sy * f, it.sz * f);
          _m.compose(_p, it.q, _s).toArray(arr, n * 16);
          n++;
        }
        m.count = n;
        m.instanceMatrix.needsUpdate = true;
        live += n;
      }
      return live;
    }
  }

  /* -------------------------------------------------------------- materials */

  /** Per-instance macro variation, hashed from the instance origin — no extra buffer. */
  const TINT_VERTEX_PARS = /* glsl */`
    varying vec3 vPropTint;
    uniform float uTintAmt;
  `;
  const TINT_VERTEX = /* glsl */`
    #ifdef USE_INSTANCING
      vec3 io = instanceMatrix[3].xyz;
      float h0 = fract(sin(dot(io, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float h1 = fract(sin(dot(io, vec3(93.9898, 27.233, 61.719))) * 24634.6345);
      float h2 = fract(sin(dot(io, vec3(41.1237, 55.017, 19.311))) * 17325.1231);
      vPropTint = 1.0 + uTintAmt * (vec3(h0, h1, h2) - 0.5) * 2.0;
    #else
      vPropTint = vec3(1.0);
    #endif
  `;
  const PROP_PARS = /* glsl */`
    varying vec3 vPropTint;
    /** Below the swash line everything is soaked; it dries out up the berm. */
    float pWet(vec3 wp){ return clamp(smoothstep(2.2, 0.10, wp.y), 0.0, 1.0); }
  `;

  /**
   * Make `mat.onBeforeCompile` accumulate handlers instead of replacing them.
   *
   * Three parties want that one hook and the handoff between them loses work:
   * `applyWorldMaterial()` reads the current handler, wraps it, and then calls
   * `lighting.registerMaterial()` — and three's `CSM.setupMaterial()` *assigns*
   * `material.onBeforeCompile` outright, discarding the wrapper that was just
   * installed. (CSM's own GLSL is applied by overwriting `ShaderChunk` globally, so
   * only its uniform push lives in the hook; nothing about the fix disturbs it.)
   *
   * While the property is open the getter reports `undefined`, so a caller that
   * reads-then-wraps does not end up invoking earlier handlers a second time —
   * `applyWorldMaterial`'s `#include <common>` replacement is not idempotent and a
   * second pass duplicates the aerial-perspective uniform block, which will not
   * compile. `seal()` switches the getter to the composite before first render.
   */
  function chainOnBeforeCompile(mat) {
    const fns = [];
    let sealed = false;
    Object.defineProperty(mat, 'onBeforeCompile', {
      configurable: true,
      enumerable: true,
      get() {
        if (!sealed) return undefined;
        return (shader, renderer) => { for (const f of fns) f(shader, renderer); };
      },
      set(fn) { if (typeof fn === 'function') fns.push(fn); },
    });
    return () => { sealed = true; };
  }

  function makeMaterial(ctx, key, matId, body, o = {}) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: o.roughness ?? 0.7, metalness: 0.0,
    });
    if (o.side) mat.side = o.side;
    const seal = chainOnBeforeCompile(mat);
    // Surface authoring is injected before <lights_physical_fragment>, not at
    // applyWorldMaterial's own hook — see the note in the file header.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTintAmt = { value: o.tint ?? 0.14 };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        `{\n${body}\n}\n#include <lights_physical_fragment>`);
    };
    applyWorldMaterial(mat, ctx, {
      matId,
      inject: {
        key: `props-${key}`,
        pars: SURFACE_GLSL + PROP_PARS,
        vertexPars: TINT_VERTEX_PARS,
        vertex: TINT_VERTEX,
      },
    });
    seal();
    materials.push(mat);
    return mat;
  }

  /* ----------------------------------------------------------------- module */

  const api = {
    name: 'props',
    order: 55,
    enabled: true,

    /** Handed to `physics` — see docs/API.md. */
    colliders,
    /** Reporting only. */
    stats: counts,

    async init(ctx) {
      const terrain = ctx.get('terrain');
      const rocks = ctx.get('rocks');

      /* ---- ground query, with the documented profile as the fallback ------- */
      const _n = new THREE.Vector3();
      const ground = (x, z) => {
        if (terrain) {
          try {
            if (typeof terrain.sample === 'function') {
              const s = terrain.sample(x, z);
              if (s && Number.isFinite(s.y)) {
                return {
                  y: s.y,
                  nx: s.normal?.x ?? 0, ny: s.normal?.y ?? 1, nz: s.normal?.z ?? 0,
                  slope: Number.isFinite(s.slope) ? s.slope : 0,
                  wet: Number.isFinite(s.wetness) ? s.wetness : 0,
                  real: true,
                };
              }
            }
            if (typeof terrain.height === 'function') {
              const y = terrain.height(x, z);
              if (Number.isFinite(y)) {
                let nx = 0, ny = 1, nz = 0, slope = 0;
                if (typeof terrain.normal === 'function') {
                  const n = terrain.normal(x, z, _n);
                  if (n && Number.isFinite(n.y)) { nx = n.x; ny = n.y; nz = n.z; slope = 1 - Math.min(1, Math.abs(n.y)); }
                }
                return { y, nx, ny, nz, slope, wet: THREE.MathUtils.clamp(1 - (y - 0.1) / 2.2, 0, 1), real: true };
              }
            }
          } catch (err) { /* half-built terrain: fall through to the profile */ }
        }
        const y = profileY(x, z);
        const eps = 0.7;
        const dx = profileY(x + eps, z) - profileY(x - eps, z);
        const dz = profileY(x, z + eps) - profileY(x, z - eps);
        const len = Math.hypot(dx, 2 * eps, dz);
        return {
          y,
          nx: -dx / len, ny: (2 * eps) / len, nz: -dz / len,
          slope: 1 - (2 * eps) / len,
          wet: THREE.MathUtils.clamp(1 - (y - 0.05) / 2.3, 0, 1),
          real: false,
        };
      };
      counts.terrainReal = ground(0, 10).real;

      /* ---- rocks proximity ------------------------------------------------ */
      const landmarks = [];
      try {
        const lm = rocks?.landmarks;
        if (lm && typeof lm.forEach === 'function') {
          lm.forEach((v) => {
            const c = v?.center;
            if (c && Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(v.radius)) {
              landmarks.push({ x: c.x, z: c.z, r: v.radius });
            }
          });
        }
      } catch (err) { /* rocks half-built */ }
      counts.landmarksFromRocks = landmarks.length;
      if (!landmarks.length) {
        // docs/WORLD.md landmark table, so talus still lands in the right places
        // when `rocks` has not published yet.
        for (const [x, z, r] of [
          [-38, -92, 15], [34, -70, 17], [-96, -140, 19], [-128, -172, 13],
          [120, -210, 16], [156, -246, 12], [108, 20, 40],
        ]) landmarks.push({ x, z, r });
      }

      /** -1 inside a landmark (reject), else 0..1 across its talus apron. */
      const nearRock = (x, z) => {
        let best = 0;
        for (const l of landmarks) {
          const d = Math.hypot(x - l.x, z - l.z);
          if (d < l.r * 0.82) return -1;
          const t = (d - l.r * 0.82) / (l.r * 1.05);
          if (t < 1) best = Math.max(best, 1 - t);
        }
        return best;
      };
      /** Cliff talus: the wall runs X -150..+190 at Z ~ +62 (docs/WORLD.md). */
      const nearCliff = (x, z) => (x > -155 && x < 195)
        ? THREE.MathUtils.clamp(1 - Math.abs(z - 52) / 16, 0, 1) : 0;

      const b = terrain?.bounds;
      const X0 = Number.isFinite(b?.minX) ? Math.max(b.minX, -170) : -170;
      const X1 = Number.isFinite(b?.maxX) ? Math.min(b.maxX, 150) : 150;
      const Z0 = Number.isFinite(b?.minZ) ? Math.max(b.minZ, -46) : -46;
      const Z1 = Number.isFinite(b?.maxZ) ? Math.min(b.maxZ, 62) : 62;

      /**
       * Weighted rejection sampling over the beach band. `weight` returns 0..1 and the
       * sampler keeps drawing until it has `count` accepted points or runs out of
       * tries, so density follows the field without needing to normalise it.
       */
      function scatterPoints(rnd, count, weight, tries = 24) {
        const out = [];
        let guard = count * tries;
        while (out.length < count && guard-- > 0) {
          const x = rnd.range(X0, X1), z = rnd.range(Z0, Z1);
          const g = ground(x, z);
          const w = weight(x, z, g);
          if (w > 0 && rnd.next() < w) out.push({ x, z, g });
        }
        return out;
      }

      /** Sit an object on the ground, tilted to the surface, with a random spin. */
      function seat(g, rnd, tiltBlend = 1, jitter = 0.28) {
        _p.set(g.nx, Math.max(0.2, g.ny), g.nz).normalize();
        if (tiltBlend < 1) _p.lerp(_up, 1 - tiltBlend).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(_up, _p);
        _q.setFromEuler(_e.set(rnd.sym(jitter), rnd.range(0, Math.PI * 2), rnd.sym(jitter), 'YXZ'));
        return q.multiply(_q);
      }

      /* ================================================== 1. cobbles / rubble */
      {
        const rnd = ctx.rand.fork(0x51c0bb1e);
        const geos = [
          makeStone(rnd.fork(1), { detail: 1, lumps: 8, amp: 0.24, cuts: 0, flatten: 0.78 }),
          makeStone(rnd.fork(2), { detail: 1, lumps: 6, amp: 0.20, cuts: 5, flatten: 0.72, faceted: true }),
          makeStone(rnd.fork(3), { detail: 1, lumps: 7, amp: 0.17, cuts: 3, flatten: 0.44, faceted: true }),
        ];
        geometries.push(...geos);

        const mat = makeMaterial(ctx, 'cobble', MAT_ID.ROCK, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float n    = fbm3(wp * 3.1, 4) * 0.5 + 0.5;
          float n2   = fbm3(wp * 21.0, 3) * 0.5 + 0.5;
          float grit = vnoise3(wp * 96.0);
          float wet  = pWet(wp);
          // dry cobbles are pale warm grey; wet ones go near-black and glossy
          vec3 dry = mix(vec3(0.470, 0.430, 0.372), vec3(0.250, 0.226, 0.198), n);
          dry = mix(dry, vec3(0.560, 0.520, 0.455), smoothstep(0.62, 0.95, n2) * 0.55);
          dry *= 0.80 + 0.34 * grit;
          diffuseColor.rgb = mix(dry, dry * 0.30, wet) * vPropTint;
          roughnessFactor = clamp(mix(0.88, 0.24, wet) * (0.84 + 0.30 * n2) - 0.10 * grit, 0.06, 1.0);
        `, { roughness: 0.72, tint: 0.16 });

        // Cobbles form beds and drifts, not confetti — a coherent field decides where.
        const bed = (x, z) => THREE.MathUtils.clamp(
          (gradNoise2(x * 0.055, z * 0.075, 311) * 0.5 + 0.5) * 0.78 +
          (gradNoise2(x * 0.190, z * 0.260, 733) * 0.5 + 0.5) * 0.34, 0, 1);

        const scat = new Scatter('cobble', geos, mat, {
          // the flat slab variant contributes almost no shadow area; skip its cascades
          castShadow: [true, true, false], matId: MAT_ID.ROCK, roughness: 0.72,
        });

        const pts = scatterPoints(rnd, 5200, (x, z, g) => {
          if (g.y < -2.6 || g.y > 11) return 0;
          if (g.slope > 0.62) return 0;
          const nr = nearRock(x, z);
          if (nr < 0) return 0;
          // densest just above the waterline, thinning up the dry berm
          const band = THREE.MathUtils.clamp(1.18 - Math.abs(g.y - 0.55) * 0.30, 0.12, 1.0);
          let w = 0.42 * band * (0.25 + bed(x, z)) * (1 - g.slope * 0.7);
          w += nr * 0.75 + nearCliff(x, z) * 0.55;
          return Math.min(1, w);
        });

        for (const pt of pts) {
          // power-law sizes: many pebbles, few boulders
          const size = 0.045 * Math.pow(20.0, Math.pow(rnd.next(), 2.1));
          const gi = size > 0.34 ? rnd.int(1, 2) : rnd.int(0, 2);
          const sink = size * rnd.range(0.18, 0.62);
          const y = pt.g.y - sink + size * 0.5;
          scat.push({
            x: pt.x, y, z: pt.z,
            q: seat(pt.g, rnd, 0.8, 0.30),
            sx: size * rnd.range(0.85, 1.25),
            sy: size * rnd.range(0.62, 1.00),
            sz: size * rnd.range(0.85, 1.25),
            gi,
            // pebbles vanish close in; boulders survive out to the haze band
            fadeEnd: THREE.MathUtils.clamp(size * 300, 26, 260),
          });
          if (size > 0.42 && colliders.length < 190) {
            colliders.push({
              type: 'sphere',
              center: new THREE.Vector3(pt.x, y, pt.z),
              radius: size * 0.58,
              surface: 'rock',
            });
          }
        }
        scatters.push(scat);
      }

      /* =========================================== 2. driftwood and branches */
      {
        const rnd = ctx.rand.fork(0xd21f7);
        const geo = makeDriftwood(rnd.fork(1), { seg: 7, radial: 7, bend: 0.20, knots: 2 });
        geometries.push(geo);

        const mat = makeMaterial(ctx, 'driftwood', MAT_ID.DEFAULT, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float grain = fbm3(wp * vec3(2.0, 26.0, 26.0), 4) * 0.5 + 0.5;
          float n     = fbm3(wp * 6.0, 3) * 0.5 + 0.5;
          float wet   = pWet(wp);
          vec3 base = mix(vec3(0.400, 0.352, 0.290), vec3(0.610, 0.575, 0.512), grain);
          base = mix(base, vec3(0.300, 0.262, 0.212), smoothstep(0.55, 0.95, n) * 0.6);
          diffuseColor.rgb = mix(base, base * 0.42, wet * 0.8) * vPropTint;
          roughnessFactor = clamp(mix(0.94, 0.55, wet) * (0.86 + 0.22 * grain), 0.10, 1.0);
        `, { roughness: 0.9, tint: 0.13 });

        const scat = new Scatter('driftwood', [geo], mat, {
          castShadow: true, matId: MAT_ID.DEFAULT, roughness: 0.9,
        });

        const pts = scatterPoints(rnd, 90, (x, z, g) => {
          if (g.y < 0.9 || g.y > 6.5) return 0;        // strictly above the swash
          if (g.slope > 0.42) return 0;
          if (nearRock(x, z) < 0) return 0;
          const band = THREE.MathUtils.clamp(1.1 - Math.abs(g.y - 2.4) * 0.30, 0, 1);
          const streak = gradNoise2(x * 0.04, g.y * 0.5, 505) * 0.5 + 0.5;
          return Math.min(1, 0.30 * band * (0.35 + streak) + nearCliff(x, z) * 0.25);
        });

        for (const pt of pts) {
          const branch = rnd.next() < 0.55;
          const len = branch ? rnd.range(0.55, 1.5) : rnd.range(1.1, 3.6);
          const rad = branch ? len * rnd.range(0.030, 0.055) : len * rnd.range(0.055, 0.105);
          const yaw = rnd.range(0, Math.PI * 2);
          const y = pt.g.y + rad * rnd.range(0.35, 0.75);
          scat.push({
            x: pt.x, y, z: pt.z,
            q: new THREE.Quaternion().setFromEuler(_e.set(rnd.sym(0.12), yaw, rnd.sym(0.5), 'YXZ')),
            sx: len, sy: rad, sz: rad, gi: 0,
            fadeEnd: THREE.MathUtils.clamp(len * 90, 60, 220),
          });
          if (!branch && colliders.length < 230) {
            const ax = Math.cos(yaw) * len, az = -Math.sin(yaw) * len;
            colliders.push({
              type: 'capsule',
              a: new THREE.Vector3(pt.x - ax, y, pt.z - az),
              b: new THREE.Vector3(pt.x + ax, y, pt.z + az),
              radius: rad, surface: 'wood',
            });
          }
        }
        scatters.push(scat);
      }

      /* ================================================ 3. kelp in the swash */
      {
        const rnd = ctx.rand.fork(0x4e17);
        const geo = makeKelpMat(rnd.fork(1));
        geometries.push(geo);

        const mat = makeMaterial(ctx, 'kelp', MAT_ID.FOLIAGE, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float n = fbm3(wp * 5.0, 4) * 0.5 + 0.5;
          float f = fbm3(wp * 34.0, 3) * 0.5 + 0.5;
          vec3 base = mix(vec3(0.086, 0.078, 0.040), vec3(0.170, 0.148, 0.062), n);
          base = mix(base, vec3(0.230, 0.170, 0.086), smoothstep(0.6, 0.95, f) * 0.5);
          diffuseColor.rgb = base * vPropTint;
          // wet weed is the glossiest thing on the beach — it is what catches the sun
          roughnessFactor = clamp(0.20 + 0.26 * n, 0.05, 1.0);
        `, { roughness: 0.28, tint: 0.26, side: THREE.DoubleSide });

        const scat = new Scatter('kelp', [geo], mat, {
          castShadow: false, matId: MAT_ID.FOLIAGE, roughness: 0.28,
        });

        const pts = scatterPoints(rnd, 320, (x, z, g) => {
          if (g.y < -1.1 || g.y > 1.6) return 0;       // strictly the swash line
          if (g.slope > 0.45) return 0;
          const nr = nearRock(x, z);
          if (nr < 0) return 0;
          const band = THREE.MathUtils.clamp(1.15 - Math.abs(g.y - 0.25) * 1.05, 0, 1);
          const clump = gradNoise2(x * 0.09, z * 0.14, 271) * 0.5 + 0.5;
          return Math.min(1, 0.55 * band * (0.2 + clump * 1.3) + nr * 0.35);
        });

        for (const pt of pts) {
          const size = rnd.range(0.22, 0.85);
          scat.push({
            x: pt.x, y: pt.g.y + 0.012, z: pt.z,
            q: seat(pt.g, rnd, 1.0, 0.10),
            sx: size * rnd.range(0.8, 1.3),
            sy: size * rnd.range(0.18, 0.42),
            sz: size * rnd.range(0.8, 1.3),
            gi: 0,
            fadeEnd: THREE.MathUtils.clamp(size * 110, 34, 130),
          });
        }
        scatters.push(scat);
      }

      /* ================================================= 4. shells and crabs */
      {
        const rnd = ctx.rand.fork(0x5e11);
        const shellGeo = makeShell(rnd.fork(1));
        geometries.push(shellGeo);

        const shellMat = makeMaterial(ctx, 'shell', MAT_ID.DEFAULT, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float n = fbm3(wp * 40.0, 3) * 0.5 + 0.5;
          float wet = pWet(wp);
          vec3 base = mix(vec3(0.720, 0.672, 0.585), vec3(0.845, 0.800, 0.720), n);
          base = mix(base, vec3(0.560, 0.470, 0.400), smoothstep(0.7, 1.0, n) * 0.4);
          diffuseColor.rgb = mix(base, base * 0.62, wet * 0.7) * vPropTint;
          roughnessFactor = clamp(mix(0.52, 0.20, wet) * (0.9 + 0.2 * n), 0.05, 1.0);
        `, { roughness: 0.42, tint: 0.10 });

        const shells = new Scatter('shell', [shellGeo], shellMat, {
          castShadow: false, matId: MAT_ID.DEFAULT, roughness: 0.42,
        });

        const pts = scatterPoints(rnd, 480, (x, z, g) => {
          if (g.y < -0.6 || g.y > 3.4) return 0;
          if (g.slope > 0.42) return 0;
          if (nearRock(x, z) < 0) return 0;
          const band = THREE.MathUtils.clamp(1.1 - Math.abs(g.y - 0.9) * 0.55, 0, 1);
          return Math.min(1, 0.5 * band * (0.25 + valueNoise2(x * 0.22, z * 0.3, 88) * 1.4));
        });

        for (const pt of pts) {
          const size = rnd.range(0.026, 0.085);
          const flip = rnd.next() < 0.45 ? Math.PI : 0;
          shells.push({
            x: pt.x, y: pt.g.y + size * 0.10, z: pt.z,
            q: new THREE.Quaternion().setFromEuler(
              _e.set(flip + rnd.sym(0.4), rnd.range(0, Math.PI * 2), rnd.sym(0.4), 'YXZ')),
            sx: size * rnd.range(0.85, 1.2),
            sy: size * rnd.range(0.70, 1.1),
            sz: size * rnd.range(0.85, 1.2),
            gi: 0, fadeEnd: 22,
          });
        }
        scatters.push(shells);

        /* crabs — the tide-pool shelf only, per docs/WORLD.md */
        const crabGeo = makeCrab(rnd.fork(9));
        geometries.push(crabGeo);
        const crabMat = makeMaterial(ctx, 'crab', MAT_ID.DEFAULT, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float n = fbm3(wp * 55.0, 3) * 0.5 + 0.5;
          diffuseColor.rgb = mix(vec3(0.300, 0.120, 0.062), vec3(0.470, 0.230, 0.115), n) * vPropTint;
          roughnessFactor = clamp(0.34 + 0.24 * n, 0.05, 1.0);
        `, { roughness: 0.36, tint: 0.18 });

        const crabs = new Scatter('crab', [crabGeo], crabMat, {
          castShadow: false, matId: MAT_ID.DEFAULT, roughness: 0.36,
        });
        for (let i = 0; i < 30; i++) {
          const x = rnd.range(-70, -18), z = rnd.range(-14, -2);
          const g = ground(x, z);
          if (g.y < -1.2 || g.y > 1.6 || g.slope > 0.5) continue;
          const size = rnd.range(0.055, 0.11);
          crabs.push({
            x, y: g.y + size * 0.05, z,
            q: new THREE.Quaternion().setFromEuler(_e.set(0, rnd.range(0, Math.PI * 2), 0, 'YXZ')),
            sx: size, sy: size, sz: size, gi: 0, fadeEnd: 26,
          });
        }
        scatters.push(crabs);
      }

      /* ===================================== 5. broken Forerunner alloy panels */
      {
        const rnd = ctx.rand.fork(0xf07e);
        const geo = makeAlloyPanel(rnd.fork(1));
        geometries.push(geo);

        const mat = makeMaterial(ctx, 'alloy', MAT_ID.FORERUNNER, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float brush  = fbm3(wp * vec3(1.2, 30.0, 30.0), 3) * 0.5 + 0.5;
          float grime  = fbm3(wp * 4.4, 4) * 0.5 + 0.5;
          float sanded = smoothstep(0.55, 0.05, wp.y);   // the buried edge silts over
          vec3 alloy = mix(vec3(0.205, 0.202, 0.192), vec3(0.315, 0.312, 0.300), brush);
          alloy = mix(alloy, vec3(0.135, 0.133, 0.126), smoothstep(0.55, 0.95, grime) * 0.55);
          diffuseColor.rgb = mix(alloy, vec3(0.330, 0.288, 0.220), sanded * 0.55 * grime) * vPropTint;
          metalnessFactor = mix(0.34, 0.08, sanded);
          roughnessFactor = clamp(mix(0.38, 0.80, grime) + sanded * 0.25, 0.06, 1.0);
        `, { roughness: 0.48, tint: 0.07 });

        const scat = new Scatter('alloy', [geo], mat, {
          castShadow: true, matId: MAT_ID.FORERUNNER, roughness: 0.48,
        });

        // The bridge runs (54,60) -> (-34,-4). Debris lies along the run and under the
        // broken tip — but not right at it: kf_01500 stands roughly under the tip and
        // shows open cobbled sand there, so the field starts a little way inboard.
        const AX = -34, AZ = -4, BX = 54, BZ = 60;
        let placed = 0;
        for (let i = 0; i < 900 && placed < 42; i++) {
          const t = 0.18 + 0.72 * Math.pow(rnd.next(), 1.4);
          const spread = 5 + 11 * t;
          const x = AX + (BX - AX) * t + rnd.sym(spread);
          const z = AZ + (BZ - AZ) * t + rnd.sym(spread);
          if (x < X0 || x > X1 || z < Z0 || z > Z1) continue;
          const g = ground(x, z);
          if (g.y < -1.6 || g.y > 12 || g.slope > 0.5) continue;
          if (nearRock(x, z) < 0) continue;
          placed++;
          const size = rnd.range(0.35, 1.65);
          const bury = rnd.range(0.1, 0.7);
          const strut = rnd.next() < 0.30;
          scat.push({
            x, y: g.y - size * 0.05 * bury, z,
            q: new THREE.Quaternion().setFromEuler(
              _e.set(rnd.sym(0.5) - bury * 0.4, rnd.range(0, Math.PI * 2), rnd.sym(0.45), 'YXZ')),
            sx: size * (strut ? rnd.range(1.3, 1.8) : rnd.range(0.80, 1.25)),
            sy: size * (strut ? rnd.range(1.3, 2.2) : rnd.range(0.70, 1.40)),
            sz: size * (strut ? rnd.range(0.20, 0.40) : rnd.range(0.70, 1.20)),
            gi: 0,
            fadeEnd: THREE.MathUtils.clamp(size * 190, 90, 300),
          });
          if (size > 1.2 && colliders.length < 250) {
            const half = new THREE.Vector3(size * 0.55, size * 0.22, size * 0.45);
            const c0 = new THREE.Vector3(x, g.y + size * 0.1, z);
            colliders.push({
              type: 'box',
              // `physics.js` reads `.box`; `rocks` and `structures` both publish
              // `center`/`halfExtents` instead. Publish both spellings so this works
              // whichever way that contract gets settled.
              box: new THREE.Box3(c0.clone().sub(half), c0.clone().add(half)),
              center: c0.clone(),
              halfExtents: half.clone(),
              surface: 'metal',
            });
          }
        }
        scatters.push(scat);
      }

      /* ====================================================== 6. gear pickups */
      {
        const rnd = ctx.rand.fork(0x9ea7);
        const magGeo = makeMag(), pistolGeo = makePistol();
        geometries.push(magGeo, pistolGeo);

        const gearMat = makeMaterial(ctx, 'gear', MAT_ID.METAL, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float w = fbm3(wp * 60.0, 3) * 0.5 + 0.5;
          float scuff = fbm3(wp * 190.0, 2) * 0.5 + 0.5;
          vec3 base = mix(vec3(0.052, 0.056, 0.048), vec3(0.115, 0.120, 0.108), w);
          base = mix(base, vec3(0.190, 0.180, 0.160), smoothstep(0.75, 1.0, scuff) * 0.6);
          diffuseColor.rgb = base;
          metalnessFactor = 0.45;
          roughnessFactor = clamp(0.30 + 0.26 * w - 0.10 * scuff, 0.05, 1.0);
        `, { roughness: 0.4, tint: 0.0 });

        const plasmaMat = makeMaterial(ctx, 'plasma', MAT_ID.METAL, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float w = fbm3(wp * 70.0, 3) * 0.5 + 0.5;
          diffuseColor.rgb = mix(vec3(0.120, 0.105, 0.230), vec3(0.240, 0.210, 0.400), w);
          metalnessFactor = 0.35;
          roughnessFactor = clamp(0.22 + 0.20 * w, 0.05, 1.0);
          totalEmissiveRadiance += vec3(0.10, 0.42, 0.62) * smoothstep(0.55, 0.95, w) * 0.55;
        `, { roughness: 0.3, tint: 0.0 });

        const mags = new Scatter('mag', [magGeo], gearMat, {
          castShadow: true, matId: MAT_ID.METAL, roughness: 0.40,
        });
        const pistols = new Scatter('pistol', [pistolGeo], plasmaMat, {
          castShadow: true, matId: MAT_ID.METAL, roughness: 0.30,
        });

        // Near the spawn and the first scored poses, so they actually read.
        const spots = [[8.4, 15.2], [4.6, 12.1], [-3.2, 7.4], [-26.5, -0.5]];
        for (let i = 0; i < spots.length; i++) {
          const [x, z] = spots[i];
          const g = ground(x, z);
          (i === 3 ? pistols : mags).push({
            x, y: g.y + (i === 3 ? 0.03 : 0.018), z,
            q: new THREE.Quaternion().setFromEuler(
              _e.set(Math.PI * 0.5 + rnd.sym(0.2), rnd.range(0, Math.PI * 2), rnd.sym(0.3), 'YXZ')),
            sx: 1, sy: 1, sz: 1, gi: 0, fadeEnd: 55,
          });
        }
        scatters.push(mags, pistols);
      }

      /* ========================================================= 7. Pelican */
      {
        const geo = makePelican();
        geometries.push(geo);
        const mat = makeMaterial(ctx, 'pelican', MAT_ID.METAL, /* glsl */`
          vec3 wp = vWorldPositionWM;
          float p = fbm3(wp * 0.9, 3) * 0.5 + 0.5;
          diffuseColor.rgb = mix(vec3(0.088, 0.096, 0.086), vec3(0.170, 0.180, 0.168), p);
          metalnessFactor = 0.40;
          roughnessFactor = 0.42;
          // engine bells stay hot against the sky — the cue that still reads at 600 m
          totalEmissiveRadiance += vec3(0.55, 0.72, 1.0) * smoothstep(0.72, 0.98, p) * 1.4;
        `, { roughness: 0.42, tint: 0.0 });

        pelican = new THREE.Mesh(geo, mat);
        pelican.name = 'props.pelican';
        pelican.scale.setScalar(15.0);          // ~28 m long
        pelican.castShadow = false;
        pelican.receiveShadow = false;
        pelican.layers.set(LAYER.OPAQUE);
        patchForGBuffer(pelican, { matId: MAT_ID.METAL, roughness: 0.42 });
        group.add(pelican);
        counts.meshes++;

        // A slow transit high over the north-east sea, placed so that at the capture
        // time it sits where kf_00720 shows one: high in the upper right, small,
        // well silhouetted against the gas giant.
        pelicanPath = {
          start: new THREE.Vector3(1049, 142, 87),
          dir: new THREE.Vector3(-0.900, 0.015, -0.436).normalize(),
          speed: 38,
          length: 2600,
        };
        placePelican(ctx.clock.t);
      }

      /* --------------------------------------------------------------- wire up */
      for (const s of scatters) s.build(group);
      counts.colliders = colliders.length;
      ctx.scene.add(group);
      api.refresh(ctx.camera.position);

      // `physics` re-collects on engine:ready, but announce anyway for anything that
      // came up before us.
      ctx.emit('props:ready', { colliders });
      if (!counts.terrainReal) {
        console.warn('[props] terrain unavailable at init — scattered against the ' +
          'docs/WORLD.md beach profile instead; positions are approximate.');
      }
    },

    /* ------------------------------------------------------------ per-frame */

    update(dt, ctx) {
      group.visible = api.enabled !== false;
      if (!group.visible) return;

      // Freeze animation on demand without losing the harness's setTime().
      let t;
      if (ctx.config.frozen) { if (frozenT === null) frozenT = ctx.clock.t; t = frozenT; }
      else { frozenT = null; t = ctx.clock.t; }
      placePelican(t);

      // The LOD rebuild is O(items), so only redo it when the camera actually moved.
      // During a capture the camera is static: this runs once and every settle frame
      // afterwards is byte-identical.
      const cam = ctx.camera.position;
      if (cam.distanceToSquared(lastRefresh) > 4.0) api.refresh(cam);
    },

    /** Rebuild instance matrices for a camera position. Returns the live instance count. */
    refresh(cam) {
      lastRefresh.copy(cam);
      let live = 0;
      for (const s of scatters) live += s.refresh(cam);
      counts.live = live;
      return live;
    },

    dispose(ctx) {
      ctx.scene.remove(group);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      group.clear();
      scatters.length = 0;
      colliders.length = 0;
    },
  };

  function placePelican(t) {
    if (!pelican || !pelicanPath) return;
    const L = pelicanPath.length;
    const u = ((t * pelicanPath.speed) % L + L) % L;
    pelican.position.copy(pelicanPath.start).addScaledVector(pelicanPath.dir, u);
    pelican.rotation.set(0.03, Math.atan2(-pelicanPath.dir.x, -pelicanPath.dir.z), 0.06, 'YXZ');
    pelican.updateMatrixWorld(true);
  }

  return api;
}
