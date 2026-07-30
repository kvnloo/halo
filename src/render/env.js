import * as THREE from 'three';

/**
 * `env` — the image-based-lighting probe.
 *
 * Everything opaque in the scene is a MeshStandardMaterial routed through
 * `applyWorldMaterial`, so the single cheapest way to give every one of them a real
 * ambient is `scene.environment`: three then evaluates a PMREM cube for both the
 * diffuse (mip L1) and the roughness-selected specular term, for free, in the shader
 * it was already going to run.
 *
 * What goes into the probe
 * ------------------------
 * A private scene holding one inverted sphere. Its shader samples `sky.cubeTexture`
 * (the HDR cube the sky module already renders from its own private dome scene, so a
 * screen-space cloud pass can never be dragged in) and composites three corrections
 * on top:
 *
 *  1. **The solar disc is removed.** `sky` draws the sun at 320 units of radiance with
 *     a 48-unit corona on top. The sun is *already* in the scene as a CSM
 *     DirectionalLight; leaving it in the probe would double-count its energy, deliver
 *     it unshadowed, and — because a 0.54 deg disc lands on well under one texel of a
 *     128 px face — alias into a blocky, jittering specular blob. Inside `uSunKill`
 *     (8 deg) the sky is resampled along the same great circle at exactly `uSunKill`
 *     from the sun and cross-faded, which removes the disc and its corona while
 *     leaving the aureole's shape continuous.
 *
 *  2. **Ground bounce.** The lower hemisphere of the sky dome is the atmosphere's own
 *     ground term — a dim, desaturated wash. The reference is not that: docs/WORLD.md
 *     records "sand throws a noticeable warm bounce up onto rock undersides and onto
 *     the weapon; without it the viewmodel reads pasted-on". So below the horizon the
 *     probe carries a Lambertian sand term
 *
 *         L_sand = albedo / pi * (E_sun + E_sky) * occlusion
 *
 *     where E_sun and E_sky are recomputed at every refresh from `time` and from
 *     `sky.radiance()` integrated over the upper hemisphere. It is weighted in by a
 *     cosine lobe `(-d.y)^uGroundLobe`: straight down sees nothing but sand, while
 *     grazing-downward directions see mostly the haze-washed distance and are blended
 *     back toward the sky at the waterline. That lobe is the difference between "the
 *     ground is a brown card" and "the ground is a beach receding into aerial
 *     perspective".
 *
 *  3. A soft knee on radiance, and a NaN/Inf clamp. `sky`'s ring and gas-giant shaders
 *     are documented NaN sources; one NaN texel in a cubemap poisons every PMREM mip
 *     above it and therefore the ambient on every surface in the frame.
 *
 * SH9
 * ---
 * The same shader is rendered a second time into a 64x32 equirectangular HDR target,
 * read back, and projected onto the first nine real spherical harmonics using three's
 * own basis ordering — so `env.irradiance` can be dropped straight into
 * `THREE.SphericalHarmonics3` / `shGetIrradianceAt()` by any custom shader that wants
 * a cheap ambient without a cube fetch. Equirect rather than the cube because the
 * cube-face texel -> direction mapping depends on three's CubeCamera conventions and
 * on readPixels' bottom-up row order, whereas the equirect mapping is written in this
 * file's own vertex shader and cannot be got wrong.
 *
 * `env.groundIrradiance` publishes E(+Y) from that SH. `tonemap.keyedExposure()`
 * consumes it: an ambient this size changes the photographic key, and a probe that
 * lights the scene without telling the exposure about it just over-exposes the frame.
 *
 * Refresh policy
 * --------------
 * Once at init, once at frame 2 (after the harness has set the pose, so the deferred
 * capture sees the settled sky), and thereafter only when the sun has moved more than
 * `sunMoveDeg` or `sky.needsEnvUpdate` goes true — with a hard floor of
 * `minRefreshFrames` between recaptures so an animated sun cannot pay it every frame.
 * Everything is keyed on `clock.frame` and on the sun, never on wall-clock time, so
 * captures stay byte-identical. It must never run per frame: a refresh is six cube
 * faces, a PMREM chain and a blocking pixel readback.
 *
 * Cost: 12 ms per refresh (measured, of which the readback stall is most), twice in a
 * capture and effectively never during play; ~0 ms/frame steady state. The IBL term it
 * switches on in every world material costs ~0.25 ms at 1080p.
 *
 * API (docs/API.md):
 *   env.probe            THREE.Texture   PMREM cube-UV, === ctx.scene.environment
 *   env.irradiance       THREE.Color[9]  SH9 radiance coefficients (three's basis order)
 *   env.refresh(ctx)     void            re-capture; expensive
 * plus:
 *   env.cubeTexture      THREE.CubeTexture  the raw 128/face HDR probe
 *   env.sh               THREE.SphericalHarmonics3
 *   env.shArray          Float32Array(27)   flat rgb triples, ready for uniform upload
 *   env.irradianceAt(n, out?) -> THREE.Color   E(n) in three's light units
 *   env.groundIrradiance number             E(+Y) luminance, read by tonemap
 */

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------- shaders */

const VERT_CUBE = /* glsl */`
out vec3 vDir;
void main(){
  // The probe sphere is centred on the probe camera and never rotated, so object
  // space *is* the sample direction. Uniform scale cancels in the normalise.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const VERT_EQUIRECT = /* glsl */`
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
precision highp samplerCube;

layout(location = 0) out vec4 oCol;

uniform samplerCube tSky;
uniform float uHasSky;
uniform float uSkyScale;

uniform vec3  uSunDir;
uniform float uSunKill;        // radians; disc + corona are removed inside this cone

uniform vec3  uZenithCol;      // analytic fallback when the sky module is absent
uniform vec3  uHorizonCol;

uniform vec3  uGroundRad;      // sand bounce radiance, linear HDR
uniform float uGroundMix;
uniform float uGroundLobe;
uniform float uHorizonFeather;

uniform float uCloudCover;
uniform vec3  uCloudTint;

uniform float uKnee;           // radiance above this is compressed
uniform float uCeil;           // ...asymptotically toward this

#ifdef ENV_EQUIRECT
in vec2 vUv;
vec3 envDir(){
  float phi = (vUv.x - 0.5) * ${TAU.toFixed(10)};
  float el  = (vUv.y - 0.5) * ${Math.PI.toFixed(10)};
  float ce  = cos(el);
  return vec3(ce * sin(phi), sin(el), ce * cos(phi));
}
#else
in vec3 vDir;
vec3 envDir(){ return normalize(vDir); }
#endif

vec3 analyticSky(vec3 d){
  vec3 c = mix(uHorizonCol, uZenithCol, pow(clamp(d.y, 0.0, 1.0), 0.55));
  return mix(uHorizonCol * 0.72, c, smoothstep(-0.10, 0.05, d.y));
}

vec3 rawSky(vec3 d){
  vec3 c = (uHasSky > 0.5) ? texture(tSky, d).rgb : analyticSky(d);
  // Any comparison against NaN is false, so this catches NaN and +Inf both. One bad
  // texel here would spread across every PMREM mip and darken the whole scene.
  c = mix(vec3(0.0), c, vec3(lessThan(c, vec3(1.0e6))));
  return max(c, vec3(0.0));
}

/** Sky with the solar disc and corona resampled away — see the header. */
vec3 skyNoSun(vec3 d){
  float cs  = clamp(dot(d, uSunDir), -1.0, 1.0);
  float ang = acos(cs);
  if (ang >= uSunKill) return rawSky(d);
  vec3 t = d - uSunDir * cs;
  float lt = length(t);
  t = (lt > 1e-4) ? t / lt
                  : normalize(cross(uSunDir, normalize(vec3(0.017, 1.0, 0.0))));
  vec3 alt = normalize(uSunDir * cos(uSunKill) + t * sin(uSunKill));
  return mix(rawSky(alt), rawSky(d), smoothstep(0.0, 1.0, ang / uSunKill));
}

/** Identity below uKnee, asymptotic to uCeil above it. */
vec3 softKnee(vec3 c){
  vec3 e = max(c - vec3(uKnee), vec3(0.0)) / max(uCeil - uKnee, 1e-3);
  vec3 hi = vec3(uKnee) + (uCeil - uKnee) * (vec3(1.0) - exp(-e));
  return mix(c, hi, vec3(greaterThan(c, vec3(uKnee))));
}

void main(){
  vec3 d = envDir();
  vec3 col = skyNoSun(d) * uSkyScale;

  if (uCloudCover > 0.001){
    // No cloud volume is available to the probe, so coverage only neutralises the
    // upper hemisphere toward a grey-blue overcast. Deliberately mild.
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, mix(col, vec3(lum) * uCloudTint, 0.55),
              clamp(uCloudCover, 0.0, 1.0) * 0.55 * smoothstep(-0.05, 0.30, d.y));
  }

  // ---- ground bounce ----------------------------------------------------------
  // Cosine lobe: straight down is pure sand, grazing-down is the haze at the
  // waterline. hz samples the sky at +2.6 deg in the same azimuth, which is exactly
  // the band the beach dissolves into.
  float below = smoothstep(0.0, -uHorizonFeather, d.y);
  if (below > 0.0){
    float lobe = pow(clamp(-d.y, 0.0, 1.0), uGroundLobe);
    vec3 hz = rawSky(normalize(vec3(d.x, 0.045, d.z))) * uSkyScale;
    col = mix(col, mix(hz, uGroundRad, lobe), below * uGroundMix);
  }

  oCol = vec4(softKnee(max(col, vec3(0.0))), 1.0);
}
`;

/* ------------------------------------------------------- spherical harmonics */

/** three's SphericalHarmonics3 basis order and normalisation. */
function shBasis(x, y, z, out) {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3.0 * z * z - 1.0);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
  return out;
}

/** IEEE 754 binary16 -> Number. readRenderTargetPixels hands back raw half bits. */
function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return s * 5.9604644775390625e-8 * f;          // subnormal: 2^-24 * f
  if (e === 0x1f) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/* ------------------------------------------------------------------- module */

export function create(opts = {}) {
  const S = Object.assign({
    cubeSize: 128,
    shWidth: 64,
    shHeight: 32,
    /** Play-area centre. Everything the probe samples is directional, so this only
     *  matters for the day a local object is added to the probe scene. */
    center: [0, 3.0, 4.0],
    /** Linear albedo of the beach seen from the play-area centre — a mix of dry sand,
     *  damp sand and wet cobble, warm. sRGB ~ (163, 145, 118). */
    sandAlbedo: [0.355, 0.288, 0.196],
    /** The ground is not an infinite open plane: rocks, water and the berm eat some
     *  of the light that would otherwise reach it. */
    groundOcclusion: 0.86,
    groundMix: 1.0,
    groundLobe: 0.62,
    horizonFeather: 0.065,
    sunKillDeg: 8.0,
    /** Re-capture once the sun has moved this far. Below ~0.5 deg the probe is
     *  visually identical and a refresh is pure cost. */
    sunMoveDeg: 0.6,
    /** Hard floor on the interval between refreshes, in frames. A refresh is ~12 ms;
     *  an animated sun must never be able to pay that every frame. */
    minRefreshFrames: 24,
    skyScale: 1.0,
    intensity: 1.0,
    knee: 26.0,
    ceil: 90.0,
    cloudTint: [0.92, 0.95, 1.02],
    /** Deferred second capture, in engine frames. The harness sets the pose after
     *  init, so the init-time probe is taken before the world has settled. */
    settleFrame: 2,
  }, opts.env || {});

  let renderer = null;
  let probeScene = null, probeMesh = null, probeMat = null, probeGeom = null;
  let cubeRT = null, cubeCam = null;
  let shScene = null, shCam = null, shMat = null, shRT = null, shBuf = null;
  let pmrem = null, pmremRT = null;
  let quadGeom = null;

  let dirty = true;
  let force = true;
  const refSun = new THREE.Vector3(0, 1, 0);
  let refFrame = -1e9;
  let settled = false;
  let ownsEnvironment = false;
  let failed = false;
  let refreshes = 0;
  let lastRefreshMs = 0;

  const uniforms = {
    tSky: { value: null },
    uHasSky: { value: 0 },
    uSkyScale: { value: S.skyScale },
    uSunDir: { value: new THREE.Vector3(0.666, 0.656, -0.354) },
    uSunKill: { value: THREE.MathUtils.degToRad(S.sunKillDeg) },
    uZenithCol: { value: new THREE.Color(0.34, 0.52, 0.90) },
    uHorizonCol: { value: new THREE.Color(0.78, 0.80, 0.86) },
    uGroundRad: { value: new THREE.Color(0.12, 0.10, 0.07) },
    uGroundMix: { value: S.groundMix },
    uGroundLobe: { value: S.groundLobe },
    uHorizonFeather: { value: S.horizonFeather },
    uCloudCover: { value: 0 },
    uCloudTint: { value: new THREE.Color(...S.cloudTint) },
    uKnee: { value: S.knee },
    uCeil: { value: S.ceil },
  };

  // SH9 radiance coefficients, three's basis order.
  const sh = new THREE.SphericalHarmonics3();
  const irradiance = [];
  for (let i = 0; i < 9; i++) irradiance.push(new THREE.Color(0, 0, 0));
  const shArray = new Float32Array(27);
  const _basis = new Float32Array(9);
  const _c = new THREE.Color();
  const _v = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _eUp = new THREE.Color();

  /* ---------------------------------------------------------------- helpers */

  /** Cosine-weighted irradiance arriving on an up-facing surface, from `sky`. */
  function skyIrradianceDown(ctx, out) {
    out.setRGB(0, 0, 0);
    const sky = ctx.get('sky');
    const time = ctx.get('time');
    if (sky && typeof sky.radiance === 'function') {
      // 96-direction cosine-weighted Fibonacci hemisphere. Deterministic, ~0.1 ms.
      const N = 96;
      const tmp = new THREE.Color();
      let wsum = 0;
      for (let i = 0; i < N; i++) {
        const fi = (i + 0.5) / N;
        const cz = Math.sqrt(1 - fi);          // cosine-distributed elevation
        const sz = Math.sqrt(fi);
        const ph = i * 2.399963229728653;
        _v.set(sz * Math.cos(ph), cz, sz * Math.sin(ph));
        let ok = false;
        try { sky.radiance(_v, tmp); ok = Number.isFinite(tmp.r); } catch { ok = false; }
        if (!ok) { out.setRGB(0, 0, 0); wsum = 0; break; }
        out.r += tmp.r; out.g += tmp.g; out.b += tmp.b;
        wsum += 1;
      }
      if (wsum > 0) {
        // Mean radiance over a cosine-weighted hemisphere * pi = irradiance.
        out.multiplyScalar(Math.PI / wsum);
        return out;
      }
    }
    // Fallback mirrors lighting.js's documented hemisphere rig.
    const alt = Math.max(time?.sunDir?.y ?? 0.656, 0.02);
    const skyC = time?.skyColor || new THREE.Color(0.30, 0.45, 0.78);
    out.copy(skyC).multiplyScalar(1.35 * Math.pow(alt, 0.35));
    return out;
  }

  /** Recompute the sand bounce radiance from the current rig. */
  function updateGroundRadiance(ctx) {
    const time = ctx.get('time');
    const sunDir = time?.sunDir || _v.set(0.666, 0.656, -0.354);
    const sunUp = Math.max(sunDir.y, 0);
    const sunI = time?.state?.sunIntensity ?? 6.2;
    const sunC = time?.sunColor || new THREE.Color(1.0, 0.94, 0.82);

    // E arriving on the sand: direct sun (cosine) + sky.
    const E = _c.copy(sunC).multiplyScalar(sunI * sunUp);
    const eSky = new THREE.Color();
    skyIrradianceDown(ctx, eSky);
    E.add(eSky);

    // Clouds shade the sand as well as the sky.
    const cov = ctx.get('clouds')?.coverage;
    if (Number.isFinite(cov) && cov > 0) E.multiplyScalar(1.0 - 0.35 * Math.min(cov, 1));

    const a = ctx.config.envSandAlbedo || S.sandAlbedo;
    uniforms.uGroundRad.value.setRGB(
      E.r * a[0], E.g * a[1], E.b * a[2],
    ).multiplyScalar(S.groundOcclusion / Math.PI);
  }

  function syncUniforms(ctx) {
    const sky = ctx.get('sky');
    const time = ctx.get('time');

    const cube = sky?.cubeTexture || sky?.getRenderTarget?.()?.texture || null;
    uniforms.tSky.value = cube;
    uniforms.uHasSky.value = cube ? 1 : 0;

    if (time?.sunDir) uniforms.uSunDir.value.copy(time.sunDir).normalize();
    const sunAng = time?.state?.sunAngularRadius || 0.0047;
    uniforms.uSunKill.value = Math.max(THREE.MathUtils.degToRad(S.sunKillDeg), sunAng * 14);

    // Analytic fallback colours, only used when `sky` is absent.
    try {
      if (sky?.zenithRadiance) uniforms.uZenithCol.value.copy(sky.zenithRadiance(_c));
      else if (time?.skyColor) uniforms.uZenithCol.value.copy(time.skyColor).multiplyScalar(1.15);
      if (sky?.horizonRadiance) uniforms.uHorizonCol.value.copy(sky.horizonRadiance(_c));
      else if (time?.skyColor) uniforms.uHorizonCol.value.copy(time.skyColor).multiplyScalar(0.95);
    } catch { /* a half-built sky is allowed to throw here */ }
    if (!Number.isFinite(uniforms.uZenithCol.value.r)) uniforms.uZenithCol.value.setRGB(0.34, 0.52, 0.90);
    if (!Number.isFinite(uniforms.uHorizonCol.value.r)) uniforms.uHorizonCol.value.setRGB(0.78, 0.80, 0.86);

    const cov = ctx.get('clouds')?.coverage;
    uniforms.uCloudCover.value = Number.isFinite(cov) ? Math.max(0, Math.min(1, cov)) : 0;

    uniforms.uSkyScale.value = ctx.config.envSkyScale ?? S.skyScale;
    uniforms.uGroundMix.value = ctx.config.envGroundMix ?? S.groundMix;
    uniforms.uGroundLobe.value = ctx.config.envGroundLobe ?? S.groundLobe;

    updateGroundRadiance(ctx);
  }

  /** Project the equirect probe onto SH9. Returns false if the readback is unusable. */
  function projectSH() {
    const W = S.shWidth, H = S.shHeight;
    if (!shBuf) shBuf = new Uint16Array(W * H * 4);
    try {
      renderer.readRenderTargetPixels(shRT, 0, 0, W, H, shBuf);
    } catch (e) {
      console.warn('[env] SH readback failed:', e?.message || e);
      return false;
    }

    const acc = new Float64Array(27);
    let any = false;
    const dPhi = TAU / W, dEl = Math.PI / H;
    for (let j = 0; j < H; j++) {
      // readPixels row 0 is the bottom of the framebuffer, which is uv.y = 0 — the
      // same v the equirect vertex shader mapped to elevation -pi/2. No flip needed.
      const el = ((j + 0.5) / H - 0.5) * Math.PI;
      const ce = Math.cos(el), y = Math.sin(el);
      const dOmega = dPhi * dEl * ce;
      if (dOmega <= 0) continue;
      for (let i = 0; i < W; i++) {
        const phi = ((i + 0.5) / W - 0.5) * TAU;
        const x = ce * Math.sin(phi), z = ce * Math.cos(phi);
        const o = (j * W + i) * 4;
        const r = halfToFloat(shBuf[o]);
        const g = halfToFloat(shBuf[o + 1]);
        const b = halfToFloat(shBuf[o + 2]);
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
        if (r > 0 || g > 0 || b > 0) any = true;
        shBasis(x, y, z, _basis);
        for (let k = 0; k < 9; k++) {
          const w = _basis[k] * dOmega;
          acc[k * 3] += r * w;
          acc[k * 3 + 1] += g * w;
          acc[k * 3 + 2] += b * w;
        }
      }
    }
    if (!any) return false;

    for (let k = 0; k < 9; k++) {
      shArray[k * 3] = acc[k * 3];
      shArray[k * 3 + 1] = acc[k * 3 + 1];
      shArray[k * 3 + 2] = acc[k * 3 + 2];
      irradiance[k].setRGB(acc[k * 3], acc[k * 3 + 1], acc[k * 3 + 2]);
      sh.coefficients[k].set(acc[k * 3], acc[k * 3 + 1], acc[k * 3 + 2]);
    }
    return true;
  }

  /** CPU fallback: project sky.radiance() + the ground model directly. */
  function projectSHFromCPU(ctx) {
    const sky = ctx.get('sky');
    const acc = new Float64Array(27);
    const tmp = new THREE.Color();
    const N = 1024;
    const dOmega = (4 * Math.PI) / N;
    const gr = uniforms.uGroundRad.value;
    const hz = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const fi = (i + 0.5) / N;
      const y = 1 - 2 * fi;
      const s = Math.sqrt(Math.max(0, 1 - y * y));
      const ph = i * 2.399963229728653;
      const x = s * Math.cos(ph), z = s * Math.sin(ph);
      let r, g, b;
      if (y > 0) {
        if (sky?.radiance) { try { sky.radiance(_v.set(x, y, z), tmp); } catch { tmp.setRGB(0.4, 0.55, 0.9); } }
        else tmp.copy(uniforms.uZenithCol.value).lerp(uniforms.uHorizonCol.value, 1 - y);
        r = tmp.r; g = tmp.g; b = tmp.b;
      } else {
        const lobe = Math.pow(-y, S.groundLobe);
        if (sky?.radiance) { try { sky.radiance(_v.set(x, 0.045, z).normalize(), hz); } catch { hz.copy(uniforms.uHorizonCol.value); } }
        else hz.copy(uniforms.uHorizonCol.value);
        r = hz.r + (gr.r - hz.r) * lobe;
        g = hz.g + (gr.g - hz.g) * lobe;
        b = hz.b + (gr.b - hz.b) * lobe;
      }
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      shBasis(x, y, z, _basis);
      for (let k = 0; k < 9; k++) {
        const w = _basis[k] * dOmega;
        acc[k * 3] += r * w; acc[k * 3 + 1] += g * w; acc[k * 3 + 2] += b * w;
      }
    }
    for (let k = 0; k < 9; k++) {
      shArray[k * 3] = acc[k * 3];
      shArray[k * 3 + 1] = acc[k * 3 + 1];
      shArray[k * 3 + 2] = acc[k * 3 + 2];
      irradiance[k].setRGB(acc[k * 3], acc[k * 3 + 1], acc[k * 3 + 2]);
      sh.coefficients[k].set(acc[k * 3], acc[k * 3 + 1], acc[k * 3 + 2]);
    }
  }

  return {
    name: 'env',
    order: 28,
    enabled: true,

    /* ------------------------------------------------------------ public API */
    probe: null,
    cubeTexture: null,
    irradiance,
    sh,
    shArray,
    groundIrradiance: 0,
    intensity: S.intensity,

    /** E(n): irradiance in three's own light units (comparable with a DirectionalLight). */
    irradianceAt(n, out = new THREE.Color()) {
      const x = n.x, y = n.y, z = n.z;
      const c = irradiance;
      out.setRGB(0, 0, 0);
      out.r = c[0].r * 0.886227
        + c[1].r * 1.023328 * y + c[2].r * 1.023328 * z + c[3].r * 1.023328 * x
        + c[4].r * 0.858086 * x * y + c[5].r * 0.858086 * y * z
        + c[6].r * (0.743125 * z * z - 0.247708)
        + c[7].r * 0.858086 * x * z + c[8].r * 0.429043 * (x * x - y * y);
      out.g = c[0].g * 0.886227
        + c[1].g * 1.023328 * y + c[2].g * 1.023328 * z + c[3].g * 1.023328 * x
        + c[4].g * 0.858086 * x * y + c[5].g * 0.858086 * y * z
        + c[6].g * (0.743125 * z * z - 0.247708)
        + c[7].g * 0.858086 * x * z + c[8].g * 0.429043 * (x * x - y * y);
      out.b = c[0].b * 0.886227
        + c[1].b * 1.023328 * y + c[2].b * 1.023328 * z + c[3].b * 1.023328 * x
        + c[4].b * 0.858086 * x * y + c[5].b * 0.858086 * y * z
        + c[6].b * (0.743125 * z * z - 0.247708)
        + c[7].b * 0.858086 * x * z + c[8].b * 0.429043 * (x * x - y * y);
      out.r = Math.max(out.r, 0); out.g = Math.max(out.g, 0); out.b = Math.max(out.b, 0);
      return out;
    },

    /* ---------------------------------------------------------------- hooks */

    async init(ctx) {
      renderer = ctx.renderer;

      probeGeom = new THREE.SphereGeometry(10, 32, 24);
      probeMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: VERT_CUBE,
        fragmentShader: FRAG,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      probeMesh = new THREE.Mesh(probeGeom, probeMat);
      probeMesh.frustumCulled = false;
      probeMesh.matrixAutoUpdate = false;
      probeScene = new THREE.Scene();
      probeScene.add(probeMesh);

      cubeRT = new THREE.WebGLCubeRenderTarget(S.cubeSize, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      cubeRT.texture.colorSpace = THREE.NoColorSpace;
      cubeRT.texture.name = 'env.probeCube';
      cubeCam = new THREE.CubeCamera(0.5, 60, cubeRT);
      this.cubeTexture = cubeRT.texture;

      // Equirect target for the SH projection.
      quadGeom = new THREE.BufferGeometry();
      quadGeom.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      quadGeom.setAttribute('uv', new THREE.BufferAttribute(
        new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      shMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: VERT_EQUIRECT,
        fragmentShader: FRAG,
        defines: { ENV_EQUIRECT: 1 },
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      const shMesh = new THREE.Mesh(quadGeom, shMat);
      shMesh.frustumCulled = false;
      shScene = new THREE.Scene();
      shScene.add(shMesh);
      shCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      shRT = new THREE.WebGLRenderTarget(S.shWidth, S.shHeight, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      shRT.texture.colorSpace = THREE.NoColorSpace;

      pmrem = new THREE.PMREMGenerator(renderer);
      try { pmrem.compileCubemapShader(); } catch { /* non-fatal */ }

      const c = ctx.config.envCenter || S.center;
      cubeCam.position.set(c[0], c[1], c[2]);
      cubeCam.updateMatrixWorld(true);
      probeMesh.position.set(c[0], c[1], c[2]);
      probeMesh.updateMatrix();
      probeMesh.updateMatrixWorld(true);

      ctx.on('config', ({ k, v }) => {
        if (k === 'envIntensity') { this.intensity = v; this.applyIntensity(ctx); }
        else if (k === 'envRefresh' || k === 'envSandAlbedo' || k === 'envGroundMix'
          || k === 'envGroundLobe' || k === 'envSkyScale' || k === 'envCenter'
          || k === 'sunElevation' || k === 'sunAzimuth' || k === 'timeOfDay') {
          dirty = true; force = true;
        }
      });

      this.refresh(ctx);
    },

    /**
     * Push `intensity` into three and republish `groundIrradiance` — E(+Y), the
     * ambient this probe puts on a flat piece of beach, in the same units the sun and
     * the hemisphere fill are measured in. `tonemap.keyedExposure()` adds it to the
     * photographic key; without it the frame is over-exposed by exactly this much.
     */
    applyIntensity(ctx) {
      const s = this.intensity;
      if (ownsEnvironment && 'environmentIntensity' in ctx.scene) ctx.scene.environmentIntensity = s;
      if (!ownsEnvironment) { this.groundIrradiance = 0; return; }
      const e = this.irradianceAt(_up, _eUp);
      this.groundIrradiance = Math.max(0, LUM(e.r, e.g, e.b) * s);
    },

    /**
     * Re-capture the probe. Expensive — six cube faces, a PMREM chain and a blocking
     * pixel readback. Called at init, once after the scene settles, and whenever the
     * sun moves.
     */
    refresh(ctx) {
      if (failed || !renderer || !cubeRT) return;
      const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
      try {
        const c = ctx.config.envCenter || S.center;
        cubeCam.position.set(c[0], c[1], c[2]);
        cubeCam.updateMatrixWorld(true);
        probeMesh.position.set(c[0], c[1], c[2]);
        probeMesh.updateMatrix();
        probeMesh.updateMatrixWorld(true);

        syncUniforms(ctx);

        const prevTarget = renderer.getRenderTarget();
        const prevActiveFace = renderer.getActiveCubeFace();
        const prevActiveMip = renderer.getActiveMipmapLevel();
        const prevAuto = renderer.autoClear;

        renderer.autoClear = true;
        cubeCam.update(renderer, probeScene);

        renderer.setRenderTarget(shRT);
        renderer.clear(true, false, false);
        renderer.render(shScene, shCam);

        renderer.setRenderTarget(prevTarget, prevActiveFace, prevActiveMip);
        renderer.autoClear = prevAuto;

        // ---- PMREM ------------------------------------------------------------
        const next = pmrem.fromCubemap(cubeRT.texture, pmremRT);
        pmremRT = next;
        this.probe = next.texture;
        if (ctx.scene.environment === null || ownsEnvironment) {
          ctx.scene.environment = next.texture;
          ownsEnvironment = true;
        }

        // ---- SH9 --------------------------------------------------------------
        if (!projectSH()) projectSHFromCPU(ctx);
        this.applyIntensity(ctx);

        refreshes++;
        lastRefreshMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
        dirty = false;
        force = false;
        refFrame = ctx.clock.frame;
        const sd = ctx.get('time')?.sunDir;
        if (sd) refSun.copy(sd).normalize();
      } catch (e) {
        failed = true;
        console.warn('[env] probe refresh failed, IBL disabled:', e?.stack || e);
        if (ownsEnvironment) { ctx.scene.environment = null; ownsEnvironment = false; }
      }
    },

    update(dt, ctx) {
      // Dirty check only — the capture itself must never run per frame.
      const sd = ctx.get('time')?.sunDir;
      if (sd) {
        // Angular, not a quantised string: a string key trips on the last digit of a
        // float that is not really moving, and an animated sun would then pay the
        // 12 ms recapture on a large fraction of frames.
        _v.copy(sd).normalize();
        if (refSun.dot(_v) < Math.cos(THREE.MathUtils.degToRad(S.sunMoveDeg))) dirty = true;
      }
      const sky = ctx.get('sky');
      if (sky?.needsEnvUpdate) { dirty = true; force = true; sky.needsEnvUpdate = false; }
      if (!settled && ctx.clock.frame >= S.settleFrame) { settled = true; dirty = true; force = true; }
    },

    prerender(ctx) {
      if (failed) return;
      if (!this.enabled) {
        // Hot A/B: __HALO__.togglePass('env', false) must actually remove the IBL.
        if (ownsEnvironment) { ctx.scene.environment = null; ownsEnvironment = false; }
        this.groundIrradiance = 0;
        return;
      }
      if (!ownsEnvironment && this.probe && ctx.scene.environment === null) {
        ctx.scene.environment = this.probe;
        ownsEnvironment = true;
        this.applyIntensity(ctx);
      }
      if (dirty && (force || ctx.clock.frame - refFrame >= S.minRefreshFrames)) this.refresh(ctx);
    },

    resize(w, h, ctx) {},

    stats() {
      return { refreshes, lastRefreshMs: Math.round(lastRefreshMs * 100) / 100,
        groundIrradiance: this.groundIrradiance, failed };
    },

    dispose(ctx) {
      if (ownsEnvironment && ctx?.scene) ctx.scene.environment = null;
      ownsEnvironment = false;
      probeGeom?.dispose(); probeMat?.dispose();
      quadGeom?.dispose(); shMat?.dispose();
      cubeRT?.dispose(); shRT?.dispose();
      pmremRT?.dispose(); pmrem?.dispose();
      probeScene = null; shScene = null; cubeCam = null; shBuf = null;
    },
  };
}
