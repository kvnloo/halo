import * as THREE from 'three';
import { NOISE_GLSL } from '../gfx/glsl/noise.js';
import { fsMaterial, FullScreenQuad, LAYER } from '../render/RenderPipeline.js';

/**
 * `sky` — atmosphere, sun disc, stars, the Halo ring arc and the Threshold gas giant.
 *
 * Structure (Hillaire "Scalable and Production Ready Sky and Atmosphere", trimmed):
 *
 *   1. transmittance LUT   256x64   built once      T(r, mu)
 *   2. multiple-scatter LUT 32x32   built once      Psi_ms(r, mu_s)   (sun-independent)
 *   3. sky-view LUT        256x256  rebuilt on sun move, MRT x2:
 *        rt0.rgb = Rayleigh in-scatter integral WITHOUT the phase function
 *        rt0.a   = Mie      in-scatter integral WITHOUT the phase function
 *        rt1.rgb = isotropic multiple-scatter contribution
 *      keeping the phase out of the LUT is what lets a 256-wide table still resolve a
 *      razor-sharp g=0.8 Mie aureole around the sun — the phase is applied per pixel.
 *   4. sky dome: one back-faced sphere on LAYER.SKY. Per pixel it composites
 *        stars -> Threshold -> Halo ring -> sun disc   (all "space" radiance)
 *      then folds them through the atmosphere:
 *        L = space*T + inscatter*(1 - T*objectCoverage)
 *      which is why the ring and Threshold dissolve into the horizon haze for free,
 *      while the sky itself (coverage 0) keeps the full in-scatter integral.
 *      A thin high-cirrus veil and a 0.3% dither go on last.
 *   5. env probe: a 128px cube of the dome, rendered from a private scene so a
 *      screen-space cloud pass on LAYER.SKY can never be dragged into it.
 *
 * Everything is linear HDR. The tonemap pass owns exposure; these values are keyed so
 * that AgX at the tonemap's own `keyedExposure()` (~0.67 for the reference rig) lands
 * on the clip's measured sky.
 *
 * Geometry note — the Halo ring is traced analytically as the inner surface of a
 * cylinder the observer is standing on, so its centre line is a great circle through
 * the zenith and its apparent width flares as 1/sin(elevation), exactly as in the
 * footage. Its azimuth (162.5 deg) and Threshold's (az 210.4, el 24.3, 25.5 deg
 * angular radius) were measured by back-projecting kf_00600 and kf_01500 through the
 * ref_00600 / ref_01500 poses — the band's screen-space edges land within 1-6 px of
 * the reference over 500 px of image. docs/WORLD.md's azimuths for these two are in a
 * different (rotated) convention and do not reproduce the footage; its elevations, the
 * sun and everything else do.
 *
 * Public API (consumed by `env`, `clouds`, `ocean`, `lighting`):
 *   radiance(dir, target?)  -> THREE.Color, linear HDR sky radiance in a direction
 *   getRenderTarget()       -> WebGLCubeRenderTarget, HalfFloat, ready to PMREM
 *   cubeTexture / transmittanceTexture / skyViewTexture / multiScatterTexture
 *   skyMaterialUniforms     -> the shared uniform block (sun dir, LUTs, tints)
 *   zenithRadiance() / horizonRadiance()
 */

const PI = Math.PI;

/* ------------------------------------------------------------------ shared GLSL */

const ATMO_GLSL = /* glsl */`
#define ATM_PI 3.14159265359
const float ATM_Rg = 6360.0;                       // km, ground
const float ATM_Rt = 6420.0;                       // km, top of atmosphere
const vec3  ATM_bR = vec3(5.802e-3, 13.558e-3, 33.100e-3);   // Rayleigh scatter /km
const float ATM_bMs = 1.900e-3;                    // Mie scatter /km
const float ATM_bMe = 2.150e-3;                    // Mie extinction /km
const vec3  ATM_bO = vec3(0.650e-3, 1.881e-3, 0.085e-3);     // ozone absorption /km
const float ATM_Hr = 8.0;
const float ATM_Hm = 1.2;

void atmDens(float h, out float dr, out float dm, out float doz){
  dr = exp(-max(h,0.0) / ATM_Hr);
  dm = exp(-max(h,0.0) / ATM_Hm);
  doz = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
}
vec3 atmExtinction(float h){
  float dr, dm, doz; atmDens(h, dr, dm, doz);
  return ATM_bR*dr + vec3(ATM_bMe*dm) + ATM_bO*doz;
}
/** nearest positive hit of a sphere of radius R centred at the origin, else -1 */
float atmRaySphere(vec3 ro, vec3 rd, float R){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R*R;
  float d = b*b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d, t1 = -b + d;
  if (t1 < 0.0) return -1.0;
  return t0 < 0.0 ? t1 : t0;
}
float phaseRayleigh(float c){ return (3.0/(16.0*ATM_PI)) * (1.0 + c*c); }
float phaseMieHG(float c, float g){
  float g2 = g*g;
  float d = 1.0 + g2 - 2.0*g*c;
  return (1.0 - g2) / (4.0*ATM_PI * max(d, 1e-4) * sqrt(max(d, 1e-4)));
}
/* Cornette-Shanks: a touch wider than HG, closer to real aerosol. */
float phaseMie(float c, float g){
  float g2 = g*g;
  float k = 3.0/(8.0*ATM_PI) * (1.0 - g2)/(2.0 + g2);
  float d = 1.0 + g2 - 2.0*g*c;
  return k * (1.0 + c*c) / max(d*sqrt(max(d,1e-4)), 1e-4);
}

/* ---- transmittance LUT parameterisation (Bruneton) ---- */
vec2 atmTrUv(float r, float mu){
  float H = sqrt(max(ATM_Rt*ATM_Rt - ATM_Rg*ATM_Rg, 1e-6));
  float rho = sqrt(max(r*r - ATM_Rg*ATM_Rg, 0.0));
  float disc = r*r*(mu*mu - 1.0) + ATM_Rt*ATM_Rt;
  float d = max(0.0, -r*mu + sqrt(max(disc, 0.0)));
  float dmin = ATM_Rt - r;
  float dmax = rho + H;
  return vec2(clamp((d - dmin)/max(dmax - dmin, 1e-6), 0.0, 1.0), clamp(rho/H, 0.0, 1.0));
}
void atmTrFromUv(vec2 uv, out float r, out float mu){
  float H = sqrt(max(ATM_Rt*ATM_Rt - ATM_Rg*ATM_Rg, 1e-6));
  float rho = H * uv.y;
  r = sqrt(rho*rho + ATM_Rg*ATM_Rg);
  float dmin = ATM_Rt - r;
  float dmax = rho + H;
  float d = dmin + uv.x*(dmax - dmin);
  mu = (d < 1e-6) ? 1.0 : (H*H - rho*rho - d*d) / (2.0*r*d);
  mu = clamp(mu, -1.0, 1.0);
}
vec3 atmSampleTr(sampler2D tex, float r, float mu){
  return texture(tex, atmTrUv(r, mu)).rgb;
}

/* ---- sky-view LUT parameterisation: (angle from the sun's meridian, elevation) ---- */
vec2 atmSkyUv(vec3 dir, vec3 sunDir){
  float el = asin(clamp(dir.y, -1.0, 1.0));
  vec2 dh = vec2(dir.x, dir.z);
  vec2 sh = vec2(sunDir.x, sunDir.z);
  float ld = length(dh), ls = length(sh);
  float cosd = (ld > 1e-5 && ls > 1e-5) ? clamp(dot(dh, sh)/(ld*ls), -1.0, 1.0) : 1.0;
  float u = acos(cosd) / ATM_PI;
  float t = el / (0.5*ATM_PI);
  float v = 0.5 + 0.5*sign(t)*sqrt(abs(t));
  return vec2(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}
vec3 atmSkyDir(vec2 uv, vec3 sunDir){
  float s = uv.y*2.0 - 1.0;
  float t = sign(s)*s*s;
  float el = t*0.5*ATM_PI;
  float az = uv.x*ATM_PI;
  vec2 sh = vec2(sunDir.x, sunDir.z);
  float l = length(sh);
  sh = (l > 1e-5) ? sh/l : vec2(0.0, 1.0);
  float ca = cos(az), sa = sin(az);
  vec2 rh = vec2(sh.x*ca - sh.y*sa, sh.x*sa + sh.y*ca);
  float ce = cos(el);
  return normalize(vec3(rh.x*ce, sin(el), rh.y*ce));
}
`;

/* --------------------------------------------------------- 1. transmittance LUT */

const TRANSMITTANCE_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
${ATMO_GLSL}
void main(){
  float r, mu;
  atmTrFromUv(vUv, r, mu);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu*mu, 0.0)), mu, 0.0);
  float tTop = atmRaySphere(ro, rd, ATM_Rt);
  float tGnd = atmRaySphere(ro, rd, ATM_Rg);
  float tMax = (tGnd > 0.0) ? tGnd : max(tTop, 0.0);

  const int N = 48;
  vec3 od = vec3(0.0);
  float dt = tMax / float(N);
  for (int i = 0; i < N; i++){
    vec3 p = ro + rd * (float(i) + 0.5) * dt;
    od += atmExtinction(length(p) - ATM_Rg) * dt;
  }
  oCol = vec4(exp(-od), 1.0);
}
`;

/* -------------------------------------------------- 2. multiple-scattering LUT */

const MULTISCATTER_FRAG = /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform sampler2D tTransmittance;
uniform float uGroundAlbedo;
${ATMO_GLSL}

const int MS_DIRS = 20;
const int MS_STEPS = 20;

void main(){
  float muS = clamp(vUv.x*2.0 - 1.0, -1.0, 1.0);
  float r = mix(ATM_Rg + 0.002, ATM_Rt - 0.002, vUv.y);
  vec3 sunDir = vec3(sqrt(max(1.0 - muS*muS, 0.0)), muS, 0.0);
  vec3 ro = vec3(0.0, r, 0.0);

  vec3 Lsum = vec3(0.0);
  vec3 Fsum = vec3(0.0);

  for (int d = 0; d < MS_DIRS; d++){
    // Fibonacci sphere
    float fi = (float(d) + 0.5) / float(MS_DIRS);
    float cz = 1.0 - 2.0*fi;
    float sz = sqrt(max(1.0 - cz*cz, 0.0));
    float ph = float(d) * 2.399963229728653;
    vec3 rd = vec3(sz*cos(ph), cz, sz*sin(ph));

    float tTop = atmRaySphere(ro, rd, ATM_Rt);
    float tGnd = atmRaySphere(ro, rd, ATM_Rg);
    bool hitGround = tGnd > 0.0;
    float tMax = hitGround ? tGnd : max(tTop, 0.0);
    if (tMax <= 0.0) continue;

    vec3 L = vec3(0.0), F = vec3(0.0), T = vec3(1.0);
    float dt = tMax / float(MS_STEPS);
    for (int i = 0; i < MS_STEPS; i++){
      vec3 p = ro + rd * (float(i) + 0.5) * dt;
      float rp = length(p);
      float h = rp - ATM_Rg;
      float dr, dm, doz; atmDens(h, dr, dm, doz);
      vec3 sc = ATM_bR*dr + vec3(ATM_bMs*dm);
      vec3 ex = ATM_bR*dr + vec3(ATM_bMe*dm) + ATM_bO*doz;

      float muSp = dot(p/rp, sunDir);
      float shadow = (atmRaySphere(p, sunDir, ATM_Rg) > 0.0) ? 0.0 : 1.0;
      vec3 Tsun = atmSampleTr(tTransmittance, rp, muSp) * shadow;

      vec3 stepT = exp(-ex*dt);
      vec3 safeEx = max(ex, vec3(1e-8));
      // in-scattering, integrated analytically over the segment
      vec3 S = sc * Tsun * (1.0/(4.0*ATM_PI));
      L += T * (S - S*stepT) / safeEx;
      // scattering transfer (the "how much of an isotropic ambient comes back" term)
      F += T * (sc - sc*stepT) / safeEx;
      T *= stepT;
    }
    if (hitGround){
      vec3 p = ro + rd * tMax;
      float muSp = dot(normalize(p), sunDir);
      if (muSp > 0.0){
        vec3 Tsun = atmSampleTr(tTransmittance, ATM_Rg, muSp);
        L += T * Tsun * muSp * uGroundAlbedo / ATM_PI;
      }
    }
    Lsum += L;
    Fsum += F;
  }
  Lsum /= float(MS_DIRS);
  Fsum /= float(MS_DIRS);
  // geometric series over infinite scattering orders
  vec3 psi = Lsum / max(vec3(1.0) - Fsum, vec3(1e-4));
  oCol = vec4(psi, 1.0);
}
`;

/* ------------------------------------------------------------- 3. sky-view LUT */

const SKYVIEW_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oRayMie;   // rgb = Rayleigh (no phase), a = Mie (no phase)
layout(location = 1) out vec4 oMulti;    // rgb = isotropic multiple scattering
uniform sampler2D tTransmittance;
uniform sampler2D tMultiScatter;
uniform vec3  uSunDir;
uniform float uCamAltKm;
uniform float uGroundAlbedo;
uniform vec3  uGroundTint;
${ATMO_GLSL}

const int SV_STEPS = 40;

vec3 sampleMs(float r, float muS){
  vec2 uv = vec2(muS*0.5 + 0.5, clamp((r - ATM_Rg)/(ATM_Rt - ATM_Rg), 0.0, 1.0));
  return texture(tMultiScatter, uv).rgb;
}

void main(){
  vec3 dir = atmSkyDir(vUv, uSunDir);
  float r = ATM_Rg + max(uCamAltKm, 0.0004);
  vec3 ro = vec3(0.0, r, 0.0);
  // rebuild the sun in this local frame so the LUT stays 2-D
  vec3 sunL = normalize(vec3(sqrt(max(1.0 - uSunDir.y*uSunDir.y, 0.0)), uSunDir.y, 0.0));
  // dir came back in world space; rotate it into the local frame the same way
  {
    vec2 sh = vec2(uSunDir.x, uSunDir.z);
    float l = length(sh);
    sh = (l > 1e-5) ? sh/l : vec2(0.0, 1.0);
    vec2 dh = vec2(dir.x, dir.z);
    // component along / perpendicular to the sun's horizontal direction
    float a = dot(dh, sh);
    float b = length(dh - sh*a);
    dir = vec3(a, dir.y, b);   // x = toward the sun, z = across
    dir = normalize(dir);
    sunL = normalize(vec3(sqrt(max(1.0 - uSunDir.y*uSunDir.y, 0.0)), uSunDir.y, 0.0));
    // in this frame the sun's horizontal component points down +x
  }

  float tTop = atmRaySphere(ro, dir, ATM_Rt);
  float tGnd = atmRaySphere(ro, dir, ATM_Rg);
  bool hitGround = tGnd > 0.0;
  float tMax = hitGround ? tGnd : max(tTop, 0.0);

  vec3 Lr = vec3(0.0);
  float Lm = 0.0;
  vec3 Lms = vec3(0.0);
  vec3 T = vec3(1.0);

  if (tMax > 0.0){
    for (int i = 0; i < SV_STEPS; i++){
      // quadratic step distribution: dense near the camera where density is highest
      float t0 = float(i) / float(SV_STEPS);
      float t1 = float(i + 1) / float(SV_STEPS);
      t0 *= t0; t1 *= t1;
      float ta = t0 * tMax, tb = t1 * tMax;
      float dt = tb - ta;
      if (dt <= 0.0) continue;
      vec3 p = ro + dir * (ta + dt*0.5);
      float rp = length(p);
      float h = rp - ATM_Rg;
      float dr, dm, doz; atmDens(h, dr, dm, doz);
      vec3 scR = ATM_bR*dr;
      float scM = ATM_bMs*dm;
      vec3 ex = ATM_bR*dr + vec3(ATM_bMe*dm) + ATM_bO*doz;

      float muSp = dot(p/rp, sunL);
      float shadow = (atmRaySphere(p, sunL, ATM_Rg) > 0.0) ? 0.0 : 1.0;
      vec3 Tsun = atmSampleTr(tTransmittance, rp, muSp) * shadow;
      vec3 psi = sampleMs(rp, muSp);

      vec3 stepT = exp(-ex*dt);
      vec3 safeEx = max(ex, vec3(1e-8));
      vec3 iw = (vec3(1.0) - stepT) / safeEx;      // integral of exp(-ex s) over the step

      Lr  += T * scR * Tsun * iw;
      Lm  += (T.g * scM * Tsun.g * iw.g);
      Lms += T * (scR + vec3(scM)) * psi * iw;
      T *= stepT;
    }
    if (hitGround){
      vec3 p = ro + dir * tMax;
      float muSp = dot(normalize(p), sunL);
      vec3 g = vec3(0.0);
      if (muSp > 0.0){
        vec3 Tsun = atmSampleTr(tTransmittance, ATM_Rg, muSp);
        g = Tsun * muSp * uGroundAlbedo / ATM_PI;
      }
      g += sampleMs(ATM_Rg, muSp) * uGroundAlbedo;
      Lms += T * g * uGroundTint;
    }
  }

  oRayMie = vec4(Lr, Lm);
  oMulti  = vec4(Lms, 1.0);
}
`;

/* ------------------------------------------------------------------ 4. sky dome */

const DOME_VERT = /* glsl */`
out vec3 vDir;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DOME_FRAG = /* glsl */`
precision highp float;
in vec3 vDir;
layout(location = 0) out vec4 oColor;

uniform sampler2D tTransmittance;
uniform sampler2D tSkyRayMie;
uniform sampler2D tSkyMulti;

uniform vec3  uSunDir;
uniform vec3  uSunTint;
uniform float uSolarIrradiance;
uniform float uSunAngularRadius;
uniform float uSunDiscRadiance;
uniform float uCamAltKm;
uniform float uMieG;
uniform vec3  uAtmTint;

uniform float uStarStrength;
uniform float uStarDensity;
uniform vec2  uCirrusOffset;
uniform float uCirrusStrength;
uniform vec3  uCirrusColor;

uniform vec3  uRingAxis;        // horizontal, across the band's width
uniform vec3  uRingEast;        // horizontal, along the circumference
uniform float uRingRadiusKm;
uniform float uRingHalfWidthKm;
uniform float uRingWidthOffset; // where the observer sits across the band, -1..1
uniform float uRingBrightness;
uniform float uRingHazeK;
uniform vec3  uRingHazeColor;
uniform float uRingOpacity;
uniform float uRingSeed;

uniform vec3  uPlanetDir;
uniform vec3  uPlanetAxis;
uniform float uPlanetCosAng;    // cos of the angular radius
uniform float uPlanetBrightness;
uniform float uPlanetTerminator;
uniform float uPlanetLimbHaze;
uniform float uPlanetAtmo;
uniform float uPlanetAuroraq;
uniform vec3  uPlanetColA;
uniform vec3  uPlanetColB;
uniform vec3  uPlanetColC;
uniform vec3  uPlanetColD;
uniform float uPlanetSeed;

/* ctx.config.skyDebugMode: 1 Rayleigh only, 2 Mie only, 3 multi-scatter only,
 * 4 transmittance, 5/6/7 the raw sky-view LUT channels. 0 = normal. */
uniform float uDebugMode;
uniform float uMsScale;
uniform float uMieScale;

${ATMO_GLSL}
${NOISE_GLSL}

/* ------------------------------------------------------------------ stars */
float starCellHash(vec2 c, float s){ return hash12(c + vec2(s, s*1.7)); }

vec3 stars(vec3 dir, float px){
  // cube-face parameterisation: cheap, seams land between pixels
  vec3 ad = abs(dir);
  vec2 uv; float face;
  if (ad.x >= ad.y && ad.x >= ad.z){ uv = dir.yz / ad.x; face = dir.x > 0.0 ? 0.0 : 1.0; }
  else if (ad.y >= ad.z){ uv = dir.xz / ad.y; face = dir.y > 0.0 ? 2.0 : 3.0; }
  else { uv = dir.xy / ad.z; face = dir.z > 0.0 ? 4.0 : 5.0; }

  vec2 g = uv * uStarDensity;
  vec2 gi = floor(g), gf = fract(g);
  vec3 acc = vec3(0.0);
  float cell = 2.0 / uStarDensity;                 // cell size in uv units
  for (int j = -1; j <= 1; j++){
    for (int i = -1; i <= 1; i++){
      vec2 o = vec2(float(i), float(j));
      vec2 id = gi + o + face*37.0;
      float h0 = starCellHash(id, 1.0);
      if (h0 > 0.26) continue;                     // most cells are empty
      vec2 pos = o + vec2(starCellHash(id, 5.0), starCellHash(id, 9.0));
      float d = length((gf - pos) * cell);          // angular-ish distance
      float mag = starCellHash(id, 13.0);
      float bright = pow(mag, 4.0)*0.95 + 0.05;
      float rad = px * (0.60 + 0.85*pow(mag, 9.0));
      float core = exp(-(d*d) / (rad*rad));
      float halo = 0.055 * exp(-(d) / (rad*2.2));
      vec3 tint = mix(vec3(0.80, 0.92, 1.22), vec3(1.02, 1.0, 0.99), starCellHash(id, 21.0)*0.55);
      acc += tint * bright * (core + halo);
    }
  }
  return acc * uStarStrength;
}

/* ------------------------------------------------------------ high cirrus */
/* The reference's deep sky is not clean: there is a thin, sheared ice veil at
 * altitude that carries most of its high-frequency energy up there. It belongs to
 * the atmosphere rather than to the cumulus deck, so it lives here. */
float cirrusVeil(vec3 dir){
  if (dir.y < 0.015) return 0.0;
  vec2 p = dir.xz / max(dir.y, 0.015) * 1.25 + uCirrusOffset;

  // A fixed 2.5:1 anisotropy with no rotation and no scale variation produced a field
  // of visually identical almond filaments, all at the same angle and the same length,
  // tiled uniformly across the hemisphere - they read as dirt on the lens rather than
  // as weather. Three fixes: rotate the noise frame by a low-frequency field so the
  // streaks follow a flow, jitter the anisotropy per region so they are not all the
  // same lozenge, and gate the whole thing behind a sparse sheet mask so filaments
  // cluster into two or three sheets instead of covering the sky.
  float rot = fbm2(p*0.08 + 57.0, 3) * 2.4;
  float cs = cos(rot), sn = sin(rot);
  mat2 R = mat2(cs, -sn, sn, cs);
  vec2 pr = R * p;

  // per-region anisotropy: blend a stretched frame against a squatter one
  float aniso = fbm2(p*0.13 + 71.0, 2) * 0.5 + 0.5;
  vec2 sA = vec2(0.62, 1.55), sB = vec2(1.40, 3.20);
  vec2 sc = mix(sA, sB, aniso);

  float w = fbm2(pr*0.42 + 3.3, 3);
  float v = fbm2(pr*sc + w*1.10 + 9.1, 5);
  float f = fbm2(vec2(pr.x*1.60, pr.y*4.40) + w*0.7 + 21.0, 4);
  float m = smoothstep(0.26, 0.58, v*0.74 + f*0.44);

  // sheet mask: only a couple of broad regions carry cirrus at all
  float sheet = smoothstep(0.10, 0.46, fbm2(p*0.055 + 137.0, 3)*0.5 + 0.5);

  return m * sheet * smoothstep(0.03, 0.34, dir.y)
           * smoothstep(7.0, 2.4, length(p - uCirrusOffset));
}

/* -------------------------------------------------------------- Halo ring */
struct RingHit { float t; float a; float theta; vec3 n; bool hit; };

RingHit ringTrace(vec3 dir){
  RingHit h;
  h.hit = false; h.t = 0.0; h.a = 0.0; h.theta = 0.0; h.n = vec3(0.0,1.0,0.0);
  float du = dir.y;                               // dot(dir, up)
  if (du <= 1e-4) return h;
  vec3 A = uRingAxis;
  vec3 e = dir - dot(dir, A)*A;
  float e2 = dot(e, e);
  if (e2 < 1e-6) return h;
  float R = uRingRadiusKm;
  float t = 2.0*R*du / e2;
  if (t <= 0.0) return h;
  float a = t*dot(dir, A) + uRingWidthOffset*uRingHalfWidthKm;
  h.t = t; h.a = a;
  float sinHalf = clamp(t/(2.0*R), 0.0, 1.0);
  h.theta = 2.0*asin(sinHalf);
  vec3 up = vec3(0.0, 1.0, 0.0);
  h.n = -(t*e - R*up) / R;
  h.hit = abs(a) <= uRingHalfWidthKm;
  return h;
}

vec3 ringSurface(float s, float v, out float lum){
  // s: arc length along the circumference (km), v: across the band, -1..1.
  // One unit = 300 km, so continents land at the right scale and the finest octave
  // resolves individual weather systems rather than noise.
  // s: arc length along the circumference (km), v: across the band, -1..1.
  // The divisor was 300 km, so with the 0.27 multiplier below one noise period spanned
  // ~1100 km while the band is only 520 km wide - the entire band width fell inside a
  // quarter of one period, which is exactly why it read as a uniform pastel wash with
  // no continents. 80 km per unit puts ~1.7 continent/ocean cycles across the band.
  vec2 q = vec2(s, v*uRingHalfWidthKm) / 115.0 + vec2(uRingSeed, uRingSeed*0.37);

  float cont = warpedFbm2(q*0.24, 4, 1.55);
  float shelf = smoothstep(-0.035, 0.045, cont);
  float land  = smoothstep(0.080, 0.155, cont);
  float alt   = smoothstep(0.150, 0.310, cont);

  // Seen through the ring's own air the ocean reads as a muted cyan-navy. It must go
  // DARKER than the surrounding sky - previously the band's darkest pixel was brighter
  // than the sky behind it, so the whole strip floated instead of reading as terrain.
  vec3 deep    = vec3(0.011, 0.044, 0.104);
  vec3 shallow = vec3(0.150, 0.360, 0.455);
  vec3 grass   = vec3(0.205, 0.300, 0.225);
  vec3 dry     = vec3(0.430, 0.395, 0.290);
  vec3 rock    = vec3(0.480, 0.470, 0.445);

  vec3 c = mix(deep, shallow, shelf);
  vec3 ground = mix(grass, dry, fbm2(q*0.62 + 11.0, 3)*0.5 + 0.5);
  ground = mix(ground, rock, alt*0.7);
  c = mix(c, ground, land);

  // inland seas and river systems scratched into the land
  float riv = 1.0 - smoothstep(0.0, 0.075, abs(ridged2(q*0.38 + 4.3, 2) - 0.58));
  c = mix(c, shallow*0.9, riv*land*0.7);

  // Cloud deck: compact bright clumps sheared along the circumference. In the
  // reference these are the only genuinely white thing on the band; everything else
  // is translucent pale cyan.
  vec2 cq = vec2(q.x*0.55, q.y*0.95);
  float cw = fbm2(cq*0.70 + 21.0, 3);
  float cb = fbm2(cq*0.62 + vec2(cw*1.6, cw*0.4) + 51.0, 4);
  float cd = fbm2(cq*0.90 + vec2(cw*0.8, 0.0) + 77.0, 3);   // popcorn cumulus
  float cm = smoothstep(0.110, 0.295, cb*0.78 + cd*0.55);
  // Cloud tops are the only thing on the band that should reach white and clip.
  vec3 cloud = vec3(2.55, 3.05, 3.80);

  // The global overcast veil lifted the whole band's floor, flattening the sea/land
  // contrast that carries most of its structure. Keep a trace of it, no more.
  c = mix(c, cloud*0.30, smoothstep(-0.09, 0.30, cb) * 0.09);
  c = mix(c, cloud, cm);
  c = mix(c, cloud*1.12, cm * smoothstep(0.20, 0.52, cd) * 0.55);

  // Large-scale weather / illumination banding. Widened: the old 0.74+0.52 range both
  // lifted the floor and capped the ceiling, so nothing was ever dark or ever clipped.
  c *= 0.50 + 1.02*(fbm2(q*0.14 + 91.0, 3)*0.5 + 0.5);

  lum = dot(c, vec3(0.30, 0.59, 0.11));
  return c;
}

/* --------------------------------------------------------- Threshold */
vec3 planetSurface(vec3 n, out float detail){
  vec3 ax = normalize(uPlanetAxis);
  vec3 bx = normalize(cross(ax, vec3(0.0, 0.0, 1.0) + vec3(0.13, 0.0, 0.0)));
  vec3 bz = cross(ax, bx);
  float lat = asin(clamp(dot(n, ax), -1.0, 1.0));
  float lon = atan(dot(n, bz), dot(n, bx));

  vec2 q = vec2(lon*1.05, lat*2.2) + uPlanetSeed;
  // Two-level domain warp: turbulent belts instead of stripes.
  // The finest warp term used to run at 2.30 with 3 octaves, which at ~900 px of
  // on-screen disc diameter resolves nothing below ~40 px - the disc measured 3x short
  // on fine structure. Push the second warp up in frequency and depth.
  vec2 w1 = vec2(fbm2(q*0.85 + 3.7, 5), fbm2(q*0.85 + 9.1, 5));
  vec2 w2 = vec2(fbm2(q*5.40 + w1*1.1 + 17.3, 6), fbm2(q*5.40 + w1*1.1 + 27.9, 6));
  float y = lat*7.0 + 1.30*w1.y + 0.40*w2.y;

  float b1 = 0.5 + 0.5*sin(y*1.30);
  float b2 = 0.5 + 0.5*sin(y*3.10 + 1.7);
  float b3 = 0.5 + 0.5*sin(y*7.90 + 4.1);
  float b4 = 0.5 + 0.5*sin(y*18.0 + 2.0);       // fine striation

  vec3 c = mix(uPlanetColA, uPlanetColB, smoothstep(0.06, 0.94, b1));
  c = mix(c, uPlanetColC, b2*0.38);
  c = mix(c, uPlanetColD, smoothstep(0.62, 1.30, abs(lat)));
  c *= 0.93 + 0.12*b3;
  c *= 0.975 + 0.055*b4;
  c *= 0.92 + 0.16*(fbm2(q*0.42 + 61.0, 4)*0.5 + 0.5);
  // Fine filamentary shear - the octaves that carry the disc's high-frequency detail.
  c *= 0.955 + 0.090*(fbm2(q*3.10 + w2*0.9 + 131.0, 5)*0.5 + 0.5);
  c *= 0.978 + 0.044*(ridged2(q*7.40 + w2*1.4 + 203.0, 4));

  // storm ovals and shear wisps
  float storm = ridged2(q*1.1 + w2*0.5 + 40.0, 3);
  c = mix(c, uPlanetColB*1.14, smoothstep(0.70, 0.97, storm)*0.30);
  detail = b1*0.5 + b2*0.3 + storm*0.2;
  return c;
}

/* ================================================================== main */
void main(){
  vec3 dir = normalize(vDir);
  float r = ATM_Rg + max(uCamAltKm, 0.0004);

  /* ---- atmosphere: in-scatter from the LUT with exact per-pixel phases ---- */
  vec2 svUv = atmSkyUv(dir, uSunDir);
  vec4 rm = texture(tSkyRayMie, svUv);
  vec3 ms = texture(tSkyMulti, svUv).rgb;
  float cosT = dot(dir, uSunDir);
  vec3 termR = rm.rgb * phaseRayleigh(cosT);
  vec3 termM = vec3(rm.a) * phaseMie(cosT, uMieG) * uMieScale;
  vec3 termS = ms * uMsScale;
  if (uDebugMode > 0.5){
    if (uDebugMode < 1.5) { termM = vec3(0.0); termS = vec3(0.0); }
    else if (uDebugMode < 2.5) { termR = vec3(0.0); termS = vec3(0.0); }
    else if (uDebugMode < 3.5) { termR = vec3(0.0); termM = vec3(0.0); }
  }
  vec3 inscatter = (termR + termM + termS) * uSolarIrradiance * uSunTint;
  inscatter *= uAtmTint;

  vec3 Tview = atmSampleTr(tTransmittance, r, clamp(dir.y, -1.0, 1.0));
  if (dir.y < 0.0){
    // below the horizon the transmittance LUT parameterisation degenerates; the
    // ground blocks everything anyway.
    Tview *= smoothstep(-0.02, 0.0, dir.y);
  }

  /* ---- "space" content, composited back to front ---- */
  float pxAng = max(fwidth(dir.x) + fwidth(dir.y) + fwidth(dir.z), 1e-5) * 0.6;
  vec3 space = stars(dir, max(pxAng, 6.0e-4));
  float coverage = 0.0;

  /* -- Threshold -- */
  float cp = dot(dir, uPlanetDir);
  if (cp > uPlanetCosAng - 0.06){
    float sinA = sqrt(max(1.0 - uPlanetCosAng*uPlanetCosAng, 1e-8));
    float D = 1.0;
    float Rp = D*sinA;
    float disc = D*D*(cp*cp - uPlanetCosAng*uPlanetCosAng);
    float aa = max(fwidth(cp), 1e-6);
    float edge = smoothstep(uPlanetCosAng - aa*1.6, uPlanetCosAng + aa*1.6, cp);
    if (disc > 0.0){
      float t = D*cp - sqrt(disc);
      vec3 n = normalize(dir*t - D*uPlanetDir);
      float detail;
      vec3 base = planetSurface(n, detail);

      float ndl = dot(n, uSunDir);
      // A 100-degree-wide terminator ramp lit the whole disc uniformly and read as a
      // flat sticker. The real terminator on a body this size is a narrow band.
      float lam = smoothstep(-0.08, 0.55, ndl);
      float shade = mix(1.0, lam, uPlanetTerminator);
      float ndv = max(dot(n, -dir), 0.0);
      float limb = mix(0.66, 1.0, pow(ndv, 0.30));

      vec3 col = base * shade * limb * uPlanetBrightness;

      // Threshold's own atmosphere. This used to mix 76% of the MID-DISC toward the
      // blue sky in-scatter, which is what bleached the body into a lavender bubble
      // (measured 40% short of the reference's chroma). Confine the wash to the outer
      // ~15% of the disc radius, and mix toward a planet-local scattering colour so
      // the body keeps its own hue instead of turning into sky.
      float limbHaze = uPlanetAtmo + pow(1.0 - ndv, 4.0) * uPlanetLimbHaze;
      vec3 planetScatter = mix(vec3(0.115, 0.086, 0.078),          // shadowed: dusty rose
                               vec3(0.290, 0.215, 0.180),          // sunward: warm haze
                               smoothstep(-0.20, 0.70, ndl));
      col = mix(col, planetScatter, clamp(limbHaze, 0.0, 1.0));
      // ...and only cross-fade to true sky inside the 2-3px antialiased edge.
      col = mix(col, inscatter * 1.12 + vec3(0.008, 0.016, 0.026),
                clamp(pow(1.0 - ndv, 26.0), 0.0, 1.0) * 0.85);

      // Thin bright limb thread, as its own additive term rather than a by-product of
      // the haze mix - that is what makes the edge read as an atmosphere seen edge-on.
      col += vec3(0.085, 0.098, 0.132) * exp(-(1.0 - ndv) * 38.0)
             * (0.35 + 1.05 * smoothstep(-0.30, 0.60, ndl));

      // Aurora: applied AFTER the haze mix (it was being washed out by it), confined to
      // a narrow angular band near the terminator rather than smeared over the limb.
      float aurBand = smoothstep(0.36, 0.06, ndv) * smoothstep(0.60, 0.06, abs(ndl - 0.06));
      float streak = fbm2(vec2(atan(dot(n, uPlanetAxis), ndv)*7.0, ndv*22.0) + uPlanetSeed, 4)*0.5 + 0.5;
      col += vec3(0.050, 0.240, 0.130) * aurBand * smoothstep(0.42, 0.92, streak) * uPlanetAuroraq;
      // a thin scattering rim, brightest on the sunward side
      float rim = pow(1.0 - ndv, 5.0);
      float sunSide = smoothstep(-0.25, 0.65, ndl);
      col += vec3(0.030, 0.075, 0.055) * rim * (0.30 + 1.15*sunSide);
      space = mix(space, col, edge);
      coverage = max(coverage, edge);
    }
    // soft outer halo so the limb never reads as a hard cut
    float halo = exp(-max(uPlanetCosAng - cp, 0.0) * 900.0);
    space += vec3(0.030, 0.052, 0.048) * halo * (1.0 - edge) * uPlanetBrightness;
  }

  /* -- Halo ring -- */
  RingHit rh = ringTrace(dir);
  if (rh.t > 0.0){
    float v = rh.a / uRingHalfWidthKm;
    float av = abs(v);
    float aaw = max(fwidth(v), 1e-4);
    float band = 1.0 - smoothstep(1.0 - aaw*2.0, 1.0 + aaw*2.0, av);
    band *= smoothstep(0.010, 0.075, dir.y);      // merge into the horizon
    if (band > 0.001){
      float s = uRingRadiusKm * rh.theta * sign(dot(dir, uRingEast));
      float lum;
      vec3 surf = ringSurface(s, v, lum);

      float ndl = dot(rh.n, uSunDir);
      float lit = mix(0.68, 1.06, smoothstep(-1.0, 1.0, ndl));
      surf *= lit * uRingBrightness;

      // The ring's own air. The view ray meets its inner surface at grazing incidence
      // cos(i) = sin(elevation), so the path through the ring's atmosphere is an
      // airmass of 1/sin(el): the band dissolves as it approaches the horizon exactly
      // the way the reference does, and stays crisp overhead.
      float am = 1.0 / max(dir.y, 0.010);
      float hz = 1.0 - exp(-uRingHazeK * pow(max(am - 1.0, 0.0), 1.4));
      vec3 hazeCol = mix(uRingHazeColor * (0.34 + 0.52*lit), inscatter * 1.05, min(1.0, 0.10 + 0.85*hz));
      surf = mix(surf, hazeCol, hz);

      // bright scattering fringe where the air is seen along the band wall
      float fringe = smoothstep(0.78, 1.0, av);
      surf += uRingHazeColor * fringe * 0.13 * (1.0 - hz*0.6);

      float alpha = band * uRingOpacity;
      space = mix(space, surf, alpha);
      coverage = max(coverage, alpha);
    }
  }

  /* -- sun disc -- */
  float ang = acos(clamp(cosT, -1.0, 1.0));
  float aaS = max(fwidth(ang), 1e-5);
  float discMask = 1.0 - smoothstep(uSunAngularRadius - aaS, uSunAngularRadius + aaS, ang);
  if (discMask > 0.0){
    float d = clamp(ang / uSunAngularRadius, 0.0, 1.0);
    float mu = sqrt(max(1.0 - d*d, 0.0));
    vec3 u = vec3(0.42, 0.56, 0.70);
    vec3 limbD = vec3(1.0) - u*(vec3(1.0) - pow(vec3(mu), vec3(0.55)));
    space += uSunDiscRadiance * limbD * uSunTint * discMask * (1.0 - coverage);
  }

  /* ---- fold space through the atmosphere ---- */
  vec3 col = space * Tview + inscatter * (1.0 - Tview*coverage);

  /* ---- high cirrus, in front of everything but the sun's own disc ---- */
  if (uCirrusStrength > 0.001){
    float cv = cirrusVeil(dir) * uCirrusStrength;
    float sunLit = 0.72 + 0.55*pow(max(cosT, 0.0), 6.0);
    col = mix(col, uCirrusColor * sunLit * mix(0.55, 1.0, clamp(Tview.g*1.3, 0.0, 1.0)), clamp(cv, 0.0, 1.0));
  }

  /* ---- 8-bit-safe dither: HDR skies band badly without it ---- */
  col *= 1.0 + (hash12(gl_FragCoord.xy) - 0.5) * 0.006;

  if (uDebugMode > 3.5){
    if (uDebugMode < 4.5) col = Tview;                 // transmittance to space
    else if (uDebugMode < 5.5) col = rm.rgb * 3.0;     // Rayleigh integral, no phase
    else if (uDebugMode < 6.5) col = vec3(rm.a) * 30.0;// Mie integral, no phase
    else col = ms * 3.0;                               // multiple scattering
  }

  col = max(col, vec3(0.0));

  oColor = vec4(col, 1.0);
}
`;

/* ============================================================== the module */

export function create(opts = {}) {
  const S = {
    /* --- placement, measured off the reference frames (see header) --- */
    ringAzimuthDeg: 162.5,     // horizon azimuth where the band rises (az = atan2(x,z))
    ringRadiusKm: 5000,
    ringWidthRatio: 0.104,     // W / R  -> 520 km band
    ringWidthOffset: 0.0,
    ringBrightness: 2.10,
    ringHazeZenithOD: 0.22,   // optical depth of the ring's own air, straight down
    ringOpacity: 0.915,

    planetAzimuthDeg: 210.4,
    planetElevationDeg: 24.3,
    planetAngularRadiusDeg: 25.5,
    planetBrightness: 0.285,
    planetAurora: 1.0,
    planetTerminator: 1.00,   // was 0.50: a 100-deg ramp lit the whole disc flat
    planetLimbHaze: 0.55,    // was 2.30: bleached 76% of the mid-disc into sky
    planetAtmo: 0.05,
    planetPoleAzDeg: 95.0,
    planetPoleElDeg: 43.0,

    solarIrradiance: 9.4,
    mieG: 0.78,
    sunDiscRadiance: 900.0,
    groundAlbedo: 0.14,
    starStrength: 0.55,
    starDensity: 56.0,
    cirrusDrift: 0.00045,
    cirrusStrength: 0.060,   // was 0.175: the streaks read as lint on the lens
    atmTint: [0.605, 0.578, 1.105],
    cubeSize: 128,
  };
  Object.assign(S, opts.sky || {});

  const uniforms = {
    tTransmittance: { value: null },
    tSkyRayMie: { value: null },
    tSkyMulti: { value: null },

    uSunDir: { value: new THREE.Vector3(0.666, 0.656, -0.354) },
    uSunTint: { value: new THREE.Color(1, 1, 1) },
    uSolarIrradiance: { value: S.solarIrradiance },
    uSunAngularRadius: { value: 0.0047 },
    uSunDiscRadiance: { value: S.sunDiscRadiance },
    uCamAltKm: { value: 0.0017 },
    uMieG: { value: S.mieG },
    uAtmTint: { value: new THREE.Vector3(...S.atmTint) },

    uStarStrength: { value: S.starStrength },
    uStarDensity: { value: S.starDensity },
    uCirrusOffset: { value: new THREE.Vector2(0, 0) },
    uCirrusStrength: { value: S.cirrusStrength },
    uCirrusColor: { value: new THREE.Vector3(1.55, 1.62, 1.78) },

    uRingAxis: { value: new THREE.Vector3(1, 0, 0) },
    uRingEast: { value: new THREE.Vector3(0, 0, 1) },
    uRingRadiusKm: { value: S.ringRadiusKm },
    uRingHalfWidthKm: { value: S.ringRadiusKm * S.ringWidthRatio * 0.5 },
    uRingWidthOffset: { value: S.ringWidthOffset },
    uRingBrightness: { value: S.ringBrightness },
    uRingHazeK: { value: S.ringHazeZenithOD },
    uRingHazeColor: { value: new THREE.Vector3(0.50, 0.78, 1.30) },
    uRingOpacity: { value: S.ringOpacity },
    uRingSeed: { value: 0 },

    uPlanetDir: { value: new THREE.Vector3(0, 0.4, -1).normalize() },
    uPlanetAxis: { value: new THREE.Vector3(0, 1, 0) },
    uPlanetCosAng: { value: Math.cos(THREE.MathUtils.degToRad(S.planetAngularRadiusDeg)) },
    uPlanetBrightness: { value: S.planetBrightness },
    uPlanetTerminator: { value: S.planetTerminator },
    uPlanetLimbHaze: { value: S.planetLimbHaze },
    uPlanetAtmo: { value: S.planetAtmo },
    uPlanetAuroraq: { value: S.planetAurora },
    uPlanetColA: { value: new THREE.Vector3(0.643, 0.247, 0.247) },
    uPlanetColB: { value: new THREE.Vector3(1.362, 0.696, 0.588) },
    uPlanetColC: { value: new THREE.Vector3(0.955, 0.361, 0.559) },
    uPlanetColD: { value: new THREE.Vector3(0.560, 0.452, 0.740) },
    uPlanetSeed: { value: 0 },

    uDebugMode: { value: 0 },
    uMsScale: { value: S.msScale ?? 1.0 },
    uMieScale: { value: S.mieScale ?? 1.0 },
  };

  let domeMesh = null, domeMat = null;
  let probeScene = null, probeMesh = null, cubeRT = null, cubeCam = null;
  let trRT = null, msRT = null, svRT = null;
  let quad = null, trMat = null, msMat = null, svMat = null;
  let _sunKey = '';
  let _ctx = null;

  /* --------------------------------------------------- CPU atmosphere (radiance) */
  const CPU = {
    Rg: 6360, Rt: 6420,
    bR: [5.802e-3, 13.558e-3, 33.100e-3],
    bMs: 3.996e-3, bMe: 4.4e-3,
    bO: [0.650e-3, 1.881e-3, 0.085e-3],
    Hr: 8, Hm: 1.2,
  };
  function cpuRaySphere(ox, oy, oz, dx, dy, dz, R) {
    const b = ox * dx + oy * dy + oz * dz;
    const c = ox * ox + oy * oy + oz * oz - R * R;
    let d = b * b - c;
    if (d < 0) return -1;
    d = Math.sqrt(d);
    const t0 = -b - d, t1 = -b + d;
    if (t1 < 0) return -1;
    return t0 < 0 ? t1 : t0;
  }
  function cpuOpticalDepth(r0, mu, out) {
    // integrate extinction from (r0, mu) to the top of the atmosphere
    const ox = 0, oy = r0, oz = 0;
    const sx = Math.sqrt(Math.max(1 - mu * mu, 0)), sy = mu, sz = 0;
    const tG = cpuRaySphere(ox, oy, oz, sx, sy, sz, CPU.Rg);
    if (tG > 0) { out[0] = out[1] = out[2] = 40; return; }
    const tT = Math.max(cpuRaySphere(ox, oy, oz, sx, sy, sz, CPU.Rt), 0);
    const N = 16, dt = tT / N;
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) * dt;
      const px = sx * t, py = oy + sy * t, pz = sz * t;
      const h = Math.sqrt(px * px + py * py + pz * pz) - CPU.Rg;
      const dr = Math.exp(-Math.max(h, 0) / CPU.Hr);
      const dm = Math.exp(-Math.max(h, 0) / CPU.Hm);
      const doz = Math.max(0, 1 - Math.abs(h - 25) / 15);
      a += (CPU.bR[0] * dr + CPU.bMe * dm + CPU.bO[0] * doz) * dt;
      b += (CPU.bR[1] * dr + CPU.bMe * dm + CPU.bO[1] * doz) * dt;
      c += (CPU.bR[2] * dr + CPU.bMe * dm + CPU.bO[2] * doz) * dt;
    }
    out[0] = a; out[1] = b; out[2] = c;
  }
  const _od = [0, 0, 0], _odv = [0, 0, 0];
  function cpuRadiance(dx, dy, dz, target) {
    const sun = uniforms.uSunDir.value;
    const r0 = CPU.Rg + Math.max(uniforms.uCamAltKm.value, 0.0004);
    const cosT = dx * sun.x + dy * sun.y + dz * sun.z;
    const pR = (3 / (16 * PI)) * (1 + cosT * cosT);
    const g = uniforms.uMieG.value, g2 = g * g;
    const dd = 1 + g2 - 2 * g * cosT;
    const pM = (3 / (8 * PI)) * ((1 - g2) / (2 + g2)) * (1 + cosT * cosT) / Math.max(dd * Math.sqrt(Math.max(dd, 1e-4)), 1e-4);

    const tG = cpuRaySphere(0, r0, 0, dx, dy, dz, CPU.Rg);
    const tT = cpuRaySphere(0, r0, 0, dx, dy, dz, CPU.Rt);
    const tMax = tG > 0 ? tG : Math.max(tT, 0);
    const N = 14;
    const L = [0, 0, 0];
    const T = [1, 1, 1];
    for (let i = 0; i < N; i++) {
      let t0 = i / N, t1 = (i + 1) / N;
      t0 *= t0; t1 *= t1;
      const ta = t0 * tMax, tb = t1 * tMax, dt = tb - ta;
      if (dt <= 0) continue;
      const t = ta + dt * 0.5;
      const px = dx * t, py = r0 + dy * t, pz = dz * t;
      const rp = Math.sqrt(px * px + py * py + pz * pz);
      const h = rp - CPU.Rg;
      const dr = Math.exp(-Math.max(h, 0) / CPU.Hr);
      const dm = Math.exp(-Math.max(h, 0) / CPU.Hm);
      const doz = Math.max(0, 1 - Math.abs(h - 25) / 15);
      const muS = (px * sun.x + py * sun.y + pz * sun.z) / rp;
      cpuOpticalDepth(rp, muS, _od);
      for (let k = 0; k < 3; k++) {
        const scR = CPU.bR[k] * dr, scM = CPU.bMs * dm;
        const ex = CPU.bR[k] * dr + CPU.bMe * dm + CPU.bO[k] * doz;
        const st = Math.exp(-ex * dt);
        const iw = (1 - st) / Math.max(ex, 1e-8);
        const Ts = Math.exp(-_od[k]);
        // single scattering + a crude isotropic multiple-scattering fill
        const ms = (scR + scM) * 0.052 * Math.exp(-_od[k] * 0.62);
        L[k] += T[k] * ((scR * pR + scM * pM) * Ts + ms) * iw;
        T[k] *= st;
      }
    }
    const E = uniforms.uSolarIrradiance.value;
    const tint = uniforms.uAtmTint.value;
    const st = uniforms.uSunTint.value;
    target = target || new THREE.Color();
    target.setRGB(L[0] * E * tint.x * st.r, L[1] * E * tint.y * st.g, L[2] * E * tint.z * st.b);
    return target;
  }

  /* ------------------------------------------------------------------ helpers */
  function dirFromAzEl(azDeg, elDeg, out) {
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
    const ce = Math.cos(el);
    return out.set(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)).normalize();
  }

  function makeLutRT(w, h, count = 1) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      count,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    for (const t of (rt.textures || [rt.texture])) t.colorSpace = THREE.NoColorSpace;
    return rt;
  }

  function renderLut(renderer, mat, rt) {
    quad.material = mat;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    quad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
  }

  const _v3 = new THREE.Vector3();

  return {
    name: 'sky',
    order: 20,
    enabled: true,
    settings: S,
    skyMaterialUniforms: uniforms,

    async init(ctx) {
      _ctx = ctx;
      const { renderer } = ctx;
      const rnd = ctx.rand.fork ? ctx.rand.fork('sky') : null;
      const rf = () => (rnd && rnd.next ? rnd.next() : (rnd && rnd.random ? rnd.random() : 0.5));
      uniforms.uRingSeed.value = 13.7 + rf() * 40.0;
      uniforms.uPlanetSeed.value = 5.3 + rf() * 40.0;

      quad = new FullScreenQuad(null);

      /* 1. transmittance */
      trRT = makeLutRT(256, 64);
      trMat = fsMaterial(TRANSMITTANCE_FRAG, {});
      renderLut(renderer, trMat, trRT);
      uniforms.tTransmittance.value = trRT.texture;

      /* 2. multiple scattering (sun-independent) */
      msRT = makeLutRT(32, 32);
      msMat = fsMaterial(MULTISCATTER_FRAG, {
        tTransmittance: { value: trRT.texture },
        uGroundAlbedo: { value: S.groundAlbedo },
      });
      renderLut(renderer, msMat, msRT);

      /* 3. sky-view (MRT: ray/mie + multi) */
      svRT = makeLutRT(256, 256, 2);
      svMat = fsMaterial(SKYVIEW_FRAG, {
        tTransmittance: { value: trRT.texture },
        tMultiScatter: { value: msRT.texture },
        uSunDir: uniforms.uSunDir,
        uCamAltKm: uniforms.uCamAltKm,
        uGroundAlbedo: { value: S.groundAlbedo },
        uGroundTint: { value: new THREE.Vector3(0.54, 0.50, 0.45) },
      });
      uniforms.tSkyRayMie.value = svRT.textures[0];
      uniforms.tSkyMulti.value = svRT.textures[1];

      /* 4. dome */
      domeMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: DOME_VERT,
        fragmentShader: DOME_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
        fog: false,
        toneMapped: false,
      });
      const geom = new THREE.SphereGeometry(1, 48, 32);
      domeMesh = new THREE.Mesh(geom, domeMat);
      domeMesh.name = 'skyDome';
      domeMesh.scale.setScalar(9000);
      domeMesh.frustumCulled = false;
      domeMesh.renderOrder = -1000;
      domeMesh.matrixAutoUpdate = true;
      domeMesh.layers.set(LAYER.SKY);
      ctx.scene.add(domeMesh);

      /* env probe: a private scene so a cloud raymarch on LAYER.SKY can't get dragged in */
      probeScene = new THREE.Scene();
      probeMesh = new THREE.Mesh(geom, domeMat);
      probeMesh.frustumCulled = false;
      probeMesh.scale.setScalar(9000);
      probeScene.add(probeMesh);
      cubeRT = new THREE.WebGLCubeRenderTarget(S.cubeSize, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      });
      cubeRT.texture.colorSpace = THREE.NoColorSpace;
      cubeCam = new THREE.CubeCamera(1.0, 20000, cubeRT);

      this.syncFromTime(ctx);
      this.updateLuts(ctx, true);
      this.renderProbe(ctx);

      ctx.on('config', ({ k, v }) => {
        if (k === 'skyDebugMode') uniforms.uDebugMode.value = v;
        if (k === 'skyMsScale') uniforms.uMsScale.value = v;
        if (k === 'skyMieScale') uniforms.uMieScale.value = v;
        if (k === 'skyIrradiance') uniforms.uSolarIrradiance.value = v;
        if (k === 'ringBrightness') uniforms.uRingBrightness.value = v;
        if (k === 'planetBrightness') uniforms.uPlanetBrightness.value = v;
        if (k === 'starStrength') uniforms.uStarStrength.value = v;
        if (k === 'ringAzimuth') { S.ringAzimuthDeg = v; this.syncFromTime(ctx); }
        if (k === 'planetAzimuth') { S.planetAzimuthDeg = v; this.syncFromTime(ctx); }
        if (k === 'planetElevation') { S.planetElevationDeg = v; this.syncFromTime(ctx); }
        if (k === 'planetAngRadius') {
          S.planetAngularRadiusDeg = v;
          uniforms.uPlanetCosAng.value = Math.cos(THREE.MathUtils.degToRad(v));
        }
      });
    },

    /** Pull sun + placement into the uniform block. */
    syncFromTime(ctx) {
      const time = ctx.get('time');
      if (time) {
        uniforms.uSunDir.value.copy(time.sunDir).normalize();
        uniforms.uSunAngularRadius.value = time.state.sunAngularRadius || 0.0047;
        // time.sunColor is a display-referred warm white; use it only as a tint
        const c = time.sunColor;
        const m = Math.max(c.r, c.g, c.b, 1e-4);
        uniforms.uSunTint.value.setRGB(c.r / m, c.g / m, c.b / m);
      }
      // ring frame
      const azR = THREE.MathUtils.degToRad(S.ringAzimuthDeg);
      const east = _v3.set(Math.sin(azR), 0, Math.cos(azR)).normalize();
      uniforms.uRingEast.value.copy(east);
      uniforms.uRingAxis.value.set(Math.cos(azR), 0, -Math.sin(azR)).normalize();
      uniforms.uRingRadiusKm.value = S.ringRadiusKm;
      uniforms.uRingHalfWidthKm.value = S.ringRadiusKm * S.ringWidthRatio * 0.5;
      // Threshold
      dirFromAzEl(S.planetAzimuthDeg, S.planetElevationDeg, uniforms.uPlanetDir.value);
      dirFromAzEl(S.planetPoleAzDeg, S.planetPoleElDeg, uniforms.uPlanetAxis.value);
      uniforms.uPlanetCosAng.value = Math.cos(THREE.MathUtils.degToRad(S.planetAngularRadiusDeg));
    },

    updateLuts(ctx, force = false) {
      const s = uniforms.uSunDir.value;
      const key = `${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)},${uniforms.uCamAltKm.value.toFixed(5)}`;
      if (!force && key === _sunKey) return false;
      _sunKey = key;
      renderLut(ctx.renderer, svMat, svRT);
      return true;
    },

    renderProbe(ctx) {
      const r = ctx.renderer;
      probeMesh.position.copy(ctx.camera.position);
      probeMesh.updateMatrixWorld(true);
      cubeCam.position.copy(ctx.camera.position);
      cubeCam.updateMatrixWorld(true);
      const prevTarget = r.getRenderTarget();
      const prevAuto = r.autoClear;
      r.autoClear = true;
      cubeCam.update(r, probeScene);
      r.autoClear = prevAuto;
      r.setRenderTarget(prevTarget);
    },

    update(dt, ctx) {},

    prerender(ctx) {
      if (!domeMesh) return;
      this.syncFromTime(ctx);
      uniforms.uCamAltKm.value = Math.max(ctx.camera.position.y, 0.4) * 0.001;
      uniforms.uCirrusOffset.value.set(
        ctx.clock.t * S.cirrusDrift, ctx.clock.t * S.cirrusDrift * 0.31);
      domeMesh.position.copy(ctx.camera.position);
      domeMesh.updateMatrixWorld(true);
      const dirty = this.updateLuts(ctx);
      // Six cube faces every frame is pure waste when the sun is static, but the probe
      // must never go stale for `env`. Rebuild on a sun change, otherwise every 48
      // frames — a fixed count, so captures stay byte-identical.
      if (dirty || (ctx.clock.frame % 48) === 0) this.renderProbe(ctx);
    },

    /* ------------------------------------------------------------- public API */

    /** Linear HDR sky radiance in a world direction (atmosphere only, no sun disc). */
    radiance(dir, target) {
      const d = _v3.copy(dir).normalize();
      return cpuRadiance(d.x, d.y, d.z, target);
    },

    /** Cube render target of the sky, ready for PMREM. */
    getRenderTarget() { return cubeRT; },
    get cubeTexture() { return cubeRT ? cubeRT.texture : null; },
    get transmittanceTexture() { return trRT ? trRT.texture : null; },
    get skyViewTexture() { return svRT ? svRT.textures[0] : null; },
    get multiScatterTexture() { return svRT ? svRT.textures[1] : null; },
    get material() { return domeMat; },

    /** Irradiance-ish helpers other modules can key ambient off. */
    zenithRadiance(target) { return cpuRadiance(0, 1, 0, target); },
    horizonRadiance(target) {
      const s = uniforms.uSunDir.value;
      const l = Math.hypot(s.x, s.z) || 1;
      return cpuRadiance(s.x / l * 0.9986, 0.052, s.z / l * 0.9986, target);
    },

    resize(w, h, ctx) {},

    dispose(ctx) {
      if (domeMesh) ctx.scene.remove(domeMesh);
      domeMesh?.geometry?.dispose();
      domeMat?.dispose();
      trMat?.dispose(); msMat?.dispose(); svMat?.dispose();
      trRT?.dispose(); msRT?.dispose(); svRT?.dispose();
      cubeRT?.dispose();
      quad = null;
    },
  };
}
