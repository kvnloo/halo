import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyWorldMaterial } from '../gfx/materialCommon.js';
import { patchForGBuffer, MAT_ID } from '../gfx/GBufferMaterial.js';
import { LAYER } from '../render/RenderPipeline.js';
import { NOISE_GLSL } from '../gfx/glsl/noise.js';

/**
 * `structures` — the Forerunner bridge.
 *
 * The dominant man-made silhouette in the opening shots: a cantilevered deck that
 * comes out of the cliff at (54, 60) and reaches over the shallows to (-34, -4),
 * broken off at the tip. Two raked A-frames carry it, each a pair of tapered blades.
 *
 * ---------------------------------------------------------------------------
 * How it is built
 *
 * Everything is a *chamfered plate*: a 2D outline extruded a short distance with a
 * one-segment bevel. That single primitive gives Forerunner architecture exactly what
 * it needs — large flat planes, hard chamfers on every edge, deep recessed channels
 * (stack two plates with different outlines), and a repeating rib/coffer grid. There
 * is no greebling; the density comes from the *layout*, not from stuck-on detail.
 *
 * The deck is a stack of four plan-view plates rather than one box, so the fascia has
 * a real recessed band in it, and so the ruined tip can be a different outline on
 * every layer — the break is stepped in three dimensions instead of being a saw cut.
 *
 * ---------------------------------------------------------------------------
 * How it is shaded
 *
 * `applyWorldMaterial` supplies sun, shadow and aerial perspective. On top of that
 * every vertex carries its position and normal *in its own part's frame* (`aLocal`,
 * `aLocalN`), so the fragment shader can lay out panel seams in bridge coordinates on
 * the deck and in blade coordinates on the struts, with the same code. From those the
 * shader derives:
 *
 *   - an irregular panel-joint network (three tiers plus a sparse diagonal family),
 *     rendered as a groove *and* as a normal tilt, so the sun lights one wall of every
 *     seam and shadows the other. Seams that only darken read as decals; seams that
 *     bend the normal read as geometry.
 *   - vertical water streaking hung off the top edge of each panel. 100,000 years of
 *     rain is the single strongest weathering cue in the reference footage.
 *   - dust and sand on upward faces, heaviest near the cliff anchor.
 *   - edge wear on the chamfers, found analytically: an axis-aligned face has one
 *     normal component at 1.0, a chamfer has none above ~0.71, so `1 - max(|n|)` is a
 *     curvature mask that costs three abs and two max.
 *
 * ---------------------------------------------------------------------------
 * Also here: the dust haze under the deck (kf_00000 / kf_00120). Soft billboards
 * elongated along the sun direction, which is most of the look of a light shaft for a
 * fraction of the cost of marching one.
 */

/* ========================================================================== */
/*  Layout — docs/WORLD.md 'bridge'. Do not drift from these.                 */
/* ========================================================================== */

const ANCHOR = { x: 54, z: 60 };
const TIP = { x: -34, z: -4 };

const DECK_Y = 21.5;                 // deck walking surface
const DECK_THICK = 2.6;              // -> underside 18.9
const HALF_W = 7.75;                 // 15.5 m wide
const RUN_LEN = Math.hypot(TIP.x - ANCHOR.x, TIP.z - ANCHOR.z);   // 108.83
const Z_BURIED = -24;                // local z where the deck starts, inside the cliff

const SOFFIT_Y = DECK_Y - DECK_THICK;      // 18.9  — rib faces
const COFFER_Y = SOFFIT_Y + 0.40;          // 19.30 — recessed panel floor
const RIB_W = 0.35;                        // spec: 0.35 m rib grid

const GIRDER_BOT = 16.30;
const CHANNEL_X = 6.98;                    // recessed light channel floor, girder
const CHANNEL_Y0 = 17.18, CHANNEL_Y1 = 17.82;

const PARAPET_TOP = DECK_Y + 0.9;          // 0.9 m chamfered rail
const RAIL_CH_Y0 = 21.84, RAIL_CH_Y1 = 22.06;

const OVER = 0.02;                         // stacked plates overlap, no coplanar z-fight

/** Struts: feet from WORLD.md, converted to bridge-local in build(). */
const STRUT_FEET = [
  { x: 6, y: 2.4, z: 30, scale: 1.00 },     // near the cliff — the broad pylon
  { x: -26, y: 0.6, z: 2, scale: 0.86 },    // at the tip — the one standing in the water
];

const PART = { DECK: 0, STRUT: 1, GIRDER: 2, RAIL: 3, RIB: 4, COFFER: 5, ANCHOR: 6 };

/* ========================================================================== */
/*  Geometry primitives                                                        */
/* ========================================================================== */

/** A 2D outline extruded `thickness` along +Z with a hard one-segment chamfer. */
function plate(contour, holes, thickness, chamfer) {
  const c = Math.max(0, Math.min(chamfer, thickness * 0.42));
  const shape = new THREE.Shape(contour.map((p) => new THREE.Vector2(p[0], p[1])));
  if (holes) for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness - 2 * c,
    bevelEnabled: c > 1e-4,
    bevelThickness: c, bevelSize: c, bevelOffset: 0, bevelSegments: 1,
    steps: 1, curveSegments: 1,
  });
  if (c > 1e-4) g.translate(0, 0, c);
  g.deleteAttribute('uv');
  return g;
}

/** rotX(-90): shape (x,y,z) -> (x, z, -y). Plan outlines are written as (x, z). */
const _planM = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
function planMat(y0) {
  const m = _planM.clone();
  m.setPosition(0, y0, 0);
  return m;
}
const flipZ = (pts) => pts.map((p) => [p[0], -p[1]]);

/** Plate lying in the horizontal plane, outline in bridge (x, z), rising from y0. */
function planPlate(pts, holes, y0, thickness, chamfer) {
  return { geo: plate(flipZ(pts), holes ? holes.map(flipZ) : null, thickness, chamfer), mat: planMat(y0) };
}

/** Plate on the vertical plane x = x0, outline in bridge (z, y), thickness along +X. */
function sidePlate(pts, holes, x0, thickness, chamfer) {
  const conv = (a) => a.map((p) => [-p[0], p[1]]);
  const geo = plate(conv(pts), holes ? holes.map(conv) : null, thickness, chamfer);
  // shape (x,y,z) -> (z + x0, y, -x):  det = +1
  const m = new THREE.Matrix4().set(
    0, 0, 1, x0,
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1);
  return { geo, mat: m };
}

const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _mA = new THREE.Matrix4();
const IDENT = new THREE.Matrix4();

/**
 * Stamp a piece into the merge list.
 *
 * `toBridge` places the piece in bridge space. `toPart` maps the authored geometry
 * into the frame its *panel layout* lives in — the bridge frame for the deck, the
 * blade frame for a strut. Each vertex therefore carries:
 *
 *   aLocal        position in the part frame     (where the seam lattice is laid out)
 *   aAxX / aAxY   the part frame's X and Y axes, expressed in bridge space
 *
 * From those two axes the shader recovers the part-frame normal out of the *shaded*
 * world normal, and pushes its seam perturbation back the other way — so the panel
 * grid follows the blade on a raked strut and the run on the deck, with one code path.
 */
function bake(out, geo, toBridge, toPart, part, ao) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position;
  const n = pos.count;

  const mp = toPart || toBridge;
  const loc = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(mp);
    loc[i * 3] = _v.x; loc[i * 3 + 1] = _v.y; loc[i * 3 + 2] = _v.z;
  }

  // part -> bridge rotation
  _mA.copy(mp).invert().premultiply(toBridge || IDENT);
  _nm.setFromMatrix4(_mA);
  const ax = new THREE.Vector3(1, 0, 0).applyMatrix3(_nm).normalize();
  const ay = new THREE.Vector3(0, 1, 0).applyMatrix3(_nm).normalize();

  const axA = new Float32Array(n * 3);
  const ayA = new Float32Array(n * 3);
  const info = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    axA[i * 3] = ax.x; axA[i * 3 + 1] = ax.y; axA[i * 3 + 2] = ax.z;
    ayA[i * 3] = ay.x; ayA[i * 3 + 1] = ay.y; ayA[i * 3 + 2] = ay.z;
    info[i * 2] = part; info[i * 2 + 1] = ao;
  }
  g.setAttribute('aLocal', new THREE.BufferAttribute(loc, 3));
  g.setAttribute('aAxX', new THREE.BufferAttribute(axA, 3));
  g.setAttribute('aAxY', new THREE.BufferAttribute(ayA, 3));
  g.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
  if (toBridge) g.applyMatrix4(toBridge);
  out.push(g);
  return g;
}

/* ========================================================================== */
/*  The bridge                                                                 */
/* ========================================================================== */

/**
 * Ruined-tip outline for one deck layer.
 * A rake plus a couple of deliberate steps and a light jitter, different on every
 * layer so the break reads as torn rather than sawn.
 */
function tipOutline(halfW, zEnd, rake, jag, rnd, steps) {
  const N = 11;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);                 // 0 at +x, 1 at -x
    const x = halfW - 2 * halfW * t;
    let z = zEnd - rake * t;
    z += (rnd.next() - 0.5) * jag;
    for (const s of steps) if (t >= s.t0 && t <= s.t1) z -= s.d;
    pts.push([x, z]);
  }
  // hard vertical facets: duplicate x at each step boundary so the break has corners
  return pts;
}

function deckPlan(halfW, tip) {
  const pts = [[halfW, Z_BURIED]];
  for (const p of tip) pts.push(p);
  pts.push([-halfW, Z_BURIED]);
  return pts;
}

function buildBridge(ctx) {
  const rnd = ctx.rand.fork('bridge');
  const out = [];

  /* ---------------------------------------------------------------- deck */
  // Four stacked plan plates. One tall fascia plane carrying a single crisp
  // recessed line near the top, then a deep undercut into the soffit — the
  // reference silhouette is three strong horizontals, not six weak ones.
  const layers = [
    { y0: DECK_Y - 0.38, y1: DECK_Y, hw: HALF_W, ch: 0.14, zEnd: 106.2, rake: 4.6, jag: 0.55, ao: 1.0 },
    { y0: DECK_Y - 0.66, y1: DECK_Y - 0.36, hw: HALF_W - 0.26, ch: 0.06, zEnd: 104.9, rake: 3.4, jag: 0.9, ao: 0.52 },
    { y0: DECK_Y - 2.05, y1: DECK_Y - 0.64, hw: HALF_W, ch: 0.16, zEnd: 107.9, rake: 5.8, jag: 0.7, ao: 1.0 },
    { y0: COFFER_Y, y1: DECK_Y - 2.03, hw: HALF_W - 0.30, ch: 0.09, zEnd: 106.4, rake: 4.2, jag: 0.5, ao: 0.72 },
  ];
  const stepSets = [
    [{ t0: 0.30, t1: 0.46, d: 2.6 }, { t0: 0.72, t1: 0.83, d: 1.5 }],
    [{ t0: 0.24, t1: 0.44, d: 3.4 }],
    [{ t0: 0.36, t1: 0.50, d: 2.0 }, { t0: 0.80, t1: 1.00, d: 3.1 }],
    [{ t0: 0.28, t1: 0.48, d: 2.8 }],
  ];
  layers.forEach((L, i) => {
    const tip = tipOutline(L.hw, L.zEnd, L.rake, L.jag, rnd, stepSets[i]);
    const p = planPlate(deckPlan(L.hw, tip), null, L.y0, L.y1 - L.y0, L.ch);
    bake(out, p.geo, p.mat, p.mat, PART.DECK, L.ao);
  });

  /* ------------------------------------------------------- deck top relief */
  // Barely visible from the beach, but it stops the walking surface reading as a
  // single extrusion from the bridge-top poses.
  for (let i = 0; i < 12; i++) {
    const z0 = -18 + i * 9.9 + rnd.range(-1.4, 1.4);
    const w = rnd.range(4.4, 6.4);
    const off = rnd.range(-1.6, 1.6);
    const p = planPlate(rect(-w + off, w + off, z0, z0 + rnd.range(5.5, 8.4)), null,
      DECK_Y - 0.16, 0.16 + OVER, 0.07);
    bake(out, p.geo, p.mat, p.mat, PART.DECK, 0.88);
  }

  /* ------------------------------------------------------------- parapets */
  // 0.9 m rail, three stacked plates so the middle is a continuous recessed
  // channel on both faces — that channel carries the cyan strips.
  const railZ = [];
  {
    let z = -14;
    while (z < 100) {
      const len = rnd.range(15, 27);
      railZ.push([z, Math.min(z + len, 102.5)]);
      z += len + rnd.range(0.30, 0.55);       // expansion breaks
    }
    railZ[railZ.length - 1][1] = Math.min(railZ[railZ.length - 1][1], 100.5);
  }
  const railBands = [
    { y0: DECK_Y - OVER, y1: DECK_Y + 0.34, xi: 6.80, xo: 7.71, ch: 0.08 },
    { y0: DECK_Y + 0.32, y1: DECK_Y + 0.58, xi: 7.02, xo: 7.47, ch: 0.05, ao: 0.42 },
    { y0: DECK_Y + 0.56, y1: PARAPET_TOP, xi: 6.80, xo: 7.71, ch: 0.10 },
  ];
  for (const s of [1, -1]) {
    for (const seg of railZ) {
      // the -x rail is broken back further: asymmetric ruin
      const zEnd = s < 0 ? Math.min(seg[1], 96.5) : seg[1];
      if (zEnd - seg[0] < 1.5) continue;
      for (const b of railBands) {
        const p = planPlate(rect(Math.min(s * b.xi, s * b.xo), Math.max(s * b.xi, s * b.xo), seg[0], zEnd),
          null, b.y0, b.y1 - b.y0, b.ch);
        bake(out, p.geo, p.mat, p.mat, PART.RAIL, b.ao ?? 1.0);
      }
    }
  }

  /* -------------------------------------------------------------- girders */
  // Hangs below each deck edge. Proud chamfered nose (the bright specular line in
  // the reference) over a deep recessed channel (the black slot under it).
  const gp = [
    [6.10, SOFFIT_Y + 0.30], [7.50, SOFFIT_Y + 0.30], [7.50, 18.42],
    [7.80, 18.16], [7.80, 17.98],
    [7.34, 17.90], [CHANNEL_X, CHANNEL_Y1], [CHANNEL_X, CHANNEL_Y0], [7.36, 17.10],
    [7.62, 16.94], [7.62, 16.72], [7.24, GIRDER_BOT], [6.60, GIRDER_BOT], [6.10, 16.86],
  ];
  for (const s of [1, -1]) {
    const contour = gp.map((p) => [p[0] * s, p[1]]);
    const g = plate(contour, null, 132.0, 0.07);
    const m = new THREE.Matrix4().makeTranslation(0, 0, Z_BURIED);
    bake(out, g, m, m, PART.GIRDER, 1.0);
  }

  /* --------------------------------------------------- soffit coffer grid */
  // Bays of ~5.6 m with a heavier rib between them; 0.4 m deep so the grid still
  // casts a readable shadow line at 50 m rather than dissolving into a waffle.
  const ribZ = [];
  {
    let z = -16, i = 0;
    while (z < 107) {
      const heavy = (i % 2) === 1;
      ribZ.push({ z, heavy });
      z += heavy ? 5.9 : 5.4;
      i++;
    }
  }
  const longX = [0, 3.68, -3.68, 7.10, -7.10];
  for (const x of longX) {
    const w = Math.abs(x) > 6 ? RIB_W * 1.7 : RIB_W;
    const p = planPlate(rect(x - w * 0.5, x + w * 0.5, -16, 106.2), null,
      SOFFIT_Y, COFFER_Y - SOFFIT_Y + OVER, 0.06);
    bake(out, p.geo, p.mat, p.mat, PART.RIB, 1.0);
  }
  for (const r of ribZ) {
    const w = r.heavy ? 0.78 : RIB_W;
    const drop = r.heavy ? 0.22 : 0.0;
    const p = planPlate(rect(-7.42, 7.42, r.z - w * 0.5, r.z + w * 0.5), null,
      SOFFIT_Y - drop, COFFER_Y - SOFFIT_Y + drop + OVER, 0.06);
    bake(out, p.geo, p.mat, p.mat, PART.RIB, 1.0);
  }
  // recessed panel inside every coffer cell (a second, deeper step)
  const cellX = [[-7.10, -3.68], [-3.68, 0], [0, 3.68], [3.68, 7.10]];
  for (let i = 0; i < ribZ.length - 1; i++) {
    const z0 = ribZ[i].z + (ribZ[i].heavy ? 0.39 : 0.175) + 0.42;
    const z1 = ribZ[i + 1].z - (ribZ[i + 1].heavy ? 0.39 : 0.175) - 0.42;
    if (z1 - z0 < 0.9) continue;
    for (const cx of cellX) {
      const x0 = cx[0] + 0.55, x1 = cx[1] - 0.55;
      const p = planPlate(rect(x0, x1, z0, z1), null, COFFER_Y, 0.20 + OVER, 0.06);
      bake(out, p.geo, p.mat, p.mat, PART.COFFER, 0.48);
    }
  }

  /* ---------------------------------------------------------- fascia inset */
  // Long diagonal step plates on the outer face. Asymmetric layout: the two sides
  // do not share stations, which is what stops a 109 m extrusion looking extruded.
  for (const s of [1, -1]) {
    let z = -12 + (s > 0 ? 0 : 9.5);
    while (z < 100) {
      const len = rnd.range(17, 31);
      const y0 = DECK_Y - 1.94 + rnd.range(0, 0.20);
      const y1 = DECK_Y - 0.80 - rnd.range(0, 0.22);
      const skew = rnd.range(4.5, 11.0) * (rnd.next() < 0.5 ? 1 : -1);
      const pts = [[z + 0.9, y0], [z + len - 0.9, y0],
      [z + len - 0.9 + Math.min(0, skew), y1], [z + 0.9 + Math.max(0, skew), y1]];
      const p = sidePlate(pts, null, s > 0 ? HALF_W - 0.22 : -HALF_W - 0.05, 0.27, 0.075);
      bake(out, p.geo, p.mat, p.mat, PART.DECK, 0.90);
      z += len + rnd.range(1.6, 3.6);
    }
  }

  /* --------------------------------------------------------- anchor collar */
  // The mass the deck emerges from where it enters the cliff. Stepped back in
  // three tiers so the deck grows out of it rather than being plugged into a box.
  {
    const tiers = [
      { hw: 11.4, y0: 14.4, y1: 24.9, z1: 1.6, ch: 0.40 },
      { hw: 9.9, y0: 15.6, y1: 24.0, z1: 7.4, ch: 0.32 },
      { hw: 8.9, y0: 16.6, y1: 23.2, z1: 12.6, ch: 0.26 },
    ];
    for (const t of tiers) {
      const p = planPlate([[-t.hw, Z_BURIED], [t.hw, Z_BURIED], [t.hw, t.z1 - 2.2],
      [t.hw - 1.5, t.z1], [-t.hw + 1.5, t.z1], [-t.hw, t.z1 - 2.2]],
        null, t.y0, t.y1 - t.y0, t.ch);
      bake(out, p.geo, p.mat, p.mat, PART.ANCHOR, 1.0);
    }
    for (let i = 0; i < 4; i++) {
      const z0 = -9 + i * 4.4;
      const r = planPlate(rect(-11.9, 11.9, z0, z0 + 1.9), null, 15.2, 8.6, 0.20);
      bake(out, r.geo, r.mat, r.mat, PART.ANCHOR, 0.92);
    }
  }

  /* ------------------------------------------------------------- tip ruin */
  // Torn skin, exposed internal webs, one slab still hanging on.
  {
    for (let i = 0; i < 7; i++) {
      const x = rnd.range(-6.6, 6.6);
      const z = rnd.range(101.5, 107.5);
      const w = rnd.range(0.24, 0.5);
      const h = rnd.range(0.8, 2.0);
      const p = planPlate(rect(x - w, x + w, z - rnd.range(1.2, 3.2), z), null,
        COFFER_Y - 0.1, h, 0.04);
      bake(out, p.geo, p.mat, p.mat, PART.RIB, 0.9);
    }
    // a slab fragment tipped down off the end
    const frag = plate([[0, 0], [4.6, 0.35], [5.1, 2.9], [0.4, 3.4]], null, 0.55, 0.09);
    const fm = new THREE.Matrix4().makeRotationX(-Math.PI / 2 + 0.42);
    fm.premultiply(new THREE.Matrix4().makeRotationY(0.30));
    fm.setPosition(-5.4, 19.1, 104.9);
    bake(out, frag, fm, fm, PART.DECK, 0.95);

    const frag2 = plate([[0, 0], [3.1, 0.2], [3.4, 2.1], [0.2, 2.4]], null, 0.42, 0.08);
    const fm2 = new THREE.Matrix4().makeRotationX(-Math.PI / 2 - 0.55);
    fm2.premultiply(new THREE.Matrix4().makeRotationY(-0.5));
    fm2.setPosition(4.9, 19.6, 107.2);
    bake(out, frag2, fm2, fm2, PART.DECK, 0.95);
  }

  return out;
}

/* ========================================================================== */
/*  Struts — raked A-frames, each a pair of tapered blades                     */
/* ========================================================================== */

function buildStruts(ctx, out, toLocal) {
  const rnd = ctx.rand.fork('struts');
  const rr = (a, b) => rnd.range(a, b);
  const info = [];

  for (const foot of STRUT_FEET) {
    const f = new THREE.Vector3(foot.x, foot.y, foot.z).applyMatrix4(toLocal);
    const rake = THREE.MathUtils.degToRad(62);
    const topY = SOFFIT_Y - 1.35;                       // into the under-structure
    const rise = topY - f.y;
    const runZ = rise / Math.tan(rake);                 // leans toward the tip
    const L = Math.hypot(rise, runZ);
    const sc = foot.scale;

    const splayTop = 4.75 * sc, splayFoot = 1.25 * sc;

    for (const side of [1, -1]) {
      // Blade frame: +Y up the rake, +X the chord (in the run/up plane), +Z the
      // broad face normal (~ +/-X in bridge space, so the blade is seen face-on
      // from the beach).
      const topP = new THREE.Vector3(f.x + side * splayTop, topY, f.z + runZ);
      const botP = new THREE.Vector3(f.x + side * splayFoot, f.y, f.z);
      const up = topP.clone().sub(botP).normalize();
      const len = topP.distanceTo(botP);
      const nrm = new THREE.Vector3(side, 0, 0);
      nrm.addScaledVector(up, -nrm.dot(up)).normalize();
      const chord = new THREE.Vector3().crossVectors(up, nrm).normalize();
      const th = 1.42 * sc;
      const basis = new THREE.Matrix4().makeBasis(chord, up, nrm);
      basis.setPosition(botP.x - nrm.x * th * 0.5, botP.y - nrm.y * th * 0.5, botP.z - nrm.z * th * 0.5);

      const hcB = 2.05 * sc, hcT = 3.85 * sc;
      const hc = (t) => THREE.MathUtils.lerp(hcB, hcT, t * t * 0.45 + t * 0.55);
      const outline = [
        [-hcB * 1.10, -0.35], [hcB * 1.10, -0.35],
        [hc(0.10), 0.10 * len], [hc(0.42), 0.42 * len], [hc(0.74), 0.74 * len],
        [hc(0.90) + 0.24, 0.90 * len], [hc(1.0) + 0.55, 0.965 * len], [hc(1.0) + 0.55, len + 0.9],
        [-hc(1.0) - 0.55, len + 0.9], [-hc(1.0) - 0.55, 0.965 * len], [-hc(0.90) - 0.24, 0.90 * len],
        [-hc(0.74), 0.74 * len], [-hc(0.42), 0.42 * len], [-hc(0.10), 0.10 * len],
      ];
      bake(out, plate(outline, null, th, 0.20), basis, IDENT, PART.STRUT, 1.0);

      // Nested chevron steps on both faces — the signature blade motif. Each ring
      // steps up toward the centre, so the blade reads as a ziggurat in section:
      // three concentric bright chamfers with dark grooves between them.
      const mkRing = (inset, apex, tops, bots) => {
        const seq = [bots, 0.34, 0.66, tops];
        const r = [];
        for (const t of seq) r.push([hc(t) - inset, t * len]);
        r.push([0, tops * len + apex]);                       // the chevron point
        for (let i = seq.length - 1; i >= 0; i--) r.push([-(hc(seq[i]) - inset), seq[i] * len]);
        return r;
      };
      for (let k = 0; k < 3; k++) {
        const inset = 0.42 + k * 0.86;
        const step = 0.26 - k * 0.05;
        const tops = 0.90 - k * 0.075, bots = 0.055 + k * 0.05;
        const apex = 2.4 - k * 0.5;
        const ring = mkRing(inset, apex, tops, bots);
        const hole = mkRing(inset + 0.46, apex - 0.7, tops - 0.016, bots + 0.03);
        const g = plate(ring, k < 2 ? [hole] : null, step, 0.075);
        for (const face of [1, -1]) {
          const t = new THREE.Matrix4().makeTranslation(0, 0, face > 0 ? th : -step);
          const m = basis.clone().multiply(t);
          bake(out, g.clone(), m, t, PART.STRUT, k === 0 ? 0.78 : 0.9);
        }
        g.dispose();
      }

      info.push({ top: topP, bot: botP, radius: th * 0.72 });
    }

    // transverse collar tying the pair together
    for (const tt of [0.30, 0.66]) {
      const y = THREE.MathUtils.lerp(f.y, topY, tt);
      const z = f.z + runZ * tt;
      const w = THREE.MathUtils.lerp(splayFoot, splayTop, tt) + 0.9 * sc;
      const p = planPlate(rect(-w, w, z - 1.25 * sc, z + 1.25 * sc), null, y, 1.05 * sc, 0.12);
      const m = new THREE.Matrix4().makeTranslation(f.x, 0, 0).multiply(p.mat);
      bake(out, p.geo, m, m, PART.STRUT, 0.9);
    }

    // foot pad
    {
      const w = splayFoot + 2.5 * sc;
      const p = planPlate([[-w, -2.4 * sc], [w, -2.4 * sc], [w * 0.8, 2.6 * sc], [-w * 0.8, 2.6 * sc]],
        null, f.y - 1.6, 2.0, 0.2);
      const m = new THREE.Matrix4().makeTranslation(f.x, 0, f.z).multiply(p.mat);
      bake(out, p.geo, m, m, PART.STRUT, 1.0);
    }

    // knuckle where the pair meets the deck
    {
      const w = splayTop + 1.7 * sc;
      const p = planPlate([[-w, -2.9 * sc], [w, -2.9 * sc], [w - 0.7, 3.1 * sc], [-w + 0.7, 3.1 * sc]],
        null, topY - 0.1, SOFFIT_Y - topY + 0.4, 0.22);
      const m = new THREE.Matrix4().makeTranslation(f.x, 0, f.z + runZ).multiply(p.mat);
      bake(out, p.geo, m, m, PART.STRUT, 0.85);
    }

    // machinery hub hanging under the deck at the pylon head (reference kf_00000)
    if (sc > 0.95) {
      const cz = f.z + runZ - 1.2, cx = f.x;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const r = 1.5 + (i % 3) * 0.55;
        const w = rr(0.35, 0.8), d = rr(0.5, 1.3), h = rr(0.5, 1.5);
        const p = planPlate(rect(-w, w, -d, d), null, SOFFIT_Y - h - 0.3, h, 0.08);
        const m = new THREE.Matrix4().makeTranslation(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r * 1.25).multiply(p.mat);
        bake(out, p.geo, m, m, PART.STRUT, 0.7);
      }
      const p = planPlate(rect(-2.5, 2.5, -3.0, 3.0), null, SOFFIT_Y - 1.0, 0.9, 0.25);
      const m = new THREE.Matrix4().makeTranslation(cx, 0, cz).multiply(p.mat);
      bake(out, p.geo, m, m, PART.STRUT, 0.75);
    }
  }
  return info;
}

/* ========================================================================== */
/*  Surface shader                                                             */
/* ========================================================================== */

const ALLOY_PARS = /* glsl */`
${NOISE_GLSL}
uniform mat4  uBridgeInv;
uniform vec3  uAlloyDark;
uniform vec3  uAlloyLight;
uniform vec3  uAlloyWorn;
uniform vec3  uDustCol;
uniform vec3  uEmisCol;
uniform vec3  uBounceCol;
uniform float uEmisGain;
uniform float uSeam;
uniform float uStreak;
uniform float uDust;
uniform float uBounce;
varying vec3  vLocalP;
varying vec3  vAxX;
varying vec3  vAxY;
varying vec2  vInfo;

/** Irregular but perfectly straight joint lattice.
 *  x -> (distance to nearest joint, cell id, side sign, upper joint position) */
vec4 jointInfo(float x, float period, float jit, float seed){
  float i0 = floor(x / period);
  float lo = -1e8, hi = 1e8;
  for (int k = -2; k <= 2; k++){
    float i = i0 + float(k);
    float j = (i + jit * (hash11(i * 1.731 + seed) - 0.5)) * period;
    if (j <= x) lo = max(lo, j); else hi = min(hi, j);
  }
  float dl = x - lo, dh = hi - x;
  return vec4(min(dl, dh), floor(lo / period + 0.5), dl < dh ? 1.0 : -1.0, hi);
}
`;

const ALLOY_FRAG = /* glsl */`
  vec3  lp   = vLocalP;
  float part = vInfo.x;
  float ao   = vInfo.y;

  vec3  wN = normalize(normal * mat3(viewMatrix));      // shaded world normal
  vec3  bN = normalize(mat3(uBridgeInv) * wN);          // ... in bridge space
  vec3  aX = normalize(vAxX), aY = normalize(vAxY);
  vec3  aZ = cross(aX, aY);
  vec3  ln = vec3(dot(bN, aX), dot(bN, aY), dot(bN, aZ));   // ... in part space

  vec3  an = abs(ln);
  float mx = max(an.x, max(an.y, an.z));

  // Project onto the plane of the dominant axis. Every face therefore shares the
  // 'along the run' coordinate, so longitudinal seams continue across chamfers.
  vec2 uvp; vec3 tU, tV;
  if (an.y >= mx - 1e-4)      { uvp = vec2(lp.z, lp.x); tU = vec3(0,0,1); tV = vec3(1,0,0); }
  else if (an.x >= mx - 1e-4) { uvp = vec2(lp.z, lp.y); tU = vec3(0,0,1); tV = vec3(0,1,0); }
  else                        { uvp = vec2(lp.x, lp.y); tU = vec3(1,0,0); tV = vec3(0,1,0); }

  float sideAmt = 1.0 - smoothstep(0.42, 0.82, an.y);   // 1 on vertical faces
  vec3  bp = (uBridgeInv * vec4(vWorldPositionWM, 1.0)).xyz;

  float px  = max(fwidth(uvp.x), fwidth(uvp.y)) + 1e-5;
  float lod = 1.0 - smoothstep(0.008, 0.048, px);       // fade sub-pixel tiers

  bool  isDeck  = part < 0.5;
  // Big plates. The reference's fascia panels are 15-25 m long, separated by one
  // bold groove — small panels everywhere read as corduroy, not architecture.
  float pu = isDeck ? 16.0 : 3.6;
  float pv = isDeck ? 2.55 : 2.4;

  vec4 Ju = jointInfo(uvp.x, pu, 0.52, 3.1 + part * 11.0);
  vec4 Jv = jointInfo(uvp.y, pv, 0.46, 17.7 + part * 5.3);
  float cell = hash12(vec2(Ju.y, Jv.y) * 1.31 + part * 3.7);

  // --- tier 1: major recessed channels ------------------------------------
  float wA = 0.155;
  float gu = 1.0 - smoothstep(wA - px * 0.9, wA + px * 0.9, Ju.x);
  float gv = 1.0 - smoothstep(wA - px * 0.9, wA + px * 0.9, Jv.x);

  // --- tier 2: panel subdivision ------------------------------------------
  vec4 Su = jointInfo(uvp.x, pu * 0.27, 0.55, 91.0 + part * 4.0);
  vec4 Sv = jointInfo(uvp.y, pv * 0.55, 0.50, 131.0 + part * 6.0);
  float wB = 0.055;
  float su = (1.0 - smoothstep(wB - px, wB + px, Su.x)) * step(0.55, hash11(Su.y * 0.71 + 5.0)) * lod;
  float sv = (1.0 - smoothstep(wB - px, wB + px, Sv.x)) * step(0.68, hash11(Sv.y * 1.13 + 9.0)) * lod;

  // --- tier 3: sparse long diagonals (the Forerunner 'arrow' seams) --------
  vec2 dv = mat2(0.9063, 0.4226, -0.4226, 0.9063) * uvp;
  vec4 Jd = jointInfo(dv.y, isDeck ? 13.0 : 4.2, 0.60, 61.0 + part * 2.0);
  float wD = 0.135;
  float gd = (1.0 - smoothstep(wD - px, wD + px, Jd.x)) * step(0.42, hash11(Jd.y * 0.53 + 2.7));

  // --- tier 4: 4 cm interlock gap at every joint --------------------------
  float wH = 0.02;
  float hair = max(1.0 - smoothstep(wH - px, wH + px * 2.0, Ju.x),
                   1.0 - smoothstep(wH - px, wH + px * 2.0, Jv.x)) * lod;

  float groove = max(max(gu, gv), max(max(su, sv) * 0.75, gd * 0.9));
  float seamAO = clamp(groove * 0.85 + hair * 0.55, 0.0, 1.0);

  // normal tilt: one wall of every seam catches the sun, the other falls away
  vec2 tilt = vec2(Ju.z * gu + Su.z * su * 0.6, Jv.z * gv + Sv.z * sv * 0.6);
  vec3 dN = (tU * tilt.x + tV * tilt.y) * (0.85 * uSeam);
  dN += (tU * 0.9063 + tV * -0.4226) * (Jd.z * gd * 0.5 * uSeam);

  // --- base alloy ----------------------------------------------------------
  // Weathered alloy is *cloudy*: broad tonal patches at several scales, not noise.
  float mott = fbm2(uvp * 0.115, 4) * 0.5 + 0.5;
  float mott2 = fbm2(uvp * 0.52 + 31.0, 4) * 0.5 + 0.5;
  float mott3 = fbm2(uvp * 1.9 + 71.0, 3) * 0.5 + 0.5;
  vec3 alb = mix(uAlloyDark, uAlloyLight, clamp(mott * 1.15 - 0.08, 0.0, 1.0));
  alb *= 0.80 + 0.42 * mott2;                       // plate-scale value break-up
  alb *= 0.90 + 0.20 * mott3;
  alb *= 0.80 + 0.42 * cell;                        // panel-to-panel value step
  float rough = mix(0.35, 0.62, hash11(Ju.y * 2.3 + Jv.y * 5.7 + 1.9));
  rough += (mott2 - 0.5) * 0.14;

  // faint anisotropic brushing along the run
  float brush = vnoise2(vec2(uvp.x * 0.5, uvp.y * 82.0));
  rough += (brush - 0.5) * 0.06 * lod;
  dN += tV * (brush - 0.5) * 0.10 * lod;

  // fine grain — real high-frequency information, faded before it aliases
  float grain = vnoise2(uvp * 23.0) - 0.5;
  alb *= 1.0 + grain * 0.10 * lod;
  rough += grain * 0.05 * lod;

  // --- vertical water streaking below every horizontal edge ---------------
  // The single strongest weathering cue in the reference: hard-edged dark runs
  // hanging off every ledge, with pale mineral deposit between them.
  {
    float below = max(Jv.w - uvp.y, 0.0);                  // distance below the panel top
    float li    = floor(uvp.x / 0.30);
    float lane  = hash11(li * 1.13 + 7.7);
    float lane2 = hash11(li * 2.71 + 21.3);
    float jag   = 0.60 + 0.40 * vnoise2(vec2(uvp.x * 6.5, uvp.y * 0.22));
    float dark  = smoothstep(0.42, 0.86, lane) * exp(-below / mix(1.4, 7.0, lane2)) * jag;
    float pale  = smoothstep(0.70, 0.99, lane2) * exp(-below / mix(1.0, 4.5, lane)) * jag;
    float broad = smoothstep(0.35, 1.0, vnoise2(vec2(uvp.x * 0.55, 4.4))) * exp(-below / 9.0);
    dark = (dark + broad * 0.55) * sideAmt * uStreak;
    pale = pale * sideAmt * uStreak;
    alb *= 1.0 - 0.62 * clamp(dark, 0.0, 1.0);
    alb = mix(alb, uAlloyWorn * 0.9, clamp(pale, 0.0, 0.6) * 0.45);
    rough += clamp(dark, 0.0, 1.0) * 0.22;
  }

  // --- dust / sand on upward faces, heaviest at the cliff anchor ----------
  {
    float up = clamp(wN.y, 0.0, 1.0);
    float near = mix(0.35, 1.0, smoothstep(104.0, 6.0, bp.z));
    float dn = fbm2(vec2(bp.z * 0.31, lp.x * 0.55), 4) * 0.5 + 0.5;
    float d = up * up * (0.18 + 0.82 * dn) * near * uDust;
    d = clamp(d, 0.0, 0.80);
    alb = mix(alb, uDustCol, d);
    rough = mix(rough, 0.95, d * 0.9);
  }

  // --- chamfer wear: bright metal on every hard edge -----------------------
  // 1 - max(|n|) is exactly zero on an axis-aligned face and ~0.29 on a 45 deg
  // chamfer, so it is a curvature mask for the cost of three abs and two max.
  {
    float edge = smoothstep(0.04, 0.30, 1.0 - mx);
    float wn = vnoise2(uvp * 2.7) * 0.6 + vnoise2(uvp * 11.0) * 0.4;
    float wear = edge * smoothstep(0.18, 0.72, wn);
    alb = mix(alb, uAlloyWorn, wear * 0.75);
    rough = mix(rough, 0.16, wear * 0.75);
  }

  // --- recess ambient occlusion -------------------------------------------
  float occ = ao;
  if (part > 1.5 && part < 2.5) {                      // girder light channel
    float inCh = step(6.90, abs(lp.x)) * step(abs(lp.x), 7.28)
               * step(${CHANNEL_Y0.toFixed(2)} - 0.10, lp.y) * step(lp.y, ${CHANNEL_Y1.toFixed(2)} + 0.10);
    occ *= mix(1.0, 0.10, inCh);
  }
  if (part > 2.5 && part < 3.5) {                      // parapet channel
    float inR = step(${RAIL_CH_Y0.toFixed(2)} - 0.03, lp.y) * step(lp.y, ${RAIL_CH_Y1.toFixed(2)} + 0.03);
    occ *= mix(1.0, 0.22, inR);
  }
  occ *= 1.0 - seamAO * 0.55;

  alb *= mix(0.22, 1.0, clamp(occ, 0.0, 1.0));

  diffuseColor.rgb = alb;
  roughnessFactor = clamp(rough, 0.06, 1.0);
  // seam perturbation is authored in part space -> bridge -> world -> view
  vec3 bN2 = normalize(bN + (aX * dN.x + aY * dN.y + aZ * dN.z));
  vec3 wN2 = normalize(bN2 * mat3(uBridgeInv));
  normal = normalize(mat3(viewMatrix) * wN2);

  // --- warm sand bounce on the soffit --------------------------------------
  // The reference underside is khaki, not blue: it is lit almost entirely by
  // light coming back off the beach. Added here as unshadowed irradiance.
  {
    float down = clamp(-wN2.y, 0.0, 1.0);
    totalEmissiveRadiance += alb * uBounceCol * (down * down * uBounce * clamp(occ, 0.0, 1.0));
  }

  // --- emissive strips -----------------------------------------------------
  {
    float e = 0.0;
    if (part > 1.5 && part < 2.5) {
      e = step(6.94, abs(lp.x)) * step(abs(lp.x), 7.10)
        * step(${CHANNEL_Y0.toFixed(2)} + 0.16, lp.y) * step(lp.y, ${CHANNEL_Y1.toFixed(2)} - 0.16);
    } else if (part > 2.5 && part < 3.5) {
      float band = step(${RAIL_CH_Y0.toFixed(2)} + 0.06, lp.y) * step(lp.y, ${RAIL_CH_Y1.toFixed(2)} - 0.06);
      e = band * max(step(7.40, abs(lp.x)), 1.0 - step(7.08, abs(lp.x)));
    } else if (part > 0.5 && part < 1.5) {
      // short dashes down the centreline of each blade face
      e = step(0.90, fract(lp.y * 0.22 + 0.17)) * step(abs(lp.x), 0.16) * step(0.70, an.z);
    }
    float seg = floor(bp.z * 0.19);
    float dash = mix(0.10, 1.0, step(0.26, fract(bp.z * 0.19)));
    e *= dash * step(0.18, hash11(seg * 0.77 + 4.1));
    totalEmissiveRadiance += uEmisCol * (uEmisGain * e);
  }
`;

/* ========================================================================== */
/*  Dust haze / light shafts under the deck                                    */
/* ========================================================================== */

const HAZE_VERT = /* glsl */`
varying vec2 vUvH;
varying vec3 vWpH;
varying vec2 vSeed;
attribute vec2 aSeed;
void main(){
  vUvH = uv;
  vSeed = aSeed;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWpH = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const HAZE_FRAG = /* glsl */`
${NOISE_GLSL}
varying vec2 vUvH;
varying vec3 vWpH;
varying vec2 vSeed;
uniform vec3 uHazeCol;
uniform vec3 uHazeRim;
uniform float uDensity;
uniform float uTime;
uniform vec3 uCamPos;
void main(){
  vec2 p = vUvH * 2.0 - 1.0;
  // Elongated soft core; the quad is oriented so +Y follows the sun direction,
  // which is what turns a blob into a shaft for the price of a billboard.
  float r = length(vec2(p.x * 1.55, p.y * 0.70));
  float core = exp(-r * r * 3.1);
  float n = fbm2(vec2(p.x * 2.4 + vSeed.x * 13.0, p.y * 1.0 - uTime * 0.010 + vSeed.x * 5.0), 4) * 0.5 + 0.5;
  float a = core * mix(0.20, 1.10, n) * uDensity * vSeed.y;
  // fade to nothing near the ground and at the top, so it has no cut edges
  a *= smoothstep(-1.0, -0.35, p.y) * (1.0 - smoothstep(0.55, 1.0, p.y));
  a *= smoothstep(1.2, 5.5, vWpH.y);
  float d = distance(uCamPos, vWpH);
  a *= smoothstep(5.0, 20.0, d) * (1.0 - smoothstep(140.0, 250.0, d));
  vec3 c = mix(uHazeCol, uHazeRim, clamp(n * 0.85, 0.0, 1.0));
  gl_FragColor = vec4(c, clamp(a, 0.0, 0.85));
}`;

/* ========================================================================== */

export function create(opts = {}) {
  const group = new THREE.Group();
  let mesh = null, mat = null;
  let haze = null, hazeMat = null;
  let hazeItems = [];
  const uniforms = {
    uBridgeInv: { value: new THREE.Matrix4() },
    uAlloyDark: { value: new THREE.Color(0.088, 0.084, 0.083) },
    uAlloyLight: { value: new THREE.Color(0.205, 0.194, 0.183) },
    uAlloyWorn: { value: new THREE.Color(0.330, 0.318, 0.300) },
    uDustCol: { value: new THREE.Color(0.300, 0.248, 0.166) },
    uEmisCol: { value: new THREE.Color().setHex(0x7fd8ff, THREE.SRGBColorSpace) },
    uBounceCol: { value: new THREE.Color(1.00, 0.72, 0.42) },
    uEmisGain: { value: 2.2 },
    uSeam: { value: 1.0 },
    uStreak: { value: 1.0 },
    uDust: { value: 1.0 },
    uBounce: { value: 0.75 },
  };

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _up = new THREE.Vector3();
  const _fw = new THREE.Vector3();
  const _rt = new THREE.Vector3();
  const _sc = new THREE.Vector3();

  return {
    name: 'structures',
    order: 40,
    enabled: true,

    /* ------------------------------------------------ docs/API.md interface */
    bridge: group,
    deckY: DECK_Y,
    colliders: [],
    walkableSurfaces: [],

    async init(ctx) {
      /* bridge frame: origin at the cliff anchor, +Z local runs out to the tip */
      const dx = TIP.x - ANCHOR.x, dz = TIP.z - ANCHOR.z;
      const theta = Math.atan2(dx / RUN_LEN, dz / RUN_LEN);
      group.position.set(ANCHOR.x, 0, ANCHOR.z);
      group.rotation.y = theta;
      group.updateMatrixWorld(true);
      const toLocal = new THREE.Matrix4().copy(group.matrixWorld).invert();
      uniforms.uBridgeInv.value.copy(toLocal);

      const parts = buildBridge(ctx);
      const struts = buildStruts(ctx, parts, toLocal);

      const geo = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      geo.computeBoundingSphere();

      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.5, metalness: 0.02,
        emissive: 0xffffff, emissiveIntensity: 1.0,
      });
      mat.emissive.setRGB(0, 0, 0);

      // Two hazards in the shared material layer, worked around here rather than by
      // editing files this module does not own. Both are reported upstream.
      //
      // 1. CSM.setupMaterial() *assigns* material.onBeforeCompile, and
      //    applyWorldMaterial() registers with CSM as its last act — so the
      //    world-material injection is silently thrown away on every material that
      //    receives sun shadows. Both hooks are needed, so they are composed below.
      // 2. applyWorldMaterial() splices inject.fragment at <lights_fragment_begin>,
      //    but three fills `material.diffuseColor` / `.roughness` / `.metalness` in
      //    <lights_physical_fragment>, which runs one line *earlier*. Writes to
      //    diffuseColor/roughnessFactor there are dead. The surface block is
      //    therefore spliced by hand at the correct point.
      const noLighting = Object.create(ctx);
      noLighting.get = (n, req) => (n === 'lighting' ? null : ctx.get(n, req));
      applyWorldMaterial(mat, noLighting, {
        matId: MAT_ID.FORERUNNER,
        inject: {
          key: 'forerunner-alloy',
          uniforms,
          vertexPars: 'attribute vec3 aLocal;\nattribute vec3 aAxX;\nattribute vec3 aAxY;\nattribute vec2 aInfo;\n' +
            'varying vec3 vLocalP;\nvarying vec3 vAxX;\nvarying vec3 vAxY;\nvarying vec2 vInfo;',
          vertex: 'vLocalP = aLocal; vAxX = aAxX; vAxY = aAxY; vInfo = aInfo;',
          pars: ALLOY_PARS,
        },
      });
      const wmHook = mat.onBeforeCompile;
      ctx.get('lighting')?.registerMaterial?.(mat);
      const csmHook = mat.onBeforeCompile;
      mat.onBeforeCompile = function (shader, renderer) {
        wmHook.call(this, shader, renderer);
        if (csmHook !== wmHook) csmHook.call(this, shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_physical_fragment>',
          `{\n${ALLOY_FRAG}\n}\n#include <lights_physical_fragment>`);
        mat.userData.shader = shader;
      };

      mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER.OPAQUE);
      mesh.frustumCulled = false;
      patchForGBuffer(mesh, { matId: MAT_ID.FORERUNNER, roughness: 0.5 });
      group.add(mesh);
      ctx.scene.add(group);

      this.buildHaze(ctx, toLocal);
      this.buildColliders(struts);
    },

    /* --------------------------------------------------------- dust shafts */
    buildHaze(ctx, toLocal) {
      const rnd = ctx.rand.fork('bridgeHaze');
      const rr = (a, b) => rnd.range(a, b);
      const N = 14;
      const g = new THREE.PlaneGeometry(1, 1, 1, 1);
      g.deleteAttribute('normal');
      const seeds = new Float32Array(N * 2);
      hazeItems = [];
      const toWorld = new THREE.Matrix4().copy(toLocal).invert();
      for (let i = 0; i < N; i++) {
        seeds[i * 2] = rr(0, 10);
        // Under the deck and biased hard toward the cliff anchor, which is where
        // the reference plume sits. Never above the deck.
        const t = Math.pow(rnd.next(), 1.7);
        const lz = 4 + t * 62;
        const lx = rr(-9, 11);
        const ly = rr(2.0, 12.5);
        const p = new THREE.Vector3(lx, ly, lz).applyMatrix4(toWorld);
        hazeItems.push({
          pos: p,
          size: rr(9, 21) * (1.0 - 0.4 * t),
          aspect: rr(1.5, 2.4),
          amp: rr(0.55, 1.0) * (1.0 - 0.45 * t),
        });
      }
      for (let i = 0; i < N; i++) seeds[i * 2 + 1] = hazeItems[i].amp;
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 2));

      hazeMat = new THREE.ShaderMaterial({
        vertexShader: HAZE_VERT,
        fragmentShader: HAZE_FRAG,
        uniforms: {
          uHazeCol: { value: new THREE.Color(0.62, 0.52, 0.38) },
          uHazeRim: { value: new THREE.Color(1.05, 0.90, 0.66) },
          uDensity: { value: 0.30 },
          uTime: { value: 0 },
          uCamPos: { value: new THREE.Vector3() },
        },
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.NormalBlending, side: THREE.DoubleSide,
      });

      haze = new THREE.InstancedMesh(g, hazeMat, N);
      haze.frustumCulled = false;
      haze.layers.set(LAYER.EFFECTS);
      haze.renderOrder = 5;
      haze.castShadow = false; haze.receiveShadow = false;
      ctx.scene.add(haze);
    },

    /* ---------------------------------------------------------- colliders */
    buildColliders(struts) {
      const toWorld = group.matrixWorld;
      const mid = new THREE.Vector3(0, (DECK_Y + SOFFIT_Y) * 0.5, (RUN_LEN + Z_BURIED) * 0.5).applyMatrix4(toWorld);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, group.rotation.y, 0));
      this.colliders = [
        {
          type: 'box', center: mid, quaternion: q.clone(),
          halfExtents: new THREE.Vector3(HALF_W, DECK_THICK * 0.5, (RUN_LEN - Z_BURIED) * 0.5),
        },
      ];
      for (const s of [1, -1]) {
        const c = new THREE.Vector3(s * (HALF_W - 0.4), DECK_Y + 0.45, (RUN_LEN + Z_BURIED) * 0.5).applyMatrix4(toWorld);
        this.colliders.push({
          type: 'box', center: c, quaternion: q.clone(),
          halfExtents: new THREE.Vector3(0.42, 0.45, (RUN_LEN - Z_BURIED) * 0.5),
        });
      }
      for (const b of struts) {
        this.colliders.push({
          type: 'capsule',
          a: b.bot.clone().applyMatrix4(toWorld),
          b: b.top.clone().applyMatrix4(toWorld),
          radius: b.radius,
        });
      }
      this.walkableSurfaces = [{
        type: 'rect',
        y: DECK_Y,
        center: new THREE.Vector3(0, DECK_Y, (RUN_LEN + Z_BURIED) * 0.5).applyMatrix4(toWorld),
        normal: new THREE.Vector3(0, 1, 0),
        u: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
        v: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
        halfU: HALF_W - 0.9,
        halfV: (RUN_LEN - Z_BURIED) * 0.5,
      }];
    },

    update(dt, ctx) { },

    prerender(ctx) {
      if (!haze) return;
      const time = ctx.get('time');
      const cam = ctx.camera;
      const sun = time ? time.sunDir : _up.set(0.67, 0.66, -0.35).normalize();
      hazeMat.uniforms.uCamPos.value.copy(cam.position);
      hazeMat.uniforms.uTime.value = ctx.config.frozen ? 0 : ctx.clock.t;

      if (time) {
        // warm forward-scattered sunlight; the rim picks up the sun colour directly
        hazeMat.uniforms.uHazeCol.value.copy(time.sunColor).multiplyScalar(0.42).lerp(
          time.skyColor, 0.30);
        hazeMat.uniforms.uHazeRim.value.copy(time.sunColor).multiplyScalar(0.95);
      }
      const density = ctx.config.bridgeHaze ?? 0.30;

      for (let i = 0; i < hazeItems.length; i++) {
        const it = hazeItems[i];
        _fw.copy(cam.position).sub(it.pos).normalize();
        // billboard, but with its long axis locked to the sun direction
        _up.copy(sun).addScaledVector(_fw, -sun.dot(_fw));
        if (_up.lengthSq() < 1e-4) _up.set(0, 1, 0); else _up.normalize();
        _rt.crossVectors(_up, _fw).normalize();
        _m.makeBasis(_rt, _up, _fw);
        _q.setFromRotationMatrix(_m);
        _sc.set(it.size, it.size * it.aspect, 1);
        _m.compose(it.pos, _q, _sc);
        haze.setMatrixAt(i, _m);
      }
      haze.instanceMatrix.needsUpdate = true;
      hazeMat.uniforms.uDensity.value = density;
    },

    resize(w, h, ctx) { },

    dispose(ctx) {
      ctx.scene.remove(group);
      if (haze) { ctx.scene.remove(haze); haze.geometry.dispose(); hazeMat.dispose(); }
      mesh?.geometry.dispose();
      mat?.dispose();
    },
  };
}
