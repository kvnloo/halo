# poses — `src/world/poses.js`

Wave H. Owner file: `src/world/poses.js` only. New probe: `tools/_posecheck.mjs`.

Brief: fix KNOWN_ISSUES **17.1** (two showcase cameras under the terrain), then audit every
pose in the file the same way and leave a check behind so it cannot regress silently.

---

## 0. TL;DR

| | |
|---|---|
| Poses under the terrain, before | 2 of 28 (`shot_beach_establishing` −0.21 m, `shot_cliff_vegetation` −0.30 m) |
| Poses under the terrain, after | 0 of 28 (`node tools/_posecheck.mjs` → 0 FAIL, 0 WARN) |
| Showcase cells that did not show their caption's subject, before | **6 of 12** — 17.1's two, plus BOTH bridge cells (aimed 180° away from the bridge), plus `shot_water_edge` and `shot_weapon_detail` from 17.5 |
| Showcase cells changed | 7 (`beach_establishing`, `forerunner_bridge`, `bridge_underside`, `stack_gauntlet`, `water_edge`, `cliff_vegetation`, `weapon_detail`) |
| `ref_*` scored poses changed | **0** |
| ms cost | 0 — this file is a data table, it is not in any frame's critical path |

Two findings that are *not* pose bugs and belong to other owners are in §6.

---

## 1. 17.1 reproduced without rendering anything, then fixed

`terrain.js` exposes the same analytic height field on the CPU (`terrain.height(x,z)`,
built by `buildTables()` at init) that `FIELD_GLSL` evaluates on the GPU and that
`physics.raycast`/`physics.moveCharacter` march. It needs no GPU, so the whole pose table
can be audited in about two seconds:

```
node tools/_posecheck.mjs
```

`terrain.init()` throws partway through (it wants a renderer to bake textures), but the
1-D LUTs and `buildTables()` run *before* that, so `height()` is live. The probe catches
the throw and only bails if `height()` is unusable.

Before, eye-above-ground for the two named poses:

```
shot_beach_establishing   eye 1.74   ground 1.95   clearance -0.21   <- buried
shot_cliff_vegetation     eye 2.40   ground 2.70   clearance -0.30   <- buried
```

Confirmed in the image (`shots/poses/before_shot_*.png`): terrain underside overhead,
pebbles hanging downward, clouds below the ground plane. A ray-march of the height field
over a 48×27 grid of pixel directions puts **52%** of `shot_beach_establishing`'s frame on
nothing at all, which is the "~55% flat void" the integration report measured off the sheet.

Root cause, and the reason it will happen again: **`pos[1]` is an absolute world Y, not a
height above ground.** `terrain.js` is re-profiled nearly every wave. Any pose written as a
literal Y silently sinks. That is now a checked contract — see §4.

After:

```
shot_beach_establishing   pos [12.0, 3.67, 24.0]    ground 1.95   clearance 1.72
shot_cliff_vegetation     pos [86.0, 8.99,  6.0]    ground 7.27   clearance 1.72
```

Every showcase pose is now authored as `terrain.height(x,z) + EYE_STAND` (1.72 m, the value
`player.js` uses for `T.eyeStand`).

---

## 2. The audit found four more broken cells, two of them worse than 17.1

### 2.1 Neither bridge cell contained the bridge

`shot_forerunner_bridge` (yaw 78) and `shot_bridge_underside` (yaw 84) were both aimed at
**yaw ≈ 80**, i.e. forward ≈ (−1, 0, 0), straight down −X.

The deck, read out of `structures.js` headlessly (`bridge.matrixWorld`, deck local z 0→132):

```
local z   0 -> world (80.0, 21.5,  42.7)     cliff abutment
local z  60 -> world (69.9, 21.5, -16.4)     mid-span
local z 132 -> world (57.8, 21.5, -87.4)     sea end
collider AABB  x 54.1 .. 91.7,  y 18.9 .. 21.5,  z -65.9 .. 67.7
```

The bridge is entirely in **+X**. Both cameras were pointed 180° away from it. This is not
a framing nicety — the two cells named after the title structure contained no structure.
(`shot_beach_establishing`, at yaw 296, has always had it; that is why the defect survived.)

Fixed by aiming at the deck:

```
shot_forerunner_bridge  pos [14.0, 2.14,  6.0]  rot [18, 288, 0]  fov 78   full span, side on
shot_bridge_underside   pos [70.0, 2.52,-16.0]  rot [42,  10, 0]  fov 82   under mid-span, along the soffit
```

`shots/poses/br_tmp1.png` and `br_tmp4.png` are the verification frames.

I have added the yaw convention to the file header, because getting it backwards is
evidently easy: `forward = (−sin yaw, sin pitch, −cos yaw)`; yaw 0 → −Z, 90 → −X, 180 → +Z,
270 → +X.

### 2.2 `shot_water_edge` ("refraction + caustics") had almost no water in it

Classifying every ray hit by submerged depth: the old pose put **6%** of the frame on water
shallower than 1.5 m, most of the rest on wet shingle, and the water surface it did contain
was at the horizon where you see reflection, not refraction. A search over standable
positions (`ground` in 0.05..1.2 m) × yaw × pitch, maximising shallow-water pixel fraction:

```
old  pos [-30.0, 0.85,-12.0] rot [ -6,   4, 0] fov 68    shallow  6%
new  pos [-45.0, 1.84,-10.0] rot [-28,  45, 0] fov 66    shallow 59%,  deep 6%, dry 24%, sky 14%
```

The new frame looks *through* the surface at the bed, with foam and the wave-height
gradient across it (`shots/poses/tmp1.png` from the first round).

### 2.3 `shot_cliff_vegetation` was aimed where vegetation cannot exist

Fixing the height alone would not have fixed this cell. `vegetation.js` derives its accept
region from `buildScoredViews()` — a candidate cell is only planted if **at least one
`ref_*` camera can see it**. Replicating that gate exactly (3 m cells, `y+0.7`, maxDist 320)
and applying the file's own per-layer predicates:

```
cliff curtains  (slope > 0.78, y > 12, d < 320)   n=160   x  96..300   z 47..62
lip / moss      (0.30 < slope < 0.90, y > 12)     n=1009  x-300..300   z 44..98
trees           (y > 18, slope < 0.40, d < 340)   n=5042  x-300..300   z 59..200
```

The only terrain steep enough for hanging cliff growth is the **east headland, x 96..300**.
The old pose stood at (24, ·, 30) aimed at yaw 40 — out to sea, away from all of it. New
pose stands on the dune shelf below the headland's undercut face:

```
shot_cliff_vegetation  pos [86.0, 8.99, 6.0]  rot [18, 218, 0]  fov 74
                       340 cliff/lip cells in frame, nearest 33 m; 1613 tree cells on the rim
```

### 2.4 `shot_weapon_detail`: the `fov` field cannot do what it was set for

The old pose used `fov 58`, i.e. someone narrowed the camera to make the gun bigger. It
does the opposite. `passes/scene.js` renders the viewmodel through `pipe.viewCamera`, a
**hard-coded 55° camera** (`RenderPipeline.js:131`), whose only per-frame update is aspect.
The pose's `fov` therefore magnifies the *world* while the gun stays exactly the same size.

Measured, same position and rotation, `--skip weapons` differencing for the mask:

```
fov 58    207 311 px    10.00% of frame
fov 95    207 503 px    10.01% of frame      delta 0.09%
```

So a "detail" cell is impossible from `poses.js` alone; all a pose can pick is the backdrop.
Ranking candidates by |gun luminance − surround luminance| and by the gun's own tonal
spread (how much of its form reads):

```                       gun_lum  surround  |Δ|   gun_std
beach, pitch -14, fov 58    59.2     102.6   43.4    23.7    (old)
beach, pitch  18, fov 78    51.7      87.2   35.5    38.3
water, pitch  12, fov 70    64.9     113.4   48.5    54.2
bridge underside,   fov 78  42.4     105.8   63.4    28.1    (highest Δ, flattest gun)
```

Chosen: `pos [8.0, 1.74, 18.0] rot [10, 292, 0] fov 88` — the opening beach, pitched up
enough that the receiver sits against bright water and sky rather than mid-tone shingle,
and wide enough that world detail stops competing with a gun whose size is fixed.

**This one needs an owner outside my file.** If a real weapon-detail cell matters, make
`pipe.viewCamera.fov` pose-driven (`RenderPipeline.js` / `passes/scene.js`).

### 2.5 `shot_stack_gauntlet`

Framing only: at pitch 4 the stacks sit on the horizon line and read as a smear. At pitch 12
the four stacks, their trees and the ring all separate. Changed `rot[0]` 4 → 12.
`shot_hero_stack`, `shot_shoreline`, `shot_tide_pools`, `shot_sky_ring`, `shot_overview`
were audited and left alone.

---

## 3. Full audit table (current tree)

`node tools/_posecheck.mjs`, all 28 poses, worst clearance first:

```
pose                       eyeY     groundY   clear    min    status
ref_00000                  1.74     1.48      0.26     0.10   ok
diag_gun                   1.74     1.48      0.26     0.10   ok
shot_weapon_detail         1.74     1.19      0.55     0.40   ok
ref_00120                  1.74     0.98      0.76     0.10   ok
ref_00720                  1.74     0.64      1.10     0.10   ok
shot_sky_ring              1.74     0.58      1.16     1.00   ok
ref_02220                  1.74     0.56      1.18     0.10   ok
ref_00450                  1.74     0.56      1.18     0.10   ok
ref_00600                  1.74     0.52      1.22     0.10   ok
ref_01500                  1.72     0.23      1.49     0.10   ok
shot_shoreline             1.30    -0.25      1.55     1.20   ok
ref_00840                  1.74     0.17      1.57     0.10   ok
shot_hero_stack            1.74     0.07      1.67     1.40   ok
shot_beach_establishing    3.67     1.95      1.72     1.40   ok
shot_cliff_vegetation      8.99     7.27      1.72     1.40   ok
shot_bridge_underside      2.52     0.80      1.72     1.40   ok
shot_forerunner_bridge     2.14     0.42      1.72     1.40   ok
shot_tide_pools            1.55    -0.17      1.72     1.20   ok
shot_water_edge            1.84     0.12      1.72     1.40   ok
ref_01800                  1.70    -0.03      1.73     0.10   ok
diag_water                 2.20    -0.05      2.25     1.00   ok
shot_stack_gauntlet        1.74    -0.78      2.52     1.40   ok
diag_stack                 3.00    -1.72      4.72     1.00   ok
diag_bridge                6.00    -0.23      6.23     1.00   ok
diag_sky                  12.00     0.24     11.76     4.00   ok
diag_zenith               12.00     0.24     11.76     4.00   ok
diag_terrain              26.00     5.69     20.31     4.00   ok
shot_overview             46.00     7.80     38.20    20.00   ok

28 poses: 0 FAIL, 0 WARN, 28 ok
```

---

## 4. The regression gate

Three layers, cheapest first.

1. **`selfCheck()` runs at module import**, in node *and* in the browser. It throws if any
   pose has a malformed `pos`/`rot`/`fov`, or if a pose has no `POSE_GROUND` entry, or if
   `POSE_GROUND` has an entry for a pose that no longer exists. A thrown module is at least
   loud; §20's lesson is that silence is the expensive failure.
2. **`POSE_GROUND`** stores, per pose, the `terrain.height()` at the moment the pose was
   last verified, plus the minimum eye-above-ground it is allowed to have (1.40 m for a
   standing showcase camera, 0.10 m for the immovable `ref_*` set).
3. **`auditPoses(terrain)` / `assertPosesAboveGround(terrain)`** re-derive the ground from
   the live terrain module and report `FAIL` (buried, or below `minClear`) / `WARN` (the
   ground has drifted more than 0.60 m from the bake, so the shot has changed even though
   the camera is still above it). A second, independent witness is used where available:
   `terrain.raycast` returns `null` outright when the origin is below the surface, so a
   buried pose fails two different tests for two different reasons.

The gate is verified to fire, not just to exist. Injecting a terrain that returns 3.0 m
everywhere:

```
injected +3 m ground: FAIL count = 22 of 28
  shot_shoreline: camera is 1.70 m UNDER the terrain
  shot_beach_establishing: clearance 0.67 m < required 1.40 m
assertPosesAboveGround threw as expected
drift-only case (ground 1.07 m below the bake): WARN "ground moved -1.07 m since this
  pose was verified — recheck the framing, then rebake"
```

Run `node tools/_posecheck.mjs` after any terrain edit; `--rebake` prints fresh `groundY`
values for a deliberate move.

---

## 5. The `ref_*` poses are NOT moved, but they are 1.2–1.5 m out of register with the beach

Not actionable inside this file, recorded so the next pose-refit task has the number.

The scored poses all sit at an absolute `y ≈ 1.74`, which was written as "eye height of a
standing player" back when the beach was near y = 0. The beach is no longer near y = 0:

```
ref_00000   ground 1.48   eye is 0.26 m above the sand
ref_00120   ground 0.98   eye is 0.76 m above the sand
ref_00450   ground 0.56   eye is 1.18 m above the sand
ref_01800   ground -0.03  eye is 1.73 m above the sand   (correct, it is at the waterline)
```

At `ref_00000` — the pose the whole score history is anchored on — the camera is **26 cm off
the ground**, effectively lying on the beach, where the reference video is a standing Chief.
So the near-field foreground geometry of the highest-weighted scored frame is at the wrong
scale. Either the beach profile rises too fast east of the waterline, or the poses need
refitting with `y = height(x,z) + 1.72`. Both are outside this task (KNOWN_ISSUES §3: a
refit invalidates every recorded score, and needs its own owner and one clean re-baseline).
`auditPoses` will keep reporting the clearances so whoever takes it has the data.

---

## 6. Two things I measured that are somebody else's

### 6.1 A build changed under me mid-audit — §16 is real and it cost me an hour

`shots/poses/a_shot_hero_stack.png` and `a_shot_stack_gauntlet.png`, captured in a batch,
came back with the sea stacks clipped to flat white — the same "sea stacks missing / float"
symptom §17.4 describes. I nearly re-aimed both poses on the strength of it.

Before doing that I ran the separating experiment: capture the *identical* pose again.

```
shot_hero_stack, identical pose, four captures, current tree
  standalone #1                lum 105.06  p99 217  hl 0.0058  sat 59.2
  standalone #2                lum 105.06  p99 217  hl 0.0058  sat 59.2
  after shot_bridge_underside  lum 105.06  p99 217  hl 0.0058  sat 59.2
  after shot_tide_pools        lum 105.06  p99 217  hl 0.0058  sat 59.2
earlier batch, same pose         lum  95.04  p99 227  hl 0.0112  sat 51.5
```

Byte-stable and order-independent *now*, and materially different from the frame taken
~40 minutes earlier. So it was not the pose, not the framing, not exposure keying and not
daemon state leaking between poses — another agent's edit landed in `src/` between the two
captures. **Any showcase or ROI measurement taken during a concurrent wave has an unpinned
build under it.** Re-verify before you act on one; the frame you are looking at may not be
the frame the tree produces now.

(Corollary for whoever reads the Wave G/H sheets: a defect seen in one sheet cell and not
reproducible from a single-pose capture is probably this, not the subsystem.)

### 6.2 The Halo ring, in every showcase cell that contains it

Renders as a pale blue vertical band of speckled noise with green blotches (see
`shots/poses/final_shot_hero_stack.png`, `final_shot_stack_gauntlet.png`). It is the title
object of the project and it appears in 5 of the 12 cells. Already §17.2; still open.

---

## 7. Verification

- `node tools/parsecheck.mjs` — ok, 42 files, no GLSL template hazards.
- `node tools/_posecheck.mjs` — 28 poses, 0 FAIL, 0 WARN.
- All 12 showcase cells re-captured on the current tree at `--settle 48` into
  `shots/poses/final_shot_*.png` and looked at individually. Every cell now contains the
  subject its caption names. The captures themselves prove `selfCheck()` passes in the
  browser: it throws at import, so a bad table would have taken the whole build down
  rather than producing a frame.
- ms cost: none. `poses.js` is a data module read once at `setPose`; `auditPoses` is only
  ever called by the offline probe.

## 8. Weakest thing left

`shot_weapon_detail` still is not a detail shot and cannot become one from this file — the
viewmodel is 10.0% of the frame at every pose because `pipe.viewCamera` is a fixed 55°
camera. Whoever owns `RenderPipeline.js` / `passes/scene.js` should make that fov
pose-driven; until then the cell is "MA5B on the beach", not "MA5B viewmodel".

## 9. Files

- `src/world/poses.js` — the pose table, `POSE_GROUND`, `EYE_STAND`, `selfCheck()`,
  `auditPoses()`, `assertPosesAboveGround()`, `SHOWCASE_POSES`.
- `tools/_posecheck.mjs` — headless gate. `node tools/_posecheck.mjs [--rebake]`.
- `shots/poses/before_shot_*.png` — the 17.1 defect as shipped.
- `shots/poses/final_shot_*.png` — the 12 showcase cells after the fix.
