import * as THREE from 'three';
import { HASH_GLSL, VALUE_NOISE_GLSL, GRAD_NOISE_GLSL, WORLEY_GLSL, FBM_GLSL, TILEBREAK_GLSL } from '../gfx/glsl/noise.js';
import { applyWorldMaterial, configureTexture, sharedAerialUniforms } from '../gfx/materialCommon.js';
import { MAT_ID, patchForGBuffer } from '../gfx/GBufferMaterial.js';
import { LAYER, fsMaterial, FullScreenQuad } from '../render/RenderPipeline.js';

/**
 * `terrain` — the beach, the seafloor, and the query API everything else stands on.
 *
 * ## Shape
 *
 * The elevation profile of docs/WORLD.md is a 1-D table of (Z -> y) measured at X = 0.
 * It is resampled at init into a monotone-cubic LUT (`profileY`), and modulated along X
 * by a second LUT (`shoreAt`) carrying the waterline offset, the beach-width scale, the
 * berm height and the alongshore cobble density. Everything else — dunes, beach cusps,
 * the tide-pool shelf, swash terraces, cobbles, wind ripples — is noise layered on top,
 * in one function that is written ONCE and evaluated in three places:
 *
 *   - the terrain vertex shader (full detail, per vertex)
 *   - the shadow depth material (same displacement, or the terrain's shadow is a plane)
 *   - JS, at init, into two lookup tables that back `height()` / `normal()` / `sample()`
 *
 * The JS hash/noise here is a deliberate mirror of `src/gfx/glsl/noise.js` — same
 * constants, same order of operations — so the CPU tables and the rendered surface agree
 * to well under a centimetre at every scale the tables carry. Vegetation that scatters
 * against `height()` sits ON the ground the player sees, not near it.
 *
 * ## Geometry: a morphing clipmap
 *
 * A camera-centred geometry clipmap: one square centre block plus 10 concentric rings,
 * each with twice the spacing of the one inside it, 3 cm at the camera out to 2.9 km.
 * Every level is one instance of the same ring mesh, so the whole 630k-triangle
 * heightfield is three draw calls.
 *
 * LOD seams are killed by CDLOD morphing driven by *Chebyshev distance in the level's
 * own lattice*, not by Euclidean distance from the camera. That matters: it makes the
 * morph reach exactly 1.0 along the whole of a level's outer boundary — corners
 * included — so the outer ring of vertices lands exactly on the parent lattice and the
 * two surfaces are provably coincident. A distance-from-camera morph is only
 * approximately 1 at the boundary and leaves a crack at the corners.
 *
 * ## Why the G-buffer needs a second material
 *
 * `RenderPipeline`'s pre-pass renders the scene with `scene.overrideMaterial =
 * gbufMat`, whose vertex shader has no idea about this displacement. A displaced
 * surface tested LEQUAL against a *flat* pre-pass depth is a surface with holes in it.
 * So both terrain materials set `allowOverride = false` (three r185 honours that per
 * material) and a second, cheap MRT material draws the same geometry with the same
 * displacement into the G-buffer. The two are gated against each other by
 * `geometry.drawRange` in `onBeforeRender`, restored in `onAfterRender` so the shadow
 * pass — which runs inside every `renderer.render()` call and does *not* fire those
 * hooks — always sees a full draw range.
 *
 * ## Where the detail comes from
 *
 * docs/TARGETS.md wants lap_var 521 / edge_density 0.120 on `sand`. That is a cobble
 * pavement, and pavements are geometry:
 *
 *   - within ~5 m the clipmap itself resolves 10-25 cm cobbles and 12-20 cm wind
 *     ripples as real displacement, with real normals and real self-shading;
 *   - 15 cm - 1.4 m stones are instanced meshes with real silhouettes and cast shadows;
 *   - beyond that the same cobble and ripple fields continue as normal maps, so the
 *     statistics do not fall off a cliff at the geometry's edge.
 *
 * Wind ripple direction follows `time.state.windDir`, pushed as `uTWind` each frame.
 */

/* ============================================================== world constants */

const ZW0 = -6.5;           // the profile's z coordinate where y crosses sea level

/** docs/WORLD.md, densified between the published knots so the spline stays honest. */
const PROFILE = [
  [-1400, -54.0], [-900, -47.0], [-620, -39.0], [-460, -32.5], [-340, -26.0],
  [-260, -18.4], [-180, -11.0], [-124, -7.3], [-70, -4.2], [-46, -2.42],
  [-26, -1.15], [-16, -0.56], [-6.5, 0.0], [-3.0, 0.145], [0, 0.35],
  [4.0, 0.70], [9, 1.30], [15, 1.98], [22, 2.75], [30, 3.95], [38, 5.40],
  [43, 7.05], [48, 9.0], [53, 15.2], [58, 26.0], [65, 41.5], [72, 58.0],
  [86, 64.5], [120, 68.0], [300, 70.0],
];

const PROF_N = 4096, PROF_Z0 = -1400, PROF_Z1 = 300;
const SHORE_N = 2048, SHORE_X0 = -1000, SHORE_X1 = 1000;

// clipmap
const CM_M = 192;                 // quads across a level
const CM_S0 = 0.030;              // metres per lattice unit at level 0
const CM_RINGS = 10;              // rings on top of the centre block
const CM_NEAR_RINGS = 3;          // rings that cast shadows (inner ~1.9 m..15 m)

// CPU height tables
const FINE_STEP = 0.5, FINE_X0 = -270, FINE_X1 = 175, FINE_Z0 = -150, FINE_Z1 = 150;
const CRS_STEP = 3.0, CRS_X0 = -840, CRS_X1 = 840, CRS_Z0 = -840, CRS_Z1 = 840;

/* ================================================================== JS noise ==
 * A mirror of src/gfx/glsl/noise.js. Same constants, same operation order. */

const fract = (x) => x - Math.floor(x);

function hash12(x, y) {
  let ax = fract(x * 0.1031), ay = fract(y * 0.1031), az = fract(x * 0.1031);
  const d = ax * (ay + 33.33) + ay * (az + 33.33) + az * (ax + 33.33);
  ax += d; ay += d; az += d;
  return fract((ax + ay) * az);
}
function hash22(x, y, out) {
  let ax = fract(x * 0.1031), ay = fract(y * 0.1030), az = fract(x * 0.0973);
  const d = ax * (ay + 33.33) + ay * (az + 33.33) + az * (ax + 33.33);
  ax += d; ay += d; az += d;
  out[0] = fract((ax + ay) * az);
  out[1] = fract((ax + az) * ay);
  return out;
}
const _h2 = [0, 0];
/** dot of the normalised hashed gradient at lattice (ix,iz) with (dx,dz) */
function gdot(ix, iz, dx, dz) {
  let ax = fract(ix * 0.1031), ay = fract(iz * 0.1030), az = fract(ix * 0.0973);
  const d = ax * (ay + 33.33) + ay * (az + 33.33) + az * (ax + 33.33);
  ax += d; ay += d; az += d;
  let gx = fract((ax + ay) * az) * 2 - 1;
  let gz = fract((ax + az) * ay) * 2 - 1;
  const l = Math.sqrt(gx * gx + gz * gz) || 1;
  return (gx * dx + gz * dz) / l;
}
function gnoise2(px, pz) {
  const ix = Math.floor(px), iz = Math.floor(pz);
  const fx = px - ix, fz = pz - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const va = gdot(ix, iz, fx, fz);
  const vb = gdot(ix + 1, iz, fx - 1, fz);
  const vc = gdot(ix, iz + 1, fx, fz - 1);
  const vd = gdot(ix + 1, iz + 1, fx - 1, fz - 1);
  const a = va + (vb - va) * ux;
  const b = vc + (vd - vc) * ux;
  return (a + (b - a) * uz) * 1.4142;
}
/** matches FBM_GLSL fbm2(): M2 rotation, lacunarity 2.02, gain 0.5, amplitude-normalised */
function fbm2(px, pz, oct) {
  let a = 0.5, s = 0, n = 0, x = px, z = pz;
  for (let i = 0; i < oct; i++) {
    s += a * gnoise2(x, z); n += a;
    const nx = (0.80 * x - 0.60 * z) * 2.02;
    const nz = (0.60 * x + 0.80 * z) * 2.02;
    x = nx; z = nz; a *= 0.5;
  }
  return s / Math.max(n, 1e-4);
}

/* ============================================================ profile spline == */

/** Fritsch-Carlson monotone cubic — no overshoot, so the beach never grows a hump. */
function monotoneSpline(knots) {
  const n = knots.length;
  const xs = knots.map((k) => k[0]), ys = knots.map((k) => k[1]);
  const d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) * 0.5;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0] + (x - xs[0]) * m[0];
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]) * m[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const h = xs[hi] - xs[lo], t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo]
         + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}

/* ============================================================= shared GLSL ==== */

const NOISE_CORE = HASH_GLSL + VALUE_NOISE_GLSL + GRAD_NOISE_GLSL + WORLEY_GLSL + FBM_GLSL;

/** The height field, shared verbatim by the surface, depth and G-buffer materials. */
const FIELD_GLSL = /* glsl */`
uniform sampler2D tTProfile;     // 1-D: r = y(z)
uniform sampler2D tTShore;       // 1-D: r = waterline shift, g = width scale,
                                 //      b = berm boost, a = alongshore cobble density
uniform vec4  uTProfRange;       // x0, x1, n, 1/(x1-x0)
uniform vec4  uTShoreRange;
uniform vec2  uTWind;            // unit vector, direction the wind blows toward
uniform float uTDetail;          // global detail scale, ctx.config.terrainDetail

const float TZW0 = ${ZW0.toFixed(3)};

float tLut1(sampler2D tex, vec4 rng, float x, int ch){
  float u = clamp((x - rng.x) * rng.w, 0.0, 1.0) * (rng.z - 1.0);
  float i0 = floor(u); float f = u - i0;
  int a = int(i0); int b = min(a + 1, int(rng.z) - 1);
  vec4 va = texelFetch(tex, ivec2(a, 0), 0);
  vec4 vb = texelFetch(tex, ivec2(b, 0), 0);
  vec4 v = mix(va, vb, f);
  return ch == 0 ? v.r : (ch == 1 ? v.g : (ch == 2 ? v.b : v.a));
}
vec4 tLut4(sampler2D tex, vec4 rng, float x){
  float u = clamp((x - rng.x) * rng.w, 0.0, 1.0) * (rng.z - 1.0);
  float i0 = floor(u); float f = u - i0;
  int a = int(i0); int b = min(a + 1, int(rng.z) - 1);
  return mix(texelFetch(tex, ivec2(a, 0), 0), texelFetch(tex, ivec2(b, 0), 0), f);
}

float tProfileY(float z){ return tLut1(tTProfile, uTProfRange, z, 0); }
vec4  tShoreAt(float x){ return tLut4(tTShore, uTShoreRange, x); }

/** Shore-normal profile coordinate: the z a point would have on the X=0 cross-section. */
float tShoreZ(vec2 P, vec4 sh){
  return TZW0 + (P.y - TZW0 - sh.x) / max(sh.y, 0.12);
}

/** Worley cell: x = F1 distance, y = F2, z = a per-cell hash. The per-cell hash is the
 *  whole point — it lets the fragment shader give every cobble the vertex shader lifted
 *  out of the sand its own albedo, from near-black basalt to pale quartz. Cobbles whose
 *  shading is uncorrelated with their shape read as noise; correlated, they read as
 *  stones, and that correlation is most of the reference's lum_std and edge density. */
vec3 tCell(vec2 p){
  vec2 n = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0; vec2 best = n;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 g = vec2(float(i), float(j));
    vec2 c = n + g;
    vec2 o = hash22(c);
    // squash cells slightly so stones are ellipsoids, not marbles
    vec2 dv = g + o - f;
    float d = length(dv * vec2(1.0, 0.74 + 0.5 * hash12(c + 5.1)));
    if (d < f1){ f2 = f1; f1 = d; best = c; } else if (d < f2){ f2 = d; }
  }
  return vec3(f1, f2, hash12(best + 3.7));
}

/** Ellipsoid cap of a stone whose radius is r cell units: 1 at the crown, 0 at the
 *  rim. This is the shape both the displacement and the splat use, so a stone that
 *  stands proud of the sand is also shaded as one. */
float tStoneCap(float f1, float r){
  float d = clamp(f1 / max(r, 0.02), 0.0, 1.0);
  return sqrt(max(1.0 - d * d, 0.0));
}

/** Shared by the displacement and the splat so stone shading tracks stone geometry. */
float tCobbleMask(vec2 P, float alongshore, float y){
  // A cobble beach is a PAVEMENT: stones everywhere, denser in drifts. The old form
  // was smoothstep(-0.16, 0.30, fbm) with no floor, which left the whole near field
  // at zero — the foreground rendered as bare sand with no stones in it at all, and
  // took lum_std and edge_density down with it. Floor 0.28, drifts to 1.18.
  float m = alongshore * (0.28 + 0.90 * smoothstep(-0.30, 0.25, fbm2(P * 0.42 + 61.0, 3)));
  return m * (1.0 - smoothstep(4.8, 7.6, y));
}

/* ---- the layers, cheapest first. lod gates the expensive ones by clipmap level. */
float tHeight(vec2 P, int lod){
  vec4 sh = tShoreAt(P.x);
  float zp = tShoreZ(P, sh);
  float y = tProfileY(zp);

  // how much of "beach" we are on: 0 offshore / inland, 1 across the intertidal + berm
  float beach = smoothstep(-140.0, -34.0, zp) * (1.0 - smoothstep(40.0, 62.0, zp));

  // macro dune / bar undulation, 40-110 m
  y += fbm2(P * 0.0125, 4) * (0.55 + 1.35 * beach);
  // meso swales and berm scallops, 6-14 m
  y += fbm2(P * 0.098 + 17.0, 3) * (0.10 + 0.30 * beach) * sh.z;

  // headland shoulder at (108, 20) so rocks has something to stand on
  {
    vec2 d = (P - vec2(108.0, 20.0)) / 46.0;
    y += 11.0 * exp(-dot(d, d) * 1.15);
  }
  // tide-pool rock shelf, X [-70,-18] Z [-14,-2]: flatten, then scoop pools out of it
  {
    float sx = smoothstep(-78.0, -66.0, P.x) * (1.0 - smoothstep(-24.0, -12.0, P.x));
    float sz = smoothstep(-17.5, -13.0, P.y) * (1.0 - smoothstep(-4.0, 0.5, P.y));
    float shelf = sx * sz;
    if (shelf > 0.001){
      float flatY = 0.16 + 0.20 * fbm2(P * 0.16 + 91.0, 2);
      y = mix(y, flatY, shelf * 0.86);
      vec2 w = worley2(P * 0.30 + 5.0);
      float pool = smoothstep(0.52, 0.10, w.x);
      y -= shelf * pool * (0.55 + 0.42 * fbm2(P * 0.5 + 3.0, 2));
    }
  }

  if (lod >= 1){
    // swash-cut micro-terraces: shore-parallel steps in the last few metres of run-up
    float band = exp(-pow((zp - TZW0) * 0.19, 2.0));
    float warp = fbm2(P * vec2(0.055, 0.20) + 31.0, 3);
    float u = (zp - TZW0) * 1.15 + warp * 2.6;
    float saw = 0.5 - abs(fract(u) - 0.5);
    y += band * (saw - 0.25) * 0.115;
    // strandline debris berm, just above the swash limit
    float sl = exp(-pow((zp - TZW0 - 3.1) * 0.55, 2.0));
    y += sl * 0.055 * (0.5 + fbm2(P * vec2(0.35, 1.1) + 7.0, 2));
    // broad cobble mounds
    float cm = smoothstep(0.10, 0.62, fbm2(P * 0.20 + 61.0, 3)) * sh.w;
    y += cm * 0.13;
  }

  /* Relief finer than 2x the level's own lattice cannot be resolved by it; asking for
   * it does not add detail, it adds aliasing that measures as high lap_var against a
   * shallow spectral_slope. Level spacings are 3 / 6 / 12 cm for lod 3 / 3 / 2, so the
   * 22 cm pavement is the only cobble scale lod 2 can carry and the 9 cm shingle and
   * 16 cm ripples belong to lod 3. */
  float cob = 0.0;
  if (lod >= 2){
    cob = tCobbleMask(P, sh.w, y);
    // 22 cm cobble pavement — the scale that survives a 12 cm lattice.
    //
    // The profile is an ellipsoid cap over a per-stone radius, NOT (1 - k*F1) run
    // through a smoothstep. That old form only left the floor where F1 < 0.24, which
    // is 13% of the area, and the cubic crushed it further: mean relief came out at
    // 3 mm against a nominal 11 cm, so the pavement was mathematically present and
    // visually absent. Every stone here now stands 4-12 cm proud, which is what the
    // reference's edge_density and lum_std on 'sand' are actually made of.
    vec3 w1 = tCell(P * 4.6 + 13.0);
    float c1 = tStoneCap(w1.x, 0.34 + 0.16 * w1.z);
    y += c1 * (0.045 + 0.078 * w1.z) * cob * uTDetail;
  }

  if (lod >= 3){
    // 9 cm shingle packed between the pavement stones
    vec3 w2 = tCell(P * 11.3 + 41.0);
    float c2 = tStoneCap(w2.x, 0.36 + 0.14 * w2.z);
    y += c2 * 0.020 * cob * uTDetail;

    // wind ripples: crests perpendicular to the wind, only on damp/dry sand, and
    // patchy — an unbroken corduroy across the whole beach is a desert, not a shore
    float dry = smoothstep(0.10, 0.85, y) * (1.0 - smoothstep(4.6, 7.0, y));
    // NB: 'patch' is a reserved word in GLSL ES 3.00 — naming this variable that made
    // all three terrain materials fail to compile, so the beach did not render at all.
    float ripPatch = smoothstep(-0.22, 0.28, fbm2(P * 0.20 + 133.0, 3));
    float rw = fbm2(P * 0.34 + 5.0, 3);
    float ph = dot(P, uTWind) * 39.0 + rw * 5.2;
    float rip = sin(ph) * 0.62 + sin(ph * 0.41 + rw * 2.0) * 0.38;
    y += rip * 0.013 * dry * ripPatch * (1.0 - cob * 0.8) * uTDetail;
    // the old 2.2 cm value-noise term that used to sit here was below the Nyquist of
    // every level it ran on (3 and 6 cm); it produced no relief, only vertex fizz.
  }
  return y;
}
`;

/* ------------------------------------------------- clipmap vertex displacement */

const CLIPMAP_VERT = /* glsl */`
attribute vec4 iParams;      // originX, originZ, spacing, lod
uniform float uTHalfM;
varying vec3 vTWorldNormal;
varying float vTLevelSpacing;

vec3 tClipWorld(vec3 latt, out float spacing){
  spacing = iParams.z;
  // CDLOD morph, driven by Chebyshev distance in this level's own lattice so it is
  // exactly 1.0 along the whole outer boundary — corners included.
  float cheb = max(abs(latt.x), abs(latt.z)) / uTHalfM;
  float k = clamp((cheb - 0.70) / 0.28, 0.0, 1.0);
  vec2 l = latt.xz - fract(latt.xz * 0.5) * 2.0 * k;
  return vec3(iParams.x + l.x * spacing, 0.0, iParams.y + l.y * spacing);
}
`;

/** Body shared by the three materials: sets `tWorld` (displaced) and `tNrm`. */
const CLIPMAP_BODY = /* glsl */`
  float tSpacing;
  vec3 tWorld = tClipWorld(position, tSpacing);
  int tLod = int(iParams.w + 0.5);
  float tE = tSpacing;
  float h0 = tHeight(tWorld.xz, tLod);
  float hx = tHeight(tWorld.xz + vec2(tE, 0.0), tLod);
  float hz = tHeight(tWorld.xz + vec2(0.0, tE), tLod);
  tWorld.y = h0;
  vec3 tNrm = normalize(vec3(h0 - hx, tE, h0 - hz));
  vTWorldNormal = tNrm;
  vTLevelSpacing = tSpacing;
`;

/* ==================================================== procedural texture bakes */

const TEX_COMMON = NOISE_CORE + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oCol;
vec3 encN(vec3 n){ n = normalize(n); return vec3(n.xy * 0.5 + 0.5, 0.0); }
/** tileable fbm: sample the field on a torus so the texture wraps exactly */
float tfbm(vec2 uv, float freq, int oct){
  float a = 0.5, s = 0.0, nn = 0.0, f = freq;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    vec2 q = uv * f;
    // periodic value noise via a wrapped lattice
    vec2 ip = floor(q), fp = fract(q);
    vec2 u = fp*fp*fp*(fp*(fp*6.0-15.0)+10.0);
    float p = f;
    float a00 = hash12(mod(ip + vec2(0,0), vec2(p)) + 0.5);
    float a10 = hash12(mod(ip + vec2(1,0), vec2(p)) + 0.5);
    float a01 = hash12(mod(ip + vec2(0,1), vec2(p)) + 0.5);
    float a11 = hash12(mod(ip + vec2(1,1), vec2(p)) + 0.5);
    s += a * (mix(mix(a00,a10,u.x), mix(a01,a11,u.x), u.y) * 2.0 - 1.0);
    nn += a; a *= 0.5; f *= 2.0;
  }
  return s / max(nn, 1e-4);
}
/** tileable worley; returns F1 in cell units */
float tworley(vec2 uv, float freq, float seed){
  vec2 q = uv * freq;
  vec2 n = floor(q), f = fract(q);
  float f1 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 g = vec2(float(i), float(j));
    vec2 c = mod(n + g, vec2(freq));
    vec2 o = hash22(c + seed);
    f1 = min(f1, length(g + o - f));
  }
  return f1;
}
`;

/** micro sand: grain, wind striation, shell fleck.  rg = normal.xy, b = height, a = albedo */
const TEX_SAND_MICRO = TEX_COMMON + /* glsl */`
float fieldH(vec2 uv){
  float g = tfbm(uv, 48.0, 4) * 0.5;
  float grain = 1.0 - tworley(uv, 110.0, 3.0);
  g += grain * grain * 0.55;
  g += (1.0 - tworley(uv, 46.0, 9.0)) * 0.30;
  // faint wind striation
  g += tfbm(vec2(uv.x * 1.0, uv.y * 9.0), 16.0, 3) * 0.16;
  return g;
}
void main(){
  vec2 uv = vUv;
  float e = 1.0 / 1024.0;
  float h  = fieldH(uv);
  float hx = fieldH(uv + vec2(e, 0.0));
  float hy = fieldH(uv + vec2(0.0, e));
  vec3 n = normalize(vec3((h - hx) * 12.0, (h - hy) * 12.0, 1.0));
  // albedo: pale quartz speckle plus dark heavy-mineral flecks and bright shell chips
  float sp = tfbm(uv, 90.0, 3) * 0.5 + 0.5;
  float dark = smoothstep(0.72, 0.94, 1.0 - tworley(uv, 78.0, 21.0));
  float shell = smoothstep(0.90, 0.99, 1.0 - tworley(uv, 34.0, 55.0));
  float alb = 0.5 + (sp - 0.5) * 0.40 - dark * 0.34 + shell * 0.45;
  oCol = vec4(n.xy * 0.5 + 0.5, clamp(h * 0.55, 0.0, 1.0), clamp(alb, 0.0, 1.0));
}
`;

/** meso sand, ~3.6 m tile: hollows, wind scour, organic streaks, faint footfalls */
const TEX_SAND_MESO = TEX_COMMON + /* glsl */`
float fieldH(vec2 uv){
  float h = tfbm(uv, 6.0, 4) * 0.6;
  h += tfbm(uv, 18.0, 3) * 0.28;
  h -= smoothstep(0.55, 0.95, 1.0 - tworley(uv, 9.0, 17.0)) * 0.35;   // shallow hollows
  return h;
}
void main(){
  vec2 uv = vUv;
  float e = 1.0 / 1024.0;
  float h  = fieldH(uv);
  float hx = fieldH(uv + vec2(e, 0.0));
  float hy = fieldH(uv + vec2(0.0, e));
  vec3 n = normalize(vec3((h - hx) * 3.2, (h - hy) * 3.2, 1.0));
  float mott = tfbm(uv, 4.0, 4) * 0.5 + 0.5;
  float streak = smoothstep(0.30, 0.85, tfbm(vec2(uv.x * 3.0, uv.y * 0.5), 7.0, 3) * 0.5 + 0.5);
  float alb = clamp(0.5 + (mott - 0.5) * 0.85 - streak * 0.22, 0.0, 1.0);
  oCol = vec4(n.xy * 0.5 + 0.5, clamp(h * 0.5 + 0.5, 0.0, 1.0), alb);
}
`;

/** pebble pavement, ~1.4 m tile. b = pebble height, a = per-stone albedo */
const TEX_GRAVEL = TEX_COMMON + /* glsl */`
float peb(vec2 uv, float freq, float seed, out float id){
  vec2 q = uv * freq;
  vec2 n = floor(q), f = fract(q);
  float f1 = 8.0; vec2 best = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 g = vec2(float(i), float(j));
    vec2 c = mod(n + g, vec2(freq));
    vec2 o = hash22(c + seed);
    vec2 dv = g + o - f;
    // squash each cell a little so stones are not all round
    float d = length(dv * vec2(1.0, 0.78 + 0.44 * hash12(c + seed + 7.0)));
    if (d < f1){ f1 = d; best = c; }
  }
  id = hash12(best + seed + 31.0);
  return f1;
}
void main(){
  vec2 uv = vUv;
  float id1, id2;
  float d1 = peb(uv, 14.0, 3.0, id1);
  float d2 = peb(uv, 34.0, 11.0, id2);
  float r1 = 0.40 + 0.20 * id1, r2 = 0.36 + 0.18 * id2;
  float h1 = sqrt(max(1.0 - pow(clamp(d1 / r1, 0.0, 1.0), 2.0), 0.0)) * (0.55 + 0.45 * id1);
  float h2 = sqrt(max(1.0 - pow(clamp(d2 / r2, 0.0, 1.0), 2.0), 0.0)) * 0.42;
  float cover = smoothstep(0.28, 0.62, tfbm(uv, 5.0, 3) * 0.5 + 0.5);
  float h = max(h1 * cover, h2 * 0.75) + tfbm(uv, 60.0, 2) * 0.05;
  float e = 1.0 / 1024.0;
  // finite differences on the same field
  float ida, idb;
  float hx1 = sqrt(max(1.0 - pow(clamp(peb(uv + vec2(e,0.0), 14.0, 3.0, ida) / r1, 0.0, 1.0), 2.0), 0.0)) * (0.55 + 0.45 * ida);
  float hy1 = sqrt(max(1.0 - pow(clamp(peb(uv + vec2(0.0,e), 14.0, 3.0, idb) / r1, 0.0, 1.0), 2.0), 0.0)) * (0.55 + 0.45 * idb);
  vec3 n = normalize(vec3((h - max(hx1 * cover, h2 * 0.75)) * 9.0, (h - max(hy1 * cover, h2 * 0.75)) * 9.0, 1.0));
  float dominant = (h1 * cover >= h2 * 0.75) ? id1 : id2;
  // stones run from near-black basalt to pale quartz; the pale ones are the sparkle
  float alb = pow(dominant, 1.6) * 0.9 + 0.06;
  oCol = vec4(n.xy * 0.5 + 0.5, clamp(h, 0.0, 1.0), clamp(alb, 0.0, 1.0));
}
`;

/** macro, ~46 m tile: r tone, g wet retention, b cobble density, a organic strandline */
const TEX_MACRO = TEX_COMMON + /* glsl */`
void main(){
  vec2 uv = vUv;
  float tone = tfbm(uv, 3.0, 4) * 0.5 + 0.5;
  float wetr = smoothstep(0.30, 0.80, tfbm(uv + 11.0, 5.0, 3) * 0.5 + 0.5);
  float cob  = smoothstep(0.22, 0.78, tfbm(uv + 27.0, 4.0, 4) * 0.5 + 0.5);
  float org  = smoothstep(0.55, 0.92, tfbm(uv + 53.0, 8.0, 3) * 0.5 + 0.5);
  oCol = vec4(tone, wetr, cob, org);
}
`;

/** wet rock shelf / tide-pool rock, ~3 m tile */
const TEX_ROCK = TEX_COMMON + /* glsl */`
float fieldH(vec2 uv){
  float h = tfbm(uv, 7.0, 5) * 0.7;
  h += (1.0 - tworley(uv, 13.0, 5.0)) * 0.35;
  h -= smoothstep(0.55, 0.95, 1.0 - tworley(uv, 5.0, 29.0)) * 0.25;
  return h;
}
void main(){
  vec2 uv = vUv;
  float e = 1.0 / 1024.0;
  float h = fieldH(uv), hx = fieldH(uv + vec2(e,0.0)), hy = fieldH(uv + vec2(0.0,e));
  vec3 n = normalize(vec3((h - hx) * 7.5, (h - hy) * 7.5, 1.0));
  float algae = smoothstep(0.35, 0.80, tfbm(uv + 71.0, 9.0, 4) * 0.5 + 0.5);
  oCol = vec4(n.xy * 0.5 + 0.5, clamp(h * 0.5 + 0.5, 0.0, 1.0), algae);
}
`;

/* ==================================================== the surface fragment shader */

const SURFACE_PARS = NOISE_CORE + TILEBREAK_GLSL + /* glsl */`
uniform sampler2D tTSandMicro;
uniform sampler2D tTSandMeso;
uniform sampler2D tTGravel;
uniform sampler2D tTMacro;
uniform sampler2D tTRock;
uniform vec3  uTZenith;
uniform vec3  uTHorizon;
uniform vec3  uTSunRad;
uniform vec3  uTSunDir;
uniform vec3  uTDryCol;
uniform vec3  uTWetCol;
uniform vec3  uTRockCol;
uniform float uTWetLevel;
uniform float uTSpecBoost;
uniform float uTDbg;
varying vec3 vTWorldNormal;
varying float vTLevelSpacing;

vec3 gTEnvSpec;

vec3 tDecodeN(vec4 t, float s){
  vec2 xy = (t.xy * 2.0 - 1.0) * s;
  return normalize(vec3(xy, 1.0));
}
vec3 tBlendN(vec3 a, vec3 b){          // whiteout blend
  return normalize(vec3(a.xy + b.xy, a.z * b.z));
}
/** Analytic sky radiance for reflections; keyed off the sky module's own horizon and
 *  zenith radiance so wet sand never disagrees with the sky it is mirroring. */
vec3 tSkyRefl(vec3 d, float rough){
  vec3 c = mix(uTHorizon, uTZenith, pow(clamp(d.y, 0.0, 1.0), 0.55));
  c = mix(c, uTHorizon * 0.86, smoothstep(0.02, -0.25, d.y));
  float s = max(dot(d, uTSunDir), 0.0);
  float sharp = mix(1600.0, 26.0, clamp(rough * 3.2, 0.0, 1.0));
  c += uTSunRad * (pow(s, sharp) * (1.0 - rough * 0.6) + pow(s, 5.0) * 0.05);
  return c;
}
/** Karis' analytic split-sum env BRDF. Without it the Schlick term alone runs to 1.0
 *  at grazing incidence on a roughness-0.94 surface, which turns the entire beach —
 *  seen at a grazing angle by definition — into a mirror. That is exactly how a
 *  sunlit beach measures sat_mean 7 against a reference 87. */
float tEnvBRDF(float F0, float rough, float NoV){
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return F0 * (-1.04 * a004 + r.z) + (1.04 * a004 + r.w);
}
`;

const SURFACE_FRAG = /* glsl */`
  vec3 wp = vWorldPositionWM;
  vec2 P  = wp.xz;
  vec3 V  = normalize(uCameraPos - wp);
  float dist = length(uCameraPos - wp);
  vec3 nw = normalize(vTWorldNormal);

  vec4 sh  = tShoreAt(P.x);
  vec4 mac = texture(tTMacro, P * (1.0 / 46.0));
  float slope = clamp(1.0 - nw.y, 0.0, 1.0);

  /* ---------------- wetness --------------------------------------------------
   * Distance to the waterline in the vertical, not the horizontal: that is what
   * actually decides whether the swash has been over a patch of sand this minute. */
  float swashTop = uTWetLevel * (0.62 + 0.72 * mac.g)
                 + fbm2(P * vec2(0.09, 0.30) + 3.0, 3) * 0.22;
  float wet = 1.0 - smoothstep(-0.06, max(swashTop, 0.05), wp.y);
  // water sits in hollows long after the sheet has gone
  float hollow = smoothstep(0.35, 0.90, 1.0 - texture(tTSandMeso, P * (1.0/3.6)).b);
  wet = clamp(max(wet, hollow * (1.0 - smoothstep(0.15, 1.35, wp.y)) * 0.85), 0.0, 1.0);
  wet *= 1.0 - smoothstep(0.30, 0.75, slope);
  // the thin retreating sheet: a narrow, very smooth, very reflective band
  float sheet = exp(-pow((wp.y - swashTop * 0.30) * 7.0, 2.0)) * smoothstep(0.35, 0.85, wet);
  sheet *= 0.45 + 0.55 * smoothstep(0.25, 0.75, fbm2(P * vec2(0.20, 0.9) + 61.0, 3) * 0.5 + 0.5);

  /* ---------------- layer weights -------------------------------------------- */
  float cobD = clamp(tCobbleMask(P, sh.w, wp.y) * (0.55 + 1.0 * mac.b), 0.0, 1.25);
  float shelf = smoothstep(-78.0, -66.0, P.x) * (1.0 - smoothstep(-24.0, -12.0, P.x))
              * smoothstep(-17.5, -13.0, P.y) * (1.0 - smoothstep(-4.0, 0.5, P.y));
  float rockW = clamp(shelf * 0.9 + smoothstep(0.42, 0.72, slope), 0.0, 1.0);

  /* ---------------- multi-scale surface --------------------------------------
   * mipFade starts at 5 m, not 14: the 3 mm grain normal is what makes the whole
   * beach read as one uniform sheet of sandpaper, and a uniformly speckled plane
   * measures a high lap_var against a *shallow* spectral_slope — broadband high
   * frequency with nothing underneath it. Structure has to come from the metre
   * scales below, not from grain. */
  float mipFade = clamp(1.0 - (dist - 7.0) / 29.0, 0.0, 1.0);

  vec4 micro = textureNoTile(tTSandMicro, P * (1.0 / 0.32), 0.55);
  vec4 meso  = texture(tTSandMeso, P * (1.0 / 3.6));
  vec4 meso2 = texture(tTSandMeso, P * (1.0 / 13.0) + 0.37);
  vec4 grav  = textureNoTile(tTGravel, P * (1.0 / 1.35), 0.5);

  vec3 nMicro = tDecodeN(micro, 0.88 * (0.24 + 0.76 * mipFade));
  vec3 nMeso  = tDecodeN(meso, 0.85);
  vec3 nMeso2 = tDecodeN(meso2, 0.55);
  vec3 nDet = tBlendN(tBlendN(nMeso, nMeso2), nMicro);

  // gravel normal, faded in with cobble density and faded UP with distance so the
  // statistics do not fall off where the displaced geometry stops resolving stones
  float gravN = clamp(cobD * (0.55 + 0.75 * smoothstep(3.0, 14.0, dist)), 0.0, 1.25);
  nDet = tBlendN(nDet, tDecodeN(grav, 1.45 * gravN));

  // wind ripples as a normal, taking over from the geometry beyond ~6 m
  {
    float dryM = smoothstep(0.10, 0.85, wp.y) * (1.0 - smoothstep(4.2, 6.5, wp.y));
    float take = smoothstep(1.5, 5.0, dist) * (1.0 - smoothstep(45.0, 95.0, dist)) * dryM * (1.0 - wet);
    float rw = fbm2(P * 0.34 + 5.0, 3);
    float ph = dot(P, uTWind) * 39.0 + rw * 5.2;
    float d1 = cos(ph) * 39.0 * 0.62 + cos(ph * 0.41 + rw * 2.0) * 16.0 * 0.38;
    vec2 g = uTWind * d1 * 0.030 * take;
    nDet = tBlendN(nDet, normalize(vec3(-g, 1.0)));
  }

  // rock shelf
  vec4 rockT = texture(tTRock, P * (1.0 / 3.0));
  vec3 nRock = tDecodeN(rockT, 1.3);
  nDet = mix(nDet, nRock, rockW);

  /* ---------------- world normal --------------------------------------------- */
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - nw * nw.x);
  vec3 B = cross(T, nw);
  vec3 nOut = normalize(T * nDet.x + B * nDet.y + nw * nDet.z);

  /* ---------------- albedo ----------------------------------------------------
   * Values are linear reflectance, not "a colour that looks like sand". Dry quartz
   * beach sand is ~0.22, a warm mid-tone; damp sand ~0.13 and cooler because the
   * water film kills the diffuse back-scatter; saturated sand ~0.07 and specular.
   * Authoring these at 0.5-0.7, as a paint program encourages, is what makes a beach
   * render as a white sheet with the chroma washed out of it.
   *
   * The modulations are deliberately weighted toward the LOW frequencies. 'tone'
   * (8-46 m drifts) swings +-60%; grain (3 mm) only +-16%. The reference's 'sand'
   * region sits at spectral_slope -2.37 with lum_std 31.5 — most of its energy is at
   * the metre scale and above. Loading the variance into grain instead gives the
   * opposite: lap_var high, slope shallow, lum_std and local_contrast both low. */
  float grainA = micro.a;
  float mesoA  = meso.a * 0.6 + meso2.a * 0.4;
  float tone   = (0.40 + 1.22 * mac.r) * (0.80 + 0.42 * meso2.a);
  // 4-16 m drifts. The 46 m macro tile barely changes across the visible beach at
  // eye height, so on its own it contributes almost nothing to lum_std; this is the
  // band that does. Low frequency by construction, so it costs no aliasing.
  tone *= 0.64 + 0.72 * (fbm2(P * 0.085 + 401.0, 4) * 0.5 + 0.5);

  vec3 dry  = uTDryCol * tone
            * (0.84 + 0.32 * grainA)
            * (0.78 + 0.56 * mesoA);
  // damp sand is darker AND cooler: the water film removes the warm multiple
  // scattering between grains that gives dry sand its yellow cast
  vec3 damp = dry * vec3(0.50, 0.52, 0.585);
  vec3 wetC = uTWetCol * tone * (0.88 + 0.24 * grainA);

  /* The wet/dry line is the strongest value contrast on the beach — a 3x step over a
   * few centimetres of run-up, not a slow gradient. Narrow ramps. */
  vec3 alb = mix(dry, damp, smoothstep(0.03, 0.28, wet));
  alb = mix(alb, wetC, smoothstep(0.44, 0.76, wet));

  /* Damp patches on the dry berm: 3-9 m pools of retained moisture, well above the
   * swash limit, where the sand last held water. On a real beach these carry more
   * mid-scale value contrast than anything except the stones, and without them the
   * berm is a flat plane no matter what the grain is doing. */
  {
    float dp = smoothstep(0.34, 0.88, mac.g * 0.50 + (fbm2(P * 0.30 + 209.0, 3) * 0.5 + 0.5) * 0.72)
             * (1.0 - smoothstep(1.5, 4.6, wp.y)) * (1.0 - wet);
    // a second, broader stain at 10-30 m: last week's high tide, not last hour's swash
    float dp2 = smoothstep(0.40, 0.90, mac.g * 0.62 + (fbm2(P * 0.075 + 71.0, 3) * 0.5 + 0.5) * 0.60)
              * (1.0 - smoothstep(2.6, 6.0, wp.y));
    alb = mix(alb, alb * vec3(0.60, 0.60, 0.635), dp * 0.80);
    alb = mix(alb, alb * vec3(0.74, 0.735, 0.755), dp2 * 0.85);
  }

  /* Stone tone at range, from the mip-filtered gravel bake. The analytic cell field
   * below is exact but has no derivatives to filter with, so it aliases into fizz
   * past a few metres; this carries the same statistics out to the horizon with
   * proper mip and anisotropy behind it. */
  float gravFar = clamp(cobD, 0.0, 1.0) * smoothstep(8.0, 22.0, dist);
  alb = mix(alb, mix(vec3(0.0200, 0.0168, 0.0134), vec3(0.186, 0.146, 0.102), grav.a) * tone,
            gravFar * smoothstep(0.14, 0.58, grav.b) * 0.90);

  /* Cobble pavement. Two layers of the SAME cell field the vertex shader displaced,
   * so every stone that stands proud of the sand is also shaded as a stone. Stones
   * are DARKER than the sand they sit in — basalt and wet-stained limestone against a
   * 0.22 quartz pavement — and that value step is where the reference's lum_std comes
   * from. Coverage is broad enough to read as a pavement rather than as speckle. */
  float cobShade = 0.0;
  float stoneTop = 0.0;
  if (cobD > 0.004) {
    float nearC = clamp(1.0 - (dist - 14.0) / 17.0, 0.0, 1.0);
    vec3 cA = tCell(P * 4.6 + 13.0);
    float mA = tStoneCap(cA.x, 0.34 + 0.16 * cA.z);
    float sA = smoothstep(0.06, 0.42, mA) * clamp(cobD * 1.25, 0.0, 1.0) * nearC;
    vec3 colA = mix(vec3(0.0102, 0.0086, 0.0070), vec3(0.228, 0.176, 0.120), pow(cA.z, 1.30));
    colA = mix(colA, colA * vec3(0.58, 0.70, 0.58), smoothstep(0.45, 0.92, wet) * 0.75);
    alb = mix(alb, colA * tone, sA * 0.97);

    vec3 cB = tCell(P * 11.3 + 41.0);
    float mB = tStoneCap(cB.x, 0.36 + 0.14 * cB.z);
    float sB = smoothstep(0.10, 0.46, mB) * clamp(cobD * 1.15, 0.0, 1.0) * (1.0 - sA * 0.7)
             * clamp(1.0 - (dist - 6.0) / 10.0, 0.0, 1.0);
    vec3 colB = mix(vec3(0.0165, 0.0140, 0.0112), vec3(0.226, 0.176, 0.122), pow(cB.z, 1.20));
    alb = mix(alb, colB * tone, sB * 0.92);

    // the sand between the stones is shaded, damper and darker
    cobShade = clamp(cobD, 0.0, 1.0) * (smoothstep(0.26, 0.01, mA) * 0.62 + smoothstep(0.30, 0.03, mB) * 0.28);
    stoneTop = max(sA, sB);
    // detail normal from the same cells, so the lighting agrees with the silhouette
    float e = 0.012;
    vec2 gA = vec2(tCell((P + vec2(e, 0.0)) * 4.6 + 13.0).x - cA.x,
                   tCell((P + vec2(0.0, e)) * 4.6 + 13.0).x - cA.x) / e;
    nDet = tBlendN(nDet, normalize(vec3(gA * 0.085 * clamp(cobD, 0.0, 1.0) * nearC, 1.0)));
  }
  alb *= 1.0 - cobShade * 0.34;

  // organic strandline: dark weed and shell wrack in a band above the swash
  {
    float band = exp(-pow((wp.y - swashTop - 0.22) * 3.4, 2.0));
    float w = band * smoothstep(0.34, 0.86, mac.a) * smoothstep(0.34, 0.76, micro.a);
    alb = mix(alb, vec3(0.038, 0.036, 0.024), w * 0.72);
  }

  // rock shelf albedo + algae stain
  {
    vec3 rc = uTRockCol * (0.55 + 0.75 * rockT.b);
    rc = mix(rc, vec3(0.026, 0.040, 0.022), rockT.a * smoothstep(0.9, 0.15, wp.y) * 0.85);
    alb = mix(alb, rc, rockW);
  }

  /* ---------------- roughness -------------------------------------------------
   * Dry sand is as rough as a surface gets; saturated sand is a wet film at ~0.12
   * and starts mirroring the sky, which is the other half of why the wet/dry line
   * reads so hard in the reference. Must stay in step with buildGBufferMaterial(). */
  float rough = mix(0.94, 0.12, smoothstep(0.30, 0.95, wet));
  rough = mix(rough, 0.055, sheet);
  rough = mix(rough, mix(0.72, 0.34, rockT.a), rockW);
  rough = mix(rough, 0.62, smoothstep(0.20, 0.60, grav.b) * clamp(cobD, 0.0, 1.0) * (1.0 - wet * 0.6));
  // wave-polished stone tops are smoother than the sand around them
  rough = mix(rough, 0.46, stoneTop * 0.55);
  rough = clamp(rough - (grainA - 0.5) * 0.05, 0.04, 1.0);

  /* ---------------- occlusion -------------------------------------------------- */
  float ao = 1.0
    - (1.0 - micro.b) * 0.16 * mipFade
    - (1.0 - meso.b) * 0.26
    - smoothstep(0.32, 0.0, grav.b) * clamp(cobD, 0.0, 1.0) * 0.34;
  ao = clamp(ao, 0.22, 1.0);

  diffuseColor.rgb = alb * ao;
  if (uTDbg > 0.5) {
    // 1 = flat uTDryCol, no texture, no AO; 2 = flat 0.18 grey. Diagnostic only:
    // tells you what the light + tonemap + grade chain does to a known albedo.
    diffuseColor.rgb = uTDbg > 2.5 ? vec3(0.0) : (uTDbg > 1.5 ? vec3(0.18) : uTDryCol);
    // 4..7 visualise the masks that decide where anything happens
    if (uTDbg > 3.5 && uTDbg < 4.5) diffuseColor.rgb = vec3(clamp(cobD, 0.0, 1.0)) * 0.5;
    if (uTDbg > 4.5 && uTDbg < 5.5) diffuseColor.rgb = vec3(wet) * 0.5;
    if (uTDbg > 5.5 && uTDbg < 6.5) diffuseColor.rgb = vec3(tone) * 0.25;
    if (uTDbg > 6.5 && uTDbg < 7.5) diffuseColor.rgb = vec3(clamp(sh.w, 0.0, 2.0)) * 0.25;
    if (uTDbg > 7.5 && uTDbg < 8.5) diffuseColor.rgb = vec3(smoothstep(0.40, 0.12, tCell(P * 4.6 + 13.0).x)) * 0.4;
    // 9 = 1 m checkerboard + red every 10 m: a scale bar on the ground
    if (uTDbg > 8.5) {
      float ck = mod(floor(P.x) + floor(P.y), 2.0);
      diffuseColor.rgb = mix(vec3(0.05), vec3(0.5), ck);
      if (mod(floor(P.x * 0.1) + floor(P.y * 0.1), 2.0) > 0.5) diffuseColor.rgb *= vec3(1.0, 0.35, 0.35);
    }
  }
  roughnessFactor = rough;
  metalnessFactor = 0.0;
  normal = normalize((viewMatrix * vec4(nOut, 0.0)).xyz);

  /* ---------------- image-based specular --------------------------------------
   * env is not landed, so there is no PMREM probe to sample. Rather than let the
   * wettest surface in the frame carry no reflection at all, the sky is evaluated
   * analytically from the sky module's own horizon/zenith radiance. */
  {
    float NoV = max(dot(nOut, V), 1e-3);
    float F0 = mix(0.028, 0.021, smoothstep(0.3, 0.9, wet));
    vec3 R = reflect(-V, nOut);
    vec3 Rr = normalize(mix(R, nOut, rough * rough * 0.9));
    vec3 sky = tSkyRefl(Rr, rough);
    gTEnvSpec = sky * tEnvBRDF(F0, rough, NoV) * ao * uTSpecBoost;
  }
`;

/* ================================================================== the module */

export function create(opts = {}) {
  /* ---- state --------------------------------------------------------------- */
  let ctxRef = null;
  let profileFn = null;
  let profArr = null, shoreArr = null;
  let profTex = null, shoreTex = null;
  let fineTbl = null, crsTbl = null;
  let fineW = 0, fineH = 0, crsW = 0, crsH = 0;

  let group = null;
  let surfMat = null, depthMat = null, gbufMat = null;
  let ringGeo = null, ringGeoG = null, ctrGeo = null, ctrGeoG = null;
  const clipMeshes = [];        // { mesh, geo, kind }
  let pebbleChunks = [];
  const textures = {};

  const fieldUniforms = {
    tTProfile: { value: null },
    tTShore: { value: null },
    uTProfRange: { value: new THREE.Vector4(PROF_Z0, PROF_Z1, PROF_N, 1 / (PROF_Z1 - PROF_Z0)) },
    uTShoreRange: { value: new THREE.Vector4(SHORE_X0, SHORE_X1, SHORE_N, 1 / (SHORE_X1 - SHORE_X0)) },
    uTWind: { value: new THREE.Vector2(0.83, 0.56) },
    uTDetail: { value: 1.0 },
    uTHalfM: { value: CM_M * 0.5 },
  };
  const surfUniforms = {
    tTSandMicro: { value: null },
    tTSandMeso: { value: null },
    tTGravel: { value: null },
    tTMacro: { value: null },
    tTRock: { value: null },
    uTZenith: { value: new THREE.Vector3(0.05, 0.10, 0.22) },
    uTHorizon: { value: new THREE.Vector3(0.30, 0.34, 0.40) },
    uTSunRad: { value: new THREE.Vector3(6, 5.6, 5) },
    uTSunDir: { value: new THREE.Vector3(0.6, 0.66, -0.45) },
    // Linear reflectance, measured values, not picked colours:
    //   dry beach sand         0.20-0.25, warm      -> 0.322 / 0.196 / 0.116  (Y 0.217)
    //   saturated sand         ~0.07, cooler        -> 0.072 / 0.060 / 0.048
    //   weathered limestone    0.30-0.40 dry, less wet
    // `damp` is derived from dry in the shader (x0.50/0.52/0.585 -> ~0.125, cooler).
    uTDryCol: { value: new THREE.Vector3(0.322, 0.196, 0.116) },
    uTWetCol: { value: new THREE.Vector3(0.072, 0.060, 0.048) },
    // the tide-pool shelf is permanently damp and algae-stained, so it sits well
    // below dry limestone's 0.30-0.40
    uTRockCol: { value: new THREE.Vector3(0.150, 0.140, 0.122) },
    uTWetLevel: { value: 0.42 },
    uTSpecBoost: { value: 1.0 },
    uTDbg: { value: 0.0 },
  };

  /* ================================================ CPU field (mirrors FIELD_GLSL) */

  const _sh = [0, 0, 0, 0];
  function shoreAtJS(x, out) {
    const u = Math.min(Math.max((x - SHORE_X0) / (SHORE_X1 - SHORE_X0), 0), 1) * (SHORE_N - 1);
    const i0 = Math.floor(u), f = u - i0, i1 = Math.min(i0 + 1, SHORE_N - 1);
    for (let c = 0; c < 4; c++) out[c] = shoreArr[i0 * 4 + c] + (shoreArr[i1 * 4 + c] - shoreArr[i0 * 4 + c]) * f;
    return out;
  }
  function profileYJS(z) {
    const u = Math.min(Math.max((z - PROF_Z0) / (PROF_Z1 - PROF_Z0), 0), 1) * (PROF_N - 1);
    const i0 = Math.floor(u), f = u - i0, i1 = Math.min(i0 + 1, PROF_N - 1);
    return profArr[i0 * 4] + (profArr[i1 * 4] - profArr[i0 * 4]) * f;
  }
  const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
  function worley2JS(px, pz) {
    const ix = Math.floor(px), iz = Math.floor(pz);
    let f1 = 8;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      hash22(ix + i, iz + j, _h2);
      const dx = i + _h2[0] - (px - ix), dz = j + _h2[1] - (pz - iz);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < f1) f1 = d;
    }
    return f1;
  }

  /** Same layering as FIELD_GLSL, lod 2 (everything the tables can carry). */
  function heightJS(x, z, lod) {
    const sh = shoreAtJS(x, _sh);
    const zp = ZW0 + (z - ZW0 - sh[0]) / Math.max(sh[1], 0.12);
    let y = profileYJS(zp);
    const beach = smoothstep(-140, -34, zp) * (1 - smoothstep(40, 62, zp));
    y += fbm2(x * 0.0125, z * 0.0125, 4) * (0.55 + 1.35 * beach);
    y += fbm2(x * 0.098 + 17, z * 0.098 + 17, 3) * (0.10 + 0.30 * beach) * sh[2];
    {
      const dx = (x - 108) / 46, dz = (z - 20) / 46;
      y += 11.0 * Math.exp(-(dx * dx + dz * dz) * 1.15);
    }
    {
      const sx = smoothstep(-78, -66, x) * (1 - smoothstep(-24, -12, x));
      const sz = smoothstep(-17.5, -13, z) * (1 - smoothstep(-4, 0.5, z));
      const shelf = sx * sz;
      if (shelf > 0.001) {
        const flat = 0.16 + 0.20 * fbm2(x * 0.16 + 91, z * 0.16 + 91, 2);
        y = y + (flat - y) * (shelf * 0.86);
        const w = worley2JS(x * 0.30 + 5, z * 0.30 + 5);
        const pool = smoothstep(0.52, 0.10, w);
        y -= shelf * pool * (0.55 + 0.42 * fbm2(x * 0.5 + 3, z * 0.5 + 3, 2));
      }
    }
    if (lod >= 1) {
      const band = Math.exp(-Math.pow((zp - ZW0) * 0.19, 2));
      const warp = fbm2(x * 0.055 + 31, z * 0.20 + 31, 3);
      const u = (zp - ZW0) * 1.15 + warp * 2.6;
      const saw = 0.5 - Math.abs(fract(u) - 0.5);
      y += band * (saw - 0.25) * 0.115;
      const sl = Math.exp(-Math.pow((zp - ZW0 - 3.1) * 0.55, 2));
      y += sl * 0.055 * (0.5 + fbm2(x * 0.35 + 7, z * 1.1 + 7, 2));
      const cm = smoothstep(0.10, 0.62, fbm2(x * 0.20 + 61, z * 0.20 + 61, 3)) * sh[3];
      y += cm * 0.13;
    }
    return y;
  }

  /* ---- lookup tables -------------------------------------------------------- */
  function buildTables() {
    fineW = Math.round((FINE_X1 - FINE_X0) / FINE_STEP) + 1;
    fineH = Math.round((FINE_Z1 - FINE_Z0) / FINE_STEP) + 1;
    crsW = Math.round((CRS_X1 - CRS_X0) / CRS_STEP) + 1;
    crsH = Math.round((CRS_Z1 - CRS_Z0) / CRS_STEP) + 1;
    fineTbl = new Float32Array(fineW * fineH);
    crsTbl = new Float32Array(crsW * crsH);
    for (let j = 0; j < fineH; j++) {
      const z = FINE_Z0 + j * FINE_STEP;
      for (let i = 0; i < fineW; i++) fineTbl[j * fineW + i] = heightJS(FINE_X0 + i * FINE_STEP, z, 1);
    }
    for (let j = 0; j < crsH; j++) {
      const z = CRS_Z0 + j * CRS_STEP;
      for (let i = 0; i < crsW; i++) crsTbl[j * crsW + i] = heightJS(CRS_X0 + i * CRS_STEP, z, 0);
    }
  }

  function sampleTable(tbl, w, h, x0, z0, step, x, z) {
    const u = (x - x0) / step, v = (z - z0) / step;
    const i0 = Math.min(Math.max(Math.floor(u), 0), w - 2);
    const j0 = Math.min(Math.max(Math.floor(v), 0), h - 2);
    const fu = Math.min(Math.max(u - i0, 0), 1), fv = Math.min(Math.max(v - j0, 0), 1);
    const a = tbl[j0 * w + i0], b = tbl[j0 * w + i0 + 1];
    const c = tbl[(j0 + 1) * w + i0], d = tbl[(j0 + 1) * w + i0 + 1];
    return (a + (b - a) * fu) + ((c + (d - c) * fu) - (a + (b - a) * fu)) * fv;
  }

  /** THE hot query. Two clamped bilinear table taps, no noise, no mesh. */
  function height(x, z) {
    if (x > FINE_X0 + 1 && x < FINE_X1 - 1 && z > FINE_Z0 + 1 && z < FINE_Z1 - 1) {
      return sampleTable(fineTbl, fineW, fineH, FINE_X0, FINE_Z0, FINE_STEP, x, z);
    }
    if (x > CRS_X0 + 2 && x < CRS_X1 - 2 && z > CRS_Z0 + 2 && z < CRS_Z1 - 2) {
      return sampleTable(crsTbl, crsW, crsH, CRS_X0, CRS_Z0, CRS_STEP, x, z);
    }
    // far offshore / far inland: the profile alone, which is what is out there anyway
    const sh = shoreAtJS(x, _sh);
    return profileYJS(ZW0 + (z - ZW0 - sh[0]) / Math.max(sh[1], 0.12));
  }

  const _n = new THREE.Vector3();
  function normal(x, z, out) {
    const e = 0.45;
    const hL = height(x - e, z), hR = height(x + e, z);
    const hD = height(x, z - e), hU = height(x, z + e);
    (out || _n).set(hL - hR, 2 * e, hD - hU).normalize();
    return out || _n;
  }

  function wetnessAt(x, z, y) {
    const w = 1 - smoothstep(-0.06, Math.max(surfUniforms.uTWetLevel.value, 0.05), y);
    return Math.min(Math.max(w, y < -0.02 ? 1 : 0), 1);
  }

  /* =============================================================== texture bake */

  function bakeTexture(ctx, frag, size, srgb = false) {
    const { renderer } = ctx;
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    const mat = fsMaterial(frag, {});
    const quad = new FullScreenQuad(mat);
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    quad.render(renderer);
    const buf = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
    quad.dispose();
    rt.dispose();
    const tex = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    configureTexture(tex, ctx, { srgb, repeat: true });
    return tex;
  }

  /* ============================================================= clipmap meshes */

  /** Grid of `m` x `m` quads in lattice coordinates [-m/2, m/2], optional square hole. */
  function buildLattice(m, holeQuads) {
    const n = m + 1;
    const half = m * 0.5;
    const pos = new Float32Array(n * n * 3);
    const nrm = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 3;
        pos[k] = i - half; pos[k + 1] = 0; pos[k + 2] = j - half;
        nrm[k] = 0; nrm[k + 1] = 1; nrm[k + 2] = 0;
      }
    }
    const idx = [];
    const h0 = (m - holeQuads) / 2, h1 = h0 + holeQuads;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        if (holeQuads > 0 && i >= h0 && i < h1 && j >= h0 && j < h1) continue;
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1)
                                    : new THREE.Uint16BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    return geo;
  }

  /** A second geometry object sharing the same GPU buffers — only drawRange differs. */
  function shareGeo(src) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.getAttribute('position'));
    g.setAttribute('normal', src.getAttribute('normal'));
    g.setIndex(src.getIndex());
    g.boundingSphere = src.boundingSphere;
    return g;
  }

  function makeInstanceAttr(count) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }

  /* ------------------------------------------------------------- the materials */

  /** Splice the displacement into any three vertex shader that has <begin_vertex>.
   *  Materials with normals (standard) get the body at <beginnormal_vertex> so the
   *  displaced normal is in scope for <defaultnormal_vertex>; the depth material has
   *  no normal chunk at all, so there the body goes at <begin_vertex> instead. */
  function patchVertex(shader, withNormal = true) {
    let v = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NOISE_CORE}\n${FIELD_GLSL}\n${CLIPMAP_VERT}`);
    if (withNormal) {
      v = v.replace('#include <beginnormal_vertex>', `${CLIPMAP_BODY}\n  vec3 objectNormal = tNrm;`)
           .replace('#include <begin_vertex>', '  vec3 transformed = tWorld;');
    } else {
      v = v.replace('#include <begin_vertex>', `${CLIPMAP_BODY}\n  vec3 transformed = tWorld;`);
    }
    shader.vertexShader = v;
  }

  /**
   * `applyWorldMaterial()` ends by calling `lighting.registerMaterial()`, which calls
   * `CSM.setupMaterial()` — and three's CSM addon does a bare
   * `material.onBeforeCompile = function (shader) {...}`, throwing away whatever chain
   * was there. Every injection applyWorldMaterial had just installed is destroyed:
   * no aerial perspective, no custom surface, and here no vertex displacement either.
   *
   * So: apply the world material with `lighting` hidden, then register with CSM
   * ourselves and rebuild the chain by hand. CSM's callback only adds three uniforms
   * and stashes the shader object, so running it first is safe.
   *
   * This is a defect in shared code (src/gfx/materialCommon.js + the CSM addon) that
   * every future world material will hit; it is worked around here rather than fixed
   * because this task owns one file. See the report.
   */
  function applyWorldMaterialWithCSM(mat, ctx, o, post) {
    const noLighting = Object.assign({}, ctx, {
      get: (n, req) => (n === 'lighting' ? null : ctx.get(n, req)),
    });
    applyWorldMaterial(mat, noLighting, o);
    const wmChain = mat.onBeforeCompile;
    const lighting = ctx.get('lighting');
    let csmChain = null;
    if (lighting?.registerMaterial) {
      lighting.registerMaterial(mat);
      if (mat.onBeforeCompile !== wmChain) csmChain = mat.onBeforeCompile;
    }
    mat.onBeforeCompile = (shader, renderer) => {
      csmChain?.(shader, renderer);
      wmChain(shader, renderer);
      post?.(shader, renderer);
    };
    return mat;
  }

  /**
   * The surface code has to be spliced in before <lights_physical_fragment>, not
   * before <lights_fragment_begin> where applyWorldMaterial puts `inject.fragment`.
   * By the time <lights_fragment_begin> runs, <lights_physical_fragment> has already
   * copied diffuseColor, roughnessFactor and metalnessFactor into the `PhysicalMaterial`
   * struct that the BRDF actually reads — so writes to those three from an
   * `inject.fragment` block are dead code, and the surface renders as the untouched
   * base material (albedo 1.0, which is how a sunlit beach measures lum_mean 183 and
   * sat_mean 6). Writes to `normal` do work, which is what makes the bug look like a
   * shading problem rather than a plumbing one.
   *
   * Reported rather than fixed in place: src/gfx/materialCommon.js is shared code
   * this task does not own.
   */
  function injectSurface(shader, glsl) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `{\n${glsl}\n}\n#include <lights_physical_fragment>`);
  }

  function buildSurfaceMaterial(ctx) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.9, metalness: 0.0, dithering: true,
    });
    // runs first: applyWorldMaterial chains it as `prev`
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, fieldUniforms, surfUniforms);
      patchVertex(shader);
      // the env specular computed in the inject block is added after three's own IBL
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n  reflectedLight.indirectSpecular += gTEnvSpec;');
    };
    applyWorldMaterialWithCSM(mat, ctx, {
      matId: MAT_ID.TERRAIN_SAND,
      inject: {
        key: 'terrain-surface',
        uniforms: Object.assign({}, fieldUniforms, surfUniforms),
        pars: SURFACE_PARS + FIELD_GLSL,
      },
    }, (shader) => injectSurface(shader, SURFACE_FRAG));
    mat.allowOverride = false;
    return mat;
  }

  function buildDepthMaterial() {
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, fieldUniforms);
      // MeshDepthMaterial only includes <beginnormal_vertex> under USE_DISPLACEMENTMAP,
      // so the body has to go in at <begin_vertex> here.
      patchVertex(shader, false);
    };
    mat.customProgramCacheKey = () => 'terrain-depth';
    return mat;
  }

  /** Replicates GBufferMaterial's outputs with this module's vertex displacement. */
  function buildGBufferMaterial() {
    const u = Object.assign({
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCurrViewProj: { value: new THREE.Matrix4() },
      uTRoughApprox: { value: 0.75 },
      uTMatId: { value: MAT_ID.TERRAIN_SAND },
    }, fieldUniforms);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: u,
      vertexShader: /* glsl */`
        #include <common>
        ${NOISE_CORE}
        ${FIELD_GLSL}
        ${CLIPMAP_VERT}
        uniform mat4 uPrevViewProj;
        uniform mat4 uCurrViewProj;
        out vec3 vViewNormal;
        out vec4 vCurClip;
        out vec4 vPrevClip;
        out vec3 vWP;
        void main(){
          ${CLIPMAP_BODY}
          vViewNormal = normalize(normalMatrix * tNrm);
          vec4 mvPosition = modelViewMatrix * vec4(tWorld, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vec4 world = modelMatrix * vec4(tWorld, 1.0);
          vWP = world.xyz;
          vCurClip = uCurrViewProj * world;
          vPrevClip = uPrevViewProj * world;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTRoughApprox;
        uniform float uTMatId;
        in vec3 vViewNormal;
        in vec4 vCurClip;
        in vec4 vPrevClip;
        in vec3 vWP;
        varying vec3 vTWorldNormal;
        varying float vTLevelSpacing;
        layout(location = 0) out vec4 oNormalRough;
        layout(location = 1) out vec4 oMotionId;
        void main(){
          vec3 n = normalize(vViewNormal);
          if (!gl_FrontFacing) n = -n;
          vec2 cur  = vCurClip.xy  / max(vCurClip.w,  1e-6);
          vec2 prev = vPrevClip.xy / max(vPrevClip.w, 1e-6);
          // roughness and material id must agree with the surface pass or SSR and
          // the TAA clamp will disagree with what was actually shaded
          float wet = 1.0 - smoothstep(-0.06, 0.42, vWP.y);
          float rough = mix(0.94, 0.12, smoothstep(0.30, 0.95, wet));
          float mid = mix(${MAT_ID.TERRAIN_SAND}.0, ${MAT_ID.TERRAIN_WET}.0, step(0.5, wet));
          oNormalRough = vec4(n * 0.5 + 0.5, rough);
          oMotionId    = vec4((cur - prev) * 0.5, mid / 255.0, 1.0);
        }
      `,
    });
    mat.allowOverride = false;
    return mat;
  }

  /* ============================================================ pebble scatter */

  function makePebbleGeometry(rand, kind) {
    const detail = kind === 0 ? 0 : 1;
    const g = new THREE.IcosahedronGeometry(0.5, detail);
    const pos = g.getAttribute('position');
    const v = new THREE.Vector3();
    const seed = rand.next() * 100;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = 0.72
        + 0.30 * gnoise2(v.x * 3.1 + seed, v.z * 3.1 + seed)
        + 0.16 * gnoise2(v.x * 7.4 + seed * 2, v.y * 7.4 + seed * 2);
      v.multiplyScalar(n);
      v.y *= 0.52 + 0.22 * gnoise2(v.x * 2.0 + seed, v.z * 2.0 + seed);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  }

  const CHUNK = 48;
  const BAND_X0 = -336, BAND_X1 = 192, BAND_Z0 = -48, BAND_Z1 = 60;

  function buildPebbles(ctx) {
    const rand = ctx.rand.fork(0x7e44a1);
    const geoSmall = makePebbleGeometry(rand, 0);
    const geoLarge = makePebbleGeometry(rand, 1);

    const mkMat = (rough) => {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: rough, metalness: 0.0 });
      applyWorldMaterialWithCSM(m, ctx, {
        matId: MAT_ID.ROCK,
        inject: { key: `terrain-pebble-${rough}` },
      }, (shader) => injectSurface(shader, `
        // damp stones near the waterline: darker, smoother
        float wetp = 1.0 - smoothstep(-0.05, 0.55, vWorldPositionWM.y);
        diffuseColor.rgb *= mix(1.0, 0.40, wetp);
        roughnessFactor = mix(roughnessFactor, 0.16, wetp * 0.85);
      `));
      return m;
    };
    const matSmall = mkMat(0.78);
    const matLarge = mkMat(0.72);

    const nx = Math.ceil((BAND_X1 - BAND_X0) / CHUNK);
    const nz = Math.ceil((BAND_Z1 - BAND_Z0) / CHUNK);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s3 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    const col = new THREE.Color();
    const shTmp = [0, 0, 0, 0];

    for (let cz = 0; cz < nz; cz++) {
      for (let cx = 0; cx < nx; cx++) {
        const ox = BAND_X0 + cx * CHUNK, oz = BAND_Z0 + cz * CHUNK;
        const cr = ctx.rand.fork(0x91b3 + cx * 977 + cz * 131);
        const small = [], large = [];
        // jittered grid so the field is dense without clumping into a lattice
        const step = 0.62;
        for (let z = oz; z < oz + CHUNK; z += step) {
          for (let x = ox; x < ox + CHUNK; x += step) {
            const px = x + cr.range(-step * 0.5, step * 0.5);
            const pz = z + cr.range(-step * 0.5, step * 0.5);
            const y = height(px, pz);
            if (y < -0.9 || y > 5.6) continue;
            shoreAtJS(px, shTmp);
            const dens = Math.min(Math.max(shTmp[3] * (0.35 + 0.9 * (fbm2(px * 0.021 + 27, pz * 0.021 + 27, 3) * 0.5 + 0.5)), 0), 1.3)
                       * (1 - smoothstep(2.4, 5.0, y));
            if (cr.next() > dens * 0.72) continue;
            const nrm = normal(px, pz, new THREE.Vector3());
            if (nrm.y < 0.72) continue;
            const r = cr.next();
            const big = r > 0.962;
            const sc = big ? cr.range(0.16, 0.46) : cr.range(0.035, 0.18);
            (big ? large : small).push({ x: px, y, z: pz, s: sc, r: cr });
          }
        }
        if (!small.length && !large.length) continue;
        const cxw = ox + CHUNK * 0.5, czw = oz + CHUNK * 0.5;

        const mk = (list, geo, mat, isLarge) => {
          if (!list.length) return null;
          list.sort((a, b) => b.s - a.s);
          const im = new THREE.InstancedMesh(geo, mat, list.length);
          im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
          for (let i = 0; i < list.length; i++) {
            const o = list[i];
            e.set(cr.range(-0.5, 0.5), cr.range(0, Math.PI * 2), cr.range(-0.5, 0.5));
            q.setFromEuler(e);
            s3.set(o.s * cr.range(0.8, 1.3), o.s * cr.range(0.45, 0.85), o.s * cr.range(0.8, 1.3));
            p3.set(o.x, o.y + s3.y * cr.range(0.02, 0.28) - s3.y * 0.22, o.z);
            m4.compose(p3, q, s3);
            im.setMatrixAt(i, m4);
            const v = cr.next();
            const base = 0.020 + Math.pow(v, 1.9) * 0.20;
            col.setRGB(base * cr.range(0.92, 1.10), base * cr.range(0.88, 1.02), base * cr.range(0.78, 0.98));
            im.setColorAt(i, col);
          }
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.layers.set(LAYER.OPAQUE);
          im.castShadow = true;
          im.receiveShadow = true;
          im.frustumCulled = true;
          im.boundingSphere = new THREE.Sphere(new THREE.Vector3(cxw, 1, czw), CHUNK * 0.78);
          im.computeBoundingSphere = () => {};
          patchForGBuffer(im, { matId: MAT_ID.ROCK, roughness: isLarge ? 0.72 : 0.78 });
          group.add(im);
          return { mesh: im, full: list.length, cx: cxw, cz: czw };
        };
        const a = mk(small, geoSmall, matSmall, false);
        const b = mk(large, geoLarge, matLarge, true);
        if (a) pebbleChunks.push(a);
        if (b) pebbleChunks.push(b);
      }
    }
  }

  /* ================================================================ per-frame */

  const _camXZ = new THREE.Vector2();
  function updateClipmap(ctx) {
    const cx = ctx.camera.position.x, cz = ctx.camera.position.z;
    for (const c of clipMeshes) {
      const attr = c.attr;
      for (let i = 0; i < c.levels.length; i++) {
        const L = c.levels[i];
        const s = CM_S0 * Math.pow(2, L);
        const snap = 2 * s;
        const ox = Math.round(cx / snap) * snap;
        const oz = Math.round(cz / snap) * snap;
        const lod = L === 0 ? 3 : (L === 1 ? 3 : (L === 2 ? 2 : (L <= 4 ? 1 : 0)));
        attr.setXYZW(i, ox, oz, s, lod);
      }
      attr.needsUpdate = true;
    }
    _camXZ.set(cx, cz);
  }

  function updatePebbles(ctx) {
    const cp = ctx.camera.position;
    for (const c of pebbleChunks) {
      const d = Math.hypot(c.cx - cp.x, c.cz - cp.z);
      let f = 1.0;
      if (d > 30) f = Math.max(0.0, 1.0 - (d - 30) / 95);
      f = f * f;
      const n = d > 128 ? 0 : Math.max(0, Math.min(c.full, Math.ceil(c.full * f)));
      c.mesh.count = n;
      c.mesh.visible = n > 0;
    }
  }

  const _c = new THREE.Color();
  function updateSkyUniforms(ctx) {
    const sky = ctx.get('sky');
    const time = ctx.get('time');
    if (sky?.zenithRadiance) {
      sky.zenithRadiance(_c); surfUniforms.uTZenith.value.set(_c.r, _c.g, _c.b);
      sky.horizonRadiance(_c); surfUniforms.uTHorizon.value.set(_c.r, _c.g, _c.b);
    }
    if (time) {
      surfUniforms.uTSunDir.value.copy(time.sunDir);
      const k = time.state.sunIntensity * 1.15;
      surfUniforms.uTSunRad.value.set(time.sunColor.r * k, time.sunColor.g * k, time.sunColor.b * k);
      const wd = THREE.MathUtils.degToRad(time.state.windDir);
      fieldUniforms.uTWind.value.set(-Math.sin(wd), -Math.cos(wd)).normalize();
    }
  }

  /* ==================================================================== module */

  return {
    name: 'terrain',
    order: 30,
    enabled: true,
    bounds: { minX: CRS_X0, maxX: CRS_X1, minZ: CRS_Z0, maxZ: CRS_Z1 },

    async init(ctx) {
      ctxRef = ctx;

      /* ---- 1-D LUTs ------------------------------------------------------- */
      profileFn = monotoneSpline(PROFILE);
      profArr = new Float32Array(PROF_N * 4);
      for (let i = 0; i < PROF_N; i++) {
        const z = PROF_Z0 + (PROF_Z1 - PROF_Z0) * (i / (PROF_N - 1));
        profArr[i * 4] = profileFn(z);
      }
      profTex = new THREE.DataTexture(profArr, PROF_N, 1, THREE.RGBAFormat, THREE.FloatType);
      profTex.minFilter = profTex.magFilter = THREE.NearestFilter;
      profTex.wrapS = profTex.wrapT = THREE.ClampToEdgeWrapping;
      profTex.needsUpdate = true;

      shoreArr = new Float32Array(SHORE_N * 4);
      for (let i = 0; i < SHORE_N; i++) {
        const x = SHORE_X0 + (SHORE_X1 - SHORE_X0) * (i / (SHORE_N - 1));
        // waterline: beach cusps at ~27 m, a long meander, and the headland pulling
        // the shore inland as the beach pinches out to the east
        const cusp = Math.sin(x * (Math.PI * 2 / 27.0) + fbm2(x * 0.011, 3.7, 3) * 3.0) * 2.3;
        const meander = fbm2(x * 0.0065 + 51, 11.3, 4) * 9.0;
        const head = smoothstep(30, 120, x) * 27.0 - smoothstep(-30, -260, x) * 6.0;
        // width: widest at X = -20, pinched against the headland at X = +95
        let width = 1.0 + 0.46 * Math.exp(-Math.pow((x + 20) / 130, 2)) - 0.58 * smoothstep(5, 100, x);
        width += fbm2(x * 0.004 + 91, 5.1, 3) * 0.14;
        width = Math.min(Math.max(width, 0.34), 1.7);
        const berm = 0.75 + 0.5 * (fbm2(x * 0.014 + 131, 2.3, 3) * 0.5 + 0.5);
        const cob = Math.min(Math.max(0.30 + 0.95 * (fbm2(x * 0.0085 + 211, 7.7, 4) * 0.5 + 0.5), 0), 1.25);
        shoreArr[i * 4] = cusp + meander + head;
        shoreArr[i * 4 + 1] = width;
        shoreArr[i * 4 + 2] = berm;
        shoreArr[i * 4 + 3] = cob;
      }
      shoreTex = new THREE.DataTexture(shoreArr, SHORE_N, 1, THREE.RGBAFormat, THREE.FloatType);
      shoreTex.minFilter = shoreTex.magFilter = THREE.NearestFilter;
      shoreTex.wrapS = shoreTex.wrapT = THREE.ClampToEdgeWrapping;
      shoreTex.needsUpdate = true;

      fieldUniforms.tTProfile.value = profTex;
      fieldUniforms.tTShore.value = shoreTex;

      /* ---- CPU tables ----------------------------------------------------- */
      buildTables();

      /* ---- textures ------------------------------------------------------- */
      textures.sandMicro = bakeTexture(ctx, TEX_SAND_MICRO, 1024);
      textures.sandMeso = bakeTexture(ctx, TEX_SAND_MESO, 1024);
      textures.gravel = bakeTexture(ctx, TEX_GRAVEL, 1024);
      textures.macro = bakeTexture(ctx, TEX_MACRO, 512);
      textures.rock = bakeTexture(ctx, TEX_ROCK, 1024);
      surfUniforms.tTSandMicro.value = textures.sandMicro;
      surfUniforms.tTSandMeso.value = textures.sandMeso;
      surfUniforms.tTGravel.value = textures.gravel;
      surfUniforms.tTMacro.value = textures.macro;
      surfUniforms.tTRock.value = textures.rock;

      /* ---- materials ------------------------------------------------------ */
      surfMat = buildSurfaceMaterial(ctx);
      depthMat = buildDepthMaterial();
      gbufMat = buildGBufferMaterial();

      group = new THREE.Group();
      group.name = 'terrain';
      group.matrixAutoUpdate = false;
      ctx.scene.add(group);

      /* ---- clipmap -------------------------------------------------------- */
      ctrGeo = buildLattice(CM_M, 0);
      ringGeo = buildLattice(CM_M, CM_M / 2 - 2);
      ctrGeoG = shareGeo(ctrGeo);
      ringGeoG = shareGeo(ringGeo);

      const addClip = (geo, geoG, levels, castShadow) => {
        const attr = makeInstanceAttr(levels.length);
        geo.setAttribute('iParams', attr);
        geoG.setAttribute('iParams', attr);
        const mesh = new THREE.InstancedMesh(geo, surfMat, levels.length);
        mesh.frustumCulled = false;
        mesh.layers.set(LAYER.OPAQUE);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        mesh.customDepthMaterial = depthMat;
        mesh.matrixAutoUpdate = false;
        for (let i = 0; i < levels.length; i++) mesh.setMatrixAt(i, new THREE.Matrix4());
        mesh.instanceMatrix.needsUpdate = true;
        mesh.onBeforeRender = (r, scene) => { if (scene.overrideMaterial) geo.setDrawRange(0, -1); };
        mesh.onAfterRender = () => geo.setDrawRange(0, Infinity);
        group.add(mesh);

        const proxy = new THREE.InstancedMesh(geoG, gbufMat, levels.length);
        proxy.frustumCulled = false;
        proxy.layers.set(LAYER.OPAQUE);
        proxy.castShadow = false;
        proxy.receiveShadow = false;
        proxy.matrixAutoUpdate = false;
        for (let i = 0; i < levels.length; i++) proxy.setMatrixAt(i, new THREE.Matrix4());
        proxy.instanceMatrix.needsUpdate = true;
        proxy.onBeforeRender = (r, scene) => { if (!scene.overrideMaterial) geoG.setDrawRange(0, -1); };
        proxy.onAfterRender = () => geoG.setDrawRange(0, Infinity);
        group.add(proxy);

        clipMeshes.push({ mesh, proxy, attr, levels });
      };

      addClip(ctrGeo, ctrGeoG, [0], true);
      const nearLv = [], farLv = [];
      for (let L = 1; L <= CM_RINGS; L++) (L <= CM_NEAR_RINGS ? nearLv : farLv).push(L);
      // near rings and far rings need separate instance attributes; clone the ring geo
      const ringGeoFar = shareGeo(ringGeo), ringGeoFarG = shareGeo(ringGeo);
      addClip(ringGeo, ringGeoG, nearLv, true);
      addClip(ringGeoFar, ringGeoFarG, farLv, false);

      /* ---- instanced stone field ------------------------------------------ */
      buildPebbles(ctx);

      updateSkyUniforms(ctx);
      updateClipmap(ctx);
      updatePebbles(ctx);

      ctx.on('config', ({ k, v }) => {
        if (k === 'terrainDetail') fieldUniforms.uTDetail.value = v;
        if (k === 'terrainWetLevel') surfUniforms.uTWetLevel.value = v;
        if (k === 'terrainSpec') surfUniforms.uTSpecBoost.value = v;
        if (k === 'terrainDbg') surfUniforms.uTDbg.value = v;
        if (k === 'terrainEnvInt' && surfMat) surfMat.envMapIntensity = v;
        if (k === 'terrainDryCol') surfUniforms.uTDryCol.value.fromArray(v);
        if (k === 'terrainWetCol') surfUniforms.uTWetCol.value.fromArray(v);
      });
    },

    update(dt, ctx) {},

    prerender(ctx) {
      updateSkyUniforms(ctx);
      updateClipmap(ctx);
      updatePebbles(ctx);
      const pipe = ctx.get('pipeline')?.pipe;
      if (pipe && gbufMat) {
        // Mirrors src/render/passes/scene.js exactly, jitter convention included:
        // taa.js compensates for the jittered-vs-unjittered mismatch documented in
        // docs/KNOWN_ISSUES.md #1, and terrain must not be the one surface that
        // disagrees with the compensation.
        gbufMat.uniforms.uCurrViewProj.value
          .multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
        gbufMat.uniforms.uPrevViewProj.value.copy(pipe.prevViewProj);
      }
    },

    resize(w, h, ctx) {},

    /* ------------------------------------------------------------- public API */

    height,
    normal(x, z, out) { return normal(x, z, out); },

    sample(x, z) {
      const y = height(x, z);
      const n = normal(x, z, new THREE.Vector3());
      const slope = Math.min(Math.max(1 - n.y, 0), 1);
      const wet = wetnessAt(x, z, y);
      const shelf = smoothstep(-78, -66, x) * (1 - smoothstep(-24, -12, x))
                  * smoothstep(-17.5, -13, z) * (1 - smoothstep(-4, 0.5, z));
      const mat = (shelf > 0.5 || slope > 0.5) ? MAT_ID.ROCK
                : (wet > 0.5 ? MAT_ID.TERRAIN_WET : MAT_ID.TERRAIN_SAND);
      return { y, normal: n, slope, wetness: wet, material: mat };
    },

    raycast(origin, dir, maxDist = 400) {
      const d = dir.clone().normalize();
      let t = 0;
      let py = origin.y - height(origin.x, origin.z);
      if (py < 0) return null;
      const step0 = 0.25;
      while (t < maxDist) {
        const step = Math.max(step0, Math.min(6.0, py * 0.6 + step0));
        const nt = t + step;
        const x = origin.x + d.x * nt, y = origin.y + d.y * nt, z = origin.z + d.z * nt;
        const h = height(x, z);
        const ny = y - h;
        if (ny <= 0) {
          // bisect
          let a = t, b = nt;
          for (let i = 0; i < 24; i++) {
            const m = (a + b) * 0.5;
            const hm = height(origin.x + d.x * m, origin.z + d.z * m);
            if (origin.y + d.y * m - hm > 0) a = m; else b = m;
          }
          const tt = (a + b) * 0.5;
          const point = new THREE.Vector3(origin.x + d.x * tt, origin.y + d.y * tt, origin.z + d.z * tt);
          point.y = height(point.x, point.z);
          return { point, normal: normal(point.x, point.z, new THREE.Vector3()), t: tt };
        }
        t = nt; py = ny;
      }
      return null;
    },

    dispose(ctx) {
      if (group) ctx.scene.remove(group);
      for (const c of clipMeshes) { c.mesh.geometry.dispose(); c.proxy.geometry.dispose(); }
      for (const c of pebbleChunks) c.mesh.geometry.dispose?.();
      surfMat?.dispose(); depthMat?.dispose(); gbufMat?.dispose();
      for (const k in textures) textures[k]?.dispose();
      profTex?.dispose(); shoreTex?.dispose();
    },
  };
}
