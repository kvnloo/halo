import * as THREE from 'three';
import { Pass, LAYER } from '../RenderPipeline.js';
import { createGBufferMaterial } from '../../gfx/GBufferMaterial.js';

/**
 * The scene pass: everything that draws actual geometry, in the one order that works.
 *
 *   1. G-buffer pre-pass  — depth, view normal + roughness, motion vectors
 *   2. Sky                — drawn into the HDR target at max depth
 *   3. Opaque             — depth test EQUAL against the pre-pass, so no overdraw
 *   4. Opaque copy        — snapshot for refraction / SSR consumers
 *   5. Transparent        — water, glass
 *   6. Effects            — particles, tracers
 *   7. Viewmodel          — own camera, own near plane, own DEPTH ATTACHMENT
 *
 * Steps 4-7 sit here rather than in the post chain because they need the depth
 * buffer that the pre-pass filled.
 *
 * DEPTH INVARIANT (KNOWN_ISSUES #18, fixed here): `pipe.depthTex` is written exactly once
 * per frame, by step 1, and is never cleared or overwritten again. Sky (step 2) and the
 * transparent and effects layers (5, 6) all render with `depthWrite: false`; the viewmodel
 * (7) renders into `pipe.viewDepthTex` instead. So from the end of step 1 onward the shared
 * depth texture holds true opaque world depth, and the whole post chain can sample it.
 * If you add a draw here, it must not write depth unless it is opaque world geometry that
 * also went through step 1.
 */
export function createScenePass() {
  const p = new Pass('scene');
  p.scenePass = true;

  const gbufMat = createGBufferMaterial();
  const skyCam = new THREE.PerspectiveCamera();
  let opaqueNeedsCopy = true;

  p.init = (ctx, pipe) => {
    p.pipe = pipe;
    p.ctx = ctx;
  };

  p.render = (ctx, pipe) => {
    const { renderer, scene, camera } = ctx;
    const cam = camera;

    // ---------------------------------------------------- 1. G-buffer pre-pass
    //
    // Velocity is the difference of two UN-JITTERED clip positions. Both jitters enter
    // the true expression and only as a difference, so pairing a jittered current
    // matrix with an un-jittered previous one (which this used to do) is wrong by
    // exactly the current jitter — see research/taa.md §1.2 and KNOWN_ISSUES #1.
    // `pipe.currViewProj` / `pipe.prevViewProj` are both built from `unjitteredProj`
    // before `_applyJitter` runs, which is the same pair three.js's own TRAANode feeds
    // its VelocityNode, and it is what `terrain.js`'s G-buffer material already uses.
    //
    // This does NOT unjitter the rasterisation. `GBufferMaterial`'s `gl_Position` comes
    // from three's `<project_vertex>` using the jittered `projectionMatrix` uniform;
    // `vCurClip` is a separate varying built from `uCurrViewProj`. Depth, normals and
    // colour stay jittered, as they must — only the value written to MRT1.rg moves.
    // The invariant this buys: a static camera on static geometry writes a bit-exact
    // ZERO motion vector, so TAA's Catmull-Rom history fetch lands on the texel centre
    // and is the identity. Verify with `node tools/_mvprobe.mjs`.
    //
    // `mvLegacyJitter` restores the old pairing for a same-page-load A/B (taa.js reads
    // the same flag and re-adds its compensation). It is a diagnostic, not a mode.
    if (ctx.config?.mvLegacyJitter) {
      gbufMat.uniforms.uCurrViewProj.value
        .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    } else {
      gbufMat.uniforms.uCurrViewProj.value.copy(pipe.currViewProj);
    }
    gbufMat.uniforms.uPrevViewProj.value.copy(pipe.prevViewProj);

    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = gbufMat;

    cam.layers.disableAll();
    cam.layers.enable(LAYER.OPAQUE);
    cam.layers.enable(LAYER.DEFAULT);

    renderer.setRenderTarget(pipe.gbuffer);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    scene.overrideMaterial = prevOverride;

    // -------------------------------------------------- 2/3. sky then opaque
    renderer.setRenderTarget(pipe.sceneRT);
    renderer.setClearColor(0x000000, 1);  // opaque: captures go through toDataURL
    renderer.clear(true, false, false);   // keep the pre-pass depth

    // Sky writes no depth and tests against the far plane; the opaque pass then
    // overwrites it wherever geometry exists.
    cam.layers.disableAll();
    cam.layers.enable(LAYER.SKY);
    renderer.render(scene, cam);

    cam.layers.disableAll();
    cam.layers.enable(LAYER.OPAQUE);
    cam.layers.enable(LAYER.DEFAULT);
    renderer.render(scene, cam);

    // --------------------------------------------------- 4. opaque snapshot
    if (opaqueNeedsCopy) pipe.blit(pipe.sceneRT.texture, pipe.opaqueRT);

    // --------------------------------------------- 5/6. transparent + effects
    renderer.setRenderTarget(pipe.sceneRT);
    cam.layers.disableAll();
    cam.layers.enable(LAYER.TRANSPARENT);
    renderer.render(scene, cam);

    cam.layers.disableAll();
    cam.layers.enable(LAYER.EFFECTS);
    renderer.render(scene, cam);

    // ------------------------------------------------------- 7. viewmodel
    //
    // The weapon is drawn through its own camera (near 0.002 m, far 12 m) so a 5 cm-long
    // gun model never intersects the beach. That needs a depth buffer with nothing of the
    // world in it — but for four waves this pass got one by calling `renderer.clearDepth()`
    // on `sceneRT`, whose depth attachment IS `pipe.depthTex`, the buffer the G-buffer
    // pre-pass had just filled and the entire post chain is about to sample. The clear
    // wiped the world and refilled it with the weapon, so `dof`, `motionBlur`, `taa`,
    // `volumetricFog`, `ssao`, `ssr` and water refraction all ran against a depth buffer
    // that read "sky at the far plane" for every world pixel (KNOWN_ISSUES #18). Measured
    // at ref_00000: 10.1% of the frame carried depth (the gun), against a G-buffer opaque
    // mask of 85.7%.
    //
    // So the weapon gets its OWN attachment. `pipe.viewDepthTex` is swapped onto `sceneRT`
    // for this one draw and the world's is swapped back immediately after; three re-runs
    // `setupDepthRenderbuffer` when a bound target's `depthTexture` changes identity, so
    // this costs two `framebufferTexture2D` calls and no copies. The colour attachment is
    // unchanged, so the weapon still composites over the world exactly as before, and it
    // still cannot clip into it — it is depth-tested only against a freshly cleared buffer
    // of its own. Verify both halves with `node tools/_depthprobe.mjs`.
    const vm = pipe.viewCamera;
    vm.position.copy(cam.position);
    vm.quaternion.copy(cam.quaternion);
    vm.updateMatrixWorld(true);
    vm.layers.disableAll();
    vm.layers.enable(LAYER.VIEWMODEL);
    //
    // `vmLegacyDepth=1` restores the old shared-buffer clear for a same-build A/B — the
    // only honest way to compare, since a source-level A/B cannot be run simultaneously
    // and `src/` is not quiescent during a wave (KNOWN_ISSUES #16, reports/screenspace.md
    // §6). It is a diagnostic, not a mode: it reintroduces #18 in full.
    const legacyDepth = !!ctx.config?.vmLegacyDepth;
    if (!legacyDepth) pipe.sceneRT.depthTexture = pipe.viewDepthTex;
    renderer.setRenderTarget(pipe.sceneRT);   // re-bind: this is what performs the swap
    renderer.clearDepth();                    // clears viewDepthTex, NOT the world's depth
    renderer.render(scene, vm);
    // Put the world's depth back before anything else can bind sceneRT. Leaving the
    // viewmodel attachment on it would silently move the damage one frame later instead
    // of removing it.
    if (!legacyDepth) pipe.sceneRT.depthTexture = pipe.depthTex;

    cam.layers.enableAll();
    gbufMat.captureHistory(scene);
  };

  p.dispose = () => gbufMat.dispose();
  return p;
}
