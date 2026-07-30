import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYER } from '../render/RenderPipeline.js';
import { MAT_ID, patchForGBuffer } from '../gfx/GBufferMaterial.js';
import { applyWorldMaterial, configureTexture } from '../gfx/materialCommon.js';

/**
 * `weapons` — MA5B assault rifle viewmodel, firing, ballistics, recoil.
 *
 * The viewmodel is on screen 100% of the time and owns roughly a quarter of every
 * frame. Everything here is built for one measured target (docs/TARGETS.md, region
 * `weapon`):
 *
 *     lum_mean 79.8   lum_std 49.4   sat_mean 73.5
 *     lap_var 489     edge_density 0.089   local_contrast 0.178
 *
 * i.e. a *dark* object — 26% below the frame mean — carrying the highest local
 * contrast in the image. That combination only comes from one thing: chamfered edges
 * catching hard specular rim highlights against a near-black matte body. So every
 * box in this file is a chamfered box, every chamfer facet carries an `aMask.x` edge
 * weight, and the shader turns that weight into exposed-metal wear with lower
 * roughness. Take the chamfers away and the silhouette survives but `lap_var` and
 * `local_contrast` collapse — the gun goes to a grey prop.
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
const MOUNT_POS = new THREE.Vector3(0.200, -0.146, -0.400);
const MOUNT_ROT = { pitch: 0.1222, yaw: 0.1571, roll: 0.1745 };   // 7 / 9 / 10 deg
const ADS_POS = new THREE.Vector3(0.052, -0.092, -0.335);
const ADS_ROT = { pitch: 0.0524, yaw: 0.0262, roll: 0.0175 };

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

  /** Triangle with one flat normal. Points are [x,y,z]; masks are [edge, ao]. */
  tri(a, b, c, n, ma, mb, mc) {
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
  const band = (p0, p1, q0, q1, n) => {
    const mid0 = [(p0[0] + q0[0]) * 0.5, (p0[1] + q0[1]) * 0.5, (p0[2] + q0[2]) * 0.5];
    const mid1 = [(p1[0] + q1[0]) * 0.5, (p1[1] + q1[1]) * 0.5, (p1[2] + q1[2]) * 0.5];
    mb.quad(p0, p1, mid1, mid0, n, mLo, mLo, mHi, mHi);
    mb.quad(mid0, mid1, q1, q0, n, mHi, mHi, mLo, mLo);
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

  for (let j = 0; j < stations.length - 1; j++) {
    const A = stations[j], B = stations[j + 1];
    if (A.skip) continue;
    const mA = [A.edge || 0, A.ao ?? 1], mB = [B.edge || 0, B.ao ?? 1];
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const p0 = pt(A, i), p1 = pt(A, i2), p2 = pt(B, i2), p3 = pt(B, i);
      const n0 = nAt(A, vN[i][0]), n1 = nAt(A, vN[i][1]);
      const n2 = nAt(B, vN[i][1]), n3 = nAt(B, vN[i][0]);
      mb.quadN(p0, n0, p1, n1, p2, n2, p3, n3, mA, mA, mB, mB);
    }
  }
  if (o.capFront !== false) capProfile(mb, prof, stations[0], -1, o);
  if (o.capBack !== false) capProfile(mb, prof, stations[stations.length - 1], 1, o);
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

function transformMB(geo, m) {
  geo.applyMatrix4(m);
  return geo;
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
  const hgt = new Float32Array(N * N);
  const wearF = new Float32Array(N * N);

  // --- base cast/machined grain
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = x / N * 8, v = y / N * 8;
      const g = fbmT(u, v, 8, 4, 11) - 0.5;
      const fine = fbmT(u * 6, v * 6, 48, 2, 27) - 0.5;
      hgt[i] = (g * 0.55 + fine * 0.45) * grain;
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
    const len = N * (0.02 + Math.pow(rand.next(), 2.2) * 0.55);
    const amp = (rand.next() < 0.30 ? 1 : -1) * (0.05 + rand.next() * 0.28);
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
      const dhx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const dhy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      const nx = Math.max(-1, Math.min(1, -dhx * 6.0));
      const ny = Math.max(-1, Math.min(1, -dhy * 6.0));
      // roughness: scratch cores polish, cast grain roughens
      const rgh = 0.5 + hgt[i] * 0.9;
      // wear: mottled, contrast stretched so it breaks up rather than washes
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
  const uv = (p) => [(p.x - x0) / (x1 - x0), 1 - (p.y - y0) / (y1 - y0)];
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
