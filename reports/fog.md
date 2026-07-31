# fog — report (Wave H)

Owned file: `src/render/passes/volumetricFog.js`. All numbers from `tools/capture.mjs
--pose <p> --settle 48` + `tools/metrics.py` / `tools/roi.py`, driven by
`tools/_fogab.mjs` (new) so every arm of an A/B is captured **consecutively in one batch**.

**Retraction from the Wave-E version of this file:** it opened by telling everyone to
measure with `HALO_NO_DAEMON=1` on a stale-module-cache theory. KNOWN_ISSUES 19 tested that
directly and it is **false**; the workaround costs one Chrome per agent and OOMed the box.
Do not use it. The symptom behind it was a module that failed to parse and was skipped
silently (KNOWN_ISSUES 20) — run `node tools/parsecheck.mjs` instead.

Still true, and still the thing to watch: fifteen-plus agents are editing `src/` right now.
Numbers from different batches are not comparable. Grep every capture for
`passes not loaded`.

---

## 0. Headline

`volumetricFog` now owns aerial perspective for every opaque surface and for the water;
`sky.js` owns the sky; `materialCommon`'s `wmAerial` is switched off. The previous split
existed only because KNOWN_ISSUES 18 had destroyed the depth this pass needed, and that
blocker is closed.

At `ref_00000`, each arrangement differenced per pixel against a build with no aerial
perspective at all — the number that matters, because it says *where* the term is spent:

```
                mean    p99    max     top third    middle    bottom third
  this pass     6.45     41    127        12.11       7.11        0.15
  wmAerial     20.34    100    154        40.70      19.45        0.88
```

Whole-frame, one batch: `sat_mean` 53.59 -> **60.76** (reference 77.86), `lap_var`
474.0 -> **545.8** (reference 598.8), `lab_b` -1.94 -> **-0.46** (reference +4.67),
`lum_mean` 102.07 -> 91.08 (reference 112.19 — the one axis that got worse; 1).

Also closed: the viewmodel veil reports/depth.md 5c predicted (+61 `lap_var` on the weapon
at `ref_00600`), the 60 m `geoMaxDist` guess, and the `useNormalMask` workaround. Two
harness traps found on the way, one of which is not specific to this pass.

Cost: not measured — see 6, and the reason is memory pressure, not laziness.

### Two harness traps found by arms that disagreed with their own prediction

**1. `--config fog=false` has never switched this pass off.** `capture.mjs` /
`captured.mjs` send config values as `isNaN(+v) ? v : +v`, so a boolean arrives as the
**string** `'false'`, and the pass tested `c.fog === false`. The arm came out numerically
identical to the default (whole-frame `sat_mean` 60.60 against 59.85, inside batch drift)
instead of restoring `wmAerial`. Every `--config fog=false` A/B ever run against this pass
measured the shipped build. Now tested as `c.fog === false || 'false' || 0 || '0'`. This is
the same class of trap as reports/depth.md 7 and it is probably not unique to this pass —
**any pass whose kill switch is a boolean `--config` key has the same hole.**

**2. The first version of the ownership hand-off could not be undone.** It wrote
`ctx.config.aerialDensity = 0`. The engine renders a frame *before* `--config` is applied,
so the pass had already claimed the key by the time `fogAerial=0` arrived, and the arm
that was supposed to restore the Wave-G split silently measured a build with `wmAerial`
still off: `fogAerial=0` gave `sat_mean` 69.50 where forcing
`--config aerialDensity=0.0062` gives 52.58. Rewritten to latch `materialCommon`'s own
default out of the shared uniform block and write it back, so the knob is reversible; a
`--config aerialDensity=...` override still always wins.

Verified reproduction of the pre-Wave-H arrangement, same build, same batch:
`--config aerialDensity=0.0062,fogAerial=0` -> 102.78 / 52.58 / 463.7 against the
pre-edit tree's 102.87 / 51.83 / 472.4.

### The result

Four arms, one batch, `ref_00000`, `--settle 48`. `off2` = `--config fog=false`, which now
really does remove this pass *and* hand aerial perspective back to `wmAerial`, so it is the
Wave-G arrangement in the Wave-H build.

```
                                        lum      sat    lab_b   lap_var   score
  Wave-G: wmAerial owns surfaces      102.07    53.59   -1.94    474.0    33.18
  Wave-H: THIS PASS owns surfaces      91.08    60.76   -0.46    545.8    32.74
  no aerial perspective at all         88.12    72.22   +1.39    597.7    34.10
  reference kf_00000                  112.19    77.86   +4.67    598.8      —
```

**The decisive number is the per-pixel contribution.** Each arrangement differenced against
the no-aerial arm, in 8-bit code values, split by thirds of the frame (top = sky and the
distance band, bottom = the beach at the camera's feet):

```
                mean    p99    max     top third    middle    bottom third
  this pass     6.17     39    123        11.71       6.64        0.15
  wmAerial     20.34    100    154        40.70      19.45        0.88
```

(Those four arms are one batch, captured before the final `skyJ()` anchor fix in 2.4. The
shipped build measures 91.26 / 60.52 / -0.52 / 544.7 at the same pose, inside batch drift
of the `def2` row, and its per-pixel contribution is the 6.45 / 0.15 pair in 0.)

This is research/aerial.md 3 measured rather than argued: a correct `beta_ex` puts
**0.15 code values** on the near field — nothing — and spends its entire budget on the
distance band, while `wmAerial` is 3.3x heavier everywhere and still puts six times as much
into the foreground. There is no near-field suppression hack in this pass; it does not need
one.

`lap_var` says the same thing from the other side: 545.8 against `wmAerial`'s 474.0 with
the reference at 598.8. `wmAerial` destroys 124 points of image detail; this pass destroys
52. Same for `sat_mean` (60.76 vs 53.59, reference 77.86) and `lab_b` (-0.46 vs -1.94,
reference +4.67).

**Look at the two frames, not just the table** — `shots/fogH/ownership_sbs.png`, the two
arrangements side by side at `ref_00000`. Under `wmAerial` the Forerunner bridge and both
cliff faces are washed to near-white: the bridge's ribs and the rock's material are simply
gone at ~150-250 m, which is the "smearing the distance band it exists to create" claim in
a form no mean can express (docs/TARGETS, "Means are not an image"). Under this pass they
are legible, and the near beach is identical in both.

**Where `wmAerial` wins, and why I am not chasing it: `lum_mean`.** 102.07 against my 91.08
and a reference 112.19. It buys that luminance with the unnormalised in-scatter pedestal
research/aerial.md 0 documents — a term that is present in every direction including
anti-solar and is not bounded by the sky radiance. A physically correct aerial term is
close to luminance-neutral on a surface: it *replaces* surface radiance with sky radiance
rather than adding to it. The frame being 21 points darker than the reference is real, but
it is not this pass's to fix, and closing it with a fake in-scatter floor is exactly the
circular calibration KNOWN_ISSUES 4 warns about. `score` prefers the no-aerial arm (34.10)
over both — which tells you the score is currently dominated by that luminance deficit, not
by whether aerial perspective is right.

### The J-identity test — J is the clear sky, and clouds are the exception

`--config fogDensity=0,fogDebug=3` paints `skyJ()` over the sky pixels and nothing else, so
it can be differenced against `--config fogDensity=0` through the identical tonemap. If `J`
is the sky radiance the two frames must be the same image.

```
d02 vs d0j          full  mean 4.53  max 165
  clear sky patch (0.02-0.14, 0.02-0.10)      mean  2.61  max  22
  clear sky patch (0.23-0.41, 0.03-0.15)      mean  6.86  max 121
  patch containing cloud (0.42-0.52, ...)     mean 33.46  max 158
  near-horizon sky under the bridge           mean 31.94  max 118
```

**On genuinely clear sky the identity holds to a few code values**, which is what earns
`fogAmbient = 1.0`. It fails in exactly two places, both understood:

1. **Clouds.** `cloudComposite` runs before this pass, so `src` on a cloud pixel is the
   cloud; `J` is the clear-sky radiance behind it. The painted frame has no clouds in it at
   all. This is a real limitation of deriving `J` from a clear-sky model, and it is
   bounded here because the aerosol species is gated off on sky pixels, so only the thin
   dust layer applies `J` there.
2. **The near-horizon sky is ~20 % brighter in `J` than the sky module draws it** (162 vs
   136 in blue). That is `skyJ()`'s elevation profile, not the samples: it is a `sqrt(el)`
   blend between one horizon sample and the zenith, and `sqrt` is a guess. See "weakest
   things left".

---

## 1. The decision: this pass now owns aerial perspective, exclusively

KNOWN_ISSUES 18 is closed. `pipe.depthTex` holds real opaque world depth for the whole post
chain (reports/depth.md). The Wave-G split — `materialCommon.wmAerial` owning aerial
perspective on every surface, this pass owning only the sky and the shafts — existed
*because* opaque pixels had no distance here. That is gone, so the split was re-opened.

**Chosen: `volumetricFog` owns extinction + ambient in-scatter + shadowed sun in-scatter
for every opaque surface and for the water; `sky.js` owns the sky; `wmAerial` is zeroed.**

The measurement that decides it, four arms captured back to back at `ref_00000`
(`shots/fogH/`), all with the *old* fog still in place so that only the ownership of the
per-surface term varies:

```
ref_00000, whole frame        lum      sat    lab_b   lap_var   score
  as shipped (both on)      102.87    51.83    -1.71    472.4    33.14
  --config aerialDensity=0   88.36    68.23    +1.21    603.9    34.11
  --config fogDensity=0     102.12    53.54    -1.88    475.9    33.19
  both off                   87.18    71.51    +1.01    616.2    33.61
  reference kf_00000        112.19    77.86    +4.67    598.8      —

ROI                    both on -> wmAerial off      reference
  horizon  lum          127.74 -> 93.71             119.51
  horizon  sat           30.92 -> 62.54              69.74
  horizon  lap_var      355.6  -> 653.1             244.8
  cliff    sat           38.50 -> 73.42              97.93
  rock     sat           56.51 -> 69.99              52.41
  sky      sat           55.10 -> 81.97              56.14
```

`wmAerial` is costing the project **16.4 points of whole-frame `sat_mean`**; this pass, as
it stood, cost 1.7. `lap_var` lands on 603.9 against a reference 598.8 with `wmAerial` off
and 472.4 with it on: it is smearing the very distance band it exists to create.

Reasons, in order of weight:

1. **`wmAerial` cannot be fixed from any file this project is allowed to hold.** Four
   independent defects in one function in `materialCommon.js`, all diagnosed in
   research/aerial.md 0: density 0.0062 m⁻¹ (Koschmieder visual range **631 m** — that is
   fog, and it is ~11x too thick), an unnormalised phase `mix(0.42, wmHG*2.6, 0.55)` that
   never falls below 0.19 in *any* direction including anti-solar, a 48 m scale height
   (a mist layer, not air), and three hand-authored in-scatter colours that cannot track
   the sky.
2. **The in-scatter colour here is the sky's own radiance** (`skyJ()` samples
   `sky.radiance()`, which is a CPU read of the sky's own sky-view LUT, not a second
   model). Distant geometry therefore dissolves into the sky instead of being outlined
   against a hand-authored grey. The reference's horizon band is bright **and** saturated
   (lum 119.5 / sat 69.7); `wmAerial` reaches the luminance by spending 39 points of
   saturation.
3. **It is shadowed and integrated**, so aerial perspective and the shafts become one
   integral. The sun-lobe double-apply that research/aerial.md 5.3 identifies — `wmAerial`
   adds an unshadowed sun lobe, this pass adds a shadowed one to the same pixels — is
   deleted by construction rather than compensated.
4. Hillaire EGSR 2020 5.4 and research/aerial.md 4.3 both recommend exactly this split for
   a pipeline that has a G-buffer, a depth buffer and a volumetric pass.

**What it costs.** Transparent surfaces other than water (bridge glazing in
`structures.js`, particles) do not write depth, so they receive the aerial perspective of
whatever is behind them. That is the standard cost of the post-pass side of the split —
Hillaire pays it too and answers it with a per-vertex term on transparents — and at these
poses it is a few hundred pixels.

### How `wmAerial` is switched off without editing a file I do not own

`materialCommon.updateAerialUniforms()` reads `ctx.config.aerialDensity` every frame, and
`ocean.js` aliases the same uniform block, so one shared key switches the per-surface term
off everywhere. This pass writes `ctx.config.aerialDensity = 0` each frame, and **stands
down permanently if it ever reads back a value it did not write** — a `--config` override
or a future owner of `materialCommon.js` wins. `--config fogAerial=0` restores the Wave-G
split in the same build.

---

## 2. What else changed, and why each of them is a re-derivation rather than a re-fit

Every constant in this file that was fitted by eye or by sweep was fitted against a depth
buffer containing only a gun. The ones below were re-derived from research/aerial.md, not
re-swept.

### 2.1 `uGeoMaxDist` (60 m) and `uUseNormalMask` — DELETED

Both existed only to stand in for the distance KNOWN_ISSUES 18 was stealing. `tEnd` is now
the depth buffer's own radial distance. Shafts no longer leak through solid geometry for up
to 60 m.

### 2.2 The viewmodel is its own class, with `tEnd = 0`

reports/depth.md 5c: after the depth fix the weapon is in `pipe.viewDepthTex` and *not* in
`pipe.depthTex`, so it classified as **sky** and had the entire layer integrated over it —
a milky veil wherever it silhouettes against sky, which is 100 % of the weapon at
`shot_beach_establishing` and 69 % at `shot_cliff_vegetation`. It is now `CLS_WEAPON`:
inside the near plane, no participating medium in front of it, nothing to integrate. The
composite's class weight also keeps the upsample from smearing the neighbouring sky's fog
value back across the silhouette. `--config fogWeaponMask=0` reproduces the regression.

### 2.3 One density became two species

```
sigma(p) = uHazeDensity * exp(-h/1200) * isGeo      // aerosol  -> aerial perspective
         + uMistDensity * exp(-h/24) * noise(p)     // local dust -> the shafts
```

They are not the same medium. The aerosol term is the marine haze that makes a sea stack at
1 km pale; its scale height is ~1.2 km (Bruneton `demo.cc`, Hillaire Table 1), i.e.
effectively constant here, and research/aerial.md 2.5 puts its coefficient at 5e-4..8e-4
m⁻¹. The dust term is the low, noisy, wind-advected layer the shafts live in, scale height
24 m. Merging them — which is what the single old `fogDensity` did — forces one to be
wrong: 24 m of scale height cannot reach a sea stack.

**The aerosol species is gated off on sky pixels** (`isGeo`), because `sky.js` already
integrates that species to infinity. That is the no-double-count rule (research/aerial.md
4.2: "applying aerial perspective to the sky would double-count"). The dust species is not
in the planetary model, so it *is* integrated in front of the sky — that is the shaft you
see against the sky.

### 2.4 `fogAmbient` 0.52 -> 1.0, and why it is not a knob

Set `s -> infinity` in the single-scattering solution: `L -> J`. So `J` is by identity the
radiance of an infinitely deep slab of the same medium — the sky radiance in that
direction (research/aerial.md 1.3). The composite is `src*T + J*(1-T)`. At `J = src` that
is exactly `src`, so a correct ambient lobe is **a no-op on the sky at any density**, and a
surface at infinity tends to the sky pixel above it instead of to a seam. Both limits break
at any value other than 1.0. 0.52 was a fit against a hand-authored `J`.

### 2.5 Exponential step spacing

`tEnd` used to be 460 m on almost every pixel; it is now the real surface distance and
spans 0.5 m to 6 km. With the old quadratic bias `t = tEnd*(0.25u+0.75u^2)` the *first
step* scales with `tEnd` — 3 m on a sky pixel, 40 m on a sea stack at 3 km — so
neighbouring pixels would sample the 46 m dust noise at completely different rates and
leave a rim along every distant silhouette. `t = tNear * grow^i` with
`grow = (tEnd/tNear)^(1/STEPS)` holds the sampling rate constant in log-distance, which is
the froxel-volume standard. Two `pow`s per pixel, not one per step. `--config fogStepExp=0`
restores the quadratic.

---

## 3. Measurement hooks added to the pass

The classification is the thing most likely to be silently wrong and it is invisible in a
finished frame, so it is renderable:

```
--config fogDebug=1                 class map: green = sky, red = world, blue = viewmodel
--config fogDebug=2,fogDbgScale=N   distance ramp, black = 0 m, white = N m
--config fogDebug=3                 paint skyJ() over the sky pixels only
```

`fogDebug=3` is the falsifiable test for 2.4: if `J` really is the sky radiance, painting
it over the sky must be a **no-op image**, and both frames go through the identical tonemap
so the comparison survives the grade.

What the class map settles, at `ref_00000` (`shots/fogH/ref_00000_cls.png`):

* **The viewmodel class covers 207 812 px.** reports/depth.md 4 counts the viewmodel at
  209 395 px at this pose from the GPU side, by a completely different route. Two
  independent instruments agree to 0.8 %, which is what says `CLS_WEAPON` really is the
  weapon and not, say, a near-plane artefact.
* **Every beach, cliff and bridge pixel is `CLS_WORLD` with a real distance.** Under
  KNOWN_ISSUES 18 this map was a flat sky field with the rifle cut out of it
  (`shots/fog/dbg4.png`). That is the whole difference this wave is built on, in one image.
* **The sea plane still changes the classification of 2 796 px (0.135 %) at this pose** —
  small only because the sea is a sliver under the bridge here; see the `ref_01500` numbers
  below. `pipe.depthTex` is written once by the opaque pre-pass and `ocean.js` renders with
  `depthWrite: false`, so water is in no depth buffer at any point in the frame. The
  analytic plane is still the only thing that gives the sea a distance, and it is now
  carrying more weight than before, not less: it is what gives the water its aerial
  perspective now that `ocean.js`'s aliased `wmAerial` copy is switched off with the rest.

---

## 3b. The viewmodel veil, measured and removed

reports/depth.md 5c predicted this pass would haze the weapon once the depth fix landed,
because the weapon left `pipe.depthTex` and therefore classified as sky. `ref_00600` is the
pose it flagged (16 % of weapon pixels have sky behind them). `--config fogWeaponMask=0`
reintroduces it in the same build:

```
ref_00600, weapon ROI        lum      sat    lab_b   lap_var
  masked (shipped)          92.16    80.84   -9.23    466.7
  unmasked (the bug)        97.37    72.03   -9.68    405.8
  reference                 98.98    78.09  -10.45    198.8

full-frame diff, masked vs unmasked:  mean 1.29  max 162
  rock region  max 0      sky region  max 0      sand region  max 3
```

The veil was worth 5.2 `lum_mean`, 8.8 `sat_mean` and **61 points of `lap_var`** on the
weapon — it was washing out the receiver detail — and the diff is *exactly zero* outside the
weapon, which is the check that the mask is a mask and not a global change.

Note that `score` prefers the unmasked frame (22.92 vs 22.15). It is wrong to follow it
here for the same reason as in 1: the whole frame is short of the reference's luminance, so
anything that adds light scores better. The physical statement — the viewmodel is inside
the near plane, there is no participating medium in front of it — plus the 61 points of
recovered detail is the argument.

## 4. Shafts: still structured, still not a frame lift

`fogShafts=0` A/B at `ref_00000`, differenced per pixel against the shipped default in the
same batch:

```
  mean 1.51   p99 11   max 25   |  top third 3.57   middle 0.95   bottom third 0.02
```

The contribution is *structured*, not a wash (`/tmp` diff map: bright in the sky gap beside
the cloud deck, following the bridge underside and its edges, zero on the open beach). It
reads the shadow cascades. Whole-frame cost of the term: `sat_mean` 1.88, `lum_mean` 0.97.

Mitchell's rule (GPU Gems 3 ch. 13, quoted in research/aerial.md 5.2) is that occlusion is
an **attenuation of the source**, so shafts can only ever darken relative to the unoccluded
integral. That is what this is: the sun lobe is integrated over the dust with per-froxel
CSM visibility, not added as a screen-space decal.

## 4b. The sea plane, reassessed — still required, but it now matters much less

The brief asked whether the analytic ray/sea-plane intersection is still the right call now
that water could in principle be depth-tested. It is, and the reason is not inertia:
`pipe.depthTex` is written **once**, by the G-buffer opaque pre-pass, and `ocean.js` renders
with `depthWrite: false`. Water is therefore in no depth buffer at any point in the frame,
before or after KNOWN_ISSUES 18 (reports/depth.md 8.6 states it; the class map at
`ref_00000` confirms it from this pass's own side — 2 796 px flip from world to sky when
`fogSeaPlane=0`).

What *has* changed is the cost of getting it wrong. `ref_01500` (a water-heavy pose),
`fogSeaPlane=0` against the default in one batch:

```
                     full-frame diff        water ROI sat    water ROI lum
  sea plane off      mean 0.26  max 103     45.67 (+2.31)    108.92 (+0.81)
```

Under the Wave-E arrangement, a sea pixel that fell through to "sky" had the entire 460 m
layer integrated in front of it **on top of** `ocean.js`'s own aliased `wmAerial` copy — a
double count over a third of the frame. Now `wmAerial` is off everywhere and the aerosol
species is gated off on sky pixels, so a misclassified sea pixel loses a term instead of
gaining a duplicate. The plane is now load-bearing for the *opposite* reason: it is the only
thing that gives the sea a distance, and therefore the only thing giving the water any
aerial perspective at all.

## 5. Determinism

Two `--pose ref_00000 --settle 48` captures of the shipped build are **byte-identical**
(`cmp` on the PNGs). The noise field is a pure function of `ctx.clock.t`, never an
accumulator, which is what makes that true across a daemon page that has already served
other captures.

## 6. Cost — NOT measured, and why not

Added since the previous version: one extra `pow` pair per pixel for the exponential step
spacing (two total, not one per step); one extra density evaluation term (a second `exp`,
~4 ALU) per march step; one extra full-resolution `tViewDepth` fetch per `fogClassify()`
call, of which the composite makes five (centre + four taps). Removed: the G-buffer normal
fetch in both shaders, and the whole `uUseNormalMask` branch. Net: roughly ten extra
full-resolution texture fetches per pixel's worth of work in the composite, against ~10 M
pixels; nothing in the march's inner loop grew by more than a handful of ALU.

`tools/_fogperf.mjs` (new) is the instrument: one page, one pose, arms alternating in
blocks of individually-timed frames, because reports/depth.md 6 measured **2.7 ms of
block-to-block drift within a single arm** — two separate captures cannot resolve anything
this pass costs. **I did not run it.** It spawns its own vite + Chrome, and the box was at
13 GB of 15 GB used with 1 GB available when I got to this step; KNOWN_ISSUES 19 records
that exact configuration OOMing the machine at 17 agents. Running it would have risked
other agents' work to produce a number, so it is left for whoever has headroom:

```
node tools/_fogperf.mjs --pose ref_00000 --arms "on=;off=fog=false" --block 90 --blocks 2
```

Note that arm compares *arrangements*, not just this pass: `fog=false` removes both of this
pass's draws and hands aerial perspective back to `wmAerial`, which is per-fragment ALU in
every world material including overdraw.

## 7. Weakest things left, in order

1. **`J` overestimates the near-horizon sky by ~20 %.** `fogDebug=3`, patch just above the
   sea line: `src` (136.4, 107.8, 93.8) against `J` (165.4, 136.0, 120.4). That is the one
   direction where distant geometry is most visible, and it means a sea stack dissolving
   into the horizon will land slightly *above* the sky it should match — the outlining
   failure J exists to prevent, in miniature. Anchoring the interpolation at the sampled
   elevation (this wave) cut the fraction of sky pixels that disagree at all from 47 % to
   19 % but did not move this patch. The next experiment is a second radiance ring at
   el ~ 0.15-0.4 with piecewise interpolation instead of one `sqrt` guess between the
   horizon and the zenith; three more CPU `radiance()` calls, free, and the prediction is
   that this patch's diff drops below 10 codes. If it does not, the horizon *sample* is
   wrong rather than the profile, and that is a question for `sky.js`.
2. **`J` is the clear sky, so cloud pixels get pulled toward clear sky.** Bounded, because
   the aerosol species is gated off on sky pixels and only the thin dust layer applies `J`
   there, but it is a real error wherever haze sits in front of a cloud deck. The fix is
   for `J` to sample the *composited* sky (the buffer this pass already reads as `tSrc`)
   in the ray's direction rather than a CPU model — a screen-space lookup at the ray's
   projected far point, which is what a sky-view LUT would give for free.
3. **`uAmbGround` is the last hand-authored colour in this pass**, and the ownership change
   made it load-bearing: most geometry is below the horizon, so `skyJ()` returns a blend
   toward it. It is currently the horizon ring averaged and pushed 20 % warm. It should
   come from the real ambient (`env.irradianceAt(+Y)`), and the reason it does not is that
   `env`'s units are three's light units while `sky.radiance()` is in the atmosphere
   model's — the same unreconciled unit systems that make `fogShafts` a calibration
   constant (below).
4. **`fogShafts = 0.25` is still unfalsifiable.** `time.sunIntensity` is a
   `DirectionalLight` intensity and the sky's radiance is in its own units with its own
   `solarIrradiance`; nobody has reconciled them, so the physically correct
   `phase x irradiance` is roughly an order of magnitude hot against the sky this engine
   draws, and 0.25 absorbs the difference. Until someone reconciles those two scales, the
   shaft magnitude is a fit, not a derivation. Everything else in this pass now is a
   derivation.
5. **Transparents other than water get the aerial perspective of what is behind them.**
   The cost of the post-pass side of the split (research/aerial.md 4.1). Hillaire answers
   it with a per-vertex term on transparents; here it is bridge glazing and particles, a
   few hundred pixels. If someone wants it, the clean fix is for `materialCommon` to keep
   `wmAerial` **for transparent materials only** and for this pass to keep owning opaques —
   which is exactly UE's split, and which the `fogAerial` knob does not currently express.
6. **The density was not fitted, and could not honestly be fitted at these poses.**
   `fogDensity = 0.00055` m⁻¹ comes from research/aerial.md 2.5 (Koschmieder V = 7.1 km);
   the dust adds 70 % of that at sea level, for V = 4.2 km near the ground. Fitting it
   against `ref_00000` would be fitting to a frame whose camera sits between two cliffs
   while the reference looks down an open beach — the geometry is not the same scene yet
   (KNOWN_ISSUES 3), and docs/TARGETS "Means are not an image" is the standing warning
   against exactly that. The number to re-check once the poses are fitted is the `horizon`
   ROI's `lap_var`: the reference is 244.8 and every arrangement we have is 350-670, i.e.
   the reference's distance band is far softer than anything this project renders.

## 8. Files touched

* `src/render/passes/volumetricFog.js` — the pass (owned).
* `tools/_fogab.mjs` — new. Back-to-back multi-arm A/B: captures every arm consecutively
  through the shared daemon and prints one whole-frame + per-ROI table.
* `tools/_fogstats.mjs` — new. Recomputes that table from PNGs already on disk.
* `tools/_fogperf.mjs` — new. Interleaved same-page cost A/B (written, not run — 6).

No file outside `src/render/passes/volumetricFog.js` was edited. `materialCommon.js` is
imported read-only, for the shared uniform block it already publishes to `ocean.js`.

## 9. Citations

- `research/aerial.md` — 0 the `wmAerial` diagnosis, 1.2 the closed-form single-scattering
  solution, 1.3 `J` = sky radiance, 2.5 the recommended coefficients, 4.2/4.3 the ownership
  rule and the recommendation for this pipeline, 5.3 the sun-lobe double-apply.
- Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*,
  EGSR 2020 — https://sebh.github.io/publications/egsr2020.pdf (5.4 application rule;
  Table 1 Mie scale height 1.2 km; exponential froxel slices).
- Hoffman & Preetham, *Photorealistic Real-Time Outdoor Light Scattering*, GDM Aug 2002 —
  https://renderwonk.com/publications/gdm-2002/GDM_August_2002.pdf (Eq. 1/3/4; the
  extinction/visibility table).
- Mitchell, *Volumetric Light Scattering as a Post-Process*, GPU Gems 3 ch. 13 — occlusion
  as an attenuation of the source, i.e. shafts can only ever darken.
- Íñigo Quílez, *Better Fog* — https://iquilezles.org/articles/fog/ (the height-exponential
  analytic integral).
