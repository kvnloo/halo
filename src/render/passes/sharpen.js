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
 * ## Strength: derived from the TAA MTF, not fitted to a metric
 *
 * `sharpenStrength` is CAS's own 0..1 sharpness knob; it sets `peak = −1/mix(8,5,s)`.
 * The kernel's gain on an on-axis Nyquist pattern is exactly `1/(1 + 4w)`, so the knob
 * spans a Nyquist gain of 2.00 (s=0) to 5.00 (s=1). Note the floor: **CAS at strength
 * zero is already a 2x boost at Nyquist.** The knob is not the restraint lever;
 * `sharpenAmount` is.
 *
 * `taa.js` states and measures its own transfer: the jitter-recentred radius-1 tent it
 * converges to has an MTF of **0.41** at Nyquist. Inverting exactly wants a gain of
 * 1/0.41 = 2.44, i.e. `1 + 4w = 0.41`, i.e. `s = 0.407`.
 *
 * The shipped default is **0.30**, giving a Nyquist gain of **2.29** — 94% of the
 * measured resolve loss, deliberately short rather than over. That is the whole
 * derivation. It is a number that comes from the filter this pass is inverting, not from
 * pushing a strength until `lap_var` looked good, and that distinction is the reason it
 * can be defended on a frame this build cannot yet render.
 *
 * It also lands below the FidelityFX "reference" 0.5-0.6 for a second reason: this chain
 * already sharpens once inside the TAA resolve (`taaSharpen 0.45`, a difference-of-tents
 * against a phase-stable mean) and the two stack.
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
 *   sharpenStrength  number   CAS sharpness 0..1 (default 0.30)
 *   sharpenAmount    number   final blend against the source, 0..1 (default 1.0)
 *   sharpenClamp     number   0..1 overshoot clamp to the 3x3 extent (default 0 = off)
 *
 *
 * ## Cost
 *
 * **Estimated, not profiled.** These numbers are derived, not measured, and the
 * distinction is stated because this project rejects numbers whose provenance is not
 * given. The GPU was saturated by a dozen concurrent capture sessions throughout this
 * task, so a toggle-off/toggle-on timing run would have measured contention. The basis
 * is the one hard measurement available for this chain: `grade.js` records **0.18 ms**
 * for a full-screen RGBA16F pass at 1920x1080 doing one texture fetch plus four
 * texelFetch from a cache-resident LUT, and **0.14 ms** for its dither stage doing a
 * single fetch. Both are bandwidth-bound (8.3 MB read + 8.3 MB write), so in this chain
 * a full-res pass costs ~0.14 ms of floor and additional taps that hit L1/L2 are close
 * to free; a half-res pass costs ~a quarter of that.
 *
 * A real profiling pass on a quiet GPU is owed and should be run before anyone trusts
 * these to two decimal places.
 *
 * Nine fetches of a 3x3 neighbourhood - eight of which are L1 hits behind the first -
 * plus about 40 ALU. **~0.15 ms**, essentially the full-res bandwidth floor.
 */

/**
 * Provenance for the strength sweep. Every row came out of `tools/metrics.py --stats`
 * run on a PNG written by the capture harness — never from a reference frame pushed
 * through anything. Command:
 *
 *   CFG='{"sharpenStrength":S}' node tools/_cap_cfg.mjs --pose ref_00720 \
 *       --only time,lighting,sky,pipeline --out shots/ab_sS.png --settle 48
 *   .venv/bin/python tools/metrics.py --stats shots/ab_sS.png
 *
 * Reference clip, whole frame: lap_var 463, spectral_slope −2.60 (docs/TARGETS.md).
 *
 * **Read the caveat before reading the numbers.** At the time of measurement `terrain`,
 * `rocks`, `ocean`, `clouds`, `structures` and `vegetation` are all stubs, so the frame
 * is sky over a flat placeholder and its own `lap_var` is 16 against a target of 463 —
 * it carries about 3% of the high-frequency energy a finished frame will. On content
 * that smooth, sharpening moves `spectral_slope` *toward* −2.60 rather than away from
 * it, because the render is starting from −3.03 and has a long way to go before it
 * overshoots. That is the opposite of the failure mode this axis exists to catch, and it
 * would be dishonest to report it as a pass.
 *
 * So the table below is **not** evidence that 0.30 is right. The derivation from the
 * measured TAA MTF (see the header) is the argument; the table is here so the
 * re-measurement after the scene lands is a one-command diff, and so the shape of the
 * response is on record.
 *
 * The rule to apply when the scene IS complete: a strength is only acceptable if
 * `lap_var` rises AND `spectral_slope` does not move away from −2.60. On this frame,
 * 0.30 costs 0.207 of slope movement for +22.6 of lap_var; if the finished frame starts
 * at −2.60 the same filter would land near −2.39, which would be too much and the knob
 * would have to come down. Re-measure. Do not assume.
 */
export const MEASURED = {
  method: 'capture',
  pose: 'ref_00720',
  only: 'time,lighting,sky,pipeline',
  settle: 48,
  caveat: 'scene is 90% missing at measurement time (frame lap_var 16 vs a 463 target); '
        + 'the slope is at -3.03, so every strength moves it TOWARD -2.60. This selects '
        + 'nothing. Re-measure once terrain/rocks/ocean land.',
  reference: { lap_var: 463, spectral_slope: -2.60 },
  rows: [
    { strength: 0.00, nyquistGain: 1.00, lap_var: 16.17, spectral_slope: -3.0259 },
    { strength: 0.15, nyquistGain: 2.14, lap_var: 35.06, spectral_slope: -2.8389 },
    { strength: 0.30, nyquistGain: 2.29, lap_var: 38.75, spectral_slope: -2.8187 },  // shipped
    { strength: 0.60, nyquistGain: 2.68, lap_var: 52.20, spectral_slope: -2.7595 },
  ],
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
  sharpenStrength: 0.30,
  sharpenAmount: 1.0,
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
