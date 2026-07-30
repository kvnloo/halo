# Aerial perspective for a 1–2 km tropical daylight scene (WebGL2 / three.js r185)

**Key: `aerial`.** Written for someone who is going to edit `src/gfx/materialCommon.js` and
`src/render/passes/volumetricFog.js` today.

---

## 0. TL;DR — the diagnosis, before any theory

Your `wmAerial` uses the *right structural form* (`mix(color, inscatter, 1-exp(-integral))`)
but three of its inputs are wrong, and one is wrong by a factor of ~13.

`createAerialUniforms()` sets `uAerialDensity = 0.0062` (per metre, at base height). Run
Beer–Lambert on that:

| distance | `1 - exp(-0.0062·s)` = fraction of surface colour replaced by haze |
|---|---|
| 5 m | **3.1 %** |
| 10 m | **6.0 %** |
| 30 m | **17.0 %** |
| 100 m | **46.2 %** |
| 300 m | **84.4 %** |
| 1000 m | 99.8 % |

Koschmieder's relation (§2.4) converts that extinction coefficient to a meteorological
visual range of **631 metres**. That is not tropical haze. In the Hoffman & Preetham
empirical table (§2.3) it sits between "light fog" (β ≈ 1×10⁻³ m⁻¹) and "heavy fog"
(β ≈ 1×10⁻² m⁻¹). You are rendering a scene that is supposed to see 1–2 km through a
medium in which a black object disappears at 631 m.

**46 % of every pixel at 100 m is fog colour.** That is, on its own, a sufficient
explanation for whole-scene saturation landing at 43 % of target. There is no additional
mystery to find.

Three secondary defects compound it:

1. **A constant, angle-independent in-scatter lobe.**
   `phase = mix(0.42, wmHG(cosT,0.76)*2.6, uAerialSunAmount)` with `uAerialSunAmount = 0.55`
   leaves `0.45 × 0.42 = 0.189` of achromatic sun-coloured in-scatter present *in every
   direction, including 180° away from the sun*. Evaluated:

   | cos θ (view·sun) | your `phase` | added in-scatter = `sunColor × phase × 0.55` |
   |---|---|---|
   | 1.0 (at the sun) | 3.666 | **2.016 × sunColor** |
   | 0.5 | 0.254 | 0.140 × sunColor |
   | 0.0 | 0.213 | 0.117 × sunColor |
   | −1.0 (anti-sun) | 0.198 | **0.109 × sunColor** |

   A physically-correct phase term falls to `1/4π × (1−g)²/(1+g)² ≈ 0.0062 sr⁻¹` at the
   anti-solar point for g = 0.76 — 0.08× isotropic. Yours only falls to 0.198, i.e. it
   never goes away. That is a flat white pedestal on the whole frame.

2. **The phase is not normalised and is mixed with a dimensionally different constant.**
   `wmHG` correctly integrates to 1 over the sphere (peak 2.43 sr⁻¹ at g = 0.76, isotropic
   value 1/4π = 0.0796 sr⁻¹). Multiplying it by 2.6 and `mix`ing it against a bare `0.42`
   destroys the normalisation, so the in-scatter is no longer bounded by the sky radiance.

3. **The in-scatter colour is not tied to what the sky module renders.** `uAerialSkyColor`,
   `uAerialGroundColor`, `uAerialSunColor` are hand-authored. §3 shows why the in-scatter
   colour *must* equal the sky radiance in the view direction; if it does not, distant
   ridges are outlined against the sky.

Also: `uAerialStart = 6.0` is a band-aid for defect #0. Once β is right you do not need it,
and it costs you a contrast step as objects cross 6 m.

And there is a real **double-apply of the sun lobe** between `wmAerial` and
`volumetricFog` — see §5.3. The header comment in `volumetricFog.js` correctly reasons
about the *ambient* lobe (gated by `uGeoAmbient = 0`) but `sunTerm` is **not** gated by
`geoW`, so on opaque pixels the sun in-scatter is added twice: once unshadowed by
`wmAerial`, once shadowed by the volumetric pass.

Recommended immediate change set is in §8.

---

## 1. The analytic single-scattering formulation — actual equations

### 1.1 The radiative transfer ODE along a view ray

Let `s` be **radial distance** from the eye to the surface (metres — not view-space
`-z`, see §6.4). Let `L₀` be the surface radiance before atmosphere.

Radiance along the ray obeys ([Hoffman & Preetham, *Photorealistic Real-Time Outdoor Light
Scattering*, Game Developer, Aug 2002](https://renderwonk.com/publications/gdm-2002/GDM_August_2002.pdf),
and the companion GDC 2002 course notes
[hoffman.pdf](https://renderwonk.com/publications/gdc-2002/hoffman.pdf) Eq. 14):

```
dL/ds = E_sun · β_sc(θ)  −  β_ex · L
```

where

- `β_ab(λ)` — absorption coefficient, **m⁻¹**. Fraction of radiance absorbed per metre.
- `β_sc(λ)` — scattering coefficient, **m⁻¹**. Fraction scattered *out of* the ray per metre.
- `β_ex = β_ab + β_sc` — extinction coefficient, **m⁻¹**. (GDM Eq. following "Extinction".)
- `f(θ)` — phase function, **sr⁻¹**, `∫_{4π} f dω = 1`.
- `β_sc(θ) = β_sc · f(θ)` — angular scattering coefficient, **m⁻¹·sr⁻¹**.
- `E_sun` — sun **irradiance** on a plane ⟂ to the sun direction (W·m⁻², or your engine's
  linear light unit). *Not* radiance. `E_sun = ω_sun · L_sun`.
- `θ` — angle between the view ray and the sun direction. `cos θ = dot(viewDir, sunDir)`.

### 1.2 The closed-form solution (this is the equation you implement)

Assuming `E_sun`, `β_sc(θ)` and `β_ex` constant along the ray:

```
L(s, θ)  =  F_ex(s) · L₀  +  L_in(s, θ)                          … (Eq. 1)

F_ex(s)  =  exp(−β_ex · s)                                       … (Eq. 3)

L_in(s, θ) = (1 / β_ex) · E_sun · β_sc(θ) · (1 − exp(−β_ex·s))   … (Eq. 4)
```

Verbatim from GDM 2002 (I read the typeset equation off the rendered page to be sure):
`L_in(s,θ) = (1/β_ex) · E_sun · β_sc(θ) · (1 − e^(−β_ex·s))`.

**Cross-check.** Preetham's SIGGRAPH 2003 course notes
([*Modeling Skylight and Aerial Perspective*](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf),
p. "Aerial Perspective Model") derive the same thing independently and write it as:

```
L_s = f·L₀ + L_in,   f = e^(−βs),   L_in = E_s · (β(ω,ω_s)/β) · (1 − e^(−βs))
```

Two independent sources, same equation. Use it.

### 1.3 Rewriting it as a `mix()` — and why your structure is already right

Define the **equilibrium in-scatter radiance**

```
J(θ)  =  E_sun · β_sc(θ) / β_ex          [radiance, same units as L₀]
```

Then Eq. 1 + 4 is *exactly*

```
L = L₀·T  +  J·(1 − T),      T = exp(−β_ex·s)
  = mix(L₀, J, 1 − T)
```

which is the `mix(color, inscatter, t)` you already have. **So the shape of `wmAerial`
is correct.** The bug is entirely in `β_ex` and in `J`.

`J` has a physical identity you must respect: **`J` is the radiance of an infinitely deep
slab of the same medium — i.e. it is the sky radiance in direction `v`.** Set `s → ∞` in
Eq. 4 and `L → J`. If your `J` is not the colour your sky shader paints at that direction,
distant geometry will not blend into the sky (§7, failure mode F3).

### 1.4 Two particle species

Air molecules (Rayleigh) and aerosols (Mie) have different `β` *and* different phase
functions, so you sum the angular coefficients and sum the extinctions
(GDM 2002, "Filling in the Parameters"):

```
β_ex     = β_ex^R + β_ex^M                                    (per RGB channel)
β_sc(θ)  = β_sc^R · f_R(θ)  +  β_sc^M · f_M(θ)                (per RGB channel)

J(θ)     = E_sun · [β_sc^R·f_R(θ) + β_sc^M·f_M(θ)] / β_ex
```

Hoffman & Preetham additionally carry *two independent path lengths* `s_Air` and `s_Haze`
because the two species have different vertical scale heights, giving
`F_ex(s_Air, s_Haze) = exp(−(β_ex^Air·s_Air + β_ex^Haze·s_Haze))`. **At 1–2 km ground range
you do not need this.** Preetham's own note: *"For landscape scenes that focus on aerial
perspective, the viewing rays are close to the earth's surface and it can safely be assumed
that the density of the medium is a constant"*. Use one path length; keep the height falloff
only as an art control for a ground-hugging haze layer.

### 1.5 Adding the sky (ambient) lobe

Eq. 4 only handles in-scatter from the sun. In daylight, in-scatter from the *sky dome* is
comparable in magnitude for a near-horizontal ray. Because `∫f dω = 1`, in-scatter from an
approximately uniform surrounding radiance field `L̄` contributes `L̄` regardless of phase:

```
J(θ) = (β_sc/β_ex) · [ f(θ)·E_sun  +  L̄_env ]

L̄_env ≈ 0.5·L_sky_avg + 0.5·L_ground_avg
```

Your `mix(uAerialGroundColor, uAerialSkyColor, v.y*0.5+0.5)` **is** this term, and it is the
right shape. It just needs to be (a) actual scene radiances in the same linear units the
surfaces are lit in, and (b) multiplied by the single-scattering albedo `β_sc/β_ex`.

Single-scattering albedo for this scene: Rayleigh is a pure scatterer (`β_ab = 0`);
maritime aerosol SSA is 0.95–0.99. So `β_sc/β_ex ≈ 0.97` — you can set it to 1.0 and lose
nothing. **This is why "fog colour = sky colour" is not a hack: it is the correct limit.**

### 1.6 Height-exponential density (keep, it is correct)

If density is `f(x,y,z) = b·exp(−c·y)`, the optical depth along the ray has a closed form.
Carsten Wenzel's CryEngine 2 derivation
([*Real-time Atmospheric Effects in Games*, SIGGRAPH 2006 Advanced Real-Time Rendering course, ch. 6](https://advances.realtimerendering.com/s2006/Chapter6-Real-time%20Atmospheric%20Effects%20in%20Games.pdf), §6.4):

```
∫₀¹ f(o + t·d) |d| dt  =  b·e^(−c·o_y) · |d| · (1 − e^(−c·d_y)) / (c·d_y)
```

Íñigo Quílez gives the same integral ([*Better Fog*](https://iquilezles.org/articles/fog/)):

```glsl
float fogAmount = (a/b) * exp(-ro.y*b) * (1.0 - exp(-t*rd.y*b)) / rd.y;
```

Your `wmAerial` implements exactly this with the `abs(fy) > 1e-4` guard. Wenzel warns about
the same singularity (`cSlopeThreshold = 0.01`). **Keep this code; it is right.**

Recommended scale height for the aerosol layer: Bruneton/Hillaire use **1.2 km** for the
Mie layer and **8 km** for Rayleigh. Your `uAerialHeightFalloff = 0.021` → e-folding height
of 1/0.021 = **48 m**. That is a ground-hugging mist layer, not tropical haze. For a scene
where you fly/climb 0–200 m and want the haze to feel like *air*, set the e-folding height
to 600–1500 m (`uAerialHeightFalloff = 0.0007 … 0.0017`), or set it to 0 and use constant
density (which is what Preetham recommends at this range). Keep the 48 m layer only if you
also want a separate visible ground mist, in which case make it a *second*, thin layer.

---

## 2. Coefficients: values, units, physical meaning

### 2.1 Rayleigh (air molecules), sea level

Preetham's exact expression (SIGGRAPH 2003 notes, and identically in GDM 2002):

```
β_sc^Air = (8π³ (n² − 1)²  / (3 N λ⁴)) · (6 + 3p_n)/(6 − 7p_n)      [m⁻¹]

f_Air(θ) = (3 / 16π) · (1 + cos²θ)                                  [sr⁻¹]
```

- `n` = refractive index of air = **1.0003**, dimensionless.
- `N` = molecules per m³ = **2.545 × 10²⁵** at 0 °C, 1 atm.
- `p_n` = depolarisation factor = **0.035**, dimensionless.
  *(The 2003 course notes print `0.0035`; GDM 2002 prints `0.035`. 0.035 is the physically
  accepted value for air. Treat the 2003 notes as a typo.)*

**Numbers you can paste (two independent sources, in agreement):**

| Source | λ (nm) | β_sc R | β_sc G | β_sc B | units |
|---|---|---|---|---|---|
| Hoffman & Preetham GDM 2002 | 650 / 570 / 475 | 6.95e-6 | 1.18e-5 | 2.44e-5 | m⁻¹ |
| Bruneton / Hillaire | 680 / 550 / 440 | 5.802e-6 | 1.3558e-5 | 3.31e-5 | m⁻¹ |

These agree: rescaling GDM's 6.95e-6 @ 650 nm by λ⁻⁴ to 570 nm gives 1.175e-5 ✓ and to
475 nm gives 2.44e-5 ✓, and to Bruneton's 440 nm gives 3.32e-5 ✓ against 3.31e-5.
*(The 2003 course notes label these same three numbers 700/530/400 nm; that labelling is
internally inconsistent with λ⁻⁴ — use GDM's 650/570/475 or Bruneton's 680/550/440.)*

Sources for the Bruneton row:
- [Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*, EGSR 2020](https://sebh.github.io/publications/egsr2020.pdf),
  Table 1: `σ_rs = 5.802, 13.558, 33.1` in units of **×10⁻⁶ m⁻¹**, `σ_ra = 0`.
- [ebruneton/precomputed_atmospheric_scattering `demo.cc`](https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/demo/demo.cc):
  `kRayleigh = 1.24062e-6` with `rayleigh_scattering = kRayleigh · λ⁻⁴` (λ in µm), which
  evaluates to 5.80e-6 / 1.3556e-5 / 3.310e-5 at 680/550/440 nm. ✓
- [sebh/UnrealEngineSkyAtmosphere `SkyAtmosphereCommon.cpp`](https://github.com/sebh/UnrealEngineSkyAtmosphere/blob/master/Application/SkyAtmosphereCommon.cpp):
  `rayleigh_scattering = {0.005802f, 0.013558f, 0.033100f}; // 1/km`.

**Physical meaning:** per metre of clean sea-level air, 3.3×10⁻⁵ of blue radiance and
5.8×10⁻⁶ of red radiance is scattered out of the ray. Absorption is zero. Rayleigh alone
gives a meteorological visual range of **289 km** — clean air is essentially transparent at
2 km. *All of the haze you see at 1–2 km is aerosol.*

Rayleigh scale height (density e-folding): **8 km** (Hillaire Table 1, Bruneton
`kRayleighScaleHeight = 8000.0`). At your altitudes it is constant.

### 2.2 Mie / aerosol

Phase function — Henyey–Greenstein
([Henyey & Greenstein 1941](https://en.wikipedia.org/wiki/Henyey%E2%80%93Greenstein_phase_function),
as given in Preetham 2003):

```
f_HG(θ) = (1/4π) · (1 − g²) / (1 − 2g·cosθ + g²)^(3/2)          [sr⁻¹]
```

**Sign convention warning.** Preetham 2003 states plainly: *positive g = forward
scattering*. That is the standard graphics convention and the one your `wmHG` implements
(`1 + g² − 2g·cosθ`, peaks at `cosθ = 1` for `g > 0`). Hoffman's GDC 2002 course notes say
the opposite ("negative values of g will cause most of the light to be scattered in the
forward direction") and print the numerator as `(1 − g)²` rather than `(1 − g²)`. **The GDC
notes are wrong on both counts; follow Preetham/Bruneton/Hillaire.** Your `wmHG` is correct.

Cornette–Shanks is a slightly better Mie fit and is what Hillaire's paper actually uses
(EGSR 2020 §4):

```
p_m(θ, g) = (3 / 8π) · (1 − g²)(1 + cos²θ) / ((2 + g²)(1 + g² − 2g·cosθ)^(3/2))
```

Hillaire: *"Please note that it is also appropriate to use the simpler Henyey-Greenstein
phase function."* Stick with HG.

**Mie coefficient defaults (Bruneton / Hillaire, "clean Earth"):**

| quantity | value | units | meaning |
|---|---|---|---|
| `σ_ms` scattering | 3.996e-6 | m⁻¹ | aerosol scatter per metre at sea level |
| `σ_me` extinction | 4.440e-6 | m⁻¹ | scatter + absorb per metre |
| `σ_ma` absorption | 4.44e-7 | m⁻¹ | = extinction − scattering (SSA 0.9) |
| scale height | 1200 | m | aerosol layer e-folding height |
| `g` | 0.8 | — | HG asymmetry |

**Correction you should know about:** Hillaire's EGSR 2020 Table 1 prints
`Mie: σ_ms = 3.996, σ_ma = 4.40` (×10⁻⁶ m⁻¹) which reads as absorption = 4.40e-6, giving an
SSA of 0.476. His own reference implementation says otherwise:
`mie_scattering = 0.003996; mie_extinction = 0.004440; // 1/km`, i.e. **absorption is
0.444e-6 m⁻¹, and 4.44e-6 is the extinction.** Bruneton's `demo.cc` confirms:
`kMieAngstromBeta = 5.328e-3`, `kMieScaleHeight = 1200`, `kMieSingleScatteringAlbedo = 0.9`
→ extinction = 5.328e-3/1200 = 4.44e-6, scattering = 0.9 × that = 3.996e-6. The paper's
table label is a typo. **Use SSA 0.9 (or 0.97 for maritime), not 0.476.**

**These defaults are far too clean for your scene.** `σ_me = 4.44e-6 m⁻¹` over a 1.2 km
layer is an aerosol optical depth of 0.0053. Real tropical-coastal AOD(550 nm) is
**0.10–0.25**. Convert:

```
σ_aerosol_at_surface  =  AOD / H_aerosol
AOD = 0.15, H = 1200 m  →  σ = 1.25e-4 m⁻¹
```

### 2.3 Hoffman & Preetham's empirical haze table (GDM 2002, Table 1)

Directly measured, and the most useful sanity anchor:

| Description | β_sc^Haze R | G | B | units |
|---|---|---|---|---|
| Light haze | 2×10⁻⁵ | 3×10⁻⁵ | 4×10⁻⁵ | m⁻¹ |
| Heavy haze | 8×10⁻⁵ | 1×10⁻⁴ | 1.2×10⁻⁴ | m⁻¹ |
| Light fog | 9×10⁻⁴ | 1×10⁻³ | 1.1×10⁻³ | m⁻¹ |
| Heavy fog | ~1×10⁻² | ~1×10⁻² | ~1×10⁻² | m⁻¹ |

Also from that page: `β_ab^Haze` ranges 0 → ~5×10⁻⁵ m⁻¹, "usually negligible unless there
is a lot of pollution present", and is spectrally flat.

**⚠ I could not verify the `g` column of this table.** The printed PDF (page 5, right
column) literally shows `g = −1, −3, −10, −30` for the four rows. Those cannot be
Henyey–Greenstein asymmetry parameters, which require |g| < 1. The `β_sc^Haze` B cell for
"heavy fog" is likewise printed as `10⁻⁵`, which is inconsistent with `10⁻²` for R and G.
The table has a typesetting fault. **Do not use the `g` column.** I could not find a
corrected version of it; the ShaderX/Charles River reprint
(*Real-Time Light-Atmosphere Interactions for Outdoor Scenes*, Graphics Programming
Methods, 2003) may have it but I could not obtain that text.

### 2.4 Koschmieder — the sanity check to run on any β you invent

Meteorological visual range (distance at which a black object drops to a 2 % contrast
threshold):

```
V  =  3.912 / β_ex          [metres, using β_ex in m⁻¹ at ~550 nm]
```

(2 % threshold ⇒ ln(0.02) = −3.912. Sources:
[Wilson, Milton & Nield 2015, §on Koschmieder](https://www.rtwilson.com/academic/WilsonMiltonNield_2015_VisAOT.pdf);
[Horvath 1971, "On the applicability of the Koschmieder visibility formula"](https://www.sciencedirect.com/science/article/abs/pii/0004698171900813).)

Run it on every candidate density:

| β_ex(green) m⁻¹ | V | reads as |
|---|---|---|
| 1.36e-5 (Rayleigh only) | 289 km | perfectly clean air |
| 4.0e-5 | 98 km | exceptional clarity |
| 1.4e-4 | 28 km | clear tropical day, AOD 0.15 |
| 2.9e-4 | 13.6 km | typical hazy tropical day |
| 4.6e-4 | 8.5 km | visibly hazy |
| 8.0e-4 | 4.9 km | heavy haze / light mist |
| **6.2e-3 (yours)** | **0.63 km** | **fog. WMO "moderate fog".** |

### 2.5 Recommended values for your scene

Choose β by *the haze fraction you want at your far distance*, then verify the near field.
Anchor: 1500 m.

| target haze @1500 m | β_ex(G) m⁻¹ | @30 m | @100 m | @300 m | V |
|---|---|---|---|---|---|
| 25 % | 1.92e-4 | 0.57 % | 1.9 % | 5.6 % | 20.4 km |
| 35 % | 2.87e-4 | 0.86 % | 2.8 % | 8.3 % | 13.6 km |
| **50 %** | **4.62e-4** | **1.38 %** | **4.5 %** | **12.9 %** | 8.5 km |
| 60 % | 6.11e-4 | 1.82 % | 5.9 % | 16.7 % | 6.4 km |
| 70 % | 8.03e-4 | 2.38 % | 7.7 % | 21.4 % | 4.9 km |
| 85 % | 1.27e-3 | 3.72 % | 11.9 % | 31.6 % | 3.1 km |

For "distant sea stacks dissolve into a pale warm band at ~1.5 km while the foreground is
crisp", **β_ex(G) ≈ 5e-4 to 8e-4 m⁻¹** is the range. That is **8–13× lower than your
current 6.2e-3**. Start at `uAerialDensity = 0.00055` and tune within [0.0004, 0.0009].

Split it into physical species so the *colour* falls out rather than being authored:

```
β_ex^R_rgb = (5.802e-6, 1.3558e-5, 3.31e-5)      // Rayleigh, fixed, never an art knob
β_ex^M     = uAerialDensity  (scalar, grey)      // aerosol, the art knob
β_ex_rgb   = β_ex^R_rgb + β_ex^M
```

At `uAerialDensity = 5.5e-4`, `β_ex_rgb = (5.56e-4, 5.64e-4, 5.83e-4)` — B/R ratio 1.05.
**Expect a nearly-grey haze.** That is physically correct: the blue of aerial perspective is
a Rayleigh effect, and Rayleigh only dominates when total extinction is small. You cannot
have both "strongly blue" and "50 % opaque at 1.5 km" in a physical model. Halo's pale warm
band is the correct outcome — the haze takes the *colour of the illumination* (warm 40°
sun + blue-white sky), not the colour of the scatterer.

If you want a little more Rayleigh flavour without lowering density, use an Ångström
exponent on the Mie term: `β_M(λ) = β_M(550) · (λ/550)^(−α)`, with **α ≈ 0.3–0.8 for
maritime aerosol** (large, wet sea-salt particles → nearly spectrally flat) versus
α ≈ 1.3–1.6 continental. *(α range for marine aerosol is from the general AERONET/Maritime
Aerosol Network literature; I did not pin it to a single quotable table — treat as a
plausible art range, not a measurement.)*

### 2.6 `g` for tropical haze

- **Measurement:** AERONET marine boundary layer, subtropical eastern North Atlantic:
  asymmetry parameter `g = 0.77 ± 0.03` at 440 nm and `g = 0.75–0.76` at longer
  wavelengths; consistent with dust/marine mixtures at Cape Verde
  ([Atmos. Chem. Phys. 22, 11105, 2022](https://acp.copernicus.org/articles/22/11105/2022/)).
  Clean-marine studies use `g = 0.75`.
- **Graphics convention:** Bruneton `kMiePhaseFunctionG = 0.8`; Hillaire "By default,
  g = 0.8".

**Your `wmHG(cosT, 0.76)` is right.** Keep it. Do not raise it — g > 0.85 produces a hard
glare disc that will read as a bug (§7, F5).

**Important geometric consequence for your scene.** With the sun at 40° elevation and a
roughly horizontal camera, `cosθ` never exceeds `cos(40°) = 0.766` unless the player
pitches up. Evaluate HG at g = 0.76:

| cos θ | angle from sun | `f_HG` sr⁻¹ | × 4π (vs isotropic) |
|---|---|---|---|
| 1.00 | 0° | 2.432 | 30.6× |
| 0.90 | 26° | 0.350 | 4.4× |
| 0.766 | 40° | 0.127 | 1.6× |
| 0.50 | 60° | 0.045 | 0.57× |
| 0.00 | 90° | 0.017 | 0.21× |
| −1.00 | 180° | 0.0062 | 0.078× |

So for gameplay-typical horizontal views the forward lobe contributes only ~1.6× isotropic.
**The 30× peak only appears when you look directly at the sun.** If your frame is
uniformly hot when the sun is 40° up and off to the side, the phase function is not the
cause — an unnormalised constant is.

---

## 3. Why a correct in-scatter formulation *cannot* wash the near field

This is a two-line proof and it is worth internalising, because it means you never need a
near-field suppression hack.

```
L_in(s) = J · (1 − exp(−β_ex·s))
```

As `s → 0`, expand the exponential:

```
L_in(s)  →  J · β_ex · s  +  O(s²)
```

**The in-scatter goes to zero linearly in `s`, with slope `J·β_ex`.** Now bound both factors
independently:

1. **`J` is bounded by the sky radiance.** By construction `J = lim_{s→∞} L(s)` — it is the
   radiance of an infinite slab of the medium, i.e. the sky in that direction. So
   `J ≲ L_sky`. In a linear-HDR frame where a white sunlit lambertian surface reads ~1.0,
   `L_sky` is roughly 0.5–2.0 away from the sun disc.
2. **`β_ex·s` at 30 m is tiny.** With β_ex = 5e-4 m⁻¹: `β_ex · 30 = 0.015`.

Product: **in-scatter at 30 m ≤ ~1.5 % of sky radiance, and at 5 m ≤ 0.25 %.** The
extinction term is equally negligible: `exp(−0.015) = 0.985`, i.e. the surface loses 1.5 %
of its own radiance. Combined effect at 30 m is a ~1.5 % lerp toward the sky colour, which
is invisible.

**A correct implementation therefore needs no start distance, no smoothstep, no near
clamp.** The near field is untouched for free, as a consequence of the mathematics.

Which means: **if your near field is washed, exactly one of four things is true.**

| symptom cause | how to detect it in the shader |
|---|---|
| **(a) β_ex 5–30× too large** | evaluate `3.912/β_ex`; if < 5 km you are rendering fog |
| **(b) `J` is not `E·β_sc(θ)/β_ex`** | any term added to the fog colour that is not derived from a normalised phase × irradiance |
| **(c) an additive constant independent of `s`** | any term outside the `(1 − e^(−βs))` factor, or a constant inside the phase mix |
| **(d) the blend factor isn't `1 − e^(−β_ex·s)`** | `smoothstep(near, far, d)`, or a `pow()`, or a linear ramp — these are all non-zero immediately |

Your code has (a) and (c), and arguably (b).

**Aside — three.js's own fog is even flatter near the camera.** r185
`fog_fragment.glsl.js` FOG_EXP2 computes
`fogFactor = 1.0 - exp(-fogDensity*fogDensity * vFogDepth*vFogDepth)`, whose derivative at
`z = 0` is *zero* (quadratically flat). It is not physical in the far field, but it is
evidence that even the naive engine default does not wash the near field. If yours does,
it is not "fog is hard", it is a parameter error.
([mrdoob/three.js r185 fog_fragment.glsl.js](https://github.com/mrdoob/three.js/blob/r185/src/renderers/shaders/ShaderChunk/fog_fragment.glsl.js))

---

## 4. Where aerial perspective belongs: material shader vs fullscreen depth pass

### 4.1 The tradeoffs

**Per-surface, injected into the material (what `wmAerial` does today):**

| pro | con |
|---|---|
| Works for transparent/alpha-blended surfaces, which don't write depth | Must be replicated into every material and every custom shader — drift risk (this is exactly why `applyWorldMaterial` exists) |
| Correct under MSAA (per-sample) | Cost paid per shaded fragment *including overdraw* |
| Cheap to evaluate per-vertex for distant/low-poly geometry | Cannot ray-march a shadow map along the view ray → **no shafts, ever** |
| No depth-buffer round trip, no reconstruction error | Cannot be evaluated at reduced resolution |
| Trivially consistent with the sky if it reads the same uniforms | Impossible for opaques in a deferred pipeline |

**Fullscreen depth-based post pass:**

| pro | con |
|---|---|
| One shader, one owner, zero drift | Transparents don't write depth → they receive the aerial perspective of whatever is *behind* them |
| Can run at ½ or ¼ res with a bilateral (depth-weighted) upsample | Needs a bilateral upsample or you get halos at silhouettes |
| Can ray-march the shadow map → **shafts and volumetric shadows** | Must run *before* bloom and tonemap, in linear HDR, or the haze will not bloom and will be graded as if it were surface radiance |
| Exact per-pixel for opaques | Depth reconstruction must produce **radial** distance, not view-space z |
| Can be temporally reprojected/amortised | Interacts with TAA jitter (must be jitter-consistent) |

### 4.2 How production engines split it — and never double-apply

**The rule is: exactly one owner per pixel class, and the classes are disjoint.**

Hillaire, EGSR 2020 §5.4, states it explicitly:

> *"The aerial perspective volume texture is applied on opaque objects as a post process
> after lighting is evaluated, at the same time as the Sky-View LUT is applied on screen.
> For transparent elements in a forward-rendering pipeline, we apply aerial perspective at
> the per-vertex level."*

So in UE5:
- **Opaque pixels** → aerial-perspective LUT applied as a screen-space post process. The
  material never touches it.
- **Transparent pixels** → per-vertex in the forward pass (their reasoning: transparents are
  small in screen space relative to atmospheric variation, so per-vertex is enough).
- **Sky pixels** → the Sky-View LUT *is* the in-scatter integral to infinity. No separate
  aerial term. Applying aerial perspective to the sky would double-count.

The LUT is a 32×32×32 froxel volume fitted to the camera frustum, RGB = in-scatter,
A = mean transmittance, over a **32 km** depth range by default. Hillaire notes: *"If the
planet's atmosphere is really dense … then the depth range can be brought back closer to
the view point, in order to increase accuracy over short range."* For a 2 km scene you would
fit the volume to 2–4 km, giving you ~60–125 m per slice.

UE also exposes `aerial_perspective_start_depth` (kilometres) — *"the distance at which we
start evaluating the aerial perspective"* — and its documented purpose is **performance
(early-Z rejection of unaffected pixels)**, not near-field correction. It is not there to
stop washing. ([SkyAtmosphereComponent Python API](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/SkyAtmosphereComponent?application_version=5.0))
There is also `aerial_perspective_view_distance_scale` — *"makes the aerial perspective look
thicker by scaling distances from view to surfaces"*. **That is the right shape for an art
knob: scale `s`, not `β`,** so the physical coefficients stay physical and readable.

### 4.3 Recommendation for *your* pipeline

You have a G-buffer, a depth buffer, and a volumetric pass. The clean architecture is:

```
opaque surfaces   →  volumetricFog owns EVERYTHING (extinction + ambient in-scatter
                     + shadowed sun in-scatter). wmAerial is disabled for them.
transparents      →  wmAerial, per-vertex or per-pixel, ambient + unshadowed sun only.
sky               →  sky.js already integrates to infinity. Nothing else touches it.
```

Your `volumetricFog.js` header already documents the escape hatch for this
(`ctx.config.aerialDensity = 0` plus `fogGeoAmbient = 1`). Given that the analytic term is
currently mis-parameterised *and* double-applies the sun lobe, flipping to this split is
probably less work than fixing both.

**If you keep both**, the invariant that makes double-apply impossible is:

> The second pass must be a **multiplicative modulation of a term the first pass already
> owns**, never an additive second copy.

Concretely, for shafts, see §5.3.

---

## 5. Light shafts / god rays: compositing so they show in shadow without lifting the frame

### 5.1 The screen-space radial-blur method (GPU Gems 3, ch. 13)

Kenny Mitchell, [*Volumetric Light Scattering as a Post-Process*, GPU Gems 3 ch. 13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process).
The summation with control coefficients (their Eq. 4, verbatim from Listing 13-1):

```glsl
// Vector from pixel to light in screen space
vec2 deltaTexCoord = (texCoord - ScreenLightPos.xy);
deltaTexCoord *= 1.0 / float(NUM_SAMPLES) * Density;

vec3  color = texture(frameSampler, texCoord).rgb;
float illuminationDecay = 1.0;

for (int i = 0; i < NUM_SAMPLES; i++) {
    texCoord -= deltaTexCoord;
    vec3 s = texture(frameSampler, texCoord).rgb;
    s *= illuminationDecay * Weight;
    color += s;
    illuminationDecay *= Decay;
}
return vec4(color * Exposure, 1.0);
```

- `Density` — controls sample *separation*. Higher = tighter samples = brighter shafts
  covering a **shorter** range.
- `Weight` — per-sample scale (fine-grain brightness).
- `Decay ∈ [0,1]` — geometric falloff per sample, `decay^i`; makes shafts fade away from the
  sun.
- `Exposure` — overall output scale (coarse-grain brightness).
- `NUM_SAMPLES` — the demo used SM3.0 because the sample count exceeded SM2.0's limits;
  ~64–128 is typical. Chapter does **not** give a table of recommended numeric values.

### 5.2 The crucial physical statement in that chapter

Mitchell models occlusion as an **attenuation of the source illumination**, not as an
additive term:

> *"the effect due to occluding matter such as clouds, buildings, and other objects is
> modeled here simply as an attenuation of the source illumination"* — `E_sun → E_sun·D(φ)`,
> where `D` is the combined attenuated sun-occluder opacity.

Substituting into Eq. 4:

```
L_in(s,θ) = D · E_sun · β_sc(θ)/β_ex · (1 − e^(−β_ex·s))
```

`D ∈ [0,1]`. **This is multiplicative. It can only ever darken relative to the unoccluded
integral.** That is the whole answer to "visible in shadow without lifting the frame":
god rays are not light being added, they are shadow being *removed* from a medium that was
already bright.

### 5.3 The formulation to use (and the fix for your current double-apply)

Split the in-scatter into two lobes and give each exactly one owner:

```
J(θ)      = J_amb  +  J_sun(θ)
J_amb     = (β_sc/β_ex) · L̄_env                  // sky+ground, no shadowing
J_sun(θ)  = (β_sc/β_ex) · f(θ) · E_sun            // sun, shadow-dependent
```

Then:

```
L = L₀·T  +  J_amb·(1−T)  +  V̄ · J_sun(θ)·(1−T)
```

where `V̄ ∈ [0,1]` is the transmittance-weighted mean sun visibility along the ray,
which is exactly what your ray march computes:

```
V̄ = ∫₀^s T(0,t)·σ_s(t)·Vis(t) dt  /  ∫₀^s T(0,t)·σ_s(t) dt
```

**Two ways to composite this, both safe:**

**(A) Split by lobe (recommended, minimal change from what you have).**
- `wmAerial` computes **`J_amb` only** — delete the `uAerialSunColor * phase` term entirely.
- `volumetricFog` computes **`J_sun` only**, with visibility, and adds it.
- No pixel gets either lobe twice.
- *This is a one-line deletion in `wmAerial` and it is what your `volumetricFog.js` header
  comment thinks is already happening.* Right now `sunTerm` in `volumetricFog` is **not**
  gated by `geoW` (only `ambDir` is), so on opaque pixels the sun lobe is added by
  `volumetricFog` *and* baked into `wmAerial`'s `inscatter`. That is your double-apply.

**(B) Deficit form (bulletproof, slightly more plumbing).**
- The analytic term computes the full unshadowed `L` including `J_sun`.
- The volumetric pass outputs only `ΔL = −(1 − V̄) · J_sun(θ) · (1 − T)`, which is **≤ 0 by
  construction**.
- Composite is `L + ΔL`.
- In a fully lit region `V̄ = 1 → ΔL = 0` exactly. **The pass mathematically cannot lift the
  frame.** This is worth doing if you ever want to A/B the shaft pass on/off without the
  overall exposure changing.

Either way the composite must be `src·T + inscatter`, which is what your
`COMPOSITE_FRAG` already does (`src * fog.a + fog.rgb`).

### 5.4 The screen-space radial-blur variant, if you also want a lens-ish sun burst

If you keep a radial-blur god-ray pass *on top* of the volumetric integration (for the
Halo-style bloom-y shafts around the sun disc), the frame-lifting failure comes from
sampling the *lit scene* rather than an occlusion mask. GPU Gems 3 §13.5 gives three fixes;
use the first:

- **§13.5.1 Occlusion pre-pass** — render occluders **black and untextured** into the source
  buffer, sky/emissive normally. Radial-blur *that*. Then render the scene normally and
  **additively blend** the blurred mask result over it. Because occluders are black, a fully
  occluded region contributes zero and cannot lift.
- §13.5.2 stencil variant (mark emissive pixels, only stencilled samples contribute).
- §13.5.3 contrast reduction — *"this problem may be managed by reducing texture contrast
  through … fog, aerial perspective, or light adaption"*. Note the circularity: this only
  works if your aerial perspective is already correct.

Documented caveats you will hit, from §13.6:
- Shafts from background objects appear **in front of** foreground objects. Mitigation: it
  reads as a lens effect; reduce by keeping the pass subtle.
- Occluders crossing the screen edge cause **flicker** (samples leave the addressable
  range). Mitigation: render a guard band.
- When the sun is near-perpendicular to the view, its screen-space position tends to
  infinity → huge sample separation. **Clamp the screen-space light position to a guard-band
  region, and fade the effect out toward perpendicular and when the sun is behind the
  camera.**

Additional rules for not lifting the frame:
1. Run it **in linear HDR before tonemap**, so a bright shaft rolls off through the tonemap
   curve rather than raising the post-tonemap black level.
2. Multiply the whole pass by `smoothstep` on the sun's angular distance from the view
   frustum, and by `max(0, dot(viewDir, sunDir))`, so it is exactly zero when the sun is
   behind you.
3. Never add a constant. If your radial blur has any term that survives with an all-black
   source image, it is a black-level lift by definition.

---

## 6. WebGL2 / GLSL3 sketch

Three injects `#version 300 es` itself. Written as a drop-in replacement for the body of
`wmAerial`.

### 6.1 Pars

```glsl
// --- aerial perspective, physical form -------------------------------------
// beta in inverse metres. Rayleigh is fixed physics; Mie is the art knob.
const vec3 BETA_RAYLEIGH = vec3(5.802e-6, 1.3558e-5, 3.31e-5); // m^-1, 680/550/440nm
                                                               // Bruneton/Hillaire, sea level
uniform float uMieDensity;      // m^-1, aerosol extinction at base height. 4e-4 .. 9e-4
uniform float uMieG;            // HG asymmetry. 0.76 for tropical maritime haze
uniform float uMieSSA;          // single scattering albedo. 0.97 maritime, 0.9 continental
uniform float uHeightFalloff;   // 1/m. 0.0 = constant density; 1/1200 for a 1.2km layer
uniform float uDistanceScale;   // dimensionless art knob on s. 1.0 = physical

uniform vec3  uSunDir;          // normalised, pointing TOWARD the sun
uniform vec3  uSunIrradiance;   // E_sun: irradiance on a plane perpendicular to the sun,
                                // in the SAME linear units your surfaces are lit in.
                                // If a white lambertian facing the sun reads L, E = PI*L.
uniform vec3  uSkyRadianceUp;   // L_sky averaged over the upper hemisphere
uniform vec3  uSkyRadianceDown; // L_ground averaged over the lower hemisphere
uniform vec3  uCameraPos;

varying vec3 vWorldPositionWM;

float phaseRayleigh(float c) {          // sr^-1, integrates to 1 over the sphere
  return (3.0 / (16.0 * 3.14159265)) * (1.0 + c * c);
}

float phaseHG(float c, float g) {       // sr^-1, integrates to 1 over the sphere
  float g2 = g * g;
  float d  = max(1.0 + g2 - 2.0 * g * c, 1e-4);
  return (1.0 - g2) / (12.566370614 * d * sqrt(d));
}
```

### 6.2 The function

```glsl
vec3 wmAerial(vec3 color, vec3 worldPos, vec3 camPos) {
  vec3  v    = worldPos - camPos;
  float dist = length(v) * uDistanceScale;
  if (dist < 1e-3) return color;
  v /= max(length(v), 1e-4);

  // ---- optical depth along the ray -------------------------------------
  // Constant-density case, plus Wenzel/IQ analytic height integral.
  // NOTE: this scales BOTH species by the same height profile. That is a
  // simplification (Rayleigh's scale height is 8km, aerosol's is 1.2km) and is
  // fine at <2km ground range -- Preetham says so explicitly.
  float pathScale;
  if (uHeightFalloff < 1e-6) {
    pathScale = dist;
  } else {
    float hf = uHeightFalloff;
    float c0 = exp(-hf * max(camPos.y, 0.0));
    float fy = hf * v.y;
    pathScale = (abs(fy) > 1e-4)
      ? c0 * (1.0 - exp(-fy * dist)) / fy
      : c0 * dist;
  }

  vec3  betaR   = BETA_RAYLEIGH;
  float betaM   = uMieDensity;
  vec3  betaExt = betaR + vec3(betaM);

  vec3 tau = betaExt * pathScale;         // optical depth, dimensionless, per channel
  vec3 T   = exp(-tau);                   // transmittance, per channel  -> reddens L0

  // ---- equilibrium in-scatter radiance J -------------------------------
  float cosT = dot(v, uSunDir);
  float pR   = phaseRayleigh(cosT);
  float pM   = phaseHG(cosT, uMieG);

  vec3 betaScat = betaR + vec3(betaM * uMieSSA);   // scattering (not extinction)

  // sun lobe: irradiance [W/m^2] * phase [1/sr] = radiance [W/(m^2 sr)]  <- dimensionally
  // correct, and this is the part your current code gets wrong.
  vec3 Jsun = (betaR * pR + vec3(betaM * uMieSSA) * pM) / betaExt * uSunIrradiance;

  // ambient lobe: for a roughly uniform surrounding field, the phase integrates to 1,
  // so the contribution is just the mean environment radiance times the SSA.
  vec3 Lenv = mix(uSkyRadianceDown, uSkyRadianceUp, clamp(v.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 Jamb = (betaScat / betaExt) * Lenv;

  vec3 J = Jsun + Jamb;

  // ---- Hoffman/Preetham Eq.1 + Eq.3 + Eq.4 ------------------------------
  return color * T + J * (1.0 - T);
}
```

Notes on the sketch:

- **`color * T + J * (1 - T)` per channel**, not a scalar `mix`. The per-channel `T` is what
  reddens the transmitted surface colour and partially *preserves* saturation instead of
  crushing it.
- **`Jsun` uses irradiance × phase.** If your `time.sunColor` is authored as "the colour a
  white lambertian surface facing the sun shows", multiply by π to get irradiance.
- **`uDistanceScale`** is the art knob to reach for first (it is UE's
  `aerial_perspective_view_distance_scale`). It keeps `β` physically meaningful and
  readable.
- **No `uAerialStart`.** Delete it. §3 says you do not need it.
- For a **post-pass** version, everything is identical except `worldPos` is reconstructed
  from depth: `vec4 w = uInvVP * vec4(ndc, depth*2.0-1.0, 1.0); worldPos = w.xyz/w.w;` and
  `dist = length(worldPos - camPos)` — **radial**, which your `volumetricFog.js` already
  does correctly.

### 6.3 Sanity assertions to bake into a self-test

```
assert  1 - exp(-betaExt.g * 30.0)   <  0.03     // near field untouched
assert  1 - exp(-betaExt.g * 1500.0) in [0.4,0.8]
assert  3.912 / betaExt.g            in [3000, 20000]   // metres, Koschmieder
assert  phaseHG(-1.0, g) * 4.0*PI    <  0.15     // anti-solar lobe is dark
assert  |J(anti-sun) - skyRadiance(anti-sun)|  small     // no horizon seam
```

### 6.4 A three.js-specific trap

`three` r185's built-in fog uses **planar** depth: `fog_vertex.glsl.js` is
`vFogDepth = -mvPosition.z`. For aerial perspective you want **radial** distance
`length(worldPos - camPos)`. At a 90° horizontal FOV, a pixel at the screen edge is
`1/cos(45°) = 1.41×` further away than the planar depth says, so planar fog under-hazes the
screen edges by ~30 % of the haze amount. Your `wmAerial` correctly uses `length(v)`; keep
it, and do not accidentally "optimise" it to view-space z.

---

## 7. Failure modes, described so you can spot them in a screenshot

**F1 — "Milk on the lens" (near-field wash).**
*Look for:* a dark rock face 3 m from the camera whose shadowed side is grey rather than
near-black; your own weapon model looking dusty; the ground directly under the player
having the same shadow-interior brightness as a cliff 200 m away.
*Test:* screenshot a foreground shadow interior and read the darkest pixel. If it is above
~2 % of the frame's mid-grey, near-field in-scatter is leaking.
*Cause:* §3 (a)/(c)/(d).

**F2 — Saturation collapse.**
*Look for:* a red-brown rock at 5 m and blue-green water at 500 m reading as two values of
the same beige. Hue variance across the frame collapsing toward a single point.
*Test:* mean HSV saturation over the frame. A tropical daylight reference sits around
0.30–0.45; you are at 43 % of your target.
*Cause:* β too high (you replace 46 % of every pixel at 100 m), compounded by a
low-saturation `J` and a scalar (not per-channel) transmittance.

**F3 — "Sticker sky" / horizon seam.**
*Look for:* the most distant ridge is *outlined* against the sky — a thin visible edge
where the terrain is slightly bluer, greyer, or brighter than the sky immediately above it.
Most visible on a low, flat horizon.
*Test:* sample one pixel just below and one just above the horizon line at max view
distance. They should be within a few percent.
*Cause:* `J` is hand-authored and does not match what `sky.js` renders. Fix by deriving `J`
from the same uniforms, or by literally sampling your sky cubemap/LUT in direction `v`.

**F4 — Fog that darkens instead of hazes.**
*Look for:* distant terrain going grey-**dark**, so far hills are *darker* than the sky
behind them at midday. Overall frame luminance drops as you increase fog.
*Test:* toggle the fog pass; if mean luminance falls, extinction is being applied without
the matching in-scatter. (Your `volumetricFog.js` header records exactly this: "−4.3
lum_mean when the ambient term alone was zeroed".)
*Cause:* extinction and in-scatter gated by different switches. They must always be gated
together — the energy removed must be put back.

**F5 — "Headlight in fog" (unnormalised phase / g too high).**
*Look for:* pan toward the sun. Correct behaviour is a tight glow that is clearly brighter
only within ~15–25° of the sun disc and has fallen to near-nothing by 60°. Failure modes
are (i) *the whole lower half of the frame brightens uniformly* — unnormalised phase or a
constant lobe; or (ii) *a hard-edged bright disc with a visible boundary* — g too high
(> 0.85) or too few tonemap headroom.
*Numeric check:* `f_HG(cos=0, g=0.76)·4π = 0.21`. At 90° from the sun the haze should be
**5× dimmer** than isotropic, not brighter.

**F6 — Achromatic pedestal (angle-independent in-scatter).**
*Look for:* turn 180° from the sun and compare the haze colour to the 90°-from-sun haze
colour. They should differ noticeably — anti-solar haze is markedly cooler and darker.
If the haze looks the same in all directions, you have a constant additive term.
*In your code:* the `0.42` inside `mix(0.42, wmHG(...)*2.6, uAerialSunAmount)`.

**F7 — Near-plane contrast pop.**
*Look for:* strafe past a rock so it crosses your `uAerialStart` radius. A visible step in
its contrast as it crosses.
*Cause:* `uAerialStart = 6.0`. Delete it.

**F8 — Horizontal seam at eye height.**
*Look for:* a faint horizontal band across the frame at exactly the camera's altitude,
which moves as you pitch. Most visible against a flat sky or water.
*Cause:* the `v.y → 0` singularity in the height-fog integral. Your `abs(fy) > 1e-4` guard
handles it; if you see the seam, widen the threshold or lerp across it (Wenzel uses
`cSlopeThreshold = 0.01`).

**F9 — Double-apply halo at silhouettes.**
*Look for:* a bright or dark 2–4 px fringe where a near object silhouettes against a far
background — most visible on a thin object (an antenna, a railing) against distant terrain.
*Cause:* either the low-res fog buffer's bilateral upsample failing at the depth
discontinuity, or two passes both applying in-scatter to the same pixel with different
depths.

**F10 — God rays lifting the frame.**
*Look for:* (i) put the sun off-screen and toggle the shaft pass — the frame's black level
should not move at all; (ii) stand in a deep shadowed interior with the sun on screen
through a doorway — the interior's *unshafted* areas should stay dark.
*Cause:* additive radial blur over the lit scene rather than an occlusion mask, or a shaft
term added outside the transmittance weighting.

**F11 — Shafts visible on top of foreground objects.**
*Look for:* a shaft crossing *over* a near rock that should occlude it.
*Cause:* inherent to the GPU Gems 3 screen-space method (their §13.6 documents it as a
known limitation and notes it reads as a lens effect). Only fixed by volumetric
integration with depth, which your `volumetricFog` already does.

**F12 — Banding in the far gradient.**
*Look for:* concentric or vertical steps in the sky-to-terrain haze gradient, ~2–4 bands
across the distance ramp.
*Cause:* the haze gradient is smooth and low-contrast, so 8-bit quantisation shows. Fix
with a small dither before the 8-bit write, not by changing the fog.

---

## 8. Recommended change set, in priority order

1. **`uAerialDensity: 0.0062 → 0.00055`** (m⁻¹). Verify with `3.912/β` ≈ 7 km, and
   `1−exp(−β·30)` ≈ 1.6 %. Tune within [0.0004, 0.0009]. **This single change is expected to
   recover most of the missing 57 % of saturation.**
2. **Delete the `0.42` constant** from the phase mix. Replace
   `phase = mix(0.42, wmHG(cosT,0.76)*2.6, uAerialSunAmount)` with `phase = wmHG(cosT, 0.76)`
   and fold the intensity into `uSunIrradiance`.
3. **Delete `uAerialStart`.** §3.
4. **Fix the sun-lobe double-apply**: either gate `sunTerm` by `geoW` in `volumetricFog.js`
   (line ~272), or remove the sun lobe from `wmAerial` entirely (option A in §5.3).
   Right now `ambDir` is gated by `geoW` but `sunTerm` is not.
5. **`uAerialHeightFalloff: 0.021 → 0.0` or `0.0008`.** 1/0.021 = 48 m is a mist layer, not
   air. If you want the ground mist, make it a separate second layer.
6. **Make `T` per-channel** (`vec3 T = exp(-betaExt * pathScale)`) rather than a scalar
   `mix`. Cheap, and it stops the transmitted colour from being achromatically crushed.
7. **Derive `J` from the sky module's own radiances** rather than the three hand-authored
   `uAerial*Color` uniforms, or at least add a self-test asserting they agree at the
   horizon. Fixes F3 permanently.
8. **Add an `aerialDistanceScale` art knob** that scales `s`, and stop letting artists move
   `β`. This is UE's design and it keeps Koschmieder meaningful.

---

## 9. What I could not verify

- **The `g` column of Hoffman & Preetham's GDM 2002 Table 1.** The published PDF prints
  `−1, −3, −10, −30`, which are not valid HG asymmetry parameters. The same table's
  heavy-fog blue coefficient prints as `10⁻⁵` where R and G are `10⁻²`. The table is
  typographically corrupt and I could not find a corrected reprint. **I did not guess
  values.** Use the AERONET-measured `g ≈ 0.75–0.77` instead (§2.6).
- **Hillaire EGSR 2020 Table 1's Mie absorption.** The paper prints `σ_ma = 4.40` (×10⁻⁶
  m⁻¹). His own reference implementation says `mie_scattering = 0.003996; mie_extinction =
  0.004440` per km, i.e. absorption = 0.444×10⁻⁶ m⁻¹. Bruneton's `demo.cc` (SSA 0.9,
  Ångström β 5.328e-3, H 1200 m) agrees with the code, not the table. I am confident the
  table label is a typo but I could not find an erratum.
- **UE's default value for `aerial_perspective_start_depth`.** The API docs give the
  property and its meaning ("distance in kilometres at which we start evaluating the aerial
  perspective", motivated by early-Z performance) but not the default. I did not find a
  citable default.
- **Ångström exponent range for maritime aerosol (α ≈ 0.3–0.8).** This is standard
  atmospheric-optics common knowledge and consistent with the marine-aerosol literature I
  found, but I did not pin it to a single quotable table. Treat as an art range.
- **Typical AOD(550 nm) = 0.10–0.25 for tropical coastal sites.** Same caveat — a plausible
  and commonly cited range, not a value I read off a specific table in this session.
- **Halo: Campaign Evolved's actual atmospheric parameters.** Nothing public. Every number
  above is derived from physics plus the visual target you described, not from the shipped
  game.

---

## Sources

- [Hoffman, N. & Preetham, A. J., *Photorealistic Real-Time Outdoor Light Scattering*, Game Developer Magazine, August 2002](https://renderwonk.com/publications/gdm-2002/GDM_August_2002.pdf) — Eq. 1/3/4, Rayleigh coefficients, haze table.
- [Hoffman, N. & Preetham, A. J., *Rendering Outdoor Light Scattering in Real Time*, GDC 2002 course notes](https://renderwonk.com/publications/gdc-2002/hoffman.pdf) — derivation of the transport equation, phase functions.
- [Preetham, A. J., *Modeling Skylight and Aerial Perspective*, SIGGRAPH 2003 course notes](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf) — independent derivation of the same closed form; Rayleigh β expression; HG sign convention.
- [Hillaire, S., *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*, EGSR 2020](https://sebh.github.io/publications/egsr2020.pdf) — Table 1 coefficients, Cornette–Shanks, aerial-perspective LUT and its application rule (§5.4).
- [sebh/UnrealEngineSkyAtmosphere — `Application/SkyAtmosphereCommon.cpp`](https://github.com/sebh/UnrealEngineSkyAtmosphere/blob/master/Application/SkyAtmosphereCommon.cpp) — the authoritative numeric defaults in 1/km.
- [Bruneton, E. & Neyret, F., *Precomputed Atmospheric Scattering*, CGF 2008](https://inria.hal.science/inria-00288758/document) / [reference implementation `demo.cc`](https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/demo/demo.cc) — `kRayleigh`, `kMieAngstromBeta`, scale heights, `kMiePhaseFunctionG = 0.8`.
- [Wenzel, C., *Real-time Atmospheric Effects in Games*, SIGGRAPH 2006 Advanced Real-Time Rendering course, ch. 6](https://advances.realtimerendering.com/s2006/Chapter6-Real-time%20Atmospheric%20Effects%20in%20Games.pdf) — CryEngine 2 analytic height-fog integral and its slope-threshold guard.
- [Quílez, I., *Better Fog*](https://iquilezles.org/articles/fog/) — the same height integral, and the sun-direction fog-colour mix.
- [Mitchell, K., *Volumetric Light Scattering as a Post-Process*, GPU Gems 3 ch. 13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process) — god-ray summation, occlusion-as-source-attenuation, occlusion pre-pass, caveats.
- [mrdoob/three.js r185 `fog_fragment.glsl.js`](https://github.com/mrdoob/three.js/blob/r185/src/renderers/shaders/ShaderChunk/fog_fragment.glsl.js) and [`fog_vertex.glsl.js`](https://github.com/mrdoob/three.js/blob/r185/src/renderers/shaders/ShaderChunk/fog_vertex.glsl.js) — built-in FogExp2 form and planar `vFogDepth`.
- [Unreal Engine `SkyAtmosphereComponent` API](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/SkyAtmosphereComponent?application_version=5.0) — `aerial_perspective_start_depth`, `aerial_perspective_view_distance_scale`.
- [Rodríguez et al., *Aerosol characterisation in the subtropical eastern North Atlantic region using long-term AERONET measurements*, Atmos. Chem. Phys. 22, 11105 (2022)](https://acp.copernicus.org/articles/22/11105/2022/) — measured marine-boundary-layer asymmetry parameter g = 0.75–0.77.
- [Wilson, Milton & Nield, *Are visibility-derived AOT estimates suitable for parameterizing satellite data atmospheric correction algorithms?*, IJRS 2015](https://www.rtwilson.com/academic/WilsonMiltonNield_2015_VisAOT.pdf) and [Horvath, *On the applicability of the Koschmieder visibility formula*, Atmos. Environ. 5 (1971)](https://www.sciencedirect.com/science/article/abs/pii/0004698171900813) — V = 3.912/β_ext at a 2 % contrast threshold.
- [Jendersie & d'Eon, *An Approximate Mie Scattering Function for Fog and Cloud Rendering*, SIGGRAPH 2023 Talks](https://research.nvidia.com/labs/rtr/approximate-mie/publications/approximate-mie.pdf) — a better-than-HG phase fit, if you later want a real fog/cloud phase. Not needed for haze.
