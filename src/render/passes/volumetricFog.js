import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';
import { HASH_GLSL, VALUE_NOISE_GLSL } from '../../gfx/glsl/noise.js';

/**
 * `volumetricFog` — aerial perspective on the sky, height haze, and crepuscular rays.
 *
 * ## Why this is a march and not a radial blur
 *
 * A screen-space radial blur from the sun is the cheap way to get shafts and it is also
 * the reason a lot of WebGL scenes announce themselves: the shaft is a *decal*. It has
 * no thickness, it does not get denser as you look along it, it cannot be occluded by
 * something the sun is behind but the camera is in front of, and it brightens the sky
 * uniformly rather than brightening the air between you and the sky. Under the Forerunner
 * bridge (kf_00000, kf_00120) the reference shows the opposite: a warm body of lit dust
 * with a *volume* — brighter where the slab lets light through, and visibly attenuating
 * the rocks behind it. That is an integral along the view ray, so this pass integrates.
 *
 * ## Structure
 *
 * Two draws.
 *
 * 1. **March**, at `resScale` (default 1/4 in each axis, so 480x270 at 1080p). Each low
 *    resolution pixel walks its own view ray front-to-back in `STEPS` non-uniform steps,
 *    sampling
 *      - a height-exponential density with a slow 2-octave value-noise modulation, so the
 *        haze has body instead of reading as a flat wash;
 *      - the sun's CSM shadow map at that world point, which *is* the shaft: unlit
 *        froxels contribute only ambient, lit ones contribute the forward-scatter lobe.
 *    and outputs `vec4(inscattered radiance, transmittance)`.
 *
 *    This is a froxel volume in everything but storage: 480x270x40 samples against the
 *    ~160x90x64 a 3D-texture froxel pass would use. Skipping the 3D texture skips the
 *    64-slice sequential integration (a fragment shader cannot scan along z in one draw,
 *    and 64 tiny ping-pong draws cost more state changes than this costs ALU) and skips
 *    the froxel grid's own worst artefact — z-slice aliasing on a hard shadow edge.
 *    What it gives up is reuse by transparent surfaces, which nothing asks for yet.
 *
 * 2. **Depth-aware upsample + composite**, at full resolution: `scene * T + L`.
 *
 * ## The choices that matter
 *
 * - **The step distribution is quadratic-biased, not uniform.** `t = tEnd*(0.25u + 0.75u^2)`
 *   puts ~3x the samples in the near third of the ray, which is where the shaft geometry
 *   under the bridge lives and where a uniform distribution bands visibly.
 * - **The dither is static.** The first step is offset by an interleaved-gradient hash of
 *   `gl_FragCoord` with *no* frame term, deliberately. A frame-varying offset is the usual
 *   trick — let TAA average the noise away — but the noise here is generated at quarter
 *   resolution, so it arrives at TAA as correlated 4x4 blocks. TAA's variance box is a
 *   full-resolution 3x3 that sits *inside* one such block, measures near-zero variance,
 *   and clips the history that would have averaged it: the noise never converges and
 *   instead crawls. A fixed offset costs a small stationary banding (invisible at 40 steps
 *   against a smooth density) and is temporally dead, which is what a temporal filter
 *   downstream actually wants.
 * - **Sky and geometry get the same integral.** A distant sea stack at 480 m and the sky
 *   behind it differ by 20 m of march, so the silhouette does not step in haze — which is
 *   the whole point of doing this after the G-buffer instead of per-surface.
 * - **Density is capped in distance, not just in height.** `uMaxDist` with a smooth taper
 *   over the last third: this is a local marine/dust layer, not a planetary atmosphere.
 *   The sky module already owns the planetary term and this must not double it.
 *
 * ## Coordination note — read before retuning density
 *
 * `src/gfx/materialCommon.js` injects an analytic aerial-perspective term into every
 * opaque world material (`uAerialDensity` 0.0062, height falloff 0.021). That term does
 * not exist on the sky, and it cannot be shadowed, which is why this pass exists. But it
 * *does* overlap this pass on opaque geometry: a surface at 400 m gets both. The default
 * `fogDensity` here is therefore set well below what a standalone fog would use. If a
 * later integration pass wants one authority for aerial perspective, the right move is to
 * lower `ctx.config.aerialDensity` and raise `ctx.config.fogDensity`, not to fight it from
 * both ends. Neither file may edit the other.
 *
 * ## ctx.config knobs
 * ```
 * fog            true      master enable
 * fogDensity     0.00075   extinction at the base height, per metre
 * fogHeight      24.0      e-folding height of the layer, metres
 * fogMaxDist     460.0     end of the layer
 * fogShafts      0.25      scale on the sun in-scatter (the crepuscular term)
 * fogAmbient     0.52      scale on the sky/ground in-scatter
 * fogNoise       0.55      0 = smooth wash, 1 = fully modulated
 * fogWarmth      1.0       scale on the warm tint pushed into the low layer
 * ```
 */

/* -------------------------------------------------------------------- march */

const MARCH_FRAG = /* glsl */`
precision highp sampler2DShadow;

in vec2 vUv;

uniform sampler2D tDepth;

uniform mat4  uInvVP;
uniform vec3  uCamPos;
uniform vec3  uSunDir;        // toward the sun
uniform vec3  uSunRadiance;   // linear, already scaled by intensity
uniform vec3  uAmbSky;        // in-scattered skylight, upper hemisphere
uniform vec3  uAmbGround;     // in-scattered ground bounce, lower hemisphere
uniform vec3  uWarmTint;      // warm-neutral push applied to the dense low layer

uniform float uDensity;
uniform float uHeightFalloff;
uniform float uMaxDist;
uniform float uShaft;
uniform float uAmbient;
uniform float uNoiseAmp;
uniform float uNoiseScale;
uniform vec3  uNoiseOfs;
uniform float uG1, uG2, uLobeMix;
uniform float uCloudAtten;

uniform float uNumCasc;
uniform mat4  uCascMat[4];
uniform sampler2DShadow uCasc0;
uniform sampler2DShadow uCasc1;
uniform sampler2DShadow uCasc2;
uniform sampler2DShadow uCasc3;
uniform float uShadowBias;

out vec4 oCol;

${HASH_GLSL}
${VALUE_NOISE_GLSL}

/** Henyey-Greenstein, normalised over the sphere (the 1/4pi is in the constant). */
float hg(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

/** Interleaved gradient noise. No frame term — see the header. */
float ign(vec2 p){
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float densityAt(vec3 p){
  float h = max(p.y, 0.0);
  float d = exp(-h * uHeightFalloff);
  if (uNoiseAmp > 0.001) {
    vec3 q = p * uNoiseScale + uNoiseOfs;
    float f = vnoise3(q) * 0.66 + vnoise3(q * 2.71 + 11.3) * 0.34;
    // mean of f is ~0.5, so this stays energy neutral as uNoiseAmp rises
    d *= mix(1.0, 0.30 + 1.40 * f, uNoiseAmp);
  }
  return uDensity * d;
}

/**
 * Sun visibility from the CSM cascades. Cascades are ordered near-to-far, so the first
 * one whose ortho box contains the point is the tightest one that does. Outside every
 * cascade (past CSM maxFar) the froxel is treated as lit: at that range the shaft has no
 * contrast left anyway, and guessing "shadowed" would put a hard dark wall at the last
 * cascade boundary.
 */
float sunVis(vec3 p){
  vec4 c; vec3 s;
  if (uNumCasc > 0.5) {
    c = uCascMat[0] * vec4(p, 1.0); s = c.xyz / c.w;
    if (all(greaterThan(s, vec3(0.002))) && all(lessThan(s, vec3(0.998))))
      return texture(uCasc0, vec3(s.xy, s.z - uShadowBias));
  }
  if (uNumCasc > 1.5) {
    c = uCascMat[1] * vec4(p, 1.0); s = c.xyz / c.w;
    if (all(greaterThan(s, vec3(0.002))) && all(lessThan(s, vec3(0.998))))
      return texture(uCasc1, vec3(s.xy, s.z - uShadowBias));
  }
  if (uNumCasc > 2.5) {
    c = uCascMat[2] * vec4(p, 1.0); s = c.xyz / c.w;
    if (all(greaterThan(s, vec3(0.002))) && all(lessThan(s, vec3(0.998))))
      return texture(uCasc2, vec3(s.xy, s.z - uShadowBias));
  }
  if (uNumCasc > 3.5) {
    c = uCascMat[3] * vec4(p, 1.0); s = c.xyz / c.w;
    if (all(greaterThan(s, vec3(0.002))) && all(lessThan(s, vec3(0.998))))
      return texture(uCasc3, vec3(s.xy, s.z - uShadowBias));
  }
  return 1.0;
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;

  vec4 fp4 = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 fp  = fp4.xyz / fp4.w;
  vec3 dir = normalize(fp - uCamPos);

  // The depth texture is NearestFilter, so this picks one representative full-resolution
  // texel per low-resolution pixel. The upsample reproduces the same mapping to build its
  // bilateral weights, which is what keeps the two passes agreeing on where the
  // silhouettes are.
  float dz = texture(tDepth, vUv).r;

  float tEnd = uMaxDist;
  if (dz < 0.999999) {
    vec4 wp4 = uInvVP * vec4(ndc, dz * 2.0 - 1.0, 1.0);
    tEnd = min(length(wp4.xyz / wp4.w - uCamPos), uMaxDist);
  }

  float cosT = dot(dir, uSunDir);
  float phase = mix(hg(cosT, uG2), hg(cosT, uG1), uLobeMix);

  vec3 ambDir = mix(uAmbGround, uAmbSky, clamp(dir.y * 0.5 + 0.5, 0.0, 1.0)) * uAmbient;
  vec3 sunTerm = uSunRadiance * phase * uShaft * uCloudAtten;

  float jitter = ign(gl_FragCoord.xy);

  float T = 1.0;
  vec3  L = vec3(0.0);
  float tPrev = 0.0;

  for (int i = 0; i < STEPS; i++) {
    float u = (float(i) + jitter) / float(STEPS);
    float t = tEnd * (0.25 * u + 0.75 * u * u);
    float dt = t - tPrev;
    tPrev = t;
    if (dt <= 0.0) continue;

    vec3 p = uCamPos + dir * t;

    float sig = densityAt(p);
    // Finite layer: taper the last third rather than ending it on a step.
    sig *= 1.0 - smoothstep(uMaxDist * 0.62, uMaxDist, t);
    if (sig < 1e-7) continue;

    float a = 1.0 - exp(-sig * dt);

    // The warm push is strongest in the dense part of the layer, which is where the
    // reference's under-bridge dust sits. High, thin haze stays the sky's own colour.
    vec3 warm = mix(vec3(1.0), uWarmTint, clamp(sig / max(uDensity, 1e-6), 0.0, 1.0));
    vec3 inscatter = (ambDir + sunTerm * sunVis(p)) * warm;

    L += T * a * inscatter;
    T *= 1.0 - a;
    if (T < 0.008) break;
  }

  oCol = vec4(L, T);
}
`;

/* ------------------------------------------------------ upsample + composite */

const COMPOSITE_FRAG = /* glsl */`
in vec2 vUv;

uniform sampler2D tSrc;
uniform sampler2D tFog;
uniform sampler2D tDepth;

uniform vec2  uLowRes;
uniform vec2  uInvLowRes;
uniform float uNear, uFar;

out vec4 oCol;

float linZ(float d){
  float n = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - n * (uFar - uNear), 1e-6);
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;

  float zc = linZ(texture(tDepth, vUv).r);

  // Bilateral 4-tap. The reference depth for each low-resolution tap is fetched from the
  // *full* resolution depth texture at the tap's own centre — the same texel the march
  // used — so a tap that ran on sky is recognised as sky and never bleeds onto a
  // silhouette in front of it. A plain bilinear upsample halos every sea stack.
  vec2 c = vUv * uLowRes - 0.5;
  vec2 base = floor(c);
  vec2 f = c - base;

  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  vec4 bestTap = vec4(0.0);
  float bestErr = 1e30;

  float tol = 0.05 * zc + 0.35;

  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i & 1), float(i >> 1));
    vec2 uvL = clamp((base + o + 0.5) * uInvLowRes, uInvLowRes * 0.5, 1.0 - uInvLowRes * 0.5);
    float bw = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
    float zi = linZ(texture(tDepth, uvL).r);
    vec4 s = texture(tFog, uvL);

    float err = abs(zi - zc);
    if (err < bestErr) { bestErr = err; bestTap = s; }

    float w = bw * exp(-err / tol);
    acc += s * w;
    wsum += w;
  }

  // Every tap disagrees with this pixel (a one-pixel-wide silhouette, a thin mast):
  // take the closest one rather than a meaningless average.
  vec4 fog = (wsum > 1e-4) ? acc / wsum : bestTap;

  oCol = vec4(src * clamp(fog.a, 0.0, 1.0) + max(fog.rgb, vec3(0.0)), 1.0);
}
`;

export function create(opts = {}) {
  const p = new Pass('volumetricFog');

  const cfg = Object.assign({
    resScale: 0.25,
    steps: 40,
    density: 0.00075,
    height: 24.0,
    maxDist: 460.0,
    shafts: 0.25,
    ambient: 0.52,
    noise: 0.55,
    noiseScale: 1 / 46.0,
    warmth: 1.0,
    // Two-term Henyey-Greenstein: a hard forward peak plus a small backscatter lobe.
    // The first cut used `mix(isotropic, HG(0.76), 0.55)`, i.e. a 45%-weight isotropic
    // term, and it measured badly for a reason worth recording: an isotropic lobe is
    // 1/4pi of the *whole* solar irradiance in every direction at once, so it lands as a
    // flat achromatic wash over the entire frame instead of as a glow around the sun.
    // On the ref_00120 A/B that single term took the upper sky from sat 95.5 to 84.2
    // while the ambient term (which is the sky's own colour, so it cannot desaturate)
    // moved it by 0.9. Real aerosol phase functions are forward-peaked by two orders of
    // magnitude; this one is ~50:1 forward:side, which puts the energy where a shaft is.
    g1: 0.78,
    g2: -0.35,
    lobeMix: 0.80,
    shadowBias: 0.0016,
  }, opts.volumetricFog || {});

  let marchMat = null, marchQuad = null;
  let compMat = null, compQuad = null;
  let fogRT = null;
  let W = 0, H = 0, LW = 0, LH = 0;
  let animT = 0;

  const invVP = new THREE.Matrix4();
  const identity = new THREE.Matrix4();
  const cascMats = [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
  const _sky = new THREE.Color();
  const _gnd = new THREE.Color();
  const _sun = new THREE.Color();

  p.init = (ctx, pipe) => {
    marchMat = fsMaterial(MARCH_FRAG, {
      tDepth: { value: null },
      uInvVP: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRadiance: { value: new THREE.Vector3(1, 1, 1) },
      uAmbSky: { value: new THREE.Vector3(0.4, 0.5, 0.7) },
      uAmbGround: { value: new THREE.Vector3(0.4, 0.38, 0.33) },
      uWarmTint: { value: new THREE.Vector3(1, 1, 1) },
      uDensity: { value: cfg.density },
      uHeightFalloff: { value: 1 / cfg.height },
      uMaxDist: { value: cfg.maxDist },
      uShaft: { value: cfg.shafts },
      uAmbient: { value: cfg.ambient },
      uNoiseAmp: { value: cfg.noise },
      uNoiseScale: { value: cfg.noiseScale },
      uNoiseOfs: { value: new THREE.Vector3() },
      uG1: { value: cfg.g1 },
      uG2: { value: cfg.g2 },
      uLobeMix: { value: cfg.lobeMix },
      uCloudAtten: { value: 1 },
      uNumCasc: { value: 0 },
      uCascMat: { value: cascMats },
      uCasc0: { value: null },
      uCasc1: { value: null },
      uCasc2: { value: null },
      uCasc3: { value: null },
      uShadowBias: { value: cfg.shadowBias },
    }, { STEPS: Math.max(8, cfg.steps | 0) });
    marchMat.blending = THREE.NoBlending;
    marchQuad = new FullScreenQuad(marchMat);

    compMat = fsMaterial(COMPOSITE_FRAG, {
      tSrc: { value: null },
      tFog: { value: null },
      tDepth: { value: null },
      uLowRes: { value: new THREE.Vector2(1, 1) },
      uInvLowRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.06 },
      uFar: { value: 12000 },
    });
    compMat.blending = THREE.NoBlending;
    compQuad = new FullScreenQuad(compMat);

    p.setSize(pipe.w > 2 ? pipe.w : ctx.size.w, pipe.h > 2 ? pipe.h : ctx.size.h, ctx);
  };

  p.setSize = (w, h) => {
    if (!marchMat || (w === W && h === H && fogRT)) return;
    W = w; H = h;
    LW = Math.max(2, Math.round(w * cfg.resScale));
    LH = Math.max(2, Math.round(h * cfg.resScale));
    fogRT?.dispose();
    fogRT = makeRT(LW, LH);
    compMat.uniforms.uLowRes.value.set(LW, LH);
    compMat.uniforms.uInvLowRes.value.set(1 / LW, 1 / LH);
  };

  /** Pull the sun / sky / ground in-scatter colours from whoever is present. */
  const updateLighting = (ctx, u) => {
    const time = ctx.get('time');
    const sky = ctx.get('sky');

    if (time) {
      u.uSunDir.value.copy(time.sunDir).normalize();
      _sun.copy(time.sunColor).multiplyScalar(time.state?.sunIntensity ?? 6.2);
    } else {
      u.uSunDir.value.set(0.5, 0.7, 0.5).normalize();
      _sun.setRGB(6.2, 5.9, 5.5);
    }
    // `sunIntensity` is a three.js DirectionalLight intensity, and the sky module's
    // radiance is in its own atmosphere units with `solarIrradiance 9.4`. The two are not
    // on a common scale, so the physically-correct `phase * irradiance` comes out roughly
    // an order of magnitude hot against the sky this engine actually draws. `fogShafts`
    // absorbs that; it is a calibration constant, not a look knob, and it should be
    // revisited if anyone ever reconciles the two unit systems.
    u.uSunRadiance.value.set(_sun.r, _sun.g, _sun.b);

    // The ambient in-scatter of an optically thin layer under an open sky is close to the
    // sky's own radiance, so ask the sky module rather than inventing a colour that will
    // drift away from it the moment the atmosphere is retuned.
    let ok = false;
    if (sky?.zenithRadiance && sky?.horizonRadiance) {
      try {
        sky.zenithRadiance(_sky);
        sky.horizonRadiance(_gnd);
        ok = Number.isFinite(_sky.r) && Number.isFinite(_gnd.r) && (_sky.r + _sky.g + _sky.b) > 1e-5;
      } catch { ok = false; }
    }
    if (!ok) {
      const s = time ? time.skyColor : { r: 0.36, g: 0.56, b: 0.94 };
      _sky.setRGB(s.r * 2.0, s.g * 2.0, s.b * 2.0);
      _gnd.setRGB(s.r * 1.6, s.g * 1.6, s.b * 1.6);
    }
    // Upper hemisphere: mostly zenith. `horizonRadiance()` is sampled toward the sun's
    // azimuth, so it is the bright, nearly achromatic circumsolar band — weighting it
    // heavily here is what turns haze milky, and milk is the failure mode this pass is
    // most likely to be accused of. Lower hemisphere: that band plus a warm sand bounce,
    // which is what stops the low haze reading as blue-grey (TARGETS: the horizon region
    // is lab_b -9.3, i.e. only mildly blue, against the sky's -15).
    const kz = 0.72, kh = 0.28;
    u.uAmbSky.value.set(_sky.r * kz + _gnd.r * kh, _sky.g * kz + _gnd.g * kh, _sky.b * kz + _gnd.b * kh);
    const warmBounce = 0.20;
    u.uAmbGround.value.set(
      _gnd.r * (1.0 + warmBounce * 1.35),
      _gnd.g * (1.0 + warmBounce * 0.95),
      _gnd.b * (1.0 + warmBounce * 0.35));
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const c = ctx.config || {};

    if (!fogRT) p.setSize(pipe.w, pipe.h, ctx);

    // Master kill switch — still has to write `out`, the chain swaps regardless.
    if (c.fog === false) { pipe.blit(pipe.read.texture, out); return; }

    const u = marchMat.uniforms;

    // cam.projectionMatrixInverse is the jittered one at post time, which is exactly what
    // unprojects the depth buffer as it was rasterised (same convention as taa.js).
    invVP.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    u.uInvVP.value.copy(invVP);
    u.uCamPos.value.copy(cam.position);
    u.tDepth.value = pipe.depthTex;

    updateLighting(ctx, u);

    u.uDensity.value = c.fogDensity ?? cfg.density;
    u.uHeightFalloff.value = 1 / Math.max(c.fogHeight ?? cfg.height, 0.5);
    u.uMaxDist.value = Math.max(c.fogMaxDist ?? cfg.maxDist, 10);
    u.uShaft.value = c.fogShafts ?? cfg.shafts;
    u.uAmbient.value = c.fogAmbient ?? cfg.ambient;
    u.uNoiseAmp.value = THREE.MathUtils.clamp(c.fogNoise ?? cfg.noise, 0, 1);

    const warmth = c.fogWarmth ?? cfg.warmth;
    u.uWarmTint.value.set(
      1.0 + 0.10 * warmth,
      1.0 + 0.015 * warmth,
      1.0 - 0.11 * warmth);

    // Deterministic drift: accumulate the engine's own dt, and hold still when the
    // capture harness freezes the world. The haze is advected by `time.wind` at a small
    // fraction of the wind speed — dust in a boundary layer lags the free stream, and a
    // haze bank that slides at 5 m/s reads as a moving texture rather than as air.
    if (!c.frozen) animT += ctx.clock?.dt ?? 0;
    const wind = ctx.get('time')?.wind;
    const ns = u.uNoiseScale.value;   // noise-space units per world metre
    const drift = 0.08;               // fraction of the wind the haze actually follows
    u.uNoiseOfs.value.set(
      -(wind ? wind.x : -1.5) * animT * drift * ns,
      -animT * 0.05 * ns,
      -(wind ? wind.z : 0.9) * animT * drift * ns);

    // --- sun shadow cascades ------------------------------------------------
    const csm = ctx.get('lighting')?.csm;
    let n = 0;
    if (csm && Array.isArray(csm.lights)) {
      for (let i = 0; i < csm.lights.length && i < 4; i++) {
        const l = csm.lights[i];
        const map = l?.shadow?.map;
        const tex = map?.depthTexture || null;
        if (!tex) break;
        cascMats[i].copy(l.shadow.matrix);
        u[`uCasc${i}`].value = tex;
        n++;
      }
    }
    for (let i = n; i < 4; i++) { cascMats[i].copy(identity); u[`uCasc${i}`].value = null; }
    u.uNumCasc.value = n;

    // Clouds cannot be shadow-mapped into the froxels (their shadow map has no published
    // projection in docs/API.md), so the sun term is attenuated by coverage instead. The
    // radiance side is already cloud-aware: cloudComposite runs before this pass, so the
    // scene colour this fog attenuates and adds to has clouds in it.
    const clouds = ctx.get('clouds');
    const cov = typeof clouds?.coverage === 'number' ? THREE.MathUtils.clamp(clouds.coverage, 0, 1) : 0;
    u.uCloudAtten.value = 1.0 - 0.45 * cov;

    // --- march --------------------------------------------------------------
    r.setRenderTarget(fogRT);
    marchQuad.render(r);

    // --- upsample + composite ----------------------------------------------
    const cu = compMat.uniforms;
    cu.tSrc.value = pipe.read.texture;
    cu.tFog.value = fogRT.texture;
    cu.tDepth.value = pipe.depthTex;
    cu.uNear.value = cam.near;
    cu.uFar.value = cam.far;
    r.setRenderTarget(out);
    compQuad.render(r);
  };

  p.dispose = () => {
    fogRT?.dispose();
    marchQuad?.dispose();
    compQuad?.dispose();
  };

  return p;
}
