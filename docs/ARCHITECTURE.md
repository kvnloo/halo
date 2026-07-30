# Engine architecture — the contract

Read this before touching any file. It exists so that many people can work on this
codebase at once without stepping on each other.

## Hard rules

1. **One module per file. A module owns its file exclusively.** Never edit a file you
   were not assigned. If you need something from another subsystem, get it through
   `ctx.get(name)` at runtime — never with an `import`.
2. **No cross-module imports.** `src/world/ocean.js` must not import `src/world/terrain.js`.
   Shared code lives in `src/core/` and `src/gfx/` and is import-only (never mutated).
3. **Everything is deterministic.** Draw randomness from `ctx.rand.fork(salt)`. Never call
   `Math.random()`, `Date.now()`, or `performance.now()` for content generation. Two runs
   with the same seed must produce byte-identical frames — the whole measurement loop
   depends on it.
4. **No network fetches at runtime.** Every texture is generated procedurally on the GPU or
   in JS at load time, and every mesh is generated from code. There is no asset CDN and
   there are no texture or model files in this repo. Build your own generators inside the
   file you own, drawing on the shared GLSL in `src/gfx/glsl/noise.js`.
5. **Linear HDR everywhere until the tonemap pass.** Materials output linear radiance.
   `renderer.toneMapping` is `NoToneMapping` on purpose — the pipeline tonemaps by hand.
   If you set a colour from a hex literal, call `.setHex(v, THREE.SRGBColorSpace)`.
6. **Budget.** 1920×1080 @ 60fps on an RTX 3080 Ti = 16.6 ms. Target ≤ 11 ms so there is
   headroom. Keep draw calls under ~900. Say in your report what your subsystem costs.

## Module shape

```js
// src/world/ocean.js
import * as THREE from 'three';

export function create(opts) {
  return {
    name: 'ocean',
    order: 50,                       // lower runs first; see the manifest for the order map
    enabled: true,

    async init(ctx) { /* build GPU resources; may await */ },
    update(dt, ctx) { /* simulation */ },
    prerender(ctx) { /* push uniforms, render helper targets */ },
    resize(w, h, ctx) { },
    dispose(ctx) { },
  };
}
```

`create()` is called once, synchronously, before `init`. Do no real work in it.

## The context object

```
ctx.engine            the Engine
ctx.renderer          THREE.WebGLRenderer (WebGL2)
ctx.scene             THREE.Scene
ctx.camera            main PerspectiveCamera
ctx.clock             { t, dt, frame, wall }   t = seconds since start
ctx.caps              { maxTextureSize, maxAnisotropy, floatRender, floatLinear, drawBuffers }
ctx.rand              seeded Rand (see src/core/Rand.js) — use .fork(salt) for a private stream
ctx.size              { w, h, dpr }
ctx.get(name, req?)   another module instance, or null
ctx.on/off/emit       tiny event bus
ctx.config            runtime tunables poked by the capture harness / debug UI
```

## Module order map

| order | name         | owns                                                        |
|-------|--------------|-------------------------------------------------------------|
| 10    | `time`       | sun direction, time of day, wind vector — **the authority**  |
| 12    | `lighting`   | sun DirectionalLight, CSM cascades, ambient/sky IBL intensity |
| 20    | `sky`        | atmosphere, sun disc, stars, Halo ring arc, gas giant         |
| 25    | `clouds`     | volumetric cloud raymarch + temporal reprojection             |
| 28    | `env`        | PMREM environment probe captured from sky+clouds              |
| 30    | `terrain`    | heightfield, splat material, tri-planar blend, terrain query  |
| 35    | `rocks`      | sea stacks, cliff walls, boulders, tide-pool rock             |
| 40    | `structures` | Forerunner bridge / platform / pylons                         |
| 45    | `vegetation` | trees, grass, shrubs, wind animation                          |
| 50    | `ocean`      | water surface, refraction, foam, caustics, underwater fog     |
| 55    | `props`      | debris, wreckage, small set dressing                          |
| 60    | `particles`  | sea spray, dust motes, wind sand, impact FX                   |
| 65    | `physics`    | collision world, character sweep, rigid bodies                |
| 70    | `player`     | first-person controller, head bob, camera authority           |
| 75    | `weapons`    | viewmodel, firing, ballistics, recoil                         |
| 80    | `ai`         | enemy actors, perception, combat behaviour                    |
| 85    | `hud`        | reticle, shield/health, ammo, motion tracker                  |
| 90    | `audio`      | procedural audio graph, spatialisation                        |
| 1000  | `pipeline`   | G-buffer, HDR chain, every post pass                          |

## Rendering

`src/render/RenderPipeline.js` is shared infrastructure. `src/render/pipeline.js` is the
module that instantiates it and registers passes. Post passes live in
`src/render/passes/<name>.js`, one file each.

### Layers

Put every object on the right layer (`obj.layers.set(LAYER.X)`), from
`src/render/RenderPipeline.js`:

```
LAYER.OPAQUE      1   terrain, rock, structures, props, vegetation
LAYER.TRANSPARENT 2   water surface, glass — drawn after the opaque copy exists
LAYER.EFFECTS     3   particles, tracers
LAYER.VIEWMODEL   4   first-person weapon (own camera, own near plane)
LAYER.SKY         5   sky dome and clouds
```

### G-buffer

The depth pre-pass fills:

```
MRT0.rgb  view-space normal        MRT0.a  perceptual roughness
MRT1.rg   motion vector (NDC)      MRT1.b  material id    MRT1.a  reserved
depthTex  FloatType depth texture, sampled by fog / water / AO / SSR / clouds
```

Opaque materials must contribute to it. `src/gfx/GBufferMaterial.js` provides the
override material and the `patchForGBuffer()` helper — use it rather than rolling
your own, otherwise your object will punch a hole in AO, SSR and TAA.

### Pass order (post chain, all HDR until `tonemap`)

```
ssao → ssr → cloudComposite → water(refraction consumer) → volumetricFog
     → bloom → motionBlur → dof → taa → tonemap → grade → sharpen → grain
```

A pass with `needsSwap = false` writes to its own target for later passes to sample
(e.g. `ssao`) and leaves the main chain alone. A pass with `scenePass = true` runs
before the post chain (shadow, prepass, opaque, sky, transparent draws).

## Capture / measurement API

The harness drives `window.__HALO__`:

```
await __HALO__.ready
__HALO__.setSize(1920, 1080)
__HALO__.setPose('ref_0000')     // or an object {pos:[x,y,z], rot:[pitch,yaw,roll], fov}
__HALO__.setTime(12.0)           // freeze animated content at a fixed t
__HALO__.advance(48)             // deterministic frames so TAA converges
__HALO__.screenshot()            // data URL
__HALO__.togglePass('bloom', false)
__HALO__.stats()
```

Named poses live in `src/world/poses.js` and correspond to specific frames of
`reference.mp4`. **Do not change a pose's numbers** — the whole score history is
keyed on them.

## Measuring your work

```bash
node tools/capture.mjs --pose ref_0000 --out shots/mine.png
.venv/bin/python tools/metrics.py ref/keyframes/kf_00000.png shots/mine.png
```

Six axes are reported, each 0–100. What they mean and what "AAA" looks like,
calibrated by comparing *different shots of the actual reference game to each other*
(`ref/baseline.json`):

| axis         | measures                          | same-game baseline | your floor |
|--------------|-----------------------------------|--------------------|------------|
| `structure`  | MS-SSIM — composition match       | 0.4 (unmatched)    | > 45 pose-matched |
| `grade`      | HSV histogram — colour grade      | 48 mean / 98 max   | > 65 |
| `perceptual` | LPIPS(alex)                       | 6.2 (unmatched)    | > 45 pose-matched |
| `detail`     | Laplacian-variance ratio          | 79                 | > 80 |
| `geometry`   | Canny edge-density ratio          | 88.5               | > 85 |
| `spectrum`   | power-spectrum slope match        | 97.8               | > 92 |

`detail`, `geometry` and `spectrum` are **composition-independent** — they say
"does this image carry the texture and edge density of a AAA render" no matter what
the camera is pointed at. They are the honest quality signal while the scene is still
being built. `structure` and `perceptual` only become meaningful once your geometry
sits where the reference's geometry sits.

The reference's own signature, averaged over the clip — match these:

```
lum_mean 107.8   lum_std 52.3   p01 17   p50 105   p99 221
shadow_frac 0.050   highlight_frac 0.007      (soft filmic roll-off, nothing clipped)
sat_mean 83.9/255   lab_a +3.2   lab_b +1.4   (subtle warm push, not orange-teal)
lap_var 463   edge_density 0.085   local_contrast 0.192
spectral_slope -2.60                          (natural-image statistics)
```

A flat, untextured CG render lands near −3.0 on spectral slope and under 200 on
`lap_var`. Getting to −2.6/463 is what "AAA texture density" actually means, and it
comes from real high-frequency detail — not from a sharpen filter, which raises
`lap_var` while pushing the slope the wrong way. The metric will catch that.

## The blind test

Numbers are necessary but not sufficient. The final gate is a blind comparison:

```bash
node tools/score.mjs --tag current                     # capture every matched pose
node tools/blind.mjs --shots shots/current --out shots/blind
# -> sheets showing two unlabelled frames, A and B, in randomised order.
#    One is the real game. One is this build. The answer key is written OUTSIDE
#    the repo so a reviewer working in-tree cannot find it.

node tools/blind.mjs --score "ref_00000=A,ref_00450=B,..."   # reveal and tally
```

The bar is a reviewer who cannot reliably tell which is which. If you are a reviewer:
look at the sheet, pick the one that looks better, and say why — **do not go looking
for the key**. Guessing from telltales rather than from quality is the one way to make
this measurement worthless.

## Fitting the poses

`src/world/poses.js` was authored by hand from `docs/WORLD.md`, so the framing is close
but not exact — and a few degrees of yaw is worth more `structure` score than most
rendering work. `tools/fitpose.mjs` searches (x, y, z, pitch, yaw, fov) for the framing
that best matches a reference frame:

```bash
node tools/fitpose.mjs --pose ref_00000 --iters 260 --verbose   # report only
node tools/fitpose.mjs --all --apply                            # rewrite poses.js
```

It drives one live browser session and scores candidates in-page with a multi-scale
normalised gradient correlation — robust to the brightness and colour differences that
still exist between our render and the reference, and sensitive to exactly what matters
here: where edges and silhouettes sit. A few hundred samples takes seconds.

**Only run `--apply` against a complete scene.** Fitting while terrain or rocks are
missing optimises the camera against a world that is not there yet, and bakes that
mistake into every score afterwards. And because the whole history is keyed on these
poses, applying a fit invalidates every previously recorded score — re-baseline
immediately after.
