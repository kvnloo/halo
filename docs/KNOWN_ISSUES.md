# Known issues

Live defects and coordination hazards. Anything here is real and reproducible; fix it
deliberately, not opportunistically.

---

## 1. Motion vectors are computed against mismatched projections — CRITICAL, COUPLED

**Where:** `src/render/passes/scene.js`, the G-buffer pre-pass setup.

```js
gbufMat.uniforms.uCurrViewProj.value
  .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);  // JITTERED
gbufMat.uniforms.uPrevViewProj.value.copy(pipe.prevViewProj);       // UN-jittered
```

`RenderPipeline.render()` applies the Halton sub-pixel jitter to `cam.projectionMatrix`
*before* the scene passes run, while `pipe.currViewProj` / `pipe.prevViewProj` are both
built from `unjitteredProj`. So `uCurrViewProj` carries the jitter and `uPrevViewProj`
does not, and every motion vector in `gbuffer.textures[1].rg` inherits a ±½ px
per-frame error even when nothing in the scene is moving.

**Impact.** For motion blur a half-pixel is negligible. For TAA it is not: feeding that
velocity into the history lookup random-walks the resolve by half a pixel every frame,
which is permanent, unrecoverable blur — exactly the failure that would show up as a
`detail` and `spectrum` regression and be misattributed to the TAA implementation.

**Correct fix:** use the un-jittered `pipe.currViewProj` for `uCurrViewProj`, so both
matrices are jitter-free and the velocity is exactly zero for static geometry.

**Why it is not just fixed:** `src/render/passes/taa.js` already works around it. That
pass derives reprojection from depth (unprojecting with the *jittered* inverse view-proj,
which is exact for the pixel as rasterised, then re-projecting through the un-jittered
matrices), and consults the G-buffer velocity only where the two disagree by more than
1.5 px — applying a `+0.5 * uJitter` correction when it does. **That correction assumes
the bug is present.** Repairing `scene.js` without removing the compensation in
`taa.js` replaces one half-pixel error with a different one.

**Therefore:** these two files must be changed in the same commit, by one person, with a
determinism check and a `detail`/`spectrum` measurement either side:

```bash
node tools/capture.mjs --pose ref_01500 --out shots/mv_before.png --settle 48
# ... edit scene.js AND taa.js together ...
node tools/capture.mjs --pose ref_01500 --out shots/mv_after.png --settle 48
.venv/bin/python tools/metrics.py --stats shots/mv_before.png
.venv/bin/python tools/metrics.py --stats shots/mv_after.png   # lap_var must not drop
cmp shots/mv_after.png <(second identical capture)             # must stay deterministic
```

Found by the TAA implementer during Phase 1. Deferred until Phase 1's critic round
finishes, so the review is not run against a moving target.

---

## 2. Scene incomplete — expected, tracked here so it is not re-reported

As of Phase 1 only `time`, `lighting`, `sky`, and the `tonemap`/`grade`/`taa`/`bloom`
passes are implemented. `terrain`, `rocks`, `ocean`, `clouds`, `structures`,
`vegetation`, `props`, `particles`, `player`, `weapons`, `ai`, `hud`, `audio`, `env`
and the remaining post passes are stubs that render nothing.

Consequences that are **not** bugs right now:

- Captures show a flat clear-colour plane below the horizon. That is the clear, not ground.
- The `sky` ROI measures far below its target (`lap_var` 27 vs 253) because clouds supply
  most of a sky's tonal structure. See the caveat in `docs/TARGETS.md` about regions
  being fixed screen rectangles rather than semantic masks.
- `structure` and `perceptual` are near zero at every pose, because the geometry that
  would match the reference framing does not exist yet.

## 3. Poses are unfitted

`src/world/poses.js` was authored by hand from `docs/WORLD.md`. `tools/fitpose.mjs`
exists to refit them, but must only be run against a **complete** scene — see the
"Fitting the poses" section of `docs/ARCHITECTURE.md`. Applying a fit invalidates every
previously recorded score.

---

## 4. Circular calibration — a methodology trap, not a code bug

Phase 1's grade was fitted by pushing `ref/keyframes/*.png` through the grade LUT and
minimising against the reference signature. Every statistic it reported was therefore a
property of *the reference clip*, not of anything this engine renders. Captured through
`tools/capture.mjs`, the same build measured `lab_b` −24.2 against a claimed +1.35, and
`sat_mean` 97.7 against a claimed 84.1.

Worse than being wrong, it pointed the defaults the wrong way: saturation was raised to
1.10 because the *reference* was short on chroma, while the actual render was already
14–18 units over — so the grade amplified its single largest error.

**Rule.** A calibration is only valid if its input distribution is a frame this engine
produced. Fit against `tools/capture.mjs` output. If you report a number, it must have
come from a PNG the renderer wrote — never from a reference frame you transformed.

This generalises: any subsystem that tunes itself against the reference rather than
against its own output is measuring the target instead of the work.

---

## 5. Post-chain order corrected — TAA now resolves before bloom/DoF/motion blur

`src/render/pipeline.js` originally registered `bloom, motionBlur, dof, taa`, so bloom
was fed a jittered, un-resolved image and its threshold test fired on different
sub-pixel highlights on every jitter phase — highlights crawl and sparkle frame to
frame. Fixed to `taa, dof, motionBlur, bloom`; `docs/ARCHITECTURE.md` updated to match.

Verified deterministic across two full-pipeline captures at `diag_sky` after the change.
Note this is evidence at one pose, not a proof across all of them — the Phase 2
integration pass re-checks determinism at every scored pose.

Anyone tuning bloom, DoF or motion blur against measurements taken **before** this
change should re-take them; their input image was different.

---

## 6. The grade cannot be finally calibrated until the scene is complete

Phase 1's grade refine improved the whole-frame statistics while making the sky region
measurably worse:

```
sky ROI      before     after    target
sat_mean      94.40    117.91     87.05     +31 over, was +7
lab_b        -18.05    -29.54    -15.07     -14 off, was -3
lum_std       21.10     16.82     44.92
```

The cause is structural, not a mistake by that agent. At Phase 1 the frame is roughly
60% sky and 40% flat placeholder clear-colour where the ground will be. Optimising the
**whole-frame** average against a reference whose lower half is warm sunlit sand forces
the grade to push the only content that exists — the sky — away from its own target, to
compensate for a warm region that is not there yet.

This is the circular-calibration trap in a second costume: fitting against a frame that
is not the product. Last time the input distribution was reference footage; this time it
is a render that is 40% placeholder.

**Therefore:**

1. Treat the current grade defaults as provisional. They are approximately right in
   hue and roughly right in exposure, and that is all they need to be for other
   subsystems to be built and judged against them.
2. Any agent tuning the grade before terrain, ocean and clouds exist must measure the
   **`sky` ROI**, not the whole frame, and say which it used.
3. The grade gets a final calibration pass after Phase 3, against complete frames at all
   eight scored poses, using `tools/capture.mjs` output as the input distribution.
   Schedule it; do not let it be done early and quietly.

The same caution applies to exposure, bloom threshold and anything else keyed off
whole-frame luminance statistics. `p01 75 / p99 162 / shadow_frac 0 / highlight_frac 0`
in the current build are not grade failures — there is genuinely nothing dark or
specular in the scene yet.

---

## 7. Sky: critic fixes applied by hand (Phase 1 refine agents were cut off)

The Phase 1 refine agents failed on a session usage limit, so the sky critic's fixes
were applied directly. Measured on the ring band (box x695-748, y120-430 at ref_00720):

```
                    before    after    target
ring band lap_var   2481.5    844.3    568.0
ring band std         26.0     35.0     42.9
ring band max          228      231      252
gas giant chroma      19.4     32.6     30.8   <- on target
sun peak               243      255      255   <- clips, drives bloom
frame frac>224     0.00013  0.00064  0.00457
```

**Done:** gas-giant limb haze confined to the outer disc (was bleaching 76% of the
mid-disc into sky), narrow terminator, separate limb thread, +80% chroma at constant
luma, two extra detail octaves; aurora moved after the haze mix and narrowed; cirrus
rotated per-region with a sheet mask and strength cut 0.175 -> 0.060; ring continental
scale fixed (one noise period spanned 1100 km against a 520 km band), sea colour
darkened, cloud tops allowed to clip, haze thinned so seas are not lifted.

**Still short:**
- Ring `lap_var` is 844 against 568 — still ~1.5x too much high-frequency energy, and
  `std` 35.0 against 42.9 means it is still short on large-scale structure. The band is
  ~55 px wide on screen for 520 km (~9.5 km/px), so anything finer than ~30 km aliases;
  the remaining excess is probably that, not real detail.
- `frac>224` 0.00064 against 0.00457 — the frame still has 7x too little clipped energy.
  Expected to close on its own once water glints, wet sand and cloud tops exist; do not
  chase it by raising exposure while the scene is empty.
- The ring reads as "camouflage" more than orbital terrain at this distance. Wants
  coherent coastlines rather than isotropic blobs — a river/erosion pass, or advecting
  the continental field along the band, would help more than another octave.

A methodological note on my own error here: the first three measurements used a box
that clipped sky at the corners, so `min` read 91-99 and looked stuck no matter how far
the sea colour was darkened. That is exactly the failure documented at the top of
`docs/TARGETS.md` — regions are screen rectangles, look at the crop before believing
the number.

---

## 8. Scene renders blown out and desaturated — ALBEDO, not exposure

First full-scene capture with terrain, rocks, structures, vegetation and the viewmodel
present (`shots/preview/preview.png`). Measured at `ref_00000` against `kf_00000`:

```
                  ours       ref     delta
lum_mean        148.42    112.19    +36.22
p50             163       116       +47
sat_mean         33.62     77.86    -44.24     <-- the real problem
lab_b            -5.58      4.67    -10.26
lap_var         402.23    598.76   -196.52
```

**Saturation has collapsed to 43% of the reference.** The sheet shows why: sand, rock and
the Forerunner alloy are all rendering near-white. That is an albedo authoring problem in
the material modules, not a tonemap problem.

Proof it is not exposure: bisecting `exposureEV` moves luminance but barely moves chroma.

```
EV  0.0   lum 148.4   p50 162   sat 32.4   lap 302
EV -0.8   lum 126.2   p50 138   sat 39.3   lap 385
EV -1.6   lum  13.2   p50  15   sat 98.8   lap   8      <-- see below
reference lum 112.2   p50 116   sat 77.9   lap 599
```

Halving exposure buys 7 saturation points against a 44-point deficit. Correct fix is in
the material modules: **real sand albedo is ~0.20-0.25 linear, not 0.7+**, wet sand is
darker still, and the reference's `sand` region measures `sat_mean` 69 with `lab_b` +2.8.
Dry beach sand is a warm mid-tone, not a white surface.

### 8b. `exposureEV` has a discontinuity between -0.8 and -1.6

A 0.8-stop change should scale luminance by ~0.57 (126 -> ~72). It produces 13.2 — an
order of magnitude too dark, with saturation jumping to 98.8. Something in
`tonemap.js` (probably the interaction between a pinned `ctx.config.exposure` and
`keyedExposure()`) is discontinuous. Reproduce:

```bash
node tools/capture.mjs --pose ref_00000 --config exposureEV=-0.8 --out /tmp/a.png --settle 40
node tools/capture.mjs --pose ref_00000 --config exposureEV=-1.6 --out /tmp/b.png --settle 40
.venv/bin/python tools/metrics.py --stats /tmp/a.png
.venv/bin/python tools/metrics.py --stats /tmp/b.png
```

Fix this before anyone tunes exposure, or they will be tuning against a broken control.

### 8c. Ordering

Do **not** recalibrate the grade against these frames yet — see issue 6. Fix albedos
first, then 8b, then recalibrate the grade once, against complete frames.
