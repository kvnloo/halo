# Scoreboard audit — all six axes

**Owner:** metrics agent (`tools/metrics.py`, `tools/score.mjs`)
**Date:** 2026-07-31 (second pass)
**Status:** LANDED.

> **Sections 1–8 are the first pass and two of their numbers are now retracted.** Read
> **§9–§14** first. In short: the first pass re-banded `1 − MS-SSIM` and made it the
> highest-weighted axis, and §9 shows that axis is won by rendering *nothing* — a flat grey
> rectangle beats every render this project has ever produced, and blurring our own frame
> is worth +14 composite points. `structure` is now measured with GMSM instead. §10 retracts
> the first pass's `good` anchors: they were not reproducible by the command this report
> told you to run. §11 retracts §6.1 — run-to-run noise is not "unmeasured", it is exactly
> zero, and that is now proven from the archive.

---

## 0. Headline

`grade` was not the broken axis. It was the only *obviously* broken one.

**Every axis is railed, and 43% of all readings on the current build are pinned at 0 or 100.**
Per-pose axes for `waveH` (the current head), 9 poses x 6 axes = 54 readings:

```
pose        struct  grade  percep  detail   geom  spect
ref_00000        0   0.00    8.97   100.0   89.3   97.2
ref_00120        0   1.47   11.64   100.0   96.5   79.0
ref_00450        0   0.55   17.21    96.0   90.7  100.0
ref_00600    30.81   5.49   14.19     1.7   23.0   95.7
ref_00720        0   0.00    0.00    74.8   68.1  100.0
ref_00840        0   0.00    0.00    94.9  100.0   99.7
ref_01500        0   5.07    8.76    63.5   96.8   85.8
ref_01800        0   0.00    2.78    95.3  100.0  100.0
ref_02220        0   0.03    4.04    65.6   63.0   90.0

readings at exactly 0 or exactly 100:  23 / 54  = 43%
structure  = 0 at 8 of 9 poses
grade      < 6 at 9 of 9 poses, exactly 0 at 4
perceptual = 0 at 2 of 9
detail     = 100 at 3 of 9
geometry   = 100 at 3 of 9
spectrum   = 100 at 3 of 9
```

A reading at a rail has **zero derivative**. Eight of nine poses could improve their
composition and `structure` would not move. Three of nine poses could double their texture
detail, or halve it, and `detail` would not move. The composite is the weighted sum of three
axes stuck on the floor and three stuck on the ceiling.

---

## 1. Two silent faults found before any re-banding

### 1a. `lpips` failure is indistinguishable from a good `perceptual` score

`metrics.py:110`

```python
def lpips_score(a, b):
    try:
        m, dev, torch = _lpips_model()
    except Exception as e:
        return None
```

and `metrics.py:187`

```python
'perceptual': band(res['lpips'] if res['lpips'] is not None else 0.6, 0.25, 0.70),
```

If torch or the LPIPS weights fail to load for **any** reason, the axis silently reports
`band(0.6) = 22.2` — a fabricated number, higher than any value this project has ever
genuinely scored on that axis (best real: 9.49). No warning, no null, no non-zero exit.

This is not hypothetical. It fired on me today. The shared scratchpad contains another
agent's `profile.py`; any python run with that directory on `sys.path` shadows the stdlib
`profile` module, which breaks `torch._dynamo`'s `import cProfile`, which breaks
`torchvision`, which breaks `lpips`:

```
AttributeError: module 'profile' has no attribute 'run' (consider renaming
'.../scratchpad/profile.py' since it has the same name as the standard library module
named 'profile')
```

My first calibration run produced `lpips: None` for all 217 pairs and I only caught it
because I was storing raw values. A scored run in the same conditions would have printed
`perceptual: 22.2` and been believed. **Fix: an axis that cannot be computed must report
`null` and a `warnings` entry, never a default.**

### 1b. `grad_hist` is computed on every comparison and used by nothing

`gradient_hist_distance()` runs on every pair (Sobel + 36-bin orientation histogram over the
full frame) and lands in the JSON, but no axis reads it, `score.mjs` does not carry it in
`raw`, and no report has ever quoted it. Either promote it or stop paying for it.

---

## 2. The raw trend and the reported trend disagree

Raw values, read straight out of `scores/*.json` — these are means over the same 9 poses,
so they are directly comparable across waves:

| tag     | ms_ssim | hist  | lpips | lap_ratio | edge_ratio | reported SCORE |
|---------|--------:|------:|------:|----------:|-----------:|---------------:|
| latest  |  0.3405 | 0.8892| 0.6954|     0.757 |      0.689 |          22.24 |
| waveE   |  0.3545 | 0.8020| 0.6813|     0.986 |      0.891 |          28.62 |
| waveF   |  0.3485 | 0.7934| 0.6599|     0.793 |      1.033 |          30.09 |
| waveG   |  0.3427 | 0.7876| 0.6620|     0.841 |      1.058 |          30.30 |
| waveH   |  0.3145 | 0.7540| 0.6724|     1.360 |      1.413 |          29.44 |

Three things the scoreboard did not say:

1. **`hist` improved monotonically, every single wave, 0.889 -> 0.754.** The `grade` axis
   reported `0.00` for four of those five runs (KNOWN_ISSUES 15). This is the only axis with
   a clean monotone improvement across the whole project and it was invisible.
2. **`ms_ssim` peaked at waveE and has fallen every wave since**, 0.3545 -> 0.3145, an 11%
   regression in the one axis that measures whether the right thing is in the right place.
   The composite rose 28.62 -> 30.30 across that same span.
3. **`lap_ratio` and `edge_ratio` crossed 1.0 and kept going** — mean 0.99 -> 1.36 and
   0.89 -> 1.41. `detail` and `geometry` barely moved: 75.2 -> 76.9 and 79.4 -> 80.8.

### 2a. A correction to my own reading of point 3 — the stored `raw` means are the wrong aggregate

My first pass read `raw.lap_ratio` 0.986 (waveE) -> 1.360 (waveH) as "went from near-perfect
detail density to 36% over-textured, and the axis did not notice". That is wrong, and it is
wrong in a way worth recording, because it is the *same* mistake the axis makes.

Per-pose `lap_ratio`:

```
waveE   0.64 0.63 0.75 [2.54] 0.81 1.18 0.67 1.13 0.53    mean 0.986   median |ln| 0.397
waveH   0.91 1.05 1.21 [3.26] 1.51 1.23 0.59 0.82 1.67    mean 1.360   median |ln| 0.204
```

waveE's "near-perfect" 0.986 is an artifact: **eight of its nine poses are under-detailed
(0.53–1.18) and one pose, `ref_00600`, sits at 2.54** and drags the mean back to 1.0. The
mean of a set of ratios is not a measure of agreement — a frame at 0.5 and a frame at 2.0
average to 1.25 and neither one matches anything. On the correct aggregate (median absolute
log-ratio, which is what agreement actually means) waveH is a **real improvement**, 0.397 ->
0.204, and the old axis's +1.7 points understated it rather than overstating it.

So point 3 is retracted as evidence of "rewards texture". The axes *are* blind to placement
(§3a proves that with a known answer), but this particular number was not the proof — the
stored aggregate was. `score.mjs` now records `raw.detail` and `raw.geometry` as the mean
per-pose log-deviation alongside the legacy mean-of-ratios, so the misleading aggregate is no
longer the only one on file.

**One thing falls out of that table that is not about metrics at all:** at `ref_00600`, the
look-up-at-the-sky pose, our render carries **2.5x (waveE) and 3.3x (waveH)** the reference's
Laplacian energy. `docs/TARGETS.md` says in as many words that the sky is the smoothest thing
in the frame and must not have noise added to it chasing detail. That pose is the single
worst detail outlier in every run recorded, and it is getting worse. Whoever owns sky/clouds
should see this.

---

## 3. Why every band was wrong — the calibration nobody ran

The six bands were hand-picked constants. I measured what they should have been, using only
the reference clip compared against itself, so nothing here is a property of anything this
engine renders (the KNOWN_ISSUES 4 rule):

* **`good`** — median over the 158 pairs of *adjacent* keyframes (`kf_X` vs `kf_X+15`).
  This is how close the real game gets to its own next frame. It is the practical ceiling.
* **`null`** — median over 91 pairs of keyframes at least 20 apart. This is what
  "no relationship at all" measures, in the same units.

| axis | raw distance | old `good` | measured `good` | old `bad` | measured `null` | verdict |
|---|---|---:|---:|---:|---:|---|
| `structure`  | `1 − MS-SSIM`      | 0.15 | **0.524** | 0.65 | **0.718** | `good` demands better than the source achieves against itself |
| `perceptual` | `LPIPS`            | 0.25 | **0.481** | 0.70 | **0.697** | same fault; `bad` happens to be right |
| `grade`      | `hist` †           | 0.25 | 0.234 ✓  | 0.75 | **0.545** | `bad` set 0.21 *beyond* "no relationship" — and our operating point is 0.75 |
| `detail`     | `\|ln lap_ratio\|`  | 0.15 | **0.054** | 1.20 | **0.412** | both anchors ~3x too loose |
| `geometry`   | `\|ln edge_ratio\|` | 0.15 | **0.021** | 1.20 | **0.242** | `good` 7x loose, `bad` 5x loose |
| `spectrum`   | `\|Δslope\|`        | 0.15 | **0.027** | 1.00 | **0.090** | `good` 5x loose, `bad` 11x loose |

† the `grade` row is measured against the **legacy** `hist`, because that is what the old band
was banding; figures are means over the same pair sets. The five other rows are medians, which
is what `CALIB` uses. `grade` is now banded against `hist_smooth` instead — §4a explains why,
and its anchors are 0.131 / 0.442.

Read as one statement: **the two comparative axes were banded to a standard the reference
itself cannot meet, and the three composition-independent axes were banded five times looser
than the reference's own frame-to-frame variation.** That is the entire mechanism. It is not
six unrelated mistakes, it is one missing calibration step, and it produced exactly the
symptom the project has been living with — a floor and a ceiling, with the composite riding
the ceiling.

`grade` is the third case: its `bad` anchor landed, by coincidence, within 0.004 of this
project's actual `hist`. KNOWN_ISSUES 15 called that correctly.

### 3a. What the old scoreboard scores when you feed it known answers

I scored the reference clip against deliberately damaged copies of itself. Every row below
is the **old** banding and the **old** weights — this is what the project has been steering
by, given inputs whose correct answer is known:

| what was scored | old SCORE | old `grade` |
|---|---:|---:|
| `hue30` — the reference, hue-rotated 30°, catastrophically wrong colour | **79.55** | **0.0** |
| `near15` — the real game vs its own next frame | 75.12 | 92.8 |
| `shift64` — the reference, translated 64 px sideways | 72.22 | 100.0 |
| `cross` — an unrelated shot of the real game | 35.48 | 41.7 |
| `waveG` — our best run ever recorded | 30.30 | 0.0 |
| `waveH` — current head | 29.44 | 1.4 |

Four things fall out of that table, and each of them is fatal on its own:

1. **A frame with its colour destroyed outscores the real game compared with itself**
   (79.55 vs 75.12). Hue rotation leaves structure, detail, edges and spectrum untouched, and
   those carry 0.52 of the old weight, so wrecking the grade costs almost nothing.
2. **`grade` gives the hue-rotated frame and our render the same score: 0.0.** The axis
   cannot separate "our colour" from "the reference rotated 30° in hue". That is not a
   dead readout, it is a readout that cannot distinguish any two failures of any size.
3. **An unrelated shot of Halo scores 35.48 — higher than every run this project has ever
   recorded.** The whole 22 -> 30 improvement happened *below the metric's own null*. A run
   scoring 30 is not "38% of the way there"; it is behind the score you get by pointing the
   camera at a completely different part of the level.
4. **`shift64` scores 72.22.** The right image, 64 px out of place, keeps `detail 100`,
   `geometry 100`, `spectrum 100` and `grade 100`. This is the "rewards having texture, not
   having the *right* texture" hypothesis from the brief, demonstrated with a known answer:
   four of six axes are exactly, provably blind to whether anything is in the right place.

### 3b. Is any axis actually distinguishing our render from Halo?

`d'` between our per-pose values and the 91 cross-pairs, plus the fraction of our poses that
land inside the cross p10–p90 band:

| raw metric | ours (waveH) | cross | d' | ours inside cross band |
|---|---:|---:|---:|---:|
| `hist`      | 0.754 | 0.545 | **3.01** | **0%** |
| `ms_ssim`   | 0.315 | 0.280 | 0.60 | 89% |
| `Δslope`    | 0.182 | 0.125 | 0.57 | 78% |
| `lpips`     | 0.672 | 0.690 | 0.45 | 78% |
| `lap_dev`   | 0.375 | 0.487 | 0.30 | 78% |
| `edge_dev`  | 0.334 | 0.309 | 0.09 | 78% |
| `grad_hist` | 0.086 | 0.087 | 0.05 | 78% |

**Exactly one of the six axes separates our render from an unrelated frame of the real game
with any confidence, and it is `grade` — the one that has reported 0.00 since the project
began.** Every other axis overlaps the null by 78–89%.

The ordering the brief asked for, measured (medians):

| | `1−MS-SSIM` | `hist_smooth` | `LPIPS` | `\|ln lap\|` | `\|ln edge\|` | `\|Δslope\|` |
|---|---:|---:|---:|---:|---:|---:|
| identity | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| near15 (adjacent kf) | 0.524 | 0.131 | 0.481 | 0.054 | 0.021 | 0.027 |
| near60 | 0.589 | — | 0.562 | 0.384 | 0.263 | 0.064 |
| near300 | 0.674 | — | 0.669 | 0.645 | 0.396 | 0.118 |
| cross (unrelated shot) | 0.718 | 0.442 | 0.697 | 0.412 | 0.242 | 0.090 |
| **ours (waveH)** | **0.685** | **0.625** | **0.672** | **0.375** | **0.334** | **0.182** |

Our pose-matched render sits **between `near300` and `cross`** on structure and perceptual —
i.e. rendering the correct camera pose buys us about as much similarity as looking at a
reference frame five seconds later in the clip. On `grade`, `geometry` and `spectrum` we are
*past* the null: further from our own reference frame than two unrelated shots of Halo are
from each other.

**The brief's expected ordering is wrong for half the axes, and I should say so.** It asked
for "a reference frame vs a *different* reference frame should score high but not perfect;
ours should score lower." That holds for `detail`, `geometry` and `spectrum`, which are
composition-independent. It is backwards for `structure` and `perceptual`: two different
compositions *must* score near zero on MS-SSIM and LPIPS, and `ref/baseline.json` already
recorded that (0.44 and 6.2). `cross` is not a high-water mark for those axes, it is their
null — which is precisely what makes it the right thing to anchor them against.

---

## 4. The fix

### 4a. `hist` is not a grade metric — `hist_smooth` is

Before re-banding `grade`, I checked whether the underlying number was worth banding. It is
not. Measured on the reference against damaged copies of itself:

| what was compared | `hist` (32³ HSV Bhattacharyya) | `hist_smooth` |
|---|---:|---:|
| identical | 0.000 | 0.000 |
| **`hue2` — 2° hue rotation, invisible** | **0.278** | 0.100 |
| `near15` — the game vs its own next frame | 0.236 | 0.131 |
| `hue5` — 5° rotation | 0.561 | 0.231 |
| `cross` — unrelated shot | 0.510 | 0.400 |
| `hue30` | 0.944 | 0.875 |
| ours (waveH) | 0.747 | 0.625 |

(medians over 5 poses and a 40-pair `cross` subsample, so both columns see identical inputs;
the shipped `grade` anchors use the full 158/91 pairs and come out 0.131 / 0.442.)

`hist` calls a **2-degree hue rotation** (0.278) a bigger colour difference than two genuinely
different keyframes of the clip (0.236), and calls a 5-degree rotation (0.561) a bigger
difference than an unrelated shot (0.510). The cause is bin quantisation: 32 hue bins over
180° is 5.6°/bin, so a shift smaller than one bin moves most of the mass across a hard edge
and the Bhattacharyya overlap collapses. The metric is close to a binary detector, and no
choice of band could have rescued it.

Smoothing the joint histogram by one bin (hue axis wrapped) before comparing fixes it:
`hist_smooth` is monotone in hue rotation, saturation scale and gamma, and correctly ranks an
invisible 2° shift *below* the clip's own frame-to-frame variation. `grade` is now banded
against `hist_smooth`; `hist` is still computed and still in `raw`, unbanded, so five waves of
history remain readable.

Measured on our own runs, `hist_smooth` shows the same clean monotone improvement the legacy
`hist` did — the colour work of the last five waves is real:

```
latest 0.8073   waveE 0.6849   waveF 0.6709   waveG 0.6645   waveH 0.6245
```

### 4b. Bands that cannot rail

```
s(v) = 100 / (1 + (v / u50) ** p)      p = ln(81) / ln(null/good)
                                       u50 = good * 9 ** (1/p)
```

Exactly 100 when the frames are identical, asymptotic to 0, and **never equal to either
anywhere else**. The old linear band clipped, which is why 23 of 54 readings had zero
derivative. Under this band no pose can ever be arithmetically incapable of improving.

| axis | `good` (→90) | `null` (→10) | `u50` | `p` |
|---|---:|---:|---:|---:|
| structure  | 0.52386 | 0.71764 | 0.61314 | 13.96 |
| grade      | 0.13133 | 0.44230 | 0.24101 | 3.62 |
| perceptual | 0.48136 | 0.69674 | 0.57912 | 11.88 |
| detail     | 0.05413 | 0.41217 | 0.14937 | 2.16 |
| geometry   | 0.02077 | 0.24224 | 0.07092 | 1.79 |
| spectrum   | 0.02726 | 0.09003 | 0.04954 | 3.68 |

`p ≈ 14` on `structure` and `≈ 12` on `perceptual` is not a tuning choice, it is the
measurement: MS-SSIM's entire usable range between "the real game's adjacent frames" (0.524)
and "two unrelated shots" (0.718) is **0.19 wide**, so the axis has to be high-gain to be
readable at all. That narrowness is itself worth knowing — it means small MS-SSIM movements
are large real movements, and the old band, which spread 0.15→0.65 over that same 0..100,
was compressing a 0.19-wide signal into 38 points of a scale it then clipped.

Regenerate the whole table from the reference clip with:

```bash
.venv/bin/python tools/metrics.py --calibrate ref/keyframes
```

### 4c. `progress` — the number to actually tune against

The 0..100 axes are a dashboard. For steering, `compare()` now also emits `progress`:

```
progress = 100 * (null - v) / (null - good)
```

signed, linear, unbounded. `0` = no closer than an unrelated shot of Halo. `100` = as close
as the game's own adjacent frames. Negative = worse than an unrelated shot. Because it is
linear in the raw distance its derivative is constant, so an improvement is worth the same
number of points wherever you are standing — which is exactly the property `grade` lacked.

### 4d. Weights

```
structure .25   grade .22   perceptual .23   |   detail .12   geometry .10   spectrum .08
                       comparative = 0.70
```

was `structure .22  grade .20  perceptual .26 | detail .12  geometry .12  spectrum .08`
(comparative 0.68 nominally — but with three of those axes pinned at 0 the *effective*
comparative weight was near zero, and the composite was in practice a readout of
detail+geometry+spectrum alone).

`score_comparative` is now also reported: the same three comparative axes, renormalised, with
the composition-independent axes removed entirely. If `score` and `score_comparative` diverge,
the run gained on texture statistics rather than on looking like Halo.

`score_geometric` is also reported: the same axes as a weighted **geometric** mean. It
collapses if any single axis does, so it cannot be raised by improving five axes while
destroying the sixth. Measured on the acceptance cases:

| case | `score` (arithmetic) | `score_geometric` |
|---|---:|---:|
| `hue30` — right image, colour destroyed | 77.7 | **36.1** |
| `shift64` — right image, 64 px out of place | 91.6 | 91.0 |
| `near15` | 82.2 | 81.5 |
| `cross` | 17.7 | 15.0 |
| ours (waveH) | 19.8 | 14.4 |

It is deliberately **not** the headline number. A composite dominated by its worst axis
would steer the loop at `grade`, and `reports/blind.md` ranks the grade (T11) last of the
eleven things worth fixing — "the cheapest item on the list but also the least valuable".
Read it as a guard instead: if `score` rises and `score_geometric` does not, the gain came
from axes that were already the strong ones.

### 4e. Two silent-failure fixes

* `lpips` failure now yields `axes.perceptual = null` plus a `warnings` entry that
  `score.mjs` prints to stderr. The 0.6 default is gone.
* `score.mjs` means are now computed over the poses where a value exists, and yield `null`
  when none do. A missing measurement can no longer arrive as a 0, which is a score.

---

## 5. The corrected history

`--rescore` measures PNGs already on disk without capturing, so every run whose shots
survive could be re-measured under both bandings from the same pixels:

```bash
node tools/score.mjs --rescore shots/waveE --tag rescore_waveE   # does not touch history.jsonl
```

**Backward-compatibility proof.** `score_legacy` reproduces the recorded score to the
decimal for every run whose PNGs are untouched — waveE **28.62**, waveF **30.09**,
waveG **30.30**, waveH **29.44**, identical to `scores/history.jsonl`. The re-banding is
therefore a pure re-read of the same measurements, not a different measurement.
(`latest` comes out 23.38 against a recorded 22.24: `shots/latest/` has been overwritten by
later agents, so those are no longer the pixels that produced the 22.24. Treat that row as
approximate.)

### 5a. Reported trend vs corrected trend

```
tag         NEW    cmp   geom  legacy  recorded      struct  grade  percep  detail  geomet  spectr
latest    15.55  14.54   5.64   23.38     22.24       29.04   1.38   11.36   27.07   12.43   11.00
waveE     18.67  17.10   9.71   28.62     28.62       32.91   2.33   14.04   21.17   24.18   21.75
waveF     18.22  17.83   8.96   30.09     30.09       29.66   2.35   19.78   25.58   24.50    2.75
waveG     18.88  16.89   9.06   30.30     30.30       27.63   2.43   19.06   37.32   24.83    1.17
waveH     16.39  13.86   8.39   29.44     29.44       21.10   3.07   16.33   32.74   18.45   11.36
```

**The scoreboard reported +7.2 from `latest` to waveH and +0.8 across waves E→H. Corrected,
the project gained +3.1 at waveE and has given 2.3 of it back since: 18.67 → 16.39.**

The brief's hypothesis was "it is entirely possible we have been flat for five waves". It is
worse than flat. On the comparative composite — the three axes that can tell whether we
rendered *Halo* — waveH (13.86) sits **below where waveE stood three waves earlier** (17.10),
and below `latest` on structure.

### 5b. Per-axis, in `progress` (the linear readout)

```
tag        struct    grade   percep   detail   geomet   spectr
latest       30.3   -113.5      2.6    -31.6   -132.1   -353.4
waveE        37.2    -76.4      7.2      1.3    -43.6    -70.1
waveF        34.1    -75.7     17.1      4.6     10.2   -317.1
waveG        31.2    -73.7     16.1     15.6      7.3   -274.2
waveH        16.6    -60.1     11.3     10.3    -41.5   -146.1
```

* **`structure` has fallen every wave since waveE: 37.2 → 34.1 → 31.2 → 16.6.** waveH alone
  gave up 14.6 points, the largest single-wave regression in the recorded history. The old
  scoreboard rendered that as `5.13 → 3.42` — a 1.7-point wobble, indistinguishable from noise.
* **`grade` is the only axis that improved every single wave: −113.5 → −60.1, +53.4 points.**
  It was reported as `0.00` in four of those five runs. Five waves of real colour work were
  invisible to the instrument the project steers by.
* **`geometry` swung +142 then −49 in a single wave.** waveH's edge density went from matched
  to worse-than-an-unrelated-frame.
* `perceptual` peaked at waveF and has fallen since.
* `spectrum` is noise: −353, −70, −317, −274, −146. See §6.

**waveH in one line:** grade +13.6, structure −14.6, geometry −48.8, perceptual −4.8. It was
recorded as a −0.86 dip that read as measurement noise. It was the worst wave since the metric
began, on the axes that matter.

### 5c. Does the corrected number agree with the blind gate?

`reports/blind.md`: **9 losses out of 9**, every one decided on a technical tell within
seconds. A scoreboard consistent with that should place us far below the reference and near
the "no relationship" null. Measured, through the shipped `compare()`:

```
identity                                  100.00     the reference against itself
shift64  (right image, 64 px out of place) 91.65     what a small pose-fit error costs
near15   (the game vs its own next frame)  82.13
hue30    (right image, colour destroyed)   77.67     (geometric: 36.11)
near300  (5 s later in the clip)           22.90
ours     (waveH)                           19.84
cross    (an unrelated shot of Halo)       17.72
```

(The `cross` row here is a 5-pair subsample so it can share poses with the others; on the full
91 pairs it is **17.7 new / 35.5 legacy**, which is the figure quoted in §3a.)

Our render lands between "an unrelated shot of the real game" and "the same shot five seconds
later". **A composite of 16–20 is consistent with losing 9-0. A composite of 29.4 on a scale
where an unrelated frame scores 35.5 never was.**

Note also that the new scale ranks `shift64` (91.7) above `hue30` (77.7); the old one had them
the other way round (72.2 vs 79.6), i.e. it preferred a frame with its colour destroyed over a
perfect frame with a sub-degree pose error. Given KNOWN_ISSUES 3 — the poses are unfitted — that
was the wrong tolerance to have.

### 5c-bis. It is already earning its keep

Another agent ran captures through the new `score.mjs` while I was writing this, and the
first thing it caught was the failure mode described above, live:

```
tag                     NEW   legacy   struct  grade  percep  detail  geomet  spectr
waveI-posefit             -    24.29      8.2    1.7    11.4    55.4    56.5    72.5
waveI-fitstand        16.85    30.15     24.2    2.9    17.6    37.2    13.8     3.4
```

`waveI-posefit` reads as a **−5.15 disaster** on the legacy scale (29.44 → 24.29) — and its
`structure` went **3.4 → 8.2**, the largest structural gain in the project's history, because
someone finally fitted the poses. The legacy composite scored that as a large loss, because
`detail` and `geometry` fell from their saturated 77/81 to 55/57 and those two carried 0.24 of
the weight against `structure`'s effectively-zero. Under the new banding the same work reads
`structure 24.2` and the composite goes *up*.

That is the exact failure the brief described — "a run can gain 8 points while looking no more
like Halo" — running in reverse: a run that genuinely looked more like Halo lost 5 points.

### 5d. What actually changed in the composite

| | old | new |
|---|---:|---:|
| share of waveH's composite from `structure`+`grade`+`perceptual` | **10%** | **59%** |
| share from `detail`+`geometry`+`spectrum` | **90%** | **41%** |
| per-pose axis readings pinned at exactly 0 or 100 | **23 of 54 (43%)** | **0 of 216 (0%)** |

The weights barely moved (comparative 0.68 → 0.70). Almost all of that shift is the banding:
with three comparative axes clipped to zero, their *nominal* 0.68 of weight was contributing
2.99 points of a 29.44 composite. The project has been steered by texture statistics for five
waves not because the weights said so, but because the other three axes were arithmetically
incapable of contributing.

---

## 6. What is still weak — read this before trusting the new number either

1. **`spectrum` is the noisiest axis in the suite and I have not fixed it.** Its raw
   `|Δslope|` swung 0.134 → 0.289 → 0.262 → 0.182 across three waves with no matching change
   in intent, and the reference's own null band is only 0.027–0.090 wide, so the axis spends
   most of its time past the null. It carries 0.08, about ±1.5 composite points of pure
   volatility. I left the weight alone rather than tune it without evidence. **The measurement
   that would settle it does not exist:** nobody has ever run the same build twice and recorded
   the run-to-run spread of any axis. Until someone does, no single-wave composite delta under
   about 2 points should be believed — mine included.
2. **`structure`'s band has `p ≈ 14`.** That is the honest fit — MS-SSIM's whole usable range
   here is 0.19 wide — but it makes the axis high-gain, and with (1) unmeasured, a 3-point move
   may be real or may be settle noise. `progress` is the safer readout; it is linear.
3. **The composite still gives `hue30` 77.7.** Five of six axes are genuinely indifferent to
   colour and no weighting fixes that; only `score_geometric` does (36.1). If the project ever
   wants one number that cannot be gamed, that is the one — with the caveat in §4d.
4. **`grad_hist` is still computed and still unused.** Measured `d' = 0.05` against unrelated
   Halo frames — the weakest discriminator in the suite. It should be deleted, not promoted. I
   left it in `raw` rather than remove a function other tools import.
5. **The anchors come from one reference clip** — medians over 158 adjacent and 91 distant
   pairs of it. Stable, but they describe *this* clip. `--calibrate` regenerates them.
6. **`--rescore` writes `sbs_*.png` into the directory it reads.** Harmless, but re-scoring
   someone else's shot dir touches their files.

---

## 7. Documents that are now wrong, owned by someone else

I own only `tools/metrics.py` and `tools/score.mjs`. These need an edit from their owners:

* **`docs/ARCHITECTURE.md`** (~line 187) — the axis table quotes the old bands and sets floors
  of `structure > 45`, `grade > 65`, `perceptual > 45`, `detail > 80`, `geometry > 85`,
  `spectrum > 92`. All wrong under the new banding. The measured equivalent of "as good as the
  real game against its own next frame" is `structure 86, grade 78, perceptual 90, detail 92,
  geometry 73, spectrum 55`.
* **`docs/TARGETS.md` §"Calibration: what AAA scores"** — "detail, geometry and spectrum above
  ~80/88/95 means the render carries the same texture and edge statistics as the real game" is
  the exact belief this audit disproves; those numbers came from bands 3–11x looser than the
  reference's own frame-to-frame variation. `ref/baseline.json` should be regenerated — its
  `axes_mean` block is in old-band units.
* **`docs/KNOWN_ISSUES.md` §15** — the diagnosis was right and the axis is fixed, but the entry
  should record that `hist` itself was the deeper fault, not only its band.

---

## 8. Reproducing all of it

```bash
node tools/parsecheck.mjs                                     # green: 42 files
.venv/bin/python tools/metrics.py --calibrate ref/keyframes   # regenerates the CALIB block
node tools/score.mjs --rescore shots/waveE --tag rescore_waveE
node tools/score.mjs --history                                # both scales, side by side
```

Calibration harness (pair classes, degradation ladder, acceptance test):
`scratchpad/mx/{collect,analyse,gradetest,calib,design,accept}.py`.


---
---

# SECOND PASS — 2026-07-31

The brief for this pass was "land the re-banding". I landed it, then tried to break it, and
it broke. Sections 9–11 are corrections to my own previous wave. Section 12 onward is the
delivery.

## 9. The re-banded `structure` axis is won by rendering nothing

`structure` was `1 − MS-SSIM`, and the first pass gave it the largest weight in the
composite (0.25) on the grounds that it is one of the three axes that can tell whether we
rendered *Halo*. Before trusting that, I fed it two inputs whose correct answer is not in
doubt: our own render progressively Gaussian-blurred, and a **flat grey rectangle** of the
reference's mean luminance. Means over the nine scored poses:

```
                            1-MS_SSIM   structure   progress      GMSM   lap_ratio
FLAT grey rectangle            0.4950       95.21     +114.9    0.2935      0.000
ungraded (earliest build)      0.5099       92.92     +107.2    0.2845      0.036
waveH blurred, kernel 61       0.5667       75.02      +77.9    0.2208      0.005
waveH blurred, kernel 31       0.5999       57.58      +60.8    0.2119      0.005
waveH blurred, kernel 15       0.6314       39.91      +44.5    0.2169      0.008
waveH blurred, kernel  7       0.6546       28.61      +32.5    0.2301      0.029
waveH blurred, kernel  3       0.6764       22.12      +24.1    0.2419      0.156
waveH  (our current head)      0.6855       17.40      +16.6    0.2476      1.360
the game vs its own next kf    0.4455       98.85     +140.4    0.1649      0.994
```

Read the first column downward. **A flat grey rectangle scores `1 − MS-SSIM = 0.495`, which
is better than the 0.524 `good` anchor the first pass took from the real game compared with
its own next frame.** The axis was calibrated over a range whose "as good as the source
footage" end is reachable by drawing a single colour.

And it is not a corner case you have to construct. Blurring our actual render raises the
banded axis **monotonically, 17.4 → 75.0**, which at weight 0.25 is about **+14 composite
points for destroying the image** — more than the entire recorded improvement of the project.
The earliest build in `shots/` (`ungraded`, an untextured grey blob, `lap_ratio` 0.036)
scores `structure` 92.9 against the current head's 17.4.

This is exactly the failure the brief asked me to eliminate — "a run must not be able to gain
points while looking no more like Halo" — and my own first pass made it *worse*, because it
raised this axis's weight from 0.22 to 0.25 and made its band responsive precisely in the
region blurring moves through. The legacy band had the same defect (`ungraded` legacy
`structure` 28 vs waveH 3.4); it was only masked because legacy weighted texture heavily
enough that the blob lost on `detail`/`geometry` instead.

**Cause.** SSIM's structure term is `s = (σxy + C3) / (σx·σy + C3)`. As the test frame's
local variance `σy → 0`, both numerator and denominator go to `C3` and `s → 1`: a frame with
no structure scores full marks for structure it does not have. I tried the obvious repair
first — pooling the SSIM map weighted by the *reference's* local variance, so a region can
only earn credit in proportion to how much structure was there to match. **It does not
work**: variance-weighted MS-SSIM still rises under blur (0.1779 → 0.2404) and still puts the
flat frame top (0.2661). The fault is in the term's value, not in the pooling.

**Fix.** `structure` is now banded against **GMSM** = `1 − mean(GMS)`, the Gradient Magnitude
Similarity of Xue et al. (2014), 12 lines of numpy in `gms_distance()`. It has no degenerate
term: where the reference has gradient and the test has none, `(2·m·0 + T)/(m² + 0 + T) → 0`.
The `GMSM` column above is the same ladder re-measured, and it puts the flat rectangle and
the untextured build **last**, which is where they belong:

```
best -> worst   near15 0.165 < shift64 0.195 < blur31 0.212 < blur15 0.217 < blur61 0.221
              < blur7 0.230 < waveI 0.238 < waveH 0.248 < ungraded 0.285 < FLAT 0.294
```

GMSM still improves slightly under a moderate blur (waveH 0.248 → 0.212 at kernel 31), and
that is **not** a residual exploit — it is the correct reading. Our render is genuinely
over-textured (`lap_ratio` 1.36, `edge_ratio` 1.41), so removing some high-frequency energy
really does move its gradient statistics toward Halo's. The tell is that the curve turns
around again at kernel 61, and never approaches `near15`. MS-SSIM's curve never turned
around: it improved all the way to a blank frame.

`ms_ssim` is still computed, still in `raw`, still what `score_legacy` bands, so no history
is lost — the same treatment `hist` got in §4a.

## 10. The first pass's `good` anchors were not reproducible — retraction

§8 of the first pass says the whole `CALIB` table regenerates from

```bash
.venv/bin/python tools/metrics.py --calibrate ref/keyframes
```

It does not. Running that command reproduces every `null` anchor to five decimals and **no
`good` anchor at all**. Two causes, both real:

1. **`ref/keyframes/` is a shared directory and the glob was `kf_*.png`.** On 2026-07-30
   another agent saved two 357x1018 crops there, `kf_00450_sand.png` and
   `kf_01500_sand.png`. They sort in between real keyframes, so four of the "adjacent
   keyframe" pairs that *define what good means for every axis* were a full frame compared
   against a crop of a different aspect ratio. `calibrate()` now accepts only
   `kf_<digits>.png` at the modal resolution, prints what it ignored, and prints how many
   keyframes at what size it actually used.
2. The remaining gap is larger than the crops can explain, and an independent measurement
   settles which side is right. Measured directly at the nine scored poses, the real game
   against its own next keyframe gives `perceptual` 0.392, `detail` 0.075, `geometry` 0.043.
   The re-run `--calibrate` gives 0.391 / 0.075 / 0.049. The first pass shipped
   0.481 / 0.054 / 0.021. **The shipped anchors were wrong and the command was right.**

Whatever produced the first pass's `good` column, it was not the documented command, and the
harness that might have said what it was (`scratchpad/mx/`) no longer exists. That is the
lesson worth keeping: *a calibration constant that cannot be regenerated by a command in the
repo is a hand-picked constant with a citation, which is the exact thing §3 was written to
condemn.* The block in `metrics.py` is now the verbatim stdout of the documented command.

Final anchors — 157 keyframes, 156 adjacent pairs, 91 cross pairs:

| axis | raw distance | `good` (→90) | `null` (→10) | `u50` | `p` |
|---|---|---:|---:|---:|---:|
| structure  | `1 − mean GMS`      | 0.18411 | 0.26578 | 0.22121 | 11.97 |
| grade      | `hist_smooth`       | 0.08404 | 0.44554 | 0.19351 | 2.63 |
| perceptual | `LPIPS`             | 0.39080 | 0.69240 | 0.52018 | 7.68 |
| detail     | `\|ln lap_ratio\|`  | 0.07518 | 0.42218 | 0.17815 | 2.55 |
| geometry   | `\|ln edge_ratio\|` | 0.04907 | 0.25820 | 0.11256 | 2.65 |
| spectrum   | `\|Δslope\|`        | 0.01607 | 0.08823 | 0.03765 | 2.58 |

## 11. Run-to-run noise is not unmeasured. It is zero. — retraction of §6.1

§6.1 said "nobody has ever run the same build twice and recorded the run-to-run spread of
any axis… no single-wave composite delta under about 2 points should be believed — mine
included." That was wrong, and the measurement was already sitting in `shots/`.

`waveH` and `waveI-prefit` are **two independent captures two hours apart** — different
tags, different history rows, and different measured performance (187 fps / 5.36 ms versus
109 fps / 9.15 ms), so they are genuinely separate GPU runs and not a copied directory.
Their frames are **byte-identical on all 9 of 9 poses**. `waveE` / `waveE-fix` are a second
such pair: 9 of 9 byte-identical.

```
waveH  vs waveI-prefit    9/9 byte-identical   (fps 187 vs 109 -> separate captures)
waveE  vs waveE-fix       9/9 byte-identical
waveG  vs waveG-mvfix     0/9 byte-identical   composite delta 0.00, lum_mean delta 0.0001
waveG  vs waveG-settle96  0/9 byte-identical   composite delta 0.52, lum_mean delta 2.89
```

**The capture path is bit-deterministic, so the measurement noise floor of every axis is
exactly 0.000.** A composite delta of any size is signal. The `waveG`/`waveG-mvfix` row is
the useful upper bound on *near*-repeats: a change that altered every pixel in the frame
moved the composite by less than 0.01.

The real uncertainty is not run-to-run, it is **pose sampling** — the composite is a mean
over nine poses that differ from each other far more than any wave has moved the score.
That is quantified per run in §13, and it is large: roughly ±4 points at 95%. Two runs
measured on the *same* nine poses are still exactly comparable (this is a paired
comparison), but a run measured on a different pose set is not comparable at all, which is
what §12 now enforces.

One thing falls out of the table that is not about metrics: **`waveG-settle96` is not noise.**
Doubling the settle count moved `lum_mean` by 2.89 levels and the composite by 0.52. The
scene is still converging at the default `--settle 48`. Whoever owns capture should know
that runs taken at different settle counts are not comparable, and that the default is not
converged.

## 12. The remaining fail-open, closed

`tools/preflight.mjs:68` documents this one and could not fix it, because that agent does not
own `score.mjs`:

> `score.mjs` prints "missing reference" and *continues*, then averages over whatever
> survived and writes the row to history.jsonl with a smaller `n`, and nothing downstream
> notices.

It now does notice. `score.mjs` tracks every pose that failed to measure, and any axis that
came back `null` on any pose, and on either condition it

* adds an explicit warning naming the poses and saying in words that the composite is a mean
  over the survivors and **is not comparable to a full run**,
* writes `incomplete: true` and `n_expected` into both `scores/<tag>.json` and the
  `history.jsonl` row,
* marks the row `!` in `--history` and **excludes it from the trend, the delta and the
  best-run line**,
* and **exits non-zero**. The JSON still goes to stdout, so nothing that wants the partial
  result loses it; it just has to acknowledge the status.

Also fixed: `--rescore` used to write its `sbs_*.png` side-by-sides into the directory it was
reading, i.e. into another agent's shot directory while they were working in it (§6.6). It
now writes them to `shots/_rescore_<tag>/`. A re-measurement no longer modifies what it
measures.

### 12a. A cross-run race that silently swapped one pose's measurement

This one bit me live while I was writing §13, which is the only reason I found it.

`shots/waveF` scored **19.91** once and **20.08** on every re-run afterwards, from pixels
whose mtimes were two days old and a metric I then proved is bit-exact across repeats
(`lpips`, `gmsm` and `hist_smooth` all had zero spread over five consecutive calls). Eight of
the nine poses agreed exactly between the two runs. Only `ref_00000` differed — 14.22 versus
15.69.

The cause is one line. `score.mjs` handed each per-pose measurement to `metrics.py --json`
at a **fixed path with no tag and no pid in it**:

```js
'--json', `scores/_tmp_${pose}.json`      // every run, every tag, the same file
```

Several agents run this repo's tooling concurrently. Two runs measuring the same pose name —
and every run measures `ref_00000` — write and read the same file, so one process can read
back the *other* process's frame and average it into its own composite. It does not error, it
does not warn, and the number it produces is entirely plausible. That is precisely the class
of fault this whole report is about, sitting in the tool that produces the report's numbers.

Fixed: per-pose measurements now go to `scores/.tmp-<pid>/`, which is removed at the end of
the run, and every file is checked on read — if the `tag` or `test` field inside it is not
the pose that was requested, the pose is marked failed rather than averaged in. Verified by
running two `--rescore` jobs concurrently against different shot directories: both returned
their own correct composite (20.08 and 17.56) and left no temp directory behind.

**How much of the history this corrupted is unknowable** — it depends on who happened to be
running what, and nothing recorded it. Every number in §13 was re-measured after this fix and
each of the five rescore artifacts on disk now reproduces on repeat runs.

### 12b. Scores from different bandings can no longer be plotted as one series

`metrics.py` now stamps `band_version` on every comparison and `score.mjs` carries it into
`scores/<tag>.json` and `history.jsonl`. `--history` shows a composite **only** for rows at
the current version and prints the rest as legacy-only, with a line saying so. `score.mjs`
also asserts its own expected version against what `metrics.py` reports and exits 5 if they
differ, so the two cannot drift apart silently.

This was not theoretical either: `waveI-fitstand` and `waveI-handstand` were scored under the
first pass and sat in `--history` showing **16.85**, while the same pixels measure **18.85**
and **18.60** under the shipped bands. Two runs of the same build under two bandings are two
different quantities sharing a name and a 0–100 range, and the trend line was happily
connecting them.

Bump `BAND_VERSION` in `metrics.py` (and the matching constant in `score.mjs`) on any change
to `CALIB`, `WEIGHTS`, or an axis's underlying raw metric.

## 13. The corrected history — we have been flat, and now I can prove it

Every surviving shot directory re-measured from its own pixels under the final bands. `NEW`
is the composite, `cmp` the comparative-only composite, `geom` the geometric guard, `legacy`
the pre-2026-07-31 scale. The `95% CI` is a bootstrap over the nine poses.

```
tag                 NEW        95% CI    cmp   geom  legacy    struct  grade percep detail geomet spectr
ungraded           6.67    [1.7,15.5]   9.50   1.52   12.02      15.1    2.5   10.0    0.1    0.0    0.2
base_full          6.48    [1.7,14.8]   9.21   1.65   11.72      15.2    2.6    9.0    0.1    0.0    0.2
latest            16.82   [11.9,22.0]  15.80   6.92   23.38      32.6    2.4   10.3   29.7   13.8   10.1
waveE             19.32   [14.4,24.3]  17.31  10.79   28.62      34.5    3.6   11.7   24.8   28.1   17.8
waveF             20.08   [14.8,25.4]  18.73  11.02   30.09      35.7    3.6   14.8   29.9   31.7    2.6
waveG             19.94   [14.8,25.2]  16.89  10.75   30.30      30.8    3.7   14.4   40.8   30.8    1.8
waveG-settle96    19.84   [14.4,25.3]  16.68  10.41   29.78      30.6    3.6   14.1   42.3   29.9    1.2
waveH             17.56   [13.9,21.0]  14.21   9.95   29.44      24.0    4.3   13.0   37.0   23.7   10.0
waveI-posefit     18.50   [15.3,21.8]  16.13  10.53   29.70      28.7    4.3   13.8   34.1   20.4   13.4
waveI-fitstand    18.85   [14.6,23.3]  16.90  10.90   30.15      31.1    4.2   13.6   40.1   19.2    3.5
waveI-handstand   18.60   [14.2,22.6]  15.90  10.64   29.89      28.2    4.3   13.6   39.9   23.0    4.8
```

`ungraded` and `base_full` are the two earliest builds in `shots/` — an untextured grey
world, `lap_ratio` 0.036. **Under the first pass's MS-SSIM banding they scored 24.06 and
23.52, above the current head's 16.39.** They now score 6.67 and 6.48. That single row is
the clearest evidence the §9 fix was necessary and that it works.

**Backward-compatibility.** `score_legacy` reproduces the recorded score exactly for **10 of
12** runs (waveE 28.62, waveE-fix 28.62, waveF 30.09, waveG 30.30, waveG-mvfix 30.30,
waveG-settle96 29.78, waveH 29.44, waveI-prefit 29.44, waveI-fitstand 30.15,
waveI-handstand 29.89). The two that do not are `latest` (23.38 vs 22.24) and
`waveI-posefit` (29.70 vs 24.29), and in both cases the shot directory was **written to
after the run was scored** — 17:02 and 01:57 respectively, both later than their history
rows. Those are no longer the pixels that produced the recorded numbers. `shotcheck.mjs`
already warns against reusing a tag directory; this is what it looks like when you do.
Everything else is a pure re-read of the same measurements.

### 13a. Not one wave in the project's history is distinguishable from zero

Paired per-pose deltas — consecutive runs are measured on the *same* nine poses, so this is
the correct statistic, and it is far tighter than differencing the level CIs above:

```
transition                           d SCORE            95% CI    d cmp  d legacy
latest -> waveE                        +2.51     [-2.37,+6.93]    +1.51     +5.25
waveE -> waveF                         +0.76     [-5.51,+6.86]    +1.41     +1.47
waveF -> waveG                         -0.14     [-0.46,+0.15]    -1.83     +0.21
waveG -> waveH                         -2.37     [-7.96,+3.14]    -2.68     -0.86
waveH -> waveI-posefit                 +0.93     [-2.42,+4.19]    +1.92     +0.26
waveI-posefit -> waveI-fitstand        +0.35     [-1.89,+2.36]    +0.76     +0.45

latest -> waveI-fitstand               +2.03     [-3.02,+7.83]  cmp +1.10   legacy +6.77
waveF   -> waveI-fitstand              -1.23     [-5.86,+2.99]  cmp -1.83   legacy +0.06
```

**Every interval contains zero.** The brief asked me to say it plainly if we have been flat,
so: **we have been flat.** Across the entire recorded history the composite has moved
+2.03 points with a 95% interval of [−3.02, +7.83], and on the comparative composite — the
three axes that can tell whether we rendered *Halo* — **+1.10**. The legacy scoreboard
reported +6.77 over the same pixels. Since waveF, four waves ago, the comparative composite
is **down 1.83**.

The one interval that excludes nothing by a wide margin, `waveF -> waveG` at
[−0.46, +0.15], is not a precise measurement of a real improvement — it is two runs that
barely differ (per-pose sd 0.49 against 7–10 elsewhere), i.e. waveG changed almost nothing.

### 13b. The binding constraint is nine poses, not the banding

The per-pose standard deviation of a wave-to-wave delta is **6.54** points (median over the
six transitions). That fixes the instrument's resolution, and §11 already established that
the other candidate noise source — re-capture — is exactly zero, so this is the whole of it:

```
smallest composite delta 9 poses can resolve at 95%:   4.27 points
poses needed to resolve a 5-point wave:   7
poses needed to resolve a 3-point wave:  18
poses needed to resolve a 2-point wave:  41
poses needed to resolve a 1-point wave: 164        we score 9
```

**No wave in this project's history has ever been large enough for nine poses to detect.**
This is now the single biggest limitation of the scoreboard, and it is not a banding problem
— re-banding cannot buy resolution. It is a sampling problem with a cheap fix: `ref/keyframes`
holds **157** usable keyframes and we score against 9 of them. Scoring 30 would take the
detectable wave from 4.3 points to 2.3 for about 3.3x the capture time. That is the highest-
value change available to this harness and it belongs to whoever owns `src/world/poses.js`
and `tools/capture.mjs`, not to me.

Until then the honest reading of any single wave is: **if it moved the composite by less
than ~4 points, the scoreboard did not measure anything.** Use `progress` per axis and the
blind A/B gate, which decided 9 of 9 within seconds and is a far more powerful instrument
than this one.

## 14. Acceptance — does the suite order known answers correctly?

The brief's sanity check, plus the adversarial cases. Means over the nine scored poses
(`cross` over 40 unrelated keyframe pairs):

```
case          NEW    cmp   geom  legacy    struct  grade percep detail geomet spectr
identity   100.00 100.00 100.00  100.00     100.0  100.0  100.0  100.0  100.0  100.0
shift64     85.04  79.60  83.21   69.63      72.4  100.0   67.9   99.7   99.9   92.0
hue30       78.46  70.25  51.82   80.03     100.0    5.3  100.0   99.7   99.3   92.5
near15      73.71  71.38  69.59   75.12      75.8   68.9   68.9   85.7   86.5   60.1
near300     18.82  17.98  15.57   37.00      20.2   18.4   15.1   25.1   25.2    8.9
ours (waveI-fitstand)  18.85  16.90  10.90  30.15
cross       15.18  11.36  10.43   34.84      11.4   12.6   10.1   24.8   27.6   18.6
```

The ordering the brief asked for holds: **identity 100 > a different reference frame 73.7 >
ours 18.9**, and the legacy scale got the last comparison backwards — it put an *unrelated
shot of Halo* at 34.84, above every run this project has ever recorded.

Read the two numbers that matter together: **our best run scores 18.85 where an unrelated
shot of the real game scores 15.18 and the game against its own next frame scores 73.71.**
On that scale we are about **6% of the way** from "no relationship" to "the source footage".
That is a scoreboard consistent with losing the blind gate 9–0. A composite of 30 on a scale
where an unrelated frame scored 35 never was.

**One case the composite still gets wrong, and it cannot be fixed by weighting.** `hue30` —
the reference with its colour destroyed by a 30° hue rotation — scores 78.46, above `near15`
at 73.71. Five of the six axes are genuinely indifferent to colour, so no assignment of
weights across them can fix it. `score_geometric` does: **51.82 vs 69.59**, correctly
ordered, because it collapses when any single axis does. That is what it is for. It is still
not the headline number, for the reason in §4d.

### 14a. Rails

```
                     readings at exactly 0 or 100 (per pose, per axis)
legacy bands              431 / 918   (47%)
new bands                   4 / 918   (0.4%)
```

The four are `geometry` at three poses and `detail` at one, all reading `100.0`, and **none
of them is clipped**: `soft_band` is asymptotic and reaches 100 only at a raw distance of
exactly 0. Those poses have `edge_ratio` within a whisker of 1.000, so the true value is
99.99+ and it rounds to 100.0 at the two decimal places the JSON stores. The derivative is
non-zero everywhere. It is a display artefact, not a rail — but it is worth knowing that
"100.0" in the output does not mean the axis has stopped responding, which is exactly what
it used to mean.

## 15. What is still weak

1. **Nine poses cannot resolve any wave this project has ever produced (§13b).** This is now
   the limiting fault of the scoreboard and I cannot fix it from `metrics.py`.
2. **`spectrum` is still the noisiest axis** and still spends most of its time past the null
   (`progress` −129 at waveH). It carries 0.08. I have again left the weight alone rather
   than tune it without evidence.
3. **`hue30` still scores 78.5 on the headline composite (§14).** Only `score_geometric`
   catches it.
4. **The anchors describe one reference clip**, 157 keyframes of it. `--calibrate`
   regenerates them and now reports exactly which files it used and at what resolution.
5. **`grad_hist` is still computed and still unused** (`d'` = 0.05, the weakest discriminator
   measured). Left in `raw` only because `tools/_posefit_metrics.py` copied it.
6. **`--calibrate` takes ~8 minutes** (249 pairs x LPIPS). It is not in any gate.
7. **`structure` still improves slightly under a moderate blur** (§9). I argued that reading
   is correct because our render is over-textured, but it is an assumption, not a proof, and
   it is the obvious place to attack this axis next.

## 16. Reproducing the second pass

```bash
node tools/preflight.mjs && node tools/parsecheck.mjs
.venv/bin/python tools/metrics.py --calibrate ref/keyframes   # prints the shipped CALIB
node tools/score.mjs --rescore shots/waveH --tag rescore_waveH
node tools/score.mjs --history
```
