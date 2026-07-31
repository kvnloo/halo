# taa + scene: the motion-vector / jitter mismatch (KNOWN_ISSUES §1)

Owner of `src/render/passes/scene.js` and `src/render/passes/taa.js`, changed together.
Research basis: `research/taa.md` (full citations there).

**STATUS: fix applied to both files, invariant verified. Image A/B + convergence below.**

---

## 0. The formulation I chose, and why

**Velocity is the difference of the two UN-jittered NDC positions.** Both matrices
jitter-free, nothing added in the resolve.

`research/taa.md` §1.2 gives the master equation `v = u_n(x_n) − u_{n−1}(x_{n−1})`; both
jitters enter and only as a difference, so "current jittered vs previous un-jittered" —
what `scene.js` does today — is wrong by exactly `−J_n`, half the jitter in the
`(cur−prev)*0.5` packing. Three equivalent implementations exist (UE4 subtracts each
matrix's own jitter; MJP subtracts the delta; three.js `TRAANode` uses two un-jittered
matrices). I took **three.js's own form** because:

- it is what `RenderPipeline` already computes and stores (`currViewProj`, `prevViewProj`
  are both built from `unjitteredProj` before `_applyJitter` runs),
- it costs zero per-fragment work,
- it makes the invariant checkable with one number: **static camera + static geometry ⇒
  bit-exact zero motion vector**,
- and it is the convention `taa.js`'s *depth-derived* path already uses, so the two paths
  agree instead of needing a correction term to reconcile them.

Rasterisation is untouched: `GBufferMaterial`'s `gl_Position` comes from three's
`<project_vertex>` using the *jittered* `projectionMatrix` uniform, while `vCurClip` comes
from the separate `uCurrViewProj`. Depth and normals stay jittered, as they must (FSR2's
rule: "all inputs at render resolution *except motion vectors* should be rendered with
jitter"). Only the value written to MRT1.rg moves.

---

## 1. Measurement, not argument: the G-buffer velocity read back off the GPU

`tools/_mvprobe.mjs` (new) reads `pipe.gbuffer.textures[1]` back as half-float with a
static camera and reports per-`matId` statistics. This is deliberately independent of
tonemap/fog/grade, which other agents are editing under me.

Baseline, `--pose ref_01500 --settle 48`, 1920x1080, frameIndex 49,
`pipe.jitter = (0, −3.0864e−4)` so the predicted buggy value is `−0.5·jitter =
(0, +1.5432e−4)`:

| matId | surface | px | zeroFrac | mean mv | mean px | frac > 1.5 px gate |
|---|---|---|---|---|---|---|
| 2 | TERRAIN_WET | 877 626 | **1.0000** | (0, 0) | 0.000 | 0 |
| 3 | ROCK | 265 582 | 0.0000 | (0, **+1.54258e−4**) | 0.167 | 0 |
| 1 | TERRAIN_SAND | 148 847 | **1.0000** | (0, 0) | 0.000 | 0 |
| 5 | FOLIAGE | 49 246 | 0.0000 | (3.8e−6, +1.614e−4) | 0.281 | 4.3e−4 |
| 7 | SKIN (ai.js) | 27 099 | 0.0000 | (1.88e−4, +1.81e−4) | 0.707 | **0.0846** |
| 0 | DEFAULT | 1 530 | 0.0000 | (0, +1.54259e−4) | 0.167 | 0 |

`matId 3` reads `+1.54258e−4` against a predicted `+1.54321e−4` — agreement to the last
half-float step. **The bug is confirmed, exactly, and its magnitude is exactly the
predicted `−0.5·J_n`.**

### 1a. A finding KNOWN_ISSUES §1 does not have: there are THREE velocity producers, not one

`scene.js`/`GBufferMaterial` is not the only thing writing MRT1. Grepping
`uCurrViewProj`/`allowOverride` finds two more, both opting out of `scene.overrideMaterial`
because they do vertex displacement:

1. **`scene.js` + `GBufferMaterial`** — rocks, structures, props, AI, weapons.
   `uCurrViewProj` **jittered**, `uPrevViewProj` un-jittered ⇒ error `−0.5·J_n`. *(the
   documented bug; measured above on matId 0/3/7)*
2. **`terrain.js` `buildGBufferMaterial()`** (terrain.js:1900) — sets its own
   `uCurrViewProj` from `ctx.camera.projectionMatrix` **in `prerender`**. Its comment says
   it "mirrors src/render/passes/scene.js exactly, jitter convention included". **It does
   not.** `Engine.step` runs every module's `prerender` *before* `pipeline.render`, and
   `RenderPipeline.render` restores the un-jittered projection at the end of the previous
   frame — so at `prerender` time `camera.projectionMatrix` is **un-jittered**. Terrain
   therefore already uses two un-jittered matrices and is **already correct**: measured
   `zeroFrac = 1.0000` over 1 026 473 terrain pixels.
   Consequence: `taa.js`'s blanket `+ 0.5 * uJitter` compensation is *wrong for terrain
   today* — it injects a half-pixel error into 75 % of the frame's velocity. It is
   harmless only because of the 1.5 px gate.
3. **`vegetation.js`** (vegetation.js:391, 2130) — `vVegCur = gl_Position`, i.e. the
   **jittered** clip position, against `uPrevViewProj` captured in `prerender` and
   therefore **un-jittered**. Same error as (1), and it stays wrong after my fix because
   I do not own that file. Measured impact today: FOLIAGE mean 0.281 px, and only
   **0.043 %** of foliage pixels exceed the 1.5 px gate at which `taa.js` would consume
   the G-buffer value at all. Logged for the vegetation owner; the one-line fix there is
   to publish `pipe.currViewProj` into a `uCurrViewProj` and use it for `vVegCur`
   instead of `gl_Position`.

### 1b. Blast radius, measured rather than asserted

`taa.js` consumes `gb1.rg` only where `length((mvG − mv)*uRes) > 1.5`. With a static
camera the depth-derived `mv` is *identically zero* (`currViewProj == prevViewProj`
bit-for-bit), so the measured `|mv|` in pixels **is** the disagreement. Result:
`gateFrac = 0` for every static surface — rock, terrain, structures. The only pixels that
actually consume the G-buffer velocity in a scored still are the animated AI
(`matId 7`, 8.5 % of 27 k px) and a handful of wind-blown foliage.

So `research/taa.md` §1.6 is confirmed empirically: **the still-frame blast radius of this
bug is nil, and the coupled commit is therefore low risk.** What it fixes is the
correctness of every *moving* pixel, and it removes a landmine that fires the moment
anything (AI, tracers, the viewmodel, the Pelican) moves.

---

## 2. Pass order — confirmed correct

`PASS_MANIFEST` (src/render/pipeline.js) is
`ssao, ssr, cloudComposite, volumetricFog, taa, dof, motionBlur, bloom, tonemap, grade,
sharpen, grain`. The scored sub-chain `taa → dof → motionBlur → bloom → tonemap` is
exactly UE4's canonical post order. TAA first is mandatory (bloom's threshold otherwise
fires on a different set of sub-pixel highlights every jitter phase — highlight crawl).
No change.

---

## 3. The change, and the invariant after it

`src/render/passes/scene.js`
```js
gbufMat.uniforms.uCurrViewProj.value.copy(pipe.currViewProj);   // was: P_jittered * V
gbufMat.uniforms.uPrevViewProj.value.copy(pipe.prevViewProj);
```
`src/render/passes/taa.js`
```glsl
vec2 mvG = gb1.rg + uMvLegacy * 0.5 * uJitter;   // uMvLegacy = 0 by default
```
`ctx.config.mvLegacyJitter` restores the old pairing in **both** files at once, which is
what makes a same-page-load A/B possible. It is a diagnostic switch, not a mode.

Same probe, same pose, after (`missingPasses []`, `taaPass true`,
`jitter = (0, −3.0864e−4)`):

| matId | surface | px | zeroFrac | mean mv | gateFrac |
|---|---|---|---|---|---|
| 2 | TERRAIN_WET | 923 262 | **1.0000** | (0, 0) | 0 |
| 3 | ROCK | 270 763 | **1.0000** ← was 0.0000 | (0, **0**) ← was +1.5426e−4 | 0 |
| 1 | TERRAIN_SAND | 105 601 | **1.0000** | (0, 0) | 0 |
| 5 | FOLIAGE | 74 759 | 0.0000 | (2.3e−6, +1.586e−4) | 2.8e−4 |
| 7 | SKIN (moving AI) | 27 109 | 0.3427 | (+1.8831e−4, **+2.645e−5**) | 0.0795 |
| 0 | DEFAULT | 1 545 | **1.0000** | (0, 0) | 0 |

Two things worth reading twice:

- Every **static** surface now writes a **bit-exact zero** motion vector. That is the
  invariant the whole design rests on: Catmull-Rom at `f = 0` collapses to the centre tap,
  so the history resample is the identity and note 7b's zero-velocity box relaxation is
  legitimate.
- The **moving AI** kept its motion and lost exactly the bias. `meanY` went
  `1.8110e−4 → 2.6452e−5`; the difference is `1.5465e−4` against a predicted jitter bias
  of `1.5432e−4`. `meanX` is unchanged (`1.8814e−4 → 1.8831e−4`) because this jitter phase
  has `jx = 0`. Nothing but the bias moved.
- FOLIAGE still carries `+1.586e−4 ≈ +1.5432e−4`, i.e. **vegetation.js is still wrong** —
  see §1a. Its residual true motion is ~1.6e−5.

Re-checked at a second pose, `ref_00450 --settle 48`: TERRAIN_SAND (859 254 px),
ROCK (316 318 px) and TERRAIN_WET (188 957 px) all `zeroFrac 1.0000, gateFrac 0`. The two
non-zero populations are the ones that should be — FOLIAGE (still-buggy producer) and
`matId 9 METAL`, the Pelican, which is genuinely moving at 0.576 px/frame.

### 3b. What it does to the picture: nothing measurable, which is the predicted answer

`tools/_abshot.mjs`, one page load, world pinned, `ref_01500 --settle 48`,
`--skip volumetricFog,ocean`. Three variants: `newA` (fixed), `old`
(`mvLegacyJitter=1`), `newB` (fixed again — the **control** that bounds the harness's own
repeatability). `rock` ROI:

| variant | edge_density | local_contrast | lap_var | lum_std |
|---|---|---|---|---|
| **old** (pre-fix) | 0.041153 | 0.105231 | 239.558 | 30.7338 |
| **newA** (fixed) | 0.040976 | 0.105069 | 237.835 | 30.6806 |
| newB (control) | 0.040660 | 0.105220 | 239.626 | 30.7315 |

| comparison | Δ edge_density | Δ local_contrast | Δ lap_var | rock max Δ, code values |
|---|---|---|---|---|
| effect (old → newA) | −0.000177 | −0.000162 | −1.72 | 16 |
| **control (newA → newB)** | **−0.000316** | **+0.000151** | **+1.79** | **16** |

**The effect is smaller than the control on every axis.** There is no measurable change to
a static still, and the control proves the measurement was sensitive enough to have seen
one. This is the predicted result, not a null: §1b measured `gateFrac = 0` on every static
surface, so the bad vector was never consumed in a scored frame in the first place. The
claim in KNOWN_ISSUES §1 that this bug was causing "permanent, unrecoverable blur" in the
stills is **false**, and I would rather say so than take credit for a number that did not
move.

Cost: **≈ 0 ms.** CPU side the change replaces a `Matrix4.multiplyMatrices` with a
`Matrix4.copy` once per frame (cheaper). GPU side it is the same one `vec2` multiply-add
in the resolve. Measured frame time across variants sat at 5.4-7.1 ms with more spread
between repeats of the same variant than between variants.

### 3a. Third consumer: `motionBlur.js` also compensates, and I did not touch it

`motionBlur.js:189` does `v = g1.rg + 0.5 * uJitter` with the same rationale. It is not my
file and not in the concurrent-edit set, so I left it — but I checked that leaving it is
safe rather than assuming it. After the fix its residual on static geometry is
`0.5·uJitter`, i.e. at most `|jpx| ≤ 0.637 px` of raw velocity, scaled by
`uHalfShutter = mbShutter/2 = 0.25` to **≤ 0.16 px of half-extent**, against its own
`mbMinPx = 0.60` cutoff at motionBlur.js:350. It cannot reach the threshold, so the
whole-frame early-out still fires on a locked-off camera and no blur is produced. The
one-line follow-up for its owner is to drop the `+ 0.5 * uJitter`.

## 4. Does the still actually converge at `--settle 48`?

**Yes for everything static, and the answer required a different experiment than
"capture twice and cmp".**

Capturing twice does not work here, and the failure is instructive. Two `capture.mjs` runs
of `ref_01500 --settle 48` three minutes apart differed by **max 159, mean 0.789, 13.7 %
of pixels** — because six world files (`weapons, clouds, ocean, rocks, vegetation,
terrain`) were written between them by the concurrent wave. Repeating the settle inside
one page load is worse, not better (**mean 1.777, 55 % of pixels**): each variant starts
from the previous one's simulation state, and passes that key off absolute
`pipe.frameIndex` (grain, motion-blur tap jitter) are 48 frames out of step.

So `tools/_convprobe.mjs` pins the world instead: `__HALO__.freeze(true)` plus
`setTime(t)` re-applied **before every single frame**, so `clock.t` never advances and
nothing clock-driven can move. The only thing changing between frames is the Halton
phase, so every difference measured is TAA.

Frame 48 vs frame N, world pinned, `--skip volumetricFog,ocean,clouds`, max |Δ| in code
values (the two skips are justified in §4a — they animate per *frame*, not per clock, so
they are the only things that move under the pin):

| region | 48 vs 49 | 48 vs 64 | 48 vs 96 | 48 vs 128 |
|---|---|---|---|---|
| rock | **53** | **3** | **3** | **3** |
| sky | **53** | **3** | **3** | **3** |

That is exactly the 16-frame limit cycle `research/taa.md` §3.2 predicts, and it is
larger than I expected. **Phase-matched frames are converged**: 48, 64, 96 and 128 agree
to 3 code values, which is the grain floor — the accumulator has stopped moving by frame
48 and stays stopped out to 128. **Adjacent frames are not the same picture**: 48 vs 49
differs by up to **53 code values** on high-contrast rock/sky silhouettes.

With a fixed `α = 0.09` the converged still is **periodic with period 16, not a fixed
point** — the steady state weights the newest phase `(1−α)^15 = 4.1×` the oldest, so which
still you get depends on `frameIndex % 16`. `--settle 48 = 3 × 16` lands on a stable phase
and every score in this project's history is safe. But **a settle count that is not a
multiple of 16 is a different picture by up to 53 code values on exactly the edges the
`detail` and `structure` metrics look at.** Anyone who "just bumps the settle to 50" will
move scores and blame their own subsystem. `--settle` should be documented as
"multiple of 16 only".

A ~0.63 mean / 55 %-of-pixels ±1 floor is present between *any* two frames including
phase-matched ones. It is the `grain` pass's per-frame dither, not TAA: it is flat across
regions and does not decay with frame count.

### 4b. Why I did NOT add the `α = 1/(n+1)` settle ramp

`research/taa.md` §3.3 recommends it, and on the face of it 53 code values of phase
dependence is exactly the argument for it: an equal-weight mean over `n = 3 × 16` frames is
phase-independent by construction. I did not add it, and the reason is a measurement, not
caution.

**The settle is not a static scene.** §4a shows `ocean.js` and `clouds.js` advance their
own animation once per *frame*, independent of `clock.t`. A running mean with no
forgetting would therefore average the ocean over 48 frames of wave motion instead of ~11,
smearing the water and the cloud tops — the two regions with the most sub-pixel structure
in the frame. The ramp is only safe once the harness can genuinely freeze the world during
settle, which is the same fix §4a already asks the ocean and cloud owners for. Sequence
matters here: **freeze the world first, then the ramp is free quality.** Doing the ramp
first is a water regression dressed as an antialiasing win.

### 4a. What is NOT converged at 48: the ocean (and it is not TAA)

With the ocean **in**, the same test shows the lower half of the frame still moving at
frame 48 and getting monotonically further from it: `sand` max |Δ| goes
**14 (f56) → 25 (f64) → 41 (f80) → 55 (f96) → 68 (f128)**, mean 0.66 → 1.63. A 12×12 grid
of the f48↔f128 difference puts every value above y = 0.5 at 3-4 and everything below it
at 20-110.

Attribution, by nulling one term at a time (the method from KNOWN_ISSUES §8):

| variant | sand max Δ, f48 vs f128 |
|---|---|
| default | 68 |
| `taaAlpha = 1.0` (TAA history feedback off) | 68 |
| `ssr` pass disabled | 68 |
| **`--skip ocean`** | **3** |

So it is `ocean.js`, integrating its own time per frame instead of reading the pinned
`clock.t`, and it does not honour `ctx.config.frozen`. **It is not a TAA convergence
failure and not a scoring hazard** — `--settle 48` is fixed, so the water is reproducible
— but it does mean the water in every scored frame is "the ocean at 48 frames of
simulation", and it will move if anyone changes the settle count. Logged for the ocean
owner; `ctx.config.frozen` support there would make the whole harness stricter.

## 5. Review of the resolve itself

Checked against primary sources via `research/taa.md`; everything below is a *verification
result*, not a change, unless it says otherwise.

- **Neighbourhood rectification** — YCoCg variance box `μ ± γσ` intersected with a rounded
  `(box+cross)/2` min/max, clipped toward the centre rather than clamped per channel.
  That is Salvi's variance clip inside Playdead's rounded box with Karis's YCoCg
  reorientation and clip-not-clamp, which is the state of the art and correctly
  assembled. `γ = 1.6` static / `0.85` moving inverts three.js `TRAANode`'s relationship
  deliberately and, I agree, correctly: rectification exists to reject *stale* history,
  staleness requires motion, and loosening when still is what preserves sub-pixel detail.
  Not done: Playdead's chroma-extent shrink (`cmin.yz = chroma_centre ± 0.25·0.5·luma
  extent`). It is the standard extra defence against coloured ghosting on saturated
  moving objects; worth an A/B when plasma bolts and muzzle flash exist.
- **History resampling** — 5-tap Catmull-Rom (MJP's optimisation, corners dropped).
  Verified identity at `f = 0` (`w0 = w3 = 0, w1 = 1, w2 = 0`), which is the entire payoff
  of the exact-zero motion vector. `w12 ∈ [1, 1.125]` so `w2/w12` cannot divide by zero;
  the `max(s,1e-5)` renormalisation is belt-and-braces. Correct.
- **Disocclusion** — off-screen test (present), plane-slope depth tolerance
  `dz/dpx = 2·z·|n.x|·tanX/(W·|n.z|)` (present, and a better formulation than the scalar
  relative-depth test everyone else ships). **Missing: velocity dilation** — sampling the
  velocity of the *closest* fragment in a 3×3 rather than the centre one (Karis "dilate
  velocity — take front most velocity"; Playdead `find_closest_fragment_3x3`; three's
  `TRAANode.closestPositionTexel`). It is the cheapest remaining quality win and it costs
  8 depth taps. I did **not** add it: with a static camera `uCurrVP == uPrevVP` bit-for-bit
  so `mv ≡ 0` regardless of which depth is dilated, which means it cannot change a single
  scored still and I would be shipping an unmeasurable change during a live wave. It is
  the top of the next-agent list.
- **Reprojection algebra** — re-derived. `uInvVPJit` must be the *jittered* inverse
  (it is), and `RenderPipeline.render()` must restore the un-jittered projection only
  *after* the post chain (it does). If anyone moves that restore earlier, TAA breaks
  silently. Note `research/taa.md` §1.3 has a sign slip in its final line
  (`p − (p + J) + u = u − J`, not `u + J`); §4.2 has it right and the code matches §4.2.

## 6. Pass order — confirmed, no change

Already covered in §2: `taa → dof → motionBlur → bloom → tonemap` is UE4's canonical
order and TAA-first is mandatory. The `_checkOrder` alarm in taa.js is the right shape —
it warns, it does not mutate the list that owns it.

## 7. Tools left behind

- `tools/_mvprobe.mjs` — reads MRT1 back off the GPU, per-`matId` velocity stats and the
  1.5 px gate fraction. Refuses to report if any pass failed to load.
- `tools/_convprobe.mjs` — world-pinned convergence sweep (`--frames`, `--off`).
- `tools/_abshot.mjs` — N config variants in ONE page load with the world pinned. This is
  the only A/B that survives a live wave.
- `tools/_panshot.mjs` — moving-camera capture (yaws without re-issuing `setPose`, which
  would reset the TAA history).
- `tools/_imdiff.py` — max/mean/tail difference per ROI. `cmp` only says "differs".

**Do not trust any capture-based A/B in this repo that does not pin the world.** Measured
noise floors at `ref_01500`: 0.79 mean across processes, 1.78 mean across settles in one
page load, ~0.63 mean (grain dither) with the world pinned.

All three `.mjs` probes now **refuse to report** if `__HALO_MISSING_PASSES__` is non-empty.
That guard exists because I earned it: a stray backtick inside the GLSL template literal
made `taa.js` a syntax error, `pipeline.js` swallowed the failed dynamic import into a
`console.warn`, `_applyJitter` saw no `taa` pass and set the jitter to zero — and I
collected a full set of confident, meaningless measurements before noticing. **A missing
pass in this engine looks exactly like a working engine.** `node --check` after every edit,
and check the missing list before believing a number.

## 8. Ranked follow-ups (each is one file, none is mine)

1. **`vegetation.js`** — still on the old convention (`vVegCur = gl_Position`, jittered).
   Publish `pipe.currViewProj` as a `uCurrViewProj` and use it. Small today (0.028 % of
   foliage pixels reach the gate) but it is now the only producer that disagrees.
2. **`ocean.js` / `clouds.js`** — honour `ctx.config.frozen` and drive animation from
   `ctx.clock.t` rather than a per-frame accumulator. This is what makes the harness
   strict, and it is the precondition for §4b's `α = 1/(n+1)` settle ramp, which is the
   single largest still-frame quality win left in the TAA (it would remove the 53 code
   values of jitter-phase dependence entirely).
3. **`motionBlur.js:189`** — drop `+ 0.5 * uJitter` (§3a). Currently harmless, will stop
   being harmless if `mbShutter` or `mbMinPx` is ever retuned.
4. **`taa.js` velocity dilation** (§5) — closest-depth 3×3. Unmeasurable on stills by
   construction, real for moving silhouettes. Wants a moving-capture harness with a frozen
   world and moving *geometry*, which `tools/_panshot.mjs` is 80 % of.
5. **`taa.js` `wide` tent is truncated** (`research/taa.md` §2.7). The radius-2 tent needs
   taps at ±2 to be a partition of unity; on the 3×3 its discrete sum swings 12.5 % with
   the jitter phase, so `filt - wide` re-injects a phase-dependent term that note 0 spent
   40 lines removing. The zero-cost fix is to make `wide` the **quadratic B-spline**
   `B2(x) = 0.75 − x²` for `|x| ≤ 0.5`, `0.5(1.5 − |x|)²` for `0.5 < |x| ≤ 1.5` — support
   3, so with `|j| ≤ 0.5` it fits the existing 9 taps exactly, and being a B-spline it
   satisfies `Σ B2(o+j) = 1` and `Σ B2(o+j)(o+j) = 0` identically for every phase
   (verified by hand at j = 0, 0.25, 0.5). It needs a gain of ≈2.0 to match the current
   high-pass amplitude at Nyquist, and that re-calibration is a global sharpening change,
   which is why I did not land it mid-wave with six other agents measuring against the
   current build. It is a clean, cheap, well-founded win for whoever owns taa.js next.
   Also: the comment above the `uFilter` clamp still talks about a "9-tap Gaussian" and is
   stale from before the tent landed.
6. **`scene.js` step 7 clears the shared depth texture** (`research/taa.md` §4.3): 
   `renderer.clearDepth()` on `sceneRT` clears `pipe.depthTex`, which `taa`, `dof`,
   `motionBlur`, `ssr`, `ssao` and `volumetricFog` all read afterwards. It is latent only
   because nothing is on `LAYER.VIEWMODEL` in a scored pose yet. This one IS in my file
   and I deliberately left it: fixing it means giving `sceneRT` its own depth attachment
   or snapshotting `depthTex`, which changes what six other passes read, and doing that in
   the same commit as a velocity change would make both unattributable. It should be its
   own change, with its own before/after, before `weapons` puts geometry on that layer.

