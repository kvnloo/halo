import * as THREE from 'three';
import { NOISE_GLSL } from '../gfx/glsl/noise.js';
import { LAYER, fsMaterial, FullScreenQuad, makeRT } from '../render/RenderPipeline.js';
import { sharedAerialUniforms } from '../gfx/materialCommon.js';

/**
 * `ocean` — water surface, shoaling swell, refraction, reflection, foam and caustics.
 *
 * The measured target for the `water` region is lap_var 677 / edge_density 0.109, and
 * on the two frames where water actually fills the crop (kf_01800) it is lap_var 1376 /
 * edge 0.197 — the highest-frequency thing in the entire reference. A smooth gradient
 * plane lands near 60. Everything below exists to put real, physically-shaped structure
 * at every spatial scale from 28 m down to a pixel, without adding broadband noise
 * (which would raise lap_var while dragging spectral_slope the wrong way).
 *
 * Where the energy actually comes from, in order of contribution:
 *
 *  1. REFLECTION MODULATED BY WAVE SLOPE. At eye height 1.7 m almost the whole water
 *     surface is seen within a few degrees of grazing, so Fresnel is ~0.9 and the pixel
 *     is *the reflection*. A wave facet tilting by ±8 deg swings the reflected ray
 *     across 16 deg of sky — from bright horizon haze to deep zenith blue, or below the
 *     horizon onto a dark sea stack. That is a huge radiance swing driven by a tiny
 *     geometric change, and it is what produces the light/dark banding that fills
 *     kf_01800. So the reflection is sampled from the *rendered frame* (full-res, via
 *     `pipe.opaqueRT`) rather than from the 128 px sky cube: the cube cannot carry the
 *     ring, Threshold, the stacks or the beach, and those are exactly the high-contrast
 *     things whose reflections carry the detail.
 *
 *  2. SUN GLITTER as a real microfacet lobe whose roughness is the *filtered-out* wave
 *     slope variance (Toksvig / LEAN). Waves finer than a pixel are removed from the
 *     normal and their slope variance is folded into roughness instead, which is both
 *     the correct anti-aliasing and the thing that turns a single mirror highlight into
 *     the broad broken glitter track the reference has.
 *
 *  3. REFRACTED, ABSORBED, CAUSTIC-LIT SEAFLOOR. Beer-Lambert with per-channel
 *     extinction over the true water-column path (from the depth buffer), so the same
 *     shader goes clear at the swash, turquoise over the sandbar and deep blue offshore
 *     without a single hand-painted gradient.
 *
 *  4. FOAM from an advected Eulerian field: crests break where depth-limited amplitude
 *     clipping kicks in, foam is injected there and at rock waterlines, then decays and
 *     drifts. The field carries only the envelope; the lace and bubble structure is a
 *     procedural overlay evaluated at render time, which is the right split — a 0.6 m
 *     texel cannot hold a bubble but it can hold "there is foam here".
 *
 * ## Shoaling
 *
 * Waves are Gerstner trochoids, but every one of them is re-solved against the local
 * still-water depth each frame:
 *   - wavenumber from the Fenton & McKee explicit approximation to the dispersion
 *     relation, so wavelength shortens in shallow water,
 *   - amplitude by Green's shoaling coefficient sqrt(cg0/cg), so it grows,
 *   - clipped by the depth-limited breaker criterion H <= 0.78 h and by the Miche
 *     steepness limit H <= L/7,
 *   - phase skewed by `theta += s*sin(theta)` with s growing as it shoals, which is
 *     what turns a sine into a pitched front with a steep face and a long flat back.
 * The amount of amplitude the clip removed *is* the breaking intensity, and that drives
 * the foam source. This is why the breaker line lands on a contour of the bathymetry
 * rather than on a hand-placed spline: it falls out of the depth field.
 *
 * ## Bathymetry
 *
 * Depth has to be available per-pixel on the GPU, but `terrain` owns the heightfield
 * and modules may not import each other. So at init the module samples
 * `terrain.height()` over the near-shore rectangle into a float texture, once. If
 * `terrain` has not landed yet it falls back to an analytic profile fitted to the
 * cross-section table in docs/WORLD.md, so the ocean is judgeable in isolation and
 * snaps to the real seabed the moment terrain exists.
 *
 * ## Coherence
 *
 * Water is not an opaque world surface, so it does not go through `applyWorldMaterial`
 * (it needs its own refraction/reflection/Fresnel composition rather than three's
 * lighting model). It does alias `sharedAerialUniforms()` and apply the identical
 * height-fog in-scatter integral, so the horizon dissolves at exactly the same rate as
 * terrain and rock. Sun direction, colour and intensity all come from `time`; the sky
 * term comes from `sky`.
 */

/* ------------------------------------------------------------------ constants */

const SEA_LEVEL = 0.0;
const G = 9.81;

/**
 * Displaced Gerstner bands. dirDeg is measured from +Z (shoreward) toward +X.
 *
 * The directional spread is deliberately narrow (±24 deg) for the swell. A wide
 * spread makes a confused, isotropic sea; the reference is a long-crested swell whose
 * crests run almost exactly parallel to the beach (kf_01800 shows eight or nine
 * near-parallel crests across 20 m of shallows), which is what refraction over a
 * shore-parallel bathymetry does to any incoming swell. The chop above it keeps a
 * wide spread because that is genuinely wind-driven and short-crested.
 *
 * Total mean-square slope over both tables is 0.030, which is the Cox-Munk value for
 * the 5.4 m/s wind `time` reports. That number matters: it sets how far the reflected
 * ray wanders across the sky gradient, and therefore how much contrast the surface has.
 */
const WAVE_BANDS = [
  // wavelength(m), amplitude(m), dirDeg, steepness
  { L: 28.0, A: 0.340, dir: -5, Q: 0.74 },
  { L: 19.0, A: 0.225, dir: 9, Q: 0.72 },
  { L: 13.0, A: 0.152, dir: -14, Q: 0.68 },
  { L: 8.60, A: 0.104, dir: 17, Q: 0.64 },
  { L: 5.50, A: 0.068, dir: -21, Q: 0.58 },
  { L: 3.60, A: 0.043, dir: 24, Q: 0.52 },
  { L: 2.40, A: 0.028, dir: -33, Q: 0.46 },
  { L: 1.60, A: 0.0185, dir: 41, Q: 0.40 },
];
const NW = WAVE_BANDS.length;

/** Normal-only bands, evaluated per pixel. Too fine to tessellate, too coarse to
 *  hide in a texture — this is the band that carries the visible chop. */
const CHOP_BANDS = [
  { L: 1.90, A: 0.0132, dir: 62 },
  { L: 1.25, A: 0.0089, dir: -78 },
  { L: 0.82, A: 0.0059, dir: 96 },
  { L: 0.54, A: 0.0039, dir: -117 },
  { L: 0.35, A: 0.00255, dir: 139 },
  { L: 0.22, A: 0.00165, dir: -158 },
  { L: 0.145, A: 0.00108, dir: 173 },
];
const NC = CHOP_BANDS.length;

/** Sea-stack waterlines, used as foam/spray sources. Preferred source is
 *  `rocks.landmarks`; this table (from docs/WORLD.md) is the fallback so the surf
 *  still breaks on the stacks when `rocks` has not landed. */
const FALLBACK_LANDMARKS = [
  { x: -38, z: -92, r: 15 },
  { x: 34, z: -70, r: 17 },
  { x: -96, z: -140, r: 19 },
  { x: -128, z: -172, r: 13 },
  { x: 120, z: -210, r: 16 },
  { x: 156, z: -246, r: 12 },
  { x: 108, z: 20, r: 40 },
];
const MAX_LANDMARKS = 8;

/** Bathymetry / foam domain. Covers every camera pose plus the sea stacks. */
const DOM = { x0: -340, x1: 340, z0: -330, z1: 60 };
const BATHY_W = 768, BATHY_H = 768;
const FOAM_W = 1024, FOAM_H = 512;
const DEEP_Y = -34.0;

/* ------------------------------------------------- analytic fallback bathymetry */

/** docs/WORLD.md cross-section at X = 0. */
const PROFILE_Z = [-340, -180, -70, -26, -6.5, 0, 9, 22, 38, 48, 58, 72, 120];
const PROFILE_Y = [-26, -11.0, -4.2, -1.15, 0.0, 0.35, 1.30, 2.75, 5.40, 9.0, 26, 58, 92];

/** Monotone cubic (Fritsch-Carlson) through the table: a piecewise-linear seabed puts
 *  a slope discontinuity into the absorption term, which reads as a hard band in the
 *  water colour. */
const PROFILE_M = (() => {
  const n = PROFILE_Z.length, d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (PROFILE_Y[i + 1] - PROFILE_Y[i]) / (PROFILE_Z[i + 1] - PROFILE_Z[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) * 0.5;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return m;
})();

function profileY(z) {
  const n = PROFILE_Z.length;
  if (z <= PROFILE_Z[0]) return PROFILE_Y[0] + (z - PROFILE_Z[0]) * 0.09;
  if (z >= PROFILE_Z[n - 1]) return PROFILE_Y[n - 1] + (z - PROFILE_Z[n - 1]) * 0.55;
  let i = 0;
  while (i < n - 2 && z > PROFILE_Z[i + 1]) i++;
  const h = PROFILE_Z[i + 1] - PROFILE_Z[i], t = (z - PROFILE_Z[i]) / h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * PROFILE_Y[i] + (t3 - 2 * t2 + t) * h * PROFILE_M[i]
       + (-2 * t3 + 3 * t2) * PROFILE_Y[i + 1] + (t3 - t2) * h * PROFILE_M[i + 1];
}

/* cheap deterministic value noise for the fallback seabed (CPU only) */
function h2(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1;
}
function vn2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}
function fbmCpu(x, y, oct) {
  let s = 0, a = 0.5, n = 0, fx = x, fy = y;
  for (let i = 0; i < oct; i++) { s += a * vn2(fx, fy); n += a; fx *= 2.03; fy *= 2.01; a *= 0.5; }
  return s / n;
}

/**
 * Analytic seabed used only until `terrain` lands. Follows docs/WORLD.md: the beach is
 * widest near X = -20 and pinches against the headland at X = +95, and there is a
 * sandbar at Z ~ -26 (the "pale turquoise, caustics visible" line in the table).
 */
function fallbackSeabed(x, z) {
  // shoreline excursion along X: positive pushes the waterline seaward
  // The table is authoritative AT X = 0, so the modulation is anchored to zero there.
  let zOff = 4.5 * Math.exp(-Math.pow((x + 20) / 45, 2)) - 2.4
           - 26.0 * smooth01((x - 38) / 66)
           + 3.2 * fbmCpu(x / 78 + 11.3, 0.5, 3)
           + 1.1 * fbmCpu(x / 19 + 41.7, 3.5, 2);
  const ze = z + zOff;
  let y = profileY(ze);
  if (ze < -2) {
    // sandbar crest, and general seabed relief
    const bar = 0.55 * Math.exp(-Math.pow((ze + 26) / 13, 2)) * (0.72 + 0.5 * fbmCpu(x / 55 + 7.1, 1.3, 2));
    const relief = 0.13 * fbmCpu(x / 34 + 3.3, ze / 34 + 9.1, 3)
                 + 0.055 * fbmCpu(x / 9.5 + 13.3, ze / 9.5 + 19.1, 3);
    y += bar + relief * Math.min(1, -ze / 6);
  } else {
    y += 0.05 * fbmCpu(x / 11 + 21.3, ze / 11 + 5.1, 3);
  }
  return y;
}
function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

/* ------------------------------------------------------------------ shared GLSL */

/** Bathymetry lookup + the shoaling wave model. Shared verbatim by the water vertex
 *  shader, the water fragment shader and the foam simulation, so all three agree
 *  about where a wave breaks. */
const OCEAN_COMMON = /* glsl */`
#define NW ${NW}
#define NC ${NC}
const float OC_G = 9.81;
const float OC_TAU = 6.283185307;

uniform vec4 uWaveA[NW];    // dir.x, dir.z, amplitude0, wavelength0
uniform vec4 uWaveB[NW];    // omega, steepness, phase, 1/wavelength0
uniform vec4 uChop[NC];     // dir.x, dir.z, amplitude0, wavelength0
uniform float uSeaLevel;
uniform float uTime;
uniform vec2  uWind;
uniform float uWaveScale;

uniform sampler2D tBathy;
uniform vec4 uBathyRect;    // x0, z0, 1/(x1-x0), 1/(z1-z0)
uniform float uBathyDeep;

/** Seabed elevation in metres. Outside the sampled rectangle the floor keeps falling
 *  away seaward (so the shoaling model does not mistake the open ocean for a sandbar)
 *  and clamps to the land profile inland. */
float oc_seabedY(vec2 p){
  vec2 uv = (p - uBathyRect.xy) * uBathyRect.zw;
  float y = texture(tBathy, clamp(uv, vec2(0.0008), vec2(0.9992))).r;
  float seaward = clamp(-uv.y * 5.0, 0.0, 1.0);
  return mix(y, min(y, uBathyDeep), seaward);
}
float oc_depth(vec2 p){ return max(uSeaLevel - oc_seabedY(p), 0.0); }

/* ---------------------------------------------------------------- shoaling ---- */
/** Everything a shoaled wave needs at one point: wavenumber, amplitude after the
 *  breaker clip, phase skew, and how much amplitude the clip removed (= breaking). */
struct OcWave { float k; float A; float Q; float skew; float brk; };

OcWave oc_wave(int i, float h){
  OcWave w;
  vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
  float k0 = OC_TAU * b.w;
  float he = max(h, 0.22);
  float k0h = k0 * he;
  float k = k0, Ks = 1.0, kh = k0h;

  if (k0h < 3.0){
    // Fenton & McKee: kh = k0h * coth((k0h)^(3/4))^(2/3). One pow and one tanh, and
    // it is within 1.7% of the exact dispersion root over the whole range.
    float x = pow(max(k0h, 1e-4), 0.75);
    kh = max(k0h * pow(1.0 / max(tanh(x), 1e-4), 0.6666667), 1e-3);
    k = min(kh / he, k0 * 5.0);
    kh = k * he;
    // Green's law: Ks = sqrt(cg0/cg), cg = n*c
    float s2 = sinh(min(2.0 * kh, 11.0));
    float n  = 0.5 * (1.0 + 2.0 * kh / max(s2, 1e-3));
    float c  = sqrt(OC_G * tanh(min(kh, 11.0)) / max(k, 1e-4));
    float c0 = sqrt(OC_G / max(k0, 1e-4));
    Ks = sqrt(clamp(0.5 * c0 / max(n * c, 1e-4), 0.3, 3.2));
  }

  float A0 = a.z * uWaveScale;
  float A  = A0 * Ks;
  // depth-limited breaking (H <= 0.78h) and the Miche steepness limit (H <= L/7)
  float Amax = min(0.39 * h, OC_TAU / (k * 14.0));
  float Ac   = min(A, Amax);
  w.brk = clamp((A - Ac) / max(A, 1e-4), 0.0, 1.0);
  w.A = Ac;
  w.k = k;
  // steepness ramps with shoaling; hard-clamped so the trochoid never self-intersects
  w.Q = min(b.y * (1.0 + 2.1 * w.brk + 1.3 * clamp(Ks - 1.0, 0.0, 1.5)), 0.92 / max(w.k * w.A * float(NW) * 0.30, 1e-3));
  // sawtooth the phase: steep front face, long flat back — a pitched breaker, not a sine
  w.skew = clamp(0.85 * w.brk + 0.45 * clamp(Ks - 1.0, 0.0, 1.0), 0.0, 0.95);
  return w;
}

/* ------------------------------------------------------------------- swash ---- */
/** Run-up. The depth-limited clip drives every wave to zero amplitude exactly at the
 *  still waterline, so on its own the beach would never get wet. Hunt's formula for
 *  this slope (tan b ~ 0.084, H 0.7 m, L0 28 m) gives an Iribarren number of 0.53 and
 *  a vertical run-up of ~0.37 m, i.e. a ~4-6 m horizontal excursion. This is that
 *  surge: a shore-normal bore that raises the water level over the last couple of
 *  metres of depth, asymmetric in time (fast rush up, slow drain). */
float oc_swashPhase(vec2 p){
  return -p.y * 0.216 - uTime * 1.487 + sin(p.x * 0.0135) * 1.1 + sin(p.x * 0.0455 + 2.3) * 0.55;
}
float oc_swash(vec2 p, float h, out float front){
  float ph = oc_swashPhase(p);
  float s = sin(ph);
  // asymmetric: uprush occupies ~1/3 of the cycle
  float up = pow(clamp(s * 0.5 + 0.5, 0.0, 1.0), 0.55);
  float shore = smoothstep(2.6, 0.0, h);
  front = clamp(cos(ph), 0.0, 1.0) * shore;
  return (up - 0.42) * 0.62 * shore;
}

/* ------------------------------------------------------------- displacement --- */
/** Full displaced surface. Returns world position; tx/tz accumulate dP/dx, dP/dz. */
vec3 oc_surface(vec2 p, float h, float lodAmp, out vec3 tx, out vec3 tz, out float brk, out float crest){
  vec3 P = vec3(p.x, uSeaLevel, p.y);
  tx = vec3(1.0, 0.0, 0.0);
  tz = vec3(0.0, 0.0, 1.0);
  brk = 0.0; crest = 0.0;
  for (int i = 0; i < NW; i++){
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    OcWave w = oc_wave(i, h);
    float A = w.A * lodAmp;
    if (A < 1.0e-4) continue;
    vec2 D = a.xy;
    float th = w.k * dot(D, p) - b.x * uTime + b.z;
    float sk = sin(th);
    float thS = th + w.skew * sk;
    float dth = 1.0 + w.skew * cos(th);           // d(thS)/d(th)
    float st = sin(thS), ct = cos(thS);
    P.y  += A * ct;
    P.xz -= D * (w.Q * A * st);
    float kA = w.k * A * dth;
    // dP/dx and dP/dz of the trochoid
    tx.x -= w.Q * kA * D.x * D.x * ct;
    tx.z -= w.Q * kA * D.x * D.y * ct;
    tx.y -= kA * D.x * st;
    tz.x -= w.Q * kA * D.y * D.x * ct;
    tz.z -= w.Q * kA * D.y * D.y * ct;
    tz.y -= kA * D.y * st;
    // Crest indicator, and breaking confined to a narrow window around the crest.
    // A wave aerates as it pitches forward, not over its whole profile: without this
    // window the depth-limited clip (which is nonzero everywhere inside the surf zone)
    // fills the entire bay with foam instead of drawing a breaker line.
    float c01 = ct * 0.5 + 0.5;
    crest += c01 * A;
    brk = max(brk, w.brk * smoothstep(0.55, 0.95, c01) * step(0.02, A));
  }
  float front;
  float sw = oc_swash(p, h, front);
  P.y += sw * lodAmp;
  brk = max(brk, front * smoothstep(1.2, 0.10, h) * 0.72);
  return P;
}
`;

/* ------------------------------------------------------------ detail normal map */

const DETAIL_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
${NOISE_GLSL}

/* Tiling gradient noise: the shared library's gnoise2 does not wrap, and a detail map
 * that does not tile shows its seam every 1.6 m across the whole bay. Same hash, same
 * quintic interpolant, lattice indices taken modulo the period. */
vec2 thash2(vec2 i, float per){ return hash22(mod(i, vec2(per)) + 0.137); }
float tgrad(vec2 p, float per){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 ga = normalize(thash2(i+vec2(0,0), per)*2.0-1.0);
  vec2 gb = normalize(thash2(i+vec2(1,0), per)*2.0-1.0);
  vec2 gc = normalize(thash2(i+vec2(0,1), per)*2.0-1.0);
  vec2 gd = normalize(thash2(i+vec2(1,1), per)*2.0-1.0);
  return mix(mix(dot(ga,f-vec2(0,0)), dot(gb,f-vec2(1,0)), u.x),
             mix(dot(gc,f-vec2(0,1)), dot(gd,f-vec2(1,1)), u.x), u.y) * 1.4142;
}
float tfbm(vec2 p, float per, int oct){
  float a = 0.5, s = 0.0, n = 0.0, pr = per;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * tgrad(p * (pr/per) , pr);
    n += a; pr *= 2.0; a *= 0.55;
  }
  return s / max(n, 1e-4);
}

/** Capillary skin. Real wind chop is anisotropic: long crests across the wind, short
 *  along it, plus a cellular capillary pattern riding the larger ripples. */
float surfH(vec2 uv){
  float P = 8.0;
  vec2 q = uv * P;
  float w = tfbm(vec2(q.x * 0.55, q.y * 1.0), P, 3);
  float h = 0.0;
  h += 0.55 * tfbm(vec2(q.x * 1.0, q.y * 2.6) + w * 0.65, P, 4);
  h += 0.30 * tfbm(vec2(q.x * 2.7, q.y * 1.1) - w * 0.40, P * 2.0, 4);
  h += 0.22 * (worley3Tiled(vec3(uv * 1.0, 0.31), 14.0) - 0.55);
  h += 0.13 * (worley3Tiled(vec3(uv * 1.0, 5.70), 27.0) - 0.55);
  return h;
}

void main(){
  float e = 1.0 / 512.0;
  float c  = surfH(vUv);
  float hx = surfH(vUv + vec2(e, 0.0));
  float hy = surfH(vUv + vec2(0.0, e));
  // A raw d(height)/d(uv) runs to several hundred and clipped this map to solid white
  // in an 8-bit target. Store a unit normal instead and let the shader read the slope
  // back as n.xy/n.z, which is scale-free and cannot saturate.
  vec2 g = vec2(hx - c, hy - c) / e * 0.0022;
  vec3 n = normalize(vec3(-g, 1.0));
  oCol = vec4(n * 0.5 + 0.5, c * 0.5 + 0.5);
}
`;

/* ---------------------------------------------------------------- foam sim pass */

const FOAM_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
${NOISE_GLSL}
${OCEAN_COMMON}

uniform sampler2D tPrev;
uniform float uDt;
uniform vec4 uFoamRect;     // x0, z0, (x1-x0), (z1-z0)
uniform vec4 uLandmarks[${MAX_LANDMARKS}];   // x, z, radius, active
uniform float uFoamDecay;
uniform float uFoamGain;

void main(){
  vec2 p = uFoamRect.xy + vUv * uFoamRect.zw;
  float h = oc_depth(p);

  /* --- advect ------------------------------------------------------------------
   * Semi-Lagrangian, one bilinear tap. The velocity is the Stokes drift of the swell
   * (shoreward, growing as it shoals) plus a slice of the wind. The field only has to
   * carry the low-frequency envelope — the lace and bubbles are procedural at render
   * time — so the numerical diffusion of a sub-texel step is not merely tolerable, it
   * is doing useful work (dispersing foam is what foam does). */
  float shoal = smoothstep(9.0, 0.4, h);
  vec2 vel = vec2(0.0, 1.0) * (0.55 + 2.35 * shoal) + uWind * 0.045;
  vec2 prevUv = vUv - vel * uDt / uFoamRect.zw;
  vec4 prev = texture(tPrev, clamp(prevUv, vec2(0.0), vec2(1.0)));

  float foam = prev.r;
  float wet  = prev.g;

  /* --- decay ------------------------------------------------------------------- */
  // deep-water foam dissipates fast; foam sitting in the swash lingers
  // Foam has to die faster than the wave period or successive breakers merge into one
  // continuous sheet — which is exactly what happened at tau = 2.6 s against a 4.2 s
  // swell. At 1.5 s each breaker leaves a separate band with clear water between.
  float tau = mix(0.65, 1.55, shoal);
  foam *= exp(-uDt / tau);
  wet  *= exp(-uDt / 7.5);

  /* --- inject: breaking crests --------------------------------------------------
   * brk is how much amplitude the depth-limited clip removed. That is nonzero over
   * the whole surf zone, but a wave only *aerates* right at the crest as it pitches,
   * so the source is raised to a power: the difference between a plausible breaker
   * line and a bay filled with milk. */
  vec3 tx, tz; float brk, crest;
  vec3 S = oc_surface(p, h, 1.0, tx, tz, brk, crest);
  foam += pow(brk, 3.0) * uFoamGain * uDt * 1.75;

  /* --- inject: the swash sheet -------------------------------------------------- */
  float col = S.y - oc_seabedY(p);
  float sheet = smoothstep(0.16, 0.012, col) * step(0.0, col);
  foam += sheet * uDt * 0.55;
  wet   = max(wet, step(0.005, col));

  /* --- inject: waves hitting rock ------------------------------------------------
   * A stack standing in 3 m of water throws the whole incident wave straight up. The
   * source is a ring at the waterline whose strength follows the swell phase, so the
   * spray pulses rather than sitting there. */
  for (int i = 0; i < ${MAX_LANDMARKS}; i++){
    vec4 lm = uLandmarks[i];
    if (lm.w < 0.5) continue;
    float d = length(p - lm.xy) - lm.z;
    if (d > 9.0 || d < -6.0) continue;
    float ring = exp(-max(d, 0.0) * 0.85) * smoothstep(-2.5, 0.6, d);
    float pulse = pow(clamp(crest * 2.6, 0.0, 1.0), 2.0);
    foam += ring * (0.15 + 0.85 * pulse) * uDt * 1.25 * smoothstep(0.2, 2.5, h);
  }

  oCol = vec4(clamp(foam, 0.0, 1.0), clamp(wet, 0.0, 1.0), 0.0, 1.0);
}
`;

/* ------------------------------------------------------------ depth resolve ---- */

/**
 * `pipe.depthTex` is attached to `pipe.sceneRT`, which is the framebuffer the water is
 * drawn into, so sampling it from the water shader is a rendering feedback loop and
 * WebGL2 drops the draw call entirely (`GL_INVALID_OPERATION: Feedback loop formed
 * between Framebuffer and active Texture` — verified, the water simply did not appear).
 * Turning depth writes off is not enough; ANGLE rejects the read on the attachment
 * alone. So the depth is resolved into a target of our own immediately before the
 * water draw, which is the same thing three's own Reflector/Refractor do from
 * `onBeforeRender`, and the water samples that copy.
 */
const DEPTH_COPY_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tDepth;
out vec4 oCol;
void main(){ oCol = vec4(texture(tDepth, vUv).r, 0.0, 0.0, 1.0); }
`;

/* --------------------------------------------------------------- water material */

const WATER_VERT = /* glsl */`
precision highp float;
precision highp sampler2D;

in vec3 position;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCamPos;
uniform float uLodStart;
uniform float uLodEnd;

${NOISE_GLSL}
${OCEAN_COMMON}

out vec3 vWorld;
out vec2 vFlat;
out vec3 vTx;
out vec3 vTz;
out float vBrk;
out float vCrest;
out float vDepth;
out float vLod;

void main(){
  vec2 p = (modelMatrix * vec4(position, 1.0)).xz;

  // Beyond ~1 km the mesh is coarser than the shortest displaced band, so displacing
  // it only manufactures aliasing. Fade the geometry out and let the flat plane plus
  // the filtered normal carry the distance — which is exactly what the reference's
  // distant water is: a smooth pale band.
  float d = length(p - uCamPos.xz);
  float lod = 1.0 - smoothstep(uLodStart, uLodEnd, d);
  vLod = lod;

  float h = oc_depth(p);
  vDepth = h;

  vec3 tx, tz; float brk, crest;
  vec3 P = oc_surface(p, h, lod, tx, tz, brk, crest);

  vWorld = P;
  vFlat = p;
  vTx = tx; vTz = tz;
  vBrk = brk; vCrest = crest;

  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;

const WATER_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp samplerCube;

in vec3 vWorld;
in vec2 vFlat;
in vec3 vTx;
in vec3 vTz;
in float vBrk;
in float vCrest;
in float vDepth;
in float vLod;

layout(location = 0) out vec4 oCol;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProj;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec2 uInvRes;

uniform sampler2D tOpaque;
uniform sampler2D tDepth;
uniform sampler2D tDetail;
uniform sampler2D tFoam;
uniform samplerCube tSky;
uniform sampler2D tClouds;
uniform float uUseClouds;
uniform vec4 uFoamRect;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyAmbient;
uniform vec3 uHorizonColor;
uniform float uUseSSR;

uniform vec3 uExtinction;
uniform vec3 uScatterCol;
uniform float uFoamAmount;
uniform float uGlitter;
uniform float uCausticAmount;
uniform float uDetailAmount;

/* Aerial perspective — the exact model and the exact uniform block from
 * src/gfx/materialCommon.js (aliased, not copied: sharedAerialUniforms() hands back
 * the same objects lighting refreshes each frame). Water is not an opaque world
 * surface so it cannot go through applyWorldMaterial, but it must dissolve into the
 * horizon at precisely the same rate as the rock standing in it. */
uniform vec3  uAerialSunDir;
uniform vec3  uAerialSunColor;
uniform vec3  uAerialSkyColor;
uniform vec3  uAerialGroundColor;
uniform float uAerialDensity;
uniform float uAerialHeightFalloff;
uniform float uAerialSunAmount;
uniform float uAerialStart;

${NOISE_GLSL}
${OCEAN_COMMON}

float wmHG(float c, float g){
  float g2 = g*g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5));
}
vec3 wmAerial(vec3 color, vec3 worldPos, vec3 camPos){
  vec3 v = worldPos - camPos;
  float dist = length(v);
  if (dist < uAerialStart) return color;
  v /= max(dist, 1e-4);
  float hf = uAerialHeightFalloff;
  float c0 = uAerialDensity * exp(-hf * max(camPos.y, 0.0));
  float fy = hf * v.y;
  float integral = abs(fy) > 1e-4
      ? c0 * (1.0 - exp(-fy * (dist - uAerialStart))) / fy
      : c0 * (dist - uAerialStart);
  float t = 1.0 - exp(-integral);
  float cosT = dot(v, uAerialSunDir);
  float phase = mix(0.42, wmHG(cosT, 0.76) * 2.6, uAerialSunAmount);
  vec3 inscatter = mix(uAerialGroundColor, uAerialSkyColor, clamp(v.y * 0.5 + 0.5, 0.0, 1.0));
  inscatter += uAerialSunColor * phase * uAerialSunAmount;
  return mix(color, inscatter, clamp(t, 0.0, 1.0));
}

/* ------------------------------------------------------------------ depth utils */
vec3 worldFromDepth(vec2 uv, float d){
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  return w.xyz / w.w;
}
float viewZ(vec3 wp){ return -(viewMatrix * vec4(wp, 1.0)).z; }

/* ------------------------------------------------------------------- caustics */
/** Voronoi *edges*, not cells: a caustic is the fold of the wavefront, so it is a
 *  bright network of lines. Two counter-drifting layers, sharpened, with a per-channel
 *  spatial offset for the dispersion fringe. */
float causticNet(vec2 q, float t){
  vec2 f1 = worley2(q + vec2(t * 0.052, -t * 0.041));
  vec2 f2 = worley2(q * 1.87 + vec2(-t * 0.083, t * 0.067) + 31.7);
  float a = pow(1.0 - clamp(abs(f1.y - f1.x) * 1.55, 0.0, 1.0), 4.0);
  float b = pow(1.0 - clamp(abs(f2.y - f2.x) * 1.55, 0.0, 1.0), 5.0);
  return a + 0.55 * b;
}
vec3 caustics(vec2 p, float t, float depth){
  // Cell size scales with depth: the focal length of a wave lens is set by how far the
  // light travels below it. At 0.62 m^-1 the network read as a 1.6 m honeycomb, which
  // is the size of paving slabs, not of caustics in ankle-deep water.
  vec2 q = p * (2.6 / (0.42 + 0.55 * clamp(depth, 0.0, 4.0)));
  float e = 0.016;
  vec3 c = vec3(causticNet(q + vec2(e, 0.0), t), causticNet(q, t), causticNet(q - vec2(e, 0.0), t));
  // contrast collapses with depth as the focal caustic defocuses
  float k = exp(-depth * 0.42);
  return vec3(1.0) + (c - 0.40) * (0.95 * k * uCausticAmount);
}

/* ------------------------------------------------------------ detail normal map */
vec2 detailSlope(vec2 p, float tile, vec2 drift, float t){
  vec3 n = texture(tDetail, (p + drift * t) / tile).xyz * 2.0 - 1.0;
  return n.xy / max(n.z, 0.15);
}

/* ------------------------------------------------------------- fallback seabed */
/** Only used where the depth pre-pass found no geometry, i.e. terrain has not landed
 *  yet. Without it the water refracts the sky dome's grey ground hemisphere, which is
 *  bright and neutral and turns every shallow into milk — it hides exactly the Fresnel
 *  banding this shader exists to produce. Rippled sand at a plausible albedo. */
vec3 oc_fallbackBottom(vec2 p, float depth){
  float ripple = sin(p.y * 5.4 + fbm2(p * 0.22, 3) * 4.5) * 0.5 + 0.5;
  ripple = mix(ripple, sin(p.x * 0.9 + p.y * 3.1) * 0.5 + 0.5, 0.35);
  float cobble = 1.0 - worley2(p * 2.7).x;
  float grain = fbm2(p * 6.5 + 19.0, 3) * 0.5 + 0.5;
  float mottle = fbm2(p * 0.55 + 5.0, 4) * 0.5 + 0.5;
  vec3 sand = vec3(0.455, 0.372, 0.252);
  vec3 dark = vec3(0.155, 0.140, 0.108);
  vec3 c = mix(sand, dark, smoothstep(0.62, 0.93, cobble) * 0.75 * smoothstep(2.2, 0.2, depth));
  c *= 0.80 + 0.34 * ripple * smoothstep(4.5, 0.3, depth);
  c *= 0.86 + 0.30 * mottle;
  c *= 0.90 + 0.20 * grain;
  return c;
}

/* ================================================================= main ======= */
void main(){
  vec3 P = vWorld;
  vec3 toCam = uCamPos - P;
  float viewDist = length(toCam);
  vec3 V = toCam / max(viewDist, 1e-4);

  float bedY = oc_seabedY(vFlat);
  float column = P.y - bedY;
  if (column < -0.035) discard;

  /* ---- screen-space background ------------------------------------------------ */
  vec2 suv = gl_FragCoord.xy * uInvRes;
  vec3 bgRaw = texture(tOpaque, suv).rgb;
  float bgD = texture(tDepth, suv).r;
  bool bgIsSky = bgD >= 0.999995;
  vec3 bgPos = worldFromDepth(suv, bgD);

  /* ---- normal ------------------------------------------------------------------
   * The vertex stage supplies the displaced-band tangents. Everything from 1.9 m down
   * is added here, per pixel, with an explicit LOD: a band whose wavelength falls
   * under twice the pixel footprint is removed from the normal and its slope variance
   * is folded into roughness instead. That is the correct pre-filter (it is what turns
   * a mirror into a glitter track at distance) and it is the difference between
   * detail and shimmer. */
  vec3 tx = vTx, tz = vTz;
  float fp = max(length(vec2(dFdx(vFlat.x), dFdy(vFlat.x))),
                 length(vec2(dFdx(vFlat.y), dFdy(vFlat.y)))) + 1e-4;

  float h = vDepth;
  vec2 varLost = vec2(0.0);
  for (int i = 0; i < NC; i++){
    vec4 c = uChop[i];
    float L = c.w;
    float k0 = OC_TAU / L;
    float k = k0, Ks = 1.0;
    float he = max(h, 0.22);
    float k0h = k0 * he;
    if (k0h < 3.0){
      float x = pow(max(k0h, 1e-4), 0.75);
      float kh = max(k0h * pow(1.0 / max(tanh(x), 1e-4), 0.6666667), 1e-3);
      k = min(kh / he, k0 * 4.0);
      Ks = sqrt(clamp(pow(tanh(min(kh, 8.0)), -0.5), 0.4, 2.4));
    }
    float A = c.z * Ks * uWaveScale;
    float Ld = OC_TAU / k;
    float vis = smoothstep(0.95, 0.30, fp / Ld);
    float om = sqrt(OC_G * k * tanh(min(k * he, 10.0)));
    float th = k * dot(c.xy, vFlat) - om * uTime;
    float kA = k * A;
    if (vis > 0.002){
      tx.y -= vis * kA * c.x * sin(th);
      tz.y -= vis * kA * c.y * sin(th);
    }
    // slope variance of what was thrown away, projected on the two axes
    float lost = kA * kA * 0.5 * (1.0 - vis * vis);
    varLost += lost * vec2(c.x * c.x, c.y * c.y);
  }

  /* three scrolling detail scales for the sub-0.2 m skin */
  float dAmp = uDetailAmount * (0.55 + 0.45 * smoothstep(6.0, 0.6, h));
  vec2 w = uWind * 0.03;
  vec2 ds = vec2(0.0);
  float dv;
  dv = smoothstep(0.95, 0.30, fp / 0.42);
  if (dv > 0.002) ds += dv * 0.055 * dAmp * detailSlope(vFlat, 1.60, w + vec2(0.13, 0.34), uTime);
  dv = smoothstep(0.95, 0.30, fp / 0.14);
  if (dv > 0.002) ds += dv * 0.034 * dAmp * detailSlope(vFlat * 1.03 + 17.0, 0.52, w * 1.7 + vec2(-0.29, 0.21), uTime);
  dv = smoothstep(0.95, 0.30, fp / 0.045);
  if (dv > 0.002) ds += dv * 0.020 * dAmp * detailSlope(vFlat * 0.97 + 53.0, 0.17, w * 2.6 + vec2(0.41, -0.17), uTime);
  tx.y += ds.x; tz.y += ds.y;
  varLost += vec2(2.6e-4, 2.6e-4) * dAmp * dAmp
           * vec2(1.0 - smoothstep(0.95, 0.30, fp / 0.045));

  vec3 N = normalize(cross(tz, tx));
  // Only flip when we are genuinely looking at the underside. Flipping on
  // dot(N,V) < 0 instead would erase the steep near-face of every shoaling crest —
  // which is precisely where the Fresnel drops and the seabed shows through, i.e. the
  // dark band that gives the reference surface its contrast.
  if (!gl_FrontFacing) N = -N;

  /* filtered roughness: base + the slope variance we removed (Toksvig / LEAN) */
  float vX = varLost.x, vZ = varLost.y;
  float rough = clamp(sqrt(max(vX + vZ, 0.0) * 2.0) + 0.0075, 0.006, 0.62);
  float alphaX = clamp(sqrt(2.0 * vX) + 0.006, 0.005, 0.7);
  float alphaZ = clamp(sqrt(2.0 * vZ) + 0.006, 0.005, 0.7);

  /* ---- refraction + absorption -------------------------------------------------
   * Offset the background tap along the surface normal, scaled by how much water is
   * actually in front of the seabed and inversely by distance so the offset is a
   * roughly constant number of pixels. Per-channel offsets give the dispersion fringe
   * you see over cobbles in kf_01800. */
  vec3 Nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  float thick = clamp(column, 0.0, 3.0);
  float offScale = (0.055 + 0.30 * thick) / max(viewDist * 0.22, 1.0);
  vec2 roff = Nv.xy * offScale;
  vec3 refr;
  {
    vec2 u0 = clamp(suv + roff * 0.94, vec2(0.0015), vec2(0.9985));
    vec2 u1 = clamp(suv + roff * 1.00, vec2(0.0015), vec2(0.9985));
    vec2 u2 = clamp(suv + roff * 1.07, vec2(0.0015), vec2(0.9985));
    float dr = texture(tDepth, u1).r;
    // reject a tap that grabbed something in front of the water
    vec3 rp = worldFromDepth(u1, dr);
    float ok = step(rp.y, P.y + 0.06);
    refr = vec3(texture(tOpaque, mix(suv, u0, ok)).r,
                texture(tOpaque, mix(suv, u1, ok)).g,
                texture(tOpaque, mix(suv, u2, ok)).b);
    bgPos = mix(bgPos, rp, ok);
    bgIsSky = bgIsSky && (dr >= 0.999995);
  }

  /* Path length through the water column. Use the real geometry when the seabed is in
   * the depth buffer; fall back to the analytic bathymetry (and a synthetic sand
   * radiance) when terrain has not landed, so the ocean still reads as water rather
   * than as a mirror over nothing. */
  float pathView;
  float sunT = clamp(uSunDir.y, 0.15, 1.0);
  if (bgIsSky){
    // The view ray leaves the surface and travels down to the seabed; at grazing
    // incidence that is a long way through the water, which is exactly why distant
    // shallows still read as deep colour.
    vec3 vd = (P - uCamPos) / max(viewDist, 1e-4);
    pathView = min(column / max(-vd.y, 0.030), 55.0);
    bgPos = P + vd * min(pathView, 55.0);
    refr = oc_fallbackBottom(bgPos.xz, column)
         * (uSunColor * uSunIntensity * 0.105 * sunT + uSkyAmbient * 0.62);
  } else {
    pathView = min(max(distance(bgPos, P), column), 55.0);
  }
  float sunPath = min(column / clamp(uSunDir.y, 0.2, 1.0), 34.0);
  vec3 trans = exp(-uExtinction * pathView);
  vec3 transSun = exp(-uExtinction * sunPath);

  /* caustics ride on the seabed, so they belong on the refracted sample */
  if (uCausticAmount > 0.001 && column < 9.0){
    vec3 cst = caustics(bgPos.xz, uTime, column);
    refr *= mix(vec3(1.0), cst, smoothstep(9.0, 0.6, column) * clamp(uSunDir.y * 1.6, 0.0, 1.0));
  }

  float lightIn = clamp(uSunDir.y, 0.0, 1.0);
  vec3 inScatter = uScatterCol * (uSunColor * uSunIntensity * 0.048 * lightIn + uSkyAmbient * 0.75);
  // Downwelling light is part sun (attenuated over the slant path to the bed) and part
  // sky (which arrives from every direction, so it is attenuated far less).
  vec3 body = refr * trans * mix(vec3(1.0), transSun, 0.62)
            + inScatter * (vec3(1.0) - trans);

  /* ---- reflection ---------------------------------------------------------------
   * Base term: project the reflected direction as a point at infinity and read the
   * frame there. Because pipe.opaqueRT is a full-resolution snapshot taken after the
   * sky and before the transparent pass, that single tap returns the real sky — the
   * ring, Threshold, the cirrus veil — instead of the 128 px cube, which is worth an
   * enormous amount of the water's measured detail. Off-screen rays fall back to the
   * cube. A short depth march on top of that picks up the sea stacks and the beach. */
  vec3 R = reflect(-V, N);
  /* A facet steeper than the view depression sends the reflected ray *below* the
   * horizon, where it meets the sea again at grazing and comes back as a second,
   * dimmer reflection over the deep-water colour. Clamping those rays up instead
   * flattens the back of every crest into the same bright sky the front already
   * shows, and costs most of the surface's contrast. */
  float below = clamp(-R.y * 8.0, 0.0, 1.0);
  vec3 Rs = vec3(R.x, abs(R.y) + 0.002, R.z);
  vec3 refl = texture(tSky, Rs).rgb;
  {
    vec4 ci = uViewProj * vec4(Rs, 0.0);
    if (ci.w > 1e-6){
      vec2 uvi = (ci.xy / ci.w) * 0.5 + 0.5;
      vec2 e = min(uvi, 1.0 - uvi);
      float on = smoothstep(0.0, 0.035, min(e.x, e.y));
      if (on > 0.0 && texture(tDepth, clamp(uvi, vec2(0.002), vec2(0.998))).r >= 0.999995){
        vec2 uc = clamp(uvi, vec2(0.002), vec2(0.998));
        vec3 skyPix = texture(tOpaque, uc).rgb;
        // clouds composites in post, so opaqueRT has no cumulus in it. Its screen
        // buffer is indexed by view ray direction, and a reflected ray projected to
        // infinity lands on exactly the pixel whose ray direction it shares — so this
        // tap is the correct reflected cloud, not an approximation of one.
        if (uUseClouds > 0.5){
          vec4 cl = texture(tClouds, uc);
          skyPix = cl.rgb + skyPix * cl.a;
        }
        refl = mix(refl, skyPix, on);
      }
    }
  }
  vec3 deepBody = uScatterCol * (uSunColor * uSunIntensity * 0.048 * lightIn + uSkyAmbient * 0.75);
  refl = mix(refl, mix(deepBody, refl * 0.72, 0.55), below);
  if (uUseSSR > 0.5 && viewDist < 165.0 && R.y < 0.32){
    float t = 0.30, dt = 0.30;
    vec3 hitC = vec3(0.0); float hit = 0.0;
    for (int i = 0; i < 18; i++){
      t += dt; dt *= 1.42;
      vec3 q = P + R * t;
      vec4 cp = uViewProj * vec4(q, 1.0);
      if (cp.w <= 1e-5) break;
      vec2 uvq = (cp.xy / cp.w) * 0.5 + 0.5;
      if (uvq.x < 0.0 || uvq.x > 1.0 || uvq.y < 0.0 || uvq.y > 1.0) break;
      float dq = texture(tDepth, uvq).r;
      if (dq >= 0.999995) continue;
      vec3 sp = worldFromDepth(uvq, dq);
      float rz = viewZ(q), sz = viewZ(sp);
      if (rz > sz && (rz - sz) < dt * 3.4 + 0.6){
        // never reflect the seafloor: it is behind the mirror, not in front of it
        if (sp.y > uSeaLevel - 0.10){
          vec2 ee = min(uvq, 1.0 - uvq);
          hit = smoothstep(0.0, 0.06, min(ee.x, ee.y));
          hitC = texture(tOpaque, uvq).rgb;
        }
        break;
      }
    }
    refl = mix(refl, hitC, hit);
  }
  // rough water scatters the reflection toward the ambient
  refl = mix(refl, uHorizonColor, clamp(rough * 1.5, 0.0, 0.55));

  /* ---- Fresnel ------------------------------------------------------------------ */
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  F = mix(F, clamp(F * 1.05, 0.0, 1.0), 1.0);
  // a rough surface never reaches a perfect grazing mirror
  F *= mix(1.0, 0.82, clamp(rough * 2.2, 0.0, 1.0));

  /* ---- sun glitter -------------------------------------------------------------
   * Anisotropic GGX whose alphas are the sub-pixel slope variances computed above. The
   * lobe therefore widens with distance exactly as the resolved waves drop out, which
   * is what draws the broken highlight track instead of one blown mirror dot. */
  vec3 L = normalize(uSunDir);
  vec3 Hv = normalize(L + V);
  float ndl = clamp(dot(N, L), 0.0, 1.0);
  float ndh = clamp(dot(N, Hv), 0.0, 1.0);
  float vdh = clamp(dot(V, Hv), 0.0, 1.0);
  vec3 T0 = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
  vec3 B0 = cross(N, T0);
  float hx = dot(Hv, T0) / max(alphaX, 1e-3);
  float hz = dot(Hv, B0) / max(alphaZ, 1e-3);
  float dd = hx * hx + hz * hz + ndh * ndh;
  float D = 1.0 / (3.14159265 * alphaX * alphaZ * dd * dd + 1e-7);
  float k = rough * rough * 0.5;
  float Gv = 1.0 / ((ndv * (1.0 - k) + k) * (ndl * (1.0 - k) + k) + 1e-5);
  float Fs = 0.02 + 0.98 * pow(1.0 - vdh, 5.0);
  vec3 spec = uSunColor * uSunIntensity * (D * Gv * Fs * 0.25) * ndl * uGlitter;
  spec = min(spec, vec3(420.0));

  /* ---- sub-surface scattering in the crests -------------------------------------
   * A crest thin enough to be lit through glows green-teal on the shadow side. Driven
   * by the crest height from the vertex stage and by how much the wave is pitching. */
  float back = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  float thin = clamp(vCrest * 2.2, 0.0, 1.0) * smoothstep(0.0, 0.55, 1.0 - ndv);
  vec3 sss = vec3(0.075, 0.44, 0.36) * uSunColor * uSunIntensity
           * (back * thin * 0.085 + thin * 0.014 * clamp(uSunDir.y, 0.0, 1.0));
  sss *= smoothstep(0.0, 1.6, h);

  /* ---- compose the water -------------------------------------------------------- */
  vec3 col = mix(body, refl, clamp(F, 0.0, 1.0)) + spec + sss;

  /* ---- foam --------------------------------------------------------------------
   * The simulation supplies the envelope; the structure is procedural. Three layers:
   * a torn lace at the breaker, a fine bubble field in the swash, and a thin bright
   * leading edge where the sheet is thinnest. */
  vec2 fuv = (vFlat - uFoamRect.xy) / uFoamRect.zw;
  float env = 0.0, wet = 0.0;
  if (all(greaterThan(fuv, vec2(0.0))) && all(lessThan(fuv, vec2(1.0)))){
    vec2 fs = texture(tFoam, fuv).rg;
    env = fs.x; wet = fs.y;
  }
  env = max(env, pow(vBrk, 3.0) * 0.55);

  float foamCov = 0.0;
  vec3 foamCol = vec3(0.0);
  if (env > 0.02){
    vec2 fp2 = vFlat + vec2(0.0, uTime * 1.35) + N.xz * 0.6;
    float lace = 1.0 - worley2(fp2 * 1.15).x;
    float lv = smoothstep(0.90, 0.30, fp / 0.85);
    float bub = 1.0 - worley2(fp2 * 4.6 + 13.0).x;
    float bv = smoothstep(0.90, 0.30, fp / 0.24);
    float tex = mix(0.58, lace, lv * 0.92) * mix(1.0, 0.50 + 1.0 * bub, bv * 0.65);
    tex *= 0.66 + 0.62 * (fbm2(fp2 * 0.60 + 71.0, 3) * 0.5 + 0.5);
    // Dissolve the density field against the texture rather than scaling it: a moving
    // threshold makes foam grow by *filling in holes*, which is how real foam appears
    // and disappears. Scaling an alpha makes it fade like a painted decal instead.
    float thr = 1.06 - env * 1.18;
    foamCov = clamp(smoothstep(thr, thr + 0.30, tex), 0.0, 1.0);
    // foam is a bright rough dielectric: mostly sky, a little sun, and it is never
    // pure white — the reference's brightest swash sits around 215, not 255
    foamCol = (uSkyAmbient * 1.05 + uSunColor * uSunIntensity * 0.085 * clamp(uSunDir.y, 0.0, 1.0))
            * vec3(0.95, 0.975, 1.0);
    foamCol *= 0.60 + 0.55 * tex;
    foamCov *= uFoamAmount;
  }
  col = mix(col, foamCol, foamCov);

  /* thin-sheet sheen: the last centimetres before the sand shows through go glossy
   * rather than watery, which is the "mirror-ish wet sand" of the elevation table */
  float sheet = smoothstep(0.22, 0.0, column);
  col = mix(col, mix(body, refl, clamp(F * 1.12, 0.0, 1.0)) + spec * 0.55, sheet * 0.55);

  col = wmAerial(col, P, uCamPos);

  /* ---- coverage: soft edge instead of a polygon silhouette --------------------- */
  float cov = smoothstep(-0.004, 0.055, column);
  col = mix(bgRaw, col, cov);

  oCol = vec4(max(col, vec3(0.0)), 1.0);
}
`;

/* =============================================================== the module === */

export function create(opts = {}) {
  /* --- CPU-side mirrors of the wave model (physics, particles, AI) --- */
  const waveDir = WAVE_BANDS.map((b) => {
    const a = THREE.MathUtils.degToRad(b.dir);
    return [Math.sin(a), Math.cos(a)];
  });
  const waveK = WAVE_BANDS.map((b) => (2 * Math.PI) / b.L);
  const waveOmega = waveK.map((k) => Math.sqrt(G * k));
  const wavePhase = WAVE_BANDS.map((_, i) => i * 2.399963229728653);

  let ctxRef = null;
  let bathyTex = null, bathyData = null;
  let foamA = null, foamB = null, foamMat = null, foamQuad = null;
  let detailRT = null;
  let depthRT = null, depthMat = null, depthQuad = null;
  let geom = null, mesh = null, mat = null;
  let uniforms = null;
  let landmarkArr = null;
  let lastT = -1e9;
  let primed = false;
  let waveScale = 1.0;
  let cost = { foamMs: 0 };

  const _v3 = new THREE.Vector3();
  const _c1 = new THREE.Color();
  const _c2 = new THREE.Color();

  /* ---------------------------------------------------------------- CPU queries */

  function seabedCpu(x, z) {
    const terrain = ctxRef && ctxRef.get ? ctxRef.get('terrain') : null;
    if (terrain && typeof terrain.height === 'function') {
      const y = terrain.height(x, z);
      if (Number.isFinite(y)) return y;
    }
    return fallbackSeabed(x, z);
  }

  function depthCpu(x, z) { return Math.max(SEA_LEVEL - seabedCpu(x, z), 0); }

  /** Shoaled parameters for band i at depth h — the JS twin of oc_wave(). */
  function waveCpu(i, h) {
    const k0 = waveK[i];
    const he = Math.max(h, 0.22);
    const k0h = k0 * he;
    let k = k0, Ks = 1;
    if (k0h < 3.0) {
      const x = Math.pow(Math.max(k0h, 1e-4), 0.75);
      const th = Math.tanh(x);
      const kh0 = Math.max(k0h * Math.pow(1 / Math.max(th, 1e-4), 2 / 3), 1e-3);
      k = Math.min(kh0 / he, k0 * 5);
      const kh = k * he;
      const s2 = Math.sinh(Math.min(2 * kh, 11));
      const n = 0.5 * (1 + (2 * kh) / Math.max(s2, 1e-3));
      const c = Math.sqrt((G * Math.tanh(Math.min(kh, 11))) / Math.max(k, 1e-4));
      const c0 = Math.sqrt(G / Math.max(k0, 1e-4));
      Ks = Math.sqrt(Math.min(3.2, Math.max(0.3, (0.5 * c0) / Math.max(n * c, 1e-4))));
    }
    const A0 = WAVE_BANDS[i].A * waveScale;
    const A = A0 * Ks;
    const Amax = Math.min(0.39 * h, (2 * Math.PI) / (k * 14));
    const Ac = Math.min(A, Amax);
    return { k, A: Ac, brk: Math.min(1, Math.max(0, (A - Ac) / Math.max(A, 1e-4))), Ks };
  }

  function swashCpu(x, z, h, t) {
    const ph = -z * 0.216 - t * 1.487 + Math.sin(x * 0.0135) * 1.1 + Math.sin(x * 0.0455 + 2.3) * 0.55;
    const s = Math.sin(ph);
    const up = Math.pow(Math.max(0, Math.min(1, s * 0.5 + 0.5)), 0.55);
    const shore = smooth01((2.6 - h) / 2.6);
    return { y: (up - 0.42) * 0.62 * shore, front: Math.max(0, Math.cos(ph)) * shore };
  }

  function heightAt(x, z, t) {
    if (t === undefined) t = ctxRef ? ctxRef.clock.t : 0;
    const h = depthCpu(x, z);
    let y = SEA_LEVEL;
    for (let i = 0; i < NW; i++) {
      const w = waveCpu(i, h);
      if (w.A < 1e-4) continue;
      const D = waveDir[i];
      const th = w.k * (D[0] * x + D[1] * z) - waveOmega[i] * t + wavePhase[i];
      const skew = Math.min(0.95, 0.85 * w.brk + 0.45 * Math.min(1, Math.max(0, w.Ks - 1)));
      y += w.A * Math.cos(th + skew * Math.sin(th));
    }
    y += swashCpu(x, z, h, t).y;
    return y;
  }

  function normalAt(x, z, t, out) {
    const o = out || new THREE.Vector3();
    const e = 0.28;
    const y0 = heightAt(x, z, t);
    const yx = heightAt(x + e, z, t);
    const yz = heightAt(x, z + e, t);
    return o.set(-(yx - y0) / e, 1, -(yz - y0) / e).normalize();
  }

  function foamAt(x, z, t) {
    if (t === undefined) t = ctxRef ? ctxRef.clock.t : 0;
    const h = depthCpu(x, z);
    let brk = 0;
    for (let i = 0; i < NW; i++) {
      const w = waveCpu(i, h);
      if (w.A < 1e-4) continue;
      const D = waveDir[i];
      const th = w.k * (D[0] * x + D[1] * z) - waveOmega[i] * t + wavePhase[i];
      const c01 = Math.cos(th) * 0.5 + 0.5;
      brk = Math.max(brk, w.brk * smooth01((c01 - 0.05) / 0.67));
    }
    const sw = swashCpu(x, z, h, t);
    const col = heightAt(x, z, t) - seabedCpu(x, z);
    const sheet = col > 0 ? smooth01((0.42 - col) / 0.4) : 0;
    // waves detonating on a sea stack
    let rock = 0;
    for (const lm of landmarkList()) {
      const d = Math.hypot(x - lm.x, z - lm.z) - lm.r;
      if (d < 6 && d > -4) rock = Math.max(rock, Math.exp(-Math.max(d, 0) * 0.55) * smooth01((h - 0.15) / 2.35));
    }
    return Math.min(1, brk * 0.9 + sheet * 0.55 + Math.max(0, sw.front) * smooth01((1.5 - h) / 1.35) * 0.5 + rock * 0.6);
  }

  function landmarkList() {
    const rocks = ctxRef && ctxRef.get ? ctxRef.get('rocks') : null;
    const out = [];
    if (rocks && rocks.landmarks && rocks.landmarks.size) {
      for (const [, lm] of rocks.landmarks) {
        if (!lm || !lm.center) continue;
        // only things standing in or near the water
        if (lm.center.z > 40) continue;
        out.push({ x: lm.center.x, z: lm.center.z, r: lm.radius || 12 });
        if (out.length >= MAX_LANDMARKS) break;
      }
    }
    if (!out.length) for (const l of FALLBACK_LANDMARKS.slice(0, MAX_LANDMARKS)) out.push(l);
    return out;
  }

  /* ------------------------------------------------------------------ resources */

  function buildBathymetry(ctx) {
    const t0 = performance.now();
    const data = bathyData || new Float32Array(BATHY_W * BATHY_H);
    const terrain = ctx.get('terrain');
    const useTerrain = !!(terrain && typeof terrain.height === 'function'
      && Number.isFinite(terrain.height(0, -20)));
    const dx = (DOM.x1 - DOM.x0) / (BATHY_W - 1);
    const dz = (DOM.z1 - DOM.z0) / (BATHY_H - 1);
    for (let j = 0; j < BATHY_H; j++) {
      const z = DOM.z0 + j * dz;
      for (let i = 0; i < BATHY_W; i++) {
        const x = DOM.x0 + i * dx;
        let y = useTerrain ? terrain.height(x, z) : fallbackSeabed(x, z);
        if (!Number.isFinite(y)) y = fallbackSeabed(x, z);
        data[j * BATHY_W + i] = y;
      }
    }
    bathyData = data;
    if (!bathyTex) {
      bathyTex = new THREE.DataTexture(data, BATHY_W, BATHY_H, THREE.RedFormat, THREE.FloatType);
      bathyTex.wrapS = bathyTex.wrapT = THREE.ClampToEdgeWrapping;
      const lin = ctx.caps.floatLinear !== false;
      bathyTex.minFilter = lin ? THREE.LinearFilter : THREE.NearestFilter;
      bathyTex.magFilter = lin ? THREE.LinearFilter : THREE.NearestFilter;
      bathyTex.generateMipmaps = false;
      bathyTex.colorSpace = THREE.NoColorSpace;
    }
    bathyTex.needsUpdate = true;
    return { ms: performance.now() - t0, useTerrain };
  }

  /**
   * Camera-centred radial disc. Ring spacing is 0.14 m out to 6 m and 2.25% of radius
   * beyond, so screen-space triangle size is roughly constant: ~0.9 m of tessellation
   * at 40 m, which resolves an 8 m shoaled crest with ten samples across its face.
   */
  function buildDisc() {
    const radii = [];
    let r = 0.18;
    while (r < 12000) { radii.push(r); r += Math.max(0.14, r * 0.0225); }
    radii.push(12000);
    const NR = radii.length;
    const NS = 448;
    const vcount = NR * (NS + 1);
    const pos = new Float32Array(vcount * 3);
    let p = 0;
    for (let i = 0; i < NR; i++) {
      const rr = radii[i];
      for (let s = 0; s <= NS; s++) {
        const a = (s / NS) * Math.PI * 2;
        pos[p++] = Math.cos(a) * rr;
        pos[p++] = 0;
        pos[p++] = Math.sin(a) * rr;
      }
    }
    const idx = new Uint32Array((NR - 1) * NS * 6);
    let q = 0;
    for (let i = 0; i < NR - 1; i++) {
      const row = i * (NS + 1), next = (i + 1) * (NS + 1);
      for (let s = 0; s < NS; s++) {
        const a = row + s, b = row + s + 1, c = next + s, d = next + s + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 24000);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-12000, -60, -12000), new THREE.Vector3(12000, 60, 12000));
    return { geom: g, tris: (NR - 1) * NS * 2, verts: vcount };
  }

  function waveUniformArrays() {
    const A = [], B = [], C = [];
    for (let i = 0; i < NW; i++) {
      const b = WAVE_BANDS[i];
      const a = THREE.MathUtils.degToRad(b.dir);
      A.push(new THREE.Vector4(Math.sin(a), Math.cos(a), b.A, b.L));
      B.push(new THREE.Vector4(waveOmega[i], b.Q, wavePhase[i], 1 / b.L));
    }
    for (let i = 0; i < NC; i++) {
      const b = CHOP_BANDS[i];
      const a = THREE.MathUtils.degToRad(b.dir);
      C.push(new THREE.Vector4(Math.sin(a), Math.cos(a), b.A, b.L));
    }
    return { A, B, C };
  }

  /* ------------------------------------------------------------------ foam pass */

  function stepFoam(ctx, dt, tOverride) {
    const r = ctx.renderer;
    const u = foamMat.uniforms;
    u.tPrev.value = foamA.texture;
    u.uDt.value = dt;
    u.uTime.value = tOverride;
    const prevRT = r.getRenderTarget();
    r.setRenderTarget(foamB);
    foamQuad.render(r);
    r.setRenderTarget(prevRT);
    const t = foamA; foamA = foamB; foamB = t;
    uniforms.tFoam.value = foamA.texture;
  }

  /** Spin the field up so a capture is not looking at 0.8 s of foam history. */
  function primeFoam(ctx, t) {
    const K = 130, dt = 1 / 45;
    for (let i = 0; i < K; i++) stepFoam(ctx, dt, t - (K - i) * dt);
  }

  function pushLandmarks() {
    const list = landmarkList();
    for (let i = 0; i < MAX_LANDMARKS; i++) {
      const v = landmarkArr[i];
      if (i < list.length) v.set(list[i].x, list[i].z, list[i].r, 1);
      else v.set(0, 0, 0, 0);
    }
  }

  /* ==================================================================== module */

  return {
    name: 'ocean',
    order: 50,
    enabled: true,
    level: SEA_LEVEL,

    async init(ctx) {
      ctxRef = ctx;
      const { renderer } = ctx;

      const bath = buildBathymetry(ctx);

      /* --- detail normal map (procedural, once) --- */
      detailRT = makeRT(512, 512, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
        minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true,
      });
      {
        const dm = fsMaterial(DETAIL_FRAG, {});
        const dq = new FullScreenQuad(dm);
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(detailRT);
        dq.render(renderer);
        renderer.setRenderTarget(prev);
        dq.dispose();
        detailRT.texture.anisotropy = Math.min(8, ctx.caps.maxAnisotropy || 1);
        detailRT.texture.needsUpdate = true;
      }

      /* --- depth resolve target (see DEPTH_COPY_FRAG) --- */
      depthRT = makeRT(ctx.size.w, ctx.size.h, {
        type: THREE.FloatType, format: THREE.RedFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      depthMat = fsMaterial(DEPTH_COPY_FRAG, { tDepth: { value: null } });
      depthQuad = new FullScreenQuad(depthMat);

      /* --- uniform block --- */
      const { A, B, C } = waveUniformArrays();
      const aer = sharedAerialUniforms();
      landmarkArr = Array.from({ length: MAX_LANDMARKS }, () => new THREE.Vector4());
      pushLandmarks();

      const shared = {
        uWaveA: { value: A },
        uWaveB: { value: B },
        uChop: { value: C },
        uSeaLevel: { value: SEA_LEVEL },
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector2(0, 0) },
        uWaveScale: { value: 1.0 },
        tBathy: { value: bathyTex },
        uBathyRect: { value: new THREE.Vector4(DOM.x0, DOM.z0, 1 / (DOM.x1 - DOM.x0), 1 / (DOM.z1 - DOM.z0)) },
        uBathyDeep: { value: DEEP_Y },
      };

      /* --- foam field --- */
      const foamOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false };
      foamA = makeRT(FOAM_W, FOAM_H, foamOpts);
      foamB = makeRT(FOAM_W, FOAM_H, foamOpts);
      foamMat = fsMaterial(FOAM_FRAG, Object.assign({}, shared, {
        uTime: { value: 0 },
        tPrev: { value: null },
        uDt: { value: 1 / 60 },
        uFoamRect: { value: new THREE.Vector4(DOM.x0, DOM.z0, DOM.x1 - DOM.x0, DOM.z1 - DOM.z0) },
        uLandmarks: { value: landmarkArr },
        uFoamDecay: { value: 1.0 },
        uFoamGain: { value: 1.0 },
      }));
      foamQuad = new FullScreenQuad(foamMat);
      {
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(foamA); renderer.clear(true, false, false);
        renderer.setRenderTarget(foamB); renderer.clear(true, false, false);
        renderer.setRenderTarget(prev);
      }

      /* --- water material --- */
      uniforms = Object.assign({}, shared, {
        uCamPos: { value: new THREE.Vector3() },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uViewProj: { value: new THREE.Matrix4() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uLodStart: { value: 260 },
        uLodEnd: { value: 1250 },

        tOpaque: { value: null },
        tDepth: { value: null },
        tDetail: { value: detailRT.texture },
        tFoam: { value: foamA.texture },
        tSky: { value: null },
        tClouds: { value: null },
        uUseClouds: { value: 0 },
        uFoamRect: { value: new THREE.Vector4(DOM.x0, DOM.z0, DOM.x1 - DOM.x0, DOM.z1 - DOM.z0) },

        uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.5) },
        uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
        uSunIntensity: { value: 6.2 },
        uSkyAmbient: { value: new THREE.Color(0.12, 0.19, 0.30) },
        uHorizonColor: { value: new THREE.Color(0.35, 0.42, 0.52) },
        uUseSSR: { value: 1 },

        uExtinction: { value: new THREE.Vector3(0.365, 0.056, 0.040) },
        uScatterCol: { value: new THREE.Color(0.048, 0.300, 0.345) },
        uFoamAmount: { value: 1.0 },
        uGlitter: { value: 1.0 },
        uCausticAmount: { value: 1.0 },
        uDetailAmount: { value: 1.0 },
      }, aer);

      mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        side: THREE.DoubleSide,
        transparent: false,
        blending: THREE.NoBlending,
        depthTest: true,
        // The water is not in the depth pre-pass, and pipe.depthTex is attached to the
        // target being drawn into. Leaving depth writes off is both what keeps that
        // sample legal and what stops the transparent pass from stamping water depth
        // over the G-buffer's terrain depth for the post chain.
        depthWrite: false,
        toneMapped: false,
      });

      const built = buildDisc();
      geom = built.geom;
      mesh = new THREE.Mesh(geom, mat);
      mesh.name = 'ocean';
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = true;
      mesh.renderOrder = 10;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.layers.set(LAYER.TRANSPARENT);

      /* Everything view-dependent is refreshed here rather than in prerender(): by the
       * time three issues this draw, RenderPipeline has already applied the TAA
       * sub-pixel jitter to camera.projectionMatrix, so this is the only place the
       * inverse view-projection matches the pixels actually being rasterised. Getting
       * that wrong shifts every refraction and reflection tap by half a pixel. */
      mesh.onBeforeRender = (renderer2, scene2, camera2) => {
        const pipeMod = ctx.get('pipeline');
        const pipe = pipeMod && pipeMod.pipe;
        uniforms.uViewProj.value.multiplyMatrices(camera2.projectionMatrix, camera2.matrixWorldInverse);
        uniforms.uInvViewProj.value.copy(uniforms.uViewProj.value).invert();
        uniforms.uCamPos.value.copy(camera2.position);
        if (!pipe) return;
        uniforms.tOpaque.value = pipe.opaqueRT.texture;
        uniforms.uInvRes.value.set(1 / pipe.w, 1 / pipe.h);
        if (depthRT.width !== pipe.w || depthRT.height !== pipe.h) depthRT.setSize(pipe.w, pipe.h);
        const prevRT = renderer2.getRenderTarget();
        depthMat.uniforms.tDepth.value = pipe.depthTex;
        renderer2.setRenderTarget(depthRT);
        depthQuad.render(renderer2);
        renderer2.setRenderTarget(prevRT);
        uniforms.tDepth.value = depthRT.texture;
      };

      ctx.scene.add(mesh);

      ctx.config.oceanWaveScale = ctx.config.oceanWaveScale ?? 1.0;
      ctx.on('config', ({ k, v }) => {
        if (k === 'oceanWaveScale') { waveScale = v; uniforms.uWaveScale.value = v; foamMat.uniforms.uWaveScale.value = v; primed = false; }
        if (k === 'oceanFoam') uniforms.uFoamAmount.value = v;
        if (k === 'oceanGlitter') uniforms.uGlitter.value = v;
        if (k === 'oceanCaustics') uniforms.uCausticAmount.value = v;
        if (k === 'oceanDetail') uniforms.uDetailAmount.value = v;
        if (k === 'oceanSSR') uniforms.uUseSSR.value = v ? 1 : 0;
        if (k === 'oceanExtinction') uniforms.uExtinction.value.fromArray(v);
        if (k === 'oceanScatter') uniforms.uScatterCol.value.fromArray(v);
        if (k === 'oceanLod') { uniforms.uLodStart.value = v; uniforms.uLodEnd.value = v * 4.8; }
      });
      ctx.on('terrain:ready', () => { buildBathymetry(ctx); primed = false; });
      ctx.on('camera:teleport', () => { primed = false; });

      this._stats = {
        tris: built.tris, verts: built.verts,
        bathyMs: Math.round(bath.ms), bathySource: bath.useTerrain ? 'terrain' : 'analytic',
      };
    },

    update(dt, ctx) {},

    prerender(ctx) {
      if (!mesh) return;
      const t = ctx.clock.t;
      const time = ctx.get('time');
      const sky = ctx.get('sky');

      /* follow the camera; the wave field itself is world-anchored so nothing swims */
      mesh.position.set(ctx.camera.position.x, 0, ctx.camera.position.z);
      mesh.updateMatrixWorld(true);

      uniforms.uTime.value = t;
      foamMat.uniforms.uTime.value = t;
      if (time) {
        uniforms.uSunDir.value.copy(time.sunDir);
        uniforms.uSunColor.value.copy(time.sunColor);
        uniforms.uSunIntensity.value = time.state.sunIntensity * (ctx.config.sunScale ?? 1);
        uniforms.uWind.value.set(time.wind.x, time.wind.z);
        foamMat.uniforms.uWind.value.copy(uniforms.uWind.value);
      }
      if (sky && sky.radiance) {
        // sky irradiance seen by the water: a crude two-lobe average of the dome
        _c1.set(0, 0, 0);
        sky.radiance(_v3.set(0, 1, 0), _c2); _c1.add(_c2);
        sky.radiance(_v3.set(0.7, 0.4, 0.6).normalize(), _c2); _c1.add(_c2);
        sky.radiance(_v3.set(-0.7, 0.25, -0.6).normalize(), _c2); _c1.add(_c2);
        uniforms.uSkyAmbient.value.copy(_c1).multiplyScalar(1 / 3);
        if (sky.horizonRadiance) uniforms.uHorizonColor.value.copy(sky.horizonRadiance(_c2));
        const crt = sky.getRenderTarget ? sky.getRenderTarget() : null;
        uniforms.tSky.value = crt ? crt.texture : null;
      }
      const clouds = ctx.get('clouds');
      const cbuf = clouds && clouds.buffer ? clouds.buffer : null;
      uniforms.tClouds.value = cbuf;
      uniforms.uUseClouds.value = cbuf ? 1 : 0;

      /* ---- foam simulation ----
       * Re-prime on a time discontinuity (the capture harness sets the clock before it
       * advances) and on a teleport, so the field is converged and pose-independent
       * rather than carrying whatever the previous pose left behind. */
      const jumped = Math.abs(t - lastT) > 0.6;
      lastT = t;
      pushLandmarks();
      if (!primed || jumped) {
        primeFoam(ctx, t);
        primed = true;
      } else {
        stepFoam(ctx, Math.min(Math.max(ctx.clock.dt, 1e-4), 0.05), t);
      }
    },

    resize(w, h, ctx) {
      if (uniforms) uniforms.uInvRes.value.set(1 / w, 1 / h);
      depthRT?.setSize(Math.max(2, w), Math.max(2, h));
    },

    /* ----------------------------------------------------------- public API */

    heightAt(x, z, t) { return heightAt(x, z, t); },
    normalAt(x, z, t, out) { return normalAt(x, z, t, out); },
    depthAt(x, z) { return depthCpu(x, z); },
    isSubmerged(p) { return p.y < heightAt(p.x, p.z); },
    foamAt(x, z, t) { return foamAt(x, z, t); },

    /* ---- extras (guarded consumers only; not part of the frozen contract) ---- */
    /** Seabed elevation — terrain if it is loaded, the WORLD.md profile if not. */
    seabedAt(x, z) { return seabedCpu(x, z); },
    /** 0..1 how recently a point was under the swash — for wet-sand shading. */
    wetnessAt(x, z, t) {
      const col = heightAt(x, z, t) - seabedCpu(x, z);
      if (col > 0.01) return 1;
      return smooth01((col + 0.45) / 0.45) * 0.85;
    },
    /** Points where surf is currently detonating on rock — spray emitters. */
    sprayEmitters(t) {
      const tt = t === undefined ? (ctxRef ? ctxRef.clock.t : 0) : t;
      const out = [];
      for (const lm of landmarkList()) {
        for (let a = 0; a < 6; a++) {
          const ang = (a / 6) * Math.PI * 2 + 0.4;
          const x = lm.x + Math.cos(ang) * lm.r, z = lm.z + Math.sin(ang) * lm.r;
          const f = foamAt(x, z, tt);
          if (f > 0.28) out.push({ position: new THREE.Vector3(x, heightAt(x, z, tt) + 0.2, z), rate: f });
        }
      }
      return out;
    },
    get foamTexture() { return foamA ? foamA.texture : null; },
    get bathymetryTexture() { return bathyTex; },
    get material() { return mat; },
    stats() { return this._stats; },

    dispose(ctx) {
      if (mesh) ctx.scene.remove(mesh);
      geom?.dispose();
      mat?.dispose();
      bathyTex?.dispose();
      foamA?.dispose(); foamB?.dispose();
      foamQuad?.dispose();
      detailRT?.dispose();
      depthRT?.dispose();
      depthQuad?.dispose();
    },
  };
}
