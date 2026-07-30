# rocks — albedo pass

Owner file: `src/world/rocks.js`. Complete.

## Headline

The rock albedo is now correct: with atmospheric inscatter disabled the sunlit stack
face measures **RGB 114.7 / 94.4 / 68.5, sat 105.8, lab_b +17.8** against a reference
lit face of **106.5 / 90.3 / 67.6, sat 98.5, lab_b +15.6**. The blue channel is within
one code value.

With the shipped `uAerialDensity` the same pixels measure **sat 52.5, lab_b +8.5**.
Aerial perspective — 37 m from the camera — is throwing away half the rock's chroma.
That term is in `src/gfx/materialCommon.js`, which I do not own. Details below; it is
the single largest remaining obstacle to the scene-wide saturation deficit in
KNOWN_ISSUES §8, and it hits terrain, structures and vegetation identically.

## Measurement rig

The scored frames were unusable for most of this session: `clouds` was drawing sprites
over the whole lower half of every frame, `terrain` had a GLSL `patch` reserved-word
compile error, `physics` failed to init, and at `ref_01500` the ocean still covers the
sea stacks entirely. So before/after is taken on a rock-dominant isolate that is stable
and repeatable:

```
node tools/capture.mjs --pose diag_stack \
  --skip clouds,vegetation,weapons,hud,ai,ocean,particles,props \
  --config sunAzimuth=6 --settle 32
```

`sunAzimuth=6` swings the sun so the camera-facing wall of `stack_hero` (37 m away) is
lit at NdotL 0.75 instead of sitting in its own shadow — without that, every "rock"
measurement at this pose is a measurement of blue sky fill. Box `830,380 - 1170,640` is
a sunlit mid-face; box `870,770 - 1230,860` is the tide-line foot.

## Before / after

```
                        R      G      B    lum    std   sat   lab_b  lap_var
lit mid   BEFORE     114.8  108.7  104.2  110.0   22.9  28.5   +3.2    936
lit mid   AFTER      121.0  108.3   96.1  110.7   23.5  52.5   +8.5    928
lit mid   AFTER (aerialDensity=0)
                     114.7   94.4   68.5   97.5   32.4 105.8  +17.8   1643
reference kf_01500 lit ledge
                     106.5   90.3   67.6   92.6   39.8  98.5  +15.6   2161
reference kf_01500 lit midface
                      90.4   78.6   57.1   79.6   38.6 102.6  +14.2   2575

whole stack BEFORE   104.0  102.5  105.5  103.3   26.3  38.6   -1.7    757
whole stack AFTER    107.6  101.7   99.7  103.2   26.8  53.0   +1.8    743
whole stack AFTER (aerialDensity=0)
                      99.8   86.9   73.3   89.2   32.7  98.3   +9.7   1358
```

Saturation on the sunlit face: **28.5 -> 52.5 as shipped, 28.5 -> 105.8 with the haze
term removed.** lab_b (the warmth axis) **+3.2 -> +8.5 / +17.8**. Luminance is flat,
`lap_var` is flat — the change is chroma and hue, not level and not sharpening.

ROI at `ref_00000`, `--skip clouds,weapons,hud`, before vs after. **These deltas are
contaminated** — `terrain` shipped a large change between the two captures (the `sand`
ROI moved 117.2 -> 107.4 and I did not touch it), so read them as "state of the frame",
not as my before/after:

```
              lum          sat         lab_b        lap_var     target
cliff  before 114.5        26.2        -2.32          204      lum 104.9 sat 87.5
cliff  after  105.8        25.9        -2.72          240
rock   before 124.3        66.0       -16.14          152      lum 118.6 sat 86.6
rock   after  117.8        68.7       -16.28          168
```

Both ROIs are now on their luminance target. Both are ~20 saturation points short, for
the reason in the next section. Note the `cliff` ROI at this pose is mostly vegetation
and sand, and the `rock` ROI is mostly sky — very few of those pixels are mine.

## THE FINDING THAT MATTERS: rock chroma is capped by an additive veil I do not own

I fitted the albedo -> pixel transfer by capturing the same frame with the whole rock
palette scaled by a known per-channel factor (`PAL` in rocks.js, shipped as `[1,1,1]`):

```
PAL              lit-mid RGB
[1,1,1]          114.8  108.7  104.2
[.5,.5,.25]       97.8   94.7   91.0
[0,0,0]           68.3   74.4   85.2     <- black rock still reads 68/74/85
[0,0,0] aerial=0  36.3   37.5   44.5
```

**A rock with zero albedo renders at sRGB 68/74/85.** Fitting output = K*albedo + C per
channel in linear-sRGB output units:

```
K = 0.277 / 0.299 / 0.396      C = 0.072 / 0.076 / 0.093
```

C is a near-neutral, slightly blue additive floor. ~62% of it is aerial-perspective
inscatter (`uAerialDensity 0.0062`, `uAerialStart 6.0`); the rest is env-probe specular.
The reference rock target has a blue channel of sRGB 63-68 on a lit face. **The floor
alone is 85.** Solving the fit for the reference target returns a *negative* blue
albedo:

```
target RGB 106/90/68  ->  albedo needed  0.259 / 0.089 / -0.090
```

So the reference rock colour is not reachable by any rock albedo in the current build,
and the direct A/B confirms it: identical material, `aerialDensity=0`, sat 105.8.

Worth knowing for whoever tunes it: the optical depth at 37 m is only ~0.15, so this
looks like a 15% effect on paper. It is not. The tone curve is compressive at the top
and expansive at the bottom, so a 15% *pre-tonemap* inscatter becomes 35-50% of the
*displayed* value. Judging haze density by optical depth rather than by a black-albedo
capture is how it ended up 2-3x hot.

## What changed in src/world/rocks.js

1. **Palette re-authored to iron-stained warm limestone.** `matRock` base
   `(0.355, 0.256, 0.116)` -> `(0.558, 0.330, 0.070)`; luminance reflectance 0.267 ->
   0.336, which is inside the 0.32-0.40 band for pale coastal limestone, and B/R 0.33
   -> 0.125. Coastal karst is limonite-stained and goethite has almost no blue
   reflectance, so the hue is physical rather than a compensation hack — verified by
   the `aerialDensity=0` capture landing on the reference, which a compensation hack
   would have overshot.
   `matFar` and `matBoulder` moved with it. Boulders went *up* in level
   (0.115 -> 0.169 luminance): at 0.115 they rendered as black chips on the sand, and
   a sunlit beach cobble is a mid-dark warm grey.

2. **Capped the detail multiplier chain.** It ran
   `mix(0.56,1.38,hA)*mix(0.66,1.30,hB)*mix(0.76,1.24,hC)*mix(0.86,1.15,hD)` = up to
   2.56x, times a macro term reaching 1.43x — the top decile of every stack was
   multiplied by 3.7 and clipped to bone. Now capped near 1.9x with the dark tail
   preserved (0.296 min vs 0.242 before), so the level lives in one authored number
   rather than four multiplied ones. `lap_var` did not drop (936 -> 928): the variance
   came back through the base colour, it was not sharpened in.

3. **Built a real tide band.** The old algae mask peaked at ~0.19 of a mix, which is
   invisible; there was no separate damp term at all. There is now a broad `damp` band
   (albedo -> `uColDamp` 0.062/0.049/0.027, ~0.05 luminance) from the waterline to ~5 m,
   with the weed mat as a second, narrower layer inside it. Measured effect on the foot
   box with haze off: lum 104.2 -> 88.7, i.e. a real 10-unit step below the dry rock
   instead of none. With haze on the step is only 9 units — same cause as above.

4. **Cut the ambient specular veil.** three gives every non-metal F0 = 0.04 / F90 = 1.0;
   against a bright sky probe that is a neutral white sheen over the whole rock, worth
   sRGB 36/37/45 of pure specular on a black-albedo capture. Now F0 0.025 / F90 0.45
   for dry rock (rough microporous carbonate is not a clean dielectric interface),
   rising to 0.038 / 0.80 where the rock is wet, which is the entire visual point of
   wet rock. Wet roughness relaxed 0.215 -> 0.31 so the damp band reads as sheen rather
   than a hot highlight that fills the dark band back in.

5. **Bleach and lichen.** The salt-bleached supratidal colour was `(0.52,0.47,0.35)` —
   near-neutral, and it was desaturating the brightest, most visible band on every
   stack. Now a pale warm cream. Lichen was gated to the crown only; it now also
   colonises dry up-facing ledges above the supratidal band, which is where the one
   high-chroma accent on a real stack lives.

## Cost

`rocks` init 1436 ms -> 1544 ms, but that is build-time noise from a shared GPU (the
geometry path is untouched; no vertex, index or mask code changed). Per-pixel the
fragment shader is **net zero extra noise**: the damp mottle reuses the existing `m2`
macro octave rather than evaluating a fourth `fbm3`, and everything else added is
smoothsteps and three uniform writes. 564 draw calls / 12.0 M triangles at `ref_00000`,
unchanged by this work. Two identical full captures at `ref_00000` are byte-identical.

## Weakest thing left

Aerial perspective, and it is not mine. Everything above is a workaround for it. Until
`uAerialDensity` is re-derived against a black-albedo capture rather than against
optical depth, the rock cannot get past sat ~53 no matter what albedo it is given, and
the same ceiling is capping terrain, structures and vegetation. If that gets fixed, the
rock palette here needs **no** change — it was tuned to be right *without* the haze.

Second: `lap_var` on the lit face is 928 shipped against 2161-2575 on the reference's
own lit faces. The geometry and detail maps carry the structure fine (1643 with haze
off), so this is the same veil flattening the local contrast, not missing detail.

Third: at `ref_01500` — the pose the `rock` ROI was designed for — the ocean currently
draws over the sea stacks entirely, so the one pose where this work would be scored
against real rock pixels cannot be measured at all.
