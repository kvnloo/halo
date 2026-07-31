# The validation loop — what it can see, what it cannot, and the standing rules

This document exists because the loop passed subsystem after subsystem while the build
lost a blind A/B against the real game **9 pairs out of 9**. That is not a tuning
problem. It is an instrument problem, and this is the audit.

Read `reports/blind.md` first — it is the ground truth this document is calibrated
against. Read `reports/harness.md` for the raw numbers behind §1.

---

## 0. The one-paragraph version

The composite score is built from six axes. Three of them (detail, geometry, spectrum)
measure **whether there is stuff in the frame**. Three of them (structure, grade,
perceptual) measure **whether it is the right stuff** — and all three were clipped
against their floors for the entire project, so they contributed exactly zero gradient.
Five waves of work were therefore steered by three axes that cannot tell Halo from
detailed noise. Measured directly: a Fourier phase-scramble of the reference scores
**30.33** on that loop, and the best score in project history is **30.30** — the whole
recorded 22 → 30 improvement sits below the score that noise gets for free.

A retune of `metrics.py` landed mid-wave and fixed the clipping. It did **not** fix the
underlying problem: a mirrored, blurred or jigsawed reference still outscores the build
by 1.9x to 3.8x. See §1.

---

## 1. The audit: feed the loop things that are known to be wrong

`tools/nullcheck.py` builds surrogates that preserve exactly what the loop measures and
destroy everything else, then runs the loop's own scorer on them. It calls
`metrics.compare` rather than carrying its own copy of the scoring curve, so it audits
whatever is actually running. Mean over all nine blind poses, under the scorer as it
stood at the start of this wave:

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

### Re-run against the retuned scorer — half fixed, half not

`tools/metrics.py` was retuned by its owner during this same wave (hard clipped bands
replaced with calibrated soft curves keyed on a measured null). Re-running the identical
audit against the live code:

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

**Fixed:** the build now scores above phase noise (16.39 vs 12.82) and above a wrong
keyframe. The retune did real work and the axes carry gradient again.

**Not fixed:** `mirror` still scores **3.8x** the build, `blur` **3.5x**, and a 64 px
jigsaw of the reference still scores **1.9x**. The scorer still prefers a destroyed
reference to a real render, because those surrogates keep the pixel statistics and the
scorer is still made of pixel statistics. Retuning the curve cannot fix that; only
adding instruments that measure arrangement can, which is what §2 does.

Run `nullcheck` again after **any** change to `metrics.py`. Any surrogate scoring above
the build is a live bug in the scorer, not a curiosity.

* **mirror** — the reference flipped left-to-right. Statistically identical to the
  reference to machine precision; the scene is the mirror world. **54.97.**
* **blur** — the reference under a 4 px Gaussian. Every detail destroyed. **49.00.**
* **shuffle64** — the reference cut into 64 px squares and jigsawed at random. **45.40.**
* **phase** — Fourier phase randomised, magnitude kept bit-exact, so the power spectrum
  and all first/second-order statistics are preserved and no object survives. **30.33.**
* **wrongpose** — a different keyframe of the same clip entirely. **29.90.**
* **our render — 29.44, last place except for pure Gaussian noise.**

The composite ranks **every** structure-destroying control above the actual build.

And the ROI signature gate — the thing critics used to pass subsystems — behaves the
same way. Cropping the ten named regions and counting how many of seven stats land
within 25% of `ref/roi_signatures.json`:

```
shuffle64   65.9%      <- a jigsaw of the reference
OUR RENDER  59.0%
phase       56.0%      <- structured noise
```

**A jigsaw of the reference passes the ROI signature gate better than our render does.**
Every "this subsystem matches the signature" verdict in `reports/` means only that the
subsystem is in the same statistical family as a scrambled reference.

Reproduce: `.venv/bin/python tools/nullcheck.py --all --roi` (~3.5 min, no capture).

### Why the loop could not move — the mechanism, now partly repaired

This was the state at the start of the wave: `metrics.py` mapped each raw metric through
`band(v, good, bad)` clipped to `[0,1]`, and at the operating point the result was:

| axis | raw value | band | result | local gradient |
|---|---|---|---|---|
| grade | hist **0.889** | 0.25 → 0.75 | **clipped to 0** | **exactly zero** |
| structure | 1−ms_ssim **0.659** | 0.15 → 0.65 | **clipped to 0** | **exactly zero** |
| perceptual | lpips **0.695** | 0.25 → 0.70 | 0.011 | live, 1.1% of range |
| detail / geometry / spectrum | | | 77 / 81 / 94 | live |

The declared weights give structure + grade + perceptual **68%** of the composite. It
did not matter. A clipped axis has zero derivative at any weight, so an optimiser
following this signal could only ever move detail, geometry and spectrum. That is
exactly what five waves did. `grade` read **0.00 in every run ever recorded** — that was
not a hard axis, it was a dead one, and a dead axis should have been treated as a broken
instrument on day one rather than as a standing to-do.

The soft-curve retune has restored gradient to all six axes (structure 21.1, perceptual
16.3 on the live scorer where both were pinned near 0). The lesson survives the fix, and
it is rule 3 below: **a metric that reports the same value every run is not a hard
target, it is a broken instrument.** Nobody noticed for five waves because nobody ever
fed the scorer an input whose correct answer was known.

### And nothing checks that it is even the same scene

At `ref_01500` the reference is two large sea stacks over a broad dry sand foreground.
Our render at the same camera is an all-water plane with five small distant stacks and
about ten characters standing in the shallows. Different composition, different subject
scale, different ground material. The loop scores that pose **29.40 — above its own
nine-pose average.** MS-SSIM sees it (3.4/100) and is outvoted by three axes that are
satisfied because there is *some* detail *somewhere*.

---

## 2. Instrument-by-instrument: what each one can and cannot see

### `tools/metrics.py` — six axes, ~20 s/pose (LPIPS dominates)

| CAN see | CANNOT see |
|---|---|
| gross exposure and colour cast | whether an object has the right shape |
| how much high-frequency energy exists | where anything is |
| whether the spectrum is natural-ish | whether a subsystem rendered at all, if another one fills the same region |
| a total blur or a total noise field | a size distribution, a spacing, a silhouette |

**Failure mode to know:** `lap_var` and `edge_density` are counts of detail, not
judgements of it. A sharpen filter, a noise overlay and a correctly-modelled rock all
raise them. `TARGETS.md` warns about the sharpen case; the same warning applies to
*every* way of adding energy, including adding the wrong geometry.

**MS-SSIM is the only axis in this file that ever saw the real problem, and it has been
pinned at 3/100 while the composite went up.** If you read one number from `score.mjs`,
read `axes.structure` — and read it as a raw metric, not as a component of the mean.

### `ref/roi_signatures.json` + `tools/roi.py` — ROI means, ~1 s

| CAN see | CANNOT see |
|---|---|
| a region that is far too dark, too bright, too flat or too saturated | anything whatsoever about arrangement |
| a subsystem contributing nothing at all to a region | shape, distribution, repetition, contact, depth |

Three further limitations, all load-bearing:

1. **The regions are fixed screen rectangles, not semantic masks.** `TARGETS.md` says
   this; it is worse than it sounds. In a frame that looks up at the sky, the `sand`
   crop contains sky, and the published `sand` target is still what gets compared.
2. **The published signature is a mean over five frames.** It is a mean of means. A
   render can hit it while matching no individual frame.
3. **It has no tolerance model.** Nobody ever defined how close is close, so "matches
   the signature" has meant whatever the reader wanted. At the 25% used above, a jigsaw
   beats us.

### `tools/silhouette.py` — shape, ~0.3 s/pair — NEW

Built for T1 ("rock silhouettes are extrusions, not erosion", decided 7 of 9 pairs).
Segments objects against the sky and describes the **outline**, not the pixels inside it.

```
pose      undercut ref   undercut render     overhang ref   render
01500          8.46            0.99               1.34      1.02
00450          7.75            0.99               1.42      1.02
02220          6.73            1.81               1.69      1.10
00000          6.16            4.31               1.73      1.11
```

`undercut` is the largest fractional re-widening that occurs *below* a local minimum of
the half-width profile — the sea-notch. A monotone taper, which is what we build, cannot
produce a value above ~1 by construction. Wave-cut erosion returns 6–8. Same direction,
large margin, every pose.

| CAN see | CANNOT see |
|---|---|
| undercuts, overhangs, fracture concavity, contour roughness | anything brighter than its background (Otsu, darker class) |
| a horizontal tonal break inside an object (`vert_break`, the wet/dry band) | which object is which — it ranks by area, so a foreground change reorders it |
| that the whole object population has the wrong form | scenes with no sky in shot |

**One-sided.** A high `undercut` proves erosion; a low one means "extrusion **or**
garbage". Verified: phase-noise also scores low. Use it to fail an extrusion, never to
certify a shape.

Segmentation is Otsu-in-box, darker class as subject. Two other approaches were tried
and failed on these exact frames — sky flood-fill leaks through the sky→sea→sand
gradient and claims 99.5% of the frame; per-column gradient skyline fires on cloud edges
and on reference film grain. Stated in the file so the assumption can be checked.

### `tools/scatter.py` — distributions, ~0.4 s/pair — NEW

Built for T2 ("identical cobbles at one size mode with constant spacing", decided 5 of 9).
Detects discrete elements (band-pass + watershed, so a wetness gradient cannot create or
destroy them) and describes the **population**.

```
region sand          tile_peak ref    tile_peak render
ref_00000                 0.262            0.473
ref_00840                 0.193            0.501
ref_01500                 0.252            0.418
```

`tile_peak` — the strongest off-origin autocorrelation peak — is roughly **double** the
reference on every pose. That is "it tiles visibly", as a number. `size_slope`
(power-law tail), `size_cv`, `nn_cv` and `clark_evans` (regular vs clustered spacing)
are the size-distribution and spacing descriptors T2 named; they point the right way but
with smaller margins, so treat `tile_peak` as the headline and the rest as supporting.

| CAN see | CANNOT see |
|---|---|
| repetition, clone fields, one-size-mode scatter, lattice spacing | whether individual elements are the right *shape* |
| missing fines and missing boulders in the size tail | anything outside its fixed ROI crop |

### `tools/discriminate.py` — machine blind test, ~8 s (26 s with calibration) — NEW

Expresses every feature in units of **the reference clip's own frame-to-frame
variation**: the same features are measured across ~20 reference keyframes and a robust
sigma (1.4826 × MAD) is taken per feature, so

```
z = |f(render, pose) − f(reference, pose)| / sigma(reference clip)
```

reads as "our render differs from this reference frame by z times as much as reference
frames differ from each other". Current build:

```
separability 5.69      every pose 5.0 – 9.9
detectable features per pose 5.8 of 37
top tells: sil.sky_frac 4.99, stat.local_contrast 4.48, stat.lum_std 4.42,
           sct.shoreline.size_cv 2.59, sil.overhang 2.13, sil.undercut 2.03
```

**This instrument is one-way and that is not a limitation to be fixed, it is what it is
for.** A high z proves a human would separate the pair. A low z proves *nothing*: it
says only that these 37 features stopped catching us, while the reference frames differ
from each other in a hundred ways none of them measure. Use it to fail fast between
human blind tests. Never quote it as a pass.

### `tools/blind.mjs` — the human blind test, the only ground truth

Everything else in this list is a proxy that was chosen because it was easy to compute.
This is the only instrument that has ever been right, and until this wave it was run
once, at the end, after five waves of proxy-chasing.

---

## 3. What is invisible to ALL of the above

Be explicit about the hole, because tells keep landing in it:

* **Contact and grounding (T3, decided 6 of 9).** Nothing measures the darkening
  gradient where an object meets the ground. Every instrument here would score a scene
  where every object floats 5 cm above its shadow exactly as it scores a correct one.
  *This is the highest-value missing instrument.*
* **Aerial perspective (T9, global).** No instrument relates saturation or local
  contrast to depth. A frame with no haze gradient and a frame with a correct one have
  the same global means by construction.
* **Material identity (T4, T6, T10).** "Is this untextured flat-shaded plastic" is not
  measured anywhere. Flat albedo at the right mean luminance is invisible.
* **Translucency and light transport (T5, T7, T8).** Opaque cotton clouds vs clouds with
  silver linings; paper foam vs aerated foam; a decal planet vs one behind atmosphere.
  All are "the right colour on average".
* **Framing, placement and subject scale.** No instrument asks whether the render is of
  the same scene. See §1, `ref_01500`.
* **Absence.** A subsystem that draws zero pixels does not fail any instrument here — it
  just shifts the means slightly. This has already happened twice (`props` drew nothing
  in any full-scene frame; the bridge is absent at `ref_02220`) and neither was caught
  by the loop. `node tools/parsecheck.mjs` catches only the parse-failure flavour.

---

## 4. Running the loop — what to do every wave

```bash
node tools/parsecheck.mjs                        # green or nothing else is valid
node tools/blind.mjs --auto                      #  8 s  — did anything get worse?
.venv/bin/python tools/silhouette.py --pair-pose 01500
.venv/bin/python tools/scatter.py  --pair-pose 00000 --region sand
node tools/score.mjs --tag waveX                 # the old composite, as a log only

# once per wave, and it now costs three looks, not nine:
node tools/blind.mjs --capture --contact
#   read shots/blind/contact_1..3.png, write the picks down, THEN:
node tools/blind.mjs --score "ref_00000=A,ref_00120=B,..."
node tools/blind.mjs --history
```

What changed in `tools/blind.mjs` to make that affordable:

* `--contact` builds paged contact sheets (3 pairs per page, ~1600 px wide) instead of
  nine full sheets. Judging is 3 looks. Per-pose sheets are still written for detail work.
* `--capture` runs `parsecheck` and the capture itself and **refuses to build a blind
  test if parsecheck fails or the capture reports `failedModules`** — a blind test with a
  subsystem silently missing is not a fair fight, and this project has lost a whole
  review to exactly that.
* `--auto` is the cheap machine pass described above.
* Side assignment is `node:crypto` per run. It used to be `sha256(render bytes) & 1` in
  `sbs.py --blind` — deterministic and recomputable by any agent standing in the repo.
  It was unguessable only by convention.
* Every result appends to `scores/blind.jsonl`, so the only honest number this project
  has is finally a trend. `node tools/blind.mjs --history`.

---

## 5. Standing rules

1. **A subsystem is not done because its means match.** Means are the one thing a
   scrambled reference reproduces perfectly. `nullcheck` proves it: a 64 px jigsaw of
   the reference passes the ROI signature gate better than the whole build does.

2. **Never report a composite without its worst axis.** The composite is an arithmetic
   mean over axes with wildly different information content, and it has spent five waves
   averaging a dead 0 against a live 94. Quote `axes.structure` and `raw.ms_ssim`
   alongside any score, or quote nothing.

3. **A clipped axis is a broken instrument, not a hard target.** If a metric has read
   the same value every run — `grade` has read 0.00 every run ever recorded — it is
   carrying no information and must be re-banded or removed before it is cited again.

4. **Before trusting a new instrument, make it reject the nullcheck controls.**
   `nullcheck.py --instruments` reports each descriptor's response to every surrogate.
   The pass condition has two halves and both matter: a large response to
   phase/shuffle/noise, and a **near-zero response to `mirror`** — mirroring preserves
   shape, so a shape descriptor that moves on mirror is measuring position and lying to
   you. The silhouette descriptors return exactly 0.00 on mirror; that is the check
   passing.

5. **An instrument that cannot fail cannot pass anything.** Every measurement quoted in
   a report should come with the value it would have taken had the subsystem been wrong.
   If you cannot state that, you have not measured anything.

6. **Run the blind test every wave, not at the end.** It costs one command and three
   looks now. Five waves were spent optimising proxies that a single 30-minute blind
   test would have invalidated on day one.

7. **The blind test is the score.** Everything in `scores/history.jsonl` is a proxy that
   was picked for being cheap. When a proxy and the blind test disagree, the proxy is
   wrong. It has disagreed once, by 9 pairs to nil.
