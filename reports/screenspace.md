# screenspace — `src/render/passes/ssao.js`, `src/render/passes/ssr.js`

Wave I. Owner of these two files only (plus `tools/_ssprobe.mjs`). Wave H's report is
superseded by this one; the parts of it that still stand are re-stated below with today's
numbers, because the tree moved under every one of them.

---

## 0. Headline

Three things, in order of size:

1. **The opaque-depth snapshot is deleted.** `reports/depth.md` §1 asked for it, proved it
   bit-identical to `pipe.depthTex` at all 21 poses, and left the deletion to this owner. I
   re-confirmed 0 differing pixels on today's tree before deleting. Both passes now read
   `pipe.depthTex`. −8.3 MB, −1 full-screen R32F draw, −1 scene object, −2 dead config knobs.
   No image change, by construction.

2. **`fi`, the indirect fraction the AO composite weights itself by, was missing the IBL.**
   `env.js` owns `scene.environment` and puts `groundIrradiance = 0.549` on a flat piece of
   beach; the analytic sky fill it was being compared against is `0.649`. So **46% of the
   ambient in this scene was absent from the estimate**, `fi` on sunlit sand read 0.1415
   instead of 0.2334, and the AO was applied at 61% of its correct weight everywhere. Fixed
   by evaluating the probe's own published SH9 (`env.shArray`) per pixel — the same
   expression `env.js:524` uses to produce the number `tonemap.keyedExposure()` already
   trusts. Not a fitted constant.

3. **The dual-radius GTAO collapsed into a single radius over the whole near field, and the
   `min()` combine was therefore a downward-biased estimator rather than Lagarde's rule.**
   Both passes shared one 96 px clamp; on the foreground beach (0.26–1.4 m) both saturate it,
   so `min(aoL, aoS)` was `min()` of two noisy estimates of the *same* integral. Measured:
   44% of the contact pass's near-field darkening was estimator bias, not geometry. The
   contact pass now has its own clamp (24 px).

And one negative result that matters more than any of them: **the correct amount of AO on
this beach is very close to zero, and the reference agrees.** §3.

---

## 1. The deletion (KNOWN_ISSUES §18 follow-through)

`reports/depth.md` fixed the root cause: `pipe.depthTex` now holds opaque world depth for the
whole frame. Its §1 listed the pure deletion this file owed:

* `ensureOpaqueDepth`, `opaqueDepthTexture`, `OPAQUE_DEPTH_FRAG`, the probe mesh and the
  `_opaqueDepth` WeakMap — gone from `ssao.js`.
* `ssr.js` no longer imports from `ssao.js` at all.
* `aoLegacyDepth` / `ssrLegacyDepth` — gone. They selected between two byte-identical
  textures.
* `LAYER` is no longer imported by `ssao.js`.

**Verified before deleting, not asserted.** `node tools/_depthprobe.mjs --pose ref_00000
--settle 48` on today's tree:

```
agree: { snapshotGeoFrac 0.85696, differingPx 0, maxAbsDiff 0, identical true }
```

**Verified after deleting.** `node tools/_ssprobe.mjs --pose ref_00000` reads `pipe.depthTex`
directly now (through an RGBA32F resolve — a `DepthTexture` cannot be a colour attachment):

```
depth: { readOk true, geoFrac 0.85682, zeroFrac 0, near 0.06, far 12000, reversed false }
```

0.85682 against the G-buffer opaque mask's 0.85696 — the same buffer, to four decimals.

Two tool fixes went with it:

* `tools/_ssprobe.mjs --config` **has never applied anything** — `depth.md` §7 found it, and
  it was my bug: `H.setConfig` is `(key, value)` and the probe passed an object. Fixed, and
  the probe now echoes `appliedConfig` back in its output so a silent no-op cannot recur.
  Every `--config` number in Wave H's report §8 was a reading of the shipped build.
* `_ssprobe` gained a `lighting` block that reports every term of the direct/indirect split
  against `lighting.js` and `env.js`. That block is what found §2.

---

## 2. `fi` was missing the IBL — the AO was applied at 61% of its correct weight

The apply pass cannot separate direct from indirect radiance (forward lighting), so it
*estimates* the indirect share per pixel and attenuates only that. Research §2.7 is
unambiguous that this is the rule ("the ambient occlusion term is only applied to indirect
lighting"), and the estimate is the whole ballgame: if a term of `I` is missing, AO is
silently under-applied everywhere and the pass *looks* well-behaved because it is barely
doing anything.

`I` counted the `HemisphereLight` and the bounce `DirectionalLight`. It did not count
`scene.environment`, which `env.js` owns and which puts IBL diffuse into every
`MeshStandardMaterial` in the frame. Measured at `ref_00000`, `t = 12.0`:

| term | value | source |
|---|---:|---|
| `sunLum` (sun, ×`lum(sunColor)`) | 6.0032 | `lighting.js:75` — matches the pass exactly |
| `skyLum` (hemisphere fill) | 0.6494 | `lighting.js:77` — matches the pass exactly |
| `bounceLum` | 0.2370 | `lighting.js:79` — matches the pass exactly |
| **`env.groundIrradiance`** | **0.5495** | `env.js:650`, **was not in the estimate at all** |

The IBL is **85% the size of the hemisphere fill** and 46% of the total ambient on an
up-facing surface. On flat, unshadowed, sunlit sand (N = +Y, sun altitude 0.656):

```
direct                       3.9385
fi  analytic lights only     0.1415      <- what shipped
fi  with the env IBL         0.2334      <- correct, +65%
```

**The fix is not a constant.** `env.js` publishes `shArray` (a `Float32Array(27)`, "flat rgb
triples, ready for uniform upload") and evaluates exactly three's `shGetIrradianceAt`
expression at `env.js:524` to produce `groundIrradiance` — the number
`tonemap.keyedExposure()` already adds to the photographic key, in `lighting.js`'s own units.
The apply pass now uploads the luminance projection of those nine coefficients (×
`env.intensity`) and evaluates the same expression against **this pixel's** world normal
instead of against +Y. Nine MADs, clamped at 0 for SH ringing.

`--config aoUseEnv=0` restores the old behaviour for a same-build A/B.

**Why this was invisible for three waves:** it makes AO weaker, and weaker AO on a beach
looks *correct* — no dirt, no halos, nothing to report. It is the quiet half of research
§2.7's failure pair. The loud half (AO on direct sun) is what everyone looks for.

---

## 3. THE EXPERIMENT: how much AO is right, and the reference's answer is "almost none"

Wave H measured that the foreground beach is a plane to within millimetres and concluded the
pass correctly returns ~1 there. Terrain has since gained relief — the same measurement, same
tool, today:

| 0–4 m band, out-of-plane deviation | wave H | today |
|---|---:|---:|
| 8 px p90 / p99 | 1.2 mm / 15 mm | 1.6 mm / 29 mm |
| 32 px p50 / p90 / p99 | 1.5 mm / 9.9 mm / 56 mm | 1.8 mm / 17 mm / **117 mm** |

Relief roughly doubled, and the AO buffer followed it: the 0–5 m band's mean went 0.9936 →
0.979, `min` 0.66 → 0.43. So the pass *is* now finding foreground geometry.

**And it should still barely darken the image, because the reference is brighter and cleaner
than we are.** `sand` ROI at `ref_00000`:

```
                lum_mean   p01   shadow_frac   sat_mean   lap_var
ours (AO off)     102.19     22       0.0209      54.82    610.9
ours (AO on)      101.72     20       0.0229      54.94    611.2
REFERENCE         119.22     31     0.0110       86.58   1089.0
```

The reference sand is **17 code values brighter** and has **half our shadow fraction**. Our
sand deficit is luminance (−17), saturation (−32) and detail (−478 lap_var). **None of those
is an AO deficit — two of the three are the wrong sign for AO.** Any tuning that puts more
darkening on this ROI is fitting a constant to make an already-too-dark region darker.

So the honest statement of what this pass contributes, which is what the brief asked for:

| | when it rendered zero pixels (`aoEnabled=0`) | now |
|---|---:|---:|
| `sand` lum_mean | 102.19 | 101.72 (**−0.47**, 0.46%) |
| `sand` p01 | 22 | 20 |
| `sand` shadow_frac | 0.0209 | 0.0229 (**+0.20 pp**) |
| `rock` (ref_01500) lum_mean | 105.69 | 105.21 (−0.48) |
| `rock` (ref_01500) lap_var | 542.3 | 546.3 (+0.7%) |
| `rock` (ref_01500) edge_density | 0.0873 | 0.0878 (+0.6%) |
| `rock` (ref_01500) local_contrast | 0.1297 | 0.1314 (+1.3%) |
| whole-frame score ref_00000 / ref_01500 | 32.53 / 28.77 | 32.64 / 28.67 |

All four arms of that table were launched **simultaneously** and are `--config` arms of one
build, so no source churn is inside them. The score movement (±0.1) is an order of magnitude
inside KNOWN_ISSUES §26's ±0.5 noise floor: **this subsystem does not move the score, and on
the evidence above it should not.**

**Do not compare any of these numbers with Wave H's.** Between my first and second capture
batch this session — about thirty minutes — the `rock` ROI at `ref_00000` moved `lap_var`
221 → 392 and `sat_mean` 56.0 → 68.8 with the AO/SSR arms all switched off. That is
`rocks.js` landing under the measurement (KNOWN_ISSUES §16). Only within-batch rows above are
comparable.

### AO is NOT on direct sun — checked, with the number rather than the picture

Research §2.7 describes the failure as grey rims on sunlit silhouettes, a doubled shadow
terminator and collapsing highlight contrast. The composite here weights AO by `fi` and
`fi` is computed from the engine's actual light intensities (§2 table — all three analytic
terms verified line-for-line against `lighting.js`), gated by a real CSM lookup
(`_ssprobe` reports `csm { present true, lights 4, mapsReady 4, uNumCasc 4 }`). On sunlit
sand `fi = 0.233`, so a crease there receives 23% of the occlusion and 77% of the pixel is
untouched. `aoAmbientFloor` remains 0, which makes `src·(1−fi) + src·fi·occ ≡ src·mix(1,
occ, fi)` algebraically exact rather than a cheat. `highlight_frac` in the `sand` ROI is
0.0000 in every arm and 0.0070 in the `rock` ROI in every arm — AO moves neither.

---

## 4. The dual-radius collapse — a `min()` that was not Lagarde's rule

`radiusPxL = clamp(uRadius·pxPerMetre, 2.5, 96)` and
`radiusPxS = clamp(uRadiusS·pxPerMetre, 1.8, 96)` — **the same clamp**.

At `ref_00000` the foreground beach sits at p10 0.33 m, p50 1.15 m (`_depthprobe distM`).
`pxPerMetre = 0.5·H_half/(tanY·z)` is 380–1550 there, so the ambient radius (1.2 m) wants
460–1900 px and the contact radius (0.25 m) wants 95–390 px. **Both saturate 96 px.** The two
searches then cover the identical 96-px disc and `min(aoL, aoS)` is `min()` of two
independent noisy estimates of the *same* integral — which is not an estimator of that
integral, it is biased low by ~0.5σ. Worse, the contact pass spends `STEPS_S = 3` taps on
that disc against the ambient pass's 4, so it was also the *coarser* of the two: its taps
land at ~2.7 / 24 / 66 px against the ambient pass's 1.6 / 13.5 / 37.5 / 73.5.

Arithmetic: the contact clamp only stops biting past `z = 5.4 m` at 24 px and `z = 1.35 m` at
96 px; the ambient clamp stops biting past `z = 6.5 m`. So the defect is confined to the near
field — which is where the beach is.

**Three-arm A/B inside one build** (`_ssprobe --pose ref_00000`, AO buffer read off the GPU,
so nothing downstream of it can contaminate the number):

| arm | AO mean | p01 | frac<0.90 | frac<0.70 | **0–5 m mean** | 0–5 m min | 15–40 m | 40 m+ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| shipped (`aoMaxRadiusPxSmall=96`) | 0.9718 | 0.6909 | 0.0595 | 0.01064 | **0.9772** | 0.4158 | 0.985 | 0.964 |
| fixed (`=24`, new default) | 0.9728 | 0.7202 | 0.0563 | 0.00812 | **0.9790** | 0.4316 | 0.985 | 0.964 |
| no contact pass (`aoDualRadius=0`) | 0.9741 | 0.7329 | 0.0540 | 0.00727 | **0.9813** | 0.5186 | 0.9856 | 0.9641 |

Read the 0–5 m column: the contact pass's near-field darkening was 0.0041 and is now 0.0023.
**44% of it was estimator bias, not geometry.** The 15–40 m and 40 m+ bands are unchanged to
four decimals in all three arms — exactly the prediction, since neither clamp binds there.
That invariance is what makes this a clamp defect and not a retune.

`min()` is still Lagarde's rule where the two scales are genuinely different, which is now
everywhere. `aoDualRadius=0` and `aoMaxRadiusPxSmall` stay as A/B knobs.

**What is NOT fixed, and is not a bug:** in the near field the ambient pass still reaches only
`96 px / pxPerMetre` ≈ 0.21 m at 1.15 m and 0.06 m at 0.33 m, not its nominal 1.2 m. That is
the GTAO paper's own pixel clamp doing its job ("clamped to a maximum radius in pixels to
avoid too large gathering radiuses on objects very close to the near plane"). Raising it does
not buy reach for free: the 4 taps are already 36 px apart at the outer end, and widening the
disc widens the gaps occluders fall through. `aoMaxRadiusPx` is now a config knob if anyone
wants to sweep it.

---

## 5. Constants re-derived against real geometry — what moved and what did not

Every constant in these two files was fitted while the depth buffer contained a gun, or (Wave
H) against a private snapshot. This is the audit.

| constant | value | verdict |
|---|---|---|
| `aoRadius` 1.2 m | kept | Research §2.5 says 1.0–1.5 m for the main pass. Pixel-clamped in the near field regardless (§4). |
| `aoRadiusSmall` 0.25 m | kept | §2.5's "second 0.2–0.3 m pass, combined with `min()`". Now actually distinct — **its clamp was the bug, not its value.** |
| `maxRadiusPx` 96 | kept, now a knob | §2.5: 64–96 at half res. |
| **`maxRadiusPxSmall`** | **NEW, 24** | §4. Was implicitly 96 and that deleted the pass. |
| `aoAngleBias` 0.045 | kept | sin(2.6°). A 17 mm occluder (today's 0–4 m 32 px p90) at 0.1 m lateral subtends 9.6°, sin 0.167 — comfortably above the bias, so the foreground relief that now exists is *not* being erased by it. At the old 0.12 it would have been marginal. |
| `aoThickness` 0.30 | kept | XeGTAO's 0.15–0.30 for vegetation, both parts implemented. |
| `aoPower` 1.6 | kept | §2.5's 1.4–1.8 outdoor. XeGTAO's 2.2 is an interior value. |
| `aoAmbientFloor` 0.0 | kept | Earns its 0 from the CSM lookup (§3). |
| `aoDepthPhi` 0.06 + 0.012·z | kept | Plane-distance, not \|Δz\|. At 1.15 m → 0.074 m, at 60 m → 0.78 m. Both are above the surface's own curvature residual and below every silhouette in frame. |
| `uSunLum` / `uSkyLum` / `uBounceLum` | kept, **verified** | Reproduce `lighting.js:75/77/79` term for term, including `sunScale`/`skyFill`/`bounceFill`. Checked this wave; they are not eyeballed. |
| **env IBL in `indirect`** | **NEW** | §2. The one term that was missing. |
| `ssrWetRoughClamp` 0.12 | kept, still a workaround | `ref_01500` G-buffer **still** reports matId 2 at roughness 0.65–0.875, mean **0.703**, over **42.7%** of the frame, while `terrain.js:1650` shades the same pixel at `mix(rough, 0.16, wetp·0.85)`. Unchanged since Wave H. Revert to ~0.42 the day terrain writes its shaded roughness. |
| `ssrThickness` 0.55 / `ssrThickMax` 2.5 | kept | §6. |
| `ssrMaxDist` 90 m | kept | §6. |
| `ssrEdgeFade` 0.12 | kept | Research §5.7: the screen edge is the tell; 12% per axis, 2-D. |

---

## 6. SSR against real geometry

`_ssprobe`, AO/SSR buffers read off the GPU:

```
ref_00000   hitFrac 0.0480   strongFrac 0.0319   confMeanOverHits 0.669
ref_01500   hitFrac 0.0764   strongFrac 0.0525   confMeanOverHits 0.687
```

At `ref_01500`, wet sand (matId 2) covers **42.7%** of the frame but SSR returns a hit on
7.6% of it. That is not a bug and it is worth stating plainly, because it looks like one: a
ray leaving a beach at 2–10° above the horizontal travels up the screen and exits through the
top long before it finds anything (research §5.7). The remaining 35% falls to the sky
fallback, which is a real `sky.cubeTexture` sample in the correct reflected direction — which
is why there is no screen-edge seam. The EnvBRDF weight is applied identically to both
branches (Frostbite slide 87), so there is no brightness step at the fade either.

The pass contributes `rock` lap_var +0.6% and `sat_mean` +0.11 at `ref_01500` (`n_off` →
`n_aoonly` arms), against a 2.4× lap_var deficit. §7 item 2 says why.

### The thickness heuristic sits exactly on its knee — swept, at `ref_01500`

McGuire & Mara's interval test accepts a step when the ray-depth range `[zA, zB]` overlaps
`[sz, sz + thick]`, with `thick = min(uThickness + (zB−zA)·0.25, uThickMax)`. Both constants
were unvalidated at runtime. Sweeping them (same build, `--config`):

| arm | hitFrac | strongFrac | confMeanOverHits |
|---|---:|---:|---:|
| `ssrThickness=0.15` | 0.0759 | 0.0513 | 0.676 |
| **shipped: 0.55, `thickMax` 2.5** | **0.0764** | **0.0525** | **0.687** |
| `ssrThickness=2.0, ssrThickMax=10` | 0.0842 | 0.0586 | 0.694 |

Tightening by 3.7× moves `hitFrac` by **0.7%**; loosening by 4× moves it by **+10%**. That
asymmetry is the signature of a threshold at the knee: below 0.55 there are no more real
crossings to find, above it the extra acceptances are the false ones the interval test exists
to reject — research §7's "duplicated silhouette offset downward". Keeping 0.55 / 2.5.

`ssrMaxDist = 90 m` likewise: at 250 m `hitFrac` rises 28% (0.0764 → 0.0979) but
`confMeanOverHits` **falls** 0.687 → 0.607. With `SSR_STEPS = 24` fixed, a 250 m ray steps
10 m at a time, so `(zB−zA)·0.25` alone is 2.5 m and the interval test is pinned at
`thickMax` for the whole march. The extra hits are low-confidence far-field acceptances that
the length fade then throws most of away. Keeping 90 m.

---

## 7. Cost

Priced the way `reports/depth.md` §6 prices things: **one page**, arms alternated in blocks of
90 individually-timed frames with 20 discarded per block, two blocks per arm
(`scratchpad/_sscost.mjs`). `ref_00000`, p50 ms:

```
block 1   on 13.4    off 15.3
block 2   off 14.7   on 11.5
```

The **within-arm drift is 1.9 ms** (on: 13.4 vs 11.5) and the arm difference has the wrong
sign in both blocks. **The subsystem's cost is not resolvable by this instrument**, which is
the same conclusion Wave H reached (≈0.3 ms, inside the spread) and the same one `depth.md`
reached for a change that was provably two GL calls. KNOWN_ISSUES §22's caveat applies:
`performance.now()` around `step()` is CPU submit cost.

What *is* countable: 14 full-screen draws (ssao 4 half-res + 1 full-res; ssr 5 mip + 2
half-res + 1 full-res... plus the march), and this wave **removed** one full-res R32F draw,
one 8.3 MB R32F target and one scene object with the snapshot. The two additions are a
uniform branch (no divergence) and nine MADs in the apply shader.

---

## 8. Weakest things left, in order

1. **The `sand` and `rock` ROIs are short on luminance, saturation and detail, and this
   subsystem cannot supply any of the three.** `sand` is 17 code values darker and 32
   saturation points short of the reference; `rock` at `ref_01500` is 2.4× short on `lap_var`
   and 1.8× on `edge_density`. Those are `terrain.js` and `rocks.js` items. AO's entire
   authority over the image is ±0.5 code values, and the reference says even that is on the
   wrong side.
2. **The sea still has no reflection path.** Nothing in `src/` samples `ssrTexture`, and it
   is not a drop-in: the rays in it were traced from the opaque surface *under* the water.
   The right fix is research §6.2 option (2) — trace inside the ocean surface shader against
   `pipe.depthTex`, which now actually contains the world. Owner: `ocean.js`.
3. **`ssrWetRoughClamp = 0.12` is still a workaround for a `terrain.js` G-buffer/shading
   mismatch** — 0.703 written vs ~0.16 shaded, measured again this wave, unchanged. It is
   load-bearing: at 0.42 the cone footprint saturates the mip clamp and the sea-stack
   silhouettes get read out of a 60-px image.
4. **The apply pass's `indirect` still omits the hemisphere light's *ground* colour**
   (`0x2a2a26`, lum ≈ 0.026 × intensity). Correct for up-facing normals, ~4% low for
   down-facing ones. Not worth a uniform.
5. **No VNDF importance sampling / no ratio-estimator resolve in SSR** (research §5.3–5.4).
   One mirror ray, roughness expressed purely as blur. Costs contact-hardening.
6. **The near-field ambient radius is pixel-limited to ~0.2 m** (§4). Sanctioned by the GTAO
   paper, but it does mean the nominal 1.2 m is only achieved past ~6.5 m.
7. **Measurement hygiene:** `rocks.js` moved the `rock` ROI's `lap_var` by 77% between two
   capture batches thirty minutes apart in this session. Every cross-batch comparison in this
   project is worth less than it looks. Same-build `--config` arms launched simultaneously are
   the only kind that survived.
8. **Not mine, but live right now:** the last capture of this session printed
   `ReferenceError: aerialOrig is not defined` from `src/render/passes/volumetricFog.js:795`.
   `parsecheck` is green (it is a runtime reference, not a parse error), so the module loads
   and then throws per frame. Whoever owns that file should know; anyone measuring in this
   window should check their capture output for it.

---

## 9. Tools

* `tools/_ssprobe.mjs` — now reads `pipe.depthTex` through an RGBA32F resolve (a
  `DepthTexture` cannot be a colour attachment), applies `--config` correctly and echoes
  `appliedConfig`, and reports a `lighting` block: every term of the direct/indirect split
  against `lighting.js` and `env.js`, plus `fi` with and without the IBL.
* `scratchpad/_sscost.mjs` — interleaved same-page cost A/B (§7).

## 10. Sources

* Jimenez et al., *Practical Realtime Strategies for Accurate Indirect Occlusion* (GTAO),
  ATVI-TR-16-01 — arc integral eq. 7, bent normal, multibounce eq. 10, the pixel radius clamp.
* Intel XeGTAO, `XeGTAO.hlsli` — thin-occluder 481–503, edge weights 120–129,
  `FinalValuePower`/`max(0.03,·)` 556–558.
* Filament, *Ambient occlusion* — "the ambient occlusion term is only applied to indirect
  lighting"; `gtaoMultiBounce`; Lagarde `computeSpecularAO`; Lagarde's `min(AO_medium,
  AO_large)`.
* three.js `SphericalHarmonics3.getIrradianceAt` / `shGetIrradianceAt`, `DFGApprox` in
  `bsdfs.glsl.js`, `PoissonDenoiseShader`.
* McGuire & Mara, *Efficient GPU Screen-Space Ray Tracing*, JCGT 2014 — the `[zA,zB]` interval.
* Frostbite, *Stochastic Screen-Space Reflections* (SIGGRAPH 2015) — slides 84/85, 87.
* `research/screenspace.md` §0, §2.4–2.7, §4.1, §5.2, §5.5, §5.7–5.8, §6.2–6.3, §7.
* `reports/depth.md` §1, §3, §4, §6, §7.
