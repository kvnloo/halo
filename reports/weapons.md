# weapons — MA5B viewmodel (wave 2)

Owner file: `src/game/weapons.js` (only). Previous wave's report is superseded; its
methodology notes are kept at the bottom.

## THE FINDING — 25–99% of the viewmodel's triangles were wound inside-out

Everything else in this wave is downstream of this. Found offline, with a new tool, in
about ten minutes and zero captures.

WebGL's front face is CCW: a triangle is front-facing exactly when `(b-a) x (c-a)` agrees
with its own shading normal. `tools/_wind.mjs` compares those two per triangle. Before
the fix, share of triangles whose winding **opposed** their normal, by surface area:

```
boltPoly 99.5%   armR 99.5%   engrave 100%   plate 75.8%   rail 69.2%
handL    68.7%   poly 42.9%   mag  33.9%     body  25.0%
```

With `side: FrontSide` (the `MeshStandardMaterial` default) that does not punch a hole
you would notice — it culls the near surface and draws the model's **inside**, shaded by
normals pointing away from the viewer. It reads as a soft, pale, structureless mass. The
critic's "pale warm-beige stick … carved sandstone, not gunmetal" was, in large part,
the interior of the mesh.

Two independent causes:

1. `extrudeProfile` walks its stations along **-Z** for `segRounded` and
   `ribbedCylinder`, which flips handedness against a CCW-in-XY profile. That is the
   forearms, every finger, the charging handle, the muzzle stub.
2. `chamferBox`'s eight corner facets are `tri(cx, cy, cz)`, which is only CCW for the
   four even-parity corners.

Fixed once, in `MB.tri()` and `MB.quadN()`: if the geometric normal opposes the shading
normal, swap the last two vertices. One cross product per triangle at build time, and it
cannot be got wrong again by the next primitive someone adds.

## SECOND FINDING — every chamfer band was a bowtie with two holes in it

`chamferBox`'s `band(p0, p1, q0, q1)` receives its four points in **ring** order, so the
vertex opposite `p0` across the band is `q1`, not `q0`. It paired them `p0+q0` / `p1+q1`,
which puts both "midpoints" on the band's centroid — `mid0 === mid1` **exactly**. Each
chamfer therefore emitted two real triangles meeting at a point plus two
exactly-degenerate ones, leaving two triangular holes through the chamfer, and the
`0.3 -> 1 -> 0.3` edge-mask ramp the function exists to produce collapsed to one value.

Found with `tools/_wpntri.mjs`: 12 zero-area triangles per `chamferBox`, every one with
two identical vertices at the band centre. That is also what `cullDegenerate()` had been
quietly deleting for a wave — it was removing the symptom.

## THIRD FINDING — the surviving "dotted hairline across the beach"

`--skip weapons` differencing left 73 stray mask components on a single line from
(1360,707) to (1918,1045). `tools/_wpntri.mjs` projects every triangle through the
mount transform offline and ranks by screen-space aspect, which named it in one run:
the rail recess's rear lip wall, `obj [[0.018,0.0465,0.086],[-0.018,0.0465,0.086],
[-0.0144,0.0427,0.0824]]` — inverted winding, so the wall that should have been hidden
was drawn and poked a sub-pixel fringe past the rail silhouette. Down to **11** strays
after the winding fix, and those are legitimate 1-px chamfers seen edge-on.

## Measurement rig

`tools/_wpn2.py` — gun-only structural statistics. The mean is not the image, so it
prints the luma histogram in the bins that separate gunmetal from sandstone, a
connected-component analysis of the highlight population, per-scanline silhouette
coverage, and lap_var / local_contrast on an **eroded** mask.

```
sh tools/_wpnab.sh <tag>                                  # paired capture (with / --skip weapons)
.venv/bin/python tools/_wpn2.py ours shots/<tag>.png shots/<tag>_nw.png
.venv/bin/python tools/_wpn2.py ref  ref/keyframes/kf_00000.png
node tools/_wpntri.mjs screen|slivers                     # offline, no GPU
node tools/_wind.mjs                                      # winding audit
```

**`tools/_wpntri.mjs` is the important one.** `passes/scene.js` renders the viewmodel
with `pipe.viewCamera`, whose world matrix is copied from the main camera, so
`root.matrixWorld = cam.matrixWorld · M_mount` and the view matrix is
`cam.matrixWorld⁻¹` — a vertex's **view-space** position is exactly `M_mount · v`,
independent of where the player is standing. The entire viewmodel screen layout is
therefore computable in bare node. Validated against the GPU: projected bottom-row
coverage 485 px against 487 px measured. Mount-pose and silhouette work costs seconds
instead of a 2-minute capture per guess.

**World flux warning.** Terrain/ocean/fog were being edited by other agents throughout
this session; `SAND(ours)` inside the weapon ROI moved from `L 67.1 / R-B −12.6` to
`L 90.7 / R-B +22.5` between two of my own captures. Absolute gun luminance is therefore
not comparable across captures. The **gun/sand luminance ratio inside one capture** is,
and the reference's is **0.496** (gun 67.46 / sand-in-ROI 136.1).

## Results

Gun-only, pose ref_00000, mask = `--skip weapons` difference clipped to the ROI.

```
                     before    winding fix       ref
n (silhouette)       175688        232753     242005
lum_std               33.70         35.43      52.28
lap_var              298.9         664.7     1156.0
local_contrast        0.097        0.1248      0.157
>170 components          23           180        491
  largest holds       82.4%         62.9%      39.7%
>200 components          30           129        319
  largest holds       95.8%         82.2%      36.0%
stray components         73            11          0
```

Silhouette area is now 96% of the reference and the highlight population went from
23 components to 180 — the chamfer glints exist for the first time. `lap_var` more than
doubled without a single shader change.

Still wrong after this step, and being worked next: albedo is sand (crit 1), no
geometric specular AA (crit 2), the env probe is 52% of all light with no occlusion
(crit 3), mount pose does not seal the frame (major 5), the hand is not a hand
(major 6).

---

## Inherited notes that still hold (wave 1)

- `applyWorldMaterial` ends with `registerMaterial` → three's CSM does a bare
  `material.onBeforeCompile = ...` with **no chaining**, so it overwrites the hook
  `applyWorldMaterial` just installed and the whole injection is discarded before the
  first compile. `vmMaterial` re-installs its own hook afterwards and chains. **This
  affects every world material in the project**, not just the viewmodel — not my file
  to fix.
- The correct fragment anchor is `<lights_physical_fragment>`, not
  `<lights_fragment_begin>`: the latter runs after diffuseColor / roughnessFactor /
  metalnessFactor have already been copied into the BRDF struct.
- Do NOT tune to `ref/roi_signatures.json`'s `weapon` row. It is a clip mean over a
  screen rectangle that is ~65% sand.
- Fog cannot reach this object: every `applyWorldMaterial` here passes `aerial: false`
  and the viewmodel draws after `clearDepth()` with its own camera at ~0.4 m. Confirmed
  again this wave — `--config fogGeoAmbient=1` moves the gun 0.4 luma.
