# terrain — AAA surface detail for a tropical beach + rocky cliffs, WebGL2 / three r0.185.1

Research brief for the implementer. Everything here is either (a) quoted from a primary
source with the URL inline, (b) derived arithmetic that I show my working for, or
(c) explicitly flagged as unverified opinion. Nothing is cited from memory.

Scene constraints assumed throughout: **eye height 1.7 m**, ground roughly horizontal from
0.5 m to ~200 m, cliffs out to ~1 km, **1080p output**, three.js r0.185.1 (confirmed:
`node_modules/three/package.json` → `0.185.1`), GLSL ES 3.00 (three injects `#version 300 es`).

---

## 0. The two numbers that decide everything else

Before any technique choice, work out what a pixel *is* on this ground. This is plain
trigonometry, done here rather than cited.

Let `Δα` = angular size of one pixel. At 1080 rows and a 55° vertical FOV:

```
Δα = 55° / 1080 = 0.0509° = 0.889 mrad
```

For a horizontal ground plane, eye height `h = 1.7 m`, horizontal distance `d`, slant range
`r = sqrt(d² + h²)`, grazing elevation `sin θ = h / r`:

```
footprint ACROSS the view direction  s_⊥  = r · Δα
footprint ALONG  the view direction  s_∥  = r · Δα / sin θ = r² · Δα / h
anisotropy ratio                     s_∥ / s_⊥ = 1 / sin θ = r / h
```

Evaluated:

| d (m) | r (m) | s_⊥ (mm) | s_∥ (mm) | aniso ratio |
|---|---|---|---|---|
| 1 | 1.97 | 1.8 | 2.0 | 1.2 : 1 |
| 2 | 2.63 | 2.3 | 3.6 | 1.5 : 1 |
| 5 | 5.28 | 4.7 | 15 | 3.1 : 1 |
| 10 | 10.1 | 9.0 | 54 | 6.0 : 1 |
| 20 | 20.1 | 18 | 210 | 12 : 1 |
| **27** | **27.2** | **24** | **390** | **16 : 1** |
| 50 | 50.0 | 44 | 1310 | 29 : 1 |
| 100 | 100 | 89 | 5230 | 59 : 1 |
| 200 | 200 | 178 | 20900 | 118 : 1 |

Two consequences that should drive the whole shader:

**(1) Sand grains are never resolved. Not once, anywhere in frame.**
Medium sand is 0.25–0.5 mm (Wentworth scale). The smallest feature that reads as a feature
needs ≈2 px across, i.e. `2·r·Δα`, which at the closest ground you can see standing (r ≈ 2 m)
is **4.7 mm**. So the finest scale worth putting in an albedo/normal map is ~5 mm — a *clump*,
a *pit*, a *shell fragment* — not a grain. Grains may only enter the shader as **statistics**:
as roughness, as normal-map variance feeding specular AA, and as sparkle. Authoring a
"sand grain" albedo texture at 0.3 mm/texel is pure aliasing fuel; it will read as crawling
noise and nothing else.

**(2) Anisotropic filtering runs out at ~27 m.**
`r/h = 16` at `r = 27.2 m`. Beyond that even 16× aniso (the common hardware cap; get the real
cap from `renderer.capabilities.getMaxAnisotropy()`, three r185
`src/renderers/webgl/WebGLCapabilities.js`) under-filters *across* or over-blurs *along*,
depending on how the driver clamps. **This is exactly the distance at which beach sand goes
to mush in a screenshot.** If your sand looks crisp at your feet and like grey felt at 40 m,
you have not found a shader bug — you have found the aniso cap, and the fix is not more
texture detail, it is *large-scale* detail (dunes, cusps, wet/dry boundary, debris lines)
that survives a 4 cm × 130 cm footprint.

Wind-ripple wavelength on a beach is **~10 cm** (aeolian impact ripples: "about 10–15 cm",
"ripple spacing mostly ranges between a few centimetres and ten centimetres",
<https://geo.libretexts.org/Bookshelves/Sedimentology/Introduction_to_Fluid_Motions_and_Sediment_Transport_(Southard)/12:_Bed_Configurations_Generated_by_Water_Flows_and_the_Wind/12.07:_Wind_Ripples_and_Eolian_Dunes>;
cross-checked against <https://www.pnas.org/doi/10.1073/pnas.1413058111>, which uses the same
order of magnitude and reports crest heights typically under 1 cm). Needing 2 px per half
wavelength, ripples survive in the across direction to `r·Δα < 0.05 m` → **r < 56 m**, and in
the along direction to `r² Δα/h < 0.05` → **r < 9.8 m** unfiltered, extended to ~27 m by 16×
aniso. So: **ripples are a 0–30 m phenomenon.** Past 30 m they must be replaced by a
lower-frequency signal or the surface will simply flatten.

Current codebase note: `src/world/terrain.js` documents a clipmap with 3 cm vertex spacing at
the camera, doubling each ring. Resolving a 10 cm ripple as geometry needs ≥4 samples per
wavelength = 2.5 cm. **Only the innermost block can carry ripples as real displacement**;
ring 1 (6 cm) already aliases them. Everything past ~the first ring must get ripples from a
normal map or POM.

---

## 1. Killing tiling repetition

### 1.1 Why naive random-offset tiling loses contrast — the actual math

Heitz & Neyret 2018, §3.1 (<https://inria.hal.science/hal-01824773/>, PDF at
<https://hal.inria.fr/hal-01824773/document>). Blend N independent samples `X₁..X_N` of the
same texture with weights `w₁..w_N`, `Σwₙ = 1`:

```
E[X_lin]   = E[X]                                  (Eq. 4 — mean is preserved)
cov[X_lin] = W² · cov[X],   W = sqrt(Σ wₙ²)        (Eq. 5, 6 — variance is NOT)
H_lin(X)   = H₁ ∗ … ∗ H_N                          (Eq. 7 — histogram gets convolved)
```

Independently confirmed by Burley 2019 JCGT 8(4) Eq. 2
(<http://jcgt.org/published/0008/04/02/>): "The convolution of linearly blended Gaussian
distributions is a Gaussian distribution with reduced variance … `W = sqrt(w₁² + … + w_N²)`."

So contrast is scaled by `W`, and `W < 1` everywhere except where one weight is 1.

**Worked example against the code already in this repo.** `TILEBREAK_GLSL` in
`src/gfx/glsl/noise.js` blends 4 taps with bilinear weights
`w = (1-|f.x-i|)(1-|f.y-j|)`. At a cell **corner** (`f = (0.5,0.5)`) all four weights are
0.25, so `W = sqrt(4 · 0.0625) = 0.5` — **contrast is exactly halved**. At a cell **centre**
(`f → (0,0)`) one weight is 1 and `W = 1` — full contrast. The result is a **soft
checkerboard of low-contrast blotches on a 1-tile lattice**, i.e. you traded a visible
repeating texture for a visible repeating *softness*. That is the classic symptom and it is
worse, not better, on sand, because sand is nearly featureless and the eye locks onto the
low-frequency contrast modulation instantly.

Heitz's other two complaints (§3.1) are equally visible: the convolved histogram
"might contain new colors that were not present in the original data" (a greenish or greyish
tone appearing between two tiles that both look sandy), and "ghosting" — two copies of the
same recognisable feature faintly superimposed.

### 1.2 Fix A (cheap, recommended): the variance-preserving rescale

Heitz Eq. 8: rescale around the mean.

```
X_cov = ( Σ wₙ (Xₙ − E[X]) ) / W  +  E[X],      W = sqrt(Σ wₙ²)
```

This restores mean (Eq. 9) and covariance (Eq. 10) exactly. It is *exactly*
histogram-preserving only if the input is Gaussian (Eq. 13). For anything else "it overshoots
(it creates too dark and too bright pixels)" — Heitz §3.2 Discussion. On 8-bit textures the
overshoot **clips**, and Burley §3 and §7 devote the paper to that: clipping shows up as
**flat white or flat black speckles that appear only near tile boundaries**.

Practical: this is one `mix`/divide. If you do nothing else, do this. Use `E[X]` = the mean
colour of the source texture, uploaded as a `uniform vec3` (compute it in JS once from the
image data; do **not** use the top mip, which is only equal to the mean if the texture is
power-of-two square and you trust the driver's box filter).

### 1.3 Fix B (correct, expensive to set up): full histogram-preserving blending

Heitz & Neyret, Algorithm 1 (paper §5.4), quoted verbatim from the PDF:

```
get triangle vertices v1,v2,v3 and weights w1,w2,w3 at uv
uv1 = uv + hash(v1);  uv2 = uv + hash(v2);  uv3 = uv + hash(v3)
duvdx = dFdx(uv);  duvdy = dFdy(uv)
G1 = texture2DGrad(texGaussian, uv1, duvdx, duvdy)      # and G2, G3
Gcov = ( w1·G1 + w2·G2 + w3·G3 − (½,½,½) ) / sqrt(w1²+w2²+w3²)  + (½,½,½)
U    = ½ + ½ erf( (Gcov − ½) / ( (1/6)·√2 ) )
X    = texture3D(lookUpTable, U)
```

Offline you build two things:
- `texGaussian` — the input image, pixel-permuted by 3D optimal transport so its histogram is
  a 3D Gaussian with mean ½ and **σ = 1/6** per channel (paper §4.2, Eq. 20:
  `G = ½ + (1/6)√2 · erfinv(2U − 1)`). σ = 1/6 is independently confirmed by Burley:
  "We use the recommended σ = 1/6 from Heitz and Neyret."
- `lookUpTable` — a **32³** RGB LUT (paper: "We always use a 32³ look-up table"), which is
  adequate because the inverse-transform parameterisation is area-preserving, so "the look-up
  table has no dead spots."

Cost: 3 texture fetches + 1 LUT fetch. Heitz measured **0.11 ms at 1920×1080 on a GTX 980**
for the no-LUT (already-Gaussian input) case and **0.29 ms** for the full case, with a 256²
input. Memory 197 KB / 295 KB respectively.

**My assessment (opinion, not from a source):** for a beach you do not need this. The 3D
optimal-transport preprocess is minutes per texture (Heitz: "several minutes for a 256×256
texture") and it must be run in your asset pipeline, and it **forbids randomised per-tile
rotation** (see §1.5). Sand and weathered rock are close to Gaussian-ish unimodal already.
Go with §1.4.

### 1.4 Fix C (what to actually ship): Mikkelsen's hex-tiling

Morten S. Mikkelsen, *Practical Real-Time Hex-Tiling*, JCGT 11(2), 2022 —
<https://jcgt.org/published/0011/03/05/> (paper PDF
<https://jcgt.org/published/0011/03/05/paper-lowres.pdf>, demo
<https://github.com/mmikk/hextile-demo>). This drops histogram preservation entirely and
replaces it with (a) exponentiated weights, (b) a data-driven weight modulation, and (c) an
S-curve gain on the weights. It samples the **original** texture, so it drops into an existing
material with no preprocessing.

Verbatim from the paper (Eq. 1, 3, 4, 5 and Listings 1–8):

```
w'ᵢ = δ(xᵢ)·wᵢ^γ / Σⱼ δ(xⱼ)·wⱼ^γ                                     (Eq. 1)

for derivative/normal data:   δ_N(xᵢ) = (1−β) + β·sqrt( ‖xᵢ‖² / (1+‖xᵢ‖²) )   (Eq. 3)
for colour data:              δ_C(xᵢ) = (1−β) + β·( xᵢ · (0.299,0.587,0.114) ) (Eq. 4)

Perlin/Hoffert gain, applied to the normalised weights:
    k = log(1−r)/log(0.5)
    g(x) = ½(2x)^k                 if x < 0.5
         = 1 − ½(2−2x)^k           if x ≥ 0.5
```

**Parameter values, straight from §3 and §4 of the paper:**

| symbol | value | meaning |
|---|---|---|
| `γ` (`g_exp`) | **7** | weight exponent. Higher → hex tiles read as a hard blend mask instead of a cross-fade; kills ghosting, risks visible hex seams. |
| `β` (`g_fallOffContrast`) | **0.6** | how much the *content* modulates the weight. `δ ∈ [1−β, 1]`. Lets the steeper/brighter tile win the transition, which "diffuses" the seam so it doesn't follow the hex edge. |
| `r` (colour/roughness) | **0.65 – 0.75** | S-curve gain. Paper: "a conservative choice is in the range r ∈ [0.65, 0.75]"; figures use 0.75. `r = 0.5` is a no-op. Higher r = more contrast, harder hex edges. |
| `r` (normal maps) | **0.5** (disabled) | "the ramp is disabled for normal maps at r = 0.5" |

**GLSL ES 3.00 port.** The paper is HLSL. Two porting traps: HLSL `mul(M, v)` equals GLSL
`v * mat(same args)`, and HLSL `mul(v, M)` equals GLSL `mat(same args) * v`, because HLSL's
`float2x2(a,b,c,d)` is row-major and GLSL's `mat2(a,b,c,d)` is column-major. I have written
the skew/unskew out longhand below so this cannot go wrong.

```glsl
// ---- hex lattice -------------------------------------------------------
const float HEX_S = 3.46410162;   // 2*sqrt(3)

void triangleGrid(out vec3 w, out ivec2 v1, out ivec2 v2, out ivec2 v3, vec2 st)
{
  st *= HEX_S;
  // skew into the simplex lattice: mul(float2x2(1,-0.57735027, 0,1.15470054), st)
  vec2 sk = vec2(st.x - 0.57735027 * st.y, 1.15470054 * st.y);

  ivec2 baseId = ivec2(floor(sk));
  vec3  t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;

  float s  = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;

  w  = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  v1 = baseId + ivec2(int(s), int(s));
  v2 = baseId + ivec2(int(s), 1 - int(s));
  v3 = baseId + ivec2(1 - int(s), int(s));
}

vec2 hexCenST(ivec2 v)   // inverse skew, /(2*sqrt(3))
{
  vec2 f = vec2(v);
  return vec2(f.x + 0.5 * f.y, 0.86602540 * f.y) / HEX_S;
}

mat2 hexRot(ivec2 idx, float rotStrength)
{
  float a = abs(float(idx.x * idx.y)) + abs(float(idx.x + idx.y)) + 3.14159265;
  a = mod(a, 6.28318531);
  if (a > 3.14159265) a -= 6.28318531;
  a *= rotStrength;
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);      // standard CCW; M*v rotates by +a, v*M by −a
}

vec3 gain3(vec3 x, float r)      // Listing 8
{
  float k = log(1.0 - r) / log(0.5);
  vec3 s = 2.0 * step(vec3(0.5), x);
  vec3 m = 2.0 * (1.0 - s);
  vec3 res = 0.5 * s + 0.25 * m * pow(max(vec3(0.0), s + x * m), vec3(k));
  return res / max(res.x + res.y + res.z, 1e-6);
}

// ---- colour / roughness / AO -------------------------------------------
vec4 hexTexture(sampler2D tex, vec2 st, float rotStrength, float r)
{
  vec2 dSTdx = dFdx(st), dSTdy = dFdy(st);

  vec3 w; ivec2 v1, v2, v3;
  triangleGrid(w, v1, v2, v3, st);

  mat2 R1 = hexRot(v1, rotStrength);
  mat2 R2 = hexRot(v2, rotStrength);
  mat2 R3 = hexRot(v3, rotStrength);

  vec2 c1 = hexCenST(v1), c2 = hexCenST(v2), c3 = hexCenST(v3);
  vec2 st1 = (st - c1) * R1 + c1 + hash22(vec2(v1));
  vec2 st2 = (st - c2) * R2 + c2 + hash22(vec2(v2));
  vec2 st3 = (st - c3) * R3 + c3 + hash22(vec2(v3));

  vec4 c_1 = textureGrad(tex, st1, dSTdx * R1, dSTdy * R1);
  vec4 c_2 = textureGrad(tex, st2, dSTdx * R2, dSTdy * R2);
  vec4 c_3 = textureGrad(tex, st3, dSTdx * R3, dSTdy * R3);

  const vec3 Lw = vec3(0.299, 0.587, 0.114);
  vec3 Dw = vec3(dot(c_1.rgb, Lw), dot(c_2.rgb, Lw), dot(c_3.rgb, Lw));
  Dw = mix(vec3(1.0), Dw, 0.6);            // beta = 0.6
  vec3 W = Dw * pow(w, vec3(7.0));         // gamma = 7
  W /= (W.x + W.y + W.z);
  if (r != 0.5) W = gain3(W, r);

  return W.x * c_1 + W.y * c_2 + W.z * c_3;
}
```

For **normal maps**, Mikkelsen blends *partial derivatives*, not normals, because "the
derivative is a linear operator, which means that by blending the partial derivatives, the
obtained result is equivalent to blending directly from the height map." Listings 9/10:

```glsl
vec2 tspaceNormalToDerivative(vec3 vM)   // vM in [-1,1]
{
  const float scale = 1.0 / 128.0;
  vec3  vMa  = abs(vM);
  float z_ma = max(vMa.z, scale * max(vMa.x, vMa.y));   // clamps deriv to [-128,128]
  const bool gFlipVertDeriv = false;
  float s = gFlipVertDeriv ? -1.0 : 1.0;
  return -vec2(vM.x, s * vM.y) / z_ma;
}
```
and the per-tile weight uses Eq. 3 (`D = dot(dᵢ,dᵢ); Dw = sqrt(D/(1+D))`), the three sampled
derivatives are rotated **forward** (`dᵢ = Rᵢ * dᵢ`) before blending, and the final normal is
`normalize(vec3(-deriv.xy, 1.0))`.

**Hex cell size — the number nobody prints.** Derive it: after `st *= 2√3` the lattice is
unit-spaced in skewed space, and `hexCenST` divides by `2√3`, so adjacent hex centres are
`1/(2√3) = 0.2887` **UV units** apart. That is **2√3 ≈ 3.46 hexagons per texture repeat**
along each lattice direction. So if you drive it with `st = worldXZ / 2.0` (a 2 m texture
repeat), your hexagons are **0.58 m flat-to-flat**. Tune `st` scale so the hex is *larger*
than the biggest recognisable feature in the texture, or you will chop features in half.
For beach sand at 2 m repeat this is fine; for a cliff texture with 1 m boulders in it, it is
not — use a 4–6 m repeat there.

### 1.5 The gotchas that will bite you

**`textureGrad` is not optional.** The random offsets break `dFdx(uv)` across a hex boundary,
which the hardware would read as a huge footprint → a **1-pixel-wide blurred line tracing the
hex edges** across your whole beach. Heitz §5.4: "these screen-space derivatives are broken by
the random offsets if neighbouring pixels are not in the same triangle. To avoid this problem,
we compute the derivatives of `uv` before adding the random offsets and we pass them
explicitly." `textureGrad` is core ES 3.00 and is legal inside non-uniform control flow
(unlike `texture()` with implicit LOD), so it is also the right call inside your material
branches.

**Hash precision at 1 km is a real failure, not a theoretical one.** `hash22` in
`src/gfx/glsl/noise.js` is Dave-Hoskins style (`fract(p * 0.1031)` …). With `st = worldXZ/2`
and world coords out to ±1400 m (`PROFILE` in `terrain.js` runs to z = −1400), `st` reaches
700 and hex vertex ids reach ~2400. `fract(2400 * 0.1031)` = `fract(247.44)` — of the ~7
significant decimal digits in fp32 you have burned 3 on the integer part, leaving ~4 for the
fraction. Adjacent vertex ids start producing **correlated** offsets. Visually: a broad region
of the far beach where the tile-break stops working and the base texture repeat comes back,
often as diagonal banding. Mikkelsen's own `hash()` (Listing 2) uses
`frac(sin(...)*43758.5453)` and is *worse* — `sin` of a large argument on a mobile/ANGLE fp32
path is close to noise, and on some drivers is fast-pathed to garbage. **Fix:** either
(a) recentre `st` on a camera-following integer origin each frame, or (b) hash the `ivec2`
with integer ops, which ES 3.00 gives you natively:

```glsl
vec2 hashI2(ivec2 p) {
  uvec2 q = uvec2(p) * uvec2(1597334673u, 3812015801u);
  q = (q.x ^ q.y) * uvec2(1597334673u, 3812015801u);
  return vec2(q) * (1.0 / float(0xffffffffu));
}
```
(I have not benchmarked this specific integer hash against the paper's; the *class* of fix —
integer hashing instead of `fract(sin())` — is standard practice and is why ES 3.00's uint
support matters here. Treat the exact constants as replaceable.)

**Rotation is incompatible with histogram preservation.** Mikkelsen §3: "this feature is only
possible with normal maps when histogram preservation is disabled … when histogram
preservation is used, the directionality is unknown until blending has already taken place."
Rotation is what kills the last of the repetition when the texture has oriented features —
pebbles all lying the same way, ripple crests all parallel. On a beach, ripples *should* be
parallel (wind-aligned), so use `rotStrength = 0` for the ripple layer and `rotStrength ≈ 1`
for the cobble/shell/gravel layer.

**Cost.** 3 taps per map. If you hex-tile albedo + normal + roughness that is 9 taps, with
aniso on, at grazing angles, over a full screen of beach. **Do not hex-tile everything.**
My recommendation (opinion): hex-tile the *normal* map only (Mikkelsen's own emphasis: "we
emphasize the use case of normal maps in our work"), and break the albedo with a
multiply-by-low-frequency-noise macro variation (§3.4) which costs one cheap tap. Albedo
repetition on sand is far less visible than normal-map repetition, because sand albedo is
nearly flat and it is the *shading* that carries the pattern.

**When to switch it off.** Once the pixel footprint exceeds the hex cell, all three taps land
in the same mip and return the same colour; the blend is a no-op and you are paying 3× for
nothing. Heitz notes this is also why there's no aliasing from the grid: "as the pixel-footprint
size becomes larger than the size of the tile, the MIPmapped content of the fetched texture
becomes a constant color and the result is the same whatever the values of the blending
weights." Gate on `textureQueryLod` (ES 3.00 does **not** have `textureQueryLod`; use your own
`log2(max(length(dSTdx), length(dSTdy)) * texSize)`) and fall back to a plain `textureGrad`
past ~mip 5. Saves 6 taps on most of the screen.

---

## 2. Detail at grazing angles

### 2.1 What POM actually is (the equations)

Natalya Tatarchuk, *Practical Parallax Occlusion Mapping for Highly Detailed Surface
Rendering*, GDC 2006 / SIGGRAPH 2006 course —
<https://advances.realtimerendering.com/s2006/Tatarchuk-POM.pdf>.

Core loop:
1. Compute the **parallax offset vector** `P` in tangent space: the maximum texture-space
   displacement for this pixel, `P = (V_ts.xy / V_ts.z) · height_scale` (this is the standard
   form; Tatarchuk's slides describe it as "the maximum visual offset in texture-space").
2. **Linear search only** along `P`, sampling the height field at step `δ`, testing pairs of
   endpoints against the current horizon.
3. When a pair straddles the ray, **intersect the ray with the linear segment** rather than
   taking the nearest sample. This is the whole point of the paper: "we perform actual line
   intersection computation for the ray and the linear section of the approximated height
   field … this allows us to preserve perspective-correct depth even at oblique angles as well
   as display very little or none aliasing."

**Adaptive sample count — verbatim from the slides:**

```
n = n_min + (N̂ · V̂_ts) · (n_max − n_min)
```

with the stated shipping range **8 to 50 samples** ("1100 polygons with parallax occlusion
mapping (8 to 50 samples used)"). Note the sign: `N·V → 1` (face-on) gives `n_max`. Read the
slide text, not the formula, to get the intent right — "we take more samples when the surface
is viewed at steep grazing angles, where more samples are desired." **The published formula
as printed gives the opposite**, so either the slide has a sign slip or `N̂·V̂` there means
something other than the usual cosine. Implement it as
`n = mix(n_max, n_min, saturate(dot(N, V)))` — more samples at grazing — because that is what
the surrounding paragraph asks for. *(Flagging this explicitly: I could not resolve the
discrepancy from the slide deck alone, and I did not find a second source that restates the
formula. Do not trust the printed sign.)*

**Self-shadowing.** Same ray-march, run from the intersection point toward the light. Hard
shadows (Policarpo-style "is the first blocker above me") "can result in shadow aliasing
artifacts." Tatarchuk's soft version: keep marching past the first blocker "until we reach the
next fully visible point on the surface," then "compute the visibility coefficient by scaling
the contribution of each sample by the distance from the reference sample." Result: closer
blockers → tighter penumbra, which is the physically right behaviour and, importantly, "well-
behaved soft shadows without any edge aliasing."

**LOD.** Tatarchuk's explicit scheme: compute the mip level in the fragment shader; below a
threshold mip render with plain normal mapping; above it scale `n` with mip level; in the
transition band **lerp the POM result against the normal-mapped result using the fractional
part of the mip level**. Do this. Without it POM's cost is unbounded and its aliasing is
unbounded.

### 2.2 Does POM actually earn its keep on this beach? Numbers.

Ripple amplitude ≈ 8 mm (crest heights "typically less than 1 cm", PNAS/LibreTexts above),
wavelength 10 cm.

Parallax displacement at the surface = `amplitude / tan(elevation)`. At d = 10 m, h = 1.7 m:
`tan(elev) = 0.171`, so the crest appears shifted by `8 mm / 0.171 = 47 mm` — **almost half a
ripple wavelength**. A normal map cannot express that; it will render ripple *shading* in the
wrong place, and worse, the shading will not move with the camera. So the parallax is real and
large in exactly the band where you can still see ripples.

But from §0, ripples stop being resolved (along-view) past ~10 m unfiltered / ~27 m with
16× aniso. Combine:

> **POM on sand ripples pays for itself from roughly 1.5 m to 8 m, is marginal 8–20 m, and is
> wasted past ~25 m.** Inside 1.5 m the parallax is small (at 1 m, elev = 59.5°, shift =
> 8/1.70 = 4.7 mm, sub-pixel-ish) *and* the clipmap's 3 cm inner block is already carrying
> the ripple as geometry. Past 25 m the aniso filter has already erased the ripple.

That is a narrow band. My recommendation (opinion): **do not build a general POM path.**
Build a cheap 8–16 step POM that is enabled only when `mip < threshold` **and** the material
is sand **and** `dot(N,V) < 0.5`, and lerp it out with mip fraction as Tatarchuk describes.
The whole thing is then off for >90% of the screen.

### 2.3 POM's grazing-angle failure modes, and displacement as the alternative

At true grazing on a **horizontal** plane (which is the beach, always), POM is at its worst:
the offset vector `V.xy/V.z` blows up as `V.z → 0`, the march covers many wavelengths of the
height field per step, and no sample count saves it. Symptoms in §6.

The honest alternative, and the one this project is already set up for: **the ripples are
geometry.** `src/world/terrain.js` runs a CDLOD clipmap at 3 cm inner spacing. If you push the
ripple field into the vertex displacement (it already displaces — the doc comment names "wind
ripples" as one of the noise layers) and let the CDLOD morph fade it out with level spacing,
you get correct silhouette, correct self-shadow (from the CSM), correct parallax, and zero
fragment cost, over the 0–3 m band. Then hand off to a **normal map** for 3–30 m and to
**nothing** past 30 m. That is a cleaner and cheaper split than POM, and it is what the
existing architecture wants.

**Ripple self-shadowing only reads at low sun.** Shadow length = `amplitude / tan(sun
elevation)`. At 8 mm amplitude: sun 20° → 22 mm shadow = 22% of the wavelength, clearly
visible as dark bands on the lee side. Sun 45° → 8 mm = 8%, marginal. Sun 60° → 4.6 mm = 5%,
invisible. **If the scene's sun is above ~40°, ripple self-shadowing is not worth a single
instruction.** Check `time.state` before you build the feature.

---

## 3. Multi-scale detail composition

### 3.1 The rule: each scale must fade out at its own footprint

The reason one scale "dominates" is almost always that scales are summed with fixed amplitudes
and the small ones keep contributing after they've become sub-pixel noise. A sub-pixel scale
does not read as detail; it reads as **variance**, and variance in a normal map reads as
*aliasing* in the specular and as *flattening* in the diffuse. So:

```
weight_k = 1 − smoothstep(0.5, 1.0, pixelFootprint / wavelength_k)
```
where `pixelFootprint` is the **anisotropic max**, `max(s_⊥, s_∥)` from §0 (compute it as
`max(length(dFdx(worldPos)), length(dFdy(worldPos)))`). Two texels per wavelength is Nyquist;
fade between 1 and 2 texels. Each octave then has a distance at which it politely leaves.

Suggested scale ladder for this scene (my proposal, calibrated against §0's table — not from a
source):

| scale | wavelength | carried by | alive from → to |
|---|---|---|---|
| micro roughness | 0.2–0.5 mm | **roughness value + specular AA only**, never a texture | everywhere |
| grain clumps / shell chips | 5–20 mm | albedo + normal detail map | 0 → 4 m |
| wind ripples | 10 cm | vertex displacement 0–3 m; normal map 3–30 m | 0 → 30 m |
| footprints / swash marks / cobbles | 0.2–1 m | normal + albedo, hex-tiled | 0 → 120 m |
| beach cusps / berm / drift lines | 3–20 m | vertex displacement + albedo macro | 0 → 600 m |
| dunes / cliff massing | 30–300 m | heightfield geometry | all |

Note there is no gap and no overlap of more than one octave. If two consecutive rows differ by
more than ~8× in wavelength you will see a **scale hole** — a distance band where the surface
looks synthetically smooth. On a beach that band is usually 1–3 m and it reads as "the sand
near my feet looks like carpet."

### 3.2 Compose scales as *derivatives*, not as normals

This is the single most important structural decision and it is well-sourced. Mikkelsen,
*Surface Gradient–Based Bump Mapping Framework*, JCGT 9(3), 2020 —
<http://jcgt.org/published/0009/03/04/> — and restated in the hex-tiling paper §2.1: the
tangent-space normal is just the normalised `(−∂H/∂u, −∂H/∂v, 1)`, and

```
n = (−∂H/∂u, −∂H/∂v, 1) / sqrt(1 + (∂H/∂u)² + (∂H/∂v)²)          (Eq. 2)
```

so **derivatives add linearly and normals do not.** Convert every detail normal map to a
derivative with `tspaceNormalToDerivative` (§1.4), **sum the derivatives with per-scale
amplitudes**, then convert once at the end:

```glsl
vec2 d = vec2(0.0);
d += w_clump  * amp_clump  * sampleDeriv(tClump,  uv0, ...);
d += w_ripple * amp_ripple * sampleDeriv(tRipple, uv1, ...);
d += w_cobble * amp_cobble * sampleDeriv(tCobble, uv2, ...);   // hex-tiled
vec3 nTS = normalize(vec3(-d, 1.0));
```

Why this matters visually: if you instead `normalize(nA + nB)` (the common "UDN"/"whiteout"
detail hack) the *slope* of the combined surface is systematically **under**stated wherever
both maps are steep, so the more detail layers you add the flatter the surface gets. Sum the
derivatives and a 30°-slope ripple carrying a 20°-slope clump gives you a ~45° slope, which is
correct. **This is also what makes the amplitudes meaningful** — `amp_k` is literally
`(height_k / wavelength_k)` in the same units, so you can *dial the ladder physically*:
8 mm on 100 mm ripples → `amp = 0.08`.

Guard the magnitude: `d` can grow past what a normal can express. Mikkelsen's own
`z_ma = max(|vM.z|, (1/128)·max(|vM.x|,|vM.y|))` clamp bounds each layer's derivative to
±128, which is plenty; clamp the *sum* to something sane like ±8 (slope 83°) so a stacking
accident can't invert the normal.

### 3.3 Feed the discarded scales into roughness (do not just throw them away)

When a scale fades out under §3.1, its variance has to go **somewhere** or the surface will get
shinier as it recedes — the classic wrong behaviour. Selfshadow's write-up
(<https://blog.selfshadow.com/2011/07/22/specular-showdown/>) is blunt about the naive fix:
"scaling down bumpiness … is really wrong though, as it gives us the opposite of what we want:
rather than a bumpy surface looking duller when further from the camera, flattening the normal
map leads to a more glossy appearance!"

Two mechanisms, both cited:

**(a) Toksvig, for texture-borne variance.** From the same page (quoting Toksvig 2004):
```
f_t   = |N_a| / (|N_a| + s·(1 − |N_a|))                # Toksvig factor, Blinn-Phong exponent s
σ²_toksvig = (1 − |N_a|) / |N_a|
p     = s / (1 + s·σ²)                                 # filtered exponent
```
`N_a` is the **un-normalised** averaged normal from the mip. Critical caveat also from that
page: "you can't use it with two-component input normals, such as 3Dc and (typically) DXT5 …
it's no good trying to do this with encodings that reconstruct a unit vector." In WebGL2 with
RGB(A) normal maps this is fine, but **any renormalise-on-load step destroys it**. Better,
per the same article: bake a *Toksvig map* offline from a Gaussian-filtered mip chain and ship
it as an extra gloss channel — it compresses well and is immune to the precision issue.

**(b) Tokuyoshi & Kaplanyan geometric specular AA, for geometry- and displacement-borne
variance.** *Improved Geometric Specular Antialiasing*, I3D 2019 —
<https://www.jp.square-enix.com/tech/library/pdf/ImprovedGeometricSpecularAA.pdf>,
DOI <https://doi.org/10.1145/3306131.3317026>. Eq. 4 and Listing 2, verbatim:

```
ᾱ² = α² + min( 2σ²(‖Δn_u‖² + ‖Δn_v‖²), κ ),      κ = 0.18
```
```hlsl
float3 dndu = ddx(normal), dndv = ddy(normal);
float variance = SIGMA2 * (dot(dndu,dndu) + dot(dndv,dndv));
float kernelRoughness2 = min(2.0 * variance, KAPPA);
float filteredRoughness2 = saturate(roughness2 + kernelRoughness2);
```
`α` is GGX roughness (i.e. `roughness²` in the Disney/three parameterisation — mind the
squaring convention, `α = roughness²`), `κ = 0.18` is "the clamping threshold used in
Kaplanyan et al." and `SIGMA2` is the screen-space filter variance (Kaplanyan's value is
0.25 for a box-ish half-pixel kernel; **I did not find `SIGMA2`'s numeric value stated in this
paper** — treat 0.25 as a starting point and tune, and flag it in code as unverified).

This is ~6 ALU in the fragment shader, uses **world-space** normals (no tangent frame needed),
and is the single highest-value line of code for a beach at sunset. Add it.

### 3.4 Macro variation — the cheapest anti-repetition there is

Multiply albedo by a very low frequency signal so the *beach* has slow tonal drift over metres.
Two independent frequencies, both far below anything a texture carries:

```glsl
float m = 0.5 + 0.5 * gnoise2(worldXZ * 0.06);        // ~16 m period
float n = 0.5 + 0.5 * gnoise2(worldXZ * 0.011);       // ~90 m period
albedo *= mix(0.88, 1.12, m) * mix(0.93, 1.07, n);
```
±12% and ±7% — "macro variation should be barely perceptible but cumulative" is the standard
advice (e.g. Terrain3D's shader-design notes,
<https://terrain3d.readthedocs.io/en/latest/docs/shader_design.html>). Push past ±20% and it
stops reading as sand and starts reading as a stain. Also drive **roughness** with the same
field at half the amplitude: real beaches vary in moisture and packing, and roughness variation
is far more visible under a low sun than albedo variation.

---

## 4. Cliffs: triplanar, slope/altitude blending, height blending

### 4.1 Triplanar weights

Both iq and Golus give the same core; I'll cite both since it's load-bearing.

iq, <https://iquilezles.org/articles/biplanar/>:
```glsl
vec4 boxmap( in sampler2D s, in vec3 p, in vec3 n, in float k ) {
  vec4 x = texture( s, p.yz );
  vec4 y = texture( s, p.zx );
  vec4 z = texture( s, p.xy );
  vec3 w = pow( abs(n), vec3(k) );
  return (x*w.x + y*w.y + z*w.z) / (w.x + w.y + w.z);
}
```
Golus, <https://github.com/bgolus/Normal-Mapping-for-a-Triplanar-Shader> (`TriplanarWhiteout.shader`):
```hlsl
half3 triblend = pow(abs(i.worldNormal), 4);
triblend /= max(dot(triblend, half3(1,1,1)), 0.0001);
```
**k = 4** is Golus's shipped value. The repo's existing `triWeights` comment says "sharp 4..12".
Interpretation: `k` controls the width of the cross-fade band. `k = 4` gives a wide, soft
transition (good for organic rock, hides seams); `k ≥ 8` gives a narrow band (good when the
texture has directional features that must not ghost). For sea cliffs, **k = 4–6**.

**Golus's projection-correction step** — this is the part everyone omits and then wonders why
the far side of a rock looks mirrored:
```hlsl
half3 axisSign = i.worldNormal < 0 ? -1 : 1;
uvX.x *=  axisSign.x;
uvY.x *=  axisSign.y;
uvZ.x *= -axisSign.z;
```
and the same sign flip applied to `tnormalX.x`, `tnormalY.x`, `tnormalZ.x`.

**Whiteout normal blend**, verbatim from that shader:
```hlsl
tnormalX = half3(tnormalX.xy + i.worldNormal.zy, tnormalX.z * i.worldNormal.x);
tnormalY = half3(tnormalY.xy + i.worldNormal.xz, tnormalY.z * i.worldNormal.y);
tnormalZ = half3(tnormalZ.xy + i.worldNormal.xy, tnormalZ.z * i.worldNormal.z);
half3 worldNormal = normalize(
    tnormalX.zyx * triblend.x +
    tnormalY.xzy * triblend.y +
    tnormalZ.xyz * triblend.z);
```
Note this project's `TRIPLANAR_GLSL` uses `abs(nx.z) * n.x` where Golus uses `tnormalX.z * worldNormal.x`.
Taking `abs()` of the tangent-space Z (which is ≥0 anyway for a valid normal map) then
multiplying by the signed world normal component is equivalent to Golus's version **only
because** `tnormal.z ≥ 0` — so the `abs()` is harmless but redundant, *and* the repo version is
missing the `axisSign` UV/x-component flip above. Add it, or back-facing rock faces will show
mirrored normal detail (visible as lighting that runs the wrong way across a rock's shadowed
side).

Golus also documents **RNM (Reoriented Normal Mapping)** as "more expensive than GPU Gems 3 or
Whiteout, but looks great," and states "Whiteout is ground truth for axis aligned walls like
the straight swizzle technique." Since a sea cliff is mostly *not* axis-aligned, RNM is the
quality option; Whiteout is the right default.

### 4.2 Biplanar: 2 taps instead of 3

iq's alternative, verbatim from <https://iquilezles.org/articles/biplanar/>:
```glsl
vec4 biplanar( sampler2D sam, in vec3 p, in vec3 n, in float k ) {
  vec3 dpdx = dFdx(p), dpdy = dFdy(p);
  n = abs(n);
  ivec3 ma = (n.x>n.y && n.x>n.z) ? ivec3(0,1,2) : (n.y>n.z) ? ivec3(1,2,0) : ivec3(2,0,1);
  ivec3 mi = (n.x<n.y && n.x<n.z) ? ivec3(0,1,2) : (n.y<n.z) ? ivec3(1,2,0) : ivec3(2,0,1);
  ivec3 me = ivec3(3) - mi - ma;
  vec4 x = textureGrad( sam, vec2(p[ma.y],p[ma.z]),
                        vec2(dpdx[ma.y],dpdx[ma.z]), vec2(dpdy[ma.y],dpdy[ma.z]) );
  vec4 y = textureGrad( sam, vec2(p[me.y],p[me.z]),
                        vec2(dpdx[me.y],dpdx[me.z]), vec2(dpdy[me.y],dpdy[me.z]) );
  vec2 w = vec2(n[ma.x], n[me.x]);
  w = clamp( (w-0.5773)/(1.0-0.5773), 0.0, 1.0 );   // local support
  w = pow( w, vec2(k/8.0) );                         // shape transition
  return (x*w.x + y*w.y) / (w.x + w.y);
}
```
`0.5773 = 1/√3` is exactly the normal component at the triple point where all three axes tie.
iq's own caveat: "it has some singularities that could in some cases perhaps produce visually
unpleasant results," fixable by remapping weights at the cost of narrowing the blend band.
**33% fewer taps.** If you are hex-tiling on top of triplanar you are at 3×3 = 9 taps per map;
biplanar takes that to 6. That is the difference between shipping and not.

### 4.3 Slope- and altitude-driven material assignment

No paper needed; state the remaps explicitly so they're tunable and physical.

```glsl
float slope   = 1.0 - N.y;                     // 0 flat, 1 vertical
float altitude = worldPos.y;                   // metres, sea level = 0

// sand cannot rest above its angle of repose (30-35 deg for dry sand)
// N.y = cos(slope). cos(30 deg)=0.866, cos(34 deg)=0.829, cos(38 deg)=0.788
float sandMask = smoothstep(0.788, 0.866, N.y);   // 0 on steep rock, 1 on flat sand
```
Angle of repose for dry sand is **30–35°** (it is the same physics that sets an aeolian
ripple's lee slope, cited in §2.2's sources as the avalanche angle). So: **any surface steeper
than ~34° should not be sand.** That single rule does more for believability than any texture,
because the eye knows it. Use `N.y > cos(34°) = 0.829` as the hard sand ceiling with a
smoothstep band of ±4°.

Altitude bands for a tropical beach:
```
y < -0.1 m          : submerged / permanently wet, algae tint
-0.1 .. +0.15 m     : swash zone — wet sand, darkest, smoothest, sheen
+0.15 .. +0.6 m     : damp sand, intermediate
+0.6 .. berm        : dry sand
above berm, slope>34: rock
```
Do **not** drive the wet/dry boundary purely by altitude — drive it by
`altitude − tideLevel − waveRunup(worldXZ, t)` with a noisy runup term, or you get a dead
straight waterline visible from 100 m as an unnatural contour.

### 4.4 Height blending, not linear blending

Andrey Mishkinis, *Advanced Terrain Texture Splatting*, 2013 —
<https://www.gamedeveloper.com/programming/advanced-terrain-texture-splatting> (mirror
<https://www.gamedev.net/articles/programming/graphics/advanced-terrain-texture-splatting-r3287/>).
The problem statement is the best one-liner in this whole document:

> "Stones look evenly soiled by sand, but in real world it doesn't happen. Sand doesn't stick
> to stones, instead it falls down and fills cracks between them, leaving tops of stones pure."

Verbatim formula:
```glsl
float3 blend(float4 texture1, float a1, float4 texture2, float a2)
{
    float depth = 0.2;
    float ma = max(texture1.a + a1, texture2.a + a2) - depth;
    float b1 = max(texture1.a + a1 - ma, 0);
    float b2 = max(texture2.a + a2 - ma, 0);
    return (texture1.rgb * b1 + texture2.rgb * b2) / (b1 + b2);
}
```
`texture.a` is the material's **height map** in [0,1]; `a1`,`a2` are the splat weights;
`depth = 0.2` is the recommended transition width. N-way generalisation (mine, mechanical):

```glsl
// h[i] = material height in [0,1], w[i] = splat weight
float ma = -1e9;
for (int i=0;i<N;++i) ma = max(ma, h[i] + w[i]);
ma -= DEPTH;                       // DEPTH = 0.2
float sum = 0.0; vec3 acc = vec3(0.0);
for (int i=0;i<N;++i) { float b = max(h[i] + w[i] - ma, 0.0); acc += c[i]*b; sum += b; }
return acc / max(sum, 1e-5);
```

**Tuning `depth` visually:** `depth → 0` gives a hard, ragged, per-texel boundary that follows
the height map exactly (good for gravel-into-cracks, bad for sand-into-damp-sand, where it
looks like a torn stencil). `depth → 0.5` degrades toward linear blending and you get the
"evenly soiled" mud look. **0.15–0.25 for rock/sand, 0.35–0.45 for wet/dry sand** (my numbers;
the source only states 0.2).

**Apply the same `b` weights to normals and roughness**, not just albedo, or you get the
signature failure where the *colour* transition is crisp and the *lighting* transition is soft,
which reads as a decal painted on top of the rock rather than sand lying in it.

---

## 5. Wet vs dry sand, and the sheen

### 5.1 The physics, in three numbers

Fresnel `F₀ = ((n₁−n₂)/(n₁+n₂))²`. Quartz `n = 1.544`, water `n = 1.333`, air `n = 1.0`
(the water/quartz IORs are standard; Lagarde uses 1.33 for water and 1.5 for "most rough
dielectric materials",
<https://seblagarde.wordpress.com/2013/03/19/water-drop-3a-physically-based-wet-surfaces/>).

| interface | F₀ | consequence |
|---|---|---|
| air → quartz grain | **0.0457** | dry sand's specular level |
| air → water film | **0.0204** | wet sand's *outer* specular level — and it is a **smooth** interface |
| water → quartz grain | **0.0054** | 8× less reflection at the internal interface |

That third row is the whole explanation for why wet sand is darker, and it is worth stating in
the code comment: when a water film fills the pore space, light that enters no longer gets
bounced back out at each grain boundary — it keeps going deeper and gets absorbed. Lagarde's
part A says the same qualitatively: "light entering wet materials to be less refracted due to
the reduced IOR difference, resulting in more directional forward scattering," and part B
concludes "the subsurface scattering is the most significant reason why materials are darker
when wet."

### 5.2 Lagarde's shipping formula

<https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/>,
verbatim:

```hlsl
void DoWetProcess(inout float3 Diffuse, inout float Gloss, float WetLevel, float2 uv)
{
    float Porosity = tex2D(GreyTextures, uv).g;
    float factor   = lerp(1, 0.2, Porosity);
    Diffuse       *= lerp(1.0, factor, WetLevel);
    Gloss          = lerp(1.0, Gloss, lerp(1, factor, 0.5 * WetLevel));
}
```
and, without a porosity texture:
```hlsl
float Porosity = saturate( ((1 - Gloss) - 0.5) / 0.4 );
float factor   = lerp(1, 0.2, Porosity);
// with metals excluded:
float factor   = lerp(1, 0.2, (1 - Metalness) * Porosity);
```

His stated reasoning for the constants: "We lerp between no attenuation (1.0) and full
attenuation (0.2) based on porosity. The 0.2 is chosen base on the range found in the database
[Gu et al.] and on the choice of 0.3 in [Hoffman]." And on why you don't need to change F₀:
"The change in specular color (i.e. the index of refraction) induced by the water saturation is
not visible enough in game to be taken into account (we go from 0.04 for common dielectric to
0.02 for water)." Note his `0.5 * WetLevel` on the gloss lerp is deliberate: "I use a factor of
0.5 on WetLevel to limit the specular boost."

**Sanity check against measurement.** Beach sand porosity is high; take `Porosity = 0.6` →
`factor = 0.52`. Dry quartz beach sand albedo ≈ 0.35–0.40 → wet ≈ 0.18–0.21. Spectral
measurements of coastal beach sand report "a non-linear decrease in reflectance upon wetting …
over the full wavelengths"
(<https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0112151>), and note
"at visible wavelengths averaged over 400–700 nm, there is a limited contrast between dry and
wet reflectance of beach sand composed of quartz sand." **Flagging honestly:** that paper's
finding of *limited* visible-band contrast is in tension with the roughly 2× ratio the game
formula produces. My reading is that the paper is talking about *spectral discriminability*
for remote sensing (can you tell moisture *level* apart), not about the perceptual dry-vs-wet
step, which is unmistakable to the eye. **I could not find a single citable number for "dry
beach sand albedo = X, wet = Y" in a form I trust.** Use `factor ≈ 0.55` and calibrate against
your reference frames, and treat the 0.2 floor as a floor, not a target.

### 5.3 Concrete PBR values to start from

These are my proposals calibrated against §5.1 and the Lagarde model, **not** measured values.
Label them as such in code.

| surface | baseColor (linear) | roughness | F₀ | notes |
|---|---|---|---|---|
| dry sand, sunlit | 0.36, 0.30, 0.22 | **0.72** | 0.045 | roughness must NOT be 0.95 — see §5.4 |
| damp sand | 0.26, 0.21, 0.15 | 0.55 | 0.035 | transition band |
| wet sand (swash) | 0.19, 0.155, 0.11 | **0.30** | 0.025 | outer interface is a water film → smooth |
| standing water film | — | 0.06 | 0.020 | add a clearcoat-ish layer if you can afford it |
| dry cliff rock | 0.20, 0.19, 0.17 | 0.85 | 0.04 | |
| sea-splashed rock | 0.09, 0.085, 0.075 | 0.35 | 0.04 | the wet/dry line on rock is a huge readability win |

Drive the wet/dry lerp with a single `WetLevel` scalar the shader already has
(`uTWetLevel` exists in `terrain.js`) and **lerp roughness in `α = roughness²` space**, not in
roughness space, if you want the highlight to grow/shrink linearly.

### 5.4 The sheen — why roughness 0.95 kills it

The silvery sheet you see looking down-sun along a sunlit beach is **Fresnel at grazing view
angles on a moderately rough dielectric**. GGX gives it to you for free — but only if:

1. **Roughness is ~0.7, not ~0.95.** At α = roughness² = 0.9 the specular lobe is so broad it
   is indistinguishable from the diffuse term and no sheen forms.
2. **You do not clamp `NdotV` to something like 0.1.** The whole effect lives at
   `NdotV → 0`. Clamp to 1e-4, not to 0.1.
3. **You use a multiple-scattering energy compensation term.** Single-scatter GGX at α ≈ 0.5
   loses ~20–30% of its energy, and the loss is worst at grazing — precisely where the sheen
   is. Without compensation, high-roughness dielectrics look *darker* at grazing than they
   should, which is the opposite of a sheen. three's `MeshPhysicalMaterial` /
   `MeshStandardMaterial` in r185 include an energy-compensation term in the IBL path;
   confirm your custom lighting path does too. *(I did not verify three r185's exact
   multiscatter formulation — check `src/renderers/shaders/ShaderChunk/lights_physical_*`
   before assuming.)*

**Additive tricks from Journey.** thatgamecompany's sand shader (GDC 2013, John Edwards,
<https://gdcvault.com/play/1017742/Sand-Rendering-in>, talk recording
<https://archive.org/details/GDC2013Edwards>) is the best-known art-directed take. Alan
Zucconi's reconstruction (<https://www.alanzucconi.com/2019/10/08/journey-sand-shader-4/>,
part 5) gives runnable code. Three components:

```hlsl
// (1) rim / Fresnel — makes dune contours read against a flat sky
float rim = 1.0 - saturate(dot(N, V));
rim = saturate(pow(rim, _TerrainRimPower) * _TerrainRimStrength);

// (2) "ocean specular" — a Blinn-Phong lobe, deliberately water-like

// (3) glitter
float3 G = normalize(tex2D(_GlitterTex, uv).rgb * 2 - 1);
float3 R = reflect(L, G);
float  RdotV = max(0, dot(R, V));
if (RdotV > _GlitterThreshold) return 0;
return (1 - RdotV) * _GlitterColor;

// combination:
float3 specularColor = saturate(max(rimColor, oceanColor));   // MAX, not sum
float3 color = diffuseColor + specularColor + glitterColor;
```

Two things worth stealing even in a physically-based renderer:

- **`max(rim, ocean)` rather than `rim + ocean`.** Zucconi's stated reason: "Certain parts of
  the dune, especially at grazing angles, might exhibit both Fresnel and Blinn-Phong
  reflectance. Summing both contributions would make [the] dune too shiny."
- **The glitter texture is a *normal* field, not a mask, and it's sampled through `reflect`.**
  The reason is temporal: "if [the direction] is completely random, then [the reflection] as
  well will be completely random … what happens if the lighting source is moving? … Using the
  `reflect` function, instead, allows for a much more stable rendering." Edwards generated the
  glitter texture "from a Gaussian distribution, which ensured that the predominant direction
  was aligned with the surface normal."

**Glitter is exactly what §0 said grains must become.** A sub-pixel grain cannot be a texel; it
can be a stochastic specular event. The glitter texture must be sampled at a *world-space*
scale small enough that its footprint is <1 px (so it reads as sparkle, not as a pattern) and
must be **faded out with distance** (`1 - smoothstep(15.0, 40.0, dist)`) or it becomes a
uniform grey haze at 100 m. Physically-motivated alternative if you have budget: a proper glint
BRDF, e.g. Chermain et al. / the position-normal manifold approach
(<https://arxiv.org/pdf/2505.08985>) — *I did not evaluate these for WebGL2 feasibility and
would not recommend starting there.*

---

## 6. Failure modes — what they look like in a screenshot

Ordered by how often they will actually happen.

**F1 — Hex/tile seam lattice.** A faint honeycomb of lines across the sand, spacing exactly
`1/(2√3)` of your UV repeat (0.58 m at a 2 m repeat). Cause: `γ` too high, or `r` above ~0.8.
Fix: lower `r` toward 0.65, lower `γ` toward 5. **Look for it in a flat-lit region**, not in
sun — seams hide under strong shading.

**F2 — Low-contrast blotch lattice.** Not lines — soft *patches* where the sand looks washed
out, on a regular grid, most visible in shadow or under an overcast sky. Cause: linear blending
without variance restoration (this is what the repo's current 4-tap `textureNoTile` does at
cell corners; see §1.1). Diagnostic: screenshot the same wall of sand with the tile-break on
and off and difference them — a regular lattice in the difference image means F2.

**F3 — Blurred lines tracing hex edges.** One-pixel-wide smears following the hex boundaries,
worst at grazing. Cause: `texture()` instead of `textureGrad()`, so the hardware saw a
discontinuous UV and picked mip 7. Absolutely diagnostic; nothing else looks like it.

**F4 — Far-beach repetition returns.** The tile-break works up close and stops working past
~200 m, often with a diagonal banding structure. Cause: hash precision at large vertex ids
(§1.5). Confirm by teleporting the camera to world origin — if the far beach at (0,0) looks
right and the far beach at (0,−1200) doesn't, it's F4.

**F5 — Ghosting.** The same recognisable pebble/shell appears twice, faintly superimposed,
offset by tens of centimetres. Cause: hex weights too soft (`γ` too low) or histogram-preserving
blending doing its known thing — Burley: "even with histogram preservation enabled, though
diminished, ghosting remains a problem."

**F6 — POM swim / smearing at grazing.** Texture appears to *slide* over the ground as you
walk, and features stretch into comet tails pointing away from the camera. Cause: parallax
offset `V.xy/V.z` unbounded at low `V.z`. Fix: clamp the offset magnitude to ~1.5× the height
scale, and fade POM out by `dot(N,V)`.

**F7 — POM stair-stepping.** Ripple crests break into hard terraces. Tatarchuk names the two
causes directly: piecewise-*constant* height sampling ("stair stepping artifacts visible in the
picture on the left … particularly strong at oblique viewing angles") and 8-bit height data.
Fixes: the piecewise-*linear* segment intersection (§2.1), and a 16-bit height texture — WebGL2
gives you `R16F`/`R16UI` via `EXT_color_buffer_float`/core ES3 formats.

**F8 — POM flattening near the horizon.** Details visibly lose depth as they recede, in a way
that doesn't match perspective. Cause: someone added a depth bias toward the horizon to hide
F6. Tatarchuk: "Depth biasing toward the horizon hides these artifacts but introduces excessive
feature flattening at oblique angles."

**F9 — The mush band.** Sand looks crisp to ~25 m and like grey felt from 30 m to the water.
Cause: aniso cap (§0). This is **not** fixable in the material; add larger-scale signal (§3.1).

**F10 — Shimmer / crawling specular.** Sand sparkles *wrongly* — a fizzing carpet that moves
with the camera rather than stable glints. Causes: normal map used past its Nyquist (fix: §3.1
fade), no specular AA (fix: §3.3b), or the glitter texture sampled at >1 px footprint.

**F11 — Sand getting shinier with distance.** Distant beach reads glossier than near beach.
Cause: normal-map amplitude faded out without moving the variance into roughness. Selfshadow
names this exactly (§3.3).

**F12 — Evenly soiled rock.** Sand appears as a uniform grey wash over the cliff face,
including over the tops of protruding stones. Cause: linear splat blending. Mishkinis's exact
complaint; fix with §4.4.

**F13 — Decal-looking sand-on-rock.** Colour transition is crisp but the lighting transition
is soft; the sand looks printed on. Cause: height blend applied to albedo only. Apply the same
`b` weights to normal and roughness.

**F14 — Sand on a vertical face.** Sand texture climbing a 60° cliff. Cause: no angle-of-repose
cut. Fix: hard mask at `N.y < cos(34°)`.

**F15 — Ruler-straight waterline.** The wet/dry boundary is a perfect contour line visible from
distance. Cause: driving it from altitude alone. Fix: §4.3.

**F16 — Mirrored detail on back faces.** On a triplanar rock, normal detail on the −X face
lights as if the sun were on the other side. Cause: missing `axisSign` correction (§4.1).

**F17 — Flat sand under a low sun.** Everything is technically there but the beach reads as a
flat sheet. Two independent causes worth checking in order: (a) detail normals composed by
`normalize(nA+nB)` instead of summing derivatives — the surface is genuinely flatter than you
authored it (§3.2); (b) roughness pushed to 0.95 so no sheen can form (§5.4).

**F18 — Scale hole.** A distance band (typically 1–3 m) where the sand looks like carpet: too
far for the geometry ripples, too close for anything else to have kicked in. Fix by checking
the §3.1 ladder has no >8× gaps.

---

## 7. What I could not verify

Stated plainly so nothing here gets built on sand (sorry).

1. **Tatarchuk's adaptive-sample formula sign.** The slide prints
   `n = n_min + N̂·V̂_ts (n_max − n_min)` but the surrounding text asks for more samples at
   grazing, which that formula does not give. I found no second source restating it. Use the
   text's intent, not the printed formula.
2. **`SIGMA2` in Tokuyoshi & Kaplanyan Listing 2.** The listing uses the symbol; I did not
   find its numeric value in the paper text I extracted. `κ = 0.18` *is* stated. Start at
   `SIGMA2 = 0.25` and tune; mark it unverified in code.
3. **Dry/wet beach sand albedo as a citable pair of numbers.** The PLOS ONE spectral study
   exists and is good, but it reports reflectance *curves* and explicitly notes limited
   visible-band contrast between moisture levels; it does not hand you a linear-RGB albedo pair.
   My §5.3 table is calibrated inference, not measurement.
4. **three r0.185.1's exact multiple-scattering / energy-compensation term.** I confirmed the
   version (0.185.1) and `getMaxAnisotropy` exist in the installed tree, but I did not read the
   `lights_physical` chunks. Verify before relying on §5.4 point 3.
5. **Benedikt Bitterli's histogram-tiling page** and **the Deliot & Heitz GPU Zen 2 chapter**
   are both referenced by the papers above and are likely useful, but their content was not
   retrievable through this session's fetch path — I have deliberately not summarised them.
   Bitterli: <https://benedikt-bitterli.me/histogram-tiling/>. Deliot & Heitz:
   <https://gpuzen.blogspot.com/2019/04/gpu-zen-2-procedural-stochastic.html>.
6. **The integer hash constants in §1.5** are illustrative. The *principle* (integer hashing
   instead of `fract(sin())` at kilometre scale) is sound and is why the failure exists; the
   specific multipliers are not from a cited source.
7. **Halo: Campaign Evolved's actual rendering techniques.** I did not find and did not look
   for developer disclosures. Everything here is generic AAA terrain practice targeted at the
   described scene, not reverse-engineering of that title.

---

## 8. Sources

- Heitz & Neyret, *High-Performance By-Example Noise using a Histogram-Preserving Blending Operator*, HPG 2018 (Best Paper) — <https://inria.hal.science/hal-01824773/> · <https://dl.acm.org/doi/10.1145/3233304> · <https://eheitzresearch.wordpress.com/722-2/>
- Burley, *On Histogram-preserving Blending for Randomized Texture Tiling*, JCGT 8(4), 2019 — <http://jcgt.org/published/0008/04/02/>
- Mikkelsen, *Practical Real-Time Hex-Tiling*, JCGT 11(2), 2022 — <https://jcgt.org/published/0011/03/05/> · demo <https://github.com/mmikk/hextile-demo>
- Mikkelsen, *Surface Gradient–Based Bump Mapping Framework*, JCGT 9(3), 2020 — <http://jcgt.org/published/0009/03/04/>
- Deliot & Heitz, *Procedural Stochastic Textures by Tiling and Blending*, GPU Zen 2, 2019 — <https://gpuzen.blogspot.com/2019/04/gpu-zen-2-procedural-stochastic.html>
- Tatarchuk, *Practical Parallax Occlusion Mapping for Highly Detailed Surface Rendering*, GDC/SIGGRAPH 2006 — <https://advances.realtimerendering.com/s2006/Tatarchuk-POM.pdf> · <https://archive.org/details/GDC2006Tatarchuk>
- Golus, *Normal Mapping for a Triplanar Shader*, 2017 — <https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a> · <https://github.com/bgolus/Normal-Mapping-for-a-Triplanar-Shader>
- Quilez, *Biplanar mapping* — <https://iquilezles.org/articles/biplanar/>
- Mishkinis, *Advanced Terrain Texture Splatting*, 2013 — <https://www.gamedeveloper.com/programming/advanced-terrain-texture-splatting>
- Lagarde, *Water drop 3a / 3b — Physically based wet surfaces*, 2013 — <https://seblagarde.wordpress.com/2013/03/19/water-drop-3a-physically-based-wet-surfaces/> · <https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/>
- Jensen, Legakis & Dorsey, *Rendering of Wet Materials* — <https://graphics.cs.yale.edu/sites/default/files/wet.pdf>
- Hill (selfshadow), *Specular Showdown in the Wild West* (Toksvig / CLEAN / LEAN), 2011 — <https://blog.selfshadow.com/2011/07/22/specular-showdown/>
- Tokuyoshi & Kaplanyan, *Improved Geometric Specular Antialiasing*, I3D 2019 — <https://www.jp.square-enix.com/tech/library/pdf/ImprovedGeometricSpecularAA.pdf> · <https://doi.org/10.1145/3306131.3317026>
- Edwards, *Sand Rendering in Journey*, GDC 2013 — <https://gdcvault.com/play/1017742/Sand-Rendering-in> · <https://archive.org/details/GDC2013Edwards>
- Zucconi, *Journey Sand Shader* parts 3–5 — <https://www.alanzucconi.com/2019/10/08/journey-sand-shader-3/> · <https://www.alanzucconi.com/2019/10/08/journey-sand-shader-4/> · <https://www.alanzucconi.com/2019/10/08/journey-sand-shader-5/>
- Southard, *Wind Ripples and Eolian Dunes* — <https://geo.libretexts.org/Bookshelves/Sedimentology/Introduction_to_Fluid_Motions_and_Sediment_Transport_(Southard)/12:_Bed_Configurations_Generated_by_Water_Flows_and_the_Wind/12.07:_Wind_Ripples_and_Eolian_Dunes>
- *Direct numerical simulations of aeolian sand ripples*, PNAS 2014 — <https://www.pnas.org/doi/10.1073/pnas.1413058111>
- *Measuring and Modeling the Effect of Surface Moisture on the Spectral Reflectance of Coastal Beach Sand*, PLOS ONE 2014 — <https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0112151>
- Terrain3D shader design notes (macro variation practice) — <https://terrain3d.readthedocs.io/en/latest/docs/shader_design.html>
