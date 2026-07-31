# vegetation — rework pass 2 (owner: `src/world/vegetation.js` only)

Every number below came from a PNG this renderer wrote, via `tools/capture.mjs`. Tooling
added this pass: `tools/_vegmask.py` (foliage-hue mask H 25-48 / S>60 / V>25 on OpenCV
hue units, plus row-band / named-ROI / pixel-box stat blocks) and `tools/_vegprobe.mjs`
(landmark screen positions across all nine scored poses, and per-mesh instance
projection).

---

## THE HEADLINE, AND IT IS NOT IN THIS FILE

**`src/gfx/materialCommon.js`'s `wmAerial()` erases ~97% of this subsystem's output, and
its density is physically wrong by roughly an order of magnitude.**

Measured at `ref_00720` on the centre sea stack (pixel box x720-1020, y240-640). One
build, one pose, one settle; only `--config aerialDensity` changes between rows:

| aerialDensity | sat_mean | lap_var | edge_density | lum_std | p01 | foliage-hue % |
|--------------:|---------:|--------:|-------------:|--------:|----:|--------------:|
| 0.0           |  101.5   |  706.2  |  0.1986      |  30.4   |  13 |  **17.64%**   |
| 0.0004        |   77.8   |  575.7  |  0.1809      |  26.8   |  36 |    9.76%      |
| 0.0010        |   61.0   |  446.4  |  0.1441      |  23.3   |  57 |    5.31%      |
| 0.0020        |   49.0   |  321.5  |  0.0890      |  20.1   |  73 |    0.82%      |
| **0.0062 (shipped)** | **45.1** | **201.9** | **0.0407** | **14.7** | **75** | **0.000%** |

Whole-frame foliage-hue coverage at `ref_00720`: **0.025% shipped**, **4.96% at
aerialDensity 0.0004**, against the reference's **4.38%**. With a plausible haze this
subsystem now lands *on* the reference's foliage coverage. With the shipped value, not one
pixel of the frame reads as plant matter.

`uAerialDensity = 0.0062` /m is an extinction coefficient. Koschmieder gives a
meteorological visual range of `3.912 / β` = **631 m**. That is fog. `kf_00000` and
`kf_00720` both show islets and a horizon kilometres out with contrast intact, in direct
sun — the art direction implies β on the order of 1e-4, i.e. **15-60x lower**. At the hero
stack's 90 m the pass's own analytic integral gives t = 0.30: a 30% mix toward a bright
near-neutral inscatter, which is enough to take a sat-101 canopy to sat 45.

Arithmetic consequence, stated flatly: at t = 0.30 the observed chroma retention is 0.45,
so reaching the `rock` ROI's sat 86.6 would require a source saturation of ~190/255.
**No albedo this file can author reaches the ROI targets while aerialDensity is 0.0062.**
I did not chase it with false colour, because the fog will eventually be fixed and those
colours would then be wrong.

### Corrections to `docs/KNOWN_ISSUES.md` §8

§8 currently says the desaturation "is volumetricFog, not albedo". Measured:

- `--skip volumetricFog` produces a **byte-identical PNG** to the shipped build at
  `ref_00720` (`--skip bloom` differs at byte 44, so the skip mechanism itself works).
  That pass writes zero pixels at this pose and cannot be the cause of anything here.
- The cause at this pose is `wmAerial` in `src/gfx/materialCommon.js`, per the sweep
  above. §8's *correction* names the wrong file, in the same way its original diagnosis
  named the wrong file. It is the same failure mode both times: a plausible story adopted
  without the one-flag experiment that separates the candidates.

**Escalation:** whoever owns `src/gfx/materialCommon.js` should take `uAerialDensity` from
0.0062 to ~2e-4 - 5e-4 and re-measure. The A/B is one flag and 20 seconds.

---

## What changed here, and what it bought

### FIRST: the renderer is non-deterministic again, and it is not this module

Two back-to-back captures of the identical build at `ref_00720` differ in **50.0% of
pixels**, whole frame. With `--skip vegetation` they still differ, in **38.5%**. The
critic's verdict recorded determinism as "byte-verified" — that no longer holds, so
something landed between then and now. This is blocking for everyone: it puts a noise
floor under every A/B in the project. Three identical `--skip vegetation` captures of the
`rock` ROI:

```
lap_var        103.14 / 107.21 / 115.28     spread 12.1
edge_density   0.0172 / 0.0180 / 0.0236     spread 0.0064
local_contrast 0.0357 / 0.0370 / 0.0443     spread 0.0086
foliage-hue %  0.000  / 0.000  / 0.000      spread 0
```

Every delta below is reported against the **mean of those three**, and anything inside the
spread is called out as inside the noise. The foliage-hue mask is the one statistic here
that is unaffected, which is part of why it is the headline metric.

### Shipped build, shipped aerial — the honest scored number

`--skip vegetation` isolation at `ref_00720`, `rock` ROI, vegetation's own contribution
(baseline = mean of the three OFF captures above):

| | before (critic) | after | noise floor |
|---|---:|---:|---:|
| lap_var        | **+3.99**    | **+52.1** (108.5 -> 160.6) | ±12.1 |
| edge_density   | **+0.00033** | **+0.0067** (0.0196 -> 0.0263) | ±0.0064 |
| local_contrast | **+0.00005** | +0.0004 (0.0390 -> 0.0394) | ±0.0086 — **inside noise** |

lap_var is a real 13x improvement in contribution and well clear of the noise;
edge_density is a genuine but marginal 20x; local_contrast is **indistinguishable from
zero** in the shipped build. Absolute: lap_var 160.6 against the reference frame's 236.7,
edge 0.0263 against 0.0613, lc 0.0394 against 0.0884. Foliage hue in the ROI is still
0.000%. All three of those ceilings are the aerial term — see the control-haze table
immediately below, where the same build clears them.

### Control haze (aerialDensity 0.0004) — what the geometry and materials actually are

`rock` ROI at `ref_00720`:

| | veg OFF | veg ON | reference |
|---|---:|---:|---:|
| lap_var          | 136.95 | **269.08** | 236.67 |
| edge_density     | 0.0209 | **0.0473** | 0.0613 |
| local_contrast   | 0.0460 | **0.0546** | 0.0884 |
| sat_mean         | 95.78  | 94.50      | 107.46 |
| lab_b            | -17.73 | **-14.60** | -7.17  |
| spectral_slope   | -1.466 | **-1.301** | -1.323 |
| **foliage-hue %**| 1.098  | **7.431**  | **7.962** |

Foliage coverage in the box this subsystem exists to fill goes **0.000% -> 7.43% against a
reference 7.96%**, and the spectral slope lands within 0.02 of the reference's — the
"isotropic speckle" reading is gone.

Row-band foliage coverage at `ref_00000` (the shipped build the critic measured was
**0.000%** below y=720, contradicting the previous report's "Problem 3 FIXED"):

| rows | before | after (control) | reference |
|---|---:|---:|---:|
| 0-120    | 0.000 | 15.06 |  6.82 |
| 120-240  | 0.000 |  6.25 |  9.88 |
| 240-360  | 0.001 |  5.18 |  7.58 |
| 360-480  | 0.180 |  3.90 |  6.35 |
| 720-840  | 0.007 |  0.04 |  0.47 |
| 960-1080 | 0.065 |  0.16 |  1.24 |

Whole frame at `ref_00000`: 3.42% against the reference's 3.85%. (Rows 0-120 overshoot:
that band is a distant cliff top in our composition and open sky in the reference's.)

---

## Problem 1 — placement latched onto other modules' coordinates. FIXED.

Root cause confirmed by probe, not argued. At `ref_00720` the landmark `stack_hero`
projects to screen **(178, 276)** — the top-left corner — while the stack that fills the
`rock` ROI is `stack_arch` at **(848, 339)**. Prominence over all nine scored poses, as
apparent crown radius in px and number of poses seen from:

```
headland 198px/4v   stack_arch 152px/8v   stack_hero 68px/5v   stack_twin_a 61px/4v
stack_twin_b 44px/3v   stack_far_a 31px/8v   stack_far_b 19px/8v
```

`stack_hero` is the **fourth** most prominent crown in the frames we are graded on. The
name is a label in `rocks.js`, not a statement about the composition, and pinning the hero
tree to it was the whole defect.

**Fix.** `buildScoredViews()` builds the nine `ref_*` view-projection matrices from
`poses.js` at init; `seenBy()` and `apparentPx()` answer "can a scored camera see this,
and how big is it".

- **Trees** are sited by measured prominence, not by id. Every landmark crown any scored
  camera sees at >= 14 px of crown radius gets a tree; >= 55 px gets the hero species,
  scaled `clamp(crownRadius / 5.2, 0.90, 2.10)`. `console.error` if none is visible.
  21 trees, 4 hero.
- **Ground scatters** draw from a rasterised accept region: a 3 m grid over
  x[-300,300] z[-280,200], sampled once against the height field and against `seenBy`.
  27,987 cells survive. Grass, scrub, shelf and vine bands are filters on that list.
  A band gated this way cannot be emptied by another module's terrain edit.
- **Drapes** are placed on `rocks.surfacePoint(id, u, v)` — the rock's own
  parametrisation — and accepted on visibility. The shipped ivy band (hardcoded `z 50..76`
  plus a height-field scan) placed **64 cards out of a 2600 budget**; it now fills
  3200/3200 and `console.warn`s below half.

Two further placement bugs found by probe and fixed:

1. `topPoint()` called `rocks.surfacePoint(id, u, v)` with **u and v both uniform**. That
   entry point is the **face** parametrisation (v runs base-to-rim), so the "crown moss
   mat" was scattered evenly down the entire stack — this is the isotropic speckle the
   critic measured at spectral_slope -1.78. `rocks.crownPoint(id, u, r)` is the cap
   parametrisation and now carries everything that belongs on a crown.
2. The tree sat at radial fraction 0.30-0.58 of the cap "so the trunk breaks the
   silhouette". Every scored camera stands at y = 1.74 and every crown is at y = 30-44, so
   **we look at every stack from below** and the near half of the cap is occluded by its
   own rock. Probe: the tree base projected to (847, **377**) with the rock's silhouette
   top at y ~= 295, so the entire 12 m tree finished ~3 px *under* the rim. Trees now sit
   at radial fraction 0.05-0.27, on the cap's high point.

## Problem 2 — foliage has no chroma. FIXED in this file; capped outside it.

The critic's cause (b) does not hold in the shipped build, and this is now settled by
experiment rather than by reading the source: zeroing the transmission term entirely (with
aerial disabled so the result is not buried) moved the crown box **sat 60.59 -> 48.57 and
foliage coverage 10.81% -> 2.47%**. Transmission was *contributing* chroma, not diluting
it — a previous pass had already made `uTransColor` chromatic (0.44, 0.48, 0.125), and the
brief was quoting `makeVegMaterial`'s default rather than the canopy's override. Recorded
so nobody re-derives it.

What was actually wrong, and is fixed:

- `uTransColor` is now a genuine leaf transmittance, `lin(0.30, 0.42, 0.050)`: R below G,
  B near zero, because chlorophyll passes green and absorbs blue almost completely.
- The AO gate on transmission is **inverted**: `mix(1.0, 0.30, vAO)`. It was
  `mix(0.30, 1.0, vAO)` — exposed shell leaves transmitted most and buried interior leaves
  least, which is backwards and flattened the crown from both ends.
- The lobe goes into `totalEmissiveRadiance` scaled by `(1 - NdotL^2)`, not into
  `reflectedLight.indirectDiffuse`. Anything added to indirectDiffuse is a floor under
  every fragment in the mass, and front-lit fragments must not receive a backlight term
  at all.
- **`reflectedLight.indirectSpecular *= uSpecScale * vegAO`** (0.30-0.45). F0 0.04 against
  a very bright sky probe is an additive, achromatic term on a mid-tone diffuse — one of
  the few things in this shader that can only ever reduce saturation — and the probe does
  not know the card is buried inside a canopy.
- Palette re-measured off the reference and written into the file, replacing the header's
  "olive khaki" claim, which was right about hue and wrong about chroma. Foliage-masked
  `kf_00720`: tree crown mean sRGB (121,123,70) at **sat 116**, stack scrub shelf
  (70,70,36) at **sat 133**, cliff drape (93,88,53) at sat 120. Our vegetation pixels,
  isolated by a `--skip vegetation` diff, measured mean sRGB **(111,113,114) at sat 32** —
  literally grey, with B above R.

## Problem 3 — one atlas for four species, sampled at the wrong alpha reference. FIXED.

- `LEAF_ALPHA_REF = 0.42` and `BLADE_ALPHA_REF = 0.30` are the single source of truth:
  every `buildAlphaMips` call and every consumer's `alphaTest` reads them. The shipped
  build built the chain at 0.5 and sampled it at 0.42, so **every mip level gained coverage
  with distance** — the exact inverse of the failure Castano's chain exists to prevent, and
  why distant foliage read as a solid speckled carpet.
- `assertAlphaRef()` runs from `makeVegMaterial` and `console.error`s on any mismatch,
  because this class of bug is invisible until someone measures a distant crop.
- Three distinct atlases where there was one: the compound leaf sprig (canopy, scrub,
  shelf); `makeMossAtlas`, a fine radiating cushion of short curled hairs; and
  `makeRunnerStrip` — the old vine generator, parametrised — run twice, as a long thin
  fall with leaves tapering to nothing (vine) and as a short broad runner with leaves held
  to the tip (ivy).
- `matIvy` darkened ~2x with B pushed down: `lin(0.180,0.184,0.060)` ->
  `lin(0.098,0.118,0.019)`. The reference drape is a dark warm-green mass (lum 61, sat
  142, lab_b +13.6); ours was a light cold dusting (lum 120, sat 28, lab_b -5.1).

## Problem 4 — crowns painted flat, never breaking a silhouette. FIXED.

- `clumpGeometry` is now **normalised**: x,z in [-0.5,0.5], y in [0,1], so `aOri.z` *is*
  the plant's height in metres and `aOri.w` its width. It was not normalised before, which
  is why `sY = sc*0.55` produced 0.55 m pancakes on crowns that needed a 4 m silhouette —
  and nothing at the call site made that visible. A `bulge` parameter shapes the mass
  along y; cards are placed on the golden angle so there is no azimuthal ringing.
- The stack crown is now a **shelf**: 15-card clumps 1.4-3.7 m tall on `crownPoint`, with
  radius biased hard outward (`rr = 0.62 + 0.52*u^0.55`, so most of the mass is in the
  outer third and some hangs past `rr = 1.0`), dropping as it overhangs so the lip reads
  as a rolled edge. ~4,475 shelf clumps; a thinner lichen mat covers the flat centre.
  Visually confirmed at `ref_00720`: the stack head is a ragged green mass cutting the
  rock's profile against the sky, with ivy falling down the shadowed face — the reference's
  composition, which the shipped build did not have at all.
- The ivy card orientation was **transposed**: `aOri.z` (fall length) was 0.38-0.77 m and
  `aOri.w` (width) 1.4-4.2 m, i.e. a 4 m wide, 0.6 m long shingle. Now 1.3-3.0 m long by
  0.55-1.10 m wide, tilted 2.8 rad so it hangs down the face.
- The cliff moss no longer smears over 40 m of face at slope 0.42-0.95; it is a
  crown-relative band on visible lip cells.

## Problem 5 — ground grass. FIXED.

- Placement comes from the visible-cell list, and the "is this the back beach" gate is a
  **quantile of the terrain's own height distribution within the same distance band**, not
  a number in metres. A fixed `s.y > 1.2` emptied this scatter when terrain.js re-profiled;
  its replacement `s.y > 0.05` went the other way and carpeted the swash zone, where the
  reference has none. A quantile can do neither: by construction the top 55% of visible dry
  ground always passes, wherever the height field puts it. Measured floors this build:
  near 5.26 m, mid 9.92 m -> 1,096 near + 5,179 sward cells. (First attempt took the
  quantile over *all* visible cells and read 62.77 m, because the cliff plateau dominates
  the cell count, and emptied the beach again. Per distance band it reads the beach's own
  profile — worth knowing before someone repeats it.)
- The whole 172k blade budget now lands within 95 m of a scored camera instead of being
  spread over ~48,000 m2 of mostly-invisible back-beach; tufts are 24-52 blades in a
  0.10-0.24 m radius so neighbours merge into a mat instead of reading as islands of
  dowels.
- **Shadows on** for `matGrass`, with its own `makeVegDepthMaterial` carrying identical
  placement and wind. The previous pass left them off "for cost"; the cost argument does
  not survive the measurement.
- `makeBladeAlpha`'s envelope was `half = 0.5*min(1, (1-v)/0.20 + 0.06)` — clamped to
  **full width for the bottom 80% of the blade**, so the mask was a rectangle with a point
  stuck on the tip and alphaTest 0.30 never carved a taper. Now `half = 0.5*(1-v)^0.55`.
- `matGrass` warmed toward straw: `lin(0.330,0.262,0.115)/lin(0.196,0.190,0.070)` ->
  `lin(0.375,0.278,0.068)/lin(0.205,0.172,0.042)`.

## Problem 6 — isotropic sprigs, flat crown, dowel trunk. FIXED.

- `emitSprig` used `th = U(0,2pi)`, `ph = acos(U(-1,1))` — a correct uniform distribution
  on the sphere, and exactly wrong for foliage. It now takes an optional `frame` and
  samples a cone of half-angle 0.42-0.55 rad about a preferred axis; `buildTree` supplies
  the branch tip's own direction blended toward -Y by `gravBias` 0.55-0.58, which is what
  produces a canopy's layered light/shade banding instead of a confetti ball.
- `uBaseAO` for the canopy is 0.10, and a fraction of the occlusion is folded into
  **albedo** as well (`uAlbedoAO` 0.34). The header rejected this on a measurement taken
  when the interior-to-sunlit ratio was 1.34; re-run with the corrected transmission the
  crown still measured p01 40 / lum_std 30.4 against the reference's 19 / 51.6.
  Indirect-only cannot darken a leaf the sun hits directly, and a crown interior is full of
  those. `vAO` is now a real hull-distance estimate (`shellAO`), not the shell-depth
  parameter.
- **`canopyR` is measured from the branches**, not declared: the 88th percentile of tip
  distance x 1.32. It was a magic 4.0 while the branching threw tips out to ~8 m, so the
  leaf shell filled a ball half the size of the armature and the outer limbs stuck out as
  bare grey spars — visible as two spikes either side of the crown in the shipped
  `ref_00720` capture.
- The sprig budget scales with crown **area** (`shellSprigs * (canopyR/P.canopyR)^2`).
  Fixing the count while the radius is measured means a bigger crown is a thinner crown;
  at the shipped 900 over a 7 m radius you could see cloud through the hero crown.
- Trunk: per-branch radius modulation, two harmonics along the branch (`bulge` 0.13-0.15),
  so the tube bulges and pinches. A constant-taper tube is a dowel at any distance.

---

## Cost

Whole frame at `ref_00720`, 1920x1080, with grass shadows now on: **9.41 ms / 106 fps**,
33.2M triangles submitted, 110 programs. Grass casting is not a frame-time problem.

`vegetation` init **141 ms -> 231-271 ms** (for scale: terrain 812 ms, rocks 1507 ms).
The increase is the one-time accept-region
rasterisation (27,987 `world.sample()` calls on a 3 m grid) plus the denser crowns; it is
init only, with no per-frame cost. Triangles 1.65M -> 2.38M, draws 11 -> 12. If init time
becomes a problem the cell step is one constant (`CELL = 3.0`; 4 m halves the cost).

## Weakest things left

0. **The renderer's non-determinism** (38.5% of pixels with vegetation disabled). It is
   not mine, it is new since the critic's pass, and it makes every measurement in this
   project approximate. Whoever owns the region it moves in should treat it as blocking.
1. **The aerial term.** Everything at the top of this file. Until `uAerialDensity` comes
   down, this subsystem contributes ~3% of what it actually renders.
2. Even under the control haze the `rock` ROI's `local_contrast` is 0.055 against the
   reference's 0.088 and `edge_density` 0.047 against 0.061, while the stack *box* alone
   overshoots lap_var (576 vs an ROI 237). The distribution of detail is still wrong —
   plenty in the crown, too little on the rock between the crowns — and the rock half of
   that is not mine.
3. The hero crown is lopsided; `lump()` plus the branching RNG puts most of the mass on one
   side. The reference tree is asymmetric too, but less so.
4. `matBark` has no normal detail, so at 90 m the trunk reads as a dark shape rather than
   as bark. Small fraction of the frame, went last, did not get done.
