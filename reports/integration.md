# Integration pass — wave F

**Run window:** 2026-07-30 19:00–19:45 CDT
**GPU:** ANGLE (NVIDIA, Vulkan 1.4.341, RTX 3080 Ti)
**Previous pass:** archived at `reports/integration_waveE.md`

Scope: verify the fog/exposure fix and the research-informed critic+refine pass across the
whole scene. Every number below came from a PNG this renderer wrote or a JSON this repo's
tools emitted — never from a transformed reference frame (KNOWN_ISSUES §4).

**Headline:** score **30.09**, best on record, +1.47 over Wave E. Determinism holds. Zero
shader errors, zero failed modules, zero missing passes — the cleanest boot this project has
recorded.

Three findings that are not in the score, in order of importance:

1. **A new rendering defect (§7).** `taa` writes ~8,000 pixels of pure `rgb(0,0,0)` over the
   ocean at `shot_sky_ring`. Deterministic, bisected to a single pass by elimination, and
   partly hidden by film grain.
2. **A performance regression nobody logged (§6).** Triangle count has **2.3x'd since Wave
   E** for +3% draw calls; two poses now exceed 11 ms at p50 and twenty of twenty-one exceed
   it at p95. And the extra geometry made the image *softer*, not sharper — `lap_ratio` fell
   0.9857 → 0.7929.
3. **The desaturation is not fixed (§3)** — `sat_mean` **55.72** against a target of 83.9,
   and it moved *backwards*. But the diagnosis has changed: it is no longer the fog.

---

## 0. Validity gate

KNOWN_ISSUES §16 says a measurement is only valid if `src/` is quiescent for its whole
duration; §20 says run `parsecheck` before believing anything. Both enforced.

```
$ node tools/parsecheck.mjs
ok — 42 files parse, no GLSL template hazards
```

No subsystem is silently dead this wave — itself an improvement on Wave E, where `ocean.js`
and `rocks.js` were both absent from the build without anyone noticing.

`src/` was **not** quiescent for the whole session. Writes observed live:

```
19:00:23  src/render/passes/{bloom,dof,grain,sharpen}.js
19:07:14  src/world/structures.js
19:12:00  src/world/structures.js
19:12:07  src/world/props.js
```

Each measurement below is annotated with the window it ran in. Anything that straddled a
write was discarded and re-run. This mattered — see §4.

---

## 1. Scored run — `waveF`

Captures ran 19:01:13 → 19:01:55 against a tree last written 19:00:23. Quiescent for the
whole run (50 s of margin — thin, but real).

```
   # tag                      SCORE  struct   grade  percep  detail  geomet  spectr
   1 baseline-empty            0.00     0.0     0.0     0.0     0.0     0.0     0.0
   2 latest                   22.24     3.7     0.0     2.1    56.6    62.5    82.3
   3 latest                   22.24     3.7     0.0     2.1    56.6    62.5    82.3
   4 waveE                    28.62     5.1     0.0     4.7    75.2    79.4    96.6
   5 waveE-fix                28.62     5.1     0.0     4.7    75.2    79.4    96.6
   6 waveF                    30.09     4.6     0.0     9.5    75.9    91.0    82.3

delta since first: +30.09
best: waveF @ 30.09
```

Axis by axis against Wave E:

| axis | waveE | waveF | delta | read |
|---|---|---|---|---|
| structure | 5.13 | 4.63 | −0.50 | small regression |
| grade | 0.00 | 0.00 | 0.00 | **dead readout — KNOWN_ISSUES §15** |
| perceptual | 4.66 | **9.49** | **+4.83** | doubled; real |
| detail | 75.17 | 75.92 | +0.75 | flat |
| geometry | 79.44 | **90.96** | **+11.52** | headline number, but see caveat |
| spectrum | 96.60 | **82.27** | **−14.33** | **largest single move of the wave, and it is a regression** |

Underlying raw metrics, waveE → waveF (all read from `scores/waveE.json` and
`scores/waveF.json`):

```
ssim            0.4392 -> 0.4371    -0.0021
ms_ssim         0.3545 -> 0.3485    -0.0060
hist            0.8020 -> 0.7934    -0.0086   (lower is better)
lpips           0.6813 -> 0.6599    -0.0214   (lower is better; drives `perceptual`)
lap_ratio       0.9857 -> 0.7929    -0.1928   (target 1.0 — this is the big one)
edge_ratio      0.8912 -> 1.0328    +0.1416   (target 1.0; drives `geometry`)
spectral_slope  -2.575 -> -2.625              (reference -2.542)
```

Four honest caveats about the headline:

1. **`lap_ratio` collapsed 0.9857 → 0.7929.** Wave E's Laplacian-energy ratio was within
   1.5% of the reference — effectively solved. It is now 21% short. This is the single
   worst raw-metric move of the wave and it is *not* visible in the `detail` axis, which
   went *up* (75.17 → 75.92). Whatever `detail` is weighting, it is not tracking this.
2. **`geometry` +11.5 is not unambiguously good.** It is driven by `edge_ratio` crossing
   0.8912 → **1.0328** — the render went from having *fewer* edges than the reference to
   having *more*. The axis scores distance from 1.0, so it rewards the crossing; but we
   have overshot, and the next increment of edge density will score *worse*. Do not read
   this as "geometry is 91% correct". It is "edge density passed through correct on its
   way up".
3. **`spectrum` −14.3 is a real regression**, and it agrees with caveat 1.
   `spectral_slope` −2.575 → **−2.625** against a reference −2.542: too little
   high-frequency energy relative to low. Two independent metrics (`lap_ratio`,
   `spectral_slope`) now say the frame got *softer* — while triangle count more than
   doubled (§6). More polygons, less visible detail. That combination is the strongest
   single signal in this report and it points at the same place §6 does.
4. **`grade` scored 0.00 for the sixth run running.** `hist` improved 0.8020 → 0.7934 and
   the axis did not move, because `band(hist, 0.25, 0.75)` returns 0 for anything ≥ 0.75.
   KNOWN_ISSUES §15 called this out last wave; still unfixed, still hiding real progress.

Per-pose, worst first:

| pose | score | structure | perceptual | detail | geometry | spectrum |
|---|---|---|---|---|---|---|
| ref_01500 | 17.00 | 0.00 | 5.86 | **9.92** | 69.39 | 74.54 |
| ref_00120 | 22.19 | 0.00 | 5.30 | 41.13 | 92.32 | 87.36 |
| ref_01800 | 25.28 | 0.00 | 4.23 | 49.87 | 93.25 | 87.53 |
| ref_00000 | 31.96 | 0.00 | 12.07 | 85.68 | 100.00 | 81.75 |
| ref_02220 | 32.78 | 0.00 | 8.16 | 100.00 | 88.87 | 100.00 |

**`ref_01500` is the worst pose and `detail` 9.92 is why.** It was 49.34 at Wave E — a
39-point collapse at one pose while the mean held steady. Something specific to that
framing regressed. This is the highest-value single lead in the report and nobody has
looked at it.

`structure` is 0.00 at seven of nine poses. That is not tuning, it is framing —
KNOWN_ISSUES §3, the poses have never been fitted.

---

## 2. Showcase contact sheet — cell by cell

`shots/preview/preview.png`, 3896x3134, 12 cells, regenerated 19:49 against a tree last
written 19:47:52.

**How it was captured, and why that is worth recording.** `node tools/previewsheet.mjs`
hung. The shared capture daemon was reporting `{"inflight":3,"queued":451,"served":183}`
and `served` did not advance over fifteen minutes — another agent had buried the queue.
Rather than wait or adopt the per-pose fallback (twelve separate Chrome boots), I added
`tools/_sheetcap.mjs`: one vite + one Chrome, all twelve poses in a single page load,
writing to the same paths, followed by `previewsheet.mjs --no-capture` to composite. Memory
cost is bounded and torn down on exit — this is not the `HALO_NO_DAEMON=1`-for-everything
pattern KNOWN_ISSUES §19 warns against.

Honest first impression before the detail: **the scene is legible and no longer obviously
broken** — there is sand, water, sea stacks, a bridge, clouds, a gas giant. That is a real
change from the placeholder era. But the sheet is not showable. Two of twelve cells put the
camera under the world, three are full of untextured mannequins, four have captions that
describe something not in the frame, and one has a block of corrupted black pixels.

**A defect present in all twelve cells:** the MA5B viewmodel occupies the lower-right of
every single frame at identical size and position. For a contact sheet meant to sell twelve
different views, twelve identical gun barrels is the most repetitive thing on the page.
Cells 01, 04 and 10 are largely sky, so the gun is the dominant object in them.

**A second global defect:** stars are visible through a bright blue daytime sky in cells 03,
04, 05, 06, 10 and 11. The sun is up and clouds are lit; the star layer is not being faded
out by daylight.

| # | caption | what is actually in the frame |
|---|---|---|
| 01 | beach — establishing | **Camera is under the terrain.** The lower ~45% is flat dead lavender-grey with no geometry. The beach is seen edge-on from beneath as a thin slab with boulders embedded in its *underside*, and clouds sit below the ground line. Unusable. |
| 02 | opening shot (reference-matched) | **The best cell on the sheet.** Warm sand with convincing cobble scatter, a Forerunner span mid-frame, vegetated cliffs left and right, good cumulus. Faults: the sand pebbles read as a repeating stamp, and the ring's inner surface (top right) is a flat green-blue smear rather than terrain. |
| 03 | forerunner bridge | **No bridge in the frame.** A pale cliff on the left, flat beach, clouds, gas giant top right, sea stacks right edge. The caption's subject is absent. Clouds show blocky stair-stepped silhouettes. |
| 04 | bridge underside — light shafts | **No bridge and no light shafts.** Sky, clouds, gas giant, a pale cliff bottom-left, a sliver of beach. ~80% sky. The caption promises the single most cinematic effect on the sheet and none of it is present. |
| 05 | hero sea stack + tree | Composition works — stacks with crowns against the gas giant. But the stacks are **washed to near-white translucent ghosts**, reading as frosted glass rather than rock, and **each stack is cut flat at the base with a pale pedestal hovering above the waterline**. Water is blown out to near-white. |
| 06 | stack gauntlet | The strongest of the stack cells: visible rock texture, teal water with some depth, the ring band up the centre. Still shows the **flat-cut floating bases**, and the crowns read as broccoli florets. |
| 07 | shoreline — foam + wet sand | **Two untextured humanoid mannequins standing in the shallows**, one carrying a flat brown lozenge. Foam is present but reads as flat white smears painted on, and the wet/dry sand transition is weak. |
| 08 | waterline — refraction + caustics | **Neither refraction nor caustics is visible.** A red-and-grey mannequin stands dead centre blocking the shot, with a second clipped at the left edge. The stacks behind show the floating-base defect very clearly. |
| 09 | tide pools | **About ten mannequins in a line across the mid-ground**, one emitting an unexplained white orb. This is the worst "placeholder junk" cell. Underneath them the wet cobble, standing water and foam channels are genuinely good — the cell would be a highlight without the crowd. |
| 10 | cliff + vegetation | **Camera is under/at the terrain edge again.** Bottom ~25% is flat dead grey. No coherent cliff; vegetation appears as **brown flat chips floating unattached in mid-air** on the right. Mostly sky and gas giant. |
| 11 | halo ring + threshold | **Contains a large block of corrupted pure-black pixels** across the far waterline — see §7, this is a real rendering defect, not a dark surface. The ring reads as a vertical pale column that stops, not an arc sweeping overhead. The sun is a small dot with almost no glare for a shot captioned "threshold". |
| 12 | MA5B viewmodel | **Not a weapon detail shot.** The gun sits in the corner at exactly the size it is in the other eleven cells; the frame is a beach with the bridge soffit overhead. Sand and cobble render well and there are yellow flowers on the right bank, but the caption is unmet. |

### Scored against KNOWN_ISSUES §17, which listed the Wave E sheet defects

| §17 item | status |
|---|---|
| 1. `shot_beach_establishing` + `shot_cliff_vegetation` under the terrain | **STILL OPEN**, both cells, unchanged |
| 2. Halo ring renders as two thin white lines | **PARTIALLY FIXED.** It is now a textured band with visible structure (cells 05, 06, 11) rather than two lines. It still reads as a vertical column rather than an arc, and its inner surface (cell 02) is a flat smear. |
| 3. Character models in showcase cells | **STILL OPEN**, and it is now cells 07, 08 **and** 09, with ~10 figures in the tide-pool shot |
| 4. Sea stacks float, cut flat at the base | **STILL OPEN**, clearly visible in 05, 06 and 08 |
| 5. `shot_water_edge` and `shot_weapon_detail` do not show their captions | **STILL OPEN**, and cells 03 and 04 have the same problem — four cells now, not two |

So of five recorded showcase defects, **four are unchanged and one is partly improved.** No
showcase work landed this wave. That is worth stating plainly next to a +1.47 score: the
score moved and the presentation did not.

---

## 3. Is the desaturation fixed? **No.**

Targets from `docs/TARGETS.md`, "Whole-frame signature (mean over the clip)". Measured
values are the mean over all nine scored poses of `tools/metrics.py` output on the frames
`waveF` wrote.

| statistic | Wave E | **Wave F** | target | measured ref keyframes | verdict |
|---|---|---|---|---|---|
| `sat_mean` | 57.10 | **55.72** | **83.9** | 79.14 | **NOT fixed — 28.2 short, and it went backwards −1.38** |
| `lum_mean` | 105.43 | **107.81** | **107.8** | 105.40 | **FIXED — delta +0.01** |
| `p50` | 105.89 | **112.22** | **105** | 99.44 | **overshot +7.2** |

The three numbers asked for, quoted directly: **`sat_mean` 55.72**, **`lum_mean` 107.81**,
**`p50` 112.22**.

So the *brightness* half of KNOWN_ISSUES §8 is closed and stayed closed — `lum_mean` is
within 0.01 of target, which is as good as this instrument can report. The *chroma* half is
not closed, and Wave F did not move it forward.

Whole-frame breakdown, ours vs reference keyframes, mean over nine poses:

```
                lum_mean  sat_mean       p50       p01       p99   lum_std     lab_b   lap_var  loc_cont
MEAN ours         107.81     55.72    112.22     14.89    206.67     37.38     -6.08    300.97      0.13
MEAN ref          105.40     79.14     99.44     15.67    222.11     52.36     -1.59    424.13      0.19
DELTA              +2.41    -23.42    +12.78     -0.78    -15.44    -14.97     -4.49   -123.16     -0.06
```

Per pose:

```
pose          lum_mean  sat_mean       p50       p01       p99   lum_std     lab_b   lap_var  loc_cont
ref_00000       104.73     51.08    111.00     18.00    190.00     32.39     -1.69    443.40      0.11
ref_00120       106.48     51.95    112.00     19.00    192.00     31.38     -1.93    464.54      0.11
ref_00450       106.42     54.58    110.00     16.00    211.00     35.70     -4.86    363.68      0.13
ref_00600       109.97     68.59    114.00     11.00    225.00     41.52    -12.09    139.38      0.15
ref_00720       105.58     59.69    108.00     12.00    223.00     38.52     -6.63    305.01      0.14
ref_00840       112.86     51.54    117.00     13.00    215.00     38.85     -8.05    215.83      0.14
ref_01500       110.82     48.07    115.00     15.00    202.00     37.34     -7.60    225.29      0.13
ref_01800       109.86     52.15    114.00     17.00    201.00     39.88     -8.11    184.15      0.15
ref_02220       103.57     63.80    109.00     13.00    201.00     40.89     -3.75    367.44      0.15
```

### The diagnosis has changed, and this contradicts current KNOWN_ISSUES §8 advice

Wave E's finding was that both tails were pulled toward the middle — the additive
in-scatter signature. **That is no longer what the numbers show.**

- `p01` **14.89** vs ref 15.67 — blacks are now *correct*. At Wave E `p01` was **+8.89**
  over reference (lifted). **That half of the haze is genuinely gone.** This is the fog fix
  working, and it should be credited.
- `p99` **206.67** vs ref 222.11 — whites are still crushed by 15.4.
- `lum_std` **37.38** vs 52.36 — still only 71% of the reference's tonal spread.
- `local_contrast` **0.13** vs 0.19.

An additive term lifts *both* ends. A **correct `p01` with a crushed `p99`** is not additive
in-scatter — it is a highlight roll-off / exposure-shoulder signature, which points at
`tonemap.js` and the AgX shoulder, not at `volumetricFog.js`.

Two further pieces of evidence that the residual is not fog:

- **`lab_b` −6.08** against a reference −1.59 and a `TARGETS.md` target of **+1.4**. The
  frame is *blue* where it should be faintly warm. An achromatic haze can only wash chroma
  *toward zero*; it cannot create a chroma *bias*. A −6 `lab_b` is a colour-balance error
  in grade or tonemap.
- **The deficit is strongly pose-dependent**: `ref_00600` reaches `sat_mean` 68.59 while
  `ref_01500` manages only 48.07. A whole-frame haze would be far more uniform. The
  sky-dominated poses score worst, which implicates the sky's own chroma and the grade,
  not a near-field term.

**Recommendation.** Stop attributing the residual `sat_mean` to `volumetricFog.js`. The next
experiment should be a controlled A/B on grade/tonemap chromaticity — specifically whatever
is producing `lab_b` −6 — measured on the **`sand` ROI**, not whole-frame, so the sky does
not dominate the average (KNOWN_ISSUES §6). I did not run that experiment: it is well
outside "small obviously-correct integration bugs" and it needs a named owner.

And the Wave E warning still stands: **do not chase this with grade saturation.** Raising
saturation cannot fix a crushed `p99` or a −6 `lab_b`; it would just add chroma noise on top
of a tone-curve problem.

---

## 4. Determinism

**Result: DETERMINISTIC.** But the first run reported `BROKEN`, and why it did is worth
recording, because it will happen again.

### First attempt — BROKEN, and invalid

```
$ node tools/capture.mjs --pose ref_00000 --out shots/d1.png --settle 48   # wrote 19:06:17
$ node tools/capture.mjs --pose ref_00000 --out shots/d2.png --settle 48   # wrote 19:09:31
$ cmp shots/d1.png shots/d2.png && echo DETERMINISTIC || echo BROKEN
shots/d1.png shots/d2.png differ: byte 455082, line 1451
BROKEN
```

Before reporting a defect I ran the validity gate. `src/world/structures.js` was written at
**19:07:14** — between the two captures. The diff localises to exactly where that would
show:

```
differing px: 95721 = 4.616 %      max abs diff 64
bbox  y 127..552   x 124..1887
top-third: 8.546% differ    mid-third: 5.303% differ    bot-third: 0.000% differ
```

The bottom third — the near beach — is **byte-identical**. Only the upper/mid band where
the bridge and towers sit changed. That is a source edit, not an RNG.

Note this is a *different* signature from KNOWN_ISSUES §10 (the `Math.random()` program
cache key), which produced a ~45% diff covering the entire ground plane. §10 remains fixed.

### Second attempt — clean, DETERMINISTIC

Polled the three newest `src/*.js` mtimes until stable for 80 s, re-ran parsecheck, then:

```
$ node tools/parsecheck.mjs
ok — 42 files parse, no GLSL template hazards
$ node tools/capture.mjs --pose ref_00000 --out shots/d1.png --settle 48   # wrote 19:14:55
$ node tools/capture.mjs --pose ref_00000 --out shots/d2.png --settle 48   # wrote 19:18:10
$ cmp shots/d1.png shots/d2.png && echo DETERMINISTIC || echo BROKEN
DETERMINISTIC
```

Last `src/` write before this window was 19:12:07; nothing was written 19:12:07 → 19:18:10,
so both captures saw the same tree. `programs` stable at 108 across both.

### The grep, run anyway

```
$ grep -rn "Math.random\|Date.now\|performance.now" src/world src/game src/render
```

Every hit is benign. There are **no** `Math.random` or `Date.now` calls in any pixel path.

- `performance.now()` in `ocean.js:1648,1675`, `rocks.js:1644,1941`, `env.js:660,700`,
  `audio.js:1347–1443`, `Engine.js:139,141,195,203,205,228,230`, `hud.js:1018,1051`,
  `ai.js:1402,1433` — all of the form `const t0 = performance.now()` … `ms = performance.now() - t0`,
  i.e. self-reported CPU cost written to a stats field. None feeds a uniform, a vertex or a
  texel.
- `Math.random()` appears in `src/gfx/materialCommon.js:176` **only inside a comment**
  describing the §10 bug that was removed, and in `tools/capture.mjs`'s browser-launch retry
  backoff (a tool, not the renderer).
- `src/game/hud.js:25-26` carries an explicit comment asserting the same invariant.

The grep confirms what the clean re-run showed. **Determinism is intact; the `BROKEN` was
measurement contamination — exactly the hazard KNOWN_ISSUES §16 predicted, reproduced within
one session of it being written down.**

---

## 5. Shader errors, exceptions, failed modules, "not loaded"

**There are none.** Cleanest boot recorded in this project.

The capture daemon swallows console output into a `warnings[]` array, so I bypassed it and
drove a dedicated vite + Chrome with every console channel drained (`console`, `pageerror`,
`requestfailed`) — `tools/_perfprobe.mjs`, added this pass. Complete console output for a
full boot plus a sweep of all 21 poses, verbatim, all six lines:

```
[console.debug] [vite] connecting...
[console.debug] [vite] connected.
[console.log] [vegetation] crowns headland:198px/4v stack_arch:152px/8v stack_hero:68px/5v stack_twin_a:62px/4v stack_twin_b:44px/3v stack_far_a:31px/8v stack_far_b:19px/8v
[console.log] [vegetation] ground: 27987 visible cells, floors near=5.26 mid=9.92 -> 1096 near + 5181 sward cells
[console.log] [vegetation] {"draws":12,"blades":172000,"trees":21,"shelf":4479,"moss":753,"ivy":3200,"vines":1589,"scrub":620,"cells":27987,"tris":2382392}
[console.info] [dof] world path disabled: dofWorldDepthValid is false because KNOWN_ISSUES 18 leaves pipe.depthTex holding no world geometry (measured: every pixel returns CoC 0 and the pass is byte-identical to dofEnabled:false). Set ctx.config.dofWorldDepthValid = true the day scene.js stops clearing the shared depth texture, and re-derive dofViewmodelCoC once the viewmodel reaches the G-buffer. See reports/postfx.md.
```

Boot status object, verbatim:

```json
{"ok": true, "missing": [], "failed": []}
```

And from the scored captures:

```json
"failedModules": []
"warnings": []
```

- **`__HALO__.failedModules()` — empty.** All 19 modules initialise.
- **"not loaded" — no such line.** `__HALO_MISSING__` is empty; `[capture] modules not loaded:`
  never fired.
- **Shader errors — none.** No compile or link diagnostics. In particular the
  `GL_INVALID_OPERATION: glDrawElements: Feedback loop formed between Framebuffer and active Texture`
  reported in KNOWN_ISSUES §16 **did not reproduce** in this pass.
- **Exceptions — none.** No `pageerror`, no `requestfailed`, no 404.

Module init times (ms), from `__HALO__.stats()`:

```
time 0    lighting 1.1   sky 52.6    clouds 366    env 50
terrain 1164.6   rocks 2279   structures 28.9   vegetation 365.2   ocean 34.4
props 1158.6   particles 7.7   physics 0.7   player 0.2   weapons 1359.7
ai 30.8   hud 11.5   audio 0.1   pipeline 246.6
```

`physics` at 0.7 ms confirms KNOWN_ISSUES §11 is still fixed — it initialises instead of
throwing. Total init ≈ 7.1 s, dominated by `rocks` 2.3 s and `weapons` 1.4 s.

### The one line in that output that is a real finding

The `[dof]` line is not noise. **Depth of field is currently a no-op.** The pass runs and is
byte-identical to being disabled, because `dofWorldDepthValid` is `false`, because
KNOWN_ISSUES §18 (the shared depth texture is cleared every frame) is still open.

The postfx author did the right thing — gated it off honestly rather than shipping a pass
tuned against a depth buffer containing only a gun, and left a precise re-enable condition.
But the consequence is that **§18 is now costing a whole shipped subsystem**, not merely
accuracy. §18 should be the highest-priority open item in the project: it blocks `dof`
outright and silently degrades `ssao`, `ssr`, `taa`, `motionBlur` and water refraction.

---

## 6. Performance

### The instrument was wrong, so I replaced it

`scores/*.json` reports `perf.ms` from `engine.stats.ms`, an EMA (α=0.1) read **once at the
end of the run**. In an `--all` run one page serves all nine poses, so that number is the
EMA at the end of the *last* pose only — `waveF.json` says `ms: 5.13`, which is
`ref_02220`'s warm number being reported as the whole run's. A single-pose capture has the
opposite bias: the EMA is seeded on a cold page, so `ref_00000` alone reports `ms: 11.60`,
still carrying shader-compile cost.

Both numbers are in the repo, they disagree by 2.3x, and neither is a per-pose steady state.

`tools/_perfprobe.mjs` does it properly: one page, one pose at a time, **30 warm-up frames
discarded**, then **90 individually-timed frames** → p50/p95/mean. Same method as the
KNOWN_ISSUES §13 table, so the numbers are directly comparable to it.

### Results — all 21 poses, sorted by p50

```
pose                          p50    p95   mean     max   draws         tris  progs
shot_stack_gauntlet         14.10  26.10  13.22   35.30     593   29,591,049    110   <-- >11 ms
shot_shoreline              11.50  18.60  11.05   32.80     645   32,310,093    110   <-- >11 ms
ref_00600                   10.90  22.60  12.34   29.00     639   32,475,489    110
ref_00840                   10.90  24.30  13.09   42.50     635   30,218,405    110
ref_00450                   10.10  21.80  11.51   25.40     673   31,765,581    110
ref_00720                   10.00  19.50  12.02   28.00     648   32,432,133    110
ref_01500                   10.00  18.30  11.59   25.00     644   30,233,029    110
shot_bridge_underside       10.00  16.40  10.42   26.70     652   31,634,933    110
shot_tide_pools              9.90  20.90  12.06   45.20     669   32,433,065    110
ref_01800                    9.70  18.40  11.10   23.20     620   30,107,205    110
shot_water_edge              9.70  22.90  12.21   36.40     615   30,020,381    110
shot_forerunner_bridge       9.60  18.60  10.19   25.70     685   31,753,401    110
ref_02220                    9.40  14.20   9.81   15.90     627   31,289,573    110
shot_beach_establishing      9.30  15.80  10.29   29.50     619   30,990,565    110
shot_hero_stack              9.30  20.00  11.90   27.90     632   32,344,137    110
shot_cliff_vegetation        9.30  14.80  10.00   29.20     617   31,090,777    110
ref_00000                    9.20  10.40   8.82   14.40     618   31,060,797    108
shot_weapon_detail           9.20  15.40  10.34   29.70     631   31,137,333    110
ref_00120                    8.80  12.00  13.94  525.70     636   31,176,725    110
shot_sky_ring                8.80  18.90  10.56   35.70     641   32,481,257    110
shot_overview                8.30  19.60  10.86   29.60     523   30,684,757    110
```

### Flagged: over 11 ms

**At p50, two poses exceed the bar:**

- **`shot_stack_gauntlet` — 14.10 ms p50, 26.10 p95.** Worst pose in the build, 2.6 ms clear
  of second place.
- **`shot_shoreline` — 11.50 ms p50, 18.60 p95.**

**At p95, twenty of twenty-one poses exceed it.** Only `ref_00000` (10.40) stays under. Nine
poses are over 20 ms at p95. The frame time is not merely high, it is *erratic*.

### Naming the subsystem: `rocks`

Unlike KNOWN_ISSUES §13 — which named `ocean` on correlation and said so — this attribution
has a direct same-pose, same-method comparison behind it. `shot_stack_gauntlet` appears in
the §13 table:

```
shot_stack_gauntlet     p50 ms         tris    draws
KNOWN_ISSUES §13 (E)      4.70   12,904,456      575
this pass (F)            14.10   29,591,049      593
                        ------   ----------     ----
                           3.0x         2.3x      +18
```

**Draw calls barely moved (+18, +3%) while triangles went up 2.3x.** That is not more
objects — it is the *same* objects carrying far more geometry: a tessellation or LOD change,
not a scene-population change. `shot_stack_gauntlet` is the most rock-dominated pose in the
level and it is the worst regression. Corroborating mechanism: `rocks` is by far the most
expensive module to initialise (2279 ms, 2x the next highest), consistent with a much denser
mesh generator having landed this wave.

Whole-build context: **every pose now renders 29.6–32.5 M triangles.** The §13 table ranged
12.9–15.3 M. The floor has roughly doubled *everywhere* — including `shot_sky_ring` at
32.5 M, for a shot that is mostly empty sky. That strongly suggests the extra geometry is
**not being frustum- or distance-culled**. That is the first thing to check, and it is far
cheaper to check than a rewrite.

**And the geometry is not buying detail — it is costing it.** Cross-reference §1: over this
same wave `lap_ratio` fell **0.9857 → 0.7929** and `spectral_slope` moved **−2.575 →
−2.625** away from the reference. Triangle count more than doubled and the frame got
measurably *softer* by two independent measures. That is what dense geometry aliasing into
sub-pixel noise and then being averaged out by TAA looks like — so LOD/culling is not only
the cheap perf fix here, it is plausibly also the `lap_ratio` and `spectrum` fix. Worth
testing that hypothesis directly before anyone tries to add sharpness back in post.

Honest limit on this attribution: I did **not** run a `--skip rocks` A/B, because other
agents were writing `src/` and a skip A/B is only meaningful on a quiescent tree. **`rocks`
is named on strong correlation plus a mechanism, not on proof.** The A/B that settles it:

```bash
node tools/_perfprobe.mjs --warm 30 --samples 90                                  # baseline
node tools/capture.mjs --pose shot_stack_gauntlet --skip rocks --settle 48        # and per-module
```

### Two secondary findings

- **`ref_00120` max 525.70 ms.** A single half-second frame, 37x its own p50 of 8.80, and it
  fired *after* 30 warm-up frames were already discarded. Everything else in the build peaks
  at 45 ms. A lazy build or allocation stall landing long after init — worth chasing, because
  a half-second hitch mid-gameplay is a visible freeze, not a statistical artifact.
- **`mean` exceeds `p50` at nearly every pose** (e.g. `ref_00840` p50 10.90 / mean 13.09).
  The distribution has a long right tail everywhere — this is not a stable frame time with
  rare spikes, it is a consistently unstable one.

### A caveat that applies to every perf number in this repo

`Engine.advance()` times `step()` with `performance.now()` on the CPU. WebGL command
submission is asynchronous, so this measures **CPU submit cost, not GPU frame time.** The
true GPU cost could be higher or lower. Every perf number in this project — including the
KNOWN_ISSUES §13 table — has this property. They are comparable to each other and should not
be quoted as frame times outside the project. GPU timer queries
(`EXT_disjoint_timer_query_webgl2`) would fix it.

GPU under test: `ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA GeForce RTX 3080 Ti), NVIDIA)`.

---
## 7. NEW DEFECT — TAA writes pure-black corruption over the ocean at `shot_sky_ring`

Found in cell 11 of the contact sheet. This is a new finding; it appears nowhere in
`docs/KNOWN_ISSUES.md` or in any prior report.

### The symptom

`shots/preview/shot_sky_ring.png` contains **7,978 pixels of exact `rgb(0,0,0)`**, 0.385% of
the frame, in a fixed bounding box `y902-1035 x357-956`. In an AgX-tonemapped frame with
film grain applied, exact zero in all three channels is not a lighting result — it is a
NaN or Inf reaching the framebuffer. Visually it is a shredded band of horizontal black
streaks lying on the water at the far shoreline, dense at the horizon and breaking into
dashes toward the camera.

### It is deterministic, and specific to this one pose

Scanned every frame this pass produced — the twelve showcase frames and the nine scored
frames, 21 in total:

```
frame                              exact-black      pct   bbox
shot_sky_ring.png                        7,978   0.385%   y902-1035 x357-956
(all 20 others)                              0   0.000%
```

Re-captured the pose independently, against a tree that had changed in between:

```
ring_a.png (sheet, 19:49)   exact-black  7,978   0.385%   y902-1035 x357-956
ring_b.png (fresh, 19:52)   exact-black  7,977   0.385%   y902-1035 x357-956
```

Same bounding box to the pixel, count stable to one part in eight thousand, across two
different builds. This is a stable defect, not a transient.

### Bisected by elimination to `taa`

`tools/_blackab.mjs` (added this pass) captures the same pose eleven times in one page load,
switching off one pipeline pass or world module per capture via `__HALO__.togglePass()`, and
counts exact-black pixels. Config/toggle overrides work independently of the source tree
(KNOWN_ISSUES §19), so this result cannot be invalidated by another agent writing `src/`.

```
variant                   exact-black      pct   bbox
baseline                        7,977   0.385%   y902-1035 x357-956
ssr_off                         8,103   0.391%   y902-1035 x357-956
ssao_off                        7,974   0.385%   y902-1035 x357-956
cloudComposite_off              7,984   0.385%   y902-1035 x357-956
volumetricFog_off              12,644   0.610%   y902-1035 x357-956
taa_off                             0   0.000%   --
motionBlur_off                  7,977   0.385%   y902-1035 x357-956
bloom_off                       7,986   0.385%   y902-1035 x357-956
sharpen_off                     7,968   0.384%   y902-1035 x357-956
grain_off                      14,814   0.714%   y901-1051 x343-957
ocean_off                       7,978   0.385%   y902-1035 x357-956
```

**`taa_off` is 0. Every other single-pass removal leaves the artifact essentially
unchanged.** Confirmed visually as well: with TAA disabled the same region renders as clean
water, foam and wet sand.

Three further things this table says:

- **`ocean_off` changes nothing (7,978).** The corruption is *not* the water geometry. It
  survives the ocean being removed entirely, which means TAA is regenerating it from history
  and/or reprojection rather than resolving bad shading from a surface.
- **`grain_off` nearly doubles it, 7,977 -> 14,814**, and widens the box. Film grain is
  dithering roughly half the corrupt pixels off exact zero, so the true extent of the damage
  is about **0.71% of the frame**, and grain is partially *masking* the bug. Anyone who
  scanned for pure black with grain enabled would have under-counted it by half.
- **`volumetricFog_off` raises it to 12,644** for the same reason — the fog's additive
  in-scatter was lifting some corrupt pixels just above zero.

### Why this is more important than 0.4% of one frame

The likely mechanism is TAA history poisoning: a NaN entering the neighbourhood min/max
clamp propagates to the whole clamp result, and TAA then feeds its own output back as
history, so the poison is self-sustaining. That fits the evidence — it is stable frame to
frame, it survives removing the geometry underneath it, and the horizontal streaking is a
history/reprojection footprint rather than a shading one.

It is also **directly coupled to two open issues**:

- **KNOWN_ISSUES §18** — `taa.js` samples `pipe.depthTex`, which §18 establishes contains
  no world geometry at all (only the viewmodel). TAA's depth-derived reprojection is
  therefore being computed from garbage at every pixel in the build, and `shot_sky_ring`
  is a grazing-angle water horizon, exactly where a bad depth produces extreme reprojection
  vectors.
- **KNOWN_ISSUES §1 follow-up 1** — `vegetation.js` still writes motion vectors in the old
  jittered-current convention (confirmed still present this pass, see §8), which `taa.js`
  no longer compensates for. There is vegetation on the stack crowns in this pose.

I did not fix it. It is a genuine renderer bug in a pass whose correctness is entangled with
§18, not a small integration bug, and it needs the owner of `scene.js` + `taa.js`.

**Reproduce in one command:**

```bash
node tools/_blackab.mjs            # writes shots/blackab/*.png, one per pass disabled
```

---

## 8. Open follow-ups I confirmed but deliberately did not fix

Per the brief I limited myself to small, obviously-correct integration bugs. Two items from
KNOWN_ISSUES §1 are still live, and I am recording their exact state rather than touching
them, for reasons given below.

### 8a. `vegetation.js` still uses the pre-fix motion-vector convention — STILL OPEN

KNOWN_ISSUES §1 item 1 says vegetation "is still wrong and needs the same one-line change".
It has not been made. `src/world/vegetation.js:61` still documents the old contract:

> `with the *same* jittered-current / un-jittered-previous convention` scene.js `uses, so
> the compensation in` taa.js `stays valid.`

and `:384` still writes `vVegCur = gl_Position;` — the jittered clip position — with the
comment at `:2169-2171` repeating the claim. Both premises are now false: `scene.js:60` was
fixed to `uCurrViewProj = pipe.currViewProj` (un-jittered), and the `taa.js` compensation is
gated off behind `uMvLegacy`. `terrain.js:1969` uses the corrected form. **Vegetation is the
last producer on the old convention.**

Not fixed here because it is a rendering change with measurable consequences, not an
integration bug: KNOWN_ISSUES §1 itself requires it be landed with an `_mvprobe.mjs`
verification (`zeroFrac 1.0000` on static surfaces) and a `detail`/`spectrum` measurement
either side. Neither is possible while other agents are writing `src/` — I would be handing
back an unvalidated change.

### 8b. `motionBlur.js:189` still applies the removed compensation — STILL OPEN

```js
v = g1.rg + 0.5 * uJitter;
```

KNOWN_ISSUES §1 item 2 says this line "should go". Still present. Its own analysis shows the
resulting error is <= 0.16 px against a `mbMinPx = 0.60` cutoff, so it is invisible — which
is exactly why it should be removed by whoever is already measuring motion vectors, bundled
with 8a, rather than as a drive-by from me.

### 8c. Things I checked that turned out to be already fixed

- **KNOWN_ISSUES §12, structures colliders — FIXED.** `structures.js:1148` now emits the
  deck as a 14-segment chain of axis-aligned `Box3`, with a comment explaining why it took
  the segmented-AABB option over an OBB type. No
  `[warn] [physics] ignoring malformed collider` appeared in any console capture this pass.
- **KNOWN_ISSUES §11, physics init — FIXED**, `physics` initialises in 0.7 ms.
- **KNOWN_ISSUES §10, RNG program cache key — FIXED**, `programs` stable across captures.
- **KNOWN_ISSUES §20, GLSL backtick hazard — clean**, all 42 files parse.

### 8d. Why I changed no `src/` file at all

Other agents wrote `src/world/props.js`, `src/world/structures.js` and four post passes
during this session — one of those writes invalidated a determinism check mid-measurement
(§4). Editing `src/` while that is happening would corrupt their measurements exactly as
theirs corrupted mine, and I could not have validated my own change afterwards. Everything I
added is a new file under `tools/` (`_perfprobe.mjs`, `_sheetcap.mjs`, `_blackab.mjs`), which
no capture reads.

---

## 9. Summary — what to do next, in priority order

1. **KNOWN_ISSUES §18, the shared depth texture.** It now blocks `dof` entirely (§5), it is
   the most likely root of the new TAA corruption (§7), and it silently degrades `ssao`,
   `ssr`, `motionBlur` and water refraction. It has been open since Wave E and it is the
   single highest-leverage fix in the project.
2. **The `rocks` triangle regression** (§6): 2.3x triangles for +3% draw calls, 3.0x frame
   time at `shot_stack_gauntlet`, and 32 M triangles even in a sky shot. Check culling
   before anything else.
3. **`ref_01500` `detail` collapse**, 49.34 -> 9.92 at one pose (§1). Unexplained.
4. **The showcase sheet** (§2). Four of five §17 defects untouched; two poses still under the
   terrain, three cells full of mannequins, four captions unmet.
5. **The `sat_mean` / `lab_b` deficit** (§3) — but re-diagnose first. It is a tone-curve and
   colour-balance problem now, not fog.
6. **Re-band the `grade` axis** (KNOWN_ISSUES §15). Six runs, six zeroes, real progress
   invisible.

## 10. Tools added this pass

| tool | what it does |
|---|---|
| `tools/_perfprobe.mjs` | per-pose steady-state p50/p95/mean frame time with warm-up discard, plus verbatim console drain (the daemon swallows console output) |
| `tools/_sheetcap.mjs` | the twelve showcase poses in one page load, bypassing a saturated daemon; pair with `previewsheet.mjs --no-capture` |
| `tools/_blackab.mjs` | per-pass elimination sweep for the §7 black corruption, via `togglePass` |
