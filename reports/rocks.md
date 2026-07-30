# rocks — form + palette pass (supersedes the albedo-pass report)

Owner file: `src/world/rocks.js`.

## Measurement rig — changed, and this is the point

The previous pass was tuned on `--pose diag_stack --config sunAzimuth=6`, a pose the
game never shows. Everything is now measured at **ref_01500**, the pose this module is
scored on, with a skip list that removes the modules other agents are currently
mid-flight on but keeps the camera and the sun exactly as scored:

```
node tools/capture.mjs --pose ref_01500 \
  --skip ocean,clouds,weapons,hud,ai,particles,props,vegetation,terrain \
  --settle 32
```

That frame *does* contain the sea stacks — three of them, plus the islet field and the
tide-pool shelf. The earlier claim that "the ocean covers the stacks entirely at
ref_01500" was wrong; the stacks are there, they were simply the same value as the sky
and invisible. Boxes used: hero stack face `1290,90-1600,430`, upper band
`1300,120-1580,300`, foot band `1300,455-1580,500`, near-field shelf
`250,780-1250,1060`.

Reference boxes (`ref/keyframes/kf_01500.png`): hero stack `600,80-950,420`, right stack
`1290,180-1520,470`; near-field reference is `ref/detail/rock_4k.png 100,100-1000,700`.

## Before / after — hero stack face, `--config aerialDensity=0`

```
                      RGB              lum  lum_std   sat  lab_b  lap_var  edge    lc
BEFORE          69.1 / 54.2 / 36.7    56.1   20.7   130.7  13.3    475.9  0.150  0.050
AFTER           69.6 / 61.4 / 45.4    62.0   17.1    96.9  11.1    658.6  0.190  0.158
ref hero stack  81.0 / 69.5 / 51.8    70.6   35.3    96.4  12.3   1235.4  0.199  0.196
ref right stack 129.3 /113.6 / 86.2   115.0   63.2    92.5  17.3   3177.7  0.239  0.184
```

sat 130.7 -> 96.9 against a reference 92.5-96.4 — on target, and it is now on target
*without* the aerial veil, which is the whole difference from the last pass.
local_contrast 0.050 -> 0.158 against 0.184-0.196. edge_density 0.150 -> 0.190 against
0.199-0.239. lap_var 476 -> 659.

Tide band, upper vs foot:

```
             upper lum   foot lum   step
BEFORE          54.6        55.1     0.5
AFTER           62.3        53.6     8.7      (reference moves 28.6)
```

Near-field shelf (`250,780-1250,1060`, all rock pixels):

```
              lap_var   edge    local_contrast
BEFORE         3247.5   0.295       0.063
AFTER           974.0   0.263       0.217
ref rock_4k     421.1   0.123       0.161
```

Fizz down 3.3x, contrast up 3.4x — the ratio moved the way the reference wants (fewer,
bigger, higher-contrast features), though edge_density is still 2x high.

## THE BLOCKER, re-confirmed, and it is not volumetricFog

`--skip volumetricFog` returns byte-identical stack pixels. The veil is
`aerialInscatter()` in **`src/gfx/materialCommon.js:49-66`** (`uAerialDensity` /
`uAerialStart`), a per-material additive term, not the fullscreen pass.

The same box, same build, shipped `aerialDensity` vs `aerialDensity=0`:

```
                 RGB              lum  lum_std   sat  lab_b  lap_var  edge    lc
shipped   117.4 /121.5 /127.8    121.1   5.0     20.7  -4.1     73.2  0.005  0.020
aerial=0   69.6 / 61.4 / 45.4     62.0  17.1     96.9  11.1    658.6  0.190  0.158
```

B > G > R with the veil on: **the rock renders blue**. The palette change moved the
aerial=0 number by 32 saturation points and the shipped number by 0.16 — the veil is
not attenuating the rock's chroma, it is *replacing* it. No albedo, roughness or
geometry change in `rocks.js` can reach past it. `uAerialDensity` must be re-derived in
`src/gfx/materialCommon.js` against a black-albedo capture.

## What changed in src/world/rocks.js

1. **Planarity mask (the form fix).** Cleavage planes are now cut *first* and export a
   `planarity` weight; every downstream displacement (karst lumps, fluting, channels,
   fine relief) is multiplied by `1 - 0.85*planarity`. Previously seven terms totalling
   ~0.5R ran after the clip and sanded the face straight back off. `nPlanes` 3+[0,2] ->
   4+[0,3], band width `w` 0.14-0.34 -> 0.22-0.46 of the band height so the plane bands
   overlap.

2. **Corduroy killed.** The fluting mask had a hard `0.30 +` floor, so no θ was ever
   unfluted; the floor is gone and the mask is raised to ^1.5, so roughly half the
   perimeter carries no fluting. `fy` 0.024 -> 0.10 so grooves wander several lattice
   units over the 42 m instead of running dead straight, plus a coarse y-banded gate
   (`cylFbm(th,y,0.4,0.35,...)`) that terminates them at bedding planes. Channels got
   the same treatment (`fy` 0.014 -> 0.055).

3. **Mushroom plinth removed.** Platform mask floor `0.25 +` -> none, directional weight
   0.45 -> 0.9 with a -0.15 bias, flare `R*0.20` -> `R*0.07`, and the notch is now
   evaluated **after** the platform and deepened (`n.d` -> `n.d + 0.07`) so the undercut
   wins. A/B with the flare forced to zero is now visually indistinguishable — the shelf
   no longer drives the silhouette.

4. **Damp band de-modulated.** `damp` was three sub-unit modulators multiplied together
   (`Ng.y`, `m2`, `1-cvx`) bottoming out near 0.38 on exactly the convex, up-facing,
   sunlit surface at the foot of a stack. The `Ng.y` and `cvx` terms are deleted; only
   the world-y gate and a low-frequency mottle remain, and the band is tightened to 3.6 m.

5. **Detail ladder rebalanced.** Inserted the missing **3.5 m** octave (`dA0`, its own
   `rotY`) between 9 m and 1.15 m. Normal weights pushed to the coarse end
   (9m 1.05->1.15, 3.5m new 1.10, 1.15m 1.00->0.80, 0.30m 0.78->0.34, 0.055m 0.48->0.14)
   and the two fine octaves' *albedo* ranges narrowed to near-nothing. `hC`/`hD` are now
   range-faded toward 0.5 by 26 m using `distance(P, cameraPosition)`, so 5.5 cm noise
   no longer drives tone at 100 m where it can only alias.

6. **Palette de-compensated.** `matRock` base `(0.558, 0.330, 0.070)` ->
   `(0.620, 0.500, 0.151)`: luminance reflectance 0.360 -> 0.501, B/R 0.125 -> 0.243.
   `matFar` no longer ships *more* chroma than `matRock` — it was
   `(0.588, 0.338, 0.068)` (B/R 0.116) with a comment saying it started saturated
   because aerial perspective would eat it; it is now `(0.610, 0.494, 0.155)`, B/R 0.254,
   i.e. **>=** matRock, so correcting the veil cannot invert the near/far relationship.

7. **New `matShelf` + `uWetAmt`.** The tide-pool shelf is a 56x14 m near-flat plate seen
   at grazing incidence and sits entirely inside the wet band, so at full sheen it
   rendered as chrome foil. Nulling `uDetailAmt` on it dropped its lap_var 3234 -> 24,
   proving every bit of that energy was detail normals and none of it was the mesh. It
   now has its own material (`detail: 0.72`, `wetAmt: 0.35`, `specF0 0.020 / F90 0.30`),
   and the global wet roughness floor moved 0.31 -> 0.44, wet F90 0.80 -> 0.62.

8. **Ledge step softened** (`la` step-in x0.55 over a 3x wider t band) — the hard step
   was reading as a wedding-cake tier in the silhouette.

## Cost

`rocks` init 1436 ms -> **1427 ms** at ref_00000 (noise; the geometry work is the same
loop with three extra multiplies). Fragment cost: **+1 triplanar tap set** (3 texture
fetches) for the 3.5 m octave, and one `distance()`. One extra material/shader variant
(`matShelf`) = one extra program compile and no extra draw call — the shelf was already
its own mesh. 323 draw calls / 7.68 M triangles at ref_00000.

## Weakest thing left

The aerial veil in `src/gfx/materialCommon.js`. With it shipped the stack is still
sat 20.7 / lab_b -4.1 / lum_std 5.0 and reads blue, and nothing in this file can touch
that. Everything above is measured with it nulled.

Second: `lum_std` is 17.1 against a reference 35-63, and `p99` 107 against 226. The
stacks at this pose have no plane taking direct sun — there is no sun/shade terminator
on the silhouette, only ambient. That is a light-direction/exposure question, not an
albedo one, and it is the largest remaining gap after the veil.

Third: near-field `edge_density` 0.263 against 0.123. Bisection shows the residue is in
the 9 m / 3.5 m octaves, not the fine ones — i.e. it is genuine mid-scale relief seen at
a grazing angle, not aliasing. Reducing it further would cost the stacks, which are
currently on their edge-density target.
