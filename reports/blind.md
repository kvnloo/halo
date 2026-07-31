# Blind A/B against the real game — final acceptance gate

**Date:** 2026-07-30
**Harness:** `tools/blind.mjs` → `tools/sbs.py --blind`
**Shots:** `shots/blindcap` (captured fresh this run)
**Sheets:** `shots/blind/ref_*.png`
**Key:** written outside the repo, at
`/tmp/claude-1000/-workspace-zer0-products-halo/39c41fd0-07f6-4104-85cb-913b19302333/scratchpad/blindkeys/key.json`

---

## 0. Raw tally

```
n = 9
picked the real game     9
picked our render        0
render win rate       0.000
```

**We lost 9 of 9.** Not one pair was close enough to make me hesitate, and on no pair did I
have to weigh trade-offs — every decision was made on a technical-deficiency tell inside the
first few seconds of looking, and the detail crops only confirmed what the thumbnail already
said. `blind.mjs` verdict string: *"reference wins clearly — keep going"*.

This is the honest number. Do not round it up.

### Guard against a false result

Two things could have faked this tally, and neither did:

* **Positional bias.** The randomiser put our render on side A in 4 pairs and side B in 5
  (`A,B,B,A,A,A,A,B,A` for the reference). My picks alternated with it exactly. I was
  tracking image content, not a side I had latched onto.
* **A missing subsystem.** `node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL
  template hazards`. The capture reported `"failedModules": []` and no warnings. Every
  subsystem was loaded and rendering. This was a fair fight.

I did not read the key, run the hash, or stat the reference files until all nine verdicts
were committed to `scratchpad/mypicks.txt`.

### Per-pair record

| Pose | Content | My pick | Was | Result |
|---|---|---|---|---|
| `ref_00000` | wide establishing — sand, bridge, shallows | A | reference | ✗ |
| `ref_00120` | mid push-in — bridge fills right third | B | reference | ✗ |
| `ref_00450` | mid — hero sea stack + crown tree | B | reference | ✗ |
| `ref_00600` | sky — look up, Threshold + ring band | A | reference | ✗ |
| `ref_00720` | sky — Threshold, two ring bands, cliff | A | reference | ✗ |
| `ref_00840` | close detail — tide-pool shelf | A | reference | ✗ |
| `ref_01500` | wide — stacks in the shallows | A | reference | ✗ |
| `ref_01800` | water — swash, low-sun glitter | B | reference | ✗ |
| `ref_02220` | backlit — bridge silhouette vs bright sky | A | reference | ✗ |

---

## 1. The tells, in priority order

Each of these is what actually gave the frame away. Ranked by how many frames it decided and
how early it decided them — this is the remaining work list.

### T1 — Rock silhouettes are extrusions, not erosion *(decided 7 of 9 frames)*

The single biggest tell, and it is on the scene's hero asset.

Our sea stacks are **truncated cones with a straight batter** — a smooth tapered tube with a
slight rounding at the crown. The reference stacks have:

* an **undercut sea-notch** at the waterline where wave energy has eaten in,
* an **overhanging brow** above it,
* a **fractured buttress** detached in front along a visible fracture plane,
* a silhouette that changes character with height instead of interpolating linearly.

Ours has none of those. Because the profile is monotonic, the eye gets no cue for how tall
the stack is, which is why our frames read as scale models. See
`shots/blind/ref_01500.png` — the reference stack's undercut alone carries the whole shot.

Surface is as bad as profile: a **single-octave, low-contrast noise wash**. Missing are
bedding planes, directional solution flutes, dark stain streaks under drainage points,
lichen colonies in sheltered pockets, and — critically — the **wet/dry tidal band**, which
in the reference is a hard horizontal tone break that instantly reads "this is the ocean".

### T2 — The beach is a carpet of identical cobbles *(decided 5 of 9)*

Our foreground scatter is a field of near-identical ellipsoidal blobs at **one size mode**.
Real shingle has a power-law size distribution — fines packed between mid stones, occasional
boulders, and clustering into drifts and lags. Ours has no fines, no boulders, no clustering,
and constant spacing, so it tiles visibly and destroys the scale read.

The larger foreground stones are **visibly low-poly faceted** — flat shading facets are
readable on the silhouette and across the surface (`c00_ground.png`). They are untextured:
flat diffuse albedo, no grain, no normal detail.

The sand under them is a repeating bump-mapped pebble pattern with **no wet/dry gradient**
and no ripple structure. The reference sand has microrelief, swash-cut ripple sets, mineral
colour variation, and a wetness gradient that drives its specular response.

There is also a **white translucent dome** sitting in the sand at lower-left of
`ref_00000` that reads as a placeholder or a broken shell asset.

### T3 — Nothing makes contact with the ground *(decided 6 of 9, global)*

No contact shadows, no grounding AO. Cobbles, characters, rocks and props all sit on the
surface with a clean lit seam where there should be a dark occlusion gradient. Everything
looks 5 cm above where it belongs. This is cheap to fix relative to its impact — it is
probably the highest value-per-hour item on this list.

### T4 — Characters are box primitives *(decided 3 of 9, but instantly)*

The Elite and Grunts are assemblies of chamfered cuboids with flat, nearly unlit albedo — no
normal maps, no self-shadowing, no material variation between armour, cloth and skin. The
Grunt methane tanks read as wireframe cages. Combined with T3 they float above the wet sand.
See `c840_ch.png`. Any frame containing a character was decided by the character alone.

### T5 — Water: foam is paper, surface is smear *(decided 2 of 9, and it is the water frames)*

Two separate failures, both visible in `c1800_water.png`:

* **Foam** is rendered as opaque white polygons with hard vector edges — torn paper, not
  aerated water. Real foam has a soft dissipating edge, varies in opacity with age, and
  leaves a receding lace pattern as it drains.
* **The surface** is a smeared directional streak texture — it looks like a flow-map
  advecting noise stretched into brush strokes. There are no discrete wavelets at the right
  spatial frequency, no sun glitter, no refraction of the bed below, and no depth-driven
  colour gradient. The reference swash is a thin transparent sheet over sand: you read the
  sand grain through it, modulated by depth, with a mirror sky reflection carrying the sun's
  warm sheen.

Also missing: **wave–rock interaction**. Reference stacks have breaking waves and spray at
their feet; ours meet the water at a flat line with a thin foam ring and nothing else.

### T6 — Vegetation reads as sprite cards *(decided 4 of 9)*

Alpha-cut foliage cards with **visible rectangular sprite corners** and hard cutout fringing.
Canopies are flat parasol discs rather than volumes with readable branch structure. Trunks
are untextured grey cylinders. Cliff moss and hanging vines read as dark green dashes with
hard edges rather than as growth following the rock. `c450_stack.png` and `c1500_rock.png`
show this clearly against a reference tree that has depth, internal shadowing, and birds
scaled correctly against it.

### T7 — Clouds are opaque cotton *(decided 4 of 9)*

Hard-silhouetted white puffs with no light transmission — no translucency at the thin edges,
no silver lining where the sun is behind, no internal scattering gradient, no vertical
development into anvils. They are also all the same size, which flattens the sky's depth.

There is a recurring **dark-cored cloud slab artifact** (upper area of `ref_00000`,
`ref_00120`, `ref_00450`, `ref_02220`) — a large blob with a near-black interior that does
not read as any weather phenomenon. Looks like a density or lighting sign error in the cloud
shader. This one is a bug, not a fidelity gap.

### T8 — Sky bodies read as decals *(decided 2 of 9, and they are the sky frames)*

From `c600_sky.png`:

* **Threshold's limb is a hard geometric circle.** No atmospheric scattering rim, no
  terminator softening. The reference has a blue-green scattering halo at the limb that
  fades into the sky — which is what places it *behind* the atmosphere.
* **Banding is smooth airbrushed horizontal stripes** with no turbulence, no eddies, no
  storm features. Reference banding is turbulent and multi-scale.
* It is **too saturated and too opaque** — it is not attenuated by the aerial haze it is
  being viewed through, so it sits on the glass instead of at infinity.
* **The ring band** is a flat noise stripe with blotchy bright/dark patches that do not
  resolve into geography, and it does not attenuate toward its base where it enters the haze.

### T9 — No aerial perspective *(global, and the reason everything reads flat)*

This is the quiet one that underlies several of the above. The reference separates every
depth plane with haze: distant islets desaturate and lift toward the sky colour, the sea
fades into a soft horizon, cliffs at 200 m are visibly milkier than cliffs at 50 m.

Ours has almost none. Distant sea stacks are as saturated and as contrasty as the near ones,
and the sea beyond simply **stops in a hard flat band** with no horizon haze at all
(`c120_wl.png`). Without this gradient the frame has no depth and the composition collapses
into a flat plane of equally-weighted objects.

### T10 — Structures are flat slabs, and one is missing

The bridge is flat-shaded with an obvious **vertical stripe banding** artifact (reads like a
bad procedural stripe texture), uniform albedo across the whole span, no grime streaking, no
panel-line or greeble depth, no emissive accents, and it **aliases hard against the sky**
with no edge treatment. The reference bridge is weathered concrete and metal with dirt
streaking down from every ledge, recessed panel detail, teal emissive accents, and warm
bounce light on its underside.

**Separately: at `ref_02220` the bridge is absent from our render entirely.** The pose is
documented as *"Turning back east: bridge silhouette against bright sky, cliff on the
right"*; the reference frame shows exactly that. Our frame at the same camera shows an empty
beach and a long dune ridge with no structure anywhere in view. That is a placement or
culling bug in `structures.js`, not a fidelity gap, and it should be triaged first because it
is the only finding here that is outright *wrong* rather than *not good enough*.

### T11 — Tonemap is washed

Ours is consistently brighter with less mid-tone contrast, the sky is a flatter and more
uniform blue, and there is no bloom or lens response around the sun. The reference has
deeper shadow density, a warmer highlight roll-off, and visible light shafts. This is the
cheapest item on the list but also the least valuable — fixing the grade on top of T1–T10
would just make the same problems better-exposed.

---

## 2. What this means

The gap is not stylistic and it is not a grading pass away. Every tell above is a
*capability* gap: geometry that lacks a generation stage (T1), scatter that lacks a
distribution (T2), a lighting term that isn't there (T3), assets that are placeholders (T4),
shaders missing a physical term (T5, T7, T8), and a global atmospheric model that isn't
wired (T9).

Ranked by value per unit of work, I would take them in this order:

1. **T10-bug** — the missing bridge at `ref_02220`. It is a correctness failure.
2. **T3** — contact shadows / grounding AO. Global, cheap, and it fixes the "everything
   floats" read in every single frame.
3. **T9** — aerial perspective / distance haze. Global, cheap, and it is what buys depth.
4. **T1** — rock silhouette generation (undercuts, overhangs, fracture) plus the wet/dry
   tidal band. Expensive, but it is the hero asset and it decided 7 of 9 frames.
5. **T2** — cobble size distribution and clustering, plus texturing the large stones.
6. **T5** — foam edge treatment and water surface wavelets/refraction.
7. **T7-bug** — the dark-cored cloud slab. Likely a sign error; small fix.
8. **T4, T6, T8, T7, T11** — asset and shader quality work, in that order.

The blind test should be re-run after items 1–4. That is the point at which the tally has a
chance of moving off zero.

---

## 3. Reproducing this

```bash
node tools/parsecheck.mjs                                    # must be green first
node tools/capture.mjs --all --outdir shots/blindcap
node tools/blind.mjs --shots shots/blindcap --out shots/blind
# ... judge shots/blind/*.png without reading the key ...
node tools/blind.mjs --score "ref_00000=A,ref_00120=B,..."
```

Detail crops were taken blind with `scratchpad/blindcrop.py`, which splits a sheet into its
A and B panes and takes the same ROI from each at native resolution. It never reads the key.
