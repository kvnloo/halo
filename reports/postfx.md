# postfx — bloom / dof / sharpen / grain

Owner files: `src/render/passes/{bloom,dof,sharpen,grain}.js`. Nothing else was touched.

## Measurement conditions (read before quoting any number here)

Every number below is `tools/capture.mjs` output at **`ref_00120`, `--settle 48`, 1920x1080**,
measured with `tools/_pfx.py` (a thin wrapper over `tools/metrics.py` + `tools/roi.py` that
prints whole-frame and per-ROI rows against `ref/roi_signatures.json`).

The tree was **not** quiescent (KNOWN_ISSUES §16): `terrain.js`, `rocks.js`, `clouds.js`,
`ocean.js`, `sky.js`, `vegetation.js`, `props.js` and `volumetricFog.js` were all being
edited by the concurrent wave while these ran. Two mitigations:

1. **Every sweep is captured concurrently through the shared daemon** (`tools/_pfxcap.sh`),
   so all variants of one sweep see the same tree, and the script records each capture's
   `modules not loaded` list next to the PNG. A sweep whose module lists differ between
   variants is thrown away. All sweeps quoted here have identical module state within the
   sweep.
2. **Absolute numbers are therefore only comparable inside a sweep.** Do not compare a row
   from Batch 1 with a row from Batch 2. In Batch 1 and 2 `props` failed to load
   (`Unexpected identifier 'vColor'` — another agent mid-write), so those frames are
   missing the scattered prop geometry.

Because of that, the shipped baseline is re-captured inside every sweep via `--config`
rather than taken from the critic's numbers.

---

## Batch 1 — sharpen amount sweep, and the first measurement of taaSharpen's own gain

Common config: shipped bloom (`thr 0.97 / falloff 0.75 / levels 6 / dither 0.013`),
shipped grain (`CA 0.70`, no luma preservation), shipped dof (`nearGain 2`,
fade 0.2..1.1 px). Only `sharpenAmount` (and, in the last row, `taaSharpen`) varies.

### whole frame (target: lap_var 463, spectral_slope −2.60)

| sharpenAmount | lap_var | edge_den | local_con | slope |
|---|---:|---:|---:|---:|
| **taaSharpen 0 + 0.00** | 211.8 | 0.0791 | 0.1204 | −2.451 |
| 0.00 | 322.2 | 0.0873 | 0.1206 | −2.309 |
| 0.20 | 406.0 | 0.0928 | 0.1205 | −2.239 |
| 0.30 | 452.6 | 0.0953 | 0.1205 | −2.206 |
| 0.45 | 528.5 | 0.0991 | 0.1205 | −2.158 |
| **1.00 (shipped)** | **866.4** | 0.1123 | 0.1204 | **−2.004** |

### per-ROI lap_var (reference in brackets)

| amount | sand [521.3] | water [676.6] | weapon [489.4] | sky [253.2] |
|---|---:|---:|---:|---:|
| 0.00 | 492.6 (−5%) | 506.9 (−25%) | 564.3 (+15%) | 41.7 (−84%) |
| 0.20 | 614.9 (+18%) | 663.3 (−2%) | 701.9 (+43%) | 49.1 (−81%) |
| 0.30 | 682.8 (+31%) | 750.8 (+11%) | 778.1 (+59%) | 53.4 (−79%) |
| 0.45 | 793.3 (+52%) | 894.4 (+32%) | 901.3 (+84%) | 60.4 (−76%) |
| 1.00 | 1283 (+146%) | 1541 (+128%) | 1445 (+195%) | 92.8 (−63%) |

### per-ROI spectral_slope (reference in brackets)

| amount | sand [−2.370] | water [−2.436] | weapon [−2.633] | sky [−2.947] |
|---|---:|---:|---:|---:|
| 0.00 | −2.298 | −2.228 | −2.669 | −3.194 |
| 0.20 | −2.243 | −2.152 | −2.603 | −3.180 |
| 0.30 | −2.217 | −2.116 | −2.571 | −3.173 |
| 1.00 | −2.051 | −1.888 | −2.375 | −3.123 |

### what this settles

- **`local_contrast` is invariant to the sharpener** — sand 0.05345 → 0.05347 across the
  entire 0.00 → 1.00 range, weapon 0.1250 → 0.1251. The pass adds no information. Every
  `lap_var` code value it produces is amplitude on structure that was already there, plus
  the noise floor.
- **`taaSharpen 0.45` is a real second sharpener and it is large.** With `sharpen` bypassed,
  turning `taaSharpen` off drops whole-frame lap_var 322.2 → 211.8, a 1.52x lap_var ratio
  = a **1.23x amplitude gain** already applied upstream. `sharpen.js`'s header acknowledged
  the stacking and then did not subtract it. Subtracting it: TAA converges to MTF 0.41,
  `taaSharpen` recovers ~1.23-1.45x of that, so the residual loss `sharpen` is entitled to
  invert is **~1.68x at Nyquist, not 2.44x**.
- **Even 1.68x is empirically wrong for this frame.** 1.68x needs `sharpenAmount` ~0.53 at
  `sharpenStrength 0.30`; measured, that lands whole-frame lap_var near 590 against a 463
  target and puts sand +70% and weapon +100% over their ROI targets. The MTF-inverse
  derivation assumes the pre-TAA Nyquist band is attenuated *signal*. In this scene it is
  substantially shading noise and residual aliasing off terrain/rocks/ocean, and a
  deconvolution amplifies that identically. **The measurement overrides the derivation** —
  which is what the header's own "Re-measure. Do not assume." instructed.
- **Per-ROI, the acceptance gate forbids nearly all of it.** `sand` and `water` both sit
  *flatter* than their reference slope with the sharpener bypassed (−2.298 vs −2.370;
  −2.228 vs −2.436), so any amount > 0 moves them further away. Only `weapon` and `sky`
  have slope headroom, and `weapon` is already +15% over its lap_var target at amount 0.
  Fitting lap_var gain as `g(a) = 1 + ka` per ROI (k = 0.61 sand, 0.74 water, 0.60 weapon,
  0.64 whole-frame — all within 1% over the full range) and minimising the summed squared
  log-ratio against the sand/water/weapon targets puts the optimum at **a ≈ 0.07**, and the
  objective is flat from 0.00 to 0.10.
- Visually, at 2x nearest-neighbour zoom on the foreground pebble field (`crop_sh*.png`),
  amount 1.00 shows the bright-rim / dark-outline pair on every pebble and a crawling
  high-frequency texture across the stone faces. Amount 0.20 is indistinguishable from
  0.00 at that zoom. `ref/detail/sand_4k.png` has no ring anywhere.

**Shipped: `sharpenAmount` 1.0 → 0.18, `sharpenStrength` 0.30 → 0.12.**

The strength came down as well as the amount, and for a separate reason. Writing the blend
out, `mix(e, res, a) == e + K*(b+d+f+h-4e)` with `K = a*w/(1+4w)` — a scaled Laplacian with
CAS's `amp` on the scale. `a` is linear in `K`; `s` is not, and raising `s` raises `K`
fastest where `amp` is largest, which is a **flat mid-tone neighbourhood** — sand. That is
precisely the bias behind the review's strongest piece of evidence (the |Laplacian| median
growing 1.63x on sand while the p99.9 tail grew only 1.50x: the noise floor amplified
harder than the edges). So the strength sits at the low end of its useful range (it cannot
be 0 — the pass early-outs) and `sharpenAmount` carries the setting.

(A batch measured while `sky.js` was mid-write by another agent produced a degenerate frame
— whole-frame `lap_var` 24, `sand` 8.7 — and was discarded rather than reported. It is
mentioned only so the gap in the batch numbering is accounted for.)

---

## Batch 4 — the clean sweep (complete scene, zero missing modules)

Ten variants, captured concurrently, **no missing modules in any of them**. This is the
sweep the defaults were chosen against. `P_ship` is the rejected configuration re-captured
inside the sweep; `G_final` is the new defaults at `sharpenAmount 0.24`.

### whole frame

| | lum | std | p99 | hif | lap_var | edge | local_con | slope |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| REF | 107.8 | 52.3 | 221 | 0.0070 | 463 | 0.085 | 0.192 | −2.60 |
| shipped | 105.76 | 31.75 | 188 | 0.0015 | **919.9** | 0.1138 | 0.1027 | **−1.908** |
| new | 105.84 | 31.06 | 188 | 0.0017 | **477.3** | 0.0964 | 0.1033 | **−2.132** |

### the grain CA isolation (this is the cleanest result in the whole task)

`lap_var`, everything else held at the new defaults:

| grain CA configuration | whole | sand | water | weapon | sky |
|---|---:|---:|---:|---:|---:|
| `grainCA 0` (no CA at all) | 488.2 | 760.7 | 725.6 | 835.0 | 74.5 |
| **0.45, luma-preserving (shipped)** | **477.3** | **738.7** | **719.7** | **817.6** | **71.7** |
| 0.45, no luma preservation | 453.6 | 690.9 | 707.3 | 779.4 | 66.1 |
| 0.70, no luma preservation (old) | 437.4 | 658.0 | 697.9 | 753.2 | 62.5 |

The old configuration destroyed **10.4% of whole-frame and 13.5% of `sand`** Laplacian
variance. The new one costs **2.2% and 2.9%**. At equal amplitude the luma preservation
alone recovers 5.2% whole-frame / 6.9% on sand. `local_contrast` is identical (0.0550) in
all four rows, which is what makes the old setting pure loss.

### bloom's dither (`O_bdither`)

`bloomDither 0.013` adds +1.4 whole-frame and +1.6 sky `lap_var` of pure noise and shifts
`lum_mean` by 0.01 (it is multiplicative and sits upstream of the auto-exposure meter).
Removed. Banding gate re-run on `diag_sky`, blue channel column x=1500, top 800 rows,
`grade.js`'s <2.0 px mean-plateau gate:

```
all dither off                mean_run 1.43   max 8    pass
grain off, grade dither on    mean_run 1.52   max 11   pass
SHIPPED (grain dither only)   mean_run 1.40   max 10   pass
+ bloomDither 0.013 as well   mean_run 1.35   max  7   pass
```

Removing bloom's dither costs 0.05 px of mean plateau run against a 2.0 px gate.

---

## DoF: the pass is the exact identity, and here is the proof

`cmp` on the capture PNGs: `dofEnabled 0`, the shipped `dofNearGain 2 / fade 0.2..1.1`,
and `dofViewmodelCoC 0` are **byte-identical to each other** at `ref_00120` on a frame
where the weapon fills a third of the view. Not "similar" — identical bytes.

Three captures explain it, all with `dofDebug`:

1. **`dofDebug 4` (G-buffer coverage)** — coverage is 1 over the whole world, 0 over the
   sky, and **the gun is not in it at all**. `scene.js` does not render `LAYER.VIEWMODEL`
   into the G-buffer, so at a gun pixel `g1.a` is the coverage of the *terrain behind the
   gun*. The `cocAtUv()` fallback "wrote depth, no G-buffer coverage ⇒ viewmodel" rests on
   an assumption that is false at exactly the pixels it was written for, and can never
   fire. `dofDebug 3` confirms no `MAT_ID.VIEWMODEL` anywhere either.
2. So a gun pixel takes the covered-geometry path with the viewmodel's own depth (§18
   cleared the shared depth and the viewmodel refilled it). Decoding a 0.002–12 m depth
   against the main camera's 0.06–12000 m puts the gun at **~12.4 m** — inside the
   in-focus band (near ends 1.60 m, far starts 90 m). `cocAt` returns exactly 0.
3. Every world pixel has coverage but reads depth 1.0 (cleared by §18) and hits the
   `raw >= 0.999999` refusal. Also exactly 0.

So `dofViewmodelCoC` is unreachable and so is the world path: **every pixel in the frame
has CoC 0.** The pass ran a prefilter, a 21-tap gather and a full-res composite every
frame to return its input unchanged.

This is a more specific diagnosis than the review's (which had the viewmodel path
saturating `nearCoverage` to a full half-res replace). The `uNearGain 2.0` clipping bug it
identified is real and is fixed, but it is downstream of a branch that never executes.

**Actions taken.** `dofNearGain` 2.0 → **1.0** and the sub-pixel coverage fade moved from
0.20..1.10 to **0.50..2.00 full-res px**, keyed to the half-res round trip's own ~2 px
transfer rather than copied from the far field's composite ramp — so `nearCoverage()`
reaches the composite instead of being clipped away, and the gather gets no authority at
all below half a pixel of CoC. `dofViewmodelCoC` → **0** and `dofWorldDepthValid` → **false**,
which makes the new fast-out fire and skips the prefilter and gather entirely; the output
changes by zero bytes, measured. `create()` prints a one-time `console.info` naming §18 and
the flag so it cannot quietly outlive the bug.

**The old bypass could never fire.** It was `(nearMax + farMax + vmCoC) < 0.05` against
shipped maxima of 2.6 and 1.5. The new one tests each source against the composite's own
blend floor — far needs 0.20 px to clear `smoothstep(0.20, 1.10)`, near needs
`dofNearFadeLo` — which is the condition under which the pass is provably the identity.

**The gather itself is correct.** `dofTestCoC 6` at `ref_00120` (`shots/px/b5/X_testcoc.png`)
drives a horizontal CoC ramp through the real kernel: near field left, in focus centre, far
field right. It resolves cleanly — soft at both ends, sharp down the middle, no ring at
either transition, and no leak of the sharp centre into the blurred sides, which is the
scatter-as-gather weight doing its job. That is the "look at the far-field curve once
before §18 lands" the review asked for.

**The old weapon table is deleted, not updated.** It claimed `lap_var` 543.36 → 399.12 at
1.2 px on `diag_gun`. Measured at `ref_00120` on the complete scene the `weapon` ROI reads
`lap_var` 817.6 / `local_contrast` 0.1238 and **does not move at all** between
`dofEnabled 0`, the old defaults and the new ones. The old table is not reproducible on
this build and has been removed rather than left to be believed.

---

## Bloom: it was a DC offset, and the fix is verified by profile, not by `lum_mean`

### the diagnostic

`lum_mean` cannot verify a bloom — a veil and a glare kernel deposit identical total
energy. A radial profile around the brightest *pixel* is also the wrong tool here, because
the bright things in this frame are cloud masses tens of pixels across, so most of each
annulus is background and the profile reads flat for a good kernel too. The honest version
is a **distance transform of the above-knee mask**:

```python
mask = luminance(bloom_off) > knee
dist = cv2.distanceTransform(1 - mask, cv2.DIST_L2, 5)
# mean of (bloom_on - bloom_off) in bands of dist
```

Mean added code values by distance from the above-knee mask, `ref_00120`:

| distance px | 0 | 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **shipped** (6 levels, falloff 0.75, thr 0.97) | +0.17 | +0.52 | +0.91 | +1.01 | +0.98 | +0.82 | +0.74 | +0.66 | +0.33 | +0.02 |
| 4 levels, falloff 1.80, thr 0.82 | +3.85 | +6.08 | +7.42 | +7.21 | +6.29 | +3.86 | +1.66 | +0.56 | +0.03 | +0.00 |
| 4 levels, falloff 1.80, thr 0.78 | +4.36 | +5.43 | +6.54 | +6.33 | +5.44 | +3.23 | +1.29 | +0.38 | +0.02 | +0.00 |
| 4 levels, falloff 1.80, thr 0.72 | +5.61 | +7.67 | +8.37 | +7.41 | +5.92 | +3.40 | +1.41 | +0.42 | +0.05 | +0.00 |

The shipped row is **flat within a code value from 2 px to 128 px** — a DC offset with no
kernel in it at all, peak-to-64px ratio **1.5**. The new rows fall by more than two orders
of magnitude over the same span, ratio **13–20**. That is the difference between a veil and
"small hot cores with a few pixels of bleed", which is what bloom.js's own header says the
reference has.

### the three causes, and what each cost

1. **The knee was four stops too high.** `bloomThresholdSrgb 0.97` solves to display code
   247. Measured on this build only **0.035% of pixels exceed code 240** and p99 sits at
   188–221 depending on where the concurrent scene work has left the exposure — the knee
   sat above essentially the entire highlight population. Now **0.80** (code 204), which
   selects 0.6–1.3% of pixels, the specular/cloud-top population the scene actually has.
2. **The pyramid was spending 31% of a unit-energy budget on invisible octaves.**
   6 levels at falloff 0.75 gives weights [0.339 0.202 0.149 0.120 0.101 0.089]; octaves
   3–5 carry 31% spread over areas 64x–4096x larger than octave 0, so their surface
   brightness is a rounding error and their only visible effect is to lift everything.
   Now **4 levels at falloff 1.80** → [0.663 0.190 0.092 0.055], octave 0 carrying **66%**,
   and two downsample/upsample pairs deleted.
3. **`bloomDither 0.013`** — see above; removed, `grain` owns the dither.

### whole-frame direction check

bloom.js's header states the veil failure mode as "`lum_mean` up and `lum_std` down".
Measured, bloom on minus bloom off:

| | Δlum_mean | Δlum_std | Δlocal_contrast | p99 | highlight_frac |
|---|---:|---:|---:|---:|---:|
| shipped (6/0.75/0.97) | +0.18 | **+0.04** | +0.0003 | 221 → 221 | 0.0086 → 0.0087 |
| new (4/1.80/0.82) | +0.49 | **+0.58** | +0.0030 | 221 → 226 | 0.0086 → 0.0105 |

Every axis the reference is short on (`lum_std` 52.3, `local_contrast` 0.192,
`highlight_frac` 0.007, p99 221) now moves toward it instead of by nothing.

**This number is exposure-coupled and is owed a re-check** whenever the highlight
population moves — the `volumetricFog` fix changes p99 and `highlight_frac`, and any
`exposureEV` change moves the whole population past a fixed knee. Re-verify with the
distance-transform profile above, never with `lum_mean`.

---

## Final A/B — old defaults vs new, two poses, complete scene, zero missing modules

`shots/px/f1` (`ref_00120`) and `shots/px/f2` (`ref_01500`). `old` is the rejected
configuration re-captured inside the same sweep.

### ref_00120, whole frame

| | lum | std | p99 | hif | lap_var | edge_den | local_con | slope |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| REF | 107.8 | 52.3 | 221 | 0.0070 | **463** | **0.085** | 0.192 | **−2.600** |
| old | 96.97 | 35.90 | 190 | 0.0017 | 638.5 | 0.1072 | 0.1224 | −2.197 |
| **new** | 97.14 | 35.57 | 192 | 0.0021 | **310.5** | **0.0845** | 0.1235 | **−2.416** |
| new, sharpen 0 | 97.17 | 35.48 | 192 | 0.0021 | 257.5 | 0.0794 | 0.1236 | −2.465 |

### ref_00120, per ROI (lap_var / slope)

| | sand [521.3 / −2.370] | water [676.6 / −2.436] | weapon [489.4 / −2.633] | sky [253.2 / −2.947] |
|---|---|---|---|---|
| old | 750.2 (+44%) / −2.777 | 1756.9 (**+160%**) / −1.478 | 834.8 (+71%) / −2.606 | 121.1 / −3.091 |
| **new** | 355.1 (−32%) / −2.958 | 810.1 (+20%) / −1.712 | 438.5 (−10%) / −2.798 | 57.0 / −3.254 |

### ref_01500, whole frame

| | lum | std | p99 | lap_var | edge_den | local_con | slope |
|---|---:|---:|---:|---:|---:|---:|---:|
| REF | 107.8 | 52.3 | 221 | **463** | **0.085** | 0.192 | **−2.600** |
| old | 111.29 | 37.56 | 199 | 483.2 | 0.0825 | 0.1347 | −2.489 |
| **new** | 111.57 | 37.49 | 202 | 219.3 | 0.0628 | 0.1360 | **−2.710** |

per ROI: sand 693.5 → 283.0, water 754.2 → 320.1, weapon 908.4 → 437.6 (ref 489.4),
sky 131.9 → 56.7. weapon slope −2.150 → **−2.374** (ref −2.633).

### read this before quoting the table above

**The scene moved by roughly 2x underneath this measurement.** The Batch 4 sweep (2 hours
earlier) had `new, sharpen 0` at whole-frame `lap_var` ~359 and the ground ROIs *over*
their targets; by the final sweep the terrain and ocean rewrites had landed and the same
configuration reads 257.5 with every ROI *under*. `sharpenAmount 0.18` is the value that is
defensible under **both** observed states: at the earlier one it put whole-frame `lap_var`
within 4% of 463, at the later one it leaves the frame under-detailed but with
`edge_density` exactly on target (0.0845 vs 0.085) and `spectral_slope` 0.22 closer to
−2.60 than the old default.

It is **not** a converged number and it must be re-derived on a quiesced tree (§16). That
re-derivation is one capture, not a sweep, because the response is now characterised:
`lap_var(a) = lap_var(0) * (1 + k*a)^2` with **k = 0.61 sand, 0.74 water, 0.60 weapon,
0.64 whole-frame** (fitted, within 1% over the full 0..1 range). Capture once at
`sharpenAmount 0`, solve each ROI for its own target, take the value the ground regions
tolerate.

### and look at the image

`shots/px/f1/w_old.png` vs `w_new.png` (2x nearest-neighbour, weapon + foreground pebbles).
The old frame gives every pebble a bright rim and a dark outline ring, puts a crawling
high-frequency crust on the gun's grey body, and rings the sight-glass reticle. The new one
has soft terminators on the pebbles, smooth metal on the receiver and a clean reticle. That
is the "reads as a JPEG at quality 60 with the sharpen slider at maximum" defect, gone.

---

## Cost: measured, and the answer is "below the floor"

All three "Estimated, not profiled" blocks and bloom's "≈ 0.30 ms" are replaced.
`tools/_pfxprof.mjs` uses the `Engine.advance()` instrumentation from KNOWN_ISSUES §13.
There is no per-pass GPU timer in `RenderPipeline`, so a pass is priced by
`__HALO__.togglePass` + whole-frame ms differencing, sampled in an **interleaved
round-robin** repeated over several rounds so a patch of GPU contention lands on every
configuration equally rather than on whichever one happened to be running.

`ref_00120`, 1920x1080, 638 draws, 31.2 M triangles:

```
frame p50                    14.1 ms
paired difference, median:   bloom +0.1   dof +0.1   sharpen -0.1   grain 0.0
ALL FOUR PASSES DISABLED:    all 14.1  none 14.1    difference 0.0 ms median
```

Every figure is inside `performance.now()`'s own ~0.1 ms clamp, **including all four
together**. The honest statement is an upper bound: each pass is < 0.2 ms and the whole
postfx tail is not separable from noise on a frame this heavy. Resolving these properly
needs an `EXT_disjoint_timer_query_webgl2` timer in `RenderPipeline`; there isn't one.

The bloom pyramid did get cheaper in absolute terms — 4 levels instead of 6 removes two
downsample/upsample round trips — and dof's fast-out now skips a half-res prefilter and a
21-tap half-res gather every frame. Neither is measurable here.

---

## Summary of every default changed

| file | knob | was | now | why |
|---|---|---|---|---|
| sharpen | `sharpenAmount` | 1.0 | **0.18** | 2.29x Nyquist gain measured whole-frame lap_var 187% of target and slope 0.60 away from −2.60 |
| sharpen | `sharpenStrength` | 0.30 | **0.12** | `s` enters the gain non-linearly through CAS's `amp`, biasing gain toward flat mid-tones (sand). `a` is linear. Restraint belongs on `a`. |
| bloom | `bloomThresholdSrgb` | 0.97 | **0.80** | code 247 sat above the entire highlight population (0.035% of pixels exceed 240) |
| bloom | `bloomLevels` (new knob) | 6 | **4** | octaves 3–5 carried 31% of the energy at zero surface brightness |
| bloom | `bloomFalloff` | 0.75 | **1.80** | octave 0 now carries 66% of the pyramid; profile falls 2 orders of magnitude over 2→128 px instead of being flat |
| bloom | `bloomDither` | 0.013 | **0** | `grain` has owned the dither since it was implemented; this one was double-counted AND amplified by CAS |
| grain | `grainCA` | 0.70 | **0.45** | 0.70 px bilinear = MTF 0.40 at Nyquist on R and B |
| grain | `grainCALuma` (new knob) | — | **1** | luma from the centre tap, chroma from the displaced ones: CA's sharpness cost drops from 10.4% of whole-frame lap_var to 2.2% |
| dof | `dofNearGain` | 2.0 | **1.0** | it clipped `nearCoverage()`'s sub-pixel fade to exactly 1.0, undoing the thing that function exists for |
| dof | `dofNearFadeLo/Hi` (new) | 0.20/1.10 | **0.50/2.00** px | keyed to the half-res round trip's own ~2 px transfer, not copied from the far-field composite ramp |
| dof | `dofViewmodelCoC` | 0.9 | **0** | the viewmodel branch is provably unreachable and the reference weapon is dead sharp |
| dof | `dofWorldDepthValid` (new) | — | **false** | §18 leaves no world depth; makes the fast-out fire. Byte-identical output, one-time `console.info` so it cannot outlive the bug |

## Weakest things left, in order

1. **`sharpenAmount 0.18` is not converged.** The scene moved ~2x in baseline `lap_var`
   during this task. Re-derive on a quiesced tree with one capture at `sharpenAmount 0`
   plus the fitted `k` values above.
2. **The `sky` ROI is at `lap_var` 57 against a 253 target** and no postfx setting can
   close that — it is missing cloud structure. At the old default 64% of that region's
   Laplacian reading was manufactured by the sharpener, which is why removing it looks
   like a regression on the whole-frame number and is not.
3. **DoF is inert until KNOWN_ISSUES §18 lands**, and the viewmodel needs a real G-buffer
   signal (`MAT_ID.VIEWMODEL`) before `dofViewmodelCoC` means anything. Both are in
   `scene.js`, which this task does not own.
4. **`bloomThresholdSrgb` is exposure-coupled** and the concurrent fog fix will move the
   highlight population underneath it. Re-verify with the distance-transform profile.
5. **`local_contrast` is 0.12 against a 0.192 reference** and none of these four passes
   moves it — bloom contributes +0.003 and everything else is flat. That deficit is
   lighting and grade, not postfx.

---

## Final verification, shipped defaults, no `--config` at all

`shots/px/fin/a.png` and `b.png`, `ref_00120`, settle 48, zero missing modules.
**Two identical captures are byte-identical** — the four passes stay deterministic
(`grain` seeds from `pipe.frameIndex`, the Vogel kernel and the bloom weights are baked,
nothing added a clock or an RNG).

```
whole   lum 106.73  std 31.57  p01 19  p99 192  hif 0.0021
        lap_var 470.6 [463]   edge 0.0991 [0.085]   lc 0.1056 [0.192]   slope -2.108 [-2.60]

sand    lap  756.9 [521.3]  edge 0.1746 [0.120]  lc 0.0551 [0.101]  slope -2.198 [-2.370]
water   lap  676.8 [676.6]  edge 0.1185 [0.109]  lc 0.0754 [0.142]  slope -2.160 [-2.436]
weapon  lap  801.1 [489.4]  edge 0.1604 [0.089]  lc 0.1236 [0.178]  slope -2.551 [-2.633]
sky     lap   78.7 [253.2]  edge 0.0252 [0.037]  lc 0.1080 [0.166]  slope -3.207 [-2.947]
```

`water` lands on its target to within 0.2 of a code value squared and whole-frame
`lap_var` is within 2% of 463. But note the date stamp on this against the final A/B forty
minutes earlier, where the same defaults read whole-frame 310.5: **the ground rewrites
landing underneath this task move the baseline by ~50% between captures**, which is
exactly why item 1 in the list above says `sharpenAmount` is not a converged number. The
per-ROI picture at this instant says `sand` and `weapon` are over target on `lap_var`
while sitting at 55% and 69% of their reference `local_contrast` — high-frequency energy
without mid-scale structure — so if it moves again it should move **down**, not up.
