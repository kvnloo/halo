# props / particles — report

Owned files: `src/world/props.js`, `src/world/particles.js`.

All numbers from PNGs written by `tools/capture.mjs --settle 48`, measured with
`tools/metrics.py` / `tools/roi.py`. Every A/B pair below was captured back-to-back with
`node tools/parsecheck.mjs` clean and the capture's own `warnings[]` empty — see §0.

---

## 0. Measurement hygiene, because three of my first six results were noise

Two things invalidate a props A/B and both bit me:

1. **A sibling module that fails to parse changes the frame.** `sky.js`, `ssao`, `ssr`,
   `bloom`, `sharpen` and `terrain.js` were all being rewritten while I measured. A
   capture whose `warnings[]` contains `not loaded` is a different scene, not a different
   props. Every capture here went through a wrapper that runs `tools/parsecheck.mjs`
   first, parses the capture's JSON, and re-runs if `warnings[]` mentions `not loaded` or
   `Shader Error`.
2. **`terrain.js` moved under me mid-session.** The terrain-only baseline went
   `lap_var` 1647 -> 862 and `sat_mean` 57.6 -> 51.3 between my first and third
   measurement, with no props change. **Any props delta must be quoted against a
   terrain-only baseline captured in the same session.** The critic's numbers
   (`lum_mean` 97.23 terrain-only) are against the older terrain and are not comparable
   to anything below.

I also hit KNOWN_ISSUES §20 (backticks inside a `/* glsl */` template) **four times** in
this session, twice in props.js and twice in particles.js, each time in a prose comment
quoting a GLSL symbol. `parsecheck.mjs` caught all four. Run it before every capture.

### New diagnostic: `ctx.config.propsDbg`

`props` had no way to answer "how much of the frame do I actually own", which is the
number the whole cobble argument turns on.

- `propsDbg=1` — every prop fragment is painted pure magenta and returns before
  `<opaque_fragment>`. Nothing else in the scene is magenta, so
  `g < min(r,b) - 0.04` is an exact per-pixel props mask. This is how the coverage
  numbers below were measured, and how I established that the flat grey polygons in the
  near field are **terrain's**, not mine.
- `propsDbg=2` — indirect diffuse/specular forced to zero on props, which measures the
  ambient share of a prop's pixel value.

Both are live-updated per frame from `ctx.config`, so `--config propsDbg=1` works without
a rebuild.

**Warning about `propsDbg`**: the tonemap is keyed, so changing what props draws changes
global exposure and therefore every pixel. `diff(dbg, normal)` is *not* a coverage
measure — it reported 84% for a change that touched 10% of the frame. Use the magenta
hue mask, which is immune to exposure.

---

## 1. Cobble scale: the `size` parameter was a RADIUS being read as a DIAMETER

`makeStone()` returns a lumped unit icosphere whose mean radius is ~1.05, so an instance
scale of `s` produces a stone **~2.1 s across**. Every size comment in the file, and the
critic's own bucket analysis, read `size` as a diameter. The real numbers for the shipped
distribution `0.045 * 20^(u^2.1)`:

```
                       nominal      actual diameter
p50                     0.090 m          0.20 m
p90                     0.496 m          1.09 m
p99                     0.844 m          1.86 m
```

So the field was scattering **1-1.9 m boulders**, not 0.6-1.2 m ones, over a reference
whose near-field stone is 3-9 cm. I found this by measuring a stone in a capture against
the known ground distance at that scanline (5.6 m at row 860, 212 px/m) and getting
0.57 m for an instance whose nominal cap was 0.26 m.

Replaced with a distribution quoted in diameter and clamped at both ends:

```js
const size = 0.045 * Math.pow(2.7, Math.pow(rnd.next(), 1.3));   // radius scale
// diameter 0.099 m .. 0.267 m; p50 0.148, p90 0.235, p99 0.264
```

**Ownership split, written down so it is not re-duplicated:**

```
  < 0.10 m    terrain.js   displaced cobble pavement + shingle + splat (it already
                           tunes this against the sand ROI target; see terrain.md §4)
0.10 - 0.27 m props.js     THIS SET: discrete bedded stones with contact shading
  > 0.27 m    rocks.js     talus, aprons, landmarks
```

`fadeEnd` no longer depends on size. Every stone gets one fixed near-field radius drawn
from [11, 30] m and is dropped hard at it (`Scatter.hardCull`); because the radius is
per-instance the aggregate is a smooth **density** falloff and nothing ever shrinks. The
old `clamp(size*260, 20, 170)` did the exact inverse — it killed the small stones that
are the reference at 20 m and kept the boulders to 170 m.

Cobble colliders were dropped: nothing in the set is over 27 cm and you walk over it.

---

## 2. What props costs and buys now, measured

`ref_00450`, `sand` ROI, `--only time,lighting,sky,env,terrain[,props],pipeline`,
terrain-only baseline captured in the same session.

```
                  terrain   +props     delta      ref kf_00450
lum_mean           97.01     96.14     -0.87        124.24
lum_std            22.46     25.41     +2.94         46.31
p01                31        27        -4            20
p50                99        99         0           141
p99               139       144        +5           184
shadow_frac         0.0103    0.0151   +0.0048        0.0400
sat_mean           51.34     52.18     +0.85        100.31
lab_a               4.141     3.821    -0.320          4.869
lab_b               6.390     6.667    +0.277         18.625
lap_var           839.2     838.1      -1.1         1053.7
edge_density        0.2269    0.2144   -0.0126         0.2015
local_contrast      0.0413    0.0508   +0.0096         0.1482
spectral_slope     -1.801    -1.955    -0.154         -2.107
```

Against the critic's measurement of the same three axes it called critical:

```
                 critic (old terrain)   this session
lum_mean               -8.38               -0.87
sat_mean               -6.87               +0.85
lab_b                  -3.24               +0.28
```

Screen coverage at `ref_00450` (magenta mask): **9.6% of the `sand` ROI**, 15.8% of the
lower 45% of the frame, against the critic's measured 45.6%. Every structural axis still
moves the right way at a quarter of the coverage, which is the definition of the field
no longer being a duplicate of terrain's.

`lap_var` is now neutral (-1.1) rather than the -460 the critic measured; against a
terrain baseline of 839 and a reference of 1054 that is the correct direction to be
neutral in.

---

## 3. The saturation fix is a measurement, not a colour pick

Making the stones dark and warm — the obvious reading of "the reference's stones are
slate against pale tan" — cost saturation every time I tried it, and the reason is not
the hue. Probing props pixels through the magenta mask:

```
                 lum     sat    lab_b
props pixels    86.9    40.0     2.50
surrounding     96.8    51.5     6.43
```

The albedos already had **identical HSV saturation to terrain's dry sand** (0.61 vs
0.64). They render 22% less saturated because a low-albedo surface sitting under a fixed
achromatic additive floor loses proportionally more chroma than a bright one. So the
authored chroma has to overshoot by that ratio:

```
0.61 * 51/40 = 0.78   ->   authored S = 0.74-0.75
sandCoat 0.302 0.184 0.078      midRock 0.172 0.105 0.043      darkRock 0.052 0.032 0.013
```

with the blue:red ratio held at or under terrain's own dry sand (0.36) and the
green:red ratio held at terrain's (0.609), so the set cannot pull the sand ROI's
`lab_b` cool or its `lab_a` green. That one change took `sat_mean` from **-2.07 to
+0.85** and `lab_b` from **-0.42 to +0.28** at unchanged coverage.

The population is deliberately weighted toward the bright end. The reference's near field
(zoom of `kf_00450` rows 880-1080) is mostly **sand-coated** half-buried stones that
barely separate from the sand in value; its contrast comes from hard black contact
shadows, not from dark stone albedo. A uniformly dark field gets neither the saturation
nor the `lum_std`.

---

## 4. Contact occlusion, and the experiment that says how much it can ever buy

Two terms, because a bedded stone has two things going on:

```glsl
float gline   = 2.0 * bury - 1.0;                              // exact sand line
float damp    = smoothstep(gline - 0.05, gline + 0.80, vPropUp);   // wicked damp band
float contact = smoothstep(gline - 0.10, gline + 0.22, vPropUp);   // near-black line
col     *= mix(0.55, 1.0, damp) * mix(0.35, 1.0, contact);
gPropAO  = mix(0.03, 1.0, contact);                            // INDIRECT ONLY
```

`gline` is exact rather than a guessed fraction: the scatter now places the centre
`(1 - 2*bury)` semi-heights above the ground, so the sand meets the stone at
`vPropUp = 2*bury - 1` by construction.

`gPropAO` is consumed at `<lights_fragment_end>` on `indirectDiffuse` /
`indirectSpecular` only. Multiplying AO into the albedo darkens direct sunlight too,
which is the mistake `reports/terrain.md` §2 documents (their shadowed sides went to
sRGB 4 against a reference p01 of 31).

**How much the AO can buy, measured.** Dropping the AO floor 0.06 -> 0.03 moved
`shadow_frac` by less than 0.002, while the albedo term moved it by 0.01. So in this
scene the indirect share of a near-field prop pixel is small and contact occlusion has to
be authored into the albedo (physically fine — the base of a beach stone genuinely is
damp sand and organic film) rather than into an AO term.

I checked the obvious suspect and it is **not** the fog any more. Same A/B at
`--config fogDensity=0`: terrain-only `lum_mean` 96.59 vs 97.01 on, `sat_mean` 51.80 vs
51.34, and the props deltas are identical to three decimal places. The near-field
in-scatter of KNOWN_ISSUES §8/§18 has been fixed by whoever owns that pass; the residual
additive floor is something else and it is not in my file.

The stones now cast CSM shadows in all three geometry variants (was `[true, true,
false]`).

---

## 5. Per-instance wetness — `g.wet` was computed and thrown away

`ground()` built `wet` from `terrain.sample().wetness` and **no line in the file ever read
it**. Every material instead called `pWet(wp) = pDown(2.2, 0.10, wp.y)` per fragment: a
horizontal plane in world Y, which (a) does not follow the swash or the terrain wetness
field and (b) puts a ~29% wet-to-dry gradient down the flank of every single stone.

Now carried per instance through **`instanceColor`**. three defines `USE_COLOR` in the
fragment prefix whenever an `InstancedMesh` has an `instanceColor`
(`WebGLProgram.js:737`), so the payload arrives as `vColor.rgb` with no new attribute
plumbing, no change to the G-buffer override, and it compacts alongside `instanceMatrix`
in the existing LOD rewrite. Three floats:

```
r = terrain.sample().wetness at scatter time   (constant across one stone)
g = bedding depth, drives the exact sand line
b = lithology 0..1, sand-coated .. wet slate, pushed dark where the terrain says wet
```

Packing into `instanceMatrix[3].w` was considered and rejected: three's
`project_vertex` chunk multiplies `vec4(transformed, 1.0)` by `instanceMatrix`, so
anything other than 1 in `m33` corrupts the perspective divide.

`pWet()` is kept for the classes that do not carry a per-instance value, with the
limitation written next to it.

---

## 6. Geometry: the faceted variants were never getting their normals softened

`makeStone` skipped the radial normal blend entirely under `if (!faceted)`, so the
`cuts`-based variants shaded off raw per-face normals of an 80-triangle icosphere — the
"cut gem" the code's own comment says it was avoiding. The blend now always runs, at
0.55 for the angular variants and 0.66 for the rounded ones: `cuts` supplies the
*silhouette*, it does not need faceted *shading* as well.

Cut depth was also the problem. A plane at `d = 0.70` on an 80-triangle sphere shaves a
quarter of the surface into one facet that reads as a grey polygon lying on the sand.
Cut range is now `[cutMin, 0.97]` with `cutMin = 0.84` for the shingle variant, and the
pure slab variant (`cuts: 2, flatten: 0.42`) was replaced by a flat *rounded* pebble —
on a wave-washed beach nothing 15 cm across keeps a sharp arris.

Fragment normal perturbation added (`pBump`), two octaves at 13 and 47 cycles/m with
6 mm and 2.2 mm of relief, faded out over 4-18 m. Standard forward-difference bump
mapping with the tangent frame built from the shading normal, so it needs no UVs.

**The first version of this was a visible bug worth recording**: I probed at a fixed
1.2 cm across a 2.3 cm feature — half a cycle — which aliases and returned normal tilts
up to 70°, showing as a white/black camouflage speckle crawling over every stone. The
probe offset has to be a fixed fraction of the feature size (`e = 0.20 / freq`) and the
amplitude has to be a relief in metres divided by that offset, or the function is not
scale-invariant.

---

## 7. particles: continuous masks were multiplied into `size`

`A.y` is the particle's physical radius in metres. `DRAW_VERT` grows sub-pixel particles
to 1.5 px and takes the energy back out of alpha as `1/k^2`, so once a particle is at
that floor its emitted light is proportional to `size^2`. Multiplying a continuous
emitter mask into size is therefore a **4th-power** cutoff: a shore probe at 50% foam
emitted 25% of the light over 25% of the area — ~6% of the contribution — and crossed
the `alp <= 0.0015` early-out almost immediately.

Every mask now gates *existence* with `step(uniformRandom, mask)`, which preserves the
expected particle count and gives each surviving particle its correct physical size:

```
sand    live = (0.10 + 0.90*uGust) * dry * high * level   ->  step(r2.x, live)
spray   foam = smoothstep(0.10, 0.45, sp.z)               ->  step((r2.x-0.42)/0.58, foam)
dust    shaft                                             ->  step(r3.z, shaft)
pollen  band                                              ->  step(r3.z, band)
```

The shore branch is conditioned on `r2.x >= 0.42`, so that draw is rescaled back to
U(0,1) rather than burning another hash. The `k` / `k^2` compensator is untouched — it
is correct. The invariant is now written above `respawn()` so the next person does not
re-introduce it.

---

## Files, cost, determinism

- `src/world/props.js` — cobble set re-authored, `Scatter` gains `aux` (instanceColor)
  and `hardCull`, `makeStone` gains `cutMin` and always softens normals, `PROP_PARS`
  gains `pDist`, `pBump` and `gPropAO`, `propsDbg` diagnostic, `api.bedDensity(x,z)`
  published for terrain to splat a contact skirt against.
- `src/world/particles.js` — four mask/size fixes plus the invariant note.
- No new packages. No `Math.random` / `Date.now`. All scatter is `ctx.rand.fork()`.

</content>
