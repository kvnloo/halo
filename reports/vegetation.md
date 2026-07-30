# vegetation — rework pass (owner: src/world/vegetation.js only)

## READ THIS FIRST: the scene moved under this pass, four times

Every screen-space number in the review brief (hero blob at x745-985 / y330-500, cliff
mass at x2-390, near-beach box x40-330 y860-930) was taken against a build that no
longer exists. During this session `terrain.js`, `rocks.js`, `ocean.js`, `clouds.js`,
`volumetricFog.js`, `tonemap.js` and `structures.js` were all edited by concurrent
agents. Measured evidence of the churn, all at `ref_00720`, same pose, same settle:

| capture | whole-frame sat_mean | lab_b (nearbeach box) |
|---|---|---|
| session start        |  39.2 | + 4.11 |
| ~30 min in           |  63.1 | + 4.00 |
| ~50 min in           |  —    | − 4.00 |
| ~70 min in           |  —    | + 7.74 |

The hero tree is no longer at x745-985: `rocks.js` moved `stack_hero`, and the tree now
renders top-left. The reference's near-beach box is now bare sand in our render because
the beach itself was re-profiled. **Any A/B here is only valid between two captures taken
minutes apart; cross-era comparisons in this file are labelled as such.**

Also measured, and it is not mine: **the renderer is currently non-deterministic.** Two
back-to-back captures of the identical build differ:

```
node tools/capture.mjs --pose ref_00720 --out shots/d1.png --settle 48   # x2
cmp shots/d1.png shots/d2.png   -> differ, 8.15% of pixels, bbox y495-1079 x714-1918
node tools/capture.mjs --pose ref_00720 --skip vegetation ... x2 -> ALSO differ
```
Vegetation off, it still differs, in the ocean/terrain half of the frame. Whoever owns
that region should treat this as blocking — it invalidates every A/B in the project.

---

## Problem 1 (aerial perspective) — NOT FIXED, NOT MINE, STILL OPEN

The brief's own fix says it: `src/gfx/materialCommon.js`, `uAerialDensity` /
`uAerialStart` / `mix(color, inscatter, t)`. I own `vegetation.js` only. As of the end of
this pass `git diff --stat` shows **materialCommon.js still unmodified** — the concurrent
agent has not landed it. Until it does, the canopy chroma ceiling stands: the brief's
controlled experiment (`--config aerialDensity=0.0` moving the canopy crop from
sat 17.7 / lap 339 to sat 58.0 / lap 1885) is the proof, and nothing in this file can
beat it. **This is the single largest remaining vegetation defect and it lives in
another file.**

---

## Problem 2 — hero crown silhouette. FIXED.

Measured on the geometry directly (a node harness over `buildTree`, so it is immune to
the scene churn; leaf-mass AABB in metres):

|                | before | after | reference intent |
|---|---|---|---|
| crown width    | 21.60 m | 12.54 m | ≈ total tree height (12.19 m) — the file header's own target |
| crown height   |  7.33 m |  4.50 m | |
| **w/h**        | **2.95** | **2.79** | header states 2.4 |
| leaf-mass bottom / tree top | 0.48 | **0.63** | reference: bare trunk is the lower third |
| leaf verts     | 10104 | 12528 | same mass, smaller cards |

Screen area is the real target and it dropped ~2x linear, which is what the brief's
30,314 px vs 7,373 px (4.1x area = 2.03x linear) called for.

Changes in `heroP`: `lenFall` 0.60→0.42, `spread` [0.60,0.60,0.52]→[0.55,0.55,0.48],
`flatten` 0.32→0.18, `canopyR` 8.6→4.0, `canopyH` 3.6→2.4, `tipCluster` 1.9→1.1,
`sprigSize` 1.45→0.78, `sprigLift` 0.35→0.50, `shellSprigs` 700→900.
Shell elevation `se = -0.45 + 1.45*pow(r,0.62)` → `-0.15 + 1.15*pow(r,0.55)` so nothing
hangs below the umbrella plane.

**Trunk reservation** added in both the tip-sprig and shell-sprig loops: a sprig is
rejected if its horizontal distance from the crown axis is under `0.35 * canopyR` *and*
it sits below the mean tip height. That is what moves leaf-bottom/top from 0.48 to 0.63
— the fork and upper trunk now read against the sky instead of being 100% buried.

Visually confirmed at `ref_00720`: the tree is now a small flat umbrella on a stack with
a visible stem, not a ball.

## Problem 3 — ground layer rendering zero pixels. FIXED, and the fix is defensive.

Before (isolation diff, `--skip vegetation`), row-band coverage at `ref_00720`:
```
y720-840 1.44%   y840-960 0.00%   y960-1080 0.00%
```
After:
```
y720-840 3.02%   y840-960 2.17%
```
Non-zero below y=840 for the first time. On the first working iteration, before terrain
was re-profiled under me, the brief's own near-beach box (y860-930 x40-330) measured:

| | veg OFF | veg ON | reference |
|---|---|---|---|
| lap_var       | 218.1 | **344.3** | 731.7 |
| edge_density  | 0.04  | **0.11**  | 0.17  |
| sat_mean      | 40.6  | **50.5**  | 118.2 |
| lum_std       | 12.97 | **16.81** | 24.45 |

i.e. vegetation went from contributing *exactly nothing* to contributing +126 lap_var and
+0.07 edge_density in that box. (That box is bare sand in the current build because the
beach moved; the row-band numbers above are the current-era evidence.)

What changed: a fourth placement band, `FG = {x -110..105, z -46..34}`, at ~10% of the
grass budget — the wedge both scored cameras (z=20 yaw 292°, z=8 yaw 320°) actually see,
8-40 m out. `matGrass` lod `[58, 96]` → `[110, 170]`, `widthGrow` kept at 0.0085.

**The gate is deliberately loose, and that is a finding, not sloppiness.** My first
version gated `s.y` in [1.2, 6.0] against the hand-measured beach profile. It worked, and
then `terrain.js` re-profiled the beach and the band went **6.11% → 0.00% row coverage
with zero changes in this file**. I then tried an adaptive quantile scan of the box; that
broke too, on the next terrain edit. The shipped gate is `wetness < 0.30 && slope < 0.55
&& 0.05 < y < 12` — anything that is not sea, surf or cliff face carries tufts. A
vegetation band must not be able to be emptied by someone else's height field.

## Problem 4 — leaf atlas contrast. FIXED (measurable only once problem 1 lands).

`makeLeafAtlas`: `v = 0.74 + 0.26*pow(r,0.7)` → `0.34 + 0.66*pow(r,0.7)`, matching the
comment two lines above it (0.34..1.0 = interior-shadow to sunlit-face). That is a 26%
value spread restored to 66%.
`matCanopy.colB` `lin(0.196,0.222,0.070)` → `lin(0.165,0.185,0.056)`, taking the
colA:colB ratio from 1.7x to ~2.0x.

Honest caveat: this cannot be validated on the current build. The aerial term (problem 1)
erases 84% of canopy lap_var, and the `--config aerialDensity=0.0` control needs
materialCommon.js to exist in fixed form to be meaningful. The code now matches its
documented intent and doubles the per-leaf albedo spread; the *image* proof is blocked on
another file.

## Problem 5 — gross over-scatter. FIXED.

- `mossInst`: clump scale `(0.9 + 1.5*r) * (1 + rim*0.6)` → `(0.45 + 0.55*r) * (...)`,
  `sY = sc*1.9` → `sc*0.55`. Max clump goes from ~7.6 m across to ~1.6 m.
- per-landmark count `area * 0.55` → `area * 0.18`.
- cliff-crown moss `sc = 0.9 + 1.7*r`, `sc*1.8` → `0.45 + 0.62*r`, `sc*0.6`.
- `CFG.ivyCards` 5200 → 2600; card scale `sc*(1.4+1.1r) / sc*1.5` → `sc*(0.75+0.45r) /
  sc*2.2` with `sc` halved — narrower and longer, a fringe rather than a blanket.
- ivy acceptance: the soft `if (rand > 0.18 + 0.82*top*top) continue` replaced with a
  **hard crown band** `s.y >= ivyCrownY(x,z) - 8`, where `ivyCrownY` is the local cliff
  top found by walking the height field 24 m inland, cached on a 4 m grid. Relative to
  the lip, not to an absolute y, so the fringe follows the lip wherever it is.

Whole-frame vegetation coverage at `ref_00720`, isolation diff, same-era captures:
**4.55% → 0.78-1.86%** depending on which terrain build it is measured against. Brief's
target was "under 5%". The two shapeless fuzz masses (1101x424 and 546x396 px) are gone
from the blob analysis; the largest connected vegetation blob is now the tree.

Risk flagged honestly: coverage may now be *under* the reference's ~3.5%. I could not
settle that, because the cliff that carried the reference's ivy is not in frame in the
current build.

## Problem 6 — shadows, blade alpha, magic constant. FIXED.

- `addMesh(..., shadow=true, depthOpts)` now passed for **moss, ivy and vine** (grass
  stays off for cost, as the brief allows). Each gets its own `makeVegDepthMaterial`
  carrying the identical placement + wind, so the caster does not shadow the rest pose.
- New `makeBladeAlpha(ctx, 32, 128)`: a tapered alpha strip, u across the blade, v along
  it, pinched to a point over the last 20%, run through the same `buildAlphaMips`
  coverage-preserving path. `matGrass` now takes `map: bladeTex, alphaTest: 0.30` instead
  of being a solid quad with `alphaTest 0`.
- `uSunRad`'s bare `0.115` replaced with `SUN_RAD_SCALE = LEAF_TRANSMITTANCE = 0.115`,
  documented as the visible-band leaf transmittance against the lighting module's own
  `sunIntensity`, so retuning the sun moves transmission with it.

## Cost

`vegetation` module init: **136 ms → 141 ms** (+5 ms, the `ivyCrownY` height-field walk;
it is cached on a 4 m grid). Instance counts fell (ivy 5200→2600, moss per-landmark
÷3.1), so steady-state draw cost is down, not up.

## Weakest thing left

Problem 1. The per-material aerial term in `src/gfx/materialCommon.js` still replaces
~58% of every canopy pixel with a near-neutral inscatter mix, and it is the reason the
canopy measures sat 17.7 against a reference 64.3. Everything in this file that governs
canopy chroma and micro-contrast — the leaf atlas spread, the colA/colB ratio, the
two-lobe transmission — is downstream of a `mix()` that throws 84% of it away. Until
that lands, problem 4 cannot be verified from an image, only from the code.

Second weakest: the renderer's current non-determinism (present with vegetation
disabled), which makes every A/B in the project approximate.
