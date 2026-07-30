import { RenderPipeline } from './RenderPipeline.js';
import { createScenePass } from './passes/scene.js';

/**
 * `pipeline` module — instantiates the RenderPipeline and registers passes.
 *
 * Pass files land independently, so a missing one is warned about and skipped
 * rather than taking the renderer down. Order here IS the post chain order.
 */
/**
 * Post chain order. This IS the order they run in.
 *
 * TAA resolves BEFORE bloom, DoF and motion blur, and that ordering is not negotiable:
 * bloom's threshold test fires on different sub-pixel highlights on every jitter phase
 * if it is fed a jittered, un-resolved image, which shows up as highlights crawling and
 * sparkling frame to frame. DoF and motion blur likewise want a clean, converged image
 * to gather from — blurring aliased input just spreads the aliasing.
 *
 * ssao and ssr are off-chain producers (needsSwap = false): they write their own targets
 * for the forward materials and later passes to sample, and leave the chain untouched.
 */
const PASS_MANIFEST = [
  { name: 'ssao',           load: () => import('./passes/ssao.js') },
  { name: 'ssr',            load: () => import('./passes/ssr.js') },
  { name: 'cloudComposite', load: () => import('./passes/cloudComposite.js') },
  { name: 'volumetricFog',  load: () => import('./passes/volumetricFog.js') },
  { name: 'taa',            load: () => import('./passes/taa.js') },
  { name: 'dof',            load: () => import('./passes/dof.js') },
  { name: 'motionBlur',     load: () => import('./passes/motionBlur.js') },
  { name: 'bloom',          load: () => import('./passes/bloom.js') },
  { name: 'tonemap',        load: () => import('./passes/tonemap.js') },
  { name: 'grade',          load: () => import('./passes/grade.js') },
  { name: 'sharpen',        load: () => import('./passes/sharpen.js') },
  { name: 'grain',          load: () => import('./passes/grain.js') },
];

export function create(opts = {}) {
  const pipe = new RenderPipeline({ renderScale: 1.0 });
  pipe.addPass(createScenePass());

  return {
    name: 'pipeline',
    order: 1000,
    pipe,
    pass: (n) => pipe.pass(n),

    async init(ctx) {
      const missing = [];
      for (const entry of PASS_MANIFEST) {
        let mod;
        try { mod = await entry.load(); }
        catch (e) { missing.push(`${entry.name}: ${e.message.split('\n')[0]}`); continue; }
        const make = mod.create || mod.default;
        if (typeof make !== 'function') { missing.push(`${entry.name}: no create()`); continue; }
        try {
          const pass = make(opts);
          if (pass) { pass.name = pass.name || entry.name; pipe.addPass(pass); }
        } catch (e) { missing.push(`${entry.name}: ${e.message}`); }
      }
      if (missing.length) console.warn('[pipeline] passes not loaded:\n  ' + missing.join('\n  '));
      globalThis.__HALO_MISSING_PASSES__ = missing;

      await pipe.init(ctx);
      pipe.resize(ctx.size.w, ctx.size.h, ctx);
    },

    resize(w, h, ctx) { pipe.resize(w, h, ctx); },
    render(ctx) { pipe.render(ctx); },
    dispose() { pipe.dispose(); },
  };
}
