import * as THREE from 'three';
import { NOISE_GLSL, TRIPLANAR_GLSL, HASH_GLSL } from '../gfx/glsl/noise.js';
import { applyWorldMaterial } from '../gfx/materialCommon.js';
import { MAT_ID, patchForGBuffer } from '../gfx/GBufferMaterial.js';
import { LAYER, fsMaterial, FullScreenQuad, makeRT } from '../render/RenderPipeline.js';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm2, ridged2, hash2 } from '../core/Rand.js';

/**
 * `rocks` — sea stacks, the cliff wall, the headland, the tide-pool shelf and the
 * scattered boulders. These are the hero silhouettes of Silent Cartographer, so the
 * whole module is organised around one question: *does the shape read as karst
 * limestone that the sea has been chewing on for ten thousand years, or as a
 * displaced cylinder?*
 *
 * ------------------------------------------------------------------ geometry
 *
 * Every landmark is a **warped generalised cylinder**: a radius field r(θ, t) around a
 * leaning axis, marched out to a quad mesh. That representation was chosen over an SDF
 * march because it gives three things this scene needs and marching cubes does not:
 *
 *   1. Overhang for free. r grows with height and the axis leans, so the crown hangs
 *      well outside the footprint — which is what the reference stacks actually do
 *      (kf_01500: the top-left of the hero stack overhangs its base by ~8 m).
 *   2. An exact parametric surface, so `surfacePoint(id, u, v)` is a table lookup
 *      rather than a raycast. Vegetation scatters thousands of vines off it per frame.
 *   3. Cost. The whole level builds in <1 s of JS; an SDF grid fine enough to resolve
 *      a 30 cm solution channel over a 340 m cliff is ~10^9 voxels.
 *
 * The radius field is a stack of features, each of which is a real landform:
 *
 *   profile       top-heavy Catmull-Rom spline: narrow foot, widest at ~0.75 h
 *   lobes         3 rotating cosine harmonics -> non-circular cross-section that
 *                 twists with height. This is the single thing that kills the
 *                 "procedural cylinder" read.
 *   lean          axis offset that grows as t^1.6, plus a sway term
 *   ledges        1-2 discrete bedding-plane steps with an outward lip below them —
 *                 the mid-height shelves that moss and small trees sit on
 *   karst lumps   low-frequency cylindrical fbm, ±13% of R
 *   fluting       ridged noise, high frequency in θ and almost constant in y,
 *                 subtracted -> vertical grooves
 *   channels      the same but narrower, deeper, drip-warped, and gated to the
 *                 upper faces -> karst solution channels
 *   bedding       two scales of asymmetric sawtooth in world y -> sedimentary strata
 *   notch         gaussian in y at ~1.8 m, deepest on the wave-exposed side ->
 *                 the wave-cut notch / undercut
 *   foot          outward flare below y ~ 1.2 -> the wave-cut platform the rubble
 *                 skirt sits on
 *
 * Because everything lives on a regular (θ, y) grid, three shading masks that would
 * normally need raycasts are computed by cheap separable filters over that grid and
 * baked into a vertex attribute `aRock`:
 *
 *   .x occ      cavity openness  (multi-scale radius minus its blur)
 *   .y convex   ridge/edge exposure
 *   .z shelter  how much rock hangs out above this point (under-overhang darkening)
 *   .w crown    proximity to the flat top (moss / lichen / vegetation zone)
 *
 * ------------------------------------------------------------------ material
 *
 * Pale warm limestone, not grey CG rock — see ref/detail/rock_4k.png, which is far
 * lighter and yellower than the usual default. Tri-planar, whiteout normal blending
 * (`triplanarNormal` / `triWeights` from src/gfx/glsl/noise.js) over two procedurally
 * baked detail sets sampled at four scales: 9 m, 1.15 m, 0.30 m and 0.055 m tiles.
 * With 1024² maps that resolves relief down to ~2 mm, so the 2 cm requirement is met
 * with two decades of headroom and the surface holds up in a close-up.
 *
 * On top of the tri-planar base:
 *   - curvature wear      bright exposed rock on convex edges, dark grime in concavities
 *   - vertical staining   runoff streaks running down from ledges (ridged3 stretched 25:1)
 *   - bedding             albedo + roughness banding keyed to world y with a warp
 *   - damp / algae zone   dark olive band around the tide line, patchy, heavier on
 *                         up-facing and sheltered surfaces
 *   - wet zone            below y ≈ 0: albedo × 0.48, roughness 0.13 -> specular
 *   - moss + lichen       on up-facing surfaces near the crown only
 *
 * Everything goes through `applyWorldMaterial`, so sun, CSM shadows and aerial
 * perspective agree with terrain, structures and vegetation by construction.
 */

/* ============================================================ small utilities */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = sat((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;

/** Catmull-Rom through control points [[t,v],...] sorted by t. */
function spline(ctrl, t) {
  const n = ctrl.length;
  let i = 0;
  while (i < n - 2 && t > ctrl[i + 1][0]) i++;
  const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(n - 1, i + 2)];
  const span = Math.max(1e-6, p2[0] - p1[0]);
  const u = sat((t - p1[0]) / span);
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * u
    + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2
    + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3);
}

/**
 * fbm on a cylinder. The domain is a *circle* in the noise plane, so the field is
 * exactly periodic in θ with no seam and no blend hack; height enters as a shear along
 * the second axis, which is also what makes vertical features drift slowly rather than
 * sitting in perfectly straight columns.
 */
function cylFbm(th, y, ft, fy, oct, seed) {
  return fbm2(Math.cos(th) * ft, Math.sin(th) * ft + y * fy, oct, 2.02, 0.5, seed);
}
function cylRidged(th, y, ft, fy, oct, seed) {
  return ridged2(Math.cos(th) * ft, Math.sin(th) * ft + y * fy, oct, 2.04, 0.5, seed);
}
/** Polynomial smooth minimum — rounds the arête where two cleavage faces meet. */
function smin(a, b, k) {
  const h = sat(0.5 + 0.5 * (b - a) / k);
  return mix(b, a, h) - k * h * (1 - h);
}
/** Cheap pseudo-3D noise: three orthogonal 2D slices summed. Used for boulder shaping. */
function pn3(x, y, z, f, oct, seed) {
  return (fbm2(x * f, y * f, oct, 2.02, 0.5, seed)
    + fbm2(y * f + 31.7, z * f, oct, 2.02, 0.5, seed + 77)
    + fbm2(z * f, x * f + 13.3, oct, 2.02, 0.5, seed + 151)) * (1 / 3);
}

/** Asymmetric sawtooth: a quick riser and a long slope — reads as a bedding ledge. */
function beddingShape(v) {
  const f = v - Math.floor(v);
  return Math.pow(1 - Math.abs(2 * f - 1), 0.55) - 0.62;
}

/* ================================================ world layout (docs/WORLD.md) */

const SEA_Y = 0.0;

/** The beach cross-section, used as a fallback when `terrain` is not loaded. */
const PROFILE_Z = [-340, -180, -70, -26, -6.5, 0, 9, 22, 38, 48, 58, 72, 110];
const PROFILE_Y = [-26, -11.0, -4.2, -1.15, 0.0, 0.35, 1.30, 2.75, 5.40, 9.0, 26, 58, 66];

function beachProfileY(x, z) {
  // beach widest near X=-20, pinched against the headland at X=+95
  const zz = z - 5.0 * Math.exp(-Math.pow((x + 20) / 78, 2)) + 12.0 * smoothstep(45, 105, x);
  if (zz <= PROFILE_Z[0]) return PROFILE_Y[0];
  for (let i = 0; i < PROFILE_Z.length - 1; i++) {
    if (zz <= PROFILE_Z[i + 1]) {
      const t = (zz - PROFILE_Z[i]) / (PROFILE_Z[i + 1] - PROFILE_Z[i]);
      return mix(PROFILE_Y[i], PROFILE_Y[i + 1], t * t * (3 - 2 * t));
    }
  }
  return PROFILE_Y[PROFILE_Y.length - 1];
}

/**
 * Landmark table — coordinates are the shared contract in docs/WORLD.md and must not
 * drift. Everything after (x, z, baseY, topY, radius) is silhouette authoring.
 */
const STACKS = [
  {
    id: 'stack_hero', x: -38, z: -92, baseY: -4.0, topY: 38, radius: 15,
    res: [224, 176], lod: 0, castShadow: true,
    prof: [[0, 0.72], [0.10, 0.78], [0.32, 0.92], [0.58, 1.06], [0.80, 1.14], [0.94, 1.13], [1.0, 1.08]],
    lean: [0.20, -0.11], notch: { y: 1.9, w: 1.5, d: 0.17, dir: 0.6 },
    ledges: [[0.40, 0.055], [0.66, 0.040]], flute: 1.0, crownFlat: 1.0,
  },
  {
    id: 'stack_arch', x: 34, z: -70, baseY: -3.4, topY: 41, radius: 17,
    res: [224, 176], lod: 0, castShadow: true,
    prof: [[0, 0.68], [0.09, 0.73], [0.30, 0.92], [0.55, 1.08], [0.80, 1.18], [0.93, 1.16], [1.0, 1.10]],
    lean: [-0.24, 0.14], notch: { y: 2.0, w: 1.9, d: 0.25, dir: 2.5 },
    ledges: [[0.30, 0.070], [0.58, 0.035]], flute: 1.15, crownFlat: 0.8,
  },
  {
    id: 'stack_twin_a', x: -96, z: -140, baseY: -7.5, topY: 44, radius: 19,
    res: [176, 144], lod: 1, castShadow: false,
    prof: [[0, 0.74], [0.12, 0.80], [0.34, 0.94], [0.60, 1.07], [0.82, 1.14], [0.94, 1.12], [1.0, 1.06]],
    lean: [0.14, 0.20], notch: { y: 1.7, w: 1.6, d: 0.16, dir: 4.0 },
    ledges: [[0.44, 0.050]], flute: 0.9, crownFlat: 1.0,
  },
  {
    id: 'stack_twin_b', x: -128, z: -172, baseY: -9.0, topY: 33, radius: 13,
    res: [144, 112], lod: 1, castShadow: false,
    prof: [[0, 0.76], [0.14, 0.82], [0.36, 0.96], [0.62, 1.08], [0.84, 1.12], [0.95, 1.09], [1.0, 1.02]],
    lean: [-0.18, -0.16], notch: { y: 1.6, w: 1.5, d: 0.15, dir: 1.4 },
    ledges: [[0.52, 0.045]], flute: 1.0, crownFlat: 0.9,
  },
  {
    id: 'stack_far_a', x: 120, z: -210, baseY: -12, topY: 36, radius: 16,
    res: [112, 88], lod: 2, castShadow: false,
    prof: [[0, 0.76], [0.13, 0.82], [0.35, 0.95], [0.60, 1.06], [0.83, 1.11], [0.95, 1.08], [1.0, 1.00]],
    lean: [0.16, 0.10], notch: { y: 1.8, w: 1.6, d: 0.14, dir: 3.1 },
    ledges: [[0.48, 0.045]], flute: 0.85, crownFlat: 1.0,
  },
  {
    id: 'stack_far_b', x: 156, z: -246, baseY: -13, topY: 30, radius: 12,
    res: [96, 72], lod: 2, castShadow: false,
    prof: [[0, 0.78], [0.13, 0.84], [0.36, 0.96], [0.62, 1.07], [0.84, 1.10], [0.95, 1.07], [1.0, 0.98]],
    lean: [-0.12, 0.18], notch: { y: 1.7, w: 1.5, d: 0.14, dir: 5.4 },
    ledges: [[0.45, 0.040]], flute: 0.9, crownFlat: 0.9,
  },
  {
    id: 'headland', x: 108, z: 20, baseY: -2.0, topY: 34, radius: 40,
    res: [192, 120], lod: 0, castShadow: true,
    prof: [[0, 0.86], [0.10, 0.90], [0.34, 0.97], [0.60, 1.00], [0.80, 0.97], [0.93, 0.88], [1.0, 0.72]],
    lean: [0.05, 0.08], notch: { y: 1.6, w: 1.7, d: 0.09, dir: 4.4 },
    ledges: [[0.30, 0.035], [0.62, 0.030]], flute: 0.75, crownFlat: 1.0,
    capAmp: 3.2, capTilt: 0.06,
  },
];

/* ==================================================== radius field for a stack */

function makeStackField(spec, rnd) {
  const R = spec.radius;
  const H = spec.topY - spec.baseY;
  const seed = rnd.int(1, 1 << 28);
  const p1 = rnd.range(0, TAU), p2 = rnd.range(0, TAU), p3 = rnd.range(0, TAU);
  const tw1 = rnd.range(0.6, 1.6), tw2 = rnd.range(-1.9, -0.8), tw3 = rnd.range(1.3, 2.6);
  const lobe1 = 0.185 + rnd.range(-0.05, 0.06);
  const lobe2 = 0.115 + rnd.range(-0.035, 0.05);
  const lobe3 = 0.060 + rnd.range(-0.02, 0.03);
  const leanX = spec.lean[0] * R, leanZ = spec.lean[1] * R;
  const swayX = rnd.sym(0.07) * R, swayZ = rnd.sym(0.07) * R;
  const swayP = rnd.range(0, TAU);
  const bedP1 = rnd.range(1.15, 1.85), bedP2 = rnd.range(3.6, 5.6);
  const bedA = R * 0.0062;
  const n = spec.notch;
  const flute = spec.flute ?? 1.0;
  const browDir = rnd.range(0, TAU);
  const fluteDir = rnd.range(0, TAU);

  /**
   * Cleavage faces. A limestone stack is a mass with a handful of *large flat faces*
   * meeting at arêtes, not an isotropic lump — look at kf_01500, where the whole
   * seaward side of the hero stack is one plane. Each plane clips the radius to
   * p/cos(θ-φ) over a height band, smooth-minned so the arête has a real fillet.
   * This is the single feature that stops the silhouette reading as procedural.
   */
  const planes = [];
  const nPlanes = 3 + rnd.int(0, 2);
  for (let i = 0; i < nPlanes; i++) {
    const y0 = spec.baseY + H * rnd.range(0.02, 0.62);
    const hh = H * rnd.range(0.34, 0.85);
    planes.push({
      phi: rnd.range(0, TAU),
      p: R * rnd.range(0.76, 1.06),
      tilt: rnd.sym(0.17),
      y0, y1: y0 + hh,
      k: R * rnd.range(0.055, 0.14),
      w: hh * rnd.range(0.14, 0.34),
      s: seed + 3000 + i * 97,
    });
  }

  /** axis offset at normalised height t */
  const axis = (t) => [
    leanX * Math.pow(t, 1.55) + swayX * Math.sin(t * 2.4 + swayP),
    leanZ * Math.pow(t, 1.55) + swayZ * Math.sin(t * 2.1 + swayP * 1.7),
  ];

  /** the smooth part only — the reference the cavity/edge masks are measured against */
  const rSmooth = (th, t) => {
    let r = R * spline(spec.prof, t);
    r *= 1 + lobe1 * Math.cos(th + p1 + tw1 * t)
      + lobe2 * Math.cos(2 * th + p2 + tw2 * t)
      + lobe3 * Math.cos(3 * th + p3 + tw3 * t);
    return r;
  };

  const rAt = (th, t, y) => {
    let r = rSmooth(th, t);

    // one-sided overhanging brow near the crown: the top hangs well outside the foot
    r += R * 0.22 * smoothstep(0.62, 0.93, t) * Math.pow(sat(Math.cos(th - browDir)), 1.5);

    // ledges: a discrete step in with an outward lip just below it
    for (const [lt, la] of (spec.ledges || [])) {
      r -= R * la * smoothstep(lt - 0.014, lt + 0.026, t);
      r += R * la * 0.55 * Math.exp(-Math.pow((t - lt + 0.011) / 0.013, 2));
    }

    // karst mass: big lumps and blocky sub-masses
    r += R * 0.115 * cylFbm(th, y, 0.95, 0.055, 3, seed);
    r += R * 0.042 * cylFbm(th, y, 2.55, 0.145, 3, seed + 31);

    // cleavage faces
    for (const pl of planes) {
      const c = Math.cos(th - pl.phi);
      if (c <= 0.26) continue;
      const g = smoothstep(pl.y0 - pl.w, pl.y0 + pl.w, y) * (1 - smoothstep(pl.y1 - pl.w, pl.y1 + pl.w, y));
      if (g < 0.02) continue;
      const rp = (pl.p + pl.tilt * (y - pl.y0)) / c + R * 0.055 * cylFbm(th, y, 2.2, 0.10, 2, pl.s);
      r = mix(r, smin(r, rp, pl.k), g);
    }

    // vertical fluting — broad ridged grooves stretched ~35:1 along y, and only on
    // some faces: uniform ribbing all the way round reads as corduroy, not rock.
    // The crest must not be serrated: a 1.6 m groove cut into the last row reads as saw
    // teeth against the sky, which no sea stack has. Fade the grooves out under the rim.
    const topFade = 1 - smoothstep(0.84, 0.99, t);
    const fw = 0.40 * cylFbm(th, y, 0.7, 0.05, 2, seed + 77);
    const fmask = 0.30 + 0.70 * sat(0.55 + 0.9 * Math.cos(th - fluteDir)
      + 1.5 * cylFbm(th, y, 1.3, 0.045, 2, seed + 91));
    r -= R * 0.105 * flute * fmask * topFade * cylRidged(th + fw, y, 5.6, 0.024, 3, seed + 53);

    // karst solution channels: narrow, deep, drip-warped, upper faces only
    const cw = 0.85 * cylFbm(th, y, 0.5, 0.09, 2, seed + 201);
    const ch = cylRidged(th + cw, y, 11.5, 0.014, 2, seed + 143);
    r -= R * 0.058 * flute * fmask * topFade * Math.pow(sat(ch * 1.30), 2.0)
      * (0.25 + 0.75 * smoothstep(0.14, 0.55, t));

    // sedimentary bedding — small, and gated so it only shows where the face cuts
    // across the strata rather than as a ring all the way round
    const bw = 2.6 * cylFbm(th, y, 4.5, 0.05, 2, seed + 601);
    const bmask = sat(0.35 + 1.4 * cylFbm(th, y, 1.1, 0.02, 2, seed + 631));
    r += bedA * bmask * (beddingShape((y + bw) / bedP1) + 0.8 * beddingShape((y + bw * 0.6) / bedP2));

    // wave-cut notch: skewed in y so the roof overhangs, deepest on the exposed side
    const dy = y - n.y;
    const np = Math.exp(-Math.pow(dy / (dy > 0 ? n.w * 0.78 : n.w * 1.35), 2));
    const nd = 0.32 + 0.68 * sat(Math.cos(th - n.dir) * 0.5 + 0.5);
    const nb = 0.68 + 0.64 * (cylFbm(th, y, 3.4, 0.25, 2, seed + 511) * 0.5 + 0.5);
    r -= R * n.d * np * nd * nb;

    // Wave-cut platform. Only on part of the perimeter — a flare all the way round is a
    // plinth, and stacks do not stand on plinths; the surf cuts a shelf where it reaches.
    const ft = smoothstep(2.4, -1.2, y);
    const fpm = sat(0.25 + 1.5 * cylFbm(th, y, 1.15, 0.06, 2, seed + 811)
      + 0.45 * Math.cos(th - n.dir));
    r += R * 0.20 * ft * fpm * (0.55 + 0.45 * (cylFbm(th, y, 3.2, 0.30, 2, seed + 821) * 0.5 + 0.5));

    // fine relief so the mesh itself carries ~30 cm structure
    r += R * 0.019 * cylFbm(th, y, 6.2, 0.62, 3, seed + 311);

    return Math.max(R * 0.16, r);
  };

  // Crown: a *flat* tilted plateau with a hard rim. The reference stacks are cut off
  // clean at the top and carry grass right to the edge; a domed cap reads as a thumb.
  const capAmp = spec.capAmp ?? R * 0.055;
  const tiltX = (spec.capTilt ?? 0.085) * rnd.sym(1);
  const tiltZ = (spec.capTilt ?? 0.085) * rnd.sym(1);
  const capSeed = seed + 1777;
  const rimDrop = R * 0.048;
  const flatK = spec.crownFlat ?? 1.0;

  /** s = 0 at the rim, 1 at the centre */
  const capY = (px, pz, s) => {
    const lump = capAmp * (0.60 * fbm2(px * 0.075, pz * 0.075, 3, 2.02, 0.5, capSeed)
      + 0.40 * fbm2(px * 0.24 + 4.4, pz * 0.24, 3, 2.02, 0.5, capSeed + 9));
    const roll = -rimDrop * (1 - smoothstep(0, 0.16, s));
    const dome = capAmp * 0.35 * s * flatK;
    return spec.topY + tiltX * px + tiltZ * pz + lump * flatK + roll + dome;
  };

  return { seed, rAt, rSmooth, axis, capY, R };
}

/* ============================================ grid -> mesh for a radial landmark */

function buildStack(spec, rnd) {
  const F = makeStackField(spec, rnd);
  const [nT, nY] = spec.res;
  const R = spec.radius;
  const rows = nY + 1;

  // Non-uniform row distribution: concentrate rows on the notch and the crown, where
  // the silhouette changes fastest. Uniform spacing wastes half the mesh on the middle.
  const tv = new Float32Array(rows);
  {
    const w = new Float64Array(rows);
    let acc = 0;
    for (let j = 0; j < rows; j++) {
      const t = j / nY;
      w[j] = 1 + 2.4 * Math.exp(-Math.pow((t - 0.105) / 0.085, 2))
        + 1.0 * Math.exp(-Math.pow((t - 0.975) / 0.045, 2));
      acc += w[j];
    }
    let c = 0;
    for (let j = 0; j < rows; j++) { tv[j] = c / acc; c += w[j]; }
    tv[rows - 1] = 1;
  }

  const cs = new Float32Array(nT), sn = new Float32Array(nT);
  for (let i = 0; i < nT; i++) { const a = (i / nT) * TAU; cs[i] = Math.cos(a); sn[i] = Math.sin(a); }

  // rim radius / height, evaluated first so the body's top row meets the cap exactly
  const rimR = new Float32Array(nT), rimY = new Float32Array(nT);
  const axTop = F.axis(1);
  for (let i = 0; i < nT; i++) {
    const th = (i / nT) * TAU;
    const r = F.rAt(th, 1, spec.topY);
    rimR[i] = r;
    rimY[i] = F.capY(r * cs[i], r * sn[i], 0);
  }

  const N = rows * nT;
  const Rg = new Float32Array(N);      // radius grid
  const Yg = new Float32Array(N);      // world y grid
  for (let j = 0; j < rows; j++) {
    const t = tv[j];
    for (let i = 0; i < nT; i++) {
      const th = (i / nT) * TAU;
      const y = spec.baseY + (rimY[i] - spec.baseY) * t;
      const k = j * nT + i;
      Yg[k] = y;
      Rg[k] = F.rAt(th, t, y);
    }
  }

  const { occ, convex, shelter } = gridMasks(Rg, Yg, nT, rows, R, true);

  // crown proximity: how close to the top, in metres below the rim
  const crown = new Float32Array(N);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < nT; i++) {
      const k = j * nT + i;
      crown[k] = smoothstep(9.5, 1.2, rimY[i] - Yg[k]);
    }
  }

  /* ---- assemble ---- */
  const nCap = Math.max(5, Math.round(nY * 0.10));
  const capVerts = nCap * nT + 1;
  const total = N + capVerts + 1;               // + bottom centre
  const pos = new Float32Array(total * 3);
  const rock = new Float32Array(total * 4);

  for (let j = 0; j < rows; j++) {
    const ax = F.axis(tv[j]);
    for (let i = 0; i < nT; i++) {
      const k = j * nT + i, r = Rg[k];
      pos[k * 3] = spec.x + ax[0] + r * cs[i];
      pos[k * 3 + 1] = Yg[k];
      pos[k * 3 + 2] = spec.z + ax[1] + r * sn[i];
      rock[k * 4] = occ[k]; rock[k * 4 + 1] = convex[k];
      rock[k * 4 + 2] = shelter[k]; rock[k * 4 + 3] = crown[k];
    }
  }

  // crown rings
  const capBase = N;
  for (let c = 1; c <= nCap; c++) {
    const s = c / nCap;
    const shrink = Math.pow(1 - s, 0.80);
    for (let i = 0; i < nT; i++) {
      const k = capBase + (c - 1) * nT + i;
      const rr = rimR[i] * shrink;
      const px = rr * cs[i], pz = rr * sn[i];
      pos[k * 3] = spec.x + axTop[0] + px;
      pos[k * 3 + 1] = F.capY(px, pz, s);
      pos[k * 3 + 2] = spec.z + axTop[1] + pz;
      const kk = (rows - 1) * nT + i;
      rock[k * 4] = mix(occ[kk], 0.94, s);
      rock[k * 4 + 1] = mix(convex[kk], 0.55, s);
      rock[k * 4 + 2] = shelter[kk] * (1 - s);
      rock[k * 4 + 3] = 1;
    }
  }
  const capCentre = capBase + nCap * nT;
  {
    const cy = F.capY(0, 0, 1);
    pos[capCentre * 3] = spec.x + axTop[0];
    pos[capCentre * 3 + 1] = cy;
    pos[capCentre * 3 + 2] = spec.z + axTop[1];
    rock[capCentre * 4] = 0.96; rock[capCentre * 4 + 1] = 0.5;
    rock[capCentre * 4 + 2] = 0; rock[capCentre * 4 + 3] = 1;
  }
  const botCentre = capCentre + 1;
  {
    pos[botCentre * 3] = spec.x;
    pos[botCentre * 3 + 1] = spec.baseY - Math.max(3, R * 0.25);
    pos[botCentre * 3 + 2] = spec.z;
    rock[botCentre * 4] = 0.3; rock[botCentre * 4 + 1] = 0.4;
    rock[botCentre * 4 + 2] = 0.8; rock[botCentre * 4 + 3] = 0;
  }

  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < nT; i++) {
      const i2 = (i + 1) % nT;
      const a = j * nT + i, b = j * nT + i2, c = (j + 1) * nT + i2, d = (j + 1) * nT + i;
      idx.push(a, c, b, a, d, c);
    }
  }
  for (let c = 0; c < nCap; c++) {
    for (let i = 0; i < nT; i++) {
      const i2 = (i + 1) % nT;
      const lo = c === 0 ? (rows - 1) * nT : capBase + (c - 1) * nT;
      const hi = capBase + c * nT;
      idx.push(lo + i, hi + i2, lo + i2, lo + i, hi + i, hi + i2);
    }
  }
  {
    const last = capBase + (nCap - 1) * nT;
    for (let i = 0; i < nT; i++) idx.push(last + i, capCentre, last + ((i + 1) % nT));
  }
  for (let i = 0; i < nT; i++) idx.push(i, ((i + 1) % nT), botCentre);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rock, 4));
  geo.setIndex(total > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  /* ---- colliders: a capsule chain up the axis ---- */
  const colliders = [];
  const bands = 10;
  for (let b = 0; b < bands; b++) {
    const t0 = b / bands, t1 = (b + 1) / bands;
    let rmin = 1e9;
    const j0 = Math.round(t0 * (rows - 1)), j1 = Math.round(t1 * (rows - 1));
    for (let j = j0; j <= j1; j++) for (let i = 0; i < nT; i++) rmin = Math.min(rmin, Rg[j * nT + i]);
    const a0 = F.axis(t0), a1 = F.axis(t1);
    const y0 = spec.baseY + (spec.topY - spec.baseY) * t0;
    const y1 = spec.baseY + (spec.topY - spec.baseY) * t1;
    colliders.push({
      type: 'capsule', tag: spec.id,
      a: [spec.x + a0[0], y0, spec.z + a0[1]],
      b: [spec.x + a1[0], y1, spec.z + a1[1]],
      radius: rmin * 0.92,
    });
  }

  return {
    geo, colliders, field: F, rimY, rimR, nT, rows, tv,
    crownCentre: new THREE.Vector3(spec.x + axTop[0], F.capY(0, 0, 1), spec.z + axTop[1]),
    crownRadius: rimR.reduce((a, b) => a + b, 0) / nT,
  };
}

/**
 * Cavity / edge / overhang masks from the radius grid.
 * Separable box blurs over (θ, y): O(n·k) array reads instead of O(n·k) noise evals,
 * which is what makes baking these affordable at all.
 */
function gridMasks(Rg, Yg, nT, rows, R, wrapT) {
  const N = rows * nT;
  const blur = (src, kt, kj) => {
    const tmp = new Float32Array(N), out = new Float32Array(N);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < nT; i++) {
        let s = 0, w = 0;
        for (let d = -kt; d <= kt; d++) {
          let ii = i + d;
          if (wrapT) ii = ((ii % nT) + nT) % nT; else ii = clamp(ii, 0, nT - 1);
          s += src[j * nT + ii]; w++;
        }
        tmp[j * nT + i] = s / w;
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < nT; i++) {
        let s = 0, w = 0;
        for (let d = -kj; d <= kj; d++) {
          const jj = clamp(j + d, 0, rows - 1);
          s += tmp[jj * nT + i]; w++;
        }
        out[j * nT + i] = s / w;
      }
    }
    return out;
  };

  const bNear = blur(Rg, 2, 2);
  const bMid = blur(Rg, 6, 5);
  const bFar = blur(Rg, 16, 12);

  const occ = new Float32Array(N), convex = new Float32Array(N), shelter = new Float32Array(N);
  const sNear = R * 0.020, sMid = R * 0.045, sFar = R * 0.10;
  for (let k = 0; k < N; k++) {
    const dN = (Rg[k] - bNear[k]) / sNear;
    const dM = (Rg[k] - bMid[k]) / sMid;
    const dF = (Rg[k] - bFar[k]) / sFar;
    const cav = 0.42 * dN + 0.36 * dM + 0.22 * dF;
    occ[k] = sat(0.5 + cav * 0.55);
    convex[k] = sat(0.5 + (0.62 * dN + 0.38 * dM) * 0.75);
  }

  // overhang shelter: how far the rock above sticks out past this point
  const look = Math.max(4, Math.round(rows * 0.06));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < nT; i++) {
      const k = j * nT + i;
      let over = 0;
      const y0 = Yg[k];
      for (let d = 1; d <= look; d++) {
        const jj = Math.min(rows - 1, j + d);
        const kk = jj * nT + i;
        const dy = Math.max(0.4, Yg[kk] - y0);
        over = Math.max(over, (bMid[kk] - Rg[k]) / dy);
      }
      shelter[k] = sat(over * 0.9);
    }
  }
  return { occ, convex, shelter };
}

/* ============================================================== the cliff wall */

function buildCliff(rnd, ctx) {
  const X0 = -150, X1 = 190, CHUNKS = 6;
  const nX = 112, nY = 80, nCap = 8;
  const seed = rnd.int(1, 1 << 28);
  const S = (a) => seed + a;

  // alcoves: the big shadowed recesses that give the wall its depth (kf_00000)
  const alcoves = [];
  for (let i = 0; i < 7; i++) {
    alcoves.push({
      x: mix(X0 + 20, X1 - 20, rnd.next()),
      y: rnd.range(12, 34),
      rx: rnd.range(9, 22), ry: rnd.range(7, 15), d: rnd.range(4.5, 10.5),
    });
  }

  const zRef = (x) => 62 + 13 * fbm2(x * 0.0062, 3.3, 3, 2.02, 0.5, S(5)) + 6 * fbm2(x * 0.019, 9.1, 2, 2.02, 0.5, S(6));
  const yTop = (x) => 58 + 9.5 * fbm2(x * 0.0085, 1.7, 4, 2.02, 0.5, S(11))
    + 3.4 * fbm2(x * 0.036, 7.2, 3, 2.02, 0.5, S(12));
  const yBase = (x) => 6.0 + 3.2 * fbm2(x * 0.012, 21.0, 3, 2.02, 0.5, S(13));

  /** displacement forward (toward -Z / the beach) of the face at (x, y) */
  const disp = (x, y) => {
    let d = -0.155 * (y - 20);                                  // batter: the top sets back
    d += 6.4 * smoothstep(23.0, 8.0, y);                        // undercut base
    d += 7.0 * fbm2(x * 0.021, y * 0.0060, 4, 2.02, 0.5, S(21)); // buttresses & gullies
    d += 3.1 * fbm2(x * 0.058 + 3.1, y * 0.030, 4, 2.02, 0.5, S(22));
    const fw = 0.9 * fbm2(x * 0.010, y * 0.006, 2, 2.02, 0.5, S(23));
    d -= 2.9 * ridged2(x * 0.185 + fw, y * 0.0115, 4, 2.04, 0.5, S(24));   // vertical fluting
    d -= 1.35 * Math.pow(sat(ridged2(x * 0.52 + fw * 2.0, y * 0.008, 3, 2.04, 0.5, S(25)) * 1.3), 1.8);
    d += 0.85 * fbm2(x * 0.42, y * 0.22, 3, 2.02, 0.5, S(26));   // fine
    const bw = 2.2 * fbm2(x * 0.020, y * 0.010, 3, 2.02, 0.5, S(27));
    d += 0.42 * beddingShape((y + bw) / 1.55) + 0.30 * beddingShape((y + bw * 0.5) / 4.4);
    for (const a of alcoves) {
      const q = Math.pow((x - a.x) / a.rx, 2) + Math.pow((y - a.y) / a.ry, 2);
      d -= a.d * Math.exp(-q * 1.7);
    }
    return d;
  };

  const chunks = [];
  const colliders = [];
  const grids = [];
  const spanX = (X1 - X0) / CHUNKS;

  for (let c = 0; c < CHUNKS; c++) {
    const cx0 = X0 + c * spanX, cx1 = cx0 + spanX;
    const rows = nY + 1, cols = nX + 1;
    const N = rows * cols;
    const capN = nCap * cols;
    const total = N + capN;
    const pos = new Float32Array(total * 3);
    const rock = new Float32Array(total * 4);
    const Dg = new Float32Array(N), Yg = new Float32Array(N);

    const xs = new Float32Array(cols), yt = new Float32Array(cols), yb = new Float32Array(cols), zr = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      const x = cx0 + (i / nX) * spanX;
      xs[i] = x; yt[i] = yTop(x); yb[i] = yBase(x); zr[i] = zRef(x);
    }

    for (let j = 0; j < rows; j++) {
      const v = j / nY;
      const vv = v * v * (3 - 2 * v) * 0.35 + v * 0.65;      // a few more rows near the base
      for (let i = 0; i < cols; i++) {
        const y = mix(yb[i], yt[i], vv);
        const k = j * cols + i;
        Yg[k] = y;
        Dg[k] = disp(xs[i], y);
      }
    }

    const { occ, convex, shelter } = gridMasks(Dg, Yg, cols, rows, 13.0, false);

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        pos[k * 3] = xs[i] + 1.6 * fbm2(xs[i] * 0.03, Yg[k] * 0.05, 2, 2.02, 0.5, S(41));
        pos[k * 3 + 1] = Yg[k];
        pos[k * 3 + 2] = zr[i] - Dg[k];
        rock[k * 4] = occ[k]; rock[k * 4 + 1] = convex[k];
        rock[k * 4 + 2] = shelter[k];
        rock[k * 4 + 3] = smoothstep(11.0, 1.5, yt[i] - Yg[k]);
      }
    }

    // crown: rolls back over the top into the grass shelf vegetation sits on
    for (let cc = 1; cc <= nCap; cc++) {
      const s = cc / nCap;
      for (let i = 0; i < cols; i++) {
        const k = N + (cc - 1) * cols + i;
        const back = 17.0 * Math.pow(s, 0.82);
        const y = yt[i] + 3.6 * Math.sqrt(s) + 1.3 * fbm2(xs[i] * 0.05, s * 3.0 + 40, 3, 2.02, 0.5, S(51));
        pos[k * 3] = xs[i] + 1.2 * fbm2(xs[i] * 0.03, s * 5 + 12, 2, 2.02, 0.5, S(52));
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = zr[i] - disp(xs[i], yt[i]) + back;
        const kk = (rows - 1) * cols + i;
        rock[k * 4] = mix(occ[kk], 0.93, s);
        rock[k * 4 + 1] = mix(convex[kk], 0.55, s);
        rock[k * 4 + 2] = 0;
        rock[k * 4 + 3] = 1;
      }
    }

    const idx = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i, b = j * cols + i + 1, cq = (j + 1) * cols + i + 1, d = (j + 1) * cols + i;
        idx.push(a, b, cq, a, cq, d);
      }
    }
    for (let cc = 0; cc < nCap; cc++) {
      const lo = cc === 0 ? (rows - 1) * cols : N + (cc - 1) * cols;
      const hi = N + cc * cols;
      for (let i = 0; i < cols - 1; i++) idx.push(lo + i, lo + i + 1, hi + i + 1, lo + i, hi + i + 1, hi + i);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRock', new THREE.BufferAttribute(rock, 4));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    chunks.push(geo);
    grids.push({ cols, rows, pos, uSpan: [c / CHUNKS, (c + 1) / CHUNKS], wrapU: false });

    for (let b = 0; b < 4; b++) {
      const x = cx0 + (b + 0.5) * (spanX / 4);
      const zf = zRef(x) - disp(x, 20);
      colliders.push({
        type: 'box', tag: 'cliff_main',
        center: [x, 32, zf + 26], halfExtents: [spanX / 8 + 1, 32, 26],
      });
    }
  }

  return { chunks, colliders, grids, zRef, yTop };
}

/* ================================================= tide-pool wave-cut shelf */

function buildShelf(rnd, heightAt) {
  const X0 = -72, X1 = -16, Z0 = -15, Z1 = -1;
  const nX = 168, nZ = 56;
  const seed = rnd.int(1, 1 << 28);
  const cols = nX + 1, rows = nZ + 1, N = cols * rows;
  const pos = new Float32Array(N * 3);
  const rock = new Float32Array(N * 4);
  const Hg = new Float32Array(N), Yg = new Float32Array(N);

  /**
   * Relief *relative to the sand*, centred slightly below it: the shelf is a wave-cut
   * platform that the beach has half-buried, so only the ridges and pool rims emerge as
   * dark rock outcrops with sand lying in between — which is exactly what the reference
   * foreground does at kf_01500 and kf_01800.
   */
  const shelfRelief = (x, z) => {
    let h = -0.30;
    h += 0.62 * fbm2(x * 0.052, z * 0.052, 4, 2.02, 0.5, seed);
    h += 0.26 * fbm2(x * 0.20, z * 0.20, 4, 2.02, 0.5, seed + 7);
    h += 0.085 * fbm2(x * 0.82, z * 0.82, 3, 2.02, 0.5, seed + 13);
    // pools and channels: basins scoured below the sand
    const pw = 0.6 * fbm2(x * 0.03, z * 0.03, 2, 2.02, 0.5, seed + 21);
    const pl = ridged2(x * 0.062 + pw, z * 0.062, 3, 2.04, 0.5, seed + 29);
    h -= 0.95 * Math.pow(sat(pl * 1.15), 2.2);
    // bedding steps
    h += 0.10 * beddingShape((h * 3.0 + 0.7 * fbm2(x * 0.04, z * 0.04, 2, 2.02, 0.5, seed + 31)) / 0.42);
    return h;
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = mix(X0, X1, i / nX), z = mix(Z0, Z1, j / nZ);
      const k = j * cols + i;
      // fade the slab away at its border so sand swallows the edges
      const fade = smoothstep(0, 8, x - X0) * smoothstep(0, 8, X1 - x)
        * smoothstep(0, 6, z - Z0) * smoothstep(0, 4, Z1 - z);
      const ground = heightAt(x, z);
      const y = ground + mix(-1.5, shelfRelief(x, z), fade);
      pos[k * 3] = x + 0.35 * fbm2(x * 0.2, z * 0.2, 2, 2.02, 0.5, seed + 41);
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z + 0.35 * fbm2(x * 0.2 + 9, z * 0.2, 2, 2.02, 0.5, seed + 42);
      Hg[k] = y; Yg[k] = y;
    }
  }

  const { occ, convex } = gridMasks(Hg, Yg, cols, rows, 3.0, false);
  for (let k = 0; k < N; k++) {
    rock[k * 4] = occ[k]; rock[k * 4 + 1] = convex[k];
    rock[k * 4 + 2] = 0; rock[k * 4 + 3] = 0;
  }

  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = j * cols + i + 1, c = (j + 1) * cols + i + 1, d = (j + 1) * cols + i;
      idx.push(a, c, b, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rock, 4));
  geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ==================================================================== boulders */

function buildBoulderShape(rnd, detail) {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute('uv');
  raw.deleteAttribute('normal');
  // PolyhedronGeometry is non-indexed; welding first means computeVertexNormals gives a
  // smooth shell that the displacement can then break up, instead of a geodesic dome.
  const geo = mergeVertices(raw, 1e-5);
  raw.dispose();
  const p = geo.getAttribute('position');
  const seed = rnd.int(1, 1 << 28);
  const sq = [rnd.range(0.95, 1.40), rnd.range(0.42, 0.74), rnd.range(0.95, 1.40)];
  // Cleavage planes: beach limestone breaks into angular blocks, not potatoes. The
  // reference surf boulders are clearly faceted with rounded arêtes.
  const planes = [];
  for (let i = 0; i < 5; i++) {
    const v = new THREE.Vector3(rnd.sym(1), rnd.sym(1) * 0.8, rnd.sym(1)).normalize();
    planes.push({ n: v, d: rnd.range(0.44, 0.80) });
  }
  const v = new THREE.Vector3();
  const N = p.count;
  const occ = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    v.fromBufferAttribute(p, i);
    const nx = v.x, ny = v.y, nz = v.z;
    let r = 1;
    r += 0.42 * pn3(nx, ny, nz, 1.15, 4, seed);
    r += 0.17 * pn3(nx, ny, nz, 3.2, 3, seed + 11);
    r += 0.075 * pn3(nx, ny, nz, 8.5, 3, seed + 23);
    r -= 0.16 * Math.pow(sat(pn3(nx, ny, nz, 5.2, 2, seed + 37) * 2.2 + 0.45), 2.0);
    v.set(nx * sq[0], ny * sq[1], nz * sq[2]).multiplyScalar(r);
    for (const pl of planes) {
      const dd = v.dot(pl.n);
      if (dd > pl.d) v.addScaledVector(pl.n, -(dd - pl.d));
    }
    p.setXYZ(i, v.x, v.y, v.z);
    const cav = sat(0.5 + (r - 1) * 1.7);
    occ[i * 4] = mix(0.45, 1.0, cav);
    occ[i * 4 + 1] = cav;
    occ[i * 4 + 2] = sat(-ny) * 0.6;
    occ[i * 4 + 3] = 0;
  }
  geo.setAttribute('aRock', new THREE.BufferAttribute(occ, 4));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ========================================================== detail texture bake */

/**
 * Tileable gradient / worley noise.
 *
 * src/gfx/glsl/noise.js supplies `hash22`/`hash33` and a tiling *worley* (`worley3Tiled`)
 * but no periodic gradient noise, and a detail map that does not tile is useless. These
 * two are the library's own lattice construction with `mod()` on the cell index — same
 * hash, same quintic, same normalisation — so the statistics stay coherent with every
 * other procedural surface in the game.
 */
const TILE_NOISE_GLSL = /* glsl */`
float tgnoise(vec2 p, float P){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  #define TG(o) dot(normalize(hash22(mod(i+o, vec2(P)))*2.0-1.0), f-o)
  return mix(mix(TG(vec2(0,0)), TG(vec2(1,0)), u.x),
             mix(TG(vec2(0,1)), TG(vec2(1,1)), u.x), u.y) * 1.4142;
  #undef TG
}
float tfbm(vec2 p, float P, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s += a*tgnoise(p, P); n += a; p *= 2.0; P *= 2.0; a *= 0.5; }
  return s/max(n,1e-4);
}
float tridged(vec2 p, float P, int oct){
  float a = 0.5, s = 0.0, n = 0.0, prev = 1.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    float v = 1.0 - abs(tgnoise(p, P)); v *= v; v *= prev; prev = v;
    s += a*v; n += a; p *= 2.0; P *= 2.0; a *= 0.5;
  }
  return s/max(n,1e-4);
}
vec2 tworley(vec2 p, float P){
  vec2 n = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(mod(n+g, vec2(P)));
    float d = length(g + o - f);
    if(d < f1){ f2 = f1; f1 = d; } else if(d < f2){ f2 = d; }
  }
  return vec2(f1, f2);
}
`;

const HEIGHT_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform float uVariant;
` + HASH_GLSL + TILE_NOISE_GLSL + /* glsl */`
void main(){
  float h;
  if (uVariant < 0.5) {
    // --- A: meso relief. Fractured, blocky, pocked limestone.
    float P = 6.0;
    vec2 p = vUv * P;
    vec2 w = vec2(tfbm(p, P, 4), tfbm(p + 3.7, P, 4));
    h  = 0.55 * tridged(p + w * 0.85, P, 5);
    h += 0.30 * (tfbm(p * 2.0, P * 2.0, 5) * 0.5 + 0.5);
    // solution pockets
    vec2 wo = tworley(vUv * 14.0, 14.0);
    h -= 0.20 * smoothstep(0.46, 0.02, wo.x);
    // cleavage: a couple of sharp planar breaks
    float cl = tfbm(p * 0.7 + 9.1, P, 3);
    h += 0.16 * smoothstep(0.02, 0.10, abs(cl)) * sign(cl);
    // hairline cracks along worley edges
    h -= 0.10 * smoothstep(0.10, 0.0, wo.y - wo.x);
  } else {
    // --- B: fine grain. Pitting, grit and micro-cracks; this is the 2 cm decade.
    float P = 10.0;
    vec2 p = vUv * P;
    h  = 0.38 * (tfbm(p * 1.6, P * 1.6, 5) * 0.5 + 0.5);
    vec2 w1 = tworley(vUv * 26.0, 26.0);
    h += 0.26 * (1.0 - smoothstep(0.0, 0.55, w1.x));
    vec2 w2 = tworley(vUv * 62.0, 62.0);
    h -= 0.16 * smoothstep(0.32, 0.0, w2.x);
    h -= 0.13 * smoothstep(0.075, 0.0, w2.y - w2.x);
    h += 0.10 * (tfbm(p * 9.0, P * 9.0, 3) * 0.5 + 0.5);
    h += 0.07 * (tfbm(p * 26.0, P * 26.0, 2) * 0.5 + 0.5);
  }
  // Both variants land in roughly -0.2 .. +0.75 raw. Encoding that as h*0.5+0.5 wastes
  // three quarters of the 8-bit range and — worse — leaves the Sobel gradients tiny, so
  // every derived normal comes out within a degree of flat. Stretch to fill 0..1.
  oCol = vec4(clamp(h * 1.55 + 0.14, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

const NORMAL_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform sampler2D tH;
uniform vec2 uTexel;
uniform float uStrength;
void main(){
  float l = texture(tH, vUv - vec2(uTexel.x, 0.0)).r;
  float r = texture(tH, vUv + vec2(uTexel.x, 0.0)).r;
  float d = texture(tH, vUv - vec2(0.0, uTexel.y)).r;
  float u = texture(tH, vUv + vec2(0.0, uTexel.y)).r;
  float c = texture(tH, vUv).r;
  vec3 n = normalize(vec3((l - r) * uStrength, (d - u) * uStrength, 1.0));
  oCol = vec4(n * 0.5 + 0.5, c);
}
`;

function bakeDetail(ctx, size, variant, strength) {
  const { renderer } = ctx;
  const hRT = makeRT(size, size, { type: THREE.UnsignedByteType });
  hRT.texture.wrapS = hRT.texture.wrapT = THREE.RepeatWrapping;
  const nRT = makeRT(size, size, { type: THREE.UnsignedByteType });
  nRT.texture.wrapS = nRT.texture.wrapT = THREE.RepeatWrapping;
  nRT.texture.generateMipmaps = true;
  nRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
  nRT.texture.magFilter = THREE.LinearFilter;
  nRT.texture.anisotropy = Math.min(8, ctx.caps.maxAnisotropy);

  const hMat = fsMaterial(HEIGHT_FRAG, { uVariant: { value: variant } });
  const q = new FullScreenQuad(hMat);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(hRT);
  q.render(renderer);

  const nMat = fsMaterial(NORMAL_FRAG, {
    tH: { value: hRT.texture },
    uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
    uStrength: { value: strength },
  });
  q.material = nMat;
  renderer.setRenderTarget(nRT);
  q.render(renderer);
  renderer.setRenderTarget(prev);

  hMat.dispose(); nMat.dispose();
  return { tex: nRT.texture, rts: [hRT, nRT] };
}

/* ================================================================== material */

const ROCK_PARS = NOISE_GLSL + TRIPLANAR_GLSL + /* glsl */`
uniform sampler2D uNH_A;
uniform sampler2D uNH_B;
uniform vec3  uColBase, uColBright, uColGrime, uColStain, uColAlgae, uColMoss, uColLichen, uColBleach;
uniform float uRough, uAlgaeAmt, uMossAmt, uWetY, uDetailAmt, uAOAmt, uMacroAmt;
varying vec3 vWNrmRK;
varying vec4 vRockRK;

/** The library's whiteout tri-planar blend, extended to carry the height channel so
 *  four detail scales cost 12 taps instead of 24. Weights come from triWeights(). */
vec4 triplanarNH(sampler2D t, vec3 wp, vec3 n, float scale, float sharp){
  vec3 w = triWeights(n, sharp);
  vec4 sx = texture(t, wp.zy * scale);
  vec4 sy = texture(t, wp.xz * scale);
  vec4 sz = texture(t, wp.xy * scale);
  vec3 nx = sx.xyz * 2.0 - 1.0, ny = sy.xyz * 2.0 - 1.0, nz = sz.xyz * 2.0 - 1.0;
  nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
  ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
  nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
  vec3 nn = normalize(nx.zyx*w.x + ny.xzy*w.y + nz.xyz*w.z);
  float h = sx.w*w.x + sy.w*w.y + sz.w*w.z;
  return vec4(nn, h);
}
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }
`;

const ROCK_FRAG = /* glsl */`
vec3 P  = vWorldPositionWM;
vec3 Ng = normalize(vWNrmRK);

float occ = vRockRK.x, cvx = vRockRK.y, shl = vRockRK.z, crn = vRockRK.w;

// ---- tri-planar detail, four scales: 9 m / 1.15 m / 0.30 m / 0.055 m ----------
// Each scale is rotated in world space so the same map at different sizes does not
// visibly repeat itself down the pyramid.
mat3 r1 = rotY(0.9), r2 = rotY(2.1), r3 = rotY(-1.35);
vec4 dA1 = triplanarNH(uNH_A, P,      Ng, 1.0/9.00,  4.0);
vec4 dA2 = triplanarNH(uNH_A, r1 * P, Ng, 1.0/1.15,  5.0);
vec4 dB1 = triplanarNH(uNH_B, r2 * P, Ng, 1.0/0.30,  6.0);
vec4 dB2 = triplanarNH(uNH_B, r3 * P, Ng, 1.0/0.055, 6.0);

float k = uDetailAmt;
vec3 nDet = Ng
  + (dA1.xyz - Ng) * (1.05 * k)
  + (dA2.xyz - Ng) * (1.00 * k)
  + (dB1.xyz - Ng) * (0.78 * k)
  + (dB2.xyz - Ng) * (0.48 * k);
nDet = normalize(nDet);

// Expand each scale over its useful band before it modulates anything: the raw maps
// cluster around the middle and an un-stretched height buys almost no albedo variance.
float hA = smoothstep(0.12, 0.90, dA1.w);
float hB = smoothstep(0.12, 0.90, dA2.w);
float hC = smoothstep(0.12, 0.90, dB1.w);
float hD = smoothstep(0.15, 0.88, dB2.w);
float h = hA * 0.38 + hB * 0.29 + hC * 0.20 + hD * 0.13;

// ---- macro fields (procedural, so they never tile) ---------------------------
float m1 = fbm3(P * 0.055, 4);
float m2 = fbm3(P * 0.215 + 11.0, 3);
// runoff staining: ridged noise stretched ~25:1 along gravity
float streak = ridged3(vec3(P.x * 1.05, P.y * 0.042, P.z * 1.05) + m1 * 0.7, 4);
streak = pow(clamp(streak * 1.25, 0.0, 1.0), 1.5);
// bedding: asymmetric bands in world y, warped so they are not dead level
float bw  = fbm3(P * vec3(0.055, 0.016, 0.055), 3);
float bs  = fract(P.y * 0.58 + bw * 1.9);
float bed = smoothstep(0.0, 0.09, bs) * (1.0 - smoothstep(0.55, 0.98, bs));
float bed2 = fract(P.y * 0.205 + bw * 0.9);
bed2 = smoothstep(0.0, 0.12, bed2) * (1.0 - smoothstep(0.6, 1.0, bed2));

// ---- albedo ------------------------------------------------------------------
// Measured on the reference (kf_01500, rock-only boxes): the lit faces run
// lum 67-111 with lum_std 33-64 and lap_var 860-3900. That variance is the whole
// game — it has to come from independent modulation at every scale, so each detail
// octave multiplies albedo separately rather than through one blended height.
vec3 alb = uColBase;
alb *= 1.0 + uMacroAmt * (0.40 * m1 + 0.22 * m2);
alb *= mix(0.56, 1.38, hA);
alb *= mix(0.66, 1.30, hB);
alb *= mix(0.76, 1.24, hC);
alb *= mix(0.86, 1.15, hD);
// curvature wear: grime settles in the concavities, edges scrub clean and bright
float grime = (1.0 - occ) * (0.45 + 0.55 * (1.0 - smoothstep(0.15, 0.62, h)));
alb = mix(alb, uColGrime, clamp(grime * 0.95, 0.0, 0.82));
float wear = cvx * cvx * smoothstep(0.36, 0.88, h);
alb = mix(alb, uColBright, wear * 0.70);
// vertical staining, strongest below ledges and absent on up-facing rock
float stainMask = streak * (1.0 - smoothstep(0.25, 0.72, Ng.y)) * (0.35 + 0.65 * (1.0 - crn));
alb = mix(alb, uColStain, stainMask * 0.55);
// bedding shows as a tonal band, not a groove
alb *= 1.0 - 0.20 * bed - 0.11 * bed2;

// ---- tide zone ---------------------------------------------------------------
float yn = 0.62 * fbm3(P * vec3(0.16, 0.55, 0.16), 3) + 0.30 * fbm3(P * vec3(0.9, 2.2, 0.9), 2);
float yw = P.y - uWetY + yn * 1.5;
float wet   = smoothstep(1.05, -0.25, yw);
float algae = smoothstep(4.3, 0.7, yw) * smoothstep(-3.4, -1.2, yw);
algae *= (0.34 + 0.66 * smoothstep(-0.25, 0.55, Ng.y));
algae *= (0.52 + 0.48 * (1.0 - occ));
algae *= 0.45 + 0.55 * smoothstep(-0.35, 0.35, fbm3(P * 0.42 + 31.0, 3));
algae *= uAlgaeAmt;
alb = mix(alb, uColAlgae, clamp(algae, 0.0, 0.92));
// salt-bleached supratidal band just above the algae
float bleach = exp(-pow((yw - 4.4) / 2.6, 2.0)) * 0.30 * cvx * smoothstep(0.3, 0.8, h);
alb = mix(alb, uColBleach, bleach);

// ---- moss / lichen on the crown ---------------------------------------------
float up = smoothstep(0.10, 0.68, Ng.y);
float mottle = smoothstep(-0.22, 0.30, fbm3(P * 0.26 + 71.0, 4));   // 'patch' is reserved in GLSL ES 3.00
float moss = crn * up * mottle * (0.45 + 0.55 * (1.0 - occ)) * uMossAmt;
alb = mix(alb, uColMoss, clamp(moss, 0.0, 0.9));
float lich = crn * 0.45 * smoothstep(0.45, 0.95, h) * smoothstep(0.0, 0.5, fbm3(P * 0.7 + 5.0, 3));
alb = mix(alb, uColLichen, lich * uMossAmt * 0.30);

// under an overhang: dry, dusty, no growth, and genuinely darker
alb = mix(alb, alb * vec3(0.66, 0.645, 0.635), shl * 0.72);
// wet rock loses most of its diffuse
alb *= mix(1.0, 0.46, wet);

// ---- ambient occlusion (floor kept off zero: the reference p01 is 17, never 0) --
float ao = mix(1.0, 0.36 + 0.64 * occ, uAOAmt);
ao *= mix(1.0, 0.48, shl * 0.9);
ao *= mix(1.0, 0.62 + 0.38 * smoothstep(0.02, 0.52, hC), 0.85);

diffuseColor.rgb = alb * ao;
diffuseColor.a = 1.0;

// ---- roughness ---------------------------------------------------------------
float rgh = uRough * (0.84 + 0.38 * (1.0 - h));
rgh = mix(rgh, 0.55, algae * 0.55);
rgh = mix(rgh, 0.78, bed * 0.30);
rgh = mix(rgh, 0.215, wet);          // damp limestone, not a mirror
roughnessFactor = clamp(rgh, 0.10, 1.0);

normal = normalize((viewMatrix * vec4(nDet, 0.0)).xyz);

// applyWorldMaterial injects at <lights_fragment_begin>, but three's
// <lights_physical_fragment> runs one chunk EARLIER and has already copied
// diffuseColor / roughnessFactor into the PhysicalMaterial struct. Writing the locals
// alone changes nothing but the G-buffer - the first coloured capture of this module
// came out a flat white MeshStandardMaterial with correct relief, which is exactly that
// symptom. Push the values into "material" too, replicating three's own derivation.
material.diffuseColor = diffuseColor.rgb;
material.diffuseContribution = diffuseColor.rgb * (1.0 - metalnessFactor);
material.roughness = min(max(roughnessFactor, 0.0525) + geometryRoughness, 1.0);
`;

const ROCK_VERT_PARS = /* glsl */`
attribute vec4 aRock;
varying vec4 vRockRK;
varying vec3 vWNrmRK;
`;

const ROCK_VERT = /* glsl */`
vRockRK = aRock;
{
  vec3 wmN = objectNormal;
  #ifdef USE_INSTANCING
    mat3 imRK = mat3(instanceMatrix);
    wmN /= vec3(dot(imRK[0], imRK[0]), dot(imRK[1], imRK[1]), dot(imRK[2], imRK[2]));
    wmN = imRK * wmN;
  #endif
  vWNrmRK = normalize(mat3(modelMatrix) * wmN);
}
`;

const C = (r, g, b) => new THREE.Color(r, g, b);

function makeRockMaterial(ctx, texA, texB, o) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.72, metalness: 0.0, dithering: true,
  });
  const uniforms = {
    uNH_A: { value: texA },
    uNH_B: { value: texB },
    uColBase: { value: o.base },
    uColBright: { value: o.bright },
    uColGrime: { value: o.grime },
    uColStain: { value: o.stain },
    uColAlgae: { value: o.algae },
    uColMoss: { value: o.moss },
    uColLichen: { value: o.lichen },
    uColBleach: { value: o.bleach },
    uRough: { value: o.rough },
    uAlgaeAmt: { value: o.algaeAmt },
    uMossAmt: { value: o.mossAmt },
    uWetY: { value: SEA_Y },
    uDetailAmt: { value: o.detail ?? 1.0 },
    uAOAmt: { value: o.ao ?? 1.0 },
    uMacroAmt: { value: o.macro ?? 1.0 },
  };
  // ------------------------------------------------------------------ ordering
  // `applyWorldMaterial` installs its onBeforeCompile and THEN calls
  // lighting.registerMaterial() -> CSM.setupMaterial(), and CSM's setupMaterial does a
  // bare `material.onBeforeCompile = function(shader){...}` — it does not chain. So the
  // world-material injection is silently thrown away and every surface renders with a
  // white MeshStandardMaterial. (Verified: first capture of this module came out
  // colourless with no shader error, because the shader that compiled was stock.)
  //
  // Registering with CSM *first* and hiding `lighting` from applyWorldMaterial makes the
  // chain run the right way round: applyWorldMaterial captures CSM's hook as `prev` and
  // calls it before merging its own uniforms. Fixing this properly belongs in
  // src/gfx/materialCommon.js, which this module does not own — reported instead.
  ctx.get('lighting')?.registerMaterial?.(mat);
  const noLighting = Object.create(ctx);
  noLighting.get = (n, req) => (n === 'lighting' ? null : ctx.get(n, req));

  applyWorldMaterial(mat, noLighting, {
    matId: MAT_ID.ROCK,
    inject: {
      key: o.key,
      uniforms,
      pars: ROCK_PARS,
      fragment: ROCK_FRAG,
      vertexPars: ROCK_VERT_PARS,
      vertex: ROCK_VERT,
    },
  });
  mat.userData.rockUniforms = uniforms;
  return mat;
}

/* =============================================================== the module */

export function create(opts = {}) {
  const group = new THREE.Group();
  group.name = 'rocks';

  const landmarks = new Map();
  const colliders = [];
  const disposables = [];
  const materials = [];
  let boulderMeshes = [];

  /** bilinear sample of a stored parametric grid */
  function gridSample(g, u, v) {
    const { cols, rows, pos, nrm, wrapU } = g;
    let fu = u * (wrapU ? cols : cols - 1);
    const fv = sat(v) * (rows - 1);
    let i0 = Math.floor(fu), j0 = Math.floor(fv);
    const su = fu - i0, sv = fv - j0;
    const wrap = (i) => (wrapU ? ((i % cols) + cols) % cols : clamp(i, 0, cols - 1));
    i0 = wrap(i0);
    const i1 = wrap(i0 + 1);
    const j1 = Math.min(rows - 1, j0 + 1);
    j0 = clamp(j0, 0, rows - 1);
    const at = (arr, i, j, c) => arr[(j * cols + i) * 3 + c];
    const out = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    for (let c = 0; c < 3; c++) {
      const a = mix(at(pos, i0, j0, c), at(pos, i1, j0, c), su);
      const b = mix(at(pos, i0, j1, c), at(pos, i1, j1, c), su);
      out.point.setComponent(c, mix(a, b, sv));
      const na = mix(at(nrm, i0, j0, c), at(nrm, i1, j0, c), su);
      const nb = mix(at(nrm, i0, j1, c), at(nrm, i1, j1, c), su);
      out.normal.setComponent(c, mix(na, nb, sv));
    }
    out.normal.normalize();
    return out;
  }

  return {
    name: 'rocks',
    order: 35,
    enabled: true,

    /** @type {Map<string, {object3D, center: THREE.Vector3, radius: number, topY: number}>} */
    landmarks,
    /** @type {Array<object>} handed to `physics` */
    colliders,

    async init(ctx) {
      const t0 = performance.now();
      const terrain = ctx.get('terrain');
      const heightAt = (x, z) => {
        if (terrain && typeof terrain.height === 'function') {
          const y = terrain.height(x, z);
          if (Number.isFinite(y)) return y;
        }
        return beachProfileY(x, z);
      };

      /* ---------------- detail maps ---------------- */
      // The Sobel gradient is per-texel, so `strength` must carry the texel-to-world
      // ratio: at 1024 px a one-texel difference is ~0.005 of the height range, and the
      // first pass shipped 2.6 here, which flattened every detail normal to within 1°
      // of the geometric normal. 16/13 puts strong features at 50-70°.
      const A = bakeDetail(ctx, 1024, 0.0, 16.0);
      const B = bakeDetail(ctx, 1024, 1.0, 13.0);
      disposables.push(...A.rts, ...B.rts);

      /* ---------------- materials ---------------- */
      // Warm limestone. Rock-only boxes in kf_01500 measure R 125 / G 110 / B 82 on a
      // lit face (lab_b +17, sat 95) — a tan, not the near-neutral pale grey a first
      // read of the 4K crop suggests. In linear that is an albedo R/B ratio near 2.3,
      // which is what these numbers encode.
      const matRock = makeRockMaterial(ctx, A.tex, B.tex, {
        key: 'rock-limestone',
        base: C(0.355, 0.256, 0.116),
        bright: C(0.580, 0.448, 0.222),
        grime: C(0.094, 0.066, 0.031),
        stain: C(0.132, 0.090, 0.038),
        algae: C(0.040, 0.050, 0.020),
        moss: C(0.032, 0.062, 0.019),
        lichen: C(0.235, 0.230, 0.104),
        bleach: C(0.520, 0.470, 0.352),
        rough: 0.76, algaeAmt: 1.0, mossAmt: 1.0,
      });
      // Beach and surf boulders read much darker and greener than the stacks —
      // permanently wet, permanently colonised.
      const matBoulder = makeRockMaterial(ctx, A.tex, B.tex, {
        key: 'rock-boulder',
        base: C(0.140, 0.112, 0.064),
        bright: C(0.258, 0.216, 0.132),
        grime: C(0.040, 0.034, 0.024),
        stain: C(0.064, 0.052, 0.032),
        algae: C(0.036, 0.046, 0.019),
        moss: C(0.030, 0.055, 0.018),
        lichen: C(0.165, 0.170, 0.082),
        bleach: C(0.300, 0.284, 0.240),
        rough: 0.70, algaeAmt: 1.5, mossAmt: 0.5, macro: 1.3,
      });
      // Far stacks and islets: pure silhouette work, so the expensive detail scales
      // are dialled down and AO is flattened — aerial perspective eats it all anyway.
      const matFar = makeRockMaterial(ctx, A.tex, B.tex, {
        key: 'rock-far',
        base: C(0.370, 0.272, 0.132),
        bright: C(0.552, 0.434, 0.230),
        grime: C(0.108, 0.086, 0.054),
        stain: C(0.140, 0.106, 0.060),
        algae: C(0.048, 0.058, 0.026),
        moss: C(0.040, 0.070, 0.024),
        lichen: C(0.225, 0.222, 0.104),
        bleach: C(0.500, 0.458, 0.350),
        rough: 0.78, algaeAmt: 0.8, mossAmt: 0.9, detail: 0.6, ao: 0.75, macro: 0.85,
      });
      materials.push(matRock, matBoulder, matFar);

      const addMesh = (geo, mat, name, castShadow = true) => {
        const m = new THREE.Mesh(geo, mat);
        m.name = name;
        m.layers.set(LAYER.OPAQUE);
        m.castShadow = castShadow;
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        patchForGBuffer(m, { roughness: 0.72, matId: MAT_ID.ROCK });
        group.add(m);
        return m;
      };

      /* ---------------- sea stacks + headland ---------------- */
      for (const spec of STACKS) {
        const rnd = ctx.rand.fork(hash2(spec.id.length * 7919, spec.x | 0, spec.z | 0) * 1e6 | 0);
        const built = buildStack(spec, rnd);
        const mat = spec.lod >= 2 ? matFar : matRock;
        const mesh = addMesh(built.geo, mat, spec.id, spec.castShadow);
        colliders.push(...built.colliders);

        const posArr = built.geo.getAttribute('position').array;
        const nrmArr = built.geo.getAttribute('normal').array;
        const grid = { cols: built.nT, rows: built.rows, pos: posArr, nrm: nrmArr, wrapU: true };

        landmarks.set(spec.id, {
          object3D: mesh,
          center: new THREE.Vector3(spec.x, (spec.baseY + spec.topY) * 0.5, spec.z),
          radius: spec.radius,
          topY: spec.topY,
          crown: { center: built.crownCentre, radius: built.crownRadius * 0.72 },
          _grid: grid,
          _built: built,
        });
        disposables.push(built.geo);
      }

      /* ---------------- cliff wall ---------------- */
      {
        const rnd = ctx.rand.fork(0x0c11ff);
        const cliff = buildCliff(rnd, ctx);
        const cliffGroup = new THREE.Group();
        cliffGroup.name = 'cliff_main';
        const grids = [];
        cliff.chunks.forEach((geo, i) => {
          const m = addMesh(geo, matRock, `cliff_${i}`, true);
          cliffGroup.add(m);
          disposables.push(geo);
          grids.push(Object.assign(cliff.grids[i], {
            pos: geo.getAttribute('position').array,
            nrm: geo.getAttribute('normal').array,
          }));
        });
        colliders.push(...cliff.colliders);
        landmarks.set('cliff_main', {
          object3D: cliffGroup,
          center: new THREE.Vector3(20, 34, 62),
          radius: 190,
          topY: 60,
          _grids: grids,
        });
      }

      /* ---------------- tide-pool shelf ---------------- */
      {
        const rnd = ctx.rand.fork(0x5be1f);
        const geo = buildShelf(rnd, heightAt);
        const mesh = addMesh(geo, matRock, 'tidepool_shelf', true);
        disposables.push(geo);
        landmarks.set('tidepool_shelf', {
          object3D: mesh,
          center: new THREE.Vector3(-44, 0.4, -8),
          radius: 32,
          topY: 1.4,
          _grid: { cols: 169, rows: 57, pos: geo.getAttribute('position').array, nrm: geo.getAttribute('normal').array, wrapU: false },
        });
      }

      /* ---------------- distant islets ---------------- */
      {
        const rnd = ctx.rand.fork(0x1512e7);
        const parts = [];
        for (let i = 0; i < 15; i++) {
          const ang = rnd.range(-1.15, 1.15);
          const dist = rnd.range(660, 1750);
          const spec = {
            id: `islet_${i}`,
            x: Math.sin(ang) * dist + rnd.sym(120),
            z: -Math.cos(ang) * dist,
            baseY: -22, topY: rnd.range(11, 42), radius: rnd.range(16, 52),
            res: [40, 28], lod: 3,
            prof: [[0, 0.80], [0.14, 0.86], [0.38, 0.96], [0.64, 1.04], [0.85, 1.04], [0.95, 0.95], [1.0, 0.78]],
            lean: [rnd.sym(0.16), rnd.sym(0.16)],
            notch: { y: 1.6, w: 1.6, d: 0.12, dir: rnd.range(0, TAU) },
            ledges: [], flute: 0.7, crownFlat: 1.0,
          };
          parts.push(buildStack(spec, rnd).geo);
        }
        const merged = mergeGeometries(parts, false);
        for (const g of parts) g.dispose();
        const mesh = addMesh(merged, matFar, 'islet_field', false);
        mesh.frustumCulled = true;
        disposables.push(merged);
        landmarks.set('islet_field', {
          object3D: mesh, center: new THREE.Vector3(0, 12, -1100), radius: 1400, topY: 42,
        });
      }

      /* ---------------- boulders ---------------- */
      {
        const rnd = ctx.rand.fork(0xb0d1de);
        const shapes = [
          buildBoulderShape(rnd, 3),
          buildBoulderShape(rnd, 3),
          buildBoulderShape(rnd, 2),
        ];
        const buckets = [[], [], []];
        const push = (i, m) => buckets[i].push(m);
        const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), Sv = new THREE.Vector3(), Pv = new THREE.Vector3();

        const place = (x, z, scale, sink, shapeIdx) => {
          const y = heightAt(x, z);
          E.set(rnd.sym(0.30), rnd.range(0, TAU), rnd.sym(0.30));
          Q.setFromEuler(E);
          Sv.set(scale * rnd.range(0.82, 1.22), scale * rnd.range(0.72, 1.12), scale * rnd.range(0.82, 1.22));
          Pv.set(x, y - Sv.y * sink, z);
          M.compose(Pv, Q, Sv);
          push(shapeIdx, M.clone());
        };

        // rubble skirt around every stack base: fallen blocks, half-buried
        for (const spec of STACKS) {
          if (spec.lod >= 2 && spec.id !== 'headland') continue;
          const n = Math.round(10 + spec.radius * 0.85);
          for (let i = 0; i < n; i++) {
            const a = rnd.range(0, TAU);
            const rr = spec.radius * rnd.range(0.90, 1.75);
            const x = spec.x + Math.cos(a) * rr, z = spec.z + Math.sin(a) * rr;
            const sc = spec.radius * rnd.range(0.035, 0.115);
            place(x, z, sc, rnd.range(0.30, 0.62), rnd.int(0, 2));
          }
        }
        // shoreline and beach scatter
        for (let i = 0; i < 150; i++) {
          const x = rnd.range(-135, 105);
          const z = rnd.range(-30, 30);
          const w = Math.exp(-Math.pow((z - 2) / 17, 2));
          if (rnd.next() > w * 0.92 + 0.06) continue;
          if (x > -76 && x < -12 && z > -19 && z < 4 && rnd.next() < 0.72) continue; // shelf owns this
          place(x, z, rnd.range(0.30, 1.55), rnd.range(0.34, 0.66), rnd.int(0, 2));
        }
        // talus slope under the cliff
        for (let i = 0; i < 70; i++) {
          const x = rnd.range(-140, 170);
          const z = rnd.range(40, 60);
          place(x, z, rnd.range(0.55, 2.4), rnd.range(0.22, 0.5), rnd.int(0, 2));
        }

        boulderMeshes = [];
        buckets.forEach((list, i) => {
          if (!list.length) return;
          const im = new THREE.InstancedMesh(shapes[i], matBoulder, list.length);
          for (let k = 0; k < list.length; k++) im.setMatrixAt(k, list[k]);
          im.instanceMatrix.needsUpdate = true;
          im.layers.set(LAYER.OPAQUE);
          im.castShadow = true;
          im.receiveShadow = true;
          im.frustumCulled = false;
          im.name = `boulders_${i}`;
          patchForGBuffer(im, { roughness: 0.68, matId: MAT_ID.ROCK });
          group.add(im);
          boulderMeshes.push(im);
          disposables.push(shapes[i]);

          for (let k = 0; k < list.length; k++) {
            const m = list[k];
            const p = new THREE.Vector3().setFromMatrixPosition(m);
            const s = new THREE.Vector3().setFromMatrixScale(m);
            colliders.push({ type: 'sphere', tag: 'boulder', center: [p.x, p.y, p.z], radius: Math.max(s.x, s.z) * 0.85 });
          }
        });
      }

      group.matrixAutoUpdate = false;
      group.updateMatrix();
      ctx.scene.add(group);

      this.buildMs = performance.now() - t0;
      this.drawCalls = group.children.length;
      let tris = 0;
      group.traverse((o) => {
        if (o.isMesh) {
          const n = (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position').count) / 3;
          tris += n * (o.isInstancedMesh ? o.count : 1);
        }
      });
      this.triangles = tris | 0;
    },

    update() {},
    prerender() {},
    resize() {},

    /* ------------------------------------------------------------ public API */

    /**
     * A point on a landmark's rock face.
     * u ∈ [0,1) goes around the stack (or along the cliff, west to east);
     * v ∈ [0,1] runs from the base to the crown rim.
     * @returns {{point: THREE.Vector3, normal: THREE.Vector3} | null}
     */
    surfacePoint(landmarkId, u, v) {
      const L = landmarks.get(landmarkId);
      if (!L) return null;
      if (L._grid) return gridSample(L._grid, u, v);
      if (L._grids) {
        const n = L._grids.length;
        const uu = sat(u) * n;
        const gi = Math.min(n - 1, Math.floor(uu));
        return gridSample(L._grids[gi], uu - gi, v);
      }
      return null;
    },

    /**
     * A point on the flat crown of a stack (where a tree or a moss mat sits).
     * u ∈ [0,1) angular, r ∈ [0,1] from centre to rim.
     */
    crownPoint(landmarkId, u, r) {
      const L = landmarks.get(landmarkId);
      if (!L || !L._built) return null;
      const b = L._built;
      const s = 1 - sat(r);
      const i = Math.round(sat(u) * (b.nT - 1)) % b.nT;
      const th = (i / b.nT) * TAU;
      const rr = b.rimR[i] * Math.pow(sat(r), 0.8);
      const px = rr * Math.cos(th), pz = rr * Math.sin(th);
      const ax = b.field.axis(1);
      const y = b.field.capY(px, pz, s);
      const e = 0.6;
      const yx = b.field.capY(px + e, pz, s) - y;
      const yz = b.field.capY(px, pz + e, s) - y;
      return {
        point: new THREE.Vector3(L.center.x + ax[0] + px, y, L.center.z + ax[1] + pz),
        normal: new THREE.Vector3(-yx / e, 1, -yz / e).normalize(),
      };
    },

    dispose(ctx) {
      ctx.scene.remove(group);
      for (const d of disposables) d.dispose?.();
      for (const m of materials) m.dispose();
      landmarks.clear();
      colliders.length = 0;
    },
  };
}
