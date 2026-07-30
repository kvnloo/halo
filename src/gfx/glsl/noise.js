/**
 * Shared GLSL noise library.
 *
 * Every procedural surface in the game draws from this so that sand, rock, metal and
 * foliage share a coherent statistical character. Import the chunk you need and
 * splice it into your shader source; do not re-implement noise locally.
 *
 *   import { NOISE_GLSL } from '../gfx/glsl/noise.js';
 *   const frag = NOISE_GLSL + `...my shader...`;
 */

export const HASH_GLSL = /* glsl */`
// ---------------------------------------------------------------- hashing
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p3){ p3 = fract(p3*0.1031); p3 += dot(p3, p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3  hash33(vec3 p3){ p3 = fract(p3*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
vec3  hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yzz)*p3.zyx); }
`;

export const VALUE_NOISE_GLSL = /* glsl */`
// ------------------------------------------------------------ value noise
float vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash12(i+vec2(0,0)), hash12(i+vec2(1,0)), u.x),
             mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(mix(hash13(i+vec3(0,0,0)), hash13(i+vec3(1,0,0)), u.x),
                 mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), u.x), u.y),
             mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), u.x),
                 mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), u.x), u.y), u.z);
}
`;

export const GRAD_NOISE_GLSL = /* glsl */`
// --------------------------------------------------------- gradient noise
float gnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 ga = normalize(hash22(i+vec2(0,0))*2.0-1.0);
  vec2 gb = normalize(hash22(i+vec2(1,0))*2.0-1.0);
  vec2 gc = normalize(hash22(i+vec2(0,1))*2.0-1.0);
  vec2 gd = normalize(hash22(i+vec2(1,1))*2.0-1.0);
  return mix(mix(dot(ga, f-vec2(0,0)), dot(gb, f-vec2(1,0)), u.x),
             mix(dot(gc, f-vec2(0,1)), dot(gd, f-vec2(1,1)), u.x), u.y) * 1.4142;
}
float gnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  #define G3(o) dot(normalize(hash33(i+o)*2.0-1.0), f-o)
  return mix(mix(mix(G3(vec3(0,0,0)), G3(vec3(1,0,0)), u.x),
                 mix(G3(vec3(0,1,0)), G3(vec3(1,1,0)), u.x), u.y),
             mix(mix(G3(vec3(0,0,1)), G3(vec3(1,0,1)), u.x),
                 mix(G3(vec3(0,1,1)), G3(vec3(1,1,1)), u.x), u.y), u.z) * 1.1547;
  #undef G3
}
/** Analytic-derivative 2D gradient noise: returns (value, ddx, ddy).
 *  Lets a shader build a normal map from noise without finite differences. */
vec3 gnoise2d(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
  vec2 ga = normalize(hash22(i+vec2(0,0))*2.0-1.0);
  vec2 gb = normalize(hash22(i+vec2(1,0))*2.0-1.0);
  vec2 gc = normalize(hash22(i+vec2(0,1))*2.0-1.0);
  vec2 gd = normalize(hash22(i+vec2(1,1))*2.0-1.0);
  float va = dot(ga, f-vec2(0,0)), vb = dot(gb, f-vec2(1,0));
  float vc = dot(gc, f-vec2(0,1)), vd = dot(gd, f-vec2(1,1));
  float v = va + u.x*(vb-va) + u.y*(vc-va) + u.x*u.y*(va-vb-vc+vd);
  vec2 d = ga + u.x*(gb-ga) + u.y*(gc-ga) + u.x*u.y*(ga-gb-gc+gd)
         + du * (vec2(u.y,u.x)*(va-vb-vc+vd) + vec2(vb,vc) - va);
  return vec3(v, d) * 1.4142;
}
`;

export const WORLEY_GLSL = /* glsl */`
// ------------------------------------------------------- worley / cellular
vec2 worley2(vec2 p){                     // returns (F1, F2)
  vec2 n = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n+g);
    float d = length(g + o - f);
    if(d < f1){ f2 = f1; f1 = d; } else if(d < f2){ f2 = d; }
  }
  return vec2(f1, f2);
}
vec2 worley3(vec3 p){
  vec3 n = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for(int k=-1;k<=1;k++) for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 o = hash33(n+g);
    float d = length(g + o - f);
    if(d < f1){ f2 = f1; f1 = d; } else if(d < f2){ f2 = d; }
  }
  return vec2(f1, f2);
}
/** Tiling worley for cloud volume textures. */
float worley3Tiled(vec3 p, float freq){
  p *= freq;
  vec3 n = floor(p), f = fract(p);
  float f1 = 8.0;
  for(int k=-1;k<=1;k++) for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 c = mod(n+g, freq);
    float d = length(g + hash33(c) - f);
    f1 = min(f1, d);
  }
  return 1.0 - f1;
}
`;

export const FBM_GLSL = /* glsl */`
// ------------------------------------------------------------------- fbm
const mat2 M2 = mat2(0.80, 0.60, -0.60, 0.80);
const mat3 M3 = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

float fbm2(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s += a*gnoise2(p); n += a; p = M2*p*2.02; a *= 0.5; }
  return s/max(n,1e-4);
}
float fbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s += a*gnoise3(p); n += a; p = M3*p*2.03; a *= 0.5; }
  return s/max(n,1e-4);
}
/** Ridged multifractal — eroded rock, cliff faces, cloud wisps. */
float ridged2(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0, prev = 1.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    float v = 1.0 - abs(gnoise2(p)); v *= v; v *= prev; prev = v;
    s += a*v; n += a; p = M2*p*2.04; a *= 0.5;
  }
  return s/max(n,1e-4);
}
float ridged3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0, prev = 1.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    float v = 1.0 - abs(gnoise3(p)); v *= v; v *= prev; prev = v;
    s += a*v; n += a; p = M3*p*2.05; a *= 0.5;
  }
  return s/max(n,1e-4);
}
/** Domain-warped fbm — the single cheapest way to stop noise looking like noise. */
float warpedFbm2(vec2 p, int oct, float warp){
  vec2 q = vec2(fbm2(p, 4), fbm2(p + vec2(5.2, 1.3), 4));
  return fbm2(p + warp*q, oct);
}
`;

export const TRIPLANAR_GLSL = /* glsl */`
// ------------------------------------------------------------- tri-planar
/** Blend weights from a world normal. sharp 4..12; higher = less cross-fade. */
vec3 triWeights(vec3 n, float sharp){
  vec3 w = pow(abs(n), vec3(sharp));
  return w / max(w.x + w.y + w.z, 1e-5);
}
vec3 triplanarColor(sampler2D tex, vec3 wp, vec3 n, float scale, float sharp){
  vec3 w = triWeights(n, sharp);
  vec3 cx = texture(tex, wp.zy * scale).rgb;
  vec3 cy = texture(tex, wp.xz * scale).rgb;
  vec3 cz = texture(tex, wp.xy * scale).rgb;
  return cx*w.x + cy*w.y + cz*w.z;
}
/** Whiteout tri-planar normal blend — keeps detail that naive blending flattens. */
vec3 triplanarNormal(sampler2D nmap, vec3 wp, vec3 n, float scale, float sharp){
  vec3 w = triWeights(n, sharp);
  vec3 nx = texture(nmap, wp.zy * scale).xyz * 2.0 - 1.0;
  vec3 ny = texture(nmap, wp.xz * scale).xyz * 2.0 - 1.0;
  vec3 nz = texture(nmap, wp.xy * scale).xyz * 2.0 - 1.0;
  nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
  ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
  nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
  return normalize(nx.zyx*w.x + ny.xzy*w.y + nz.xyz*w.z);
}
`;

export const TILEBREAK_GLSL = /* glsl */`
// ---------------------------------------------------- stochastic tile break
/** Hex-grid stochastic texture sampling (Heitz & Neyret style, simplified).
 *  Kills visible tiling on large surfaces — essential for a beach that fills
 *  two thirds of frame. Costs 3 taps. */
vec4 textureNoTile(sampler2D tex, vec2 uv, float v){
  vec2 p = floor(uv), f = fract(uv);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for(int j=0;j<2;j++) for(int i=0;i<2;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(p + g) * v;
    float w = (1.0 - abs(f.x - g.x)) * (1.0 - abs(f.y - g.y));
    acc += textureGrad(tex, uv + o, dx, dy) * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-4);
}
`;

/** Everything, in dependency order. */
export const NOISE_GLSL = HASH_GLSL + VALUE_NOISE_GLSL + GRAD_NOISE_GLSL + WORLEY_GLSL + FBM_GLSL;
export const SURFACE_GLSL = NOISE_GLSL + TRIPLANAR_GLSL + TILEBREAK_GLSL;
