# ring — the Halo ring arc (KNOWN_ISSUES §17.2)

Owner file: `src/world/sky.js` only.

**Headline: the ring's angular width law, its plane orientation and its arc azimuth are now
solved from the reference plate rather than fitted by eye. The two defects that made it read
as "two thin white lines" (Wave F) and "a vertical translucent column… a glass pillar, not
an arc" (Wave G, `reports/integrationG.md` cell 11) were both SIGN errors: the width flare
and the haze mix each varied with elevation in the wrong direction.**

Measured band width error against `kf_00600`, median over 17 cuts spanning el 15–64:
**−40% → −5%** (median absolute error 40% → 11%). Interior 8-bit contrast (std): median
**11 → 21** against the reference's 30. Ring-local laplacian variance, background-subtracted:
**64 → 246** against the reference's 316 — i.e. the object went from 5× under-detailed to
22% under.

---

## 0. The plate, and why the previous numbers were wrong

`kf_00600` is the **only** reference frame in which the ring is unobstructed. 68 horizontal
cuts at 10-px spacing; per row, background = median of the sky either side, band = the
largest contiguous run above `max(6, 0.25·peak)`.

`kf_00720` does **not** contain ring bands. `docs/WORLD.md` cites "two visible in kf_00720
(azimuth ≈ 356° and ≈ 300°)" and sizes the ring off them at "~0.6–1.2° wide". Crop
`kf_00720` at x 620–900, y 150–700 and the feature is a translucent glowing pillar with a
hard top and no banded surface — a Forerunner light conduit, the same family as the blue
chevrons at kf_00600 x 490–540. **The WORLD.md ring row is wrong by 3–6× on width and wrong
about which frames contain the object.**

### 0a. The band lies on a great circle to 0.050°, and its plane is tilted 1.55°

Convert each cut's centre to a world direction at the `ref_00600` pose; take the smallest
singular vector of the 68 unit vectors:

```
                        plane normal          rms resid   max resid
pitch 26 fov 78      el +1.55  az −103.84       0.050°      0.265°
pitch 24 fov 78      el +2.03  az −103.78       0.050°
pitch 28 fov 78      el +1.07  az −103.88       0.050°
pitch 26 fov 76      el +1.74  az −103.48       0.049°
pitch 26 fov 80      el +1.36  az −104.20       0.051°
```

An rms of 0.050° over 50° of elevation is the signature of a ring whose plane **contains the
eye** — which is what standing on the inner surface means; the plane's intersection with the
view sphere is a great circle by construction. It is not a skybox card. The fit is also
insensitive to the assumed pose, because a pitch error rotates the sky about the camera's
x-axis and the fitted normal lies within 14° of that axis, so a pitch error rotates the
normal about itself.

The normal sits at elevation **+1.55°**, not 0. `ringTrace` hard-coded `up = (0,1,0)` and so
could only ever draw a dead-vertical band; the reference leans 2.4° of azimuth across the
frame. The trace now takes an explicit `uRingUp` (observer → ring centre, unit,
perpendicular to the axis) and the axis carries a `tiltDeg`.

Band azimuth: camera-relative **−13.84°** → world 16.16 → `azimuthDeg` **163.84** (was
162.5, a 1.3° error).

### 0b. The width was measured in the wrong units, and was 32% low

`reports/sky.md` §0b measured **52 px at y 150–250** and set `widthRatio 0.087`. Pixel width
is not angular width off-axis: at el 52 the perspective projection stretches azimuth by
1/cos(el) = 1.63, and a single cut cannot see the flare law at all.

True great-circle angular width (`acos(d_left · d_right)`), least squares against sin(el):

```
    W(el) = 3.298° · sin(el)^−0.6179          rms 0.26° over 68 cuts
    measured  3.03° @ el 63.5   →   7.48° @ el 13.8
```

The el = 90 asymptote is `W/(2R)`, so **widthRatio = 0.1151** — 576 km on a 5000 km radius.
Exact cylinder geometry gives `sin(el)^−1`; the reference is shallower, so the km half-width
is scaled by `sin(el)^0.382` and the two laws compose to the measured one.

**The shipped exponent was `pow(du, 0.70)`, i.e. `sin(el)^−0.30`** — a band 3.0° wide at
el 63 and 3.4° at el 20 where the reference is 3.0 and 6.4. That is the flat column.

---

## 1. Before / after, `ref_00600`

Isolated rig (`--only time,lighting,sky,env,pipeline`) so the centre sea stack does not
occlude the band. Absolute codes differ from the full frame, so every column is a ratio or
an angle. "before" is the shipped tree captured through `git stash` on the *same* tree
minutes apart, so no other agent's concurrent edit is in the difference.

```
  el   |    angular width, deg     |  error %   |  interior 8-bit std  |  band/sky lum
       |  ref    before   after    | bef   aft  |  ref   bef    aft    | ref  bef   aft
 63.5  |  3.03    3.15    3.63     |   +4  +20  |  8.3   8.6    7.9    |1.20  1.45  1.24
 58.9  |  3.26    2.90    3.48     |  −11   +7  |  9.1  10.7   22.6    |1.30  1.42  1.41
 53.8  |  3.87    2.83    3.72     |  −27   −4  | 11.7   8.2   28.1    |1.31  1.48  1.52
 48.1  |  4.12    2.71    2.65 *   |  −34  −36  | 25.6   9.6   31.6    |2.08  1.39  1.97
 42.0  |  4.41    2.64    3.45     |  −40  −22  | 36.2  11.9   27.2    |1.77  1.28  1.66
 35.5  |  4.83    2.78    4.00     |  −42  −17  | 30.7  13.1   16.3    |1.54  1.34  1.44
 28.8  |  5.35    2.97    5.10     |  −44   −5  | 43.6  11.1   21.2    |1.70  1.29  1.45
 22.0  |  5.97    3.46    5.97     |  −42   −0  | 22.5   7.1   14.8    |1.53  1.20  1.30
 18.7  |  6.57    3.51    6.65     |  −47   +1  | 30.1   5.0   19.1    |1.62  1.17  1.25
 15.4  |  7.14    3.56    6.68     |  −50   −6  | 34.5  16.3   14.2    |1.57  1.22  1.25

 median |err|                          40%   11%
```

\* four rows (el 51.0, 48.1, 45.1, 25.4) are edge-detector dropouts, not real narrowing: a
deep-ocean stretch of the band falls below the 0.25·peak threshold and the run splits. They
are left in the table rather than filtered, and they are the whole of the residual median
error.

### 1b. Ring-local detail, isolated from the frame's own noise floor

Laplacian variance over the ring's bounding box (`y 0–700, x 760–920`, 112 k px) and over
the rest of the frame. Independent signals add in variance, so
`ring ≈ box − rest`:

```
                 full frame   ring box   rest of frame   → ring signal
  reference          101.4      400.5         84.4            316
  before             312.7      373.0        309.2             64
  after              320.1      552.7        306.8            246
```

**The object carried 1/5 of the reference's local detail and now carries 78% of it.** Note
also where the frame's `lap_var` overshoot actually lives: the rest of the frame is at 3.6×
the reference (307 vs 84) in both captures. That is not the ring's, and it is why the whole
frame's `detail` axis is what it is.

### 1c. Whole frame

`ref_00600`, same tree, stash A/B: **22.24 → 22.62** (structure 30.21→31.05, spectrum
88.94→94.35, detail 6.89→4.67). That is inside `KNOWN_ISSUES §26`'s ±0.5 noise band, so the
honest statement is **no measurable whole-frame change**; the ring is 1.5% of the pixels and
this pose's score is dominated by other subsystems mid-edit. The measurement that matters is
§1 and §1b.

---

## 2. What changed in `src/world/sky.js`

| # | Item | Before | After |
|---|---|---|---|
| 1 | `ringTrace` up-vector | hard-coded `(0,1,0)`; band could only be vertical | `uRingUp[k]`, so the ring's axis can tilt off horizontal (measured 1.55°) |
| 2 | width flare | `pow(du, 0.70)` → `sin(el)^−0.30` | `pow(du, uRingWidthExp)`, `ringWidthExp 0.382` → measured `sin(el)^−0.618` |
| 3 | `widthRatio` | 0.087 (435 km), from **pixel** width at one elevation | **0.1151** (576 km), from the great-circle width law's el=90 asymptote |
| 4 | `azimuthDeg` / `tiltDeg` | 162.5 / n/a | **163.84 / 1.55**, both from the great-circle fit |
| 5 | ring haze | `am = 1/sin(el)` — hazier toward the HORIZON | chord distance `t/(2R)`. See §3 |
| 6 | ring haze elevation dep. | — | `ringHazeK 16`, `ringHazeExp 12`, fitted to the reference's interior-std profile (8 codes at el 60, 34–44 at el 30–45) |
| 7 | rails | `0.34 · (1 − hz·0.40)` — brightest exactly where the reference has none | `0.085 · (0.22 + 0.90·hz)` — a thin rim only where the interior has been hazed flat |
| 8 | atmosphere double-count | ring mixed toward `inscatter` on its own 1/sin(el) airmass **and** `col = space·Tview + inscatter·(…)` applied our atmosphere again | the airmass term is deleted; the dome's transmittance is the only owner |
| 9 | surface land fraction | `land` opened at `cont 0.080`; band measured near-neutral 142/155/165 | sea-dominated (`land` 0.150–0.240); the reference's clear sections measure 96/134/179 |
| 10 | cloud | albedo 1.50–1.90, one coverage threshold everywhere | albedo 3.60–4.15 (tops reach the AgX shoulder — reference interior maxima are 240–251 in 33 of 34 cuts) and a synoptic field that varies the coverage **threshold**, so whole sections are overcast and whole sections clear |
| 11 | `brightness` | 1.15 | 3.20 (the haze mix is now 0.94 at the zenith end, so this lever moves the near end of the band and barely touches the far end) |

---

## 3. Method — the sign errors, and the experiment that separated them

Both defects are the same mistake: a law carried over from terrestrial intuition instead of
fitted to the object. **For a ring you are standing on, distance increases with elevation.**
The chord to the hit point is `t = 2R·sin(el)`: the zenith is the antipode at the full
10,000 km and the base of the band is only 3,000–4,000 km away. Everything you know about
"haze grows toward the horizon" is inverted for this one object, and the shipped code had
both the width flare and the haze mix carrying the inverted version.

The reference agrees and says so unambiguously: interior std **8.3 at el 63, 34–44 at
el 30–45**. The top of the band is the washed-out end.

**The experiment.** Two candidate causes for the too-narrow base: (a) the exponent, (b) the
haze eating the band's faint edges before the detector sees them. These are separable
without a capture, because the width is a closed form in the trace's own constants:

```
    W_ang(el) = (widthRatio/2) · flare(el) · sin(el)^(WEXP − 1)
```

Evaluating that for the shipped constants predicts **3.03° at el 63.5 and 3.42° at el 20.4**.
The shipped capture measured **3.15 and 3.03**. Prediction and measurement agree to 4% and
13%, so the geometry alone accounts for the flat band — the haze is not eating the edges,
and no amount of haze tuning would have found it. One step, before touching a constant.

The haze law was then fitted separately, to the interior-std profile rather than to the
appearance, and it comes out very steep (`sd^12`). I do not believe that is a real
extinction law; I think part of what the plate shows at the top of the band is a real
overcast region on the ring's surface rather than aerial perspective. It is fitted because
it reproduces the measurement, and it is flagged here because it is the one constant in this
change that is a curve fit and not a solved geometric quantity.

---

## 4. Cost

No new pass, no new texture, no new geometry — the ring is still two analytic
cylinder intersections inside the existing sky-dome fragment shader. Added: one `vec3`
uniform array (`uRingUp`), two `float` uniforms, and two extra 3-octave `fbm2` calls in
`ringSurface` (the synoptic coverage field and the ragged cloud edge). Both sit inside the
`band > 0.001` branch, which the band covers on **1.5% of the frame** at `ref_00600`
(112 k px of 2.07 M, and the band is under half of that box). Upper bound on the added work
is therefore ~2 × 3-octave value noise on <1% of one full-screen pass.

**I did not run `tools/_perfprobe.mjs`.** It launches its own Chrome, and `free -g` reports
15 of 15 GB used with 0 available — exactly the condition `KNOWN_ISSUES §19` records as
having OOMed the box. Someone with the machine to themselves should confirm the bound.

---

## 5. Still open / weakest thing left

1. **The band's near end is ~20% dimmer than the reference** (band/sky 1.25–1.30 at
   el 15–22 against 1.53–1.62) and its far end ~1.5× too contrasty (std 8–23 at el 58–63
   against 7–9). Both are dominated by **where the noise realisation puts its overcast
   section**, not by a law: in `kf_00600` the solid deck is at the top of the band and the
   clear ocean at the bottom, and ours is the other way round. Pushing the chord-haze
   exponent any harder to close that would be fitting a law to one realisation of a random
   field — `ringHazeExp` is already 12, steeper than any real extinction. The right fix is a
   phase offset on the surface field along the arc, chosen once against this plate.
2. **`ring[1]` almost certainly should not exist.** The second segment (`opacity 0.40`,
   `azimuthDeg 106.5`, `arcDeg 84`, `leg 1`) was added to reproduce `docs/WORLD.md`'s "two
   bands in kf_00720", and §0 shows those are light conduits. I left it in because it
   appears in showcase framings and deleting it is a composition decision, not a correctness
   fix. It inherits the new width and haze laws and is dim enough not to distort anything.
3. `arcDeg 176` terminates the band ~4° short of the zenith so the two legs do not collide
   on the singular point directly overhead. No reference frame looks above el 65, so this is
   unconstrained — `diag_zenith` is the pose to check it on if anyone cares.
4. **`docs/WORLD.md`'s Halo-ring row is wrong** on width (3–6×) and on which frames contain
   the object. Whoever owns that file should fix it; the numbers to use are in §0.
5. `KNOWN_ISSUES §24` (TAA black corruption over the water at `shot_sky_ring`) is still
   plainly visible in `shots/ring/shot_ring.png`. Not this file's.
