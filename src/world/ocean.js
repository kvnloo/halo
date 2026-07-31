import * as THREE from 'three';
import { NOISE_GLSL } from '../gfx/glsl/noise.js';
import { LAYER, fsMaterial, FullScreenQuad, makeRT } from '../render/RenderPipeline.js';
import { sharedAerialUniforms } from '../gfx/materialCommon.js';

/**
 * 'ocean' — water surface, shoaling swell, refraction, reflection, foam and caustics.
 *
 * TARGETS (ref/roi_signatures.json 'water': lap_var 677 / edge_density 0.109; the
 * kf_01800 crop, where water fills the frame: lap_var 1376 / edge 0.197). Everything
 * below exists to put real, physically-shaped structure at every spatial scale from
 * 28 m down to a pixel, without adding broadband noise (which would raise lap_var while
 * dragging spectral_slope the wrong way).
 *
 * NOTHING IN THIS HEADER IS A MEASUREMENT UNLESS reports/ocean.md CARRIES THE COMMAND
 * THAT PRODUCED IT.
 *
 * !! NO BACKTICKS ANYWHERE IN THIS FILE, INCLUDING IN COMMENTS INSIDE THE GLSL TEMPLATE
 *    LITERALS. Use plain quotes. This has silently deleted the whole module three times.
 *    An EVEN number of stray backticks re-closes the template, so 'node --check' STILL
 *    PASSES, and the text between them becomes evaluated JavaScript — the module then
 *    throws at import and the capture writes a perfectly plausible PNG with no water in
 *    it. The only reliable guard is to reject any capture whose log contains
 *    "not loaded: ocean"; reports/ocean.md section 1a has the scanner and the wrapper.
 *
 * READ reports/ocean.md SECTION 0 BEFORE TUNING ANYTHING. The short version: this module
 * was scored 3/100 for raising water-ROI lap_var to +43% OVER the signature while
 * REDUCING local_contrast to 45% UNDER it. That combination is not detail, it is
 * pixel-scale hash. **Never judge a change here on lap_var alone.** The triple
 * (lap_var, local_contrast, lum_std) has to move together, and a lap_var DROP toward 677
 * is usually a win.
 *
 * Where the energy comes from, in order of contribution:
 *
 *  1. REFLECTION MODULATED BY WAVE SLOPE. At eye height 1.7 m almost the whole water
 *     surface is seen within a few degrees of grazing, so Fresnel is ~0.9 and the pixel
 *     is *the reflection*. A wave facet tilting by 8 deg swings the reflected ray across
 *     16 deg of sky. That radiance swing is the mechanism that draws the light/dark
 *     banding kf_01800 shows — but it is also, unbounded and unfiltered, exactly how
 *     this module manufactured its hash. Two constraints keep it honest now:
 *       - the reflected direction is bounded by clamping the SURFACE SLOPE
 *         (uReflMaxSlope), and the same bounded direction drives the sky cube AND the
 *         screen tap, so they cannot disagree;
 *       - the screen tap is a MIP of a half-res prefiltered copy of the frame, at a
 *         level chosen from the roughness cone. A rough facet gathers; it never
 *         point-samples.
 *
 *  2. REFRACTED, ABSORBED SEAFLOOR. Beer-Lambert with per-channel extinction over the
 *     SNELL-REFRACTED in-water path, which is bounded at 1.512x the column depth by
 *     total internal reflection. That bound is the whole reason water stays legible at
 *     grazing angles, and running the absorption over the air-side path instead (which
 *     is what was here) drives the bottom term to exp(-20) and turns the sea opaque
 *     navy. Composed as Lyzenga's optically-shallow form, bottom*T2 + L_deep*(1-T2).
 *
 *  3. SUN GLITTER as a real microfacet lobe whose roughness is the *filtered-out* wave
 *     slope variance (Toksvig / LEAN, alpha = sqrt(mss)), lit by the sun as a DISC of
 *     angular radius 0.00465 rad via Karis's representative point. A lobe narrower than
 *     the sun is not physical and TAA eats it.
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
 *   - phase skewed by 'theta += s*sin(theta)' with s growing as it shoals, which is
 *     what turns a sine into a pitched front with a steep face and a long flat back.
 * The amount of amplitude the clip removed *is* the breaking intensity, and that drives
 * the foam source. This is why the breaker line lands on a contour of the bathymetry
 * rather than on a hand-placed spline: it falls out of the depth field.
 *
 * ## Bathymetry
 *
 * Depth has to be available per-pixel on the GPU, but 'terrain' owns the heightfield
 * and modules may not import each other. So at init the module samples
 * 'terrain.height()' over the near-shore rectangle into a float texture, once. If
 * 'terrain' has not landed yet it falls back to an analytic profile fitted to the
 * cross-section table in docs/WORLD.md, so the ocean is judgeable in isolation and
 * snaps to the real seabed the moment terrain exists.
 *
 * ## Coherence
 *
 * Water is not an opaque world surface, so it does not go through 'applyWorldMaterial'
 * (it needs its own refraction/reflection/Fresnel composition rather than three's
 * lighting model). It does alias 'sharedAerialUniforms()' and apply the identical
 * height-fog in-scatter integral, so the horizon dissolves at exactly the same rate as
 * terrain and rock. Sun direction, colour and intensity all come from 'time'; the sky
 * term comes from 'sky'.
 */

/* ------------------------------------------------------------------ constants */

const SEA_LEVEL = 0.0;
const G = 9.81;
/** JS mirror of OC_RUNUP in OCEAN_COMMON. Keep the two in step. */
const OCEAN_RUNUP = 0.12;

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
 * SEA STATE. This is a SHELTERED LAGOON INSIDE A REEF, not open ocean. kf_01800 and
 * kf_00000 show an unbroken cloud reflection running continuously across ~20 m of
 * surface, which puts Hs well under 0.2 m; the visible ripple wavelength at ~5 m range
 * is 0.3-0.6 m. The previous table was built for the 5.4 m/s open-ocean wind 'time'
 * reports (Cox-Munk mss 0.0307, rho = A/L = 0.0119, Lp 28 m) and gave a deep-water
 * Hs of 1.29 m BEFORE Green's shoaling and BEFORE the bore term — 6-10x the reference.
 * Measured consequence: the near-field patch (x0-200, y900-1050) read rgb
 * (103.8, 113.4, 135.3) against a reference (45.7, 43.5, 44.1), because the wave field
 * alone was adding +57 codes of blown sky reflection.
 *
 * The ladder and the ratios are kept; every amplitude is cut to rho = 0.0032 and the
 * peak wavelength moved 28 m -> 14 m. Deep-water Hs = 4*sqrt(sum(A^2)/2) = 0.172 m.
 * mss over both tables is 0.0105, the Cox-Munk value for U = 1.5 m/s — a light breeze
 * inside a reef, which is what the reference shows. Crest SHAPE is bought with Q (the
 * loop budget, see below), never with A: raising A raises the reflection excursion,
 * raising Q only sharpens the trochoid.
 */
const WAVE_BANDS = [
  // wavelength(m), amplitude(m), dirDeg, steepness (Q_i, GPU Gems eq: sum Q_i k_i A_i <= 1)
  { L: 14.00, A: 0.0448, dir: -5, Q: 2.60 },
  { L: 9.50, A: 0.0304, dir: 8, Q: 2.55 },
  { L: 6.40, A: 0.0205, dir: -12, Q: 2.50 },
  { L: 4.30, A: 0.0138, dir: 15, Q: 2.40 },
  { L: 2.90, A: 0.0093, dir: -19, Q: 2.30 },
  { L: 1.95, A: 0.0062, dir: 22, Q: 2.20 },
  { L: 1.30, A: 0.0042, dir: -28, Q: 2.00 },
  { L: 0.88, A: 0.0028, dir: 34, Q: 1.80 },
];
const NW = WAVE_BANDS.length;

/** Normal-only bands, evaluated per pixel. Too fine to tessellate, too coarse to
 *  hide in a texture — this is the band that carries the visible chop.
 *  rho = 0.0080; mss = 7*(2 pi rho)^2/2 = 0.0088, which with the 0.0017 from the
 *  geometric ladder is the Cox-Munk mss for a ~1.5 m/s breeze. Wavelengths pushed down
 *  one notch (1.10 m -> 0.085 m) so the visible ripple scale matches the reference. */
const CHOP_BANDS = [
  { L: 1.10, A: 0.0088, dir: 62 },
  { L: 0.72, A: 0.00576, dir: -78 },
  { L: 0.47, A: 0.00376, dir: 96 },
  { L: 0.31, A: 0.00248, dir: -117 },
  { L: 0.20, A: 0.00160, dir: 139 },
  { L: 0.130, A: 0.00104, dir: -158 },
  { L: 0.085, A: 0.00068, dir: 173 },
];
const NC = CHOP_BANDS.length;

/** Sea-stack waterlines, used as foam/spray sources. Preferred source is
 *  'rocks.landmarks'; this table (from docs/WORLD.md) is the fallback so the surf
 *  still breaks on the stacks when 'rocks' has not landed. */
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
 * Analytic seabed used only until 'terrain' lands. Follows docs/WORLD.md: the beach is
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
/** Angular radius of the sun as seen from the surface, radians (0.266 deg). It is the
 *  physical floor on any specular lobe width — nothing in the sky is sharper. */
const float OC_SUN_R = 0.00465;

/** Maximum vertical run-up above still water, in metres. Hunt's formula, re-derived for
 *  the corrected sea state: tan b ~ 0.084, Hs 0.17 m, L0 14 m gives an Iribarren number
 *  of 0.084/sqrt(0.17/14) = 0.76 and R2% = Hs*xi = 0.13 m. NOTHING the ocean draws or
 *  reports may sit higher than this above the local seabed, and every land gate in this
 *  module is measured against it. Without it the swash surge — which is gated on a depth
 *  that is clamped to zero on land, and therefore carries no information there — floods
 *  the entire map; at 0.25 m (fitted to the old 1.29 m Hs) it was still admitting water
 *  far enough up the profile to add +27.8 codes to the sand ROI. */
const float OC_RUNUP = 0.12;

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

/** Uphill (shoreward) unit direction of the seabed, i.e. the normalised horizontal
 *  gradient of the bathymetry. This is what a shoaling crest turns to face — Snell's
 *  law with c(h) playing the role of 1/n (research/ocean.md 1.4c). The offset is 2.4 m,
 *  ~2.7 bathymetry texels, which is the smallest stencil that does not just measure
 *  the seabed's own noise. Returns (0,0) on a genuinely flat bed so the caller can
 *  fall back to the deep-water direction. */
vec2 oc_bedGrad(vec2 p){
  const float e = 2.4;
  float gx = oc_seabedY(p + vec2(e, 0.0)) - oc_seabedY(p - vec2(e, 0.0));
  float gz = oc_seabedY(p + vec2(0.0, e)) - oc_seabedY(p - vec2(0.0, e));
  vec2 g = vec2(gx, gz);
  float m = length(g);
  return m > 1e-4 ? g / m : vec2(0.0);
}

/* ---------------------------------------------------------------- shoaling ---- */
/** Everything a shoaled wave needs at one point: wavenumber, amplitude after the
 *  breaker clip, phase skew, how much amplitude the clip removed (= breaking), the
 *  REFRACTED travel direction, and the Nyquist LOD fade for the local mesh density. */
struct OcWave { float k; float A; float Q; float skew; float brk; float Ab; vec2 D; float fade; };

/**
 * @param h    still-water depth, m
 * @param nBed uphill unit bathymetry gradient (from oc_bedGrad), or (0,0) for flat
 * @param e    local mesh edge length in metres; the band is faded out over
 *             L in [2e, 4e] (GPU Gems ch.1 1.3.3). Pass ~0 to disable.
 */
OcWave oc_wave(int i, float h, vec2 nBed, float e){
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
    // Ks is a physical quantity that reaches ~1.3 at h = 0.05*L0; the old 3.2 ceiling
    // let the ratio run to a factor the breaker clip then had to undo, so the surf
    // zone's amplitude was set by the clip rather than by the swell. 1.6 is generous.
    Ks = sqrt(clamp(0.5 * c0 / max(n * c, 1e-4), 0.3, 1.6));
  }

  float A0 = a.z * uWaveScale;
  float A  = A0 * Ks;
  // depth-limited breaking (H <= 0.78h) and the Miche steepness limit (H <= L/7)
  float Amax = min(0.39 * h, OC_TAU / (k * 14.0));
  float Ac   = min(A, Amax);
  w.brk = clamp((A - Ac) / max(A, 1e-4), 0.0, 1.0);
  w.A = Ac;
  w.k = k;
  /* The clip removes real energy, and deleting it is what left the surf zone
   * geometrically flat: by the time a wave is in the breaker line the model had already
   * zeroed the thing that should be drawing the crest. Carry the removed amplitude
   * forward as a BORE instead — a body of water riding on top of the still level with a
   * steep shoreward face and a flat back. A bore cannot be taller than the water it is
   * running over, hence the 0.60*h cap (which also makes it exactly zero on land). */
  w.Ab = clamp(A - Ac, 0.0, 0.60 * h);
  /* Steepness ramps with shoaling. The per-wave ceiling is GPU Gems' loop constraint
   * shared out over the NW bands: sum_i Q_i k_i A_i <= 1 is guaranteed if every band
   * obeys Q_i <= 0.95/(k_i A_i NW). The old ceiling divided by NW*0.30 instead, i.e.
   * it permitted sum = 3.07 — three times the self-intersection limit — so the clamp
   * was decorative. */
  w.Q = min(b.y * (1.0 + 2.1 * w.brk + 1.3 * clamp(Ks - 1.0, 0.0, 1.5)),
            0.95 / max(w.k * w.A * float(NW), 1e-4));
  // sawtooth the phase: steep front face, long flat back — a pitched breaker, not a sine
  w.skew = clamp(0.85 * w.brk + 0.45 * clamp(Ks - 1.0, 0.0, 1.0), 0.0, 0.95);

  /* Refraction. The shallow end of a crest slows first, so the crest turns toward the
   * depth contours; without this, crests march onto the sand at a fixed angle forever,
   * which research/ocean.md calls out as the most recognisable not-a-real-beach cue
   * (failure mode 9). Cheap stable form: rotate the deep-water direction toward the
   * uphill bathymetry gradient by an amount that grows as the wave shoals. */
  vec2 Dd = a.xy;
  float L0 = 1.0 / max(b.w, 1e-4);
  float bend = 1.0 - clamp(h / (0.5 * L0), 0.0, 1.0);
  vec2 Dm = mix(Dd, nBed, bend * 0.85 * step(1e-4, dot(nBed, nBed)));
  float dm = length(Dm);
  w.D = dm > 1e-4 ? Dm / dm : Dd;

  /* Nyquist LOD (GPU Gems ch.1 1.3.3): a band is at full amplitude while its SHOALED
   * wavelength is >= 4 mesh edges and gone by 2. The shoaled L is the right one to
   * test — that is the wavelength actually on the mesh. */
  float L = OC_TAU / max(k, 1e-4);
  w.fade = e > 1e-4 ? smoothstep(2.0 * e, 4.0 * e, L) : 1.0;
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
  // h is max(seaLevel - bed, 0), so it is identically 0 over every dry pixel in the
  // world and smoothstep(2.6, 0.0, h) evaluates to 1.0 out to infinity inland. Gating
  // on it alone put +0.36 m of surge on the whole land mass. The second factor is the
  // one that matters: it measures the bed's SIGNED elevation relative to still water
  // and kills the surge at the Hunt run-up height above the local waterline contour.
  float above = oc_seabedY(p) - uSeaLevel;
  float shore = smoothstep(2.6, 0.0, h) * smoothstep(OC_RUNUP, -0.06, above);
  front = clamp(cos(ph), 0.0, 1.0) * shore;
  return (up - 0.42) * 0.62 * shore;
}

/* ------------------------------------------------------------- displacement --- */
/**
 * Full displaced surface. Returns world position; tx/tz accumulate dP/dx, dP/dz.
 *
 * @param e        local mesh edge length in metres. Each band is faded out over
 *                 L in [2e, 4e] INDEPENDENTLY (GPU Gems ch.1 1.3.3). A single global
 *                 distance ramp is wrong: the disc's edge is 1.12 m at 50 m and 2.25 m
 *                 at 100 m, so at the old uLodStart of 260 m five of the eight bands
 *                 had been past Nyquist at full amplitude for the whole near field.
 *                 That was the source of the shard aliasing.
 * @param varDrop  out: the slope variance the LOD removed, per axis. Toksvig/LEAN —
 *                 it has to reappear as roughness or the far water becomes a mirror.
 * @param pinch    out: 0..1 horizontal-displacement magnitude (Gerstner "choppiness"
 *                 offset). This, NOT the crest elevation, is what drives translucency
 *                 (research 3.5 / failure mode 23).
 * @param jminus   out: Tessendorf's minimum Jacobian eigenvalue. < ~0.4 means the
 *                 surface is folding, i.e. free breaking foam (research 4.3b).
 */
vec3 oc_surface(vec2 p, float h, float e, out vec3 tx, out vec3 tz, out float brk,
                out float crest, out vec2 varDrop, out float pinch, out float jminus){
  vec3 P = vec3(p.x, uSeaLevel, p.y);
  tx = vec3(1.0, 0.0, 0.0);
  tz = vec3(0.0, 0.0, 1.0);
  brk = 0.0; crest = 0.0; varDrop = vec2(0.0);
  vec2 nBed = oc_bedGrad(p);
  vec2 disp = vec2(0.0); float dispMax = 1e-4;
  for (int i = 0; i < NW; i++){
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    OcWave w = oc_wave(i, h, nBed, e);
    float lodAmp = w.fade;
    // Whatever the Nyquist fade removed is slope that must survive as roughness.
    float kA0 = w.k * (w.A + w.Ab * 0.85);
    varDrop += 0.5 * kA0 * kA0 * (1.0 - lodAmp * lodAmp) * vec2(w.D.x * w.D.x, w.D.y * w.D.y);
    dispMax += w.Q * w.A;
    float A = w.A * lodAmp;
    // NB: test the bore too. A fully clipped band has A == 0 and is precisely the band
    // that should be drawing a roller; skipping it here is what deleted the surf zone.
    if (A + w.Ab * lodAmp < 1.0e-4) continue;
    vec2 D = w.D;
    float th = w.k * dot(D, p) - b.x * uTime + b.z;
    float sk = sin(th);
    float thS = th + w.skew * sk;
    float dth = 1.0 + w.skew * cos(th);           // d(thS)/d(th)
    float st = sin(thS), ct = cos(thS);
    P.y  += A * ct;
    P.xz -= D * (w.Q * A * st);
    disp -= D * (w.Q * A * st);
    float kA = w.k * A * dth;
    /* the broken part of the wave, as a roller sitting on the crest phase */
    float Ab = w.Ab * lodAmp;
    if (Ab > 1.0e-4){
      float bp = clamp(ct * 0.5 + 0.5, 0.0, 1.0);
      float bore = bp * bp * sqrt(bp);            // ~bp^2.5: narrow, locked to the crest
      P.y += Ab * bore * 0.85;
      // d(bore)/d(theta) = 2.5*bp^1.5 * d(bp)/d(theta), d(bp)/d(theta) = -0.5*st*dth
      float dbd = 2.5 * bp * sqrt(bp) * (-0.5 * st * dth);
      float kAb = w.k * Ab * 0.85 * dbd;
      tx.y += kAb * D.x;
      tz.y += kAb * D.y;
    }
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
    // Crest indicator, and breaking confined to the pitching face of the wave. The
    // window used to be smoothstep(0.55, 0.95) and the source was then cubed in the
    // sim and cubed AGAIN at shading time — three independent suppressors stacked on
    // one term, which is why the bay had no breaker line at all. One window, no cube;
    // the gain is tuned against the water-ROI A/B in reports/ocean.md.
    float c01 = ct * 0.5 + 0.5;
    crest += c01 * A;
    brk = max(brk, w.brk * smoothstep(0.35, 0.85, c01) * step(0.006, A + w.Ab));
  }
  /* Tessendorf's folding criterion, and it is FREE — Jxx, Jyy, Jxy are already sitting
   * in the tangent frame. J- goes 1 -> 0 -> negative as the surface folds over itself,
   * so foam can be injected slightly BEFORE the fold rather than after. */
  float Jxx = tx.x, Jyy = tz.z, Jxy = tx.z;
  float trJ = Jxx + Jyy;
  float discJ = sqrt(max(0.0, (Jxx - Jyy) * (Jxx - Jyy) + 4.0 * Jxy * Jxy));
  jminus = 0.5 * (trJ - discJ);

  pinch = clamp(length(disp) / dispMax, 0.0, 1.0);

  float front;
  float sw = oc_swash(p, h, front);
  P.y += sw;
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
   * brk is how much amplitude the depth-limited clip removed, already confined to the
   * pitching face by the crest window inside oc_surface. It is NOT cubed here: the
   * spatial confinement is the window's job, and stacking a cube on top of it (plus a
   * third cube at shading time) is what suppressed the breaker line to nothing. */
  vec3 tx, tz; float brk, crest, pinch, jminus; vec2 vdrop;
  vec3 S = oc_surface(p, h, 0.0, tx, tz, brk, crest, vdrop, pinch, jminus);
  foam += brk * brk * uFoamGain * uDt * 0.50;

  /* --- inject: surface folding (Tessendorf J-) ---------------------------------
   * The eigenvalue is already computed inside oc_surface from terms the tangent frame
   * needed anyway. This is the foam source that fires on a steep unbroken crest, i.e.
   * before the depth-limited clip has anything to remove, so it draws the lace on the
   * face of a shoaling wave rather than only the band behind it. Gate on depth: a fold
   * out in open water is failure mode 13 (white blotches in deep water). */
  float fold = smoothstep(0.12, -0.10, jminus) * smoothstep(14.0, 3.0, h);
  foam += fold * uFoamGain * uDt * 0.65;

  /* --- inject: shore proximity (Crest's shoreline foam) ------------------------- */
  foam += smoothstep(0.85, 0.0, h) * uDt * 0.22;

  /* --- inject: the swash sheet -------------------------------------------------- */
  float bed = oc_seabedY(p);
  float land = step(bed, uSeaLevel + OC_RUNUP);   // 0 on dry land, 1 in the swash/sea
  float col = S.y - bed;
  float sheet = smoothstep(0.20, 0.012, col) * step(0.0, col) * land;
  foam += sheet * uDt * 0.85;
  wet   = max(wet, step(0.005, col) * land);

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
 * 'pipe.depthTex' is attached to 'pipe.sceneRT', which is the framebuffer the water is
 * drawn into, so sampling it from the water shader is a rendering feedback loop and
 * WebGL2 drops the draw call entirely ('GL_INVALID_OPERATION: Feedback loop formed
 * between Framebuffer and active Texture' — verified, the water simply did not appear).
 * Turning depth writes off is not enough; ANGLE rejects the read on the attachment
 * alone. So the depth is resolved into a target of our own immediately before the
 * water draw, which is the same thing three's own Reflector/Refractor do from
 * 'onBeforeRender', and the water samples that copy.
 */
const DEPTH_COPY_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tDepth;
out vec4 oCol;
void main(){ oCol = vec4(texture(tDepth, vUv).r, 0.0, 0.0, 1.0); }
`;

/* --------------------------------------------------- reflection prefilter pass */

/**
 * Half-resolution, cloud-composited copy of the opaque frame, rendered into a target
 * with a full mip chain. The water samples it with 'textureLod' at a level chosen from
 * the roughness cone, so a rough facet GATHERS radiance over its lobe instead of point-
 * sampling one texel of a full-res image. Point-sampling was the single largest source
 * of the module's excess high-frequency energy (water lap_var +43% over the signature
 * while local_contrast sat 45% under it).
 *
 * The cloud composite happens here rather than at the tap, so every mip level carries
 * the cumulus. 'clouds' composites in post, so 'pipe.opaqueRT' has no cumulus in it, and
 * its screen buffer is indexed by view-ray direction — a reflected ray projected to
 * infinity lands on exactly the pixel whose ray direction it shares.
 *
 * A 4-tap box at half res (three.js 'generateMipmap' does a plain box downsample from
 * there) is a cheap approximation to a proper GGX prefilter, but the error is a slightly
 * boxy kernel, not a wrong radiance — and it is two orders of magnitude closer than no
 * filter at all.
 */
const REFL_PREFILTER_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tCloudBuf;
uniform float uUseClouds;
uniform vec2 uTexel;      // 1/full-res size
out vec4 oCol;
void main(){
  vec2 o = uTexel * 0.5;
  vec3 c = texture(tSrc, vUv + vec2(-o.x, -o.y)).rgb
         + texture(tSrc, vUv + vec2( o.x, -o.y)).rgb
         + texture(tSrc, vUv + vec2(-o.x,  o.y)).rgb
         + texture(tSrc, vUv + vec2( o.x,  o.y)).rgb;
  c *= 0.25;
  if (uUseClouds > 0.5){
    vec4 cl = texture(tCloudBuf, vUv);
    c = cl.rgb + c * cl.a;
  }
  oCol = vec4(c, 1.0);
}
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
uniform float uLodStart;   // scale on the Nyquist edge length; 1.0 = exactly GPU Gems' rule

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
out vec2 vVarDrop;
out float vPinch;
out float vFold;

void main(){
  vec2 p = (modelMatrix * vec4(position, 1.0)).xz;

  /* Local mesh edge length, analytic from buildDisc(): the ring spacing is
   * max(0.14, r*0.0225) and the circumferential spacing 2*pi*r/448 = 0.014*r, so the
   * radial step is always the longer edge. Each Gerstner band is faded out over
   * L in [2e, 4e] INSIDE oc_wave, which is the Nyquist rule GPU Gems ch.1 states
   * literally. uLodStart scales it (config oceanLod, 1.0 = exactly Nyquist).
   *
   * This replaces a single global 1 - smoothstep(260, 1250, d) applied to all eight
   * bands at once. That ramp did not start until 260 m, where the edge is already
   * 5.85 m — so at 50 m five of eight bands were being displaced onto a mesh far too
   * coarse to carry them, at full amplitude. */
  float d = length(p - uCamPos.xz);
  float e = max(0.085, d * 0.0225) * uLodStart;
  vLod = e;

  float h = oc_depth(p);
  vDepth = h;

  vec3 tx, tz; float brk, crest, pinch, jminus; vec2 vdrop;
  vec3 P = oc_surface(p, h, e, tx, tz, brk, crest, vdrop, pinch, jminus);

  vVarDrop = vdrop;
  vWorld = P;
  vFlat = p;
  vTx = tx; vTz = tz;
  vBrk = brk; vCrest = crest;
  vPinch = pinch;
  vFold = smoothstep(0.12, -0.10, jminus);

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
in vec2 vVarDrop;
in float vLod;      // local mesh edge length, metres
in float vPinch;    // 0..1 Gerstner horizontal-displacement magnitude
in float vFold;     // 0..1 Tessendorf J- fold indicator

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
uniform sampler2D tRefl;     // half-res, mipped, cloud-composited copy of the frame
uniform float uReflMaxSlope; // slope beyond which a facet adds no more reflected excursion
uniform float uUseSSR;       // below-horizon screen-space march on/off
uniform float uReflBlur;     // scale on the roughness-cone mip selection
uniform float uRefrScale;    // artistic multiplier on the PHYSICAL refraction offset

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

/* ------------------------------------------------------- in-water geometry ---- */
/** cos of the refracted (in-water) angle, given the cosine of the air-side angle to
 *  the vertical. Snell with n = 1.333; the result is bounded below by cos(48.6 deg) =
 *  0.661, so 1/cosInWater <= 1.512 no matter how grazing the air-side ray is. */
float oc_cosInWater(float cosAir){
  float sinAir2 = max(0.0, 1.0 - cosAir * cosAir);
  float sinW2 = sinAir2 / (1.333 * 1.333);
  return sqrt(max(0.0, 1.0 - sinW2));
}

/** Downwelling irradiance just under the surface, engine radiance units. Sun with the
 *  ~8% surface Fresnel loss at moderate elevation, plus the sky hemisphere (uSkyAmbient
 *  is a mean dome RADIANCE, so the hemispherical irradiance is ~pi times smaller than
 *  a naive integral — 2.6 is the fitted factor for the two-lobe average 'sky' reports). */
vec3 oc_edown(){
  return uSunColor * uSunIntensity * clamp(uSunDir.y, 0.0, 1.0) * 0.92
       + uSkyAmbient * 2.6;
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
vec3 caustics(vec2 p, float t, float depth, float rough){
  /* Project along the REFRACTED sun ray, not straight down (research 3.6.1). The
   * caustic web is cast by the surface a depth 'depth' above the bed, so the point on
   * the bed at p was lit by the surface at p - depth*tan(theta_sun')*sunAzimuth.
   * Without this the web neither slides as the sun moves nor shears on a sloping bed. */
  float cs = oc_cosInWater(clamp(uSunDir.y, 0.02, 1.0));
  float tanW = sqrt(max(0.0, 1.0 - cs * cs)) / max(cs, 1e-3);
  vec2 az = uSunDir.xz;
  float azl = length(az);
  vec2 pp = p - (azl > 1e-4 ? az / azl : vec2(0.0, 1.0)) * (depth * tanW);

  // Cell size scales with depth: the focal length of a wave lens is set by how far the
  // light travels below it. At 0.62 m^-1 the network read as a 1.6 m honeycomb, which
  // is the size of paving slabs, not of caustics in ankle-deep water.
  vec2 q = pp * (2.6 / (0.42 + 0.55 * clamp(depth, 0.0, 4.0)));
  float e = 0.016;
  vec3 c = vec3(causticNet(q + vec2(e, 0.0), t), causticNet(q, t), causticNet(q - vec2(e, 0.0), t));
  // contrast collapses with depth as the focal caustic defocuses...
  float k = exp(-depth * 0.42);
  // ...and with local slope variance: choppy water has no caustic, the glassy patch
  // between sets has a lot (research 3.6.3). rough^2 is the local mss.
  k *= 1.0 - clamp(rough * rough / 0.05, 0.0, 1.0);
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

  /* Hard land gate, before any shading. The column test below is necessary but not
   * sufficient: it only asks whether the displaced surface happens to sit above the
   * bed at this instant, so a metre of noise in the bathymetry (or any future change
   * to the wave model) can pond water in an inland hollow. This asks the question that
   * actually matters — is this pixel above the maximum run-up? — and costs one compare. */
  float bedY = oc_seabedY(vFlat);
  if (bedY > uSeaLevel + OC_RUNUP) discard;
  float column = P.y - bedY;
  if (column < -0.035) discard;

  vec3 Edn = oc_edown();     // downwelling irradiance just under the surface

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
  vec2 varLost = vVarDrop;
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
    // Same Nyquist rule as the vertex bands: full amplitude at L = 4*footprint, gone
    // at L = 2*footprint (GPU Gems ch.1 1.3.3).
    float vis = smoothstep(2.0 * fp, 4.0 * fp, Ld);
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

  /* Two scrolling detail scales for the sub-0.09 m skin. Was three; the third (tile
   * 0.17 m) sat one octave below the second and measurably did nothing — water-ROI
   * lap_var moved 0.2% with oceanDetail=0 — so it was pure cost. Tiles are 0.55 m and
   * 0.16 m, a ratio of 3.4, inside research 5.4's 3-5x rule (2x aliases against mip
   * levels, 10x leaves a visible gap in the slope spectrum). */
  float dAmp = uDetailAmount * (0.55 + 0.45 * smoothstep(6.0, 0.6, h));
  vec2 w = uWind * 0.03;
  vec2 ds = vec2(0.0);
  float dv;
  dv = smoothstep(2.0 * fp, 4.0 * fp, 0.55);
  if (dv > 0.002) ds += dv * 0.030 * dAmp * detailSlope(vFlat, 0.55, w + vec2(0.13, 0.34), uTime);
  dv = smoothstep(2.0 * fp, 4.0 * fp, 0.16);
  if (dv > 0.002) ds += dv * 0.018 * dAmp * detailSlope(vFlat * 1.03 + 17.0, 0.16, w * 1.7 + vec2(-0.29, 0.21), uTime);
  tx.y += ds.x; tz.y += ds.y;
  // whatever the two tiers could not carry stays as roughness, not as nothing
  varLost += vec2(1.6e-4) * dAmp * dAmp * (1.0 - smoothstep(2.0 * fp, 4.0 * fp, 0.16));

  vec3 N = normalize(cross(tz, tx));
  /* Flip ONLY when the eye is genuinely under the surface.
   *
   * This used to be: if (!gl_FrontFacing) N = -N;  -- and with side: DoubleSide on a
   * rippled surface seen at grazing incidence, whether a given triangle is back-facing
   * flips PER TRIANGLE. A flipped N gives dot(N,V) < 0, so ndv clamps to 0 and F goes
   * to 1.0 (pure mirror), while R = reflect(-V,N) points DOWN so 'below' goes to 1 and
   * the mirror returns the near-black deep-water body. Front-facing neighbours return
   * bright sky. That is a hard, straight-edged, per-triangle bright/dark shatter across
   * the whole mid field — and it got dramatically worse in this pass, because correcting
   * uScatterCol made the dark side ~10x darker.
   *
   * The tangent frame cannot produce a downward normal on its own: tx ~ (1,.,.) and
   * tz ~ (.,.,1), so cross(tz,tx).y is +1 minus the loop-budget sum, which GPU Gems'
   * constraint (now actually enforced, see oc_wave) keeps below 1. So the only correct
   * reason to flip is being underwater. */
  if (uCamPos.y < P.y) N = -N;

  /* Filtered roughness (Toksvig / LEAN): the slope variance the LODs removed IS the
   * roughness. For an isotropic Beckmann/GGX lobe mss = alpha^2 exactly (research 5.3),
   * so alpha = sqrt(mss) — the old sqrt(2*mss) was a factor of 1.41 too rough. Per axis
   * sigma_a^2 = alpha_a^2/2, hence the sqrt(2) there and NOT here. */
  float vX = varLost.x, vZ = varLost.y;
  float rough = clamp(sqrt(max(vX + vZ, 0.0)) + 0.004, 0.004, 0.62);
  float alphaX = clamp(sqrt(2.0 * vX) + 0.004, 0.004, 0.7);
  float alphaZ = clamp(sqrt(2.0 * vZ) + 0.004, 0.004, 0.7);

  /* ---- refraction + absorption -------------------------------------------------
   * The screen-space offset of the refracted seabed tap, in metres of LATERAL
   * displacement at the bed, is
   *     d ~ column * tilt * (1 - 1/n)        (n = 1.333, so the factor is 0.25)
   * and a world offset d at range viewDist subtends d/viewDist radians, which is
   * d/viewDist * P11/2 in UV. Everything on the right is known here.
   *
   * The old form was (0.055 + 0.30*thick) / max(viewDist*0.22, 1.0) applied to the
   * raw view-space normal — which is ~0.77 for flat water seen at 50 deg, not a tilt.
   * In the near field (viewDist < 4.5, so the divisor pinned at 1.0) with thick at its
   * 3 m clamp that is an offset of up to **0.955 in UV — essentially the whole frame**.
   * The ok test rejects the taps that land on sky, but a tap that lands on distant
   * terrain below the horizon passes it, and the result is a smear of an unrelated part
   * of the image stamped into the near water. That is a large part of the shard hash.
   *
   * Physically the correct number is small: 0.5 m of water at 5 m range with a 0.05
   * slope displaces the bed by 6 mm, about one pixel. uRefrScale is the artistic
   * multiplier on top of the physical value. */
  vec3 Nv  = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  vec3 Nv0 = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec2 dNv = Nv.xy - Nv0.xy;                       // view-space tilt, ~= the slope angle
  float thick = clamp(column, 0.0, 3.0);
  float offScale = thick * 0.25 * (projectionMatrix[1][1] * 0.5)
                 / max(viewDist, 0.5) * uRefrScale;
  vec2 roff = clamp(dNv * offScale, vec2(-0.06), vec2(0.06));
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

  /* ---- water column: Beer-Lambert on the SNELL-REFRACTED in-water path -----------
   * Light must go down to the bed and back up, and BOTH legs are refracted. Even at
   * 90 deg incidence the in-water angle is capped at asin(1/1.333) = 48.6 deg, so
   * 1/cos(theta') <= 1.51 and the in-water path can never exceed 1.51 * depth per leg.
   * That is why real water stays legible at grazing angles.
   *
   * What was here instead was the AIR-side geometry: column/max(-vd.y, 0.030), i.e. up
   * to 33x column, and distance(bgPos,P), the full 3D slant. With K.r = 0.365 and the
   * 55 m clamp that gave exp(-20) — the bottom term was annihilated everywhere past
   * the swash, which is research/ocean.md failure mode 3 ("the whole distant sea is
   * opaque navy") and is why --skip terrain moved the near-field patch by only 9% on a
   * pixel that should be ~90% seabed. */
  float pathView;
  vec3 vd = (P - uCamPos) / max(viewDist, 1e-4);
  float cosViewW = oc_cosInWater(max(-vd.y, 0.0));
  pathView = column / cosViewW;                     // <= 1.51 * column, no clamp needed
  if (bgIsSky){
    // No seabed in the depth buffer (terrain has not landed, or we are looking past
    // the bathymetry rectangle). Synthesise one so the water still reads as water.
    bgPos = P + vd * min(pathView, 55.0);
    refr = oc_fallbackBottom(bgPos.xz, column) * Edn * 0.3183098;   // albedo -> radiance
  }
  float sunPath = column / oc_cosInWater(clamp(uSunDir.y, 0.02, 1.0));
  /* Diffuse sky downwelling arrives from the whole hemisphere; averaged over the
   * refracted hemisphere its mean slant is ~1.19 * depth, near enough to 1.25. */
  float skyPath = column * 1.25;

  vec3 Tview = exp(-uExtinction * pathView);
  vec3 Tdown = mix(exp(-uExtinction * sunPath), exp(-uExtinction * skyPath), 0.40);

  /* caustics ride on the seabed, so they belong on the refracted sample */
  if (uCausticAmount > 0.001 && column < 9.0){
    vec3 cst = caustics(bgPos.xz, uTime, column, rough);
    refr *= mix(vec3(1.0), cst, smoothstep(9.0, 0.6, column) * clamp(uSunDir.y * 1.6, 0.0, 1.0));
  }

  /* Optically-shallow-water form (Lyzenga 1978 / research 3.1, 3.4):
   *   L_up = bottom * T_two_way + L_deep * (1 - T_two_way)
   * The (1-T) weight is what stops a blue haze being added on top of bright shallow
   * sand. uScatterCol is now the derived DEEP_SCATTER (0.004, 0.030, 0.075) rather
   * than (0.048, 0.300, 0.345) — 10x the green and 4.6x the blue — which was
   * saturating the volume term before the bottom term had died and turning the whole
   * near field opaque navy. */
  vec3 T2 = Tview * Tdown;
  vec3 Ldeep = uScatterCol * Edn;
  vec3 body = refr * T2 + Ldeep * (vec3(1.0) - T2);

  /* ---- reflection ---------------------------------------------------------------
   * PREFILTERED PLANAR TAP, not a point sample of a full-res frame.
   *
   * The old code projected the fully perturbed reflected direction Rs to infinity and
   * read tOpaque at that UV. At this FOV a +-10 deg normal perturbation moves the tap
   * by +-20 deg of screen — about a third of the frame — and there was no filtering at
   * all beyond a <=12% lerp toward one constant. Measured: the module tripled water-ROI
   * lap_var (296 -> 970, +43% OVER the signature's 677) while REDUCING local_contrast
   * (0.086 -> 0.078, -45% under the signature). That combination is manufacturing
   * pixel-scale hash, not structure, and it looked like crumpled foil.
   *
   * Replaced with the two things three's own Water.js does and this did not:
   *   1. the base tap is the FLAT mirror direction (stable, one smooth screen field),
   *      and the wave slope only adds a bounded offset
   *        distortion = N.xz * (0.001 + 1/dist) * scale
   *      whose 1/dist term is what stops distant water sampling from wildly wrong
   *      places (research 5.2, verified against the r0.185.1 source);
   *   2. the lookup is a MIP of a half-res prefiltered copy, with the level chosen from
   *      the roughness cone, so a rough facet GATHERS instead of point-sampling. */
  vec3 R = reflect(-V, N);
  /* A facet steeper than the view depression sends the reflected ray *below* the
   * horizon, where it meets the back of the next crest at near-normal incidence —
   * Fresnel a few percent — so what returns is the absorbed body, not dimmed sky. */
  /* The ramp has to match the ANGULAR SCALE OF THE SEA it is describing: a ray a little
   * below the horizon meets the next crest at grazing incidence and comes back mostly
   * bright, and only a ray well below it strikes near-normal and returns the absorbed
   * body. The rms slope of this sea is sqrt(mss) = 0.10, so the transition belongs over
   * roughly R.y in [0, -0.15], not [0, -0.038]. The previous 26.0 was fitted while
   * chasing shadow_frac, and against the corrected (10x darker) deep-water colour it
   * snaps between bright sky and near-black inside one facet. */
  float below = smoothstep(0.0, -0.15, R.y);
  vec3 deepBody = uScatterCol * Edn * 0.42;

  /* ONE bounded reflection direction, used for BOTH the cube and the screen tap.
   *
   * The first version of this fix bounded only the screen tap (Water.js's UV rule) and
   * left the cube sampled with the raw perturbed R. Near-field water at ~25 deg
   * depression projects its reflection above the top of the frame, so it falls through
   * to the cube every time — and the cube tap was still swinging +-20 deg of sky per
   * +-10 deg of facet, across the limb of a very large, very bright gas giant. Measured
   * result: hard pink/blue facets over the whole near field, near-patch blue 110.7.
   *
   * Bound the SLOPE instead of the UV: a facet steeper than uReflMaxSlope contributes no
   * further reflected excursion. That is one clamp, it is expressed in the units the
   * problem is actually in (surface slope), and it applies identically to both taps. */
  vec2 slopeR = vec2(N.x, N.z) / max(N.y, 0.25);
  float slopeLen = length(slopeR);
  slopeR *= min(1.0, uReflMaxSlope / max(slopeLen, 1e-5));
  vec3 Nr = normalize(vec3(slopeR.x, 1.0, slopeR.y));
  vec3 Rr = reflect(-V, Nr);

  // Cube fallback, clamped to the horizon.
  vec3 Rs = vec3(Rr.x, max(Rr.y, 0.0) + 0.002, Rr.z);
  vec3 refl = texture(tSky, Rs).rgb;

  if (Rs.y > 0.004){
    vec4 ci = uViewProj * vec4(Rs, 0.0);
    if (ci.w > 1e-6){
      vec2 uvi = (ci.xy / ci.w) * 0.5 + 0.5;
      vec2 e = min(uvi, 1.0 - uvi);
      float on = smoothstep(0.0, 0.035, min(e.x, e.y));
      if (on > 0.0){
        vec2 uc = clamp(uvi, vec2(0.002), vec2(0.998));
        /* Roughness cone -> mip level. The reflected lobe spreads over ~2*rough
         * radians; pxPerRad converts that to full-res pixels, and the prefiltered
         * copy is half res, so the texel radius is rough*pxPerRad. */
        float pxPerRad = projectionMatrix[1][1] * 0.5 / max(uInvRes.y, 1e-6);
        float lod = log2(max(1.0, rough * pxPerRad * uReflBlur));
        refl = mix(refl, textureLod(tRefl, uc, lod).rgb, on);
      }
    }
  }

  /* Below-horizon geometry: the sea stacks and the wet beach. kf_01800's water ROI gets
   * a large share of its lum_std (45.4 against our 18.1) and essentially ALL of its
   * shadow_frac (0.0206 against our 0.0004) from dark reflected rock — look at the crop,
   * the dark streaks under the stacks are the single highest-contrast thing in it.
   *
   * OFF BY DEFAULT (config oceanSSR=1 to enable), and this time the experiment that
   * settles it is run on the metric the term is supposed to serve, not on lap_var alone.
   * The critic's evidence against the old 22-step march was that oceanSSR=0 moved
   * lap_var by 0.35%, which says nothing about lum_std or shadow_frac. So I restored it
   * leaner (14 steps) and re-measured everything. Water ROI at ref_01800, one window:
   *
   *   off -> on:  lum_std 18.1 -> 26.3,  p99 166 -> 181         (the wanted direction)
   *               lap_var 408 -> 4802,   edge_density 0.047 -> 0.229
   *               spectral_slope -2.10 -> -1.14,  local_contrast 0.0543 -> 0.0566
   *               shadow_frac 0.00040 -> 0.00059  (target 0.0206 — it did not move)
   *
   * A spectral slope of -1.14 is white noise. A binary per-pixel hit test marched with a
   * 1.55x geometric step over a rippled surface is salt-and-pepper by construction:
   * neighbouring pixels hit and miss. It costs 4400 lap_var to buy 0.002 of
   * local_contrast, and the shadow_frac it was restored for did not move at all.
   *
   * Kept behind the flag because the IDEA is right — the reference's dark water really
   * is reflected sea stack — but it needs a filtered, temporally stable resolve, not a
   * per-pixel march. */
  if (uUseSSR > 0.5 && viewDist < 120.0 && Rr.y < 0.14){
    float t = 0.08, dt = 0.14;
    vec3 hitC = vec3(0.0); float hit = 0.0;
    for (int i = 0; i < 14; i++){
      t += dt; if (i >= 5) dt *= 1.55;
      vec3 q = P + Rr * t;
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
  // A below-horizon ray still carries a real grazing reflection off the next crest, so
  // it is not purely the body: 0.82 body / 0.18 dimmed-sky was fitted against a
  // deep-water colour that was 10x too bright and reads as a hole now.
  refl = mix(refl, mix(refl * 0.45, deepBody, 0.62), below);

  /* ---- Fresnel ------------------------------------------------------------------ */
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  // No roughness knock-down here: the microfacet shadowing that a rough grazing surface
  // suffers belongs in the specular G term (where it already is), and applying it a
  // second time to the whole reflection lobe just flattened the grazing contrast.

  /* ---- sun glitter -------------------------------------------------------------
   * Anisotropic GGX whose alphas are the sub-pixel slope variances computed above, lit
   * by the sun as a DISC of angular radius 0.00465 rad (0.266 deg) via Karis's
   * representative-point approximation (Real Shading in UE4, 2013). Treating the sun as
   * a point with an alpha floor of 0.005 made the lobe narrower than the sun itself:
   * the whole track then lived inside a fraction of a pixel and was annihilated by TAA,
   * which is why water highlight_frac measured 0.0 at both poses against kf_00000's
   * 0.0247. The floor is now the sun's own angular radius, which is a physical bound. */
  vec3 L0 = normalize(uSunDir);
  // representative point on the sun disc closest to the mirror direction
  vec3 ctr = dot(L0, R) * R - L0;
  float ctrLen = length(ctr);
  vec3 L = normalize(L0 + ctr * clamp(OC_SUN_R / max(ctrLen, 1e-5), 0.0, 1.0));
  /* Karis: widen alpha by the light's angular radius and renormalise by
   * (alpha/alphaPrime)^2 so the total energy is unchanged — the peak gets dimmer and
   * the highlight gets WIDER, which is the whole point. A lobe narrower than the sun
   * is not physical and is what TAA was eating. */
  float aX = min(alphaX + OC_SUN_R, 0.7);
  float aZ = min(alphaZ + OC_SUN_R, 0.7);
  float specNorm = (alphaX / aX) * (alphaZ / aZ);

  vec3 Hv = normalize(L + V);
  float ndl = clamp(dot(N, L), 0.0, 1.0);
  float ndh = clamp(dot(N, Hv), 0.0, 1.0);
  float vdh = clamp(dot(V, Hv), 0.0, 1.0);
  vec3 T0 = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
  vec3 B0 = cross(N, T0);
  float hx = dot(Hv, T0) / max(aX, 1e-4);
  float hz = dot(Hv, B0) / max(aZ, 1e-4);
  float dd = hx * hx + hz * hz + ndh * ndh;
  float D = 1.0 / (3.14159265 * aX * aZ * dd * dd + 1e-7);
  float kg = rough * rough * 0.5;
  float Gv = 1.0 / ((ndv * (1.0 - kg) + kg) * (ndl * (1.0 - kg) + kg) + 1e-5);
  float Fs = 0.02 + 0.98 * pow(1.0 - vdh, 5.0);
  vec3 spec = uSunColor * uSunIntensity * (D * specNorm * Gv * Fs * 0.25) * ndl * uGlitter;
  spec = min(spec, vec3(420.0));

  /* ---- sub-surface scattering in the crests -------------------------------------
   * Barre-Brisebois & Bouchard's translucency approximation (GDC 2011, Frostbite 2),
   * with thickness driven by the Gerstner HORIZONTAL-DISPLACEMENT PINCH, which is the
   * Sea of Thieves trick: where the choppiness offset is large the wave is a peak and
   * the light path through the water is short. Driving it from crest ELEVATION instead
   * (which is what was here) makes every wave top glow including flat offshore swell —
   * research/ocean.md failure mode 23, "backlit green plastic sheeting". */
  vec3 ltL = L0 + N * 0.25;                                  // LT_DISTORTION
  float ltDot = pow(clamp(dot(V, -ltL), 0.0, 1.0), 4.0) * 2.4;  // LT_POWER, LT_SCALE
  float thin = vPinch * smoothstep(0.0, 0.55, 1.0 - ndv);
  vec3 sss = vec3(0.10, 0.55, 0.45) * uSunColor * uSunIntensity
           * clamp(uSunDir.y, 0.0, 1.0) * (ltDot + 0.12) * thin * 0.030;
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
  /* env comes from the ADVECTED FIELD ONLY.
   *
   * There used to be two shading-time floors here, env = max(env, pow(vBrk,3)*0.55) and
   * a Tessendorf J- fold term. Both read VERTEX varyings, so the foam-coverage threshold
   * crossed along straight TRIANGLE EDGES and the surf zone rendered as hard-edged white
   * polygons — clearly visible at 2x in shots/oc2_H_on.png and shots/oc2_J_on.png.
   *
   * Both sources are already injected into the foam RT by FOAM_FRAG (depth-limited
   * breaking, the J- fold, shore proximity, the swash sheet and the rock waterlines),
   * where they are a smooth world-space field that advects and decays. Reading them a
   * second time, faceted, only added the facets. */
  // Never let the dissolve threshold go solid: real whitewater always has holes, and
  // an env of 1.0 drives thr negative, which returns foamCov 1.0 for every texel.
  env = min(env, 0.85);

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
    // At env 0.85 the old thr = 1.06 - 1.18*env evaluated to 0.057 against a tex
    // distribution that runs ~0.3-1.2, i.e. foamCov saturated to 1 over almost every
    // texel and the swash went solid white again. 1.15 - 0.95*env keeps the threshold
    // inside the texture's range at both ends, so foam still grows by filling holes.
    float thr = 1.15 - env * 0.95;
    foamCov = clamp(smoothstep(thr, thr + 0.30, tex), 0.0, 1.0);
    /* Foam is LIT: a rough (albedo 0.6-0.8, never 1.0) dielectric taking the sun's N.L
     * and the sky hemisphere. Unlit foam reads as fog — research/ocean.md failure mode
     * 11, and the previous foamCol had no directional term in it at all, just a flat
     * ambient + a constant slice of sun. The reference's brightest swash sits ~215. */
    float fndl = clamp(dot(N, L0), 0.0, 1.0);
    vec3 foamAlbedo = vec3(0.68, 0.70, 0.72);
    foamCol = foamAlbedo * (uSunColor * uSunIntensity * fndl * 0.3183098
                            + uSkyAmbient * 0.85);
    foamCol *= 0.60 + 0.55 * tex;
    foamCov *= uFoamAmount;
  }
  /* Foam is opaque and rough, so it KILLS the Fresnel mirror underneath — foam that
   * still reflects the sky looks like white paint on glass (research 4.4). */
  col = mix(col, foamCol, foamCov);

  /* Thin swash sheet. The module must NOT paint a bright wet sheen over the beach:
   * measured, the ocean was adding +27.8 codes to a sand ROI already +30 over target
   * and 3.3x the reference's entire sand lap_var budget. In ref/detail/sand_4k.png the
   * wet strip runs 45-90 codes against 110-140 for dry sand — wet sand is DARKER, and
   * its signature is the roughness drop, not a sheen added on top (Lekner & Dorf 1988).
   *
   * The albedo/roughness/normal part of that belongs in the terrain's own shading and
   * cannot be done from here (the foam RT already carries the wet channel in .g for
   * whoever owns it). What is left for the water shader is the sheet itself: a few
   * millimetres of near-mirror water, DARKENING what is under it, with only the
   * specular allowed to add light. */
  float sheet = smoothstep(0.16, 0.0, column);
  vec3 wetCol = bgRaw * 0.62 + refl * clamp(F, 0.0, 1.0) * 0.55 + spec * 0.35;
  col = mix(col, wetCol, sheet * 0.75);

  col = wmAerial(col, P, uCamPos);

  /* ---- coverage: soft edge instead of a polygon silhouette ---------------------
   * The waterline is where the DISPLACED surface crosses the bed, and P.y is a vertex
   * quantity linearly interpolated across a triangle, so its zero crossing is a straight
   * segment per triangle: the water/land boundary is piecewise linear at the
   * tessellation scale, ~22 px at 3 m range, and reads as hard wedges of dry beach
   * cutting into the swash.
   *
   * Widening this feather 0.055 -> 0.120 to hide that is MEASURABLY THE WRONG TRADE.
   * shoreline ROI at ref_01800, one window (shots/oc2_L_on.png vs shots/oc2_M_on.png):
   *
   *     0.055 -> 0.120:  lum_std 42.63 -> 28.71  (target 41.96)
   *                      local_contrast 0.1562 -> 0.0932  (target 0.142)
   *                      sat_mean 45.1 -> 27.4   shadow_frac 0.1518 -> 0.027
   *                      lap_var 911.6 -> 1045   (target 914.9)
   *
   * A wider feather means mix(bgRaw, col, cov) keeps more DRY BEACH over the whole swash
   * band, and the swash is where all of this module's contrast lives. Reverted. The real
   * fix is a per-pixel waterline (recompute the displaced height in the fragment shader
   * over the shallow band), not a fatter blend. */
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
  let reflRT = null, reflMat = null, reflQuad = null;
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
      Ks = Math.sqrt(Math.min(1.6, Math.max(0.3, (0.5 * c0) / Math.max(n * c, 1e-4))));
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
    // Same two-factor gate as oc_swash(): 'h' is clamped to 0 on land and therefore
    // carries no information there, so the run-up height above the local waterline
    // contour is what actually stops the surge flooding the whole map.
    const above = seabedCpu(x, z) - SEA_LEVEL;
    const shore = smooth01((2.6 - h) / 2.6) * smooth01((OCEAN_RUNUP - above) / (OCEAN_RUNUP + 0.06));
    return { y: (up - 0.42) * 0.62 * shore, front: Math.max(0, Math.cos(ph)) * shore };
  }

  /** Refracted travel direction for band i at depth h — the JS twin of the bend in
   *  oc_wave(). Physics/particles read heightAt(), so if the crests turn on the GPU and
   *  not on the CPU a grunt standing in the surf bobs to a different wave than the one
   *  drawn around him. */
  function waveDirCpu(i, x, z, h) {
    const D = waveDir[i];
    const L0 = WAVE_BANDS[i].L;
    const bend = 1 - Math.min(1, Math.max(0, h / (0.5 * L0)));
    if (bend <= 1e-4) return D;
    const e = 2.4;
    const gx = seabedCpu(x + e, z) - seabedCpu(x - e, z);
    const gz = seabedCpu(x, z + e) - seabedCpu(x, z - e);
    const m = Math.hypot(gx, gz);
    if (!(m > 1e-4)) return D;
    const f = bend * 0.85;
    const mx = D[0] * (1 - f) + (gx / m) * f;
    const mz = D[1] * (1 - f) + (gz / m) * f;
    const ml = Math.hypot(mx, mz);
    return ml > 1e-4 ? [mx / ml, mz / ml] : D;
  }

  function heightAt(x, z, t) {
    if (t === undefined) t = ctxRef ? ctxRef.clock.t : 0;
    const h = depthCpu(x, z);
    let y = SEA_LEVEL;
    for (let i = 0; i < NW; i++) {
      const w = waveCpu(i, h);
      if (w.A < 1e-4) continue;
      const D = waveDirCpu(i, x, z, h);
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
      const D = waveDirCpu(i, x, z, h);
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
   * Camera-centred radial disc. Ring spacing is 0.085 m out to 3.8 m and 2.25% of radius
   * beyond, so screen-space triangle size is roughly constant: ~0.9 m of tessellation
   * at 40 m, which resolves an 8 m shoaled crest with ten samples across its face.
   */
  function buildDisc() {
    const radii = [];
    let r = 0.18;
    while (r < 12000) { radii.push(r); r += Math.max(0.085, r * 0.0225); }
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

      /* --- prefiltered reflection target (see REFL_PREFILTER_FRAG) --- */
      reflRT = makeRT(Math.max(2, ctx.size.w >> 1), Math.max(2, ctx.size.h >> 1), {
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
      });
      reflMat = fsMaterial(REFL_PREFILTER_FRAG, {
        tSrc: { value: null },
        tCloudBuf: { value: null },
        uUseClouds: { value: 0 },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      });
      reflQuad = new FullScreenQuad(reflMat);

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
        uLodStart: { value: 1.0 },

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
        tRefl: { value: reflRT.texture },
        uReflMaxSlope: { value: 0.22 },
        // OFF by default — measured broadband hash, see the note above the march.
        uUseSSR: { value: 0 },
        uReflBlur: { value: 1.0 },
        uRefrScale: { value: 3.0 },

        /* Pope & Fry (1997) pure-water absorption band-averaged over sRGB primaries is
         * (0.39, 0.045, 0.010) m^-1; a real lagoon carries CDOM and resuspended
         * carbonate fines on top, giving research/ocean.md's clear-tropical value
         * (0.45, 0.090, 0.045) m^-1. K_B = 0.045 sits between Jerlov IA and IB. These
         * apply to the SNELL path, which is why the numbers can be this large without
         * annihilating the bottom term the way the old air-side path did. */
        uExtinction: { value: new THREE.Vector3(0.45, 0.090, 0.045) },
        /* DEEP_SCATTER: what open water backscatters, as a factor on the downwelling
         * irradiance. Was (0.048, 0.300, 0.345) — 10x the derived green and 4.6x the
         * derived blue — so the volume term saturated before the bottom term had died
         * and the near field went opaque navy. */
        uScatterCol: { value: new THREE.Color(0.004, 0.030, 0.075) },
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
        uniforms.tDepth.value = depthRT.texture;

        /* Prefilter the opaque frame for the reflection tap: half res, cloud
         * composited, full mip chain. three regenerates the mips at the end of
         * WebGLRenderer.render(), which FullScreenQuad.render() goes through, so this
         * one draw leaves the whole chain valid. */
        const rw = Math.max(2, pipe.w >> 1), rh = Math.max(2, pipe.h >> 1);
        if (reflRT.width !== rw || reflRT.height !== rh) reflRT.setSize(rw, rh);
        reflMat.uniforms.tSrc.value = pipe.opaqueRT.texture;
        reflMat.uniforms.tCloudBuf.value = uniforms.tClouds.value;
        reflMat.uniforms.uUseClouds.value = uniforms.uUseClouds.value;
        reflMat.uniforms.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
        renderer2.setRenderTarget(reflRT);
        reflQuad.render(renderer2);
        renderer2.setRenderTarget(prevRT);
      };

      ctx.scene.add(mesh);

      ctx.config.oceanWaveScale = ctx.config.oceanWaveScale ?? 1.0;
      ctx.on('config', ({ k, v }) => {
        if (k === 'oceanWaveScale') { waveScale = v; uniforms.uWaveScale.value = v; foamMat.uniforms.uWaveScale.value = v; primed = false; }
        if (k === 'oceanFoam') uniforms.uFoamAmount.value = v;
        if (k === 'oceanGlitter') uniforms.uGlitter.value = v;
        if (k === 'oceanCaustics') uniforms.uCausticAmount.value = v;
        if (k === 'oceanDetail') uniforms.uDetailAmount.value = v;
        if (k === 'oceanReflBlur') uniforms.uReflBlur.value = v;
        if (k === 'oceanRefrScale') uniforms.uRefrScale.value = v;
        if (k === 'oceanReflSlope') uniforms.uReflMaxSlope.value = v;
        if (k === 'oceanSSR') uniforms.uUseSSR.value = v ? 1 : 0;
        if (k === 'oceanExtinction') uniforms.uExtinction.value.fromArray(v);
        if (k === 'oceanScatter') uniforms.uScatterCol.value.fromArray(v);
        if (k === 'oceanLod') uniforms.uLodStart.value = v;
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
      reflRT?.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
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
      reflRT?.dispose();
      reflQuad?.dispose();
    },
  };
}
