import * as THREE from 'three';

/**
 * `clouds` — Raymarched volumetric clouds with temporal reprojection.
 *
 * STUB. See docs/ARCHITECTURE.md for the module contract and docs/WORLD.md for the
 * layout this must respect.
 */
export function create(opts = {}) {
  return {
    name: 'clouds',
    order: 25,
    enabled: true,

    async init(ctx) {},
    update(dt, ctx) {},
    prerender(ctx) {},
    resize(w, h, ctx) {},
    dispose(ctx) {},
  };
}
