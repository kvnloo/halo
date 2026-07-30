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
 *   7. Viewmodel          — own camera and near plane, own depth range
 *
 * Steps 4-7 sit here rather than in the post chain because they need the depth
 * buffer that the pre-pass filled, and post passes run after depth is gone.
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
    gbufMat.uniforms.uCurrViewProj.value
      .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
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
    const vm = pipe.viewCamera;
    vm.position.copy(cam.position);
    vm.quaternion.copy(cam.quaternion);
    vm.updateMatrixWorld(true);
    vm.layers.disableAll();
    vm.layers.enable(LAYER.VIEWMODEL);
    renderer.setRenderTarget(pipe.sceneRT);
    renderer.clearDepth();
    renderer.render(scene, vm);

    cam.layers.enableAll();
    gbufMat.captureHistory(scene);
  };

  p.dispose = () => gbufMat.dispose();
  return p;
}
