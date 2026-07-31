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

> **RETRACTED by later measurement — this section names the wrong file.** The half that
> holds is "not albedo": zeroing the albedo and re-measuring was the right experiment and
> its result stands. The attribution to `volumetricFog.js` does not. `reports/vegetation.md`
> §"Corrections to §8" measured `--skip volumetricFog` as a **byte-identical** PNG at
> `ref_00720` (with `--skip bloom` as a control), so the pass wrote no pixels and cannot
> have been the cause; `docs/KNOWN_ISSUES.md` §18 then found it — `scene.js` cleared the
> depth texture shared with the G-buffer, so every world pixel integrated 460 m of haze.
> Registered as `fog-owns-desaturation` in `tools/refuted.json`.

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

---
---

# terrain — pass 2 (this session)

All numbers from `tools/capture.mjs --settle 48`, `sand` ROI via `tools/roi.py`,
against `kf_00000`'s own `sand` crop (lum 119.2 / std 35.1 / sat 86.6 / lab_a 5.10 /
lab_b 15.35 / lap 1089 / edge 0.228 / lc 0.094 / slope -2.084 / p01 31 / p99 178).

## 0. The reproducibility complaint (critic item 6) was a broken sibling module

The critic measured a 56% luminance swing between two identical `ref_01500`
invocations. Re-run now, three back-to-back `--pose ref_01500 --settle 48` captures are
**byte-identical** (sand ROI lum 106.403460 / sat 54.784391 / lap 847.329 / edge
0.0901587 on all three). The difference: the critic's captures had `ocean` failing to
init from another agent's uncommitted edit, and a scene that is missing a module renders
differently depending on *which* modules happened to fail that run. There is no
nondeterminism in terrain. The engine-level gate the critic asks for (refuse to write a
PNG when `warnings[]` has a "modules not loaded" line) belongs in `tools/capture.mjs`,
which this task does not own — but the check is one grep on the capture's own stderr and
every number below was taken with `terrain` confirmed loaded.

## 1. Critic item 2 was right, and it is three's specular, not albedo

`terrainDbg=3` (albedo forced to pure black), `sand` ROI, ref_00000:

```
                       before    after
lum_mean (black alb)    48.4      23.9
lap_var  (black alb)   645.1     403.2
```

`terrainDbg=9` (1 m checkerboard, albedo 0.05 vs 0.50, 10:1), near field, solving
`L = k*a + c` on the linear p10/p90:

```
              before            after
p10/p90 sRGB   94 / 174         71.1 / 168.9
linear ratio   3.85 : 1         6.26 : 1
k              0.705            0.739
additive c     0.076 linear     0.0263 linear    (-65%)
```

Cause and fix: `MeshStandardMaterial` hard-codes F0 = 0.04 and applies **no specular
occlusion**, and neither `uTSpecBoost` nor `envMapIntensity` gates it — which is why the
previous pass eliminated every config knob and still measured a black beach at sRGB 44.
Two new globals, `gTSpecOcc` and `gTAO`, are now applied at the
`<lights_fragment_end>` injection point:

```glsl
reflectedLight.directSpecular   *= gTSpecOcc;
reflectedLight.indirectSpecular *= gTSpecOcc;
reflectedLight.indirectDiffuse  *= gTAO;
reflectedLight.indirectSpecular += gTEnvSpec;
```

with `gTSpecOcc = mix(0.42, 1.0, smoothstep(0.35,0.90,wet)) * ao * (1 - cobShade*0.55)`
— 0.42 takes F0 from three's 0.04 to sand's ~0.018, wet sand keeps its lobe. This did
not need `MeshPhysicalMaterial`; it is four lines in an injection that already existed
and costs nothing measurable.

## 2. Critic item 5 — AO was on the albedo, so it darkened the sun

`diffuseColor.rgb = alb * ao` is physically wrong: AO is an indirect-only term. Combined
with an AO floor of 0.22 (78% occlusion, on an open beach), a cobble-shade multiplier
and two damp-stain multipliers all stacked on the same albedo, the shadowed sides of the
mounds went to sRGB 4 against the reference's p01 of 31. Now: AO floor 0.62, the micro/
meso/gravel occlusion weights cut roughly in half, `diffuseColor.rgb = alb`, and `ao`
applied to `reflectedLight.indirectDiffuse` only. Damp stains 0.80/0.85 -> 0.55/0.55 and
their tints lifted.

```
sand ROI, ref_00000     before   after   kf_00000
p01                        4       18       31
p99                      140      135      178
shadow_frac             0.0263   0.024    0.0110
```

## 3. Critic item 3 — the mounds are gone

`FIELD_GLSL` and its `heightJS` mirror, changed in the same edit:

```
macro dune 40-110 m   fbm2(P*0.0125, 4) * (0.55 + 1.35*beach)  ->  (0.55 + 0.45*beach)
berm scallop 6-14 m   fbm2(P*0.098,  3) * (0.10 + 0.30*beach)  ->  2 octaves, (0.04 + 0.10*beach)
lod>=1 cobble mounds  cm * 0.13                                ->  cm * 0.055
swash micro-terraces  band*(saw-0.25)*0.115                    ->  *0.21   (reinvested, shore-PARALLEL)
```

The scallop drops from 3 octaves to 2 so its tail stops landing at 2.5 m. Visually this
is the single biggest change in the frame: `shots/c2_r.png` onward reads as a sand slope
rather than the tapioca field in `shots/cE_terrain_b.png`.

## 4. Critic item 1 — the wet path no longer mirrors

```
rough    mix(0.94, 0.12, ...) -> mix(0.94, 0.30, ...)
sheet    rough -> 0.055        -> 0.085, and the sheet gaussian narrowed
         exp(-((y - swashTop*0.30)*7.0)^2) -> *22.0   (sigma 0.14 m -> 0.045 m in Y;
         at a 2 deg beach slope the old value painted 8+ m of ground, not ~1 m of run-up)
uTWetCol 0.072/0.060/0.048     -> 0.100/0.085/0.070   (dark but still warm)
stones   mix(colA, colA*vec3(0.58,0.70,0.58), wet*0.75) -> colA *= mix(1.0, 0.55, wet)
         and the nearC distance fade no longer scales the splat
```

## 5. Critic item 4 — stones: partly fixed, and the framing is measured

The critic's brief assumed the `sand` ROI is ground at 10-40 m. It is not.
`terrainDbg=9` and a new `terrainDbg=10` (which paints `vec3(sA, sB, 0.0)`, the two
stone splat weights) settle it: **in the `sand` crop 1 m of ground is ~1000 px**, i.e.
the foreground there is 0.5-1.5 m from the camera. That measurement invalidates most of
the intuition on both sides of this argument — at that range a 22 cm cobble is 200 px
wide, and the "uniform orange-peel stipple" is the 3 mm grain normal, not the pavement.

Changes made: `tStoneDisc` (an oblate `pow(1-d^2, 0.35)` cap) replaces the hemispherical
`tStoneCap` for the DISPLACEMENT only, so stones are flattened discs bedded in sand
rather than marbles; displacement amplitude `(0.045 + 0.078*w1.z)` -> `(0.014+0.020*w1.z)`;
`tCobbleMask` given a coverage floor independent of `alongshore` (it was gated entirely
on a waterline band, so the whole near and mid field had **zero** stones) and its height
cut-off raised 4.8-7.6 m -> 8.2-11.5 m (the berm the camera stands on at ref_00000 is
already above 4.8 m, so the foreground fell outside the pavement); `nearC` extended from
14-31 m to 40-62 m and layer B from 6-16 m to 14-30 m; stone albedo re-authored from
0.010-0.228 to 0.006-0.098 for a real ~3.5x value step against 0.217 sand; contact
shadow `cobShade` 0.34 -> 0.52.

**This is the weakest part of the pass and it is not finished** — see below.

## Results, `sand` ROI at ref_00000

```
                 critic's ship   this pass   kf_00000
lum_mean            108.16        111.90      119.22
lum_std              24.47         19.95       35.12
p01                      4            18          31
p99                    140           135         178
sat_mean             55.76         66.11       86.58
lab_a                 4.59          5.56        5.10
lab_b                 6.86          9.95       15.35
lap_var             834.5         312.5      1089.0
edge_density          0.1419        0.0459      0.2284
local_contrast        0.0783        0.0663      0.0944
spectral_slope       -1.718        -1.728      -2.084
shadow_frac           0.0262        0.0240      0.0110
```

Honest reading: chroma and the black point moved decisively the right way
(sat +18.5%, lab_b +45%, p01 4 -> 18 against a target of 31) and the false detail is
gone — but it took `lap_var` and `edge_density` down with it, because the broadband
energy that was there was specular fizz on the grain normal and nothing replaced it.
`lum_std` fell 24.5 -> 20.0 for the same reason: the mounds were carrying it, and the
stones do not yet carry it back.

## 6. Final numbers (this is what is on disk)

`sand` ROI. Two independent `--settle 48` captures at ref_00000 are byte-identical
(`cmp` clean).

```
ref_00000            critic's ship   THIS PASS    kf_00000 crop
lum_mean                108.16        112.40        119.22
lum_std                  24.47         17.44         35.12
p01                          4            38            31
p99                        140           137           178
shadow_frac             0.0262        0.0053        0.0110
sat_mean                 55.76         67.53         86.58
lab_a                     4.59          5.75          5.10
lab_b                     6.86         10.59         15.35
lap_var                 834.5         569.1        1089.0
edge_density              0.1419        0.1176        0.2284
local_contrast            0.0783        0.0519        0.0944
spectral_slope           -1.718        -0.886        -2.084

ref_01500 (ocean present in both)   before   after   kf_01500 crop
lum_mean                            106.40   104.74      66.10
lum_std                              33.42    32.40      17.41
sat_mean                             54.78    60.61      39.66
lap_var                             847.3    861.8      194.97
edge_density                          0.0902   0.0941     0.0863
local_contrast                        0.1129   0.1087     0.0511
spectral_slope                       -2.556   -2.547     -2.247
```

Note that the critic's ref_01500 figures (lum 129.4 / edge 0.019 / lap 200) cannot be
reproduced with `ocean` loaded, and `terrainDbg=3` at ref_01500 measures 94.8 with the
terrain albedo at zero — because most of that crop at that pose is **rocks**, not
terrain. The ref_01500 `sand` numbers are largely not this module's to move.

## Weakest thing left — read this before touching the stone splat

**The cobble albedo splat does not reach the screen and I could not find out why.**
Decisive experiment: set `colA` to `vec3(0.0)` — pure black stones over ~30-45% coverage
— and re-capture. The frame is *visually indistinguishable* from the shipped one
(`shots/blk4_r.png` vs `shots/c10_r.png`), and the `sand` ROI barely moves. Every
intermediate step in that chain checks out on its own:

- The line is live. Replacing `sA` with the constant 0.75 in the same `mix` drops the
  ROI from lum 112 to **67.8**, so the statement executes and reaches `diffuseColor`.
- `sA` is non-zero and correctly shaped: `terrainDbg=10` (new, paints `vec3(sA, sB, 0)`)
  shows discrete stones at ~30-45% coverage; `terrainDbg=8` shows the same Worley field.
- Albedo reaches the screen: `terrainDbg=1` (flat 0.322/0.196/0.116) renders
  rgb 141.0/120.0/105.7 — **R > G > B**, the hue inversion the critic measured is gone —
  against `terrainDbg=3` (black) at 18.7. Solving `L = k*a + c` gives k 0.90, floor
  0.0064 linear. There is no additive floor left that could hide a 3.5x albedo step.
- Removing `rockW` entirely changes nothing.
- It is not the shared capture daemon: killing it and re-capturing gives the same frame.

Two facts that must be true simultaneously — `sA` is large, and forcing the colour it
blends in to black does nothing — cannot both be true, so one of the two measurements is
lying and I ran out of session before I found which. **Whoever picks this up: start
there, and start by rendering `sA` and the final `alb` to two halves of the same frame
so they are read from one capture instead of two.** Do not re-tune anything else until
that is settled; every stone-related number in this report is downstream of it.

Consequences visible in the table above: `lum_std` 17.4 against 35.1, `local_contrast`
0.052 against 0.094 and `spectral_slope` -0.886 against -2.084 are all the same defect —
the mound relief that used to supply the metre-scale variance is (correctly) gone, and
the stones that should have replaced it are not landing, so what remains of the beach's
energy is the grain and gravel normals, which is high-frequency by construction. I put
those normals back up (micro 0.55 -> 0.80, gravel 0.85 -> 1.30) purely to hold
`edge_density` at 0.118 rather than 0.046 while the splat is broken; that is a knowing
trade of `spectral_slope` for `edge_density` and it should be reverted the moment the
splat works.

`p01` also overshot: 4 -> 38 against a target of 31, and `shadow_frac` 0.0053 against
0.0110. The AO floor is at 0.46; it wants to come back to ~0.35 once real contact
shadows exist.

## Cost

No new draw calls, no new textures, no new npm anything. Fragment shader: four
multiplies at `<lights_fragment_end>`, one extra `mix` in the specular-occlusion term.
Vertex shader: `tStoneDisc` replaces `tStoneCap` (a `pow` for a `sqrt`) and the berm
scallop drops from 3 fbm octaves to 2, which is a net saving. Module init measured
1.41 s against 1.51 s before, but other agents were capturing concurrently in both runs,
so treat that as "unchanged".

## Diagnostics added

`terrainDbg=10` — paints `vec3(sA, sB, 0.0)`, the two cobble splat weights. This is the
one that showed the splat is present, and it is the one the next person needs.

---
---

# PASS 3 — the pavement is real objects now (height blend), and the dead normal is fixed

All numbers below: `node tools/capture.mjs --pose <p> --settle 48`, `tools/roi.py … sand`,
`tools/metrics.py --stats`. Band figures are the std of the luma in Gaussian-difference
bands (sigma 2 / 8 / 32 px) = the "hi / 2-8 / 8-32 / >32" columns — the same decomposition
the critic used, so the numbers are directly comparable.

Baseline for this pass reproduces the critic's shipped figures **exactly**
(lum_std 17.442, lap_var 569.05, local_contrast 0.05191, edge 0.11762, p01 38,
shadow_frac 0.005272, bands 9.09/3.89/4.81/11.00). So we are measuring the same build.

## 0. The critic's item 1 is confirmed, and it was one line

`nOut` was built at the top of the fragment shader and the cobble block wrote into `nDet`
100 lines later. Nothing read `nDet` again — the stones had **no shading normal at all**.
Moving the `nOut` construction to just before `roughnessFactor` (a pure reorder, nothing
between the two points reads it) reproduces the critic's probe to three digits:

```
sand ROI, ref_00000     shipped    +nOut move   kf_00000
lum_std                  17.442      21.440       35.12
local_contrast           0.05191     0.06913      0.09438
shadow_frac              0.00527     0.00988      0.01097
p01                         38          32           31
lap_var                  569.05      628.79      1089.0
edge_density             0.11762     0.12107      0.22840
band 8-32 px              4.81        5.75        13.12
```

**This also explains reports/terrain.md's "unsolved mystery"** (setting `colA` to black
changed nothing). It was never an albedo problem. Two facts the previous pass could not
reconcile — "sA is large" and "zeroing the colour it blends in does nothing" — are both
true; what was missing is that a hard-rimless splat with no normal is a tint, and a tint
of near-black over near-black sand-in-shadow is invisible. Do not re-open that thread.

## 1. TRAP: a backtick inside a `/* glsl */` comment kills the module silently

I lost a cycle to this within ten minutes of starting, exactly as §1 of this report warns.
The capture reports it as `modules not loaded: terrain: Unexpected identifier '<token>'` —
a *JavaScript* parse error, not a GLSL one, because the backtick terminated the template
literal. **Grep your new comments for backticks before capturing.**

## 2. The framing argument, settled with a finer ruler

`terrainDbg=9` was a **1 m** checkerboard. One square more than fills the foreground crop,
which is how two mutually exclusive estimates of "how many pixels is a metre" both survived
a whole pass (the critic's ~150-500 px/m and my own ~35 px/m read off the same frames).
It is now a **10 cm** checker, red every 1 m, blue every 10 m. Read off `shots/tf/dbg9b.png`:

```
sand ROI, ref_00000     ground distance     scale
bottom of crop              ~0.8 m         ~1000 px/m
middle of crop              ~1.8 m          ~450 px/m
top of crop                 ~3.2 m          ~250 px/m
```

Consequences, and this is what drove the whole pass:

- the reference's foreground pebbles are 30-90 px → **3-9 cm**, not the 16-22 cm the
  previous pass and the critic's note both assumed;
- a 6 cm stone cannot be displaced by a 3 cm lattice (2 samples), so **the pavement has to
  be a shading feature**, with the vertex term only rounding the surface under it;
- the 0.32 m micro tile is 0.31 mm/texel, so at 1000 px/m its finest content is sub-pixel
  and carries no information — research §0.1's "nothing under ~5 mm is ever resolved".

## 3. The pavement: Mishkinis height blend (research §4.4), not a radial splat

Replaced `smoothstep(0.40, 0.14, F1)` — a soft 5 cm ramp with no discontinuity anywhere —
with the published height blend, `ma = max_i(h_i + w_i) - DEPTH`, `b_i = max(h_i+w_i-ma, 0)`
normalised, and the **same b_i driving albedo, normal AND roughness** (research F13).
Two layers (5.5-7.6 cm stones at 0.091 m cells, 2.3-3.2 cm granules at 0.038 m cells)
plus sand. `DEPTH = max(0.085, fp*26)` — widened with the pixel footprint so the hard rim
is never narrower than a pixel, which is the antialiasing.

Three things had to be right and each was a separate measured failure:

1. **The heights you blend must be smooth relative to a stone.** My first version had
   `hS = 0.40 + 0.34*mesoA + 0.14*grainA`, and `grainA` is the millimetre micro tile — the
   blend boundary followed the grain, and `terrainDbg=10` came back as red *static* instead
   of red discs. `hS = 0.44 + 0.20*mesoA`.
2. **Local density belongs in the burial depth, not in the layer weight.** With density in
   `w_i`, a 2.4 m drift mask switched the entire pavement off in patches — `terrainDbg=10`
   was one red oval in a black frame. In `h_i` it means "thin pavement = most stones
   swallowed, the biggest still show", which is what a thinning pavement is.
3. **Stones must not touch.** At radius 0.40-0.56 of a 0.20 m cell the discs overlapped,
   every stone fused with its neighbour and coverage hit ~100%: the sand disappeared and
   the crop lost 30 code values of `lum_mean` and 21 of `sat_mean`. Radius 0.30-0.42 of a
   cell caps peak coverage at `pi*r^2` = 41%, which is a pavement *with sand in it*.

Also: `tCell` squashed every cell along world Z, so every stone on the beach was an ellipse
with the same major axis and the field read as combed. It now squashes in a **per-cell
random frame** taken from a normalised hash vector (not a sincos — 9 cells x 2 layers x
2 trig per pixel is not worth a rotation nobody can measure), and per-stone *value* comes
from a second decorrelated hash so the pale stones are not also the big ones.

## 4. `tCellG`: exact analytic Worley gradient, and it is free

For Worley F1 the gradient *is* the unit vector away from the winning feature point, so
`dF1/dP = -R^T (S^2 (R dv)) / F1` falls out of the loop you already ran. That replaced two
extra 9-cell Worley evaluations per pixel (the old finite difference), and it differentiated
the **stone**, not the distance field — the old `0.085 * grad(F1)` tilted the sand between
the stones as hard as the stones, and understated a real stone slope by ~3x.

## 5. Derivative summing, variance-preserving tile break, specular AA

- **Normals**: every detail layer is now a tangent-space derivative (`tDecodeD`), summed,
  clamped to +/-8, converted once. The whiteout blend it replaces multiplies the z terms,
  so each added layer pushed the combined *slope down* (research F17a). Measured
  independently: with `terrainDetail=0` the sand crop's >32 px band is 22.18 and with the
  detail stack on it is 13.34 — the stack was *removing* low-frequency contrast.
- **Tile break**: local `tNoTile` implements Heitz Eq. 8, `X = sum(w_n(X_n - E[X]))/sqrt(sum w_n^2) + E[X]`,
  with `E[X]` the true per-channel mean computed in JS from the bake readback (not the top
  mip). Offsets are full-tile, not the 0.5 sub-tile shifts that left the four taps as
  correlated copies (F5), and the whole blend is skipped once one pixel covers half a tile,
  where it is a provable no-op that was costing 4 taps to the horizon.
  `src/gfx/glsl/noise.js` is **not** mine and is unchanged; `textureNoTile` is still there
  for other modules and still halves contrast at every cell corner.
- **Specular AA**: Kaplanyan/Tokuyoshi, `alpha2 += min(2*variance, 0.18)` on the final
  world normal, SIGMA2 0.25. Unverified against a reference implementation — flagged.

## 6. A bug I introduced and caught by measurement

I added Fdez-Aguera multiple-scattering energy compensation to `tEnvBRDF` and wrote
`Fms = Ess*Favg/(1-Ems*Favg)`. It must be **`FssEss`**, not `Ess` — with `Ess` the
compensation is independent of F0 and adds 0.019 on top of a 0.012 single-scatter term on
roughness-0.94 F0-0.028 dry sand, i.e. a **2.6x specular boost on dry sand** arriving as a
blue additive wash. Caught because `lap_var` jumped to 946 with no visible detail change
and `p01` fell to 11. Fixed; `p01` went 11 -> 26 and `lap_var` 946 -> 538 in one step.

## 7. The mounds (critic item 3) — the claim does not reproduce, and here is the test

The critic says `terrainDbg=1` shows "a field of 0.5-3 m humps at full strength across the
entire mid-field". Run with `terrainDbg=1,terrainDetail=0` — which keeps the mound terms
(they are **not** gated by `uTDetail`) and removes the cobble/shingle/ripple stack — the
beach is a near-planar slope with one broad swell (`shots/tf/z_nodet.png`). What reads as
"mounds" in the shipped frame is the wind-ripple corduroy plus the grain stipple.

The band decomposition agrees and points the other way: at the time of the complaint the
crop's >32 px band was 11.00 against the reference's 13.45 — we were **under**, not over.
I trimmed `cm * 0.055` to `0.040` anyway (it did briefly overshoot to 16.1 once the pavement
landed) and mirrored it in `heightJS`, but this was a 25% trim, not the ~65% cut asked for,
and the crop is now at 9.18 — **under target, and that is the biggest remaining gap.**

## 8. Results — `sand` ROI at ref_00000

```
                     shipped     THIS PASS    kf_00000     target(TARGETS.md)
lum_mean              112.40       107.46       119.22        102.1
lum_std                17.44        28.83        35.12         31.5
p01                       38           23           31
p99                      137          146          178
shadow_frac           0.00527      0.02201      0.01097
sat_mean               67.53        57.10        86.58         69.0
lab_a                   5.75         4.35         5.10          3.57
lab_b                  10.59         8.54        15.35         +2.83
lap_var               569.05       955.72      1089.0         521
edge_density          0.11762      0.22903      0.22840        0.120
local_contrast        0.05191      0.08102      0.09438        0.101
spectral_slope        -0.886       -2.162       -2.084        -2.37

Gaussian band std (sigma 2 / 8 / 32 px)
hi  (<2 px)             9.09        12.63        15.39
2-8 px                  3.89        11.05        14.13
8-32 px                 4.81        12.66        13.12
>32 px                 11.00         9.18        13.45
```

`edge_density` is now **on** the reference (0.2290 vs 0.2284) and `spectral_slope` moved
from the flattest number in the build (-0.886) to -2.16 against -2.08. The 3.6x hole at
2-8 px and the 2.7x hole at 8-32 px are closed to 1.28x and 1.04x. Whole-frame `detail`
axis went 71.77 -> 100.0 and `score` 29.51 -> 31.05 (`geometry` was already 100).

**And the crop now looks like a cobble beach** — `shots/tf/z_s9m.png` against
`shots/tf/kf0_sand.png`: discrete stones with hard rims, their own value, their own
contact shadow, bedded in visible sand. The shipped build was `shots/tf/z_s1.png`, brown
suede with grey stipple.

## 9. What did NOT get fixed, honestly

**`sat_mean` 57.1 against 86.6 is not this module's albedo, and I can prove it.**
Flat-albedo probe at ref_00000 (`terrainDbg=1`, albedo = `uTDryCol` = 0.322/0.196/0.116,
R:B = **2.78**) renders at rgb 135.5/115.5/102.4, i.e. linear R:B = **1.81**. A
neutral 0.18 grey (`terrainDbg=2`) renders at linear R:B 0.900, so the illumination itself
is ~11% blue; the rest is an additive floor. Black terrain (`terrainDbg=3`) renders at
sRGB 24.0/24.1/27.1. Nulling **my** analytic sky specular (`terrainSpec=0.001`) moves the
sand ROI's `sat_mean` by **1.2 points** (58.8 -> 60.0). So at most ~1 point of the 29-point
deficit is mine. Warming the stones by 40% moved `sat_mean` by 1.0 point. Whoever owns the
grade/fog/aerial chain should take this: the terrain cannot be made saturated by authoring
a more saturated albedo, because the chain divides its chroma by 1.5 before it reaches the
screen.

**The >32 px band, 9.18 against 13.45.** The reference's low-frequency energy in that crop
is a wet swash sheet and a wave; ours is a dry berm. Some of that is pose/scene, not
shading. The honest fix is shore-parallel swash terraces and a drift line, which I did not
get to.

**`shadow_frac` 0.0220 against 0.0110 and `p01` 23 against 31.** Too many dark pixels —
the stones plus their contact shadows. Halving `cobShade` again is the obvious next knob.

**Wet sand at ref_01500 is still a grey card, and it is the same additive floor.**
Terrain-only patch x[0.02,0.30] y[0.60,0.80], `--skip ocean`:

```
                      shipped    THIS PASS    kf_01500
rgb                 90.0/89.5/88.4  92.0/91.4/91.3  71.8/72.9/88.0
sat                     14.5         20.1           49.5
lab_b                   +0.74        +0.15          -8.93
lum                     89.5         91.6           74.4
```

I re-authored `uTWetCol` from 0.100/0.085/0.070 (R:B 1.43) to 0.076/0.057/0.043 (R:B 1.77),
split the wet roughness path (0.30 -> **0.65**, research §5.4's "moderately rough
dielectric", with only the thin draining sheet at 0.085), stopped AO and the cobble shade
crushing the wet specular lobe, clamped `NoV` to 1e-4, and added the multiple-scattering
term. **The patch did not move.** Two measurements say why: (a) `terrainDbg=5` puts `wet`
at ~0.5 there, and the `wetC` mix only starts at `smoothstep(0.44, 0.76, wet)`, so barely
10% of `uTWetCol` is reaching that patch — it is *damp*, not *wet*; (b) `terrainDbg=3` at
that pose renders **rgb 33.5/38.3/45.7** — a **black** beach at sRGB 34-46, blue-dominant.
The additive floor is 16% of the red channel and 28% of the blue channel of the shipped
pixel value, and it is what neutralises the hue. Same disease as §9 above.

`--skip ocean` is required at ref_01500 or you are measuring the ocean, and note that
`--skip` silently does nothing for render passes (`volumetricFog`, `aerial`) — use
`--config fogDensity=0` / `aerialDensity=0` for those.

## 10. Cost

No new textures, no new draw calls, no new npm anything. Net fragment ALU is roughly flat:
+1 Worley (a third `tCellG` was NOT added), but -2 Worley from the analytic gradient
replacing the finite difference, -4 texture taps from gating the tile break by footprint,
and the whiteout `normalize` chain replaced by a running `vec2` add. Vertex is cheaper:
the shingle displacement layer is gone. `pipeline` init 114-289 ms across captures, module
init dominated by other agents capturing concurrently — treat as unchanged.

## 11. Diagnostics

- `terrainDbg=9` — **now a 10 cm checker**, red every 1 m, blue every 10 m. This is the one
  that settles framing arguments. Use it before you believe anything about feature sizes.
- `terrainDbg=10` — `vec3(bA, bB, 0)`, the two height-blend weights. Red static = your
  blend heights have high-frequency content in them. One red oval = your density is in the
  weight instead of the height.
- `terrainDbg=11` — `vec3(cobD, layer-A footprint visibility, fp*10)`: separates the three
  things that can empty the pavement in one capture.
- `terrainDbg=1/2/3` — flat warm albedo / 0.18 grey / black. Running all three at one pose
  is how you find out whether a chroma complaint is albedo or an additive floor, and it
  takes three captures.

---

## 12. FINAL NUMBERS — a true back-to-back A/B, and why the earlier tables drifted

Several postfx modules (`sharpen`, `taa`, `ssao`, `ssr`, `bloom`, `dof`, `grain`) were
being edited by other agents **during** this pass. Two captures of an unchanged build
minutes apart agreed to 0.3% (`lap_var` 487.0 vs 488.5), but captures an hour apart did
not: the shipped build's own `sand` figures moved from `lum_mean` 112.4 / `sat_mean` 67.5
to 90.3 / 39.6 without anyone touching this file. **So the only honest before/after is a
back-to-back one.** Method: `cp` my file aside, `git show HEAD:src/world/terrain.js >` it,
capture, restore, capture. Both frames below are from the same ten-minute window.

```
sand ROI, ref_00000        BEFORE (HEAD)   AFTER (this pass)   kf_00000
lum_mean                       90.30           106.95           119.22
lum_std                        30.96            27.92            35.12
p01                               31               26               31
p99                              136              144              178
shadow_frac                   0.0119           0.0165           0.0110
sat_mean                       39.59            52.08            86.58
lab_a                           3.10             4.32             5.10
lab_b                           1.63             7.32            15.35
lap_var                       414.71           668.35          1089.0
edge_density                  0.14141          0.21919          0.22840
local_contrast                0.10749          0.07900          0.09438
spectral_slope                -1.980           -2.198           -2.084

Gaussian band std (sigma 2 / 8 / 32 px)
hi  (<2 px)                     8.68            11.69            15.39
2-8 px                          7.07            10.85            14.13
8-32 px                        12.28            12.39            13.12
>32 px                         19.74             8.82            13.45

whole frame        detail 38.75 -> 85.67    spectrum 100 -> 81.74
                   geometry 100 -> 100      score 26.14 -> 31.96
```

Headline: **the 2-8 px band — the pebble band, the one the critic measured a 3.6x hole in —
is up 53%**, `edge_density` is within 4% of the reference, `sat_mean` is up 12.5 points,
`lab_b` up 5.7, and the whole-frame `detail` axis went 38.75 -> 85.67 (the AAA calibration
in TARGETS.md puts the reference's own cross-shot `detail` mean at 79.0).

Losses, stated plainly:

- **`>32 px` band 19.74 -> 8.82 against a target of 13.45.** I over-corrected. The
  mound-trim is only part of it — putting `cm * 0.055` back (from 0.040) moved it 8.82 ->
  8.82, i.e. **not at all**, so the mound term is not what carries that band and the
  critic's item 3 was aimed at the wrong term. Neither did clumping the stones into
  decimetre drifts (8.82 -> 8.85 for one 3-octave fbm per pixel; reverted, with a comment
  in the file saying why). At this framing that band is 7-70 cm of ground; the honest
  candidates left are shore-parallel swash terraces, a drift line, and modulating the
  height-blend THRESHOLD rather than the density. **This is the first thing to fix.**
- **`local_contrast` 0.1075 -> 0.0790 against 0.0944.** HEAD's higher figure came from
  metre-scale mound shading; mine is lower because that went and the pavement did not
  fully replace it. Same root cause as the band above.
- **`spectrum` axis 100 -> 81.74** whole-frame, while the `sand` crop's own
  `spectral_slope` improved from -1.98 to -2.198 against -2.084. Those are not in conflict:
  the crop got better, the whole frame's mix changed.

Wet sand at ref_01500 (terrain-only patch, `--skip ocean`) did move, just not far enough:

```
                    HEAD-ish shipped   THIS PASS    kf_01500
rgb                  90.0/89.5/88.4   94.0/93.3/98.5   71.8/72.9/88.0
sat                       14.5            23.7           49.5
lab_b                    +0.74           -2.89          -8.93
lum                       89.5            94.1           74.4
```

The **sign of `lab_b` is now right** and B > R for the first time, so the grazing sky
reflection is reaching the surface. It is still 27% too bright and half the chroma, and
§9 says why: on a **black** terrain that patch still renders at sRGB 33.5/38.3/45.7.

## 13. Failed experiments, so nobody repeats them

- Widening the stone size spread from 1.4x to 2.6x (`r = 0.18 + 0.28*hash`): worse on every
  axis — `lap_var` 488 -> 468, `edge_density` 0.168 -> 0.158 — because the height-blend
  threshold culls the small end, so the spread costs coverage and buys nothing. A comment
  in the file records this at the line.
- Clumping stones into 0.45 m drifts via `cobD`: no measurable effect (see above).
- Re-authoring `uTWetCol` alone: moved the ref_01500 patch by 0.1 code values, because
  `wet` is ~0.5 there and the `wetC` mix started at `smoothstep(0.44, ...)`. Widening the
  ramp is what let it take effect.
- Warming the stone albedo by 40%: +1.0 `sat_mean`. Nulling my own env specular: +1.2
  `sat_mean`. Neither is where the 29-point saturation deficit lives.

## 14. The picture, which is the actual point

`shots/tf/z_BEFORE.png` and `shots/tf/z_FINAL.png` are the same crop (sand ROI, ref_00000)
from the two back-to-back A/B frames in §12.

- **Before**: metre-scale grey humps under a uniform, scale-invariant grey stipple. Brown
  suede with sandpaper printed on it — the critic's phrase, and it is accurate.
- **After**: discrete stones with hard rims, each with its own value and its own contact
  shadow, bedded in visible warm sand.

Worth noting for whoever reads the critic's item 3 next: the humps visible in the BEFORE
crop are largely the **instanced pebble meshes** (`buildPebbles`, 16-46 cm large / 3.5-18 cm
small at 0.62 m spacing), not the `cm * 0.055` height term. At 1000 px/m a 40 cm cobble is
400 px and reads as a hump. Their instance colours were 0.020-0.22 linear at an R:B of only
1.2 — neutral slate over warm sand — and since they are the largest objects in the crop they
were dragging `sat_mean` and `lab_b` down. Re-authored to 0.045-0.245 at R:B ~1.7.
