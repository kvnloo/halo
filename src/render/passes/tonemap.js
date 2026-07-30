import * as THREE from 'three';
import { Pass, fsMaterial, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `tonemap` — exposure + display transform. This is the pass that leaves linear space.
 *
 * Everything upstream is linear HDR radiance; everything downstream (grade, sharpen,
 * grain) works on sRGB-encoded display values in [0,1]. So this pass is the single
 * point where the scene's physical units get turned into pixels, and every other
 * subsystem in the game is judged through it.
 *
 * ## Why AgX
 *
 * The reference clip has a bright sky, sunlit sand and cloud tops that all sit within
 * a stop or two of clipping, and none of them shift hue on the way up. ACES's RRT
 * skews saturated highlights toward yellow (the notorious "ACES sunset") and bends
 * blue-cyan sky toward cyan-white; on this scene that reads instantly wrong. AgX
 * instead does its sigmoid in a *rotated, inset* primaries space, which means as a
 * channel approaches the top of the curve it desaturates toward the scene's own white
 * rather than rotating around the hue circle. That per-channel desaturation is exactly
 * what the reference's cloud tops and wet-sand glints look like.
 *
 * The implementation is the Blender / Filament formulation:
 *
 *   linear sRGB -> linear Rec.2020 -> AgX inset -> log2 encode over [-12.47, +4.03] EV
 *   -> per-channel sigmoid (6th-order fit of AgX's default contrast curve)
 *   -> optional ASC-style "look" -> AgX outset -> 2.2 decode -> linear sRGB -> sRGB OETF
 *
 * ACES-fitted (Stephen Hill's RRT+ODT fit) and extended Reinhard are provided as
 * alternates for A/B, selectable at runtime.
 *
 * ## Exposure
 *
 * Auto-exposure is deliberately absent: it makes a capture depend on what the camera
 * happened to be pointing at on the previous frame, which destroys determinism and
 * therefore the whole measurement loop. Instead the exposure is a manual scalar with a
 * photographic basis — it is keyed so that a Lambertian 18% grey card facing the key
 * light under `time.state.sunIntensity` lands on AgX's middle grey. See
 * `keyedExposure()` below; `ctx.config.exposure` overrides it outright and
 * `ctx.config.exposureEV` offsets it in stops.
 *
 * ## Config
 *
 *   exposure        number    linear scene->sensor multiplier (overrides the keyed value)
 *   exposureEV      number    stops added on top of whichever exposure is in force
 *   tonemapper      string    'agx' | 'aces' | 'reinhard' | 'none'
 *   tonemapWhite    number    extended-Reinhard white point, in exposed linear units
 *   agxLook         [s,o,p,sat]  AgX look: slope, offset, power, saturation (neutral = [1,0,1,1])
 *   tonemapGuard    bool      NaN/Inf repair (default true)
 *
 * Cost: one full-screen triangle, ~20 ALU + 1 tap. ~0.09 ms at 1920x1080 on a 3080 Ti.
 */

/* ------------------------------------------------------------------ matrices */
/* All matrices are written row-major here because that is how they are published;
 * `glslMat3` transposes them into GLSL's column-major constructor. Keeping one
 * source of truth means the JS mirror used for offline calibration and the GLSL that
 * actually ships can never drift apart. */

const M_SRGB_TO_REC2020 = [
  [0.6274, 0.3293, 0.0433],
  [0.0691, 0.9195, 0.0113],
  [0.0164, 0.0880, 0.8956],
];

const M_REC2020_TO_SRGB = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

/** AgX inset: rotates + compresses the primaries so the sigmoid desaturates instead of
 *  hue-rotating as channels approach the shoulder. */
const M_AGX_INSET = [
  [0.856627153315983, 0.0951212405381588, 0.0482516061458583],
  [0.137318972929847, 0.761241990602591, 0.101439036467562],
  [0.11189821299995, 0.0767994186031903, 0.811302368396859],
];

/** AgX outset: puts the saturation back, but not all of it — the residual is what
 *  gives AgX its characteristic highlight bleach. */
const M_AGX_OUTSET = [
  [1.1271005818144368, -0.11060664309660323, -0.016493938717834573],
  [-0.1413297634984383, 1.157823702216272, -0.016493938717834257],
  [-0.14132976349843826, -0.11060664309660294, 1.2519364065950405],
];

/* Stephen Hill's fit of the ACES RRT + sRGB ODT. */
const M_ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.07600, 0.90834, 0.01566],
  [0.02840, 0.13383, 0.83777],
];
const M_ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

/** log2( 2^-10 * 0.18 ) and log2( 2^6.5 * 0.18 ) — AgX's 16.5-stop working range. */
export const AGX_MIN_EV = -12.47393;
export const AGX_MAX_EV = 4.026069;

/** Rec.709 luma weights, used by the AgX look and by the alternates' desaturation. */
const LUMA = [0.2126, 0.7152, 0.0722];

/* -------------------------------------------------------------- JS reference */
/* These mirror the GLSL exactly and exist so the grade can be calibrated offline
 * (tools + the scratchpad harness) without a GPU in the loop. */

function mul3(m, c) {
  return [
    m[0][0] * c[0] + m[0][1] * c[1] + m[0][2] * c[2],
    m[1][0] * c[0] + m[1][1] * c[1] + m[1][2] * c[2],
    m[2][0] * c[0] + m[2][1] * c[1] + m[2][2] * c[2],
  ];
}

/** 6th-order polynomial fit of AgX's default contrast sigmoid on [0,1]. */
function agxSigmoid(x) {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
    + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/** AgX in JS. `look` = [slope, offset, power, saturation]; neutral is [1,0,1,1]. */
export function agxJS(rgb, look = null) {
  let c = mul3(M_AGX_INSET, mul3(M_SRGB_TO_REC2020, rgb.map((v) => Math.max(v, 0))));
  const range = AGX_MAX_EV - AGX_MIN_EV;
  c = c.map((v) => {
    const e = (Math.log2(Math.max(v, 1e-10)) - AGX_MIN_EV) / range;
    return agxSigmoid(Math.min(Math.max(e, 0), 1));
  });
  if (look && (look[0] !== 1 || look[1] !== 0 || look[2] !== 1 || look[3] !== 1)) {
    const l = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
    c = c.map((v, i) => {
      const p = Math.pow(Math.max(v * look[0] + look[1], 0), look[2]);
      return l + look[3] * (p - l);
    });
  }
  c = mul3(M_AGX_OUTSET, c).map((v) => Math.pow(Math.max(v, 0), 2.2));
  return mul3(M_REC2020_TO_SRGB, c).map((v) => Math.min(Math.max(v, 0), 1));
}

function acesFitJS(rgb) {
  let c = mul3(M_ACES_IN, rgb.map((v) => Math.max(v, 0)));
  c = c.map((v) => {
    const a = v * (v + 0.0245786) - 0.000090537;
    const b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  });
  return mul3(M_ACES_OUT, c).map((v) => Math.min(Math.max(v, 0), 1));
}

function reinhardJS(rgb, white) {
  const w2 = Math.max(white * white, 1e-4);
  return rgb.map((v) => {
    v = Math.max(v, 0);
    return Math.min(v * (1 + v / w2) / (1 + v), 1);
  });
}

/** sRGB OETF (piecewise, the real one — not pow(1/2.2)). */
export function srgbEncodeJS(c) {
  return c.map((v) => {
    v = Math.min(Math.max(v, 0), 1);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  });
}

/**
 * Full CPU mirror of this pass: linear scene radiance -> sRGB-encoded display value.
 * @param {number[]} rgb   linear scene radiance
 * @param {object}   p     { exposure, mode, white, look }
 */
export function tonemapJS(rgb, p = {}) {
  const e = p.exposure ?? 1;
  const lin = [rgb[0] * e, rgb[1] * e, rgb[2] * e];
  let d;
  switch (p.mode || 'agx') {
    case 'aces': d = acesFitJS(lin); break;
    case 'reinhard': d = reinhardJS(lin, p.white ?? 6); break;
    case 'none': d = lin.map((v) => Math.min(Math.max(v, 0), 1)); break;
    default: d = agxJS(lin, p.look || null); break;
  }
  return srgbEncodeJS(d);
}

/* ------------------------------------------------------------------- exposure */

const _lightDir = new THREE.Vector3();
const lum709 = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Luminous irradiance falling on the *ground plane* — an upward-facing Lambertian
 * surface — in the units three's physical lights use.
 *
 * Directional lights are combined with `max`, not `sum`: CSM registers one
 * DirectionalLight per cascade, all with the same colour, direction and intensity, and
 * each lights only its own depth slice. Summing them would over-key the exposure by
 * exactly the cascade count. The warm sand bounce points upward, so its `dir.y` is
 * negative and it correctly contributes nothing to a surface facing the sky.
 */
function groundIrradiance(scene) {
  let sun = 0, ambient = 0, found = false;
  scene.traverse((o) => {
    if (!o.isLight || o.visible === false || !(o.intensity > 0)) return;
    const L = lum709(o.color) * o.intensity;
    if (o.isDirectionalLight) {
      _lightDir.copy(o.position);
      if (o.target) _lightDir.sub(o.target.position);
      const len = _lightDir.length();
      if (len < 1e-6) return;
      sun = Math.max(sun, L * Math.max(_lightDir.y / len, 0));
      found = true;
    } else if (o.isHemisphereLight) {
      ambient += L;                       // sky half, seen in full by an up-facing normal
      found = true;
    } else if (o.isAmbientLight) {
      ambient += L;
      found = true;
    }
  });
  return found ? sun + ambient : 0;
}

/**
 * Photographic key. Pick the linear multiplier that lands an 18% Lambertian grey card
 * lying on the beach on AgX's middle grey (0.18 scene-linear at the tonemap input).
 *
 *   card radiance  L = 0.18/pi * E          E = irradiance on the ground plane
 *   we want        L * exposure = 0.18
 *   therefore      exposure = pi / E
 *
 * The albedo cancels, so this depends on nothing but the lights `lighting` actually
 * put in the scene — no image feedback, no frame-to-frame state, and identical for
 * every capture of a given time of day. That is the entire reason auto-exposure is
 * not used here: it would make a screenshot depend on where the camera was pointing
 * on the previous frame and the measurement loop would stop being reproducible.
 *
 * Sanity check against the clip: inverting AgX on kf_00000 puts sunlit dry sand at a
 * scene-linear (0.638, 0.409, 0.222), luma 0.444. With `lighting`'s defaults the same
 * surface renders at luma ~0.70, i.e. it wants ~0.64x — and pi / E with those lights
 * comes out at 0.67. The two independent derivations agree to 5%.
 */
export function keyedExposure(ctx) {
  let E = ctx?.scene ? groundIrradiance(ctx.scene) : 0;
  if (!(E > 1e-6)) {
    // No lights yet (isolated-module preview): fall back to the documented reference
    // rig — sun 6.2 at 41 deg elevation plus the 1.35 sky fill.
    const time = ctx?.get?.('time');
    const sun = time?.state?.sunIntensity ?? 6.2;
    const s = Math.max(Math.sin((time?.state?.elevationDeg ?? 41) * Math.PI / 180), 0.02);
    E = sun * s + 1.35 * Math.pow(s, 0.35) * 0.545;
  }
  return Math.PI / Math.max(E, 1e-6);
}

/* ------------------------------------------------------------------ the shader */

const glslMat3 = (m) => `mat3(${[0, 1, 2].map((c) => [0, 1, 2].map((r) => m[r][c].toFixed(12)).join(', ')).join(',\n            ')})`;

const FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uExposure;
uniform int   uMode;        // 0 = AgX, 1 = ACES fitted, 2 = extended Reinhard, 3 = none
uniform float uWhite;       // Reinhard white point
uniform vec4  uLook;        // AgX look: slope, offset, power, saturation
uniform float uGuard;       // >0.5 enables NaN/Inf repair
out vec4 oCol;

const mat3 SRGB_TO_REC2020 = ${glslMat3(M_SRGB_TO_REC2020)};
const mat3 REC2020_TO_SRGB = ${glslMat3(M_REC2020_TO_SRGB)};
const mat3 AGX_INSET       = ${glslMat3(M_AGX_INSET)};
const mat3 AGX_OUTSET      = ${glslMat3(M_AGX_OUTSET)};
const mat3 ACES_IN         = ${glslMat3(M_ACES_IN)};
const mat3 ACES_OUT        = ${glslMat3(M_ACES_OUT)};

const float AGX_MIN_EV = ${AGX_MIN_EV};
const float AGX_MAX_EV = ${AGX_MAX_EV};
const vec3  LUMA = vec3(${LUMA.join(', ')});

/* A NaN fails every comparison, so x != x isolates it without relying on isnan()
 * surviving the driver's optimiser. Inf is caught by the magnitude test — half-float
 * tops out at 65504, so anything past that came from a divide-by-zero upstream. */
bool isBad(vec3 c){
  return any(notEqual(c, c)) || any(greaterThan(abs(c), vec3(6.0e4)));
}

/* A broken shader upstream produces isolated NaN texels. Left alone they survive the
 * tonemap, then bloom/TAA smear them across the frame on the next pass. Replace a bad
 * texel with the mean of its finite 4-neighbours instead of black, so a dead pixel
 * disappears rather than becoming a hole. The branch is essentially never taken, so it
 * costs nothing in the common case. */
vec3 fetchGuarded(vec2 uv){
  vec3 c = texture(tSrc, uv).rgb;
  if (uGuard < 0.5 || !isBad(c)) return max(c, vec3(0.0));
  // textureLod, not texture: these taps sit inside divergent control flow, where
  // implicit-derivative LOD selection is undefined.
  vec3 sum = vec3(0.0); float n = 0.0;
  vec3 s;
  s = textureLod(tSrc, uv + vec2( uTexel.x, 0.0), 0.0).rgb; if (!isBad(s)) { sum += max(s, vec3(0.0)); n += 1.0; }
  s = textureLod(tSrc, uv + vec2(-uTexel.x, 0.0), 0.0).rgb; if (!isBad(s)) { sum += max(s, vec3(0.0)); n += 1.0; }
  s = textureLod(tSrc, uv + vec2(0.0,  uTexel.y), 0.0).rgb; if (!isBad(s)) { sum += max(s, vec3(0.0)); n += 1.0; }
  s = textureLod(tSrc, uv + vec2(0.0, -uTexel.y), 0.0).rgb; if (!isBad(s)) { sum += max(s, vec3(0.0)); n += 1.0; }
  return n > 0.0 ? sum / n : vec3(0.0);
}

vec3 agxSigmoid(vec3 x){
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 tonemapAgX(vec3 c){
  c = AGX_INSET * (SRGB_TO_REC2020 * max(c, vec3(0.0)));
  c = (log2(max(c, vec3(1e-10))) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  c = agxSigmoid(clamp(c, 0.0, 1.0));

  // ASC-style look, applied inside the sigmoid space where AgX defines it.
  if (uLook.x != 1.0 || uLook.y != 0.0 || uLook.z != 1.0 || uLook.w != 1.0) {
    float luma = dot(c, LUMA);
    vec3 p = pow(max(c * uLook.x + uLook.y, vec3(0.0)), vec3(uLook.z));
    c = luma + uLook.w * (p - luma);
  }

  c = pow(max(AGX_OUTSET * c, vec3(0.0)), vec3(2.2));   // out of AgX's 2.2 display space
  return clamp(REC2020_TO_SRGB * c, 0.0, 1.0);
}

vec3 tonemapACES(vec3 c){
  c = ACES_IN * max(c, vec3(0.0));
  c = (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081);
  return clamp(ACES_OUT * c, 0.0, 1.0);
}

vec3 tonemapReinhard(vec3 c){
  c = max(c, vec3(0.0));
  float w2 = max(uWhite * uWhite, 1e-4);
  return clamp(c * (1.0 + c / w2) / (1.0 + c), 0.0, 1.0);
}

vec3 srgbEncode(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main(){
  vec3 c = fetchGuarded(vUv) * uExposure;
  vec3 d;
  if      (uMode == 1) d = tonemapACES(c);
  else if (uMode == 2) d = tonemapReinhard(c);
  else if (uMode == 3) d = clamp(c, 0.0, 1.0);
  else                 d = tonemapAgX(c);
  oCol = vec4(srgbEncode(d), 1.0);
}
`;

const MODES = { agx: 0, aces: 1, reinhard: 2, none: 3 };

/* ------------------------------------------------------------------- the pass */

export function create(opts = {}) {
  const p = new Pass('tonemap');
  let quad = null, mat = null;

  p.init = (ctx) => {
    const c = ctx.config;
    // Seed defaults so a debug UI / the capture harness can enumerate and poke them.
    // `pipeline` is order 1000, so `lighting` (order 12) has already populated the
    // scene by the time this runs and the key is measured against the real rig.
    // Setting ctx.config.exposure = null at any point re-derives it.
    if (c.exposure === undefined || c.exposure === null) c.exposure = keyedExposure(ctx);
    if (c.exposureEV === undefined) c.exposureEV = 0;
    if (c.tonemapper === undefined) c.tonemapper = 'agx';
    if (c.tonemapWhite === undefined) c.tonemapWhite = 6.0;
    if (c.agxLook === undefined) c.agxLook = [1, 0, 1, 1];
    if (c.tonemapGuard === undefined) c.tonemapGuard = true;

    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uExposure: { value: c.exposure },
      uMode: { value: MODES.agx },
      uWhite: { value: c.tonemapWhite },
      uLook: { value: new THREE.Vector4(1, 0, 1, 1) },
      uGuard: { value: 1 },
    });
    quad = new FullScreenQuad(mat);
  };

  p.setSize = (w, h) => {
    if (mat) mat.uniforms.uTexel.value.set(1 / Math.max(w, 1), 1 / Math.max(h, 1));
  };

  p.render = (ctx, pipe, out) => {
    const c = ctx.config;
    const u = mat.uniforms;
    if (c.exposure === undefined || c.exposure === null) c.exposure = keyedExposure(ctx);
    u.uExposure.value = c.exposure * Math.pow(2, c.exposureEV || 0);
    u.uMode.value = MODES[c.tonemapper] ?? MODES.agx;
    u.uWhite.value = c.tonemapWhite ?? 6.0;
    u.uGuard.value = (c.tonemapGuard ?? true) ? 1 : 0;
    const lk = c.agxLook;
    if (lk) u.uLook.value.set(lk[0] ?? 1, lk[1] ?? 0, lk[2] ?? 1, lk[3] ?? 1);
    u.tSrc.value = pipe.read.texture;
    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.dispose = () => quad?.dispose();
  return p;
}
