# Sky and sun — physically-based daytime sky for a tropical scene, sun at ~40° elevation

Research brief for an implementer writing WebGL2 / GLSL ES 3.00 under three.js r0.185.1 today.
Every equation below is either (a) quoted from a primary source I opened and read, with the URL,
(b) derived here with the arithmetic shown, or (c) explicitly flagged as unverified.

---

## 0. Source ledger — read this first

**Primary sources I downloaded and extracted text from directly:**

| Source | What I actually pulled out |
|---|---|
| Preetham, Shirley, Smits, *A Practical Analytic Model for Daylight*, SIGGRAPH 1999. [PDF (Duke mirror)](https://courses.cs.duke.edu/fall01/cps124/resources/p91-preetham.pdf) · [SIGGRAPH history page](https://history.siggraph.org/learning/a-practical-analytic-model-for-daylight-by-preetham-shirley-and-smits/) | Perez eq. 3, normalisation eq. 4, **the full A–E turbidity matrices, the Yz formula, and both zenith-chromaticity matrices** — all quoted verbatim in §1.2. Note the Utah URL `cs.utah.edu/~shirley/papers/sunsky/sunsky.pdf` is dead (404 after redirect); the Duke mirror works. |
| Hosek & Wilkie, *An Analytic Model for Full Spectral Sky-Dome Radiance*, ACM TOG 31(4), SIGGRAPH 2012. [Preprint PDF](https://cgg.mff.cuni.cz/projects/SkylightModelling/HosekWilkie_SkylightModel_SIGGRAPH2012_Preprint_lowres.pdf) | **Eq. 8 (the extended Perez form with G·χ and I·cos^½θ), eq. 9 (χ), eq. 10 (L = F·L_M)**, the 0.01 horizon fudge factor and its justification, the turbidity definition, the validity limits. Quoted verbatim in §1.3. |
| Hosek & Wilkie reference implementation, `ArHosekSkyModel.cpp` / `ArHosekSkyModelData_Spectral.h` (v1.4a). [kumoworks mirror of the .cpp](https://github.com/opentoonz/kumoworks/blob/master/sources/ArHosekSkyModel.cpp) · [pbrt-v3 mirror of the .h](https://github.com/mmp/pbrt-v3/blob/master/src/ext/ArHosekSkyModel.h) | **The exact limb-darkening evaluation code and the 11 × 6 limb-darkening coefficient table.** Quoted verbatim in §2.2. Also `TERRESTRIAL_SOLAR_RADIUS = (0.51°)/2`. |
| Bruneton, *A Qualitative and Quantitative Evaluation of 8 Clear Sky Models*, IEEE TVCG 2017. [arXiv PDF](https://arxiv.org/pdf/1612.04336) | **Table 2 — the RMSE of every model against measurement**, the Preetham/Hosek qualitative sections, the aerosol inversion (α=0.8, β=0.04, g=0.7), the perceptual study. Quoted in §1.5. |
| Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*, EGSR 2020. [PDF](https://sebh.github.io/publications/egsr2020.pdf) · [Wiley](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14050) | **The non-linear Sky-View LUT latitude parameterisation** (§3.4), the aerial-perspective froxel volume defaults. This is the model `src/world/sky.js` already implements. |
| Ramamoorthi & Hanrahan, *An Efficient Representation for Irradiance Environment Maps*, SIGGRAPH 2001. [PDF (UCL mirror)](http://www0.cs.ucl.ac.uk/research/vr/Projects/VLF/vlfpapers/ibr/Ramamoorthi_R__An_Efficient_Representation_for_Irradiance_Environment_Maps__SIGGRAPH2001.pdf) · [Stanford](https://graphics.stanford.edu/papers/envmap/envmap.pdf) | **Eq. 9 — Â₀ = 3.141593, Â₁ = 2.094395, Â₂ = 0.785398, Â₃ = 0, Â₄ = −0.130900, Â₅ = 0, Â₆ = 0.049087**, and the first-9-Y_lm table. §4.3. |
| Gjøl & Svendsen (Playdead), *Banding in Games: A Noisy Rant*, GDC Europe / Digital Dragons 2016. [Slides PDF](https://loopit.dk/banding_in_games.pdf) · [talk video](https://www.youtube.com/watch?v=RdN06E6Xn9E) | **The entire §5.** Verbatim: the TPDF construction, the `[-1;1[` hindsight correction, the four "right colour space" cases, the "dither after quantisation does not work" slide, and the clamped-boundary lerp fix. |
| three.js r0.185.1, local `node_modules/three` | `examples/jsm/objects/Sky.js` verbatim (it is **not** Preetham — see §1.6), `ShaderChunk/dithering_*.glsl.js`, chunk ordering in `meshphysical.glsl.js`, `shGetIrradianceAt` constants, `LightProbeGenerator`, `PMREMGenerator` (HalfFloatType targets). |

**Secondary, used as cross-checks:**
[Koomen et al., *Luminance of the Sun*, JOSA 45(6) 1955](https://opg.optica.org/josa/abstract.cfm?uri=josa-45-6-483) (measured solar disc luminance — abstract only, see caveats);
[Smirnov et al., *Optical Properties of Atmospheric Aerosol in Maritime Environments*, JAS 59(3) 2002](https://data.giss.nasa.gov/gacp/publications/special/smirnov2.pdf) (marine AOD);
[Jimenez, *Next Generation Post Processing in COD:AW*, SIGGRAPH 2014](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/) (IGN);
[demofox on IGN](https://blog.demofox.org/2022/01/01/interleaved-gradient-noise-a-different-kind-of-low-discrepancy-sequence/);
[blog.frost.kiwi, *How to (and how not to) fix color banding*](https://blog.frost.kiwi/GLSL-noise-and-radial-gradient/);
[Wronski, *Dithering part three*](https://bartwronski.com/2016/10/30/dithering-part-three-real-world-2d-quantization-dithering/).

**Could NOT verify — do not build on these as fact:**
- **The JOSA 1955 solar-luminance numbers** (243 000 cd·cm⁻² centre / 193 000 cd·cm⁻² average) came to me through a search snippet of the abstract, not the paper. They are *internally* consistent with two independent things I did compute (§2.3), which is why I am willing to quote them, but I did not read the paper.
- **Lipshitz, Wannamaker & Vanderkooy 1992** (the theorem that 2-LSB TPDF makes both the mean and variance of quantisation error signal-independent). I am citing it *via* the INSIDE slide deck's own reference list; I did not open it. URL from the deck: `http://www.ece.rochester.edu/courses/ECE472/resources/Papers/Lipshitz_1992.pdf`.
- **The Hosek-Wilkie 2013 solar-radiance paper** (IEEE CG&A, "Adding a Solar-Radiance Function to the Hošek-Wilkie Skylight Model") is paywalled. I have its *implementation* (the code and coefficient table in §2.2), not its text.
- **The Kittler/Krochmann zenith-luminance relation** `Lz = (1.376T − 1.81) cot θ_sun + 0.38 kcd/m²` is quoted from Bruneton's §3, which cites it as [21]. I have not read [21]; §1.5 shows I had to *infer* that θ_sun there is the solar **zenith** angle by back-substituting Bruneton's own T = 2.53 against his Fig. 7. That inference is mine, not the paper's.
- Precise near-sun (aureole) sky luminance in cd/m². Bruneton's Fig. 7 y-axis tops out at 25 000 cd/m² and the sunward peak runs off it. My "≈2 × 10⁴ cd/m² at a few degrees from the sun" in §2.3 is a floor read off that plot, not a measurement.
- I did not find a citable source for the exact visual threshold at which a display-referred gradient starts to band. §5.1 gives the Weber arithmetic instead, which is defensible; the "1 code per 4 px" rule of thumb in §5.1 is my own and is labelled as such.

---

## 1. Which sky model

### 1.0 The short answer for this project

`src/world/sky.js` already implements a trimmed Hillaire 2020 (transmittance LUT → multiple-scattering LUT → sky-view LUT). **Keep it.** Bruneton's Table 2 (§1.5) puts a Bruneton-class precomputed-scattering model at RMSE 11.3 mW/(m²·sr·nm) against measurement, Hosek-Wilkie at 41.5, and Preetham at 88.1 — **Preetham is the worst of the eight models tested**, worse even than O'Neal (49.5).

Read §1.1–§1.4 anyway, because:
- Turbidity is the parameter you will be asked to expose, and you need to know what it physically means (§1.4) to pick a tropical value.
- The Perez/Hosek functional form is still the cheapest way to get a *reference* sky to validate the LUT chain against, and it is the right thing for the env-probe fallback path on low-end GPUs.
- Everyone's mental model of "the three.js sky" is `Sky.js`, and `Sky.js` is not actually Preetham (§1.6). Somebody will eventually propose swapping to it. Have the counter-argument ready.

### 1.1 The Perez formula (the common ancestor)

Preetham eq. 3, verbatim from the paper:

```
F(θ, γ) = (1 + A·e^(B / cos θ)) · (1 + C·e^(D·γ) + E·cos²γ)          (Preetham eq. 3)
```

- **θ** — angle between the view ray and the **zenith**, radians. 0 at zenith, π/2 at horizon.
- **γ** — angle between the view ray and the **sun**, radians.
- **A** darkening/brightening of the horizon
- **B** luminance gradient near the horizon
- **C** relative intensity of the circumsolar region
- **D** width of the circumsolar region
- **E** relative backscattered light

(Those five physical meanings are Preetham's own wording, §2 of the paper.)

The Perez formula is *relative*; you anchor it at the zenith:

```
Y = Y_z · F(θ, γ) / F(0, θ_s)                                         (Preetham eq. 4)
```

where **θ_s** is the sun's zenith angle. `F(0, θ_s)` is F evaluated straight up (θ=0, so γ from the zenith to the sun is exactly θ_s).

### 1.2 Preetham's turbidity fits — every coefficient, verbatim

All of these are Appendix A.2 of the paper. **T is turbidity, valid 2 ≤ T ≤ 6** (the paper's own stated range; Hosek §2.3.1 confirms "the authors of the Preetham model decided to go with a valid turbidity range of 2 to 6").

**Luminance distribution coefficients:**

```
A_Y =  0.1787·T − 1.4630
B_Y = −0.3554·T + 0.4275
C_Y = −0.0227·T + 5.3251
D_Y =  0.1206·T − 2.5771
E_Y = −0.0670·T + 0.3703
```

**x chromaticity distribution coefficients:**

```
A_x = −0.0193·T − 0.2592
B_x = −0.0665·T + 0.0008
C_x = −0.0004·T + 0.2125
D_x = −0.0641·T − 0.8989
E_x = −0.0033·T + 0.0452
```

**y chromaticity distribution coefficients:**

```
A_y = −0.0167·T − 0.2608
B_y = −0.0950·T + 0.0092
C_y = −0.0079·T + 0.2102
D_y = −0.0441·T − 1.6537
E_y = −0.0109·T + 0.0529
```

**Zenith luminance**, in **kcd/m²** (the paper says "Absolute value of zenith luminance in Kcd·m⁻²" — this is the single most common unit bug in reimplementations):

```
χ  = (4/9 − T/120) · (π − 2·θ_s)          θ_s = solar ZENITH angle, radians
Y_z = (4.0453·T − 4.9710)·tan(χ) − 0.2155·T + 2.4192      [kcd/m²]
```

**Zenith chromaticities.** These are `[T² T 1] · M · [θ_s³ θ_s² θ_s 1]ᵀ` with θ_s the solar zenith angle in radians. The OCR of the paper truncates to 4 decimals; the 5-decimal values below are the ones every reference implementation uses and they agree with the paper's printed digits to the last place shown:

```
        ⎡  0.00166  −0.00375   0.00209   0.00000 ⎤
x_z = [T² T 1] · ⎢ −0.02903   0.06377  −0.03202   0.00394 ⎥ · [θ_s³ θ_s² θ_s 1]ᵀ
        ⎣  0.11693  −0.21196   0.06052   0.25886 ⎦

        ⎡  0.00275  −0.00610   0.00317   0.00000 ⎤
y_z = [T² T 1] · ⎢ −0.04214   0.08970  −0.04153   0.00516 ⎥ · [θ_s³ θ_s² θ_s 1]ᵀ
        ⎣  0.15346  −0.26756   0.06670   0.26688 ⎦
```

Paper's printed values for cross-check (x row 1): `0.0017 −0.0037 0.0021 0.000`; (x row 3): `0.1169 −0.2120 0.0605 0.2589`; (y row 3): `0.1535 −0.2676 0.0667 0.2669`. All consistent.

Then `x = x_z·F_x(θ,γ)/F_x(0,θ_s)`, `y = y_z·F_y(...)/F_y(...)`, `Y` from eq. 4, and convert xyY → XYZ → linear sRGB.

**The three landmines in that last step:**
1. `Y_z` is in kcd/m². Multiply by 1000 before treating it as cd/m², or divide it out consistently. If you skip this and then "fix" it with an exposure fudge you will have silently broken the ratio between sky and sun.
2. xyY → XYZ is `X = x·Y/y`, `Y = Y`, `Z = (1−x−y)·Y/y`. `y` can go to zero near the horizon at high T. Clamp `y ≥ 1e-4`.
3. XYZ → linear sRGB with the standard Rec.709 matrix produces **negative** values for saturated sky blues. Clamping to zero desaturates; the right answer for a photographic still is a gamut-map (scale toward white until in gamut), not a clamp.

### 1.3 Hosek-Wilkie — the extended form, verbatim

From the SIGGRAPH 2012 preprint, eqs. 8, 9, 10:

```
F(θ, γ) = (1 + A·e^(B / (cos θ + 0.01)))
        · (C + D·e^(E·γ) + F·cos²γ + G·χ(H, γ) + I·cos^(1/2) θ)      (eq. 8)

χ(g, α) = (1 + cos²α) / (1 + g² − 2g·cos α)^(3/2)                     (eq. 9)

L = F(θ, γ) · L_M                                                      (eq. 10)
```

Nine parameters A…I per channel, plus one master value L_M per channel. What each addition buys, in the authors' own words:

- **`+ 0.01` in the denominator.** *"in the original Perez formula, as the viewing direction neared the horizon, the values diverged towards infinity and when querying luminance exactly at the horizon, it would produce division by zero: when θ becomes 90°, B/cos θ becomes undefined. This is solved simply by adding a small fudge factor that moves the offending division by zero about 0.5° below horizon and also solves the extremely bright rim around horizon."* — Arithmetic check: `cos θ + 0.01 = 0` ⟹ `θ = 90.573°`, i.e. 0.573° below the horizon. Matches. **This is the single most important line in §3.**
- **`G·χ(H,γ)`** — a Mie-like anisotropic lobe. *"The zero order glow of Mie scattering produces a phenomenon called circumsolar ring (aureole). This produces a highly localised spike, one that is impossible to accurately fit using the original Perez formula."* H is the lobe's asymmetry (the "g" of a Henyey-Greenstein-shaped term).
- **`I·cos^½θ`** — *"at lower solar elevations, the aureole does not extend towards the zenith nearly as much as it does towards the horizon and sides… When I is set to a negative value (as it always is with our fitted data), it suppresses brightness around the zenith, and thereby also reduces the extent of the aureole around the zenith."*
- **`C` replacing the leading `1`, and no zenith normalisation.** *"we opted out of any explicit normalisation… L_M is the expected value of spectral radiance in a point randomly picked in the upper hemisphere with uniform distribution."* Consequence: **Hosek-Wilkie F is absolute, Preetham F is relative.** Do not port a Preetham `F(θ,γ)/F(0,θ_s)` normalisation into a Hosek evaluator; it will be wrong by a factor that varies with sun elevation.

**Scope and validity, stated by the authors and confirmed by Bruneton §12.3:**
- Turbidity 1 ≤ T ≤ 10 (dataset range). Preetham's is 2–6.
- Ground albedo α ∈ [0,1], **per channel**. Genuinely useful over a bright tropical lagoon.
- Solar elevation ≥ 0° only. *"there are technical reasons why we did not extend the fitting process beneath solar elevations of 0°"* — the dark crescent that appears in the reference at −5° cannot be fitted by this function family.
- **Ground-level observer only.** No aerial perspective at all (Preetham at least ships a separate — and inconsistent — aerial-perspective model).
- The fitted sky **excludes the solar disc**: *"the fitted model therefore does not include the solar disc, so users of the model have to include it separately."* Same is true of Preetham. §2 is not optional.

The A…I parameters are Bézier-interpolated over turbidity/albedo/elevation from a large baked table (`ArHosekSkyModelData_*.h`, ~500 KB for the spectral version, ~67 KB for the CIE XYZ version). For a WebGL2 port, use the **CIE XYZ** dataset (`ArHosekSkyModelData_CIEXYZ.h`, 67 KB) and evaluate the 9 params on the CPU once per sun move, then push 3×10 floats as uniforms. Do not try to evaluate the Bézier fit in the shader.

### 1.4 Turbidity — what it physically is, and what to use for a tropical sky

Hosek §2.3, verbatim:

> Linke's turbidity factor [McCartney 1976], or turbidity for short, serves as a simple and intuitive measure of the aerosol content of the air. It is defined as the ratio of the additional optical thickness of the atmosphere in question t_h to the optical thickness of an idealised atmosphere that consists only of pure gas t_m:
>
> **T = (t_m + t_h) / t_m**    (eq. 4)
>
> T = 2 yields a very clear, Arctic-like sky, T = 3 a clear sky in a temperate climate, T = 6 a sky on a warm, moist day, T = 10 a slightly hazy day, and values of T above 50 represent dense fog.

Preetham defines it identically ("the ratio of the optical thickness of the haze atmosphere to that of the pure molecular atmosphere") and adds the *meteorological range* reading: T is what sets how far you can see. Note it is **dimensionless and ≥ 1 by construction** (T = 1 is a pure-gas atmosphere).

**What to use for a clear tropical marine scene:**

| Quantity | Value | How I got it |
|---|---|---|
| Aerosol optical depth τ(500 nm), tropical Pacific marine background | **0.07 mean, mode 0.06, σ 0.02–0.05** | [Smirnov et al. 2002, JAS 59(3)](https://data.giss.nasa.gov/gacp/publications/special/smirnov2.pdf) |
| Ångström exponent α for marine aerosol | **≈ 0.8** | Bruneton's own inversion against measurement: *"we found a minimum RMSE at 0.8, 0.04, 0.7"*, refined to α = 0.816, β = 0.0384, g = 0.704. Note his β = 0.04 is Ångström's β, i.e. τ at 1 µm; τ(550 nm) = β·(0.55)^−α = 0.04 · 0.55^−0.8 = 0.0655. **Independently lands on the same 0.065 as Smirnov.** |
| Cornette-Shanks / HG asymmetry g for that aerosol | **0.70** | same inversion |
| Linke turbidity T | **≈ 3.3** | Computed from the pyWaPOR/ESRA conversion `T_LK = 3.91·τ₅₅₀·e^(0.689·p_rel) + 0.376·ln(TCWV) + (2 + 0.54·p_rel − 0.34·p_rel²)` with p_rel = 1 (sea level), τ₅₅₀ = 0.065, TCWV = 4.5 cm (tropical): 0.506 + 0.566 + 2.20 = **3.27**. **Flagged**: I did not verify that this conversion's `T_LK` and Hosek's `T` are the same quantity to better than ~±0.5. Treat 3.3 as "clear tropical", and expect to art-direct it between 2.6 and 4.0. |
| What Bruneton fitted to real measured skies | **T = 2.53** (2.33 for Preetham's own RMSE minimum, 2.62 for Hosek's) | Bruneton §3 |

**Use T = 3.0–3.5.** T = 2 is Arctic and will read as thin and cold — wrong for the tropics. T = 6 ("warm, moist day") kills the deep blue and is what you want only if you are also rendering haze. Above T ≈ 4, Hosek's own Fig. 1 shows Preetham visibly failing ("*At T = 6, both the horizon colour pattern and the luminance distribution are considerably off*"), which is another reason not to reach for Preetham for a warm scene.

### 1.5 Accuracy: the numbers that decide the argument

Bruneton 2017, **Table 2**, verbatim. RMSE is in **mW/(m²·sr·nm)** against measured clear skies (Kider et al.'s data), computed over 81 sky directions × 40 wavelengths from 360–830 nm:

| Model | Viewpoints | Aerial persp. | Sunset/rise | Scattering orders | Render time | **RMSE** |
|---|---|---|---|---|---|---|
| Nishita93 | all | yes | yes | 1 | O(n) | 26.6 |
| Nishita96 | in atmosphere | yes | yes | 2 | O(n) | 18.3 |
| **Preetham** | ground only | yes | **no** | 2 | **O(1)** | **88.1** |
| O'Neal | all | yes | yes | 1 | O(n) | 49.5 |
| Haber | ground only | yes | yes | all | O(n²) | 14.7 |
| **Bruneton** | all | yes | yes | all | **O(1)** | **11.3** |
| Elek | all | yes | yes | all | O(1) | 11.3 |
| **Hosek** | ground only | **no** | **no** | all | **O(1)** | **41.5** |

Bruneton's own verdicts:
- Preetham: *"overestimates the measured values, by a large factor (about 2; the RMSE is 88.1). The relative luminance and the chromaticity are also quite different from the measured ones… especially near the Sun or the horizon."*
- Hosek: *"overestimates the measured values, by a large factor (but not as large as for the Preetham model), except near the sun where, on the contrary, it underestimates the measured values."*

**Cross-check I ran myself, so you can see the size of the Preetham error in units you care about.** Sun at 40° elevation ⟹ θ_s = 50° = 0.87266 rad. T = 2.5.

```
χ    = (4/9 − 2.5/120)(π − 2·0.87266) = 0.423611 × 1.396263 = 0.591480 rad
tanχ = 0.67167
Y_z  = (4.0453·2.5 − 4.9710)·0.67167 − 0.2155·2.5 + 2.4192
     = 5.14225·0.67167 + 1.88045
     = 5.334 kcd/m²  =  5334 cd/m²
```
Against the empirical relation Bruneton uses to *calibrate* turbidity from measurement,
`Lz = (1.376·T − 1.81)·cot θ_sun + 0.38 kcd/m²`, with θ_sun = 50° solar zenith:
```
Lz = (1.376·2.5 − 1.81)·cot(50°) + 0.38 = 1.630 × 0.83910 + 0.38 = 1.748 kcd/m²
```
**Preetham is 3.05× too bright at the zenith at this sun elevation.** That is not a subtle fit error; it is a whole 1.6-stop exposure error that you will then compensate with an exposure knob, which silently destroys the sun:sky ratio in §2.3. (Caveat repeated: my identification of θ_sun in that relation as the solar *zenith* angle is an inference — see §0.)

**The perceptual study is worth knowing too**, because "physically accurate" and "reads as photographic" are not automatically the same thing. 25 lab participants + 105 online, pairwise "click the more realistic image":

> *"these results show that the less physically accurate models, according to our results in Table 2, i.e. the Preetham and O'Neal models, are also perceived as less realistic by the participants. Conversely, the more physically accurate models are perceived as more realistic. However, it seems that participants perceive models whose physical accuracy is 'good enough' as equally realistic."*

For the morning sky (the closest scene to yours): Bruneton, Hosek, Nishita96 and Haber tied at the top with no statistically significant difference; Preetham and O'Neal dead last. **So: your Hillaire implementation is already in the top group. Hosek-Wilkie would be a lateral move. Preetham would be a downgrade.**

### 1.6 three.js `Sky.js` is not Preetham, and its sun disc is 2× too big

I read `node_modules/three/examples/jsm/objects/Sky.js` in full. It is a Preetham-*flavoured* hand-tuned shader, not the Preetham model. The tells, verbatim from the file:

```glsl
vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
Lin *= mix( vec3( 1.0 ), pow( vSunE * (...) * Fex, vec3( 1.0 / 2.0 ) ),
            clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 1.0 ) );
...
vec3 texColor = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );
```

A `pow(..., 1.5)`, a `pow(..., 0.5)` blended by a Fresnel-shaped term, a `* 0.04`, and an additive `vec3(0, 0.0003, 0.00075)` floor. None of those are in Preetham. There are no Perez A–E coefficients anywhere in the file. There is no `Y_z`. The vertex shader's `sunIntensity()` is an ad-hoc `EE * max(0, 1 − exp(−(cutoffAngle − acos(μ))/1.5))` with `EE = 1000` and a "earth shadow hack" comment. **`Sky.js` has no absolute photometric meaning at all.** Do not put it into a lighting rig.

**Concrete bug worth knowing** (this is arithmetic, verify it yourself):

```glsl
// 66 arc seconds -> degrees, and the cosine of that
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;
...
float sundisc = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );
```

`acos(0.999956676946448) = 9.3084 × 10⁻³ rad = 0.53333°`. But `cosTheta = dot(direction, vSunDirection)` is the cosine of the angle from the sun **centre**, so this threshold is an angular **radius** of 0.5333°, i.e. a disc **1.0667° across — exactly twice the real sun.** (The comment "66 arc seconds" is also wrong; 0.53333° is 1920 arcsec.) If you have ever used `Sky.js` as a look reference, its sun is 2× oversized and your bloom tuning inherited that.

Your own `src/world/sky.js` uses `uSunAngularRadius = 0.0047` rad = 0.2693°, diameter 0.5386°. That is correct to within 1%; the exact value is 0.004654 rad (§2.1).

---

## 2. The sun disc

The sky model does not contain the sun. Both Preetham and Hosek-Wilkie explicitly exclude it from the fit. You add it, and its absolute level relative to the sky is what drives every downstream effect: bloom, veiling glare, lens ghosts, the ocean's specular sun glitter, and whether the tonemapper's shoulder has anything to do.

### 2.1 Geometry — angular diameter and solid angle

| Quantity | Value | Source |
|---|---|---|
| Mean angular **diameter** | **0.5334° = 31′59″ = 9.3084 mrad** | [Wikipedia: Angular diameter](https://en.wikipedia.org/wiki/Angular_diameter) gives the range 31′27″–32′32″; mean ≈ 32′. |
| Range over the year | 31′27″ (aphelion, 0.5242°) to 32′32″ (perihelion, 0.5422°) | same |
| Angular **radius** | **0.2667° = 4.6542 mrad = 0.0046542 rad** | half of the above |
| **Solid angle Ω_sun** | **6.805 × 10⁻⁵ sr** | Ω = 2π(1 − cos 0.2667°) = 2π × 1.0830 × 10⁻⁵. Computed here. |
| Hosek-Wilkie reference impl. uses | 0.51° diameter (`TERRESTRIAL_SOLAR_RADIUS = (0.51 DEGREES)/2.0`) | `ArHosekSkyModel.cpp` line 133 — that is 4.4% small; harmless for a sky model, wrong if you are matching a photograph. |

**Use 0.0046542 rad for the angular radius.** Not 0.0047, not 0.5° "close enough".

**How many pixels is that?** With a 40° vertical FOV at 1080 px, one pixel subtends 40/1080 = 0.03704°, so the disc is **0.5334 / 0.03704 = 14.4 px across**. Cross-check by solid angle: Ω_px ≈ (6.46 × 10⁻⁴ rad)² = 4.17 × 10⁻⁷ sr; 6.805 × 10⁻⁵ / 4.17 × 10⁻⁷ = 163 px of area; πr² = 163 ⟹ r = 7.2 px, d = 14.4 px. ✓

At 14 px diameter the disc is **badly aliased by a hard threshold** and **badly under-resolved by one sample per pixel**. See §2.5.

### 2.2 Limb darkening — the actual coefficients

The Hosek-Wilkie reference implementation evaluates limb darkening exactly like this (`ArHosekSkyModel.cpp`, `arhosekskymodel_solar_radiance_internal2`, verbatim):

```c
const double sol_rad_sin = sin(state->solar_radius);
const double ar2         = 1 / ( sol_rad_sin * sol_rad_sin );
const double singamma    = sin(gamma);
double sc2 = 1.0 - ar2 * singamma * singamma;
if (sc2 < 0.0 ) sc2 = 0.0;
double sampleCosine = sqrt (sc2);

//   here, we directly use fitted 5th order polynomials provided by the
//   astronomical community for the limb darkening effect.
double  darkeningFactor =
      ldCoefficient[0]
    + ldCoefficient[1] * sampleCosine
    + ldCoefficient[2] * pow( sampleCosine, 2.0 )
    + ldCoefficient[3] * pow( sampleCosine, 3.0 )
    + ldCoefficient[4] * pow( sampleCosine, 4.0 )
    + ldCoefficient[5] * pow( sampleCosine, 5.0 );

direct_radiance *= darkeningFactor;
```

`sampleCosine` is **μ**, the cosine of the angle between the line of sight and the local solar surface normal. For a normalised disc radius `d = γ/R_sun ∈ [0,1]`, that is exactly **μ = √(1 − d²)**. μ = 1 at disc centre, μ = 0 at the limb.

The coefficient table, verbatim from `ArHosekSkyModelData_Spectral.h`:

| λ (nm) | c₀ | c₁ | c₂ | c₃ | c₄ | c₅ |
|---|---|---|---|---|---|---|
| 440 | 0.158489 | 1.23346 | −0.875754 | 0.857812 | −0.484919 | 0.110895 |
| 480 | 0.198587 | 1.30507 | −1.25998 | 1.49727 | −1.04047 | 0.299516 |
| 520 | 0.23695 | 1.29927 | −1.28034 | 1.37760 | −0.85054 | 0.21706 |
| 560 | 0.26892 | 1.34319 | −1.58427 | 1.91271 | −1.31350 | 0.37295 |
| 600 | 0.299804 | 1.36718 | −1.80884 | 2.29294 | −1.60595 | 0.454874 |
| 640 | 0.33551 | 1.30791 | −1.79382 | 2.44646 | −1.89082 | 0.594769 |
| 680 | 0.364007 | 1.27316 | −1.73824 | 2.28535 | −1.70203 | 0.517758 |
| 720 | 0.389704 | 1.2448 | −1.69708 | 2.14061 | −1.51803 | 0.440004 |

(The table also has 320 and 360 nm rows, irrelevant here.)

**Sanity checks I ran on this table:**
- Σcᵢ at μ = 1 must be 1 (normalised to disc centre). 440 nm: 0.999983. 600 nm: 0.999808. ✓
- At μ = 0 the value is just c₀, so **the limb is 16% of the centre in blue, 24% in green, 34% in red**. That is why the solar limb is orange and why a correctly limb-darkened disc has a warm rim even at high sun.

**The two-parameter fit you actually want in a shader.** The Hestroffer-Magnan form `I(μ)/I(1) = 1 − u·(1 − μ^α)` is one `pow` per channel instead of five multiply-adds per channel. I fitted u and α per RGB primary by (i) matching the limb value exactly, and (ii) matching the disc-average exactly:

```
disc average of the polynomial = ∫₀¹ I(μ)·2μ dμ = 2·Σ cᵢ/(i+2)
disc average of the H-M form   = (1 − u) + u·2/(α + 2)
```

| Channel | λ used | limb ratio c₀ | **u = 1 − c₀** | disc avg from poly | **α** |
|---|---|---|---|---|---|
| R | 640 nm | 0.3355 | **0.664** | 0.8288 | **0.695** |
| G | 520/560 mean | 0.2529 | **0.747** | 0.7993 | **0.735** |
| B | 440/480 mean | 0.1785 | **0.821** | 0.7661 | **0.796** |

Residual check of the fit against the 5th-order polynomial at 560 nm: at μ = 0.9, poly = 0.9474, fit = 0.9443 (0.33% low); at μ = 0.5, poly = 0.7131, fit = 0.7018 (1.6% low). **Good enough for a 14-px disc by a wide margin.**

```glsl
// d = angular distance from sun centre / solar angular radius, in [0,1]
const vec3 LIMB_U     = vec3( 0.664, 0.747, 0.821 );
const vec3 LIMB_ALPHA = vec3( 0.695, 0.735, 0.796 );

vec3 limbDarkening( float d ) {
    float mu = sqrt( max( 1.0 - d * d, 0.0 ) );
    return vec3( 1.0 ) - LIMB_U * ( vec3( 1.0 ) - pow( vec3( mu ), LIMB_ALPHA ) );
}
```

**What is currently in `src/world/sky.js` (line ~929):**
```glsl
vec3 u = vec3(0.42, 0.56, 0.70);
vec3 limbD = vec3(1.0) - u*(vec3(1.0) - pow(vec3(mu), vec3(0.55)));
```
Same functional form, but **u is 37%/25%/15% too small** — the limb comes out at 0.58/0.44/0.30 of centre where astronomy says 0.34/0.25/0.18. The disc reads flatter and less orange-rimmed than a real sun. Swapping in the numbers above is a one-line change with a real, if subtle, payoff on a photographic still: the disc gains a soft warm edge instead of being a uniform white sticker.

### 2.3 Absolute levels — the sun:sky ratio, which is the number that matters

This is the part that drives bloom, and it is the part people get wrong by three orders of magnitude.

**Solar disc luminance.**

| Quantity | Value | Provenance |
|---|---|---|
| Disc-**centre** luminance, outside the atmosphere | 2.43 × 10⁹ cd/m² (243 000 cd/cm² ± 5000) | [Koomen et al., JOSA 45(6) 1955](https://opg.optica.org/josa/abstract.cfm?uri=josa-45-6-483) — **abstract only, see §0** |
| Disc-**average** luminance, outside the atmosphere | 1.93 × 10⁹ cd/m² (193 000 cd/cm² ± 4000) | same |
| Implied luminous solar constant | 1.93 × 10⁹ × 6.805 × 10⁻⁵ = **131 400 lx** | computed here |
| Implied centre/average ratio | 243/193 = **1.259** | computed here |

**Independent verification of that pair of numbers, which is why I trust them despite only seeing the abstract:** the Hosek limb-darkening polynomial predicts a centre/average ratio of `1 / 0.806 = 1.241` at 560 nm (from the disc-average integral in §2.2). Measured 1.259, predicted 1.241 — **1.5% apart, from two completely unrelated sources.** And the implied 131 klx luminous solar constant is right on top of the commonly cited 133 klx. Two chains agree; use them.

**At the ground, sun at 40° elevation, clear tropical marine air:**

```
relative air mass m ≈ 1/sin(40°) = 1.556
broadband luminous transmittance at T≈3.3, m≈1.56:  ≈ 0.72–0.78
disc-average luminance at ground ≈ 1.93e9 × 0.75 ≈ 1.4 × 10⁹ cd/m²
disc-centre  luminance at ground ≈ 1.8 × 10⁹ cd/m²
implied direct normal illuminance = 1.4e9 × 6.805e-5 ≈ 95 000 lx
```
That 95 klx lands inside the textbook 50–130 klx band for direct sunlight, which is the third independent check.

**Sky luminance, same conditions:**

| Where | Luminance | Source |
|---|---|---|
| Zenith | ≈ 1.8 × 10³ cd/m² | Kittler relation at θ_s = 50°, T = 2.53 (§1.5) |
| 90° from the sun, mid-elevation | ≈ 2–6 × 10³ cd/m² | Bruneton Fig. 7 luminance profiles |
| Horizon band | ≈ 8–15 × 10³ cd/m² | Bruneton Fig. 7 (rises strongly toward the horizon) |
| A few degrees from the sun (aureole) | **≳ 2 × 10⁴ cd/m²** | Bruneton Fig. 7 — the y-axis stops at 25 000 and the peak runs off it. **Floor, not a measurement.** |

**The ratios you must preserve:**

```
sun disc : aureole (3° out)   ≈ 1.4e9 : 2e4   =  7 × 10⁴   ≈ 16.1 stops
sun disc : mid-sky            ≈ 1.4e9 : 4e3   = 3.5 × 10⁵  ≈ 18.4 stops
sun disc : zenith             ≈ 1.4e9 : 1.8e3 = 7.8 × 10⁵  ≈ 19.6 stops
horizon sky : zenith sky      ≈ 1.1e4 : 1.8e3 =  6.1       ≈  2.6 stops
```

**What this means for bloom, concretely.** The disc covers 163 px at 1080p/40° FOV (§2.1). Take mid-sky = 1.0 in your working units, so the disc is 3.5 × 10⁵. Total disc "energy" in the frame = 163 × 3.5 × 10⁵ = **5.7 × 10⁷ sky-pixel-units.** If your bloom kernel scatters just **1%** of that over a 200-px-radius halo (1.26 × 10⁵ px), the added level is

```
0.01 × 5.7e7 / 1.26e5 = 4.5 × the sky level
```

**A 1% bloom leak makes a 200-px halo 4.5× brighter than the sky it sits on.** That is not a bug — that is what a photograph of the sun looks like, and it is why real sun photos have a large white blob rather than a crisp orange disc with a thin ring. If your bloom looks weak, the failure is almost always that the disc radiance was clamped somewhere upstream, not that the bloom radius is too small.

**The half-float trap.** `PMREMGenerator._allocateTargets()` uses `HalfFloatType` (verified in `node_modules/three/src/extras/PMREMGenerator.js` line 297) and your own `RenderPipeline.js` uses `THREE.HalfFloatType` for the HDR chain. **Half-float maxes at 65504.** If mid-sky = 1.0, the sun disc at 3.5 × 10⁵ **overflows to `Inf`**. `Inf` then propagates through every mip of the PMREM blur and every tap of the bloom downsample, and one `Inf × 0` produces `NaN`, and a single NaN texel in a Gaussian chain turns the whole mip level black or white. Symptoms: the entire environment probe goes white or black the moment the sun enters the probe's view; or the bloom develops a hard black square the size of one mip tile.

Three fixes, in order of preference:
1. **Normalise so that 1.0 = a much larger radiance.** E.g. 1.0 ≡ 10⁴ cd/m². Then sky = 0.18–1.1, disc = 1.4 × 10⁵ — still over 65504. Pick 1.0 ≡ 10⁵ cd/m²: sky = 0.018–0.11, disc = 1.4 × 10⁴. Fits. But now the sky sits at 0.02–0.11, which loses half-float mantissa precision in the ocean's reflection chain. This is a real tension; measure before choosing.
2. **Clamp the disc for the probe/bloom path only.** Render the probe cube with the disc radiance clamped to, say, 2000× sky, and separately hand the *unclamped* sun to the `DirectionalLight` and to an analytic bloom/flare sprite. This is what you want anyway — see §4.2 (an unclamped delta function in an SH probe is a disaster regardless of precision).
3. Use `FloatType` for the probe only. 128 × 128 × 6 × RGBA32F = 393 KB. Cheap. But three's PMREM will still allocate half-float internally, so this only helps if you write your own convolution.

### 2.4 Where the sun's *colour* comes from

**Do not author the sun colour.** It must come from the same transmittance function the sky uses, or the two will drift apart at every sun elevation but the one you tuned:

```
L_sun(λ) = L_sun_TOA(λ) · T(camera_altitude, μ_sun) · limbDarkening(d, λ)
E_sun(λ) = E_TOA(λ)     · T(camera_altitude, μ_sun)          [irradiance for the directional light]
```

where `T` is exactly the transmittance LUT you already have in `sky.js` (`ATM_bR`, `ATM_bMe`, `ATM_bO`, `ATM_Hr = 8 km`, `ATM_Hm = 1.2 km`). At 40° elevation with those coefficients, the RGB transmittance ratio will be roughly (0.90, 0.86, 0.78) of the neutral value — a **mild** warm shift. A sun that is visibly orange at 40° elevation is wrong; that is a sunset colour. See §6.

Extraterrestrial solar spectrum: for a 3-channel renderer, use the RGB-integrated solar irradiance at 1 AU, **1361 W/m²** total (Kopp & Lean's TSI; Bruneton and Hillaire both parameterise on the full spectrum). Split by the sRGB primaries' share of the 380–780 nm band if you need per-channel numbers; the simplest defensible choice is a flat `vec3(1.0)` TOA spectrum in linear sRGB, letting the transmittance do all the colouring, because a *flat* extraterrestrial spectrum in sRGB primaries is within ~5% of the real thing over 450–650 nm.

### 2.5 Rendering the disc without aliasing it

At 14 px diameter with 1 sample per pixel and a hard `step()`, the disc edge crawls badly under camera motion and looks octagonal on a still. Your current code already does the right thing:

```glsl
float ang  = acos(clamp(cosT, -1.0, 1.0));
float aaS  = max(fwidth(ang), 1e-5);
float mask = 1.0 - smoothstep(uSunAngularRadius - aaS, uSunAngularRadius + aaS, ang);
```

`fwidth(ang)` is the per-pixel angular footprint, so the smoothstep width tracks the FOV and resolution automatically. Two refinements worth making:

1. **`acos` is ill-conditioned near cosT = 1** — the derivative is infinite. For a disc this small, `cosT` is within 3 × 10⁻⁵ of 1 across the whole disc, and `fp32 acos` near 1 loses about half its significant digits. Use the chord instead:
   ```glsl
   // ang ≈ length(dir - sunDir) for small angles, exact to O(ang³/24)
   float ang = length(dir - sunDir);          // = 2·sin(ang/2); relative error ang²/24
   ```
   At the disc edge (ang = 0.0046542 rad) the relative error is `ang²/24 = 9 × 10⁻⁷` — i.e. 1/100 000 of a pixel on a 14-px disc. Strictly better conditioned than `acos` near cosθ = 1, and cheaper.

2. **Supersample the disc region only.** If a 1-spp disc still crawls, take a 2 × 2 rotated-grid of `d` values inside the mask's transition band. The cost is bounded to ~50 pixels per frame.

3. **Do not put a `pow()` corona on top of a blown-out disc and call it bloom.** Your `uSunCorona` term (`exp(-rr*0.85)`) is a reasonable *inner*-corona cheat to stop AgX flattening the core to a white sticker, but it is a look hack, not physics, and it will double-count against the bloom pass. Pick one owner of the glow. My recommendation for a photographic still: let the disc be physically bright, let the bloom own everything beyond 1 solar radius, and drop the analytic corona entirely.

---

## 3. The horizon

This is where analytic sky models fail, where your sea meets your sky, and where 8-bit banding is worst, all at once. It is also the part of the frame a viewer's eye goes to first in a marine still.

### 3.1 Why analytic models go wrong there — the actual mechanism

**Perez/Preetham: `e^(B/cos θ)`.** B is negative (`B_Y = −0.3554T + 0.4275`, so B_Y = −0.46 at T = 2.5). As θ → 90°⁻, cos θ → 0⁺, `B/cos θ → −∞`, `e^(...) → 0`, and the horizon-brightening factor `(1 + A·e^(B/cosθ))` collapses to exactly 1. **Two bad consequences:**
- At **θ = 90° exactly**, `B/0` is a division by zero. In GLSL that is `-inf` (fine) or `NaN` if cos θ is exactly ±0 with the wrong sign. On some drivers you will get a one-pixel line of NaN along the true horizon.
- For **θ > 90°** (below the horizon, which you *will* sample when the camera is above sea level and looking down at the water, and when the sky dome geometry extends below the horizon) `cos θ < 0`, so `B/cos θ → +∞` and `F → +∞`. Hosek's own words: *"the values diverged towards infinity"* and there is an *"extremely bright rim around horizon."*

**Hosek-Wilkie's fix**, which you should copy into anything Perez-shaped:

```glsl
float denom = cosTheta + 0.01;     // singularity moves to θ = 90.573°, i.e. 0.573° BELOW horizon
```

That is a one-character change with a huge visual payoff. Verified arithmetic: `cos θ = −0.01 ⟹ θ = 90.5730°`.

**Both models' deeper limitation:** they are fitted for *an observer standing on the ground*, with an implicit flat, opaque ground plane below θ = 90°. There is no representation of (a) the camera being 2–100 m up, (b) the ground being a specular ocean that reflects the sky back, or (c) aerial perspective being continuous with the sky. Bruneton flags exactly this for Preetham: *"It supports aerial perspective, but with a separate model from the sky model, which could give visual inconsistencies between the two (near the horizon)."* Hosek-Wilkie does not model aerial perspective **at all**.

**Your Hillaire implementation does not have any of these problems** — the transmittance LUT and the sky-view LUT are continuous through and below the horizon, and the aerial-perspective froxel volume is the same integral. This is the strongest single argument for keeping it.

### 3.2 The geometry nobody computes, and then gets wrong

For eye height `h` above a sphere of radius `R = 6371 km`:

```
horizon dip angle  δ = acos( R / (R + h) ) ≈ sqrt( 2h/R )
distance to horizon d ≈ sqrt( 2 R h )
```

| Eye height h | Dip δ | Dip in px @ 40° vFOV, 1080p (0.0370°/px) | Distance to horizon |
|---|---|---|---|
| 1.7 m (standing) | 0.0418° | **1.1 px** | 4.65 km |
| 2 m | 0.0454° | 1.2 px | 5.05 km |
| 10 m | 0.1015° | 2.7 px | 11.3 km |
| 50 m | 0.227° | 6.1 px | 25.2 km |
| 100 m | 0.321° | 8.7 px | 35.7 km |
| 500 m | 0.718° | 19.4 px | 79.8 km |

**Read those numbers carefully — they decide three things:**

1. **At a normal standing eye height the dip is ~1 px.** So if you are drawing a flat infinite ocean plane and a sky dome, the "correct" horizon and the "flat earth" horizon are within one pixel of each other. **Do not chase curvature at ground level.** But at 100 m (a cliff, a Pelican) it is 9 px, which *is* visible and *does* read as scale. Make the horizon line derive from the actual planet radius so it is right at both.
2. **The horizon is 5 km away at eye level.** Your ocean mesh must reach at least that far or you will see its edge. If it reaches 5 km and the horizon is at 5.05 km, you get a **sliver of sky-dome below the horizon line** — see §3.3.
3. **The sun disc is 14.4 px and the horizon dip is 1.1 px.** So a "the horizon is 1 px off" bug is 1/13 of a sun diameter. Nobody will see it. A "the horizon is 8 px off" bug at altitude is over half a sun diameter, and readers of a photographic still absolutely will.

### 3.3 The sky/sea meeting line — how to make it not seam

There are four distinct failure mechanisms that all present as "a line at the horizon". Diagnose which one you have before fixing:

**(a) Geometric gap — a band of a different colour, 1–20 px tall, exactly at the waterline, present on a still.**
The ocean mesh ends before the true horizon distance. Fix: make the last ring of the ocean mesh extend to ≥ 3× the horizon distance (15 km for eye level, 110 km for 100 m altitude) — the extra geometry is one ring of ~64 triangles. Or, better, **ray-intersect the ocean plane analytically in the sky shader**: for any view direction with `dir.y < -sin(δ)`, you are looking at water, so the "sky" fragment should return the water's colour instead of the sky's. That makes the meeting line exact by construction with no geometry at all.

**(b) Normal collapse — the far water goes flat, uniformly bright, and does not match the sky.**
Known problem: as the water surface recedes, its shading normal tends toward `+Y` (straight up) because the wave normals average out under mipmapping, whereas a real ocean at grazing incidence shows you the *sides* of waves, whose normals point toward the viewer. The result is that distant water reflects the *zenith* sky (dark blue) when it should reflect the *near-horizon* sky (bright pale). Fix: bend the sampled normal toward the viewer as a function of distance, or use a distance-dependent roughness that widens the reflection lobe so it integrates the whole near-horizon sky band. **Flagged: I could not find a citable primary source with a specific formula for this; the mechanism is well known but my search returned only forum posts.** Implement it as an art-directed `mix(N, normalize(N + viewDirHoriz * k), saturate(dist/D0))` and tune against a photograph.

**(c) Aerial-perspective discontinuity — the water is *bluer or greyer* than the sky it meets, with a soft but definite step.**
This happens when the water is fogged by one model (an exponential-height fog, or your `volumetricFog` pass) and the sky by another (the sky-view LUT). At the horizon the water's optical depth must converge *exactly* to the sky's optical depth in that direction, because at the horizon they are the same ray. **The only robust fix is to use one integral for both**: apply the same aerial-perspective froxel volume (Hillaire §5.4, default 32 × 32 × 32 over 32 km) to the ocean surface that you use for everything else, and let the sky-view LUT be the `d → ∞` limit of that same integral. If you cannot, at minimum force
```
skyRadiance(dir_horizon) == waterRadiance(dist → horizonDistance)
```
by construction, with a hard `mix` to the sky colour over the last 5% of the distance.

**(d) Banding at the horizon specifically, worse than elsewhere in the sky.**
Two causes stack there: (i) the sky's *vertical* luminance gradient is steepest at the horizon (§2.3: horizon is 6× zenith, and most of that change happens in the last 10°), and (ii) if you are sampling a lat/long sky-view LUT with linear v, you have the *fewest* texels exactly where the gradient is highest. Hillaire's fix, verbatim (eq. in §5.3 of the paper):

```
v = 0.5 + 0.5 · sign(l) · sqrt( |l| / (π/2) ) ,  with l ∈ [−π/2, π/2]
```

> *"higher-frequency visual features are visible toward the horizon. In order to help better represent those, we apply a non-linear transformation to the latitude l when computing the texture coordinate v ∈ [0,1] that will compress more texels near the horizon."*

Note the **`sign(l)`** — the mapping is symmetric about the horizon, so it also gives you texel density just *below* the horizon, which is what the ocean's reflections sample. Inverse, for the LUT build pass:

```
l = sign(2v − 1) · (π/2) · (2v − 1)²
```

With a 256-tall LUT spanning l ∈ [−90°, +90°], linear v gives a flat **1.42 texels per degree**. The sqrt mapping puts `v − 0.5 = 0.5·sqrt(1°/90°) = 0.0527` at 1° of elevation, i.e. **13.5 texels inside the first degree above the horizon** — a **9.5× improvement** exactly where the gradient is steepest — at the cost of dropping to 0.71 texels/deg near the zenith, where nothing is happening. Your `sky.js` header says the sky-view LUT is 256 × 256; check whether the v mapping is linear, because if it is, that alone can be your horizon banding.

### 3.4 One more horizon subtlety: ozone

Preetham has no ozone term at all. Hosek-Wilkie has it implicitly (fitted from a path tracer that included it). Your `sky.js` has `ATM_bO = vec3(0.650e-3, 1.881e-3, 0.085e-3) /km`. Hillaire's paper notes ozone is what keeps *sky-blue colours when the sun is at the horizon* — without it the whole horizon band goes yellow-grey. The green channel absorption being 2.9× the red and 22× the blue is what carves the blue back out of the long-path horizon. If you ever see a **grey-yellow horizon band** with a blue zenith, check that ozone is actually being applied along the *view* ray and not only the sun ray.

---

## 4. Getting the sky into the lighting rig

The rule: **one radiance function, three consumers.** The sky dome pixel, the directional sun, and the ambient/IBL must all be derived from the same `L(dir)` and the same `T(μ_sun)`. Any one of them authored independently will drift.

### 4.1 The directional sun

```js
// irradiance on a plane perpendicular to the sun, at the camera's altitude
E_sun = E_TOA * transmittance(camera_r, mu_sun);        // vec3, W/m² (or your unit)
directionalLight.color.setRGB(E_sun.r, E_sun.g, E_sun.b).normalize?  // NO — see below
directionalLight.intensity = luminance(E_sun);
```

**three.js gotcha:** `DirectionalLight` multiplies `color × intensity` and, when `renderer.useLegacyLights === false` (the default since r155), treats `intensity` as **lux** for the physically-correct path only for point/spot lights; for directional lights `intensity` is a unitless multiplier on `color`. The clean approach is to leave `intensity = 1` and put the full `vec3` into `color` via `setRGB(r, g, b, THREE.LinearSRGBColorSpace)`. **`Color.setRGB` with no colour-space argument assumes the working colour space (linear-sRGB) in r0.185.1, which is what you want — but `setHex` assumes sRGB.** Your codebase uses `setHex(..., THREE.SRGBColorSpace)` for authored colours, which is correct for those; do not use `setHex` for computed radiometric values.

**Energy sanity check for a 40° tropical sun**, which you should be able to reproduce in the running app:

| Quantity | Expected |
|---|---|
| Direct normal illuminance | 90–105 klx |
| Direct **horizontal** illuminance = DNI·sin40° | 58–68 klx |
| Diffuse horizontal illuminance (clear sky) | 10–16 klx |
| Global horizontal illuminance | 70–85 klx |
| **Sun : sky irradiance ratio on a horizontal surface** | **≈ 4–6 : 1** |

That last row is the one to check. If your ambient is more than ~1/4 of your sun, shadows will be milky and the image will not read as tropical noon. If it is less than ~1/8, shadow interiors go black and the image reads as CG.

Second, independent check using only the sky model: for a uniform sky of radiance L the horizontal irradiance is `E = π·L`. With mid-sky ≈ 3500 cd/m² and a clear-sky shape factor of ~1.1 (horizon brighter than zenith), `E ≈ π × 3500 × 1.1 ≈ 12 klx`. Sits inside the 10–16 klx row. ✓

### 4.2 Ambient / IBL from the sky — the pipeline

You already build a 128 px cube of the dome from a private scene. That is the right structure. What matters is what goes *into* it:

```
                                                 ┌─► DirectionalLight  (sun disc, unclamped)
sky radiance L(dir) ──┬─► sky dome pixel ────────┤
                      │                          └─► bloom / flare (sun disc, unclamped)
                      └─► env probe cube 128px ──┬─► PMREM  → specular IBL (roughness mips)
                         (sun disc CLAMPED or    └─► SH9    → diffuse irradiance
                          EXCLUDED)
```

**Why the sun must be clamped or excluded from the probe:**

1. **Half-float overflow.** §2.3. `Inf` → `NaN` → black or white mips.
2. **SH ringing (Gibbs).** The sun is a delta function of solid angle 6.8 × 10⁻⁵ sr carrying ~80% of the total irradiance. Projecting a delta onto 9 SH basis functions and reconstructing gives large negative lobes on the opposite side of the sphere. Visually: **surfaces facing *away* from the sun get negative ambient and go pure black, or the whole probe develops a dark band 90° from the sun.** The sun's contribution must be the `DirectionalLight`, full stop.
3. **PMREM specular double-count.** If the sun is in the PMREM *and* is a `DirectionalLight`, every rough metal in the scene gets two suns.

**How much to clamp to.** A clean rule: clamp the probe's sun disc to the level that preserves the correct *total* irradiance if you were to remove the directional light — but since you are keeping the directional light, just **remove the disc entirely** and keep the aureole. The aureole (the Mie forward lobe within ~10° of the sun) carries real energy that the directional light does not represent and *does* belong in the probe. Practically: in the probe render path, set `uSunDiscRadiance = 0` and `uSunCorona = 0`; leave the atmospheric in-scatter untouched.

**Probe resolution.** 128 px per face for the PMREM is generous — three's `PMREMGenerator` reduces to `LOD_MIN = 4` (16 px) for the roughest mip anyway. For a *sky-only* probe (no clouds, no geometry) even 64 px is plenty; the sky is low-frequency by construction once the sun is out. If the clouds pass contributes to the probe, keep 128.

**Update cadence.** The transmittance and multiple-scattering LUTs are sun-independent (build once). The sky-view LUT rebuilds on sun move. The probe + PMREM is the expensive one — for a still, once. For a moving sun, rebuild the probe at most every N frames and cross-fade the two `SphericalHarmonics3` sets, because a probe pop is very visible on flat surfaces.

### 4.3 The SH path — exact constants

**Ramamoorthi & Hanrahan eq. 9, verbatim:**

```
Â₀ = 3.141593    Â₁ = 2.094395    Â₂ = 0.785398
Â₃ = 0    Â₄ = −0.130900    Â₅ = 0    Â₆ = 0.049087
```

i.e. `Â₀ = π`, `Â₁ = 2π/3`, `Â₂ = π/4`. Because Â₃ = 0 and Â₄ is already 2.7% of Â₀, **9 coefficients (l ≤ 2) is genuinely enough for diffuse irradiance** — the paper's own claim is *"average errors of only 1%"* for the reconstructed irradiance.

The first 9 real SH, from the same paper:

```
(x, y, z)              = (sinθ cosφ, sinθ sinφ, cosθ)
Y₀₀                    = 0.282095
(Y₁₁; Y₁₀; Y₁₋₁)       = 0.488603 (x; z; y)
(Y₂₁; Y₂₋₁; Y₂₋₂)      = 1.092548 (xz; yz; xy)
Y₂₀                    = 0.315392 (3z² − 1)
Y₂₂                    = 0.546274 (x² − y²)
```

**three.js already implements the convolved version**, in `ShaderChunk/lights_pars_begin.glsl.js` (verbatim from `node_modules/three` r0.185.1):

```glsl
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;                    // Â₀·Y₀₀ = π·0.282095
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;              // Â₁·Y₁₋₁ path
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
```
Cross-check: `0.886227 = π × 0.282095` ✓. `0.511664 = (2π/3) × 0.488603 / 2` ✓ (the factor-of-2 is folded into the `2.0 *`). `0.429043 = (π/4) × 1.092548 / 2` ✓. `0.743125 = 3 × (π/4) × 0.315392` ✓ and `0.247708 = (π/4) × 0.315392` ✓. **The constants are correct.**

**Getting the coefficients.** `LightProbeGenerator.fromCubeRenderTarget(renderer, cubeRenderTarget)` (async, r0.185.1) reads back the cube and projects it. It handles `FloatType`, `HalfFloatType` (via `DataUtils.fromHalfFloat`) and `UnsignedByteType`. The solid-angle weight it uses is:

```js
const weight = 4 / ( Math.sqrt( lengthSq ) * lengthSq );   // lengthSq of the unit-cube coord
```
which is the standard `dω = 4 / (x²+y²+z²)^{3/2}` cube-face differential solid angle, then normalised by `totalWeight` at the end. This is correct.

**Cost warning:** `fromCubeRenderTarget` does a `readRenderTargetPixelsAsync` per face — 6 GPU→CPU readbacks. On a 128 px cube that is 6 × 128 × 128 × 4 × 2 bytes = 786 KB and a pipeline stall. **Do not do this every frame.** For a moving sun, either (a) do it every ~30 frames and lerp, or (b) compute the 9 coefficients analytically on the CPU from the sky model, which for a Hosek/Preetham-shaped sky is a 100-sample Fibonacci-sphere quadrature and takes <1 ms in JS.

**The SH deringing question.** With the sun disc removed (as recommended), the remaining sky is smooth enough that 9-term SH does not ring meaningfully. If you *must* include a bright localised feature, apply Sloan's windowing — three.js's own `LightProbeGenerator` docstring points at [StupidSH36.pdf](https://www.ppsloan.org/publications/StupidSH36.pdf). **Flagged: I did not open that PDF this session.**

### 4.4 The specular path — PMREM

```js
const pmrem = new THREE.PMREMGenerator( renderer );
pmrem.compileCubemapShader();
const envRT = pmrem.fromCubemap( skyCubeTexture );   // or .fromScene(skyOnlyScene, sigma, near, far)
scene.environment = envRT.texture;
```

`fromScene(scene, sigma = 0, near = 0.1, far = 100, options)` — the `sigma` is *"The blur radius in radians"*, applied before the roughness chain. For a sky probe leave it 0; the sky is already smooth and any pre-blur will soften the horizon line in reflections, which is exactly the detail the ocean needs.

**Keep `scene.environment` and the SH probe from drifting.** If you use `scene.environment` for specular and a `LightProbe` for diffuse, they must come from the same cube. If you use `scene.environment` alone, three's `envMapIntensity` applies to both diffuse and specular IBL and defaults to 1 — so any global "ambient looks too strong" fix via `envMapIntensity` also darkens every reflection. Prefer fixing the sky's absolute level.

---

## 5. Sky gradient banding and the correct dither

This is the single highest-value / lowest-effort item in this document for "must hold up as a photographic still."

### 5.1 Why an 8-bit sky *always* bands — the arithmetic

The sRGB EOTF for V > 0.04045 is `L = ((V + 0.055)/1.055)^2.4`. The relative luminance change per 8-bit code step is

```
(1/L)(dL/dV)(1/255) = 2.4 / (V + 0.055) / 255
```

| Code value | V | Relative luminance step per code |
|---|---|---|
| 128 | 0.502 | **1.69 %** |
| 160 | 0.627 | 1.38 % |
| 180 | 0.706 | **1.24 %** |
| 220 | 0.863 | 1.03 % |

Weber's law puts the human threshold for a *soft-edged* luminance difference at roughly 1% at photopic levels, and a **hard-edged step is detectable well below that** because of lateral inhibition (Mach banding). So **every 8-bit code boundary in a smooth midtone gradient sits at or above the detection threshold.** This is not a "sometimes" problem; an undithered smooth 8-bit gradient bands, always. The only question is whether the bands are wide enough to notice.

**How wide are they in your frame?** Take the sky going from ~11 000 cd/m² at the horizon to ~1 800 cd/m² at the zenith (§2.3) — after a filmic curve that lands at, say, sRGB code 205 → 150, so **55 code steps spread over the ~35° of sky in frame**. At 40° vFOV / 1080p that is 945 px, so **one band boundary every 17 px**. Seventeen-pixel bands in the sky are *screamingly* visible on a still, and they are the number-one giveaway of a real-time renderer.

*My rule of thumb, not sourced:* bands become invisible without dither only when the gradient is steeper than ~1 code per 3–4 px. Your sky is 5× shallower than that. Dither is mandatory.

### 5.2 Triangular-PDF dither — the correct construction

From the Playdead INSIDE deck ([loopit.dk/banding_in_games.pdf](https://loopit.dk/banding_in_games.pdf)), verbatim slides and their own hindsight annotations:

> **Empiric conclusion: Use a triangular distribution in the interval [-0.5;1.5[**
> *HINDSIGHT: The reason a triangular distribution is "enough", is that it does not exhibit "noise modulation". Neither do gaussians, but this is the main benefit.*
> **HINDSIGHT: GPUs round, so dither-range should be [-1;1[**  — i.e. `hash(s1) + hash(s2) - 1.0`

And the reasoning for *why* uniform noise is not enough:

> *"...noise is uniformly distributed, but the resulting visual noise is NOT uniformly distributed - almost no noise near 'correct' values. Really no reason to add noise where signal -is- it's truncated value."*
> *"[Triangular] effectively adds noise in low-noise-areas, giving a more uniform noise-appearance."*

Their walkthrough of the distributions:
> - A uniform distribution in the interval [0;1[ creates areas of little to no noise, giving the impression of a smooth signal, but non-uniform noise.
> - expanding the noise to [-0.5;1.5[ creates areas of too much noise (in the "overlapping" regions)
> - Switching to a triangular distribution [-0.5;1.5[ gives a nice uniform distribution (the "overlapping" noise-regions accumulate to 1)
> - Using a gaussian distribution again creates areas with too little noise
> - using a gaussian-pdf in range [-1.0;2.0[ appears very similar to triangular, but with more noticeable noise
>
> *"Awesome, if triangular is good, gaussian must be even betterer!" (spoiler: don't do it)*

**The magnitude, stated unambiguously: 2 LSB peak-to-peak, triangular, symmetric about zero.** For 8-bit output that is `± 1/255`, generated as the sum of two independent uniforms minus one. The theoretical justification (Lipshitz, Wannamaker & Vanderkooy 1992, cited in the deck; **not read by me**) is that 2-LSB TPDF is the minimum that makes both the **mean** and the **variance** of the quantisation error independent of the signal — which is exactly the "noise modulation" the deck describes empirically.

**Price you pay:** quantisation noise alone has σ = 1/√12 = 0.289 LSB. TPDF over [−1,1) has variance 2 × (1/12) = 1/6, σ = 0.408 LSB. Total σ after dithering = √(1/12 + 1/6) = 0.5 LSB. **You go from 0.289 to 0.5 LSB of noise — a 4.8 dB penalty — in exchange for removing all *correlated* error.** That trade is always worth taking on a gradient and never worth arguing about.

### 5.3 The GLSL

```glsl
// ---- hash: two independent uniform [0,1) values from the fragment coordinate ----
// Any decent 2D hash works. This one is cheap and adequate; swap for a blue-noise
// texture lookup if you have the bandwidth (see §5.6).
vec2 hash22( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.xx + p3.yz ) * p3.zy );
}

// ---- triangular PDF in [-1, 1), mean 0 ----
float tpdf( vec2 seed ) {
    vec2 r = hash22( seed );
    return r.x + r.y - 1.0;
}

// ---- apply, in the SAME SPACE the value will be quantised in ----
// quantSteps = 255.0 for 8-bit, 1023.0 for 10-bit
vec3 ditherTPDF( vec3 displayReferred, vec2 fragCoord, float quantSteps ) {
    // one independent sample per channel — Gjøl: "you should of course dither
    // r,g,b separately for improved luminance resolution"
    vec3 n = vec3( tpdf( fragCoord ),
                   tpdf( fragCoord + 17.0 ),
                   tpdf( fragCoord + 43.0 ) );
    return displayReferred + n / quantSteps;
}
```

**The boundary fix.** Also from the deck, verbatim — this is the last slide of the dithering section and it is easy to miss:

> *It turns out, that due to clamping, the boundaries around black/white (0/1) become wrong when using 2LSB triangular dithering… As the noise gets clamped, clamping destroys the symmetry in the noise - and for that reason the average does not tend towards the actual signal. A solution is to lerp to a 1LSB uniform-PDF noise at boundaries.*

```glsl
vec2  rnd       = hash22( seed );
float dithertri = ( rnd.x + rnd.y - 1.0 );      // symmetric, triangular, [-1;1[
float dithernorm= rnd.x - 0.5;                  // symmetric, uniform,   [-0.5;0.5[
float sizt_lo   = clamp( v / ( 0.5 / 7.0 ), 0.0, 1.0 );
float sizt_hi   = 1.0 - clamp( ( v - 6.5 / 7.0 ) / ( 1.0 - 6.5 / 7.0 ), 0.0, 1.0 );
float dither    = mix( dithernorm, dithertri, min( sizt_lo, sizt_hi ) );
```
(`v` is the display-referred value in [0,1]. Their `0.5/7` and `6.5/7` breakpoints come from a 3-bit test case; for 8-bit scale them: fade in over `v ∈ [0, 2/255]` and out over `v ∈ [253/255, 1]`.) Source for the fix: [computergraphics.stackexchange 5904](https://computergraphics.stackexchange.com/questions/5904/whats-a-proper-way-to-clamp-dither-noise/5952#5952), as cited in the deck.

For a bright daytime sky this boundary case only matters if you have crushed blacks somewhere in frame. Include it; it is four lines.

### 5.4 Where in the pipeline it must sit — this is the part that goes wrong

**Two rules, both from the deck, both absolute:**

**Rule 1 — dither in whatever space the value will be quantised in.** Four cases, verbatim from the slides:

```glsl
// (a) linear 8-bit target
return ditherRGBA( outcol, fragpos );

// (b) manual sRGB encode, then 8-bit target
return ditherRGBA( lin2srgb( outcol ), fragpos );          // convert first, dither after

// (c) manual logarithmic buffer (e.g. Unity's light buffer)
return ditherRGBA( exp2( -outcol ), fragpos );

// (d) hardware-sRGB render target (GL_FRAMEBUFFER_SRGB / SRGB8_ALPHA8)
return srgb2lin( ditherRGBA( lin2srgb( outcol ), fragpos ) );
```
with the cheap approximations they use for (d):
```glsl
vec4 srgb2lin(vec4 c) { return vec4( c.rgb * c.rgb, c.a ); }
vec4 lin2srgb(vec4 c) { return vec4( sqrt( c.rgb ), c.a ); }
```
> *"(sqrt(c)+n)^2 == c + 2*n*sqrt(c) + n^2 …but pow( sqrt( c ) + rnd/255.0, 2.0 ); is probably faster"*

**This matters for your project.** `src/core/Engine.js` sets `renderer.outputColorSpace = THREE.SRGBColorSpace`, and `WebGLTextures.js` line 234 shows three uses `_gl.SRGB8_ALPHA8` for `UNSIGNED_BYTE` targets whose colour space has an sRGB transfer. So:
- If your final pass writes to the **canvas** and your material includes `<colorspace_fragment>`, the sRGB OETF is applied *in the shader*. Dither goes **after** that include. That is case (b).
- If your final pass writes to an intermediate `UnsignedByteType` render target with `colorSpace = SRGBColorSpace`, the hardware does the encode. Dither must be case (d) — encode, dither, decode, and let the hardware re-encode.
- If you dither in **linear** and let the sRGB encode happen after, the dither amplitude is stretched by the OETF derivative: at V = 0.5 the sRGB curve's slope means a linear-space ±1/255 becomes ±3.9/255 in code values in the shadows and ±0.6/255 in the highlights. **Symptom: the sky (bright) still bands while the shadows are visibly grainy.** That is the diagnostic signature of dithering in the wrong space.

**Rule 2 — dither *before* the quantisation you are trying to fix, and only that one.** Verbatim slide:

> **Dithering after quantisation does not remove banding** (e.g. LDR film-grain at end of frame)
> right: `trunc(f+rnd)`   wrong: `trunc(f)+rnd`
> *"lets just add grain at end of frame to make banding go away" …only works if input signal is kept at high precision, so e.g. HDR-rendering and adding grain at time of tonemapping is fine… Otherwise you are just adding noise on top of an already banding image.*

**Consequences for your pass chain** (`tonemap → grade → grain → sharpen → …`):
- Your HDR chain is `THREE.HalfFloatType` throughout (`RenderPipeline.js` lines 43, 110, 145), so there is only **one** 8-bit quantisation, at the final canvas write. Good. The dither must live in **whichever pass writes to the canvas**, after that pass's sRGB encode, and nowhere else.
- **`grain` is not a substitute for dither.** Film grain is a *look* — correlated, coloured, scaled with luminance, and usually applied at a magnitude of several LSBs. Dither is a *fix* — 2 LSB TPDF, white or blue, uncorrelated. Ship both; they do different jobs. But if grain runs before the final sRGB encode and dither runs after, you're fine; if grain is your only noise and it runs on an already-8-bit buffer, you get `trunc(f)+rnd` and the bands survive under the grain.
- **TAA will eat your dither.** If `taa` runs after the dither, temporal accumulation averages the noise away and the bands come back. Dither must be **after TAA**, in the final output pass. This is the single most common way dither silently stops working in a modern pipeline.

**three.js's built-in `#include <dithering_fragment>` is not enough.** Verbatim from `node_modules/three/src/renderers/shaders/ShaderChunk/dithering_pars_fragment.glsl.js`:

```glsl
vec3 dithering( vec3 color ) {
    float grid_position = rand( gl_FragCoord.xy );
    vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
    dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
    return color + dither_shift_RGB;
}
```
That is **uniform (rectangular) PDF, 1 LSB peak-to-peak** (`±0.5/255`), with the *same* `grid_position` driving all three channels (so the noise is correlated across RGB — it modulates chroma, not just luminance). By the deck's own analysis that leaves "areas of little to no noise… the impression of a smooth signal, but non-uniform noise" — i.e. residual banding with a noisy fringe on each band edge. Chunk ordering is correct though (`meshphysical.glsl.js` lines 217–221: `tonemapping_fragment → colorspace_fragment → fog_fragment → dithering_fragment`), so `material.dithering = true` at least dithers in the right space. **Use it as a floor; write the TPDF version for the final pass.**

### 5.5 Noise source: white vs IGN vs blue

| Source | Cost | Look | When |
|---|---|---|---|
| White (hash) | ~6 ALU | Correct but the *most visible* noise for a given amplitude | Always works. Default. |
| **Interleaved Gradient Noise** | **3 ALU** | Less visible than white at the same amplitude; slightly structured (diagonal) | Best cost/quality for a static still. |
| Blue noise tile (64³ or 128² × N) | 1 texture fetch | Least visible; energy pushed to high spatial frequency the eye rolls off | Best absolute quality; costs a texture and a bind. |

**IGN, verbatim** (Jimenez, SIGGRAPH 2014; constants confirmed against [demofox](https://blog.demofox.org/2022/01/01/interleaved-gradient-noise-a-different-kind-of-low-discrepancy-sequence/) and [blog.frost.kiwi](https://blog.frost.kiwi/GLSL-noise-and-radial-gradient/)):

```glsl
float gradientNoise( in vec2 uv ) {
    return fract( 52.9829189 * fract( dot( uv, vec2( 0.06711056, 0.00583715 ) ) ) );
}
```
`uv` is `gl_FragCoord.xy` (integer pixel coordinates — **not** normalised UVs; the constants were tuned for pixel units).

**Caution on combining IGN with TPDF.** A triangular PDF needs two *independent* uniform samples. IGN is deliberately **low-discrepancy** — that is, correlated by design — so `gradientNoise(fc) + gradientNoise(fc + offset) - 1.0` is **not** guaranteed to give a triangular distribution, and I did not verify what it actually gives. Two safe options:
- Use white noise for both samples (`hash22`, §5.3). This is the construction the INSIDE deck actually ships.
- Use IGN as a **single uniform sample** and remap it to a triangular PDF analytically. The deck's own hindsight note points at [Shadertoy 4t2SDh](https://www.shadertoy.com/view/4t2SDh) for that remap. **Flagged: I could not fetch that Shadertoy (the pages are JS-rendered), so I am not reproducing a remap function here rather than risk giving you a wrong one.**

If in doubt, use `hash22`. Six ALU is not the bottleneck in a final output pass.

**Animate it if and only if there is no TAA and no motion blur downstream.** A per-frame changing dither is perceptually much better (the eye temporally integrates it toward the true value) but if anything downstream accumulates, you lose the dither and gain a flicker. For a still frame capture, use a fixed seed so the shot is reproducible.

---

## 6. Failure modes, described so you can spot them in a screenshot

Each entry: **what you see** → **what it is** → **where to look**.

### Sky model / colour

1. **Sky is a flat, even blue with almost no gradient from horizon to zenith.**
   Your zenith:horizon ratio has collapsed. Real clear sky is ~6:1 horizon:zenith in luminance (§2.3), and the horizon is also markedly *less saturated* (paler, whiter) because the long path adds multiply-scattered light. If both ends are the same blue, you have either lost the Mie term or you are normalising the sky by its own average somewhere.

2. **Sky is deep blue right down to the waterline, with no pale band.**
   No aerosol / Mie in-scatter, or the aerosol scale height is far too small. Tropical marine air has τ₅₅₀ ≈ 0.065 and H_m ≈ 1.2 km; the pale band should occupy the bottom ~8–10° of sky. This is the single most common "it looks like a video game" tell for a sea scene.

3. **Zenith is *too* dark and the region around the sun is *not bright enough*, at the same time.**
   That is Hosek's own Figure 1 caption describing the Preetham model at T ≥ 4, verbatim: *"the area around the sun is not bright enough, and the zenith is not dark enough"* (their reference vs Preetham, note the polarity is reversed relative to what you see). If you are on Preetham and raise turbidity to warm the scene, this is what you get. Fix: don't use Preetham above T = 4.

4. **Everything is 1.5–3× too bright and you fixed it with an exposure knob.**
   §1.5: Preetham overestimates measured zenith luminance by ~3× at 40° sun. Once you compensate with exposure, your *sun* is now 3× too dim relative to the sky, so your bloom, your specular highlights on the water, and your shadow contrast are all wrong together. **Diagnostic: check the sun:sky irradiance ratio (§4.1) — it should be 4–6:1 on a horizontal plane. If it's 2:1 you have this bug.**

5. **A bright rim exactly along the horizon line, one to three pixels tall, in the sky.**
   The Perez `e^(B/cosθ)` singularity. Add Hosek's `+ 0.01`. §3.1.

6. **Grey-yellow horizon band under a blue zenith.**
   Ozone absorption missing from the *view* ray integral (it may be present only on the sun ray). §3.4.

7. **The sky's blue is oversaturated to the point of looking like a poster, and the horizon has a magenta tinge.**
   XYZ → linear sRGB producing out-of-gamut negatives, then clamped. Gamut-map instead of clamping. §1.2.

### Sun

8. **The sun is a uniform white circle with a hard edge.**
   Limb darkening missing or too weak, and/or no bloom. A correctly limb-darkened disc has a warm rim (limb is 0.34/0.25/0.18 of centre in R/G/B — §2.2), and even that is usually invisible under bloom, which is the point: *if you can see a hard disc edge at all, your bloom is far too weak.* §2.3.

9. **The sun looks like a moon: crisp, round, no glow.**
   Sun radiance clamped upstream. Check for a `min()`, a `clamp()`, or a half-float `Inf` (§2.3). Trace the disc's value all the way to the bloom threshold.

10. **The sun is visibly orange/amber at 40° elevation.**
    Sun colour authored rather than derived, or the transmittance is being evaluated at the horizon path length. At 40° elevation air mass is only 1.56 and the RGB transmittance ratio is roughly (0.90, 0.86, 0.78) — a *mild* warm shift, not an amber one. §2.4.

11. **The sun disc is about twice the size it should be.**
    You inherited three's `Sky.js` constant. §1.6. Correct angular *radius* is 0.0046542 rad.

12. **The sun disc shimmers/crawls at the edge under camera motion, or looks octagonal on a still.**
    Hard threshold with no `fwidth()` AA, or `acos()` precision loss near cosθ = 1. §2.5.

13. **A dark ring around the sun, just outside the bloom.**
    Classic bloom-threshold artifact: the threshold subtracts a constant, and the aureole sky (which is genuinely 5–10× the mid-sky) falls just under it, so it gets darker than its surroundings after the bloom is added back. Use a soft knee, not a hard threshold.

### Horizon / sea

14. **A thin band of sky visible *below* the waterline.** Ocean mesh does not reach the horizon distance. §3.3(a). At 2 m eye height the horizon is 5.05 km; at 100 m it is 35.7 km.

15. **Distant water is *darker and bluer* than the sky it meets; the transition is a visible step.** Normal collapse — the far ocean is reflecting the zenith instead of the near-horizon sky. §3.3(b).

16. **Distant water is *greyer/hazier* than the sky it meets, with a soft but definite step.** Two different fog/aerial-perspective models. §3.3(c).

17. **Horizontal bands specifically concentrated in the bottom 10° of sky, wider than the bands elsewhere.** Linear-v sky-view LUT under-sampling the horizon. Apply Hillaire's `v = 0.5 + 0.5·sign(l)·sqrt(|l|/(π/2))`. §3.3(d).

18. **The horizon line is perfectly straight and at exactly the camera's level, from a 100 m viewpoint.** Missing planet curvature. At 100 m the dip is 0.32° = 8.7 px at 1080p/40° FOV — visible, and its absence quietly removes the sense of altitude. §3.2.

### Lighting

19. **Shadows are milky; the whole image looks flat and overcast despite a visible sun.** Ambient too strong relative to the sun. Target 4–6:1 sun:sky on a horizontal plane. §4.1.

20. **Surfaces facing away from the sun go pure black, or there is a dark band 90° from the sun across all diffuse geometry.** SH ringing from the sun disc being included in the light probe. §4.2.

21. **The whole environment probe turns white (or black) the instant the sun enters the probe's field of view.** Half-float overflow → `Inf` → `NaN` through the PMREM/SH chain. §2.3.

22. **Rough metal in the scene has two suns, one sharp and one blurry, slightly offset.** Sun in both the `DirectionalLight` and the PMREM. §4.2.

23. **The ambient light "pops" as the sun moves.** Probe rebuilt at a low cadence with no cross-fade between `SphericalHarmonics3` sets. §4.2.

### Banding / dither

24. **Smooth horizontal bands across the sky, roughly evenly spaced, most visible in the mid-tones.** No dither, or dither in the wrong colour space. Count them: if they're ~17 px apart at 1080p, that matches the arithmetic in §5.1 exactly.

25. **The sky still bands but the shadows are visibly grainy.** Dither applied in *linear* space before the sRGB encode. The OETF stretches the noise in the darks and squashes it in the lights. §5.4 Rule 1.

26. **Bands with a noisy fringe on each band edge, and clean flat regions between them.** Uniform-PDF dither ("noise modulation"). Switch to TPDF. §5.2. This is what three's built-in `dithering` gives you.

27. **Grain is clearly visible but the bands are visible *through* it.** `trunc(f) + rnd` — noise added after quantisation. §5.4 Rule 2. Also happens if the grain pass reads an 8-bit intermediate.

28. **Dither works on a paused frame, disappears in motion, bands come back.** TAA running after the dither and averaging it away. Move the dither after TAA. §5.4.

29. **A faint coloured (not neutral) speckle in the sky.** Same random value used for R, G and B — the noise modulates chroma. Use three independent samples. §5.3.

30. **Correct dither everywhere except a hard edge right where the sky reaches pure white near the sun.** TPDF clipping asymmetry at the 0/1 boundary. Apply the lerp-to-uniform fix. §5.3.

---

## 7. A concrete parameter block for this scene

Tropical marine, sun at 40° elevation, camera 2–10 m above sea level, photographic still.

```js
// ---- atmosphere ----
// keep the existing Hillaire coefficients in src/world/sky.js; they are standard:
//   ATM_bR  = (5.802, 13.558, 33.100) e-3 /km      Rayleigh scattering
//   ATM_bMs = 1.900e-3 /km                          Mie scattering
//   ATM_bMe = 2.150e-3 /km                          Mie extinction  (albedo 0.884)
//   ATM_bO  = (0.650, 1.881, 0.085) e-3 /km        ozone absorption
//   ATM_Hr  = 8.0 km,  ATM_Hm = 1.2 km
// Bruneton's measurement-fitted marine aerosol, for cross-checking those:
//   Angstrom alpha = 0.816, beta = 0.0384  =>  tau(550nm) = 0.0655
//   Cornette-Shanks g = 0.704               (your Mie phase asymmetry)
// Equivalent Linke turbidity for a Preetham/Hosek path: T = 3.0-3.5

// ---- sun ----
sunAngularRadius      : 0.0046542,     // rad  = 0.2667 deg  (diameter 0.5334 deg)
sunSolidAngle         : 6.805e-5,      // sr
limbU                 : [0.664, 0.747, 0.821],   // 1 - c0 from Hosek limb-darkening table
limbAlpha             : [0.695, 0.735, 0.796],   // fitted to match the disc average
// disc-average luminance at ground, 40 deg elev, clear marine:
sunDiscLuminance      : 1.4e9,         // cd/m^2   (centre ~1.8e9)
// implied direct normal illuminance:
sunDNI                : 9.5e4,         // lx

// ---- expected sky levels, for validation ----
zenithLuminance       : 1.8e3,         // cd/m^2
midSkyLuminance       : 4.0e3,         // cd/m^2  (90 deg from sun)
horizonLuminance      : 1.1e4,         // cd/m^2
aureoleLuminance      : 2.0e4,         // cd/m^2  (>= this, 3 deg from sun)
diffuseHorizIlluminance: 1.2e4,        // lx
sunSkyRatioHoriz      : 5.0,           // direct-horizontal : diffuse-horizontal

// ---- probe ----
probeCubeSize         : 128,
probeSunDiscRadiance  : 0.0,           // sun disc EXCLUDED from the probe
probeSunCorona        : 0.0,           // ditto
probeUpdateInterval   : 30,            // frames, cross-faded

// ---- sky-view LUT ----
skyViewSize           : [256, 256],
skyViewVMapping       : 'sqrt-signed',  // v = 0.5 + 0.5*sign(l)*sqrt(|l|/(pi/2))

// ---- output ----
ditherPDF             : 'triangular',
ditherAmplitudeLSB    : 1.0,           // i.e. +-1/255, 2 LSB peak to peak
ditherSpace           : 'display-encoded',  // AFTER the sRGB OETF
ditherPosition        : 'final pass, after TAA, after tonemap, after grade',
ditherPerChannel      : true,          // 3 independent samples
```

**Three validation shots to take before calling it done:**
1. **Zenith-to-horizon vertical scan**, sky only, no clouds, sun behind the camera. Plot linear luminance vs elevation. It should be monotonic, ~6:1 horizon:zenith, and the last 8° should curve up steeply. A straight line means no Mie.
2. **A 200-px-wide crop of empty mid-sky**, exported as PNG, levels-stretched by 8× in an image editor. If you see bands, dither is not working. If you see uniform speckle, it is.
3. **Sun in frame at 40° elevation**, then measure the ratio of the brightest pixel to a pixel 30° away in the sky, *in the linear HDR buffer before tonemapping*. Should be ~10⁵. If it's ~10² your sun is clamped; if it's `Inf`, §2.3.
