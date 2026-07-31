# depth — `src/render/RenderPipeline.js` + `src/render/passes/scene.js`

Wave H. KNOWN_ISSUES **§18 is closed**. This report is the handover: what the buffer now
contains, how that was proved, and exactly what every consumer must do about it.

---

## 0. Headline

`pipe.depthTex` now holds true opaque **world** depth for the entire frame, including the
whole post chain. The viewmodel was given its own depth attachment, `pipe.viewDepthTex`.

Measured at `ref_00000`, 1920×1080:

| | before | after |
|---|---:|---:|
| `depth.geoFrac` (fraction of frame carrying real geometric depth) | **0.10094** | **0.85696** |
| G-buffer opaque mask (MRT1.a) — independent witness | 0.85682 | 0.85696 |
| median decoded distance over those pixels | 12.18 m (nonsense: the gun) | 1.15 m (the beach) |
| `pipe.depthTex` vs `pipe.opaqueDepthTex`, differing pixels | **1 776 706** (85.7 % of frame), max \|Δ\| 0.2425 | **0** |

Across **all 21 poses**, `depth.geoFrac` now equals the G-buffer's own opaque mask to five
decimals, and the ssao/ssr snapshot is bit-identical to the shared buffer. Before the fix
`depth.geoFrac` was ~0.10 at every pose regardless of scene content, because it was the gun.

Cost: **≤ 0.2 ms**, below the block-to-block drift of the measurement (§6). Two extra
`framebufferTexture2D` calls per frame; no copies, no extra draws, no extra passes.

---

## 1. The decision the brief asked for: **fix the attachment, and the snapshot becomes a
derived copy**

Wave G's screenspace agent shipped an opaque-depth snapshot (`pipe.opaqueDepthTex`, an R32F
copy taken mid-frame by an invisible probe mesh on `LAYER.TRANSPARENT`). The brief asked me
to promote it to canonical or retire it, and to make sure the two can never drift.

**Chosen: fix the attachment properly. `pipe.depthTex` is canonical.**

Reasons, in order of weight:

1. **It fixes every consumer with zero consumer edits.** `dof`, `motionBlur`, `taa`,
   `volumetricFog`, `cloudComposite` and `ocean` refraction all read `pipe.depthTex` by
   name. Promoting the snapshot would have left all six reading a buffer containing a gun
   and required six separate adoptions — the state §18 has been in for four waves.
2. **The snapshot cannot exist without the bug it works around.** Its whole reason to be
   is "copy the depth at the one moment it still holds the world". Once the world's depth
   is never destroyed, there is no such moment to catch: every moment is that moment.
3. **A copy costs a full-screen R32F target** (1920×1080×4 B = 8.3 MB) **and a full-screen
   draw**, to reproduce a texture that already exists.

**Why both still exist, and why they cannot drift.** `ensureOpaqueDepth()` lives in
`src/render/passes/ssao.js`, which I do not own, so I cannot delete it this wave. What I can
guarantee — and did, by measurement — is that it is now a **bit-exact copy of the canonical
buffer**, not an independent opinion of it. It copies `pipe.depthTex` at the start of
`scene.js` step 5; `pipe.depthTex` is written once, by step 1, and nothing after that touches
it (§2). So the copy is taken from a source that is already final. Verified at all 21 poses:
**0 differing pixels**. Before the fix the same comparison gave 85.7 % differing.

**Retiring it is a pure deletion, and it belongs to the ssao/ssr owner**, next wave:

* delete `ensureOpaqueDepth`, `opaqueDepthTexture`, `OPAQUE_DEPTH_FRAG`, the probe mesh and
  the `_opaqueDepth` WeakMap from `ssao.js`;
* replace `opaqueDepthTexture(pipe)` with `pipe.depthTex` at `ssao.js:1097` and
  `ssr.js:777`;
* drop the `aoLegacyDepth` / `ssrLegacyDepth` knobs, which now mean nothing.

Nothing in the AO or SSR image should move — the two textures are byte-identical. That is
the point of proving it rather than asserting it.

---

## 2. What changed, mechanically

**`RenderPipeline.js`**

* New `this.viewDepthTex` — a second `DepthTexture(FloatType, Nearest)`, resized alongside
  `depthTex`, disposed with it.
* `resize()` now sizes **both** depth textures. three throws
  `'Attached DepthTexture is initialized to the incorrect size'` on the next bind otherwise,
  and `viewDepthTex` is bound once per frame, so the throw would land mid-weapon-draw.
* `dispose()` now disposes both depth textures (it disposed neither before).
* The class doc carries the depth contract (§3).

**`scene.js` step 7**

```js
if (!legacyDepth) pipe.sceneRT.depthTexture = pipe.viewDepthTex;
renderer.setRenderTarget(pipe.sceneRT);   // the re-bind is what performs the swap
renderer.clearDepth();                    // clears viewDepthTex, NOT the world's depth
renderer.render(scene, vm);
if (!legacyDepth) pipe.sceneRT.depthTexture = pipe.depthTex;
```

This is supported API in r0.185.1, not a trick: `WebGLRenderer.setRenderTarget` compares the
bound target's `depthTexture` against `renderTargetProperties.__boundDepthTexture` and re-runs
`textures.setupDepthRenderbuffer()` when they differ
(`three.module.js:18925-18945`, `12873-12905`). There is no early-out for "same render target",
so re-binding `sceneRT` is sufficient to make the swap happen.

`ctx.config.vmLegacyDepth = 1` restores the old shared-buffer clear — a same-build A/B, which
is the only honest kind while `src/` is live (KNOWN_ISSUES §16, reports/screenspace.md §6).
It reproduces the pre-fix numbers exactly (`geoFrac` 0.10094, `geoPx` 209 304, both matching
the pre-edit tree). It is a diagnostic, not a mode: it reintroduces §18 in full.

**`src/world/clouds.js`, one expression** — see §5. Not a retune; no constant in that file
was touched.

---

## 3. THE DEPTH CONTRACT — for consumers

```
pipe.depthTex      Raw (non-linear) depth of the OPAQUE WORLD, full res, NearestFilter,
                   under the WORLD camera's projection (near 0.06, far 12000).
                   1.0 == sky / nothing. Valid for the whole frame and the whole post
                   chain. Contains NO viewmodel, NO water surface, NO particles.

pipe.viewDepthTex  Raw depth of the VIEWMODEL alone, under viewCamera's projection
                   (near 0.002, far 12). 1.0 == "not the weapon".
                   USE IT AS A MASK, NOT AS A DISTANCE — its near/far are not the world's.
```

Why the invariant holds, and what would break it: `depthTex` is written **once**, by the
G-buffer pre-pass over `LAYER.OPAQUE + LAYER.DEFAULT`. Sky (`sky.js:1660`), water
(`ocean.js:1921`), glass (`structures.js:1118`) and every particle material all render with
`depthWrite: false`, and the viewmodel now writes `viewDepthTex`. **If you add a draw to
`scene.js` steps 2/5/6, it must not write depth unless it also went through step 1.**

`pipe.opaqueDepthTex` remains published and is currently bit-identical to `pipe.depthTex`.
Prefer `pipe.depthTex`.

---

## 4. Proof — readback, not argument (`tools/_depthprobe.mjs`)

A `DepthTexture` cannot be a colour attachment, so it cannot be `readPixels`'d directly. The
probe resolves it through a full-screen RGBA32F copy and reads that back, after
`H.advance()` has completed a frame — i.e. at the moment the post chain samples it.

```
node tools/_depthprobe.mjs --pose ref_00000 --settle 48
node tools/_depthprobe.mjs --poses all --settle 48
node tools/_depthprobe.mjs --pose ref_00000 --perf 90
node tools/_depthprobe.mjs --pose ref_00000 --config vmLegacyDepth=1     # reproduce §18
```

Three independent witnesses, all of which had to agree:

1. **The shared buffer itself** (`depth.geoFrac`).
2. **The G-buffer's own opaque mask, MRT1.a** (`gbufferGeoFrac`) — a different attachment,
   written by a different pass, that never went through the depth clear. If the depth fix
   were an artefact of my readback, this would not track it.
3. **ssao's snapshot** (`agree`) — an R32F copy made mid-frame by unrelated code.

All 21 poses, after the fix (`--poses all`):

| pose | `depth.geoFrac` | G-buffer mask | snapshot identical | viewmodel px | weapon-over-sky |
|---|---:|---:|:--:|---:|---:|
| ref_00000 | 0.85696 | 0.85696 | yes | 209 395 | 0.000 |
| ref_00120 | 0.84264 | 0.84264 | yes | 208 823 | 0.000 |
| ref_00450 | 0.71541 | 0.71541 | yes | 206 609 | 0.000 |
| ref_00600 | 0.37392 | 0.37392 | yes | 207 987 | **0.160** |
| ref_00720 | 0.61679 | 0.61679 | yes | 208 618 | 0.004 |
| ref_00840 | 0.65804 | 0.65804 | yes | 207 563 | 0.000 |
| ref_01500 | 0.70695 | 0.70695 | yes | 208 357 | 0.000 |
| ref_01800 | 0.65998 | 0.65998 | yes | 207 748 | 0.000 |
| ref_02220 | 0.68135 | 0.68135 | yes | 206 399 | 0.000 |
| shot_beach_establishing | 0.40462 | 0.40462 | yes | 208 475 | **1.000** |
| shot_forerunner_bridge | 0.55324 | 0.55324 | yes | 208 913 | 0.047 |
| shot_bridge_underside | 0.31209 | 0.31209 | yes | 207 037 | **0.544** |
| shot_hero_stack | 0.62097 | 0.62097 | yes | 209 246 | 0.000 |
| shot_stack_gauntlet | 0.72520 | 0.72520 | yes | 209 914 | 0.000 |
| shot_shoreline | 0.77269 | 0.77269 | yes | 205 083 | 0.000 |
| shot_tide_pools | 0.89802 | 0.89802 | yes | 205 142 | 0.000 |
| shot_water_edge | 0.71964 | 0.71964 | yes | 209 648 | 0.000 |
| shot_cliff_vegetation | 0.23963 | 0.23963 | yes | 209 256 | **0.687** |
| shot_sky_ring | 0.36270 | 0.36270 | yes | 208 243 | **0.235** |
| shot_weapon_detail | 0.95277 | 0.95277 | yes | 209 236 | 0.000 |
| shot_overview | 0.85920 | 0.85920 | yes | 206 983 | 0.000 |

Before the fix, `depth.geoFrac` was **0.10094 at ref_00000 regardless of scene content**,
and its decoded "distances" were 7.6-21.8 m — the gun's depth, written under a
near 0.002 / far 12 projection and decoded with near 0.06 / far 12000. Not merely the wrong
geometry: a meaningless number even for the gun.

### The viewmodel still does not clip into world geometry

Two proofs.

**By construction.** The weapon is depth-tested only against a buffer it cleared to 1.0
one call earlier. That was true before and is true now; the only change is *which* texture
that buffer is. Nothing in the world writes `viewDepthTex`, so no world fragment can ever
occlude a weapon fragment.

**By measurement.** `shot_weapon_detail`, the pose that fills the frame with the gun, old vs
new with fog and TAA neutralised (`--config fogDensity=0,taaAlpha=1[,vmLegacyDepth=1]`):

```
weapon ROI   max 1   mean 0.026   frac>=2 0.000000
full frame   max 65  mean 0.035   frac>=2 0.001629
```

The weapon is pixel-identical to within one code value. Corroborated on the GPU side: the
weapon covers 209 304 px in the legacy shared buffer and 209 304 px in `viewDepthTex`.

---

## 5. WHAT THIS CHANGES FOR CONSUMERS — read this before you re-fit

Everything below is a **consequence of the buffer becoming correct**. I retuned no
consumer's constants. Poses are re-fittable against the new buffer now.

### 5a. `ssao` / `ssr` — nothing changes today, one deletion available

They read the snapshot, which is now bit-identical to `pipe.depthTex`. No image change. See
§1 for the deletion.

### 5b. `taa` — **your depth constants are now live for the first time; re-fit**

`taa.js:506` reads `pipe.depthTex`, and `uDepthTol` / `uSlopeScale` gate history rejection on
it. Until now every world pixel read as the far plane, so those constants were doing nothing
on 86 % of the frame. They now act on real geometry.

Isolated by experiment at `ref_00600`, old vs new (`--config vmLegacyDepth=1` A/B):

```
fog on,  taa on                 full-frame diff  mean 1.060   max 220
fog off (fogDensity=0)          full-frame diff  mean 0.508   max 166
fog off + taa off (taaAlpha=1)  full-frame diff  mean 0.058   max 169
```

**With fog and TAA neutralised the two arms are the same image.** The entire visible delta of
this change is those two passes reacting to correct depth. The diff map is a silhouette map —
sea-stack outlines, structure edges, the gun outline — which is the TAA signature.

Score effect is pose-dependent and currently mixed, because these constants were fitted
against the broken buffer:

| pose | old score | new score | detail axis |
|---|---:|---:|---|
| ref_00000 | 32.41 | **33.14** | 83.75 → 91.72 |
| ref_01500 | 17.00 | **19.50** | 8.91 → 24.94 |
| ref_00600 | 37.50 | 34.37 | 79.39 → 59.66 |

`ref_00600` is the pose with a bright sky-facing weapon; §5c is most of it.

### 5c. `volumetricFog` — **ACTION REQUIRED, and it is the one visible regression**

`volumetricFog.js` classifies a pixel as geometry with `dz < 0.999999` on `tDepth`, and its
header (rule 1) says *"`tDepth` — works for the viewmodel only"*. That is no longer true. The
world is now classified correctly with a real distance — which is the whole point of §18 —
**but the weapon is not classified at all**, so wherever the gun silhouettes against sky it
gets the full `uMaxDist` = 460 m of sky in-scatter integrated over it. Visible as a milky
veil on the barrel and receiver.

Measured at `ref_00600` (16.0 % of weapon pixels have sky behind them), weapon ROI, old vs new:

```
as shipped                 mean 3.338  max 220     (clouds + fog)
after the clouds fix (5d)  mean 2.301  max 126     (fog alone)
with fogDensity=0          mean 0.515  max 166     (neither)
```

Exposure across the pose set is the `weapon-over-sky` column in §4: zero at 13 poses, but
1.00 at `shot_beach_establishing`, 0.69 at `shot_cliff_vegetation`, 0.54 at
`shot_bridge_underside`, 0.24 at `shot_sky_ring`. Severity scales with in-scatter, so it is
worst on bright sky-facing poses and near-invisible on dark ones (`shot_beach_establishing`
weapon ROI moves by mean 0.05 despite 100 % sky behind the gun).

**The fix, for the fog owner** (I did not make it — it needs a new uniform in two shaders and
a decision about `tEnd`, which is design, not a rebind):

```glsl
uniform sampler2D tViewDepth;   // pipe.viewDepthTex — 1.0 == not the weapon
...
// after the tDepth / normal-mask classification, before the sea plane:
if (texture(tViewDepth, vUv).r < 1.0) { isGeo = 1.0; tEnd = 0.0; }
```

`tEnd = 0` (not a small positive number) is the physically right answer: the weapon is inside
the near plane, so there is no participating medium in front of it worth integrating. Apply
the same test in `classify()` in the upsample shader, or the bilateral will smear the
neighbouring sky's fog value back over the silhouette. Then **delete the `uUseNormalMask`
block and set `useNormalMask: false`** — its own comment says "delete this whole block the
day depth survives the frame", and that day is today. `geoMaxDist` can go with it: `tEnd`
now comes from the depth buffer, exactly, instead of being clamped to a 60 m guess.

### 5d. `clouds` — DONE, one expression, and why I touched a file I do not own

`clouds.js:1335` read `pipe.depthTex` **specifically to get the viewmodel** ("...and the
depth texture for the viewmodel, which never enters the pre-pass"), i.e. it depended on the
bug. Left as it was, the gun stops being masked and clouds render *through the weapon*
wherever it meets sky — plainly visible at `ref_00600`, weapon ROI mean 3.34 / max 220, pose
score 37.5 → 34.2.

Changed to `pipe.viewDepthTex || pipe.depthTex`. Same raw non-linear convention, so the
`< 0.999995` test below it is unchanged, and no constant in that file was touched. Revert it
if you disagree — but revert it together with a different weapon mask, not on its own.

(`cloudComposite.js:171` also reads `pipe.depthTex`, for its bilateral upsample. That one
*wants* world depth and is now correct with no change.)

### 5e. `dof` — **you can turn it back on**

`dof.js:449` ships `dofWorldDepthValid: false` and prints a self-announcing console line
every capture, because "every pixel returns CoC 0". KNOWN_ISSUES §21 calls this a feature
removed from the build by §18. The stated re-enable condition — *"the day `scene.js` stops
clearing the shared depth texture"* — is met. Set it to `true`, then re-derive
`dofViewmodelCoC`: the weapon is **not** in `pipe.depthTex` any more, so the world CoC path
will read the background behind the gun. Gate the weapon on `pipe.viewDepthTex` the same way
§5c describes for fog.

### 5f. `motionBlur` — depth is real now

`motionBlur.js:510` reads `pipe.depthTex`; its header already documents §18 as the reason its
depth-aware tile logic is inert. It is no longer inert. Re-fit.

### 5g. `ocean` refraction — depth is real now

`ocean.js:1952` copies `pipe.depthTex` into its own `depthRT` for the refraction/attenuation
path. It was copying a gun. It now copies the terrain under the water, which is what the
Snell-path extinction in that shader was written for. This is a *correction*, and it changes
the water: `ref_01500` water ROI is inside the score movement in §5b. Re-fit against it.

Note the ordering hazard the ocean already handles correctly: it binds `depthRT` *before*
sampling `pipe.depthTex`, so the texture is never sampled while attached to the bound FBO.
Keep that.

---

## 6. Cost

Priced as an interleaved same-page A/B — one page alternating `vmLegacyDepth` in blocks of 90
individually-timed frames, 20 discarded per block, two blocks per arm. Two captures would
have compared different GPU states and page ages.

```
ref_00000, p50 ms:   new 12.00   old 11.80      (block A)
                     new 14.60   old 14.50      (block B)
```

The arm difference is **0.10-0.20 ms**; the drift *between blocks of the same arm* is 2.7 ms.
The cost is below the noise floor of the instrument, which is what two `framebufferTexture2D`
calls should be. Caveat from KNOWN_ISSUES §22: `performance.now()` around `step()` is CPU
submit cost, not GPU frame time.

Memory: one extra `DEPTH_COMPONENT32F` texture at render resolution, 8.3 MB at 1080p.

---

## 7. Side finding: `tools/_ssprobe.mjs --config` has never applied anything

`__HALO__.setConfig` is `(key, value)` (`src/main.js:114`). `_ssprobe.mjs:88` calls
`H.setConfig(o)` with an **object**, which sets `ctx.config['[object Object]'] = undefined`
and returns quietly. So every `_ssprobe --config ...` invocation documented in
`reports/screenspace.md` §8 measured the default configuration.

This does **not** invalidate that report's §5 before/after table — that was measured with
`tools/capture.mjs --config`, which passes `(k, v)` correctly. It does mean any
`_ssprobe --config aoLegacyDepth=1` reading was of the shipped build.

I hit this myself: my first `--config vmLegacyDepth=1` run returned the *fixed* numbers and
looked like the A/B knob was dead. Worth one line of care in any new probe.
`tools/_depthprobe.mjs` echoes the applied config back in its output for exactly that reason.

---

## 8. Weakest things left, in order

1. **`volumetricFog` hazes the weapon** (§5c). The one regression this change introduces; a
   ~6-line fix in a file I do not own, with the patch written out above. Highest priority.
2. **`taa`'s depth constants were fitted against a buffer with no world in it** (§5b) and are
   now live. `ref_00600` detail 79.4 → 59.7 says the current values are wrong for real depth.
   `ref_00000` and `ref_01500` say they are better than nothing. Someone has to sweep
   `taaDepthTol` / `taaSlopeScale` now that the input exists.
3. **`dof` is still switched off by a flag whose condition is now met** (§5e).
4. **The snapshot in `ssao.js` is dead weight** (§1) — 8.3 MB and a full-screen draw
   reproducing a texture bit-for-bit. Pure deletion, blocked only on file ownership.
5. **The viewmodel is still absent from the G-buffer**, so it has no motion vectors, no
   normals and no material id. Every pass that wants to treat it specially has to do so
   through `pipe.viewDepthTex` as a mask. A cleaner long-term answer is a stencil bit or a
   viewmodel material id written into MRT1.b during the weapon draw — then one test serves
   fog, DoF, TAA and clouds instead of four bespoke ones. Out of scope here.
6. **`pipe.depthTex` still excludes water.** `ocean.js` compensates analytically and
   `volumetricFog` has a sea-plane term, but any future pass that assumes "depth == the
   nearest visible surface" will be wrong over the sea.

---

## 9. Files touched

* `src/render/RenderPipeline.js` — `viewDepthTex`, resize, dispose, depth-contract docs.
* `src/render/passes/scene.js` — step 7 attachment swap, `vmLegacyDepth` A/B knob, invariant
  documented in the header.
* `src/world/clouds.js` — one expression (§5d), no constants.
* `tools/_depthprobe.mjs` — new.
