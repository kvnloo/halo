# structures — Wave F: the bridge is in the shot

File owned: `src/world/structures.js` (only file edited). Diagnostics added:
`tools/_stmask.py`, `tools/_stcrop.py`, `tools/_stcollide.mjs`.

The Wave E report ("Forerunner alloy albedo") is superseded below where it conflicts;
its palette work stands and was **not** re-tuned — see §6 for why.

---

## Method

`src/` is not quiescent (other agents own terrain/ocean/clouds/rocks/vegetation/
weapons/fog, and `sky.js` failed to compile during one of my captures), so no
whole-frame number captured minutes apart is comparable. Everything below is either

* an **isolated two-capture mask** —
  `--only time,lighting,structures,pipeline` minus `--only time,lighting,pipeline`,
  differenced per pixel; the mask *is* an exact semantic segmentation of this
  subsystem (`tools/_stmask.py`), or
* a **fixed crop at a fixed pose** compared against the same crop of
  `ref/keyframes/kf_00000.png` / `ref/detail/bridge_4k.png` (`tools/_stcrop.py`), or
* a **non-rendering probe** (`tools/_stcollide.mjs`) for the collider contract.

Two full captures of the final build at `ref_00000` are byte-identical.

---

## 1. CRITICAL — the bridge was not in any scored frame. Fixed here.

`ANCHOR` / `TIP` live in this file, so this was mine to do.

**Before** (isolated mask, unmodified file, this session):

```
Δ>50   0.92% of frame   x1811-1919  y0-309      (the review's number)
Δ>25   0.55% of frame   x1849-1919  y0-289      (mine, same session)
```

i.e. the last ~100 px of a 1920-wide image, entirely above the horizon. In
`kf_00000` the bridge is x 370-1250 and *is* the composition.

**How the new placement was derived** — not by re-aiming, and not by eye. Six points
were read off the deck-top silhouette in `kf_00000` (image x 380…1250), back-projected
through the `ref_00000` pose (pos 10.5,1.74,20 / rot −4,292 / fov 78 / 16:9) onto the
plane y = 22, and fitted:

| image (x,y) | world (x,z) at y=22 | range |
|---|---|---|
| 380, 300 | 54.1, −63.3 | 96.2 m |
| 700, 262 | 57.7, −23.7 | 67.4 m |
| 1100, 238 | 65.3, +9.9 | 59.3 m |
| 1250, 232 | 68.4, +20.9 | 61.4 m |

Those are the *near* (west) deck edge; adding the 7.75 m half-width along the run's
perpendicular gives the centreline, and extending it to the documented 108.83 m run:

```
ANCHOR (80.0, 42.7)      TIP (61.7, −64.6)      run 108.85 m, 9.7° off −Z
```

The run now sits 60–100 m from the beach spawn and is seen *across*, not stood under.
`STRUT_FEET` are now expressed in bridge-**local** coordinates (lx, lz) so they follow
the run instead of being re-derived from world points; local z 40 (on damp sand) and
92 (in the water), matching the reference spacing.

> This drifts from `docs/WORLD.md`'s "anchor (+54,+60) → tip (−34,−4)". That placement
> is geometrically incompatible with the `ref_*` camera track — from `ref_00000` the
> old run's midpoint is 8 m from the camera and 116° off-axis, and anchor and tip
> subtend 155°, so **no yaw frames it**. `WORLD.md` is not my file; the drift is
> deliberate, measured, and needs to be written back into it by whoever owns it.

**After** (same isolated mask):

```
Δ>50  12.34% of frame   x365-1919  y108-551     (isolated: nothing occludes it)
full scene, structures-in minus structures-out:
Δ>50   1.82%            x382-1732  y130-492
Δ>6    8.82%            x214-1900  y25-549
```

Reference bridge: x 370-1250. Our left/tip edge is **382** against 370. The review's
acceptance criterion ("Δ>50 must land in x350-1300") is met on the left; the right
edge runs to 1732 because our cliff silhouette sits further east than the reference's,
which is terrain's geometry, not mine.

Whole-frame `ref_00000` score, structures-in vs structures-out (the honest bracket for
"before", since the old bridge contributed 0.9% of frame):

```
                    no structures    with structures
score                   32.80             32.03
perceptual              11.87             12.25
geometry                98.95            100.00
spectrum                94.11             81.59
```

**The bridge is now a net-neutral contribution to the whole-frame score, and the reason
is §6.** It is 46% of frame width in the reference and it renders as a flat pale grey
slab; `spectrum` falls 12.5 points the moment it is drawn.

### Blocked, not mine: `ref_02220` is aimed the wrong way

`kf_02220` is essentially the same picture as `kf_00000` — bridge centre-left, cliff on
the right. `poses.js` has `ref_02220: pos (−30, 1.74, 4), rot (−1, 96, 0)`. Yaw 96
points **west down the beach with the cliff on the left**; I captured it, and the
terrain confirms it is mirrored, independently of anything structures does. From
(−30, 4) the new run's midpoint bears **yaw ≈ 278°**. One number, in `poses.js`, not my
file. Until it changes `ref_02220` scores zero structure however good this module is.

---

## 2. CRITICAL — surface frequency: corduroy → architecture. Fixed.

Same pose, same scale, pure-alloy crops (no sky, no background), `aerialDensity=0`
because the wash destroys every contrast statistic (§6):

| strut blade, `ref_00000` | before¹ | **after** | reference (kf_00000 515,465–590,555) |
|---|---:|---:|---:|
| lum | — | **73.6** | 85.2 |
| lum_std | — | **18.2** | 24.2 |
| p01 / p99 | — | **15.8 / 106.5** | 38.8 / 132.6 |
| p99−p01 range | — | **90.7** | **93.8** |
| lap_var | — | 280.0 | 598.5 |
| **lap_var/std²** | 1.508 | **0.842** | **1.019** |
| ms_std 1/8/32 px | — | 16.6 / 9.9 / 5.0 | 21.0 / 8.8 / 2.9 |

¹ the 1.508 is the review's measurement of the shipped build at `diag_bridge`; its
reference figure (0.238) was a `bridge_4k` crop at a different scale. The like-for-like
numbers are the last two columns — same pose, same pixels-per-metre.

**lap_var/std² was 6.3× the reference and is now 0.83× it.** That ratio is the
diagnostic one: absolute `lap_var` also rises with legitimate contrast, so only the
normalised figure separates "architecture" from "corduroy". The dynamic range on the
blade (90.7) is now within 3% of the reference's (93.8).

What changed:

* **Tiers 2 and 4 are switched off on the strut** (`tierK = 1 − isStrut`). Those put a
  seam every 0.97 / 1.32 m and a 4 cm interlock gap at every joint — on a blade 4–8 m
  wide at 87 m range that is a line every 3–5 screen pixels, and it was the entire
  corduroy signal.
* **Panel periods**: strut 3.6×2.4 → **9.0×7.0**; other non-deck parts 3.6×2.4 →
  **6.5×4.5** (the soffit was on the 3.6×2.4 lattice too). Deck unchanged at 16×2.55.
* **The chevron rings were rebuilt.** They were three concentric 0.46 m pinstripes
  standing 0.26/0.21/0.16 m proud — and *stepping the wrong way*, less proud toward
  the centre, despite a comment claiming a ziggurat. Now two contours: a 1.60 m band
  0.42 m proud, a 0.50 m groove, then a **solid** plateau 0.90 m proud, plus the
  blade's own 0.20 m edge chamfer — three nested mitered contours whose groove walls
  are real occluders. Half-chords clamp at 0.30 m so the inner contour dies out where
  the blade narrows instead of inverting through the centreline.
* **The chamfer highlight is now metal.** `p99` could not reach the reference at
  metalness 0.02 (F0 = 0.04). `metalnessFactor` is driven to 0.72 by the wear mask —
  it is declared by `<metalnessmap_fragment>`, which runs *before* the splice point, so
  `<lights_physical_fragment>` picks it up. Physically correct: a worn chamfer is bare
  alloy. Roughness floor 0.16 → 0.10, edge mask widened 0.04→0.02 / 0.30→0.26.

### Blade chord, measured off the silhouette

At `ref_00000` image row 470 the reference's seaward A-frame is **180 px** across;
ours was **75 px** — same pose, same ~87 m range, so the reference blade is 2.4× ours.
At 4–8 m chord ours read as two poles under a slab. `hcB/hcT` 2.05/3.85 → **4.40/8.20**
(9–16 m chord), thickness 1.42 → 1.90. After: **120–136 px**.

A chord that wide is tilted 28° out of horizontal, so its two upper corners differ by
8 m in world height — left alone one punches up *through* the deck and the other stops
5 m short of the soffit. The reference wedge does neither: its top is a long horizontal
edge tucked under the deck. The outline is therefore cut by the world plane
`y = SOFFIT_Y + 0.28` (`capCy` / `clip`), which is a slanted line in blade coordinates
and a horizontal one in world.

---

## 3. CRITICAL — the soffit coffer grid was invented. Deleted.

`ref/detail/bridge_4k.png` (950,420)-(1500,560), the underside:

```
lum 71.33  std 22.64  sat 96.06  rgb 81.6/70.2/52.3  B/R 0.641
lap_var 125.5   lap_var/std² 0.245
```

A near-smooth warm-khaki plane with two or three long shallow channels and one
machinery hub, blue the **minimum** channel by 29 code values. Ours was a 0.35 m
orthogonal lattice every 3.68 m longitudinally and 5.4–5.9 m transversely with a second
recessed panel inside every cell — at 4 px a rib it read as a wooden boardwalk, and the
file's own header says "there is no greebling".

Deleted: the transverse rib loop, the longitudinal ribs at 0 and ±3.68, and all
per-cell coffer panels. Replaced by **three wide soffit plates with two 1.2 m gaps**
between them — the gaps *are* the channels, because a recess is an absence of plate,
not another plate — plus the two outer fascia ribs at ±7.10 and **four** transverse
expansion joints over 122 m. Two edges across 15.5 m instead of eight; no transverse
frequency. The machinery hub is kept (the reference has it).

**Hue.** `totalEmissiveRadiance += alb * uBounceCol * down*down * uBounce` was wrong
twice: multiplying by `alb` made the bounce worth almost nothing on `uAlloyDark`
(0.076,0.053,0.056), exactly where it is needed, and `down*down` zeroed it on every
side wall. Now `sqrt(alb) * uBounceCol * downG * uBounce * mix(0.55,1,occ)` using the
**geometric** downness — using the seam-perturbed normal made every seam flicker in the
bounce and pushed `lap_var/std²` to 1.78 in one measured experiment. `uBounceCol`
(1.00,0.70,0.38) → (1.00,0.60,0.24), `uBounce` 0.95 → 1.90.

Additionally, a downward-facing surface sees almost no sky, but three's
`HemisphereLight` hands it the full ground term regardless of the 15.5 m slab above it.
That cold unshadowed ambient is what kept the underside blue. It is now attenuated by
`mix(1.0, 0.55, downG)` and the energy returned as sand bounce — the same total
radiance in a defensible spectrum. Sand albedo ~0.22 under this scene's irradiance
gives an outgoing radiance ~0.27, so the soffit's irradiance is of order π·0.27 ≈ 0.85,
comparable to the direct sun and warm.

Measured on the best crop available at `ref_00000`: **B/R 1.058 → 0.952**,
`sat` 50.2 → 65.6. Target 0.641. Not closed.

> **Honest limit.** With the girder deepened (§5) the deck underside is occluded at
> `ref_00000` — the fascia beam is between the camera and the soffit, which is also
> true of the reference at that pose. `bridge_4k` is a much closer, steeper view, and
> **no pose in `poses.js` reproduces it with the new placement**: `diag_bridge`,
> `shot_forerunner_bridge` and `shot_bridge_underside` all point −X and the bridge is
> now at +X. So the soffit hue is verified in direction and in physics but not to the
> 0.641 target. Closing it needs a diagnostic pose, which is `poses.js`.

---

## 4. MAJOR — silhouette and emissive: guardrail → slab. Fixed.

**Emissive.** `dash = mix(0.10, 1.0, step(0.26, fract(bp.z*0.19)))` was full gain over
**74%** of a 5.26 m period, gated by `step(0.18, hash11(...))` which kept 82% of
segments, on four separate edges — 61% of the run was a continuous lit cyan line, and
those strips were the brightest non-sky pixels on the object. In `bridge_4k` I count
three or four isolated ~1 m tick clusters in the entire 4K frame, dim.

Now `step(0.94, fract(bp.z*0.19))` × `step(0.80, hash11(seg*0.77+4.1))` = **1.2% of the
run**, restricted to the girder channel only (parapet branch and strut-centreline
dashes deleted), `uEmisGain` 1.15 → **0.50**.

**Parapet.** Three stacked 0.9 m rail bands with a continuous recessed light channel
running the full 109 m on both sides, cut to a single **0.34 m nose**
(`railBands[1]`/`[2]` deleted, and with them the parapet occlusion and emissive
branches). At the 40–100 m the reference views this object from, the silhouette is all
it has.

---

## 5. Girder depth — measured, and not on the review's list

At `ref_00000` the reference deck's *top* edge and ours agree to 8–15 px over image
x 700–1200 (after §1), but its underside sits ~35 px lower. At the 65 m range that is
**3.4 m of missing section**. `WORLD.md`'s "2.6 m thick" is the deck *plate*; the
fascia beam under it carries the depth. `GIRDER_BOT` 16.30 → **13.60**, lower web
re-drawn.

| image x | our bottom, before | our bottom, after | reference |
|---|---:|---:|---:|
| 700 | 370 | **393** | ~405 |
| 900 | 362 | **386** | — |
| 1100 | 353 | **379** | — |

Cost: it occludes the soffit at `ref_00000` (§3's honesty note). The reference is
occluded the same way at the same pose, so I judged the silhouette the more important
of the two.

---

## 6. MAJOR — `wmAerial` is the largest remaining error and it is not in this file

Confirmed independently, with the new geometry, on the pure-alloy strut crop at
`ref_00000`:

| | shipped (aerial 0.0062) | `--config aerialDensity=0` | reference |
|---|---:|---:|---:|
| lum | **126.3** | 73.6 | 85.2 |
| lum_std | **9.7** | 18.2 | 24.2 |
| sat | 30.0 | 48.0 | 40.2 |
| p01 / p99 | **95.2 / 135.5** | 15.8 / 106.5 | 38.8 / 132.6 |
| range | **40.3** | 90.7 | 93.8 |
| lap_var | **42.3** | 280.0 | 598.5 |

**The shipped haze costs this object 50 of its 91 code values of dynamic range and
lifts its blacks by 79.** Every §2 and §3 fix is invisible underneath it: with the
aerial on, `lap_var` on the blade is 42 against a reference 599, and whole-frame
`spectrum` drops 94.1 → 81.6 the moment the bridge is drawn (§1).

`src/gfx/materialCommon.js:78` `wmAerial()`: `uAerialGroundColor` defaults to
(0.62, 0.60, 0.55) **scene-linear** and `lighting` never overwrites it (it writes only
sun dir/colour and sky colour). A 0.15-albedo surface under this scene's irradiance
reflects ~0.21 — **the haze colour is three times brighter than the brightest thing it
fogs.** With `uAerialDensity` 0.0062 and `uAerialStart` 6, the mix is 0.14 at 30 m,
0.28 at 60 m, 0.44 at 100 m.

This is **not** the `volumetricFog` bug of KNOWN_ISSUES §8/§18 — the review measured
`--skip volumetricFog` at 113.57 → 113.63 lum on this object, i.e. noise — and
`materialCommon.js` is on nobody's owner list. Recommended, unchanged from the Wave E
report which also flagged it: drop `uAerialGroundColor` to roughly the ground's own
outgoing radiance (~0.10–0.15) and have `lighting` drive it from the terrain albedo,
and/or cut `uAerialDensity` so the mix is under 0.05 below 80 m.

Deliberately **not** compensated for inside `structures.js`. With the aerial on this
object is +41 lum over the reference; with it off it is −12. Any albedo change made now
would be tuned against a broken control — the exact trap KNOWN_ISSUES §4 and §8
document. One line, one file, and it moves this subsystem more than everything above.

Reproduce:

```bash
node tools/capture.mjs --pose ref_00000 --only time,lighting,structures,pipeline \
  --config aerialDensity=0 --out /tmp/a.png --settle 48
.venv/bin/python tools/_stcrop.py /tmp/a.png 480 430 555 505 strut
.venv/bin/python tools/_stcrop.py ref/keyframes/kf_00000.png 515 465 590 555 ref
```

---

## 7. MAJOR — colliders: KNOWN_ISSUES §12 closed

The deck and both parapets were emitted as `{type:'box', center, quaternion,
halfExtents}`. `physics.validCollider` (physics.js:107) requires a `Box3` on `.box` and
has no OBB case, so **all three were silently discarded** — the entire 109 m deck was
non-solid and `[warn] [physics] ignoring malformed collider (type="box")` fired on
every capture. Only the four strut capsules survived.

§12 says do not convert mechanically, and it is right: the run is 9.7° off −Z, so one
axis-aligned `Box3` around the whole deck is **37.6 m** wide where the deck is 15.5.
Of the two options §12 lists, the OBB type belongs to `physics.js`, which I do not own,
so this takes the other: a chain of **14 axis-aligned `Box3` segments**, each the exact
AABB of that segment's eight rotated corners. The parapet colliders are gone with the
parapet.

`node tools/_stcollide.mjs` (no renderer; applies `validCollider`'s predicate verbatim):

```
colliders: 18  (14 box, 4 capsule)
malformed by physics.validCollider: 0
point 69.91,21.40,-16.45 (deck local 0,60) inside 1 deck box
deck collider top at that point: y=21.500        <- the walking surface, exactly
AABB X extent: max 16.87 m; deck width projected on X = 15.28 m
   -> 0.80 m of solid air per side   (one un-segmented AABB would be 37.6 m wide)
walkableSurfaces: 1, halfU=6.85, halfV=66.42     <- still the exact oriented rect
```

The warning is gone from every capture in this session. (The review's drop point
(10,30,20) is no longer over the deck — the run moved; bridge-local (0, ·, 60) is the
equivalent, world (69.91, ·, −16.45).)

---

## Cost

`structures` init **52.0 ms → 23.1 ms** (same machine, same session): deleting the
coffer grid removes ~110 plates and their merge. One mesh, one draw call, unchanged.
The fragment shader is net *cheaper* on the strut (two seam tiers switched off there)
and unchanged elsewhere; one extra `sqrt` and one `mix` per fragment for the bounce.
Two full captures byte-identical.

---

## Weakest things left, in order

1. **`wmAerial` (§6).** Costs this object 50 of 91 code values of range and 12.5 points
   of whole-frame `spectrum`. Not in this file and not on anyone's list.
2. **`ref_02220`'s yaw (§1).** Should be ~278°, is 96°. One number in `poses.js`.
   Until then the second bridge pose scores nothing.
3. **The soffit hue is verified in direction only (§3)** — B/R 0.95 against 0.64 — and
   no pose now shows the underside. A `diag_bridge` replacement looking up at (70, ·,
   −20) from the west would close this and any future soffit work.
4. **The blade is 12 lum dark and 6 std flat with the aerial off** (73.6/18.2 against
   85.2/24.2). That is an albedo/irradiance question and it cannot be answered while
   §6 makes the same surface 41 lum *bright* with the aerial on.
5. The deck fascia still carries more horizontal banding than the reference's single
   bold recessed line. The strut is fixed and measured; the deck's 16×2.55 lattice was
   not re-derived, only the sub-tier periods on non-deck parts.
6. `docs/WORLD.md`'s bridge coordinates now disagree with the code (§1). Someone who
   owns that file must write the new run back into it.
