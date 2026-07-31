# Why procedural rock and terrain read as "CG" — the tells, and the published fixes

**Key:** `cgtells` · Research input for the Halo: Campaign Evolved rebuild (Three.js r0.185.1 / WebGL2 / GLSL ES 3.00)

---

## 0. The one-paragraph thesis, in the words of the person who invented most of this

Musgrave — author of the fBm/multifractal terrain models nearly every procedural generator still uses — wrote the following about his own models:

> "people often say these terrain models 'look so real,' yet they actually bear little resemblance to the true form of terrains in Nature which are both more complex and utterly different in their character, being dominated by **context-sensitive erosion features not captured by fBm-based fractal models**."
> — *Procedural Fractal Terrains*, §2.8 Conclusions ([classes.cs.uchicago.edu PDF, p. 2-16](https://www.classes.cs.uchicago.edu/archive/2015/fall/23700-1/final-project/MusgraveTerrain00.pdf))

and, on the isotropy/homogeneity problem:

> "synthetic fractal mountains constructed with a single, uniform fractal dimension everywhere have the same roughness everywhere. **Real mountains are never like that.**"
> — *ibid.*, §2.4 (p. 2-6)

That is the whole report. Everything below is (i) how to *see* those two failures in a screenshot, (ii) how to measure them numerically so you can score yourself against reference frames, and (iii) the published constructions that fix each one, with numbers.

**The single highest-leverage idea in this document** is in §1.3 and §4.4: nature has a **spectral bump at a characteristic length** (joint spacing ≈ bed thickness), procedural fBm has a **monotone power law**. Almost every "CG rock" tell is downstream of that one mismatch. If you change nothing else, boost the octave whose wavelength equals your joint spacing by 2–4× and add plane cuts at that spacing.

---

## 1. (a) The catalogue of tells

Each tell below is written as: **what it is** → **what it looks like in a frame** → **how to measure it** → **§ where the fix lives**.

### 1.1 Smooth, monotonic, convex silhouette

**What it is.** Displacing a sphere/ellipsoid/heightfield by fBm produces an outline whose curvature almost never goes negative at a scale larger than the noise's highest octave. You get a lump with wobbles, not a rock.

**Why this is the dominant tell.** Silhouette carries most of shape recognition. Attneave (1954) showed that manually picking *extrema of curvature* along a contour and joining them with straight lines yields figures humans recognise essentially as easily as the originals. Hoffman & Richards, *Parts of recognition*, Cognition 1984, formalised this as the **minima rule**: the visual system segments a shape into parts at **negative minima of curvature**, because transversal intersection of two solid volumes necessarily creates a concave crease there. Experimental test (Braunstein/Hoffman/Saidpour, 1989, [PubMed 2628932](https://pubmed.ncbi.nlm.nih.gov/2628932/)) found subjects picked minima-parts over maxima-parts 101 vs 55. Eye-tracking during 3-D object recognition shows preferential fixation of **concave** surface-curvature minima ([JOV](https://jov.arvojournals.org/article.aspx?articleid=2192169)); concavities behave as a basic feature in visual search ([Psychonomic Bull. & Rev.](https://link.springer.com/article/10.3758/BF03212069)).

Consequence for you: **a silhouette with no negative-curvature minima has no parts. It reads as one undifferentiated blob** — i.e. "a CG rock". Shading fixes cannot recover this; the information was never in the geometry.

**In a frame.** Trace the outline of one of your boulders against sky. If you can walk the whole contour without the tangent ever reversing its turn direction at a scale bigger than a few pixels, you have the tell. Real rock outlines are: straight runs (planar joint faces), sharp convex corners (joint intersections), and **concave bites** (spalls, undercuts, notches where a block fell out).

**Measure it.** Render an object mask, extract the contour, resample to constant arclength, smooth at a scale of ~1/40 of the perimeter, and count **sign changes of discrete curvature per unit perimeter**, plus the count of *deep* negative-curvature minima (κ below −2/R̄, where R̄ = perimeter/2π). Compare the same statistic on a reference frame's rock. My prediction, stated as a hypothesis you should test rather than a citation: procedural-fBm rock will show 0–2 deep concavities per silhouette; real jointed rock will show 4–12. **I could not find a published measurement of this statistic on game/photographic rock silhouettes — treat the specific numbers as a starting hypothesis, not a fact.**

→ Fix: **§3** (plane cuts, Voronoi spalling, boolean subtraction).

### 1.2 Isotropic noise where nature is anisotropic

**What it is.** fBm is by construction statistically homogeneous *and* isotropic (Musgrave §2.4, cited above). Rock is neither. Sedimentary rock has **bedding**; almost all rock has **joint sets**; volcanic rock has **flow banding** and **columnar jointing**.

**The geology, with numbers** (ETH Zürich structural geology course notes, *Joints*, jpb 2020, [PDF](https://www.files.ethz.ch/structuralgeology/JPB/files/English/4joints.pdf), pp. 133–142):

- Joints form **sets** — "families of straight to curviplanar fractures typically perpendicular to the layer boundaries". Two or more sets = a **joint system**, intersecting at **constant dihedral angles**: **conjugate for dihedral angles 30°–60°, orthogonal when the dihedral angle is nearly 90°** (p. 133).
- **Systematic joints**: "roughly planar geometry; relatively long traces; sets of approximately parallel and almost equally spaced joints."
  **Non-systematic joints**: "short, curved and irregularly spaced. They generally terminate against systematic joints." (p. 133)
  → *This is a two-population model, and it is exactly what a single fBm cannot produce.*
- **Spacing distribution**: in isotropic rocks (e.g. granite) joint spacing follows an approximately **log-normal** frequency distribution (p. 134).
- **Spacing vs bed thickness**: `D = αT` — average joint spacing D is **linear in bed thickness T**, valid for beds **< 1.5 m**; above that the curve flattens (`d²D/dT² < 0`). Data from Ladeira & Price 1981, *J. Struct. Geol.* 3(2) 179–183, reproduced on p. 134 as fracture separation (0–100 cm) vs bed thickness (0–600 cm) for greywacke and limestone.
- Independent measurements of the ratio D/T from the sedimentology literature: **critical fracture-spacing-to-layer-thickness ratio 0.8–1.2**; across 16 localities, ratios **0.17 to 1.82, mean 1.04, median 0.99, s.d. 0.51**. (From abstracts of [J. Struct. Geol. 2021 power-law study](https://www.sciencedirect.com/science/article/abs/pii/S0191814121001371) and related papers found via [Cambridge Geol. Mag.](https://www.cambridge.org/core/journals/geological-magazine/article/abs/relationship-between-joint-spacing-and-bed-thickness-in-sedimentary-rocks-effects-of-interbed-slip/A9CE9E6F07EB49510DC9EBFC024A23A3). **Caveat: I read abstracts, not full texts, for these particular numbers.** The ETH notes independently confirm the linear D=αT relation, so the *form* is solid; take D/T ≈ 1.0 ± 0.5 as the working prior.)
- Incompetent interlayer thickness has a **critical value ≈ 5 cm**: fractures are more widely spaced where interlayers are thicker than 5 cm, more closely spaced where thinner (p. 135).
- **Master joints**: dimensions "tens of centimetres to hundreds of metres" with repeat distances "several centimetres to tens of metres" (p. 136).
- **Abutting**: younger joints curve to meet older joints at right angles and terminate — "the pattern of dilatant joints is commonly **T-shaped**" (p. 136, 141). Younger joints are consequently **shorter**.
- **Joint-surface ornament** (sub-decimetre, matters for normal maps): plumose hackles diverge at **~30°** from the plume axis near the origin, "gradually curving to angles of about **70°** near the margins"; fringe faces are oblique to the main joint at **5°–25°**, *en échelon* (pp. 137–139).
- Joint patterns come in five arrangements: parallel sets; fan sets along fold/intrusion crests; radial sets around intrusion centres; concentric sets (cone/ring/cylindrical); **polygonal sets as columnar or prismatic** (p. 136).

**In a frame.** Real cliff faces show *aligned* linear features: parallel ledges, parallel shadow lines, blocks whose long axes share an orientation. If you draw a rose diagram of edge orientations in a crop of your render and it is flat, you have the tell. Real outcrop gives 2–3 pronounced lobes, typically ~90° apart or ~30–60° apart.

**Measure it.** Sobel the luminance, histogram gradient orientation weighted by magnitude, over an 8°-binned rose diagram. Compute the circular variance / anisotropy index (largest eigenvalue ratio of the structure tensor, `(λ1−λ2)/(λ1+λ2)`). Isotropic fBm → near 0. Bedded rock → 0.3–0.7.

→ Fix: **§4**.

### 1.3 The missing mid band ("noise at two scales but nothing between")

**What it actually is — and it is not bandwidth, it is amplitude.** Most pipelines *do* cover the middle frequencies; they just cover them at negligible amplitude. In standard fBm the octave amplitude decays as `a_i = G^i` with `G = exp2(-H)` ([iquilezles.org/articles/fbm](https://iquilezles.org/articles/fbm/), verified). With the near-universal `G = 0.5`, an octave five doublings below the base contributes `0.5^5 ≈ 3%` of the base amplitude. On a 3 m boulder, the 10 cm band is a 3% ripple — invisible in silhouette, invisible in shading.

Nature does not do that. Nature has a **characteristic length** — joint spacing ≈ bed thickness (§1.2) — and material is removed in **whole blocks at that length**. That is a *bump* in the height spectrum, not a continuation of a power law. A single fallen block leaves a step of 30 cm on a cliff whose overall relief is 20 m: amplitude ratio 1.5% of relief but *sharp-edged and locally 100% contrast*, at a spatial frequency 60× the base. fBm at gain 0.5 will never place that.

Musgrave's own multifractals are the first-generation fix for exactly this: they make the amplitude of high frequencies depend on the local value of low frequencies, so roughness is *not* uniform (§2.4–2.5 of his notes, and see §5.1 below for the code).

**In a frame.** Squint at a screenshot, or blur it to 1/8 resolution. Real rock still has structure at 1/8 res — ledges, block boundaries, shadow bands. fBm rock goes to a smooth grey lump immediately, because everything above the base octave is 3% amplitude.

**Measure it.** Build a Laplacian pyramid of the *depth buffer* (not the beauty pass — you want geometry, not albedo) and plot RMS per level, log–log. Do the same for a reference frame's depth (or its luminance, if you only have footage). A clean straight line with slope ≈ −H is the tell. Real terrain/rock shows a **break of slope** and usually a local excess around the joint/bed spacing.

→ Fix: **§4.4** (boost the joint-spacing octave), **§3** (block removal puts real energy there), **§5.1** (multifractals).

### 1.4 No evidence of process

**What it is.** Every visible feature on real rock is the *record of an event*: water ran here, a block fell out there, this face was polished by ice, that hollow holds dust so lichen grows in it. Procedural noise records nothing. There is no causal chain, and the eye — even an untrained one — reads the absence.

**Concrete process evidence to look for and to add.** (Sources: Dorsey et al., *Modeling and Rendering of Weathered Stone*, SIGGRAPH '99, [project page](http://graphics.ucsd.edu/~henrik/papers/sig99/) — moisture flow, mineral transport, dissolution and recrystallisation in a surface-aligned *slab* volume, governing erosion of material from the surface; and Chen et al., *Visual simulation of weathering by γ-ton tracing*, ACM TOG 24(3):1127–1133, 2005, [PDF](https://ttwong12.github.io/papers/gammaton/gammaton.pdf) — aging particles traced like photons, producing dirt, rust, cracks and scratches **including large-scale geometry change**, not just texture change.)

| Process | Visual signature | Where it lands |
|---|---|---|
| Rainwash | Vertical streaks, darker, 2–20 cm wide, *starting at an overhang edge and widening downward* | Below convex breaks in slope; **stops** where the face undercuts |
| Dust/silt deposition | Light, matte, lower roughness contrast | Upward-facing surfaces with N·up > ~0.7 **and** high concavity |
| Lichen / algae | Patchy, hard-edged colonies with fractal margins | Concave + shaded + non-scoured; near-zero on freshly spalled faces |
| Case hardening / rind | Bright, harder outer shell over a softer core; hollow *tafoni* pits behind it | Where a rind is breached — sharp-edged holes with intact lips |
| Edge wear | Rounded convex edges, sharper concave ones | Convex curvature maxima only |
| Water polish | Low roughness, high specular | Channel floors — **flow accumulation**, not slope |
| Frost shattering | Angular chips, no rounding, size ≈ joint spacing | Everywhere above the frost line; talus at the base |

**In a frame.** The dead giveaway is *stain that does not obey gravity*: a dirt mask that is uniform noise sits on undersides and overhangs as happily as it sits under a ledge. Real staining is directional and has an upstream source.

→ Fix: **§5**.

### 1.5 Uniform statistics across a surface where nature is patchy

**What it is.** One noise, one amplitude, one roughness, everywhere. Nature is patchy at every scale: one lithology weathers, its neighbour does not; one face is sun-baked, its opposite is mossy.

Jákó & Tóth make this explicit as a modelling decision: they carry a per-cell **hardness coefficient R(x,y) ∈ [0,1]** built by "copying and scaling the terrain heightfield, adding some random noise to every cell, and applying a global Gaussian filter" — so higher terrain is harder, and consistency varies from place to place. "The surface will be more irregular, similarly to real-world terrains where the material inhomogeneity influences the erosion" (*Fast Hydraulic and Thermal Erosion on the GPU*, CESCG 2011, §4, [PDF](https://old.cescg.org/CESCG-2011/papers/TUBudapest-Jako-Balazs.pdf)).

**Measure it.** Take your dirt/wear mask and histogram it. If it is a unimodal bump centred at 0.3–0.5, it is noise. Real coverage masks are **bimodal**: large areas at ~0 and distinct patches at ~1, with a small transition population. Target something like 55–70% of texels below 0.1 and 15–30% above 0.8. (Numbers are my recommendation from the qualitative literature, not a measured statistic — flagged.)

→ Fix: **§5.5** (mask composition rules).

### 1.6 Scatter with one size mode and even spacing

**What it is.** Blue-noise / Poisson-disc scattering of one or three prop meshes at one scale. Both halves are wrong.

- **Even spacing is wrong at large scales.** Real natural point patterns show "**small-scale regularity and large-scale clustering**" — Dixon, *Ripley's K function*, in *Encyclopedia of Environmetrics*, Wiley 2002, [PDF](https://academicweb.nd.edu/~mhaenggi/ee87021/Dixon-K-Function.pdf), p. 6: "Patterns with small-scale regularity and large-scale clustering are quite common for ecological processes, especially when individuals are large." Poisson-disc gives you *only* the regularity.
- **One size mode is wrong.** Clast populations are heavy-tailed power laws (§6.2).

**Measure it.** Nearest-neighbour distance CV. For a homogeneous 2-D Poisson process of intensity λ, NN distance is Rayleigh: mean `1/(2√λ)`, and **CV = √(4/π − 1) = 0.5227** (derivable in two lines; I derived it rather than citing it). Poisson-disc/blue noise gives CV ≈ 0.15–0.30. Clustered natural patterns give CV > 0.6. Equivalently use the Clark–Evans index `R = mean_NN_observed × 2√λ`: R = 1 random, R < 1 clustered, R > 1 regular, **maximum R = 2.1491 for a perfect hexagonal lattice** (also derived: hex NN distance = `√(2/(√3 λ))` = 1.0746/√λ).

→ Fix: **§6**.

### 1.7 Six smaller tells worth a line each

1. **Uniform rotation about all three axes.** Real clasts rest on a stable face. Rotation should be ~uniform about the surface normal, with tilt drawn from a narrow distribution about the local slope (see §6.4).
2. **Zero burial.** Objects sitting exactly *on* the ground plane with a hard contact line. Real clasts are partly buried and have a debris apron.
3. **No contact occlusion.** Missing the dark ring where a rock meets soil.
4. **Silhouette all convex at the base.** Real boulders undercut — the widest point is often above the ground line.
5. **Repeating detail at a fixed tile period.** Especially visible on cliff faces; needs domain warping or hash-based per-cell offsets.
6. **Detail amplitude independent of scale.** A 30 cm rock and a 30 m cliff carrying the same normal-map wavelength. Real surface roughness has a *characteristic* physical wavelength (grain size, joint spacing) that does **not** scale with object size.

---

## 2. Why the silhouette carries most of the recognition (and what follows for the budget)

Restating §1.1 as an engineering decision:

- Attneave 1954 / Hoffman & Richards 1984 (cited above): recognition is dominated by **curvature extrema on the contour**, and part decomposition happens at **negative minima of curvature**.
- Therefore, *geometry* that changes the contour is worth far more than *shading* that does not. A 0.3 m concave notch on the outline of a 3 m rock is worth more than any amount of normal-map detail.
- Therefore, spend your polygon budget **anisotropically**: the tessellation that matters is the tessellation on the *rim*. This argues for baking a small number of high-quality rock meshes offline (with real concavities) and instancing them, rather than displacing a uniform sphere on the GPU.

Practical corollary for WebGL2: you cannot afford per-frame CSG or erosion. Do **all** silhouette work offline (Node script → glTF), and keep only the cheap masks (§5) at runtime.

---

## 3. (b) Silhouette-first techniques — getting non-monotonic profiles procedurally

Ranked by (silhouette payoff) / (implementation cost) for a WebGL2 scene with an offline bake step.

### 3.1 Half-space cutting by joint planes — **best value, do this first**

Model the rock as an SDF, subtract half-spaces sampled from 2–3 joint sets. This alone converts a lump into a blocky clast with straight silhouette runs and sharp corners.

**Sampling the planes, grounded in §1.2:**
- **Number of sets:** 2 or 3 (ETH notes: "two or more sets … compose a joint system"). For Halo's blocky cliffs, use 3: one bedding-parallel set (normal ≈ up, since joints are "typically perpendicular to the layer boundaries", so the *bedding* planes themselves are horizontal-ish) and 2 sub-vertical sets.
- **Dihedral angle between the two sub-vertical sets:** draw from {orthogonal ≈ 85–95°} with p ≈ 0.5, or {conjugate 30–60°} with p ≈ 0.5.
- **Scatter within a set:** normals perturbed by ~5–12° (1σ). Systematic joints are "approximately parallel"; a von Mises–Fisher with κ ≈ 60–200 gives roughly this. (κ choice is mine; the ≤~10° figure is an inference from "approximately parallel", not a published measurement — flagged.)
- **Spacing along each set:** log-normal (ETH p. 134), with median = bed thickness T (D/T ≈ 1.0, §1.2) and σ_log ≈ 0.45 (matches the reported s.d. 0.51 on a mean of 1.04). For a Halo cliff with T = 0.8 m you get joint spacings mostly in 0.35–1.9 m.
- **Two populations:** 60–75% systematic (long, planar, full-height cuts) + 25–40% non-systematic (short, curved, *terminating against* a systematic cut — implement as a half-space intersected with a slab bounded by two systematic planes). This is the ETH systematic/non-systematic split and it is what makes the result look *observed* rather than *generated*.
- **T-junctions:** never let two non-systematic cuts cross. Enforce abutting: sort cuts by "age", and clip each younger cut to the region bounded by older ones.

```glsl
// GLSL ES 3.00 — Three r0.185.1 injects the #version line itself.
// Half-space cut. n must be normalised; d is the signed offset from origin.
float opPlaneCut(float sd, vec3 p, vec3 n, float d) {
    return max(sd, dot(p, n) - d);          // exact for planes; max() is the CSG intersection
}
// Slightly rounded joint edge (real joint intersections are not razor-sharp):
float opPlaneCutSoft(float sd, vec3 p, vec3 n, float d, float k) {
    // -opSmoothUnion(-a,-b,k) == opSmoothIntersection, per iquilezles.org/articles/distfunctions
    float b = dot(p, n) - d;
    float kk = k * 4.0;
    float h = max(kk - abs(sd + b), 0.0);   // note sign flip for the intersection form
    return -( min(-sd, -b) - h*h*0.25/kk );
}
```
`opUnion = min`, `opSubtraction = max(-a,b)`, `opIntersection = max(a,b)`; the smooth variants and the warning that subtraction/intersection/smooth-variants "do not produce true SDFs" and are only *bounds* are from [iquilezles.org/articles/distfunctions](https://iquilezles.org/articles/distfunctions/) (verified). `k` in the smooth-min family is **blend thickness in distance units**; IQ recommends the quadratic polynomial form because it is "fast, close enough to circular, never overestimates" ([iquilezles.org/articles/smin](https://iquilezles.org/articles/smin/), verified).

Canonical quadratic smin, for reference:
```glsl
float smin(float a, float b, float k) {   // k = blend width, world units
    k *= 4.0;
    float h = max(k - abs(a-b), 0.0) / k;
    return min(a,b) - h*h*k*0.25;
}
```

**Edge rounding as a function of curvature sign, not uniformly.** Real weathering rounds *convex* edges and leaves *concave* ones sharp. In SDF terms: apply `opRound` (subtract a radius) only where the local mean curvature of the field is positive. Cheap approximation: `r = r0 * saturate(laplacian(sd))`, evaluated by 6-tap finite differences of the SDF.

### 3.2 Voronoi / cellular shattering — for spalls, flakes and rubble

**Two distinct uses.**

(a) **As a displacement basis.** Worley's cellular basis with the **F2−F1** metric is the production standard for blocky rock: "one of the best for blocky, cellular shapes" (SideFX/Houdini rock pipelines; see the [80.lv breakdown of a procedural rock generator](https://80.lv/articles/006sdf-breakdown-procedural-rock-generation-in-houdini) and [SideFX Rock Generator](https://www.sidefx.com/tutorials/rock-generator/)). F2−F1 is ~0 in cell interiors and rises to a ridge at cell boundaries — i.e. it produces *facets separated by creases*, which is precisely what fBm cannot do. Original source: Worley, *A Cellular Texture Basis Function*, SIGGRAPH '96.

Musgrave's own Bryce terrain models "Mordor" (Worley distance-squared basis) and "shattered hills" (Worley distance basis) are hybrid multifractals over a Voronoi basis, and the accompanying figures show visibly faceted, blocky relief that the Perlin-basis versions do not have (Musgrave notes pp. 2-9, 2-10, verified from the PDF).

(b) **As actual shattering.** Compute a 3-D Voronoi diagram over jittered seeds inside the rock's bounding volume, then *subtract* a small number (3–8) of whole cells that touch the surface. This is the "conchoidal spall" operator and it is the single most effective way to put deep negative-curvature minima on the silhouette (§1.1). Houdini pipelines do the mesh equivalent with **VDB fracture on the high-detail layers to "chip off the edges"** ([80.lv breakdown](https://80.lv/articles/006sdf-breakdown-procedural-rock-generation-in-houdini)).

**Continuous control between smooth and blocky.** IQ's *voronoise* gives you a two-parameter family: `u` jitters the feature-point grid (0 = regular grid, 1 = fully jittered), `v` blends between minimum-distance (Voronoi) and interpolated (value-noise) evaluation ([iquilezles.org/articles/voronoise](https://iquilezles.org/articles/voronoise/), verified):

```glsl
float voronoise(vec2 x, float u, float v) {
    vec2 p = floor(x), f = fract(x);
    float k = 1.0 + 63.0*pow(1.0-v, 4.0);
    float va = 0.0, wt = 0.0;
    for (int j=-2; j<=2; j++)
    for (int i=-2; i<=2; i++) {
        vec2 g = vec2(float(i), float(j));
        vec3 o = hash3(p+g) * vec3(u, u, 1.0);
        vec2 r = g - f + o.xy;
        float d = dot(r, r);
        float w = pow(1.0 - smoothstep(0.0, 1.414, sqrt(d)), k);
        va += w*o.z; wt += w;
    }
    return va/wt;
}
// u=0,v=0 cell noise · u=0,v=1 value noise · u=1,v=0 Voronoi · u=1,v=1 voronoise
```
For rock, run this at `u = 1.0, v ≈ 0.05–0.2` — nearly Voronoi, but without the grid artefacts of the hard minimum.

### 3.3 Thermal erosion / the slump filter — **cheapest possible win, ~20 lines**

Musgrave's diffusive-erosion filter converges the surface to a fixed angle of repose. Verbatim from his notes (p. 2-14, verified):

```
delta       = [difference of adjacent samples] / [sample spacing]
talus_moved = delta - talus_slope;
if (talus_moved > 0.0) talus_moved *= diffusion_coeff;
else                   talus_moved = 0.0;
```
"`talus_slope` is the derivative of the angle of repose … `diffusion_coeff` should be positive but much less than 1.0."

**Numbers.** Angle of repose for coarse angular debris: **30°–40°**, with dry homogeneous piles failing at **33°–37°**; talus slopes "stand at or close to the repose angle of the talus material, with values … around **35°**" ([Wiley, *Angles of repose, angles of shearing resistance and angles of talus slopes*, ESPL](https://onlinelibrary.wiley.com/doi/abs/10.1002/esp.3290020408); [UBC thesis, *Material-form relationships on talus slopes in SW British Columbia*](https://open.library.ubc.ca/media/download/pdf/831/1.0093774/2)). Note the caveat in that literature: **small-specimen laboratory tests give steeper, unrealistic repose angles** — use field values.

So: `talus_slope = tan(33°) = 0.6494` for coarse debris, `tan(35°) = 0.7002` typical talus, `tan(37°) = 0.7536` upper bound. Bedrock cliff faces are of course far steeper; the slump filter applies only to *loose* material, so gate it by a "regolith depth" channel.

`diffusion_coeff` ≈ 0.05–0.2, 50–500 iterations. Jákó & Tóth's equivalent thermal-erosion parameters (verified from their Table 2): thermal erosion rate `K_t = 0.15` (range 0–3), talus-angle tangent coefficient `K_a = 0.8` (range 0–1), talus-angle tangent bias `K_i = 0.1` (range 0–1) — i.e. their effective talus tangent is `R(x,y)·0.8 + 0.1`, giving tan ∈ [0.1, 0.9] → 5.7°–42° depending on local hardness R.

**Why it matters for the silhouette:** a slumped terrain has **planar faces at a constant angle** meeting at sharp ridges. Musgrave: "In such terrains, fractal character is evident in the distribution of the drainage channels and on small scales on the terrain surface. **The faces of the mountains, all at or near a given angle of repose, are not particularly fractal.**" (p. 2-14). That is a straight-line silhouette segment, which fBm alone will never give you.

### 3.4 Hydraulic erosion on a heightfield — full parameter table

Use the **virtual-pipes** shallow-water model (Mei, Decaudin & Hu, *Fast Hydraulic Erosion Simulation and Visualization on GPU*, Pacific Graphics 2007) as improved by **Jákó & Tóth, CESCG 2011** ([PDF](https://old.cescg.org/CESCG-2011/papers/TUBudapest-Jako-Balazs.pdf)). *I could not retrieve the Mei et al. original — every mirror I tried 404'd or was access-blocked — so all equations and numbers below are from Jákó & Tóth, who reimplement and extend it and print a full parameter table.*

Per cell: terrain height `b`, water height `d`, suspended sediment `s`, outflow flux `f = (fL,fR,fT,fB)`, velocity `v`.

Seven steps per iteration (their §2):
1. Water increment from rain: `d1 = d + Δt·r(x,y)·K_r` — **constant rain rate per cell**, not random raindrops ("This gives us more balanced and finer grained results in the long run").
2. Flow: `fL(t+Δt) = max(0, fL + Δt·A·g·Δh_L/l)`, then scale all four by `K = max(1, d1·lx·ly / ((fL+fR+fT+fB)·Δt))` so outflow never exceeds available water. `ΔV = Δt·(Σf_in − Σf_out)`, `d2 = d1 + ΔV/(lx·ly)`.
3. Thermal outflow (§3.3 above), run in virtual pipes so it parallelises.
4. Erosion/deposition. Sediment capacity, original form: `C = K_c · sin(α) · |v|`. **Their two important improvements:**
   - depth limiting `C = K_c · sin(α) · |v| · l_max(d1)` where `l_max` ramps 0→1 over water depth 0→`K_dmax`, "so the erosion will occur only in shallower areas … just like in real world". Without this the model "carves riverbeds unrealistically deep".
   - true 3-D collision: `C = K_c · (−N(x,y)·V) · |v| · l_max(d1)`, i.e. more erosion where flow hits the surface closer to perpendicular. "we observed some ripples on sea floors similar to sand ripples on real-world seashores."
   - if `s < C`: `b −= Δt·R·K_s·(C−s)`, `s += Δt·R·K_s·(C−s)`, `d += Δt·R·K_s·(C−s)` (the last term added for long-term stability; without it water disappears with the sediment and you get ripple artefacts).
   - if `s > C`: `b += Δt·K_d·(s−C)`, `s −= Δt·K_d·(s−C)`, `d −= Δt·K_d·(s−C)`.
5. Sediment softening: `R(t+Δt) = max(R_min, R − Δt·K_h·K_s·(C−s))` — "In nature, moving sediment becomes softer by the time."
6. Semi-Lagrangian sediment advection: `s(t+Δt) = s1(x − u·Δt, y − v·Δt)`, bilinear.
7. Evaporation: `d(t+Δt) = d3·(1 − K_e·Δt)`.

**Table 2 — allowed ranges and typical values (verbatim from the paper):**

| Symbol | Description | Range | Value |
|---|---|---|---|
| Δt | time increment | [0; 0.05] | **0.02** |
| K_r | rain rate | [0; 0.05] | **0.012** |
| K_e | water evaporation rate | [0; 0.05] | **0.015** |
| A | virtual pipe cross-section area | [0.1; 60] | **20** |
| g | gravity | [0.1; 20] | **9.81** |
| K_c | sediment capacity | [0.1; 3] | **1** |
| K_t | thermal erosion rate | [0; 3] | **0.15** |
| K_s | soil suspension rate | [0.1; 2] | **0.5** |
| K_d | sediment deposition rate | [0.1; 3] | **1** |
| K_h | sediment softening rate | [0; 10] | **5** |
| K_dmax | maximal erosion depth | [0; 40] | **10** |
| K_a | talus angle tangent coefficient | [0; 1] | **0.8** |
| K_i | talus angle tangent bias | [0; 1] | **0.1** |

**Cost (Table 1, ms/iteration):** 512×512 → 39.22 ms on an ATI HD3650, **3.835 ms on an HD4870**; 1024×1024 → 15.47 ms on the HD4870. Results shown after **1000 iterations**. So a 1024² erosion bake is **~15 s on 2009-era hardware** — trivially affordable as an offline Node/headless-GL step today, and *arguably affordable at load time in WebGL2* (1024², 1000 iterations, ping-pong FBO, MRT — well under a second on any modern GPU).

**Hardness field.** Use theirs (§1.5): `R = gaussian_blur(normalize(height) + noise)`, clamped to [0,1], `R_min` small. Higher and blurrier = harder.

**Musgrave's warning, which you should weigh.** He abandoned physical fluvial erosion: the PDEs "are particularly nasty, so the simulations must employ very small time steps to remain stable", the model has "on the order of 100 parameters", and "the literature of formal models of fluvial geomorphology generally does not even address deposition" (pp. 2-15). Also: the drainage network "is to human perception less important in achieving the impression of realism … 'Not enough bang for the buck!'" (Mandelbrot, quoted by Musgrave). **My read:** he was right in 1999 and wrong now — the Jákó/Tóth timings show the cost is gone — but his ranking of *perceptual* payoff still holds. Do §3.1 (plane cuts) and §3.3 (slump) before §3.4.

Corroboration from a modern practitioner: dandrino's [terrain-erosion-3-ways](https://github.com/dandrino/terrain-erosion-3-ways) states that fBm produces "fairly boring" terrain because "the fractal nature of fBm means everything more or less looks the same", and that features like stream networks, smooth valleys and ridge patterns "emerge from erosion processes rather than simple noise layering." He notes the simulation needs "around 10 constants" and that "small changes to any of these can produce completely different results."

### 3.5 Particle/droplet erosion

The other common family: drop N particles, each with position/velocity/water/sediment, walk downhill with inertia, erode/deposit in a radius. Popularised by Hans Theobald Beyer's bachelor thesis *Implementation of a method for hydraulic erosion* (TU München, 2015) and Sebastian Lague's implementation.

**I could not fetch the thesis** (the firespark.de host presents a self-signed certificate; the Wayback mirror is not reachable from this environment). **I am therefore not going to quote its parameter table**, because I would be reciting it from memory and you would build on it. What I can say safely:

- The method's shape is: `dir = lerp(dir_prev, -gradient, 1 - inertia)`; capacity `C = max(-Δh, minSlope) · speed · water · capacityFactor`; erode `min((C - sediment)·erodeSpeed, -Δh)` distributed over a disc of `erosionRadius` cells; deposit `(sediment - C)·depositSpeed`; `speed = sqrt(max(0, speed² + Δh·gravity))`; `water *= (1 - evaporateSpeed)`; kill after `maxLifetime` steps.
- Order-of-magnitude settings that are widely used and that I have seen work, **offered as defaults to tune, not as citations**: `inertia 0.02–0.3`, `capacityFactor 3–8`, `minSlope 0.01`, `erodeSpeed 0.3`, `depositSpeed 0.3`, `evaporateSpeed 0.01–0.05`, `gravity 4`, `erosionRadius 2–4 cells`, `maxLifetime 30–60`, `droplets ≈ 70–200 × cellcount/1000` (i.e. ~70k–200k droplets for a 1024²).

**Recommendation:** prefer the grid/virtual-pipes method (§3.4) for WebGL2 — it maps to ping-pong FBOs with MRT with no scatter-write, whereas droplets need atomics or a CPU pass.

### 3.6 Large-scale: stream-power / tectonic uplift

For the *island-scale* silhouette (ridge lines against sky, valley spacing), the relevant modern method is Cordonnier et al., *Large Scale Terrain Generation from Tectonic Uplift and Fluvial Erosion*, Computer Graphics Forum 35(2):165–175, 2016 ([Wiley](https://onlinelibrary.wiley.com/doi/10.1111/cgf.12820), [HAL](https://hal.science/hal-01262376)). Given a painted **uplift map**, it builds a stream graph over the whole domain and applies the geological **stream power equation**, then converts the stream graph to a DEM by blending landform feature kernels, "providing high-level control over the large scale dendritic structures of the resulting river networks, watersheds, and mountain ridges."

**I could not extract the paper's exponent values** — the Purdue PDF exceeds the fetcher's 10 MB limit and the other hosts were abstract-only. The stream-power law is standardly written `∂z/∂t = U − K·A^m·S^n` with A = drainage area and S = slope, and the *commonly quoted* exponent ratio is `m/n ≈ 0.4–0.6` with `n ≈ 1`, but **I did not verify those numbers in this session — do not put them in a shipping comment without checking the paper.**

**What is safe to take from it:** the architecture. Uplift map (art-directable) → flow routing → erosion proportional to a power of drainage area → ridges emerge *between* the channels. This is what produces the characteristic **dendritic valley network with roughly constant valley spacing** that fBm cannot produce, and it is the reason real ridgelines have a specific serration frequency.

### 3.7 What is practical to bake offline for a WebGL2 scene

| Technique | Where | Cost | Silhouette payoff |
|---|---|---|---|
| Plane cuts + Voronoi spalls on SDF → marching cubes → glTF | Node, offline | seconds/rock | ★★★★★ |
| Slump/thermal filter on heightfield | Load time or offline | ms | ★★★★ |
| Virtual-pipes hydraulic erosion, 1024², 1000 it. | Load time (WebGL2 FBO) or offline | ~0.2–1 s modern GPU | ★★★★ |
| Stream-power / uplift for island silhouette | Offline, authored once | minutes | ★★★★★ (macro only) |
| Droplet erosion | Offline (CPU) | seconds | ★★★ |
| Runtime SDF raymarching of rocks | — | too expensive | — |

**Bake 8–16 distinct rock meshes per lithology**, not 3, and vary them further with non-uniform instance scale (see §6.5 for the correct way to do that without giving the game away).

---

## 4. (c) Directional / anisotropic structure

### 4.1 The core move: warp the *domain metric*, not the noise

To make features elongate by a factor `s` along a unit direction `d`, **compress** the sampling domain along `d`:

```glsl
// Elongate noise features by factor s along direction d (d normalised).
vec3 anisoDomain(vec3 p, vec3 d, float s) {
    return p - (1.0 - 1.0/s) * d * dot(p, d);
}
// usage: float h = fbm( anisoDomain(p, beddingDir, 6.0) * freq );
```
Check: the component of `p` along `d` is divided by `s`, so a noise feature of noise-space extent L occupies `s·L` in world space along `d`. Perpendicular extent is unchanged.

This is exactly what the Houdini production recipe does, described in prose in the [80.lv procedural rock breakdown](https://80.lv/articles/006sdf-breakdown-procedural-rock-generation-in-houdini): the primary shaping noise is **Worley F2−F1** with "the Y frequency … scaled up to create vertically stretched cells", and the displacement is "masked on the vertical Y-axis, applying only to X and Z axes."

**Anisotropy ratios to use:**
- Bedded sedimentary rock: `s = 3–10` along bedding strike, `1` across.
- Flow-banded volcanic: `s = 5–20` along flow.
- Columnar basalt: not a stretch — it is a *polygonal set* (ETH p. 136); use a 2-D Voronoi in the plane normal to the column axis, extruded. Column diameters are commonly 0.1–3 m; **I could not verify a specific distribution in this session** — treat as a range to art-direct.
- Glacially scoured / striated rock: `s = 20–100`, very low amplitude (mm), aligned with ice flow.

### 4.2 Layer the anisotropy — a directional field, not a constant

A single global `d` is itself a tell (everything parallel, everywhere). Real bedding is *folded*. Use a slowly-varying direction field:

```glsl
// A cheap, smooth, curl-free-ish direction field from two low-frequency noises.
vec3 beddingDir(vec3 p) {
    float a = fbm(p * 0.013 + vec3(11.3, 0.0, 4.7)) * 0.6;   // dip azimuth wander
    float b = fbm(p * 0.011 + vec3(0.0, 7.9, 2.1)) * 0.35;   // dip magnitude wander
    return normalize(vec3(cos(a)*cos(b), sin(b), sin(a)*cos(b)));
}
```
`0.013` and `0.011` are chosen so the field turns over a wavelength of ~75–90 world units — i.e. bedding orientation is coherent across a whole cliff and changes between cliffs. Rule of thumb: **the direction field's wavelength should be 20–100× the joint spacing.**

### 4.3 Discrete strata, not continuous gradients

Continuous anisotropic noise still reads soft. The production trick is to **slice into discrete layers with per-layer randomisation**. From the same 80.lv breakdown: the mesh is sliced into strata by planes copied to points, and "each layer receives randomized X and Z scaling (**0.8–1.2 range**) driven by unique seed values tied to iteration numbers, preventing interpenetration while maintaining sharp strata layers."

Shader-side equivalent, for a cliff:
```glsl
// Discrete bedding: quantise the along-normal coordinate, then jitter each bed.
float beddedDisplacement(vec3 p, vec3 n, float bedThickness) {
    float t   = dot(p, n) / bedThickness;
    float id  = floor(t);
    float f   = fract(t);
    float h   = hash11(id);
    // per-bed recession: some beds are recessive (shale), some resistant (sandstone)
    float recess = mix(0.0, 1.0, step(0.55, h));           // ~45% resistant
    // per-bed lateral scale jitter, matching the Houdini 0.8..1.2 recipe
    float scale  = mix(0.8, 1.2, hash11(id + 37.0));
    float d = fbm(anisoDomain(p * scale, cross(n, vec3(0,1,0)), 6.0) * 0.9);
    // hard step at the bed boundary — this is the "sharp strata" the eye reads
    return recess * (0.35 + 0.65*d) + 0.06 * smoothstep(0.0, 0.08, f) ;
}
```
**Bed thickness:** pick 0.15–1.5 m for the sedimentary look; below 1.5 m the D = αT linear relation holds (§1.2), so **joint spacing = bed thickness × (1.0 ± 0.5)**, log-normal.

Visually: differential weathering of alternating resistant/recessive beds is what produces the **ledge-and-slope profile** — a stepped silhouette. That stepped profile is one of the strongest "this is real rock" cues in a screenshot, and it is *impossible* to get from isotropic fBm.

### 4.4 Boost the joint-spacing octave — the spectral bump

Per §1.3, standard fBm at gain 0.5 puts nothing at the joint spacing. Fix it explicitly:

```glsl
// fBm with a deliberate spectral bump at the joint / bed spacing.
// H: Hurst; G = exp2(-H) is the standard gain (iquilezles.org/articles/fbm)
float fbmWithBump(vec3 p, float H, int oct, float bumpWavelength, float bumpGain) {
    float G = exp2(-H);
    float f = 1.0, a = 1.0, t = 0.0;
    for (int i = 0; i < oct; i++) {
        float lambda = 1.0 / f;                                  // wavelength of this octave
        float w = 1.0 + (bumpGain - 1.0) *
                  exp(-pow(log(lambda / bumpWavelength), 2.0) / (2.0*0.35*0.35));  // log-normal bump
        t += a * w * noise(f * p);
        f *= 2.01;                                               // detune, see below
        a *= G;
    }
    return t;
}
```
- `bumpGain = 2.0–4.0`. `0.35` is the log-width of the bump — matched to the log-normal joint-spacing distribution (§1.2, σ_log ≈ 0.45; use 0.3–0.45).
- `bumpWavelength` = your bed thickness.
- **Do not** just raise global gain: that destroys the macro silhouette and gives you the "fuzzy" look. The point is a *band-limited* excess.

### 4.5 Detune every octave — the axis-alignment tell

IQ (verified, [iquilezles.org/articles/fbm](https://iquilezles.org/articles/fbm/)): unroll the loop and "detune each octave slightly by replacing 2.0 by 2.01, 1.99" to prevent "unrealistic patterns"; in 2-D you can also "rotate the domain a bit besides stretching it by an octave."

The rotation matrix used throughout IQ's public terrain shaders is `mat2 m2 = mat2(0.80, -0.60, 0.60, 0.80)` (a ~36.87° rotation). **The article I fetched confirms the *technique* but does not print that matrix — I am supplying it from familiarity with his shaders, so verify before quoting it as his.** Any irrational-ish rotation works; the requirement is that the per-octave rotations do not commensurate.

In 3-D use a fixed rotation of ~30–40° about an axis that is not a coordinate axis, e.g.
```glsl
const mat3 M3 = mat3( 0.00, 0.80, 0.60,
                     -0.80, 0.36, -0.48,
                     -0.60,-0.48,  0.64 );   // orthonormal, ~37 deg, no axis fixed
```

### 4.6 Derivative-weighted fBm — "erosion for free"

IQ's *value noise derivatives* trick ([iquilezles.org/articles/morenoise](https://iquilezles.org/articles/morenoise/), verified): accumulate the analytic derivative `d` across octaves and damp each octave by the accumulated slope:

```
a += b * n.x / (1.0 + dot(d, d));
```
with **lacunarity f = 1.98, gain s = 0.49, initial amplitude b = 0.5** (his stated values). Effect: "erosion-like effects and increased shape variety" — flat areas alongside rough areas, i.e. *heterogeneity*, which is tell §1.5. Use the **quintic** interpolant `u(x) = 6x⁵ − 15x⁴ + 10x³` rather than cubic `3x² − 2x³`; the quintic "eliminat[es] discontinuity artifacts present in the cubic version due to smoother second derivatives."

Analytic derivatives cost about 1/5 of the price of computing them by central differences separately, because you get them inside the noise evaluation.

### 4.7 Domain warping — cheap organic complexity

IQ's [warp](https://iquilezles.org/articles/warp/) article, verified, exact constants:
```
q.x = fbm(p + vec2(0.0, 0.0));
q.y = fbm(p + vec2(5.2, 1.3));
r.x = fbm(p + 4.0*q + vec2(1.7, 9.2));
r.y = fbm(p + 4.0*q + vec2(8.3, 2.8));
f(p) = fbm(p + 4.0*r);
```
Single warp → "subtle distortion with visible structure"; double warp → "intricate, natural-looking patterns with flowing characteristics."

Musgrave's 3-D equivalent (verified from his notes p. 2-10/2-11), with his stated good starting values **H = 0.25, distortion = 0.3**:
```c
distort.x = fBm(tmp);  tmp.x += 10.5;
distort.y = fBm(tmp);  tmp.y += 10.5;
distort.z = fBm(tmp);
point += distortion * distort;
return fBm(point);
```
He motivates this geologically: "Sometimes rock flows, as in deformation of soft sediments prior to lithification and under the tremendous heat and pressure of metamorphosis and orogenesis." His "warped slickrock" and "warped ridges" figures show exactly the swirled, folded strata look.

**Important:** warping alone will *not* fix the silhouette (§1.1). It fixes the "obviously noise" texture read. Both are needed.

### 4.8 If you need real spectral control: Gabor noise

Lagae et al., *A Survey of Procedural Noise Functions*, Computer Graphics Forum 29(8):2579–2600, 2010 ([PDF](https://www.cs.umd.edu/~zwicker/publications/SurveyProceduralNoise-CGF10.pdf)) and Lagae et al., *Procedural noise using sparse Gabor convolution*, ACM TOG 28(3), 2009. Gabor noise is a sparse convolution of Gabor kernels; the kernel's **frequency F₀, orientation ω₀ and bandwidth a** are direct, independent parameters, so anisotropy is specified rather than emergent, and it supports "setup-free surface noise and analytic anisotropic filtering of noise."

**I could not extract the paper's equations or default parameter values** — both PDFs came back as undecodable binary through my fetcher. So: know it exists, know it is the principled answer to §1.2, and read it directly before implementing. For WebGL2 the domain-warp approach in §4.1–4.3 is far cheaper and gets 80% of the way.

---

## 5. (d) Making detail follow PROCESS, not noise

### 5.1 Start with heterogeneity: multifractals (verified source code)

The simplest step away from "same roughness everywhere" is Musgrave's multifractal family. Source verified from [musgrave.c](https://engineering.purdue.edu/~ebertd/texture/1stEdition/musgrave/musgrave.c) and the notes PDF.

**Shared preamble** — spectral weights `exponent_array[i] = pow(frequency, -H)`, `frequency *= lacunarity`.

**Hetero_Terrain** — high frequencies scaled by the *local value* of the accumulated function, so valleys stay smooth and peaks get rough:
```c
value = offset + Noise3(point);
for (i=1; i<octaves; i++) {
    point *= lacunarity;
    increment = (Noise3(point) + offset) * exponent_array[i] * value;
    value += increment;
}
```

**HybridMultifractal** — additive/multiplicative hybrid. **Musgrave's stated good starting values: H = 0.25, offset = 0.7.**
```c
result = (Noise3(point) + offset) * exponent_array[0];
weight = result;
point *= lacunarity;
for (i=1; i<octaves; i++) {
    if (weight > 1.0) weight = 1.0;                       /* prevent divergence */
    signal = (Noise3(point) + offset) * exponent_array[i];
    result += weight * signal;
    weight *= signal;                                     /* monotonically decreasing weight */
    point *= lacunarity;
}
```

**RidgedMultifractal** — **Musgrave's stated defaults: H = 1.0, offset = 1.0, gain = 2.0.**
```c
signal = fabs(Noise3(point)); signal = offset - signal; signal *= signal;
result = signal; weight = 1.0;
for (i=1; i<octaves; i++) {
    point *= lacunarity;
    weight = clamp(signal * gain, 0.0, 1.0);
    signal = fabs(Noise3(point)); signal = offset - signal; signal *= signal;
    signal *= weight;
    result += signal * exponent_array[i];
}
```
Note the `weight` term: **an octave only contributes where the previous octave was near a ridge.** That is a primitive process model (ridges are where erosion has not yet reached) and it is why ridged multifractal reads better than ridged fBm.

**Other verified parameters from Musgrave's notes:**
- Lacunarity: "in practice a non-issue, we almost always leave it set at a value very close to 2.0."
- Octaves: `octaves = log2(screen_resolution) − 2`, "a value of about **6 to 10**." (For a 1920-wide render: ~8.9. For a rock filling 300 px: ~6.2.)
- `H = 1.0 − fractal_increment`; H=1 relatively smooth, H→0 approaches white noise. Surface fractal dimension D = 3 − H.
- Basis function matters more than the construction: his "ridges" (1−|Perlin|), "Mordor" (Worley d²) and "shattered hills" (Worley d) models use the *identical* hybrid-multifractal code and look radically different.

### 5.2 Curvature masks — wear on convexities, dirt in concavities

**On a heightfield**, curvature is a 3×3 stencil. Profile/plan/mean curvature from a DEM is standard geomorphometry (Zevenbergen & Thorne 1987, *Quantitative analysis of land surface topography*, ESPL 12:47–56 — **I am citing this from memory; I did not fetch it this session**). The cheap and adequate version:

```glsl
// Heightfield curvature stencil. Positive = concave (hollow), negative = convex (ridge/edge).
float concavity(sampler2D H, vec2 uv, vec2 texel, float amp) {
    float c  = texture(H, uv).r;
    float l  = texture(H, uv - vec2(texel.x, 0.0)).r;
    float r  = texture(H, uv + vec2(texel.x, 0.0)).r;
    float d  = texture(H, uv - vec2(0.0, texel.y)).r;
    float u  = texture(H, uv + vec2(0.0, texel.y)).r;
    return amp * ((l + r + d + u) * 0.25 - c);      // discrete Laplacian
}
```
**Multi-scale is mandatory.** Sample the Laplacian at 3 scales (1×, 4×, 16× texel) and combine — dirt collects in *big* hollows, lichen in *small* ones, and edge wear responds to the *smallest* scale. A single-scale curvature mask is itself a tell (everything wears at one radius).

**On a mesh**, the reference method is Rusinkiewicz, *Estimating Curvatures and Their Derivatives on Triangle Meshes*, 3DPVT 2004 — per-face second fundamental form from finite differences of vertex normals along the triangle's edges, accumulated to vertices with Voronoi-area weights, then eigendecomposed for principal curvatures κ₁, κ₂ and directions. **I could not fetch the paper (both Princeton URLs 404'd), so I am describing the method from familiarity — verify the exact weighting before implementing.** In practice for a baked rock you can skip it: bake curvature into a vertex attribute or a texture channel in your offline Node step using any mesh library, and ship it.

**Use of principal directions:** κ₁ direction is the *scratch/striation direction* for glacially polished rock and the *flute direction* for water-scoured rock. Free anisotropy (§4) that automatically follows the shape.

**Wear rule.** Rounding and brightening on convex maxima (κ_mean < 0), darkening and roughening in concave minima (κ_mean > 0):
```glsl
float edgeWear  = smoothstep(0.15, 0.55, -meanCurv_smallScale);
float cavityDirt= smoothstep(0.10, 0.45,  meanCurv_midScale);
```

### 5.3 Flow masks — where water actually goes

**This is the highest-value process mask and the one most often skipped.** Slope masks are not flow masks: slope tells you a surface is steep; flow accumulation tells you that 400 m² of hillside drains through *this* pixel, which is why there is a channel, a stain, and moss there and nowhere 2 m to the left.

Offline (Node, on the heightfield):
1. Sort all cells by height, descending.
2. Initialise `A[i] = cellArea` for all cells.
3. In sorted order, push `A[i]` to the downslope neighbour(s). **D∞ / multiple-flow-direction** (split proportionally to `max(0, slope_k)^p`, p ≈ 1.1) beats D8, which produces visible 45°-staircase artefacts — a tell in its own right.
4. Store `log(A)` in a texture channel.

Derived masks:
- **Channel mask** `= smoothstep(a0, a1, log(A))` → water polish, low roughness, darker albedo, sparse vegetation in arid settings / dense in temperate.
- **Topographic wetness index** `TWI = ln(A / tan β)` (Beven & Kirkby 1979 — standard, cited from memory) → moss, lichen, dark damp staining. High where flow is large *and* slope is low: valley floors, ledges, the base of cliffs.
- **Streak mask on a vertical face.** Flow accumulation degenerates on a near-vertical cliff. Instead do a short downhill walk in *texture space* along the projected gravity direction, accumulating a source term:
```glsl
// Cheap gravity streak: march up the projected-gravity direction, gather "shed" sources.
float streak(sampler2D srcTex, vec2 uv, vec2 gravUV, int steps, float decay) {
    float acc = 0.0, w = 1.0;
    vec2 q = uv;
    for (int i = 0; i < steps; i++) {
        q -= gravUV;                     // walk upstream (against flow)
        acc += w * texture(srcTex, q).r; // src = 1 where an overhang edge sheds water
        w *= decay;                      // decay 0.90-0.97; steps 24-64
    }
    return acc;
}
```
`src` should be `saturate(-meanCurv_large) * step(N·up, 0.2)` — i.e. **convex breaks in slope on near-vertical faces**, which is where a real drip line forms. This produces the vertical dark streaks under ledges that read instantly as "weathered stone" and cost one loop.

### 5.4 The full weathering literature, if you want to go further

- **Dorsey et al. 1999** ([project page](http://graphics.ucsd.edu/~henrik/papers/sig99/)): the **slab** — a surface-aligned volume in a narrow band around the boundary — with a simulation of moisture flow and mineral dissolution/recrystallisation governing erosion of material *from* the surface, plus subsurface scattering for the render. This is the correct model for **case hardening and tafoni**: minerals migrate outward and recrystallise as a hard rind, the softer interior hollows out, the rind eventually breaches. If you want tafoni (very characteristic of coastal sandstone, and very Halo), this is the physics.
- **Chen et al. 2005** ([PDF](https://ttwong12.github.io/papers/gammaton/gammaton.pdf)): **γ-ton tracing** — trace aging particles through the scene like photons, record transport, then generate the effect. Handles *multi-weathering* (dirt washing off one surface and depositing on another below it) and produces geometry change, not just texture. The transport model is exactly what makes stains *causally connected* between objects — the single thing procedural masks never do.

**Practical WebGL2 substitute for γ-tons:** a one-off offline pass where you shoot 10⁵–10⁶ rays downward-with-jitter into the scene, deposit "dirt" on first hit weighted by `N·up`, then *bounce* a fraction downhill along the surface. Bake to a second UV set / vertex colour. Cost: minutes offline, zero at runtime.

### 5.5 Mask composition rules — how not to undo all of this

1. **Multiply, don't lerp.** `dirt = wetness * concavity * (1 - scour)`. Products give you the patchy, bimodal histogram of §1.5; sums give you grey mush.
2. **Threshold with a noisy threshold.** `m = smoothstep(t - w, t + w, mask)` where `t = t0 + 0.25*fbm(p*3.0)`. This produces hard-edged colonies with fractal margins — how lichen actually looks.
3. **Two scales of breakup.** A large-scale patch mask (wavelength 3–15 m) gating a small-scale detail mask (wavelength 5–30 cm). Never one.
4. **Never apply a mask isotropically to a directional process.** Rainwash is vertical. Wind polish is horizontal. Ice is unidirectional.
5. **Check the histogram.** Target ~55–70% below 0.1, ~15–30% above 0.8 (my recommendation, §1.5).
6. **Occlusion is not curvature and not a substitute.** AO responds to the *whole scene*; cavity responds to the *surface*. You need both channels; dirt tracks cavity, ambient tint tracks AO.

---

## 6. (e) Scatter realism

### 6.1 The right point process: hard-core at short range, clustered at long range

This is the single correction that matters, and it is well-documented.

Dixon (verified, [PDF](https://academicweb.nd.edu/~mhaenggi/ee87021/Dixon-K-Function.pdf)):
- **Ripley's K:** `K(t) = λ⁻¹ E[number of extra events within distance t of a randomly chosen event]`. Under complete spatial randomness (CSR, homogeneous Poisson), `K(t) = πt²`. `K(t) > πt²` → clustering; `K(t) < πt²` → regularity. In practice use `L(t) = √(K(t)/π)`, so `L(t) − t = 0` under CSR.
- **Matérn hard-core process** (small-scale regularity): random thinning of a Poisson process with intensity ρ — any pair separated by less than a critical distance δ is deleted. `K(t) = (2ρπ / exp(−ρπδ²)) ∫₀ᵗ u·k(u) du`, with `k(u) = 0` for `u < δ`, `exp[−ρV(u,δ)]` for `u ≥ δ`, where V is the area of intersection of two circles of radius δ whose centres are u apart.
- **Neyman–Scott / Thomas process** (large-scale clustering): parents from a homogeneous Poisson process of intensity ρ; each parent generates `Nᵢ ~ Poisson(m)` offspring at bivariate-Gaussian offsets with zero mean and variance `σ²I`; parents are then discarded. **`K(t) = πt² + (1 − exp(−t²/4σ²))/ρ`.**
- General Poisson cluster process: `K(t) = πt² + E[N(N−1)]·F(t)/(ρμ²)`, where F(t) is the distribution of distance between offspring from the same parent and μ is the mean number of offspring per parent.

**Real measured numbers**, from Dixon's swamp-hardwood example (91 cypress trees, 1 ha plot, 50 m × 200 m; verified, pp. 5–6):
- `L(t) − t < 0` for `t ≤ 2 m` → **spatial regularity at short range** (physical exclusion: stems are 15–180 cm diameter, median 105 cm).
- `L(t) − t > 0` for `t ≥ 3 m`, significantly above the 97.5% envelope from **4 m to 27 m**, peaking around 10–15 m → **clustering at medium range**.
- Fitted Neyman–Scott parameters: **`σ̂² = 24.1 m²` (σ ≈ 4.91 m), parent density `ρ̂ = 0.0034 m⁻²`** (≈34 clusters per hectare).
- Magnitude: **"In a 6-m radius circle, each cypress tree is surrounded by an estimated 88% more cypress trees than expected if cypress trees were randomly distributed."**
- Meanwhile for *all* 630 trees pooled, the excess in a 6 m circle was only **5.6%** — nearly random. **Lesson: cluster each species/type separately; the pooled pattern looks random and misleads you.**
- The two species were also **spatially segregated** (cypress in cypress patches, black gum in black gum patches), tested by cross-K.

**Direct translation to a boulder field / vegetation scatter:**

```js
// Thomas (Neyman-Scott) cluster process + Matern-II hard-core thinning, 2D.
// Produces: small-scale regularity + large-scale clustering. The natural signature.
function scatterNatural(W, H, rng, {
  parentDensity = 0.0034,   // clusters per m^2   (Dixon cypress: 0.0034)
  meanOffspring = 8,        // Poisson mean per cluster
  sigma         = 4.9,      // m, cluster dispersion (Dixon: sqrt(24.1) = 4.91)
  hardCore      = r => 2.0*r // min centre distance as f(radius); physical exclusion
}) {
  const nParents = poisson(rng, parentDensity * W * H);
  const pts = [];
  for (let i = 0; i < nParents; i++) {
    const px = rng()*W, py = rng()*H;
    const k = poisson(rng, meanOffspring);
    for (let j = 0; j < k; j++) {
      // Box-Muller for the bivariate Gaussian offset
      const u1 = Math.max(1e-9, rng()), u2 = rng();
      const R = sigma * Math.sqrt(-2*Math.log(u1));
      const x = px + R*Math.cos(2*Math.PI*u2);
      const y = py + R*Math.sin(2*Math.PI*u2);
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      pts.push({x, y, r: sampleRadius(rng)});          // see 6.2
    }
  }
  // Matern-II thinning: keep in random "age" order, delete anything too close to a kept point.
  shuffle(pts, rng);
  const kept = [], grid = new SpatialHash(4*sigma);
  for (const p of pts) {
    let ok = true;
    for (const q of grid.near(p.x, p.y, hardCore(p.r) + 4)) {
      const dx = p.x-q.x, dy = p.y-q.y;
      if (dx*dx + dy*dy < Math.pow(hardCore(p.r) + hardCore(q.r), 2)) { ok = false; break; }
    }
    if (ok) { kept.push(p); grid.insert(p); }
  }
  return kept;
}
```

**When Poisson-disc is still right.** Bridson, *Fast Poisson Disk Sampling in Arbitrary Dimensions*, SIGGRAPH 2007 sketch ([PDF](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf), verified from the paper itself):
- Background grid with **cell size `r/√n`** (n = dimension) so each cell holds at most one sample.
- Pick a random initial sample, put it on an "active list".
- Repeat: pick a random active sample, generate up to **k points uniformly from the spherical annulus between radius r and 2r** around it; accept the first that is ≥ r from all existing samples; if all k fail, remove the sample from the active list.
- **`k` is typically 30.** The algorithm is **O(N)** (step 2 runs exactly 2N−1 times).

Use it for: grass blades, gravel *within* a patch, tessellation seeds — anything where physical exclusion genuinely dominates and there is no clustering mechanism. Use it as the **hard-core stage inside** the cluster process, not as the whole scatter. Bridson himself notes that jittered/stratified sampling "reduces but doesn't eliminate clustering", and that unstructured random distributions have "undesirable clustering" *for rendering* — that undesirability is a rendering criterion, not a naturalism criterion, and this is exactly where the graphics tradition leads people astray.

### 6.2 Size–frequency: power law, and it must be heavy-tailed

Clast populations are power-law distributed. Numbers I found:

- **Rockfall frequency–magnitude:** power-law `b` parameters from **−0.61 to −1.04** for lichen-dated talus in Glenwood Canyon, CO ([Geomorphology 2022](https://www.sciencedirect.com/science/article/abs/pii/S0169555X22001465)). Corresponding recurrence: sub-annual-to-annual for 0.1 m³ events, years-to-decades for 1 m³, several decades for 10 m³.
- **Boulder size–frequency on deposits:** comet 67P talus deposit power-law index **−3.9 (+0.2/−0.4)**; distal detrital deposits **−2.4 (+0.2/−0.3)** ([arXiv 1512.03193](https://arxiv.org/pdf/1512.03193)). "A steeper power-law index in the talus deposit indicates an increase of the population of smaller-size boulders with respect to the bigger ones." Many small-body boulder populations fit power laws with exponents **around −3** ([arXiv 2009.00957](https://arxiv.org/pdf/2009.00957), [arXiv 2406.02892](https://arxiv.org/pdf/2406.02892)).
- **Caveat:** the −3.9/−2.4 figures are from *comet* and *asteroid* surfaces (low gravity, no water). The general *form* — power law, steeper near the source, shallower distally — is robust and is also what the terrestrial rockfall literature reports, but **I did not verify a terrestrial terrestrial-talus exponent from full text.** Treat α ∈ [2.5, 4.0] as the working range, α ≈ 3.5–4 at the cliff foot, α ≈ 2.4–3 out on the apron.

**Sampling.** Pareto inverse-CDF, exact and one line:
```js
// P(D > d) ∝ d^-alpha for d >= dmin.  alpha ~ 2.5..4.0
const sampleRadius = (rng, dmin = 0.12, alpha = 3.2, dmax = 4.0) => {
  const u = rng();
  const d = dmin * Math.pow(1 - u, -1 / alpha);
  return Math.min(d, dmax) * 0.5;              // radius
};
```
**What this looks like versus what you probably have.** With `dmin = 0.12 m, α = 3.2`, out of 1000 clasts you get roughly: ~800 in 0.12–0.2 m, ~150 in 0.2–0.35 m, ~35 in 0.35–0.7 m, ~10 in 0.7–1.5 m, ~2 above 1.5 m. **Nearly all of your rocks should be small and nearly invisible, with a handful of dominant ones.** A scatter with three sizes at 1:1:1 is a tell you can see from across the room.

`dmax` matters: cut the tail at the largest joint-bounded block your cliff can supply, i.e. roughly `bed thickness × joint spacing × joint spacing` in volume → `dmax ≈ 1.5–2.5 × bed thickness`.

### 6.3 Density should be causal, not uniform

Boulders come *from* somewhere. Real talus/colluvium:
- **Density decays with distance from the source cliff.** Model as `ρ(x) = ρ0 · exp(−x/L)`. `L` on the order of 0.5–1.5 × cliff height. (**Heuristic; I did not find a published decay length — flagged.**)
- **Fall sorting:** the largest clasts bounce and roll furthest, so mean clast size *increases* toward the toe of a talus slope, while total density decreases. Implement by making `α` (the power-law exponent) a function of distance: steeper (more fines) near the apex, shallower (coarser) at the toe — which is exactly the 67P talus-vs-distal contrast. (Fall sorting is a standard talus-slope observation; **I am citing it from general geomorphology knowledge, not from a source fetched this session.**)
- **Slope gating.** Nothing rests above the angle of repose (§3.3: 33–37°). Above that, only *attached* outcrop. This is a hard cut and its absence — boulders sitting on 55° faces — is a glaring tell.
- **Flow gating.** Fines are washed out of channels; channels contain either bedrock or coarse lag. Use the flow-accumulation channel (§5.3) to *remove* small clasts and *keep* large ones.

### 6.4 Orientation and burial

- **Rotation.** Yaw uniform on [0, 2π). **Tilt is not uniform.** A clast rests on a stable face, so its short (c) axis is roughly normal to the ground. Sample tilt from a half-normal about the local surface normal with σ ≈ 8–15°, plus the local slope.
- **Imbrication.** Clasts transported by flow (in a channel, or a debris flow) come to rest **dipping upstream**, typically 10°–30°. This is a real, strong, cheap visual signal, and its presence in a channel bed instantly reads as "water did this." (**Standard sedimentology; recalled, not fetched this session.**)
- **Long-axis alignment.** In a flow, prolate clasts align either parallel or transverse to flow depending on regime; on a talus, long axes tend to lie along the slope. Either way, **not random** — draw the long-axis azimuth from a von Mises distribution about the flow/slope direction with κ ≈ 2–6 (broad but non-uniform).
- **Burial.** Sink each clast by 15–40% of its c-axis (short axis) into the ground surface, more for smaller clasts and finer substrate. Never zero.
- **Debris apron.** Every clast above ~0.5 m should have a halo of smaller clasts within 1–2 diameters — its own spall debris. Cheap: for each large clast, emit 3–10 children from the same Pareto with `dmin` scaled to 0.15× the parent, offset by Gaussian σ = 0.8 × parent radius.
- **Contact.** A dark contact ring / small berm of fines on the upslope side.

**Clast shape.** Use the **Zingg (1935)** classification for axis ratios: with axes a ≥ b ≥ c, the thresholds are at **b/a = 2/3** and **c/b = 2/3**, giving four classes — oblate/disc (b/a > 2/3, c/b < 2/3), equant/spheroid (both > 2/3), bladed (both < 2/3), prolate/rod (b/a < 2/3, c/b > 2/3). Angularity is classified on the six **Powers (1953)** roundness classes: very angular, angular, subangular, subrounded, rounded, well rounded. **Both are recalled from sedimentology, not fetched this session — the 2/3 thresholds in particular should be checked before you hard-code them.** What matters for you regardless: **sample the axis ratios, don't scale uniformly.** Fresh rockfall is angular and *bladed/equant* (joint-bounded blocks, so axis ratios follow joint spacings); a river cobble is rounded and *oblate*.

### 6.5 The standard mistakes, as a checklist

| Mistake | Symptom | Fix |
|---|---|---|
| Poisson-disc for everything | Suspiciously even carpet; CV_NN ≈ 0.2 | §6.1 Thomas + Matérn |
| Uniform random placement | Ugly clumps *and* holes at the wrong scale | §6.1 |
| One or three sizes | Visible size quantisation | §6.2 Pareto |
| Uniform-random scale multiplier | Looks like one rock, resized — **the classic** | Use distinct meshes; vary *non-uniformly* per axis (§6.4 Zingg) and re-derive normals |
| Uniform 3-axis rotation | Rocks balanced on corners | §6.4 |
| No burial | Hard contact line, floating look | §6.4 |
| Density uniform over the map | No causal story | §6.3 |
| Instance rotation shared with instance scale seed | Correlated pattern visible at distance | Use independent hash streams |
| Same LOD/normal-map wavelength at all sizes | Detail scales with the object (§1.7.6) | Fix detail wavelength in **world** units |
| Placement ignores slope | Boulders on 60° faces | §6.3 slope gate at ~35° |
| No lighting-scale variance | Everything reads as one material | Vary albedo ±15% and roughness ±0.1 per instance |

---

## 7. (f) Parameter cookbook and code sketches

### 7.1 A complete offline rock generator, parameterised

```js
// Node/offline. Produces one clast mesh. Run 8-16 times per lithology.
const rockParams = {
  // --- macro shape ---
  axes:            () => zinggAxes(),         // a:b:c from Zingg classes, e.g. 1 : 0.72 : 0.48
  baseNoise:       { H: 0.9, octaves: 4, amp: 0.16, lacunarity: 2.01 },

  // --- anisotropy (Sec 4) ---
  beddingDir:      [0.0, 1.0, 0.0],           // local up for a horizontally bedded clast
  beddingStretch:  6.0,                       // 3-10 sedimentary, 5-20 flow-banded
  bedThickness:    0.22,                      // metres; drives everything below

  // --- joint plane cuts (Sec 3.1) ---
  jointSets:       3,
  setDihedral:     () => (Math.random() < 0.5 ? rand(85, 95) : rand(30, 60)),
  setScatterDeg:   9.0,                       // 1-sigma, vMF kappa ~ 120
  spacingMedian:   0.22,                      // == bedThickness  (D/T = 1.04, Sec 1.2)
  spacingSigmaLog: 0.45,                      // log-normal
  systematicFrac:  0.68,                      // rest are non-systematic, T-terminating

  // --- Voronoi spalls (Sec 3.2) ---
  spallCount:      () => randint(3, 8),
  spallCellSize:   0.30,                      // relative to clast diameter: 0.15-0.45
  spallDepthFrac:  () => rand(0.10, 0.35),

  // --- spectral bump (Sec 4.4) ---
  bumpWavelength:  0.22,                      // == bedThickness
  bumpGain:        2.8,                       // 2.0-4.0
  bumpLogWidth:    0.35,

  // --- edge treatment (Sec 3.1, 5.2) ---
  convexRound:     0.012,                     // metres; 0 for fresh rockfall, 0.02-0.05 fluvial
  concaveRound:    0.002,                     // keep concavities sharp

  // --- micro (baked to normal map) ---
  microNoise:      { H: 0.55, octaves: 5, amp: 0.004, wavelengthWorld: 0.03 },
};
```

Pipeline: SDF (ellipsoid → plane cuts → spall subtractions → `+ fbmWithBump` → curvature-gated rounding) → marching cubes at ~0.4 × spacingMedian → decimate → bake AO/curvature/flow into vertex attributes → glTF.

### 7.2 Cliff-face heightfield: recommended chain

1. `hetero_terrain` or `hybridMultifractal` base, **H = 0.25, offset = 0.7, lacunarity 2.01, octaves 8**.
2. Domain-warp with the Musgrave 3-D warp, **distortion = 0.3, H = 0.25**.
3. Discrete bedding pass (§4.3), bed thickness 0.15–1.5 m, 45% resistant beds.
4. Virtual-pipes hydraulic erosion, **1000 iterations**, parameters from §3.4 Table 2, with a hardness field `R = blur(normalised_height + noise)`.
5. Thermal slump, `talus_slope = tan(34°) = 0.674`, `diffusion_coeff = 0.1`, 200 iterations, gated by regolith depth.
6. Extract from the result and store as channels: `log(flowAccumulation)`, `meanCurvature` at 3 scales, `slope`, `R`.
7. Scatter with §6, using the erosion result's channels as the density and gating fields.

### 7.3 Runtime shader budget (WebGL2)

You only need the *masks* at runtime; everything else is baked.

```glsl
// Per-fragment weathering composite. ~15 ALU + 4 texture fetches.
// procMask.r = log flow accum, .g = curvature (small), .b = curvature (large), .a = hardness R
vec4 pm = texture(uProcMask, vUv);
float flow  = smoothstep(uFlow0, uFlow1, pm.r);
float cavS  = smoothstep(0.10, 0.45,  pm.g);
float cavL  = smoothstep(0.05, 0.30,  pm.b);
float convex= smoothstep(0.15, 0.55, -pm.g);
float up    = smoothstep(0.45, 0.80, vWorldNormal.y);
float streakM = texture(uStreak, vUv).r;             // baked, Sec 5.3

// Two-scale noisy threshold -> hard-edged patches, bimodal histogram (Sec 5.5)
float patchL = fbm(vWorldPos * 0.22);                // ~4.5 m wavelength
float patchS = fbm(vWorldPos * 6.0);                 // ~17 cm wavelength
float thr    = 0.42 + 0.22 * patchL;

float lichen = smoothstep(thr - 0.06, thr + 0.06, cavL * up * (0.5 + 0.5*patchS)) * (1.0 - flow);
float dirt   = smoothstep(0.30, 0.70, cavS * up * (1.0 - flow)) ;
float stain  = saturate(streakM * 0.9) * (1.0 - up);
float wear   = convex * pm.a;                        // harder rock wears less

vec3 albedo = uRockAlbedo;
albedo = mix(albedo, uDirtAlbedo,   dirt   * 0.85);
albedo = mix(albedo, uStainAlbedo,  stain  * 0.65);
albedo = mix(albedo, uLichenAlbedo, lichen * 0.90);
albedo = mix(albedo, albedo * 1.18, wear   * 0.5);   // wear brightens fresh rock
float rough = mix(uRough, 0.35, flow) ;              // water-polished channels are smoother
rough = mix(rough, 0.92, dirt);
```

### 7.4 The diagnostic battery — score yourself before the next blind A/B

Run all six on your frames **and on reference frames** from the target footage. This turns "it looks CG" into numbers you can iterate against.

| # | Metric | How | CG signature | Target |
|---|---|---|---|---|
| 1 | Silhouette concavity count | Object mask → contour → resample → smooth at P/40 → count κ sign changes and deep minima (κ < −2/R̄) per silhouette | 0–2 deep minima | match reference (hypothesis: 4–12) |
| 2 | Depth-buffer Laplacian pyramid | RMS per level, log–log | straight line, slope ≈ −H | break of slope + local excess at joint spacing |
| 3 | Gradient orientation rose | Sobel, magnitude-weighted 8° histogram; structure-tensor anisotropy `(λ1−λ2)/(λ1+λ2)` | ≈ 0 (flat rose) | 0.3–0.7 with 2–3 lobes |
| 4 | Scatter NN-distance CV | positions → NN distances → σ/μ | 0.15–0.30 (blue noise) or exactly 0.52 (Poisson) | > 0.6 |
| 5 | Scatter size histogram | log–log CCDF of projected size | flat / 1–3 spikes | straight line, slope −2.5 to −4 |
| 6 | Weathering mask histogram | histogram of each mask channel | unimodal at 0.3–0.5 | bimodal: 55–70% < 0.1, 15–30% > 0.8 |

Metrics 1, 4, 5 are the ones that most reliably separate procedural from real, in that order. Metric 4's CG signature values are exact (derived, §1.6); the rest of the "target" column mixes verified values with my recommendations — see §8.

### 7.5 If you can only do three things

1. **Plane cuts + Voronoi spalls on every rock, baked offline** (§3.1, §3.2). This alone fixes tell 1.1, the dominant one.
2. **Replace Poisson-disc scatter with Thomas-cluster + Matérn hard-core, and Pareto sizes** (§6.1, §6.2). Fixes tell 1.6, the second most visible.
3. **Bake flow accumulation and multi-scale curvature; drive every mask from them, with a noisy two-scale threshold** (§5.3, §5.5). Fixes tells 1.4 and 1.5.

Everything else is refinement.

---

## 8. What I verified, and what I did not

**Verified by reading the primary source in this session:**
- Musgrave, *Procedural Fractal Terrains* — all quotes, the slump-filter code, H/lacunarity/octaves guidance, the fBm/hybrid-multifractal/warped-fBm code and stated defaults (H=0.25, offset=0.7, distortion=0.3), and the §2.7/§2.8 conclusions. [PDF](https://www.classes.cs.uchicago.edu/archive/2015/fall/23700-1/final-project/MusgraveTerrain00.pdf)
- `musgrave.c` — RidgedMultifractal (H=1.0, offset=1.0, gain=2.0), HybridMultifractal (H=0.25, offset=0.7), Hetero_Terrain, multifractal, and the `pow(frequency, -H)` exponent array. [source](https://engineering.purdue.edu/~ebertd/texture/1stEdition/musgrave/musgrave.c)
- Jákó & Tóth, *Fast Hydraulic and Thermal Erosion on the GPU*, CESCG 2011 — all equations, the complete Table 2 parameter set, and Table 1 timings. [PDF](https://old.cescg.org/CESCG-2011/papers/TUBudapest-Jako-Balazs.pdf)
- Bridson, *Fast Poisson Disk Sampling in Arbitrary Dimensions* — cell size r/√n, k ≈ 30, annulus [r, 2r], O(N), step 2 runs 2N−1 times. [PDF](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf)
- Dixon, *Ripley's K function* — K/L definitions, Matérn hard-core K(t), Neyman–Scott K(t), Poisson-cluster K(t), and the cypress numbers (σ̂²=24.1 m², ρ̂=0.0034, regularity ≤2 m, clustering ≥3 m significant 4–27 m, 88% excess at 6 m, 5.6% pooled). [PDF](https://academicweb.nd.edu/~mhaenggi/ee87021/Dixon-K-Function.pdf)
- ETH structural geology notes, *Joints* (jpb 2020), pp. 133–142 — conjugate 30–60°/orthogonal ~90°, systematic vs non-systematic definitions, log-normal spacing, D=αT valid below 1.5 m with Ladeira & Price 1981 data, 5 cm interlayer threshold, master joints scale, T-junction abutting, plumose 30°→70°, fringe 5–25°, the five joint patterns. [PDF](https://www.files.ethz.ch/structuralgeology/JPB/files/English/4joints.pdf)
- iquilezles.org: [fbm](https://iquilezles.org/articles/fbm/) (G = exp2(−H), detuning 2.01/1.99, per-octave rotation), [warp](https://iquilezles.org/articles/warp/) (exact offsets 5.2/1.3, 1.7/9.2, 8.3/2.8, factor 4.0), [morenoise](https://iquilezles.org/articles/morenoise/) (`a += b*n.x/(1+dot(d,d))`, f=1.98, s=0.49, b=0.5, quintic > cubic), [smin](https://iquilezles.org/articles/smin/) (all six forms, k = blend width, quadratic recommended), [distfunctions](https://iquilezles.org/articles/distfunctions/) (CSD ops + the "not true SDFs" warnings), [voronoise](https://iquilezles.org/articles/voronoise/) (full GLSL, u/v parameter space).
- GPU Gems 3 Ch. 1, Geiss, *Generating Complex Procedural Terrains Using the GPU* — `density = -ws.y` plus octaves, ~9 octaves for rich terrain, 32³ voxel blocks / 33³ density texture, `ws += warp*8`, hard-floor term `saturate((hard_floor_y - ws_orig.y)*3)*40` for shelves/terraces. [chapter](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu)
- 80.lv Houdini procedural rock breakdown — Worley F2−F1 as primary blocky basis, Y-frequency stretch, XZ noise masking, strata slicing with 0.8–1.2 per-layer XZ scale jitter, noise-driving-noise warp, AttributeBlur between passes, VDB fracture for edge chipping, 5–10 min/asset. [article](https://80.lv/articles/006sdf-breakdown-procedural-rock-generation-in-houdini)
- dandrino, terrain-erosion-3-ways README — "fBm … fairly boring", "everything more or less looks the same", ~10 constants, features emerge from erosion not noise layering. [repo](https://github.com/dandrino/terrain-erosion-3-ways)

**Derived by me (not cited, but checkable in two lines):**
- CV of nearest-neighbour distance under 2-D CSR = √(4/π − 1) = 0.5227.
- Clark–Evans maximum R = 2.1491 for a hexagonal lattice.
- The domain-compression identity for anisotropic noise in §4.1.
- The amplitude argument in §1.3 (0.5⁵ ≈ 3%).

**Read only in abstract/summary form — verify before relying on:**
- Joint spacing/thickness ratios 0.8–1.2 critical; 0.17–1.82, mean 1.04, median 0.99, s.d. 0.51 (ScienceDirect / Cambridge abstracts). The *linear* D = αT relation is independently confirmed by the ETH notes.
- Talus angle of repose 30–40°, dry failure 33–37°, cone material ~35°, and the small-specimen caveat (Wiley ESPL abstracts + UBC thesis excerpt).
- Rockfall power-law b = −0.61 to −1.04 (Glenwood Canyon lichenometry abstract).
- Boulder SFD exponents −3.9 (talus) / −2.4 (distal) on 67P, ~−3 generally on small bodies (arXiv preprints, read as search summaries).
- Hoffman & Richards minima rule, Attneave 1954, and the 101-vs-55 experimental result (read via abstracts and summaries, not the original papers).
- Musgrave's per-octave rotation matrix `mat2(0.8,-0.6,0.6,0.8)` — the *technique* is confirmed in the IQ article, the *matrix* is from my familiarity with his shader code.

**Could not retrieve at all — gaps you should close if these become load-bearing:**
- **Mei, Decaudin & Hu 2007** (the original virtual-pipes paper). Every mirror 404'd or was access-blocked. Everything I give for that model comes from Jákó & Tóth's reimplementation.
- **Beyer 2015 droplet-erosion thesis.** Host has a self-signed certificate; archive.org is unreachable from here. **I deliberately did not quote its parameter table** — the values in §3.5 are my own defaults, labelled as such.
- **Cordonnier et al. 2016** full text (Purdue PDF exceeds the 10 MB fetch limit). I have the architecture from the abstract; **I do not have verified stream-power exponents m and n.**
- **Lagae et al. 2010 noise survey** and **Bridson et al. 2007 curl noise** — PDFs came back undecodable. Gabor noise parameters and the curl-noise potential construction are therefore unquantified here.
- **Rusinkiewicz 2004** curvature estimation — both Princeton URLs 404'd. §5.2's mesh-curvature description is from familiarity.
- **Guerrilla Games, GPU-Based Procedural Placement in Horizon Zero Dawn** (GDC 2017). Only the landing page was retrievable; the slide deck is behind links I could not resolve. **I have no numbers from it** — density definitions, jitter, tile sizes and clustering rules are all unknown to me. Given that HZD's placement is probably the closest published match to what you need, this is the biggest single gap in this document. The deck is at [guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn](https://www.guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn) and [GDC Vault](https://sandbox.gdcvault.com/play/1024700/GPU-Based-Run-Time-Procedural).
- **Zingg 1935 / Powers 1953 / Zevenbergen & Thorne 1987 / Beven & Kirkby 1979** — cited from memory, not fetched. All four are real and standard, but check the specific thresholds and coefficients before hard-coding.
- No published measurement of **silhouette concavity counts** on real vs synthetic rock exists as far as I could find. Metric 1 in §7.4 is a construct of mine; the *perceptual justification* (minima rule) is solid, the *target numbers* are not.
