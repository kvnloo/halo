# rocks — wave H: the sea stacks do not float, they were shaded black

Owner file: `src/world/rocks.js`. Supersedes the sheen/form/detail-ladder report.
Task: KNOWN_ISSUES 17.4, "the sea stacks float — cut flat at the base with a visible gap
above the water in every stack cell (05, 06, 08)."

---

## 0. Headline: the reported diagnosis is wrong, and the real one is measurable

**The stacks are not cut flat and there is no gap.** `--skip ocean` shows every stack's
geometry running past the waterline down to the seabed; `baseY` is −3.4 to −13 m against
`SEA_Y = 0`, and there is a bottom cap at `baseY − max(3, R*0.25)` below that. Nothing was
ever floating.

What is actually there is a **~28 px band of exact black at the foot of every stack**.
Measured at `ref_01500`, veils nulled, down a column through the right-hand stack:

```
row 470-482   rock          rgb  106/94/68 .. 84/69/41
row 486-514   "the gap"     rgb  42/29/7 -> 1.8/2.0/1.0 -> 0.4/0.6/0.4   <-- black
row 518       water         rgb  155/157/161
```

The reference never does this. `kf_01500`, same band on the hero stack, has a minimum row
of **53** against a shaft of 93. A black skirt with a hard, near-horizontal top edge under a
pale shaft does not read as wet rock — it reads as the shadow gap beneath a floating object,
which is exactly what got filed.

**This also explains why the mask-based check said "floating".** Differencing against a
`rockDbg=1` (black-albedo) capture reports 80–100% of columns on the two hero stacks as
having a 14–16 px non-rock gap above the water. That is an artifact: forcing an
already-black band to black changes nothing, so the mask stops early. The mask rig from the
previous report is not safe near the tide line, and I nearly shipped that conclusion.

### The separating experiment

Two candidate causes, albedo and lighting, separated with `--config` probes at row 506:

```
                                    rgb            implies
shipped                          0.4 / 0.6 / 0.4
grey 0.18 albedo (rockDbg=2)     3.8 / 8.2 /19.2   lighting alone
grey 0.18 albedo + rockAO=0     25.6 /35.4 /54.6   AO factor = 0.134
shipped albedo + rockAO=0        3.2 / 4.2 / 3.4   albedo    = 0.020 linear
```

**Both are wrong, and they multiply.** `0.020 × 0.134 = 0`.

- **Albedo 0.020 linear.** `research/terrain.md` §5.3 puts *sea-splashed rock* at **0.09**
  against dry cliff rock at 0.20. Shipped was a fifth of that — darker than fresh asphalt.
  Cause: three independent "wet is darker" terms stacked — a damp mix to a 0.062 colour, an
  algae mix to 0.048, then `alb *= mix(1.0, 0.66, wet)`. That is one physical effect
  triple-counted.
- **AO 0.134.** `mix(1,0.30+0.70*occ,·) * mix(1,0.40,shl·0.9) * mix(1,0.58+0.42·hC,0.9)`
  has no floor and bottoms out at 0.075. It is also the *wrong sign* here: `occ` and `shl`
  are baked from the stack's own radius grid by `gridMasks`, so they describe self-occlusion
  only and cannot know that at the foot the mass simply **ends**. The wave-cut notch 1–2 m
  above drives `shl` high, so the least-occluded band on the rock — a vertical wall standing
  in open water under an open sky — was shaded as the most-occluded one.

At `ref_01500` the sun is azimuth 118° / elevation 41° and the camera looks −Z, so the
hemisphere the stacks present is backlit: the suppressed sky probe is the *only* light there.

---

## 1. Result

Back-to-back on one tree via a new `--config rockLegacyTide=1` (see §4), veils nulled,
right-hand stack. The ratio *darkest base row / shaft mean* is used because it is immune to
the ±14-code global exposure drift the previous report documented.

```
                     ratio    band p05   band p50   frac of band < code 10
BEFORE               0.017        0.7       13.3          0.449
AFTER                0.310       21.8       49.6          0.001
reference kf_01500   0.540       18.1       65.8          0.001
```

**The black is gone: 44.9% of the band was below code value 10, now 0.1%, matching the
reference's 0.1%.** The ratio is 18× better and now within 1.7× of the reference rather than
32× short. `p05` is now slightly *above* reference.

`ref_01800`, waterline stripe y430–560, whole width:

```
             min    p01    p05   frac<10   frac<5   whole-frame exact-black px
BEFORE       0.0    3.4   29.9   0.0195    0.0130            78
AFTER        7.1   27.9   54.4   0.0001    0.0000            25
```

Whole-frame `lap_var`, veils nulled, attributed by region (`BEF2` vs `FIN3`):

```
region                          legacy    final    delta
waterline band y470-520          717.8    700.3    -17.5
stacks above water y150-470      328.6    328.5     -0.1
cliff left y150-560 x0-600       657.3    666.2     +8.9
water+beach y520-1080            463.8    514.8    +51.0   <- skerries
WHOLE FRAME                      472.8    497.8    +25.1
```

Detail went **up**, not down: the removed black edge cost 17.5 in its own band and the
skerries returned 51 in the water.

---

## 2. What changed

1. **Wet darkening is now Lagarde's `DoWetProcess`, once.** (Lagarde 2013, *Water drop 3b —
   physically based wet surfaces*.) `factor = lerp(1, 0.2, Porosity)`, `Porosity = 0.69` →
   0.45, which is exactly the brief's dry-cliff→sea-splashed pair (0.20 → 0.09). The three
   stacked darkenings are gone. Roughness follows Lagarde's `0.5 * WetLevel` gloss lerp.
2. **An albedo floor of 0.075/0.071/0.062, gated to the tide zone.** Initially applied
   globally, which clamped every dark crevice on every rock; a floor is a claim about wet
   weed-covered limestone, not about a dry crevice in shadow.
3. **AO floor and an open-water relaxation.** `occ` and `shl` are both remapped to shallower
   ranges over open water, with the floor rising 0.10 → 0.42 there. Concentrated at the
   contact (`smoothstep(5.5, 0.4, yw)`), not 9 m up the shaft.
4. **Sea-surface bounce — the missing source.** An occlusion-only ambient model can never
   brighten anything, so the band with the largest secondary source in the scene rendered
   darkest. Added to `reflectedLight.indirectDiffuse` at `<lights_fragment_end>`, coloured by
   the water (`research/ocean.md`'s transmitted 0.686/0.687/0.615 at 0.10 m, pushed toward
   cyan) rather than by the sky probe that already over-dominates this rock.
5. **Intertidal zonation** (Stephenson & Stephenson's universal scheme) replacing one algae
   blob: black lichen (*Verrucaria*) fringe → pale barnacle belt → fucoid algae → wet rock.
   Dark-over-light-over-dark is what makes a waterline legible at 90 m, where a monotonic
   ramp just reads as dirt.
6. **Foam / swash scum line on the rock** (not on the water — that is `ocean`'s). A ragged
   bright line at the top of the run-up plus a splash veil above it, with a *second*
   high-frequency warp so the line wanders at ~25 cm as well as at ~1.5 m. Per
   `research/ocean.md` §4.4 foam is 0.6–0.8 linear, lit, and rough — so it is a mix toward a
   bright warm-neutral with roughness 0.80, never an additive white decal.
7. **Skerries — the strongest cue, and a plain bug.** A rubble skirt already existed around
   every stack and **every block of it was invisible**: `place()` sat each boulder on the
   *terrain*, and the terrain under a stack at z = −92 is 5–13 m below sea level, so the
   whole skirt was on the seabed under several metres of water. `place()` now takes an
   `absTop` so blocks straddle the surface — a third as dark shoals just under, the rest
   0–1.6 m proud. Far stacks (`lod >= 2`), previously skipped entirely, now get 7 larger
   blocks each.
8. **Terrain contact.** Stacks whose foot is *above* sea level (the headland) get a tighter
   apron of part-buried blocks and spalled chips against the shaft — a talus collar, so the
   sand meeting is a contact and not an intersection line.
9. **The cliff got its own material** (`rock-cliff`, `seaContact: 0`). It is the same
   limestone but its foot meets sand, so it must not receive the open-water AO relaxation or
   the sea bounce. See §3 — getting this wrong was measurable.

---

## 3. Two measurement traps I fell into, both worth recording

**(a) A non-back-to-back A/B measured tree drift, not my change.** My first shipped-config
scoring said legacy 34.48 vs new 28.88 at `ref_01500` — an apparent 5.6-point regression with
`detail` 99.5 → 59.2. Re-run strictly back-to-back on the current tree:

```
              legacy    new     delta
ref_01500      29.19   29.04    -0.15
ref_01800      31.66   31.52    -0.14
ref_00000      32.79   32.82    +0.03
```

All three inside the ±0.5 settle-noise floor of KNOWN_ISSUES 26. **The same config scored
34.48 and 29.19 about an hour apart — 5.3 points of drift from other agents' edits, 10× the
settle noise that §26 quotes.** Anyone doing a shipped-config A/B on this tree must capture
both sides consecutively; I added `rockLegacyTide=1` precisely so that is possible without
touching git. The legacy run's `detail 99.5 / geometry 100 / spectrum 100` should also have
been a red flag on its own — that is *above* the AAA self-calibration ceiling in
`docs/TARGETS.md` (79.0 / 88.5 / 97.8).

**(b) A global fix for a local defect.** The first AO floor was global at 0.20 and cost
whole-frame `lap_ratio` 0.856 → 0.561 — a third of the frame's high-frequency energy — to fix
a band 0.45% of the frame wide, because it also raised every crevice on every rock *and* fired
on the cliff foot (the relaxation keys on world height, and the cliff base is also a few
metres above sea level). Gating it behind `uSeaContact` and dropping the global floor to 0.10
recovered it. `ref_00000`, which the cliff dominates, holds `detail` at 100.0 and
`lap_ratio` 0.913 → 0.910.

---

## 4. Diagnostics (permanent, read per frame from `ctx.config`)

```
rockAO=0           disable the whole ambient-occlusion chain
rockAlgae=0        disable damp/algae/tide albedo, keep the dry rock
rockWet=0          disable the wet specular + diffuse-loss branch
rockFoam           waterline foam/scum strength (shipped 1)
rockBounce         sea-surface bounce radiance strength (shipped 1)
rockLegacyTide=1   restore the pre-wave-H tide/AO chain for a back-to-back A/B
```
plus the existing `rockDbg`, `rockSpecF90`, `rockSpecOcc`, `rockHex`, `rockDetail`.
`gRKBounce` is deliberately set **after** the `rockDbg` override, so a bounce term computed
from the real albedo cannot survive its own albedo being forced to zero.

---

## 5. Cost

`rocks` init **1510 ms**, against 1515 ms in the previous report — no change. (Two earlier
readings of 2449 and 3467 ms were machine load: the box was at load average 32 with a dozen
concurrent agents. Do not read init ms off a loaded box.)

Draw calls **692, unchanged** — the skerries reuse the three instanced boulder meshes that
already existed. Added instances: 7 + 7 far-stack skerries + ~24 headland apron ≈ 38, about
36 k triangles against a frame total of 33.3 M (**+0.11%**), so this is not a contributor to
KNOWN_ISSUES 23. One new program (112 total) for `rock-cliff`.

Fragment ALU: the tide block gains three `fbm3` calls (barnacle patch, lichen fringe, foam
warp) and the AO block gains ~10 ALU. No new textures, no new fetches.

---

## 6. Weakest things left, in order

1. **The base band is still 1.7× darker than the reference (ratio 0.310 vs 0.540), and the
   remainder is not reachable from this file.** With AO forced fully off and a flat 0.18
   grey albedo, the backlit face at the waterline renders 25.6/35.4/54.6 — that is the
   *ceiling* the sky probe can deliver there, and it is below what the reference band needs
   before any albedo is applied. This is the same sun:ambient deficit the previous report
   found in §2 and §8.1; it is `env`/`lighting`/exposure. I set the bounce coefficient to
   0.62 (implying `L_water ≈ 1.25`), the top of what I will call physical, and deliberately
   did **not** raise it to the ~1.4 that would close the gap, because that would be another
   module's bug fitted into this one's material.
2. **`uAerialDensity` still erases all of this in the shipped frame at `ref_01500`.** Two
   builds differing by every change in this report produced byte-identical shipped captures
   at that pose (`ship1500_v2` vs `v3` scored identically on every axis). The veil is why the
   shipped-config A/B in §3 reads ±0.15 while the veil-nulled measurement reads 18×. This is
   the previous report's §8.2 and KNOWN_ISSUES 18, both still open, neither mine.
3. **The waterline is still too straight in silhouette.** The tide *shading* now varies
   vertically by ±1.4 m, but the rock's own bottom edge against the water is close to a
   horizontal line because the wave-cut platform flare is nearly axisymmetric. The reference
   breaks that line with geometry, not shading. The skerries help; the profile itself should
   probably gain a strong one-sided low-frequency lobe below y = 2.
4. **The distant islets (`islet_field`) get no skerries and no apron** — they are built from
   `buildStack` but are not in `STACKS`, so the loop skips them. At 660–1750 m they read as
   flat-topped tables cut at the waterline. Visible at `ref_01800`.
5. `ssao.js` failed to load for every capture in this session — `Unexpected identifier
   'scene'`, i.e. KNOWN_ISSUES 20's backtick hazard again, in another agent's live edit. It
   is controlled for my A/Bs (both sides), but every absolute number here was taken with no
   SSAO. `tools/parsecheck.mjs` caught the same hazard three times in my own edits; run it.
