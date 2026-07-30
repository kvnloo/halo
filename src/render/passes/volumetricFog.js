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
 * - **Sky and geometry are NOT integrated the same way any more.** They were, and that
 *   was the design; see "Who owns aerial perspective" below for why opaque surfaces now
 *   get only the shaft term, and reports/fog.md 1 for why they cannot get a distance at
 *   all right now.
 * - **Density is capped in distance, not just in height.** `uMaxDist` with a smooth taper
 *   over the last third: this is a local marine/dust layer, not a planetary atmosphere.
 *   The sky module already owns the planetary term and this must not double it.
 *
 * ## THE DEPTH THIS PASS READS IS DESTROYED BEFORE IT RUNS — read reports/fog.md 1
 *
 * scene.js step 7 calls renderer.clearDepth() on pipe.sceneRT, whose depth attachment IS
 * the shared pipe.depthTex. So tDepth contains the weapon viewmodel and nothing else, and
 * every world pixel here read as "sky at 460 m". A rock 4 m away was getting 460 m of
 * haze integrated in front of it. That, not the density tuning, was the near-field wash.
 * Proved by rendering isGeo/tEnd straight out of the march: shots/fog/dbg4.png is a flat
 * field with the gun cut out of it. Until scene.js is fixed this pass takes its geometry
 * test from the G-buffer normal target (a colour attachment, so it survives the clear)
 * and has no distance for opaque pixels at all.
 *
 * ## Who owns aerial perspective — settled by measurement, do not undo casually
 *
 * Aerial perspective is applied per-surface, by the `wmAerial` term that
 * `src/gfx/materialCommon.js` injects into every opaque world material and that
 * `src/world/ocean.js` (line ~1116) applies to the water using the *same shared
 * uniforms*. This pass adds no in-scatter and no extinction to anything that has a
 * surface. It owns exactly two things: the sky, and the shadowed sun in-scatter (the
 * shafts), which an analytic per-surface term cannot produce because it cannot read the
 * shadow cascades.
 *
 * The classification is by pixel, and there are three ways a pixel can turn out to be a
 * surface, because the depth buffer this pass is entitled to has been destroyed (below):
 *
 *   1. `tDepth` — works for the viewmodel only.
 *   2. a non-zero G-buffer normal — works for everything in the opaque pre-pass.
 *   3. **the ray hitting the sea plane** — water is LAYER.TRANSPARENT, so it is in
 *      neither of the above, and every ocean pixel used to be classified as sky and
 *      marched for the full 460 m *on top of* the aerial perspective ocean.js applies
 *      itself. The plane is analytic, so this needs no depth buffer.
 *
 * Measured at ref_00000, three captures back to back (reports/fog.md 4):
 *
 * ```
 *   ref_00000, whole frame     lum_mean   sat_mean   lap_var
 *   before this session           111.4       39.5      204.8
 *   now                           109.7       53.8      296.1
 *   --config fogDensity=0         108.6       55.0      292.4   (the pass switched off)
 *   reference kf_00000            107.8       83.9      463.0
 *
 *   water ROI          sat 29.1 -> 47.1 (off 47.0)   lap 358.8 -> 660.2 (off 629.3)
 *   sand  ROI          sat 38.3 -> 65.8 (off 66.0)
 *   horizon ROI        lum 131.3 -> 131.7            lap 222.6 -> 334.3
 * ```
 *
 * The pass cost 15.5 points of whole-frame sat_mean and 87.6 of lap_var. It now costs
 * 1.2 sat and *adds* 3.7 lap_var. Everything left is the shaft term: with
 * `fogShafts=0` the frame lands on the pass-off number to within 0.1 (ref_00120: 53.8
 * against 53.7 off). The ambient lobe is a measured no-op on clear sky, which is the
 * correct limit and not an accident — see skyJ().
 *
 * If a later pass wants the *opposite* split — this pass owning everything, for shadowed
 * aerial perspective across silhouettes — the move is `ctx.config.aerialDensity = 0` plus
 * `fogGeoAmbient = 1`, in one commit, with the horizon ROI re-measured. It cannot be done
 * until the depth buffer survives the frame, because opaque pixels have no distance here.
 * Neither file may edit the other.
 *
 * ## ctx.config knobs
 * ```
 * fog            true      master enable
 * fogDensity     0.00075   extinction at the base height, per metre
 * fogHeight      24.0      e-folding height of the layer, metres
 * fogMaxDist     460.0     end of the layer
 * fogShafts      0.25      scale on the sun in-scatter (the crepuscular term)
 * fogAmbient     0.52      scale on the sky/ground in-scatter (sky pixels)
 * fogGeoAmbient  0.0       fraction of that ambient lobe applied to OPAQUE pixels
 * fogSeaPlane    true      terminate the march at the ocean plane
 * fogNoise       0.55      0 = smooth wash, 1 = fully modulated
 * fogWarmth      1.0       scale on the warm tint pushed into the SUN lobe
 * ```
 */

/* -------------------------------------------------------------------- march */

/**
 * Shared by the march and the composite so the two agree, texel for texel, on how a
 * pixel is classified. The composite's bilateral upsample has to reproduce the march's
 * own classification exactly or it blends across a discontinuity it cannot see — that
 * is where the +108-code streaks at the dune line came from (reports/fog.md 8).
 */
const CLASSIFY_GLSL = /* glsl */`
/** Distance to the sea plane, or -1 if this ray never reaches it. Analytic: the ocean
 *  is a plane at a known y (docs/WORLD.md: sea level is y = 0), so a downward ray has a
 *  distance even though water is LAYER.TRANSPARENT and therefore absent from the
 *  G-buffer pre-pass this pass takes its geometry test from. */
float seaHitDist(vec3 camPos, vec3 dir, float seaLevel, float enable){
  if (enable < 0.5) return -1.0;
  float h = camPos.y - seaLevel;
  if (h <= 0.05 || dir.y > -1e-4) return -1.0;
  return -h / dir.y;
}
`;

const MARCH_FRAG = /* glsl */`
precision highp sampler2DShadow;

in vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tNormal;    // G-buffer MRT0: view normal (xyz) + roughness (w)
uniform float uUseNormalMask; // 1 = trust tNormal for the geometry test, not tDepth
uniform float uGeoMaxDist;    // march length on masked geometry when depth is unusable

uniform mat4  uInvVP;
uniform vec3  uCamPos;
uniform vec3  uSunDir;        // toward the sun
uniform vec3  uSunRadiance;   // linear, already scaled by intensity
// The equilibrium in-scatter radiance J, sampled from the sky module at four directions
// and reconstructed per-pixel. See skyJ() and research/aerial.md 1.3.
uniform vec3  uAmbSky;        // zenith
uniform vec3  uAmbHorSun;     // horizon, sun azimuth
uniform vec3  uAmbHorSide;    // horizon, 90 deg off the sun
uniform vec3  uAmbHorAnti;    // horizon, anti-solar azimuth
uniform vec2  uSunAz;         // normalised (sunDir.xz)
uniform vec3  uAmbGround;     // in-scattered ground bounce, lower hemisphere
uniform vec3  uWarmTint;      // warm-neutral push applied to the dense low layer

uniform float uDensity;
uniform float uHeightFalloff;
uniform float uMaxDist;
uniform float uShaft;
uniform float uAmbient;
uniform float uGeoAmbient;    // scale on the ambient in-scatter for OPAQUE pixels (see header)
uniform float uNoiseAmp;
uniform float uNoiseScale;
uniform vec3  uNoiseOfs;
uniform float uG1, uG2, uLobeMix;
uniform float uCloudAtten;

uniform float uSeaLevel;
uniform float uSeaEnable;

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

/** Henyey-Greenstein, normalised over the sphere (the 1/4pi is in the constant). */
float hg(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

/**
 * The equilibrium in-scatter radiance J in a view direction.
 *
 * research/aerial.md 1.3: set s -> infinity in the single-scattering solution and the
 * radiance tends to J. J is therefore, by identity, *the radiance of an infinitely deep
 * slab of the same medium* — i.e. the sky radiance in that direction. If J is not the
 * colour the sky module paints there, distant geometry does not dissolve into the sky, it
 * is outlined against it, and everything the haze touches drifts toward whatever fixed
 * colour J actually is.
 *
 * The previous form was mix(ground, 0.72*zenith + 0.28*horizonTowardSun, y*0.5+0.5). The
 * 0.28 put more than a quarter of the bright, nearly achromatic circumsolar band into the
 * *zenith* — the one direction it is most wrong for — so the haze desaturated the top of
 * the sky by construction. Reconstructing from four real sky samples costs 4 CPU
 * cpuRadiance() calls per frame (14 steps each) and 5 shader ALU ops.
 */
vec3 skyJ(vec3 d){
  vec2 dh = vec2(d.x, d.z);
  float lh = length(dh);
  float a = lh > 1e-5 ? dot(dh / lh, uSunAz) : 0.0;    // -1 anti-solar .. +1 toward sun
  vec3 H = a >= 0.0 ? mix(uAmbHorSide, uAmbHorSun, a) : mix(uAmbHorSide, uAmbHorAnti, -a);
  // sqrt in elevation, not linear: the horizon band is thin in angle and the gradient to
  // the zenith is steep near it. Linear leaves the whole lower sky reading as zenith blue.
  float el = clamp(d.y, -1.0, 1.0);
  return el >= 0.0 ? mix(H, uAmbSky, sqrt(el)) : mix(H, uAmbGround, sqrt(-el));
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
  float isGeo = 0.0;
  if (dz < 0.999999) {
    vec4 wp4 = uInvVP * vec4(ndc, dz * 2.0 - 1.0, 1.0);
    tEnd = min(length(wp4.xyz / wp4.w - uCamPos), uMaxDist);
    isGeo = 1.0;
  }

  // See reports/fog.md 1. scene.js clears the shared depth attachment before drawing the
  // viewmodel, so tDepth contains ONLY the viewmodel and every world pixel reads as sky.
  // The G-buffer normal target survives that clear (it is a colour attachment), and its
  // pre-pass clear is (0,0,0,0), so a non-zero normal is an exact opaque-geometry test.
  // It carries no distance, hence uGeoMaxDist below. Delete this whole block, and set
  // uUseNormalMask to 0, the day depth survives the frame.
  // The viewmodel is the one thing tDepth still has, and it is NOT in the G-buffer
  // pre-pass, so the mask must only ever add geometry, never take it away.
  if (uUseNormalMask > 0.5 && isGeo < 0.5) {
    if (length(texture(tNormal, vUv).xyz) > 0.1) {
      isGeo = 1.0;
      tEnd = min(uGeoMaxDist, uMaxDist);
    }
  }

  // Water is LAYER.TRANSPARENT, so it is in neither the G-buffer pre-pass nor (thanks to
  // the clearDepth) tDepth — every ocean pixel was classified as SKY and had the whole
  // 460 m layer integrated in front of it. src/world/ocean.js line 1116 already applies
  // its own copy of wmAerial to the water surface using the *same shared uniforms* as
  // materialCommon, so that was the identical double-count this pass was fixed for on
  // opaque surfaces, still live over the entire sea. The plane is analytic (sea level is
  // a constant), so the distance is exact and needs no depth buffer.
  float tSea = seaHitDist(uCamPos, dir, uSeaLevel, uSeaEnable);
  if (tSea > 0.0 && tSea < tEnd) { tEnd = tSea; isGeo = 1.0; }

  // Aerial perspective on opaque surfaces belongs to materialCommon's wmAerial, which
  // already runs per-surface with its own extinction AND its own in-scatter. Applying the
  // ambient lobe here as well double-counts it, and because this pass is additive the
  // second copy lands as a bright achromatic floor on surfaces a few metres away. So on
  // opaque pixels the ambient lobe (and the matching extinction) is scaled by
  // uGeoAmbient, which is 0 by default: this pass keeps only the shadowed sun term,
  // i.e. the shafts, which is the thing an analytic per-surface term cannot do.
  // On sky pixels (isGeo = 0) nothing changes — wmAerial never touches the sky, so the
  // horizon haze is still integrated here at full strength.
  float geoW = mix(1.0, uGeoAmbient, isGeo);

  float cosT = dot(dir, uSunDir);
  float phase = mix(hg(cosT, uG2), hg(cosT, uG1), uLobeMix);

  vec3 ambDir = skyJ(dir) * uAmbient * geoW;
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
    // reference's under-bridge dust sits.
    //
    // It applies to the SUN lobe only. Warm-tinting the ambient lobe as well tinted the
    // open sky: differenced against fogDensity=0 the pass was adding (+17,+12,+3) codes
    // to the upper sky, i.e. a visibly yellow veil, which is the wrong direction on every
    // axis (ref sky lab_b is -15.07, ours -6.9). The ambient lobe's colour is the sky's
    // own radiance by construction (research/aerial.md 1.3: the equilibrium in-scatter of
    // an optically deep slab IS the sky radiance in the view direction) and it must not
    // be re-tinted on the way in, or distant geometry stops matching the sky it dissolves
    // into. Lit dust is warm because the *sunlight* through it is warm — that is the sun
    // lobe, and that is where the tint belongs.
    vec3 warm = mix(vec3(1.0), uWarmTint, clamp(sig / max(uDensity, 1e-6), 0.0, 1.0));
    vec3 inscatter = ambDir + sunTerm * sunVis(p) * warm;

    L += T * a * inscatter;
    T *= 1.0 - a;
    if (T < 0.008) break;
  }

  // Extinction follows the ambient lobe: a surface whose in-scatter wmAerial owns must
  // have its extinction owned by wmAerial too, or the fog darkens it without ever
  // putting the scattered energy back and the frame just loses light (measured: -4.3
  // lum_mean when the ambient term alone was zeroed).
  oCol = vec4(L, mix(1.0, T, geoW));
}
`;

/* ------------------------------------------------------ upsample + composite */

const COMPOSITE_FRAG = /* glsl */`
in vec2 vUv;

uniform sampler2D tSrc;
uniform sampler2D tFog;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform float uUseNormalMask;

uniform mat4  uInvVP;
uniform vec3  uCamPos;
uniform float uSeaLevel;
uniform float uSeaEnable;

uniform vec2  uLowRes;
uniform vec2  uInvLowRes;
uniform float uNear, uFar;

out vec4 oCol;

${CLASSIFY_GLSL}

float linZ(float d){
  float n = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - n * (uFar - uNear), 1e-6);
}

/**
 * The march's own classification of a pixel, reproduced exactly.
 *
 * 0 = sky (the whole layer is integrated), 1 = a surface (only the shaft term is).
 * The two classes differ by ~100 code values at the horizon, so an upsample that cannot
 * tell them apart blends across the boundary and lays a quarter-resolution bar over it.
 */
float classify(vec2 uv){
  float dz = texture(tDepth, uv).r;
  if (dz < 0.999999) return 1.0;
  if (uUseNormalMask > 0.5 && length(texture(tNormal, uv).xyz) > 0.1) return 1.0;
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 fp4 = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(fp4.xyz / fp4.w - uCamPos);
  return seaHitDist(uCamPos, dir, uSeaLevel, uSeaEnable) > 0.0 ? 1.0 : 0.0;
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;

  // Bilateral 4-tap.
  //
  // This used to weight taps by |linZ(tDepth[tap]) - linZ(tDepth[here])|. That texture
  // holds only the viewmodel (reports/fog.md 1), so every world pixel reads as the far
  // plane, every err was ~0, every weight was ~1, and the "bilateral" filter was a
  // plain bilinear one. Differenced against fogDensity=0 that showed up as hard
  // quarter-resolution vertical bars up to +108 code values along the dune grass, where
  // the low-resolution buffer jumps from "sky, 460 m of haze" to "surface, shafts only"
  // inside one 4x4 block. Weighting by the march's own sky/surface classification instead
  // uses a signal that survives the clear, and is exactly the discontinuity that matters.
  // The depth term is kept as a secondary weight because depth IS valid for the
  // viewmodel, which is the one thing still in that buffer.
  float gc = classify(vUv);
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
    float gerr = abs(classify(uvL) - gc);
    float err = zerr + gerr * 1e4;          // a class mismatch always outranks depth
    if (err < bestErr) { bestErr = err; bestTap = s; }

    float w = bw * exp(-zerr / tol) * mix(1.0, 1e-4, gerr);
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
    // Ambient in-scatter applied to OPAQUE pixels, as a fraction. 0 = materialCommon's
    // `wmAerial` is the sole owner of aerial perspective on surfaces and this pass owns
    // only the shafts + the sky. See the "Who owns aerial perspective" note above.
    geoAmbient: 0.0,
    // See reports/fog.md 1 and the header. Both of these exist only because pipe.depthTex
    // is destroyed before this pass runs.
    useNormalMask: true,
    geoMaxDist: 60.0,
    // Terminate the march at the ocean plane. Water is transparent, so it is in neither
    // the G-buffer nor the (destroyed) depth buffer, and without this every sea pixel is
    // marched as sky on top of the aerial perspective ocean.js applies itself.
    seaPlane: true,
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

  const invVP = new THREE.Matrix4();
  const identity = new THREE.Matrix4();
  const cascMats = [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
  const _sky = new THREE.Color();
  const _hs = new THREE.Color();
  const _hd = new THREE.Color();
  const _ha = new THREE.Color();
  const _sun = new THREE.Color();

  p.init = (ctx, pipe) => {
    marchMat = fsMaterial(MARCH_FRAG, {
      tDepth: { value: null },
      tNormal: { value: null },
      uUseNormalMask: { value: cfg.useNormalMask ? 1 : 0 },
      uGeoMaxDist: { value: cfg.geoMaxDist },
      uInvVP: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRadiance: { value: new THREE.Vector3(1, 1, 1) },
      uAmbSky: { value: new THREE.Vector3(0.4, 0.5, 0.7) },
      uAmbHorSun: { value: new THREE.Vector3(0.5, 0.5, 0.6) },
      uAmbHorSide: { value: new THREE.Vector3(0.45, 0.5, 0.65) },
      uAmbHorAnti: { value: new THREE.Vector3(0.4, 0.47, 0.65) },
      uSunAz: { value: new THREE.Vector2(0, -1) },
      uAmbGround: { value: new THREE.Vector3(0.4, 0.38, 0.33) },
      uWarmTint: { value: new THREE.Vector3(1, 1, 1) },
      uDensity: { value: cfg.density },
      uHeightFalloff: { value: 1 / cfg.height },
      uMaxDist: { value: cfg.maxDist },
      uShaft: { value: cfg.shafts },
      uAmbient: { value: cfg.ambient },
      uGeoAmbient: { value: cfg.geoAmbient },
      uNoiseAmp: { value: cfg.noise },
      uNoiseScale: { value: cfg.noiseScale },
      uNoiseOfs: { value: new THREE.Vector3() },
      uG1: { value: cfg.g1 },
      uG2: { value: cfg.g2 },
      uLobeMix: { value: cfg.lobeMix },
      uCloudAtten: { value: 1 },
      uSeaLevel: { value: 0 },
      uSeaEnable: { value: 1 },
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
      tNormal: { value: null },
      uUseNormalMask: { value: cfg.useNormalMask ? 1 : 0 },
      uInvVP: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uSeaLevel: { value: 0 },
      uSeaEnable: { value: 1 },
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

    // The equilibrium in-scatter J of this layer IS the sky radiance in the view
    // direction (research/aerial.md 1.3), so it is sampled from the sky module rather
    // than authored — four directions, reconstructed per pixel by skyJ(). `sky.radiance()`
    // is a 14-step CPU march, so four of them per frame is free.
    const sd = u.uSunDir.value;
    const azLen = Math.hypot(sd.x, sd.z) || 1;
    const ax = sd.x / azLen, az = sd.z / azLen;
    u.uSunAz.value.set(ax, az);

    // A hair above the horizon: exactly on it the ray grazes the ground sphere and the
    // march returns the terminated-early value.
    const EL = 0.052, C = Math.sqrt(1 - EL * EL);
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
    // warm region in the whole reference (TARGETS: `sand` lab_b +2.83 against `sky` -15).
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

    // Master kill switch — still has to write `out`, the chain swaps regardless.
    if (c.fog === false) { pipe.blit(pipe.read.texture, out); return; }

    const u = marchMat.uniforms;

    // cam.projectionMatrixInverse is the jittered one at post time, which is exactly what
    // unprojects the depth buffer as it was rasterised (same convention as taa.js).
    invVP.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    u.uInvVP.value.copy(invVP);
    u.uCamPos.value.copy(cam.position);
    u.tDepth.value = pipe.depthTex;
    u.tNormal.value = pipe.gbuffer?.textures?.[0] || null;
    u.uUseNormalMask.value = (u.tNormal.value && (c.fogNormalMask ?? cfg.useNormalMask)) ? 1 : 0;
    u.uGeoMaxDist.value = Math.max(c.fogGeoMaxDist ?? cfg.geoMaxDist, 1);

    // The ocean plane. `ocean.level` is the module's own SEA_LEVEL; if the module is
    // absent the plane is switched off rather than guessed, because a wrong plane would
    // truncate the march on every downward ray.
    const ocean = ctx.get('ocean');
    const seaOn = (c.fogSeaPlane ?? cfg.seaPlane) && typeof ocean?.level === 'number';
    u.uSeaEnable.value = seaOn ? 1 : 0;
    u.uSeaLevel.value = seaOn ? ocean.level : 0;

    updateLighting(ctx, u);

    u.uDensity.value = c.fogDensity ?? cfg.density;
    u.uHeightFalloff.value = 1 / Math.max(c.fogHeight ?? cfg.height, 0.5);
    u.uMaxDist.value = Math.max(c.fogMaxDist ?? cfg.maxDist, 10);
    u.uShaft.value = c.fogShafts ?? cfg.shafts;
    u.uAmbient.value = c.fogAmbient ?? cfg.ambient;
    u.uGeoAmbient.value = THREE.MathUtils.clamp(c.fogGeoAmbient ?? cfg.geoAmbient, 0, 1);
    u.uNoiseAmp.value = THREE.MathUtils.clamp(c.fogNoise ?? cfg.noise, 0, 1);

    const warmth = c.fogWarmth ?? cfg.warmth;
    u.uWarmTint.value.set(
      1.0 + 0.10 * warmth,
      1.0 + 0.015 * warmth,
      1.0 - 0.11 * warmth);

    // Drift is a pure function of `ctx.clock.t`, never an accumulator.
    //
    // This is not a style preference: the capture daemon reuses ONE page for many
    // captures, and `__HALO__.setTime()` rewinds `clock.t` before each one. An
    // accumulator that adds `clock.dt` every frame therefore carries every frame ever
    // rendered by that page into the next capture, and two runs of
    //   capture --pose ref_00000 --settle 48
    // differ in the haze pattern by however much wall time the daemon happened to have
    // been alive. That reproduced as a byte-level diff on the first determinism check
    // here. Reading `clock.t` — which setTime resets — makes the frame a function of
    // (pose, time, settle) alone, which is the contract.
    //
    // The haze is advected by `time.wind` at a small fraction of the wind speed: dust in
    // a boundary layer lags the free stream, and a haze bank sliding at the full 5 m/s
    // reads as a moving texture rather than as air.
    const animT = c.frozen ? 0 : (ctx.clock?.t ?? 0);
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
    cu.tNormal.value = u.tNormal.value;
    cu.uUseNormalMask.value = u.uUseNormalMask.value;
    cu.uInvVP.value.copy(invVP);
    cu.uCamPos.value.copy(cam.position);
    cu.uSeaLevel.value = u.uSeaLevel.value;
    cu.uSeaEnable.value = u.uSeaEnable.value;
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
