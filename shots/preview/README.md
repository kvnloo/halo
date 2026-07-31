# Preview

Regenerate any time — including while agents are building — with:

```bash
node tools/preview.mjs                 # capture all 9 matched poses, rebuild the grid
node tools/preview.mjs --no-capture    # rebuild the grid from existing frames
node tools/preview.mjs --compare       # also write reference|render|deltaE sheets
```

## `preview.png`

**5760 x 3240** — a 3x3 grid of nine untouched 1080p frames, no downscaling. One cell
per matched reference pose (`ref_00000` ... `ref_02220`), each labelled in-frame so the
cell stays exactly 1920x1080.

Individual frames are alongside it as `ref_NNNNN.png`.

## What exists right now

Sky, atmosphere, Halo ring, Threshold, sun, stars, and the tonemap/grade/TAA/bloom
chain. **The flat plane below the horizon is the clear colour, not ground.**

Terrain, ocean, clouds, rocks, the Forerunner bridge, vegetation, the weapon, HUD,
particles, props and AI are being built concurrently as this is written. Roughly 70% of
the pixels in a reference frame come from subsystems not yet in the scene.

`00_sky_progress.png` shows sky-as-first-built -> after critic fixes -> the real game.

## Sky: two critic rounds

Round 1 scored 54/100, round 2 scored 31/100 — the second reviewer measured harder, and
was right to. What it caught that round 1 missed:

| defect | measured | after |
|---|---|---|
| ring width | 5.3 deg vs reference 1.1-1.3 deg | `ringWidthRatio` 0.104 -> 0.040 |
| ring surface | isotropic blotches, "camouflage netting" | 15:1 anisotropy -> vertical striations |
| Threshold value | 0.59x sky luminance; reference is 1.63x | a 2.8x inversion, now corrected |
| Threshold belts | 5.4x too little band structure | belt separation is a VALUE mix, `lat*22` |
| limb darkening | Lambert sphere; gas giants have none | `mix(0.93, 1.0, pow(ndv, 0.5))` |

The ring insight was the good one: the band sits 2R away, so arc length along it is
compressed about two orders of magnitude more than distance across it. Isotropic-in-km
noise therefore *has* to read as blotches; the physically correct appearance is
near-vertical striations. That is a real fact about the geometry, not a taste call.

## Still wrong

- The sky is the only thing in frame, so `structure` and `perceptual` are near zero and
  the tonal range (`p01`, `p99`, `shadow_frac`) is meaningless until geometry lands.
- The grade is provisional by design — see `docs/KNOWN_ISSUES.md` section 6.

Method and numbers: `docs/TARGETS.md`. Live defects: `docs/KNOWN_ISSUES.md`.
