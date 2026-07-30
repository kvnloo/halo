import * as THREE from 'three';

/**
 * `ocean` — Ocean surface, refraction, shoreline foam, caustics, underwater fog.
 *
 * STUB. See docs/ARCHITECTURE.md for the module contract and docs/WORLD.md for the
 * layout this must respect.
 */
export function create(opts = {}) {
  return {
    name: 'ocean',
    order: 50,
    enabled: true,

    async init(ctx) {},
    update(dt, ctx) {},
    prerender(ctx) {},
    resize(w, h, ctx) {},
    dispose(ctx) {},
  };
}
