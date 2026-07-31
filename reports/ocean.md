# ocean — Wave I (post depth-fix)

Owned file: `src/world/ocean.js` only. The Wave-H revision is preserved as
`reports/ocean_waveH.md`; everything in it about the sea state, the Beer-Lambert
re-derivation and the reflection prefilter still stands.

> **Measurement hygiene.** Fifteen-plus agents are editing `src/` right now. During this
> session `sky.js` and `rocks.js` were both un-parseable for ~90 s and `volumetricFog.js`
> took ownership of aerial perspective mid-session (5). Every capture went through a guard
> that **fails the measurement if any module or pass reports `not loaded`**
> (KNOWN_ISSUES 20); it fired three times, and each would otherwise have been a number
> from a build with no sky in it. Every A/B is fully specified on both arms —
> `--config a=..,b=..` on *both* — because a partially-specified arm inherits whatever the
> other one set. The final A/Bs are byte-identical on repeat (`mean 0.00000 max 0`).

---

## 0. HEADLINE — the premise of this wave's brief is false for this file, and it is proved

The brief says my refraction path consumed the broken depth buffer and that every constant
fitted against it is suspect by construction. `reports/depth.md` 5g says the same:

> "`ocean.js:1952` copies `pipe.depthTex` into its own `depthRT`... **It was copying a
> gun.** It now copies the terrain under the water... Re-fit against it."

**That is not what happened. `ocean.js` has never seen the broken buffer.** KNOWN_ISSUES 18
was a bug in `scene.js` **step 7**; the water is drawn in **step 5**. The ocean resolves
`pipe.depthTex` from `onBeforeRender`, i.e. two steps before the viewmodel's `clearDepth()`
runs. Nothing in the refraction, the shallow-water ramp, the shoreline wetness or the foam
proximity needed re-fitting, because none of them was ever fitted against a gun.

Three independent witnesses:

**1. Structural.** `src/render/passes/scene.js`:

```
step 1  line  79   gbuffer                       <- writes pipe.depthTex
step 5  line 105   sceneRT, LAYER.TRANSPARENT    <- THE WATER DRAWS HERE
                   ocean.js onBeforeRender copies pipe.depthTex -> depthRT
step 7  line 147   sceneRT, clearDepth(), vm     <- the bug lived here
```

Every consumer §18 actually damaged (`dof`, `motionBlur`, `taa`, `volumetricFog`,
`cloudComposite`) is a **post** pass and runs after step 7. The ocean is not a post pass.

**2. Direct measurement of the thing the bug would have destroyed.** `--config oceanDbg=1`
(new, 3) paints each water pixel by where its refracted background comes from: MAGENTA if
`bgIsSky` — the depth buffer held nothing behind it, so the bottom is the synthetic
`oc_fallbackBottom()` — GREEN if it is real geometry read out of `tOpaque`. If the ocean
read the gun-only buffer, **every** water pixel would be magenta, because a cleared depth
buffer is 1.0 everywhere. `ref_01800`, two arms back to back, where `--config
vmLegacyDepth=1` is the depth agent's own same-build knob for reinstating §18 in full:

```
                          magenta px   green px   fallback fraction
  depth-fixed (shipped)       15 145    686 009        2.16 %
  --config vmLegacyDepth=1    15 073    685 593        2.15 %
```

**3. The two maps are the same map.** XOR of the magenta masks between the arms: **262 px
out of 15 145** (1.7 %), all on the antialiased boundary between the classes. The ocean's
depth input is bit-stable across a knob that empties the depth buffer for everyone
downstream of it.

A whole-image diff between those arms is **not** a valid test of this and I did not use it
as one: under `vmLegacyDepth=1` the viewmodel never writes `pipe.viewDepthTex`, so
`clouds.js` (which reports/depth.md 5d repointed at that texture) loses its weapon mask,
and the ocean composites `clouds` into its reflection prefilter. That is why witness 2 is a
*classification of the ocean's own input* rather than a diff of its output.

**Action for whoever owns `reports/depth.md` / KNOWN_ISSUES:** strike 5g. It is the only
wrong claim in an otherwise excellent report, and it is the one that would have sent this
wave re-deriving constants against a change that did not happen.

---

## 1. THE REAL BUG FOUND THIS WAVE: the reflection prefilter was punching black holes in
## the sea, and they were being scored as contrast

Found by chasing an A/B that would not reproduce. `--config oceanReflBlur=1.0` gave
`water lum_std` 14.07 in one battery and 27.54 in the next, with `p01` 77 vs **4** and
`shadow_frac` 0.0006 vs **0.046**. That is not drift, it is two different images.

Looking at the crop instead of the number: hard-edged **pure black patches** in the water
beside the sea stacks (`shots/oc3_X_r1.png`). Near-black fraction of the water band:
**0.805 %**.

Mechanism, confirmed by experiment. `REFL_PREFILTER_FRAG` composites `clouds` into the
half-res copy of the frame and writes it straight into an RGBA16F target with a full mip
chain, unclamped:

```glsl
c = cl.rgb + c * cl.a;          // no bound of any kind
oCol = vec4(c, 1.0);
```

A single non-finite or wildly out-of-range texel is then averaged into **every mip level
above it**, and the water samples those levels wherever the surface is rough. Two
separating experiments, run in this order:

* **clamp the level selection.** `lod` capped at 6 -> black fraction 0.729 % (barely
  moved); capped at 4 -> **0.002 %**. So the poison lives in levels 5 and up, i.e. it is
  cumulative up the chain, not "sampling past the end of the chain".
* **sanitise the source instead and leave the level selection free.** NaN/Inf killed and
  the value clamped to [0, 64] *before* the chain is built -> **0.002 %** at
  `uReflBlur = 1.0` with `lod` unclamped. Cause removed, not symptom.

Both shipped: the sanitisation is the fix, and `uReflMaxLod = 8` stays as a cheap guard
against ever sampling past the real top of the chain. NaN is not ordered, so `clamp()`
alone cannot be trusted to remove it — the test is explicit.

**Why this matters beyond the artefact:** those black pixels were worth **+10 of water
`lum_std` and +0.04 of `local_contrast`**, both metrics this module is being judged on and
both of which it is far under. A reader looking at the numbers alone would have scored a
mip-chain artefact as the structure the water is missing. This is the third time in this
file's history that a number was measured against something that was not water.

---

## 2. `uReflBlur` 1.0 -> 0.25 — the reflection was being blurred toward its own mean

With the poison gone the sweep is clean and monotone. `ref_01800`, one window, both arms
fully specified, `water` ROI:

```
  uReflBlur       1.0     0.5    0.25     0.1   --skip ocean   kf_01800   SIGNATURE
  lum_std       14.07   14.85   15.93   16.89       17.61       45.41       40.96
  local_con     .0403   .0433   .0471   .0504       .0463       .1497        .142
  lap_var       232.3   268.2   328.4   405.5       401.2        1376       676.6
  edge_dens     .0373   .0436   .0534   .0707        .098       .1968        .109
  sat_mean      40.52   41.54   41.57   42.00       58.32       60.62       69.72
```

The whole triple (`lap_var`, `local_contrast`, `lum_std`) rises **together** and `lap_var`
stays well under the signature at every value — the signature of structure, not of hash.
Contrast the SSR march still in this file, which bought `lap_var` 408 -> 4802 for +0.002
`local_contrast`.

The analytic form `lod = log2(rough * pxPerRad * uReflBlur)` fixes the *shape* of the level
selection and does **not** fix this constant: "the lobe's rms angular width" and "a
trilinear mip fetch's support" differ by a factor of two in each direction depending on
which convention you pick. So it is measured, and the file carries the sweep.

I stopped at 0.25 — a 4x reduction, the point where the module roughly stops *destroying*
the region's detail (`lap_var` 328 against 401 for the empty scene, versus 232 at 1.0).
Lower measured better on every static metric at both poses with no far-field aliasing
penalty (`ref_00000 water lap_var` 1436 -> 1419 from 1.0 to 0.02); the two reasons not to
go there are a two-capture temporal probe 0.05 s apart, which put the `lap_var` of the
frame-to-frame **delta** at 175 (blur 1.0) against 300 (blur 0.02), and that below ~0.1 the
prefilter stops being a prefilter and the far-field glitter regime it exists for is not
exercised by either pose in my battery.

---

## 3. NEGATIVE RESULT, kept and flagged: the optical column must NOT come from the depth
## buffer, and the reason is the tap

This is the change the brief points at, I made it, and **it measured worse at the pose that
actually looks at shallow water.** It is off by default behind `--config oceanDepthColumn=1`
with the whole argument in the file.

The idea. `column = P.y - oc_seabedY(vFlat)` is analytic: the depth of water directly under
this bit of surface, from a 768x768 resample of `terrain.height()` over 680 x 390 m, i.e.
**0.89 x 0.51 m cells**. The depth buffer holds the true bed at full resolution and the
shader already has it in `bgPos`, so taking the optical column from there looked free and
strictly better — it would carry every cobble and rock the bathymetry grid smooths away.

They disagree almost everywhere. `--config oceanDbg=6` (new) paints GREEN where the two
agree within 0.20 m, RED where the real bed is deeper, BLUE where it is shallower, YELLOW
where there is no geometry behind the pixel. `ref_01800`:

```
  GREEN   agree within 0.20 m                    0.07 %
  RED     real bed DEEPER by > 0.20 m           61.1 %
  BLUE    real bed SHALLOWER by > 0.20 m        38.8 %
  YELLOW  no geometry behind (synthetic bed)     0.03 %
```

and the map (`shots/oc3_F_map.png`) is broad coherent shore-parallel banding, not noise.

**But the depth-derived number is the wrong one, and the buffer is not at fault — the tap
is.** `bgPos` is read along the **unrefracted camera ray**: `roff` corrects only the
wave-tilt part of the offset, not the base air->water bend, which is what every real-time
water shader does. At grazing incidence the camera ray travels ~11 m horizontally per metre
of drop where the refracted ray travels 1.13 m, so the tapped bed is up to **10x further
out** and therefore much deeper than the column the Snell path is entitled to. The bottom
term dies and the water falls back to deep colour plus reflection.

Isolated at `shot_water_edge` — the pose that puts the camera in the shallows — one window,
`uReflBlur` held fixed in both arms, `water` ROI:

```
                analytic   depth-derived   SIGNATURE
  sat_mean         57.42          44.97        69.72
  lab_b           -7.643         -6.539       -7.875
  lum_std          14.90          15.12        40.96
```

**12.4 points of saturation and 1.1 of `lab_b`, both away from the signature, to buy +0.2
`lum_std`.** At `ref_01800` the same change was a small win (+1.05 `sat_mean`); the pose
that looks at shallow water settles it. Reverted to opt-in.

To make it work you have to reconstruct the bed at the point the **refracted** ray lands
on, not the point the camera ray lands on — one Newton step against the bathymetry, or a
short march. Until then the analytic column is the one *consistent with the Snell path*,
precisely because the refracted ray can only travel 1.13 x its depth horizontally and
therefore does hit the bed nearly straight below the surface point.

---

## 4. Coordination with `volumetricFog` — checked, and there is no double-apply

`reports/fog.md` (Wave I, landed mid-session) moves aerial perspective wholesale into that
pass and **writes `ctx.config.aerialDensity = 0` every frame**. `ocean.js` applies a
verbatim `wmAerial()` to the water surface using `sharedAerialUniforms()` — the *same
uniform objects*, not a copy. So `uAerialDensity` is 0 in my shader too, `c0 = 0`,
`integral = 0`, `t = 0`, and `mix(color, inscatter, 0)` returns `color`. The ocean's aerial
term is off **by arithmetic**, not by agreement.

Fog's analytic ray/sea-plane intersection (`seaHitDist`) is still needed and still correct:
`pipe.depthTex` excludes water by design (water is `depthWrite: false`, and
reports/depth.md 3 lists that as an invariant), so the sea is the one surface class the
fixed depth buffer still cannot supply a distance for. **The depth fix does not retire it.**

**I therefore changed nothing here, deliberately.** Deleting my `wmAerial()` call would look
tidy and would break `--config fogAerial=0`, fog's documented same-build knob for restoring
the Wave-G split — under that flag `aerialDensity` returns to 0.0062 and the water must pick
its own term back up, at exactly the same rate as the rock standing in it. The call site
stays; the shared uniform decides. That is the arrangement that cannot double-count in
either configuration.

---

## 5. Before / after — measured, both arms fully specified, one window

`inherited` = `--config oceanReflBlur=1.0,oceanReflMaxLod=16` (the Wave-H constants).
`shipped` = defaults. Repeat captures of both arms are byte-identical.

```
ref_01800  water ROI      --skip ocean   inherited   shipped   kf_01800   SIGNATURE
  lum_std                       17.61       13.96     15.74      45.41       40.96
  local_contrast              0.04633     0.03929   0.04618     0.1497       0.142
  lap_var                       401.2       237.6     326.8       1376       676.6
  edge_density                  0.098     0.03697   0.05221     0.1968       0.109
  sat_mean                      58.32       39.52     40.63      60.62       69.72
  lab_b                        -12.72      -8.263    -8.143     -3.014      -7.875
  spectral_slope               -1.884      -1.877    -1.780     -1.955      -2.436

ref_01800  shoreline ROI
  lap_var                       438.6       322.5     365.7      914.9       695.6
  edge_density                 0.1135     0.06824   0.07452      0.166       0.127
  lum_std                       26.57       28.64     28.85      41.96       42.69
  local_contrast              0.09115      0.1011    0.1017      0.142        0.15
  sat_mean                      44.74       42.09     42.03      50.62       69.31

ref_01800  sand ROI            unchanged to 3 s.f. on every metric

shot_water_edge  water ROI     unchanged (this pose's roughness never selects a high mip)
shot_water_edge  shoreline     unchanged
```

Whole-frame delta, shipped vs inherited at `ref_01800`: mean 0.754, p99 14, max 64 — it is
a water-only change, as it should be.

Read honestly: **+13 % `lum_std`, +18 % `local_contrast`, +38 % `lap_var` and +41 %
`edge_density` in the water, all moving together and all still far under the signature**,
plus +1.1 `sat_mean` and `lab_b` moving 0.12 toward it. The one metric that moved the wrong
way is `spectral_slope`, -1.877 -> -1.780 against kf_01800's -1.955: the recovered energy
is higher-frequency than the reference's. That is the honest cost of un-blurring a
reflection and it is the thing to watch if someone pushes `uReflBlur` lower still.

And the black-hole fix (1) is not visible in this table because at `uReflBlur = 0.25` the
level selection no longer reaches the poisoned levels — its measured effect is at the
inherited setting, where it removes 0.805 % of the water band that was pure black.

---

## 6. Cost

Nothing was added to any per-pixel path that was not already there:

* prefilter sanitisation — three `isnan`/`isinf` pairs and one `clamp`, **once per
  half-res texel** (960x540), not per water pixel;
* `lod` clamp — one `clamp`;
* `uReflBlur` 1.0 -> 0.25 selects a *lower* mip, i.e. a **larger** texture read with worse
  cache behaviour; that is the only term that could cost anything and it is one
  `textureLod` either way;
* the diagnostics are dead branches on a uniform that is 0 in every shipping capture;
* `columnOpt` is off by default and compiles to `columnOpt = column`.

No new draw call, no new target, no new fetch, no vertex change. Not separately timed —
nothing in `tools/` exposes a GPU timer and the box was running a dozen concurrent captures
all session, so any `ms` figure would be noise. That remains worth someone's half hour.

---

## 7. Diagnostics now in the file

```
--config oceanDbg=1            seabed SOURCE map: magenta = synthetic fallback,
                               green = real geometry behind the water
--config oceanDbg=2            force the synthetic seabed everywhere
--config oceanDbg=3            body only    (Fresnel mirror forced off)
--config oceanDbg=4            mirror only  (Fresnel forced to 1)
--config oceanDbg=5            Fresnel F as greyscale
--config oceanDbg=6            columnOpt vs column disagreement map (3)
--config oceanDepthColumn=1    optical column from the depth buffer (3, measured worse)
--config oceanReflBlur=        roughness-cone scale (2)
--config oceanReflMaxLod=      ceiling on the selected prefilter mip (1)
```

They are the reason 0 and 1 are proofs rather than arguments, and they cost one branch on a
uniform each.

---

## 8. What they found that I did not fix — read this before touching a colour constant

Run at `ref_01800`, one window, `water` ROI:

```
                     on     body only   mirror only    kf_01800   SIGNATURE
  sat_mean         37.97       51.51         32.65        60.62       69.72
  lum_std          15.36       18.92         17.48        45.41       40.96
  local_contrast  0.04709     0.06369       0.04894      0.1497       0.142
```

and forcing the synthetic seabed everywhere (`oceanDbg=2`) moved `water sat_mean`
37.97 -> 29.02 and `lum_std` 15.36 -> 14.33 — **replacing the entire refracted bottom with
a completely different bottom barely moves the water.**

The effective Fresnel weight, recovered per pixel from the three arms as
`(on - body)/(mirror - body)`:

```
  just below the horizon   median F 0.857
  mid water                median F 0.586
  near field               median F 0.250
  water ROI overall        median F 0.645
```

That is exactly the profile a low camera over water must have, so **the Fresnel is right
and the water genuinely is ~65 % mirror over this ROI by construction.** Which means the
reflection is the only lever that can move this region, and no amount of retuning
`uExtinction`, `uScatterCol` or the seabed will do it. `--skip ocean` -> ocean on still
takes `water sat_mean` from 58.32, within 2.3 of the reference's 60.62, down to 40.63,
because the thing being mixed in at 65 % is a smooth pale sky.

---

## 9. Weakest things left, in order

1. **The reflection has no structure, and that is now measured rather than asserted (8).**
   The reference's water gets its `lum_std` (45.4 against our 15.7) and essentially all of
   its `shadow_frac` (0.0206 against 0.0006) from **dark reflected sea stack**. Wave H
   proved a per-pixel screen-space march is not the way (`lap_var` 408 -> 4802,
   `spectral_slope` -1.14 = white noise; still in the file behind `oceanSSR=1` with that
   measurement in the comment). What it needs is a *filtered, temporally stable* resolve —
   a mirrored-camera planar reflection of the stacks only, or a reflected-ray hit resolved
   at the prefilter's half resolution and mipped like everything else in that path, so a
   miss costs a blurred neighbour rather than a black pixel. **Note that this is the same
   failure mode as 1**: an unfiltered term that produces hard black where it fails.
2. **`spectral_slope` is the metric that says how far `uReflBlur` can go** (-1.780 against
   kf_01800's -1.955 at 0.25, -1.761 at 0.1). Anyone lowering it further should watch that
   and the frame-to-frame delta, not `lap_var` alone.
3. **The depth-derived optical column is a real idea with a fixable defect (3).** Reconstruct
   the bed at the refracted landing point — one Newton step against `oc_seabedY` — and the
   61 %/39 % disagreement becomes usable instead of biased.
4. **`highlight_frac` is still 0.0** at `ref_01800` against kf_00000's 0.0247. Wave H rebuilt
   the glitter lobe on Karis's representative-point sun disc with the correct angular floor
   and it still does not clip. Next step is not more reasoning about the lobe: log `spec`,
   `ndl`, `aX`, `aZ` at a known fragment — `oceanDbg` now has the plumbing — and find out
   whether `spec` survives at all, whether the 420.0 clamp bites, or whether the tonemap
   eats it.
5. **The waterline is still a polygon.** `P.y` is a vertex quantity, so its crossing of the
   bed is a straight segment per triangle, ~22 px at 3 m. Wave H measured that widening the
   feather is decisively the wrong trade (shoreline `local_contrast` 0.156 -> 0.093). The
   real fix is a per-pixel waterline: recompute the displaced height in the fragment shader
   over the shallow band.
6. **Caustics are still not shadowed** (research/ocean.md failure mode 21). No shadow sampler
   is bound to this material; water does not go through `applyWorldMaterial`. Plumbing the
   cascades in touches `materialCommon.js`, not my file.
7. **`uEdown`'s `uSkyAmbient * 2.6`** is still the one underived number in the water column,
   and it sets the absolute level of both the synthetic seabed and the deep-water term.
   Unchanged from Wave H.
