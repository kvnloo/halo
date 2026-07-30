# Volumetric clouds — tropical fair-weather cumulus over ocean, WebGL2 / three.js r0.185.1

Research brief for an implementer writing the shader today. Every number below is either
(a) quoted from a primary source with a URL, (b) derived from first principles with the
derivation shown, or (c) explicitly flagged as unverified.

---

## 0. Source ledger — read this first

**Primary, read directly and quoted verbatim below:**

| Source | What I actually extracted |
|---|---|
| Schneider & Vos, *The Real-time Volumetric Cloudscapes of Horizon Zero Dawn*, SIGGRAPH 2015 Advances in RTR. [PDF](https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/The-Real-time-Volumetric-Cloudscapes-of-Horizon-Zero-Dawn.pdf) · [PPTX](https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/Siggraph15_Schneider_Real-Time_Volumetric_Cloudscapes_of_Horizon_Zero_Dawn.pptx) · [landing page](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn) | Speaker notes only. Texture resolutions (128³ ×4ch, 32³ ×3ch, 128² curl), altitudes (1500–4000 m), 64→128 view steps, 6 cone light samples, 35 km draw radius. **The lighting equations on the slides are rasterised images — I could NOT extract the 2015 powder formula from the primary file.** See §3.5. |
| Schneider & Vos, *Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine*, SIGGRAPH 2017. [PDF](https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/Nubis-Authoring-Realtime-Volumetric-Cloudscapes-with-the-Decima-Engine-Final.pdf) · [PPTX](https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/Nubis+-+Authoring+Realtime+Volumetric+Cloudscapes+with+the+Decima+Engine+-+Final.pptx) · [landing page](https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine) | **Full HLSL of `SampleCloudDensity`, `GetLightEnergy`, `SampleCloudDensityAlongCone`, and the main ray-march loop, as live text in the PPTX slide XML.** All quoted verbatim in §2 and §3. |
| Schneider, *Nubis, Evolved*, SIGGRAPH 2022. [PDF](https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/NubisEvolved/NubisEvolved-NoVideos.pdf) | Corrected `HenyeyGreenstein()`, `ms_volume` multi-scatter, `ambient_scattering`, distance-adaptive step size. |
| Schneider, *Nubis³*, SIGGRAPH 2023. [PDF](https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/Nubis%20Cubed.pdf) | Adaptive step size + jitter policy, dimensional-profile gradients, `GetUprezzedVoxelCloudDensity`. |
| Hillaire, *Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite*, SIGGRAPH 2016 PBS course. [PDF](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf) · [course index](https://blog.selfshadow.com/publications/s2016-shading-course/) | Physical σt / albedo for cumulus & stratus, correct HG normalisation, dual-lobe phase, **energy-conserving analytic scattering integration (Eq. 17)**, multi-scatter octaves (Eq. 19/20). |
| Hillaire, `TileableVolumeNoise`. [source](https://github.com/sebh/TileableVolumeNoise) ([main.cpp raw](https://raw.githubusercontent.com/sebh/TileableVolumeNoise/master/main.cpp)) | Exact frequencies/octave weights for the 128³ shape and 32³ erosion volumes. |
| Wrenninge, *Art-Directable Multiple Volumetric Scattering*, SIGGRAPH 2015 Talks. [PDF](https://history.siggraph.org/wp-content/uploads/2022/10/2015-Talks-Wrenninge_Art-Directable-Multiple-Volumetric-Scattering.pdf) | Eq. 1 — the actual "contrast approximation" that Frostbite's octave scheme implements. |
| Toft, Bowles & Zimmermann, *Optimisations for Real-Time Volumetric Cloudscapes*, arXiv 1609.05344. [PDF](https://arxiv.org/pdf/1609.05344) | The step-size-dependent-brightness bug and its analytic fix; measured step-count/time table. |
| Jendersie & d'Eon, *An Approximate Mie Scattering Function for Fog and Cloud Rendering*, SIGGRAPH 2023 Talks. [NVIDIA research page](https://research.nvidia.com/publication/2023-08_approximate-mie-scattering-function-fog-and-cloud-rendering) · [PDF](https://research.nvidia.com/labs/rtr/approximate-mie/publications/approximate-mie.pdf) · [DOI](https://doi.org/10.1145/3587421.3595409) | HG+Draine phase function + parameter fit. This is the single biggest photographic-realism upgrade available. |
| three.js r0.185.1, local `node_modules/three` | `Data3DTexture` defaults, `sampler3D` precision injection, `#version 300 es` behaviour, `generateMipmap(TEXTURE_3D)`. |

**Secondary, used only as cross-checks (working implementations of the above):**
[Meteoros `cloudRayMarch.comp`](https://raw.githubusercontent.com/AmanSachan1/Meteoros/master/src/CloudScapes/shaders/cloudRayMarch.comp) (Vulkan),
[clayjohn/godot-volumetric-cloud-demo `clouds.gdshader`](https://raw.githubusercontent.com/clayjohn/godot-volumetric-cloud-demo/master/clouds.gdshader),
[Skybolt write-up](https://prograda.com/2021/07/28/rendering-planetwide-volumetric-clouds-in-skybolt/),
[demofox, *Ray Marching Fog With Blue Noise*](https://blog.demofox.org/2020/05/10/ray-marching-fog-with-blue-noise/).

**Could NOT verify (stated plainly, do not treat as fact):**
- The exact 2015 / GPU Pro 7 powder constant (`1 - exp(-d*2)` and the `2.0 *` prefactor). GPU Pro 7
  ch. 4 is paywalled ([Taylor & Francis](https://www.taylorfrancis.com/chapters/edit/10.1201/b21261-11/real-time-volumetric-cloudscapes-andrew-schneider)); the 2015 slide equations are images.
  §3.5 gives the form that IS verified plus the 2017 replacement that is fully verified.
- `bitsquid.blogspot.com` (Ola Olsson's cloud post) — the host refused TLS from this machine.
- Häggström's Umeå thesis (diva-portal.org) — host unreachable from this machine.
- Hess et al. 1998 (OPAC) itself — I have the σt numbers only via Frostbite's quotation of it.

---

## 1. Geometry and altitudes — tropical fair-weather cumulus over ocean

### 1.1 Real numbers

| Quantity | Value | Physical meaning | Source |
|---|---|---|---|
| Cloud base (LCL) | **600–700 m** AMSL | Lifting condensation level over tropical ocean; diurnal cycle 600–650 m at night | trade-wind cumulus obs. ([Wikipedia: trade wind cumulus](https://en.wikipedia.org/wiki/Trade_wind_cumulus_cloud), corroborated by BOMEX/RICO cloud-base definition 400–1300 m, [Vial et al., PMC5717165](https://pmc.ncbi.nlm.nih.gov/articles/PMC5717165/)) |
| Cloud top (humilis/mediocris) | **1000–1500 m** | Trade inversion caps growth; tops are notably *uniform* in altitude | same |
| Cloud top (congestus, the "hero" tower) | 2500–4000 m | occasional deeper convection | same |
| Layer thickness to march | **base 600 m, top 2200 m ⇒ 1600 m shell** | gives room for one or two congestus without stratus-flattening the field | design choice from the above |
| Cloud fraction | **13 ± 6 % (BOMEX) to 19 ± 9 % (RICO)** | fraction of sky covered — the single most commonly wrong parameter | [Vial et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC5717165/) |
| Horizontal cloud spacing | ~2–5 km between individual towers | | implied by the above cloud fractions at 1–2 km cloud widths |
| Planet radius for the shell | 6360 km (matches your `RG_KM` in `src/world/clouds.js`) | curvature is what makes distant clouds *descend* into the horizon | Nubis 2015 notes §"spherical atmosphere" |

Guerrilla used base 1500 m / top 4000 m and a **35 000 m draw radius**, with a transition
to cumulus at ~50 % coverage starting at **15 000 m** so the horizon is always interesting
(2015 notes, p. 45). For a *tropical marine* scene, 1500 m is too high — trade cumulus
bases sit at 600–700 m and that low base is a large part of why tropical skies read as
tropical: the clouds are close, their bases are flat and dark, and the horizon line
cuts them.

### 1.2 Marching a spherical shell

Do **not** march a flat slab. On an ocean horizon the flat-slab error is immediately
visible: clouds pile up into a hard band at the horizon instead of sinking below it.

```glsl
// Ray/sphere for a ray that starts inside the planet-centred shell.
// ro is camera position relative to planet centre, in km.
float raySphereFar(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return -1.0;
    return -b + sqrt(d);          // far root; ro inside ⇒ this is the exit
}
float tIn  = raySphereFar(ro, rd, RG + baseKm);
float tOut = raySphereFar(ro, rd, RG + topKm);
// looking down: tIn < 0, no clouds. Looking up: march [tIn, tOut].
```

`height_fraction = (length(p) - (RG + base)) / thickness`, clamped to [0,1]. Guerrilla
uses exactly this (`GetHeightFractionForPoint`, §2.1); clayjohn's Godot port does the same
with `length(p)`.

The ray length through the shell grows as `1/sin(elevation)`. At 1600 m thickness:
- straight up: 1.6 km of shell
- 30° elevation: 3.2 km
- 5° elevation: ~18 km
- at the tangent point: 2·sqrt(2·R·top) ≈ 340 km of shell

This is why every published implementation ramps step count *up* toward the horizon
(Nubis 2017: "between 54 and 96 samples depending on if the view ray is pointing up or to
the horizon"; clayjohn: `mix(96.0, 54.0, dot(dir, up))`) **and** ramps step *size* up with
distance (Nubis Evolved, §4.2).

---

## 2. Density model

### 2.1 The two utility functions (verbatim, Nubis 2017 slide 40)

```hlsl
// fractional value for sample position in the cloud layer
float GetHeightFractionForPoint(float3 inPosition, float2 inCloudMinMax)
{
    // get global fractional position in cloud zone
    float height_fraction = (inPosition.z - inCloudMinMax.x ) / (inCloudMinMax.y - inCloudMinMax.x);
    return saturate(height_fraction);
}
// Utility function that maps a value from one range to another.
float Remap(float original_value, float original_min, float original_max, float new_min, float new_max)
{
    return new_min + (((original_value - original_min) / (original_max - original_min)) * (new_max - new_min))
}
```

`Remap` is the load-bearing primitive of the entire Nubis density model. **Why remap
rather than multiply** (2017 notes, p. 36, verbatim): *"as opposed to multiplying the noises
together, Remapping prevents a loss of too much density at the core of the base cloud
shape."* Multiplying two [0,1] noises gives you `E[ab] = 0.25`; remapping gives you an
*erosion from the edge inward*, which is what carving a cloud actually looks like.

Note `Remap` is **unclamped**. Guerrilla relies on downstream `saturate`. If you clamp
inside `Remap` you will lose the "dilation" behaviour in the `base_cloud` line below,
where `original_min` is negative.

### 2.2 The noise textures — exact generation recipe

Nubis 2015 (notes p. 30–33) and Nubis Evolved both specify:

| Texture | Res | Channels | Content |
|---|---|---|---|
| **Shape** (3D) | 128³ | RGBA | R = Perlin-Worley; G,B,A = Worley fBm at increasing frequency |
| **Erosion / detail** (3D) | 32³ | RGB | Worley fBm at increasing frequency |
| **Curl** (2D) | 128² | RGB | curl noise (divergence-free), for turbulence at cloud base |

Nubis Evolved reports the shape volume as *"4 Channel [128³] … Uncompressed, 2 Bytes /
Texel, 4.194 Megabytes"*.

The **Perlin-Worley composition** (Nubis 2017 slide, verbatim):

```
perlin-worley = remap(perlin, 1.0 - worley, 1.0, 0.0, 1.0)
```

i.e. take the Perlin field and rescale it so that the *inverted-Worley* value becomes the
new zero point. Where inverted Worley is high (cell centres) Perlin gets pushed down;
where it is low, Perlin survives. The result keeps Perlin's connectedness but gains
Worley's packed billows. Guerrilla themselves point at
[Hillaire's TileableVolumeNoise](https://github.com/sebh/TileableVolumeNoise) as the
reference generator, whose `main.cpp` uses the *equivalent* form
`remap(perlinNoise, 0.0f, 1.0f, worleyFBM, 1.0f)` and carries this comment verbatim:

> *"Perlin Worley is based on description in GPU Pro 7: Real Time Volumetric Cloudscapes.
> However it is not clear the text and the image are matching … Also there are a lot of
> fudge factor in the code, e.g. \*0.2, so it is really up to you to fine the formula you like."*

**Exact frequencies from `TileableVolumeNoise/main.cpp`** (these are the numbers to copy):

*Shape volume, 128³:*
- Perlin fBm: `octaveCount = 3`, `frequency = 8.0`
- Perlin-Worley's Worley bank: `cellCount = 4`, multiplied by `frequenceMul[6] = {2, 8, 14, 20, 26, 32}`
- `worleyFBM = w(×2)*0.625 + w(×8)*0.25 + w(×14)*0.125`
- R channel: `PerlinWorleyNoise = remap(perlinNoise, 0, 1, worleyFBM, 1)`
- G,B,A channels (`cellCount = 4`):
  - `worleyFBM0 = w(×1)*0.625 + w(×2)*0.25 + w(×4)*0.125`
  - `worleyFBM1 = w(×2)*0.625 + w(×4)*0.25 + w(×8)*0.125`
  - `worleyFBM2 = w(×4)*0.75  + w(×8)*0.25`  ← only 2 octaves; the next one aliases at 128³

*Erosion volume, 32³:* `cellCount = 2`, octaves at ×1, ×2, ×4 (and ×8), same 0.625/0.25/0.125 weights.

All Worley values are stored **inverted** (`1.0 - WorleyNoise(...)`). Inverted Worley is
what makes billows; non-inverted Worley makes a web/caustic pattern and reads as damage,
not cloud.

**Hard limits** (from the same file's comments and from Nyquist): with a 128³ volume and
`cellCount = 4`, do not exceed ×32 frequency multiplier — you get 1 cell per texel and it
becomes white noise. With a 32³ erosion volume, ×8 is the ceiling. Your existing
`src/world/clouds.js` comments already state this correctly ("Frequencies are capped at 32
cells", "32³ resolves at most 8 cells per axis").

### 2.3 The density-height gradient

Two published formulations. **Use the second one.**

**(a) 2015 / GPU Pro 7 style — four control points per cloud type.** The gradient is
`smoothstep(a, b, h) - smoothstep(c, d, h)`, with `(a,b,c,d)` lerped between three presets by
`cloud_type ∈ [0,1]`. The constants below are from clayjohn's Godot implementation
(cross-check, not primary):

```glsl
const vec4 STRATUS_GRADIENT        = vec4(0.02, 0.05, 0.09, 0.11);
const vec4 STRATOCUMULUS_GRADIENT  = vec4(0.02, 0.20, 0.48, 0.625);
const vec4 CUMULUS_GRADIENT        = vec4(0.01, 0.0625, 0.78, 1.00);

vec4 mixGradients(float t){
    float stratus       = 1.0 - clamp(t * 2.0, 0.0, 1.0);
    float stratocumulus = 1.0 - abs(t - 0.5) * 2.0;
    float cumulus       = clamp(t - 0.5, 0.0, 1.0) * 2.0;
    return STRATUS_GRADIENT*stratus + STRATOCUMULUS_GRADIENT*stratocumulus + CUMULUS_GRADIENT*cumulus;
}
float densityHeightGradient(float h, float t){
    vec4 g = mixGradients(t);
    return smoothstep(g.x, g.y, h) - smoothstep(g.z, g.w, h);
}
```

The primary 2017 deck shows only the *stratus* case explicitly:
`stratus = remap(height, 0.0, 0.1, 0.0, 1.0) * remap(height, 0.2, 0.3, 1.0, 0.0)` — the
same "two ramps multiplied" idea with `remap` instead of `smoothstep`.

**(b) Nubis Evolved / Nubis³ "dimensional profile" — smoother and cheaper, and this is
what shipped in Horizon Forbidden West** (Nubis³ PDF, verbatim):

```
float height_fraction   = remap( height, min_height, max_height, 0.0, 1.0 );
float top_gradient      = pow( 1.0 - height_fraction, 1.5 );
float bottom_gradient   = pow( height_fraction, 2.0 );
float edge_gradient     = remap( sample_height, 0.0, 35.0, 1.0, 0.0 );
float dimensional_profile = bottom_gradient * top_gradient * edge_gradient;
```

and combined with coverage as `float dimensional_profile = vertical_profile * cloud_coverage;`
(Nubis Evolved).

For fair-weather cumulus, `pow(h, 2.0)` for the bottom and `pow(1-h, 1.5)` for the top is
exactly right: **quadratic at the bottom** gives the sharp, flat, dark base you see on
trade cumulus (all bases at the same LCL); **1.5-power at the top** gives the soft
cauliflower dome. Swapping these two exponents is one of the most common visual errors
(see §6.2).

### 2.4 The full density sampler (verbatim, Nubis 2017 slide 40)

```hlsl
float SampleCloudDensity(float3 p, float3 weather_data, int mip_level, bool doCheaply)
{
    // get height fraction  (be sure to create a cloud_min_max variable)
    float height_fraction = GetHeightFractionForPoint(p, cloud_min_max)
    // wind settings
    float3 wind_direction = float3(1.0, 0.0, 0.0);
    float cloud_speed = 10.0;
    // cloud_top offset - push the tops of the clouds along this wind direction by this many units.
    float cloud_top_offset = 500.0;
    // skew in wind direction
    p += height_fraction * wind_direction * cloud_top_offset;
    //animate clouds in wind direction and add a small upward bias to the wind direction
    p+= (wind_direction + float3(0.0, 0.1, 0.0) ) * time * cloud_speed;
    // read the low frequency Perlin-Worley and Worley noises
    float4 low_frequency_noises = tex3Dlod(Cloud3DNoiseTextureA, Cloud3DNoiseSamplerA, float4 (p, mip_level) ).rgba;
    // build an fBm out of the low frequency Worley noises that can be used to add detail to the Low frequency Perlin-Worley noise
    float low_freq_fBm = ( low_frequency_noises.g * 0.625 ) + ( low_frequency_noises.b * 0.25 ) + ( low_frequency_noises.a * 0.125 );
    // define the base cloud shape by dilating it with the low frequency fBm made of Worley noise.
    float base_cloud = Remap( low_frequency_noises.r, - ( 1.0 - low_freq_fBm), 1.0, 0.0, 1.0 );
    // Get the density-height gradient using the density-height function (not included)
    float density_height_gradient = GetDensityHeightGradientForPoint(height_fraction, weather_data );
    // apply the height function to the base cloud shape
    base_cloud *= density_height_gradient;
    // cloud coverage is stored in the weather_data's red channel.
    float cloud_coverage = weather_data.r;
    // apply anvil deformations
    cloud_coverage = pow(cloud_coverage, Remap(height_fraction, 0.7, 0.8, 1.0, lerp(1.0, 0.5, anvil_bias)));
    //Use remapper to apply cloud coverage attribute
    float base_cloud_with_coverage = Remap(base_cloud, cloud_coverage, 1.0, 0.0, 1.0);
    //Multiply result by cloud coverage so that smaller clouds are lighter and more aesthetically pleasing.
    base_cloud_with_coverage *= cloud_coverage;
    //define final cloud value
    float final_cloud = base_cloud_with_coverage;
    // only do detail work if we are taking expensive samples!
    if(!doCheaply)
    {
        // add some turbulence to bottoms of clouds using curl noise. Ramp the effect down over height and scale it by some value (200 in this example)
        float2 curl_noise = tex2Dlod(Cloud2DNoiseTexture, Cloud2DNoiseSampler, float4 (float2(p.x, p.y), 0.0, 1.0).rg;
        p.xy += curl_noise.rg * (1.0 - height_fraction) * 200.0;
        // sample high-frequency noises
        float3 high_frequency_noises = tex3Dlod(Cloud3DNoiseTextureB, Cloud3DNoiseSamplerB, float4 (p * 0.1, mip_level) ).rgb;
        // build High frequency Worley noise fBm
        float high_freq_fBm = ( high_frequency_noises.r * 0.625 ) + ( high_frequency_noises.g * 0.25 ) + ( high_frequency_noises.b * 0.125 );
        // get the height_fraction for use with blending noise types over height
        float height_fraction = GetHeightFractionForPoint(p, inCloudMinMax);
        // transition from wispy shapes to billowy shapes over height
        float high_freq_noise_modifier = lerp(high_freq_fBm, 1.0 - high_freq_fBm, saturate(height_fraction * 10.0));
        // erode the base cloud shape with the distorted high frequency Worley noises.
        final_cloud = Remap(base_cloud_with_coverage, high_freq_noise_modifier * 0.2 , 1.0, 0.0, 1.0);
    }
    return final_cloud;
}
```

Line-by-line notes that matter:

- **`Remap(r, -(1 - low_freq_fBm), 1, 0, 1)`** — the *negative* min is deliberate. It's a
  dilation, not an erosion; it expands the Perlin-Worley field outward by the Worley fBm
  rather than cutting into it.
- **`cloud_top_offset = 500.0` m** — shear. Cloud tops are pushed downwind relative to
  bases. Without this, cumulus look like they were extruded straight up and read as CG.
  For trade cumulus in 6–8 m/s trades this is right at 300–600 m.
- **`p += (wind + (0, 0.1, 0)) * time * cloud_speed`** — the small *upward* bias in the
  advection vector is what makes clouds appear to boil/rise rather than merely slide.
- **`saturate(height_fraction * 10.0)`** — the wispy↔billowy flip happens in the bottom
  **10 %** of the layer only. Below that the erosion noise is used *inverted*, which
  produces the wispy tendrils under the base; above it, non-inverted, which produces
  cauliflower. 2015 notes: *"If you invert the Worley noise at the base of the clouds you
  get some nice whispy shapes."*
- **`high_freq_noise_modifier * 0.2`** — the erosion is scaled to 20 %. This is the single
  strongest "detail amount" knob. Above ~0.35 the clouds shred into lace; below ~0.10 they
  look like blobs of cotton wool.
- **`p * 0.1` on the erosion lookup** — erosion volume is sampled at **10× the world
  frequency** of the shape volume.
- **Curl distortion is ramped by `(1 - height_fraction)` and scaled by 200 m** — turbulence
  only at the base, where it belongs.
- The `anvil_bias` line is for cumulonimbus. **For fair-weather cumulus set `anvil_bias = 0`**,
  which makes the exponent exactly 1.0 and the line a no-op.

**Nubis Evolved / Nubis³ simplification.** By 2022 Guerrilla had replaced the chain of
remaps with a single subtraction (verbatim from both decks):

```
float cloud_density = saturate(cloud_noise_composite - (1.0 - dimensional_profile));
```

with the noise composite built as (Nubis³, `GetUprezzedVoxelCloudDensity`, verbatim):

```hlsl
float wispy_noise = lerp(noise.r, noise.g, inDimensionalProfile);
float billowy_type_gradient = pow(inDimensionalProfile, 0.25);
float billowy_noise = lerp(noise.b * 0.3, noise.a * 0.3, billowy_type_gradient);
float noise_composite = lerp(wispy_noise, billowy_noise, inType);
...
float uprezzed_density = ValueErosion(inDimensionalProfile, noise_composite);
uprezzed_density = pow(uprezzed_density, lerp(0.3, 0.6, max(EPSILON, powered_density_scale)));
```

The trailing `pow(density, 0.3…0.6)` **sharpens** the result — it is what stops the
silhouette from looking soft/fuzzy after erosion. Note `ValueErosion()` is never defined in
the deck; from the 2022 slide it is almost certainly `saturate(profile_arg - (1 - noise_arg))`
or the equivalent `Remap`. **Flagging: the exact body of `ValueErosion` is not in any
primary source I could reach.**

### 2.5 Coverage / weather field for *this* scene

`weather_data.r = coverage`, `.g = precipitation`, `.b = cloud type` (Nubis 2015 notes p. 40,
verbatim: *"Red is coverage, Green is precipitation and blue is cloud type"*).

For tropical fair weather:
- **`coverage` should average ≈ 0.15–0.25**, not 0.5. See §1.1 — measured trade-cumulus
  cloud fraction is 13–19 %. A uniform 0.5 coverage field is *the* reason most WebGL cloud
  demos look like overcast Europe rather than the Caribbean.
- **`type` should sit low (0.2–0.5)** with a few high-`type` cells for the hero towers.
  All-cumulus (`type = 1`) everywhere gives a field of identical popcorn.
- The coverage field must be **clustered, not uniform**. Real trade cumulus organise into
  streets aligned with the trades and into "flower"/"gravel" mesoscale patterns, with wide
  clear lanes. A single-octave fBm coverage gives even carpeting. Multiply a broad,
  low-frequency "system" mask (period ~20–40 km) against a mid-frequency cell field
  (period ~2–5 km) and threshold hard.
- Guerrilla animate the **noise** but *not* the coverage field (2017 notes, p. 45):
  *"while the noise in the density model is animated, the coverage signal is not … we only
  want them to appear to be changing without altering the larger structure."* For stills
  this is irrelevant, but it is why their skies stay art-directed.

---

## 3. Lighting

### 3.1 Get the physics units right first

This is where most implementations silently go wrong, because "density" in the sampler is
a dimensionless [0,1] number and extinction is in m⁻¹.

**Measured values** (Frostbite course notes §5.2, quoting Hess et al. 1998 / OPAC, verbatim):

> *"Hess et al. [HKS98] measured water clouds and reported a single scattering albedo ρ = 1
> and high extinction σt coefficient in the [0.04, 0.06] range for stratus, [0.05, 0.12] for
> cumulus (for the 550um wavelength corresponding to perceptible green). Given the fact that
> ρ is very close to 1, σs = σt can be assumed."*

(The "550um" is a typo in the source for 550 nm.)

**Independent cross-check from cloud microphysics.** For a droplet population in the
geometric-optics limit, extinction is

```
σ_ext = 3 · LWC / (2 · ρ_water · r_eff)
```

With maritime cumulus LWC ≈ 0.3 g m⁻³ and r_eff ≈ 10 µm:
`σ = 3 × 0.3e-3 / (2 × 1000 × 10e-6) = 0.045 m⁻¹`. That lands inside Frostbite's
[0.05, 0.12] range and confirms it. **Use σt = 0.05 m⁻¹ (= 50 km⁻¹) at density 1** for
tropical cumulus.

Consequences you can sanity-check in a screenshot:
- **Mean free path** = 1/σt = **20 m**. Any step longer than ~20 m inside a cloud is
  integrating over more than one scattering length.
- **Optical depth of a 1000 m thick cumulus** = 50. Transmittance `exp(-50) ≈ 2e-22`. The
  core is *completely* opaque to single scattering. If your cloud cores are not pure black
  before you add multiple scattering, your σt is far too low.
- **Single-scattering albedo ρ = σs/σt ≈ 1.0** (Frostbite: "cloud albedo is very close to 1").
  Water absorbs essentially nothing at visible wavelengths. **Set albedo = 0.9–1.0, never
  0.5.** An albedo below ~0.85 gives you grey smoke, not cloud (Frostbite §5.8: *"Multi-
  scattering is also a key component for clouds to not look like smoke."*)

So: `extinction = density * uExtinction` with `uExtinction = 50.0` if your units are km,
`0.05` if metres.

### 3.2 Beer–Lambert and the integration you must get right

Transmittance over a step of length `ds`: `T = exp(-σt · ds)`.

The naive loop

```glsl
scatter += S * T_accum * ds;   // (S)
T_accum *= exp(-sigma_t * ds); // (T)
```

is **wrong in a way that is visible**: the result depends on step count. Toft, Bowles &
Zimmermann (arXiv 1609.05344, Fig. 2) demonstrate it directly, and Frostbite Fig. 35 shows
the two orderings bracketing the truth (S-before-T ⇒ not energy conserving / too bright;
T-before-S ⇒ over-absorbed / too dark).

**Fix — analytic integration over the step** (Frostbite Eq. 17; identical result derived
independently in the arXiv paper's §3.1):

```
∫₀^d exp(-σt·x) · S dx  =  (S - S·exp(-σt·d)) / σt
```

Frostbite's listing, verbatim:

```hlsl
const float clampedExtinction = max( extinction, 0.0000001);
const float transmittance     = exp( -extinction * ds );
const float3 integScatt       = (luminance - luminance * transmittance) / clampedExtinction;
intScattTrans.rgb += intScattTrans.a * integScatt;
intScattTrans.a   *= transmittance;
```

Frostbite Fig. 37: **512 samples needed to converge without it, 21 samples with it.**
Do not skip this. It is four lines and it is the difference between a 512-step and a
32-step still.

GLSL3:

```glsl
float sigma = density * uExtinction;              // 1/km
float Tstep = exp(-sigma * ds);
vec3  S     = scatteredLuminance;                 // sun + ambient, already phase-weighted
vec3  Sint  = (S - S * Tstep) / max(sigma, 1e-7);
radiance   += transmittance * Sint;
transmittance *= Tstep;
```

### 3.3 Phase function

**Henyey–Greenstein — the correct normalisation:**

```
p_HG(θ, g) = (1 - g²) / (4π · (1 + g² - 2g·cosθ)^1.5)
```

(Frostbite Eq. 9, verbatim from the course notes.)

⚠️ **The 2017 Nubis slide contains a typo.** Slide 63 reads:

```
return ((1.0 - e*e) / pow((1.0 + e*e - 2.0*e*cos_angle), 3.0/2.0)) / 4.0 * PI;
```

`… / 4.0 * PI` evaluates left-to-right as `(x/4)·π`, which is **π² ≈ 9.87× too large**.
Guerrilla themselves fixed it by 2022 — *Nubis, Evolved* gives, verbatim:

```hlsl
float HenyeyGreenstein(float inCosAngle, float inG)
{
    float num = 1.0 - inG * inG;
    float denom = 1.0 + inG * inG - 2.0 * inG * inCosAngle;
    float rsqrt_denom = rsqrt(denom);
    return num * rsqrt_denom * rsqrt_denom * rsqrt_denom * (1.0 / (4.0 * M_PI));
}
```

Use the 2022 form. (Meteoros' independent GLSL port also uses `* ONE_OVER_FOUR_PI`, a
third confirmation.)

**Dual lobe.** A single forward lobe makes clouds go dead when the sun is behind the
camera (Frostbite Fig. 39-left: *"only ambient lighting would remain when looking at clouds
when the sun is behind the camera"*). Two published combiners:

- **Nubis (max)** — 2017 slide 64, verbatim:
  ```
  eccentricity = 0.6
  Energy = max( HG(cos θ, eccentricity), silver_intensity * HG(cos θ, 0.99 - silver_spread) )
  ```
  `eccentricity = 0.6` is the stated mid-day value; `1.0` gave good sun highlights but
  *"the clouds 90 degrees away from the sun became too dark"*.
  `silver_intensity` and `silver_spread` are artist knobs in [0,1] (Meteoros' doc-comment
  cross-check: *"Increase silver_intensity to add intensity on clouds near the sun.
  Decrease silver_spread to increase brightness that's spread throughout clouds away from
  the sun"*). Typical: `silver_intensity ≈ 0.7`, `silver_spread ≈ 0.2` ⇒ second lobe at
  `g = 0.79`.
- **Frostbite (lerp)** — Eq. 18: `p_dual(θ, g0, g1, w) = lerp(p_hg(θ,g0), p_hg(θ,g1), w)`,
  with `g0 > 0` forward and `g1 < 0` backward. This is energy-conserving; `max()` is not.
  Suggested start: `g0 = 0.8`, `g1 = -0.3`, `w = 0.3`.
- clayjohn stacks three: `max(max(HG(c,0.6), HG(c, 0.4 - 1.4*sunDir.y)), HG(c,-0.2))` —
  note the middle lobe is *time-of-day dependent* (sharpens as the sun drops).

**The photographic upgrade — HG + Draine (Jendersie & d'Eon 2023).** This is the single
highest-leverage change for a still that must look like a photograph. Real water droplets
have a phase function that neither HG nor a 2-lobe HG mixture matches (their Fig. 1
compares them side by side against tabulated Mie).

Draine's phase function (their Eq. 2, verbatim):

```
φ_{α,g}(θ) = 1/(4π) · (1 - g²) / (1 + g² - 2g cosθ)^{3/2} · (1 + α cos²θ) / (1 + α(1 + 2g²)/3)
```

(reduces to HG at α = 0, to Cornette–Shanks at α = 1, to Rayleigh at g = 0, α = 1.)

Their model (Eq. 3): `φ_fog(θ) = (1 - w_D)·φ_{0,g_HG} + w_D·φ_{α,g_D}`

with the parameter fit as a function of **mean droplet diameter d in µm** (Eqs. 4–7,
valid 5 < d < 50 µm):

```
g_HG(d) = exp( -0.0990567 / (d - 1.67154) )
g_D (d) = exp( -2.20679 / (d + 3.91029) - 0.428934 )
α   (d) = exp( 3.62489 - 8.29288 / (d + 5.52825) )
w_D (d) = exp( -0.599085 / (d - 0.641583) - 0.665888 )
```

I evaluated these for you:

| d (µm) | g_HG | g_D | α | w_D |
|---|---|---|---|---|
| 5 | 0.9707 | 0.5083 | 17.07 | 0.4478 |
| 10 | 0.9882 | 0.5557 | 22.00 | 0.4820 |
| 15 | 0.9926 | 0.5795 | 25.05 | 0.4928 |
| **20** | **0.9946** | **0.5938** | **27.11** | **0.4982** |
| **25** | **0.9958** | **0.6033** | **28.60** | **0.5013** |
| 30 | 0.9965 | 0.6102 | 29.71 | 0.5034 |
| 50 | 0.9980 | 0.6251 | 32.32 | 0.5076 |

**For maritime cumulus use d = 20–28 µm.** Maritime clouds have far fewer CCN than
continental ones (droplet number 20–60 cm⁻³ vs 50–300+ cm⁻³) so droplets are larger:
effective radius ≈ 14 µm over sea vs 9–10 µm over land
([CAIPEEX/ScienceDirect summary](https://www.sciencedirect.com/science/article/abs/pii/S0169809512000427)).
⚠️ **Caveat I cannot resolve from the sources:** the paper's `d` is *mean droplet diameter*
of a log-normal distribution (σ = 0.25), which is not identical to 2·r_eff. Treat
d = 20–28 µm as the right ballpark, and tune by eye.

```glsl
float draine(float c, float g, float a){
    float g2 = g*g;
    float d  = 1.0 + g2 - 2.0*g*c;
    float rd = inversesqrt(d);
    return (1.0/(4.0*PI)) * (1.0-g2) * rd*rd*rd * (1.0 + a*c*c) / (1.0 + a*(1.0+2.0*g2)/3.0);
}
// d = 25 um maritime cumulus
float phaseMie(float c){
    const float gHG = 0.9958, gD = 0.6033, alpha = 28.60, wD = 0.5013;
    return (1.0 - wD) * draine(c, gHG, 0.0) + wD * draine(c, gD, alpha);
}
```

⚠️ **Dynamic range warning.** At `g_HG = 0.996`, `p(0°) = (1-g²)/(4π(1-g)³) ≈ 1.0e4 sr⁻¹`.
That is physically correct and it is why the sun's edge on a cloud is blinding, but it
means the shader must run in HDR and must be tone-mapped. If you clamp before tonemapping
you will get a hard white disc with a ring; see §6.4. The paper explicitly notes it does
*not* reproduce the back-scatter glory/fogbow peaks, which are invisible in most scenes
anyway.

### 3.4 The Nubis lighting model (verbatim, 2017 slide 70)

This is the complete, shipped function — the most useful single block in this document:

```hlsl
// dl is the density sampled along the light ray for the given sample position.
// ds_lodded is the low lod sample of density at the given sample position.
// get light energy
float GetLightEnergy( float3 p, float height_fraction, float dl, float ds_loded, float phase_probability, float cos_angle, float step_size, float brightness)
{
    // attenuation – difference from slides – reduce the secondary component when we look toward the sun.
    float primary_attenuation = exp( - dl );
    float secondary_attenuation = exp(-dl * 0.25) * 0.7;
    float attenuation_probability = max( Remap( cos_angle, 0.7, 1.0, secondary_intensity_curve, secondary_intensity_curve * 0.25) , primary_intensity_curve);
    // in-scattering – one difference from presentation slides – we also reduce this effect once light has attenuated to make it directional.
    float depth_probability = lerp( 0.05 + pow( ds_loded, remap( height_fraction, 0.3, 0.85, 0.5, 2.0 )), 1.0, saturate( dl / step_size));
    float vertical_probability = pow( remap( height_fraction, 0.07, 0.14, 0.1, 1.0 ), 0.8 );
    float in_scatter_probability = depth_probability * vertical_probability;
    float light_energy = attenuation_probability * in_scatter_probability * phase_probability * brightness;
    return light_energy;
}
```

(Note the slide's own inconsistency: `secondary_intensity_curve` / `primary_intensity_curve`
are clearly meant to be `secondary_attenuation` / `primary_attenuation`. Meteoros' port
resolves it that way and it is the only reading that type-checks.)

The three factors, and what each does to the picture:

1. **`attenuation_probability`** = the Beer term with a **multi-scatter floor**. Slide 66,
   verbatim: `Energy = max( exp(-d), exp(-d * 0.25) * 0.7 )`. The second exponential decays
   4× slower and is scaled to 70 %, so deep in the cloud, transmittance floors out at 0.7
   instead of going to zero. Guerrilla: *"The attenuation value for the second function was
   reduced to push light further into the cloud. However, we reduced its influence so that
   we didn't overpower the result."* The `Remap(cos_angle, 0.7, 1.0, …, …·0.25)` **kills
   this boost when you look within ~45° of the sun** — otherwise back-lit clouds lose their
   dark cores.
2. **`depth_probability`** = the in-scatter / powder term. `ds_loded` is a *low-mip* density
   sample at the current position — i.e. "how much cloud is around me", not "how much cloud
   is at me". `pow(ds, e)` with `e` remapped from 0.5 at h = 0.3 to 2.0 at h = 0.85 means the
   darkening is *strong at the top of the cloud and relaxed lower down*. The `+ 0.05` floor
   stops edges going pure black. The `lerp(…, 1.0, saturate(dl/step_size))` disables the
   whole effect once light has already been attenuated, which restores directionality.
3. **`vertical_probability`** = `pow(remap(h, 0.07, 0.14, 0.1, 1.0), 0.8)`. Below 7 % of the
   layer height the in-scatter probability is 0.1; by 14 % it is 1.0. This is what makes
   **cumulus bases dark**. Physically: *"because there are no strong scattering sources
   below clouds, the bottoms will have fewer occurrences of in-scattering"* (2017 notes,
   p. 88). For a 1600 m layer, 7–14 % = 112–224 m above cloud base — a plausible thickness
   for the dark base band on a real cumulus.

**Ambient.** Nubis Evolved, verbatim: `float ambient_scattering = pow(1.0 - dimensional_profile, 0.5);`
and Nubis³: `pow(1.0 - dimensional_profile, 0.5) * exp(-summed_ambient_density)`. Frostbite
weights ambient by a linear gradient from bottom to top of the layer, biased to `[a, 1]`
to account for ground bounce, and explicitly offers artists a **desaturate** control
because *"taking into account the sky … can result in slightly blue cloud if no
multi-scattering solution is used"* (§5.5.1). Over a tropical ocean the ground-bounce term
is not neutral — it is cyan-green from the water. Sample your sky/ocean for it.

Composite (Nubis Evolved, verbatim):
```
Light Energy = Direct Scattering + Ambient Scattering
Direct Scattering = (Transmittance * Primary Scattering Phase) + (Multiple Scattering * Secondary Scattering Phase)
```

### 3.5 The 2015 "Beer's-powder" function — what is and is not verified

**Verified from the primary 2015 material:** the *form* is `Energy = Beer × HG × Powder`
(slide text: `Energy = * HG * P`, with slides labelled "Beer's Law", "Powder Effect",
"'Beer's-Powder' Effect"); the powder term exists to produce dark edges/undersides; and it
is view-dependent — notes p. 66: *"we only see it where our view vector approaches the light
vector, so the powder function should account for this gradient as well"*, and p. 67:
*"a panning camera view that shows this effect increasing as we look away from the sun."*

**NOT verified:** the exact constants. The universally-repeated form is

```glsl
float powder(float d){ return 1.0 - exp(-d * 2.0); }
float beers (float d){ return exp(-d); }
float energy = 2.0 * beers(d) * powder(d) * HG(cosθ, g);
```

I could not confirm the `2.0`s against a primary source — the equations on the 2015 slides
are images and GPU Pro 7 ch. 4 is paywalled. Web-search snippets quote
`powder_sugar_effect = 1.0 − exp(−light_samples * 2.0)` and `beers_law = exp(−light_samples)`
from a GPU Pro 7 summary, but I regard a search snippet as weak evidence.

**Recommendation: don't use the 2015 powder function.** Use the 2017 `in_scatter_probability`
in §3.4, which *is* verbatim from the primary deck and which Guerrilla explicitly describe
as the replacement: *"In 2015 we made a function to approximate this effect and called it
the powder sugar function. We have since improved this to account for the fact that the
effect is not purely directional."*

If you keep a powder term anyway, gate it correctly. With `cos_angle = dot(sunDir, viewDir)`
(both pointing *away* from the camera/toward the target), the effect is at maximum when the
sun is **behind the camera** (`cos_angle → -1`, you are looking at the lit face):

```glsl
float powderWeight = clamp(-cos_angle * 0.5 + 0.5, 0.0, 1.0);  // 1 = sun behind camera
float powderTerm   = mix(1.0, 1.0 - exp(-2.0 * d), powderWeight);
```

Getting this sign backwards is a classic bug: you get dark edges on the *back-lit* rim,
which is exactly where the silver lining should be. See §6.3.

### 3.6 Cheap multiple scattering — the octave method

This is the technique that makes clouds white instead of grey. Two independent statements
of the same thing:

**Wrenninge 2015 (Pixar), Eq. 1, verbatim:**

```
L_i = σs · b_i · L_light(ω_i) · p(ω_i, ω_o, c_i·g) · exp( -a_i ∫₀^t σt(s) ds )
```

**Frostbite 2016, Eqs. 19–20, verbatim:**

```
L_multiscat(x, ω_i) = Σ_{n=0}^{N-1} L_scat(x, ω_i)

with substitutions:   σs' = σs · aⁿ
                      σe' = σe · bⁿ
                      p'(θ) = p(θ · cⁿ)
```

> *"In order to make sure this technique energy conserving … one must ensure that a <= b.
> Otherwise more light can be scattered than expected because equation σt = σa + σs would
> not be respected any more since σs could end up being larger than σt."*

**Values.** Skybolt uses **N = 3 octaves with a = b = c = 0.5** (`k = pow(0.5, N)`) and
mixes the phase toward isotropic as `mix(1/(4π), hg, hgMScatK)`. Frostbite's Fig. 40 shows
N = 1 (single scatter), N = 2, and N = 3 "with exaggerated multi scattering". `N = 3,
a = b = c = 0.5` is the value to start from. `N = 2` is visibly insufficient for the cores;
`N > 4` costs nothing extra in convergence and adds nothing visible.

**Crucially, all octaves share the same light-march result** — you compute the optical
depth toward the sun *once* and evaluate `exp(-τ · bⁿ)` per octave. This is why the
technique is cheap. Implementation:

```glsl
// tauLight  = optical depth toward the sun (dimensionless, from the cone march)
// sigmaT    = local extinction at this sample (1/km)
// cosTheta  = dot(sunDir, viewDir)
vec3 msScatter = vec3(0.0);
float a = 1.0, b = 1.0, c = 1.0;                 // aⁿ, bⁿ, cⁿ
for (int n = 0; n < 3; ++n) {
    float phase = mix(1.0/(4.0*PI), phaseMie(cosTheta), c);   // widen lobe per octave
    msScatter  += a * exp(-tauLight * b) * phase * sunColor;
    a *= uMSa;  b *= uMSb;  c *= uMSc;           // 0.5, 0.5, 0.5
}
vec3 S = sigmaT * albedo * msScatter + ambient;
```

Frostbite's honest caveat: *"it does not represent well complex multi-scattering behavior:
for instance side or backward scattering, no cone spread"* — but it *"works very well in
practice"*. It is also what makes it possible for light to "punch through the medium in
order to reveal inner details on the shadowed sides".

Note this and the Nubis `max(exp(-d), exp(-0.25d)·0.7)` are **two solutions to the same
problem**. Pick one. Using both stacks two multi-scatter boosts and washes out the cores.

---

## 4. Ray-march strategy for stills

For a still you can spend 10–100× a game budget. The right way to spend it is *not*
"more view steps" — it is more *light* steps and a correct integrator.

### 4.1 Step counts

| | Shipped real-time (Nubis 2017) | Recommended for photographic stills |
|---|---|---|
| View steps, looking up | 54 | 128 |
| View steps, at horizon | 96 | 384–512 |
| Light (cone) samples | 5–6 | 12–16 |
| Long-distance shadow sample | 1 extra, far out | keep it |
| Empty-space step multiplier | ×2 | ×2 to ×3 |

Primary quote (2017 notes, p. 95): *"The step count ranges between 54 and 96 samples
depending on if the view ray is pointing up or to the horizon."* 2015 notes give
*"an initial potential 64 samples and end with a potential 128 at the horizon"* and
*"6 light samples per march in a cone"*.

Cross-check on cost: arXiv 1609.05344 Fig. 3 measures, at 1920×1080 on a GTX 1080:
128 steps full-res = 297.7 ms, 128 steps half-res = 128.0 ms, 8 steps half-res = 2.3 ms.
You are rendering stills, so 300 ms/frame is fine.

**Sizing by mean free path.** With σt = 0.05 m⁻¹ the mean free path is 20 m. A 1600 m
shell at 30° elevation is a 3.2 km path; 128 steps = 25 m/step ≈ 1 mfp. That is the right
order. At 5° elevation the path is 18 km; 128 steps = 140 m/step = 7 mfp, which is far too
coarse — hence adaptive stepping.

### 4.2 Adaptive step size

Nubis Evolved (verbatim):

```hlsl
// Define step size constants
float near_step_size = 3.0;
float far_step_size_offset = 60.0;
float step_adjustment_distance = 16384.0;
// Calculate distanced-based step size
float step_size = near_step_size + ((far_step_size_offset * distance_from_camera) / step_adjustment_distance);
```

So 3 m at the camera, growing to 63 m at 16.4 km. Nubis³ replaces it with:

```hlsl
float adaptive_step_size = max( 1.0, max(sqrt(raymarch_info.mDistance), EPSILON) * 0.08);
```

i.e. `0.08·√d` metres, floored at 1 m: 2.5 m at 1 km, 8 m at 10 km, 25 m at 100 km. The
sqrt law is better than linear because projected texel size grows like √d for a
perspective camera at fixed angular resolution.

### 4.3 Empty-space skipping (verbatim, Nubis 2017 slide 73)

```hlsl
float ds = 0.0;
float cloud_test = 0.0;
int zero_density_sample_count = 0;
float sampled_density_previous = -1.0;
float alpha = 0.0;
for (int i = 0; i < sample_count; i++)
{
    if(alpha <= 1.0)
    {
        // cloud_test starts as zero so we always evaluate the second case from the beginning
        if(cloud_test > 0.0)
        {
            float sampled_density = SampleCloudDensity(p, weather_data, mip_level, false);
            if( sampled_density == 0.0 && sampled_density_previous == 0.0) { zero_density_sample_count ++; }
            if(zero_density_sample_count < 11 && sampled_density != 0.0)
            {
                ds += sampled_density;
                dl = SampleCloudDensityAlongCone (p, ray_direction);
                // get light energy here / add to alpha here / attenuate light energy by alpha here
                p += step;
            }
            else { cloud_test = 0.0; zero_density_sample_count = 0; }
            sampled_density_previous = sampled_density;
        }
        else
        {
            cloud_test = SampleCloudDensity(p, weather_data, mip_level, true);   // cheap: low-freq only
            if( cloud_test == 0.0) { p += step * 2; }
            else                   { p -= step ; }   // step back, don't miss the surface
        }
    }
}
```

The two details that are easy to get wrong:
- **The step *back* on first hit.** `p -= step` when the cheap sample first returns
  non-zero. Without it you punch a hole in the leading face of every cloud.
- **The 10-consecutive-zeros rule** before dropping back to cheap mode. Dropping back after
  one zero sample makes the interior of clouds flicker/stripe.

This is only correct because *"the high frequency cloud noises are applied as a subtraction
to the edges of the low frequency noise"* — the cheap (low-freq only) sample is a
conservative isosurface enclosing the true cloud. If you ever make erosion *additive*, this
optimisation silently starts eating geometry.

Measured payoff, PS4, from the same deck: baseline+reprojection 22 ms → LOD & step size
8.1 ms → light only where density > 0: 3.34 ms → cull below horizon 1.81 ms → depth cull 1.2 ms.

### 4.4 The cone light march (verbatim, Nubis 2017 slide 73)

```hlsl
// random unit vectors for your cone sample.
static float3 noise_kernel[] = { … some noise vectors… }
// How wide to make the cone.
float cone_spread_multplier = length(light_step);
// a function to gather density in a cone for use with lighting clouds.
float SampleCloudDensityAlongCone(p, ray_direction)
{
    float density_along_cone = 0.0;
    for(int i=0; i<=6; i++)
    {
        p += light_step + ( cone_spread_multiplier * noise_kernel[i] * float(i) );
        int mip_offset = int(i * 0.5);
        density_along_cone += SampleCloudDensity(p, weather_data, mip_level + mip_offset, false);
    }
    return density_along_cone;
}
```

Three things are happening simultaneously and all three matter:
1. **The cone spreads** — offset scales with `i`, so sample `i` is `i·spread` off-axis. This
   is a poor-man's blur that *"smooths the banding we would normally get with 6 samples and
   weights our lighting function with neighboring density values, which creates a nice
   ambient effect"* (2015 notes p. 83).
2. **The mip level increases** — `mip_offset = i/2`. Farther samples read a blurrier
   version of the volume, which is both cheaper and more correct (they represent a larger
   solid angle).
3. **One sample is thrown far** — 2015 notes: *"The last sample is placed far away from the
   rest in order to capture shadows cast by distant clouds."* clayjohn's cross-check puts
   it at `18 * lss`, i.e. 18 light-steps out; Meteoros' kernel has `vec3(0.0, 3.0, 0.0)` as
   its 6th entry, 3× the cone length.

A concrete, working kernel (from clayjohn's Godot implementation — 6 unit-ish vectors):

```glsl
const vec3 RANDOM_VECTORS[6] = vec3[6](
  vec3( 0.38051305,  0.92453449, -0.02111345),
  vec3(-0.50625799, -0.03590792, -0.86163418),
  vec3(-0.32509218, -0.94557439,  0.01428793),
  vec3( 0.09026238, -0.27376545,  0.95755165),
  vec3( 0.28128598,  0.42443639, -0.86065785),
  vec3(-0.16852403,  0.14748697,  0.97460106));
```

**Light step length.** clayjohn uses `lss = layerThickness / 36.0` (≈ 44 m for a 1600 m
layer) — so 6 samples reach ~270 m and the distant sample reaches ~800 m. For stills with
12–16 samples, scale `lss` down proportionally so the *total* reach stays ~0.3–0.5 × the
cloud diameter; reaching further just re-samples the same cloud.

**Only march light when you are inside a cloud.** This is the single biggest cost saving
(8.1 ms → 3.34 ms above) and it is free.

### 4.5 Banding, blue noise, and how to get a clean still

Undersampled ray-marches band. The fix is to offset each ray's start by a per-pixel
fraction of one step:

```glsl
p = rayStart + rd * (offset01 * stepSize);
```

Which `offset01`? Ranked, from [demofox's comparison](https://blog.demofox.org/2020/05/10/ray-marching-fog-with-blue-noise/):

- **White noise / `hash(pos)`** — *"better than the banding, but is pretty ugly."* This is
  what clayjohn and Meteoros use, and it is why their stills look grainy.
- **Tiled screen-space blue noise texture** — *"lots better"*. **This is the right choice
  for a still.** Free 64×64 / 128×128 blue-noise tiles: [momentsingraphics.de/BlueNoise.html](https://momentsingraphics.de/BlueNoise.html).
  Sample with `texelFetch(tBlueNoise, ivec2(gl_FragCoord.xy) % 64, 0).r`.
- **Interleaved gradient noise (Jimenez)** — cheap, no texture, pleasant, but *"patterns
  are still noticeable and it can alias"*.
  ```glsl
  float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  ```
- **Bayer 4×4** — worst for this; *"strong single frequency bands tend to alias heavily."*

**For stills specifically:** the whole banding-vs-noise trade-off dissolves if you
**accumulate**. Render N frames with the blue-noise offset advanced by the golden ratio and
average them:

```glsl
float offset = fract(blueNoise + float(uFrame) * 0.61803398875);
```

demofox: *"adding the golden ratio × the frame number to the blue noise texture value and
using fract to bring it back between 0 and 1 … maintains blue spatial distribution while
achieving low discrepancy over time."* 16–64 accumulated frames with a *static camera*
converges to a clean image with no TAA, no reprojection, and no ghosting. Your repo already
has a `taa.js` pass and the `clouds.js` header comments mention 16 dither phases — that is
exactly this idea; just make sure the accumulation is a true mean, not an exponential
moving average, or the first frames bias the result.

Nubis³ has a subtlety worth stealing even for stills:

```
jitter_offset = distance_from_camera < 250.0 ? animated_hash : static_hash
```

*"The jitter switches from animated close by to static far away to reduce under-sampling
artifacts without making distant clouds shimmer."* For a single still it doesn't matter;
for a sequence it does.

Also note the arXiv paper's warning: jittering costs performance because it **destroys
texture cache coherence** (their 8-step case went 2.3 ms → 7.5 ms purely from the jitter).
Irrelevant at still-image budgets, but don't be surprised by the profile.

### 4.6 three.js r0.185.1 / WebGL2 specifics (verified against local `node_modules/three`)

- **`sampler3D` works in a plain `ShaderMaterial`.** `WebGLProgram.js` unconditionally emits
  `#version 300 es` for non-raw materials (line 805) and injects
  `precision ${precision} sampler3D;` (line 312). It also `#define texture2D texture`, so
  `texture()` and `textureLod()` on a `sampler3D` compile without setting `glslVersion`.
  You still want `precision highp sampler3D;` at the top of your fragment source for clarity
  (your `clouds.js` already does).
- **`Data3DTexture` defaults are hostile to tiling noise.** From `Data3DTexture.js`:
  `magFilter = NearestFilter`, `minFilter = NearestFilter`, `wrapR = ClampToEdgeWrapping`,
  `generateMipmaps = false`, `unpackAlignment = 1`. You must set:
  ```js
  tex.minFilter = THREE.LinearMipmapLinearFilter;   // needed for textureLod cone sampling
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  ```
  `WebGLTextures.js` does call `generateMipmap(gl.TEXTURE_3D)` for a `Data3DTexture` when
  `textureNeedsGenerateMipmaps()` is true (line ~1393), and does set `TEXTURE_WRAP_R` from
  `texture.wrapR` (line 679). **Without mipmaps, `textureLod(..., mip)` in the cone march
  silently returns mip 0 and you lose the smoothing that makes 6 light samples viable.**
- **A tiling 3D noise volume must tile in R too.** `wrapR` defaults to clamp; if you leave
  it, the volume mirrors/clamps in the vertical noise axis and you get a visible seam plane
  through the cloud layer.
- **Float vs 8-bit.** `RedFormat`/`UnsignedByteType` at 128³×4 = 8 MB is plenty (Guerrilla
  ship 2 bytes/texel). `HalfFloatType` doubles memory and buys nothing here — the density
  field is [0,1] and quantisation is hidden by the erosion remaps. But **do not** store the
  *packed* single-channel version if you want to tune the fBm weights at runtime.

---

## 5. Parameter set — tropical fair-weather cumulus, marine

Start here, then tune. Units are explicit; "physical meaning" is what you are actually
dialling.

| Uniform | Value | Units | Physical meaning / what moves when you change it |
|---|---|---|---|
| `cloudBase` | **650** | m AMSL | LCL. Lower ⇒ clouds closer, bases more visible, more tropical. |
| `cloudTop` | **2200** | m AMSL | trade inversion. Uniform tops are the trade-cumulus signature. |
| `planetRadius` | 6360 | km | curvature; controls how fast clouds sink at the horizon. |
| `drawRadius` | 35 000 | m | Guerrilla's shipped value. |
| `coverage` (mean) | **0.18** | – | sky fraction. 13–19 % measured. >0.35 ⇒ not fair weather. |
| `cloudType` (mean) | 0.35 | – | 0 = stratus, 1 = cumulus/congestus. Low with sparse high spikes. |
| `anvilBias` | 0.0 | – | off. Anvils are cumulonimbus, not fair-weather. |
| `σt` (`uExtinction`) | **50** | km⁻¹ (= 0.05 m⁻¹) | extinction at density 1. Frostbite/Hess cumulus range 0.05–0.12 m⁻¹. |
| `albedo` (σs/σt) | **0.995** | – | ≈1 for water at visible λ. <0.85 ⇒ smoke. |
| `shapeFreq` | 1 / 4000 | m⁻¹ | one 128³ tile ≈ **4 km**. Sets individual cloud size (~1–2 km across). |
| `erosionFreq` | 10 × shapeFreq | m⁻¹ | one 32³ tile ≈ 400 m. |
| `weatherFreq` (system) | 1 / 30 000 | m⁻¹ | mesoscale organisation / cloud streets. |
| `weatherFreq` (cells) | 1 / 4000 | m⁻¹ | individual cloud clusters. |
| `erodeAmount` | **0.20** | – | Nubis' `high_freq_noise_modifier * 0.2`. 0.10 = blobby, 0.35 = lace. |
| `curlAmount` | 200 | m | base turbulence displacement, ramped by `(1-h)`. |
| `cloudTopOffset` (shear) | **400** | m | downwind lean of tops. 0 ⇒ extruded, CG look. |
| `windDir` | trades, e.g. (−1, 0, −0.2) | – | easterlies. |
| `windSpeed` | 7 | m s⁻¹ | trade wind. |
| `g_HG`, `g_D`, `α`, `w_D` | 0.9958, 0.6033, 28.60, 0.5013 | – | HG+Draine at d = 25 µm maritime droplets (§3.3). |
| — or Nubis dual-HG — | `g = 0.6`, `silver_intensity = 0.7`, `silver_spread = 0.2` | – | verbatim 2017 mid-day values. |
| MS octaves `N` | 3 | – | Skybolt/Frostbite. |
| MS `a`, `b`, `c` | 0.5, 0.5, 0.5 | – | scattering / extinction / phase-width falloff per octave. Require `a ≤ b`. |
| in-scatter depth remap | `(0.3, 0.85) → (0.5, 2.0)` | – | verbatim 2017. |
| in-scatter vertical remap | `(0.07, 0.14) → (0.1, 1.0)`, `pow 0.8` | – | verbatim 2017. **This is the dark base.** |
| view steps | 128 (up) → 448 (horizon) | – | still-image budget. |
| light cone samples | 12 | – | ×2 the shipped 6. |
| light step | thickness / 36 ≈ 44 | m | so 12 samples reach ~530 m. |
| jitter | blue-noise tile + golden-ratio over frames | – | §4.5. |
| accumulated frames | 32 | – | converges without TAA ghosting. |

**Sanity checks you can do before you look at the image:**
- optical depth through a 1 km tower = σt × 1000 m = 50. `exp(-50)` ≈ 0. Cores must be
  black before multiple scattering.
- mean free path = 20 m; your smallest step must be ≲ 25 m inside a cloud.
- with coverage 0.18 and a 4 km shape tile, expect ~1 cloud per 4 km² of sky — count them
  in the render.

---

## 6. Failure modes, described visually

These are written so you can diagnose from a screenshot, not from code.

### 6.1 Density / shape

**"Popcorn carpet."** Every cloud the same size, evenly spaced, filling the whole sky.
→ Coverage field is a single-octave fBm at one frequency and its mean is ~0.5. Real trade
cumulus come in clusters with wide clear lanes. Multiply a low-frequency system mask
against a mid-frequency cell field and drop the mean to ~0.18.

**"Cauliflower everywhere, including underneath."** Bases are bumpy and billowy instead of
flat and ragged. → The wispy↔billowy flip (`saturate(height_fraction * 10.0)`) is missing
or its scale is wrong, so you are using non-inverted erosion noise at the base. Real
cumulus bases are *flat* (all at the LCL) with wispy tatters hanging below.

**"Cotton wool."** Silhouettes are smooth, rounded, and soft; no fine structure on the
rim. → Erosion amount too low (< 0.10), or the 32³ erosion volume is being sampled at too
low a world frequency, or you skipped the Nubis³ sharpening `pow(density, 0.3…0.6)`.

**"Lace / shredded tissue."** Clouds have holes and thin filaments everywhere. → Erosion
amount too high (> 0.35), or you multiplied noises together instead of using `Remap` (which
gouges the core, not just the edge).

**"Extruded columns."** Clouds look like they were pushed straight up out of a plane; tops
sit exactly above bases. → `cloud_top_offset` (shear) is 0. Set it to 300–600 m in the wind
direction.

**"Chequerboard when thresholded."** Grid-aligned diagonal structure appears as coverage
drops. → Un-rotated fBM octaves; the Perlin lattice is aligned across octaves. Rotate or
domain-warp each octave. (Your `clouds.js` already notes this.)

**"Horizon wall."** Clouds pile into a hard band at the horizon and never sink below it.
→ You are marching a flat slab, not a spherical shell.

**"Visible tiling at the horizon."** The same cloud repeating in a regular grid far away.
Guerrilla explicitly show this: *"the cloud sphere drops below the horizon and begins to
tile noticeably."* → Increase the weather-map world extent, add a second incommensurate
weather octave, and fade to sky over distance (clayjohn: `smoothstep(0.6, 1.0, 1.0-dir.y)`).

### 6.2 Height gradient

**"Flying pancakes."** Clouds are wide and flat with sharp tops. → Top and bottom gradient
exponents are swapped: you want `pow(h, 2.0)` at the bottom (sharp) and `pow(1-h, 1.5)` at
the top (soft), per Nubis³. Reversed gives a soft base and a hard top.

**"Everything is stratus."** No vertical development anywhere. → `cloud_type` is near 0
globally, or the gradient's `c`/`d` control points (the upper `smoothstep`) are too low.

**"Clouds float with a visible gap under them."** A clear air layer under the deck, then a
hard bottom edge. → `height_fraction` is being computed from a flat `p.y` rather than
`length(p) - (R + base)`, so the layer bottom follows a plane while the march follows a
sphere.

### 6.3 Lighting — the ones this brief specifically asks about

**Wrong phase function — single lobe, g too high (e.g. one HG at g = 0.9):**
*Visual:* a tight, blinding halo within a few degrees of the sun, and **everything else is
flat and dead**. Clouds 90° from the sun have no shading at all — they read as uniform grey
paper cut-outs. Clouds with the sun behind the camera (the classic "white puffy cumulus
against blue" shot) are the worst affected: no form, no modelling, no self-shadow contrast.
Guerrilla saw exactly this: *"the clouds 90 degrees away from the sun became too dark."*
Frostbite: *"with a strong forward peak, only ambient lighting would remain when looking at
clouds when the sun is behind the camera."*
*Fix:* dual lobe (max or lerp), or HG+Draine.

**Wrong phase function — g too low (e.g. one HG at g = 0.3):**
*Visual:* no silver lining at all. Back-lit clouds are uniformly grey; the rim does not
glow. The image looks like it was shot on an overcast day even though the sun is in frame.
Everything is soft and low-contrast.

**Wrong phase function — no normalisation (the `/ 4.0 * PI` typo):**
*Visual:* the whole cloud layer is ~10× too bright and clips to white after tonemapping;
you compensate by dropping sun intensity, and then the *sky* and *ocean* go dark. If your
clouds look right only when the rest of the scene looks wrong, check this first.

**Wrong powder term — sign flipped:**
*Visual:* the **back-lit rim is dark** and the front-lit face is bright and flat. This is
exactly inverted from reality: back-lit cumulus should have a blazing bright rim and a dark
interior; front-lit cumulus should have dark creases and a bright body. If your sunset
clouds have black edges, the powder gate is backwards.

**Wrong powder term — applied everywhere, no view gate:**
*Visual:* clouds look like they were rendered with an ambient-occlusion pass. Every
silhouette edge is uniformly dark, including at the sun-facing rim, and the effect does not
change as the camera pans. The image reads as "3D render", not "photograph". Guerrilla:
*"this is a view dependent effect."*

**Powder term too strong:**
*Visual:* clouds develop a hard dark outline, like a comic-book ink line, and the interiors
go milky/washed. It looks like a bad "detail enhance" filter.

**No powder / in-scatter term at all:**
*Visual:* clouds are uniformly bright right up to their edges; bases are the same value as
tops. They read as fog banks or steam, not as solid bodies. You lose all sense of volume
and, critically, all sense of *scale* — Guerrilla note it *"helps sell the scale of the scene."*
The `vertical_probability` term is the one that darkens bases; without it, a cumulus with a
white underside looks like it is lit from below.

**Too few light steps (1–3):**
*Visual:* **hard concentric shadow bands** running across the cloud body roughly
perpendicular to the sun direction, like contour lines on a map. On animation they crawl.
The cone spread plus increasing mip is the specific fix (2015 notes: it *"smooths the
banding we would normally get with 6 samples"*).

**Light steps taken without cone spread (a straight line march):**
*Visual:* shadow terminators are razor-sharp and blocky; you get "shadow acne" speckle
inside the cloud where consecutive samples land in and out of erosion detail. The clouds
look crunchy rather than soft.

**Light steps not mip-LODed:**
*Visual:* high-frequency sparkle/crawl in the shaded regions, worst at grazing sun angles.

**Light march too short (reach ≪ cloud size):**
*Visual:* no self-shadowing — the far side of a tower is as bright as the near side, and
one cloud never shadows another. The sky reads as a field of independent glowing blobs.

**Light march too long:**
*Visual:* everything is over-shadowed and grey; the sunlit tops lose their punch. You also
pay for nothing, because `exp(-τ)` has already saturated.

**No multiple scattering (single scatter only):**
*Visual:* **grey, dirty, smoke-like clouds.** Cores are near-black, and only a thin rind at
the surface is lit. This is Frostbite Fig. 40-top and Nubis 2017 slide 66-left, and it is
the most common single mistake. Real cumulus are *white* through their whole optically
thick body because photons bounce dozens of times at albedo ≈ 1.

**Too much multiple scattering (N too high, or a/b too close to 1, or stacking Nubis'
`max(exp(-d), 0.7·exp(-0.25d))` on top of octaves):**
*Visual:* clouds become uniformly luminous with no internal contrast — they look like
they're made of frosted glass and lit from inside. Self-shadowing disappears and the deck
flattens into a single value.

**Multi-scatter phase not widened per octave (`c` = 1):**
*Visual:* the silver lining "leaks" — the bright forward-scatter rim appears on clouds
nowhere near the sun, because higher scattering orders keep the narrow forward lobe they
should have lost.

**Ambient too blue / not desaturated:**
*Visual:* shadowed cloud faces are cyan-blue instead of neutral grey-white. Frostbite calls
this out explicitly and ships a desaturate control. Over a tropical ocean the *upward*
bounce is also strongly cyan, so you can end up with blue tops and blue bottoms and no
neutral anywhere.

**Ambient without a height gradient:**
*Visual:* cloud undersides are as bright as their tops, killing the dark base that says
"cumulus". Frostbite weights ambient by a bottom-to-top gradient for exactly this reason.

### 6.4 Integration / sampling

**Brightness changes with step count:**
*Visual:* the same scene rendered at 64 vs 256 steps has visibly different exposure. Or:
the clouds get brighter toward the horizon (where steps are longer). → You are missing the
analytic scattering integration (§3.2). arXiv 1609.05344 Fig. 2 is a picture of exactly this.

**Banding:**
*Visual:* smooth, concentric arcs of alternating brightness through the cloud layer,
strongest in low-density regions and at the layer boundary. → No per-ray jitter.

**Grain:**
*Visual:* per-pixel salt-and-pepper noise in the cloud interiors. → White-noise jitter.
Switch to a blue-noise tile, and accumulate.

**Aliased silhouettes:**
*Visual:* hard, stair-stepped cloud edges that crawl. → Step size too large relative to the
erosion detail; add a soft-edge falloff, increase steps near the silhouette, or (cheap)
apply Nubis³'s trick of lowering density and sharpening near the camera.

**Clamped highlights:**
*Visual:* the sun-adjacent rim is a flat white shape with a hard boundary, no gradient
inside it. → You're clamping to [0,1] before tonemapping. Nubis 2017 notes explicitly:
*"we do not clamp any values in our lighting model. This allows support for HDR."*
Given `p(0°) ≈ 1e4 sr⁻¹` for a d = 25 µm droplet phase function, unclamped HDR is mandatory.

**No aerial perspective on distant clouds:**
*Visual:* clouds 30 km away are as saturated and contrasty as clouds 3 km away. The image
has no depth; the horizon reads as a wall. → Blend cloud colour toward the atmospheric
in-scatter colour by depth. Nubis' method (2017, verbatim): record a depth at the point
where alpha reaches **0.5**, sample accumulated atmospheric scattering at that depth, store
it as a blend factor, and lerp cloud colour → sky colour in the composite pass. Over an
ocean horizon this is what makes the far cumulus go pale blue-grey and *sit* in the
distance.

---

## 7. Order to build it in

1. Spherical shell march + `height_fraction` + a constant density. Check the horizon sinks.
2. Analytic integration (§3.2) *before* anything else. Verify brightness is step-count independent.
3. Density-height gradient (Nubis³ dimensional profile) with coverage from a hand-painted
   or procedural weather texture. Check bases are flat and at one altitude.
4. Shape volume (Perlin-Worley + Worley fBm) via the `Remap` chain.
5. Erosion volume at ×10 frequency, at 0.2 strength, with the base-inversion flip.
6. Beer + single HG. Expect grey smoke — that's correct at this stage.
7. Multi-scatter octaves (N=3, a=b=c=0.5). Clouds should go white. **This is the big moment.**
8. Cone light march with mip falloff + the far shadow sample.
9. In-scatter probability (`depth_probability × vertical_probability`). Bases go dark.
10. HG+Draine phase at d = 25 µm. Silver lining appears.
11. Blue-noise jitter + golden-ratio accumulation.
12. Aerial perspective blend at the alpha = 0.5 depth.
13. Shear (`cloud_top_offset`) and curl at the base — last, because they're purely cosmetic
    and easy to over-apply.

---

## 8. What I could not verify — restated so it doesn't get built on

1. **The 2015 / GPU Pro 7 powder constants** (`1 - exp(-2d)`, `2.0 *` prefactor). Form
   verified; constants not. Use the 2017 in-scatter probability instead (§3.5).
2. **`ValueErosion()`** in Nubis³ is used but never defined in the deck. My reading
   (`saturate(a - (1 - b))`) is inference from the 2022 slide, not a quote.
3. **Hess et al. 1998 (OPAC)** — I have σt = [0.05, 0.12] m⁻¹ for cumulus only via
   Frostbite's quotation of it, not from the paper. My independent LWC-based derivation
   agrees, which is why I'm comfortable recommending 0.05.
4. **Droplet diameter `d` for the Mie fit** — the paper's `d` is a log-normal *mean
   diameter*, and the maritime `r_eff ≈ 14 µm` I found is an *effective radius*. The
   d = 20–28 µm recommendation bridges those two definitions loosely. Tune by eye.
5. **The GPU Pro 7 height-gradient constants** (`STRATUS_GRADIENT` etc.) come from
   clayjohn's Godot implementation, not from the book. Different implementations quote
   slightly different numbers; the 2017 deck only shows the stratus case.
6. **bitsquid.blogspot.com** and **diva-portal.org** (Häggström thesis) were unreachable
   from this machine (TLS failure / connection refused respectively). Both are frequently
   cited in this area and may contain numbers I've had to derive elsewhere.
