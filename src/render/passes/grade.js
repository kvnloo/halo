import * as THREE from 'three';
import { Pass, fsMaterial, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `grade` — the colourist trim, applied in display space after `tonemap`.
 *
 * The whole transform is evaluated on the CPU into a 32^3 3D LUT at init (and again
 * only when a parameter actually changes), so the per-pixel cost on the GPU is one
 * tetrahedrally-interpolated lookup no matter how baroque the grade gets. That is the
 * point of a LUT: the grade is free to be expensive because nobody pays for it per
 * pixel.
 *
 * ## The chain, in order
 *
 *   1. ASC CDL          out = (in * slope + offset) ^ power        per channel
 *   2. lift / gamma / gain                                          per channel
 *   3. contrast around a pivot (power law, so it cannot clip on its own)
 *   4. saturation (Rec.709 luma preserving)
 *   5. split tone       cool into the shadows, warm into the highlights
 *   6. soft roll-off    a C1 exponential toe and shoulder
 *
 * ## Why the roll-off matters most
 *
 * Measured over all 157 reference keyframes the clip's tails look like this:
 *
 *      p0.1 = 4   p1 = 13   p99 = 225   p99.9 = 239   p99.99 = 251
 *      fraction at 0 = 6.6e-5      fraction at 255 = 1.2e-5
 *
 * i.e. the darkest content lands in the single digits but essentially never at zero,
 * and the brightest sun glint grazes 251 but essentially never clips. Both ends roll
 * off smoothly over a long way. That is the single most recognisable property of the
 * reference grade and the thing that makes a CG render read as "shot" rather than
 * "computed" — a hard clip at either end is instantly legible as CG.
 *
 * Steps 6's toe and shoulder are exponentials pinned to be C1 at the knee:
 *
 *      x < t :  y = lo  + (t - lo) * exp( -(t - x) / (t - lo) )
 *      x > s :  y = top - (top - s) * exp( -(x - s) / (top - s) )
 *
 * so the derivative is exactly 1 where they meet the linear middle — no visible kink,
 * no lost midtone contrast, and asymptotes at `lo` and `top` that are never reached.
 *
 * ## Config (all under ctx.config, all live)
 *
 *   gradeEnabled      bool     false bypasses the LUT (still one pass, no lookup)
 *   gradeCdlSlope     [r,g,b]  ASC CDL slope   (multiplicative, the warm push lives here)
 *   gradeCdlOffset    [r,g,b]  ASC CDL offset  (additive)
 *   gradeCdlPower     [r,g,b]  ASC CDL power   (gamma)
 *   gradeLift         [r,g,b]  raises shadows without touching white
 *   gradeGamma        [r,g,b]  midtone gamma
 *   gradeGain         [r,g,b]  multiplies white without touching black
 *   gradeContrast     number   power law around gradePivot
 *   gradePivot        number   the tonal centre contrast rotates about
 *   gradeSaturation   number   1 = untouched
 *   gradeShadowTint    [r,g,b] added where luma is low  (cool)
 *   gradeHighlightTint [r,g,b] added where luma is high (warm)
 *   gradeSplitPivot   number   luma at which the two masks hand over
 *   gradeBlackFloor   number   toe asymptote, display units
 *   gradeToeStart     number   luma below which the toe engages
 *   gradeWhiteCeil    number   shoulder asymptote, display units
 *   gradeShoulderStart number  luma above which the shoulder engages
 *   gradeDither       number   TPDF dither in LSBs, only when writing the 8-bit backbuffer
 *   gradeLutSize      number   LUT grid resolution (default 32; a rebuild reallocates)
 *
 * Cost: 4 texelFetch from a 512 KB RGBA32F volume that lives in L2, plus ~10 ALU.
 * ~0.07 ms at 1920x1080 on a 3080 Ti. LUT rebuild is ~2 ms of CPU, off the hot path.
 */

/* --------------------------------------------------------------- the defaults */
/*
 * Calibrated against the reference clip. The reasoning behind each number:
 *
 *  - slope is a warm push of +1.2% red / -1.4% blue. The clip's mean lab_a is +2.6 and
 *    lab_b hovers around zero, i.e. a very slight magenta-warm bias with *no* yellow
 *    cast. Pushing red and pulling blue while leaving green alone moves a and leaves b
 *    almost untouched, which is exactly that signature. Nudging red/yellow instead —
 *    the reflex "make it warm" move — overshoots lab_b and lands in the orange-and-teal
 *    look the reference conspicuously does not have.
 *  - saturation 1.075: the reference sits at sat_mean 83.9/255 against a neutral AgX
 *    render's ~78. AgX's inset/outset pair deliberately leaves a little saturation on
 *    the table in exchange for its highlight behaviour; this puts it back.
 *  - contrast 1.045 about a 0.42 pivot: matches lum_std 52.3 / local_contrast 0.192
 *    without steepening the toe, because the pivot sits below the midpoint.
 *  - the split tone is deliberately tiny (2 code values at 8 bits). Its job is to keep
 *    the sky-fill in the shadows reading as *sky* rather than as grey, and to let the
 *    sand bounce read as warm, not to be a look.
 *  - toe/shoulder as derived from the clip's measured tails, above.
 */
const DEFAULTS = {
  gradeEnabled: true,

  gradeCdlSlope: [1.012, 1.000, 0.986],
  gradeCdlOffset: [0.000, 0.000, 0.000],
  gradeCdlPower: [1.000, 1.000, 1.000],

  gradeLift: [0.000, 0.000, 0.000],
  gradeGamma: [1.000, 1.000, 1.000],
  gradeGain: [1.000, 1.000, 1.000],

  gradeContrast: 1.045,
  gradePivot: 0.420,
  gradeSaturation: 1.075,

  gradeShadowTint: [-0.004, 0.000, 0.008],
  gradeHighlightTint: [0.008, 0.003, -0.006],
  gradeSplitPivot: 0.500,

  gradeBlackFloor: 0.010,
  gradeToeStart: 0.075,
  gradeWhiteCeil: 1.000,
  gradeShoulderStart: 0.870,

  gradeDither: 1.0,
  gradeLutSize: 32,
};

const LUMA = [0.2126, 0.7152, 0.0722];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * One exponential knee, C1-continuous with the identity at the knee point.
 * `lo < t`: below `t` the curve bends over toward `lo` and never reaches it.
 */
function toe(x, lo, t) {
  if (x >= t || t <= lo) return x;
  const d = t - lo;
  return lo + d * Math.exp(-(t - x) / d);
}
function shoulder(x, top, s) {
  if (x <= s || top <= s) return x;
  const d = top - s;
  return top - d * Math.exp(-(x - s) / d);
}

/**
 * The full grade, in display space. Input and output are sRGB-encoded [0,1].
 * This is the single source of truth: the GPU only ever sees its baked output.
 * @param {number[]} rgb
 * @param {object}   P  a fully-populated parameter set (see DEFAULTS)
 */
export function gradeJS(rgb, P) {
  let c = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];

  // 1. ASC CDL: (x * slope + offset) ^ power
  for (let i = 0; i < 3; i++) {
    const v = c[i] * P.gradeCdlSlope[i] + P.gradeCdlOffset[i];
    c[i] = Math.pow(Math.max(v, 0), P.gradeCdlPower[i]);
  }

  // 2. lift / gamma / gain. Lift pivots on white, gain pivots on black, so the two
  //    are independent and a colourist can reach for either without undoing the other.
  for (let i = 0; i < 3; i++) {
    const L = P.gradeLift[i];
    let v = (c[i] + L * (1 - c[i])) * P.gradeGain[i];
    c[i] = Math.pow(Math.max(v, 0), 1 / Math.max(P.gradeGamma[i], 1e-3));
  }

  // 3. contrast as a power law about the pivot — monotone, and it degrades gracefully
  //    instead of clipping the way a linear (x-p)*k + p does.
  if (P.gradeContrast !== 1) {
    const p = Math.max(P.gradePivot, 1e-4);
    for (let i = 0; i < 3; i++) c[i] = p * Math.pow(Math.max(c[i], 1e-6) / p, P.gradeContrast);
  }

  // 4. saturation about Rec.709 luma
  if (P.gradeSaturation !== 1) {
    const l = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
    for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * P.gradeSaturation;
  }

  // 5. split tone. Weighted so the two masks sum to <= 1 and vanish at the pivot.
  {
    const l = clamp01(LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]);
    const sw = 1 - smoothstep(0, P.gradeSplitPivot, l);
    const hw = smoothstep(P.gradeSplitPivot, 1, l);
    for (let i = 0; i < 3; i++) c[i] += P.gradeShadowTint[i] * sw + P.gradeHighlightTint[i] * hw;
  }

  // 6. soft roll-off at both ends
  for (let i = 0; i < 3; i++) {
    let v = c[i];
    v = toe(v, P.gradeBlackFloor, P.gradeToeStart);
    v = shoulder(v, P.gradeWhiteCeil, P.gradeShoulderStart);
    c[i] = clamp01(v);
  }
  return c;
}

/**
 * Bake the grade into an N^3 RGBA float lattice, laid out for a sampler3D
 * (x fastest, then y, then z).
 */
export function buildGradeLut(P, N = 32) {
  const data = new Float32Array(N * N * N * 4);
  const inv = 1 / (N - 1);
  let o = 0;
  for (let z = 0; z < N; z++) {
    const b = z * inv;
    for (let y = 0; y < N; y++) {
      const g = y * inv;
      for (let x = 0; x < N; x++) {
        const c = gradeJS([x * inv, g, b], P);
        data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2]; data[o++] = 1;
      }
    }
  }
  return data;
}

/** Merge ctx.config over DEFAULTS, so a partially-poked config is still complete. */
export function resolveParams(config = {}) {
  const P = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = config[k];
    const d = DEFAULTS[k];
    if (v === undefined) P[k] = Array.isArray(d) ? d.slice() : d;
    else P[k] = Array.isArray(d) ? [v[0] ?? d[0], v[1] ?? d[1], v[2] ?? d[2]] : v;
  }
  return P;
}

export { DEFAULTS as GRADE_DEFAULTS };

/* ------------------------------------------------------------------ the shader */

const FRAG = /* glsl */`
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler3D tLut;
uniform float uLutSize;
uniform float uBypass;    // >0.5 = straight copy
uniform float uDither;    // TPDF amplitude in LSBs; 0 when not writing 8-bit
out vec4 oCol;

/*
 * Tetrahedral interpolation. Trilinear would be a single hardware tap, but it
 * interpolates across the cube diagonal and that shows up as a hue twist on smooth
 * gradients — exactly where a sky is, which is a third of this game's frame. The
 * tetrahedral decomposition only ever mixes four lattice points that lie in the same
 * simplex, so the neutral axis stays neutral and gradients stay clean. Four texelFetch
 * from a 512 KB volume is a cache hit every time; the cost difference is noise.
 */
vec3 lutTetra(vec3 c){
  float N = uLutSize;
  vec3 p = clamp(c, 0.0, 1.0) * (N - 1.0);
  vec3 base = floor(p);
  vec3 f = p - base;

  ivec3 hi = ivec3(int(N) - 1);
  ivec3 i0 = min(ivec3(base), hi);
  ivec3 i1 = min(i0 + ivec3(1), hi);

  vec3 c000 = texelFetch(tLut, i0, 0).rgb;
  vec3 c111 = texelFetch(tLut, i1, 0).rgb;

  if (f.r > f.g) {
    if (f.g > f.b) {          // r > g > b
      vec3 a = texelFetch(tLut, ivec3(i1.x, i0.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i1.y, i0.z), 0).rgb;
      return (1.0 - f.r) * c000 + (f.r - f.g) * a + (f.g - f.b) * b + f.b * c111;
    } else if (f.r > f.b) {   // r > b > g
      vec3 a = texelFetch(tLut, ivec3(i1.x, i0.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i0.y, i1.z), 0).rgb;
      return (1.0 - f.r) * c000 + (f.r - f.b) * a + (f.b - f.g) * b + f.g * c111;
    } else {                  // b > r > g
      vec3 a = texelFetch(tLut, ivec3(i0.x, i0.y, i1.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i0.y, i1.z), 0).rgb;
      return (1.0 - f.b) * c000 + (f.b - f.r) * a + (f.r - f.g) * b + f.g * c111;
    }
  } else {
    if (f.b > f.g) {          // b > g > r
      vec3 a = texelFetch(tLut, ivec3(i0.x, i0.y, i1.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i0.x, i1.y, i1.z), 0).rgb;
      return (1.0 - f.b) * c000 + (f.b - f.g) * a + (f.g - f.r) * b + f.r * c111;
    } else if (f.b > f.r) {   // g > b > r
      vec3 a = texelFetch(tLut, ivec3(i0.x, i1.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i0.x, i1.y, i1.z), 0).rgb;
      return (1.0 - f.g) * c000 + (f.g - f.b) * a + (f.b - f.r) * b + f.r * c111;
    } else {                  // g > r > b
      vec3 a = texelFetch(tLut, ivec3(i0.x, i1.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i1.y, i0.z), 0).rgb;
      return (1.0 - f.g) * c000 + (f.g - f.r) * a + (f.r - f.b) * b + f.b * c111;
    }
  }
}

/* Deterministic (frame-invariant) interleaved-gradient hash. */
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main(){
  vec3 src = texture(tSrc, vUv).rgb;
  vec3 c = uBypass > 0.5 ? clamp(src, 0.0, 1.0) : lutTetra(src);

  // Triangular-PDF dither, one LSB peak-to-peak, so the 32^3 lattice and the 8-bit
  // backbuffer cannot band a smooth sky. Frame-invariant, so captures stay identical.
  if (uDither > 0.0) {
    vec2 q = gl_FragCoord.xy;
    float n = ign(q) - ign(q + vec2(37.0, 17.0));   // two hashes -> triangular PDF
    c += (n * uDither) / 255.0;
  }
  oCol = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/* -------------------------------------------------------------------- the pass */

export function create(opts = {}) {
  const p = new Pass('grade');
  let quad = null, mat = null, lutTex = null, lutN = 0, sig = '';

  const signature = (P) => JSON.stringify(P);

  function rebuild(P) {
    const N = Math.max(8, Math.min(64, P.gradeLutSize | 0 || 32));
    const data = buildGradeLut(P, N);
    if (!lutTex || lutN !== N) {
      lutTex?.dispose();
      lutTex = new THREE.Data3DTexture(data, N, N, N);
      lutTex.format = THREE.RGBAFormat;
      lutTex.type = THREE.FloatType;
      // Nearest: the tetrahedral filter fetches lattice points directly and does its
      // own weighting. Hardware filtering here would fight it.
      lutTex.minFilter = THREE.NearestFilter;
      lutTex.magFilter = THREE.NearestFilter;
      lutTex.wrapS = lutTex.wrapT = lutTex.wrapR = THREE.ClampToEdgeWrapping;
      lutTex.colorSpace = THREE.NoColorSpace;
      lutTex.unpackAlignment = 1;
      lutN = N;
    } else {
      lutTex.image.data.set(data);
    }
    lutTex.needsUpdate = true;
    if (mat) {
      mat.uniforms.tLut.value = lutTex;
      mat.uniforms.uLutSize.value = N;
    }
  }

  p.init = (ctx) => {
    // Publish every default into ctx.config so tuning really is a one-liner and a
    // debug UI can enumerate the whole grade without knowing about this file.
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (ctx.config[k] === undefined) ctx.config[k] = Array.isArray(v) ? v.slice() : v;
    }

    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      tLut: { value: null },
      uLutSize: { value: 32 },
      uBypass: { value: 0 },
      uDither: { value: 0 },
    });
    quad = new FullScreenQuad(mat);

    const P = resolveParams(ctx.config);
    sig = signature(P);
    rebuild(P);
  };

  p.render = (ctx, pipe, out) => {
    const P = resolveParams(ctx.config);
    const s = signature(P);
    if (s !== sig) { sig = s; rebuild(P); }

    mat.uniforms.tSrc.value = pipe.read.texture;
    mat.uniforms.uBypass.value = P.gradeEnabled ? 0 : 1;
    // Dither only buys anything against an 8-bit destination; an intermediate
    // half-float target would just carry the noise into sharpen and grain.
    mat.uniforms.uDither.value = out === null ? (P.gradeDither || 0) : 0;

    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.setSize = () => {};
  p.dispose = () => { quad?.dispose(); lutTex?.dispose(); };
  return p;
}
