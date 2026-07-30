import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `tonemap` pass — Exposure and tonemapping (AgX).
 *
 * STUB: currently a pass-through. See docs/ARCHITECTURE.md for the pass contract.
 */
export function create(opts = {}) {
  const p = new Pass('tonemap');
  let quad = null, mat = null;

  p.init = (ctx, pipe) => {
    mat = fsMaterial(`
      in vec2 vUv; uniform sampler2D tSrc; out vec4 oCol;
      void main(){ oCol = texture(tSrc, vUv); }`, { tSrc: { value: null } });
    quad = new FullScreenQuad(mat);
  };

  p.render = (ctx, pipe, out) => {
    mat.uniforms.tSrc.value = pipe.read.texture;
    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.setSize = (w, h) => {};
  p.dispose = () => quad?.dispose();
  return p;
}
