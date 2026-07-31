import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';
import { HASH_GLSL, VALUE_NOISE_GLSL } from '../../gfx/glsl/noise.js';
// Read-only: the shared uniform block every world material and the ocean already alias.
// This pass never edits materialCommon.js; see ownAerial().
import { sharedAerialUniforms } from '../../gfx/materialCommon.js';

/**
 * `volumetricFog` — **the single owner of aerial perspective in this renderer**, plus the
 * local dust layer and its crepuscular rays.
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
 * ## WHO OWNS AERIAL PERSPECTIVE — re-decided in Wave H, now that depth survives
 *
 * KNOWN_ISSUES 18 is closed (reports/depth.md): `pipe.depthTex` now holds true opaque
 * world depth for the whole post chain instead of the viewmodel alone. The previous
 * split — `materialCommon.js`'s `wmAerial` owning aerial perspective on every surface,
 * this pass owning only the sky and the shafts — existed *because* opaque pixels had no
 * distance here. That constraint is gone, so the split was re-opened and reversed.
 *
 * ```
 *   opaque surfaces  ->  THIS PASS. Extinction + ambient in-scatter + shadowed sun
 *                        in-scatter, integrated along the real depth-buffer distance.
 *   water            ->  THIS PASS, via the analytic sea plane (water still does not
 *                        write depth — see 'The sea plane' below).
 *   sky              ->  sky.js. It integrates the planetary atmosphere to infinity and
 *                        is not touched here: the aerosol component of the march is
 *                        gated OFF on sky pixels so it cannot be counted twice. Only the
 *                        LOCAL dust layer, which the planetary model does not contain,
 *                        is integrated in front of the sky.
 *   viewmodel        ->  nothing. It is inside the near plane; there is no participating
 *                        medium in front of it.
 * ```
 *
 * This is Hillaire EGSR 2020 5.4 as quoted in research/aerial.md 4.2 ("aerial perspective
 * is applied on opaque objects as a post process after lighting is evaluated... applying
 * aerial perspective to the sky would double-count") and it is the arrangement
 * research/aerial.md 4.3 recommends for this pipeline by name.
 *
 * Reasons this direction and not the other, in order of weight:
 *
 * 1. **It is measurable, and it was measured.** At ref_00000, `--config aerialDensity=0`
 *    (i.e. `wmAerial` switched off, nothing else changed) moves whole-frame `sat_mean`
 *    51.83 -> 68.23, `lab_b` -1.71 -> +1.21 and `lap_var` 472.4 -> 603.9 against a
 *    reference of 77.86 / +4.67 / 598.8. The `cliff` ROI moves sat 38.5 -> 73.4 and the
 *    `horizon` ROI 30.9 -> 62.5. `wmAerial` as parameterised is costing this project 16
 *    points of whole-frame saturation. Switching this pass off instead costs 1.7.
 * 2. **`wmAerial` cannot be fixed from any file this project is allowed to hold.** Its
 *    density is wrong by ~11x (0.0062/m is Koschmieder V = 631 m, i.e. fog: research
 *    /aerial.md 0), its phase function has an unnormalised 0.42 pedestal that never falls
 *    to zero in any direction, its scale height of 48 m is a mist layer, and its
 *    in-scatter colour is three hand-authored constants that cannot track the sky. Four
 *    defects in one function in a file with a different owner.
 * 3. **The in-scatter colour here is the sky's own radiance** (see `skyJ`), so distant
 *    geometry dissolves into the sky instead of being outlined against a hand-authored
 *    grey. That is what the reference's bright *and* saturated horizon band is:
 *    kf_00000 `horizon` measures lum 119.5 / sat 69.7. `wmAerial` reaches the luminance
 *    (127.7) by spending 39 points of saturation to get there.
 * 4. **It is shadowed.** Aerial perspective and the shafts become one integral instead of
 *    an unshadowed analytic term plus a shadowed additive one — which is the sun-lobe
 *    double-apply research/aerial.md 5.3 identifies, and it is deleted by construction
 *    rather than compensated.
 *
 * What it costs: transparent surfaces other than water (glass in `structures.js`,
 * particles) receive the aerial perspective of whatever is *behind* them, because they
 * do not write depth. That is the standard cost of the post-pass side of the split, it
 * is what Hillaire pays too (he applies a per-vertex term to transparents), and at these
 * poses it is a few hundred pixels of bridge glazing.
 *
 * ### How `wmAerial` is switched off, given that this file may not edit that one
 *
 * `materialCommon.updateAerialUniforms()` reads `ctx.config.aerialDensity` every frame,
 * and `ocean.js` aliases the same uniform block. So this pass writes
 * `ctx.config.aerialDensity = 0` each frame — one shared key, no import, no edit to a
 * `materialCommon`'s own default is latched out of that block on the first frame and
 * written back if this pass stops wanting ownership, so the hand-off is reversible; and a
 * `--config aerialDensity=...` override always wins, because `lighting.prerender` pushes
 * it into the block before any post pass runs. See `ownAerial()`.
 *
 * The honest same-build A/B for the whole decision is one flag:
 * ```
 *   --config fogAerial=0   hands aerial perspective back to wmAerial. Opaque pixels then
 *                          get no extinction and no ambient in-scatter from this pass,
 *                          only the shafts — the Wave-G arrangement, except that the
 *                          shafts now march the real depth-buffer distance instead of a
 *                          flat 60 m, and sky pixels get the ambient lobe at 1.0 rather
 *                          than 0.52. Measured at ref_00000: 102.77 / 52.61 / 461.6
 *                          against the pre-edit tree's 102.87 / 51.83 / 472.4.
 *   --config fog=false     removes this pass entirely AND releases the ownership claim,
 *                          i.e. the Wave-G build.
 * ```
 *
 * ## Structure
 *
 * Two draws.
 *
 * 1. **March**, at `resScale` (default 1/4 in each axis, so 480x270 at 1080p). Each low
 *    resolution pixel walks its own view ray front-to-back in `STEPS` non-uniform steps,
 *    sampling
 *      - a two-component density (below), with a slow 2-octave value-noise modulation on
 *        the dust term so the haze has body instead of reading as a flat wash;
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
 * 2. **Class-aware upsample + composite**, at full resolution: `scene * T + L`.
 *
 * ## Two density components, because they have different owners
 *
 * ```
 *   sigma(p) = uHazeDensity * exp(-h/uHazeHeight) * isGeo      // aerosol: aerial persp.
 *            + uMistDensity * exp(-h/uMistHeight) * noise(p)   // local dust: the shafts
 * ```
 *
 * They are not the same medium and must not share one number.
 *
 * - The **aerosol** term is the marine haze that makes a sea stack at 1 km pale. Its
 *   scale height is ~1.2 km (Bruneton `demo.cc`, Hillaire Table 1), i.e. effectively
 *   constant over this scene, and its coefficient is chosen from the haze fraction wanted
 *   at the far distance: research/aerial.md 2.5 gives beta_ex = 5e-4 .. 8e-4 m^-1 for
 *   "distant stacks dissolve at ~1.5 km while the foreground is crisp". **This species is
 *   already in sky.js's planetary integral**, so it is gated off on sky pixels
 *   (`isGeo`), which is the no-double-count rule.
 * - The **dust** term is the low, noisy, wind-advected layer the shafts live in. Scale
 *   height 24 m, so it is a ground effect. It is *not* in the planetary model, so it is
 *   integrated in front of the sky as well, and it is tapered out over the last third of
 *   `uMistDist` rather than ending on a step.
 *
 * Merging them, which is what the old single `fogDensity` did, forces one of the two to
 * be wrong: 24 m of scale height cannot reach a sea stack, and 1.2 km of scale height
 * puts the shaft dust at the top of the frame.
 *
 * ## The constants that were re-derived, not re-fitted
 *
 * - `ambient` 0.52 -> **1.0**. This is not a look knob and must not be swept. Setting
 *   `s -> infinity` in the single-scattering solution gives `L -> J`, so `J` is by
 *   identity the radiance of an infinitely deep slab of the same medium — the sky
 *   radiance in that direction (research/aerial.md 1.3). The composite is
 *   `src*T + J*(1-T)`; at `J = src` that is exactly `src`, so **a correct ambient lobe is
 *   a no-op on the sky at any density**, and a distant surface tends to the sky pixel
 *   above it instead of to a seam. Any value but 1.0 breaks both limits. 0.52 was a fit
 *   against a hand-authored `J`; `skyJ()` now samples the real one.
 * - `density` 0.00075 (one merged layer) -> `hazeDensity` 0.00055 + `mistDensity` 0.00039
 *   (see above). Koschmieder on the aerosol term alone: V = 3.912/5.5e-4 = **7.1 km**,
 *   which is tropical haze. The old merged number was V = 5.2 km *including* a term whose
 *   scale height made it irrelevant past the beach.
 * - `geoAmbient` 0.0 -> `aerial` 1.0. The old value was the whole of the old split.
 * - `geoMaxDist` (60 m) and `useNormalMask` are **deleted**. They existed only to stand
 *   in for the distance KNOWN_ISSUES 18 was stealing; `tEnd` now comes from the depth
 *   buffer exactly. Shafts no longer leak through solid geometry for up to 60 m.
 *
 * ## The sea plane — still required, re-checked rather than assumed
 *
 * `pipe.depthTex` is written once, by the G-buffer opaque pre-pass. `ocean.js:1921`
 * renders with `depthWrite: false`, so **water is still absent from the depth buffer**
 * even after KNOWN_ISSUES 18 (reports/depth.md 8.6 says so; `--config fogSeaPlane=0`
 * with `fogDebug=1` confirms it from this pass's own classification — the whole sea goes
 * from 'world' red to 'sky' green). The ocean is a plane at a known height, so
 * `t = -(camY - seaLevel)/dir.y` is exact and needs no depth buffer. It is now doing more
 * work than it was, not less: it is the only thing giving the sea its aerial perspective
 * now that `ocean.js`'s aliased `wmAerial` copy is switched off with the rest.
 *
 * It is strictly conservative for dry land: the beach sits above y = 0, so the plane is
 * always at or beyond the true surface distance and never shortens a march past it.
 *
 * ## The viewmodel
 *
 * reports/depth.md 5c: the weapon is in `pipe.viewDepthTex` and *not* in `pipe.depthTex`,
 * so as of the depth fix it classified as sky and got the entire layer integrated over
 * it — a milky veil on the barrel wherever it silhouettes against the sky (100 % of the
 * weapon at `shot_beach_establishing`, 69 % at `shot_cliff_vegetation`). It is now its
 * own class with `tEnd = 0`: no medium in front of it at all, which is the physical
 * answer, and the composite's class weight keeps the bilateral from smearing the
 * neighbouring sky's fog value back over the silhouette.
 *
 * ## Other choices that matter
 *
 * - **The step distribution is exponential (constant ratio), not quadratic-biased.** It
 *   used to be `t = tEnd*(0.25u + 0.75u^2)`, which was fine when `tEnd` was 460 m on
 *   almost every pixel. It is not fine now: `tEnd` is the real surface distance and
 *   spans 0.5 m to 6 km, and with a quadratic bias the *first step* scales with `tEnd`
 *   — 3 m on a sky pixel, 40 m on a sea stack at 3 km. Neighbouring pixels would then
 *   sample the 46 m dust noise at completely different rates and leave a rim along every
 *   distant silhouette. `t = tNear * grow^i` with `grow = (tEnd/tNear)^(1/STEPS)` keeps
 *   the sampling rate constant in log-distance, which is the froxel-volume standard
 *   (exponential depth slices). Two `pow`s per pixel, not one per step. The aerosol term
 *   is constant where the steps get long and a piecewise-constant integration of a
 *   constant is exact, so the long far steps cost nothing. `--config fogStepExp=0`
 *   restores the quadratic for A/B.
 * - **The dither is static.** The first step is offset by an interleaved-gradient hash of
 *   `gl_FragCoord` with *no* frame term, deliberately. A frame-varying offset is the usual
 *   trick — let TAA average the noise away — but the noise here is generated at quarter
 *   resolution, so it arrives at TAA as correlated 4x4 blocks. TAA's variance box is a
 *   full-resolution 3x3 that sits *inside* one such block, measures near-zero variance,
 *   and clips the history that would have averaged it: the noise never converges and
 *   instead crawls. A fixed offset costs a small stationary banding (invisible at 40 steps
 *   against a smooth density) and is temporally dead, which is what a temporal filter
 *   downstream actually wants.
 *
 * ## ctx.config knobs
 * ```
 * fog            true      master enable (also leaves wmAerial alone when false)
 * fogDensity     0.00055   aerosol extinction per metre — aerial perspective
 * fogMistRatio   0.70      dust extinction at sea level, as a fraction of fogDensity
 * fogHeight      24.0      e-folding height of the DUST layer, metres
 * fogHazeHeight  1200.0    e-folding height of the AEROSOL layer, metres
 * fogMaxDist     460.0     extent of the dust layer; NOT a cap on aerial perspective
 * fogFarMax      6000.0    hard cap on the marched distance to a surface
 * fogShafts      0.25      scale on the sun in-scatter (the crepuscular term)
 * fogAmbient     1.0       scale on the ambient in-scatter — see above, do not sweep
 * fogAerial      1.0       1 = this pass owns aerial perspective on surfaces (and zeroes
 *                          wmAerial); 0 = the Wave-G split, shafts only
 * fogSeaPlane    true      terminate the march at the ocean plane
 * fogNoise       0.55      0 = smooth dust, 1 = fully modulated
 * fogWarmth      1.0       scale on the warm tint pushed into the SUN lobe
 * fogStepExp     1         1 = exponential step spacing, 0 = the old quadratic bias
 * fogWeaponMask  1         0 = stop excluding the viewmodel (reproduces the Wave-H bug)
 * fogDebug       0         1 = class map, 2 = distance ramp, 3 = paint skyJ over the sky
 * fogDbgScale    1000      metres mapped to white by fogDebug=2
 * ```
 */

/* ------------------------------------------------------------------ shared */

/**
 * Uniforms and classification shared verbatim by the march and the composite, so the two
 * cannot drift apart. The composite's upsample has to reproduce the march's own
 * classification exactly or it blends across a discontinuity it cannot see — that is
 * where the +108-code streaks at the dune line came from (reports/fog.md 3.2).
 */
const CLASSIFY_GLSL = /* glsl */`
uniform sampler2D tDepth;       // opaque WORLD depth (reports/depth.md 3). 1.0 == sky.
uniform sampler2D tViewDepth;   // viewmodel-only depth. 1.0 == not the weapon.
uniform float uHasViewDepth;
uniform mat4  uInvVP;
uniform vec3  uCamPos;
uniform float uSeaLevel;
uniform float uSeaEnable;

#define CLS_SKY    0.0
#define CLS_WORLD  1.0
#define CLS_WEAPON 2.0

vec3 rayDir(vec2 ndc){
  vec4 fp4 = uInvVP * vec4(ndc, 1.0, 1.0);
  return normalize(fp4.xyz / fp4.w - uCamPos);
}

/** Distance to the sea plane, or -1 if this ray never reaches it. Analytic: the ocean is
 *  a plane at a known y (docs/WORLD.md: sea level is y = 0) and it renders with
 *  'depthWrite: false', so it is in no depth buffer at any point in the frame. */
float seaHitDist(vec3 dir){
  if (uSeaEnable < 0.5) return -1.0;
  float h = uCamPos.y - uSeaLevel;
  if (h <= 0.05 || dir.y > -1e-4) return -1.0;
  return -h / dir.y;
}

/** vec2(class, radial distance to the surface). distance < 0 means 'nothing there'. */
vec2 fogClassify(vec2 uv){
  vec2 ndc = uv * 2.0 - 1.0;
  // The weapon is drawn under its own projection into its own depth attachment, so its
  // depth is a MASK here and never a distance (reports/depth.md 3).
  if (uHasViewDepth > 0.5 && texture(tViewDepth, uv).r < 1.0) return vec2(CLS_WEAPON, 0.0);

  float dist = -1.0;
  float dz = texture(tDepth, uv).r;
  if (dz < 0.999999) {
    vec4 wp4 = uInvVP * vec4(ndc, dz * 2.0 - 1.0, 1.0);
    dist = length(wp4.xyz / wp4.w - uCamPos);
  }
  float tSea = seaHitDist(rayDir(ndc));
  if (tSea > 0.0 && (dist < 0.0 || tSea < dist)) dist = tSea;

  return vec2(dist > 0.0 ? CLS_WORLD : CLS_SKY, dist);
}
`;

/**
 * The equilibrium in-scatter radiance J in a view direction, reconstructed from four real
 * `sky.radiance()` samples. Shared so the debug view can paint it straight over the sky.
 */
const SKYJ_GLSL = /* glsl */`
uniform vec3  uAmbSky;        // zenith
uniform vec3  uAmbHorSun;     // horizon, sun azimuth
uniform vec3  uAmbHorSide;    // horizon, 90 deg off the sun
uniform vec3  uAmbHorAnti;    // horizon, anti-solar azimuth
uniform vec3  uAmbGround;     // in-scattered ground bounce, lower hemisphere
uniform vec2  uSunAz;         // normalised (sunDir.xz)
uniform float uHorizonEl;     // elevation the horizon ring was actually sampled at

/**
 * research/aerial.md 1.3: set s -> infinity in the single-scattering solution and the
 * radiance tends to J. J is therefore, by identity, *the radiance of an infinitely deep
 * slab of the same medium* — i.e. the sky radiance in that direction. If J is not the
 * colour the sky module paints there, distant geometry does not dissolve into the sky, it
 * is outlined against it, and everything the haze touches drifts toward whatever fixed
 * colour J actually is. sky.radiance() is not a second sky model — sky.js reads its own
 * sky-view LUT back to the CPU and applies the same phase functions and scales the dome
 * fragment does — so this is the drawn sky, not an approximation of it.
 */
vec3 skyJ(vec3 d){
  vec2 dh = vec2(d.x, d.z);
  float lh = length(dh);
  float a = lh > 1e-5 ? dot(dh / lh, uSunAz) : 0.0;    // -1 anti-solar .. +1 toward sun
  vec3 H = a >= 0.0 ? mix(uAmbHorSide, uAmbHorSun, a) : mix(uAmbHorSide, uAmbHorAnti, -a);
  // sqrt in elevation, not linear: the horizon band is thin in angle and the gradient to
  // the zenith is steep near it. Linear leaves the whole lower sky reading as zenith blue.
  //
  // The horizon ring is sampled a hair above the horizon (uHorizonEl), not on it, because
  // exactly on it the CPU march grazes the ground sphere. The interpolation is anchored so
  // that skyJ() at that elevation returns the sample itself: without the remap it returned
  // sqrt(0.052) = 23 % zenith at the very direction the sample was taken in.
  float el = clamp(d.y, -1.0, 1.0);
  float up = sqrt(clamp((el - uHorizonEl) / max(1.0 - uHorizonEl, 1e-3), 0.0, 1.0));
  float dn = sqrt(clamp((-el - uHorizonEl) / max(1.0 - uHorizonEl, 1e-3), 0.0, 1.0));
  return el >= 0.0 ? mix(H, uAmbSky, up) : mix(H, uAmbGround, dn);
}
`;

/* -------------------------------------------------------------------- march */

const MARCH_FRAG = /* glsl */`
precision highp sampler2DShadow;

in vec2 vUv;

uniform vec3  uSunDir;        // toward the sun
uniform vec3  uSunRadiance;   // linear, already scaled by intensity
uniform vec3  uWarmTint;      // warm-neutral push applied to the lit dust

uniform float uHazeDensity;   // aerosol extinction at sea level, per metre
uniform float uHazeFalloff;   // 1 / aerosol scale height
uniform float uMistDensity;   // local dust extinction at sea level, per metre
uniform float uMistFalloff;   // 1 / dust scale height
uniform float uMistDist;      // extent of the dust layer
uniform float uFarMax;        // hard cap on tEnd
uniform float uShaft;
uniform float uAmbient;
uniform float uAerial;        // 1 = this pass owns aerial perspective on surfaces
uniform float uNoiseAmp;
uniform float uNoiseScale;
uniform vec3  uNoiseOfs;
uniform float uG1, uG2, uLobeMix;
uniform float uCloudAtten;
uniform float uStepExp;       // 1 = exponential step spacing, 0 = the old quadratic bias

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
${CLASSIFY_GLSL}
${SKYJ_GLSL}

/** Henyey-Greenstein, normalised over the sphere (the 1/4pi is in the constant). */
float hg(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

/** Interleaved gradient noise. No frame term — see the header. */
float ign(vec2 p){
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Extinction at a point, split by species. x = total, y = dust fraction of the total.
 *  'hazeOn' is 0 on sky pixels: the aerosol species is already inside sky.js's integral
 *  to infinity and integrating it again in front of the sky is the double-count the
 *  ownership rule exists to forbid. */
vec2 densityAt(vec3 p, float t, float hazeOn){
  float h = max(p.y, 0.0);

  float mist = uMistDensity * exp(-h * uMistFalloff);
  if (uNoiseAmp > 0.001) {
    vec3 q = p * uNoiseScale + uNoiseOfs;
    float f = vnoise3(q) * 0.66 + vnoise3(q * 2.71 + 11.3) * 0.34;
    // mean of f is ~0.5, so this stays energy neutral as uNoiseAmp rises
    mist *= mix(1.0, 0.30 + 1.40 * f, uNoiseAmp);
  }
  // Finite layer: taper the last third rather than ending it on a step.
  mist *= 1.0 - smoothstep(uMistDist * 0.62, uMistDist, t);

  float haze = uHazeDensity * exp(-h * uHazeFalloff) * hazeOn;

  // y is the dust density as a fraction of its sea-level peak, which is what the warm
  // tint tracks: the tint belongs to the dust, and it must fade with the dust as the ray
  // climbs out of the layer. (Using mist/(mist+haze) instead would leave sky rays fully
  // tinted at every height, because they carry no haze at all.)
  return vec2(mist + haze, clamp(mist / max(uMistDensity, 1e-9), 0.0, 1.0));
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
  vec3 dir = rayDir(ndc);

  // The depth textures are NearestFilter, so this picks one representative full-resolution
  // texel per low-resolution pixel. The upsample reproduces the same mapping to build its
  // weights, which is what keeps the two passes agreeing on where the silhouettes are.
  vec2 cd = fogClassify(vUv);

  // The viewmodel sits inside the near plane. There is no participating medium in front of
  // it, so there is nothing to integrate: identity transmittance, zero in-scatter.
  if (cd.x > 1.5) { oCol = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float isGeo = cd.x > 0.5 ? 1.0 : 0.0;
  // A surface gets the real distance. The sky gets the extent of the dust layer, which is
  // the only species it is entitled to.
  float tEnd = isGeo > 0.5 ? min(cd.y, uFarMax) : uMistDist;

  // 'uAerial' is the whole ownership decision in one number. At 1 an opaque pixel gets
  // extinction, the ambient lobe and the aerosol species from this pass and wmAerial is
  // zeroed on the JS side; at 0 none of those, and wmAerial is left running — the Wave-G
  // arrangement, in the same build, for A/B.
  float geoW = mix(1.0, uAerial, isGeo);

  float cosT = dot(dir, uSunDir);
  float phase = mix(hg(cosT, uG2), hg(cosT, uG1), uLobeMix);

  vec3 ambDir  = skyJ(dir) * uAmbient * geoW;
  vec3 sunTerm = uSunRadiance * phase * uShaft * uCloudAtten;

  float jitter = ign(gl_FragCoord.xy);

  float T = 1.0;
  vec3  L = vec3(0.0);
  float tPrev = 0.0;

  // Exponential (constant-ratio) step spacing — see the header. tNear is the first
  // sample's distance; 'grow' is the fixed ratio between consecutive samples, so the
  // sampling rate is constant in log-distance and the near field is resolved to
  // sub-metre no matter how far away tEnd is.
  float tNear = min(0.5, tEnd * 0.02);
  float grow  = pow(tEnd / max(tNear, 1e-3), 1.0 / float(STEPS));
  float tExp  = tNear * pow(grow, jitter);

  for (int i = 0; i < STEPS; i++) {
    float u = (float(i) + jitter) / float(STEPS);
    float t = uStepExp > 0.5 ? tExp : tEnd * (0.25 * u + 0.75 * u * u);
    tExp *= grow;
    float dt = t - tPrev;
    tPrev = t;
    if (dt <= 0.0) continue;

    vec3 p = uCamPos + dir * t;

    vec2 dn = densityAt(p, t, isGeo * geoW);
    float sig = dn.x;
    if (sig < 1e-9) continue;

    float a = 1.0 - exp(-sig * dt);

    // The warm push is strongest in the dust, which is where the reference's
    // under-bridge haze sits, and it applies to the SUN lobe only. Warm-tinting the
    // ambient lobe as well tinted the open sky: differenced against a fog-free frame the
    // pass was adding (+17,+12,+3) codes to the upper sky, i.e. a visibly yellow veil,
    // which is the wrong direction on every axis (ref sky lab_b is -15.07). The ambient
    // lobe's colour is the sky's own radiance by construction and must not be re-tinted
    // on the way in, or distant geometry stops matching the sky it dissolves into. Lit
    // dust is warm because the *sunlight* through it is warm — that is the sun lobe.
    vec3 warm = mix(vec3(1.0), uWarmTint, dn.y);
    vec3 inscatter = ambDir + sunTerm * sunVis(p) * warm;

    L += T * a * inscatter;
    T *= 1.0 - a;
    if (T < 0.008) break;
  }

  // Extinction follows the ambient lobe: a surface whose in-scatter is owned elsewhere
  // must have its extinction owned there too, or the fog darkens it without ever putting
  // the scattered energy back and the frame just loses light (measured: -4.3 lum_mean
  // when the ambient term alone was zeroed).
  oCol = vec4(L, mix(1.0, T, geoW));
}
`;

/* ------------------------------------------------------ upsample + composite */

const COMPOSITE_FRAG = /* glsl */`
in vec2 vUv;

uniform sampler2D tSrc;
uniform sampler2D tFog;

uniform vec2  uLowRes;
uniform vec2  uInvLowRes;
uniform float uNear, uFar;
uniform float uDebug;
uniform float uDbgScale;

out vec4 oCol;

${CLASSIFY_GLSL}
${SKYJ_GLSL}

float linZ(float d){
  float n = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - n * (uFar - uNear), 1e-6);
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;

  vec2 cd = fogClassify(vUv);

  // --- measurement hooks --------------------------------------------------------------
  // These exist because the classification is the thing most likely to be silently wrong,
  // and it is invisible in a finished frame. 1: is the sea classified as world when the
  // sea plane is off? 2: how far away is the horizon really, i.e. is uFarMax binding?
  // 3: the J identity — paint skyJ() over the sky and diff against the same capture with
  // uDebug=0. If J is the sky radiance the two frames are the same image, and that is
  // what earns uAmbient = 1.
  if (uDebug > 0.5) {
    if (uDebug < 1.5) {
      vec3 k = cd.x < 0.5 ? vec3(0.0, 1.0, 0.0) : (cd.x < 1.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0));
      oCol = vec4(k * 0.5, 1.0); return;
    }
    if (uDebug < 2.5) {
      oCol = vec4(vec3(cd.y < 0.0 ? 0.0 : clamp(cd.y / max(uDbgScale, 1.0), 0.0, 1.0)), 1.0); return;
    }
    if (cd.x < 0.5) { oCol = vec4(skyJ(rayDir(vUv * 2.0 - 1.0)), 1.0); return; }
    oCol = vec4(src, 1.0); return;
  }

  // --- class-aware 4-tap upsample -----------------------------------------------------
  //
  // A plain bilinear tap set blends across the sky/surface boundary, where the low
  // resolution buffer jumps by ~100 code values inside one 4x4 block; that showed up as
  // hard quarter-resolution bars up to +108 codes along the dune grass. Weighting by the
  // march's own classification uses exactly the discontinuity that matters, and depth is
  // now a real secondary weight for surface-to-surface silhouettes (before the Wave-H
  // depth fix it was the viewmodel and nothing else, so every weight was ~1 and the
  // 'bilateral' was plain bilinear).
  float gc = cd.x;
  float zc = linZ(texture(tDepth, vUv).r);

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

    float zerr = abs(zi - zc);
    float gerr = abs(fogClassify(uvL).x - gc);
    float err = zerr + gerr * 1e4;          // a class mismatch always outranks depth
    if (err < bestErr) { bestErr = err; bestTap = s; }

    float w = bw * exp(-zerr / tol) * mix(1.0, 1e-4, min(gerr, 1.0));
    acc += s * w;
    wsum += w;
  }

  // Every tap disagrees with this pixel (a one-pixel-wide silhouette, a thin mast):
  // take the closest one rather than a meaningless average.
  vec4 fog = (wsum > 1e-4) ? acc / wsum : bestTap;

  oCol = vec4(src * clamp(fog.a, 0.0, 1.0) + max(fog.rgb, vec3(0.0)), 1.0);
}
`;

/** Elevation (sin of the angle) the horizon radiance ring is sampled at. Shared by the
 *  CPU sampler and by skyJ()'s interpolation anchor — they must agree or the function
 *  does not reproduce its own samples. */
const HORIZON_EL = 0.052;

export function create(opts = {}) {
  const p = new Pass('volumetricFog');

  const cfg = Object.assign({
    resScale: 0.25,
    steps: 40,
    // Aerosol: the aerial-perspective species. research/aerial.md 2.5 — beta_ex 5e-4 to
    // 8e-4 per metre gives "distant stacks dissolve at ~1.5 km, foreground crisp".
    // Koschmieder V = 3.912/5.5e-4 = 7.1 km. Tune within [0.0004, 0.0009].
    density: 0.00055,
    hazeHeight: 1200.0,   // Mie scale height, Bruneton demo.cc / Hillaire Table 1
    // Local dust: the shaft medium, as a fraction of the aerosol coefficient. Total
    // extinction near the ground is therefore 9.35e-4 per metre, V = 4.2 km.
    mistRatio: 0.70,
    height: 24.0,
    maxDist: 460.0,       // extent of the DUST layer only
    farMax: 6000.0,       // hard cap on a surface distance; the far plane is 12000
    shafts: 0.25,
    // Not a look knob. See "The constants that were re-derived" in the header: the
    // ambient lobe is a no-op on the sky and a seamless join at infinity only at 1.0.
    ambient: 1.0,
    // 1 = this pass owns aerial perspective on opaque surfaces and zeroes wmAerial.
    // 0 = the Wave-G split (wmAerial owns surfaces, this pass owns sky + shafts).
    aerial: 1.0,
    // Terminate the march at the ocean plane. Water renders with depthWrite:false, so it
    // is in no depth buffer at any point in the frame, and without this every sea pixel
    // is marched as sky.
    seaPlane: true,
    noise: 0.55,
    noiseScale: 1 / 46.0,
    warmth: 1.0,
    // Two-term Henyey-Greenstein: a hard forward peak plus a small backscatter lobe.
    // The first cut used 'mix(isotropic, HG(0.76), 0.55)', i.e. a 45%-weight isotropic
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
    stepExp: true,
  }, opts.volumetricFog || {});

  let marchMat = null, marchQuad = null;
  let compMat = null, compQuad = null;
  let fogRT = null;
  let W = 0, H = 0, LW = 0, LH = 0;

  // materialCommon's own default for uAerialDensity, latched on the first frame so that
  // ownership can be handed back. See ownAerial().
  let aerialOrig = null;

  const invVP = new THREE.Matrix4();
  const identity = new THREE.Matrix4();
  const cascMats = [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
  const _sky = new THREE.Color();
  const _hs = new THREE.Color();
  const _hd = new THREE.Color();
  const _ha = new THREE.Color();
  const _sun = new THREE.Color();

  // Uniform names shared by both programs, mirrored march -> composite once per frame.
  // Split by kind on purpose: THREE.Texture also has a .copy(), so a single "copy if it
  // can" loop would deep-copy a depth texture into a null and throw.
  const SHARED_SCALAR = ['tDepth', 'tViewDepth', 'uHasViewDepth', 'uSeaLevel', 'uSeaEnable'];
  const SHARED_OBJ = ['uInvVP', 'uCamPos', 'uAmbSky', 'uAmbHorSun', 'uAmbHorSide',
    'uAmbHorAnti', 'uAmbGround', 'uSunAz'];

  const classifyUniforms = () => ({
    tDepth: { value: null },
    tViewDepth: { value: null },
    uHasViewDepth: { value: 0 },
    uInvVP: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uSeaLevel: { value: 0 },
    uSeaEnable: { value: 1 },
  });

  const skyJUniforms = () => ({
    uAmbSky: { value: new THREE.Vector3(0.4, 0.5, 0.7) },
    uAmbHorSun: { value: new THREE.Vector3(0.5, 0.5, 0.6) },
    uAmbHorSide: { value: new THREE.Vector3(0.45, 0.5, 0.65) },
    uAmbHorAnti: { value: new THREE.Vector3(0.4, 0.47, 0.65) },
    uAmbGround: { value: new THREE.Vector3(0.4, 0.38, 0.33) },
    uSunAz: { value: new THREE.Vector2(0, -1) },
    uHorizonEl: { value: HORIZON_EL },
  });

  p.init = (ctx, pipe) => {
    marchMat = fsMaterial(MARCH_FRAG, Object.assign(classifyUniforms(), skyJUniforms(), {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRadiance: { value: new THREE.Vector3(1, 1, 1) },
      uWarmTint: { value: new THREE.Vector3(1, 1, 1) },
      uHazeDensity: { value: cfg.density },
      uHazeFalloff: { value: 1 / cfg.hazeHeight },
      uMistDensity: { value: cfg.density * cfg.mistRatio },
      uMistFalloff: { value: 1 / cfg.height },
      uMistDist: { value: cfg.maxDist },
      uFarMax: { value: cfg.farMax },
      uShaft: { value: cfg.shafts },
      uAmbient: { value: cfg.ambient },
      uAerial: { value: cfg.aerial },
      uNoiseAmp: { value: cfg.noise },
      uNoiseScale: { value: cfg.noiseScale },
      uNoiseOfs: { value: new THREE.Vector3() },
      uG1: { value: cfg.g1 },
      uG2: { value: cfg.g2 },
      uLobeMix: { value: cfg.lobeMix },
      uCloudAtten: { value: 1 },
      uStepExp: { value: cfg.stepExp ? 1 : 0 },
      uNumCasc: { value: 0 },
      uCascMat: { value: cascMats },
      uCasc0: { value: null },
      uCasc1: { value: null },
      uCasc2: { value: null },
      uCasc3: { value: null },
      uShadowBias: { value: cfg.shadowBias },
    }), { STEPS: Math.max(8, cfg.steps | 0) });
    marchMat.blending = THREE.NoBlending;
    marchQuad = new FullScreenQuad(marchMat);

    compMat = fsMaterial(COMPOSITE_FRAG, Object.assign(classifyUniforms(), skyJUniforms(), {
      tSrc: { value: null },
      tFog: { value: null },
      uLowRes: { value: new THREE.Vector2(1, 1) },
      uInvLowRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.06 },
      uFar: { value: 12000 },
      uDebug: { value: 0 },
      uDbgScale: { value: 1000 },
    }));
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

  /**
   * Take exclusive ownership of aerial perspective by zeroing `wmAerial`.
   *
   * `sharedAerialUniforms()` is the process-wide uniform block that every world material
   * and `ocean.js` alias, so one write switches the per-surface term off everywhere
   * without this file editing `materialCommon.js` or `ocean.js`.
   *
   * Two rules make it safe:
   *
   * - **A `--config aerialDensity=...` override always wins.** `updateAerialUniforms()`
   *   pushes that key into the block every frame, from `lighting.prerender`, i.e. before
   *   any post pass; so if the key is set at all, this pass stands down and lets it
   *   through. `--config aerialDensity=0.0062` is therefore a clean way to force the
   *   per-surface term back on regardless of what this pass wants.
   * - **It is reversible.** The block's own default is latched on the first frame and
   *   written back when `fogAerial` goes to 0, so the A/B knob restores the previous
   *   arrangement instead of leaving `wmAerial` stuck at zero.
   *
   * That second rule was added because the first version of this wrote
   * `ctx.config.aerialDensity = 0` and could not undo it: the engine renders a frame
   * before `--config` is applied, so the pass had already claimed the key by the time
   * `fogAerial=0` arrived, and the A/B arm that was supposed to restore `wmAerial`
   * silently measured a build with `wmAerial` still off (`aer0` came out at `sat_mean`
   * 69.50 where the Wave-G arrangement measures 53.54). The arm that disagreed with its
   * own prediction is what found it.
   */
  const ownAerial = (ctx, want) => {
    let u = null;
    try { u = sharedAerialUniforms(); } catch { return; }
    if (!u || !u.uAerialDensity) return;
    if (aerialOrig === null) aerialOrig = u.uAerialDensity.value;
    if ((ctx.config || {}).aerialDensity !== undefined) return;   // an override owns it
    u.uAerialDensity.value = want ? 0 : aerialOrig;
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
    // 'sunIntensity' is a three.js DirectionalLight intensity, and the sky module's
    // radiance is in its own atmosphere units with its own solarIrradiance. The two are
    // not on a common scale, so the physically-correct 'phase * irradiance' comes out
    // roughly an order of magnitude hot against the sky this engine actually draws.
    // 'fogShafts' absorbs that; it is a calibration constant, not a look knob, and it
    // should be revisited if anyone ever reconciles the two unit systems.
    u.uSunRadiance.value.set(_sun.r, _sun.g, _sun.b);

    // The equilibrium in-scatter J of this layer IS the sky radiance in the view
    // direction (research/aerial.md 1.3), so it is sampled from the sky module rather
    // than authored — four directions, reconstructed per pixel by skyJ(). sky.radiance()
    // is a CPU read of the sky's own LUT, so four of them per frame is free.
    const sd = u.uSunDir.value;
    const azLen = Math.hypot(sd.x, sd.z) || 1;
    const ax = sd.x / azLen, az = sd.z / azLen;
    u.uSunAz.value.set(ax, az);

    // A hair above the horizon: exactly on it the ray grazes the ground sphere and the
    // march returns the terminated-early value.
    const EL = HORIZON_EL, C = Math.sqrt(1 - EL * EL);
    let ok = false;
    if (sky?.radiance && sky?.zenithRadiance) {
      try {
        sky.zenithRadiance(_sky);
        sky.radiance({ x: ax * C, y: EL, z: az * C }, _hs);
        sky.radiance({ x: -az * C, y: EL, z: ax * C }, _hd);
        sky.radiance({ x: -ax * C, y: EL, z: -az * C }, _ha);
        ok = [_sky, _hs, _hd, _ha].every((c) => Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b))
          && (_sky.r + _sky.g + _sky.b) > 1e-5;
      } catch { ok = false; }
    }
    if (!ok) {
      const s = time ? time.skyColor : { r: 0.36, g: 0.56, b: 0.94 };
      _sky.setRGB(s.r * 2.0, s.g * 2.0, s.b * 2.0);
      _hs.setRGB(s.r * 2.4, s.g * 2.2, s.b * 2.0);
      _hd.setRGB(s.r * 1.9, s.g * 1.9, s.b * 1.9);
      _ha.setRGB(s.r * 1.7, s.g * 1.8, s.b * 1.9);
    }
    u.uAmbSky.value.set(_sky.r, _sky.g, _sky.b);
    u.uAmbHorSun.value.set(_hs.r, _hs.g, _hs.b);
    u.uAmbHorSide.value.set(_hd.r, _hd.g, _hd.b);
    u.uAmbHorAnti.value.set(_ha.r, _ha.g, _ha.b);

    // Below the horizon the layer is lit from underneath by the sand, which is the one
    // warm region in the whole reference (TARGETS: 'sand' lab_b +2.83 against 'sky' -15).
    // Averaged over the horizon ring so it does not inherit the circumsolar band alone.
    const hr = (_hs.r + _hd.r * 2 + _ha.r) * 0.25;
    const hg = (_hs.g + _hd.g * 2 + _ha.g) * 0.25;
    const hb = (_hs.b + _hd.b * 2 + _ha.b) * 0.25;
    const warmBounce = 0.20;
    u.uAmbGround.value.set(
      hr * (1.0 + warmBounce * 1.35),
      hg * (1.0 + warmBounce * 0.95),
      hb * (1.0 + warmBounce * 0.35));
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const c = ctx.config || {};

    if (!fogRT) p.setSize(pipe.w, pipe.h, ctx);

    // Master kill switch. '--config' can only carry numbers and strings — capture.mjs
    // sends `isNaN(+v) ? v : +v` — so `--config fog=false` arrives as the STRING 'false'
    // and a bare `c.fog === false` test never fires. Every `--config fog=false` A/B ever
    // run against this pass therefore measured the shipped build (found here by an arm
    // that came out identical to the default; same class of trap as reports/depth.md 7).
    const enabled = !(c.fog === false || c.fog === 'false' || c.fog === 0 || c.fog === '0');

    // Ownership is claimed BEFORE the kill switch, and released by it: 'fog=false' has to
    // mean "this pass is not here", which includes not having taken aerial perspective
    // away from wmAerial.
    const aerial = THREE.MathUtils.clamp(c.fogAerial ?? cfg.aerial, 0, 1);
    ownAerial(ctx, enabled && aerial > 0);

    // Still has to write 'out'; the chain swaps regardless.
    if (!enabled) { pipe.blit(pipe.read.texture, out); return; }

    const u = marchMat.uniforms;

    // cam.projectionMatrixInverse is the jittered one at post time, which is exactly what
    // unprojects the depth buffer as it was rasterised (same convention as taa.js).
    invVP.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    u.uInvVP.value.copy(invVP);
    u.uCamPos.value.copy(cam.position);
    u.tDepth.value = pipe.depthTex;
    // reports/depth.md 3: viewDepthTex is a MASK, never a distance — its near/far are the
    // viewmodel camera's, not the world's.
    u.tViewDepth.value = pipe.viewDepthTex || null;
    u.uHasViewDepth.value = (u.tViewDepth.value && (c.fogWeaponMask ?? 1)) ? 1 : 0;

    // The ocean plane. 'ocean.level' is the module's own SEA_LEVEL; if the module is
    // absent the plane is switched off rather than guessed, because a wrong plane would
    // truncate the march on every downward ray.
    const ocean = ctx.get('ocean');
    const seaOn = (c.fogSeaPlane ?? cfg.seaPlane) && typeof ocean?.level === 'number';
    u.uSeaEnable.value = seaOn ? 1 : 0;
    u.uSeaLevel.value = seaOn ? ocean.level : 0;

    updateLighting(ctx, u);

    const density = Math.max(c.fogDensity ?? cfg.density, 0);
    u.uHazeDensity.value = density;
    u.uHazeFalloff.value = 1 / Math.max(c.fogHazeHeight ?? cfg.hazeHeight, 1);
    u.uMistDensity.value = density * Math.max(c.fogMistRatio ?? cfg.mistRatio, 0);
    u.uMistFalloff.value = 1 / Math.max(c.fogHeight ?? cfg.height, 0.5);
    u.uMistDist.value = Math.max(c.fogMaxDist ?? cfg.maxDist, 10);
    u.uFarMax.value = Math.max(c.fogFarMax ?? cfg.farMax, 10);
    u.uShaft.value = c.fogShafts ?? cfg.shafts;
    u.uAmbient.value = c.fogAmbient ?? cfg.ambient;
    u.uAerial.value = aerial;
    u.uNoiseAmp.value = THREE.MathUtils.clamp(c.fogNoise ?? cfg.noise, 0, 1);
    u.uStepExp.value = (c.fogStepExp ?? (cfg.stepExp ? 1 : 0)) > 0.5 ? 1 : 0;

    const warmth = c.fogWarmth ?? cfg.warmth;
    u.uWarmTint.value.set(
      1.0 + 0.10 * warmth,
      1.0 + 0.015 * warmth,
      1.0 - 0.11 * warmth);

    // Drift is a pure function of 'ctx.clock.t', never an accumulator.
    //
    // This is not a style preference: the capture daemon reuses ONE page for many
    // captures, and '__HALO__.setTime()' rewinds 'clock.t' before each one. An
    // accumulator that adds 'clock.dt' every frame therefore carries every frame ever
    // rendered by that page into the next capture, and two runs of
    //   capture --pose ref_00000 --settle 48
    // differ in the haze pattern by however much wall time the daemon happened to have
    // been alive. That reproduced as a byte-level diff on the first determinism check
    // here. Reading 'clock.t' — which setTime resets — makes the frame a function of
    // (pose, time, settle) alone, which is the contract.
    //
    // The dust is advected by 'time.wind' at a small fraction of the wind speed: dust in
    // a boundary layer lags the free stream, and a haze bank sliding at the full 5 m/s
    // reads as a moving texture rather than as air.
    const animT = c.frozen ? 0 : (ctx.clock?.t ?? 0);
    const wind = ctx.get('time')?.wind;
    const ns = u.uNoiseScale.value;   // noise-space units per world metre
    const drift = 0.08;               // fraction of the wind the dust actually follows
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
    for (const k of SHARED_SCALAR) cu[k].value = u[k].value;
    for (const k of SHARED_OBJ) cu[k].value.copy(u[k].value);
    cu.tSrc.value = pipe.read.texture;
    cu.tFog.value = fogRT.texture;
    cu.uNear.value = cam.near;
    cu.uFar.value = cam.far;
    cu.uDebug.value = c.fogDebug ?? 0;
    cu.uDbgScale.value = c.fogDbgScale ?? 1000;
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
