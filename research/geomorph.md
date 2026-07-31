# Coastal geomorphology of tropical sea stacks and rocky shorelines

**Purpose:** a shape vocabulary with numbers, for a procedural sea-stack / rocky-shore generator.
**Scope note:** this is a natural-science brief. No shading advice. Everything below is either cited
inline or explicitly flagged as unverified.

---

## 0. The nine rules that kill the truncated cone

If you implement nothing else, implement these. Each is expanded and sourced below.

| # | Rule | Number |
|---|---|---|
| 1 | The waterline is **undercut**, not tapered. Cut a notch into the stack at MSL. | Notch penetrates **0.4–2.5 m** horizontally; typical tropical carbonate **1–3 m** |
| 2 | The notch is **short vertically and deep horizontally** — a slot, not a cove. | Notch vertical extent **45–70 cm** (Mediterranean mean); depth/height ratio commonly **1–4** |
| 3 | Above the notch there is a **visor / brow that overhangs**, i.e. the silhouette moves *outward* going up. | Overhang crest **1.3–2.1 m** above datum on one measured stack; Ko Tapu goes **4 m → 8 m** diameter over 20 m of height |
| 4 | Notch depth **varies with aspect** around one stack by a factor of ~3–4. Do not make it axisymmetric. | 0.65 m sheltered face vs 2.0–2.5 m exposed face on the *same* stack |
| 5 | The profile is **stepped by bedding**, not smooth. Ledge spacing follows bed thickness. | Joint spacing ≈ **0.3–1.2 × bed thickness** (mode ~1.0–1.3), **lognormal** |
| 6 | The plan outline is **polygonal**, cut by 2–3 joint sets, not circular. | Orthogonal sets, ~90° apart; columnar basalt **0.4–1.1 m** across, 55 % hexagons |
| 7 | There is at least one **detached buttress** separated along a planar fracture. | Arch/collapse residue; blocks in a channel between stack and shore |
| 8 | A **hard horizontal tone break** at the top of the splash zone (black band). | Splash zone **~1 m** high sheltered, **tens of metres** exposed |
| 9 | **Angular talus** at the base, scattered out to a **27–32° shadow angle** from the notch roof. | Talus surface **29–36°**; block volume power law exponent **β ≈ 0.5 ± 0.2** |

---

## (a) Wave-cut notch morphology

### Terminology (use these, the literature is inconsistent)

Following the measurement scheme in Antonioli et al. 2015 (Fig. 3 of that paper):

- **Notch width (A)** = the *vertical* extent of the notch, base to roof. Confusingly named; it is a height.
- **Notch depth (B)** = the *horizontal* inward penetration. This is the undercut you are missing.
- **Bottom depth (C)** = horizontal extent of the notch floor / biological rim.
- **Rim thickness (D)** = thickness of the organic encrustation on the notch floor.
- **Cliff-toe depth (E)** = position of the toe at MSL.

Source: Antonioli, F. et al. (2015) *Tidal notches in Mediterranean Sea: a comprehensive analysis*,
Quaternary Science Reviews 119, 66–84.
Post-print PDF: <https://arts.units.it/retrieve/handle/11368/2845156/415396/2845156_Tidal%20notches%20in%20Mediterranean%20Sea%20a%20comprehensive%20analysis.%20Part%201-PostPrint.pdf>
Publisher: <https://www.sciencedirect.com/science/article/abs/pii/S0277379115001237>

### Core dimensions (71 carbonate sites, Mediterranean)

> "In average, all the tidal notches we measured are 45–70 cm wide and 40–100 cm deep, although more
> extreme values are possible." — Antonioli et al. 2015, §4.1

So for a microtidal (~0.4 m) carbonate coast:

- **Vertical extent: 0.45–0.70 m**
- **Horizontal undercut: 0.40–1.00 m**
- **Depth ÷ height ratio: ~0.6 to ~2.2**, higher on exposed sites.

Trenhaile's review gives the full envelope across all settings: notches are
"indentations ranging from a few centimetres up to several metres in height and depth, cut into cliff
bases" — Trenhaile, A.S. (2015) *Coastal notches: their morphology, formation, and function*,
Earth-Science Reviews 150, 285–304. <https://www.sciencedirect.com/science/article/abs/pii/S0012825215300271>
**(Full text was paywalled to me — I only have the abstract/snippet. Treat the "several metres" upper
bound as reviewed-but-second-hand.)**

### Scaling to tidal range

The single most useful scaling law found:

> "In sheltered areas, the notch width [vertical extent] is ~**0.3–3.2 times the tidal range**, a ratio
> that seems maintained in exposed sites, although with larger variability."
> — Antonioli et al. 2015, §4.2

And critically for silhouette:

> "In exposed sites, the depth of the notch increases with respect to sheltered sites… **increased wave
> action results in an increased notch depth rather than an increased notch width**, which seems more
> constant and related, to some extent, to the tidal range."

**Generator consequence:** notch *height* is a function of tide (roughly fixed for a given world);
notch *depth* is a function of wave exposure, and therefore of **aspect**. Drive depth from
`dot(faceNormal, dominantSwellDirection)`.

Confirmed independently in a tropical carbonate setting (Bonaire, Netherlands Antilles), where the
modern notch is **81 ± 13 cm** in vertical extent against a Great Diurnal tidal range of only
**23.4 cm** — a ratio of ~3.5 — and the MIS 5e fossil notch is 65 ± 19 cm.
Rovere, A. et al. (2017) *Tides in the Last Interglacial: insights from notch geometry and palaeo tidal
models in Bonaire*, Scientific Reports 7. <https://www.nature.com/articles/s41598-017-16285-6>
(open access mirror: <https://pmc.ncbi.nlm.nih.gov/articles/PMC5701235/>)

Also from Antonioli: "the present notch is always **wider than the maximum local tide**" — checked at
Barbados, Zanzibar, Bonaire, Phi Phi (Thailand), Mauritius. So: **notch vertical extent > full tidal
range, always.** Never draw a notch shorter than the tide.

### Height relative to mean sea level

The apex/deepest point of a tidal notch sits at or very near MSL, but not exactly, and it **shifts with
aspect on a single stack**. Measured on Shag Rock, a calcareous-sandstone sea stack at Trigg, Western
Australia (Abensperg-Traun, M., Wheaton, G.A. & Eliot, I.G., 1990, *Bioerosion, notch formation and
micromorphology in the intertidal and supratidal zones of a calcareous sandstone stack*, J. Royal Soc.
Western Australia 73(2), 47–56):
<https://ia801503.us.archive.org/18/items/biostor-256746/biostor-256746.pdf>

> "In general, the elevation of the notch is close to the upper tidal zone. It lies between **0.1 m and
> 0.2 m above AHD Zero** on most profiles. Exceptions… on the southern profile, where the deepest point
> is **0.6 m above**, and on the eastern profile where it is **0.5 m below**, AHD Zero. The exceptions
> respectively correspond with the **most exposed and protected** aspects of the stack."

**Generator consequence:** the notch apex is not a horizontal circle. Sweep it as
`z_apex = MSL + 0.0…+0.6 m on the windward side, MSL − 0.5 m on the lee side`. That single tilt does
enormous work — it makes the undercut read as wave-driven rather than lathe-turned.

### Notch depth varies by aspect on ONE stack

Same source, Shag Rock macromorphology:

> "The notch is deepest (**2.0–2.3 m**) on the south and southwest profiles and least on the western
> wall, inside the 'V' where it is **0.65 m** deep."
> "The notch varies from ca 0.6 m in depth inside the 'V' to **2.5 m** on the exposed southwesterly
> face. There is **moderate visor development** on the northern side of the stack, where the notch is ca
> 1.6 m deep. The **leeward, easterly face is nearly vertical** in some places and there are
> **collapsed blocks in the channel** between Shag Rock and the shoreline."

So on one ~10 m-class stack: **notch depth ranges 0.65 → 2.5 m (×3.8) around the circumference**, and
the lee face has essentially no notch at all — it is a plain vertical wall with debris at its foot.

### The visor / overhanging brow

Same source:

> "The upper surface of the stack has a northeasterly slope so that the **crest of the visor is highest
> (2.1 m) in the southwest and lowest (1.3 m) to the northeast**. The overhang varies in shape with
> aspect and exposure to wave and current activity."

So the visor rim is a **tilted plane**, 0.8 m of relief across the stack. The overhang projects outward
above the notch; the "V" re-entrant on the sheltered side has almost none.

### Rock-type differences

**Limestone / carbonate (massive):**
Deep, sharply-cut, roof-and-floor-parallel notch with a *pronounced visor*. This is the mushroom
profile. Antonioli's mechanical data for the rocks that carry these notches
(their Table 3):

| Property | Massive limestone | Organogenic limestone | Calcitic dolostone | Dolostone | Calcarenite (sandstone) |
|---|---|---|---|---|---|
| Porosity n (%) | 4–10 | 10–20 | 10–20 | 4–11 | **44–50** |
| Uniaxial compressive strength (MPa) | **227.5** | 135.3 | 131.4 | 117.7 | **28.4–36.2** |
| Flexural strength (MPa) | 20.1 | 16.7 | 14.5 | 11.8 | 2.2–5.1 |

**Sandstone / calcarenite / stratified limestone:**

> "By grouping our data according to lithology, **sandstones and stratified limestone have… a
> width/depth ratio lower than massive carbonate rocks**. This relation supports the notion that in
> weaker lithologies wave action affects notch depth rather than notch width."

i.e. **weak, porous, bedded rock → the notch is *deeper and shorter*** — a narrow horizontal slot
driven far in. Massive limestone → a taller, more open notch with a strong visor. Do not use the same
notch cross-section for both.

Also: bedded rock puts the notch roof and floor **on bedding planes**, so the notch has flat, parallel,
razor-straight top and bottom surfaces and a *rectangular* section, not a lens.

**Basalt / volcanic:**
This is the weakest part of my evidence and I will say so plainly. I did **not** find a quantitative
study giving basalt notch depth/height ratios. What is defensible:

- Basalt has no karst dissolution and far less bioerosion susceptibility than limestone, so notching is
  dominated by **mechanical quarrying along cooling joints**, not by solution. Consequence: the notch is
  **irregular, plucked and blocky**, following column boundaries, rather than a smooth continuous slot.
- Basaltic sea cliffs preferentially develop **arches, caves and plunging cliffs** at flow-unit
  boundaries where a rubbly flow top or a weaker interior sits between denser layers. Example: Hōlei Sea
  Arch, Hawai'i Volcanoes NP, **27 m (90 ft) high**, "cut into the cliff of an ancient lava flow from
  about 550 years ago due to **differential erosion**" of layers of varying hardness.
  <https://www.nps.gov/places/holei-sea-arch.htm>
- Practical rule for a generator: on basalt, replace the smooth notch curve with a **stepped notch whose
  depth jumps discretely at each flow-unit contact**, plus a *rubble apron* rather than a clean floor.

### Notch floor: the biological rim

On carbonate coasts there is a constructional ledge at the notch base:

> "The biological coverage reaches thicknesses of up to **25 cm**." (corallinaceous algae —
> *Lithophyllum* spp. — plus vermetids, mussels, limpets, barnacles) — Antonioli et al. 2015

Visually: a **pale, knobbly, often pinkish-white to buff rim** that sticks out at the bottom lip of the
notch, right at low water. It is one of the sharpest tonal edges on the whole rock. It also means the
notch floor is *convex/lipped*, not a flat shelf running back into the cut.

Rim thickness correlates positively with mean wave energy flux (their Fig. 5d).

### Erosion rates (for anyone parameterising "age")

- Overall notch-forming lowering rates, Mediterranean carbonate: **0.02–2.1 mm/yr** (Antonioli et al. 2015).
- Bioerosion specifically: **0.2–1.28 mm/yr** (Evelpidou et al. 2012, cited therein).
- Mid-intertidal maximum, Gulf of Trieste: **~0.3 mm/yr**; supratidal **0.09–0.194 mm/yr**
  (Furlani et al.) — supratidal and subtidal rates are ~**one order of magnitude lower** than intertidal.
  *This is why the notch exists at all.*
- Shag Rock, calcareous sandstone: upper intertidal **0.2–0.8 mm/yr**, lower intertidal **0.4–0.5 mm/yr**;
  the observed notches would take **2,000–8,000 yr** to cut at those rates.
- Twelve Apostles (Port Campbell limestone, high-energy Southern Ocean): base erosion **~2 cm/yr** —
  three orders of magnitude faster than Mediterranean carbonate. Soft rock + big waves.

---

## (b) Why the silhouette is non-monotonic

A truncated cone is the shape of a pile of homogeneous material. Real stacks are **residuals of a
structure**, and every stage of their history leaves a discontinuity in the outline.

### The canonical sequence

Joint/fault → cave → arch → stack → stump. The sea attacks "lines of weakness, such as steep joints or
small fault zones in a cliff face"; cracks enlarge into caves; a cave that pierces a headland becomes an
arch; the arch collapses leaving a pillar; the pillar collapses to a stump low enough to be submerged at
high tide. <https://en.wikipedia.org/wiki/Stack_(geology)>

Each stage is a **different geometric operator**, and each leaves a signature. Build them as a stack of
operators, not as one profile curve:

**1. Joint control → polygonal plan and planar faces.**
The stack is bounded by pre-existing fracture surfaces. Its plan view should be a **polygon with 3–7
sides** whose edges align with 2–3 joint set azimuths shared with the parent headland, not a circle.
Two orthogonal sets is the commonest arrangement in flat-lying bedded rock — see e.g.
*The formation of orthogonal joint systems and cuboidal blocks… flat-lying limestone beds, Havre-Saint-
Pierre, Quebec*, <https://www.sciencedirect.com/science/article/pii/S1674775523001154>.
Critically: **the same joint azimuths must appear on neighbouring stacks and on the mainland cliff.**
Randomising per-stack destroys the read. Use one global joint frame + per-stack ±10° jitter.

**2. Arch collapse → an asymmetric flat scar and a stump/counterpart nearby.**
An arch collapse removes a *span*, leaving one or two abutments. The signature is:
   - a **large, planar, fresh-toned failure surface** on one side, dipping steeply, sometimes overhanging;
   - a **notch or slot at the former springing line** (the height at which the arch sprang);
   - a **debris cone directly beneath that scar only** — not around the whole base;
   - very often a **second, lower residual** 10–40 m away (the other abutment) — pairs and triplets, not
     lone spires. Twelve Apostles went from twelve to eight stacks after a 50 m stack fell on
     3 July 2005; the surviving group stands **up to 45 m** high.

**3. Differential erosion of bedding → horizontal steps and re-entrants.**
Where a weak bed (marl, shale, rubbly flow top, poorly cemented grainstone) sits between resistant beds,
the weak bed erodes back to form a **horizontal slot / re-entrant**, and the resistant bed above
**overhangs**. This is what makes the silhouette move outward with height in places. Ledge spacing =
bed thickness. In shallow-marine carbonates and lava piles this is typically **0.2–2 m** per unit
(*bed thickness range is my own reading of the field literature, not a value I found stated as a range in
a single citable source — flagged*). What *is* citable is that joint spacing tracks bed thickness — see (c).

**4. Case hardening / differential cementation → mushroom and pedestal forms independent of the notch.**
Isolated hard nodules or a cemented cap produce **cap-and-stem** profiles at scales well above the tidal
notch. Combined with the notch you get a *double* waist: one at MSL, one at the base of a resistant cap.

**5. Toppling / spalling of the visor → truncated overhangs.**
The visor cannot grow indefinitely; it fails in tension. So real stacks show **partly-collapsed
overhangs**: an overhang on one arc, a fresh vertical scar where the overhang broke off on the adjacent
arc, and a block of that overhang lying in the notch below. This is the single richest source of
non-monotonic outline.

### Concretely: what "non-monotonic" should mean in your radius function

Do not write `r(h) = r0 * (1 - k*h)`. Write a **piecewise profile with at least four inflections**, then
break the axial symmetry:

```
h (m above MSL)   r/r_max   character
 -2.0             0.98      submerged base, flaring slightly
 -0.4             0.98      floor of notch
 -0.2             0.55–0.85 NOTCH APEX  (r drops by 0.15–0.45 of radius — this is the undercut)
 +0.3             0.60–0.90 notch roof
 +0.8             1.00      VISOR / BROW — r is now LARGER than at the notch, and often
                            larger than the local mean → the outline flares outward
 +1.5             0.93      first bedding re-entrant
 +2.5             0.97      resistant bed, slight overhang again
 …                          alternate ±0.04 r per bed to the top
 top               0.5–0.9   crown; often BROADER than the waist (see Ko Tapu below)
```

And make **r a function of (h, θ)** with the notch depth term scaled by wave exposure:
`notchDepth(θ) = d_min + (d_max − d_min) * max(0, dot(n(θ), swellDir))^1.5`, with
`d_min/d_max ≈ 0.65 m / 2.5 m` on a ~10 m stack (Shag Rock, measured).

### The proof case: Ko Tapu

Ko Tapu ("James Bond Island"), Phang Nga Bay, Thailand — Permian limestone karst tower:

> "Ko Ta Pu reaches approximately **20 metres (66 ft)** tall… The rock's diameter expands from about
> **4 metres (13 ft) near the water level to approximately 8 metres (26 ft) at its top**."
> <https://en.wikipedia.org/wiki/Ko_Tapu>

**The stack is twice as wide at the top as at the waterline.** That is the exact inverse of a truncated
cone with a straight batter. If your generator cannot express this, it cannot express tropical carbonate
sea stacks. Radius ratio top:base = **2.0** over an aspect ratio of height:base-diameter = **5.0**.

Supporting: Phang Nga Bay limestone is Permian, **250–295 Ma**, locally **>1,000 m** thick; the current
tower karst morphology dates to ~2 Ma. <https://visitjamesbondisland.com/geology.html>

And Palau's Rock Islands: "Many of the islands display a **mushroom-like shape with a narrower base at
the intertidal notch**" <https://en.wikipedia.org/wiki/Rock_Islands>; notches there "extend approximately
**2–3 m horizontally** at lowest spring tide" (figure caption, Rovere et al., via
<https://www.researchgate.net/figure/a-Evidence-of-stable-sea-level-along-the-ubiquitous-limestone-islands-of-Palau-b_fig1_282222070>).

---

## (c) Surface texture at 1–50 m viewing distance

### Measured surface roughness — a real amplitude number

Shag Rock (Abensperg-Traun et al. 1990) measured surface elevation at **2 mm intervals along 15 cm
profile segments** in **40 cm bands** down the rock face, and reported the roughness coefficient R = the
standard deviation of the detrended elevations, in mm:

| Distance below visor rim | Profile 1 (S) elev / R | Profile 3 (E) elev / R | Profile 6 (N) elev / R | Profile 8 (SW) elev / R |
|---|---|---|---|---|
| 40 cm | 1.6 m / **5.3** | 1.2 m / 5.7 | 1.0 m / 3.1 | 1.3 m / **10.8** |
| 80 cm | 1.2 m / 3.3 | 0.8 m / 6.0 | 0.6 m / 6.5 | 0.9 m / 5.1 |
| 120 cm | 0.8 m / **15.3** | 0.4 m / 3.5 | 0.2 m / **13.1** | 0.5 m / **13.4** |
| 160 cm | 0.4 m / 4.9 | −0.1 m / 6.1 | −0.2 m / 3.2 | 0.1 m / 5.5 |
| 200 cm | 0.0 m / 6.0 | −0.5 m / 5.1 | — | −0.3 m / 7.2 |

> "The highest roughness coefficients were recorded in the upper intertidal and supratidal zone,
> **between AHD Zero and 0.8 m**… Roughness **decreases above and below this band**. It increases again
> near the visor rim on the southerly and westerly profiles, where the upper part of the rockface is
> exposed to spray."

**Directly usable:** at a 15 cm gauge length, displacement RMS is
**~3–6 mm baseline**, rising to **13–15 mm in a ~0.8 m-tall band centred on the upper intertidal**, and
rising again at the spray-wetted visor rim. That is a **2.5–3× roughness multiplier** in one narrow
horizontal band — a *texture* band that coincides with, but is not the same as, the *colour* band in (d).
It is also anisotropic by aspect: "the roughest profiles were those facing to the west and southwest"
(i.e. into the weather).

The mechanism is grazing: the roughness maximum "was coincident with the highest densities of
*Littorina unifaciata*". Molluscan rasping produces **millimetre-to-centimetre pits and homesite
depressions**; the paper gives a chiton homesite mean volume of **55 cm³** (≈ 4–5 cm across) and chiton
homesite excavation rates of **0.2–2.9 mm/yr**.

### Bedding planes

Horizontal (or gently dipping) partings. Visually at 1–50 m: **continuous horizontal lines wrapping the
whole stack and continuing onto neighbouring stacks and the mainland cliff at the same elevation.** The
continuity across separate rocks is the tell that they are one bedrock unit. Spacing = bed thickness.
Weak beds recess; strong beds project as ledges 5–40 cm proud.

### Joint sets: spacing and orientation

The strongest usable quantitative relation:

> "Field observations provide a broad range of **fracture spacing to layer thickness ratios from <0.1 to
> >10, with the most commonly reported values between 0.3 and 1.2**." Cohesive units of the Monterey
> Formation "show a nearly constant ratio of layer thickness to joint spacing of about **1.3**."
> — Bai & Pollard (2000), *Fracture spacing in layered rocks: a new explanation based on the stress
> transition*, J. Structural Geology.
> <https://www.sciencedirect.com/science/article/pii/S0191814199001376>
> See also the original Narr & Suppe relation: <https://www.sciencedirect.com/science/article/abs/pii/0191814181900134>

Distribution shape:

> "The frequency distribution of the **ratio of joint spacing to median spacing is log-normal**."
> Power-law form `s = m·t^(1−1/k)`, m = ½ (layer tensile strength / interface shear stress), k = Weibull
> modulus. <https://www.sciencedirect.com/science/article/abs/pii/S0191814121001371>

**Generator recipe:** pick bed thickness `t` per unit; draw joint spacing from
`lognormal(median = 0.3…1.2 × t, σ_ln ≈ 0.5)`; orient joints in **two near-orthogonal sets** with a
weaker third set; extend joints **only within a bed** (they terminate at bedding planes) — that
bed-bounded termination is what produces **cuboidal blocks** and hence the angular talus in (e).

**Columnar jointing (basalt), where the setting is volcanic:**
- Devils Postpile: columns **up to 1.1 m (2.5 ft) diameter**, **up to 18 m (60 ft) long**, **55 %
  hexagonal**; host flow up to 122 m thick.
- Devils Tower: larger columns **1.8–2.4 m diameter near the base, tapering to ~1.2 m at the top**.
- Coastal example (Giant's Causeway, N. Ireland): **~40 cm** diameter.
- "Columnar-blocky jointing" ranges **0.3 m to >3 m** diameter.
- Column width is governed by cooling rate: **fast cooling → narrow columns**.
  <https://www.nps.gov/subjects/volcanoes/columnar-jointing.htm>

A basalt sea cliff therefore reads at 10–50 m as a **vertical corduroy of 0.4–1.2 m prisms**, with a
lower *colonnade* of regular tall columns and an upper *entablature* of smaller, chaotically-oriented
columns — the contact between them is a sharp horizontal texture change.

### Spalling / cavernous weathering (tafoni, honeycomb)

- **Tafoni**: cavities from **<1 cm to >1 m**. <https://en.wikipedia.org/wiki/Tafoni>
- **Alveolar / honeycomb weathering**: individual cells **<2 cm** (Wikipedia) to **2–5 cm** typical
  diameter. <https://en.wikipedia.org/wiki/Honeycomb_weathering>
- Broader survey range in the literature: from polygonal cells of **2–4 mm** up to circular pits of
  **30 m+**. ("Tafoni and other rock basins", <https://scholarworks.uark.edu/geospub/31/>)
- Both are strongly favoured by **salt-rich, wetting-and-drying environments** — i.e. exactly the
  **supratidal / spray zone**, above the notch. Place them in the band from just above the visor to a few
  metres up, not at the waterline and not on the crown.

**Case hardening** is the co-process: a **surface rind** cemented by evaporated salts/carbonate, harder
than the interior. Visually it gives (i) a slightly *lighter, smoother, sometimes glazed* skin, and
(ii) **rimmed cavities** — the hardened rind survives as a thin lip around a hollowed interior, and
(iii) **shell-like spall scars** where a plate of the rind has flaked off, exposing a *fresher, lighter,
untextured* patch with a **sharp curved boundary**. Spall scars are the correct way to break up an
otherwise-uniform rock face: 5–50 cm across, concave, sharply bounded, higher-albedo than their
surroundings.
**Caveat: I did not find a citable number for case-hardened rind thickness. Do not quote one.**

### Solution flutes / karren (carbonate only)

On tropical limestone above the notch you get **karren**: rillenkarren (sharp, parallel, downslope
flutes), spitzkarren (needle-sharp pinnacles), kamenitzas (flat-floored solution pans), and
biologically-driven **phytokarst** (irregular, needle-sharp, blackened, pitted rock).

Gómez-Pujol & Fornós identify **four morphological zones along limestone coastal profiles**, with
"marine abrasion, bioerosion and biological driven solution show[ing] a larger influence seaward,
whereas non-biological driven solution enhances its participation landward."
<https://digitalcommons.usf.edu/geologia/vol55/iss1/art5/>

**Gap, stated plainly:** both open-access copies of the coastal-karren paper were blocked to me (403 /
bot-wall), so **I have no verified numbers for rillenkarren width, flute spacing or kamenitza diameter**.
I am not going to make them up. What is safe to say without numbers: karren are **sub-decimetre-scale,
sharply-crested, and strongly directional (down the local slope)**, and their density increases upward
away from the wave-washed zone. If you need numbers, that is the paper to get hold of.

The visual consequence you *can* build without numbers: tropical carbonate above the splash zone is
**not smooth** — it is a fretwork of sharp, dark, pitted, near-vertical needles and blades, and it is
notably **rougher and sharper** than the wave-polished rock inside the notch. The notch interior is
comparatively **smooth and rounded**; the rock above it is **jagged**. That inversion (smooth low, jagged
high) is the opposite of what a naïve erosion model produces and is a strong recognition cue.

---

## (d) The tidal banding — vertical zonation and its colours

This is the hard horizontal tone break. It is real, it is sharp, and it is *biological*, not lithological.

### Band order, bottom to top

| Band | Organisms | Colour | Vertical position |
|---|---|---|---|
| Sublittoral fringe | kelps / large algae, coralline crusts | dark olive-brown to near-black when wet; pink-white coralline | below MLWS |
| **Biological rim / algal rim** | *Lithophyllum*, vermetids, coralline algae | **pale buff / pinkish-white**, knobbly, up to **25 cm thick** | at the notch floor, ~MLW |
| Algal turf / lower midlittoral | turf algae, mussels | **dark olive-green to blackish-green**, matte, "furry" | lower half of intertidal |
| **Barnacle band** | *Chthamalus*, *Tetraclita*, *Balanus* | **white to pale grey, very rough**, high-frequency speckle | roughly the lower/mid half of the tidal range |
| **Littorinid band** | periwinkles / *Echinolittorina* | bare rock with dark speckle; reads as **mid-grey** | roughly the upper half of the tidal range |
| **Black band** | *Verrucaria* / *Hydropunctaria maura* lichen (temperate); endolithic cyanobacteria — *Calothrix*, *Kyrtuthrix* (tropical) | **matte black to charcoal, sharply bounded** | littoral fringe / splash, at and above MHWS |
| Yellow-grey lichen band | *Xanthoria parietina*, *Caloplaca marina* | **orange-yellow and pale grey**, patchy | supralittoral, above the black band |
| Terrestrial | vegetation | green | above |

Sources:
- Band sequence "(1) a black band of blue green algae and lichens (in the spray zone or just at or above
  the highest regular tides); (2) a periwinkle snail or littorinid snail zone (roughly the upper half of
  the tide zone); (3) a **white and very rough barnacle zone** (the lower half of the regular tide)".
- "the black lichen *Hydropunctaria maura*… creates **a distinct black band in the upper littoral
  fringe**", sitting **below the yellow and grey lichen zone**.
  <https://www.marlin.ac.uk/habitats/detail/120/verrucaria_maura_on_littoral_fringe_rock>
- "Yellow and grey lichens such as *Xanthoria parietina*, *Caloplaca marina*" dominate the supralittoral,
  with "the distinctive black band of *Verrucaria maura*" below in the littoral fringe.
  <https://eunis.eea.europa.eu/habitats/30004>
- "mussels, barnacles, and lichens form a series of **contrasting colour bands**" — Oxford Academic,
  *Vertical distributions: 'zonation' and its causes*.
- Tropical equivalent of the black band is **endolithic cyanobacteria** in the spray zone —
  filamentous cyanobacteria "endure extreme salinity fluctuation and complete desiccation within the
  wave spray zone" <https://people.bu.edu/golubic/marine-cyano.html>; "Bioerosion on tropical limestone
  coasts consists of interaction between **microbial endoliths** and invertebrate grazers"
  <https://www.researchgate.net/publication/239926476>.
  Note this is *endolithic* — it lives **inside** the top millimetres of the rock, so the black is a
  stain in the substrate, not a coating on it. It follows every micro-relief exactly and does not sit
  proud. Model it as an albedo mask, not geometry.

### Band heights — the number that actually matters

The one solid, citable number for band height is for the splash/black zone, and it is a *huge* range:

> "The width of the splash zone varies considerably, depending on the degree of exposure of the shore to
> wave action. On **very exposed coasts the zone is very wide, extending 10s of meters up cliffs**,
> whilst in very **sheltered sites it may be only a metre or so high**."
> — EUNIS habitat 30004 / JNCC. <https://eunis.eea.europa.eu/habitats/30004>

Corroborating field measurement on the tropical/subtropical Australian stack: wave splash and wetting
marks reach **up to 70 cm above MHWS** on Shag Rock (a low, sheltered-ish site with ~0.6 m tide), and
"under wave action, wave splash occurs to **the roof of the notch, at least**."

Another usable anchor (Interhemispheric comparison, Ecosphere 2020): fucoid seaweed upper boundary at
**1.5 m above chart datum**, barnacle distribution limit at **4 m above chart datum** on the shores
studied. <https://esajournals.onlinelibrary.wiley.com/doi/full/10.1002/ecs2.3068>

**Practical parameterisation for a tropical island with tidal range T (use T = 1.0–2.0 m):**

```
z_MLWS      = -T/2
z_MHWS      = +T/2
black band  : from  z_MHWS - 0.2T   to   z_MHWS + E     where E = splash rise
              E = 0.5–1.5 m on a sheltered lee face
              E = 3–15 m on a fully exposed windward face   (EUNIS: "10s of m" at the extreme)
barnacle    : from  z_MLWS + 0.15T  to   z_MHWS - 0.1T
littorinid  : overlaps the upper half of the barnacle band, adds grey speckle
algal turf  : from  z_MLWS - 0.3T   to   z_MLWS + 0.3T
bio rim     : a 10–25 cm thick ledge at the notch floor
```

**Two things that make the banding read correctly, and are usually got wrong:**

1. **The black band's upper edge is sharp; its lower edge is diffuse.** The top is a hard line set by the
   maximum splash reach. Below, it grades into the grazed/barnacled zone.
2. **The bands are NOT horizontal around the stack.** They rise on the windward face and drop on the lee
   face, by the same E term that governs splash. Sweep the band elevations with
   `z(θ) = z0 + E * max(0, dot(n(θ), swellDir))`. This is the *single* strongest reason a real photo of a
   stack does not look like a layer cake: the "waterline stripe" tilts and thickens toward the weather.
   The same aspect asymmetry is measured in the notch geometry (§a), so drive both from one term.
3. The bands **continue across the water onto neighbouring stacks and the mainland cliff at the same
   elevation**. Coherence across objects is the read.

---

## (e) Talus and collapse debris at the base

### Shape of the blocks

Blocks are **angular and equant-to-tabular**, bounded by the pre-existing joint and bedding surfaces —
i.e. they are **cuboids and wedges with planar faces and sharp edges**, not rounded boulders. They only
round after long residence in the surf zone. Fresh talus = angular; old, wave-worked talus at the
waterline = rounded to sub-rounded. **Put both in the same pile, sorted by height.**

Measured block-shape axial ratios on four talus slopes (median values):
**1.73 (most cuboid, basalt at Piton de la Fournaise), ~2.2, ~2.2, 2.63 (most elongate)**.
Median block volumes at those four sites: **0.08, 1.63, 3.38 and 13.16 m³**.
<https://nhess.copernicus.org/articles/21/1159/2021/>
(0.08 m³ ≈ 0.43 m cube; 13.16 m³ ≈ 2.4 m cube.)

### Size distribution

Rockfall volumes follow a **power law**. Cumulative volume–frequency exponent:

- **β = 0.5 ± 0.2** for subvertical cliffs — "significantly smaller than the 1.2 ± 0.3 value reported for
  mixed landslide types." Dussauge-Peisser et al. (2002), JGR.
  <https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2001JB000650>
- A worked recent inventory gives **β = 0.54**. <https://www.mdpi.com/2624-795X/7/2/69>
- Reported range across studies: **0.4–0.7**.
  <https://www.sciencedirect.com/science/article/abs/pii/S0169555X22003567>

**Generator recipe:** sample block volume from a Pareto with `P(V > v) ∝ v^(−β)`, `β = 0.5`, over
`V ∈ [0.01, 30] m³`. Because β < 1 the mean is dominated by the largest blocks — **you need a few blocks
much larger than the modal size**, otherwise the pile reads as gravel. A good visual set on a 15 m stack:
one or two blocks of **2–3 m** across, five to ten of **0.8–1.5 m**, and dozens of **0.2–0.6 m**, all
angular, plus fines.

### Slope and pile geometry

- Angle of repose for talus: **30–45°**, most commonly **34–36°**.
  <https://onlinelibrary.wiley.com/doi/abs/10.1002/esp.3290020408>
- Measured talus surface angles at four field sites: **29° (basalt, Réunion), 32°, 32°, 36°**, with local
  sectors up to 43°. <https://nhess.copernicus.org/articles/21/1159/2021/>
- **Use 32–35° for the main cone, with local 40–43° at the apex and 25–28° at the toe (concave-up).**

### How far the debris scatters — the shadow angle

The **shadow angle** is the angle from the horizontal, measured from the *apex of the talus* (i.e. the
base of the free-fall cliff) to the farthest travelled boulder. Its complement, the **reach angle**
(Fahrböschung), is measured from the *release point*. Values in the literature:

| Study | Minimum shadow angle |
|---|---|
| Lied (1977) | **28°–30°** |
| Evans & Hungr (1993), 16 paths in British Columbia | **27.5°** |
| Wieczorek et al. (1998, 2008), 25 boulders, Yosemite | mean **26°**; minimum **22°** for larger rockfalls |
| Meißl (2001), German/Austrian Alps | **31.5°** |
| Copons (2004), Solà d'Andorra | farthest boulder **25.5°**; usual **~27°** |
| Extremes (glacier / fine debris / grass) | Evans & Hungr **24°**; Holm & Jakob **21°**; Domaas **17°** |

Statistical distribution from 103 blocks stopped on talus at Solà d'Andorra (block sizes 5–150 m³):
tan(shadow angle) ranges **0.60–0.86** (i.e. **31.0°–40.7°**), mean interval **0.70–0.75**
(**35.0°–36.9°**); 90th percentile **31.8°**, 99th percentile **30.0°**; a value of **27°** is used for
the extreme outliers beyond the talus toe.
Reach angle from 110 blocks: tan **0.75–1.5** (**36.9°–56.3°**), mean interval 0.95–1.0 (**43.5°–45.0°**).
Copons et al. (2009), NHESS 9, 2107–2118.
<https://nhess.copernicus.org/articles/9/2107/2009/nhess-9-2107-2009.pdf>

**Generator recipe.** For a stack of height H whose visor sits at height H:
- Bulk of the talus: within a horizontal distance `L = H / tan(35°) ≈ 1.43 H` of the base.
- Outliers ("rockfall shadow"): a sparse scatter of large blocks out to `L = H / tan(27°) ≈ 1.96 H`.
- Rare farthest block: `H / tan(22°) ≈ 2.5 H`.
- So on a **20 m** stack, the debris field is **~29 m** of dense talus with isolated boulders out to
  **~40–50 m**. That is a big apron. Undersized debris fields are a common tell.

**Marine modification — important, and specific to this setting.** Below the notch the talus is *not* a
static cone. Waves rework it: blocks are rounded, sorted, and either (i) driven into a **boulder
rampart / storm ridge** at the back of the platform, or (ii) removed entirely, leaving a **clean shore
platform**. Consequences:
- The talus cone **does not extend into the water on the exposed face** — waves clear it. On that side
  you get bare platform plus a few very large blocks too heavy to move (>2–3 m).
- On the **lee face** the talus survives intact right down to the water: this is where you get the
  classic debris ramp. Directly observed: at Shag Rock, "the leeward, easterly face is nearly vertical in
  some places and there are **collapsed blocks in the channel** between Shag Rock and the shoreline."
- So the debris field is **asymmetric in the same sense as the notch**: notch deep + debris cleared on
  the weather side; notch shallow + debris piled on the lee side. **One exposure term drives notch depth,
  band elevation, roughness and talus distribution.** That coupling is what makes the whole thing read as
  one place rather than three independent noise fields.

---

## (f) The specific look of a tropical carbonate/volcanic island shore

The Silent Cartographer setting — limestone/coral over volcanic basement — is a real and common
configuration: a volcanic edifice capped and fringed by reef carbonate, then uplifted. Palau's Rock
Islands are precisely this: "limestone 'icing' on top of the sinking volcanic 'cake'", coral limestone
exposed by a subduction-related uplift ~35 Ma.
<https://paddlingpalau.net/geology.html>

I could not find any published art-direction statement about the geology of the level.
Halopedia's level page gives no useful visual description of the rock
(<https://www.halopedia.org/CE:The_Silent_Cartographer>); the only sourced statement about inspiration is
that the art director cited the "amazing beauty" of the **Pacific Northwest**
(<https://en.wikipedia.org/wiki/The_Silent_Cartographer>) — which is a temperate, forested, basaltic /
sedimentary coast, not a carbonate one. **So "tropical carbonate" is a reading of the imagery, not a
documented intent. Flagging that explicitly.** The geology below is what a real island of that
description looks like; whether it matches the shipped art is a call for whoever holds the reference
frames.

### The composite profile, bottom to top

```
 -8 … -2 m   fringing reef / reef flat: near-horizontal, coral rubble, sand patches
 -2 … -0.5   SHORE PLATFORM, sub-horizontal, with a sharp seaward slope break
 -0.5 … -0.2 biological rim: knobbly pale ledge, up to 25 cm thick, at the notch floor
 -0.2 … +0.3 TIDAL NOTCH: 0.45–0.8 m tall, cut 1–3 m into the rock. Smooth, shadowed,
             often with a straight roof following a bedding plane.
 +0.3 … +1.5 VISOR / BROW: overhangs the notch. Rock projects OUTWARD with height.
             Surface here is the roughest on the whole stack (13–15 mm RMS at 15 cm gauge).
 +1.5 … +4   Splash / supratidal: BLACK cyanobacterial staining, tafoni and honeycombing
             (cells 2–5 cm), salt weathering, case-hardened rind with spall scars.
 +4 … +top   Karst above the splash zone: sharp needles, blades and flutes (karren);
             pale grey-white weathered limestone where not blackened; near-vertical
             joint-bounded walls; ledges at bedding contacts.
 top         Crown: often BROADER than the waist. Densely vegetated — dark green
             scrub/palms growing right to the cliff edge and overhanging it.
```

### Diagnostic features specific to this setting

1. **The vegetated crown overhangs the rock.** On tropical karst islands the forest grows to the very
   edge and the canopy projects *beyond* the cliff line. This adds a **second** outward flare above the
   visor: rock waist → rock flare → green overhang. Almost never modelled, very characteristic.
   ("rugged, densely vegetated high limestone islands" —
   <https://www.livingoceansfoundation.org/palaus-iconic-rock-islands/>)

2. **The undercut is much deeper than in temperate settings** because dissolution + bioerosion +
   grazing all operate. Palau: **2–3 m** horizontal at lowest spring tide. Combined with a small tropical
   tidal range, this makes the depth:height ratio of the notch **large** — a thin, deep, dark slot. From
   30–50 m, the notch reads as a **continuous black line at the waterline** wrapping every island.
   That line is arguably the single most recognisable feature of the whole landform class.

3. **Multiple islands share the notch and the bands at the same elevation.** They were all cut by the
   same sea. Correlated elevations across objects = "one coast"; uncorrelated = "asset scatter".

4. **Arches and collapse are everywhere, not exceptional.** "Natural Archways and spiraling vertical
   cliffs" from collapsing limestone are routine features
   (<https://paddlingpalau.net/geology.html>). Populate ~1 arch per 5–10 stacks and leave the residue of
   collapsed ones.

5. **Sand is bioclastic and blindingly white**, produced by reef organisms — parrotfish alone are cited
   at "up to one ton of beach sand per parrotfish per year" (ibid.). It abuts the dark rock with almost
   no transitional tone. The beach/rock contact is a **hard, high-contrast edge**.

6. **Where volcanic basement is exposed** (typically at the base, in gullies, or on one flank), it is
   **darker, more massive, columnar-jointed at 0.4–1.2 m**, weathers to **red-brown**, forms **blockier
   talus**, and shows **no karren and no deep smooth notch** — instead a plucked, irregular, stepped
   undercut following flow-unit contacts. A lithological boundary between the two is a strong horizontal
   line with a **texture and colour change on both sides**, and it will be at a *different* elevation from
   the tidal bands. Two horizontal line families at different elevations, one lithological and one
   biological, is a very cheap way to look real.

7. **Scale calibration.** Tropical stacks of this type are **10–50 m** tall with base diameters of
   **4–20 m**, i.e. **height:base-diameter of 2:1 to 6:1** (Ko Tapu is 5:1). The Twelve Apostles reach
   **45 m** on a similar footprint. A stack much squatter than 2:1 reads as an islet, not a stack.

---

## Consolidated parameter table for the generator

| Parameter | Value | Source |
|---|---|---|
| Stack height H | 10–50 m (tropical carbonate) | Ko Tapu 20 m; Twelve Apostles 45 m |
| Height : base diameter | 2:1 to 6:1 | Ko Tapu 5:1 |
| Radius top ÷ radius at waterline | **0.8 to 2.0** (must be able to exceed 1.0) | Ko Tapu 8 m / 4 m = 2.0 |
| Notch vertical extent | 0.45–0.80 m; **> full tidal range, always**; = 0.3–3.2 × tidal range | Antonioli 2015; Rovere 2017 |
| Notch horizontal depth, temperate carbonate | 0.4–1.0 m | Antonioli 2015 |
| Notch horizontal depth, tropical carbonate | **1–3 m** | Palau; Trenhaile 2015 |
| Notch depth, exposed vs sheltered on ONE stack | **0.65 m → 2.5 m (×3.8)** | Abensperg-Traun 1990 |
| Notch depth ÷ stack radius | 0.15–0.45 (up to 0.6 on soft rock) | derived from above |
| Notch apex elevation | MSL + 0.1…0.2 m typical; **+0.6 m windward, −0.5 m leeward** | Abensperg-Traun 1990 |
| Notch cross-section, massive limestone | tall, open, strong visor, curved roof | Antonioli 2015 Fig 6a |
| Notch cross-section, bedded/weak rock | **short, deep, rectangular slot**, flat roof & floor on bedding | Antonioli 2015 §4.2 |
| Visor crest elevation | 1.3–2.1 m above datum; tilted plane, 0.8 m relief across the stack | Abensperg-Traun 1990 |
| Bio rim ledge at notch floor | up to 0.25 m thick, pale, knobbly | Antonioli 2015 |
| Joint spacing | lognormal, median 0.3–1.2 × bed thickness (mode ~1.0–1.3) | Bai & Pollard 2000 |
| Joint sets | 2 orthogonal + 1 weak; shared azimuth across all stacks, ±10° jitter | Havre-Saint-Pierre study |
| Basalt column diameter | 0.4–1.2 m (up to 2.4 m); 55 % hexagonal | NPS |
| Surface roughness RMS (15 cm gauge) | 3–6 mm baseline; **13–15 mm** in a 0.8 m band at upper intertidal; rises again at spray-wetted visor | Abensperg-Traun 1990 Table 1 |
| Honeycomb cell size | 2–5 cm (<2 cm for "alveolar") | Wikipedia / Grokipedia |
| Tafoni size | <1 cm to >1 m | Wikipedia |
| Black splash band height above MHWS | 0.5–1.5 m sheltered; 3–15 m exposed ("tens of m" extreme) | EUNIS 30004 |
| Band elevation sweep with aspect | rises windward by the same E term as splash | derived; consistent with notch data |
| Talus surface angle | 32–35° main cone (range 29–43°) | NHESS 2021; Carson 1977 |
| Block axial ratio (median) | 1.7–2.6 | NHESS 2021 |
| Block volume distribution | Pareto, **β = 0.5 ± 0.2**, V ∈ [0.01, 30] m³ | Dussauge-Peisser 2002 |
| Dense talus extent | H / tan 35° ≈ **1.43 H** | Copons 2009 |
| Outlier boulder extent | H / tan 27° ≈ **1.96 H**; extreme H / tan 22° ≈ 2.5 H | Copons 2009 |
| Talus asymmetry | cleared on weather side; preserved to waterline on lee side | Abensperg-Traun 1990 |
| Notch-forming erosion rate | 0.02–2.1 mm/yr carbonate; ~2 cm/yr high-energy soft limestone | Antonioli 2015; Twelve Apostles |
| UCS, massive limestone / calcarenite | 227 MPa / 28–36 MPa | Antonioli 2015 Table 3 |

---

## What I could NOT verify — read this before building on anything above

1. **Trenhaile (2015), the definitive notch review, was paywalled to me (HTTP 403).** Everything
   attributed to it here comes from abstract/snippet text, not the full paper. If one source is worth
   obtaining properly, it is that one:
   doi 10.1016/j.earscirev.2015.08.003.

2. **Basalt notch geometry is my weakest section.** I found no study giving basalt notch depth:height
   ratios or basalt notch profiles. The claims about stepped, joint-plucked notches on volcanic coasts
   are inferences from the mechanism (no dissolution, no significant bioerosion, cooling-joint control)
   plus the Hōlei Sea Arch differential-erosion description — **not** measured geometry. Do not quote
   numbers for basalt notches; there are none here.

3. **Coastal karren dimensions: no verified numbers.** Both open-access routes to Gómez-Pujol & Fornós
   were blocked (an Anubis bot-wall and a 403). I have the four-zone conceptual finding but no
   rillenkarren widths, flute spacings or solution-pan diameters. I deliberately left those blank rather
   than supply plausible-sounding figures.

4. **Case-hardened rind thickness: no verified number.** The mechanism and visual signature are well
   attested; the thickness is not, in anything I could read.

5. **Bed thickness range (0.2–2 m for shallow-marine carbonates and lava units)** is my own
   generalisation, not a figure I found stated in a citable source. The *joint-spacing-to-bed-thickness
   ratio* (0.3–1.2) IS properly sourced; the absolute bed thickness is not.

6. **Palau specifics** are thinly sourced. The "notches extend approximately 2–3 m horizontally" figure
   comes from a figure caption surfaced via ResearchGate, not from a paper I read. A claim of
   "0.5–6 m overhang height" appeared only on a low-quality content-aggregator site and I have
   **excluded it** from the tables above. Palau's tidal range I did not confirm at all.

7. **Tropical rocky-shore band heights in metres.** I found no study giving numeric vertical extents for
   Indo-Pacific black / littorinid / barnacle bands. The parameterisation in §(d) is *constructed* from
   the tidal-range scaling plus the EUNIS splash-zone statement. It is reasonable; it is not measured.

8. **Silent Cartographer's art intent.** No sourced statement that the level's rock is carbonate. The one
   sourced inspiration claim is "Pacific Northwest", which cuts the other way. The carbonate reading is
   an interpretation of the imagery.

---

## Sources

- Antonioli, F. et al. (2015) *Tidal notches in Mediterranean Sea: a comprehensive analysis*, Quaternary Science Reviews 119, 66–84. [post-print PDF](https://arts.units.it/retrieve/handle/11368/2845156/415396/2845156_Tidal%20notches%20in%20Mediterranean%20Sea%20a%20comprehensive%20analysis.%20Part%201-PostPrint.pdf) · [publisher](https://www.sciencedirect.com/science/article/abs/pii/S0277379115001237)
- Abensperg-Traun, M., Wheaton, G.A. & Eliot, I.G. (1990) *Bioerosion, notch formation and micromorphology in the intertidal and supratidal zones of a calcareous sandstone stack*, J. Roy. Soc. Western Australia 73(2), 47–56. [PDF](https://ia801503.us.archive.org/18/items/biostor-256746/biostor-256746.pdf)
- Rovere, A. et al. (2017) *Tides in the Last Interglacial: insights from notch geometry and palaeo tidal models in Bonaire*, Sci. Rep. 7. [Nature](https://www.nature.com/articles/s41598-017-16285-6) · [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC5701235/)
- Trenhaile, A.S. (2015) *Coastal notches: their morphology, formation, and function*, Earth-Sci. Rev. 150, 285–304. [abstract](https://www.sciencedirect.com/science/article/abs/pii/S0012825215300271)
- Schneiderwind, S. et al. (2017) *Numerical modeling of tidal notch sequences on rocky coasts of the Mediterranean Basin*, JGR Earth Surface. [link](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2016JF004132) (403 to me)
- Georgiou, N. et al. (2024) *Decoding the interplay between tidal notch geometry and sea-level variability during MIS 5e*, GRL. [link](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2023GL106829)
- Bai, T. & Pollard, D.D. (2000) *Fracture spacing in layered rocks: a new explanation based on the stress transition*, J. Struct. Geol. [link](https://www.sciencedirect.com/science/article/pii/S0191814199001376)
- Narr, W. & Suppe, J. (1991) *Joint spacing in sedimentary rocks* / Ladeira & Price (1981) *Relationship between fracture spacing and bed thickness*. [link](https://www.sciencedirect.com/science/article/abs/pii/0191814181900134)
- Ji, S. et al. (2021) *Power-law relationship between joint spacing and bed thickness in sedimentary rocks*, J. Struct. Geol. [link](https://www.sciencedirect.com/science/article/abs/pii/S0191814121001371)
- *The formation of orthogonal joint systems and cuboidal blocks… Havre-Saint-Pierre, Quebec* (2023). [link](https://www.sciencedirect.com/science/article/pii/S1674775523001154)
- Copons, R. et al. (2009) *Rockfall travel distance analysis by using empirical models*, NHESS 9, 2107–2118. [PDF](https://nhess.copernicus.org/articles/9/2107/2009/nhess-9-2107-2009.pdf)
- *Assessing the effect of lithological setting, block characteristics and slope topography on the runout length of rockfalls* (2021), NHESS 21, 1159. [link](https://nhess.copernicus.org/articles/21/1159/2021/)
- Dussauge-Peisser, C. et al. (2002) *Statistical analysis of rockfall volume distributions*, JGR. [link](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2001JB000650)
- *Power law models for rockfall frequency–magnitude distributions*, Geomorphology (2022). [link](https://www.sciencedirect.com/science/article/abs/pii/S0169555X22003567)
- Carson, M.A. (1977) *Angles of repose, angles of shearing resistance and angles of talus slopes*, ESPL. [link](https://onlinelibrary.wiley.com/doi/abs/10.1002/esp.3290020408)
- NPS, *Columnar Jointing*. [link](https://www.nps.gov/subjects/volcanoes/columnar-jointing.htm)
- NPS, *Hōlei Sea Arch*. [link](https://www.nps.gov/places/holei-sea-arch.htm)
- EUNIS habitat 30004, *Lichens or small green algae on Atlantic supralittoral and littoral fringe rock*. [link](https://eunis.eea.europa.eu/habitats/30004)
- MarLIN, *Hydropunctaria maura on littoral fringe rock*. [link](https://www.marlin.ac.uk/habitats/detail/120/verrucaria_maura_on_littoral_fringe_rock)
- Golubic, S., *Marine cyanobacteria*, Boston University. [link](https://people.bu.edu/golubic/marine-cyano.html)
- *Microbial assemblages in tropical coastal bioerosion*. [link](https://www.researchgate.net/publication/239926476)
- Gómez-Pujol, L. & Fornós, J.J., *Coastal karren in temperate microtidal settings*. [link](https://digitalcommons.usf.edu/geologia/vol55/iss1/art5/)
- Trenhaile, A.S. (2016) *Rocky coast processes: with special reference to the recession of soft rock cliffs*. [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC4754505/)
- Wikipedia: [Stack (geology)](https://en.wikipedia.org/wiki/Stack_(geology)) · [Ko Tapu](https://en.wikipedia.org/wiki/Ko_Tapu) · [Rock Islands](https://en.wikipedia.org/wiki/Rock_Islands) · [Tafoni](https://en.wikipedia.org/wiki/Tafoni) · [Honeycomb weathering](https://en.wikipedia.org/wiki/Honeycomb_weathering) · [The Silent Cartographer](https://en.wikipedia.org/wiki/The_Silent_Cartographer)
- Living Oceans Foundation, *Palau's Iconic Rock Islands*. [link](https://www.livingoceansfoundation.org/palaus-iconic-rock-islands/)
- Paddling Palau, *Geology*. [link](https://paddlingpalau.net/geology.html)
- Visit James Bond Island, *Geology*. [link](https://visitjamesbondisland.com/geology.html)
- Ecosphere (2020), *Interhemispheric comparison of scale-dependent spatial variation*. [link](https://esajournals.onlinelibrary.wiley.com/doi/full/10.1002/ecs2.3068)
