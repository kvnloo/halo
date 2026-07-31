# weapons — MA5B viewmodel (wave 2)

Owner file: `src/game/weapons.js` (only). Supersedes wave 1's report; its still-valid
notes are kept at the bottom.

---

## 1. THE FINDING — 25–99% of the viewmodel's triangles were wound inside-out

Everything else in this wave is downstream of this. Found offline, with a new tool, in
about ten minutes and zero captures.

WebGL's front face is CCW: a triangle is front-facing exactly when `(b-a) × (c-a)` agrees
with its own shading normal. `tools/_wind.mjs` compares those two per triangle. Before
the fix, share of triangles whose winding **opposed** their normal, **by surface area**:

```
boltPoly 99.5%   armR 99.5%   engrave 100%   plate 75.8%   rail 69.2%
handL    68.7%   poly 42.9%   mag  33.9%     body  25.0%
```

With `side: FrontSide` (the `MeshStandardMaterial` default) that does not punch a hole
you would notice — it culls the near surface and draws the model's **inside**, shaded by
normals pointing away from the viewer. It reads as a soft, pale, structureless mass. The
critic's "pale warm-beige stick … carved sandstone, not gunmetal" was, in large part,
literally the interior of the mesh.

Two independent causes:

1. `extrudeProfile` walks its stations along **-Z** for `segRounded` and
   `ribbedCylinder`, which flips handedness against a CCW-in-XY profile. That is both
   forearms, every finger, the charging handle, the muzzle stub.
2. `chamferBox`'s eight corner facets are `tri(cx, cy, cz)`, which is only CCW for the
   four even-parity corners.

Fixed once, in `MB.tri()` and `MB.quadN()`: if the geometric normal opposes the shading
normal, swap the last two vertices. One cross product per triangle at build time, and it
cannot be got wrong again by the next primitive someone adds. Post-fix audit: 0.3% of
`body` (8 near-degenerate triangles), 0.0% everywhere else.

## 2. SECOND FINDING — every chamfer band was a bowtie with two holes in it

`chamferBox`'s `band(p0, p1, q0, q1)` receives its four points in **ring** order, so the
vertex opposite `p0` across the band is `q1`, not `q0`. It paired them `p0+q0` / `p1+q1`,
which puts both "midpoints" on the band's centroid — `mid0 === mid1` **exactly**. Each
chamfer emitted two real triangles meeting at a point plus two exactly-degenerate ones,
leaving two triangular holes through the chamfer, and the `0.3 → 1 → 0.3` edge-mask ramp
the whole function exists to produce collapsed to a single value.

Found with `tools/_wpntri.mjs`: 12 zero-area triangles per `chamferBox`, every one with
two identical vertices at the band centre. That is also what `cullDegenerate()` had been
quietly deleting for a wave — it was removing the symptom, which is why "tighten the
threshold" would never have worked.

Fixing this alone took the `>170` highlight-component count from **23 to 180**: the
chamfer glints the critic's problem 4 is about did not exist because half of every
chamfer was missing.

## 3. THIRD FINDING — the surviving "dotted hairline across the beach"

`--skip weapons` differencing left 73 stray mask components on a single line from
(1360,707) to (1918,1045). `tools/_wpntri.mjs` projects every triangle through the mount
transform offline and ranks by screen-space aspect ratio, which named it in one run: the
rail recess's rear lip wall, `obj [[0.018,0.0465,0.086], [-0.018,0.0465,0.086],
[-0.0144,0.0427,0.0824]]` — inverted winding, so the wall that should have been hidden
was drawn and left a sub-pixel fringe outside the rail silhouette. **73 strays → 0**
after the winding fix.

---

## 4. Measurement rig

**`tools/_wpntri.mjs` is the tool that mattered.** `passes/scene.js` renders the
viewmodel with `pipe.viewCamera`, whose world matrix is copied from the main camera, so
`root.matrixWorld = cam.matrixWorld · M_mount` and the view matrix is
`cam.matrixWorld⁻¹` — a vertex's **view-space** position is exactly `M_mount · v`,
independent of where the player is standing. The entire viewmodel screen layout is
therefore computable in bare node, with no GPU and no browser.

Validated against the GPU twice: projected bottom-row coverage 485 px vs 487 measured,
and later 911 vs 911. Modes:

```
node tools/_wpntri.mjs screen      # per-scanline coverage, per-group screen bbox,
                                   # a PPM overlay against the reference silhouette,
                                   # and /tmp/vmmask.pgm
node tools/_wpntri.mjs slivers [maxWidthPx] [x0,y0,x1,y1]
node tools/_wpntri.mjs optimise    # hill-climb MOUNT_POS/MOUNT_ROT for silhouette IoU
node tools/_wpntri.mjs hands       # same for the glove / forearm mounts
node tools/_wind.mjs               # winding audit
.venv/bin/python tools/_wpn2.py proj shots/x.png     # gun-only structural stats
.venv/bin/python tools/_wpn2.py ref  ref/keyframes/kf_00000.png
```

`_wpn2.py` prints the things that separate gunmetal from sandstone: the luma histogram in
the bins that matter, connected-component analysis of the highlight population,
per-scanline coverage, and lap_var / local_contrast on an **eroded** mask.

### Two measurement hazards, both real, both cost me captures

**(a) The world moves between paired captures.** Terrain/ocean/fog were being edited by
other agents throughout. `SAND(ours)` inside the weapon ROI went `L 67.1 / R−B −12.6` →
`L 90.7 / R−B +22.5` → `L 79.1` → `L 95.8` across my own captures. Worse, the
`--skip weapons` difference mask is **poisoned** whenever a terrain edit lands between
the two frames of a pair: n jumps from 215k to 490k and every statistic is garbage. Three
of my measurements had to be thrown away this way. `tools/_wpn2.py proj` fixes it — it
uses the geometry-derived mask from `_wpntri.mjs`, eroded 3 px for idle sway, which does
not care what terrain is doing.

**(b) Absolute luminance is not comparable across captures, the gun/sand ratio is.**
Reference: gun 67.46 / sand-in-ROI 136.1 = **0.496**. Ours went 0.840 (wave 1, i.e. the
gun was nearly the same value as the beach behind it — the figure-ground failure the
critic describes) → **0.585** now.

---

## 5. Results — gun only, pose ref_00000

Wave-1 baseline and the winding fix are measured through the `--skip weapons` difference
mask; the last two columns use the projection mask (see 4a). Where the two masks overlap
they agree to ~3%.

```
                    wave 1     winding      final       ref     acceptance
n (silhouette)      175688      232753     199067    242005
lum_mean             56.41       63.67      56.03     67.46
p50                  48.65       56.57      49.55     48.97    ~49          MET
lum_std              33.70       35.43      37.56     52.28
frac < 25           0.0575      0.0470     0.1610    0.1898    >= 0.15      MET
local_contrast       0.097      0.1248     0.1385     0.157
lap_var              298.9       664.7      359.0    1156.0
R-B                  +8.44       +4.47      -9.10    +11.02                 MISSED
gun/sand ratio       0.840       0.702      0.585     0.496
stray components        73          11          0         0                 MET

luma histogram, fraction of gun pixels
  0-15              0.0001      0.0005     0.0631    0.0573
  15-25             0.0574      0.0466     0.0978    0.1325
  25-80             0.8213      0.7370     0.6734    0.5304
  80-130            0.0789      0.1629     0.1120    0.1157
  130-170           0.0113      0.0229     0.0218    0.1065    >= 0.06      MISSED
  170-200           0.0165      0.0178     0.0213    0.0301
  200-256           0.0145      0.0124     0.0105    0.0276

highlight components  (px > 170)
  count                 23         180         22       491    > 200        MISSED
  largest holds      82.4%       62.9%      82.5%     39.7%    < 45%        MISSED

per-scanline coverage inside the weapon ROI, of 922 columns
  y1079                407         487        867       922    > ~850       MET
  y1040                402         519        905       915
  y1000                409         555        897       830
  y950                 353         515        893       732
  y900                 318         473        897       640
```

The histogram is the headline: `frac<25` 0.058 → 0.161 against the reference's 0.190,
`0-15` 0.0001 → 0.063 against 0.057, at `p50` 49.55 against 48.97 and `local_contrast`
0.139 against 0.157. The gun has a real deep-shadow population for the first time, and it
is not there because the mean was pushed down — the median is still on target.

## 6. What changed, and why

**Albedo (crit 1).** `mats.body` went `0x847661` = linear (0.229, 0.180, 0.120), which is
dry-sand albedo, to `0x3c3e43` ≈ linear 0.045 — research/weapons.md §4.5's black anodised
aluminium, at **metalness 1.0** (anodising is a thin oxide, not paint). Rail, plate,
polymer and glove to the same table. The reference gun is warm because it sits in strong
warm sand bounce, not because its albedo is warm: the counter-housing shell in kf_00000
measures RGB (63.3, 69.6, 75.8), R−B **−12.5**.

A consequence worth writing down, because it is what made this hard: **at metalness 1.0
the HemisphereLight and the warm bounce DirectionalLight contribute nothing.** three's
meshphysical gives metals no diffuse term, so the PMREM probe is the gun's entire
ambient. Cutting `weaponEnvInt` to 0.20 (the critic's crit-3 asks for the §2.2 fill range
of 0.06–0.12 of sun) drove the gun to `lum_mean 27.2` with **64% of its pixels below code
25** — a black hole. §2.2's 0.06–0.12 is the *private camera-relative fill*; the specular
IBL is listed separately in the same table with no cap, and for a metal it is not
optional, it is the shading. Settled at `weaponEnvInt 0.95`, modulated per-vertex by cast
AO.

**Geometric specular AA (crit 2).** Filament's `normalFiltering()` (Kaplanyan 2016 /
Tokuyoshi 2017 / Tokuyoshi–Kaplanyan 2019) injected verbatim after `roughnessFactor` is
computed, on the **geometric** normal `vNormal`, variance 0.15, threshold 0.2, plus
`MIN_PERCEPTUAL_ROUGHNESS` 0.045. Separately — and this is the larger half — the detail
map's scale budget was wrong: at 0.4 m and 1920 px one pixel is 0.39 mm, and at
`uDetailScale 7.2` with N=512 one texel is 0.28 mm, so the *whole texture* lived at or
below the pixel. `makeSurfaceTex` now derives normals from the 8-period octave (17 mm
features) and the rasterised scratches only, with a 5-tap derivative; the 48-period
octave (2.9 mm ≈ 7 px) moved into the **roughness** channel where sub-pixel geometry
belongs. `uNormalStr` 0.95 → 0.30.

**Cast AO (crit 3).** research §2.3.2 implemented: a BVH over the whole rest-pose
viewmodel, 24 cosine-weighted rays per unique (position, normal), cached, written to an
`aAO` vertex attribute. Applied by injecting after `<aomap_fragment>` — the one hook in
meshphysical that runs after `<lights_fragment_end>` where `reflectedLight.indirect*`
still exist — so it multiplies IBL/ambient and **leaves the sun alone**; occluding a
delta light with a hemispherical visibility term is double-counting and reads as dirt.
Specular occlusion goes through three's own `computeSpecularOcclusion()`.

Visibility is floored at 0.30. Unclamped it put 44% of the gun below code 25 with
p01 = 0.6, which contradicts `src/render/lighting.js`'s own header: the reference clip
never lets a shadow reach black (p01 = 17).

**Mount and mass (crit 5).** New carry-handle shell: one extrusion of a dome
cross-section with independent `sx`/`sy` per station, so it grows in height without
growing in width (a uniform scale gives a cone, and a cone is the "flat plank with a
bevel" read being replaced). Receiver 62 → 68 mm wide. The rail is now a 17.6 mm sight
channel capping the shell rather than a 57 mm prism with a 36 × 132 mm trough milled into
it. `MOUNT_POS` and both glove mounts re-solved offline by silhouette IoU. Bottom-row
coverage **407 → 867** of 922.

**Forearms (crit 6).** The right forearm was projecting to screen y 2164–6600 — it was
**entirely off the bottom of the frame** and had been for at least a wave. It is now at
IoU 0.94 against the bottom-right glove lobe. The left forearm was entering horizontally
from the left at mid-receiver height, which a left arm anatomically cannot do; it is
longer, thicker, and angled down-left, and the glove boxes are ~25% larger.

Note on the optimiser, because it is a trap: run free over all six DOF it found a pose
with a **higher** IoU (0.85 vs 0.75) that showed the **back** of the carry handle with
the ammo counter edge-on. Silhouette overlap is not the read. Rotation is now on a ±2°
rein around the hand-authored orientation, and mount z has a leash at 0.375 ± 0.03 m
(research §1.1) because otherwise the fit buys silhouette area by dragging the gun toward
the near plane — which is a zoom, not a pose, and it throws the right hand off the frame.

## 7. Cost

`weapons` init 780 ms → **1226 ms** (+446 ms one-off, the AO bake: ~10k triangles, ~6k
unique vertices, 24 rays each, through the BVH). **Zero per-frame cost** — no new passes,
no new draw calls; one extra varying and ~8 ALU in the viewmodel fragment shader on
~0.2 Mpx. If the budget matters, `--config weaponAoRays=12` halves it.

## 8. Weakest things left, in order

1. **The 130-170 rail-sheen band: 0.022 against 0.107, and 22 highlight components
   against 491.** This is crit 4 and it is not fixed. The reference's hard-surface read
   is a small specular event on every chamfer plus one long broad anisotropic sheen down
   the rail. We now have real chamfer geometry (the bowtie fix) but the events are too
   few and one plate still holds 82% of the highlight energy. The two things research
   §4.1 asks for are **not implemented**: a real anisotropic GGX lobe with an explicit
   sun term, and — §4.1.1 — a genuine `tangent` attribute on the rail, without which a
   degenerate frame makes anisotropy silently do nothing. `uRailStreak` still ships at 0.
   I did **not** write a sun disc into `buildEnvProbe`'s radiance (the critic's
   suggestion 4a): three evaluates the DirectionalLight's specular analytically through
   `BRDF_GGX`, so a disc in the IBL double-counts the sun. If someone does add it, the
   direct term has to come off at the same time.
2. **R−B is −9.1 against the reference's +11.0.** The gun is too cool. The probe's ground
   hemisphere was strengthened twice (`SAND_BOUNCE_GAIN` 3.6 → 7.2) and moved R−B from
   −13.5 to −9.1, so the term works but is nowhere near strong enough — or, more likely,
   the visible surfaces are dominated by the sky-facing shell and the bounce needs to
   subtend a much larger solid angle than the 0.30–0.85 `skyVis` ramp gives it.
3. **`lap_var` 359 against 1156.** The shell's large smooth top replaced the busy rail
   and the surface has no mid-frequency story on it. `makeDecalTex`'s panel lines are
   projected on the receiver **flanks** only (weighted by the X-facing triplanar term)
   and the shell top gets none of them. Panel lines on the shell, and the 3–4 px groove
   profile with a lip highlight the critic asks for, are the obvious next move.
4. **The left hand still does not read as a hand.** Silhouette IoU plateaus at 0.70 no
   matter where it is placed, because it is a stack of chamfered boxes, not a posed
   curled-finger rig with a pebble albedo. This needs the geometry rebuild the previous
   wave also named; it is not another placement nudge, and I did not do it.
5. The gun's top edge reaches y = 633 against the reference's 545 — the counter housing
   sits ~90 px low.

---

## Inherited notes that still hold (wave 1)

- `applyWorldMaterial` ends with `registerMaterial` → three's CSM does a bare
  `material.onBeforeCompile = ...` with **no chaining**, so it overwrites the hook
  `applyWorldMaterial` just installed and the whole injection is discarded before the
  first compile. `vmMaterial` re-installs its own hook afterwards and chains onto CSM's.
  **This affects every world material in the project**, not just the viewmodel — not my
  file to fix.
- The correct fragment anchor is `<lights_physical_fragment>`, not
  `<lights_fragment_begin>`: the latter runs after diffuseColor / roughnessFactor /
  metalnessFactor have already been copied into the BRDF struct.
- `weaponEnvInt` must be applied **deferred**, at the top of `update()`, with the render
  target saved and restored — rebuilding PMREM inside the config callback leaves the
  renderer bound to its own target and the next frame comes back black.
- Do NOT tune to `ref/roi_signatures.json`'s `weapon` row. It is a clip mean over a screen
  rectangle that is ~65% sand.
- Fog cannot reach this object: every `applyWorldMaterial` here passes `aerial: false`
  and the viewmodel draws after `clearDepth()` with its own camera at ~0.4 m.

## Research relied on

`research/weapons.md` §0.2 (FOV tangent ratio — the 55/78 split is correct, do not
"fix" it), §2.2 (the rig; and the fill/IBL distinction in §6 above), §2.3.2 (per-vertex
cast AO), §2.3.3 (contact darkening), §4.1/§4.1.1 (anisotropic GGX and the tangent-frame
gotcha — **not implemented**), §4.2 (wear follows curvature), §4.3b (0.39 mm/px scale
budget), §4.4 (Filament `normalFiltering()`, verbatim, from
`google/filament shaders/src/surface_shading_lit.fs`; parameters from
google.github.io/filament/Materials.md.html), §4.5 (linear material values and the
"albedo trap"), §1.1 (0.35–0.45 m hold distance).
