import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `dof` — depth of field, sized for gameplay rather than for a cutscene.
 *
 * Runs in linear HDR after `taa` and before `motionBlur`/`bloom` (docs/ARCHITECTURE.md).
 * Gathering from a resolved image matters here: a defocus filter applied to a jittered
 * frame spreads the aliasing instead of hiding it.
 *
 * ## What "restrained" means, concretely
 *
 * The reference is a first-person shooter at 78 degrees of vertical FOV. Look at any
 * frame of it: the sea stacks 300 m out are *sharp*. There is no rack focus, no creamy
 * background, and the weapon is only slightly soft. Anything more reads as a screenshot
 * filter, and it costs `detail` and `geometry` score directly — a blur is the one post
 * effect that can only ever remove high-frequency energy from the frame.
 *
 * Defaults, at `dofStrength: 'low'`:
 *
 *   - near field: **world near blur is OFF** (`dofNearMaxCoC: 0`). The near field is the
 *     VIEWMODEL's field and is delivered by `dofViewmodelCoC` through an exact weapon
 *     mask. See "The near ramp was authored for a scene that does not exist" below —
 *     this is the constant that changed this wave and it changed by measurement.
 *   - far field: nothing at all until 90 m, reaching 1.5 px only past 700 m. Aerial-
 *     perspective-scale softening on the far islets, not bokeh.
 *
 * ## The near ramp was authored for a scene that does not exist — MEASURED, wave I
 *
 * The header used to justify a 0.28 -> 1.6 m near ramp with: *'in practice that is the
 * viewmodel and nothing else — the world's nearest geometry is the sand under the
 * player's feet at ~1.6 m'*. That was written while KNOWN_ISSUES 18 was open, i.e. while
 * `pipe.depthTex` held only the gun, so it could not be checked. It is now checkable and
 * it is false. Read back off the corrected buffer at `ref_00000` (tools/_dfxprobe.mjs):
 *
 *                                          claimed    measured
 *     nearest world geometry (z p01)         ~1.6 m      0.26 m
 *     world depth median      (z p50)             -      1.13 m
 *     frame inside dofNearStart = 1.60 m         ~0      47.4 %
 *     frame given a near CoC over the floor      ~0      44.2 %
 *
 * The camera in this scene sits low; cobble props and sand fill the bottom half of the
 * frame at 0.26-1.1 m. The decode was verified against a witness that does not touch the
 * depth buffer at all — a CPU raycast of the same scene graph through the same pixels,
 * which agrees with `linearZ()` to three decimals on every cell where both hit the same
 * object (0.341/0.341, 0.612/0.611, 52.255/52.198, 50.517/50.520 m). So 0.26 m is real
 * geometry and `uNear`/`uFar` are right.
 *
 * Turning the world path on with the old ramp, same build, `--config` only, `ref_00000`:
 *
 *                                        score   detail   sand lap_var   weapon lap_var
 *     shipped (bypassed)                 33.14    91.72          614.7            500.6
 *     dofWorldDepthValid=1 alone         24.99    51.36          145.7            187.4
 *     dofWorldDepthValid=1, near off     33.14    91.63              -                -
 *     reference kf_00000                     -        -          521.3            489.4
 *
 * -8.15 score, and the weapon ROI was already AT the reference before the blur. Hence
 * `dofNearMaxCoC: 0`. The knob is kept, not deleted: a scene whose camera stands at
 * normal eye height would have a legitimate use for it, and the ramp endpoints are still
 * the right shape. It is the max that is zero, and it is zero because of the four numbers
 * in the table above, not because near-field DoF is a bad idea.
 *
 * ## The CoC curve is a ramp, not a thin-lens solve, and that is deliberate
 *
 * A physical lens at f/2.8, 15 mm (which is what 78 deg on a 24 mm sensor is), focused
 * at 25 m has a hyperfocal distance around 14 m — the model would produce *no* far blur
 * at all while sending the near field past 40 px on the weapon. Solving the lens equation
 * and then clamping the answer back to 2.6 px is a physical model with the physics taken
 * out. Two explicit smoothsteps say what is actually wanted, are tunable by someone who
 * is not an optician, and cannot surprise anyone. Every shipping FPS does this.
 *
 * ## Near/far handling: scatter-as-gather, which is what stops the leak
 *
 * The gather accepts a tap only when *the tap's own* CoC disc reaches the centre pixel:
 *
 *     w = saturate( coc(tap) - distance + 1 )
 *
 * That single line is the whole near/far correctness argument. An in-focus foreground
 * object beside a defocused background has coc ~ 0, so it is rejected at every distance
 * and cannot bleed its sharp colour into the background's bokeh — the classic artefact.
 * Conversely a defocused *near* object has a large CoC and legitimately does reach
 * across, so it spreads over the background the way a real out-of-focus foreground does.
 * No depth sort, no layer masks, no halo.
 *
 * The two fields accumulate separately (far = taps with positive CoC, near = taps with
 * negative CoC) and the near field carries its own coverage alpha, so it composites
 * *over* the sharp+far result instead of being averaged into it. Averaging is what
 * produces the grey rim around a blurred gun barrel.
 *
 * ## Where the CoC comes from — and why the weapon test changed
 *
 * `cocAtUv()` is the only place depth is consulted. It resolves a pixel in this order:
 *
 *  1. **The viewmodel**, from `pipe.viewDepthTex` — its OWN depth attachment, cleared to
 *     1.0 and written by nothing but the weapon, so `texture(tViewDepth, uv).r < 1.0` is
 *     an EXACT mask. It gets a *fixed* near CoC (`dofViewmodelCoC`) and no depth lookup:
 *     the weapon is rasterised through a 0.002-12 m frustum, so `linearZ()` under the
 *     world's 0.06-12000 m near/far would be meaningless on it, and it sits at a fixed
 *     distance from the eye by construction, so a constant is the right model rather than
 *     an approximation.
 *
 *     **This test is new and it is not optional.** The old test was 'depth written, no
 *     G-buffer coverage', which was exact only BECAUSE KNOWN_ISSUES 18 was open. With 18
 *     closed the gun is not in `pipe.depthTex` at all, so a gun pixel has coverage from
 *     the terrain behind it and takes the covered-geometry path — it reads the CoC of
 *     whatever is BEHIND the weapon. Measured, per pose, over the weapon's ~209 k px:
 *
 *                 world behind gun   weapon px given   given far    mean CoC
 *                        (z p50)        near blur         blur
 *         ref_00000        0.33 m         100.0 %          0 %      -2.50 px
 *         ref_00120        1.09 m          62.1 %          0 %      -0.79 px
 *         ref_00600       13.82 m           0.0 %        6.1 %      +0.09 px
 *         others         2.0-2.7 m           0             0            ~0
 *
 *     At `ref_00000` the entire weapon received the maximum near CoC. The old heuristic is
 *     not merely weaker now, it is EMPTY: counted directly off the GPU, the set
 *     {depth written AND no coverage} is **0 pixels**, and {coverage AND no depth} is also
 *     **0** — the two masks are the identical 1 777 000-pixel set. Not 'small'. Zero.
 *
 *     The `MAT_ID.VIEWMODEL` test that used to sit beside it is gone too. It was correct
 *     in principle and unreachable in fact (`scene.js` renders the G-buffer over
 *     LAYER.OPAQUE + LAYER.DEFAULT only, and the weapon is on LAYER.VIEWMODEL), and
 *     `viewDepthTex` supersedes it: a dedicated attachment is a stronger signal than a
 *     material id, and it works whether or not the viewmodel ever reaches the G-buffer.
 *
 *  2. **No G-buffer coverage** (`MRT1.a == 0`) — sky, or a hole. The sky is at infinity
 *     *uniformly*, so it is either entirely in or entirely out of focus and defocusing a
 *     smooth gradient is a no-op that only costs bandwidth. docs/TARGETS.md puts the sky
 *     at `lap_var` 253 and `spectral_slope` -2.95, the smoothest region in the frame;
 *     there is nothing there for a blur to do except lose score.
 *
 *  3. **Covered geometry, real depth** — `cocAt(linearZ(raw))`. This is the path that was
 *     dead for four waves and is live now. `dofWorldDepthValid` still gates it (the
 *     KNOWN_ISSUES 18 escape hatch) but now defaults to **true**, because the condition
 *     the flag names — *'the day scene.js stops clearing the shared depth texture'* — is
 *     met. See `reports/depth.md`. Setting it false is now only a diagnostic.
 *
 * ## Does the bokeh read at 1080p? No, and it cannot at these radii
 *
 * Worth stating plainly because the kernel is a 20-tap Vogel spiral and that invites the
 * assumption that bokeh *shape* is on screen somewhere. The largest CoC this pass can
 * produce is `dofFarMaxCoC` = 1.5 full-res px, which is 0.75 px in the half-res gather,
 * against a search radius of `0.75 + 1 = 1.75` half-res px. Twenty-one taps over a disc
 * 1.5 half-res px across is enormously oversampled and has no resolvable structure: a
 * defocus disc needs roughly 4+ px of radius before its edge reads as a disc rather than
 * as a blur. So the spiral is doing sampling quality here, not aperture shape, and the
 * tap count could be cut substantially before anything became visible. The Vogel set is
 * still the right choice - it is what keeps the small kernel isotropic and free of the
 * 6-point star a low-count ring would give - but nobody should look for bokeh in a frame.
 *
 * ## Structure
 *
 *   1. prefilter (half res)  rgb = colour, a = signed CoC in full-res pixels. The CoC of
 *      the 2x2 block is the one with the largest magnitude, so a thin near edge (a gun
 *      sight, a barrel rim) survives the downsample instead of being averaged away.
 *   2. gather (half res)     20-tap golden-angle spiral (circular bokeh) + centre, two
 *      accumulators. rgb = near-over-far, a = near coverage.
 *   3. composite (full res)  mix(src, blur, max(farBlend, nearAlpha)). In-focus pixels
 *      come through the source path bit-identical, which is why the composite is at full
 *      resolution rather than being an upsample of the blur.
 *
 * Half resolution for 1-2 costs nothing at these radii (2.6 px of full-res CoC is 1.3
 * half-res px) and turns a 21-tap full-res gather into a quarter of the work.
 *
 * ## ctx.config
 *
 *   dofEnabled        bool     false = straight copy
 *   dofStrength       string   'off' | 'low' | 'medium' | 'high'   (default 'low')
 *   dofNearMaxCoC     number   WORLD near CoC, px at 1080p, full-res, before the
 *                              strength scale. **0** — see the measurement above. (0.0)
 *   dofFarMaxCoC      number   px at 1080p, full-res, before the strength scale  (1.5)
 *   dofViewmodelCoC   number   fixed near CoC for viewmodel pixels, delivered through
 *                              the pipe.viewDepthTex mask                        (0.0)
 *   dofWorldDepthValid bool    KNOWN_ISSUES 18 escape hatch. The condition it named is
 *                              met (reports/depth.md), so this is now **true** and
 *                              setting it false is a diagnostic, not a workaround.
 *   dofNearEnd        number   metres: full near blur at or below this   (0.28)
 *   dofNearStart      number   metres: near blur gone at or above this   (1.60)
 *   dofFarStart       number   metres: far blur begins                   (90)
 *   dofFarEnd         number   metres: far blur saturates                (700)
 *   dofNearGain       number   how fast near coverage saturates          (1.0)
 *   dofNearFadeLo/Hi  number   full-res px of near CoC over which the half-res gather
 *                              earns its authority                       (0.50 / 2.00)
 *   dofDebug          number   0 off | 1 linear depth | 2 signed CoC | 3 matId | 4 coverage
 *   dofTestCoC        number   DIAGNOSTIC. Non-zero replaces the whole CoC derivation
 *                              with a horizontal ramp from -v (near, left) through 0
 *                              (in focus, centre) to +v (far, right), so the gather can
 *                              be exercised and looked at while the scene has no
 *                              G-buffer coverage at all. 0 in every real frame.
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

/* ------------------------------------------------------------------ the kernel */
/*
 * Golden-angle (Vogel) spiral. Equal-area, so tap density is uniform over the disc and
 * the bokeh is round rather than a 6-point star; and it is a *fixed* point set, so there
 * is no per-pixel rotation and therefore no noise for the grain pass to fight. Generated
 * in JS and baked into the shader as a const array — no runtime randomness, nothing for
 * determinism to trip over.
 */
function vogel(n) {
  const GA = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * GA;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}
const TAPS = 20;
const KERNEL_GLSL = `const vec2 KERN[${TAPS}] = vec2[${TAPS}](`
  + vogel(TAPS).map(([x, y]) => `vec2(${x.toFixed(5)},${y.toFixed(5)})`).join(',') + ');';

/* --------------------------------------------------------------- shared GLSL */

const COC_LIB = /* glsl */`
uniform sampler2D tDepth;
uniform sampler2D tViewDepth;         // pipe.viewDepthTex - EXACT weapon mask, 1.0 = not the gun
uniform float uHasViewDepth;          // 0 if the pipeline did not publish one
uniform sampler2D tGbuf1;
uniform vec2  uTexel;                 // full-res texel
uniform float uNear, uFar;
uniform float uNearMax, uFarMax;      // peak CoC, full-res pixels
uniform float uNearEnd, uNearStart;   // metres
uniform float uFarStart, uFarEnd;     // metres
uniform float uViewmodelCoC;          // fixed near CoC for the weapon
uniform float uWorldValid;            // 0 = the depth buffer holds no world geometry
uniform float uTestCoC;               // diagnostic; 0 in every real frame

/* The weapon, exactly. 'pipe.viewDepthTex' is cleared to 1.0 and written by nothing but
 * the viewmodel draw, so this is a mask and not a heuristic. It replaces the old
 * 'depth written but no G-buffer coverage' test, which was exact only while
 * KNOWN_ISSUES 18 was open and is now empty at every pose (measured: 0 px). */
bool isViewmodelPx(vec2 uv){
  return uHasViewDepth > 0.5 && texture(tViewDepth, uv).r < 1.0;
}

float linearZ(float d){
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - ndc * (uFar - uNear), 1e-6);
}

/* Signed circle of confusion in FULL-RES pixels. Negative = near field, positive = far.
 * Zero over the whole depth range a player actually shoots at, which is the design. */
float cocAt(float z){
  float nearC = uNearMax * (1.0 - smoothstep(uNearEnd, uNearStart, z));
  float farC  = uFarMax  * smoothstep(uFarStart, uFarEnd, z);
  return farC - nearC;
}

/* The only place depth is consulted. Order matters: the weapon is in front of
 * everything, so it is resolved first and never reaches the world curve. */
float cocAtUv(vec2 uv){
  // Diagnostic override: a horizontal CoC ramp, near field on the left, in focus down
  // the middle, far field on the right. The shipped CoC curve is deliberately zero over
  // most of this scene's depth range, so without this the gather is hard to see at all.
  // Zero in every real frame.
  if (uTestCoC != 0.0) return uTestCoC * (uv.x * 2.0 - 1.0);

  // 1. The viewmodel, from its own depth attachment. Exact, not a heuristic.
  if (isViewmodelPx(uv)) return -uViewmodelCoC;

  vec4 g1 = texture(tGbuf1, uv);
  float raw = texture(tDepth, uv).r;

  // 2. Sky / no coverage. 'depthTex' is 1.0 there and there is nothing to defocus.
  if (g1.a <= 0.5) return 0.0;
  if (raw >= 0.999999) return 0.0;

  // 3. Real world geometry at a real distance. Live since KNOWN_ISSUES 18 closed.
  if (uWorldValid < 0.5) return 0.0;                              // diagnostic only
  return cocAt(linearZ(raw));
}
`;

/* ------------------------------------------------------------- 1. prefilter */

const PREFILTER_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
out vec4 oCol;
${COC_LIB}

void main(){
  // One bilinear tap on a half-res grid is exactly the 2x2 box average of the source.
  vec3 c = texture(tSrc, vUv).rgb;

  // The G-buffer and depth are NEAREST, so the four texels have to be fetched
  // explicitly. Keep the CoC with the largest magnitude rather than the average: a
  // one-pixel-wide near edge must survive the downsample, and averaging it against three
  // background samples deletes it.
  vec2 h = uTexel * 0.5;
  float c0 = cocAtUv(vUv + vec2(-h.x, -h.y));
  float c1 = cocAtUv(vUv + vec2( h.x, -h.y));
  float c2 = cocAtUv(vUv + vec2(-h.x,  h.y));
  float c3 = cocAtUv(vUv + vec2( h.x,  h.y));
  float a = c0;
  if (abs(c1) > abs(a)) a = c1;
  if (abs(c2) > abs(a)) a = c2;
  if (abs(c3) > abs(a)) a = c3;

  oCol = vec4(c, a);
}
`;

/* ---------------------------------------------------------------- 2. gather */

const GATHER_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tPre;
uniform vec2  uHalfTexel;
uniform float uRadius;      // search radius, HALF-res pixels
uniform float uNearGain;
uniform vec2  uNearFade;    // sub-pixel coverage fade, HALF-res px (lo, hi)
out vec4 oCol;

${KERNEL_GLSL}

/* Near-field COVERAGE for a tap whose near CoC is cocS (half-res px) at distance dist.
 *
 * Two factors, and the second one is not optional.
 *
 *  - scatter-as-gather: the tap's own disc must reach the centre.
 *  - a sub-pixel fade. Without it, a tap with a CoC of 0.1 px still returns weight 1 at
 *    dist 0, the coverage alpha saturates, and the composite replaces the pixel wholesale
 *    with the half-res gather - which is a ~2 px blur no matter how small the CoC was,
 *    because the half-res round trip is itself a box downsample and a bilinear upsample.
 *    That is a blur FLOOR imposed by the internal resolution rather than by the optics,
 *    and it is invisible in a still of a smooth surface and glaring on a gun sight.
 *    Measured: it cost 26% of the weapon ROI's lap_var at a nominal 1.2 px of CoC.
 *
 * The ramp is uNearFade, in half-res pixels, and its endpoints are set by the
 * *half-res round trip*, not by the optics. A box downsample followed by a bilinear
 * upsample is a ~2 full-res-pixel low-pass; below that the gather cannot represent the
 * blur it is being asked for, so its authority has to fade out or it substitutes its
 * own floor for the requested CoC. Default 0.25..1.00 half-res px = 0.50..2.00 full-res,
 * i.e. the gather gets no authority at all below half a pixel of CoC and full authority
 * only once the requested blur exceeds what the round trip itself imposes.
 *
 * The first version of this used smoothstep(0.10, 0.55) — 0.20..1.10 full-res, copied
 * from the far field's composite ramp — and that is a full pixel too early: at the
 * 0.9 px viewmodel CoC it returns 0.874, which uNearGain 2.0 then clipped to exactly
 * 1.0, so the composite replaced the whole gun with the half-res gather and the fade
 * bought nothing. Measured on the finished scene, weapon ROI: see the table in the
 * header. */
float nearCoverage(float cocS, float dist){
  float cn = max(-cocS, 0.0);
  return clamp(cn - dist + 1.0, 0.0, 1.0) * smoothstep(uNearFade.x, uNearFade.y, cn);
}

void main(){
  vec4 c0 = texture(tPre, vUv);
  float coc0 = c0.a * 0.5;                 // full-res px -> half-res px

  // Centre tap: distance 0, so its own disc always covers it.
  vec3 farSum  = c0.rgb;        float farW  = 1.0;
  float cov0 = nearCoverage(coc0, 0.0);
  vec3 nearSum = c0.rgb * cov0; float nearW = cov0;
  float nearHits = cov0;

  for (int i = 0; i < ${TAPS}; i++) {
    vec2 o = KERN[i] * uRadius;            // half-res pixels
    float dist = length(o);
    vec4 s = texture(tPre, vUv + o * uHalfTexel);
    float cocS = s.a * 0.5;

    // Scatter-as-gather: the TAP's disc must reach the centre. An in-focus foreground
    // (cocS ~ 0) is rejected at every distance and cannot leak into a defocused
    // background; a defocused near object has a big CoC and legitimately does reach.
    float wf = clamp(max(cocS, 0.0) - dist + 1.0, 0.0, 1.0);
    float wn = nearCoverage(cocS, dist);

    farSum  += s.rgb * wf;  farW  += wf;
    nearSum += s.rgb * wn;  nearW += wn;
    nearHits += wn;
  }

  vec3 farCol  = farSum / max(farW, 1e-4);
  vec3 nearCol = nearSum / max(nearW, 1e-4);

  // Coverage, not weight: the fraction of the search disc occupied by near-field taps.
  // This is what lets the near field composite OVER the background instead of being
  // averaged into it (averaging is what produces a grey rim around a blurred barrel).
  float alpha = clamp(nearHits / float(${TAPS} + 1) * uNearGain, 0.0, 1.0);

  oCol = vec4(mix(farCol, nearCol, alpha), alpha);
}
`;

/* ------------------------------------------------------------- 3. composite */

const COMPOSITE_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tBlur;
uniform float uBypass;
uniform float uDebug;
out vec4 oCol;
${COC_LIB}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;

  if (uDebug > 0.5) {
    if (uDebug < 1.5) {                              // 1: linear depth, log grey
      float z = linearZ(texture(tDepth, vUv).r);
      float g = clamp(log2(max(z, 0.01) / 0.05) / 16.0, 0.0, 1.0);
      oCol = vec4(vec3(g), 1.0); return;
    }
    if (uDebug < 2.5) {                              // 2: signed CoC (red near, blue far)
      float c = cocAtUv(vUv);
      oCol = vec4(max(-c, 0.0) * 0.35, (1.0 - min(abs(c), 1.0)) * 0.25, max(c, 0.0) * 0.35, 1.0);
      return;
    }
    vec4 g1 = texture(tGbuf1, vUv);
    if (uDebug < 3.5) { oCol = vec4(vec3(g1.b * 255.0 / 12.0), 1.0); return; }  // 3: matId
    oCol = vec4(vec3(g1.a), 1.0); return;                                       // 4: coverage
  }

  if (uBypass > 0.5) { oCol = vec4(src, 1.0); return; }

  float coc = cocAtUv(vUv);
  vec4 b = texture(tBlur, vUv);

  // Far field fades in over the first pixel of CoC, so anything the player is looking at
  // comes through the source path bit-identical. Near coverage overrides, because a sharp
  // background behind a blurred gun must still receive the gun's spread.
  float farBlend = smoothstep(0.20, 1.10, max(coc, 0.0));
  oCol = vec4(mix(src, b.rgb, clamp(max(farBlend, b.a), 0.0, 1.0)), 1.0);
}
`;

/* ------------------------------------------------------------------ the pass */

const STRENGTH = { off: 0.0, low: 1.0, medium: 1.8, high: 3.0 };

const DEFAULTS = {
  dofEnabled: true,
  dofStrength: 'low',
  // 0.0, not 2.6: measured, the world reaches 0.26 m in this scene and the old ramp put
  // a visible near CoC on 44.2 % of ref_00000 for -8.15 score. See the header.
  dofNearMaxCoC: 0.0,
  dofFarMaxCoC: 1.5,
  // The weapon's fixed near CoC. It has an exact signal for the first time (viewDepthTex)
  // but no reference measurement isolating the gun exists, our weapon ROI lap_var is
  // already at the reference without it (500.6 vs 489.4 at ref_00000), and the reference
  // weapon reads sharp — so it ships at 0 and is a one-line change for whoever gets a
  // gun-only reference number. Note the composite's own floor: anything below
  // `dofNearFadeLo` (0.50 px) is identically zero, so the useful range starts there.
  dofViewmodelCoC: 0.0,
  dofNearEnd: 0.28,
  dofNearStart: 1.60,
  dofFarStart: 90.0,
  dofFarEnd: 700.0,
  dofWorldDepthValid: true,
  dofNearGain: 1.0,
  dofNearFadeLo: 0.50,      // full-res px of near CoC at which the gather starts to count
  dofNearFadeHi: 2.00,      // full-res px at which it is trusted completely
  dofDebug: 0,
  dofTestCoC: 0,
};

export function create(opts = {}) {
  const p = new Pass('dof');

  let preRT = null, blurRT = null;
  let preMat = null, gatherMat = null, compMat = null;
  let preQuad = null, gatherQuad = null, compQuad = null;
  let W = 0, H = 0;
  let announced = false;

  const cfg = Object.assign({}, DEFAULTS, opts.dof || {});

  const cocUniforms = () => ({
    tDepth: { value: null },
    tViewDepth: { value: null },
    uHasViewDepth: { value: 0 },
    tGbuf1: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.06 }, uFar: { value: 12000 },
    uNearMax: { value: cfg.dofNearMaxCoC }, uFarMax: { value: cfg.dofFarMaxCoC },
    uNearEnd: { value: cfg.dofNearEnd }, uNearStart: { value: cfg.dofNearStart },
    uFarStart: { value: cfg.dofFarStart }, uFarEnd: { value: cfg.dofFarEnd },
    uViewmodelCoC: { value: cfg.dofViewmodelCoC },
    uWorldValid: { value: 1 },
    uTestCoC: { value: 0 },
  });

  p.init = (ctx, pipe) => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (ctx.config[k] === undefined) ctx.config[k] = cfg[k] ?? v;
    }

    preMat = fsMaterial(PREFILTER_FRAG, Object.assign({ tSrc: { value: null } }, cocUniforms()));
    gatherMat = fsMaterial(GATHER_FRAG, {
      tPre: { value: null },
      uHalfTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.5 },
      uNearGain: { value: cfg.dofNearGain },
      uNearFade: { value: new THREE.Vector2(cfg.dofNearFadeLo * 0.5, cfg.dofNearFadeHi * 0.5) },
    });
    compMat = fsMaterial(COMPOSITE_FRAG, Object.assign({
      tSrc: { value: null }, tBlur: { value: null },
      uBypass: { value: 0 }, uDebug: { value: 0 },
    }, cocUniforms()));
    for (const m of [preMat, gatherMat, compMat]) m.blending = THREE.NoBlending;

    preQuad = new FullScreenQuad(preMat);
    gatherQuad = new FullScreenQuad(gatherMat);
    compQuad = new FullScreenQuad(compMat);

    p.setSize(pipe.w > 2 ? pipe.w : ctx.size.w, pipe.h > 2 ? pipe.h : ctx.size.h, ctx);
  };

  p.setSize = (w, h) => {
    if (!preMat || (w === W && h === H && preRT)) return;
    W = w; H = h;
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    preRT?.dispose(); blurRT?.dispose();
    preRT = makeRT(hw, hh);
    blurRT = makeRT(hw, hh);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const c = ctx.config || {};
    const cam = ctx.camera;
    if (!preRT || W !== pipe.w || H !== pipe.h) p.setSize(pipe.w, pipe.h, ctx);

    const debug = +(c.dofDebug ?? cfg.dofDebug) || 0;
    const scale = STRENGTH[String(c.dofStrength ?? cfg.dofStrength)] ?? STRENGTH.low;
    // CoC maxima are authored at 1080p and scale with resolution, so the *look* is
    // resolution-independent rather than the pixel count being.
    const resScale = pipe.h / 1080;
    const nearMax = Math.max(0, (c.dofNearMaxCoC ?? cfg.dofNearMaxCoC) * scale * resScale);
    const farMax = Math.max(0, (c.dofFarMaxCoC ?? cfg.dofFarMaxCoC) * scale * resScale);
    const vmCoC = Math.max(0, (c.dofViewmodelCoC ?? cfg.dofViewmodelCoC) * scale * resScale);
    const testCoC = +(c.dofTestCoC ?? cfg.dofTestCoC) || 0;

    /* Fast-out. A pixel can only ever receive blur if it clears one of the composite's
     * own blend floors: the far field fades in over smoothstep(0.20, 1.10) of full-res
     * CoC, and the near field over `dofNearFadeLo`..`Hi`. If no configured source can
     * reach either floor, the composite is the identity and the prefilter + gather are
     * pure bandwidth. The old test was `(nearMax + farMax + vmCoC) < 0.05`, which with
     * the shipped 2.6/1.5 maxima could never fire under any viewmodel setting — so the
     * three-stage chain ran every frame to deliver a sub-pixel blur on a gun.
     *
     * `dofWorldDepthValid` was the escape for KNOWN_ISSUES 18. 18 is closed and it now
     * defaults to true; setting it false still forces every world pixel to CoC 0, which
     * with `dofNearMaxCoC: 0` and `dofViewmodelCoC: 0` makes the whole pass bypass. That
     * is the diagnostic arm of the A/B, not a workaround. */
    const worldValid = (c.dofWorldDepthValid ?? cfg.dofWorldDepthValid) !== false;
    const wNear = worldValid ? nearMax : 0;
    const wFar = worldValid ? farMax : 0;
    const nearFloor = Math.max(0, c.dofNearFadeLo ?? cfg.dofNearFadeLo);
    const bypass = !(c.dofEnabled ?? cfg.dofEnabled)
      || (testCoC === 0 && wFar <= 0.20 && Math.max(wNear, vmCoC) <= nearFloor);

    // Self-announcing, once per session. The KNOWN_ISSUES 18 announcement is gone — the
    // world path is on. What is worth one line is the OTHER way of switching this pass
    // off by accident: a pipeline that publishes no viewmodel depth, which silently
    // returns the weapon to reading the CoC of the terrain behind it.
    if (!announced && !pipe.viewDepthTex) {
      announced = true;
      console.info('[dof] pipe.viewDepthTex is absent, so the weapon has no mask and '
        + 'takes the world CoC of whatever is behind it (measured at ref_00000: the full '
        + '-2.6 px near CoC over 100% of the gun). See reports/depthfx.md.');
    }

    const pushCoc = (u) => {
      u.tDepth.value = pipe.depthTex;
      // An unbound sampler reads as (0,0,0,1) in three, i.e. r = 0 < 1.0, which would
      // classify the WHOLE FRAME as viewmodel. The flag is what makes that impossible.
      u.tViewDepth.value = pipe.viewDepthTex || pipe.depthTex;
      u.uHasViewDepth.value = pipe.viewDepthTex ? 1 : 0;
      u.tGbuf1.value = pipe.gbuffer ? pipe.gbuffer.textures[1] : null;
      u.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      u.uNearMax.value = nearMax; u.uFarMax.value = farMax;
      u.uViewmodelCoC.value = vmCoC;
      u.uWorldValid.value = worldValid ? 1 : 0;
      u.uNearEnd.value = c.dofNearEnd ?? cfg.dofNearEnd;
      u.uNearStart.value = c.dofNearStart ?? cfg.dofNearStart;
      u.uFarStart.value = c.dofFarStart ?? cfg.dofFarStart;
      u.uFarEnd.value = c.dofFarEnd ?? cfg.dofFarEnd;
      u.uTestCoC.value = testCoC;
    };

    if (!bypass && !debug) {
      pushCoc(preMat.uniforms);
      preMat.uniforms.tSrc.value = pipe.read.texture;
      r.setRenderTarget(preRT);
      preQuad.render(r);

      const gu = gatherMat.uniforms;
      gu.tPre.value = preRT.texture;
      gu.uHalfTexel.value.set(2 / pipe.w, 2 / pipe.h);
      // Search radius in half-res pixels; +1 so a tap whose disc only just reaches the
      // centre is still inside the search set.
      gu.uRadius.value = Math.max(1.0,
        Math.max(Math.abs(testCoC), Math.max(nearMax, Math.max(farMax, vmCoC))) * 0.5 + 1.0);
      gu.uNearGain.value = c.dofNearGain ?? cfg.dofNearGain;
      // Half-res units: the gather works in half-res pixels, the knobs are authored in
      // full-res ones so they read against the CoC maxima above them.
      gu.uNearFade.value.set(
        Math.max(0, (c.dofNearFadeLo ?? cfg.dofNearFadeLo) * 0.5),
        Math.max(1e-3, (c.dofNearFadeHi ?? cfg.dofNearFadeHi) * 0.5));
      r.setRenderTarget(blurRT);
      gatherQuad.render(r);
    }

    const cu = compMat.uniforms;
    pushCoc(cu);
    cu.tSrc.value = pipe.read.texture;
    cu.tBlur.value = blurRT ? blurRT.texture : null;
    cu.uBypass.value = bypass ? 1 : 0;
    cu.uDebug.value = debug;
    r.setRenderTarget(out);
    compQuad.render(r);
  };

  p.dispose = () => {
    preRT?.dispose(); blurRT?.dispose();
    preQuad?.dispose(); gatherQuad?.dispose(); compQuad?.dispose();
  };

  return p;
}
