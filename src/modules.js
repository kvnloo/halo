/**
 * Module manifest.
 *
 * Each entry is loaded lazily. A missing or broken module is reported and skipped
 * rather than taking the whole build down - that is deliberate: subsystems land
 * independently, and a half-built game still has to boot so it can be looked at.
 *
 * `?only=sky,clouds,pipeline` loads a subset (isolated preview for one subsystem).
 * `?skip=ai,audio` drops specific ones.
 */

const MANIFEST = [
  // --- world simulation & lighting authority --------------------------------
  { name: 'time',        load: () => import('./world/time.js') },
  { name: 'lighting',    load: () => import('./render/lighting.js') },

  // --- environment ----------------------------------------------------------
  { name: 'sky',         load: () => import('./world/sky.js') },
  { name: 'clouds',      load: () => import('./world/clouds.js') },
  { name: 'env',         load: () => import('./render/env.js') },

  // --- terrain & set --------------------------------------------------------
  { name: 'terrain',     load: () => import('./world/terrain.js') },
  { name: 'rocks',       load: () => import('./world/rocks.js') },
  { name: 'structures',  load: () => import('./world/structures.js') },
  { name: 'vegetation',  load: () => import('./world/vegetation.js') },
  { name: 'ocean',       load: () => import('./world/ocean.js') },
  { name: 'props',       load: () => import('./world/props.js') },
  { name: 'particles',   load: () => import('./world/particles.js') },

  // --- gameplay -------------------------------------------------------------
  { name: 'physics',     load: () => import('./game/physics.js') },
  { name: 'player',      load: () => import('./game/player.js') },
  { name: 'weapons',     load: () => import('./game/weapons.js') },
  { name: 'ai',          load: () => import('./game/ai.js') },
  { name: 'hud',         load: () => import('./game/hud.js') },
  { name: 'audio',       load: () => import('./game/audio.js') },

  // --- rendering (last: it consumes everything above) -----------------------
  { name: 'pipeline',    load: () => import('./render/pipeline.js') },
];

export async function buildModules(opts = {}) {
  const qs = opts.qs || new URLSearchParams();
  const only = qs.get('only') ? new Set(qs.get('only').split(',').map((s) => s.trim())) : null;
  const skip = qs.get('skip') ? new Set(qs.get('skip').split(',').map((s) => s.trim())) : new Set();

  const out = [];
  const missing = [];
  for (const entry of MANIFEST) {
    if (only && !only.has(entry.name)) continue;
    if (skip.has(entry.name)) continue;
    let mod;
    try {
      mod = await entry.load();
    } catch (e) {
      missing.push(`${entry.name}: ${e.message}`);
      continue;
    }
    const factory = mod.create || mod.default;
    if (typeof factory !== 'function') {
      missing.push(`${entry.name}: no create() export`);
      continue;
    }
    try {
      const inst = factory(opts);
      if (inst) {
        inst.name = inst.name || entry.name;
        out.push(inst);
      }
    } catch (e) {
      missing.push(`${entry.name}: create() threw — ${e.message}`);
    }
  }
  if (missing.length) console.warn('[modules] not loaded:\n  ' + missing.join('\n  '));
  globalThis.__HALO_MISSING__ = missing;
  return out;
}
