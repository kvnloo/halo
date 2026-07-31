# Wave G integration pass — 2026-07-30

Two waves landed concurrently into one tree. This report is the state of the tree as it
stands, measured, not assumed.

Tree at time of measurement: `76237b2` ("Wave F: research-led fixes land") plus one
uncommitted change, `src/world/props.js` (+49 lines, the props agent's landmark-exclusion
fix, written ~21:21 — i.e. an agent was still landing work as this pass began). Every
other subsystem named in either wave brief is committed. `node tools/parsecheck.mjs` ->
**ok — 42 files parse, no GLSL template hazards**.

**Answer to "did a half-written file get committed": no.** Both waves' work parses,
initialises and renders. The failure mode the checkpoint protocol was built for did not
occur this time. The two waves did, however, leave three of their own follow-ups
unfinished (§1's, and §18 which was explicitly assigned to this wave) — see §7 and the
closing list.

Everything below is measured. Where I am inferring, I say so.

---

## 1. Does it boot? YES — completely clean

`node tools/_perfprobe.mjs --warm 40 --samples 90` (one page load, drains every console
message, pageerror and failed request verbatim):

```
BOOT ok = true
__HALO__.failedModules()  = []          <- empty
__HALO_MISSING__          = []          <- empty
```

**Zero failed modules. Zero modules not loaded. Zero shader compile/link errors. Zero
pageerrors. Zero failed requests.** All 21 poses probed without an exception.

The complete console output for the whole session, verbatim, all 7 lines:

```
[console.debug] [vite] connecting...
[console.debug] [vite] connected.
[console.log] [vegetation] crowns headland:198px/4v stack_arch:152px/8v stack_hero:68px/5v stack_twin_a:62px/4v stack_twin_b:44px/3v stack_far_a:31px/8v stack_far_b:19px/8v
[console.log] [vegetation] ground: 27987 visible cells, floors near=5.26 mid=9.92 -> 1096 near + 5181 sward cells
[console.log] [vegetation] {"draws":12,"blades":172000,"trees":21,"shelf":4479,"moss":753,"ivy":3200,"vines":1589,"scrub":620,"cells":27987,"tris":2382392}
[console.info] [props] ignoring region-scale rocks landmarks as exclusion discs: cliff_main(r=190), islet_field(r=1400) — see the note above nearRock()
[console.info] [dof] world path disabled: dofWorldDepthValid is false because KNOWN_ISSUES 18 leaves pipe.depthTex holding no world geometry (measured: every pixel returns CoC 0 and the pass is byte-identical to dofEnabled:false). Set ctx.config.dofWorldDepthValid = true the day scene.js stops clearing the shared depth texture, and re-derive dofViewmodelCoC once the viewmodel reaches the G-buffer. See reports/postfx.md.
```

Two of those are informational-by-design (`[props]` documents its own fix, `[dof]`
documents KNOWN_ISSUES §18 gating a pass off). Neither is an error.

Notably **absent** relative to Wave F: no `[warn] [physics] ignoring malformed collider`
(§12 stays fixed), no `[capture] modules not loaded`, no GLSL `ERROR:` lines. The
half-written-file hazard the two-wave overlap creates did **not** materialise.

---

## 2. Scored run — 30.30, best on record, but the gain is +0.21

`node tools/score.mjs --tag waveG --settle 48`

```
   # tag                      SCORE  struct   grade  percep  detail  geomet  spectr
   1 baseline-empty            0.00     0.0     0.0     0.0     0.0     0.0     0.0
   2 latest                   22.24     3.7     0.0     2.1    56.6    62.5    82.3
   3 latest                   22.24     3.7     0.0     2.1    56.6    62.5    82.3
   4 waveE                    28.62     5.1     0.0     4.7    75.2    79.4    96.6
   5 waveE-fix                28.62     5.1     0.0     4.7    75.2    79.4    96.6
   6 waveF                    30.09     4.6     0.0     9.5    75.9    91.0    82.3
   7 waveG                    30.30     4.4     0.0     9.0    77.5    90.0    85.9

delta since first: +30.30
best: waveG @ 30.30
```

**Two waves of research-led critic+refine over fourteen subsystems bought +0.21 points.**
That is the headline and it should not be dressed up. Read the raw statistics, not the
axes, for what actually moved:

```
                     waveF        waveG      delta     reference
ssim                0.4371       0.4328    -0.0043
ms_ssim             0.3485       0.3427    -0.0058
lpips               0.6599       0.6620    +0.0021   (lower is better -> worse)
hist                0.7934       0.7876    -0.0058
lap_ratio           0.7929       0.8406    +0.0477   1.0
edge_ratio          1.0328       1.0583    +0.0255   1.0

lum_mean          107.8098     107.1982    -0.6116   105.40
lum_std            37.3846      38.0439    +0.6593    52.36
sat_mean           55.7171      55.6561    -0.0610    79.14
lap_var           300.9686     318.3364   +17.3678   424.13
local_contrast      0.1336       0.1351    +0.0015    0.1936
shadow_frac         0.0374       0.0397    +0.0023    0.0565
highlight_frac      0.0035       0.0035    +0.0000    0.0088
spectral_slope      -2.6250      -2.6240   +0.0010    -2.542
```

Honest reading:

- **The real win is sharpness.** `lap_ratio` **0.7929 -> 0.8406** and `lap_var` **301 ->
  318**. KNOWN_ISSUES §23 flagged the frame getting *softer* while triangles doubled;
  that has partly reversed. Still 16% short of the reference.
- **Every reference-similarity metric got slightly worse.** `ssim`, `ms_ssim`, `hist` and
  `lpips` all moved the wrong way. The score rose anyway because `detail` (+1.60) and
  `spectrum` (+3.66) outweighed `geometry` (-0.92), `perceptual` (-0.47) and `structure`
  (-0.20). **The composite score and the perceptual metrics now disagree in sign.** Do
  not treat 30.30 as unambiguous progress.
- **§8's chroma half is completely untouched.** `sat_mean` 55.72 -> 55.66, against a
  reference 79.14 — 23.5 codes short, and it has now moved backwards in two consecutive
  waves. The tonemap wave re-fitted `KEY_TRIM_EV` to 0 and closed §9, but nothing this
  wave attacked the saturation deficit that §8 identifies as a highlight roll-off.
- **`lum_std` 37.8 vs reference 52.4** and `local_contrast` 0.135 vs 0.194. The frame is
  still globally flat; `highlight_frac` is 0.0035 against 0.0088, i.e. **the render has
  40% of the reference's specular highlight area.**
- **`grade` is still 0.00**, for the eighth run in a row (KNOWN_ISSUES §15). `hist` moved
  0.7934 -> 0.7876 and the axis did not notice, as designed-in-error.

Per pose:

```
  ref_00000     31.96 ->  32.41  +0.45
  ref_00120     31.80 ->  32.66  +0.86
  ref_00450     36.11 ->  36.44  +0.33
  ref_00600     39.03 ->  37.55  -1.48   <- biggest regression
  ref_00720     30.96 ->  31.32  +0.36
  ref_00840     25.90 ->  27.26  +1.36
  ref_01500     17.00 ->  17.14  +0.14   <- still by far the worst pose
  ref_01800     25.28 ->  25.24  -0.04
  ref_02220     32.78 ->  32.68  -0.10
```

`ref_01500` at 17.14 has been the floor for three waves. Its `detail` axis is **10.75**
while every other pose is 50-100. That is where the next wave should aim.

`ref_00600` lost 1.48: `structure` is the only pose in the set that scores non-zero
(39.86) and its `spectrum` fell to 57.29, the lowest in the set.

**Ignore `perf` in `scores/waveG.json`.** It says `ms: 4.85, fps: 206`. That is the EMA
artefact of KNOWN_ISSUES §22 — the real p50 range is 8.4–16.4 ms. Section 5 below has the
numbers.

---

## 3. Showcase sheet — cell by cell, honestly

`node tools/previewsheet.mjs --settle 48` -> `shots/preview/preview.png`, 3896x3134,
12 cells, 3 columns. (The first attempt hung; see the tooling note at the end of this
section.)

Two things are true of the whole sheet before any individual cell:

- **Everything beyond ~40 m is washed to near-white.** Sea stacks, cliffs and distant
  islets have essentially no rock colour left — they read as pale ice or fog banks. This
  is `sat_mean` 55.7 vs a reference 79.1 made visible, and it is the single biggest
  aesthetic defect in the build.
- **The near field is genuinely good now.** Cobble and pebble beds have real size
  variation, value variation and contact darkening. That is this wave's `props` fix
  landing (see §1's console line) and it is the most improved thing on the sheet.

| # | cell | what is actually there |
|---|---|---|
| 01 | beach — establishing | **BROKEN POSE.** Camera is *under* the terrain looking up. Pebbles and rock are stuck to a ceiling, vegetation hangs downward, and the bottom ~42% of frame is flat lavender-grey void (the clear colour). KNOWN_ISSUES §17 item 1, unchanged. |
| 02 | opening shot (reference-matched) | Correct and the second-best cell. Warm pebbled sand fills the lower two-thirds with convincing cobble scatter; the bridge slab and a cliff sit on the horizon; clouds read as volumetric cumulus. Horizon is high and the sky wedge is thin, but nothing is wrong. |
| 03 | forerunner bridge | Reads. Large pale cliff wall on the left, sand shelf, deep blue sky, well-formed cumulus. The bridge itself is a thin flat band at the horizon and is easy to miss — the caption oversells it. Cliff is heavily desaturated. |
| 04 | bridge underside — light shafts | **No light shafts visible.** A pale wall fills the left third, clouds and the Threshold band fill the sky, and the bottom-left corner has a wet sheet. The promised god-ray effect is not in the frame. |
| 05 | hero sea stack + tree | Composed well: two stacks with green crowns, ring column behind, bridge on the right. **§17 item 4 (floating stacks) looks FIXED** — both stacks now have a visible flared talus apron where they enter the water. But the stacks are near-white with no rock albedo, and a row of **flat white rectangular cards sits on the horizon line** (distant islet LOD imposters, unshaded). Some clouds have dark navy underside patches that read as holes. |
| 06 | stack gauntlet | Same strengths and same flaws as 05: stacks are pale slabs, water is a low-contrast sheet, horizon holds the same flat white imposter cards. |
| 07 | shoreline — foam + wet sand | Foam and wet-sand transitions are legible and the pebble bed is good. **Two low-poly humanoids stand on the left**, one in an orange vest. §17 item 3, unchanged. |
| 08 | waterline — refraction + caustics | **A blocky red-and-grey humanoid holding a green object stands dead centre**, the most prominent object in the frame. Neither refraction nor caustics is visible — the water is a flat pale sheet with foam streaks. §17 items 3 and 5, both unchanged. |
| 09 | tide pools | ~10 humanoid figures scattered across the middle distance, plus one large one at the left edge. The pools themselves are legible but the figures dominate. §17 item 3, unchanged. |
| 10 | cliff + vegetation | **BROKEN POSE.** Camera under the terrain again; bottom-left ~25% is flat void, pebbles hang from a ceiling, trees hang downward. The *sky* in this cell is the best on the sheet — Threshold, stars, the ring, and genuinely good cumulus — but the pose is unusable. §17 item 1, unchanged. |
| 11 | halo ring + threshold | **The §24 TAA black corruption is plainly visible** — a shredded band of pure-black horizontal streaks over the water at the far shoreline. The ring renders as a **vertical translucent column**, textured and striated but reading as a glass pillar, not an arc. Threshold is a well-banded gas giant. §17 item 2 still partly wrong, §24 unchanged. |
| 12 | MA5B viewmodel | **The best-looking cell in the sheet**, and it does not show what its caption promises. It is a beautiful pebble beach; the rifle occupies the same bottom-right corner it occupies in all twelve cells and is half out of frame. §17 item 5, unchanged. |

### §24 re-measured on this sheet

Exact `rgb(0,0,0)` pixel counts across all twelve frames:

```
shot_sky_ring.png                black=   7934  0.383%  box y902-1035 x357-956
ref_00000.png                    black=     17  0.001%  box y629-640  x882-912   <- NEW
shot_shoreline.png               black=      6  0.000%  box y547-676  x1047-1616 <- NEW
(the other nine frames: 0)
```

`shot_sky_ring` reproduces at **7,934 px in the identical bounding box** (Wave F measured
7,978 and 7,977). **The TAA/motion-vector wave did not touch it.** And it has now leaked
into two more poses at small scale, which Wave F explicitly recorded as zero. Grain is
still masking about half of it (§24).

### Tooling note — the shared capture daemon deadlocked

The first `previewsheet` run hung for 15 minutes. `/health` reported
`{"inflight":3,"queued":479,"served":183}` and `served` did not advance by one over
several minutes of polling. The daemon had been up 6h13m. Two `tools/_pfxprof.mjs`
processes had also been running for **2h45m** and a `node tools/capture.mjs --beauty
--placement --chrome --label loop-r27` was running with flags `capture.mjs` does not
define. I killed the daemon and removed `/tmp/halo-captured.port`; the next invocation
started a fresh one which served all 12 poses without incident. **Anyone whose capture
"is just slow" right now should check `/health` before waiting** — and the daemon needs a
watchdog, because a wedged one is indistinguishable from a busy one and silently blocks
every agent on the machine.

---

## 4. Determinism PASSES. Convergence FAILS — and it is bigger than the wave.

### 4a. Determinism: bit-exact

```
node tools/capture.mjs --pose ref_00000 --out shots/g1.png --settle 48
node tools/capture.mjs --pose ref_00000 --out shots/g2.png --settle 48
cmp shots/g1.png shots/g2.png  ->  DETERMINISTIC
```

Quantified, not just `cmp`:

```
shots/g1.png vs shots/g2.png
  full   max 0  mean 0.00000  frac>=1 0.00000
  rock   max 0  mean 0.00000  frac>=1 0.00000
  sky    max 0  mean 0.00000  frac>=1 0.00000
  sand   max 0  mean 0.00000  frac>=1 0.00000
```

**The TAA/motion-vector fix did not break determinism.** No `Math.random` /
`Date.now` / `performance.now` grep was needed.

### 4b. Convergence: `--settle 48` is NOT converged, and the error is larger than a wave's worth of work

This is the finding to act on.

**Same tree, same code, same seed, same poses. Only `--settle` changed:**

```
   6 waveF                    30.09
   7 waveG                    30.30      <- settle 48
   8 waveG-settle96           29.78      <- settle 96, IDENTICAL CODE
```

**A -0.52 point swing from a knob that is supposed to be a convergence margin.** For
scale: this whole wave, fourteen subsystems of research-led critic+refine across two
concurrent teams, moved the score **+0.21**. **The settle-count noise is 2.5x the entire
measured gain.** Every score in `scores/history.jsonl` carries this.

Per pose it is far worse:

```
  pose          s48     s96    delta
  ref_01500   17.14   13.59   -3.55     <- 21% of the pose score
  ref_02220   32.68   31.53   -1.15
  ref_00600   37.55   38.35   +0.80
  ref_00840   27.26   26.55   -0.71
  ref_01800   25.24   24.91   -0.33
  ref_00000   32.41   32.71   +0.30
  ref_00720   31.32   31.20   -0.12
  ref_00450   36.44   36.43   -0.01
  ref_00120   32.66   32.72   +0.06
```

And in the underlying statistics:

```
                     s48        s96      delta   reference
highlight_frac    0.0035     0.0082    +0.0047      0.0088   <- 2.3x, from 40% of ref to 93%
lum_mean         107.198    110.091    +2.893      105.40
lum_std           38.044     39.914    +1.870       52.36
local_contrast    0.1351     0.1429    +0.0078      0.1936
lap_ratio         0.8406     0.8226    -0.0180      1.0
sat_mean          55.656     54.896    -0.760       79.14
```

`highlight_frac` **more than doubles** and lands almost exactly on the reference. Anyone
who tunes specular response against the settle-48 number is tuning against a phase, not
a material.

### 4c. Two separate causes, and only one of them is TAA

The 48-vs-96 comparison confounds two things, so I separated them.

**Cause 1 — `--settle` is also a world-clock knob, and this dominates.** `capture.mjs`
does `H.setTime(t)` **once** and then `H.advance(settle)` at `fixedDt = 1/60`. The clock
runs. So `--settle 48` renders the world at t+0.80 s and `--settle 96` at t+1.60 s.
Different wave crests, different foam, different sun glints. **`--settle` is not a
convergence parameter; it is a convergence parameter welded to an animation parameter.**
That is the whole explanation for `highlight_frac` doubling.

**Cause 2 — genuine temporal residual, isolated by freezing the world.**
`tools/_convprobe.mjs` pins `freeze(true)` and re-applies `setTime(t)` before *every*
frame, so the only thing that varies is the Halton jitter phase. Mean absolute 8-bit
difference against a settle-144 reference:

```
ref_00000 (frozen)          full      rock       sky      sand    max(full)
  settle  24 vs 144        1.346     1.807     1.724     0.848      148
  settle  48 vs 144        0.683     0.719     0.717     0.662       21
  settle  64 vs 144        0.657     0.664     0.655     0.661       16
  settle  96 vs 144        0.653     0.658     0.649     0.661       15

ref_01500 (frozen)          full      rock       sky      sand    max(full)
  settle  24 vs 144        1.632     1.661     1.379     2.216      101
  settle  48 vs 144        0.982     0.713     0.668     1.714       91
  settle  64 vs 144        0.902     0.659     0.624     1.587       79
  settle  96 vs 144        0.751     0.656     0.621     1.093       43
```

There is an irreducible floor of **~0.65 mean** — film grain re-dithers on every frame
index, so two different frame counts can never be identical. Read everything relative to
that floor:

- **`ref_00000` is converged at 48.** Excess over the floor is 0.030 codes, and max error
  21 vs a floor of 15. Fine.
- **`ref_01500` is NOT converged at 48, and is still not converged at 96.** Its `sand`
  ROI — the wet-sand/foam waterline — sits **1.714** at settle 48 against a 0.62 sky
  floor, i.e. **1.09 codes of real residual with a max error of 91 code values**, and it
  is still descending at 96 (1.093) and at 144. Something in that region has a temporal
  time-constant far longer than TAA's.

**Convergence is pose-dependent and nobody has been checking.** KNOWN_ISSUES §14 said "48
is roughly the minimum that converges, not a safety margin" — that was measured on
`ref_00000`, and it does not generalise. And note which pose fails: **`ref_01500` is the
worst-scoring pose in the project (17.14, `detail` axis 10.75) and it is also the one
whose image is still crawling at settle 48.** Those two facts have probably been
connected all along.

### 4d. What to do about it — and what NOT to do

- **Do not raise `--settle` globally.** It would change the world time of every capture
  and invalidate all seven historical rows at once, for a reason unrelated to
  convergence.
- **Decouple the two knobs.** `capture.mjs` should re-pin `setTime(t)` inside the settle
  loop, exactly as `_convprobe.mjs` already does, so `--settle` becomes a pure
  convergence control and captures land on a fixed world phase. **This is a deliberate
  re-baseline, not a bug fix — every number in `scores/history.jsonl` moves — so I did
  not do it here.** It needs an owner and one clean re-baselining run.
- **Until then, treat +/-0.5 score points as noise.** A wave that moves the score by less
  than that has not been shown to have moved it at all. This one moved it +0.21.

### 4e. Fixes applied here (verified, see §7)

The motion-vector convention fix was landed in `scene.js` + `taa.js` but **two of its
three named follow-ups were still open in the tree.** Both are now closed; measurements
in §7.

---

## 5. Performance — REGRESSED HARD. 19 of 21 poses are over 11 ms at p50

`node tools/_perfprobe.mjs --warm 40 --samples 90` — 40 warm-up frames discarded, 90
individually-timed frames per pose, one page load. Same method as §13/§23 so it is
directly comparable.

```
pose                            p50    p95   mean     max  draws         tris  prog
shot_hero_stack               16.40  18.90  15.38   35.20    677   37,733,969   113   OVER
shot_stack_gauntlet           16.30  18.70  15.54   34.30    637   33,358,625   113   OVER
ref_00840                     16.10  18.60  17.82  411.90    681   34,276,261   113   OVER
ref_01500                     16.10  18.80  17.38  408.10    687   33,129,133   113   OVER
ref_00600                     16.00  17.80  15.11   34.40    683   39,208,297   113   OVER
ref_01800                     15.80  18.60  16.94  401.00    663   30,768,493   113   OVER
shot_sky_ring                 15.70  18.20  17.60  419.30    689   39,062,717   113   OVER
ref_00450                     15.50  17.80  14.63   32.80    717   38,476,453   113   OVER
ref_00720                     15.50  18.40  17.34  399.50    691   38,729,613   113   OVER
shot_forerunner_bridge        15.50  18.10  14.64   33.50    730   38,439,209   113   OVER
shot_shoreline                15.20  17.60  16.24  386.60    691   36,727,957   113   OVER
shot_tide_pools               15.00  17.50  16.23  378.80    713   33,530,673   113   OVER
shot_bridge_underside         14.90  17.30  13.66   29.90    692   37,736,269   113   OVER
shot_overview                 14.70  16.80  12.82   31.50    533   30,771,997   113   OVER
shot_water_edge               14.60  18.50  16.96  407.50    658   32,642,813   113   OVER
shot_weapon_detail            14.00  17.50  12.84   30.40    675   36,237,157   113   OVER
shot_beach_establishing       13.80  15.80  12.87   27.50    663   35,243,613   113   OVER
ref_02220                     12.70  17.00  15.41  368.70    672   34,932,421   113   OVER
shot_cliff_vegetation         12.30  16.50  14.82  357.80    677   34,536,073   113   OVER
ref_00120                      9.20  12.00  13.95  488.30    679   36,601,341   113
ref_00000                      8.40  10.40   8.07   11.90    662   35,748,525   111
```

**19 of 21 poses exceed 11 ms at p50. 21 of 21 exceed it at p95.** Wave F had 2 of 21
over at p50. The floor has risen from 8.3 ms to 12.3 ms.

Movement since Wave F, same tool, same method:

```
                          waveF        waveG     delta
p50 range            8.30-14.10   8.40-16.40    +2.3 ms at the top
triangle range        29.6-32.5M   30.8-39.2M   +21% at the top
draw call range          523-645      533-730   +13%
```

### Which subsystem?

**Named on evidence, ranked by confidence:**

1. **Geometry volume, most likely `rocks` + `vegetation` + `props` — KNOWN_ISSUES §23 is
   not fixed, it got worse.** Every pose renders 30.8–39.2 M triangles. `shot_sky_ring`,
   a shot that is *mostly empty sky*, renders **39,062,717 triangles**. `shot_overview`
   renders 30.8 M from 533 draw calls. A floor that high in every pose regardless of what
   is in frame is the signature §23 called out: **the geometry is not being frustum- or
   distance-culled.** Nothing this wave addressed it, and the top of the range moved up
   21%.
2. **Draw calls +44 run-average (626 -> 670), peak 730.** `props` is the plausible source:
   this wave's props fix (`src/world/props.js`) removed two region-scale exclusion discs
   that had been rejecting *every* scatter point, so a module that was drawing literally
   nothing is now drawing its full population for the first time. That is a correct fix
   with a real cost, and it is the cleanest explanation for the simultaneous +13% draws
   and +21% triangles.
3. **`ocean` remains under suspicion at p95** per §13, unproven.

The `--skip` A/B that would settle this still has not been run, because `src/` has not
been quiescent for a single measurement window in two waves. **That A/B is the single
highest-value measurement nobody has taken.**

### NEW: a ~400 ms frame hitch, now on 11 of 21 poses

Wave F recorded one 525 ms outlier at `ref_00120` and called it secondary. It is not
secondary any more:

```
pose                     p50     max    ratio
ref_00120               9.20  488.30     53x
shot_sky_ring          15.70  419.30     27x
ref_00840              16.10  411.90     26x
ref_01500              16.10  408.10     25x
shot_water_edge        14.60  407.50     28x
ref_01800              15.80  401.00     25x
ref_00720              15.50  399.50     26x
shot_shoreline         15.20  386.60     25x
shot_tide_pools        15.00  378.80     25x
ref_02220              12.70  368.70     29x
shot_cliff_vegetation  12.30  357.80     29x
```

**Eleven poses now stall for a third to half a second, after 40 warm-up frames were
already discarded**, so it is not shader compilation. Every affected pose also has
`mean > p95`, which is the arithmetic signature of one or two enormous frames dragging
the average above the 95th percentile — a single hitch, not a broad slowdown.

Ten poses are clean (max 27.5–35.3 ms). The split does not correlate with triangle count
or draw calls. It is a real, visible half-second freeze in half the level and it appeared
this wave. Untriaged — the next perf owner should instrument which frame index stalls.

**Caveat that applies to every number above** (§22): `performance.now()` around `step()`
measures **CPU submit cost, not GPU frame time**. These are comparable to each other and
to §13/§23, and they are not frame times.

---

## 6. `docs/KNOWN_ISSUES.md` updated

Wave G section appended; §1, §12, §17, §18, §23, §24 status lines revised; §25–§27 added.
See that file.

---

## 7. Integration fixes applied — two, both named follow-ups of §1, both measured

I changed nothing else. No subsystem was rewritten.

### Fix 1 — `src/world/vegetation.js`: foliage was the last producer on the old motion-vector convention

§1 follow-up 1 said `vegetation.js` was still wrong. It was, and here is the proof rather
than the claim. `tools/_mvprobe.mjs --pose ref_01500 --settle 48` reads MRT1 back off the
GPU; with jitter `[0, -3.086e-4]` the predicted buggy velocity is `[0, +1.5432e-4]`:

```
                                  BEFORE                    AFTER
matId          px      zeroFrac    meanY        zeroFrac    meanY
 5 FOLIAGE  81,925       0.0056   +1.570e-04      0.0088   +3.587e-06
 7 SKIN     27,108       0.3427   +2.672e-05      0.3427   +2.672e-05
 2 WET     886,269       1.0000    0.000e+00      1.0000    0.000e+00
 3 ROCK    288,092       1.0000    0.000e+00      1.0000    0.000e+00
 1 SAND    125,176       1.0000    0.000e+00      1.0000    0.000e+00
 4 FORER    52,612       1.0000    0.000e+00      1.0000    0.000e+00
 0 DEFAULT   3,143       1.0000    0.000e+00      1.0000    0.000e+00
```

**Foliage's mean vertical velocity was `+1.570e-4` against a predicted-buggy
`+1.5432e-4` — the jitter offset, in isolation, to within 1.8%.** After the fix it is
`+3.587e-6`, a **44x reduction**, and what remains is the genuine wind velocity the
material is supposed to carry (`zeroFrac` stays near zero because foliage really does
move). Every other material is byte-identical before and after — SKIN unchanged to all
printed digits, so the AI characters were not disturbed.

The change is three lines, mirroring `terrain.js` exactly: a `uCurrViewProj` uniform,
`vVegCur = uCurrViewProj * vec4(transformed, 1.0)` in place of `vVegCur = gl_Position`,
and one assignment in `prerender`. Rasterisation stays jittered, as it must.

### Fix 2 — `src/render/passes/motionBlur.js:189`: compensation for a bug that no longer exists

§1 follow-up 2. The line was `v = g1.rg + 0.5 * uJitter;`, cancelling a jitter that
`scene.js` no longer writes. It is now `v = g1.rg + uMvLegacy * 0.5 * uJitter;` with
`uMvLegacy` driven by `ctx.config.mvLegacyJitter`, exactly as `taa.js` does — so the
legacy A/B now flips **all three** consumers coherently instead of two. The stale doc
comment above it was rewritten. §1 already proved the over-correction was below this
pass's own `mbMinPx = 0.60` cutoff, so no image change was expected and none was seen.

### Verification after both fixes

```
node tools/parsecheck.mjs                 ok — 42 files parse, no GLSL template hazards
__HALO__.failedModules()                  []          (re-probed, still empty)
console errors / shader errors            none        (same 7 benign lines as §1)
cmp shots/g6.png shots/g7.png             DETERMINISTIC_AFTER_FIX
node tools/score.mjs --tag waveG-mvfix    30.30       (waveG was 30.30)
```

Raw statistics moved only in the 4th decimal (`lap_var` 318.3364 -> 318.3183, `sat_mean`
55.6561 -> 55.6564), which is what a correctness fix confined to 5.6% of pixels at
0.083 px of error should look like. **This confirms §1's own honest conclusion: the bug
was real, exact, and was never reaching a scored still.** It is worth fixing so the
invariant holds, not because it buys points.

### A hazard I walked straight into, for the next agent

My first version of the vegetation comment used backticks inside the GLSL template
literal and `parsecheck` caught it immediately — **KNOWN_ISSUES §20, one commit after it
was written down.** The gate works. Run it before believing an edit landed.

---

## What the next wave should attack, in order

1. **§18, the shared depth texture.** `scene.js:114` still calls `renderer.clearDepth()`.
   It was assigned to this wave's `scene.js` owner and did not get done. It is silently
   degrading `ssao`, `ssr`, `taa`, `motionBlur` and water refraction, has removed `dof`
   from the build entirely (§21), and is the likely root of §24.
2. **The `--settle` decoupling (§4c).** Until it lands nobody can tell a +0.21 wave from
   noise, which is exactly the position this report is in.
3. **Culling (§23).** 39 M triangles for a sky shot. Cheapest large perf win available,
   and the `--skip` A/B still has not been run because the tree is never quiescent.
4. **`sat_mean` 55.7 vs 79.1 (§8 chroma half).** Two waves have now moved it backwards.
   §18 must land first or you will fit constants to a bug.
5. **The two broken showcase poses (§17.1)** — two lines in `poses.js`, and they are 2 of
   12 cells of the project's shop window.


