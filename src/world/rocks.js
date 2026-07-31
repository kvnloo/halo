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
 * Iron-stained warm limestone, not grey CG rock — see ref/detail/rock_4k.png. The
 * reference `rock` region is *more* saturated than the sand (86.6 against 69.0), so
 * the rock is what carries the colour in that frame; authoring it as a near-neutral
 * pale grey is a large part of why an earlier build read as washed out. Tri-planar, whiteout normal blending
 * (`triplanarNormal` / `triWeights` from src/gfx/glsl/noise.js) over two procedurally
 * baked detail sets sampled at four scales: 9 m, 1.15 m, 0.30 m and 0.055 m tiles.
 * With 1024² maps that resolves relief down to ~2 mm, so the 2 cm requirement is met
 * with two decades of headroom and the surface holds up in a close-up.
 *
 * On top of the tri-planar base:
 *   - curvature wear      bright exposed rock on convex edges, dark grime in concavities
 *   - vertical staining   runoff streaks running down from ledges (ridged3 stretched 25:1)
 *   - bedding             albedo + roughness banding keyed to world y with a warp
 *   - damp / tide band    the biggest tonal event on the silhouette: below the splash
 *                         line the rock drops from ~0.33 to ~0.07 linear, with a weed
 *                         mat in the lower half of the band
 *   - wet zone            below y ≈ 0: roughness 0.31 and a raised F0 -> sheen
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
 *
 * `prof` is BOTTOM-LOADED, and that is a correction, not a preference. Every stack
 * here used to run 0.68-0.78 R at the foot to 1.10-1.18 R at three-quarter height —
 * 45-70% wider at the shoulder than at the base — and all seven shared one curve with
 * jittered numbers, so the whole stack field was a single tree-stump silhouette
 * repeated six times. kf_01500 and ref/detail/rock_4k show the opposite: near-plumb
 * columns, widest at or just above the base, undercut ONCE, terminated by a hard rim.
 * Each stack now gets a different shape *family* (plumb column / leaning slab with a
 * mid-height undercut / tapered spire / stubby drum / two-tier block), and the single
 * overhang event comes from `notch` or `undercut`, never from a smooth brow added on
 * top of a smooth bulge.
 */
const STACKS = [
  {
    // plumb column, faint waist, hard rim — the hero silhouette
    id: 'stack_hero', x: -38, z: -92, baseY: -4.0, topY: 38, radius: 15,
    res: [224, 176], lod: 0, castShadow: true,
    prof: [[0, 1.12], [0.12, 1.11], [0.38, 1.07], [0.66, 1.035], [0.86, 1.04], [0.95, 1.055], [1.0, 1.005]],
    lean: [0.20, -0.11], notch: { y: 1.9, w: 1.5, d: 0.20, dir: 0.6 },
    ledges: [[0.40, 0.055], [0.66, 0.040]], flute: 1.0, crownFlat: 1.0,
  },
  {
    // leaning slab with one mid-height undercut
    id: 'stack_arch', x: 34, z: -70, baseY: -3.4, topY: 41, radius: 17,
    res: [224, 176], lod: 0, castShadow: true,
    prof: [[0, 1.14], [0.13, 1.12], [0.40, 1.06], [0.68, 1.02], [0.88, 1.04], [1.0, 0.98]],
    lean: [-0.24, 0.14], notch: { y: 2.0, w: 1.9, d: 0.25, dir: 2.5 },
    undercut: { t: 0.55, w: 0.12, d: 0.17, dir: 2.2 },
    ledges: [[0.30, 0.070], [0.58, 0.035]], flute: 1.15, crownFlat: 0.8,
  },
  {
    // tapered spire
    id: 'stack_twin_a', x: -96, z: -140, baseY: -7.5, topY: 44, radius: 19,
    res: [176, 144], lod: 1, castShadow: false,
    prof: [[0, 1.15], [0.16, 1.12], [0.46, 1.05], [0.74, 0.99], [0.90, 0.955], [1.0, 0.88]],
    lean: [0.14, 0.20], notch: { y: 1.7, w: 1.6, d: 0.16, dir: 4.0 },
    undercut: { t: 0.40, w: 0.10, d: 0.12, dir: 0.8 },
    ledges: [[0.44, 0.050]], flute: 0.9, crownFlat: 1.0,
  },
  {
    // stubby drum on a broad foot
    id: 'stack_twin_b', x: -128, z: -172, baseY: -9.0, topY: 33, radius: 13,
    res: [144, 112], lod: 1, castShadow: false,
    prof: [[0, 1.21], [0.10, 1.13], [0.36, 1.08], [0.68, 1.06], [0.88, 1.075], [1.0, 1.03]],
    lean: [-0.18, -0.16], notch: { y: 1.6, w: 1.5, d: 0.15, dir: 1.4 },
    ledges: [[0.52, 0.045]], flute: 1.0, crownFlat: 0.9,
  },
  {
    // two-tier block
    id: 'stack_far_a', x: 120, z: -210, baseY: -12, topY: 36, radius: 16,
    res: [112, 88], lod: 2, castShadow: false,
    prof: [[0, 1.13], [0.18, 1.10], [0.34, 1.03], [0.52, 1.01], [0.74, 0.99], [0.92, 1.00], [1.0, 0.93]],
    lean: [0.16, 0.10], notch: { y: 1.8, w: 1.6, d: 0.14, dir: 3.1 },
    ledges: [[0.48, 0.045]], flute: 0.85, crownFlat: 1.0,
  },
  {
    // slender leaner
    id: 'stack_far_b', x: 156, z: -246, baseY: -13, topY: 30, radius: 12,
    res: [96, 72], lod: 2, castShadow: false,
    prof: [[0, 1.14], [0.15, 1.10], [0.44, 1.03], [0.72, 0.98], [0.90, 0.95], [1.0, 0.86]],
    lean: [-0.12, 0.18], notch: { y: 1.7, w: 1.5, d: 0.14, dir: 5.4 },
    ledges: [[0.45, 0.040]], flute: 0.9, crownFlat: 0.9,
  },
  {
    id: 'headland', x: 108, z: 20, baseY: -2.0, topY: 34, radius: 40,
    res: [192, 120], lod: 0, castShadow: true,
    prof: [[0, 1.05], [0.12, 1.04], [0.36, 1.015], [0.60, 0.98], [0.80, 0.945], [0.93, 0.885], [1.0, 0.735]],
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
  const nPlanes = 6 + rnd.int(0, 3);
  for (let i = 0; i < nPlanes; i++) {
    // Bands must reach BELOW the foot. With y0 starting at the base half the planes
    // began above y = 6 m, so the bottom 10 m of every stack was never clipped by
    // anything and stood out as a bell-shaped skirt under a faceted shaft — the
    // "traffic cone" read that survived removing the wave-cut platform flare.
    const y0 = spec.baseY + H * rnd.range(-0.40, 0.34);
    const hh = H * rnd.range(0.55, 1.30);
    planes.push({
      phi: rnd.range(0, TAU),
      p: R * rnd.range(0.74, 1.02),
      tilt: rnd.sym(0.20),
      y0, y1: y0 + hh,
      // 12-30 cm fillet at R = 15. The previous 0.055-0.14 R was a 0.8-2.1 m fillet,
      // which subtends ~25 px at the 90 m hero stack: at that size a smin does not
      // produce an arête, it dents a cylinder, and a surface with no slope
      // discontinuity has no N.L discontinuity and therefore no terminator. That is
      // why shadow_frac read 0.036 against the reference's 0.101 and highlight_frac
      // read 0.000 against 0.044.
      k: R * rnd.range(0.008, 0.020),
      // Narrow ramps at the band ENDS only, so inside the band the face IS the plane
      // rather than a smoothstep-weighted lerp toward it. The ramp itself then reads
      // as a horizontal fracture edge, which is what a bedding plane looks like.
      w: H * rnd.range(0.012, 0.035),
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

    // Exactly ONE overhang event per stack, and it is a real undercut — mass removed
    // below a line so the rock above it hangs — not a smooth brow added on top of a
    // smooth profile bulge. Only the stacks whose shape family calls for it have one;
    // the rest get their single undercut from the wave-cut notch further down.
    if (spec.undercut) {
      const u = spec.undercut;
      const ub = Math.exp(-Math.pow((t - u.t) / u.w, 2));
      const ud = Math.pow(sat(0.5 + 0.5 * Math.cos(th - u.dir)), 1.3);
      r -= R * u.d * ub * ud * (0.72 + 0.56 * (cylFbm(th, y, 1.8, 0.12, 2, seed + 909) * 0.5 + 0.5));
    }

    // ledges: a discrete step in with an outward lip just below it
    for (const [lt, la] of (spec.ledges || [])) {
      r -= R * la * 0.55 * smoothstep(lt - 0.030, lt + 0.070, t);
      r += R * la * 0.40 * Math.exp(-Math.pow((t - lt + 0.011) / 0.016, 2));
    }

    // ---- cleavage faces, and the planarity mask they hand to everything after -----
    // The faces are cut FIRST and every noise term downstream is attenuated by how
    // strongly a face owns this (θ, y). Previously seven displacement terms totalling
    // ~0.5R ran after the clip on the same radius, so the one feature that was supposed
    // to give the stack a flat plane immediately had the plane sanded off it again.
    let planarity = 0;
    for (const pl of planes) {
      const c = Math.cos(th - pl.phi);
      // Wide angular acceptance is free: p/cos blows up away from the plane's facing
      // direction, so the min simply does nothing there. Narrowing it to c > 0.26 only
      // narrowed the PLANARITY mask, which is what left `rough` near 1 over most of
      // the perimeter and let the noise sand the faces back off.
      if (c <= 0.15) continue;
      const g = smoothstep(pl.y0 - pl.w, pl.y0 + pl.w, y) * (1 - smoothstep(pl.y1 - pl.w, pl.y1 + pl.w, y));
      if (g < 0.02) continue;
      const rp = (pl.p + pl.tilt * (y - pl.y0)) / c + R * 0.028 * cylFbm(th, y, 2.2, 0.10, 2, pl.s);
      const w = g * sat((c - 0.15) / 0.22);
      r = mix(r, smin(r, rp, pl.k), g);
      if (w > planarity) planarity = w;
    }
    // a cut face stays a face; the noise lives on the un-cut mass between arêtes
    const rough = 1 - 0.88 * planarity;

    // karst mass: big lumps and blocky sub-masses
    r += R * 0.115 * rough * cylFbm(th, y, 0.95, 0.055, 3, seed);
    r += R * 0.042 * rough * cylFbm(th, y, 2.55, 0.145, 3, seed + 31);

    // vertical fluting — broad ridged grooves stretched along y, on SOME of the
    // perimeter only: uniform ribbing all the way round reads as corduroy, not rock.
    // There is no floor on the mask, so roughly half the perimeter carries no fluting
    // at all, and the grooves are y-banded so they terminate at bedding planes instead
    // of running dead straight for the full 42 m.
    // The crest must not be serrated: a 1.6 m groove cut into the last row reads as saw
    // teeth against the sky, which no sea stack has. Fade the grooves out under the rim.
    const topFade = 1 - smoothstep(0.84, 0.99, t);
    const fw = 0.40 * cylFbm(th, y, 0.7, 0.05, 2, seed + 77);
    const fmask = Math.pow(sat(0.55 + 0.9 * Math.cos(th - fluteDir)
      + 1.5 * cylFbm(th, y, 1.3, 0.045, 2, seed + 91)), 1.5)
      * smoothstep(-0.30, 0.20, cylFbm(th, y, 0.4, 0.35, 2, seed + 97));
    r -= R * 0.072 * flute * rough * fmask * topFade * cylRidged(th + fw, y, 5.6, 0.10, 3, seed + 53);

    // karst solution channels: narrow, deep, drip-warped, upper faces only
    const cw = 0.85 * cylFbm(th, y, 0.5, 0.09, 2, seed + 201);
    const ch = cylRidged(th + cw, y, 11.5, 0.055, 2, seed + 143);
    r -= R * 0.058 * flute * rough * fmask * topFade * Math.pow(sat(ch * 1.30), 2.0)
      * (0.25 + 0.75 * smoothstep(0.14, 0.55, t));

    // sedimentary bedding — small, and gated so it only shows where the face cuts
    // across the strata rather than as a ring all the way round
    const bw = 2.6 * cylFbm(th, y, 4.5, 0.05, 2, seed + 601);
    const bmask = sat(0.35 + 1.4 * cylFbm(th, y, 1.1, 0.02, 2, seed + 631));
    r += bedA * bmask * (beddingShape((y + bw) / bedP1) + 0.8 * beddingShape((y + bw * 0.6) / bedP2));

    // Wave-cut platform. Only on part of the perimeter — a flare all the way round is a
    // plinth, and stacks do not stand on plinths; the surf cuts a shelf where it reaches.
    // No floor on the mask and a much smaller flare: at 0.25 floor / 0.20R this ran the
    // whole way round and was *larger* than the notch, so every stack stood on a
    // mushroom foot that was wider than its shaft and lit exactly where the dark tide
    // band belongs.
    // Cut to 0.07R -> 0.022R and pulled below y = 1.2: with a bottom-loaded profile
    // the foot is already the widest part of the stack, so any flare on top of it is
    // a second, brighter skirt exactly where the dark tide band belongs.
    const ft = smoothstep(1.2, -1.6, y);
    const fpm = sat(1.5 * cylFbm(th, y, 1.15, 0.06, 2, seed + 811)
      + 0.9 * Math.cos(th - n.dir) - 0.15);
    r += R * 0.022 * ft * fpm * (0.55 + 0.45 * (cylFbm(th, y, 3.2, 0.30, 2, seed + 821) * 0.5 + 0.5));

    // wave-cut notch: skewed in y so the roof overhangs, deepest on the exposed side.
    // Evaluated AFTER the platform so the undercut wins — an undercut that a shelf can
    // fill back in is not an undercut.
    const dy = y - n.y;
    const np = Math.exp(-Math.pow(dy / (dy > 0 ? n.w * 0.78 : n.w * 1.35), 2));
    const nd = 0.32 + 0.68 * sat(Math.cos(th - n.dir) * 0.5 + 0.5);
    const nb = 0.68 + 0.64 * (cylFbm(th, y, 3.4, 0.25, 2, seed + 511) * 0.5 + 0.5);
    r -= R * (n.d + 0.07) * np * nd * nb;

    // fine relief so the mesh itself carries ~30 cm structure
    r += R * 0.019 * rough * cylFbm(th, y, 6.2, 0.62, 3, seed + 311);

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
      a: new THREE.Vector3(spec.x + a0[0], y0, spec.z + a0[1]),
      b: new THREE.Vector3(spec.x + a1[0], y1, spec.z + a1[1]),
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
        box: new THREE.Box3().setFromCenterAndSize(
          new THREE.Vector3(x, 32, zf + 26),
          new THREE.Vector3((spanX / 8 + 1) * 2, 64, 52)),
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
    // --- A: meso relief. A limestone face is a MOSAIC OF NEAR-FLAT PLATES separated
    // by knife-edge fracture lines and metre-deep gullies (ref/detail/rock_4k.png).
    // It is not a field of bumps. The previous map was 0.55*ridged + 0.30*fbm +
    // worley pockets, i.e. isotropic blob noise at essentially one scale, and at 90 m
    // that covered every square metre of every stack in identical popcorn — the
    // single most obvious "procedural" tell in the whole module.
    //
    // Note on tiling: tgnoise/tfbm stay periodic under any *additive* offset (the
    // lattice index shifts by the same integer at p and p+P) but only under INTEGER
    // scale multiples, so every rescale below is 2x or 3x.
    float P = 6.0;
    vec2 p = vUv * P;
    vec2 w = vec2(tfbm(p, P, 4), tfbm(p + 3.7, P, 4));

    // (1) plates — terrace a smooth warped field so the surface is piecewise flat
    // with hard risers between levels. That is what bedded, jointed limestone does.
    float base = tfbm(p + w * 0.55, P, 4);
    float lv = base * 3.2;
    float terr = (floor(lv) + smoothstep(0.0, 0.14, fract(lv))) / 3.2;
    // 65% terraced, 35% smooth: a full terrace reads as a machined contour map, and
    // once the popcorn was gone that regularity became the new procedural tell.
    h = mix(base, terr, 0.65) * 0.42 + 0.30;

    // (2) fracture lines — two families of thin deep cuts, the arêtes and joints
    float c1 = tgnoise(p * 2.0 + 4.2, P * 2.0);
    float c2 = tgnoise(p + vec2(11.3, 2.1), P);
    // Widths matter more than depths here: a 1-texel-wide cut Sobels into a near-90
    // degree normal and that aliases into a crawling white thread at range (measured
    // lap_var 5565 against a reference 1296 before these were widened).
    h -= 0.17 * (1.0 - smoothstep(0.0, 0.080, abs(c1)));
    h -= 0.12 * (1.0 - smoothstep(0.0, 0.052, abs(c2)));

    // (3) a little grain so the plates are not glassy — deliberately small
    h += 0.09 * tfbm(p * 3.0, P * 3.0, 3);

    // (4) solution pockets, far rarer and larger than the old 14-cell field
    vec2 wo = tworley(vUv * 7.0, 7.0);
    h -= 0.13 * smoothstep(0.26, 0.02, wo.x);
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
uniform vec3  uColBase, uColBright, uColGrime, uColStain, uColDamp, uColAlgae, uColMoss, uColLichen, uColBleach;
uniform float uRough, uAlgaeAmt, uMossAmt, uWetY, uDetailAmt, uAOAmt, uMacroAmt;
uniform float uSpecF0, uSpecF90, uWetAmt, uSpecOccAmt, uHexAmt, uDbg;
varying vec3 vWNrmRK;
varying vec4 vRockRK;

/* Specular occlusion, consumed at <lights_fragment_end> (see makeRockMaterial).
 * three's MeshStandardMaterial applies none at all, so the PMREM sky probe lays an
 * even blue sheen into every gully and under every overhang — light that no path
 * in the scene could deliver. Measured on a black-albedo capture it was 35-45% of
 * the rendered pixel and it was the reason the rock rendered B > R under an ochre
 * albedo with B/R = 0.24. */
float gRKSpecOcc = 1.0;
/* Ambient occlusion, likewise applied to reflectedLight.indirectDiffuse and not to
 * the albedo, so it cannot darken direct sunlight. */
float gRKAO = 1.0;

/* ------------------------------------------------------------------ hex-tiling
 * Mikkelsen, "Practical Real-Time Hex-Tiling", JCGT 11(2) 2022,
 * https://jcgt.org/published/0011/03/05/ — gamma = 7, beta = 0.6, and the S-curve
 * gain disabled (r = 0.5) for normal data, which is what the paper prescribes.
 * The paper is HLSL: mul(M,v) is v*mat(same args) in GLSL because HLSL's float2x2 is
 * row-major, so the skew is written out longhand rather than as a mat2.
 * Why it is here: the 9 m octave repeats ~38 times across the 340 m cliff wall. */
const float RK_HEX_S = 3.46410162;   // 2*sqrt(3)

void rkTriGrid(out vec3 w, out ivec2 v1, out ivec2 v2, out ivec2 v3, vec2 st){
  st *= RK_HEX_S;
  vec2 sk = vec2(st.x - 0.57735027 * st.y, 1.15470054 * st.y);
  ivec2 baseId = ivec2(floor(sk));
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s  = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;
  w  = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  v1 = baseId + ivec2(int(s), int(s));
  v2 = baseId + ivec2(int(s), 1 - int(s));
  v3 = baseId + ivec2(1 - int(s), int(s));
}
/* Integer hash. research/terrain.md 1.5: both fract(sin(x)*43758) and the Hoskins
 * fract(p*0.1031) run out of mantissa once the vertex id passes ~2000, which happens
 * partway along this cliff, and the base repeat comes back as diagonal banding.
 * ES 3.00 has uints — use them. */
vec2 rkHashI(ivec2 p){
  uvec2 q = uvec2(p) * uvec2(1597334673u, 3812015801u);
  q = (q.x ^ q.y) * uvec2(1597334673u, 3812015801u);
  return vec2(q) * (1.0 / float(0xffffffffu));
}
/* One hex-tiled fetch. Derivatives are passed in, computed BEFORE the random offset:
 * Heitz & Neyret 5.4 — the offsets break dFdx across a tile boundary and the hardware
 * reads that as a huge footprint, i.e. a 1 px blurred line tracing every hex edge. */
vec4 rkHexTex(sampler2D tex, vec2 st, vec2 dx, vec2 dy){
  vec3 w; ivec2 v1, v2, v3;
  rkTriGrid(w, v1, v2, v3, st);
  vec4 c1 = textureGrad(tex, st + rkHashI(v1), dx, dy);
  vec4 c2 = textureGrad(tex, st + rkHashI(v2), dx, dy);
  vec4 c3 = textureGrad(tex, st + rkHashI(v3), dx, dy);
  // Eq. 3's delta() modulation: let the tile with the more prominent feature win the
  // transition so the seam stops following the hex edge. These maps carry height in
  // .w, which is a better proxy for "prominent" than the luminance Eq. 4 uses.
  vec3 Dw = mix(vec3(1.0), vec3(c1.w, c2.w, c3.w), 0.6);   // beta = 0.6
  vec3 W = Dw * pow(w, vec3(7.0));                          // gamma = 7
  W /= max(W.x + W.y + W.z, 1e-6);
  return W.x * c1 + W.y * c2 + W.z * c3;
}

/** Whiteout tri-planar blend carrying the height channel, with Golus's projection
 *  correction and an optional hex-tiled path. Every fetch is textureGrad so the whole
 *  function is legal inside non-uniform control flow. */
vec4 rkTriNH(sampler2D t, vec3 wp, vec3 n, float scale, float sharp, float hex){
  vec3 w = triWeights(n, sharp);
  // Golus's axisSign step, which research/terrain.md 4.1 names this repo's
  // TRIPLANAR_GLSL for omitting: without it every face whose axis component is
  // negative samples a mirrored projection, so on a generalised cylinder half of
  // every stack has its detail lighting running backwards.
  // https://github.com/bgolus/Normal-Mapping-for-a-Triplanar-Shader
  vec3 sg = vec3(n.x < 0.0 ? -1.0 : 1.0, n.y < 0.0 ? -1.0 : 1.0, n.z < 0.0 ? -1.0 : 1.0);
  vec2 ux = vec2(wp.z *  sg.x, wp.y) * scale;
  vec2 uy = vec2(wp.x *  sg.y, wp.z) * scale;
  vec2 uz = vec2(wp.x * -sg.z, wp.y) * scale;
  vec2 dxx = dFdx(ux), dyx = dFdy(ux);
  vec2 dxy = dFdx(uy), dyy = dFdy(uy);
  vec2 dxz = dFdx(uz), dyz = dFdy(uz);
  vec4 sx, sy, sz;
  if (hex > 0.5) {
    sx = rkHexTex(t, ux, dxx, dyx);
    sy = rkHexTex(t, uy, dxy, dyy);
    sz = rkHexTex(t, uz, dxz, dyz);
  } else {
    sx = textureGrad(t, ux, dxx, dyx);
    sy = textureGrad(t, uy, dxy, dyy);
    sz = textureGrad(t, uz, dxz, dyz);
  }
  vec3 nx = sx.xyz * 2.0 - 1.0, ny = sy.xyz * 2.0 - 1.0, nz = sz.xyz * 2.0 - 1.0;
  nx.x *=  sg.x; ny.x *=  sg.y; nz.x *= -sg.z;
  nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
  ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
  nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
  vec3 nn = normalize(nx.zyx*w.x + ny.xzy*w.y + nz.xyz*w.z);
  float h = sx.w*w.x + sy.w*w.y + sz.w*w.z;
  return vec4(nn, h);
}

/** Mikkelsen, *Surface Gradient-Based Bump Mapping Framework*, JCGT 9(3) 2020.
 *  Eq. 2 says the tangent-space normal is the normalised (-dH/du, -dH/dv, 1), so
 *  DERIVATIVES add linearly and normals do not. Resolve each octave to its
 *  tangent-plane gradient with this, sum those, and convert once at the end:
 *  normalize(Ng - g) reproduces the octave exactly when only one is present, and
 *  composes correctly when several are. The old normalize(Ng + sum(n_k - Ng))
 *  understates the slope wherever two octaves are both steep, so the surface got
 *  flatter with every layer added. */
vec3 rkGrad(vec3 nk, vec3 Ng){
  float d = max(dot(Ng, nk), 1e-3);
  return (Ng * d - nk) / d;
}
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }
`;

const ROCK_FRAG = /* glsl */`
vec3 P  = vWorldPositionWM;
vec3 Ng = normalize(vWNrmRK);

float occ = vRockRK.x, cvx = vRockRK.y, shl = vRockRK.z, crn = vRockRK.w;

float vDist = distance(P, cameraPosition);

// ---- tri-planar detail, five scales: 9 m / 3.5 m / 1.15 m / 0.30 m / 0.055 m --
// Each scale is rotated in world space so the same map at different sizes does not
// visibly repeat itself down the pyramid.
//
// Two structural rules from research/terrain.md, neither of which this ladder used
// to obey:
//
// 3.1 — every octave fades out at *its own pixel footprint*, not at a camera
//   distance, and its albedo and its normal fade together. The old gate was
//   1 - smoothstep(8, 26, vDist) on the two finest heights only, so the 30 cm and
//   5.5 cm NORMALS still contributed 0.34 and 0.14 at 300 m where 5.5 cm subtends
//   0.02 px. That is not detail, it is aliasing, and it was the uniform isotropic
//   fizz laid over the whole 42 m stack.
// 3.2 — compose as derivatives (see rkGrad), not as normals.
const float L0 = 9.00, L1 = 3.50, L2 = 1.15, L3 = 0.30, L4 = 0.055;   // metres
// anisotropic max pixel footprint in metres
vec3 ddxP = dFdx(P), ddyP = dFdy(P);
float fp = max(length(ddxP), length(ddyP));
// Nyquist is two texels per wavelength; fade between one and two.
float w0 = 1.0 - smoothstep(0.5, 1.0, fp / L0);
float w1 = 1.0 - smoothstep(0.5, 1.0, fp / L1);
float w2 = 1.0 - smoothstep(0.5, 1.0, fp / L2);
float w3 = 1.0 - smoothstep(0.5, 1.0, fp / L3);
float w4 = 1.0 - smoothstep(0.5, 1.0, fp / L4);

// Hex-tiling is only worth its 6 extra taps while the tile is still large on screen.
// A 9 m tile stops being recognisable as a repeat once it is under ~40 px, i.e.
// fp > 0.22 m; the 3.5 m rung crosses the same threshold at fp > 0.09 m.
float hexNear = uHexAmt * step(fp, 0.22);
float hexMid  = uHexAmt * step(fp, 0.09);

mat3 r1 = rotY(0.9), r2 = rotY(2.1), r3 = rotY(-1.35), r0 = rotY(-0.55);
vec4 dA1 = rkTriNH(uNH_A, P,      Ng, 1.0/L0, 4.0, hexNear);
vec4 dA0 = rkTriNH(uNH_A, r0 * P, Ng, 1.0/L1, 4.5, hexMid);
vec4 dA2 = rkTriNH(uNH_A, r1 * P, Ng, 1.0/L2, 5.0, 0.0);
vec4 dB1 = rkTriNH(uNH_B, r2 * P, Ng, 1.0/L3, 6.0, 0.0);
vec4 dB2 = rkTriNH(uNH_B, r3 * P, Ng, 1.0/L4, 6.0, 0.0);

float k = uDetailAmt;
vec3 gDet = vec3(0.0);
gDet += (1.30 * k * w0) * rkGrad(dA1.xyz, Ng);
gDet += (1.20 * k * w1) * rkGrad(dA0.xyz, Ng);
gDet += (0.70 * k * w2) * rkGrad(dA2.xyz, Ng);
gDet += (0.28 * k * w3) * rkGrad(dB1.xyz, Ng);
gDet += (0.14 * k * w4) * rkGrad(dB2.xyz, Ng);
// clamp the SUM, not each layer: slope 83 deg, so a stacking accident cannot invert N
float gLen = length(gDet);
gDet *= (gLen > 8.0) ? (8.0 / gLen) : 1.0;
vec3 nDet = normalize(Ng - gDet);

// Expand each scale over its useful band before it modulates anything: the raw maps
// cluster around the middle and an un-stretched height buys almost no albedo variance.
// Each is gated by the SAME footprint weight as its normal — an octave that has left
// the normal must not still be driving tone, and vice versa.
float hA  = mix(0.5, smoothstep(0.12, 0.90, dA1.w), w0);
float hA0 = mix(0.5, smoothstep(0.12, 0.90, dA0.w), w1);
float hB  = mix(0.5, smoothstep(0.12, 0.90, dA2.w), w2);
float hC  = mix(0.5, smoothstep(0.12, 0.90, dB1.w), w3);
float hD  = mix(0.5, smoothstep(0.15, 0.88, dB2.w), w4);
float h = hA * 0.30 + hA0 * 0.26 + hB * 0.22 + hC * 0.14 + hD * 0.08;

// ---- macro fields (procedural, so they never tile) ---------------------------
float m1 = fbm3(P * 0.055, 4);
float m2 = fbm3(P * 0.215 + 11.0, 3);
// runoff staining: ridged noise stretched ~25:1 along gravity
float streak = ridged3(vec3(P.x * 1.05, P.y * 0.042, P.z * 1.05) + m1 * 0.7, 4);
streak = pow(clamp(streak * 1.25, 0.0, 1.0), 1.5);
// bedding: asymmetric bands in world y, warped so they are not dead level
// Bedding. Real strata vary in thickness by a factor of several and wander; a
// fract() on a lightly warped world y is a dead-level 1.7 m contour ring, which is
// exactly what appeared the moment the detail map stopped hiding it. Warp hard in y
// (amplitude ~1.6 m) and modulate the band's own strength, so the strata read as a
// sequence of unequal beds rather than a lathe finish.
float bw  = fbm3(P * vec3(0.055, 0.016, 0.055), 3);
float bWarp = 1.55 * fbm3(P * vec3(0.030, 0.055, 0.030) + 5.0, 3)
            + 0.65 * fbm3(P * vec3(0.11, 0.14, 0.11) + 23.0, 2);
float bs  = fract(P.y * 0.58 + bw * 1.9 + bWarp);
float bed = smoothstep(0.0, 0.09, bs) * (1.0 - smoothstep(0.55, 0.98, bs));
bed *= 0.35 + 0.65 * smoothstep(-0.25, 0.30, fbm3(P * vec3(0.09, 0.021, 0.09) + 61.0, 3));
float bed2 = fract(P.y * 0.205 + bw * 0.9 + bWarp * 0.5);
bed2 = smoothstep(0.0, 0.12, bed2) * (1.0 - smoothstep(0.6, 1.0, bed2));

// ---- albedo ------------------------------------------------------------------
// Measured on the reference (kf_01500, rock-only boxes): the lit faces run
// lum 67-111 with lum_std 33-64 and lap_var 860-3900. That variance is the whole
// game — it has to come from independent modulation at every scale, so each detail
// octave multiplies albedo separately rather than through one blended height.
//
// The *bright* half of that chain used to run to 1.38*1.30*1.24*1.15 = 2.56x, and on
// top of a macro term reaching 1.43x the top decile of every stack was multiplied by
// 3.7 — which is how a 0.36 limestone ended up rendering as bleached bone. Rock does
// not have a 3.7x dynamic range in reflectance; it has a wide *dark* tail (shadowed
// pits, grime, damp) and a narrow bright one. The dark side is kept, the bright side
// is capped near 1.9x, and the level lost is put back into the base colour where it
// is under one number instead of four multiplied ones.
vec3 alb = uColBase;
alb *= 1.0 + uMacroAmt * (0.34 * m1 + 0.19 * m2);
alb *= mix(0.60, 1.24, hA);
alb *= mix(0.66, 1.22, hA0);
alb *= mix(0.78, 1.14, hB);
alb *= mix(0.88, 1.10, hC);
alb *= mix(0.94, 1.05, hD);
// curvature wear: grime settles in the concavities, edges scrub clean and bright
float grime = (1.0 - occ) * (0.45 + 0.55 * (1.0 - smoothstep(0.15, 0.62, h)));
alb = mix(alb, uColGrime, clamp(grime * 0.95, 0.0, 0.82));
float wear = cvx * cvx * smoothstep(0.36, 0.88, h);
alb = mix(alb, uColBright, wear * 0.70);
// Vertical staining, strongest below ledges and absent on up-facing rock. Gated by a
// low-frequency patch field as well: an unbroken 25:1 ridged streak applied over every
// non-up-facing texel is corduroy, and it was the dominant read on the whole stack
// field. Runoff comes off specific ledges and gullies, not off every square metre.
float stainPatch = smoothstep(-0.10, 0.42, fbm3(P * vec3(0.05, 0.012, 0.05) + 17.0, 3));
float stainMask = streak * (1.0 - smoothstep(0.25, 0.72, Ng.y)) * (0.35 + 0.65 * (1.0 - crn)) * stainPatch;
alb = mix(alb, uColStain, stainMask * 0.36);
// bedding shows as a tonal band, not a groove
alb *= 1.0 - 0.13 * bed - 0.08 * bed2;

// ---- tide zone ---------------------------------------------------------------
// The single biggest tonal event on a sea stack's silhouette. In the reference the
// rock below the splash line is *much* darker than the dry rock above it — a soaked,
// weed-colonised band of roughly 0.10 linear against 0.36 dry — and the boundary is
// what stops the stack reading as one pale monolith. The old mask topped out around
// 0.19 of a mix, which is invisible; this one is a real band.
float yn = 0.62 * fbm3(P * vec3(0.16, 0.55, 0.16), 3) + 0.30 * fbm3(P * vec3(0.9, 2.2, 0.9), 2);
float yw = P.y - uWetY + yn * 1.5;
float wet = smoothstep(1.15, -0.35, yw) * uWetAmt;

// Broad damp band: soaked rock, strongest at the waterline, gone by ~5 m up.
//
// HEIGHT-BLENDED, not linearly blended — Mishkinis, *Advanced Terrain Texture
// Splatting* (2013), whose problem statement is exactly this defect: "Sand doesn't
// stick to stones, instead it falls down and fills cracks between them, leaving tops
// of stones pure." The sea fills the low plates first and leaves the proud faces dry,
// so the damp material's height is 1-h and the dry material's is h. A linear 3.45 m
// ramp gave an 8.7 code-value step where the reference moves 28.6; this one is ragged
// and near-hard, with dark tongues running up the gullies.
float dampW = clamp(smoothstep(4.4, 0.15, yw) * uAlgaeAmt, 0.0, 1.0);
dampW *= 0.82 + 0.18 * smoothstep(-0.40, 0.35, m2);   // reuse the macro octave: no extra fbm3
float dryW = 1.0 - dampW;
const float DAMP_DEPTH = 0.20;    // research 4.4: 0.15-0.25 for rock
float dMa = max(h + dryW, (1.0 - h) + dampW) - DAMP_DEPTH;
float dB1w = max(h + dryW - dMa, 0.0);
float dB2w = max((1.0 - h) + dampW - dMa, 0.0);
float damp = dB2w / max(dB1w + dB2w, 1e-5);
alb = mix(alb, uColDamp, damp * 0.95);

// weed / algae mat concentrated in the lower half of that band
float algae = smoothstep(3.2, 0.1, yw) * smoothstep(-3.6, -1.4, yw);
algae *= (0.45 + 0.55 * smoothstep(-0.25, 0.55, Ng.y));
algae *= (0.52 + 0.48 * (1.0 - occ));
algae *= 0.35 + 0.65 * smoothstep(-0.35, 0.35, fbm3(P * 0.42 + 31.0, 3));
algae *= uAlgaeAmt;
alb = mix(alb, uColAlgae, clamp(algae * 0.95, 0.0, 0.94));

// salt-bleached supratidal band just above the algae. Bleached limestone is *pale
// warm*, not grey: a neutral bleach colour here was quietly desaturating the brightest
// and most visible band on every stack.
float bleach = exp(-pow((yw - 4.6) / 2.4, 2.0)) * 0.26 * cvx * smoothstep(0.3, 0.8, h);
alb = mix(alb, uColBleach, bleach);

// ---- moss / lichen on the crown ---------------------------------------------
float up = smoothstep(0.10, 0.68, Ng.y);
float mottle = smoothstep(-0.22, 0.30, fbm3(P * 0.26 + 71.0, 4));   // 'patch' is reserved in GLSL ES 3.00
float moss = crn * up * mottle * (0.45 + 0.55 * (1.0 - occ)) * uMossAmt;
alb = mix(alb, uColMoss, clamp(moss, 0.0, 0.9));
// Lichen is not only a crown feature: on a real stack the ochre crusts colonise every
// dry up-facing ledge and bedding step from the supratidal band to the top. Keeping it
// on the crown alone threw away the one warm high-chroma accent the rock has.
float lichZone = max(crn, 0.55 * up * smoothstep(4.0, 8.5, yw));
float lich = lichZone * 0.50 * smoothstep(0.42, 0.95, h) * smoothstep(0.0, 0.5, fbm3(P * 0.7 + 5.0, 3));
alb = mix(alb, uColLichen, clamp(lich * uMossAmt * 0.42, 0.0, 0.55));

// under an overhang: dry, dusty, no growth, and genuinely darker
alb = mix(alb, alb * vec3(0.66, 0.645, 0.635), shl * 0.72);
// wet rock loses diffuse — but uColDamp has already taken the tone down, so this is
// only the last bit of specular-dominated darkening, not a second full halving.
alb *= mix(1.0, 0.66, wet);

// ---- ambient occlusion --------------------------------------------------------
// AO is an INDIRECT term and it is applied to reflectedLight.indirectDiffuse at
// <lights_fragment_end>, not multiplied into the albedo. Multiplying it in dimmed the
// SUN as well as the sky, which is exactly backwards here: measured with the albedo
// forced to a flat 0.18 grey (--config rockDbg=2) the rock's own lighting reads
// rgb 72/76/88 — B largest, R-B = -15, lab_b -7.5 — i.e. the surface is dominated by
// a blue sky probe, and the term that should have been suppressing that was instead
// being spent equally on the one warm, directional source in the scene.
float ao = mix(1.0, 0.30 + 0.70 * occ, uAOAmt);
ao *= mix(1.0, 0.40, shl * 0.9);
ao *= mix(1.0, 0.58 + 0.42 * smoothstep(0.02, 0.52, hC), 0.9);
gRKAO = ao;

diffuseColor.rgb = alb;
diffuseColor.a = 1.0;

// Diagnostic. --config rockDbg=1 forces the albedo to pure black so whatever is
// left in the frame is indirect specular and nothing else; 2 forces a known 0.18 grey.
// This is the only honest way to tune a sheen: an albedo problem cannot survive its
// own albedo being zero.
if (uDbg > 0.5) diffuseColor.rgb = (uDbg < 1.5) ? vec3(0.0) : vec3(0.18);

// ---- roughness ---------------------------------------------------------------
float rgh = uRough * (0.84 + 0.38 * (1.0 - h));
rgh = mix(rgh, 0.55, algae * 0.55);
rgh = mix(rgh, 0.78, bed * 0.30);
// the tide line's height-blend weight drives roughness too, not only albedo — a crisp
// colour edge over a soft lighting edge reads as a decal painted on the rock
rgh = mix(rgh, 0.52, damp * 0.55);
rgh = mix(rgh, 0.44, wet);           // damp porous limestone, not a mirror.
                                     // 0.31 turned the near-flat tide-pool slab into
                                     // chrome foil at grazing incidence.
// research/terrain.md 3.3: an octave that left under the footprint gate has to hand
// its variance to roughness or the rock gets GLOSSIER as it recedes — the exact
// wrong behaviour. Added in alpha space, which is where variance lives.
float lostVar = (1.0 - w2) * 0.010 + (1.0 - w3) * 0.024 + (1.0 - w4) * 0.034;
rgh = sqrt(clamp(rgh * rgh + lostVar, 0.0, 1.0));
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

// Geometric specular antialiasing — Tokuyoshi & Kaplanyan, *Improved Geometric
// Specular Antialiasing*, I3D 2019, Eq. 4 / Listing 2:
//     alphaBar^2 = alpha^2 + min(2*sigma^2*(|dn/du|^2 + |dn/dv|^2), kappa)
// kappa = 0.18 is the paper's clamp. SIGMA2 = 0.25 is Kaplanyan's half-pixel box
// kernel; the paper does not state a numeric value, so treat it as tuned, not cited.
// Nothing in this module did any specular AA at all, and it is 6 ALU.
{
  vec3 dnx = dFdx(nDet), dny = dFdy(nDet);
  float nvar = 0.25 * (dot(dnx, dnx) + dot(dny, dny));
  float a2 = material.roughness * material.roughness + min(2.0 * nvar, 0.18);
  material.roughness = sqrt(clamp(a2, 0.0, 1.0));
}

// ---- specular -----------------------------------------------------------------
// three gives every non-metal a flat F0 = 0.04 with F90 = 1.0 and applies NO specular
// occlusion, so the PMREM sky probe lays an even sheen over the whole rock. Measured:
// with the albedo forced to pure black (--config rockDbg=1) and both veils nulled,
// the rock still rendered sRGB 36/37/45 — 35-45% of the shipped pixel, and BLUE
// (B > R by 9) under an albedo whose B/R is 0.24. That, not fog, is why the rock ROI
// came out B > G > R.
//
// Two corrections, both physical:
//  (a) F90. research/terrain.md 5.3 puts dry cliff rock at F0 0.04, and a microporous
//      carbonate has no coherent grazing interface at all — the 'surface' is a
//      statistical mix of grains, pores and dust, so the Fresnel edge peak is
//      suppressed rather than rising to unity. 0.45 was buying a blue rim wash and
//      nothing else. Wet rock goes the other way: that is the point of a wet rock.
//  (b) Occlusion by the baked cavity mask, exactly as terrain.js does with its
//      gTSpecOcc global. None of that sheen should survive inside a gully or under
//      an overhang.
float sF0  = mix(uSpecF0, 0.038, wet);
float sF90 = mix(uSpecF90, 0.62, wet);
material.specularColor = vec3(sF0);
material.specularColorBlended = mix(vec3(sF0), diffuseColor.rgb, metalnessFactor);
material.specularF90 = sF90;

float so = mix(1.0, 0.20 + 0.80 * occ, uSpecOccAmt);
so *= mix(1.0, 0.38, shl);
so *= mix(0.70, 1.0, wet);          // the wet band keeps its lobe; dry chalk has none
gRKSpecOcc = so;
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

const PAL = [1, 1, 1];   // calibration probe scale — must be [1,1,1] in shipped builds
const C = (r, g, b) => new THREE.Color(r * PAL[0], g * PAL[1], b * PAL[2]);

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
    uColDamp: { value: o.damp },
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
    uSpecF0: { value: o.specF0 ?? 0.025 },
    // 0.45 was re-derived against a black-albedo capture: see the specular block in
    // ROCK_FRAG. 0.13 is what leaves a neutral, sub-8-sRGB floor.
    uSpecF90: { value: o.specF90 ?? 0.13 },
    uWetAmt: { value: o.wetAmt ?? 1.0 },
    uSpecOccAmt: { value: o.specOcc ?? 1.0 },
    uHexAmt: { value: o.hex ?? 1.0 },
    uDbg: { value: 0 },
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

  // Specular occlusion has to be applied to `reflectedLight`, which only exists after
  // <lights_fragment_end>; the ROCK_FRAG injection point (<lights_fragment_begin>) is
  // too early. Chain a hook in front of applyWorldMaterial's so it captures this one
  // as `prev` — same construction terrain.js uses for gTSpecOcc.
  const prevOBC = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prevOBC?.(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
  reflectedLight.directSpecular   *= gRKSpecOcc;
  reflectedLight.indirectSpecular *= gRKSpecOcc;
  reflectedLight.indirectDiffuse  *= gRKAO;`);
  };

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
      //
      // Iron-stained warm limestone. Two numbers set these:
      //
      // 1. Level. Pale coastal limestone is ~0.32-0.40 *luminance* reflectance. The
      //    base below is 0.362, and because the detail chain now averages 0.85 rather
      //    than 0.96 the surface mean lands near 0.31 — a warm mid-tone, which is what
      //    a sunlit stack is. It is emphatically not a white surface; the previous
      //    numbers averaged 0.27 but had a 3.7x bright tail that clipped to bone.
      //
      // 2. Hue. Warm, but NOT pre-compensated for the aerial veil. The previous pass
      //    pushed B/R down to 0.125 on the argument that inscatter would eat the
      //    chroma back; measured at the scored pose with the veil nulled out that
      //    lands on sat 128 against a reference 92-96, i.e. the palette was fitted to
      //    a rendering bug and inverts the moment the bug is fixed. B/R is now 0.24,
      //    which measures on target with the veil off and is still ochre enough that
      //    the rock carries more chroma than the sand, as it does in the reference.
      const matRock = makeRockMaterial(ctx, A.tex, B.tex, {
        key: 'rock-limestone',
        base: C(0.532, 0.426, 0.120),
        bright: C(0.700, 0.596, 0.232),
        grime: C(0.086, 0.060, 0.026),
        stain: C(0.158, 0.082, 0.022),
        damp: C(0.062, 0.049, 0.027),
        algae: C(0.048, 0.056, 0.022),
        moss: C(0.036, 0.068, 0.020),
        lichen: C(0.300, 0.285, 0.105),
        bleach: C(0.720, 0.545, 0.235),
        rough: 0.76, algaeAmt: 1.0, mossAmt: 1.0,
      });
      // Beach and surf boulders read much darker and greener than the stacks —
      // permanently wet, permanently colonised. Darker, but not the near-black chips
      // the first pass produced: a sunlit beach cobble is a mid-dark warm grey, and
      // 0.115 luminance reflectance rendered as coal against the sand.
      const matBoulder = makeRockMaterial(ctx, A.tex, B.tex, {
        key: 'rock-boulder',
        base: C(0.284, 0.179, 0.052),
        bright: C(0.428, 0.294, 0.098),
        grime: C(0.048, 0.034, 0.018),
        stain: C(0.082, 0.050, 0.018),
        damp: C(0.044, 0.036, 0.021),
        algae: C(0.040, 0.050, 0.020),
        moss: C(0.030, 0.058, 0.018),
        lichen: C(0.195, 0.190, 0.078),
        bleach: C(0.380, 0.318, 0.180),
        rough: 0.70, algaeAmt: 1.5, mossAmt: 0.5, macro: 1.3,
      });
      // Far stacks and islets: pure silhouette work, so the expensive detail scales
      // are dialled down and AO is flattened. The palette is NOT boosted to fight
      // aerial perspective — it used to ship more chroma than the near rock for
      // exactly that reason, which is a material authored around a rendering bug.
      // B/R here is >= matRock's, so correcting the veil cannot make the far stacks
      // more saturated than the near ones.
      const matFar = makeRockMaterial(ctx, A.tex, B.tex, {
        key: 'rock-far',
        base: C(0.524, 0.422, 0.124),
        bright: C(0.692, 0.590, 0.234),
        grime: C(0.110, 0.078, 0.034),
        stain: C(0.162, 0.094, 0.032),
        damp: C(0.072, 0.056, 0.031),
        algae: C(0.055, 0.062, 0.026),
        moss: C(0.044, 0.074, 0.024),
        lichen: C(0.290, 0.278, 0.104),
        bleach: C(0.710, 0.540, 0.238),
        rough: 0.78, algaeAmt: 0.8, mossAmt: 0.9, detail: 0.6, ao: 0.75, macro: 0.85,
      });
      // The wave-cut shelf is a half-buried horizontal slab seen at a grazing angle,
      // and at that angle the full detail-normal stack reads as crumpled foil rather
      // than as rock: measured lap_var 3247 / edge_density 0.295 against a reference
      // face at 421 / 0.123. Nulling `uDetailAmt` on the shelf dropped lap_var to 24,
      // so every bit of that energy is detail normals, not the mesh. Same palette,
      // two-thirds the normal amplitude, and the tide colours pushed up because the
      // whole slab is inside the splash zone.
      const matShelf = makeRockMaterial(ctx, A.tex, B.tex, {
        key: 'rock-shelf',
        base: C(0.532, 0.426, 0.120),
        bright: C(0.700, 0.596, 0.232),
        grime: C(0.086, 0.060, 0.026),
        stain: C(0.158, 0.082, 0.022),
        damp: C(0.062, 0.049, 0.027),
        algae: C(0.048, 0.056, 0.022),
        moss: C(0.036, 0.068, 0.020),
        lichen: C(0.300, 0.285, 0.105),
        bleach: C(0.720, 0.545, 0.235),
        rough: 0.82, algaeAmt: 1.15, mossAmt: 0.8, detail: 0.72, macro: 1.15,
        // The whole slab sits inside the wet band, so at full strength the sheen term
        // turned a 56 x 14 m near-flat plate into chrome foil at grazing incidence.
        wetAmt: 0.35, specF0: 0.020, specF90: 0.16,
      });
      materials.push(matRock, matBoulder, matFar, matShelf);

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
        const mesh = addMesh(geo, matShelf, 'tidepool_shelf', true);
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
            prof: [[0, 1.14], [0.15, 1.10], [0.42, 1.04], [0.70, 1.00], [0.90, 0.97], [1.0, 0.87]],
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
            colliders.push({ type: 'sphere', tag: 'boulder', center: p, radius: Math.max(s.x, s.z) * 0.85 });
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

    /**
     * Live tuning + diagnostics. `tools/capture.mjs --config k=v` pokes ctx.config
     * *after* boot, so anything a measurement needs to A/B has to be read per frame
     * rather than baked into the uniform at init.
     *
     *   rockDbg=1        albedo forced to black — everything left is indirect specular
     *   rockDbg=2        albedo forced to 0.18 grey
     *   rockSpecF90      grazing Fresnel of the dry rock (shipped 0.13)
     *   rockSpecOcc      0 disables cavity specular occlusion
     *   rockHex          0 disables hex tile-breaking on the two coarse octaves
     *   rockDetail       global detail-normal amplitude
     */
    update(dt, ctx) {
      const c = ctx?.config;
      if (!c) return;
      for (const m of materials) {
        const u = m.userData.rockUniforms;
        if (!u) continue;
        u.uDbg.value = +(c.rockDbg ?? 0);
        if (c.rockSpecF90 !== undefined) u.uSpecF90.value = +c.rockSpecF90;
        if (c.rockSpecOcc !== undefined) u.uSpecOccAmt.value = +c.rockSpecOcc;
        if (c.rockHex !== undefined) u.uHexAmt.value = +c.rockHex;
        if (c.rockDetail !== undefined) u.uDetailAmt.value = +c.rockDetail;
      }
    },
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
