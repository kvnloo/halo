# structures — Forerunner alloy albedo

File owned: `src/world/structures.js` (only file touched).

## Method

The whole-frame `ref_00000` capture is useless for this subsystem (see "Blocking
finding"), and other agents are editing the scene while I measure — two no-bridge
baselines captured 40 min apart differ by mean-abs 6 code values. So every number
below comes from an **isolated, masked, same-session** measurement:

```bash
node tools/capture.mjs --pose P --only time,lighting,sky,structures,pipeline --out A.png
node tools/capture.mjs --pose P --only time,lighting,sky,pipeline           --out B.png
# bridge mask = pixels where |A-B| > 6 on any channel -> an exact semantic mask
```

Script: `scratchpad/bridgestats.py`. The "before" row was re-captured against the
*same* sky by temporarily restoring the old shader (`scratchpad/mklegacy.py`), so
before/after differ only by my edit. Reference numbers are hand-crops of pure alloy
in `ref/keyframes/kf_00000.png` (bridge occupies x 360-1250, y 210-620 there).

## BLOCKING FINDING — the bridge is not in frame at any scored pose

At `ref_00000`, isolating `structures` and differencing against a no-structures
capture puts **every** structure pixel in `x 1304-1919, y 0-405` — the extreme right
edge — and all *hard geometry* (delta > 50) in `x 1858-1919`, **503 pixels, 0.02% of
the frame**. The rest of that right-edge region is the dust-haze billboards bleeding
into the sky. `ref_02220`, documented as "bridge silhouette against bright sky",
renders **34** pixels at delta > 6 and **zero** at delta > 25. `ref_00120` is the
same picture as `ref_00000`.

In `kf_00000` the bridge occupies x 370-1250 — 46% of the frame width, left of
centre. It is the composition.

The geometry is where `docs/WORLD.md` puts it (anchor (54,60) -> tip (-34,-4), deck
y 21.5; confirmed in `shot_overview`). The camera is the problem. At `ref_00000` =
pos (10.5, 1.74, 20), yaw 292 deg, three.js YXZ forward is
`(-sin y, -cos y) = (+0.927, -0.375)`:

- the deck centreline passes through (10.5, 28.4) — **21 m directly overhead**;
- the anchor is 64.6 deg off-axis to the right, outside the 55 deg half-FOV;
- the tip is at dot -0.64, i.e. **behind the camera**.

`WORLD.md`'s documented spawn — "(6, 1.72, 16) yaw 288, looking WNW down the beach
at the bridge" — has the same defect: the tip is at dot -0.71, behind the player.
So either the yaw convention is mirrored or the bridge run is reversed relative to
the camera track; it is not a small offset.

**Consequence: no change to `structures.js` can move the score at any `ref_*` pose
until this is fixed,** and the brief's premise ("the reference bridge reads as a dark
silhouette against a bright sky in kf_00000 — that contrast is the whole composition")
cannot be tested at `ref_00000`. `poses.js` and `WORLD.md` are not my files; this is
for the pose-refit task in KNOWN_ISSUES #3. Cross-check: `shots/preview/ref_00000.png`,
captured before this session, shows the bridge as a thin sliver on the horizon.

## What was actually wrong

Not "albedo too high" in the naive sense. The palette was already 0.088-0.205 linear,
which renders 128 because `keyedExposure` puts a **0.18 horizontal albedo exactly on
code 128** — so a sunlit deck reads its own albedo, and 128 *is* 0.18. Two real defects:

1. **The palette was achromatic.** uAlloyLight 0.205/0.194/0.183 = 11% linear channel
   spread; the rendered deck measured BGR (127.4, 127.7, 130.2), a sat-of-mean of 5.9
   against the reference's 21. Every pure-alloy crop in kf_00000 has **green as its
   minimum channel** (lab_a +0.8 to +6.9) with lab_b swinging -6 (cold mauve plates)
   to +13 (khaki soffit).
2. **One flat tone.** The panel step was +/-21% and the fbm bands were used raw —
   fbm hardly ever leaves [0.35, 0.65], so three octave layers together moved the
   albedo by +/-25% total. Measured std 14.5 against a reference 18-40.

Point 2 is why the first fix attempt failed instructively: pushing the tint alone
(uAlloyLight -> a strong mauve, uDustCol -> R/B 2.6) moved `sat_mean` on the sunlit
deck from 11.4 to **11.2**. `sat_mean` is the mean of *per-pixel* saturation, so a
uniform surface measures its sat-of-mean no matter how far the hue is pushed. It is
bought with variety, not with a stronger tint on one colour.

## Changes

- **Palette re-authored from measurement**, linear: `uAlloyDark` 0.076/0.053/0.056
  (lum 0.058), `uAlloyLight` 0.206/0.148/0.152 (lum 0.161), `uAlloyWorn`
  0.246/0.202/0.206, `uDustCol` 0.205/0.141/0.078 (lum 0.150). Desaturated mauve-taupe,
  green minimum in all of them.
- **Cloudy staining, expanded.** Zoomed into kf_00000 the fascia is mineral staining
  1-3 m across at nearly 2:1 in value. Three bands (10 m / 2.3 m / 0.7 m) are now
  summed with gains 1.75 / 2.30 / 0.85 into one `tone`, instead of being multiplied
  in raw. Panel step widened to 0.66 + 0.70*cell.
- **Hue decorrelated from value.** A per-panel + per-patch field drives
  `mix(uTintCool 0.94/0.96/1.24, uTintWarm 1.10/0.99/0.74)`. The field is the
  *difference* of two octave bands the tone already paid for (the tone is their
  weighted sum), so it is free — a dedicated 3-octave fbm for it cost 0.5 ms/frame
  and moved `sat` by 0.0, and was removed.
- **Dust is drifts, not a wash.** It was mixing 60% toward one ochre on every upward
  face — exactly where the deck read flattest. Expanded so bare alloy shows through,
  capped 0.80 -> 0.62, and its value now follows the plate underneath (thin dust over
  dark metal is dark dust).
- **Chamfer wear leans on specular, not paint**: albedo mix 0.75 -> 0.70 toward a
  darker `uAlloyWorn`, roughness drop 0.75 -> 0.85.
- **Emissive strips**: `uEmisGain` 2.2 -> 1.15, so they stay accents against a darker
  alloy. Sand bounce on the soffit 0.75 -> 0.95, `uBounceCol` warmer.
- `--config alloyGain=X` scales the whole albedo family, for the scheduled
  post-Phase-3 grade calibration.

## Measured, same sky, isolated + masked

| pose | metric | before | after | reference envelope |
|---|---|---:|---:|---|
| `shot_overview` sunlit deck + anchor, 30 m | lum | 122.35 | **112.88** | 84 - 105 |
| | std | 14.45 | **15.26** | 18 - 40 |
| | sat | 11.97 | **16.90** | 24 - 42 |
| | lab_a | +0.89 | **+2.58** | +1.6 … +4.9 |
| | lab_b | +0.51 | **-0.67** | -6 … +13 |
| | lap | 142.4 | 134.2 | 151 - 330 |
| `diag_bridge` soffit + struts | lum | 92.10 | **88.55** | |
| | sat | 29.58 | **34.34** | |
| | lab_a | +0.51 | **+2.47** | |
| | lap | 423.2 | 368.2 | |
| `shot_forerunner_bridge` | lum | 83.55 | **81.39** | 80.5 / 94.6 (struts) |
| | sat | 35.47 | **40.00** | 37.7 / 38.5 |
| `shot_bridge_underside` | lum | 83.29 | **80.02** | |
| | sat | 31.64 | **40.30** | |

Reference crops (kf_00000, pure alloy): deck_top_flat lum 102.2 std 29.2 sat 27.9
lab_a +4.93 lab_b -1.90; deck_top_flat2 84.1 / 18.1 / 42.2 / +1.63 / +5.05;
strut_face_lit 80.5 / 27.8 / 37.7; strut_face_2 94.6 / 39.6 / 38.5; soffit 67.0 /
19.8 / 98.1 / lab_b +12.71; sky directly above the bridge lum 184.8.

Deterministic: two full captures at `diag_bridge` byte-identical.

## The bridge is still not dark enough, and it is not the albedo

`--config aerialDensity=0`, final shader, same masks:

| | aerial 0.0062 (ship) | aerial 0 | reference |
|---|---:|---:|---|
| `shot_overview` lum | 112.88 | **105.67** | 102.2 |
| sat | 16.90 | **23.52** | 27.9 |
| std | 15.26 | **20.07** | 29.2 |
| lap | 134.2 | **194.4** | 150.7 |
| `shot_bridge_underside` lum | 80.02 | **57.55** | 67.0 |
| sat | 40.30 | **100.56** | 98.1 |
| lab_a / lab_b | +3.54 / -3.04 | **+6.27 / +4.10** | +1.63 / +12.71 |
| lap | 326.6 | **463.8** | 214 - 955 |

With the aerial term off the bridge lands on the reference envelope on every axis.
With it on, at **25-40 m** it loses 7 lum-worth of lift and 7 saturation points on the
deck, and 22 lum and **60 saturation points** on the soffit.

`src/gfx/materialCommon.js` `wmAerial()`: `uAerialGroundColor` defaults to
(0.62, 0.60, 0.55) **scene-linear** and `lighting` never overwrites it (it only sets
sun dir/colour and sky colour). A 0.15-albedo surface under this scene's irradiance
(E ~ 4.3, sun 6.2 at 41 deg + hemi 1.35) reflects `0.15 * 4.3 / pi` ~ 0.21. **The haze
colour is three times brighter than the brightest thing it is fogging.** With
`uAerialDensity` 0.0062 and `uAerialStart` 6, the mix fraction is 0.14 at 30 m,
0.28 at 60 m, 0.44 at 100 m — so nearly half of every 100 m surface is replaced by a
flat grey brighter than the surface itself. That is a bright achromatic lift applied
to every world material, i.e. the exact signature reported in KNOWN_ISSUES #8
(lum +36, sat -44) — and it is *not* fixable in the material modules.

Not my file; not fixed here, and deliberately not compensated for inside
`structures.js` (that would be wrong twice over once the shared layer is corrected).
Recommended: drop `uAerialGroundColor` to roughly the ground's own radiance
(~0.10-0.15) and have `lighting` drive it from the terrain albedo, and/or reduce
`uAerialDensity` so the mix is negligible under ~80 m. Reproduce in one line:

```bash
node tools/capture.mjs --pose shot_bridge_underside --only time,lighting,sky,structures,pipeline \
  --config aerialDensity=0 --out /tmp/a.png --settle 32
```

## Cost

No geometry, draw-call, texture or uniform-count change (init still 28 ms, one merged
mesh, one draw call). The fragment shader is **+1 `vnoise2` and +1 `hash12` per bridge
fragment** over the previous version. Min-of-3 wall-clock A/B at `diag_bridge` (bridge
fills ~50% of a 1080p frame): **3.17 ms/frame new vs 3.34 ms/frame old** — the delta is
inside a +/-1.5 ms noise floor caused by concurrent agents sharing the GPU, so treat it
as "not measurable". The intermediate version with a dedicated 3-octave fbm for the hue
field measured min 3.67 ms against the same baseline; that cost was real, so it was
removed for no quality loss (sat 16.90 vs 17.01).

## Weakest things left

1. **The pose/layout mismatch above.** Everything else is moot until it is fixed.
2. **The aerial lift.** Costs the bridge 7 saturation points at 30 m and 60 at the
   soffit. Biggest single remaining error on this subsystem and it is not in this file.
3. `lap_var` on the sunlit deck is 134 (194 without aerial) against a reference
   150-330. The reference deck top carries **crisp recessed inset plates** on the
   walking surface that this build only has on the fascia — that is geometry, not
   shading, and it is the honest way to close the gap. I did not chase it with noise:
   broadband high frequency raises `lap_var` while pushing `spectral_slope` the wrong
   way, which the metric catches.
4. Soffit `lab_b` is +4.1 (aerial off) against a reference +12.7 — the sand bounce is
   still too weak/too neutral. `uBounceCol` is hard-coded; it should be sampled from
   whatever the terrain module ends up authoring, once sand albedo settles.
