# sky — Wave G refine (response to the 34/100 REJECT)

Owner file: `src/world/sky.js` only. New tool: `tools/_skyprobe.mjs` (reads `sky.radiance()`
in LINEAR HDR and toggles the shared uniforms to attribute a colour to a scattering term).

**Read §0 first — two of the critic's measurements were taken against the wrong pixels, and
one of them, applied as written, would have been a regression.**

---

## 0. Two review measurements do not reproduce

`docs/TARGETS.md` warns that ROI regions are *screen rectangles, not semantic masks*, and
`KNOWN_ISSUES §7` records the previous sky agent making that exact mistake. It happened
again in the review, twice. Both are checkable in a minute and both change the fix.

**(a) `sky_sun` at ref_00720 is not sky.** In `kf_00720` the `sky_sun` crop (x 1056-1882,
y 21-324) is filled almost edge to edge by **Threshold**, the mauve gas giant — open
`shots/skyfix/_c2.png`. Its `sat_mean 85.78` is the planet's chroma, not an atmosphere
target. The underlying complaint was still right (`uCircumsolar` really was bleaching the
near-sun sky and really was applied outside the sky's own colour) and it is fixed —
`sky_sun` sat went **28.6 → 72.3** — but 85.8 is not a number the atmosphere can own.

**(b) The ring band is 52 px, not 200, and `widthRatio 0.104` would have overshot.** The
critic's "reference band" is a vertical cut at `kf_01500` x 20-30, which is Threshold's
limb again. The ring is unobstructed in **kf_00600**. Measured there, horizontal cuts at
y = 150/200/250 put it at x 847-898 / 841-892 / 832-888 — **52 ± 2 px**. Our band at
`widthRatio 0.040` measured **24 px** at the same elevations, so the correct value is
`0.040 × 52/24 = 0.087` (435 km on a 5000 km radius, within 17% of `docs/WORLD.md`'s 520
km). `0.104` draws ~62 px; KNOWN_ISSUES §7 already records it drawing far too wide, which
is why a previous pass cut it to 0.040 and broke the object a different way.

The real ring defects were the two contrast killers *inside* the band, and those are fixed.
`shots/skyfix/_ringzoomsbs.png` is the before/after: a two-railed fluorescent tube on the
left, a translucent band with land, sea and cloud on the right.

Everything else in the review reproduced.

---

## 1. Headline numbers, full frame at ref_00720

`shots/skyfix/base_720.png` (before) → `shots/skyfix/full_E.png` (after).

```
                      before    after     ref      
sky      sat_mean      70.03    81.31    87.05     +11.3
sky      lab_b        -13.64   -17.31   -15.07     crosses the target
sky      lum_mean     113.16   112.10   120.67
sky_sun  sat_mean      28.55    72.31    85.78     +43.8  <- the big one
sky_sun  lum_mean     139.42    95.93   106.05     -43.5, was +33 over
sky_sun  lab_b         -5.16   -12.15    -7.66
horizon  sat_mean      63.71    54.84    81.93     regressed, see §5

clean deep-sky patch (x560-660, y30-60), the atmosphere on its own:
   before   53.4 / 74.7 / 119.2   B/R 2.23   lum 73.4
   after    52.4 / 84.1 / 137.7   B/R 2.63   lum 81.3
   ref      47.4 / 79.4 / 132.6   B/R 2.80   lum 76.4
   (ref patch found by scanning kf_00720 for low-variance blue 30x30 boxes;
    x 730-1010, y 10-130 is clean sky and agrees with the critic's 48.9/81.2/134.4)

clean-sky high-frequency content (laplacian variance, 200x100 sky-only box):
   before 78.9   after 62.7   ref 67.7

ring band at kf_00600 (isolated rig, y150):  width 24 px -> 46 px  (ref 52)
                                             median/sky ~2.3 -> 1.43  (ref 1.39)
sun disc: derived ratio 3.9e5 before Tview / 3.4e5 after, vs research §2.3's 3.5e5.
   589 px at >= 246 in a plateau with a 45-px veiling-glare skirt; before, the whole
   frame's brightest pixel was 248 with no plateau at all.
```

Cost: no measurable per-frame change (frame ms ranged 7.4-11.2 across the session,
dominated by other agents' concurrent edits). The one new cost is a sky-view LUT readback
on **sun move only** (2 × 256×256 RGBA16F ≈ 512 KB plus a half→float convert), which is
once per capture; the LUT itself was already gated on `_sunKey`.

---

## 2. What changed

| # | Item | Before | After |
|---|---|---|---|
| 1 | sun disc radiance | `320.0`, hand-set | **derived on every sun move** from the sky-view LUT: disc-avg : mid-sky pinned to research §2.3's 3.5e5, `sunDiscMax 45000` for half-float |
| 1 | `uSunCorona` | 48.0 additive lobe | **deleted** (research §2.5.3 — one owner of the glow; bloom.js owns beyond 1 solar radius) |
| 1 | env probe | dome rendered with the disc in it | **disc zeroed inside `renderProbe` only** (research §4.2: half-float Inf, SH ringing, PMREM double-count). Aureole kept. |
| 2 | `uCircumsolar` | `0.055` fitted polynomial tail, applied *outside* `uAtmTint` | **deleted**; fixed at the source with a signed-sqrt azimuth mapping on the sky-view LUT's u axis (first texel now spans 0.048°, the texel 1° out 0.105°, vs 0.70° everywhere before) |
| 3 | `surf = max(surf, inscatter*0.9)` | floors the whole band at 0.9× sky | **deleted** |
| 3 | ring haze floor | hard `0.45` regardless of elevation | `uRingHazeFloor = 0.16`; the 1/sin(el) airmass term carries the rest |
| 3 | `ringRail` | 1.35, 0.075-wide gaussian | 0.34, 0.150-wide (kf_00600's band peaks in the MIDDLE and falls to both edges) |
| 3 | `widthRatio` | 0.040 / 0.030 | **0.087 / 0.065** (measured — §0b) |
| 3 | `ringSurface` | frame `(s/1400, a/95)×0.24` → 396 km period across a 200 km band | keyed in km: `CONT_KM 155`, `ANISO 2.6`, coastline term; cloud albedo 2.15/2.55/3.10 → 1.50/1.66/1.90, threshold 0.110 → 0.235 |
| 4 | `cpuRadiance` | **a second atmosphere**: bMs 3.996e-3 vs GPU 1.900e-3, bMe 4.4e-3 vs 2.150e-3, boundary layer folded into the g=0.78 Mie lobe, hand-rolled MS, no `uMieScale` | **sky-view LUT read back to the CPU once per sun move**; `radiance()` applies the same phases, scales and tints the dome does, from the same uniforms |
| 4 | atmosphere constants | duplicated in a GLSL string and a JS object | **one exported `ATM` table; the GLSL string is generated from it** |
| 5 | `msScale` | 0.22 (78% of multiple scattering discarded) | **1.0** |
| 5 | `uBelowLift` | 6.0× on the below-horizon term "because env PMREMs this dome" | **deleted**; msScale 1.0 lands the lower hemisphere within 25% of where the hack put it |
| 5 | `uAtmTint` | `(0.430, 0.456, 0.912)` — a chroma rotation **times a 0.483 luminance cut** | **`(0.836, 0.964, 1.842)`, luminance-preserving to 4 dp**; the luminance half moved into `solarIrradiance` 9.4 → 4.8 |
| 5 | `uSunTint` on the in-scatter | applied — double-counts the atmosphere's own reddening | **removed** (kept on the disc, so disc and DirectionalLight still agree) |
| 6 | limb darkening | `u=(0.42,0.56,0.70)`, `alpha=0.55` | `LIMB_U=(0.664,0.747,0.821)`, `LIMB_ALPHA=(0.695,0.735,0.796)` — research §2.2 verbatim |
| 6 | `uSunAngularRadius` | 0.0047, and `time` overwrote it every frame | **0.0046542**; sky now owns the constant and only defers to `time` if something moved it off the legacy default |
| 6 | disc angle | `acos(cosT)`, ill-conditioned at cosT→1 | chord `length(dir - uSunDir)`, relative error 9e-7 at the limb, and cheaper |
| — | grain | 0.0240 | 0.0383, re-keyed after the sky's level dropped (see §1) |

---

## 3. The one place I disagreed with the review, and the experiment that settles it

The critic: *"Once MS is back, `uAtmTint` should be provably close to (1,1,1); if it is not,
the LUT chain has a bug worth finding rather than tinting away."*

I ran it. **With `msScale = 1.0` and `atmTint = (1,1,1)` the sky gets *less* saturated:**
`sky` ROI `sat_mean` 70.03 → **49.76**, clean deep sky B/R 2.23 → **1.62**
(`shots/skyfix/v1_720.png`). The hypothesis is falsified by its own experiment.

I then attributed it in **linear**, not by eye, with `tools/_skyprobe.mjs`:

```
zenith, linear HDR             R        G        B      B/R    G/R
  Rayleigh only            0.03397  0.06883  0.13668   4.02   2.03
  + boundary-layer haze     0.04778  0.08093  0.14660   3.07   1.69
  + free-troposphere Mie    0.04876  0.08188  0.14750   3.03   1.68
  + multiple scattering     0.06088  0.10980  0.23004   3.78   1.80
```

Multiple scattering is *bluer* than the single-scatter sky, so it is not the desaturator.
The desaturator is the marine boundary-layer aerosol, and it is doing exactly what its
coefficients say: τ_Bs/τ_R,red = 0.28, phase ratio at this scattering angle = 1.51, product
0.42 — measured 0.41. Its AOD is 0.015 against Bruneton's measurement-fitted marine 0.0655,
i.e. already four times too clean. There is no bug there to find.

Then the arithmetic that decides it. Inverting the real `agxJS()` out of `tonemap.js`
numerically against the reference's own clean deep sky (kf_00600 45/79/132, kf_00720
49/81/134) asks for **linear B/R ≈ 7.2, G/R ≈ 2.0**. Ours is B/R 4.2, G/R 1.95. So:

* **G is already physically right** — the old tint's green cut was simply wrong;
* a CIE clear zenith sky is B/R **2.78** in linear sRGB, so at 4.2 we are *already bluer
  than physical*. The residual ~1.7× in blue-over-red is the reference clip's colour
  **grade**, not an atmosphere defect.

So the tint stays — decomposed and quarantined:

* the **luminance** half (0.483) moved into `solarIrradiance`, one honest scalar that sets
  the sky's absolute level and nothing else;
* what remains is **luminance-preserving by construction**
  (`0.2126·0.836 + 0.7152·0.964 + 0.0722·1.842 = 1.0001`), so it cannot move the sky's
  absolute level, the sun:sky ratio, `env.groundIrradiance` or the exposure key;
* it is **solved**: a search over luminance-preserving (r,g,b) and exposure through
  `agxJS()` lands (49.2, 80.8, 134.0) against the reference's (49, 81, 134) at exposure
  0.582 — which is the exposure the scene's auto key was already running. One closed loop
  later (capture → invert `agxJS` on the measured patch → re-solve) it settles at
  (0.836, 0.964, 1.842).
* cross-check: the OLD tint's chroma rotation, normalised to luminance 1, is
  (0.890, 0.943, 1.887). Two independent derivations of the same grade. What was wrong
  with it was the luminance cut welded on and the green, not the blue.

It belongs in the `grade` pass at its final calibration (KNOWN_ISSUES §6).

---

## 4. Measurement hygiene

Mid-session `particles`, `ssr`, `structures` and a shadow-sampler material were all failing
to compile from *other* agents' in-flight edits; `shots/skyfix/A_720.png` is a flat grey
frame with no terrain, no sky dome and no weapon. Full-frame ROI numbers taken in that
window are worthless. The sky was therefore measured on an isolated rig:

```
node tools/capture.mjs --pose ref_00600 --only time,lighting,sky,env,pipeline --settle 24
```

which renders sky + Threshold + ring + sun and nothing else. Absolute code values differ
from the full frame (different auto-exposure), so the isolated rig is used for **ratios,
widths and chromaticity**; full-frame ROI numbers are taken separately and only from
captures whose log shows no failed module in the path.

Also, twice: backticks inside a GLSL template literal (KNOWN_ISSUES §20). `tools/_skycheck.sh`
now parses the module and scans every `/* glsl */` literal for stray backticks; run it
before every capture.

---

## 5. Still open / weakest thing left

1. **`sky` ROI `lap_var` 75 vs 253 and `edge_density` 0.018 vs 0.037.** Most of that gap is
   *geometry the frame does not have* — in kf_00720 the `sky` crop is half cliff, and in
   our captures `structures` was intermittently failing to compile. The part that IS the
   sky's own is now measured directly on a sky-only box and closed: clean-sky laplacian
   variance 62.7 against the reference's 67.7. Re-measure the ROI on a build where every
   module compiles before treating the residual as a sky defect.
2. **`horizon` `sat_mean` regressed 63.7 → 54.8** (ref 81.9). That crop is mostly ocean and
   near-field haze, and both `ocean.js` and `volumetricFog.js` were being edited during
   these captures. It needs re-measuring, and if it survives it is probably §18's depth
   bug rather than the sky's boundary layer.
3. **The frame still tops out at 248, not 255.** `agxJS()` returns display 254.7 for any
   exposed-linear ≥ 100 and the disc is now at ~2.4e4 exposed-linear, so this is no longer
   a sky problem — something after the tonemap (TAA's neighbourhood clamp on a 14-px disc
   is the most likely candidate, since TAA now resolves *before* bloom per §5) is capping
   it. Whoever owns `taa.js` should check with a 1-frame capture.
4. **`lighting` still drives the DirectionalLight from `time.sunColor`**, not from this
   file's transmittance LUT (research §4.1/§2.4). `sky.transmittanceTexture` and
   `sky.sunDiscDebug()` are exposed for whoever picks that up.
5. **`radiance()` now returns roughly half what it used to** (`env.groundIrradiance` 0.546).
   That is intended — it is the honest level, and per the review's item 4 every ambient and
   exposure constant fitted before this was fitted against the *wrong* atmosphere — but
   anything keyed off `sky.radiance()` (`env`, `clouds`, `volumetricFog`) should re-check
   its constants.
6. **The ring surface still reads as weather over noise rather than as coastlines.** The
   coastline term added here helps; KNOWN_ISSUES §7's own still-open note — advect the
   continental field along the circumference, or add an erosion/river pass — is the right
   next step. Our band std at kf_00600 y150 is 24.9 against the reference's 10.3, i.e. it
   is still too high-frequency for the ~9 km/px it subtends.

## 6. Research relied on

`research/sky.md` §2.1 (angular radius 0.0046542), §2.2 (Hosek-Wilkie limb-darkening table
and the Hestroffer-Magnan two-parameter fit), §2.3 (the 3.5e5 sun:sky ratio, the half-float
trap), §2.4 (do not author the sun colour), §2.5.1 (chord instead of `acos`), §2.5.3 (one
owner of the glow), §4 (one radiance function, three consumers), §4.2 (exclude the disc
from the probe), §7 (parameter block). Hillaire EGSR 2020 for the LUT chain and the
signed-sqrt parameterisation; Bruneton TVCG 2017 for the marine aerosol cross-check
(α 0.816, β 0.0384, τ550 0.0655) and for the CIE clear-sky chromaticity sanity check.
