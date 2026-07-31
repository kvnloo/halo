# characters — `src/game/ai.js`

Wave H. Owner: characters agent. Target: KNOWN_ISSUES §17.3, "character models stand in
three showcase cells … reads as placeholder junk."

**Decision: option (a).** The models are kept, in frame, and in the scored poses. The
reason is that the defect turned out not to be the models.

---

## 0. Headline

**The actor material injection has never executed in any capture in this project.**
Everything else in this report follows from that.

`applyWorldMaterial()` (src/gfx/materialCommon.js) installs `mat.onBeforeCompile`, and
then, on its last line, calls `ctx.get('lighting')?.registerMaterial?.(mat)`. Three's
stock `CSM.setupMaterial` does a bare, unchained assignment:

```js
// node_modules/three/examples/jsm/csm/CSM.js:443
material.onBeforeCompile = function ( shader ) { ... };
```

That overwrites the hook `applyWorldMaterial` installed one line earlier. `lighting` is
module order 12 and every actor material is built at order 80, so the stomp is
unconditional — the injection was discarded before the first compile, every time.

Consequence for the actors: `aFx` per-vertex roughness/metalness never reached the BRDF,
so **every** actor surface — armour, methane tanks, plasma weapons, glow strips — shaded
with the base `MeshStandardMaterial` values `roughness 0.6 / metalness 0.1`. One matte
plastic for the whole cast. Emissive never ran either, and neither did aerial
perspective, so the actors did not haze with the scene.

`reports/weapons.md` found the same bug from the viewmodel side in an earlier wave and
recorded that it "affects every world material in the project — not my file to fix."
It is still unfixed centrally. **Anyone owning `materialCommon.js` or `lighting.js`
should fix it there**; every module that calls `applyWorldMaterial` is affected, and each
one is currently getting a fallback shade it did not author.

### How it was established (one step)

Guessing between "the shader is running but too subtle" and "the shader is not running"
was avoidable. The class-1 branch was temporarily made to write, under a uniform flag,

```glsl
totalEmissiveRadiance = vec3( groove, (aiCls == 1.0) ? 1.0 : 0.0, ... );
diffuseColor.rgb = vec3( 0.0 );
```

The Elite rendered gold. A fragment block that runs cannot survive its own output being
forced to black. After the chaining fix, the same debug build rendered the actors in
false colour with a visible panel grid — which simultaneously confirmed the seam field
and the surface-class attribute. `shots/latest/ch_dbg.png` was that frame.

**Fix, inside `ai.js` only:** register with CSM *first*, then call `applyWorldMaterial`
with a shim whose `get('lighting')` returns null, so `applyWorldMaterial` chains onto
CSM's hook instead of being overwritten by it.

---

## 1. Measured before/after

Method: `tools/_chmask.py`. It builds an exact character mask by differencing a frame
against the same frame with `--skip ai`, **erodes it by 4 px**, and measures only the
actor surface. The erosion matters: on a hand-picked crop, a flat plastic model scores a
high `lap_var` because the energy is its silhouette against busy water. Erode and the
surface has to carry the number itself.

Other agents were editing `src/` throughout, so an old capture is not a valid control —
the sky, ocean and cliff all moved. The control here swaps **only `src/game/ai.js`**
(`git show HEAD:` vs working tree), back to back, in the same tree, same minute
(`tools/_chab.sh`). Pose: 6 m from the Elite Major at (-30.5, -11.0), `--settle 24`.

| actor-surface axis (silhouette excluded) | before | after | delta |
|---|---:|---:|---:|
| `lap_var`       | 231.2  | **371.6** | +61 % |
| `edge_density`  | 0.155  | **0.262** | +69 % |
| `sat_mean`      | 97.0   | **114.0** | +17.5 % |
| `lum_mean`      | 90.7   | 81.2  | −10.5 % |
| `lum_std`       | 43.1   | 41.6  | −3.5 % |
| `p99`           | 187.9  | 170.1 | −9.5 % |
| `spec_frac` (lum > 200) | **0.0000** | 0.0012 | first specular pixels |
| masked px       | 93 986 | 122 619 | larger silhouettes (pauldrons, cuisses) |

Reading these honestly:

- `lap_var` and `edge_density` rose because panel seams, bevels and plate layering were
  added — real information, not a sharpen. `spectral_slope` was not degraded by a
  broadband noise term; the relief is band-limited at the panel and micro scales.
- `lum_mean` and `p99` **fell**. That is the metalness finally reaching the BRDF:
  `diffuseContribution = albedo * (1 - metalness)`, so 0.42-metal armour is darker and
  more directional than 0.1-metal plastic. The reference's `weapon` region sits at
  `lum_mean` 79.8 against a frame mean of 107.8, i.e. dark matte with sharp breakup, so
  81 for armour is defensible — but see §5, this is the weakest number here.
- `spec_frac` moved off exactly zero for the first time. It is still only 0.12 %,
  because a roughness-0.045 visor produces a very small, very intense lobe. This axis
  does not prove the visor reads; the image does (`shots/latest/ch_elite_front.png`).

Before/after crop of the Elite Major: `shots/latest/ab_before.png` vs
`ab_after.png`.

### 1.1 Effect on the scored poses

The encounter is visible in `ref_01500` and `ref_01800`, so this had to be checked rather
than assumed. Same single-file swap, `--settle 48`, `tools/metrics.py` against the
keyframes. Whole frame, so the actors are a small fraction of the pixels:

| | ref_01800 before | after | ref_01500 before | after |
|---|---:|---:|---:|---:|
| `lap_ratio` (target 1.0)  | 0.779 | **0.821** | 0.556 | **0.648** |
| `edge_ratio` (target 1.0) | 1.025 | 1.038 | 0.825 | **0.868** |
| `spectral_slope` (ref −2.494 / −2.354) | −2.647 | **−2.584** | −2.629 | **−2.540** |
| `ssim`   | 0.3870 | 0.3855 | 0.3511 | 0.3476 |
| `ms_ssim`| 0.2849 | 0.2837 | 0.2804 | 0.2745 |
| `lpips` (lower better) | 0.6891 | **0.6888** | 0.6620 | 0.6631 |

The detail and spectrum axes move clearly toward the reference on both poses — and
crucially `spectral_slope` moves the *right* way while `lap_ratio` rises, which is the
signature of added information rather than of an unsharp mask (the failure mode
`docs/TARGETS.md` calls out drags slope away from target while raising `lap_var`).
`ssim`/`ms_ssim` drop by 0.0015–0.0035; per KNOWN_ISSUES §4 and the `ref/baseline.json`
calibration, `structure` is not meaningful until the poses are pose-matched, and a
change of that size on a whole frame is below the level I would defend either way.

`scores/history.jsonl` was deliberately **not** appended to — a mid-wave run with five
other agents editing `src/` would record their state, not mine.

---

## 2. Ground contact — measured, not assumed

The brief required feet on the ground via the terrain raycast in `src/game/physics.js`.
Eyeballing this is hopeless: the encounter stands in ankle-deep water on a wet shelf, so
"the legs are cut off" and "the legs are underwater" look identical.

`tools/_chprobe.mjs` skins every actor's bind-pose vertices by hand, takes the **lowest
world-space vertex** (the sole of the boot, not the ankle bone), and compares it against
both `terrain.height()` and a downward `physics.raycast()`.

All 12 encounter actors at `shot_tide_pools`, `--settle 24`:

```
 id type      gapTerr  gapPhys   soleY   terrY
  1 elite      -0.045   -0.045   0.066   0.110
  2 grunt       0.021    0.021  -0.122  -0.142
  3 grunt       0.003    0.003  -0.141  -0.144
  4 grunt       0.024    0.024   0.061   0.037
  5 grunt       0.006    0.006  -0.129  -0.134
  6 elite      -0.030   -0.030  -0.187  -0.157
  7 grunt       0.036    0.036  -0.345  -0.381
  8 grunt       0.030    0.030  -0.243  -0.273
  9 jackal     -0.036   -0.036   0.037   0.074
 10 jackal     -0.004   -0.004   0.061   0.065
 11 grunt       0.026    0.026  -0.285  -0.311
 12 jackal     -0.030   -0.030  -0.149  -0.118
mean 0.000   min -0.045   max +0.036
```

**Feet were already planted.** Worst error 4.5 cm on a 2.28 m Elite (2 % of height),
mean zero. Nothing floats and nothing sinks. `gapTerr == gapPhys` to the last digit at
every one of the twelve positions, i.e. no static collider stands under this encounter,
so the two queries were returning the same answer.

`groundAt()` was still moved onto `physics.raycast(..., MASK.WORLD)` as asked — not as a
bug fix but so it keeps holding when an actor is spawned on a rock or a structure deck.
Implementation note that matters: the **decision** is cached on a 0.5 m grid (does any
static collider stand proud of the terrain in this cell?), not the height. Caching the
height would quantise foot placement to the cell size and make actors walk down a slope
in visible 12 cm stairs. On a clear cell — every cell in this encounter — the function
returns the exact analytic terrain height at the same cost as before.

---

## 3. What was built

### 3.1 Procedural armour shader (the bulk of the win)

Added to the `applyWorldMaterial` injection, per-pixel, no texture fetches:

- **Bump mapping unparametrised surfaces** (Mikkelsen 2010; the derivation behind
  three's own `perturbNormalArb`). A scalar height field in *bind-pose object space* is
  turned into a normal perturbation from screen-space derivatives — no UVs, no tangent
  frame, and it survives skinning because the field is authored pre-skin.
- **Triplanar panel seams**, object-normal weights to the 4th power, on a sine-warped
  rectangular tiling so a seam grid lies flat on a curved pauldron and does not read as
  graph paper. Cell size is a per-actor uniform derived from body height — a 1.30 m
  Grunt with Elite-sized plating reads as a doll.
- **Curvature-driven edge wear**, the standard Substance/Frostbite construction:
  `|d(normal)| / |d(position)|` in screen space, with both varyings taken in bind pose so
  the ratio is a real object-space curvature in 1/m rather than a screen-size artefact.
  Threshold `smoothstep(60, 260)` separates *creased* from merely *curved* — set it low
  and every 5 cm limb tube (1/r ≈ 20) wears down to bare metal.
- **Five surface classes** in a new fourth `aFx` channel: suit / plate / metal / glow /
  visor / skin, each with its own height field, cavity darkening and roughness response.

### 3.2 Geometry

- `Builder.plate()` gained an **`o.bevel` chamfer** — 44 triangles instead of 12, with
  every face, edge and corner emitted through a new `Builder.poly()` that picks its
  winding from the geometry (a hand-wound 26-facet chamfer box gets a quad backwards and
  renders a black hole in the armour). This is what makes a plate stop reading as a
  painted-on colour region: a 90° crease carries no highlight, a 45° chamfer catches a
  bright specular line along every silhouette edge and the eye reads that as thickness.
- `Builder.blob()` gained **`theta`/`phi` arcs**. Visors are built as partial shells of
  the *helmet's own ellipsoid*, grown 3–6 %, so the lens hugs the helmet. The first
  attempt used a separate protruding ellipsoid and the Elite grew a snout.
- **Elite**: dark mirror visor + raised trim surround; mandibles splayed into an X and
  tapered to points with a thin armoured root cap (clustered fat jaws read as a bunch of
  grapes); pauldrons stand off and above the shoulder with a rolled lip; sternum ridge,
  collar band, rib trim, upper-arm plate, forearm cuff, thigh cuisse, metatarsal cuff.
- **Grunt**: breather cowl; visor band wrapped around the mask cone as a short sleeve at
  1.05× the local cone radius, with two cyan eye lenses; collar band, chest tab, forearm
  cuff, shin plate.
- **Jackal**: glossy eyes with violet pupils, headset lens, collar band, gauntlet clamps.

### 3.3 One regression the fix caused, and its repair

Turning the injection on for the first time made the **emissive** term live as well, and
the Jackal's point-defence shield had been authored at emissive 0.5 against a shader that
never ran. It blew out to a flat white board. Dropped to 0.22 on a saturated amber
(`0xd9701e`), it reads as an energy barrier. This is the general hazard of §0: **every
`aFx` emissive value in this file, and every material constant in every other module that
routes through `applyWorldMaterial`, was tuned against a fallback shade.** Expect more of
these wherever the central fix eventually lands.

---

## 4. Cost

- `ai` module init: **21.5 ms → 100 ms** (`stats.modules`). Init only — the generators
  run once at boot. The cost is the chamfered plates (12 → 44 tris each, ~15 plates per
  actor) plus the extra trim pieces.
- Triangles: +~500 per actor, ~+6 k for the encounter, against a frame total of 33.7 M —
  under 0.02 %.
- Per-frame: one extra `physics.raycast` per 0.5 m cell first time it is touched (cached
  thereafter), and the fragment work above on a few thousand pixels. No measurable
  change to `frameMs` was isolatable from the concurrent edits of other agents; this is
  a pixel-shader cost on a very small screen area and I do not claim a number I could
  not separate.

---

## 5. Weakest thing left

**The actors got darker (`lum_mean` 90.7 → 81.2, `p99` 187.9 → 170.1) and I did not
verify that against the reference.** It is the mechanically-correct consequence of
metalness finally reaching the BRDF, and it moves toward the reference's dark-armour
`weapon` row, but "correct mechanism" is not "measured right". If a critic reports the
Covenant reading too dark, the knob is `FX_PLATE`'s metalness (0.42) and the wear
term's push to 0.92, not the albedos.

Second: `spec_frac` is 0.12 %. The visor reads in an image but barely registers on a
statistic, so the claim "visor speculars" rests on the picture, not on a number.

Third: at showcase distance in `shot_tide_pools` the actors are ~50 px tall and almost
none of §3.1 is resolvable. What fixed that cell is that they are no longer flat and
washed out — the surface work pays off at `shot_shoreline` and `shot_waterline`
distances, not at tide-pool distance.

Fourth: **the Jackal is the weakest of the three.** Its `jackalSkin` (`0xa8977a`) reads
near-white in direct sun and it is class `SUIT`, so it gets almost no procedural relief —
in `shot_shoreline` it is a pale cream figure next to a well-read Grunt. The Elite got the
attention because it is the one that carries the showcase; the Jackal needs the same
plating pass and a darker, warmer hide.

Fifth, and outside my file: **the CSM stomp in §0 is still live for terrain, rocks,
structures, vegetation and props.** Each of those is currently rendering with a fallback
material shade rather than the one its author wrote, and every constant any of them has
tuned was tuned against that fallback.

## Tools added

- `tools/_chcam.mjs` — capture at an arbitrary camera pose through the shared daemon
  (`poses.js` is owned by the pose-refit task; judging a model needs the camera 3 m from
  its face).
- `tools/_chmask.py` — eroded character-mask surface statistics.
- `tools/_chprobe.mjs` — per-actor lowest-vertex vs terrain/physics ground contact.
- `tools/_chab.sh` — single-file A/B against `HEAD:src/game/ai.js`.
