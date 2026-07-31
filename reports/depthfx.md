# depthfx — `src/render/passes/dof.js` + `src/render/passes/motionBlur.js`

Wave I. Both passes consume `pipe.depthTex`, which changed under them when KNOWN_ISSUES §18
closed (`reports/depth.md`). This report is what the corrected buffer actually contains, what
that breaks in these two files, and what I changed.

**Headline: `reports/depth.md` §5e tells the next agent to set `dofWorldDepthValid = true`.
Doing exactly that, and nothing else, costs −8.15 score at `ref_00000` (33.14 → 24.99,
detail 91.72 → 51.36) because it blurs 44 % of the frame and the entire weapon.** The
instruction is right; the constants it re-enables are not, and this is why.

New tool: `tools/_dfxprobe.mjs`.

---

## 1. The premise both files were built on is measurably false

`dof.js`'s header states the design rationale for the near field:

> near field: full inside 0.28 m, gone by 1.6 m … **In practice that is the viewmodel and
> nothing else — the world's nearest geometry is the sand under the player's feet at ~1.6 m.**

Measured at `ref_00000` off the corrected `pipe.depthTex`, 1920×1080:

| | claimed | measured |
|---|---:|---:|
| nearest world geometry (z p01) | ~1.6 m | **0.26 m** |
| world depth median (z p50) | — | **1.13 m** |
| fraction of frame inside `dofNearStart` = 1.60 m | ~0 | **47.4 %** |
| fraction receiving a near CoC above the composite's own floor | ~0 | **44.2 %** |

The camera in this scene sits very low; cobble props and sand fill the bottom half of the
frame at 0.26–1.1 m. The near ramp was authored for a world that starts at 1.6 m and is
being applied to a world that starts at 0.26 m.

### The decode is correct — proved against a witness that does not use the depth buffer

Before re-deriving anything I had to rule out "the linearisation is wrong". `_dfxprobe`
raycasts the same scene graph from the same camera through a 5×5 pixel grid and compares the
hit distance projected onto the view axis against `linearZ(texture(tDepth,uv).r)` at the same
pixel. Wherever the ray and the raster hit the same object they agree to three decimals:

```
pixel        decoded   raycast   object
(192,108)      0.341     0.341   props.cobble.0
(576,324)      0.612     0.611   props.cobble.0
(1344,324)     0.434     0.434   props.cobble.0
(576,540)      9.713     9.724   props.cobble.0
(192,756)     52.255    52.198   stack_arch
(1344,756)    50.517    50.520   headland
(1728,972)    52.848    52.889   boulders_0
```

(The grid cells that disagree are ones where `Raycaster` hit a different object than the
rasteriser — instanced/displaced meshes — not a decode discrepancy.) So the 0.26 m is real
geometry, not a decode artefact, and `uNear`/`uFar` (0.06 / 12000) are right.

Distances across the nine scored poses (world pixels only):

| pose | z p01 | z p05 | z p25 | z p50 | sky % | near-band % | **near-visible %** | far-band % | far-visible % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ref_00000 | 0.26 | 0.30 | 0.44 | 1.13 | 14.3 | 47.4 | **44.2** | 1.5 | 0.4 |
| ref_00120 | 0.84 | 0.95 | 1.43 | 4.05 | 15.7 | 24.6 | **15.6** | 1.7 | 0.4 |
| ref_00450 | 1.49 | 1.58 | 2.30 | 5.49 | 28.5 | 4.1 | 0.0 | 1.5 | 1.4 |
| ref_00600 | 5.74 | 6.40 | 12.34 | 51.46 | 62.6 | 0.0 | 0.0 | 3.0 | 1.9 |
| ref_00720 | 1.55 | 1.72 | 2.62 | 7.56 | 38.3 | 1.2 | 0.0 | 3.0 | 1.3 |
| ref_00840 | 2.25 | 2.42 | 3.31 | 6.05 | 34.2 | 0.0 | 0.0 | 7.2 | 1.6 |
| ref_01500 | 1.91 | 2.10 | 2.95 | 5.78 | 29.3 | 0.0 | 0.0 | 6.7 | 2.5 |
| ref_01800 | 1.81 | 2.02 | 2.77 | 4.91 | 34.0 | 0.0 | 0.0 | 6.5 | 2.0 |
| ref_02220 | 1.41 | 1.55 | 2.18 | 4.39 | 31.9 | 4.8 | 0.0 | 6.0 | 1.6 |

---

## 2. The weapon is no longer in `pipe.depthTex`, so every viewmodel guard in both files broke

`dof.js` and `motionBlur.js` both identify the weapon as *"depth written, no G-buffer
coverage"* (`drawnAfterPrepass`). That test was exact **because** §18 was open. Now the gun
writes `pipe.viewDepthTex` and the shared buffer holds the world behind it, so:

* the test is vacuous — `depth.geoFrac` equals the G-buffer opaque mask to five decimals at
  all 21 poses (`reports/depth.md` §4);
* a gun pixel takes the **covered-geometry path** and reads the depth and the velocity of
  whatever is behind the gun.

Measured consequence for DoF, per pose — the CoC the weapon's 209 k pixels receive from the
world behind them:

| pose | world behind gun (z p50) | weapon px given **near** blur | given far blur | mean CoC |
|---|---:|---:|---:|---:|
| ref_00000 | 0.33 m | **100.0 %** | 0 % | **−2.50 px** |
| ref_00120 | 1.09 m | **62.1 %** | 0 % | −0.79 px |
| ref_00600 | 13.82 m | 0 % | 6.1 % | +0.09 px |
| ref_00720 | 2.20 m | 0 % | 0.7 % | +0.01 px |
| others | 2.0–2.7 m | 0 % | 0 % | ~0 |

At `ref_00000` the whole weapon receives the maximum near CoC. That is the visible half of
the −8.15.

---

## 3. Measured cost of following §5e literally

Same build, `--config` only, `ref_00000`, settle 48:

| arm | score | detail | geometry | sand ROI `lap_var` | weapon ROI `lap_var` |
|---|---:|---:|---:|---:|---:|
| shipped (`dofWorldDepthValid=0`, bypass) | **33.14** | 91.72 | 100.0 | 614.7 | 500.6 |
| `dofWorldDepthValid=1` (§5e as written) | **24.99** | 51.36 | 76.0 | **145.7** | **187.4** |
| `dofWorldDepthValid=1, dofNearMaxCoC=0` | **33.14** | 91.63 | 100.0 | — | — |
| reference `kf_00000` | — | — | — | 521.3 | 489.4 |

The weapon ROI is *already at* the reference without DoF (500.6 vs 489.4); the naive turn-on
takes it to 187.4.

---

## 4. The old viewmodel guard is EMPTY, not weak — counted, not inferred

Both files identified the weapon as *"depth written, no G-buffer coverage"*. `depth.md` §4
shows the two mask **fractions** now agree to five decimals, which is not the same as the two
**sets** being equal. Counted directly off the GPU at `ref_00000`:

```
{depth written AND no G-buffer coverage}        0 px      <- what the old guard caught
{G-buffer coverage AND no depth}                0 px
{both}                                  1 777 000 px
```

Zero. The masks are the identical set. So in both files the only guard that ever fired now
fires on nothing, and `MAT_ID.VIEWMODEL` — the "principled" test beside it — has never fired
at all, because `scene.js` renders the G-buffer over `LAYER.OPAQUE + LAYER.DEFAULT` and the
weapon is on `LAYER.VIEWMODEL`.

Both files now use `pipe.viewDepthTex` as an exact mask, as `RenderPipeline.js:184` invites.

### Proof that this matters, by injected camera turn

At rest the weapon cannot smear because nothing moves, so the regression is invisible in a
still and would have shipped. `mbTestVelX` injects a uniform velocity — a synthetic camera
turn — and `mbLegacyVmGuard` restores the old test **in the same build**. Gun mask taken as
`|with weapon − --skip weapons| > 6`, eroded 3 px so the silhouette (where world blur
legitimately lands) is excluded.

Stated before measuring: *with the legacy guard the weapon smears; with the mask it is
identical to the still, while the world smears identically in both arms.*

| comparison, `ref_00000`, +40 px/frame injected | gun interior mean | frac ≥ 2 | world mean | frac ≥ 2 |
|---|---:|---:|---:|---:|
| still vs **new guard** | **0.067** | **0.0078** | 9.168 | 0.847 |
| still vs **legacy guard** | **9.594** | **0.862** | 9.204 | 0.849 |
| new vs legacy | 9.561 | 0.860 | **0.087** | **0.012** |

The two guards differ *only* on the gun, and the gun is the only thing the new one protects.

The same mask drives DoF. Raising `dofViewmodelCoC` 0 → 2.6 at `ref_00000`:

```
gun interior   mean 3.559  frac>=2 0.5805
world          mean 0.403  frac>=2 0.0508    <- the capture's own noise floor (0.34 / 0.051)
```

### `mbNearSuppressM` inverted its meaning

The raw near-distance guard (0.35 m) never caught the viewmodel and said so. What it catches
now is **11.4 % of `ref_00000`** — the cobbles at the camera's feet — and bypasses motion blur
on every one of them. On a camera turn the fastest-moving thing on screen would be the one
thing not blurred. Defaulted to **0**.

---

## 5. Motion blur: near-zero at rest, and *also* near-zero on the moving AI — and that is correct

The brief asked me to confirm blur is near-zero at rest and then confirm it is **not**
near-zero for the moving AI. The first holds. **The second does not, and the reason is the
scene, not the pass.**

CPU re-implementation of tileMax(20) → 3×3 neighbourMax over the read-back MRT1, so the pass's
own gate (`|vN| · 0.5·shutter ≥ mbMinPx`) is evaluated exactly:

| pose | active tiles | frame blurred | max half-extent px | AI px | AI blurred |
|---|---:|---:|---:|---:|---:|
| ref_00000 | 0 / 5184 | 0.000 % | 0.46 | 0 | — |
| ref_00120 | 0 / 5184 | 0.000 % | 0.41 | 0 | — |
| ref_00450 | 0 / 5184 | 0.000 % | 0.43 | 0 | — |
| ref_00600 | 0 / 5184 | 0.000 % | 0.33 | 0 | — |
| ref_00720 | 0 / 5184 | 0.000 % | 0.59 | 2 627 | 0.0 % |
| ref_00840 | 51 / 5184 | 0.984 % | 0.82 | 57 331 | 10.6 % |
| ref_01500 | 41 / 5184 | 0.791 % | 0.64 | 35 427 | 7.5 % |
| ref_01800 | 0 / 5184 | 0.000 % | 0.43 | 14 559 | 0.0 % |
| ref_02220 | 0 / 5184 | 0.000 % | 0.36 | 0 | — |

At rest it is not "small", it is exactly zero: every static surface writes an identically-zero
velocity (KNOWN_ISSUES §1 is fixed at the source, so there is no jitter residue), the tile max
of zeros is zero, and the early-out is uniform across whole tiles.

**And in the image, `ref_00840` with motion blur on is byte-identical to motion blur off** —
`max 0` over the whole frame — even though 51 tiles clear the gate. The weights collapse: with
`lenVY ≈ 0.3 px` the cone term is zero beyond 0.3 px and only taps essentially coincident with
the centre survive.

That could mean "the motion is genuinely sub-pixel" or "the pass is broken for AI". Separating
them: open the gate (`mbShutter=1, mbMinPx=0.2`) and see *where* the change lands. AI mask
taken as `|default − --skip ai| > 6`, dilated 3 px.

| arm, `ref_00840` | AI mask mean | frac ≥ 2 | non-AI mean | frac ≥ 2 |
|---|---:|---:|---:|---:|
| **null** (off vs off, two captures) | 0.274 | 0.017 | 0.341 | 0.051 |
| shipped (on vs off) | **0.000** | 0.000 | **0.000** | 0.000 |
| `mbShutter=1, mbMinPx=0.2` vs off | **0.869** | **0.122** | 0.349 | 0.053 |

Opening the gate lifts the AI mask 3.2× above the noise floor and leaves everything off it
*at* the noise floor. The pass works, it is aimed correctly, and it engages on exactly the
moving characters — it is simply gated off in the shipped configuration because a marine
walking ~2 m/s at 20–40 m subtends under 1 px of motion per 60 Hz frame, which a 180° shutter
halves again.

So the answer to the brief's question is: **no, the AI do not blur, and they should not at
this shutter.** I did not open the gate to make the effect visible — see §8.1 for the one
research-backed argument that it should be opened, with the numbers already taken.

### The depth-aware weighting was inert, by construction

While §18 was open every world pixel read `raw = 1.0`, and `linearZ(1.0)` is exactly
`uFar = 12000`. So `softZ(12000, 12000) = clamp(1 − 0/(0.05·12000)) = 1.0` in **both**
directions — every tap fully accepted as both foreground and background, which is the same
filter with no depth comparison at all. The relative epsilon the header argues for so
carefully had nothing to be relative to. It now sees 0.26 m – 3.5 km of real range.

### Tile-max / neighbour-max is doing something structurally real

`neighbourMax > this tile's own max` on 506–1185 of 5184 tiles per pose, i.e. the 3×3 dilation
genuinely propagates AI velocity into neighbouring tiles. It is the `mbMinPx` gate, not the
tile machinery, that limits the result.

---

## 6. Does the bokeh read at 1080p? No, and it cannot

`dofFarMaxCoC` = 1.5 full-res px = 0.75 half-res px, against a gather radius of 1.75 half-res
px. Twenty-one taps over a disc 1.5 half-res px across is enormously oversampled and has no
resolvable structure — a defocus disc needs roughly 4+ px of radius before its edge reads as a
disc rather than as a blur. The Vogel spiral is doing sampling quality here, not aperture
shape. Nobody should look for bokeh in a frame, and the tap count could be cut substantially
before anything became visible.

---

## 7. What I changed

**`src/render/passes/dof.js`**

* `tViewDepth` / `uHasViewDepth` uniforms; `cocAtUv()` resolves the weapon **first**, from
  `pipe.viewDepthTex`. Removed the now-empty "depth without coverage" branch and the
  never-reachable `MAT_ID.VIEWMODEL` branch.
* `dofWorldDepthValid: false → **true**` — the condition it named is met.
* `dofNearMaxCoC: 2.6 → **0.0**` — the world near ramp is retired *for this scene*, on the
  four measurements in §1. The knob and the ramp endpoints stay; it is the max that is zero.
* `dofViewmodelCoC` stays 0, now with a real signal behind it (§8.2).
* The `console.info` announcing §18 is gone; it is replaced by one that fires only if a
  pipeline publishes no `viewDepthTex`, which is the new way to break this silently.
* Header: the false premise, the raycast validation, the per-pose leak table, and the bokeh
  note replace the three-refusal-cases section, which described a build that no longer exists.

**`src/render/passes/motionBlur.js`**

* Same `tViewDepth` mask, used in all three places the old guard was (tile reduction, per-tap
  weight, whole-pixel bypass). `isViewmodel`/`drawnAfterPrepass` deleted.
* `mbNearSuppressM: 0.35 → **0.0**`.
* New `mbLegacyVmGuard` (restores the old test for a same-build A/B) and `mbTestVelX/Y`
  (scalar twins of `mbTestVelocity`, because `capture.mjs --config` only parses `k=v` — the
  array form was unreachable from the command line and silently produced `NaN`).
* Header: the measured at-rest/AI tables, the "guard is empty" count, and the note that the
  depth comparison was inert.

Both files guard against `pipe.viewDepthTex` being absent with an explicit flag. This matters:
an unbound sampler reads `(0,0,0,1)` in three, so `r = 0 < 1.0` would classify the **whole
frame** as viewmodel and silently switch both passes off.

`node tools/parsecheck.mjs` — ok, 42 files.

---

## 8. Weakest things left, in order

1. **`mbMinPx = 0.60` is 2.4× McGuire's published threshold.** The paper skips
   `||vmax|| ≤ 0.5` px, where its tap parameter spans ±0.5·vmax — i.e. a **0.25 px
   half-extent**. Ours gates the half-extent at 0.60, so it discards anything under a 1.2 px
   total smear. Lowering it to 0.25 is the one research-backed argument for making the AI
   blur, and §5 has the measurement. I did **not** take it, for three reasons: no reference
   pose matches `ref_00840` (the reference keyframe there has no marines in it at all), the
   change costs an 11-tap gather over more of the frame for a sub-quantisation result, and
   `mbMinPx` has a **second, unrelated role** — it is the divisor floor in
   `weight = 1/max(lenVX, uMinPx)`, so lowering it also *raises* the centre weight and
   *reduces* blur. Those two roles should be separate constants before either is tuned.
2. **`dofViewmodelCoC` is still 0 and now unblocked.** The signal is exact and verified
   (§4), the composite's floor means the useful range starts at `dofNearFadeLo` = 0.50 px, and
   the weapon ROI is already at the reference (500.6 vs 489.4). What is missing is a
   **gun-only reference number**: the `weapon` ROI is ~80 % beach, so it cannot resolve this.
   Someone with a hand-cropped gun region from `kf_00000` sets this in one line.
3. **The far field is the only world effect DoF now has, and §9 shows it is a wash** —
   +0.07 summed over nine poses, positive where our distant detail is over the reference and
   negative where it is under. `dofFarStart/End` (90/700 m) and `dofFarMaxCoC` (1.5 px) were
   authored from intent while the path was unreachable and have still never been fitted
   against anything, because until this wave there was nothing to fit them to. The reference
   keyframes show *sharp* distant geometry (`kf_00840`: the sea stack 300 m out is crisp), so
   there is no reference support for far blur at all — only for the fact that our distance is
   noisier than theirs, which is a TAA/sharpen problem and not DoF's to fix. Someone should
   decide whether this effect should exist; `dofFarMaxCoC=0` is the whole experiment.
4. **DoF and motion blur sample a jittered G-buffer with an un-jittered colour buffer.** TAA
   resolves before both, so `pipe.read` is converged, but `tDepth`/`tGbuf1` still carry the
   current frame's ±0.5 px jitter. Sub-pixel, pre-existing, and it bounds how sharp any
   depth-keyed edge in either pass can be.
5. **`pipe.depthTex` excludes water** (`depth.md` §8.6). The DoF far field therefore does not
   see the sea surface — it CoCs the terrain *under* the water. At `ref_00450`/`ref_01500`,
   where water is a large fraction of the frame, that is a silent wrong answer, currently
   harmless only because the far CoC is 1.5 px.

---

## 9. Score, same build, `--config` A/B

Cross-time comparison is void this wave — `ref_00840` moved from 27.07 to 31.49 on the `old`
arm alone between my first sweep and my second, because other agents are editing `src/`
(KNOWN_ISSUES §16). Everything below is one build, `--config` only, arms captured adjacently.

Arms: `old` = `dofEnabled=0, mbLegacyVmGuard=1, mbNearSuppressM=0.35` — reproduces the
pre-change behaviour exactly; `new` = shipped defaults.

| pose | old | new | Δ | our `lap_var` vs ref | far-visible % |
|---|---:|---:|---:|:--|---:|
| ref_00000 | 32.77 | 32.82 | **+0.05** | 545.5 vs 598.8 (under) | 0.4 |
| ref_00120 | 33.18 | 33.24 | **+0.06** | 636.0 vs 607.2 (over) | 0.4 |
| ref_00450 | 34.92 | 35.07 | **+0.15** | 535.4 vs 442.5 (over) | 1.4 |
| ref_00600 | 21.87 | 22.15 | **+0.28** | 331.3 vs 101.5 (over) | 1.9 |
| ref_00720 | 25.03 | 25.13 | **+0.10** | 535.0 vs 351.2 (over) | 1.3 |
| ref_00840 | 31.49 | 31.45 | **−0.04** | 420.2 vs 346.0 (over) | 1.6 |
| ref_01500 | 29.50 | 29.04 | **−0.46** | 390.8 vs 674.0 (**under**) | 2.5 |
| ref_01800 | 31.63 | 31.52 | **−0.11** | 286.1 vs 362.2 (**under**) | 2.0 |
| ref_02220 | 23.60 | 23.64 | **+0.04** | 557.6 vs 333.8 (over) | 1.6 |
| **sum** | | | **+0.07** | | |

**Read this honestly: the far field is a wash, and the per-pose sign is not random.** It is
positive on five of the six poses where our distant detail is *above* the reference and
negative on two of the three where it is *below* (`ref_01500` −0.46 and `ref_01800` −0.11 are
the two largest-magnitude entries in the table, and both are under-detailed poses). That is
the signature of a pure high-frequency remover trading against whatever sign the frame's
detail error happens to have — it is not correcting anything. A blur is the one post effect
that can only ever subtract, and this table is what that looks like when measured.

It ships **on** because the effect is small, defensible as restrained aerial-scale softening,
net non-negative, and because leaving it on is what keeps the pass — including the new
viewmodel mask path — exercised in a real frame instead of returning it to the fully-bypassed
dead code that KNOWN_ISSUES §21 exists to complain about. `dofFarMaxCoC=0` turns it off in one
config value and restores the full CPU-side bypass; nobody should feel they are overturning a
result by doing that.

**The value of this change is not the +0.07.** It is the −8.15 that would otherwise have
landed the moment someone acted on `depth.md` §5e, and the weapon smear that would have
appeared the first time the camera turned. Neither is visible in a still from a static camera,
which is exactly why both needed an injected-motion experiment and a raycast rather than a
score.

## 10. Cost

`tools/_pfxprof.mjs --pose ref_00000 --rounds 8 --samples 24`, run while the A/B sweep was
also on the GPU: `dof` prices at **median +0.1 ms**, with a per-round spread of −10.5 to
+3.6 ms. `bloom` prices at *−1.6 ms* in the same run. The instrument's noise is ~100× the
signal under concurrent load, so the only defensible reading is the one already in the file:
**below the measurement floor**, consistent with the earlier "every one of the four postfx
passes differences to within ±0.1 ms".

What is structurally new, and should be stated because it cannot be measured today:

* **DoF no longer takes the CPU-side bypass.** It previously skipped the prefilter and gather
  entirely (`dofWorldDepthValid: false` made the fast-out fire); both now run every frame, at
  half resolution. By this file's own bandwidth model — a full-res RGBA16F pass ≈ 0.14 ms, a
  half-res one ≈ a quarter of that — that is **≈ 0.07 ms added**.
* **motionBlur adds one texture fetch per velocity evaluation.** The tile-X reduction runs
  `velocityUV` K = 20 times per output pixel over a 96×1080 target, so this is ~2.1 M extra
  fetches, about one full-res texture read's worth: **≈ 0.05 ms**, same order.

Both are estimates from a stated model, not measurements, and are labelled as such.

