import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `taa` — temporal anti-aliasing.
 *
 * The pipeline jitters the projection with Halton(2,3) over 16 samples whenever this
 * pass exists and is enabled (RenderPipeline._applyJitter), so every frame is a
 * different sub-pixel sample of the same image. This pass is the accumulator.
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
 * 3. **YCoCg variance clipping.** Plain 3×3 min/max leaves an enormous box on this
 *    scene's sand and shingle, and the history then wobbles inside it as the jitter
 *    phase cycles. mean ± γ·σ, intersected with a rounded (box+cross)/2 min/max,
 *    then *clipped* toward the box centre rather than clamped per-channel.
 * 4. **Blending happens in tone-mapped space** (c/(1+luma)), which is exactly the
 *    luminance weighting that stops one 5000-nit sun sample from dragging a whole
 *    neighbourhood, and it is inverted exactly afterwards.
 * 5. **Disocclusion from depth.** The history's alpha carries linear view depth; the
 *    current pixel's world position is pushed through the previous view matrix and
 *    compared against the four texels under the reprojected position. Any match
 *    accepts, so silhouettes are not rejected every frame (which would leave them
 *    permanently aliased).
 *
 * Convergence: with a static camera the motion vector is exactly zero, the clip box
 * contains the history, and the resolve is a 1/α exponential average of the 16-phase
 * Halton pattern. α = 0.09 → 24 frames leaves 0.9^24 ≈ 8 % of the initial frame,
 * and the residual jitter-phase ripple is well under a code value.
 *
 * ctx.config knobs: taaAlpha 0.09, taaGamma 1.25, taaSharpen 0.22, taaClipBoost 0.25,
 *                   taaDepthTol 0.055, taaVelBoost 0.006
 */

const FRAG = /* glsl */`
in vec2 vUv;

uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform sampler2D tGbuf1;

uniform vec2  uTexel;
uniform vec2  uRes;
uniform vec2  uJitter;
uniform mat4  uInvVPJit;
uniform mat4  uCurrVP;
uniform mat4  uPrevVP;
uniform mat4  uPrevView;
uniform float uNear, uFar;
uniform float uAlpha, uGamma, uValid, uSharp, uClipBoost, uDepthTol, uVelBoost;

out vec4 oCol;

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
  for (int i = 0; i < 9; i++) {
    m1 += n[i];
    m2 += n[i] * n[i];
    boxMin = min(boxMin, n[i]);
    boxMax = max(boxMax, n[i]);
  }
  vec3 crossMin = min(n[4], min(min(n[1], n[3]), min(n[5], n[7])));
  vec3 crossMax = max(n[4], max(max(n[1], n[3]), max(n[5], n[7])));
  vec3 rMin = 0.5 * (boxMin + crossMin);
  vec3 rMax = 0.5 * (boxMax + crossMax);

  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));
  vec3 mn = max(mu - uGamma * sigma, rMin);
  vec3 mx = min(mu + uGamma * sigma, rMax);

  // Compensate the 1-px box that jitter accumulation convolves in. Applied to the
  // current sample only, and kept inside the true neighbourhood so it cannot ring.
  vec3 cur = n[4] + (n[4] - mu) * uSharp;
  cur = clamp(cur, boxMin, boxMax);
  mn = min(mn, cur);
  mx = max(mx, cur);

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
  vec4 gb = texture(tGbuf1, vUv);
  if (gb.a > 0.5) {
    vec2 mvG = gb.rg + 0.5 * uJitter;
    if (length((mvG - mv) * uRes) > 1.5) mv = mvG;
  }

  vec2 prevUV = vUv - mv;

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
  float relErr = best / max(prevLinZ, 1.0);
  float accept = 1.0 - smoothstep(uDepthTol * 0.45, uDepthTol, relErr);
  accept *= inside * uValid;

  // ------------------------------------------------------------------- resolve
  vec4 hRaw = catmullRom(tHist, clamp(prevUV, uTexel * 0.5, 1.0 - uTexel * 0.5), uRes, uTexel);
  vec3 hist = rgb2ycocg(tone(san(hRaw.rgb)));

  float clipAmt = 0.0;
  vec3 histC = clipToAABB(mn, mx, hist, clipAmt);

  float a = mix(1.0, uAlpha, accept);
  a = max(a, clipAmt * uClipBoost * accept);
  a = clamp(a + length(mv * uRes) * uVelBoost, 0.0, 1.0);

  vec3 res = mix(histC, cur, a);
  oCol = vec4(san(untone(ycocg2rgb(res))), linZ);
}
`;

export function create(opts = {}) {
  const p = new Pass('taa');

  let histA = null, histB = null;
  let quad = null, mat = null, copyMat = null, copyQuad = null;
  let W = 0, H = 0, frames = 0;

  const prevView = new THREE.Matrix4();
  const invVPJit = new THREE.Matrix4();

  const cfg = Object.assign({
    alpha: 0.09,
    gamma: 1.25,
    sharpen: 0.22,
    clipBoost: 0.25,
    depthTol: 0.055,
    velBoost: 0.006,
  }, opts.taa || {});

  p.init = (ctx, pipe) => {
    mat = fsMaterial(FRAG, {
      tCur: { value: null }, tHist: { value: null },
      tDepth: { value: null }, tGbuf1: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRes: { value: new THREE.Vector2() },
      uJitter: { value: new THREE.Vector2() },
      uInvVPJit: { value: new THREE.Matrix4() },
      uCurrVP: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uPrevView: { value: new THREE.Matrix4() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
      uAlpha: { value: cfg.alpha }, uGamma: { value: cfg.gamma },
      uValid: { value: 0 }, uSharp: { value: cfg.sharpen },
      uClipBoost: { value: cfg.clipBoost }, uDepthTol: { value: cfg.depthTol },
      uVelBoost: { value: cfg.velBoost },
    });
    mat.blending = THREE.NoBlending;

    copyMat = fsMaterial(/* glsl */`
      in vec2 vUv; uniform sampler2D tSrc; out vec4 oCol;
      void main(){ oCol = vec4(texture(tSrc, vUv).rgb, 1.0); }`, { tSrc: { value: null } });
    copyMat.blending = THREE.NoBlending;

    quad = new FullScreenQuad(mat);
    copyQuad = new FullScreenQuad(copyMat);

    // A teleport invalidates every temporal buffer in the engine; say so out loud
    // rather than letting the depth test discover it over the next dozen frames.
    ctx.on?.('camera:teleport', () => { frames = 0; });
    ctx.on?.('engine:resize', () => { frames = 0; });

    p.setSize(pipe.w || ctx.size.w, pipe.h || ctx.size.h, ctx);
  };

  p.setSize = (w, h) => {
    if (!mat || (w === W && h === H)) return;
    W = w; H = h; frames = 0;
    histA?.dispose(); histB?.dispose();
    histA = makeRT(w, h);
    histB = makeRT(w, h);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const c = ctx.config || {};
    if (!histA) p.setSize(pipe.w, pipe.h, ctx);

    const u = mat.uniforms;
    u.tCur.value = pipe.read.texture;
    u.tHist.value = histA.texture;
    u.tDepth.value = pipe.depthTex;
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

    u.uAlpha.value = THREE.MathUtils.clamp(c.taaAlpha ?? cfg.alpha, 0.02, 1.0);
    u.uGamma.value = c.taaGamma ?? cfg.gamma;
    u.uSharp.value = c.taaSharpen ?? cfg.sharpen;
    u.uClipBoost.value = c.taaClipBoost ?? cfg.clipBoost;
    u.uDepthTol.value = c.taaDepthTol ?? cfg.depthTol;
    u.uVelBoost.value = c.taaVelBoost ?? cfg.velBoost;
    u.uValid.value = frames > 0 ? 1 : 0;

    r.setRenderTarget(histB);
    quad.render(r);

    copyMat.uniforms.tSrc.value = histB.texture;
    r.setRenderTarget(out);
    copyQuad.render(r);

    const t = histA; histA = histB; histB = t;
    prevView.copy(cam.matrixWorldInverse);
    frames++;
  };

  p.dispose = () => {
    histA?.dispose(); histB?.dispose();
    quad?.dispose(); copyQuad?.dispose();
  };

  return p;
}
