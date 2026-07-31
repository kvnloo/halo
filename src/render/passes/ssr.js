import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `ssr` — screen-space reflections, for wet sand and water.
 *
 * `needsSwap = false`. The pass owns a half-resolution reflection target exposed as
 * `pass.ssrTexture`, and composites its own result into the HDR chain (see "How the
 * reflection is applied").
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCENE NEEDS IT
 *
 * `docs/TARGETS.md` measures the `shoreline` region at `lap_var 696` and
 * `edge_density 0.127` — the highest of any region in the reference, higher than the
 * water itself. That is not sand texture. In `kf_01500` the retreating swash sheet is a
 * millimetre of water lying on packed sand, viewed at ~4° above the horizontal, and at
 * that angle a water film is very close to a mirror: it is carrying a second, sharp,
 * upside-down copy of the sky, the sea stacks and their silhouette edges. Take the
 * reflection away and the shoreline is a smooth wet-looking gradient measuring perhaps
 * 250. Half of that region's high-frequency energy arrives through this pass.
 *
 * So the target surfaces, in priority order:
 *   MAT_ID.TERRAIN_WET  the swash sheet and the saturated berm — the whole point
 *   MAT_ID.WATER        the sea, via `pass.ssrTexture` (see the caveat below)
 *   MAT_ID.FORERUNNER / METAL / ROCK   wet rock and alloy, a much smaller contribution
 *
 * ---------------------------------------------------------------------------
 * THE MARCH
 *
 * A perspective-correct screen-space DDA against `pipe.depthTex` — opaque world depth,
 * valid for the whole post chain since KNOWN_ISSUES §18 was closed (`reports/depth.md`;
 * before that this pass marched against a buffer containing only the viewmodel and its
 * first guard rejected every world pixel) — not a
 * view-space march. The ray's two endpoints are projected to screen, and the march interpolates
 * **linearly in screen space** while interpolating **1/z linearly** alongside — which is
 * the only interpolation that is correct under perspective. That matters here more than
 * usual: these rays are near-grazing, so a view-space march with uniform steps spends
 * most of its taps on a handful of pixels near the origin and then skips whole sea
 * stacks in the distance. Uniform screen-space steps sample every pixel the ray crosses
 * at the same rate, so a thin silhouette 80 m away is as findable as one 2 m away.
 *
 * `SSR_STEPS` coarse taps with a per-pixel low-discrepancy start offset locate the
 * crossing; `SSR_REFINE` bisection steps then converge on it. The dither is what turns
 * the coarse march's step quantisation from banding into noise, and the temporal pass
 * below turns that noise back into a converged answer.
 *
 * Hi-Z was considered and rejected for this scene. A min-depth pyramid is a win when
 * rays are long and the screen is mostly empty; here the rays are grazing and skim the
 * terrain surface, so the pyramid's conservative test fails at almost every level and
 * degenerates into the linear march anyway, after paying for the pyramid.
 *
 * ---------------------------------------------------------------------------
 * ROUGHNESS: A CONE TRACE OVER A MIP CHAIN
 *
 * `pipe.opaqueRT` has no mips (`generateMipmaps: false`), so the pass builds its own
 * 5-level chain by successive downsampling — deliberately, rather than turning mip
 * generation on for a half-float target, which is an extension-dependent path.
 *
 * The lobe width is converted to a *screen* footprint at the hit, not a fixed level:
 *
 *     coneTan  = f(roughness)                       lobe half-angle
 *     footprint= 2 · coneTan · rayLength            world units at the hit
 *     pixels   = footprint · (½H / (tanY · hitZ))   projected
 *     lod      = log₂(pixels)
 *
 * so a rough reflection of something 2 m away is barely blurred while the same
 * roughness reflecting a sea stack 90 m away is blurred hard — which is the actual
 * behaviour of a GGX lobe, and the thing a fixed roughness→mip table gets wrong.
 *
 * ---------------------------------------------------------------------------
 * FADES — and why the screen edge is the one that gives SSR away
 *
 * Every SSR failure has to fade to *something*, and the classic tell is the hard
 * vertical seam where reflections stop at the edge of the screen. It happens because a
 * grazing reflection off a floor plane travels up the screen and leaves through the top
 * long before it finds anything, so the top of the reflection is a sharp horizontal
 * discontinuity across the whole frame. Five independent fades feed one confidence value:
 *
 *   edge     2-D smoothstep on the hit uv, per axis. Not a 1-D border test — a ray
 *            leaving through a corner has to fade on both axes.
 *   length   the last 30% of the ray's screen travel fades out, so a ray that runs out
 *            of march before finding anything does not pop against one that found
 *            something at 99%.
 *   backface the hit surface's G-buffer normal faces the ray: we hit the far side of
 *            something, and the colour there is not what the reflection would see.
 *   facing   the reflected ray points back toward the camera. Everything it could hit is
 *            behind the visible surface, so any "hit" is a false positive off the depth
 *            buffer's front layer.
 *   miss     no crossing at all within the march.
 *
 * Wherever confidence is short of 1 the remainder comes from the sky: `sky.cubeTexture`
 * if the sky module is loaded, otherwise a two-colour analytic gradient from `time`.
 * Because the fallback is a real sky sample in the correct world direction, the fade is
 * between two plausible images rather than between an image and black — the wet sand
 * keeps mirroring the sky right up to the frame edge, which is exactly the look the
 * shoreline needs, and there is no seam to see.
 *
 * ---------------------------------------------------------------------------
 * HOW THE REFLECTION IS APPLIED
 *
 *     (A,B) = DFGApprox(N·V, roughness)                 pre-integrated split-sum EnvBRDF
 *     k     = (F0(matId)·A + B) · gain(matId)
 *             · (1 − smoothstep(0.35, 0.9, roughness)) · ssrStrength
 *     colour = mix(colour, reflection, clamp(k, 0, 0.92))
 *
 * The weight is the **pre-integrated EnvBRDF**, not raw Schlick. Raw Schlick at 4° grazing
 * returns F ≈ 1 for every material in the frame and turns the whole shoreline into a
 * mirror — research §5.8b, and the measured shoreline signature this pass shipped with.
 * `(F0·A + B)` carries the geometric attenuation that pulls grazing reflectance back down,
 * and it is the right weight for a reflection that has been prefiltered into a mip chain.
 * It is applied AFTER the temporal filter and AFTER the sky/SSR mix, identically to both
 * branches (Frostbite slide 87): weighting one branch and not the other puts a visible
 * brightness step exactly at the fade you built the fallback to hide.
 *
 * A **mix**, not an add. The forward material has already put its own sun specular and
 * ambient into the pixel; adding a reflection on top double-counts and is a fast way to
 * blow `highlight_frac` past the reference's 0.007. Substituting energy instead is also
 * closer to what Fresnel means — at 4° grazing on a water film F approaches 1 and the
 * diffuse under it genuinely is not what you see.
 *
 * `gain(matId)` is what keeps this off surfaces that should not have it: dry sand 0.15,
 * foliage 0, viewmodel 0, wet sand and water 1.
 *
 * Same two exclusions as the AO pass: pixels the G-buffer never covered (sky), and
 * pixels a transparent surface was drawn over — detected as `|read − opaqueRT|`, since
 * the scene pass snapshots `opaqueRT` between the opaque and transparent draws.
 *
 * ---------------------------------------------------------------------------
 * WATER, AND THE ONE-FRAME CAVEAT
 *
 * Water is on `LAYER.TRANSPARENT`, and the G-buffer pre-pass only rasterises
 * `LAYER.OPAQUE | LAYER.DEFAULT`. So the water surface has **no normal, no roughness and
 * no depth in the G-buffer**, and this pass cannot reflect off it — at a water pixel the
 * G-buffer describes the seabed behind it.
 *
 * **Read this before wiring anything to `ssrTexture`.** As of today NOTHING in `src/`
 * samples it — grep `ssrTexture|tSSR` outside this file and you get nothing — so the sea,
 * the largest reflective surface in the `ref_01500` frame, has no reflection path from
 * either direction. And the buffer is not a drop-in fix for that, because **the rays in it
 * were traced from the opaque surface under the water, not from the water surface**: at a
 * sea pixel `ssrTexture` holds a reflection computed off the seabed's normal, which is not
 * the reflection the sea should show. It is a correct, useful buffer for the *wet sand*
 * — which is opaque and IS in the G-buffer, and is where most of the `shoreline` region's
 * high-frequency energy lives — and it is a bad answer for open water.
 *
 * The right fix for the sea is research §6.2 option (2): trace SSR **inside the ocean
 * surface shader**, from the water surface, against the opaque depth buffer. The ray
 * origin and the wave normal are both correct there, there is no one-frame lag, and the
 * opaque depth it needs is `pipe.depthTex`, which since KNOWN_ISSUES §18 closed actually
 * contains the world — before that there was no usable depth for it to march against,
 * which is a large part of why this was never wired up.
 *
 * If the ocean owner instead wants the published-texture route (§6.2 option 1), the
 * binding is:
 *
 *     const ssr = ctx.get('pipeline')?.pass('ssr');
 *     u.tSSR.value = ssr?.ssrTexture ?? null;      // half res, rgb = radiance,
 *                                                  // a = confidence 0..1
 *
 * — and it must be reprojected by the camera delta, because a scene-pass material reads
 * **last frame's** buffer (the post chain runs after the scene draws), and it must accept
 * the seabed-origin caveat above.
 *
 * ---------------------------------------------------------------------------
 * ctx.config knobs
 *   ssrEnabled 1     ssrStrength 1.0    ssrMaxDist 90     ssrThickness 0.55
 *   ssrThickMax 2.5  ssrEdgeFade 0.12   ssrAlpha 0.15     ssrWetRoughClamp 0.12
 *   ssrDepthPhi 0.06
 *   ssrDebug 0       1 = reflection, 2 = confidence, 3 = applied weight
 */

const COMMON = /* glsl */`
const float SKY_Z = 5.0e4;
float ign(vec2 px, float frame){
  vec3 m = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(m.z * fract(dot(px + 5.588238 * frame, m.xy)));
}
float linearDepth(float d, float n, float f){
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / max(f + n - z * (f - n), 1e-6);
}
`;

const VIEWPOS = /* glsl */`
uniform vec2 uTanHalf;
uniform vec2 uJitter;
vec3 viewPos(vec2 uv, float lz){
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3((ndc + uJitter) * uTanHalf * lz, -lz);
}
`;

/* ------------------------------------------------------- 1. colour pyramid */

const DOWN_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // texel size of the SOURCE
out vec4 oCol;

/** 8-tap tent. The inner four taps sit exactly on the four source texels this
 *  destination texel covers (a bit-exact 2x2 box); the outer four widen it just enough
 *  that a chain of five levels reads as a blur rather than as a mosaic — which matters,
 *  because level 3 and 4 are what a rough reflection actually samples. */
void main(){
  vec3 a = texture(tSrc, vUv + vec2(-0.5, -0.5) * uTexel).rgb
         + texture(tSrc, vUv + vec2( 0.5, -0.5) * uTexel).rgb
         + texture(tSrc, vUv + vec2(-0.5,  0.5) * uTexel).rgb
         + texture(tSrc, vUv + vec2( 0.5,  0.5) * uTexel).rgb;
  vec3 b = texture(tSrc, vUv + vec2(-1.5, -1.5) * uTexel).rgb
         + texture(tSrc, vUv + vec2( 1.5, -1.5) * uTexel).rgb
         + texture(tSrc, vUv + vec2(-1.5,  1.5) * uTexel).rgb
         + texture(tSrc, vUv + vec2( 1.5,  1.5) * uTexel).rgb;
  oCol = vec4(a * 0.1875 + b * 0.0625, 1.0);
}
`;

/* --------------------------------------------------------------- 2. march */

const MARCH_FRAG = COMMON + VIEWPOS + /* glsl */`
in vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tGbuf0;
uniform sampler2D tGbuf1;
uniform sampler2D tMip0, tMip1, tMip2, tMip3, tMip4;
uniform mat4  uProj;         // jittered — matches the depth buffer as rasterised
uniform vec2  uRes;          // half-res dimensions of this target
uniform float uNear, uFar;
uniform float uMaxDist;
uniform float uThickness;
uniform float uEdgeFade;
uniform float uFrame;
uniform float uProjScaleY;   // 0.5 * mip0Height / tanY  — world→pixels at unit depth
uniform float uWetRoughClamp;
uniform float uThickMax;
out vec4 oCol;

vec3 sampleMip(vec2 uv, float lod){
  float l = clamp(lod, 0.0, 4.0);
  float f = fract(l);
  int i = int(floor(l));
  vec3 a, b;
  // textureLod, not texture: the fetch sits in non-uniform control flow, where implicit
  // derivatives are undefined.
  if (i <= 0)      { a = textureLod(tMip0, uv, 0.0).rgb; b = textureLod(tMip1, uv, 0.0).rgb; }
  else if (i == 1) { a = textureLod(tMip1, uv, 0.0).rgb; b = textureLod(tMip2, uv, 0.0).rgb; }
  else if (i == 2) { a = textureLod(tMip2, uv, 0.0).rgb; b = textureLod(tMip3, uv, 0.0).rgb; }
  else if (i == 3) { a = textureLod(tMip3, uv, 0.0).rgb; b = textureLod(tMip4, uv, 0.0).rgb; }
  else             { a = textureLod(tMip4, uv, 0.0).rgb; b = a; }
  return mix(a, b, f);
}

/** Which materials get a screen-space reflection at all, and how strongly. */
float gainFor(int id){
  if (id == 2) return 1.0;    // wet sand — the reason this pass exists
  if (id == 6) return 1.0;    // water
  if (id == 4) return 0.65;   // Forerunner alloy
  if (id == 9) return 0.80;   // metal
  if (id == 3) return 0.35;   // rock
  if (id == 1) return 0.15;   // dry sand: a faint sheen, no more
  if (id == 5) return 0.0;    // foliage
  if (id == 8) return 0.0;    // viewmodel — its own pass owns its look
  return 0.25;
}

void main(){
  vec4 g1 = texture(tGbuf1, vUv);
  float d0 = texture(tDepth, vUv).r;
  if (g1.a < 0.5 || d0 >= 1.0) { oCol = vec4(0.0); return; }

  int matId = int(g1.b * 255.0 + 0.5);
  float gain = gainFor(matId);
  if (gain <= 0.0) { oCol = vec4(0.0); return; }

  vec4 g0 = texture(tGbuf0, vUv);
  vec3 N = g0.xyz * 2.0 - 1.0;
  float nl = length(N);
  if (nl < 1e-4) { oCol = vec4(0.0); return; }
  N /= nl;
  float rough = clamp(g0.w, 0.02, 1.0);
  // A swash sheet is a water film, not sand. If the terrain material left the G-buffer
  // roughness at the generic default this clamp is what stops the reflection being
  // blurred into nothing; if terrain authors a properly low value the clamp is inert.
  if (matId == 2 || matId == 6) rough = min(rough, uWetRoughClamp);
  if (rough > 0.92) { oCol = vec4(0.0); return; }

  float linZ = linearDepth(d0, uNear, uFar);
  vec3 P = viewPos(vUv, linZ);
  vec3 V = normalize(-P);
  vec3 R = reflect(-V, N);

  // Rays coming back at the camera can only "hit" the front layer of the depth buffer,
  // which is by definition not what they would see. Cheap to reject here, and it saves
  // the whole march.
  float facing = 1.0 - smoothstep(0.15, 0.55, dot(R, V));
  if (facing <= 0.001) { oCol = vec4(0.0); return; }

  // Offset the origin off the surface, scaled with depth so it is a constant number of
  // pixels rather than a constant number of metres. Without it every grazing ray
  // self-intersects on its first tap.
  vec3 O = P + N * (0.012 + 0.004 * linZ);

  float maxT = uMaxDist;
  // Clip against the near plane, or the projection of the far endpoint flips sign and
  // the screen-space segment becomes garbage.
  if (O.z + R.z * maxT > -uNear) maxT = (-uNear - O.z) / R.z;
  if (maxT <= 0.01) { oCol = vec4(0.0); return; }
  vec3 E = O + R * maxT;

  vec4 c0 = uProj * vec4(O, 1.0);
  vec4 c1 = uProj * vec4(E, 1.0);
  if (c0.w <= 1e-5 || c1.w <= 1e-5) { oCol = vec4(0.0); return; }
  vec2 s0 = (c0.xy / c0.w) * 0.5 + 0.5;
  vec2 s1 = (c1.xy / c1.w) * 0.5 + 0.5;
  float iz0 = 1.0 / c0.w;      // c.w == -z for a perspective projection, so this is 1/linZ
  float iz1 = 1.0 / c1.w;

  // Screen-space DDA: uv interpolates linearly, 1/z interpolates linearly. Anything else
  // is wrong under perspective, and on a grazing ray it is wrong by tens of metres.
  float dither = ign(floor(vUv * uRes), uFrame);

  // McGuire & Mara's per-step depth INTERVAL test, not a point sample plus a scalar
  // thickness. Each step covers the ray-depth range [zA, zB]; the surface at the sampled
  // pixel occupies [sz, sz + thick]. Accept only when those two overlap. This is what
  // makes the test robust when one step spans several pixels, which on a 90 m grazing ray
  // at 24 steps it always does in the far field.
  //
  // The version this replaced used 'thick = max(uThickness, stepExtent * 1.6)', i.e. it let
  // the acceptance window track the step's own depth extent with no bound — tens of metres
  // out at the far end of the march. That accepts almost any depth sample and produces
  // research 7's 'duplicated silhouette offset downward'. The extent is now handled by the
  // interval itself, so 'thick' is just an object-thickness allowance and is CAPPED
  // ('uThickMax', 2.5 m) at something scene-scaled.
  float hitU = -1.0;
  float prevU = 0.0;
  float rzPrev = 1.0 / max(iz0, 1e-9);
  for (int i = 1; i <= SSR_STEPS; i++) {
    float u = (float(i) - dither) / float(SSR_STEPS);
    vec2 suv = mix(s0, s1, u);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
    float rz = 1.0 / mix(iz0, iz1, u);
    float sd = texture(tDepth, suv).r;
    if (sd >= 1.0) { prevU = u; rzPrev = rz; continue; }   // sky: never an occluder
    float sz = linearDepth(sd, uNear, uFar);
    float zA = min(rzPrev, rz), zB = max(rzPrev, rz);
    float thick = min(uThickness + (zB - zA) * 0.25, uThickMax);
    if (zB >= sz && zA <= sz + thick) { hitU = u; break; }
    prevU = u;
    rzPrev = rz;
  }

  if (hitU < 0.0) { oCol = vec4(0.0); return; }

  // Bisect between the last miss and the hit.
  float lo = prevU, hi = hitU;
  for (int i = 0; i < SSR_REFINE; i++) {
    float mid = 0.5 * (lo + hi);
    vec2 suv = mix(s0, s1, mid);
    float sd = texture(tDepth, suv).r;
    float rz = 1.0 / mix(iz0, iz1, mid);
    float sz = (sd >= 1.0) ? 1.0e9 : linearDepth(sd, uNear, uFar);
    if (rz - sz > 0.0) hi = mid; else lo = mid;
  }
  float u = hi;
  vec2 hitUv = mix(s0, s1, u);
  float hitZ = 1.0 / mix(iz0, iz1, u);
  float rayLen = length(viewPos(hitUv, hitZ) - O);

  // ---- confidence ---------------------------------------------------------
  // edge: 2-D, per axis. A ray leaving through a corner must fade on both.
  vec2 ef = smoothstep(vec2(0.0), vec2(uEdgeFade), hitUv)
          * smoothstep(vec2(0.0), vec2(uEdgeFade), 1.0 - hitUv);
  float fade = ef.x * ef.y;
  // length: the tail of the march fades so a ray that just barely found something does
  // not pop against one that ran out.
  fade *= 1.0 - smoothstep(0.7, 1.0, u);
  fade *= facing;
  // backface: we landed on the far side of something.
  vec3 hn = texture(tGbuf0, hitUv).xyz * 2.0 - 1.0;
  float hnl = length(hn);
  if (hnl > 1e-4) fade *= smoothstep(-0.05, 0.25, dot(hn / hnl, -R));

  if (fade <= 0.002) { oCol = vec4(0.0); return; }

  // ---- roughness cone -> mip level ---------------------------------------
  float a2 = rough * rough;
  float coneTan = a2 * 1.6 + rough * 0.05;
  // Frostbite's grazing-angle cone shrink (slide 85), which was missing entirely:
  //   specularConeTangent *= lerp(saturate(NdotV * 2), 1, sqrt(roughness))
  // Their reasoning (slide 84): a GGX lobe becomes anisotropic at grazing incidence, and a
  // cone fitted to the wider *azimuthal* angle over-blurs badly. Fit it to the polar angle
  // instead. This scene is the worst case in the literature for it — every reflection that
  // matters is a wet-sand or swash pixel at 2-10 degrees, where NoV ~ 0.07 and the
  // unshrunk cone drives the LOD straight into the max-mip clamp. Max mip here is
  // 1920/32 = 60 px wide, so 'the inverted silhouette of the sea stacks' — the entire
  // visual payload of this pass — was being read out of a 60-pixel image.
  float NoV = clamp(dot(N, V), 0.0, 1.0);
  coneTan *= mix(clamp(NoV * 2.0, 0.0, 1.0), 1.0, sqrt(rough));
  float footprintPx = 2.0 * coneTan * rayLen * (uProjScaleY / max(hitZ, 1e-3));
  float lod = clamp(log2(max(footprintPx, 1.0)), 0.0, 4.0);

  vec3 col = sampleMip(hitUv, lod);
  // Half-float targets can carry a NaN out of a failed material; one of those poisons
  // the temporal accumulator permanently.
  col = clamp(mix(vec3(0.0), col, vec3(equal(col, col))), vec3(0.0), vec3(60000.0));

  oCol = vec4(col, fade);
}
`;

/* ------------------------------------------------------------ 3. temporal */

const TEMPORAL_FRAG = COMMON + VIEWPOS + /* glsl */`
in vec2 vUv;
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform sampler2D tGbuf1;
uniform mat4  uCamWorld;
uniform mat4  uCurrVP;
uniform mat4  uPrevVP;
uniform mat4  uPrevView;
uniform float uNear, uFar;
uniform float uAlpha;
uniform float uValid;
out vec4 oCol;

void main(){
  vec4 cur = texture(tCur, vUv);
  float d = texture(tDepth, vUv).r;
  vec4 g1 = texture(tGbuf1, vUv);
  if (g1.a < 0.5 || d >= 1.0) { oCol = cur; return; }

  // Same depth-derived reprojection as taa.js and ssao.js, for the same reason: the
  // G-buffer velocity is built from a jittered current view-projection against an
  // un-jittered previous one (KNOWN_ISSUES #1), so it carries a half-pixel error per
  // frame. Accumulating a reflection through that smears it.
  float linZ = linearDepth(d, uNear, uFar);
  vec3 wp = (uCamWorld * vec4(viewPos(vUv, linZ), 1.0)).xyz;
  vec4 cc = uCurrVP * vec4(wp, 1.0);
  vec4 pc = uPrevVP * vec4(wp, 1.0);
  float valid = uValid;
  if (cc.w <= 1e-5 || pc.w <= 1e-5) valid = 0.0;
  vec2 mv = (cc.xy / max(cc.w, 1e-5)) * 0.5 - (pc.xy / max(pc.w, 1e-5)) * 0.5;
  vec2 prevUV = vUv - mv;
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) valid = 0.0;

  vec4 h = texture(tHist, clamp(prevUV, vec2(0.0), vec2(1.0)));
  float prevLinZ = -(uPrevView * vec4(wp, 1.0)).z;
  // The history's own depth is not stored (all four channels are spoken for), so
  // disocclusion is caught by depth continuity against the *current* buffer at the
  // reprojected pixel plus a confidence-jump test. A reflection that changes character
  // wholesale between frames is a disocclusion whatever the depth says.
  float hd = texture(tDepth, clamp(prevUV, vec2(0.0), vec2(1.0))).r;
  float hLinZ = linearDepth(hd, uNear, uFar);
  if (abs(hLinZ - prevLinZ) > 0.05 * prevLinZ + 0.05) valid = 0.0;

  float a = mix(1.0, uAlpha, valid);
  // Confidence leads the blend: a pixel that just started hitting something should adopt
  // the hit quickly rather than fading it in over 1/alpha frames, which reads as a wipe.
  a = max(a, clamp(abs(cur.a - h.a) * 2.0, 0.0, 1.0) * valid);
  oCol = mix(h, cur, a);
}
`;

/* --------------------------------------------------------------- 4. apply */

const APPLY_FRAG = COMMON + VIEWPOS + /* glsl */`
precision highp samplerCube;   // ESSL 3.00 defaults samplers to lowp; the sky is HDR
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tOpaque;
uniform sampler2D tSSR;
uniform sampler2D tDepth;
uniform sampler2D tGbuf0;
uniform sampler2D tGbuf1;
uniform samplerCube tSkyCube;
uniform float uHasSkyCube;
uniform vec3  uSkyUp, uSkyHoriz;
uniform mat3  uViewToWorld;
uniform vec2  uSsrTexel, uSsrRes;
uniform float uNear, uFar;
uniform float uStrength;
uniform float uWetRoughClamp;
uniform float uDepthPhi;
uniform float uDebug;
out vec4 oCol;

/** Karis's analytic split-sum EnvBRDF, the same fit three ships as 'DFGApprox' in
 *  'bsdfs.glsl.js'. Returns (A, B) for 'specular = prefiltered * (F0*A + B)'. */
vec2 dfgApprox(float NoV, float rough){
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572,  0.022);
  const vec4 c1 = vec4( 1.0,  0.0425,  1.040, -0.040);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

float gainFor(int id){
  if (id == 2) return 1.0;
  if (id == 6) return 1.0;
  if (id == 4) return 0.65;
  if (id == 9) return 0.80;
  if (id == 3) return 0.35;
  if (id == 1) return 0.15;
  if (id == 5) return 0.0;
  if (id == 8) return 0.0;
  return 0.25;
}
float f0For(int id){
  if (id == 2) return 0.045;   // water film on sand
  if (id == 6) return 0.020;   // water
  if (id == 4) return 0.070;   // Forerunner alloy, semi-metallic
  if (id == 9) return 0.300;   // metal
  return 0.035;
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;
  vec4 g1 = texture(tGbuf1, vUv);
  float d0 = texture(tDepth, vUv).r;
  if (g1.a < 0.5 || d0 >= 1.0 || uStrength <= 0.0) { oCol = vec4(src, 1.0); return; }

  int matId = int(g1.b * 255.0 + 0.5);
  float gain = gainFor(matId);
  if (gain <= 0.0) { oCol = vec4(src, 1.0); return; }

  vec4 g0 = texture(tGbuf0, vUv);
  vec3 N = g0.xyz * 2.0 - 1.0;
  float nl = length(N);
  if (nl < 1e-4) { oCol = vec4(src, 1.0); return; }
  N /= nl;
  float rough = clamp(g0.w, 0.02, 1.0);
  if (matId == 2 || matId == 6) rough = min(rough, uWetRoughClamp);

  float linZ = linearDepth(d0, uNear, uFar);
  vec3 V = normalize(vec3(-(vUv * 2.0 - 1.0 + uJitter) * uTanHalf, 1.0));
  vec3 R = reflect(-V, N);
  float NoV = clamp(dot(N, V), 1e-3, 1.0);

  // --- plane-distance bilateral upsample of the half-res reflection. Straight bilinear
  // drags a sea stack's reflection across the silhouette of whatever is in front of it.
  // The weight is the tap's distance from this pixel's tangent plane rather than |Δz|:
  // on a beach at 4 degrees the raw depth difference between neighbouring pixels is
  // metres on a perfectly smooth surface, so a |Δz| tolerance either refuses to
  // reconstruct the sand or leaks across every silhouette. Same fix as ssao.js's two
  // bilaterals; see the note there.
  vec3 Pc = viewPos(vUv, linZ);
  float phi = uDepthPhi + 0.012 * linZ;
  vec2 fp = vUv * uSsrRes - 0.5;
  vec2 base = floor(fp);
  vec2 f = fp - base;
  vec4 acc = vec4(0.0);
  float wSum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i & 1), float(i >> 1));
    vec2 suv = (base + o + 0.5) * uSsrTexel;
    float sd = texture(tDepth, suv).r;
    float sz = linearDepth(sd, uNear, uFar);
    float bw = ((i & 1) == 0 ? 1.0 - f.x : f.x) * ((i >> 1) == 0 ? 1.0 - f.y : f.y);
    float dd = abs(dot(viewPos(suv, sz) - Pc, N));
    float dw = (sd >= 1.0) ? 0.0 : max(1.0 - dd / phi, 0.0);
    float w = bw * dw + 1e-5;
    acc += texture(tSSR, suv) * w;
    wSum += w;
  }
  acc /= wSum;
  float conf = clamp(acc.a, 0.0, 1.0);

  // --- fallback: the real sky, in the real reflected direction. Fading a reflection to
  // the sky rather than to nothing is what removes the screen-edge seam.
  vec3 Rw = normalize(uViewToWorld * R);
  vec3 skyCol = uHasSkyCube > 0.5
    ? texture(tSkyCube, Rw).rgb
    : mix(uSkyHoriz, uSkyUp, clamp(Rw.y * 0.5 + 0.5, 0.0, 1.0));
  skyCol = clamp(mix(vec3(0.0), skyCol, vec3(equal(skyCol, skyCol))), vec3(0.0), vec3(60000.0));

  vec3 refl = mix(skyCol, acc.rgb, conf);

  // --- energy weight: the PRE-INTEGRATED EnvBRDF, not raw Schlick.
  //
  // Raw 'F = f0 + (1-f0)(1-NoV)^5' at 4 degrees grazing returns ~1 for every material in
  // the frame, which turns the whole shoreline into a mirror and washes it out — research
  // 5.8b, and exactly the shoreline signature this frame had (lum_mean +37, sat_mean -13).
  // The split-sum '(F0*A + B)' carries the geometric attenuation term that pulls grazing
  // reflectance back down, and it is the correct weight when the reflection has been
  // prefiltered into a mip chain, which it has. Applied AFTER the temporal filter and
  // AFTER the sky/SSR mix, identically to both branches (Frostbite slide 87, research
  // 5.4/5.7): weighting one branch and not the other puts a brightness step at the fade.
  float f0 = f0For(matId);
  vec2 ab = dfgApprox(NoV, rough);
  float k = (f0 * ab.x + ab.y) * gain * (1.0 - smoothstep(0.35, 0.9, rough)) * uStrength;

  // Do not reflect off a pixel that a transparent surface was drawn over — see the
  // header. Water in particular is not in the G-buffer at all.
  //
  // The test is chromatic, not a magnitude difference, and that is deliberate: the ssao
  // pass runs earlier in the chain and has already multiplied tSrc by its occlusion term,
  // so abs(src - opaque) is large in every crease in the frame and a magnitude test would
  // switch reflections off exactly where the geometry is most interesting. An AO multiply
  // is near-neutral in hue and can only darken; a water sheet or a particle changes the
  // chromaticity and frequently brightens. Testing those two things instead is immune to
  // whatever the earlier pass did.
  vec3 opq = texture(tOpaque, vUv).rgb;
  float ls = dot(src, vec3(0.2126, 0.7152, 0.0722));
  float lo = dot(opq, vec3(0.2126, 0.7152, 0.0722));
  float chroma = length(src / max(ls, 1e-4) - opq / max(lo, 1e-4));
  float brighter = max(ls / max(lo, 1e-4) - 1.0, 0.0);
  k *= 1.0 - smoothstep(0.10, 0.45, chroma * 1.5 + brighter);
  k = clamp(k, 0.0, 0.92);

  if (uDebug > 2.5)      { oCol = vec4(vec3(k), 1.0); return; }
  else if (uDebug > 1.5) { oCol = vec4(vec3(conf), 1.0); return; }
  else if (uDebug > 0.5) { oCol = vec4(refl, 1.0); return; }

  oCol = vec4(mix(src, refl, k), 1.0);
}
`;

/* ------------------------------------------------------------------ module */

export function create(opts = {}) {
  const p = new Pass('ssr');
  p.needsSwap = false;

  const cfg = Object.assign({
    steps: 24,
    refine: 5,
    maxDist: 90,
    thickness: 0.55,
    thickMax: 2.5,
    edgeFade: 0.12,
    strength: 1.0,
    alpha: 0.15,
    // A swash sheet is a water film. terrain.js:1601 writes 0.65 into the G-buffer for wet
    // sand while terrain.js:1650 *shades* the same pixel at mix(rough, 0.16, wetp*0.85) —
    // the comment two lines above the write says the two must agree and they do not. Until
    // that is reconciled by the terrain owner this clamp is what the trace actually sees,
    // so it is set to the shaded value's neighbourhood (research 6.3: wet sand is
    // mix(rough_dry, 0.05..0.15, wetness)), not to the 0.42 it shipped with. At 0.42 the
    // cone footprint saturated the mip clamp for every ray that mattered.
    wetRoughClamp: 0.12,
    depthPhi: 0.06,
    mips: 5,
  }, opts.ssr || {});

  let mipRT = [];
  let marchRT = null, histA = null, histB = null;
  let downMat = null, marchMat = null, tempMat = null, applyMat = null;
  let quad = null;
  let W = 0, H = 0, sw = 0, sh = 0;
  let frames = 0, lastPipeFrame = -99;
  let geomProbe = 0, geomFrame = -999;

  const prevView = new THREE.Matrix4();
  const _m3 = new THREE.Matrix3();

  const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  BLACK.needsUpdate = true;

  /** Half-resolution reflection buffer: `.rgb` linear HDR radiance already cone-traced
   *  for roughness, `.a` confidence 0..1 (0 = no screen-space answer, use your own sky
   *  fallback). Never null. */
  p.ssrTexture = BLACK;
  p.ssrLayout = { radiance: 'rgb', confidence: 'a', scale: 0.5 };

  const hasOpaqueGeometry = (ctx, frame) => {
    if (frame - geomFrame < 30 && geomFrame >= 0) return geomProbe === 1;
    geomFrame = frame;
    geomProbe = 0;
    const mask = (1 << 1) | (1 << 0);   // LAYER.OPAQUE | LAYER.DEFAULT
    ctx.scene.traverse((o) => {
      if (geomProbe) return;
      if ((o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) && o.visible && (o.layers.mask & mask) !== 0) geomProbe = 1;
    });
    return geomProbe === 1;
  };

  p.init = (ctx, pipe) => {
    downMat = fsMaterial(DOWN_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    });

    marchMat = fsMaterial(MARCH_FRAG, {
      tDepth: { value: null }, tGbuf0: { value: null }, tGbuf1: { value: null },
      tMip0: { value: null }, tMip1: { value: null }, tMip2: { value: null },
      tMip3: { value: null }, tMip4: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uTanHalf: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() },
      uRes: { value: new THREE.Vector2() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
      uMaxDist: { value: cfg.maxDist }, uThickness: { value: cfg.thickness }, uThickMax: { value: cfg.thickMax },
      uEdgeFade: { value: cfg.edgeFade }, uFrame: { value: 0 },
      uProjScaleY: { value: 500 }, uWetRoughClamp: { value: cfg.wetRoughClamp },
    }, { SSR_STEPS: cfg.steps, SSR_REFINE: cfg.refine });

    tempMat = fsMaterial(TEMPORAL_FRAG, {
      tCur: { value: null }, tHist: { value: null },
      tDepth: { value: null }, tGbuf1: { value: null },
      uTanHalf: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCurrVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
      uPrevView: { value: new THREE.Matrix4() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
      uAlpha: { value: cfg.alpha }, uValid: { value: 0 },
    });

    applyMat = fsMaterial(APPLY_FRAG, {
      tSrc: { value: null }, tOpaque: { value: null }, tSSR: { value: null },
      tDepth: { value: null }, tGbuf0: { value: null }, tGbuf1: { value: null },
      tSkyCube: { value: null }, uHasSkyCube: { value: 0 },
      uSkyUp: { value: new THREE.Color(0.30, 0.45, 0.78) },
      uSkyHoriz: { value: new THREE.Color(0.62, 0.68, 0.76) },
      uViewToWorld: { value: new THREE.Matrix3() },
      uSsrTexel: { value: new THREE.Vector2() }, uSsrRes: { value: new THREE.Vector2() },
      uTanHalf: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
      uStrength: { value: cfg.strength }, uWetRoughClamp: { value: cfg.wetRoughClamp },
      uDepthPhi: { value: cfg.depthPhi },
      uDebug: { value: 0 },
    });

    for (const m of [downMat, marchMat, tempMat, applyMat]) m.blending = THREE.NoBlending;
    quad = new FullScreenQuad(downMat);

    ctx.on?.('camera:teleport', () => { frames = 0; });
    ctx.on?.('engine:resize', () => { frames = 0; });

    p.setSize(pipe.w > 2 ? pipe.w : ctx.size.w, pipe.h > 2 ? pipe.h : ctx.size.h, ctx);
  };

  p.setSize = (w, h) => {
    if (!downMat || (w === W && h === H && marchRT)) return;
    W = w; H = h;
    sw = Math.max(2, Math.ceil(w / 2));
    sh = Math.max(2, Math.ceil(h / 2));
    frames = 0;
    for (const rt of mipRT) rt.dispose();
    mipRT = [];
    for (let i = 0; i < cfg.mips; i++) {
      mipRT.push(makeRT(Math.max(2, Math.ceil(w / (2 << i))), Math.max(2, Math.ceil(h / (2 << i)))));
    }
    for (const rt of [marchRT, histA, histB]) rt?.dispose();
    marchRT = makeRT(sw, sh);
    histA = makeRT(sw, sh);
    histB = makeRT(sw, sh);
    p.ssrTexture = histA.texture;
  };

  p.render = (ctx, pipe) => {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const c = ctx.config || {};
    if (!marchRT || sw !== Math.max(2, Math.ceil(pipe.w / 2))) p.setSize(pipe.w, pipe.h, ctx);

    if ((c.ssrEnabled ?? 1) === 0) return;

    // No opaque geometry: nothing to reflect off and nothing to reflect. Leave the chain
    // and `ssrTexture` alone rather than paying for eight full-screen draws.
    if (!hasOpaqueGeometry(ctx, pipe.frameIndex)) {
      p.ssrTexture = BLACK; frames = 0;
      return;
    }

    if (pipe.frameIndex !== lastPipeFrame + 1) frames = 0;
    lastPipeFrame = pipe.frameIndex;

    const pe = pipe.unjitteredProj.elements;
    const tanX = 1 / Math.max(Math.abs(pe[0]), 1e-6);
    const tanY = 1 / Math.max(Math.abs(pe[5]), 1e-6);
    // Canonical world depth (KNOWN_ISSUES §18 closed). The private snapshot this used to
    // read was proved bit-identical and has been deleted; see the header of ssao.js.
    const depthTex = pipe.depthTex;

    /* -------------------------------------------------- 1. colour pyramid */
    {
      quad.material = downMat;
      const u = downMat.uniforms;
      u.tSrc.value = pipe.opaqueRT.texture;
      u.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
      r.setRenderTarget(mipRT[0]);
      quad.render(r);
      for (let i = 1; i < mipRT.length; i++) {
        u.tSrc.value = mipRT[i - 1].texture;
        u.uTexel.value.set(1 / mipRT[i - 1].width, 1 / mipRT[i - 1].height);
        r.setRenderTarget(mipRT[i]);
        quad.render(r);
      }
    }

    /* ---------------------------------------------------------- 2. march */
    {
      const u = marchMat.uniforms;
      u.tDepth.value = depthTex;
      u.tGbuf0.value = pipe.gbuffer.textures[0];
      u.tGbuf1.value = pipe.gbuffer.textures[1];
      for (let i = 0; i < 5; i++) u['tMip' + i].value = mipRT[Math.min(i, mipRT.length - 1)].texture;
      // The jittered projection, because it is what rasterised the depth buffer this
      // march is testing against.
      u.uProj.value.copy(cam.projectionMatrix);
      u.uTanHalf.value.set(tanX, tanY);
      u.uJitter.value.copy(pipe.jitter);
      u.uRes.value.set(sw, sh);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      u.uMaxDist.value = Math.max(1, c.ssrMaxDist ?? cfg.maxDist);
      u.uThickness.value = Math.max(0.01, c.ssrThickness ?? cfg.thickness);
      u.uThickMax.value = Math.max(0.05, c.ssrThickMax ?? cfg.thickMax);
      u.uEdgeFade.value = THREE.MathUtils.clamp(c.ssrEdgeFade ?? cfg.edgeFade, 0.001, 0.45);
      u.uWetRoughClamp.value = THREE.MathUtils.clamp(c.ssrWetRoughClamp ?? cfg.wetRoughClamp, 0.02, 1.0);
      // Deterministic: driven by the pipeline frame counter, never a clock.
      u.uFrame.value = pipe.frameIndex % 64;
      // World units -> mip0 pixels at unit depth, for the cone footprint.
      u.uProjScaleY.value = 0.5 * mipRT[0].height / tanY;
      quad.material = marchMat;
      r.setRenderTarget(marchRT);
      quad.render(r);
    }

    /* ------------------------------------------------------- 3. temporal */
    {
      const u = tempMat.uniforms;
      u.tCur.value = marchRT.texture;
      u.tHist.value = histA.texture;
      u.tDepth.value = depthTex;
      u.tGbuf1.value = pipe.gbuffer.textures[1];
      u.uTanHalf.value.set(tanX, tanY);
      u.uJitter.value.copy(pipe.jitter);
      u.uCamWorld.value.copy(cam.matrixWorld);
      u.uCurrVP.value.copy(pipe.currViewProj);
      u.uPrevVP.value.copy(pipe.prevViewProj);
      u.uPrevView.value.copy(prevView);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      u.uAlpha.value = THREE.MathUtils.clamp(c.ssrAlpha ?? cfg.alpha, 0.03, 1.0);
      u.uValid.value = frames > 0 ? 1 : 0;
      quad.material = tempMat;
      r.setRenderTarget(histB);
      quad.render(r);
      const t = histA; histA = histB; histB = t;
      p.ssrTexture = histA.texture;
    }

    /* ---------------------------------------------------------- 4. apply */
    {
      const u = applyMat.uniforms;
      u.tSrc.value = pipe.read.texture;
      u.tOpaque.value = pipe.opaqueRT.texture;
      u.tSSR.value = histA.texture;
      u.tDepth.value = depthTex;
      u.tGbuf0.value = pipe.gbuffer.textures[0];
      u.tGbuf1.value = pipe.gbuffer.textures[1];
      u.uSsrTexel.value.set(1 / sw, 1 / sh);
      u.uSsrRes.value.set(sw, sh);
      u.uTanHalf.value.set(tanX, tanY);
      u.uJitter.value.copy(pipe.jitter);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      u.uStrength.value = Math.max(0, c.ssrStrength ?? cfg.strength);
      u.uWetRoughClamp.value = THREE.MathUtils.clamp(c.ssrWetRoughClamp ?? cfg.wetRoughClamp, 0.02, 1.0);
      u.uDepthPhi.value = Math.max(0.005, c.ssrDepthPhi ?? cfg.depthPhi);
      u.uDebug.value = c.ssrDebug ?? 0;

      // Reflection directions are world-space; the G-buffer normal is view-space.
      _m3.setFromMatrix4(cam.matrixWorld);
      u.uViewToWorld.value.copy(_m3);

      // Sky fallback. `sky.cubeTexture` is a half-float cube rendered from the camera
      // each frame — exactly the right thing for an off-screen reflection. Guarded:
      // with `?only=pipeline` there is no sky module, and the analytic gradient from
      // `time` takes over.
      const sky = ctx.get?.('sky');
      const cube = sky?.cubeTexture || null;
      u.tSkyCube.value = cube;
      u.uHasSkyCube.value = cube ? 1 : 0;
      const time = ctx.get?.('time');
      if (time) {
        u.uSkyUp.value.copy(time.skyColor).multiplyScalar(1.6);
        u.uSkyHoriz.value.copy(time.skyColor).lerp(time.sunColor, 0.35).multiplyScalar(1.9);
      }

      quad.material = applyMat;
      r.setRenderTarget(pipe.write);
      quad.render(r);
    }

    // See the note in ssao.js: needsSwap is false so the pipeline will not rotate the
    // chain, but the composite above is a chain write, so rotate it here.
    pipe.swap();

    prevView.copy(cam.matrixWorldInverse);
    frames++;
  };

  p.dispose = () => {
    for (const rt of mipRT) rt.dispose();
    for (const rt of [marchRT, histA, histB]) rt?.dispose();
    for (const m of [downMat, marchMat, tempMat, applyMat]) m?.dispose();
    BLACK.dispose();
    quad?.dispose();
  };

  return p;
}
