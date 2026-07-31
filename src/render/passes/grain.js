import * as THREE from 'three';
import { Pass, fsMaterial, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `grain` — the terminal output stage: film grain, optical vignette, lateral chromatic
 * aberration, and the 8-bit dither, in that order.
 *
 * This is the last pass in `PASS_MANIFEST`, so it is the pass that writes the 8-bit
 * backbuffer, and everything below that depends on the destination being 8 bits keys off
 * `pass.writesBackbuffer` — never off a null render target. See the `Pass.writesBackbuffer`
 * note in docs/ARCHITECTURE.md: a Phase 1 dither gated on `out === null` became dead code
 * the moment `sharpen` and `grain` were registered after `grade`, and the sky banded at
 * 40 plateaus averaging 15.7 px. That is the single most expensive kind of bug in this
 * chain, because the image still looks plausible.
 *
 * ## This pass owns the dither
 *
 * `grade.js` appends its own terminal dither stage unless something else in the chain
 * declares `providesDither`. This pass declares it in `create()`, before `pipe.init()`
 * runs, so `grade` stands down and the TPDF injection happens here instead — saving a
 * whole full-screen 8.3 MB read + write round trip (0.14 ms, measured by that pass) for
 * an effect that is thirty integer ALU.
 *
 * Dither is only dither if nothing modifies the signal between the noise injection and
 * the quantisation, so it is the *last* thing this shader does, after the grain and after
 * the vignette multiply.
 *
 * Measured, blue channel down column x=1500 of a `diag_sky` capture, top 800 rows — the
 * same measurement grade.js records, so the two are comparable. Grain is a broadband
 * additive stage and therefore decorrelates quantisation on its own, so the dither has
 * to be isolated by turning grain off:
 *
 *                                            codes  mean run  max run  runs >= 8px
 *     grainAmount 0, gradeDither 0             53     2.23       20        12
 *     grainAmount 0, gradeDither 1 (dither)    54     1.72       11         3
 *     shipped (grain + dither)                 55     1.48       10         2
 *     ref/keyframes (grade.js, for scale)     142-169  1.08-1.37  7-11     0-3
 *
 * `grade.js`'s regression gate fails above a 2.0 px mean plateau run. Undithered this
 * pass measures 2.23 and would fail it; dithered it measures 1.72 and passes, and the
 * shipped configuration is 1.48. So the dither is demonstrably reaching the backbuffer —
 * which is exactly the claim that was false for two shipped reviews.
 *
 * ## Order of operations, and why chromatic aberration looks out of place in the list
 *
 * The brief order is grain -> vignette -> CA -> dither. Grain and vignette are pointwise
 * functions of screen position; CA is a *resampling*. Applying a resample last is
 * therefore the same thing as evaluating everything before it at the displaced
 * coordinates — which is exactly what this shader does, per channel:
 *
 *     for c in {r, g, b}:  uv_c = uv + caOffset(uv, c)
 *                          v_c  = grain(uv_c, c) applied to src(uv_c).c, then vignette(uv_c)
 *
 * That is cheaper than three full composites and it is also *more* correct than
 * displacing a finished monochrome image: real film grain is three independent dye
 * layers, so the channels should decorrelate, and real lateral CA displaces the whole
 * optical path including the illumination falloff. The alternative — grain the composite,
 * then split it radially — gives every grain particle a red/blue fringe, which is
 * precisely the artefact CA at this amplitude is supposed to be too small to show.
 *
 * ## Grain
 *
 * Luminance-dependent, because film is: silver-halide density response peaks in the
 * midtones and collapses in the highlights, where the emulsion is saturated. The
 * response curve here is ~0.1 at black, 1.0 from 0.25 to 0.45, and 0.08 at white, so a
 * blown cloud top or the sun disc stays clean while the mid-grey sand carries texture.
 *
 * Triangular-PDF (two decorrelated halves of one PCG word), so the distribution has the
 * soft shoulders of grain rather than the hard rails of a uniform. One texel by default:
 * `grainSize` 1.0. Coarse grain is the fastest way to lose `spectral_slope`, because
 * noise is white — flat spectrum — and the reference sits at −2.60. At the shipped
 * amplitude the added Laplacian variance is about 20·sigma^2 ~= 5 code^2 against a target
 * `lap_var` of 463, i.e. about 1%.
 *
 * Animated from `pipe.frameIndex`, never from a wall clock. `tools/capture.mjs` advances
 * a fixed number of frames, so `frameIndex` is identical across two runs of the same
 * command and the capture stays byte-identical — which a `Date.now()` or
 * `performance.now()` seed would destroy, taking the whole measurement loop with it.
 *
 * **The old cost claim here was void and is replaced.** It read "`lap_var` 12.39 ->
 * 16.17 ... +3.8 of Laplacian variance against a 463 target (0.8%)", measured at
 * `ref_00720` with `--only time,lighting,sky,pipeline` on a frame that was sky over a
 * placeholder. On the complete scene at `ref_00120` the pass as a whole is a *net
 * subtraction*, because the CA resample dominates everything the grain adds — see the
 * table in the CA section. With the shipped luma-preserving CA the whole pass costs
 * 2.2% of whole-frame `lap_var`; with the old CA it cost 10.4%. The grain itself is
 * still deliberately below the level at which it could move the spectrum.
 *
 * ## Vignette
 *
 * Natural illumination falloff, `1/(1 + k·r^2)^2` — the cos^4 law, evaluated so that the
 * requested corner darkening comes out exactly. It is a smooth quadratic from the centre,
 * not a ring: there is no smoothstep, no inner radius, and no edge to see. Default 0.12
 * at the corner, which is roughly what a fast wide prime does wide open and is at the
 * edge of noticing on a sky gradient.
 *
 * ## Chromatic aberration
 *
 * Lateral only (transverse), which is the kind a real lens shows off-axis: displacement
 * along the radius, growing as r^2, exactly zero on the optical axis. Longitudinal CA —
 * per-channel focus shift — is a depth-of-field effect and does not belong in a 2D pass.
 *
 * ### It used to be the most destructive operation in the whole post chain
 *
 * A lateral displacement is a bilinear fetch, and a bilinear fetch at sub-pixel offset d
 * is a two-tap box with weights (1-d, d), whose MTF at Nyquist is |1 - 2d|. At the 0.70 px
 * corner offset this pass shipped, that is 0.40 — R and B lost 60% of their finest detail,
 * and R-to-B separation reached 1.40 px, well past this header's own "if coloured fringing
 * is visible anywhere, it is at least three times too strong" rule.
 *
 * Two changes. **(1)** The amplitude came down to 0.45 px at the corner (0.90 px total
 * R/B separation). **(2)** The luminance is taken from the *centre* tap and only the
 * chroma from the displaced ones, so the luma MTF is 1.0 by construction at any
 * amplitude. That is the same thing as a YCoCg round trip that displaces CoCg and keeps
 * Y, minus the two matrix multiplies: adding a constant to all three channels moves Y and
 * leaves Co/Cg alone. It is also the more correct model — transverse CA is a *chromatic*
 * error, three images of the same scene at slightly different magnifications, and what the
 * eye reads off it is a coloured fringe, not a softer picture. `grainCALuma` 0 restores
 * the old behaviour for A/B.
 *
 * Measured, `ref_00120`, complete scene, all four variants captured concurrently through
 * the shared daemon with an identical module-load state (`tools/_pfxcap.sh`), everything
 * else at the shipped defaults. `lap_var`, whole frame and per ROI:
 *
 *                                     whole     sand    water   weapon      sky
 *     grainCA 0     (no CA at all)    488.2    760.7    725.6    835.0     74.5
 *     0.45, luma-preserving (SHIPPED) 477.3    738.7    719.7    817.6     71.7
 *     0.45, no luma preservation      453.6    690.9    707.3    779.4     66.1
 *     0.70, no luma preservation (OLD) 437.4   658.0    697.9    753.2     62.5
 *
 * So the old configuration destroyed **10.4% of whole-frame and 13.5% of `sand`
 * Laplacian variance**; the shipped one costs **2.2% and 2.9%**. At equal amplitude the
 * luma preservation alone recovers 5.2% whole-frame and 6.9% on `sand`. `local_contrast`
 * is unchanged by any of them (sand 0.0550 in all four rows), which is why the old
 * setting was pure loss: it removed high-frequency energy and returned nothing.
 *
 * ## ctx.config
 *
 *   grainEnabled     bool     default true (bypasses grain/vignette/CA, NOT the dither)
 *   grainAmount      number   peak grain in display units at full response (0.0060 ~ 1.5 codes)
 *   grainSize        number   grain cell in pixels (1.0)
 *   grainResponse    number   0 = flat, 1 = full luminance dependence (1.0)
 *   grainVignette    number   corner darkening, 0..1 (0.12)
 *   grainCA          number   channel separation at the corner, in pixels (0.45)
 *   grainCALuma      number   1 = keep the centre tap's luma so CA costs no sharpness
 *                             (default 1); 0 = the old, lossy per-channel resample
 *   grainDither      number   TPDF amplitude in LSBs, peak. Falls back to `gradeDither`
 *                             so the existing knob keeps working. (1.0)
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

const FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uRes;
uniform vec2  uTexel;
uniform float uAspect;
uniform float uGrain;       // peak amplitude, display units
uniform float uGrainSize;   // px
uniform float uGrainResp;   // 0..1
uniform float uVigK;        // solved from the requested corner darkening
uniform float uCA;          // px at the corner
uniform float uCALuma;      // 1 = keep centre-tap luma (chroma-only displacement)
uniform float uDither;      // LSBs, peak. 0 = off (destination is not 8-bit)
uniform float uFrame;
uniform float uBypass;
out vec4 oCol;

uint pcg(uint v){
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

/* Triangular PDF on [-1,1] from one hashed word: the two 16-bit halves of a PCG output
 * are decorrelated well enough to subtract, which costs one hash instead of two.
 * Integer-only — a fract(sin()) hash is precision-dependent and drifts between drivers,
 * which would break byte-identical capture. */
float grainAt(vec2 px, uint chan){
  uvec2 q = uvec2(floor(max(px, vec2(0.0)) / max(uGrainSize, 0.25)));
  uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(uFrame) * 3u + chan)));
  float a = float(h & 0xFFFFu) * (1.0 / 65535.0);
  float b = float(h >> 16u) * (1.0 / 65535.0);
  return a - b;
}

/* Silver-halide density response: almost nothing in crushed black, peak through the
 * midtones, and effectively gone by the time the emulsion saturates. */
float grainResponse(float L){
  float lo = smoothstep(0.0, 0.16, L);
  float hi = 1.0 - 0.92 * smoothstep(0.45, 1.0, L);
  return mix(1.0, lo * hi, uGrainResp);
}

/* cos^4 natural falloff. Quadratic from the centre, no ring, no edge. */
float vignetteAt(vec2 uv){
  vec2 d = (uv - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(d, d) / (0.25 * (uAspect * uAspect + 1.0));
  float v = 1.0 / (1.0 + uVigK * r2);
  return v * v;
}

void main(){
  vec3 c;
  vec2 uvR = vUv, uvG = vUv, uvB = vUv;

  if (uBypass < 0.5) {
    // ---- chromatic aberration: lateral, radial, r^2, zero on axis ----------
    vec2 pxPos = (vUv - 0.5) * uRes;
    float rr = dot(pxPos, pxPos);
    float rn2 = rr / max(dot(uRes * 0.5, uRes * 0.5), 1.0);       // 1.0 at the corner
    vec2 dir = pxPos * inversesqrt(max(rr, 1e-6));
    vec2 offUV = dir * (uCA * rn2) * uTexel;
    uvR = clamp(vUv + offUV, vec2(0.0), vec2(1.0));
    uvB = clamp(vUv - offUV, vec2(0.0), vec2(1.0));
  }

  c = vec3(texture(tSrc, uvR).r, texture(tSrc, uvG).g, texture(tSrc, uvB).b);

  /* ---- restore the centre tap's luminance -------------------------------------
   * A lateral displacement is implemented as a bilinear fetch, and a bilinear fetch
   * at a sub-pixel offset d is a two-tap box with weights (1-d, d), whose MTF at
   * Nyquist is |1 - 2d|. At the 0.70 px corner offset this pass used to ship that is
   * 0.40 — R and B lost 60% of their finest detail and the pass measured as a net
   * REMOVAL of 334 lap_var on a complete frame, three times more than every other
   * stage in this file contributes.
   *
   * Real transverse CA is a *chromatic* error: the three images are the same scene at
   * slightly different magnifications, so what the eye reads is a coloured fringe, not
   * a softer picture. Splitting the fetch into luma and chroma reproduces exactly that
   * — take the chroma from the displaced taps and the luminance from the centre one —
   * and the luma MTF is then 1.0 by construction at any amplitude. Equivalent to a
   * YCoCg round trip (displace CoCg, keep Y) but without the two matrix multiplies:
   * adding a constant to all three channels moves Y and leaves Co/Cg untouched. */
  if (uCALuma > 0.0 && uBypass < 0.5) {
    vec3 lw = vec3(0.2126, 0.7152, 0.0722);
    float lCentre = dot(texture(tSrc, vUv).rgb, lw);
    c += (lCentre - dot(c, lw)) * uCALuma;
  }

  if (uBypass < 0.5) {
    // ---- grain, evaluated per channel at that channel's displaced position --
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float amp = uGrain * grainResponse(clamp(L, 0.0, 1.0));
    c.r += grainAt(uvR * uRes, 0u) * amp;
    c.g += grainAt(uvG * uRes, 1u) * amp;
    c.b += grainAt(uvB * uRes, 2u) * amp;

    // ---- vignette, likewise per channel ------------------------------------
    c.r *= vignetteAt(uvR);
    c.g *= vignetteAt(uvG);
    c.b *= vignetteAt(uvB);
  }

  // ---- dither: last, immediately before the 8-bit write --------------------
  // Two independent uniforms subtracted give a symmetric triangular distribution, which
  // is the textbook TPDF dither: it makes the quantisation error white and
  // signal-independent, i.e. it removes banding rather than hiding it. Deterministic in
  // gl_FragCoord alone so two captures stay byte-identical.
  if (uDither > 0.0) {
    uvec2 q = uvec2(gl_FragCoord.xy);
    float r1 = float(pcg(q.x ^ pcg(q.y))) * (1.0 / 4294967295.0);
    float r2 = float(pcg((q.x ^ pcg(q.y ^ 0x9E3779B9u)) + 0x85EBCA6Bu)) * (1.0 / 4294967295.0);
    c += ((r1 - r2) * uDither) / 255.0;
  }

  oCol = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

const DEFAULTS = {
  grainEnabled: true,
  grainAmount: 0.0060,
  grainSize: 1.0,
  grainResponse: 1.0,
  grainVignette: 0.12,
  grainCA: 0.45,
  grainCALuma: 1.0,
  grainDither: 1.0,
};

export function create(opts = {}) {
  const p = new Pass('grain');

  // Declared here, in create(), not in init(): `pipeline.js` builds every pass before it
  // calls `pipe.init()`, and `grade.js` checks this flag during ITS init to decide
  // whether to append its own terminal dither pass. Setting it any later is setting it
  // too late.
  p.providesDither = true;

  let quad = null, mat = null, warned = false;
  const cfg = Object.assign({}, DEFAULTS, opts.grain || {});

  p.init = (ctx) => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      // grainDither is deliberately NOT published. `grade.js` publishes `gradeDither`,
      // which is the knob every existing note and regression gate names, and leaving
      // grainDither unset lets that one keep working while still allowing an explicit
      // override here. Publishing a default would shadow it permanently.
      if (k === 'grainDither') continue;
      if (ctx.config[k] === undefined) ctx.config[k] = cfg[k] ?? v;
    }
    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      uRes: { value: new THREE.Vector2(1920, 1080) },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uAspect: { value: 16 / 9 },
      uGrain: { value: cfg.grainAmount },
      uGrainSize: { value: cfg.grainSize },
      uGrainResp: { value: cfg.grainResponse },
      uVigK: { value: 0.066 },
      uCA: { value: cfg.grainCA },
      uCALuma: { value: cfg.grainCALuma },
      uDither: { value: 0 },
      uFrame: { value: 0 },
      uBypass: { value: 0 },
    });
    mat.blending = THREE.NoBlending;
    quad = new FullScreenQuad(mat);
  };

  p.render = (ctx, pipe, out) => {
    const c = ctx.config || {};
    const u = mat.uniforms;

    u.tSrc.value = pipe.read.texture;
    u.uRes.value.set(pipe.w, pipe.h);
    u.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
    u.uAspect.value = pipe.w / Math.max(pipe.h, 1);

    const on = (c.grainEnabled ?? cfg.grainEnabled) !== false;
    u.uBypass.value = on ? 0 : 1;
    u.uGrain.value = Math.max(0, c.grainAmount ?? cfg.grainAmount);
    u.uGrainSize.value = Math.max(0.25, c.grainSize ?? cfg.grainSize);
    u.uGrainResp.value = Math.max(0, Math.min(1, c.grainResponse ?? cfg.grainResponse));
    u.uCA.value = Math.max(0, c.grainCA ?? cfg.grainCA);
    u.uCALuma.value = Math.max(0, Math.min(1, c.grainCALuma ?? cfg.grainCALuma));

    // Solve k so that the corner lands exactly on the requested darkening:
    // (1/(1+k))^2 = 1 - amount.
    const vig = Math.max(0, Math.min(0.95, c.grainVignette ?? cfg.grainVignette));
    u.uVigK.value = vig <= 0 ? 0 : (1 / Math.sqrt(1 - vig) - 1);

    // Deterministic: pipe.frameIndex, never a wall clock.
    u.uFrame.value = pipe.frameIndex % 64;

    // Keyed off writesBackbuffer, NOT off `out === null`. Which pass ends the chain
    // depends on which passes happen to be enabled; inferring it from the target is how
    // the Phase 1 dither became dead code and the sky banded.
    const amt = Math.max(0, c.grainDither ?? c.gradeDither ?? cfg.grainDither);
    u.uDither.value = p.writesBackbuffer ? amt : 0;
    if (!p.writesBackbuffer && !warned) {
      warned = true;
      console.warn('[grain] a pass was registered after grain, so grain is no longer the '
        + '8-bit output stage and its dither is disabled. Dither must be the last thing '
        + 'before the backbuffer write - move this pass, or clear providesDither here and '
        + 'let grade.js append its own terminal dither stage again.');
    }

    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.setSize = () => {};
  p.dispose = () => quad?.dispose();
  return p;
}
