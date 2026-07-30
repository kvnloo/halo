import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `taa` — temporal anti-aliasing.
 *
 * The pipeline jitters the projection with Halton(2,3) over 16 samples whenever this
 * pass exists and is enabled (RenderPipeline._applyJitter), so every frame is a
 * different sub-pixel sample of the same image. This pass is the accumulator.
 *
 * It must run *first* in the post chain — ahead of dof, motionBlur and bloom. All three
 * read sub-pixel structure: bloom's threshold test in particular fires on a different
 * set of highlights on every jitter phase if it is fed a jittered, un-resolved image,
 * which is a direct path to sparkle crawl. `PASS_MANIFEST` orders it that way;
 * `_hoist()` re-asserts it at runtime and complains loudly if the manifest regresses,
 * because that regression is invisible in a still and expensive in motion.
 *
 * Design notes, in order of how much they matter to *not softening the picture*:
 *
 * 1. **Reprojection is derived from depth, not from the G-buffer velocity, for
 *    everything that is not actually moving.** `scene.js` builds MRT1.rg from the
 *    *jittered* current view-projection against the *un-jittered* previous one, so it
 *    carries a ±½-pixel per-frame error. Feeding that straight into the history
 *    lookup makes the resolve random-walk by half a pixel every frame, which is a
 *    permanent, irrecoverable blur — the single most common way a TAA ends up mushy.
 *    Here the world position is reconstructed with the *jittered* inverse view-proj
 *    (exact for the pixel as rasterised) and re-projected through the un-jittered
 *    current and previous matrices. With a static camera that yields a bit-exact
 *    zero motion vector, so Catmull-Rom lands precisely on the texel centre and the
 *    history resample is an identity. The G-buffer velocity is used only where it
 *    disagrees with the depth-derived one by more than 1.5 px, i.e. genuinely moving
 *    geometry, where half a pixel is irrelevant (and it is jitter-corrected anyway).
 * 2. **Catmull-Rom history resampling** (5 bilinear taps, MJP's optimisation). At
 *    f = 0 the weights collapse to the centre tap exactly, so a stationary image
 *    never loses energy to resampling.
 * 3. **YCoCg variance clipping** — mean ± γ·σ intersected with a rounded
 *    (box+cross)/2 min/max, then *clipped* toward the box centre rather than clamped
 *    per channel. Two things are deliberately NOT done to that box:
 *      - it is built from the **unsharpened** neighbourhood. Widening the ghost-
 *        rejection box by exactly the unsharp amount, at every edge, every frame, is
 *        letting stale history through in precisely the place it is visible.
 *      - it is **not** what velocity modulates. Raising α under motion (the previous
 *        build went 0.09 → 0.47 on a 180 °/s turn) switches the accumulator off for
 *        the whole of a firefight and snaps sharp when you stop. Motion instead
 *        *tightens* γ, which rejects ghosts without throwing accumulation away.
 * 4. **Point highlights are not averaged into the background.** A lone bright texel
 *    in a dark 3×3 has μ = S/9 and σ = 0.314·S, so the variance box tops out at
 *    0.58·S and the accumulator converges to ~0.62·S — a star, a distant specular
 *    glint or a wet-sand sparkle loses a third of its peak on top of the honest
 *    sub-pixel dilution. `spike` detects single-tap dominance (top1 − top2 bigger than
 *    half the rest of the range), opens the box to the true 3×3 extent there, and
 *    lifts α so the highlight tracks the frame rather than the 16-phase mean. This is
 *    the same problem UE solves with `bResponsiveAA` and COD with stencil-tagged
 *    particles; without a stencil channel to key off, the image itself is the signal.
 * 5. **Disocclusion is a plane test, not a relative-depth test.** A scalar tolerance
 *    cannot tell a grazing surface from a disocclusion: the beach fills the lower half
 *    of every reference frame and its depth changes several percent per pixel, so any
 *    tolerance loose enough not to reject it (the old 5.5 %) never rejects anything,
 *    and everything smears. The allowance is now the depth change the *surface* can
 *    legitimately produce over the reprojection footprint, from the G-buffer view
 *    normal and the camera's tan(fov/2):  dz/dpixel = 2·z·|n.x|·tanX / (W·|n.z|).
 *    Grazing geometry gets a large allowance because it earns one; a silhouette does
 *    not, because the *surface* there is not grazing. That lets the relative term drop
 *    from 5.5 % to 1 %.
 * 6. **Blending happens in tone-mapped space** (c/(1+luma)), which is exactly the
 *    luminance weighting that stops one 5000-nit sun sample from dragging a whole
 *    neighbourhood, and it is inverted exactly afterwards.
 * 7. **The unsharp is not a sharpness result.** Accumulating 16 sub-pixel phases
 *    convolves by well under a 1-px box, so the honest deconvolution is small;
 *    calibrating it upward until lap_var matches supersampled ground truth is fitting
 *    the metric. Default 0.15, and it is decoupled from `accept` — scaling it by how
 *    much history is in play left every newly disoccluded region soft and gave moving
 *    silhouettes a visible soft wake that faded in over ~1/α frames.
 *
 * ctx.config knobs:
 *   taaAlpha 0.09        taaGamma 1.6        taaGammaMoving 0.85
 *   taaSharpen 0.22      taaClipBoost 0.25   taaSpike 0.50
 *   taaDepthTol 0.01     taaSlopeScale 2.5   taaVelGamma 0.02
 *   taaVelBoost 0.0008   taaVelAlphaMax 0.10
 */

const FRAG = /* glsl */`
in vec2 vUv;

uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform sampler2D tGbuf0;
uniform sampler2D tGbuf1;

uniform vec2  uTexel;
uniform vec2  uRes;
uniform vec2  uJitter;
uniform vec2  uTanHalf;
uniform mat4  uInvVPJit;
uniform mat4  uCurrVP;
uniform mat4  uPrevVP;
uniform mat4  uPrevView;
uniform float uNear, uFar;
uniform float uAlpha, uGamma, uGammaMoving, uValid, uSharp, uClipBoost, uSpike;
uniform float uDepthTol, uSlopeScale, uVelGamma, uVelBoost, uVelAlphaMax;

out vec4 oCol;

/** NaN-safe and non-negative: tone()/untone() divide by (1 ± luma), which is only
 *  invertible for non-negative radiance, and accumulating negative light is meaningless.
 *  The tonemapper clamps at zero as well, so nothing is lost here that survives later. */
vec3 san(vec3 c){ return clamp(mix(vec3(0.0), c, vec3(equal(c, c))), vec3(0.0), vec3(60000.0)); }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 tone(vec3 c){ return c / (1.0 + lum(c)); }
vec3 untone(vec3 c){ return c / max(1.0 - lum(c), 1e-4); }
vec3 rgb2ycocg(vec3 c){
  return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
               0.50 * c.r            - 0.50 * c.b,
              -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 ycocg2rgb(vec3 c){
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

/** 5-tap Catmull-Rom. Identity when the sample lands on a texel centre. */
vec4 catmullRom(sampler2D tex, vec2 uv, vec2 res, vec2 invRes){
  vec2 sp = uv * res;
  vec2 tp1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 t0  = (tp1 - 1.0) * invRes;
  vec2 t3  = (tp1 + 2.0) * invRes;
  vec2 t12 = (tp1 + o12) * invRes;

  vec4 r = vec4(0.0);
  float k;
  k = w12.x * w0.y;  r += texture(tex, vec2(t12.x, t0.y )) * k;  float s = k;
  k = w0.x  * w12.y; r += texture(tex, vec2(t0.x,  t12.y)) * k;  s += k;
  k = w12.x * w12.y; r += texture(tex, vec2(t12.x, t12.y)) * k;  s += k;
  k = w3.x  * w12.y; r += texture(tex, vec2(t3.x,  t12.y)) * k;  s += k;
  k = w12.x * w3.y;  r += texture(tex, vec2(t12.x, t3.y )) * k;  s += k;
  return r / max(s, 1e-5);
}

vec3 clipToAABB(vec3 mn, vec3 mx, vec3 q, out float amount){
  vec3 c = 0.5 * (mx + mn);
  vec3 e = 0.5 * (mx - mn) + 1e-5;
  vec3 v = q - c;
  vec3 a = abs(v / e);
  float m = max(a.x, max(a.y, a.z));
  amount = clamp(1.0 - 1.0 / max(m, 1.0), 0.0, 1.0);
  return (m > 1.0) ? (c + v / m) : q;
}

vec3 fetchN(vec2 uv){ return rgb2ycocg(tone(san(texture(tCur, uv).rgb))); }

void main(){
  // ---------------------------------------------------------------- current 3x3
  vec3 n[9];
  n[0] = fetchN(vUv + vec2(-uTexel.x, -uTexel.y));
  n[1] = fetchN(vUv + vec2( 0.0,      -uTexel.y));
  n[2] = fetchN(vUv + vec2( uTexel.x, -uTexel.y));
  n[3] = fetchN(vUv + vec2(-uTexel.x,  0.0));
  n[4] = fetchN(vUv);
  n[5] = fetchN(vUv + vec2( uTexel.x,  0.0));
  n[6] = fetchN(vUv + vec2(-uTexel.x,  uTexel.y));
  n[7] = fetchN(vUv + vec2( 0.0,       uTexel.y));
  n[8] = fetchN(vUv + vec2( uTexel.x,  uTexel.y));

  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 boxMin = n[0], boxMax = n[0];
  float top1 = -1e9, top2 = -1e9;          // two brightest taps, for spike detection
  for (int i = 0; i < 9; i++) {
    m1 += n[i];
    m2 += n[i] * n[i];
    boxMin = min(boxMin, n[i]);
    boxMax = max(boxMax, n[i]);
    float y = n[i].x;
    if (y > top1) { top2 = top1; top1 = y; } else if (y > top2) { top2 = y; }
  }
  vec3 crossMin = min(n[4], min(min(n[1], n[3]), min(n[5], n[7])));
  vec3 crossMax = max(n[4], max(max(n[1], n[3]), max(n[5], n[7])));
  vec3 rMin = 0.5 * (boxMin + crossMin);
  vec3 rMax = 0.5 * (boxMax + crossMax);
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));

  // One tap much brighter than every other == a sub-pixel point highlight, not an
  // edge (an edge puts several taps near the top, so top1 - top2 is small).
  float spike = clamp(((top1 - top2) - 0.5 * (top2 - boxMin.x))
                      / max(top1 - boxMin.x, 1e-5), 0.0, 1.0);

  // ------------------------------------------------------------- reprojection
  float dz = texture(tDepth, vUv).r;
  float ndcZ = dz * 2.0 - 1.0;
  float linZ = (2.0 * uNear * uFar) / max(uFar + uNear - ndcZ * (uFar - uNear), 1e-6);

  vec4 wp4 = uInvVPJit * vec4(vUv * 2.0 - 1.0, ndcZ, 1.0);
  vec3 wp = wp4.xyz / wp4.w;

  vec4 cc = uCurrVP * vec4(wp, 1.0);
  vec4 pc = uPrevVP * vec4(wp, 1.0);
  bool projOk = (cc.w > 1e-5) && (pc.w > 1e-5);
  vec2 curTrue  = (cc.xy / max(cc.w, 1e-5)) * 0.5 + 0.5;
  vec2 prevTrue = (pc.xy / max(pc.w, 1e-5)) * 0.5 + 0.5;
  vec2 mv = curTrue - prevTrue;                 // exact for static geometry

  // Dynamic geometry: MRT1.rg is (cur - prev) * 0.5 in NDC with the current jitter
  // baked in; +0.5*jitter removes it. Only trusted where it actually disagrees.
  vec4 gb1 = texture(tGbuf1, vUv);
  if (gb1.a > 0.5) {
    vec2 mvG = gb1.rg + 0.5 * uJitter;
    if (length((mvG - mv) * uRes) > 1.5) mv = mvG;
  }

  vec2 prevUV = vUv - mv;
  float vel = length(mv * uRes);                       // pixels of travel this frame

  float inside = (prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0) ? 1.0 : 0.0;
  if (!projOk) inside = 0.0;

  // -------------------------------------------------------------- disocclusion
  float prevLinZ = -(uPrevView * vec4(wp, 1.0)).z;
  vec2 hp = floor(prevUV * uRes - 0.5) + 0.5;
  vec2 hb = hp * uTexel;
  float d0 = texture(tHist, hb).a;
  float d1 = texture(tHist, hb + vec2(uTexel.x, 0.0)).a;
  float d2 = texture(tHist, hb + vec2(0.0, uTexel.y)).a;
  float d3 = texture(tHist, hb + uTexel).a;
  float best = min(min(abs(d0 - prevLinZ), abs(d1 - prevLinZ)),
                   min(abs(d2 - prevLinZ), abs(d3 - prevLinZ)));

  // How much depth this *surface* may legitimately change over the reprojection
  // footprint. From the plane through the pixel: z = c / (n . d), so
  // dz/du = -z * n.x * tanX / (n . d), and one pixel is 2/W of NDC.
  vec3 nv = gb1.a > 0.5 ? normalize(texture(tGbuf0, vUv).xyz * 2.0 - 1.0) : vec3(0.0, 0.0, 1.0);
  float slope = 2.0 * prevLinZ
              * (abs(nv.x) * uTanHalf.x * uTexel.x + abs(nv.y) * uTanHalf.y * uTexel.y)
              / max(abs(nv.z), 0.06);
  float tol = uDepthTol * prevLinZ + uSlopeScale * slope + 0.01;
  float accept = 1.0 - smoothstep(tol * 0.5, tol, best);
  accept *= inside * uValid;

  // ---------------------------------------------------------------- clip box
  // Motion tightens the variance box instead of raising alpha: that is what rejects
  // stale history, and it costs no accumulation.
  float gam = mix(uGamma, uGammaMoving, clamp(vel * uVelGamma, 0.0, 1.0));
  vec3 mn = max(mu - gam * sigma, rMin);
  vec3 mx = min(mu + gam * sigma, rMax);
  // ...but a genuine point highlight is not variance to be clipped away.
  mn = mix(mn, min(mn, boxMin), spike);
  mx = mix(mx, max(mx, boxMax), spike);

  // 16 sub-pixel phases convolve the image with a box that has a real MTF roll-off;
  // deconvolve a little against the 3x3 mean. Fixed strength, clamped to the true
  // neighbourhood so it cannot ring past a real extreme — and deliberately NOT folded
  // back into mn/mx, which would widen the ghost clamp at every edge.
  vec3 cur = clamp(n[4] + (n[4] - mu) * uSharp, boxMin, boxMax);

  // ------------------------------------------------------------------- resolve
  vec4 hRaw = catmullRom(tHist, clamp(prevUV, uTexel * 0.5, 1.0 - uTexel * 0.5), uRes, uTexel);
  vec3 hist = rgb2ycocg(tone(san(hRaw.rgb)));

  float clipAmt = 0.0;
  vec3 histC = clipToAABB(mn, mx, hist, clipAmt);

  float a = mix(1.0, uAlpha, accept);
  a = max(a, clipAmt * uClipBoost * accept);
  a = max(a, spike * uSpike * accept);
  a = clamp(a + min(vel * uVelBoost, uVelAlphaMax), 0.0, 1.0);

  vec3 res = mix(histC, cur, a);
  oCol = vec4(san(untone(ycocg2rgb(res))), linZ);
}
`;

export function create(opts = {}) {
  const p = new Pass('taa');

  let histA = null, histB = null;
  let quad = null, mat = null;
  let W = 0, H = 0, frames = 0, lastPipeFrame = -99, hoisted = false;

  const prevView = new THREE.Matrix4();
  const invVPJit = new THREE.Matrix4();

  const cfg = Object.assign({
    alpha: 0.09,
    gamma: 1.6,
    gammaMoving: 0.85,
    sharpen: 0.22,
    clipBoost: 0.25,
    spike: 0.50,
    depthTol: 0.01,
    slopeScale: 2.5,
    velGamma: 0.02,
    velBoost: 0.0008,
    velAlphaMax: 0.10,
  }, opts.taa || {});

  /**
   * Assert (and if necessary restore) "taa before bloom/dof/motionBlur" in the live
   * pass list. A no-op against the current manifest — it exists because that ordering
   * is invisible in a still frame and expensive in motion, so a regression should
   * announce itself rather than quietly cost sparkle crawl. Done on the first render,
   * not in init/setSize: the pipeline iterates `passes` in both of those and splicing
   * an array mid-iteration skips entries, whereas `render()` iterates a filtered copy.
   */
  const _hoist = (pipe) => {
    const arr = pipe.passes;
    const me = arr.indexOf(p);
    let target = -1;
    for (const name of ['bloom', 'motionBlur', 'dof']) {
      const i = arr.findIndex((q) => q.name === name);
      if (i >= 0 && (target < 0 || i < target)) target = i;
    }
    if (me < 0 || target < 0 || me <= target) return;
    arr.splice(me, 1);
    arr.splice(target, 0, p);
    frames = 0;
    console.warn('[taa] hoisted ahead of bloom/motionBlur/dof at runtime; '
      + 'PASS_MANIFEST in pipeline.js still lists it last.');
  };

  p.init = (ctx, pipe) => {
    mat = fsMaterial(FRAG, {
      tCur: { value: null }, tHist: { value: null },
      tDepth: { value: null }, tGbuf0: { value: null }, tGbuf1: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRes: { value: new THREE.Vector2() },
      uJitter: { value: new THREE.Vector2() },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uInvVPJit: { value: new THREE.Matrix4() },
      uCurrVP: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uPrevView: { value: new THREE.Matrix4() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
      uAlpha: { value: cfg.alpha }, uGamma: { value: cfg.gamma },
      uGammaMoving: { value: cfg.gammaMoving },
      uValid: { value: 0 }, uSharp: { value: cfg.sharpen },
      uClipBoost: { value: cfg.clipBoost }, uSpike: { value: cfg.spike },
      uDepthTol: { value: cfg.depthTol }, uSlopeScale: { value: cfg.slopeScale },
      uVelGamma: { value: cfg.velGamma }, uVelBoost: { value: cfg.velBoost },
      uVelAlphaMax: { value: cfg.velAlphaMax },
    });
    mat.blending = THREE.NoBlending;

    quad = new FullScreenQuad(mat);

    // A teleport invalidates every temporal buffer in the engine; say so out loud
    // rather than letting the depth test discover it over the next dozen frames.
    ctx.on?.('camera:teleport', () => { frames = 0; });
    ctx.on?.('engine:resize', () => { frames = 0; });

    p.setSize(Math.max(2, pipe.w > 2 ? pipe.w : ctx.size.w), Math.max(2, pipe.h > 2 ? pipe.h : ctx.size.h), ctx);
  };

  p.setSize = (w, h) => {
    if (!mat || (w === W && h === H && histA && histB)) return;
    W = w; H = h; frames = 0;
    histA?.dispose(); histB?.dispose();
    histA = makeRT(w, h);
    histB = makeRT(w, h);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const c = ctx.config || {};
    if (!hoisted) { hoisted = true; _hoist(pipe); }
    if (!histA) p.setSize(pipe.w, pipe.h, ctx);
    // Skipped frames (pass toggled off for an A/B, or a stalled tab) leave a history
    // that no longer matches the previous-frame matrices. Start clean instead.
    if (pipe.frameIndex !== lastPipeFrame + 1) frames = 0;
    lastPipeFrame = pipe.frameIndex;

    const u = mat.uniforms;
    u.tCur.value = pipe.read.texture;
    u.tHist.value = histA.texture;
    u.tDepth.value = pipe.depthTex;
    u.tGbuf0.value = pipe.gbuffer.textures[0];
    u.tGbuf1.value = pipe.gbuffer.textures[1];
    u.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
    u.uRes.value.set(pipe.w, pipe.h);
    u.uJitter.value.copy(pipe.jitter);

    // cam.projectionMatrixInverse is still the jittered one at post time — that is
    // exactly what unprojects the pixel as it was rasterised.
    invVPJit.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    u.uInvVPJit.value.copy(invVPJit);
    u.uCurrVP.value.copy(pipe.currViewProj);
    u.uPrevVP.value.copy(pipe.prevViewProj);
    u.uPrevView.value.copy(prevView);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    // tan(fov/2) per axis, from the un-jittered projection: P[0][0] = 1/tanX,
    // P[1][1] = 1/tanY. Feeds the plane-slope disocclusion tolerance.
    const pe = pipe.unjitteredProj.elements;
    u.uTanHalf.value.set(1 / Math.max(Math.abs(pe[0]), 1e-6), 1 / Math.max(Math.abs(pe[5]), 1e-6));

    u.uAlpha.value = THREE.MathUtils.clamp(c.taaAlpha ?? cfg.alpha, 0.02, 1.0);
    u.uGamma.value = c.taaGamma ?? cfg.gamma;
    u.uGammaMoving.value = c.taaGammaMoving ?? cfg.gammaMoving;
    u.uSharp.value = c.taaSharpen ?? cfg.sharpen;
    u.uClipBoost.value = c.taaClipBoost ?? cfg.clipBoost;
    u.uSpike.value = c.taaSpike ?? cfg.spike;
    u.uDepthTol.value = c.taaDepthTol ?? cfg.depthTol;
    u.uSlopeScale.value = c.taaSlopeScale ?? cfg.slopeScale;
    u.uVelGamma.value = c.taaVelGamma ?? cfg.velGamma;
    u.uVelBoost.value = c.taaVelBoost ?? cfg.velBoost;
    u.uVelAlphaMax.value = c.taaVelAlphaMax ?? cfg.velAlphaMax;
    u.uValid.value = frames > 0 ? 1 : 0;

    r.setRenderTarget(histB);
    quad.render(r);

    // The history has to carry linear view depth in alpha and the chain output must
    // not, so the resolve cannot simply *be* the chain buffer — one copy is structural.
    // Use the pipeline's own blit (it writes vec4(rgb, 1.0)) rather than a second copy
    // material and quad of our own.
    pipe.blit(histB.texture, out);

    const t = histA; histA = histB; histB = t;
    prevView.copy(cam.matrixWorldInverse);
    frames++;
  };

  p.dispose = () => {
    histA?.dispose(); histB?.dispose();
    quad?.dispose();
  };

  return p;
}
