# tonemap — exposure control fix + default exposure fit

Owner file: `src/render/passes/tonemap.js` (only file touched).

---

## 1. The reported discontinuity does not reproduce at HEAD

`docs/KNOWN_ISSUES.md` 8b reports EV -1.6 rendering 10x too dark (lum 13.2, lap_var 8).
Re-measured, `ref_00000`, `--settle 40`, **before touching anything**:

```
    EV      lum     p50   p99  shadow   high     sat     lap    lum ratio
     0    110.52    114   209  0.0548  0.0030   36.30   238.6      —
 -0.25    103.35    106   204  0.0576  0.0021   38.50   232.3    0.935
 -0.50     96.26     98   198  0.0653  0.0013   40.68   223.1    0.931
 -0.75     89.29     91   191  0.0749  0.0008   42.89   212.3    0.928
 -1.00     82.46     83   185  0.0800  0.0005   45.14   200.0    0.924
 -1.25     75.81     76   178  0.0911  0.0003   47.42   186.2    0.919
 -1.50     69.35     69   171  0.1146  0.0000   49.81   172.1    0.915
 -1.75     63.10     63   163  0.1473  0.0000   52.37   157.6    0.910
 -2.00     57.09     56   156  0.1823  0.0000   55.11   143.1    0.905
```

Smooth, monotonic, and the per-quarter-stop ratio drifts only 0.935 -> 0.905 (AgX
compressing as it walks down its toe). No cliff anywhere between 0 and -2.

The historical `lum 13.2 / sat 98.8 / lap_var 8` is a near-black, near-flat frame — the
signature of a frame that did not render, not of a frame that was exposed 3 stops down.
lap_var 8 at any exposure means there was no image. Most likely a transient from a
concurrent shader edit; note the same row's baseline (`EV 0 -> lum 148.4`) also no longer
holds, since albedo work has since moved EV 0 from 148.4 to 110.5.

**8b as written is not a live defect. Something else in the exposure path is.**

## 2. What *is* broken: `ctx.config.exposure` pins are silently ignored

The documented contract is "write a number to pin it, write null to release". Measured,
before the fix:

```
node tools/capture.mjs --pose ref_00000 --config exposure=0.15 --settle 40 --out a.png
node tools/capture.mjs --pose ref_00000 --config exposure=2.0  --settle 40 --out b.png
cmp a.png b.png                     # IDENTICAL
cmp a.png <auto, no --config>       # IDENTICAL
```

A 13x exposure range, zero effect, byte for byte. `lum_mean` 110.51883342978395 for all
three.

Cause: the config slot is both the input (the pin) and the output (the published value
bloom reads), so intent was inferred as `v !== published` — and then the pin was
republished into that same slot. One frame later the pin *is* `published`, reads as our
own output, and auto takes over. Pins lasted exactly frame 0; every capture past
`--settle 1` rendered at the keyed value. This is precisely the "interaction between a
pinned `ctx.config.exposure` and `keyedExposure()`" 8b suspected — it just presents as a
dead control rather than a jump.

### Fix

Latch the pin in a variable owned by the pass; the config slot stays purely the published
output. An outside write latches, a non-number releases, our own value coming back is a
no-op. Comparison is by relative epsilon (1e-6) not `===`, so a debug UI or
`tools/captured.mjs` round-tripping `ctx.config` through JSON cannot have its own echo
mistaken for a pin and freeze exposure. Also: a non-finite/<=0 keyed value now falls back
to the last good number instead of publishing `Infinity` into a slot bloom multiplies by,
and the final uniform is range-clamped so an absurd `exposureEV` cannot reach the shader
as a non-finite uniform.

### Proof it works now

```
pin exposure=0.15   lum_mean  56.12   p50  55
pin exposure=0.35   lum_mean  87.39   p50  89
pin exposure=0.70   lum_mean 115.74   p50 119
pin exposure=1.40   lum_mean 144.58   p50 150
pin exposure=2.00   lum_mean 158.91   p50 165
auto (no pin)       lum_mean 110.52   p50 114
```

Monotonic over 13x. And the shipped auto path is **byte-identical to pre-fix**
(`cmp` clean) — zero regression for anyone not using the pin.

## 3. Default exposure fit

Whole-frame targets (`docs/TARGETS.md`): lum_mean 107.8, p50 105, p99 221,
shadow_frac 0.050, highlight_frac 0.007.

```
     EV     lum_mean   p50   p99   shadow_frac  highlight_frac
    +0.50    124.99    129   219      0.0441       0.0059
    +0.25    117.75    121   214      0.0493       0.0042
     0.00    110.52    114   209      0.0548       0.0030
    -0.125   106.92    110   207      0.0565       0.0025
    -0.25    103.35    106   204      0.0576       0.0021
    -0.50     96.26     98   198      0.0653       0.0013
```

The five targets have no common solution. Bulk terms want about -0.2 stops (lum_mean
alone -0.10, p50 alone -0.28); tail terms want +0.2 to +0.7 (shadow_frac +0.22, p99 +0.6,
highlight_frac +0.7). That is not disagreement about exposure — the histogram is too
narrow: lum_std 40 vs the reference 52.3, lap_var 239 vs 463. Exposure slides a histogram,
it cannot widen one. The tails belong to albedo/lighting/grade (sat_mean is still 36
against a target of 84).

Fitted to the two terms exposure actually controls, least squares on relative error of
lum_mean and p50 against local slopes 28.9 / 29.3 codes per stop:

```
0.030687 + 0.149749 * EV = 0   ->   EV = -0.205
```

Shipped as `KEY_TRIM_EV = -0.2`, applied to the **keyed** exposure only (a pin is an
absolute request and must not be silently scaled), overridable at runtime via
`ctx.config.exposureTrimEV`. It is folded into the published `ctx.config.exposure`, so
bloom's `exposureGain()` reconstruction stays exact with no change to bloom.
`exposureEV` stays a pure user offset defaulting to 0, so the sweep commands in
`KNOWN_ISSUES` keep their meaning.

**What the number assumes:** the albedos as of this fit. It is worth 5.8 codes; the albedo
work moved EV 0 from lum_mean 148.4 to 110.5 while this was being measured. Re-fit with
the sweep above when albedos land. Do not treat -0.2 as fixed.

Re-checked at the end of the session: `--config exposureTrimEV=0` measures lum_mean
110.5161 against the 110.5188 recorded before any of this work — 0.003 codes of drift, so
nothing landed under the fit and it still holds.

## 3b. Post-fix sweep (proof the control is still smooth with the trim in)

```
    EV      lum     p50   p99  shadow   high     sat     lap    ratio
     0    104.78    107   205  0.0571  0.0023   38.06   233.9     —
 -0.25     97.66    100   199  0.0627  0.0015   40.25   225.1   0.932
 -0.50     90.66     92   193  0.0738  0.0009   42.45   214.5   0.928
 -0.75     83.81     85   186  0.0788  0.0006   44.70   202.6   0.924
 -1.00     77.12     78   179  0.0870  0.0003   46.96   189.0   0.920
 -1.25     70.62     71   172  0.1086  0.0001   49.33   174.9   0.916
 -1.50     64.33     64   165  0.1404  0.0000   51.84   160.5   0.911
 -1.75     58.27     57   157  0.1753  0.0000   54.57   145.9   0.906
 -2.00     52.47     51   150  0.2157  0.0000   57.22   131.4   0.900
```

Final default frame, `ref_00000 --settle 48`, captured twice back to back:
**byte-identical** (determinism intact). lum_mean 104.73, p50 107, vs whole-frame targets
107.8 / 105. A re-capture a few minutes later reads 104.68 / 107 — 0.05 codes of drift
from other modules landing, well inside the fit.

## 4. Cost

No shader change — the GLSL is untouched, so the pass stays at its documented 0.18 ms at
1920x1080. The added CPU work per frame is two float comparisons and one `Math.pow`.

## 5. Weakest thing left

`highlight_frac` 0.0030 against a target of 0.007 and `p99` 209 against 221 at the fitted
exposure. The scene does not produce values in the top two stops, so AgX's shoulder never
engages and the display transform is doing the job of a gamma curve. That is the headroom
deficit this file's own header predicts; `ctx.config.tonemapProbe = 1` prints the
exposed-linear tail so it can be argued with numbers. Nothing in tonemap can fix it —
raising exposure to reach the tails costs 20+ codes on the median.
