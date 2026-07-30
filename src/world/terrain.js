import * as THREE from 'three';

/**
 * `terrain` — Heightfield beach and seafloor, splat material, height/normal queries.
 *
 * STUB. See docs/ARCHITECTURE.md for the module contract and docs/WORLD.md for the
 * layout this must respect.
 */
export function create(opts = {}) {
  return {
    name: 'terrain',
    order: 30,
    enabled: true,

    async init(ctx) {},
    update(dt, ctx) {},
    prerender(ctx) {},
    resize(w, h, ctx) {},
    dispose(ctx) {},
  };
}
