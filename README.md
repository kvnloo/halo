# Silent Cartographer

A first-person shooter in Three.js, built to match the visual bar of
*Halo: Campaign Evolved*. The target is the 39-second 4K/60 beach sequence in
`reference.mp4`; every visual decision in this repo is measured against it rather
than eyeballed.

**Reference video (X):** [my repost of the 4K Campaign Evolved beach capture](https://x.com/_kvnloo/status/2082664626655805446)  
(original: [@GeForce_JacobF](https://x.com/GeForce_JacobF/status/2082333194335170983) — 4K max / DLSS 4.5)

```bash
npm install
npm run dev            # http://localhost:5173
```

## The reference material is not in this repo

`reference.mp4` and everything under `ref/` — the extracted keyframes and 4K detail crops —
are frames of a commercial game. They are not ours to redistribute, so they are gitignored
and absent from history. The engine runs without them; the *measurement* tooling does not,
because `tools/metrics.py` has nothing to score against.

**Public source clip:** the 4K beach capture via the repost link above. Locally,
download/save it as `reference.mp4` for the measurement loop (do not commit the file).

To reproduce the loop, supply that capture (or your own beach take) as `reference.mp4` and rebuild
the layout the tools expect. No script survives for this — the extraction was done by hand
early on and never got written down, which is its own small lesson:

```
ref/keyframes/kf_NNNNN.png   # frame NNNNN of the clip, zero-padded to 5 digits
ref/detail/*_4k.png          # full-res crops: rock, sand, sky, bridge, weapon
ref/roi_signatures.json      # per-region stats the scores are compared against
```

```bash
ffmpeg -i reference.mp4 -vf "select='not(mod(n,15))'" -vsync 0 \
       -frame_pts 1 ref/keyframes/kf_%05d.png
.venv/bin/python tools/roi.py --all ref/keyframes ref/rois     # regenerate signatures
```

Camera poses in `src/world/poses.js` are hand-fitted to *our* clip, so a different capture
needs them refitted (`tools/fitpose.mjs`). Scores are only meaningful against the reference
they were fitted to — the numbers in `scores/history.jsonl` and `docs/TARGETS.md` are ours.

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
