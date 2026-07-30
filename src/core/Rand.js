/**
 * Deterministic RNG. Every piece of procedural content in this game must draw from
 * a seeded stream so that a capture at frame N is byte-comparable across runs -
 * without that the /loop metrics measure noise instead of progress.
 */

/** Mulberry32 - small, fast, good enough distribution for content generation. */
export class Rand {
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x6d2b79f5;
  }
  /** uniform [0,1) */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** uniform [a,b) */
  range(a, b) { return a + (b - a) * this.next(); }
  /** integer [a,b] inclusive */
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  /** symmetric [-a,a] */
  sym(a = 1) { return (this.next() * 2 - 1) * a; }
  /** approximately normal(0,1) via 3-sample irwin-hall */
  normal() { return (this.next() + this.next() + this.next() - 1.5) * 1.8856; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** independent child stream - lets a subsystem consume randomness without
   *  perturbing its siblings' sequences (critical for reproducible scenes) */
  fork(salt = 0) { return new Rand((Math.imul(this.s ^ (salt + 0x85ebca6b), 0xc2b2ae35) >>> 0) ^ 0x27d4eb2f); }
  /** point on unit sphere */
  onSphere() {
    const z = this.range(-1, 1), a = this.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
  }
  /** cosine-weighted point in unit disc */
  inDisc() {
    const r = Math.sqrt(this.next()), a = this.range(0, Math.PI * 2);
    return [r * Math.cos(a), r * Math.sin(a)];
  }
}

/** Hash-based value noise helpers shared by CPU-side generators. */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** 2D value noise in [0,1]. */
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  return lerp(
    lerp(hash2(xi, yi, seed), hash2(xi + 1, yi, seed), u),
    lerp(hash2(xi, yi + 1, seed), hash2(xi + 1, yi + 1, seed), u), v);
}

/** 2D gradient (perlin-style) noise in [-1,1]. */
export function gradNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const g = (ix, iy, dx, dy) => {
    const a = hash2(ix, iy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  return lerp(
    lerp(g(xi, yi, xf, yf), g(xi + 1, yi, xf - 1, yf), u),
    lerp(g(xi, yi + 1, xf, yf - 1), g(xi + 1, yi + 1, xf - 1, yf - 1), u), v);
}

/** Fractal brownian motion over gradNoise2. */
export function fbm2(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5, seed = 0) {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * gradNoise2(x * f, y * f, seed + i * 131);
    norm += a; a *= gain; f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal - the classic generator for eroded rock and cliff silhouettes. */
export function ridged2(x, y, octaves = 5, lacunarity = 2.05, gain = 0.5, seed = 0) {
  let a = 0.5, f = 1, sum = 0, norm = 0, prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(gradNoise2(x * f, y * f, seed + i * 977));
    n *= n; n *= prev; prev = n;
    sum += a * n; norm += a; a *= gain; f *= lacunarity;
  }
  return sum / norm;
}

/** Worley / cellular noise. Returns { f1, f2 } distances (scaled to cell units). */
export function worley2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 7919);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2 };
}
