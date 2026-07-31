# Beach sedimentology for a procedural scatter

Research brief for the Halo: Campaign Evolved foreground rebuild.
Written for someone sampling distributions today, not reading a textbook.

**The diagnosis first.** "A carpet of identical cobbles" fails on four independent axes, and
each has a different fix:

| Blind-test symptom | What real beaches do | Section |
|---|---|---|
| one size mode | multi-modal, and *count* statistics differ wildly from *mass* statistics | (a) |
| constant spacing | clast-supported contact, clustered, with bare patches | (b) |
| no fines | interstitial fill is 15–40% of the surface and it's what kills the "floating" look | (a), (b) |
| ellipsoids | beach clasts are **oblate discs**, mean Ψp ≈ 0.60, oblate-prolate index ≈ −2 | (c) |
| visibly tiling | real organisation has *four* nested length scales, 5 cm → 40 m | (b) |

The single biggest win is (c) + imbrication in (b): change the shape family to discs and make
them lean, and the "carpet of eggs" read collapses immediately.

---

## 0. The scale everything is expressed in

**Krumbein phi:** φ = −log₂(d in mm), so d = 2^(−φ). Coarse = negative φ.
([Blott & Pye 2001, GRADISTAT](https://onlinelibrary.wiley.com/doi/10.1002/esp.261);
[Geosciences LibreTexts 3.1](https://geo.libretexts.org/Courses/SUNY_Potsdam/Sedimentary_Geology:_Rocks_Environments_and_Stratigraphy/03:_Describing_Sediment_and_Sedimentary_Rocks/3.01:_Grain_Size))

Udden–Wentworth class boundaries (all verified against GRADISTAT Table I and the
[Coastal Wiki sediment table](https://www.coastalwiki.org/wiki/Coastal_and_marine_sediments)):

| Class | mm | φ |
|---|---|---|
| Boulder | > 256 | < −8 |
| Cobble | 64 – 256 | −6 to −8 |
| Very coarse pebble | 32 – 64 | −5 to −6 |
| Coarse pebble | 16 – 32 | −4 to −5 |
| Medium pebble | 8 – 16 | −3 to −4 |
| Fine pebble | 4 – 8 | −2 to −3 |
| Granule | 2 – 4 | −1 to −2 |
| Very coarse sand | 1 – 2 | −1 to 0 |
| Coarse sand | 0.5 – 1 | 0 to 1 |
| Medium sand | 0.25 – 0.5 | 1 to 2 |
| Fine sand | 0.125 – 0.25 | 2 to 3 |
| Very fine sand | 0.0625 – 0.125 | 3 to 4 |
| Silt | 0.002 – 0.0625 | 4 to 9 |

Note: **"shingle" is not a size class.** Blott & Pye state it plainly — *"'Shingle' may also be
defined simply as rounded gravel."* Shingle is 2–200 mm gravel that happens to be well rounded.
Wikipedia's [Shingle beach](https://en.wikipedia.org/wiki/Shingle_beach) gives the working range
as **20–200 mm**. So a shingle beach is a *pebble-to-cobble* beach, and if your foreground stones
read as 150 mm you are at the coarse end already.

---

## (a) Grain size distributions — numbers to sample from

### a.1 The distribution family is log-normal, but only over the middle 95%

From [Geological Digressions on grain size distributions](https://www.geological-digressions.com/analysis-of-sediment-grain-size-distributions/):
*"Each curve shows a dominant straight-line segment that represents the log-normal distribution
of grain sizes for about 95% of each sample. The remaining 5% in the 'tails' departs from log
normal."*

So: **normal in φ, log-normal in mm, with fat non-log-normal tails.** Sample
`φ ~ N(μφ, σφ)`, then `d = 2^(−φ)`. Handle the coarse tail (boulders) as a *separate process* —
see a.5, this matters a lot.

### a.2 Folk & Ward statistics — the definitive tables

These are the numbers everyone in the literature reports, so you can read any field paper and
map it straight onto your sampler. Verbatim from GRADISTAT Table II
([Blott & Pye 2001, Earth Surf. Process. Landforms 26:1237–1248](https://onlinelibrary.wiley.com/doi/10.1002/esp.261)):

**Formulas (logarithmic, φ):**
```
Mean      Mz  = (φ16 + φ50 + φ84) / 3
Sorting   σI  = (φ84 − φ16)/4  +  (φ95 − φ5)/6.6
Skewness  SkI = (φ16 + φ84 − 2φ50) / (2(φ84 − φ16))  +  (φ5 + φ95 − 2φ50) / (2(φ95 − φ5))
Kurtosis  KG  = (φ95 − φ5) / (2.44(φ75 − φ25))
```

**Sorting classes (σI, in φ):**

| Class | σI (φ) | geometric σG (dimensionless) |
|---|---|---|
| Very well sorted | < 0.35 | < 1.27 |
| Well sorted | 0.35 – 0.50 | 1.27 – 1.41 |
| Moderately well sorted | 0.50 – 0.70 | 1.41 – 1.62 |
| Moderately sorted | 0.70 – 1.00 | 1.62 – 2.00 |
| Poorly sorted | 1.00 – 2.00 | 2.00 – 4.00 |
| Very poorly sorted | 2.00 – 4.00 | 4.00 – 16.00 |
| Extremely poorly sorted | > 4.00 | > 16.00 |

(σG and σI are the same quantity: **σI = log₂(σG)**. Field papers use both; the UK gravel data
below is quoted in σG.)

**Skewness classes (SkI):** very fine skewed > +0.3; fine skewed +0.1…+0.3; symmetrical
−0.1…+0.1; coarse skewed −0.1…−0.3; very coarse skewed < −0.3.
**Kurtosis classes (KG):** very platykurtic < 0.67; platykurtic 0.67–0.90; mesokurtic 0.90–1.11;
leptokurtic 1.11–1.50; very leptokurtic 1.50–3.00; extremely leptokurtic > 3.00.

For your purposes: a **beach** foreshore sample is usually *moderately to well sorted*
(σI 0.35–1.0) if it's a clean sand or clean shingle, and *poorly to very poorly sorted*
(σI 1.0–2.0+) if it's a mixed sand-and-gravel beach.

### a.3 Real mixed sand-and-gravel beaches are strongly BIMODAL

This is the most useful single finding in the whole brief, and it is confirmed independently on
two continents.

**UK coast**, 5 beaches, hundreds of samples — López de San Román Blanco (2003), reproduced in the
Environment Agency/Defra
[mixed beaches report](https://assets.publishing.service.gov.uk/media/6026a394d3bf7f03132e96d1/Development_of_predictive_tools_and_design_guidance_for_mixed_beaches_-_Stage_2_Final_report_appendix.pdf)
(Table 3-1 and §3.3):

| Statistic | D50 shingle (mm) | D50 sand (mm) | f = D50sh/D50sa | B (Wilcock bimodality) | Sand % |
|---|---|---|---|---|---|
| Average | 21.73 | 0.35 | 52.53 | 3.12 | 15.89 |
| Median | 16.50 | 0.30 | 52.53 | 3.09 | 15.89 |
| Std dev | 9.94 | 0.07 | 28.00 | 1.79 | 17.57 |
| Max | 57.17 | 0.72 | 198.82 | 11.62 | 96.00 |
| Min | 2.36 | 0.07 | 3.29 | 0.79 | 0.00 |

Their explicit "typical UK mixed beach" spec (§3.3), which is exactly what you want to sample:

1. **Bimodal**, one mode in sand, one in gravel. Wilcock's B always > 1.7, up to 11.
2. **Gravel is ~80% by mass.**
3. Gravel mode spans **5 – 30 mm**, D50 **10 – 20 mm**, **D84/D16 ≈ 4.5** (→ σG ≈ 2.12, σI ≈ 1.08φ, *poorly sorted*).
4. Sand mode spans **0.25 – 0.5 mm**, D50 **≈ 0.3 mm**, **D84/D16 ≈ 3.5** (→ σG ≈ 1.87, σI ≈ 0.90φ, *moderately sorted*).
5. Sand content **increases with depth** (~+10% at 1.5 m below the beach face) — i.e. the *surface* is the coarse, sand-starved layer. This is the armour layer.
6. Deeper samples are coarser gravel; surface gravel is finer than buried gravel at some sites and coarser at others — high variability.

Per-site numbers from the same report (σ quoted is geometric):

| Beach | D50 gravel (mm) | σG gravel | D50 sand (mm) | σG sand | Sand % |
|---|---|---|---|---|---|
| Hunstanton | 9.7 | 2.5 | 0.35 | 1.8 | 38 (mean) |
| Isle of Sheppey | 14.5 | 1.8 | 0.32 | 2.2 | 14 |
| Hastings | 12.1 | 2.5 | 0.24 | 1.8 | 18 |
| Highcliffe | 22.7 | — | 0.40 | — | 0 at surface; 18 subsurface (range 11–75) |
| Hengistbury Head | ~15 | — | 0.29 | — | 84% sand at MLWS, 31% at MHWS |

**New England, USA**, ~100 transects, n = 454 intertidal mixed samples
([Grain Size and Beach Face Slope on Paraglacial Beaches of New England, EarthArXiv preprint / Marine Geology](https://eartharxiv.org/repository/object/1717/download/3621/);
published version [Marine Geology 2021](https://www.sciencedirect.com/science/article/pii/S0025322721001092)):

- Two peaks: **medium-to-very-coarse sand 0.25–1 mm** and **medium-to-very-coarse gravel 10–64 mm**.
- **A pronounced trough between 1 and 10 mm.** "The paucity of grains between 1–10 mm … [is] a
  persistent feature of sand and gravel beaches of southern New England."
- Bulk median lands at 2 mm — which is *the emptiest part of the histogram*. Never sample from a
  single mode fitted to the bulk median; you'll produce exactly the granule size that real
  beaches lack.
- Samples with D50 between 1 and 10 mm are **all poorly sorted** (they are mixtures, not a mode).
  Moderately-to-well-sorted samples fall in the 0.25–1 mm or 16–64 mm modes.

**Implementation consequence:** the histogram is a **two-humped camel with a hole at granule
size (1–10 mm)**. Your current single mode is the one thing the real distribution never is.

### a.4 The mass-vs-count trap — this is why "no fines"

A distribution quoted as "80% gravel / 20% sand" is **by mass**. Number counts are a completely
different animal because n ∝ mass / d³.

For a log-normal mass distribution `N(μφ, σφ)`, multiplying by d⁻³ = 2^(3φ) gives another
Gaussian with the **same σφ** and mean shifted:

```
μφ(number) = μφ(mass) + 3·ln2·σφ²  =  μφ(mass) + 2.0794·σφ²
```

Derivation: exp(−(φ−μ)²/2σ²)·exp(kφ) with k = 3ln2 completes the square to N(μ + kσ², σ²).

So with σφ = 1.0 the **number-median is 2.08 φ finer than the mass-median — a factor 4.2 smaller
in diameter**. With σφ = 0.7 it's 1.02 φ, a factor 2.0.

And across the sand/gravel divide it's brutal: one 16 mm pebble has the mass of
(16/0.3)³ ≈ 1.5 × 10⁵ sand grains. At 80:20 gravel:sand by mass, there are ~**38,000 sand grains
per pebble**.

**Therefore:**
- Instance geometry only for the coarse mode (roughly **> 8 mm**, i.e. φ < −3). Everything finer is
  a *material*: displacement + normal + albedo variation, not meshes.
- But the fines must be *present* in the shading, filling every interstice, or the pebbles read
  as floating on a plane. The "no fines" note in the blind test is a shading bug as much as a
  scatter bug.
- Do not let the instanced-stone histogram be the mass histogram. Convert it with the formula
  above, or you will under-populate small stones by a factor of several.

### a.5 The boulder tail is a SEPARATE process

A log-normal with μφ = −4.5 (23 mm), σφ = 0.8 predicts P(d > 256 mm) ≈ 6 × 10⁻⁶ — effectively
zero boulders. Real shingle beaches nonetheless carry scattered boulders, because they arrive by
a different mechanism (cliff fall, storm quarrying of bedrock, glacial erratics, reef blocks),
not by the abrasion/sorting cascade that made the shingle.

**Model boulders as an independent sparse Poisson process** with its own size law, superposed on
the log-normal cobble field. Fragmentation/rockfall size distributions are conventionally
power-law, `N(>D) ∝ D^(−b)`.

> ⚠️ **Could not verify** a published exponent *b* for beach boulder populations specifically.
> `b ≈ 2.0–2.6` is the range commonly cited for rockfall/fragmentation generally, but I did not
> find a source I could read that gives it for a beach. Treat `b = 2.5` as an art-directed knob,
> not a cited number. What *is* well supported is the qualitative point: boulders on beaches are
> exotic, clustered near their source (cliff toe, headland, reef), and do not belong to the
> shingle's size distribution.

Visually: boulders are also **less rounded and less oblate** than the shingle around them,
because they've had far less residence time per unit mass. A boulder that looks like a scaled-up
pebble is a tell.

### a.6 Ready-to-use presets

```
# All: sample phi ~ Normal(mu, sigma), clamp to [lo,hi], d_mm = 2**(-phi)
# Then convert to number-weighting: mu_n = mu + 2.0794 * sigma**2

PURE_SHINGLE_STORM_RIDGE:      # well-sorted, upper beach
  mu_phi = -5.0 (32 mm), sigma_phi = 0.55, clamp phi in [-7.0, -3.0]   # 8–128 mm
  # sorting 0.55 phi = "moderately well sorted"

SHINGLE_ACTIVE_BEACHFACE:
  mu_phi = -4.2 (18 mm), sigma_phi = 0.80, clamp phi in [-7.5, -2.0]   # 4–180 mm

MIXED_SAND_GRAVEL (UK typical; MASS weights):
  gravel: w=0.80, mu_phi = -4.0 (16 mm), sigma_phi = 1.05, clamp [-7.0, -2.0]
  sand:   w=0.20, mu_phi = +1.74 (0.30 mm), sigma_phi = 0.90, clamp [+0.5, +3.5]
  # explicit hole: reject any draw in phi (-3.3, -0.3)  i.e. 1.2–10 mm, keep <10% of draws there

CLEAN_SAND_BEACHFACE:
  mu_phi = +1.75 (0.30 mm), sigma_phi = 0.45   # "well sorted"
  # upper beach / foredune is finer AND better sorted than lower beach:
  # upper: sigma_phi ~ 0.30–0.40; lower/step: sigma_phi ~ 0.7–1.0

BOULDERS (separate Poisson layer):
  intensity ~ 0.005–0.05 per m^2 near a source, ~0 away from it
  N(>D) ∝ D^-2.5 over D in [0.25, 2.0] m       # exponent UNVERIFIED
  roundness and obliqueness both reduced (see c.5)
```

---

## (b) Spatial organisation — the part you're missing

Real beach surfaces are organised at **four nested scales**. Modelling only the clast scale is
precisely what produces "constant spacing, visibly tiling".

| Scale | Length | Structure |
|---|---|---|
| 1. Clast fabric | 2–20 cm | imbrication: discs overlapping like roof tiles, leaning seaward |
| 2. Clusters / lags / drifts | 0.2–3 m | pebble clusters, sand drifts, shell lags, patches of bare fines |
| 3. Cross-shore zonation | 5–30 m | Bluck's zones; berm crest → step; systematic size grading |
| 4. Rhythmic alongshore | 5–40 m | beach cusps: horns coarse, embayments fine |

### b.1 Clast fabric — imbrication

Imbrication is *the* structural signature of a worked gravel surface. Platy/discoidal clasts stack
against one another and dip consistently, like roof tiles or a fallen row of dominoes.

- **Direction: imbrication is UPSTREAM in rivers, SEAWARD on beaches.** This inversion is well
  established and is the single most-cited fact about beach fabric.
  ([Imbrication and flow-oriented clasts, Springer Encyclopedia of Sediments and Sedimentary Rocks](https://link.springer.com/rwe/10.1007/3-540-31079-7_116);
  [Imbrication – ScienceDirect Topics](https://www.sciencedirect.com/topics/earth-and-planetary-sciences/imbrication))
- **What dips is the a–b plane** (the flat face of the disc), not the long axis.
  ([Wikipedia: Imbrication (sedimentology)](https://en.wikipedia.org/wiki/Imbrication_(sedimentology)))
- **AB-plane imbrication** — the bedload/rolling case, which is what beaches do — has the **long
  (a) axis oriented PERPENDICULAR to flow**, i.e. **shore-parallel** on a beach face, with the
  intermediate axis pointing up/down the slope. This is directly stated on the Wikipedia entry
  and confirmed for gravel beds by
  [Structure and self-organization of imbricated gravel bed surfaces (J. Hydraulic Res. 2025)](https://www.tandfonline.com/doi/full/10.1080/00221686.2025.2606942):
  *"Long axes of imbricated pebbles orient predominantly perpendicular to flow."*
- **Only discs and blades imbricate.** Spheres and rods don't — they roll into the gaps. This is
  Bluck's whole point (b.3): the disc-rich zones are the imbricated ones.
- **Dip angle: 20–30° seaward** is what I'd use.
  > ⚠️ **Partially verified.** I found "20–25° seaward on exposed coarse gravel beaches" in a
  > search-engine summary and "20–40°" on Grokipedia — neither is a source I'd stake anything on,
  > and I could not open a primary paper stating a beach imbrication angle. What IS solid: the
  > seaward direction, the a–b-plane mechanism, the shore-parallel a-axis, and that the dip is
  > low-angle. Geometrically, a stack of overlapping discs of aspect ratio c/a ≈ 0.44 packs
  > naturally at 20–35°, which brackets the quoted values, so 25° ± 8° is a defensible default.

**Implementation.** For each clast in an imbricated patch:
```
up      = beach-slope-up direction (landward)
along   = shore-parallel
a_axis  = along, jittered ±20° in the tangent plane
n       = clast face normal; tilt it from the surface normal toward SEAWARD by
          theta ~ Normal(25 deg, 8 deg), clamp [10, 40]
```
Then — critically — **place them in contact, not at spacing.** An imbricate zone is
clast-supported: each disc rests *on top of* the seaward edge of the one below. Overlap the
projected footprints by roughly 25–50%. Your current constant-spacing scatter has each stone
sitting in its own little clearing, which is the giveaway.

### b.2 Clustering — the statistical fix

Real coarse clasts are **clustered**, not Poisson and definitely not jittered-grid.

- **Pebble clusters** are a named, ubiquitous microform: a large *obstacle clast* with finer
  clasts jammed against its upstream face and a tail of clasts in its lee. They *"occupy as much
  as 10 per cent of the bed surface"*
  ([Pebble clusters in gravel-bed rivers, Earth Surf. Process. Landforms](https://onlinelibrary.wiley.com/doi/10.1002/esp.195)).
- With increasing shear stress the surface organises through a **sequence**:
  *flat bed → pebble cluster → line cluster → heap cluster → reticulate structure*
  ([Laboratory study on the evolution of gravel-bed surfaces, J. Hydrology 2021](https://www.sciencedirect.com/science/article/abs/pii/S0022169420312129)).
  Line clusters are chains of clasts; reticulate structure is a connected mesh of coarse clasts
  enclosing cells of finer material. **That mesh-of-coarse-enclosing-cells-of-fines is what a
  storm-worked beach surface looks like from a metre away**, and it's the single most
  recognisable spatial texture you're missing.
- **Armouring / overpassing** is the mechanism: *"granules and fine gravels with higher pivoting
  angles in the beach slope are easily trapped within the bed, while rounded pebbles continue
  rolling over (overpassing) it, and finally, decreasing flow velocity allows the deposition of
  the larger pebbles, thus armouring the beach"*
  ([Overpassing and armouring phenomena on gravel beaches, Marine Geology 1993](https://www.sciencedirect.com/science/article/abs/pii/002532279390094C)).
  So the *surface* is a coarse, sand-depleted lag over a finer subsurface — which the UK data
  confirms independently (sand content +10% at 1.5 m depth, §a.3).

**Implementation — replace your Poisson/jittered scatter with a Thomas / Neyman–Scott cluster
process:**
```
1. parent points: Poisson, intensity lambda_p ~ 0.3–1.5 per m^2   (cluster centres)
2. per parent: n_children ~ Poisson(mu = 4–12)
3. children offset by Normal(0, sigma_c) with sigma_c ~ 0.08–0.25 m
4. designate the largest clast of each cluster the OBSTACLE; place it first,
   put 2–4 clasts hard against its seaward-facing side, 1–3 trailing landward
5. overlay a low-frequency intensity field (fbm, feature size 1.5–4 m) that
   modulates lambda_p by 0.2x–2.5x  -> drifts, lags and bare patches
6. leave 10–25% of the ground as bare fines / open framework
```
The key perceptual change: **variance in local density**. Real ground has patches you could
count the stones in and patches where you can't see the substrate at all.

### b.3 Cross-shore zonation — Bluck's four zones

Bluck (1967), *Sedimentation of beach gravels: examples from South Wales*, J. Sedimentary
Petrology 37(1):128–156 — the classic and still the standard description
([abstract via GeoScienceWorld](https://pubs.geoscienceworld.org/sepm/jsedres/article-abstract/37/1/128/95953/)).
From the abstract: *"the surface layers of some South Wales beaches are subdivided into four
zones — a large disc zone landward, typified by cobble sized discs, having on its seaward side
the imbricate zone composed mainly of imbricate disc-shaped pebbles"*, then an **infill zone**
of *spherical and rod shaped pebbles* occupying the spaces between larger clasts, then the
**outer frame** seaward.

Landward → seaward:

| Zone | Position | Content | Visual read |
|---|---|---|---|
| **Large disc zone** | top of beach / berm crest | cobble-sized **discs**, largest clasts on the beach | big flat plates lying almost flat, tightly packed, very few fines |
| **Imbricate zone** | upper beach face | disc-shaped **pebbles**, strongly imbricated | shingled/tiled texture, consistent seaward lean, strong directional read |
| **Infill zone** | mid beach face | **spheres and rods** filling voids between the frame clasts | mixed shapes, less directional, gaps plugged, matrix visible |
| **Outer frame** | lower beach face / step | coarsest framework at the toe | open, coarse, wet, often with a plunge step |

> ⚠️ I could only read the published **abstract** of Bluck 1967 (the full text is paywalled at
> GeoScienceWorld and the AAPG Datapages mirror returned 403). The zone names, order and the
> disc/sphere/rod content per zone above are all from that abstract and are reliable. Zone
> *widths* in metres are not — I could not verify them. Given typical South Wales beach faces,
> a few metres to ~10 m per zone is plausible but is my inference.

**This is directly actionable and it's your biggest missing structure**: shape family should
change across the beach, not just size. Discs high, spheres and rods low. Right now presumably
you use one shape distribution everywhere.

### b.4 Cross-shore SIZE grading — real profiles

Grading is not monotonic. The universal feature is a **coarse maximum at the plunge step /
breakpoint**, with fining both landward and seaward of it.

**Marathonas, Greece** (Moutzouris 1991, via the EA mixed beaches report Fig 2-1): *"grains were
coarser and less well-sorted in zones of increased wave energy… the 'plunge step' was always
found to be composed of the coarsest and worst sorted material."*

**New Zealand mixed sand-gravel barrier** (Single & Hemmingsen 2001, via the same report,
Fig 2-2) — a full cross-shore D50 profile, which is exactly the curve to bake into a texture:

| Cross-shore distance (m from landward datum) | D50 (mm) |
|---|---|
| 0 (crest) | 70 |
| ~40 | 45 |
| ~80 | 30 |
| ~120 | 30 |
| ~160 | 40 |
| ~250 | 18 |
| ~320 | 4 |
| ~400 | 0.25 |

Note the **non-monotonic bump at ~160 m** (40 mm, coarser than either side) — that's the step.
And note the fall from 18 mm to 0.25 mm over ~80 m: the transition from shingle to sand is
*sharp*, often a visible break of slope. Lower foreshore there is bimodal with peaks at
**3–5 mm and ~18 mm**.

**Hengistbury Head, UK**: 84% sand / 16% shingle at low water springs, flipping to
31% sand / 69% shingle at high water springs. A ~2.5× swing in gravel fraction across the
intertidal.

**General rule to encode:** gravel fraction and clast size both **increase up-beach**, with a
local coarse spike at the step; sand fraction increases **down-beach** and **with depth**.

### b.5 Beach slope — because it constrains your camera framing

- Empirical relation for sand ([Coastal Wiki](https://www.coastalwiki.org/wiki/Coastal_and_marine_sediments)):
  `tanβ = −0.154 (D50 − 0.125)^(−0.145) + 0.268`, D50 in mm, valid D50 > 0.125 mm.
  Check: D50 = 0.25 mm → tanβ = 0.060 (3.4°); D50 = 1.0 mm → tanβ = 0.111 (6.3°).
- Above D50 ≈ 1 mm the relation **breaks down and plateaus**. From the New England study
  (n = 454) and the [Bujan et al. 2019 global compilation](https://www.sciencedirect.com/science/article/pii/S0025322721001092)
  it cites: (1) slope increases with D50 below 1 mm, (2) **upper limit of beach face slope ≈ 0.2**
  (11.3°), (3) poor correlation above D50 ≈ 1 mm, with slopes plateauing in **0.1 – 0.2**.
- Regional medians from the same study: **mesotidal ≈ 0.06, microtidal ≈ 0.12**.
- So: **a shingle beach face is 6–11°, a sand beach face is 1–6°.** If your foreground shingle
  sits on a 2° slope it will read as sand-beach geometry with cobble texture.

### b.6 Beach cusps — the alongshore rhythm

([Coastal Wiki: Beach Cusps](https://www.coastalwiki.org/wiki/Beach_Cusps);
[Masselink 2004, JGR Oceans](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2004JC002339);
[Field Observations of a Multilevel Beach Cusp System, Geosciences 11:148](https://www.mdpi.com/2076-3263/11/4/148))

- **Spacing: <1 m to 50–100 m**, most commonly **metres to tens of metres**. Another compilation
  gives ~10 cm to 40 m. For a shingle beach in a moderate swell, **8–25 m** is the sweet spot.
- Spacing **scales linearly with the cross-shore swash excursion**. Cusps are *"usually associated
  to steeper beaches with coarse-grained sediments"* — so a shingle beach is exactly where you
  should see them.
- **Morphology: steep, seaward-pointing HORNS separated by gentle, rounded, seaward-facing
  EMBAYMENTS.** Swash diverges over the horn and converges into a concentrated backwash stream in
  the embayment.
- **Sediment segregation: "the coarser sediment fractions concentrate on the horns."** The
  embayments are finer and often wetter (they drain the backwash).

**Implementation:** modulate everything in this document by a 1-D alongshore field of wavelength
λ_cusp ∈ [8, 25] m with ~20% wavelength jitter (they're rhythmic, not periodic):
```
horn:      +0.5 to +1.0 phi coarser, higher packing density, drier, +0.15 m elevation, steeper local slope
embayment: finer, more sand visible, wetter, scoured, gentler slope, wet line reaches further landward
```
The scalloped wet line alone will destroy the tiling read, because it introduces a large-scale
non-repeating feature that the eye locks onto instead of the stone lattice.

> ⚠️ **Could not verify** a cusp *relief/amplitude* in metres — Coastal Wiki explicitly declines
> to give one, and I found no readable primary source with a number. 0.1–0.5 m for a shingle
> beach is my inference from the horn/embayment descriptions; treat as art direction.

---

## (c) Clast shape — you have the wrong shape family

### c.1 The four indices, and their formulas

Measure a, b, c = long, intermediate, short orthogonal axes (a ≥ b ≥ c).
([GEL 324 Particle Shape Analysis, SERC/Carleton](https://serc.carleton.edu/files/NAGTWorkshops/sedimentary/activities/particle_shape.pdf);
[89.325 Gravel Shape and Sedimentary Environment, UMass Lowell](https://faculty.uml.edu/Nelson_Eby/89.325/Lab%20pdfs/Gravel%20Shape%20&%20Sedimentary%20Environment.pdf))

```
Krumbein / Wadell operational sphericity   psi   = (b*c / a^2)^(1/3)
Sneed & Folk max projection sphericity     psi_p = (c^2 / (a*b))^(1/3)
Cailleux flatness index                    F     = (a + b) / (2c)          # 1 = equant, larger = flatter
Dobkins & Folk oblate-prolate index        OP    = 10*[ ((a-b)/(a-c)) - 0.5 ] / (c/a)
```
OP runs −∞ … +∞; negative = **disc**, ~0 = blade, positive = **rod**.
Sphericity runs 0…1; *"most sedimentary particles falling in the range of 0.3 to 0.9."*

**Zingg (1935) four classes** (thresholds at 2/3):

| Zingg class | b/a | c/b | Shape |
|---|---|---|---|
| I | > 2/3 | < 2/3 | **Oblate — discoidal, tabular** |
| II | > 2/3 | > 2/3 | Equiaxial — spherical, equant |
| III | < 2/3 | < 2/3 | Triaxial — bladed |
| IV | < 2/3 | > 2/3 | Prolate — rods |

Sneed & Folk (1958) rejected Zingg's four classes as too coarse and use a **ternary diagram**
(S/L vs the disc–rod index) with **10 classes**. For a generator, Zingg's 4 classes are the right
granularity for *authoring* and Sneed–Folk's Ψp is the right target for *calibration*.

### c.2 THE load-bearing numbers: beach vs river

Dobkins & Folk (1970), the standard discriminants, as reported in the UMass Lowell teaching
handout above (which cites them, plus Stratten 1974 and Gale 1990):

> *"Water as a transporting agent has a great effect on sphericity. In general fluvial gravel has
> Ψp ≥ 0.67 and beach gravels have Ψp ≤ 0.65. Stratten (1974) and Gale (1990) found mean Ψp for
> fluvial gravels are between 0.67 and 0.77 and beach gravels between 0.53 and 0.64."*
>
> *"Mean OP for fluvial gravel is near zero. Beach gravels have more negative OP (usually less
> than −2) and fluvial gravels are greater than −1."*
>
> *"Using the mean Modified Wentworth Roundness scale, fluvial gravels range between 0.26 – 0.65.
> Low energy beach gravels (0.34 – 0.61) are less than higher energy beach gravels (0.35 – 0.81)."*

Corroborating values found in search summaries of Dobkins & Folk (river Ψp 0.68 / beach Ψp 0.60;
OP: rivers +0.18 to +0.2, **low-wave-energy beaches −0.81, high-wave-energy beaches −2.13**;
discriminant "Ψp under 0.66 and OP more negative than −1.5 distinguishes beach from river").
These are consistent with the handout, so I'm confident in the ranges; the individual decimals
came from a search snippet rather than a page I could open, so treat them as ±.

**And the causal mechanism**, also from the handout: *"Abrasion is the chief cause for the
abundance of discs on the beaches; as roundness increases from rivers to beaches, sphericity
DECREASES and oblate-prolate index becomes more negative (disc-like)."*

> **This is the headline.** On a beach, more wear does **not** mean more spherical. It means
> **flatter**. A clast dragged back and forth in the swash rocks on its flat face and wears the
> face, not the rim. Your current near-spheroidal ellipsoids are the *fluvial* shape family — and
> even for a river they'd be too regular.

### c.3 Sampling recipe for beach clast axes

Target: Ψp ≈ 0.60–0.63, OP ≈ −2 to −2.4 (a high-wave-energy beach).

```
b_over_a ~ Normal(0.78, 0.10)   clamp [0.50, 0.98]
c_over_b ~ Normal(0.55, 0.12)   clamp [0.25, 0.85]
c_over_a  = b_over_a * c_over_b          # -> mean ~0.43
```
Verification of that centre (a=1, b=0.78, c=0.44):
- Ψp = (0.44² / (1 × 0.78))^(1/3) = (0.2482)^(1/3) = **0.629** ✓ (target 0.53–0.64)
- OP = 10·[(0.22/0.56) − 0.5] / 0.44 = 10·(−0.1071)/0.44 = **−2.43** ✓ (target ≈ −2)
- Cailleux F = (1 + 0.78)/(2×0.44) = **2.02** (distinctly flat)

Resulting **Zingg mix** (assuming independence of the two ratios):
- P(b/a > 0.667) = 87%, P(c/b < 0.667) = 83%
- **Discs 72%, spheres 15%, blades 11%, rods 2%**

> ⚠️ **Explicit caveat:** I could **not** find a published Zingg-class *percentage* histogram for
> a beach. That 72/15/11/2 is **my construction**, calibrated so the mean Ψp and mean OP land on
> Dobkins & Folk's verified beach values. It is however strongly consistent with Bluck's
> qualitative zonation (disc-dominated upper zones, spheres and rods relegated to the infill
> zone), which is an independent check. Use it, but know its provenance.

**Zone-varying shapes** (from Bluck, b.3) — this is cheap and very effective:
```
large disc zone / imbricate zone:  b_over_a ~ N(0.82, 0.08), c_over_b ~ N(0.48, 0.10)   # ~85% discs
infill zone:                       b_over_a ~ N(0.70, 0.13), c_over_b ~ N(0.72, 0.14)   # spheres + rods
outer frame / step:                b_over_a ~ N(0.76, 0.12), c_over_b ~ N(0.58, 0.14)
boulders (any zone):               b_over_a ~ N(0.72, 0.14), c_over_b ~ N(0.65, 0.16)   # blockier
```

**Lithology drives shape.** Both teaching sources stress this. Foliated/bedded rocks (slate,
shale, schist, thin-bedded sandstone, limestone with bedding) produce discs and blades because
they *split* that way; massive isotropic rocks (granite, basalt, vein quartz, chert) produce
equant clasts. So on a real beach the shape distribution is **correlated with colour**: the dark
flat ones and the pale round ones are different rocks. Give each lithology its own (colour,
axis-ratio, roundness, gloss) tuple and sample lithology first. This alone breaks the
"identical" read harder than anything else, because it makes shape and albedo covary the way a
viewer's eye expects.

### c.4 Roundness — and why it is NOT the same as sphericity

- **Wadell roundness**: mean radius of curvature of the corners ÷ radius of the largest inscribed
  circle, measured on the a–b (maximum projection) plane. Ranges 0–1; *"natural particles
  generally have roundness values greater than 0.12."*
- **Powers (1953)** classes: very angular, angular, subangular, subrounded, rounded, well-rounded
  — on a *logarithmic* scale, because differences at the round end are hard to see.
- Beach gravel: **rounded to well-rounded**, modified-Wentworth roundness **0.35–0.81** on
  high-energy beaches. Shingle is *by definition* rounded gravel.

**The abrasion mechanism, which tells you how to build the mesh**
([Domokos et al., *How River Rocks Round: Resolving the Shape-Size Paradox*, PLOS ONE](https://pmc.ncbi.nlm.nih.gov/articles/PMC3922984/)):

> Abrasion has **two phases**. *Phase I:* high-curvature regions are removed first — edges round
> rapidly with **no change in axis dimensions or axis ratios**; the particle becomes entirely
> convex. *Phase II:* only then do axis dimensions slowly reduce while the particle stays convex.
> The transition occurred at ~35% volume loss in their limestone cuboid experiments (initial
> a₀ = 70.8 ± 0.8, b₀ = 60.7 ± 0.7, c₀ = 50.6 ± 1.2 mm).

**Two implications for the generator:**
1. **A beach clast's proportions are inherited from how the parent rock broke, not from how long
   it was abraded.** So sample axis ratios from a *lithology-conditioned* distribution (c.3), then
   round the corners — don't derive proportions from a wear parameter.
2. **The silhouette must be strictly CONVEX with no re-entrants**, and it must still be
   *irregular*. A well-worn beach cobble is a convex, smooth, gently lumpy plate on which the
   broad flats of the original block are still faintly readable — not a mathematical ellipsoid.
   Model it as: start from a low-poly convex block with 8–14 faces at the target axis ratios,
   then heavily smooth/inflate the edges while keeping the face centres nearly planar. The
   Domokos work notes the fitted superellipsoid exponent converges to n ≈ 2 (ellipsoidal) only in
   the *fully worn* limit, so `n` slightly above 2 (2.1–2.6, a "rounded box") is the honest shape
   for typical shingle. **This alone will read differently in a screenshot from your current
   ellipsoids.**

Surface texture (secondary but cheap): high-energy beach clasts are *polished* on the a–b faces
and matte on the rim; many carry percussion pits, and limestone/chalk clasts carry
biological borings. Cross-face gloss variation is a real cue.

### c.5 Recognising the difference in a screenshot

| Feature | Wrong (yours) | Right (beach) |
|---|---|---|
| Silhouette from above | circular / oval | **elongate oval, b/a ≈ 0.78** |
| Silhouette from the side | oval | **thin plate, c/a ≈ 0.44** — half as thick as it is wide |
| Cross-section | smooth ellipse | convex but faceted-then-smoothed; broad flats |
| Orientation | random | **a-axis shore-parallel, face dipping ~25° seaward** |
| Attitude | resting on the ground | **resting on each other**, overlapping like tiles |
| Shape variety | one family | discs + a minority of spheres, blades and rods, correlated with lithology/colour |

---

## (d) Sand microrelief

### d.1 Wave (oscillatory) ripples — the runnel/low-tide terrace

([Coastal Wiki: Wave ripples](https://www.coastalwiki.org/wiki/Wave_ripples))

- **Orbital ripples** (Clifton): `λ ≈ 0.65 × (2U₀/ω)` — i.e. **0.65 × the near-bed orbital
  diameter**. These are the common case in shallow water.
- **Anorbital ripples**: `λ = 400d to 600d`, independent of the flow. For d = 0.3 mm that's
  **12–18 cm**. Useful default when you have no hydrodynamics.
- **Steepness** (Soulsby & Whitehouse): `η/λ = 0.15[1 − exp(−(5.0×10³/(U₀/ωd))^3.5)]`, so
  **η/λ ≤ 0.15** — a hard ceiling. Nelson et al.: `η/λ = 0.12 λ^(−0.056)` (λ in m).
- Typical field values: **λ ~ O(10 cm), height a few cm.**

Visual: crests **shore-parallel**, long and continuous, often bifurcating; symmetric in profile
(unlike current ripples). Crests are commonly a slightly *different colour* from troughs because
of grain sorting.

### d.2 Backwash / rhomboid ripples — the beach face itself

This is the one that says "swash zone" in a screenshot.
([Bedforms: ripples and dunes, geologyistheway.com](https://geologyistheway.com/sedimentary/bedforms-ripple-marks-and-dunes/))

> *"V-shaped rhomboid ripple marks form as wave swash goes back and forth in a receding tide…
> rhomboid ripples are very small ripples with limited height (a few mm) that develop in very
> shallow waters (a few mm to some cm) and are common in beaches where they form by wave backwash
> and washover on sand."*

Also present: **antidunes** — *"backwash flows rapidly down the beach and a gentle wave-like
bedform develops that is in phase with the water surface."*

Visual: a **diamond/rhomb lattice**, apexes pointing **seaward** (down-slope), relief **1–3 mm**,
extremely low contrast — you see it as a shimmer of shadow at grazing sun, not as geometry. It
is a *normal-map and shallow-displacement* feature, never mesh.

> ⚠️ **Could not verify** a rhomboid ripple *wavelength*. Every source gives the height (a few mm)
> and the geometry but not the spacing. From published photographs the rhombs are of order 5–20 cm
> on the long diagonal; treat as an art-directed value.

### d.3 Wind ripples — the dry backshore

- Wavelength **~10 cm** (range a few cm to tens of cm), height **a few mm to a few cm**.
  ([Scientific American on wind ripple spacing](https://www.scientificamerican.com/article/why-do-regular-wavelike-s/);
  [Direct numerical simulations of aeolian sand ripples, PNAS](https://www.pnas.org/doi/abs/10.1073/pnas.1413058111))
- **Ripple index RI = λ/H is typically 15–20** for aeolian ripples — i.e. these are *very* flat.
  Ten centimetres of wavelength, five millimetres of height.
- Formed by **saltation and reptation**; wavelength set by the ratio of sediment flux to
  erosion/deposition rate, which increases linearly with wind speed. Crests are **perpendicular to
  the wind**.
- **Coarse grains concentrate on the crests** — this is the well-known aeolian grain-segregation
  mechanism ([Grain Segregation Mechanism in Aeolian Sand Ripples, arXiv cond-mat/9809423](https://arxiv.org/pdf/cond-mat/9809423)).
  So wind ripples produce **visible colour/texture banding at the ripple wavelength**, not just
  shading. Free contrast — take it.

> One source ([Geological Digressions glossary](https://www.geological-digressions.com/glossary-sedimentary-structures/))
> describes impact ripples as *"10–20 mm amplitude and a few centimetres wavelength"*, implying
> RI ≈ 2, which contradicts the RI 15–20 figure and the physics. I believe that entry is in error
> or is describing something else; **go with RI 15–20**.

### d.4 The swash / wet line

- Not a straight line. It is **scalloped at the cusp wavelength** (b.6), reaching further landward
  in the embayments and retreating around the horns.
- Each uprush deposits a thin **arcuate swash-line ridge** of the lightest material — foam scum,
  shell fragments, weed, mica flakes, plastic — a millimetre or two proud, and there are
  **several stacked, nested arcs** from successive swashes, not one line. These arcs are the
  strongest small-scale directional cue on a sand beach.
- The **highest** arc (the strandline / wrack line) is coarse debris and is where the shell hash
  and weed accumulate.

### d.5 Heavy-mineral laminae and placer streaking

The dark streaks that make real beaches read as *sedimentary* rather than *painted*.

- **Composition**: magnetite, ilmenite, zircon, monazite, rutile, garnet — ρ ≈ 4.2–5.2 vs quartz
  2.65, so the swash sorts them out hydraulically.
  ([Heavy Mineral Sands, sandatlas.org](https://sandatlas.org/heavy-mineral-sand/);
  [Black Sand, sandatlas.org](https://sandatlas.org/what-is-black-sand/))
- **Lamina thickness: 2 mm to 150 mm**, with heavy-mineral concentrations **up to 98.3%**,
  *"separated by white sands of variable thickness"*, formed by *"grain segregation due to
  selective sorting within the bed flow during wave backwash."*
  ([Heavy mineral, beach-placer sandstone deposits, NMGS Guidebook 68](https://nmgs.nmt.edu/publications/guidebooks/downloads/68/68_p0123_p0132.pdf))
- **Where**: swash zone, back of dunes, and *"areas just beyond the reach of average wave
  action"*. During storm erosion the light fraction is winnowed offshore and the heavies are left
  as surface lags — so **heavy-mineral streaking is a post-storm signature**, concentrated on the
  upper beach face and in scour hollows.
- Seasonal variability is documented (e.g.
  [Malaga Cove, California, AAPG Bulletin 50:648](https://pubs.geoscienceworld.org/aapg/aapgbull/article-abstract/50/3/648/552167/)).

**Implementation:** streaks **parallel to the swash lines** (i.e. shore-parallel, curving with the
cusps), widths 1–15 cm, lengths 0.3–5 m, strongly anisotropic. Value drop is large — near-black
against pale sand — so they are the highest-contrast feature on a sand beach and should be
sparse: a few percent of area, concentrated in the upper foreshore, pooling in low spots and on
the lee side of obstacles. Colour is not pure black: magnetite/ilmenite give blue-black to
grey-purple, garnet gives red-purple, so slight hue variation between streaks is correct.

---

## (e) The wet/dry gradient

### e.1 The physics of the transition

- **Capillary fringe thickness**: *"can be up to about one meter in very fine sediment and not
  exceed a few centimetres in very coarse sediment"*; measured on beaches at **0.10–0.15 m**.
  ([Beach groundwater, Coastal Wiki](https://www.coastalwiki.org/wiki/Beach_groundwater);
  [Geng et al. 2020, Water Resources Research](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2020WR028401))
- **Where the sand stays saturated**: *"just above the low-tide level, where the groundwater table
  is shallowest (h < 0.1 − 0.2 m), the sand remains saturated."*
- **Mid-to-upper intertidal moisture content is 5–25% and highly variable** — *"from saturated
  immediately after the emersion of the beach surface during falling tide to nearly dry just
  before its submersion by the rising tide."*
  ([Tide-induced variability in beach surface moisture, ESPL](https://onlinelibrary.wiley.com/doi/10.1002/esp.4493))
- The beach matrix acts as a **low-pass filter**: the water table responds to individual waves
  only in the swash zone itself, and those high-frequency fluctuations are negligible above it.

### e.2 The derived number you actually want: how WIDE the damp band is

The damp band above the last swash limit is the capillary fringe height projected onto the beach
slope:

```
damp_band_width  =  capillary_fringe_height / tan(beta)
```

| Beach | fringe | tanβ | **damp band width** |
|---|---|---|---|
| Fine sand | 0.15 m | 0.03 | **5.0 m** |
| Medium sand | 0.12 m | 0.06 | **2.0 m** |
| Coarse sand | 0.08 m | 0.10 | **0.8 m** |
| Shingle | 0.02 m | 0.15 | **0.13 m** |

This is why a sand beach has a broad, soft, gradual tonal ramp from the water to the dry
backshore, and **a shingle beach has an almost knife-edge wet line**. If you render both with the
same blend width, one of them is wrong. On shingle it should be a hard edge — arguably per-clast:
individual cobbles are either wet or not, with a one-stone-wide transition, and the *undersides
and interstices* stay wet long after the tops dry.

> ⚠️ The formula is mine (simple trigonometry) but both inputs are sourced. The real profile also
> depends on tidal phase and drainage rate — a beach on a falling tide has a much wider damp band
> than the same beach on a rising tide, because it was recently saturated and hasn't drained. If
> you want one number, use the falling-tide (wider) case; it's the more common photographic look.

### e.3 What wetting does to the shading

**Mechanism** (Lekner & Dorf, *Why some things are darker when wet*, Applied Optics 1988 — the
standard citation; I could read summaries but not the paper itself):

1. Water replaces air between and around grains, so the **refractive-index contrast falls** from
   ~1.55/1.0 to ~1.55/1.33. Less light is back-scattered at each grain interface; more is
   forward-scattered *into* the medium.
2. Light that does scatter back upward hits the water/air interface from below and, beyond the
   critical angle (~48.6° for n=1.33), is **totally internally reflected** back into the sand for
   another absorption pass.
3. Net: mean path length in the absorbing medium rises sharply → **lower diffuse albedo**.

**Numbers.**
> ⚠️ **Weakly sourced.** The commonly quoted albedo pair is **dry sand ≈ 0.40, wet sand ≈ 0.20**
> (a factor of 2, ~1 stop). I could not open an authoritative table to confirm this — the search
> result echoed my own query terms back at me, which is not a citation. The *mechanism* above is
> solid and well established; the specific 0.40/0.20 pair should be treated as a plausible default
> to be checked against reference photography, not as a cited value. What I would state
> confidently: the drop is **substantial (roughly halving) and non-linear in saturation**, with
> most of the darkening happening in the first ~30% of pore saturation.

**Beyond value, three things change and you probably only model the first:**

1. **Value drops** — diffuse albedo × ~0.5 at full saturation.
2. **Saturation INCREASES.** More absorption passes means the colour that survives is more
   spectrally selective. Wet sand isn't just darker grey — it's *more strongly coloured*
   (browner, more golden, more olive). Multiplying albedo by a scalar 0.5 gives you a
   grey, dead beach. Multiply by a per-channel factor that darkens the weak channels more.
3. **Specular changes character.** Dry sand is close to Lambertian with a rough, broad, weak
   specular. Wet sand acquires a **smooth water film**: F0 ≈ 0.02 (n = 1.33), roughness dropping
   to near-mirror on standing water in the swash and in ripple troughs, and staying moderately
   rough where the film is thin and grain-conformal. The visible signature is a **hard sky
   reflection and a long specular streak** toward the light — this, not the value drop, is what
   makes a wet beach read as wet.

**Suggested saturation field** (drive all three from one scalar s ∈ [0,1]):
```
s = 1                        below the swash limit (standing/receding water)
s = smoothstep down to 0     over damp_band_width above it   (e.1/e.2)
s += 0.2 * (residual from last high tide, decaying over hours)
s modulated by cusp phase    (embayments wetter than horns)
s += noise in scour hollows and around clast bases (water pools and drains slowly there)

albedo_out    = albedo_dry * lerp(1.0, wet_tint, s)     # wet_tint ~ (0.55, 0.48, 0.42) - darkens AND warms
roughness_out = lerp(rough_dry, 0.08, s)                # water film
F0_out        = lerp(F0_dry, 0.02, s)
```
On shingle, apply s **per clast and per height-above-contact**, not per-pixel over a smooth field:
the tops of cobbles dry first, the wedged interstices stay dark. That vertical wet/dry banding
*within* the clast field is a strong, cheap realism cue and is impossible with a screen-space
gradient.

---

## (f) Tropical carbonate beaches

Relevant if the target look is Halo's island ring beaches, which are carbonate-coded (white sand,
turquoise water, coral rubble).

### f.1 Composition — real percentages

**Spermonde Archipelago, Indonesia** — coral reef island beaches, point-counted
([Sediment Composition and Facies of Coral Reef Islands in the Spermonde Archipelago, Frontiers in Marine Science 4:144](https://www.frontiersin.org/journals/marine-science/articles/10.3389/fmars.2017.00144/full)):

| Constituent | Outer-shelf islands (3 sites) | Inner-shelf island |
|---|---|---|
| Coralline (red) algae | 33.8 – 39.5% | **60.1%** |
| Coral | 29.7 – 39.5% | 6.7% |
| Gastropods | 11.0 – 13.4% | 10.8% |
| Foraminifera | 6.4 – 10.7% | 12.4% |
| Halimeda (green calcareous algae) | 4.0 – 8.6% | 0.7% |
| Bivalves | 0.4 – 1.0% | 2.7% |
| Echinoderms, bryozoans, other | < 2% each | — |

Grain size at those sites: mean **1460 – 2144 µm** (1.5–2.1 mm — *very coarse sand to granule*),
**poorly sorted**, textural class **sandy gravel** (>30% gravel) or **gravelly sand** (5–30%
gravel). Subsurface at one site was 80.2% coral, showing composition changes with depth.

**Molokaʻi, Hawaiʻi** ([USGS SIR 2007-5101 Chapter 17](https://pubs.usgs.gov/sir/2007/5101/sir2007-5101_chapter17.pdf)):
of the sand **along the beach**, molluscan fragments ≈ **6%**, Halimeda ≈ **6%**, coral ≈ **11%**;
CaCO₃ content **80–95% on the reef flat, consistently >90%** further out. Terrigenous mud from the
basaltic island is only 10–20% CaCO₃ and is **red-brown from iron oxidation** — so a Hawaiian
beach can carry a rust-coloured terrigenous component adjacent to white carbonate.

**Regional survey**, 100 beaches in a tropical archipelago
([Spatial variability in beach biogeomorphology in a tropical archipelago, ESPL](https://onlinelibrary.wiley.com/doi/10.1002/esp.4604)):
first-order split is **70 sand beaches : 30 coral rubble beaches**; sandy-beach mean grain size
ranges **226 µm to 4215 µm** (fine sand to fine pebble), typically *moderately sorted coarse
sand*; *"coral rubble beaches range up to boulder-sized clasts."*

### f.2 Colour and appearance

USGS Molokaʻi, on reef-derived grains: *"the grains are almost uniformly light in color — **white,
cream, or tan**."* That "almost uniformly" is important — carbonate beaches have **much lower
albedo variance than siliciclastic ones**, because everything came from the same CaCO₃ factory.
Contrast comes from *shadow and shape*, not from lithology.

**Constituent-by-constituent appearance** (from composition sources plus general carbonate
sedimentology; the appearance descriptors are synthesis, flagged below):

| Constituent | Shape | Colour | Read at 1 m |
|---|---|---|---|
| **Coral rubble** | cylindrical **branch sticks**, 20–150 mm long, 8–30 mm dia., or tabular plates | chalk white, bleached; pink/grey where recently dead | strongly **elongate rods** — the exact opposite of your discs |
| Coralline algae | irregular **nodules / crusts**, equant to platy | pink, mauve, lilac, white | subtle pink flecks |
| Halimeda | flat **segmented plates**, ~5–15 mm, disc-like | chalky white to pale green | thin white flakes, very low density (they float in swash) |
| Foraminifera | small **stars, discs, spirals**, 0.5–2 mm | white, cream, pale orange (*Baculogypsina*, *Amphistegina*) | fine cream sand; where dominant, star-sand |
| Gastropods / bivalves | **curved shell fragments**, concave-convex | white, cream, banded, occasional purple/brown | curved bright chips, high specular on the nacre side |

> ⚠️ The composition **percentages** and the grain sizes are verified. The per-constituent
> **shape and colour** descriptors above are synthesis from general carbonate sedimentology and
> reference imagery — I did not find a single citable source giving them as a table. They are
> uncontroversial but they are not cited.

### f.3 What makes a carbonate beach look different in a screenshot

1. **Shape family flips.** Coral rubble is **rods and plates**, not discs — branching *Acropora*
   fragments are stubby cylinders. A carbonate rubble beach and a siliciclastic shingle beach
   have opposite Zingg distributions. If your target is a Halo island beach, the c.3 disc recipe
   is *wrong* and you want b/a ≈ 0.45, c/b ≈ 0.80 (prolate/rod, Zingg IV).
2. **Rubble is not rounded.** Coral fragments abrade slowly and are internally porous, so they
   stay **subangular** with visible corallite texture, septa and pores. They read as *broken*, not
   *worn*. Reserve high roundness for the siliciclastic case.
3. **Albedo is high and uniform**: white/cream/tan, low variance. Very sensitive to exposure —
   this interacts with the exposureEV discontinuity already noted in this project's history.
4. **Sorting is POOR** (all four Spermonde sites) and the texture is *sandy gravel* — so a
   carbonate beach is a **wide** size range with fines everywhere between the rubble, which is
   almost the inverse of a well-sorted shingle beach.
5. **Halimeda plates and shell chips float and raft**, so they concentrate in swash-line arcs and
   in wind shadows — a distinct, very high-albedo, very low-density surface layer draped on top
   of the coarser stuff.

---

## Summary: the ten changes, ranked by screenshot impact

1. **Change the shape family to oblate discs.** b/a ~ N(0.78, 0.10), c/b ~ N(0.55, 0.12).
   Targets Ψp ≈ 0.63, OP ≈ −2.4. (c.3)
2. **Imbricate them.** a-axis shore-parallel, face dipping ~25° (±8°) **seaward**, footprints
   overlapping 25–50%, clast-supported contact — not spacing. (b.1)
3. **Cluster the placement.** Thomas cluster process, λ_parent 0.3–1.5/m², 4–12 children,
   σ_cluster 0.08–0.25 m, plus a low-frequency fbm intensity field for drifts and lags. (b.2)
4. **Add fines.** Interstitial sand/granules shading in every gap. Instance only > 8 mm; the
   remaining ~38,000 grains per pebble are a material, not geometry. (a.4)
5. **Make the histogram bimodal with a hole at 1–10 mm.** Gravel mode 5–30 mm (D50 10–20 mm,
   σφ ≈ 1.05); sand mode 0.25–0.5 mm; reject the granule size between. (a.3)
6. **Convert mass weights to count weights**: μφ(number) = μφ(mass) + 2.079 σφ². You are almost
   certainly under-populating small stones. (a.4)
7. **Add sparse boulders as a separate process** — bigger, blockier, less round, clustered near a
   source. Not the tail of the cobble log-normal. (a.5)
8. **Zone the beach cross-shore** — discs and cobbles high, spheres and rods low, coarse spike at
   the plunge step, sand fraction rising down-beach. Slope 6–11° for shingle. (b.3, b.4, b.5)
9. **Add cusps** at 8–25 m alongshore with ±20% jitter — coarse dry horns, fine wet embayments,
   scalloped wet line. This is what kills the tiling read. (b.6)
10. **Fix the wet gradient**: band width = capillary fringe / tanβ (≈ 0.13 m on shingle, 2 m on
    sand), and wetting must *darken, saturate and smooth* — not just darken. Apply per-clast on
    shingle so interstices stay dark. (e.2, e.3)

---

## Sources

- [Blott, S.J. & Pye, K. (2001) *GRADISTAT: a grain size distribution and statistics package for the analysis of unconsolidated sediments*. Earth Surf. Process. Landforms 26:1237–1248](https://onlinelibrary.wiley.com/doi/10.1002/esp.261) — Folk & Ward formulas and full classification tables (verified from the paper's Tables I–II)
- [López de San Román Blanco, B. (2003), in *Development of predictive tools and design guidance for mixed beaches — Stage 2 Final Report Appendix*, Environment Agency / Defra](https://assets.publishing.service.gov.uk/media/6026a394d3bf7f03132e96d1/Development_of_predictive_tools_and_design_guidance_for_mixed_beaches_-_Stage_2_Final_report_appendix.pdf) — UK mixed beach D50/sorting/bimodality statistics, cross-shore profiles
- [*Grain Size and Beach Face Slope on Paraglacial Beaches of New England, USA*, EarthArXiv preprint / Marine Geology (2021)](https://eartharxiv.org/repository/object/1717/download/3621/) · [published](https://www.sciencedirect.com/science/article/pii/S0025322721001092) — n=454 bimodality, 1–10 mm gap, slope-vs-D50 plateau
- [Bluck, B.J. (1967) *Sedimentation of beach gravels: examples from South Wales*, J. Sedimentary Petrology 37(1):128–156](https://pubs.geoscienceworld.org/sepm/jsedres/article-abstract/37/1/128/95953/) — four-zone gravel beach model (abstract only)
- [Dobkins & Folk (1970), Stratten (1974), Gale (1990), via *89.325 Gravel Shape and Sedimentary Environment*, UMass Lowell](https://faculty.uml.edu/Nelson_Eby/89.325/Lab%20pdfs/Gravel%20Shape%20&%20Sedimentary%20Environment.pdf) — Ψp and OP discriminants for beach vs fluvial gravel
- [*GEL 324 Sedimentology: Particle Shape Analysis*, SERC/Carleton](https://serc.carleton.edu/files/NAGTWorkshops/sedimentary/activities/particle_shape.pdf) — Zingg, Sneed & Folk, Wadell, Cailleux, Powers definitions
- [Domokos, G. et al. *How River Rocks Round: Resolving the Shape-Size Paradox*, PLOS ONE](https://pmc.ncbi.nlm.nih.gov/articles/PMC3922984/) — two-phase abrasion; axis ratios unchanged in Phase I
- [*Overpassing and armouring phenomena on gravel beaches*, Marine Geology (1993)](https://www.sciencedirect.com/science/article/abs/pii/002532279390094C) — armour layer formation
- [*Pebble clusters in gravel-bed rivers*, Earth Surf. Process. Landforms](https://onlinelibrary.wiley.com/doi/10.1002/esp.195) — clusters occupy up to 10% of bed surface
- [*Laboratory study on the evolution of gravel-bed surfaces*, J. Hydrology (2021)](https://www.sciencedirect.com/science/article/abs/pii/S0022169420312129) — cluster → line → heap → reticulate sequence
- [*Structure and self-organization of imbricated gravel bed surfaces*, J. Hydraulic Research (2025)](https://www.tandfonline.com/doi/full/10.1080/00221686.2025.2606942) — long axes perpendicular to flow
- [*Imbrication and flow-oriented clasts*, Springer Encyclopedia of Sediments and Sedimentary Rocks](https://link.springer.com/rwe/10.1007/3-540-31079-7_116) · [Wikipedia: Imbrication (sedimentology)](https://en.wikipedia.org/wiki/Imbrication_(sedimentology)) · [ScienceDirect Topics: Imbrication](https://www.sciencedirect.com/topics/earth-and-planetary-sciences/imbrication)
- [Coastal Wiki: Beach Cusps](https://www.coastalwiki.org/wiki/Beach_Cusps) · [Wave ripples](https://www.coastalwiki.org/wiki/Wave_ripples) · [Beach groundwater](https://www.coastalwiki.org/wiki/Beach_groundwater) · [Swash zone dynamics](https://www.coastalwiki.org/wiki/Swash_zone_dynamics) · [Coastal and marine sediments](https://www.coastalwiki.org/wiki/Coastal_and_marine_sediments)
- [Masselink, G. (2004) *Test of edge wave forcing during formation of rhythmic beach morphology*, JGR Oceans](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2004JC002339) · [*Field Observations of a Multilevel Beach Cusp System*, Geosciences 11:148](https://www.mdpi.com/2076-3263/11/4/148)
- [Geng, X. et al. (2020) *Groundwater Flow and Moisture Dynamics in the Swash Zone*, Water Resources Research](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2020WR028401) · [*Tide-induced variability in beach surface moisture*, ESPL](https://onlinelibrary.wiley.com/doi/10.1002/esp.4493)
- [*Direct numerical simulations of aeolian sand ripples*, PNAS](https://www.pnas.org/doi/abs/10.1073/pnas.1413058111) · [*Grain Segregation Mechanism in Aeolian Sand Ripples*, arXiv cond-mat/9809423](https://arxiv.org/pdf/cond-mat/9809423) · [Scientific American: wind ripple spacing](https://www.scientificamerican.com/article/why-do-regular-wavelike-s/)
- [*Bedforms: ripples and dunes*, geologyistheway.com](https://geologyistheway.com/sedimentary/bedforms-ripple-marks-and-dunes/) — rhomboid ripples, antidunes
- [Heavy Mineral Sands](https://sandatlas.org/heavy-mineral-sand/) and [Black Sand](https://sandatlas.org/what-is-black-sand/), sandatlas.org · [*Heavy mineral, beach-placer sandstone deposits*, NMGS Guidebook 68](https://nmgs.nmt.edu/publications/guidebooks/downloads/68/68_p0123_p0132.pdf) · [*Seasonal Distribution of Magnetite and Ilmenite in Beach Sand of Malaga Cove*, AAPG Bulletin 50:648](https://pubs.geoscienceworld.org/aapg/aapgbull/article-abstract/50/3/648/552167/)
- [*Sediment Composition and Facies of Coral Reef Islands in the Spermonde Archipelago*, Frontiers in Marine Science 4:144](https://www.frontiersin.org/journals/marine-science/articles/10.3389/fmars.2017.00144/full) · [USGS SIR 2007-5101 Ch. 17, *Sediment on the Molokaʻi Reef*](https://pubs.usgs.gov/sir/2007/5101/sir2007-5101_chapter17.pdf) · [*Spatial variability in beach biogeomorphology in a tropical archipelago*, ESPL](https://onlinelibrary.wiley.com/doi/10.1002/esp.4604)
- [Geological Digressions: *Analysis of sediment grain size distributions*](https://www.geological-digressions.com/analysis-of-sediment-grain-size-distributions/) · [Glossary: Sedimentary structures](https://www.geological-digressions.com/glossary-sedimentary-structures/)
- [Geosciences LibreTexts 3.1: Grain Size](https://geo.libretexts.org/Courses/SUNY_Potsdam/Sedimentary_Geology:_Rocks_Environments_and_Stratigraphy/03:_Describing_Sediment_and_Sedimentary_Rocks/3.01:_Grain_Size) · [Wikipedia: Shingle beach](https://en.wikipedia.org/wiki/Shingle_beach) · [Wikipedia: Cobble (geology)](https://en.wikipedia.org/wiki/Cobble_(geology)) · [NPS: Coastal Sediments — Material Size](https://www.nps.gov/articles/coastal-sediments-material-size.htm)

## Explicit gaps — things I could NOT verify

1. **Beach imbrication dip angle in degrees.** Direction (seaward), mechanism (a–b plane) and
   a-axis orientation (shore-parallel) are solid. The specific angle is not: I saw "20–25°" in a
   search summary and "20–40°" on Grokipedia, neither of which I'd cite. 25° ± 8° is
   geometrically consistent with disc packing at c/a ≈ 0.44 but is not a sourced figure.
2. **Zingg-class percentages for beaches.** No published histogram found. The 72% disc / 15%
   sphere / 11% blade / 2% rod mix in c.3 is my construction, calibrated to Dobkins & Folk's
   verified mean Ψp and OP. Consistent with Bluck's zonation, but derived not cited.
3. **Bluck's zone widths in metres.** Only the abstract was readable (full text paywalled at
   GeoScienceWorld; the Datapages mirror 403'd). Zone names, order and shape content are sourced;
   widths are not.
4. **Beach boulder size-distribution exponent.** No source found for beaches specifically.
   b ≈ 2.5 is a placeholder.
5. **Beach cusp relief/amplitude in metres.** Coastal Wiki explicitly declines to give one; no
   other readable source found. 0.1–0.5 m is inference.
6. **Rhomboid (backwash) ripple wavelength.** Height (a few mm) and geometry are sourced;
   spacing is not. 5–20 cm is inferred from photographs.
7. **Dry vs wet sand albedo values.** The 0.40/0.20 pair is widely repeated but the only "source"
   I reached echoed my query. The Lekner–Dorf *mechanism* is solid; the numbers are not verified
   and should be checked against reference photography.
8. **Areal packing fraction of an armoured gravel surface.** I could find no measured value for
   what percentage of the surface is coarse clast vs visible fines. The 10–25% bare-fines figure
   in b.2 is art direction.
9. **Buscombe & Masselink (2006) *Concepts in gravel beach dynamics*, Earth-Science Reviews
   79:33–52** — this is the definitive modern review and would supersede several inferences above,
   but every route to it (ScienceDirect, Academia.edu, the Plymouth research portal) was paywalled
   or 403'd. If anyone has institutional access, this is the one paper worth chasing.
10. **Per-constituent shape and colour of carbonate grains** (f.2 table) — the composition
    percentages are sourced, the appearance descriptors are synthesis.
