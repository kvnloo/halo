import * as THREE from 'three';

/**
 * `physics` — the collision world.
 *
 * Deliberately not a general rigid-body engine. This game needs exactly four things,
 * and needs all four to be exact and cheap:
 *
 *   1. a character sweep against terrain + analytic colliders (the player must never
 *      tunnel, jitter on rippled sand, or catch on a 2 cm lip)
 *   2. fast raycasts for hitscan weapons and AI line of sight
 *   3. simple dynamic bodies for shells, grenades and debris
 *   4. an overlap query for explosions
 *
 * Terrain is queried analytically through `terrain.height(x,z)` instead of being
 * turned into triangles: exact at any scale, and far cheaper than a mesh BVH.
 * Everything else is a small set of primitive colliders in a uniform XZ grid.
 *
 * Simulation runs at a fixed 120 Hz substep, so behaviour is frame-rate independent
 * and reproducible under the deterministic capture harness.
 */

const MASK = {
  WORLD: 1 << 0,
  CHARACTER: 1 << 1,
  PROJECTILE: 1 << 2,
  DEBRIS: 1 << 3,
  ALL: 0xffff,
};

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 8;

/* ------------------------------------------------------------- primitives */

function raySphere(ro, rd, c, r) {
  const ox = ro.x - c.x, oy = ro.y - c.y, oz = ro.z - c.z;
  const b = ox * rd.x + oy * rd.y + oz * rd.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? t1 : -1;
}

function rayAABB(ro, rd, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    const inv = 1 / (rd[ax] || 1e-12);
    let t1 = (min[ax] - ro[ax]) * inv;
    let t2 = (max[ax] - ro[ax]) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) return -1;
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : -1);
}

const _ba = new THREE.Vector3(), _oa = new THREE.Vector3();
function rayCapsule(ro, rd, a, b, r) {
  _ba.subVectors(b, a);
  _oa.subVectors(ro, a);
  const baba = _ba.dot(_ba), bard = _ba.dot(rd), baoa = _ba.dot(_oa);
  const rdoa = rd.dot(_oa), oaoa = _oa.dot(_oa);
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0 && Math.abs(A) > 1e-9) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (t >= 0 && y > 0 && y < baba) return t;
  }
  let best = -1;
  for (const p of [a, b]) {
    const t = raySphere(ro, rd, p, r);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/* ----------------------------------------------------------------- module */

export function create() {
  const statics = [];
  const bodies = new Map();
  let nextId = 1;
  let accum = 0;

  // Broadphase: uniform grid over XZ. The playable area is a few hundred metres and
  // colliders are sparse, so a flat grid beats any tree here.
  const CELL = 16;
  const grid = new Map();
  const cellKey = (cx, cz) => (cx * 73856093) ^ (cz * 19349663);

  let terrain = null;
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _n = new THREE.Vector3(), _tmpQ = new THREE.Quaternion();
  const _cands = [];
  const _seen = new Set();

  /** True only if the collider carries the fields its own type requires. */
  function validCollider(c) {
    if (!c || typeof c !== 'object') return false;
    switch (c.type) {
      case 'sphere': return !!c.center?.isVector3 && Number.isFinite(c.radius);
      case 'box': return !!c.box?.isBox3 && !!c.box.min && !!c.box.max;
      case 'capsule':
      case 'cylinder': return !!c.a?.isVector3 && !!c.b?.isVector3 && Number.isFinite(c.radius);
      default: return false;
    }
  }

  function computeAabb(c) {
    const box = new THREE.Box3();
    if (c.type === 'sphere') {
      box.setFromCenterAndSize(c.center, new THREE.Vector3(c.radius * 2, c.radius * 2, c.radius * 2));
    } else if (c.type === 'box') {
      box.copy(c.box);
    } else if (c.type === 'capsule' || c.type === 'cylinder') {
      box.setFromPoints([c.a, c.b]).expandByScalar(c.radius);
    } else {
      box.setFromCenterAndSize(c.center || new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    }
    return box;
  }

  function insertStatic(c) {
    const b = c.aabb;
    const x0 = Math.floor(b.min.x / CELL), x1 = Math.floor(b.max.x / CELL);
    const z0 = Math.floor(b.min.z / CELL), z1 = Math.floor(b.max.z / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = cellKey(cx, cz);
        let arr = grid.get(k);
        if (!arr) grid.set(k, arr = []);
        arr.push(c);
      }
    }
  }

  function candidates(p0, p1, pad, out) {
    out.length = 0;
    _seen.clear();
    const x0 = Math.floor((Math.min(p0.x, p1.x) - pad) / CELL);
    const x1 = Math.floor((Math.max(p0.x, p1.x) + pad) / CELL);
    const z0 = Math.floor((Math.min(p0.z, p1.z) - pad) / CELL);
    const z1 = Math.floor((Math.max(p0.z, p1.z) + pad) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const arr = grid.get(cellKey(cx, cz));
        if (!arr) continue;
        for (const c of arr) if (!_seen.has(c)) { _seen.add(c); out.push(c); }
      }
    }
    return out;
  }

  /** Penetration depth of a sphere into a collider, and the separating normal. */
  function resolvePenetration(c, p, radius, outNormal) {
    if (c.type === 'sphere') {
      _v.subVectors(p, c.center);
      const d = _v.length();
      const pen = c.radius + radius - d;
      if (pen <= 0) return 0;
      if (d > 1e-6) outNormal.copy(_v).divideScalar(d); else outNormal.set(0, 1, 0);
      return pen;
    }
    if (c.type === 'box') {
      const b = c.box;
      _v.set(
        THREE.MathUtils.clamp(p.x, b.min.x, b.max.x),
        THREE.MathUtils.clamp(p.y, b.min.y, b.max.y),
        THREE.MathUtils.clamp(p.z, b.min.z, b.max.z));
      _v2.subVectors(p, _v);
      const d = _v2.length();
      if (d > 1e-6) {
        const pen = radius - d;
        if (pen <= 0) return 0;
        outNormal.copy(_v2).divideScalar(d);
        return pen;
      }
      // centre inside the box: push out along the shallowest axis
      const dx = Math.min(p.x - b.min.x, b.max.x - p.x);
      const dy = Math.min(p.y - b.min.y, b.max.y - p.y);
      const dz = Math.min(p.z - b.min.z, b.max.z - p.z);
      const m = Math.min(dx, dy, dz);
      outNormal.set(0, 0, 0);
      if (m === dx) outNormal.x = p.x > (b.min.x + b.max.x) * 0.5 ? 1 : -1;
      else if (m === dy) outNormal.y = p.y > (b.min.y + b.max.y) * 0.5 ? 1 : -1;
      else outNormal.z = p.z > (b.min.z + b.max.z) * 0.5 ? 1 : -1;
      return m + radius;
    }
    if (c.type === 'capsule' || c.type === 'cylinder') {
      _v.subVectors(c.b, c.a);
      const len2 = _v.lengthSq();
      _v2.subVectors(p, c.a);
      let t = len2 > 1e-9 ? _v2.dot(_v) / len2 : 0;
      if (c.type === 'capsule') t = THREE.MathUtils.clamp(t, 0, 1);
      else if (t < 0 || t > 1) return 0;
      _v3.copy(c.a).addScaledVector(_v, t);
      _v2.subVectors(p, _v3);
      const d = _v2.length();
      const pen = c.radius + radius - d;
      if (pen <= 0) return 0;
      if (d > 1e-6) outNormal.copy(_v2).divideScalar(d); else outNormal.set(0, 1, 0);
      return pen;
    }
    return 0;
  }

  const api = {
    name: 'physics',
    order: 65,
    enabled: true,
    MASK,
    gravity: -19.6,

    async init(ctx) {
      terrain = ctx.get('terrain');
      collectColliders(ctx);
      // Set-dressing modules may build their colliders during init, in any order.
      ctx.on('engine:ready', () => collectColliders(ctx));
    },

    /* --------------------------------------------------------- statics */
    /** Rejects malformed colliders rather than throwing. Colliders arrive from half a
     *  dozen independently-authored modules; one bad entry must not take down the
     *  world. Returns null and warns instead. */
    addStatic(c) {
      if (c?._registered) return c.id;
      if (!validCollider(c)) {
        if (!addStatic._warned) { addStatic._warned = new Set(); }
        const k = `${c?.type}`;
        if (!addStatic._warned.has(k)) {
          addStatic._warned.add(k);
          console.warn(`[physics] ignoring malformed collider (type="${c?.type}") — `
            + `see docs/API.md for the required fields per type`);
        }
        return null;
      }
      c.id = nextId++;
      c.mask = c.mask ?? MASK.WORLD;
      c.aabb = c.aabb || computeAabb(c);
      c._registered = true;
      statics.push(c);
      insertStatic(c);
      return c.id;
    },
    get staticCount() { return statics.length; },

    /* ---------------------------------------------------------- bodies */
    addBody(desc) {
      const b = Object.assign({
        id: nextId++,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        angularVelocity: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        radius: 0.08,
        mass: 1,
        restitution: 0.35,
        friction: 0.6,
        gravityScale: 1,
        drag: 0.02,
        mask: MASK.DEBRIS,
        sleeping: false,
        life: Infinity,
        onHit: null,
      }, desc);
      bodies.set(b.id, b);
      return b;
    },
    removeBody(id) { bodies.delete(id); },
    get bodyCount() { return bodies.size; },
    get bodies() { return bodies; },

    /* --------------------------------------------------------- queries */
    /**
     * Ray against terrain + statics. The terrain leg marches with a growing step and
     * then bisects the crossing — exact enough for hitscan at any range, ~40 height
     * samples worst case, and it cannot miss a thin ridge the way a fixed step can.
     */
    raycast(origin, dir, maxDist = 1000, mask = MASK.ALL) {
      let best = null;
      const d = _v.copy(dir).normalize();

      candidates(origin, _v2.copy(origin).addScaledVector(d, maxDist), 4, _cands);
      for (const c of _cands) {
        if (!(c.mask & mask)) continue;
        let t = -1;
        if (c.type === 'sphere') t = raySphere(origin, d, c.center, c.radius);
        else if (c.type === 'box') t = rayAABB(origin, d, c.box.min, c.box.max);
        else if (c.type === 'capsule' || c.type === 'cylinder') t = rayCapsule(origin, d, c.a, c.b, c.radius);
        if (t >= 0 && t <= maxDist && (!best || t < best.t)) {
          const point = new THREE.Vector3().copy(origin).addScaledVector(d, t);
          const normal = new THREE.Vector3();
          // nudge outward so the penetration test resolves a stable normal
          resolvePenetration(c, _v3.copy(point).addScaledVector(d, -0.002), 0.004, normal);
          if (normal.lengthSq() < 1e-6) normal.copy(d).negate();
          best = { point, normal, t, body: c, surface: c.surface || 'rock' };
        }
      }

      if (terrain && (mask & MASK.WORLD)) {
        const limit = best ? Math.min(best.t, maxDist) : maxDist;
        let step = Math.max(0.2, limit / 240);
        let prevT = 0;
        if (origin.y - terrain.height(origin.x, origin.z) >= 0) {
          for (let t = step; t <= limit; t += step) {
            const px = origin.x + d.x * t, pz = origin.z + d.z * t, py = origin.y + d.y * t;
            if (py - terrain.height(px, pz) < 0) {
              let lo = prevT, hi = t;
              for (let i = 0; i < 24; i++) {
                const mid = (lo + hi) * 0.5;
                const mh = (origin.y + d.y * mid) - terrain.height(origin.x + d.x * mid, origin.z + d.z * mid);
                if (mh < 0) hi = mid; else lo = mid;
              }
              const point = new THREE.Vector3().copy(origin).addScaledVector(d, hi);
              const normal = terrain.normal(point.x, point.z, new THREE.Vector3());
              const s = terrain.sample ? terrain.sample(point.x, point.z) : null;
              best = { point, normal, t: hi, body: null,
                surface: s && s.wetness > 0.5 ? 'wetsand' : 'sand' };
              break;
            }
            prevT = t;
            step = Math.min(step * 1.06, 6);
          }
        }
      }
      return best;
    },

    /** Conservative-advancement sphere cast: converges fast, cannot tunnel. */
    sphereCast(origin, dir, radius, maxDist = 100, mask = MASK.ALL) {
      const d = _v.copy(dir).normalize();
      const p = new THREE.Vector3().copy(origin);
      let travelled = 0;
      for (let i = 0; i < 48 && travelled < maxDist; i++) {
        const clear = api.clearance(p, radius, mask);
        if (clear.dist <= 1e-3) {
          return { point: p.clone(), normal: clear.normal.clone(), t: travelled, body: clear.body };
        }
        const step = Math.min(Math.max(clear.dist, 0.02), maxDist - travelled);
        p.addScaledVector(d, step);
        travelled += step;
      }
      return null;
    },

    /** Signed distance from a sphere to the nearest surface, plus that normal. */
    clearance(p, radius, mask = MASK.ALL) {
      let dist = Infinity;
      const normal = new THREE.Vector3(0, 1, 0);
      let body = null;
      candidates(p, p, radius + 2, _cands);
      for (const c of _cands) {
        if (!(c.mask & mask)) continue;
        const pen = resolvePenetration(c, p, radius, _n);
        if (pen > 0 && -pen < dist) { dist = -pen; normal.copy(_n); body = c; }
      }
      if (terrain && (mask & MASK.WORLD)) {
        const dy = p.y - radius - terrain.height(p.x, p.z);
        if (dy < dist) { dist = dy; terrain.normal(p.x, p.z, normal); body = null; }
      }
      return { dist: dist === Infinity ? 1e6 : dist, normal, body };
    },

    overlapSphere(center, radius, mask = MASK.ALL) {
      const out = [];
      candidates(center, center, radius, _cands);
      for (const c of _cands) {
        if (!(c.mask & mask)) continue;
        if (resolvePenetration(c, center, radius, _n) > 0) out.push(c);
      }
      for (const b of bodies.values()) {
        if (!(b.mask & mask)) continue;
        if (b.position.distanceTo(center) <= radius + b.radius) out.push(b);
      }
      return out;
    },

    /**
     * Move a character capsule with collide-and-slide.
     *
     * The terrain leg samples a small disc rather than a single point and sits the
     * capsule on the highest sample. That is specifically what stops the camera
     * jittering as the player walks over centimetre-scale sand ripples and cobbles —
     * a single-point sample makes the eye height twitch every frame.
     */
    moveCharacter(position, delta, opts = {}) {
      const radius = opts.radius ?? 0.42;
      const height = opts.height ?? 1.78;
      const stepHeight = opts.stepHeight ?? 0.55;
      const maxSlope = Math.cos(THREE.MathUtils.degToRad(opts.maxSlopeDeg ?? 52));
      const mask = opts.mask ?? MASK.WORLD;

      const pos = position.clone();
      let grounded = false;
      const groundNormal = new THREE.Vector3(0, 1, 0);
      let groundSurface = 'sand';
      const centres = [radius, height - radius];
      const move = delta.clone();

      for (let iter = 0; iter < 4 && move.lengthSq() > 1e-10; iter++) {
        pos.add(move);
        move.set(0, 0, 0);

        for (const cy of centres) {
          const c = _v3.set(pos.x, pos.y + cy, pos.z);
          candidates(c, c, radius + 2, _cands);
          for (const col of _cands) {
            if (!(col.mask & mask)) continue;
            const pen = resolvePenetration(col, c, radius, _n);
            if (pen > 0) {
              pos.addScaledVector(_n, pen);
              c.set(pos.x, pos.y + cy, pos.z);
              if (_n.y > maxSlope) { grounded = true; groundNormal.copy(_n); }
            }
          }
        }

        if (terrain) {
          let hMax = -Infinity, hx = pos.x, hz = pos.z;
          const r = radius * 0.75;
          const OFF = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]];
          for (const [ox, oz] of OFF) {
            const h = terrain.height(pos.x + ox, pos.z + oz);
            if (h > hMax) { hMax = h; hx = pos.x + ox; hz = pos.z + oz; }
          }
          if (pos.y < hMax) {
            const n = terrain.normal(hx, hz, _n);
            if (n.y > maxSlope || pos.y > hMax - stepHeight) {
              pos.y = hMax;
              grounded = true;
              groundNormal.copy(n);
              const s = terrain.sample ? terrain.sample(pos.x, pos.z) : null;
              groundSurface = s && s.wetness > 0.5 ? 'wetsand' : 'sand';
            } else {
              pos.sub(_v.copy(delta).projectOnVector(n));  // too steep: slide
            }
          } else if (pos.y - hMax < 0.06) {
            grounded = true;
            terrain.normal(pos.x, pos.z, groundNormal);
          }
        }
      }

      return { position: pos, grounded, groundNormal, surface: groundSurface };
    },

    /* ------------------------------------------------------------- step */
    step(dt) {
      accum += dt;
      let steps = 0;
      while (accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
        accum -= FIXED_DT;
        steps++;
        substep(FIXED_DT);
      }
      if (steps === MAX_SUBSTEPS) accum = 0;   // shed load rather than spiral
    },

    update(dt, ctx) {
      if (ctx.config.frozen) return;
      api.step(dt);
    },
  };

  function collectColliders(ctx) {
    for (const src of ['rocks', 'structures', 'props', 'vegetation', 'terrain']) {
      const m = ctx.get(src);
      if (m?.colliders) for (const c of m.colliders) api.addStatic(c);
    }
  }

  function substep(h) {
    let dead = null;
    for (const b of bodies.values()) {
      if (b.sleeping) continue;
      b.life -= h;
      if (b.life <= 0) { (dead ||= []).push(b.id); continue; }

      b.velocity.y += api.gravity * b.gravityScale * h;
      if (b.drag) b.velocity.multiplyScalar(Math.max(0, 1 - b.drag * h));

      const next = _v2.copy(b.position).addScaledVector(b.velocity, h);

      let hit = null;
      if (terrain) {
        const gh = terrain.height(next.x, next.z);
        if (next.y - b.radius <= gh) {
          hit = { point: new THREE.Vector3(next.x, gh, next.z),
                  normal: terrain.normal(next.x, next.z, new THREE.Vector3()), surface: 'sand' };
          next.y = gh + b.radius;
        }
      }
      if (!hit) {
        candidates(b.position, next, b.radius + 1, _cands);
        for (const c of _cands) {
          if (!(c.mask & MASK.WORLD)) continue;
          const pen = resolvePenetration(c, next, b.radius, _n);
          if (pen > 0) {
            next.addScaledVector(_n, pen);
            hit = { point: next.clone(), normal: _n.clone(), surface: c.surface || 'rock' };
            break;
          }
        }
      }

      if (hit) {
        const vn = b.velocity.dot(hit.normal);
        if (vn < 0) {
          b.velocity.addScaledVector(hit.normal, -(1 + b.restitution) * vn);
          _v3.copy(b.velocity).addScaledVector(hit.normal, -b.velocity.dot(hit.normal));
          b.velocity.addScaledVector(_v3, -Math.min(1, b.friction * h * 12));
          b.onHit?.(hit, b);
        }
        if (b.velocity.lengthSq() < 0.06 && Math.abs(vn) < 0.4) b.sleeping = true;
      }

      b.position.copy(next);

      if (b.angularVelocity.lengthSq() > 1e-8) {
        b.quaternion.premultiply(_tmpQ.setFromAxisAngle(
          _v.copy(b.angularVelocity).normalize(), b.angularVelocity.length() * h));
      }
    }
    if (dead) for (const id of dead) bodies.delete(id);
  }

  return api;
}
