import * as THREE from 'three';

/* ------------------------------------------------------------------ helpers */

const _quadGeom = new THREE.BufferGeometry();
// Oversized triangle: one primitive, no diagonal seam, no wasted fragments.
_quadGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
_quadGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

/** Draws a single full-screen triangle with the given material. */
export class FullScreenQuad {
  constructor(material) {
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._mesh = new THREE.Mesh(_quadGeom, material);
    this._mesh.frustumCulled = false;
  }
  get material() { return this._mesh.material; }
  set material(m) { this._mesh.material = m; }
  render(renderer) { renderer.render(this._mesh, this._cam); }
  dispose() { this._mesh.material?.dispose?.(); }
}

/** Standard vertex shader for every full-screen pass. */
export const FS_VERT = /* glsl */`
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Convenience: build a full-screen ShaderMaterial with sane defaults.
 *  three injects `#version 300 es` itself for GLSL3 — never write it here. */
export function fsMaterial(fragment, uniforms = {}, defines = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'precision highp float;\nin vec3 position;\nin vec2 uv;\n' + FS_VERT,
    fragmentShader: 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n' + fragment,
    uniforms, defines,
    depthTest: false, depthWrite: false,
  });
}

export function makeRT(w, h, o = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), Object.assign({
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  }, o));
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

/* ------------------------------------------------------------------- passes */

/**
 * Base class for a post pass.
 * A pass reads `pipe.read` (an HDR texture) and writes into the render target it is
 * given. `needsSwap = false` means the pass draws to an offscreen target of its own
 * (e.g. an AO buffer that a later pass samples) and the main chain is untouched.
 */
export class Pass {
  constructor(name) {
    this.name = name;
    this.enabled = true;
    this.needsSwap = true;
    /** Set by the pipeline each frame: true when this pass writes the 8-bit default
     *  framebuffer. A pass must NOT infer that from `out === null` — whether it is last
     *  depends on which other passes happen to be enabled, so a pass that dithers or
     *  quantises only when `out === null` silently becomes dead code the moment
     *  anything is registered after it. */
    this.writesBackbuffer = false;
  }
  init(_ctx, _pipe) {}
  setSize(_w, _h) {}
  /** @param {THREE.WebGLRenderTarget|null} out  null = default framebuffer */
  render(_ctx, _pipe, _out) {}
  dispose() {}
}

/* --------------------------------------------------------------- the pipeline */

/**
 * RenderPipeline is the `pipeline` module. It owns:
 *   - the depth pre-pass / G-buffer (depth, view normal, roughness, motion vectors)
 *   - the HDR scene colour target and the ping-pong chain used by post passes
 *   - the ordered list of post passes
 *
 * Scene rendering itself is split into layers so translucent things (water, particles,
 * the viewmodel) can be sequenced correctly relative to post effects that need the
 * opaque-only image (SSR, refraction, AO).
 */
export const LAYER = {
  DEFAULT: 0,
  OPAQUE: 1,      // terrain, rocks, structures, props
  TRANSPARENT: 2, // water surface, glass, decals-over
  EFFECTS: 3,     // particles, tracers, muzzle flash
  VIEWMODEL: 4,   // first-person weapon: rendered with its own near-field projection
  SKY: 5,         // sky dome / clouds
};

export class RenderPipeline {
  constructor(opts = {}) {
    this.name = 'pipeline';
    this.order = 1000;
    this.opts = Object.assign({ renderScale: 1.0, hdrType: THREE.HalfFloatType }, opts);
    this.passes = [];
    this._byName = new Map();
    this.w = 1; this.h = 1;
    /** viewmodel gets its own camera so a 0.05m-long gun never clips into the world */
    this.viewCamera = new THREE.PerspectiveCamera(55, 16 / 9, 0.002, 12);
    this.frameIndex = 0;
    this.jitter = new THREE.Vector2();
    this.prevViewProj = new THREE.Matrix4();
    this.currViewProj = new THREE.Matrix4();
    this.unjitteredProj = new THREE.Matrix4();
    this._clearColor = new THREE.Color(0, 0, 0);
  }

  addPass(p) {
    this.passes.push(p);
    this._byName.set(p.name, p);
    return p;
  }
  pass(name) { return this._byName.get(name) || null; }

  async init(ctx) {
    this.ctx = ctx;
    const { renderer } = ctx;
    this._maxAniso = renderer.capabilities.getMaxAnisotropy();

    // Depth is sampled by fog, water, AO, SSR and clouds - it must be a real texture.
    this.depthTex = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.depthTex.minFilter = THREE.NearestFilter;
    this.depthTex.magFilter = THREE.NearestFilter;

    // G-buffer: MRT0 = view-space normal (xyz) + roughness (w)
    //           MRT1 = motion vector (xy) + material id (z) + curvature/edge (w)
    this.gbuffer = new THREE.WebGLRenderTarget(1, 1, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.gbuffer.depthTexture = this.depthTex;
    for (const t of this.gbuffer.textures) t.colorSpace = THREE.NoColorSpace;

    // HDR scene colour (shares the pre-pass depth so opaque geometry needs no re-depth).
    this.sceneRT = makeRT(1, 1, { type: this.opts.hdrType, depthBuffer: true });
    this.sceneRT.depthTexture = this.depthTex;

    // Copy of the opaque image, for refraction and SSR to sample.
    this.opaqueRT = makeRT(1, 1, { type: this.opts.hdrType });

    // Ping-pong chain for post.
    this.rtA = makeRT(1, 1, { type: this.opts.hdrType });
    this.rtB = makeRT(1, 1, { type: this.opts.hdrType });
    this.read = this.rtA; this.write = this.rtB;

    // Alpha is forced to 1: the capture harness reads the canvas with toDataURL, and
    // a zero alpha would produce a transparent PNG that every viewer renders as white.
    this._copyMat = fsMaterial(/* glsl */`
      in vec2 vUv; uniform sampler2D tSrc; out vec4 oCol;
      void main(){ oCol = vec4( texture(tSrc, vUv).rgb, 1.0 ); }`, { tSrc: { value: null } });
    this._copyQuad = new FullScreenQuad(this._copyMat);

    for (const p of this.passes) await p.init?.(ctx, this);
  }

  swap() { const t = this.read; this.read = this.write; this.write = t; }

  /** Blit any texture into a target (or the screen). */
  blit(texture, out = null) {
    const r = this.ctx.renderer;
    this._copyMat.uniforms.tSrc.value = texture;
    r.setRenderTarget(out);
    this._copyQuad.render(r);
  }

  resize(w, h, ctx) {
    const s = this.opts.renderScale;
    const rw = Math.max(2, Math.round(w * s)), rh = Math.max(2, Math.round(h * s));
    if (rw === this.w && rh === this.h) return;
    this.w = rw; this.h = rh;
    this.depthTex.image.width = rw; this.depthTex.image.height = rh;
    this.depthTex.needsUpdate = true;
    for (const rt of [this.gbuffer, this.sceneRT, this.opaqueRT, this.rtA, this.rtB]) rt.setSize(rw, rh);
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const p of this.passes) p.setSize?.(rw, rh, ctx || this.ctx);
  }

  /** Halton(2,3) sub-pixel jitter, the standard TAA sample distribution. */
  _applyJitter(camera) {
    const taa = this._byName.get('taa');
    if (!taa || !taa.enabled) { this.jitter.set(0, 0); return; }
    const i = (this.frameIndex % 16) + 1;
    const halton = (idx, base) => { let f = 1, r = 0; while (idx > 0) { f /= base; r += f * (idx % base); idx = Math.floor(idx / base); } return r; };
    const jx = (halton(i, 2) - 0.5) * 2.0 / this.w;
    const jy = (halton(i, 3) - 0.5) * 2.0 / this.h;
    this.jitter.set(jx, jy);
    camera.projectionMatrix.elements[8] += jx;
    camera.projectionMatrix.elements[9] += jy;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  render(ctx) {
    const { renderer, scene, camera } = ctx;
    const cam = camera;

    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    this.unjitteredProj.copy(cam.projectionMatrix);
    this.prevViewProj.copy(this.currViewProj);
    this.currViewProj.multiplyMatrices(this.unjitteredProj, cam.matrixWorldInverse);
    this._applyJitter(cam);

    renderer.setRenderTarget(null);
    renderer.setClearColor(this._clearColor, 1);

    // ---- shadow + G-buffer + opaque, all driven by hook modules -------------
    for (const p of this.passes) if (p.enabled && p.scenePass) p.render(ctx, this, null);

    // ---- post chain --------------------------------------------------------
    this.read = this.rtA; this.write = this.rtB;
    this.blit(this.sceneRT.texture, this.rtA);

    const active = this.passes.filter((p) => p.enabled && !p.scenePass);
    // The last chain pass writes the 8-bit backbuffer; tell it so explicitly rather
    // than making it guess from a null target (see Pass.writesBackbuffer).
    const lastSwapIdx = active.reduce((acc, p, i) => (p.needsSwap === false ? acc : i), -1);
    for (let i = 0; i < active.length; i++) active[i].writesBackbuffer = (i === lastSwapIdx);

    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      const last = i === lastSwapIdx;
      if (p.needsSwap === false) { p.render(ctx, this, null); continue; }
      p.render(ctx, this, last ? null : this.write);
      if (!last) this.swap();
    }
    // Nothing in the chain wrote the backbuffer (no passes at all, or every enabled
    // pass is an off-chain producer like ssao) - present what we have.
    if (lastSwapIdx === -1) this.blit(this.read.texture, null);

    // restore un-jittered projection so gameplay raycasts stay exact
    cam.projectionMatrix.copy(this.unjitteredProj);
    cam.projectionMatrixInverse.copy(this.unjitteredProj).invert();
    this.frameIndex++;
  }

  dispose() {
    for (const p of this.passes) p.dispose?.();
    for (const rt of [this.gbuffer, this.sceneRT, this.opaqueRT, this.rtA, this.rtB]) rt?.dispose();
    this._copyQuad.dispose();
  }
}
