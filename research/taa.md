# TAA and motion vectors in a WebGL2 / three.js deferred-ish pipeline

Research note for `src/render/passes/taa.js`, `src/render/passes/scene.js`,
`src/gfx/GBufferMaterial.js`, `src/render/RenderPipeline.js`.
Target: a renderer judged on **still frames captured after ~48 settle frames**.

Everything below is checked against the code in this repo at the time of writing, and against
primary sources. Where I derived something myself rather than citing it, I say so.

---

## 0. Executive summary — what to actually do

1. **The correct velocity is the difference of the two *un-jittered* NDC positions.**
   Current-frame jitter is removed from the current position, previous-frame jitter from the
   previous position. Both jitters enter, and if both matrices carry their own frame's jitter
   the correction collapses to subtracting the jitter *delta* `(j_n − j_{n−1})`. The invariant
   that makes it right: **a static camera looking at static geometry must produce a bit-exact
   zero motion vector.**
2. **The fix in this repo is two lines**, and it is safe: `gl_Position` in
   `GBufferMaterial` comes from three's `<project_vertex>` (which uses the *jittered*
   `projectionMatrix` uniform), while `vCurClip` comes from the separate `uCurrViewProj`
   uniform. Changing `uCurrViewProj` to the un-jittered matrix therefore **does not change
   rasterisation at all** — depth and normals stay jittered, as they must. See §1.5.
3. **The blast radius of the current bug is smaller than `KNOWN_ISSUES` states**, and I can
   show why: the G-buffer error is at most 0.707 px, and `taa.js` only trusts the G-buffer
   velocity when it disagrees with the depth-derived one by **more than 1.5 px**. So static
   geometry never touches the broken path today, and never will in any of the four
   fix/no-fix combinations. Only *moving* geometry is affected. Details and the exact
   arithmetic in §1.6 — this changes the risk calculus for the coupled commit.
4. **For a still-frame-judged renderer, a fixed `α` never converges.** With `α = 0.09` and a
   16-phase jitter cycle the steady state is a *16-frame limit cycle*, not a fixed point:
   the newest phase carries 4.1× the weight of the oldest. Switch to `α = max(1/(n+1), α_min)`
   with `n` reset on cut, and settle for an exact multiple of the sequence length. Then the
   still is provably converged, and frame 48 equals frame 64 to float precision. §3.
5. **Two genuine defects I found while reading the code**, both TAA-relevant, neither in
   `KNOWN_ISSUES`: the viewmodel pass wipes the shared depth texture that the TAA resolve
   reads (§4.3), and the `wide` tent in the reconstruction filter is truncated to 3×3 and is
   therefore *not* phase-stable, which partially defeats the stated purpose of note 7 (§2.7).

---

## 1. (a) The correct relationship between jitter and motion vectors

### 1.1 Notation and the three.js sign convention (verified from source)

Let

- `W, H` = render target size in pixels.
- `jpx_n = (jx_n, jy_n)` = the frame-`n` sub-pixel jitter **in pixels**, conventionally in
  `[-0.5, +0.5]`.
- `J_n` = the same jitter in **NDC units**, `J_n = 2 · jpx_n / (W, H)`.
- `u_n(x)` = the **un-jittered** NDC of world point `x` under frame `n`'s camera.
- `p` = the pixel centre being resolved, in NDC / UV.

three.js builds the perspective matrix as (verified in
`node_modules/three/build/three.core.js`, `Matrix4.makePerspective`, r0.185.1):

```
te[0]=x  te[4]=0  te[8]=a   te[12]=0
te[1]=0  te[5]=y  te[9]=b   te[13]=0
te[2]=0  te[6]=0  te[10]=c  te[14]=d
te[3]=0  te[7]=0  te[11]=-1 te[15]=0
```

`elements` is column-major and the matrix is applied as `clip = P · viewPos`, so
`te[8]` is `P[row 0][col 2]` and `te[11] = -1`. Therefore

```
clip.x = P00·x_view + P02·z_view
clip.w = -z_view
ndc.x  = (P00·x_view + P02·z_view) / (-z_view) = -P00·x_view/z_view - P02
```

so **adding `J` to `elements[8]` shifts NDC by `−J`**. Consequently:

> **three.js convention:** `ndc_jittered = ndc_unjittered − J_n`.
> A feature whose un-jittered position is `p` is rasterised at `p − jpx_n`; equivalently the
> pixel at `p` point-samples the scene at `p + jpx_n`. Un-jittered NDC = jittered NDC **+** `J_n`.

**This is the opposite sign to Unreal Engine**, which uses row-vector maths
(`clip = mul(pos, ViewToClip)`) and positive view-space `z`, giving
`ndc = ndc_unjittered + j`. Karis's slide
([TemporalAA_small.pdf, "Jittering"](https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf))
writes:

```
ProjMatrix[2][0] += ( SampleX * 2.0f – 1.0f ) / ViewRect.Width();
ProjMatrix[2][1] += ( SampleY * 2.0f – 1.0f ) / ViewRect.Height();
```

which is the same *magnitude* as `RenderPipeline._applyJitter` in this repo
(`jx = (halton(i,2) - 0.5) * 2.0 / this.w`) but the opposite *effect on NDC*. Do not
copy a sign from a UE/HLSL snippet without re-deriving it.

The existing `taa.js` comment and its `mvG = gb1.rg + 0.5 * uJitter` correction already encode
this sign correctly; I re-derived it independently from `makePerspective` and they agree.

### 1.2 The master equation

The velocity written for a fragment must be

```
velocity_ndc = u_n(x_n) − u_{n−1}(x_{n−1})
```

i.e. the un-jittered current NDC minus the un-jittered previous NDC. In three.js sign
convention, if you happen to have the *jittered* NDCs:

```
u_n     = ndc_n     + J_n
u_{n−1} = ndc_{n−1} + J_{n−1}

velocity_ndc = (ndc_n + J_n) − (ndc_{n−1} + J_{n−1})
             = (ndc_n − ndc_{n−1}) + (J_n − J_{n−1})       // three.js sign
```

and in UE/HLSL sign convention the correction is `−(j_n − j_{n−1})`. Either way:

> **Both jitters enter, and only as a difference.** Removing the current jitter alone is
> wrong. Removing neither is wrong. Removing the *delta* is right, and is identical to
> "compute both positions with un-jittered matrices".

The resolve then reads

```
prevUV = pixelCentreUV − velocity_uv,     velocity_uv = velocity_ndc * vec2(0.5, ±0.5)
```

(the `±` is your depth/UV y-orientation; in this repo MRT1 stores `(cur−prev)*0.5` with no
y flip because the render targets are already y-up in UV.)

### 1.3 Why this is right — the derivation that actually explains it

This is worth spelling out because the naive argument ("the history is at the previous
un-jittered position, so don't add the current jitter") gives the *wrong* answer, and people
talk themselves out of the correct formula.

The history buffer `H` lives on the **un-jittered pixel grid**: `H[p]` is an estimate of the
pixel-filtered radiance at un-jittered pixel centre `p`. Each frame contributes a point
sample taken at `p + jpx_n`, which is a *biased* estimate of `H[p]`, but the bias has zero
mean over the jitter sequence, so accumulation is unbiased. (Yang/Liu/Salvi, *A Survey of
Temporal Antialiasing Techniques*, §3.1 —
<http://behindthepixels.io/assets/files/TemporalAA.pdf>.)

For pixel `p` at frame `n`, the fragment that landed there has jittered NDC `≈ p`, so its
un-jittered current NDC is `u_n = p + J_n`. Let its un-jittered previous NDC be `u_{n−1}`.
Then

```
prevUV = p − velocity = p − (u_n − u_{n−1}) = p − (p + J_n) + u_{n−1} = u_{n−1} + J_n
```

The current jitter **reappears** in the lookup. That looks wrong and is exactly right: `u_{n−1}`
is the previous position of the *jitter-offset sample point*, not of the pixel centre, and the
`+ J_n` cancels that offset. Check it against the static case: static camera, static scene ⇒
`u_{n−1} = u_n = p + J_n` ⇒ `prevUV = p` exactly, the texel centre, so the Catmull-Rom resample
is the identity and nothing is lost. That is the whole point.

### 1.4 The three implementations you will meet in the wild — all equivalent

| Source | Matrices used | Correction applied | Reference |
|---|---|---|---|
| **UE4** | current jittered, previous jittered | subtract each matrix's own jitter | `Calculate2DVelocity`, below |
| **MJP `MSAAFilter`** | current jittered, previous jittered | subtract the delta `(j_n − j_{n−1})` | `BackgroundVelocity.hlsl`, below |
| **three.js `TRAANode` (r185)** | **both un-jittered** | none needed | `TRAANode.js`, below |

**UE4** — `Engine/Shaders/VelocityCommon.usf`
([mirror](https://raw.githubusercontent.com/raysjoshua/UnrealEngine/master/Engine/Shaders/VelocityCommon.usf)):

```hlsl
float2 Calculate2DVelocity(float4 PackedVelocityA, float4 PackedVelocityC)
{
    float2 ScreenPosition     = PackedVelocityA.xy / PackedVelocityA.w - View.ViewToClip[2].xy;
    float2 PrevScreenPosition = PackedVelocityC.xy / PackedVelocityC.w - View.PrevProjection[2].xy;

    // 2d velocity, includes camera an object motion
    float2 Velocity = ScreenPosition - PrevScreenPosition;
    return Velocity;
}
```

`View.ViewToClip[2].xy` is *literally the two matrix elements Karis's slide adds the jitter to*
— row 2, components x and y — for the current frame, and `View.PrevProjection[2].xy` the same
for the previous frame. This is the most direct citation available for "both jitters, each
removed from its own position".

**MJP** — `MSAAFilter/MSAAFilter.cpp` + `BackgroundVelocity.hlsl`
(<https://github.com/TheRealMJP/MSAAFilter>):

```cpp
jitterOffset = (jitter - prevJitter) * 0.5f;   // CPU: the delta, in half-pixels
prevJitter   = jitter;
```
```hlsl
float2 velocity = PositionSS.xy - prevPositionSS;
velocity -= JitterOffset;
return velocity / RTSize;
```

Both his current and previous view-projections are jittered, so the residual is exactly the
delta and he subtracts it.

**three.js r185's own TRAA** — `examples/jsm/tsl/display/TRAANode.js`, `setViewOffset()`:

```js
// save original/unjittered projection matrix for velocity pass
this._originalProjectionMatrix.copy( this.camera.projectionMatrix );
this._velocityNode.setProjectionMatrix( this._originalProjectionMatrix );
// ...then jitter via camera.setViewOffset(...)
```

and `src/nodes/accessors/VelocityNode.js` rolls `previousProjectionMatrix` forward from that
same un-jittered matrix. So the first-party three.js answer is **option 3: use un-jittered
matrices for both** — which is exactly the fix `docs/KNOWN_ISSUES.md` proposes.

**Cross-checks from other authorities** (all agree):

- Alex Tardif, *Temporal Antialiasing Starter Pack*: `float2 velocity = (currentPosNDC.xy - jitter) - (previousPosNDC.xy - previousJitter);` — <https://alextardif.com/TAA.html>
- Karis, SIGGRAPH 2014, "Reprojection" slide: *"Remember to remove jitter"* — <https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf>
- elopezr, *Temporal AA and the Quest for the Holy Trail*: *"Remember to remove the jitters in the space you've uploaded them in"* — <https://www.elopezr.com/temporal-aa-and-the-quest-for-the-holy-trail/>
- AMD FSR2 manual: *"Motion vectors should not have jitter applied, unless the `FFX_FSR2_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION` flag is present"*, and *"All inputs that are provided at Render Resolution, except for motion vectors, should be rendered with jitter"* — <https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-temporal/>

That last FSR2 sentence is also the exact answer to question (d): the *surfaces* are rasterised
jittered; the *motion vector values* carry no jitter.

### 1.5 What this repo actually does, and the exact fix

`RenderPipeline.render()` (verified):

```js
this.unjitteredProj.copy(cam.projectionMatrix);
this.prevViewProj.copy(this.currViewProj);                          // last frame, un-jittered
this.currViewProj.multiplyMatrices(this.unjitteredProj, cam.matrixWorldInverse);  // un-jittered
this._applyJitter(cam);                                             // now projectionMatrix is jittered
```

`scene.js`:

```js
gbufMat.uniforms.uCurrViewProj.value
  .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);  // JITTERED  ← bug
gbufMat.uniforms.uPrevViewProj.value.copy(pipe.prevViewProj);       // un-jittered
```

So the stored value is `mv_G = 0.5·(ndc_jittered_cur − u_{n−1})`, and the true value is
`0.5·((ndc_jittered_cur + J_n) − u_{n−1}) = mv_G + 0.5·J_n`. That is precisely the
`+ 0.5 * uJitter` compensation in `taa.js`. Sign and magnitude confirmed.

**Fix, in `src/render/passes/scene.js`:**

```js
gbufMat.uniforms.uCurrViewProj.value.copy(pipe.currViewProj);   // un-jittered, matches prev
gbufMat.uniforms.uPrevViewProj.value.copy(pipe.prevViewProj);   // un-jittered
```

**And in `src/render/passes/taa.js`, the same commit:**

```glsl
if (gb1.a > 0.5) {
  vec2 mvG = gb1.rg;                                   // was: gb1.rg + 0.5 * uJitter
  if (length((mvG - mv) * uRes) > 1.5) mv = mvG;
}
```

**Why this is safe — the thing worth verifying before you touch it.** `GBufferMaterial`'s
vertex shader computes `gl_Position` through `#include <project_vertex>`, which uses three's
own `projectionMatrix` uniform (the jittered one three uploads from `camera.projectionMatrix`).
`vCurClip` is computed separately from `uCurrViewProj`. **Un-jittering `uCurrViewProj` therefore
changes only the velocity output — rasterisation, depth and normals stay jittered.** That is
required: they must line up with the jittered colour buffer. The file's own comment ("gl_Position
MUST be computed exactly the way three's `<project_vertex>` does it") stays satisfied.

`pipe.currViewProj` is written *before* `_applyJitter` and scene passes run after, so it is
available and correct at that point.

Note also that `GBufferMaterial` already declares an unused `uJitter` uniform. The alternative
fix — keep the jittered `uCurrViewProj` and do `oMotionId.rg = (cur - prev) * 0.5 + 0.5 * uJitter;`
in the fragment shader — is equivalent and would let you flip between them for an A/B. Prefer the
matrix fix; it costs nothing per fragment.

### 1.6 The real blast radius (this is the part that de-risks the coupled commit)

`taa.js` gates the G-buffer velocity:

```glsl
if (length((mvG - mv) * uRes) > 1.5) mv = mvG;
```

The disagreement introduced by the jitter mismatch is, in pixels,
`|0.5 · J_n| · uRes = |jpx_n| ≤ (0.5, 0.5)`, magnitude `≤ 0.707 px`. **That is always below the
1.5 px trust threshold.** Therefore:

| `scene.js` | `taa.js` | static geometry | moving geometry |
|---|---|---|---|
| jittered (today) | `+0.5*uJitter` (today) | correct (depth path wins) | correct |
| un-jittered (fixed) | `+0.5*uJitter` (stale) | correct (depth path wins) | **0.5 px/frame error** |
| jittered (unfixed) | plain `gb1.rg` | correct (depth path wins) | **0.5 px/frame error** |
| un-jittered (fixed) | plain `gb1.rg` (fixed) | correct | correct |

So a half-fix does **not** produce "permanent, unrecoverable blur" across the frame, as
`KNOWN_ISSUES` warns — the depth-derived path already protects all static content. It produces
a sub-pixel per-frame velocity error confined to genuinely moving geometry (tracers, particles,
the viewmodel, animated props). Since none of those exist yet at Phase 1, **the two files can in
practice be fixed independently without a measurable regression on today's reference poses.**
They should still be fixed together, because the moment weapons/particles land the error becomes
visible as a soft comet-wake on moving highlights.

I would still run the determinism + `lap_var` check either side, but the "must be one person, one
commit" framing can be relaxed to "must be one commit".

### 1.7 The one test that catches every sign error at once

Do not reason about signs; measure. Add a debug readback:

```js
// Static camera, static scene, TAA jitter ON.
// Requirement: every pixel of gbuffer.textures[1].rg is EXACTLY 0.0.
```

Any non-zero value means one of: wrong jitter sign, missing previous-frame jitter, a
`prevMatrixWorld` that is stale by a frame, or a `y` flip. A `max(abs(mv))` reduction printed
once per frame is a 20-line debug pass and will save hours. Karis's slide is blunt about the
tolerance: *"Minor imprecision will streak a static image"*, and UE stores velocity at
**RG16F / 16:16**, not RG8.

`taa.js`'s depth-derived path already satisfies this invariant by construction (it unprojects
with the *jittered* inverse view-proj — exact for the pixel as rasterised — then re-projects
through un-jittered current and previous). That is the correct design and matches the survey's
Eq. 1 (`p_{n−1} = M_{n−1} M_n^{-1} p_n`), with the necessary refinement that `M_n^{-1}` must be
the **jittered** inverse because the depth buffer was rasterised jittered. Keep it.

---

## 2. (b) The standard TAA resolve

### 2.1 Jitter sequence: Halton(2,3), and how many phases

```js
// radical inverse; index MUST be 1-based (Halton(0,b) = 0 = no jitter)
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const jpx = [ halton(i, 2) - 0.5, halton(i, 3) - 0.5 ];   // pixels, in [-0.5, 0.5)
```

Identical in AMD's `ffxFsr2GetJitterOffset`
(<https://github.com/GPUOpen-Effects/FidelityFX-FSR2>, `src/ffx-fsr2-api/ffx_fsr2.cpp`):

```cpp
const float x = halton((index % phaseCount) + 1, 2) - 0.5f;
const float y = halton((index % phaseCount) + 1, 3) - 0.5f;
```

**Phase count in shipped engines:**

| Engine | Phases | Source |
|---|---|---|
| Unreal Engine 4 (default) | **8** | Survey §3.1, citing [Epi15] |
| Playdead INSIDE | **16** | `FrustumJitter.cs`, `Pattern.Halton_2_3_X16` |
| Alex Tardif's starter pack | **8** ("recommended starting sample count") | alextardif.com/TAA.html |
| three.js `TRAANode` r185 | 32 generated, **31 used** (`% (len - 1)`) | `TRAANode.js:337` |
| FSR2 | `8 · (displayWidth / renderWidth)²`, i.e. **8** at native | `ffxFsr2GetJitterPhaseCount` |
| **this repo** | 16 | `RenderPipeline._applyJitter` |

For a still-frame-judged renderer, 16 is a *cap on quality*: it is the number of distinct
sub-pixel sample positions you can ever accumulate. See §3.4 — go to 48 or 64 when static.

The first 16 values, so you can unit-test the generator:

```
i     halton(i,2)   halton(i,3)
 1    0.500000      0.333333   (1/3)
 2    0.250000      0.666667   (2/3)
 3    0.750000      0.111111   (1/9)
 4    0.125000      0.444444   (4/9)
 5    0.625000      0.777778   (7/9)
 6    0.375000      0.222222   (2/9)
 7    0.875000      0.555556   (5/9)
 8    0.062500      0.888889   (8/9)
 9    0.562500      0.037037   (1/27)
10    0.312500      0.370370   (10/27)
11    0.812500      0.703704   (19/27)
12    0.187500      0.148148   (4/27)
13    0.687500      0.481481   (13/27)
14    0.437500      0.814815   (22/27)
15    0.937500      0.259259   (7/27)
16    0.031250      0.592593   (16/27)
```

**A gotcha I have not seen documented anywhere, derived here:** the mean of these 16 offsets is
**not zero**. Exactly:

```
mean_x = 0.5 − 15/512 = 0.470703  →  offset −0.0292969 px
mean_y = 0.5 − 1/27   = 0.462963  →  offset −0.0370370 px
```

In a *correct* implementation this is harmless (your reconstruction kernel is centred 0.03 px
off the pixel centre, forever). In *any* implementation with residual jitter in the history
lookup it becomes a **DC drift term**: reading the history at `p + δ` and writing it back to `p`
translates the accumulated image by `−δ` every frame, damped by `α`, with steady-state
displacement `δ·(1−α)/α`. At `α = 0.09` and `δ = 0.03 px` that is a **~0.3 px systematic image
shift** relative to the un-TAA'd render — small, but it is a real, measurable, *constant* bias
and it will move your `structure`/`perceptual` scores against a reference. Cheap prophylactic:
subtract the cycle mean once at startup so `Σ_phases jpx = 0` exactly.

**Do not let the jitter be exactly zero** on any frame — FSR2 explicitly warns: *"care should be
taken that your jitter sequence never generates a null vector"*. `halton(i,·)` with `i ≥ 1` never
returns exactly 0.5 for both bases simultaneously, so 1-based indexing already satisfies this.
`(this.frameIndex % 16) + 1` in this repo is correct.

**Applying the jitter — two ways in three.js:**

```js
// (A) what this repo does: poke the projection matrix. NDC shifts by MINUS jx.
camera.projectionMatrix.elements[8] += 2 * jpx.x / W;
camera.projectionMatrix.elements[9] += 2 * jpx.y / H;
camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

// (B) what three's own TRAANode does: view offset. Survives updateProjectionMatrix().
camera.setViewOffset(W, H, jpx.x, jpx.y, W, H);   // clearViewOffset() afterwards
```

(B) is more robust — anything that calls `camera.updateProjectionMatrix()` mid-frame silently
destroys (A). But (B) rebuilds the whole matrix, so `unjitteredProj` must be captured *before*
the call (which is exactly what `TRAANode.setViewOffset` does). Given this repo already restores
the un-jittered matrix at the end of `render()`, (A) is fine; just be aware of the hazard.

### 2.2 Accumulation

Karis's slides give it directly:

```
s_t = α·x_t + (1 − α)·s_{t−1}                            (exponential moving average)
```

and the survey's Eq. 2 is the same with reprojection folded in:
`f_n(p) = α·s_n(p) + (1−α)·f_{n−1}(π(p))`.

**Effective sample count** for fixed `α` (survey Fig. 4, plotted from Yang et al. 2009 Eq. 30),
at the commonly used `α = 0.1`:

| frames accumulated | effective spp |
|---|---|
| 5 | 2.2 |
| 10 | 5.1 |
| 15 | 9.8 |
| ∞ (steady state) | **19** |

This repo's `α = 0.09` sits right there — roughly 21 effective samples at steady state, capped
by the 16 distinct jitter positions.

**Blend in tone-mapped space.** Karis:

```
T(c)    = c / (1 + luma(c))
T⁻¹(c)  = c / (1 − luma(c))
weight  = 1 / (1 + luma)
```

`taa.js`'s `tone()`/`untone()` are exactly this. Karis's slide notes that the *luma-weight* form
preserves chroma better than tone-mapping the colour outright ("Tone mapping desaturates bright
pixels"); this repo does the tone-map form. Both are in the slides as acceptable; the weight form
is his stated preference. Given tonemap/albedo desaturation has already been logged as a finding
in this project (commit `6bbf321`), the weight form may be worth an A/B.

three.js `TRAANode`'s `flickerReduction()` uses the weighted form with `max(r,g,b)` instead of
luma:

```js
compressed = color / (max(color.r, color.g, color.b) + 1);
currentWeight *= 1 / (1 + luminance(compressedCurrent));
historyWeight *= 1 / (1 + luminance(compressedHistory));
out = (cur*cw + hist*hw) / max(cw + hw, 1e-5);
```

### 2.3 Neighbourhood rectification — AABB clamp vs variance clip

Three escalating variants, all from primary sources.

**(i) Plain min/max clamp** (Lottes 2011, Malan 2012, via Karis): clamp history to the 3×3
min/max. Karis's slide: *"Simple clamp to min/max of 8 neighbors results in 3×3 box artifacts."*

**(ii) Rounded box + clip toward centre** (Playdead). From `TemporalReprojection.shader`
(<https://github.com/playdeadgames/temporal>, MIT):

```hlsl
// rounded 3x3: average the 9-tap box with the 5-tap '+' cross
float4 cmin5 = min(ctc, min(cml, min(cmc, min(cmr, cbc))));
float4 cmax5 = max(ctc, max(cml, max(cmc, max(cmr, cbc))));
float4 cavg5 = (ctc + cml + cmc + cmr + cbc) / 5.0;
cmin = 0.5 * (cmin + cmin5);
cmax = 0.5 * (cmax + cmax5);
cavg = 0.5 * (cavg + cavg5);
```
```hlsl
float4 clip_aabb(float3 aabb_min, float3 aabb_max, float4 p, float4 q)
{
    float3 p_clip = 0.5 * (aabb_max + aabb_min);
    float3 e_clip = 0.5 * (aabb_max - aabb_min) + FLT_EPS;   // FLT_EPS = 1e-8 desktop, 1e-4 mobile
    float4 v_clip = q - float4(p_clip, p.w);
    float3 v_unit = v_clip.xyz / e_clip;
    float3 a_unit = abs(v_unit);
    float  ma_unit = max(a_unit.x, max(a_unit.y, a_unit.z));
    if (ma_unit > 1.0) return float4(p_clip, p.w) + v_clip / ma_unit;
    else               return q;   // inside
}
```

Karis's rationale for clipping over clamping: *"Colors don't collect in box corners like clamping
does."* Per-channel clamping projects an out-of-gamut history onto a box *corner*, which is a
saturated, off-hue colour; clipping walks it back along the line toward the box centre and keeps
the hue.

`taa.js`'s `clipToAABB()` is this, plus an `amount` output used to drive `uClipBoost`. Correct.

**(iii) Variance clipping** (Salvi, GDC 2016,
<https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf>):

```
m1 = Σ c_i ,  m2 = Σ c_i²   over the 3x3   (N = 9)
mu    = m1 / N
sigma = sqrt(max(m2/N − mu², 0))
minc  = mu − γ·sigma
maxc  = mu + γ·sigma
history = clip_aabb(minc, maxc, clamp(mu, minc, maxc), history)
```

Salvi's own guidance, verbatim from the notes: *"We typically use gamma = 1 for good results.
Larger gammas produced more temporally stable results at the cost of increased ghosting. When
gamma is too small we lose the ability of integrating data over time."* He also recommends
clamping the variance AABB against the min/max AABB so it cannot be *larger* than it — which is
exactly what `taa.js` does with `rMin`/`rMax`.

Values in the wild: Salvi **γ = 1.0**; Tardif **γ = 1.0**; three.js `TRAANode`
`mix(0.5, 1.0, (1−motion)²)` with a code comment saying *"Reasonable gamma range is [0.75, 2]"*
that contradicts the code — do not copy three's numbers uncritically. This repo uses
**γ = 1.6 static / 0.85 moving**, i.e. *loosens* when still and *tightens* under motion.
That inversion relative to `TRAANode` is deliberate and, in my reading, right: rectification
exists to reject stale history, staleness requires motion, and loosening the box when still is
what preserves sub-pixel detail (see §2.4).

### 2.4 YCoCg-space clipping

Karis's argument: the RGB min/max AABB is axis-aligned in a space where the neighbourhood's
actual colour cloud is elongated along the *luma* axis (high local luma contrast, low local
chroma contrast). Re-orienting the box into YCoCg makes it a much tighter fit to the convex hull
without paying for the hull.

Transform (Intel's, used verbatim by Playdead and by `taa.js`):

```
Y  =  R/4 + G/2 + B/4
Co =  R/2       − B/2
Cg = −R/4 + G/2 − B/4

R = Y + Co − Cg
G = Y      + Cg
B = Y − Co − Cg
```

Playdead additionally *shrinks the chroma extent* to a fraction of the luma extent and re-centres
it on the current sample:

```hlsl
float2 chroma_extent = 0.25 * 0.5 * (cmax.r - cmin.r);
float2 chroma_center = texel0.gb;
cmin.yz = chroma_center - chroma_extent;
cmax.yz = chroma_center + chroma_extent;
cavg.yz = chroma_center;
```

`taa.js` converts to YCoCg but does **not** do this chroma shrink. Adding it is a ~4-line change
and is the standard extra defence against coloured ghosting on saturated moving objects (plasma
bolts, muzzle flash). It costs detail on genuinely chromatic edges, so A/B it. Note Playdead
themselves shipped INSIDE with `USE_YCOCG` *off* ("our implementation still supports it") — the
technique is Karis's, not theirs.

### 2.5 History resampling: Catmull-Rom

MJP's optimised bicubic, 9 taps (<https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1>),
reduced to 5 by dropping the corners. Weights:

```
samplePos = uv * texSize
texPos1   = floor(samplePos - 0.5) + 0.5
f         = samplePos - texPos1

w0 = f * (-0.5 + f * ( 1.0 - 0.5 * f))
w1 = 1.0 + f*f * (-2.5 + 1.5 * f)
w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f))
w3 = f*f * (-0.5 + 0.5 * f)

w12      = w1 + w2
offset12 = w2 / w12
```

`taa.js`'s implementation is the 5-tap version and is correct. Two properties worth knowing:

- **At `f = 0` it is the identity.** `w0 = w3 = 0`, `w1 = 1`, `w2 = 0`, `offset12 = 0`, so the
  single centre tap gets weight 1 and everything else 0. A stationary image loses nothing. This
  is the payoff for the exact-zero motion vector.
- **`w12 = 1 + 0.5f − 0.5f² ∈ [1, 1.125]` for `f ∈ [0,1]`**, so `w2/w12` never divides by zero.
  (Derived; the `max(s, 1e-5)` renormalisation in `taa.js` is belt-and-braces, harmless.)

Why bicubic at all: the survey §6.1.1 and its Fig. 8 show 100 iterations of repeated resampling.
Bilinear turns the image to mush; Catmull-Rom is dramatically better but still soft; the
Nehab–Hoppe generalised cubic quasi-interpolator is "almost visually lossless". Catmull-Rom is
the right cost/quality point and is what UE4 and SMAA T2x use.

**Catmull-Rom overshoots** (negative lobes) and can produce ringing / negative radiance. Clamp
the result to the neighbourhood min/max, or at minimum to `≥ 0`. `taa.js` does this downstream
via `san()` and the clip box.

### 2.6 Disocclusion

Four mechanisms, in increasing order of quality:

1. **Off-screen test.** `prevUV ∉ [0,1]²` ⇒ `α = 1`. Mandatory. `taa.js` has it.
2. **Velocity dilation** — sample the velocity of the *closest* fragment in a 3×3, not the
   fragment at the pixel. Karis: *"Moving silhouette edges lose AA… Dilate velocity — take front
   most velocity."* Playdead's `find_closest_fragment_3x3`; three's `TRAANode` uses
   `closestPositionTexel`. **`taa.js` does NOT do this.** It is the single cheapest remaining
   quality win for moving geometry, and it matters for tracers and the viewmodel. ~8 extra depth
   taps.
3. **Depth-plane test.** A scalar relative-depth tolerance cannot separate a grazing surface from
   a disocclusion. `taa.js`'s plane-slope tolerance
   `dz/dpixel = 2·z·|n.x|·tanX / (W·|n.z|)` is a correct and unusually good version of this;
   I have not found it published in this exact form, but it is the standard plane-fit
   depth-derivative bound and the derivation in the file checks out. Keep it.
4. **Colour rectification** (§2.3) — the catch-all. Survey §4: neighbourhood clamping
   *"significantly lessens the need for other history validation heuristics"*.

Do **not** use "velocity difference" (per-frame acceleration) as your primary rejection metric
if you have depth; elopezr describes it, but it fails for shading-only changes and for
translucency, and Karis explicitly lists both depth-compare and velocity-weighting as
insufficient on their own.

### 2.7 The current-frame reconstruction filter — and a bug in this repo's version

Karis's slide: *"Box filter is not stable under motion"*, and the fix is to weight the taps by a
reconstruction kernel:

```
Gaussian fit to Blackman-Harris 3.3:   W(x) = e^(−2.29·x²),  support ≈ 2 pixels
```
(citing [Burley07], *Filtering in PRMan*.)

`taa.js` (note 0) replaces the Gaussian with a **separable radius-1 tent centred on the
un-jittered pixel position**, weighting the 9 box taps by `W(o + jpx)`. **Its stated justification
is mathematically correct and I verified it**: the radius-1 tent is the linear B-spline, which
satisfies the Strang–Fix conditions of order 2 — `Σ_{o∈ℤ} tent(o+j) = 1` and
`Σ_{o∈ℤ} tent(o+j)·(o+j) = 0` exactly, for every `j`. A Gaussian satisfies neither, so its
discrete sum and first moment wobble with the jitter phase. For radius 1 and `|j| ≤ 0.5` the
support `|o+j| < 1` is entirely inside the 3×3, so the identities hold with the taps available
and `fsum ≡ 1`.

**But the `wide` term is broken.** The radius-2 tent `w(d) = max(0, 1 − |d|/2)` needs taps out to
`o = ±2` to be a partition of unity. Truncated to `o ∈ {−1,0,1}` (derived):

```
j = 0.0 :  w(-1) + w(0) + w(1)   = 0.5  + 1.0  + 0.5  = 2.00
j = 0.5 :  w(-0.5)+w(0.5)+w(1.5) = 0.75 + 0.75 + 0.25 = 1.75      ← 12.5% swing
```

Normalising by `wsum` fixes the *sum* but not the *shape*: the effective kernel is
phase-dependent, so `filt - wide` — the unsharp high-pass, scaled by `uSharp = 0.45` and added
straight back into the signal — reinjects exactly the phase-dependent term note 0 removed. This
is a real, checkable defect in a pass whose headline claim is phase stability. With full 5×5
support the sum is constant at 2.0 for every `j` (verified: `j=0.5` gives
`0.25+0.75+0.75+0.25+0 = 2.0`).

Fix options, cheapest first:
- Use a **radius-2 tent over a 5×5 window** for `wide` (16 extra taps; probably too expensive).
- Use a **second radius-1 tent evaluated on a 2-pixel-spaced grid** — i.e. sample at `±2` texels
  with the radius-1 tent — which is a partition of unity on that grid.
- Reduce `uSharp` and accept the residual (the swing is ~12.5 % of a high-pass term at 0.45
  strength, so ~5 % of the sharpening amplitude — small, but this is precisely the class of
  error the file spends 40 lines eliminating elsewhere).

Also: the comment above the `uFilter` clamp (*"below ~1.5 the 9-tap Gaussian is wider than its
own support"*) is stale from the Gaussian era and now reads as misinformation.

**The alternative, simpler approach used by Playdead**: don't reweight, just *resample* the
current frame and the neighbourhood at the un-jittered position:

```hlsl
#if UNJITTER_COLORSAMPLES
    float4 texel0 = sample_color(_MainTex, ss_txc - _JitterUV.xy);
#endif
#if UNJITTER_NEIGHBORHOOD
    float2 uv = ss_txc - _JitterUV.xy;
#endif
```

That costs a bilinear resample of the current frame every frame (blur) and is strictly worse than
the tap-reweighting this repo does. Mentioning it only so you recognise it in other codebases.

---

## 3. (c) Static camera, settling toward a converged still

### 3.1 Yes, the jitter must keep going

If you freeze the jitter when the camera is static, the accumulator converges to a single point
sample per pixel — i.e. exactly the aliased image, with the history contributing nothing but lag.
The whole mechanism *is* "distribute samples over multiple frames" (Karis, slide "Temporal
filtering"). The survey §6.3 is explicit: *"Since a different jitter offset is applied to the
viewport in each frame, the shading sample computed for a pixel changes every frame even when the
camera stays stationary. Typically, the difference is absorbed by the sample accumulation step to
provide the correctly filtered pixel."*

The failure mode of leaving jitter on is a *different* one, and it is the one Salvi names:
*"simply jittering the viewport might cause some extremely thin geometrical or lighting features
to fall between samples, entirely erasing its color contribution from the current color
distribution. When this happens variance can shrink significantly, causing every past color
contribution to be clipped against the current sample color. … If these events are repeated (for
instance due to jittering the viewport) they will cause flickering, even when nothing is moving on
the screen."*

That is precisely the defect `taa.js` note 7b (`uBoxExpand`) exists to fix, and its reasoning —
*"a pixel with a bit-exact zero motion vector and an accepted depth match has no stale history to
reject in the first place"* — is exactly right and is, as far as I can find, a better answer than
anything published. Salvi's own remedy is weaker (*"we can take care of it by using other
anti-aliasing methods"*). Keep it. It only works if the motion vector really is bit-exact zero,
which is §1 again.

### 3.2 With fixed α, the still NEVER converges — it enters a 16-frame limit cycle

This is the load-bearing point for a renderer graded on stills, and I derived it rather than
found it, so here is the derivation in full.

With `s_t = α·x_t + (1−α)·s_{t−1}` and `x_t` periodic with period `N` (the jitter cycle), the
steady state is

```
s_t^∞ = α · Σ_{k≥0} (1−α)^k · x_{t−k}
      = [ α / (1 − (1−α)^N) ] · Σ_{k=0}^{N−1} (1−α)^k · x_{t−k}
```

so within one period the phases carry weights `w_k ∝ (1−α)^k`, **not** uniform. The ratio between
the newest phase and the oldest is `(1−α)^(N−1)`. For this repo's `α = 0.09`, `N = 16`:

```
(1 − 0.09)^15 = 0.243          →  newest phase weighted 4.1× the oldest
normalisation α/(1−(1−α)^N) = 0.09/0.7789 = 0.11555
w_0 = 0.1156   (uniform would be 0.0625)
w_15 = 0.0281
```

**Consequences, all visible in your capture pipeline:**

- The converged still is a *biased* estimate of `s ⊛ W` — biased toward whichever four or five
  jitter phases happened to be most recent.
- `s_t^∞` is **periodic with period 16**, not constant. Frame 48 and frame 49 differ; frame 48 and
  frame 64 are identical. A "slow crawl" that a frame-to-frame difference test will report as
  "converged" is exactly this residual.
- Which still you get **depends on `frameIndex % 16` at capture time**. `--settle 48` is
  `48 = 3 × 16`, so the phase is deterministic *given the same start index* — but any change that
  shifts the start index (a skipped frame, a resize, `frames = 0` reset firing a frame later)
  silently changes the output image. Your `cmp` determinism check would catch this only if the
  perturbation is reproducible.

### 3.3 The fix: `α = 1/(n+1)` during settle

The survey states this directly (§3.3): *"we can store a per-pixel accumulated sample count
`N_t(p)` in the alpha channel of the history buffer. This value is initialized to 1 whenever the
pixel is refreshed, and is incremented every frame. By setting `α = 1/N_t(p)`, Eq. 2 assigns the
same weight to all history samples. It then enables optimal convergence rate at the cost of an
additional storage channel."* (Attributed to Yang et al. 2009.) Yang et al. also establish that
*"the optimal variance reduction is achieved when all samples are weighted equally"*.

This is exactly what three.js's `SSAARenderPass` does for its offline supersample
(`baseSampleWeight = 1.0 / jitterOffsets.length`, equal weights over a fixed jitter set) — the
converged-still case and the SSAA case are the same computation.

Concretely for this repo, a global (not per-pixel) frame counter is enough because the settle is
a static camera:

```js
// taa.js p.render(), replacing the fixed uAlpha
const nAcc = frames;                                    // frames already accumulated
const alphaConv = 1.0 / (nAcc + 1);                     // exact running mean
u.uAlpha.value = Math.max(cfgAlpha, alphaConv);
```

- Frame 0: `α = 1` (history invalid anyway).
- Frame 10: `α = 1/11 = 0.0909` — already at the tuned value, so no behaviour change for gameplay.
- Frame 47: `α = 1/48 = 0.0208`, and the running mean over 48 frames = **exactly 3 uniform passes
  of all 16 phases**. The still is the unbiased, phase-independent, deterministic answer.
- Because `max()` with the floor `0.09` clamps at `n ≈ 10`, interactive responsiveness is
  unchanged; only the settle benefits. If you want the full benefit you must *drop the floor*
  during capture — expose it as `taaAlphaFloor` and set it to 0 in the capture config.

**Caveat that must not be skipped:** with `α = 1/(n+1)` the accumulator has no forgetting, so any
disocclusion or shading change must reset `n` for that pixel, not just raise `α`. Since the
capture camera is static and the scene is (presumably) frozen at `--time t`, a global counter is
safe *for capture*. For gameplay, keep the per-pixel form or keep the floor.

### 3.4 Use more jitter phases when you are settling

With 16 phases and 48 frames you visit 16 distinct sub-pixel positions three times each: a hard
ceiling of **16× SSAA**. Halton is *progressive* — every prefix is well-stratified — so nothing
stops you from running `i = 1 … 48` (or 64) and getting 48 distinct positions. Combined with
§3.3's uniform weights that is a genuine 48× stratified supersample of every pixel, for free, on
exactly the metric this project is scored on (`detail`, `lap_var`, `spectrum`).

```js
// RenderPipeline._applyJitter
const PHASES = ctx.config.taaPhases ?? 16;      // capture config sets 48 or 64
const i = (this.frameIndex % PHASES) + 1;
```

Cheap insurance: pick a phase count **coprime with any periodic content** you have (three.js
`TRAANode` uses `% 31`, prime, apparently by accident). 48 = 2⁴·3 shares factors with a lot;
**47 or 61 are better choices** if you ever see a beat pattern. The survey §3.1 makes the general
point: *"With a short recurrent sequence, certain motion speed may cause sample locations from
multiple frames to cluster… By randomizing the jittering pattern, we can break regular cycles."*

### 3.5 How to *know* you have converged

Rank-ordered:

1. **Structural proof (best).** With `α = 1/(n+1)` and `n = k · PHASES` for integer `k`, the
   result is by construction the equal-weight mean of `n` samples. No measurement needed. This is
   the reason to prefer §3.3.
2. **Period-aware difference (necessary if you keep fixed α).** Compare frame `n` and frame
   `n − PHASES`, **not** `n` and `n − 1`. With a limit cycle of period 16, consecutive frames can
   differ by a lot while the process is stationary, and — worse — frames 16 apart can be identical
   while the process is *not yet* stationary early on. Require
   `max |I_n − I_{n−16}| < 1 code value (1/255)` over two consecutive checks.
3. **Cheap in-shader convergence probe.** Accumulate `Σ|H_n − H_{n−1}|` into a 1×1 target via
   mipmap reduction and read it back; stop when it crosses a threshold. Overkill here since the
   settle count is fixed.
4. **What NOT to trust.** A single frame-to-frame diff. It is exactly the metric a slow crawl
   defeats.

### 3.6 Static-settle checklist for this repo

- `α` ramp per §3.3 (biggest single win).
- `taaPhases` 48–64 during capture per §3.4.
- Rectification already relaxes to near-off at zero velocity via `uBoxExpand` — good. Consider
  making it a *hard* off when `vel == 0.0 && accept > 0.99 && frames > PHASES`: at that point the
  clip box can only remove real detail (survey §6.1.2, Fig. 9: "a thin foreground object is
  sampled in frame 0 and 2, but is completely missed in frame 1 and 3. The foreground color is
  then removed from the accumulated history in frame 1 and 3, leading to biased results").
- `uSharp` interacts badly with a fully converged image: the resolve is already `s ⊛ tent`, and
  the unsharp is a *deconvolution estimate*. Re-tune `taaSharpen` **after** the α ramp lands; the
  currently-tuned 0.45 was fitted against a partially-converged, phase-biased still.
- **Mip bias.** The survey gives `bias = −½·log₂(N_eff)`; for `N_eff = 4` that is `−1.0`, and
  *"in practice, a less aggressive bias between this value and 0 is sometimes preferred"*. With a
  16–48× converged still the theoretical bias is `−2` to `−2.8`, which would be far too
  aggressive for gameplay but is close to free for a still. **WebGL2 does not expose
  `GL_TEXTURE_LOD_BIAS`** (it is not in the WebGL2 spec —
  <https://github.com/mrdoob/three.js/issues/26564>), so the only route is the optional `bias`
  argument to `texture()` in GLSL ES 3.00 fragment shaders: `texture(map, uv, uLodBias)`. That
  means patching every material's texture fetch (`onBeforeCompile` string replace), which is
  invasive. A cheaper 80 % substitute for a still: raise `texture.anisotropy` to
  `renderer.capabilities.getMaxAnisotropy()` on everything (this repo already caches
  `this._maxAniso` in `RenderPipeline.init` but I could not find where it is used).

---

## 4. (d) Interaction with the G-buffer

### 4.1 The rule

> **Rasterise everything jittered. Store the motion vector un-jittered.**

There is no contradiction. The jitter determines *where the sample is taken*; the motion vector is
*a quantity measured at that sample*. FSR2 states the same requirement operationally: *"All inputs
that are provided at Render Resolution, except for motion vectors, should be rendered with
jitter."*

Concretely for `pipe.gbuffer`:

| target | jittered? | why |
|---|---|---|
| depth (`depthTex`) | **yes** (rasterisation) | must match the colour buffer pixel-for-pixel |
| MRT0 view normal + roughness | **yes** (rasterisation) | same |
| MRT1.rg motion vector | rasterised jittered, **value un-jittered** | the value is a displacement, not a position |
| MRT1.z material id | jittered | same |

### 4.2 The consequence for depth-based reprojection

Because the depth buffer *is* jittered, reconstructing world position from it requires the
**jittered** inverse view-projection:

```glsl
vec4 wp4 = uInvVPJit * vec4(vUv * 2.0 - 1.0, ndcZ, 1.0);   // uInvVPJit = camWorld * projInverse_JITTERED
vec3 wp  = wp4.xyz / wp4.w;
```

and then the *un-jittered* current and previous view-projections to form the velocity:

```glsl
vec2 curTrue  = (uCurrVP * vec4(wp,1.0)).xy / w * 0.5 + 0.5;   // un-jittered current
vec2 prevTrue = (uPrevVP * vec4(wp,1.0)).xy / w * 0.5 + 0.5;   // un-jittered previous
vec2 mv       = curTrue - prevTrue;
vec2 prevUV   = vUv - mv;
```

`taa.js` does exactly this and it is correct. Note the subtlety that makes it work: `curTrue` is
**not** `vUv` — it is `vUv + jitterUV`, because `wp` was unprojected from the jittered NDC. So
`vUv − mv = vUv − (vUv + jitter) + prevTrue = prevTrue − jitter`… and for a static camera
`prevTrue = vUv + jitter`, giving `prevUV = vUv` exactly. Same cancellation as §1.3, arriving from
the other direction. The `uInvVPJit` uniform being the *jittered* inverse is load-bearing; the
comment in `taa.js` (*"cam.projectionMatrixInverse is still the jittered one at post time — that
is exactly what unprojects the pixel as it was rasterised"*) is right, and depends on
`RenderPipeline.render()` restoring the un-jittered matrix only *after* the post chain. It does.
**If anyone ever moves the restore earlier, TAA breaks silently.** Worth a comment or an assert.

### 4.3 A defect I found: the viewmodel pass wipes the depth texture TAA reads

`RenderPipeline.init`:

```js
this.gbuffer.depthTexture = this.depthTex;
this.sceneRT.depthTexture = this.depthTex;   // SHARED
```

`scene.js`, step 7:

```js
renderer.setRenderTarget(pipe.sceneRT);
renderer.clearDepth();                       // clears pipe.depthTex — the shared one
renderer.render(scene, vm);
```

`WebGLRenderer.clearDepth()` clears the depth attachment of the **currently bound** render target,
which is `sceneRT`, whose depth attachment *is* `pipe.depthTex`. After this call the depth texture
contains 1.0 (far) everywhere except where viewmodel geometry drew, and the viewmodel's depth is
in *its own* near/far range (`0.002 … 12`, from `pipe.viewCamera`), which is not the main camera's
range at all.

Every post pass that reads `pipe.depthTex` runs after this: `taa` (its **primary** reprojection
path), `volumetricFog`, `ssr`, `ssao`, `dof`, `cloudComposite`. For TAA the result is that every
pixel unprojects to the far plane, so:

- with a static camera, `mv = 0` anyway and you would not notice;
- **the moment the camera moves, every pixel reprojects as if it were sky at infinity** — the
  entire frame smears along the camera-motion direction, and the plane-slope disocclusion test
  gets nonsense normals-vs-depth and rejects (or accepts) at random.

It has not bitten yet only because `weapons` is a stub and nothing is on `LAYER.VIEWMODEL`. This
will land as "TAA broke when we added the gun" and be misattributed. Fixes: give `sceneRT` its own
depth renderbuffer and blit/keep `depthTex` separately, or render the viewmodel into its own
target and composite, or (cheapest) snapshot `depthTex` into a second texture before step 7 and
point post passes at the snapshot. I have not verified this against a running build — it is a
read of the code plus the documented behaviour of `clearDepth()` — so confirm before acting.

### 4.4 Things with no valid motion vector

- **Sky** — `gb1.a = 0` in this repo, so the depth path handles it (unprojecting the far plane and
  reprojecting is *correct* for an infinitely distant sky, given a rotation-only camera delta).
  Good.
- **Transparent / water / particles** — the G-buffer pre-pass only draws `LAYER.OPAQUE` and
  `LAYER.DEFAULT`, so water and effects have no velocity and inherit whatever opaque surface is
  behind them. Karis: *"Translucency is a poor fit for temporal — single history, single
  velocity"*, and UE's answer is a stencil-tagged "Responsive AA" flag that forces a high `α` on
  those pixels. Note his warning that you still need `α < 1` there: *"Unfortunately need >0
  feedback to prevent visible jittering."* When `ocean.js` and `particles.js` come online, budget
  for a `MAT_ID`-driven `α` boost — `MAT_ID.WATER` and an effects id are already in the enum, so
  the plumbing exists (`gb1.z`).
- **The viewmodel** is not jittered at all (`pipe.viewCamera` never receives the jitter) and is not
  in the G-buffer. It will alias and shimmer under a TAA that thinks it is static background. Jitter
  `viewCamera` with the *same* `jpx` and give it velocity, or tag it and force `α = 1`.

---

## 5. (e) Failure modes, described so you can spot them in a screenshot

### 5.1 Jitter / velocity MISMATCH — the one you have

**In a still (static camera):** *nothing dramatic*. This is the trap. The image is not obviously
broken; it is **uniformly, gently soft**, like a 0.5–0.8 px Gaussian applied to the whole frame —
including regions that should be pin-sharp, such as a high-contrast horizon or a hard edge on a
Forerunner structure. Diagnostics:

- Fine, regular, high-contrast texture (sand grain, a starfield, a 1-px specular filament) loses
  contrast *without* losing position. Edges stay where they are; they just get a wider ramp.
- The softness is **isotropic and global**, not directional. This is what distinguishes it from
  motion smear.
- It is **invisible in a single-frame comparison** with TAA off if you only look at edges; it shows
  up in `lap_var` / high-frequency spectral energy, which is exactly why this project would catch
  it as a `detail`/`spectrum` regression and misattribute it.
- Superimposed on the blur, a **constant sub-pixel offset** of the whole image (~0.3 px, §2.1 —
  derived, not cited) relative to the un-TAA'd render. Detect by cross-correlating a TAA-on and
  TAA-off capture of the same pose; a non-zero peak offset is diagnostic.
- **The decisive test is not visual at all**: dump the velocity buffer with a static camera. Any
  non-zero pixel is the bug. See §1.7.

**In motion:** the mismatch adds ±0.5 px of *random* per-frame error on top of the real motion.
Visually that is **edge crawl on moving silhouettes** — a moving object's antialiased edge boils
between frames instead of translating smoothly — and a **soft, one-sided halo trailing the
direction of motion** (the history is being pulled from slightly the wrong place each frame, so
the accumulated edge is a smear rather than a ramp). Distinguishable from ordinary ghosting by
being *sub-pixel and symmetric about the edge*, not a visible second copy of the object.

### 5.2 Ghosting

A recognisable **second, faint copy of a moving object**, trailing it, persisting for roughly
`1/α ≈ 11` frames and fading exponentially. Sharpest where a bright object crosses a dark
background. In a still capture it appears as a *translucent duplicate*, correctly shaped, offset
along the motion path. Causes, in order of likelihood: history rectification defeated by a
high-contrast neighbourhood (survey Fig. 10 — grass, foliage, and *sand grain* all produce huge
colour bounding boxes that let anything through), motion vectors missing for the object, or the
`α` never being raised on disocclusion.

Note for this project: **beach sand and vegetation are the canonical worst case.** The survey's own
ghosting figure is a character running over grass, and the mechanism (`c` in that figure) is
exactly a large luma extent in the per-pixel bounding box. Expect it when `vegetation.js` lands.

### 5.3 Smearing

Not a discrete copy but a **continuous directional streak**, as if the frame were motion-blurred
along the camera path — and it covers *everything*, not just moving objects. This is the signature
of **globally wrong reprojection**: a bad previous view-projection, an off-by-one-frame
`prevMatrixWorld`, or (see §4.3) a depth buffer that no longer contains the depth you think it
does. Karis: *"Motion without correct velocity will smear."*

Distinguishing smear from ghosting in a still: smear has **no sharp leading edge** and affects
static background; ghosting has a recognisable object silhouette.

### 5.4 Edge shimmer / crawl (temporal instability) on a static camera

A thin feature — a 1-px filament, a distant spire, a star, a wet-sand sparkle — **pulses in
brightness with a period equal to your jitter cycle** (16 frames here). In a burst of consecutive
captures it is unmistakable; in one still it looks like the feature is *dimmer than it should be*
(the mechanism erases part of its energy).

Two distinct causes with different fixes:

1. **Variance-box collapse** (Salvi, quoted in §3.1): the feature falls between samples on some
   phases, `sigma` collapses, and the clip *snaps* the history. This is a hard jump, immune to `α`.
   Fix = relax the box when velocity is zero (`uBoxExpand`) or Karis's *"reduce blend factor when
   history is near clamping"*.
2. **Point-sampled input** (Karis's "Reconstruction filter" slide): the pixel is a point sample of
   a signal way above Nyquist, so its value swings between phases. Fix = a reconstruction kernel
   over the taps (§2.7).

If the pulse period is not 16 frames but 2, suspect a ping-pong bug (history read and write
aliasing) rather than jitter.

### 5.5 Over-blur

The whole image is soft *and* fine detail is gone rather than just low-contrast. Three sources,
distinguishable:

- **Resampling blur** — worsens with camera motion, recovers when you stop. Fix = Catmull-Rom
  (done), zero motion vectors when static (§1).
- **Rectification blur** — thin features specifically vanish while broad edges stay sharp
  (survey Fig. 9). Fix = looser `γ` when static.
- **The reconstruction kernel itself** — a radius-1 tent gives MTF 0.41 at Nyquist versus 0.64 for
  a box, as `taa.js`'s own notes state. This is a *deliberate*, permanent trade and it is the right
  one for a starfield, but it is also the reason `uSharp` exists, and it is why `taaSharpen` must be
  re-tuned after any change to `uFilter` or the α ramp.

### 5.6 Fireflies / bloom sparkle

Isolated bright pixels that survive TAA and then explode in bloom. Prevented by (a) TAA running
*before* bloom — Karis's *"Temporal AA is a firewall"* slide, which `taa.js`'s `_checkOrder`
correctly enforces as a warning — and (b) the `1/(1+luma)` weighting (§2.2). If you see it with
both in place, `san()`'s `clamp(..., 60000.0)` is not tight enough and you want a per-frame
neighbourhood-relative clamp on the current sample.

---

## 6. Compact reference: the whole thing, WebGL2 / GLSL 3.00

```js
// ---- CPU, once per frame, before any scene pass -------------------------------------
const PHASES = config.taaPhases ?? 16;           // 48-64 for a settle-and-capture pass
const i = (frameIndex % PHASES) + 1;             // 1-based: Halton(0,b)=0 => null vector
const jpx = new THREE.Vector2(halton(i,2) - 0.5, halton(i,3) - 0.5)
              .sub(SEQUENCE_MEAN);               // SEQUENCE_MEAN = (-0.0293,-0.0370) for 16
cam.updateMatrixWorld(true); cam.updateProjectionMatrix();

unjitteredProj.copy(cam.projectionMatrix);
prevViewProj.copy(currViewProj);
currViewProj.multiplyMatrices(unjitteredProj, cam.matrixWorldInverse);   // UN-jittered

jitterNDC.set(2 * jpx.x / W, 2 * jpx.y / H);
cam.projectionMatrix.elements[8] += jitterNDC.x;   // NDC shifts by MINUS this (three.js)
cam.projectionMatrix.elements[9] += jitterNDC.y;
cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

// G-buffer material: rasterises with the JITTERED projectionMatrix via <project_vertex>,
// but measures velocity with the UN-jittered pair:
gbufMat.uniforms.uCurrViewProj.value.copy(currViewProj);
gbufMat.uniforms.uPrevViewProj.value.copy(prevViewProj);
```

```glsl
// ---- G-buffer fragment ---------------------------------------------------------------
vec2 cur  = vCurClip.xy  / max(vCurClip.w,  1e-6);   // un-jittered NDC, frame n
vec2 prev = vPrevClip.xy / max(vPrevClip.w, 1e-6);   // un-jittered NDC, frame n-1
oMotionId = vec4((cur - prev) * 0.5, matId / 255.0, 1.0);   // UV-space; ZERO when static
```

```glsl
// ---- resolve -------------------------------------------------------------------------
// 1. depth-derived velocity for everything (exact for static geometry)
vec4  wp4 = uInvVPJit * vec4(vUv * 2.0 - 1.0, texture(tDepth, vUv).r * 2.0 - 1.0, 1.0);
vec3  wp  = wp4.xyz / wp4.w;
vec4  cc  = uCurrVP * vec4(wp, 1.0);      // UN-jittered
vec4  pc  = uPrevVP * vec4(wp, 1.0);      // UN-jittered
vec2  mv  = (cc.xy / cc.w - pc.xy / pc.w) * 0.5;

// 2. dilate + trust the G-buffer only where it genuinely differs (moving geometry)
//    -- use the CLOSEST fragment in the 3x3, not the centre one (Karis, Playdead)
vec4 gb1 = texture(tGbuf1, closestDepthUV);
if (gb1.a > 0.5 && length((gb1.rg - mv) * uRes) > 1.5) mv = gb1.rg;   // NO jitter term

vec2 prevUV = vUv - mv;                    // == vUv exactly when static

// 3. rectify + blend (see §2.3, §2.5)
vec3 hist = catmullRom(tHist, prevUV, uRes, uTexel).rgb;
hist      = clipToAABB(mu - g*sigma, mu + g*sigma, hist);
float a   = max(1.0 / float(nAcc + 1), uAlphaFloor);   // uniform-weight settle, §3.3
oCol      = vec4(mix(hist, cur, mix(1.0, a, accept)), linearViewZ);
```

---

## 7. Ranked recommendations for this codebase

1. **Fix `scene.js` + `taa.js` together** per §1.5. Low risk (§1.6). Do it first because
   everything else assumes zero velocity for static content.
2. **Add the `α = 1/(n+1)` settle ramp** (§3.3) and drop the floor in the capture config. This is
   the largest quality delta available for still-frame scoring and it also makes captures provably
   deterministic w.r.t. jitter phase.
3. **Investigate §4.3** (viewmodel `clearDepth()` on the shared depth texture) before `weapons`
   lands. If confirmed, it is a bigger TAA bug than the jitter one.
4. **Raise `taaPhases` to 48–64 during capture** (§3.4). Two-line change, strictly more samples.
5. **Fix or de-rate the truncated `wide` tent** (§2.7).
6. **Add closest-depth velocity dilation** (§2.6 item 2) — matters as soon as anything moves.
7. **Subtract the jitter-sequence mean** (§2.1) — trivial, removes a systematic sub-pixel bias.
8. **Re-tune `taaSharpen` after 2** — the current 0.45 was fitted against a phase-biased still.
9. Later, when translucency exists: `MAT_ID`-driven `α` boost for water/particles (§4.4).

---

## 8. What I could NOT verify

- **The `y` sign of the jitter in this repo's UV/NDC convention.** I verified the *x* derivation
  fully from `Matrix4.makePerspective` and it is consistent with `taa.js`'s existing (working)
  `+0.5 * uJitter` compensation. The `y` axis additionally involves the render-target UV
  orientation and the `(cur - prev) * 0.5` packing with no `y` flip, which I read but did not run.
  **Use the static-camera zero-velocity test (§1.7) rather than trusting my sign for `y`.**
- **The exact UE5 velocity code.** `EpicGames/UnrealEngine` is not publicly fetchable; the
  `Calculate2DVelocity` I quote is from a public UE **4.9-era** mirror
  (`raysjoshua/UnrealEngine`). The formula is unchanged in spirit in UE5 (it is the same one
  Karis's slides describe), but I did not read UE5 source. Treat the mirror as UE4, not UE5.
- **Playdead's `VelocityBuffer.shader`** — I read `TemporalReprojection.shader`, `FrustumJitter.cs`,
  `TemporalReprojection.cs` and `Extensions.cs`, but not the velocity generator, so I cannot say
  with certainty whether their per-object velocities are jittered or not. Their `_JitterUV` uniform
  carries `xy = current frame, zw = previous`, which is consistent with the delta form, but I did
  not confirm where `zw` is consumed. Their `UNJITTER_REPROJECTION` path un-jitters the *lookup
  coordinate* into the velocity buffer, which is a different (and additional) thing.
- **The ~0.3 px steady-state image shift** from the non-zero Halton mean under a residual-jitter
  bug (§2.1) is my own derivation from the EMA fixed point. I have not measured it and have not
  seen it published. The non-zero mean itself is arithmetic and is certain.
- **§4.3 (viewmodel `clearDepth`)** is a code read, not a reproduction. `WebGLRenderer.clearDepth()`
  acting on the bound target is documented three behaviour, and the depth texture sharing is
  explicit in `RenderPipeline.init`, but I did not run a build with viewmodel geometry present.
- **The MTF figures** quoted in `taa.js`'s own notes (0.64 box / 0.41 tent at Nyquist) I did not
  independently recompute; they are plausible and the *relative* ordering is certainly right.
- **Karis's PDF** was extracted with `pdftotext` from the CloudFront copy; slide *text* is verbatim
  but figures and any on-slide code in images are not captured. Where I quote him I quote the
  extracted text.
- **`renderer.capabilities.getMaxAnisotropy()`** is cached in `RenderPipeline.init` as `_maxAniso`
  but I could not find any consumer; I did not grep exhaustively.

---

## 9. Sources

- Brian Karis, *High Quality Temporal Supersampling*, SIGGRAPH 2014 Advances in Real-Time Rendering — <https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf>, index at <https://advances.realtimerendering.com/s2014/>
- Lasse Jon Fuglsang Pedersen, *Temporal Reprojection Anti-Aliasing in INSIDE*, GDC 2016 — slides <https://s3.amazonaws.com/arena-attachments/655504/c5c71c5507f0f8bf344252958254fb7d.pdf>, transcript <https://archive.org/stream/GDC2016Pedersen/GDC2016-Pedersen_djvu.txt>, source <https://github.com/playdeadgames/temporal> (MIT)
- Marco Salvi, *An Excursion in Temporal Supersampling*, GDC 2016 — <https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf>
- Lei Yang, Shiqiu Liu, Marco Salvi, *A Survey of Temporal Antialiasing Techniques*, Computer Graphics Forum 39(2), Eurographics 2020 STAR — <http://behindthepixels.io/assets/files/TemporalAA.pdf>, DOI <https://onlinelibrary.wiley.com/doi/abs/10.1111/cgf.14018>
- Alex Tardif, *Temporal Antialiasing Starter Pack* — <https://alextardif.com/TAA.html>
- Matt Pettineo (MJP), optimised Catmull-Rom — <https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1>; TAA + velocity reference implementation — <https://github.com/TheRealMJP/MSAAFilter>
- Unreal Engine 4 `VelocityCommon.usf` (public mirror) — <https://raw.githubusercontent.com/raysjoshua/UnrealEngine/master/Engine/Shaders/VelocityCommon.usf>
- AMD, *FidelityFX Super Resolution 2* manual — <https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-temporal/>; source <https://github.com/GPUOpen-Effects/FidelityFX-FSR2>
- Jorge Jimenez / elopezr, *Temporal AA and the Quest for the Holy Trail* — <https://www.elopezr.com/temporal-aa-and-the-quest-for-the-holy-trail/>
- three.js r0.185.1 first-party: `examples/jsm/tsl/display/TRAANode.js`, `src/nodes/accessors/VelocityNode.js`, `examples/jsm/postprocessing/SSAARenderPass.js`, `src/math/Matrix4.js`, `src/cameras/PerspectiveCamera.js` (read from `node_modules/three` in this repo)
- Brent Burley, *Filtering in PRMan* — <http://www.renderman.org/RMR/st/PRMan_Filtering/Filtering_In_PRMan.html> (source of Karis's `W(x) = e^(−2.29x²)` Blackman-Harris fit)
- Nehab et al., *Accelerating Real-Time Shading with Reverse Reprojection Caching* — <http://gfx.cs.princeton.edu/pubs/Nehab_2007_ARS/NehEtAl07.pdf>
- Yang et al., *Amortized Supersampling* (source of the `α = 1/N` uniform-weight result) — <http://www.cs.virginia.edu/~gfx/pubs/Yang_2009_AMS/yang2009.pdf>
- WebGL2 LOD-bias gap — <https://github.com/mrdoob/three.js/issues/26564>
