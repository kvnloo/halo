# Wave H integration — depth fix + showcase repairs

**Date:** 2026-07-30 · **Tree:** working tree on `main` @ `8ed94d7` + uncommitted Wave H
**Headline:** the depth fix is real, correct, and it works. The composite score went
**DOWN 0.86** anyway (30.30 → 29.44) and the images got **visibly much better**. Both of
those statements are true and section 3 explains why they are not in conflict.

---

## 1. Parse gate

```
$ node tools/parsecheck.mjs
ok — 42 files parse, no GLSL template hazards
EXIT=0
```

Green. Nothing to fix. (KNOWN_ISSUES §20 gate.)

Second gate, new this wave and also green — the pose ground audit:

```
$ node tools/_posecheck.mjs
28 poses: 0 FAIL, 0 WARN, 28 ok
```

Every pose now stands above `terrain.height()` with margin. The two that were buried
(`shot_beach_establishing` at −1.93 m under the sand, `shot_cliff_vegetation` at −0.30 m)
clear by 1.72 m each.

---

## 2. Boot

Clean. Verbatim, from a fresh vite + Chrome with no daemon (`tools/_bootprobe.mjs`):

```
__HALO__.failedModules()  ->  []
globalThis.__HALO_MISSING__ ->  []
boot.ok = true,  boot.err = null
```

**Zero shader errors. Zero pageerrors. Zero failed requests. Zero "not loaded" lines.**
All 19 modules initialised. The complete console output for the boot + 8 frames at
`ref_00000` is six lines, and all six are informational:

```
[console.debug] [vite] connecting...
[console.debug] [vite] connected.
[console.log] [vegetation] crowns headland:198px/4v stack_arch:152px/8v stack_hero:68px/5v
              stack_twin_a:62px/4v stack_twin_b:44px/3v stack_far_a:31px/8v stack_far_b:19px/8v
[console.log] [vegetation] ground: 27987 visible cells, floors near=5.26 mid=9.92
              -> 1096 near + 5181 sward cells
[console.log] [vegetation] {"draws":12,"blades":172000,"trees":21,"shelf":4479,"moss":753,
              "ivy":3200,"vines":1589,"scrub":620,"cells":27987,"tris":2382392}
[console.info] [props] ignoring region-scale rocks landmarks as exclusion discs:
              cliff_main(r=190), islet_field(r=1400) — see the note above nearRock()
```

Two things worth noting because they are *absences*:

- **The `[dof] world path disabled: ...` line from KNOWN_ISSUES §21 is gone.** DoF was a
  shipped no-op gated off by §18; with §18 closed the gate opened and the pass no longer
  announces itself as dead.
- **No `[warn] [physics] ignoring malformed collider`** (§12 stays fixed).

GPU: `ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA GeForce RTX 3080 Ti), NVIDIA)`.
113 programs compiled, 654 draw calls, 35.9 M triangles at `ref_00000`.

---

## 3. Scored run — the score went down, and the picture went up

```
$ node tools/score.mjs --tag waveH --settle 48
$ node tools/score.mjs --history

   # tag                      SCORE  struct   grade  percep  detail  geomet  spectr
   4 waveE                    28.62     5.1     0.0     4.7    75.2    79.4    96.6
   6 waveF                    30.09     4.6     0.0     9.5    75.9    91.0    82.3
   7 waveG                    30.30     4.4     0.0     9.0    77.5    90.0    85.9
   9 waveG-mvfix              30.30     4.4     0.0     9.0    77.5    90.0    85.9
  10 waveH                    29.44     3.4     1.4     7.5    76.9    80.8    94.2

best: waveG @ 30.30
```

**waveH is not the best run on record. It is 0.86 below waveG.**

### 3.1 Every axis that went DOWN, named

Axis weights are in `tools/metrics.py:193`
(`structure .22, grade .20, perceptual .26, detail .12, geometry .12, spectrum .08`),
so each axis's contribution to the −0.86 is exactly computable:

| axis | waveG | waveH | Δ axis | weight | Δ score |
|---|---:|---:|---:|---:|---:|
| **geometry** | 90.04 | 80.81 | **−9.23** | .12 | **−1.108** |
| **perceptual** | 9.02 | 7.51 | **−1.51** | .26 | **−0.393** |
| **structure** | 4.43 | 3.42 | **−1.01** | .22 | **−0.222** |
| **detail** | 77.52 | 76.86 | **−0.66** | .12 | **−0.079** |
| grade | 0.00 | 1.40 | +1.40 | .20 | +0.280 |
| spectrum | 85.93 | 94.15 | +8.22 | .08 | +0.658 |
| | | | | | **−0.864** |

Four axes down, two up. **`geometry` alone is more than the whole regression** and the
other three downs are collectively smaller than the two ups. So there is one cause to
explain, not four.

### 3.2 Why `geometry` fell — one number

`geometry = band(|log(edge_ratio)|, 0.15, 1.2)`, and `edge_ratio` is the render's Canny
edge density over the reference's. 1.0 is perfect.

```
                 edge_density   edge_ratio      lap_var    lap_ratio
reference             0.0768         1.000       424.13        1.000
waveE                 0.0684         0.891       418.0         0.986
waveF                 0.0793         1.033       336.3         0.793
waveG                 0.0770         1.058       318.32        0.841
waveH                 0.0986         1.413       472.50        1.360
```

waveG was **essentially exact on edge density** (1.058). waveH is **41% over**. Same story
in Laplacian variance: waveG was 16% *under* the reference's detail energy, waveH is 36%
*over*. The render has swung from too soft straight past the target to too sharp.

**Cause: GTAO and SSR are rendering pixels for the first time in the project's history,
and their constants have never once been validated against an image.**

I verified that premise against git rather than taking it on faith:

```
$ for c in 865e972 76237b2 8ed94d7; do git show $c:src/render/passes/ssao.js \
      | grep -c "export function ensureOpaqueDepth"; done
0
0
0
```

`ensureOpaqueDepth` — the mid-frame snapshot that first made these two passes see world
depth — **exists in no commit.** It was written and then deleted entirely inside the
uncommitted Wave H working tree. Every scored run up to and including `waveG-mvfix`
(21:57, four hours after the last commit to touch `ssao.js`) ran with both passes taking
the `d >= 1.0` early-out on every world pixel. So `aoStrength`, `aoRadius`, `aoPower`,
`ssrStrength` and the rest were tuned against a dead pass. They are now live at those
values, and they are too strong.

GTAO writes a dark contact gradient into every crevice and every geometry junction; SSR
adds high-frequency reflected detail to wet sand and water. Both inject exactly the kind
of energy Canny and the Laplacian measure. That is the whole −1.108.

### 3.3 The two axes that went UP are the ones that mattered

- **`spectrum` 85.93 → 94.15.** Spectral slope `−2.624 → −2.533` against a reference
  `−2.542`. waveG was 0.082 off; waveH is **0.009 off — essentially exact.** The
  frequency distribution of the render now matches the reference for the first time.
- **`grade` 0.00 → 1.40.** It has been a flat zero for the entire score history (§15
  calls it "a dead readout"). It moved. `sat_mean` **55.66 → 61.66** against a reference
  79.14 — the first movement on KNOWN_ISSUES §8 chroma in *three waves*, and §8 had been
  going slightly **backwards**. The depth fix did what §18 predicted it would.

### 3.4 The per-pose spread is enormous, and the mean hides it

```
pose            waveG   waveH       Δ    geomG  geomH   Δgeo
ref_01500       17.14   29.40  +12.26     69.7   96.8  +27.2
ref_01800       25.24   32.15   +6.91     93.0  100.0   +7.0
ref_00840       27.25   31.36   +4.11     92.7  100.0   +7.3
ref_00120       32.66   33.22   +0.56    100.0   96.5   −3.5
ref_00000       32.41   32.82   +0.41    100.0   89.2  −10.8
ref_00450       36.44   34.99   −1.45    100.0   90.7   −9.3
ref_00720       31.31   25.14   −6.17     94.3   68.1  −26.2
ref_02220       32.68   23.69   −8.99     87.7   63.0  −24.7
ref_00600       37.55   22.18  −15.37     72.9   23.0  −50.0
```

This is not a uniform regression. Three poses gained 4–12 points; three lost 6–15. The
mean moved −0.86 and describes **none** of them.

`ref_00600` is the worst: it was the highest-scoring pose in waveG (37.55) and is now
nearly the lowest (22.18), with `geometry` collapsing 72.9 → 23.0.

### 3.5 …and `ref_00600` is where the render improved *most*

This is the finding of the wave, so I looked at the pixels rather than the number.
Reference | waveG | waveH, `ref_00600` and `ref_02220`:

- **`ref_00600` (sea stacks against the ring).** In waveG the stacks are pale grey ghosts
  barely separable from the sky — no albedo, no vegetation, no crevice shading. In waveH
  they have real warm-tan rock, visible moss and tree cover on the caps, and dark
  interior crevices. The 460 m of achromatic in-scatter that §18 was integrating in front
  of every world pixel is gone.
- **`ref_02220` (headland cliff).** waveG renders the cliff as a **flat white wall** —
  essentially invisible. waveH renders tan rock with strata and dark vegetation speckle.

Both are large, obvious, unambiguous improvements. Both scored *worse*.

**Conclusion: on this change the composite score is anti-correlated with visible quality.**
The mechanism is precise and not mysterious — `edge_ratio` is a *ratio*, it is blind to
sign, and waveG scored 1.058 by having a washed-out mush whose Canny density coincidentally
landed near the reference's. Adding correct detail moved the ratio away from 1.0 and the
0.12-weighted `geometry` axis punished it 9.2 points.

This is KNOWN_ISSUES §4 (circular calibration) presenting in a new form, and it is a
scoring-instrument problem, not a rendering problem. **Do not revert the depth fix to
recover 0.86 points.**

The actionable item is real though, and it is not "the metric is wrong": GTAO/SSR are
genuinely over-strength. Bringing `edge_ratio` from 1.41 back toward 1.0 by *reducing AO
and SSR intensity* would recover the `geometry` axis and keep the chroma and spectrum
wins. That is a tuning task with a live image behind it, which is the first time it has
been possible.

---

## 4. Showcase sheet — cell by cell

```
$ node tools/previewsheet.mjs --settle 48
[sheet] capturing 12 showcase poses...
[sheet] 680 draws, 37008397 tris
{"path": "shots/preview/preview.png", "size": [3896, 3134], "cells": 12, "cols": 3}
```

**No `[sheet] not loaded:` line** — all 12 poses captured, every subsystem present.

Honest read of `shots/preview/preview.png`, one cell at a time. "Fixed" below means fixed
against KNOWN_ISSUES §17.

| # | cell | verdict |
|---|---|---|
| 01 | beach — establishing | **Fixed.** Camera is above the sand (was 1.93 m under it). Wide beach, bridge spanning the middle distance, cliffs both sides, convincing pebble-scale sand detail. Defects: the bridge deck reads as a flat mauve/purple banded slab with no Forerunner surfacing; a hard horizontal seam runs across the sand at the wet/dry line. |
| 02 | opening (reference-matched) | Decent. Rocks now carry real albedo and crevice shading. Defect: the large foreground boulders are smooth featureless bean shapes — silhouette only, no surface. |
| 03 | forerunner bridge | **Fixed.** The cell contains a bridge for the first time; the old pose was aimed yaw 78 (down −X) at a deck that runs entirely in +X, so the frame had no bridge in it at all. Now seen from below-left with sun glare. Same untextured mauve slab problem. |
| 04 | bridge underside — light shafts | **Half fixed.** Genuinely under mid-span now, looking along the soffit ribs (old pose was 84 m short *and* 180° off). But there are **no light shafts** — the caption still promises something not in the frame. |
| 05 | hero sea stack + tree | Stacks with tree caps, water, ring column. **§17.4 (floating stacks) is fixed** — zoomed to the base, the stack flares into a skirt and meets the water with a dark contact band and a splash line. No gap. |
| 06 | stack gauntlet | Similar; a bright turquoise reflective strip on the right foreground water that was not there in waveG — SSR is visibly live. |
| 07 | shoreline — foam + wet sand | **§17.3 NOT fixed.** Two humanoid mannequins stand in frame, left of centre — orange/white torsos, dark blob heads, no visible arms. They read as flat cardboard cutouts. Foam is barely present; a bright haze band still crosses the middle distance. |
| 08 | waterline — refraction + caustics | **Half fixed.** Water now fills the frame as the caption promises (old pose was 30 m away with 6% water). But **no caustics are visible on the bed**, and the surface renders as a chaotic field of jagged white triangular shards rather than foam, with an odd smooth turquoise lens in the centre. This cell reads as an artifact. |
| 09 | tide pools | **§17.3 NOT fixed, worst case.** ~9 humanoid mannequins wading in the mid-distance, plus a **bright cyan glowing blob** at left-centre (unexplained emissive/particle artifact). Foreground rock carries strange smooth marbled swirls. |
| 10 | cliff + vegetation | **Pose fixed** (was 0.30 m underground aimed out to sea; now on the headland's undercut face). But the cliff renders as a hard-edged **blocky staircase** — terrain quantisation terracing across the entire face — and there is a near-black unlit region top-left that reads as a hole. |
| 11 | halo ring + threshold | **§17.2 partially fixed.** It is no longer "two thin white lines": the band now has genuine inner-surface texture — blue/white marbled ocean-and-cloud detail is clearly visible. But it is still a narrow near-vertical column that terminates abruptly at the frame top, and still reads as a light shaft rather than an arch. **New defect: stars are visible across the daytime sky**, dozens of them, alongside a bright sun and full cumulus. |
| 12 | MA5B viewmodel | **NOT fixed, and not fixable by a pose.** The gun still covers ~10% of the frame, cropped at the bottom-right corner; no receiver detail is legible. `poses.js` now documents why: `scene.js` draws the viewmodel through `pipe.viewCamera`, a hard-coded 55° camera, so pose `fov` cannot magnify it (measured 207,311 px at fov 58 vs 207,503 px at fov 95 — 0.09%). The pose change only improved the backdrop. The caption still over-promises. |

### §17 scorecard

| item | status |
|---|---|
| 17.1 cameras under the terrain | **FIXED** — and gated by `tools/_posecheck.mjs`, 28/28 ok |
| 17.2 ring is two thin white lines | **PARTIAL** — band and inner surface now render; still a column, not an arch |
| 17.3 characters in showcase cells | **NOT FIXED** — still in 07 and 09 |
| 17.4 sea stacks float | **FIXED** — verified at the base of `shot_hero_stack` |
| 17.5 cells don't show what the caption promises | **PARTIAL** — 03/04/08 improved, 12 is structurally impossible, 04 and 08 still miss their headline effect |

---

## 5. Determinism — HOLDS

```
$ node tools/capture.mjs --pose ref_00000 --settle 48 --out det_a.png   # exit 0
$ node tools/capture.mjs --pose ref_00000 --settle 48 --out det_b.png   # exit 0
$ cmp det_a.png det_b.png
DETERMINISM: BIT-IDENTICAL
```

Two independent captures, two separate process invocations, byte-for-byte identical
4.9 MB PNGs. The depth fix did not introduce frame-order or state dependence, which was
a live risk: `scene.js` now mutates `pipe.sceneRT.depthTexture` mid-frame and restores it,
and a missed restore would have shown up here as drift.

Not required (the check passed), but run as hygiene anyway:

```
$ grep -rn "Math.random|Date.now()|performance.now()" src/ | wc -l
29
```

All 29 are instrumentation or prose. Every `performance.now()` brackets a timing
measurement (`Engine.js`, `rocks.js`, `ocean.js`, `ai.js`, `hud.js`, `audio.js`,
`env.js`); none feeds a shader uniform, a seed or a transform. `Math.random` appears
**only inside comments** recording that it was removed (`materialCommon.js:176`,
`grain.js:77`, `hud.js:25` — the §10 fix). Nothing to do.

---

## 6. Performance — the honest answer is "these numbers are not measurable today"

I set out to price GTAO and SSR. I could not, and the reason matters more than the
number would have.

### 6.1 What the mandated tool reports

`node tools/_perfprobe.mjs --warm 30 --samples 90` (the tool KNOWN_ISSUES §22 requires,
30 warm-up frames discarded, 90 individually-timed frames per pose):

```
pose                          p50    p95   mean     max  draws         tris
ref_00720                   16.50  18.50  14.55   31.00    691   38,926,565  <-- OVER 11ms
ref_00840                   16.50  19.10  17.58  429.80    679   34,472,861  <-- OVER 11ms
ref_00600                   16.40  18.80  14.38   34.40    683   39,401,569  <-- OVER 11ms
ref_00450                   15.50  19.50  13.28   30.80    717   38,668,301  <-- OVER 11ms
shot_stack_gauntlet         15.50  20.20  17.39  454.10    631   33,538,117  <-- OVER 11ms
shot_beach_establishing     14.90  17.10  12.43   31.10    663   35,387,805  <-- OVER 11ms
shot_forerunner_bridge      14.40  19.50  12.61   36.40    674   37,132,477  <-- OVER 11ms
shot_overview               14.10  17.30  13.18   24.00    533   30,892,997  <-- OVER 11ms
shot_bridge_underside       11.40  18.00  11.03   27.40    525   36,345,733  <-- OVER 11ms
shot_tide_pools             10.80  20.80  11.52   26.90    713   33,739,393
ref_02220                   10.70  18.20  11.38   28.70    671   35,124,381
ref_00000                   10.60  13.80  10.79   27.50    662   35,929,781
shot_weapon_detail          10.60  23.00  16.46  374.40    682   37,009,949
ref_01800                   10.50  21.10  16.11  435.80    664   30,962,821
shot_sky_ring               10.40  23.30  14.44  299.70    688   39,252,993
shot_water_edge             10.30  22.40  12.84   30.70    677   30,679,637
shot_hero_stack             10.10  20.50  16.29  412.00    673   37,922,501
shot_cliff_vegetation        9.20  10.70   9.03   13.20    509   31,417,229
ref_01500                    8.30  24.00  15.99  423.50    688   33,335,405
shot_shoreline               7.10  17.60  15.04  398.20    690   36,924,545
ref_00120                    7.00  10.00  13.61  579.00    680   36,793,301

9 of 21 over 11 ms at p50   (§23 Wave F: 2 of 21)
19 of 21 over 11 ms at p95  (§23 Wave F: 20 of 21)
```

Taken at face value that is a serious regression: **p50 breaches went 2/21 → 9/21.**

### 6.2 Why I do not believe it

`ref_00600` was measured **four times on this identical build** during this session:

| measurement | p50 |
|---|---:|
| `_perfprobe.mjs`, 21 poses sequential in one page | **16.40** |
| `_ssaocost.mjs` baseline, first variant | **18.80** |
| `_ssaocost.mjs` "both off" variant | 11.60 |
| interleaved A/B, mean of 6 reps with ssao+ssr **on** | **10.23** |

**A 1.84x spread on identical code.** No source changed between them. Whatever these
numbers are measuring, it is not the renderer.

The cause is on the machine, and it is checkable:

```
$ uptime
 23:51:37 up 2 days, 9:37, 1 user,  load average: 24.03, 20.28, 17.95
$ free -g
               total   used   free   shared  buff/cache   available
Mem:              15     14      0        0           1           1
$ ps aux | grep -c "[c]hrome"      -> 22
$ ps aux | grep -E "[c]apture|[v]ite" | wc -l  -> 17
$ nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv
27 %, 850 MiB
```

**Load average 24. One gigabyte of RAM available out of fifteen. Twenty-two Chrome
processes. And the GPU is 27% idle.**

KNOWN_ISSUES §22 already established the decisive fact and nobody has applied it:
`performance.now()` around `advance()` measures **CPU submit cost, not GPU frame time**,
because WebGL submission is asynchronous. So the instrument is a CPU stopwatch — and the
CPU is oversubscribed 24-deep by a dozen other agents while the GPU, the thing we
actually want to measure, sits at 27%.

That also explains the column nobody has explained: the **299–579 ms max frames** in
7 of 21 poses, *after* 30 warm-up frames were discarded. §23 flagged a single 525.70 ms
outlier at `ref_00120` as "a visible freeze" and looked for a rendering cause. There are
now eight of them, they land on different poses each run, and they are the size of a
scheduler stall on a swapping box — not of anything a renderer does.

**§23's and §25's frame-time conclusions were measured the same way, on the same
contended machine, and are suspect for the same reason.** §25 in particular ("frame time
regressed across the board — 19 of 21 poses now over 11 ms") may be entirely an artifact.

### 6.3 What GTAO + SSR actually cost

The only design that controls for drift is interleaving, so: `ref_00600`, A/B/A/B/A/B,
6 repetitions, 30 warm frames and 60 timed frames per cell, both passes toggled together
via `__HALO__.togglePass()`.

```
rep   ssao+ssr ON    OFF
 0        10.30      9.70
 1         9.80     14.90
 2        10.40      9.20
 3        10.80     10.50
 4        10.10     10.70
 5        10.00     10.90
       ------------------
mean      10.23     10.98
median    10.20     10.60
```

**The combined cost of GTAO and SSR is below the noise floor.** The "off" arm is
*slower* than the "on" arm in this design, which is impossible and is exactly how you
know the residual is noise. The measurement floor here is roughly ±1 ms; the effect is
smaller than that.

The uncontrolled sequential A/B that I ran first said `+5.90 ms for ssao, +8.20 ms for
ssr` at this pose — while simultaneously reporting `both off` as *slower* than `ssr off`.
That internal contradiction is what sent me looking at the machine. **I am reporting the
interleaved result and discarding the sequential one.**

### 6.4 So: is it worth it?

On the evidence I can actually defend: **yes, and the question of cost is currently
unanswerable.** GTAO + SSR bought the first movement on §8 chroma in three waves
(`sat_mean` 55.66 → 61.66), an essentially exact spectral slope (0.009 off the reference,
from 0.082), and the visible recovery of rock albedo at `ref_00600`/`ref_02220`. Their
measured cost is indistinguishable from zero under the only controlled measurement I was
able to take. If they are expensive, this machine cannot currently show it.

### 6.5 The one perf number that IS trustworthy

Triangle and draw counts are deterministic counters, not timers, so contention cannot
touch them:

```
                  triangles                draw calls
§23 (Wave F)      29.6 M – 32.5 M          523 – 645
waveH             30.7 M – 39.4 M          509 – 717
```

**Triangle count rose again, by roughly 10–20%, and the ceiling moved from 32.5 M to
39.4 M.** §23's core complaint stands untouched and has got worse: every pose renders
30–39 M triangles including `shot_sky_ring` at 39.3 M for a shot that is mostly empty
sky. That is still a culling/LOD problem, it is still the most likely real performance
issue in the build, and it is still measurable without a stopwatch. **Fix culling before
anyone tries to price a post pass again.**

**Flagged >11 ms subsystems:** I decline to name one. The p50 table would name
`rocks`/`terrain` at `ref_00450`–`ref_00840`, but I cannot separate that from a load
average of 24. The correct next step is a quiet machine or `EXT_disjoint_timer_query_webgl2`
GPU timer queries (§22 already recommends the latter), not another CPU stopwatch run.

---
## 7. KNOWN_ISSUES.md updates

`docs/KNOWN_ISSUES.md` edited in three places.

### §18 — marked **FIXED, VERIFIED**

Not on the fixing agent's word. Re-run independently:

```
$ node tools/_depthprobe.mjs --pose ref_00000 --settle 48

depth.geoFrac          0.85704     <- was 0.10094 (the gun alone)
gbufferGeoFrac         0.85704     <- INDEPENDENT witness: G-buffer MRT1.a, a different
                                      attachment written by a different pass. Agrees to
                                      five decimals.
depth.distM            p50 1.152 m   p90 57.87 m   p99 181.2 m
                                   <- real world distances. Before, every world pixel
                                      read as sky at the 460 m far plane.
viewmodel.frac         0.10098     <- exactly the OLD geoFrac. The gun rasterises
                                      identically, it just no longer does so into the
                                      world's buffer. The prediction in §18 confirmed.
viewmodel.overSkyFrac  0
```

The independent witness is what makes this conclusive: `gbufferGeoFrac` comes from a
different attachment filled by a different pass, and it matches to five decimals.

### §17 — marked **2 of 5 FIXED, 2 PARTIAL, 1 OPEN — not closeable**

Per-item table added inline. 17.3 (character mannequins in showcase cells 07 and 09) is
completely untouched and is the reason the section stays open.

### §21 — marked **CLOSED**, as a side effect of §18

The `[dof] world path disabled: ...` console line is gone from every capture.

### New sections added

- **§28 — GTAO and SSR have never been validated against an image, and are
  over-strength.** With the git proof that `ensureOpaqueDepth` exists in no commit, the
  `edge_ratio`/`lap_ratio` table, and §28b on the score being anti-correlated with
  visible quality this wave.
- **§29 — Every frame-time number in this document was taken on a saturated machine.**
  The 1.84x spread on one pose, the `uptime`/`free`/`nvidia-smi` evidence, and the
  consequence that §23 and §25 are suspect and §25b is probably not a rendering bug.
  Plus §29b: triangle count is the one perf fact that survives, and it rose again.
- **§30 — Six new visual defects** now clearly visible with the haze wash lifted:
  daytime stars, cliff terracing, the shard-like water surface, the cyan blob in the
  tide pools, the untextured bridge deck, and the un-framable viewmodel. Each with an
  owner file.

Also updated the "Status changes" block: §8 moved for the first time in three waves;
§1/§10/§11/§12/§13/§20 unchanged and holding; §26 still governs the ±0.5 noise floor.

---

## 8. Summary — what actually happened

**The depth fix is the most valuable change the project has landed.** It closed the
highest-priority open item, closed §21 for free, moved §8 chroma for the first time in
three waves, brought the spectral slope to essentially exact, and is verified by an
independent witness. It did not break determinism.

**It also cost 0.86 points of score, and that is not a reason to touch it.** The loss is
one axis — `geometry`, via `edge_ratio` overshooting to 1.41 — caused by two post passes
that are live for the first time carrying constants that were tuned while they rendered
nothing. That is a tuning task, and it is now possible for the first time.

**The showcase repairs are real but partial.** The pose work is genuinely good and is now
gated (`_posecheck.mjs`, 28/28). Two of five §17 items are properly fixed. But character
mannequins still stand in two showcase cells, the ring is still a column rather than an
arch, and the viewmodel cell is structurally impossible to fix from a pose.

**The performance question could not be answered, and pretending otherwise would have
been the worst outcome of this wave.** The machine was at load average 24 with 1 GB of
RAM free while the GPU idled at 27%, and the mandated instrument is a CPU stopwatch. One
pose measured between 10.2 and 18.8 ms on identical code. I have reported that as a
methodology defect (§29) rather than as a rendering regression, and declined to name a
subsystem.

### Ranked next actions

1. **Tune AO and SSR intensity down** toward `edge_ratio` → 1.0. Recovers ~1.1 points of
   score and keeps every §18 win. First time this is doable against a live image.
2. **Land GPU timer queries** (`EXT_disjoint_timer_query_webgl2`). Three waves of perf
   conclusions are blocked on it.
3. **Run the `--skip rocks` / `--skip props` A/B** on a quiet machine. Fourth wave
   outstanding; triangle count is now 30.7–39.4 M.
4. **Hide characters from showcase poses** — closes §17.3, the last open §17 item.
5. **Decouple `--settle` from the world clock** (§26). Until then ±0.5 score points are
   noise and this wave's −0.86 is only just outside it.

### Tools added this wave

- `tools/_bootprobe.mjs` — boot-only probe, verbatim `failedModules()` + every console
  message, pageerror and failed request, on a fresh vite + Chrome with no daemon.
- `tools/_ssaocost.mjs` — `togglePass`-driven A/B for the cost of `ssao` and `ssr`.
  **Its sequential design is drift-prone; the interleaved measurement in §6.3 supersedes
  its output. Kept because the negative result is the point.**
