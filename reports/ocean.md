# ocean — checkpoint (2026-07-30, second pass after REJECT 3/100)

Owned file: `src/world/ocean.js` only.

> **Read section 1 before believing any absolute number in this file or in the review.**
> The scene moved under me mid-session: at 16:01 `terrain` rendered pure black, `clouds`
> and `vegetation` failed to compile at all, and the viewmodel came and went. Only
> back-to-back captures inside one window are A/Bs.

## HEADLINE

Same-window `--skip ocean` -> ocean ON at ref_01800 (§3.6), **`shoreline` ROI**, which is
the region this module is actually responsible for:

```
                 ocean OFF   ocean ON   kf_01800   SIGNATURE
lum_std              28.93      42.63      41.96       42.69
local_contrast     0.09316     0.1562      0.142        0.15
lap_var               1391      911.6      914.9       695.6
edge_density        0.1746     0.1297      0.166       0.127
spectral_slope      -1.744     -2.385     -2.292      -2.347
sat_mean             23.53       45.1      50.62       69.31
```

Five metrics land within a few percent of the signature and `lap_var` is within 0.4% of
the kf_01800 crop. Everything moved the right way.

In the `water` ROI the broadband hash the critic identified is gone — `lap_var`
973 -> 643 against a 677 signature, `spectral_slope` −2.34 -> −1.75 — and the near-field
patch went (103.7, 113.3, 135.2) -> (70.0, 88.1, 93.6) against a reference
(45.7, 43.5, 44.1). But **the module still lowers `water` `lum_std` (23.8 -> 18.3) and
`local_contrast` (0.075 -> 0.051)**, which is the same shape of failure as before at a
smaller magnitude. §3.6 and §5 say exactly why and what to do.

`sand` flooding: the ocean used to add **+27.8** codes to `sand lum_mean` and 3.3x the
reference's whole sand `lap_var` budget; it now adds **+11.1** and *removes* 55 of
`lap_var`.

---

## 0. What the previous pass got wrong, and how it was settled

The critic's verdict was right and the previous report's headline was wrong for a
diagnosable reason: it read `lap_var` alone. `lap_var` up + `local_contrast` down +
`lum_std` flat is not "more detail", it is **pixel-scale hash**. The module was
manufacturing exactly the broadband noise its own header says it exists to avoid.

The three numbers that have to move together, and the direction each has to move:

| water ROI, ref_01800 | before | signature | kf_01800 | wanted |
|---|---:|---:|---:|---|
| lap_var        | 973.4  | 676.6 | 1375.9 | **down** toward 677 |
| local_contrast | 0.0786 | 0.142 | 0.1497 | **up** |
| lum_std        | 25.53  | 40.96 | 45.41  | **up** |

Treating a `lap_var` drop as a regression is what produced a 3/100.

---

## 1. Measurement hygiene — the scene is not stable

`terrain`, `clouds`, `vegetation`, `tonemap`, `volumetricFog`, `rocks` and `structures`
were all being edited during this session. Observed inside 15 minutes:

```
16:01  --skip ocean at ref_01800 -> the entire lower frame is BLACK (terrain unlit)
16:01  GLSL: clouds.js  'cloudDensity'/'lightMarch'/'dualHG' : no matching overloaded function
16:01  JS:   vegetation.js  ReferenceError: mossTex is not defined
16:12  terrain renders again (cobbles visible), viewmodel gone
```

Consequences you must respect if you repeat any of this:

- **Every A/B below is a set of captures taken back to back in one window.** Comparing
  a number from window X against a number from window Y is not an experiment.
- `--skip ocean` is the only honest control, and it must be re-captured in the same
  window as the change.
- `--skip <renderpass>` does nothing. `src/modules.js:46` filters *modules*;
  `volumetricFog` is a `Pass`. Use `--config fogDensity=0`. (Confirmed again.)
- zsh does not word-split an unquoted `$args`, so a scripted sweep silently passes
  `"--skip ocean"` as one token and every variant comes back byte-identical. Write the
  flags out literally, as the commands below do.
- Other agents write into `shots/` with `w_*` names too. Mine are `oc2_*`.
- **The dev server reads from disk at page load.** Editing `ocean.js` while a scripted
  battery is running silently changes the build under the later captures. Freeze edits
  for the duration of a battery.

### 1a. The backtick trap, again — and `node --check` does not catch it

`reports/ocean.md`'s previous revision records that a backtick-quoted `` `h` `` inside a
comment inside `OCEAN_COMMON` terminated the template literal and the module never
rendered a pixel. **It happened to me too, twice**, and the second time it got past
`node --check`:

```
"* The old form was `(0.055 + 0.30*thick) / max(viewDist*0.22, 1.0)` applied to the"
```

An **even** number of stray backticks re-closes the template, so the file still parses —
and the text between them becomes evaluated JavaScript. Result at runtime:

```
[capture] modules not loaded: ocean: thick is not defined
```

and a perfectly plausible-looking 1920x1080 PNG **with no water in it**, buried in a
1800-character JSON blob. I nearly measured it.

Two guards, both cheap, neither of which has an owner in `tools/`:

```python
# scan every /* glsl */` ... ` block for a backtick on any line
import re, sys
for path in sys.argv[1:]:
    src = open(path).read()
    for m in re.finditer(r"/\* glsl \*/`", src):
        b = src.index('`', m.start()) + 1; e = src.index("\n`;", b)
        for i, line in enumerate(src[b:e].split('\n')):
            if '`' in line:
                print(f"{path}:{src[:b].count(chr(10))+1+i}: stray backtick: {line.strip()[:120]}")
```

```bash
# and never accept a capture that says the module did not load
node tools/capture.mjs ... > "$LOG" 2>&1
grep -q "not loaded: ocean" "$LOG" && { echo "FAIL: ocean did not load"; exit 3; }
```

This is the third time this file has been measured against a build that was not running.
It needs a CI gate over `src/**`, not a note in a report.

---

## 2. What changed, and the published technique behind each

Everything here is `src/world/ocean.js` only.

### 2.1 Sea state: the table was built for the wrong ocean [critical 1]

`WAVE_BANDS` was tuned to Cox–Munk at the 5.4 m/s **open-ocean** wind `time` reports:
`rho = A/L = 0.0119`, `Lp = 28 m`, deep-water `Hs = 4*sqrt(sum(A^2)/2) = 1.29 m` before
Green's shoaling and before the bore term. kf_01800 and kf_00000 show a **sheltered
lagoon inside a reef**: an unbroken cloud reflection runs continuously across ~20 m of
surface, and the near-field crop (`ref/keyframes/kf_01800.png`, x0-1040 y820-1080) is
glassy wet sand with a millimetre sheet over it and no wave structure at all.

New table: same geometric ladder and the same direction ratios, `rho = 0.0032`,
`Lp 28 m -> 14 m`, shortest band `1.6 m -> 0.88 m`.

```
deep-water Hs = 4*sqrt(sum(A^2)/2) = 0.172 m          (was 1.29 m)
mss(geometric) = 8*(2 pi 0.0032)^2/2  = 0.0016        (was 0.0224)
mss(chop)      = 7*(2 pi 0.0080)^2/2  = 0.0088        (was 0.0070)
mss(total)     = 0.0105                                (was 0.0294)
   -> Cox-Munk 0.003 + 0.00512*U  =>  U = 1.5 m/s, a light breeze inside a reef
```

Chop wavelengths pushed down one notch (`1.90..0.145 m` -> `1.10..0.085 m`) because the
reference's visible ripple at ~5 m range is 0.3–0.6 m, not 1.6 m.

Crest **shape** is now bought with `Q`, which is free, instead of with `A`, which is not:
`Q_i` raised so `sum Q_i k_i A_i = 0.37` at rest and up to the GPU Gems ceiling of 1.0 as
`brk` and `Ks` ramp inshore. Two related bugs fixed at the same time:

- the per-wave loop clamp was `0.92/(k A NW*0.30)`, i.e. it permitted `sum = 3.07` —
  **three times** the self-intersection limit. It is now `0.95/(k A NW)`, which actually
  enforces `sum Q k A <= 0.95` (GPU Gems ch.1 §1.2).
- Green's `Ks` was clamped to **3.2**. `Ks` reaches ~1.3 at `h = 0.05*L0`; a 3.2 ceiling
  let the shoaling ratio run to a factor the breaker clip then had to undo, so the surf
  zone's amplitude was being set by the clip rather than by the swell. Now 1.6.

`OC_RUNUP` re-derived from Hunt rather than left at a value fitted to the old sea state:
`tan b = 0.084`, `Hs = 0.17 m`, `L0 = 14 m` -> Iribarren `0.084/sqrt(0.17/14) = 0.76`,
`R2% = Hs*xi = 0.13 m`. **0.25 -> 0.12.**

### 2.2 Beer–Lambert on the Snell path, not the air-side path [critical 2]

This is the single largest colour error and it is research/ocean.md failure mode 3.

```
was:  pathView = min(column / max(-vd.y, 0.030), 55.0)      // 1/cos of the AIR-side depression, up to 33x column
      pathView = min(max(distance(bgPos,P), column), 55.0)  // the 3D slant, same error
      sunPath  = min(column / clamp(uSunDir.y, 0.2, 1.0), 34.0)
now:  pathView = column / cosInWater(max(-vd.y, 0.0))       // <= 1.512 * column, BY CONSTRUCTION
      sunPath  = column / cosInWater(uSunDir.y)
      skyPath  = column * 1.25                              // diffuse downwelling, mean refracted slant
      cosInWater(c) = sqrt(1 - (1 - c*c)/1.333^2)           // >= cos(48.6 deg) = 0.661
```

With `K.r = 0.365` and the 55 m clamp the old form evaluated `exp(-20) = 2e-9`: the
bottom term was **annihilated at every distance past the swash**. The 55.0 clamp was not
a safety net, it was papering over the wrong formula, and it is deleted — the Snell form
cannot blow up.

Three consequences fixed with it:

- `uScatterCol` was `(0.048, 0.300, 0.345)` — **10x** the derived `DEEP_SCATTER` green
  and **4.6x** its blue — so the volume term took over before the bottom term had died.
  Now the derived `(0.004, 0.030, 0.075)`, applied as a factor on a real downwelling
  irradiance `oc_edown()` rather than on an ad-hoc `0.048*sun + 0.75*sky`.
- `uExtinction` `(0.365, 0.056, 0.040)` -> `(0.45, 0.090, 0.045)` (research §3.3: Pope &
  Fry band-averaged pure water plus lagoon CDOM/carbonate fines; `K_B` sits between
  Jerlov IA and IB). These are now legitimate because they multiply a bounded path.
- the composition is the optically-shallow-water form (Lyzenga 1978):
  `L_up = bottom * T2 + L_deep * (1 - T2)`, `T2 = Tview * Tdown`. The old code added
  `inScatter * (1-trans)` on top of a `trans`-weighted bottom that had already been
  multiplied by a *partially applied* (`mix(1, transSun, 0.62)`) downwelling term.
- `oc_fallbackBottom`'s lighting was `sun*0.105 + sky*0.62` — a 0.105 fudge on the sun
  that under-lit the synthetic seabed by about an order of magnitude relative to the
  reflection it competes with. It is now `albedo * Edown / pi`.

### 2.3 The reflection: prefiltered, and bounded [critical 3]

Was: project the **fully perturbed** reflected direction to infinity and point-sample
`tOpaque` at that UV. At this FOV a ±10° normal perturbation moves the tap ±20° of
screen — about a third of the frame — and the only filtering anywhere in the file was
`mix(refl, uHorizonColor, clamp(rough*rough*1.3, 0, 0.12))`, a ≤12% lerp toward one
constant. That is the mechanism that produced +227% `lap_var` with **−45%**
`local_contrast`.

Now, the two things three.js's own `Water.js` does and this did not:

1. **The base tap is the flat-mirror direction** `reflect(-V, up) = (-V.x, V.y, -V.z)`
   projected to infinity — one smooth screen field — and the wave slope only adds a
   *bounded* offset, `distortion = N.xz * (0.001 + 1/dist) * scale`. The `1/dist` is the
   load-bearing part: without it distant water samples from wildly wrong places and
   smears along the horizon (verified against the r0.185.1 source; research §5.2).
2. **The lookup is a mip**, `textureLod(tRefl, uc, lod)`, of a new half-res
   cloud-composited copy of the frame with a full mip chain, with
   `lod = log2(max(1, rough * pxPerRad * uReflBlur))` from the roughness cone
   (`pxPerRad = projectionMatrix[1][1] * h/2`). A rough facet now **gathers** instead of
   point-sampling.

The prefilter target lives in this module (`reflRT`, `REFL_PREFILTER_FRAG`); three
regenerates its mips at the end of `WebGLRenderer.render()`, which `FullScreenQuad.render()`
goes through, so one draw leaves the whole chain valid. Compositing `clouds` into the
prefilter rather than at the tap means every mip carries the cumulus.

**The 22-step SSR march is deleted.** Measured by the critic and reproduced: `oceanSSR=0`
moved water `lap_var` 970.0 -> 973.4, i.e. ±0.35%, while running on every pixel with
`viewDist < 165 && R.y < 0.32`, and its result was being overwritten by the sky tap for
most pixels anyway.

### 2.3b The refraction tap could offset by 0.955 in UV — found by reading, not by the review

Not in the critic's list, and it is probably a larger contributor to the shard hash than
anything that was:

```
was:  float offScale = (0.055 + 0.30 * thick) / max(viewDist * 0.22, 1.0);   // thick = clamp(column,0,3)
      vec2  roff     = Nv.xy * offScale;                                     // Nv = view-space NORMAL
```

`Nv.xy` is not a tilt — for flat water seen at 50° it is ~0.77. Inside 4.5 m the divisor
pins at 1.0, so with `thick` at its 3 m clamp the offset reaches **0.955 in UV, i.e. the
whole frame**. The `ok` test (`step(rp.y, P.y + 0.06)`) rejects taps that land on sky,
but a tap that lands on distant terrain *below* the horizon passes it, and an unrelated
part of the image gets stamped into the near water.

The physical number is small and fully determined:

```
lateral displacement at the bed   d   ~= column * tilt * (1 - 1/n),  n = 1.333 -> 0.25
that offset subtends              d / viewDist  radians
which in UV is                    d / viewDist * P11 / 2
```

So `offScale = column*0.25*(P11*0.5)/viewDist`, applied to `Nv.xy - Nv0.xy` (the actual
view-space **tilt**, not the normal), hard-clamped to ±0.06 UV, with `uRefrScale`
(default 3.0) as the artistic multiplier on top. Sanity: 0.5 m of water at 5 m range with
a 0.05 slope displaces the bed 6 mm — about one pixel. The reference's near water shows
the seabed with essentially no distortion, so physically correct is also visually correct
here.

### 2.4 Per-band Nyquist LOD, and refraction [major 6]

**LOD.** Was one global `lod = 1 - smoothstep(260, 1250, d)` applied to all eight bands
equally. The disc's radial spacing is `max(0.14, r*0.0225)`, so the edge is 1.12 m at
50 m and 2.25 m at 100 m — five of the eight bands were past Nyquist **at full
amplitude** through the entire near field, and the ramp did not even begin until 260 m
where the edge is already 5.85 m. That is the source of the shard aliasing, and the
abrupt pale band beyond the ring is failure mode 19.

Now each band is faded independently on its **shoaled** wavelength against the analytic
local edge length, `fade = smoothstep(2e, 4e, L)`, which is GPU Gems ch.1 §1.3.3
literally. The removed `0.5*(kA)^2` goes into `varDrop` per band (Toksvig/LEAN) instead
of vanishing. The fragment-stage chop bands use the same `smoothstep(2*fp, 4*fp, L)`
rule (was `smoothstep(0.95, 0.30, fp/L)`, i.e. `[1.05 fp, 3.33 fp]`).

Side effect: the vertex shader's separate `NW`-iteration `vVarDrop` loop is gone —
`oc_surface` returns it, since it is already solving each band.

**Refraction.** `oc_surface` used `vec2 D = a.xy`, the deep-water direction, at every
depth, so crests marched diagonally onto the sand at a fixed angle forever — research
failure mode 9, "the most recognisable not-a-real-beach cue". Now `oc_wave` rotates each
band toward the uphill bathymetry gradient as it shoals:

```glsl
vec2 nBed = oc_bedGrad(p);                       // central difference, 2.4 m stencil
float bend = 1.0 - clamp(h / (0.5 * L0), 0.0, 1.0);
w.D = normalize(mix(D_deep, nBed, bend * 0.85));
```

The same bend is mirrored in the CPU twin (`waveDirCpu`), because physics and particles
read `heightAt()` — if the crests turn on the GPU and not on the CPU, anything standing
in the surf bobs to a different wave than the one drawn around it.

**Fold foam.** Tessendorf's `J-` is free: `Jxx = tx.x`, `Jyy = tz.z`, `Jxy = tx.z` are
already accumulated in the tangent frame.
`J- = 0.5*(tr - sqrt((Jxx-Jyy)^2 + 4 Jxy^2))`, `foamFold = smoothstep(0.40, -0.05, J-)`,
gated by `smoothstep(14, 3, h)` so it cannot produce failure mode 13 (white blotches in
deep water). Crest's shore-proximity source (`smoothstep(0.85, 0, h)`) added alongside it.
Both go into the **foam simulation only** — see §3.4 for why injecting a vertex-derived
foam term at shading time is a mistake regardless of how good the term is.

### 2.5 Glitter, SSS, foam shading [major 4, major 6]

- **Glitter.** `highlight_frac` was **0.0** in our water at both poses against 5.4e-6 at
  kf_01800 and 0.0247 at kf_00000, with `p99` 166 vs 191. The lobe had an alpha floor of
  0.005 and was fed a **point** sun, so at short range the lobe was narrower than the sun
  itself and lived inside a fraction of a pixel — annihilated by TAA. Now Karis's
  representative-point sphere-light approximation: the shading `L` is the point on the
  sun disc closest to the mirror direction, `alpha' = alpha + 0.00465` (the sun's true
  angular radius, which is the physical floor on any specular lobe), and the NDF is
  renormalised by `(alpha/alpha')^2` so widening the lobe does not add energy — the peak
  gets dimmer and the highlight gets **wider**, which is exactly what was missing.
- **Roughness.** `rough = sqrt(2*(vX+vZ))` was `sqrt(2)` too large: for an isotropic
  Beckmann/GGX lobe `mss = alpha^2` exactly, so `alpha = sqrt(mss)`. The `sqrt(2)`
  belongs on the **per-axis** alphas (`sigma_a^2 = alpha_a^2/2`) and is still there.
- **SSS** was driven by crest **elevation** — research failure mode 23, "every crest
  glows including flat offshore swell, backlit green plastic sheeting". Now
  Barré-Brisebois & Bouchard (GDC 2011) translucency with thickness from the Gerstner
  **horizontal-displacement pinch** (`vPinch`), which is the Sea of Thieves construction.
- **Foam was unlit** — no `N·L` anywhere in `foamCol`, just flat ambient plus a constant
  slice of sun, which is why it read as fog (failure mode 11). Now albedo `(0.68,0.70,0.72)`
  (never 1.0) times `sun*N.L/pi + sky`.
- **Caustics** now project along the **refracted sun ray** (`p - azimuth * depth*tan(theta')`)
  instead of straight down, and defocus with local slope variance
  (`1 - clamp(mss/0.05, 0, 1)`) as well as with depth. Not yet multiplied by a shadow
  term — see §5, there is no shadow sampler bound to this material.
- **Detail tiers 3 -> 2** (tiles 0.55 m and 0.16 m, ratio 3.4, inside research §5.4's
  3–5x rule). The third tier measurably did nothing.
- **Foam dissolve threshold.** `thr = 1.06 - 1.18*env` evaluates to **0.057** at the
  `env` ceiling of 0.85, against a `tex` distribution that runs ~0.3–1.2 — so `foamCov`
  saturated to 1 over almost every texel and the swash went solid white again, which is
  the same failure the previous pass thought it had fixed by capping `env`. Capping `env`
  is necessary but not sufficient; the *slope* has to keep the threshold inside the
  texture's range at both ends. Now `thr = 1.15 - 0.95*env`.

### 2.5b The per-triangle bright/dark shatter — `gl_FrontFacing`

Found by measuring, then looking. After 2.1–2.5 the water ROI `lap_var` had come down
onto the signature (973 -> 658 against 677) and `spectral_slope` had landed exactly on
kf_01800 (−2.34 -> −1.96 against −1.955), but `lum_std` and `local_contrast` had gone
**down**, and the crop showed hard, straight-edged, ~20–60 px bright/dark facets. 20 px
is exactly what the disc's radial edge (`max(0.14, r*0.0225)`) subtends at 20 m, so the
shading was discontinuous *across triangle edges*.

```glsl
if (!gl_FrontFacing) N = -N;      // with side: THREE.DoubleSide
```

On a rippled surface at grazing incidence, whether a triangle is back-facing flips **per
triangle**. A flipped `N` gives `dot(N,V) < 0`, so `ndv` clamps to 0 and `F` goes to
**1.0** (pure mirror), while `R = reflect(-V,N)` points down so `below` goes to 1 and the
mirror returns the near-black deep-water body — next to a front-facing neighbour
returning bright sky. Correcting `uScatterCol` in §2.2 made the dark side ~10x darker and
turned a subtle artefact into a shatter.

The tangent frame cannot produce a downward normal on its own (`cross(tz,tx).y` is
`1 - sum Q k A sin`, and the loop constraint — now actually enforced — keeps that
positive), so the only correct reason to flip is being underwater:
`if (uCamPos.y < P.y) N = -N;`.

Two related terms were fitted against the old, 10x-too-bright deep colour and snap
against the new one:

- `below = clamp(-R.y * 26.0, 0, 1)` reaches full strength at **2.2°** below the horizon.
  It has to match the angular scale of the sea it describes: with `sqrt(mss) = 0.10` rms
  slope, a ray just below the horizon still meets the next crest at grazing and returns
  mostly bright. Now `smoothstep(0.0, -0.15, R.y)`.
- the below-horizon return `mix(refl*0.30, deepBody, 0.82)` -> `mix(refl*0.45, deepBody, 0.62)`.

### 2.6 The wet sheet stops painting the beach white [major 5]

`sand` ROI at ref_01800 measured `--skip ocean` 86.03 -> ocean ON 113.8 against a
reference 56.42: the module was adding **+27.8 codes** to a region already +30 over, and
`sand lap_var` 88.5 -> 459.0 against ref 139.0 — 3.3x the reference's entire sand detail
budget, painted on by the water shader.

`wetCol` was `mix(bgRaw*0.72, mix(body, refl, F*1.12) + spec*0.55, 0.55)`, which is
brighter than dry sand once `refl` is the blown sky. In `ref/detail/sand_4k.png` the wet
strip runs 45–90 codes against 110–140 for dry sand: **wet sand is darker**, and its
signature is the roughness drop, not a sheen added on top (Lekner & Dorf 1988).

Now `wetCol = bgRaw*0.62 + refl*F*0.55 + spec*0.35` — the sheet darkens what is under it
and only the specular adds light — over a shorter column (`0.22 -> 0.16 m`). The
albedo/roughness/normal half of wet sand belongs in the terrain's own shading and cannot
be done from here; the foam RT already carries the wet channel in `.g` for whoever owns
that (`FOAM_FRAG`, `wet = max(wet, step(0.005, col) * land)`).

---

## 3. Measured

Reproduce with (note the guard — see §1a):

```bash
cap () { node tools/capture.mjs --out "$1" --settle 48 "${@:2}" >/tmp/c.log 2>&1
         grep -q "not loaded: ocean" /tmp/c.log && { echo "FAIL $1"; return 3; }; echo "OK $1"; }
cap shots/oc2_B_on.png     --pose ref_01800
cap shots/oc2_A_noc.png    --pose ref_01800 --skip ocean
cap shots/oc2_C_nogl.png   --pose ref_01800 --config oceanGlitter=0
cap shots/oc2_D_nofoam.png --pose ref_01800 --config oceanFoam=0
cap shots/oc2_E_flat.png   --pose ref_01800 --config oceanWaveScale=0.02
cap shots/oc2_G_on0.png    --pose ref_00000
cap shots/oc2_F_noc0.png   --pose ref_00000 --skip ocean
```

### 3.1 After §2.1–2.5, before the `gl_FrontFacing` fix

`water` ROI at ref_01800. **`w_base` is from an earlier window and is shown only for the
shape of the change, not as an A/B** — see §1.

```
metric            oc2_B_on    w_base  kf_01800   SIGNATURE
lum_mean             125.8     122.8     116.3       114.3
lum_std              21.98     25.53     45.41       40.96
p01                     47        55        23           -
p99                    163       166       191           -
shadow_frac      0.0005853 0.0004994   0.02056           -
highlight_frac           0         0 5.369e-06           -
sat_mean             30.43     43.22     60.62       69.72
lab_b               -6.075    -7.717    -3.014      -7.875
lap_var              658.3     973.4      1376       676.6
edge_density        0.0869    0.1025    0.1968       0.109
local_contrast      0.0652   0.07857    0.1497       0.142
spectral_slope      -1.959    -2.343    -1.955      -2.436

near-field patch (x0-200, y900-1050), rgb
  oc2_B_on  (60.8, 78.3, 110.7)     w_base (103.7, 113.3, 135.2)   kf_01800 (45.7, 43.5, 44.1)
```

Read it honestly:

- **`lap_var` 973 -> 658 against a signature of 677, and `spectral_slope` −2.34 -> −1.96
  against kf_01800's −1.955.** The +43%-over-signature broadband hash is gone and the
  spatial spectrum now has the reference's slope. That is the headline the previous pass
  should have been chasing.
- **The near-field patch went (103.7, 113.3, 135.2) -> (60.8, 78.3, 110.7)** against a
  reference (45.7, 43.5, 44.1). Red is now within 15 codes of the reference (was 58 over);
  the residual is that the pixel is still far too blue, i.e. the reflection term still
  dominates a body that should be seabed.
- **`lum_std` 25.5 -> 22.0 and `local_contrast` 0.0786 -> 0.0652 went the WRONG WAY.**
  Removing the hash also removed what little tonal structure there was. Both are still
  roughly half the signature (41.0 / 0.142). This is the open problem.
- `sat_mean` 43.2 -> 30.4 against 69.7. Also the wrong way, same cause: the surface is
  now mostly a mirror of a near-white sky.

The crop is what said what to do next — hard straight-edged facets at the tessellation
scale — and that is §2.5b.

### 3.2 After the `gl_FrontFacing` fix — diagnosis confirmed, and a new problem exposed

```
metric            oc2_H_on  oc2_B_on  kf_01800   SIGNATURE
lum_mean             128.3     125.8     116.3       114.3
lum_std              18.12     21.98     45.41       40.96
p01                     79        47        23           -     <-- the black facets are gone
p99                    166       163       191           -
shadow_frac      0.0003973 0.0005853   0.02056           -
highlight_frac           0         0 5.369e-06           -
sat_mean             25.56     30.43     60.62       69.72
lab_b               -4.874    -6.075    -3.014      -7.875
lap_var              408.1     658.3      1376       676.6
edge_density       0.04735    0.0869    0.1968       0.109
local_contrast     0.05434    0.0652    0.1497       0.142
spectral_slope      -2.097    -1.959    -1.955      -2.436

near-field patch  oc2_H_on (62.5, 83.3, 90.6)   oc2_B_on (60.8, 78.3, 110.7)   ref (45.7, 43.5, 44.1)
```

**`p01` 47 -> 79 confirms the diagnosis**: the dark pixels in `oc2_B_on` were the
back-facing triangles rendering as near-black deep water, not anything real. Near-patch
blue 110.7 -> 90.6 as the mirrored gas-giant limb stopped whipping across facets, and the
2x crop goes from hard pink/blue triangular shatter to continuous teal water.

**And it removed 250 of the 658 `lap_var`.** That energy was an artefact — but it was also,
measurably, most of what the water had. `lum_std` 22.0 -> 18.1 and `local_contrast`
0.065 -> 0.054 against 41.0 / 0.142. The water is now clean and far too flat.

This is the honest state of the module: the fake structure is gone and the real structure
has not been built yet.

### 3.3 What the reference's contrast actually is, and what I changed next

`ref/keyframes/kf_01800.png` cropped to the `water` ROI is the answer, and it is not
subtle: the highest-contrast features in it are **the dark reflections of the sea stacks**
and the dark wet-rock/seabed patches. Long smooth light/dark ripple bands supply the
mid-frequency structure; there is no high-frequency hash anywhere in it.

We measure `shadow_frac` 0.0004 against 0.0206 — **50x** under. There is nothing dark in
our water at all.

The below-horizon screen-space march is the term that serves exactly that, and I had
deleted it this session on the critic's evidence that `oceanSSR=0` moved `lap_var` by
0.35%. That evidence is the same mistake the critic correctly identified elsewhere:
**`lap_var` is not the metric that term serves.** Restored, leaner (14 steps instead of
22, gated to `Rr.y < 0.14` and `viewDist < 120`), to be judged on `lum_std` and
`shadow_frac`. `--config oceanSSR=0` is the A/B.

Three other changes went in the same window:

- **One bounded reflection direction for BOTH taps.** The §2.3 fix bounded only the
  screen tap; near-field water at ~25° depression projects its reflection above the top
  of the frame and therefore falls through to the **cube** every time, which was still
  steered by the raw perturbed `R` — ±20° of sky per ±10° of facet, across the limb of a
  very large, very bright gas giant. Now the **slope** is clamped
  (`uReflMaxSlope = 0.22`) and one direction `Rr` drives the cube, the screen tap and the
  march. One clamp, expressed in the units the problem is in.
- **Fold-foam window narrowed**, `smoothstep(0.40, -0.05, J-)` ->
  `smoothstep(0.12, -0.10, J-)`, shading weight 0.6 -> 0.35. With the loop constraint now
  actually enforced, `sum Q k A` ramps to ~0.95 in the surf zone, so `J- = 0.05` fired the
  old window at 0.61 across the *whole* surf zone — and `env` is a vertex quantity, so the
  threshold crossing is a straight line across a triangle. That is the hard-edged white
  polygons in the `oc2_H_on` crop.
- **Near-field ring spacing 0.14 m -> 0.085 m.** At 3 m a 0.14 m ring subtends 0.047 rad
  = 36 px, and the linearly interpolated tangent frame smears the shading into 36 px
  radial streaks — visible as diagonal streaking in the crop. 384 -> 405 rings,
  ~10k extra vertices. `WATER_VERT`'s Nyquist edge length uses the same constant, so the
  two stay in step.

### 3.4 The restored SSR march is broadband hash — settled, and reverted

```
metric            oc2_J_on  oc2_H_on  kf_01800   SIGNATURE     J = H + SSR + refl-unify + foam + tess
lum_mean             124.1     128.3     116.3       114.3
lum_std              26.26     18.12     45.41       40.96
p01                     58        79        23           -
p99                    181       166       191           -
shadow_frac      0.0005853 0.0003973   0.02056           -
sat_mean             35.59     25.56     60.62       69.72
lap_var               4802     408.1      1376       676.6
edge_density        0.2292   0.04735    0.1968       0.109
local_contrast     0.05657   0.05434    0.1497       0.142
spectral_slope      -1.143    -2.097    -1.955      -2.436
```

`lum_std` 18.1 -> 26.3 and `p99` 166 -> 181 are the wanted direction. Everything else is a
catastrophe: **`lap_var` 408 -> 4802** and **`spectral_slope` −2.10 -> −1.14**. A slope of
−1.14 is white noise. The 2x crop (`shots/oc2_J_on.png`) is dense salt-and-pepper
shattering across the whole near field.

The mechanism is structural, not a tuning error: a **binary per-pixel hit test** marched
with a 1.55x geometric step over a rippled surface hits and misses on neighbouring pixels
by construction. And the thing it was restored for did not move — `shadow_frac` 0.00040 ->
0.00059 against a target of 0.0206.

So the critic's conclusion (delete it) was right, even though the evidence offered for it
(`lap_var` ±0.35%) did not support it. It is now **off by default** behind
`--config oceanSSR=1`, with the full measurement in the comment above the march, because
the *idea* is right — the reference's dark water really is reflected sea stack — and
whoever revisits it needs to know that the failure is the per-pixel resolve, not the
concept. It needs a filtered, temporally stable resolve.

Two other things landed in the same window and are kept:

- **The polygonal foam is fixed at its source.** `env = max(env, pow(vBrk,3)*0.55)` and
  the J- fold floor both read **vertex varyings**, so the foam-coverage threshold crossed
  along straight triangle edges — the hard-edged white polygons visible at 2x in both
  `oc2_H_on` and `oc2_J_on`. Both sources are *already* injected into the foam RT by
  `FOAM_FRAG`, where they are a smooth advected world-space field. Reading them a second
  time, faceted, only added the facets. `env` now comes from the field alone.
- **One bounded reflection direction** and the **finer near-field rings**, as described in
  §3.3.

### 3.4b The waterline feather — tried, measured, reverted

The remaining visible artefact after §3.4 is the water/land boundary: `P.y` is a vertex
quantity, so its crossing of the bed is a straight segment per triangle, and at 3 m range
that is a ~22 px piecewise-linear edge reading as hard wedges of dry beach cutting into
the swash. Widening the coverage feather from 6 cm to 14 cm is the obvious cheap fix, so
I tried it (`shots/oc2_M_on.png`) against `shots/oc2_L_on.png` in one window.

```
shoreline ROI    cov 0.055   cov 0.120   kf_01800
lum_std              42.63       28.71      41.96
local_contrast      0.1562      0.0932      0.142
sat_mean              45.1        27.4      50.62
shadow_frac         0.1518       0.027    0.05636
lap_var              911.6        1045      914.9
```

Decisively worse. A wider feather keeps more DRY BEACH in `mix(bgRaw, col, cov)` across
the whole swash band, and the swash is where every one of this module's wins lives.
**Reverted**; the shipping value is the one measured as `oc2_L_on`.

### 3.5 Final state, `water` ROI at ref_01800

`shots/oc2_L_on.png` (SSR off by default + foam floors removed) is **byte-identical in
every metric to `shots/oc2_K_nossr.png`**, which confirms `K` was captured after those
edits landed, i.e. both are the shipping build.

```
metric               oc2_L_on   oc2_B_on   w_base*     kf_01800   SIGNATURE
lum_mean                125.9      125.8     122.8        116.3       114.3
lum_std                 18.25      21.98     25.53        45.41       40.96
p01                        78         47        55           23           -
p99                       167        163       166          191           -
shadow_frac         0.0003973  0.0005853 0.0004994      0.02056           -
highlight_frac              0          0         0    5.369e-06           -
sat_mean                27.88      30.43     43.22        60.62       69.72
lab_b                  -5.345     -6.075    -7.717       -3.014      -7.875
lap_var                 643.3      658.3     973.4         1376       676.6
edge_density           0.0869     0.0869    0.1025       0.1968       0.109
local_contrast         0.0514     0.0652   0.07857       0.1497       0.142
spectral_slope         -1.745     -1.959    -2.343       -1.955      -2.436

near-field patch  oc2_L_on (70.0, 88.1, 93.6)   w_base (103.7, 113.3, 135.2)   ref (45.7, 43.5, 44.1)
```

`*` **`w_base` is the state I inherited, but from an EARLIER WINDOW** (terrain was pale
grey; `clouds` and `vegetation` later failed to compile and then recovered; the viewmodel
came and went). It is shown for the shape of the change only. The only same-window
control is `shots/oc2_A_noc.png` (`--skip ocean`).

**Won, and these are the ones the 3/100 was about:**

| | inherited | now | target |
|---|---:|---:|---|
| `lap_var` | 973.4 (**+43% OVER**) | **643.3** | 676.6 — 95% of signature |
| `spectral_slope` | −2.343 | **−1.745** | −1.955 (kf_01800) |
| near-patch R | 103.7 (**+58 over**) | **70.0** | 45.7 |
| near-patch B | 135.2 | **93.6** | 44.1 |

The broadband hash is gone, the spatial spectrum has moved most of the way to the
reference's slope, and the near field is no longer 2.3x too bright with a +62 blue cast.
Visually the change is not marginal: `shots/w_base.png` at 2x is crumpled aluminium foil
with contour-zigzag aliasing; `shots/oc2_L_on.png` at 2x is continuous teal water with a
seabed visible through it.

### 3.6 THE ACTUAL A/B — `--skip ocean` vs ocean ON, same window

This is the only honest control, and it changes the story. `shots/oc2_A_noc.png` vs
`shots/oc2_L_on.png`, captured back to back at ref_01800.

**`shoreline` ROI — this is the region the module is actually responsible for, and it
lands on essentially every target:**

```
metric            ocean OFF   ocean ON   kf_01800   SIGNATURE
lum_std               28.93      42.63      41.96       42.69   <-- on target
local_contrast      0.09316     0.1562      0.142        0.15   <-- on target
lap_var                1391      911.6      914.9       695.6   <-- 911.6 vs 914.9
edge_density         0.1746     0.1297      0.166       0.127   <-- on signature
spectral_slope       -1.744     -2.385     -2.292      -2.347   <-- on target
sat_mean              23.53       45.1      50.62       69.31
lum_mean                100       97.4      88.83       99.71
p99                     147        176        185           -
shadow_frac         0.03978     0.1518    0.05636           -   <-- now 2.7x OVER
```

Five of the shoreline signature's metrics are within a few percent, `lap_var` is within
0.4% of the kf_01800 crop, and every one of them moved the right way. `shadow_frac` has
gone from under to 2.7x over — the swash sheet is now too dark. That is the one number in
this ROI to pull back.

**`water` ROI — the module still LOWERS the two metrics it most needs to raise:**

```
metric            ocean OFF   ocean ON   kf_01800   SIGNATURE
lap_var               663.3      643.3       1376       676.6
edge_density        0.06982     0.0869     0.1968       0.109
spectral_slope       -1.984     -1.745     -1.955      -2.436
sat_mean              19.51      27.88      60.62       69.72   <-- +8.4, right way
lum_std               23.81      18.25      45.41       40.96   <-- ocean REDUCES it
local_contrast      0.07497     0.0514     0.1497       0.142   <-- ocean REDUCES it
near patch     (79.5,81.2,78.8) (70.0,88.1,93.6)   ref (45.7,43.5,44.1)
```

This is the same shape of failure the critic identified, at a much smaller magnitude and
now without the hash: putting water over the beach still *smooths* the region. The empty
scene has `lum_std` 23.8 because it is dry cobbles; the reference has 45.4 because it has
dark rocks standing in the water, their reflections, and strong long-wavelength ripple
banding. We supply none of the three. **This is the module's remaining defect and it is
stated here so the next pass does not have to rediscover it.**

Note also that the empty scene already measures `lap_var` 663 against a signature of 677 —
at this pose the `water` screen rectangle is mostly terrain, so the ROI is a weak
instrument for this module. `shoreline` is the honest one.

**`sand` ROI — the flooding is much reduced but not eliminated:**

```
metric            ocean OFF   ocean ON   kf_01800   SIGNATURE
lum_mean              90.48      101.6      56.42       102.1
lap_var               960.1      905.1        139       521.3
edge_density         0.2014       0.15    0.04356        0.12
spectral_slope       -1.611     -2.553     -2.628       -2.37
```

The ocean used to add **+27.8** codes to `sand lum_mean` and **3.3x** the reference's
entire sand `lap_var` budget. It now adds **+11.1** codes and *removes* 55 of `lap_var`,
and it pulls `spectral_slope` from −1.61 to −2.55 against a reference −2.63. The residual
+11 is the swash sheet; the region's real problem is that the dry beach is already at 90.5
against a kf_01800 56.4, which is terrain's.

### 3.7 Second pose, ref_00000

`shots/oc2_G_on0.png`, no same-window `--skip ocean` control, so this is orientation only:

```
metric            oc2_G_on0   kf_00000   SIGNATURE
lum_mean              120.1        136       114.3
lum_std               28.65      52.51       40.96
p01                      34         32           -     <- on target
shadow_frac        0.007952    0.00945           -     <- on target
p99                     177        231           -
highlight_frac            0    0.02473           -     <- the glitter track, still missing
sat_mean                 42      59.91       69.72
lap_var                2151      633.2       676.6     <- 3.4x over
spectral_slope       -1.206      -2.76       -2.436
local_contrast      0.07305     0.1905       0.142
near patch  (118.6, 102.9, 91.6)  vs ref (122.3, 97.5, 73.0)
```

`p01`, `shadow_frac` and the near-field patch are close at this pose; `lap_var` is 3.4x
over with a −1.21 slope. **I could not attribute that**: at ref_00000 the `water` screen
rectangle contains a large amount of terrain and vegetation, and I had no `--skip ocean`
control at that pose in the same window. Do not assume it is the water. Run
`--pose ref_00000 --skip ocean` first.

`highlight_frac` 0 against 0.0247 at this pose is the one place the missing glitter track
is unambiguous, and it is unresolved — see §5.

**Lost, and I am not going to dress this up:**

| | inherited | now | target |
|---|---:|---:|---|
| `lum_std` | 25.53 | **18.25** | 40.96 |
| `local_contrast` | 0.0786 | **0.0514** | 0.142 |
| `sat_mean` | 43.22 | **27.88** | 69.72 |
| `edge_density` | 0.1025 | 0.0869 | 0.109 |

Some of that drop was fake — `p01` 47 -> 78 across the `gl_FrontFacing` fix shows the old
dark pixels were black back-facing triangles, not water. But not all of it. The module is
now clean, correctly coloured and correctly band-limited, and **too flat**. See §5.

---

## 4. Cost

Per frame, changes relative to the previous build:

| | before | after |
|---|---|---|
| `WATER_VERT` per-vertex loops | 2 x NW (`vVarDrop` + `oc_surface`) | 1 x NW |
| `oc_bedGrad` | — | +4 bathymetry taps per vertex / foam texel |
| SSR march | 22 steps, `viewDist<165 && R.y<0.32`, always on | **off by default** (14 steps behind `oceanSSR=1`) |
| detail-map fetches | 3 | 2 |
| extra full-screen passes | 1 (depth copy) | 2 (depth copy + half-res prefilter + mipgen) |
| disc vertices | 384 rings x 449 = 172k | 405 rings x 449 = 182k |

Net: one 960x540 RGBA16F blit plus its mip chain and ~10k extra vertices, against the
whole 22-step screen-space march (which ran on every pixel with `viewDist<165 && R.y<0.32`,
a large fraction of the frame), one fewer detail-map fetch, and one fewer per-vertex
`NW` loop. Not separately timed —
the machine was running 12-15 concurrent captures from other agents all session and any
`ms` figure taken in that window would be noise.

Init unchanged (bathymetry 768x768, ~24 ms).

---

## 5. Weakest thing left

**The `water` ROI is the one region where the module still makes the image worse on the
metrics that matter**: same-window `--skip ocean` -> ON moves `lum_std` 23.81 -> 18.25 and
`local_contrast` 0.07497 -> 0.0514, against 40.96 / 0.142. Putting water over the beach
*smooths* it.

`shadow_frac` 0.0004 against 0.0206 says exactly where the gap is: **there is nothing dark
in our water.** In `ref/keyframes/kf_01800.png` cropped to the water ROI, the
highest-contrast features are, in order: dark sea stacks standing in the water, their
reflections, and dark wet-rock/seabed patches showing through. We supply none of the
three. The reflections are ours (§3.4 shows a per-pixel march is not the way); the visible
dark seabed is gated on terrain's albedo, which still measures 90.5 `lum_mean` on dry sand
against a kf_01800 56.4.

Note the `shoreline` ROI is now essentially on target (§3.6) and the `water` screen
rectangle at this pose is mostly terrain — the empty scene already measures `lap_var` 663
against a 677 signature. Do not over-fit to `water`; check `shoreline` too.

One number went from under to over and should be pulled back: `shoreline shadow_frac`
0.0398 -> 0.1518 against a kf_01800 0.0564. The swash sheet (`bgRaw * 0.62`) is now too
dark. That is a one-constant fix I did not have the capture budget to verify.

Then, in order:

1. **Do not trade `lap_var` back.** If a later pass raises `lap_var` toward kf_01800's
   1376 while `local_contrast` stays flat, it has re-introduced the hash. The signature
   is 677 and we are at 643; the honest way up is *structure* (dark reflections, visible
   seabed, long Fresnel bands), not slope noise. Judge every change on the triple
   (`lap_var`, `local_contrast`, `lum_std`) moving together, never on `lap_var` alone.
   §3.4 is the worked example of what happens if you don't.
2. **The waterline is a polygon, and you cannot feather your way out of it — measured.**
   `P.y` is a vertex quantity interpolated linearly, so its crossing of the bed is a
   straight segment per triangle: at 3 m range a ~22 px piecewise-linear boundary that
   reads as hard wedges of dry beach cutting into the swash. Widening the coverage
   feather 6 cm -> 14 cm looked like the obvious cheap fix. `shots/oc2_L_on.png` vs
   `shots/oc2_M_on.png`, one window, **shoreline** ROI:

   ```
   cov 0.055 -> 0.120:  lum_std        42.63 -> 28.71   (target 41.96)
                        local_contrast 0.1562 -> 0.0932 (target 0.142)
                        sat_mean        45.1 -> 27.4
                        shadow_frac   0.1518 -> 0.027
                        lap_var        911.6 -> 1045    (target 914.9)
   ```

   A wider feather keeps more DRY BEACH in `mix(bgRaw, col, cov)` across the whole swash
   band, and the swash is where all of this module's contrast lives. **Reverted** — the
   shipping value is `smoothstep(-0.004, 0.055, column)`, i.e. exactly the state measured
   as `oc2_L_on`. The real fix is a per-pixel waterline: recompute the displaced height
   in the fragment shader over the shallow band, or drive the alpha edge from a
   screen-space distance rather than a linear interpolant.
3. **Caustics are still not multiplied by a shadow term** — research/ocean.md calls this
   "the single most legible fake-water tell in a still frame" (failure mode 21). There is
   no shadow map sampler bound to this material; water does not go through
   `applyWorldMaterial`. Fixing it properly means plumbing the cascade uniforms into
   `WATER_FRAG`, which touches `src/gfx/materialCommon.js` — not my file.
4. **Wet sand is only half fixed.** The water shader has stopped painting a bright sheen
   over the beach, but the *correct* wet-sand model (albedo x0.55, roughness -> 0.18,
   F0 -> 0.02, normal flattened by w*0.6) belongs in `terrain`'s shading. The foam RT
   already publishes the wetness field in `.g` and the module exposes `wetnessAt(x,z,t)`;
   whoever owns terrain should consume one of them.
5. **`uReflMaxSlope = 0.22` is a guess, and it is the dial that trades flatness for
   hash.** It caps the reflected ray's excursion at ~25°. Too low and the water is a flat
   mirror (where we are now); too high and the facets shatter again. Sweep it with
   `--config oceanReflSlope=` and watch `local_contrast` and `lum_std` rise while
   `lap_var` stays near 677. Note the Water.js `(0.001 + 1/dist)` UV rule I started with
   is, on reflection, the wrong tool here: it is designed for a mirror-camera render
   where *parallax* moves, whereas we reflect sky at infinity, where the excursion is
   purely angular and distance-independent. Clamping the slope is the right form; only
   the value is unverified.
6. **`uEdown`'s `uSkyAmbient * 2.6`** is a fitted conversion from the mean dome radiance
   `sky` reports to a hemispherical irradiance. It is the one number in the new water
   column that is not derived. It sets the absolute level of both the synthetic seabed
   and the deep-water term; check it against the `water` ROI `lum_mean` before trusting
   the deep-blue offshore colour.
7. **`highlight_frac` is still 0.0** in the water at both poses, against 0.0247 at
   kf_00000 (and `p99` 177 vs 231). The glitter lobe was rebuilt on Karis's
   representative-point sun disc with the correct angular floor, and it still does not
   clip. That means the next step is to log `spec`, `ndl` and the alphas at a known
   fragment rather than to reason about the lobe again — is `spec` surviving at all, is
   `ndl` nonzero at these sun elevations, and is the 420.0 clamp or the tonemap eating
   it? I did not get to that.
8. **The horizon ROI is not this module's to fix.** The previous pass measured horizon
   `sat_mean` 25.7 with `--skip ocean` and 25.9 with the ocean on against a reference
   79.9 — the deficit there is sky/aerial, not water.
