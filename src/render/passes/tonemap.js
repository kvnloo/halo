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
 * photographic basis: it is keyed so an 18% Lambertian grey card lying on the beach
 * lands on AgX's middle grey, which works out to `exposure = pi / E` where E is the
 * irradiance on the ground plane. With the reference rig (sun 6.2 at 41 degrees plus
 * the 1.35 sky fill) that is 0.685, and AgX returns sRGB 127.6 for scene-linear 0.18 —
 * dead centre, no fudge factor. See `keyedExposure()`. `ctx.config.exposure` is seeded
 * with that value and can simply be overwritten; `ctx.config.exposureEV` offsets
 * whatever is in force by whole stops.
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
 * Cost: one full-screen triangle, ~20 ALU + 1 tap. Measured 0.05 ms at 1920x1080 on a
 * 3080 Ti (400-frame A/B against the pass disabled, with a per-frame pipeline flush).
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

const MODES = { agx: 0, aces: 1, reinhard: 2, none: 3 };

/**
 * Exposure compensation per tonemapper, so that switching one out is an A/B of the
 * *curve* and not an accidental exposure change.
 *
 * All three are normalised to where AgX puts scene-linear 0.18, which is sRGB 127.6 —
 * middle grey, by construction. ACES's fitted RRT+ODT is much darker through the
 * midtones (0.18 lands at 91.4) and extended Reinhard sits between them (109.1), so
 * without this a mode switch would read as "ACES is 0.75 stops under" rather than as
 * a difference in shoulder and hue behaviour. Solved numerically against `tonemapJS`.
 */
const MODE_GAIN = { agx: 1.0, aces: 1.6757, reinhard: 1.5031, none: 1.0 };

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
  const mode = (p.mode in MODES) ? p.mode : 'agx';
  const e = (p.exposure ?? 1) * MODE_GAIN[mode];
  // Same NaN/Inf contract as the shader: non-finite in, black out, never propagated.
  const g = (v) => (Number.isFinite(v) ? Math.max(v, 0) : 0);
  const lin = [g(rgb[0]) * e, g(rgb[1]) * e, g(rgb[2]) * e];
  let d;
  switch (mode) {
    case 'aces': d = acesFitJS(lin); break;
    case 'reinhard': d = reinhardJS(lin, p.white ?? 6); break;
    case 'none': d = lin.map((v) => Math.min(Math.max(v, 0), 1)); break;
    default: d = agxJS(lin, p.look || null); break;
  }
  return srgbEncodeJS(d);
}

/* ------------------------------------------------------------------- exposure */

const lum709 = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Ambient (non-directional) luminous irradiance reaching an upward-facing surface.
 * A HemisphereLight gives an up-facing normal its sky half in full, so its `color` and
 * `intensity` are the whole story; an AmbientLight is uniform by definition.
 */
function ambientIrradiance(scene) {
  let a = 0;
  scene.traverse((o) => {
    if (!o.isLight || o.visible === false || !(o.intensity > 0)) return;
    if (o.isHemisphereLight || o.isAmbientLight) a += lum709(o.color) * o.intensity;
  });
  return a;
}

/**
 * Photographic key. Pick the linear multiplier that lands an 18% Lambertian grey card
 * lying on the beach on AgX's middle grey.
 *
 *   card radiance  L = 0.18/pi * E          E = irradiance on the ground plane
 *   we want        L * exposure = 0.18
 *   therefore      exposure = pi / E
 *
 * The albedo cancels, so this depends on nothing but the lighting rig — no image
 * feedback, no frame-to-frame state, and identical for every capture at a given time
 * of day. That is the entire reason auto-exposure is not used: it would make a
 * screenshot depend on where the camera was pointing on the *previous* frame, and the
 * measurement loop would stop being reproducible.
 *
 * AgX earns the "middle grey" half of that claim: feeding it 0.18 returns sRGB 127.6,
 * i.e. dead centre, so exposure = pi / E needs no fudge factor.
 *
 * The sun term is read from `time`, not from the DirectionalLights in the scene, and
 * that is deliberate. `time` is the documented authority for sun direction, and CSM's
 * per-cascade lights do not have their transforms set until `csm.update()` runs in
 * lighting's prerender — which is *after* this pass initialises. Reading `light.position`
 * here would see three's default (0,1,0), read the sun as straight overhead, and
 * over-key the irradiance by 1/sin(elevation): 0.53 stops of silent under-exposure at
 * the reference's 41 degrees. (Measured: it produced 0.472 instead of 0.685.)
 * The sand-bounce fill is ignored for the same reason it should be — it shines upward,
 * so it delivers nothing to a surface facing the sky.
 *
 * Cross-check against the clip: inverting AgX on kf_00000 puts sunlit dry sand at a
 * scene-linear (0.638, 0.409, 0.222), luma 0.444. Rendering the same surface under
 * this rig gives luma ~0.70, i.e. it wants ~0.64x — and pi / E comes out at 0.685.
 * Two independent derivations, 7% apart.
 */
export function keyedExposure(ctx) {
  const time = ctx?.get?.('time');
  const sunLum = time?.sunColor ? lum709(time.sunColor) : 0.99;
  const sunI = time?.state?.sunIntensity ?? 6.2;
  const sinEl = time?.sunDir
    ? Math.max(time.sunDir.y, 0)
    : Math.max(Math.sin((time?.state?.elevationDeg ?? 41) * Math.PI / 180), 0);

  let E = sunLum * sunI * sinEl;
  const amb = ctx?.scene ? ambientIrradiance(ctx.scene) : 0;
  // No sky fill in the scene yet (isolated-module preview): assume the documented rig.
  E += amb > 0 ? amb : 1.35 * Math.pow(Math.max(sinEl, 0.02), 0.35) * 0.545;

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
    const mode = c.tonemapper in MODES ? c.tonemapper : 'agx';
    u.uExposure.value = c.exposure * MODE_GAIN[mode] * Math.pow(2, c.exposureEV || 0);
    u.uMode.value = MODES[mode];
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
