# weapons — first-person viewmodel rendering at AAA quality (three.js r0.185.1 / WebGL2)

Research brief for an implementer writing shader + pipeline code today.
Everything load-bearing is cited inline. Where I could not verify something, it says so
explicitly in a **UNVERIFIED** or **REASONED, NOT CITED** tag. Numbers without a tag are
either quoted from a cited source or derived by arithmetic from one, and the derivation is
shown so you can check it.

Repo context this was written against (read before implementing):
- `/workspace/zer0/products/halo/src/game/weapons.js` — MA5B viewmodel, 1925 lines, already
  procedural, already on `LAYER.VIEWMODEL`.
- `/workspace/zer0/products/halo/src/render/passes/scene.js` step 7 — the viewmodel draw.
- `/workspace/zer0/products/halo/src/render/RenderPipeline.js:115` —
  `viewCamera = new PerspectiveCamera(55, 16/9, 0.002, 12)`.
- `/workspace/zer0/products/halo/src/core/Engine.js:74` —
  `camera = new PerspectiveCamera(78, 16/9, 0.06, 12000)`.

---

## 0. Executive summary — the five things that actually decide whether this reads as AAA

1. **The viewmodel must occupy its own depth space, and the world's depth buffer must
   survive that.** Today `scene.js` calls `renderer.clearDepth()` on a target whose depth
   attachment *is* `pipe.depthTex`, which destroys world depth for every post pass that runs
   after. Section 1.6 gives three fixes with costs.
2. **The viewmodel FOV/world FOV ratio must be ~1.5.** Your current 55/78 gives
   `tan(39°)/tan(27.5°) = 1.5555`. Source ships 54/75 → `tan(37.5°)/tan(27°) = 1.5060`.
   You are already in the right place; do not "fix" it toward 1.0.
3. **Same sun direction as the world, different fill.** A private rig that ignores world sun
   azimuth is the single most instantly-readable "pasted on" tell.
4. **Fog/aerial must be excluded, and the reason is a depth-decode bug, not physics.** At
   0.4 m real aerial perspective is ~0.8% — invisible. What kills you is a depth-buffer fog
   pass decoding the viewmodel's depth with the *main* camera's near/far and getting 12 m.
   Arithmetic in §2.4.
5. **Hard-surface reads come from chamfer highlights, not from albedo.** Anisotropic GGX +
   curvature-driven roughness break + geometric specular AA. Sections 4.1–4.4.

---

# 1. Separate FOV and separate depth range

## 1.1 Why the problem exists at all

Two independent problems get conflated:

**(P1) Apparent size.** A weapon held at a realistic ~0.35–0.45 m from the eye, rendered at
a wide gameplay FOV (yours: 78° vertical / 110.4° horizontal at 16:9), is tiny and violently
perspective-distorted at the frame edge. Real shooters solve this by rendering the viewmodel
with a *narrower* FOV so it appears larger and flatter.
Source ships `viewmodel_fov` default `54`, described as approximating a 35 mm lens, against a
world default of `75` — both horizontal at 4:3
([Valve Developer Community — Viewmodel](https://developer.valvesoftware.com/wiki/Viewmodel);
default `54.0f` lives in `weapon_parse.h`). CS2's slider range is 54–68, default 60
([Total CS — FOV and Viewmodel commands](https://totalcsgo.com/commands/categories/fov-and-viewmodel)).
TF2 caps at 70 ([TF2 Wiki — Viewmodel](https://wiki.teamfortress.com/wiki/Viewmodel)).

**(P2) Interpenetration.** The weapon's muzzle sits ~0.5–0.9 m in front of the eye, which is
*inside* the player's collision capsule's forward clearance. Walk to a wall and the barrel
goes through it. Every shipping engine cheats this; nobody solves it with real collision.

These want different fixes. (P1) is a projection problem. (P2) is a depth problem.

## 1.2 FOV conventions — get this right first or every number below is wrong

three.js `PerspectiveCamera.fov` is the **vertical** full angle in degrees. Source/Quake FOV
cvars are **horizontal** full angle at 4:3. Conversion:

```
tan(fov_v/2) = tan(fov_h/2) / aspect
fov_v = 2 * atan( tan(fov_h/2) / aspect )
fov_h = 2 * atan( tan(fov_v/2) * aspect )
```

Worked, so you can check yourself:
- Source world 75° h @ 4:3 → `2*atan(tan(37.5°)/1.3333) = 2*atan(0.5755) = 59.9°` vertical.
- Source viewmodel 54° h @ 4:3 → `2*atan(tan(27°)/1.3333) = 2*atan(0.3821) = 41.8°` vertical.
- Your world 78° v @ 16:9 → `2*atan(tan(39°)*1.7778) = 2*atan(1.4396) = 110.4°` horizontal.
- Your viewmodel 55° v @ 16:9 → `2*atan(tan(27.5°)*1.7778) = 2*atan(0.9255) = 85.6°` horizontal.

The **only ratio that matters** for how the gun reads is the tangent ratio:

```
k = tan(fov_world/2) / tan(fov_viewmodel/2)      // both taken on the same axis
```

- Source: `tan(37.5°)/tan(27°) = 0.7673/0.5095 = 1.506`
- Yours:  `tan(39°)/tan(27.5°) = 0.8098/0.5206 = 1.555`

`k` is the linear magnification the narrower FOV buys you. `k ≈ 1.5` is the industry
consensus. `k = 1.0` (no separate FOV) makes the gun look small and bendy at the edges;
`k > 2` makes it look like a telephoto product shot glued to the screen — the barrel loses
all convergence and the whole model flattens.

**Aspect-ratio policy.** If you support non-16:9, keep the *vertical* FOV fixed and let
horizontal grow ("Vert−"/"Hor+"). If you instead keep horizontal fixed, `k` changes with
aspect and the gun changes size when the user resizes the window. `PerspectiveCamera.aspect`
is updated for `viewCamera` in `RenderPipeline.js:196`, so you are already Hor+. Good.

**35 mm-lens sanity check.** three.js gives you this for free:
`PerspectiveCamera.filmGauge` (default 35, mm) and `getFocalLength()`:
`focalLength = 0.5 * filmHeight / tan(fov_v/2)`, `filmHeight = filmGauge / max(aspect, 1)`.
For your `viewCamera` at 16:9: `filmHeight = 35/1.7778 = 19.69 mm`,
`f = 0.5*19.69/tan(27.5°) = 9.845/0.5206 = 18.9 mm`. So your viewmodel "lens" is an 18.9 mm
wide-angle on 35 mm — *not* the 35 mm-equivalent Valve describes. Source's 41.8° vertical on
a 4:3 35 mm frame: `filmHeight = 35/1.3333 = 26.25`, `f = 13.125/0.3821 = 34.4 mm` — that is
where Valve's "35 mm lens" claim comes from and it checks out. If you want the reference's
*flatter* barrel read, drop `viewCamera.fov` toward 45° v (→ `f = 23.7 mm`, `k = 1.955`); if
the barrel looks too converged/tapered, raise toward 60° (→ `k = 1.402`). Sweep `k` in
[1.35, 1.95], not `fov`, because `k` is what the eye sees.

## 1.3 Approach A — second camera + depth clear (what this repo does today)

```js
// scene.js step 7, current
const vm = pipe.viewCamera;
vm.position.copy(cam.position);
vm.quaternion.copy(cam.quaternion);
vm.updateMatrixWorld(true);
vm.layers.disableAll();
vm.layers.enable(LAYER.VIEWMODEL);
renderer.setRenderTarget(pipe.sceneRT);
renderer.clearDepth();
renderer.render(scene, vm);
```

This is the canonical three.js idiom (`autoClear=false` + `renderer.clearDepth()` between
renders; see the three.js forum thread
[Rendering a gun on another layer?](https://discourse.threejs.org/t/rendering-a-gun-on-another-layer/80805)
and [Render multiple views](https://discourse.threejs.org/t/render-multiple-views/57999)).
`WebGLRenderer.clearDepth()` clears only the depth attachment of the **currently bound**
framebuffer and ignores `autoClear`
([three.js Renderer docs](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.clearDepth)).

**Pros:** correct self-occlusion within the viewmodel; independent near plane; independent
FOV; zero shader work; one extra draw pass.
**Cons — and these are the ones biting you:**

1. It **destroys the shared depth texture**. `RenderPipeline.js:153,158` assign the *same*
   `DepthTexture` to both `gbuffer` and `sceneRT`. `clearDepth()` on `sceneRT` therefore
   wipes world depth for every consumer of `pipe.depthTex`: `volumetricFog`, `dof`, `ssr`,
   `taa`, `motionBlur`, `cloudComposite`. Your own source comments already record this
   (`dof.js:99-103`, `volumetricFog.js:66`, `motionBlur.js:58-64`) — this section is
   confirmation plus the fix menu, not a discovery.
2. Viewmodel pixels write depth in the **viewmodel camera's** clip space and are then decoded
   by post passes using the **main camera's** near/far. §1.7 quantifies the error.
3. The viewmodel is absent from the G-buffer, so no SSAO, no SSR, no motion vectors, no TAA
   velocity for it.

## 1.4 Approach B — `gl.depthRange` compression (what Source actually ships)

Source's `CViewRender::DrawViewModels` compresses the viewmodel into the *front tenth* of
the depth range rather than clearing depth:

```cpp
// HACK HACK: Munge the depth range to prevent view model from poking into walls, etc.
if ( bUseDepthHack )
    pRenderContext->DepthRange( 0.0f, 0.1f );
... draw opaque + translucent viewmodel lists ...
if ( bUseDepthHack )
    pRenderContext->DepthRange( 0.0f, 1.0f );
```

Verified against two independent mirrors of `game/client/viewrender.cpp`
([hl2sdk-bgt on hg.alliedmods.net](https://hg.alliedmods.net/hl2sdks/hl2sdk-bgt/file/f8823649f84a/game/client/viewrender.cpp),
[searchcode mirror](https://searchcode.com/codesearch/view/53281097/)). I could not fetch
either page's full text through this environment's proxy (403 / domain block), so the exact
surrounding lines are **UNVERIFIED**; the `DepthRange(0.0f, 0.1f)` call itself and the
`bUseDepthHack` guard are confirmed by both.

`gl.depthRange(zNear, zFar)` maps NDC z ∈ [−1, 1] linearly onto window z ∈ [zNear, zFar]
([MDN — WebGLRenderingContext.depthRange](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/depthRange)).
Setting `(0.0, 0.1)` guarantees every viewmodel fragment lands in window-z ≤ 0.1. World
geometry only reaches window-z ≤ 0.1 when it is *extremely* close — with your main camera
(n = 0.06, f = 12000), window-z = 0.1 corresponds to:

```
z_ndc  = 2*w - 1 = -0.8
d      = 2*n*f / (f + n - z_ndc*(f - n))
       = 2*0.06*12000 / (12000.06 + 0.8*11999.94)
       = 1440 / 21600.01
       = 0.0667 m
```

i.e. only 6.7 cm from the eye — inside the near clip for practical purposes. So the gun wins
the depth test against everything real, exactly as intended.

**three.js integration.** `WebGLState` in r185 never touches `gl.depthRange` (grepped:
`src/renderers/webgl/WebGLState.js` has `polygonOffset` handling but no `depthRange`), so a
direct GL call is safe and sticky — you must restore it yourself.

```js
const gl = renderer.getContext();
gl.depthRange(0.0, 0.1);
renderer.render(scene, vmCamera);     // no clearDepth()
gl.depthRange(0.0, 1.0);
```

**Pros:** world depth for non-viewmodel pixels survives intact — the single biggest win over
Approach A. Self-occlusion inside the viewmodel is still correct (relative ordering is
preserved by the linear remap). Works with the *main* camera's projection if you also apply
§1.5, which means the viewmodel can go into the G-buffer, TAA and SSAO.
**Cons:** viewmodel pixels still hold a nonsense linear depth (a 0.35 m fragment reads as
~0.067 m once decoded, which is *harmless* — near, so no fog, no far-DOF). Depth precision
inside the viewmodel drops to 1/10 of the buffer; with a 24-bit depth buffer that is still
~1.68 M steps across the gun, which is plenty. **REASONED, NOT CITED:** at 0.1 depth-range
width and a 0.06–12000 m frustum, the *worst* precision inside the viewmodel is at its far
end; you will not see z-fighting on a 0.9 m-deep object.

## 1.5 The projection-scale trick — separate FOV *without* a second camera

If you take Approach B you still need P1 solved. You can get an arbitrary viewmodel FOV out
of the *main* projection by pre-scaling the model in **view space**.

Derivation. A perspective projection maps view-space `(x, y, z)` (z negative, OpenGL
convention) to NDC:

```
x_ndc = x / ( aspect * tan(fov/2) * (-z) )
y_ndc = y / (          tan(fov/2) * (-z) )
```

You want the appearance of `fov_vm` while rendering with `fov_world`. Setting the two
expressions equal:

```
x / (aspect * tan(fov_vm/2) * -z)  ==  (k*x) / (aspect * tan(fov_world/2) * -z)
=> k = tan(fov_world/2) / tan(fov_vm/2)
```

So scale x and y (not z) by `k` in view space. In matrix form with **column vectors**
(three.js convention, `P·V·M·v`):

```
S     = diag(k, k, 1, 1)                    // acts in view space
M_adj = V⁻¹ · S · V · M
```

because `P · V · M_adj = P · V · V⁻¹ · S · V · M = (P·S) · V · M`, and `P·S` is exactly the
projection with `tan(fov_world/2)/k = tan(fov_vm/2)`.

This is the same construction Unreal implementers use, but note the correction: the widely
circulated writeup
([Sahil Dhanju — Render First-Person Meshes with a Separate FOV](https://sahildhanju.com/posts/render-first-person-fov/))
builds `P_adj = diag(world/viewmodel, world/viewmodel, 1, 1)` from the **ratio of half-angles
in radians** and then says the "results [are] not exact". They are inexact precisely because
the correct ratio is of **tangents**, not angles. For 39°/27.5°: angle ratio = 1.4182,
tangent ratio = 1.5555 — a 9.7% size error. Use tangents. Also note that writeup uses
row-vector convention (`M·V·P`), so its multiply order is mirrored relative to three.js.

three.js implementation (call once per frame, before render, on the viewmodel root):

```js
const _S = new THREE.Matrix4();
const _V = new THREE.Matrix4();
const _Vi = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();

function applyViewmodelFovScale(root, camera, fovWorldDeg, fovVmDeg) {
  const k = Math.tan(THREE.MathUtils.degToRad(fovWorldDeg) * 0.5) /
            Math.tan(THREE.MathUtils.degToRad(fovVmDeg)    * 0.5);
  _S.makeScale(k, k, 1);
  _V.copy(camera.matrixWorldInverse);
  _Vi.copy(camera.matrixWorld);
  // M_adj = V⁻¹ · S · V · M   →  prepend (V⁻¹ · S · V) to the root's world matrix
  _tmp.multiplyMatrices(_Vi, _S).multiply(_V);
  root.matrixAutoUpdate = false;
  root.updateMatrix();                       // local TRS -> root.matrix
  root.matrixWorld.multiplyMatrices(_tmp, root.matrix);
  root.updateMatrixWorld(true);              // children inherit
}
```

**Caveat you must handle:** this is a *non-uniform* scale in view space (x,y scaled, z not).
Normals transform by the inverse-transpose; three.js computes `normalMatrix` from
`modelViewMatrix`, so it is handled automatically per-mesh, **but** the scale is view-space
non-uniform and therefore *shears normals as the model rotates relative to the camera*.
Because the viewmodel is rigidly parented to the camera and its local rotation is only ±10°,
the shear is small (≤ a few degrees of normal error at k = 1.56).
**REASONED, NOT CITED** — I found no source that quantifies this. If specular highlights
crawl along the barrel when you sway, this is the cause; fall back to Approach A + B
(separate camera *and* depth range), which has no shear.

## 1.6 Recommended pipeline for this repo

Ranked. Pick one.

**Option 1 (cheapest correct, recommended).** Keep the second camera. Replace
`renderer.clearDepth()` with `gl.depthRange(0, 0.1)`, and give the viewmodel camera a
near/far chosen so its NDC output is *monotone with true distance* (it already is). World
depth survives; viewmodel pixels decode as ≤ 6.7 cm, which every depth-consuming pass treats
as "very near" — which is exactly the behaviour you want for fog (none) and for motion blur
(the near-suppression guard `mbNearSuppressM` in `motionBlur.js` starts working for real).

Problem: with a *second* camera you cannot use `depthRange` alone to keep depth meaningful,
because the viewmodel camera's near/far differ. Two sub-options:
- **1a.** Use the main camera for the viewmodel draw and apply §1.5's view-space scale.
  Then the depth written is genuinely the main camera's, compressed into [0, 0.1]. Fully
  consistent. This is Source's actual architecture.
- **1b.** Keep the viewmodel camera but set `viewCamera.near/far = camera.near/far` and get
  the FOV from `viewCamera.fov`. You lose the tight 0.002 near plane; check that nothing on
  the model is inside 0.06 m of the eye. (Your `MOUNT_POS.z = -0.395`; the closest vertex is
  the stock/glove, plausibly ~0.15 m. 0.06 m near is safe.) **Verify by capture** before
  committing.

**Option 2 (most flexible, costs one RT).** Render the viewmodel into its own render target
with its own depth attachment, then composite:

```js
// once
pipe.vmRT = makeRT(w, h, { type: pipe.opts.hdrType, depthBuffer: true });   // own depth
// per frame, after effects, before post
renderer.setRenderTarget(pipe.vmRT);
renderer.setClearColor(0x000000, 0);
renderer.clear(true, true, false);
renderer.render(scene, pipe.viewCamera);
```

Then composite `vmRT` over the post chain wherever you want it: **after** fog/DOF/SSR/motion
blur (so none of them touch it), **before** bloom/tonemap/grade (so the muzzle flash blooms
and the gun is graded with the frame). This is what most modern engines do and it is the
only option that gives you per-effect control. Cost: one full-res HDR RT + one full-screen
composite. At 1920×1080 RGBA16F that's 16.6 MB and ~0.15 ms of bandwidth.
**REASONED, NOT CITED** for the cost figure.

**Option 3 (do nothing, patch consumers).** Leave `clearDepth()` and give every depth
consumer a copy of world depth taken before step 7. WebGL2 can do this with
`gl.blitFramebuffer(..., gl.DEPTH_BUFFER_BIT, gl.NEAREST)` between two FBOs of identical
depth format. three.js does not expose this; you would call it on
`renderer.getContext()` with framebuffers obtained from
`renderer.properties.get(rt).__webglFramebuffer`. Fragile across three versions. Not
recommended, listed for completeness.

**Ordering rule that holds for all options:** the viewmodel must be *outside* SSAO, SSR,
volumetric fog, DOF-far, and motion blur; and *inside* bloom, tonemap, colour grade, grain,
and (arguably) sharpen. If it is outside tonemapping it will be the only object in the frame
in a different exposure and will read as a sticker instantly.

## 1.7 Depth decode error — the number that explains the fog bug

With the viewmodel drawn by `viewCamera` (n = 0.002, f = 12) and decoded by a pass using
`camera` (n = 0.06, f = 12000):

Encode (OpenGL, distance `d` > 0):
```
z_ndc = ( f + n - 2fn/d ) / ( f - n )
w     = 0.5 * (z_ndc + 1)                     // window depth, what's in the texture
```
Decode:
```
z_ndc = 2w - 1
d     = 2 n f / ( f + n - z_ndc (f - n) )
```

Worked for the viewmodel's mount distance and one nearer point:

| true distance | window z (vm cam) | decoded with main cam |
|---|---|---|
| 0.300 m | 0.99350 | **9.22 m** |
| 0.395 m | 0.99510 | **12.24 m** |
| 0.600 m | 0.99683 | **18.91 m** |

(0.300 → 9.22 m matches the ~9 m figure already recorded in `motionBlur.js:66-68`, which is
an independent confirmation that this arithmetic is right.)

Now the fog consequence. For an exponential extinction `σ` per metre, transmittance is
`T = exp(-σ d)`. At a plausible sea-level haze `σ = 0.02 /m`:

- physically correct at 0.395 m: `T = exp(-0.0079) = 0.9921` → **0.8% wash**. Invisible.
- what a depth-buffer fog pass computes: `T = exp(-0.02 * 12.24) = 0.7829` → **21.7% of the
  gun replaced by skylight**.

That 21.7% is why the weapon goes milky/blue and why `lum_mean 79.8 / lum_std 49.4` collapses.
It is not "aerial perspective is wrong for viewmodels" in a physical sense — it is a decode
bug amplified 31× (12.24 / 0.395). Both facts matter: **exclude fog** *and* **fix the
depth**, because if you only exclude fog, DOF and motion blur still see 12 m.

## 1.8 Depth precision, near planes, and why you cannot use reversed-Z

WebGL2 has **no** `glClipControl`, so the reversed-Z trick (near→1, far→0, float depth) is
unavailable; the request has been open on the WebGL registry since 2016
([KhronosGroup/WebGL#2197](https://github.com/KhronosGroup/WebGL/issues/2197)) and OpenGL
ES 3.0 — WebGL2's basis — does not expose it. So you are stuck with standard `d = a/z + b`
hyperbolic depth, whose precision collapses as `near` shrinks
([Nathan Reed — Depth Precision Visualized](https://www.reedbeta.com/blog/depth-precision-visualized/):
"pulling in the near plane will make the `d` range skyrocket up toward the asymptote";
NVIDIA's [Visualizing Depth Precision](https://developer.nvidia.com/blog/visualizing-depth-precision/)
says the same).

Practical consequences for you:
- `viewCamera.near = 0.002` (2 mm) is aggressive. If the closest geometry on the gun is
  ≥ 0.10 m, raise near to **0.05 m**. That alone improves the near/far ratio 25× and buys
  back precision across the whole model. Measure the closest vertex; do not guess.
- Do **not** enable `logarithmicDepthBuffer` for this. It costs a per-fragment `gl_FragDepth`
  write, which disables early-Z on the whole material, and it does not help a 0.05–12 m
  frustum ([three.js docs — logarithmicDepthBuffer](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.logarithmicDepthBuffer)).
- `pipe.depthTex` is `THREE.FloatType` (`RenderPipeline.js:137`). Reed's measurements show
  float vs int24 makes essentially no difference in the *non*-reversed configuration
  ("there is no difference between float and integer depth buffers in most setups; the
  arithmetic error swamps the quantization error"). Do not expect float depth to save you.

## 1.9 ADS (aim-down-sights) and FOV

Two FOVs animate at once and they must be animated *consistently* or the world appears to
lurch relative to the gun.

- World FOV zooms in on ADS by a factor equal to the sight magnification. For a 2× red dot,
  `tan(fov_ads/2) = tan(fov_hip/2) / 2`. With your 78° v hip:
  `tan(39°)/2 = 0.4049` → `fov_ads = 2*atan(0.4049) = 44.0°` vertical.
- Viewmodel FOV should zoom **less**, or not at all, otherwise the gun grows enormously.
  Source-family games keep viewmodel FOV fixed during ADS; the *model* moves toward the eye
  instead. Your `ADS_POS.z = -0.335` vs `MOUNT_POS.z = -0.395` does exactly that (a 15%
  approach) — keep it.
- Blend both with the **same** easing curve and the same duration or you get "FOV swim".
  Interpolate `tan(fov/2)` linearly, **not** `fov` — linear-in-degrees zoom looks like it
  accelerates at the end. `fov(t) = 2*atan( mix(tan(fovA/2), tan(fovB/2), e(t)) )`.
  **REASONED, NOT CITED**, but it falls straight out of the projection algebra above.
- Duration: see §3.6.

---

# 2. Viewmodel lighting

## 2.1 Why a dedicated rig exists, and why you should only half-adopt it

The historical reason is technical: in several engines viewmodels simply are not reachable by
the world's dynamic lights, so studios bolt on a private rig. Godot users put the viewmodel
on a visual layer, put lights on the same layer, and render it through a `SubViewport`; the
Source Filmmaker equivalent is that "viewmodels aren't affected by non-static lighting"
(both summarised in the
[Unity/Godot/SFM discussion set surfaced by search](https://discussions.unity.com/t/rendering-of-first-person-weapon-model/719196)
— I could not fetch the primary pages, so treat the *engine-specific claims* as
**UNVERIFIED**; the *pattern* is uncontroversial).

The **artistic** reason is the one that should drive your decision:

1. A viewmodel is on screen 100% of the time. If it goes fully black in shadow, a quarter of
   every frame goes black, and the reference's `p01 = 17` floor (per
   `/workspace/zer0/products/halo/src/render/lighting.js` header) is violated.
2. A viewmodel is ~0.4 m from the eye, so it never receives the world's *spatial* lighting
   variation. Every shadow cascade texel it samples is from the same cascade at the same
   distance. It has no meaningful shadow story of its own.
3. It never moves relative to the camera, so any lighting that depends on camera-relative
   position (specular lobes, Fresnel) is *frozen*. This is what makes viewmodels look like
   they have a light stuck to them. Fixing it requires the light directions to change as the
   player turns — which means world-space light directions.

The synthesis, and what `weapons.js` already does correctly (see its header contract), is:

> **Take the world's sun direction and intensity verbatim. Take the world's sky and bounce
> fills verbatim. Add exactly one private element: a small camera-relative fill that lifts
> the shadow side off zero. Never add a private key light.**

## 2.2 The concrete rig

| element | source | value | why |
|---|---|---|---|
| key (sun) | world `time.sunDir`, world intensity | unchanged | as the player turns, the barrel highlight sweeps. This *is* the effect. |
| sky fill | world hemisphere | unchanged | blue on top surfaces |
| bounce fill | world warm ground bounce | unchanged | warm under-lighting from sand |
| **viewmodel-only fill** | camera-relative | dir = normalize(camera forward + 0.35·camera up), intensity **0.06–0.12** of sun | lifts the shadow side; kills the "black gun" |
| specular IBL | small PMREM from `sky.radiance()` | 64–128 px cube | without this a metallic viewmodel is black except in the sun lobe |
| muzzle flash | transient point light at the muzzle | §2.5 | |

The viewmodel-only fill must be **diffuse-dominant and low**. If it is strong enough to cast
a visible specular lobe, the gun acquires a highlight that never moves when the player turns
— the exact tell you are trying to avoid.

**three.js layer plumbing.** `three` only collects a light if `light.layers.test(camera.layers)`
passes. Since your viewmodel camera has `layers` restricted to `LAYER.VIEWMODEL`, every world
light you want on the gun must have `LAYER.VIEWMODEL` *enabled in addition to* its existing
mask — widening a light's mask is strictly additive, so nothing else changes. `weapons.js`
already documents this at lines 1707–1714. The reverse is what you want for the private fill:
`fill.layers.set(LAYER.VIEWMODEL)` so it *only* touches the gun.

## 2.3 Shadows on the viewmodel

Do **not** run CSM on the viewmodel; the cascades are sized for 340 m and the first cascade
texel at 2048² is far too coarse for a 0.9 m object, so you get either nothing or a giant
soft blob. Instead:

1. **Receive** the world's shadow as a single scalar. Sample the shadow map once at the
   *player's* position, get a 0..1 "am I in shade" term, and multiply the viewmodel's sun
   contribution by it. This makes the gun correctly go dark when you walk under an overhang,
   which is the only shadow event a player notices.
2. **Self-shadow** with baked ambient occlusion instead of shadow maps. Because the geometry
   is procedural, you can compute a cheap per-vertex AO at build time: for each vertex, cast
   N=32 cosine-weighted rays against the merged geometry's bounds and store the visibility in
   a vertex attribute. Cost is one-time. This is what gives you the dark line under the
   carry handle and inside the magazine well.
3. **Contact darkening between hand and weapon** is worth faking explicitly: a small
   proximity-based multiplier on the glove where it wraps the grip.

## 2.4 Excluding aerial perspective / fog — exactly what to do

Three separate mechanisms can fog your gun. Kill all three.

**(i) three.js built-in fog.** `Material.fog = false` on every viewmodel material. This
removes the `fog_fragment` chunk entirely at compile time.

**(ii) Your custom aerial-perspective injection.** `materialCommon.js:117` already keys off
`o.aerial !== false`, and `weapons.js` passes `{ aerial: false }`. Verify no viewmodel
material bypasses `applyWorldMaterial`. Grep for `new THREE.Mesh*Material` inside `weapons.js`
and check each one.

**(iii) Screen-space fog / volumetric passes that read depth.** These do not care about
material flags. Either fix the depth (§1.6) or add an explicit stencil/mask. The cheapest
mask with no extra attachment: write a viewmodel flag into an unused channel of the G-buffer
or of `sceneRT`'s alpha, and have `volumetricFog`, `dof` and `motionBlur` early-out on it.
`volumetricFog.js:130` already has a `uUseNormalMask` uniform doing something similar for the
G-buffer test — extend the same idea.

**Physical justification for excluding it, stated plainly:** at 0.4 m, for any atmosphere you
would render in a Halo ring exterior, in-scattering is ≤ 1% (arithmetic in §1.7). The "correct"
answer and "no fog at all" differ by less than one 8-bit code value. There is no visual cost
to excluding it and a 21.7% cost to getting it wrong.

**One exception worth implementing:** heavy, *local* volumetrics — a smoke grenade, a dust
plume — genuinely should touch the gun, because the player is *inside* the medium. Handle
that with an explicit uniform (`uLocalFogDensityAtCamera`) applied uniformly to the whole
viewmodel, not with depth-based fog.

## 2.5 Muzzle flash lighting

Real small-arms muzzle flash in the visible band lasts **1–2 ms**, occasionally up to 7 ms for
30-06, and associated IR under 30 ms
([Temporal Characterization of Small Arms Muzzle Flash in the Broadband Visible](https://www.researchgate.net/publication/224244255_Temporal_Characterization_of_Small_Arms_Muzzle_Flash_in_the_Broadband_Visible)).
Games stretch this: VFX practice is **2–4 frames** for rifles, i.e. **33–66 ms at 60 fps**
(pistols 1–3 frames, shotguns 2–5)
([mycreativefx muzzle flash reference](https://mycreativefx.com/blog/357-free-muzzle-flash-vfx-download-4k-gun-effects-for-video-editing)).

Implementation values (**REASONED, NOT CITED** — derived from the above plus the frame budget):

```
flash light:  PointLight at the muzzle, world-space
  colour      #ffd9a0 → #ff9040 over its life (2700 K → 1800 K equivalent)
  peak power  ~ 8–20 × sun irradiance at the muzzle, i.e. enough to blow the barrel
              to 1.0 for 1 frame after tonemap. Tune against the tonemapper, not in lux.
  radius      0.6–1.2 m falloff (it should light the barrel and the glove, nothing else)
  envelope    rise 0 ms (instant), hold 16 ms, decay to 0 by 55 ms, curve = t^3
  layers      LAYER.VIEWMODEL + LAYER.OPAQUE  (it should also splash on nearby walls)
```

The `t^3` decay matters: a linear decay reads as a strobe, a cubic reads as a flash. Also
**randomise peak by ±25% per shot** — identical flashes at 600 RPM read as a UI element.

## 2.6 Exposure and tonemapping

The viewmodel must go through the same tonemap and the same exposure as the world. If you
adopt Option 2 (separate RT) in §1.6, composite **before** `tonemap.js`. If you composite
after, the gun will be the only thing in the frame not obeying the auto-exposure and it will
pop every time the player looks at the sky.

Your measured viewmodel target (`weapons.js` header) is `lum_mean 79.8` against a frame mean
of ~108 (79.8 is stated as 26% below frame mean). That is a *dark object in bright sun* —
which means the gun's albedo must be low (0.03–0.08 linear for the black polymer, see §4.5)
and the brightness must come from **specular on chamfers**, not from raising base colour.
Raising albedo to hit `lum_mean` is the single fastest way to make it look like a toy;
`weapons.js:655` already says this.

---

# 3. Procedural weapon motion

## 3.1 The five layers, and the order they compose

```
final_transform =
    mount_pose (or ADS pose, blended by `a`)
  ∘ idle_sway            // never stops, lowest amplitude
  ∘ walk_bob             // scales with horizontal speed
  ∘ look_lag             // driven by angular velocity of the camera
  ∘ recoil               // impulse + spring recovery
  ∘ landing              // vertical impulse on ground contact
```

They are additive in **local (view) space**, applied about a pivot at the weapon's centre of
mass — `weapons.js:63` already defines this pivot. Rotating about the muzzle instead makes
the gun swing like a pendulum, which reads as weightless.

## 3.2 Walk bob — the Quake equation, verified

From `WinQuake/view.c`
([id-Software/Quake](https://raw.githubusercontent.com/id-Software/Quake/master/WinQuake/view.c)):

```c
float V_CalcBob (void)
{
	float	bob, cycle;

	cycle = cl.time - (int)(cl.time/cl_bobcycle.value)*cl_bobcycle.value;
	cycle /= cl_bobcycle.value;
	if (cycle < cl_bobup.value)
		cycle = M_PI * cycle / cl_bobup.value;
	else
		cycle = M_PI + M_PI*(cycle-cl_bobup.value)/(1.0 - cl_bobup.value);

	bob = sqrt(cl.velocity[0]*cl.velocity[0] + cl.velocity[1]*cl.velocity[1]) * cl_bob.value;
	bob = bob*0.3 + bob*0.7*sin(cycle);
	if (bob > 4)  bob = 4;
	else if (bob < -7) bob = -7;
	return bob;
}
```

Cvar defaults, same file: `cl_bob 0.02`, `cl_bobcycle 0.6`, `cl_bobup 0.5`.
Half-Life/GoldSrc ships `cl_bob 0.01`, `cl_bobcycle 0.8`, `cl_bobup 0.5`
([Steam Workshop — Quake/Half-Life View bobbing](https://steamcommunity.com/sharedfiles/filedetails/?id=378401390),
cross-checked against the [SourceRuns wiki cl_bob page](https://wiki.sourceruns.org/wiki/Cl_bob)).
CS:GO/CS2 stock: `cl_bobcycle 0.98`, `cl_bob_lower_amt 21`, `cl_bobamt_lat 0.33`,
`cl_bobamt_vert 0.14`
([Total CS](https://totalcsgo.com/commands/categories/fov-and-viewmodel)).

Two things worth stealing and one worth discarding:

**Steal 1 — `cl_bobup` asymmetry.** The piecewise remap makes the up-phase occupy
`cl_bobup` of the period and the down-phase `1 - cl_bobup`. At 0.5 it's symmetric; at
**0.35** the weapon snaps up quickly and settles down slowly, which is what a footfall
actually does. This is a one-line change with a disproportionate payoff. GLSL/JS:

```js
function bobCycle(t, period, up) {
  let c = (t % period) / period;
  return (c < up) ? Math.PI * c / up
                  : Math.PI + Math.PI * (c - up) / (1 - up);
}
```

**Steal 2 — the `0.3 + 0.7·sin` DC offset.** `bob = A*(0.3 + 0.7*sin(cycle))` never goes
negative for positive A, so the weapon is always *displaced* while moving, not just
oscillating. That reads as "carrying something heavy while walking".

**Discard — the amplitude.** HL at 320 u/s with `cl_bob 0.01` gives 3.2 units of bob.
Taking 1 GoldSrc unit ≈ 0.0254 m (player is 72 units ≈ 1.83 m), that's **8.1 cm** peak.
Modern shooters are an order of magnitude below that.

**Your current values** (`weapons.js:1848-1853`) — vertical 0.70 cm, lateral 0.45 cm, roll
0.020 rad = 1.15° at full speed — are in the modern range and are good. Keep them.

**Frequency.** Your `bobPhase += dt * (5.6 - sprint*1.4) * min(1.4, 0.35 + speed*0.24)`
evaluates at 4.6 m/s to `5.6 * 1.4 = 7.84 rad/s = 1.25 Hz` for the lateral term and
`sin(2·bp) = 2.50 Hz` for the vertical. That is the correct biomechanical relationship
(vertical oscillates once per footfall, lateral once per *stride* = two footfalls) and
2.5 footfalls/s is a realistic run cadence. Do not change it.

**Figure-of-eight.** `x = A_x·sin(φ)`, `y = A_y·sin(2φ)` traces a lemniscate. If you want the
gun to trace it in a consistent direction (it should — a right-handed shooter's weapon traces
the same loop every stride), use `y = A_y·sin(2φ + ψ)` with `ψ ≈ 0.4 rad`; ψ = 0 gives a
degenerate figure-eight that reverses direction.

## 3.3 Look lag / inertia — what Quake *meant* to do

`CalcGunAngle` in the same file is worth reading, with a caveat:

```c
	yaw = r_refdef.viewangles[YAW];
	pitch = -r_refdef.viewangles[PITCH];

	yaw = angledelta(yaw - r_refdef.viewangles[YAW]) * 0.4;
	if (yaw > 10)  yaw = 10;
	if (yaw < -10) yaw = -10;
	...
	move = host_frametime*20;
	if (yaw > oldyaw) { if (oldyaw + move < yaw) yaw = oldyaw + move; }
	else              { if (oldyaw - move > yaw) yaw = oldyaw - move; }
```

Note `yaw` is assigned `viewangles[YAW]` and then immediately used in
`yaw - r_refdef.viewangles[YAW]`, which is identically zero. **In shipped Quake this lag term
is a no-op.** I am confident of the reading; I have not found a source that states it, so
treat "it's a known bug" as **UNVERIFIED** — but the arithmetic is on the page above.

The *intended* design, which is what you should implement, is clear from the surviving
constants:
- lag gain **0.4** (the gun rotates 0.4× the accumulated view delta),
- clamp **±10°**,
- slew rate limit **20 °/s** (`host_frametime*20` per frame).

The 20 °/s slew is the important one: it means the lag *cannot* snap. Modern equivalents use
a critically-damped spring instead, which gives the same non-snapping behaviour with better
settling. Use the spring (§3.5) with a hard clamp at ±10° pitch and ±10° yaw, and keep the
0.4 gain.

**Sign convention:** the gun lags *behind* the camera, so a fast right-turn pushes the gun
*left* in view space. Your `localPos.x += ... - st.lagYaw * 0.075` (`weapons.js:1878`) has
the right sign for a positive-yaw-is-left convention — confirm against a capture, this is
the single easiest thing to get backwards.

**Positional lag too, not just rotational.** Rotation-only lag reads as the gun pivoting in
place. Add ~7 cm of lateral translation per radian of accumulated yaw error (your `0.075`
coefficient is exactly this) and ~6 cm per radian of pitch (`0.060`). Both correct.

## 3.4 Recoil — Source's spring, and its actual characteristics

Source's view punch, from `game/shared/gamemovement.cpp` /
`CBasePlayer::DecayPunchAngle`:

```cpp
#define PUNCH_DAMPING         9.0f   // bigger number makes the response more damped
#define PUNCH_SPRING_CONSTANT 65.0f  // bigger number increases the speed at which the view corrects

m_Local.m_vecPunchAngle += m_Local.m_vecPunchAngleVel * gpGlobals->frametime;
float damping = 1 - (PUNCH_DAMPING * gpGlobals->frametime);
if ( damping < 0 ) damping = 0;
m_Local.m_vecPunchAngleVel *= damping;
float springForceMagnitude = PUNCH_SPRING_CONSTANT * gpGlobals->frametime;
springForceMagnitude = clamp(springForceMagnitude, 0, 2);
m_Local.m_vecPunchAngleVel -= m_Local.m_vecPunchAngle * springForceMagnitude;
```

Constants confirmed via search of the alliedmods `hl2sdk-csgo` and `hl2sdk-l4d2` mirrors
([hl2sdk-csgo gamemovement.cpp](https://hg.alliedmods.net/hl2sdks/hl2sdk-csgo/file/89079a96c198/game/shared/gamemovement.cpp),
[ValveSoftware ViewPunch wiki page](https://developer.valvesoftware.com/wiki/ViewPunch)).
The full function body is **UNVERIFIED** (I could not fetch either page's raw text through
this proxy); the two `#define` values and the structure are confirmed by both sources.

**Derive what those constants actually mean.** The continuous ODE is `v̇ = −k·x − c·v` with
`k = 65 s⁻²`, `c = 9 s⁻¹`:

```
ω_n = √k        = √65        = 8.062 rad/s     → f_n = 1.283 Hz
ζ   = c/(2√k)   = 9/16.125   = 0.558           → UNDERDAMPED
T_d = 2π/(ω_n√(1−ζ²)) = 6.2832/(8.062·0.8300) = 0.939 s   (one full overshoot cycle)
overshoot = exp(−πζ/√(1−ζ²)) = exp(−2.112)     = 0.121     → 12.1% cross-back
t_settle(2%) ≈ 4/(ζω_n) = 4/4.500              = 0.889 s
```

So Source's punch **overshoots by 12% and takes ~890 ms to settle**. That is a very *soft*,
slow recovery by modern standards — it is a *camera* punch, not a weapon kick. Use it for the
camera. Use a stiffer, more damped spring for the viewmodel itself.

**Recommended two-spring split** (**REASONED, NOT CITED** — these are derived from the
timings in §3.6, not quoted):

| spring | ω_n | ζ | f_n | overshoot | 2% settle |
|---|---|---|---|---|---|
| camera punch (pitch/yaw) | 8.06 rad/s | 0.55 | 1.28 Hz | 12% | 890 ms |
| viewmodel kick (pos + rot) | 26 rad/s | 0.62 | 4.14 Hz | 8.5% | 248 ms |
| viewmodel *muzzle climb* (slow, accumulating) | 6 rad/s | 1.0 | 0.95 Hz | 0% | 667 ms |

The third spring is what makes sustained automatic fire feel real: a fast spring per shot
riding on a slow, critically-damped drift that only decays between bursts.

**Per-shot impulse magnitudes** for a 600 RPM assault rifle (your `RPM = 600` → 100 ms
between shots). **REASONED, NOT CITED** — dial against capture:

```
viewmodel rotation impulse:  pitch  −2.2°  (muzzle up), yaw ±0.5° random, roll ±0.9° random
viewmodel position impulse:  z +0.022 m (back toward the eye), y +0.004 m, x ±0.003 m
camera punch impulse:        pitch  −0.55°, yaw ±0.18° random
```

The viewmodel kick should be **~4× the camera punch** in angle. If they are equal, the gun
appears welded to the view and the recoil is invisible; the whole readability of recoil comes
from *relative* motion between gun and world.

**Recoil recovery is not the same as recoil decay.** Real shooters split it:
- the **fast** component (the spring above) returns most of the kick in ~150–250 ms;
- the **slow** component (accumulated climb) only returns when the trigger is released, over
  ~300–500 ms, and in many games returns only *partially* so that spraying walks the crosshair.

## 3.5 The spring integrator — use the exact solution, not Euler

Daniel Holden's spring reference
([Spring-It-On: The Game Developer's Spring-Roll-Call](https://theorangeduck.com/page/spring-roll-call))
gives closed-form, framerate-independent versions. These are the ones to use — a
semi-implicit Euler spring changes its damping when the frame time changes, which means your
recoil feels different at 144 Hz and 30 Hz.

Exponential damper (for sway, lag, ADS blend — anything with no overshoot):
```c
float damper_exact(float x, float g, float halflife, float dt, float eps=1e-5f)
{
    return lerp(x, g, 1.0f - expf(-(0.69314718056f * dt) / (halflife + eps)));
}
```
`0.69314718056` is ln 2; `halflife` is the time in seconds to close half the remaining gap —
a genuinely intuitive unit. **This is the single most useful function in this document.**

Critically-damped spring with velocity (for recoil, landing, bob impulses):
```c
float halflife_to_damping(float halflife, float eps = 1e-5f)
{
    return (4.0f * 0.69314718056f) / (halflife + eps);
}

void simple_spring_damper_exact(float& x, float& v, float x_goal, float halflife, float dt)
{
    float y = halflife_to_damping(halflife) / 2.0f;
    float j0 = x - x_goal;
    float j1 = v + j0*y;
    float eydt = fast_negexp(y*dt);

    x = eydt*(j0 + j1*dt) + x_goal;
    v = eydt*(v - j1*y*dt);
}
```

For the *underdamped* springs in §3.4 you need the full `spring_damper_exact` from the same
page (it branches on ζ<1 / ζ=1 / ζ>1). If you only want critical damping, the function above
is complete and exact for any `dt`.

Conversion between the two parameterisations:
```
ζ = 1 (critical):  ω_n = halflife_to_damping(h)/2 = 2·ln2/h  →  h = 2·ln2/ω_n = 1.386/ω_n
general:           c = 2ζω_n,  and halflife = 4·ln2/c = 2.773/(2ζω_n)
```
So the "viewmodel kick" row (ω_n = 26, ζ = 0.62) has `c = 32.2 s⁻¹`, halflife 86 ms. If you
implement everything with `simple_spring_damper_exact` and just tune halflives, use
**86 ms** for the kick, **250 ms** for the camera punch, **380 ms** for muzzle climb.

**Framerate-independent exponential smoothing, if you use nothing else from this section:**
```js
const a = 1 - Math.exp(-dt / tau);   // tau = time constant, seconds
x += (target - x) * a;
```
Never write `x += (target - x) * 0.1` — that is a different filter at every frame rate.
`weapons.js:1810` uses `Math.min(1, dt*6)` for `bobAmt`, which is the naive form; at 30 fps
`dt*6 = 0.2`, at 144 fps `0.0417`, giving time constants of 139 ms and 240 ms respectively.
Replace with `1 - Math.exp(-dt*6)` for exact framerate independence (same nominal τ = 167 ms).

## 3.6 Timing constants table

Consolidated. Sourced values are cited; the rest are **REASONED, NOT CITED** practitioner
defaults derived from the sourced ones and from the ADS benchmarks below. Treat this as a
starting tuning sheet, not gospel.

| motion | parameter | value | unit / meaning |
|---|---|---|---|
| **fire rate** | shot interval | 100 | ms (600 RPM, your `SHOT_DT`) |
| **muzzle flash** | hold | 16 | ms (1 frame at 60) |
| | total life | 55 | ms (~3 frames), cubic decay |
| **recoil kick** | rise to peak | 25–40 | ms — must be < 1 frame at 30 fps or it is invisible |
| | halflife (viewmodel) | 86 | ms |
| | 2% settle | ~250 | ms |
| **camera punch** | halflife | 250 | ms |
| | 2% settle | ~890 | ms (derived from Source's 65/9) |
| **muzzle climb** | halflife | 380 | ms, critically damped, only decays when not firing |
| **look lag** | halflife | 70–110 | ms (heavier weapon ⇒ larger) |
| | gain | 0.4 | dimensionless (Quake `CalcGunAngle`) |
| | clamp | ±10 | degrees (Quake) |
| **idle sway** | rate A | 0.63 | Hz (≈ breathing, 12–20 breaths/min) |
| | rate B | 0.41 | Hz — incommensurate with A so it never loops |
| | amplitude | 0.25–0.45 | degrees peak |
| **walk bob** | lateral freq | 1.25 | Hz at 4.6 m/s |
| | vertical freq | 2.50 | Hz (2×) |
| | lateral amp | 0.45 | cm |
| | vertical amp | 0.70 | cm |
| | roll amp | 1.15 | degrees |
| | bobup asymmetry | 0.35 | fraction of period spent rising (Quake's `cl_bobup`) |
| | speed→amp ramp | 167 | ms time constant |
| **landing** | impulse | scales with impact v_y | clamp at 4 cm |
| | halflife | 90 | ms |
| **ADS in** | duration | 180–240 | ms for an assault rifle |
| **ADS out** | duration | 140–180 | ms (faster than in — always) |
| **sprint→fire** | duration | 180–250 | ms |
| **reload** | total | 2600 | ms (your `RELOAD_TIME`) |

ADS anchor: CoD-family practitioner guidance targets **240–280 ms** for assault rifles, with
"below 240 ms feels extremely snappy like an SMG, above 300 ms too sluggish"
([ExpertBeacon — ADS speed](https://expertbeacon.com/what-is-ads-speed-cod-mobile/) —
this is a community guide, not a developer source; treat the exact bounds as **UNVERIFIED**,
but the *order of magnitude* is corroborated by every ADS-time table for MW2019
([mp1st ADS attachment stats](https://mp1st.com/news/modern-warfare-ads-gun-attachments-stats-guide-how-to-lower-ads-time))).
Halo-family games use faster, shallower ADS than CoD, so the lower end (180–240 ms) is the
right target for this project.

**ADS easing curve.** Use a curve with a fast start and a soft landing, not a symmetric
smoothstep — a symmetric ease makes ADS feel mushy at the start, which is what players
perceive as "slow ADS" even at the same duration.
```
e(t) = 1 - pow(1 - t, 3)      // cubic ease-out, in
e(t) = 1 - pow(1 - t, 2)      // quadratic ease-out, out (snappier still)
```

## 3.7 Motion things that separate AAA from indie

1. **Everything is speed-scaled, not on/off.** Sway amplitude ← breath; bob ← `speed/maxSpeed`
   with a time constant; lag ← angular velocity. No binary state transitions.
2. **Nothing is periodic at a single frequency.** Two incommensurate sines minimum for idle
   sway (`weapons.js:1844-1847` already does this). If the ratio of the two rates is rational
   with a small denominator, the pattern repeats visibly; use e.g. 0.63 and 0.41 Hz
   (ratio 1.537, period ≈ 39 s before near-repeat).
3. **Recoil randomisation must be *seeded per shot* and *correlated within a burst*.** Pure
   per-shot white noise reads as jitter. Use a low-discrepancy sequence or a per-magazine
   fixed pattern (this is what CS and Valorant literally do — the "spray pattern").
4. **The gun leads on stop, lags on start.** When the player stops turning, the gun overshoots
   past centre and comes back. This is the `ζ < 1` in §3.4 and it is the difference between
   "weight" and "damped".
5. **Landing impulse ≠ bob.** A landing must break the bob phase, not add to it.
6. **Breath hold on ADS.** Idle sway amplitude drops ~60% within 200 ms of entering ADS, then
   creeps back over 4–6 s. Every milsim does this; Halo does a mild version of it.

---

# 4. Hard-surface material detail, procedurally

Constraint from the repo: no authored textures. Everything below is generated at init from
`ctx.rand.fork(...)` or computed in the shader.

## 4.1 Anisotropic specular — the exact equations, three ways, all consistent

This is the highest-value item in this section because brushed/machined metal is *the* look of
a Halo weapon, and isotropic GGX cannot produce it.

**The NDF** (Burley's anisotropic GGX, as specified normatively by Khronos in
[KHR_materials_anisotropy](https://raw.githubusercontent.com/KhronosGroup/glTF/main/extensions/2.0/Khronos/KHR_materials_anisotropy/README.md)):

```
D(h) = 1 / ( π α_t α_b ( (h·t)²/α_t² + (h·b)²/α_b² + (h·n)² )² )
```

**Filament's identical statement** ([Filament PBR document](https://google.github.io/filament/Filament.md.html)):

```
D_aniso(h, α) = (1/(π α_t α_b)) · 1 / ( ((t·h)/α_t)² + ((b·h)/α_b)² + (n·h)² )²
```

**The two roughness derivations differ, and you must pick one deliberately:**

| formulation | α_t (along anisotropy direction) | α_b | source |
|---|---|---|---|
| **Kulla 2017 / Filament** | `α · (1 + anisotropy)` | `α · (1 − anisotropy)` | [Filament](https://google.github.io/filament/Filament.md.html), [filament `surface_shading_model_standard.fs`](https://raw.githubusercontent.com/google/filament/main/shaders/src/surface_shading_model_standard.fs) |
| **glTF / three.js** | `mix(α, 1.0, anisotropy²)` | `α` | [KHR_materials_anisotropy](https://raw.githubusercontent.com/KhronosGroup/glTF/main/extensions/2.0/Khronos/KHR_materials_anisotropy/README.md) |

where `α = roughness²` in both.

The glTF form only ever *increases* roughness along the anisotropy direction; the Filament
form increases one and decreases the other, so it can push α_b below the material roughness.
For a brushed barrel you want the *cross-groove* direction to stay reasonably sharp, so the
glTF form is the safer default and it is what three.js implements — **use it**, so that
`MeshPhysicalMaterial.anisotropy` and any hand-written shader agree.

**three.js r185's implementation, verified in `node_modules`:**

`src/renderers/shaders/ShaderChunk/lights_physical_fragment.glsl.js:145-158`
```glsl
material.anisotropy = length( anisotropyV );
if( material.anisotropy == 0.0 ) { anisotropyV = vec2( 1.0, 0.0 ); }
else { anisotropyV /= material.anisotropy; material.anisotropy = saturate( material.anisotropy ); }

// Roughness along the anisotropy bitangent is the material roughness,
// while the tangent roughness increases with anisotropy.
material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );

material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
```

`src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js:98-120`
```glsl
float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB,
    const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL,
    const in float dotNV, const in float dotNL ) {

	float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
	float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}

float D_GGX_Anisotropic( const in float alphaT, const in float alphaB,
    const in float dotNH, const in float dotTH, const in float dotBH ) {

	float a2 = alphaT * alphaB;
	highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
	highp float v2 = dot( v, v );
	float w2 = a2 / v2;
	return RECIPROCAL_PI * a2 * pow2 ( w2 );
}
```

I verified algebraically that three's `D_GGX_Anisotropic` is *exactly* the Khronos/Filament
formula, not an approximation. Sketch: let `a2 = α_t α_b`. Then
`|v|² = α_b²(t·h)² + α_t²(b·h)² + a2²(n·h)²`, and multiplying the Khronos bracket by `a2²`
gives precisely `|v|²`. So the bracket is `|v|²/a2²`, its square is `|v|⁴/a2⁴`, and
`D = 1/(π·a2·|v|⁴/a2⁴) = (1/π)·a2·(a2/|v|²)²` — which is the returned expression. Good: you
can mix hand-written aniso lobes with `MeshPhysicalMaterial` and they will match.

**Anisotropic IBL — the bent-normal trick** (three r185
`envmap_physical_pars_fragment.glsl.js:47-57`, itself citing
[Filament's anisotropy IBL section](https://google.github.io/filament/Filament.md.html#lighting/imagebasedlights/anisotropy)):

```glsl
vec3 bentNormal = cross( bitangent, viewDir );
bentNormal = normalize( cross( bentNormal, bitangent ) );
bentNormal = normalize( mix( bentNormal, normal,
                             pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
return getIBLRadiance( viewDir, bentNormal, roughness );
```

The `pow2(pow2(x))` is `x⁴`. This is a single-sample approximation; the KHR spec notes that
"further samples should be placed on both sides along the `anisotropicT` direction, spaced
according to α_t". For a viewmodel you can afford 3 taps along the anisotropy direction —
this is the difference between a *streak* and a *smear* in the sky reflection on the top rail.
**Note:** three's `getIBLAnisotropyRadiance` returns `vec3(0.0)` unless
`ENVMAP_TYPE_CUBE_UV` — i.e. unless your env map went through `PMREMGenerator`. Your
`weapons.js:1300-1307` PMREM probe satisfies this. Verify it, because the failure is silent
(the gun just loses its sky streak).

### 4.1.1 THE GOTCHA: tangent frames

`normal_fragment_begin.glsl.js:22-39` in r185:

```glsl
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal, /* vNormalMapUv | vClearcoatNormalMapUv | vUv */ );
	#endif
#endif
```

and `getTangentFrame` (`normalmap_pars_fragment.glsl.js:20-40`) derives T and B from
**screen-space derivatives of position and UV**:

```glsl
vec3 q0 = dFdx( eye_pos.xyz );   vec3 q1 = dFdy( eye_pos.xyz );
vec2 st0 = dFdx( uv.st );        vec2 st1 = dFdy( uv.st );
vec3 q1perp = cross( q1, N );    vec3 q0perp = cross( N, q0 );
vec3 T = q1perp * st0.x + q0perp * st1.x;
vec3 B = q1perp * st0.y + q0perp * st1.y;
float det = max( dot( T, T ), dot( B, B ) );
float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
return mat3( T * scale, B * scale, N );
```

**If your merged, procedurally-generated viewmodel geometry has degenerate or arbitrary UVs
(and merged chamfered boxes usually do), `det == 0` → `scale = 0` → the tangent frame is the
zero matrix → the anisotropy direction is `vec3(0)` → the aniso lobe silently degenerates.**
This will look like "anisotropy does nothing" and you will spend an hour on it.

Fixes, in order of preference:
1. **Supply a real `tangent` attribute** (`Float32BufferAttribute`, itemSize **4** — xyz +
   handedness w). Since you generate the geometry, you know the machining direction per face
   analytically: for a barrel, T = the barrel axis; for a receiver flat, T = the long axis.
   Write it directly. This also sets `USE_TANGENT`, which is faster than `getTangentFrame`.
2. `computeMikkTSpaceTangents(geometry, MikkTSpace)` from
   `three/addons/utils/BufferGeometryUtils.js` (present in r185, verified; requires
   `three/addons/libs/mikktspace.module.js`). Needs position, normal and non-degenerate uv.
3. Give every face a sane planar UV before merging.

`MeshPhysicalMaterial.anisotropyRotation` is "measured in radians counter-clockwise from the
tangent" (r185 `MeshPhysicalMaterial.js:66-73`), so once you have per-face tangents you can
rotate the lay per-part with a single float.

### 4.1.2 Direction semantics — the sign error everyone makes

From the KHR spec, verbatim in meaning:

> The direction vector of the anisotropy is the direction in which highlights will be
> stretched. The direction of the micro-grooves in the material causing the anisotropy will
> run **perpendicular**.

So for a **barrel with a lengthwise brushed lay** (grooves parallel to the bore), the
highlight stretches **around the circumference** — a bright ring/band across the barrel.
For a **lathe-turned barrel** (circumferential rings, the usual case for a machined barrel),
the highlight stretches **along the bore** — a long streak down the barrel. The second is
what reads as "gun", and it is the more common real-world finish. Set the anisotropy
direction *along the barrel axis* for a turned barrel.

For **receiver flats** milled on a CNC, the lay follows the tool path — usually the long axis
of the part. For **stamped sheet** (a magazine body), the lay follows the rolling direction of
the stock, i.e. the long axis.

Sensible anisotropy strengths (**REASONED, NOT CITED**, calibrated to look right at
`roughness 0.25–0.45`):

| part | roughness | anisotropy | direction |
|---|---|---|---|
| turned barrel / gas tube | 0.22 | 0.65 | along bore |
| milled receiver flats | 0.35 | 0.40 | long axis of part |
| stamped magazine body | 0.45 | 0.30 | long axis |
| bead-blasted / parkerised surfaces | 0.55 | 0.00 | (isotropic — this is the point of bead blasting) |
| polymer furniture | 0.60 | 0.00 | isotropic |
| worn edge / exposed bright metal | 0.12 | 0.15 | inherits parent |

## 4.2 Edge wear from curvature, with no baked map

Curvature is the master mask: **convex = wear, exposed bright metal, lower roughness;
concave = grime, higher roughness, darker albedo**
([Polycount wiki — Curvature map](http://wiki.polycount.com/wiki/Curvature_map);
[StraySpark on curvature-driven weathering](https://www.strayspark.studio/blog/procedural-weathering-blender-geometry-nodes)).

You have three ways to get it. Use **(A) plus (C)**.

**(A) Build-time per-vertex convexity — best quality, free at runtime.**
Because you merge geometry at init, compute this in JS. For each vertex `i` with smoothed
normal `n_i`, and each incident face with geometric normal `n_f` and centroid offset
`d = centroid − p_i`:

```
convexity_i = Σ_f  w_f · sign(dot(n_i, d_f)) · (1 − dot(n_i, n_f))
```
normalised by `Σ w_f` (use face area for `w_f`). Positive → convex edge, negative → concave.
Store into a vertex attribute (you already have `aMask.x` doing an analogous job for chamfer
facets — extend that attribute rather than adding one).

**Cheaper and often sufficient for chamfered box geometry:** after `mergeGeometries` with
`indexed = false` (flat faces), a chamfer facet's own normal differs from *both* neighbours by
the chamfer half-angle. Tag chamfer facets at generation time — which `weapons.js` already
does. Keep doing this; it is the correct answer for procedural hard-surface.

**(C) Runtime screen-space curvature — use as a *modulator*, not the primary mask.**
```glsl
// units: 1/metre. worldPos and N must be in the same space (world or view, consistently).
float screenCurvature(vec3 N, vec3 P) {
    vec3  dN = fwidth(N);            // = abs(dFdx(N)) + abs(dFdy(N))
    float dP = length(fwidth(P)) + 1e-6;
    return length(dN) / dP;
}
// sign: positive where the surface bulges toward the viewer
float curvatureSign(vec3 N, vec3 P) {
    return sign( dot(dFdx(N), dFdx(P)) + dot(dFdy(N), dFdy(P)) );
}
```
(`fwidth(p) == abs(dFdx(p)) + abs(dFdy(p))` — the cheap-and-decent derivative approximation
noted in the [Polycount FWVN thread](https://polycount.com/discussion/202689/fwvn-edge-wear-material-function-for-dynamic-procedural-texturing/p2)
and demonstrated in [this Shadertoy fwidth curvature test](https://www.shadertoy.com/view/ldd3DH)
— read for technique only.)

**Why not use (C) alone:** it is *resolution-dependent*. The wear band gets wider as you walk
toward the object and narrower as you walk away, which on a viewmodel means the wear pattern
breathes with ADS. It is also 1-pixel-quantised, so it aliases badly under TAA. On a
viewmodel — which never changes its screen size much — it is *less* bad than elsewhere, but
still: build-time is the right primary source.

**Composing the wear mask.** Never use raw curvature; it produces a perfectly even outline that
reads as a toon shader.

```glsl
// c        : 0..1 convexity from the vertex attribute (aMask.x)
// pObj     : OBJECT-space position — see the note below
// wearAmt  : 0..1 global "how beaten up is this gun"
float edgeWear(float c, vec3 pObj, float wearAmt) {
    // 1. break the edge line with two octaves of noise at different scales
    float n1 = fbm(pObj * 42.0, 3);        // 2.4 cm features — where wear starts
    float n2 = fbm(pObj * 310.0, 2);       // 3 mm features  — the ragged boundary
    // 2. contrast the curvature so only the sharpest edges qualify
    float e  = smoothstep(0.42, 0.78, c);
    // 3. modulate the threshold, don't multiply the mask (multiplying just fades it)
    float t  = mix(0.72, 0.18, wearAmt) + (n1 - 0.5) * 0.34;
    return smoothstep(t, t + 0.10, e * (0.75 + 0.25 * n2));
}
```

Three things in there earn their keep:
- **Threshold modulation, not multiplication.** Multiplying a noise into the mask makes the
  wear *translucent*. Modulating the threshold makes it *patchy* — some edges worn, some not.
  That is what real wear looks like.
- **Two noise scales.** One decides *which* edges wear, one decides the *raggedness* of each
  worn patch. One scale alone gives either a uniform outline or salt-and-pepper.
- **Object space.** `weapons.js:1217-1219` already flags this: world-space projection makes
  every scratch swim as the gun sways. Use object space for anything spatially projected.

**What wear does to the material:**
```glsl
float w = edgeWear(...);
albedo    = mix(albedo, vec3(0.560, 0.570, 0.580), w);   // bare steel, linear
metalness = mix(metalness, 1.0, w);
roughness = mix(roughness, 0.14, w * 0.85);              // polished by handling
```
The `0.560,0.570,0.580` is iron's F0 (see §4.5). The roughness drop is the *entire point*: a
worn edge is bright because it is *smooth*, not because it is *white*. If you only change
albedo you get a chalk line.

**Grime in the concave regions** is the other half and is usually skipped:
```glsl
float g = smoothstep(0.35, 0.80, -curvatureSigned) * fbm(pObj * 90.0, 3);
albedo    *= mix(1.0, 0.55, g);
roughness  = mix(roughness, 0.82, g * 0.7);
metalness *= (1.0 - g * 0.6);       // grime is a dielectric layer
```
Grime raises roughness *and* kills metalness. Without the metalness term the crevices still
reflect like metal and the grime reads as a decal.

## 4.3 Machining marks

Three distinct phenomena, all procedural, all cheap:

**(a) Anisotropic lay** — handled entirely by §4.1. This is the dominant one and it costs
nothing but a tangent attribute.

**(b) Tool-path ridges (normal perturbation).** A milled surface has a periodic ridge pattern
at the tool feed pitch. For a hobby-grade finish that's 0.05–0.2 mm; for a firearm receiver
0.02–0.08 mm. At viewmodel distance (0.4 m) with a ~86° horizontal FOV over 1920 px, one pixel
subtends `2*0.4*tan(43°)/1920 = 0.39 mm`. **So individual machining ridges are sub-pixel and
you must not model them as normals — they will alias into a shimmering mess.** Encode them in
*roughness/anisotropy* instead. This is the single most common mistake in hard-surface
shaders.

Where you *can* use normal perturbation is at the ~1 mm scale — the visible chatter, the
step between adjacent tool passes:
```glsl
// object-space, tangent-aligned. `lay` = the anisotropy tangent.
float pitch  = 340.0;                              // ≈ 2.9 mm period
float ridge  = sin(dot(pObj, lay) * pitch) * 0.5 + 0.5;
ridge       *= fbm(pObj * 18.0, 2);                // vary depth along the part
normal       = normalize(normal + lay_perp * (ridge - 0.5) * 0.020);
roughness   += (ridge - 0.5) * 0.04;
```

**(c) Turned (lathe) rings on cylindrical parts.** Use the angle-independent radial coordinate:
```glsl
float r = length(pObj.xy - axisCentre);            // if the barrel runs along +z
float rings = fract(pObj.z * 520.0);               // 1.9 mm pitch
roughness += (rings - 0.5) * 0.05;
// anisotropy direction = the bore axis (see §4.1.2)
```

**(d) The bore / flash hider slots / rail engraving** are geometry, not shader. `weapons.js`
already generates them.

## 4.4 Geometric specular antialiasing — non-optional for a chamfered viewmodel

A gun made of chamfered boxes has hundreds of ~1 px-wide chamfer facets with roughness ~0.2.
Those *will* fireflies-and-crawl under any temporal filter. The fix is Kaplanyan/Tokuyoshi
normal filtering: widen roughness by the screen-space variance of the normal.

Filament's implementation, verified verbatim from
[`shaders/src/surface_shading_lit.fs`](https://raw.githubusercontent.com/google/filament/main/shaders/src/surface_shading_lit.fs):

```glsl
#if defined(GEOMETRIC_SPECULAR_AA)
float normalFiltering(float perceptualRoughness, const vec3 worldNormal) {
    // Kaplanyan 2016, "Stable specular highlights"
    // Tokuyoshi 2017, "Error Reduction and Simplification for Shading Anti-Aliasing"
    // Tokuyoshi and Kaplanyan 2019, "Improved Geometric Specular Antialiasing"
    vec3 du = dFdx(worldNormal);
    vec3 dv = dFdy(worldNormal);
    du *= frameUniforms.derivativesScale.x;
    dv *= frameUniforms.derivativesScale.y;
    float variance = materialParams._specularAntiAliasingVariance * (dot(du, du) + dot(dv, dv));
    float roughness = perceptualRoughnessToRoughness(perceptualRoughness);
    float kernelRoughness = min(2.0 * variance, materialParams._specularAntiAliasingThreshold);
    float squareRoughness = saturate(roughness * roughness + kernelRoughness);
    return roughnessToPerceptualRoughness(sqrt(squareRoughness));
}
#endif
```

Parameter meanings and defaults, from
[Filament's Materials guide](https://google.github.io/filament/Materials.md.html):
- `specularAntiAliasingVariance` — default **0.15**, range 0–1. "Sets the screen space
  variance of the filter kernel used when applying specular anti-aliasing." Physically: how
  many pixels wide you assume the reconstruction filter is. Larger → more blur, fewer
  fireflies.
- `specularAntiAliasingThreshold` — default **0.2**, range 0–1. "Sets the clamping threshold
  used to suppress estimation errors." Physically: a ceiling on how much roughness the filter
  is allowed to add, so that a genuine hard crease does not become a matte blob.

`derivativesScale` corrects for dynamic-resolution/upscaling; if you render at native, use
`vec2(1.0)`. If you render the viewmodel at a different resolution than the world (you don't),
set it to the ratio.

**Note that Tokuyoshi & Kaplanyan's own paper listing uses different constant names
(`SIGMA2`, `KAPPA`) with values commonly quoted as 0.15915494 (= 1/2π) and 0.18.** I attempted
to fetch [the paper PDF](https://yusuketokuyoshi.com/papers/2019/ImprovedGeometricSpecularAA.pdf)
and could not extract its text in this environment, so **those two numeric values are
UNVERIFIED here**. Filament's 0.15 / 0.2 *are* verified from both its source and its docs, and
are close enough that this does not matter in practice. Use Filament's.

three.js r185 does **not** ship geometric specular AA. Inject it via `onBeforeCompile` into
`roughnessmap_fragment`, or into whatever your `applyWorldMaterial` inject hook targets:

```glsl
// after roughnessFactor is computed
{
  vec3 du = dFdx( vNormal );
  vec3 dv = dFdy( vNormal );
  float variance = 0.15 * ( dot(du,du) + dot(dv,dv) );
  float a = roughnessFactor * roughnessFactor;
  float kernel = min( 2.0 * variance, 0.2 );
  roughnessFactor = sqrt( clamp( a + kernel, 0.0, 1.0 ) );
}
```
Use the **geometric** normal (`vNormal`, un-perturbed), not the normal-mapped one — Filament
calls `getWorldGeometricNormalVector()`. Applying it to the mapped normal double-counts.

## 4.5 Material values — linear-space, physically grounded

F0 (reflectance at normal incidence) for metals, and base colour for dielectrics. These are
standard tabulated values; the *metal* F0s are widely reproduced from measured n/k data.
**REASONED, NOT CITED** for the specific triples below — cross-check against your own
reference if a colour looks off, but they will be within a few percent of any PBR chart.

| material | metalness | linear base colour / F0 | roughness | note |
|---|---|---|---|---|
| iron / mild steel | 1.0 | 0.560, 0.570, 0.580 | 0.25–0.45 | bare, worn |
| chromium (bolt, pins) | 1.0 | 0.549, 0.556, 0.554 | 0.10–0.20 | |
| aluminium (receiver) | 1.0 | 0.913, 0.922, 0.924 | 0.30–0.50 | |
| black anodised aluminium | 1.0 | 0.045, 0.046, 0.048 | 0.35–0.55 | **stays metalness 1** — anodising is a thin oxide, not paint |
| parkerised / phosphate steel | 1.0 | 0.180, 0.176, 0.170 | 0.60–0.75 | matte, near-isotropic |
| black polymer furniture | 0.0 | 0.021, 0.021, 0.022 | 0.55–0.70 | F0 = 0.04 (default dielectric) |
| olive/grey polymer | 0.0 | 0.048, 0.055, 0.038 | 0.60 | |
| rubber grip | 0.0 | 0.015, 0.015, 0.015 | 0.85 | |
| glove fabric | 0.0 | 0.035, 0.033, 0.030 | 0.90 | plus a sheen term if you have one |
| glass (sight lens) | 0.0 | 0.0 | 0.03 | transmissive, F0 0.04, add a coloured coating tint |

**The albedo trap.** Your measured target is `lum_mean 79.8` — dark. A black polymer at
linear 0.021 tonemaps to roughly sRGB 40 under neutral exposure. To hit 79.8 you need the
*specular* to carry the difference. Concretely: the chamfer highlights and the sky IBL streak
on the top rail should be the brightest things on the gun, at 200–255, occupying maybe 3–6% of
the weapon's pixels. That is what produces `local_contrast 0.178` and `lap_var 489` at a
`lum_mean` of 79.8. Raising base colour to 0.08 would hit the mean and destroy both the
contrast and the laplacian variance.

## 4.6 Detail-map generation (procedural, at init)

Since the repo already generates its scratch/wear map, glove weave, rail engraving and
ammo-counter panel from `ctx.rand.fork(...)`, the useful additions are:

**Scratches** — a directional Worley/Voronoi with heavy anisotropic domain stretch:
```
p' = p * vec2(1.0, 24.0)            // 24:1 stretch → long thin cells
d  = worley(p')                     // F1 distance
scratch = smoothstep(0.02, 0.0, d) * randomLength
```
Rotate `p'` per-region by a per-part angle so scratches follow the way the gun is handled
(mostly along the length, from holstering).

**Domain warping** to make the fbm not look like fbm — the canonical
`q = fbm(p); r = fbm(p + q); result = fbm(p + r)` recipe
([Inigo Quilez — Domain warping](https://iquilezles.org/articles/warp/); see also
[his fbm article](https://iquilezles.org/articles/fbm/)). One level of warp is enough for
wear patchiness; two starts to look like marble.

**Value vs gradient noise:** use **gradient** noise (Perlin-family) for anything that modulates
roughness continuously — value noise has visible axis-aligned lattice artifacts at the
low frequencies you need for the "which edges wear" mask.

---

# 5. Failure modes — described so you can spot them in a screenshot

Each entry: **what you see** → what it is → the fix.

## 5.1 Geometry / projection

1. **Barrel tip disappears into a wall when you walk up to it, but the rest of the gun is
   fine.** → Depth interpenetration; no depth-range compression or the compression range is
   too wide. → §1.4.
2. **Gun visibly *shrinks* toward the frame edge, and the stock bends away from the camera.**
   → Rendered at world FOV (k = 1). → §1.5.
3. **Gun looks like a photograph pasted flat on the screen; the barrel has no convergence and
   the receiver's far end is the same width as its near end.** → k too high (> ~2.2), or the
   model was authored for a much narrower FOV than it's rendered at. → lower `k` toward 1.5.
4. **When you resize the window the gun changes size.** → aspect policy inconsistency between
   the two cameras. Both must be Hor+ or both Vert−. → §1.2.
5. **Thin z-fighting sparkle along the chamfer between two adjacent boxes on the gun.** →
   near plane too small (0.002) for the depth format, or `depthRange` compressed too far. →
   raise `viewCamera.near` to 0.05; §1.8.
6. **Sight/rail pokes through the frame edge and gets clipped by the *side* of the screen at
   an angle that changes as you sway.** → the model is outside the viewmodel camera's frustum
   but inside the world camera's; you are seeing the frustum boundary. → widen `viewCamera.fov`
   or move the mount pose inboard.

## 5.2 Depth-buffer contamination (the class this repo is currently in)

7. **The whole world goes uniformly hazy/milky, and the haze does not vary with distance.** →
   Depth buffer cleared before a depth-consuming pass; every pixel reads as the far plane. →
   §1.6. *(Your `dof.js` header already documents that DOF degrades to a no-op in this state;
   fog degrades to "everything is at the far plane" instead, which is far more visible.)*
8. **The gun specifically is washed blue/grey, ~20% toward the sky colour, and looks like it's
   50 m away.** → §1.7 exactly. The 12.24 m decode.
9. **The gun ghosts/smears when you turn, leaving a faint echo of the barrel for 3–4 frames.**
   → TAA has no motion vectors for the viewmodel; history reprojection uses world velocity
   (≈ camera velocity), which for a camera-locked object is exactly wrong. → Either write
   viewmodel velocity into the G-buffer using the viewmodel's own previous matrices, or mark
   viewmodel pixels and force `blendFactor = 1` (no history) there. The second is cheaper and
   for a 100%-covered object costs almost nothing.
10. **The gun blurs violently under motion blur when you turn, more than the world does.** →
    Same root cause: it's being given the world's velocity. → mask it out; or, if you want
    weapon motion blur (you probably don't — it destroys readability of the sight), compute
    velocity from the viewmodel's own transform history.
11. **The world visible *through* the gap between the gun and the frame edge is sharp while
    everything else is defocused, or vice versa.** → DOF sampling depth at viewmodel-adjacent
    pixels. → mask.
12. **SSAO draws a dark halo in the world around the gun's silhouette.** → viewmodel depth is
    in the AO input but viewmodel normals aren't. → either put both in, or neither. Neither
    is correct for a viewmodel.

## 5.3 Lighting

13. **Gun goes fully black in shadow while the world's shadows still read at code value ~17.**
    → No viewmodel fill, or the fill is on the wrong layer and never collected. → §2.2; check
    `light.layers.test(camera.layers)`.
14. **A highlight sits at a fixed spot on the receiver and never moves as the player turns.**
    → A camera-relative light with a specular contribution. → make the private fill
    diffuse-only or drop its intensity below ~0.12 of sun.
15. **The gun is lit from the left while every world object is lit from the right.** → private
    key light. → delete it; use the world sun direction.
16. **The gun is uniformly lit with no directional read at all — like a clay render.** → only
    ambient/IBL, no sun reaching it. → check `LAYER.VIEWMODEL` on the sun/CSM light.
17. **Metallic parts are black except for a small bright sun spot.** → No specular IBL. A
    metal with no environment *is* black. → PMREM probe; §2.2. This is called out in
    `weapons.js:1300-1307`.
18. **Sky reflection on the top rail is a uniform grey smear rather than a streak.** →
    `getIBLAnisotropyRadiance` returning `vec3(0)` because the env map isn't `ENVMAP_TYPE_CUBE_UV`,
    or anisotropy is 0. → §4.1.
19. **Muzzle flash lights the barrel but not the wall two metres ahead.** → flash light is on
    `LAYER.VIEWMODEL` only. → enable `LAYER.OPAQUE` too.
20. **Muzzle flash reads as a strobe / a UI blink rather than a flash.** → linear decay, or
    no per-shot variation. → cubic decay, ±25% peak randomisation; §2.5.
21. **The gun's exposure doesn't track the world's — it stays mid-grey when you look at the
    sky and the world blows out.** → composited after tonemap. → §2.6.

## 5.4 Motion

22. **The gun is rock-solid still when the player stands still.** → no idle sway, or sway
    gated on movement. → sway never stops; §3.6.
23. **The idle sway visibly repeats on a ~2 s loop.** → the two sway frequencies are in a
    small-integer ratio. → use incommensurate rates (0.63 / 0.41 Hz).
24. **The gun snaps instantly to the new orientation when you flick the mouse.** → no lag, or
    lag halflife < ~30 ms. → §3.3, halflife 70–110 ms.
25. **The gun swings like a pendulum from the muzzle when you turn.** → rotating about the
    wrong pivot. → pivot at centre of mass; `weapons.js:63`.
26. **The gun's lag never overshoots; it just eases in.** → critically damped where you want
    ζ ≈ 0.6. → underdamp it slightly; this is where "weight" comes from.
27. **Recoil is invisible at 600 RPM — the gun just vibrates.** → viewmodel kick amplitude too
    close to camera punch amplitude, so there's no relative motion. → viewmodel kick ≈ 4×
    camera punch; §3.4.
28. **Recoil recovers completely between every shot at 600 RPM.** → single spring with too
    short a halflife. Shots are 100 ms apart; a 86 ms halflife recovers 55% between shots,
    which is right. If it recovers 95%+, the halflife is ~25 ms. → §3.4's two-spring split.
29. **Sustained fire doesn't walk the muzzle up.** → missing the slow accumulating spring. →
    third row of the §3.4 table.
30. **The bob feels different at 144 Hz than at 60 Hz.** → naive `x += (t-x)*k*dt` smoothing.
    → `1 - exp(-dt/tau)`; §3.5. `weapons.js:1810` has this today.
31. **Walking bob looks like the gun is on a spring, not like footsteps.** → symmetric sine.
    → `cl_bobup` asymmetry at 0.35; §3.2.
32. **The bob traces a figure-eight that reverses direction randomly.** → vertical and lateral
    phases are exactly 2:1 with zero offset. → add ψ ≈ 0.4 rad; §3.2.
33. **Landing looks like a bob spike.** → landing added to the bob phase rather than as a
    separate impulse. → separate spring, and break the bob phase on impact.
34. **ADS feels slow even at 200 ms.** → symmetric easing. → cubic ease-*out*; §3.6.
35. **The world seems to lurch relative to the gun during ADS.** → world FOV and viewmodel
    pose interpolated on different curves or durations, or FOV lerped in degrees. → lerp
    `tan(fov/2)`; §1.9.

## 5.5 Materials

36. **Anisotropy appears to do nothing at all.** → degenerate tangent frame; `det == 0` in
    `getTangentFrame`. → supply a real `tangent` attribute; §4.1.1. **Check this first.**
37. **Anisotropic streak runs the wrong way — around the barrel instead of along it.** →
    direction/groove confusion. The anisotropy vector is the *stretch* direction, and the
    grooves run perpendicular. → §4.1.2.
38. **Specular highlights crawl and shimmer along the chamfers when the gun sways, and TAA
    can't kill it.** → no geometric specular AA on sub-pixel chamfer facets. → §4.4.
39. **The gun sparkles with white pixel-sized fireflies in the sun.** → same, more severe.
    Roughness is too low on facets that are sub-pixel. → §4.4, and clamp
    `roughness >= 0.045` (Filament's `MIN_PERCEPTUAL_ROUGHNESS`).
40. **Machining marks shimmer into a moiré pattern that changes as you sway.** → tool-path
    ridges modelled as normals at sub-pixel pitch. At 0.4 m / 1920 px one pixel is ~0.39 mm;
    ridges finer than ~1 mm must live in roughness, not normals. → §4.3(b).
41. **Edge wear is a perfectly even outline around every edge — reads as a toon/inked shader.**
    → curvature used raw. → threshold modulation with two noise scales; §4.2.
42. **Edge wear looks like a translucent white smear rather than exposed metal.** → noise
    multiplied into the mask instead of modulating its threshold, and/or roughness not
    lowered on the wear. → §4.2; the wear must drop roughness to ~0.14 and raise metalness to 1.
43. **Scratches swim over the surface as the gun sways.** → world-space projection. → object
    space; `weapons.js:1217-1219`.
44. **Grime in the crevices still reflects like polished metal.** → metalness not reduced by
    grime. → `metalness *= (1 - g*0.6)`; §4.2.
45. **Black anodised parts look like matte plastic.** → metalness set to 0 for "black metal".
    Anodising is a thin oxide over aluminium: **metalness stays 1**, base colour goes to ~0.045.
    → §4.5.
46. **Gun's mean luminance is right but it looks flat and grey — `lap_var` and
    `local_contrast` are both low.** → albedo raised to hit the luminance target instead of
    letting specular carry it. → §4.6/§4.5; this is the "toy gun" failure and it is the most
    likely single reason a viewmodel misses an AAA read.
47. **Sight glass reads as a solid grey disc.** → no transmission and no coating tint. →
    roughness 0.03, a coloured F0 tint (purple/green AR coating), and a fake internal
    reflection streak.

---

# 6. What I could not verify

Stated plainly so nobody builds on sand.

- **Source `viewrender.cpp` full context around `DepthRange(0.0f, 0.1f)`.** The call and the
  `bUseDepthHack` guard are confirmed by two independent mirrors' search indices
  (hg.alliedmods.net, searchcode.com), but this environment's proxy returned 403 / domain
  block for both raw pages and for `developer.valvesoftware.com`, and the GitHub
  `ValveSoftware/source-sdk-2013` raw paths I tried 404'd. **The surrounding pass order and
  whether Source pushes a separate projection matrix for viewmodel FOV are UNVERIFIED.**
- **That Quake's `CalcGunAngle` lag term is a no-op.** The code is quoted verbatim above and
  the arithmetic is unambiguous (`yaw` is assigned `viewangles[YAW]` then used in
  `yaw - viewangles[YAW]`), but I found no source that says so. Read the code yourself.
- **Tokuyoshi & Kaplanyan 2019's own constants `SIGMA2 = 0.15915494`, `KAPPA = 0.18`.** The
  PDF would not extract in this environment. Filament's 0.15 / 0.2 are verified from source
  and docs and are what I recommend.
- **Overwatch's first-person animation specifics** (GDC 2017 Animation Bootcamp, Matt Boehm)
  are behind GDC Vault. I have the talk's existence and topic confirmed
  ([GDC Vault listing](https://gdcvault.com/play/1024319/Animation-Bootcamp-The-First-Person),
  [Game Anim writeup](https://www.gameanim.com/2017/04/29/first-person-animation-overwatch/))
  but **no frame counts or timing constants from it**. Nothing in §3 is attributed to it.
- **ADS timing bounds (240–280 ms).** Community guides only, not developer sources. The order
  of magnitude is corroborated across several MW2019 attachment tables; the specific bounds
  are **UNVERIFIED**.
- **All values marked REASONED, NOT CITED** in §2.5, §3.4, §3.6, §4.1.2, §4.5, §1.5's shear
  caveat, and §1.6's bandwidth estimate. These are derived or conventional, not quoted.
- **Halo: Campaign Evolved's / Halo CE's actual viewmodel FOV and rendering approach.** I found
  nothing technical. All FOV guidance here comes from Source-family engines and general
  practice.
- **Metal F0 triples in §4.5.** Standard tabulated values reproduced from memory of measured
  n/k data; I did not fetch a primary table this session.

---

## Sources

- [Filament — Physically Based Rendering (Filament.md.html)](https://google.github.io/filament/Filament.md.html)
- [Filament — Materials guide](https://google.github.io/filament/Materials.md.html)
- [Filament — `shaders/src/surface_shading_lit.fs`](https://raw.githubusercontent.com/google/filament/main/shaders/src/surface_shading_lit.fs)
- [Filament — `shaders/src/surface_shading_model_standard.fs`](https://raw.githubusercontent.com/google/filament/main/shaders/src/surface_shading_model_standard.fs)
- [Khronos — KHR_materials_anisotropy specification](https://raw.githubusercontent.com/KhronosGroup/glTF/main/extensions/2.0/Khronos/KHR_materials_anisotropy/README.md)
- three.js r185 source, read locally from `node_modules/three/src/renderers/shaders/ShaderChunk/`:
  `lights_physical_fragment.glsl.js`, `lights_physical_pars_fragment.glsl.js`,
  `normal_fragment_begin.glsl.js`, `normalmap_pars_fragment.glsl.js`,
  `envmap_physical_pars_fragment.glsl.js`; and `src/renderers/webgl/WebGLState.js`,
  `src/materials/MeshPhysicalMaterial.js`, `examples/jsm/utils/BufferGeometryUtils.js`
- [three.js — WebGLRenderer.clearDepth](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.clearDepth)
- [three.js — WebGLRenderer.logarithmicDepthBuffer](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.logarithmicDepthBuffer)
- [three.js forum — Rendering a gun on another layer?](https://discourse.threejs.org/t/rendering-a-gun-on-another-layer/80805)
- [three.js forum — Render multiple views](https://discourse.threejs.org/t/render-multiple-views/57999)
- [id-Software/Quake — `WinQuake/view.c`](https://raw.githubusercontent.com/id-Software/Quake/master/WinQuake/view.c)
- [Steam Workshop — Quake/Half-Life View bobbing](https://steamcommunity.com/sharedfiles/filedetails/?id=378401390)
- [SourceRuns wiki — cl_bob](https://wiki.sourceruns.org/wiki/Cl_bob)
- [Total CS — FOV and Viewmodel commands](https://totalcsgo.com/commands/categories/fov-and-viewmodel)
- [Valve Developer Community — Viewmodel](https://developer.valvesoftware.com/wiki/Viewmodel)
- [Valve Developer Community — ViewPunch](https://developer.valvesoftware.com/wiki/ViewPunch)
- [TF2 Wiki — Viewmodel](https://wiki.teamfortress.com/wiki/Viewmodel)
- [hl2sdk-bgt — `game/client/viewrender.cpp`](https://hg.alliedmods.net/hl2sdks/hl2sdk-bgt/file/f8823649f84a/game/client/viewrender.cpp)
- [hl2sdk-csgo — `game/shared/gamemovement.cpp`](https://hg.alliedmods.net/hl2sdks/hl2sdk-csgo/file/89079a96c198/game/shared/gamemovement.cpp)
- [Daniel Holden — Spring-It-On: The Game Developer's Spring-Roll-Call](https://theorangeduck.com/page/spring-roll-call)
- [Allen Chou — Game Math: Precise Control over Numeric Springing](https://allenchou.net/2015/04/game-math-precise-control-over-numeric-springing/)
- [Sahil Dhanju — Render First-Person Meshes with a Separate FOV](https://sahildhanju.com/posts/render-first-person-fov/)
- [Nathan Reed — Depth Precision Visualized](https://www.reedbeta.com/blog/depth-precision-visualized/)
- [NVIDIA — Visualizing Depth Precision](https://developer.nvidia.com/blog/visualizing-depth-precision/)
- [KhronosGroup/WebGL issue 2197 — the case for Reversed Depth Range](https://github.com/KhronosGroup/WebGL/issues/2197)
- [MDN — WebGLRenderingContext.depthRange](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/depthRange)
- [Polycount wiki — Curvature map](http://wiki.polycount.com/wiki/Curvature_map)
- [Polycount — FWVN edge wear material function](https://polycount.com/discussion/202689/fwvn-edge-wear-material-function-for-dynamic-procedural-texturing/p2)
- [StraySpark — Procedural Weathering: Edge Wear, Rust, Dirt](https://www.strayspark.studio/blog/procedural-weathering-blender-geometry-nodes)
- [Shadertoy — fwidth() curvature test](https://www.shadertoy.com/view/ldd3DH) (technique only)
- [Inigo Quilez — Domain warping](https://iquilezles.org/articles/warp/)
- [Inigo Quilez — fBM](https://iquilezles.org/articles/fbm/)
- [Tokuyoshi & Kaplanyan — Improved Geometric Specular Antialiasing (I3D 2019)](https://dl.acm.org/doi/10.1145/3306131.3317026) · [author PDF](https://yusuketokuyoshi.com/papers/2019/ImprovedGeometricSpecularAA.pdf)
- [Temporal Characterization of Small Arms Muzzle Flash in the Broadband Visible](https://www.researchgate.net/publication/224244255_Temporal_Characterization_of_Small_Arms_Muzzle_Flash_in_the_Broadband_Visible)
- [MyCreativeFX — muzzle flash frame durations](https://mycreativefx.com/blog/357-free-muzzle-flash-vfx-download-4k-gun-effects-for-video-editing)
- [ExpertBeacon — ADS speed in CoD](https://expertbeacon.com/what-is-ads-speed-cod-mobile/) (community source)
- [MP1st — MW ADS attachment stats](https://mp1st.com/news/modern-warfare-ads-gun-attachments-stats-guide-how-to-lower-ads-time) (community source)
- [GDC Vault — Animation Bootcamp: The First Person Animation of 'Overwatch'](https://gdcvault.com/play/1024319/Animation-Bootcamp-The-First-Person) (not accessible)
- [Game Anim — The First Person Animation of Overwatch](https://www.gameanim.com/2017/04/29/first-person-animation-overwatch/)
