import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `bloom` — energy-conserving HDR glare.
 *
 * Progressive dual-filter pyramid (Jimenez, "Next Generation Post Processing in
 * Call of Duty: Advanced Warfare"):
 *
 *   scene ──13-tap Karis downsample+threshold──▶ mip0 (½ res)
 *   mip0 ──13-tap downsample──▶ mip1 ─▶ … ─▶ mip5  (1/64 res)
 *   mip5 ──9-tap tent, mix(dst, up(src), k)──▶ mip4 ─▶ … ─▶ mip0
 *   out = scene + mip0 * intensity
 *
 * Three things make this behave rather than announce itself:
 *
 *  1. **Karis average on the first downsample only.** Each 2×2 group is weighted by
 *     1/(1+luma) before it is combined, so a single blown-out sub-pixel highlight
 *     cannot dominate a 13-tap footprint. Without it, sun glitter on the swash
 *     produces crawling fireflies that the temporal pass then smears into streaks.
 *  2. **Exposure-relative threshold.** The chain carries log2(luma) in alpha all the
 *     way down; a 1×1 reduction of the smallest mip is the frame's geometric-mean
 *     luminance, and the knee sits at `bloomThresholdRel ×` that. The pass therefore
 *     does the same thing whatever absolute scale the HDR buffer happens to be in and
 *     whatever exposure the tonemapper later picks — only genuinely bright things
 *     (sun disc, specular glints) ever cross the knee. One frame of latency, which is
 *     deterministic under the capture harness.
 *  3. **Unit-energy upsample.** Each step is `mix(dst, tent(src), k)`, done with
 *     fixed-function blending (src=One, dst=OneMinusSrcAlpha, alpha=k), so the mip
 *     weights sum to exactly 1 and `intensity` means "fraction of glare energy",
 *     not "arbitrary brightness knob". The reference is not hazy: default is low.
 *
 * ctx.config knobs (all live):
 *   bloomIntensity 0.28   bloomThresholdRel 3.1   bloomThresholdAbs 0.02
 *   bloomKnee 0.55        bloomRadius 1.0         bloomMix 0.55
 *   bloomAnamorphic 1.35  bloomClamp 140          bloomTint [1,1,1]
 */

const LEVELS = 6;

const HEAD = /* glsl */`
in vec2 vUv;
float bLum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 bSan(vec3 c){ return clamp(mix(vec3(0.0), c, vec3(equal(c, c))), vec3(0.0), vec3(60000.0)); }
`;

/* 13-tap "dual filter" kernel, offsets in source texels.
     A   B   C
       J   K
     D   E   F
       L   M
     G   H   I                                              */
const PREFILTER_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform sampler2D tAvg;
uniform vec2  uT;
uniform float uThreshRel, uThreshAbs, uKnee, uClamp;
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

  // plain 13-tap mean: the honest local luminance, used for the exposure estimate
  vec3 mean13 = g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125;

  // Karis: partial averages weighted by 1/(1+luma) kill single-pixel fireflies
  float w0 = 0.125 / (1.0 + bLum(g0));
  float w1 = 0.125 / (1.0 + bLum(g1));
  float w2 = 0.125 / (1.0 + bLum(g2));
  float w3 = 0.125 / (1.0 + bLum(g3));
  float w4 = 0.500 / (1.0 + bLum(g4));
  vec3 col = (g0*w0 + g1*w1 + g2*w2 + g3*w3 + g4*w4) / (w0 + w1 + w2 + w3 + w4);

  // exposure-relative soft knee
  float avgL = max(exp2(texture(tAvg, vec2(0.5)).r) - 1e-3, 0.0);
  float thr  = max(uThreshAbs, uThreshRel * avgL);
  float knee = max(uKnee * thr, 1e-4);
  float br   = max(col.r, max(col.g, col.b));
  float sq   = clamp(br - thr + knee, 0.0, 2.0 * knee);
  sq = sq * sq / (4.0 * knee);
  col *= max(sq, br - thr) / max(br, 1e-5);
  col  = min(col, vec3(uClamp * max(thr, 1e-4)));

  oCol = vec4(col, log2(bLum(mean13) + 1e-3));
}
`;

const DOWNSAMPLE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uT;
out vec4 oCol;

vec4 S(vec2 o){ vec4 v = texture(tSrc, vUv + o * uT); return vec4(bSan(v.rgb), v.a); }

void main(){
  vec4 a = S(vec2(-2.0, 2.0)), b = S(vec2(0.0, 2.0)), c = S(vec2(2.0, 2.0));
  vec4 d = S(vec2(-2.0, 0.0)), e = S(vec2(0.0, 0.0)), f = S(vec2(2.0, 0.0));
  vec4 g = S(vec2(-2.0,-2.0)), h = S(vec2(0.0,-2.0)), i = S(vec2(2.0,-2.0));
  vec4 j = S(vec2(-1.0, 1.0)), k = S(vec2(1.0, 1.0));
  vec4 l = S(vec2(-1.0,-1.0)), m = S(vec2(1.0,-1.0));

  vec4 g0 = (a + b + d + e) * 0.25;
  vec4 g1 = (b + c + e + f) * 0.25;
  vec4 g2 = (d + e + g + h) * 0.25;
  vec4 g3 = (e + f + h + i) * 0.25;
  vec4 g4 = (j + k + l + m) * 0.25;
  oCol = g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125;
}
`;

/** 8x8 reduction of the smallest mip's alpha (log-luma) into a 1x1 target. */
const AVG_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
out vec4 oCol;
void main(){
  float s = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      float v = texture(tSrc, (vec2(float(x), float(y)) + 0.5) / 8.0).a;
      s += (v == v) ? clamp(v, -12.0, 16.0) : 0.0;
    }
  }
  oCol = vec4(s / 64.0, 0.0, 0.0, 1.0);
}
`;

/* 9-tap tent, then mix() via fixed-function blending: out.rgb = tent*k, out.a = k
   with (src=One, dst=OneMinusSrcAlpha) gives dst' = tent*k + dst*(1-k). */
const UPSAMPLE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2  uT;
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
  oCol = vec4(s * (uK / 16.0), uK);
}
`;

const COMPOSITE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform vec3  uTint;
uniform float uIntensity;
out vec4 oCol;
void main(){
  vec3 s = bSan(texture(tSrc, vUv).rgb);
  vec3 b = bSan(texture(tBloom, vUv).rgb);
  oCol = vec4(s + b * uTint * uIntensity, 1.0);
}
`;

export function create(opts = {}) {
  const p = new Pass('bloom');

  let mips = [];
  let avgRT = null;
  let quad = null;
  let mPre = null, mDown = null, mUp = null, mAvg = null, mComp = null;
  let W = 0, H = 0;
  let avgSeeded = false;

  const cfg = Object.assign({
    intensity: 0.28,
    thresholdRel: 3.1,
    thresholdAbs: 0.02,
    knee: 0.55,
    radius: 1.0,
    mix: 0.55,
    anamorphic: 1.35,
    clamp: 140.0,
  }, opts.bloom || {});

  const tint = new THREE.Vector3(1, 1, 1);

  p.init = (ctx, pipe) => {
    mPre = fsMaterial(PREFILTER_FRAG, {
      tSrc: { value: null }, tAvg: { value: null },
      uT: { value: new THREE.Vector2() },
      uThreshRel: { value: cfg.thresholdRel }, uThreshAbs: { value: cfg.thresholdAbs },
      uKnee: { value: cfg.knee }, uClamp: { value: cfg.clamp },
    });
    mDown = fsMaterial(DOWNSAMPLE_FRAG, { tSrc: { value: null }, uT: { value: new THREE.Vector2() } });
    mAvg = fsMaterial(AVG_FRAG, { tSrc: { value: null } });
    mUp = fsMaterial(UPSAMPLE_FRAG, {
      tSrc: { value: null }, uT: { value: new THREE.Vector2() },
      uRadius: { value: cfg.radius }, uAniso: { value: 1.0 }, uK: { value: cfg.mix },
    });
    mComp = fsMaterial(COMPOSITE_FRAG, {
      tSrc: { value: null }, tBloom: { value: null },
      uTint: { value: tint }, uIntensity: { value: cfg.intensity },
    });

    for (const m of [mPre, mDown, mAvg, mComp]) m.blending = THREE.NoBlending;

    // dst' = src*1 + dst*(1 - src.a) == mix(dst, tent, k)   -> unit-energy pyramid
    mUp.blending = THREE.CustomBlending;
    mUp.blendEquation = THREE.AddEquation;
    mUp.blendSrc = THREE.OneFactor;
    mUp.blendDst = THREE.OneMinusSrcAlphaFactor;
    mUp.blendEquationAlpha = THREE.AddEquation;
    mUp.blendSrcAlpha = THREE.OneFactor;
    mUp.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

    quad = new FullScreenQuad(mComp);

    avgRT = makeRT(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    p._seedAvg(ctx);
    p.setSize(pipe.w || ctx.size.w, pipe.h || ctx.size.h, ctx);
  };

  /** Deterministic starting exposure estimate: log2(1.0). */
  p._seedAvg = (ctx) => {
    const r = ctx.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(avgRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    r.setRenderTarget(prevTarget);
    avgSeeded = true;
  };

  p.setSize = (w, h, ctx) => {
    if (!mPre || (w === W && h === H)) return;
    W = w; H = h;
    for (const rt of mips) rt.dispose();
    mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < LEVELS; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      mips.push(makeRT(mw, mh));
    }
    if (ctx) p._seedAvg(ctx);
  };

  const _draw = (r, mat, target) => {
    quad.material = mat;
    r.setRenderTarget(target);
    quad.render(r);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const c = ctx.config || {};

    if (!mips.length) p.setSize(pipe.w, pipe.h, ctx);
    if (!avgSeeded) p._seedAvg(ctx);

    const intensity = c.bloomIntensity ?? cfg.intensity;
    if (intensity <= 0.0) { pipe.blit(pipe.read.texture, out); return; }

    mPre.uniforms.uThreshRel.value = c.bloomThresholdRel ?? cfg.thresholdRel;
    mPre.uniforms.uThreshAbs.value = c.bloomThresholdAbs ?? cfg.thresholdAbs;
    mPre.uniforms.uKnee.value = c.bloomKnee ?? cfg.knee;
    mPre.uniforms.uClamp.value = c.bloomClamp ?? cfg.clamp;

    // ---------------------------------------------------------- 1. prefilter
    mPre.uniforms.tSrc.value = pipe.read.texture;
    mPre.uniforms.tAvg.value = avgRT.texture;
    mPre.uniforms.uT.value.set(1 / pipe.w, 1 / pipe.h);
    _draw(r, mPre, mips[0]);

    // ------------------------------------------------------ 2. downsample chain
    for (let i = 1; i < LEVELS; i++) {
      const src = mips[i - 1];
      mDown.uniforms.tSrc.value = src.texture;
      mDown.uniforms.uT.value.set(1 / src.width, 1 / src.height);
      _draw(r, mDown, mips[i]);
    }

    // ------------------------- 3. geometric-mean luminance for the next frame
    mAvg.uniforms.tSrc.value = mips[LEVELS - 1].texture;
    _draw(r, mAvg, avgRT);

    // -------------------------------------------------------- 4. upsample chain
    const radius = c.bloomRadius ?? cfg.radius;
    const k = THREE.MathUtils.clamp(c.bloomMix ?? cfg.mix, 0.05, 0.95);
    const aniso = c.bloomAnamorphic ?? cfg.anamorphic;
    mUp.uniforms.uRadius.value = radius;
    mUp.uniforms.uK.value = k;
    for (let i = LEVELS - 2; i >= 0; i--) {
      const src = mips[i + 1];
      mUp.uniforms.tSrc.value = src.texture;
      mUp.uniforms.uT.value.set(1 / src.width, 1 / src.height);
      // only the widest kernel gets the anamorphic stretch; anything more reads as a lens gimmick
      mUp.uniforms.uAniso.value = (i === LEVELS - 2) ? aniso : 1.0;
      _draw(r, mUp, mips[i]);
    }

    // ------------------------------------------------------------ 5. composite
    const t = c.bloomTint;
    if (Array.isArray(t) && t.length === 3) tint.set(t[0], t[1], t[2]); else tint.set(1, 1, 1);
    mComp.uniforms.tSrc.value = pipe.read.texture;
    mComp.uniforms.tBloom.value = mips[0].texture;
    mComp.uniforms.uIntensity.value = intensity;
    _draw(r, mComp, out);
  };

  p.dispose = () => {
    for (const rt of mips) rt.dispose();
    mips = [];
    avgRT?.dispose();
    for (const m of [mPre, mDown, mUp, mAvg, mComp]) m?.dispose();
    quad?.dispose();
  };

  return p;
}
