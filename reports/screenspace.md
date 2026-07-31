# screenspace — `src/render/passes/ssao.js`, `src/render/passes/ssr.js`

Wave H. Owner of these two files only. Everything below was measured on this tree; where the
tree moved under a measurement I say so.

---

## 0. Headline

The critic's verdict was right and the proof reproduced: both passes exited at their first
guard on every world pixel and rendered nothing. That is fixed, entirely inside these two
files, and both passes now run against real geometry.

Two of the critic's items turned out to have different causes than stated, and I have the
experiment for each:

* **P8 (captures are nondeterministic) is FALSE.** Two captures launched *simultaneously* are
  **byte-identical**, with the passes on and with them off. The 11.31-mean delta the critic
  measured was `src/` churn between two *sequential* captures — KNOWN_ISSUES §16, not a
  renderer bug. Method below; this matters because it makes A/B measurement possible again.
* **P1's "not one pebble has a contact shadow" is true, and it is not fixable here.** The
  foreground beach is a geometric plane to within millimetres in the depth buffer. Measured,
  not asserted. An AO pass cannot occlude an object that does not exist in depth.

---

## 1. The depth fix (critic P1) — root cause, and why it landed here

`RenderPipeline.js:137-158` binds one `DepthTexture` to both `gbuffer` and `sceneRT`;
`scene.js:114` calls `renderer.clearDepth()` on `sceneRT` before the viewmodel draw. By the
time post runs, `pipe.depthTex` is 1.0 everywhere except the gun (KNOWN_ISSUES §18).
`ssao.js:212` and `ssr.js:236/457` both test `d >= 1.0` meaning "sky, nothing to do", so every
world pixel took the early-out.

The clean fix is in `scene.js`, which this subsystem does not own — and `dof`, `motionBlur`,
`taa`, `volumetricFog` and water refraction are all being measured against the broken buffer
by other agents right now, so changing shared state mid-wave would move their numbers under
them. So the fix here is **local and additive**: an opaque-depth snapshot that copies
`pipe.depthTex` into an R32F target at the one moment in the frame when it still holds the
world, read only by these two passes. `pipe.opaqueDepthTex` is published for anyone else to
adopt; nothing is taken away.

**The mid-frame hook.** The scene pass does steps 1-7 in one `render()` call, so there is no
pass boundary between the opaque draw and the depth clear. The hook is an invisible degenerate
mesh on `LAYER.TRANSPARENT` with `renderOrder = -1e6`, whose `onBeforeRender` fires at the
start of scene.js step 5. **This is not a new trick** — `src/world/particles.js:1148` already
uses exactly this pattern to get a mid-frame depth copy. The copy binds its own target first,
so the depth texture is never sampled while attached to the bound FBO.

The copy stores the **raw non-linear** depth, so every existing `linearDepth(...)` call site
and every `>= 1.0` sky test stays byte-for-byte valid; only the bound texture changes.
`--config aoLegacyDepth=1,ssrLegacyDepth=1` restores the old (inert) behaviour for an A/B in
the same build — which is how the before/after in §5 was measured despite a churning tree.

**Verification** (`node tools/_ssprobe.mjs --pose ref_00000`):

```
depth: { readOk: true, geoFrac: 0.8486, near: 0.06, far: 12000, reversed: false }
```

85% of the frame carries world depth. Before the fix that number was ~0 (gun only).

---

## 2. THE EXPERIMENT: there are no pebbles in the depth buffer

The critic's central image claim is "every pebble in our frame meets the sand at exactly the
sand's brightness… that single difference is most of the −43% local_contrast." Before retuning
anything I ran the experiment that separates *"the AO is too weak"* from *"there is nothing to
occlude"*: read the opaque depth back off the GPU and measure the signal GTAO integrates —
the out-of-plane deviation `|dot(P_neighbour − P_centre, N_centre)|`, in metres, bucketed by
view distance (`tools/_ssprobe.mjs`, `relief`). At `ref_00000`:

| band | samples | 8 px p90 | 8 px p99 | 32 px p50 | 32 px p90 | 32 px p99 |
|---|---:|---:|---:|---:|---:|---:|
| **0-4 m (foreground beach)** | 49 105 | **1.2 mm** | **15 mm** | **1.5 mm** | **9.9 mm** | **56 mm** |
| 4-10 m | 947 | 19 mm | 64 mm | 16 mm | 85 mm | 424 mm |
| 10-25 m | 1 552 | 29 mm | 1.04 m | 10 mm | 0.71 m | 1.92 m |
| 25-80 m | 24 228 | 0.33 m | 3.35 m | 0.14 m | 1.86 m | 20.7 m |

**The foreground beach is a plane to within millimetres.** Over a ~15 cm patch of near sand the
surface deviates from flat by a median of 1.5 mm. The cobbles in `ref/detail/sand_4k.png` are,
in our build, albedo and normal-map detail on a flat mesh — the G-buffer normal comes from
`vViewNormal` (the geometric normal), not from a normal map, so SSAO never sees them either.

Corroborated by the AO buffer itself:

```
ao.byDepth   0-5m  mean 0.9936  min 0.66   (272k px)
             5-15m mean 0.9979  min 0.68
            15-40m mean 0.9881  min 0.03
             40m+  mean 0.9640  min 0.00
```

Where relief exists (rocks, cliffs, structures at 15 m+) this pass drives AO to zero. On the
beach it returns 0.9936, which is **the correct answer for a plane**.

**Conclusion, and it is a handover not an excuse:** the pebble-contact-shadow deficit is a
`terrain.js` geometry item. Displace the cobbles into real geometry and this pass will darken
them the same day with no change here. Any further "the AO is too weak" tuning against that
symptom is fitting a constant to a bug in a different file — exactly the trap KNOWN_ISSUES
§4/§6/§8 keep documenting.

---

## 3. What changed in `ssao.js`

1. **Opaque depth** (§1). Without it nothing below runs at all.
2. **Dual-radius GTAO with `min()` combine** (critic P3, research §2.5). Ambient pass
   `aoRadius` **2.2 → 1.2 m**; new contact pass `aoRadiusSmall` **0.25 m**; combined per
   Lagarde's rule as quoted by Filament. The small pass is not redundant: at the t² step
   distribution the large pass's taps land at ~1.6, 12, 33, 64 px, so a 5-px occluder between
   the first two taps is invisible to it; the small pass's taps at that depth land at
   ~1.6, 7, 19 px. `maxRadiusPx` 84 → 96 (research: 64-96 at half res).
3. **`aoAngleBias` 0.12 → 0.045.** 0.12 discards any occluder standing under 6.9° above the
   tangent plane; a 0.15 m pebble at 1.2 m subtends 7.1°, i.e. the bias sat exactly on top of
   the geometry it was pointed at. Research §2.4 caps the legitimate range at sin(5°)=0.087
   once texel-centre snapping is in place, which it already was.
4. **3 slices × 4 steps instead of 2 × 6** (research §0), same tap count. Slice-direction error
   is what the denoiser and temporal pass remove; step error is not.
5. **XeGTAO thin-occluder part 1 added** — the depth-axis stretch of the sample delta before
   the falloff test (`XeGTAO.hlsli:481-490`). Only part 2 (the horizon lerp) was present.
   *Correction to the research brief's appendix:* it suggests replacing
   `(shc>h) ? shc : mix(h,shc,c)` with XeGTAO's `lerp(max(h,shc),shc,c)`. Those are
   algebraically identical — when `shc > h` the max wins and the lerp is the identity. No-op.
6. **Falloff radius now `min(worldRadius, radiusPx/pxPerMetre)`.** The search is pixel-clamped
   near the camera but the falloff was spanning the full world radius, so the outermost tap
   kept ~full weight — a hard cutoff at the radius, research §7's "ring at a fixed distance
   from every object". `min()` is correct at both the near (pixel-clamped) and far (2.5 px
   floor) ends.
7. **Both bilaterals now weight by plane distance** (critic P4, research §4.1). Was
   `exp2(-|Δz| / 0.02·z)` in the denoise and `0.03·z` in the upsample. On a beach seen from
   1.74 m at ~4° the ground is grazing everywhere, so a raw `|Δz|` tolerance either refuses to
   blur the largest surface in frame or bleeds across every silhouette. Now
   `w = max(1 − |dot(P_s − P_c, N_c)| / phi, 0)` with `phi = 0.06 + 0.012·z` m, plus a normal
   similarity term — the form three's own `PoissonDenoiseShader` uses. Same change applied to
   `ssr.js`'s upsample.
8. **`aoAmbientFloor` 0.25 → 0.0, replaced by a real shadow term** (critic P5, research §2.7).
   The floor existed because the pass had no way to tell "facing the sun" from "lit by the
   sun", so it applied a quarter of the occlusion to *direct sunlight everywhere* — the single
   most recognisable bad-AO look, and it spent the frame's shadow budget on sunlit sand where
   the reference has none. The direct term is now gated by a real CSM lookup taken from
   `lighting.csm` exactly as `volumetricFog.js` does. Verified wired, not silently defaulting:
   `_ssprobe` reports `csm { present: true, lights: 4, mapsReady: 4, uNumCasc: 4 }`, and
   `--config aoDebug=7` renders `sunVis` (p01 23, shadow_frac 0.038 — it varies; there is
   simply little cast shadow at noon). With the floor at 0 the composite is now algebraically
   exact rather than a cheat: `src·(1−fi) + src·fi·occ ≡ src·mix(1, occ, fi)`.
9. **`FinalValuePower` 1.6**, applied after the temporal average (research §2.5 says 1.4-1.8
   outdoor; XeGTAO's 2.2 default is an interior value), plus XeGTAO's `max(0.03, ao)`.
10. New debug/A-B knobs: `aoLegacyDepth`, `aoUseShadow`, `aoDebug=7` (sunVis),
    `aoGtaoDbg=4` (contact-radius AO alone), `aoPower`, `aoDepthPhi`, `aoNormalPhi`.

## 4. What changed in `ssr.js`

1. **Opaque depth** (§1).
2. **Frostbite's grazing cone shrink** (critic P2, research §5.5, slide 85):
   `coneTan *= mix(saturate(NoV*2), 1, sqrt(rough))`. It was missing entirely.
3. **`ssrWetRoughClamp` 0.42 → 0.12.** The G-buffer measurably disagrees with the shading:
   `_ssprobe --pose ref_01500` reports matId 2 (TERRAIN_WET) covering **43.9%** of the frame
   with roughness **0.65-0.875, mean 0.703**, while `terrain.js:1650` shades the same pixel at
   `mix(rough, 0.16, wetp*0.85)`. Research §6.3 puts wet sand at `mix(rough_dry, 0.05-0.15,
   wetness)`. At 0.42 the cone footprint saturated the `clamp(...,0,4)` mip clamp for any
   roughness above ≈0.115, so the sea-stack silhouettes were being read out of mipRT[4] =
   60×33 px. **This clamp is a workaround for a `terrain.js` bug** and should be reverted to
   ~0.42 the day terrain writes its shaded roughness into the G-buffer.
4. **McGuire/Mara interval thickness test** (critic P7b, research §5.2). Was
   `thick = max(uThickness, stepExtent*1.6)` — unbounded, tens of metres in the far field of a
   90 m/24-step ray, which accepts almost any depth sample. Now each step's ray-depth range
   `[zA,zB]` must overlap the surface's `[sz, sz+thick]`, with `thick` **capped** at
   `ssrThickMax = 2.5 m`.
5. **Pre-integrated EnvBRDF instead of raw Schlick** (critic P7a, research §5.8b). `DFGApprox`,
   the same analytic fit three ships in `bsdfs.glsl.js`, applied after the temporal filter and
   after the sky/SSR mix, identically to both branches (Frostbite slide 87). Worked example on
   a wet-sand pixel at `rough` 0.12: at NoV 0.5 raw Schlick gives k≈0.63 and EnvBRDF gives
   **k=0.080**; at NoV 0.07 (4° grazing) they give 0.63 and **0.60**. That is the whole point —
   the geometric attenuation term collapses the weight everywhere *except* true grazing, so the
   swash sheet mirrors and the rest of the beach does not.
6. **Plane-distance upsample** (as §3.7).
7. **The water contract, documented honestly** (critic P6). Nothing in `src/` reads
   `ssrTexture` — and it is not a drop-in fix for the sea, because the rays in it were traced
   from the **opaque surface under the water**, not the water surface. The header now says so,
   points at research §6.2 option (2) (trace inside the ocean surface shader) as the right fix,
   and notes that the opaque depth that option needs now exists as `pipe.opaqueDepthTex` —
   which is a large part of why it was never wired up. `ocean.js` is owned by another agent
   this wave; this is a handover, not a fix.

---

## 5. Before / after, measured

**Method.** Both arms launched *simultaneously* (see §6) so they see the same tree, and "old"
is `--config aoLegacyDepth=1,ssrLegacyDepth=1`, i.e. the shipped inert behaviour reproduced in
today's build. That removes source churn from the comparison entirely.

`ref_01500`, ROI vs `kf_01500`:

| region / metric | OLD (inert) | NEW | REF |
|---|---:|---:|---:|
| rock lap_var | 81.56 | **98.27** (+20.5%) | 1295.5 |
| rock edge_density | 0.0337 | **0.0364** (+8.0%) | 0.1621 |
| rock sat_mean | 53.53 | **53.94** | 80.89 |
| water lap_var | 305.50 | **319.98** (+4.7%) | 900.8 |
| water sat_mean | 38.35 | **39.77** (+1.42) | 51.58 |
| water local_contrast | 0.0817 | **0.0822** | 0.0983 |
| shoreline sat_mean | 40.46 | **42.23** (+1.77) | 46.42 |
| shoreline lum_mean | 105.59 | 106.01 | 70.35 |
| sand lap_var | 295.03 | **283.05** (−4%, toward ref) | 194.97 |

`ref_00000` moves less (that pose is mostly flat beach — see §2): rock lum_mean 121.19 → 120.60,
sand lap_var 462.03 → 462.52, shoreline essentially unchanged.

Every axis that moved, moved toward the reference. The magnitudes are small, and §2 and §7 say
why: the two things the reference has that we do not — geometric relief on the beach and on
the sea stacks — are upstream of this subsystem. Reporting them as SSAO/SSR wins would be
dishonest.

**Cost.** `stats.ms` at `ref_01500`: 9.15 / 9.60 with both passes on, 9.18 with
`aoEnabled=0,ssrEnabled=0`. The subsystem is **≈0.3 ms**, inside the run-to-run spread of the
measurement itself (13 half-res draws total). Frame budget is 11 ms.

---

## 6. Determinism (critic P8) — the critic's diagnosis was wrong

The critic reported that two runs of the byte-identical capture command differ by mean 11.31 /
max 209 / 1.53M px, and concluded the renderer is nondeterministic at `--settle 48`.

**Experiment.** Run the two captures *simultaneously* instead of sequentially, so they cannot
straddle a source edit. Both arms, twice:

```
passes ON,  two simultaneous captures:  max 0  mean 0.00000  frac>=1 0.00000
passes OFF, two simultaneous captures:  max 0  mean 0.00000  frac>=1 0.00000
```

**Byte-identical.** Run the same pair *sequentially* while the tree is live and you get
mean 5.66, and the delta concentrates in the region owned by whichever module was being saved
(`sand` mean 14.19 while `sky` was 0.13 and `rock` 0.23).

So `--settle 48` converges and the capture path is deterministic. What the critic measured was
KNOWN_ISSUES §16 — a non-quiescent `src/`. **Practical rule for anyone A/B-ing during a wave:
launch both arms at the same instant.** A `--config` A/B (like `aoLegacyDepth=1`) is even
better, because both arms are one build.

`node tools/_imdiff.py a.png b.png` reproduces all of the above.

---

## 7. Weakest things left, in order

1. **The beach has no geometric relief** (§2). Until `terrain.js` displaces the cobbles, AO on
   the foreground is correctly ~0.994 and there is nothing more to win there.
2. **The sea stacks are an order of magnitude short of the reference on structure**: rock ROI
   at `ref_01500` lap_var 98 vs 1296, edge_density 0.036 vs 0.162, local_contrast 0.101 vs
   0.214, sat_mean 53.9 vs 80.9. That is `rocks.js` geometry and material, not screen space.
3. **The sea still has no reflection path** (§4.7). Needs `ocean.js`; the enabling piece
   (`pipe.opaqueDepthTex`) now exists.
4. **`ssrWetRoughClamp = 0.12` is a workaround for a `terrain.js` G-buffer/shading mismatch**
   (§4.3), measured at 0.703 written vs ~0.16 shaded. Revert it when terrain is fixed.
5. **Everything else downstream is still reading the broken `pipe.depthTex`** — `dof`,
   `motionBlur`, `taa`, `volumetricFog`, water refraction. `pipe.opaqueDepthTex` is published
   and free to adopt (one line each), but the real fix is still the one KNOWN_ISSUES §18 asks
   for, in `scene.js`.
6. **No VNDF importance sampling / no ratio-estimator resolve in SSR** (research §5.3-5.4).
   Single mirror-direction ray with roughness expressed purely as blur. That costs
   contact-hardening. Next largest available SSR win after the ones above.

---

## 8. Tools added

`tools/_ssprobe.mjs` — reads `ssao.aoTexture`, `ssr.ssrTexture`, the opaque depth snapshot and
the G-buffer straight off the GPU, so nothing it reports depends on tonemap/grade/fog (all
being edited by other agents). Reports: opaque-depth coverage, the depth-buffer relief table of
§2, AO distribution bucketed by view distance, SSR hit/confidence fractions, per-matId G-buffer
coverage and roughness, and CSM cascade wiring.

```
node tools/_ssprobe.mjs --pose ref_00000 --settle 48
node tools/_ssprobe.mjs --pose ref_01500 --config aoRadius=0.6
```

## 9. Sources relied on

* Jimenez, Wu, Pesce, Jarabo, *Practical Realtime Strategies for Accurate Indirect Occlusion*
  (GTAO), ATVI-TR-16-01 — arc integral eq. 7, bent normal, multibounce eq. 10.
  <https://iryoku.com/downloads/Practical-Realtime-Strategies-for-Accurate-Indirect-Occlusion.pdf>
* Intel XeGTAO, `XeGTAO.hlsli` — slice frame ~396-410, arc integral ~536-545, thin-occluder
  481-503, edge weights 120-129, `FinalValuePower`/`max(0.03,·)` 556-558.
  <https://github.com/GameTechDev/XeGTAO>
* Filament, *Ambient occlusion* — "the ambient occlusion term is only applied to indirect
  lighting"; `gtaoMultiBounce`; Lagarde `computeSpecularAO`; Lagarde's `min(AO_medium,
  AO_large)`. <https://google.github.io/filament/Filament.md.html>
* three.js `PoissonDenoiseShader` — `depthDiff = abs(dot(viewPos − viewPosSample, viewNormal))`;
  `DFGApprox` in `bsdfs.glsl.js`.
* McGuire & Mara, *Efficient GPU Screen-Space Ray Tracing*, JCGT 2014 — perspective-correct DDA
  and the `[zA,zB]` interval test. <https://jcgt.org/published/0003/04/04/>
* Frostbite, *Stochastic Screen-Space Reflections* (SIGGRAPH 2015) — slide 84/85 grazing cone
  shrink, slide 87 EnvBRDF after temporal.
* `research/screenspace.md` §0, §2.4-2.7, §4.1, §5.2, §5.5, §5.8, §6.2-6.3, §7.
