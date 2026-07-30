import * as THREE from 'three';
import { Rand } from './Rand.js';

/**
 * Engine - owns the WebGL device, the frame loop, and the module registry.
 *
 * Everything in the game is a Module (see docs/ARCHITECTURE.md). A module is a plain
 * object with any subset of these hooks; all of them are optional:
 *
 *   name           : string, unique
 *   order          : number, lower runs first (default 100)
 *   async init(ctx): build resources; may return a promise; may report progress
 *   update(dt,ctx) : simulation, once per frame, before rendering
 *   prerender(ctx) : last-chance per-frame GPU work (uniform pushes, RT updates)
 *   resize(w,h,ctx): viewport changed
 *   dispose(ctx)   : free GPU resources
 *
 * The context object handed to every hook is stable for the lifetime of the engine,
 * so modules can hold a reference to it. Modules must NOT import each other; they
 * find each other through ctx.get(name), which keeps the dependency graph flat and
 * lets separate agents own separate files without collisions.
 */
export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = Object.assign({
      seed: 1337,
      deterministic: false,   // fixed timestep + frozen wall clock, for captures
      fixedDt: 1 / 60,
      pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
      width: 0, height: 0,    // 0 = follow the canvas element
      shadows: true,
      msaa: 0,                // native MSAA is off: TAA is the AA of record
    }, opts);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,   // required for deterministic toDataURL captures
      failIfMajorPerformanceCaveat: false,
    });
    renderer.debug.checkShaderErrors = true;
    renderer.setPixelRatio(this.opts.pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The pipeline tonemaps by hand in its own pass; three must stay linear/passthrough.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = this.opts.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    this.renderer = renderer;

    const gl = renderer.getContext();
    this.caps = {
      isWebGL2: renderer.capabilities.isWebGL2 !== false,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      floatRender: !!gl.getExtension('EXT_color_buffer_float'),
      floatLinear: !!gl.getExtension('OES_texture_float_linear'),
      drawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
      renderer: (() => {
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      })(),
    };

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.06, 12000);
    this.camera.matrixAutoUpdate = true;

    this.clock = { t: 0, dt: 0, frame: 0, wall: 0 };
    this.rand = new Rand(this.opts.seed);
    this.modules = [];
    this._byName = new Map();
    this._running = false;
    this._raf = 0;
    this._resizeObs = null;
    this.stats = { fps: 0, ms: 0, drawCalls: 0, triangles: 0, programs: 0 };
    this._fpsAccum = 0; this._fpsFrames = 0;

    /** Shared context handed to every module hook. */
    this.ctx = {
      engine: this,
      renderer,
      scene: this.scene,
      camera: this.camera,
      clock: this.clock,
      caps: this.caps,
      rand: this.rand,
      size: { w: 1, h: 1, dpr: this.opts.pixelRatio },
      /** module lookup by name; throws only if `required` */
      get: (name, required = false) => {
        const m = this._byName.get(name);
        if (!m && required) throw new Error(`[engine] required module "${name}" not registered`);
        return m || null;
      },
      /** cross-module event bus - kept intentionally tiny */
      on: (evt, fn) => { (this._bus[evt] ||= []).push(fn); return () => this.off(evt, fn); },
      off: (evt, fn) => { const a = this._bus[evt]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
      emit: (evt, payload) => { const a = this._bus[evt]; if (a) for (const f of a.slice()) f(payload); },
      /** tunables that the capture harness / debug UI can poke at runtime */
      config: {},
    };
    this._bus = {};

    this._onResize = () => this.resize();
    globalThis.addEventListener?.('resize', this._onResize);
  }

  /** Register a module. Order is resolved at init time. */
  add(mod) {
    if (!mod || !mod.name) throw new Error('[engine] module needs a name');
    if (this._byName.has(mod.name)) throw new Error(`[engine] duplicate module "${mod.name}"`);
    this._byName.set(mod.name, mod);
    this.modules.push(mod);
    return mod;
  }

  /** Initialise every module in `order`, reporting 0..1 progress. */
  async init(onProgress = () => {}) {
    this.resize();
    this.modules.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    const n = this.modules.length;
    for (let i = 0; i < n; i++) {
      const m = this.modules[i];
      onProgress(i / n, m.name);
      // One module throwing must not take down the whole build. Subsystems are authored
      // independently and land at different times; a half-finished module should be
      // reported and skipped, exactly like a missing one, so everything else can still
      // be looked at and measured.
      try {
        if (m.init) {
          const t0 = performance.now();
          await m.init(this.ctx);
          m._initMs = performance.now() - t0;
        }
        if (m.resize) m.resize(this.ctx.size.w, this.ctx.size.h, this.ctx);
      } catch (e) {
        m._failed = e;
        m.enabled = false;
        (this.failedModules ||= []).push({ name: m.name, error: String(e?.stack || e) });
        console.error(`[engine] module "${m.name}" failed to init and was disabled:\n`, e);
        // Unhook it so update/prerender never touch a half-built module.
        m.update = m.prerender = m.resize = undefined;
      }
    }
    onProgress(1, 'ready');
    this.initialised = true;
    this.ctx.emit('engine:ready');
  }

  resize(w, h) {
    const dpr = this.opts.pixelRatio;
    if (this.opts.width && this.opts.height) { w = this.opts.width; h = this.opts.height; }
    if (!w || !h) {
      const r = this.canvas.getBoundingClientRect?.();
      w = Math.max(2, Math.round(r?.width || this.canvas.clientWidth || 1920));
      h = Math.max(2, Math.round(r?.height || this.canvas.clientHeight || 1080));
    }
    if (this.ctx.size.w === w && this.ctx.size.h === h) return;
    this.ctx.size.w = w; this.ctx.size.h = h; this.ctx.size.dpr = dpr;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.initialised) for (const m of this.modules) m.resize?.(w, h, this.ctx);
    this.ctx.emit('engine:resize', { w, h });
  }

  /** One simulation + render step. dt in seconds. */
  step(dt) {
    const c = this.clock;
    c.dt = dt; c.t += dt; c.frame++;
    for (const m of this.modules) m.update?.(dt, this.ctx);
    this.camera.updateMatrixWorld(true);
    for (const m of this.modules) m.prerender?.(this.ctx);
    const pipe = this._byName.get('pipeline');
    if (pipe?.render) pipe.render(this.ctx);
    else { this.renderer.clear(); this.renderer.render(this.scene, this.camera); }
    const info = this.renderer.info;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;
    info.reset();
  }

  start() {
    if (this._running) return;
    this._running = true;
    let last = performance.now();
    const tick = (now) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(tick);
      let dt = (now - last) / 1000; last = now;
      if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
      dt = Math.min(dt, 0.1);                 // never let a hitch teleport the sim
      if (this.opts.deterministic) dt = this.opts.fixedDt;
      const t0 = performance.now();
      this.step(dt);
      const ms = performance.now() - t0;
      this.stats.ms = this.stats.ms * 0.9 + ms * 0.1;
      this._fpsAccum += dt; this._fpsFrames++;
      if (this._fpsAccum >= 0.5) {
        this.stats.fps = this._fpsFrames / this._fpsAccum;
        this._fpsAccum = 0; this._fpsFrames = 0;
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() { this._running = false; cancelAnimationFrame(this._raf); }

  /** Advance exactly n frames synchronously - used by the capture harness so TAA and
   *  every temporal buffer converges to a stable image before the screenshot. */
  advance(n, dt = this.opts.fixedDt) { for (let i = 0; i < n; i++) this.step(dt); }

  dispose() {
    this.stop();
    globalThis.removeEventListener?.('resize', this._onResize);
    for (const m of this.modules) m.dispose?.(this.ctx);
    this.renderer.dispose();
  }
}
