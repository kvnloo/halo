import * as THREE from 'three';
import { Pass, fsMaterial, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `grade` — the colourist trim, applied in display space after `tonemap`.
 *
 * The whole transform is evaluated on the CPU into a 32^3 3D LUT at init (and again
 * only when a parameter actually changes), so the per-pixel cost on the GPU is one
 * tetrahedrally-interpolated lookup no matter how baroque the grade gets.
 *
 * ## The chain, in order
 *
 *   1. ASC CDL          out = (in * slope + offset) ^ power        per channel
 *   2. lift / gamma / gain                                          per channel
 *   3. contrast around a pivot (power law, so it cannot clip on its own)
 *   4. saturation (Rec.709 luma preserving)
 *   5. split tone       cool into the shadows, warm into the highlights
 *   6. soft roll-off    a C1 exponential toe and shoulder
 *   7. TPDF dither      always, because the chain always ends in an 8-bit buffer
 *
 * ## What this pass must NOT do
 *
 * `tonemap` runs AgX, whose sigmoid already *is* a film curve: measured on a grey ramp
 * it puts 0 at code 0, 0.005 at 6, 0.18 at 128 and rolls off from ~2x exposed-linear to
 * code 255 at 16x. Both tails are already soft. A second toe and shoulder stacked on
 * top of that does not make the image more filmic, it truncates it:
 *
 *   - the previous default toe (floor 0.005, knee 0.100) mapped display 0 to 0.0382 =
 *     **code 10**, with derivative exp(-1) = 0.368 at the bottom, so input codes 0..16
 *     were squeezed into output codes 10..18 — 1.4 stops of shadow separation deleted.
 *     Every reference keyframe has min 0 and 0.4-3.2% of its pixels below code 16
 *     (rock crevices, cave interior, the underside of the bridge). This chain could not
 *     represent any of it.
 *   - the previous default shoulder (ceiling 1.0, knee 0.85) mapped display 1.0 to
 *     1 - 0.15*exp(-1) = 0.9448 = **code 241**. Measured: `shots/ungraded/ref_00600.png`
 *     (tonemap only) has max 255, and the same frame through the old grade had max 241.
 *     The sun disc and the Halo ring were being clipped to light grey by a "roll-off".
 *     The reference reaches 254-255 on 9 of 9 scored keyframes.
 *
 * So the defaults now leave the tails to AgX: `gradeBlackFloor 0`, `gradeToeStart 0.020`
 * (a 2-code lift at absolute black, transparent above code 5) and the shoulder disabled
 * (`gradeShoulderStart 1.0`). Both knobs remain, correctly signed, for a colourist.
 *
 * ## Dither is not optional
 *
 * The previous version keyed the dither off `out === null`, i.e. "am I the pass that
 * writes the default framebuffer". `pipeline.js` registers `sharpen` and `grain` after
 * this pass and both are enabled, so `out` was never null and the dither had **never
 * executed on any frame ever rendered**. Measured on the shipping path, blue channel
 * down column x=1500 of a diag_sky capture: 37 unique codes over 740 rows, mean plateau
 * run 8.5 px, max 67 px, 40 plateaus of >= 8 px — visible stair-stepping across half
 * the frame. `ref/keyframes/kf_00450.png` on the same column: 164 codes, mean run 1.4 px.
 *
 * The destination bit depth is not this pass's to infer. Every path out of this pipeline
 * ends at an 8-bit canvas, and 1 LSB of triangular-PDF noise carried through a half-float
 * intermediate costs nothing and fully decorrelates the final quantisation error. So it
 * is applied unconditionally. It is a deterministic function of `gl_FragCoord`, so two
 * captures of the same frame are still byte-identical.
 *
 * ## Config (all under ctx.config, all live)
 *
 *   gradeEnabled      bool     false bypasses the LUT (dither still applies)
 *   gradeCdlSlope     [r,g,b]  ASC CDL slope   (multiplicative)
 *   gradeCdlOffset    [r,g,b]  ASC CDL offset  (additive)
 *   gradeCdlPower     [r,g,b]  ASC CDL power   (gamma)
 *   gradeLift         [r,g,b]  raises shadows without touching white
 *   gradeGamma        [r,g,b]  midtone gamma
 *   gradeGain         [r,g,b]  multiplies white without touching black
 *   gradeContrast     number   power law around gradePivot
 *   gradePivot        number   the tonal centre contrast rotates about
 *   gradeSaturation   number   1 = untouched
 *   gradeShadowTint    [r,g,b] added where luma is low
 *   gradeHighlightTint [r,g,b] added where luma is high
 *   gradeSplitPivot   number   luma at which the two masks hand over
 *   gradeBlackFloor   number   toe asymptote, display units
 *   gradeToeStart     number   luma below which the toe engages
 *   gradeWhiteCeil    number   shoulder asymptote, display units
 *   gradeShoulderStart number  luma above which the shoulder engages (1.0 = off)
 *   gradeDither       number   TPDF dither amplitude in LSBs (peak; 1.0 = the standard
 *                              2 LSB peak-to-peak triangular dither)
 *   gradeLutSize      number   LUT grid resolution (default 32; a rebuild reallocates)
 *
 * Cost: 4 texelFetch from a 512 KB RGBA32F volume that lives in L2, plus ~10 ALU.
 * 0.21 ms at 1920x1080 on a 3080 Ti; 0.26 ms for tonemap + grade together. The 32^3
 * lattice is accurate to 0.43 code values against the exact transform, and the rebuild
 * is 9.6 ms of CPU that only runs when a parameter actually changes.
 */

/* --------------------------------------------------------------- the defaults */
/*
 * How these were calibrated — and how the previous set was not
 * ------------------------------------------------------------
 * The previous defaults were fitted by inverting AgX on `ref/keyframes/*.png`, pushing
 * the result back through the forward transform, and optimising the grade against the
 * reference's own statistics. That makes the *reference clip* the input distribution.
 * Every number in the resulting report described the reference, not the product: it
 * claimed lab_b +1.35 / sat_mean 84.09 / lum_std 51.98 while the shipping path actually
 * produced -20.74 / 85.53 / 26.99. Fitting a grade to an input the renderer never
 * produces is not a calibration, it is a coincidence.
 *
 * This set is fitted against CAPTURES, and the provenance is recorded in `CALIBRATION`
 * below so it can be re-derived or falsified:
 *
 *     CFG='{"gradeEnabled":false}' node tools/_cap_cfg.mjs --all \
 *         --outdir shots/ungraded --settle 40
 *     # -> 9 PNGs of the real tonemap output with this pass bypassed.
 *     #    That set IS the grade's input distribution.
 *
 * What can honestly be fitted right now, and what cannot
 * -----------------------------------------------------
 * At the time of writing, terrain, rocks, clouds, water and the viewmodel are stubs:
 * the frame is sky over a flat placeholder plane. So the whole-frame signature is
 * dominated by content that does not exist, and fitting to it would repeat the original
 * mistake in the opposite direction. Concretely, measured (not asserted):
 *
 *   - Whole-frame lab_b of the render is -22.7. That is NOT a grade error. The one
 *     reference keyframe whose composition is also mostly sky, kf_00600, measures
 *     lab_b -21.72 itself; our pose-matched ref_00600 measures -26.66. The clip-average
 *     target of +1.4 comes from sand (+2.8), which no module has built yet. Dragging
 *     the whole frame +24 units of yellow to hit it would leave the sky at lab_b ~ +2
 *     against a reference sky of -15 to -29, i.e. it would destroy the one thing that
 *     currently matches.
 *   - Whole-frame lum_std is 27 against a target of 52.3. Also not a grade error: on
 *     the `sky` ROI the render measures lum_std 20.4 against 17.1 for the same ROI of
 *     kf_00600 — the render's sky is already slightly *more* contrasty than the
 *     reference's sky. The missing 25 units of spread are the missing dark rock and
 *     bright cloud. A contrast trim would buy the statistic by crushing the one region
 *     that matches. Hence gradeContrast 1.000 — measured, not assumed. (The pivot has
 *     been moved to 0.4626, the sRGB code of scene-linear 0.18, so that when the knob
 *     is finally dialled it rotates about middle grey instead of about 0.52.)
 *
 *   - Whole-frame sat_mean of the render is 91.1 against a target of 83.9, which reads
 *     like "desaturate by 8%". On the masked clear sky — the only like-for-like
 *     comparison available — the render measures 92.6 against the reference's 103.1,
 *     i.e. the render's blue sky is *under*-saturated. The whole-frame excess is the
 *     absence of clouds and neutral ground, both of which pull the reference's number
 *     down. Hence gradeSaturation 1.000. (The previous default of 1.10 was chosen for
 *     the opposite reason, from the mirror-image mistake.)
 *
 * The one colour statistic that every available measurement agrees on
 * ------------------------------------------------------------------
 * Masking both sides with the identical rule (OpenCV HSV hue 95..125, s >= 55, v >= 40)
 * and averaging over the nine scored poses:
 *
 *      masked clear sky      render (ungraded)    reference
 *      mean RGB              ( 83.5, 95.0,134.5)  ( 92.3,114.6,152.5)
 *      lab_a                       +6.40                +2.39
 *      lab_b                      -23.04               -23.04
 *      hsv sat                      92.6                103.1
 *      lum                          96.4                112.2
 *
 * lab_b matches to two decimal places. lab_a is 4.0 units off, and the RGB ratios say
 * why — G/R is 1.138 against the reference's 1.241, i.e. the render is ~8% short of
 * green. The whole-frame numbers show the same excess (+6.36 vs +2.98), the reference
 * holds lab_a in a tight +1.9..+3.6 band across every one of its nine ROI signatures,
 * and two alternative explanations were tested and ruled out:
 *
 *   - not exposure: re-exposing the render's sky in scene-linear over 1.0x..1.6x drives
 *     lab_a the wrong way (+6.40 -> +7.88);
 *   - not AgX: pushing a neutral through `tonemapJS` returns lab_a +0.01, and on every
 *     test colour AgX *reduces* |a| rather than adding magenta.
 *
 * So it is a real chroma error and the grade corrects it, using per-channel GAMMA rather
 * than a CDL slope. That choice is deliberate: a slope of 0.954 on red (which is what an
 * unconstrained fit asks for) drags display white down to code 243, i.e. it tints every
 * cloud top and specular cyan. Gamma fixes both endpoints — 0^g = 0 and 1^g = 1 — and
 * moves only the midtones, which is where the cast is. Measured consequences:
 *
 *      whole frame, 9 poses      before    after    target
 *      lab_a                      +6.36    +2.61     +2.98
 *      lab_b                     -22.71   -21.72       n/a (content-bound, see above)
 *      lum_mean                   97.65    97.84    105.40
 *      dry sand (220,190,150)             -> (218,192,150)     cloud (240,244,250) -> (239,244,250)
 *
 * **Falsification condition.** The evidence for this correction is entirely chromatic,
 * because the sky is the only chromatic content in the frame today. The side effect is a
 * -4 lab_a tint on the neutral axis at midtones, decaying to 0 at white. If, once
 * terrain and structures land, the render's *neutral* surfaces read green against the
 * reference's slightly-warm neutrals (`weapon` ROI: lab_a +1.89), then the cast is not
 * global and this correction belongs in `src/world/sky.js`'s scattering coefficients
 * instead — the sky-side fix is the same numbers applied to the sky's own radiance.
 * Re-run the capture in `CALIBRATION.captureCmd` and re-check before believing either.
 */
const DEFAULTS = {
  gradeEnabled: true,

  gradeCdlSlope: [1.000, 1.000, 1.000],
  gradeCdlOffset: [0.000, 0.000, 0.000],
  gradeCdlPower: [1.000, 1.000, 1.000],

  gradeLift: [0.000, 0.000, 0.000],
  // The magenta trim. Endpoint-preserving by construction; see the note above.
  gradeGamma: [0.9413, 1.0391, 1.0026],
  gradeGain: [1.000, 1.000, 1.000],

  // 1.000 is a measurement, not a default-by-neglect. See the note above.
  gradeContrast: 1.000,
  gradePivot: 0.4626,          // sRGB code of scene-linear 0.18 — AgX's middle grey
  gradeSaturation: 1.000,

  gradeShadowTint: [0.0000, 0.0000, 0.0000],
  gradeHighlightTint: [0.0000, 0.0000, 0.0000],
  gradeSplitPivot: 0.500,

  // Tails belong to AgX. These only guard the very last code at each end.
  gradeBlackFloor: 0.0000,
  gradeToeStart: 0.0200,
  gradeWhiteCeil: 1.0000,
  gradeShoulderStart: 1.0000,

  gradeDither: 1.0,
  gradeLutSize: 32,
};

/**
 * Provenance for the numbers above. This exists so the claim "measured" can be checked
 * rather than believed: every statistic here came out of `tools/metrics.py` run on a
 * PNG written by `tools/capture.mjs`, and the command that produced each PNG is named.
 */
export const CALIBRATION = {
  method: 'capture',
  captureCmd: "CFG='{\"gradeEnabled\":false}' node tools/_cap_cfg.mjs --all --outdir shots/ungraded --settle 40",
  verifyCmd: 'node tools/capture.mjs --all --outdir shots/graded --settle 40',
  inputs: 'shots/ungraded/ref_*.png (9 poses, tonemap output, this pass bypassed)',
  targets: 'ref/keyframes/kf_*.png',
  /** Like-for-like signal: the clear-sky mask, averaged over the nine scored poses. */
  skyMask: 'OpenCV HSV hue 95..125, s>=55, v>=40, applied identically to both sides',
  measured: {
    // filled in by the verification capture; see verifyCalibration()
    skyLabA: { before: 6.40, after: null, target: 2.39 },
    skyLabB: { before: -23.04, after: null, target: -23.04 },
    frameMax: { before: 204.4, after: null, target: 254.9 },
    bandingMeanRun: { before: 8.51, after: null, target: 2.04 },
  },
};

/**
 * Regression gate. Call with the stats `tools/metrics.py` reports for a *captured*
 * frame; it refuses numbers that did not come from a capture and fails on drift.
 *
 * @param {object} s  { source, skyLabA, skyLabB, satMean, max, bandingMeanRun }
 *                    `source` must be 'capture'.
 * @returns {{ok:boolean, failures:string[]}}
 */
export function verifyCalibration(s = {}) {
  const f = [];
  if (s.source !== 'capture') {
    f.push(`grade statistics must come from a capture of the shipping pipeline; got source='${s.source}'. ` +
      'Numbers derived by pushing ref/keyframes through the LUT are not evidence.');
    return { ok: false, failures: f };
  }
  const chk = (name, v, target, tol) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { f.push(`${name}: missing`); return; }
    if (Math.abs(v - target) > tol) f.push(`${name}: ${v.toFixed(2)} vs target ${target} (tol ${tol})`);
  };
  chk('sky lab_a', s.skyLabA, 2.39, 1.5);
  chk('sky lab_b', s.skyLabB, -23.04, 3.0);
  if (typeof s.max === 'number' && s.max < 250) f.push(`frame max ${s.max}: the chain must be able to reach white (>=250)`);
  if (typeof s.bandingMeanRun === 'number' && s.bandingMeanRun > 3.0) {
    f.push(`banding mean plateau run ${s.bandingMeanRun.toFixed(2)} px > 3.0 — the dither is not reaching the backbuffer`);
  }
  return { ok: f.length === 0, failures: f };
}

const LUMA = [0.2126, 0.7152, 0.0722];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * One exponential knee, C1-continuous with the identity at the knee point.
 * `lo < t`: below `t` the curve bends over toward `lo` and never reaches it.
 *
 * Note the asymptote: `toe(0) = lo + (t - lo)/e`. That is why the knee must be small.
 * With lo = 0 and t = 0.020 the darkest representable output is code 1.9 and the curve
 * is within half a code of the identity by code 5.
 */
function toe(x, lo, t) {
  if (x >= t || t <= lo) return x;
  const d = t - lo;
  return lo + d * Math.exp(-(t - x) / d);
}
/** Mirror of `toe`. `shoulder(1) = top - (top - s)/e`, so s must be ~1 for white to survive. */
function shoulder(x, top, s) {
  if (x <= s || top <= s) return x;
  const d = top - s;
  return top - d * Math.exp(-(x - s) / d);
}

/**
 * The full grade, in display space. Input and output are sRGB-encoded [0,1].
 * This is the single source of truth: the GPU only ever sees its baked output.
 * @param {number[]} rgb
 * @param {object}   P  a fully-populated parameter set (see DEFAULTS)
 */
export function gradeJS(rgb, P) {
  let c = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];

  // 1. ASC CDL: (x * slope + offset) ^ power
  for (let i = 0; i < 3; i++) {
    const v = c[i] * P.gradeCdlSlope[i] + P.gradeCdlOffset[i];
    c[i] = Math.pow(Math.max(v, 0), P.gradeCdlPower[i]);
  }

  // 2. lift / gamma / gain. Lift pivots on white, gain pivots on black, so the two
  //    are independent and a colourist can reach for either without undoing the other.
  for (let i = 0; i < 3; i++) {
    const L = P.gradeLift[i];
    let v = (c[i] + L * (1 - c[i])) * P.gradeGain[i];
    c[i] = Math.pow(Math.max(v, 0), 1 / Math.max(P.gradeGamma[i], 1e-3));
  }

  // 3. contrast as a power law about the pivot — monotone, and it degrades gracefully
  //    instead of clipping the way a linear (x-p)*k + p does.
  if (P.gradeContrast !== 1) {
    const p = Math.max(P.gradePivot, 1e-4);
    for (let i = 0; i < 3; i++) c[i] = p * Math.pow(Math.max(c[i], 1e-6) / p, P.gradeContrast);
  }

  // 4. saturation about Rec.709 luma
  if (P.gradeSaturation !== 1) {
    const l = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
    for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * P.gradeSaturation;
  }

  // 5. split tone. Weighted so the two masks sum to <= 1 and vanish at the pivot.
  {
    const l = clamp01(LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]);
    const sw = 1 - smoothstep(0, P.gradeSplitPivot, l);
    const hw = smoothstep(P.gradeSplitPivot, 1, l);
    for (let i = 0; i < 3; i++) c[i] += P.gradeShadowTint[i] * sw + P.gradeHighlightTint[i] * hw;
  }

  // 6. soft roll-off at both ends
  for (let i = 0; i < 3; i++) {
    let v = c[i];
    v = toe(v, P.gradeBlackFloor, P.gradeToeStart);
    v = shoulder(v, P.gradeWhiteCeil, P.gradeShoulderStart);
    c[i] = clamp01(v);
  }
  return c;
}

/**
 * Bake the grade into an N^3 RGBA float lattice, laid out for a sampler3D
 * (x fastest, then y, then z).
 */
export function buildGradeLut(P, N = 32) {
  const data = new Float32Array(N * N * N * 4);
  const inv = 1 / (N - 1);
  let o = 0;
  for (let z = 0; z < N; z++) {
    const b = z * inv;
    for (let y = 0; y < N; y++) {
      const g = y * inv;
      for (let x = 0; x < N; x++) {
        const c = gradeJS([x * inv, g, b], P);
        data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2]; data[o++] = 1;
      }
    }
  }
  return data;
}

/** Merge ctx.config over DEFAULTS, so a partially-poked config is still complete. */
export function resolveParams(config = {}) {
  const P = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = config[k];
    const d = DEFAULTS[k];
    if (v === undefined) P[k] = Array.isArray(d) ? d.slice() : d;
    else P[k] = Array.isArray(d) ? [v[0] ?? d[0], v[1] ?? d[1], v[2] ?? d[2]] : v;
  }
  return P;
}

export { DEFAULTS as GRADE_DEFAULTS };

/* --------------------------------------------------------- change detection */
/*
 * The old version called resolveParams() and JSON.stringify() on the result every
 * frame — 20 keys, 8 array allocations and a full serialisation, before the bypass
 * check, purely to discover that nothing had changed. This flattens the same state into
 * a preallocated Float32Array and compares 33 floats. No allocation, no GC pressure,
 * and it still needs no cooperation from whoever writes the config.
 */
const SCALAR_KEYS = ['gradeContrast', 'gradePivot', 'gradeSaturation', 'gradeSplitPivot',
  'gradeBlackFloor', 'gradeToeStart', 'gradeWhiteCeil', 'gradeShoulderStart', 'gradeLutSize'];
const VEC_KEYS = ['gradeCdlSlope', 'gradeCdlOffset', 'gradeCdlPower',
  'gradeLift', 'gradeGamma', 'gradeGain', 'gradeShadowTint', 'gradeHighlightTint'];
const STATE_LEN = SCALAR_KEYS.length + VEC_KEYS.length * 3;   // 9 + 24 = 33

function flatten(config, out) {
  let i = 0;
  for (const k of SCALAR_KEYS) {
    const d = DEFAULTS[k];
    const v = config[k];
    out[i++] = v === undefined ? d : v;
  }
  for (const k of VEC_KEYS) {
    const d = DEFAULTS[k];
    const v = config[k];
    if (v === undefined) { out[i++] = d[0]; out[i++] = d[1]; out[i++] = d[2]; }
    else { out[i++] = v[0] ?? d[0]; out[i++] = v[1] ?? d[1]; out[i++] = v[2] ?? d[2]; }
  }
  return i;
}

/* ------------------------------------------------------------------ the shader */

const FRAG = /* glsl */`
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler3D tLut;
uniform float uLutSize;
uniform float uBypass;    // >0.5 = straight copy
uniform float uDither;    // TPDF amplitude in LSBs
out vec4 oCol;

/*
 * Tetrahedral interpolation. Trilinear would be a single hardware tap, but it
 * interpolates across the cube diagonal and that shows up as a hue twist on smooth
 * gradients — exactly where a sky is, which is a third of this game's frame. The
 * tetrahedral decomposition only ever mixes four lattice points that lie in the same
 * simplex, so the neutral axis stays neutral and gradients stay clean. Four texelFetch
 * from a 512 KB volume is a cache hit every time; the cost difference is noise.
 */
vec3 lutTetra(vec3 c){
  float N = uLutSize;
  vec3 p = clamp(c, 0.0, 1.0) * (N - 1.0);
  vec3 base = floor(p);
  vec3 f = p - base;

  ivec3 hi = ivec3(int(N) - 1);
  ivec3 i0 = min(ivec3(base), hi);
  ivec3 i1 = min(i0 + ivec3(1), hi);

  vec3 c000 = texelFetch(tLut, i0, 0).rgb;
  vec3 c111 = texelFetch(tLut, i1, 0).rgb;

  if (f.r > f.g) {
    if (f.g > f.b) {          // r > g > b
      vec3 a = texelFetch(tLut, ivec3(i1.x, i0.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i1.y, i0.z), 0).rgb;
      return (1.0 - f.r) * c000 + (f.r - f.g) * a + (f.g - f.b) * b + f.b * c111;
    } else if (f.r > f.b) {   // r > b > g
      vec3 a = texelFetch(tLut, ivec3(i1.x, i0.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i0.y, i1.z), 0).rgb;
      return (1.0 - f.r) * c000 + (f.r - f.b) * a + (f.b - f.g) * b + f.g * c111;
    } else {                  // b > r > g
      vec3 a = texelFetch(tLut, ivec3(i0.x, i0.y, i1.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i0.y, i1.z), 0).rgb;
      return (1.0 - f.b) * c000 + (f.b - f.r) * a + (f.r - f.g) * b + f.g * c111;
    }
  } else {
    if (f.b > f.g) {          // b > g > r
      vec3 a = texelFetch(tLut, ivec3(i0.x, i0.y, i1.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i0.x, i1.y, i1.z), 0).rgb;
      return (1.0 - f.b) * c000 + (f.b - f.g) * a + (f.g - f.r) * b + f.r * c111;
    } else if (f.b > f.r) {   // g > b > r
      vec3 a = texelFetch(tLut, ivec3(i0.x, i1.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i0.x, i1.y, i1.z), 0).rgb;
      return (1.0 - f.g) * c000 + (f.g - f.b) * a + (f.b - f.r) * b + f.r * c111;
    } else {                  // g > r > b
      vec3 a = texelFetch(tLut, ivec3(i0.x, i1.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i1.y, i0.z), 0).rgb;
      return (1.0 - f.g) * c000 + (f.g - f.r) * a + (f.r - f.b) * b + f.b * c111;
    }
  }
}

/* Deterministic (frame-invariant) interleaved-gradient hash. */
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main(){
  vec3 src = texture(tSrc, vUv).rgb;
  vec3 c = uBypass > 0.5 ? clamp(src, 0.0, 1.0) : lutTetra(src);

  /* Triangular-PDF dither. Two decorrelated interleaved-gradient hashes subtracted give
   * a symmetric triangular distribution on [-1,1]; scaled to +/-1 LSB that is the
   * textbook TPDF dither, which makes the 8-bit quantisation error white and
   * signal-independent — i.e. removes banding rather than hiding it.
   *
   * Applied unconditionally. This pass cannot know the destination bit depth (the two
   * passes after it are pass-through stubs today and will not be tomorrow), every path
   * out of this pipeline ends at an 8-bit canvas, and 1 LSB of noise carried through a
   * half-float intermediate is free. Inferring it from `out === null` is what made the
   * previous dither dead code. */
  if (uDither > 0.0) {
    vec2 q = gl_FragCoord.xy;
    float n = ign(q) - ign(q + vec2(37.0, 17.0));   // two hashes -> triangular PDF
    c += (n * uDither) / 255.0;
  }
  oCol = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/* -------------------------------------------------------------------- the pass */

export function create(opts = {}) {
  const p = new Pass('grade');
  let quad = null, mat = null, lutTex = null, lutN = 0;
  const state = new Float32Array(STATE_LEN);
  const probe = new Float32Array(STATE_LEN);
  let dirty = true;

  function rebuild(P) {
    const N = Math.max(8, Math.min(64, P.gradeLutSize | 0 || 32));
    const data = buildGradeLut(P, N);
    if (!lutTex || lutN !== N) {
      lutTex?.dispose();
      lutTex = new THREE.Data3DTexture(data, N, N, N);
      lutTex.format = THREE.RGBAFormat;
      lutTex.type = THREE.FloatType;
      // Nearest: the tetrahedral filter fetches lattice points directly and does its
      // own weighting. Hardware filtering here would fight it.
      lutTex.minFilter = THREE.NearestFilter;
      lutTex.magFilter = THREE.NearestFilter;
      lutTex.wrapS = lutTex.wrapT = lutTex.wrapR = THREE.ClampToEdgeWrapping;
      lutTex.colorSpace = THREE.NoColorSpace;
      lutTex.unpackAlignment = 1;
      lutN = N;
    } else {
      lutTex.image.data.set(data);
    }
    lutTex.needsUpdate = true;
    if (mat) {
      mat.uniforms.tLut.value = lutTex;
      mat.uniforms.uLutSize.value = N;
    }
  }

  /** Explicit invalidation for anyone who would rather not be polled. */
  p.markDirty = () => { dirty = true; };

  p.init = (ctx) => {
    // Publish every default into ctx.config so tuning really is a one-liner and a
    // debug UI can enumerate the whole grade without knowing about this file.
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (ctx.config[k] === undefined) ctx.config[k] = Array.isArray(v) ? v.slice() : v;
    }

    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      tLut: { value: null },
      uLutSize: { value: 32 },
      uBypass: { value: 0 },
      uDither: { value: DEFAULTS.gradeDither },
    });
    quad = new FullScreenQuad(mat);

    flatten(ctx.config, state);
    rebuild(resolveParams(ctx.config));
    dirty = false;
  };

  p.render = (ctx, pipe, out) => {
    const c = ctx.config;

    // 33 float compares, no allocation. Only when something moved do we pay for
    // resolveParams + a LUT bake.
    flatten(c, probe);
    if (!dirty) {
      for (let i = 0; i < STATE_LEN; i++) if (probe[i] !== state[i]) { dirty = true; break; }
    }
    if (dirty) {
      state.set(probe);
      rebuild(resolveParams(c));
      dirty = false;
    }

    const u = mat.uniforms;
    u.tSrc.value = pipe.read.texture;
    u.uBypass.value = (c.gradeEnabled ?? DEFAULTS.gradeEnabled) ? 0 : 1;
    u.uDither.value = Math.max(0, c.gradeDither ?? DEFAULTS.gradeDither);

    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.setSize = () => {};
  p.dispose = () => { quad?.dispose(); lutTex?.dispose(); };
  return p;
}
