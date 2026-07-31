# Integration pass — wave E

**Run window:** 2026-07-30 15:37–15:59 CDT
**GPU:** ANGLE (NVIDIA, Vulkan 1.4.341, RTX 3080 Ti)

> ## Read this first: the tree moved under this pass
>
> Concurrent agents were writing `src/` **throughout** this session. Observed write times:
>
> ```
> 15:33:01 src/render/passes/tonemap.js
> 15:36:22 src/render/passes/volumetricFog.js
> 15:56:06 src/game/weapons.js      15:59:18 src/game/weapons.js
> 15:56:23 src/world/clouds.js      15:59:22 src/world/clouds.js
> 15:56:36 src/world/rocks.js
> 15:57:38 src/world/terrain.js
> 15:58:48 src/world/vegetation.js
> 15:59:04 src/world/ocean.js       15:59:21 src/world/ocean.js
> ```
>
> Consequences for everything below, stated once:
>
> - The **score run and the showcase sheet (15:37–15:38) are a coherent snapshot** of one
>   tree state. Trust them as a pair.
> - The **error sweep and the final determinism checks (15:57–15:59) are not** — they
>   caught `ocean.js`, `vegetation.js` and `clouds.js` mid-write.
> - I have marked every result with which window it came from. Where a result is an
>   artifact of the churn rather than a real defect, I say so explicitly rather than
>   reporting it as a finding.

---

## 1. Scored run

`node tools/score.mjs --tag waveE --settle 48` — window 15:37, stable tree.

```
   # tag                      SCORE  struct   grade  percep  detail  geomet  spectr
   1 baseline-empty            0.00     0.0     0.0     0.0     0.0     0.0     0.0
   2 latest                   22.24     3.7     0.0     2.1    56.6    62.5    82.3
   3 latest                   22.24     3.7     0.0     2.1    56.6    62.5    82.3
   4 waveE                    28.62     5.1     0.0     4.7    75.2    79.4    96.6

delta since first: +28.62
best: waveE @ 28.62
```

**+6.38 over the previous run (22.24 → 28.62).** Where it came from:

| axis | before | after | delta | note |
|---|---|---|---|---|
| detail | 56.64 | 75.17 | **+18.5** | `lap_ratio` 0.757 → **0.986** — detail density now essentially matches the reference |
| geometry | 62.52 | 79.44 | **+16.9** | `edge_ratio` 0.689 → **0.891** |
| spectrum | 82.27 | 96.60 | **+14.3** | spectral slope −2.828 → **−2.575** vs ref −2.542 |
| perceptual | 2.07 | 4.66 | +2.6 | LPIPS 0.695 → 0.681 — barely moved |
| structure | 3.74 | 5.13 | +1.4 | MS-SSIM 0.341 → 0.355 — barely moved |
| **grade** | **0.00** | **0.00** | **0** | **pinned at zero; `hist` distance got *worse*, 0.889 → 0.802** |

The fog/exposure fix bought real texture-statistics wins (detail, geometry, spectrum are
close to saturated). It bought almost nothing on the two axes that carry 48% of the
weight — `structure` (0.22) and `perceptual` (0.26) are still at 5.1 and 4.7 out of 100.

**`grade` is 0.00 and has been 0.00 in every run ever recorded.** Note the scoring band:
`band(hist, 0.25, 0.75)` scores 0 for any Bhattacharyya distance ≥ 0.75. At 0.802 the
grade axis is still saturated at the floor — it cannot report progress until `hist` drops
below 0.75. It moved 0.889 → 0.802, which is genuine improvement rendered invisible by
the band. Anyone tuning the grade against this axis is tuning against a dead readout.

### Per-pose (waveE)

| pose | score | struct | grade | percep | detail | geom | spectr |
|---|---|---|---|---|---|---|---|
| ref_00840 | 31.01 | 1.39 | 0 | 0.00 | 98.73 | 90.47 | 100 |
| ref_01800 | 31.62 | 0 | 0 | 0.81 | 100 | 95.09 | 100 |
| ref_01500 | 26.08 | 0 | 0 | 3.43 | 76.47 | 69.59 | 95.71 |
| **ref_02220** | **17.11** | 0 | 0 | 0.31 | 53.68 | **21.54** | 100 |

`ref_02220` is the worst pose by a wide margin and its failure is `geometry` 21.54 —
it has roughly the right texture but the wrong shapes in frame.

---

## 2. Showcase sheet — honest cell-by-cell

`node tools/previewsheet.mjs --settle 48` → `shots/preview/preview.png` (3896×3134, 12
cells). Window 15:38, stable tree. I read each 1920×1080 source frame directly rather
than the downscaled sheet cell.

**Things true of all twelve cells**, stated once so I don't repeat them:

- The MA5B viewmodel occupies the lower-right quadrant of *every* frame at identical
  scale and position, including the two cells whose captions promise something else. It
  reads as a flat brown plank with a bright cyan "36" ammo tile — the silhouette is a
  rectangular slab, not a rifle. It is the single most prominent object in the sheet.
- Clouds are opaque cotton-wool blobs with hard edges and near-zero internal tonal
  variation. They read as polystyrene, not water vapour, and they are consistently *below*
  or *level with* distant terrain tops.
- Flat brown leaf-shaped billboard quads float unattached in mid-air in several cells.

| # | caption | what is actually in the frame |
|---|---|---|
| 01 | beach — establishing | **Broken.** Camera is under the terrain looking up. The beach hangs from the top of frame — grass tufts point *downward*, rocks hang inverted, clouds sit below the ground plane. Lower ~55% is flat featureless purple-grey. Nothing about this is an establishing shot. |
| 02 | opening shot (reference-matched) | **The best cell.** Genuinely good sand: dune ripples, varied grain, believable grass tufts, plausible depth into the distance. Faults: pale grey-green sea stacks with no surface texture; translucent rectangular panels near the left horizon (billboard quads with wrong alpha); flat blobby clouds. |
| 03 | forerunner bridge | The bridge reads as a **timber pier**, not Forerunner alloy — tan plank tiling, visible wood grain, no metal spec. Threshold (pink banded gas giant) sits right. A hard black band cuts the left mid-ground (terrain shadow/LOD seam). Tiny humanoid figures stand in the surf at right. |
| 04 | bridge underside — light shafts | Underside geometry is the most convincing structure work in the sheet — real depth, coffered beams. But **there are no light shafts.** The thin white diagonal lines crossing the sky are the Halo ring rendered as a bare sliver (see cell 11), not god rays. Stars are visible in a daylit sky. |
| 05 | hero sea stack + tree | **Sea stacks float.** Each is cut off flat at the base with a white gap between rock and water — none intersect the ocean. The "hero tree" is an unreadable dark blob on the leftmost stack. Ocean is blown to near-white with large smeared foam streaks. |
| 06 | stack gauntlet | Same floating-stack defect, clearly visible on all five stacks. Threshold's reflection is a large flat pink smear on the water with no wave modulation. Stacks have a green moss cap that stops at a hard line. |
| 07 | shoreline — foam + wet sand | **Humanoid figures standing in the surf** — brown/white low-poly, reading as scarecrows. Foam covers nearly the whole beach as grey-white noise; "wet sand" is an undifferentiated grey mush with no wetness gradient and no specular. |
| 08 | waterline — refraction + caustics | **Neither refraction nor caustics is visible.** A red/white toy-robot-like figure stands centre-frame in the water. The waterline is a hard horizontal band; beyond it a flat pale-green translucent slab. Foreground is grey mush. |
| 09 | tide pools | **A crowd of ~12 low-poly humanoids** (blue, orange, yellow, brown) stands in the shallows, plus one blown-out white glowing blob. Reads as a placeholder character test accidentally left in the showcase. Pools themselves are grey/white noise puddles, not water. |
| 10 | cliff + vegetation | **Broken, same as 01** — camera below terrain. Flat purple-grey fills the lower left; grass hangs downward; dozens of flat brown quads float free in the air. Threshold dead-centre. |
| 11 | halo ring + threshold | **The ring is two thin parallel white lines.** No band, no inner-surface terrain, no width — this is the "light shaft" artifact from 04/05/07 identified. Threshold renders acceptably (banding, limb) but is very close and very pink. Sun is a small dot. Stars in daylight. |
| 12 | MA5B viewmodel | **Not a viewmodel shot** — a wide beach at the same camera framing as every other cell, weapon at identical size. Additionally the sand here shows a strongly repeating cobblestone pattern of dark rounded blobs tiling across the whole beach. |

### The three things worth fixing first, by impact on the sheet

1. **Two of twelve showcase poses (01, 10) put the camera under the terrain.** A pose or
   terrain-height regression. Cheapest possible win.
2. **The Halo ring — the title object — renders as a 1px line.** It is misread as a
   rendering artifact in four separate cells.
3. **Character models are standing in three showcase cells** (07, 08, 09) and read as
   placeholder junk.

---

## 3. Is the desaturation fixed? — **Partially. It closed about half the gap.**

Whole-frame means across all 9 scored poses (window 15:37).

| metric | before | **waveE** | target asked for | ref (measured) | verdict |
|---|---|---|---|---|---|
| `sat_mean` | 40.05 | **57.10** | 83.9 | 79.14 | **~44% of the gap closed; still 22.0 short of ref** |
| `lum_mean` | 106.67 | **105.43** | 107.8 | 105.40 | **on target — delta +0.03** |
| `p50` | — | **105.89** | 105 | 99.44 | **on target — 105.89 vs 105** |

Quoting the numbers as asked:

- **`sat_mean` 57.10** against a 83.9 target and a 79.14 measured reference. Not fixed.
  It moved 40.05 → 57.10, so the fog change was real and in the right direction, but the
  frame is still **28% under-saturated** relative to the reference.
- **`lum_mean` 105.43** against 107.8 asked / 105.40 reference. **Fixed** — within 0.03 of
  the reference.
- **`p50` 105.89** against 105 asked. **Fixed** — but note it now sits *above* the
  reference's own p50 of 99.44, i.e. it overshot the reference by +6.4.

### The remaining error is contrast, not brightness

Luminance is nailed on average but the *distribution* is badly compressed:

| metric | render | ref | delta |
|---|---|---|---|
| `lum_std` | 35.44 | 52.36 | **−16.92** |
| `p01` | 24.56 | 15.67 | **+8.89** (shadows lifted) |
| `p99` | 203.22 | 222.11 | **−18.89** (highlights crushed) |
| `local_contrast` | 0.128 | 0.194 | −0.066 |
| `shadow_frac` | 0.037 | 0.057 | −0.020 |
| `highlight_frac` | 0.0029 | 0.0088 | −0.0059 |
| `lab_b` | −5.45 | −1.59 | −3.86 (still too blue) |

Both tails are pulled toward the middle: blacks are +8.9 too bright and whites are −18.9
too dark, which is exactly the signature of a residual additive haze — the same mechanism
KNOWN_ISSUES §8 identified in `volumetricFog.js`. **The fog fix reduced the term but did
not eliminate it.** Chasing the remaining `sat_mean` with grade saturation would be a
mistake; the tell is that `p01` is lifted, which saturation cannot cause.

> **Retraction (added by a later wave):** the additive-haze *signature* read here was real,
> but `volumetricFog.js` is the wrong file for it. `--skip volumetricFog` measured
> byte-identical (`reports/vegetation.md`); the source was `scene.js` clearing the depth
> texture shared with the G-buffer, per `docs/KNOWN_ISSUES.md` §18. By Wave H the signature
> itself is gone — `p01` is 14.89 against a reference 15.67 while `p99` is still crushed,
> which is an exposure shoulder in `tonemap.js`, not an additive term (§8's Wave-H note).
> The "do not chase it with grade saturation" warning still stands. Registered as
> `fog-owns-desaturation` in `tools/refuted.json`.

Per-pose `sat_mean` is also strikingly *flat* — render 53.0–65.4 (range 12.4) against a
reference spanning 63.3–105.2 (range 41.9). The scene is not just under-saturated on
average, it fails to vary chroma between shots the way the reference does.

---

## 4. Determinism

### Result: **DETERMINISTIC on a quiesced tree — but only after fixing an RNG I found here.**

Sequence, in order:

1. **Initial check (15:41), before any fix:** `DETERMINISTIC`. This was a false pass — see
   below.
2. **After fixing the `physics` init crash:** `BROKEN`. Two captures differed across
   934,388 px (45% of frame), max channel delta 100, bbox covering the entire ground
   plane; sky and viewmodel were byte-identical.
3. **Root-caused, fixed, re-verified (15:50): `DETERMINISTIC` across three consecutive
   captures**, with physics live.
4. **Final checks (15:57, 15:59): `BROKEN`** — but this is the concurrent-edit churn, not
   a regression. `weapons.js`, `ocean.js` and `clouds.js` were all rewritten *between* the
   two captures being compared. Not a real finding.

### Why the first check was a false pass

Determinism appeared to hold only because the `physics` module was **crashing at init and
being disabled**, which freed enough CPU budget that the race never lost. Repairing
physics exposed it. The grep the task specifies found the cause:

```
src/gfx/materialCommon.js:171:
  const key = `wm:${o.matId ?? 0}:${o.inject?.key || Math.random().toString(36).slice(2)}`;
```

This is the `customProgramCacheKey` for every world material without an explicit
`inject.key`. Seeded from `Math.random()`, it made the WebGL program cache key different
on every run. Corroborating evidence: `programs` was observed at **106 in one capture and
107 in the next** on an identical scene.

Fixed by replacing the RNG with a monotonic counter (`src/gfx/materialCommon.js`) — this
preserves the exact uniqueness guarantee the random value provided (no two anonymous
materials ever collide) while being reproducible, because module init order and
per-module material creation order are both fixed. After the fix: three consecutive
byte-identical captures, `programs` stable at 106.

Full grep result for the record — every other hit is self-timing only and touches no
pixel:

```
src/gfx/materialCommon.js:171  Math.random()   <-- THE BUG, fixed
src/game/hud.js:1018,1051      performance.now()   module CPU cost only
src/world/ocean.js:1269,1296   performance.now()   module CPU cost only
src/world/rocks.js:1371,1668   performance.now()   build time only
src/render/env.js:660,700      performance.now()   refresh cost only
src/game/audio.js:1347..1443   performance.now()   module CPU cost only
src/game/ai.js:1402,1433       performance.now()   module CPU cost only
src/core/Engine.js:139..230    performance.now()   frame/init timing only
```

### A second, still-open fragility

Determinism at `--settle 48` is **marginal**. Before I found the RNG, the same race was
also curable by raising settle: at `--settle 200` the two captures were byte-identical
even with the RNG present. The harness has little headroom — an async convergence that
lands on a different frame index will silently produce a different image. `--settle 48`
is not a safety margin, it is roughly the minimum that works.

---

## 5. Errors, exceptions, failed modules and "not loaded" lines — verbatim

### 5a. `physics` failed to init on every capture — **FIXED (mine)**

Present on every run at session start:

```
[error] [engine] module "physics" failed to init and was disabled:
 ReferenceError: addStatic is not defined
```

```
"failedModules": [
  {
    "name": "physics",
    "error": "ReferenceError: addStatic is not defined\n    at Object.addStatic (http://127.0.0.1:29459/src/game/physics.js:237:9)\n    at collectColliders (http://127.0.0.1:29459/src/game/physics.js:477:58)\n    at Object.init (http://127.0.0.1:29459/src/game/physics.js:225:7)\n    at Engine.init (http://127.0.0.1:29459/src/core/Engine.js:140:19)\n    at async http://127.0.0.1:29459/src/main.js:39:3"
  }
]
```

**The entire physics module has been dead in every capture and every score ever recorded.**

### 5b. Malformed colliders — **PARTIALLY FIXED (mine); one left open by design**

Once physics initialised, the warnings it had been crashing *before* reaching appeared:

```
[warn] [physics] ignoring malformed collider (type="capsule") — see docs/API.md for the required fields per type
[warn] [physics] ignoring malformed collider (type="box") — see docs/API.md for the required fields per type
[warn] [physics] ignoring malformed collider (type="sphere") — see docs/API.md for the required fields per type
```

Producer/consumer contract audit (`validCollider`, physics.js:107):

| producer | type | emits | verdict |
|---|---|---|---|
| props.js:804 | sphere | `center: Vector3` | ok |
| props.js:859 | capsule | `a`/`b: Vector3` | ok |
| props.js:1040 | box | `box: Box3` | ok |
| structures.js:1055 | capsule | `a`/`b: Vector3` | ok |
| **structures.js:1042,1049** | **box** | `center`+`quaternion`+`halfExtents` | **REJECTED — still open** |
| **rocks.js:544** | **capsule** | `a`/`b` as plain **arrays** | **REJECTED — fixed** |
| **rocks.js:757** | **box** | `center`+`halfExtents` as arrays | **REJECTED — fixed** |
| **rocks.js:1657** | **sphere** | `center` as plain array | **REJECTED — fixed** |

**Every collider `rocks.js` produced was being discarded** — all sea stacks, cliffs and
boulders were non-solid. Fixed (arrays → `Vector3`/`Box3`); capsule and sphere warnings
are now gone.

**Still open, deliberately not fixed:** `structures.js` emits its bridge deck and railings
as **oriented** boxes (`center`+`quaternion`+`halfExtents`). `validCollider` has no OBB
case and `computeAabb` cannot represent one. Converting to an axis-aligned `Box3` would
silently discard the rotation and give the bridge wrong collision. **This is a physics API
gap, not a typo — it needs an owner decision**, so I left the warning in place rather than
paper over it.

### 5c. Shader errors — verbatim, but **in-flight code**

Captured at 15:57, with `ocean.js` and `vegetation.js` mid-write. Reported for the record;
these are almost certainly transient partial edits, **not** settled defects.

```
[error] [engine] module "vegetation" failed to init and was disabled:
 ReferenceError: topPoint is not defined
    at Object.init (http://127.0.0.1:29459/src/world/vegetation.js:1650:22)
```

```
[error] THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false
Material Type: RawShaderMaterial
Program Info Log: Fragment shader is not compiled.
FRAGMENT
ERROR: 0:339: 'stepAt' : no matching overloaded function found
ERROR: 0:360: 'stepAt' : no matching overloaded function found
  338:   float seg = tOut - tIn;
> 339:   float step = stepAt(tIn);
```

```
[error] THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false
Material Type: RawShaderMaterial
Program Info Log: Fragment shader is not compiled.
FRAGMENT
ERROR: 0:393: 'lodAmp' : undeclared identifier
ERROR: 0:439: 'oc_surface' : no matching overloaded function found
ERROR: 0:439: '=' : dimension mismatch
ERROR: 0:439: '=' : cannot convert from 'const mediump float' to 'highp 3-component vector of float'
  392:   float sw = oc_swash(p, h, front);
> 393:   P.y += sw * lodAmp;
```

```
[error] THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false
Material Type: RawShaderMaterial
Program Info Log: Vertex shader is not compiled.
VERTEX
ERROR: 0:400: 'lodAmp' : undeclared identifier
ERROR: 0:437: 'oc_wave' : no matching overloaded function found
ERROR: 0:437: '=' : cannot convert from 'const mediump float' to 'structure 'OcWave' (symbol id 3164)'
ERROR: 0:444: 'oc_surface' : no matching overloaded function found
ERROR: 0:444: '=' : dimension mismatch
FRAGMENT
ERROR: 0:448: 'lodAmp' : undeclared identifier
```

```
[warn] WebGL: INVALID_OPERATION: useProgram: program not valid          (x20+)
[warn] [.WebGL-0x5e4000f6000] GL_INVALID_OPERATION: glDrawElements: Feedback loop formed between Framebuffer and active Texture.
```

The **framebuffer feedback loop** is worth a second look independently of the churn — a
pass is sampling the texture it is currently rendering into. That is a real pipeline bug
whenever it occurs, not a syntax error.

### 5d. Transient module-load failure

```
[warn] [modules] not loaded:
  terrain: Unexpected identifier 'roughnessFactor'
[warn] [props] terrain unavailable at init — scattered against the docs/WORLD.md beach profile instead; positions are approximate.
```

`terrain.js` parses and loads cleanly now (verified via `vm.SourceTextModule` → `PARSE OK`
and a clean 818 ms init). This was a partial write by a concurrent agent. Noting it
because it demonstrates the degradation path works — but also that **`props` silently
falls back to approximate positions when terrain is missing**, which would quietly
invalidate a score run if it happened unnoticed.

### 5e. `__HALO_MISSING__` / "not loaded"

Empty (`missing: []`) on every stable-tree capture. No module is permanently missing.

---

## 6. Performance

### Whole-frame timing was structurally unmeasurable — **FIXED (mine)**

Every `perf` block in `scores/*.json` and `history.jsonl` reads:

```json
"perf": { "fps": 0, "ms": 0, "drawCalls": 601, "tris": 14057892 }
```

`Engine.stats.ms`/`.fps` were only updated inside `start()`'s `requestAnimationFrame`
tick. Every headless capture uses `advance(n)`, which calls `step()` directly and never
touches the accumulators. **Every frame-time number this project has ever recorded was a
structural zero.** Fixed by instrumenting `advance()` in `src/core/Engine.js`.

### Real numbers (steady state: 20 warm-up frames discarded, 90 samples, `--settle 48`)

| pose | p50 ms | p95 ms | mean ms | draws | tris |
|---|---|---|---|---|---|
| ref_00000 | 4.90 | 5.60 | 5.04 | 596 | 13,067,200 |
| shot_stack_gauntlet | 4.70 | 5.20 | 4.76 | 575 | 12,904,456 |
| shot_bridge_underside | 5.40 | 8.20 | 6.70 | 638 | 14,354,408 |
| shot_tide_pools | 6.60 | 9.70 | 8.06 | 648 | 15,336,424 |
| **shot_hero_stack** | 5.90 | **10.80** | 8.93 | 607 | 14,052,200 |
| **shot_water_edge** | 6.00 | **10.90** | 8.53 | 594 | 13,358,768 |

**Nothing exceeds 11 ms at p50 — the scene is comfortably inside budget on typical
frames.** Median cost is ~5–6 ms (160–200 fps equivalent).

**Flag: `shot_hero_stack` (10.80) and `shot_water_edge` (10.90) sit within 0.2 ms of the
11 ms bar at p95.** Both are the two most ocean-dominated poses in the set, which points
at **`ocean`** as the subsystem to watch. I could not confirm this by A/B: the `--skip`
attribution runs all returned identical `drawCalls`/`triangles`, and the runs that did
differ landed inside the concurrent-edit window, so **I am naming `ocean` as the suspect
on correlation, not proof.** It needs a clean re-measure on a quiesced tree.

Also observed: occasional single-frame spikes to 79–130 ms, consistent with lazy shader
compilation on first use of a material. These do not affect p50/p95 but would be visible
as a hitch in real play.

### Geometry load

**12.9M–15.3M triangles and 575–648 draw calls per frame** is heavy for the visual result
being returned — cell 02 is the only frame whose detail plausibly justifies ~13M
triangles. Worth a pass on whether rock/vegetation LOD is engaging at all; `rocks` is also
by far the most expensive init at **1437 ms** (vs `terrain` 823 ms, `weapons` 645 ms).

*(Note: `stats.modules[].ms` are **init/build** costs, not per-frame costs. There is no
per-subsystem per-frame breakdown available; the whole-frame numbers above are measured
directly.)*

---

## 7. Fixes applied

All four are small, mechanical, and verified. **Score is unchanged at 28.62 (`waveE-fix`
== `waveE`) — every fix is visually neutral, as intended.**

| # | file | change | evidence |
|---|---|---|---|
| 1 | `src/game/physics.js:237-240` | `addStatic._warned` → `api.addStatic._warned`. `addStatic` is an object-literal method, so the bare identifier had no binding and threw on the first malformed collider, killing the module. | `failedModules: []`, physics inits in 1 ms |
| 2 | `src/world/rocks.js:545,758,1839` | Colliders emitted as plain arrays → `THREE.Vector3` / `THREE.Box3`, matching the `validCollider` contract. | capsule + sphere warnings gone |
| 3 | `src/gfx/materialCommon.js:116,182` | `Math.random()` program-cache key → monotonic counter. Same uniqueness guarantee, reproducible. | 3 consecutive byte-identical captures; `programs` stable at 106 |
| 4 | `src/core/Engine.js:225-238` | Instrument `advance()` so headless captures record real frame time. | `ms 10.45 / fps 95.7` where it was `0 / 0` |

Also added `tools/_intprobe.mjs` — steady-state frame timing + collider census probe.

### Deliberately NOT fixed

- **`structures.js` oriented-box colliders** (§5b) — needs an OBB decision in the physics
  API; a mechanical conversion would silently break bridge collision.
- **All shader errors in §5c** — files were being written as I read them.
- **Everything in §2** — visual/authoring work, not integration bugs.

---

## 8. Recommended next actions, ranked

1. **Re-run the score on a quiesced tree.** Every number in §1–§3 predates the 15:56–15:59
   edits to `ocean`, `clouds`, `weapons`, `terrain`, `vegetation`. This pass cannot tell
   you what those did.
2. **Fix the two under-terrain showcase poses (cells 01, 10).** Cheapest visible win.
3. **The Halo ring renders as a 1px line** and is being misread as an artifact in four
   cells. It is the title object.
4. **Remove the character models from showcase cells 07/08/09**, or make them look
   intentional.
5. **Finish the fog in-scatter removal.** `sat_mean` 57.10 vs 79.14 and the two-tailed
   compression (`p01` +8.9, `p99` −18.9) say the additive term is reduced, not gone. Do
   not compensate with grade saturation.
6. **Re-band the `grade` axis or stop reporting it.** It has read 0.00 in every run ever
   recorded and hid a genuine 0.889 → 0.802 improvement.
7. **Give `--settle` more headroom** (§4) — 48 is near the minimum that converges.
8. **Investigate the framebuffer feedback loop** (§5c) independently of the churn.
