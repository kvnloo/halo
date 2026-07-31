# props / particles — report

Owned files: `src/world/props.js`, `src/world/particles.js`.

All numbers from PNGs written by `tools/capture.mjs --settle 48`, measured with
`tools/metrics.py` / `tools/roi.py`. Every A/B pair was captured back-to-back with
`node tools/parsecheck.mjs` clean and the capture's own `warnings[]` empty — see §0.

---

## THE HEADLINE: props was drawing nothing at all in any full-scene frame

At `ref_00450`, before this session:

```
node tools/capture.mjs --pose ref_00450             --out a.png
node tools/capture.mjs --pose ref_00450 --skip props --out b.png
cmp a.png b.png        ->  IDENTICAL
```

Byte-identical. Not "a small contribution" — zero pixels, zero shadows, after 1.9 s of
init work.

**Cause.** `rocks.landmarks` is not a list of discrete obstacles. Alongside the six sea
stacks (radius 12-19 m) it publishes two aggregates:

```
cliff_main    centre (20, 62)      radius  190      rocks.js:1808
islet_field   centre (0, -1100)    radius 1400      rocks.js:1857
```

`props`'s `nearRock()` treats `radius * 0.82` as a hard rejection disc. `cliff_main`
alone excludes a 156 m circle centred 59 m from the spawn; `islet_field` excludes a
1148 m circle reaching to z = +48. Between them they cover the entire playable beach, so
**every scatter point in the module was rejected** whenever `rocks` was loaded.

Isolated, `propsDbg=1` coverage at `ref_00450`:

```
--only ...,terrain,props,pipeline                12.05% of frame   23.06% of lower 45%
--only ...,terrain,player,props,pipeline         12.05%            23.06%   (player innocent)
--only ...,terrain,rocks,props,pipeline           0.91%             0.13%   <- rocks
full scene                                        0.00%             0.00%
```

That is critic item 7 ("a large fraction of the module's authored content never enters a
scored frame") in one line, and it is not a placement problem — nothing was ever placed.
It also means **the critic's own review, and every previous judgement of this module's
content, was formed on `--only` captures** (which do work) or on full frames that
contained none of it. The 45.6% coverage figure in the review is an `--only` number and
cannot be compared with a full-scene one.

**Fix** (in props.js, because props consumes the contract): a landmark is only used as an
exclusion disc if it is plausibly a discrete solid, `radius <= 45 m`. Region-scale
entries are logged once and ignored; the cliff already has its own apron term
(`nearCliff`). `counts.landmarksSkippedAsRegions` reports how many were dropped.

Full scene at `ref_00450` after the fix, props vs `--skip props`, whole frame:

```
                 --skip props    with props     ref kf_00450
score               36.17          36.41
detail              95.91         100.0
geometry           100.0          100.0
spectrum           100.0          100.0
perceptual          17.93          16.97
lap_var            364.8          414.7           442.5
edge_density         0.0931         0.0965          0.0884
local_contrast       0.1256         0.1267          0.1885
lum_std             35.80          36.80           51.86
```

---

## 0. Measurement hygiene, because several early results were noise

1. **A sibling module that fails to parse changes the frame.** `sky.js`, `ssao`, `ssr`,
   `bloom`, `sharpen` and `terrain.js` were all being rewritten while I measured. Every
   capture here went through a wrapper that runs `tools/parsecheck.mjs` first, parses the
   capture JSON, and re-runs if `warnings[]` mentions `not loaded` or `Shader Error`.
2. **`terrain.js` moved under me mid-session.** The terrain-only baseline went `lap_var`
   1647 -> 862 and `sat_mean` 57.6 -> 51.3 with no props change. **Any props delta must
   be quoted against a terrain-only baseline captured in the same session.** The critic's
   `lum_mean` 97.23 baseline is against the older terrain and is not comparable to
   anything below.
3. KNOWN_ISSUES §20 (backticks in a `/* glsl */` template) bit **four times** this
   session, twice in each file, always in a prose comment quoting a GLSL symbol.
   `parsecheck.mjs` caught all four. Run it before every capture you intend to believe.

### New diagnostic: `ctx.config.propsDbg`

- `propsDbg=1` — every prop fragment is painted a **per-class** flat colour and returns
  before `<opaque_fragment>` (cobble magenta, driftwood red, kelp green, shell blue, crab
  yellow, alloy cyan, gear orange, plasma violet, pelican spring-green). One capture
  gives every class's screen coverage at once. This is what found the `rocks` bug and
  what established that the flat grey polygons in the near field are **terrain's**, not
  props'.
- `propsDbg=2` — indirect diffuse/specular forced to zero on props, which measures the
  ambient share of a prop's pixel value.

Both are live-updated per frame from `ctx.config`, so `--config propsDbg=1` works.

**Trap**: the tonemap is keyed, so changing what props draws changes global exposure and
therefore every pixel. `diff(dbg, normal)` is **not** a coverage measure — it reported
84% for a change that touched 10% of the frame. Use the hue mask, which is immune to
exposure.

---

## 1. Cobble scale: `size` was a RADIUS being read as a DIAMETER

`makeStone()` returns a lumped unit icosphere of mean radius ~1.05, so an instance scale
`s` produces a stone **~2.1 s across**. Every size comment in the file, and the critic's
bucket analysis, read `size` as a diameter. Real numbers for the shipped distribution
`0.045 * 20^(u^2.1)`:

```
        nominal        actual diameter
p50      0.090 m           0.20 m
p90      0.496 m           1.09 m
p99      0.844 m           1.86 m
```

So the field scattered **1-1.9 m boulders** over a reference whose near-field stone is
3-9 cm. Confirmed independently by measuring a stone in a capture against the known
ground distance at its scanline (5.6 m at row 860 -> 212 px/m) and getting 0.57 m for an
instance whose nominal cap was 0.26 m.

Replaced with a distribution quoted in diameter and clamped at both ends:

```js
const size = 0.045 * Math.pow(2.7, Math.pow(rnd.next(), 1.3));   // radius scale
// diameter 0.099 .. 0.267 m; p50 0.148, p90 0.235, p99 0.264
```

**Ownership split, written down so it is not re-duplicated:**

```
  < 0.10 m     terrain.js   displaced cobble pavement + shingle + splat (terrain.md §4)
0.10 - 0.27 m  props.js     THIS SET: discrete bedded stones with contact shading
  > 0.27 m     rocks.js     talus, aprons, landmarks
```

`fadeEnd` no longer depends on size. Every stone gets one fixed near-field radius drawn
from [11, 30] m and is dropped hard at it (`Scatter.hardCull`); because the radius is
per-instance the aggregate is a smooth **density** falloff and nothing ever shrinks. The
old `clamp(size*260, 20, 170)` did the exact inverse — it killed the small stones that
*are* the reference at 20 m and kept the boulders to 170 m.

Cobble colliders dropped: nothing in the set is over 27 cm.

Count 17,000 -> 115,000, affordable because `scatterPoints2()` pre-rejects on the cheap
2-D bound before paying for a `terrain.sample()`. Module init went **~900 ms -> 462 ms**
despite 6.8x the instances.

---

## 2. What props costs and buys, measured

**Full scene**, `ref_00450`, `sand` ROI, props vs `--skip props`, captured back-to-back:

```
                  --skip    +props     delta      ref kf_00450
lum_mean           96.50     94.75     -1.76        124.24
lum_std            22.72     26.07     +3.35         46.31
p01                29        18       -11            20
p50                99        98        -1           141
p99               139       144        +5           184
shadow_frac         0.0117    0.0239   +0.0122        0.0400
sat_mean           52.79     53.05     +0.25        100.31
lab_a               4.134     3.974    -0.160          4.869
lab_b               6.648     6.468    -0.180         18.625
lap_var           859.7     880.3     +20.6         1053.7
edge_density        0.2276    0.2216   -0.0060         0.2015
local_contrast      0.0416    0.0510   +0.0093         0.1482
spectral_slope     -1.799    -2.086    -0.287         -2.107
```

`p01` lands at 18 against a reference 20 and `spectral_slope` at -2.086 against -2.107 —
both within noise of the target. Every axis moves the right way except `lum_mean` (-1.76)
and `lab_a` (-0.16).

Against the three axes the critic called critical:

```
                 critic (old terrain, --only)   this session (full scene)
lum_mean                -8.38                        -1.76
sat_mean                -6.87                        +0.25
lab_b                   -3.24                        -0.18
```

Density was tuned by measurement, not taste — whole-frame score at `ref_00450`:

```
count      score   detail  spectrum  perc   sand p01   sand slope
  0 (skip) 36.17    95.9    100.0    17.93     29        -1.799
115,000    36.41   100.0    100.0    16.97     18        -2.086   <- shipped
150,000    36.34   100.0     99.2    16.94     15        -2.186
200,000    36.10   100.0     96.4    16.86      8        -2.261
```

Past 115k the stones start crushing `p01` below the reference and overshooting
`spectral_slope`, and `spectrum` falls off a cliff. That is the metric catching
over-application, exactly as docs/TARGETS.md says it should.

Screen coverage at the shipped count, `ref_00450` full scene: **10.0% of the frame,
20.9% of the lower 45%**.

Second pose, `ref_01500` (camera in the swash), `--only` A/B against terrain:
`sat_mean` +3.05, `lab_b` +0.51 (toward -3.07), `lab_a` +0.19, `shadow_frac` 0.0019 ->
0.0179 (ref 0.0445), `p01` 39 -> 23 (ref 19), `spectral_slope` -1.644 -> -1.982
(ref -2.247). Positive on every axis at that pose.

---

## 3. The saturation fix is a measurement, not a colour pick

Making the stones dark and warm — the obvious reading of "slate against pale tan" — cost
saturation every time, and the reason is not the hue. Probing props pixels through the
per-class debug mask:

```
                 lum     sat    lab_b
props pixels    86.9    40.0     2.50
surrounding     96.8    51.5     6.43
```

The albedos already had **identical HSV saturation to terrain's dry sand** (0.61 vs
0.64). They render 22% less saturated because a low-albedo surface under a fixed
achromatic additive floor loses proportionally more chroma than a bright one. So the
authored chroma has to overshoot by that ratio:

```
0.61 * 51/40 = 0.78   ->   authored S = 0.74-0.75
sandCoat 0.276 0.168 0.071    midRock 0.166 0.101 0.042    darkRock 0.052 0.032 0.013
```

with blue:red held at or under terrain's own dry sand (0.36) and green:red held at
terrain's (0.609), so the set cannot pull the sand ROI `lab_b` cool or its `lab_a` green.
That change alone took `sat_mean` from **-2.07 to +0.85** and `lab_b` from **-0.42 to
+0.28** at unchanged coverage.

The population is deliberately weighted toward the bright end. The reference's near field
(zoom of `kf_00450` rows 880-1080) is mostly **sand-coated** half-buried stones that
barely separate from the sand in value; its contrast comes from hard black contact
shadows, not from dark stone albedo. A uniformly dark field gets neither the saturation
nor the `lum_std`.

---

## 4. Contact occlusion, and how much it can ever buy

```glsl
float gline   = 2.0 * bury - 1.0;                 // exact sand line, by construction
float gl2     = gline + (n2 - 0.5) * 0.85;        // broken up, or it is a straight stripe
float damp    = smoothstep(gl2 - 0.10, gl2 + 0.95, vPropUp);   // wicked damp band
float contact = smoothstep(gl2 - 0.16, gl2 + 0.46, vPropUp);   // near-black line
col     *= mix(0.62, 1.0, damp) * mix(0.50, 1.0, contact);
gPropAO  = mix(0.10, 1.0, contact);                            // INDIRECT ONLY
```

`gline` is exact rather than a guessed fraction: the scatter now places the centre
`(1 - 2*bury)` semi-heights above the ground, so the sand meets the stone at
`vPropUp = 2*bury - 1`.

`gPropAO` is consumed at `<lights_fragment_end>` on `indirectDiffuse` /
`indirectSpecular` only. Multiplying AO into the albedo darkens direct sunlight too,
which is the mistake `reports/terrain.md` §2 documents.

**How much AO can buy, measured.** Dropping the AO floor 0.06 -> 0.03 moved
`shadow_frac` by <0.002, while the albedo bedding term moved it by 0.010. In this scene
the indirect share of a near-field prop pixel is small, so contact darkening has to be
authored into the albedo — which is physically fine, the base of a beach stone genuinely
is damp sand and organic film.

I checked the obvious suspect and it is **no longer the fog**. Same A/B at
`--config fogDensity=0`: terrain-only `lum_mean` 96.59 vs 97.01 on, `sat_mean` 51.80 vs
51.34, and the props deltas are identical to three decimals. The near-field in-scatter of
KNOWN_ISSUES §8/§18 has been fixed by whoever owns that pass; the residual additive floor
is something else and is not in my file.

All three cobble variants now cast CSM shadows (was `[true, true, false]`).

---

## 5. Per-instance wetness — `g.wet` was computed and thrown away

`ground()` built `wet` from `terrain.sample().wetness` and **no line in the file ever read
it**. Every material instead called `pWet(wp) = pDown(2.2, 0.10, wp.y)` per fragment: a
horizontal plane in world Y that (a) does not follow the swash or the terrain wetness
field and (b) puts a ~29% wet-to-dry gradient down the flank of every single stone.

Now carried per instance through **`instanceColor`**. three defines `USE_COLOR` in the
fragment prefix whenever an `InstancedMesh` has an `instanceColor`
(`WebGLProgram.js:737`), so the payload arrives as `vColor.rgb` with no new attribute
plumbing, no change to the G-buffer override or the shadow material, and it compacts
alongside `instanceMatrix` in the existing LOD rewrite:

```
r = terrain.sample().wetness at scatter time   (constant across one stone)
g = bedding depth, gives the exact sand line
b = lithology 0..1, sand-coated .. wet slate, pushed dark where the terrain says wet
```

Packing into `instanceMatrix[3].w` was considered and rejected: three's `project_vertex`
multiplies `vec4(transformed, 1.0)` by `instanceMatrix`, so anything but 1 in `m33`
corrupts the perspective divide.

`pWet()` is kept for the classes with no per-instance channel, with the limitation
documented next to it.

---

## 6. Geometry: the angular variants never got their normals softened

`makeStone` skipped the radial normal blend entirely under `if (!faceted)`, so the
`cuts` variants shaded off raw per-face normals of an 80-triangle icosphere — the "cut
gem" the code's own comment says it was avoiding. The blend now always runs, at 0.55 for
angular and 0.66 for rounded: `cuts` supplies the *silhouette*, it does not need faceted
*shading* too.

Cut depth was the other half. A plane at `d = 0.70` on an 80-triangle sphere shaves a
quarter of the surface into one facet that reads as a grey polygon lying on the sand. The
range is now `[cutMin, 0.97]` with `cutMin = 0.84`, and the pure slab variant
(`cuts: 2, flatten: 0.42`) was replaced by a flat *rounded* pebble — on a wave-washed
beach nothing 15 cm across keeps a sharp arris.

Fragment normal perturbation added (`pBump`): two octaves at 13 and 47 cycles/m with
6 mm and 2.2 mm of relief, faded out over 4-18 m. Forward-difference bump mapping
(Blinn 1978) with the tangent frame built from the shading normal, so it needs no UVs.

**The first version was a visible bug worth recording**: I probed at a fixed 1.2 cm
across a 2.3 cm feature — half a cycle — which aliases and returned normal tilts up to
70°, showing as a white/black camouflage speckle crawling over every stone. The probe
offset must be a fixed fraction of the feature size (`e = 0.20 / freq`) and the amplitude
must be a relief in metres divided by that offset, or the function is not scale-invariant.

---

## 7. particles: continuous masks were multiplied into `size`

`A.y` is the particle's physical radius in metres. `DRAW_VERT` grows sub-pixel particles
to 1.5 px and takes the energy back out of alpha as `1/k^2`, so once a particle is at
that floor its emitted light goes as `size^2`. Multiplying a continuous emitter mask into
size is therefore a **4th-power** cutoff: a shore probe at 50% foam emitted 25% of the
light over 25% of the area — ~6% of the contribution — and crossed the `alp <= 0.0015`
early-out almost immediately.

Every mask now gates *existence*, preserving the expected count and giving each surviving
particle its correct physical size:

```
sand    live = (0.10 + 0.90*uGust) * dry * high * level  ->  step(r2.x, live)
spray   foam = smoothstep(0.10, 0.45, sp.z)              ->  step((r2.x-0.42)/0.58, foam)
dust    shaft                                            ->  step(r3.z, shaft)
pollen  band                                             ->  step(r3.z, band)
```

The shore branch is conditioned on `r2.x >= 0.42`, so that draw is rescaled back to
U(0,1) rather than burning another hash. The `k` / `k^2` compensator is untouched — it is
correct. The invariant is now written above `respawn()`.

**Honest magnitude.** I A/B'd it properly by reverting the four lines and re-capturing.
At `ref_01500`, particles vs no particles:

```
                    >2 px    >8 px    >24 px   meanabs
old masks          2.653%   0.976%   0.0974%   0.2139
new masks          2.684%   1.009%   0.1148%   0.2220
```

So the fix is real and the mechanism is exactly as described, but on the **current** build
it is worth about +18% on strong particle pixels, not the difference between "nothing"
and "spray". The critic's "not one spray droplet at ref_01500" does not reproduce here —
airborne sand sheets are clearly visible off the swash in `shots/pr17_1500_part.png`
either way. The masks that were badly hurt (`dry * high * level`, `shaft`, `band`) are
the ones that are usually well below 1; `foam` and `beat` are mostly saturated at these
poses, which is why the visible delta is small.

---

## 8. Per-class coverage (critic item 7), with the numbers I actually have

One capture with `propsDbg=1` at `ref_00450`, classified by hue. Hues that collide with
natural scene colours (orange ~27° = sand, blue 240° = sky, violet 267° = the viewmodel)
are contaminated and marked as such:

```
class        whole%   lower45%
cobble       10.17     21.23
kelp          0.27      0.56
driftwood    <=0.25    <=0.39   (red, collides with warm sand)
pelican       0.014     0.005
alloy         0.003     0.001
crab          0.001     0.002
shell/gear/plasma       contaminated by sand + sky + viewmodel hues
```

Shells were 480 over ~34,000 m² at `fadeEnd` 22 — measurably zero on screen. Raised to
2,600 at `fadeEnd` 26.

I did **not** delete `crab`, `alloy` or `pelican` on this evidence. One pose is not the
nine the critic asked for, and all three are cheap (30, 42 and 1 instances). The durable
contribution here is the per-class debug colour, which makes the nine-pose audit one
capture per pose instead of one capture per class per pose.

---

## Determinism, cost, weakest thing left

- Two independent full-scene `ref_00450 --settle 48` captures are **byte-identical**
  (`cmp` clean) with 115,000 instanced stones and per-instance `instanceColor`.
- `props` init **462 ms** (was ~900 ms) with 6.8x the instances, thanks to the two-stage
  rejection sampler. Per-frame cost is unchanged in structure: the LOD rewrite is O(items)
  but only runs when the camera moves >2 m, and it now also writes three floats per live
  instance into `instanceColor`.
- No new packages, no `Math.random` / `Date.now`, all scatter via `ctx.rand.fork()`.

**Weakest thing left, in order:**

1. **`perceptual` goes 17.93 -> 16.97 when props is enabled** while `detail` goes
   95.9 -> 100. Props adds real high-frequency structure and LPIPS does not like it,
   because the reference's near field at this pose is *sand-dominant* and ours (terrain's
   pavement plus this set) is *stone-dominant*. The stone/sand ratio of the ground is
   mostly terrain's call, not mine; if terrain's cobble pavement thins out, this set
   should go up in density, and the count is one constant.
2. **`local_contrast` 0.051 against a reference 0.148, and `lum_mean` 94.7 against 124.**
   These are scene-wide: terrain alone is at 0.042 / 96.5, and I measured that neither
   the fog (`fogDensity=0`) nor the props indirect term can move them. Something is
   holding an additive floor under the whole near field and it is not in either of my
   files.
3. **A few cobbles still show a straight-ish shading boundary** where `damp`/`contact`
   crosses the stone. I broke the threshold up with `n2` (21 cycles/m) and widened both
   transitions, which mostly fixed it, but a properly irregular sand line wants a
   silhouette-aware term, not an object-space elevation.
4. **`api.bedDensity(x, z)` is published and nothing consumes it.** The right home for a
   ground-side contact skirt is terrain's splat, which I do not own. Whoever does: it is
   the same field the scatter uses, 0..1.
5. **The nine-pose per-class audit is still not done** — only `ref_00450` and the
   `--only` half of `ref_01500` and `ref_00000`. The tool for it now exists.
