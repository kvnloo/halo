import * as THREE from 'three';

/**
 * `weapons` — Weapon viewmodel, firing, recoil, ballistics.
 *
 * STUB. See docs/ARCHITECTURE.md for the module contract and docs/WORLD.md for the
 * layout this must respect.
 */
export function create(opts = {}) {
  return {
    name: 'weapons',
    order: 75,
    enabled: true,

    async init(ctx) {},
    update(dt, ctx) {},
    prerender(ctx) {},
    resize(w, h, ctx) {},
    dispose(ctx) {},
  };
}
