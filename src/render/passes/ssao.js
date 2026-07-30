import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `ssao` — **GTAO** (ground-truth ambient occlusion), not random-sample SSAO.
 *
 * `needsSwap = false`. The pass owns its own half-resolution AO target and exposes it as
 * `pass.aoTexture`; it does not sit in the ping-pong chain. It *does* composite its own
 * result (see "How the AO is applied" below), because nothing else in the engine reads
 * `aoTexture` yet and an AO buffer nobody samples is an AO buffer nobody can judge.
 *
 * ---------------------------------------------------------------------------
 * WHY GTAO AND NOT SSAO
 *
 * Classic SSAO integrates a random point cloud in a hemisphere and reports the fraction
 * of samples that fell behind geometry. That estimator has two problems that show up
 * immediately on a beach: it is not the visibility integral anybody's lighting model
 * actually wants (it has no cosine weight, so it over-darkens grazing geometry — every
 * sand ripple), and its variance is proportional to 1/sqrt(N), so the only way to make
 * it quiet is to spend samples.
 *
 * GTAO instead finds, per slice through the view vector, the two *horizon angles* — the
 * highest angle above the surface at which the depth buffer occludes — and then
 * evaluates the cosine-weighted visibility integral over that arc **analytically**:
 *
 *     a = ¼(−cos(2h₁ − n) + cos n + 2h₁ sin n) + ¼(−cos(2h₂ − n) + cos n + 2h₂ sin n)
 *
 * with `n` the signed angle of the surface normal projected into the slice plane, and
 * h₁/h₂ the two horizons clamped to the normal-oriented hemisphere. The estimator is
 * exact for the depth field it is given; the only error left is the slice discretisation,
 * which is *directional* rather than white — and directional error is exactly what a
 * per-pixel rotation plus a temporal accumulation removes for free. That is why 2 slices
 * × 6 steps here looks cleaner than 16 random samples would, at a third of the taps.
 *
 * Following Jimenez et al. 2016 ("Practical Realtime Strategies for Accurate Indirect
 * Occlusion") for the integral and the bent normal, and Intel's XeGTAO for the thin
 * occluder compensation.
 *
 * ---------------------------------------------------------------------------
 * PASS STRUCTURE  (5 draws: 4 at half res, 1 at full res)
 *
 *   1. prep      ½ res  → (view normal.xyz, linear view depth)   — one fetch per GTAO tap
 *   2. gtao      ½ res  → (visibility, bentNormal.oct.xy, linZ)
 *   3. denoise   ½ res  → 3×3 depth-bilateral, cleans the slice-rotation pattern
 *   4. temporal  ½ res  → depth-reprojected accumulation, `pass.aoTexture`
 *   5. apply     1× res → composites into the HDR chain
 *
 * The prep pass is not bookkeeping. The GTAO inner loop does ~24 dependent texture reads
 * per pixel; against a full-res FloatType depth texture those are 4× the memory traffic
 * and thrash the cache. Packing normal+linear-depth into one half-res RGBA16F first makes
 * the whole march read one texture with good locality, and it is where the sky/no-geometry
 * sentinel gets stamped so every later stage can early-out on a single compare.
 *
 * ---------------------------------------------------------------------------
 * NOT CRUSHING — the requirement that shapes every constant here
 *
 * The reference clip measures `shadow_frac 0.050` and `p01 17`: the darkest one percent of
 * pixels still sit at code value 17, and only 5% of the frame is below 25% grey. AO is the
 * single easiest way to violate that, because the naive composite — multiply the frame by
 * a visibility term — is wrong twice over:
 *
 *  a) It darkens *direct* sunlight. A crease in sunlit sand is still receiving the full
 *     6.2 units of sun irradiance; its ambient occlusion says nothing about that. Sunlit
 *     creases must not go dark, and the sun is by far the largest term in this scene.
 *  b) It ignores interreflection. Real occluded geometry bounces light between its own
 *     walls; a corner of dry sand (albedo ≈ 0.48) with V = 0.3 does *not* return 30% of
 *     the ambient, it returns nearer 45%. Multiplying by raw V is how AO reads as soot.
 *
 * (b) is fixed by Jimenez's multi-bounce fit, evaluated per channel against a per-material
 * albedo (MAT_ID → albedo table below, since the G-buffer carries no albedo). Bright sand
 * therefore keeps its warmth in the creases while dark foliage is allowed to go properly
 * dark. (a) is fixed by the indirect-fraction weighting in the apply pass.
 *
 * ---------------------------------------------------------------------------
 * HOW THE AO IS APPLIED  — read this before judging the composite
 *
 * The engine has no deferred lighting: opaque surfaces are forward-lit by three's
 * `MeshStandardMaterial` through `applyWorldMaterial`, so by the time any post pass runs,
 * direct and indirect radiance are already summed into one HDR value and cannot be
 * separated exactly. `materialCommon.js` is owned by another module and offers no AO hook.
 * So the apply pass *estimates* the indirect share per pixel and only attenuates that:
 *
 *     D = sunIntensity · lum(sunColor) · max(N·L, 0)                  (direct)
 *     I = skyFill · lum(skyColor) · (0.5 + 0.5 N·up)                  (hemisphere fill)
 *       + bounceFill · lum(bounceColor) · max(N·bounceDir, 0)         (warm sand bounce)
 *     w = aoAmbientFloor + (1 − aoAmbientFloor) · I / (I + D)
 *     colour *= mix(1, occlusion, w · aoStrength)
 *
 * D, I and the light colours are recomputed from `time` + `lighting`'s own intensity
 * formulas each frame, so the split follows the sun rather than being a baked constant.
 * Three properties of this that matter:
 *
 *  - A surface facing the sun is direct-dominated (I/(I+D) ≈ 0.15 at noon), so its creases
 *    darken by only ~15% of the AO. It cannot crush.
 *  - A surface facing away from the sun has N·L ≤ 0, so D = 0, w = 1, and it receives the
 *    *full* AO — which is correct, because sky fill is genuinely all it is getting. This
 *    is where AO does its real work: rock undersides, the lee of a sea stack, the
 *    underside of the bridge deck.
 *  - `aoAmbientFloor` (default 0.25) is the deliberate cheat. Shadowing is unknown to this
 *    pass (there is no shadow term in the G-buffer), so a pixel that is sunward-facing
 *    *but standing in the cliff's shadow* would otherwise be under-occluded. The floor
 *    gives every pixel at least 25% of the AO. It is the one knob to turn if a critic
 *    finds the AO too weak; raising it past ~0.5 starts eating `p01`.
 *
 * Specular is occluded separately with Lagarde's specular-occlusion fit driven by the
 * GTAO **bent normal**, and blended in by roughness — a near-mirror wet-sand facet is not
 * meaningfully occluded by a diffuse visibility term, and multiplying it by one is how
 * SSR-lit wet sand ends up looking dirty.
 *
 * Two pixels are deliberately excluded from all of the above:
 *  - anything the G-buffer does not cover (`gbuf1.a < 0.5`): sky, and nothing else exists
 *    for it to occlude;
 *  - anything a *transparent* surface was drawn over. The scene pass draws water, effects
 *    and the viewmodel into `sceneRT` after snapshotting `opaqueRT`, and post runs after
 *    all of it, so a wet-sand G-buffer pixel may be hidden behind the water sheet by the
 *    time this pass sees it. `|read − opaqueRT|` detects that and fades the AO out. It is
 *    a heuristic, and it is the honest cost of AO living in the post chain rather than
 *    between the opaque and transparent draws — see the note in `dispose`'s vicinity.
 *
 * ---------------------------------------------------------------------------
 * THIN GEOMETRY
 *
 * A depth buffer has no thickness. Marching past a grass blade, a vine or one of the
 * bridge's ribs, the naive horizon update `h = max(h, sampleAngle)` latches the spike
 * permanently and the blade casts an occlusion shadow as if it were a wall — vegetation
 * over sand is the worst case in this scene and it reads as grey mud. The fix (XeGTAO's
 * thin-occluder compensation) is to let the horizon *decay* toward any later, lower
 * sample instead of only ever rising:
 *
 *     horizon = (s > horizon) ? s : mix(horizon, s, aoThickness)
 *
 * A wall keeps every subsequent sample high, so its horizon holds. A rib is one high
 * sample followed by sky, so its horizon relaxes back within two steps. `aoThickness`
 * 0.35 is the default; 0 restores hard latching.
 *
 * ---------------------------------------------------------------------------
 * ctx.config knobs
 *   aoEnabled 1     aoStrength 1.0    aoRadius 2.2     aoThickness 0.35
 *   aoAmbientFloor 0.25               aoFalloffStart 0.55    aoAngleBias 0.12
 *   aoAlpha 0.10 (temporal)           aoDepthTol 0.02
 *   aoDebug 0       1 = AO, 2 = bent normal, 3 = indirect weight
 */

/* -------------------------------------------------------------- shared GLSL */

const COMMON = /* glsl */`
const float PI = 3.14159265359;
const float HALF_PI = 1.57079632679;
const float SKY_Z = 5.0e4;

/** Signed-octahedral normal packing: a unit vector in two half-floats, ~0.5° error. */
vec2 octEncode(vec3 n){
  n /= max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
  if (n.z < 0.0) {
    n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  }
  return n.xy;
}
vec3 octDecode(vec2 e){
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    v.xy = (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
  }
  return normalize(v);
}

/** Interleaved gradient noise (Jimenez). Deterministic in (pixel, frame) — never a clock. */
float ign(vec2 px, float frame){
  vec3 m = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(m.z * fract(dot(px + 5.588238 * frame, m.xy)));
}
`;

/** Reconstruct a view-space position from a pixel's uv and its linear view depth.
 *  The projection carries the TAA jitter in P[0][2]/P[1][2], so ndc.x = x/(tanX·z) − jx;
 *  inverting that is where uJitter comes back in. It is half a pixel — it changes nothing
 *  visible, but leaving it out would make the reconstruction disagree with `taa`'s. */
const VIEWPOS = /* glsl */`
uniform vec2 uTanHalf;
uniform vec2 uJitter;
vec3 viewPos(vec2 uv, float lz){
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3((ndc + uJitter) * uTanHalf * lz, -lz);
}
`;

/* ------------------------------------------------------------------ 1. prep */

const PREP_FRAG = COMMON + /* glsl */`
in vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tGbuf0;
uniform sampler2D tGbuf1;
uniform vec2  uFullTexel;
uniform vec2  uHalfRes;
uniform float uNear, uFar;
out vec4 oCol;

void main(){
  // Snap to the centre of full-res texel (2i, 2j). A half-res pixel centre lands exactly
  // on a boundary between two full-res texels, where NearestFilter's choice is
  // implementation-defined — and worse, depth, normal and mask could each resolve to a
  // *different* one of the four, which produces a normal that does not belong to the
  // depth it is paired with. Sampling one explicit texel makes the half-res buffer an
  // exact subsample and removes the ambiguity.
  vec2 suv = (floor(vUv * uHalfRes) * 2.0 + 0.5) * uFullTexel;
  vec4 g1 = texture(tGbuf1, suv);
  float d  = texture(tDepth, suv).r;
  // g1.a is 1 only where the G-buffer pre-pass actually rasterised opaque geometry.
  // Sky, and an empty scene, land here and are stamped with the sentinel depth so every
  // later stage costs one compare instead of a branch tree.
  if (g1.a < 0.5 || d >= 1.0) { oCol = vec4(0.0, 0.0, 1.0, SKY_Z); return; }
  float ndcZ = d * 2.0 - 1.0;
  float linZ = (2.0 * uNear * uFar) / max(uFar + uNear - ndcZ * (uFar - uNear), 1e-6);
  vec3 n = texture(tGbuf0, suv).xyz * 2.0 - 1.0;
  float l = length(n);
  oCol = vec4(l > 1e-4 ? n / l : vec3(0.0, 0.0, 1.0), linZ);
}
`;

/* ------------------------------------------------------------------ 2. gtao */

const GTAO_FRAG = COMMON + VIEWPOS + /* glsl */`
in vec2 vUv;
uniform sampler2D tPrep;
uniform vec2  uRes;          // half-res dimensions
uniform vec2  uTexel;
uniform float uRadius;       // world-space radius, metres
uniform float uThickness;    // thin-occluder compensation, 0..1
uniform float uFalloffStart; // fraction of uRadius at which attenuation begins
uniform float uAngleBias;    // sin of the minimum elevation above the tangent plane
uniform float uFrame;
uniform float uMaxRadiusPx;
out vec4 oCol;

void main(){
  vec4 c = texture(tPrep, vUv);
  float lz = c.a;
  if (lz >= SKY_Z) { oCol = vec4(1.0, octEncode(vec3(0.0, 0.0, 1.0)), SKY_Z); return; }

  vec3 N = c.xyz;
  vec3 P = viewPos(vUv, lz);
  vec3 V = normalize(-P);

  // Screen radius of the world-space sampling sphere. Pixels are square, so one scale
  // (from the vertical FOV) is correct on both axes.
  float radiusPx = 0.5 * uRadius / max(uTanHalf.y * lz, 1e-5) * uRes.y;
  radiusPx = clamp(radiusPx, 2.5, uMaxRadiusPx);

  vec2 px = vUv * uRes;
  float noise = ign(floor(px), uFrame);
  // Two independent low-discrepancy offsets: one rotates the slice fan, one staggers the
  // step positions. Correlating them would make the residual error a fixed moire.
  float rotN  = noise;
  float stepN = fract(noise * 1.6180339887 + 0.5);

  float falloffMul = 1.0 / max(uRadius * (1.0 - uFalloffStart), 1e-4);

  float visibility = 0.0;
  vec3  bent = vec3(0.0);

  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + rotN) * PI / float(SLICES);
    vec2 omega = vec2(cos(phi), sin(phi));
    vec3 dirV = vec3(omega, 0.0);

    // Slice plane spanned by V and dirV; sliceN is its normal, T its in-plane tangent
    // pointing along +omega.
    vec3 sliceN = cross(dirV, V);
    float slLen = length(sliceN);
    if (slLen < 1e-5) continue;
    sliceN /= slLen;
    vec3 T = cross(V, sliceN);

    vec3 projN = N - sliceN * dot(N, sliceN);
    float projLen = length(projN);
    if (projLen < 1e-4) continue;
    vec3 pn = projN / projLen;

    // Signed angle of the projected normal away from the view vector.
    float n = acos(clamp(dot(pn, V), -1.0, 1.0)) * (dot(pn, T) < 0.0 ? -1.0 : 1.0);
    float sinN = sin(n);

    // Horizon search, both ways along the slice.
    float cosH1 =  sinN;   // "no occlusion" value for the -omega side
    float cosH2 = -sinN;   // ... and for the +omega side
    for (int side = 0; side < 2; side++) {
      float sgn = (side == 0) ? 1.0 : -1.0;
      float lowH = (side == 0) ? -sinN : sinN;
      float cosH = lowH;
      for (int st = 0; st < STEPS; st++) {
        // Quadratic step distribution: dense near the centre where the horizon actually
        // changes, sparse at the rim where it rarely does. +1.0 keeps the first tap off
        // this pixel's own texel, which would self-occlude every surface.
        float t = (float(st) + stepN) / float(STEPS);
        float rp = max(t * t * radiusPx, 1.6);
        // Snap to the texel centre the fetch will actually land on. tPrep is
        // NearestFilter, so an un-snapped uv reads texel A's depth while the
        // reconstruction below believes the sample sits at position B, up to half a texel
        // away. On a tilted surface that fabricates a height difference — and at the first
        // step, where the two points are only ~1.6 px apart, half a texel of lateral error
        // is a large fraction of the separation. That is a plane occluding itself, and it
        // is invisible as a bug because it looks like plausible ambient darkening.
        vec2 sPx = floor(px + omega * (sgn * rp)) + 0.5;
        vec2 sUv = sPx * uTexel;
        if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) break;

        float slz = texture(tPrep, sUv).a;
        if (slz >= SKY_Z) continue;

        vec3 D = viewPos(sUv, slz) - P;
        float dist = length(D);
        if (dist < 1e-4) continue;
        float sCos = dot(D, V) / dist;

        // Distance attenuation, folded into the horizon rather than applied to the final
        // visibility: an occluder leaving the radius should relax the horizon smoothly,
        // not have its contribution scaled after the integral (which would break the
        // analytic solution's energy).
        float w = clamp((uRadius - dist) * falloffMul, 0.0, 1.0);

        // Angle bias. A sample lying *in* this pixel's own tangent plane is not an
        // occluder — its horizon is exactly the hemisphere limit, so in exact arithmetic
        // it contributes nothing. In practice the depth buffer is quantised and this
        // buffer is half resolution, and at grazing incidence a fraction of a millimetre
        // of depth error is several degrees of horizon error. The result is a flat plane
        // that occludes itself: measured, an unoccluded ground plane at this scene's
        // camera height read a uniform 0.84 instead of 1.0, with a black band along the
        // horizon where the grazing gets extreme. Requiring a sample to stand at least
        // ~7 degrees above the tangent plane before it counts removes it. sin(elevation
        // above the tangent plane) is just D.N/|D|.
        w *= smoothstep(0.0, uAngleBias, dot(D, N) / dist);

        sCos = mix(lowH, sCos, w);

        // Thin-occluder compensation — see the header. max() would latch a grass blade
        // into a wall.
        cosH = (sCos > cosH) ? sCos : mix(cosH, sCos, uThickness);
      }
      if (side == 0) cosH2 = cosH; else cosH1 = cosH;
    }

    float h2 =  acos(clamp(cosH2, -1.0, 1.0));
    float h1 = -acos(clamp(cosH1, -1.0, 1.0));
    h1 = n + max(h1 - n, -HALF_PI);
    h2 = n + min(h2 - n,  HALF_PI);

    // The cosine-weighted visibility integral, in closed form.
    float cosN = cos(n);
    float a = 0.25 * (-cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN)
            + 0.25 * (-cos(2.0 * h2 - n) + cosN + 2.0 * h2 * sinN);
    visibility += projLen * a;

    // Bent normal: the cosine-weighted mean unoccluded direction over the same arc,
    // also in closed form (Jimenez et al., appendix). Free given h1/h2, and it is what
    // makes specular occlusion directional instead of a scalar guess.
    float t0 = (6.0 * sin(h1 - n) - sin(3.0 * h1 - n)
              + 6.0 * sin(h2 - n) - sin(3.0 * h2 - n)
              + 16.0 * sinN - 3.0 * (sin(h1 + n) + sin(h2 + n))) / 12.0;
    float t1 = (-cos(3.0 * h1 - n) - cos(3.0 * h2 - n) + 8.0 * cosN
              - 3.0 * (cos(h1 + n) + cos(h2 + n))) / 12.0;
    bent += projLen * (T * t0 + V * t1);
  }

  // Deliberately NOT clamped to 1 here. A single slice of an unoccluded tilted surface
  // integrates to more than 1 (the |sin θ| Jacobian is a per-slice measure, not a
  // normalised one); it is the *average over all slice orientations* that converges to 1.
  // With 2 slices a pixel can read ~1.015 on one frame and 0.985 on the next, and clamping
  // before the temporal accumulation would keep the low excursions while discarding the
  // high ones — a systematic darkening of every grazing surface, which is most of a beach.
  // The clamp lives at the end of the temporal pass, after the average has been taken.
  float ao = clamp(visibility / float(SLICES), 0.0, 1.5);
  vec3 bn = (dot(bent, bent) > 1e-8) ? normalize(bent) : N;
  // The bent normal must stay in the upper hemisphere of the geometric normal; the
  // closed form can dip below it when both horizons are extreme.
  if (dot(bn, N) < 0.0) bn = N;
  oCol = vec4(ao, octEncode(bn), lz);
}
`;

/* --------------------------------------------------------------- 3. denoise */

const DENOISE_FRAG = COMMON + /* glsl */`
in vec2 vUv;
uniform sampler2D tAO;
uniform vec2 uTexel;
out vec4 oCol;

/** 3x3 depth-bilateral. The slice fan is rotated per pixel, so neighbouring pixels
 *  carry *different* directional error — averaging them is not blurring away signal,
 *  it is completing the integral. The depth weight is what keeps that from bleeding
 *  occlusion across a silhouette. */
void main(){
  vec4 c = texture(tAO, vUv);
  if (c.a >= SKY_Z) { oCol = c; return; }

  float sum = 0.0;
  vec2  bsum = vec2(0.0);
  float wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec4 s = texture(tAO, vUv + o);
      if (s.a >= SKY_Z) continue;
      // Relative depth tolerance: 2% of the centre depth, which is generous enough for
      // the beach (grazing, several percent per pixel) and tight enough for a silhouette.
      float w = exp2(-abs(s.a - c.a) / max(0.02 * c.a, 1e-3));
      w *= (x == 0 && y == 0) ? 2.0 : 1.0;
      sum  += s.r * w;
      bsum += s.gb * w;
      wsum += w;
    }
  }
  oCol = (wsum > 1e-5) ? vec4(sum / wsum, bsum / wsum, c.a) : c;
}
`;

/* -------------------------------------------------------------- 4. temporal */

const TEMPORAL_FRAG = COMMON + VIEWPOS + /* glsl */`
in vec2 vUv;
uniform sampler2D tAO;
uniform sampler2D tHist;
uniform mat4  uCamWorld;     // camera.matrixWorld
uniform mat4  uCurrVP;       // un-jittered
uniform mat4  uPrevVP;       // un-jittered
uniform mat4  uPrevView;
uniform float uAlpha;
uniform float uValid;
uniform float uDepthTol;
out vec4 oCol;

void main(){
  vec4 cur = texture(tAO, vUv);
  if (cur.a >= SKY_Z) { oCol = cur; return; }

  // Reprojection is derived from depth, not from gbuffer1.rg. That velocity is built
  // from a jittered current view-projection against an un-jittered previous one
  // (KNOWN_ISSUES #1) so it carries a half-pixel error every frame; feeding it to an
  // accumulator makes the AO random-walk and smear. Unprojecting the pixel and pushing
  // it through the two un-jittered matrices — exactly what taa.js does — gives a
  // bit-exact zero for static geometry, which is the whole scene at a capture pose.
  vec3 vp = viewPos(vUv, cur.a);
  vec3 wp = (uCamWorld * vec4(vp, 1.0)).xyz;

  vec4 cc = uCurrVP * vec4(wp, 1.0);
  vec4 pc = uPrevVP * vec4(wp, 1.0);
  float valid = uValid;
  if (cc.w <= 1e-5 || pc.w <= 1e-5) valid = 0.0;
  vec2 mv = (cc.xy / max(cc.w, 1e-5)) * 0.5 - (pc.xy / max(pc.w, 1e-5)) * 0.5;
  vec2 prevUV = vUv - mv;
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) valid = 0.0;

  vec4 h = texture(tHist, clamp(prevUV, vec2(0.0), vec2(1.0)));
  float prevLinZ = -(uPrevView * vec4(wp, 1.0)).z;
  if (h.a >= SKY_Z || abs(h.a - prevLinZ) > uDepthTol * prevLinZ + 0.02) valid = 0.0;

  float a = mix(1.0, uAlpha, valid);
  // Bent normals are averaged through the octahedral encoding. Over a 48-frame settle the
  // directions differ by well under the encoding's own error, so decode/slerp/re-encode
  // would buy nothing for three extra transcendentals per pixel.
  oCol = vec4(clamp(mix(h.r, cur.r, a), 0.0, 1.0), mix(h.gb, cur.gb, a), cur.a);
}
`;

/* ----------------------------------------------------------------- 5. apply */

const APPLY_FRAG = COMMON + /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;      // pipe.read — the HDR chain
uniform sampler2D tOpaque;   // pipe.opaqueRT — pre-transparent snapshot
uniform sampler2D tAO;       // half-res (ao, bentOct.xy, linZ)
uniform sampler2D tDepth;
uniform sampler2D tGbuf0;
uniform sampler2D tGbuf1;
uniform vec2  uAoTexel;
uniform vec2  uAoRes;
uniform vec2  uTanHalf;
uniform vec2  uJitter;
uniform float uNear, uFar;
uniform float uStrength;
uniform float uAmbientFloor;
uniform vec3  uSunDirView;
uniform vec3  uUpView;
uniform vec3  uBounceDirView;
uniform float uSunLum, uSkyLum, uBounceLum;
uniform float uDebug;
out vec4 oCol;

/** Jimenez's multi-bounce fit: how much light an occluded cavity of this albedo actually
 *  returns, versus the single-bounce visibility. Bright sand keeps its warmth; dark
 *  foliage is allowed to go dark. Without this, AO reads as soot. */
vec3 multiBounce(float v, vec3 albedo){
  vec3 a =  2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c =  2.7552 * albedo + 0.6903;
  return clamp(max(vec3(v), ((v * a + b) * v + c) * v), 0.0, 1.0);
}

/** The G-buffer carries no albedo, so it is looked up from the material id. These are
 *  plausible linear diffuse albedos for the Silent Cartographer set, not measurements —
 *  they only need to be right to within about ±0.1 for the multi-bounce fit to behave. */
vec3 albedoFor(float id){
  int i = int(id + 0.5);
  if (i == 1) return vec3(0.52, 0.46, 0.37);   // dry sand
  if (i == 2) return vec3(0.27, 0.25, 0.22);   // wet sand — darker, that is the point
  if (i == 3) return vec3(0.28, 0.27, 0.25);   // rock
  if (i == 4) return vec3(0.38, 0.39, 0.40);   // Forerunner alloy
  if (i == 5) return vec3(0.17, 0.22, 0.12);   // foliage
  if (i == 6) return vec3(0.03, 0.05, 0.07);   // water
  if (i == 7) return vec3(0.36, 0.28, 0.24);   // skin
  if (i == 8) return vec3(0.13, 0.13, 0.14);   // viewmodel
  if (i == 9) return vec3(0.25, 0.25, 0.26);   // metal
  return vec3(0.30);
}

/** Lagarde's specular-occlusion fit (Frostbite). A near-mirror facet is not occluded by
 *  a diffuse visibility term, and multiplying it by one is what makes SSR-lit wet sand
 *  read as dirty rather than wet. */
float specOcclusion(float NoV, float ao, float rough){
  return clamp(pow(max(NoV + ao, 0.0), exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;
  vec4 g1 = texture(tGbuf1, vUv);
  if (g1.a < 0.5 || uStrength <= 0.0) { oCol = vec4(src, 1.0); return; }

  vec4 g0 = texture(tGbuf0, vUv);
  vec3 N = g0.xyz * 2.0 - 1.0;
  float nl = length(N);
  N = nl > 1e-4 ? N / nl : vec3(0.0, 0.0, 1.0);
  float rough = clamp(g0.w, 0.02, 1.0);

  float ndcZ = texture(tDepth, vUv).r * 2.0 - 1.0;
  float linZ = (2.0 * uNear * uFar) / max(uFar + uNear - ndcZ * (uFar - uNear), 1e-6);

  // --- depth-bilateral upsample. A plain bilinear fetch of a half-res AO buffer leaks
  // occlusion across every silhouette in the frame — the classic dark halo around
  // foreground geometry — so the four taps are re-weighted by how well their depth
  // agrees with this full-res pixel's.
  vec2 fp = vUv * uAoRes - 0.5;
  vec2 base = floor(fp);
  vec2 f = fp - base;
  float aoSum = 0.0, wSum = 0.0;
  vec2 bSum = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i & 1), float(i >> 1));
    vec4 s = texture(tAO, (base + o + 0.5) * uAoTexel);
    float bw = ((i & 1) == 0 ? 1.0 - f.x : f.x) * ((i >> 1) == 0 ? 1.0 - f.y : f.y);
    float dw = (s.a >= SKY_Z) ? 0.0 : exp2(-abs(s.a - linZ) / max(0.03 * linZ, 1e-3));
    float w = bw * dw + 1e-5;
    aoSum += s.r * w; bSum += s.gb * w; wSum += w;
  }
  float ao = clamp(aoSum / wSum, 0.0, 1.0);
  vec3 bentN = octDecode(bSum / wSum);

  // --- how much of this pixel's radiance is indirect (see the header).
  float ndl = max(dot(N, uSunDirView), 0.0);
  float direct   = uSunLum * ndl;
  float indirect = uSkyLum * (0.5 + 0.5 * dot(N, uUpView))
                 + uBounceLum * max(dot(N, uBounceDirView), 0.0);
  float fi = indirect / max(indirect + direct, 1e-4);
  float w = clamp(uAmbientFloor + (1.0 - uAmbientFloor) * fi, 0.0, 1.0) * uStrength;

  // --- diffuse vs specular occlusion, blended by roughness.
  vec3 diffOcc = multiBounce(ao, albedoFor(g1.b * 255.0));
  // View vector in view space. P = ((ndc + jitter)·tanHalf·z, −z), so the direction back
  // to the camera is normalize(−P), whose depth factor cancels.
  vec3 V = normalize(vec3(-(vUv * 2.0 - 1.0 + uJitter) * uTanHalf, 1.0));
  float NoV = clamp(dot(bentN, V), 0.0, 1.0);
  float so = specOcclusion(NoV, ao, rough);
  vec3 occ = mix(vec3(so), diffOcc, clamp(rough * 1.6, 0.0, 1.0));

  // --- do not occlude a pixel that a transparent surface was drawn over. The post chain
  // runs after water, particles and the viewmodel, but the G-buffer only ever saw the
  // opaque layer; opaqueRT is the snapshot taken between the two, so the difference is
  // exactly "something translucent happened here".
  vec3 opq = texture(tOpaque, vUv).rgb;
  float d = length(src - opq) / (length(src) + length(opq) + 1e-3);
  float cover = 1.0 - smoothstep(0.12, 0.45, d);

  vec3 mul = mix(vec3(1.0), occ, w * cover);

  if (uDebug > 4.5)      { oCol = vec4(vec3(fract(linZ * 0.05)), 1.0); return; }
  else if (uDebug > 3.5) { oCol = vec4(N * 0.5 + 0.5, 1.0); return; }
  else if (uDebug > 2.5) { oCol = vec4(vec3(w * cover), 1.0); return; }
  else if (uDebug > 1.5) { oCol = vec4(bentN * 0.5 + 0.5, 1.0); return; }
  else if (uDebug > 0.5) { oCol = vec4(vec3(ao), 1.0); return; }

  oCol = vec4(src * mul, 1.0);
}
`;

/* ------------------------------------------------------------------ module */

export function create(opts = {}) {
  const p = new Pass('ssao');
  p.needsSwap = false;

  const cfg = Object.assign({
    slices: 2,
    steps: 6,
    radius: 2.2,
    strength: 1.0,
    thickness: 0.35,
    falloffStart: 0.55,
    angleBias: 0.12,
    ambientFloor: 0.25,
    alpha: 0.10,
    depthTol: 0.02,
    maxRadiusPx: 84,
  }, opts.ssao || {});

  let prepRT = null, gtaoRT = null, blurRT = null, histA = null, histB = null;
  let prepMat = null, gtaoMat = null, blurMat = null, tempMat = null, applyMat = null;
  let quad = null;
  let W = 0, H = 0, hw = 0, hh = 0;
  let frames = 0, lastPipeFrame = -99;
  let geomProbe = 0, geomFrame = -999;

  const prevView = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  const _bounce = new THREE.Vector3();

  /** A 1×1 white texture so `pass.aoTexture` is never null for a consumer that reads it
   *  before the first frame, or while this pass is disabled. */
  const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  WHITE.needsUpdate = true;

  p.aoTexture = WHITE;
  p.bentNormalTexture = WHITE;
  /** Channel layout of `aoTexture`, published so a consumer does not have to read this
   *  file: `.r` visibility 0..1, `.gb` octahedral view-space bent normal, `.a` linear
   *  view depth (or ≥ 5e4 for sky / no geometry). Half resolution. */
  p.aoLayout = { ao: 'r', bentNormalOct: 'gb', linearDepth: 'a', scale: 0.5 };

  const halfRT = (w, h, nearest) => makeRT(w, h, nearest ? {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  } : {});

  /** Is there any opaque geometry at all? While terrain/rocks/structures are stubs the
   *  G-buffer is empty and every stage below would be a no-op anyway — but a no-op that
   *  still costs five full-screen draws. Probed rarely (the answer changes once, at
   *  load) and deterministically off the frame index. */
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
    const D = { SLICES: cfg.slices, STEPS: cfg.steps };

    prepMat = fsMaterial(PREP_FRAG, {
      tDepth: { value: null }, tGbuf0: { value: null }, tGbuf1: { value: null },
      uFullTexel: { value: new THREE.Vector2() }, uHalfRes: { value: new THREE.Vector2() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
    });

    gtaoMat = fsMaterial(GTAO_FRAG, {
      tPrep: { value: null },
      uRes: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() },
      uTanHalf: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() },
      uRadius: { value: cfg.radius }, uThickness: { value: cfg.thickness },
      uFalloffStart: { value: cfg.falloffStart }, uFrame: { value: 0 },
      uAngleBias: { value: cfg.angleBias }, uMaxRadiusPx: { value: cfg.maxRadiusPx },
    }, D);

    blurMat = fsMaterial(DENOISE_FRAG, {
      tAO: { value: null }, uTexel: { value: new THREE.Vector2() },
    });

    tempMat = fsMaterial(TEMPORAL_FRAG, {
      tAO: { value: null }, tHist: { value: null },
      uTanHalf: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCurrVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
      uPrevView: { value: new THREE.Matrix4() },
      uAlpha: { value: cfg.alpha }, uValid: { value: 0 }, uDepthTol: { value: cfg.depthTol },
    });

    applyMat = fsMaterial(APPLY_FRAG, {
      tSrc: { value: null }, tOpaque: { value: null }, tAO: { value: null },
      tDepth: { value: null }, tGbuf0: { value: null }, tGbuf1: { value: null },
      uAoTexel: { value: new THREE.Vector2() }, uAoRes: { value: new THREE.Vector2() },
      uTanHalf: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() },
      uNear: { value: 0.06 }, uFar: { value: 12000 },
      uStrength: { value: cfg.strength }, uAmbientFloor: { value: cfg.ambientFloor },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uBounceDirView: { value: new THREE.Vector3(0, -1, 0) },
      uSunLum: { value: 6.2 }, uSkyLum: { value: 1.2 }, uBounceLum: { value: 0.28 },
      uDebug: { value: 0 },
    });

    for (const m of [prepMat, gtaoMat, blurMat, tempMat, applyMat]) m.blending = THREE.NoBlending;
    quad = new FullScreenQuad(prepMat);

    ctx.on?.('camera:teleport', () => { frames = 0; });
    ctx.on?.('engine:resize', () => { frames = 0; });

    p.setSize(pipe.w > 2 ? pipe.w : ctx.size.w, pipe.h > 2 ? pipe.h : ctx.size.h, ctx);
  };

  p.setSize = (w, h) => {
    if (!prepMat || (w === W && h === H && prepRT)) return;
    W = w; H = h;
    hw = Math.max(2, Math.ceil(w / 2));
    hh = Math.max(2, Math.ceil(h / 2));
    frames = 0;
    for (const rt of [prepRT, gtaoRT, blurRT, histA, histB]) rt?.dispose();
    prepRT = halfRT(hw, hh, true);
    gtaoRT = halfRT(hw, hh, true);
    blurRT = halfRT(hw, hh, true);
    histA = halfRT(hw, hh, false);
    histB = halfRT(hw, hh, false);
    p.aoTexture = histA.texture;
    p.bentNormalTexture = histA.texture;
  };

  p.render = (ctx, pipe) => {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const c = ctx.config || {};
    if (!prepRT) p.setSize(pipe.w, pipe.h, ctx);
    if (hw !== Math.max(2, Math.ceil(pipe.w / 2))) p.setSize(pipe.w, pipe.h, ctx);

    if ((c.aoEnabled ?? 1) === 0) return;

    // Nothing opaque in the scene: leave `aoTexture` white and the chain untouched.
    // Costs one cached traversal every 30 frames instead of five full-screen draws.
    if (!hasOpaqueGeometry(ctx, pipe.frameIndex)) {
      p.aoTexture = WHITE; p.bentNormalTexture = WHITE; frames = 0;
      return;
    }

    if (pipe.frameIndex !== lastPipeFrame + 1) frames = 0;
    lastPipeFrame = pipe.frameIndex;

    const pe = pipe.unjitteredProj.elements;
    const tanX = 1 / Math.max(Math.abs(pe[0]), 1e-6);
    const tanY = 1 / Math.max(Math.abs(pe[5]), 1e-6);

    /* ---------------------------------------------------------------- 1. prep */
    {
      const u = prepMat.uniforms;
      u.tDepth.value = pipe.depthTex;
      u.tGbuf0.value = pipe.gbuffer.textures[0];
      u.tGbuf1.value = pipe.gbuffer.textures[1];
      u.uFullTexel.value.set(1 / pipe.w, 1 / pipe.h);
      u.uHalfRes.value.set(hw, hh);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      quad.material = prepMat;
      r.setRenderTarget(prepRT);
      quad.render(r);
    }

    /* ---------------------------------------------------------------- 2. gtao */
    {
      const u = gtaoMat.uniforms;
      u.tPrep.value = prepRT.texture;
      u.uRes.value.set(hw, hh);
      u.uTexel.value.set(1 / hw, 1 / hh);
      u.uTanHalf.value.set(tanX, tanY);
      u.uJitter.value.copy(pipe.jitter);
      u.uRadius.value = Math.max(0.05, c.aoRadius ?? cfg.radius);
      u.uThickness.value = THREE.MathUtils.clamp(c.aoThickness ?? cfg.thickness, 0, 1);
      u.uFalloffStart.value = THREE.MathUtils.clamp(c.aoFalloffStart ?? cfg.falloffStart, 0, 0.95);
      u.uAngleBias.value = THREE.MathUtils.clamp(c.aoAngleBias ?? cfg.angleBias, 0.0, 0.9);
      u.uMaxRadiusPx.value = cfg.maxRadiusPx;
      // Animated from the pipeline's own frame counter, never a clock — two runs of the
      // same capture must produce the same slice rotations on every frame.
      u.uFrame.value = pipe.frameIndex % 64;
      quad.material = gtaoMat;
      r.setRenderTarget(gtaoRT);
      quad.render(r);
    }

    /* ------------------------------------------------------------- 3. denoise */
    {
      const u = blurMat.uniforms;
      u.tAO.value = gtaoRT.texture;
      u.uTexel.value.set(1 / hw, 1 / hh);
      quad.material = blurMat;
      r.setRenderTarget(blurRT);
      quad.render(r);
    }

    /* ------------------------------------------------------------ 4. temporal */
    {
      const u = tempMat.uniforms;
      u.tAO.value = blurRT.texture;
      u.tHist.value = histA.texture;
      u.uTanHalf.value.set(tanX, tanY);
      u.uJitter.value.copy(pipe.jitter);
      u.uCamWorld.value.copy(cam.matrixWorld);
      u.uCurrVP.value.copy(pipe.currViewProj);
      u.uPrevVP.value.copy(pipe.prevViewProj);
      u.uPrevView.value.copy(prevView);
      u.uAlpha.value = THREE.MathUtils.clamp(c.aoAlpha ?? cfg.alpha, 0.02, 1.0);
      u.uDepthTol.value = c.aoDepthTol ?? cfg.depthTol;
      u.uValid.value = frames > 0 ? 1 : 0;
      quad.material = tempMat;
      r.setRenderTarget(histB);
      quad.render(r);
      const t = histA; histA = histB; histB = t;
      p.aoTexture = histA.texture;
      p.bentNormalTexture = histA.texture;
    }

    /* --------------------------------------------------------------- 5. apply */
    {
      const u = applyMat.uniforms;
      u.tSrc.value = pipe.read.texture;
      u.tOpaque.value = pipe.opaqueRT.texture;
      u.tAO.value = histA.texture;
      u.tDepth.value = pipe.depthTex;
      u.tGbuf0.value = pipe.gbuffer.textures[0];
      u.tGbuf1.value = pipe.gbuffer.textures[1];
      u.uAoTexel.value.set(1 / hw, 1 / hh);
      u.uAoRes.value.set(hw, hh);
      u.uTanHalf.value.set(tanX, tanY);
      u.uJitter.value.copy(pipe.jitter);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      u.uStrength.value = Math.max(0, c.aoStrength ?? cfg.strength);
      u.uAmbientFloor.value = THREE.MathUtils.clamp(c.aoAmbientFloor ?? cfg.ambientFloor, 0, 1);
      u.uDebug.value = c.aoDebug ?? 0;

      // The direct/indirect split follows `lighting`'s own intensity formulas so the AO
      // weighting tracks the sun instead of a baked constant. Guarded: with `?only=` the
      // time module may not exist, and the defaults are then simply the noon values.
      const time = ctx.get?.('time');
      const lum = (col) => 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
      if (time) {
        const alt = Math.max(0.02, time.sunDir.y);
        u.uSunLum.value = time.state.sunIntensity * (c.sunScale ?? 1) * lum(time.sunColor);
        u.uSkyLum.value = 1.35 * Math.pow(alt, 0.35) * (c.skyFill ?? 1) * lum(time.skyColor);
        u.uBounceLum.value = 0.42 * alt * (c.bounceFill ?? 1) * 0.86;
        _v.copy(time.sunDir).transformDirection(cam.matrixWorldInverse);
        u.uSunDirView.value.copy(_v);
      }
      _v.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
      u.uUpView.value.copy(_v);
      // `lighting`'s bounce light sits at (0,-1,0.25) looking at the origin, so its
      // incident direction is that position normalised.
      _bounce.set(0, -1, 0.25).normalize().transformDirection(cam.matrixWorldInverse);
      u.uBounceDirView.value.copy(_bounce);

      quad.material = applyMat;
      r.setRenderTarget(pipe.write);
      quad.render(r);
    }

    // needsSwap is false, so the pipeline will not rotate the chain for us — but the
    // composite above *is* a chain write, so rotate it here. This is exactly what a
    // needsSwap = true pass would have done; declaring false keeps `writesBackbuffer`
    // off this pass (it never writes the 8-bit backbuffer) and keeps `aoTexture`
    // available to anyone who wants to do their own thing with it.
    pipe.swap();

    prevView.copy(cam.matrixWorldInverse);
    frames++;
  };

  p.dispose = () => {
    for (const rt of [prepRT, gtaoRT, blurRT, histA, histB]) rt?.dispose();
    for (const m of [prepMat, gtaoMat, blurMat, tempMat, applyMat]) m?.dispose();
    WHITE.dispose();
    quad?.dispose();
  };

  return p;
}
