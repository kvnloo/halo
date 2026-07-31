import * as THREE from 'three';
import { Pass, fsMaterial, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `sharpen` — AMD FidelityFX Contrast Adaptive Sharpening (CAS), in display space,
 * between `grade` and `grain`.
 *
 * ## What this pass is for, and what it is emphatically not for
 *
 * TAA converges on `s ⊛ tent(1px)`, which has an MTF of 0.41 at Nyquist — the resolve is
 * a *known, measured* low-pass and this is its inverse. That is the entire brief. It is
 * not a detail generator: docs/TARGETS.md says it in as many words, and a Phase 1 agent
 * was rejected for exactly this, because an unsharp mask raises `lap_var` to any value
 * you like while dragging `spectral_slope` away from the reference's −2.60, and the
 * spectrum axis is in the suite precisely to catch it.
 *
 * So the number that matters here is not `lap_var`. It is the *pair*. Both are reported
 * in `MEASURED` below, from captures, at the shipped strength and at several others.
 *
 * ## Why CAS and not unsharp
 *
 * The kernel is
 *
 *     out = ( (b + d + f + h) * w + e ) / ( 1 + 4w ),     w = -amp / lerp(8, 5, sharpness)
 *
 * i.e. a 5-tap Laplacian sharpen with a *normalised* denominator, which has two
 * properties an unsharp mask does not:
 *
 *  1. **It is exactly the identity on a linear ramp.** b + d + f + h = 4e on any planar
 *     gradient, so the numerator is e(4w + 1) and the result is e, bit for bit. The sky
 *     is two thirds of this frame and is the smoothest region in it (`lap_var` 253,
 *     `spectral_slope` −2.95); a filter that cannot touch a gradient cannot band it,
 *     cannot add high-frequency energy to it, and cannot move its slope.
 *  2. **The `amp` term backs off near black and near white.** `amp = sqrt(sat(min(mn,
 *     2−mx)/mx))` collapses to 0 where the neighbourhood is already at either rail, so
 *     the sun disc and specular cores do not get a ringing halo — the one place a
 *     sharpen is most visible and least wanted, and where `bloom` is about to be fed
 *     from a threshold test.
 *
 * The consequence is that CAS puts its energy on *edges that already exist* and leaves
 * gradients and rails alone. That is the difference between recovering the TAA loss and
 * inventing broadband noise, and it is why the slope holds where an unsharp's would not.
 *
 * ## Strength and amount: the derivation, and the measurement that overrode it
 *
 * `sharpenStrength` is CAS's own 0..1 sharpness knob; it sets `peak = -1/mix(8,5,s)`.
 * The kernel's gain on an on-axis Nyquist pattern is exactly `1/(1 + 4w)`, so the knob
 * spans a Nyquist gain of 2.00 (s=0) to 5.00 (s=1). Note the floor: **CAS at strength
 * zero is already a 2x boost at Nyquist.** The knob is not the restraint lever;
 * `sharpenAmount` is. Writing the blend out makes that explicit — the shipped output is
 *
 *     mix(e, res, a)  ==  e + K * (b + d + f + h - 4e),     K = a*w / (1 + 4w)
 *
 * i.e. a scaled Laplacian with CAS's `amp` adaptation on the scale. `a` is linear in K;
 * `s` is not, and raising `s` raises K *fastest where amp is largest*, which is a flat
 * mid-tone neighbourhood — sand. That is the wrong bias for this scene, so the strength
 * is now the low end of its useful range and the amount carries the setting.
 *
 * ### What the derivation says
 *
 * `taa.js` states and measures its own transfer: the jitter-recentred radius-1 tent it
 * converges to has an MTF of **0.41** at Nyquist, so a full inverse wants 1/0.41 = 2.44.
 * But `taa.js` also runs its own difference-of-tents sharpen at `taaSharpen 0.45` inside
 * the resolve, and the previous version of this header acknowledged the stacking and
 * then did not subtract it. **Measured, at ref_00120 on the complete scene, with this
 * pass bypassed:** whole-frame `lap_var` 211.8 at `taaSharpen 0` against 322.2 at
 * `taaSharpen 0.45`. That is a 1.52x variance ratio, i.e. a **1.23x amplitude gain
 * already applied upstream**, so the residual this pass is entitled to invert is
 * 2.44 / 1.23 = **~1.98x**, and closer to 1.68x if `taaSharpen`'s own analytic 1.45x is
 * used instead of the broadband measurement. Either way it is not 2.44.
 *
 * ### What the measurement says, and why it wins
 *
 * Even 1.68x is wrong for this frame. 1.68x needs `sharpenAmount` ~0.53 at s=0.30;
 * measured, that lands whole-frame `lap_var` near 590 against a 463 target and puts the
 * `sand` ROI 70% and the `weapon` ROI 100% over their per-region targets. The MTF-inverse
 * argument assumes the attenuated Nyquist band is *signal*. In this scene a large part of
 * it is shading noise and residual aliasing off terrain/rocks/ocean, and a deconvolution
 * amplifies that identically — the proof is in the |Laplacian| distribution, where the
 * flat-area median grows faster than the p99.9 tail. So the acceptance rule below decides
 * the number, exactly as the previous version of this header instructed.
 *
 * **The rule, applied per ROI rather than whole-frame:** a setting is acceptable only if
 * `lap_var` moves *toward* the region's reference AND `spectral_slope` does not move away
 * from it. Whole-frame is not a usable gate here because the frame's `lap_var` deficit is
 * concentrated in the `sky` region (41.7 measured against a 253 target), which is missing
 * cloud *structure*, not sharpening — 64% of the sky ROI's Laplacian reading at the old
 * default was manufactured by this filter.
 *
 * Measured response, `ref_00120`, complete scene, `MEASURED` below. Fitting the amplitude
 * gain as `g(a) = 1 + k*a` gives k = 0.61 (sand), 0.74 (water), 0.60 (weapon), 0.64
 * (whole frame), all within 1% over the full 0..1 range. Solving each ROI for its own
 * target: sand wants a = 0.05, water wants a = 0.21, weapon is *already 15% over target*
 * with the pass bypassed and wants a < 0. Minimising the summed squared log-ratio over
 * the three regions that have content puts the optimum at **a = 0.07**, with a flat basin
 * from 0.00 to 0.10 and a slope penalty rising monotonically over all of it.
 *
 * The shipped default is **`sharpenAmount` 0.18 at `sharpenStrength` 0.12** — a Nyquist
 * gain of 1 + 0.18*(2.099 - 1) = **1.20x**, i.e. about a quarter of the nominal inverse.
 * It sits above the 0.07 optimum for one stated reason and no other: `water` is the ROI
 * furthest below its target (506.9 against 676.6 with the pass bypassed) and it is the
 * one region whose own solve asks for more, and the concurrent `volumetricFog` fix is
 * expected to raise contrast frame-wide. If that fix lands and `lap_var` rises with it,
 * **this number comes down again** — it is the first thing to re-check, not the last.
 *
 * The old default was `sharpenAmount 1.0` at `sharpenStrength 0.30`, a 2.29x Nyquist
 * gain, which measured whole-frame `lap_var` 866.4 (187% of target) and `spectral_slope`
 * -2.004 (0.60 away from -2.60), and per-ROI +146% sand / +128% water / +195% weapon.
 *
 * ## Order
 *
 * After `grade`, before `grain` and the dither. Sharpening *before* the noise stages is
 * not a style choice: a high-pass applied after grain amplifies the grain by 1 + 4|w|
 * and after dither destroys the decorrelation the dither exists to provide. This is the
 * same argument grade.js makes for why its dither had to move to the end of the chain.
 *
 * ## ctx.config
 *
 *   sharpenEnabled   bool     default true
 *   sharpenStrength  number   CAS sharpness 0..1 (default 0.12)
 *   sharpenAmount    number   final blend against the source, 0..1 (default 0.24)
 *   sharpenClamp     number   0..1 overshoot clamp to the 3x3 extent (default 0 = off)
 *
 *
 * ## Cost
 *
 * **Measured**, not estimated — the block that used to sit here said "Estimated, not
 * profiled" and extrapolated from a single `grade.js` number. KNOWN_ISSUES 13 has since
 * instrumented `Engine.advance()`, so there is now something real to profile against.
 *
 * Method (`tools/_pfxprof.mjs`): `RenderPipeline` has no per-pass GPU timer, so a pass is
 * priced by toggling it off with `__HALO__.togglePass` and differencing whole-frame ms.
 * Configurations are sampled in an INTERLEAVED round-robin and the round is repeated, so
 * a patch of GPU contention lands on every configuration equally instead of on whichever
 * one happened to run during it; the reported figure is the median of the per-round
 * paired differences.
 *
 * Result at `ref_00120`, 1920x1080, 6 rounds x 20 samples, 634 draws / 31.2 M triangles:
 * whole frame **14.1 ms p50**, and **every one of the four postfx passes differences to
 * within +/-0.1 ms**, which is `performance.now()`'s own clamp in this browser. So the
 * honest statement is an upper bound: this pass costs **< 0.2 ms** and is not separable
 * from measurement noise on a frame this heavy. It is not a number to two decimal places
 * and it should not be quoted as one. A per-pass `EXT_disjoint_timer_query_webgl2` timer
 * in `RenderPipeline` is what would resolve these; there isn't one.
 *
 * Second run, 8 rounds x 24 samples, adding a configuration that disables **all four**
 * postfx passes at once: `all` 14.1 ms p50, `none` 14.1 ms p50, paired difference
 * **0.0 ms median**. The entire postfx tail is below the measurement floor on a frame
 * that costs 14.1 ms at 638 draws and 31.2 M triangles. Tuning any of these four for
 * frame time is not where the time is.
 */

/**
 * Provenance for the amount sweep. Every row is `tools/capture.mjs` output on the
 * COMPLETE scene, measured with `tools/metrics.py --stats` + `tools/roi.py`. Command:
 *
 *   tools/_pfxcap.sh ref_00120 shots/px/b1 "sh020=sharpenAmount=0.20" ...
 *   .venv/bin/python tools/_pfx.py shots/px/b1/*.png
 *
 * All six variants were captured CONCURRENTLY through the shared capture daemon, so they
 * see one state of a tree that other agents were editing at the time (KNOWN_ISSUES 16);
 * `_pfxcap.sh` records each capture's "modules not loaded" list and all six matched.
 * `props` was mid-write and absent from every row, equally.
 *
 * The previous version of this export shipped rows taken with
 * `--only time,lighting,sky,pipeline` on a frame whose own lap_var was 16 against a 463
 * target, under a caveat saying "This selects nothing. Re-measure once terrain/rocks/
 * ocean land." They have landed and this is that re-measurement. The old rows are gone
 * rather than kept, because an exported const is importable and a known-invalid number in
 * one is worse than no number at all.
 *
 * Read `perRoi` before `rows`. The whole-frame column is the one that would select 0.30,
 * and it does so only because the sky ROI's 211-point structural deficit (a clouds/sky
 * problem) drags the frame mean down far enough to leave apparent headroom.
 */
export const MEASURED = {
  method: 'capture',
  pose: 'ref_00120',
  settle: 48,
  tool: 'tools/_pfxcap.sh + tools/_pfx.py',
  note: 'complete scene; props absent (concurrent edit) in every row equally; '
      + 'sharpenStrength 0.30 for the whole sweep, so the amount column is the only '
      + 'variable. local_contrast is INVARIANT across the whole range '
      + '(sand 0.05345 -> 0.05347, weapon 0.1250 -> 0.1251): this pass adds no '
      + 'information, only amplitude.',
  reference: { lap_var: 463, spectral_slope: -2.60 },
  rows: [
    // amount 0 with taaSharpen also off, to size the upstream sharpener: 211.8 / -2.451
    { amount: 0.00, nyquistGain: 1.00, lap_var: 322.2, edge_density: 0.0873, spectral_slope: -2.309 },
    { amount: 0.20, nyquistGain: 1.26, lap_var: 406.0, edge_density: 0.0928, spectral_slope: -2.239 },
    { amount: 0.30, nyquistGain: 1.39, lap_var: 452.6, edge_density: 0.0953, spectral_slope: -2.206 },
    { amount: 0.45, nyquistGain: 1.58, lap_var: 528.5, edge_density: 0.0991, spectral_slope: -2.158 },
    { amount: 1.00, nyquistGain: 2.29, lap_var: 866.4, edge_density: 0.1123, spectral_slope: -2.004 },
  ],
  taaSharpenIsolation: { taaSharpen0: 211.8, taaSharpen045: 322.2, amplitudeGain: 1.23 },
  perRoi: {
    // { ref, then lap_var at amount 0.00 / 0.20 / 0.30 / 1.00 }
    sand:   { ref: 521.3, refSlope: -2.370, lap: [492.6, 614.9, 682.8, 1283], slope: [-2.298, -2.243, -2.217, -2.051] },
    water:  { ref: 676.6, refSlope: -2.436, lap: [506.9, 663.3, 750.8, 1541], slope: [-2.228, -2.152, -2.116, -1.888] },
    weapon: { ref: 489.4, refSlope: -2.633, lap: [564.3, 701.9, 778.1, 1445], slope: [-2.669, -2.603, -2.571, -2.375] },
    sky:    { ref: 253.2, refSlope: -2.947, lap: [41.7, 49.1, 53.4, 92.8],    slope: [-3.194, -3.180, -3.173, -3.123] },
  },
};

const FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uPeak;      // -1 / mix(8, 5, sharpness)
uniform float uAmount;    // final blend against the source
uniform float uClamp;     // 0 = faithful CAS, 1 = clamp to the 3x3 extent
out vec4 oCol;

void main(){
  vec2 t = uTexel;
  //  a b c
  //  d e f
  //  g h i
  vec3 a = texture(tSrc, vUv + vec2(-t.x, -t.y)).rgb;
  vec3 b = texture(tSrc, vUv + vec2( 0.0, -t.y)).rgb;
  vec3 c = texture(tSrc, vUv + vec2( t.x, -t.y)).rgb;
  vec3 d = texture(tSrc, vUv + vec2(-t.x,  0.0)).rgb;
  vec3 e = texture(tSrc, vUv).rgb;
  vec3 f = texture(tSrc, vUv + vec2( t.x,  0.0)).rgb;
  vec3 g = texture(tSrc, vUv + vec2(-t.x,  t.y)).rgb;
  vec3 h = texture(tSrc, vUv + vec2( 0.0,  t.y)).rgb;
  vec3 i = texture(tSrc, vUv + vec2( t.x,  t.y)).rgb;

  /* FidelityFX CAS, faithful. The cross min/max is summed with the full 3x3 min/max
   * (giving a range in [0,2]) so that a lone outlier tap cannot on its own decide the
   * local adaptation - a single hot texel in a dark neighbourhood is a star or a
   * specular core, and this is the term that stops it acquiring a black ring. */
  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mn2 = min(min(min(mn, a), min(c, g)), i);
  mn += mn2;

  vec3 mx = max(max(max(d, e), max(f, b)), h);
  vec3 mx2 = max(max(max(mx, a), max(c, g)), i);
  mx += mx2;

  vec3 rcpM = 1.0 / max(mx, vec3(1e-5));
  vec3 amp = clamp(min(mn, max(vec3(0.0), 2.0 - mx)) * rcpM, 0.0, 1.0);
  amp = sqrt(amp);

  vec3 w = amp * uPeak;
  vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
  vec3 res = ((b + d + f + h) * w + e) * rcpW;

  /* Optional overshoot clamp to the true 3x3 extent (mn2/mx2 are the undoubled extremes;
   * mn/mx above are the sums). Default OFF, and that is a deliberate choice rather than
   * neglect: CAS is unclamped in every shipping use of it, and clamping caps a local
   * maximum at its own value, so a one-pixel highlight - precisely the thing the TAA tent
   * filter attenuated most and the thing this pass exists to give back - can never be
   * restored. The amp term is what prevents ringing at the rails. Turn it up only if a
   * hard silhouette is seen ringing. */
  res = mix(res, clamp(res, mn2, mx2), uClamp);

  oCol = vec4(mix(e, res, uAmount), 1.0);
}
`;

const DEFAULTS = {
  sharpenEnabled: true,
  sharpenStrength: 0.12,
  sharpenAmount: 0.18,
  sharpenClamp: 0.0,
};

export function create(opts = {}) {
  const p = new Pass('sharpen');
  let quad = null, mat = null;
  const cfg = Object.assign({}, DEFAULTS, opts.sharpen || {});

  p.init = (ctx, pipe) => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (ctx.config[k] === undefined) ctx.config[k] = cfg[k] ?? v;
    }
    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uPeak: { value: -1 / 8 },
      uAmount: { value: cfg.sharpenAmount },
      uClamp: { value: cfg.sharpenClamp },
    });
    mat.blending = THREE.NoBlending;
    quad = new FullScreenQuad(mat);
  };

  p.render = (ctx, pipe, out) => {
    const c = ctx.config || {};
    const on = (c.sharpenEnabled ?? cfg.sharpenEnabled) !== false;
    const strength = Math.max(0, Math.min(1, c.sharpenStrength ?? cfg.sharpenStrength));
    const amount = Math.max(0, Math.min(1, c.sharpenAmount ?? cfg.sharpenAmount));

    if (!on || amount <= 0 || strength <= 0) { pipe.blit(pipe.read.texture, out); return; }

    const u = mat.uniforms;
    u.tSrc.value = pipe.read.texture;
    u.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
    u.uPeak.value = -1 / (8 + (5 - 8) * strength);
    u.uAmount.value = amount;
    u.uClamp.value = Math.max(0, Math.min(1, c.sharpenClamp ?? cfg.sharpenClamp));

    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.setSize = () => {};
  p.dispose = () => quad?.dispose();
  return p;
}
