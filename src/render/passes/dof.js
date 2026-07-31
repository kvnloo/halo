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
 *   - near field: full inside 0.28 m, gone by 1.6 m, peak 2.6 px of CoC. In practice
 *     that is the viewmodel and nothing else — the world's nearest geometry is the sand
 *     under the player's feet at ~1.6 m.
 *   - far field: nothing at all until 90 m, reaching 1.5 px only past 700 m. Aerial-
 *     perspective-scale softening on the far islets, not bokeh.
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
 * ## Where the CoC comes from, and the three things that can go wrong with it
 *
 * `cocAtUv()` is the only place depth is consulted, and it refuses to produce a CoC in
 * three cases. Each of these is a real state this build can be in right now:
 *
 *  1. **No G-buffer coverage** (`MRT1.a == 0`) — sky, or a hole. The sky is at infinity
 *     *uniformly*, so it is either entirely in or entirely out of focus and defocusing a
 *     smooth gradient is a no-op that only costs bandwidth. docs/TARGETS.md puts the sky
 *     at `lap_var` 253 and `spectral_slope` −2.95, the smoothest region in the frame;
 *     there is nothing there for a blur to do except lose score.
 *  2. **The viewmodel** — a *fixed* near CoC (dofViewmodelCoC), no depth lookup at all.
 *     It has to be fixed: scene.js draws the viewmodel from its own camera with a
 *     0.002-12 m frustum, so a fragment at 0.3 m writes a depth that decodes to ~12 m
 *     against the main camera's 0.06-12000 m near/far. linearZ() on it would be
 *     meaningless. The weapon sits at a fixed distance from the eye by construction, so a
 *     constant is not an approximation — it is the right model.
 *
 *     **MEASURED, ref_00120, complete scene: this branch is unreachable, and so is every
 *     other one. The pass is currently the exact identity.** Three captures settle it —
 *     dofDebug 4 (G-buffer coverage), dofDebug 3 (matId) and a byte comparison:
 *
 *       - `dofDebug 4` shows coverage = 1 over the whole world and 0 over the sky, with
 *         **no gun anywhere in it**. `scene.js` does not render LAYER.VIEWMODEL into the
 *         G-buffer, so at a gun pixel `g1.a` is the *terrain behind the gun*, not 0.
 *         The "wrote depth, no G-buffer coverage" fallback in `cocAtUv()` therefore can
 *         never fire — the assumption it rests on is false at exactly the pixels it was
 *         written for. `dofDebug 3` confirms no MAT_ID.VIEWMODEL is present either.
 *       - So a gun pixel takes the covered-geometry path. Its depth is the viewmodel's
 *         own (KNOWN_ISSUES 18 clears the shared depth and the viewmodel refills it), and
 *         decoding that 0.002-12 m depth against 0.06-12000 m puts the gun at **~12.4 m**
 *         — squarely inside `cocAt`'s in-focus band (near ends at 1.60 m, far starts at
 *         90 m), so `cocAt` returns exactly 0.
 *       - Every *world* pixel has coverage but reads `raw` = 1.0, because 18 cleared it,
 *         and hits the `raw >= 0.999999` refusal. Also exactly 0.
 *       - Consequence, verified with `cmp`: captures at `dofEnabled 0`, at the shipped
 *         `dofNearGain 2 / fade 0.2..1.1`, and at `dofViewmodelCoC 0` are **byte-identical
 *         to each other**. Not "similar" — identical. The pass ran a prefilter, a 21-tap
 *         gather and a full-res composite every frame to produce the input unchanged.
 *
 *     `dofViewmodelCoC` therefore defaults to **0** and `dofWorldDepthValid` to **false**,
 *     which makes the CPU-side fast-out fire and skips the prefilter and gather. That
 *     changes the output by zero bytes, measured. `create()` prints a one-time
 *     `console.info` naming issue 18 so the flag cannot quietly outlive the bug.
 *
 *     **What to do the day 18 lands.** Set `dofWorldDepthValid: true`; the 90 m -> 700 m
 *     far field then switches on across the whole world for the first time and needs a
 *     look before it is trusted (`dofTestCoC 6` at `ref_00120` exercises the same gather
 *     against a horizontal CoC ramp and is the cheapest way to see the kernel — done, and
 *     it resolves cleanly: soft at both ends, sharp down the middle, no ring at either
 *     transition and no leak of the sharp centre into the blurred sides). Separately, the
 *     viewmodel needs a real signal: either `scene.js` renders LAYER.VIEWMODEL into the
 *     G-buffer with `MAT_ID.VIEWMODEL` (the contract this file already checks for) or the
 *     viewmodel gets its own depth buffer. Until one of those exists, no value of
 *     `dofViewmodelCoC` does anything at all.
 *
 *     The old header carried this table, at 1.2 px, from `diag_gun`:
 *
 *                        lap_var   local_contrast
 *         dofEnabled 0    543.36       0.2634
 *         dofEnabled 1    399.12       0.2632
 *         reference       489          0.178
 *
 *     with an instruction to re-measure it against 489 before trusting the default. Done,
 *     at `ref_00120` on the complete scene: the `weapon` ROI reads `lap_var` **817.6** and
 *     `local_contrast` **0.1238** and does **not move at all** between `dofEnabled 0`,
 *     the old defaults and the new ones, because of the above. The old table described a
 *     pose and a build in which the gun did reach the G-buffer; it is not reproducible
 *     here and has been removed rather than left to be believed.
 *  3. **Covered geometry sitting exactly on the far plane** — impossible for real
 *     geometry, and the signature of a depth buffer that was cleared after the pre-pass
 *     filled it. `scene.js` calls `renderer.clearDepth()` before the viewmodel draw while
 *     `sceneRT.depthTexture` *is* `pipe.depthTex`, so this is not hypothetical — it is
 *     KNOWN_ISSUES 18 and it is what case 2 above measures. Under that condition the pass
 *     degrades to a no-op instead of defocusing the entire world.
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
 *   dofNearMaxCoC     number   px at 1080p, full-res, before the strength scale  (2.6)
 *   dofFarMaxCoC      number   px at 1080p, full-res, before the strength scale  (1.5)
 *   dofViewmodelCoC   number   fixed near CoC for viewmodel pixels               (0.0)
 *   dofWorldDepthValid bool    false while KNOWN_ISSUES 18 is open: the shared depth
 *                              texture holds no world geometry, so the world CoC is
 *                              identically zero and the prefilter+gather are pure cost.
 *                              Set true the day scene.js stops clearing it.  (false)
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
uniform sampler2D tGbuf1;
uniform vec2  uTexel;                 // full-res texel
uniform float uNear, uFar;
uniform float uNearMax, uFarMax;      // peak CoC, full-res pixels
uniform float uNearEnd, uNearStart;   // metres
uniform float uFarStart, uFarEnd;     // metres
uniform float uViewmodelCoC;          // fixed near CoC for the weapon
uniform float uWorldValid;            // 0 = the depth buffer holds no world geometry
uniform float uTestCoC;               // diagnostic; 0 in every real frame

const float MATID_VIEWMODEL = 8.0;

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

/* The only place depth is consulted. See the three refusal cases in the header. */
float cocAtUv(vec2 uv){
  // Diagnostic override: a horizontal CoC ramp, near field on the left, in focus down
  // the middle, far field on the right. It exists because the shipped CoC curve is
  // deliberately zero over almost every depth in this scene, and because the depth
  // buffer is currently cleared before post runs (case 3 below), so on a real frame
  // every path underneath correctly refuses and the gather is unreachable — which makes
  // it unverifiable too. This exercises the filter itself without weakening the
  // defaults to do it. Zero in every real frame.
  if (uTestCoC != 0.0) return uTestCoC * (uv.x * 2.0 - 1.0);

  vec4 g1 = texture(tGbuf1, uv);
  float raw = texture(tDepth, uv).r;

  if (g1.a <= 0.5) {
    // Depth written but no G-buffer coverage means the pixel was drawn AFTER the
    // pre-pass, and scene.js draws exactly one thing after the pre-pass: the viewmodel,
    // from its own 0.002-12 m camera. Its depth is therefore not in the main camera's
    // range and must not be run through linearZ() - it gets the fixed CoC instead.
    // Cleared depth reads exactly 1.0, so the sky falls through to zero.
    if (raw < 0.999999) return -uViewmodelCoC;
    return 0.0;                                                   // sky / no coverage
  }
  if (abs(g1.b * 255.0 - MATID_VIEWMODEL) < 0.5) return -uViewmodelCoC;
  if (raw >= 0.999999) return 0.0;                                // depth not valid here
  if (uWorldValid < 0.5) return 0.0;                              // KNOWN_ISSUES 18 escape
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
  dofNearMaxCoC: 2.6,
  dofFarMaxCoC: 1.5,
  dofViewmodelCoC: 0.0,
  dofNearEnd: 0.28,
  dofNearStart: 1.60,
  dofFarStart: 90.0,
  dofFarEnd: 700.0,
  dofWorldDepthValid: false,
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
     * `dofWorldDepthValid` is the escape for KNOWN_ISSUES 18: while `scene.js` clears
     * the shared depth texture before the viewmodel draw, every world pixel reads 1.0
     * and `cocAtUv` already returns 0 for all of them — so the world maxima below are
     * describing an effect that cannot happen, and they are the only reason this pass
     * cannot bypass. Set it false to make that explicit and get the bypass; set it back
     * to true (the default) the day 18 lands. It does not change the image today. */
    const worldValid = (c.dofWorldDepthValid ?? cfg.dofWorldDepthValid) !== false;
    const wNear = worldValid ? nearMax : 0;
    const wFar = worldValid ? farMax : 0;
    const nearFloor = Math.max(0, c.dofNearFadeLo ?? cfg.dofNearFadeLo);
    const bypass = !(c.dofEnabled ?? cfg.dofEnabled)
      || (testCoC === 0 && wFar <= 0.20 && Math.max(wNear, vmCoC) <= nearFloor);

    // Self-announcing, once per session, so `dofWorldDepthValid: false` cannot quietly
    // outlive the bug it exists for.
    if (!worldValid && !announced) {
      announced = true;
      console.info('[dof] world path disabled: dofWorldDepthValid is false because '
        + 'KNOWN_ISSUES 18 leaves pipe.depthTex holding no world geometry (measured: '
        + 'every pixel returns CoC 0 and the pass is byte-identical to dofEnabled:false). '
        + 'Set ctx.config.dofWorldDepthValid = true the day scene.js stops clearing the '
        + 'shared depth texture, and re-derive dofViewmodelCoC once the viewmodel reaches '
        + 'the G-buffer. See reports/postfx.md.');
    }

    const pushCoc = (u) => {
      u.tDepth.value = pipe.depthTex;
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
