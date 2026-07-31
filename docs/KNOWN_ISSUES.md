# Known issues

Live defects and coordination hazards. Anything here is real and reproducible; fix it
deliberately, not opportunistically.

---

## 1. Motion vectors are computed against mismatched projections — FIXED, ALL FOLLOW-UPS CLOSED

> **Wave G (2026-07-30):** follow-ups 1 and 2 below are now **DONE** — see the two
> paragraphs marked FIXED and `reports/integrationG.md` §7 for the before/after
> `_mvprobe` tables. All three velocity producers (`scene.js`, `terrain.js`,
> `vegetation.js`) now write the difference of two un-jittered clip positions, and all
> three consumers (`taa.js`, `motionBlur.js`, and the G-buffer itself) flip together
> under `ctx.config.mvLegacyJitter`. Determinism re-verified bit-exact afterwards.

**Fixed** in `src/render/passes/scene.js` + `src/render/passes/taa.js`, one change, both
files. `uCurrViewProj` is now `pipe.currViewProj` (un-jittered, matching `uPrevViewProj`)
and `taa.js` no longer adds `0.5 * uJitter`. `ctx.config.mvLegacyJitter = 1` restores the
old pairing in both files simultaneously for an A/B. Full workings, measurements and the
three follow-ups below in **`reports/taa.md`**. Verify with `node tools/_mvprobe.mjs`,
which reads MRT1 back off the GPU: every static surface must report `zeroFrac 1.0000`.

Three things the original diagnosis below got wrong, all measured:

1. **There are three velocity producers, not one.** `terrain.js` and `vegetation.js` have
   their own G-buffer materials (they opt out of `scene.overrideMaterial` for vertex
   displacement). `terrain.js` was already *correct* — its `prerender` runs before
   `_applyJitter`, so it reads an un-jittered `projectionMatrix` despite a comment
   claiming it mirrors scene.js. ~~**`vegetation.js` is still wrong**~~ — **FIXED in
   Wave G.** `vVegCur` now comes from a `uCurrViewProj` uniform set in `prerender`,
   mirroring `terrain.js`. Measured at `ref_01500` with jitter `[0, -3.086e-4]`, so a
   predicted-buggy velocity of `[0, +1.5432e-4]`: FOLIAGE (matId 5) `meanY` was
   **+1.570e-04** — the jitter offset in isolation to 1.8% — and is now **+3.587e-06**,
   a 44x reduction leaving only genuine wind velocity. Every other matId byte-identical.
2. ~~**`motionBlur.js:189` applies the same `+ 0.5 * uJitter` compensation**~~ — **FIXED
   in Wave G.** It now reads `v = g1.rg + uMvLegacy * 0.5 * uJitter` with `uMvLegacy`
   driven by `ctx.config.mvLegacyJitter`, so the A/B flag flips all three consumers
   coherently. As predicted, no image change: the over-correction was ≤0.16 px of
   half-extent against this pass's own `mbMinPx = 0.60` cutoff.
3. **The claimed impact — "permanent, unrecoverable blur" — did not happen.** `taa.js`
   only consults the G-buffer velocity where it disagrees with the depth-derived one by
   >1.5 px, and the error was ≤0.707 px. Measured `gateFrac` on every static surface at
   `ref_01500`: **0**. The bug was real, exact and worth fixing; it was never reaching a
   scored still.

---

### Original report, kept for the reasoning

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

## 8. Scene renders blown out and desaturated — **CORRECTED: it is volumetricFog, not albedo**

> **This section's original diagnosis was wrong and is kept below for the record.**
> I attributed the `sat_mean` collapse to material albedo. The terrain agent disproved
> it with the right experiment: force the terrain albedo to **pure black** and re-measure
> the `sand` ROI. The desaturation persisted. An albedo problem cannot survive its own
> albedo being zero.
>
> The real cause is an **additive near-field in-scatter term in
> `src/render/passes/volumetricFog.js`**, which washes a bright, low-saturation haze over
> every surface at close range. Corroborated independently by the rocks agent: on a
> sunlit stack face, saturation goes **28.5 -> 52.5** as shipped but **28.5 -> 105.8**
> with the haze term removed, and `lab_b` goes +3.2 -> +8.5 / +17.8.
>
> `volumetricFog.js` was written in the build-only breadth wave and its critic never ran
> (killed by a usage limit), so it has never been reviewed. That is the file to fix.
>
> The albedo work done under the wrong diagnosis was not wasted — it moved whole-frame
> `lum_mean` from 98.87 to 110.48 against a reference 112.19 — but it was not the cause.
>
> **Lesson, and it is the same one as sections 4 and 6:** I reasoned from a correlation
> ("everything looks white, so the albedos must be white") instead of running the
> controlled experiment that would separate the candidates. The agent that zeroed the
> albedo and re-measured got the answer in one step.

### Original (incorrect) diagnosis follows


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

---

## 9. `ctx.config.exposure` pin has no effect

Found by the tonemap agent while fixing 8b. Pinning `exposure` across a **13x range**
produces byte-identical frames — `lum_mean` 110.51883342978395 for every value. The
`exposureEV` discontinuity from 8b is fixed (the sweep is now smooth and monotonic, with
the per-quarter-stop ratio drifting only 0.935 -> 0.905, which is AgX's own curvature),
but the absolute `exposure` pin is dead.

Note also that 8b's baseline no longer holds: EV 0 has moved from `lum_mean` 148.4 to
110.5 as the albedo work landed. Re-measure before relying on any number in section 8.

---

# Wave E integration pass — 2026-07-30

Full working notes in `reports/integration.md`. Sections 10–16 below are new.

## Status changes to existing sections

- **§8 (desaturation / volumetricFog): PARTIALLY FIXED, still open.** The fog fix moved
  whole-frame `sat_mean` 40.05 -> **57.10** against a 79.14 reference — about 44% of the
  gap. `lum_mean` **105.43** vs ref 105.40 and `p50` **105.89** are now on target, so the
  *brightness* half of §8 is closed.

  What remains is **contrast, not brightness**, and it is still the same additive haze:
  `lum_std` 35.44 vs 52.36, `p01` **+8.89** (blacks lifted), `p99` **−18.89** (whites
  crushed), `local_contrast` 0.128 vs 0.194. Both tails pulled toward the middle is the
  additive-inscatter signature.

  **Do not chase the residual `sat_mean` with grade saturation.** The tell is that `p01`
  is *lifted*; saturation cannot do that. Finish removing the near-field in-scatter term.

- **§5 (post-chain order):** the promised follow-up — "the Phase 2 integration pass
  re-checks determinism at every scored pose" — is now done, see §10. It did not hold, and
  the cause was unrelated to the post chain.

---

## 10. Program cache key was seeded from `Math.random()` — FIXED

**Where:** `src/gfx/materialCommon.js`

```js
const key = `wm:${o.matId ?? 0}:${o.inject?.key || Math.random().toString(36).slice(2)}`;
```

Every world material without an explicit `inject.key` got a **random**
`customProgramCacheKey` on every run, so the WebGL program cache keyed differently each
boot. `programs` was observed at **106 in one capture and 107 in the next** on an
identical scene, and two `--settle 48` captures of `ref_00000` differed across **45% of
the frame** (the entire ground plane; sky and viewmodel byte-identical).

**Fixed** by replacing the RNG with a monotonic counter — identical uniqueness guarantee
(no two anonymous materials collide), but reproducible, because module init order and
per-module material creation order are both fixed. Verified: three consecutive
byte-identical captures, `programs` stable at 106.

**Why this hid for so long:** determinism checks passed only because `physics` was
crashing at init (§11) and being disabled, which freed enough CPU that the race never
lost. Fixing physics exposed it. A green determinism check is not evidence of determinism
if a module is silently dead.

## 11. `physics` failed to init on every capture ever recorded — FIXED

**Where:** `src/game/physics.js:237`

```
ReferenceError: addStatic is not defined
    at Object.addStatic (src/game/physics.js:237:9)
    at collectColliders (src/game/physics.js:477:58)
    at Object.init (src/game/physics.js:225:7)
```

`addStatic` is an object-literal method on `api`, so the bare `addStatic._warned`
identifier inside it had no binding. The first malformed collider threw, and the engine
disabled the whole module. **Physics was dead in every capture and every score on
record.** Fixed to `api.addStatic._warned`.

## 12. Collider contract mismatch — rocks FIXED, structures STILL OPEN

`validCollider` (`physics.js:107`) requires `Vector3` for `sphere.center` and
`capsule.a`/`.b`, and a `Box3` on `box.box`. Audit of every producer:

| producer | type | emitted | status |
|---|---|---|---|
| props.js:804 / :859 / :1040 | sphere / capsule / box | `Vector3` / `Vector3` / `Box3` | ok |
| structures.js:1055 | capsule | `Vector3` | ok |
| **structures.js:1042, :1049** | **box** | `center`+`quaternion`+`halfExtents` | **OPEN** |
| rocks.js:544 / :757 / :1657 | capsule / box / sphere | plain **arrays** | FIXED |

**Every collider `rocks.js` produced was silently discarded** — all sea stacks, cliffs and
boulders were non-solid. Fixed (arrays -> `Vector3`/`Box3`).

**Still open — needs an owner decision, do not "fix" mechanically.** `structures.js`
emits the bridge deck and railings as **oriented** boxes. Physics has no OBB case at all:
`validCollider` rejects them and `computeAabb` cannot represent one. Converting to an
axis-aligned `Box3` would silently discard the rotation and give the bridge wrong
collision. Either add an OBB type to the physics API or have structures emit an
axis-aligned bound deliberately. The warning is left in place until then:

```
[warn] [physics] ignoring malformed collider (type="box")
```

## 13. Every frame-time number ever recorded was a structural zero — FIXED

**Where:** `src/core/Engine.js`

`stats.ms` / `stats.fps` were only updated inside `start()`'s `requestAnimationFrame`
tick. Every headless capture uses `advance(n)`, which calls `step()` directly and never
touched the accumulators — so every `perf` block in `scores/*.json` and `history.jsonl`
reads `"fps": 0, "ms": 0`.

Fixed by instrumenting `advance()`. `fps` there is derived from measured step cost rather
than counted per wall-clock second, because `advance()` has no frame pacing.

**Any perf claim made before this commit is void.** Real steady-state numbers (20 warm-up
frames discarded, 90 samples):

```
pose                     p50    p95   mean  draws        tris
ref_00000               4.90   5.60   5.04    596  13,067,200
shot_stack_gauntlet     4.70   5.20   4.76    575  12,904,456
shot_bridge_underside   5.40   8.20   6.70    638  14,354,408
shot_tide_pools         6.60   9.70   8.06    648  15,336,424
shot_hero_stack         5.90  10.80   8.93    607  14,052,200
shot_water_edge         6.00  10.90   8.53    594  13,358,768
```

Nothing exceeds 11 ms at p50. **`shot_hero_stack` and `shot_water_edge` sit within 0.2 ms
of the 11 ms bar at p95**; both are the most ocean-dominated poses, so `ocean` is the
suspect — **on correlation, not proof.** A clean `--skip` A/B on a quiesced tree is still
needed.

## 14. `--settle 48` has almost no convergence headroom

Before §10 was found, the same nondeterminism was *also* curable by raising settle: at
`--settle 200` two captures were byte-identical even with the RNG present. 48 is roughly
the minimum that converges, not a safety margin. Any async work that lands on a different
frame index will silently change the image. Treat a determinism failure at 48 as a
convergence question before assuming randomness.

## 15. The `grade` axis is a dead readout

`grade` has scored **0.00 in every run ever recorded**, including runs where it genuinely
improved. The scoring band is `band(hist, 0.25, 0.75)` — it returns 0 for any
Bhattacharyya distance >= 0.75. Wave E moved `hist` **0.889 -> 0.802**, real progress
rendered completely invisible.

Anyone tuning the grade against this axis is tuning against a flat signal. Either re-band
it to the range the project actually occupies, or read `raw.hist` directly.

## 16. Coordination hazard: concurrent agents writing `src/` during measurement

During this pass, `weapons.js`, `clouds.js`, `rocks.js`, `terrain.js`, `vegetation.js` and
`ocean.js` were all rewritten *while* captures were running — twice inside a single
determinism check. This produced findings that look real and are not:

- `terrain: Unexpected identifier 'roughnessFactor'` at "not loaded" — `terrain.js` parses
  clean now; it was caught mid-write.
- `vegetation: ReferenceError: topPoint is not defined`, and GLSL errors for `stepAt`,
  `lodAmp`, `oc_surface`, `oc_wave` — all in files being saved at that second.
- Two determinism `BROKEN` results that were just the tree changing between captures.

**Rules this implies.** A scored run or determinism check is only valid if `src/` is
quiescent for its whole duration. Check before trusting a result:

```bash
find src -name '*.js' -newermt '-10 minutes' -printf '%TH:%TM:%.2TS %p\n' | sort
```

And note the silent-corruption path: when `terrain` fails to load, `props` does **not**
fail — it warns and scatters against the `docs/WORLD.md` profile instead ("positions are
approximate"). A score run that straddles a bad terrain save produces plausible-looking
numbers from a different world.

One genuine item from that window deserves follow-up independently of the churn, because
it is a pipeline bug whenever it appears rather than a syntax error:

```
GL_INVALID_OPERATION: glDrawElements: Feedback loop formed between Framebuffer and active Texture.
```

---

## 17. Showcase sheet defects (visual, not integration) — 2 of 5 FIXED, 2 PARTIAL, 1 OPEN

> **Wave H (2026-07-30):** re-read cell by cell against a fresh sheet; full table in
> `reports/integrationH.md` §4. Per-item status is inline below. **Not closeable —
> 17.3 is untouched.**
>
> | item | status |
> |---|---|
> | 17.1 cameras under terrain | **FIXED**, and now gated by `tools/_posecheck.mjs` (28/28 ok) |
> | 17.2 ring is two thin lines | **PARTIAL** — band + inner-surface texture render; still a column, not an arch |
> | 17.3 characters in showcase | **OPEN** — still in cells 07 and 09 |
> | 17.4 sea stacks float | **FIXED** — verified at the base of `shot_hero_stack` |
> | 17.5 captions over-promise | **PARTIAL** — 03 fixed, 04/08 improved but still miss their headline effect, 12 is structurally impossible |

From `shots/preview/preview.png`, full cell-by-cell in `reports/integration.md` §2.
Highest-impact, in order:

1. **Showcase poses `shot_beach_establishing` and `shot_cliff_vegetation` put the camera
   under the terrain** — grass hangs downward, clouds sit below the ground plane, ~55% of
   the frame is flat void. 2 of 12 showcase cells.
2. **The Halo ring renders as two thin white lines** — no band, no inner-surface terrain.
   It is misread as a rendering artifact in four separate cells (04, 05, 07, 11). The
   title object of the project.
3. **Character models stand in three showcase cells** (07 shoreline, 08 waterline, 09 tide
   pools) — ~12 low-poly humanoids in the tide-pool shot. Reads as placeholder junk.
4. **Sea stacks float** — cut flat at the base with a visible gap above the water in
   every stack cell (05, 06, 08).
5. Cells `shot_water_edge` ("refraction + caustics") and `shot_weapon_detail` ("MA5B
   viewmodel") do not show the thing their caption promises.

---

## 18. The shared depth texture is cleared every frame — **FIXED (Wave H), VERIFIED**

> **Wave H (2026-07-30): CLOSED.** `scene.js` step 7 no longer clears the world's depth.
> The viewmodel got its own attachment, `pipe.viewDepthTex`, swapped onto `sceneRT` for
> that one draw and swapped back immediately after (two `framebufferTexture2D` calls, no
> copies). `RenderPipeline.js` now carries the depth contract in a header comment, and
> both attachments track size on resize. `ctx.config.vmLegacyDepth = 1` reintroduces the
> bug in full for a same-build A/B.
>
> **Verified independently** with `node tools/_depthprobe.mjs --pose ref_00000 --settle 48`
> — not by trusting the fixing agent's own numbers:
>
> ```
> depth.geoFrac        0.85704     <- was 0.10094 (the gun alone)
> gbufferGeoFrac       0.85704     <- INDEPENDENT witness: G-buffer MRT1.a,
>                                     a different attachment written by a different
>                                     pass. Agrees to five decimals.
> depth.distM          p50 1.152 m   p90 57.87 m   p99 181.2 m
>                                  <- real world distances. Before, every world pixel
>                                     read as sky at the 460 m far plane.
> viewmodel.frac       0.10098     <- exactly the OLD geoFrac. The gun rasterises
>                                     identically; it just no longer does so into the
>                                     world's buffer. Prediction confirmed.
> viewmodel.overSkyFrac  0
> ```
>
> **Downstream effects, all observed:**
> - **§8 chroma moved for the first time in three waves.** `sat_mean` 55.66 → 61.66
>   (reference 79.14). It had been going slightly *backwards*. The mechanism §18
>   predicted — 460 m of achromatic in-scatter integrated in front of every world pixel —
>   was real and is gone. Visible directly at `ref_00600` (sea stacks recover their
>   albedo and vegetation) and `ref_02220` (the cliff stops being a flat white wall).
> - **§21 closed as a side effect.** The `[dof] world path disabled: ...` line no longer
>   appears in any capture. DoF is a shipped feature again.
> - **Spectral slope is now essentially exact**: −2.533 against a reference −2.542, from
>   −2.624.
> - **Determinism re-verified bit-exact** afterwards — important, because `scene.js` now
>   mutates `pipe.sceneRT.depthTexture` mid-frame and a missed restore would drift.
> - **`ssao` and `ssr` render pixels for the first time in the project's history.** See
>   the new §28 — this is not free, and it is why the composite score went *down*.

### Original report, kept for the reasoning

**This is the real cause of the near-field haze wash in issue 8, and it is not in
`volumetricFog.js`.** Found by the fog agent in Wave E; full writeup in `reports/fog.md`.

`RenderPipeline.js:137-158` binds ONE `DepthTexture` to both the G-buffer and `sceneRT`.
`src/render/passes/scene.js` step 7 then calls `renderer.clearDepth()` on `sceneRT` so the
viewmodel can be drawn without intersecting the world. That wipes the world's depth and
refills it with the weapon alone.

Proof, one step: the fog march was made to output `vec3(isGeo, tEnd/uMaxDist, |L|)`.
`shots/fog/dbg4.png` is a flat green field — `isGeo=0`, `tEnd=uMaxDist` — with the assault
rifle cut out of it in red. The beach 4 m away, the sea stacks and the bridge all read as
**sky at 460 m**.

So every world pixel had the full 460 m of haze integrated in front of it: ~0.10-0.13 linear
of achromatic in-scatter against a lit-sand scene value of ~0.2-0.3. Auto-exposure pulled
luminance back down, so chroma collapsed while `lum_mean` looked fine. That is exactly the
signature reported independently in `reports/terrain.md` §2.

**Everything downstream that samples `pipe.depthTex` is reading the same garbage**: `dof`,
`motionBlur`, `taa` (so this is coupled to issue 1), `ssao`, `ssr`, and water refraction.
Several of those have been "tuned" against a depth buffer containing only a gun.

Fix belongs in `scene.js`: give the viewmodel its own depth buffer, or copy `depthTex`
before the clear. The Wave G motion-vector agent owns `scene.js` + `taa.js` together and is
the right owner. Do not tune any depth-consuming pass until this lands — you would be
fitting constants to a bug.

---

## 19. "The capture daemon serves stale code" — TESTED AND FALSE

`reports/fog.md` opens by instructing everyone to measure with `HALO_NO_DAEMON=1`, claiming
the daemon serves a cached module graph so that "an A/B by config looks live while an A/B by
source edit is a lie."

Tested directly: a vite server started with `HALO_NO_HMR=1` (exactly how `captured.mjs`
starts it), fetch a module, edit it on disk, fetch again. Vite re-transforms and serves the
new source. Disabling HMR turns off the *push channel*; it does not disable the watcher or
the module-graph invalidation. `captured.mjs` additionally opens a fresh page per request
with a cache-busting query param.

So the workaround is unnecessary, and it is expensive: `HALO_NO_DAEMON=1` restores one vite
plus one Chrome **per agent**, which is the configuration that exhausted system memory at 17
agents (14 GB of 15 GB used, 0 available). Do not adopt it.

The symptom the fog agent saw was almost certainly a pass that stopped *loading* rather than
one that kept running old code — a file that fails to parse is skipped silently and its
subsystem simply vanishes from the frame (see issue 20). Their own note to grep capture
output for `passes not loaded` is the right instinct; the diagnosis attached to it was wrong.

What IS true from that report: `--config` overrides work independently of source edits, and
capture warnings do get swallowed into `warnings[]`.

---

## 20. Backticks inside GLSL template literals — recurring, now gated

Three occurrences so far: `noise.js`, `ocean.js` (twice), `rocks.js`. An agent writes a
careful prose comment inside a `` /* glsl */` ... ` `` template and quotes a symbol or a flag
in backticks, as they would in markdown. The backtick ends the template. The file stops
parsing, `src/modules.js` skips the module, and **the subsystem disappears from every capture
silently** — no error in the image, just a scene with no ocean in it.

That silence is the whole problem. Wave E's ocean critic scored the subsystem 12/100 before
discovering there was no ocean in the build at all, and both Wave F and Wave G ran captures
against a tree where `ocean.js` and `rocks.js` were both dead.

Gated now: `node tools/parsecheck.mjs` checks every file under `src/` and flags this specific
hazard by looking for `/* glsl */` templates that end somewhere other than a statement
boundary or a `+` concatenation. **Run it before any measurement you intend to believe.**

In GLSL comments, use 'single quotes'.

---

# Wave F integration pass — 2026-07-30

Full working notes in `reports/integration.md` (Wave E's are archived at
`reports/integration_waveE.md`). Score **30.09**, best on record. Sections 21–24 are new.

## Status changes to existing sections

- **§8 (desaturation): brightness half CLOSED, chroma half OPEN — and the diagnosis has
  changed.** Whole-frame means over all nine scored poses:

  ```
                  ours     target   ref keyframes
  lum_mean      107.81      107.8         105.40    FIXED, delta +0.01
  p50           112.22        105          99.44    overshot +7.2
  sat_mean       55.72       83.9          79.14    NOT fixed, 28.2 short
  ```

  `sat_mean` moved **57.10 -> 55.72**, i.e. slightly *backwards* this wave.

  **Stop attributing the residual to `volumetricFog.js`.** Wave E's evidence was that both
  tails were pulled inward — the additive-inscatter signature. That is no longer true.
  `p01` is now **14.89 against a reference 15.67** (it was +8.89 *over* at Wave E), so the
  blacks are correct; only `p99` is still crushed (206.67 vs 222.11). An additive term
  lifts both ends. A correct `p01` with a crushed `p99` is a **highlight roll-off /
  exposure-shoulder** signature — `tonemap.js`, not the fog.

  Two corroborations: `lab_b` is **−6.08** against a reference −1.59 and a target of +1.4
  (an achromatic haze cannot create a chroma *bias*, only wash chroma toward zero); and the
  deficit is strongly pose-dependent (`ref_00600` 68.59 vs `ref_01500` 48.07), which a
  whole-frame haze would not be. Next experiment is a grade/tonemap chromaticity A/B
  measured on the **`sand` ROI**, not whole-frame.

  The Wave E warning still stands: do not chase this with grade saturation. It cannot fix a
  crushed `p99` or a −6 `lab_b`.

- **§12 (collider contract): NOW FULLY FIXED.** `structures.js:1148` emits the bridge deck
  as a 14-segment chain of axis-aligned `Box3` instead of an OBB, with the error bounded at
  `Lseg * sin(9.7°)` = 0.79 m per side. No `[warn] [physics] ignoring malformed collider`
  appeared in any console capture this pass.

- **§13 (perf): the numbers are void again, for a different reason — see §22.** `perf.ms`
  in `scores/*.json` is an EMA read once at the end of the run, so in an `--all` run it
  reports only the *last* pose. `waveF.json` says `ms: 5.13`; the real per-pose p50 range is
  8.3–14.1 ms. Use `tools/_perfprobe.mjs`.

- **§16 (concurrent writes): reproduced within one session of being written down.** A
  determinism check returned `BROKEN` purely because `structures.js` was saved between the
  two captures. The gate works — run it before believing any result.

- **§17 (showcase defects): 4 of 5 unchanged.** Items 1, 3, 4 and 5 are still open exactly
  as described; item 3 is now three cells with ~10 figures in the tide pools. Item 2 (the
  ring) is **partially fixed** — it is a textured band now, not two thin lines, though it
  reads as a vertical column rather than an arc. No showcase work landed this wave.

- **§18 (shared depth texture): still open, and now costing a whole subsystem — see §21.**

- **§1, §15, §20:** unchanged. §20's `parsecheck` gate passes clean (42 files).

---

## 21. Depth of field is a shipped no-op, gated off by §18

Every capture prints, verbatim:

```
[console.info] [dof] world path disabled: dofWorldDepthValid is false because KNOWN_ISSUES 18 leaves pipe.depthTex holding no world geometry (measured: every pixel returns CoC 0 and the pass is byte-identical to dofEnabled:false). Set ctx.config.dofWorldDepthValid = true the day scene.js stops clearing the shared depth texture, and re-derive dofViewmodelCoC once the viewmodel reaches the G-buffer.
```

The postfx author did the right thing — gating it off honestly beats shipping a pass tuned
against a depth buffer containing only a gun, and the re-enable condition is precise. But it
means **§18 is no longer only an accuracy problem; it has removed a feature from the build**,
on top of silently degrading `ssao`, `ssr`, `taa`, `motionBlur` and water refraction.

§18 is the highest-priority open item in the project. It is also the most likely root of §24.

## 22. Every recorded frame-time number is still wrong, in a new way — FIXED by a new tool

§13 fixed `stats.ms` being a structural zero. It is now non-zero and still not what anyone
thinks it is:

- `Engine.advance()` accumulates `stats.ms` as an EMA (α=0.1) and `capture.mjs` reads it
  **once, at the end**. An `--all` run serves nine poses from one page, so
  `scores/*.json` records the EMA at the end of the *last* pose and labels it the run's.
- A single-pose capture has the opposite bias: the EMA is seeded on a cold page, so it still
  carries shader-compile cost. `ref_00000` alone reports **11.60 ms**; `waveF.json` reports
  **5.13 ms**. Both are in the repo and they disagree by 2.3x.

Use **`node tools/_perfprobe.mjs`** — one pose at a time, 30 warm-up frames discarded, 90
individually-timed frames, p50/p95/mean. Same method as §13's table, so directly comparable.

**And note this caveat, which applies to §13's numbers too:** `performance.now()` around
`step()` measures **CPU submit cost, not GPU frame time**, because WebGL submission is
asynchronous. These numbers are comparable to each other and are not frame times. GPU timer
queries (`EXT_disjoint_timer_query_webgl2`) would fix it.

## 23. Triangle count has 2.3x'd since Wave E — `rocks` suspected, culling first

Measured steady state, all 21 poses. Two exceed 11 ms at p50; **twenty of twenty-one exceed
it at p95**.

```
pose                          p50    p95   mean     max   draws         tris
shot_stack_gauntlet         14.10  26.10  13.22   35.30     593   29,591,049   <-- over
shot_shoreline              11.50  18.60  11.05   32.80     645   32,310,093   <-- over
ref_00600                   10.90  22.60  12.34   29.00     639   32,475,489
ref_00840                   10.90  24.30  13.09   42.50     635   30,218,405
...
shot_overview                8.30  19.60  10.86   29.60     523   30,684,757
```

Same pose, same method, against §13's table:

```
shot_stack_gauntlet     p50 ms         tris    draws
§13 (Wave E)              4.70   12,904,456      575
Wave F                   14.10   29,591,049      593
                           3.0x         2.3x      +18
```

**Draw calls moved +3% while triangles moved +129%.** That is the same objects carrying far
more geometry — a tessellation/LOD change, not more scene population. `shot_stack_gauntlet`
is the most rock-dominated pose and the worst regression, and `rocks` is by far the most
expensive module to initialise (2279 ms, 2x the next). **Named on strong correlation plus a
mechanism, not on proof** — the `--skip rocks` A/B was not run because `src/` was not
quiescent.

**Check culling first.** Every pose now renders 29.6–32.5 M triangles, including
`shot_sky_ring` at 32.5 M for a shot that is mostly empty sky. A floor that high everywhere
says the geometry is not being frustum- or distance-culled, which is much cheaper to fix
than a mesh generator.

**And the extra geometry is not buying detail — it is costing it.** Over the same wave, two
independent sharpness metrics moved the wrong way: `lap_ratio` **0.9857 -> 0.7929** (Wave E
was within 1.5% of the reference; it is now 21% short) and `spectral_slope` **-2.575 ->
-2.625** against a reference -2.542. Triangle count more than doubled while the frame got
measurably *softer*. That is the signature of dense geometry aliasing into sub-pixel noise
and then being averaged away by TAA — which is another reason to look at culling and LOD
distance before anything else. Note `detail` scored **+0.75** across this, so the scoring
axis did not see it; read `raw.lap_ratio` directly.

Secondary: `ref_00120` recorded a **525.70 ms** single frame, 37x its own p50, *after* 30
warm-up frames were discarded. Everything else in the build peaks at 45 ms. A half-second
hitch is a visible freeze.

## 24. NEW — `taa` writes pure-black corruption over the ocean at `shot_sky_ring`

`shots/preview/shot_sky_ring.png` contains **7,978 pixels of exact `rgb(0,0,0)`** (0.385% of
frame) in a fixed box `y902-1035 x357-956` — a shredded band of horizontal black streaks on
the water at the far shoreline. In an AgX-tonemapped, grain-dithered frame, exact zero in all
three channels is a NaN/Inf reaching the framebuffer, not a lighting result.

**Deterministic and pose-specific.** Zero exact-black pixels in the other 20 frames captured
this pass. Two independent captures, against trees that differed in between, produced
**7,978 and 7,977** pixels in the identical bounding box.

**Bisected to `taa` by elimination** (`node tools/_blackab.mjs` — one page load, one pass
disabled per capture, via `__HALO__.togglePass()`):

```
variant                   exact-black      pct
baseline                        7,977   0.385%
ssr_off                         8,103   0.391%
ssao_off                        7,974   0.385%
cloudComposite_off              7,984   0.385%
volumetricFog_off              12,644   0.610%
taa_off                             0   0.000%   <-- artifact gone entirely
motionBlur_off                  7,977   0.385%
bloom_off                       7,986   0.385%
sharpen_off                     7,968   0.384%
grain_off                      14,814   0.714%
ocean_off                       7,978   0.385%
```

Three readings from that table:

1. **`taa_off` is 0.** No other single removal changes anything. Confirmed visually — the
   region renders as clean water, foam and wet sand with TAA off.
2. **`ocean_off` changes nothing.** The corruption is not the water geometry; it survives the
   ocean being removed, so TAA is regenerating it from history/reprojection rather than
   resolving bad shading.
3. **`grain_off` nearly doubles it (7,977 -> 14,814).** Film grain is dithering about half
   the corrupt pixels off exact zero — the true damage is ~0.71% of the frame, and **grain is
   masking the bug.** Any scan for pure black done with grain on under-counts by half.

Likely mechanism: a NaN entering TAA's neighbourhood min/max clamp poisons the clamp result,
and TAA feeds its output back as history, so it is self-sustaining. That fits it being stable
frame to frame and surviving removal of the geometry underneath.

**Coupled to two open issues.** `taa.js` samples `pipe.depthTex`, which §18 establishes holds
no world geometry at all — so TAA's depth-derived reprojection is computed from garbage
everywhere, and this pose is a grazing-angle water horizon, exactly where that produces
extreme reprojection vectors. And §1 follow-up 1 (`vegetation.js` still on the old
jittered-current convention, confirmed still present) applies to the stack crowns in frame.

Owner: whoever holds `scene.js` + `taa.js`. Fix §18 first and re-measure before anything else.

---

# Wave G integration pass — 2026-07-30

Two waves landed into one tree concurrently. Full working notes in
`reports/integrationG.md`. Score **30.30** at `--settle 48` (Wave F: 30.09).
Sections 25–27 are new. **§26 is the most important thing in this pass.**

## Status changes to existing sections

- **§1 (motion vectors): FULLY CLOSED.** Follow-ups 1 (`vegetation.js`) and 2
  (`motionBlur.js`) are fixed and measured; see the section itself. Follow-up 3 was
  already an observation, not a task. Determinism re-verified bit-exact after both.

- **§8 (desaturation): chroma half completely untouched, for the second wave running.**
  `sat_mean` **55.72 -> 55.66** against a reference **79.14**. It has now moved slightly
  *backwards* in two consecutive waves. `lum_std` is 38.04 vs a reference 52.36 and
  `highlight_frac` 0.0035 vs 0.0088 — the render carries **40% of the reference's
  specular highlight area**. Visually this is the dominant defect: everything past ~40 m
  in the showcase sheet is washed to near-white with no rock albedo left. Wave F's
  redirection of the diagnosis from `volumetricFog` to `tonemap`'s highlight roll-off
  stands; nothing acted on it. **Do not attack it before §18 lands.**

- **§12 (collider contract): still fixed.** Zero `[warn] [physics] ignoring malformed
  collider` lines in any console capture this pass.

- **§14 (`--settle 48` headroom): SUPERSEDED BY §26.** The claim "48 is roughly the
  minimum that converges" was measured on `ref_00000` and does not generalise. It is
  converged there and demonstrably *not* converged at `ref_01500`.

- **§15 (`grade` axis): unchanged, dead.** 0.00 for the ninth run in a row while `hist`
  moved 0.7934 -> 0.7876.

- **§17 (showcase defects): 4 of 5 still open, 1 now looks fixed.**
  - Item 1 (poses under the terrain): **unchanged.** Cells 01 and 10 still put the camera
    below the ground plane — pebbles on a ceiling, vegetation hanging downward, ~25-42%
    of frame flat lavender void. Two lines in `poses.js`; nobody owns it.
  - Item 2 (the ring): **unchanged from Wave F's "partially fixed"** — textured and
    striated, still reads as a vertical glass column rather than an arc.
  - Item 3 (character models in showcase cells): **unchanged.** Cells 07, 08, 09; the
    figure in 08 is the single most prominent object in a cell captioned "refraction +
    caustics".
  - Item 4 (sea stacks float): **appears FIXED.** Both stacks in cell 05 now show a
    flared talus apron entering the water; no base gap visible in 05, 06 or 08.
  - Item 5 (cells not showing what they promise): **unchanged.** Cell 08 shows neither
    refraction nor caustics; cell 12 "MA5B viewmodel" frames the rifle exactly as all
    eleven other cells do, half out of frame in the corner.

- **§18 (shared depth texture): STILL OPEN, and it was assigned to this wave.**
  `src/render/passes/scene.js:114` still calls `renderer.clearDepth()`. The section names
  "the Wave G motion-vector agent" as the right owner; that agent fixed §1 and did not
  fix this. It remains the highest-priority open item in the project.

- **§21 (`dof` is a no-op): unchanged.** The gating console line prints verbatim on every
  capture, still.

- **§23 (triangle count): WORSE, see §25.**

- **§24 (`taa` black corruption at `shot_sky_ring`): UNCHANGED, and now spreading.**
  Re-measured on this wave's sheet: **7,934 exact-black pixels in the identical bounding
  box `y902-1035 x357-956`** (Wave F: 7,978 and 7,977). The motion-vector wave did not
  touch it. New this pass: `ref_00000` shows **17** exact-black px at `y629-640
  x882-912` and `shot_shoreline` shows **6** at `y547-676 x1047-1616`. Wave F recorded
  zero in every non-`sky_ring` frame, so it has leaked into two more poses.

---

## 25. Frame time regressed across the board — 19 of 21 poses now over 11 ms

`node tools/_perfprobe.mjs --warm 40 --samples 90`, same method as §13 and §23.

```
                          waveF        waveG
p50 range            8.30-14.10   8.40-16.40
over 11 ms at p50        2 / 21      19 / 21
over 11 ms at p95       20 / 21      21 / 21
triangle range       29.6-32.5M   30.8-39.2M
draw call range         523-645      533-730
```

`shot_sky_ring` — a shot that is mostly empty sky — renders **39,062,717 triangles**.
`shot_overview` renders 30.8 M from 533 draw calls. **§23's culling hypothesis is
strengthened, not weakened:** a 30 M triangle floor in every pose regardless of content
is not a content problem.

Draw calls moved +44 on the run average. The likeliest single contributor is this wave's
`props` fix (`src/world/props.js`): it removed two region-scale `rocks.landmarks`
exclusion discs (`cliff_main` r=190, `islet_field` r=1400) that had been rejecting
**every** scatter point, so a module that previously drew literally nothing now draws its
full population. That is a correct fix with a real and expected cost.

**The `--skip rocks` / `--skip props` A/B still has not been run**, for the third wave
running, because `src/` has never been quiescent during a measurement window. It is the
single highest-value measurement nobody has taken.

### 25b. A ~400 ms frame hitch, now on 11 of 21 poses

§23 recorded one 525 ms outlier at `ref_00120` and called it secondary. It is not:

```
pose                     p50     max    ratio
ref_00120               9.20  488.30     53x
shot_sky_ring          15.70  419.30     27x
ref_00840              16.10  411.90     26x
ref_01500              16.10  408.10     25x
shot_water_edge        14.60  407.50     28x
ref_01800              15.80  401.00     25x
ref_00720              15.50  399.50     26x
shot_shoreline         15.20  386.60     25x
shot_tide_pools        15.00  378.80     25x
ref_02220              12.70  368.70     29x
shot_cliff_vegetation  12.30  357.80     29x
```

**After 40 warm-up frames were already discarded**, so it is not shader compilation.
Every affected pose has `mean > p95` — the signature of one or two enormous frames, not a
broad slowdown. The other ten poses peak at 27.5–35.3 ms. Untriaged; instrument which
frame index stalls.

---

## 26. `--settle 48` is not converged, and `--settle` is secretly a world-clock knob

**This invalidates the precision of every score in `scores/history.jsonl`.**

Same tree, same code, same seed, same poses, only `--settle` changed:

```
   7 waveG                    30.30      settle 48
   8 waveG-settle96           29.78      settle 96, IDENTICAL CODE
```

**-0.52 points from a knob that is supposed to be a safety margin.** This entire wave —
fourteen subsystems, two concurrent teams of research-led critic+refine — moved the score
**+0.21**. The settle-count noise is **2.5x the measured gain**.

Per pose it is far worse: `ref_01500` **17.14 -> 13.59 (-3.55)**, `ref_02220` -1.15,
`ref_00600` **+0.80**. And `highlight_frac` **more than doubles**, 0.0035 -> 0.0082,
landing almost exactly on the reference 0.0088. Anyone tuning specular response against
the settle-48 number is fitting to a phase, not a material.

### Two independent causes

**1. `--settle` also advances the world clock, and this dominates.** `capture.mjs` calls
`H.setTime(t)` **once** and then `H.advance(settle)` at `fixedDt = 1/60`. So `--settle
48` renders the world at t+0.80 s and `--settle 96` at t+1.60 s: different wave crests,
different foam, different sun glints. `--settle` is a convergence parameter welded to an
animation parameter.

**2. Genuine temporal residual, and it is pose-dependent.** Isolated with
`tools/_convprobe.mjs`, which pins `freeze(true)` and re-applies `setTime(t)` before
every frame so only the Halton jitter phase varies. Mean absolute 8-bit difference
against a settle-144 reference:

```
ref_00000 (frozen)          full      rock       sky      sand    max(full)
  settle  48 vs 144        0.683     0.719     0.717     0.662       21
  settle  96 vs 144        0.653     0.658     0.649     0.661       15

ref_01500 (frozen)          full      rock       sky      sand    max(full)
  settle  48 vs 144        0.982     0.713     0.668     1.714       91
  settle  64 vs 144        0.902     0.659     0.624     1.587       79
  settle  96 vs 144        0.751     0.656     0.621     1.093       43
```

There is an irreducible **~0.65 mean floor** — film grain re-dithers on every frame
index, so two different frame counts can never be identical. Relative to that floor:

- **`ref_00000` IS converged at 48** (excess 0.030 codes, max 21 vs a floor of 15).
  This is the pose §14 was measured on, which is why §14 concluded what it did.
- **`ref_01500` is NOT converged at 48 and still is not at 96.** Its `sand` ROI — the
  wet-sand/foam waterline — sits **1.714** against a 0.62 floor with a **max error of 91
  code values**, and is still descending at 96 and 144. Something there has a temporal
  time-constant much longer than TAA's.

Note which pose fails: **`ref_01500` is the worst-scoring pose in the project (17.14,
`detail` axis 10.75) and is also the one still crawling at settle 48.** Those two facts
are probably connected.

### What to do

- **Do NOT just raise `--settle`.** It changes the world time of every capture and
  invalidates all historical rows for a reason unrelated to convergence.
- **Decouple the knobs.** `capture.mjs` should re-pin `setTime(t)` inside the settle loop
  exactly as `_convprobe.mjs` already does, making `--settle` a pure convergence control
  landing on a fixed world phase. This is a deliberate re-baseline — every number in
  `scores/history.jsonl` moves — so it needs an owner and one clean re-baselining run.
  **It was deliberately not done as a drive-by.**
- **Until then, treat ±0.5 score points as noise.** A wave that moves the score by less
  than that has not been shown to have moved it at all.

---

## 27. The shared capture daemon can deadlock, and looks identical to "busy"

`tools/previewsheet.mjs` hung for 15 minutes. `/health` reported:

```
{"ok":true,"inflight":3,"queued":479,"served":183}
```

`served` did not advance by one over several minutes of polling, with 3 requests
in-flight and 479 queued. The daemon had been up 6h13m. Also found running: two
`tools/_pfxprof.mjs` processes at **2h45m** each, and a `node tools/capture.mjs --beauty
--placement --chrome --label loop-r27` using four flags `capture.mjs` does not define.

`kill` + `rm /tmp/halo-captured.port` fixed it — the next `capture.mjs` invocation started
a fresh daemon which served all 12 poses without incident.

**Check `curl localhost:$(cat /tmp/halo-captured.port)/health` twice before waiting on a
slow capture.** A wedged daemon blocks every agent on the machine and is indistinguishable
from a busy one. `captured.mjs` needs a watchdog: a per-request deadline that releases the
in-flight slot, and a `/health` field for "seconds since `served` last advanced".

---

# Wave H integration pass — 2026-07-30

Depth fix + showcase repairs. Full working notes in `reports/integrationH.md`.
Score **29.44** at `--settle 48`, **down 0.86** from Wave G's 30.30 — and the images
improved substantially. §28 explains why both are true. **§29 is the most important
thing in this pass.**

## Status changes to existing sections

- **§18 (shared depth texture): CLOSED AND VERIFIED.** See the section itself for the
  `_depthprobe` before/after and the independent G-buffer witness. This was the
  highest-priority open item in the project.
- **§21 (DoF is a shipped no-op): CLOSED**, as a direct consequence of §18. The gating
  console line is gone from every capture.
- **§8 (desaturation): MOVED, for the first time in three waves.** `sat_mean`
  55.66 → 61.66 against a reference 79.14. Still 22% short, but the direction reversed.
  Wave F's redirection of the remaining gap to `tonemap`'s highlight roll-off is still
  unacted-on; `highlight_frac` is 0.0039 against a reference 0.0088.
- **§17 (showcase defects): 2 of 5 fixed, 2 partial, 1 open.** Table inline in §17.
- **§1, §10, §11, §12, §13, §20: unchanged and still holding.** `parsecheck` green
  (42 files); zero failed modules; zero malformed-collider warnings; determinism
  bit-exact across two independent captures of `ref_00000`.
- **§25 and §23 (frame time): SUSPECT — see §29.** Both were measured with a CPU
  stopwatch on a machine at load average 24. Their conclusions may be artifacts.
- **§26 (`--settle` is not converged) still governs everything above.** It sets a ±0.5
  noise floor on the score, and this wave's −0.86 is only just outside it. Treat the
  magnitude with suspicion; treat the per-axis *direction* (§28) as real, because it is
  corroborated by raw statistics and by the pixels.

---

## 28. GTAO and SSR have never been validated against an image, and are over-strength

`ssao` and `ssr` both guard on `d >= 1.0` meaning "sky, nothing to do". Under §18 that
was true of every world pixel, so **both passes took the early-out everywhere and
rendered nothing.** §18 is now fixed and they are live for the first time.

Checked against git rather than taken on trust — the mid-frame snapshot that first gave
these passes real depth exists in **no commit**:

```
$ for c in 865e972 76237b2 8ed94d7; do
    git show $c:src/render/passes/ssao.js | grep -c "export function ensureOpaqueDepth"
  done
0    (Wave E)
0    (Wave F)
0    (Wave G)
```

It was written and deleted entirely inside the uncommitted Wave H tree. So every scored
run through `waveG-mvfix` had both passes dead, and `aoStrength`, `aoRadius`, `aoPower`,
`ssrStrength` and the rest **were all tuned against a pass that produced no output.**

They are now live at those values and they are too strong:

```
                 edge_density   edge_ratio      lap_var    lap_ratio
reference             0.0768         1.000       424.13        1.000
waveE                 0.0684         0.891       418.0         0.986
waveF                 0.0793         1.033       336.3         0.793
waveG                 0.0770         1.058       318.32        0.841
waveH                 0.0986         1.413       472.50        1.360
```

The render has swung from 16% *under* the reference's detail energy to 36% *over*, and
from an essentially exact edge density to **41% over**. GTAO writes a dark contact
gradient into every crevice and geometry junction; SSR adds high-frequency reflected
detail to wet sand and water. Both inject exactly what Canny and the Laplacian measure.

`geometry = band(|log(edge_ratio)|, 0.15, 1.2)` collapsed 90.04 → 80.81 as a result,
which at weight 0.12 is **−1.108 of score — more than the entire −0.86 regression.**

**The task is a downward tuning pass on AO and SSR intensity, with a live image behind it
for the first time.** Target `edge_ratio` and `lap_ratio` back toward 1.0. The chroma and
spectrum wins from §18 do not depend on AO strength and should survive it.

### 28b. The composite score is currently anti-correlated with visible quality

The two worst-scoring poses this wave are the two that improved most visibly:

```
pose         waveG   waveH        Δ   geomG  geomH
ref_00600    37.55   22.18   -15.37    72.9   23.0
ref_02220    32.68   23.69    -8.99    87.7   63.0
```

At `ref_00600` waveG renders the sea stacks as pale grey ghosts barely separable from the
sky — no albedo, no vegetation, no crevice shading. waveH gives them warm-tan rock,
visible moss and tree cover, and dark interior crevices. At `ref_02220` waveG renders the
headland cliff as a **flat white wall**; waveH renders tan rock with strata and vegetation
speckle. Both are large, obvious improvements. Both scored dramatically worse.

The mechanism is precise: `edge_ratio` is a **ratio**, blind to sign. waveG scored 1.058
by having a washed-out mush whose Canny density coincidentally landed near the
reference's. Adding correct detail moved it away from 1.0 and was punished.

This is **§4 (circular calibration) presenting in a new form.** Do not revert §18 to
recover 0.86 points. And note the per-pose spread the mean hides — three poses gained
4–12 points while three lost 6–15; the mean describes none of them.

---

## 29. Every frame-time number in this document was taken on a saturated machine

**This calls §23 and §25 into question, and possibly §13.**

`ref_00600` was measured four times on one identical build in a single session:

| method | p50 |
|---|---:|
| `_perfprobe.mjs`, 21 poses sequential | 16.40 |
| `_ssaocost.mjs` baseline | 18.80 |
| `_ssaocost.mjs` "both off" | 11.60 |
| interleaved A/B, mean of 6 reps, ssao+ssr ON | 10.23 |

**A 1.84x spread with no source change.** The machine state at the time:

```
$ uptime
 load average: 24.03, 20.28, 17.95
$ free -g          ->  15 total, 14 used, 1 available
$ ps aux | grep -c "[c]hrome"                    -> 22
$ ps aux | grep -E "[c]apture|[v]ite" | wc -l    -> 17
$ nvidia-smi --query-gpu=utilization.gpu ...     -> 27 %
```

**Load average 24, one gigabyte of RAM free — and the GPU 27% idle.**

§22 already established the decisive fact and nobody applied it: `performance.now()`
around `advance()` measures **CPU submit cost, not GPU frame time**. The instrument is a
CPU stopwatch, and the CPU is oversubscribed 24-deep by a dozen concurrent agents while
the GPU — the thing we want to measure — is mostly idle.

This also explains **§25b's "~400 ms frame hitch"**. There are now 7–8 such frames per
run, they land on *different poses each run*, and they survive 30–40 discarded warm-up
frames. That is the signature of a scheduler stall on a swapping box, not of anything a
renderer does. **§25b is probably not a rendering bug at all.**

### What to do

- **Record `uptime` and `free` alongside every frame-time table from now on.** A number
  taken at load 24 is not comparable to one taken at load 3.
- **Do not name a subsystem as "over 11 ms" from a CPU stopwatch on a busy box.** This
  pass declined to, despite 9 of 21 poses breaching p50.
- **Land `EXT_disjoint_timer_query_webgl2` GPU timer queries** (§22's own recommendation).
  It is the only measurement immune to this, and three waves of perf conclusions are now
  waiting on it.
- **Triangle and draw counts remain trustworthy** — they are deterministic counters.
  Use them.

### 29b. The one perf fact that survives

```
                  triangles                draw calls
§23 (Wave F)      29.6 M – 32.5 M          523 – 645
waveH             30.7 M – 39.4 M          509 – 717
```

**Triangle count rose again, ~10–20%, ceiling 32.5 M → 39.4 M.** `shot_sky_ring` renders
39.3 M triangles for a shot that is mostly empty sky. §23's culling/LOD hypothesis is
untouched and stronger, it is the most likely real performance problem in the build, and
it is measurable **without a stopwatch**. The `--skip rocks` / `--skip props` A/B has
still not been run — fourth wave running. **Fix culling before pricing another post pass.**

---

## 30. New visual defects observed this wave

Not regressions from a specific change; first clearly visible now that the haze wash has
lifted. All from `shots/preview/preview.png`.

1. **Stars are rendering in the daytime sky.** Dozens of them in `shot_sky_ring`,
   alongside a bright sun and full cumulus. Owner: `src/world/sky.js`.
2. **The headland cliff is a hard-edged blocky staircase** in `shot_cliff_vegetation` —
   terrain quantisation terracing across the entire face, plus a near-black unlit region
   at top-left that reads as a hole. Owner: `src/world/terrain.js`.
3. **The water surface at `shot_water_edge` renders as jagged white triangular shards**
   rather than foam, with a smooth turquoise lens in the centre. The cell reads as an
   artifact. **No caustics are visible** despite the caption. Owner: `src/world/ocean.js`.
4. **A bright cyan glowing blob** sits at left-centre of `shot_tide_pools` — unexplained
   emissive or particle artifact. Owner: `src/world/particles.js` or `src/game/ai.js`.
5. **The Forerunner bridge deck is an untextured mauve/purple banded slab** in every cell
   it appears in (01, 03, 04, 07, 09, 10, 12). It is the second-most-visible structure in
   the level. Owner: `src/world/structures.js`.
6. **The viewmodel cannot be framed.** `scene.js` draws it through `pipe.viewCamera`, a
   hard-coded 55° camera, so pose `fov` has no effect on it (207,311 px at fov 58 vs
   207,503 px at fov 95 — 0.09%). `shot_weapon_detail` cannot show weapon detail until
   `viewCamera`'s FOV becomes settable. Owner: `src/render/RenderPipeline.js`.
