import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `motionBlur` — McGuire-style reconstruction filter.
 *
 * ("A Reconstruction Filter for Plausible Motion Blur", McGuire/Hennessy/Bukowski/
 * Osman, I3D 2012, plus the tile refinements from Guertin/McGuire/Nowrouzezahrai 2014.)
 *
 * Runs in linear HDR after `taa` and `dof`, before `bloom`. Gathering from a resolved
 * image is the whole reason TAA runs first: smearing a jittered frame along a velocity
 * vector spreads the aliasing rather than hiding it.
 *
 * ## The three passes
 *
 *   1. tileMax   two separable K-tap max reductions, (W,H) -> (W/K,H) -> (W/K,H/K).
 *                Keeps the *vector* with the largest magnitude, not the componentwise
 *                max — a componentwise max invents a diagonal that no surface has.
 *   2. neighbourMax  3x3 max over the tile grid. This is what lets a static pixel know
 *                that something fast is about to sweep across it, which is the entire
 *                difference between a reconstruction filter and a per-pixel smear.
 *   3. reconstruct   scattering-as-gathering along the neighbour-max direction with
 *                McGuire's cone/cylinder weights and a soft depth comparison.
 *
 * ## Why the depth comparison is not optional
 *
 * Without it, a gather along a large velocity vector picks up whatever happens to lie
 * along that line, so a fast foreground object drags background colour into itself and a
 * static background acquires a halo of foreground colour on *both* sides of the object,
 * including the side it is moving away from. The soft comparison splits each tap into
 *
 *   f = "the tap is in front of me"     -> its blur legitimately covers me
 *   b = "I am in front of the tap"      -> my own blur legitimately covers it
 *
 * and weights the two by the tap's and this pixel's velocities respectively. The
 * comparison is *relative* (a fraction of the nearer depth), not absolute: this scene
 * runs a 0.06 m near plane against a 12 km far plane, and any absolute epsilon that
 * resolves a gun barrel is meaningless at a sea stack 400 m out.
 *
 * ## The viewmodel must not smear
 *
 * A ghosting weapon is an instant tell: the gun is rigidly attached to the camera, so
 * when the player turns it is the one thing on screen that is *not* moving relative to
 * the eye, while every velocity vector around it is enormous.
 *
 * Suppression is applied in three places — the tile reduction (so the gun's own velocity
 * never dilates a neighbour's tile), the per-tap weight (so the gun cannot paint the
 * world and the world cannot paint the gun), and a whole-pixel bypass.
 *
 * ## The guard changed this wave, and the one it replaces is EMPTY, not weak
 *
 * Until KNOWN_ISSUES 18 closed, the working test was `drawnAfterPrepass` — 'depth
 * written, no G-buffer coverage'. That was exact **because** of the bug: `scene.js`
 * cleared the shared depth texture and refilled it with the weapon, so the gun was the
 * only thing in `pipe.depthTex` and it had no G-buffer coverage. With 18 closed the gun
 * writes `pipe.viewDepthTex` instead and the shared buffer holds the WORLD BEHIND IT.
 * Counted off the GPU at `ref_00000` (tools/_dfxprobe.mjs):
 *
 *     {depth written AND no coverage}   0 px          <- what the old guard caught
 *     {coverage AND no depth}           0 px
 *     {both}                            1 777 000 px
 *
 * Zero. The two masks are the identical set. So the old guard did not weaken, it emptied,
 * and a gun pixel now reads the *velocity of the terrain behind the gun*. At rest that is
 * still zero, so there is no image change today — but the moment the camera turns, the
 * background behind the weapon carries the largest velocity in the frame and the gun
 * would smear with it. That is the exact artefact this section exists to prevent.
 *
 * The guard is now `pipe.viewDepthTex`: its own depth attachment, cleared to 1.0, written
 * by nothing but the weapon. `texture(tViewDepth, uv).r < 1.0` is a mask, not a heuristic,
 * and it is independent of whether the viewmodel ever reaches the G-buffer.
 *
 * `MAT_ID.VIEWMODEL` (8) in `gbuffer.textures[1].b` is retired with it. It was the
 * contract in docs/ARCHITECTURE.md and `weapons.js` honours it, but `scene.js` renders
 * the G-buffer over LAYER.OPAQUE + LAYER.DEFAULT only and the weapon is on
 * LAYER.VIEWMODEL, so it has never once fired. A dedicated attachment is a stronger
 * signal than a material id; if the viewmodel does reach MRT1 later, this still works.
 *
 * `mbLegacyVmGuard` restores the old `drawnAfterPrepass` test for a same-build A/B.
 *
 * ## `mbNearSuppressM` was harmless and is now harmful — default 0
 *
 * The raw near-distance guard (`zX < uNearSuppress`, 0.35 m) never caught the viewmodel
 * and never claimed to: the weapon is rasterised through a 0.002-12 m frustum, so a
 * fragment at 0.3 m decoded with the world's 0.06-12000 m near/far reads as ~9 m. It was
 * kept 'for a viewmodel one day drawn by the main camera'. What it catches NOW is real
 * world geometry: measured, **11.4 % of `ref_00000` is world closer than 0.35 m** (the
 * cobbles and sand at the camera's feet — the world in this scene starts at 0.26 m, not
 * the 1.6 m the DoF header used to assume). Every one of those pixels takes the
 * whole-pixel bypass, so on a camera turn the fastest-moving thing on screen — the
 * foreground — would be the one thing NOT blurred. Exactly inverted. It defaults to 0
 * (off); the weapon is masked properly now and the guard has no job left.
 *
 * ## Shutter
 *
 * `mbShutter` is the open fraction of the frame interval: 0.5 is a 180 degree shutter,
 * the film-camera default and what the reference reads as. The G-buffer velocity is the
 * full inter-frame displacement, so the sampled extent is +/- 0.5 * shutter * v around
 * the pixel — total smear = half the frame's motion. Taps are clamped to the tile size,
 * because a tile-max grid cannot report a velocity that leaves its own tile.
 *
 * ## Jitter compensation
 *
 * MRT1.rg *used to be* built against a jittered current view-projection and an
 * un-jittered previous one (docs/KNOWN_ISSUES.md #1), so static geometry carried a
 * +/-0.5 px per-frame velocity and this pass added `0.5 * uJitter` to cancel it.
 * **That is fixed at the source now** — `scene.js`, `terrain.js` and `vegetation.js` all
 * write the difference of two un-jittered clip positions — so the compensation would
 * over-correct, and it is applied only under `ctx.config.mvLegacyJitter`, the same A/B
 * flag `taa.js` reads. The over-correction was provably invisible here (<= 0.16 px of
 * half-extent against this pass's own `mbMinPx = 0.60` cutoff); it is removed because
 * making static geometry read exactly zero is what lets the whole-frame early-out fire
 * on a locked-off camera, which is free performance and free determinism.
 *
 * ## Sky
 *
 * Sky and anything else with no G-buffer coverage (`MRT1.a == 0`) has no velocity
 * written for it, so it would sit rock-still while the world swept past — a dead
 * giveaway on a fast turn. Those pixels get a camera-only velocity reconstructed from
 * depth: unproject with the *jittered* inverse view-projection (exact for the pixel as
 * rasterised), reproject through the un-jittered current and previous matrices. At the
 * far plane that is pure rotational parallax, which is precisely what a sky should have.
 *
 * ## ctx.config
 *
 *   mbEnabled        bool    default true
 *   mbShutter        number  open fraction of the frame, 0.5 = 180 deg
 *   mbSamples        int     taps along the neighbour-max line (default 11, odd)
 *   mbTileSize       int     K, and therefore the maximum blur half-extent in px (20)
 *   mbMinPx          number  HALF-EXTENTS below this are treated as zero (0.60)
 *   mbDepthTol       number  soft depth compare extent, fraction of depth (0.05)
 *   mbNearSuppressM  number  metres; closer than this is bypassed. **0 = off**, see above
 *   mbLegacyVmGuard  bool    restore the pre-KNOWN_ISSUES-18 'drawn after pre-pass'
 *                            viewmodel test, for a same-build A/B. It is empty now.
 *   mbDebug          int     0 off | 1 per-pixel velocity | 2 neighbour-max | 3 matId
 *   mbTestVelocity   [x,y]   px/frame injected uniformly, for validating the filter on
 *                            a static capture. Diagnostic only; 0 in every real frame.
 *   mbTestVelX/Y     number  the same thing as two scalars, so it is reachable from
 *                            `capture.mjs --config`, which only parses `k=v`.
 *
 * ## What the filter actually does on a scored still — MEASURED, wave I
 *
 * The captures are stills from a static camera, so the requirement is: near-zero at rest,
 * non-zero on the moving AI. Read back off MRT1 with the tile reduction and the 3x3
 * neighbour-max re-implemented on the CPU (`tools/_dfxprobe.mjs`), so the gate this pass
 * applies is evaluated exactly rather than inferred:
 *
 *     pose        active tiles   frame blurred   max |vN| (half-extent px)   AI px   AI blurred
 *     ref_00000     0 / 5184        0.000 %              0.46                   0        -
 *     ref_00120     0 / 5184        0.000 %              0.41                   0        -
 *     ref_00450     0 / 5184        0.000 %              0.43                   0        -
 *     ref_00600     0 / 5184        0.000 %              0.33                   0        -
 *     ref_00720     0 / 5184        0.000 %              0.59               2 627      0.0 %
 *     ref_00840    51 / 5184        0.984 %              0.82              57 331     10.6 %
 *     ref_01500    41 / 5184        0.791 %              0.64              35 427      7.5 %
 *     ref_01800     0 / 5184        0.000 %              0.43              14 559      0.0 %
 *     ref_02220     0 / 5184        0.000 %              0.36                   0        -
 *
 * At rest the blur is not 'small', it is **exactly zero** on seven of nine poses: every
 * static surface writes an identically-zero velocity (KNOWN_ISSUES 1 is fixed at the
 * source, so there is no jitter residue to clear), the tile max of zeros is zero, and the
 * `lenVN < uMinPx` early-out is therefore uniform across whole tiles. The only non-zero
 * pixels anywhere in a scored still are the animated AI and the two poses where their
 * tiles clear the gate.
 *
 * And the AI blur is *correctly* marginal rather than broken. A marine walking ~2 m/s at
 * 20-40 m subtends ~1-3 px of motion per 60 Hz frame; a 180 degree shutter halves that to
 * a ~0.5-1.5 px total smear. `mbMinPx = 0.60` on the half-extent discards anything under
 * a 1.2 px total smear, which is why 90 % of AI pixels are skipped. That threshold is
 * 2.4x more conservative than McGuire's (the paper skips `||vmax|| <= 0.5` px, i.e. a
 * 0.25 px half-extent). Lowering it would make more of the AI blur, at the cost of
 * running an 11-tap gather to produce a sub-pixel smear; it was left alone because
 * nothing in the reference set measures it and 'make the effect bigger' is not a finding.
 *
 * ## The depth-aware weighting was inert for four waves and is live now
 *
 * By construction, not by inspection: while KNOWN_ISSUES 18 was open every world pixel
 * read `raw = 1.0`, and `linearZ(1.0)` is exactly `uFar` = 12000. So `softZ` was always
 * `softZ(12000, 12000) = clamp(1 - 0/(0.05*12000)) = 1.0` in **both** directions — every
 * tap fully accepted as both foreground and background, which is the same filter with no
 * depth comparison at all. The relative epsilon that the header argues for so carefully
 * had nothing to be relative to. It now sees 0.26 m to 3.5 km of real range.
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
 * tileMax (two reductions into 96x1080 then 96x54) ~0.03 ms; neighbourMax ~0.01 ms;
 * reconstruct ~0.16 ms when nothing moves (the early-out is uniform across whole tiles,
 * so it degenerates to the full-res floor plus one fetch) and ~0.40 ms when the whole
 * frame is in motion. **~0.20 ms typical, ~0.44 ms during a full-screen fast turn.**
 *
 * The known optimisation, deliberately not taken in this pass: fold `velocityUV` into a
 * full-res setup target packing (vel.xy, linearZ, viewmodelFlag) into one RGBA16F, so
 * each of the 11 reconstruction taps becomes two coherent fetches along a line instead
 * of two fetches plus three mat4 products plus a branch. That trades one extra full-res
 * write for a much cheaper and much less divergent inner loop. It is a rewrite of a
 * verified pass for an unmeasured performance concern, which is the wrong trade for a
 * breadth pass - do it when there is a profile that says it matters.
 */

/* ------------------------------------------------------------- velocity library */
/*
 * Shared by the tile reduction and the reconstruction. Returns the per-frame screen
 * displacement in UV units; multiply by uRes for pixels.
 */
const VELOCITY_LIB = /* glsl */`
uniform sampler2D tGbuf1;
uniform sampler2D tDepth;
uniform sampler2D tViewDepth;   // pipe.viewDepthTex - EXACT weapon mask, 1.0 = not the gun
uniform float uHasViewDepth;    // 0 if the pipeline did not publish one
uniform float uLegacyVmGuard;   // 1 = restore the pre-issue-18 test, for a same-build A/B
uniform vec2  uJitter;
uniform float uMvLegacy;
uniform mat4  uInvVPJit;
uniform mat4  uCurrVP;
uniform mat4  uPrevVP;
uniform vec2  uTestVel;      // px/frame, diagnostic injection
uniform vec2  uRes;

/* The weapon, exactly. 'pipe.viewDepthTex' is cleared to 1.0 and written by nothing but
 * the viewmodel draw. This replaces BOTH of the old tests (see the header): the
 * MAT_ID.VIEWMODEL contract, which has never fired because the weapon is not in the
 * G-buffer, and 'drawn after the pre-pass', which was exact only while KNOWN_ISSUES 18
 * was open and now matches 0 pixels at every pose.
 *
 * uLegacyVmGuard restores the old test so the two can be compared in one build. */
bool isViewmodelPx(vec2 uv, vec4 g1, float rawDepth){
  if (uLegacyVmGuard > 0.5) return g1.a <= 0.5 && rawDepth < 0.999999;
  return uHasViewDepth > 0.5 && texture(tViewDepth, uv).r < 1.0;
}

vec2 velocityUV(vec2 uv, out vec4 g1, out float rawDepth){
  g1 = texture(tGbuf1, uv);
  rawDepth = texture(tDepth, uv).r;

  // The viewmodel is rigidly attached to the eye: zero, always. Resolved before anything
  // else and before uTestVel is added, so an injected camera-turn velocity does not reach
  // the gun either. Excluded from the tile reduction too, so it cannot dilate a
  // neighbour's tile.
  if (isViewmodelPx(uv, g1, rawDepth)) return vec2(0.0);

  vec2 v;
  if (g1.a > 0.5) {
    // KNOWN_ISSUES #1 is FIXED: MRT1.rg is now the difference of two un-jittered clip
    // positions and carries no jitter, so this compensation is dead and only re-applied
    // under the mvLegacyJitter A/B flag - exactly as taa.js does it.
    v = g1.rg + uMvLegacy * 0.5 * uJitter;
  } else {
    // No coverage and no depth: sky. Camera-only velocity, reconstructed at the far
    // plane, which is pure rotational parallax — exactly what a sky should have.
    vec4 wp4 = uInvVPJit * vec4(uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
    vec3 wp = wp4.xyz / wp4.w;
    vec4 cc = uCurrVP * vec4(wp, 1.0);
    vec4 pc = uPrevVP * vec4(wp, 1.0);
    if (cc.w <= 1e-5 || pc.w <= 1e-5) return uTestVel / uRes;
    v = (cc.xy / cc.w) * 0.5 - (pc.xy / pc.w) * 0.5;
  }
  return v + uTestVel / uRes;
}
`;

/* ------------------------------------------------------------------ tile passes */

const TILE_X_FRAG = /* glsl */`
in vec2 vUv;
uniform float uTile;
out vec4 oCol;
${VELOCITY_LIB}

void main(){
  int x0 = int(gl_FragCoord.x) * int(uTile);
  int y  = int(gl_FragCoord.y);
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int i = 0; i < int(uTile); i++) {
    vec2 uv = (vec2(float(x0 + i), float(y)) + 0.5) / uRes;
    if (uv.x > 1.0) break;
    vec4 g1; float rawD;
    vec2 v = velocityUV(uv, g1, rawD);
    float l = dot(v, v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  oCol = vec4(best, 0.0, 1.0);
}
`;

const TILE_Y_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uSrcRes;
uniform float uTile;
out vec4 oCol;

void main(){
  int x  = int(gl_FragCoord.x);
  int y0 = int(gl_FragCoord.y) * int(uTile);
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int i = 0; i < int(uTile); i++) {
    vec2 uv = (vec2(float(x), float(y0 + i)) + 0.5) / uSrcRes;
    if (uv.y > 1.0) break;
    vec2 v = texture(tSrc, uv).rg;
    float l = dot(v, v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  oCol = vec4(best, 0.0, 1.0);
}
`;

const NEIGHBOUR_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uSrcTexel;
out vec4 oCol;

void main(){
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 v = texture(tSrc, vUv + vec2(float(i), float(j)) * uSrcTexel).rg;
      float l = dot(v, v);
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  oCol = vec4(best, 0.0, 1.0);
}
`;

/* -------------------------------------------------------------- reconstruction */

const RECON_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tNeighbour;
uniform vec2  uTexel;
uniform float uNear, uFar;
uniform float uHalfShutter;    // 0.5 * shutter
uniform float uMinPx;
uniform float uMaxPx;
uniform float uDepthTol;
uniform float uNearSuppress;   // metres
uniform int   uSamples;
uniform float uFrame;
uniform float uDebug;
out vec4 oCol;
${VELOCITY_LIB}

float linearZ(float d){
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - ndc * (uFar - uNear), 1e-6);
}

/* softZ(a, b) == "b is in front of a", smoothly.
 *
 * Note the argument order against McGuire's listing. The paper stores camera-space z,
 * which is negative in front of the eye and therefore *increases* toward the camera, so
 * its comparison reads (za - zb). linearZ() here returns a positive distance, which
 * increases *away* from the camera, so the subtraction has to be the other way round.
 * Getting this backwards is silent and expensive: the foreground/background split
 * inverts, so a moving foreground stops covering the background it sweeps over and
 * instead smears the background across itself.
 *
 * Relative, not absolute: a 0.06 m near plane against a 12 km far plane means any fixed
 * epsilon that separates a gun barrel is noise at a sea stack 400 m out. */
float softZ(float za, float zb){
  return clamp(1.0 - (zb - za) / max(uDepthTol * min(za, zb), 1e-4), 0.0, 1.0);
}
float cone(float dist, float v){ return clamp(1.0 - dist / max(v, 1e-4), 0.0, 1.0); }
float cylinder(float dist, float v){ return 1.0 - smoothstep(0.95 * v, 1.05 * v, dist); }

/* Integer hash (PCG). Not a fract(sin()) hash: those are precision-dependent and drift
 * between drivers, which would break byte-identical capture. Seeded from the pixel and
 * from pipe.frameIndex, both of which are deterministic under the capture harness. */
uint pcg(uint v){
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float tapJitter(){
  uvec2 q = uvec2(gl_FragCoord.xy);
  uint h = pcg(q.x ^ pcg(q.y ^ uint(uFrame)));
  return float(h) * (1.0 / 4294967295.0) - 0.5;
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;
  vec4 g1X; float rawX;
  vec2 vXuv = velocityUV(vUv, g1X, rawX);
  float zX = linearZ(rawX);

  vec2 vN = texture(tNeighbour, vUv).rg * uRes * uHalfShutter;   // px, half-extent
  vec2 vX = vXuv * uRes * uHalfShutter;

  if (uDebug > 0.5) {
    if (uDebug < 1.5) { oCol = vec4(abs(vX.x) * 0.1, abs(vX.y) * 0.1, 0.0, 1.0); return; }
    if (uDebug < 2.5) { oCol = vec4(abs(vN.x) * 0.1, abs(vN.y) * 0.1, 0.0, 1.0); return; }
    oCol = vec4(vec3(g1X.b * 255.0 / 12.0), 1.0); return;
  }

  float lenVN = min(length(vN), uMaxPx);
  // The viewmodel is rigid in eye space; it must never smear, and it must never be
  // smeared onto. One test now, and it is exact (see the header). uNearSuppress is a
  // second, blunter guard that defaults to 0 = off, because with real world depth in the
  // buffer it catches the beach at the camera's feet rather than the gun.
  bool vmX = isViewmodelPx(vUv, g1X, rawX)
          || (uNearSuppress > 0.0 && zX < uNearSuppress);
  if (lenVN < uMinPx || vmX) { oCol = vec4(src, 1.0); return; }

  vN = vN * (lenVN / max(length(vN), 1e-5));
  float lenVX = min(length(vX), uMaxPx);

  // McGuire's centre weight: a pixel with a small velocity keeps most of its own
  // radiance, which is what stops a slow-moving object being washed out by its
  // fast-moving neighbours.
  float weight = 1.0 / max(lenVX, uMinPx);
  vec3 sum = src * weight;

  float j = tapJitter();
  int n = uSamples;
  for (int i = 0; i < n; i++) {
    if (i == n / 2) continue;                        // centre already accounted for
    float t = mix(-1.0, 1.0, (float(i) + j + 0.5) / float(n));
    vec2 offPx = vN * t;
    vec2 uvY = vUv + offPx * uTexel;
    if (uvY.x < 0.0 || uvY.x > 1.0 || uvY.y < 0.0 || uvY.y > 1.0) continue;

    vec4 g1Y; float rawY;
    vec2 vYuv = velocityUV(uvY, g1Y, rawY);
    // The gun does not paint the world, and the world does not paint the gun.
    if (isViewmodelPx(uvY, g1Y, rawY)) continue;

    float zY = linearZ(rawY);
    float lenVY = min(length(vYuv * uRes * uHalfShutter), uMaxPx);
    float dist = length(offPx);

    float f = softZ(zX, zY);          // Y in front of X: its blur may cover me
    float b = softZ(zY, zX);          // X in front of Y: my blur may cover it
    float w = f * cone(dist, lenVY)
            + b * cone(dist, lenVX)
            + cylinder(dist, lenVY) * cylinder(dist, lenVX) * 2.0;

    sum += texture(tSrc, uvY).rgb * w;
    weight += w;
  }

  oCol = vec4(sum / max(weight, 1e-5), 1.0);
}
`;

/* ------------------------------------------------------------------- the pass */

const DEFAULTS = {
  mbEnabled: true,
  mbShutter: 0.5,
  mbSamples: 11,
  mbTileSize: 20,
  mbMinPx: 0.60,
  mbDepthTol: 0.05,
  // 0, not 0.35: with real world depth in the buffer this caught 11.4 % of ref_00000 —
  // the cobbles at the camera's feet — and bypassed motion blur on all of it. The weapon
  // is masked by pipe.viewDepthTex now, so this guard has nothing left to do. See header.
  mbNearSuppressM: 0.0,
  mbLegacyVmGuard: false,
  mbDebug: 0,
  mbTestVelocity: [0, 0],
  mbTestVelX: 0,
  mbTestVelY: 0,
};

export function create(opts = {}) {
  const p = new Pass('motionBlur');

  let tileXRT = null, tileYRT = null, nbRT = null;
  let tileXMat = null, tileYMat = null, nbMat = null, reconMat = null;
  let tileXQuad = null, tileYQuad = null, nbQuad = null, reconQuad = null;
  let W = 0, H = 0, K = 0;

  const cfg = Object.assign({}, DEFAULTS, opts.motionBlur || {});
  const invVPJit = new THREE.Matrix4();

  const velUniforms = () => ({
    tGbuf1: { value: null },
    tDepth: { value: null },
    tViewDepth: { value: null },
    uHasViewDepth: { value: 0 },
    uLegacyVmGuard: { value: 0 },
    uJitter: { value: new THREE.Vector2() },
    uMvLegacy: { value: 0 },
    uInvVPJit: { value: new THREE.Matrix4() },
    uCurrVP: { value: new THREE.Matrix4() },
    uPrevVP: { value: new THREE.Matrix4() },
    uTestVel: { value: new THREE.Vector2() },
    uRes: { value: new THREE.Vector2(1, 1) },
  });

  p.init = (ctx, pipe) => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (ctx.config[k] === undefined) {
        const d = cfg[k] ?? v;
        ctx.config[k] = Array.isArray(d) ? d.slice() : d;
      }
    }

    tileXMat = fsMaterial(TILE_X_FRAG, Object.assign({ uTile: { value: 20 } }, velUniforms()));
    tileYMat = fsMaterial(TILE_Y_FRAG, {
      tSrc: { value: null }, uSrcRes: { value: new THREE.Vector2() }, uTile: { value: 20 },
    });
    nbMat = fsMaterial(NEIGHBOUR_FRAG, {
      tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() },
    });
    reconMat = fsMaterial(RECON_FRAG, Object.assign({
      tSrc: { value: null }, tNeighbour: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
      uHalfShutter: { value: 0.25 },
      uMinPx: { value: cfg.mbMinPx }, uMaxPx: { value: 20 },
      uDepthTol: { value: cfg.mbDepthTol },
      uNearSuppress: { value: cfg.mbNearSuppressM },
      uSamples: { value: cfg.mbSamples },
      uFrame: { value: 0 }, uDebug: { value: 0 },
    }, velUniforms()));
    for (const m of [tileXMat, tileYMat, nbMat, reconMat]) m.blending = THREE.NoBlending;

    tileXQuad = new FullScreenQuad(tileXMat);
    tileYQuad = new FullScreenQuad(tileYMat);
    nbQuad = new FullScreenQuad(nbMat);
    reconQuad = new FullScreenQuad(reconMat);

    p.setSize(pipe.w > 2 ? pipe.w : ctx.size.w, pipe.h > 2 ? pipe.h : ctx.size.h, ctx);
  };

  const alloc = (w, h, k) => {
    const tw = Math.max(1, Math.ceil(w / k)), th = Math.max(1, Math.ceil(h / k));
    tileXRT?.dispose(); tileYRT?.dispose(); nbRT?.dispose();
    // NearestFilter: these are max reductions, and a bilinear tap between two tiles is
    // an average of two maxima, which is not a maximum of anything.
    const o = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    tileXRT = makeRT(tw, h, o);
    tileYRT = makeRT(tw, th, o);
    nbRT = makeRT(tw, th, o);
    W = w; H = h; K = k;
  };

  p.setSize = (w, h) => {
    if (!tileXMat) return;
    const k = Math.max(4, Math.min(64, (cfg.mbTileSize | 0) || 20));
    if (w === W && h === H && k === K && tileXRT) return;
    alloc(w, h, k);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const c = ctx.config || {};
    const cam = ctx.camera;

    const k = Math.max(4, Math.min(64, (c.mbTileSize | 0) || cfg.mbTileSize));
    if (!tileXRT || W !== pipe.w || H !== pipe.h || K !== k) alloc(pipe.w, pipe.h, k);

    const debug = +(c.mbDebug ?? cfg.mbDebug) || 0;
    const enabled = (c.mbEnabled ?? cfg.mbEnabled) !== false;
    const shutter = Math.max(0, Math.min(1, c.mbShutter ?? cfg.mbShutter));
    // `capture.mjs --config` can only express `k=v`, so the array has scalar twins. A
    // string "x,y" is accepted too - the config parser hands strings through unchanged.
    let tv = c.mbTestVelocity || cfg.mbTestVelocity || [0, 0];
    if (typeof tv === 'string') tv = tv.split(',').map(Number);
    if (!Array.isArray(tv)) tv = [0, 0];
    tv = [(+tv[0] || 0) + (+(c.mbTestVelX ?? cfg.mbTestVelX) || 0),
      (+tv[1] || 0) + (+(c.mbTestVelY ?? cfg.mbTestVelY) || 0)];

    if (!enabled && !debug) { pipe.blit(pipe.read.texture, out); return; }

    invVPJit.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);

    const pushVel = (u) => {
      u.tGbuf1.value = pipe.gbuffer ? pipe.gbuffer.textures[1] : null;
      u.tDepth.value = pipe.depthTex;
      // An unbound sampler reads as (0,0,0,1) in three, i.e. r = 0 < 1.0, which would
      // classify the WHOLE FRAME as viewmodel and switch the pass off. The flag is what
      // makes that impossible.
      u.tViewDepth.value = pipe.viewDepthTex || pipe.depthTex;
      u.uHasViewDepth.value = pipe.viewDepthTex ? 1 : 0;
      u.uLegacyVmGuard.value = (c.mbLegacyVmGuard ?? cfg.mbLegacyVmGuard) ? 1 : 0;
      u.uJitter.value.copy(pipe.jitter);
      u.uMvLegacy.value = c.mvLegacyJitter ? 1 : 0;
      u.uInvVPJit.value.copy(invVPJit);
      u.uCurrVP.value.copy(pipe.currViewProj);
      u.uPrevVP.value.copy(pipe.prevViewProj);
      u.uTestVel.value.set(tv[0] || 0, tv[1] || 0);
      u.uRes.value.set(pipe.w, pipe.h);
    };

    // ---- 1. tile max, separable -------------------------------------------
    pushVel(tileXMat.uniforms);
    tileXMat.uniforms.uTile.value = k;
    r.setRenderTarget(tileXRT);
    tileXQuad.render(r);

    tileYMat.uniforms.tSrc.value = tileXRT.texture;
    tileYMat.uniforms.uSrcRes.value.set(tileXRT.width, tileXRT.height);
    tileYMat.uniforms.uTile.value = k;
    r.setRenderTarget(tileYRT);
    tileYQuad.render(r);

    // ---- 2. neighbour max --------------------------------------------------
    nbMat.uniforms.tSrc.value = tileYRT.texture;
    nbMat.uniforms.uSrcTexel.value.set(1 / tileYRT.width, 1 / tileYRT.height);
    r.setRenderTarget(nbRT);
    nbQuad.render(r);

    // ---- 3. reconstruction -------------------------------------------------
    const u = reconMat.uniforms;
    pushVel(u);
    u.tSrc.value = pipe.read.texture;
    u.tNeighbour.value = nbRT.texture;
    u.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uHalfShutter.value = shutter * 0.5;
    u.uMinPx.value = Math.max(1e-3, c.mbMinPx ?? cfg.mbMinPx);
    // A tile-max grid cannot report a velocity that leaves its own tile, so the blur
    // half-extent is clamped to K. Raising mbTileSize is the way to allow longer trails.
    u.uMaxPx.value = k;
    u.uDepthTol.value = Math.max(1e-4, c.mbDepthTol ?? cfg.mbDepthTol);
    u.uNearSuppress.value = Math.max(0, c.mbNearSuppressM ?? cfg.mbNearSuppressM);
    u.uSamples.value = Math.max(3, Math.min(31, (c.mbSamples | 0) || cfg.mbSamples));
    u.uFrame.value = pipe.frameIndex % 64;
    u.uDebug.value = debug;

    r.setRenderTarget(out);
    reconQuad.render(r);
  };

  p.dispose = () => {
    tileXRT?.dispose(); tileYRT?.dispose(); nbRT?.dispose();
    tileXQuad?.dispose(); tileYQuad?.dispose(); nbQuad?.dispose(); reconQuad?.dispose();
  };

  return p;
}
