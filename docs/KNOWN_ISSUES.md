# Known issues

Live defects and coordination hazards. Anything here is real and reproducible; fix it
deliberately, not opportunistically.

---

## 1. Motion vectors are computed against mismatched projections — CRITICAL, COUPLED

**Where:** `src/render/passes/scene.js`, the G-buffer pre-pass setup.

```js
gbufMat.uniforms.uCurrViewProj.value
  .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);  // JITTERED
gbufMat.uniforms.uPrevViewProj.value.copy(pipe.prevViewProj);       // UN-jittered
```

`RenderPipeline.render()` applies the Halton sub-pixel jitter to `cam.projectionMatrix`
*before* the scene passes run, while `pipe.currViewProj` / `pipe.prevViewProj` are both
built from `unjitteredProj`. So `uCurrViewProj` carries the jitter and `uPrevViewProj`
does not, and every motion vector in `gbuffer.textures[1].rg` inherits a ±½ px
per-frame error even when nothing in the scene is moving.

**Impact.** For motion blur a half-pixel is negligible. For TAA it is not: feeding that
velocity into the history lookup random-walks the resolve by half a pixel every frame,
which is permanent, unrecoverable blur — exactly the failure that would show up as a
`detail` and `spectrum` regression and be misattributed to the TAA implementation.

**Correct fix:** use the un-jittered `pipe.currViewProj` for `uCurrViewProj`, so both
matrices are jitter-free and the velocity is exactly zero for static geometry.

**Why it is not just fixed:** `src/render/passes/taa.js` already works around it. That
pass derives reprojection from depth (unprojecting with the *jittered* inverse view-proj,
which is exact for the pixel as rasterised, then re-projecting through the un-jittered
matrices), and consults the G-buffer velocity only where the two disagree by more than
1.5 px — applying a `+0.5 * uJitter` correction when it does. **That correction assumes
the bug is present.** Repairing `scene.js` without removing the compensation in
`taa.js` replaces one half-pixel error with a different one.

**Therefore:** these two files must be changed in the same commit, by one person, with a
determinism check and a `detail`/`spectrum` measurement either side:

```bash
node tools/capture.mjs --pose ref_01500 --out shots/mv_before.png --settle 48
# ... edit scene.js AND taa.js together ...
node tools/capture.mjs --pose ref_01500 --out shots/mv_after.png --settle 48
.venv/bin/python tools/metrics.py --stats shots/mv_before.png
.venv/bin/python tools/metrics.py --stats shots/mv_after.png   # lap_var must not drop
cmp shots/mv_after.png <(second identical capture)             # must stay deterministic
```

Found by the TAA implementer during Phase 1. Deferred until Phase 1's critic round
finishes, so the review is not run against a moving target.

---

## 2. Scene incomplete — expected, tracked here so it is not re-reported

As of Phase 1 only `time`, `lighting`, `sky`, and the `tonemap`/`grade`/`taa`/`bloom`
passes are implemented. `terrain`, `rocks`, `ocean`, `clouds`, `structures`,
`vegetation`, `props`, `particles`, `player`, `weapons`, `ai`, `hud`, `audio`, `env`
and the remaining post passes are stubs that render nothing.

Consequences that are **not** bugs right now:

- Captures show a flat clear-colour plane below the horizon. That is the clear, not ground.
- The `sky` ROI measures far below its target (`lap_var` 27 vs 253) because clouds supply
  most of a sky's tonal structure. See the caveat in `docs/TARGETS.md` about regions
  being fixed screen rectangles rather than semantic masks.
- `structure` and `perceptual` are near zero at every pose, because the geometry that
  would match the reference framing does not exist yet.

## 3. Poses are unfitted

`src/world/poses.js` was authored by hand from `docs/WORLD.md`. `tools/fitpose.mjs`
exists to refit them, but must only be run against a **complete** scene — see the
"Fitting the poses" section of `docs/ARCHITECTURE.md`. Applying a fit invalidates every
previously recorded score.
