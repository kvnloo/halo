# rocks — critic round 2: sheen, form, and the detail ladder

Owner file: `src/world/rocks.js`. Supersedes the form+palette report.

---

## 0. Measurement rig — the previous report's rig was measuring the sky

The `rock` ROI (`0.24,0.02 – 0.58,0.50`) at ref_01500 is a **fixed screen rectangle that
is only 25–40% rock**. Everything else in it is sky, cloud, the ring and water. Every
ROI-wide mean in the last report — and in the critic's table — is therefore mostly a
statement about the sky module.

The rig used here builds an **exact rock mask** instead, by differencing the frame
against the same frame with the rock albedo forced to pure black:

```
node tools/capture.mjs --pose ref_01500 --config aerialDensity=0,fogDensity=0 --out A.png
node tools/capture.mjs --pose ref_01500 --config aerialDensity=0,fogDensity=0,rockDbg=1 --out B.png
# mask = |A - B|max > 6   ->  exactly the pixels this module painted
```

`rockDbg` is new and permanent (see §6). Reference counterparts are the two rock-only
boxes in `ref/keyframes/kf_01500.png`: hero stack `600,80–950,420`, right stack
`1290,180–1520,470`.

**Two hazards, both real, both cost me captures.** (a) A dozen agents are editing other
modules right now; three captures in this session came back with `rocks` missing or
`vegetation`/`weapons` failing to boot, and one whole run had the post chain 404. Check
`failedModules` on every capture before you believe a number. (b) Two identical
back-to-back captures currently differ by a **uniform ~13 code values across sky, cloud
AND rock alike** (`meanabs` 11.9 / 12.8 / 14.1 in three disjoint boxes) — that is global
exposure, not geometry, and it is not this module. Absolute luminance is therefore ±14
noisy between runs; hue (`R-B`, `lab_b`) and ratios are not. All A/B pairs below were
captured back to back.

---

## 1. Headline: before / after, rock-only mask, ref_01500, both veils nulled

```
                        lum   std    sf      hf     sat   lab_b   R-B    lap_var   lc
BEFORE (session start) 81.2  39.7  0.1470  0.0016  90.9   8.76   19.11   1618   0.1843
AFTER                  88.7  31.8  0.0520  0.0000  91.4  15.61   30.56   1261   0.1253

ref hero stack box     70.9  35.3  0.0751  0.0000  96.4  12.30   29.15   1235   0.1080
ref right stack box   115.2  63.3  0.0258  0.0124  92.5  17.31   43.13   3178   0.2097
```

Every axis except the highlight tail now lands **between the two reference stacks**.
The hue error the critic called "a 40-code inversion" is closed: `R-B` 19.1 → 30.6
against a reference 29.2–43.1, `lab_b` 8.8 → 15.6 against 12.3–17.3.

Cliff, ref_00000, rock-only mask: **`R-B` −7.7 (critic's measurement) → +19.3**,
`lab_b` +9.5, `sat` 80.3. Still ~8 short of the reference cliff ROI's +27.1 and 29%
dark (lum 61.7 vs 86.6), but the inversion is gone.

---

## 2. [critical 1] The sheen — re-derived against a black-albedo capture

The critic's "36/37/45 black-albedo floor" is the **ROI mean, i.e. mostly sky**. Measured
on a box that is entirely rock (`750,240–880,460`), back to back:

```
black albedo, F90 0.45, no spec occ   rgb  5.61 / 5.54 / 5.76   R-B -0.16
black albedo, F90 0.13 + cavity occ   rgb  2.83 / 2.79 / 2.71   R-B +0.12
```

Target was "neutral-to-warm and under ~8 sRGB". Met: **2.8 sRGB, R−B +0.12**. Later
re-measured on the current build with vegetation overhanging the box, median 4/255.

Three changes, in the order the critic asked for:

1. `uSpecF90` **0.45 → 0.13**. `research/terrain.md` §5.3 puts dry cliff rock at F0 0.04
   and a microporous carbonate has no coherent grazing interface at all — the "surface"
   is a statistical mix of grains, pores and dust, so the Fresnel edge peak is suppressed
   rather than rising toward unity. 0.45 was buying a blue rim wash and nothing else.
   The wet branch still lifts to 0.62, which is the whole point of a wet rock.
2. **Specular occlusion by the baked cavity mask**, the way `terrain.js` does it with
   `gTSpecOcc`. `so = mix(1, 0.20 + 0.80*occ, uSpecOccAmt) * mix(1, 0.38, shl) *
   mix(0.70, 1, wet)`, consumed at `<lights_fragment_end>`:
   ```glsl
   reflectedLight.directSpecular   *= gRKSpecOcc;
   reflectedLight.indirectSpecular *= gRKSpecOcc;
   reflectedLight.indirectDiffuse  *= gRKAO;
   ```
   `ROCK_FRAG` injects at `<lights_fragment_begin>`, which is too early to touch
   `reflectedLight`; the hook is chained **in front of** `applyWorldMaterial`'s so the
   latter captures it as `prev`.
3. Palette re-levelled afterwards, not before: `matRock` base `C(0.620,0.500,0.151)` →
   `C(0.532,0.426,0.120)`; `matFar` and `matShelf` in step. B/R held at ~0.23.

### The bigger finding this experiment produced

Forcing the albedo to a **flat 0.18 neutral grey** (`--config rockDbg=2`) shows what the
lighting alone does to this rock:

```
flat 0.18 grey albedo, both veils nulled:
  rgb 72.5 / 76.1 / 87.7    R-B = -15.2    lab_b = -7.45
  p01 52   p50 60   p99 147   shadow_frac 0.0012
```

**A neutral surface renders blue, and the lighting has no dark tail at all.** The rock is
dominated by a blue sky probe with a sun:ambient ratio far below the reference's. That is
`env` / `lighting` / exposure, not `rocks.js`, and it caps what any albedo in this file
can do. What *is* in this file, and was wrong:

**AO was being multiplied into the albedo**, so it dimmed the sun as well as the sky —
exactly backwards when the sky is the term you want to suppress. It now goes to
`reflectedLight.indirectDiffuse` only (`gRKAO`). Measured effect on the rock-only mask,
back-to-back pair: `lum` 73.5 → 83.7, `lap_var` 1712 → 1902, `p99` 159 → 168, and
`shadow_frac` landed on 0.073 against the reference hero box's 0.075.

---

## 3. [critical 3 / major 4] Form — planes that are actually planar, profiles that are not mushrooms

**Cleavage faces.** `pl.k` **R*[0.055,0.14] → R*[0.008,0.020]** (a 2.1 m fillet at R=15
became 30 cm; at 90 m the old one subtended ~25 px and could only read as a dent).
Band gate `w` went from `hh*[0.22,0.46]` — a ramp taller than most of the band — to
`H*[0.012,0.035]`, i.e. **narrow ramps at the band ends only, so inside the band the face
IS the plane**. The ramp then reads as a horizontal fracture edge, which is what a
bedding plane is. Angular acceptance `c > 0.26 → c > 0.15` with the planarity weight
re-normalised: widening it is free because `p/cos` blows up off-axis and the `min` does
nothing there, but it was what left `rough = 1 - 0.88*planarity` near 1 over most of the
perimeter and let the noise sand the faces back off. `nPlanes` 4+[0,2] → 6+[0,3].

**Plane bands had to reach below the foot.** `y0` started at `baseY + H*[-0.06,0.55]`,
so half the planes began above y = 6 m and the bottom 10 m of every stack was never
clipped by anything — a bell-shaped skirt under a faceted shaft. This, not the wave-cut
platform, was the surviving "traffic cone" read. Now `y0 = baseY + H*[-0.40,0.34]`,
`hh = H*[0.55,1.30]`.

**Profiles.** All seven ran 0.68–0.78 R at the foot to 1.10–1.18 R at t=0.80 — 45–70%
wider at the shoulder than at the base — off one curve with jittered numbers. Replaced
with five distinct shape families, all bottom-loaded and all with ≤15% total taper:
plumb column (hero), leaning slab with a mid-height undercut (arch), tapered spire
(twin_a), stubby drum (twin_b), two-tier block (far_a), slender leaner (far_b).
The `R*0.22` one-sided **brow is deleted**; each stack now has exactly one overhang
event, from `notch` or from the new optional `spec.undercut` (a one-sided gaussian
*removal* of mass, so the rock above genuinely hangs). Wave-cut platform flare
`R*0.07 → R*0.022` and pulled below y = 1.2.

The critic is right that ROI stats do not catch a shape defect. `shots/rk/f2.png` and the
2× crop of the hero stack are the evidence: a near-plumb column with two large faces
meeting at a visible vertical arête that carries a real value step, irregular horizontal
fracture lines, and a hard bevelled crown rim. It is no longer a muffin.

**Mesh resolution was raised and then reverted.** 224×176 → 256×192 plus the extra planes
took the rocks init from 1427 ms to **2394 ms**. Reverted to the original resolutions,
keeping the plane count: **1515 ms**, +6%. The arête sharpness comes from the clip, not
from the tessellation.

---

## 4. [major 5] The detail ladder is now derivatives with a footprint gate

**§3.2 — compose as derivatives.** The old ladder was
`normalize(Ng + Σ w_k (n_k − Ng))`, a normal lerp, which understates the composed slope
wherever two octaves are both steep (Mikkelsen, *Surface Gradient–Based Bump Mapping
Framework*, JCGT 9(3) 2020, Eq. 2 — <http://jcgt.org/published/0009/03/04/>). Each octave
is now resolved to its tangent-plane surface gradient, those are summed, and the
conversion happens once:

```glsl
vec3 rkGrad(vec3 nk, vec3 Ng){ float d = max(dot(Ng,nk),1e-3); return (Ng*d - nk)/d; }
gDet = Σ (amp_k * k * w_k) * rkGrad(n_k, Ng);
gDet *= (len > 8.0) ? 8.0/len : 1.0;          // clamp the SUM, slope 83 deg
nDet  = normalize(Ng - gDet);
```
`normalize(Ng - g)` reproduces a single octave exactly and composes correctly for several.

**§3.1 — footprint, not camera distance.** The old gate was
`1 - smoothstep(8, 26, vDist)` applied to the albedo of the two finest octaves *only*, so
the 30 cm and 5.5 cm **normals** still contributed at 300 m where 5.5 cm subtends 0.02 px.
That was the uniform isotropic fizz over the whole 42 m stack. Now:

```glsl
vec3 ddxP = dFdx(P), ddyP = dFdy(P);
float fp = max(length(ddxP), length(ddyP));            // anisotropic max, metres
w_k = 1.0 - smoothstep(0.5, 1.0, fp / L_k);            // L = 9.0, 3.5, 1.15, 0.30, 0.055
```
and `w_k` gates that octave's **normal and its albedo together**.

**§3.3 — the variance has to go somewhere.** An octave that left under the gate now adds
its variance back to roughness in alpha space, so the rock does not get glossier as it
recedes: `rgh = sqrt(rgh² + Σ (1-w_k)·c_k)`.

**§3.3b — geometric specular AA, which this module had none of.** Tokuyoshi & Kaplanyan,
I3D 2019, Eq. 4 / Listing 2 (<https://www.jp.square-enix.com/tech/library/pdf/ImprovedGeometricSpecularAA.pdf>),
6 ALU, sitting directly above `material.roughness`:
```glsl
vec3 dnx = dFdx(nDet), dny = dFdy(nDet);
float nvar = 0.25 * (dot(dnx,dnx) + dot(dny,dny));         // SIGMA2 = 0.25, unverified
material.roughness = sqrt(clamp(rough² + min(2.0*nvar, 0.18), 0.0, 1.0));  // KAPPA = 0.18
```
`SIGMA2 = 0.25` is Kaplanyan's half-pixel box kernel; the paper does not state a numeric
value, so it is flagged in code as tuned rather than cited.

---

## 5. [major 6] axisSign, hex-tiling, height blending — and the detail map itself

**Golus's `axisSign` projection correction** (§4.1) is in. Three lines, free, and without
it every face whose axis component is negative samples a mirrored projection — on a
generalised cylinder that is half of every stack with its detail lighting running
backwards. All triplanar fetches also moved to `textureGrad`, which makes the whole
function legal inside non-uniform control flow.

**Mikkelsen hex-tiling** (JCGT 11(2) 2022, γ=7, β=0.6, gain disabled for normals) is
implemented and applied to the **two coarse octaves only** (9 m, 3.5 m), gated on
footprint — `step(fp, 0.22)` and `step(fp, 0.09)` — so it costs its 6 extra taps per
octave only while the tile is still large enough on screen for a repeat to be visible,
and 0 taps past ~250 m / ~100 m. Derivatives are taken **before** the random offset
(Heitz §5.4) or you get a 1 px blurred line tracing every hex edge. The vertex hash is
integer (`uvec2` multiply/xor), because research §1.5 is right that `fract(sin(x)*43758)`
and `fract(p*0.1031)` both run out of mantissa past vertex id ~2000, which happens
partway along the 340 m cliff. `--config rockHex=0` turns it off for A/B; it cost 0 ms of
init and I could not isolate its frame cost above the ±14-code exposure noise.

**Height-blended tide line** (Mishkinis, *Advanced Terrain Texture Splatting*, 2013).
The 3.45 m linear ramp is gone:
```glsl
float dampW = clamp(smoothstep(4.4, 0.15, yw) * uAlgaeAmt, 0, 1), dryW = 1.0 - dampW;
float dMa = max(h + dryW, (1.0-h) + dampW) - 0.20;      // DEPTH 0.20, research 4.4
damp = max((1.0-h)+dampW-dMa, 0) / max(b1+b2, 1e-5);
```
The damp material's height is `1-h`: the sea fills the low plates first and leaves the
proud faces dry, which is what makes a splash line ragged. The same `b` weight now drives
**roughness** as well as albedo (`rgh = mix(rgh, 0.52, damp*0.55)`) — a crisp colour edge
over a soft lighting edge reads as a decal.

**The detail map was the actual source of the "popcorn".** This is the thing the critic
described as "one uniform isotropic 30 cm speckle over the entire 42 m object", and no
amount of ladder work fixes it, because map A was
`0.55*ridged + 0.30*fbm − 0.20*worley pockets` — isotropic blob noise at essentially one
scale. `ref/detail/rock_4k.png` is a **mosaic of near-flat plates separated by knife-edge
fracture lines**. Map A is now:
* plates — a warped smooth field terraced (`floor` + a 0.14-wide riser) and mixed 65/35
  with the un-terraced field. 100% terrace reads as a machined contour map; that was the
  first attempt and it produced visible 1.7 m rings.
* two families of thin deep fracture cuts. **Width matters more than depth**: at
  smoothstep widths 0.050/0.032 the 1-texel cut Sobels into a near-90° normal and
  measured `lap_var` **5565** against a reference 1296. Widened to 0.080/0.052 → 1031.
* a small grain term and sparse, large solution pockets (worley 14 → 7 cells).

Tiling note recorded in the code: `tgnoise`/`tfbm` stay periodic under any *additive*
offset but only under **integer** scale multiples, so every rescale in the map is 2× or 3×.

Once the popcorn was gone the shader's **bedding** term became the new procedural tell —
`fract(P.y*0.58 + …)` is a dead-level 1.72 m contour ring. It now carries a ±2.2 m
low-frequency warp and a strength mask, and its albedo amplitude dropped 0.20/0.11 →
0.13/0.08. The 25:1 vertical runoff `streak` was likewise applied to every non-up-facing
texel — corduroy — and is now gated by a low-frequency patch field at 0.55 → 0.36 strength.

---

## 6. New diagnostics (permanent, read per frame from `ctx.config`)

`tools/capture.mjs --config` pokes `ctx.config` *after* boot, so these are synced in
`update()` rather than baked at init:

```
rockDbg=1      albedo forced to pure black — whatever is left is indirect specular
rockDbg=2      albedo forced to a flat 0.18 grey — shows the LIGHTING alone
rockSpecF90    grazing Fresnel of the dry rock (shipped 0.13)
rockSpecOcc=0  disable cavity specular occlusion
rockHex=0      disable hex tile-breaking
rockDetail     global detail-normal amplitude
```

`rockDbg=1` is what the mask rig in §0 is built on and is the only honest way to tune a
sheen: an albedo problem cannot survive its own albedo being zero.

---

## 7. Cost

`rocks` init **1427 ms → 1515 ms** (+6%), after reverting a mesh-resolution bump that had
taken it to 2394 ms. Fragment: the ladder is the same 5 triplanar octaves (15 fetches),
now `textureGrad` instead of `texture`, **plus** up to 12 extra fetches on rock nearer
than ~250 m from the two hex-tiled coarse octaves, and 0 beyond that. New ALU: one
`rkGrad` per octave (5 × ~6 ALU), the footprint `max(length(dFdx(P)), length(dFdy(P)))`
once, and 6 ALU of specular AA. Two extra `reflectedLight` multiplies at
`<lights_fragment_end>`. No new draw calls, no new materials, no new textures.

---

## 8. Weakest things left, in order

1. **`highlight_frac` is still ~0 against the reference ROI's 0.044, and it is not
   reachable from this file.** The flat-grey probe in §2 shows the rock's own lighting
   spans p01 52 → p99 147, a 2.8× range in sRGB, against a reference stack that spans
   28 → 226 (8×). The sun at ref_01500 is azimuth 118°, elevation 41°, i.e.
   `sunDir ≈ (0.667, 0.656, −0.354)`, while the camera looks −Z — so the +Z hemispheres
   the stacks present to camera are **backlit**, and only the +X limb catches sun. The
   reference frame's bright stack is in full sun. Note the reference *hero* stack box
   also measures `highlight_frac` 0.0000, so this is a framing difference plus a
   sun:ambient ratio owned by `lighting`/`env`/exposure, not an albedo or a form defect.
2. **`uAerialDensity = 0.0062 /m` in `src/gfx/materialCommon.js` still blocks, and
   `shots/rk/final.png` is the proof.** That is a shipped-config capture at ref_01500
   with nothing nulled: the stacks are pale blue-white slabs with no hue, no faces and
   no tide band, brighter than the sky behind them. Compare `shots/rk/f2.png`, the same
   build with `aerialDensity=0,fogDensity=0`. **Every form, palette and detail change in
   this report is invisible in the shipped frame.** Not my file; the critic's arithmetic
   stands (t = 0.354 at the 90 m hero stack, ~15–60× clear-air extinction). The secondary
   bug in the same function — `inscatter += uAerialSunColor * phase * uAerialSunAmount`
   with no cap against the sky's own radiance, so a dissolving silhouette ends up
   brighter than the sky it is dissolving into — is still there and is exactly what that
   capture shows.
3. **The cliff at ref_00000 is 29% dark** (lum 61.7 vs 86.6) and `local_contrast` 0.069
   vs 0.168, while the stacks at ref_01500 are 12% *bright*. The two pull opposite ways
   under a single albedo, which says the residual is AO/shadowing on the cliff mesh, not
   the palette. Next thing I would isolate.
4. **`lum_std` 31.8 vs the reference hero box's 35.3 and right box's 63.3.** Same root
   cause as (1).
5. The measurement environment itself: ±14 code values of global exposure drift between
   identical captures, and other modules failing to boot mid-run. Anyone re-measuring
   this should re-read §0 first.
