# Ocean — real-time tropical shoreline water in WebGL2 / three.js r0.185.1

Research brief for an implementer writing the shader today. Every equation below is
written out. Every parameter has a unit and a physical meaning. Sources are inline.
Section 9 lists what I could **not** verify — treat those as gaps, not facts.

Scope: shallow turquoise water over white carbonate sand, breaking surf on a beach,
deeper blue offshore, viewed from eye height (~1.7 m) on the sand.

---

## 0. The five things that actually produce the look

Before the maths, the causal chain, because it determines where to spend effort.

1. **Fresnel at eye height is the master control.** Standing on a beach, water at 3 m
   away is at ~60° incidence (F ≈ 0.05 — essentially a clear window onto the sand);
   water at 30 m is at ~87° incidence (F ≈ 0.75 — essentially a mirror). The
   near-to-far transition from *turquoise transparency* to *bright reflective sheet*
   is not an artistic ramp, it is the Fresnel curve. Get F0 = 0.02 right and this
   falls out for free. §5.1.
2. **The turquoise is Beer–Lambert on a two-way path through water over bright sand.**
   Red is absorbed ~40× faster than blue in pure water. A 0.7-albedo carbonate sand
   bottom under 2 m of water returns roughly (0.12, 0.49, 0.52) linear — that *is*
   the turquoise band. It is entirely driven by depth. §3.
3. **The offshore blue is water-column backscatter**, i.e. what you see when the
   bottom term has died. Different physical term, must be added separately, or the
   deep water goes black. §3.4.
4. **Surf comes from depth-limited breaking**, `H ≤ 0.78·h`. Because that is a
   condition on the bathymetry, the breaker line automatically lands on a depth
   contour and curves around sandbars. No hand-authored splines. §4.
5. **The high-frequency energy in the frame is reflection modulated by wave slope**,
   not by wave height. A ±8° facet tilt sweeps the reflected ray through 16° of sky.
   Tessendorf makes this point explicitly: height fields look nothing like water,
   *slope* fields do. §5.

---

## 1. Wave geometry — Gerstner vs FFT

### 1.1 The Gerstner (trochoidal) wave, exactly

From GPU Gems 1 ch.1, Fernando & Bryan (Finch), *Effective Water Simulation from
Physical Models*
(<https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models>).

Let, for wave *i*:

- `L_i`  — wavelength, **metres**, crest-to-crest.
- `k_i = 2π / L_i` — wavenumber, **rad·m⁻¹**. (GPU Gems calls this `w_i`; I use `k`
  because `ω` is the temporal frequency and conflating them is the #1 source of bugs.)
- `A_i`  — amplitude, **metres**. Wave *height* is `H_i = 2·A_i`.
- `D_i`  — unit horizontal direction, dimensionless `vec2`.
- `ω_i`  — angular temporal frequency, **rad·s⁻¹**.
- `Q_i`  — steepness multiplier, dimensionless.
- `θ_i(x,t) = k_i · (D_i · x) − ω_i·t + φ_i`, with `x` the *undisplaced* horizontal
  position in metres, `φ_i` a random per-wave phase offset in radians.

**Position** (world Y-up; horizontal plane is XZ):

```
P.x = x   + Σ_i  Q_i · A_i · D_i.x · cos(θ_i)
P.z = z   + Σ_i  Q_i · A_i · D_i.y · cos(θ_i)
P.y = SEA + Σ_i        A_i        · sin(θ_i)
```

**Tangent** (∂P/∂x), **binormal** (∂P/∂z), **normal**. Writing `kA_i = k_i·A_i`:

```
T = ( 1 − Σ Q_i·kA_i·D_i.x·D_i.x·sin θ_i ,
          Σ     kA_i·D_i.x        ·cos θ_i ,
        − Σ Q_i·kA_i·D_i.x·D_i.y·sin θ_i )

B = ( − Σ Q_i·kA_i·D_i.x·D_i.y·sin θ_i ,
          Σ     kA_i·D_i.y        ·cos θ_i ,
      1 − Σ Q_i·kA_i·D_i.y·D_i.y·sin θ_i )

N = normalize( cross(B, T) )
```

Or directly, the closed form GPU Gems gives as Equation 12:

```
N = ( −Σ     kA_i·D_i.x·cos θ_i ,
      1 −Σ Q_i·kA_i      ·sin θ_i ,
      −Σ     kA_i·D_i.y·cos θ_i )      // then normalize
```

Cross-checked against Catlike Coding's independent derivation, which gives the same
tangent/binormal structure with `s = Q·k·A`
(<https://catlikecoding.com/unity/tutorials/flow/waves/>).

> **Sign / handedness warning.** `cross(B, T)` vs `cross(T, B)` differs by a sign, and
> the sign depends on whether your D is measured in (x,z) or (x,y) and whether your
> Y axis is up. Test it by rendering `N.y` — it must be ≈ +1 on flat water and dip on
> crest faces, never negative. If your whole ocean is black, this is why.

### 1.2 The looping constraint — the one that bites

GPU Gems, verbatim: *"When the sum `Q_i × w_i × A_i` is greater than 1, the z
component of our normal can go negative at the peaks, as our wave loops over itself.
As long as we select our `Q_i` such that this sum is always less than or equal to 1,
we will form sharp peaks but never loops."*

So the hard budget is:

```
Σ_i  Q_i · k_i · A_i   ≤   1
```

GPU Gems' recommended parameterisation makes this a single artist dial:

```
Q_i = Q / ( k_i · A_i · numWaves )      ⇒   Σ_i Q_i·k_i·A_i = Q,  Q ∈ [0, 1]
```

so `Q` is *literally the fraction of the loop budget you have spent*. `Q = 0` is a
pure sine sum; `Q = 1` is the sharpest non-self-intersecting trochoid.

**Practical corollary for this repo.** If you hold the amplitude-to-wavelength ratio
constant at `ρ = A_i/L_i` (see §1.5), then `k_i·A_i = 2π·ρ` for *every* wave, and

```
Σ_i Q_i·k_i·A_i  =  2π·ρ · Σ_i Q_i        ⇒     Σ_i Q_i  ≤  1 / (2π·ρ)
```

With the current `src/world/ocean.js` table (`ρ ≈ 0.0119` across all 8 bands,
`Q_i` from 0.74 down to 0.40, `Σ Q_i = 4.74`):

```
Σ Q_i·k_i·A_i = 2π·0.0119·4.74 = 0.354
```

**You are using 35% of the loop budget.** There is ~2.8× headroom before crests
self-intersect. If the crests are reading rounder than the reference, that is the
first dial to turn — and it costs nothing.

Same check on mean-square slope (the quantity that sets reflection contrast, §5.3):
for a sum of independent sinusoids, `mss ≈ Σ (k_i A_i)² / 2`. Geometric bands give
`8 · (2π·0.0119)²/2 = 0.0224`; the six chop bands (`ρ ≈ 0.0071`) add
`6 · (2π·0.0071)²/2 = 0.0060`; total **0.028**, against the Cox–Munk target of
`0.003 + 0.00512·5.4 = 0.0306` for a 5.4 m/s wind (§5.3). That is consistent — the
existing table is well founded and I found no error in it.

### 1.3 Dispersion: how fast each wave moves

Deep water (`h > L/2`), from Tessendorf §4 (eq. 32 region) and GPU Gems:

```
ω_i = sqrt( g · k_i )              g = 9.81 m·s⁻²
phase speed  c_i = ω_i / k_i = sqrt(g / k_i) = sqrt(g·L_i / 2π)
group speed  cg_i = c_i / 2
```

Finite depth `h` (metres, still-water depth below sea level) — Tessendorf gives this
explicitly for the shallow case:

```
ω(k) = sqrt( g·k · tanh(k·h) )
```
(<https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf>, §4.2,
"A second situation which modifies the dispersion relation…"; verbatim in the PDF as
`ω(k) = gk tanh(kD)` under a square root.)

Group speed in finite depth:

```
cg = (ω / 2k) · ( 1 + 2·k·h / sinh(2·k·h) )
shallow limit (k·h → 0):  c = cg = sqrt(g·h)
```

**Solving for `k` given a fixed period.** As a wave shoals its *period stays constant*
(Green's law: "the oscillation period of shoaling waves does not change",
<https://en.wikipedia.org/wiki/Green%27s_law>) while `k` grows. So you must invert
`ω² = g·k·tanh(k·h)` for `k` per-vertex. Iterating `tanh` in a vertex shader is
avoidable — Fenton & McKee (1990), *On calculating the lengths of water waves*,
Coastal Engineering 14, 499–513, give an explicit closed form
(<https://johndfenton.com/Papers/Fenton90c+McKee-On-calculating-the-lengths-of-water-waves.pdf>):

```
L  =  L0 · [ tanh( (ω²·h / g)^(3/4) ) ]^(2/3)         with  L0 = g·T² / (2π)
```

Reported accuracy: exact in both the deep-water and shallow-water limits, better than
~1.7% in between. *(Caveat: I read the formula from the abstract and secondary
descriptions — the exponent pair 3/4 and 2/3 is what multiple secondary sources state,
and it is what `src/world/ocean.js` already uses. I could not extract the equation
from the PDF body itself; see §9.)*

In GLSL:

```glsl
// k from angular frequency w and depth h, Fenton & McKee explicit approximation
float kFromOmega(float w, float h) {
    float k0 = w * w / G;                       // deep-water wavenumber, rad/m
    float t  = tanh(pow(k0 * h, 0.75));
    return k0 / pow(t, 2.0 / 3.0);              // k >= k0, i.e. L shortens inshore
}
```

### 1.4 Shoaling, breaking, and the shore-parallel crest

Three effects, all needed, all cheap.

**(a) Amplitude growth — Green's law.** Energy flux `E·cg` is conserved along a ray,
so `A ∝ cg^(-1/2)`. Wikipedia states the shallow-water special case exactly:
`H·b^(1/2)·h^(1/4) = constant`, i.e. `H ∝ h^(-1/4)` for constant channel width — waves
double in height when depth drops by 16× (<https://en.wikipedia.org/wiki/Green%27s_law>).
Use the general form so it is valid in intermediate depth too:

```
Ks = sqrt( cg(k0, h0) / cg(k, h) )      // shoaling coefficient, dimensionless
A  = A_deep · Ks
```

Typical values: `Ks` dips slightly *below* 1 (≈0.91) around `h/L₀ ≈ 0.15` before
rising steeply; it reaches ≈1.3 at `h ≈ 0.05·L₀`. That small initial dip is real and
worth keeping — it is why swell looks momentarily flatter just outside the surf.

**(b) Amplitude clipping — the breaker.** McCowan's solitary-wave criterion, the
standard first estimate in coastal engineering:

```
H_b / h_b = γ = 0.78            ⇒   A ≤ 0.39 · h
```
(<https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/05:_Coastal_hydrodynamics/5.02:_Wave_transformation/5.2.5:_Wave_breaking>,
which attributes γ ≈ 0.78 to solitary-wave theory / McCowan 1894.)

Also apply the Miche steepness limit for deep and intermediate water:

```
H ≤ (L/7) · tanh(k·h)      →  deep-water limit H/L ≤ 1/7 = 0.143
```

**The amount of amplitude you removed is the breaking intensity.** That scalar is the
foam source (§4.3). Store it.

```glsl
float A_shoaled = A_deep * Ks;
float A_limit   = min(0.39 * h, (L / 14.0) * tanh(k * h));   // A = H/2
float A_final   = min(A_shoaled, A_limit);
float breaking  = max(0.0, A_shoaled - A_final) / max(A_shoaled, 1e-4); // 0..1
```

**(c) Refraction — crests turn parallel to the beach.** Waves obey Snell's law with
`c(h)` playing the role of `1/n`: `sin(α)/c = const` along a ray. The shallow part of
a crest slows first, so the crest bends toward the depth contours
(<https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/05:_Coastal_hydrodynamics/5.02:_Wave_transformation/5.2.3:_Refraction>,
<https://www.coastalwiki.org/wiki/Refraction>).

The cheap and stable version: rotate each wave's direction toward the local
bathymetry gradient by an amount that grows as it shoals, rather than integrating rays.

```glsl
vec2 nBed  = normalize(vec2(dHdx, dHdz));   // uphill = shoreward, from the depth texture
float bend = 1.0 - clamp(h / (0.5 * L0), 0.0, 1.0);   // 0 offshore, →1 in the shallows
vec2 D     = normalize( mix(D_deep, nBed, bend * 0.85) );
```

Visually this is *the* thing that turns a generic sea into a beach. Without it you get
crests at a fixed angle marching diagonally onto the sand, which reads instantly as
wrong.

**(d) Front-face pitching.** A real shoaling wave is not sinusoidal in *phase* either:
the front face steepens and the back flattens. Skew the phase:

```
θ' = θ + s·sin(θ),      s ramps 0 → ~0.6 as the wave shoals
```
This is a classic sawtoothing trick, not a physical derivation — it produces the
pitched bore profile. `src/world/ocean.js` already does this.

### 1.5 A concrete 6–12 wave shoreline table

**Why constant `A/L`.** The Phillips spectrum is `P_h(k) = A·exp(−1/(kL_w)²)·|k̂·ŵ|²/k⁴`
(Tessendorf eq. 40, verbatim from the course notes; `L_w = V²/g` is the largest wave a
wind of speed `V` can raise). If you sample it in *logarithmic* bands (`Δk ∝ k`, which
is what a geometric wavelength ladder is), the height variance in band *i* is
`σ_i² ∝ k⁻⁴·k·k = k⁻²`, so `A_i ∝ 1/k_i ∝ L_i`. **Constant amplitude-to-wavelength
ratio is the Phillips-consistent choice for a geometric ladder**, which is also what
GPU Gems recommends on purely practical grounds ("we use a constant (or scripted)
ratio… the ratio of its amplitude to its wavelength will match the ratio of the median
amplitude to the median wavelength"). Two independent routes to the same rule.

**Recommended structure for a shoreline (10 geometric + 6 normal-only):**

| Role | Count | Wavelength span | `A/L` (ρ) | Direction spread about shore-normal | Purpose |
|---|---|---|---|---|---|
| Swell / geometric | 8–10 | `2·Lp` down to `0.08·Lp`, geometric ratio ≈ 1.45 | 0.012–0.022 | **±20°**, narrowing to ±6° inshore via refraction | crests, breakers, silhouette |
| Chop / normal-only | 5–7 | 2.0 m down to 0.2 m, ratio ≈ 1.55 | 0.006–0.008 | ±90° (genuinely short-crested wind sea) | slope texture, glint breakup |
| Ripple / texture | — | < 0.2 m | — | isotropic | normal map, §5.4 |

Two presets. `Lp` = peak (dominant) wavelength.

**Preset A — "lagoon chop", calm tropical shore, `Lp = 12 m`, `ρ = 0.020`, `Q = 0.80`:**

| i | L (m) | A (m) | H = 2A (m) | T = √(2πL/g) (s) | dir (° from shore-normal) |
|---|---|---|---|---|---|
| 0 | 24.0 | 0.480 | 0.96 | 3.93 | −4 |
| 1 | 16.6 | 0.332 | 0.66 | 3.27 | +7 |
| 2 | 11.4 | 0.229 | 0.46 | 2.71 | −11 |
| 3 | 7.9  | 0.158 | 0.32 | 2.25 | +14 |
| 4 | 5.4  | 0.109 | 0.22 | 1.87 | −18 |
| 5 | 3.8  | 0.075 | 0.15 | 1.55 | +21 |
| 6 | 2.6  | 0.052 | 0.10 | 1.29 | −26 |
| 7 | 1.8  | 0.036 | 0.07 | 1.07 | +31 |

`Σ Q_i k_i A_i = Q = 0.80` when `Q_i = Q/(k_i A_i · 8)`. mss ≈ `8·(2π·0.02)²/2 = 0.063`
— that is quite rough; drop `ρ` to 0.015 for a glassier sea (mss 0.036).

**Preset B — "tropical swell", `Lp = 45 m`, `ρ = 0.010`, `Q = 0.85`, 10 waves:**
wavelengths 90, 62, 43, 30, 21, 14.5, 10, 7, 4.8, 3.3 m; amplitudes = `0.010·L`;
directions ±(3, 6, 9, 13, 17, 21, 26, 31, 37, 44)° alternating sign.
`H` for the dominant = 0.86 m, `T` = 5.4 s at 43 m. Breaks (`A = 0.39h`) at `h ≈ 1.1 m`.

**Where the breaker line lands.** For a wave of deep amplitude `A₀`, breaking occurs
where `A₀·Ks(h) = 0.39·h`. On a 1:30 beach slope, Preset B's dominant wave
(`A₀ = 0.43 m`) breaks around `h ≈ 1.3 m`, i.e. ~39 m offshore. Preset A's
(`A₀ = 0.48 m`) breaks around `h ≈ 1.5 m`. Tune the beach slope to put the surf where
you want it; do not tune the criterion.

**Randomising phases.** Give each wave `φ_i = 2π·rand()`. Without this all crests
coincide at `x = 0, t = 0` and you get one enormous wave leaving the origin.

**Avoid rational wavelength ratios.** If `L_i/L_j` is a simple rational number the sum
is exactly periodic and you will see a repeating quilt. Use irrational-ish ratios
(1.45, 1.47, 1.43 …) rather than a clean 1.5.

### 1.6 Gerstner vs FFT (Tessendorf) — the decision, for a shoreline

**Tessendorf's FFT method** (course notes,
<https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf>), the
equations verbatim:

```
h̃₀(k)   = (1/√2)·(ξ_r + i·ξ_i)·√( P_h(k) )                        (eq. 42)
h̃(k,t)  = h̃₀(k)·exp{ i·ω(k)·t } + h̃₀*(−k)·exp{ −i·ω(k)·t }        (eq. 43)
D(x,t)  = Σ_k  −i·(k/|k|)·h̃(k,t)·exp( i·k·x )                     (eq. 44)
P_h(k)  = A·exp( −1/(k·L_w)² ) / k⁴ · |k̂·ŵ|²                       (eq. 40)
                                     × exp( −k²·ℓ² )               (eq. 41)
```

with `ξ_r, ξ_i` ~ N(0,1); `L_w = V²/g`; `ŵ` the wind unit vector; `ℓ` a small-wave
cutoff length in metres. Tessendorf's own stated practical ranges: grid `N, M` between
16 and 2048, "128 to 512 sufficient for many situations"; grid spacing `dx = Lx/M`
"need never go below 2 cm"; his worked example is `M = N = 512`, `Lx = Lz = 1000 m`,
`V = 31 m/s`, `ℓ = 1 m`. Raising the directional exponent from `|k̂·ŵ|²` to `|k̂·ŵ|⁶`
visibly aligns the sea with the wind — a free directionality dial.

**FFT wins** for open ocean: unlimited wave count, correct statistics, free
whitecap-from-Jacobian, and it is what Sea of Thieves shipped
(<https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf>).

**Gerstner wins for a shoreline**, and it is not close:

- FFT gives you a *spatially homogeneous* sea. A beach is the opposite: every wave
  parameter (`k`, `A`, direction, phase skew) must be a function of the local depth.
  You cannot re-solve dispersion per-texel inside an FFT — the whole point of the FFT
  is that `ω` is a function of `k` alone.
- Shoaling, refraction, and depth-limited breaking are all per-position operations.
  With Gerstner they are ~8 extra ALU per wave per vertex. With FFT you would need
  a cascade of FFTs blended by depth, which is what Crest does and which is a lot of
  machinery (<https://crest.readthedocs.io/en/4.12/user/ocean-simulation.html>).
- WebGL2 has no compute shaders. A GPU FFT via ping-pong fragment passes is doable
  (butterfly texture + `log2(N)` passes × 2 axes × 3 fields) but it is a big chunk of
  frame budget for a scene where the water is a strip, not a hemisphere.

**Recommendation: Gerstner for geometry, FFT-like statistics for the *distribution*.**
Use the Phillips shape to pick `A_i(L_i)` and the directional factor `|k̂·ŵ|²` to pick
the spread, then evaluate as a Gerstner sum. You get FFT's realism of *distribution*
with Gerstner's per-position controllability. This is exactly what UE5's Water plugin
does — it exposes Gerstner as the default wave model but lets you drive its parameters
from a Pierson-Moskowitz or JONSWAP spectrum, with 16 waves by default
(<https://dev.epicgames.com/documentation/en-us/unreal-engine/simulating-waves-using-the-water-waves-asset-in-unreal-engine>,
<https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Water/UGerstnerWaterWaves>).

### 1.7 Tessellation: the Nyquist rule

GPU Gems ch.1 §1.3.3, and it is worth obeying literally: you need vertices separated by
**at most half** the shortest wavelength you displace with. Their scheme, which is
better than a fixed cutoff: store the minimum edge length in each vertex's
neighbourhood, and attenuate each wave with a ramp that is **1 when `L = 4·edge` and
0 when `L = 2·edge`**.

```glsl
float lodFade = smoothstep(2.0 * edgeLen, 4.0 * edgeLen, L_i);
A_i *= lodFade;
```

Move the removed amplitude into the per-pixel normal band (§5.3) rather than deleting
it, or the sea flattens with distance.

---

## 2. Depth: the field everything hangs off

You need, per pixel and per vertex, the **still-water depth `h`** (metres, positive
under water) and ideally the **instantaneous depth** `h + η` where `η` is the current
wave elevation.

Two sources, use both:

1. **Baked bathymetry texture.** Sample the terrain heightfield once at init over the
   nearshore rectangle into an `R32F`/`R16F` texture. Gives `h` at vertices for
   shoaling, and `dHdx/dHdz` for refraction. This is authoritative and stable.
   `src/world/ocean.js` already does this.
2. **Depth buffer, per pixel.** For the *rendered* water-column path length (§3), you
   need the distance from the water surface to whatever opaque thing is behind it,
   which the bathymetry texture cannot give you (it does not know about rocks, the
   player's legs, or a Warthog).

In three.js r0.185.1 with WebGL2, render the opaque pass to an RT with a
`DepthTexture` (`THREE.DepthTexture`, `type: UnsignedIntType` or `FloatType`), then in
the water fragment shader:

```glsl
#include <packing>   // three's chunk; gives perspectiveDepthToViewZ, viewZToOrthographicDepth

uniform sampler2D uSceneDepth;
uniform vec2  uInvRes;
uniform float uNear, uFar;

float sceneViewZ(vec2 fragUV) {
    float d = texture(uSceneDepth, fragUV).x;             // [0,1] window-space depth
    return perspectiveDepthToViewZ(d, uNear, uFar);       // negative, metres
}

void main() {
    vec2 uv = gl_FragCoord.xy * uInvRes;
    float zScene   = sceneViewZ(uv);                      // -metres
    float zSurface = vViewPosition.z;                     // -metres, this fragment
    float columnAlongView = max(0.0, zSurface - zScene);  // metres along the eye ray
    ...
}
```

`perspectiveDepthToViewZ` is present in `three/src/renderers/shaders/ShaderChunk/packing.glsl.js`
in r0.185.1 (verified locally alongside `packDepthToRGBA`, `unpackRGBAToDepth`, etc.).

> **`columnAlongView` is not `h`.** It is the slant path through the water along the
> eye ray, which at grazing incidence is enormous. That is correct for absorption
> (§3.2) but wrong for anything that wants "how deep is it here" (foam, wave
> attenuation). Keep both quantities and do not mix them up. This confusion produces
> the failure mode where the entire distant sea turns opaque navy (§8, item 6).

---

## 3. The tropical shallow-water look

### 3.1 Radiometric decomposition

At the surface point, the outgoing radiance splits cleanly:

```
L_out = F(θ)·L_reflected  +  (1 − F(θ))·L_upwelling
```

with `L_upwelling` itself split into a **bottom** term and a **water-column** term:

```
L_upwelling  =  ρ_bottom · E_down · T_two_way(d)      // bottom-reflected, dies with depth
             +  L_deep · (1 − T_two_way(d))           // volume backscatter, saturates
             +  L_translucent                          // §3.5, forward-scattered sun through crests
```

This is the standard optically-shallow-water form used in ocean colour remote sensing
(Lyzenga 1978, Maritorena et al. 1994, Lee et al. 1998), where the observed reflectance
is written as a deep-water term plus a bottom term attenuated by `exp(−2·K·d)`.
*(I found consistent secondary descriptions of this structure — e.g.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC4208206/>, <https://github.com/teongu/lyzenga1978> —
but could not open the original Lyzenga 1978 paper to quote the exact symbol
convention. See §9.)*

### 3.2 Beer–Lambert, and why the path is two-way

Light must go **down** to the sand and **back up** to the eye:

```
T(λ, d) = exp( −K(λ) · ( d/cos θ_sun'  +  d/cos θ_view' ) )
```

where `θ_sun'` and `θ_view'` are the **refracted** (in-water) angles from Snell's law
with `n_water = 1.333`. The refracted view angle is bounded: even at 90° incidence,
`θ_view' ≤ asin(1/1.333) = 48.6°`, so `1/cos θ_view' ≤ 1.51`. **In-water path length
never blows up**, which is why water stays legible at grazing angles. If your water
goes solid navy toward the horizon, you skipped the refraction and used the air-side
angle.

For a sun near the zenith and a moderate view angle, `≈ 2·d` is a fine approximation
and is the form the remote-sensing literature uses (`exp(−2·K·d)`).

```glsl
const float N_WATER = 1.333;
float cosInWater(float cosAir) {
    float sinAir = sqrt(max(0.0, 1.0 - cosAir * cosAir));
    float sinW   = sinAir / N_WATER;                  // Snell
    return sqrt(max(0.0, 1.0 - sinW * sinW));         // >= cos(48.6°) = 0.661
}
float pathLen(float depth, float cosSunAir, float cosViewAir) {
    return depth * (1.0 / cosInWater(cosSunAir) + 1.0 / cosInWater(cosViewAir));
}
```

### 3.3 Actual extinction coefficients

Pure-water absorption, **Pope & Fry (1997)**, from the OMLC compendium
(<https://omlc.org/spectra/water/data/pope97.txt>, header units 1/cm; ×100 → m⁻¹;
index page <https://omlc.org/spectra/water/abs/index.html>):

| λ (nm) | a (m⁻¹) | | λ (nm) | a (m⁻¹) |
|---|---|---|---|---|
| 440 | 0.00635 | | 600 | 0.2224 |
| 450 | 0.00922 | | 620 | 0.2755 |
| 490 | 0.0150  | | 650 | 0.340  |
| 510 | 0.0325  | | 680 | 0.465  |
| 550 | 0.0565  | | 700 | 0.624  |

Band-averaging over rough sRGB primary supports (R ≈ 590–700, G ≈ 490–580, B ≈ 400–500):

```
a_pure ≈ vec3( 0.39, 0.045, 0.010 )   m⁻¹
```

Red is absorbed **39× faster than blue**. That single ratio is the entire colour story.

Real tropical shore water is not pure — it carries CDOM and resuspended carbonate
fines. Add a roughly flat-to-blue-weighted term. Recommended starting extinction for
a **clear tropical lagoon over sand**:

```glsl
// metres^-1. Total attenuation for the two-way bottom path.
const vec3 K_WATER = vec3(0.45, 0.090, 0.045);
```

Sanity: Jerlov oceanic type IA has `Kd ≈ 0.035–0.040 m⁻¹` (blue-green band) and type
III `0.115–0.14 m⁻¹`; coastal types are higher still
(<https://aslopubs.onlinelibrary.wiley.com/doi/10.1002/lol2.10338>,
<https://opg.optica.org/ao/abstract.cfm?uri=ao-54-17-5392>). `K_B = 0.045` sits
between Jerlov IA and IB — appropriate for a clear-but-not-abyssal lagoon.

**Dial for artistic control:** scale `K` up uniformly for murkier water (the turquoise
band narrows and moves inshore), or lower `K.r` alone to push the shallows toward
green rather than cyan.

### 3.4 The turquoise band, computed

Carbonate ("white coral") sand is bright and blue-weighted-flat across the visible;
reflectance rises from 400 to ~565 nm then falls slightly to 650
(Hochberg et al. 2003, *Spectral reflectance of coral reef bottom-types worldwide*,
<https://www.sciencedirect.com/science/article/abs/pii/S0034425702002018>). Take a
linear-space bottom albedo:

```glsl
const vec3 SAND_ALBEDO = vec3(0.75, 0.70, 0.62);   // dry-carbonate-ish, linear
```

Then with `T(d) = exp(−2·K·d)` and `K = (0.45, 0.090, 0.045)`:

| depth h (m) | T(h) = exp(−2Kh) | bottom colour `SAND·T` (linear) | reads as |
|---|---|---|---|
| 0.10 | (0.914, 0.982, 0.991) | (0.686, 0.687, 0.615) | wet sand, barely tinted |
| 0.25 | (0.798, 0.956, 0.978) | (0.598, 0.669, 0.606) | pale sand, faintly green |
| 0.50 | (0.638, 0.914, 0.956) | (0.478, 0.640, 0.593) | first hint of green |
| 1.0  | (0.407, 0.835, 0.914) | (0.305, 0.585, 0.567) | **green-cyan** |
| 2.0  | (0.165, 0.698, 0.835) | (0.124, 0.489, 0.518) | **turquoise** |
| 3.0  | (0.067, 0.583, 0.763) | (0.050, 0.408, 0.473) | strong teal |
| 4.0  | (0.027, 0.487, 0.698) | (0.020, 0.341, 0.433) | deep teal |
| 6.0  | (0.0045, 0.340, 0.583) | (0.003, 0.238, 0.362) | blue-teal |
| 8.0  | (0.0007, 0.237, 0.487) | (0.001, 0.166, 0.302) | blue |
| 15.0 | (~0, 0.067, 0.260) | (~0, 0.047, 0.161) | bottom essentially gone |

**This is the Halo/tropical look and it is not hand-authored.** The turquoise band sits
where `2·K_r·h ≈ 1.5–2.5`, i.e. **h ≈ 1.7–2.8 m** for these coefficients. Its
*horizontal* width on screen is entirely the beach slope: on a 1:30 slope the band
occupies 33 m of shore-normal distance; on 1:10 it is 11 m and looks like a hard rim.
**If your turquoise band is too narrow, flatten the seabed, don't touch the colour.**

Then add the deep-water volume term, which takes over as the bottom term dies:

```glsl
// L_deep: what open water backscatters. Small, blue, and NOT the same as the shallow colour.
const vec3 DEEP_SCATTER = vec3(0.004, 0.030, 0.075);   // linear radiance factor × ambient

vec3 upwelling(float h, float cosSun, float cosView, vec3 sandLit) {
    float s = pathLen(h, cosSun, cosView);
    vec3  T = exp(-K_WATER * s);
    return sandLit * T + DEEP_SCATTER * (1.0 - T);
}
```

Two independent misconceptions this fixes:
- Without `DEEP_SCATTER`, deep water goes **black**, not blue.
- Without the `(1 − T)` weight, shallow water gets a spurious blue haze added on top of
  bright sand and the whites go grey.

### 3.5 Subsurface / translucency — the lit crest

The single most recognisable "tropical" cue after the depth ramp: when the sun is
behind or beside a shoaling crest, the crest **glows green** because light travels a
short path through the thin wall of water and forward-scatters to the eye.

Sea of Thieves' documented approach: *"We blend between a deep water colour and a
sub-surface water colour based on a combination of view angle, sun direction and a
wave peak mask. The wave peak mask is generated from the FFT choppiness vertex
offsets. Where the choppiness offset is greater, this corresponds to wave peaks, which
show more sub-surface due to shorter distance traveled by light through the water."*
(<https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf>)

The concrete formula to use is Barré-Brisebois & Bouchard's GDC 2011 translucency
approximation (shipped in Frostbite 2), verbatim:

```hlsl
half3 vLTLight = vLight + vNormal * fLTDistortion;
half  fLTDot   = pow(saturate(dot(vEye, -vLTLight)), iLTPower) * fLTScale;
half3 fLT      = fLightAttenuation * (fLTDot + fLTAmbient) * fLTThickness;
```
(<https://colinbarrebrisebois.com/2011/03/07/gdc-2011-approximating-translucency-for-a-fast-cheap-and-convincing-subsurface-scattering-look/>,
<https://www.ea.com/frostbite/news/approximating-translucency-for-a-fast-cheap-and-convincing-subsurface-scattering-look>)

Adapted for water, with the **thickness driven by the Gerstner horizontal displacement
magnitude** (the Sea of Thieves trick — the pinch *is* the peak):

```glsl
// suggested starting values
const float LT_DISTORTION = 0.25;   // dimensionless: how far the light dir is bent by N
const float LT_POWER      = 4.0;    // dimensionless: tightness of the forward lobe
const float LT_SCALE      = 2.4;    // dimensionless: overall gain
const vec3  SSS_COLOUR    = vec3(0.10, 0.55, 0.45);  // linear; green-teal, NOT the deep colour

// horizDisp = length of the summed Gerstner XZ offset, metres.
// Normalise by the maximum possible (Σ Q_i·A_i) so thickness is 0..1.
float peakMask  = clamp(horizDisp / maxHorizDisp, 0.0, 1.0);
float thinness  = peakMask * smoothstep(0.0, 1.0, elevation / maxElevation);

vec3  ltLight   = sunDir + N * LT_DISTORTION;
float ltDot     = pow(clamp(dot(V, -ltLight), 0.0, 1.0), LT_POWER) * LT_SCALE;
vec3  sss       = sunColour * SSS_COLOUR * (ltDot + 0.12) * thinness;
```

Failure mode to watch for: if you drive `thinness` from height alone rather than the
displacement pinch, *every* wave top glows, including flat offshore swell, and the sea
looks like backlit green plastic sheeting.

### 3.6 Caustics on the sand

Caustics are what stop the shallow band from reading as a flat gradient. They also
carry real high-frequency energy, which matters for this project's lap_var target.

Practical, no-simulation approach (used by the Moana ShaderToy, which is a very close
visual target for tropical shallow water —
<https://wallisc.github.io/rendering/2020/12/08/Making-Of-Moana-the-shadertoy.html>,
which uses "smooth voronoi noise that's distorted, then sampled via xz position", and
by essentially every stylised water shader):

```glsl
// Two counter-rotating layers of Voronoi/Worley F1, min-combined, gives the
// characteristic web with sharp bright filaments rather than blobs.
float caustic(vec2 p, float t) {
    float a = voronoiF1(p * 1.7 + vec2( 0.11, -0.07) * t);
    float b = voronoiF1(p * 2.3 * ROT13 + vec2(-0.09,  0.13) * t);
    float c = 1.0 - min(a, b);
    return pow(c, 6.0);            // exponent 4..8: higher = thinner, brighter filaments
}
```

Three modulations that must be present or it looks pasted on:

1. **Project along the refracted sun ray, not straight down.** Offset the sample
   position by `depth · tan(θ_sun') · sunAzimuthDir`. Without this the caustic web
   does not slide as the sun moves and does not shear on a sloping seabed.
2. **Attenuate with depth**, `× exp(−K_g · d)` — caustics are essentially gone by
   6–8 m, and are *strongest* at 0.3–1.5 m.
3. **Fade with wave slope variance.** Choppy water defocuses the caustic. Multiply by
   `1 − clamp(mss_local/0.05, 0, 1)`. The band right under the breakers should have
   almost no caustic; the glassy patch between sets should have a lot.
4. **Multiply by the sun's shadow term.** Caustics inside a rock's shadow are the most
   noticeable single-frame giveaway of a fake water shader.

Caustic contrast should be roughly ±35% of local irradiance, not 0→1.

---

## 4. The shoreline

### 4.1 The two fields you need

- `h(x,z)` — still-water depth, from the bathymetry texture. Metres.
- `d_shore(x,z)` — signed distance to the still-water line, or equivalently just use
  `h` with a sign. Metres.

Both should be **advected by the instantaneous wave elevation**, i.e. compute
`h_inst = h + η(x,z,t)` where `η` is the summed Gerstner elevation. Almost every
"static bathtub ring" artefact comes from evaluating shore effects against `h` rather
than `h_inst`.

### 4.2 Wet-sand darkening

**Physics.** Lekner & Dorf (1988), *Why some things are darker when wet*, Applied
Optics 27(7), 1278 (<https://opg.optica.org/ao/abstract.cfm?uri=ao-27-7-1278>): a
water film over a rough diffuse substrate lets light that would have escaped undergo
**total internal reflection** at the water/air interface and be sent back into the
grains, giving it more chances to be absorbed. Twomey, Bohren & Mergenthaler (1986),
*Reflectance and albedo differences between wet and dry surfaces*, Applied Optics
25(3), 431, add the second mechanism: replacing air with water around the grains drops
the relative refractive index, which increases the scattering asymmetry parameter `g`
(they model dry `g ≈ 0.7`, wet `g ≈ 0.9`), so photons need more scattering events to
escape (<https://pubmed.ncbi.nlm.nih.gov/18231193/>,
<https://www.semanticscholar.org/paper/c24faf959e8b07337ae37490f9afb265c3190569>).

**Practical model.** Three changes, all needed:

```glsl
// wetness w in [0,1]
vec3  albedoWet    = SAND_ALBEDO * mix(1.0, 0.55, w);   // darken ~45% at full wet
float roughnessWet = mix(roughDry, 0.18, w);            // a water film is SMOOTH
float f0Wet        = mix(0.04, 0.02, w);                // top interface becomes water
// and the sand normal flattens as the film fills the micro-relief:
vec3  nWet         = normalize(mix(nSand, vec3(0,1,0), w * 0.6));
```

The 0.55 factor is the standard "wet sand is about half as bright" rule of thumb and
sits inside the range Twomey/Bohren report for natural sediments; I did **not** find a
single authoritative number for carbonate beach sand specifically (§9). Tune against
the reference frames, but keep the *roughness drop* — a darkened-but-still-rough sand
reads as mud. The bright sheen of a receding wave is the roughness change, not the
albedo change.

**Wetness field.** Wetness should be *set* instantly by water coverage and *decay*
slowly, so the swash leaves a trailing dark band:

```glsl
// per-frame, in a small persistent R8 texture over the beach strip
float covered = step(waterSurfaceY, sandY + 0.005);
wet = max(wet * exp(-dt / TAU_DRY), covered);
// TAU_DRY: 20–60 seconds. Godot/Unity shoreline implementations commonly use ~45 s.
```
(45 s is quoted in a Godot shoreline implementation described at
<https://reboot16.itch.io/godot-rsw>; treat it as a plausible artistic value, not a
measurement.)

The wet/dry boundary must be **ragged**, not a smooth contour: offset the threshold by
a low-frequency noise of amplitude ~15 cm along the shore. A perfectly smooth wet line
is instantly readable as CG.

### 4.3 Foam — where it comes from

Four independent sources. You want at least the first three.

**(a) Depth-limited breaking.** From §1.4: `breaking = (A_shoaled − A_final)/A_shoaled`.
This is a smooth 0..1 field that is nonzero exactly on the depth contour where the
swell exceeds `0.78·h`. It gives you the **surf line**, and it curves around sandbars
for free.

**(b) Surface folding — the Jacobian.** Tessendorf's criterion, verbatim from the
course notes (eq. 45–46 region):

```
J(x) = Jxx·Jyy − Jxy·Jyx
Jxx  = 1 + λ·∂Dx/∂x
Jyy  = 1 + λ·∂Dy/∂y
Jxy  = λ·∂Dx/∂y ,   Jyx = λ·∂Dy/∂x
```

and the analytic eigenvalues (eq. 47):

```
J± = ½(Jxx + Jyy) ± ½·sqrt( (Jxx − Jyy)² + 4·Jxy² )
```

Tessendorf: *"The criterion for folding that J < 0 means that J₋ < 0 and J₊ > 0. So
the minimum eigenvalue is the actual signal of the onset of folding."* Use `J₋`, not
`J`, because `J₋` degrades gracefully — it goes 1 → 0 → negative, so you can inject
foam *before* the fold with `foam = smoothstep(0.35, -0.05, Jminus)`.

For a Gerstner sum the horizontal displacement is analytic, so:

```glsl
// D = Σ Q_i A_i D_i cos θ_i   ⇒   ∂D/∂x needs Σ Q_i A_i k_i D_i.x D_i.x sin θ_i etc.
// You already compute these for the tangent/binormal — reuse them, don't recompute.
float Jxx = T.x;                       // = 1 − Σ Q kA Dx Dx sin θ
float Jyy = B.z;                       // = 1 − Σ Q kA Dz Dz sin θ
float Jxy = T.z;                       // = −Σ Q kA Dx Dz sin θ   (== B.x)
float tr  = Jxx + Jyy;
float disc = sqrt(max(0.0, (Jxx - Jyy) * (Jxx - Jyy) + 4.0 * Jxy * Jxy));
float Jminus = 0.5 * (tr - disc);
float foamFold = smoothstep(0.40, -0.05, Jminus);
```

This is a **free** foam source: the terms are already in your tangent frame.

**(c) Shore proximity.** Crest's model, and it is the right shape: foam accumulates
where the water is shallow regardless of breaking, because turbulence reaches the bed.
Crest exposes exactly `Shoreline Foam Max Depth` and `Shoreline Foam Strength`
(<https://crest.readthedocs.io/en/4.12/user/ocean-simulation.html>).

```glsl
float foamShore = smoothstep(SHORE_FOAM_MAX_DEPTH, 0.0, h_inst) * SHORE_FOAM_STRENGTH;
// SHORE_FOAM_MAX_DEPTH: 0.6–1.2 m for a gentle beach.
```

**(d) Object intersection.** Depth-buffer comparison against the water plane —
Sea of Thieves does this in "a camera centred window using depth buffer comparisons".
`foamObj = 1 − smoothstep(0, 0.35, columnAlongView)` gives the collar around rocks and
legs. 0.35 m is a good width.

### 4.4 Foam — how it should behave and look

The single biggest quality lever is **advection + decay**, not the texture.

Maintain a foam field `Fₜ` in an R8/R16F texture covering the nearshore rectangle
(0.5–1.0 m per texel is plenty; the field carries the *envelope*, not the bubbles):

```glsl
// each frame, one full-screen-ish pass over the foam RT
vec2  uvPrev = uv - flowVelocity * dt * invRectSize;   // advect with the Stokes drift
float f      = texture(uFoamPrev, uvPrev).r;
f *= exp(-dt / TAU_FOAM);                              // TAU_FOAM: 1.5–4.0 s
f  = max(f, foamFold + foamShore + foamObj + 1.6 * breaking);
outFoam = clamp(f, 0.0, 1.0);
```

`flowVelocity`: the Stokes drift plus the swash, roughly `0.15·c·(kA)²` shoreward for
the dominant wave, which for Preset B is ~0.1–0.3 m/s. Sea of Thieves progressively
blurs their foam buffer with feedback "to simulate the foam dispersing"; a 1-tap
bilinear read at an offset UV already gives you most of that for free.

**Then overlay procedural lace at render time.** A 1 m texel cannot hold a bubble, but
it can hold "there is foam here". At shading time:

```glsl
float env  = texture(uFoamField, worldUV).r;              // 0..1 envelope
float lace = fbm(worldXZ * 3.0 + flow * t, 4);            // 3 cyc/m, 4 octaves
float bub  = voronoiF1(worldXZ * 11.0 + flow * t * 1.3);  // 11 cyc/m — bubble scale
float mask = smoothstep(0.55, 0.95, env * (0.55 + 0.45 * lace) + 0.25 * (1.0 - bub));
```

**Foam shading, which people get wrong:**

- Foam albedo is **0.6–0.8 linear, not 1.0**. Pure white foam reads as a decal.
- Foam is **lit** — it takes the sun's `N·L` and the sky ambient. Unlit foam looks
  like fog.
- Foam is **rough** (roughness ≈ 0.8) and dielectric, so it kills the Fresnel
  reflection underneath: `F_eff = mix(F, 0.03, foamMask)`. Foam that still mirrors the
  sky looks like white paint on glass.
- Foam should **not** appear on already-wet sand above the waterline — mask it by
  `1 − wetSandMask` there, or the beach looks snowed on.

### 4.5 Surf lines without a fluid sim

Three layers, superimposed. Each is cheap.

**Layer 1 — the breaker line (physical).** Already have it: `breaking` from §1.4 is
nonzero on a depth contour, and because each of the 8–10 waves has its own phase,
you get **sets** — several parallel foam lines at different distances, appearing and
disappearing, which is exactly what a real beach does. This is the payoff for
per-wave shoaling.

**Layer 2 — the bore / whitewater sheet.** Inside the break point the wave is a
translating bore. Model it as a *phase-locked* travelling band in the shore-normal
coordinate `u = d_shore` rather than as a wave:

```glsl
// nWaves ≈ 2.5–3.5 visible surf lines between break point and swash
float phase = fract(u / SURF_SPACING - t / SURF_PERIOD);   // SURF_SPACING ~ 9 m, PERIOD ~ 5.5 s
float bore  = smoothstep(0.90, 1.00, phase) * smoothstep(BREAK_DEPTH, 0.0, h);
```
This is essentially the Cyanilux shoreline construction (`fract` or `cos(TAU··)` of a
shore gradient minus time, remapped with `smoothstep`, faded seaward by a second
`smoothstep`) — <https://www.cyanilux.com/tutorials/shoreline-shader-breakdown/>.

**Layer 3 — the swash / uprush on dry sand.** The thin sheet that runs up the sand and
drains back. Drive it with a **cosine, not a fract**, because the run-up decelerates
and reverses:

```glsl
float s      = cos(t * SWASH_RATE + SWASH_OFFSET);        // -1..1
float runup  = SWASH_MAX * (0.5 + 0.5 * s);               // metres up the beach, ~0.4–1.2 m
float edge   = u - runup + 0.15 * voronoiF1(alongShore * 2.0);  // ragged, not straight
float sheet  = smoothstep(0.06, 0.0, edge);
```
Cyanilux's version uses exactly this: a `Cosine` of `Time × ScrollSpeed × WaveCount × TAU`
with a hand-tuned "Time Offset" (≈ −2.5 for a wave count of 3.2) to phase-lock the
swash to the incoming lines, a Voronoi × 0.15 added to the offset for raggedness, and
a sand/water boundary from a `smoothstep` with edges 0.85/0.84. Match the swash
frequency to the *dominant wave period*, not to the surf line spacing, or the surf and
the swash visibly decouple and it looks like two unrelated animations.

The swash sheet should be: thin (a few mm), near-mirror (roughness 0.05), foamy at its
leading edge only, and it should leave `wet = 1` behind it (§4.2).

---

## 5. Water shading

### 5.1 Fresnel

Water's refractive index is `n = 1.333` (Tessendorf states `n = 4/3` for water). Normal
incidence reflectance:

```
F0 = ( (n1 − n2) / (n1 + n2) )²  =  ( (1 − 1.333) / (1 + 1.333) )²  =  0.0204
```

three.js's own `Water.js` in r0.185.1 hard-codes exactly this (`float rf0 = 0.02;`,
verified locally in `node_modules/three/examples/jsm/objects/Water.js`, and again in
the TSL `WaterMesh.js`). **Use 0.02. Not 0.04.** 0.04 is the generic dielectric default
and it makes water look like polished plastic in the near field.

Schlick:

```
F(θ) = F0 + (1 − F0)·(1 − cos θ)⁵     with cos θ = max(0, dot(N, V))
```

Concrete values, and this is the table to keep on screen while tuning:

| cos θ | incidence | F | what you're looking at, eye 1.7 m |
|---|---|---|---|
| 1.00 | 0° | 0.020 | straight down |
| 0.87 | 30° | 0.023 | — |
| 0.50 | 60° | 0.051 | water **3 m** away — a clear window |
| 0.34 | 70° | 0.096 | water 5 m away |
| 0.17 | 80° | 0.398 | water **10 m** away |
| 0.087 | 85° | 0.641 | water 19 m away |
| 0.056 | 86.8° | 0.755 | water **30 m** away |
| 0.017 | 89° | 0.917 | water 100 m away |

So on a 1.7 m eye the sea goes from 5% reflective to 75% reflective over 3 m → 30 m.
**That transition is the whole composition of a beach shot.** If your near water is
already mirror-like, check that you are using the *per-pixel perturbed* normal in the
Fresnel term and that the horizon is not being blended in too early.

Schlick's error vs the exact Fresnel equations for a dielectric at `n = 1.33` is under
about 1% everywhere, so the exact form (Tessendorf eq. 62,
`R = ½[ sin²(θt−θi)/sin²(θt+θi) + tan²(θt−θi)/tan²(θt+θi) ]`) is not worth the cost.

### 5.2 Sky reflection

At the angles that dominate a beach shot, the reflected ray points **just above the
horizon**, into the brightest, haziest part of the sky. Consequences:

- **A low-resolution sky cube is not enough.** At 128², one texel spans ~2.8°, which
  is 5× the sun's angular diameter (0.53°). The sun's reflection becomes a soft blob
  and the sea loses all its high-frequency contrast. Either (a) keep the sun **out** of
  the cube and add it analytically as a specular lobe (§5.3), or (b) reflect the
  *rendered frame* for anything below the horizon.
- **Reflect the rendered frame for below-horizon content.** Anything the reflected ray
  hits below the horizon — the beach, rocks, structures, the Halo ring's lower arc — is
  not in the sky cube, and those are precisely the high-contrast features whose
  reflections carry visible detail. `src/world/ocean.js` already does this via
  `pipe.opaqueRT`; that is the right call.
- **Blend by the reflected ray's elevation**, not by distance:

```glsl
vec3 R = reflect(-V, N);
float horizonBlend = smoothstep(-0.02, 0.06, R.y);   // 0 = below horizon, 1 = sky
vec3 refl = mix(sampleSceneReflection(uvSSR), sampleSky(R), horizonBlend);
```

- **Grazing distortion must shrink with distance.** three's `Water.js` uses
  `distortion = surfaceNormal.xz * (0.001 + 1.0/distance) * distortionScale` with
  `distortionScale` default 20 (verified in the local r0.185.1 source; the ocean
  example passes 3.7). The `1/distance` is the important part: without it, distant
  water samples the reflection buffer from wildly wrong places and you get smearing
  along the horizon.

### 5.3 Sun glint

**The physics.** The sun's glitter track is not a highlight, it is the set of surface
points whose slope happens to satisfy the mirror condition. Its width is set by the
**mean square slope** of the waves your geometry does *not* resolve.

Cox & Munk (1954), from photographs of sun glitter, verified against two sources
(<https://www.oceanopticsbook.info/view/surfaces/cox-munk-sea-surface-slope-statistics>
and the arXiv reanalysis <https://arxiv.org/pdf/2210.05456>):

```
σ_a²  = 0.000 + 3.16e-3 · U      (along-wind slope variance)
σ_c²  = 0.003 + 1.92e-3 · U      (cross-wind slope variance)
mss   = σ_a² + σ_c² = 0.003 + 5.12e-3 · U
```

with **U the wind speed in m·s⁻¹ measured at 12.5 m height**. The slope PDF is the
bivariate Gaussian `p(η_a, η_c) = exp[−½(η_a²/σ_a² + η_c²/σ_c²)] / (2π σ_a σ_c)`.

For U = 5.4 m/s: `mss = 0.0307`, `σ_a² = 0.0171`, `σ_c² = 0.0134`. The along/cross
ratio of ~1.28 is why the glitter track is **elongated along the wind**, not circular.

**Converting mss to a roughness.** For the Beckmann NDF, per-axis slope variance is
`α²/2`, so total mss = `α²`, giving `α = sqrt(mss)`. GGX's `α` is conventionally taken
to match Beckmann's. So:

```
roughness = sqrt( mss_unresolved )
```

`mss_unresolved` is the sum of `(k_i A_i)²/2` over **only** the wave bands whose
wavelength is below the pixel footprint at this fragment. For U = 5.4 m/s all-in that
is `sqrt(0.0307) = 0.175`; for the sub-pixel remainder in the near field it may be
0.03–0.06.

**This is the correct anti-aliasing *and* the correct look simultaneously.** Removing
sub-pixel waves from the normal and folding their variance into roughness is exactly
LEAN mapping (Olano & Baker, I3D 2010, <https://userpages.cs.umbc.edu/olano/papers/lean/>,
<https://dl.acm.org/doi/10.1145/1730804.1730834>): store the first and second moments
of the slope, `B = ⟨n_x/n_z, n_y/n_z⟩` and `M = ⟨(n_x/n_z)², (n_y/n_z)², (n_x n_y/n_z²)⟩`,
both of which filter linearly under mipmapping, and form the covariance `Σ = M − B⊗B`
which adds to the base roughness covariance. Toksvig's cheaper variant infers the
variance from the shortened length of the filtered normal.

Since you generate the fine waves **analytically**, you do not need to store moments —
you can compute the removed variance in closed form:

```glsl
float mssRemoved = 0.0;
for (int i = 0; i < NB; ++i) {
    float kA   = k[i] * A[i];
    float fade = 1.0 - smoothstep(2.0 * pixelFootprint, 4.0 * pixelFootprint, L[i]);
    mssRemoved += 0.5 * kA * kA * fade;      // fade = 1 when the band is sub-pixel
}
float roughness = sqrt(max(mssRemoved, 1e-4));
```

Then a standard GGX specular against a **disc** light of the sun's angular radius
(0.00465 rad ≈ 0.266°), using Karis's representative-point / "closest point on sphere"
approximation — the same one Sea of Thieves used for the low sun
(Karis, *Real Shading in Unreal Engine 4*, 2013):

```glsl
vec3 R = reflect(-V, N);
vec3 L = sunDir;
vec3 centreToRay = dot(L, R) * R - L;
vec3 closest     = L + centreToRay * clamp(SUN_ANG_RADIUS / max(length(centreToRay), 1e-5), 0.0, 1.0);
vec3 Lrep = normalize(closest);
// widen alpha to conserve energy for the sphere light
float alphaP = clamp(roughness * roughness + SUN_ANG_RADIUS / (2.0 * length(centreToRay) + 1e-5), 0.0, 1.0);
```

Expected result: a **broken track**, several hundred metres long, widening toward the
observer, made of thousands of individual facet flashes — not one bright dot.

### 5.4 Normal detail across scales without tiling

You need slope information from ~2 m down to ~2 mm. Three tiers:

**Tier 1 — analytic chop bands (2 m → 0.2 m).** Evaluate 5–7 more Gerstner terms in
the *fragment* shader for the normal only (no displacement). Cost ~6 sin/cos. These
never tile because they are not textures. This is where the visible chop lives.

**Tier 2 — a scrolling normal map (0.4 m → 2 cm).** This is where tiling bites.

The classic three.js `Water.js` approach (verified in r0.185.1 source) is to sum
**four** samples of the same normal map at mutually prime-ish scales and independent
scroll speeds:

```glsl
vec4 getNoise(vec2 uv) {
    vec2 uv0 = ( uv / 103.0 ) + vec2(time / 17.0, time / 29.0);
    vec2 uv1 = ( uv / 107.0 ) - vec2(time / -19.0, time / 31.0);
    vec2 uv2 = ( uv / vec2(8907.0, 9803.0) ) + vec2(time / 101.0, time / 97.0);
    vec2 uv3 = ( uv / vec2(1091.0, 1027.0) ) - vec2(time / 109.0, time / -113.0);
    vec4 n = texture(normalSampler, uv0) + texture(normalSampler, uv1)
           + texture(normalSampler, uv2) + texture(normalSampler, uv3);
    return n * 0.5 - 1.0;
}
vec3 surfaceNormal = normalize( noise.xzy * vec3(1.5, 1.0, 1.5) );
```

Note the choice of denominators: 103, 107, 1091, 1027, 8907, 9803 — deliberately
co-prime-ish so the four layers' common period is astronomically long. The scroll
periods (17, 29, 19, 31, 101, 97, 109, 113 s) are all prime. This is a good, nearly
free anti-tiling scheme and it is worth copying wholesale. **Do not** replace them with
round numbers.

Its limitation: all four layers come from the same texture, so its *character*
repeats even though its *pattern* does not. For a harder guarantee use Inigo Quilez's
techniques (<https://iquilezles.org/articles/texturerepetition/>):

- **Technique 1** — per-tile random offset + mirroring, 4 texture fetches, blended with
  `smoothstep` near tile borders. Requires `textureGrad()` with derivatives taken from
  the *original repeating* UV, or the mips break at every tile boundary.
- **Technique 3** — "virtual pattern variation", **2 fetches**: sample a low-frequency
  variation texture, use it to index between two hash-generated offsets
  (`offset = sin(vec2(3.0,7.0)*(i + k))`), sample the base texture twice at those
  offsets, `mix()`. Cache-friendly because the variation texture is low frequency.
  This is the right cost/quality point for water.

```glsl
// iq technique 3, adapted. dx/dy computed ONCE from the repeating UV.
vec4 noRepeat(sampler2D tex, vec2 uv, float k /*0..1 variation*/) {
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    float l = k * 8.0;
    float f = fract(l);
    float ia = floor(l), ib = ia + 1.0;
    vec2 offa = sin(vec2(3.0, 7.0) * ia);
    vec2 offb = sin(vec2(3.0, 7.0) * ib);
    vec4 cola = textureGrad(tex, uv + offa, dx, dy);
    vec4 colb = textureGrad(tex, uv + offb, dx, dy);
    return mix(cola, colb, smoothstep(0.2, 0.8, f - 0.1 * dot(cola - colb, vec4(1.0))));
}
```

**Tier 3 — sub-pixel (< 2 cm).** Do **not** put this in the normal. Put it in
roughness, via §5.3. This is the single most effective anti-shimmer measure available.

**Scale ratio rule.** Adjacent detail tiers should differ by a factor of **3–5**, never
2 (aliases against mip levels) and never 10 (visible gap in the slope spectrum, water
reads as "big smooth waves with sandpaper on top").

**Fade normal amplitude with distance.** GPU Gems ch.1: *"The scale value is modulated
by another scale factor that goes to zero with increasing distance from the vertex to
the eye. This causes the normal to collapse to the geometric surface normal in the
distance, where the normal map texels are much smaller than pixels."* Correct, but do
it via §5.3 (move it into roughness) rather than just deleting it, or the distant sea
goes glassy and dead.

---

## 6. Putting the fragment shader together

WebGL2 / GLSL ES 3.00 sketch. three injects `#version 300 es` itself, so do not write
it. Use `in`/`out`, `texture()`, and declare `out vec4 fragColor` (three's
`ShaderMaterial` with `glslVersion: THREE.GLSL3` expects `pc_fragColor` or your own
declared out).

```glsl
precision highp float;

in vec3  vWorldPos;
in vec3  vViewPos;
in vec3  vGeomNormal;      // from the Gerstner tangent frame
in float vBreaking;        // 0..1, amplitude clipped by depth limit
in float vJminus;          // Tessendorf minimum eigenvalue
in float vHorizDisp;       // |Σ Q A D cos θ|, metres
in float vDepthStill;      // metres

uniform sampler2D uSceneColour, uSceneDepth, uFoamField, uSandCaustic;
uniform samplerCube uSky;
uniform vec3  uSunDir, uSunColour, uSkyColour, uCamPos;
uniform vec2  uInvRes;
uniform float uNear, uFar, uTime;

out vec4 fragColor;

const float N_WATER   = 1.333;
const float F0_WATER  = 0.0204;
const vec3  K_WATER   = vec3(0.45, 0.090, 0.045);   // m^-1
const vec3  SAND_ALB  = vec3(0.75, 0.70, 0.62);
const vec3  DEEP_SCAT = vec3(0.004, 0.030, 0.075);
const vec3  SSS_COL   = vec3(0.10, 0.55, 0.45);
const vec3  FOAM_ALB  = vec3(0.72, 0.74, 0.75);

void main() {
    vec2  uv = gl_FragCoord.xy * uInvRes;
    vec3  V  = normalize(uCamPos - vWorldPos);

    // ---- normal: geometric frame + analytic chop + anti-tiled ripple ----
    vec3 N = vGeomNormal;
    float mssRemoved = 0.0;
    N = perturbByChopBands(N, vWorldPos.xz, uTime, /*out*/ mssRemoved);   // §5.4 tier 1
    N = perturbByRippleMap(N, vWorldPos.xz, uTime);                        // §5.4 tier 2
    N = normalize(N);
    float rough = sqrt(max(mssRemoved + BASE_MSS, 1e-4));                  // §5.3 tier 3

    // ---- Fresnel ----
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    float F = F0_WATER + (1.0 - F0_WATER) * pow(1.0 - NdotV, 5.0);

    // ---- refraction: sample the scene behind, offset by the in-water bent ray ----
    float zSurf  = vViewPos.z;
    float zSceneStraight = perspectiveDepthToViewZ(texture(uSceneDepth, uv).x, uNear, uFar);
    float thicknessStraight = max(0.0, zSurf - zSceneStraight);

    // distortion must shrink with distance (three's Water.js rule) AND be clamped by
    // the *unrefracted* thickness, or foreground objects bleed into the water.
    float dist = length(uCamPos - vWorldPos);
    vec2 refrOff = N.xz * (0.001 + 1.0 / dist) * REFRACT_SCALE
                 * clamp(thicknessStraight * 2.0, 0.0, 1.0);
    vec2 uvR = uv + refrOff;

    float zScene = perspectiveDepthToViewZ(texture(uSceneDepth, uvR).x, uNear, uFar);
    if (zScene > zSurf) { uvR = uv; zScene = zSceneStraight; }   // reject in-front pixels
    vec3  bottomLit = texture(uSceneColour, uvR).rgb;

    // ---- caustics on the bottom ----
    float hCol = max(0.0, zSurf - zScene) * abs(V.y);            // ~ vertical depth, metres
    bottomLit *= 1.0 + CAUSTIC_GAIN * (caustic(vWorldPos.xz + causticParallax(hCol), uTime) - 0.35)
                     * exp(-0.35 * hCol) * (1.0 - clamp(mssRemoved / 0.05, 0.0, 1.0));

    // ---- Beer-Lambert over the true two-way in-water path ----
    float cosSunW  = cosInWater(max(uSunDir.y, 0.05));
    float cosViewW = cosInWater(NdotV);
    float s = hCol * (1.0 / cosSunW + 1.0 / cosViewW);
    vec3  T = exp(-K_WATER * s);
    vec3  refracted = bottomLit * T + DEEP_SCAT * uSkyColour * (1.0 - T);

    // ---- translucency through crests ----
    vec3  ltL   = uSunDir + N * 0.25;
    float ltDot = pow(clamp(dot(V, -ltL), 0.0, 1.0), 4.0) * 2.4;
    float thin  = clamp(vHorizDisp / MAX_HORIZ_DISP, 0.0, 1.0);
    refracted  += uSunColour * SSS_COL * (ltDot + 0.12) * thin;

    // ---- reflection ----
    vec3  R = reflect(-V, N);
    float horizonBlend = smoothstep(-0.02, 0.06, R.y);
    vec3  reflected = mix(sampleSSR(uv, R, dist), texture(uSky, R).rgb, horizonBlend);

    // ---- sun glint ----
    reflected += ggxSunDisc(N, V, uSunDir, rough) * uSunColour;

    // ---- composite ----
    vec3 col = mix(refracted, reflected, F);

    // ---- foam, last, and it overrides the Fresnel ----
    float foam = foamMask(vWorldPos.xz, vJminus, vBreaking, vDepthStill, uTime);
    vec3  foamCol = FOAM_ALB * (uSkyColour * 0.55 + uSunColour * max(dot(N, uSunDir), 0.0) * 0.75);
    col = mix(col, foamCol, foam);

    col = applyAerialPerspective(col, dist);
    fragColor = vec4(col, 1.0);
}
```

Ordering notes that matter:
- Fresnel uses the **perturbed** normal, not the geometric one.
- Absorption applies **only** to the refracted term. If you attenuate the reflection
  too, the horizon goes dark and the sea reads as navy paint.
- Foam is applied **after** the Fresnel mix and replaces both terms; a foam that is
  blended before Fresnel will still show sky reflection through it.
- Aerial perspective is applied last and must use the same in-scatter integral as the
  terrain, or the water/land horizon line separates.

---

## 7. Quick parameter sheet

| Symbol | Value | Unit | Meaning |
|---|---|---|---|
| `g` | 9.81 | m·s⁻² | gravity, sets all wave speeds |
| `n_water` | 1.333 | — | refractive index; caps in-water angle at 48.6° |
| `F0` | 0.0204 | — | normal-incidence reflectance of water |
| `γ` (breaker index) | 0.78 | — | `H/h` at breaking (McCowan) |
| Miche limit | `H/L ≤ 1/7` | — | deep-water steepness limit |
| `Σ Q_i k_i A_i` | ≤ 1.0 | — | Gerstner loop budget; current repo uses 0.354 |
| `A/L` (ρ) | 0.010–0.022 | — | Phillips-consistent for a log ladder |
| `mss` | `0.003 + 0.00512·U` | — | Cox–Munk; U in m/s at 12.5 m |
| `K_water` | (0.45, 0.090, 0.045) | m⁻¹ | RGB extinction, clear tropical lagoon |
| `a_pure` | (0.39, 0.045, 0.010) | m⁻¹ | pure-water absorption, Pope & Fry band-avg |
| Sand albedo | (0.75, 0.70, 0.62) | — | linear, dry carbonate |
| Wet-sand darkening | ×0.55 | — | albedo multiplier at full wetness |
| Wet-sand roughness | 0.18 | — | water film is smooth |
| Sand dry time | 20–60 | s | wetness decay `τ` |
| Turquoise band centre | `h ≈ 1.7–2.8` | m | where `2·K_r·h ≈ 1.5–2.5` |
| Shore foam max depth | 0.6–1.2 | m | Crest's `Shoreline Foam Max Depth` |
| Foam decay `τ` | 1.5–4.0 | s | how long whitewater persists |
| Foam advection speed | 0.1–0.3 | m·s⁻¹ | Stokes drift, shoreward |
| Foam albedo | 0.6–0.8 | — | linear; never 1.0 |
| Sun angular radius | 0.00465 | rad | 0.266°, for the disc specular |
| Refraction distortion | `(0.001 + 1/dist)·S` | — | three's Water.js rule, `S ≈ 3.7–20` |
| Detail tier ratio | 3–5 | × | between adjacent normal scales |
| Nyquist wave cutoff | `L ∈ [2·e, 4·e]` | m | GPU Gems edge-length fade, `e` = edge length |

---

## 8. Failure modes — what they look like in a screenshot

Ordered by how often they occur.

1. **Water is flat matte teal with no sparkle, at all distances.**
   The reflection source has no high-frequency content — you are sampling a low-res sky
   cube or an over-blurred probe. *Tell:* the sea has a smooth vertical gradient and no
   texture; the sun's reflection is a soft oval instead of a broken track. Fix: reflect
   the rendered frame below the horizon and add the sun analytically (§5.2, §5.3).

2. **Near water looks like grey plastic / oil slick.**
   `F0` is 0.04 or higher, or Fresnel uses the geometric normal. *Tell:* you cannot see
   the sand through water at your feet; the water at 2 m has a visible sheen. Fix:
   `F0 = 0.0204`, perturbed normal.

3. **The whole distant sea is opaque navy.**
   Absorption is being applied along the *air-side* view path instead of the refracted
   in-water path, so path length → ∞ at grazing. *Tell:* the transition to navy happens
   at a fixed screen height regardless of bathymetry. Fix: §3.2, clamp
   `1/cos θ_view' ≤ 1.51`.

4. **Deep water is black, not blue.**
   Missing the `DEEP_SCATTER · (1 − T)` volume term. *Tell:* the colour ramp runs
   turquoise → teal → black rather than turquoise → teal → deep blue.

5. **A hard contour line in the water colour that doesn't move.**
   The depth ramp is a `smoothstep` on a small depth range, or it is evaluated against
   *still* depth rather than instantaneous depth. *Tell:* a printed-map isoline that the
   waves slide over without disturbing. Fix: use `exp(−2Kd)` (which has no edges at all)
   and use `h + η`.

6. **Turquoise band is a thin rim rather than a broad band.**
   The seabed is too steep, not a shader problem. Expected width: `Δh ≈ 2 m` of depth →
   `Δx = 2/slope` metres of shore-normal distance. On 1:10 that is 20 m; on 1:3 it is 6 m
   and reads as a rim.

7. **Black or blown-out pinpricks that sit on wave crests and pop frame to frame.**
   Gerstner loops: `Σ Q_i k_i A_i > 1` and `N.y` has gone negative at peaks. *Tell:* the
   speckles ride the crest, they are not screen-space noise. Fix: §1.2.

8. **The sea reads as corrugated iron / a regular quilt.**
   Too few waves, or wavelength ratios that are simple rationals, or all phases zero.
   *Tell:* crests are the same length, evenly spaced, and every crest runs the full
   width of the frame. Real crests end.

9. **Crests march diagonally onto the beach and never turn.**
   No refraction. *Tell:* the surf line is at a constant angle to the shoreline all the
   way in. This is the most recognisable "not a real beach" cue. Fix: §1.4(c).

10. **The surf line is a single continuous white band at a fixed distance ("bathtub ring").**
    Foam driven by a depth threshold alone, not by per-wave breaking. *Tell:* the band's
    distance from shore never changes; there are no sets. Fix: drive from `breaking`
    (§1.4b) so each wave breaks on its own schedule.

11. **Foam looks like fog / smoke / white paint.**
    Unlit, albedo 1.0, and/or applied before the Fresnel mix so it still mirrors the sky.
    *Tell:* the foam has no shading variation across the wave; it is the same brightness
    in shadow. Fix: §4.4.

12. **Foam sits still while the water moves under it.**
    No advection in the foam field. *Tell:* a foam patch stays put while a crest passes
    through it.

13. **White blotches out in the deep water.**
    Jacobian threshold too aggressive, or `J` used instead of `J₋`. *Tell:* foam in water
    that is clearly several metres deep and not breaking.

14. **The wet/dry sand line is a smooth, perfectly parallel curve.**
    Missing the along-shore noise offset. *Tell:* it looks drawn with a French curve.
    Add ~15 cm of low-frequency raggedness.

15. **Wet sand is darker but still visibly rough.**
    You darkened the albedo but did not drop the roughness. *Tell:* it reads as mud, not
    as wet sand. The characteristic sheen of a draining swash *is* the roughness change.

16. **The sun's reflection is one sharp dot.**
    Roughness driven from a constant instead of from sub-pixel slope variance, or the
    sun treated as a point light. *Tell:* looks like a lens flare on a mirror. Real
    glitter is hundreds of metres long and widens toward the viewer.

17. **The sun track boils / crawls / fizzes between frames.**
    Specular aliasing: sub-pixel normal detail is still in the normal instead of in the
    roughness. *Tell:* the shimmer is worst at mid-distance where texel ≈ pixel, and it
    is temporally unstable even with a static camera. Fix: §5.3.

18. **A regular grid of identical sparkle clusters at mid distance.**
    Normal-map tiling. *Tell:* the same distinctive "comma" of bright texels repeats at a
    fixed spacing. Fix: §5.4, the four-layer co-prime scheme or iq technique 3.

19. **A visible ring in the distance where the sea goes smooth.**
    Normal amplitude faded to zero with distance without moving the variance into
    roughness. *Tell:* an annulus of dead flat water beyond a certain radius.

20. **Objects standing in the shallows bleed sideways into the water in front of them.**
    Screen-space refraction sampling a pixel that is *in front of* the water surface.
    *Tell:* a smeared copy of a leg or a rock offset into water nearer the camera. Fix:
    reject samples where `zScene > zSurf` and fall back to the undistorted UV, and scale
    the offset by the unrefracted thickness (in the §6 sketch).

21. **Caustics visible inside shadows.**
    Not multiplied by the sun shadow term. This is the single most legible "fake water"
    tell in a still frame.

22. **Caustics at the same strength in deep water.**
    Missing the `exp(−K·d)` falloff. Caustics should be essentially gone by 6–8 m.

23. **Every crest glows green including flat offshore swell.**
    Translucency driven from elevation rather than from the horizontal-displacement
    pinch. *Tell:* it looks like backlit green plastic sheeting.

24. **The water is neon / oversaturated cyan.**
    sRGB colour values used as linear. `(0.0, 0.8, 0.8)` picked in a colour picker is
    `(0.0, 0.60, 0.60)` linear; the reverse mistake pushes it to `(0.0, 0.91, 0.91)`.
    Check `THREE.ColorManagement` and that all constants above are treated as **linear**.

25. **The waves punch through the sand at the waterline; the sand edge scallops and flickers.**
    No amplitude attenuation as `h → 0`. Fix: GPU Gems' explicit advice — attenuate wave
    amplitude to zero *slightly above* the water plane so the water can lap up the shore
    without penetrating it, and clamp vertices so they never go below the seabed.

26. **The water/land horizon separates into two different hazes.**
    Water is not sharing the terrain's aerial-perspective integral.

---

## 9. What I could **not** verify

Stated plainly so nothing here gets built on sand.

- **Fenton & McKee's exact exponents.** I could not extract the formula body from
  either <https://johndfenton.com/Papers/Dispersion-Relation.pdf> or the 1990 Coastal
  Engineering scan (both returned unparsed binary). The form
  `L = L0·[tanh((ω²h/g)^(3/4))]^(2/3)` and the ≤1.7% error figure come from secondary
  descriptions and from the ResearchGate/ScienceDirect abstracts, plus the fact that
  `src/world/ocean.js` already uses it. **Confidence: medium-high on the form, medium
  on the exponents.** If it matters, verify against the paper before shipping. A safe
  fallback is 3–4 Newton iterations on `ω² − g·k·tanh(k·h) = 0` starting from
  `k = ω²/g`, which converges in practice for all `k·h > 0.01`.

- **Lyzenga (1978) exact notation.** The `R = R_deep + (ρ_bottom − R_deep)·exp(−2Kd)`
  structure is consistently described across secondary sources and is the form used in
  §3.1, but I could not open the original Applied Optics 17:379 paper to confirm the
  symbol convention or whether the exponent is `2K` or three separate coefficients
  (`Kd`, `Ku_C`, `Ku_B` — the Lee et al. 1998 refinement explicitly splits them).
  **For rendering this does not matter**; the exponential two-way structure is right.

- **`K_WATER = (0.45, 0.090, 0.045)`** is my construction: Pope & Fry pure-water
  absorption band-averaged over sRGB primaries, plus a small CDOM/sediment term chosen
  so the blue channel lands between Jerlov IA and IB. The pure-water numbers are solid
  (two-source: OMLC data file + the general literature agreement that a(700) ≈ 0.62 m⁻¹).
  **The additive coastal term is a judgement call, not a measurement.**

- **Sand albedo (0.75, 0.70, 0.62).** Hochberg et al. confirm carbonate sand's spectral
  *shape* (rise 400→565, slight fall 565→650) but I could not extract absolute
  reflectance magnitudes. Treat the magnitude as a starting point to be matched against
  the reference frames.

- **Wet-sand darkening factor 0.55.** The *mechanisms* are well sourced (Lekner & Dorf
  1988; Twomey, Bohren & Mergenthaler 1986, with their `g_dry = 0.7`, `g_wet = 0.9`
  model parameters). The specific 0.55 multiplier for carbonate beach sand is **not**
  from a measurement I could reach.

- **The 45-second sand dry time** comes from a description of a Godot shoreline asset,
  not from a physical measurement. It is a plausible artistic value.

- **Toksvig's exact gloss-remapping formula.** I deliberately did not quote it because I
  could not open the 2005 note. I gave the LEAN covariance formulation instead, which is
  sourced (<https://userpages.cs.umbc.edu/olano/papers/lean/>) and which the analytic
  `mssRemoved` computation makes unnecessary anyway.

- **Halo: Campaign Evolved's actual water implementation.** Public material confirms
  only: it is UE5, uses hardware Lumen ray-traced reflections "on the surfaces of
  water", and has "interactive water and deformable sand" with "ocean waves lapping the
  sandy shores of The Silent Cartographer… creating realistic foam and splashes"
  (<https://www.unrealengine.com/developer-interviews/halo-campaign-evolved-brings-the-legendary-franchise-into-a-new-era-with-ue5>,
  <https://en.wikipedia.org/wiki/Halo:_Campaign_Evolved>). **There is no published
  technical breakdown of their water shader.** Everything in §3 about "the Halo look" is
  a physical reconstruction of what produces that appearance, not a description of what
  they did. UE5's stock SingleLayerWater shading model plus the Water plugin's
  16-wave Gerstner default with a depth-attenuation curve is the most likely basis, and
  that is a public, documented starting point
  (<https://dev.epicgames.com/documentation/en-us/unreal-engine/water-body-actors-in-unreal-engine>).

- **`src/world/ocean.js` review.** I read the header, the wave tables, and the shader
  regions around lines 240–390. The wave tables check out numerically (§1.2: loop budget
  0.354 of 1.0, mss 0.028 vs Cox–Munk 0.031). I did **not** audit the rest of the 1635
  lines, so this brief should be read as "here is the correct physics", not "here is
  what your file gets wrong".

---

## 10. Sources

- GPU Gems 1, ch.1, *Effective Water Simulation from Physical Models* — <https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models>
- Tessendorf, *Simulating Ocean Water*, SIGGRAPH course notes 2004 — <https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf>
- Catlike Coding, *Waves* (independent Gerstner derivation) — <https://catlikecoding.com/unity/tutorials/flow/waves/>
- Fenton & McKee 1990, *On calculating the lengths of water waves* — <https://johndfenton.com/Papers/Fenton90c+McKee-On-calculating-the-lengths-of-water-waves.pdf>
- Green's law — <https://en.wikipedia.org/wiki/Green%27s_law>
- Depth-induced breaking, γ = 0.78 — <https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/05:_Coastal_hydrodynamics/5.02:_Wave_transformation/5.2.5:_Wave_breaking>
- Wave refraction — <https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/05:_Coastal_hydrodynamics/5.02:_Wave_transformation/5.2.3:_Refraction> and <https://www.coastalwiki.org/wiki/Refraction>
- Cox & Munk slope statistics — <https://www.oceanopticsbook.info/view/surfaces/cox-munk-sea-surface-slope-statistics> and <https://arxiv.org/pdf/2210.05456>
- Pope & Fry 1997 pure-water absorption data — <https://omlc.org/spectra/water/data/pope97.txt>, index <https://omlc.org/spectra/water/abs/index.html>
- Jerlov water types, Kd — <https://aslopubs.onlinelibrary.wiley.com/doi/10.1002/lol2.10338>, <https://opg.optica.org/ao/abstract.cfm?uri=ao-54-17-5392>
- Hochberg et al. 2003, coral-reef bottom-type spectra — <https://www.sciencedirect.com/science/article/abs/pii/S0034425702002018>
- Lekner & Dorf 1988, *Why some things are darker when wet* — <https://opg.optica.org/ao/abstract.cfm?uri=ao-27-7-1278>
- Twomey, Bohren & Mergenthaler 1986, *Reflectance and albedo differences between wet and dry surfaces* — <https://pubmed.ncbi.nlm.nih.gov/18231193/>
- Ang et al., *The Technical Art of Sea of Thieves*, SIGGRAPH 2018 Talks — <https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf>
- Barré-Brisebois & Bouchard, GDC 2011 translucency — <https://colinbarrebrisebois.com/2011/03/07/gdc-2011-approximating-translucency-for-a-fast-cheap-and-convincing-subsurface-scattering-look/>, <https://www.ea.com/frostbite/news/approximating-translucency-for-a-fast-cheap-and-convincing-subsurface-scattering-look>
- Olano & Baker, *LEAN Mapping*, I3D 2010 — <https://userpages.cs.umbc.edu/olano/papers/lean/>, <https://dl.acm.org/doi/10.1145/1730804.1730834>
- Inigo Quilez, *Texture Repetition* — <https://iquilezles.org/articles/texturerepetition/>
- Cyanilux, *Shoreline Shader Breakdown* — <https://www.cyanilux.com/tutorials/shoreline-shader-breakdown/>
- Crest Ocean System, ocean simulation docs — <https://crest.readthedocs.io/en/4.12/user/ocean-simulation.html>
- Unreal Engine 5 Water: Water Waves asset — <https://dev.epicgames.com/documentation/en-us/unreal-engine/simulating-waves-using-the-water-waves-asset-in-unreal-engine>; Water Body actors — <https://dev.epicgames.com/documentation/en-us/unreal-engine/water-body-actors-in-unreal-engine>; `UGerstnerWaterWaves` — <https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Water/UGerstnerWaterWaves>
- Wallis, *Making of Moana (the ShaderToy)* — <https://wallisc.github.io/rendering/2020/12/08/Making-Of-Moana-the-shadertoy.html>
- Halo: Campaign Evolved / UE5 developer interview — <https://www.unrealengine.com/developer-interviews/halo-campaign-evolved-brings-the-legendary-franchise-into-a-new-era-with-ue5>
- three.js r0.185.1 local source: `node_modules/three/examples/jsm/objects/Water.js`, `WaterMesh.js`, `src/renderers/shaders/ShaderChunk/packing.glsl.js`
