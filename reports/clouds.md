# clouds — refit against the critic's REJECT (18/100)

Owner file: `src/world/clouds.js` **only**. `src/render/passes/scene.js`,
`src/render/passes/cloudComposite.js` and `src/render/RenderPipeline.js` were not touched;
see §1 for the part of the critical fix that cannot be done from inside this file.

Helpers added: `tools/_clstat.py` (cloud-body mask via differencing against
`--skip clouds`; the scored `sky` ROI is unusable as a frame-to-frame signal right now,
see §7).

---

## 1 critical — THE DEPTH TERMINATION IS DEAD. Fixed, without editing `scene.js`.

**The critic was right and the reason is worth writing down, because the broken code
looked perfect.** `RenderPipeline.init()` assigns the *same* `DepthTexture` object to
both `pipe.gbuffer.depthTexture` (line 153) and `pipe.sceneRT.depthTexture` (line 158),
and `scene.js:114` calls `renderer.clearDepth()` before drawing the viewmodel into
`sceneRT`. That clear lands on the shared texture. So `pipe.depthTex` contains only the
viewmodel, in the viewmodel camera's projection, and the entire world reads `dz == 1.0`.
The uniform was bound, the branch was live, and it never fired.

**Fix, entirely inside `clouds.js`** — read two different things, neither of them
`pipe.depthTex`'s world contents:

- `pipe.gbuffer.textures[0]` for WORLD geometry. That attachment is
  `vec4(viewNormal*0.5+0.5, roughness)`, written by the pre-pass and **never cleared for
  the viewmodel**. Background is exactly `(0,0,0,0)`; any unit normal maps to a vector of
  length >= 0.366. `dot(n,n) > 0.02` is therefore an exact world-geometry mask. Sampled
  conservatively over 2x2 full-res texels because the march is half resolution.
- `pipe.depthTex` for the VIEWMODEL only, which is on its own layer and never enters the
  pre-pass, and which is all that texture still holds. **Binary** — the old code
  linearised it with the *main* camera's `uNear/uFar` (0.06/12000) against depth written
  through the viewmodel camera's own near-field projection, so even the one case that
  fired computed a meaningless distance and was right only by accident.

Binary is sufficient and is not a shortcut: the nearest possible cloud sample is at 650 m
altitude and every solid surface in this scene is inside a few hundred metres, so
"geometry exists here" and "geometry is nearer than the clouds" are the same predicate.

**Verified as asked — differencing against `--skip clouds` at ref_00000, not on an ROI:**

| band | before | after |
|---|---|---|
| y=600-1080 (all terrain/dune/grass) | changing, max 127 | **frac>10 codes = 0.0000, max diff 5** |
| y=420-460 | 33% of pixels changing | 22%, and every changed pixel is above the terrain skyline |
| per-column max changed y | ran into the dunes | tracks the silhouette exactly; nothing past x=1200 (the cliff) |

The residual max-50-code change at y=500-560, x<300 is **correct and is not a leak**:
`src/world/ocean.js:1645` samples `clouds.buffer` for the water's sky reflection, so
`--skip clouds` legitimately changes the sea surface.

**Re-verified hours later against geometry that did not exist when the fix was written.**
`structures.js` landed a Forerunner bridge into the ref_00000 framing mid-session. The
`--skip clouds` difference map (`shots/cl/dmap.png`, 3x gain) shows the cloud shapes
bright in the sky, the sky under the bridge opening bright, and **the bridge deck, its
angled legs and the cliff face pure black** — a pixel-accurate silhouette against
geometry the mask had never seen. The `cliff` box (y100-400, x1450-1900) measures
`frac>10 = 0.0002`. This is the property to re-check after any change here, and the
difference map is a better check than any ROI number.

One caveat on that same map: the beach shows a faint diff over the cobble field. It is
per-cobble *outlines*, which is the signature of a changed normal/height field, i.e.
`terrain.js` landing an edit between the two captures — cloud leakage would be smooth
cloud-shaped blobs, not cobble rims. This is the same measurement hazard described in §7.

**What is still broken and cannot be fixed from this file.** `cloudComposite`'s bilateral
upsample reads the same destroyed `pipe.depthTex`, so every tap has `err = 0` and
`tol = 0.04*linZ(1.0) = 480`: it degenerates to a plain bilinear everywhere except on the
gun. The silhouettes this march now writes are therefore softened by ~2 full-res pixels
on the way through it. The fix is the one the critic named — have `scene.js` copy the
world depth into a dedicated target immediately before its `clearDepth()` — and it needs
an owner of `scene.js`. This is recorded in the module header.

---

## 2 critical — no dark bases, three stacked energy boosts. Fixed.

**Deleted**, in the same commit as the replacement, as instructed:
- `powder` default 2.0-peak Beer-Powder -> `0.0`. `research/clouds.md` §3.5 is explicit
  that the 2017 in-scatter probability is its *replacement*, and that the 2015 constants
  could not be verified against a primary source. The code path is kept behind
  `uPowder > 0.0` so it is switchable, but it is off.
- `uScatterGain 2.4` -> re-derived from scratch *after* the new terms landed (see below).
- `msAtten/msContrib 0.32/0.78` -> `0.62/0.62`. The old pair had the **scattering** decay
  (0.78) *above* the **extinction** decay (0.32), which violates Frostbite Eq. 20's
  `a <= b` energy-conservation condition — it manufactured light, and then two more
  multipliers sat on top of it.

**Added**, verbatim from `research/clouds.md` §3.4:
```glsl
float vertP = pow(clamp(remap(h, 0.07, 0.14, 0.1, 1.0), 0.0, 1.0), 0.8);
float depthP = 0.05 + pow(dsLod, clamp(remap(h, 0.30, 0.85, 0.5, 2.0), 0.4, 2.2));
      depthP = mix(depthP, 1.0, clamp(tauLight * 0.25, 0.0, 1.0));
sun *= depthP * vertP;
```
`dsLod` is the erosion-free `cloudDensity(p,h,0,0)` the space-skip already computes — the
loop was restructured so it is computed once and used for both, which costs nothing.
It is **normalised by `uDensity`** before `pow()`: our density is not the [0,1] number the
slide assumes and `pow(1.4, 2.0)` brightens where the term is supposed to darken. That
units error was worth 19 codes of body median on its own.

The slide's disable term `lerp(..., 1.0, saturate(dl/step_size))` is not dimensionally
meaningful (`dl` is a bare sum of densities, `step_size` a world length) and the slide is
internally inconsistent about both. The stated intent — *"we also reduce this effect once
light has attenuated to make it directional"* — is implemented against the dimensionless
optical depth toward the sun instead. Flagged as a reinterpretation, not a quote.

The ambient path keeps its two-tap occlusion (that is Nubis-3's
`exp(-summed_ambient_density)`, a *different* quantity — it attenuates the sky term, not
the sun term) plus a gentle Frostbite bottom-to-top gradient `mix(0.58, 1.0, h*2)`. Kept
gentle on purpose: stacking a second base-darkener on the vertical probability is the
same mistake in a new costume, and the first attempt at `mix(0.35, 1.0, h*1.6)` measured
body `p01 = 25` — near-black bases, which real cumulus do not have.

---

## 3 major — the far deck was flat opaque slabs, brighter than the sky behind them. Fixed.

Three changes, in the order the critic asked.

1. **Two step schedules instead of one.** `stepAt(t) = clamp(0.030+0.0075t, 0.030, 0.75)`
   held a constant *angular footprint* — right for a texture LOD, wrong for an
   optical-depth integral. Now:
   ```glsl
   float stepMarch (float t){ return clamp(0.021 + t*0.00095, 0.021, 0.090); }  // integrate
   float stepSearch(float t){ return clamp(0.055 + t*0.0090,  0.055, 1.10 ); }  // empty space
   ```
   The integration step is held near the 20 m mean free path (21 m near, 90 m at the
   70 km limit) so a cloud is resolved in tens of samples at any range; the coarse
   schedule carries the far-field cost, at Nubis' x2 with a **step back on first hit**
   (slide 73 — without it you punch a hole in the leading face of every cloud). Loop cap
   160 -> 256.
2. **The threshold softens with the step** instead of hardening:
   `edge = mix(uEdgeGain, 1.6, smoothstep(0.030, 0.085, step))`, and `uEdgeGain` itself
   came down 8.0 -> 4.5.
3. **maxDist 150 km -> 70 km.** Past ~60 km the deck is thinner than one march step and
   the honest thing to do with it is fade it into the haze.

**Measured on the critic's own slab box (ref_00720, y600-625, x580-700):**

| | before | after | reference distant cumulus (kf_00000, y440-465 x60-180) |
|---|---|---|---|
| interior std | 9.55 | **27.05** | 34.86 |
| mean | 160.2 | 125.2 | 150.7 |
| vs sky immediately above | **+29 codes (brighter)** | **-29 codes (darker)** | darker |

The "hard white strip brighter than the sky it sits in" is gone, and it is gone because
the energy is right, not because it was hidden: the inversion flipped sign.

---

## 4 major — no silver lining, no clipping tops. Fixed.

`dualHG` deleted. Replaced with HG+Draine (Jendersie & d'Eon 2023, `research/clouds.md`
§3.3) at mean droplet diameter **25 um** (maritime): `gHG 0.9958, gD 0.6033, alpha 28.60,
wD 0.5013`. Per-octave lobe widening kept, as
`mix(1/(4pi), phaseMie(cosT), c^n)`.

The old mixture was `mix(HG(+0.82), HG(-0.32), 0.36)` — **36% weighted onto a backward
lobe**, peak `p(0 deg) ~ 11 sr^-1`. The new one peaks at ~`1.0e4 sr^-1`. Nothing clamps
it anywhere in this file.

`highlight_frac` (sky ROI, `> 224`):

| pose | before | after | reference |
|---|---|---|---|
| ref_00000 | 0.0149 | **0.0361** | 0.0317 |
| ref_00720 | 0.0025 | **0.0102** | 0.0065 |

Both now slightly *over* the reference rather than 2-7x under. Cloud-body `frac > 230` at
ref_00000: 0.0079 -> **0.0599** (reference hero cumulus 0.095).

**Caveat.** The physically correct phase function is the reason the module needed
re-lighting from the ground up, and it should be understood before anyone touches it
again: at `cosT ~ 0`, `phaseMie` is **77x darker than isotropic**. Single scattering away
from the sun is essentially nil, which is correct — a white cumulus is white because of
multiple scattering, not because of the direct beam. Everything in §5 below follows from
that.

---

## 5 — the multi-scatter octave count, and the one fitted number

Frostbite's "N = 3, a = b = c = 0.5, and N > 4 adds nothing" does **not** transfer to this
scene, and the reason is the extinction. At the physically correct `sigma_t = 50 /km` a
sample 50 m inside the sunward face already has `tau = 40`, so `exp(-tau * b^n)` is
numerically zero for every low octave and the interior is lit by ambient alone. That is
the textbook *"grey, dirty, smoke-like"* single-scatter failure, and it is exactly what
the first correct-phase build measured. The octave that matters is the one whose effective
extinction `sigma_e * b^n` has optical depth O(1) over the light-march reach.

**Octave sweep, ref_00000, cloud-body mask, against the kf_00000 hero cumulus
(box 760,110-1010,300):**

| N | p01 | p50 | p90 | f110 | f230 |
|---|---|---|---|---|---|
| 3 | 35 | 100 | 216 | 0.527 | 0.050 |
| **6** | **40** | **129** | **223** | **0.399** | **0.065** |
| 8 | 58 | 143 | 223 | 0.271 | 0.067 |
| 12 | 73 | 149 | 224 | 0.197 | 0.068 |
| reference | 43 | 189 | 230 | 0.314 | 0.095 |

6 is where the dark bases still match. Past 8 the interiors brighten by destroying the
thing the in-scatter probability was added to produce. Cost is 3 extra ALU iterations —
**every octave reuses the single light-march result**, so there are no extra texture
fetches.

`uScatterGain` then re-derived at N=6 (this is Nubis' `brightness` argument to
`GetLightEnergy`; it is not optional and it is not covering a missing term — a real
cumulus at albedo 0.995 and tau ~ 50 reflects 0.7-0.8 of incident light, which takes
dozens of scattering orders and a truncated series structurally cannot deliver):

| gain | p01 | p50 | p90 | std | f230 | f110 |
|---|---|---|---|---|---|---|
| 5.0 | 40 | 129 | 223 | 58.5 | 0.065 | 0.399 |
| **8.0** | **43** | **144** | **232** | **59.0** | **0.106** | **0.311** |
| 12.0 | 48 | 154 | 237 | 56.5 | 0.147 | 0.225 |
| reference | 43 | 189 | 230 | 63.2 | 0.095 | 0.314 |

8.0 matches p01, p90, std, f230 and f110 *simultaneously*. **p50 stays ~45 codes under the
reference and that is the honest residual** — pushing the gain further blows p90/p99/f230
past the reference instead of closing it.

---

## 6 major — wrong weather, wrong structure

| | before | after | why |
|---|---|---|---|
| `baseKm` | 2.40 | **0.65** | tropical marine LCL, `research/clouds.md` §1.1 |
| `topKm` | 4.00 | **2.90** | see below — *not* the brief's 2.20 |
| shear | none | **0.40 km** downwind by height fraction | Nubis `cloud_top_offset`; without it, extruded columns |
| wispy/billowy flip | `clamp(h*3.0)` | **`clamp(h*10.0)`** | verbatim `saturate(height_fraction*10)`; the old value frayed the bottom THIRD of every cloud instead of the bottom tenth |
| bottom-of-layer density | `mix(0.45, 1.15, ...)` — **thinned** the base | `mix(1.10, 0.68, ...)` — base is densest | the base has to be the darkest, flattest, most opaque part of a trade cumulus |
| height-gradient bottom ramps | h 0.01-0.16 (250 m) | h 0.00-0.05 (78 m) | flat bases all at one altitude |
| `baseTileKm` | 5.6 | **4.0** | §5: one 128^3 tile = 4 km |
| `detailTileKm` | 0.80 | **0.40** | erosion at 10x the shape frequency |
| `coarseTileKm` | 3.20 | 1.60 | |
| `erode` | 0.32 | **0.22** | Nubis' `high_freq_noise_modifier * 0.2` |
| `edgeGain` | 8.0 | 4.5 | + distance softening, §3 |
| Nubis-3 sharpening | absent | **`pow(density, 0.50)`** | the named fix for soft silhouettes that does *not* add high-frequency energy |
| `extinction` | 28 | **50** /km | measured; also 3*LWC/(2*rho_w*r_eff) = 0.045 /m independently |
| `albedo` | 0.985 | 0.995 | |
| `lightStepKm` | 0.11 | **0.045** | thickness/36, reach ~0.8 km = 0.4x cloud diameter |
| cone kernel | ad-hoc, offset scaled by `t` | clayjohn's 6 unit vectors, offset scaled by sample index | |
| `coverage` | 0.24 | **0.42** | see below |
| `typeBias` | 0.10 | 0.22 | more hero towers |

**`topKm` 2.90, not the brief's 2.20.** The brief's own §1.1 puts congestus tops at
2500-4000 m, and kf_00720's hero bank runs from the waterline to ~25 deg of elevation,
which a 1550 m shell cannot produce at any distance. 2250 m of shell lets the *congestus*
type reach 2.1-2.9 km while *cumulus* still tops out at 1.6-2.6 km and *stratus* at
0.9-1.3 km, so the deck keeps its uniform trade-inversion character and gets hero towers
on top of it. Verified as an image, not a theory — see §7.

**`coverage` 0.42, above the brief's 0.15-0.25.** That parameter is the position of the
coverage remap window, not a sky fraction. The reference is not textbook scattered trade
cumulus — kf_00720 is one large congestus bank — and the measured effect of the sweep was
unambiguous:

| coverage | lum_std | lap_var | edge_density | lab_b | highlight_frac |
|---|---|---|---|---|---|
| 0.34 | 32.2 | 155 | 0.0385 | -12.4 | 0.0227 |
| **0.42** | **38.3** | **137** | **0.0303** | **-9.0** | **0.0361** |
| reference | 47.7 | 145 | 0.0280 | -9.7 | 0.0317 |

---

## 7 — measured, ref_00000 `sky` ROI

Against the matched `kf_00000` crop (the pose the critic said to judge tone on). **Both
columns are the same build; the "after" column is the last capture taken before
`structures.js` dropped a Forerunner bridge into the middle of that crop.** A capture of
the identical build 40 minutes later, with the bridge and a new cobble beach in frame,
reads `lum_std 27.5 / lap_var 64 / highlight_frac 0.0050` — nothing in this module
changed between them. Read §7's caveats before quoting any of these.

| | before | after | kf_00000 |
|---|---|---|---|
| lum_mean | 126.15 | 123.64 | 135.01 |
| lum_std | 33.94 | **38.31** | 47.74 |
| p01 | 69 | **61** | 35 |
| p99 | 230 | 240 | 233 |
| highlight_frac | 0.0149 | **0.0361** | 0.0317 |
| sat_mean | 48.85 | 44.85 | 56.14 |
| lab_b | -10.76 | **-9.01** | -9.70 |
| lap_var | 129.44 | **136.61** | 145.08 |
| edge_density | 0.0431 (54% OVER) | **0.0298** | 0.0280 |
| local_contrast | 0.0393 | 0.0347 | 0.0394 |

**The critic's one-line diagnosis is answered.** `edge_density` was 54% OVER while
`local_contrast` and `lum_std` were 33%/29% UNDER — "lots of small high-frequency edges,
no large-scale tonal form". `edge_density` is now within 6% of target *and* `lum_std` is
up 13%, `lap_var` up, `highlight_frac` up 2.4x, `lab_b` on target. `local_contrast` is the
one that did not follow (0.0347 vs 0.0394) and it is the weakest number left.

`horizon` ROI, ref_00720: `p01 75 -> 50` (ref 25), `p99 223 -> 227` (225),
`highlight 0.0085 -> 0.0130` (0.0101). `lum_std` and `local_contrast` in that ROI are
**not reportable right now** — the crop is 70% terrain/ocean/structures and those three
modules were being rewritten under me throughout this session.

### Read this before quoting any `sky` ROI number

1. **The cloudless floor.** With `--skip clouds` at ref_00000 the `sky` ROI already
   measures `p01 = 88`, `lum_mean = 114.8`, `lum_std = 12.3`. The sky module's own blue is
   the floor: **no cloud change can take `p01` to the reference's 35 unless the dark cloud
   bases cover a large fraction of that crop**, and `lum_mean` is 20 codes short before a
   single cloud is drawn. Attributing that gap to clouds is wrong.
2. **That crop is not sky.** At ref_00000 it contains sea stacks and cliff; at ref_00720
   it is mostly gas giant and blue, and in `kf_00720` its top-left is a large dark tan
   cliff, which is where that pose's `p01 = 24` / `shadow_frac = 0.0424` / `sat_mean 132`
   come from. Those are not cloud statistics. Worse, `rocks.js`, `terrain.js`,
   `vegetation.js`, `ocean.js` and `sky.js` were all being edited *during* this session,
   so consecutive captures of the same build differ inside that ROI by more than any
   cloud parameter moves it. **Every tuning decision above was taken on the cloud-body
   mask (`tools/_clstat.py body`), which differences against a `--skip clouds` control
   captured minutes apart, not on the ROI.**
3. There are **stars visible in the daytime sky** at both poses (sky module). They inflate
   `lap_var` and `edge_density` in that ROI by an amount no cloud change controls.

### Determinism — the scene is nondeterministic, and it is not this module

Three identical `--settle 48` captures at ref_00720 gave whole-frame `lum_mean` 113.9 /
89.3 / 125.9. **This is `sky.js`, not clouds**, and the control proves it: three identical
captures with `--skip clouds` gave 109.45 / 109.60 / **73.53**. Visually, the low-mean
runs render a near-black sky with no atmosphere, gas giant or sun, while the cloud
silhouettes in the same pair are unchanged in shape and position. The cloud module uses
`ctx.rand.fork('clouds')` for its three volume seeds and `vdc16(ctx.clock.frame)` for the
temporal phase; there is no `Math.random`/`Date.now` anywhere in it. I could not obtain a
clean determinism measurement while `sky.js` is mid-edit and am not claiming one.

---

## 8 — cost

Not resolvable above the noise floor against a scene whose other modules are being edited
between runs. Structurally: the march loop cap went 160 -> 256 and the integration step
got finer, which costs; the empty-space search got much coarser and `maxDist` went
150 -> 70 km, which saves; the light march is unchanged at 6 cone taps + 1 far tap; the
multi-scatter octaves went 3 -> 6 but reuse the single light-march result, so they are
6 extra ALU iterations and **zero** extra texture fetches. Init is unchanged (128^3 shape,
64^3 erosion, 512^2 weather, ~27 ms).

---

## 9 — citations relied on

All from `research/clouds.md`, which quotes them with URLs:

- Jendersie & d'Eon, *An Approximate Mie Scattering Function for Fog and Cloud Rendering*,
  SIGGRAPH 2023 Talks — the HG+Draine phase function and the d = 25 um parameter fit.
  <https://research.nvidia.com/labs/rtr/approximate-mie/publications/approximate-mie.pdf>
- Schneider & Vos, *Nubis*, SIGGRAPH 2017 — `GetLightEnergy` (in-scatter probability),
  `SampleCloudDensity` (`cloud_top_offset`, `saturate(height_fraction*10)`,
  `high_freq_noise_modifier*0.2`), empty-space skipping with the step-back.
  <https://d3d3g8mu99pzk9.cloudfront.net/AndrewSchneider/Nubis-Authoring-Realtime-Volumetric-Cloudscapes-with-the-Decima-Engine-Final.pdf>
- Schneider, *Nubis Evolved* (2022) / *Nubis^3* (2023) — corrected `HenyeyGreenstein()`,
  adaptive step size, `pow(density, 0.3..0.6)` sharpening, `ambient_scattering`.
- Hillaire, *Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite*,
  SIGGRAPH 2016 — Eq. 17 analytic scattering integration, Eqs. 19/20 multi-scatter
  octaves and the `a <= b` energy condition, sigma_t = 0.05-0.12 /m for cumulus
  (quoting Hess et al. 1998 / OPAC), the ambient height gradient and desaturate note.
  <https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf>
- Wrenninge, *Art-Directable Multiple Volumetric Scattering*, SIGGRAPH 2015 Talks — Eq. 1.
- clayjohn, godot-volumetric-cloud-demo — the 6-vector cone kernel, `lss = thickness/36`.
- Trade-cumulus LCL 600-700 m and cloud fraction 13-19% (BOMEX/RICO): Vial et al.,
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC5717165/>

Explicitly **not** used, and why: the 2015 Beer-Powder constants (`1-exp(-2d)`, the `2.0*`
prefactor) — `research/clouds.md` §8 flags them as unverified against any primary source,
and §3.5 says the 2017 in-scatter probability replaces rather than accompanies them.

---

## 10 — weakest things left, in order

1. **`cloudComposite` still bilinear-upsamples the silhouettes this march now writes**,
   because it reads the same destroyed `pipe.depthTex`. Needs an owner of `scene.js`
   (copy world depth to a dedicated target before `clearDepth()`), then `cloudComposite`
   and this file both point at it. ~2 px of softening on every geometry edge today.
2. **Body `p50` is 45 codes under the reference hero cumulus** (144 vs 189) while p01,
   p90, std, f230 and f110 all match. The mid-tones between the dark base and the sunlit
   top are too dark. More octaves or more gain both fix p50 by breaking one of the five
   numbers that currently match, so this wants a better multiple-scattering model (a real
   `ms_volume` / dual-lobe secondary scattering per *Nubis Evolved*), not another knob.
3. **`local_contrast` 0.0347 vs 0.0394** at ref_00000 — the only member of the
   critic's diagnostic triplet that did not move the right way. `edge_density` and
   `lum_std` both did.
4. **Weather organisation.** kf_00720 is one large congestus bank filling the right half
   of the sky; ours is a cluster plus a scattered field. The `sys` clustering term in
   `WEATHER_FRAG` is the lever and it was not touched this pass.
5. The near-field cloud at ref_00720 shows faint internal banding from the 6-sample light
   march. More cone samples (the brief wants 12-16 for stills) would fix it.
