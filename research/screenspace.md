# Screen-space AO and reflections for a sunlit beach (WebGL2 / three.js r0.185.1)

Key: `screenspace`. Audience: someone writing the shader today.
Everything below assumes a G-buffer with **view-space normal**, **perceptual roughness**, and
**linear view depth** (positive metres in front of the camera, or view-space `z` — I write
`lz > 0` for "linear distance along the view axis in metres").

Primary sources are quoted where the exact text matters. Where I could not verify something
I say so explicitly in **§9 Gaps**.

---

## 0. Executive recommendation for this scene

A beach at metre scale, hard sun, sky-dominated ambient, materials = rock / sand / vegetation /
water / wet sand.

| Decision | Recommendation | Why |
|---|---|---|
| AO algorithm | **GTAO** (slice + analytic arc integral), 2–3 slices × 3–4 steps, half res | The arc integral is exact for a height-field; classic hemisphere SSAO has no correct answer to converge to and will read as dirt. |
| AO world radius | **1.0–1.5 m** for the ambient term, plus optionally a **0.25 m** "contact" pass | Sized to the geometry you actually want darkened: rock/sand contacts, grass tuft bases, gaps under rocks. See §2.5. |
| Thickness | XeGTAO `ThinOccluderCompensation` **0.15–0.30** (vegetation-heavy), or the visibility-bitmask formulation with `t ≈ 0.05–0.15 m` | Grass and leaves are one depth sample thick and otherwise cast wall-shaped shadows. |
| Where AO multiplies | **Indirect diffuse only**, plus a separate *specular* occlusion on indirect specular. **Never** the sun term. | §2.7. Getting this wrong is the single most recognisable "bad AO" look. |
| Bent normals | **Yes, but only to drive specular occlusion** (`SpecularAO_Cones`) and, if you have an SH sky, to shift the irradiance lookup. Skip for diffuse if your ambient is a near-uniform sky dome. | §3. They're nearly free once you have h0/h1. |
| Denoise | 4×4 spatial reuse of rotated slices + edge-aware 3×3/Poisson blur + temporal reprojection with a *separate* history from TAA's | §4. |
| SSR trace | **Perspective-correct screen-space DDA** (McGuire/Mara) with dither + bisection. Hi-Z is *not* obviously a win at grazing beach angles. | §5.2. |
| SSR fallback | Sky cubemap sampled in the **same world direction**, blended by a confidence value. Never fade to black. | §5.7, §6. |
| Water | Water needs its own reflection path (it usually isn't in the opaque G-buffer). SSR beats the cubemap only where the reflected ray hits *geometry* — sea stacks, cliffs, the shoreline. For open sea looking at the horizon, sky cubemap wins and is free. | §6. |

---

## 1. Notation and WebGL2/three.js preliminaries

Three injects `#version 300 es` for a `RawShaderMaterial`/`ShaderMaterial` when
`glslVersion: THREE.GLSL3`. Practical constraints:

* **No compute.** All the Hi-Z / mip-pyramid / prefix work must be fullscreen fragment passes.
* **`textureGather` exists** in GLSL ES 3.00 — useful for the bilateral upsample (§4.4).
* **Float render targets** need `EXT_color_buffer_float`. R16F is enough for AO;
  RGBA16F for AO+bent normal, or pack into RGBA8 as XeGTAO does (bent normal `*0.5+0.5`
  in RGB, visibility in A).
* **Depth**: three r185's `GTAOShader` reconstructs view position from the depth texture with
  `cameraProjectionMatrixInverse`, and supports reversed depth via `USE_REVERSED_DEPTH_BUFFER`:
  ```glsl
  vec3 getViewPosition( const in vec2 screenPosition, const in float depth ) {
      #ifdef USE_REVERSED_DEPTH_BUFFER
          vec4 clipSpacePosition = vec4( vec2( screenPosition ) * 2.0 - 1.0, depth, 1.0 );
      #else
          vec4 clipSpacePosition = vec4( vec3( screenPosition, depth ) * 2.0 - 1.0, 1.0 );
      #endif
      vec4 viewSpacePosition = cameraProjectionMatrixInverse * clipSpacePosition;
      return viewSpacePosition.xyz / viewSpacePosition.w;
  }
  ```
  (`node_modules/three/examples/jsm/shaders/GTAOShader.js`, lines 94–102 in this checkout;
  upstream: <https://github.com/mrdoob/three.js/blob/dev/examples/jsm/shaders/GTAOShader.js>)

  If you already store **linear** depth in the G-buffer, prefer reconstructing directly:
  ```glsl
  // uTanHalf = vec2(tan(fovY/2)*aspect, tan(fovY/2))
  vec3 viewPos(vec2 uv, float lz) {
      vec2 ndc = uv * 2.0 - 1.0;
      return vec3(ndc * uTanHalf * lz, -lz);   // right-handed, camera looks down -z
  }
  ```
  This is cheaper and avoids depth-precision blowups at the far plane.
* **Nearest sampling matters.** If your AO input texture is `NearestFilter`, snap sample UVs to
  texel centres (`floor(px) + 0.5`). An unsnapped fetch reads texel A's depth while your
  reconstruction believes the sample sits at position B — up to half a texel of *lateral*
  error, which on a tilted plane fabricates a height difference. At the first step (~1.6 px
  separation) that is a large fraction of the baseline, and it looks exactly like plausible
  ambient darkening rather than like a bug.

---

## 2. Ambient occlusion

### 2.1 The quantity you are computing

The cosine-weighted visibility integral (Filament's statement of it, matching McGuire 2010):

```
AO = 1 − (1/π) ∫_Ω V(l) ⟨n·l⟩ dl
```
— <https://google.github.io/filament/Filament.md.html> ("Diffuse occlusion", eq. `diffuseAOTerm`)

and the separable approximation that justifies multiplying it into a pre-integrated irradiance:

```
L(l,v) ≈ ( π ∫_Ω f(l,v) L_a(l) dl ) · ( (1/π) ∫_Ω V(l) ⟨n·l⟩ dl )
```
Filament notes this is **exact only when `L_a` is constant and `f` is Lambertian**, and
"reasonable if both functions are relatively smooth over most of the sphere" — which is a good
description of a clear-sky beach with a strong sun, *provided you have removed the sun from
`L_a`*. See §2.7.

The GTAO paper writes the same thing (eq. 2), with `V` a **binary** function returning 0 if
there is an occluder closer than radius `r`:

> "Ambient occlusion [ZIK98] approximates Equation (1), by introducing a set of assumptions:
> i) all light comes from an infinite uniform environment light … ii) all surfaces around x are
> purely absorbing … iii) the surface at x is diffuse."
> — Jimenez, Wu, Pesce, Jarabo, *Practical Realtime Strategies for Accurate Indirect Occlusion*,
> ATVI-TR-16-01, §2. <https://iryoku.com/downloads/Practical-Realtime-Strategies-for-Accurate-Indirect-Occlusion.pdf>

### 2.2 Classic hemisphere SSAO vs horizon methods vs GTAO

**Classic SSAO (Crytek / Mittring 2007, and the normal-oriented hemisphere variants).**
Sample N points in a sphere/hemisphere of world radius R around P, project each to screen,
compare its depth to the depth buffer, count how many are "behind" geometry, divide by N.

Why it looks wrong on a beach:
* It estimates *occupancy fraction of a volume*, not the cosine-weighted solid angle. There is
  no ground truth it converges to; every parameter is a taste knob.
* Variance is O(1/√N) with a bad constant. At the 8–16 samples you can afford at 1080p it is
  pure noise, and the blur you need to hide the noise is wide enough to smear AO across
  silhouettes.
* Depth comparison is binary and has no notion of the occluder's angular extent, so a distant
  large object and a nearby small one contribute identically.
* Visually: it reads as **grey wash in concavities**, uniform in value regardless of how deep
  the concavity is, with a soft dark rim around every silhouette. That rim is what people mean
  by "AO that looks like dirt".

**HBAO (Bavoil, Sainz, Dimitrov 2008).** March along `Nd` screen-space directions, track the
maximum horizon elevation, and use `sin(h) − sin(t)` per direction. Much lower variance
because a horizon search reuses all its taps. But the per-slice integral is a heuristic and
needs an ad-hoc attenuation function to not over-darken.

**GTAO (Jimenez et al. 2016).** Same horizon search, but:
1. Horizons are measured **relative to the view vector `ω_o`**, not the tangent plane
   (following Timonen 2013). This kills transcendentals and makes the domain uniform.
2. `V` is **binary** (no obscurance attenuation), which makes the inner integral solvable
   in closed form.

That gives the paper's eq. (5):

```
Â(x) = (1/π) ∫₀^π  [ ∫_{θ1(φ)}^{θ2(φ)}  cos(θ − γ)₊ · |sin θ| dθ ] dφ
                     └──────────────── â ────────────────┘
```

with `γ` the angle between the normal `n_x` and the view vector `ω_o`.

### 2.3 The GTAO arc integral — the equation to type

Paper eq. (7), verbatim:

```
â = ¼ ( −cos(2θ₁ − γ) + cos γ + 2θ₁ sin γ )
  + ¼ ( −cos(2θ₂ − γ) + cos γ + 2θ₂ sin γ )
```

Because the normal `n_x` does not generally lie in the slice plane `P` spanned by the screen
direction `t̂(φ)` and `ω_o`, you compute `γ` from the **projected** normal and then rescale by
its length. Paper eq. (8):

```
Â(x) = (1/π) ∫₀^π  ‖n_x‖ · â(φ) dφ            (‖n_x‖ = length of n projected into P)
```

Cross-check, Intel's XeGTAO (MIT), which is a direct implementation. Verbatim from
`XeGTAO.hlsli` lines ~536–545
(<https://github.com/GameTechDev/XeGTAO/blob/master/Source/Rendering/Shaders/XeGTAO.hlsli>):

```hlsl
lpfloat h0 = -XeGTAO_FastACos((lpfloat)horizonCos1);
lpfloat h1 =  XeGTAO_FastACos((lpfloat)horizonCos0);
lpfloat iarc0 = (cosNorm + 2*h0*sin(n) - cos(2*h0 - n)) / 4;
lpfloat iarc1 = (cosNorm + 2*h1*sin(n) - cos(2*h1 - n)) / 4;
lpfloat localVisibility = projectedNormalVecLength * (iarc0 + iarc1);
visibility += localVisibility;
```

with (same file, lines ~396–410) the slice frame:

```hlsl
const lpfloat3 directionVec      = lpfloat3(cosPhi, sinPhi, 0);
const lpfloat3 orthoDirectionVec = directionVec - (dot(directionVec, viewVec) * viewVec);
const lpfloat3 axisVec           = normalize( cross(orthoDirectionVec, viewVec) );
lpfloat3 projectedNormalVec      = viewspaceNormal - axisVec * dot(viewspaceNormal, axisVec);
lpfloat  signNorm                = sign( dot( orthoDirectionVec, projectedNormalVec ) );
lpfloat  projectedNormalVecLength= length(projectedNormalVec);
lpfloat  cosNorm                 = saturate(dot(projectedNormalVec, viewVec) / projectedNormalVecLength);
lpfloat  n                       = signNorm * XeGTAO_FastACos(cosNorm);
const lpfloat lowHorizonCos0     = cos(n + XE_GTAO_PI_HALF);   // = -sin(n)
const lpfloat lowHorizonCos1     = cos(n - XE_GTAO_PI_HALF);   // = +sin(n)
```

Note `cosNorm == cos γ` and `n == γ` (signed). The two "low horizon" values are the
**unoccluded** initial horizons — the tangent-plane limits. **This is where flat ground
self-occlusion comes from**: if you initialise the horizons to ±π/2 instead of `n ∓ π/2`, an
unoccluded plane integrates to less than 1 and every flat surface reads grey.

XeGTAO also offers an optional clamp (disabled by default "for a tiny little bit more
performance"):
```hlsl
h0 = n + clamp( h0 - n, -PI_HALF, PI_HALF );
h1 = n + clamp( h1 - n, -PI_HALF, PI_HALF );
```

Final normalisation (XeGTAO lines ~556–558):
```hlsl
visibility /= sliceCount;
visibility  = pow( visibility, FinalValuePower );   // default 2.2
visibility  = max( 0.03, visibility );              // disallow total occlusion
```

**Do not clamp per-slice visibility to 1 before averaging.** A single slice of an unoccluded
*tilted* surface legitimately integrates above 1; only the average over slice orientations
converges to 1. Clamping early keeps the low excursions and discards the high ones, which is a
systematic darkening of every grazing surface — i.e. of most of a beach. Clamp after the
temporal average.

Fast transcendentals (XeGTAO lines 171–183, from Drobot 2014 / Lagarde):
```hlsl
lpfloat XeGTAO_FastSqrt( float x ) { return asfloat( 0x1fbd1df5 + ( asint(x) >> 1 ) ); }
lpfloat XeGTAO_FastACos( lpfloat inX ) {          // input [-1,1] → output [0, PI]
    const lpfloat PI = 3.141593, HALF_PI = 1.570796;
    lpfloat x = abs(inX);
    lpfloat res = -0.156583 * x + HALF_PI;
    res *= XeGTAO_FastSqrt(1.0 - x);
    return (inX >= 0) ? res : PI - res;
}
```
`FastSqrt`'s bit hack has no direct GLSL ES 3.00 equivalent without `floatBitsToInt`/
`intBitsToFloat` — those *do* exist in GLSL ES 3.00, so it ports. `FastACos` is worth it:
you call it 2×slices + 1 times per pixel.

### 2.4 Reference GLSL3 sketch (half-res GTAO, beach-tuned)

```glsl
// ---- inputs: tPrep.rgb = view normal, tPrep.a = linear view depth (metres)
const int SLICES = 3;   // 2 if you have a solid temporal accumulator
const int STEPS  = 4;

uniform vec2  uRes, uTexel;      // HALF-res dims + 1/dims
uniform float uRadius;           // metres, world space
uniform float uFalloffRange;     // 0.615 (XeGTAO default) — fraction of radius over which we fade
uniform float uThinOccluder;     // 0..0.7, 0.15-0.3 for vegetation
uniform float uFrame;

void main() {
  vec4 c = texture(tPrep, vUv);
  float lz = c.a;
  if (lz >= SKY_Z) { fragColor = vec4(1.0); return; }

  vec3 N = c.xyz;
  vec3 P = viewPos(vUv, lz);
  vec3 V = normalize(-P);

  // screen radius of the world-space sphere. Pixels are square → one scale for both axes.
  float radiusPx = 0.5 * uRadius / max(uTanHalf.y * lz, 1e-5) * uRes.y;
  radiusPx = clamp(radiusPx, 2.5, uMaxRadiusPx);   // uMaxRadiusPx ~ 96 at half res

  // XeGTAO falloff: linear ramp from falloffFrom .. effectRadius
  float falloffRange = uFalloffRange * uRadius;
  float falloffFrom  = uRadius * (1.0 - uFalloffRange);
  float falloffMul   = -1.0 / falloffRange;
  float falloffAdd   = falloffFrom / falloffRange + 1.0;

  // R2 low-discrepancy noise, decorrelated rotation vs step offset
  vec2  px    = vUv * uRes;
  float noise = r2Noise(px, uFrame);
  float rotN  = noise;
  float stepN = fract(noise * 1.6180339887 + 0.5);

  float visibility = 0.0;
  vec3  bent = vec3(0.0);

  for (int s = 0; s < SLICES; ++s) {
    float phi = (float(s) + rotN) * PI / float(SLICES);
    vec2  omega = vec2(cos(phi), sin(phi));
    vec3  dirV  = vec3(omega, 0.0);

    vec3 sliceN = cross(dirV, V);
    float slLen = length(sliceN);
    if (slLen < 1e-5) continue;
    sliceN /= slLen;
    vec3 T = cross(V, sliceN);                    // in-plane tangent, along +omega

    vec3  projN   = N - sliceN * dot(N, sliceN);
    float projLen = length(projN);
    if (projLen < 1e-4) continue;
    vec3  pn = projN / projLen;

    float cosN = clamp(dot(pn, V), -1.0, 1.0);
    float n    = acos(cosN) * (dot(pn, T) < 0.0 ? -1.0 : 1.0);   // = gamma, signed
    float sinN = sin(n);

    // "no occluder" horizons = the tangent-plane limits
    float cosH0 = -sinN;   // side  +omega  (cos(n + pi/2))
    float cosH1 =  sinN;   // side  -omega  (cos(n - pi/2))

    for (int st = 0; st < STEPS; ++st) {
      // SampleDistributionPower = 2.0 → dense near the centre where the horizon moves
      float t  = (float(st) + stepN) / float(STEPS);
      float rp = max(t * t * radiusPx, 1.3);      // pixelTooCloseThreshold = 1.3

      for (int side = 0; side < 2; ++side) {
        float sgn = (side == 0) ? 1.0 : -1.0;
        vec2  sPx = floor(px + omega * (sgn * rp)) + 0.5;   // snap to texel centre!
        vec2  sUv = sPx * uTexel;
        if (any(lessThan(sUv, vec2(0.0))) || any(greaterThan(sUv, vec2(1.0)))) continue;

        float slz = texture(tPrep, sUv).a;
        if (slz >= SKY_Z) continue;

        vec3  D    = viewPos(sUv, slz) - P;
        float dist = length(D);
        if (dist < 1e-4) continue;

        // thin-occluder compensation stretches the *depth* axis before the falloff test,
        // so a sample that is thin in z leaves the radius sooner
        float fb = length(vec3(D.x, D.y, D.z * (1.0 + uThinOccluder)));
        float w  = clamp(fb * falloffMul + falloffAdd, 0.0, 1.0);

        float shc = dot(D, V) / dist;
        float lowH = (side == 0) ? -sinN : sinN;
        shc = mix(lowH, shc, w);                  // relax the horizon, don't scale the integral

        if (side == 0) cosH0 = mix(max(cosH0, shc), shc, uThinOccluder);
        else           cosH1 = mix(max(cosH1, shc), shc, uThinOccluder);
      }
    }

    float h0 = -acos(clamp(cosH1, -1.0, 1.0));
    float h1 =  acos(clamp(cosH0, -1.0, 1.0));
    h0 = n + max(h0 - n, -HALF_PI);
    h1 = n + min(h1 - n,  HALF_PI);

    float iarc0 = (cosN + 2.0*h0*sinN - cos(2.0*h0 - n)) * 0.25;
    float iarc1 = (cosN + 2.0*h1*sinN - cos(2.0*h1 - n)) * 0.25;
    visibility += projLen * (iarc0 + iarc1);

    // bent normal, closed form over the same arc (see §3)
    float t0 = (6.0*sin(h0-n) - sin(3.0*h0-n) + 6.0*sin(h1-n) - sin(3.0*h1-n)
              + 16.0*sinN - 3.0*(sin(h0+n) + sin(h1+n))) / 12.0;
    float t1 = (-cos(3.0*h0-n) - cos(3.0*h1-n) + 8.0*cosN
              - 3.0*(cos(h0+n) + cos(h1+n))) / 12.0;
    bent += projLen * (T * t0 + V * t1);
  }

  float ao = visibility / float(SLICES);          // NOT clamped to 1 here
  vec3  bn = (dot(bent,bent) > 1e-8) ? normalize(bent) : N;
  if (dot(bn, N) < 0.0) bn = N;                   // keep it in the upper hemisphere
  fragColor = vec4(ao, octEncode(bn), lz);
}
```

R2 noise, XeGTAO's choice (Hilbert index driving the R2 sequence,
<https://github.com/GameTechDev/XeGTAO/blob/master/Source/Rendering/Shaders/vaGTAO.hlsl> lines 74–86;
the R2 constants are from Roberts, <http://extremelearning.com.au/unreasonable-effectiveness-of-quasirandom-sequences/>):

```glsl
// index = hilbert(px) + 288 * (frame % 64)
vec2 r2 = fract(0.5 + float(index) * vec2(0.75487766624669276005, 0.5698402909980532659114));
```
XeGTAO's comment on the 288: *"why 288? tried out a few and that's the best so far"* — it is
empirical, not derived. An interleaved-gradient noise plus a golden-ratio temporal offset works
about as well and is one line.

### 2.5 Parameters, with units and physical meaning

| Param | Meaning | XeGTAO default | Beach recommendation |
|---|---|---|---|
| `EffectRadius` | **metres**. World radius of the occlusion sphere. Occluders beyond it are ignored. | `0.5 m` | **1.0–1.5 m** main pass. Optionally a second 0.2–0.3 m pass composited with `min()`. |
| `RadiusMultiplier` | unitless. Multiplies the radius "to counter inherent screen space biases", tuned against a ray-traced reference. Clamp [0.3, 3.0]. | `1.457` | Keep 1.457. Your effective radius is therefore `Radius × 1.457`. |
| `EffectFalloffRange` | unitless fraction of the radius over which occluders fade out. `falloffFrom = R(1−range)`. | `0.615` | 0.6–0.7. Higher = smoother, less "ring at the radius edge". |
| `SampleDistributionPower` | `s = pow(uniform, p)` — sample density bias toward the pixel. Clamp [1,3]. | `2.0` | 2.0. Crevices matter more than big surfaces. |
| `ThinOccluderCompensation` | unitless. Multiplies the depth component of the sample delta by `(1+c)` before the falloff test. Clamp [0, 0.7]. | `0.0` | **0.15–0.30**. Beach grass and rock lips are one-sample thick. |
| `FinalValuePower` | `ao = pow(ao, p)`. Contrast knob, applied *after* the integral. Clamp [0.5, 5]. | `2.2` | 1.4–1.8 for outdoor. 2.2 was tuned on interiors and crushes outdoor AO into soot. |
| `DepthMIPSamplingOffset` | `mip = clamp(log2(offsetLen) − offset, 0, 5)`. Lower = more cache-friendly, more thin-object over-shadowing + temporal instability. Clamp [0,30]. | `3.30` | 3.3, if you build a depth pyramid at all. At half res with a 1.5 m radius the taps are close enough that a pyramid is often not worth it in WebGL2 (no compute, so each mip is a fullscreen pass). |
| `slices × steps` | | Low 1×2, Medium 2×2, High 3×3, Ultra 9×3 | **3×4** with temporal accumulation; **2×3** if you need the ms back. |
| `DenoiseBlurBeta` | Centre-tap weight in the edge-aware blur. `1e4` disables denoise. | `1.2` | 1.2. |
| `OCCLUSION_TERM_SCALE` | Divide by this before packing into UNORM, because raw pre-denoise AO can exceed 1. | `1.5` | Only relevant if you pack to RGBA8. |
| `pixelTooCloseThreshold` | pixels. Minimum sample offset; `minS = 1.3 / screenspaceRadius`. | `1.3` | 1.3–1.6 at half res. Below this you sample your own texel. |

Sources: `XeGTAO.h` lines 107–114 and 149–158, `XeGTAO.hlsli` lines 301–367.
Radius default is `float Radius = 0.5f; // World (view) space size of the occlusion sphere.`

**How to choose the radius for a beach.** The radius is the *largest occluder scale you want
to darken with*. Anything larger is the job of shadow maps and sky-visibility, not AO.

* Grass tuft base / pebble contact: 0.05–0.2 m
* Rock-to-sand contact, driftwood, footprint rims: 0.3–1.0 m
* Rock overhangs, boulder undersides, crevices between sea stacks: 1–3 m
* Cliff-to-beach ambient occlusion: 5–30 m — **do not** do this with SSAO. It will not fit on
  screen, it will pop as the camera moves, and the correct answer is a baked/probe sky
  visibility term.

So: one pass at **1.0–1.5 m** covers rock contacts and crevices; a second at **0.25 m**
combined with `min(ao_small, ao_large)` (Lagarde's rule as quoted by Filament:
"to prevent over darkening when using both medium and large scale occlusion, Lagarde recommends
to use `min(AO_medium, AO_large)`") gives the fine contact detail without doubling darkness.

A practical clamp: `radiusPx = clamp(radiusPx, 2.5, uMaxRadiusPx)`. GTAO's paper explicitly
mentions this: the neighbourhood size is "scaled depending on the distance from the camera …
and is clamped to a maximum radius in pixels to avoid too large gathering radiuses on objects
very close to the near plane, which would needlessly trash the GPU caches." At half res,
`uMaxRadiusPx ≈ 64–96`.

Note on engine conventions, for calibration: Unreal exposes `ambient_occlusion_radius` in
Unreal units, with a separate boolean `ambient_occlusion_radius_in_ws` — *"true: AO radius is
in world space units, false: AO radius is locked the view space in 400 units"*
(<https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PostProcessSettings>).
I did **not** verify Unreal's numeric default radius; do not copy a number from me here.

### 2.6 Thickness — three options, ranked

The depth buffer is a height field. A single depth sample is treated as an infinitely deep
wall. For beach grass, rock lips and thin branches this produces halos.

**(a) GTAO paper's exponential-moving-average heuristic (eq. 9)**, "derived from the assumption
that the thickness of an object is similar to their screen space size":

```
θ = max(θ_s, θ)                    if cos(θ_s) ≥ cos(θ_{s−1})
θ = blend(θ_{s−1}, θ_s)            if cos(θ_s) <  cos(θ_{s−1})
```
where `blend` is an exponential moving average and `θ₀ = 0`. The paper notes this "has the
property of not biasing the occlusion results for simple corners (e.g. walls)".

**(b) XeGTAO's `ThinOccluderCompensation`** — the shipped, tuned version of (a). Two parts,
verbatim (`XeGTAO.hlsli` lines 481–503):

```hlsl
lpfloat falloffBase0 = length( lpfloat3(sampleDelta0.x, sampleDelta0.y,
                                        sampleDelta0.z * (1+thinOccluderCompensation) ) );
lpfloat weight0      = saturate( falloffBase0 * falloffMul + falloffAdd );
...
horizonCos0 = lerp( max( horizonCos0, shc0 ), shc0, thinOccluderCompensation );
```
The first stretches the depth axis so that thin-in-z samples fall out of the radius sooner;
the second replaces the hard `max()` horizon latch with a lerp toward the current sample, so a
grass blade cannot permanently latch the horizon to a wall. **The `max()` is the bug** — one
foreground sample sets the horizon for the whole slice.

For beach vegetation, `0.15–0.30`. At 0 you get halos around every grass blade; at 0.7 rock
crevices stop occluding.

**(c) Visibility bitmask (Therrien, Levesque, Gilet 2023).** The most principled fix:
replace the two horizon angles with an `Nb`-bit field of occluded/unoccluded sectors around the
hemisphere slice, and give every depth sample a **constant world thickness `t`** so it occludes
only the sectors between `θ_f` (at the sample) and `θ_b` (behind it).

> "All occluded sectors are set at once, making the algorithm perform in O(1) for any sector
> count." — <https://arxiv.org/pdf/2301.11376> §3.1

Their Algorithm 1, the load-bearing lines:
```
14:  Front sample s_f ← view-space position at step j
15:  Back  sample s_b ← s_f − (p/‖p‖) · t
16:  θ_f, θ_b ← angles of s_f and s_b on XY-plane
17:  θ_min, θ_max ← min(θ_f, θ_b), max(θ_f, θ_b)
18:  a, b ← floor((θ_min + π/2)/π · N_b),  ceil((θ_max − θ_min)/π · N_b)
19:  b_j ← (2^b − 1) << a
26:  AO ← AO + 1 − countbits(b_i)/N_b
```
`N_b = 32` fits a `uint` and GLSL ES 3.00 has `bitCount()` and integer shifts, so this is
directly implementable in WebGL2. Their guidance on `t`:

> "We propose using a small constant value since artifacts of over-occlusion around thin
> objects are much more noticeable than light leaks behind thick objects."

and note that a fixed world `t` under-occludes distant objects, so they optionally scale `t`
linearly with distance. For a beach, `t ≈ 0.05–0.15 m` (a grass blade, a rock lip) with a mild
distance ramp. **Trade-off:** you lose the exact cosine-weighted arc integral and get a
sector-quantised approximation (32 sectors ≈ 5.6° resolution), which shows as faint banding in
very smooth gradients. Their Figure 6 is explicit that the bitmask **introduces light leaks at
depth discontinuities** that plain GTAO-without-falloff does not have.

My recommendation for this scene: start with (b), because it is 3 lines on top of the GTAO you
already have. Move to (c) only if grass/vegetation halos are the thing failing your reference
comparison.

### 2.7 Where AO is allowed to multiply — and what it looks like when it isn't

**Rule: AO multiplies indirect (ambient / IBL / probe) lighting only.** Filament states this
twice, once for diffuse and once for specular:

```glsl
// diffuse indirect
vec3 indirectDiffuse = max(irradianceSH(n), 0.0) * Fd_Lambert();
// ambient occlusion
indirectDiffuse *= texture2D(aoMap, outUV).r;
```
> "Note how the ambient occlusion term is only applied to indirect lighting."
> — <https://google.github.io/filament/Filament.md.html>, listing `bakedDiffuseAO`

The reason is in the derivation: `AO` is the fraction of the *uniform distant environment* that
reaches the point. A directional sun is not a uniform distant environment; its occlusion is a
shadow map, and you already computed it.

**What "AO on direct sun" looks like in a screenshot.** This is the failure the brief asks
about, and it is very recognisable:
1. **Sunlit surfaces have soft grey rims at every silhouette.** A boulder in full sun gets a
   dark halo where it meets bright sand, on the *sun-facing* side, where physically there is a
   crisp shadow boundary and nothing else.
2. **The shadow terminator doubles.** You see the real shadow-map edge, and then a second,
   softer, wider darkening offset from it.
3. **Contrast collapses in bright regions.** Sunlit sand near a rock reads as mid-grey instead
   of near-white, so the histogram loses its top end and the image looks flat and hazy even
   though the sun is nominally strong. If your scoring has a `highlight_frac`-type metric, it
   will drop.
4. **Turning the sun down makes it look *better***, which is the diagnostic. If lowering sun
   intensity improves the AO, AO is in the wrong term.
5. **Under a rock overhang, the AO is invisible.** Because the ambient is small there and the
   direct is zero, the AO you wanted has no effect, while the AO you didn't want is all over
   the sunlit beach. Exactly backwards.

The reverse mistake — applying AO to the *final composite* after tone mapping — looks like
someone painted grey dirt on the frame. Contact darkening survives into specular highlights
(a wet-sand sun glint should never be occluded by AO) and into the sky, and the AO does not
respond at all to changing the ambient colour.

**Multibounce.** Straight `L_indirect *= AO` over-darkens, because AO's binary visibility
assumes occluders are pure absorbers. The GTAO paper's fit (eq. 10):

```
G(A, ρ) = a(ρ)·A³ − b(ρ)·A² + c(ρ)·A
a(ρ) = 2.0404·ρ − 0.3324
b(ρ) = 4.7951·ρ − 0.6417
c(ρ) = 2.7552·ρ + 0.6903
```
fitted against three-bounce path-traced references over albedos ρ ∈ {0.1 … 0.9}.
Filament's `gtaoMultiBounce()` implements this; the common shipping form is

```glsl
vec3 gtaoMultiBounce(float visibility, const vec3 albedo) {
    vec3 a =  2.0404 * albedo - 0.3324;
    vec3 b = -4.7951 * albedo + 0.6417;
    vec3 c =  2.7552 * albedo + 0.6903;
    return max(vec3(visibility), ((visibility * a + b) * visibility + c) * visibility);
}
```
(<https://github.com/google/filament/blob/main/shaders/src/surface_ambient_occlusion.fs>,
`gtaoMultiBounce`.) Note it returns a **colour**: bright sand (ρ≈0.4 warm) bounces warm light
back into its own crevices, so the occluded region tints sandy rather than going neutral grey.
On a beach this is a very visible win and costs 6 MADs.

**Specular occlusion.** Do not use the diffuse AO on indirect specular. Lagarde's fit
(Frostbite 2014), verbatim from Filament:

```glsl
float computeSpecularAO(float NoV, float ao, float roughness) {
    return clamp(pow(NoV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao, 0.0, 1.0);
}
```
`roughness` here is the **linear/perceptual** roughness in Filament's naming; the exponent
`exp2(-16r − 1)` → 0.5 at r=0 and → ~0 at r≥0.4, i.e. the formula returns `ao` unmodified for
rough surfaces and reduces occlusion at normal incidence for smooth ones. (This is
corroborated independently by the Skyrim Community Shaders PBR implementation, which quotes
`saturate(pow(abs(NdotV + ao), exp2(-16*roughness - 1)) - 1 + ao)` —
<https://deepwiki.com/doodlum/skyrim-community-shaders/3.3-materials-and-pbr>.)

**Horizon specular occlusion** (Russell 2015, via Filament) — cheap, and it matters on wet sand
with a normal map, where the reflection vector can end up pointing into the surface:
```glsl
float horizon = min(1.0 + dot(r, n), 1.0);
indirectSpecular *= horizon * horizon;
```

---

## 3. Bent normals — worth it here?

**Short answer: yes, for specular occlusion; marginal for diffuse in this scene.**

### 3.1 The maths, free with GTAO

You already have `h0`, `h1`, `n` per slice. The cosine-weighted mean unoccluded direction over
the same arc is closed-form. XeGTAO, `#ifdef XE_GTAO_COMPUTE_BENT_NORMALS`
(lines ~547–554), labelled *"Algorithm 2 Extension that computes bent normals b"*:

```hlsl
lpfloat t0 = ( 6*sin(h0-n) - sin(3*h0-n) + 6*sin(h1-n) - sin(3*h1-n)
             + 16*sin(n) - 3*(sin(h0+n) + sin(h1+n)) ) / 12;
lpfloat t1 = ( -cos(3*h0-n) - cos(3*h1-n) + 8*cos(n)
             - 3*(cos(h0+n) + cos(h1+n)) ) / 12;
lpfloat3 localBentNormal = lpfloat3( directionVec.x*t0, directionVec.y*t0, -t1 );
localBentNormal = mul( XeGTAO_RotFromToMatrix(lpfloat3(0,0,-1), viewVec), localBentNormal )
                  * projectedNormalVecLength;
bentNormal += localBentNormal;
```
then `bentNormal = normalize(bentNormal)` after the slice loop. In a view-space slice frame
with tangent `T` and view `V` this is `bent += projLen * (T*t0 + V*t1)`.

Cost: 6 `sin` + 5 `cos` per slice. At 3 slices that is real but not fatal; you can drop to
2 slices and keep bent normals for the same budget as 3 slices without.

Storage: XeGTAO packs `bentNormal*0.5+0.5` in RGB and visibility in A of an RGBA8. Octahedral
encoding into 2×8 bits plus AO in 16 bits also works and is more accurate.

Guard: clamp the bent normal into the upper hemisphere of the geometric normal
(`if (dot(bn, N) < 0.0) bn = N;`). The closed form can dip below the tangent plane when both
horizons are extreme, and a below-horizon bent normal makes the specular cone intersection
return garbage.

### 3.2 What they buy you

**Specular occlusion via cone intersection (GTSO).** This is the real payoff. The GTAO paper
approximates visibility as a cone about the bent normal `b`, with aperture derived from AO
(eq. 17–18):

```
Â(x) = 1 − cos²(α_v)      ⟹     cos(α_v) = sqrt(1 − Â(x))
```

and the specular lobe as a second cone about the reflection vector; specular occlusion is the
ratio of the intersection solid angle to the specular cone's solid angle (eq. 19),
`S = Ω_i / Ω_s`. Filament implements exactly this, verbatim
(<https://github.com/google/filament/blob/main/shaders/src/surface_ambient_occlusion.fs>):

```glsl
float SpecularAO_Cones(vec3 bentNormal, float visibility, float roughness) {
    // aperture from ambient occlusion
    float cosAv = sqrt(1.0 - visibility);
    // aperture from roughness, log(10) / log(2) = 3.321928
    float cosAs = exp2(-3.321928 * sq(roughness));
    // angle between bent normal and reflection direction
    float cosB  = dot(bentNormal, shading_reflected);

    float ao = sphericalCapsIntersection(cosAv, cosAs, cosB) / (1.0 - cosAs);
    // Smoothly kill specular AO when entering the perceptual roughness range [0.1..0.3]
    // Without this, specular AO can remove all reflections, which looks bad on metals
    return mix(1.0, ao, smoothstep(0.01, 0.09, roughness));
}

float sphericalCapsIntersection(float cosCap1, float cosCap2, float cosDistance) {
    // Oat and Sander 2007, "Ambient Aperture Lighting"; approximation mentioned by Jimenez 2016
    float r1 = acosFastPositive(cosCap1);
    float r2 = acosFastPositive(cosCap2);
    float d  = acosFast(cosDistance);
    if (min(r1, r2) <= max(r1, r2) - d) return 1.0 - max(cosCap1, cosCap2);
    else if (r1 + r2 <= d)              return 0.0;
    float delta = abs(r1 - r2);
    float x = 1.0 - saturate((d - delta) / max(r1 + r2 - delta, 1e-4));
    float area = sq(x) * (-2.0 * x + 3.0);        // simplified smoothstep
    return area * (1.0 - max(cosCap1, cosCap2));
}
```
Filament combines the two: `specularAO = min(specularAO_Lagarde_or_material, ssSpecularAO)`.

**Why this matters on a beach.** Wet sand and water are the low-roughness surfaces in the
scene, and low roughness is exactly where scalar AO is worst and where the cone intersection
does something. A puddle in the lee of a rock should reflect the *sky it can see*, not the
sky as a whole, and it should darken on the side the rock is on. The scalar Lagarde fit has no
direction and cannot do that.

**Diffuse with bent normals.** Sampling the irradiance SH/probe along `b` instead of `n` biases
toward unoccluded directions. Interplay of Light's write-up is the best public discussion
(<https://interplayoflight.wordpress.com/2021/12/28/notes-on-occlusion-and-directionality-in-image-based-lighting/>);
it shows the improvement is large under **high-directionality** environments and modest under
near-uniform ones. A clear-sky beach with the sun *removed from the ambient* is fairly
directional in the vertical (sky above, sand/sea bounce below), so there is something to gain,
but far less than in an interior. Also note Filament deliberately does **not** use the screen-space
bent normal for diffuse: *"For now we don't use the screen space AO bent normal for the diffuse
because the AO bent normal is currently a face normal."* — i.e. their SS bent normal is
computed from the geometric/face normal and using it for diffuse would fight the normal map.

**Verdict for this scene.** Compute them. Use them for `SpecularAO_Cones` on wet sand, water
and rock. Use them for diffuse only if your sky irradiance has strong vertical structure
(e.g. an SH sky with a bright horizon band), and even then blend
`n_diffuse = normalize(mix(N, bentNormal, 0.5))` rather than swapping outright, so normal-mapped
detail survives.

---

## 4. Denoising

GTAO at 1 slice/pixel is noise. The paper's answer is to spread the integral over space and
time:

> "we sample the horizon in only one direction per pixel, but use the information gathered on a
> neighborhood of 4 × 4 using a bilateral filter for reconstruction. In addition, we make
> aggressive use of temporal coherency by alternating between 6 different rotations and
> reprojecting the results, using an exponential accumulation buffer. All this gives a total of
> 4 × 4 × 6 = 96 effective sampled directions per pixel."
> — GTAO paper §4.1

That is the design to copy: **spatial reuse of decorrelated rotations, then temporal
accumulation.** Not "blur until smooth".

### 4.1 Spatial: edge-aware, depth-driven

XeGTAO precomputes per-pixel edge weights from the depth of the 4-neighbourhood, then packs
them into 2 bits each (`XeGTAO.hlsli` lines 120–129):

```hlsl
lpfloat4 XeGTAO_CalculateEdges( centerZ, leftZ, rightZ, topZ, bottomZ ) {
    lpfloat4 edgesLRTB = lpfloat4( leftZ, rightZ, topZ, bottomZ ) - centerZ;
    lpfloat slopeLR = (edgesLRTB.y - edgesLRTB.x) * 0.5;
    lpfloat slopeTB = (edgesLRTB.w - edgesLRTB.z) * 0.5;
    lpfloat4 edgesLRTBSlopeAdjusted = edgesLRTB + lpfloat4( slopeLR, -slopeLR, slopeTB, -slopeTB );
    edgesLRTB = min( abs( edgesLRTB ), abs( edgesLRTBSlopeAdjusted ) );
    return saturate( 1.25 - edgesLRTB / (centerZ * 0.011) );
}
```

Two things to steal:
* **The slope adjustment.** Raw `|Δz|` between neighbours is large on any surface seen at a
  grazing angle — which on a beach is *the entire ground plane*. Subtracting the local slope
  first means a smooth tilted plane has near-zero edge weight and gets blurred properly, while
  a genuine depth discontinuity still registers. Without this, your bilateral filter refuses to
  blur the sand and you keep all the noise on the largest surface in frame.
* **`centerZ * 0.011`** — the tolerance is proportional to distance (≈1.1% of view depth),
  because depth precision and the world size of a pixel both scale with `z`.

The blur is a 3×3 with `blurAmount = DenoiseBlurBeta` (1.2 by default) on the centre tap and
`0.85 * 0.5` on the diagonals:
```hlsl
const lpfloat diagWeight = 0.85 * 0.5;
lpfloat sumWeight = blurAmount;
AOTermType sum = ssaoValue * sumWeight;
XeGTAO_AddSample( ssaoValueL, edgesC_LRTB[side].x, sum, sumWeight );   // ... etc
```

Three.js ships a general alternative, `PoissonDenoiseShader`, whose weight is a product of
three similarity terms (`node_modules/three/examples/jsm/shaders/PoissonDenoiseShader.js`
lines 156–162):

```glsl
float normalDiff       = dot(viewNormal, sampleNormal);
float normalSimilarity = pow(max(normalDiff, 0.), normalPhi);
float lumaDiff         = abs(getLuminance(neighborColor) - getLuminance(center));
float lumaSimilarity   = max(1.0 - lumaDiff / lumaPhi, 0.0);
float depthDiff        = abs(dot(viewPos - viewPosSample, viewNormal));   // plane distance!
float depthSimilarity  = max(1. - depthDiff / depthPhi, 0.);
float w = lumaSimilarity * depthSimilarity * normalSimilarity;
```

`depthDiff = abs(dot(viewPos - viewPosSample, viewNormal))` is the important line: it is the
**distance from the neighbour to the centre pixel's tangent plane**, not `|z1 − z2|`. This is
the same idea as XeGTAO's slope adjustment, expressed more directly, and it is the correct
depth weight for grazing ground. Use it.

Suggested phis for a beach at metre scale: `depthPhi ≈ 0.05–0.15` (metres of allowed
out-of-plane deviation), `normalPhi ≈ 4–16` (exponent, so 8 ≈ 30° half-width),
`lumaPhi ≈ 0.5–1.0` for an AO signal in [0,1].

The Poisson sample set is generated in JS as a spiral (same file, `generateDenoiseSamples`):
```js
const angle  = 2 * Math.PI * numRings * i / numSamples;
const radius = Math.pow( i / ( numSamples - 1 ), radiusExponent );
samples.push( new Vector3( Math.cos(angle), Math.sin(angle), radius ) );
```
and rotated per-pixel by a noise texture, which is what turns residual structure into noise
that the temporal pass can eat.

### 4.2 Temporal reuse

Reproject last frame's AO with the camera motion (a static-geometry beach means camera motion
vectors are enough; add object motion vectors if anything animates). Exponential accumulation:

```
ao_out = mix(ao_history_reprojected, ao_current, alpha)
```
with `alpha ≈ 1/8 … 1/16` when history is valid. Validate history by:
* **Reprojected depth vs current depth**, using the tangent-plane distance again, tolerance
  proportional to `z`;
* **Normal dot** > ~0.9;
* **Off-screen** history UV → `alpha = 1`.

Rotate the slice phase per frame over N frames (GTAO uses 6; XeGTAO advances its Hilbert-R2
index by `288 * (frame % 64)`). If you rotate over 6 frames and accumulate with `alpha = 1/8`,
you get roughly the paper's 96 effective directions.

**Bias warning:** clamp AO to [0,1] *after* the temporal average, not before (§2.3).

### 4.3 Interaction with TAA

This is where it usually goes wrong.

1. **Do not let the AO's history be the TAA's history.** They have different validity rules
   (TAA needs the jittered subpixel history; AO needs geometric similarity) and different
   blend rates. Two small buffers is correct.
2. **AO must be computed from the *jittered* depth/normal buffers** of the current frame, and
   the AO's own reprojection must account for the jitter offsets of both frames. If you forget,
   AO shimmers along every silhouette at exactly the jitter frequency, which reads as a
   1-pixel-wide crawling outline.
3. **Order.** Compute AO → denoise → temporally accumulate AO → *apply to indirect lighting* →
   then TAA the shaded image. If you apply AO after TAA you have painted a non-antialiased
   signal on an antialiased image and every AO edge aliases.
4. **Don't neighbourhood-clamp the AO history against the AO neighbourhood the way TAA does.**
   TAA's clamp exists to reject ghosting on moving objects; on AO it mostly rejects the very
   low-frequency accumulated signal you were trying to build, and reintroduces noise. Use
   geometric rejection instead.
5. **Beware double temporal filtering of the same noise.** If the AO temporal pass has already
   converged and TAA also has a long history, small camera motions produce visible *lag* in
   contact shadows — the dark region under a rock trails the rock. Keep the AO's `alpha` no
   lower than ~1/16.
6. Same rules apply to SSR, with the extra wrinkle in §5.6.

### 4.4 Half-res → full-res upsample

Bilinear upsampling AO across a depth discontinuity leaks occlusion onto the foreground object
by half a low-res texel — a visible bright/dark fringe. Filament's depth-aware bilinear
(`surface_ambient_occlusion.fs`, `evaluateSSAO`) is a good pattern: take the 4 taps with
`textureGather`, form the standard bilinear weights `b`, then

```glsl
highp vec4 w = (vec4(d) - depths) * frameUniforms.aoSamplingQualityAndEdgeDistance;
w = max(vec4(MEDIUMP_FLT_MIN), 1.0 - w * w) * b;
cache.weights = w / (w.x + w.y + w.z + w.w);
return dot(ao, cache.weights);
```
i.e. a quadratic depth falloff multiplied into the bilinear weights, renormalised.
Filament stores the low-res depth alongside AO in G/B as two 8-bit halves and unpacks with
`(depth.x * (256.0/257.0) + depth.y * (1.0/257.0))`. In WebGL2 you can just keep an R16F or
R32F depth alongside. Note the `max(FLT_MIN, ...)` — without it, all four weights can be zero
at a strong discontinuity and you divide by zero.

---

## 5. Screen-space reflections

### 5.1 What SSR is actually solving

```
L_o = ∫_Ω f_s(l,v) L_i(l) ⟨n·l⟩ dl
```
sampled by tracing a small number of rays per pixel against the depth buffer, importance-sampled
by the GGX lobe. The Frostbite talk (Stachowiak & Uludag, SIGGRAPH 2015, *Advances in Real-Time
Rendering*, <https://advances.realtimerendering.com/s2015/>) is the canonical treatment; the
pipeline is

> Tile classification → Ray allocation → Cheap raytracing → HQ raytracing → Color resolve →
> Temporal filter (slide 33)

### 5.2 Ray marching: linear vs perspective-correct DDA vs Hi-Z

**Naive view-space march** (advance the ray by a fixed world Δ, project, compare depth) is
wrong for grazing rays: uniform world steps map to wildly non-uniform screen steps under
perspective. Near the origin you re-sample the same pixel a dozen times; 80 m out you skip
whole sea stacks. On a beach every interesting SSR ray is grazing.

**Perspective-correct screen-space DDA (McGuire & Mara, JCGT 2014,
<https://jcgt.org/published/0003/04/04/>)** is the right default. The insight: `1/w` and `Q/w`
(where `Q` is the view-space position) interpolate **linearly in 2D screen space**, so you can
step uniformly in pixels and get exact view-space `z` at every step.

I could not get a clean text extraction of the paper's own GLSL listing (the JCGT PDF is a
scanned/compressed image PDF — see §9). A faithful, verifiable port is kode80's Unity
implementation, which follows the paper structure line for line
(<https://github.com/kode80/kode80SSR/blob/master/Assets/Resources/Shaders/SSR.shader>,
`traceScreenSpaceRay`, lines 124–235). Verbatim:

```hlsl
// Clip to the near plane
float rayLength = ((rayOrigin.z + rayDirection.z * _MaxRayDistance) > -_ProjectionParams.y) ?
                  (-_ProjectionParams.y - rayOrigin.z) / rayDirection.z : _MaxRayDistance;
float3 rayEnd = rayOrigin + rayDirection * rayLength;

// Project into homogeneous clip space
float4 H0 = mul( _CameraProjectionMatrix, float4( rayOrigin, 1.0));
float4 H1 = mul( _CameraProjectionMatrix, float4( rayEnd,    1.0));
float k0 = 1.0 / H0.w, k1 = 1.0 / H1.w;

// The interpolated homogeneous version of the camera-space points
float3 Q0 = rayOrigin * k0, Q1 = rayEnd * k1;
// Screen-space endpoints
float2 P0 = H0.xy * k0, P1 = H1.xy * k1;

// If the line is degenerate, make it cover at least one pixel
P1 += (distanceSquared(P0, P1) < 0.0001) ? 0.01 : 0.0;
float2 delta = P1 - P0;

// Permute so that the primary iteration is in x to collapse all quadrant-specific DDA cases
bool permute = false;
if (abs(delta.x) < abs(delta.y)) { permute = true; delta = delta.yx; P0 = P0.yx; P1 = P1.yx; }

float stepDir = sign(delta.x);
float invdx   = stepDir / delta.x;

float3 dQ = (Q1 - Q0) * invdx;
float  dk = (k1 - k0) * invdx;
float2 dP = float2(stepDir, delta.y * invdx);

// stride scaling: bigger steps near the camera, 1px steps far away
float strideScaler = 1.0 - min( 1.0, -rayOrigin.z / _PixelStrideZCuttoff);
float pixelStride  = 1.0 + strideScaler * _PixelStride;
dP *= pixelStride; dQ *= pixelStride; dk *= pixelStride;
P0 += dP * jitter; Q0 += dQ * jitter; k0 += dk * jitter;

float4 pqk  = float4( P0, Q0.z, k0);
float4 dPQK = float4( dP, dQ.z, dk);
for( i=0; i<_Iterations && intersect == false; i++) {
    pqk += dPQK;
    zA = zB;
    zB = (dPQK.z * 0.5 + pqk.z) / (dPQK.w * 0.5 + pqk.w);   // z at the MIDPOINT of the step
    swapIfBigger( zB, zA);
    hitPixel  = permute ? pqk.yx : pqk.xy;
    hitPixel *= _OneDividedByRenderBufferSize;
    intersect = rayIntersectsDepthBF( zA, zB, hitPixel);
}
```
followed by a bisection refinement when `pixelStride > 1`:
```hlsl
pqk -= dPQK; dPQK /= pixelStride;
float originalStride = pixelStride * 0.5, stride = originalStride;
for( float j=0; j<_BinarySearchIterations; j++) {
    pqk += dPQK * stride;
    zA = zB;
    zB = (dPQK.z * -0.5 + pqk.z) / (dPQK.w * -0.5 + pqk.w);
    swapIfBigger( zB, zA);
    hitPixel = permute ? pqk.yx : pqk.xy;  hitPixel *= _OneDividedByRenderBufferSize;
    originalStride *= 0.5;
    stride = rayIntersectsDepthBF( zA, zB, hitPixel) ? -originalStride : originalStride;
}
```

Three things this gets right that hand-rolled marchers usually don't:
* **the `permute` swap** — iterate along the *major* screen axis so you visit every pixel the
  ray crosses exactly once, regardless of slope;
* **`zA`/`zB` as a depth *interval* per step**, not a point sample. The intersection test is
  "does `[zA, zB]` straddle the depth buffer within `thickness`", which is what makes the test
  robust when a step covers several pixels;
* **`jitter`** — offsetting the start by a fraction of a step turns stride quantisation from
  banding into noise the temporal pass can integrate.

**Hi-Z (Uludag, GPU Pro 5).** Build a min-Z pyramid; walk the ray cell-by-cell, descending a
mip on a miss and ascending on a hit. Frostbite's slide 36:
```
mip = 0;
while (level > -1)
    step through current cell;
    if (above Z plane) ++level;
    if (below Z plane) --level;
```
A well-documented public implementation (Metal, but readable) is
<https://sugulee.wordpress.com/2021/01/19/screen-space-reflections-implementation-and-optimization-part-2-hi-z-tracing-method/>,
whose `intersectCellBoundary` is:
```metal
float3 intersectCellBoundary(float3 o, float3 d, float2 cell, float2 cell_count,
                             float2 crossStep, float2 crossOffset) {
    float2 index    = cell + crossStep;
    float2 boundary = index / cell_count + crossOffset;
    float2 delta    = (boundary - o.xy) / d.xy;
    float  t        = min(delta.x, delta.y);
    return o + d * t;
}
```
with a `crossOffset` nudge (they use a 64× texel epsilon) to avoid landing exactly on a
boundary and looping.

**Should you use Hi-Z on this scene?** Probably not, and the reasoning is scene-specific:
* Hi-Z wins when rays are long and traverse mostly *empty* screen — a corridor, a mirror floor
  in a sparse room. The min-Z pyramid then skips huge spans in a few iterations.
* On a beach the interesting rays skim the sand/water surface at a few degrees. A grazing ray
  stays inside the terrain's own min-Z envelope for its whole length, so the conservative test
  fails at nearly every level and the walk degenerates to a per-cell march — after you paid for
  the pyramid.
* In WebGL2 the pyramid costs `log2(N)` fullscreen passes (no compute, no single-pass
  downsampler), and non-power-of-two dimensions force 3×3 gathers at odd levels.
* Frostbite themselves classify **cheap rays = simple linear march** for rough surfaces and
  reserve HQ hierarchical tracing for `roughness < 20%` (slides 35, 75).

If you do build one, note the mip rule is **min** of the 4 children (a conservative near
bound), and for non-power-of-two you must include the extra row/column.

### 5.3 Importance sampling by roughness

Sample the GGX **distribution of visible normals** (VNDF), not the full NDF; VNDF never
generates microfacets facing away from the viewer, so you waste far fewer rays.

Heitz's routine, refactored and republished by Dupuy & Benyoub (HPG 2023,
<https://cdrdv2-public.intel.com/782052/sampling-visible-ggx-normals.pdf>), Listing 1:

```glsl
vec3 SampleVndf_GGX(vec2 u, vec3 wi, vec2 alpha) {
    // warp to the hemisphere configuration
    vec3 wiStd = normalize(vec3(wi.xy * alpha, wi.z));
    // sample the hemisphere
    vec3 wmStd = SampleVndf_Hemisphere(u, wiStd);
    // warp back to the ellipsoid configuration
    vec3 wm = normalize(vec3(wmStd.xy * alpha, wmStd.z));
    return wm;
}
```
and their simpler exact hemisphere routine, Listing 3 (use this one — fewer ALU, no
`inversesqrt`, no branch):
```glsl
// Sampling the visible hemisphere as half vectors (spherical caps)
vec3 SampleVndf_Hemisphere(vec2 u, vec3 wi) {
    float phi      = 2.0 * M_PI * u.x;
    float z        = fma((1.0 - u.y), (1.0 + wi.z), -wi.z);   // cap in (-wi.z, 1]
    float sinTheta = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
    vec3  c = vec3(sinTheta * cos(phi), sinTheta * sin(phi), z);
    vec3  h = c + wi;          // halfway direction
    return h;                  // unnormalised; normalisation happens in the caller
}
```
`wi` is the **view direction in tangent space** (z = normal), `alpha = roughness²` (with
`roughness` = perceptual/linear roughness, per Disney/UE4 convention). The reflected ray is
`wo = reflect(-wi, wm)`; reject and regenerate if `wo.z <= 0`.

For SSR you typically want `alpha` **anisotropically shrunk** for the trace to avoid tracing
rays that will be blurred away anyway; Frostbite instead biases the sample toward the mirror
direction (slide 68):
```
float2 u = halton(sampleIdx);
u.x = lerp(u.x, 1.0, bias);      // bias ~0.7 in shipping config
importanceSample(u);
```
with the note *"Different normalization constant / Our variance reduction re-normalizes!"* —
i.e. the biased sampling would be wrong on its own, but their weight-normalised resolve
(§5.4) divides it back out. This is a genuinely important detail: **you can bias the sampling
only if your resolve normalises by the weight sum.**

Practical ray budget: 1 ray per half-res pixel + 4 resolve taps is the Frostbite shipping
config (2.19 ms on PS4 at 1600×900 with all pixels reflective, slide 75). For WebGL2, 1 ray per
half-res pixel is the right target.

### 5.4 The resolve — ratio estimator with weight normalisation

Neighbouring pixels' rays are reused. Frostbite slide 55, verbatim:

```
result    = 0.0
weightSum = 0.0
for pixel in neighborhood:
    weight     = localBrdf(pixel.hit) / pixel.hitPdf
    result    += color(pixel.hit) * weight
    weightSum += weight
result /= weightSum
```

`localBrdf` is **this** pixel's BRDF evaluated for the *neighbour's* hit direction; `hitPdf` is
the pdf the neighbour used when it generated the ray (returned by the ray-trace alongside the
hit point). Dividing by `weightSum` rather than by `N` is what makes it a ratio estimator and
what lets you (a) bias the sampling, and (b) fill gaps where several neighbours' rays missed.
Slides 56–62 show the before/after: **without normalisation you get dark blotches**; with it,
1 ray + 4 resolve samples is usable.

Slide 46's warning: *"Neighbors can have vastly different properties → Spikes in BRDF/PDF ratio
→ Worse results than without reuse"*. Guard by rejecting neighbours whose roughness or normal
differ too much, or clamp the weight.

Slide 87 — **apply the pre-integrated `F·G` term (the split-sum `EnvBRDF`) *after* the temporal
filter**, when compositing SSR onto the screen: *"Reduces smearing and noise."* This is easy to
get wrong: if you multiply Fresnel into the traced radiance before temporal accumulation, the
history carries a stale Fresnel from a stale view angle and smears when the camera turns.

### 5.5 Roughness → blur (filtered importance sampling), and grazing angles

Rather than cone-tracing, prefilter the colour buffer into a mip chain and pick a mip from the
cone footprint at the hit (Frostbite slide 69: *"Estimate footprint of a cone at intersection /
No actual cone tracing / Mip determined by log function fit"* of roughness, distance to hit,
and elongation).

The correct way to pick the level is to convert the lobe width to a **screen footprint at the
hit**, not to use a fixed roughness→mip table:
```
coneTan   = f(roughness)                            // lobe half-angle tangent
footprint = 2 * coneTan * rayLength                 // world units at the hit
pixels    = footprint * (0.5*H / (tanHalfFovY * hitZ))
lod       = log2(pixels)
```
so the same roughness reflecting something 2 m away is barely blurred while the same roughness
reflecting a sea stack 90 m away is blurred hard — which is what a GGX lobe actually does.

**Grazing-angle over-blur**, and Frostbite's fix (slide 85), verbatim:
```
specularConeTangent *= lerp( saturate(NdotV * 2.0), 1.0, sqrt(roughness) );
```
Their reasoning (slide 84): *"Cones poorly fit specular lobes at grazing angles / Lobes become
anisotropic in shape / Cone fit to wider (azimuthal) angle over-blurs / Fit it to polar angle /
Effectively: shrink the cone at grazing angles."* **This matters enormously for a beach**,
because the wet-sand and water reflections you care about are all at 2–10° grazing. Without it,
the swash sheet's reflection of the sea stacks turns into a smear and you lose exactly the
high-frequency edge energy the shot needs.

In WebGL2: `pipe.opaqueRT` typically has `generateMipmaps: false` for a half-float target.
Build a 4–5 level chain with explicit downsample passes rather than enabling mip generation on
a float texture (which is extension-dependent — `OES_texture_float_linear` /
`EXT_color_buffer_float` interactions).

### 5.6 Temporal SSR

Frostbite slide 67: reprojecting reflections along the **G-buffer** depth "smears"; you must
add a **reflection depth** (averaged from the local rays' hit distances) and reproject the
*reflected image* by that, to get proper reflection parallax. A reflection of a distant sea
stack in wet sand moves at a different screen rate than the sand does.

Slide 90 — neighbourhood clamping, *"similar to Temporal AA / Tuned for some smearing over
noise / Can't kill all the lag anyway / Reflection color is from previous frame! / Expand the
color bounding box."* Note the admission: SSR reads *last frame's* lit colour buffer, so it is
inherently one frame late even before temporal filtering. On a 60 Hz camera that is sub-pixel
on an already-blurred reflection.

Slide 88 — if you reuse rays across 2×2 quads you produce 2×2-block noise, and *"2x2 blocks
look like features, not aliasing"* to TAA. Spread the target pixels and jitter the pattern
temporally.

### 5.7 Fades — and why the screen edge is the tell

Every SSR failure must fade to *something*. The recognisable artefact is a hard horizontal seam
where reflections stop, because a grazing reflection off a ground plane travels *up* the screen
and exits through the top before it finds anything, producing a sharp discontinuity across the
whole frame.

Use several independent confidences, multiply them, and fade the remainder into the fallback:

1. **Screen edge, 2-D, per axis.** Killing Floor 2's version
   (<https://sakibsaikia.github.io/graphics/2016/12/26/Screen-Space-Reflection-in-Killing-Floor-2.html>),
   verbatim:
   ```hlsl
   UVSamplingAttenuation = smoothstep(0.05, 0.1, RaySample.xy) * (1 - smoothstep(0.95, 1, RaySample.xy));
   ```
   Note this is a `float2` expression, then `.x * .y` — a ray leaving through a corner fades on
   both axes. A 1-D border test leaves corner seams.
2. **Camera-facing rays.** Same source:
   ```hlsl
   float CameraFacingReflectionAttenuation = 1 - smoothstep(0.25, 0.5, dot(-CameraVector, ReflectionVector));
   ```
   A reflected ray pointing back toward the camera can only hit things hidden behind the
   visible surface, so any "hit" is a false positive off the depth buffer's front layer.
3. **Ray length.** Fade over the last ~30% of the ray's screen travel, so a ray that runs out of
   march doesn't pop against one that found something at 99%.
4. **Backface rejection.** If the hit surface's G-buffer normal faces the ray
   (`dot(N_hit, rayDir) > 0`), you hit the far side of geometry and the colour there is not what
   the reflection would see.
5. **Thickness rejection.** If the hit is deeper than `thickness` behind the depth buffer, it's
   a false positive from marching behind a foreground object.
6. **Miss.**

Anti-banding start offset, same source:
```hlsl
#define RAY_MARCH_BIAS 0.001f
float DitherOffset = DitherTexture.SampleLevel(InUV * DitherTilingFactor, 0).r * 0.01f + RAY_MARCH_BIAS;
float3 RaySample = ScreenSpacePos.xyz + DitherOffset * ScreenSpaceReflectionVec;
```
(4×4 Bayer; the 0.001 constant bias prevents self-intersection at the origin.)

**How to fade without a vignette.** The fade must go to a *plausible image*, not to black and
not to "no reflection":

* Sample the **sky cubemap in the correct world reflection direction**, at the same prefiltered
  roughness mip. Then `color = mix(fallback, ssr, confidence)` is a blend between two images of
  roughly the same brightness and colour, and the transition is invisible.
* Apply Fresnel/`EnvBRDF` **identically** to both branches, after the mix. If SSR is
  Fresnel-weighted and the fallback isn't, the boundary shows as a brightness step.
* Blur the confidence buffer slightly (a 3×3 of the confidence alone) so that isolated
  full-confidence pixels next to zero-confidence pixels don't produce speckle.
* Frostbite's own framing (slides 29–31) is SSR-off / SSR-on-fallback-off / SSR-on-fallback-on
  — the fallback is not optional.
* Bart Wronski's conclusion, after enumerating SSR's failure modes, is the same:
  *"Always supplement SSR with localized and parallax-corrected baked or dynamic cubemaps,
  using screenspace reflections purely for occlusion enhancement"*
  (<https://bartwronski.com/2014/01/25/the-future-of-screenspace-reflections/>).

### 5.8 Fresnel and energy — the thing people get wrong

Two errors, both very visible:

**(a) Adding instead of substituting.** The forward material has already put its own ambient
specular / cubemap reflection into the pixel. Adding SSR on top double-counts energy. Either
(i) don't write the env-specular in the material and let the SSR pass own the whole specular
IBL term, or (ii) *replace*:
```glsl
colour = mix(colour, reflection, clamp(k, 0.0, 0.92));
```
Substituting is also closer to what Fresnel means: at 4° grazing on a water film, `F → 1` and
the diffuse under it genuinely is not what you see.

**(b) Using the raw Schlick `F` as the blend weight.** The correct weight for a
split-sum-approximated IBL is the pre-integrated `EnvBRDF`:
```
specular = prefilteredColor * (F0 * A + B),   (A,B) = envBRDF LUT(NoV, roughness)
```
Using raw `F = F0 + (1−F0)(1−NoV)^5` at grazing angles gives `F ≈ 1` on *every* material and
the whole frame turns into a mirror at the horizon. The `EnvBRDF` LUT already contains the
geometric attenuation that pulls that back down. Three.js's `BRDF_GGX`/`DFGApprox` in
`bsdfs.glsl.js` has an analytic version you can reuse.

Then multiply by:
* `specularAO` (§2.7) — indirect specular only;
* horizon occlusion `min(1 + dot(r,n), 1)²`;
* your per-material gain (dry sand ~0.1–0.2, wet sand 1.0, water 1.0, foliage 0, viewmodel 0);
* a roughness cutoff, e.g. `1 − smoothstep(0.35, 0.9, roughness)`, because above ~0.5 roughness
  a screen-space trace is noise and the prefiltered cubemap is *more* correct as well as
  cheaper. Frostbite classifies tiles by roughness for exactly this reason (slide 34–35).

---

## 6. Outdoor water and wet sand specifically

### 6.1 When SSR beats a cubemap

A sky cubemap is *exactly right* for any reflected ray that leaves the scene and hits sky. On
open water looking toward the horizon, most rays do exactly that, and SSR adds nothing but
cost and artefacts.

SSR earns its keep only where the reflected ray hits **geometry that is on screen**:

| Situation | Winner | Why |
|---|---|---|
| Open sea, camera looking out, no landmass in the reflection cone | **Cubemap** | Every ray hits sky. SSR is pure overhead. |
| Water/wet sand at the base of sea stacks, cliffs, rocks | **SSR** | The inverted silhouette of the stack is the entire visual payload, and a cubemap cannot produce it. |
| Swash sheet / wet sand at a shallow camera angle | **SSR** | A millimetre of water at ~4° grazing is nearly a mirror; it carries a second, sharp, upside-down copy of the skyline and the stack silhouettes. This is where the shoreline's high-frequency energy comes from. |
| Reflections of the *character/viewmodel* | Neither (SSR can't see backfaces) | Wronski: *"your hero won't be reflected properly in mirrors or windows."* Use a planar reflection or accept the loss. |
| Deep water far from shore, rough (wind-driven) | **Cubemap** | Roughness ≥ 0.3 → SSR is noise; the prefiltered probe is both cheaper and closer to correct. |
| Flat, large water plane, camera above it | **Planar reflection** if you can afford one extra scene draw | A mirrored-camera render has no screen-edge problem, no missing backfaces, no disocclusion. For a large flat sea this is often *better and simpler* than SSR. The cost is one extra opaque pass at reduced resolution, which for a beach with few objects is cheap. Reflection of a displaced (waving) surface is only approximate, but at these roughnesses the wave normals perturb the lookup adequately. |

Practical blend, in the water/wet-sand shader:
```glsl
vec3 skyRefl = textureLod(tSkyCube, worldReflectDir, roughnessToMip(rough));
vec3 refl    = mix(skyRefl, ssrColor, ssrConfidence);
vec3 spec    = refl * (F0 * envA + envB) * specularAO * horizon * horizon;
```

### 6.2 The water-is-not-in-the-G-buffer problem

Water is usually drawn as a transparent/forward pass, so it is not in the opaque G-buffer: at a
water pixel, the G-buffer normal/roughness/depth describe **the seabed behind it**, not the
water surface. A post-process SSR pass therefore cannot reflect off water at all.

Three workable approaches:

1. **Publish the SSR result as a texture and let the water shader sample it.**
   Cheap and already a common pattern:
   ```js
   const ssr = ctx.get('pipeline')?.pass('ssr');
   u.tSSR.value = ssr?.ssrTexture ?? null;  // half res, rgb = radiance, a = confidence
   ```
   Caveat: because the post chain runs *after* the scene draws, the water shader reads **last
   frame's** buffer. On a 60 Hz camera that is a sub-pixel lag on an already-blurred reflection;
   reproject by the camera delta if it shows. Also caveat: that buffer's rays were traced from
   the *seabed*, not from the water surface, so this only works if you re-trace or if the water
   is shallow.
2. **Trace SSR inside the water shader**, from the water surface, against the opaque depth
   buffer. This is correct (the ray origin is the actual water surface, the ray direction uses
   the actual wave normal) and it is what most ocean shaders do. It needs the opaque depth +
   opaque colour bound in the water material, and a `depthTexture` that is not the one you're
   currently writing.
3. **Render water normal/roughness/depth into the G-buffer in a second pre-pass** so the
   post-process SSR sees it. Cleanest for a deferred pipeline, most invasive.

For a beach, (2) for the sea + (1)/(post-process SSR) for the wet sand is the pragmatic split,
because wet sand *is* opaque and *is* in the G-buffer.

### 6.3 Wet sand as a material

Physically, wet sand is sand with a thin water film and water-filled pores. The two robust
observations from the literature:

* **Darker albedo.** Light entering the water film is internally reflected back into the grains
  and scatters more before escaping. The effect is largest for *low-albedo, rough, porous*
  materials and small for high-albedo, smooth, non-porous ones
  (Jensen, Legakis & Dorsey, *Rendering Wet Materials*, EGWR 1999,
  <http://graphics.ucsd.edu/~henrik/papers/egwr99/rendering_wet_materials_egwr99.pdf>;
  and the micro-ellipsoid model, <https://arxiv.org/pdf/2401.15628>). Practically: multiply
  albedo by 0.45–0.7 as wetness goes 0→1, and shift it slightly toward the saturated hue.
* **Lower roughness + a Fresnel water layer.** The film smooths the surface. Practically:
  `roughness = mix(rough_dry, 0.05–0.15, wetness)` and `F0 = mix(0.02–0.04, 0.02, wetness)`
  (water's F0 ≈ 0.02 for `n=1.33`). At 4° grazing, Schlick gives `F ≈ 0.9+`, which is why the
  swash sheet mirrors.

For SSR purposes the important consequence is: **wet sand is the lowest-roughness large surface
in the frame**, so it is the surface where SSR is both most needed and most artefact-prone.
Clamp its roughness for the *trace* (e.g. `ssrWetRoughClamp ≈ 0.4`) so you never trace a lobe
so wide the resolve can't converge.

---

## 7. Failure modes, described so you can see them in a screenshot

### AO

| What you see | Cause | Fix |
|---|---|---|
| **Dark halo / outline around every object silhouette**, thickest against a distant bright background, following the *screen* outline rather than any contact | Depth-buffer occluders treated as infinitely thick; the background pixels next to a silhouette see a "wall". | Thin-occluder compensation (§2.6b) or the visibility bitmask (§2.6c). Also check you're not just measuring `|Δz|` in the denoiser's edge test. |
| **Flat, unoccluded ground reads uniformly grey (e.g. 0.84 instead of 1.0)**, worst near the bottom of frame, with a **black band along the horizon line** | Horizons not initialised to the tangent-plane limits (`n ∓ π/2`), *or* half-res depth quantisation making a coplanar sample look like an occluder at grazing incidence. At 2° grazing, sub-millimetre depth error is several degrees of horizon error. | Initialise `cosH0 = -sin(n)`, `cosH1 = +sin(n)`. Snap sample UVs to texel centres. If it persists, add a small angle bias: require the sample to stand ≥ ~5–8° above the tangent plane, `w *= smoothstep(0.0, sin(7°), dot(D,N)/|D|)`. Be aware this is a *bias* — it slightly brightens genuine shallow creases. |
| **AO reads as dirt**: uniform grey wash in concavities, insensitive to how deep they are, plus a soft rim on everything | Classic occupancy SSAO, or GTAO with `FinalValuePower` way too high, or AO applied to the composite | Use the arc integral; drop `FinalValuePower` to 1.4–1.8; apply to indirect only. |
| **Grey outline on sunlit surfaces / doubled shadow terminator / flat highlights** | AO multiplied into direct sun | §2.7. |
| **Occlusion "swims" as the camera dollies**, contact shadows sliding across the sand | World radius too large for what's on screen, or radius clamped in pixels so it changes with distance | Clamp `radiusPx` (2.5 … ~96 at half res) and keep the world radius ≤ ~1.5 m. Large-scale occlusion belongs in baked sky visibility. |
| **Ring/banding at a fixed distance from every object** | Falloff range too small (hard cutoff at the radius) | `EffectFalloffRange` 0.6–0.7. |
| **AO shimmers on silhouettes at ~1 px width, in sync with TAA jitter** | AO reprojection not accounting for jitter | §4.3.2. |
| **Contact shadow lags behind a moving rock / trails on camera pan** | Temporal `alpha` too low, or double temporal filtering | `alpha ≥ 1/16`; separate AO history from TAA history. |
| **Bright/dark fringe one low-res texel wide along foreground silhouettes** | Naive bilinear upsample of half-res AO across a depth discontinuity | Depth-aware bilinear (§4.4). |
| **Occluded crevices go pure black and lose all albedo colour** | Missing multibounce | GTAO multibounce (§2.7); also XeGTAO's `visibility = max(0.03, visibility)`. |
| **Metals/water lose all reflection in mild AO** | Specular AO cones applied at very low roughness without the guard | Filament's `mix(1.0, ao, smoothstep(0.01, 0.09, roughness))`. |

### SSR

| What you see | Cause | Fix |
|---|---|---|
| **Reflections stretch into vertical streaks toward the top/side of the frame** | Ray exits the viewport; the last valid sample gets smeared, or the trace clamps UV | Fade by 2-D edge smoothstep (§5.7.1) and **clamp confidence to 0**, don't clamp the UV. |
| **A hard horizontal line across the whole frame where reflections stop** | 1-D edge fade only, or no fallback | 2-D fade per axis + sky cubemap fallback in the same world direction (§5.7). |
| **Objects reflected with a "shadow" of themselves / duplicated silhouette offset downward** | Thickness test too generous — the ray passed *behind* a foreground object and the depth buffer said "hit" | Tighten `thickness`; add the interval test `[zA,zB]` from the DDA (§5.2); add backface rejection. |
| **Reflection detaches from the base of an object** ("floating rock") | Thickness too tight, or the first few march steps are skipped by the origin bias | Reduce start bias; ensure the first sample is ≥1 px out but not more. |
| **Banding: concentric arcs or stripes in the reflection** | Fixed-stride march without jitter | Dither the start offset (§5.7 bias code) and let temporal integrate. |
| **Reflection is noisy/sparkly on wet sand and pops between frames** | Too few rays and no weight-normalised resolve | Frostbite ratio estimator (§5.4). Blotchy dark patches specifically = missing `/= weightSum`. |
| **Reflections smear when the camera turns** | Temporal history reprojected by G-buffer depth instead of reflection depth; or `F·G` applied before temporal | §5.6; apply `EnvBRDF` after temporal (slide 87). |
| **Grazing reflections are an over-blurred smear with no edges** | Cone footprint fitted to the azimuthal lobe width | `specularConeTangent *= lerp(saturate(NdotV*2), 1, sqrt(roughness))` (§5.5). |
| **Whole frame turns mirror-like near the horizon** | Raw Schlick `F` used as the blend weight instead of pre-integrated `EnvBRDF` | §5.8b. |
| **Scene is too bright / highlights blow out with SSR on** | SSR added on top of the material's existing env specular | Substitute, don't add (§5.8a). |
| **2×2 blocky noise that TAA refuses to remove** | Ray reuse across fixed 2×2 quads | Jitter the resolve target pattern temporally (slide 88). |
| **Reflections flicker on distant objects** | Rays too long; sub-pixel geometry aliasing in the reflected image | Limit ray world length (Wronski); prefilter the colour buffer. |
| **The character/player has no reflection** | SSR cannot see backfaces or off-screen geometry | Expected. Cubemap/planar fallback, or accept. |
| **A vignette-like dark ring around the frame** | Fading SSR to black rather than to the fallback | Always mix toward the sky sample (§5.7). |

---

## 8. Suggested pass order for this pipeline

```
1  G-buffer  (view normal, roughness, linear depth, matID)         full res
2  AO prep   (pack normal + linear depth, half res)                half res
3  GTAO      (3 slices x 4 steps, outputs ao + bent normal)        half res
4  AO edge-aware blur (3x3, slope-adjusted depth weights)          half res
5  AO temporal accumulate (own history, alpha 1/8..1/16)           half res
6  Opaque shading: indirect diffuse *= gtaoMultiBounce(ao, albedo)
                   indirect specular *= specularAO(bentNormal, ao, rough) * horizon^2
                   direct sun UNTOUCHED by AO
7  snapshot opaqueRT
8  SSR trace (half res, 1 VNDF ray/pixel, DDA + bisection)          half res
9  SSR resolve (4 neighbour taps, BRDF/pdf weights, normalised)     half res
10 SSR temporal (reflection-depth reprojection, neighbourhood clamp)half res
11 Composite SSR into HDR (apply EnvBRDF here, mix not add)
12 Transparent/water pass (samples ssrTexture and/or traces its own)
13 TAA
14 Bloom / DoF / tonemap / grade
```

---

## 9. Gaps — what I could not verify

* **McGuire & Mara's own GLSL listing.** The JCGT PDF at
  <https://jcgt.org/published/0003/04/04/paper.pdf> is a scanned/compressed image PDF and did
  not yield extractable text in this session. The DDA code in §5.2 is quoted from
  **kode80's Unity port** (BSD, <https://github.com/kode80/kode80SSR>), which is a widely used
  and structurally faithful port, *not* from the paper itself. Verify against the paper before
  treating any specific constant as authoritative.
* **Uludag's GPU Pro 5 chapter text.** Paywalled (O'Reilly / Taylor & Francis). The Hi-Z
  description in §5.2 is assembled from Frostbite's SIGGRAPH 2015 slides (which cite it) and
  from sugulee's independent reimplementation. I did not read the original chapter.
* **Unreal's numeric default AO radius.** I found the parameter and the world-space/view-space
  toggle in Epic's Python API docs but not a verified default value. Do not treat "200" as
  confirmed.
* **Frostbite's SSR slide *notes*.** The .pptx has no speaker notes; slide bullets only. Any
  gap in reasoning between bullets is my inference, not theirs. Specifically: the ordering
  claim in slide 87 ("multiply by FG after temporal") is verbatim, but my explanation of *why*
  (stale view angle in history) is my own reading.
* **`exp2(-16.0 * roughness - 1.0)` and roughness convention.** Filament's listing uses its
  `roughness` symbol; one secondary source
  (<https://gamedev.net/forums/topic/644600-...>, surfaced via search) argues the value driving
  the `pow` "should be glossiness not roughness". I have quoted Filament and the Frostbite
  formula as they are published and cross-checked against a second implementation, but I have
  **not** independently validated which roughness parameterisation Frostbite intended.
* **Optimal `ThinOccluderCompensation` for vegetation.** XeGTAO ships `0.0` as the default and
  clamps to `[0, 0.7]`. My 0.15–0.30 recommendation is reasoning from the beach's vegetation
  content, not a cited value.
* **Bent-normal slice frame in XeGTAO.** XeGTAO builds `localBentNormal` from `directionVec`
  (the raw screen-space slice direction) rather than `orthoDirectionVec` (the view-orthogonal
  one). I believe this is a minor inconsistency in their code rather than an intended
  simplification, but I could not find it discussed anywhere. It matters little because the
  result is normalised.
* **Whether Hi-Z is a loss on this specific scene.** My argument in §5.2 is analytic (grazing
  rays stay inside the min-Z envelope) and matches Frostbite's own decision to use linear
  marching for cheap rays, but I found no published measurement for an outdoor grazing case.
  Measure it if the trace becomes a bottleneck.

---

## 10. Source list

* Jimenez, Wu, Pesce, Jarabo — *Practical Realtime Strategies for Accurate Indirect Occlusion*
  (GTAO/GTSO), Activision ATVI-TR-16-01, 2016.
  <https://iryoku.com/downloads/Practical-Realtime-Strategies-for-Accurate-Indirect-Occlusion.pdf>
  · <https://research.activision.com/publications/archives/atvi-tr-16-01practical-realtime-strategies-for-accurate-indirect-occlusion>
* Intel **XeGTAO** (MIT) — reference implementation, all constants.
  <https://github.com/GameTechDev/XeGTAO>
  (`Source/Rendering/Shaders/XeGTAO.hlsli`, `XeGTAO.h`, `vaGTAO.hlsl`)
* Therrien, Levesque, Gilet — *Screen Space Indirect Lighting with Visibility Bitmask*,
  The Visual Computer 2023. <https://arxiv.org/pdf/2301.11376>
* Google **Filament** documentation and shaders — AO application rules, specular AO,
  horizon occlusion, multibounce, bilateral upsample.
  <https://google.github.io/filament/Filament.md.html> ·
  <https://github.com/google/filament/blob/main/shaders/src/surface_ambient_occlusion.fs>
* Lagarde & de Rousiers — *Moving Frostbite to Physically Based Rendering*, SIGGRAPH 2014.
  <https://seblagarde.wordpress.com/2015/07/14/siggraph-2014-moving-frostbite-to-physically-based-rendering/>
* Stachowiak & Uludag — *Stochastic Screen-Space Reflections*, SIGGRAPH 2015 Advances in
  Real-Time Rendering. <https://advances.realtimerendering.com/s2015/> ·
  <https://www.ea.com/frostbite/news/stochastic-screen-space-reflections> · <https://h3.gd/stochastic-ssr/>
* McGuire & Mara — *Efficient GPU Screen-Space Ray Tracing*, JCGT 3(4), 2014.
  <https://jcgt.org/published/0003/04/04/> ; port: <https://github.com/kode80/kode80SSR>
* Uludag — *Hi-Z Screen-Space Cone-Traced Reflections*, GPU Pro 5 (paywalled);
  independent implementation notes:
  <https://sugulee.wordpress.com/2021/01/19/screen-space-reflections-implementation-and-optimization-part-2-hi-z-tracing-method/>
* Saikia — *Screen Space Reflections in Killing Floor 2*.
  <https://sakibsaikia.github.io/graphics/2016/12/26/Screen-Space-Reflection-in-Killing-Floor-2.html>
* Wronski — *The future of screenspace reflections*.
  <https://bartwronski.com/2014/01/25/the-future-of-screenspace-reflections/>
* Heitz — *Sampling the GGX Distribution of Visible Normals*, JCGT 7(4), 2018.
  <https://jcgt.org/published/0007/04/01/paper.pdf>
* Dupuy & Benyoub — *Sampling Visible GGX Normals with Spherical Caps*, HPG 2023.
  <https://cdrdv2-public.intel.com/782052/sampling-visible-ggx-normals.pdf>
* AMD **FidelityFX SSSR** and Interplay of Light's notes on it.
  <https://gpuopen.com/fidelityfx-sssr/> ·
  <https://interplayoflight.wordpress.com/2022/09/28/notes-on-screenspace-reflections-with-fidelityfx-sssr/>
* Interplay of Light — *Notes on occlusion and directionality in image based lighting*
  (bent normals, directional GTAO).
  <https://interplayoflight.wordpress.com/2021/12/28/notes-on-occlusion-and-directionality-in-image-based-lighting/>
* Jensen, Legakis & Dorsey — *Rendering of Wet Materials*, EGWR 1999.
  <http://graphics.ucsd.edu/~henrik/papers/egwr99/rendering_wet_materials_egwr99.pdf>
* three.js r0.185.1 — `examples/jsm/shaders/GTAOShader.js`, `PoissonDenoiseShader.js`,
  `SSRShader.js`, `postprocessing/GTAOPass.js`.
  <https://github.com/mrdoob/three.js/tree/dev/examples/jsm/shaders>
* Roberts — *The Unreasonable Effectiveness of Quasirandom Sequences* (R2 constants).
  <http://extremelearning.com.au/unreasonable-effectiveness-of-quasirandom-sequences/>

---

## Appendix: notes on the code already in this repo

Read while researching; included because it changes what's worth doing next.

* `src/render/passes/ssao.js` already implements correct GTAO: horizons initialised to
  `±sin(n)`, the exact arc integral, the closed-form bent normal, the `mix(lowH, shc, w)`
  falloff-into-horizon (matching XeGTAO), texel-centre snapping, and it deliberately does not
  clamp per-slice visibility before the temporal average. All four of those are the things
  people usually get wrong. Its documented "flat plane reads 0.84" symptom is handled with a
  ~7° angle bias (`uAngleBias`); that is a legitimate fix at half res but it *is* a bias, so if
  the beach's shallow creases look too bright, that knob is the first suspect.
  Config today: `radius 2.2`, `thickness 0.35`, `falloffStart 0.55`. Against §2.5 the radius is
  on the large side for contact detail (consider 1.2–1.5 m plus a small second pass), and
  `falloffStart 0.55` ≈ XeGTAO's `falloffRange 0.45`, slightly tighter than their 0.615.
* Its thin-occluder line is `cosH = (sCos > cosH) ? sCos : mix(cosH, sCos, uThickness)` — note
  this applies the lerp only on the *decreasing* branch, whereas XeGTAO also lerps the
  increasing branch (`lerp(max(h, shc), shc, c)`). The XeGTAO form is what prevents a single
  grass blade latching the horizon; worth trying.
* `src/render/passes/ssr.js` already does the perspective-correct screen-space DDA with
  1/z interpolation, dither + bisection, a per-hit cone→screen-footprint LOD, five independent
  fades feeding one confidence, sky-cubemap fallback in the correct world direction, and
  `mix` rather than `add`. It has explicitly rejected Hi-Z for the grazing-ray reason in §5.2.
  Gaps against the research: (i) no VNDF importance sampling / no ratio-estimator resolve — it
  appears to be a single mirror-direction ray with roughness expressed purely as blur, which
  costs contact-hardening and per-pixel-normal fidelity; (ii) no grazing-angle cone shrink
  (`specularConeTangent *= lerp(saturate(NdotV*2), 1, sqrt(roughness))`), which at 4° grazing on
  wet sand is likely the largest single quality win available; (iii) the Fresnel weight is
  described as "Schlick, roughness-attenuated (Lagarde)" rather than a pre-integrated
  `EnvBRDF` — see §5.8b.
