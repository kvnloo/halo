# Measured targets from the reference clip

Every number here was measured off `reference.mp4` with `tools/metrics.py`. They are
the objective definition of "matches the reference" for each subsystem. Hit them.

## Whole-frame signature (mean over the clip)

```
lum_mean 107.8   lum_std 52.3    p01 17   p50 105   p99 221
shadow_frac 0.050   highlight_frac 0.007
sat_mean 83.9/255   lab_a +3.2   lab_b +1.4
lap_var 463   edge_density 0.085   local_contrast 0.192
spectral_slope -2.60
```

Nothing crushes and nothing clips — a soft filmic roll-off at both ends. The colour is
a subtle warm push (`lab_a +3.2`, `lab_b +1.4`), **not** orange-and-teal.

## Per-region signature

Regions are fixed fractional crops of the frame; `tools/roi.py` extracts them from any
image, reference or render, so you can measure the part of the frame your subsystem
actually owns:

```bash
.venv/bin/python tools/roi.py shots/mine.png sand shots/mine_sand.png
.venv/bin/python tools/metrics.py --stats shots/mine_sand.png
# compare against ref/roi_signatures.json
```

| region      | lum_mean | lum_std | sat_mean | lab_a | lab_b  | **lap_var** | **edge_den** | local_con | **spectral** |
|-------------|---------:|--------:|---------:|------:|-------:|------------:|-------------:|----------:|-------------:|
| `sky`       |   120.7  |   44.9  |    87.0  |  3.35 | −15.07 |     253     |    0.037     |   0.166   |   −2.95      |
| `sky_sun`   |   106.0  |   44.2  |    85.8  |  2.69 |  −7.66 |     284     |    0.038     |   0.164   |   −2.44      |
| `horizon`   |   119.5  |   46.0  |    81.9  |  2.76 |  −9.31 |     554     |    0.073     |   0.165   |   −2.47      |
| `cliff`     |   104.9  |   45.6  |    87.5  |  2.23 |  −4.89 |     387     |    0.051     |   0.166   |   −2.39      |
| `rock`      |   118.6  |   47.4  |    86.6  |  2.82 | −11.22 |     466     |    0.061     |   0.173   |   −2.54      |
| `water`     |   114.3  |   41.0  |    69.7  |  2.31 |  −7.88 |     677     |    0.109     |   0.142   |   −2.44      |
| `shoreline` |    99.7  |   42.7  |    69.3  |  2.20 |  −4.39 |     696     |    0.127     |   0.150   |   −2.35      |
| `sand`      |   102.1  |   31.5  |    69.0  |  3.57 |  +2.83 |     521     |    0.120     |   0.101   |   −2.37      |
| `weapon`    |    79.8  |   49.4  |    73.5  |  1.89 |  +0.05 |     489     |    0.089     |   0.178   |   −2.63      |

Raw data: `ref/roi_signatures.json`.

### A caveat about regions — read this before chasing a number

Regions are **fixed screen rectangles**, not semantic masks. The `sky` crop is simply
the top-left of the frame; in most reference frames that is open sky, but in
`kf_00720` it contains the cliff, and in `kf_01500` it contains a sea stack. The
published targets are averaged over five frames, so they are a fair aim for a
*finished* scene at a matched pose — and misleading for a half-built one.

Concretely: measuring the `sky` region of a render that has a sky but no terrain
against a reference frame whose `sky` region is half cliff compares two different
things, and the delta will be dominated by the missing geometry rather than by
anything the sky module did wrong.

So:

- While your subsystem is the *only* thing in the frame, use the region measurement to
  track your own before/after, and treat the absolute delta to the reference as a
  loose upper bound, not a target.
- Only trust the absolute numbers once the scene is complete and the pose is matched.
- If a number looks alarming, **look at both crops** before believing it:
  `tools/roi.py` writes them out, and the Read tool will show them to you.

## What these numbers are telling you

**The ground is the hardest part, not the sky.** `shoreline` and `water` carry the most
high-frequency energy in the entire frame (lap_var 696 and 677, edge_density 0.127 and
0.109). A flat sand plane with a tiling normal map lands near lap_var 120. To reach 520
on `sand` you need actual geometric cobbles and pebbles, wind ripples with real relief,
scattered shell and weed debris, and wet/dry variation at multiple scales — parallax
mapping alone will not get there, and neither will a sharpen filter (it raises lap_var
while pushing spectral_slope the *wrong* way, which the metric catches).

**The sky is the smoothest thing in frame** (lap_var 253, spectral −2.95). Do not add
noise or grain to it chasing "detail". Its job is a clean gradient, a correct Mie
shoulder, and well-formed cloud silhouettes.

**Saturation splits the frame in two.** Sky and rock sit near sat 87; water, sand and
shoreline sit near 69. The grade must not apply one global saturation — the reference
has desaturated ground against a saturated sky, which is a big part of why it reads as
sunlit rather than as a filter.

**lab_b tells you where the warmth is.** Sky is strongly blue (−15), rock and horizon
are moderately blue (−9 to −11), and sand is the only warm region (+2.8). Warm bounce
light belongs on the ground and on the weapon, not everywhere.

**The weapon is dark.** `weapon` lum_mean 79.8 against a frame mean of 107.8: the
viewmodel is roughly 26% darker than the scene, with the highest local contrast in the
frame (0.178). It is a dark matte object with sharp specular breakup — not a grey prop
lit to match the background.

## Calibration: what "AAA" scores

`ref/baseline.json` records what the reference game scores **against itself** across 91
pairs of different shots. That is the honest ceiling for composition-independent axes:

```
detail    79.0 mean (p25 67.2)
geometry  88.5 mean (p25 81.0)
spectrum  97.8 mean (p25 100)
grade     48.3 mean (p75 61.0, max 98.4)
structure  0.4      <- meaningless across different compositions
perceptual 6.2      <- likewise
```

So: `detail`, `geometry` and `spectrum` above ~80/88/95 means the render carries the
same texture and edge statistics as the real game. `structure` and `perceptual` only
become meaningful once the pose-matched geometry is actually in the right place — at
that point they should climb far above the 0.4/6.2 cross-shot baseline.
