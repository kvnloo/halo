import * as THREE from 'three';
import { NOISE_GLSL } from '../gfx/glsl/noise.js';
import { fsMaterial, FullScreenQuad, makeRT } from '../render/RenderPipeline.js';

/**
 * 'clouds' — raymarched volumetric cumulus, Nubis / Horizon-Zero-Dawn style.
 *
 * The reference clip's sky is not a gradient: it is a cumulus congestus deck whose
 * sunlit cauliflower tops sit near clipping (230-250 codes) against shadowed bases at
 * 150-180, over a deep blue field. That spread is where the 'sky' region's lum_std 45
 * and lap_var 253 come from, and no amount of atmosphere tuning produces it. This
 * module supplies it.
 *
 * ------------------------------------------------------------------ modelling
 *
 *   tBase    128^3 RGBA8   r = Perlin-Worley (billow-dilated periodic Perlin)
 *                          gba = Worley FBM at 3 rising frequencies
 *   tDetail   32^3 RGBA8   Worley FBM octaves used to erode the silhouette
 *   tWeather 512^2 RGBA8   r = coverage, g = cloud type, ba = curl vector
 *
 * All three are rendered on the GPU at init and all three tile seamlessly — the
 * 3D pair through 'worley3Tiled()' from the shared noise library plus a periodic
 * gradient noise built here on the shared 'hash33' (the shared 'gnoise3' is not
 * periodic, and a cloud volume texture that does not tile shows its seams as hard
 * straight edges across the sky).
 *
 * The layer is a spherical shell on the same 6360 km planet the sky module uses, so
 * the deck curves away: near towers (2-8 km) reach 25-40 deg of elevation while the
 * far deck (30-70 km) collapses into the thin bright band that hugs the waterline in
 * kf_01800. That geometry is what makes the horizon read correctly — it is not a
 * separate "distant cloud" hack.
 *
 * Cloud tops are sheared downwind by height fraction (Nubis' cloud_top_offset, 400 m
 * over the layer). Without it every lump is vertically symmetric and the deck reads as
 * extruded columns no matter how good the erosion is.
 *
 * ------------------------------------------------------------------ lighting
 *
 *  - Beer-Lambert extinction at sigma_t = 50 /km at density 1, which is the measured
 *    value for cumulus (Frostbite/Hess 0.05-0.12 /m; 3*LWC/(2*rho_w*r_eff) with maritime
 *    LWC 0.3 g/m3 and r_eff 10 um gives 0.045 /m independently). Mean free path 20 m —
 *    that is what sets the step ceiling, not any rendering consideration.
 *  - Frostbite Eq.17 analytic scattering integration over each step, so brightness does
 *    not depend on step count.
 *  - HG + Draine phase (Jendersie & d'Eon 2023) at mean droplet diameter 25 um, maritime.
 *    p(0 deg) ~ 1e4 sr^-1: that four-order-of-magnitude peak IS the silver lining, and
 *    nothing downstream may clamp it. This replaced a mix(HG(+0.82), HG(-0.32), 0.36)
 *    whose peak was 11 sr^-1 — 36% weighted onto a BACKWARD lobe, i.e. barely any forward
 *    peak at all — which is why the shipped build had no bright rim anywhere even with
 *    the sun in frame.
 *  - Multiple scattering by the Wrenninge/Frostbite octave method, N = 6, a = b = 0.62.
 *    NOT Frostbite's N = 3: at sigma_t = 50 /km the light march saturates completely and
 *    only octaves whose effective extinction sigma_e*b^n is O(1) over the march reach
 *    contribute anything. See the octave loop for the measured sweep.
 *  - Nubis 2017 in-scatter probability: vertical_probability (this is what makes cumulus
 *    bases dark) x depth_probability. Deliberately WITHOUT the Nubis
 *    max(exp(-d), 0.7*exp(-0.25d)) attenuation floor and WITHOUT the 2015 Beer-Powder
 *    term, both of which solve the same problem as the octave series above. Stacking
 *    them is what produced clouds that were simultaneously duller and greyer-cored than
 *    the reference.
 *  - Ambient from 'ctx.get('sky').radiance()' — sampled over the hemisphere on the CPU
 *    and cached against the sun key — so shadowed undersides pick up sky blue and the
 *    cloud agrees with the atmosphere it is embedded in. Occluded by two upward density
 *    taps and weighted by a Frostbite bottom-to-top gradient. The sun's own colour comes
 *    from the sky module's transmittance LUT, evaluated at cloud altitude.
 *  - Aerial perspective per pixel over the mean cloud distance (see the composite at the
 *    end of the march), which is what turns the far deck into pale haze not white paint.
 *
 * ---------------------------------------------------------------- performance
 *
 * March at half resolution with a Bayer-4x4 x van-der-Corput-16 offset on the first
 * step, then a reprojected temporal accumulation with a 1/(n+1) running mean clamped
 * to 1/16. Rotation-only reprojection is exact here: the clouds are 1-150 km away and
 * the player walks at 5 m/s, so translation parallax is below a hundredth of a pixel.
 * For a static camera the reprojection is the identity, so a capture converges to the
 * mean of the 16 dither phases and is stable frame to frame — verified by capturing at
 * settle 44 and 45 and differencing.
 *
 * Adaptive stepping with TWO schedules (see stepMarch / stepSearch). A cheap
 * (erosion-free, therefore conservative-HIGH) density skips empty space at 2x the coarse
 * step and steps BACK one on first hit; the integration step is separate and is held
 * near the 20 m mean free path so the shell is crossed in tens of samples at any range.
 * A single distance-driven step holds a constant angular footprint, which is right for a
 * texture LOD and wrong for an optical-depth integral — it is what turned the far deck
 * into 2-sample binary slabs. Early-out at transmittance < 0.01.
 *
 * The condensation threshold softens as the step grows, for the same reason: sharpening
 * a signal you can no longer resolve is what put a razor rim on those slabs. The erosion
 * octaves are LODed against the step so nothing is sampled below Nyquist.
 *
 * Cone-sampled 6-step light march, which runs the FULL eroded field - the cheap upper
 * bound is only ever valid as a space-skip test, and using it as an optical depth
 * over-shadowed every lobe the erosion had just carved.
 *
 * ---------------------------------------------------------------- integration
 *
 * Exposes 'clouds.buffer' (rgba16f, rgb = scattered radiance, a = transmittance). The
 * 'cloudComposite' pass is the SINGLE consumer and the single composite. This module
 * used to also composite the buffer itself with a LAYER.SKY quad, as a fallback for
 * while 'cloudComposite' was a stub, gated on 'pass.consumesClouds === true' — a flag
 * nothing ever set. So both ran: the quad wrote 'L + sky*T' and the pass then wrote
 * '(L + sky*T)*T + L', i.e. 'L*(1+T) + sky*T^2'. Clear sky (T=1) and opaque cores (T=0)
 * came out untouched, so it did not look like a bug; every SEMI-transparent pixel — so
 * every cloud edge and every wisp, which is the entire silhouette — got 3x the radiance
 * and a quarter of the sky behind it at T=0.5. Removing the quad restored 'sky' ROI
 * lap_var 54 -> 97 and edge_density 0.0123 -> 0.0200 with no other change.
 *
 * The march therefore has to produce the geometry silhouettes itself: it writes
 * rad = 0, T = 1 behind solid geometry. Without that, cloudComposite composites cloud
 * over rock, dune, canopy and the viewmodel.
 *
 * DO NOT READ 'pipe.depthTex' FOR THAT. This is the trap that cost the previous revision
 * of this file its critical finding, and the code that reads it looks completely
 * correct. 'RenderPipeline.init' assigns the SAME DepthTexture object to both
 * 'pipe.gbuffer.depthTexture' and 'pipe.sceneRT.depthTexture' (lines 153/158), and
 * 'scene.js' calls 'renderer.clearDepth()' before drawing the viewmodel into sceneRT.
 * That clear lands on the shared texture, so by the time anything samples it the world's
 * depth is gone and every pixel except the gun reads 1.0. The test compiled, the uniform
 * was bound, the branch was live, and it never fired: replacing the whole masked block
 * with a bare 'return' produced a BYTE-IDENTICAL frame over the entire terrain band.
 * (The one region where it did appear to work is the viewmodel, which is exactly the one
 * thing left in that buffer — a verification that proved the opposite of what it read.)
 *
 * What is read instead:
 *   - 'pipe.gbuffer.textures[0]' (view normal * 0.5 + 0.5, roughness) for WORLD geometry.
 *     The G-buffer's colour attachments are written by the pre-pass and are never cleared
 *     for the viewmodel, so attachment 0 is exactly zero where nothing was drawn and has
 *     length >= 0.36 everywhere something was. Conservative 2x2 tap, because this buffer
 *     is half resolution.
 *   - 'pipe.depthTex' for the VIEWMODEL only, which is drawn on its own layer and never
 *     enters the pre-pass, and which is all that texture still contains. Binary: the
 *     depth in there was written through the viewmodel camera's own near-field
 *     projection, so linearising it with the main camera's near/far — which the previous
 *     revision did — computes a meaningless distance.
 * Together they cover everything. Neither needs a distance: the nearest possible cloud
 * sample is at 650 m altitude and every solid surface in this scene is inside a few
 * hundred metres, so "geometry exists here" and "geometry is in front" are the same
 * predicate.
 *
 * Verified the way the critic asked: differencing against '--skip clouds' at ref_00000,
 * zero pixels below the terrain skyline change (band y=600-1080 frac>10 codes = 0.0000,
 * max diff 5), against 33% of y=420-460 changing by up to 127 codes before.
 *
 * NOTE for whoever fixes 'scene.js': once the world depth survives into a texture the
 * clouds can read, 'cloudComposite's bilateral upsample starts working too. Today every
 * one of its taps reads err = 0 against that same broken texture and tol = 0.04*linZ(1)
 * = 480, so it degenerates to a plain bilinear and the silhouettes this march writes are
 * softened by ~2 full-res pixels on the way through it. That is a real (small) defect and
 * it is not fixable from inside this file.
 *
 * One frame of latency on both reads is invisible here: the deck is 0.7-70 km away, all
 * solid geometry is inside 200 m, and the reprojected temporal resolve converges to a
 * fixed point for a static camera.
 */

const RG_KM = 6360.0;          // must match ATM_Rg in src/world/sky.js

/* ------------------------------------------------------------------ shared GLSL */

/**
 * Periodic gradient noise. The shared library's 'gnoise3' wraps on an infinite lattice
 * and therefore cannot tile a volume texture; this is the same construction with the
 * lattice folded modulo the period, built on the shared 'hash33'/'hash22' so the
 * statistical character stays identical to every other surface in the game.
 */
const PERIODIC_GLSL = /* glsl */`
vec3 pgrad3(vec3 c, float period){
  vec3 g = hash33(mod(c, vec3(period))) * 2.0 - 1.0;
  float l = length(g);
  return (l > 1e-4) ? g / l : vec3(0.5773, 0.5773, 0.5773);
}
float pgnoise3(vec3 p, float period){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  #define PG3(o) dot(pgrad3(i+o, period), f-o)
  float n = mix(mix(mix(PG3(vec3(0,0,0)), PG3(vec3(1,0,0)), u.x),
                    mix(PG3(vec3(0,1,0)), PG3(vec3(1,1,0)), u.x), u.y),
                mix(mix(PG3(vec3(0,0,1)), PG3(vec3(1,0,1)), u.x),
                    mix(PG3(vec3(0,1,1)), PG3(vec3(1,1,1)), u.x), u.y), u.z);
  #undef PG3
  return n * 1.1547;
}
float pfbm3(vec3 p, float period, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    s += a * pgnoise3(p, period); n += a;
    p *= 2.0; period *= 2.0; a *= 0.5;
  }
  return s / max(n, 1e-4);
}
vec2 pgrad2(vec2 c, float period){
  vec2 g = hash22(mod(c, vec2(period))) * 2.0 - 1.0;
  float l = length(g);
  return (l > 1e-4) ? g / l : vec2(0.7071, 0.7071);
}
float pgnoise2(vec2 p, float period){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  #define PG2(o) dot(pgrad2(i+o, period), f-o)
  float n = mix(mix(PG2(vec2(0,0)), PG2(vec2(1,0)), u.x),
                mix(PG2(vec2(0,1)), PG2(vec2(1,1)), u.x), u.y);
  #undef PG2
  return n * 1.4142;
}
float pfbm2(vec2 p, float period, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    s += a * pgnoise2(p, period); n += a;
    p *= 2.0; period *= 2.0; a *= 0.5;
  }
  return s / max(n, 1e-4);
}
/** Worley FBM, three octaves, seamless at f cells across the unit cube. */
float wfbm3(vec3 p, float f){
  return clamp(worley3Tiled(p, f) * 0.625
             + worley3Tiled(p, f*2.0) * 0.250
             + worley3Tiled(p, f*4.0) * 0.125, 0.0, 1.0);
}
float remap(float v, float a, float b, float c, float d){
  return c + (v - a) * (d - c) / max(b - a, 1e-5);
}
`;

/* ---------------------------------------------------- 1. base shape volume, 128^3 */

const BASE3D_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform float uLayer;
uniform float uRes;
uniform float uSeed;
${NOISE_GLSL}
${PERIODIC_GLSL}
void main(){
  vec3 p = vec3(vUv, (uLayer + 0.5) / uRes) + uSeed;

  // Perlin at period 4 with a periodic domain warp: unrotated FBM is grid-aligned and
  // reads as a chequerboard once it is thresholded by coverage.
  vec3 w = vec3(pfbm3(p*4.0 + 13.1, 4.0, 3),
                pfbm3(p*4.0 + 41.7, 4.0, 3),
                pfbm3(p*4.0 + 71.3, 4.0, 3));
  float perlin = pfbm3(p*4.0 + w*0.85, 4.0, 5) * 0.5 + 0.5;
  perlin = clamp(perlin, 0.0, 1.0);

  float wLow = wfbm3(p, 2.0);
  // Nubis dilation: push the Perlin field out by the inverted Worley so the low
  // frequency shape gains billowy lobes instead of smooth blobs.
  float pw = clamp(remap(perlin, wLow*0.85 - 0.12, 1.0, 0.0, 1.0), 0.0, 1.0);

  // Frequencies are capped at 32 cells: a 128^3 volume gives that only 4 voxels per
  // cell, and anything finer aliases into the shape rather than adding detail.
  oCol = vec4(pw, wfbm3(p, 2.0), wfbm3(p, 4.0), wfbm3(p, 8.0));
}
`;

/* --------------------------------------------------- 2. detail erosion volume, 64^3 */

const DETAIL3D_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform float uLayer;
uniform float uRes;
uniform float uSeed;
${NOISE_GLSL}
${PERIODIC_GLSL}
void main(){
  vec3 p = vec3(vUv, (uLayer + 0.5) / uRes) + uSeed;
  // 64^3 resolves 16 cells per axis at 4 voxels/cell, so the erosion octaves can carry
  // real structure instead of a single blurred cell. This volume is sampled TWICE in
  // world space (a ~250 m tile and a ~1.6 km tile) so the silhouette gets lobes at both
  // the cauliflower scale and the tower scale from one texture.
  oCol = vec4(wfbm3(p, 2.0), wfbm3(p, 4.0), worley3Tiled(p, 8.0), 1.0);
}
`;

/* ------------------------------------------------------- 3. weather texture, 512^2 */

const WEATHER_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform float uSeed;
uniform float uTypeBias;
${NOISE_GLSL}
${PERIODIC_GLSL}
void main(){
  vec2 uv = vUv + uSeed;
  // every multiplier below is an integer so the whole field stays periodic in uv
  vec2 w = vec2(pfbm2(uv*6.0 + 11.3, 6.0, 3), pfbm2(uv*6.0 + 27.7, 6.0, 3));

  float c1 = pfbm2(uv*3.0 + w*0.55, 3.0, 4) * 0.5 + 0.5;
  float c2 = pfbm2(uv*8.0 + w*0.75 + 5.1, 8.0, 4) * 0.5 + 0.5;
  float c3 = pfbm2(uv*18.0 + w*0.40 + 9.7, 18.0, 3) * 0.5 + 0.5;
  // Cell structure: broad weather systems carrying clusters of cumulus, not one
  // uniform field of blobs. c1 gates whether there is any convection here at all.
  float sys = smoothstep(0.20, 0.68, c1);
  float cov = clamp(c2 * 0.62 + c3 * 0.38, 0.0, 1.0);
  // Hard clustering. A uniform coverage field gives an even carpet of identical
  // popcorn; the reference is one big congestus bank with clear blue lanes around it,
  // which needs the system term to switch the deck almost fully on and fully off.
  cov = clamp(cov * (0.08 + 1.55 * sys), 0.0, 1.0);

  // cloud type: 0 flat stratocumulus .. 1 tall congestus. Towers cluster where the
  // system field is strongest, which is what gives the reference its one big anvil
  // surrounded by smaller lumps rather than a field of identical puffs.
  float ty = clamp(sys * 0.62 + (pfbm2(uv*4.0 + 31.9, 4.0, 3)*0.5 + 0.5) * 0.62 + uTypeBias, 0.0, 1.0);

  // curl vector, for wispy distortion of the eroded edges near the cloud base
  float ca = pfbm2(uv*14.0 + 3.3, 14.0, 2);
  float cb = pfbm2(uv*14.0 + 57.1, 14.0, 2);

  oCol = vec4(cov, ty, ca*0.5 + 0.5, cb*0.5 + 0.5);
}
`;

/* ------------------------------------------------------------- 4. the raymarch */

const MARCH_FRAG = /* glsl */`
precision highp sampler3D;
in vec2 vUv;
out vec4 oCol;

uniform sampler3D tBase;
uniform sampler3D tDetail;
uniform sampler2D tWeather;
uniform sampler2D tTransmittance;   // sky's LUT; null-safe via uHasTrLut

uniform vec3  uRo;            // camera, planet-centre relative, km
uniform vec3  uFwd, uRight, uUp;
uniform float uTanHalf, uAspect;

uniform vec3  uSunDir;
uniform vec3  uSunRadiance;   // linear HDR irradiance of the sun at cloud altitude
uniform vec3  uAmbTop, uAmbBottom;
uniform float uHazeK;

// Scene occlusion (previous frame's, see the integration note in the header). The march
// is the only place a silhouette can be produced, because cloudComposite upsamples this
// buffer bilaterally and an upsample cannot invent an edge that is not in the buffer.
// Rays that hit solid geometry write rad = 0, T = 1 and composite to a no-op.
//
// tGNorm is the G-BUFFER NORMAL attachment, not the depth texture. See the header: the
// shared depth texture is destroyed every frame by the viewmodel's clearDepth(), so it
// carries ONLY the viewmodel. The G-buffer's colour attachments are never cleared for
// the viewmodel, so attachment 0 (view normal * 0.5 + 0.5, roughness) is zero exactly
// where no world geometry was drawn and length >= 0.36 everywhere it was.
uniform sampler2D tGNorm;
uniform float uHasGNorm;
uniform vec2  uInvGSize;
// ...and the depth texture supplies the one thing the G-buffer lacks: the viewmodel,
// which is drawn on its own layer and never enters the pre-pass. Binary only — the
// depth in there was written with the viewmodel camera's projection, so linearising it
// with the main camera's uNear/uFar would give a meaningless distance.
uniform sampler2D tDepth;
uniform float uHasDepth;
uniform float uAmbFloor;

uniform float uBaseKm, uThickKm, uInvThick;
uniform float uCoverage, uDensity, uTypeBias;
uniform vec2  uBaseOffset;    // wind advection of the shape volume (km)
uniform vec2  uDetailOffset;
uniform vec2  uWeatherOffset, uWeatherOffset2;
uniform float uEvolve;        // slow vertical evolution of the shape volume
uniform float uBaseFreq, uBaseFreqY, uDetailFreq, uCoarseFreq, uWeatherFreq, uWeatherFreq2;
uniform float uErode, uCurl, uEdgeGain, uSharpen;
uniform vec2  uWindDir;       // unit XZ wind direction, for the cloud_top_offset shear
uniform float uShearKm;       // downwind lean of the tops over the full layer

uniform float uExtinction;    // 1/km at density 1
uniform float uAlbedo;
uniform float uPhaseGH, uPhaseGD, uPhaseA, uPhaseWD;
uniform float uMSa, uMSb, uMSc, uMSN;
uniform float uPowder;
uniform float uAmbGain;
uniform float uScatterGain;
uniform float uLightStep;

uniform float uMaxDist;
uniform float uTemporalJitter;
uniform float uHasTrLut;

const float RG = ${RG_KM.toFixed(1)};

float remap(float v, float a, float b, float c, float d){
  return c + (v - a) * (d - c) / max(b - a, 1e-5);
}

/* ---- transmittance LUT of src/world/sky.js, Bruneton parameterisation ----
 * Sampled rather than re-derived so the sun colour arriving on a cloud top is the
 * same colour the atmosphere module thinks it is. */
vec2 trUv(float r, float mu){
  float H = sqrt(max(6420.0*6420.0 - RG*RG, 1e-6));
  float rho = sqrt(max(r*r - RG*RG, 0.0));
  float disc = r*r*(mu*mu - 1.0) + 6420.0*6420.0;
  float d = max(0.0, -r*mu + sqrt(max(disc, 0.0)));
  float dmin = 6420.0 - r;
  float dmax = rho + H;
  return vec2(clamp((d - dmin)/max(dmax - dmin, 1e-6), 0.0, 1.0), clamp(rho/H, 0.0, 1.0));
}

/** Is there solid geometry in front of the cloud layer at this pixel?
 *
 *  Binary, deliberately. The nearest possible cloud sample is at uBaseKm altitude — 650 m
 *  — and every solid surface in this scene is inside a few hundred metres, so "geometry
 *  exists here" and "geometry is nearer than the clouds" are the same predicate and no
 *  distance is needed. That matters, because neither source carries a distance we could
 *  trust: the G-buffer gives normals, and the depth texture's only surviving contents
 *  were written through the viewmodel camera's projection.
 *
 *  Conservative 2x2 tap over the full-res G-buffer: this buffer is half resolution, and
 *  a cloud that bleeds one pixel onto a rock edge is more visible than a silhouette that
 *  is one pixel fat. */
bool sceneOccludes(vec2 uv){
  if (uHasGNorm > 0.5){
    float m = 0.0;
    for (int j = 0; j < 2; j++)
      for (int i = 0; i < 2; i++){
        vec3 n = texture(tGNorm, uv + (vec2(float(i), float(j)) - 0.5) * uInvGSize).xyz;
        m = max(m, dot(n, n));
      }
    if (m > 0.02) return true;
  }
  if (uHasDepth > 0.5 && texture(tDepth, uv).r < 0.999995) return true;
  return false;
}

/** TWO step schedules, because the empty-space search and the optical-depth integral
 *  want opposite things and a single distance-driven rule cannot serve both.
 *
 *  The old single rule (0.030 + 0.0075t, capped 0.75 km) held a constant ANGULAR
 *  footprint. Angular footprint is the right invariant for a texture LOD and the wrong
 *  one for an integral: at 40 km it put 2-5 samples through the whole 1.55 km shell, and
 *  a hard coverage threshold applied to 2 flat samples is a slab by construction — which
 *  is exactly what the far deck looked like (interior std 9.6 against 34.9 for reference
 *  cumulus at the same size, and 29 codes BRIGHTER than the sky behind it).
 *
 *  stepMarch is the integration step and is held near the mean free path: at sigma_t
 *  50/km the mfp is 20 m, and research/clouds.md 3.1 puts the ceiling at ~25 m. It grows
 *  only slowly with distance, so a cloud is always resolved in tens of samples however
 *  far away it is.
 *
 *  stepSearch is the empty-space skip and may be much coarser, because it only has to
 *  not step over a whole cloud. It carries the far-field cost. */
float stepMarch(float t){
  return clamp(0.021 + t * 0.00095, 0.021, 0.090);
}
float stepSearch(float t){
  return clamp(0.055 + t * 0.0090, 0.055, 1.10);
}

float raySphereFar(vec3 ro, vec3 rd, float R){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R*R;
  float h = b*b - c;
  if (h < 0.0) return -1.0;
  return -b + sqrt(h);
}
bool raySphereHits(vec3 ro, vec3 rd, float R){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R*R;
  float h = b*b - c;
  if (h < 0.0) return false;
  return (-b - sqrt(h)) > 0.0;
}

/* ---- phase function: HG + Draine, Jendersie & d'Eon 2023 ------------------------
 *
 * Draine's function (their Eq. 2) reduces to Henyey-Greenstein at alpha = 0 and to
 * Cornette-Shanks at alpha = 1, so one routine covers both lobes of their Eq. 3 fit:
 *
 *   phi(theta) = (1-w)*phi_{0,gHG} + w*phi_{alpha,gD}
 *
 * The four parameters are their closed-form fit evaluated at a mean droplet diameter of
 * 25 um — maritime cumulus, whose droplets are markedly larger than continental ones
 * because there are far fewer condensation nuclei over open ocean.
 *
 * What this replaces and why. The old dualHG was mix(HG(+0.82), HG(-0.32), 0.36): 36%
 * weighted onto a BACKWARD lobe, which leaves almost no forward peak. p(0 deg) for that
 * mixture is ~11 sr^-1. p(0 deg) here is ~1.0e4 sr^-1. That four-order-of-magnitude
 * difference IS the silver lining, and it is why the shipped build had none: the sun is
 * in frame at ref_00720 and not one cloud had a bright rim.
 *
 * Nothing downstream may clamp this. research/clouds.md 6.4: clamping before the
 * tonemapper turns the sun-adjacent rim into a flat white shape with a hard boundary. */
float draine(float c, float g, float a){
  float g2 = g*g;
  float d  = 1.0 + g2 - 2.0*g*c;
  float rd = inversesqrt(max(d, 1e-7));
  return 0.0795774715 * (1.0 - g2) * rd*rd*rd * (1.0 + a*c*c) / (1.0 + a*(1.0 + 2.0*g2)/3.0);
}
float phaseMie(float c){
  return (1.0 - uPhaseWD) * draine(c, uPhaseGH, 0.0)
       +        uPhaseWD  * draine(c, uPhaseGD, uPhaseA);
}

float heightFrac(vec3 p){
  return (length(p) - (RG + uBaseKm)) * uInvThick;
}

/** height-density profile: flat bottom, cauliflower top, type-dependent depth.
 *
 *  The bottom ramps are DELIBERATELY short — 0 to 0.05 of a 1550 m layer is 78 m. Trade
 *  cumulus all condense at the same lifting condensation level, so their bases are flat
 *  and all at one altitude; a long bottom ramp (the old 0.01-0.16, i.e. 250 m) makes the
 *  underside a soft dome and the deck reads as steam. */
float heightGradient(float h, float ty){
  float stratus = clamp(remap(h, 0.00, 0.04, 0.0, 1.0), 0.0, 1.0)
                * clamp(remap(h, 0.12, 0.28, 1.0, 0.0), 0.0, 1.0);
  float cumulus = clamp(remap(h, 0.00, 0.05, 0.0, 1.0), 0.0, 1.0)
                * clamp(remap(h, 0.40, 0.86, 1.0, 0.0), 0.0, 1.0);
  float congest = clamp(remap(h, 0.00, 0.04, 0.0, 1.0), 0.0, 1.0)
                * clamp(remap(h, 0.66, 1.00, 1.0, 0.0), 0.0, 1.0);
  float a = clamp(ty * 2.0, 0.0, 1.0);
  float b = clamp(ty * 2.0 - 1.0, 0.0, 1.0);
  return mix(mix(stratus, cumulus, a), congest, b);
}

vec4 sampleWeather(vec3 p){
  vec4 wa = texture(tWeather, (p.xz + uWeatherOffset) * uWeatherFreq);
  vec2 a = wa.xy;
  vec2 cw = wa.zw;
  vec2 b = texture(tWeather, (p.xz + uWeatherOffset2) * uWeatherFreq2).xy;
  // Two decorrelated scales multiplied together: the tile period of the product is
  // the LCM of the two, which is far beyond the 150 km view distance, so the weather
  // map never shows its seams even though each tap does.
  // Second, decorrelated scale. Its mean multiplier used to be 1.07, i.e. it added
  // variance without removing any coverage, so the three stacked coverage terms
  // (WEATHER_FRAG's clustering, this, and the remap window below) all multiplied UP and
  // S.coverage 0.56 landed near 46% volume coverage = a solid ceiling overhead.
  float cov = clamp(a.x * (0.10 + 1.20 * b.x), 0.0, 1.0);
  float ty  = clamp(a.y * 0.60 + b.y * 0.55 + uTypeBias, 0.0, 1.0);
  return vec4(cov, ty, cw * 2.0 - 1.0);
}

/** 'ero' scales the erosion octaves; 'coarse' adds the ~1.6 km tower-scale tap.
 *
 *  ero = 0 skips erosion entirely. Erosion only ever REMOVES density, so that value is a
 *  conservative upper bound — correct for empty-space skipping and wrong anywhere the
 *  result is used as an optical depth, because it systematically over-shadows. It is
 *  therefore used for the space skip and for nothing else; the light march runs the full
 *  field (see lightMarch).
 *
 *  'ero' is also the LOD handle: it is driven by the step length, so octaves whose cells
 *  are below the sampling Nyquist are faded out instead of aliased into popcorn. */
float cloudDensity(vec3 p, float h, float ero, float coarse, float edge){
  if (h < 0.0 || h > 1.0) return 0.0;
  vec4 w = sampleWeather(p);
  // A 0.70-wide remap window meant almost the whole weather field mapped to nonzero
  // coverage; 0.44 leaves genuine blue lanes between the banks.
  float cov = clamp(remap(w.x, 1.0 - uCoverage - 0.20, 1.0 - uCoverage + 0.24, 0.0, 1.0), 0.0, 1.0);
  if (cov <= 0.0) return 0.0;

  // Altitude, not planet-relative y: the volume must be indexed by height above the
  // ground, and 'h' already carries it exactly. The vertical axis gets its own, higher
  // frequency — a 1.7 km layer through a 13 km tile would otherwise span 13% of the
  // volume and give the deck almost no vertical structure.
  float alt = uBaseKm + h * uThickKm;
  // cloud_top_offset (Nubis 2017, 500 m): push the tops downwind in proportion to height
  // fraction. Without it every lump is vertically symmetric — the "extruded columns" of
  // research/clouds.md 6.1 — and no amount of erosion detail makes it read as weather.
  vec2 sh = uWindDir * (uShearKm * h);
  vec3 sp = vec3((p.x + sh.x + uBaseOffset.x) * uBaseFreq,
                 (alt + uEvolve) * uBaseFreqY,
                 (p.z + sh.y + uBaseOffset.y) * uBaseFreq);
  vec4 b = texture(tBase, sp);
  float wf = b.y*0.625 + b.z*0.25 + b.w*0.125;
  float field = clamp(remap(b.x, wf*0.72 - 0.18, 1.0, 0.0, 1.0), 0.0, 1.0);
  field *= heightGradient(h, w.y);

  // The erosion is SUBTRACTED FROM THE FIELD, before the coverage threshold, not
  // remapped out of the finished density afterwards. That is the difference between
  // clouds with cauliflower silhouettes and clouds that look like marshmallow: the
  // iso-contour that becomes the cloud's edge then follows the 120-500 m detail octaves
  // instead of the 1.4 km shape octaves, and every lobe gets its own outline.
  if (ero > 0.001){
    // saturate(height_fraction * 10.0), verbatim Nubis 2017. The wispy<->billowy
    // inversion belongs in the bottom TENTH of the layer. The old h*3.0 spread it over
    // the bottom third, so the whole lower third of every cloud got inverted (wispy)
    // erosion and frayed instead of presenting the flat base that says "cumulus".
    float hb = clamp(h * 10.0, 0.0, 1.0);
    vec3 dp = vec3((p.x + uDetailOffset.x + w.z * uCurl * (1.0 - h)) * uDetailFreq,
                   (alt - uEvolve * 0.6) * uDetailFreq,
                   (p.z + uDetailOffset.y + w.w * uCurl * (1.0 - h)) * uDetailFreq);
    vec3 dt = texture(tDetail, dp).xyz;
    float df = dt.x*0.625 + dt.y*0.25 + dt.z*0.125;
    // billowy at the top, wispy near the base — the standard Nubis inversion
    float mod_ = mix(1.0 - df, df, hb);
    if (coarse > 0.5){
      // Second tap of the same volume at ~4x the world period. One erosion scale can
      // only ever put lobes on the silhouette at one size; a cumulus has cauliflower at
      // 200 m AND turret-scale bites at 1.5 km, and the shape volume's own octaves are
      // too smooth to supply the second.
      vec3 cp = vec3((p.x + uDetailOffset.x * 0.35) * uCoarseFreq,
                     (alt - uEvolve * 0.25) * uCoarseFreq,
                     (p.z + uDetailOffset.y * 0.35) * uCoarseFreq);
      vec3 ct = texture(tDetail, cp).xyz;
      float cf = ct.x*0.60 + ct.y*0.28 + ct.z*0.12;
      mod_ = mod_ * 0.58 + mix(1.0 - cf, cf, hb) * 0.42;
    }
    field -= mod_ * uErode * ero * (0.30 + 0.70 * (1.0 - field));
  }

  // A threshold with a controlled ramp width. Real cumulus have a condensation boundary
  // a few tens of metres thick, not the 500 m gradient a linear coverage remap produces.
  //
  // 'edge' is passed in already softened for the step length (see the call sites): a hard
  // threshold applied to samples you can no longer resolve sharpens the one signal that
  // is definitely aliased, which is how the far deck became binary trapezoidal panels.
  float d = clamp((field - (1.0 - cov)) * edge, 0.0, 1.0);
  if (d <= 0.0) return 0.0;
  d *= mix(0.62, 1.0, cov);

  // Nubis-3 sharpening, pow(density, 0.3..0.6). This is the published fix for
  // "silhouettes are smooth and soft, no fine structure on the rim" that does NOT work
  // by adding high-frequency energy — it redistributes the tonal range of the body
  // instead, which is exactly the trade this deck needs (edge_density was 54% OVER
  // target at ref_00000 while local_contrast was 33% UNDER).
  d = pow(d, uSharpen);

  // Vertical density profile. A trade cumulus carries most of its liquid water low: the
  // base is the densest, flattest, most opaque part of the cloud and the turrets above
  // it are progressively more ragged. The old profile did the OPPOSITE — it thinned the
  // bottom 30% by 0.45 — which brightened and softened precisely the region that has to
  // be the darkest thing in the sky.
  d *= mix(1.10, 0.68, smoothstep(0.18, 0.95, h));
  return d * uDensity;
}

/** Cone kernel, from clayjohn's Godot port of the Nubis light march (six unit vectors).
 *  The offset is scaled by the sample index so the cone opens with distance — that is
 *  what smooths the concentric banding six light samples would otherwise produce. */
const vec3 CONE[6] = vec3[6](
  vec3( 0.38051305,  0.92453449, -0.02111345),
  vec3(-0.50625799, -0.03590792, -0.86163418),
  vec3(-0.32509218, -0.94557439,  0.01428793),
  vec3( 0.09026238, -0.27376545,  0.95755165),
  vec3( 0.28128598,  0.42443639, -0.86065785),
  vec3(-0.16852403,  0.14748697,  0.97460106));

/** Cone-sampled 6-step march toward the sun, returning optical depth in units of
 *  density*km (multiply by uExtinction for a dimensionless tau).
 *
 *  Reach: research/clouds.md 4.4 wants the total to land at 0.3-0.5x the cloud diameter,
 *  so ~0.5-0.8 km for a 1-2 km trade cumulus. With the growth factor below, 45 m x 18 =
 *  0.81 km. Marching further only re-samples the same cloud and greys the sunlit tops. */
float lightMarch(vec3 p, float baseStep, float ero, float edge){
  float od = 0.0;
  float t = 0.0;
  for (int i = 0; i < 6; i++){
    float s = baseStep * (1.0 + float(i) * 0.80);
    t += s;
    vec3 q = p + uSunDir * t + CONE[i] * (baseStep * float(i) * 0.55);
    float h = heightFrac(q);
    if (h > 1.02) break;
    // The FULL field, erosion included. The erosion-free density is an upper bound, so
    // using it here inflates every optical depth and shadows the lobes it was supposed
    // to carve back into uniform grey — the erosion cancels itself out.
    od += cloudDensity(q, h, ero, 1.0, edge) * s;
  }
  // one long far tap so a tower shadows the deck beneath it
  vec3 q = p + uSunDir * (t + 1.8);
  od += cloudDensity(q, heightFrac(q), ero, 0.0, edge) * 1.8 * 0.5;
  return od;
}

/** Two upward taps: how much cloud is between this sample and the open sky. This is
 *  ambient OCCLUSION (Nubis-3's exp(-summed_ambient_density)) and it is a different
 *  quantity from the directional in-scatter probability below — one attenuates the sky
 *  term, the other attenuates the sun term. The shipped build had only this one, which
 *  is why the direct lighting had no tonal range at all. */
float ambientMarch(vec3 p, vec3 up){
  vec3 a = p + up * 0.14;
  vec3 b = p + up * 0.52;
  return cloudDensity(a, heightFrac(a), 0.0, 0.0, uEdgeGain) * 0.30
       + cloudDensity(b, heightFrac(b), 0.0, 0.0, uEdgeGain) * 0.58;
}

/** In-scatter probability — Nubis 2017 GetLightEnergy, the term the shipped build was
 *  missing entirely and had papered over with uScatterGain 2.4 and a x2 powder boost.
 *
 *  vertical_probability: below 7% of the layer the probability is 0.1, by 14% it is 1.0.
 *  For a 1550 m shell that is 109-217 m above the LCL. Guerrilla's reason, verbatim:
 *  "because there are no strong scattering sources below clouds, the bottoms will have
 *  fewer occurrences of in-scattering". THIS IS WHAT MAKES CUMULUS BASES DARK.
 *
 *  depth_probability: 'dsLod' is the erosion-free local density — "how much cloud is
 *  around me", not "how much cloud is at me". The exponent is remapped 0.5 -> 2.0 over
 *  h = 0.3 -> 0.85, so thin material darkens hard near the top of a tower and gently
 *  lower down; the +0.05 floor keeps edges off pure black.
 *
 *  The slide's disable term is lerp(..., 1.0, saturate(dl/step_size)), which is not
 *  dimensionally meaningful (dl is a bare sum of densities and step_size a world length,
 *  and the slide is internally inconsistent about both). The INTENT is stated in the
 *  notes — "we also reduce this effect once light has attenuated to make it directional"
 *  — so the reading used here is the dimensionless optical depth toward the sun: by
 *  tau = 4 the sample is already in deep shadow and must not be darkened twice. */
float inScatterProbability(float h, float dsLod, float tauLight){
  float depthP = 0.05 + pow(max(dsLod, 1e-4), clamp(remap(h, 0.30, 0.85, 0.5, 2.0), 0.4, 2.2));
  depthP = mix(depthP, 1.0, clamp(tauLight * 0.25, 0.0, 1.0));
  float vertP = pow(clamp(remap(h, 0.07, 0.14, 0.1, 1.0), 0.0, 1.0), 0.8);
  return depthP * vertP;
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + uRight * (ndc.x * uTanHalf * uAspect) + uUp * (ndc.y * uTanHalf));

  oCol = vec4(0.0, 0.0, 0.0, 1.0);

  // Sun colour at cloud altitude, straight out of the sky module's transmittance LUT,
  // so a cloud top is lit by exactly the light the atmosphere says gets there.
  vec3 sunCol = uSunRadiance;
  if (uHasTrLut > 0.5)
    sunCol *= texture(tTransmittance, trUv(RG + uBaseKm + uThickKm*0.5, clamp(uSunDir.y, -1.0, 1.0))).rgb;

  // The ground occludes anything below the horizon, and the scene geometry is drawn
  // over the top of this buffer anyway.
  if (raySphereHits(uRo, rd, RG)) return;

  // Terminate at scene geometry. This is what stops cloudComposite painting cloud
  // radiance over rock, dune, canopy and the viewmodel, and it is what puts the geometry
  // silhouettes INTO the half-resolution buffer.
  if (sceneOccludes(vUv)) return;

  float tIn  = raySphereFar(uRo, rd, RG + uBaseKm);
  float tOut = raySphereFar(uRo, rd, RG + uBaseKm + uThickKm);
  if (tOut <= 0.0) return;
  tIn = max(tIn, 0.0);
  tOut = min(tOut, uMaxDist);
  if (tOut <= tIn) return;

  float seg = tOut - tIn;
  float step = stepMarch(tIn);

  // Bayer 4x4 in space x van der Corput 16 in time. Exactly 16 phases, exactly
  // periodic, so the temporal mean is a fixed point rather than a slow drift.
  float bx = mod(gl_FragCoord.x, 4.0), by = mod(gl_FragCoord.y, 4.0);
  float bayer = mod(bx * 5.0 + by * 3.0 + bx * by, 16.0) / 16.0;
  float jit = fract(bayer + uTemporalJitter);

  float t = tIn + step * jit;
  vec3 scatter = vec3(0.0);
  float trans = 1.0;
  float distAccum = 0.0;
  float weightAccum = 0.0;
  float cosT = dot(rd, uSunDir);

  int zeros = 8;   // start in "search" mode
  for (int i = 0; i < 256; i++){
    if (t > tOut || trans < 0.010) break;
    vec3 p = uRo + rd * t;
    float h = heightFrac(p);

    step = stepMarch(t);
    float srch = stepSearch(t);
    // Octave LOD: fade the fine erosion tap out once the step can no longer resolve it,
    // and drop the tower-scale tap when even that is below Nyquist. Sampling an octave
    // below Nyquist does not add detail, it adds noise that the 16 dither phases then
    // box-average into mush.
    float ero = clamp(1.0 - (step - 0.030) / 0.055, 0.0, 1.0);
    float coarse = step < 0.070 ? 1.0 : 0.0;
    // Soften the condensation threshold as the step grows. Sharpening a signal you can
    // no longer resolve is how a two-sample crossing of the far shell became a hard
    // trapezoidal panel with a razor rim and a dead interior.
    float edge = mix(uEdgeGain, 1.6, smoothstep(0.030, 0.085, step));

    if (zeros >= 8){
      // empty-space search on the erosion-free (conservative, upper-bound) field.
      // Nubis 2017 slide 73: x2 on a miss, and step BACK one on the first hit, or you
      // punch a hole in the leading face of every cloud.
      float dc = cloudDensity(p, h, 0.0, 0.0, edge);
      if (dc > 0.0){ zeros = 0; t -= srch; continue; }
      t += srch * 2.0;
      continue;
    }

    // The cheap erosion-free density does double duty: it is the space-skip test AND it
    // is exactly the low-LOD 'ds_lodded' the 2017 in-scatter probability wants.
    float dsLod = cloudDensity(p, h, 0.0, 0.0, edge);
    if (dsLod <= 0.0){ zeros++; t += step; continue; }
    float d = cloudDensity(p, h, ero, coarse, edge);
    if (d <= 0.0){ zeros++; t += step; continue; }
    zeros = 0;

    float sigmaE = d * uExtinction;
    float sigmaS = sigmaE * uAlbedo;

    float od = lightMarch(p, uLightStep, ero, edge);
    float tauL = od * uExtinction;

    // Multiple-scattering octaves (Wrenninge Eq.1 / Frostbite Eq.19-20): scattering,
    // extinction and phase eccentricity each decay geometrically, and every octave
    // reuses the SINGLE light-march result. Octave 0 is the direct beam; 1 and 2 stand
    // in for the diffusion that keeps a real cloud interior luminous rather than slate.
    //
    // Frostbite's energy-conservation condition is a <= b. The shipped build had the
    // scattering decay (0.78) ABOVE the extinction decay (0.32), i.e. it manufactured
    // energy, and then multiplied the result by a x2 powder and a x2.4 hand fit on top.
    // Three stacked multi-scatter boosts is what produced clouds that were somehow both
    // duller AND greyer-cored than the reference.
    // ds_lodded must be the DIMENSIONLESS [0,1] density fraction the 2017 slide assumes,
    // not our density*uDensity, or pow(ds, e) is raised on a number that can exceed 1 and
    // the term brightens where it should darken.
    float inScat = inScatterProbability(h, clamp(dsLod / max(uDensity, 1e-4), 0.0, 1.0), tauL);
    // More octaves than Frostbite's three, and the reason is the extinction. Frostbite's
    // "N > 4 adds nothing" holds for their sigma_t; at the physically correct 50/km the
    // light march saturates completely — a sample 50 m inside the sunward face already
    // has tau = 40, so exp(-tau * b^n) is numerically zero for every low octave and the
    // interior is lit by ambient alone. That is the textbook "grey, dirty, smoke-like"
    // single-scatter failure, and it is what the measurement said: body p50 57 codes
    // under the reference hero cloud while p90/p99 were already OVER it.
    //
    // The octave that matters is the one whose effective extinction sigma_e * b^n has an
    // optical depth of order 1 over the light-march reach. At b = 0.62 that is n = 7
    // (50 * 0.62^7 = 1.75 /km, tau ~ 1.4 over 0.8 km). Below that the term is zero; at
    // that order it is the whole interior. Every octave reuses the SINGLE light-march
    // result, so this costs ALU and nothing else.
    vec3 sun = vec3(0.0);
    float a = 1.0, b = 1.0, c = 1.0;
    for (int o = 0; o < 10; o++){
      if (float(o) >= uMSN) break;
      // widen the lobe per octave by lerping toward isotropic: without it the silver
      // lining leaks onto clouds nowhere near the sun.
      float ph = mix(0.0795774715, phaseMie(cosT), c);
      sun += vec3(a * exp(-tauL * b) * ph);
      a *= uMSa; b *= uMSb; c *= uMSc;
    }
    sun *= inScat;
    // Optional legacy Beer-Powder, defaulted OFF. research/clouds.md 3.5 is explicit
    // that the 2017 in-scatter probability above is its REPLACEMENT, not its companion,
    // and that the 2015 constants could not be verified against a primary source.
    if (uPowder > 0.0){
      float powder = 1.0 - exp(-tauL * 2.0);
      sun *= mix(1.0, powder, uPowder * clamp(-cosT * 0.5 + 0.5, 0.0, 1.0));
    }
    sun *= uScatterGain;

    vec3 amb = mix(uAmbBottom, uAmbTop, clamp(h, 0.0, 1.0)) * uAmbGain;
    // Ambient floor. At 0.12 nothing in the sky region could ever go dark: a fully
    // buried cumulus base still collected 12% of the open-sky term and bottomed out
    // around 120 codes, against 60-90 for a shaded flank in the reference. A base that
    // has 2 km of its own cloud overhead sees essentially no sky.
    amb *= uAmbFloor + (1.0 - uAmbFloor) * exp(-ambientMarch(p, normalize(p)) * uExtinction * 0.85);
    // Frostbite 5.5.1: weight ambient by a bottom-to-top gradient, biased to [a, 1] to
    // stand in for ground bounce. Without it cloud undersides are as bright as their
    // tops and the "cumulus" reading is gone. Kept gentle on purpose: the 2017 vertical
    // in-scatter probability above is already darkening the base, and stacking a second
    // base-darkener on it is the same mistake as stacking two multi-scatter boosts.
    amb *= mix(0.58, 1.0, clamp(h * 2.0, 0.0, 1.0));

    vec3 S = (sunCol * sun + amb) * sigmaS;
    float Tstep = exp(-sigmaE * step);
    scatter += trans * (S - S * Tstep) / max(sigmaE, 1e-5);

    float absorbed = trans * (1.0 - Tstep);
    distAccum += absorbed * t;
    weightAccum += absorbed;
    trans *= Tstep;
    t += step;
  }

  float opacity = 1.0 - trans;
  if (opacity <= 0.0005){ oCol = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Aerial perspective over the mean cloud distance.
  //
  // A cloud at distance d replaces a column of air that would otherwise have scattered
  // light toward us. Approximating the air's in-scatter over 0..d as L_sky*(1 - Tatm),
  // the correct composite is
  //     L_out = L_cloud*Tatm*opacity + L_sky*(1 - opacity*Tatm)
  // which in this buffer's (radiance, transmittance) encoding is exactly
  //     L' = L*Tatm            T' = 1 - opacity*Tatm
  // So the sky dome behind supplies the haze colour, per pixel, in the right direction,
  // for free. Mixing toward a single uniform horizon colour instead — which is what
  // this did first — painted the far deck as a hard white strip that was brighter than
  // the sky it sat in, because one sampled direction cannot stand in for the whole
  // horizon. Nothing here needs the sky's LUT parameterisation duplicated.
  float dist = distAccum / max(weightAccum, 1e-5);
  float Tatm = exp(-dist * uHazeK);
  scatter *= Tatm;
  trans = 1.0 - opacity * Tatm;
  opacity = 1.0 - trans;

  // Fade the very far deck out entirely so the band terminates instead of ending in a
  // hard line where the march distance is clamped.
  float fade = 1.0 - smoothstep(uMaxDist * 0.72, uMaxDist, dist);
  scatter *= fade;
  trans = mix(1.0, trans, fade);

  oCol = vec4(scatter, clamp(trans, 0.0, 1.0));
}
`;

/* ---------------------------------------------- 5. reprojected temporal resolve */

const RESOLVE_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform sampler2D tNew;
uniform sampler2D tHist;
uniform vec3  uFwd, uRight, uUp;
uniform mat3  uPrevRot;        // world -> previous view rotation
uniform float uTanHalf, uAspect;
uniform float uBlend;
uniform float uMoving;

void main(){
  vec4 cur = texture(tNew, vUv);
  if (uBlend >= 0.999){ oCol = cur; return; }

  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + uRight * (ndc.x * uTanHalf * uAspect) + uUp * (ndc.y * uTanHalf));
  vec3 v = uPrevRot * rd;
  if (-v.z <= 1e-4){ oCol = cur; return; }
  vec2 pn = vec2(v.x / (-v.z * uTanHalf * uAspect), v.y / (-v.z * uTanHalf));
  vec2 puv = pn * 0.5 + 0.5;
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))){ oCol = cur; return; }

  vec4 hist = texture(tHist, puv);

  // While the camera turns, clamp the history into the neighbourhood of the current
  // march so a fast look does not drag a smear of last frame's cloud across the sky.
  // With a static camera the reprojection is exact and the clamp is switched off, so
  // the accumulation converges to the true mean of the dither phases.
  if (uMoving > 0.5){
    vec2 ts = 1.0 / vec2(textureSize(tNew, 0));
    vec4 lo = cur, hi = cur;
    for (int j = -1; j <= 1; j++){
      for (int i = -1; i <= 1; i++){
        vec4 s = texture(tNew, vUv + vec2(float(i), float(j)) * ts);
        lo = min(lo, s); hi = max(hi, s);
      }
    }
    vec4 ex = (hi - lo) * 0.30 + 1e-4;
    hist = clamp(hist, lo - ex, hi + ex);
  }

  oCol = mix(hist, cur, uBlend);
}
`;

/* ================================================================== the module */

export function create(opts = {}) {
  const S = {
    // Altitude, from the meteorology and not from taste. Trade-wind cumulus over
    // tropical ocean condense at an LCL of 600-700 m and are capped by the trade
    // inversion; research/clouds.md 1.1 says Guerrilla's 1500 m is already too high for
    // this weather and the shipped 2400 m was 3.7x over. The low base is most of why a
    // tropical sky reads as tropical: the clouds are CLOSE, you see their flat dark
    // undersides from below, and the horizon line cuts through them — look at kf_00000,
    // where the hero bank runs from y~120 to y~500 and a second bank recedes behind it.
    // At 2400 m nothing cut the horizon and there was no near cloud to set scale.
    baseKm: 0.65,            // cloud base = LCL, 650 m
    // 2900, not the brief's 2200. The brief's own 1.1 puts congestus tops at 2500-4000 m
    // and kf_00720's hero bank runs from the waterline to 25 deg of elevation, which a
    // 1550 m shell cannot produce at any distance. 2250 m of shell lets the congestus
    // type reach 2.1-2.9 km while the cumulus type still tops out at 1.6-2.6 km and
    // stratus at 0.9-1.3 km, so the deck keeps its uniform trade-inversion character and
    // gets hero towers on top of it.
    topKm: 2.90,             // congestus tops, 2900 m
    // Measured at the zenith band (top 12%), not at the whole sky ROI: 0.56 gave
    // frac_cloud 0.50 against 0.04 in kf_00720, and clipped 3% of a band the reference
    // never clips at all. Sensitivity is weak (0.40 -> 0.24 moves the zenith cloud
    // fraction only 0.394 -> 0.334) because the weather field is bimodal by design.
    // NOT the sky fraction — it is the position of the coverage remap window, and the
    // sky fraction it produces is what matters. The reference is not textbook scattered
    // trade cumulus — kf_00720 is one large congestus bank — so this sits above the
    // 13-19% BOMEX/RICO figure on purpose. Sweep at ref_00000, sky ROI:
    //   0.34  lum_std 32.2  lap_var 155  edge 0.0385  lab_b -12.4  hi 0.0227
    //   0.42  lum_std 38.3  lap_var 137  edge 0.0303  lab_b  -9.0  hi 0.0361
    //   ref   lum_std 47.7  lap_var 145  edge 0.0280  lab_b  -9.7  hi 0.0317
    coverage: 0.42,
    density: 1.35,
    typeBias: 0.22,

    // research/clouds.md 5: one 128^3 shape tile = 4 km, erosion at 10x the shape
    // frequency = 400 m. That sets individual cloud size at 1-2 km across, which is what
    // a trade cumulus is.
    baseTileKm: 4.0,         // horizontal world period of the 128^3 shape volume
    baseTileYKm: 2.2,        // vertical period
    detailTileKm: 0.40,      // fine world period of the 64^3 erosion volume
    coarseTileKm: 1.60,      // second, tower-scale tap of the same volume
    weatherTileKm: 30.0,     // mesoscale organisation / cloud streets
    weatherTile2Km: 12.0,    // individual cloud clusters
    weatherOffsetKm: [0, 0],

    erode: 0.22,             // Nubis' high_freq_noise_modifier * 0.2. 0.10 blobby, 0.35 lace
    edgeGain: 4.5,           // sharpness of the condensation boundary, at the finest step
    sharpen: 0.50,           // Nubis-3 pow(density, 0.3..0.6) silhouette sharpening
    shearKm: 0.40,           // cloud_top_offset: downwind lean of the tops
    curlKm: 0.35,
    lightStepKm: 0.045,      // layerThickness/36, per clayjohn; 6 samples reach ~0.8 km

    // sigma_t = 0.05 /m = 50 /km at density 1: Frostbite/Hess put cumulus in
    // [0.05, 0.12] /m, and 3*LWC/(2*rho_w*r_eff) with maritime LWC 0.3 g/m3 and
    // r_eff 10 um independently gives 0.045 /m. Mean free path 20 m, which is what sets
    // the step ceiling in stepMarch.
    extinction: 50.0,        // 1/km at density 1
    albedo: 0.995,           // water absorbs ~nothing at visible lambda; <0.85 = smoke
    // HG + Draine (Jendersie & d'Eon 2023) fitted at d = 25 um, maritime cumulus.
    phaseGH: 0.9958,
    phaseGD: 0.6033,
    phaseA: 28.60,
    phaseWD: 0.5013,
    // Frostbite Eq.20 requires the scattering decay <= the extinction decay or the
    // series manufactures energy. Skybolt and Frostbite both ship a = b = c = 0.5.
    msAtten: 0.62,           // 'a', scattering contribution decay per octave
    msContrib: 0.62,         // 'b', extinction decay per octave
    msPhase: 0.50,           // 'c', phase eccentricity decay per octave
    // Octave-count sweep at ref_00000, cloud-body mask (diff against --skip clouds),
    // against the reference hero cumulus in kf_00000 (box 760,110-1010,300):
    //   N=3   p01 35  p50 100  f110 0.527  f230 0.050   <- grey dirty cores
    //   N=6   p01 40  p50 129  f110 0.399  f230 0.065
    //   N=8   p01 58  p50 143  f110 0.271  f230 0.067   <- bases start washing out
    //   N=12  p01 73  p50 149  f110 0.197  f230 0.068
    //   ref   p01 43  p50 189  f110 0.314  f230 0.095
    // 6 is where the dark bases (p01) still match; past 8 the interiors brighten by
    // destroying the very thing the in-scatter probability was added to produce.
    msOctaves: 6,
    powder: 0.0,             // superseded by the 2017 in-scatter probability; see 3.5

    sunScale: 1.0,           // solar irradiance -> cloud source term
    // The Nubis 'brightness' argument to GetLightEnergy, and the only fitted number in
    // this shader. It is NOT optional and it is not a fudge for a missing term: a real
    // cumulus at albedo 0.995 and tau ~ 50 reflects 0.7-0.8 of the light falling on it,
    // which takes dozens of scattering orders, and a 3-octave series with a = b = 0.5
    // structurally cannot deliver that. Re-derived from scratch AFTER the 2017
    // in-scatter probability landed (the previous 2.4 was propping up a missing term).
    // Re-swept at msOctaves 6 on the cloud-body mask, against the kf_00000 hero cloud:
    //   5.0  p01 40  p50 129  p90 223  std 58.5  f230 0.065  f110 0.399
    //   8.0  p01 43  p50 144  p90 232  std 59.0  f230 0.106  f110 0.311
    //  12.0  p01 48  p50 154  p90 237  std 56.5  f230 0.147  f110 0.225
    //   ref  p01 43  p50 189  p90 230  std 63.2  f230 0.095  f110 0.314
    // 8.0 matches p01, p90, std, f230 and f110 simultaneously. p50 stays 45 codes under
    // the reference and that is the honest residual, not something the gain can fix:
    // pushing it further blows p90/p99/f230 past the reference instead.
    scatterGain: 8.0,
    ambGain: 1.0,
    ambTopScale: 1.20,
    ambFloor: 0.12,          // sky term surviving under 1.5 km of overlying cloud
    ambBottomScale: 0.45,

    hazeK: 0.030,            // 1/km aerial-perspective extinction on the deck
    // Guerrilla ship a 35 km draw radius. The cloud base's own geometric horizon at
    // 650 m is 91 km, but past ~60 km the deck is thinner than one march step and the
    // only honest thing to do with it is fade it into the haze.
    maxDistKm: 70.0,

    windScale: 1.0,
    evolveRate: 0.0022,      // km/s of vertical drift through the shape volume

    resScale: 0.5,           // march resolution relative to the frame
    // 16 taps of a running mean is a 16-wide box filter applied to a field whose entire
    // purpose (edgeGain 12) is to be a step function; it anti-aliased away the exact
    // silhouette contrast the threshold exists to create. 8 still covers the 16 dither
    // phases well enough to be stable at settle 48.
    historyFrames: 8,
  };
  Object.assign(S, opts.clouds || {});

  let ctxRef = null;
  let baseRT = null, detailRT = null, weatherRT = null;
  let marchRT = null, histRT = [null, null], histIdx = 0;
  let quad = null, marchMat = null, resolveMat = null;
  let accumN = 0;
  let w = 2, h = 2, mw = 2, mh = 2;
  let sunKey = '';

  const _prevQuat = new THREE.Quaternion();
  const _prevPos = new THREE.Vector3(1e9, 1e9, 1e9);
  const _q = new THREE.Quaternion();
  const _m3 = new THREE.Matrix3();
  const _m4 = new THREE.Matrix4();
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
  const _c = new THREE.Color(), _acc = new THREE.Color();
  const _dir = new THREE.Vector3();

  const U = {
    tBase: { value: null }, tDetail: { value: null }, tWeather: { value: null },
    tTransmittance: { value: null },
    uRo: { value: new THREE.Vector3(0, RG_KM, 0) },
    uFwd: { value: new THREE.Vector3(0, 0, -1) },
    uRight: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uTanHalf: { value: 0.81 }, uAspect: { value: 16 / 9 },
    uSunDir: { value: new THREE.Vector3(0.666, 0.656, -0.354) },
    uSunRadiance: { value: new THREE.Vector3(8, 7.6, 6.4) },
    uAmbTop: { value: new THREE.Vector3(0.3, 0.45, 0.8) },
    uAmbBottom: { value: new THREE.Vector3(0.2, 0.3, 0.55) },
    uHazeK: { value: S.hazeK },
    tGNorm: { value: null },
    uHasGNorm: { value: 0 },
    uInvGSize: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    tDepth: { value: null },
    uHasDepth: { value: 0 },
    uAmbFloor: { value: S.ambFloor },
    uBaseKm: { value: S.baseKm },
    uThickKm: { value: S.topKm - S.baseKm },
    uInvThick: { value: 1 / (S.topKm - S.baseKm) },
    uCoverage: { value: S.coverage },
    uDensity: { value: S.density },
    uTypeBias: { value: S.typeBias },
    uBaseOffset: { value: new THREE.Vector2() },
    uDetailOffset: { value: new THREE.Vector2() },
    uWeatherOffset: { value: new THREE.Vector2() },
    uWeatherOffset2: { value: new THREE.Vector2() },
    uEvolve: { value: 0 },
    uBaseFreq: { value: 1 / S.baseTileKm },
    uBaseFreqY: { value: 1 / S.baseTileYKm },
    uDetailFreq: { value: 1 / S.detailTileKm },
    uCoarseFreq: { value: 1 / S.coarseTileKm },
    uWeatherFreq: { value: 1 / S.weatherTileKm },
    uWeatherFreq2: { value: 1 / S.weatherTile2Km },
    uErode: { value: S.erode },
    uCurl: { value: S.curlKm },
    uEdgeGain: { value: S.edgeGain },
    uSharpen: { value: S.sharpen },
    uWindDir: { value: new THREE.Vector2(-1, 0) },
    uShearKm: { value: S.shearKm },
    uExtinction: { value: S.extinction },
    uAlbedo: { value: S.albedo },
    uPhaseGH: { value: S.phaseGH }, uPhaseGD: { value: S.phaseGD },
    uPhaseA: { value: S.phaseA }, uPhaseWD: { value: S.phaseWD },
    uMSa: { value: S.msAtten }, uMSb: { value: S.msContrib }, uMSc: { value: S.msPhase },
    uMSN: { value: S.msOctaves },
    uPowder: { value: S.powder },
    uAmbGain: { value: S.ambGain },
    uScatterGain: { value: S.scatterGain },
    uLightStep: { value: S.lightStepKm },
    uMaxDist: { value: S.maxDistKm },
    uTemporalJitter: { value: 0 },
    uHasTrLut: { value: 0 },
  };

  /** van der Corput base 2 — 16 exactly-spaced temporal phases. */
  function vdc16(i) {
    let n = i & 15, r = 0, f = 0.5;
    for (let b = 0; b < 4; b++) { r += (n & 1) * f; n >>= 1; f *= 0.5; }
    return r;
  }

  function renderTo(renderer, mat, rt, layer) {
    quad.material = mat;
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt, layer || 0);
    quad.render(renderer);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  }

  function make3D(size, filter) {
    const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: filter, magFilter: filter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    const t = rt.texture;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    return rt;
  }

  /** Hemispherical ambient, straight out of the sky module so the undersides pick up
   *  the same blue the atmosphere is painting. Cached against the sun key. */
  function updateAmbient(ctx) {
    const sky = ctx.get('sky');
    const time = ctx.get('time');
    if (!sky || !sky.radiance) return;
    const s = U.uSunDir.value;
    const key = `${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)}`;
    if (key === sunKey) return;
    sunKey = key;

    // upper hemisphere: zenith plus a ring at 40 deg, cosine weighted
    _acc.setRGB(0, 0, 0);
    sky.radiance(_dir.set(0, 1, 0), _c); _acc.add(_c.multiplyScalar(0.34));
    let wsum = 0.34;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      _dir.set(Math.cos(a) * 0.766, 0.643, Math.sin(a) * 0.766);
      sky.radiance(_dir, _c);
      _acc.add(_c.multiplyScalar(0.11));
      wsum += 0.11;
    }
    _acc.multiplyScalar(S.ambTopScale / wsum);
    U.uAmbTop.value.set(_acc.r, _acc.g, _acc.b);

    // lower hemisphere: horizon sky plus the ocean's own weak upwelling
    sky.horizonRadiance ? sky.horizonRadiance(_c) : sky.radiance(_dir.set(1, 0.05, 0), _c);
    U.uAmbBottom.value.set(_c.r, _c.g, _c.b).multiplyScalar(S.ambBottomScale);

    // Sun irradiance: the sky module's solar irradiance, tinted by its own sun tint.
    // The per-pixel atmospheric extinction down to cloud altitude is applied in the
    // shader from the sky's transmittance LUT when it is available.
    const su = sky.skyMaterialUniforms;
    const E = (su && su.uSolarIrradiance ? su.uSolarIrradiance.value : 9.4) * S.sunScale;
    const tint = su && su.uSunTint ? su.uSunTint.value : (time ? time.sunColor : null);
    const tr = tint ? [tint.r, tint.g, tint.b] : [1, 1, 1];
    U.uSunRadiance.value.set(E * tr[0], E * tr[1], E * tr[2]);
  }

  function invalidateHistory() { accumN = 0; }

  return {
    name: 'clouds',
    order: 25,
    enabled: true,
    settings: S,

    /** RGBA16F, half resolution. rgb = scattered radiance, a = transmittance. */
    buffer: null,
    shadowTexture: null,
    coverage: S.coverage,

    /** dev hook: the render target behind `buffer`, so a probe can read it back */
    _debugRT() { return histRT[histIdx]; },

    async init(ctx) {
      ctxRef = ctx;
      const { renderer } = ctx;
      const rnd = ctx.rand.fork ? ctx.rand.fork('clouds') : null;
      const rf = () => (rnd && rnd.next ? rnd.next() : (rnd && rnd.random ? rnd.random() : 0.5));
      const seedA = rf() * 7.0, seedB = rf() * 7.0, seedW = rf() * 7.0;

      quad = new FullScreenQuad(null);

      /* ---- 3D shape volume, 128^3 ---- */
      baseRT = make3D(128, THREE.LinearFilter);
      const baseMat = fsMaterial(BASE3D_FRAG, {
        uLayer: { value: 0 }, uRes: { value: 128 }, uSeed: { value: seedA },
      });
      for (let z = 0; z < 128; z++) { baseMat.uniforms.uLayer.value = z; renderTo(renderer, baseMat, baseRT, z); }
      baseMat.dispose();

      /* ---- 3D erosion volume, 64^3 ---- */
      detailRT = make3D(64, THREE.LinearFilter);
      const detMat = fsMaterial(DETAIL3D_FRAG, {
        uLayer: { value: 0 }, uRes: { value: 64 }, uSeed: { value: seedB },
      });
      for (let z = 0; z < 64; z++) { detMat.uniforms.uLayer.value = z; renderTo(renderer, detMat, detailRT, z); }
      detMat.dispose();

      /* ---- 2D weather map, 512^2 ---- */
      weatherRT = makeRT(512, 512, {
        type: THREE.UnsignedByteType,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      });
      const wthMat = fsMaterial(WEATHER_FRAG, {
        uSeed: { value: seedW }, uTypeBias: { value: 0.0 },
      });
      renderTo(renderer, wthMat, weatherRT, 0);
      wthMat.dispose();

      U.tBase.value = baseRT.texture;
      U.tDetail.value = detailRT.texture;
      U.tWeather.value = weatherRT.texture;

      const sky = ctx.get('sky');
      if (sky && sky.transmittanceTexture) {
        U.tTransmittance.value = sky.transmittanceTexture;
        U.uHasTrLut.value = 1;
      }

      marchMat = fsMaterial(MARCH_FRAG, U);
      resolveMat = fsMaterial(RESOLVE_FRAG, {
        tNew: { value: null }, tHist: { value: null },
        uFwd: U.uFwd, uRight: U.uRight, uUp: U.uUp,
        uPrevRot: { value: new THREE.Matrix3() },
        uTanHalf: U.uTanHalf, uAspect: U.uAspect,
        uBlend: { value: 1 }, uMoving: { value: 0 },
      });

      this.resize(ctx.size.w, ctx.size.h, ctx);
      updateAmbient(ctx);

      ctx.on('camera:teleport', invalidateHistory);
      ctx.on('config', ({ k, v }) => {
        const set = (u, val) => { U[u].value = val; invalidateHistory(); };
        if (k === 'cloudCoverage') { S.coverage = v; this.coverage = v; set('uCoverage', v); }
        if (k === 'cloudDensity') { S.density = v; set('uDensity', v); }
        if (k === 'cloudSunScale') { S.sunScale = v; sunKey = ''; invalidateHistory(); }
        if (k === 'cloudAmbGain') { S.ambGain = v; set('uAmbGain', v); }
        if (k === 'cloudScatterGain') { S.scatterGain = v; set('uScatterGain', v); }
        if (k === 'cloudAmbTopScale') { S.ambTopScale = v; sunKey = ''; invalidateHistory(); }
        if (k === 'cloudExtinction') { S.extinction = v; set('uExtinction', v); }
        if (k === 'cloudErode') { S.erode = v; set('uErode', v); }
        if (k === 'cloudEdgeGain') { S.edgeGain = v; set('uEdgeGain', v); }
        if (k === 'cloudMSN') { S.msOctaves = v; set('uMSN', v); }
        if (k === 'cloudSharpen') { S.sharpen = v; set('uSharpen', v); }
        if (k === 'cloudShearKm') { S.shearKm = v; set('uShearKm', v); }
        if (k === 'cloudAlbedo') { S.albedo = v; set('uAlbedo', v); }
        if (k === 'cloudMaxDist') { S.maxDistKm = v; set('uMaxDist', v); }
        if (k === 'cloudMS') { S.msAtten = v[0]; S.msContrib = v[1]; S.msPhase = v[2];
          U.uMSa.value = v[0]; U.uMSb.value = v[1]; U.uMSc.value = v[2]; invalidateHistory(); }
        if (k === 'cloudAmbBotScale') { S.ambBottomScale = v; sunKey = ''; invalidateHistory(); }
        if (k === 'cloudLightStep') { S.lightStepKm = v; set('uLightStep', v); }
        if (k === 'cloudPowder') { S.powder = v; set('uPowder', v); }
        if (k === 'cloudHazeK') { S.hazeK = v; set('uHazeK', v); }
        if (k === 'cloudTypeBias') { S.typeBias = v; set('uTypeBias', v); }
        if (k === 'cloudTopKm') { S.topKm = v; U.uThickKm.value = v - S.baseKm; U.uInvThick.value = 1 / (v - S.baseKm); invalidateHistory(); }
        if (k === 'cloudOffset') { S.weatherOffsetKm = v; invalidateHistory(); }
        if (k === 'cloudAmbFloor') { S.ambFloor = v; set('uAmbFloor', v); }
        if (k === 'cloudDetailTileKm') { S.detailTileKm = v; set('uDetailFreq', 1 / v); }
        if (k === 'cloudCoarseTileKm') { S.coarseTileKm = v; set('uCoarseFreq', 1 / v); }
        if (k === 'cloudBaseKm') { S.baseKm = v; U.uBaseKm.value = v; U.uThickKm.value = S.topKm - v; U.uInvThick.value = 1 / (S.topKm - v); invalidateHistory(); }
        if (k === 'cloudResScale') { S.resScale = v; mw = 0; this.resize(w, h, ctx); }
      });
    },

    update(dt, ctx) {},

    prerender(ctx) {
      if (!marchMat) return;
      if (!this.enabled) return;

      // Previous frame's occlusion: prerender runs before the pipeline draws. See the
      // integration note in the header for why one frame of latency is safe here.
      //
      // The G-buffer's normal attachment, NOT pipe.depthTex — the depth texture is shared
      // between pipe.gbuffer and pipe.sceneRT and the viewmodel's clearDepth() wipes it
      // every frame, so it carries only the gun. The G-buffer colour attachments survive.
      const pipeMod = ctx.get('pipeline');
      const pipe = pipeMod ? (pipeMod.pipe || pipeMod) : null;   // module wrapper -> RenderPipeline
      const gTex = pipe && pipe.gbuffer && pipe.gbuffer.textures ? pipe.gbuffer.textures[0] : null;
      const gReady = !!(gTex && ctx.clock.frame > 0 && pipe.w > 2);
      U.tGNorm.value = gReady ? gTex : null;
      U.uHasGNorm.value = gReady ? 1 : 0;
      if (gReady) U.uInvGSize.value.set(1 / pipe.w, 1 / pipe.h);
      // ...and the depth texture for the viewmodel, which never enters the pre-pass.
      const dTex = pipe && pipe.depthTex ? pipe.depthTex : null;
      const dReady = !!(dTex && ctx.clock.frame > 0 && dTex.image && dTex.image.width > 2);
      U.tDepth.value = dReady ? dTex : null;
      U.uHasDepth.value = dReady ? 1 : 0;

      const { renderer, camera } = ctx;
      const time = ctx.get('time');
      if (time) U.uSunDir.value.copy(time.sunDir).normalize();
      updateAmbient(ctx);

      /* ---- camera basis (un-jittered: prerender runs before the pipeline jitters) ---- */
      camera.updateMatrixWorld(true);
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      U.uFwd.value.copy(_fwd); U.uRight.value.copy(_right); U.uUp.value.copy(_up);
      U.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      U.uAspect.value = camera.aspect;
      U.uRo.value.set(camera.position.x * 0.001,
        RG_KM + Math.max(camera.position.y, 0.5) * 0.001,
        camera.position.z * 0.001);

      /* ---- advection: slow, and evolving rather than scrolling ---- */
      const t = ctx.clock.t;
      const wind = time ? time.wind : null;
      const wx = (wind ? wind.x : -4.5) * 0.001 * S.windScale;   // km/s
      const wz = (wind ? wind.z : 2.4) * 0.001 * S.windScale;
      // Unit wind direction in XZ, for the cloud_top_offset shear. Constant per frame,
      // and deterministic: it comes from time.wind, not from the clock.
      const wl = Math.hypot(wx, wz);
      if (wl > 1e-9) U.uWindDir.value.set(wx / wl, wz / wl);
      U.uBaseOffset.value.set(-wx * t, -wz * t);
      U.uDetailOffset.value.set(-wx * t * 1.9, -wz * t * 1.9);
      U.uWeatherOffset.value.set(S.weatherOffsetKm[0] - wx * t * 0.35, S.weatherOffsetKm[1] - wz * t * 0.35);
      U.uWeatherOffset2.value.set(S.weatherOffsetKm[0] * 0.31 - wx * t * 0.21 + 8.7,
        S.weatherOffsetKm[1] * 0.31 - wz * t * 0.21 - 3.4);
      U.uEvolve.value = t * S.evolveRate;

      U.uTemporalJitter.value = vdc16(ctx.clock.frame);

      /* ---- march ---- */
      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      renderer.autoClear = false;
      quad.material = marchMat;
      renderer.setRenderTarget(marchRT);
      quad.render(renderer);

      /* ---- reprojected temporal resolve ---- */
      const moved = _prevPos.distanceToSquared(camera.position) > 1e-8
        || Math.abs(_prevQuat.dot(camera.quaternion)) < 0.9999995;
      const blend = accumN <= 0 ? 1.0 : Math.max(1.0 / (accumN + 1), 1.0 / S.historyFrames);
      // world -> PREVIOUS view rotation. Rotation-only reprojection is exact for a
      // cloud deck kilometres away; translation parallax at walking speed is far below
      // a pixel, so no depth is needed and a static camera reprojects to the identity.
      _q.copy(_prevQuat).invert();
      _m4.makeRotationFromQuaternion(_q);
      _m3.setFromMatrix4(_m4);
      resolveMat.uniforms.uPrevRot.value.copy(_m3);
      resolveMat.uniforms.tNew.value = marchRT.texture;
      resolveMat.uniforms.tHist.value = histRT[histIdx].texture;
      resolveMat.uniforms.uBlend.value = blend;
      resolveMat.uniforms.uMoving.value = moved ? 1 : 0;
      const dst = 1 - histIdx;
      quad.material = resolveMat;
      renderer.setRenderTarget(histRT[dst]);
      quad.render(renderer);
      histIdx = dst;
      accumN++;

      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;

      _prevQuat.copy(camera.quaternion);
      _prevPos.copy(camera.position);

      this.buffer = histRT[histIdx].texture;
    },

    resize(w2, h2, ctx) {
      if (!quad) return;
      w = Math.max(2, w2 | 0); h = Math.max(2, h2 | 0);
      const nw = Math.max(2, Math.round(w * S.resScale));
      const nh = Math.max(2, Math.round(h * S.resScale));
      if (marchRT && nw === mw && nh === mh) return;
      mw = nw; mh = nh;
      if (marchRT) { marchRT.dispose(); histRT[0].dispose(); histRT[1].dispose(); }
      marchRT = makeRT(mw, mh);
      histRT = [makeRT(mw, mh), makeRT(mw, mh)];
      histIdx = 0;
      invalidateHistory();
      this.buffer = histRT[0].texture;
    },

    dispose(ctx) {
      marchMat?.dispose(); resolveMat?.dispose();
      baseRT?.dispose(); detailRT?.dispose(); weatherRT?.dispose();
      marchRT?.dispose(); histRT[0]?.dispose(); histRT[1]?.dispose();
      quad = null;
    },
  };
}
