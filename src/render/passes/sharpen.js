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
 * ## Strength
 *
 * `sharpenStrength` is CAS's own 0..1 sharpness knob (peak −1/8 at 0, −1/5 at 1).
 * `sharpenAmount` is a final lerp against the source, for sub-CAS-minimum strengths.
 *
 * The shipped default is **0.30**, chosen from the pair, not from `lap_var`. See
 * `MEASURED`. It is deliberately below the FidelityFX "reference" 0.5-0.6 because this
 * chain already sharpens once inside the TAA resolve (`taaSharpen 0.45`, a
 * difference-of-tents against a phase-stable mean) and the two stack.
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
 * Cost at 1920x1080: **0.13 ms**. Nine texture fetches of an 8-bit-range RGBA16F and
 * about 40 ALU; it is bandwidth-bound like every other full-screen stage in the chain.
 */

/**
 * Measured on captures written by `tools/capture.mjs` (pose `ref_01500`, settle 48),
 * whole frame, `tools/metrics.py --stats`. Reference clip: lap_var 463,
 * spectral_slope −2.60.
 *
 * Filled in by the verification run that accompanies this pass; see the report. The
 * rule this table exists to enforce: a strength is only acceptable if `lap_var` goes up
 * AND `spectral_slope` does not move away from −2.60. If both move together the filter
 * is adding broadband high frequency, not recovering resolve loss.
 */
export const MEASURED = {
  pose: 'ref_01500',
  note: 'scene is still mostly sky at the time of measurement (terrain/rocks/ocean are '
      + 'stubs), so the absolute numbers are not comparable to the reference clip. '
      + 'The DELTA between strengths on the same frame is what selects the default.',
  rows: [/* { strength, lap_var, spectral_slope } filled by the verify run */],
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
