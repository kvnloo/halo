# Silent Cartographer

A first-person shooter in Three.js, built to match the visual bar of
*Halo: Campaign Evolved*. The target is the 39-second 4K/60 beach sequence in
`reference.mp4`; every visual decision in this repo is measured against it rather
than eyeballed.

```bash
npm install
npm run dev            # http://localhost:5173
```

## How this is built

The interesting part of this project is not the renderer, it is the **loop**.

You cannot tell whether two images look the same by looking at them — not reliably, and
not repeatably across dozens of iterations. So the build is driven by instruments:

```bash
# capture a deterministic frame at a camera pose matched to a reference frame
node tools/capture.mjs --pose ref_00000 --out shots/a.png

# score it on six independent axes
.venv/bin/python tools/metrics.py ref/keyframes/kf_00000.png shots/a.png

# capture every matched pose, score them, append to the history
node tools/score.mjs --tag my-change
node tools/score.mjs --history
```

| axis | instrument | what it catches |
|------|-----------|-----------------|
| `structure` | multi-scale SSIM | geometry in the wrong place |
| `grade` | 3D HSV histogram, Bhattacharyya | colour grade drift |
| `perceptual` | LPIPS (AlexNet) | "looks wrong" that no other metric sees |
| `detail` | Laplacian-variance ratio | missing texture density |
| `geometry` | Canny edge-density ratio | missing geometric detail |
| `spectrum` | power-spectrum slope | CG flatness, and over-sharpening |

`detail`, `geometry` and `spectrum` are composition-independent: they say whether a
render carries the same statistics as a AAA frame regardless of where the camera points.
That makes them usable as a quality signal long before the scene is finished.

The metrics are calibrated by scoring the reference game **against itself** across 91
pairs of different shots (`ref/baseline.json`). That fixes what a passing score is:
identical frames score 100, adjacent frames 97.7, different shots of the same game 39.3
— with `detail` 79, `geometry` 88.5 and `spectrum` 97.8 holding up across compositions.

Per-region targets — sand, water, rock, sky, weapon, each measured separately — are in
[`docs/TARGETS.md`](docs/TARGETS.md). They are what tell you, for instance, that the
shoreline carries more high-frequency energy than the sky does, so the ground is the
hard part.

## Layout

```
src/core/       Engine, deterministic RNG and noise
src/render/     RenderPipeline, lighting/CSM, post passes (one file each)
src/gfx/        shared GLSL noise, the common material layer, G-buffer material
src/world/      sky, clouds, terrain, rocks, structures, vegetation, ocean, props
src/game/       physics, player, weapons, AI, HUD, audio
tools/          capture, metrics, region crops, side-by-side sheets, scoring
docs/           the contracts: ARCHITECTURE, WORLD, API, TARGETS, WEAPON
ref/            frames, region crops and measured signatures from reference.mp4
```

Everything is a **module** with a small fixed lifecycle, registered in
`src/modules.js`. Modules never import each other — they meet at runtime through
`ctx.get(name)` against the frozen interfaces in [`docs/API.md`](docs/API.md). That is
what lets a dozen subsystems be built in parallel without collapsing into a knot.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before changing anything.

## Constraints

- **Procedural.** No asset downloads, no texture files, no model files. Every texture is
  generated on the GPU at load time; every mesh is generated from code.
- **Deterministic.** Seeded RNG throughout, fixed timestep in capture mode. The same seed
  and pose produce the same bytes — otherwise the metrics measure noise instead of work.
- **WebGL2**, Three.js r185, no engine forks.
- 1920×1080 at 60 fps with headroom on an RTX 3080 Ti.
