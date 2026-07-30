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
 *      which is why the ring dissolves into the horizon haze for free.
 *
 * Everything is linear HDR. The tonemap pass owns exposure.
 *
 * Placement of the ring / Threshold was measured off ref/keyframes/kf_00600.png and
 * kf_01500.png by back-projecting through the ref_00600 / ref_01500 camera poses;
 * docs/WORLD.md's azimuths for those two are in a different (rotated) convention and
 * do not reproduce the footage. Elevation, sun and everything else match the doc.
 */

const PI = Math.PI;

/* ------------------------------------------------------------------ shared GLSL */

const ATMO_GLSL = /* glsl */`
#define ATM_PI 3.14159265359
const float ATM_Rg = 6360.0;                       // km, ground
const float ATM_Rt = 6420.0;                       // km, top of atmosphere
const vec3  ATM_bR = vec3(5.802e-3, 13.558e-3, 33.100e-3);   // Rayleigh scatter /km
const float ATM_bMs = 3.996e-3;                    // Mie scatter /km
const float ATM_bMe = 4.400e-3;                    // Mie extinction /km
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
uniform float uExposureHint;

uniform float uStarStrength;
uniform float uStarDensity;

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
uniform vec3  uPlanetColA;
uniform vec3  uPlanetColB;
uniform vec3  uPlanetColC;
uniform vec3  uPlanetColD;
uniform float uPlanetSeed;

uniform float uDebugTonemap;
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
      if (h0 > 0.30) continue;                     // most cells are empty
      vec2 pos = o + vec2(starCellHash(id, 5.0), starCellHash(id, 9.0));
      float d = length((gf - pos) * cell);          // angular-ish distance
      float mag = starCellHash(id, 13.0);
      float bright = pow(mag, 5.0) + 0.06;
      float rad = px * (0.85 + 1.5*pow(mag, 8.0));
      float core = exp(-(d*d) / (rad*rad));
      float halo = 0.10 * exp(-(d) / (rad*2.6));
      vec3 tint = mix(vec3(0.82, 0.88, 1.0), vec3(1.0, 0.90, 0.78), starCellHash(id, 21.0));
      acc += tint * bright * (core + halo);
    }
  }
  return acc * uStarStrength;
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
  // s: arc length along the circumference (km), v: across the band, -1..1
  vec2 q = vec2(s, v*uRingHalfWidthKm) / 190.0 + vec2(uRingSeed, uRingSeed*0.37);

  float cont = warpedFbm2(q*0.42, 5, 1.15);
  float shelf = smoothstep(-0.045, 0.010, cont);
  float land  = smoothstep(0.010, 0.075, cont);
  float alt   = smoothstep(0.05, 0.24, cont);

  vec3 deep    = vec3(0.048, 0.115, 0.255);
  vec3 shallow = vec3(0.150, 0.420, 0.520);
  vec3 grass   = vec3(0.130, 0.215, 0.115);
  vec3 dry     = vec3(0.330, 0.300, 0.190);
  vec3 rock    = vec3(0.430, 0.415, 0.360);

  vec3 c = mix(deep, shallow, shelf);
  vec3 ground = mix(grass, dry, smoothstep(0.0, 1.0, fbm2(q*1.7 + 11.0, 4)*0.5 + 0.5));
  ground = mix(ground, rock, alt*0.8);
  c = mix(c, ground, land);

  // rivers / lake glints scratched into the land
  float riv = 1.0 - smoothstep(0.0, 0.035, abs(ridged2(q*1.05 + 4.3, 4) - 0.62));
  c = mix(c, shallow*0.8, riv*land*0.55);

  // cloud deck: stretched along the circumference, the dominant visual
  vec2 cq = vec2(q.x*0.85, q.y*2.1);
  float cw = fbm2(cq*1.15 + 21.0, 4);
  float cl = fbm2(cq*2.3 + vec2(cw*1.4, cw*0.6) + 51.0, 6);
  float cover = smoothstep(-0.055, 0.135, cl);
  float wisp = smoothstep(-0.16, 0.22, cl) * 0.45;
  vec3 cloud = vec3(1.02, 1.05, 1.10);

  c = mix(c, cloud*0.85, wisp);
  c = mix(c, cloud, cover);

  // the ring's own atmosphere sitting on top of all of it
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

  vec2 q = vec2(lon*1.15, lat*2.6) + uPlanetSeed;
  // two-level domain warp: turbulent belts instead of stripes
  vec2 w1 = vec2(fbm2(q*1.30 + 3.7, 5), fbm2(q*1.30 + 9.1, 5));
  vec2 w2 = vec2(fbm2(q*3.10 + w1*1.6 + 17.3, 4), fbm2(q*3.10 + w1*1.6 + 27.9, 4));
  float y = lat*7.4 + 1.85*w1.y + 0.62*w2.y;

  float b1 = 0.5 + 0.5*sin(y*1.55);
  float b2 = 0.5 + 0.5*sin(y*3.90 + 1.7);
  float b3 = 0.5 + 0.5*sin(y*8.30 + 4.1);

  vec3 c = mix(uPlanetColA, uPlanetColB, b1);
  c = mix(c, uPlanetColC, b2*0.55);
  c = mix(c, uPlanetColD, smoothstep(0.55, 1.15, abs(lat)));
  c *= 0.86 + 0.28*b3;

  // storm ovals and shear wisps
  float storm = ridged2(q*2.2 + w2*0.8 + 40.0, 4);
  c = mix(c, uPlanetColB*1.22, smoothstep(0.62, 0.93, storm)*0.55);
  detail = b1*0.5 + b2*0.3 + storm*0.2;
  return c;
}

/* ------------------------------------------------------- AgX (debug preview only) */
vec3 dbgAgx(vec3 c){
  const mat3 toR2020 = mat3(0.6274,0.0691,0.0164, 0.3293,0.9195,0.0880, 0.0433,0.0113,0.8956);
  const mat3 toSRGB  = mat3(1.6605,-0.1246,-0.0182, -0.5876,1.1329,-0.1006, -0.0728,-0.0083,1.1187);
  const mat3 inset = mat3(0.856627153315983,0.0951212405381588,0.0482516061458583,
                          0.137318972929847,0.761241990602591,0.101439036467562,
                          0.11189821299995,0.0767994186031903,0.811302368396859);
  const mat3 outset = mat3(1.1271005818144368,-0.11060664309660323,-0.016493938717834573,
                           -0.1413297634984383,1.157823702216272,-0.016493938717834257,
                           -0.14132976349843826,-0.11060664309660294,1.2519364065950405);
  c = toR2020 * c;
  c = inset * c;
  c = max(c, vec3(1e-10));
  c = log2(c);
  c = (c + 12.47393) / (4.026069 + 12.47393);
  c = clamp(c, 0.0, 1.0);
  vec3 x2 = c*c, x4 = x2*x2;
  c = 15.5*x4*x2 - 40.14*x4*c + 31.96*x4 - 6.868*x2*c + 0.4298*x2 + 0.1191*c - 0.00232;
  c = outset * c;
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  c = toSRGB * c;
  c = clamp(c, 0.0, 1.0);
  return mix(c*12.92, 1.055*pow(max(c, vec3(1e-6)), vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));
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
      float lam = smoothstep(-0.55, 0.85, ndl);
      float shade = mix(1.0, lam, uPlanetTerminator);
      float ndv = max(dot(n, -dir), 0.0);
      float limb = mix(0.42, 1.0, pow(ndv, 0.42));

      vec3 col = base * shade * limb * uPlanetBrightness;
      // atmospheric limb: a thin scattering rim, brightest on the sunward side
      float rim = pow(1.0 - ndv, 7.0);
      float sunSide = smoothstep(-0.25, 0.65, ndl);
      col += vec3(0.055, 0.105, 0.075) * rim * (0.35 + 0.9*sunSide) * uPlanetBrightness;
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
    if (band > 0.001){
      float s = uRingRadiusKm * rh.theta * sign(dot(dir, uRingEast));
      float lum;
      vec3 surf = ringSurface(s, v, lum);

      float ndl = dot(rh.n, uSunDir);
      float lit = mix(0.70, 1.05, smoothstep(-1.0, 1.0, ndl));
      surf *= lit * uRingBrightness;

      // the ring's own air: hundreds to thousands of km of it
      float hz = 1.0 - exp(-rh.t * uRingHazeK);
      surf = mix(surf, uRingHazeColor * (0.72 + 0.55*lit), hz*0.62);

      // bright scattering fringe at the band edges (air seen along the wall)
      float fringe = smoothstep(0.80, 1.0, av);
      surf += uRingHazeColor * fringe * 0.30;

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

  col = max(col, vec3(0.0));
  if (uDebugTonemap > 0.5) col = dbgAgx(col * uExposureHint);

  oColor = vec4(col, 1.0);
}
`;

/* ============================================================== the module */

export function create(opts = {}) {
  const S = {
    /* --- placement, measured off the reference frames (see header) --- */
    ringAzimuthDeg: 162.5,     // horizon azimuth where the band rises (az = atan2(x,z))
    ringRadiusKm: 5000,
    ringWidthRatio: 0.100,     // W / R  -> 500 km band
    ringWidthOffset: 0.0,
    ringBrightness: 1.62,
    ringHazeKmInv: 1.0 / 3100,
    ringOpacity: 0.965,

    planetAzimuthDeg: 207.5,
    planetElevationDeg: 22.0,
    planetAngularRadiusDeg: 27.5,
    planetBrightness: 0.62,
    planetTerminator: 0.42,
    planetTiltDeg: 14.0,

    solarIrradiance: 7.6,
    mieG: 0.78,
    sunDiscRadiance: 340.0,
    groundAlbedo: 0.14,
    starStrength: 0.85,
    starDensity: 46.0,
    atmTint: [1.0, 0.94, 1.06],
    exposureHint: 1.0,
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
    uExposureHint: { value: S.exposureHint },

    uStarStrength: { value: S.starStrength },
    uStarDensity: { value: S.starDensity },

    uRingAxis: { value: new THREE.Vector3(1, 0, 0) },
    uRingEast: { value: new THREE.Vector3(0, 0, 1) },
    uRingRadiusKm: { value: S.ringRadiusKm },
    uRingHalfWidthKm: { value: S.ringRadiusKm * S.ringWidthRatio * 0.5 },
    uRingWidthOffset: { value: S.ringWidthOffset },
    uRingBrightness: { value: S.ringBrightness },
    uRingHazeK: { value: S.ringHazeKmInv },
    uRingHazeColor: { value: new THREE.Vector3(0.62, 0.76, 0.98) },
    uRingOpacity: { value: S.ringOpacity },
    uRingSeed: { value: 0 },

    uPlanetDir: { value: new THREE.Vector3(0, 0.4, -1).normalize() },
    uPlanetAxis: { value: new THREE.Vector3(0, 1, 0) },
    uPlanetCosAng: { value: Math.cos(THREE.MathUtils.degToRad(S.planetAngularRadiusDeg)) },
    uPlanetBrightness: { value: S.planetBrightness },
    uPlanetTerminator: { value: S.planetTerminator },
    uPlanetColA: { value: new THREE.Vector3(0.255, 0.160, 0.150) },
    uPlanetColB: { value: new THREE.Vector3(0.560, 0.430, 0.375) },
    uPlanetColC: { value: new THREE.Vector3(0.380, 0.245, 0.290) },
    uPlanetColD: { value: new THREE.Vector3(0.290, 0.280, 0.360) },
    uPlanetSeed: { value: 0 },

    uDebugTonemap: { value: 0 },
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
        const ms = (scR + scM) * 0.11 * Math.exp(-_od[k] * 0.35);
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
        uGroundTint: { value: new THREE.Vector3(0.78, 0.74, 0.66) },
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
        if (k === 'skyDebugTonemap') uniforms.uDebugTonemap.value = v ? 1 : 0;
        if (k === 'skyDebugMode') uniforms.uDebugMode.value = v;
        if (k === 'skyMsScale') uniforms.uMsScale.value = v;
        if (k === 'skyMieScale') uniforms.uMieScale.value = v;
        if (k === 'skyExposureHint') uniforms.uExposureHint.value = v;
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
      const tilt = THREE.MathUtils.degToRad(S.planetTiltDeg);
      uniforms.uPlanetAxis.value.set(Math.sin(tilt) * 0.6, Math.cos(tilt), Math.sin(tilt) * 0.8).normalize();
      uniforms.uPlanetCosAng.value = Math.cos(THREE.MathUtils.degToRad(S.planetAngularRadiusDeg));
    },

    updateLuts(ctx, force = false) {
      const s = uniforms.uSunDir.value;
      const key = `${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)},${uniforms.uCamAltKm.value.toFixed(5)}`;
      if (!force && key === _sunKey) return;
      _sunKey = key;
      renderLut(ctx.renderer, svMat, svRT);
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
      domeMesh.position.copy(ctx.camera.position);
      domeMesh.updateMatrixWorld(true);
      this.updateLuts(ctx);
      this.renderProbe(ctx);
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
