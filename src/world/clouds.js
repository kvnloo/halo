import * as THREE from 'three';
import { NOISE_GLSL } from '../gfx/glsl/noise.js';
import { fsMaterial, FullScreenQuad, makeRT, LAYER } from '../render/RenderPipeline.js';

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
 * the deck curves away: near towers (3-8 km) reach 25-30 deg of elevation while the
 * far deck (40-150 km) collapses into the thin bright band that hugs the waterline in
 * kf_01800. That geometry is what makes the horizon read correctly — it is not a
 * separate "distant cloud" hack.
 *
 * ------------------------------------------------------------------ lighting
 *
 *  - Beer-Lambert extinction with a Beer-Powder term, so a sunward face is bright and
 *    the interior darkens instead of flattening.
 *  - Dual-lobe Henyey-Greenstein (g = +0.80 forward, -0.32 back). The backward lobe is
 *    what produces the silver rim on any cloud near the sun.
 *  - 3-octave multiple-scattering approximation (Wrenninge/Hillaire): extinction,
 *    contribution and eccentricity each decay by a fixed factor per octave. Without it
 *    interiors go slate-grey and dead, which is the classic amateur cloud look.
 *  - Ambient from 'ctx.get('sky').radiance()' — sampled over the hemisphere on the CPU
 *    and cached against the sun key — so shadowed undersides pick up sky blue and the
 *    cloud agrees with the atmosphere it is embedded in. The sun's own colour comes
 *    from the sky module's transmittance LUT, evaluated at cloud altitude.
 *  - Aerial perspective toward 'sky.horizonRadiance()' over the mean cloud distance,
 *    which is what turns the far deck into pale haze rather than white paint.
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
 * Adaptive stepping: a cheap (erosion-free, therefore conservative-high) density is
 * used to skip empty space at 3x the step, dropping back to fine steps on the first
 * non-zero sample. Early-out at transmittance < 0.01. Cone-sampled 6-step light march.
 *
 * ---------------------------------------------------------------- integration
 *
 * Exposes 'clouds.buffer' (rgba16f, rgb = scattered radiance, a = transmittance) for
 * the 'cloudComposite' pass. That pass is currently a pass-through stub owned by a
 * later phase, so until it announces itself ('pass.consumesClouds === true') this
 * module composites its own buffer with a full-screen quad on LAYER.SKY, drawn after
 * the sky dome and before opaque geometry with blend 'src + dst*src.a' — exactly the
 * 'scene * T + L' the buffer encodes. Clouds sit at 0.9-2.6 km altitude and everything
 * solid in this scene is inside 200 m, so "behind all geometry" is always true and no
 * depth test is needed for the fallback.
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

/* --------------------------------------------------- 2. detail erosion volume, 32^3 */

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
  // 32^3 resolves at most 8 cells per axis before the cells alias, so the erosion
  // texture stays coarse here and is sampled at a much higher world frequency instead.
  oCol = vec4(wfbm3(p, 1.0), wfbm3(p, 2.0), worley3Tiled(p, 4.0), 1.0);
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
  float sys = smoothstep(0.24, 0.78, c1);
  float cov = clamp(c2 * 0.66 + c3 * 0.34, 0.0, 1.0);
  cov = clamp(cov * (0.28 + 1.05 * sys), 0.0, 1.0);

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
uniform vec3  uHazeColor;
uniform float uHazeK;

uniform float uBaseKm, uThickKm, uInvThick;
uniform float uCoverage, uDensity, uTypeBias;
uniform vec2  uBaseOffset;    // wind advection of the shape volume (km)
uniform vec2  uDetailOffset;
uniform vec2  uWeatherOffset, uWeatherOffset2;
uniform float uEvolve;        // slow vertical evolution of the shape volume
uniform float uBaseFreq, uBaseFreqY, uDetailFreq, uWeatherFreq, uWeatherFreq2;
uniform float uErode, uCurl, uEdgeGain;

uniform float uExtinction;    // 1/km at density 1
uniform float uAlbedo;
uniform float uHGf, uHGb, uHGw;
uniform float uMSa, uMSb, uMSc;
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

float hgPhase(float c, float g){
  float g2 = g*g;
  float d = 1.0 + g2 - 2.0*g*c;
  return (1.0 - g2) / (12.5663706 * max(d, 1e-4) * sqrt(max(d, 1e-4)));
}
float dualHG(float c, float s){
  return mix(hgPhase(c, uHGf*s), hgPhase(c, uHGb*s), uHGw);
}

float heightFrac(vec3 p){
  return (length(p) - (RG + uBaseKm)) * uInvThick;
}

/** height-density profile: flat bottom, cauliflower top, type-dependent depth */
float heightGradient(float h, float ty){
  float stratus = clamp(remap(h, 0.00, 0.06, 0.0, 1.0), 0.0, 1.0)
                * clamp(remap(h, 0.14, 0.28, 1.0, 0.0), 0.0, 1.0);
  float cumulus = clamp(remap(h, 0.01, 0.16, 0.0, 1.0), 0.0, 1.0)
                * clamp(remap(h, 0.48, 0.86, 1.0, 0.0), 0.0, 1.0);
  float congest = clamp(remap(h, 0.01, 0.10, 0.0, 1.0), 0.0, 1.0)
                * clamp(remap(h, 0.72, 1.00, 1.0, 0.0), 0.0, 1.0);
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
  float cov = clamp(a.x * (0.42 + 1.30 * b.x), 0.0, 1.0);
  float ty  = clamp(a.y * 0.60 + b.y * 0.55 + uTypeBias, 0.0, 1.0);
  return vec4(cov, ty, cw * 2.0 - 1.0);
}

/** cheap = skip the erosion octaves. Erosion only ever removes density, so the cheap
 *  value is a conservative upper bound and is safe to use for empty-space skipping. */
float cloudDensity(vec3 p, float h, bool cheap){
  if (h < 0.0 || h > 1.0) return 0.0;
  vec4 w = sampleWeather(p);
  float cov = clamp(remap(w.x, 1.0 - uCoverage - 0.34, 1.0 - uCoverage + 0.36, 0.0, 1.0), 0.0, 1.0);
  if (cov <= 0.0) return 0.0;

  // Altitude, not planet-relative y: the volume must be indexed by height above the
  // ground, and 'h' already carries it exactly. The vertical axis gets its own, higher
  // frequency — a 1.7 km layer through a 13 km tile would otherwise span 13% of the
  // volume and give the deck almost no vertical structure.
  float alt = uBaseKm + h * uThickKm;
  vec3 sp = vec3((p.x + uBaseOffset.x) * uBaseFreq,
                 (alt + uEvolve) * uBaseFreqY,
                 (p.z + uBaseOffset.y) * uBaseFreq);
  vec4 b = texture(tBase, sp);
  float wf = b.y*0.625 + b.z*0.25 + b.w*0.125;
  float field = clamp(remap(b.x, wf*0.72 - 0.18, 1.0, 0.0, 1.0), 0.0, 1.0);
  field *= heightGradient(h, w.y);

  // The erosion is SUBTRACTED FROM THE FIELD, before the coverage threshold, not
  // remapped out of the finished density afterwards. That is the difference between
  // clouds with cauliflower silhouettes and clouds that look like marshmallow: the
  // iso-contour that becomes the cloud's edge then follows the 120-500 m detail octaves
  // instead of the 1.4 km shape octaves, and every lobe gets its own outline.
  if (!cheap){
    vec3 dp = vec3((p.x + uDetailOffset.x + w.z * uCurl * (1.0 - h)) * uDetailFreq,
                   (alt - uEvolve * 0.6) * uDetailFreq,
                   (p.z + uDetailOffset.y + w.w * uCurl * (1.0 - h)) * uDetailFreq);
    vec3 dt = texture(tDetail, dp).xyz;
    float df = dt.x*0.625 + dt.y*0.25 + dt.z*0.125;
    // billowy at the top, wispy near the base — the standard Nubis inversion
    float mod_ = mix(1.0 - df, df, clamp(h * 3.0, 0.0, 1.0));
    field -= mod_ * uErode * (0.30 + 0.70 * (1.0 - field));
  }

  // A hard threshold with a controlled ramp width. Real cumulus have a condensation
  // boundary a few tens of metres thick, not the 500 m gradient a linear coverage
  // remap produces, and that boundary is where all of the silhouette contrast lives.
  float d = clamp((field - (1.0 - cov)) * uEdgeGain, 0.0, 1.0);
  if (d <= 0.0) return 0.0;
  d *= mix(0.62, 1.0, cov);

  // vertical density profile: thin just above the base, thickest through the middle,
  // fraying at the very top. This is what stops the deck reading as a solid slab.
  d *= mix(0.45, 1.15, smoothstep(0.02, 0.30, h)) * mix(1.0, 0.62, smoothstep(0.72, 1.0, h));
  return d * uDensity;
}

const vec3 CONE[6] = vec3[6](
  vec3( 0.38, 0.21, 0.14), vec3(-0.29, 0.34, -0.22), vec3( 0.11, -0.37, 0.31),
  vec3(-0.34, -0.15, -0.30), vec3( 0.25, 0.09, -0.39), vec3(-0.09, 0.40, 0.19));

/** Cone-sampled 6-step march toward the sun. The span has to cover the slant path
 *  through the whole layer — 1.7 km of cloud at 41 deg of solar elevation is 2.6 km —
 *  or the underside of a tower never darkens and the deck reads as backlit paper. */
float lightMarch(vec3 p, float baseStep){
  float od = 0.0;
  float t = 0.0;
  for (int i = 0; i < 6; i++){
    float s = baseStep * (1.0 + float(i) * 0.80);
    t += s;
    vec3 q = p + uSunDir * t + CONE[i] * t * 0.24;
    float h = heightFrac(q);
    if (h > 1.02) break;
    od += cloudDensity(q, h, i > 2) * s;
  }
  // one long far tap so a tower shadows the deck beneath it
  vec3 q = p + uSunDir * (t + 2.4);
  od += cloudDensity(q, heightFrac(q), true) * 2.4 * 0.5;
  return od;
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

  float tIn  = raySphereFar(uRo, rd, RG + uBaseKm);
  float tOut = raySphereFar(uRo, rd, RG + uBaseKm + uThickKm);
  if (tOut <= 0.0) return;
  tIn = max(tIn, 0.0);
  tOut = min(tOut, uMaxDist);
  if (tOut <= tIn) return;

  float seg = tOut - tIn;
  float step = clamp(seg / 96.0, 0.018, 0.62);

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
  for (int i = 0; i < 160; i++){
    if (t > tOut || trans < 0.012) break;
    vec3 p = uRo + rd * t;
    float h = heightFrac(p);

    if (zeros >= 6){
      // empty-space search: coarse steps on the erosion-free (conservative) field
      float dc = cloudDensity(p, h, true);
      if (dc > 0.0){ zeros = 0; t -= step * 2.0; continue; }
      t += step * 3.0;
      continue;
    }

    float d = cloudDensity(p, h, false);
    if (d <= 0.0){ zeros++; t += step; continue; }
    zeros = 0;

    float sigmaE = d * uExtinction;
    float sigmaS = sigmaE * uAlbedo;

    float od = lightMarch(p, max(step, uLightStep));

    // Multiple-scattering octaves: extinction, contribution and phase eccentricity
    // each decay geometrically. Octave 0 is the direct beam; 1 and 2 stand in for
    // the diffusion that keeps a real cloud interior luminous.
    vec3 sun = vec3(0.0);
    float a = 1.0, b = 1.0, c = 1.0;
    for (int o = 0; o < 3; o++){
      float beer = exp(-od * uExtinction * a);
      sun += vec3(b * dualHG(cosT, c) * beer);
      a *= uMSa; b *= uMSb; c *= uMSc;
    }
    // Beer-Powder. Backscatter is suppressed just under an illuminated surface because
    // the light there has not scattered enough times yet, so it only shows on the side
    // of the cloud that faces the sun — i.e. when we are looking away from it.
    float powder = 1.0 - exp(-od * uExtinction * 2.0);
    sun *= mix(1.0, powder * 2.0, uPowder * clamp(-cosT * 0.5 + 0.5, 0.0, 1.0));
    // Truncating the scattering series at three octaves loses most of the high-order
    // energy. A thick cumulus actually reflects ~0.8 of the sunlight falling on it, so
    // an unshadowed top should read E*mu_sun*0.8/pi ~ 1.6 in the sky module's units;
    // the raw series lands near 0.35. uScatterGain closes exactly that gap and is the
    // one place this shader is fitted rather than derived.
    sun *= uScatterGain;

    vec3 amb = mix(uAmbBottom, uAmbTop, clamp(h, 0.0, 1.0)) * uAmbGain;
    amb *= 0.30 + 0.70 * exp(-od * uExtinction * 0.55);

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

  // Aerial perspective over the mean cloud distance. Without it the far deck is white
  // paint; the reference's horizon band is pale blue haze with almost no contrast.
  float dist = distAccum / max(weightAccum, 1e-5);
  float Tatm = exp(-dist * uHazeK);
  scatter = scatter * Tatm + uHazeColor * (1.0 - Tatm) * opacity;

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

/* --------------------------------------------------------- 6. fallback composite */

const COMPOSITE_VERT = /* glsl */`
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
uniform sampler2D tCloud;
uniform vec2  uTexel;
uniform float uDebug;
layout(location = 0) out vec4 oCol;
void main(){
  if (uDebug > 0.5){
    vec4 s = texture(tCloud, vUv);
    // 1 = radiance only, 2 = opacity as greyscale
    oCol = (uDebug < 1.5) ? vec4(s.rgb, 0.0) : vec4(vec3(1.0 - s.a) * 0.6, 0.0);
    return;
  }
  // Slightly sharpened bilinear: four half-texel taps recover a little of the edge a
  // straight upsample of a half-resolution buffer loses, without ringing.
  vec4 c = texture(tCloud, vUv);
  vec4 n = texture(tCloud, vUv + vec2( uTexel.x,  uTexel.y) * 0.5)
         + texture(tCloud, vUv + vec2(-uTexel.x,  uTexel.y) * 0.5)
         + texture(tCloud, vUv + vec2( uTexel.x, -uTexel.y) * 0.5)
         + texture(tCloud, vUv + vec2(-uTexel.x, -uTexel.y) * 0.5);
  vec4 r = c * 1.60 - n * 0.15;
  oCol = vec4(max(r.rgb, vec3(0.0)), clamp(r.a, 0.0, 1.0));
}
`;

/* ================================================================== the module */

export function create(opts = {}) {
  const S = {
    baseKm: 0.90,            // cloud base, 900 m
    topKm: 2.60,             // cloud top, 2600 m
    coverage: 0.56,
    density: 1.55,
    typeBias: 0.10,

    // A 1.7 km-deep layer whose horizontal features are 13 km across can only produce
    // pancakes. Congestus in the reference is roughly 3:1 wide-to-tall with ~1 km lobes,
    // so the shape volume's horizontal period has to come down to a few kilometres.
    baseTileKm: 5.6,         // horizontal world period of the 128^3 shape volume
    baseTileYKm: 2.6,        // vertical period
    detailTileKm: 0.95,      // world period of the 32^3 erosion volume
    weatherTileKm: 26.0,
    weatherTile2Km: 11.0,
    weatherOffsetKm: [0, 0],

    erode: 0.42,
    edgeGain: 7.0,           // sharpness of the condensation boundary
    curlKm: 0.45,
    lightStepKm: 0.11,

    extinction: 12.5,        // 1/km at density 1
    albedo: 0.985,
    hgForward: 0.82,
    hgBack: -0.32,
    hgWeight: 0.36,
    msAtten: 0.52,           // extinction decay per scattering octave
    msContrib: 0.62,
    msPhase: 0.58,
    powder: 0.62,

    sunScale: 1.0,           // solar irradiance -> cloud source term
    scatterGain: 4.2,        // closes the 3-octave truncation, see the shader
    ambGain: 1.0,
    ambTopScale: 1.20,
    ambBottomScale: 0.70,

    hazeK: 0.0125,           // 1/km aerial-perspective extinction on the deck
    hazeScale: 1.05,
    maxDistKm: 150.0,

    windScale: 1.0,
    evolveRate: 0.0022,      // km/s of vertical drift through the shape volume

    resScale: 0.5,           // march resolution relative to the frame
    historyFrames: 16,
  };
  Object.assign(S, opts.clouds || {});

  let ctxRef = null;
  let baseRT = null, detailRT = null, weatherRT = null;
  let marchRT = null, histRT = [null, null], histIdx = 0;
  let quad = null, marchMat = null, resolveMat = null;
  let compMesh = null, compMat = null;
  let accumN = 0;
  let w = 2, h = 2, mw = 2, mh = 2;
  let sunKey = '';
  let externalComposite = false;

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
    uHazeColor: { value: new THREE.Vector3(0.4, 0.55, 0.85) },
    uHazeK: { value: S.hazeK },
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
    uWeatherFreq: { value: 1 / S.weatherTileKm },
    uWeatherFreq2: { value: 1 / S.weatherTile2Km },
    uErode: { value: S.erode },
    uCurl: { value: S.curlKm },
    uEdgeGain: { value: S.edgeGain },
    uExtinction: { value: S.extinction },
    uAlbedo: { value: S.albedo },
    uHGf: { value: S.hgForward }, uHGb: { value: S.hgBack }, uHGw: { value: S.hgWeight },
    uMSa: { value: S.msAtten }, uMSb: { value: S.msContrib }, uMSc: { value: S.msPhase },
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
    U.uHazeColor.value.set(_c.r, _c.g, _c.b).multiplyScalar(S.hazeScale);

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

      /* ---- 3D erosion volume, 32^3 ---- */
      detailRT = make3D(32, THREE.LinearFilter);
      const detMat = fsMaterial(DETAIL3D_FRAG, {
        uLayer: { value: 0 }, uRes: { value: 32 }, uSeed: { value: seedB },
      });
      for (let z = 0; z < 32; z++) { detMat.uniforms.uLayer.value = z; renderTo(renderer, detMat, detailRT, z); }
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

      /* ---- fallback composite quad, LAYER.SKY, after the dome ---- */
      compMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tCloud: { value: null },
          uTexel: { value: new THREE.Vector2(1 / 960, 1 / 540) },
          uDebug: { value: 0 },
        },
        vertexShader: COMPOSITE_VERT,
        fragmentShader: COMPOSITE_FRAG,
        depthTest: false, depthWrite: false, toneMapped: false, fog: false,
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.SrcAlphaFactor,
        blendEquation: THREE.AddEquation,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        blendEquationAlpha: THREE.AddEquation,
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      compMesh = new THREE.Mesh(g, compMat);
      compMesh.name = 'cloudComposite.fallback';
      compMesh.frustumCulled = false;
      compMesh.renderOrder = -999;
      compMesh.layers.set(LAYER.SKY);
      ctx.scene.add(compMesh);

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
        if (k === 'cloudHazeScale') { S.hazeScale = v; sunKey = ''; invalidateHistory(); }
        if (k === 'cloudAmbTopScale') { S.ambTopScale = v; sunKey = ''; invalidateHistory(); }
        if (k === 'cloudExtinction') { S.extinction = v; set('uExtinction', v); }
        if (k === 'cloudErode') { S.erode = v; set('uErode', v); }
        if (k === 'cloudEdgeGain') { S.edgeGain = v; set('uEdgeGain', v); }
        if (k === 'cloudLightStep') { S.lightStepKm = v; set('uLightStep', v); }
        if (k === 'cloudPowder') { S.powder = v; set('uPowder', v); }
        if (k === 'cloudHazeK') { S.hazeK = v; set('uHazeK', v); }
        if (k === 'cloudTypeBias') { S.typeBias = v; set('uTypeBias', v); }
        if (k === 'cloudTopKm') { S.topKm = v; U.uThickKm.value = v - S.baseKm; U.uInvThick.value = 1 / (v - S.baseKm); invalidateHistory(); }
        if (k === 'cloudOffset') { S.weatherOffsetKm = v; invalidateHistory(); }
        if (k === 'cloudBaseKm') { S.baseKm = v; U.uBaseKm.value = v; U.uThickKm.value = S.topKm - v; U.uInvThick.value = 1 / (S.topKm - v); invalidateHistory(); }
        if (k === 'cloudResScale') { S.resScale = v; mw = 0; this.resize(w, h, ctx); }
        if (k === 'cloudDebug' && compMat) compMat.uniforms.uDebug.value = v;
      });
    },

    update(dt, ctx) {},

    prerender(ctx) {
      if (!marchMat) return;
      const pipeMod = ctx.get('pipeline');
      const cc = pipeMod && pipeMod.pass ? pipeMod.pass('cloudComposite') : null;
      // The cloudComposite pass is a later phase's stub. Take over only while it has
      // not announced that it consumes this buffer itself.
      externalComposite = !!(cc && cc.enabled && cc.consumesClouds);
      if (compMesh) compMesh.visible = this.enabled && !externalComposite;
      if (!this.enabled) return;

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
      if (compMat) {
        compMat.uniforms.tCloud.value = this.buffer;
        compMat.uniforms.uTexel.value.set(1 / mw, 1 / mh);
      }
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
      if (compMesh) { ctx.scene.remove(compMesh); compMesh.geometry.dispose(); }
      compMat?.dispose();
      marchMat?.dispose(); resolveMat?.dispose();
      baseRT?.dispose(); detailRT?.dispose(); weatherRT?.dispose();
      marchRT?.dispose(); histRT[0]?.dispose(); histRT[1]?.dispose();
      quad = null;
    },
  };
}
