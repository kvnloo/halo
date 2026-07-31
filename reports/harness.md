# harness — the loop's blind spot, measured

Owned: `tools/blind.mjs`, `docs/LOOP.md`. New instruments added: `tools/nullcheck.py`,
`tools/silhouette.py`, `tools/scatter.py`.

Full write-up and the standing rules are in **`docs/LOOP.md`**. This file is the
checkpoint: numbers first, in case the session dies.

---

## 0. Headline — the best score this project has ever recorded is below its own noise floor

`tools/nullcheck.py` feeds the loop's own scorer a set of surrogates that are guaranteed
wrong, built so that they preserve exactly what the loop measures and destroy everything
else. Mean over all nine blind poses:

```
case          SCORE   roi%   struct  grade percep detail geomet spectr
mirror        54.97   55.6      5.8  100.0    6.6  100.0  100.0  100.0
blur          49.00   36.3     99.9   96.1   30.0    0.0    0.0    0.0
shuffle64     45.40   65.9      2.2  100.0    0.0   52.7   90.0   97.4
shuffle16     32.86   56.0      0.0  100.0    0.0    0.0   45.2   93.0
phase         30.33   56.0      0.6   30.0    0.0   89.9   45.2   99.7
wrongpose     29.90   39.0      0.8   34.8    3.1   53.3   68.4   91.9
OUR RENDER    29.44   59.0      3.4    1.4    7.5   76.9   80.8   94.2
noise          0.39   23.2      1.8    0.0    0.0    0.0    0.0    0.0
```

* `mirror` — the reference flipped left-to-right. Every statistic identical to machine
  precision, the scene is the mirror world. **54.97.**
* `blur` — the reference under a 4 px Gaussian. All detail destroyed. **49.00.**
* `shuffle64` — the reference cut into 64 px squares and jigsawed at random. **45.40.**
* `phase` — Fourier phase randomised, magnitude kept bit-exact. No object survives.
  **30.33.**
* `wrongpose` — a completely different keyframe of the same clip. **29.90.**
* **Our render: 29.44. Last place except for pure Gaussian noise.**

The composite ranks **every structure-destroying control above the actual build.**

### The line that matters

```
best score ever recorded (waveG)      30.30
phase-randomised reference            30.33
```

Five waves of work moved the number 22.24 → 30.30. **The entire recorded improvement
sits below the score a Fourier phase-scramble of the reference gets for free**, and the
best run in project history is 0.03 points under it. The scoreboard was never measuring
progress toward Halo; it was measuring progress toward "an image with roughly the right
power spectrum", and it topped out exactly where noise does.

### The ROI-signature gate fails the same way

Reproducing the gate a critic applies — crop the 10 named regions, compare 7 stats each
against `ref/roi_signatures.json`, count how many land within 25% relative error:

```
shuffle64   65.9%   <- a jigsaw of the reference
OUR RENDER  59.0%
phase       56.0%   <- structured noise
shuffle16   56.0%
mirror      55.6%
```

**A 64 px jigsaw of the reference passes the ROI signature gate better than our render
does.** Any subsystem ever passed on "its ROI stats match the signature" has demonstrated
only that it is in the same statistical family as a scrambled reference.

Reproduce: `.venv/bin/python tools/nullcheck.py --all --roi`  (~3.5 min, no capture needed)

### Re-run after the mid-wave `metrics.py` retune — half fixed

`metrics.py` was retuned by its owner during this wave (clipped bands → calibrated soft
curves). `nullcheck` calls `metrics.compare` rather than carrying its own copy of the
curve, so re-running audits the live code:

```
case          SCORE   roi%   struct  grade percep detail geomet spectr
mirror        61.85   55.6     24.0  100.0   16.7  100.0  100.0  100.0
blur          57.40   36.3    100.0   92.4   52.4    0.0    0.1    0.0
shuffle64     30.41   65.9     12.9  100.0    4.7    5.3   12.0   28.4
shuffle16     23.35   56.0      0.8  100.0    0.3    0.7    1.8   10.2
OUR RENDER    16.39   59.0     21.1    3.1   16.3   32.7   18.5   11.4
wrongpose     14.12   39.0     17.6   12.0   10.6   17.4   25.0    0.7
phase         12.82   56.0      7.9    7.5    1.5   35.2   12.3   42.7
noise          3.92   23.2     14.4    1.2    0.0    0.1    0.4    0.0
```

**Fixed:** the build now beats phase noise and a wrong keyframe, and every axis carries
gradient again (structure 21.1, perceptual 16.3, both previously pinned near zero).

**Not fixed:** `mirror` still scores 3.8x the build, `blur` 3.5x, `shuffle64` 1.9x.
Those surrogates preserve pixel statistics, and the scorer is still made of pixel
statistics. No retune closes that gap — only instruments that measure arrangement do.
The ROI gate is untouched by the retune and still ranks a jigsaw above the build.

Run `nullcheck` after any `metrics.py` change. Any surrogate above the build is a bug.

## 1. Why the loop cannot move — two of six axes are pinned against a rail

`metrics.py:183` maps each raw metric through `band(v, good, bad)`, clipped to [0,1].
At the current operating point:

| axis | raw | band(good, bad) | value | d(score)/d(raw) |
|---|---|---|---|---|
| grade | hist **0.889** | 0.25 → 0.75 | **clipped to 0** | **exactly 0** |
| structure | 1−ms_ssim **0.659** | 0.15 → 0.65 | **clipped to 0** | **exactly 0** |
| perceptual | lpips **0.695** | 0.25 → 0.70 | 0.011 | live but 1.1% of range |
| detail | 76.9 | | in band | live |
| geometry | 80.8 | | in band | live |
| spectrum | 94.2 | | in band | live |

The three axes that measure *whether it is the right image* are clipped or within 1% of
their floor. Their local gradient is **zero**. Whatever the declared weights say
(structure 0.22, grade 0.20, perceptual 0.26 — 68% of the composite), an optimiser
following this signal can only ever move detail, geometry and spectrum, which is exactly
what happened for five waves. This is not a weighting problem that can be tuned away;
a clipped axis contributes no gradient at any weight.

## 2. Framing is not measured at all, and it is wrong

Nothing in the loop checks that the render is even *of the same scene*. At `ref_01500`
the reference is two large sea stacks filling the frame over a broad dry sand foreground;
our render at the same camera is an all-water plane with five small distant stacks and
about ten characters standing in the shallows. Composition, subject scale and ground
material are all different — and the loop scores that pose **29.40**, above its own
nine-pose average. MS-SSIM sees it (3.4/100) and is outvoted by three axes that are
happy because there is *some* detail *somewhere*.

## 3. New instruments — what they catch that no mean can

### `tools/silhouette.py` — T1 (decided 7 of 9 pairs)

Segments objects against the sky and describes the **outline**, not the pixels inside it.
The separating descriptor is `undercut`: the largest fractional re-widening that occurs
*below* a local minimum of the half-width profile. A monotone taper — a truncated cone
with a straight batter, which is what we build — returns ~1.0 by construction. Wave-cut
erosion returns 6–8.

```
pose      undercut ref   undercut render      overhang ref  render
01500          8.46            0.99                1.34    1.02
00450          7.75            0.99                1.42    1.02
02220          6.73            1.81                1.69    1.10
00000          6.16            4.31                1.73    1.11
```

Consistent, large, and in the same direction on every pose. `tools/roi.py` +
`metrics.py --stats` on the same crops report nothing at all about this.

Segmentation note: three approaches were tried and two failed outright (sky flood-fill
leaks across the sky→sea→sand gradient and claims 99.5% of the frame; per-column
gradient skyline fires on cloud edges and on reference film grain). Otsu-in-box with the
darker class as subject is the one that produced clean masks on both images. Documented
in the file, with its one assumption: subjects darker than their background.

`tools/scatter.py` — T2, size distribution and spacing of the cobble field. See §4 of
`docs/LOOP.md`.

## 4. `tools/blind.mjs` — made cheap enough to run every wave

Was: build 9 sheets, judge 9 images by hand, paste a score string. Nine Read calls and a
final-ceremony ritual, run once in project history.

Now:
* `--contact` builds **one** sheet containing every pair, so judging is one Read call.
* `--capture` runs the capture itself; `node tools/blind.mjs --capture --contact` is the
  whole loop in one command.
* `--auto` runs a machine discriminator over the pair and reports **separability**: how
  far our render sits from the reference on descriptors that the reference's own
  frame-to-frame variation calibrates. This is an honest one-way instrument — it can
  prove we would lose, it can never prove we would win — and that asymmetry is stated in
  `docs/LOOP.md` rather than buried.
* Results append to `scores/blind.jsonl` so the only honest number the project has is
  finally a trend and not a one-off.

Measured, `shots/blindcap` (wave H build):

```
separability 5.69      every pose 5.03 – 9.85
detectable features per pose  5.8 of 37
top tells  sil.sky_frac 4.99   stat.local_contrast 4.48   stat.lum_std 4.42
           sct.shoreline.size_cv 2.59   sil.overhang 2.13   sil.undercut 2.03
```

Consistent with the 9/9 human loss. `scores/blind.jsonl` now carries both the backfilled
wave-H human result and this auto result.

## 5. Instrument acceptance — the new tools were tested against the same controls

`nullcheck.py --instruments` reports each new descriptor's response to every surrogate.
Pass condition has two halves: large response to phase/shuffle/noise, and **near-zero
response to `mirror`**, because mirroring preserves shape and a shape descriptor that
moves on mirror is measuring position. At `kf_01500`, |delta| relative to the
descriptor's value on the reference:

```
             taper_r2  monoton  reversl undercut overhang convex_d  rough_D
mirror           0.00     0.00     0.00     0.00     0.00     0.00     0.00   <- correct
phase           18.73     0.01     0.18     0.80     0.22     0.09     0.03
shuffle64       12.15     0.18     0.07     0.87     0.19     0.29     0.00
wrongpose       13.14     0.12     0.78     0.88     0.26     0.94     0.02
OUR RENDER       0.64     0.23     0.21     0.88     0.24     0.19     0.02
```

The silhouette descriptors return **exactly 0.00 on mirror** — they measure form, not
position. `taper_r2` rejects every structureless surrogate by 12–19x.

**Honest limitation, recorded rather than hidden:** `undercut` moves ~0.8–0.9 for phase,
shuffle, noise *and* our render alike. It is a one-sided detector — high proves erosion,
low means "extrusion **or** garbage". It fails an extrusion; it can never certify a
shape. Stated in `docs/LOOP.md` §2.

The `scatter` descriptors' mirror test is confounded: they run on a fixed ROI crop, so
mirroring swaps which part of the beach is inside it. `tile_peak` moving 1.09 on mirror
is a crop artifact, not an instrument failure — but it does mean scatter descriptors are
only comparable between frames at the same pose.

## 6. Cost — this is why it can now run every wave

| instrument | cost | needs a capture? | needs a judge? |
|---|---|---|---|
| `blind.mjs --auto` | **8 s** (26 s with calibration rebuild) | no | no |
| `silhouette.py --pair-pose` | 0.3 s | no | no |
| `scatter.py --pair-pose` | 0.4 s | no | no |
| `nullcheck.py --all --roi` | 3.5 min | no | no |
| `blind.mjs --capture --contact` | capture + ~10 s | yes | **3 looks** (was 9) |
| `score.mjs` (old composite) | minutes, LPIPS-bound | yes | no |

The human blind test used to be nine full-resolution sheets, so nine image reads and a
ceremony. It is now three paged contact sheets at ~1600 px, 3.4–3.8 MB each, verified
decisive at that resolution — every tell in `reports/blind.md` is legible on the page.

## 7. The standing rule (full text in `docs/LOOP.md`)

> A subsystem is not done because its means match. Means are the one thing a scrambled
> reference reproduces perfectly. Before any instrument is trusted, it must be shown to
> reject the `nullcheck` controls; before any subsystem is passed, it must be shown to
> beat them.
