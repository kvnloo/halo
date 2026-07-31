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
 *      A thin high-cirrus veil and a luminance-correlated TPDF grain go on last.
 *   5. env probe: a 128px cube of the dome, rendered from a private scene so a
 *      screen-space cloud pass on LAYER.SKY can never be dragged into it.
 *
 * Everything is linear HDR. The tonemap pass owns exposure; these values are keyed so
 * that AgX at the tonemap's own `keyedExposure()` (~0.67 for the reference rig) lands
 * on the clip's measured sky.
 *
 * Geometry note — the Halo ring is traced analytically as the inner surface of a
 * cylinder the observer is standing on, so its centre line is a great circle through
 * the zenith and its apparent width follows W/(4 R sin el). TWO such cylinders are
 * traced, each with its own axis, arc extent and leg selection: a single trace can only
 * put its two legs exactly 180 deg apart on the horizon, which cannot reproduce
 * docs/WORLD.md's two bands 56 deg apart in kf_00720. Each segment carries an
 * arc-length window so the band terminates in a feathered chevron the way kf_00450 does
 * at x 596-634, rather than running off the top of frame at constant width.
 *
 * Segment 0's azimuth (162.5 deg) and Threshold's (az 210.4, el 24.3, 25.5 deg angular
 * radius) were measured by back-projecting kf_00600 and kf_01500 through the ref_00600 /
 * ref_01500 poses. docs/WORLD.md's azimuths for these two are in a different (rotated)
 * convention and do not reproduce the footage; its elevations, the sun and everything
 * else do.
 *
 * Photometric contract (all measured on captures, graded-simulated because the `grade`
 * pass does not currently compile — see the report):
 *   deep sky el 10-20, away from the sun   R 51 G 89 B 136  lum 85  R/B 0.38
 *   Threshold disc                          1.5-1.7x the local sky luminance, R/B ~1.0
 *   ring band                               1.2-2.4x the sky it sits in, never below
 *
 * Public API (consumed by `env`, `clouds`, `ocean`, `lighting`):
 *   radiance(dir, target?)  -> THREE.Color, linear HDR sky radiance in a direction
 *   getRenderTarget()       -> WebGLCubeRenderTarget, HalfFloat, ready to PMREM
 *   cubeTexture / transmittanceTexture / skyViewTexture / multiScatterTexture
 *   skyMaterialUniforms     -> the shared uniform block (sun dir, LUTs, tints)
 *   zenithRadiance() / horizonRadiance()
 */

const PI = Math.PI;

/* ------------------------------------------------- the ONE atmosphere constant table
 *
 * research/sky.md §4 opens with the rule this exists to enforce: "one radiance function,
 * three consumers... Any one of them authored independently will drift." It had drifted:
 * the CPU mirror carried bMs = 3.996e-3 against the shader's 1.900e-3 and bMe = 4.4e-3
 * against 2.150e-3 — a factor of 2.1 in the aerosol term — so the sky that was SEEN and
 * the sky that LIT and EXPOSED the frame were two different atmospheres.
 *
 * Now the GLSL string below is generated from this object and every JS path reads the
 * same object, so they cannot diverge again without editing one line.
 *
 * Values are Hillaire 2020 / Bruneton, cross-checked in research/sky.md §7.
 */
export const ATM = {
  Rg: 6360.0,                                            // km, ground
  Rt: 6420.0,                                            // km, top of atmosphere
  bR: [5.802e-3, 13.558e-3, 33.100e-3],                  // Rayleigh scatter /km
  bMs: 1.900e-3,                                         // Mie scatter /km
  bMe: 2.150e-3,                                         // Mie extinction /km  (albedo 0.884)
  bO: [0.650e-3, 1.881e-3, 0.085e-3],                    // ozone absorption /km
  Hr: 8.0,
  Hm: 1.2,
  /* second aerosol population: the marine boundary layer — see the note below */
  Hb: 0.9,
  bBs: 1.450e-2,
  bBe: [1.546e-2, 1.625e-2, 1.826e-2],
};

/** GLSL float literal: `6360` must not be emitted as an int. */
const gf = (x) => {
  const s = String(x);
  return (s.includes('.') || s.includes('e') || s.includes('E')) ? s : s + '.0';
};
const gv3 = (a) => `vec3(${a.map(gf).join(', ')})`;

/* research/sky.md §2 — solar geometry and limb darkening, both quoted from primary
 * sources there. The angular radius is 0.5334 deg of mean angular DIAMETER, halved;
 * "0.0047" is 1% large and "0.5 deg" is 6% small. LIMB_* is the Hestroffer-Magnan
 * two-parameter fit to the Hosek-Wilkie 5th-order limb-darkening polynomials
 * (research §2.2): one pow per channel, within 1.6% of the polynomial everywhere on
 * the disc, and it puts the limb at 0.34/0.25/0.18 of centre where the old
 * (0.42,0.56,0.70)/alpha 0.55 put it at 0.58/0.44/0.30. */
const SUN_ANG_RADIUS = 0.0046542;
const LIMB_U = [0.664, 0.747, 0.821];
const LIMB_ALPHA = [0.695, 0.735, 0.796];

/* research/sky.md §2.3: disc-average luminance 1.4e9 cd/m2 at the ground for a 40 deg
 * sun in clear marine air, mid-sky (90 deg from the sun) 4.0e3 cd/m2. That RATIO —
 * 3.5e5, 18.4 stops — is the only number that survives a change of units, and it is
 * what drives bloom, veiling glare and whether the tonemap shoulder has anything to do.
 * The disc is therefore derived from the sky-view LUT every time the sun moves rather
 * than being a magic constant that a later exposure change silently invalidates. */
const SUN_SKY_RATIO = 3.5e5;
/* Disc-average / disc-centre for the limb polynomial above (research §2.2: 0.7993 at
 * 560 nm). uSunDiscRadiance is the CENTRE radiance, so divide the ratio by this. */
const LIMB_DISC_AVG = 0.7993;

/* ------------------------------------------------------------------ shared GLSL */

const ATMO_GLSL = /* glsl */`
#define ATM_PI 3.14159265359
const float ATM_Rg = ${gf(ATM.Rg)};                       // km, ground
const float ATM_Rt = ${gf(ATM.Rt)};                       // km, top of atmosphere
const vec3  ATM_bR = ${gv3(ATM.bR)};   // Rayleigh scatter /km
const float ATM_bMs = ${gf(ATM.bMs)};                    // Mie scatter /km
const float ATM_bMe = ${gf(ATM.bMe)};                    // Mie extinction /km
const vec3  ATM_bO = ${gv3(ATM.bO)};     // ozone absorption /km
const float ATM_Hr = ${gf(ATM.Hr)};
const float ATM_Hm = ${gf(ATM.Hm)};

/* ---- second aerosol population: the marine boundary layer ----
 * One aerosol scale height integrates to a smooth exponential airmass, which is why
 * the horizon ramp came out as a straight line with the blue channel dead flat over
 * the last six degrees. The reference does not do that: ref/keyframes/kf_01800.png,
 * column x 1500-1700, rises to a maximum ~3 deg above the waterline (185/197/216) and
 * then in the last degree R holds while G and B fall (185/188/202) — a distinct Mie
 * shoulder that turns cream, not pale blue, as it saturates.
 *
 * That shape needs a second, much denser and much shallower population whose
 * extinction exceeds its scattering and is blue-heavy: in-scatter saturates at
 * bs/be per channel once the optical depth passes 1, so blue caps lowest and the last
 * degree warms. Hb = 0.9 km puts the knee inside the lowest ~8 deg (airmass 7 at 8 deg,
 * 29 at 2 deg) and leaves the deep sky untouched (airmass 2 at 30 deg -> od 0.04).
 * Its phase function is separate from the free-troposphere Mie term: coarse sea-salt
 * aerosol is far less forward-peaked, so it gets its own g (uHazeG) rather than
 * inheriting the g = 0.78 that shapes the solar aureole.
 */
const float ATM_Hb  = ${gf(ATM.Hb)};                           // boundary layer, km
const float ATM_bBs = ${gf(ATM.bBs)};                          // scatter /km
const vec3  ATM_bBe = ${gv3(ATM.bBe)};      // extinction /km, blue-heavy

void atmDens(float h, out float dr, out float dm, out float doz, out float db){
  dr = exp(-max(h,0.0) / ATM_Hr);
  dm = exp(-max(h,0.0) / ATM_Hm);
  db = exp(-max(h,0.0) / ATM_Hb);
  doz = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
}
vec3 atmExtinction(float h){
  float dr, dm, doz, db; atmDens(h, dr, dm, doz, db);
  return ATM_bR*dr + vec3(ATM_bMe*dm) + ATM_bO*doz + ATM_bBe*db;
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

/* ---- sky-view LUT parameterisation: (angle from the sun's meridian, elevation) ----
 *
 * v uses Hillaire's signed-sqrt latitude compression so the horizon gets the texels.
 * u now uses the SAME compression on azimuth-from-the-sun. It used to be linear, which
 * put one texel every pi/256 = 0.70 deg everywhere including through the solar aureole —
 * so the Mie in-scatter integral was bilinearly smeared across the one place in the sky
 * where it has a gradient, and the aureole died by ~8 deg out. u = sqrt(a/pi) spends
 * texels where the gradient is: the first texel now spans 0.048 deg and the texel at
 * 1 deg out spans 0.105 deg, 6.7x finer than before, at zero cost. (The far half of the
 * sky loses resolution it never needed: the anti-solar texel spans 1.4 deg across a
 * region whose in-scatter is flat to well under a code value.)
 *
 * This replaces the uCircumsolar additive tail that used to paper over the smearing.
 * That term sat OUTSIDE uAtmTint (so it injected untinted, i.e. far too red, light)
 * and stood a fitted polynomial in for a Mie lobe the LUT is already integrating.
 */
vec2 atmSkyUv(vec3 dir, vec3 sunDir){
  float el = asin(clamp(dir.y, -1.0, 1.0));
  vec2 dh = vec2(dir.x, dir.z);
  vec2 sh = vec2(sunDir.x, sunDir.z);
  float ld = length(dh), ls = length(sh);
  float cosd = (ld > 1e-5 && ls > 1e-5) ? clamp(dot(dh, sh)/(ld*ls), -1.0, 1.0) : 1.0;
  float u = sqrt(clamp(acos(cosd) / ATM_PI, 0.0, 1.0));
  float t = el / (0.5*ATM_PI);
  float v = 0.5 + 0.5*sign(t)*sqrt(abs(t));
  return vec2(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}
vec3 atmSkyDir(vec2 uv, vec3 sunDir){
  float s = uv.y*2.0 - 1.0;
  float t = sign(s)*s*s;
  float el = t*0.5*ATM_PI;
  float az = uv.x*uv.x*ATM_PI;
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
      float dr, dm, doz, db; atmDens(h, dr, dm, doz, db);
      vec3 sc = ATM_bR*dr + vec3(ATM_bMs*dm + ATM_bBs*db);
      vec3 ex = ATM_bR*dr + vec3(ATM_bMe*dm) + ATM_bO*doz + ATM_bBe*db;

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
                                         // a   = boundary-layer aerosol (no phase)
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
  float Lb = 0.0;
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
      float dr, dm, doz, db; atmDens(h, dr, dm, doz, db);
      vec3 scR = ATM_bR*dr;
      float scM = ATM_bMs*dm;
      float scB = ATM_bBs*db;
      vec3 ex = ATM_bR*dr + vec3(ATM_bMe*dm) + ATM_bO*doz + ATM_bBe*db;

      float muSp = dot(p/rp, sunL);
      float shadow = (atmRaySphere(p, sunL, ATM_Rg) > 0.0) ? 0.0 : 1.0;
      vec3 Tsun = atmSampleTr(tTransmittance, rp, muSp) * shadow;
      vec3 psi = sampleMs(rp, muSp);

      vec3 stepT = exp(-ex*dt);
      vec3 safeEx = max(ex, vec3(1e-8));
      vec3 iw = (vec3(1.0) - stepT) / safeEx;      // integral of exp(-ex s) over the step

      Lr  += T * scR * Tsun * iw;
      Lm  += (T.g * scM * Tsun.g * iw.g);
      Lb  += (T.g * scB * Tsun.g * iw.g);
      Lms += T * (scR + vec3(scM + scB)) * psi * iw;
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
  oMulti  = vec4(Lms, Lb);
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
uniform float uStarGate;
uniform vec2  uCirrusOffset;
uniform float uCirrusStrength;
uniform vec3  uCirrusColor;

uniform float uHazeG;           // boundary-layer aerosol asymmetry
uniform vec3  uHazeTint;
uniform float uGrain;

#define RING_N 2
uniform vec3  uRingAxis[RING_N];   // horizontal, across the band's width
uniform vec3  uRingEast[RING_N];   // horizontal, along the circumference
uniform float uRingRadiusKm[RING_N];
uniform float uRingHalfWidthKm[RING_N];
uniform float uRingArc[RING_N];    // arc extent, radians of theta, before the terminus
uniform float uRingTipFlare[RING_N];
uniform float uRingLeg[RING_N];    // 0 = both legs, +-1 = only the leg on that side
uniform float uRingBright[RING_N];
uniform float uRingOpacityA[RING_N];
uniform float uRingSeedA[RING_N];
uniform float uRingWidthOffset; // where the observer sits across the band, -1..1
uniform float uRingHazeK;
uniform float uRingHazeFloor;   // aerial perspective present even looking straight up
uniform float uRingRail;
uniform vec3  uRingRailColor;
uniform vec3  uRingHazeColor;

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
      // A 26% occupancy gate on a regular lattice is not "sparse", it is a visible
      // grid: the reference's clean zenith carries 97 px per 10k above sky+8 but 20 per
      // 10k above sky+30, i.e. mostly empty with a handful of jewels. 7.5% occupancy
      // plus a ninth-power magnitude curve reproduces that distribution; the old
      // fourth-power curve made almost every cell a mid-grey dot.
      if (h0 > uStarGate) continue;
      vec2 pos = o + vec2(starCellHash(id, 5.0), starCellHash(id, 9.0));
      float d = length((gf - pos) * cell);          // angular-ish distance
      float mag = starCellHash(id, 13.0);
      float bright = pow(mag, 9.0)*1.55 + 0.0065;
      float rad = px * (0.55 + 1.75*pow(mag, 12.0));
      float core = exp(-(d*d) / (rad*rad));
      float halo = 0.055 * exp(-(d) / (rad*2.2));
      vec3 tint = mix(vec3(0.84, 0.95, 1.26), vec3(1.03, 1.00, 1.01), starCellHash(id, 21.0)*0.60);
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
  float f = fbm2(vec2(pr.x*1.35, pr.y*3.10) + w*0.7 + 21.0, 4);
  float m = smoothstep(0.17, 0.74, v*0.74 + f*0.44);

  // Break each filament along its own length. Without this the flow field draws
  // uninterrupted uniform-width strokes clear across the hemisphere, which is exactly
  // what "scratches on the lens" means.
  m *= smoothstep(0.16, 0.72, fbm2(vec2(pr.x*1.15, pr.y*0.22) + 313.0, 4)*0.5 + 0.5);

  // sheet mask: only a couple of broad regions carry cirrus at all
  float sheet = smoothstep(0.10, 0.46, fbm2(p*0.055 + 137.0, 3)*0.5 + 0.5);

  return m * sheet * smoothstep(0.03, 0.34, dir.y)
           * smoothstep(7.0, 2.4, length(p - uCirrusOffset));
}

/* -------------------------------------------------------------- Halo ring */
/* Traced as the inner surface of a cylinder the observer is standing on. A ray at
 * elevation el meets it at arc position theta = 2*asin(sin el) measured from the
 * observer's own feet, so theta runs 0 at the horizon to pi at the zenith, and the
 * band's exact angular half-width is W/(4 R sin el).
 *
 * Two independent segments are traced. One cylinder can only ever put its two legs
 * exactly 180 deg apart on the horizon, which cannot reproduce docs/WORLD.md's two
 * bands at 56 deg of separation in kf_00720; a second trace with its own axis, arc
 * extent and leg selection can. Each segment carries an arc-length window so the band
 * terminates in a feathered chevron the way kf_00450 does at x 596-634, instead of
 * running off the top of frame at constant width.
 */
struct RingHit { float t; float a; float theta; float hw; float term; vec3 n; bool hit; };

RingHit ringTrace(vec3 dir, int k){
  RingHit h;
  h.hit = false; h.t = 0.0; h.a = 0.0; h.theta = 0.0; h.hw = 1.0; h.term = 0.0;
  h.n = vec3(0.0,1.0,0.0);
  float du = dir.y;                               // dot(dir, up)
  if (du <= 1e-4) return h;
  vec3 A = uRingAxis[k];
  vec3 E = uRingEast[k];
  float leg = uRingLeg[k];
  float sd = dot(dir, E);
  if (leg != 0.0 && sd*leg <= 0.0) return h;
  vec3 e = dir - dot(dir, A)*A;
  float e2 = dot(e, e);
  if (e2 < 1e-6) return h;
  float R = uRingRadiusKm[k];
  float t = 2.0*R*du / e2;
  if (t <= 0.0) return h;
  float a = t*dot(dir, A) + uRingWidthOffset*uRingHalfWidthKm[k];
  h.t = t; h.a = a;
  float sinHalf = clamp(t/(2.0*R), 0.0, 1.0);
  h.theta = 2.0*asin(sinHalf);
  vec3 up = vec3(0.0, 1.0, 0.0);
  h.n = -(t*e - R*up) / R;

  // Exact geometry trumpets as 1/sin(el) — 5x wider by 10 deg of elevation, which is
  // the flare the reference never shows. kf_00600 measures 53 px at el 53 against 82 px
  // at el 19: sin^-0.45, not sin^-1, because the ring's own limb haze eats the band's
  // edges as the slant path through it grows. Compress the flare to the measured law.
  float hw = uRingHalfWidthKm[k] * pow(clamp(du, 0.05, 1.0), 0.70);

  // arc-length window -> feathered chevron terminus
  float x = h.theta / max(uRingArc[k], 1e-3);
  float fx = (x - 0.90)*7.0;
  float flare = 1.0 + uRingTipFlare[k] * exp(-fx*fx);
  float term = 1.0 - smoothstep(0.93, 1.04, x);
  h.hw = hw * flare * (0.10 + 0.90*term);
  h.term = term;
  h.hit = abs(a) <= h.hw;
  return h;
}

/* The band's surface. Screen-space arc-length compression along s is ~2 orders of
 * magnitude greater than across the band (the visible arc is 15,700 km long and 200 km
 * wide, drawn into a strip ~30 px across), so an isotropic noise frame in km — which is
 * what this used to sample — produces round blotches at the wrong scale in the only
 * direction that has room for them. It read as lichen. The frame here is 15:1
 * anisotropic: everything is a lengthwise striation, which is what kf_00600 shows. */
vec3 ringSurface(float s, float v, float hwKm, float seed, out float lum){
  /* Everything here is keyed in KILOMETRES on the inner surface, because that is the
   * only frame in which the feature scales can be checked against a measurement. At
   * ref_00600 the band subtends 52 px for ~435 km, i.e. ~8.4 km/px across, while the
   * visible arc runs ~2500 km into ~600 px, ~4 km/px... but foreshortened along its
   * length by roughly 2.5x on screen. ANISO carries that, so a "continent" comes out
   * roughly as long as it is wide ON SCREEN instead of as a lengthwise smear.
   *
   * The previous frame (s/1400, v*hwKm/95) x 0.24 gave a continental period of 396 km
   * across a band that was then only 200 km wide — less than one feature edge to edge,
   * which is why the interior read as a flat wash however much contrast it was given.
   * kf_00600 shows 4-6 distinct features across the band width; CONT_KM is set to
   * deliver that. */
  const float CONT_KM = 155.0;      // continental period across the band
  const float ANISO   = 2.6;        // lengthwise stretch, screen-space compensated
  vec2 q = vec2(s/(CONT_KM*ANISO), (v*hwKm)/CONT_KM) + vec2(seed, seed*0.37);

  float cont = warpedFbm2(q, 4, 1.55);
  float shelf = smoothstep(-0.035, 0.045, cont);
  float land  = smoothstep(0.080, 0.155, cont);
  float alt   = smoothstep(0.150, 0.310, cont);

  // The band is seen through 10,000 km of the ring's own air, but that is what the
  // aerial-perspective mix in main() is for; the SURFACE keeps its own range. Deep
  // ocean genuinely is darker than the sky beside it in kf_00600 (interior minima
  // 62/89/141 against a sky of 45/79/132 in B but below it in luminance-weighted R).
  vec3 deep    = vec3(0.055, 0.135, 0.235);
  vec3 shallow = vec3(0.210, 0.395, 0.470);
  vec3 grass   = vec3(0.215, 0.310, 0.240);
  vec3 dry     = vec3(0.455, 0.415, 0.305);
  vec3 rock    = vec3(0.505, 0.490, 0.455);

  vec3 c = mix(deep, shallow, shelf);
  vec3 ground = mix(grass, dry, fbm2(q*2.6 + 11.0, 3)*0.5 + 0.5);
  ground = mix(ground, rock, alt*0.7);
  c = mix(c, ground, land);

  // Coastlines and river systems. cont is warped fbm, so its level sets already
  // meander; a ridged field keyed off the SAME warp puts drainage inside the same
  // basins instead of scattering isotropic scratches over the whole band.
  float riv = 1.0 - smoothstep(0.0, 0.075, abs(ridged2(q*1.6 + 4.3, 3) - 0.58));
  c = mix(c, shallow*0.9, riv*land*0.7);
  // a hard shelf edge exactly on the coastline reads as a coast rather than a gradient
  float coast = 1.0 - smoothstep(0.0, 0.030, abs(cont - 0.080));
  c = mix(c, shallow*1.12, coast*0.55);

  // Cloud deck, sheared along the circumference into lengthwise filaments but at a
  // period the band is actually wide enough to resolve (~170 km, ~20 px).
  vec2 cq = q * vec2(0.42, 0.62);
  float cw = fbm2(cq*1.9 + 21.0, 3);
  float cb = fbm2(cq*1.7 + vec2(cw*1.6, cw*0.4) + 51.0, 4);
  float cd = fbm2(cq*2.4 + vec2(cw*0.8, 0.0) + 77.0, 3);
  // Measured against kf_00600: at y=150/200 the reference band's brightest pixel is
  // 117/150 against a sky of 74/76, i.e. it never exceeds ~2x the sky at those
  // elevations. A 2.15-3.10 cloud albedo over a threshold this low put OUR peak at 198
  // at every elevation - a band of blown cloud with land showing through, rather than
  // land with weather on it.
  float cm = smoothstep(0.235, 0.430, cb*0.78 + cd*0.55);
  vec3 cloud = vec3(1.50, 1.66, 1.90);

  c = mix(c, cloud*0.30, smoothstep(-0.09, 0.30, cb) * 0.09);
  c = mix(c, cloud, cm);
  c = mix(c, cloud*1.12, cm * smoothstep(0.20, 0.52, cd) * 0.55);

  // lengthwise illumination banding — long, never blotchy
  c *= 0.72 + 0.60*(fbm2(vec2(q.x*0.55, q.y*1.10) + 91.0, 3)*0.5 + 0.5);

  c = mix(vec3(0.35, 0.45, 0.55), c, vec3(lessThan(c, vec3(1.0e6))));   // NaN guard
  lum = dot(c, vec3(0.30, 0.59, 0.11));
  return c;
}

/* --------------------------------------------------------- Threshold */
vec3 planetSurface(vec3 n, out float detail){
  vec3 ax = normalize(uPlanetAxis);
  vec3 bx = normalize(cross(ax, vec3(0.0, 0.0, 1.0) + vec3(0.13, 0.0, 0.0)));
  vec3 bz = cross(ax, bx);
  float lat = asin(clamp(dot(n, ax), -1.0, 1.0));
  // atan(0,0) is undefined, and with the pole inside the visible disc exactly that
  // happens on a handful of pixels: the NaN survives every bloom downsample and lands
  // as a black blob after the tonemap.
  float cbx = dot(n, bx), cbz = dot(n, bz);
  float lon = (abs(cbx) + abs(cbz) < 1e-6) ? 0.0 : atan(cbz, cbx);

  vec2 q = vec2(lon*1.05, lat*2.2) + uPlanetSeed;
  // Two-level domain warp: turbulent belts instead of stripes.
  vec2 w1 = vec2(fbm2(q*0.85 + 3.7, 5), fbm2(q*0.85 + 9.1, 5));
  vec2 w2 = vec2(fbm2(q*5.40 + w1*1.1 + 17.3, 6), fbm2(q*5.40 + w1*1.1 + 27.9, 6));
  // lat*7.0 put barely two belt cycles across the visible face where the reference
  // shows fifteen to twenty. A vertical luminance scan of kf_00720 through the disc
  // gives mean|dLum/dy| = 0.62 with peaks at 6.5; the old surface managed 0.12/3.9.
  float y = lat*22.0 + 2.55*w1.y + 0.62*w2.y + 1.15*fbm2(q*0.26 + 401.0, 3);

  float b1 = 0.5 + 0.5*sin(y*1.30);
  float b2 = 0.5 + 0.5*sin(y*3.10 + 1.7);
  float b3 = 0.5 + 0.5*sin(y*7.90 + 4.1);
  // y*18 puts one cycle every 4.5 px on a disc this large - above Nyquist, so it
  // contributed aliasing noise rather than visible striation and inflated the vertical
  // gradient statistic without adding any structure a viewer can see.
  float b4 = 0.5 + 0.5*sin(y*11.0 + 2.0);       // fine striation

  // Filaments concentrate in the mid-latitudes and fade out over the poles, and there
  // is one distinctly darker equatorial belt — both plainly visible in kf_00720.
  float al = abs(lat);
  float env = smoothstep(0.04, 0.34, al) * (1.0 - smoothstep(0.86, 1.38, al));

  vec3 c = mix(uPlanetColA, uPlanetColB, smoothstep(0.06, 0.94, b1));
  c = mix(c, uPlanetColC, b2*0.38);
  c = mix(c, uPlanetColD, smoothstep(0.62, 1.30, al));

  // Not every latitude is equally banded. A constant-amplitude belt stack is a candy
  // stripe; the reference alternates sharply ruled zones with almost featureless ones.
  float amp = 0.30 + 1.00*(fbm2(vec2(q.x*0.30, q.y*0.55) + 211.0, 3)*0.5 + 0.5);

  // Belt separation has to happen in VALUE, not only in hue. Every detail term used to
  // be a +-5% multiplier on a smooth gradient, which is why the disc read as two soft
  // diagonal smudges; adjacent zones in the reference differ by 20-35% in luminance
  // across a hard filamentary edge, not a sine.
  c *= mix(1.0, mix(0.885, 1.125, smoothstep(0.28, 0.72, b1)), amp);
  c *= mix(1.0, mix(0.935, 1.065, smoothstep(0.22, 0.78, b2)), amp);
  // One knife-edged zone boundary per b2 cycle. smoothstep over 0.10 of a sine that
  // runs 68 radians across the visible face is a sub-pixel step; it is the only thing
  // that reaches the reference's peak vertical gradient of 5.5 codes/px on a 20 px
  // column average, which no smooth stack of sines can produce at any amplitude.
  c *= mix(1.0, mix(0.915, 1.058, smoothstep(0.45, 0.55, b2)), amp*0.85);
  c *= mix(1.0, 0.964 + 0.072*smoothstep(0.16, 0.60, b3), amp*(0.45 + 0.55*env));
  c *= 0.962 + 0.076*smoothstep(0.28, 0.72, b4)*(0.30 + 0.70*env);
  float eqx = lat/0.075;
  c *= mix(1.0, 0.76, exp(-eqx*eqx));                       // equatorial belt
  c *= 0.92 + 0.16*(fbm2(q*0.42 + 61.0, 4)*0.5 + 0.5);
  // Fine filamentary shear - the octaves that carry the disc's high-frequency detail.
  c *= 0.915 + 0.170*(fbm2(q*3.10 + w2*0.9 + 131.0, 5)*0.5 + 0.5);
  c *= 0.958 + 0.084*(ridged2(q*7.40 + w2*1.4 + 203.0, 4));
  // Thin sheared threads drawn along the belts. These are what carry the disc's
  // maximum luminance gradient: the reference peaks at 5.5 codes/px on a 20 px column
  // average, which a smooth sine stack cannot reach at any amplitude.
  float thr = smoothstep(0.52, 0.88, ridged2(vec2(q.x*0.85, q.y*13.0) + w2*1.1 + 303.0, 3));
  c *= 1.0 + (0.16*thr - 0.062) * (0.35 + 0.65*env);

  // A couple of broad zones go distinctly warm - the tan/ochre belts that carry most of
  // kf_00720's colour interest. Without this the whole disc is one lavender hue.
  float warm = smoothstep(0.10, 0.62, fbm2(vec2(q.x*0.22, q.y*0.85) + 137.0, 3)*0.5 + 0.5);
  c = mix(c, c * vec3(1.16, 1.03, 0.77), warm*0.55);

  // gnoise2 normalises a hashed gradient vector, so on the handful of lattice cells
  // where the hash lands exactly on (0.5,0.5) it evaluates normalize(vec2(0)) = NaN.
  // At the finest octave one such cell is ~3 px on a disc this size, and the NaN
  // survives every bloom downsample to land as a black blob after the tonemap.
  // Any comparison against a NaN is false, so this catches NaN and +Inf both.
  c = mix(uPlanetColB * 0.55, c, vec3(lessThan(c, vec3(1.0e6))));

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
  vec3 termB = vec3(texture(tSkyMulti, svUv).a) * phaseMie(cosT, uHazeG) * uHazeTint;
  vec3 termS = ms * uMsScale;
  if (uDebugMode > 0.5){
    if (uDebugMode < 1.5) { termM = vec3(0.0); termS = vec3(0.0); termB = vec3(0.0); }
    else if (uDebugMode < 2.5) { termR = vec3(0.0); termS = vec3(0.0); }
    else if (uDebugMode < 3.5) { termR = vec3(0.0); termM = vec3(0.0); termB = vec3(0.0); }
  }
  /* uBelowLift used to multiply the below-horizon term by 6x here, with a comment
   * saying why: env PMREMs this dome and its lower hemisphere is the scene's ambient.
   * That is a dome being deformed to make the IBL come out, which stops it being a
   * radiance function at all. It is gone; the probe is fixed at the probe (renderProbe
   * zeroes the sun disc, research/sky.md §4.2) and uMsScale is back at 1, which
   * restores 4.5x of the ground/multiple-scatter term the 0.22 was throwing away —
   * so the lower hemisphere lands within 25% of where the hack put it anyway. */
  /* No uSunTint on the in-scatter. research/sky.md §2.4: "Do not author the sun
   * colour... it must come from the same transmittance function the sky uses." The
   * LUT integral already carries Tsun to every scattering point, so multiplying the
   * result by time.sunColor as well applies the atmosphere's own reddening twice —
   * measured, it costs 8% of the blue channel against red. The DISC still takes
   * uSunTint, so the disc and the DirectionalLight (which lighting drives from the
   * same time.sunColor) stay in agreement. */
  vec3 inscatter = (termR + termM + termB + termS) * uSolarIrradiance;
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
      float lam = smoothstep(-0.34, 0.72, ndl);
      float shade = mix(1.0, lam, uPlanetTerminator);
      float ndv = max(dot(n, -dir), 0.0);
      // An optically thick, strongly forward-scattering gas giant has essentially no
      // limb darkening — kf_00720 is if anything limb-BRIGHTENED by its haze layer.
      // mix(0.66, 1.0, pow(ndv,0.30)) darkened the outer 40% of the disc by up to a
      // third and was the single loudest "this is a Lambert sphere primitive" tell.
      float limb = mix(0.93, 1.0, pow(ndv, 0.5));

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
      // kf_00720's limb is BRIGHTER than the disc interior - a haze layer seen through
      // a long slant path, warm and wide, not the thin blue thread this used to draw.
      col += vec3(0.300, 0.238, 0.278) * exp(-(1.0 - ndv) * 13.0)
             * (0.45 + 0.95 * smoothstep(-0.30, 0.60, ndl));

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
  for (int k = 0; k < RING_N; k++){
    if (uRingOpacityA[k] <= 0.001) continue;
    RingHit rh = ringTrace(dir, k);
    if (rh.t <= 0.0) continue;
    float v = rh.a / max(rh.hw, 1e-4);
    float av = abs(v);
    float aaw = max(fwidth(v), 1e-4);
    float band = 1.0 - smoothstep(1.0 - aaw*2.0, 1.0 + aaw*2.0, av);
    float dissolve = smoothstep(0.010, 0.075, dir.y);   // merge into the horizon
    band *= dissolve;

    // The view ray meets the inner surface at grazing incidence cos(i) = sin(elevation),
    // so the path through the ring's own air is an airmass of 1/sin(el).
    float am = 1.0 / max(dir.y, 0.010);
    float hz = 1.0 - exp(-uRingHazeK * pow(max(am - 1.0, 0.0), 1.4));

    if (band > 0.001){
      float s = uRingRadiusKm[k] * rh.theta * sign(dot(dir, uRingEast[k]));
      float lum;
      vec3 surf = ringSurface(s, v, rh.hw, uRingSeedA[k], lum);

      float ndl = dot(rh.n, uSunDir);
      float lit = mix(0.68, 1.06, smoothstep(-1.0, 1.0, ndl));
      surf *= lit * uRingBright[k];

      // Aerial perspective over 2R = 10,000 km of the ring's own air. It is a haze MIX,
      // not a floor: surf = max(surf, inscatter*0.9) used to sit here and made it
      // mathematically impossible for the band's seas to be darker than the sky, which
      // is exactly what turned a world into a fluorescent tube. Measured on kf_00600
      // (y 150-250, x 832-892) the reference band carries 50-60 codes of internal range
      // against a 76-code sky and its darkest interior pixels sit BELOW the sky.
      // The unconditional 45% haze mix is likewise down to uRingHazeFloor; hz (the
      // 1/sin(el) airmass term above) carries the elevation dependence on its own.
      vec3 hazeCol = mix(uRingHazeColor * (0.34 + 0.52*lit), inscatter * 1.05, min(1.0, 0.10 + 0.85*hz));
      float hazeMix = clamp(uRingHazeFloor + (1.0 - uRingHazeFloor)*hz, uRingHazeFloor, 1.0);
      surf = mix(surf, hazeCol, hazeMix);

      // A soft edge highlight, not a rim wall. kf_00600 shows NO bright rails at all -
      // its band peaks in the middle and falls off to both edges - while kf_00450 shows
      // one bright edge near the chevron tip. 1.35 with a 0.075-wide gaussian drew two
      // hard specular rails brighter than everything between them, which is the other
      // half of the tube.
      float r1 = (av - 0.86)/0.150, r2 = (av - 0.45)/0.42;
      float rail = exp(-r1*r1) + 0.30*exp(-r2*r2);
      surf += uRingRailColor * rail * uRingRail * (1.0 - hz*0.40) * rh.term;

      float alpha = band * uRingOpacityA[k];
      space = mix(space, surf, alpha);
      coverage = max(coverage, alpha);
    }

    // Soft glow bleeding into the sky outside the band. Without it the edge is
    // stencilled; the reference lifts the sky for roughly half a band-width out.
    float outer = max(av - 1.0, 0.0);
    float glow = exp(-outer * 5.5) * (1.0 - band) * dissolve * rh.term;
    space += uRingRailColor * glow * uRingRail * 0.26 * (1.0 - hz*0.8) * uRingOpacityA[k];
  }

  /* -- sun disc --
   * The angle comes from the CHORD, not acos: ang = |dir - sunDir| = 2 sin(ang/2), so
   * the relative error is ang^2/24 = 9e-7 at the disc edge - a hundred-thousandth of a
   * pixel - while acos(cosT) is ill-conditioned exactly here (across the whole 14-px
   * disc cosT is within 3e-5 of 1 and fp32 acos loses half its significant digits).
   * research/sky.md §2.5.1. Cheaper too.
   *
   * uSunDiscRadiance is NOT a magic constant: it is recomputed from the sky-view LUT
   * every time the sun moves so that disc-average : mid-sky stays at the measured
   * 3.5e5 (research §2.3). See _updateSunDisc. The old 320.0 put that ratio at ~1e2 -
   * 12 stops of missing highlight energy - so the frame's only real light source handed
   * the bloom pass nothing above its knee and the sun read as a moon behind haze. */
  float ang = length(dir - uSunDir);
  float aaS = max(fwidth(ang), 1e-6);
  float discMask = 1.0 - smoothstep(uSunAngularRadius - aaS, uSunAngularRadius + aaS, ang);
  if (discMask > 0.0){
    float d = clamp(ang / uSunAngularRadius, 0.0, 1.0);
    float mu = max(sqrt(max(1.0 - d*d, 0.0)), 1e-4);
    const vec3 LIMB_U     = ${gv3(LIMB_U)};
    const vec3 LIMB_ALPHA = ${gv3(LIMB_ALPHA)};
    vec3 limbD = vec3(1.0) - LIMB_U*(vec3(1.0) - pow(vec3(mu), LIMB_ALPHA));
    space += uSunDiscRadiance * limbD * uSunTint * discMask * (1.0 - coverage);
  }
  /* No analytic corona. research §2.5.3: "Do not put a pow() corona on top of a
   * blown-out disc and call it bloom... Pick one owner of the glow." bloom.js owns
   * everything beyond 1 solar radius; this file owns the disc. */

  /* ---- fold space through the atmosphere ---- */
  vec3 col = space * Tview + inscatter * (1.0 - Tview*coverage);

  /* ---- high cirrus, in front of everything but the sun's own disc ---- */
  if (uCirrusStrength > 0.001){
    float dens = cirrusVeil(dir);
    if (dens > 0.0008){
      // A flat mix toward a constant colour gives constant-opacity streaks that read as
      // scratches on the lens. Shading the filament with its own optical depth makes
      // thick regions transmit less of the sunward glow, so they go grey-blue while the
      // thin edges stay silver - that is what makes it read as weather.
      float cv = clamp(dens * uCirrusStrength * 3.4, 0.0, 1.0);
      float selfT = exp(-dens * 3.1);
      float fwd = 0.60 + 0.95*pow(max(cosT, 0.0), 7.0);
      vec3 lit = uCirrusColor * (0.30 + 0.86*fwd*selfT) * mix(0.62, 1.0, clamp(Tview.g*1.3, 0.0, 1.0));
      col = mix(col, lit + inscatter*0.34*(1.0 - selfT), cv);
    }
  }

  /* ---- grain ----
   * The reference's clean deep sky carries a highpass std of 1.25 codes and a per-patch
   * RGB std of 4-5; a 0.3% multiplicative dither (about +-0.5 codes of white noise)
   * delivered 0.46 and the frame read as vinyl. This is TPDF and scales with the square
   * root of local luminance - photon statistics - so it survives the tonemap in the
   * midtones without lifting or crawling in the shadows, and it still breaks the
   * 8-bit banding the old dither existed to break. */
  {
    float gl = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float gn = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.yx + 17.31) - 1.0;
    col += gn * uGrain * sqrt(max(gl, 0.0));
  }

  if (uDebugMode > 3.5){
    if (uDebugMode < 4.5) col = Tview;                 // transmittance to space
    else if (uDebugMode < 5.5) col = rm.rgb * 3.0;     // Rayleigh integral, no phase
    else if (uDebugMode < 6.5) col = vec3(rm.a) * 30.0;// Mie integral, no phase
    else col = ms * 3.0;                               // multiple scattering
  }

  col = mix(inscatter, col, vec3(lessThan(col, vec3(1.0e9))));   // NaN / Inf guard
  col = clamp(col, vec3(0.0), vec3(60000.0));

  oColor = vec4(col, 1.0);
}
`;

/* ============================================================== the module */

export function create(opts = {}) {
  const S = {
    /* --- the Halo ring, one entry per visible segment --------------------------
     * ringWidthRatio is W/R. The analytic zenith half-width is W/(4R).
     *
     * MEASURED, not guessed. kf_00600 shows the band clean above the cloud deck; a
     * horizontal cut at y=150/200/250 puts it at x 847-898 / 841-892 / 832-888, i.e.
     * 52 +- 2 px. Our own ref_00600 capture at widthRatio 0.040 measured 24 px at the
     * same elevations. 0.040 x 52/24 = 0.087, i.e. 435 km on a 5000 km radius. That is
     * 2.2x the 0.040 a previous pass narrowed it to (which left the object too thin to
     * carry any surface at all — KNOWN_ISSUES §17.2 has it misread as a rendering
     * artifact in four showcase cells) and within 17% of docs/WORLD.md's 520 km.
     * arcDeg is the theta extent before the feathered chevron terminus; theta is 0 at
     * the observer's own feet and 180 at the zenith. leg selects one side of the
     * cylinder (0 = both), which is what lets two segments sit at an arbitrary
     * separation instead of the 180 deg a single trace is stuck with. */
    rings: [
      { azimuthDeg: 162.5, radiusKm: 5000, widthRatio: 0.087, arcDeg: 176,
        brightness: 1.15, opacity: 0.94, tipFlare: 0.85, leg: 0, seed: 0.0 },
      { azimuthDeg: 106.5, radiusKm: 5000, widthRatio: 0.065, arcDeg: 84,
        brightness: 0.95, opacity: 0.40, tipFlare: 0.55, leg: 1, seed: 7.9 },
    ],
    ringWidthOffset: 0.0,
    ringHazeZenithOD: 0.085,  // optical depth of the ring's own air, straight down
    // kf_00600's band peaks in the MIDDLE and falls to both edges; kf_00450 shows one
    // bright edge near the chevron tip. 1.35 drew two hard specular rails brighter than
    // everything between them, i.e. a tube.
    ringRail: 0.34,
    // unconditional haze mix, before the 1/sin(el) airmass term. Was a hard 0.45.
    ringHazeFloor: 0.16,

    planetAzimuthDeg: 210.4,
    planetElevationDeg: 24.3,
    planetAngularRadiusDeg: 25.5,
    // kf_00720 measures the disc at 1.63x the luminance of the sky beside it
    // (125.7 against 77.0). 0.285 landed it at 0.59x - a 2.8x value inversion, and the
    // largest single screen-area error in the frame.
    planetBrightness: 0.82,
    planetAurora: 0.0,   // kf_00720 shows none, and the term is a NaN source
    // 1.00 with a smoothstep(-0.08,0.55) ramp is 36 deg of shading across a disc whose
    // visible portion in the reference is close to uniformly lit.
    planetTerminator: 0.35,
    planetLimbHaze: 0.55,    // was 2.30: bleached 76% of the mid-disc into sky
    planetAtmo: 0.05,
    // The rotation axis projects to 49 deg off vertical at the ref_00720 camera, which
    // drew the belts as steep diagonal stripes. A gas giant's belts are lines of
    // latitude: with the pole near screen-vertical they sweep across the disc almost
    // horizontally and curve as great circles, which is what kf_00720 shows.
    planetPoleAzDeg: 40.0,
    planetPoleElDeg: 35.0,

    /* The sky's absolute level, and the ONLY thing that sets it. Was 9.4 with a 0.483
     * luminance cut hidden inside `atmTint` and 78% of the multiple-scatter term thrown
     * away; both of those are gone, so this carries the whole job openly. Keyed so the
     * clean deep sky lands on the clip's measured (49, 81, 134) at ref_00720. */
    solarIrradiance: 4.8,
    mieG: 0.78,
    hazeG: 0.45,             // boundary-layer aerosol is much less forward-peaked
    /* The sun disc is DERIVED (see `_updateSunDisc`): disc-average : mid-sky is pinned
     * to research/sky.md §2.3's measured 3.5e5. `sunDiscMax` is the only hand-set
     * number and it exists purely for half-float: the dome already clamps its output
     * at 60000 and everything downstream (sceneRT, TAA history, PMREM) is HalfFloat,
     * whose ceiling is 65504. 45000 leaves headroom for the grain and the cirrus mix.
     * The ratio that survives is then ~1.6e5 (17.3 stops) rather than 18.4 — 1.1 stops
     * of unrepresentable range, all of it above the point where AgX is already at 1.0. */
    sunDiscRatio: SUN_SKY_RATIO,
    sunDiscMax: 45000.0,
    groundAlbedo: 0.14,
    starStrength: 3.05,
    starDensity: 56.0,
    starGate: 0.075,         // cell occupancy; 0.26 was a visible lattice
    cirrusDrift: 0.00045,
    cirrusStrength: 0.075,
    // Re-keyed after the sky's absolute level dropped (solarIrradiance 9.4 -> 4.8):
    // the grain is sqrt(luminance)-weighted, so halving the linear sky took the
    // display-space grain with it. Measured on a clean 200x100 sky patch, laplacian
    // variance: reference kf_00720 67.7 (std 3.9), ours 78.9 before, 36.3 at 0.0240
    // after the re-level. 0.0340 got it to 53.5; 0.0383 = 0.0340 x sqrt(67.7/53.5).
    grain: 0.0383,
    /* Multiple scattering is what carries the horizon-to-zenith ramp. At 0.22 the dome
     * threw 78% of it away and the sky read as one uniform slab (measured: 23 codes of
     * red over 420 px at ref_00720, against 25 over 160 px in kf_01500 — 3x too flat
     * per degree). Back to 1.0, which is also what makes `uBelowLift` unnecessary. */
    msScale: 1.0,
    /* uAtmTint used to be (0.430, 0.456, 0.912). Decomposed, that is a chromatic
     * rotation of (0.890, 0.943, 1.887) times a LUMINANCE cut of 0.483 — i.e. an
     * exposure hack and a colour grade smuggled into one vector, applied to the output
     * of a physically parameterised chain and (worse) to the radiance function the IBL
     * and the exposure key read.
     *
     * The luminance half is gone; it belongs in `solarIrradiance`, where it is one
     * honest scalar. What is left is luminance-PRESERVING by construction
     * (0.2126 r + 0.7152 g + 0.0722 b = 1.000), so it cannot move the sky's absolute
     * level, the sun:sky ratio, `groundIrradiance` or the exposure key. Only the
     * chromaticity moves.
     *
     * And it is measured, not guessed. Probe (tools/_skyprobe.mjs) reports our LINEAR
     * mid-sky at B/R 4.23, G/R 1.95 with the tint neutral. Inverting AgX numerically
     * against the reference's own clean deep sky — kf_00600 (45,79,132), kf_00720
     * (49,81,134) — asks for B/R 7.2, G/R 2.0. So G is already physically right (the
     * old tint's green cut was simply wrong) and the residual is entirely a
     * blue-over-red rotation. That residual is NOT a bug in the LUT chain: a CIE clear
     * zenith sky is B/R 2.78 in linear sRGB and ours is already 4.2, i.e. bluer than
     * physical. It is the reference clip's colour grade, and it should migrate to the
     * `grade` pass when that gets its final calibration (KNOWN_ISSUES §6). Until then
     * it lives here quarantined to a chromaticity, not a radiance.
     *
     * Solved, not eyeballed: with the tint neutral the probe's linear mid-sky is
     * (0.0476, 0.0930, 0.2017) at solarIrradiance 5.2; a search over
     * luminance-preserving (r,g,b) and exposure through the real agxJS() lands
     * (49.2, 80.8, 134.0) against the reference's (49, 81, 134) — at exposure 0.582,
     * which is the exposure the scene's own auto key was already running. One closed
     * loop later (capture, invert agxJS on the measured patch, re-solve) it settles at
     * (0.836, 0.964, 1.842), luminance 1.0001. Worth noting as a cross-check: the old
     * tint's chroma rotation, normalised to luminance 1, was (0.890, 0.943, 1.887) —
     * two independent derivations of the same grade, which is what says the residual is
     * a grade and not a physics error. What was wrong with it was the 0.483 luminance
     * cut welded onto it and the green, not the blue. */
    atmTint: [0.836, 0.964, 1.842],
    cubeSize: 128,
  };
  Object.assign(S, opts.sky || {});
  const RN = 2;
  const rings = [];
  for (let i = 0; i < RN; i++) rings.push(S.rings[i] || { ...S.rings[0], opacity: 0 });

  const uniforms = {
    tTransmittance: { value: null },
    tSkyRayMie: { value: null },
    tSkyMulti: { value: null },

    uSunDir: { value: new THREE.Vector3(0.666, 0.656, -0.354) },
    uSunTint: { value: new THREE.Color(1, 1, 1) },
    uSolarIrradiance: { value: S.solarIrradiance },
    uSunAngularRadius: { value: SUN_ANG_RADIUS },
    uSunDiscRadiance: { value: 0 },   // derived; see _updateSunDisc
    uCamAltKm: { value: 0.0017 },
    uMieG: { value: S.mieG },
    uAtmTint: { value: new THREE.Vector3(...S.atmTint) },

    uStarStrength: { value: S.starStrength },
    uStarDensity: { value: S.starDensity },
    uStarGate: { value: S.starGate },
    uCirrusOffset: { value: new THREE.Vector2(0, 0) },
    uCirrusStrength: { value: S.cirrusStrength },
    uCirrusColor: { value: new THREE.Vector3(1.55, 1.62, 1.78) },

    uHazeG: { value: S.hazeG },
    uHazeTint: { value: new THREE.Vector3(1.10, 1.00, 0.86) },
    uGrain: { value: S.grain },

    uRingAxis: { value: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)] },
    uRingEast: { value: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)] },
    uRingRadiusKm: { value: rings.map((r) => r.radiusKm) },
    uRingHalfWidthKm: { value: rings.map((r) => r.radiusKm * r.widthRatio * 0.5) },
    uRingArc: { value: rings.map((r) => THREE.MathUtils.degToRad(r.arcDeg)) },
    uRingTipFlare: { value: rings.map((r) => r.tipFlare) },
    uRingLeg: { value: rings.map((r) => r.leg) },
    uRingBright: { value: rings.map((r) => r.brightness) },
    uRingOpacityA: { value: rings.map((r) => r.opacity) },
    uRingSeedA: { value: rings.map(() => 0) },
    uRingWidthOffset: { value: S.ringWidthOffset },
    uRingHazeK: { value: S.ringHazeZenithOD },
    uRingHazeFloor: { value: S.ringHazeFloor },
    uRingRail: { value: S.ringRail },
    uRingRailColor: { value: new THREE.Vector3(0.68, 0.94, 1.28) },
    uRingHazeColor: { value: new THREE.Vector3(0.50, 0.78, 1.30) },

    uPlanetDir: { value: new THREE.Vector3(0, 0.4, -1).normalize() },
    uPlanetAxis: { value: new THREE.Vector3(0, 1, 0) },
    uPlanetCosAng: { value: Math.cos(THREE.MathUtils.degToRad(S.planetAngularRadiusDeg)) },
    uPlanetBrightness: { value: S.planetBrightness },
    uPlanetTerminator: { value: S.planetTerminator },
    uPlanetLimbHaze: { value: S.planetLimbHaze },
    uPlanetAtmo: { value: S.planetAtmo },
    uPlanetAuroraq: { value: S.planetAurora },
    // kf_00720's disc measures R/G/B 139/120/141 - green is the LOWEST channel. That is
    // mauve / dusty rose, and it is what the palette has to average out to after the
    // atmosphere in front of it has added its blue. The old set averaged to a brick red
    // that the sky then dragged to R/B 0.44, i.e. bluer than it was red.
    uPlanetColA: { value: new THREE.Vector3(0.538, 0.312, 0.470) },   // dark mauve belt
    uPlanetColB: { value: new THREE.Vector3(1.200, 0.815, 1.045) },   // pale rose zone
    uPlanetColC: { value: new THREE.Vector3(1.030, 0.720, 0.470) },   // tan / ochre belt
    uPlanetColD: { value: new THREE.Vector3(0.735, 0.505, 0.805) },   // polar violet
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
  let _bare = false;   // measurement hook, see ctx.config.skyBare

  /* ------------------------------------------ CPU atmosphere: the SAME atmosphere
   *
   * `radiance()` is not a second sky model any more. The sky-view LUT is read back to
   * the CPU once per sun move (two 256x256 RGBA16F reads, ~500 KB, and the LUT is
   * already rebuilt only on a `_sunKey` change) and `radiance()` applies exactly the
   * same phase functions, scales and tints the dome fragment does, from the same
   * uniforms. env.js keys the ambient SH off this and tonemap.keyedExposure() reads
   * env.groundIrradiance off that SH, so "the sky you see" and "the sky that lights
   * and exposes the frame" are now the same array of numbers, not two models.
   *
   * The analytic march below survives only as a boot/no-readback fallback, and it now
   * reads the shared ATM table so even the fallback cannot carry a different aerosol.
   */
  const CPU = ATM;
  let svRayMie = null;      // Float32Array, 256*256*4 : Lr.rgb (no phase), Lm (no phase)
  let svMulti = null;       // Float32Array, 256*256*4 : Lms.rgb, Lb (no phase)
  let svW = 0, svH = 0;
  let trData = null;        // Float32Array, 256*64*4 : transmittance to space
  let trW = 0, trH = 0;

  function readLutRGBA(renderer, rt, texIndex) {
    const w = rt.width, h = rt.height;
    const buf = new Uint16Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf, undefined, texIndex);
    const out = new Float32Array(w * h * 4);
    for (let i = 0; i < out.length; i++) out[i] = THREE.DataUtils.fromHalfFloat(buf[i]);
    return out;
  }

  /** Bilinear fetch of an interleaved RGBA float image. `uv` in [0,1], y up. */
  function sampleRGBA(data, w, h, u, v, out) {
    const x = Math.min(Math.max(u, 0), 1) * w - 0.5;
    const y = Math.min(Math.max(v, 0), 1) * h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const cx0 = Math.min(Math.max(x0, 0), w - 1), cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
    const cy0 = Math.min(Math.max(y0, 0), h - 1), cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
    const i00 = (cy0 * w + cx0) * 4, i10 = (cy0 * w + cx1) * 4;
    const i01 = (cy1 * w + cx0) * 4, i11 = (cy1 * w + cx1) * 4;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy, w11 = fx * fy;
    for (let k = 0; k < 4; k++) {
      out[k] = data[i00 + k] * w00 + data[i10 + k] * w10 + data[i01 + k] * w01 + data[i11 + k] * w11;
    }
    return out;
  }

  /** Bruneton transmittance parameterisation — the exact mirror of `atmTrUv`. */
  const _tr = [0, 0, 0, 0];
  function cpuTransmittance(r, mu, out) {
    out = out || [0, 0, 0];
    if (!trData) { out[0] = out[1] = out[2] = 1; return out; }
    const H = Math.sqrt(Math.max(ATM.Rt * ATM.Rt - ATM.Rg * ATM.Rg, 1e-6));
    const rho = Math.sqrt(Math.max(r * r - ATM.Rg * ATM.Rg, 0));
    const disc = r * r * (mu * mu - 1) + ATM.Rt * ATM.Rt;
    const d = Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
    const dmin = ATM.Rt - r, dmax = rho + H;
    const u = Math.min(Math.max((d - dmin) / Math.max(dmax - dmin, 1e-6), 0), 1);
    const v = Math.min(Math.max(rho / H, 0), 1);
    sampleRGBA(trData, trW, trH, u, v, _tr);
    out[0] = _tr[0]; out[1] = _tr[1]; out[2] = _tr[2];
    return out;
  }

  /** Exact mirror of `atmSkyUv`. */
  function cpuSkyUv(dx, dy, dz, out) {
    const sun = uniforms.uSunDir.value;
    const el = Math.asin(Math.min(Math.max(dy, -1), 1));
    const ld = Math.hypot(dx, dz), ls = Math.hypot(sun.x, sun.z);
    const cosd = (ld > 1e-5 && ls > 1e-5)
      ? Math.min(Math.max((dx * sun.x + dz * sun.z) / (ld * ls), -1), 1) : 1;
    out[0] = Math.min(Math.max(Math.sqrt(Math.min(Math.max(Math.acos(cosd) / PI, 0), 1)), 0), 1);
    const t = el / (0.5 * PI);
    out[1] = Math.min(Math.max(0.5 + 0.5 * Math.sign(t) * Math.sqrt(Math.abs(t)), 0), 1);
    return out;
  }

  const _uv = [0, 0], _rm = [0, 0, 0, 0], _mu4 = [0, 0, 0, 0];
  /** The dome fragment's in-scatter, evaluated on the CPU from the same LUT. */
  function lutRadiance(dx, dy, dz, target) {
    const sun = uniforms.uSunDir.value;
    const cosT = dx * sun.x + dy * sun.y + dz * sun.z;
    const pR = (3 / (16 * PI)) * (1 + cosT * cosT);
    const hg = (c, g) => {
      const g2 = g * g;
      const k = (3 / (8 * PI)) * (1 - g2) / (2 + g2);
      const d = 1 + g2 - 2 * g * c;
      return k * (1 + c * c) / Math.max(d * Math.sqrt(Math.max(d, 1e-4)), 1e-4);
    };
    const pM = hg(cosT, uniforms.uMieG.value);
    const pB = hg(cosT, uniforms.uHazeG.value);
    cpuSkyUv(dx, dy, dz, _uv);
    sampleRGBA(svRayMie, svW, svH, _uv[0], _uv[1], _rm);
    sampleRGBA(svMulti, svW, svH, _uv[0], _uv[1], _mu4);
    const msS = uniforms.uMsScale.value, mieS = uniforms.uMieScale.value;
    const ht = uniforms.uHazeTint.value;
    const E = uniforms.uSolarIrradiance.value;
    const tint = uniforms.uAtmTint.value;
    const mie = _rm[3] * pM * mieS;
    const haz = _mu4[3] * pB;
    const r = (_rm[0] * pR + mie + haz * ht.x + _mu4[0] * msS) * E * tint.x;
    const g = (_rm[1] * pR + mie + haz * ht.y + _mu4[1] * msS) * E * tint.y;
    const b = (_rm[2] * pR + mie + haz * ht.z + _mu4[2] * msS) * E * tint.z;
    target = target || new THREE.Color();
    target.setRGB(Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0);
    return target;
  }

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
      const db = Math.exp(-Math.max(h, 0) / CPU.Hb);
      const doz = Math.max(0, 1 - Math.abs(h - 25) / 15);
      a += (CPU.bR[0] * dr + CPU.bMe * dm + CPU.bO[0] * doz + CPU.bBe[0] * db) * dt;
      b += (CPU.bR[1] * dr + CPU.bMe * dm + CPU.bO[1] * doz + CPU.bBe[1] * db) * dt;
      c += (CPU.bR[2] * dr + CPU.bMe * dm + CPU.bO[2] * doz + CPU.bBe[2] * db) * dt;
    }
    out[0] = a; out[1] = b; out[2] = c;
  }
  const _od = [0, 0, 0];
  /* Analytic fallback ONLY (before the first readback, or if half-float readback is
   * unavailable). Same constants, same phase split as the GPU: the boundary-layer
   * population gets its own g and tint instead of riding the g=0.78 solar-aureole lobe,
   * and the multiple-scatter fill rides `uMsScale` like the dome's does. */
  function cpuRadiance(dx, dy, dz, target) {
    const sun = uniforms.uSunDir.value;
    const r0 = CPU.Rg + Math.max(uniforms.uCamAltKm.value, 0.0004);
    const cosT = dx * sun.x + dy * sun.y + dz * sun.z;
    const pR = (3 / (16 * PI)) * (1 + cosT * cosT);
    const hg = (c, g) => {
      const g2 = g * g;
      const k = (3 / (8 * PI)) * (1 - g2) / (2 + g2);
      const d = 1 + g2 - 2 * g * c;
      return k * (1 + c * c) / Math.max(d * Math.sqrt(Math.max(d, 1e-4)), 1e-4);
    };
    const pM = hg(cosT, uniforms.uMieG.value);
    const pB = hg(cosT, uniforms.uHazeG.value);
    const ht = uniforms.uHazeTint.value;
    const htv = [ht.x, ht.y, ht.z];
    const msS = uniforms.uMsScale.value, mieS = uniforms.uMieScale.value;

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
      const db = Math.exp(-Math.max(h, 0) / CPU.Hb);
      const doz = Math.max(0, 1 - Math.abs(h - 25) / 15);
      const muS = (px * sun.x + py * sun.y + pz * sun.z) / rp;
      cpuOpticalDepth(rp, muS, _od);
      for (let k = 0; k < 3; k++) {
        const scR = CPU.bR[k] * dr;
        const scM = CPU.bMs * dm;
        const scB = CPU.bBs * db;
        const ex = CPU.bR[k] * dr + CPU.bMe * dm + CPU.bO[k] * doz + CPU.bBe[k] * db;
        const st = Math.exp(-ex * dt);
        const iw = (1 - st) / Math.max(ex, 1e-8);
        const Ts = Math.exp(-_od[k]);
        // isotropic multiple-scattering fill, scaled like the dome's MS LUT term
        const ms = (scR + scM + scB) * 0.052 * msS * Math.exp(-_od[k] * 0.62);
        L[k] += T[k] * ((scR * pR + scM * pM * mieS + scB * pB * htv[k]) * Ts + ms) * iw;
        T[k] *= st;
      }
    }
    const E = uniforms.uSolarIrradiance.value;
    const tint = uniforms.uAtmTint.value;
    target = target || new THREE.Color();
    target.setRGB(L[0] * E * tint.x, L[1] * E * tint.y, L[2] * E * tint.z);
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
  const _midSky = new THREE.Color();
  const _trSun = [1, 1, 1];
  const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /**
   * Pull the sky-view LUT (and, once, the transmittance LUT) back to the CPU, then
   * re-derive the sun disc from it.
   *
   * This is the whole of the "one radiance function" contract in one function: the
   * dome pixel, `radiance()` (hence env's SH, hence tonemap's exposure key) and the
   * sun disc are now all functions of the same array of texels.
   */
  function readbackLuts(renderer) {
    try {
      if (!trData) {
        const td = readLutRGBA(renderer, trRT, 0);
        let tmx = 0;
        for (let i = 0; i < td.length; i += 37) tmx = Math.max(tmx, td[i]);
        if (tmx > 0 && Number.isFinite(tmx)) { trData = td; trW = trRT.width; trH = trRT.height; }
      }
      const rm = readLutRGBA(renderer, svRT, 0);
      const mu = readLutRGBA(renderer, svRT, 1);
      // three's readRenderTargetPixels reports an unreadable format by console.error and
      // simply returns, leaving the buffer full of zeros — so "no exception" is not
      // evidence of a successful read. A sky-view LUT that is identically zero is not a
      // sky; treat that as a failed readback rather than silently unlighting the scene.
      let mx = 0;
      for (let i = 0; i < rm.length; i += 97) mx = Math.max(mx, rm[i]);
      if (!(mx > 0) || !Number.isFinite(mx)) throw new Error('sky-view LUT read back empty');
      svRayMie = rm; svMulti = mu;
      svW = svRT.width; svH = svRT.height;
    } catch (e) {
      // A driver that refuses to read RGBA16F leaves `radiance()` on the analytic
      // fallback, which now reads the same ATM table, so it degrades rather than drifts.
      svRayMie = svMulti = null;
      if (_ctx?.warn) _ctx.warn(`[sky] sky-view LUT readback unavailable (${e && e.message}); radiance() on the analytic fallback`);
    }
  }

  /**
   * uSunDiscRadiance, as a RATIO rather than a magic number.
   *
   * research/sky.md §2.3: disc-average 1.4e9 cd/m2 against a mid-sky (90 deg from the
   * sun, mid-elevation) 4.0e3 cd/m2 — 3.5e5, 18.4 stops. That ratio is the thing that
   * has to survive into the frame, because it is what bloom, veiling glare and the
   * tonemap shoulder all respond to. Anchoring it to the LUT means a later change to
   * uSolarIrradiance / msScale / groundAlbedo moves the sun WITH the sky instead of
   * silently breaking the ratio.
   *
   * Two corrections applied here:
   *  - the dome multiplies the disc by Tview (correct: research §2.4 says the sun's
   *    colour must come from the same transmittance the sky uses), so divide it out —
   *    the 1.4e9 above is already a ground-level number;
   *  - uSunDiscRadiance is the disc CENTRE, the 3.5e5 is the disc AVERAGE, so divide
   *    by the limb polynomial's 0.7993 disc average (research §2.2).
   */
  function updateSunDisc() {
    const sun = uniforms.uSunDir.value;
    // mid-sky: 90 deg from the sun in azimuth, 30 deg elevation. Away from both the
    // aureole and the horizon haze, i.e. the "4e3 cd/m2" reference point.
    const l = Math.hypot(sun.x, sun.z) || 1;
    const px = -sun.z / l, pz = sun.x / l;              // perpendicular, horizontal
    const ce = Math.cos(0.5236), se = Math.sin(0.5236); // 30 deg
    const mid = LUM(...radianceRGB(px * ce, se, pz * ce, _midSky));
    const r = ATM.Rg + Math.max(uniforms.uCamAltKm.value, 0.0004);
    cpuTransmittance(r, Math.min(Math.max(sun.y, -1), 1), _trSun);
    const tSun = Math.max(LUM(_trSun[0], _trSun[1], _trSun[2]), 0.05);
    const want = (S.sunDiscRatio * Math.max(mid, 1e-6)) / (LIMB_DISC_AVG * tSun);
    uniforms.uSunDiscRadiance.value = Math.min(want, S.sunDiscMax);
  }
  function radianceRGB(dx, dy, dz, c) {
    const n = 1 / (Math.hypot(dx, dy, dz) || 1);
    const t = (svRayMie ? lutRadiance : cpuRadiance)(dx * n, dy * n, dz * n, c);
    return [t.r, t.g, t.b];
  }

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
      for (let i = 0; i < RN; i++) uniforms.uRingSeedA.value[i] = 13.7 + rf() * 40.0 + (rings[i].seed || 0);
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
        // Measurement hook: strip every "space" object so the atmosphere can be
        // photometered on its own. Every elevation band in a normal frame is partly
        // covered by the ring, Threshold or a star, and masking those out of a capture
        // leaves too few pixels to trust.
        if (k === 'skyBare') {
          const off = !!v;
          _bare = off;
          for (let i = 0; i < RN; i++) uniforms.uRingOpacityA.value[i] = off ? 0 : rings[i].opacity;
          uniforms.uStarStrength.value = off ? 0 : S.starStrength;
          uniforms.uCirrusStrength.value = off ? 0 : S.cirrusStrength;
          uniforms.uPlanetCosAng.value = off ? 2.0
            : Math.cos(THREE.MathUtils.degToRad(S.planetAngularRadiusDeg));
          uniforms.uGrain.value = off ? 0 : S.grain;
        }
        if (k === 'skyMsScale') uniforms.uMsScale.value = v;
        if (k === 'skyMieScale') uniforms.uMieScale.value = v;
        if (k === 'skyIrradiance') uniforms.uSolarIrradiance.value = v;
        if (k === 'skyAtmTint') uniforms.uAtmTint.value.fromArray(v);
        if (k === 'skyHazeTint') uniforms.uHazeTint.value.fromArray(v);
        if (k === 'skyGrain') uniforms.uGrain.value = v;
        // Per-channel scalars so a whole A/B batch can run from --config, which only
        // carries numbers. Everything below re-derives the disc, because the disc is a
        // RATIO to the sky and every one of these moves the sky.
        if (k === 'skyAtmTintR') uniforms.uAtmTint.value.x = v;
        if (k === 'skyAtmTintG') uniforms.uAtmTint.value.y = v;
        if (k === 'skyAtmTintB') uniforms.uAtmTint.value.z = v;
        if (k === 'skySunDiscRatio') S.sunDiscRatio = v;
        if (k === 'skySunDiscMax') S.sunDiscMax = v;
        if (k === 'skyGroundAlbedo') {
          S.groundAlbedo = v;
          if (msMat) msMat.uniforms.uGroundAlbedo.value = v;
          if (svMat) svMat.uniforms.uGroundAlbedo.value = v;
          if (_ctx && msRT) { renderLut(_ctx.renderer, msMat, msRT); _sunKey = ''; }
        }
        if (k === 'skyRingRail') uniforms.uRingRail.value = v;
        if (k === 'skyRingHazeFloor') uniforms.uRingHazeFloor.value = v;
        if (k === 'skyRingWidthRatio') {
          for (let i = 0; i < RN; i++) {
            rings[i].widthRatio = v * (i === 0 ? 1.0 : 0.747);
          }
          this.syncFromTime(ctx);
        }
        if (/^sky(MsScale|MieScale|Irradiance|AtmTint[RGB]|SunDiscRatio|SunDiscMax|GroundAlbedo)$/.test(k)) {
          if (svRayMie || trData) updateSunDisc();
        }
        if (k === 'ringBrightness') { for (let i = 0; i < RN; i++) uniforms.uRingBright.value[i] = rings[i].brightness * v; }
        if (k === 'planetBrightness') uniforms.uPlanetBrightness.value = v;
        if (k === 'starStrength') uniforms.uStarStrength.value = v;
        if (k === 'ringAzimuth') { rings[0].azimuthDeg = v; this.syncFromTime(ctx); }
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
        // The solar angular radius is a physical constant (0.5334 deg of mean angular
        // DIAMETER, research/sky.md §2.1), not a time-of-day parameter. `time` still
        // publishes the legacy 0.0047, which is 1% large; honour it only if something
        // has deliberately moved it off that default.
        const ta = time.state.sunAngularRadius;
        uniforms.uSunAngularRadius.value =
          (typeof ta === 'number' && Math.abs(ta - 0.0047) > 1e-6) ? ta : SUN_ANG_RADIUS;
        // time.sunColor is a display-referred warm white; use it only as a tint
        const c = time.sunColor;
        const m = Math.max(c.r, c.g, c.b, 1e-4);
        uniforms.uSunTint.value.setRGB(c.r / m, c.g / m, c.b / m);
      }
      // ring frames
      for (let i = 0; i < RN; i++) {
        const r = rings[i];
        const azR = THREE.MathUtils.degToRad(r.azimuthDeg);
        uniforms.uRingEast.value[i].set(Math.sin(azR), 0, Math.cos(azR)).normalize();
        uniforms.uRingAxis.value[i].set(Math.cos(azR), 0, -Math.sin(azR)).normalize();
        uniforms.uRingRadiusKm.value[i] = r.radiusKm;
        uniforms.uRingHalfWidthKm.value[i] = r.radiusKm * r.widthRatio * 0.5;
        uniforms.uRingArc.value[i] = THREE.MathUtils.degToRad(r.arcDeg);
        uniforms.uRingTipFlare.value[i] = r.tipFlare;
        uniforms.uRingLeg.value[i] = r.leg;
        uniforms.uRingBright.value[i] = r.brightness;
        uniforms.uRingOpacityA.value[i] = _bare ? 0 : r.opacity;
      }
      // Threshold
      dirFromAzEl(S.planetAzimuthDeg, S.planetElevationDeg, uniforms.uPlanetDir.value);
      dirFromAzEl(S.planetPoleAzDeg, S.planetPoleElDeg, uniforms.uPlanetAxis.value);
      if (!_bare) uniforms.uPlanetCosAng.value = Math.cos(THREE.MathUtils.degToRad(S.planetAngularRadiusDeg));
    },

    updateLuts(ctx, force = false) {
      const s = uniforms.uSunDir.value;
      const key = `${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)},${uniforms.uCamAltKm.value.toFixed(5)}`;
      if (!force && key === _sunKey) return false;
      _sunKey = key;
      renderLut(ctx.renderer, svMat, svRT);
      // One readback per sun move, not per frame. It is what makes `radiance()` the
      // same atmosphere as the dome, and it is what the sun disc is derived from.
      readbackLuts(ctx.renderer);
      updateSunDisc();
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
      /* The sun disc is EXCLUDED from the probe, not clamped — research/sky.md §4.2.
       * Three separate reasons, all of which bite at once at 1e4-1e5:
       *   1. half-float. The probe cube and PMREM's own targets are HalfFloatType
       *      (ceiling 65504); one Inf propagates through every mip and one Inf x 0 is
       *      a NaN, which turns a whole mip white or black.
       *   2. SH ringing. The disc is a delta function of 6.8e-5 sr carrying most of the
       *      irradiance; projected onto 9 basis functions it produces large negative
       *      lobes — surfaces facing AWAY from the sun go black.
       *   3. double counting: the sun is already a DirectionalLight, so a disc in the
       *      PMREM gives every rough metal two suns.
       * The aureole stays: it carries real energy the directional light does not. */
      const discWas = uniforms.uSunDiscRadiance.value;
      uniforms.uSunDiscRadiance.value = 0;
      r.autoClear = true;
      cubeCam.update(r, probeScene);
      r.autoClear = prevAuto;
      r.setRenderTarget(prevTarget);
      uniforms.uSunDiscRadiance.value = discWas;
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

    /** Linear HDR sky radiance in a world direction (atmosphere only, no sun disc).
     *  Reads the same sky-view LUT the dome samples; see `readbackLuts`. */
    radiance(dir, target) {
      const d = _v3.copy(dir).normalize();
      return svRayMie ? lutRadiance(d.x, d.y, d.z, target)
        : cpuRadiance(d.x, d.y, d.z, target);
    },

    /** Cube render target of the sky, ready for PMREM. */
    getRenderTarget() { return cubeRT; },
    get cubeTexture() { return cubeRT ? cubeRT.texture : null; },
    get transmittanceTexture() { return trRT ? trRT.texture : null; },
    get skyViewTexture() { return svRT ? svRT.textures[0] : null; },
    get multiScatterTexture() { return svRT ? svRT.textures[1] : null; },
    get material() { return domeMat; },

    /** Irradiance-ish helpers other modules can key ambient off. */
    zenithRadiance(target) { return this.radiance(_v3.set(0, 1, 0), target); },
    horizonRadiance(target) {
      const s = uniforms.uSunDir.value;
      const l = Math.hypot(s.x, s.z) || 1;
      return this.radiance(_v3.set(s.x / l * 0.9986, 0.052, s.z / l * 0.9986), target);
    },

    /** Diagnostics: what the sun disc was actually derived to, and against what. */
    sunDiscDebug() {
      const sun = uniforms.uSunDir.value;
      const l = Math.hypot(sun.x, sun.z) || 1;
      const ce = Math.cos(0.5236), se = Math.sin(0.5236);
      const mid = radianceRGB(-sun.z / l * ce, se, sun.x / l * ce, _midSky);
      return {
        fromLut: !!svRayMie,
        midSkyRGB: mid,
        midSkyLum: LUM(...mid),
        discRadiance: uniforms.uSunDiscRadiance.value,
        ratio: uniforms.uSunDiscRadiance.value * LIMB_DISC_AVG / Math.max(LUM(...mid), 1e-9),
        sunAngularRadius: uniforms.uSunAngularRadius.value,
      };
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
