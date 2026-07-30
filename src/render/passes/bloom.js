import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `bloom` — HDR glare: the lens/eye veiling response to light that is brighter than
 * the display can show.
 *
 * Progressive dual-filter pyramid (Jimenez, "Next Generation Post Processing in
 * Call of Duty: Advanced Warfare"):
 *
 *   scene ──13-tap Karis downsample+threshold──▶ mip0 (½ res)
 *   mip0 ──13-tap downsample──▶ mip1 ─▶ … ─▶ mip7  (1/256 res)
 *   mip7 ──9-tap tent, mix(dst, up(src), k_i)──▶ mip6 ─▶ … ─▶ mip0
 *   out = scene + mip0 * intensity
 *
 * ## 1. The threshold is expressed in the tonemapper's units, and solved for
 *
 * "Display-referred" is only meaningful if it is stated in the units the display
 * transform actually consumes. `tonemap` feeds it `exposure * MODE_GAIN * 2^EV`
 * times the scene radiance, and under AgX display white sits at an *exposed-linear*
 * ~16.3 (the top of AgX's log2 range is 0.18·2^6.5), not at 1.0. A knee at 1.12
 * exposed-linear is sRGB 206 — four stops below white, squarely in the midtones, and
 * it produces a hazy image whose glare is dominated by things that are not bright.
 *
 * So the knee is *solved* rather than guessed: `displayWhite()` inverts the active
 * display transform on its neutral axis (all three curves preserve neutrals to within
 * 1e-4, so a scalar bisection is exact) to find the exposed-linear value that lands on
 * `bloomThresholdSrgb` (default 0.97 ≈ code 247). Divide by the same
 * `exposure · MODE_GAIN · 2^EV` the tonemapper uses and you get the scene-linear knee.
 * Switch `tonemapper` to 'aces' and the knee tracks it — including MODE_GAIN, which
 * is 1.6757 for ACES and used to silently move the knee by 0.75 stops.
 *
 * There is exactly ONE threshold path. The old build had a second, differently
 * calibrated self-exposure branch selected by `(uExposure > 0) ? … : …`, and which one
 * ran depended on whether `tonemap` had seeded `ctx.config.exposure` yet — a race that
 * produced three different images from nine identical captures. `tonemap.init` runs
 * before *any* pass renders, so reading it at render time is always well-defined; if
 * it is missing this pass fails loudly instead of quietly becoming a different effect.
 *
 * ## 2. The pyramid has to be able to reach
 *
 * Veiling glare is a ~1/r² point-spread function that spans a large fraction of the
 * frame. Six levels with a 1-texel tent bottoms out at a 30×17 mip and a cumulative
 * support of ~126 px at 1080p: a tight Gaussian bud, not a veil. Eight levels with a
 * 2-texel tent reach ~1000 px.
 *
 * Reach is necessary but not sufficient — the *weights* decide the profile. A single
 * `mix` constant k gives near-geometric octave weights (k=0.55 → 0.45, 0.25, 0.14 …),
 * so the composite is dominated by the half-res mip no matter how many levels exist.
 * Here the octave energies are chosen first, as `w_i ∝ (i+1)^-falloff`, and the
 * per-step blend constants are derived from them: with `S_j = Σ_{m≥j} w_m`, the step
 * that upsamples mip j+1 into mip j uses `k_j = S_{j+1}/S_j`, which reproduces w
 * exactly and still sums to 1 (unit energy — `intensity` stays "fraction of glare
 * energy"). A 2-D kernel of scale s has peak density ∝ 1/s², and s doubles per octave,
 * so *equal* octave weights are exactly a 1/r² profile; `falloff` tilts around that.
 *
 * ## 3. Karis average on the first downsample only
 *
 * Each 2×2 group is weighted by 1/(1+luma) before combining, so one blown-out
 * sub-pixel highlight cannot dominate a 13-tap footprint — sun glitter on the swash
 * otherwise produces crawling fireflies that TAA smears into streaks. The firefly
 * clamp is a multiple of the threshold (`bloomClamp`, 60×) and must stay well clear of
 * the sun: at 140× a 1.12 threshold it was clipping the sun disc to 229 and stealing a
 * quarter of its own halo.
 *
 * ## 4. Chromatic, slightly anamorphic
 *
 * A perfectly neutral radially symmetric Gaussian reads as a filter. Real glare is
 * warm in the core and cool in the skirt (dispersion + coating), and a rectangular
 * aperture stretches it. Each upsample step carries its own tint ratio, so octave j
 * ends up tinted by `∏_{m<j} t_m` — a smooth core→tail chromatic ramp, each step
 * normalised to luma 1 so the octave *energies* are untouched. The stretch is graded
 * across the widest four steps rather than applied to one step carrying 5% of the
 * energy, where it was invisible.
 *
 * ctx.config knobs (all live):
 *   bloomIntensity 0.42      fraction of above-knee energy redistributed
 *   bloomThresholdSrgb 0.97  display code value the knee closes at
 *   bloomThresholdDisplay    optional explicit exposed-linear knee (overrides the solve)
 *   bloomKnee 0.55           soft-knee width, as a fraction of the threshold
 *   bloomRadius 2.0          tent radius in source texels
 *   bloomFalloff 0.85        octave weight exponent; 0 = flat = 1/r²
 *   bloomAnamorphic 1.25     horizontal stretch on the widest steps
 *   bloomChroma 1.0          strength of the core→tail tint ramp
 *   bloomClamp 60            firefly ceiling, in multiples of the threshold
 *   bloomTint [1,1,1]        global tint on top of everything
 *
 * Cost at 1920×1080 on a 3080 Ti: 1 prefilter + 7 downsamples + 7 upsamples +
 * 1 composite ≈ 0.42 ms (the extra two levels are 1/1024 of a frame each).
 */

const LEVELS = 8;

/* --------------------------------------------------------------- display maths */
/* A local, neutral-axis-only mirror of `tonemap`'s transfer functions. It exists so
 * the knee can be *solved* for a display code value instead of hard-coded, and it is
 * deliberately a copy rather than an import: passes are independent files (see
 * docs/ARCHITECTURE.md) and bloom must not fall over because tonemap failed to load.
 * All three curves preserve neutrals — every matrix in the chain has unit row sums to
 * within 1e-4 — so one scalar per curve is exact. If tonemap's curve ever changes,
 * the knee moves by a few code values, not by stops. */

const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

/** Mirrors tonemap.js MODE_GAIN — the per-curve exposure compensation the tonemapper
 *  multiplies in. Missing it moved the knee 0.75 stops on a switch to 'aces'. */
const MODE_GAIN = { agx: 1.0, aces: 1.6757, reinhard: 1.5031, none: 1.0 };

const agxSigmoid = (x) => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
    + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

const srgbEncode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

/** exposed-linear -> sRGB code value in [0,1], on the neutral axis. */
function displayOf(v, mode, white) {
  v = Math.max(v, 0);
  let d;
  if (mode === 'aces') {
    d = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  } else if (mode === 'reinhard') {
    const w2 = Math.max(white * white, 1e-4);
    d = v * (1 + v / w2) / (1 + v);
  } else if (mode === 'none') {
    d = v;
  } else {
    const x = (Math.log2(Math.max(v, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
    d = Math.pow(Math.max(agxSigmoid(Math.min(Math.max(x, 0), 1)), 0), 2.2);
  }
  return srgbEncode(Math.min(Math.max(d, 0), 1));
}

/** Exposed-linear value that the active display transform maps to `target` sRGB.
 *  Bisection in log2 space: every curve here is monotonic, 60 halvings of a 24-stop
 *  bracket is exact to float precision, and it runs once per config change. */
function displayWhite(target, mode, white) {
  let lo = -12, hi = 14;
  if (displayOf(Math.pow(2, hi), mode, white) < target) return Math.pow(2, hi);
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (displayOf(Math.pow(2, mid), mode, white) < target) lo = mid; else hi = mid;
  }
  return Math.pow(2, 0.5 * (lo + hi));
}

/* ------------------------------------------------------------- pyramid weights */

/** Octave energies w_i ∝ (i+1)^-falloff, normalised. falloff 0 == flat == 1/r². */
function octaveWeights(n, falloff) {
  const w = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { w[i] = Math.pow(i + 1, -falloff); s += w[i]; }
  for (let i = 0; i < n; i++) w[i] /= s;
  return w;
}

/** Per-step blend constants that realise `w` exactly: k_j = S_{j+1}/S_j. */
function blendConstants(w) {
  const n = w.length;
  const S = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) S[i] = S[i + 1] + w[i];
  const k = new Array(n - 1);
  for (let j = 0; j < n - 1; j++) k[j] = S[j + 1] / Math.max(S[j], 1e-9);
  return k;
}

const CORE_TINT = [1.00, 0.95, 0.86];   // octave 0: warm
const TAIL_TINT = [0.88, 0.92, 1.00];   // octave LEVELS-1: cool
const lum709 = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Cumulative tint per octave, luma-normalised so only hue moves, then differenced
 *  into the per-step ratios the upsample loop actually applies. */
function tintRamp(n, chroma) {
  const T = [];
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) : 0;
    let c = [0, 1, 2].map((j) => CORE_TINT[j] + (TAIL_TINT[j] - CORE_TINT[j]) * f);
    const l = Math.max(lum709(c), 1e-4);
    c = c.map((v) => 1 + (v / l - 1) * chroma);
    T.push(c);
  }
  const step = [];
  for (let i = 0; i < n - 1; i++) step.push([0, 1, 2].map((j) => T[i + 1][j] / Math.max(T[i][j], 1e-4)));
  return { base: T[0], step };
}

/* ------------------------------------------------------------------- shaders */

const HEAD = /* glsl */`
in vec2 vUv;
float bLum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** For glare energy: NaN-safe, non-negative — scattered light cannot be negative. */
vec3 bSan(vec3 c){ return clamp(mix(vec3(0.0), c, vec3(equal(c, c))), vec3(0.0), vec3(60000.0)); }
/** For the scene passing through: NaN/Inf-safe only. Wide-gamut transforms legitimately
 *  carry small negatives and the tonemapper owns what to do with them — not this pass. */
vec3 bGuard(vec3 c){ return clamp(mix(vec3(0.0), c, vec3(equal(c, c))), vec3(-60000.0), vec3(60000.0)); }
`;

/* 13-tap "dual filter" kernel, offsets in source texels.
     A   B   C
       J   K
     D   E   F
       L   M
     G   H   I                                              */
const PREFILTER_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2  uT;
uniform float uThresh, uKnee, uClamp;
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

  // Karis: partial averages weighted by 1/(1+luma) kill single-pixel fireflies.
  // Applied to the raw image and *before* the knee, which is the order that makes it
  // an anti-firefly filter rather than a second, hidden threshold.
  float w0 = 0.125 / (1.0 + bLum(g0));
  float w1 = 0.125 / (1.0 + bLum(g1));
  float w2 = 0.125 / (1.0 + bLum(g2));
  float w3 = 0.125 / (1.0 + bLum(g3));
  float w4 = 0.500 / (1.0 + bLum(g4));
  vec3 col = (g0*w0 + g1*w1 + g2*w2 + g3*w3 + g4*w4) / (w0 + w1 + w2 + w3 + w4);

  // Quadratic soft knee around a scene-linear threshold that the CPU derived from the
  // active display transform. One branch, one calibration.
  float thr  = max(uThresh, 1e-5);
  float knee = max(uKnee * thr, 1e-5);
  float br   = max(col.r, max(col.g, col.b));
  float sq   = clamp(br - thr + knee, 0.0, 2.0 * knee);
  sq = sq * sq / (4.0 * knee);
  col *= max(sq, br - thr) / max(br, 1e-5);
  col  = min(col, vec3(uClamp * thr));

  oCol = vec4(col, 1.0);
}
`;

const DOWNSAMPLE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uT;
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
  oCol = vec4(g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125, 1.0);
}
`;

/* 9-tap tent, then mix() via fixed-function blending: out.rgb = tent*k*tint, out.a = k
   with (src=One, dst=OneMinusSrcAlpha) gives dst' = tent*k*tint + dst*(1-k). */
const UPSAMPLE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform vec2  uT;
uniform vec3  uTint;
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
  oCol = vec4(s * uTint * (uK / 16.0), uK);
}
`;

const COMPOSITE_FRAG = HEAD + /* glsl */`
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform vec3  uTint;
uniform float uIntensity;
out vec4 oCol;
void main(){
  vec3 s = bGuard(texture(tSrc, vUv).rgb);
  vec3 b = bSan(texture(tBloom, vUv).rgb);
  oCol = vec4(s + b * uTint * uIntensity, 1.0);
}
`;

export function create(opts = {}) {
  const p = new Pass('bloom');

  let mips = [];
  let quad = null;
  let mPre = null, mDown = null, mUp = null, mComp = null;
  let W = 0, H = 0;

  const cfg = Object.assign({
    intensity: 0.42,
    thresholdSrgb: 0.97,
    thresholdDisplay: null,   // explicit exposed-linear override; null = solve it
    knee: 0.55,
    radius: 2.0,
    falloff: 0.85,
    anamorphic: 1.25,
    chroma: 1.0,
    clamp: 60.0,
  }, opts.bloom || {});

  const tint = new THREE.Vector3(1, 1, 1);
  const stepTint = new THREE.Vector3(1, 1, 1);

  // derived, recomputed only when the inputs change
  let curveKey = '';
  let whitePoint = 1;
  let weightKey = '';
  let kStep = [];
  let ramp = tintRamp(LEVELS, 1.0);
  let contractChecked = false;

  p.init = () => {
    mPre = fsMaterial(PREFILTER_FRAG, {
      tSrc: { value: null },
      uT: { value: new THREE.Vector2() },
      uThresh: { value: 1 }, uKnee: { value: cfg.knee }, uClamp: { value: cfg.clamp },
    });
    mDown = fsMaterial(DOWNSAMPLE_FRAG, { tSrc: { value: null }, uT: { value: new THREE.Vector2() } });
    mUp = fsMaterial(UPSAMPLE_FRAG, {
      tSrc: { value: null }, uT: { value: new THREE.Vector2() },
      uTint: { value: stepTint },
      uRadius: { value: cfg.radius }, uAniso: { value: 1.0 }, uK: { value: 0.5 },
    });
    mComp = fsMaterial(COMPOSITE_FRAG, {
      tSrc: { value: null }, tBloom: { value: null },
      uTint: { value: tint }, uIntensity: { value: cfg.intensity },
    });

    for (const m of [mPre, mDown, mComp]) m.blending = THREE.NoBlending;

    // dst' = src*1 + dst*(1 - src.a) == mix(dst, tent*tint, k)  -> unit-energy pyramid
    mUp.blending = THREE.CustomBlending;
    mUp.blendEquation = THREE.AddEquation;
    mUp.blendSrc = THREE.OneFactor;
    mUp.blendDst = THREE.OneMinusSrcAlphaFactor;
    mUp.blendEquationAlpha = THREE.AddEquation;
    mUp.blendSrcAlpha = THREE.OneFactor;
    mUp.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

    quad = new FullScreenQuad(mComp);
  };

  p.setSize = (w, h) => {
    if (!mPre || (w === W && h === H && mips.length === LEVELS)) return;
    W = w; H = h;
    for (const rt of mips) rt.dispose();
    mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < LEVELS; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      mips.push(makeRT(mw, mh));
    }
  };

  const _draw = (r, mat, target) => {
    quad.material = mat;
    r.setRenderTarget(target);
    quad.render(r);
  };

  /**
   * Scene-linear knee. `tonemap` renders `exposure · MODE_GAIN[mode] · 2^EV · L`, so a
   * knee that means "just under display white" is `displayWhite(target) / that factor`.
   */
  const sceneThreshold = (c) => {
    const mode = (c.tonemapper in MODE_GAIN) ? c.tonemapper : 'agx';
    const white = c.tonemapWhite ?? 6.0;
    const target = THREE.MathUtils.clamp(c.bloomThresholdSrgb ?? cfg.thresholdSrgb, 0.05, 0.9999);
    const key = `${mode}|${white}|${target}`;
    if (key !== curveKey) { curveKey = key; whitePoint = displayWhite(target, mode, white); }
    const explicit = c.bloomThresholdDisplay ?? cfg.thresholdDisplay;
    const exposedThr = (typeof explicit === 'number' && explicit > 0) ? explicit : whitePoint;
    const gain = c.exposure * MODE_GAIN[mode] * Math.pow(2, c.exposureEV || 0);
    return exposedThr / Math.max(gain, 1e-6);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const c = ctx.config || {};

    // Hard contract: the knee is display-referred, so the display transform's exposure
    // has to exist. `tonemap.init` publishes it and every pass init completes before
    // the first render, so this can only fire if tonemap is missing entirely. Fail
    // loudly and once — the alternative is a second, differently calibrated bloom.
    if (!contractChecked) {
      contractChecked = true;
      if (typeof c.exposure !== 'number' || !(c.exposure > 0)) {
        p.enabled = false;
        throw new Error('[bloom] ctx.config.exposure is not a positive number — the '
          + '`tonemap` pass must publish it before any pass renders. bloom disabled.');
      }
    }

    if (!mips.length) p.setSize(pipe.w, pipe.h);

    const intensity = c.bloomIntensity ?? cfg.intensity;
    if (intensity <= 0.0) {
      // Straight through — but via the composite, not pipe.blit(): the pipeline's copy
      // material is NormalBlending and passes the source alpha through, so on a target
      // holding stale contents it blends rather than copies. The composite forces a=1.
      mComp.uniforms.tSrc.value = pipe.read.texture;
      mComp.uniforms.tBloom.value = mips[0].texture;
      mComp.uniforms.uIntensity.value = 0.0;
      _draw(r, mComp, out);
      return;
    }

    // ------------------------------------------------ derived pyramid parameters
    const falloff = c.bloomFalloff ?? cfg.falloff;
    const chroma = THREE.MathUtils.clamp(c.bloomChroma ?? cfg.chroma, 0, 4);
    const wKey = `${falloff}|${chroma}`;
    if (wKey !== weightKey) {
      weightKey = wKey;
      kStep = blendConstants(octaveWeights(LEVELS, falloff));
      ramp = tintRamp(LEVELS, chroma);
    }

    // ---------------------------------------------------------- 1. prefilter
    mPre.uniforms.uThresh.value = sceneThreshold(c);
    mPre.uniforms.uKnee.value = c.bloomKnee ?? cfg.knee;
    mPre.uniforms.uClamp.value = c.bloomClamp ?? cfg.clamp;
    mPre.uniforms.tSrc.value = pipe.read.texture;
    mPre.uniforms.uT.value.set(1 / pipe.w, 1 / pipe.h);
    _draw(r, mPre, mips[0]);

    // ------------------------------------------------------ 2. downsample chain
    for (let i = 1; i < LEVELS; i++) {
      const src = mips[i - 1];
      mDown.uniforms.tSrc.value = src.texture;
      mDown.uniforms.uT.value.set(1 / src.width, 1 / src.height);
      _draw(r, mDown, mips[i]);
    }

    // -------------------------------------------------------- 3. upsample chain
    const radius = c.bloomRadius ?? cfg.radius;
    const aniso = c.bloomAnamorphic ?? cfg.anamorphic;
    mUp.uniforms.uRadius.value = radius;
    for (let i = LEVELS - 2; i >= 0; i--) {
      const src = mips[i + 1];
      mUp.uniforms.tSrc.value = src.texture;
      mUp.uniforms.uT.value.set(1 / src.width, 1 / src.height);
      mUp.uniforms.uK.value = kStep[i];
      // Graded stretch over the widest four steps. Applying it to one step that carries
      // 5% of the energy, as before, made `bloomAnamorphic` a knob that did nothing.
      const f = THREE.MathUtils.clamp((i - (LEVELS - 6)) / 4, 0, 1);
      mUp.uniforms.uAniso.value = 1 + (aniso - 1) * f;
      const t = ramp.step[i];
      stepTint.set(t[0], t[1], t[2]);
      _draw(r, mUp, mips[i]);
    }

    // ------------------------------------------------------------ 4. composite
    const g = c.bloomTint;
    const b = ramp.base;
    if (Array.isArray(g) && g.length === 3) tint.set(g[0] * b[0], g[1] * b[1], g[2] * b[2]);
    else tint.set(b[0], b[1], b[2]);
    mComp.uniforms.tSrc.value = pipe.read.texture;
    mComp.uniforms.tBloom.value = mips[0].texture;
    mComp.uniforms.uIntensity.value = intensity;
    _draw(r, mComp, out);
  };

  p.dispose = () => {
    for (const rt of mips) rt.dispose();
    mips = [];
    for (const m of [mPre, mDown, mUp, mComp]) m?.dispose();
    quad?.dispose();
  };

  return p;
}
