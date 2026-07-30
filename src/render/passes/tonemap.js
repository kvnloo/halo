import * as THREE from 'three';
import { Pass, fsMaterial, FullScreenQuad, makeRT } from '../RenderPipeline.js';

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
 * rather than rotating around the hue circle.
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
 * ### The curve, measured (grey ramp, exposure 1, look neutral)
 *
 *      exposed-linear   0.005  0.02  0.05  0.18  0.45  1.0  2.0  4.3  8.2  15.3  >16
 *      display code         6    37    70   128   170  202  224  240  248   254   255
 *
 * Two consequences that dictate everything below:
 *
 *  - 0.18 lands on 128. Middle grey is middle grey; the exposure key needs no fudge.
 *  - **The shoulder does not begin to bite until ~2x exposed-linear.** Reference frames
 *    put 0.9–1.7% of their pixels above code 224 and 0.03–0.12% above 240, i.e. real
 *    content at 2–15x. If a render never produces those values the shoulder is inert
 *    and AgX is indistinguishable from a gamma curve — the tonemapper is then not the
 *    problem, the *scene* has no highlight headroom. `ctx.config.tonemapProbe` exists
 *    to make that deficit visible instead of arguable; see `probe` below.
 *
 * ## Exposure
 *
 * Auto-exposure is deliberately absent: it makes a capture depend on what the camera
 * happened to be pointing at on the previous frame, which destroys determinism and
 * therefore the whole measurement loop. Instead the exposure is keyed photographically:
 * an 18% Lambertian grey card lying on the beach lands on AgX's middle grey, which
 * works out to `exposure = pi / E` where E is the irradiance on the ground plane.
 *
 * **The key is resolved every frame, not at init.** The previous version computed it in
 * `init` and cached it, which lost a race with `lighting`: `src/render/lighting.js`
 * constructs its HemisphereLight with `intensity = 0` and only assigns the real value
 * in `applyIntensities()`, so a traversal at init time reads 0 and silently falls
 * through to a hardcoded constant. Resolving per frame from a *cached light list*
 * (one traversal, refreshed when the scene graph changes) costs nothing, is idempotent,
 * and tracks time-of-day. See `keyedExposure()`.
 *
 * `ctx.config.exposure` always holds the resolved number (bloom reads it). Writing a
 * number to it from outside pins it; writing `null` returns it to auto.
 *
 * ### The pin used to last exactly one frame
 *
 * That one slot is both the input (the pin) and the output (the published number), so
 * "did somebody write this, or did we?" can only be answered by remembering what we
 * wrote. The previous version answered it with `v !== published` **and then immediately
 * republished the pin into the same slot**, which made the pin indistinguishable from
 * our own output on the very next frame. A pin was therefore honoured on frame 0 and
 * silently discarded from frame 1 onward:
 *
 *     node tools/capture.mjs --pose ref_00000 --config exposure=0.15 --settle 40 --out a.png
 *     node tools/capture.mjs --pose ref_00000 --config exposure=2.0  --settle 40 --out b.png
 *     cmp a.png b.png     # byte-identical, and identical to no pin at all
 *
 * A 13x exposure range with *zero* measured effect. Anyone tuning through this control
 * was tuning nothing, which is exactly the "pinned exposure vs keyedExposure()
 * interaction" that `docs/KNOWN_ISSUES.md` 8b suspected. The fix is to **latch** the pin
 * in a variable of our own (`pin` below) instead of re-deriving intent from the shared
 * slot every frame: an outside write latches, a non-number releases, and our own value
 * coming back around changes nothing. Comparison is by relative epsilon rather than
 * bit-equality so that a debug UI or harness round-tripping `ctx.config` through JSON
 * cannot have its own echo mistaken for a pin and freeze exposure.
 *
 * The other half of 8b — `exposureEV` dropping luminance by 10x between -0.8 and -1.6 —
 * does **not** reproduce. Swept 0 to -2 in quarter stops at `ref_00000`, lum_mean falls
 * 110.52 / 103.35 / 96.26 / 89.29 / 82.46 / 75.81 / 69.35 / 63.10 / 57.09, a per-step
 * ratio of 0.935 drifting to 0.905 as AgX's toe compresses. Monotonic, no cliff. The
 * archived `lum 13.2, sat 98.8, lap_var 8` is a near-black *flat* frame: lap_var 8 means
 * there was no image at any exposure, which is a frame that failed to render, not one
 * that was exposed down. Treat 8b's EV table as stale — its EV 0 row (148.4) no longer
 * holds either, the albedo work has since moved it to 110.5.
 *
 * ## Config
 *
 *   exposure        number    resolved linear scene->sensor multiplier. Write a number
 *                             to pin it; write null to re-derive from the lighting rig.
 *   exposureEV      number    stops added on top of whichever exposure is in force
 *   exposureTrimEV  number    stops folded into the *keyed* exposure only (see KEY_TRIM_EV).
 *                             Ignored while a pin is in force, because a pin is absolute.
 *   tonemapper      string    'agx' | 'aces' | 'reinhard' | 'none'
 *   tonemapWhite    number    extended-Reinhard white point, in exposed linear units
 *   agxLook         [s,o,p,sat]  AgX look: slope, offset, power, saturation (neutral = [1,0,1,1])
 *   tonemapGuard    bool      NaN/Inf repair (default true)
 *   tonemapProbe    bool|int  HDR headroom readout; true = every 30 frames, N = every N
 *   envIrradiance   number    manual ambient term for a PMREM probe that cannot report
 *                             its own L0 (see keyedExposure)
 *
 * Cost: one full-screen triangle, ~20 ALU + 1 tap. **0.18 ms** at 1920x1080 on a
 * 3080 Ti - measured, not estimated: best of three runs of 200 frames with the pass
 * toggled off and back on, `diag_sky`, ANGLE/Vulkan. (The previous doc claimed 0.05 ms,
 * which was an ALU estimate that ignored the 8.3 MB RGBA16F read and 8.3 MB write; at
 * this resolution a full-screen pass is bandwidth-bound and the shader is nearly free.)
 * Disabling tonemap, grade and dither together saves 0.29 ms rather than the 0.50 ms
 * their individual deltas sum to, because removing one pass from the chain removes a
 * ping-pong round-trip that the remaining ones then pay instead.
 *
 * The probe adds an 8x8 reduce plus a 518 KB synchronous readback and is off by default.
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
 * *curve* and not an accidental exposure change. All three are normalised to where
 * AgX puts scene-linear 0.18, which is sRGB 128. Solved numerically against `tonemapJS`.
 *
 * Exported because `bloom` needs it: bloom's threshold is specified in display codes and
 * has to be converted back to exposed-linear through the same gain this pass applies, so
 * a bloom threshold does not silently move when the tonemapper is switched. It used to
 * carry a hand-copied duplicate of this table with a comment saying it mirrored this
 * one - a mirror maintained by comment, in a file whose GLSL matrices are all generated
 * from JS constants precisely so that nothing has to be kept in sync by hand. Import it,
 * do not copy it.
 */
export const MODE_GAIN = { agx: 1.0, aces: 1.6757, reinhard: 1.5031, none: 1.0 };

/* -------------------------------------------------------------- JS reference */
/* These mirror the GLSL exactly and exist so the chain can be inspected offline
 * (tools + the calibration harness) without a GPU in the loop. */

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
    c = c.map((v) => {
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

/**
 * Exposed-linear value that produces a given display code through the neutral AgX
 * chain. Used by the probe to phrase "the scene has no headroom" in code values.
 */
export function exposedLinearForCode(code, p = {}) {
  let lo = 0, hi = 64;
  for (let i = 0; i < 64; i++) {
    const m = 0.5 * (lo + hi);
    if (tonemapJS([m, m, m], { exposure: 1, ...p })[0] * 255 < code) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}

/* ------------------------------------------------------------------- exposure */

const lum709 = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Ambient (non-directional) irradiance on an upward-facing surface, in three's own
 * light units — the same units `getAmbientLightIrradiance` /
 * `getHemisphereLightIrradiance` produce, so it is directly comparable with the sun
 * term below.
 *
 * The light *objects* are found by one traversal and cached; their `intensity` and
 * `color` are read live on every call. That distinction is the whole point:
 * `src/render/lighting.js:56` builds its HemisphereLight with intensity 0 and assigns
 * the real value later, so a function that reads the intensity at the moment it
 * traverses gets 0 and a function that keeps the reference gets the truth.
 *
 * @param {THREE.Scene} scene
 * @param {object} cache  { lights: THREE.Light[]|null, key: string }
 */
function ambientIrradiance(scene, cache) {
  if (!scene) return 0;
  if (cache.lights === null || cache.frames <= 0) {
    const found = [];
    scene.traverse((o) => { if (o.isHemisphereLight || o.isAmbientLight) found.push(o); });
    cache.lights = found;
    cache.frames = 30;          // re-scan at most twice a second
  }
  cache.frames--;
  let a = 0;
  for (const o of cache.lights) {
    if (o.visible === false || !(o.intensity > 0) || !o.parent) continue;
    a += lum709(o.color) * o.intensity;
  }
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
 * E is assembled from three terms, in priority order:
 *
 *  1. `ctx.get('lighting').groundIrradiance` — if `lighting` publishes its own resolved
 *     number, that is authoritative and nothing here is re-derived. This is the
 *     intended long-term contract: one module owns the rig, one number crosses the
 *     boundary, and there is no traversal to lose a race with.
 *  2. Otherwise: sun from `time` (the documented authority for sun direction — CSM's
 *     per-cascade lights do not have their transforms set until `csm.update()` runs in
 *     lighting's prerender, so reading `light.position` here would see three's default
 *     (0,1,0), read the sun as overhead and over-key by 1/sin(elevation)) plus the live
 *     ambient lights (see `ambientIrradiance`).
 *  3. Plus an environment term. `scene.environment` (the PMREM probe) is a real ambient
 *     source in an outdoor scene and a PMREM texture cannot be asked for its L0 cheaply,
 *     so it must be *published*: `env.groundIrradiance` or `ctx.config.envIrradiance`.
 *     If `scene.environment` is set and neither is available this warns once rather
 *     than silently under-keying.
 *
 * The fallback when there is no ambient light in the scene at all (isolated-module
 * previews) mirrors lighting.js's documented rig — `1.35 * alt^0.35` scaled by the luma
 * of `time.skyColor` — rather than a baked constant. The old code used 0.545, the luma
 * of the *sRGB codes* of lighting.js's placeholder hex 0x87b5e8; THREE.Color stores
 * linear, and in any case lighting.js overwrites that colour with `time.skyColor` on
 * the first update, whose linear luma at the reference elevation is 0.557.
 */
export function keyedExposure(ctx, cache = { lights: null, frames: 0, warned: false }) {
  const time = ctx?.get?.('time');
  const lighting = ctx?.get?.('lighting');

  // (1) lighting publishes a resolved number: trust it, derive nothing.
  const published = lighting?.groundIrradiance;
  if (typeof published === 'number' && published > 1e-6) return Math.PI / published;

  // (2) sun, from the time authority.
  const sunLum = time?.sunColor ? lum709(time.sunColor) : 0.968;
  const sunI = time?.state?.sunIntensity ?? 6.2;
  const sinEl = time?.sunDir
    ? Math.max(time.sunDir.y, 0)
    : Math.max(Math.sin((time?.state?.elevationDeg ?? 41) * Math.PI / 180), 0);
  let E = sunLum * sunI * sinEl;

  // (2b) ambient fills, read live off cached light objects.
  const amb = ambientIrradiance(ctx?.scene, cache);
  E += amb > 0
    ? amb
    : (time?.skyColor ? lum709(time.skyColor) : 0.557) * 1.35 * Math.pow(Math.max(sinEl, 0.02), 0.35);

  // (3) image-based ambient.
  const env = ctx?.get?.('env');
  const envE = (typeof env?.groundIrradiance === 'number' ? env.groundIrradiance : null)
    ?? (typeof ctx?.config?.envIrradiance === 'number' ? ctx.config.envIrradiance : null);
  if (envE != null) E += envE;
  else if (ctx?.scene?.environment && !cache.warned) {
    cache.warned = true;
    console.warn('[tonemap] scene.environment is set but no irradiance is published ' +
      '(env.groundIrradiance / ctx.config.envIrradiance). The exposure key is ignoring ' +
      'the image-based ambient term and the frame will be over-exposed by that amount.');
  }

  return Math.PI / Math.max(E, 1e-6);
}

/**
 * Exposure compensation applied to the *keyed* exposure, in stops. Fitted, not chosen.
 *
 * `keyedExposure()` above is pure photography: it puts an 18% Lambertian card on AgX's
 * middle grey and it has no opinion about this particular clip. The reference is a game
 * capture with its own exposure and its own grade, so the two only coincide by accident.
 * This constant is the measured difference, and it is kept separate from the key so the
 * physics stays legible and so zeroing it (`ctx.config.exposureTrimEV = 0`) recovers the
 * textbook value exactly.
 *
 * ### How it was fitted
 *
 * `ref_00000`, `--settle 40`, sweeping `exposureEV` around the keyed value. Whole-frame
 * targets from `docs/TARGETS.md` are lum_mean 107.8, p50 105, p99 221, shadow_frac 0.050,
 * highlight_frac 0.007.
 *
 *      EV     lum_mean   p50   p99   shadow_frac  highlight_frac
 *     +0.50    124.99    129   219      0.0441       0.0059
 *     +0.25    117.75    121   214      0.0493       0.0042
 *      0.00    110.52    114   209      0.0548       0.0030
 *     -0.125   106.92    110   207      0.0565       0.0025
 *     -0.25    103.35    106   204      0.0576       0.0021
 *     -0.50     96.26     98   198      0.0653       0.0013
 *
 * **The five targets do not have a common solution, and cannot.** The bulk terms want
 * about -0.2 stops (lum_mean alone -0.10, p50 alone -0.28); the tail terms want +0.2 to
 * +0.7 (shadow_frac +0.22, p99 +0.6, highlight_frac +0.7). That is not a disagreement
 * about exposure, it is the histogram being too *narrow*: our lum_std is 40 against the
 * reference's 52.3 and our lap_var 239 against 463. Exposure slides a histogram, it does
 * not widen one, so no single number can hit both a median and a 99th percentile that are
 * 12 codes further apart than ours. The tails belong to the albedo/lighting/grade work
 * (see `docs/KNOWN_ISSUES.md` 8 — sat_mean is still 36 against a target of 84).
 *
 * So this is fitted to the two terms exposure actually controls, by least squares on the
 * relative error of lum_mean and p50 against the local slopes (28.9 and 29.3 codes/stop):
 *
 *      0.030687 + 0.149749 * EV = 0   ->   EV = -0.205
 *
 * Measured with the trim in force (`ref_00000`, `--settle 48`): lum_mean 104.73, p50 107
 * against targets 107.8 and 105 — relative error 2.8% / 1.9%, down from 2.5% / 8.6%.
 * Setting `ctx.config.exposureTrimEV = 0` reproduces the untrimmed 110.52 / 114 exactly.
 *
 * **What this number assumes:** the albedos as of this fit. Other modules are lowering
 * them concurrently and each pass of that work moves lum_mean far more than this trim
 * does — the same sweep measured lum_mean 148.4 at EV 0 when `KNOWN_ISSUES` 8 was
 * written and 110.5 a few hours later. Re-fit with the sweep above whenever the albedo
 * work lands; do not treat -0.2 as a constant of nature. It is worth 5.8 codes.
 */
export const KEY_TRIM_EV = -0.2;

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

  // ASC-style look, applied inside the sigmoid space where AgX defines it. Contrast
  // dialled here rides *inside* the roll-off instead of fighting it, which is why this
  // is the right place for a tone trim and the grade's power-law pivot is not.
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

/* ---------------------------------------------------------------- HDR probe */
/* 8x8 reduce of the *exposed* linear luminance: r = block max, g = block mean.
 * Reading the full-res HDR target back would be 16 MB and a full pipeline stall; a
 * 240x135 float target is 518 KB and still resolves the top 0.1% honestly, because a
 * block maximum is an upper bound on every pixel in it. */
const PROBE_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform float uExposure;
uniform vec2  uSrcSize;
out vec4 oCol;
const vec3 LUMA = vec3(${LUMA.join(', ')});
void main(){
  ivec2 lim = ivec2(uSrcSize);
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  float mx = 0.0, sum = 0.0, n = 0.0;
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      ivec2 t = base + ivec2(i, j);
      if (t.x >= lim.x || t.y >= lim.y) continue;
      vec3 c = texelFetch(tSrc, t, 0).rgb;
      if (any(notEqual(c, c)) || any(greaterThan(abs(c), vec3(6.0e4)))) continue;
      float l = dot(max(c, vec3(0.0)), LUMA) * uExposure;
      mx = max(mx, l); sum += l; n += 1.0;
    }
  }
  oCol = vec4(mx, sum / max(n, 1.0), 0.0, 1.0);
}
`;

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/* ------------------------------------------------------------------- the pass */

export function create(opts = {}) {
  const p = new Pass('tonemap');
  let quad = null, mat = null;
  let probeRT = null, probeMat = null, probeQuad = null, probeBuf = null;
  let srcW = 1920, srcH = 1080;

  const expCache = { lights: null, frames: 0, warned: false };
  let published = NaN;          // the last value this pass wrote into ctx.config.exposure
  let pin = null;               // latched external pin; null = auto (keyed)
  let lastGood = null;          // last finite positive exposure, so a bad frame degrades

  /** Exposed-linear thresholds that matter, in display codes. Constant, computed once. */
  const CODE_LIN = { 200: exposedLinearForCode(200), 224: exposedLinearForCode(224), 240: exposedLinearForCode(240), 252: exposedLinearForCode(252) };

  /**
   * "Is this number a copy of the one we published, or did somebody write it?"
   *
   * Relative epsilon, not `===`. `ctx.config` gets round-tripped through JSON by the
   * debug UI and by `tools/captured.mjs`, and a re-serialised copy of our own output
   * differing in the last bit would otherwise read as an external pin and freeze the
   * exposure at whatever the key happened to be on that frame — a bug that would only
   * show up as "exposure stopped tracking time of day", hours later.
   *
   * The cost is that a pin within 1e-6 relative of the current auto value is ignored.
   * That pin is a no-op by definition, so nothing is lost.
   */
  const sameNumber = (a, b) =>
    Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-12);

  /**
   * Resolve the exposure for this frame.
   *
   * The pin lives in `pin`, not in `ctx.config.exposure`. The config slot is the
   * *published* value — it has to be, because bloom reads it to convert its
   * display-referred knee back to scene-linear — so intent cannot also be stored there.
   * Deriving intent from the shared slot is what made a pin evaporate after one frame;
   * see the "The pin used to last exactly one frame" note in the file header.
   *
   * Transitions:
   *   finite number > 0, not ours  ->  latch it as the pin (logged once)
   *   finite number > 0, ours      ->  no change; keeps whatever mode is in force
   *   anything else (null, NaN, 0) ->  release the pin, back to keyedExposure()
   *
   * Still idempotent: with no external writes it reads only live scene state and never
   * its own previous output.
   */
  function resolveExposure(ctx) {
    const c = ctx.config;
    const v = c.exposure;

    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      if (!sameNumber(v, published) && !sameNumber(v, pin)) {
        pin = v;
        console.info('[tonemap] exposure pinned to ' + v.toPrecision(6)
          + ' — set ctx.config.exposure = null to return to the keyed value');
      }
    } else if (pin !== null) {
      pin = null;
      console.info('[tonemap] exposure pin released; back to the keyed value');
    }

    // The trim rides on the keyed value only. A pin is an absolute request for a
    // specific sensor gain — silently multiplying it by 0.87 would make the pin lie,
    // and the pin is the control people reach for when they want a known number.
    const trim = Number.isFinite(c.exposureTrimEV) ? c.exposureTrimEV : KEY_TRIM_EV;
    let e = pin !== null
      ? pin
      : keyedExposure(ctx, expCache) * Math.pow(2, Math.min(Math.max(trim, -32), 32));
    // A rig that briefly reports zero irradiance (a light being rebuilt, env mid-bake)
    // must not publish Infinity into a slot bloom multiplies by. Hold the last good
    // number for that frame instead of emitting something that poisons the pipeline.
    if (!(Number.isFinite(e) && e > 0)) e = lastGood ?? 1;
    lastGood = e;

    c.exposure = e;
    published = e;
    p.exposure = e;
    return e;
  }

  p.init = (ctx) => {
    const c = ctx.config;
    // Seed defaults so a debug UI / the capture harness can enumerate and poke them.
    if (c.exposureEV === undefined) c.exposureEV = 0;
    if (c.tonemapper === undefined) c.tonemapper = 'agx';
    if (c.tonemapWhite === undefined) c.tonemapWhite = 6.0;
    if (c.agxLook === undefined) c.agxLook = [1, 0, 1, 1];
    if (c.tonemapGuard === undefined) c.tonemapGuard = true;
    if (c.tonemapProbe === undefined) c.tonemapProbe = false;
    if (c.exposureTrimEV === undefined) c.exposureTrimEV = KEY_TRIM_EV;
    // Not resolved here on purpose — `lighting` has not finished wiring its intensities
    // when pipeline.init runs. resolveExposure() runs per frame and gets the truth.
    if (c.exposure === undefined) c.exposure = null;

    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uExposure: { value: 1 },
      uMode: { value: MODES.agx },
      uWhite: { value: c.tonemapWhite },
      uLook: { value: new THREE.Vector4(1, 0, 1, 1) },
      uGuard: { value: 1 },
    });
    quad = new FullScreenQuad(mat);
  };

  p.setSize = (w, h) => {
    srcW = Math.max(1, w | 0); srcH = Math.max(1, h | 0);
    if (mat) mat.uniforms.uTexel.value.set(1 / srcW, 1 / srcH);
    if (probeRT) {
      probeRT.setSize(Math.ceil(srcW / 8), Math.ceil(srcH / 8));
      probeBuf = null;
    }
  };

  /**
   * Scene-linear headroom readout. Answers, with numbers, the only question that
   * matters about a display transform whose shoulder never engages: does the *scene*
   * produce values up there at all?
   */
  function runProbe(ctx, pipe, exposure) {
    if (!probeRT) {
      probeRT = makeRT(Math.ceil(srcW / 8), Math.ceil(srcH / 8), { type: THREE.FloatType });
      probeRT.texture.minFilter = THREE.NearestFilter;
      probeRT.texture.magFilter = THREE.NearestFilter;
      probeMat = fsMaterial(PROBE_FRAG, {
        tSrc: { value: null }, uExposure: { value: 1 }, uSrcSize: { value: new THREE.Vector2(srcW, srcH) },
      });
      probeQuad = new FullScreenQuad(probeMat);
    }
    const w = probeRT.width, h = probeRT.height;
    probeMat.uniforms.tSrc.value = pipe.read.texture;
    probeMat.uniforms.uExposure.value = exposure;
    probeMat.uniforms.uSrcSize.value.set(srcW, srcH);
    const prev = ctx.renderer.getRenderTarget();
    ctx.renderer.setRenderTarget(probeRT);
    probeQuad.render(ctx.renderer);
    if (!probeBuf || probeBuf.length !== w * h * 4) probeBuf = new Float32Array(w * h * 4);
    ctx.renderer.readRenderTargetPixels(probeRT, 0, 0, w, h, probeBuf);
    ctx.renderer.setRenderTarget(prev);

    const n = w * h;
    const mx = new Float32Array(n), av = new Float32Array(n);
    for (let i = 0; i < n; i++) { mx[i] = probeBuf[i * 4]; av[i] = probeBuf[i * 4 + 1]; }
    mx.sort(); av.sort();
    const frac = (arr, t) => { let k = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > t) k++; return k / arr.length; };
    const st = {
      exposure,
      // block means: where the bulk of the image sits, in exposed-linear
      p50: percentile(av, 0.50), p90: percentile(av, 0.90), p99: percentile(av, 0.99),
      // block maxima: an upper bound per 8x8 tile, so these bound the real tails
      max_p50: percentile(mx, 0.50), max_p99: percentile(mx, 0.99),
      max_p999: percentile(mx, 0.999), max: mx.length ? mx[mx.length - 1] : 0,
      // how much of the frame can reach the parts of the curve that actually bend
      blocks_over_code200: frac(mx, CODE_LIN[200]),
      blocks_over_code224: frac(mx, CODE_LIN[224]),
      blocks_over_code240: frac(mx, CODE_LIN[240]),
      blocks_over_code252: frac(mx, CODE_LIN[252]),
      code_thresholds: CODE_LIN,
    };
    p.probe = st;
    globalThis.__HALO_TONEMAP_PROBE__ = st;
    const f = (v) => (v < 10 ? v.toFixed(4) : v.toFixed(2));
    console.info('[tonemap] HDR headroom  exposure=' + exposure.toFixed(4) +
      '  exposed-linear p50=' + f(st.p50) + ' p99=' + f(st.p99) +
      '  tile-max p99=' + f(st.max_p99) + ' p99.9=' + f(st.max_p999) + ' max=' + f(st.max) +
      '  tiles>2.02(code224)=' + (st.blocks_over_code224 * 100).toFixed(3) + '%' +
      '  tiles>4.32(code240)=' + (st.blocks_over_code240 * 100).toFixed(3) + '%' +
      '   [reference frames: 0.9-1.7% of *pixels* above code 224, 0.03-0.12% above 240]');
    return st;
  }

  p.render = (ctx, pipe, out) => {
    const c = ctx.config;
    const u = mat.uniforms;
    const exposure = resolveExposure(ctx);
    const mode = c.tonemapper in MODES ? c.tonemapper : 'agx';
    // `c.exposureEV || 0` is deliberately the same expression bloom uses to reconstruct
    // this gain (bloom.js `exposureGain`), so the two can never disagree for any value a
    // human would type. The clamp only catches ±Infinity / absurd pokes, which would
    // otherwise reach the shader as a non-finite uniform and white or black the frame.
    const evGain = Math.pow(2, Math.min(Math.max(c.exposureEV || 0, -32), 32));
    const raw = exposure * MODE_GAIN[mode] * evGain;
    const total = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1e6) : 1;
    u.uExposure.value = total;
    p.exposureTotal = total;
    u.uMode.value = MODES[mode];
    u.uWhite.value = c.tonemapWhite ?? 6.0;
    u.uGuard.value = (c.tonemapGuard ?? true) ? 1 : 0;
    const lk = c.agxLook;
    if (lk) u.uLook.value.set(lk[0] ?? 1, lk[1] ?? 0, lk[2] ?? 1, lk[3] ?? 1);

    const pr = c.tonemapProbe;
    if (pr) {
      const every = typeof pr === 'number' ? Math.max(1, pr | 0) : 30;
      if ((ctx.clock?.frame ?? 0) % every === 0) runProbe(ctx, pipe, total);
    }

    u.tSrc.value = pipe.read.texture;
    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.dispose = () => { quad?.dispose(); probeQuad?.dispose(); probeRT?.dispose(); };
  return p;
}
