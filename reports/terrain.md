# terrain — report

Owned file: `src/world/terrain.js`. All numbers from PNGs `tools/capture.mjs` wrote at
`--pose ref_00000 --settle 48`, measured with `tools/metrics.py` / `tools/roi.py`.

---

## 1. The terrain was not rendering at all. `patch` is a GLSL ES 3.00 reserved word.

`FIELD_GLSL` declared `float patch = smoothstep(...)` in the wind-ripple block. `patch`
is reserved in ESSL 3.00 (tessellation), so **all three** terrain materials — surface,
shadow depth, and the G-buffer proxy — failed to compile:

```
ERROR: 0:406: 'patch' : Illegal use of reserved word     MeshStandardMaterial
ERROR: 0:418: 'patch' : Illegal use of reserved word     MeshDepthMaterial
ERROR: 0:566: 'patch' : Illegal use of reserved word     ShaderMaterial
```

The "sand" in `shots/preview/preview.png` was the **clear colour**, not ground. Renaming
the variable put the whole heightfield in frame:

```
whole frame vs kf_00000     before      after
lum_mean                     98.87     110.48     (ref 112.19)
lap_var                     112.3      266.8      (ref 598.8)
edge_density                  0.025      0.048    (ref 0.098)
detail                        0.0       37.3
geometry                      0.0       46.5
score                         6.87      17.02
```

**Any whole-frame number taken before this — including the `docs/KNOWN_ISSUES.md` §8
table — was measured on a frame with no terrain in it.**

The failure is silent in a normal run: three logs the compile error to the console and
carries on with an invalid program. `tools/capture.mjs` does surface it, in
`warnings[]` and in the `modules not loaded:` stderr line. Check that line on every
capture; I lost two measurement cycles to a stray backtick inside a `/* glsl */`
template literal that killed the whole module the same way.

---

## 2. THE SCENE-WIDE DESATURATION IS `volumetricFog`, NOT ALBEDO — not my file

`docs/KNOWN_ISSUES.md` §8 blames the `sat_mean` collapse on material albedo. It is not
albedo. It is an additive near-field in-scatter from
`src/render/passes/volumetricFog.js` that auto-exposure then conceals.

Method: force the terrain albedo to pure black (`terrainDbg=3`) and measure the `sand`
ROI. Anything that appears is additive, because the surface reflects nothing.

```
config                                          sand lum_mean   rgb_mean
terrainDbg=3                                        73.4        70.5 72.9 83.5
terrainDbg=3,terrainSpec=0,aerialDensity=0          72.9        70.0 72.4 82.7
terrainDbg=3,terrainEnvInt=0                        73.4        70.5 72.9 83.5
terrainDbg=3,bloomIntensity=0                       73.4        70.5 72.9 83.5
terrainDbg=3,ssrEnabled=0                           73.4        70.5 72.9 83.5
terrainDbg=3,fogDensity=0                           44.3        44.2 43.9 46.5
```

A **black** beach renders at sRGB 73. Nothing moves it — not bloom, not SSR, not the env
probe, not aerial perspective, not this module's own analytic sky specular. Only
`fogDensity`.

Why luminance did not give it away: the fog roughly doubles the near-field pixel value
and `tonemap`'s keyed exposure pulls the frame back down to compensate. The mean looks
fine; the ratio of albedo signal to neutral wash is halved, so **chroma and contrast
collapse while luminance stays put.** That is exactly the §8 symptom, and it is why
bisecting `exposureEV` moved luminance without moving chroma.

Same build, same commit, one config knob, at `ref_00000`:

```
                fog on    fog off      ref
lum_mean        102.3      99.3      112.19
sat_mean         37.4      48.9       77.86
lap_var         280       477        598.8
edge_density      0.064     0.104       0.098
detail           41.95     92.68
geometry         72.89    100.0
spectrum         96.13    100.0
score            21.58     31.13
```

`detail` and `geometry` cross the AAA baseline (79.0 / 88.5, `ref/baseline.json`) the
moment the fog stops washing the frame, and the fog costs 25 points of `sat_mean` and 51
points of `detail` on its own.

For whoever owns that pass: `fogDensity 0.00075` over the 3-25 m of beach filling the
bottom half of frame is an optical depth of ~0.015, so the in-scattered radiance being
multiplied by it has to be of order 2.0 to produce what is measured. Either `uAmbSky`
is far too hot or the near-field distribution is inverted (`t = tEnd*(0.25u + 0.75u^2)`
concentrates samples in the near third, which is where a *marine haze layer* should
contribute least). **Nobody should recalibrate exposure or the grade until this is
resolved** — see §4 of KNOWN_ISSUES, this is the same trap in a third costume.

Terrain numbers below are quoted at `fogDensity=0` so they measure the surface rather
than the wash; the shipping-config numbers are in the summary table.

---

## 3. Albedo re-authored to measured reflectances

```
                      before                  after                  physical
dry sand      0.300 0.204 0.114       0.322 0.196 0.116        0.20-0.25, warm  (Y 0.217)
damp sand     dry x .52 .505 .515     dry x .50 .52 .585       ~0.13, cooler
wet sand      0.052 0.041 0.031       0.072 0.060 0.048        ~0.07
wet roughness 0.13                    0.12                     water film
shelf rock    0.085 0.079 0.070       0.150 0.140 0.122        damp/algal limestone
```

The damp multiplier is now cooler as well as darker: the water film kills the warm
multiple scattering between grains, which is the physical reason damp sand goes
grey-blue rather than merely dim. Wet roughness changed in **both** the surface shader
and `buildGBufferMaterial()` — they must agree or SSR and the TAA clamp disagree with
what was shaded.

The wet/dry ramps were narrowed (`smoothstep(0.02,0.45)` -> `(0.03,0.28)` and
`(0.35,0.92)` -> `(0.44,0.76)`) so the swash line is a step, not a gradient.

**The brief's 0.24/0.20/0.14 measured worse and was not shipped.** Captured, it put
`sand` at `sat_mean` 35.5 / `lab_a` 1.33 against targets of 69.0 / 3.57 — the reference
beach is golden, not neutral tan (`kf_00000`'s own `sand` crop measures `lab_b` +15.35,
`lab_a` +5.10). The shipped value keeps the reference's hue at the physical luminance;
it is an iron-stained calcareous sand, which is what a tropical shore actually is.

---

## 4. The cobbles were mathematically present and visually absent

`sand` wants `lap_var` 521 at `edge_density` 0.120 and `lum_std` 31.5. That is a stone
pavement, and pavements are geometry. There was code for one. It produced 3 mm of relief.

```glsl
float c1 = clamp(1.0 - w1.x * 2.05, 0.0, 1.0); c1 = c1*c1*(3.0-2.0*c1);
y += c1 * (0.030 + 0.055 * w1.z) * cob;
```

Mean Worley F1 for this cell layout is **0.424** (measured, 40k samples), so
`1 - 2.05*F1` clears 0.5 over only 13% of the area and the cubic crushes what is left:
mean displacement **3 mm against a nominal 11 cm**. Replaced with an ellipsoid cap over
a per-stone radius, `sqrt(1 - (F1/r)^2)`, shared by the displacement and the albedo
splat so a stone that stands proud of the sand is shaded as one.

Two more reasons nothing appeared:

- The gating mask `smoothstep(-0.16, 0.30, fbm)` had no floor and read **zero across the
  entire near field** — visualised with `terrainDbg=4`, the foreground was black. A
  cobble beach is a pavement; the mask now has a floor of 0.28 and drifts to 1.18.
- The splat weight was keyed the same crushed way (`smoothstep(0.06,0.42,mA)` on the
  same broken `mA`), so even where the mask was non-zero the blend peaked around 0.3.

Stones are now dark warm rock (0.010-0.228 linear, mean ~0.10) against 0.217 sand, with
a contact-shadow ring, a normal from the same cells, and smoother wave-polished tops.

The instanced stone field was also scattering **1.2 m boulders at ~1 per 9 m²**, which
reads as a rubble slope. Large-stone probability 10% -> 3.8% and diameter 0.20-0.95 m ->
0.16-0.46 m.

---

## 5. Frequency balance: broadband fizz with nothing underneath it

```
sand ROI (fog off)   after §1 fix    final    target
lap_var                    909        823      521
edge_density                 0.126      0.143    0.120
lum_std                     20.7       23.9     31.5
local_contrast               0.062      0.076    0.101
spectral_slope              -1.38      -1.71    -2.37
```

High `lap_var` with a *shallow* `spectral_slope` and low `lum_std` is the failure
`docs/TARGETS.md` names: high-frequency energy with no structure under it. Causes and
fixes:

- A 3 mm grain normal at full strength out to 14 m across the whole beach. Strength
  1.15 -> 0.88, `mipFade` starts at 7 m.
- Analytic Worley cells splatted with no distance fade. They have no derivatives, so
  they alias to the horizon. Now faded out at 14-31 m and replaced by the mip-filtered
  gravel bake's albedo (which previously contributed only a normal).
- Albedo variance moved from grain (was ±30%) to the metre scales: `tone` swings ±60%,
  plus a new 4-16 m drift band. The 46 m macro tile barely changes across the visible
  beach at eye height, so on its own it contributes almost nothing to `lum_std`.
- Damp staining at two scales — 3-9 m swash memory and 10-30 m high-tide stain.
- Displacement gated to what each clipmap level can resolve: 22 cm pavement at lod 2
  (12 cm lattice), 9 cm shingle and 16 cm ripples at lod 3 (3-6 cm). The old lod-3
  `vnoise2(P*46)` term had a **2.2 cm period on a 3 cm lattice** — below Nyquist at
  every level it ran on, so it produced no relief, only vertex fizz. Removed; measured
  effect on `lap_var` at the time was nil, confirming it was aliasing and not detail.

Note the direction of travel: `lap_var` came *down* 909 -> 823 while `edge_density` went
*up* 0.126 -> 0.143 and `detail` went 78 -> 93. Real edges replaced broadband noise.

---

## Results

Whole frame, `ref_00000` vs `kf_00000`:

```
                 broken   +compile fix   FINAL(ship)   FINAL(fog=0)     ref
lum_mean          98.87      110.48        102.3         99.3         112.19
lum_std           40.54       39.76         39.9         43.3          51.70
sat_mean          41.48       36.40         37.4         48.9          77.86
lab_b             -6.09       -1.22         -2.01         0.34          4.67
lap_var          112.3       266.8         280          477           598.8
edge_density       0.0254      0.0482        0.064        0.104         0.098
local_contrast     0.153       0.148         0.148        0.158         0.187
detail             0.0        37.31         41.95        92.68
geometry           0.0        46.48         72.89       100.0
spectrum          85.86       87.03         96.13       100.0
score              6.87       17.02         21.58        31.13
```

`sand` ROI (fog=0), against the published target and against `kf_00000`'s own crop:

```
                 +compile fix   FINAL    target   kf_00000
lum_mean            105.1       101.8    102.1     119.2
lum_std              20.7        23.9     31.5      35.1
sat_mean             61.2        59.0     69.0      86.6
lab_a                 3.40        4.62     3.57      5.10
lab_b                 8.60        7.02     2.83     15.35
lap_var             909         823      521      1089
edge_density          0.126       0.143    0.120     0.228
local_contrast        0.062       0.076    0.101     0.094
spectral_slope       -1.38       -1.71    -2.37     -2.08
```

`shoreline` ROI (fog=0): `lum_std` 38.5 -> 40.9 (target 42.7), `sat_mean` 66.6 -> 62.1
(69.3), `lap_var` 431 -> 899 (696), `edge_density` 0.048 -> 0.137 (0.127),
`local_contrast` 0.141 (0.150).

Second pose, `ref_00450` (fog=0): detail **100**, geometry **100**, spectrum **97.6**,
score **33.36**. The fix is not pose-specific.

**Determinism:** two independent 48-frame captures at `ref_00000` are byte-identical
(`cmp` clean). No `Math.random`/`Date.now` in captured content; all scatter is
`ctx.rand.fork()`.

**Cost:** module init 886 ms -> 1508 ms as measured, but that window had other agents
capturing concurrently (`rocks` measured 1363 and 1689 ms in the same two runs), and the
CPU work in `init` is unchanged — the height tables only evaluate lod <= 1, which is
net-identical. Per-frame vertex cost went *down* at lod 2 (one fewer Worley cell field);
the fragment gained one fbm2, one texture-free mix and one branch. Draw calls unchanged
(3 clipmap draws + the pebble chunks).

---

## Diagnostics left in the file

`ctx.config.terrainDbg` (0 = off, one static-uniform branch): 1 flat `uTDryCol`,
2 flat 0.18 grey, **3 black albedo — this is what found the fog**, 4 cobble mask,
5 wetness, 6 tone, 7 alongshore cobble density, 8 stone mask, **9 a 1 m checkerboard
with a 10 m red grid, i.e. a scale bar on the ground**. `terrainEnvInt` sets
`envMapIntensity` on the surface material.

§2 and §4 are both invisible in a normal capture and neither would have been found
without these. Mode 9 in particular: I twice mis-estimated how much ground the
foreground covers, and a checkerboard settles it in one frame.

---

## Weakest thing left

**The beach reads as a field of lumpy mounds rather than a sand slope with stones on
it.** It is worst at 15-60 m, where the grazing view multiplies vertical relief. It is
*pre-existing* — the same mounds are in the first post-compile-fix capture — and my best
hypothesis is the 6-14 m berm-scallop term, `fbm2(P*0.098) * (0.10 + 0.30*beach) * sh.z`,
whose 0.23 m first octave throws a very long shadow at 2° of grazing. I did try 0.52
there (worse: it became a dune sea) and reverted to the original, but I did not try
*reducing* it, because that term is shared with `heightJS` and therefore with every
module that scatters against `terrain.height()`. Whoever picks this up: change the GLSL
and the JS mirror **together**, and check `geometry` and `local_contrast` either side.

Second: `sand` `lum_std` 23.9 and `local_contrast` 0.076 are still ~25% short of 31.5
and 0.101, and `sat_mean` sticks at ~59 no matter how much chroma goes into the albedo
(0.244/0.202/0.140 and 0.322/0.196/0.116 both land within 2 points of each other). All
three are capped by the additive floor: with a black albedo, no fog, no bloom, no SSR
and no env, the beach still renders at sRGB 44 (~0.026 linear against a 0.11 signal).
That residue is specular — direct sun GGX at F0 0.04 plus whatever IBL survives
`envMapIntensity=0` — and it cannot be reduced from a `MeshStandardMaterial`.
`MeshPhysicalMaterial` with `specularIntensity` would expose the knob; that is a real
option and I did not take it because it is a heavier shader on the largest surface in
the frame and the fog defect dominates it by 3x.

Third: the wet/dry step is authored and measured but barely *seen*, because at
`ref_00000` the waterline is 40 m away at frame left. It needs judging at a pose that
puts the swash in the foreground — and the poses are unfitted (KNOWN_ISSUES §3), so
`kf_00000`'s `sand` crop is the wet swash zone while ours is dry berm. That mismatch is
most of the residual `sat_mean` and `lum_std` gap and no amount of terrain authoring
closes it.
