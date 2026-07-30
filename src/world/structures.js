import * as THREE from 'three';

/**
 * `structures` — The Forerunner bridge and its supports.
 *
 * STUB. See docs/ARCHITECTURE.md for the module contract and docs/WORLD.md for the
 * layout this must respect.
 */
export function create(opts = {}) {
  return {
    name: 'structures',
    order: 40,
    enabled: true,

    async init(ctx) {},
    update(dt, ctx) {},
    prerender(ctx) {},
    resize(w, h, ctx) {},
    dispose(ctx) {},
  };
}
