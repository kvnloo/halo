# clouds — refit against the critic's REJECT (3/100)

Owner file: `src/world/clouds.js` **only**. `src/render/passes/cloudComposite.js` was not
touched — it did not need to be (see #1).

## 1 critical — the double composite (fixed, verifiable)

`consumesClouds` was set by nobody (`grep -rn consumesClouds src/` → only clouds.js's own
two lines), so the LAYER.SKY fallback quad drew *and* `cloudComposite` composited, giving
`L*(1+T) + sky*T²` on every semi-transparent pixel. Fix taken from inside clouds.js alone:
**deleted the fallback quad**, its two shaders, `compMesh/compMat` and the
`externalComposite` gate. `cloudComposite` is now the only path and needed no edit.

Second half of the fix: `MARCH_FRAG` now takes `tDepth`/`uHasDepth`/`uNear`/`uFar`,
clamps `tOut` to scene distance and returns `rad=0, T=1` behind solid geometry, so the
half-res buffer carries the silhouettes the bilateral upsample is documented to preserve.

**Trap for the next person:** `ctx.get('pipeline')` returns the *module wrapper* from
`src/render/pipeline.js`, not the `RenderPipeline`. `pipeMod.depthTex` is `undefined`; the
real one is `pipeMod.pipe.depthTex`. My first build had `uHasDepth = 0` every frame and
the depth test silently never ran. Isolated in one step by making the shader `return` when
`uHasDepth < 0.5` — the frame came back completely cloudless, which an always-true test
cannot do.

Verification of both halves, ref_00720 `sky` ROI, `--config cloudStrength=0`:
before, the critic measured an unchanged full deck (zenith white fraction 0.508 vs 0.507).
Now: 61% of sky-ROI pixels change, max 147 codes, `p99 199 → 170`, `highlight_frac
0.0025 → 0`. The clouds genuinely switch off.
Depth termination, ref_00720 `weapon` ROI: `lap_var 700 → 178`, `lum 81.8 → 76.8` — the
cloud radiance painted over the viewmodel is gone.

## Other changes

- **#2 weather:** `baseKm 0.90→2.40`, `topKm 2.60→4.00`, `coverage 0.56→0.24`,
  `maxDistKm 118→150`. Also cut the two *hidden* coverage multipliers the critic named:
  `sampleWeather`'s second field `(0.42+1.30b)`→`(0.10+1.20b)` (its mean was 1.07, i.e. it
  added variance and removed no coverage) and the `cloudDensity` remap window 0.70→0.44.
- **#3 structure:** erosion volume `32³→64³` with its octaves doubled; `detailTileKm
  0.95→0.80` (cells 400/200/100 m, was 950/475/240 m); a **second tap of the same volume**
  at `coarseTileKm 3.20` for tower-scale bites; `lightMarch` runs the full eroded field on
  all seven taps instead of the erosion-free upper bound; `historyFrames 16→8`.
- **#5 sampling:** `step` is `stepAt(t)=clamp(0.030+0.0075t, 0.030, 0.75)`, recomputed
  every iteration, instead of `seg/96`. Erosion octaves LOD off the step length
  (`ero = 1-(step-0.055)/0.230`, coarse tap off above 0.42 km).
- **#4 darkness / tone:** ambient floor `0.12→0.07` (new `ambFloor` setting +
  `cloudAmbFloor` knob), `ambBottomScale 0.70→0.45`, `extinction 12.5→28` (12.5/km is at
  the thin end of a real cumulus and was the single biggest lever on tonal spread),
  `scatterGain 1.2→2.4` re-derived **only** against captured frames, `erode 0.42→0.32`,
  `edgeGain 12→8` (after the volume fix the same measurement flipped from 4.7× too smooth
  to 2.3× too busy), `hazeK 0.019→0.032`.
- **#6:** `uHazeColor` deleted from the uniform block and `updateAmbient`; the now-dead
  `hazeScale` setting and its `cloudHazeScale` knob deleted; header integration paragraph
  rewritten to describe the single surviving path and to record the double-composite
  algebra; the light-march / stepping paragraphs corrected.

## Measured

`sky` ROI, ref_00720, vs `ref/roi_signatures.json`:

|              | before | after  | target |
|--------------|--------|--------|--------|
| lum_mean     | 134.45 | 107.0  | 120.67 |
| sat_mean     |  32.86 |  81.5  |  87.05 |
| lab_b        |  -3.88 | -15.72 | -15.07 |
| lap_var      |  46.15 | 124.4  | 253.25 |
| edge_density | 0.0115 | 0.0157 | 0.037  |

`sky` ROI, ref_00000, vs the matched crop of `kf_00000` (this pose's crop is far less
contaminated by foreground — see caveats):

|              | before | after  | kf_00000 |
|--------------|--------|--------|----------|
| lum_std      |  43.97 |  34.0  | 47.74 |
| sat_mean     |  30.27 |  48.8  | 56.14 |
| lab_b        |  -4.14 | -10.76 | -9.70 |
| lap_var      |  52.28 | 129.4  | 145.08 |
| edge_density | 0.0174 | 0.0431 | 0.0280 |

Cloud-body-only mask, ref_00000: `lap_var 141 → 373`, `edge 0.026 → 0.089` (reference
cumulus body 135 / 0.023 under the same mask). The 17× internal-texture deficit is closed;
bodies are now, if anything, busier than the reference — `edge_density` is the number that
is over, not under, and it is the thing to pull back next.

Determinism: two settle-48 captures at ref_00000 differ **only below y=318** (live terrain
/ vegetation edits by other agents). `sky`-ROI max diff = **0**. Clouds are deterministic.

Cost: not resolvable above the noise floor. 2000-frame wall-clock A/B of the old vs new
file straddled zero (−3.0 s, +1.6 s over ~25 s). Against `--skip clouds` the whole module
measures ~0.6 ms/frame at 1080p / half-res on a 3080 Ti, ±0.3. Init cost rose (64³ instead
of 32³ volume): module init 27 ms.

## Three things the next critic needs

1. **The `sky` ROI at ref_00720 is not a sky-only crop.** In `kf_00720` its top-left is a
   large dark tan cliff. That cliff is where the target's `p01 = 24`,
   `shadow_frac = 0.0424` and much of `sat_mean = 132` come from. They are not cloud
   statistics and no cloud change can produce them. Judge clouds at ref_00000 or on a body
   mask.
2. **The cloudless renderer already exceeds the reference's zenith "cloud" fraction.**
   With the march forced to write nothing, the top-12% band measures `frac_cloud = 0.208`
   (ref_00000) / `0.232` (ref_00720) against `0.048` / `0.039` in the keyframes, and
   `sat = 62` against `95`. The ring/arch geometry and the sky module supply that floor.
   The cloud deck's own zenith contribution is now ~0.06–0.08, near the 0.15 the brief
   asked for, and `cloudCoverage 0.40 → 0.24` only moves the *total* 0.394 → 0.334.
   Attributing the whole zenith gap to clouds is wrong.
3. **`--skip` does not reach render passes**, only world modules — confirmed again here
   (`--skip cloudComposite` is inert, `--skip clouds` works). Belongs in
   `docs/KNOWN_ISSUES.md` / `tools/capture.mjs`, neither of which I own.

## Weakest thing left

`sky` `lap_var` at ref_00720 is 124 against a 253 target while `edge_density` is 0.0157
against 0.037 — coarse structure still short at that pose, and coverage is the only lever
that moves it, which trades directly against `sat_mean`/`lab_b` (both of which are now
within 6% of target). The far deck beyond ~30 km is still the weakest region visually: the
distance-driven step and the erosion LOD removed the aliased popcorn, but what replaced it
is a flat pale band with too little large-scale variation, and the `horizon` ROI is
currently unmeasurable because the terrain/ocean modules are mid-edit under it.

Helper used for all of the above: `tools/_cloudstat.py` (region / zenith / body modes).
