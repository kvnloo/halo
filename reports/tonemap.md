# tonemap — exposure control fix + default exposure re-fit

Owner file: `src/render/passes/tonemap.js` (only file touched).

- Wave 1 (committed in `fdaaa25`): fixed the dead `ctx.config.exposure` pin, fitted
  `KEY_TRIM_EV = -0.2`, disproved the `exposureEV` discontinuity in KNOWN_ISSUES 8b.
- Wave 2: re-verified the pin fix, re-fitted the trim to **0**, measured `volumetricFog`
  as a byte-level no-op.
- Wave 3 (this session): re-proved the pin against the current scene (terrain + fog fixes
  landed), measured what the landed fog fix is now worth in exposure terms, and re-fitted
  the default on a **pose-matched, replicated, nine-pose** basis instead of one frame.
  **KNOWN_ISSUES 9 can be closed** — the sweep in section 1 is monotonic in five
  statistics across a 10x pin range. `KEY_TRIM_EV` stays **0**, now for a measured reason
  rather than for want of a better number.

---

## 1. What was broken: `ctx.config.exposure` pins were silently ignored (KNOWN_ISSUES 9)

A 13x pin range produced byte-identical frames, lum_mean 110.51883342978395 for every
value including no pin at all.

**Cause.** The config slot is both the input (the pin) and the output (the value `bloom`
reads to convert its display-referred knee back to scene-linear). Intent was inferred as
`v !== published`, and then the pin was republished into that same slot. One frame later
the pin *is* `published`, reads as our own output, and the keyed value takes over. Pins
lasted exactly frame 0; every capture past `--settle 1` rendered at the keyed value.

**Fix.** Latch the pin in a pass-owned variable (`pin`); the config slot stays purely the
published output. An outside write latches, a non-number releases, our own value coming
back around is a no-op. Comparison by relative epsilon (1e-6), not `===`, so a debug UI or
harness round-tripping `ctx.config` through JSON cannot have its own echo mistaken for a
pin and freeze exposure. Also: a non-finite/<=0 keyed value falls back to the last good
number instead of publishing `Infinity` into a slot bloom multiplies by, and the final
uniform is range-clamped.

The trim rides on the **keyed** value only — a pin is an absolute request for a specific
sensor gain, and silently scaling it would make the pin lie.

### Proof, re-measured this session (terrain + fog fixes in the tree)

> **Method retraction (added by a later wave):** the `HALO_NO_DAEMON=1` below was copied
> from `reports/fog.md`'s stale-module-cache theory. That theory was tested and is false —
> `docs/KNOWN_ISSUES.md` §19: vite re-transforms on edit even with `HALO_NO_HMR=1`. Do not
> use the flag; it costs one vite + one Chrome per agent, the configuration that exhausted
> memory at 17 agents. It is a harness choice, not a render setting, so the six numbers
> below are not challenged by this note — but re-run them on the shared daemon. If a
> subsystem looks stale it has probably stopped loading: `node tools/parsecheck.mjs`, then
> read the capture's `missing` list. Registered as `no-daemon` in `tools/refuted.json`.

`ref_00000 --settle 48`, `HALO_NO_DAEMON=1`, all six captures with an identical module
state (the single boot warning in each is `physics: addStatic is not defined`, another
agent's file, no visual effect):

```
pin      lum_mean   p50   p99   shadow_frac  highlight_frac
0.15       55.31     52   167     0.2279       0.0002
0.35       87.26     86   200     0.0567       0.0019
0.55      105.73    105   214     0.0109       0.0041
0.75      118.76    119   221     0.0064       0.0073
1.0       130.91    132   228     0.0003       0.0139
1.5       147.48    150   233     0.0000       0.0208
```

Strictly monotonic in lum_mean, p50, p99, shadow_frac (down) and highlight_frac (up) over
a 10x range. The control is live.

## 2. `volumetricFog` is no longer a no-op, and it is worth +0.49 codes

Last wave `--skip volumetricFog` was **byte-identical** to the default frame. It is not
any more — the fog agent's fix has landed in the working tree. Re-measured at `ref_00000`:

```
                       lum_mean   sat_mean   p50   p99   shadow_frac
default (fog on)         113.71      45.87   116   204     0.0514
--skip volumetricFog     113.22      46.36   116   204     0.0514
```

**Fog contributes +0.49 codes of luminance (0.4%)** and -0.5 of sat_mean. That is the
concrete answer to "what does the default exposure assume about the fog fix": it assumes
fog is worth half a display code, a sixth of the trim's own resolution. It is small *by
design* — per `reports/fog.md` 2 the pass now yields opaque-surface haze to `wmAerial` and
owns only the sky and the shafts, so it cannot move whole-frame exposure much. A future
fog change would have to be ~10x larger than the one that just landed before the trim
would notice.

## 3. The default exposure fit — one frame was the wrong basis

`docs/TARGETS.md`'s whole-frame signature (lum_mean 107.8, p50 105, p99 221, shadow 0.050,
highlight 0.007) is a **mean over the whole clip**, and the reference is nowhere near flat
across it: its keyframes run lum_mean 71.6 (kf_01245) to 125.5 (kf_00390), and `kf_00000`
alone is 112.2. Fitting a single `ref_00000` render to a clip mean — which is what waves 1
and 2 did — bakes in that pose's own 4.4-code deviation.

So this wave fits **pose-matched**: `--all` (nine poses in one page load, ~20 s) against
the nine `ref/keyframes/kf_*.png` at the same poses. Their means are the honest target for
this pose set:

```
nine-pose reference mean:  lum_mean 105.40   p50 99.44   p99 222.1   shadow 0.0565   high 0.0088
(clip mean, docs/TARGETS)  lum_mean 107.80   p50 105     p99 221     shadow 0.050    high 0.007
```

Three alternating replicate pairs, plus a fourth pair an hour later:

```
trim      lum_mean (4 runs)              p50 (4 runs)              p99     shadow   high
 0.00   105.82 105.82 106.52 105.46   106.67 106.67 107.00 105.89  203.1   0.0316  0.0029
-0.15   101.46 102.15 100.69 101.09   102.00 102.56 101.44 101.78  199.7   0.0403  0.0024
```

Slope 30.8 codes/stop on lum_mean, 31.9 on p50; replicate spread 0.7-1.5 codes.

**At trim 0, pooled lum_mean is 105.90 against a pose-matched reference of 105.40 — +0.5%,
and the most recent run is +0.06%.** Least squares on the two terms exposure controls:

```
against the pose-matched nine-frame mean:   EV = -0.135   (latest run: -0.111)
against the clip signature in TARGETS.md:   EV = -0.003
```

The two defensible bases disagree by more than the residual they are arguing about. That
is the result: **the keyed photographic exposure is already inside the uncertainty of what
"the target" means, so `KEY_TRIM_EV` stays 0** and the 18% Lambertian card on AgX's middle
grey needs no fudge.

## 4. Why the p50 excess is a shadowing deficit, not an exposure error

Only p50 pulls the fit negative (lum_mean says 0.00). It does so because the histogram is
the wrong *shape*, not in the wrong place — our lum_std is 33-36 per pose against the
reference's 43-58, so both tails are missing and the median floats up. Solving for the
exposure each pose would need on its own:

```
  00000 +0.116   00120 +0.149   00450 +0.355   00600 -0.526   00720 -0.254
  00840 -0.280   01500 -1.004   01800 -0.803   02220 +0.999
  mean -0.139   median -0.254   sd 0.618 stops
```

The per-pose scatter is **4.5x the pooled offset**. No single number reconciles a pose that
wants +1.0 stops with one that wants -1.0, and note that `ref_00000` — the frame the
earlier waves fitted on — wants +0.12, the *opposite sign* to the pooled fit.

And the requirement correlates with the **reference's** shadow_frac at **r = -0.689**
(with `ref_std - our_std`, r = -0.585): the poses that "want" less exposure are exactly the
ones where the reference has deep shadow we do not reproduce — 01500's reference is
shadow_frac 0.1145 / p50 75 / lum_std 55.8 against our 0.0131 / 114 / 33.3. That is a
shadowing deficit wearing an exposure costume. Darkening the frame to chase it moves
lum_mean, p99 and highlight_frac *further* from target to bring p50 and shadow_frac closer:
three worse for two better.

## 5. Measurement hygiene — the scene moved under every number here

Two failure modes cost captures this session, both worth stealing:

**A module can silently vanish.** Two capture rounds returned lum_mean 102.18 / p50 90 /
lap_var 107 with **three** boot warnings: `src/world/terrain.js` did not parse (an
unescaped backtick in a comment inside a GLSL template literal), so the beach was simply
absent and the loader swallowed it into `warnings[]`. Any fit taken in that window is
garbage. Every capture here is tagged with `grep -c "not loaded\|failed to init\|
VALIDATE_STATUS"` on the harness JSON and a fit is only taken from a bracket whose count
is constant. One later run came back *pure black* (lum 0.00, shadow_frac 1.0) with
`VALIDATE_STATUS false` — a shader mid-edit in another agent's file. This is the same
signature as KNOWN_ISSUES 8b's archived `lum 13.2 / lap_var 8` row: a frame that failed to
render, not one exposed down.

**Determinism cannot be tested while other agents are landing.** Two `ref_00000` captures
60 s apart differed (ssim 0.98, lum 111.42 vs 109.35); hashing `src/**/*.js` either side of
the pair showed `SOURCES CHANGED during test`, with `terrain.js`, `volumetricFog.js` and
`weapons.js` all touched inside the window. Guard the check with a source hash. Determinism
of this pass is evidenced instead by the two replicate runs a1/a2 in section 3, which agree
to the last printed decimal on all nine poses.

Whole-frame lum_mean at fixed trim 0 has been 113.71 -> 109.62 -> 106.52 -> 105.46 across
this session at `ref_00000` / pooled, with lap_var 389 -> 300 and lum_std 37 -> 31, while
terrain, rocks, ocean, clouds, vegetation and weapons all landed. **Every number in section
3 is a snapshot of a scene that is still moving ~4 codes an hour.** The fit is cheap to
redo — two `--all` runs, 40 s.

## 6. Why three of the five targets are still missed at any exposure

p99 203 vs 222, highlight_frac 0.0029 vs 0.0088, shadow_frac 0.032 vs 0.0565. These are not
an exposure disagreement: our lum_std is ~35 against the reference's 52.4 and lap_var ~300
against 599. Exposure slides a histogram, it cannot widen one. The pin sweep in section 1
is the direct evidence — p99 221 arrives at pin 0.75, where lum_mean is 118.8 and
shadow_frac has collapsed to 0.006.

The scene does not produce values in the top two stops, so AgX's shoulder never engages and
the display transform is doing the job of a gamma curve. `ctx.config.tonemapProbe = 1`
prints the exposed-linear tail so this can be argued with numbers rather than opinions.
Nothing in tonemap can fix it; it belongs to albedo/lighting/shadowing/grade.

## 7. `exposureEV` discontinuity (KNOWN_ISSUES 8b) still does not reproduce

Swept 0 to -2 in quarter stops: lum_mean falls smoothly, per-step ratio 0.935 drifting to
0.905 as AgX's toe compresses. No cliff. 8b's EV table is stale; its EV 0 row (148.4) no
longer holds either.

## 8. Cost

No shader change — the GLSL is untouched, so the pass stays at its measured **0.18 ms** at
1920x1080 (best of three runs of 200 frames, pass toggled off and back on, ANGLE/Vulkan).
The per-frame CPU addition from the pin fix is two float comparisons and one `Math.pow`.

## 9. Weakest thing left

The default trim is a snapshot of a scene that moves ~4 codes an hour, and its two
defensible target bases (pose-matched keyframes vs the clip-mean signature in TARGETS.md)
disagree by 0.13 stops — more than the residual either of them is trying to remove. Someone
should decide which basis this project fits exposure against and write it into
`docs/TARGETS.md`; until then "the default exposure is correct" is only true to ±0.13
stops. The pin fix itself is settled and proven.
