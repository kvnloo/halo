# fog — report

Owned file: `src/render/passes/volumetricFog.js`. All numbers from `tools/capture.mjs
--pose <p> --settle 48` + `tools/metrics.py` / `tools/roi.py`.

**Measure with `HALO_NO_DAEMON=1`.** The shared capture daemon (`tools/captured.mjs`,
`HALO_NO_HMR=1`) serves a *cached module graph*: after you edit a pass file it keeps
capturing the old code, silently. `--config` overrides still work, so an A/B by config
looks live while an A/B by source edit is a lie. Grep the capture output for
`passes not loaded` — it swallows shader syntax errors into `warnings[]`.

**And measure back to back.** Fifteen-plus agents are editing world modules right now and
the frame moves under you by 10+ points of `sat_mean` in the time it takes to run five
captures. Every A/B below was captured consecutively inside one batch; numbers from
*different* batches in this document are not comparable to each other and are labelled as
such. A capture whose PNG is ~44 kB is a black frame — another module was mid-save. Check
the file size before you believe a number.

---

## 1. THE DEPTH TEXTURE THIS PASS READS CONTAINS ONLY THE WEAPON — not my file, STILL LIVE

`src/render/passes/scene.js` step 7, unchanged as of this session:

```js
renderer.setRenderTarget(pipe.sceneRT);
renderer.clearDepth();          // <-- sceneRT.depthTexture IS pipe.depthTex
renderer.render(scene, vm);
```

`RenderPipeline` binds one `DepthTexture` to *both* the G-buffer and `sceneRT`
(`RenderPipeline.js:137-158`). `clearDepth()` wipes the world's depth every frame, before
any post pass runs, and refills it with the viewmodel alone. Proved previously by
rendering `isGeo`/`tEnd` straight out of the march (`shots/fog/dbg4.png`: a flat field
with the assault rifle cut out of it).

**Everyone downstream of `scene` that samples `pipe.depthTex` is reading garbage** —
`dof`, `motionBlur`, `taa`, `ssao`/`ssr`, water refraction. One small fix in `scene.js`:
give the viewmodel its own depth buffer, or blit `depthTex` into a private copy before the
`clearDepth()`. I own neither file and have not touched them.

Consequences that are still load-bearing in this file: `uGeoMaxDist`, `uUseNormalMask`,
and the fact that opaque pixels have no distance at all here (2).

## 2. Who owns aerial perspective — the decision, and why

**`wmAerial` owns it, exclusively, on every surface. This pass owns the sky and the
shafts. Neither term is applied twice to any pixel.**

`src/gfx/materialCommon.js` injects `wmAerial` (extinction *and* in-scatter) into every
opaque world material, and `src/world/ocean.js:1116` applies a verbatim copy of the same
function to the water surface using the *same shared uniform block*. So both classes of
surface already carry a complete aerial-perspective term before this pass runs.

The alternative split — this pass owning aerial perspective for everything, with
`aerialDensity = 0` — is the better architecture (it is shadowed, it is integrated, it
blends with the sky that is actually drawn) and **it is not implementable today**: it needs
a per-pixel distance for opaque pixels and 1 has taken that away. Do not attempt it before
1 is fixed. Water is the exception, and that is why the sea plane (3.1) is analytic.

## 3. What I changed

Three defects, all of them in the classification and compositing rather than in the
density tuning. None of them is a look knob.

### 3.1 Water was classified as sky — 460 m of haze on top of ocean.js's own `wmAerial`

Water is `LAYER.TRANSPARENT`, so it is in neither the G-buffer pre-pass (which is where
this pass gets its geometry test, per 1) nor `tDepth`. Every ocean pixel therefore fell
through to `isGeo = 0` and had the entire 460 m layer integrated in front of it — the
identical double-count this pass was fixed for on opaque surfaces last session, still live
over the whole sea, which in these poses is a third of the frame.

The fix needs no depth buffer: the ocean is a plane at a known height (`ocean.level`,
docs/WORLD.md "sea level is y = 0"), so `t = -(camY - seaLevel)/dir.y` is exact. `seaHitDist()`
in `CLASSIFY_GLSL`; a hit clamps `tEnd` and sets `isGeo`, so `geoW` yields the in-scatter
and the extinction to ocean.js together. Gated by `fogSeaPlane` and switched off entirely
if the ocean module is absent, rather than guessing a plane that would truncate every
downward ray.

This is also strictly conservative for dry land: the beach sits *above* y = 0, so the
plane is always at or beyond the true surface distance and never shortens a march past it.

### 3.2 The "bilateral" upsample was weighted by the destroyed depth — it was plain bilinear

The composite weighted each low-resolution tap by `|linZ(tDepth[tap]) - linZ(tDepth[here])|`.
By 1 that texture is the far plane everywhere, so every `err` was ~0, every weight was ~1,
and the filter degenerated to bilinear — across a buffer whose two pixel classes ("sky,
460 m of haze" and "surface, shafts only") differ by ~100 code values.

Visible as hard quarter-resolution vertical bars along the dune grass. Differenced against
`fogDensity=0`, **max +108 code values** (`shots/fog2/d_fog.png`, first batch).

Fixed by weighting on the march's own sky/surface classification, recomputed in the
composite from the same three signals in the same order (`classify()`, sharing
`CLASSIFY_GLSL` with the march so the two cannot drift apart). A class mismatch outranks
any depth disagreement by 1e4. The depth term is kept as a secondary weight because depth
*is* valid for the viewmodel, which is the one thing still in that buffer.

After: the pass's whole contribution peaks at **+15** (`shots/fog2/d_new.png`), and the
`horizon` ROI recovers **+112 lap_var** (3.3 below) — the bars were destroying real edges.

### 3.3 The warm tint was being applied to the ambient lobe

`uWarmTint` (1.10, 1.015, 0.89) multiplied the sky in-scatter as well as the sun
in-scatter. Differenced against `fogDensity=0` the pass was laying **(+17, +12, +3)** code
values over the open sky — a yellow veil, wrong on every axis (ref `sky` `lab_b` −15.07).
Lit dust is warm because the *sunlight* through it is warm; that is the sun lobe. The
tint now applies there only.

### 3.4 The in-scatter colour is now the sky radiance in the view direction

research/aerial.md §1.3: set `s → ∞` in the single-scattering solution and `L → J`, so the
equilibrium in-scatter `J` *is*, by identity, the radiance of an infinitely deep slab of
the same medium — the sky radiance in that direction. If `J` is not what the sky module
paints there, the haze drags everything it touches toward whatever fixed colour `J`
actually is, and distant geometry is outlined against the sky instead of dissolving into
it.

The old `J` was `mix(ground, 0.72·zenith + 0.28·horizonTowardSun, y·0.5+0.5)`. That 0.28
put more than a quarter of the bright, nearly achromatic circumsolar band into the
*zenith* — the direction it is most wrong for — so the haze desaturated the top of the sky
by construction.

`skyJ()` now reconstructs `J` per pixel from four real `sky.radiance()` samples (zenith,
and the horizon at the solar / 90° / anti-solar azimuths), blended `sqrt` in elevation.
Cost: four 14-step CPU marches per frame and five shader ALU ops.

**This is the term that has a falsifiable prediction, and it passes.** If `J` is right, the
ambient lobe must be a *no-op on clear sky* — `mix(src, J, 1−T)` with `J = src`. Measured
at ref_00120, back to back: `fogShafts=0` gives whole-frame `sat_mean` **53.8** against
`fogDensity=0` (the pass off entirely) **53.7**, and `lap_var` 359.8 against 360.1. The
lobe is doing nothing to the clear sky and everything to the clouds and the horizon band,
which is the correct limit. It measured as a ~0.1-point change on its own; I kept it
because it removes a hand-authored colour that would drift the moment the atmosphere is
retuned, not because it moved a number.

## 4. Before / after — measured

Three captures back to back, `ref_00000`. "before" = `git show HEAD:` of this file, swapped
in and out around the captures.

```
ref_00000, whole frame       lum_mean   sat_mean   lab_b   lap_var
  before                        111.4       39.5    -2.2     204.8
  after                         109.7       53.8    +0.8     296.1
  after, fogDensity=0           108.6       55.0    +0.6     292.4
  reference (clip target)       107.8       83.9    +1.4     463.0

ROI                    before -> after   (pass off)   reference
  water     sat          29.1 -> 47.1      (47.0)        69.7
  water     lap_var     358.8 -> 660.2    (629.3)       676.6
  water     lum         118.0 -> 114.9    (113.6)       114.3
  sand      sat          38.3 -> 65.8      (66.0)        69.0
  shoreline sat          39.5 -> 62.2         —          69.3
  cliff     sat          31.2 -> 37.3      (38.0)        87.5
  rock      sat          51.7 -> 53.3      (57.6)        86.6
  rock      lap_var     156.6 -> 207.8    (217.9)       466.2
  horizon   lum         131.3 -> 131.7    (131.4)       119.5
  horizon   lap_var     222.6 -> 334.3    (339.6)       554.2
  sky       sat          48.8 -> 48.8      (52.7)        87.0

ref_00120, whole frame       lum_mean   sat_mean   lab_b   lap_var
  before                        110.6       38.8    -3.2     241.0
  after                         108.1       52.6    -0.2     376.0
  after, fogShafts=0            106.5       53.8    -0.5     359.8
  after, fogDensity=0           106.8       53.7    -0.5     360.1
```

**The pass cost 15.5 points of whole-frame `sat_mean` and 87.6 of `lap_var`; it now costs
1.2 and *adds* 3.7.** At ref_00120: 14.9 -> 1.1. Reproduced in three independent
back-to-back batches (deltas +13.9 / +14.6 / +14.3 `sat_mean`).

Whole-frame contribution, differenced per pixel against `fogDensity=0` in one clean batch:

```
                     mean   p99    max    top third   mid    bottom third
  before             3.97    29    +70      1.37      5.10       5.45
  after              0.54     6    +15      1.37      0.22       0.02
```

The near-field wash is gone (bottom third 5.45 -> 0.02 mean) and the sky contribution is
untouched (top third 1.37 both) — i.e. **the horizon haze was not traded away for the
saturation.** `horizon` `lum_mean` is 131.7 after against 131.4 with the pass switched off
and 131.3 before: the pass's horizon contribution is unchanged, and the 12 points by which
that ROI overshoots the reference's 119.5 are not this file's (see 6).

Determinism re-checked: two `--pose ref_00000 --settle 48` captures are byte-identical.

## 5. Shafts, verified separately

`fogShafts=0` A/B at ref_00120, differenced per pixel (`shots/fog2/d_G1shaft.png`): mean
+1.49/255, p99 +20, max +97, and the contribution is *structured* — bright in the sky gaps
between the cloud deck and the canopy, near zero on the open beach. It reads the shadow
cascades; it is not a frame-wide lift. Whole-frame cost 1.2 `sat_mean` / 1.6 `lum_mean`,
and it is now the entire residual cost of this pass (4).

## 6. **The remaining aerial-perspective defect is `uAerialDensity`, and it is not in my file**

`src/gfx/materialCommon.js:79` — `uAerialDensity: 0.0062` per metre. Beer–Lambert on that:
46 % of every pixel at 100 m is fog colour, 84 % at 300 m. Koschmieder (`V = 3.912/β`)
makes it a **meteorological visual range of 631 m** — between "light fog" and "heavy fog"
in the Hoffman & Preetham table — in a scene that is supposed to see 1–2 km.
research/aerial.md §0 derives this independently and calls it wrong by ~13x. This file's
own `fogDensity = 0.00075` is `V = 5.2 km`, which is the right order for tropical haze.

Measured, one back-to-back batch (earlier scene state, so compare only within the block):

```
ref_00000                  whole sat   horizon lum   horizon sat   horizon lap   cliff lum
  as shipped                    45.8         137.1          25.8         306.7       121.4
  --config aerialDensity=0      51.7         118.0          44.1         697.3       104.3
  reference                     83.9         119.5          81.9         554.2       104.9
```

Switching `wmAerial` off lands `horizon lum_mean` on 118.0 against the reference's 119.5
and `cliff lum_mean` on 104.3 against 104.9 — both essentially exact — while returning
**+18.3 horizon saturation and +390 horizon `lap_var`**. It is smearing the distance band
it exists to create. That is the largest single aerial defect left in the project and it
needs one number changed by whoever owns `materialCommon.js`. Note the copy in
`src/world/ocean.js:703` aliases the same uniform block, so the one change fixes both.

Two secondary defects in the same function, from research/aerial.md §0, that I have
verified by reading but not measured:

- `phase = mix(0.42, wmHG(cosT,0.76)*2.6, uAerialSunAmount)` with `uAerialSunAmount = 0.55`
  leaves `0.45 x 0.42 = 0.189` of achromatic sun-coloured in-scatter present in **every**
  direction, including 180° from the sun. A correct HG at g = 0.76 falls to 0.0062 sr⁻¹ at
  the anti-solar point. It is a flat white pedestal over the whole frame, and multiplying a
  normalised phase function by 2.6 and mixing it against a bare constant destroys the
  normalisation, so the in-scatter is no longer bounded by the sky radiance.
- `uAerialHeightFalloff = 0.021` is a 48 m e-folding height — a ground-hugging mist layer,
  not air. Bruneton/Hillaire use 1.2 km for the Mie layer; Preetham recommends constant
  density at this range.

**And a genuine double-apply I cannot fix from here** (research/aerial.md §5.3): `wmAerial`
adds an *unshadowed* sun lobe to every opaque surface, and this pass adds a *shadowed* one
to the same pixels — `sunTerm` is deliberately not gated by `geoW`, because gating it would
delete the shafts wherever they cross geometry, which is the only place a shaft is visible.
The resolution belongs on `wmAerial`'s side (`uAerialSunAmount`), not here.

## 7. Cost

No extra march steps (40 at 1/4 x 1/4). Added: one ray-plane test per low-resolution pixel
(~5 ALU, no fetch); in the composite, `classify()` on the centre pixel plus four taps —
each an early-out chain of at most two nearest fetches and one `mat4` multiply, replacing
five depth fetches that were already there, so the delta is ~5 extra full-resolution
fetches per pixel (~10M at 1080p); four `sky.radiance()` CPU marches per frame, 14 steps
each, which is noise beside a single draw call. Estimated well under 0.3 ms.

**I could not measure this honestly** — nothing in `tools/` exposes a GPU timer and capture
wall time is dominated by Chrome startup. That is unchanged from the previous session and
it is worth someone's half hour.

## 8. Weakest thing left

1. **`uGeoMaxDist = 60` is still a made-up number** standing in for a distance this pass is
   entitled to and has been robbed of by 1. Shafts still leak through solid geometry for up
   to 60 m. The sea plane now supplies a real distance for every downward ray, which covers
   the ocean and shortens many beach rays, but rock, cliff and structure silhouettes above
   the horizon line still march a flat 60 m. Fix 1 and this whole branch deletes itself —
   the depth path is still in the shader and takes over automatically.
2. **The sun lobe on sky pixels.** It is the entire residual cost of this pass (1.2 sat,
   4.2 on the `sky` ROI) and the sky module already renders its own circumsolar Mie lobe.
   The two are not the same medium — this one is a 24 m-scale-height local dust layer the
   planetary model does not contain — so it is not a strict double-count, but `fogShafts`
   is explicitly a calibration constant absorbing a unit mismatch between
   `DirectionalLight.intensity` and the sky's `solarIrradiance`, and nobody has reconciled
   those. Until someone does, its magnitude is unfalsifiable and I did not touch it.
3. **This file cannot reach the `sat_mean` 83.9 target and it is no longer what is stopping
   the project from reaching it.** With the pass switched off entirely the frame measures
   55.0 and the `rock` ROI 57.6. The ceiling this file can deliver is 55.0 and it is now
   within 1.2 of it. Of the remaining ~29 points, ~6 are `uAerialDensity` (6) and the rest
   are in the material and tonemap chain.
4. **docs/KNOWN_ISSUES.md section 8 now names the wrong file.** It says the additive
   near-field in-scatter is in `volumetricFog.js`. That was true and is now measured at
   1.2 points of `sat_mean`. Whoever owns that document should point section 8 at
   `materialCommon.js:79` and at 6 above.

## 9. Citations

- `research/aerial.md` (this project) — §0 the `uAerialDensity` diagnosis, §1.2 the
  closed-form single-scattering solution, §1.3 `J` = sky radiance (the basis for 3.4),
  §5.3 the sun-lobe double-apply.
- Hoffman & Preetham, *Photorealistic Real-Time Outdoor Light Scattering*, Game Developer,
  Aug 2002 — https://renderwonk.com/publications/gdm-2002/GDM_August_2002.pdf (Eq. 1/3/4;
  the extinction-coefficient/visibility table).
- Preetham, *Modeling Skylight and Aerial Perspective*, SIGGRAPH 2003 course notes —
  https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf (independent
  derivation of the same solution; constant density is safe at ground range; HG sign
  convention).
- Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*,
  EGSR 2020 — https://sebh.github.io/publications/egsr2020.pdf (Table 1 coefficients,
  Mie scale height 1.2 km).
- Íñigo Quílez, *Better Fog* — https://iquilezles.org/articles/fog/ (the height-exponential
  analytic integral already in `densityAt`/`wmAerial`; unchanged, it is correct).
