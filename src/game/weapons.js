import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYER } from '../render/RenderPipeline.js';
import { MAT_ID, patchForGBuffer } from '../gfx/GBufferMaterial.js';
import { applyWorldMaterial, configureTexture } from '../gfx/materialCommon.js';

/**
 * `weapons` — MA5B assault rifle viewmodel, firing, ballistics, recoil.
 *
 * The viewmodel is on screen 100% of the time and owns roughly a quarter of every
 * frame.
 *
 * TARGETS — read this before touching a tunable.
 *
 * Do NOT tune to `ref/roi_signatures.json`'s `weapon` row (79.8 / 49.4 / 489 / 0.089
 * / 0.178). That is a mean over the whole clip, and the `weapon` ROI is a fixed
 * screen rectangle that is ~65% *sand*: its lap_var and edge_density are set by
 * terrain, not by this file. Two separate mistakes in one number. The per-pose ROI
 * figure for the pose we actually capture (ref_00000) is
 *
 *     lum_mean 103.2  lum_std 61.2  lap_var 999  edge_den 0.124  local_con 0.220
 *
 * and the number that actually belongs to this module is the **gun-only** signature,
 * measured through `tools/_wpnmask.py` (viewmodel silhouette for ours, hand-traced
 * polygon for the reference). At ref_00000 that reads
 *
 *     lum_mean 67.5   lum_std 52.3   p99 226   R-B +11.0   lap_var 1160  hi_frac 0.028
 *
 * So the gun is NOT a near-black object: it is a mid-dark *warm-neutral* gunmetal
 * sitting in strong warm sand bounce, carrying one long specular streak down the top
 * rail and a 2.8% highlight population. Reading the clip-mean 79.8 as "dark" and
 * driving the body albedo to charcoal is what produced the navy plank this file used
 * to render.
 *
 * The surface story in `ref/detail/weapon_4k.png` is, in order of contribution:
 * panel-line grooves, white stencil decals, AO packed into the grooves, and one soft
 * anisotropic sheen down the rail. It is barely scratched. Chamfer rim wear is a
 * *supporting* term here, not the main event — it cannot mark a flat face at all
 * (aMask.x is 0 on every large face by construction), so albedo-domain panel lines
 * and stencils carry the mid-frequency structure.
 *
 * Nothing is fetched and nothing is authored by hand: the scratch/wear detail map,
 * the glove weave, the rail engraving and the ammo-counter panel are all generated
 * procedurally at init from `ctx.rand.fork(...)`.
 *
 * Layer / lighting contract:
 *   - meshes draw on LAYER.VIEWMODEL, which `passes/scene.js` renders with its own
 *     camera (`pipe.viewCamera`, fov 55, near 0.002) after a depth clear. The whole
 *     rig is laid out for that 55 deg vertical fov, not the main camera's 78.
 *   - materials go through `applyWorldMaterial(..., { aerial: false })` and are
 *     registered with `lighting`, so the gun takes the same sun, sky fill and warm
 *     sand bounce as the world. A viewmodel lit off its own private rig reads as
 *     pasted on instantly.
 *   - a small PMREM probe built from `sky.radiance()` supplies the specular IBL.
 *     Without it a metallic viewmodel is black everywhere except the sun lobe: the
 *     bright grazing sheen along the top rail in the reference *is* the sky.
 */

/* ========================================================================== */
/*  tunables                                                                  */
/* ========================================================================== */

/** Linear sand albedo (R,G,B) and overall gain for the env probe's ground hemisphere. */
const SAND_BOUNCE = [0.30, 0.235, 0.165];
/* 5.60, not 3.60. With the body at metalness 1.0 the HemisphereLight and the warm
 * bounce DirectionalLight contribute NOTHING — three's meshphysical gives metals no
 * diffuse term — so this probe is the gun's entire ambient, and its ground hemisphere
 * is the only warm light it ever sees. Measured at 3.60 the gun came out R-B -13.5
 * against the reference's +11.0: a blue-black gun in a warm frame. */
const SAND_BOUNCE_GAIN = 7.20;

const MAG_SIZE = 60;
const START_AMMO = 36;          // the reference frame reads 36; boot matching it
const START_RESERVE = 540;
const RPM = 600;
const SHOT_DT = 60 / RPM;
const RELOAD_TIME = 2.6;
const RANGE = 220;
const DAMAGE = 9.5;

/** Mount pose in view space (metres / radians). Solved against kf_01500: it puts the
 *  counter-housing apex at ~(1352, 640) of 1920x1080 and runs the rail off the right
 *  edge at y~1000, which is where the reference has them. */
const MOUNT_POS = new THREE.Vector3(0.1966, -0.2126, -0.3458);
const MOUNT_ROT = { pitch: 0.1658, yaw: 0.1571, roll: 0.1745 };   // 9.5 / 9 / 10 deg
const ADS_POS = new THREE.Vector3(0.052, -0.092, -0.335);
const ADS_ROT = { pitch: 0.0524, yaw: 0.0262, roll: 0.0175 };

/** Weapon centre of mass in local space; the sway/lag rig rotates about this. */
const PIVOT = new THREE.Vector3(0, -0.010, -0.090);

const DEG = Math.PI / 180;

/* ========================================================================== */
/*  deterministic noise                                                       */
/* ========================================================================== */

function h2i(x, y, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a, b, t) => a + (b - a) * t;

/** Tiling value noise: period `per` in cells, so the texture wraps seamlessly. */
function vnoiseT(x, y, per, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth5(xf), v = smooth5(yf);
  const w = (a) => ((a % per) + per) % per;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  return mix(mix(h2i(x0, y0, s), h2i(x1, y0, s), u), mix(h2i(x0, y1, s), h2i(x1, y1, s), u), v);
}
function fbmT(x, y, per, oct, s) {
  let a = 0.5, f = 1, sum = 0, nrm = 0;
  for (let i = 0; i < oct; i++) {
    sum += a * vnoiseT(x * f, y * f, per * f, s + i * 71);
    nrm += a; a *= 0.5; f *= 2;
  }
  return sum / nrm;
}

/** Critically damped spring step; `x`/`v` in, new [x, v] out. Frame-rate stable. */
function spring(x, v, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega, hoo = dt * oo;
  const det = 1 / (f + dt * hoo);
  const dx = x - target;
  return [(f * x + dt * v + target * dt * hoo) * det, (v - hoo * dx) * det];
}

/* ========================================================================== */
/*  mesh builder                                                              */
/* ========================================================================== */

const UVS = 8.0;   // fallback planar-UV scale (unused by triplanar materials)

class MB {
  constructor() { this.p = []; this.n = []; this.uv = []; this.m = []; }

  vert(px, py, pz, nx, ny, nz, e, a, u, v) {
    if (u === undefined) {
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      if (ax >= ay && ax >= az) { u = pz * UVS; v = py * UVS; }
      else if (ay >= az) { u = px * UVS; v = pz * UVS; }
      else { u = px * UVS; v = py * UVS; }
    }
    this.p.push(px, py, pz);
    this.n.push(nx, ny, nz);
    this.uv.push(u, v);
    this.m.push(e, a);
  }

  /**
   * WINDING NORMALISATION — read this before adding a primitive.
   *
   * WebGL's front face is CCW, so a triangle is front-facing exactly when
   * `(b-a) x (c-a)` points the same way as its shading normal. Getting that wrong
   * does not produce a hole you would notice: with `side: FrontSide` the near
   * surface is culled and you see the model's INSIDE, lit by normals that point
   * away from you. It reads as a soft, pale, structureless mass — which is what
   * this viewmodel was.
   *
   * Measured with `tools/_wind.mjs` before the fix, share of triangles whose
   * winding opposed their own normal, by surface area:
   *
   *     boltPoly 99.5%   armR 99.5%   engrave 100%   plate 75.8%   rail 69.2%
   *     handL 68.7%      poly 42.9%   mag 33.9%      body 25.0%
   *
   * Two independent causes: `extrudeProfile` runs stations along **-Z** for
   * `segRounded`/`ribbedCylinder`, which flips handedness against a CCW-in-XY
   * profile; and `chamferBox`'s corner facets are only CCW for even-parity
   * corners. Rather than hand-fix every call site and re-break it with the next
   * primitive, normalise here: it is one cross product per triangle at build time
   * and it cannot be got wrong twice.
   */
  tri(a, b, c, n, ma, mb, mc) {
    const gx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const gy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const gz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (gx * n[0] + gy * n[1] + gz * n[2] < 0) { const t = b; b = c; c = t; const tm = mb; mb = mc; mc = tm; }
    this.vert(a[0], a[1], a[2], n[0], n[1], n[2], ma[0], ma[1]);
    this.vert(b[0], b[1], b[2], n[0], n[1], n[2], mb[0], mb[1]);
    this.vert(c[0], c[1], c[2], n[0], n[1], n[2], mc[0], mc[1]);
  }

  quad(a, b, c, d, n, ma, mb, mc, md) {
    this.tri(a, b, c, n, ma, mb, mc);
    this.tri(a, c, d, n, ma, mc, md);
  }

  /** Quad with per-vertex normals and optional per-vertex UVs. */
  quadN(a, na, b, nb, c, nc, d, nd, ma, mb, mc, md, uva, uvb, uvc, uvd) {
    // same normalisation as tri(), against the mean of the three shading normals
    const gx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const gy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const gz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (gx * (na[0] + nb[0] + nc[0]) + gy * (na[1] + nb[1] + nc[1]) + gz * (na[2] + nb[2] + nc[2]) < 0) {
      [a, na, ma, uva, b, nb, mb, uvb, c, nc, mc, uvc, d, nd, md, uvd] =
        [a, na, ma, uva, d, nd, md, uvd, c, nc, mc, uvc, b, nb, mb, uvb];
    }
    const V = (p, n, m, t) => this.vert(p[0], p[1], p[2], n[0], n[1], n[2], m[0], m[1],
      t ? t[0] : undefined, t ? t[1] : undefined);
    V(a, na, ma, uva); V(b, nb, mb, uvb); V(c, nc, mc, uvc);
    V(a, na, ma, uva); V(c, nc, mc, uvc); V(d, nd, md, uvd);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.m, 2));
    return g;
  }
}

const nrm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Chamfered box. Six inset faces, twelve flat chamfer bands, eight corner facets.
 * Each chamfer band is split down its middle so `aMask.x` can ramp 0.3 -> 1 -> 0.3
 * across it: that ramp is what the shader turns into a rim of exposed metal, and it
 * is the single largest contributor to this module's local contrast.
 */
function chamferBox(w, h, d, c, o = {}) {
  const mb = o.mb || new MB();
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  c = Math.min(c, hx * 0.9, hy * 0.9, hz * 0.9);
  const ao = o.ao ?? 1.0, aoBottom = o.aoBottom ?? ao;
  const eScale = o.edge ?? 1.0;
  const off = o.offset || [0, 0, 0];

  const P = (x, y, z) => [x + off[0], y + off[1], z + off[2]];
  const S = [-1, 1];
  // corner "regions": three points per corner, one pulled out along each axis
  const cx = {}, cy = {}, cz = {};
  for (const sx of S) for (const sy of S) for (const sz of S) {
    const k = `${sx},${sy},${sz}`;
    cx[k] = P(sx * hx, sy * (hy - c), sz * (hz - c));
    cy[k] = P(sx * (hx - c), sy * hy, sz * (hz - c));
    cz[k] = P(sx * (hx - c), sy * (hy - c), sz * hz);
  }
  const K = (sx, sy, sz) => `${sx},${sy},${sz}`;
  const M0 = [0, ao], M0b = [0, aoBottom];
  const mHi = [eScale, ao], mLo = [0.30 * eScale, ao];

  // ---- 6 faces
  const faceAo = (ny) => (ny < -0.5 ? aoBottom : ao);
  for (const sx of S) {
    const n = [sx, 0, 0], m = [0, ao];
    const a = cx[K(sx, -1, sx)], b = cx[K(sx, -1, -sx)], c2 = cx[K(sx, 1, -sx)], d2 = cx[K(sx, 1, sx)];
    mb.quad(a, b, c2, d2, n, m, m, m, m);
  }
  for (const sy of S) {
    const n = [0, sy, 0], m = [0, faceAo(sy)];
    const a = cy[K(-sy, sy, -1)], b = cy[K(sy, sy, -1)], c2 = cy[K(sy, sy, 1)], d2 = cy[K(-sy, sy, 1)];
    mb.quad(a, b, c2, d2, n, m, m, m, m);
  }
  for (const sz of S) {
    const n = [0, 0, sz], m = [0, ao];
    const a = cz[K(-sz, -1, sz)], b = cz[K(sz, -1, sz)], c2 = cz[K(sz, 1, sz)], d2 = cz[K(-sz, 1, sz)];
    mb.quad(a, b, c2, d2, n, m, m, m, m);
  }

  // ---- 12 chamfer bands, each split in two so the edge mask can peak in the middle
  /* The four points arrive in RING order p0 -> p1 -> q0 -> q1, so the vertex facing
   * p0 across the band is q1, not q0. Pairing them p0+q0 / p1+q1 — as this did —
   * put both "midpoints" on the band's centroid, i.e. mid0 === mid1 exactly. Every
   * chamfer on every box then rendered as two triangles meeting at a point (a
   * bowtie) with two triangular HOLES through it, plus two exactly-degenerate
   * triangles; and the 0.3 -> 1 -> 0.3 edge-mask ramp this whole function exists to
   * produce collapsed to a single value. Found with tools/_wpntri.mjs, which dumps
   * triangle aspect ratios: 12 zero-area triangles per chamferBox, all with two
   * identical vertices at the band centre. */
  const band = (p0, p1, q0, q1, n) => {
    const mid = (u, v) => [(u[0] + v[0]) * 0.5, (u[1] + v[1]) * 0.5, (u[2] + v[2]) * 0.5];
    const mid0 = mid(p0, q1);
    const mid1 = mid(p1, q0);
    mb.quad(p0, p1, mid1, mid0, n, mLo, mLo, mHi, mHi);
    mb.quad(mid0, mid1, q0, q1, n, mHi, mHi, mLo, mLo);
  };
  for (const sy of S) for (const sz of S) {   // edges along X
    const n = nrm3([0, sy, sz]);
    band(cy[K(-1, sy, sz)], cy[K(1, sy, sz)], cz[K(1, sy, sz)], cz[K(-1, sy, sz)],
      sy * sz > 0 ? n : n);
  }
  for (const sx of S) for (const sz of S) {   // edges along Y
    const n = nrm3([sx, 0, sz]);
    band(cx[K(sx, -1, sz)], cx[K(sx, 1, sz)], cz[K(sx, 1, sz)], cz[K(sx, -1, sz)], n);
  }
  for (const sx of S) for (const sy of S) {   // edges along Z
    const n = nrm3([sx, sy, 0]);
    band(cx[K(sx, sy, -1)], cx[K(sx, sy, 1)], cy[K(sx, sy, 1)], cy[K(sx, sy, -1)], n);
  }

  // ---- 8 corner facets
  for (const sx of S) for (const sy of S) for (const sz of S) {
    const k = K(sx, sy, sz);
    const n = nrm3([sx, sy, sz]);
    const m = [0.7 * eScale, ao];
    mb.tri(cx[k], cy[k], cz[k], n, m, m, m);
  }
  return mb;
}

/**
 * Extrude a closed 2D profile along +Z through a list of stations. Stations carry a
 * scale, an offset and their own (edge, ao) mask, so a two-station pinch produces a
 * panel seam and a two-station shrink produces a rim chamfer — the two features the
 * MA5B shroud and the counter housing are made of.
 */
function extrudeProfile(prof, stations, o = {}) {
  const mb = o.mb || new MB();
  const n = prof.length;
  const segN = [];
  for (let i = 0; i < n; i++) {
    const a = prof[i], b = prof[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    segN.push([dy / l, -dx / l]);
  }
  const vN = [];   // [normalForSegmentStart, normalForSegmentEnd] per segment
  for (let i = 0; i < n; i++) {
    const prev = segN[(i - 1 + n) % n], cur = segN[i], next = segN[(i + 1) % n];
    const s0 = prof[i].smooth ? nrm3([prev[0] + cur[0], prev[1] + cur[1], 0]) : [cur[0], cur[1], 0];
    const s1 = prof[(i + 1) % n].smooth ? nrm3([cur[0] + next[0], cur[1] + next[1], 0]) : [cur[0], cur[1], 0];
    vN.push([s0, s1]);
  }
  const pt = (st, i) => [prof[i].x * (st.sx ?? st.s ?? 1) + (st.ox || 0),
    prof[i].y * (st.sy ?? st.s ?? 1) + (st.oy || 0), st.z];
  const nAt = (st, base) => nrm3([base[0], base[1], st.nz || 0]);

  const effS = (st) => Math.max(Math.abs(st.sx ?? st.s ?? 1), Math.abs(st.sy ?? st.s ?? 1));
  for (let j = 0; j < stations.length - 1; j++) {
    const A = stations[j], B = stations[j + 1];
    if (A.skip) continue;
    // A collapsed station fans a ring of near-zero-area triangles. Every viewmodel
    // mesh is frustumCulled = false and is drawn after a depth clear with its own
    // camera at near = 0.002, so one such sliver overdraws the world at ANY distance
    // — that is the pair of 1px stippled hairlines running across a third of the
    // beach. Drop the segment instead of emitting it.
    if (effS(A) < 1e-3 && effS(B) < 1e-3) continue;
    const mA = [A.edge || 0, A.ao ?? 1], mB = [B.edge || 0, B.ao ?? 1];
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const p0 = pt(A, i), p1 = pt(A, i2), p2 = pt(B, i2), p3 = pt(B, i);
      const n0 = nAt(A, vN[i][0]), n1 = nAt(A, vN[i][1]);
      const n2 = nAt(B, vN[i][1]), n3 = nAt(B, vN[i][0]);
      mb.quadN(p0, n0, p1, n1, p2, n2, p3, n3, mA, mA, mB, mB);
    }
  }
  const last = stations[stations.length - 1];
  if (o.capFront !== false && effS(stations[0]) >= 1e-3) capProfile(mb, prof, stations[0], -1, o);
  if (o.capBack !== false && effS(last) >= 1e-3) capProfile(mb, prof, last, 1, o);
  return mb;
}

function capProfile(mb, prof, st, dir, o = {}) {
  const n = prof.length;
  let cx = 0, cy = 0;
  for (const p of prof) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  const sx = st.sx ?? st.s ?? 1, sy = st.sy ?? st.s ?? 1;
  const C = [cx * sx + (st.ox || 0), cy * sy + (st.oy || 0), st.z];
  const nv = [0, 0, dir];
  const m = [0, o.capAo ?? (st.ao ?? 1)];
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    const a = [prof[i].x * sx + (st.ox || 0), prof[i].y * sy + (st.oy || 0), st.z];
    const b = [prof[i2].x * sx + (st.ox || 0), prof[i2].y * sy + (st.oy || 0), st.z];
    if (dir > 0) mb.tri(C, a, b, nv, m, m, m);
    else mb.tri(C, b, a, nv, m, m, m);
  }
}

/** Rounded convex polygon -> profile point list, CCW in XY (outward = +normal). */
function roundedPoly(pts, radius, segs = 3) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const r = Array.isArray(radius) ? radius[i] : radius;
    let v1x = prev[0] - cur[0], v1y = prev[1] - cur[1];
    let v2x = next[0] - cur[0], v2y = next[1] - cur[1];
    const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
    v1x /= l1; v1y /= l1; v2x /= l2; v2y /= l2;
    const dot = Math.max(-0.9999, Math.min(0.9999, v1x * v2x + v1y * v2y));
    const ang = Math.acos(dot);
    const half = ang * 0.5;
    let d = Math.min(r / Math.tan(half), l1 * 0.49, l2 * 0.49);
    const rr = d * Math.tan(half);
    if (rr < 1e-6 || segs < 1) { out.push({ x: cur[0], y: cur[1], smooth: false }); continue; }
    const t1 = [cur[0] + v1x * d, cur[1] + v1y * d];
    const t2 = [cur[0] + v2x * d, cur[1] + v2y * d];
    let bx = v1x + v2x, by = v1y + v2y;
    const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
    const cd = rr / Math.sin(half);
    const ccx = cur[0] + bx * cd, ccy = cur[1] + by * cd;
    let a1 = Math.atan2(t1[1] - ccy, t1[0] - ccx);
    let a2 = Math.atan2(t2[1] - ccy, t2[0] - ccx);
    let da = a2 - a1;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    for (let s = 0; s <= segs; s++) {
      const a = a1 + da * (s / segs);
      out.push({ x: ccx + Math.cos(a) * rr, y: ccy + Math.sin(a) * rr, smooth: segs > 1 });
    }
  }
  return out;
}

/** Rounded rectangle profile, CCW. */
const rrProfile = (w, h, r, segs = 3) => roundedPoly(
  [[w * 0.5, -h * 0.5], [w * 0.5, h * 0.5], [-w * 0.5, h * 0.5], [-w * 0.5, -h * 0.5]], r, segs);

/** Circle profile, CCW, all points smooth. */
function circleProfile(r, segs) {
  const out = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, smooth: true });
  }
  return out;
}

/** Annular-ribbed cylinder along -Z (charging handle / fore grip). */
function ribbedCylinder(r, len, ribs, ribAmp, o = {}) {
  const segs = o.radial || 20;
  const prof = circleProfile(1, segs);
  const stations = [];
  const perRib = 6;
  const N = ribs * perRib;
  const capR = o.capR ?? 0.55;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = -len * t;
    const ph = (t * ribs) % 1;
    const rib = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
    let rad = r + ribAmp * (rib - 0.5);
    // round both ends off
    const endT = Math.min(t, 1 - t) / capR;
    if (endT < 1) rad *= Math.sqrt(Math.max(0.04, 1 - (1 - endT) * (1 - endT)));
    stations.push({ z, s: rad, edge: rib * 0.85, ao: mix(0.62, 1.0, rib) });
  }
  for (let i = 0; i < stations.length; i++) {
    const a = stations[Math.max(0, i - 1)], b = stations[Math.min(stations.length - 1, i + 1)];
    const dz = b.z - a.z;
    stations[i].nz = dz !== 0 ? -(b.s - a.s) / dz : 0;
  }
  return extrudeProfile(prof, stations, { mb: o.mb, capFront: true, capBack: true, capAo: 0.5 });
}

/** A rectangular depression: chamfered lip walls plus a dark floor. */
function recess(mb, x0, x1, y0, y1, faceZ, depth, lip, ao = 0.35) {
  const inx0 = x0 + lip, inx1 = x1 - lip, iny0 = y0 + lip, iny1 = y1 - lip;
  const fz = faceZ, bz = faceZ + depth;   // depth is signed along +Z
  const mE = [0.85, 1.0], mI = [0.1, ao];
  const wall = (a, b, c, d, n) => mb.quad(a, b, c, d, nrm3(n), mE, mE, mI, mI);
  wall([x0, y0, fz], [x1, y0, fz], [inx1, iny0, bz], [inx0, iny0, bz], [0, -1, -Math.sign(depth)]);
  wall([x1, y1, fz], [x0, y1, fz], [inx0, iny1, bz], [inx1, iny1, bz], [0, 1, -Math.sign(depth)]);
  wall([x1, y0, fz], [x1, y1, fz], [inx1, iny1, bz], [inx1, iny0, bz], [1, 0, -Math.sign(depth)]);
  wall([x0, y1, fz], [x0, y0, fz], [inx0, iny0, bz], [inx0, iny1, bz], [-1, 0, -Math.sign(depth)]);
  const mf = [0, ao * 0.7];
  const nz = [0, 0, -Math.sign(depth)];
  mb.quad([inx0, iny0, bz], [inx1, iny0, bz], [inx1, iny1, bz], [inx0, iny1, bz], nz, mf, mf, mf, mf);
}

/**
 * Drop near-zero-area triangles from a non-indexed viewmodel geometry.
 *
 * Belt-and-braces behind the station-collapse skip in extrudeProfile. The viewmodel
 * is drawn frustumCulled = false, after a depth clear, through a camera with
 * near = 0.002; a sliver whose projected area is sub-pixel still rasterises as a
 * stippled hairline, and because it owns no depth relationship to the world it
 * paints straight across terrain tens of metres away. Cheap to prevent, impossible
 * to hide.
 */
function cullDegenerate(geo, minArea = 1e-9) {
  const pos = geo.getAttribute('position');
  if (!pos || geo.index) return geo;
  const tris = pos.count / 3;
  const keep = [];
  for (let t = 0; t < tris; t++) {
    const i = t * 3;
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (0.5 * Math.hypot(nx, ny, nz) >= minArea) keep.push(t);
  }
  if (keep.length === tris) return geo;
  const attrs = geo.attributes;
  for (const name of Object.keys(attrs)) {
    const a = attrs[name], sz = a.itemSize;
    const src = a.array, dst = new src.constructor(keep.length * 3 * sz);
    for (let k = 0; k < keep.length; k++) {
      const s = keep[k] * 3 * sz;
      for (let j = 0; j < 3 * sz; j++) dst[k * 3 * sz + j] = src[s + j];
    }
    geo.setAttribute(name, new THREE.BufferAttribute(dst, sz));
  }
  return geo;
}

function transformMB(geo, m) {
  geo.applyMatrix4(m);
  return geo;
}

/* ========================================================================== */
/*  build-time ray-cast ambient occlusion                                     */
/* ========================================================================== */

/**
 * Binary BVH over a flat triangle soup (9 floats per triangle). Median split on the
 * longest axis of the centroid bounds; leaves of <= 6 triangles.
 */
function buildBVH(tri) {
  const n = tri.length / 9;
  const idx = new Int32Array(n);
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    idx[i] = i;
    const o = i * 9;
    cx[i] = (tri[o] + tri[o + 3] + tri[o + 6]) / 3;
    cy[i] = (tri[o + 1] + tri[o + 4] + tri[o + 7]) / 3;
    cz[i] = (tri[o + 2] + tri[o + 5] + tri[o + 8]) / 3;
  }
  const maxNodes = Math.max(1, 2 * n);
  const bnd = new Float32Array(maxNodes * 6);
  const left = new Int32Array(maxNodes).fill(-1);
  const right = new Int32Array(maxNodes).fill(-1);
  const start = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  let nNodes = 0;

  const build = (lo, hi) => {
    const node = nNodes++;
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let i = lo; i < hi; i++) {
      const o = idx[i] * 9;
      for (let k = 0; k < 3; k++) {
        const px = tri[o + k * 3], py = tri[o + k * 3 + 1], pz = tri[o + k * 3 + 2];
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
      }
    }
    const b = node * 6;
    bnd[b] = x0; bnd[b + 1] = y0; bnd[b + 2] = z0; bnd[b + 3] = x1; bnd[b + 4] = y1; bnd[b + 5] = z1;
    if (hi - lo <= 6) { start[node] = lo; count[node] = hi - lo; return node; }
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
    const axis = ex >= ey && ex >= ez ? cx : (ey >= ez ? cy : cz);
    const mid = (lo + hi) >> 1;
    // nth_element by hand (quickselect) so build stays O(n log n)
    let l = lo, h = hi - 1;
    while (l < h) {
      const pivot = axis[idx[(l + h) >> 1]];
      let i = l, j = h;
      while (i <= j) {
        while (axis[idx[i]] < pivot) i++;
        while (axis[idx[j]] > pivot) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (mid <= j) h = j; else if (mid >= i) l = i; else break;
    }
    count[node] = 0;
    left[node] = build(lo, mid);
    right[node] = build(mid, hi);
    return node;
  };
  if (n > 0) build(0, n); else { nNodes = 1; count[0] = 0; }
  return { tri, idx, bnd, left, right, start, count };
}

/** Any-hit ray query. Möller-Trumbore, no backface rejection (thin shells). */
function bvhOccluded(bvh, ox, oy, oz, dx, dy, dz, tmax) {
  const { tri, idx, bnd, left, right, start, count } = bvh;
  // 0 * Infinity is NaN, so never let a slab reciprocal be infinite
  const ix = 1 / (Math.abs(dx) < 1e-8 ? (dx < 0 ? -1e-8 : 1e-8) : dx);
  const iy = 1 / (Math.abs(dy) < 1e-8 ? (dy < 0 ? -1e-8 : 1e-8) : dy);
  const iz = 1 / (Math.abs(dz) < 1e-8 ? (dz < 0 ? -1e-8 : 1e-8) : dz);
  const stack = bvhOccluded._s || (bvhOccluded._s = new Int32Array(128));
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp];
    const b = node * 6;
    let t0 = 0, t1 = tmax;
    let a = (bnd[b] - ox) * ix, c = (bnd[b + 3] - ox) * ix;
    if (a > c) { const t = a; a = c; c = t; }
    if (a > t0) t0 = a; if (c < t1) t1 = c;
    a = (bnd[b + 1] - oy) * iy; c = (bnd[b + 4] - oy) * iy;
    if (a > c) { const t = a; a = c; c = t; }
    if (a > t0) t0 = a; if (c < t1) t1 = c;
    a = (bnd[b + 2] - oz) * iz; c = (bnd[b + 5] - oz) * iz;
    if (a > c) { const t = a; a = c; c = t; }
    if (a > t0) t0 = a; if (c < t1) t1 = c;
    if (t0 > t1) continue;
    const cnt = count[node];
    if (cnt === 0) { stack[sp++] = left[node]; stack[sp++] = right[node]; continue; }
    for (let i = start[node]; i < start[node] + cnt; i++) {
      const o = idx[i] * 9;
      const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
      const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - tri[o], ty = oy - tri[o + 1], tz = oz - tri[o + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-5 && t < tmax) return true;
    }
  }
  return false;
}

/**
 * Per-vertex ambient occlusion, cast against the whole assembled viewmodel at build
 * time. research/weapons.md 2.3.2: "do not run CSM on the viewmodel — the cascades are
 * sized for 340 m and the first cascade texel at 2048^2 is far too coarse for a 0.9 m
 * object. Self-shadow with baked ambient occlusion instead: for each vertex cast
 * N = 32 cosine-weighted rays against the merged geometry and store the visibility in
 * a vertex attribute. This is what gives you the dark line under the carry handle and
 * inside the magazine well."
 *
 * It is applied to the INDIRECT terms only (see the `<aomap_fragment>` injection in
 * `vmMaterial`), never to the sun — occluding a delta light with a hemispherical
 * visibility term is double-counting, and it is what makes baked AO read as dirt.
 *
 * Results are cached per (quantised position, quantised normal), which collapses the
 * non-indexed soup ~4x and keeps the whole bake inside ~200 ms.
 */
function bakeVertexAO(geos, occluderTris, rays = 24, maxDist = 0.22) {
  const bvh = buildBVH(occluderTris);
  const cache = new Map();
  // Hammersley, cosine-weighted about +Z
  const sx = new Float32Array(rays), sy = new Float32Array(rays), sz = new Float32Array(rays);
  for (let i = 0; i < rays; i++) {
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    const u1 = (i + 0.5) / rays, u2 = bits * 2.3283064365386963e-10;
    const r = Math.sqrt(u1), phi = u2 * Math.PI * 2;
    sx[i] = r * Math.cos(phi); sy[i] = r * Math.sin(phi); sz[i] = Math.sqrt(Math.max(0, 1 - u1));
  }
  for (const geo of geos) {
    const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
    const out = new Float32Array(pos.count);
    for (let v = 0; v < pos.count; v++) {
      const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);
      let nx = nrm.getX(v), ny = nrm.getY(v), nz = nrm.getZ(v);
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const key = `${Math.round(px * 2000)},${Math.round(py * 2000)},${Math.round(pz * 2000)},`
        + `${Math.round(nx * 4)},${Math.round(ny * 4)},${Math.round(nz * 4)}`;
      const hit = cache.get(key);
      if (hit !== undefined) { out[v] = hit; continue; }
      // orthonormal basis about the normal (Duff et al. branchless ONB)
      const sgn = nz >= 0 ? 1 : -1;
      const a = -1 / (sgn + nz), b = nx * ny * a;
      const t0x = 1 + sgn * nx * nx * a, t0y = sgn * b, t0z = -sgn * nx;
      const t1x = b, t1y = sgn + ny * ny * a, t1z = -ny;
      const ox = px + nx * 3e-4, oy = py + ny * 3e-4, oz = pz + nz * 3e-4;
      let open = 0;
      for (let i = 0; i < rays; i++) {
        const dx = t0x * sx[i] + t1x * sy[i] + nx * sz[i];
        const dy = t0y * sx[i] + t1y * sy[i] + ny * sz[i];
        const dz = t0z * sx[i] + t1z * sy[i] + nz * sz[i];
        if (!bvhOccluded(bvh, ox, oy, oz, dx, dy, dz, maxDist)) open++;
      }
      /* Floor the visibility at 0.30. src/render/lighting.js's own header records that
       * the reference clip never lets a shadow reach black — shadow_frac 0.050 with
       * p01 = 17, i.e. the darkest 1% of pixels still sit at code value 17. An
       * unclamped cast-AO term on a metal (which has no diffuse fill at all) drove
       * 44% of the gun below code 25 with p01 = 0.6. */
      const ao = 0.30 + 0.70 * (open / rays);
      cache.set(key, ao);
      out[v] = ao;
    }
    geo.setAttribute('aAO', new THREE.BufferAttribute(out, 1));
  }
  return cache.size;
}

/* ========================================================================== */
/*  procedural textures                                                       */
/* ========================================================================== */

/**
 * The surface pack. One RGBA8 texture, sampled triplanar in object space:
 *   rg = tangent-plane normal perturbation   b = roughness variation
 *   a  = wear / grime mask (high = exposed, low = grime in the recesses)
 *
 * The scratches are rasterised as real segments rather than filtered noise: a
 * scratch has to be a *thin* discontinuity to read as one, and any isotropic noise
 * that is thin enough also has the wrong power spectrum (it pushes spectral_slope
 * toward white noise, which docs/TARGETS.md explicitly calls out as the way to fake
 * lap_var without adding information).
 */
function makeSurfaceTex(rand, opts = {}) {
  const N = opts.size || 512;
  const scratches = opts.scratches ?? 300;
  const aniso = opts.aniso ?? 0.86;         // 1 = all scratches along U
  const grain = opts.grain ?? 1.0;
  const hgt = new Float32Array(N * N);      // NORMAL-bearing height: coarse only
  const fineF = new Float32Array(N * N);    // sub-pixel grain: roughness only
  const wearF = new Float32Array(N * N);

  /* SCALE BUDGET — research/weapons.md 4.3b.
   * The viewmodel sits ~0.4 m from a 55 deg vertical / 85.6 deg horizontal camera, so
   * one pixel at 1920 wide is 2*0.4*tan(42.8 deg)/1920 = 0.39 mm. This texture is
   * sampled triplanar at uDetailScale ~7 (one repeat per 143 mm), so at N = 512 a
   * texel is 0.28 mm — the WHOLE texture lives at or below the pixel.
   *
   * Anything finer than ~1 mm therefore cannot be a normal: it aliases into a
   * per-pixel specular crust that survives its own albedo. Measured before this split,
   * with --config weaponAlbedoScale=0.001, the receiver top face still read L = 141.6
   * of 173.2 — 82% of the brightest large surface on the gun was albedo-independent,
   * and achromatic, i.e. pure specular fizz. That is the "woven burlap / sandstone"
   * read.
   *
   * So: only the 8-period octave (17 mm features) and the rasterised scratches drive
   * the normal. The 48-period octave (2.9 mm, i.e. 7 px) moves into the ROUGHNESS
   * channel, where sub-pixel geometry physically belongs.
   */
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = x / N * 8, v = y / N * 8;
      hgt[i] = (fbmT(u, v, 8, 4, 11) - 0.5) * 0.55 * grain;
      fineF[i] = (fbmT(u * 6, v * 6, 48, 2, 27) - 0.5) * grain;
      wearF[i] = fbmT(u * 1.5, v * 1.5, 12, 4, 53);
    }
  }

  // --- scratches: straight segments, wrapped, with a 3px soft core
  const splat = (fx, fy, amp) => {
    const xi = Math.floor(fx), yi = Math.floor(fy);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const wx = 1 - Math.abs(fx - (xi + dx)), wy = 1 - Math.abs(fy - (yi + dy));
        if (wx <= 0 || wy <= 0) continue;
        const px = ((xi + dx) % N + N) % N, py = ((yi + dy) % N + N) % N;
        hgt[py * N + px] += amp * wx * wy;
      }
    }
  };
  for (let s = 0; s < scratches; s++) {
    const x0 = rand.next() * N, y0 = rand.next() * N;
    const along = rand.next() < aniso;
    const base = along ? 0 : Math.PI * 0.5;
    const ang = base + rand.sym(0.10) + (rand.next() < 0.12 ? rand.sym(0.9) : 0);
    const len = N * (0.015 + Math.pow(rand.next(), 2.6) * 0.26);
    const amp = (rand.next() < 0.30 ? 1 : -1) * (0.03 + rand.next() * 0.13);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const steps = Math.max(2, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const fade = Math.sin(t * Math.PI);           // taper the ends
      splat(x0 + dx * len * t, y0 + dy * len * t, amp * fade);
    }
  }

  // --- pack
  const data = new Uint8Array(N * N * 4);
  const at = (x, y) => hgt[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      // 5-tap derivative: a further low-pass, so even the coarse octave cannot put
      // energy at the texel (= sub-pixel) frequency.
      const dhx = (at(x + 2, y) + at(x + 1, y) - at(x - 1, y) - at(x - 2, y)) * 0.25;
      const dhy = (at(x, y + 2) + at(x, y + 1) - at(x, y - 1) - at(x, y - 2)) * 0.25;
      const nx = Math.max(-1, Math.min(1, -dhx * 6.0));
      const ny = Math.max(-1, Math.min(1, -dhy * 6.0));
      // roughness carries the sub-pixel grain: cast grain roughens, scratch cores polish
      const rgh = 0.5 + hgt[i] * 0.9 + fineF[i] * 1.15;
      // wear: mottled, contrast stretched so it breaks up rather than washes
      // wear stays COARSE — fineF is deliberately not in here. Mixing a 2.9 mm octave
      // into the wear mask and then into a bright bare-alloy colour is how you get
      // per-pixel chalky speckle on a dark base.
      let w = wearF[i] * 0.75 + (0.5 + hgt[i] * 1.6) * 0.25;
      w = Math.max(0, Math.min(1, (w - 0.34) * 2.35));
      data[i * 4] = (nx * 0.5 + 0.5) * 255;
      data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      data[i * 4 + 2] = Math.max(0, Math.min(1, rgh)) * 255;
      data[i * 4 + 3] = w * 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/**
 * Receiver-flank decal sheet — the thing this module was missing entirely.
 *
 * `ref/detail/weapon_4k.png` shows the MA5B's flank carrying, in order of how much
 * they contribute at 1080p: panel-line grooves, tonally separated panel plates,
 * white stencil runs ("MA5B ... 7.62MM ..."), and AO packed into the grooves. It is
 * barely scratched. The chamfer-driven wear path in VM_FRAG can produce *none* of
 * that, because `aMask.x` is hard 0 on every large flat face — so a flat receiver
 * side had literally no albedo signal available. That is the 4.7x lap_var deficit.
 *
 * Projected planar in object (z, y), so it lands on the flanks and nowhere else, and
 * pinned to object space like the rest of the detail so it cannot swim.
 *
 * Channels: R = stencil coverage, G = groove darkness, B = groove dv (normal),
 *           A = large-scale panel plate tone (0.5 = neutral).
 */
function makeDecalTex(rand, W = 1024, H = 512) {
  const sten = new Float32Array(W * H);
  const grv = new Float32Array(W * H);
  const plate = new Float32Array(W * H).fill(0.5);

  const rect = (buf, x0, y0, x1, y1, v) => {
    for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) buf[y * W + x] = v;
    }
  };
  const addRect = (buf, x0, y0, x1, y1, v) => {
    for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) buf[y * W + x] += v;
    }
  };

  /* ---- panel plates: four tonally separated bands, like the reference's flank */
  const bands = [[0.00, 0.22, 0.585], [0.22, 0.38, 0.450], [0.38, 0.52, 0.545], [0.52, 1.00, 0.485]];
  for (const [v0, v1, tone] of bands) rect(plate, 0, v0 * H, W, v1 * H, tone);
  // long horizontal splits inside the big plate, so it is not one slab
  for (let i = 0; i < 5; i++) {
    const v = 0.10 + rand.next() * 0.80;
    const u0 = rand.next() * 0.5, u1 = u0 + 0.25 + rand.next() * 0.45;
    addRect(plate, u0 * W, v * H, u1 * W, (v + 0.035) * H, rand.sym(0.045));
  }

  /* ---- panel-line grooves. Horizontal runs (along the barrel) dominate. */
  const groove = (x0, y0, x1, y1, wpx, depth) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      for (let d = -wpx; d <= wpx; d++) {
        const yy = Math.round(py + d), xx = Math.round(px);
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        const f = 1 - Math.abs(d) / (wpx + 1);
        grv[yy * W + xx] = Math.max(grv[yy * W + xx], depth * f);
      }
    }
  };
  for (const [v, u0, u1, w] of [
    [0.235, 0.00, 1.00, 1.7], [0.378, 0.00, 1.00, 1.7], [0.518, 0.00, 1.00, 1.4],
    [0.155, 0.08, 0.62, 1.1], [0.600, 0.20, 0.98, 1.1], [0.305, 0.30, 0.92, 1.0],
  ]) groove(u0 * W, v * H, u1 * W, v * H, w, 1.0);
  // vertical breaks between receiver sections
  for (const u of [0.145, 0.315, 0.505, 0.685, 0.860]) {
    groove(u * W, 0.10 * H, u * W, 0.66 * H, 1.3, 0.85);
  }
  // a handful of countersunk fastener dots
  for (let i = 0; i < 14; i++) {
    const cx = rand.next() * W, cy = (0.14 + rand.next() * 0.46) * H, r = 3 + rand.next() * 2;
    for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d = Math.hypot(dx, dy); if (d > r + 1) continue;
      const xx = ((Math.round(cx + dx) % W) + W) % W, yy = Math.round(cy + dy);
      if (yy < 0 || yy >= H) continue;
      grv[yy * W + xx] = Math.max(grv[yy * W + xx], 1 - Math.max(0, d - r + 1));
    }
  }

  /* ---- stencil runs.
   * Not a font: at 1080p the receiver flank is ~200 px across and these marks land
   * at 3-6 px tall, where a glyph and a bar of the same width are the same image.
   * They are drawn as proportioned bar runs, which is what survives the resample —
   * and what the reference's stencils actually read as at this distance. */
  const stencilRun = (u0, v0, hpx, chars, gap) => {
    let x = u0 * W;
    for (let c = 0; c < chars; c++) {
      const w = hpx * (0.42 + rand.next() * 0.36);
      if (rand.next() < 0.13) { x += w + gap; continue; }        // word space
      rect(sten, x, v0 * H, x + w, v0 * H + hpx, 1.0);
      // knock a light hole through so it does not read as a solid slab
      if (hpx > 7 && rand.next() < 0.55) {
        rect(sten, x + w * 0.28, v0 * H + hpx * 0.34, x + w * 0.75, v0 * H + hpx * 0.62, 0.0);
      }
      x += w + gap;
    }
  };
  stencilRun(0.075, 0.400, 26, 5, 6);      // big "MA5B" mark
  stencilRun(0.075, 0.325, 11, 12, 3);     // caliber / serial line
  stencilRun(0.075, 0.275, 10, 16, 3);
  stencilRun(0.360, 0.470, 9, 24, 3);      // the long fine-print run along the receiver
  stencilRun(0.700, 0.545, 13, 7, 4);      // stamp near the ejection port
  stencilRun(0.180, 0.185, 9, 9, 3);

  const data = new Uint8Array(W * H * 4);
  const gAt = (x, y) => grv[Math.min(H - 1, Math.max(0, y)) * W + ((x % W) + W) % W];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dv = (gAt(x, y + 1) - gAt(x, y - 1)) * 0.5;
      data[i * 4] = Math.max(0, Math.min(1, sten[i])) * 255;
      data[i * 4 + 1] = Math.max(0, Math.min(1, grv[i])) * 255;
      data[i * 4 + 2] = (Math.max(-1, Math.min(1, -dv * 1.8)) * 0.5 + 0.5) * 255;
      data[i * 4 + 3] = Math.max(0, Math.min(1, plate[i])) * 255;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** Glove: fabric weave + fuzz + stitch runs. Same channel layout. */
function makeWeaveTex(rand, N = 256) {
  const hgt = new Float32Array(N * N);
  const PER = 10;                             // weave period in texels
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const cx = Math.floor(x / PER), cy = Math.floor(y / PER);
      const over = ((cx + cy) & 1) === 0;      // plain weave over/under
      const fx = (x % PER) / PER, fy = (y % PER) / PER;
      const rib = over ? Math.sin(fy * Math.PI) : Math.sin(fx * Math.PI);
      const fuzz = (fbmT(x / N * 40, y / N * 40, 40, 3, 91) - 0.5) * 0.30;
      hgt[i] = rib * 0.5 + fuzz;
    }
  }
  // stitching: two parallel dashed runs
  for (let run = 0; run < 3; run++) {
    const y0 = (0.18 + run * 0.31) * N;
    for (let x = 0; x < N; x++) {
      if ((x % 9) > 5) continue;
      const yy = Math.round(y0 + Math.sin(x / N * Math.PI * 2 + run) * 4);
      for (let d = -1; d <= 1; d++) hgt[(((yy + d) % N + N) % N) * N + x] += 0.45 * (1 - Math.abs(d) * 0.5);
    }
  }
  const data = new Uint8Array(N * N * 4);
  const at = (x, y) => hgt[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const nx = Math.max(-1, Math.min(1, -(at(x + 1, y) - at(x - 1, y)) * 2.2));
      const ny = Math.max(-1, Math.min(1, -(at(x, y + 1) - at(x, y - 1)) * 2.2));
      data[i * 4] = (nx * 0.5 + 0.5) * 255;
      data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      data[i * 4 + 2] = Math.max(0, Math.min(1, 0.62 + hgt[i] * 0.5)) * 255;
      data[i * 4 + 3] = Math.max(0, Math.min(1, 0.28 + hgt[i] * 0.7)) * 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** UNSC eagle + brushed streaks for the milled rail recess (tangent-space normal). */
function makeRailNormalTex(rand, W = 512, H = 256) {
  const hgt = new Float32Array(W * H);
  // brushed streaks along U
  for (let y = 0; y < H; y++) {
    const bias = (h2i(0, y, 3) - 0.5) * 0.5;
    for (let x = 0; x < W; x++) {
      hgt[y * W + x] = bias * 0.35 + (fbmT(x / W * 90, y / H * 6, 90, 2, 17) - 0.5) * 0.5;
    }
  }
  // eagle: concentric wing arcs + a body wedge, engraved (negative height)
  const cxp = W * 0.5, cyp = H * 0.52, S = H * 0.40;
  const stamp = (px, py, a) => {
    const xi = Math.round(px), yi = Math.round(py);
    if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) return;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      hgt[(yi + dy) * W + xi + dx] += a * (dx === 0 && dy === 0 ? 1 : 0.35);
    }
  };
  for (let wing = 0; wing < 2; wing++) {
    const sgn = wing ? 1 : -1;
    for (let f = 0; f < 5; f++) {
      const r = S * (0.34 + f * 0.16);
      for (let i = 0; i <= 90; i++) {
        const a = (-0.42 + (i / 90) * 1.35) * Math.PI;
        stamp(cxp + sgn * Math.cos(a) * r * 1.55, cyp - Math.abs(Math.sin(a)) * r * 0.62, -0.30);
      }
    }
    for (let f = 0; f < 4; f++) {          // feather ticks
      for (let i = 0; i <= 22; i++) {
        const t = i / 22;
        stamp(cxp + sgn * S * (0.55 + f * 0.28), cyp - S * (0.08 + t * 0.34), -0.26);
      }
    }
  }
  for (let i = 0; i <= 40; i++) {          // head + body
    const t = i / 40;
    stamp(cxp, cyp - S * (0.55 - t * 0.95), -0.32);
    stamp(cxp + S * 0.06, cyp - S * (0.55 - t * 0.95), -0.28);
    stamp(cxp - S * 0.06, cyp - S * (0.55 - t * 0.95), -0.28);
  }
  for (let i = 0; i <= 60; i++) {          // banner under the bird
    const t = i / 60;
    stamp(cxp + (t - 0.5) * S * 2.0, cyp + S * (0.52 + Math.sin(t * Math.PI) * 0.10), -0.34);
  }
  const data = new Uint8Array(W * H * 4);
  const at = (x, y) => hgt[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const nx = Math.max(-1, Math.min(1, -(at(x + 1, y) - at(x - 1, y)) * 3.0));
      const ny = Math.max(-1, Math.min(1, (at(x, y + 1) - at(x, y - 1)) * 3.0));
      const nz = Math.sqrt(Math.max(0.02, 1 - nx * nx - ny * ny));
      data[i * 4] = (nx * 0.5 + 0.5) * 255;
      data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
      data[i * 4 + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/* -------------------------------------------------------------------------- */
/*  ammo counter panel                                                        */
/* -------------------------------------------------------------------------- */

/** Stroke-path digit font. Unit box (0,0)-(1,1), y down. Deterministic — no
 *  system font is consulted, because a font fallback would change the frame. */
const DIGITS = {
  '0': [[['M', 0.12, 0.30], ['Q', 0.12, 0.06, 0.50, 0.06], ['Q', 0.88, 0.06, 0.88, 0.30],
    ['L', 0.88, 0.70], ['Q', 0.88, 0.94, 0.50, 0.94], ['Q', 0.12, 0.94, 0.12, 0.70], ['Z']]],
  '1': [[['M', 0.24, 0.26], ['L', 0.54, 0.06], ['L', 0.54, 0.94]]],
  '2': [[['M', 0.12, 0.30], ['Q', 0.12, 0.06, 0.50, 0.06], ['Q', 0.88, 0.06, 0.88, 0.32],
    ['Q', 0.88, 0.54, 0.14, 0.94], ['L', 0.92, 0.94]]],
  '3': [[['M', 0.14, 0.08], ['L', 0.84, 0.08], ['L', 0.47, 0.41],
    ['Q', 0.90, 0.41, 0.90, 0.67], ['Q', 0.90, 0.94, 0.48, 0.94], ['Q', 0.22, 0.94, 0.12, 0.81]]],
  '4': [[['M', 0.72, 0.06], ['L', 0.09, 0.69], ['L', 0.95, 0.69]], [['M', 0.72, 0.33], ['L', 0.72, 0.94]]],
  '5': [[['M', 0.86, 0.08], ['L', 0.26, 0.08], ['L', 0.20, 0.43],
    ['Q', 0.52, 0.33, 0.72, 0.45], ['Q', 0.90, 0.58, 0.85, 0.74],
    ['Q', 0.78, 0.96, 0.43, 0.94], ['Q', 0.22, 0.92, 0.12, 0.82]]],
  '6': [[['M', 0.80, 0.10], ['Q', 0.40, 0.12, 0.25, 0.46], ['Q', 0.13, 0.70, 0.30, 0.86],
    ['Q', 0.51, 1.02, 0.72, 0.87], ['Q', 0.90, 0.73, 0.79, 0.56], ['Q', 0.66, 0.37, 0.34, 0.52]]],
  '7': [[['M', 0.10, 0.08], ['L', 0.90, 0.08], ['L', 0.42, 0.94]]],
  '8': [[['M', 0.50, 0.48], ['Q', 0.85, 0.44, 0.85, 0.25], ['Q', 0.85, 0.06, 0.50, 0.06],
    ['Q', 0.15, 0.06, 0.15, 0.25], ['Q', 0.15, 0.44, 0.50, 0.48],
    ['Q', 0.13, 0.52, 0.13, 0.72], ['Q', 0.13, 0.94, 0.50, 0.94],
    ['Q', 0.87, 0.94, 0.87, 0.72], ['Q', 0.87, 0.52, 0.50, 0.48]]],
  '9': [[['M', 0.22, 0.92], ['Q', 0.60, 0.90, 0.75, 0.56], ['Q', 0.87, 0.32, 0.70, 0.16],
    ['Q', 0.49, 0.00, 0.28, 0.15], ['Q', 0.10, 0.29, 0.21, 0.46], ['Q', 0.34, 0.65, 0.66, 0.50]]],
};

function strokeGlyph(g, paths, x, y, w, h, lw) {
  g.lineWidth = lw;
  g.lineJoin = 'round';
  g.lineCap = 'butt';
  for (const sub of paths) {
    g.beginPath();
    for (const c of sub) {
      if (c[0] === 'M') g.moveTo(x + c[1] * w, y + c[2] * h);
      else if (c[0] === 'L') g.lineTo(x + c[1] * w, y + c[2] * h);
      else if (c[0] === 'Q') g.quadraticCurveTo(x + c[1] * w, y + c[2] * h, x + c[3] * w, y + c[4] * h);
      else if (c[0] === 'Z') g.closePath();
    }
    g.stroke();
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/**
 * The counter face. Kept dim on purpose: the reference panel peaks around display
 * code 210 on the digits and sits near 40 on the field, and it casts no light on the
 * housing at all. An emissive panel bright enough to light its own bezel is the
 * fastest way to make a viewmodel look like a toy.
 */
function makeCounterCanvas(W = 320, H = 420) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const CYAN = '#cfeeff', DIM = '#5f9db8';

  function draw(ammo, reloadGlow) {
    // ---- field: dark teal-black with a top-down lift
    g.clearRect(0, 0, W, H);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#0d2530');
    grd.addColorStop(0.55, '#0a1d26');
    grd.addColorStop(1, '#071219');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    // ---- UNSC wing glyph, top
    g.save();
    g.translate(W * 0.5, H * 0.105);
    g.fillStyle = CYAN;
    for (let i = 0; i < 3; i++) {
      const s = 1 - i * 0.20, yy = i * H * 0.017;
      g.globalAlpha = 0.95 - i * 0.18;
      g.beginPath();
      g.moveTo(-W * 0.085 * s, yy - H * 0.012);
      g.lineTo(0, yy + H * 0.016);
      g.lineTo(W * 0.085 * s, yy - H * 0.012);
      g.lineTo(W * 0.062 * s, yy - H * 0.020);
      g.lineTo(0, yy + H * 0.004);
      g.lineTo(-W * 0.062 * s, yy - H * 0.020);
      g.closePath();
      g.fill();
    }
    g.restore();
    g.globalAlpha = 1;

    // ---- upper sub-panel: reload / rotate glyph
    g.strokeStyle = 'rgba(120,190,220,0.30)';
    g.lineWidth = 2;
    roundRect(g, W * 0.15, H * 0.185, W * 0.70, H * 0.29, 12);
    g.fillStyle = 'rgba(30,80,100,0.22)';
    g.fill(); g.stroke();
    // faint crosshair rules
    g.strokeStyle = 'rgba(150,210,240,0.16)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(W * 0.5, H * 0.195); g.lineTo(W * 0.5, H * 0.465);
    g.moveTo(W * 0.17, H * 0.33); g.lineTo(W * 0.83, H * 0.33);
    g.stroke();
    // circular arrow with a comet tail
    const ccx = W * 0.50, ccy = H * 0.325, rr = W * 0.115;
    g.strokeStyle = CYAN;
    g.globalAlpha = 0.55 + 0.45 * reloadGlow;
    g.lineWidth = W * 0.030;
    g.beginPath();
    g.arc(ccx, ccy, rr, -0.35 * Math.PI, 1.15 * Math.PI);
    g.stroke();
    g.fillStyle = CYAN;
    g.beginPath();
    g.moveTo(ccx - rr * 1.05, ccy - rr * 0.62);
    g.quadraticCurveTo(ccx - rr * 0.20, ccy - rr * 1.55, ccx - rr * 0.05, ccy - rr * 0.72);
    g.quadraticCurveTo(ccx - rr * 0.55, ccy - rr * 0.42, ccx - rr * 1.05, ccy - rr * 0.62);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;

    // ---- lower sub-panel: the number
    g.strokeStyle = 'rgba(120,190,220,0.34)';
    g.lineWidth = 2;
    roundRect(g, W * 0.09, H * 0.505, W * 0.82, H * 0.315, 10);
    g.fillStyle = 'rgba(24,70,90,0.24)';
    g.fill(); g.stroke();
    // corner ticks
    g.strokeStyle = 'rgba(160,220,245,0.35)';
    g.lineWidth = 2;
    for (const [tx, ty, dx, dy] of [[0.12, 0.525, 1, 0], [0.88, 0.525, -1, 0],
      [0.12, 0.80, 1, 0], [0.88, 0.80, -1, 0]]) {
      g.beginPath();
      g.moveTo(W * tx, H * ty); g.lineTo(W * (tx + dx * 0.05), H * (ty + dy * 0.02));
      g.stroke();
    }

    const txt = String(Math.max(0, Math.min(99, ammo | 0))).padStart(2, '0');
    const dw = W * 0.30, dh = H * 0.225, gap = W * 0.05;
    const total = dw * txt.length + gap * (txt.length - 1);
    let px = (W - total) * 0.5, py = H * 0.555;
    g.strokeStyle = '#f2fbff';
    for (const ch of txt) {
      strokeGlyph(g, DIGITS[ch] || DIGITS['0'], px, py, dw, dh, W * 0.052);
      px += dw + gap;
    }

    // ---- magazine bar
    const bx = W * 0.28, bw = W * 0.44, by = H * 0.862, bh = H * 0.022;
    g.fillStyle = 'rgba(30,80,100,0.45)';
    roundRect(g, bx, by, bw, bh, bh * 0.5); g.fill();
    const frac = Math.max(0, Math.min(1, ammo / MAG_SIZE));
    g.fillStyle = CYAN;
    roundRect(g, bx, by, Math.max(bh, bw * frac), bh, bh * 0.5); g.fill();
    g.fillStyle = DIM;
    for (let i = 0; i < 2; i++) {
      g.fillRect(W * (0.155 + i * 0.66), by + bh * 0.25, W * 0.020, bh * 0.5);
    }

    // ---- scanlines + vignette: kills the "flat sticker" read
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = 'rgba(0,0,0,0.30)';
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    const vg = g.createRadialGradient(W * 0.5, H * 0.42, W * 0.15, W * 0.5, H * 0.5, W * 0.85);
    vg.addColorStop(0, 'rgba(255,255,255,1)');
    vg.addColorStop(1, 'rgba(70,90,100,1)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    // glass sheen, additive, biased to the upper left like the reference
    g.globalCompositeOperation = 'lighter';
    const sh = g.createLinearGradient(0, 0, W * 0.9, H);
    sh.addColorStop(0, 'rgba(120,170,200,0.10)');
    sh.addColorStop(0.35, 'rgba(60,90,110,0.03)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }

  return { canvas: cv, draw };
}

/** LED + "PUSH" decal strip on the receiver flank. */
function makeLedCanvas(W = 128, H = 64) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  // tick wedge above the lamp
  g.strokeStyle = '#c9d2d8';
  g.lineWidth = 1.6;
  for (let i = 0; i < 5; i++) {
    g.globalAlpha = 0.35 + i * 0.10;
    g.beginPath();
    g.moveTo(W * 0.16 + i * W * 0.028, H * 0.30);
    g.lineTo(W * 0.16 + i * W * 0.028, H * 0.30 - H * (0.10 + i * 0.035));
    g.stroke();
  }
  g.globalAlpha = 1;
  // lamp
  g.fillStyle = '#9dffb4';
  roundRect(g, W * 0.13, H * 0.34, W * 0.14, H * 0.34, W * 0.05);
  g.fill();
  // "PUSH" in stroke letterforms
  g.strokeStyle = '#b8c2c8';
  g.lineWidth = 1.5;
  g.lineCap = 'butt';
  const lx = W * 0.36, ly = H * 0.40, lh = H * 0.26, lw = W * 0.075, sp = W * 0.095;
  const P = (i, cmds) => {
    g.beginPath();
    for (const c of cmds) {
      const X = lx + i * sp + c[1] * lw, Y = ly + c[2] * lh;
      if (c[0] === 'M') g.moveTo(X, Y); else g.lineTo(X, Y);
    }
    g.stroke();
  };
  P(0, [['M', 0, 1], ['L', 0, 0], ['L', 1, 0], ['L', 1, 0.5], ['L', 0, 0.5]]);      // P
  P(1, [['M', 0, 0], ['L', 0, 1], ['L', 1, 1], ['L', 1, 0]]);                       // U
  P(2, [['M', 1, 0], ['L', 0, 0], ['L', 0, 0.5], ['L', 1, 0.5], ['L', 1, 1], ['L', 0, 1]]); // S
  P(3, [['M', 0, 0], ['L', 0, 1], ['M', 0, 0.5], ['L', 1, 0.5], ['M', 1, 0], ['L', 1, 1]]); // H
  return cv;
}

/* ========================================================================== */
/*  the MA5B                                                                  */
/* ========================================================================== */

const M4 = () => new THREE.Matrix4();
function xform(x, y, z, rx = 0, ry = 0, rz = 0, s = 1) {
  const m = M4();
  m.compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(s, s, s));
  return m;
}
function push(list, src, m) {
  const g = (src instanceof MB) ? src.geometry() : src;
  if (m) g.applyMatrix4(m);
  list.push(g);
  return g;
}

/** Flat cap of a profile with box-normalised UVs (used for the counter screen). */
function capProfileUV(mb, prof, z, dir, mask) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of prof) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  // CanvasTexture uploads with flipY, and the panel is read from +Z, so the
  // profile box maps mirrored in u and upright in v.
  const uv = (p) => [(p.x - x0) / (x1 - x0), (p.y - y0) / (y1 - y0)];
  let cx = 0, cy = 0;
  for (const p of prof) { cx += p.x; cy += p.y; }
  cx /= prof.length; cy /= prof.length;
  const C = { x: cx, y: cy };
  const n = [0, 0, dir];
  for (let i = 0; i < prof.length; i++) {
    const a = prof[i], b = prof[(i + 1) % prof.length];
    const A = [a.x, a.y, z], B = [b.x, b.y, z], Cc = [cx, cy, z];
    const uA = uv(a), uB = uv(b), uC = uv(C);
    if (dir > 0) {
      mb.vert(Cc[0], Cc[1], z, n[0], n[1], n[2], mask[0], mask[1], uC[0], uC[1]);
      mb.vert(A[0], A[1], z, n[0], n[1], n[2], mask[0], mask[1], uA[0], uA[1]);
      mb.vert(B[0], B[1], z, n[0], n[1], n[2], mask[0], mask[1], uB[0], uB[1]);
    } else {
      mb.vert(Cc[0], Cc[1], z, n[0], n[1], n[2], mask[0], mask[1], uC[0], uC[1]);
      mb.vert(B[0], B[1], z, n[0], n[1], n[2], mask[0], mask[1], uB[0], uB[1]);
      mb.vert(A[0], A[1], z, n[0], n[1], n[2], mask[0], mask[1], uA[0], uA[1]);
    }
  }
}

/** Ring of quads between two profiles with the same point count (rim faces). */
function ringBetween(mb, outer, inner, zo, zi, n, mo, mi, so = 1, si = 1) {
  const N = outer.length;
  for (let i = 0; i < N; i++) {
    const i2 = (i + 1) % N;
    const a = [outer[i].x * so, outer[i].y * so, zo];
    const b = [outer[i2].x * so, outer[i2].y * so, zo];
    const c = [inner[i2].x * si, inner[i2].y * si, zi];
    const d = [inner[i].x * si, inner[i].y * si, zi];
    mb.quad(a, b, c, d, n, mo, mo, mi, mi);
  }
}

/** Axis-aligned XZ panel with a circular hole, y = const, normal +Y. */
function panelWithHole(mb, x0, x1, z0, z1, y, cx, cz, r, segs, mask) {
  const n = [0, 1, 0];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const hit = (a) => {
      const dx = Math.cos(a), dz = Math.sin(a);
      let t = 1e9;
      if (dx > 1e-6) t = Math.min(t, (x1 - cx) / dx); else if (dx < -1e-6) t = Math.min(t, (x0 - cx) / dx);
      if (dz > 1e-6) t = Math.min(t, (z1 - cz) / dz); else if (dz < -1e-6) t = Math.min(t, (z0 - cz) / dz);
      return [cx + dx * t, y, cz + dz * t];
    };
    const i0 = [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r];
    const i1 = [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r];
    mb.quad(i0, hit(a0), hit(a1), i1, n, mask, mask, mask, mask);
  }
}

/** Countersunk port: chamfer ring, bore wall, dark floor. */
function portHole(mb, cx, cz, yTop, r, depth, segs = 20) {
  const rIn = r * 0.72;
  const mE = [1.0, 1.0], mM = [0.25, 0.55], mF = [0, 0.28];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const P = (a, rad, y) => [cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad];
    const nA = (a) => nrm3([Math.cos(a) * 0.75, 0.66, Math.sin(a) * 0.75]);
    const nB = (a) => nrm3([Math.cos(a), 0.05, Math.sin(a)]);
    // chamfer
    mb.quadN(P(a0, r, yTop), nA(a0), P(a1, r, yTop), nA(a1),
      P(a1, rIn, yTop - r * 0.30), nA(a1), P(a0, rIn, yTop - r * 0.30), nA(a0), mE, mE, mM, mM);
    // bore
    mb.quadN(P(a0, rIn, yTop - r * 0.30), nB(a0), P(a1, rIn, yTop - r * 0.30), nB(a1),
      P(a1, rIn, yTop - depth), nB(a1), P(a0, rIn, yTop - depth), nB(a0), mM, mM, mF, mF);
    // floor
    mb.tri([cx, yTop - depth, cz], P(a1, rIn, yTop - depth), P(a0, rIn, yTop - depth), [0, 1, 0], mF, mF, mF);
  }
}

/** Tapered rounded segment along -Z. Fingers, forearms, muzzle. */
function segRounded(len, w0, h0, w1, h1, r, o = {}) {
  const prof = rrProfile(1, h0 / w0, r / w0, o.corner ?? 3);
  const st = [];
  const K = o.steps || 5;
  const capF = o.capF ?? 0.18, capB = o.capB ?? 0.18;
  for (let i = 0; i <= K; i++) {
    const t = i / K;
    let sx = mix(w0, w1, t), sy = mix(h0, h1, t) * (w0 / h0) * (h0 / w0);
    sy = mix(h0, h1, t);
    let f = 1;
    const eT = Math.min(t / capF, (1 - t) / capB);
    if (eT < 1) f = Math.sqrt(Math.max(0.05, 1 - (1 - eT) * (1 - eT)));
    st.push({ z: -len * t, sx: sx * f, sy: sy * f, edge: eT < 1 ? 0.55 : 0.12, ao: o.ao ?? 1 });
  }
  for (let i = 0; i < st.length; i++) {
    const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
    st[i].nz = (b.z - a.z) !== 0 ? -((b.sx + b.sy) - (a.sx + a.sy)) * 0.5 / (b.z - a.z) : 0;
  }
  return extrudeProfile(prof, st, { mb: o.mb, capAo: 0.4 });
}

/**
 * Assemble the rifle. Returns geometry lists keyed by material, plus the sub-groups
 * that animate (magazine, charging handle/bolt, left hand, right forearm).
 *
 * Local frame: +X right, +Y up, -Z down the barrel. Origin sits inside the receiver
 * just above the magwell. Everything is in metres at true scale — an MA5B receiver is
 * 52 mm across and the chamfers are 3-4 mm, which is exactly the size that makes a
 * rim highlight one to three pixels wide at this distance. Fudging the scale to
 * "look right" is what turns a weapon into a plastic prop.
 */
function buildRifle(rand) {
  const G = {
    body: [], rail: [], poly: [], glove: [], plate: [], screen: [], engrave: [], led: [],
  };
  const parts = { mag: [], bolt: [], boltPoly: [], handL: [], armR: [] };

  /* ---------------------------------------------------------- receiver ---- */
  push(G.body, chamferBox(0.0680, 0.0910, 0.340, 0.0052, { offset: [0, -0.0105, 0.005], aoBottom: 0.80 }));

  /* ------------------------------------------------- carry-handle shell ---- *
   * The reference MA5B's dominant mass is a rounded, TAPERED shell that sweeps from
   * low at the fore-end up over the receiver and back to the counter housing. The
   * previous build had a flat untapered rail prism instead, which is why the gun read
   * as a plank and why the silhouette went thin above the receiver: measured
   * per-scanline coverage inside the weapon ROI was y900 469/922 against the
   * reference's 640.
   *
   * Built as one extrusion of a dome cross-section with independent sx/sy per station
   * so the shell can grow in height without growing in width — a uniform scale gives
   * a cone, and a cone is exactly the "flat plank with a bevel" read we are replacing.
   */
  {
    const dome = roundedPoly([[0.5, 0.0], [0.5, 0.60], [0.30, 1.0], [-0.30, 1.0], [-0.5, 0.60], [-0.5, 0.0]],
      [0.05, 0.16, 0.20, 0.20, 0.16, 0.05], 3);
    const base = 0.0305;
    const st = [
      { z: -0.2080, sx: 0.030, sy: 0.010, oy: base, edge: 0.9, ao: 0.75 },
      { z: -0.2000, sx: 0.048, sy: 0.024, oy: base, edge: 0.55 },
      { z: -0.1700, sx: 0.058, sy: 0.042, oy: base, edge: 0.0 },
      { z: -0.1200, sx: 0.064, sy: 0.050, oy: base, edge: 0.0 },
      { z: -0.0600, sx: 0.070, sy: 0.058, oy: base, edge: 0.0 },
      { z: 0.0100, sx: 0.070, sy: 0.060, oy: base, edge: 0.0 },
      { z: 0.0620, sx: 0.068, sy: 0.056, oy: base, edge: 0.0 },
      { z: 0.0900, sx: 0.056, sy: 0.044, oy: base, edge: 0.55 },
      { z: 0.0960, sx: 0.036, sy: 0.026, oy: base, edge: 0.9, ao: 0.75 },
    ];
    for (let i = 0; i < st.length; i++) {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
      st[i].nz = -((b.sx + b.sy) - (a.sx + a.sy)) * 0.5 / (b.z - a.z);
    }
    push(G.body, extrudeProfile(dome, st, { capAo: 0.5 }));
    // the two long panel seams where the shell halves meet the receiver
    for (const sx of [-1, 1]) {
      push(G.body, chamferBox(0.0060, 0.0075, 0.250, 0.0016,
        { offset: [sx * 0.0322, 0.0330, -0.055], edge: 1.2, ao: 0.7 }));
    }
  }
  // side relief panels: two shallow milled flats, one per flank
  for (const sx of [-1, 1]) {
    const mb = new MB();
    recess(mb, -0.075, 0.075, -0.024, 0.024, 0, 0.0038, 0.0038, 0.42);
    push(G.body, mb, xform(sx * 0.0312, -0.016, 0.045, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2, 0));
  }
  // rear stock block
  push(G.body, chamferBox(0.056, 0.076, 0.090, 0.005, { offset: [0, -0.006, 0.212], aoBottom: 0.7 }));

  /* -------------------------------------------------------------- rail ---- */
  {
    const mb = new MB();
    /* The rail now caps the carry-handle shell instead of standing on the bare
     * receiver, and its milled recess is a SIGHT CHANNEL, not a trough: at 36 x 132 mm
     * the old recess was 20% of the weapon's visible area and read as an open box.
     * 24 x 96 mm, sunk into a shell top at y = 0.1005. */
    const x1 = 0.0200, yTop = 0.0925, c = 0.0034;
    const z0 = -0.150, z1 = 0.082;
    const rx0 = -0.0088, rx1 = 0.0088;       // recess outer
    const rz0 = -0.040, rz1 = 0.056;
    const mF = [0, 1], mE = [1, 1], mLo = [0.3, 1];
    // top face: four borders around the milled recess
    const q = (a, b, cc, d, mk) => mb.quad(a, b, cc, d, [0, 1, 0], mk, mk, mk, mk);
    q([-x1 + c, yTop, z0 + c], [x1 - c, yTop, z0 + c], [x1 - c, yTop, rz0], [-x1 + c, yTop, rz0], mF);
    q([-x1 + c, yTop, rz0], [rx0, yTop, rz0], [rx0, yTop, rz1], [-x1 + c, yTop, rz1], mF);
    q([rx1, yTop, rz0], [x1 - c, yTop, rz0], [x1 - c, yTop, rz1], [rx1, yTop, rz1], mF);
    // rear border carries the circular port
    panelWithHole(mb, -x1 + c, x1 - c, rz1, z1 - c, yTop, 0, 0.068, 0.0070, 16, mF);
    portHole(mb, 0, 0.068, yTop, 0.0070, 0.008, 16);
    // recess lip + floor
    const lip = 0.0036, fy = yTop - 0.0038;
    const wall = (a, b, cc, d, n) => mb.quad(a, b, cc, d, nrm3(n), mE, mE, mLo, mLo);
    wall([rx0, yTop, rz0], [rx1, yTop, rz0], [rx1 - lip, fy, rz0 + lip], [rx0 + lip, fy, rz0 + lip], [0, 0.7, 1]);
    wall([rx1, yTop, rz1], [rx0, yTop, rz1], [rx0 + lip, fy, rz1 - lip], [rx1 - lip, fy, rz1 - lip], [0, 0.7, -1]);
    wall([rx1, yTop, rz0], [rx1, yTop, rz1], [rx1 - lip, fy, rz1 - lip], [rx1 - lip, fy, rz0 + lip], [-1, 0.7, 0]);
    wall([rx0, yTop, rz1], [rx0, yTop, rz0], [rx0 + lip, fy, rz0 + lip], [rx0 + lip, fy, rz1 - lip], [1, 0.7, 0]);
    // rail sides + top chamfers
    for (const sx of [-1, 1]) {
      const n = nrm3([sx, 1, 0]);
      mb.quad([sx * (x1 - c), yTop, z0 + c], [sx * (x1 - c), yTop, z1 - c],
        [sx * x1, yTop - c, z1 - c], [sx * x1, yTop - c, z0 + c],
        sx > 0 ? n : n, mE, mE, mLo, mLo);
      mb.quad([sx * x1, yTop - c, z0], [sx * x1, yTop - c, z1], [sx * x1, 0.082, z1], [sx * x1, 0.082, z0],
        [sx, 0, 0], mLo, mLo, [0, 0.9], [0, 0.9]);
    }
    // front + rear end chamfers
    for (const sz of [-1, 1]) {
      const zz = sz < 0 ? z0 : z1;
      const n = nrm3([0, 1, sz]);
      mb.quad([-x1 + c, yTop, zz + sz * -c], [x1 - c, yTop, zz + sz * -c],
        [x1 - c, yTop - c, zz], [-x1 + c, yTop - c, zz], n, mE, mE, mLo, mLo);
    }
    push(G.rail, mb);
    // the engraved floor is its own material (UV-mapped normal map, no triplanar)
    const eb = new MB();
    const fx0 = rx0 + lip, fx1 = rx1 - lip, fz0 = rz0 + lip, fz1 = rz1 - lip;
    const m = [0, 0.72];
    const uv = (x, z) => [(z - fz0) / (fz1 - fz0) * 2.0, (x - fx0) / (fx1 - fx0)];
    eb.quadN([fx0, fy, fz0], [0, 1, 0], [fx1, fy, fz0], [0, 1, 0], [fx1, fy, fz1], [0, 1, 0],
      [fx0, fy, fz1], [0, 1, 0], m, m, m, m, uv(fx0, fz0), uv(fx1, fz0), uv(fx1, fz1), uv(fx0, fz1));
    push(G.engrave, eb);
  }

  /* ------------------------------------------------- ammo counter housing -- */
  {
    const tri = roundedPoly([[0, 0.0790], [-0.0425, -0.0470], [0.0425, -0.0470]], [0.0150, 0.0125, 0.0125], 4);
    const st = [
      { z: -0.0470, s: 0.895, edge: 0.55, ao: 0.9 },
      { z: -0.0428, s: 0.985, edge: 1.0 },
      { z: -0.0390, s: 1.000, edge: 0.0 },
      { z: 0.0300, s: 1.000, edge: 0.0 },
      { z: 0.0342, s: 0.985, edge: 1.0 },
      { z: 0.0380, s: 0.930, edge: 0.55 },
    ];
    const mb = extrudeProfile(tri, st, { capBack: false, capFront: true, capAo: 0.6 });
    // rear face: flat annulus (the thick bezel), then a step wall down to the screen
    const mBez = [0.15, 0.95], mIn = [0.1, 0.45];
    ringBetween(mb, tri, tri, 0.0380, 0.0380, [0, 0, 1], mBez, mBez, 0.930, 0.800);
    ringBetween(mb, tri, tri, 0.0380, 0.0345, [0, 0, 1], mBez, mIn, 0.800, 0.755);
    push(G.body, mb, xform(0, 0.0940, -0.1140, -10 * DEG, 0, 0));
    // the screen itself
    const sc = new MB();
    const inner = tri.map((p) => ({ x: p.x * 0.755, y: p.y * 0.755, smooth: p.smooth }));
    capProfileUV(sc, inner, 0.0345, 1, [0, 1]);
    push(G.screen, sc, xform(0, 0.0940, -0.1140, -10 * DEG, 0, 0));
    // two micro fasteners on the housing foot
    for (const sx of [-1, 1]) {
      push(G.body, chamferBox(0.008, 0.0045, 0.008, 0.0013,
        { offset: [sx * 0.023, 0.0478, -0.0855], edge: 1.2 }));
    }
  }

  /* ------------------------------------------------------------ shroud ---- */
  {
    const prof = rrProfile(0.0790, 0.1140, 0.0130, 3);
    const zR = -0.138, zF = -0.3800;
    const st = [];
    const seams = [-0.186, -0.234, -0.282, -0.330];
    const sAt = (z) => mix(1.0, 0.905, (zR - z) / (zR - zF));
    st.push({ z: zR + 0.0000, s: sAt(zR) * 0.955, edge: 0.6, ao: 0.85 });
    st.push({ z: zR - 0.0035, s: sAt(zR), edge: 1.0 });
    for (const sz of seams) {
      st.push({ z: sz + 0.0060, s: sAt(sz), edge: 0.0 });
      st.push({ z: sz + 0.0022, s: sAt(sz) * 0.985, edge: 0.9 });
      st.push({ z: sz - 0.0022, s: sAt(sz) * 0.962, edge: 0.15, ao: 0.42 });
      st.push({ z: sz - 0.0060, s: sAt(sz) * 0.988, edge: 0.9 });
    }
    st.push({ z: zF + 0.0080, s: sAt(zF), edge: 0.0 });
    st.push({ z: zF + 0.0035, s: sAt(zF) * 0.975, edge: 1.0 });
    st.push({ z: zF, s: sAt(zF) * 0.900, edge: 0.55, ao: 0.8 });
    st.sort((a, b) => a.z - b.z);
    push(G.body, extrudeProfile(prof, st, { capAo: 0.5 }), xform(0, 0.0020, 0));

    // raised latch tabs where the seams meet the top-left edge
    for (let i = 0; i < seams.length; i++) {
      push(G.body, chamferBox(0.011, 0.0065, 0.028, 0.0017,
        { offset: [-0.0368, 0.0430, seams[i] + 0.001], edge: 1.15 }));
    }

    // slotted cooling vent on the left face, with slats
    {
      const mb = new MB();
      recess(mb, -0.052, 0.052, -0.0240, 0.0240, 0, 0.022, 0.0042, 0.14);
      push(G.body, mb, xform(-0.0390, -0.0100, -0.2620, 0, Math.PI / 2, 0));
      for (let i = 0; i < 5; i++) {
        const zz = -0.2620 + (i - 2) * 0.0205;
        push(G.body, chamferBox(0.008, 0.038, 0.0072, 0.0014,
          { offset: [-0.0372, -0.0100, zz], edge: 1.1, ao: 0.55 }));
      }
    }
    // muzzle: barrel stub past the shroud
    push(G.body, segRounded(0.040, 0.0125, 0.0125, 0.0110, 0.0110, 0.0125,
      { steps: 3, capF: 0.05, capB: 0.30 }), xform(0, 0.002, -0.3780));
  }

  /* -------------------------------------------------- fore-end / handguard */
  push(G.poly, chamferBox(0.0640, 0.0430, 0.1400, 0.0055,
    { offset: [0, -0.0720, -0.2750], aoBottom: 0.72 }));
  for (let i = 0; i < 6; i++) {   // finger grooves on the underside
    push(G.poly, chamferBox(0.056, 0.0065, 0.0080, 0.0019,
      { offset: [0, -0.0940, -0.2200 - i * 0.0190], edge: 0.9, ao: 0.6 }));
  }

  /* -------------------------------------------- charging handle (animates) */
  push(parts.boltPoly, ribbedCylinder(0.0132, 0.1180, 15, 0.0016, { radial: 18 }),
    xform(-0.0378, -0.0140, -0.0600));

  /* ------------------------------------------------------ magazine (anim) */
  push(parts.mag, chamferBox(0.0455, 0.1080, 0.0760, 0.0036,
    { offset: [0, -0.1010, 0.0480], aoBottom: 0.65 }));
  push(parts.mag, chamferBox(0.0480, 0.0135, 0.0780, 0.0030,
    { offset: [0, -0.0480, 0.0480], edge: 1.1 }));
  for (let i = 0; i < 3; i++) {   // witness slots
    push(parts.mag, chamferBox(0.0060, 0.0180, 0.0058, 0.0012,
      { offset: [-0.0200, -0.0850 - i * 0.0230, 0.0480], edge: 1.0, ao: 0.5 }));
  }

  /* ------------------------------------------------- grip + trigger group */
  push(G.poly, chamferBox(0.0420, 0.1060, 0.0520, 0.0065,
    { offset: [0, -0.0980, 0.1420], aoBottom: 0.6 }));
  push(G.body, chamferBox(0.0360, 0.0170, 0.0660, 0.0032,
    { offset: [0, -0.0600, 0.1080], ao: 0.65 }));

  /* ----------------------------------------------------------- LED decal -- */
  {
    const mb = new MB();
    const m = [0, 1];
    const x = -0.03105;
    mb.quadN([x, -0.0130, 0.0330], [-1, 0, 0], [x, -0.0130, -0.0060], [-1, 0, 0],
      [x, -0.0325, -0.0060], [-1, 0, 0], [x, -0.0325, 0.0330], [-1, 0, 0],
      m, m, m, m, [0, 0], [1, 0], [1, 1], [0, 1]);
    push(G.led, mb);
  }

  return { G, parts };
}

/**
 * Hands. The reference gives them very little tonal range — a dark soft mass with
 * hard armour plates catching the only highlights — so the budget goes into the
 * silhouette and the plates, not into anatomy that would never be resolved.
 */
/** Left-glove and right-forearm mounts, in the rifle's local frame. Solved offline
 *  against the reference silhouette lobes by `node tools/_wpntri.mjs hands`. */
const HAND_L = { p: [-0.0329, -0.0817, -0.1976], r: [0.4473, 0.4991, 0.3360] };
const ARM_R = { p: [0.0850, 0.0100, 0.0700], r: [-0.3241, -0.6599, 0.3643] };

function buildHands(G, parts, o = {}) {
  const HL = o.handL || HAND_L, AR = o.armR || ARM_R;
  /* ------------------------------------------------- left hand on the fore-end */
  // Solved against the fore-end box, which sits at [0, -0.0720, -0.2750] with half
  // extents 0.0215 (y) / 0.070 (z): the palm has to contact its underside, so the
  // back-of-hand box (half height 0.0185) centres near y -0.105. The old -0.1150 put
  // the whole hand ~40 mm clear of the handguard and it read as a knife lying on the
  // sand rather than a grip. Verified by capture, not by arithmetic.
  const H = xform(HL.p[0], HL.p[1], HL.p[2], HL.r[0], HL.r[1], HL.r[2]);
  const mul = (a, b) => a.clone().multiply(b);

  // back of hand
  push(parts.handL, chamferBox(0.1010, 0.0490, 0.1090, 0.0135, { offset: [0.004, 0, 0] }), H.clone());
  // wrist + cuff
  push(parts.handL, chamferBox(0.0890, 0.0540, 0.0600, 0.0125, { offset: [-0.0620, -0.0060, 0] }), H.clone());
  push(parts.handL, chamferBox(0.0970, 0.0640, 0.0280, 0.0072,
    { offset: [-0.0910, -0.0070, 0], edge: 1.1 }), H.clone());
  // forearm, tapering away from the camera
  // Longer, thicker, and angled DOWN-left: a left arm enters the frame from the
  // bottom-left going up-right. The old one ran horizontally in from the left at
  // mid-receiver height, which no left arm can do, and it left the reference's
  // bottom-left lobe empty (measured coverage y1079 663/922 against 922).
  push(parts.handL, segRounded(0.250, 0.0480, 0.0340, 0.0400, 0.0290, 0.0190,
    { steps: 6, capF: 0.09, capB: 0.05 }),
  mul(H, xform(-0.0950, -0.0180, 0, 0, 108 * DEG, -52 * DEG)));

  // knuckle plates + proximal finger segments
  for (let i = 0; i < 4; i++) {
    const z = -0.0360 + i * 0.0245;
    // `spread` used to be passed as the rx argument — the fingers were being ROTATED
    // about X instead of splayed, so all four pivoted into each other and into the
    // hand box, which is where the triangular spikes came from. It is a translation.
    const spread = (i - 1.5) * 0.0055;
    const F = mul(H, xform(0.0420, 0.0020, z + spread, 0, 0, 34 * DEG));
    // proximal segment
    push(parts.handL, segRounded(0.0370, 0.0108, 0.0124, 0.0100, 0.0116, 0.0074,
      { steps: 3, capF: 0.12, capB: 0.12 }), mul(F, xform(0, 0, 0, 0, 90 * DEG, 0)));
    // armoured knuckle plate, standing proud
    push(G.plate, chamferBox(0.0225, 0.0070, 0.0186, 0.0026,
      { offset: [0.0105, 0.0116, 0], edge: 1.25 }), F.clone());
    // middle segment, curling over the guard
    const F2 = mul(F, xform(0.0370, 0.0012, 0, 0, 0, 62 * DEG));
    push(parts.handL, segRounded(0.0310, 0.0100, 0.0116, 0.0094, 0.0106, 0.0072,
      { steps: 3, capF: 0.12, capB: 0.12 }), mul(F2, xform(0, 0, 0, 0, 90 * DEG, 0)));
    push(G.plate, chamferBox(0.0162, 0.0060, 0.0166, 0.0024,
      { offset: [0.0092, 0.0102, 0], edge: 1.25 }), F2.clone());
  }
  // thumb, lying along the guard
  {
    const T = mul(H, xform(0.0225, -0.0060, -0.0520, -28 * DEG, -40 * DEG, 18 * DEG));
    push(parts.handL, segRounded(0.0450, 0.0138, 0.0150, 0.0122, 0.0132, 0.0094,
      { steps: 3 }), mul(T, xform(0, 0, 0, 0, 90 * DEG, 0)));
    push(G.plate, chamferBox(0.0186, 0.0062, 0.0174, 0.0024,
      { offset: [0.0175, 0.0100, 0], edge: 1.2 }), T.clone());
  }

  /* --------------------------------- right forearm, bottom-right of the frame */
  const R = xform(AR.p[0], AR.p[1], AR.p[2], AR.r[0], AR.r[1], AR.r[2]);
  push(parts.armR, segRounded(0.230, 0.0560, 0.0500, 0.0400, 0.0380, 0.0230,
    { steps: 6, capF: 0.08, capB: 0.16 }), mul(R, xform(0, 0, 0, 0, 155 * DEG, 0)));
  // MJOLNIR forearm plate
  push(G.plate, chamferBox(0.0620, 0.0180, 0.1050, 0.0070,
    { offset: [0.0060, 0.0400, 0.0450], edge: 1.15 }), R.clone());
  push(G.plate, chamferBox(0.0480, 0.0150, 0.0520, 0.0055,
    { offset: [0.0140, 0.0330, -0.0400], edge: 1.15 }), R.clone());
}

/* ========================================================================== */
/*  materials                                                                 */
/* ========================================================================== */

const VM_PARS = /* glsl */`
uniform sampler2D tDetail;
uniform sampler2D tDecal;
uniform vec4  uDecalMap;      // xy = scale(z,y), zw = offset
uniform float uDecalAmt;      // 0 disables the whole flank-decal path
uniform vec3  uStencilCol;
uniform vec3  uRailStreak;    // x = strength, y = centre in object X, z = 1/width
uniform vec3  uWornCol;
uniform float uDetailScale;
uniform float uNormalStr;
uniform float uWearAmt;
uniform float uRoughVar;
uniform float uGrime;
uniform float uAoDepth;
uniform float uSpecAA;
uniform float uCastAo;
uniform mat3  normalMatrix;
varying vec3 vObjPosVM;
varying vec3 vObjNrmVM;
varying vec2 vMaskVM;
varying float vAoVM;
`;

/**
 * Triplanar surface authoring in OBJECT space.
 *
 * Object space, not world space: the viewmodel's world transform changes every frame
 * (sway, bob, recoil), and world-space projection would make every scratch swim
 * across the metal as the gun moves — the single most obvious "procedural" tell there
 * is. Object space costs one extra varying and pins the detail to the surface.
 */
const VM_FRAG = /* glsl */`
vec3 oN = normalize(vObjNrmVM);
vec3 aw = abs(oN); aw = aw*aw; aw = aw*aw;
aw /= max(aw.x + aw.y + aw.z, 1e-4);
vec2 uX = vObjPosVM.zy * uDetailScale;
vec2 uY = vObjPosVM.xz * uDetailScale;
vec2 uZ = vObjPosVM.xy * uDetailScale;
vec4 dX = texture2D(tDetail, uX);
vec4 dY = texture2D(tDetail, uY);
vec4 dZ = texture2D(tDetail, uZ);
vec4 dd = dX*aw.x + dY*aw.y + dZ*aw.z;

vec3 pert = vec3(0.0);
pert += aw.x * vec3(0.0, dX.r*2.0-1.0, dX.g*2.0-1.0);
pert += aw.y * vec3(dY.r*2.0-1.0, 0.0, dY.g*2.0-1.0);
pert += aw.z * vec3(dZ.r*2.0-1.0, dZ.g*2.0-1.0, 0.0);
normal = normalize(normalMatrix * normalize(oN + pert * uNormalStr));

float edgeM = vMaskVM.x;

// Wear is NOT gated on edgeM any more. chamferBox writes aMask.x = 0 on all six
// main faces and extrudeProfile's mid-panel stations pass edge 0, so the old
// clamp(edgeM,..) * .. form multiplied every large flat face to exactly zero: the
// receiver could only ever be flat base colour minus grime. Flats now take 35% of
// the detail map's wear, chamfers still take 100%.
// Flats take 15%, chamfers 100%. research 4.2: wear follows CURVATURE. At 35% on a
// near-black anodised base the mottled bare-alloy colour read as chalky speckle over
// the whole receiver rather than as a rim of exposed metal on the edges.
float wear  = smoothstep(0.34, 0.86, dd.a) * (0.15 + 0.85 * clamp(edgeM, 0.0, 1.4));
float grime = 1.0 - dd.a;

diffuseColor.rgb *= (1.0 - uGrime * grime * (1.0 - min(edgeM, 1.0)));
diffuseColor.rgb  = mix(diffuseColor.rgb, uWornCol, clamp(wear * uWearAmt, 0.0, 1.0));

/* ---- flank decals: panel plates, panel-line grooves, stencil runs.
 * Planar-projected in object (z,y) and weighted by the X-facing triplanar term, so
 * it marks the receiver sides — where the reference puts all of its surface story —
 * and leaves the top rail and underside alone. */
if (uDecalAmt > 0.0) {
  vec2 duv = vObjPosVM.zy * uDecalMap.xy + uDecalMap.zw;
  vec2 din = step(vec2(0.0), duv) * step(duv, vec2(1.0));
  float flank = aw.x * din.x * din.y * uDecalAmt;
  vec4 dc = texture2D(tDecal, duv);
  // panel plates: separate the flat into tonally distinct planes
  diffuseColor.rgb *= mix(1.0, 0.55 + 0.90 * dc.a, flank);
  // grooves: dark in albedo, rough, and shading-normal perturbed
  float gr = dc.g * flank;
  diffuseColor.rgb *= 1.0 - 0.78 * gr;
  normal = normalize(normal + normalMatrix * vec3(0.0, (dc.b * 2.0 - 1.0) * flank * 1.6, 0.0));
  roughnessFactor = clamp(roughnessFactor + gr * 0.30, 0.055, 1.0);
  // stencils: flat matte paint, so they read as ink and not as chrome
  float sc = dc.r * flank;
  diffuseColor.rgb = mix(diffuseColor.rgb, uStencilCol, sc * 0.88);
  roughnessFactor = mix(roughnessFactor, 0.86, sc * 0.9);
  metalnessFactor = mix(metalnessFactor, 0.0, sc * 0.9);
}

diffuseColor.rgb *= mix(1.0 - uAoDepth, 1.0, vMaskVM.y);
roughnessFactor = clamp(roughnessFactor + (dd.b - 0.5) * uRoughVar - wear * 0.24, 0.055, 1.0);
metalnessFactor = clamp(metalnessFactor + wear * 0.30, 0.0, 1.0);

/* ---- the top-rail sheen.  DEFAULT OFF — see the measurement below.
 * The single most prominent feature of the reference weapon is one long soft
 * highlight running the whole length of the rail; an isotropic GGX lobe against a
 * low-res probe cannot make one. Rather than a full anisotropic BRDF, author the
 * anisotropy where it is cheap: a narrow low-roughness band in object X on
 * upward-facing surfaces. The band is invariant along Z, so the isotropic lobe
 * stretches down the barrel on its own.
 *
 * MEASURED RESULT, and the reason uRailStreak.x ships at 0: this does not work with
 * the environment we have. Gun-only, at matched pose, --config weaponRailStreak =
 * 0 / 0.7 / 1.4 gives hi_frac 0.009 / 0.008 / 0.004 and p99 196 / 193 / 181 — every
 * step of polish COSTS highlight energy, because a tighter lobe reflects the probe
 * (dim) rather than the sun, and even at 256x128 the probe has no bright small
 * feature to catch. The streak in the reference is a broad soft sheen off a real
 * sky, not a mirror. Left in, knob-controlled and off, so the next agent can see the
 * experiment rather than repeat it; the actual fix is a brighter, structured probe
 * (or a real anisotropic lobe with an explicit sun term), not more smoothness. */
if (uRailStreak.x > 0.0) {
  float up = smoothstep(0.30, 0.92, oN.y);
  float d  = (vObjPosVM.x - uRailStreak.y) * uRailStreak.z;
  float band = exp(-d * d);
  float k = uRailStreak.x * up * band;
  // Polish, do not mirror. Measured: driving the band to roughness 0.075 makes the
  // lobe so tight that the rail reflects the (dim) probe instead of the sun and
  // hi_frac COLLAPSES 0.012 -> 0.001, p99 203 -> 156. The reference sheen is broad
  // and soft; 0.26 is where the band still stretches along Z but keeps its energy.
  roughnessFactor = mix(roughnessFactor, 0.26, k);
  metalnessFactor = mix(metalnessFactor, 0.90, k * 0.5);
}

/* ---- GEOMETRIC SPECULAR ANTIALIASING — Kaplanyan 2016 / Tokuyoshi 2017 /
 * Tokuyoshi-Kaplanyan 2019, in Filament's formulation (research 4.4, verbatim from
 * google/filament shaders/src/surface_shading_lit.fs). three r185 does not ship it.
 *
 * A gun made of chamfered boxes presents hundreds of ~1 px chamfer facets at
 * roughness 0.3-0.45. Without this they are per-pixel specular noise that survives
 * its own albedo — that is the "chalky crust" read, and it is why nulling the base
 * colour left the receiver top at 82% of its brightness.
 *
 * Filament defaults: variance 0.15, threshold 0.2, MIN_PERCEPTUAL_ROUGHNESS 0.045.
 * derivativesScale is 1 because the viewmodel renders at native resolution.
 *
 * The derivative MUST be taken on the GEOMETRIC normal. Filament calls
 * getWorldGeometricNormalVector(); using the mapped normal double-counts the detail
 * map, which is exactly the term we are trying to stop aliasing. vNormal from
 * <normal_pars_fragment> is the interpolated, un-perturbed vertex normal. */
{
  vec3 gdu = dFdx(vNormal);
  vec3 gdv = dFdy(vNormal);
  float variance = uSpecAA * (dot(gdu, gdu) + dot(gdv, gdv));
  float a2 = roughnessFactor * roughnessFactor;
  float kernel = min(2.0 * variance, 0.2);
  roughnessFactor = sqrt(clamp(a2 + kernel, 0.0, 1.0));
}
roughnessFactor = max(roughnessFactor, 0.045);
`;

/* Cast-AO application. <aomap_fragment> is the one hook in meshphysical that runs
 * AFTER <lights_fragment_end>, where reflectedLight.indirect* still exist and the
 * direct terms are already accumulated — so this multiplies the IBL/ambient and
 * leaves the sun alone, which is what research 2.3.2 asks for. Occluding a delta
 * light with a hemispherical visibility term is double-counting and reads as dirt.
 *
 * Specular occlusion goes through three's own computeSpecularOcclusion() rather than
 * the raw scalar: a rough surface integrates a wide cone and must not be occluded as
 * hard as the diffuse lobe. Variable names (geometryNormal / geometryViewDir) are
 * three r155+; they were geometry.normal before. */
const VM_AO = /* glsl */`
{
  float vmAo = mix(1.0, clamp(vAoVM, 0.0, 1.0), uCastAo);
  reflectedLight.indirectDiffuse *= vmAo;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float vmDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( vmDotNV, vmAo, material.roughness );
  #endif
}
`;

const VM_VERT_PARS = /* glsl */`
attribute vec2 aMask;
attribute float aAO;
varying vec3 vObjPosVM;
varying vec3 vObjNrmVM;
varying vec2 vMaskVM;
varying float vAoVM;
`;
const VM_VERT = /* glsl */`
vObjPosVM = transformed;
vObjNrmVM = objectNormal;
vMaskVM   = aMask;
vAoVM     = aAO;
`;

function vmMaterial(ctx, key, o) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(o.color, THREE.SRGBColorSpace),
    roughness: o.roughness,
    metalness: o.metalness,
    envMapIntensity: o.envInt ?? 1.0,
    dithering: true,
  });
  if (o.plain) {
    applyWorldMaterial(mat, ctx, { matId: MAT_ID.VIEWMODEL, aerial: false, inject: { key } });
    return mat;
  }
  const U = {
    tDetail: { value: o.detail },
  };

  /* ---------------------------------------------------------------------------
   * TWO separate reasons this module's surface shader has never reached the screen.
   * Both found by nulling a term and re-capturing, not by reading.
   *
   * (1) WRONG ANCHOR. applyWorldMaterial splices inject.fragment in front of
   *     `<lights_fragment_begin>`. three's meshphysical order is
   *
   *       <roughnessmap_fragment> <metalnessmap_fragment> <normal_fragment_*>
   *       <lights_physical_fragment>   <- copies diffuseColor / roughnessFactor /
   *       <lights_fragment_begin>         metalnessFactor into the BRDF struct
   *
   *     so every albedo, roughness and metalness write in VM_FRAG landed after the
   *     values had already been consumed, and was discarded. Only the `normal` write
   *     survived. The correct anchor is `<lights_physical_fragment>`.
   *
   * (2) CSM EATS THE HOOK. applyWorldMaterial ends with
   *     `ctx.get('lighting')?.registerMaterial?.(mat)` -> `csm.setupMaterial(mat)`,
   *     and three's CSM does a bare `material.onBeforeCompile = function(shader){...}`
   *     — it does not chain. So it *overwrites* applyWorldMaterial's own hook, and
   *     any hook installed before the call, and the entire injection (uniforms,
   *     pars, varyings, fragment) is thrown away before the first compile.
   *
   *     Proof: forcing `diffuseColor.rgb = vec3(duv, aw.x)` produced a byte-identical
   *     PNG at both anchors. The gun was a uniform plank because it was being drawn
   *     by a stock MeshStandardMaterial.
   *
   * So do the injection ourselves, *after* applyWorldMaterial has run, chaining onto
   * whatever CSM left behind. Everything below is what applyWorldMaterial would have
   * injected, at the anchor that works, plus this module's own.
   * ------------------------------------------------------------------------- */
  Object.assign(U, {
    tDecal: { value: o.decal ?? o.detail },
    uDecalMap: { value: new THREE.Vector4(...(o.decalMap ?? [1.613, 4.35, 0.758, 0.565])) },
    uDecalAmt: { value: o.decalAmt ?? 0.0 },
    uStencilCol: { value: new THREE.Color().setHex(o.stencil ?? 0xa9a49a, THREE.SRGBColorSpace) },
    uRailStreak: { value: new THREE.Vector3(...(o.railStreak ?? [0, 0, 1])) },
    uWornCol: { value: new THREE.Color().setHex(o.worn ?? 0x6a6d72, THREE.SRGBColorSpace) },
    uDetailScale: { value: o.detailScale ?? 7.0 },
    uNormalStr: { value: o.normalStr ?? 0.85 },
    uWearAmt: { value: o.wear ?? 0.85 },
    uRoughVar: { value: o.roughVar ?? 0.30 },
    uGrime: { value: o.grime ?? 0.30 },
    uAoDepth: { value: o.aoDepth ?? 0.45 },
    uSpecAA: { value: o.specAA ?? 0.15 },     // Filament default
    uCastAo: { value: o.castAo ?? 1.0 },
  });

  applyWorldMaterial(mat, ctx, { matId: MAT_ID.VIEWMODEL, aerial: false, inject: { key } });

  const prev = mat.onBeforeCompile;          // CSM's, installed by registerMaterial
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VM_VERT_PARS}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${VM_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VM_PARS}`)
      .replace('#include <lights_physical_fragment>',
        `{\n${VM_FRAG}\n}\n#include <lights_physical_fragment>`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${VM_AO}`);
    mat.userData.shader = shader;
  };
  mat.__vmUniforms = U;
  return mat;
}

/**
 * Specular IBL for the viewmodel only.
 *
 * `env` is a stub and `scene.environment` is deliberately unset (the exposure key in
 * `passes/tonemap.js` warns about un-published image-based ambient, and rightly). But
 * a metal gun with no environment is black except for the sun lobe, and the brightest
 * thing on the reference weapon — the grazing sheen down the top rail — is a
 * reflection of the sky. So build a tiny private probe from `sky.radiance()`, PMREM
 * it once, and hang it on the viewmodel materials by hand.
 *
 * It is normalised against the HemisphereLight's irradiance rather than used raw, so
 * the ambient the gun sees stays tied to the same lighting rig as the world instead
 * of drifting with whatever units the sky module happens to publish.
 */
function buildEnvProbe(ctx, intensityScale) {
  // 256x128, not 64x32: below ~128px of azimuth the probe carries no structure above
  // ~6 degrees, so even at roughness 0.30 the rail reflects a uniform smear and the
  // reference's long grazing sheen cannot form. Built once at init; cost is irrelevant.
  const W = 256, H = 128;
  const data = new Float32Array(W * H * 4);
  const sky = ctx.get('sky');
  const time = ctx.get('time');
  const dir = new THREE.Vector3();
  const col = new THREE.Color();
  const fallbackSky = time ? time.skyColor.clone() : new THREE.Color(0.36, 0.56, 0.94);
  const warm = time ? time.sunColor.clone() : new THREE.Color(1, 0.94, 0.82);

  let hemiSum = 0, hemiW = 0;
  const tmp = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    const el = (v - 0.5) * Math.PI;
    const sy = Math.sin(el), cy = Math.cos(el);
    for (let i = 0; i < W; i++) {
      const az = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      dir.set(Math.cos(az) * cy, sy, Math.sin(az) * cy);
      if (sy > 0.005 && sky?.radiance) {
        sky.radiance(dir, col);
      } else if (sy > 0.005) {
        col.copy(fallbackSky).multiplyScalar(0.22 + 0.30 * sy);
      } else {
        /* Ground hemisphere = sand bounce, SYNTHESISED, not tinted sky.
         *
         * The old code sampled the horizon radiance and multiplied by a warm ratio.
         * But the horizon sample is blue, and a warm *ratio* applied to a blue
         * sample is still blue — just dimmer. That is the whole reason the gun
         * rendered navy: it is ~84% ambient-lit (measured: --config sunScale=0 moved
         * a receiver-flank patch only 14.75 -> 12.33) and every last bit of that
         * ambient was cold.
         *
         * So build the bounce from what actually bounces: sun colour x sand albedo
         * x sky visibility, with a small blue sky-fill term for the part of the
         * ground that sees more sky than sun.
         */
        const skyVis = 0.30 + 0.55 * (1 + sy);          // 1 at the horizon -> 0.3 at nadir
        const horizon = sky?.radiance ? sky.radiance(dir.set(Math.cos(az), 0.06, Math.sin(az)), col.clone())
          : fallbackSky.clone().multiplyScalar(0.26);
        const hL = 0.2126 * horizon.r + 0.7152 * horizon.g + 0.0722 * horizon.b;
        // sand albedo, linear, warm (Silent Cartographer beach measures ~0.22 with a
        // strong R>G>B ramp). Driven by the sun's own colour so it tracks time of day.
        col.setRGB(
          warm.r * SAND_BOUNCE[0],
          warm.g * SAND_BOUNCE[1],
          warm.b * SAND_BOUNCE[2],
        ).multiplyScalar(hL * SAND_BOUNCE_GAIN * skyVis);
        // a little cold sky fill so the bounce is not cartoon-orange
        col.r += horizon.r * 0.04 * skyVis;
        col.g += horizon.g * 0.045 * skyVis;
        col.b += horizon.b * 0.055 * skyVis;
      }
      const k = (j * W + i) * 3;
      tmp[k] = Math.max(0, col.r); tmp[k + 1] = Math.max(0, col.g); tmp[k + 2] = Math.max(0, col.b);
      if (sy > 0) {
        const w = cy * sy;               // cosine-weighted solid angle for irradiance
        hemiSum += (0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b) * w;
        hemiW += w;
      }
    }
  }
  const meanL = hemiW > 0 ? hemiSum / hemiW : 1;
  // match the HemisphereLight the rest of the scene is lit by
  let targetE = 0.6;
  const scene = ctx.scene;
  scene.traverse((o) => {
    if (o.isHemisphereLight) {
      targetE = (0.2126 * o.color.r + 0.7152 * o.color.g + 0.0722 * o.color.b) * o.intensity;
    }
  });
  const gain = (meanL > 1e-6 ? (targetE / Math.PI) / meanL : 1) * intensityScale;

  for (let p = 0; p < W * H; p++) {
    data[p * 4] = tmp[p * 3] * gain;
    data[p * 4 + 1] = tmp[p * 3 + 1] * gain;
    data[p * 4 + 2] = tmp[p * 3 + 2] * gain;
    data[p * 4 + 3] = 1;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(ctx.renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt;
}

/* Build-time geometry is exported for `tools/_wpntri.mjs`, which loads this module
 * in bare node (no GPU, no DOM) and dumps triangle aspect ratios. That is how the
 * surviving zero-area strip was found: by measuring triangles, not by tightening a
 * threshold. Nothing in the runtime path uses it. */
export const __dbg = { buildRifle, buildHands };
export const __mount = { pos: MOUNT_POS, rot: MOUNT_ROT, pivot: PIVOT, handL: HAND_L, armR: ARM_R };

/* ========================================================================== */
/*  module                                                                    */
/* ========================================================================== */

export function create(opts = {}) {
  let ctx = null;
  const root = new THREE.Object3D();
  root.name = 'viewmodel';
  root.matrixAutoUpdate = false;
  root.frustumCulled = false;

  const grpGun = new THREE.Object3D();       // static receiver group
  const grpMag = new THREE.Object3D();
  const grpBolt = new THREE.Object3D();
  const grpHand = new THREE.Object3D();
  const grpArm = new THREE.Object3D();
  for (const g of [grpGun, grpMag, grpBolt, grpHand, grpArm]) root.add(g);

  const mats = {};
  const tex = {};
  let counter = null, counterTex = null, envRT = null;
  let pendingEnvInt = null;
  let flashLight = null, flashSprite = null;
  const shells = [];
  const tracers = [];
  let shellIx = 0, tracerIx = 0;

  const st = {
    ammo: START_AMMO, reserve: START_RESERVE,
    firing: false, reloading: false, reloadT: 0, nextShot: -1, t: 0,
    bloom: 0, ads: 0, adsTarget: 0,
    lagYaw: 0, lagYawV: 0, lagPitch: 0, lagPitchV: 0,
    recZ: 0, recZV: 0, recP: 0, recPV: 0, recY: 0, recYV: 0, recR: 0, recRV: 0,
    landY: 0, landV: 0, wasGrounded: true,
    bobPhase: 0, bobAmt: 0,
    boltT: 1, flashT: 0, counterAmmo: -1, counterGlow: 0,
    camYaw: 0, camPitch: 0, haveCam: false,
  };

  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _m = new THREE.Matrix4();
  const localPos = new THREE.Vector3();
  const muzzleLocal = new THREE.Vector3(0, 0.004, -0.462);
  const ejectLocal = new THREE.Vector3(0.030, 0.006, -0.055);
  const muzzleWorld = new THREE.Vector3();
  let rng = null;

  /* -------------------------------------------------------------- effects */
  function fireEffects() {
    st.flashT = 0.055;
    st.boltT = 0;
    if (flashLight) flashLight.position.copy(muzzleWorld);
    // shell
    const physics = ctx.get('physics');
    const shell = shells[shellIx % shells.length];
    shellIx++;
    if (shell) {
      root.updateMatrixWorld(true);
      const p = _v.copy(ejectLocal).applyMatrix4(root.matrixWorld);
      const right = _v2.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0);
      if (shell.body && physics) physics.removeBody(shell.body.id);
      shell.mesh.visible = true;
      shell.life = 2.4;
      if (physics?.addBody) {
        shell.body = physics.addBody({
          position: p.clone(),
          velocity: right.clone().multiplyScalar(2.1 + rng.next() * 0.7)
            .addScaledVector(up, 1.5 + rng.next() * 0.6)
            .addScaledVector(_v2.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion), 0.4),
          angularVelocity: new THREE.Vector3(rng.sym(24), rng.sym(24), rng.sym(24)),
          radius: 0.008, mass: 0.012, restitution: 0.42, drag: 0.06,
          mask: physics.MASK ? physics.MASK.DEBRIS : 8,
          life: 2.4,
        });
      } else {
        shell.body = null;
        shell.mesh.position.copy(p);
      }
    }
  }

  function spawnTracer(from, to) {
    const t = tracers[tracerIx % tracers.length];
    tracerIx++;
    if (!t) return;
    t.life = 0.055;
    t.mesh.visible = true;
    const d = _v.subVectors(to, from);
    const len = Math.min(d.length(), 60);
    t.mesh.position.copy(from).addScaledVector(d.normalize(), len * 0.5);
    t.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
    t.mesh.scale.set(1, 1, len);
  }

  /* ---------------------------------------------------------------- api */
  const api = {
    name: 'weapons',
    order: 75,
    enabled: true,

    current: {
      id: 'ma5b', name: 'MA5B Assault Rifle',
      ammo: START_AMMO, reserve: START_RESERVE, magSize: MAG_SIZE,
      rpm: RPM, spread: 0.006, damage: DAMAGE, range: RANGE,
    },
    get isFiring() { return st.firing; },
    get isReloading() { return st.reloading; },
    get adsAmount() { return st.ads; },
    muzzleWorldPosition: muzzleWorld,

    /** One round. Cooldown, ammo and reload state are all enforced here so external
     *  callers (input, AI, a demo script) can hammer it safely. */
    fire() {
      if (!ctx || st.reloading || st.ammo <= 0) return;
      if (st.t < st.nextShot) return;
      st.nextShot = st.t + SHOT_DT;
      st.ammo--;
      api.current.ammo = st.ammo;

      const cam = ctx.camera;
      const origin = _v.copy(cam.position);
      const dir = _v2.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const sp = 0.0022 + st.bloom * 0.026;
      dir.x += rng.sym(sp); dir.y += rng.sym(sp); dir.z += rng.sym(sp * 0.2);
      dir.normalize();
      st.bloom = Math.min(1, st.bloom + 0.115);

      const o = origin.clone(), d = dir.clone();
      const hit = ctx.get('physics')?.raycast?.(o, d, RANGE);
      const end = hit ? hit.point.clone() : o.clone().addScaledVector(d, RANGE);

      // recoil: spring impulses on the viewmodel, plus the real camera kick
      st.recZ += 0.0165; st.recP += 0.0270 + rng.next() * 0.006;
      st.recY += rng.sym(0.0085); st.recR += rng.sym(0.024);
      ctx.get('player')?.applyRecoil?.(0.0092 + rng.next() * 0.0035, rng.sym(0.0042));

      fireEffects();
      spawnTracer(muzzleWorld, end);
      ctx.emit('weapon:fired', { weapon: api.current, origin: o, direction: d });
      if (hit) {
        ctx.emit('weapon:impact', {
          point: hit.point, normal: hit.normal,
          material: hit.body?.matId ?? 0, surface: hit.surface || 'rock',
        });
        const ai = ctx.get('ai');
        if (ai?.nearestTo && hit.body?.actorId != null) ai.damage?.(hit.body.actorId, DAMAGE, hit.point, d);
      }
      ctx.get('audio')?.play?.('rifle_fire', { position: muzzleWorld.clone(), volume: 1 });
      if (st.ammo === 0) api.reload();
    },

    reload() {
      if (!ctx || st.reloading || st.ammo >= MAG_SIZE || st.reserve <= 0) return;
      st.reloading = true;
      st.reloadT = 0;
      ctx.get('audio')?.play?.('rifle_reload', { volume: 0.8 });
    },

    switchTo(id) { return id === 'ma5b'; },

    setFiring(v) { st.firing = !!v; },
    setAds(v) { st.adsTarget = v ? 1 : 0; },

    /* ------------------------------------------------------------- init */
    async init(c) {
      ctx = c;
      rng = ctx.rand.fork('weapons');
      const texRand = ctx.rand.fork('weapons.tex');

      tex.metal = configureTexture(makeSurfaceTex(texRand, { size: 512, scratches: 70, aniso: 0.90 }), ctx);
      tex.poly = configureTexture(makeSurfaceTex(texRand.fork(1), { size: 512, scratches: 45, aniso: 0.55, grain: 1.1 }), ctx);
      tex.weave = configureTexture(makeWeaveTex(texRand.fork(2), 256), ctx);
      tex.railN = configureTexture(makeRailNormalTex(texRand.fork(3)), ctx, { repeat: false });
      tex.decal = configureTexture(makeDecalTex(texRand.fork(4)), ctx, { repeat: false });

      /* THE ENV PROBE IS A FILL, NOT A KEY.
       * At 0.45 it supplied 52% of every photon on this object (measured:
       * --config weaponEnvInt=0 moved gun lum_mean 56.46 -> 27.27) and, being applied
       * with no occlusion, it lit the inside of the trigger group exactly as brightly
       * as the sky-facing plates. research 2.2 puts the viewmodel fill at 0.06-0.12 of
       * sun, diffuse-dominant, "explicitly because a strong one kills the tonal range".
       * Cut to 0.20 and now modulated per-vertex by cast AO. */
      const envInt = ctx.config.weaponEnvInt ?? 0.95;
      try { envRT = buildEnvProbe(ctx, envInt); } catch (e) { console.warn('[weapons] env probe failed', e); }
      const envMap = envRT ? envRT.texture : null;

      /* MATERIAL VALUES — research/weapons.md 4.5, linear base colour / F0.
       *
       * The previous wave drove the body to 0x847661 = linear (0.229, 0.180, 0.120).
       * That is dry-SAND albedo: warm (R/B = 1.9) and 5x past the value 4.5's "albedo
       * trap" paragraph names as the failure point ("raising base colour to 0.08 would
       * hit the mean and destroy both the contrast and the laplacian variance"). It
       * hit the mean exactly — gun p50 47.98 against the reference's 48.97 — and
       * destroyed the image: frac<25 was 0.0005 against 0.1898, the 130-170 rail-sheen
       * bin 0.0113 against 0.1065.
       *
       * The reference gun is warm because it sits in strong warm sand bounce, not
       * because its albedo is warm: on the material itself, the counter-housing shell
       * in kf_00000 reads RGB (63.3, 69.6, 75.8), R-B = **-12.5**. Baking the bounce
       * into the albedo AND applying a sand-tinted bounce probe on top double-counts it.
       *
       *   black anodised aluminium  metalness 1.0  linear 0.045/0.046/0.048  rough .35-.55
       *   black polymer furniture   metalness 0.0  linear 0.021/0.021/0.022  rough .55-.70
       *   glove fabric              metalness 0.0  linear 0.035/0.033/0.030  rough .90
       *
       * Anodising stays at metalness 1.0 — it is a thin oxide, not paint (4.5). At
       * metalness 1 three's <lights_physical_fragment> turns `color` into F0, so these
       * surfaces reflect only 4.5% at normal incidence and rise to ~100% at grazing:
       * dark faces, bright chamfer rims. That IS the hard-surface read, and it is why
       * the brightness must come from specular and never from raising base colour. */
      mats.body = vmMaterial(ctx, 'vm_body', {
        color: 0x3c3e43, roughness: 0.44, metalness: 1.0, detail: tex.metal,
        worn: 0x74797d, detailScale: 7.2, normalStr: 0.30, wear: 0.26,
        roughVar: 0.24, grime: 0.10, aoDepth: 0.34, envInt: 1.0,
        decal: tex.decal, decalAmt: 1.0, railStreak: [0.0, 0.0, 30.0],
      });
      mats.rail = vmMaterial(ctx, 'vm_rail', {
        color: 0x3f4247, roughness: 0.33, metalness: 1.0, detail: tex.metal,
        worn: 0x7d8286, detailScale: 9.5, normalStr: 0.24, wear: 0.34,
        roughVar: 0.22, grime: 0.09, aoDepth: 0.32, envInt: 1.15,
        decal: tex.decal, decalAmt: 0.85, railStreak: [0.0, 0.0, 26.0],
      });
      mats.poly = vmMaterial(ctx, 'vm_poly', {
        color: 0x2a2b2b, roughness: 0.62, metalness: 0.0, detail: tex.poly,
        worn: 0x4b4a46, detailScale: 6.0, normalStr: 0.46, wear: 0.40,
        decal: tex.decal, decalAmt: 0.55,
        roughVar: 0.30, grime: 0.34, aoDepth: 0.38, envInt: 0.9,
      });
      mats.glove = vmMaterial(ctx, 'vm_glove', {
        // pebbled leather: the weave has to be ~2.4 mm to survive a 0.39 mm pixel,
        // so detailScale drops 30 -> 16 (one repeat per 62 mm at PER = 10/256).
        color: 0x343330, roughness: 0.88, metalness: 0.0, detail: tex.weave,
        worn: 0x3c3a36, detailScale: 16.0, normalStr: 0.80, wear: 0.45,
        roughVar: 0.30, grime: 0.26, aoDepth: 0.34, envInt: 0.85,
      });
      mats.plate = vmMaterial(ctx, 'vm_plate', {
        color: 0x3a3d42, roughness: 0.40, metalness: 0.85, detail: tex.metal,
        worn: 0x72777b, detailScale: 12.0, normalStr: 0.26, wear: 0.38,
        roughVar: 0.22, grime: 0.14, aoDepth: 0.34, envInt: 1.05,
      });
      mats.engrave = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0x44484d, THREE.SRGBColorSpace),
        roughness: 0.32, metalness: 1.0, envMapIntensity: 1.1,
        normalMap: tex.railN, normalScale: new THREE.Vector2(0.40, 0.40),
      });
      applyWorldMaterial(mats.engrave, ctx, { matId: MAT_ID.VIEWMODEL, aerial: false, inject: { key: 'vm_engrave' } });

      counter = makeCounterCanvas();
      counterTex = new THREE.CanvasTexture(counter.canvas);
      counterTex.colorSpace = THREE.SRGBColorSpace;
      counterTex.anisotropy = ctx.caps.maxAnisotropy;
      counterTex.minFilter = THREE.LinearMipmapLinearFilter;
      mats.screen = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.02, 0.03, 0.035),
        roughness: 0.10, metalness: 0.0,
        emissive: new THREE.Color(1, 1, 1),
        emissiveMap: counterTex,
        emissiveIntensity: ctx.config.weaponScreenEmissive ?? 2.30,
        envMapIntensity: 1.0,
      });
      applyWorldMaterial(mats.screen, ctx, { matId: MAT_ID.VIEWMODEL, aerial: false, inject: { key: 'vm_screen' } });

      const ledTex = new THREE.CanvasTexture(makeLedCanvas());
      ledTex.colorSpace = THREE.SRGBColorSpace;
      mats.led = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.05, 0.05, 0.05),
        map: ledTex, transparent: true, alphaTest: 0.08,
        roughness: 0.5, metalness: 0.0,
        emissive: new THREE.Color(1, 1, 1), emissiveMap: ledTex, emissiveIntensity: 0.22,
      });
      applyWorldMaterial(mats.led, ctx, { matId: MAT_ID.VIEWMODEL, aerial: false, inject: { key: 'vm_led' } });

      if (envMap) for (const k of Object.keys(mats)) if (mats[k].isMeshStandardMaterial) mats[k].envMap = envMap;

      /* --------------------------------------------------- live config knobs
       * `tools/captured.mjs` applies --config AFTER __HALO__.ready, via setConfig,
       * which only writes ctx.config and emits 'config'. Anything read once inside
       * init() is therefore a dead knob: --config weaponEnvInt=0 and =10 used to
       * produce byte-identical PNGs. Same failure class as KNOWN_ISSUES section 9.
       * Subscribe, so this subsystem can actually be bisected. */
      const uni = (name) => {
        const out = [];
        for (const m of Object.values(mats)) {
          const u = m.userData?.shaderUniforms?.[name] ?? m.__vmUniforms?.[name];
          if (u) out.push(u);
        }
        return out;
      };
      ctx.on('config', ({ k, v }) => {
        if (k === 'weaponScreenEmissive') { mats.screen.emissiveIntensity = +v; }
        // NB deferred: PMREMGenerator renders, so rebuilding the probe inside the
        // config callback leaves the renderer bound to its own target and the next
        // frame comes back black. Queue it and do it at the top of update().
        else if (k === 'weaponEnvInt') { pendingEnvInt = +v; }
        else if (k === 'weaponDecalAmt') { for (const u of uni('uDecalAmt')) u.value = +v; }
        else if (k === 'weaponRailStreak') { for (const u of uni('uRailStreak')) u.value.x = +v; }
        else if (k === 'weaponWearAmt') { for (const u of uni('uWearAmt')) u.value = +v; }
        else if (k === 'weaponCastAo') { for (const u of uni('uCastAo')) u.value = +v; }
        else if (k === 'weaponSpecAA') { for (const u of uni('uSpecAA')) u.value = +v; }
        else if (k === 'weaponNormalStr') {
          for (const m of Object.values(mats)) {
            const u = m.__vmUniforms?.uNormalStr;
            if (u) { if (m.__baseNS === undefined) m.__baseNS = u.value; u.value = m.__baseNS * +v; }
          }
        }
        else if (k === 'weaponAlbedoScale') {
          for (const key of ['body', 'rail', 'poly', 'plate', 'glove']) {
            const m = mats[key];
            if (m && !m.__baseCol) m.__baseCol = m.color.clone();
            if (m) m.color.copy(m.__baseCol).multiplyScalar(+v);
          }
        }
      });

      /* ------------------------------------------------------- geometry */
      const { G, parts } = buildRifle(rng);
      buildHands(G, parts);

      const merged = [];
      const addMesh = (group, geos, mat, name) => {
        if (!geos.length) return null;
        const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
        if (!geo) { console.warn('[weapons] merge failed for', name); return null; }
        cullDegenerate(geo);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = 'vm_' + name;
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        group.add(mesh);
        merged.push(geo);
        return mesh;
      };
      addMesh(grpGun, G.body, mats.body, 'body');
      addMesh(grpGun, G.rail, mats.rail, 'rail');
      addMesh(grpGun, G.engrave, mats.engrave, 'engrave');
      addMesh(grpGun, G.poly, mats.poly, 'poly');
      addMesh(grpGun, G.screen, mats.screen, 'screen');
      addMesh(grpGun, G.led, mats.led, 'led');
      addMesh(grpGun, G.plate, mats.plate, 'plate');
      addMesh(grpGun, G.glove, mats.glove, 'gloveStatic');
      addMesh(grpMag, parts.mag, mats.body, 'mag');
      addMesh(grpBolt, parts.bolt, mats.body, 'bolt');
      addMesh(grpBolt, parts.boltPoly, mats.poly, 'boltGrip');
      addMesh(grpHand, parts.handL, mats.glove, 'handL');
      addMesh(grpArm, parts.armR, mats.glove, 'armR');

      /* ---- cast ambient occlusion (research 2.3.2). One BVH over the whole rest-pose
       * viewmodel, then 24 cosine-weighted rays per unique (position, normal). This is
       * the dark line under the carry handle, the black inside the mag well and the
       * trigger group, and the contact darkening where the glove wraps the fore-end
       * (2.3.3) — none of which the authored aMask.y chamfer term can produce, because
       * it knows nothing about what is standing in front of what. */
      {
        const t0 = (globalThis.performance ?? Date).now();
        let nTri = 0;
        for (const g of merged) nTri += g.getAttribute('position').count / 3;
        const soup = new Float32Array(nTri * 9);
        let w = 0;
        for (const g of merged) {
          const p = g.getAttribute('position').array;
          soup.set(p, w); w += p.length;
        }
        const uniq = bakeVertexAO(merged, soup, ctx.config.weaponAoRays ?? 24);
        if (ctx.config.weaponAoLog) {
          console.log('[weapons] cast AO', nTri, 'tris', uniq, 'unique verts',
            ((globalThis.performance ?? Date).now() - t0).toFixed(0), 'ms');
        }
      }

      /* ------------------------------------------------ muzzle flash + FX */
      flashLight = new THREE.PointLight(0xffd9a0, 0, 5.0, 2.0);
      flashLight.layers.enableAll();
      flashLight.castShadow = false;
      ctx.scene.add(flashLight);

      const flashGeo = new THREE.PlaneGeometry(0.10, 0.10);
      const flashMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(9.0, 6.2, 3.0),
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false, toneMapped: false,
      });
      flashSprite = new THREE.Object3D();
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(flashGeo, flashMat);
        m.rotation.z = i * Math.PI / 3;
        flashSprite.add(m);
      }
      flashSprite.position.copy(muzzleLocal);
      flashSprite.visible = false;
      root.add(flashSprite);

      const shellGeo = segRounded(0.0165, 0.0042, 0.0042, 0.0035, 0.0035, 0.0042, { steps: 3 }).geometry();
      const shellMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0xb08a3c, THREE.SRGBColorSpace),
        roughness: 0.34, metalness: 0.9, envMapIntensity: 1.0,
      });
      if (envMap) shellMat.envMap = envMap;
      applyWorldMaterial(shellMat, ctx, { matId: MAT_ID.METAL, aerial: false, inject: { key: 'vm_shell' } });
      for (let i = 0; i < 10; i++) {
        const mesh = new THREE.Mesh(shellGeo, shellMat);
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.layers.set(LAYER.EFFECTS);
        ctx.scene.add(mesh);
        shells.push({ mesh, body: null, life: 0 });
      }

      const tracerGeo = new THREE.PlaneGeometry(0.028, 1);
      tracerGeo.rotateX(Math.PI / 2);
      const tracerMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(5.2, 3.1, 1.0),
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      });
      for (let i = 0; i < 6; i++) {
        const mesh = new THREE.Mesh(tracerGeo, tracerMat);
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.layers.set(LAYER.EFFECTS);
        ctx.scene.add(mesh);
        tracers.push({ mesh, life: 0 });
      }

      /* ---------------------------------------------------------- wiring */
      /* three only collects a light when light.layers.test(camera.layers) passes.
       * Every scene light (CSM sun, sky hemisphere, warm bounce) sits on LAYER.DEFAULT,
       * and passes/scene.js draws the viewmodel with a camera restricted to
       * LAYER.VIEWMODEL — so before this the gun received *zero* direct light and was
       * lit purely by its own IBL: flat, blue, and 26% too bright in the shadows.
       * Verified with a sunScale=0 A/B: identical frame.
       * Widening a light's mask is strictly additive — every camera that saw a light
       * before still sees it — so nothing outside the viewmodel pass changes. */
      const widenLights = () => c.scene.traverse((o) => { if (o.isLight) o.layers.enableAll(); });
      widenLights();
      c.on('engine:ready', widenLights);

      root.traverse((o) => { if (o !== root) o.layers.set(LAYER.VIEWMODEL); });
      root.layers.set(LAYER.VIEWMODEL);
      patchForGBuffer(root, { matId: MAT_ID.VIEWMODEL, roughness: 0.46 });
      ctx.scene.add(root);

      // camera teleports (the capture harness sets a pose) must not leave the
      // look-lag spring mid-flight, or the first settle frames differ from a
      // steady-state one and two captures of the same pose disagree.
      ctx.on('camera:teleport', () => {
        st.lagYaw = st.lagYawV = st.lagPitch = st.lagPitchV = 0;
        st.haveCam = false;
      });

      if (!ctx.engine.opts.deterministic && ctx.config.weaponInput !== false) {
        const el = ctx.renderer.domElement;
        el.addEventListener('mousedown', (e) => { if (e.button === 0) st.firing = true; if (e.button === 2) st.adsTarget = 1; });
        globalThis.addEventListener?.('mouseup', (e) => { if (e.button === 0) st.firing = false; if (e.button === 2) st.adsTarget = 0; });
        globalThis.addEventListener?.('keydown', (e) => { if (e.code === 'KeyR') api.reload(); });
      }
      this.updateCounter(true);
    },

    updateCounter(force) {
      if (!counter) return;
      const glow = st.reloading ? 0.5 + 0.5 * Math.sin(st.reloadT * 26) : (st.ammo === 0 ? 1 : 0);
      if (!force && st.counterAmmo === st.ammo && Math.abs(st.counterGlow - glow) < 0.08) return;
      st.counterAmmo = st.ammo; st.counterGlow = glow;
      counter.draw(st.ammo, glow);
      if (counterTex) counterTex.needsUpdate = true;
    },

    /* ------------------------------------------------------------ update */
    update(dt, c) {
      if (c.config.frozen) dt = 0;
      if (pendingEnvInt !== null) {
        const want = pendingEnvInt; pendingEnvInt = null;
        try {
          const prevRT = c.renderer.getRenderTarget();
          const old = envRT;
          envRT = buildEnvProbe(c, want);
          c.renderer.setRenderTarget(prevRT);
          for (const m of Object.values(mats)) {
            if (m.isMeshStandardMaterial) { m.envMap = envRT.texture; m.needsUpdate = true; }
          }
          old?.dispose();
        } catch (e) { console.warn('[weapons] env rebuild failed', e); }
      }
      st.t = c.clock.t;
      const cam = c.camera;
      const player = c.get('player');

      st.bloom = Math.max(0, st.bloom - dt * 1.55);
      st.ads += (st.adsTarget - st.ads) * Math.min(1, dt * 11);
      st.boltT = Math.min(1, st.boltT + dt * 15);
      st.flashT = Math.max(0, st.flashT - dt);
      if (flashLight) flashLight.intensity = st.flashT > 0 ? 130 * (st.flashT / 0.055) : 0;
      if (flashSprite) flashSprite.visible = st.flashT > 0;

      if (st.firing && !st.reloading) api.fire();

      if (st.reloading) {
        st.reloadT += dt;
        if (st.reloadT >= RELOAD_TIME) {
          st.reloading = false; st.reloadT = 0;
          const need = MAG_SIZE - st.ammo;
          const take = Math.min(need, st.reserve);
          st.ammo += take; st.reserve -= take;
          api.current.ammo = st.ammo; api.current.reserve = st.reserve;
        }
      }

      /* ---- look lag: the single most important motion cue ---------------- */
      _e.setFromQuaternion(cam.quaternion, 'YXZ');
      if (!st.haveCam) { st.camYaw = _e.y; st.camPitch = _e.x; st.haveCam = true; }
      let dYaw = _e.y - st.camYaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      const dPitch = _e.x - st.camPitch;
      st.camYaw = _e.y; st.camPitch = _e.x;
      if (dt > 0) {
        st.lagYaw = THREE.MathUtils.clamp(st.lagYaw - dYaw * 0.58, -0.155, 0.155);
        st.lagPitch = THREE.MathUtils.clamp(st.lagPitch - dPitch * 0.52, -0.130, 0.130);
      }
      [st.lagYaw, st.lagYawV] = spring(st.lagYaw, st.lagYawV, 0, 14, dt);
      [st.lagPitch, st.lagPitchV] = spring(st.lagPitch, st.lagPitchV, 0, 14, dt);

      /* ---- recoil ------------------------------------------------------- */
      [st.recZ, st.recZV] = spring(st.recZ, st.recZV, 0, 21, dt);
      [st.recP, st.recPV] = spring(st.recP, st.recPV, 0, 19, dt);
      [st.recY, st.recYV] = spring(st.recY, st.recYV, 0, 17, dt);
      [st.recR, st.recRV] = spring(st.recR, st.recRV, 0, 16, dt);

      /* ---- walk bob + landing ------------------------------------------- */
      let speed = 0;
      if (player?.velocity) {
        const v = player.velocity;
        if (Number.isFinite(v.x)) speed = Math.hypot(v.x, v.z);
      } else if (c.config.weaponWalk ?? !c.engine.opts.deterministic) {
        // player is a stub: run a synthetic walk so the bob can be seen and tuned.
        // Off by default under the capture harness — a standing player has no bob,
        // and inventing one only smears the frame that gets measured.
        speed = 3.1;
      }
      const sprint = player?.sprinting ? 1 : 0;
      st.bobAmt += (Math.min(1, speed / 4.6) - st.bobAmt) * Math.min(1, dt * 6);
      st.bobPhase += dt * (5.6 - sprint * 1.4) * Math.min(1.4, 0.35 + speed * 0.24);

      const grounded = player?.grounded ?? true;
      if (grounded && !st.wasGrounded) {
        const vy = player?.velocity?.y ?? -4;
        st.landV -= Math.min(0.55, Math.abs(vy) * 0.055);
      }
      st.wasGrounded = grounded;
      [st.landY, st.landV] = spring(st.landY, st.landV, 0, 17, dt);

      /* ---- effects lifetimes -------------------------------------------- */
      for (const s of shells) {
        if (!s.mesh.visible) continue;
        s.life -= dt;
        if (s.life <= 0) { s.mesh.visible = false; if (s.body) { c.get('physics')?.removeBody?.(s.body.id); s.body = null; } continue; }
        if (s.body) { s.mesh.position.copy(s.body.position); s.mesh.quaternion.copy(s.body.quaternion); }
      }
      for (const t of tracers) {
        if (!t.mesh.visible) continue;
        t.life -= dt;
        if (t.life <= 0) t.mesh.visible = false;
      }
      this.updateCounter(false);
      api.current.spread = 0.0022 + st.bloom * 0.026;
    },

    /* --------------------------------------------------------- prerender */
    prerender(c) {
      const cam = c.camera;
      const T = c.clock.t;
      const swayK = (c.config.weaponSway ?? 1) * 0.35 * DEG;

      // idle sway: two incommensurate rates so it never reads as a loop
      const s1 = 0.66 * Math.sin(T * 2.51) + 0.34 * Math.sin(T * 1.13 + 1.90);
      const s2 = 0.62 * Math.sin(T * 1.87 + 2.40) + 0.38 * Math.sin(T * 0.97 + 0.60);
      const s3 = 0.58 * Math.sin(T * 1.44 + 4.10) + 0.42 * Math.sin(T * 2.29 + 2.80);

      // walk bob: figure of eight, vertical 1.4 cm / lateral 0.9 cm at full speed
      const bp = st.bobPhase;
      const amp = st.bobAmt;
      let bobX = Math.sin(bp) * 0.0045 * amp;
      let bobY = Math.sin(bp * 2) * 0.0070 * amp;
      let bobRoll = Math.sin(bp) * 0.020 * amp;
      const vb = c.get('player')?.viewBobOffset;
      if (vb && Number.isFinite(vb.x)) {
        bobX = bobX * 0.35 + vb.x * 0.55;
        bobY = bobY * 0.35 + vb.y * 0.55;
        bobRoll = bobRoll * 0.35 + vb.x * 2.2;
      }

      // reload timeline
      let rlx = 0, rly = 0, rlz = 0, rlp = 0, rlyaw = 0, rlroll = 0, magY = 0, magZ = 0, boltR = 0;
      if (st.reloading) {
        const p = st.reloadT / RELOAD_TIME;
        const bump = THREE.MathUtils.smoothstep(p, 0.0, 0.16) * (1 - THREE.MathUtils.smoothstep(p, 0.82, 1.0));
        rlx = -0.022 * bump; rly = -0.048 * bump; rlz = 0.026 * bump;
        rlp = -0.30 * bump; rlyaw = 0.20 * bump; rlroll = -0.26 * bump;
        const out = THREE.MathUtils.smoothstep(p, 0.13, 0.40);
        const back = THREE.MathUtils.smoothstep(p, 0.58, 0.84);
        magY = -0.185 * (out - back);
        magZ = 0.030 * (out - back);
        if (p > 0.86 && p < 0.96) boltR = Math.sin((p - 0.86) / 0.10 * Math.PI) * 0.024;
      }

      // compose the local mount transform
      const a = st.ads;
      localPos.copy(MOUNT_POS).lerp(ADS_POS, a);
      localPos.x += bobX * (1 - a * 0.7) - st.lagYaw * 0.075 + rlx;
      localPos.y += bobY * (1 - a * 0.7) + st.landY * 0.10 - st.lagPitch * 0.060 + rly;
      localPos.z += st.recZ + rlz;

      const pitch = mix(MOUNT_ROT.pitch, ADS_ROT.pitch, a) + s1 * swayK + st.lagPitch + st.recP + rlp;
      const yaw = mix(MOUNT_ROT.yaw, ADS_ROT.yaw, a) + s2 * swayK + st.lagYaw + st.recY + rlyaw;
      const roll = mix(MOUNT_ROT.roll, ADS_ROT.roll, a) + s3 * swayK * 1.6 + bobRoll + st.recR
        + st.lagYaw * 0.55 + rlroll;

      _e.set(pitch, yaw, roll, 'YXZ');
      _q.setFromEuler(_e);
      // pivot the whole rig about the weapon's centre of mass
      _v2.copy(PIVOT).applyQuaternion(_q);
      localPos.add(_v2.sub(PIVOT));
      _m.compose(localPos, _q, _v.set(1, 1, 1));
      root.matrix.multiplyMatrices(cam.matrixWorld, _m);
      root.matrixWorldNeedsUpdate = true;

      grpMag.position.set(0, magY, magZ);
      grpBolt.position.set(0, 0, 0.020 * Math.sin(Math.min(1, st.boltT) * Math.PI) + boltR);
      grpHand.position.set(0, magY * 0.10, 0);
      grpArm.position.set(0, st.landY * 0.05, st.recZ * 0.5);
      root.visible = c.config.weaponHidden !== true;
      root.updateMatrixWorld(true);
      muzzleWorld.copy(muzzleLocal).applyMatrix4(root.matrixWorld);
      if (flashSprite && st.flashT > 0) {
        flashSprite.scale.setScalar(0.75 + rng.next() * 0.5);
        flashSprite.rotation.z = rng.next() * 6.28;
      }
    },

    resize() {},

    dispose(c) {
      c.scene.remove(root);
      if (flashLight) c.scene.remove(flashLight);
      for (const s of shells) c.scene.remove(s.mesh);
      for (const t of tracers) c.scene.remove(t.mesh);
      root.traverse((o) => { o.geometry?.dispose?.(); });
      for (const k of Object.keys(mats)) mats[k].dispose?.();
      for (const k of Object.keys(tex)) tex[k].dispose?.();
      counterTex?.dispose();
      envRT?.dispose();
    },
  };

  return api;
}
