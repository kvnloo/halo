# ocean — checkpoint (2026-07-30)

Owned file: `src/world/ocean.js` only.

## 0. The module now parses and actually renders

`src/world/ocean.js:332` had a backtick-quoted `` `h` `` inside a comment inside the
`OCEAN_COMMON` template literal (opened at line 230), which terminated the JS template.
`node --check` -> `SyntaxError: Unexpected identifier 'h'`, and every capture carried
`[warn] [modules] not loaded: ocean`. Fixed (backticks removed). Verify:

    node --check src/world/ocean.js
    node tools/capture.mjs --pose ref_01800 --out shots/x.png --settle 48 2>&1 | grep -c "not loaded"   # -> 0

**Requested but NOT done (outside my owned file):** a CI gate running `node --check` over
`src/**` plus a boot assertion that fails a capture whose `warnings` contain
`not loaded`. Three agents rendered against an oceanless frame without noticing. This
needs an owner for `tools/`.

## 1. IMPORTANT: absolute numbers drift under you

terrain / rocks / structures / tonemap agents are editing concurrently. Measuring code
state X at 10:00 and state Y at 10:20 is **not** an A/B. I measured water lap_var 1111
for one code state and 740 for the *same* state twenty minutes later. Every number below
comes from three captures taken back-to-back in one window. Always re-run the `--skip
ocean` baseline in the same window as the change.

    node tools/capture.mjs --pose ref_01800 --skip ocean          --out shots/oc_A.png --settle 48
    node tools/capture.mjs --pose ref_01800                       --out shots/oc_B.png --settle 48
    node tools/capture.mjs --pose ref_01800 --config oceanFoam=0  --out shots/oc_C.png --settle 48

## 2. Headline: before / after

`water` ROI at ref_01800, ocean ON vs the same frame with `--skip ocean`:

| water ROI      | BEFORE: no ocean | BEFORE: ocean ON | AFTER: no ocean (A) | AFTER: ocean ON (B) | ref kf_01800 |
|----------------|-----------------:|-----------------:|--------------------:|--------------------:|-------------:|
| lap_var        | 416.87           | **337.55**       | 512.01              | **945.39**          | 1375.88 |
| edge_density   | 0.0670           | **0.0417**       | 0.0718              | **0.1021**          | 0.1968 |
| lum_std        | 28.47            | 15.92            | 28.14               | 24.34               | 45.41 |
| sat_mean       | 27.86            | 33.99            | 27.99               | **38.83**           | 60.62 |
| p01            | 38               | 95               | 57                  | 58                  | 23 |
| local_contrast | 0.095            | 0.0478           | 0.0948              | 0.0718              | 0.1497 |

The sign is flipped. The module used to *remove* 19% of the empty scene's water-ROI
lap_var; it now **adds 85%** (512 -> 945), and edge_density +42%. From 24.5% of the
kf_01800 target to 68.7%.

Other regions, same window (A = no ocean, B = ocean ON, ref = kf_01800):

| ROI       | metric | A (no ocean) | B (ocean ON) | ref | was (ocean ON, before) |
|-----------|--------|-------------:|-------------:|----:|----:|
| shoreline | lap_var| 425.91 | **902.12** | 914.88 | 209.78 |
| shoreline | edge   | 0.0855 | 0.1023 | — | — |
| sand      | lap_var| 174.19 | **574.63** | 521.32 | 196.71 |
| sand      | lum_mean| 79.51 | 110.14 | 56.42 | 126.29 |
| horizon   | lap_var| 190.22 | **243.99** | 734.32 | 269.38 |

shoreline went from **-51% vs the empty scene** to **+112%**, landing at 98.6% of the
kf_01800 target. sand lap_var lands within 10% of ref.

## 3. What changed, and the experiment behind each

### (a) Foam saturation — the single biggest lever [review finding 2, CONFIRMED]
`FOAM_FRAG`: injection `brk*brk * uFoamGain * uDt * 3.4` against `tau = mix(0.65,1.55,shoal)`
has equilibrium 5.27, clamped to 1.0 — pinned at the ceiling over the whole shoaling
zone. `WATER_FRAG` then computes `thr = 1.06 - env*1.18`, which at env=1 is -0.12, so
`smoothstep(thr, thr+0.30, tex)` returns 1.0 for every possible `tex`: a solid opaque
white sheet.

Changed: gain `3.4 -> 0.50`, and `env = min(env, 0.85)` so the dissolve threshold can
never go non-positive.

Cost of foam, measured, before vs after:

    before:  foam ON 337.55 lap_var, oceanFoam=0 1166.35   -> foam destroyed 71%
    after:   foam ON 945.39 lap_var, oceanFoam=0 1016.69   -> foam costs 7%

Gain sweep in one window (water lap_var / edge): 0.35 -> 1090/0.1299, 0.50 -> 1054/0.1264,
0.65 -> 1006/0.1209. 0.50 chosen: 0.35 buys ~3% detail at the cost of a visible breaker
line, which is the thing the field exists to draw.

### (b) Reflection dark term [review finding 5, PARTLY CONFIRMED]
- Screen tap gated `R.y > 0.0` -> `R.y > 0.05`. At `R.y ~ 0` the infinity projection
  collapses to the horizon pixel row, so every grazing pixel fetched the same bright
  cloud/ring band.
- `below = clamp(-R.y*9.0,0,1)` -> `*26.0` (full dark by -2.2 deg, not -6.4).
- `deepBody` multiplied by 0.42 and the blend re-weighted `mix(refl*0.55, deepBody, 0.75)`
  -> `mix(refl*0.30, deepBody, 0.82)`: a below-horizon ray strikes the back of the next
  crest near normal incidence, where Fresnel is a few percent, so what returns is the
  absorbed body, not merely-dimmed sky.
- SSR march made linear over the first ~1 m: `t=0.06, dt=0.12` fixed for 8 steps then
  `dt *= 1.42`, 22 steps (was `t=0.30, dt=0.30` geometric from step 1, 18 steps), so the
  near cobbles / stack bases / wet beach are actually hit.

`--config oceanSSR=0` produces a different md5, so SSR is live and contributing.

**Did NOT fix shadow_frac.** water shadow_frac is 0.00042 against ref 0.02056 — a 49x
deficit, essentially unchanged. Null experiment that bounds it: forcing
`refl = mix(refl, vec3(0.0), below)` (a perfectly black below-horizon term) moves
p01 61 -> 51 and shadow_frac 0.00036 -> 0.0024 only. **So `below` cannot be the source of
the reference's dark pixels — even at its physical maximum it delivers 12% of the
target.** The reference's dark water is reflected sea stacks and visible dark seabed. The
seabed is not visible because the scene-wide albedo/exposure problem (see below) makes
everything, including the seafloor, near-white. Do not spend more effort on `below`.

### (c) LOD slope variance folding [review finding 4, CONFIRMED but LOW VALUE]
`WATER_VERT` scaled Gerstner amplitude by `lod` and discarded the slope. Added a per-band
accumulation of what the LOD threw away, passed as a new varying `vVarDrop`, added to
`varLost` in `WATER_FRAG` before roughness:

    vd += 0.5 * kA*kA * (1.0 - lod*lod) * vec2(a.x*a.x, a.y*a.y);   // kA = k*(A + 0.85*Ab)

Effect measured on the horizon ROI: lap_var 269 -> 286 in isolation, and in the final
A/B the ocean lifts horizon lap_var 190 -> 244 (+28%).

**Correcting the review's blame allocation on finding 4.** Horizon `sat_mean` is 25.7
with `--skip ocean` and 25.9 with the ocean on, against ref 79.88. The horizon ROI's
saturation deficit is essentially entirely sky/aerial, not water. Fixing this in ocean.js
is not possible.

### (d) Waterline flooding [review finding 3, CAUSE MISDIAGNOSED]
The review blamed 768x768 bathymetry quantisation (0.885 m/texel). **Disproved by
experiment.** Raising `BATHY_W/H` 768 -> 2048 (2.7x linear) changed sand ROI
`lum_mean` by 0.02 codes (114.155 vs 114.136) and *reduced* detail everywhere
(sand lap_var 719 -> 604, shoreline 1124 -> 999, water 1173 -> 1094). Reverted to 768.
The waterline position is not quantisation-limited.

Lowering `OC_RUNUP` 0.40 -> 0.05 moved sand lum_mean by 11 codes. **The gate height is the
cause, not the texel size.** Landed changes:
- `OC_RUNUP 0.40 -> 0.25` (Hunt gives ~0.37 m peak vertical run-up; the hard discard sits
  below peak so the upper beach drains).
- The thin-sheet sheen was pure `mix(body, refl, F) + spec`, i.e. brighter than dry sand —
  wrong sign. Wet sand is *dark* (pore space filled, multiple scattering lost) with a
  sheen on top: `wetCol = mix(bgRaw * 0.72, wetCol, 0.55)`, blend weight 0.55 -> 0.60.

sand lum_mean 126.29 -> 110.14 (empty scene 79.51, ref 56.42). Still the weakest number
in the file, but the residual is dominated by (e).

### (e) Fresnel is NOT the reason the water is pale — null experiment
Hypothesis: Schlick on the macro normal gives F ~ 1 over the whole surface at 1.7 m eye
height, so the body/seabed never shows and the water is a pure sky mirror. Tested a
roughness-corrected Fresnel `F = 0.02 + 0.98*pow(1-ndv,5) * (1 - clamp(rough*1.4,0,0.55))`.
Result: water lap_var **1111 -> 515** and sand collapsed to its `--skip ocean` values
(174.8 vs 174.2). Reverted.

**Conclusion, and it is the important one for the next agent: the reflection term carries
essentially 100% of this module's measured detail.** Any change that trades reflection for
body colour destroys the module. The pale/pink cast is not a Fresnel bug — it is the
ocean faithfully mirroring a sky and a terrain that are themselves near-white. `--skip
ocean` at ref_01800 shows white unlit terrain and a blown cloud deck; the ring's rose band
occupies a large fraction of the upper sky and reflecting it is correct behaviour.
**The ocean cannot be judged on colour until albedo/exposure lands.**

## 4. On `--skip` and the volumetricFog A/B (confirming the review)
`--skip` is consumed only by `src/modules.js:46`, which filters *modules*.
`volumetricFog` is a render `Pass` (`src/render/passes/volumetricFog.js:378`), so
`--skip volumetricFog` matches nothing and yields a byte-identical PNG. `--skip ocean`
*does* change the md5, which is how you tell the flag works and simply does not reach
render passes. Do not re-run that experiment.

## 5. Cost
`ocean` init 23.8 ms (bathymetry build, unchanged — 768x768 retained). Per-frame adds:
one `NW`-iteration loop in `WATER_VERT`, and 22 instead of 18 SSR steps on the subset of
pixels with `viewDist < 165 && R.y < 0.32`. `drawCalls` 605, unchanged.

## 6. Weakest thing left
`water` shadow_frac 0.00042 vs ref 0.02056 and p01 58 vs 23 — the ocean has no dark
pixels. Section 3(b) shows this is not reachable from the below-horizon term. It needs
either a visible (i.e. non-white) seabed or reflected geometry that is itself dark, and
both are gated on the scene-wide albedo/exposure work in other modules. Re-measure this
file after that lands; `edge_density` 0.1021 vs 0.1968 is likely capped by the same
global contrast deficit (`lum_std` 24.3 vs 45.4).
