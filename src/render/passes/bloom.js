import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `bloom` — HDR glare: the lens/eye veiling response to light that is brighter than
 * the display can show.
 *
 * Progressive dual-filter pyramid (Jimenez, "Next Generation Post Processing in
 * Call of Duty: Advanced Warfare"):
 *
 *   scene ──13-tap Karis downsample+threshold──▶ mip0 (½ res)
 *   mip0 ──13-tap downsample──▶ mip1 ─▶ … ─▶ mip7  (1/256 res)
 *   mip7 ──9-tap tent, mix(dst, up(src), k_i)──▶ mip6 ─▶ … ─▶ mip0
 *   out = scene + mip0 * intensity
 *
 * ## 1. The threshold is expressed in the tonemapper's units, and solved for
 *
 * "Display-referred" is only meaningful if it is stated in the units the display
 * transform actually consumes. `tonemap` feeds it `exposure * MODE_GAIN * 2^EV`
 * times the scene radiance, and under AgX display white sits at an *exposed-linear*
 * ~16.3 (the top of AgX's log2 range is 0.18·2^6.5), not at 1.0. A knee at 1.12
 * exposed-linear is sRGB 206 — four stops below white, squarely in the midtones, and
 * it produces a hazy image whose glare is dominated by things that are not bright.
 *
 * So the knee is *solved* rather than guessed: `displayWhite()` inverts the active
 * display transform on its neutral axis (all three curves preserve neutrals to within
 * 1e-4, so a scalar bisection is exact) to find the exposed-linear value that lands on
 * `bloomThresholdSrgb` (default 0.80 ≈ code 204). Divide by the same
 * `exposure · MODE_GAIN · 2^EV` the tonemapper uses and you get the scene-linear knee.
 * Switch `tonemapper` to 'aces' and the knee tracks it — including MODE_GAIN, which
 * is 1.6757 for ACES and used to silently move the knee by 0.75 stops.
 *
 * There is exactly ONE threshold path. The old build had a second, differently
 * calibrated self-exposure branch selected by `(uExposure > 0) ? … : …`, and which one
 * ran depended on whether `tonemap` had resolved `ctx.config.exposure` yet — a race
 * that produced three different images from nine identical captures of the same
 * command. `tonemap` resolves the key from the live lighting rig inside its own render,
 * downstream of here, so what this pass reads is `null` on frame 0 and exactly one
 * frame old after that. One frame of lag on a knee is invisible and deterministic;
 * frame 0 simply renders without glare, and if the value is still missing several
 * frames in, tonemap is absent and the pass says so instead of silently becoming a
 * different effect.
 *
 * ## 2. The pyramid reaches exactly as far as it can pay for
 *
 * Reach is necessary but not sufficient — the *weights* decide the profile. A single
 * `mix` constant k gives near-geometric octave weights (k=0.55 → 0.45, 0.25, 0.14 …),
 * so the composite is dominated by the half-res mip no matter how many levels exist.
 * Here the octave energies are chosen first, as `w_i ∝ (i+1)^-falloff`, and the
 * per-step blend constants are derived from them: with `S_j = Σ_{m≥j} w_m`, the step
 * that upsamples mip j+1 into mip j uses `k_j = S_{j+1}/S_j`, which reproduces w
 * exactly and still sums to 1 (unit energy — `intensity` stays "fraction of glare
 * energy"). A 2-D kernel of scale s has peak density ∝ 1/s², and s doubles per octave,
 * so *equal* octave weights are exactly a 1/r² profile; `falloff` tilts around that.
 *
 * ### The measurement that set `levels` and `falloff`, and the one that must be used
 *
 * **`lum_mean` cannot verify a bloom.** A veil and a glare kernel can deposit identical
 * total energy. The only diagnostic that separates them is the *radial profile of the
 * contribution*, and it has to be measured against the shape of the above-knee source
 * rather than around a single pixel, because the bright things in this frame are cloud
 * masses tens of pixels across, not points. `tools/_glare.py` does the point version;
 * the honest one is a distance transform of the above-knee mask, and it is one command:
 *
 *     mask = luminance(bloom-off) > knee ; dist = cv2.distanceTransform(1 - mask)
 *     mean of (bloom-on − bloom-off) in bands of `dist`
 *
 * Measured that way at `ref_00120` (mean added code values by distance from the mask):
 *
 *     distance px          0     1     2     4     8    16    32    64   128   256
 *     6 levels, falloff 0.75   +0.17 +0.52 +0.91 +1.01 +0.98 +0.82 +0.74 +0.66 +0.33 +0.02
 *     4 levels, falloff 1.80   +3.85 +6.08 +7.42 +7.21 +6.29 +3.86 +1.66 +0.56 +0.03 +0.00
 *
 * The first row is **flat within a code value from 2 px to 128 px** — a DC offset, not a
 * kernel. Its peak-to-64px ratio is 1.5. The second falls by more than two orders of
 * magnitude over the same range, ratio 13, which is what "small hot cores with a few
 * pixels of bleed" actually measures like. Whole-frame it also moves the three axes in
 * the directions this header names as the pass working rather than veiling: `lum_std`
 * +0.58, `local_contrast` +0.0030, `p99` 221 → 226, `highlight_frac` 0.0086 → 0.0105.
 * The six-level version moved `lum_std` by +0.04 and `p99` by 0.
 *
 * **Why six levels at falloff 0.75 was a veil.** The octave weights are
 * [0.339 0.202 0.149 0.120 0.101 0.089]: octaves 3-5 carry 31% of a unit-energy pyramid
 * spread over areas 64x to 4096x larger than octave 0, so their *surface brightness* is
 * a rounding error and their only visible effect is to lift everything. Four levels at
 * falloff 1.80 gives [0.663 0.190 0.092 0.055] — octave 0 carries **66%** — and the
 * cumulative support dies at ~128 px, measured, which is where the profile above reaches
 * zero. Two downsample/upsample pairs were also being paid for and are now gone.
 *
 * ### The knee had to come down four stops
 *
 * `bloomThresholdSrgb 0.97` solves to display code 247. This frame's p99 is 188-221
 * depending on where the concurrent scene work has left the exposure, and **0.035% of
 * pixels exceed code 240**: the knee sat above essentially the entire highlight
 * population and almost nothing crossed it, so the pass was inert by construction. At
 * `ref_01500` `highlight_frac` is 4.1e-5 and it was mathematically inert. The shipped
 * value is now **0.85** (code 217), which on a measured frame selects ~0.25% of pixels —
 * the specular/cloud-top population this scene actually has. The reference agrees:
 * kf_00120 has no sun disc in it either and still carries obvious veiling glare on the
 * wet sand and the cliff rim, from ordinary speculars sitting just above display white.
 *
 * This number is exposure-coupled and therefore **owed a re-check whenever the scene's
 * highlight population moves**: the concurrent `volumetricFog` fix changes `p99` and
 * `highlight_frac`, and any change to `exposureEV` moves the whole population past a
 * fixed knee. Verify with the radial profile above, never with `lum_mean`.
 *
 * What this pass is NOT responsible for: the *sun disc*. Glare is the response to a
 * bright object; it is not the object. A ~0.5° disc (≈ 9 px at 1080p / 70° hfov) with
 * a hard edge at 10^3–10^4 exposed-linear has to come out of `sky`, and if it does not
 * exist then no amount of pyramid produces something that reads as brighter than white.
 *
 * ## 3. Karis average on the first downsample only
 *
 * Each 2×2 group is weighted by 1/(1+luma) before combining, so one blown-out
 * sub-pixel highlight cannot dominate a 13-tap footprint — sun glitter on the swash
 * otherwise produces crawling fireflies that TAA smears into streaks. The firefly
 * clamp (`bloomClamp`) is in *exposed-linear* units and is deliberately independent of
 * the knee: while it was expressed as a multiple of the threshold it was the thing
 * actually setting the halo strength, so *lowering* the threshold made the glare
 * weaker. The knee decides what glares; the clamp decides how far one firefly may push
 * it.
 *
 * ## 4. Chromatic and anamorphic — for real this time
 *
 * A perfectly neutral radially symmetric Gaussian reads as a filter. Real glare is
 * warm in the core and cool in the skirt (dispersion + coating), and a rectangular
 * aperture stretches it. Both of those were nominally implemented before and both
 * measured as *exactly zero* on the frame, for the same underlying reason: they were
 * applied where they could not compound.
 *
 * **Anamorphic.** It used to scale the offsets of the 9-tap tent on the last four
 * upsample steps — i.e. after every downsample had already made the kernel perfectly
 * round, it stretched the final 2-texel tent by 25 %. Measured half-above-sky radii
 * were 37 px horizontal / 30 px vertical, and essentially all of that 1.23 ratio was
 * the sky's own vertical luminance gradient. The stretch now lives in the *downsample*
 * chain (`uAniso` on `uT.x`), so octave j is built from j stretched steps and ends up
 * with a horizontal scale of `aniso^j`: 1.25 becomes 3.1× by the widest octave. That
 * is a kernel that is genuinely elliptical at every radius the eye can see, and it is
 * also the right physical model — a slit aperture stretches the PSF at every scale.
 *
 * **Chroma.** The ramp used to luma-normalise *each octave* to 1, which is precisely
 * the operation that throws the colour separation away: [1,.95,.86] and [.88,.92,1.0]
 * came out as [1.048,.996,.901] and [.959,1.003,1.090], 9 % in R and 17 % in B across
 * the whole pyramid, riding on a background quantised to ~1 code value per 12 rows.
 * Now the per-octave tints keep their raw spread and exactly one normalisation is done
 * — on the *composite*, `Σ_i w_i · luma(T_i) = 1` — so total glare energy is still
 * conserved while the core→skirt R/B ratio moves by 1.9×.
 *
 * ## 5. Dither — REMOVED from this pass; `grain` owns it
 *
 * This pass used to inject an interleaved-gradient dither at `bloomDither 0.013`, with a
 * header note saying it was a stopgap "because `grain` is currently a pass-through stub"
 * and an instruction to "set `bloomDither = 0` the moment `grain` starts dithering, or it
 * will be dithered twice". `grain.js` has been fully implemented for some time: it sets
 * `p.providesDither = true` in `create()` and injects a TPDF dither at 1.0 LSB as the
 * last operation before the 8-bit write, and records the plateau-run measurement proving
 * it reaches the backbuffer. The instruction was never executed. `bloomDither` now
 * defaults to **0**.
 *
 * The double count was the smaller half of the problem. The placement was the larger one:
 * this injection happens in linear HDR, four passes upstream of CAS, whose `amp` term is
 * exactly 1.0 in a flat mid-tone neighbourhood — so the noise received the sharpener's
 * full Nyquist gain along with everything else, and did so hardest on featureless sand.
 * It is also *multiplicative* and applied before the auto-exposure meters the buffer, so
 * turning it off moves `lum_mean`; a dither that is not exposure-neutral is not a dither.
 *
 * If a pre-tonemap dither is ever genuinely wanted for HDR banding, it has to sit AFTER
 * the sharpen and must not be multiplicative in a buffer that auto-exposure reads.
 *
 * ctx.config knobs (all live):
 *   bloomIntensity 0.50      fraction of above-knee energy redistributed
 *   bloomThresholdSrgb 0.80  display code value the knee closes at (code 204)
 *   bloomThresholdDisplay    optional explicit exposed-linear knee (overrides the solve)
 *   bloomKnee 0.55           soft-knee width, as a fraction of the threshold
 *   bloomRadius 2.0          tent radius in source texels
 *   bloomLevels 4            pyramid depth, 2..8. Live; reallocates on change.
 *   bloomFalloff 1.80        octave weight exponent; 0 = flat = exactly 1/r²
 *   bloomAnamorphic 1.25     horizontal stretch PER OCTAVE; compounds to aniso^(n-1)
 *   bloomChroma 1.0          strength of the core→tail tint ramp
 *   bloomClamp 500           firefly ceiling on the glare source, exposed-linear
 *   bloomTint [1,1,1]        global tint on top of everything
 *   bloomDither 0            OFF. `grain` owns the dither — see note 5.
 *
 * ## Cost
 *
 * **Measured**, not estimated. The line that used to sit here ("1 prefilter + 5
 * downsamples + 5 upsamples + 1 composite ~ 0.30 ms") was never profiled, and the pyramid
 * it describes no longer exists — 4 levels means 1 prefilter + 3 downsamples + 3 upsamples
 * + 1 composite, two fewer half/quarter-res round trips than before.
 *
 * Method (`tools/_pfxprof.mjs`): `RenderPipeline` has no per-pass GPU timer, so a pass is
 * priced by toggling it off with `__HALO__.togglePass` and differencing whole-frame ms,
 * in an INTERLEAVED round-robin repeated over several rounds so GPU contention lands on
 * every configuration equally. Result at `ref_00120`, 1920x1080, 6 rounds x 20 samples,
 * 634 draws / 31.2 M triangles: whole frame **14.1 ms p50**, and this pass differences to
 * **-0.1 ms (min -0.4, max +0.1)** — i.e. within `performance.now()`'s own clamp. Upper
 * bound **< 0.2 ms**, not separable from noise on a frame this heavy. Do not quote it to
 * two decimal places; a per-pass `EXT_disjoint_timer_query_webgl2` timer in
 * `RenderPipeline` is what would resolve it, and there isn't one.
 *
 * Second run, 8 rounds x 24 samples, adding a configuration that disables **all four**
 * postfx passes at once: `all` 14.1 ms p50, `none` 14.1 ms p50, paired difference
 * **0.0 ms median**. The entire postfx tail is below the measurement floor on a frame
 * that costs 14.1 ms at 638 draws and 31.2 M triangles. Tuning any of these four for
 * frame time is not where the time is.
 */

const MAX_LEVELS = 8;

/* --------------------------------------------------------------- display maths */
/* A local, neutral-axis-only mirror of `tonemap`'s transfer functions. It exists so
 * the knee can be *solved* for a display code value instead of hard-coded, and it is
 * deliberately a copy rather than an import: passes are independent files (see
 * docs/ARCHITECTURE.md) and bloom must not fall over because tonemap failed to load.
 * All three curves preserve neutrals — every matrix in the chain has unit row sums to
 * within 1e-4 — so one scalar per curve is exact. If tonemap's curve ever changes,
 * the knee moves by a few code values, not by stops. */

const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

/** Mirrors tonemap.js MODE_GAIN — the per-curve exposure compensation the tonemapper
 *  multiplies in. Missing it moved the knee 0.75 stops on a switch to 'aces'. */
const MODE_GAIN = { agx: 1.0, aces: 1.6757, reinhard: 1.5031, none: 1.0 };

const agxSigmoid = (x) => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
    + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

const srgbEncode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

/** exposed-linear -> sRGB code value in [0,1], on the neutral axis. */
function displayOf(v, mode, white) {
  v = Math.max(v, 0);
  let d;
  if (mode === 'aces') {
    d = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  } else if (mode === 'reinhard') {
    const w2 = Math.max(white * white, 1e-4);
    d = v * (1 + v / w2) / (1 + v);
  } else if (mode === 'none') {
    d = v;
  } else {
    const x = (Math.log2(Math.max(v, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
    d = Math.pow(Math.max(agxSigmoid(Math.min(Math.max(x, 0), 1)), 0), 2.2);
  }
  return srgbEncode(Math.min(Math.max(d, 0), 1));
}

/** Exposed-linear value that the active display transform maps to `target` sRGB.
 *  Bisection in log2 space: every curve here is monotonic, 60 halvings of a 24-stop
 *  bracket is exact to float precision, and it runs once per config change. */
function displayWhite(target, mode, white) {
  let lo = -12, hi = 14;
  if (displayOf(Math.pow(2, hi), mode, white) < target) return Math.pow(2, hi);
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (displayOf(Math.pow(2, mid), mode, white) < target) lo = mid; else hi = mid;
  }
  return Math.pow(2, 0.5 * (lo + hi));
}

/* ------------------------------------------------------------- pyramid weights */

/** Octave energies w_i ∝ (i+1)^-falloff, normalised. falloff 0 == flat == 1/r². */
function octaveWeights(n, falloff) {
  const w = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { w[i] = Math.pow(i + 1, -falloff); s += w[i]; }
  for (let i = 0; i < n; i++) w[i] /= s;
  return w;
}

/** Per-step blend constants that realise `w` exactly: k_j = S_{j+1}/S_j. */
function blendConstants(w) {
  const n = w.length;
  const S = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) S[i] = S[i + 1] + w[i];
  const k = new Array(n - 1);
  for (let j = 0; j < n - 1; j++) k[j] = S[j + 1] / Math.max(S[j], 1e-9);
  return k;
}

const CORE_TINT = [1.10, 1.00, 0.80];   // octave 0: warm      R/B 1.375
const TAIL_TINT = [0.82, 0.94, 1.16];   // octave LEVELS-1: cool  R/B 0.707
const lum709 = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Cumulative tint per octave, differenced into the per-step ratios the upsample loop
 * applies. Content originating at octave m passes through steps m-1 … 0 and so picks
 * up ∏ (T[k+1]/T[k]) = T[m]/T[0]; the composite then multiplies by `base`, leaving
 * octave m tinted by exactly T[m].
 *
 * There is exactly ONE luma normalisation and it is on the composite, not per octave.
 * Normalising each T[i] to luma 1 (which is what this used to do) is algebraically the
 * same as deleting most of the ramp: it forces every octave to the same brightness and
 * only the residual hue difference survives, which measured as 9 % in R across the
 * whole pyramid. Instead `base` is scaled by 1 / Σ w_i·luma(T_i), so the *total* glare
 * energy is unchanged — which is the quantity `intensity` is defined against — while
 * the individual octaves keep their full ±20 % spread.
 */
function tintRamp(n, chroma, w) {
  const T = [];
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) : 0;
    T.push([0, 1, 2].map((j) => 1 + (CORE_TINT[j] + (TAIL_TINT[j] - CORE_TINT[j]) * f - 1) * chroma));
  }
  let energy = 0;
  for (let i = 0; i < n; i++) energy += w[i] * lum709(T[i]);
  const g = 1 / Math.max(energy, 1e-4);
  const step = [];
  for (let i = 0; i < n - 1; i++) step.push([0, 1, 2].map((j) => T[i + 1][j] / Math.max(T[i][j], 1e-4)));
  return { base: T[0].map((v) => v * g), step };
}

/* ------------------------------------------------------------------- shaders */

const HEAD = /* glsl */`
in vec2 vUv;
float bLum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** For glare energy: NaN-safe, non-negative — scattered light cannot be negative. */
vec3 bSan(vec3 c){ return clamp(mix(vec3(0.0), c, vec3(equal(c, c))), vec3(0.0), vec3(60000.0)); }
/** For the scene passing through: NaN/Inf-safe only. Wide-gamut transforms legitimately
 *  carry small negatives and the tonemapper owns what to do with them — not this pass. */
vec3 bGuard(vec3 c){ return clamp(mix(vec3(0.0), c, vec3(equal(c, c))), vec3(-60000.0), vec3(60000.0)); }
`;

/* 13-tap "dual filter" kernel, offsets in source texels.
     A   B   C
       J   K
     D   E   F
       L   M
     G   H   I                                              */
const PREFILTER_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2  uT;
uniform float uThresh, uKnee, uClamp;
out vec4 oCol;

vec3 S(vec2 o){ return bSan(texture(tSrc, vUv + o * uT).rgb); }

void main(){
  vec3 a = S(vec2(-2.0, 2.0)), b = S(vec2(0.0, 2.0)), c = S(vec2(2.0, 2.0));
  vec3 d = S(vec2(-2.0, 0.0)), e = S(vec2(0.0, 0.0)), f = S(vec2(2.0, 0.0));
  vec3 g = S(vec2(-2.0,-2.0)), h = S(vec2(0.0,-2.0)), i = S(vec2(2.0,-2.0));
  vec3 j = S(vec2(-1.0, 1.0)), k = S(vec2(1.0, 1.0));
  vec3 l = S(vec2(-1.0,-1.0)), m = S(vec2(1.0,-1.0));

  vec3 g0 = (a + b + d + e) * 0.25;
  vec3 g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25;
  vec3 g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;

  // Karis: partial averages weighted by 1/(1+luma) kill single-pixel fireflies.
  // Applied to the raw image and *before* the knee, which is the order that makes it
  // an anti-firefly filter rather than a second, hidden threshold.
  float w0 = 0.125 / (1.0 + bLum(g0));
  float w1 = 0.125 / (1.0 + bLum(g1));
  float w2 = 0.125 / (1.0 + bLum(g2));
  float w3 = 0.125 / (1.0 + bLum(g3));
  float w4 = 0.500 / (1.0 + bLum(g4));
  vec3 col = (g0*w0 + g1*w1 + g2*w2 + g3*w3 + g4*w4) / (w0 + w1 + w2 + w3 + w4);

  // Quadratic soft knee around a scene-linear threshold that the CPU derived from the
  // active display transform. One branch, one calibration.
  float thr  = max(uThresh, 1e-5);
  float knee = max(uKnee * thr, 1e-5);
  float br   = max(col.r, max(col.g, col.b));
  float sq   = clamp(br - thr + knee, 0.0, 2.0 * knee);
  sq = sq * sq / (4.0 * knee);
  col *= max(sq, br - thr) / max(br, 1e-5);
  col  = min(col, vec3(uClamp));

  oCol = vec4(col, 1.0);
}
`;

/* Same kernel, one octave down. uAniso widens the horizontal footprint: because every
   octave is built by composing all the downsamples below it, octave j comes out with a
   horizontal scale of aniso^j. That is what makes a 1.25 knob visible — applying it to
   the final tent only (as before) stretched 2 texels of an already-round kernel. */
const DOWNSAMPLE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uT;
uniform float uAniso;
out vec4 oCol;

vec3 S(vec2 o){ return bSan(texture(tSrc, vUv + o * vec2(uAniso, 1.0) * uT).rgb); }

void main(){
  vec3 a = S(vec2(-2.0, 2.0)), b = S(vec2(0.0, 2.0)), c = S(vec2(2.0, 2.0));
  vec3 d = S(vec2(-2.0, 0.0)), e = S(vec2(0.0, 0.0)), f = S(vec2(2.0, 0.0));
  vec3 g = S(vec2(-2.0,-2.0)), h = S(vec2(0.0,-2.0)), i = S(vec2(2.0,-2.0));
  vec3 j = S(vec2(-1.0, 1.0)), k = S(vec2(1.0, 1.0));
  vec3 l = S(vec2(-1.0,-1.0)), m = S(vec2(1.0,-1.0));

  vec3 g0 = (a + b + d + e) * 0.25;
  vec3 g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25;
  vec3 g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
  oCol = vec4(g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125, 1.0);
}
`;

/* 9-tap tent, then mix() via fixed-function blending: out.rgb = tent*k*tint, out.a = k
   with (src=One, dst=OneMinusSrcAlpha) gives dst' = tent*k*tint + dst*(1-k). */
const UPSAMPLE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2  uT;
uniform vec3  uTint;
uniform float uRadius, uAniso, uK;
out vec4 oCol;

vec3 S(vec2 o){ return bSan(texture(tSrc, vUv + o).rgb); }

void main(){
  vec2 r = uT * uRadius;
  r.x *= uAniso;
  vec3 s =
      S(vec2(-r.x,  r.y)) * 1.0 + S(vec2(0.0,  r.y)) * 2.0 + S(vec2( r.x,  r.y)) * 1.0 +
      S(vec2(-r.x,  0.0)) * 2.0 + S(vec2(0.0,  0.0)) * 4.0 + S(vec2( r.x,  0.0)) * 2.0 +
      S(vec2(-r.x, -r.y)) * 1.0 + S(vec2(0.0, -r.y)) * 2.0 + S(vec2( r.x, -r.y)) * 1.0;
  oCol = vec4(s * uTint * (uK / 16.0), uK);
}
`;

const COMPOSITE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform vec3  uTint;
uniform float uIntensity, uDither;
out vec4 oCol;

/* Jimenez's interleaved gradient noise: uniform on [0,1), decorrelated between
   neighbours, no texture, and identical every frame — a *fixed* pattern is what breaks
   a quantisation contour without adding anything that looks like temporal noise. */
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main(){
  vec3 s = bGuard(texture(tSrc, vUv).rgb);
  vec3 b = bSan(texture(tBloom, vUv).rgb);
  vec3 o = s + b * uTint * uIntensity;
  // uDither DEFAULTS TO 0 and should stay there: grain.js owns the dither, injects TPDF
  // at 1.0 LSB immediately before the 8-bit write, and declares providesDither. See note
  // 5. The multiply is kept only so an explicit bloomDither still works for a diagnostic;
  // it is multiplicative and sits upstream of the auto-exposure meter, so any non-zero
  // value moves the exposure key as well as adding noise.
  o *= 1.0 + (ign(gl_FragCoord.xy) - 0.5) * uDither;
  oCol = vec4(o, 1.0);
}
`;

export function create(opts = {}) {
  const p = new Pass('bloom');

  let mips = [];
  let quad = null;
  let mPre = null, mDown = null, mUp = null, mComp = null;
  let W = 0, H = 0;

  const cfg = Object.assign({
    intensity: 0.50,
    thresholdSrgb: 0.80,
    thresholdDisplay: null,   // explicit exposed-linear override; null = solve it
    knee: 0.55,
    radius: 2.0,
    levels: 4,
    falloff: 1.80,
    anamorphic: 1.25,
    chroma: 1.0,
    clamp: 500.0,
    dither: 0.0,
  }, opts.bloom || {});

  /** Pyramid depth, clamped to what the RT allocation can hold. Live: changing it
   *  reallocates on the next frame. */
  const levelsOf = (c) => THREE.MathUtils.clamp(
    Math.round(c.bloomLevels ?? cfg.levels), 2, MAX_LEVELS);
  let LEVELS = levelsOf({});

  const tint = new THREE.Vector3(1, 1, 1);
  const stepTint = new THREE.Vector3(1, 1, 1);

  // derived, recomputed only when the inputs change
  let curveKey = '';
  let whitePoint = 1;
  let weightKey = '';
  let kStep = [];
  let ramp = tintRamp(LEVELS, cfg.chroma, octaveWeights(LEVELS, cfg.falloff));
  let unresolved = 0;

  p.init = () => {
    mPre = fsMaterial(PREFILTER_FRAG, {
      tSrc: { value: null },
      uT: { value: new THREE.Vector2() },
      uThresh: { value: 1 }, uKnee: { value: cfg.knee }, uClamp: { value: cfg.clamp },
    });
    mDown = fsMaterial(DOWNSAMPLE_FRAG, {
      tSrc: { value: null }, uT: { value: new THREE.Vector2() }, uAniso: { value: 1.0 },
    });
    mUp = fsMaterial(UPSAMPLE_FRAG, {
      tSrc: { value: null }, uT: { value: new THREE.Vector2() },
      uTint: { value: stepTint },
      uRadius: { value: cfg.radius }, uAniso: { value: 1.0 }, uK: { value: 0.5 },
    });
    mComp = fsMaterial(COMPOSITE_FRAG, {
      tSrc: { value: null }, tBloom: { value: null },
      uTint: { value: tint }, uIntensity: { value: cfg.intensity },
      uDither: { value: cfg.dither },
    });

    for (const m of [mPre, mDown, mComp]) m.blending = THREE.NoBlending;

    // dst' = src*1 + dst*(1 - src.a) == mix(dst, tent*tint, k)  -> unit-energy pyramid
    mUp.blending = THREE.CustomBlending;
    mUp.blendEquation = THREE.AddEquation;
    mUp.blendSrc = THREE.OneFactor;
    mUp.blendDst = THREE.OneMinusSrcAlphaFactor;
    mUp.blendEquationAlpha = THREE.AddEquation;
    mUp.blendSrcAlpha = THREE.OneFactor;
    mUp.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

    quad = new FullScreenQuad(mComp);
  };

  p.setSize = (w, h) => {
    if (!mPre || (w === W && h === H && mips.length === LEVELS)) return;
    W = w; H = h;
    for (const rt of mips) rt.dispose();
    mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < LEVELS; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      mips.push(makeRT(mw, mh));
    }
  };

  const _draw = (r, mat, target) => {
    quad.material = mat;
    r.setRenderTarget(target);
    quad.render(r);
  };

  /** The exact factor `tonemap` multiplies scene radiance by: exposed = gain · linear. */
  const exposureGain = (c) => {
    const mode = (c.tonemapper in MODE_GAIN) ? c.tonemapper : 'agx';
    return c.exposure * MODE_GAIN[mode] * Math.pow(2, c.exposureEV || 0);
  };

  /**
   * Scene-linear knee. `tonemap` renders `exposure · MODE_GAIN[mode] · 2^EV · L`, so a
   * knee that means "just under display white" is `displayWhite(target) / that factor`.
   */
  const sceneThreshold = (c) => {
    const mode = (c.tonemapper in MODE_GAIN) ? c.tonemapper : 'agx';
    const white = c.tonemapWhite ?? 6.0;
    const target = THREE.MathUtils.clamp(c.bloomThresholdSrgb ?? cfg.thresholdSrgb, 0.05, 0.9999);
    const key = `${mode}|${white}|${target}`;
    if (key !== curveKey) { curveKey = key; whitePoint = displayWhite(target, mode, white); }
    const explicit = c.bloomThresholdDisplay ?? cfg.thresholdDisplay;
    const exposedThr = (typeof explicit === 'number' && explicit > 0) ? explicit : whitePoint;
    return exposedThr / Math.max(exposureGain(c), 1e-6);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const c = ctx.config || {};

    // Hard contract: the knee is display-referred, so it needs the number the display
    // transform is actually going to multiply by. `tonemap` resolves that from the live
    // lighting rig in its own render, which is downstream of here — so on frame 0 it is
    // still null and from frame 1 on it is exactly one frame old. One frame of exposure
    // lag on a knee is nothing (and is deterministic); *no* number at all is not
    // something to paper over with a second, differently calibrated threshold, which is
    // what the previous `(uExposure > 0) ? … : …` branch did. Frame 0 renders without
    // glare; if it is still unresolved a few frames in, tonemap is missing — say so.
    //
    // What this must NOT do is throw. `RenderPipeline.render()` has no try/catch around
    // the pass loop (grep it: zero occurrences of `try {`), so an exception raised here
    // aborts tonemap, grade, sharpen, grain AND the final backbuffer present, leaves a
    // render target bound, and skips `frameIndex++` — which desyncs every temporal pass
    // in the engine. A configuration problem has to degrade to "a frame without glare",
    // not to a black screen and a corrupted pipeline. `p.enabled = false` is already the
    // correct and sufficient mechanism.
    if (typeof c.exposure !== 'number' || !(c.exposure > 0)) {
      if (++unresolved > 4) {
        console.error('[bloom] ctx.config.exposure unresolved after ' + unresolved
          + ' frames — the `tonemap` pass must publish it. bloom disabled.');
        p.enabled = false;
      }
      pipe.blit(pipe.read.texture, out);
      return;
    }
    unresolved = 0;

    const wantLevels = levelsOf(c);
    if (wantLevels !== LEVELS) { LEVELS = wantLevels; weightKey = ''; W = 0; H = 0; }
    if (!mips.length || mips.length !== LEVELS) p.setSize(pipe.w, pipe.h);

    const intensity = c.bloomIntensity ?? cfg.intensity;
    if (intensity <= 0.0) {
      // Straight through — but via the composite, not pipe.blit(): the pipeline's copy
      // material is NormalBlending and passes the source alpha through, so on a target
      // holding stale contents it blends rather than copies. The composite forces a=1.
      mComp.uniforms.tSrc.value = pipe.read.texture;
      mComp.uniforms.tBloom.value = mips[0].texture;
      mComp.uniforms.uIntensity.value = 0.0;
      mComp.uniforms.uDither.value = Math.max(c.bloomDither ?? cfg.dither, 0);
      _draw(r, mComp, out);
      return;
    }

    // ------------------------------------------------ derived pyramid parameters
    const falloff = c.bloomFalloff ?? cfg.falloff;
    const chroma = THREE.MathUtils.clamp(c.bloomChroma ?? cfg.chroma, 0, 4);
    const wKey = `${falloff}|${chroma}|${LEVELS}`;
    if (wKey !== weightKey) {
      weightKey = wKey;
      const w = octaveWeights(LEVELS, falloff);
      kStep = blendConstants(w);
      ramp = tintRamp(LEVELS, chroma, w);
    }

    // ---------------------------------------------------------- 1. prefilter
    mPre.uniforms.uThresh.value = sceneThreshold(c);
    mPre.uniforms.uKnee.value = c.bloomKnee ?? cfg.knee;
    // Ceiling on the glare *source*, in exposed-linear units so it does not move when
    // the knee does. It used to be a multiple of the threshold, which inverted the
    // knob: this scene's sun disc peaks at 6900 scene-linear, the clamp was the thing
    // actually setting the halo strength, and *lowering* the threshold therefore made
    // the glare weaker. Independent now — the knee decides what glares, this decides
    // how far a single firefly is allowed to push it.
    mPre.uniforms.uClamp.value = (c.bloomClamp ?? cfg.clamp) / Math.max(exposureGain(c), 1e-6);
    mPre.uniforms.tSrc.value = pipe.read.texture;
    mPre.uniforms.uT.value.set(1 / pipe.w, 1 / pipe.h);
    _draw(r, mPre, mips[0]);

    // ------------------------------------------------------ 2. downsample chain
    // Every level is stretched by the same factor, so octave j accumulates aniso^j.
    // This is where the anamorphic lives; doing it on the tent instead is why the knob
    // used to measure as zero eccentricity.
    const aniso = THREE.MathUtils.clamp(c.bloomAnamorphic ?? cfg.anamorphic, 0.5, 2.0);
    mDown.uniforms.uAniso.value = aniso;
    for (let i = 1; i < LEVELS; i++) {
      const src = mips[i - 1];
      mDown.uniforms.tSrc.value = src.texture;
      mDown.uniforms.uT.value.set(1 / src.width, 1 / src.height);
      _draw(r, mDown, mips[i]);
    }

    // -------------------------------------------------------- 3. upsample chain
    // The tent carries the same per-step stretch so it reconstructs the elliptical
    // footprint the downsample built rather than rounding it back off.
    const radius = c.bloomRadius ?? cfg.radius;
    mUp.uniforms.uRadius.value = radius;
    mUp.uniforms.uAniso.value = aniso;
    for (let i = LEVELS - 2; i >= 0; i--) {
      const src = mips[i + 1];
      mUp.uniforms.tSrc.value = src.texture;
      mUp.uniforms.uT.value.set(1 / src.width, 1 / src.height);
      mUp.uniforms.uK.value = kStep[i];
      const t = ramp.step[i];
      stepTint.set(t[0], t[1], t[2]);
      _draw(r, mUp, mips[i]);
    }

    // ------------------------------------------------------------ 4. composite
    const g = c.bloomTint;
    const b = ramp.base;
    if (Array.isArray(g) && g.length === 3) tint.set(g[0] * b[0], g[1] * b[1], g[2] * b[2]);
    else tint.set(b[0], b[1], b[2]);
    mComp.uniforms.tSrc.value = pipe.read.texture;
    mComp.uniforms.tBloom.value = mips[0].texture;
    mComp.uniforms.uIntensity.value = intensity;
    mComp.uniforms.uDither.value = Math.max(c.bloomDither ?? cfg.dither, 0);
    _draw(r, mComp, out);
  };

  p.dispose = () => {
    for (const rt of mips) rt.dispose();
    mips = [];
    for (const m of [mPre, mDown, mUp, mComp]) m?.dispose();
    quad?.dispose();
  };

  return p;
}
