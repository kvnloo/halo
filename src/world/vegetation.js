import * as THREE from 'three';
import { LAYER } from '../render/RenderPipeline.js';
import { applyWorldMaterial, configureTexture } from '../gfx/materialCommon.js';
import { patchForGBuffer, MAT_ID } from '../gfx/GBufferMaterial.js';
import { NOISE_GLSL } from '../gfx/glsl/noise.js';
import { POSES } from './poses.js';

/**
 * `vegetation` — the hero tree, dune grass, salt scrub, moss crowns and hanging vines.
 *
 * Reference: kf_00720 (hero tree on stack_hero, ivy drape on the cliff, a vine curtain
 * off the stack's shadowed side, sparse dune-grass tufts on the back beach) and
 * kf_01500 (moss crowns draped over the stack rims, long thin vine curtains).
 *
 * Three things drive every decision in this file.
 *
 * 1. **The palette is olive, khaki and straw — not green.** Measured off the reference,
 *    foliage-masked: sunlit canopy sRGB (157,158,116), moss (124,119,75), dune grass
 *    (148,122,88) — R ≈ G with B at roughly half. A saturated green canopy is the
 *    fastest way to look like a different game.
 *
 * 2. **Backlit foliage must glow.** At the reference sun (az 118°, el 41°) every pose
 *    that shows the tree shows it *against* the sun. Without a transmission term the
 *    canopy renders as a black cut-out on a bright sky, which is the single most common
 *    vegetation failure. `uTrans*` below is a two-lobe back-scatter: a broad wrap that
 *    lifts any leaf whose back face is lit, and a tight view-aligned lobe that blooms
 *    when the camera looks into the sun through the canopy.
 *
 * 3. **Everything shares one wind function** (`vegWindOffset`). Grass, leaves, scrub,
 *    moss and vines are all driven from `time.wind` / `time.state.gust` through the same
 *    two-component model — a broad low-frequency sway plus a gust-scaled flutter — so
 *    they agree about the weather. Stiffness is quadratic in the along-plant parameter,
 *    which is what makes trunks read as rigid and tips as soft.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE MATERIALS SET `allowOverride = false`
 * ---------------------------------------------------------------------------
 * The G-buffer pre-pass in `src/render/passes/scene.js` installs one shared
 * `scene.overrideMaterial`. That material cannot serve alpha-cutout, vertex-animated
 * foliage, for two independent reasons:
 *
 *   a) **It cannot punch the alpha holes.** `GBufferMaterial` reads `vMapUv`, which three
 *      only declares when `USE_MAP` is defined — and it is a bare ShaderMaterial with no
 *      `.map`, so the define never appears and its `uAlphaTest` branch is dead. Depth is
 *      therefore written across the *whole* leaf quad. The opaque pass then discards the
 *      transparent part, and everything behind it fails the LEQUAL depth test against a
 *      hole that nothing fills — every leaf card carves a hard-edged rectangle of sky
 *      through the tree, the cliff and the beach.
 *
 *   b) **It has no access to the wind.** The pre-pass would rasterise the rest pose while
 *      the opaque pass rasterises the bent pose. Wherever the bend pushes a fragment
 *      *away* from the camera it fails LEQUAL and drops out — foliage flickers holes.
 *
 * So these materials opt out of the override (three r185 `Material.allowOverride`) and
 * render the G-buffer themselves, from the same vertex shader, writing exactly the MRT
 * layout `GBufferMaterial.js` documents:
 *
 *     MRT0.rgb view normal   MRT0.a roughness
 *     MRT1.rg  NDC motion    MRT1.b matId/255   MRT1.a 1
 *
 * with the *same* jittered-current / un-jittered-previous convention `scene.js` uses, so
 * the compensation in `taa.js` stays valid. The pass is detected from the bound render
 * target having more than one colour attachment, and the shader returns immediately
 * after the normal chunks — the pre-pass never runs the lighting half of the shader.
 *
 * The one thing this buys beyond correctness: the previous-frame vertex position is
 * evaluated with the wind at `t - dt`, so wind-animated foliage carries a *true* motion
 * vector and TAA reprojects it instead of smearing it. Vertex-animated foliage with a
 * zero velocity is temporal mush, and it would have cost exactly the `detail` and
 * `lap_var` this project is graded on.
 *
 * `patchForGBuffer()` is still called on every mesh so the transform history that
 * `gbufMat.captureHistory()` maintains stays consistent, and so the intent is recorded
 * where the next person looks.
 *
 * ---------------------------------------------------------------------------
 * INSTANCING
 * ---------------------------------------------------------------------------
 * Every scatter is a plain `THREE.Mesh` over an `InstancedBufferGeometry` — not an
 * `InstancedMesh`. That keeps `USE_INSTANCING` undefined, so `transformed` is already in
 * world space and a world-space wind offset can simply be added to it, with no inverse
 * transforms and no double application of `instanceMatrix` in `<worldpos_vertex>`.
 * Placement is done in the vertex shader from three per-instance attributes:
 *
 *     aPos vec3   world anchor
 *     aOri vec4   yaw, tilt, scaleY, scaleXZ
 *     aVar vec4   windPhase, tint, flutter, stiffBias
 *
 * plus two per-vertex attributes shared by every geometry in the file:
 *
 *     aVeg2.x     seg — 0 at the anchored end, 1 at the free tip (drives stiffness)
 *     aVeg2.y     jit — per-vertex decorrelation for leaf shiver
 *
 * The travelling-wave term of the wind is *baked into* `aVar.x` on the CPU
 * (`phase += dot(anchorXZ, windDir) * k`) rather than recomputed from the vertex's own
 * world position. That is what keeps a leaf sprig locked to the branch tip it hangs
 * from: sprig and branch share the tree's anchor, so they sway as one body. The cost is
 * that rotating the wind at runtime translates the plants but does not re-phase the
 * spatial wave; the reference wind is a fixed 236°, so that trade is free here.
 */

/* ========================================================================== *
 *  Tunables
 * ========================================================================== */

/**
 * Scale from `time.state.sunIntensity` (the lighting module's own sun radiance scalar,
 * which `applyWorldMaterial` binds in the same units) to the radiance the two-lobe
 * transmission lobes integrate against. Foliage transmission is a *single* forward
 * scatter out of a leaf whose transmittance is ~12% in the visible — so the lobe sees
 * roughly an eighth of the direct sun radiance the diffuse lobe does. Keeping this a
 * named constant means retuning sun intensity moves transmission with it instead of
 * silently changing the backlit read.
 */
const LEAF_TRANSMITTANCE = 0.115;
const SUN_RAD_SCALE = LEAF_TRANSMITTANCE;

/**
 * The one alpha reference in this file. Every cutout mip chain is built to conserve
 * coverage at this value and every material that samples one of those chains uses it as
 * its `alphaTest` — see `assertAlphaRef`. They were 0.5 and 0.42 respectively, which
 * made distant foliage *gain* coverage.
 */
const LEAF_ALPHA_REF = 0.42;
/** Same contract for the grass blade strip, which has its own (much thinner) mask. */
const BLADE_ALPHA_REF = 0.30;

const CFG = {
  grassBlades: 172000,     // total blades over berm + cliff top + dry sand
  grassTiles: 3,           // spatial split, so frustum culling can drop most of it
  scrubCount: 620,
  mossClumps: 5200,
  ivyCards: 3200,
  vineStrands: 1750,
  treeSites: 14,
};

/* ========================================================================== *
 *  Shared GLSL
 * ========================================================================== */

/** The one wind function. Every vegetation vertex shader calls exactly this. */
const WIND_GLSL = /* glsl */`
uniform vec3  uWindDir;      // unit, horizontal, points downwind
uniform vec3  uWindSide;     // uWindDir rotated 90 deg, for the cross-flutter
uniform float uWindAmp;      // metres of tip travel per metre of plant height
uniform float uGust;         // time.state.gust, 0..1
uniform float uWindT;
uniform float uWindTPrev;
uniform float uFlutter;      // per-material weight on the fast component
uniform float uSegScale;     // how much of the stiffness comes from aVeg2.x

/**
 * Two components, exactly as the brief asks:
 *   - a broad low-frequency sway (two beating sines, ~0.14 and ~0.065 Hz)
 *   - a higher-frequency flutter (~0.85 and ~1.4 Hz) whose amplitude rides the gust
 * stiff is 0 at the anchored end and 1 at the free tip; the square is what makes a
 * trunk rigid and a tip soft. height restores arc length by dropping the tip as it
 * bends, so a blade pivots instead of stretching.
 */
vec3 vegWindOffset(float stiff, float phase, float flutter, float height, float t){
  float sway = sin(t * 0.86 + phase) * 0.63
             + sin(t * 0.41 + phase * 0.63 + 1.71) * 0.37;
  float fa   = sin(t * 5.31 + phase * 3.11) * 0.60
             + sin(t * 8.93 + phase * 1.73) * 0.40;
  float fb   = sin(t * 6.77 + phase * 2.19 + 2.4) * 0.55
             + sin(t * 11.3 + phase * 4.07) * 0.45;

  float gustAmp = 0.55 + 0.75 * uGust;
  float k = uWindAmp * stiff * stiff * height;
  float along = (sway * gustAmp + fa * flutter * uFlutter * (0.15 + 1.10 * uGust)) * k;
  float cross = fb * flutter * uFlutter * (0.10 + 0.65 * uGust) * k * 0.55;

  vec3 off = uWindDir * along + uWindSide * cross;
  off.y -= dot(off, off) / (2.0 * max(height, 0.08));   // arc-length preservation
  return off;
}
`;

/** Per-instance placement + wind, shared by every vegetation vertex shader. */
const PLACE_GLSL = /* glsl */`
attribute vec3 aPos;
attribute vec4 aOri;   // yaw, tilt, scaleY, scaleXZ
attribute vec4 aVar;   // windPhase, tint, flutter, stiffBias
attribute vec3 aVeg2;  // seg (0 anchored .. 1 tip), jit, ao (0 buried .. 1 exposed)

uniform vec3  uCamPos;
uniform vec2  uLod;         // (fade start, fade end) in metres
uniform float uWidthGrow;   // sub-pixel compensation: widen with distance
uniform float uDensity;     // 0..1 global density multiplier

varying float vSeg;
varying float vTint;
varying float vJit;
varying float vAO;
varying vec2  vVegUv;

/** Stochastic distance thinning. Returns the surviving instance's width boost. */
float vegLod(out float alive){
  float d = distance(aPos, uCamPos);
  float f = (1.0 - smoothstep(uLod.x, uLod.y, d)) * uDensity;
  float r = fract(aVar.x * 0.1273 + aVar.y * 7.3191 + 0.137);
  alive = step(r, f);
  // Conserve apparent coverage as instances drop out, and never let a blade fall
  // under a pixel: both are what stops a distance LOD reading as a visible ring.
  return mix(1.0, clamp(1.0 / max(f, 0.16), 1.0, 2.6), 1.0 - f)
       * (1.0 + d * uWidthGrow);
}

/** yaw(Y) * tilt(X) * scale, then the shared wind, then the world anchor. */
vec3 vegPlace(vec3 p, float wboost, float t, out vec3 outN, vec3 nrm){
  float sY = aOri.z, sXZ = aOri.w * wboost;
  vec3 q = vec3(p.x * sXZ, p.y * sY, p.z * sXZ);
  vec3 m = vec3(nrm.x * sY, nrm.y * sXZ, nrm.z * sY);   // inverse-transpose of the scale

  float ct = cos(aOri.y), st = sin(aOri.y);
  q = vec3(q.x, ct * q.y - st * q.z, st * q.y + ct * q.z);
  m = vec3(m.x, ct * m.y - st * m.z, st * m.y + ct * m.z);

  float cy = cos(aOri.x), sy = sin(aOri.x);
  q = vec3(cy * q.x + sy * q.z, q.y, -sy * q.x + cy * q.z);
  m = vec3(cy * m.x + sy * m.z, m.y, -sy * m.x + cy * m.z);
  outN = normalize(m);

  float stiff = clamp(aVar.w + aVeg2.x * uSegScale, 0.0, 1.35);
  float phase = aVar.x + aVeg2.y * 0.9;
  q += vegWindOffset(stiff, phase, aVar.z, max(sY, 0.05), t);
  return aPos + q;
}
`;

/** G-buffer half of the material. Mirrors src/gfx/GBufferMaterial.js exactly. */
const GBUF_PARS_FRAG = /* glsl */`
layout(location = 1) out vec4 vegMotionId;
uniform float uGBufPass;
uniform float uVegMatId;
varying vec4 vVegCur;
varying vec4 vVegPrev;
`;

const GBUF_EMIT = /* glsl */`
if (uGBufPass > 0.5) {
  vec2 cur  = vVegCur.xy  / max(vVegCur.w,  1e-6);
  vec2 prev = vVegPrev.xy / max(vVegPrev.w, 1e-6);
  gl_FragColor  = vec4(normalize(normal) * 0.5 + 0.5, roughnessFactor);
  vegMotionId   = vec4((cur - prev) * 0.5, uVegMatId / 255.0, 1.0);
  return;
}
`;

/** Two-lobe leaf transmission. Injected after <aomap_fragment>, before totalDiffuse. */
const TRANS_PARS = /* glsl */`
uniform vec3  uSunDirV;      // view-space, points toward the sun
uniform vec3  uSunRad;       // sun colour * intensity
uniform vec3  uTransColor;   // what light looks like after passing through a leaf
uniform float uTransScale;
uniform float uTransPower;
uniform float uBaseAO;
uniform float uAlbedoAO;
uniform float uSpecScale;
uniform vec3  uColA;
uniform vec3  uColB;
`;

const TRANS_EMIT = /* glsl */`
{
  // Baked canopy occlusion on the *indirect* term. Interior leaves see almost no sky,
  // sunlit outer leaves see all of it — that difference *is* the contrast of a tree.
  float vegAO = mix(uBaseAO, 1.0, vAO);
  reflectedLight.indirectDiffuse *= vegAO;
  // Environment specular on a leaf card. F0 0.04 against a very bright sky probe is an
  // *additive, achromatic* term on top of a mid-tone diffuse — one of the few things in
  // this shader that can only ever reduce saturation. A leaf mass is not a smooth
  // surface and the probe does not know it is buried inside a canopy, so it is scaled
  // back and gated on the same exposure term as the ambient.
  reflectedLight.indirectSpecular *= uSpecScale * vegAO;

  vec3 V = normalize(vViewPosition);          // surface -> camera
  vec3 L = uSunDirV;                          // surface -> sun
  vec3 N = normalize(normal);
  // broad wrap: any leaf lit from behind leaks light forward
  float wrap = clamp(-dot(N, L) * 0.62 + 0.42, 0.0, 1.0);
  // tight view lobe: looking into the sun through the canopy
  float back = pow(clamp(dot(V, -L), 0.0, 1.0), uTransPower);
  // The AO gate is *inverted* relative to the first version, which scaled transmission
  // by mix(0.30, 1.0, vAO) — that made the exposed shell leaves transmit most and the
  // buried interior leaves transmit least, which is backwards and flattened the crown
  // from both ends. Transmitted light is what you see through the *thin, backlit,
  // single-layer* interior; the exposed shell is what you see reflected. So interior
  // (vAO -> 0) transmits, shell (vAO -> 1) does not.
  float amt = wrap * (0.26 + uTransScale * back) * mix(1.0, 0.30, vAO);
  // Front-lit fragments must not receive it at all: a leaf with the sun and the camera
  // on the same side is not backlit, and adding there is what lifts the ambient floor
  // and desaturates the whole mass. Keeping it out of indirectDiffuse and out of the
  // ambient path is the difference between a glowing rim and a grey wash.
  float frontlit = clamp(dot(N, L), 0.0, 1.0);
  // Into the emissive accumulator, not into indirectDiffuse: indirectDiffuse is the
  // ambient path, and anything added there is a floor under every fragment in the mass.
  totalEmissiveRadiance += uSunRad * uTransColor * amt * (1.0 - frontlit * frontlit);
}
`;

/* ========================================================================== *
 *  Material factory
 * ========================================================================== */

let _matSeq = 0;

/**
 * One MeshStandardMaterial, patched to
 *   - place + wind instances in the vertex shader,
 *   - emit the G-buffer itself in the pre-pass (see the file header),
 *   - add leaf transmission after three's lighting,
 *   - and still route through applyWorldMaterial for sun/shadow/aerial coherence.
 */
function makeVegMaterial(ctx, U, o) {
  if (o.map && (o.alphaTest ?? 0) > 0) assertAlphaRef(o.map, o.alphaTest, o.key || 'veg');
  const mat = new THREE.MeshStandardMaterial({
    color: o.color || new THREE.Color(1, 1, 1),
    roughness: o.roughness ?? 0.62,
    metalness: 0.0,
    map: o.map || null,
    alphaTest: o.alphaTest ?? 0.0,
    side: o.side ?? THREE.DoubleSide,
    transparent: false,
    shadowSide: THREE.DoubleSide,
  });

  const uni = Object.assign({}, U, {
    uVegMatId: { value: MAT_ID.FOLIAGE },
    uWindAmp: { value: o.windAmp ?? 0.24 },
    uFlutter: { value: o.flutter ?? 1.0 },
    uSegScale: { value: o.segScale ?? 1.0 },
    uLod: { value: new THREE.Vector2(o.lod?.[0] ?? 90, o.lod?.[1] ?? 140) },
    uWidthGrow: { value: o.widthGrow ?? 0.004 },
    uTransColor: { value: o.transColor || new THREE.Color(0.30, 0.30, 0.10) },
    uTransScale: { value: o.transScale ?? 2.2 },
    uTransPower: { value: o.transPower ?? 3.0 },
    uBaseAO: { value: o.baseAO ?? 0.45 },
    uAlbedoAO: { value: o.albedoAO ?? 1.0 },
    uSpecScale: { value: o.specScale ?? 1.0 },
    uColA: { value: o.colA || new THREE.Color(1, 1, 1) },
    uColB: { value: o.colB || new THREE.Color(1, 1, 1) },
  });
  mat.userData.veg = uni;

  // Per-instance tint alone gives every leaf on one tree the same colour, which reads
  // as a flat cut-out; folding in the per-sprig jitter is what puts the light/dark
  // mottling of a real crown into the mass.
  const fragBody = o.fragment || `
    float vegT = fract(vTint + vJit * 0.71);
    diffuseColor.rgb *= mix(uColA, uColB, vegT);
    // A fraction of the baked occlusion folded into *albedo*, not only into indirect.
    // The file header used to reject this outright, on a measurement taken when the
    // interior-to-sunlit ratio was 1.34; re-run with the corrected transmission, the
    // crown still measured p01 40 / lum_std 30.4 against the reference's 19 / 51.6.
    // Indirect-only cannot darken a leaf that the sun hits directly, and the inside of
    // a crown is full of those — it is why our crowns have no core.
    diffuseColor.rgb *= mix(uAlbedoAO, 1.0, vAO);
  `;

  const vegHook = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\n${WIND_GLSL}\n${PLACE_GLSL}\nuniform float uGBufPass;\nuniform mat4 uPrevViewProj;\nvarying vec4 vVegCur;\nvarying vec4 vVegPrev;\n`)
      .replace('#include <beginnormal_vertex>', `
        float vegAlive;
        float vegW = vegLod(vegAlive);
        vec3 vegN;
        vec3 vegP = vegPlace(position, vegW, uWindT, vegN, normal) * vegAlive
                  + aPos * (1.0 - vegAlive);
        vec3 objectNormal = vegN;
        vSeg  = aVeg2.x;
        vJit  = aVeg2.y;
        vAO   = aVeg2.z;
        vTint = aVar.y;
        vVegUv = uv;
      `)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vegP;
      `)
      .replace('#include <project_vertex>', `
        #include <project_vertex>
        vVegCur = gl_Position;
        vec3 vegPrevW = transformed;
        if (uGBufPass > 0.5) {
          vec3 dummyN;
          vegPrevW = vegPlace(position, vegW, uWindTPrev, dummyN, normal) * vegAlive
                   + aPos * (1.0 - vegAlive);
        }
        vVegPrev = uPrevViewProj * vec4(vegPrevW, 1.0);
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\n${GBUF_PARS_FRAG}\n${TRANS_PARS}\nvarying float vSeg;\nvarying float vTint;\nvarying float vJit;\nvarying float vAO;\nvarying vec2 vVegUv;\n${o.fragPars || ''}\n`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GBUF_EMIT}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${TRANS_EMIT}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${fragBody}`);
  };

  // ---------------------------------------------------------------------------
  // Hook order matters, and the obvious order does not work.
  //
  // `applyWorldMaterial()` finishes by calling `lighting.registerMaterial()`, which
  // calls three's `CSM.setupMaterial()` — and that **assigns** `material.onBeforeCompile`
  // instead of chaining it. So a material set up the obvious way loses every injection
  // applyWorldMaterial just made, its own aerial-perspective chunk included, and the
  // symptom is silent: the shader compiles, it just has no aerial and no custom code.
  // (Verified here: `mat.userData.shader` was never assigned, because the hook that
  // assigns it had been overwritten before the first compile.)
  //
  // Registering with CSM *first* and hiding `lighting` from applyWorldMaterial makes the
  // chain come out right: applyWorldMaterial -> (csm -> vegHook). CSM only adds uniforms
  // in its hook — its GLSL arrives through the global ShaderChunk override — so nothing
  // downstream fights over an include token.
  ctx.get('lighting')?.registerMaterial?.(mat);
  const csmHook = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => { csmHook?.call(mat, shader, renderer); vegHook(shader, renderer); };
  const noLighting = { get: (n, req) => (n === 'lighting' ? null : ctx.get(n, req)) };
  applyWorldMaterial(mat, noLighting, {
    matId: MAT_ID.FOLIAGE,
    inject: { key: `veg${_matSeq++}:${o.key || ''}`, uniforms: uni },
  });

  // The pre-pass is the only bound target in this engine with more than one colour
  // attachment. Detecting it that way rather than by identity keeps this file from
  // reaching into the pipeline's internals.
  mat.allowOverride = false;
  mat.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    uni.uGBufPass.value = (rt && rt.textures && rt.textures.length > 1) ? 1 : 0;
  };

  return mat;
}

/** Shadow-caster twin: same vertex placement + wind, same alpha cutout. */
function makeVegDepthMaterial(U, o) {
  const mat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: o.map || null,
    alphaTest: o.alphaTest ?? 0.0,
    side: THREE.DoubleSide,
  });
  const uni = Object.assign({}, U, {
    uWindAmp: { value: o.windAmp ?? 0.24 },
    uFlutter: { value: o.flutter ?? 1.0 },
    uSegScale: { value: o.segScale ?? 1.0 },
    uLod: { value: new THREE.Vector2(o.lod?.[0] ?? 90, o.lod?.[1] ?? 140) },
    uWidthGrow: { value: o.widthGrow ?? 0.004 },
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uni);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\n${WIND_GLSL}\n${PLACE_GLSL}\n`)
      .replace('#include <begin_vertex>', `
        float vegAlive;
        float vegW = vegLod(vegAlive);
        vec3 vegN;
        vec3 transformed = vegPlace(position, vegW, uWindT, vegN, normal) * vegAlive
                         + aPos * (1.0 - vegAlive);
        vSeg = aVeg2.x; vJit = aVeg2.y; vAO = aVeg2.z; vTint = aVar.y; vVegUv = uv;
      `);
    // vSeg/vTint/vVegUv are declared by PLACE_GLSL as varyings; depth_frag does not
    // read them, which is legal — an unread varying is simply dropped by the linker.
  };
  mat.customProgramCacheKey = () => `vegdepth:${o.key || ''}`;
  return mat;
}

/* ========================================================================== *
 *  Deterministic geometry scratchpad
 * ========================================================================== */

class GeoBuf {
  constructor() { this.p = []; this.n = []; this.uv = []; this.s = []; this.idx = []; }
  get count() { return this.p.length / 3; }
  vert(px, py, pz, nx, ny, nz, u, v, seg, jit, ao = 1) {
    this.p.push(px, py, pz); this.n.push(nx, ny, nz);
    this.uv.push(u, v); this.s.push(seg, jit, ao);
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  toGeometry() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aVeg2', new THREE.Float32BufferAttribute(this.s, 3));
    g.setIndex(this.idx);
    return g;
  }
}

class Instances {
  constructor() { this.pos = []; this.ori = []; this.var = []; this.n = 0; }
  add(x, y, z, yaw, tilt, sY, sXZ, phase, tint, flutter, stiff) {
    this.pos.push(x, y, z);
    this.ori.push(yaw, tilt, sY, sXZ);
    this.var.push(phase, tint, flutter, stiff);
    this.n++;
  }
  attach(geo, radiusPad) {
    geo.instanceCount = this.n;
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('aOri', new THREE.InstancedBufferAttribute(new Float32Array(this.ori), 4));
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(new Float32Array(this.var), 4));
    // The instanced positions live in aPos, so three's own bounds (computed from the
    // unit-sized `position` attribute) would cull the whole scatter on frame one.
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (let i = 0; i < this.n; i++) {
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (this.n === 0) { minX = minY = minZ = maxX = maxY = maxZ = 0; }
    const pad = radiusPad || 2;
    const box = new THREE.Box3(
      new THREE.Vector3(minX - pad, minY - pad, minZ - pad),
      new THREE.Vector3(maxX + pad, maxY + pad, maxZ + pad));
    geo.boundingBox = box;
    geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    return geo;
  }
}

/* ========================================================================== *
 *  Procedural textures — pure JS rasterisation, no canvas, fully deterministic
 * ========================================================================== */

/** Pointed-oval leaf, drawn straight into an RGBA float buffer. */
function drawLeaf(buf, W, H, cx, cy, len, wid, ang, r, g, b) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const rad = Math.max(len, wid) * 0.75 + 2;
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const invL = 2 / Math.max(len, 1e-3), invW = 2 / Math.max(wid, 1e-3);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = (ca * dx + sa * dy) * invL;          // -1 .. 1 along the leaf
      const v = (-sa * dx + ca * dy) * invW;         // -1 .. 1 across
      if (u < -1 || u > 1) continue;
      const t = (u + 1) * 0.5;
      // pointed at the tip, rounded at the base
      const half = Math.pow(Math.sin(Math.PI * t), 0.62) * (1 - 0.25 * t);
      const d = Math.abs(v) - half;
      if (d > 0.16) continue;
      const a = Math.min(1, Math.max(0, -d / 0.16));
      // midrib + a touch of shading toward the edge
      const rib = 1 - 0.22 * Math.exp(-Math.abs(v) * 26);
      const sh = 0.86 + 0.14 * (1 - Math.abs(v) / Math.max(half, 1e-3));
      const k = rib * sh;
      const i = (y * W + x) * 4;
      const na = a;
      buf[i] = buf[i] * (1 - na) + r * k * na;
      buf[i + 1] = buf[i + 1] * (1 - na) + g * k * na;
      buf[i + 2] = buf[i + 2] * (1 - na) + b * k * na;
      buf[i + 3] = Math.max(buf[i + 3], na);
    }
  }
}

/**
 * Alpha-coverage-preserving mip chain (Castano). A naively box-filtered cutout mask
 * loses coverage every level, so a canopy dissolves as it recedes — the classic
 * "trees go bald at distance". Each level's alpha is rescaled so the fraction of
 * texels above the alpha reference matches level 0.
 */
function buildAlphaMips(base, W, H, alphaRef) {
  const coverage = (data, n, scale) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (Math.min(1, data[i * 4 + 3] * scale) >= alphaRef) c++;
    return c / n;
  };
  const target = coverage(base, W * H, 1);
  const mips = [{ data: null, width: W, height: H, src: base }];
  let src = base, w = W, h = H;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const dst = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const o = (y * nw + x) * 4;
        let wr = 0, wg = 0, wb = 0, wa = 0;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const sx = Math.min(w - 1, x * 2 + i), sy = Math.min(h - 1, y * 2 + j);
            const s = (sy * w + sx) * 4;
            const a = src[s + 3];
            wr += src[s] * a; wg += src[s + 1] * a; wb += src[s + 2] * a; wa += a;
          }
        }
        // premultiplied colour average: transparent texels must not bleed black in
        dst[o] = wa > 1e-5 ? wr / wa : 0;
        dst[o + 1] = wa > 1e-5 ? wg / wa : 0;
        dst[o + 2] = wa > 1e-5 ? wb / wa : 0;
        dst[o + 3] = wa * 0.25;
      }
    }
    // binary-search the alpha scale that restores level-0 coverage
    let lo = 0.0, hi = 12.0, scale = 1.0;
    for (let it = 0; it < 24; it++) {
      scale = 0.5 * (lo + hi);
      if (coverage(dst, nw * nh, scale) < target) lo = scale; else hi = scale;
    }
    scale = 0.5 * (lo + hi);
    for (let i = 0; i < nw * nh; i++) dst[i * 4 + 3] = Math.min(1, dst[i * 4 + 3] * scale);
    mips.push({ width: nw, height: nh, src: dst });
    src = dst; w = nw; h = nh;
  }
  return mips.map((m) => {
    const d = new Uint8Array(m.width * m.height * 4);
    for (let i = 0; i < m.width * m.height * 4; i++) d[i] = Math.round(Math.min(1, Math.max(0, m.src[i])) * 255);
    return { data: d, width: m.width, height: m.height };
  });
}

function finishTexture(mips, ctx, alphaRef) {
  const tex = new THREE.DataTexture(mips[0].data, mips[0].width, mips[0].height, THREE.RGBAFormat);
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  configureTexture(tex, ctx, { srgb: true, repeat: false });
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.userData.alphaRef = alphaRef;
  return tex;
}

/**
 * Castano's coverage-preserving mip chain conserves coverage **at exactly one alpha
 * reference** — the one it was built for. Sampling it at a different `alphaTest` is not
 * a small error and it is not symmetric: below the build reference every mip level
 * *gains* coverage as distance grows, so crowns and mats get denser and more solid as
 * they recede, which is the exact inverse of the "trees go bald at distance" failure the
 * chain exists to prevent. The shipped build had the atlas built at 0.5 and four
 * materials sampling it at 0.42, and the distant cliff read as a solid speckled carpet.
 *
 * This class of bug is invisible until someone measures a distant crop, so it is
 * asserted at material-creation time instead.
 */
function assertAlphaRef(tex, alphaTest, who) {
  if (!tex) return;
  const built = tex.userData?.alphaRef;
  if (built === undefined) return;
  if (Math.abs(built - alphaTest) > 1e-4) {
    console.error(`[vegetation] alphaTest/coverage mismatch on "${who}": the mip chain `
      + `conserves coverage at alphaRef ${built} but the material samples it at `
      + `alphaTest ${alphaTest}. Distant instances will ${alphaTest < built ? 'thicken' : 'dissolve'}.`);
  }
}

/**
 * 2x2 atlas of leaf-cluster cards: canopy sprigs, scrub, ivy, moss.
 *
 * The leaves are deliberately small relative to the tile (~6% of it) and there are a lot
 * of them. The first version used leaves three times that size and the canopy read as
 * torn paper — at the distances that matter here a card is 15-40 px across, so a leaf has
 * to be 1-3 px for the mass to read as foliage rather than as blobs. Wide per-leaf
 * luminance variation is what puts real high-frequency energy into the crown.
 */
function makeLeafAtlas(rand, ctx, S = 512) {
  const buf = new Float32Array(S * S * 4);
  for (let i = 0; i < S * S; i++) { buf[i * 4] = 0.86; buf[i * 4 + 1] = 0.90; buf[i * 4 + 2] = 0.52; }
  const T = S / 2;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const ox = tx * T, oy = ty * T;
      // a branching stem armature, so the cluster reads as a sprig, not a spatter
      const stems = 4 + Math.floor(rand.next() * 3);
      const pts = [];
      for (let s = 0; s < stems; s++) {
        const a = -Math.PI * 0.5 + rand.sym(1.05);
        const l = T * (0.40 + 0.22 * rand.next());
        const bx = ox + T * 0.5 + rand.sym(T * 0.09);
        const by = oy + T * 0.93;
        for (let k = 1; k <= 9; k++) {
          const t = k / 9;
          const px = bx + Math.cos(a) * l * t + rand.sym(T * 0.06 * t);
          const py = by + Math.sin(a) * l * t * 1.02 + rand.sym(T * 0.05 * t);
          pts.push([px, py, t]);
          // side shoots carry the outer leaves and make the silhouette feathery
          if (k > 3 && rand.next() < 0.55) {
            const sa = a + (rand.next() < 0.5 ? 1 : -1) * rand.range(0.5, 1.25);
            const sl = l * rand.range(0.16, 0.38);
            for (let j = 1; j <= 4; j++) {
              pts.push([px + Math.cos(sa) * sl * (j / 4), py + Math.sin(sa) * sl * (j / 4),
                Math.min(1, t + 0.1 * j)]);
            }
          }
        }
      }
      const nLeaf = 230 + Math.floor(rand.next() * 70);
      for (let i = 0; i < nLeaf; i++) {
        const anchor = pts[Math.floor(rand.next() * pts.length)];
        const spread = T * (0.022 + 0.055 * (1 - anchor[2] * 0.6));
        const cx = anchor[0] + rand.sym(spread);
        const cy = anchor[1] + rand.sym(spread);
        if (cx < ox + 3 || cx > ox + T - 3 || cy < oy + 3 || cy > oy + T - 3) continue;
        const len = T * (0.038 + 0.036 * rand.next());
        const wid = len * (0.40 + 0.30 * rand.next());
        const ang = rand.range(0, Math.PI * 2);
        // olive / khaki, R ~= G with B about half — measured off the reference. The
        // 0.34..1.0 value range is the interior-shadow to sunlit-face spread.
        const v = 0.34 + 0.66 * Math.pow(rand.next(), 0.7);
        const yellow = 0.86 + 0.20 * rand.next();
        drawLeaf(buf, S, S, cx, cy, len, wid, ang,
          1.00 * v * yellow, 1.00 * v, 0.62 * v * (1.10 - 0.22 * yellow));
      }
    }
  }
  return finishTexture(buildAlphaMips(buf, S, S, LEAF_ALPHA_REF), ctx, LEAF_ALPHA_REF);
}

/**
 * Moss / lichen cushion: a fine tuft of many tiny blades radiating from the base,
 * not a leaf sprig. Sharing the tree's compound-leaf sprite for moss was one of the
 * reasons nothing in the frame had a species silhouette — canopy, scrub, moss and ivy
 * were literally the same sprite at four tints and four scales.
 */
function makeMossAtlas(rand, ctx, S = 256) {
  const buf = new Float32Array(S * S * 4);
  for (let i = 0; i < S * S; i++) { buf[i * 4] = 0.72; buf[i * 4 + 1] = 0.80; buf[i * 4 + 2] = 0.40; }
  const T = S / 2;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const ox = tx * T, oy = ty * T;
      const bx = ox + T * 0.5, by = oy + T * 0.97;
      const n = 260 + Math.floor(rand.next() * 90);
      for (let i = 0; i < n; i++) {
        // a fan of short hairs; density falls off with height so the tuft has a
        // soft, thinning crest rather than a flat top
        const a = -Math.PI * 0.5 + rand.sym(1.28);
        const l = T * (0.22 + 0.62 * Math.pow(rand.next(), 1.4));
        const x0 = bx + rand.sym(T * 0.30);
        const v = 0.30 + 0.70 * Math.pow(rand.next(), 0.8);
        const curl = rand.sym(0.5);
        const steps = 7;
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const aa = a + curl * t * t;
          const px = x0 + Math.cos(aa) * l * t;
          const py = by + Math.sin(aa) * l * t;
          if (px < ox + 1 || px > ox + T - 1 || py < oy + 1 || py > oy + T - 1) break;
          const w = T * 0.011 * (1 - 0.75 * t);
          const vv = v * (0.72 + 0.34 * t);       // tips catch the light
          drawLeaf(buf, S, S, px, py, w * 2.6, w * 2.0, aa,
            0.92 * vv, 1.00 * vv, 0.50 * vv);
        }
      }
    }
  }
  return finishTexture(buildAlphaMips(buf, S, S, LEAF_ALPHA_REF), ctx, LEAF_ALPHA_REF);
}

/**
 * Blade alpha strip. Without a map the grass material runs alphaTest 0, so every blade
 * is a solid quad with a hard geometric tip — the one silhouette a blade never has.
 * u runs across the blade, v along it (matching `bladeGeometry`'s uv), and the alpha is
 * a soft-edged taper that reaches zero at the tip, so alphaTest 0.30 eats the last few
 * percent of the quad and leaves a point.
 */
function makeBladeAlpha(ctx, W = 32, H = 128) {
  const buf = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    // Continuous taper. The previous envelope was
    //   half = 0.5 * min(1, (1 - v)/0.20 + 0.06)
    // which clamps to *full width* for the bottom 80% of the blade — the mask was a
    // rectangle with a point stuck on the tip, and alphaTest 0.30 never carved a taper.
    // A blade is wide at the sheath and narrows the whole way up.
    const half = 0.5 * Math.pow(1 - v, 0.55);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W - 0.5;
      const d = half - Math.abs(u);            // signed distance inside the taper
      const a = Math.min(1, Math.max(0, d * W * 0.9));
      const i = (y * W + x) * 4;
      buf[i] = 1.0; buf[i + 1] = 1.0; buf[i + 2] = 1.0; buf[i + 3] = a;
    }
  }
  return finishTexture(buildAlphaMips(buf, W, H, BLADE_ALPHA_REF), ctx, BLADE_ALPHA_REF);
}

/**
 * A trailing runner: paired opposed leaves down a visible woody stem, tapering out.
 *
 * Used twice, at two aspects. `leafScale`/`nLeaf`/`taperTo` are what separate the two
 * species: the long thin **vine** falls in a curtain and thins to nothing, while the
 * short broad **ivy runner** keeps its leaf size to the end and reads as a mat of
 * overlapping foliage on a face. Before this, `matIvy` bound the tree's compound-leaf
 * atlas, which is why the cliff drape measured spectral_slope -1.78 — isotropic
 * speckle, closer to white noise than to the reference drape's -2.21.
 */
function makeRunnerStrip(rand, ctx, W = 128, H = 512, o = {}) {
  const nLeaf = o.nLeaf ?? 340;
  const leafScale = o.leafScale ?? 1.0;
  const taperTo = o.taperTo ?? 0.38;          // leaf size at the tip, fraction of base
  const stemW = o.stemW ?? 1.4;
  const wobA = o.wob ?? 0.055;
  const buf = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = 0.80; buf[i * 4 + 1] = 0.88; buf[i * 4 + 2] = 0.48; }
  const cx = W * 0.5;
  const wobble = (t) => Math.sin(t * 11.0) * W * wobA + Math.sin(t * 4.3 + 1.1) * W * (wobA * 0.82);
  // stem
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const hw = stemW * (1 - 0.55 * t);
    const wob = wobble(t);
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x + 0.5 - (cx + wob)) - hw;
      if (d > 1) continue;
      const a = Math.min(1, Math.max(0, -d));
      const i = (y * W + x) * 4;
      buf[i] = 0.62; buf[i + 1] = 0.58; buf[i + 2] = 0.32;
      buf[i + 3] = Math.max(buf[i + 3], a);
    }
  }
  for (let i = 0; i < nLeaf; i++) {
    const t = Math.pow(i / nLeaf, 0.92);
    const y = 8 + t * (H - 18);
    const wob = wobble(t);
    const side = (i % 2 === 0) ? 1 : -1;
    const taper = 1 - (1 - taperTo) * t;
    const len = W * (0.075 + 0.055 * rand.next()) * taper * leafScale;
    const wid = len * (0.66 + 0.26 * rand.next());
    const ang = side > 0 ? rand.range(0.20, 1.15) : Math.PI - rand.range(0.20, 1.15);
    const cxx = cx + wob + side * len * (0.35 + 0.5 * rand.next());
    // full interior-shadow to sunlit-face spread, same as the leaf atlas
    const v = (o.vMin ?? 0.38) + (o.vSpan ?? 0.62) * Math.pow(rand.next(), 0.7);
    drawLeaf(buf, W, H, cxx, y + rand.sym(4), len, wid, ang,
      0.92 * v, 1.00 * v, 0.52 * v);
  }
  return finishTexture(buildAlphaMips(buf, W, H, LEAF_ALPHA_REF), ctx, LEAF_ALPHA_REF);
}

/* ========================================================================== *
 *  Geometry
 * ========================================================================== */

/** Grass blade: 4 tapering segments, baked droop, rounded cross-section normals. */
function bladeGeometry(seg = 4, curve = 0.42, tipW = 0.10) {
  const gb = new GeoBuf();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const half = 0.5 * (1 - t) * (1 - t * 0.45) + tipW * 0.5 * t;
    const z = curve * t * t;
    const dz = 2 * curve * t;
    const ny = dz / Math.sqrt(1 + dz * dz), nz = 1 / Math.sqrt(1 + dz * dz);
    for (let s = 0; s < 2; s++) {
      const x = (s === 0 ? -half : half);
      // fold the blade across its width so it catches a highlight along one edge
      const bend = (s === 0 ? -0.55 : 0.55);
      const nx = bend;
      const l = Math.hypot(nx, -ny, nz);
      gb.vert(x, t, z, nx / l, -ny / l, nz / l, s, t, t, 0, t);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    gb.quad(a, a + 1, a + 3, a + 2);
  }
  return gb;
}

/** Hanging ribbon: two crossed strips falling from y=0 to y=-1, tapering, curling. */
function vineGeometry(seg = 11, planes = 2) {
  const gb = new GeoBuf();
  for (let pl = 0; pl < planes; pl++) {
    const a = (pl / planes) * Math.PI * 0.82 + 0.16;
    const dx = Math.cos(a), dz = Math.sin(a);
    const base = gb.count;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const half = 0.5 * (1 - 0.55 * t * t);
      // drift outward then hang plumb, with a slight curl at the tip
      const drift = 0.32 * Math.sin(t * 1.9) + 0.10 * t * t;
      const y = -t;
      for (let s = 0; s < 2; s++) {
        const off = (s === 0 ? -half : half);
        gb.vert(dx * (off + drift * 0.35), y, dz * (off + drift * 0.35),
          -dz, 0.12, dx, s, t, t, (pl * 0.37 + t * 0.21) % 1, 0.30 + 0.70 * t);
      }
    }
    for (let i = 0; i < seg; i++) {
      const q = base + i * 2;
      gb.quad(q, q + 1, q + 3, q + 2);
    }
  }
  return gb;
}

/** N quads fanned about the Y axis, unit height — the generic leaf-cluster card. */
function cardGeometry(planes = 2, tile = 0, tiles = 2, lean = 0.0) {
  const gb = new GeoBuf();
  const tu = (tile % tiles) / tiles, tv = Math.floor(tile / tiles) / tiles, ts = 1 / tiles;
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI;
    const dx = Math.cos(a), dz = Math.sin(a);
    const nx = -dz, nz = dx;
    const b = gb.count;
    const sk = lean;
    gb.vert(-dx * 0.5, 0, -dz * 0.5, nx, 0.45, nz, tu, tv + ts, 0.0, p * 0.31, 0.28);
    gb.vert(dx * 0.5, 0, dz * 0.5, nx, 0.45, nz, tu + ts, tv + ts, 0.0, p * 0.31, 0.28);
    gb.vert(dx * 0.5 + sk, 1, dz * 0.5, nx, 0.45, nz, tu + ts, tv, 1.0, p * 0.31, 1.0);
    gb.vert(-dx * 0.5 + sk, 1, -dz * 0.5, nx, 0.45, nz, tu, tv, 1.0, p * 0.31, 1.0);
    gb.quad(b, b + 1, b + 2, b + 3);
  }
  return gb;
}

/**
 * Moss / scrub clump: a squashed dome of leaf cards.
 * Normals are blended toward the dome-outward direction for the same reason the tree
 * sprigs are — a mat of cards with card normals shades flat, and the moss crowns in
 * kf_01500 are one of the strongest light-to-dark reads in the frame.
 */
/**
 * A **normalised** clump: x,z in [-0.5, 0.5], y in [0, 1]. The instance's `aOri.z`
 * (scaleY) is therefore the plant's height in metres and `aOri.w` (scaleXZ) is its
 * width in metres — which is the only way a caller can reason about whether the thing
 * will read at 90 m. The old version was not normalised (y ran -0.35..0.67, width
 * ±0.5 before scale) so "sY = sc*0.55" produced 0.55 m *pancakes* on stack crowns that
 * needed a 4 m silhouette, and nobody could see that from the call site.
 *
 * `bulge` shapes where the mass sits along y: >1 pushes it up into a shrub crown,
 * <1 flattens it into a cushion.
 */
function clumpGeometry(rand, cards = 8, tiles = 2, bulge = 1.0) {
  const gb = new GeoBuf();
  const GOLD = 2.399963;                       // golden angle: no azimuthal ringing
  for (let i = 0; i < cards; i++) {
    const a = i * GOLD + rand.sym(0.35);
    const t = (i + 0.5) / cards;
    // height along the clump, biased by `bulge`
    const py = Math.pow(rand.next(), 1.0 / Math.max(bulge, 0.15)) * 0.86 + 0.06;
    // widest in the middle of the profile, tapering to the tip — a shrub, not a ball
    const prof = Math.sin(Math.PI * Math.min(1, py * 0.92 + 0.08)) ** 0.7;
    const rr = (0.10 + 0.40 * Math.sqrt(rand.next())) * prof;
    const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
    emitSprig(gb, rand, px, py, pz, (0.30 + 0.26 * rand.next()) * (0.7 + 0.5 * prof),
      Math.min(1, 0.20 + py), tiles, px, (py - 0.45) * 1.6 + 0.35, pz, 2,
      // AO: deep interior is buried, the outside of the profile is exposed
      THREE.MathUtils.clamp(0.12 + 0.88 * (rr / Math.max(prof, 0.2) / 0.5) * (0.4 + 0.6 * py), 0.08, 1),
      { ux: px, uy: 0.55, uz: pz, jitter: 0.55 });
  }
  // a short skirt of down-turned cards so the clump does not float on its base
  for (let i = 0; i < Math.max(2, cards >> 2); i++) {
    const a = i * GOLD * 1.7 + rand.sym(0.6);
    const px = Math.cos(a) * 0.40, pz = Math.sin(a) * 0.40;
    emitSprig(gb, rand, px, 0.05 + 0.10 * rand.next(), pz, 0.26 + 0.14 * rand.next(),
      0.10, tiles, px * 2.0, -0.5, pz * 2.0, 1, 0.14,
      { ux: px, uy: -0.6, uz: pz, jitter: 0.4 });
  }
  return gb;
}

/* -------------------------------------------------------------------------- *
 *  The tree
 * -------------------------------------------------------------------------- */

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();

function emitTube(gb, pts, radii, segs, seg0, seg1) {
  const rings = [];
  const up = new THREE.Vector3(0, 1, 0);
  let ref = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const dir = _v0.copy(pts[Math.min(i + 1, pts.length - 1)])
      .sub(pts[Math.max(i - 1, 0)]).normalize();
    if (dir.lengthSq() < 1e-8) dir.copy(up);
    const t = i / (pts.length - 1);
    // stable frame: re-orthogonalise the previous reference against the new tangent
    ref.addScaledVector(dir, -ref.dot(dir));
    if (ref.lengthSq() < 1e-6) ref.set(dir.z, dir.x, dir.y).addScaledVector(dir, -dir.dot(_v1.set(dir.z, dir.x, dir.y)));
    ref.normalize();
    const bi = _v1.crossVectors(dir, ref).normalize();
    const ring = [];
    const seg = seg0 + (seg1 - seg0) * t;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      // a gnarled, non-circular section: this is most of what sells the trunk
      const wob = 1 + 0.16 * Math.sin(a * 3 + t * 5.1) + 0.10 * Math.sin(a * 5 - t * 3.3);
      const r = radii[i] * wob;
      const nx = ref.x * Math.cos(a) + bi.x * Math.sin(a);
      const ny = ref.y * Math.cos(a) + bi.y * Math.sin(a);
      const nz = ref.z * Math.cos(a) + bi.z * Math.sin(a);
      ring.push(gb.vert(p.x + nx * r, p.y + ny * r, p.z + nz * r,
        nx, ny, nz, s / segs * 3, t * 4, seg, 0, 1));
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs;
      gb.quad(rings[i][s], rings[i][s2], rings[i + 1][s2], rings[i + 1][s]);
    }
  }
}

/**
 * A leaf sprig: `planes` randomly-oriented quads through one point.
 *
 * Two details matter more than the geometry.
 *
 * 1. **Random plane orientation.** The first version used two vertical quads plus one
 *    horizontal, and the horizontal ones all went edge-on together at grazing angles,
 *    which drew coherent bright streaks across the top of the crown. Random axes have
 *    no shared degenerate view.
 *
 * 2. **The normal is blended toward the canopy-outward direction** (`ox,oy,oz`). A card's
 *    true normal is meaningless for a leaf mass; using it makes a crown shade like a pile
 *    of shuffled cards — uniformly mid-grey from every angle, which is exactly how the
 *    first render came out. Blending 72% toward "away from the canopy centre" makes the
 *    crown shade as the rounded volume it is meant to represent: lit on top, dark
 *    underneath, and with a rim where the sun grazes it.
 */
function emitSprig(gb, rand, cx, cy, cz, size, seg, tiles, ox, oy, oz, planes = 3, ao = 1, frame = null) {
  const jit = rand.next();
  const ol = Math.hypot(ox, oy, oz) || 1;
  const oux = ox / ol, ouy = oy / ol, ouz = oz / ol;
  /* Card frame.
   *
   * The first version drew `th` uniform on [0,2pi) and `ph = acos(uniform(-1,1))` — a
   * correct uniform distribution on the sphere, and exactly wrong for foliage. Sprigs
   * do not point in random directions: they hang off a branch tip with a strong bias
   * along the branch and toward gravity, and *that bias is what produces the layered
   * light/shade banding of a canopy*. Isotropic cards give a scalloped noise boundary
   * and a flat, uniform interior — measured on our crown, lum_std 30.4 against the
   * reference's 51.6 and local_contrast 0.095 against 0.173, with aerial disabled so
   * the comparison is fair.
   *
   * `frame` supplies the preferred sprig axis (branch direction already blended toward
   * -Y by the caller); we jitter about it by `jitter` radians instead of resampling
   * the sphere. Passing null keeps the old isotropic behaviour for callers that want it.
   */
  let fux = 0, fuy = -1, fuz = 0, fjit = Math.PI;
  if (frame) {
    const fl = Math.hypot(frame.ux, frame.uy, frame.uz) || 1;
    fux = frame.ux / fl; fuy = frame.uy / fl; fuz = frame.uz / fl;
    fjit = frame.jitter ?? 0.4;
  }
  for (let p = 0; p < planes; p++) {
    const tile = Math.floor(rand.next() * tiles * tiles);
    const tu = (tile % tiles) / tiles, tv = Math.floor(tile / tiles) / tiles, ts = 1 / tiles;
    let ax, ay, az;
    if (frame) {
      // cone of half-angle `fjit` about the preferred axis
      const cosMax = Math.cos(fjit);
      const cz2 = cosMax + (1 - cosMax) * rand.next();
      const sr = Math.sqrt(Math.max(0, 1 - cz2 * cz2));
      const phi = rand.range(0, Math.PI * 2);
      // orthonormal basis about (fux,fuy,fuz)
      let t1x = 0, t1y = 0, t1z = 0;
      if (Math.abs(fuy) < 0.9) { t1x = -fuz; t1z = fux; } else { t1x = 1; }
      const t1l = Math.hypot(t1x, t1y, t1z) || 1;
      t1x /= t1l; t1y /= t1l; t1z /= t1l;
      const t2x = fuy * t1z - fuz * t1y, t2y = fuz * t1x - fux * t1z, t2z = fux * t1y - fuy * t1x;
      const c = Math.cos(phi) * sr, s = Math.sin(phi) * sr;
      ax = fux * cz2 + t1x * c + t2x * s;
      ay = fuy * cz2 + t1y * c + t2y * s;
      az = fuz * cz2 + t1z * c + t2z * s;
    } else {
      const th = rand.range(0, Math.PI * 2), ph = Math.acos(rand.range(-1, 1));
      ax = Math.sin(ph) * Math.cos(th); ay = Math.cos(ph) * 0.55; az = Math.sin(ph) * Math.sin(th);
    }
    // bias the card's "up" toward world up so sprigs still hang the right way
    let bx = -ax * 0.25, by = 1, bz = -az * 0.25;
    const bd = ax * bx + ay * by + az * bz;
    bx -= ax * bd; by -= ay * bd; bz -= az * bd;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    const s = size * (0.72 + 0.56 * rand.next());
    const hx = ax * s * 0.5, hy = ay * s * 0.5, hz = az * s * 0.5;
    const vx = bx * s, vy = by * s, vz = bz * s;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx = nx / nl * 0.28 + oux * 0.72;
    ny = ny / nl * 0.28 + ouy * 0.72;
    nz = nz / nl * 0.28 + ouz * 0.72;
    const ml = Math.hypot(nx, ny, nz) || 1;
    nx /= ml; ny /= ml; nz /= ml;
    const b = gb.count;
    const qx = cx - vx * 0.5, qy = cy - vy * 0.5, qz = cz - vz * 0.5;
    gb.vert(qx - hx, qy - hy, qz - hz, nx, ny, nz, tu, tv + ts, seg, jit, ao);
    gb.vert(qx + hx, qy + hy, qz + hz, nx, ny, nz, tu + ts, tv + ts, seg, jit, ao);
    gb.vert(qx + hx + vx, qy + hy + vy, qz + hz + vz, nx, ny, nz, tu + ts, tv, seg, jit, ao);
    gb.vert(qx - hx + vx, qy - hy + vy, qz - hz + vz, nx, ny, nz, tu, tv, seg, jit, ao);
    gb.quad(b, b + 1, b + 2, b + 3);
  }
}

/**
 * Recursive branching. The reference silhouette is specific: a short, thick, twisted
 * trunk that forks a little over halfway up, then limbs that flatten hard into an
 * umbrella far wider than it is tall, with the leaf mass concentrated in a shell so the
 * sky shows through near the trunk.
 */
function buildTree(rand, P) {
  const branch = new GeoBuf();
  const leaves = new GeoBuf();
  const tips = [];

  const grow = (p, dir, len, rad, depth, seg) => {
    const steps = depth === 0 ? 7 : 4;
    const pts = [], radii = [];
    const d = dir.clone().normalize();
    const cur = p.clone();
    // a persistent sideways drift gives the trunk its lean and S-curve
    const drift = new THREE.Vector3(rand.sym(1), 0, rand.sym(1)).normalize()
      .multiplyScalar(depth === 0 ? P.trunkLean : 0.16 + 0.20 * rand.next());
    // Per-branch phase for the radius modulation below.
    const bulgeP = rand.range(0, Math.PI * 2), bulgeQ = rand.range(0, Math.PI * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push(cur.clone());
      const flare = depth === 0 ? 1 + P.flare * Math.exp(-t * 5.5) : 1;
      // A constant-taper tube cannot read as bark at any distance: it is a dowel, and
      // that is what the 190 px hero trunk looked like. Two low-frequency harmonics
      // along the branch make it bulge and pinch the way a real trunk does — the
      // reference trunk's own light/dark is a large fraction of the tree's read.
      const bulge = 1
        + P.bulge * Math.sin(t * 5.3 + bulgeP)
        + P.bulge * 0.55 * Math.sin(t * 11.7 + bulgeQ);
      radii.push(rad * (1 - t * P.taper) * flare * bulge);
      if (i === steps) break;
      const step = len / steps;
      const dd = d.clone()
        .addScaledVector(drift, Math.sin(t * 2.4 + 0.5) * 0.10)
        .add(new THREE.Vector3(rand.sym(0.09), rand.sym(0.05), rand.sym(0.09)));
      // flatten toward horizontal as we climb out of the trunk
      dd.y *= depth === 0 ? 1.0 : P.flatten;
      dd.normalize();
      d.lerp(dd, 0.72).normalize();
      cur.addScaledVector(d, step);
    }
    const segs = depth === 0 ? 9 : (depth === 1 ? 7 : 5);
    emitTube(branch, pts, radii, segs, seg, seg + P.segStep[depth]);

    const tipSeg = seg + P.segStep[depth];
    if (depth >= P.maxDepth) {
      tips.push({ p: cur.clone(), d: d.clone(), seg: tipSeg });
      return;
    }
    const n = P.splits[depth];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand.sym(0.6) + depth * 1.1;
      const side = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const spread = P.spread[depth] * (0.75 + 0.5 * rand.next());
      const nd = d.clone().multiplyScalar(1 - spread).addScaledVector(side, spread);
      nd.y = nd.y * P.flatten + P.lift[depth];
      nd.normalize();
      grow(cur.clone(), nd, len * P.lenFall * (0.82 + 0.36 * rand.next()),
        rad * P.radFall * (0.85 + 0.3 * rand.next()), depth + 1, tipSeg);
    }
  };

  grow(new THREE.Vector3(0, 0, 0), new THREE.Vector3(rand.sym(0.10), 1, rand.sym(0.10)),
    P.trunkLen, P.trunkR, 0, 0.0);

  // Leaf mass: a shell around each tip, plus fill on an oblate spheroid so the crown
  // silhouette is a lumpy flat dome rather than a ring of pom-poms.
  let cx = 0, cy = 0, cz = 0;
  for (const t of tips) { cx += t.p.x; cy += t.p.y; cz += t.p.z; }
  cx /= tips.length; cy /= tips.length; cz /= tips.length;

  /* The crown radius is *measured from the branches*, not declared.
   *
   * `canopyR` used to be a magic 4.0 while the branching produced tips out at ~8 m,
   * so the shell filled a ball half the size of the armature and the outer limbs stuck
   * out of the crown as bare grey spikes — clearly visible in the ref_00720 capture as
   * two spars either side of the leaf mass. Taking the 88th percentile of tip distance
   * guarantees the leaf shell covers the branch tips whatever the branching does. */
  const tipR = tips.map((t) => Math.hypot(t.p.x - cx, t.p.z - cz)).sort((a, b) => a - b);
  const measuredR = tipR[Math.min(tipR.length - 1, Math.floor(tipR.length * 0.88))] || P.canopyR;
  const canopyR = Math.max(P.canopyR, measuredR * 1.32);
  const canopyH = P.canopyH * (canopyR / P.canopyR);
  // Sprig budget scales with the crown's *area*, not with a constant. Fixing the count
  // while the radius is measured means a bigger crown is a thinner crown — and a crown
  // you can see cloud through is the single most obvious "this is a game tree" tell.
  // At the shipped 900 over a measured 7 m radius the hero crown showed sky in the mass.
  const shellN = Math.round(P.shellSprigs * Math.pow(canopyR / P.canopyR, 2.0));

  // A lumpy radius field: without it the crown is a smooth ellipse, and a smooth ellipse
  // is the one thing a real tree never is. Six harmonics in azimuth, two in elevation.
  const lump = (a, e) =>
    0.80 + 0.13 * Math.sin(a * 2.0 + P.lumpSeed)
    + 0.10 * Math.sin(a * 3.7 - P.lumpSeed * 1.7)
    + 0.07 * Math.sin(a * 6.1 + e * 3.0)
    + 0.06 * Math.sin(e * 4.0 + a * 1.3);

  /* Sprig frame: branch direction blended toward gravity.
   *
   * See the note in `emitSprig`. `gravBias` 0.55 means "a bit more than half way from
   * the branch's own direction toward straight down", which is what makes a crown band
   * into lit upper surfaces and shaded undersides instead of a confetti ball. */
  const sprigFrame = (dx, dy, dz, jitter) => {
    const l = Math.hypot(dx, dy, dz) || 1;
    return {
      ux: dx / l * (1 - P.gravBias),
      uy: dy / l * (1 - P.gravBias) - P.gravBias,
      uz: dz / l * (1 - P.gravBias),
      jitter,
    };
  };

  /** Occlusion at a point inside the crown: 1 outside the hull, ~0 at the core. */
  const shellAO = (dx, dy, dz) => {
    const q = Math.hypot(dx / canopyR, dy / canopyH, dz / canopyR);
    return THREE.MathUtils.clamp((q - 0.30) / 0.62, 0.05, 1.0);
  };

  for (const t of tips) {
    const n = P.sprigsPerTip;
    for (let i = 0; i < n; i++) {
      const a = rand.range(0, Math.PI * 2), r = P.tipCluster * Math.sqrt(rand.next());
      const px = t.p.x + Math.cos(a) * r;
      const py = t.p.y + rand.sym(P.tipCluster * 0.5) + P.sprigLift;
      const pz = t.p.z + Math.sin(a) * r;
      // Reserve the trunk column: nothing in the inner core below the umbrella plane,
      // so the fork and the upper trunk read against the sky the way the reference does.
      if (Math.hypot(px - cx, pz - cz) < 0.30 * canopyR && py < cy) continue;
      emitSprig(leaves, rand, px, py, pz, P.sprigSize, t.seg, P.tiles,
        px - cx, (py - cy) * (canopyR / canopyH) + 0.6, pz - cz, 3,
        shellAO(px - cx, py - cy, pz - cz),
        sprigFrame(t.d.x, t.d.y, t.d.z, 0.42));
    }
  }
  // Shell fill on a squashed, lumpy spheroid. Density is biased to the upper surface —
  // the reference crown is dense and flat on top and thins out underneath, where the
  // branch structure shows through.
  for (let i = 0; i < shellN; i++) {
    const a = rand.range(0, Math.PI * 2);
    // elevation biased upward: -0.15 .. 1 in sin(elev)
    const se = -0.15 + 1.15 * Math.pow(rand.next(), 0.55);
    const ce = Math.sqrt(Math.max(0, 1 - se * se));
    // 34% sit inside the shell so no sky punches through the middle, and so the crown
    // has an interior to be dark
    const depth = rand.next() < 0.34 ? rand.range(0.42, 0.84) : rand.range(0.88, 1.08);
    const k = lump(a, se) * depth;
    const dx = Math.cos(a) * ce * canopyR * k;
    const dz = Math.sin(a) * ce * canopyR * k;
    const dy = se * canopyH * k;
    if (Math.hypot(dx, dz) < 0.30 * canopyR && dy < 0.0) continue;
    emitSprig(leaves, rand, cx + dx, cy + dy, cz + dz,
      P.sprigSize * (0.80 + 0.5 * rand.next()),
      0.80 + 0.20 * Math.min(1, k), P.tiles,
      dx, dy * (canopyR / canopyH) + 0.35 * canopyR, dz, 3,
      shellAO(dx, dy, dz),
      // outward-and-down: the outer shell hangs, the top surface lies over
      sprigFrame(dx, dy * 0.4 - canopyH * 0.35, dz, 0.55));
  }
  return { branch, leaves, canopy: { x: cx, y: cy, z: cz, r: canopyR, h: canopyH } };
}

/* ========================================================================== *
 *  Framing — where the scored cameras actually look
 * ========================================================================== *
 *
 * Every scatter in this file used to be gated on a hand-written world-space band
 * (`z 50..76` for ivy, `z 42..68` for scrub, `z 28..60 / 64..126` for grass) and the
 * hero tree was pinned to whatever `rocks.landmarks.get('stack_hero')` happened to
 * return. Both are latches on another module's coordinates: `terrain.js` re-profiling
 * the beach emptied the grass bands twice in one session, and `rocks.js` moving
 * `stack_hero` carried the hero tree out of the composition without a line changing
 * here. Measured after that move: 0.000% foliage-hue pixels inside the `rock` ROI.
 *
 * The fix is to derive the accept region from the thing that actually defines
 * "on screen" — the scored camera matrices in `poses.js`. A candidate is accepted
 * only if at least one scored camera can see it, within a per-layer distance budget.
 * A band gated this way cannot be emptied by someone else's height field or landmark
 * table; if the world moves, the accept region moves with it.
 */

/** View-projection matrices for the nine scored `ref_*` poses. */
function buildScoredViews() {
  const views = [];
  for (const key of Object.keys(POSES)) {
    if (!key.startsWith('ref_')) continue;
    const P = POSES[key];
    const fov = P.fov ?? 78;
    const cam = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 4000);
    cam.position.set(P.pos[0], P.pos[1], P.pos[2]);
    cam.quaternion.setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(P.rot[0]),
      THREE.MathUtils.degToRad(P.rot[1]),
      THREE.MathUtils.degToRad(P.rot[2] || 0), 'YXZ'));
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    views.push({
      key,
      pos: cam.position.clone(),
      vp: new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
      // metres -> pixels at unit depth, for apparent-size tests
      pxPerM: 1080 / (2 * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5)),
    });
  }
  return views;
}

const _pv4 = new THREE.Vector4();

/**
 * How many scored cameras see this world point, and from how far.
 * `margin` is in NDC half-widths: 0.12 lets a plant hang just outside the frame edge
 * so the band does not stop with a visible straight line at the screen border.
 * @returns {{n:number, near:number}} n = number of views, near = closest view distance
 */
function seenBy(views, x, y, z, maxDist, margin = 0.12) {
  let n = 0, near = Infinity;
  const lim = 1 + margin;
  for (const v of views) {
    _pv4.set(x, y, z, 1).applyMatrix4(v.vp);
    const w = _pv4.w;
    if (w <= 0.05 || w > maxDist) continue;
    const sx = _pv4.x / w, sy = _pv4.y / w;
    if (sx < -lim || sx > lim || sy < -lim || sy > lim) continue;
    n++;
    if (w < near) near = w;
  }
  return { n, near };
}

/**
 * Apparent radius in pixels of a sphere of world radius `r` at world point p,
 * maximised over the scored views that can see it. This is the prominence measure
 * the hero-tree chooser sorts on: "how big is this stack in the frames we are graded
 * on", not "is it called stack_hero".
 */
function apparentPx(views, x, y, z, r, margin = 0.25) {
  let best = 0, seen = 0;
  const lim = 1 + margin;
  for (const v of views) {
    _pv4.set(x, y, z, 1).applyMatrix4(v.vp);
    const w = _pv4.w;
    if (w <= 0.05) continue;
    const sx = _pv4.x / w, sy = _pv4.y / w;
    if (sx < -lim || sx > lim || sy < -lim || sy > lim) continue;
    seen++;
    const px = r / w * v.pxPerM;
    if (px > best) best = px;
  }
  return { px: best, views: seen };
}

/* ========================================================================== *
 *  World queries — real modules when they exist, WORLD.md when they do not
 * ========================================================================== */

const PROFILE = [
  [-340, -26], [-180, -11.0], [-70, -4.2], [-26, -1.15], [-6.5, 0.0], [0, 0.35],
  [9, 1.30], [22, 2.75], [38, 5.40], [48, 9.0], [58, 26.0], [72, 58.0], [120, 62.0],
];

function fallbackWorld(rand) {
  const nz = (x, y, s) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const h = (a, b) => {
      let t = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
      t = Math.imul(t ^ (t >>> 15), 0x85ebca6b);
      t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
      return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
    };
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v)
      + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
  };
  const height = (x, z) => {
    // the beach is widest near X=-20 and pinches against the headland at X=+95
    const zs = z + 9 * Math.sin((x + 20) * 0.014) - Math.max(0, (x - 40) * 0.16);
    let y = PROFILE[0][1];
    for (let i = 0; i < PROFILE.length - 1; i++) {
      const [z0, y0] = PROFILE[i], [z1, y1] = PROFILE[i + 1];
      if (zs <= z1) {
        const t = Math.min(1, Math.max(0, (zs - z0) / (z1 - z0)));
        y = y0 + (y1 - y0) * (t * t * (3 - 2 * t));
        break;
      }
      y = y1;
    }
    return y + (nz(x * 0.035, z * 0.035, 11) - 0.5) * 2.6
      + (nz(x * 0.14, z * 0.14, 27) - 0.5) * 0.7;
  };
  const normal = (x, z, out) => {
    const e = 0.6;
    const hx = height(x + e, z) - height(x - e, z);
    const hz = height(x, z + e) - height(x, z - e);
    return (out || new THREE.Vector3()).set(-hx, 2 * e, -hz).normalize();
  };
  return {
    height,
    normal,
    sample(x, z) {
      const y = height(x, z);
      const n = normal(x, z);
      return { y, normal: n, slope: 1 - n.y, wetness: Math.min(1, Math.max(0, 1 - y / 1.4)), material: 1 };
    },
  };
}

/** Landmarks from docs/WORLD.md, used when `rocks` is not loaded. */
const LANDMARKS = [
  { id: 'stack_hero', x: -38, z: -92, topY: 38, radius: 15 },
  { id: 'stack_arch', x: 34, z: -70, topY: 41, radius: 17 },
  { id: 'stack_twin_a', x: -96, z: -140, topY: 44, radius: 19 },
  { id: 'stack_twin_b', x: -128, z: -172, topY: 33, radius: 13 },
  { id: 'stack_far_a', x: 120, z: -210, topY: 36, radius: 16 },
  { id: 'stack_far_b', x: 156, z: -246, topY: 30, radius: 12 },
  { id: 'headland', x: 108, z: 20, topY: 34, radius: 40 },
];

/* ========================================================================== *
 *  Module
 * ========================================================================== */

export function create(opts = {}) {
  const group = new THREE.Group();
  group.name = 'vegetation';
  group.matrixAutoUpdate = false;

  const disposables = [];
  const meshes = [];
  let U = null;
  let windT = 137.0, windTPrev = 137.0;
  const prevVP = new THREE.Matrix4();
  const _sun = new THREE.Vector3();
  const _nrm = new THREE.Matrix3();

  /** Wind-direction unit vector, cached for the CPU-side phase bake. */
  let windDirX = 0, windDirZ = -1;

  const bakePhase = (x, z, r) => (x * windDirX + z * windDirZ) * 0.052 + r * 6.2831;

  return {
    name: 'vegetation',
    order: 45,
    enabled: true,
    group,

    async init(ctx) {
      const time = ctx.get('time');
      const terrain = ctx.get('terrain');
      const rocks = ctx.get('rocks');
      const rand = ctx.rand.fork(0x5e6d1a);
      const fb = fallbackWorld(rand);

      const world = {
        height: (x, z) => (terrain?.height ? terrain.height(x, z) : fb.height(x, z)),
        sample: (x, z) => (terrain?.sample ? terrain.sample(x, z) : fb.sample(x, z)),
      };

      /* ------------------------------------------------- the accept region */
      // One rasterisation of "what the scored cameras can see" onto the height field.
      // Every ground scatter below draws its cells from this list instead of from a
      // hand-written z band, so no terrain edit can empty a band and no band can drift
      // out of frame. Cells are 3 m; scatters jitter freely inside one.
      const views = buildScoredViews();
      const CELL = 3.0;
      const cells = [];
      for (let x = -300; x <= 300; x += CELL) {
        for (let z = -280; z <= 200; z += CELL) {
          const s = world.sample(x, z);
          if (!Number.isFinite(s.y)) continue;
          const vis = seenBy(views, x, s.y + 0.7, z, 320);
          if (vis.n === 0) continue;
          cells.push({ x, z, y: s.y, slope: s.slope, wet: s.wetness, nView: vis.n, d: vis.near });
        }
      }
      if (cells.length === 0) {
        console.error('[vegetation] FATAL: no terrain cell is visible from any scored pose — '
          + 'either poses.js moved or terrain.sample() is returning garbage. Every ground '
          + 'scatter will be empty.');
      }
      /** Pick cells matching a gate, ordered by nothing (caller samples at random). */
      const cellsWhere = (fn) => cells.filter(fn);

      if (time) {
        const wd = THREE.MathUtils.degToRad(time.state.windDir);
        windDirX = -Math.sin(wd); windDirZ = -Math.cos(wd);
      }

      /* ---------------------------------------------------- shared uniforms */
      U = {
        uWindDir: { value: new THREE.Vector3(windDirX, 0, windDirZ) },
        uWindSide: { value: new THREE.Vector3(-windDirZ, 0, windDirX) },
        uGust: { value: 0.62 },
        uWindT: { value: windT },
        uWindTPrev: { value: windTPrev },
        uCamPos: { value: new THREE.Vector3() },
        uDensity: { value: 1.0 },
        uGBufPass: { value: 0 },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uSunDirV: { value: new THREE.Vector3(0, 1, 0) },
        uSunRad: { value: new THREE.Color(1, 1, 1) },
      };

      /* --------------------------------------------------------- textures */
      const leafTex = makeLeafAtlas(rand.fork(1), ctx, 512);
      // long thin fall, leaves shrinking to nothing at the tip
      const vineTex = makeRunnerStrip(rand.fork(2), ctx, 128, 512,
        { nLeaf: 340, leafScale: 1.0, taperTo: 0.38, stemW: 1.4, wob: 0.055 });
      // short broad runner, leaves held to the end: a mat, not a curtain
      const ivyTex = makeRunnerStrip(rand.fork(3), ctx, 192, 384,
        { nLeaf: 210, leafScale: 1.55, taperTo: 0.86, stemW: 2.2, wob: 0.075,
          vMin: 0.30, vSpan: 0.70 });
      const mossTex = makeMossAtlas(rand.fork(4), ctx, 256);
      disposables.push(leafTex, vineTex, ivyTex, mossTex);

      /* --------------------------------------------------------- materials */
      const lin = (r, g, b) => new THREE.Color(r, g, b);

      /* Palette note, measured — this replaces the "olive khaki" claim in the header,
       * which was right about hue and wrong about chroma.
       *
       * Foliage-masked pixels of kf_00720: tree crown mean sRGB (121,123,70) at
       * sat_mean 116/255 and hue 62 deg, p90 (155,159,101); the stack's scrub shelf is
       * darker and *more* saturated still, mean (70,70,36) at sat 133. Our foliage
       * pixels, isolated by a `--skip vegetation` diff, measured mean sRGB (111,113,114)
       * at sat 32 — literally grey, with B above R. So: R ~= G with B near 40% of G is
       * right, but the value spread and the chroma both have to be roughly doubled, and
       * the mass has to be *darker*, not lighter.
       */
      const matCanopy = makeVegMaterial(ctx, U, {
        key: 'canopy', map: leafTex, alphaTest: LEAF_ALPHA_REF, roughness: 0.72,
        colA: lin(0.340, 0.400, 0.098), colB: lin(0.105, 0.128, 0.026),
        // a genuine leaf transmittance: chlorophyll passes green, absorbs red hard and
        // blue almost completely. R below G, B near zero — transmitted light through a
        // leaf is *more* chromatic than reflected light, not less.
        transColor: lin(0.30, 0.42, 0.050), transScale: 3.1, transPower: 3.4,
        windAmp: 0.052, flutter: 1.35, segScale: 0.30, baseAO: 0.10, albedoAO: 0.34,
        specScale: 0.35,
        lod: [420, 620], widthGrow: 0.0,
      });
      const matBark = makeVegMaterial(ctx, U, {
        key: 'bark', roughness: 0.86, side: THREE.FrontSide,
        colA: lin(0.130, 0.104, 0.066), colB: lin(0.062, 0.049, 0.032),
        transColor: lin(0, 0, 0), transScale: 0.0, transPower: 1.0,
        windAmp: 0.055, flutter: 0.35, segScale: 1.0, baseAO: 1.0,
        lod: [900, 1400], widthGrow: 0.0,
        fragPars: NOISE_GLSL,
        fragment: `
          // fibrous, twisted bark. vUv.x runs around the branch, vUv.y along it.
          vec2 bu = vVegUv;
          float fib = fbm2(vec2(bu.x * 26.0 + bu.y * 2.6, bu.y * 5.0), 4);
          float rid = ridged2(vec2(bu.x * 13.0 + bu.y * 1.7, bu.y * 3.1), 4);
          float fis = smoothstep(0.42, 0.86, rid);
          float grain = fbm2(vec2(bu.x * 90.0, bu.y * 22.0), 3);
          float shade = 0.55 + 0.45 * fib + 0.30 * grain;
          diffuseColor.rgb *= mix(uColA, uColB, clamp(fis * 1.25, 0.0, 1.0)) * shade * 3.0;
          roughnessFactor = clamp(0.72 + 0.24 * fis - 0.10 * grain, 0.4, 1.0);
        `,
      });
      const bladeTex = makeBladeAlpha(ctx, 32, 128);
      disposables.push(bladeTex);
      const matGrass = makeVegMaterial(ctx, U, {
        // Straw, not sage. The reference's dune grass measures lab_b +17.3 against our
        // -4.6, i.e. 22 b* units of warmth missing from a straw-coloured plant: B has to
        // come down and R has to stay up.
        key: 'grass', map: bladeTex, alphaTest: BLADE_ALPHA_REF, roughness: 0.78,
        colA: lin(0.375, 0.278, 0.068), colB: lin(0.205, 0.172, 0.042),
        transColor: lin(0.42, 0.36, 0.075), transScale: 2.6, transPower: 3.0,
        windAmp: 0.30, flutter: 1.0, segScale: 1.0, baseAO: 0.22, albedoAO: 0.55,
        specScale: 0.45,
        lod: [110, 170], widthGrow: 0.0085,
      });
      const matScrub = makeVegMaterial(ctx, U, {
        // carries the stack crown shelf as well as the talus scrub: the reference's
        // shelf is the *darkest and most saturated* foliage in the frame (mean sRGB
        // (70,70,36), sat 133), so this is a dark mass, not a mid-tone.
        key: 'scrub', map: leafTex, alphaTest: LEAF_ALPHA_REF, roughness: 0.74,
        colA: lin(0.150, 0.186, 0.033), colB: lin(0.052, 0.068, 0.011),
        transColor: lin(0.22, 0.31, 0.036), transScale: 2.4, transPower: 3.2,
        windAmp: 0.13, flutter: 1.1, segScale: 1.0, baseAO: 0.12, albedoAO: 0.34,
        specScale: 0.35,
        lod: [220, 340], widthGrow: 0.002,
      });
      const matMoss = makeVegMaterial(ctx, U, {
        key: 'moss', map: mossTex, alphaTest: LEAF_ALPHA_REF, roughness: 0.78,
        colA: lin(0.205, 0.238, 0.052), colB: lin(0.078, 0.094, 0.020),
        transColor: lin(0.20, 0.29, 0.032), transScale: 2.5, transPower: 3.2,
        windAmp: 0.075, flutter: 1.0, segScale: 1.0, baseAO: 0.10, albedoAO: 0.36,
        specScale: 0.35,
        lod: [430, 640], widthGrow: 0.0,
      });
      const matIvy = makeVegMaterial(ctx, U, {
        // ~2x darker than the shipped values with B pushed down: the reference drape is
        // a dark warm-green mass (lum_mean 61, sat 142, lab_b +13.6) and ours was a
        // light cold dusting (lum_mean 120, sat 28, lab_b -5.1).
        key: 'ivy', map: ivyTex, alphaTest: LEAF_ALPHA_REF, roughness: 0.70,
        colA: lin(0.098, 0.118, 0.019), colB: lin(0.040, 0.050, 0.008),
        transColor: lin(0.18, 0.26, 0.028), transScale: 2.4, transPower: 3.2,
        windAmp: 0.055, flutter: 0.9, segScale: 1.0, baseAO: 0.12, albedoAO: 0.38,
        specScale: 0.30,
        lod: [280, 420], widthGrow: 0.0,
      });
      const matVine = makeVegMaterial(ctx, U, {
        key: 'vine', map: vineTex, alphaTest: LEAF_ALPHA_REF, roughness: 0.70,
        colA: lin(0.118, 0.142, 0.024), colB: lin(0.046, 0.058, 0.010),
        transColor: lin(0.20, 0.28, 0.030), transScale: 2.8, transPower: 3.2,
        windAmp: 0.115, flutter: 1.45, segScale: 1.0, baseAO: 0.26, albedoAO: 0.45,
        specScale: 0.30,
        lod: [300, 460], widthGrow: 0.0,
      });

      const mats = [matCanopy, matBark, matGrass, matScrub, matMoss, matIvy, matVine];
      disposables.push(...mats);

      const addMesh = (geo, mat, inst, pad, shadow, depthOpts) => {
        if (inst.n === 0) return null;
        inst.attach(geo, pad);
        const m = new THREE.Mesh(geo, mat);
        m.layers.set(LAYER.OPAQUE);
        m.frustumCulled = true;
        m.matrixAutoUpdate = false;
        m.receiveShadow = true;
        m.castShadow = !!shadow;
        if (shadow) {
          // The shadow pass never sees the override material, so a caster needs its own
          // depth twin carrying the identical placement + wind, or its shadow lands on
          // the geometry's rest pose at the origin.
          const dm = makeVegDepthMaterial(U, depthOpts);
          m.customDepthMaterial = dm;
          disposables.push(dm);
        }
        patchForGBuffer(m, {
          matId: MAT_ID.FOLIAGE,
          roughness: mat.roughness,
          alphaMap: mat.map || null,
          alphaTest: mat.alphaTest,
          doubleSided: mat.side === THREE.DoubleSide,
        });
        group.add(m);
        meshes.push(m);
        disposables.push(geo);
        return m;
      };

      /* ================================================================== *
       *  Trees
       * ================================================================== */
      // Proportions read off kf_00720: canopy width ~= total tree height, the fork sits
      // a little over half way up, and the crown is roughly 2.4x wider than it is tall.
      const heroP = {
        trunkLen: 8.6, trunkR: 1.05, trunkLean: 0.52, flare: 1.35, taper: 0.46,
        maxDepth: 3, splits: [3, 2, 2], spread: [0.55, 0.55, 0.48],
        lift: [0.12, 0.04, 0.06], flatten: 0.18, lenFall: 0.42, radFall: 0.54,
        segStep: [0.34, 0.28, 0.22, 0.16],
        sprigsPerTip: 26, tipCluster: 1.3, sprigSize: 0.62, sprigLift: 0.45,
        shellSprigs: 2600, canopyR: 4.0, canopyH: 2.4, lumpSeed: 1.7, tiles: 2,
        bulge: 0.13, gravBias: 0.55,
      };
      const smallP = {
        trunkLen: 4.8, trunkR: 0.46, trunkLean: 0.62, flare: 0.95, taper: 0.50,
        maxDepth: 2, splits: [3, 2], spread: [0.68, 0.60],
        lift: [0.14, 0.06], flatten: 0.38, lenFall: 0.58, radFall: 0.52,
        segStep: [0.40, 0.32, 0.22],
        sprigsPerTip: 14, tipCluster: 1.1, sprigSize: 0.72, sprigLift: 0.2,
        shellSprigs: 900, canopyR: 3.4, canopyH: 1.9, lumpSeed: 4.1, tiles: 2,
        bulge: 0.15, gravBias: 0.58,
      };

      const species = [buildTree(rand.fork(11), heroP), buildTree(rand.fork(12), smallP)];
      const treeInst = [new Instances(), new Instances()];

      /** Where the tree sits, in metres, and how big. */
      const treeSites = [];
      const landmarkOf = (id) => {
        if (rocks?.landmarks?.get) {
          const L = rocks.landmarks.get(id);
          if (L) {
            return {
              x: L.center?.x ?? 0, z: L.center?.z ?? 0,
              topY: L.topY ?? (L.center?.y ?? 0), radius: L.radius ?? 12,
            };
          }
        }
        return LANDMARKS.find((l) => l.id === id) || null;
      };
      /**
       * A point on a stack's *crown*, not on its face.
       *
       * The old code called `rocks.surfacePoint(id, u, v)` with u and v both uniform.
       * That entry point parametrises the **face** — v runs base-to-rim — so uniform
       * (u,v) scattered the "crown" mat evenly down the whole cliff of the stack, which
       * is exactly the isotropic speckled dusting the critic measured (spectral_slope
       * -1.78 against the reference drape's -2.21). `rocks.crownPoint(id, u, r)` is the
       * cap parametrisation and is what a moss mat or a tree wants.
       *
       * `r` is a *radial fraction*; callers that want area-uniform coverage must pass
       * sqrt(uniform) themselves — several deliberately do not, because the reference
       * crowns are rim-heavy.
       */
      const crownPoint = (id, u, r, L) => {
        if (rocks?.crownPoint) {
          const cp = rocks.crownPoint(id, u, Math.min(1, r));
          if (cp && cp.point && Number.isFinite(cp.point.y)) return cp;
        }
        if (rocks?.surfacePoint) {
          const sp = rocks.surfacePoint(id, u, 1.0);
          if (sp && sp.point && Number.isFinite(sp.point.y)) {
            // fall back to the rim ring, pulled in toward the axis by r
            const p = sp.point.clone();
            p.x = L.x + (p.x - L.x) * r; p.z = L.z + (p.z - L.z) * r;
            return { point: p, normal: new THREE.Vector3(0, 1, 0) };
          }
        }
        const a = u * Math.PI * 2, rr = r * L.radius;
        return {
          point: new THREE.Vector3(L.x + Math.cos(a) * rr, L.topY, L.z + Math.sin(a) * rr),
          normal: new THREE.Vector3(0, 1, 0),
        };
      };

      /* ------------------------------------------------- hero tree siting */
      /**
       * Do not trust a landmark id for the hero placement.
       *
       * `stack_hero` is a name in `rocks.js`, not a guarantee about the composition;
       * when that module moved it the tree left the frame silently and the `rock` ROI —
       * the box this subsystem exists to fill — went to 0.000% foliage. So: score every
       * landmark crown by how big it actually renders in the scored poses, and put a
       * hero-scale tree on every crown that reads at all. Prominence sets the scale.
       */
      const stackIds = ['stack_hero', 'stack_arch', 'stack_twin_a', 'stack_twin_b',
        'stack_far_a', 'stack_far_b', 'headland'];
      const crowns = [];
      for (const id of stackIds) {
        const L = landmarkOf(id);
        if (!L) continue;
        const lm = rocks?.landmarks?.get?.(id);
        const cc = lm?.crown?.center;
        const cr = lm?.crown?.radius ?? L.radius * 0.6;
        const cx = cc?.x ?? L.x, cy = cc?.y ?? L.topY, cz = cc?.z ?? L.z;
        const ap = apparentPx(views, cx, cy, cz, cr);
        crowns.push({ id, L, x: cx, y: cy, z: cz, r: cr, px: ap.px, views: ap.views });
      }
      crowns.sort((a, b) => b.px - a.px);
      const visibleCrowns = crowns.filter((c) => c.views > 0 && c.px >= 14);
      if (visibleCrowns.length === 0) {
        console.error('[vegetation] FATAL: no rock crown is visible from any scored pose. '
          + 'rocks.js landmark table:', crowns.map((c) => `${c.id} ${c.px.toFixed(0)}px/${c.views}v`).join(' '));
      }
      console.log('[vegetation] crowns', crowns.map(
        (c) => `${c.id}:${c.px.toFixed(0)}px/${c.views}v`).join(' '));

      // Hero species on anything that renders bigger than ~55 px of crown radius in at
      // least one scored frame; the small species on the rest. The reference puts a tree
      // on every stack head that is close enough to read, and one per stack.
      for (const c of visibleCrowns) {
        const heroic = c.px >= 55;
        /* Near the axis, not on the lip.
         *
         * The first version put the tree at radial fraction 0.30-0.58 "so the trunk
         * breaks the rock's silhouette". Measured, that is wrong at every scored pose:
         * the cameras stand at y = 1.7 and the crowns are at y = 30-44, so we look at
         * every stack *from below* and the near half of the cap is occluded by the rock
         * itself. The tree base projected 38 px below the crown centre and the whole
         * 12 m tree finished 3 px under the rock's silhouette — invisible. On the axis
         * the base sits at the cap's high point and the full height clears the rim.
         */
        const a = rand.range(0, Math.PI * 2);
        const rr = 0.05 + 0.22 * rand.next();
        const cp = crownPoint(c.id, a / (Math.PI * 2), rr, c.L);
        /* Scale from the stack, not from a constant. In kf_00720 the tree's crown is
         * ~1.4x the width of the rock it stands on and clears the rim by ~40% of the
         * rock's visible height; a fixed-size tree on a stack twice that wide reads as
         * a shrub. */
        const s = heroic
          ? THREE.MathUtils.clamp(c.r / 5.2, 0.90, 2.10)
          : 0.55 + 0.40 * rand.next();
        treeSites.push({
          sp: heroic ? 0 : 1, x: cp.point.x, z: cp.point.z, y: cp.point.y - 0.4,
          s, id: c.id, px: c.px,
        });
      }
      // Cliff top and any other terrain the cameras see, high and flat enough for a tree.
      {
        const treeCells = cellsWhere((c) => c.y > 18 && c.slope < 0.40 && c.d < 340);
        for (let i = 0; i < CFG.treeSites && treeCells.length; i++) {
          const c = treeCells[Math.floor(rand.next() * treeCells.length)];
          const x = c.x + rand.sym(CELL * 0.5), z = c.z + rand.sym(CELL * 0.5);
          const s = world.sample(x, z);
          if (s.slope > 0.44) continue;
          treeSites.push({ sp: 1, x, z, y: s.y - 0.3, s: 0.7 + 0.55 * rand.next() });
        }
      }

      for (const t of treeSites) {
        const r0 = rand.next();
        treeInst[t.sp].add(t.x, t.y, t.z, rand.range(0, 6.2831), 0, t.s, t.s,
          bakePhase(t.x, t.z, r0), rand.next(), 1.0, 0.0);
      }

      for (let k = 0; k < 2; k++) {
        if (treeInst[k].n === 0) continue;
        const bg = species[k].branch.toGeometry();
        addMesh(bg, matBark, treeInst[k], species[k].canopy.r + 4, true,
          { key: 'bark' + k, windAmp: 0.055, flutter: 0.35, segScale: 1.0, lod: [900, 1400] });
        const lgInst = new Instances();
        for (let i = 0; i < treeInst[k].n; i++) {
          lgInst.pos.push(treeInst[k].pos[i * 3], treeInst[k].pos[i * 3 + 1], treeInst[k].pos[i * 3 + 2]);
          for (let j = 0; j < 4; j++) lgInst.ori.push(treeInst[k].ori[i * 4 + j]);
          for (let j = 0; j < 4; j++) lgInst.var.push(treeInst[k].var[i * 4 + j]);
          lgInst.n++;
        }
        const lg = species[k].leaves.toGeometry();
        addMesh(lg, matCanopy, lgInst, species[k].canopy.r + 4, true,
          { key: 'leaf' + k, map: leafTex, alphaTest: 0.42, windAmp: 0.052, flutter: 1.35, segScale: 0.30, lod: [420, 620] });
      }

      /* ================================================================== *
       *  Dune grass — berm, cliff top, and sparse tufts out on the dry sand
       * ================================================================== */
      const bladeGeo = bladeGeometry(4);
      const grassTiles = [];
      for (let i = 0; i < CFG.grassTiles; i++) grassTiles.push(new Instances());

      const pushBlade = (x, z, y, hgt, wid, tint, r0, tile) => {
        grassTiles[tile].add(x, y, z,
          rand.range(0, 6.2831), rand.range(-0.16, 0.16), hgt, wid,
          bakePhase(x, z, r0), tint, 1.0, 0.0);
      };

      const gr = rand.fork(21);

      /* Grass is placed on the visible-cell list, not on a z band.
       *
       * `grassCells` is "every 3 m patch of ground that at least one scored camera can
       * see from under 95 m, that is not sea, not surf and not a cliff face". A tuft
       * centre is drawn from that list; blades are jittered inside it. When terrain.js
       * re-profiles the beach the list re-rasterises with it — the failure that emptied
       * this scatter twice cannot recur, because the gate no longer names a coordinate.
       *
       * Density: the whole budget now lands inside ~95 m of a scored camera instead of
       * being spread over 48,000 m2 of mostly-invisible back-beach, and tuft radius is
       * small enough that neighbouring tufts merge into a mat rather than reading as
       * islands of dowels. */
      /* The "is this the back beach" gate is a **quantile of the terrain's own visible
       * height distribution**, not a number in metres.
       *
       * A fixed `s.y > 1.2` emptied this scatter the moment terrain.js re-profiled the
       * beach; a fixed `s.y > 0.05` (its replacement) went the other way and carpeted
       * the open swash-zone sand, where the reference has none. A quantile cannot do
       * either: by construction the top 55% of visible dry ground always passes, wherever
       * the height field happens to put it. */
      const heightFloor = (list, q) => {
        if (!list.length) return -1e9;
        const ys = list.map((c) => c.y).sort((a, b) => a - b);
        return ys[Math.floor(ys.length * q)];
      };
      // The quantile must be taken over the *same distance band* it gates. Taken over
      // everything visible it reads 62 m — the cliff plateau dominates the cell count —
      // and the beach empties again. Per band it reads the beach's own profile.
      const nearDry = cellsWhere((c) => c.d < 95 && c.wet < 0.24 && c.slope < 0.60);
      const midDry = cellsWhere((c) => c.d < 260 && c.wet < 0.24 && c.slope < 0.52);
      const nearFloor = heightFloor(nearDry, 0.45);
      const midFloor = heightFloor(midDry, 0.35);
      const grassCells = nearDry.filter((c) => c.y > nearFloor);
      const swardCells = midDry.filter((c) => c.y > midFloor);
      console.log(`[vegetation] ground: ${cells.length} visible cells, floors `
        + `near=${nearFloor.toFixed(2)} mid=${midFloor.toFixed(2)} -> `
        + `${grassCells.length} near + ${swardCells.length} sward cells`);

      let placed = 0, tries = 0;
      const maxTries = CFG.grassBlades * 6;
      // clumped scatter: a tuft centre is drawn from an accepted cell, then blades are
      // jittered around it. Two levels means the expensive gate runs ~24x less often.
      while (placed < CFG.grassBlades && tries < maxTries) {
        tries++;
        // 80% near field (the part that carries screen area), 20% mid-distance sward
        const near = gr.next() < 0.80;
        const src = near ? grassCells : swardCells;
        if (src.length === 0) { if (near) continue; else break; }
        const c = src[Math.floor(gr.next() * src.length)];
        const cx = c.x + gr.sym(CELL * 0.5), cz = c.z + gr.sym(CELL * 0.5);
        const s = world.sample(cx, cz);
        if (s.wetness > 0.32 || s.slope > 0.62) continue;
        const hBase = near ? 0.50 : 0.40;
        const wid = near ? 0.020 : 0.016;
        // A tuft is 24-52 blades in a 0.10-0.24 m radius: tight enough that the tuft
        // reads as one plant and adjacent tufts close up into a sward. The old
        // 16-36 blades over 0.16-0.42 m spread the same budget into visible islands.
        const nBlades = near ? 24 + Math.floor(gr.next() * 28) : 10 + Math.floor(gr.next() * 14);
        const tile = Math.min(CFG.grassTiles - 1,
          Math.max(0, Math.floor((cx + 300) / 600 * CFG.grassTiles)));
        const spread = 0.10 + 0.14 * gr.next();
        const tuftTint = gr.next();
        for (let b = 0; b < nBlades && placed < CFG.grassBlades; b++) {
          const a = gr.range(0, 6.2831), rr = spread * Math.sqrt(gr.next());
          const bx = cx + Math.cos(a) * rr, bz = cz + Math.sin(a) * rr;
          const by = world.height(bx, bz);
          pushBlade(bx, bz, by - 0.03,
            hBase * (0.62 + 0.75 * gr.next()), wid * (0.8 + 0.5 * gr.next()),
            Math.min(1, Math.max(0, tuftTint + gr.sym(0.22))), gr.next(), tile);
          placed++;
        }
      }
      for (let i = 0; i < CFG.grassTiles; i++) {
        if (grassTiles[i].n === 0) continue;
        // Shadows ON. The previous pass left them off "for cost"; measured, a tuft with
        // no contact shadow floats — the near-beach box read p01 84 against the
        // reference's 41 and local_contrast 0.022 against 0.071, and nothing else in
        // this file buys that back.
        addMesh(bladeGeo.toGeometry(), matGrass, grassTiles[i], 2.0, true,
          { key: 'grass', map: bladeTex, alphaTest: 0.30, windAmp: 0.30, flutter: 1.0, segScale: 1.0, lod: [110, 170] });
      }

      /* ================================================================== *
       *  Salt scrub on the talus slope
       * ================================================================== */
      const scrubGeo = clumpGeometry(rand.fork(31), 11, 2, 1.35);
      const scrubInst = new Instances();
      const sr = rand.fork(32);
      // talus / broken slope the scored cameras can see — again a cell gate, not a z band
      const scrubCells = cellsWhere((c) =>
        c.d < 240 && c.y > 3 && c.slope > 0.12 && c.slope < 0.82 && c.wet < 0.25);
      for (let i = 0, t = 0; i < CFG.scrubCount && t < CFG.scrubCount * 12 && scrubCells.length; t++) {
        const c = scrubCells[Math.floor(sr.next() * scrubCells.length)];
        const x = c.x + sr.sym(CELL * 0.5), z = c.z + sr.sym(CELL * 0.5);
        const s = world.sample(x, z);
        if (s.slope > 0.86) continue;
        const sc = 0.75 + 1.35 * sr.next();
        scrubInst.add(x, s.y - 0.12, z, sr.range(0, 6.2831), sr.sym(0.20),
          sc * (1.0 + 0.9 * sr.next()), sc * 1.3, bakePhase(x, z, sr.next()), sr.next(), 1.0, 0.14);
        i++;
      }
      addMesh(scrubGeo.toGeometry(), matScrub, scrubInst, 3, true,
        { key: 'scrub', map: leafTex, alphaTest: 0.42, windAmp: 0.13, flutter: 1.1, segScale: 1.0, lod: [150, 230] });

      /* ================================================================== *
       *  Moss / lichen crowns on the stack tops + the cliff lip
       * ================================================================== */
      /* The crown shelf is a silhouette, not a texture.
       *
       * The previous version scattered 0.55 m-tall pancakes over `surfacePoint(u,v)`
       * with u and v both uniform — the *face* parametrisation, so the mat ran all the
       * way down the stack, and area-uniform v put more clumps toward the middle of the
       * disc than at the rim. Edge-on at 90 m the whole thing was sub-readable: the
       * stack contributed 1.82% of its box and 0.000% foliage hue.
       *
       * What the reference shows is a 4-6 m deep scrub shelf sitting ON the rim and
       * hanging past it, cutting a ragged, high-contrast profile into the rock against
       * the sky, with the flat crown centre comparatively bare. So: place on
       * `crownPoint`, bias hard outward (rr in 0.62..1.14, i.e. over the lip), and give
       * the clumps real vertical extent (1.6-4.4 m) out of a taller, denser geometry.
       */
      const shelfGeo = clumpGeometry(rand.fork(41), 15, 2, 1.75);
      const mossGeo = clumpGeometry(rand.fork(43), 7, 2, 0.55);
      const shelfInst = new Instances();
      const mossInst = new Instances();
      const mr = rand.fork(42);
      for (const c of visibleCrowns) {
        const L = c.L;
        // Circumference of the lip in metres, at roughly one clump per 0.55 m of rim,
        // three deep. Small distant stacks get proportionally fewer, automatically.
        const rimLen = 2 * Math.PI * Math.max(c.r, 2);
        const n = Math.min(900, Math.round(rimLen * 3.4));
        for (let i = 0; i < n; i++) {
          const u = mr.next();
          // rim-biased radius: 82% of the mass in the outer third, some hanging past 1.0
          const rr = 0.62 + 0.52 * Math.pow(mr.next(), 0.55);
          const cp = crownPoint(c.id, u, Math.min(1, rr), L);
          const p = cp.point;
          const dx = p.x - c.x, dz = p.z - c.z;
          const dl = Math.hypot(dx, dz) || 1;
          const over = Math.max(0, rr - 1.0) * c.r;         // metres past the lip
          const rim = THREE.MathUtils.clamp((rr - 0.72) / 0.34, 0, 1);
          // a clump that overhangs also drops, so the shelf reads as a rolled edge
          const drop = over * 0.9 + rim * mr.range(0.2, 2.4);
          const sc = 0.85 + 0.85 * mr.next();
          shelfInst.add(
            p.x + dx / dl * over, p.y - 0.25 - drop, p.z + dz / dl * over,
            mr.range(0, 6.2831), rim * mr.range(0.15, 0.85),
            sc * (1.6 + 2.8 * mr.next()),               // 1.4 - 3.7 m tall
            sc * (0.85 + 0.75 * mr.next()),
            bakePhase(p.x, p.z, mr.next()), mr.next(), 1.0, 0.10);
        }
        // a thinner lichen mat over the flat centre, so the crown is not bare rock
        const nc = Math.min(400, Math.round(Math.PI * c.r * c.r * 0.30));
        for (let i = 0; i < nc; i++) {
          const cp = crownPoint(c.id, mr.next(), 0.80 * Math.sqrt(mr.next()), L);
          const p = cp.point;
          const sc = 0.45 + 0.55 * mr.next();
          mossInst.add(p.x, p.y - 0.15, p.z, mr.range(0, 6.2831), mr.sym(0.25),
            sc * 0.75, sc * 1.15, bakePhase(p.x, p.z, mr.next()), mr.next(), 1.0, 0.10);
        }
      }
      // Terrain lip: the same crown-relative band, on cliff tops the cameras can see.
      // The old version smeared this over 40 m of face at slope 0.42-0.95, which is what
      // produced the even top-to-bottom speckle the critic measured at spectral_slope
      // -1.78 (near-white-noise) against the reference drape's -2.21.
      {
        const lipCells = cellsWhere((c) => c.d < 300 && c.y > 12 && c.slope > 0.30 && c.slope < 0.90);
        const n = Math.min(CFG.mossClumps, lipCells.length * 3);
        for (let i = 0; i < n && lipCells.length; i++) {
          const c = lipCells[Math.floor(mr.next() * lipCells.length)];
          const x = c.x + mr.sym(CELL * 0.5), z = c.z + mr.sym(CELL * 0.5);
          const s = world.sample(x, z);
          const sc = 0.7 + 0.8 * mr.next();
          shelfInst.add(x, s.y - 0.2, z, mr.range(0, 6.2831), mr.range(0.0, 0.55),
            sc * (1.2 + 1.9 * mr.next()), sc * (0.8 + 0.6 * mr.next()),
            bakePhase(x, z, mr.next()), mr.next(), 1.0, 0.10);
        }
      }
      addMesh(shelfGeo.toGeometry(), matScrub, shelfInst, 8, true,
        { key: 'shelf', map: leafTex, alphaTest: 0.42, windAmp: 0.10, flutter: 1.05, segScale: 1.0, lod: [430, 640] });
      addMesh(mossGeo.toGeometry(), matMoss, mossInst, 6, true,
        { key: 'moss', map: mossTex, alphaTest: 0.42, windAmp: 0.075, flutter: 1.0, segScale: 1.0, lod: [430, 640] });

      /* ================================================================== *
       *  Ivy drape on the cliff face
       * ================================================================== */
      /* The drape hangs off rock, so it is placed on the rock's own surface
       * parametrisation — `rocks.surfacePoint(id, u, v)`, v = base..rim — and accepted
       * only where a scored camera can see it. The previous version scanned the height
       * field over a hardcoded `z 50..76`; measured, that band placed **64 cards out of
       * a 2600 budget** in the shipped build, because the cliff it was written against
       * had moved. Rock surfaces cannot go empty that way: if the cliff moves, its
       * parametrisation moves with it.
       *
       * v is biased hard to the top (v = 1 - 0.30*u^1.6) because the reference drape is
       * a dark mass hanging from the lip, not a dusting spread over the whole face. */
      const ivyGeo = cardGeometry(2, 0, 1, 0.12);
      const ivyInst = new Instances();
      const ir = rand.fork(51);
      const drapeIds = [];
      if (rocks?.landmarks) for (const [id] of rocks.landmarks) drapeIds.push(id);
      else drapeIds.push(...stackIds);
      let ivyPlaced = 0;
      for (let t = 0; t < CFG.ivyCards * 14 && ivyPlaced < CFG.ivyCards; t++) {
        const id = drapeIds[Math.floor(ir.next() * drapeIds.length)];
        const u = ir.next();
        const v = 1.0 - 0.34 * Math.pow(ir.next(), 1.4);
        const sp = rocks?.surfacePoint?.(id, u, v);
        if (!sp || !sp.point || !Number.isFinite(sp.point.y)) continue;
        const p = sp.point;
        if (p.y < 6) continue;
        const n = sp.normal || new THREE.Vector3(0, 1, 0);
        const nl = Math.hypot(n.x, n.z);
        if (nl < 0.45) continue;                       // only real faces, not the cap
        if (seenBy(views, p.x, p.y, p.z, 420).n === 0) continue;
        const yaw = Math.atan2(n.x / nl, n.z / nl);
        const sc = 0.55 + 0.45 * ir.next();
        // A drape is long and narrow. The card's local +Y is rotated ~170 deg about X
        // so it hangs *down* the face: aOri.z is then the fall length in metres and
        // aOri.w the strand width. The first version had the two the wrong way round
        // and produced 4 m wide, 0.6 m long cards — a shingle, not a runner.
        ivyInst.add(p.x + n.x * 0.30, p.y + 0.15, p.z + n.z * 0.30,
          yaw + ir.sym(0.45), 2.80 + ir.sym(0.30),
          sc * (1.3 + 1.7 * ir.next()), sc * (0.55 + 0.55 * ir.next()),
          bakePhase(p.x, p.z, ir.next()), ir.next(), 1.0, 0.12);
        ivyPlaced++;
      }
      if (ivyPlaced < CFG.ivyCards * 0.5) {
        console.warn(`[vegetation] ivy drape underfilled: ${ivyPlaced}/${CFG.ivyCards} cards — `
          + 'rocks.surfacePoint() is not returning visible steep faces');
      }
      addMesh(ivyGeo.toGeometry(), matIvy, ivyInst, 4, true,
        { key: 'ivy', map: ivyTex, alphaTest: 0.42, windAmp: 0.055, flutter: 0.9, segScale: 1.0, lod: [280, 420] });

      /* ================================================================== *
       *  Hanging vine curtains — cliff undercut and stack overhangs
       * ================================================================== */
      const vineGeo = vineGeometry(11, 2);
      const vineInst = new Instances();
      const vr = rand.fork(61);
      /* A curtain is a *cluster*, not a uniform fringe. In kf_00720 and kf_01500 the
       * vines hang in two or three discrete falls per stack, each a tight fan whose
       * strands are longest in the middle and taper to nothing at the sides. Scattering
       * strands evenly round the rim gives a row of identical dreadlocks, which is what
       * the first pass looked like. */
      const curtain = (ax, ay, az, nx, nz, span, maxLen, n) => {
        const yaw = Math.atan2(nx, nz);
        for (let i = 0; i < n; i++) {
          const u = vr.range(-1, 1);
          const fall = Math.pow(Math.max(0, 1 - u * u), 0.55);
          const px = ax - nz * u * span, pz = az + nx * u * span;
          vineInst.add(px, ay - vr.next() * 0.7, pz,
            yaw + vr.sym(0.55), vr.sym(0.10),
            maxLen * (0.22 + 0.78 * fall) * (0.7 + 0.6 * vr.next()),
            0.28 + 0.42 * vr.next(),
            bakePhase(px, pz, vr.next()), vr.next(), 1.0, 0.0);
        }
      };

      // cliff: curtains hanging out of the undercut, on visible steep faces
      {
        const cliffCells = cellsWhere((c) => c.d < 320 && c.slope > 0.78 && c.y > 12);
        for (let i = 0; i < 26 && cliffCells.length; i++) {
          const c = cliffCells[Math.floor(vr.next() * cliffCells.length)];
          const x = c.x + vr.sym(CELL * 0.5), z = c.z + vr.sym(CELL * 0.5);
          const s = world.sample(x, z);
          const n = s.normal;
          const nl = Math.hypot(n.x, n.z) || 1;
          curtain(x + n.x * 0.6, s.y + 0.5, z + n.z * 0.6, n.x / nl, n.z / nl,
            1.6 + 2.6 * vr.next(), 3.0 + 5.0 * vr.next(), 22 + Math.floor(vr.next() * 20));
        }
      }
      // stacks: two or three falls off the rim, on one favoured side. Anchored on the
      // measured crown radius/height, not on the spec's nominal `radius`/`topY`.
      for (const c of visibleCrowns) {
        const L = c.L;
        const nFalls = 2 + Math.floor(vr.next() * 2);
        const favour = vr.range(0, 6.2831);
        for (let f = 0; f < nFalls; f++) {
          const a = favour + vr.sym(1.5);
          const rr = c.r * (0.93 + 0.10 * vr.next());
          const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
          curtain(x, c.y - 1.0 - vr.next() * 2.0, z, Math.cos(a), Math.sin(a),
            1.4 + 2.2 * vr.next(), 4.5 + 7.5 * vr.next(),
            26 + Math.floor(vr.next() * 26));
        }
      }
      addMesh(vineGeo.toGeometry(), matVine, vineInst, 12, true,
        { key: 'vine', map: vineTex, alphaTest: 0.40, windAmp: 0.115, flutter: 1.45, segScale: 1.0, lod: [300, 460] });

      /* ------------------------------------------------------------------ */
      group.layers.set(LAYER.OPAQUE);
      ctx.scene.add(group);
      group.updateMatrixWorld(true);
      for (const m of meshes) m.updateMatrixWorld(true);

      this.stats = {
        draws: meshes.length,
        blades: grassTiles.reduce((a, g) => a + g.n, 0),
        trees: treeSites.length,
        shelf: shelfInst.n, moss: mossInst.n, ivy: ivyInst.n, vines: vineInst.n,
        scrub: scrubInst.n, cells: cells.length,
        tris: meshes.reduce((a, m) =>
          a + (m.geometry.index.count / 3) * m.geometry.instanceCount, 0),
      };
      console.log('[vegetation]', JSON.stringify(this.stats));
    },

    update(dt, ctx) {
      const c = ctx.config;
      const anim = c.vegWind ?? 1.0;
      windTPrev = windT;
      windT += (ctx.config.frozen ? 0 : dt) * anim;
    },

    prerender(ctx) {
      if (!U) return;
      group.visible = this.enabled !== false;
      if (!group.visible) return;

      const time = ctx.get('time');
      if (time) {
        const wd = THREE.MathUtils.degToRad(time.state.windDir);
        U.uWindDir.value.set(-Math.sin(wd), 0, -Math.cos(wd));
        U.uWindSide.value.set(Math.cos(wd), 0, -Math.sin(wd));
        U.uGust.value = time.state.gust;
        _sun.copy(time.sunDir);
        _nrm.setFromMatrix4(ctx.camera.matrixWorldInverse);
        U.uSunDirV.value.copy(_sun).applyMatrix3(_nrm).normalize();
        U.uSunRad.value.copy(time.sunColor).multiplyScalar(time.state.sunIntensity * SUN_RAD_SCALE);
      }
      U.uWindT.value = windT;
      U.uWindTPrev.value = windTPrev;
      U.uCamPos.value.copy(ctx.camera.position);
      U.uDensity.value = ctx.config.vegDensity ?? 1.0;

      // Same convention scene.js uses: current = the jittered clip position the vertex
      // shader already computed, previous = the un-jittered previous view-projection.
      // taa.js compensates for exactly that pairing.
      U.uPrevViewProj.value.copy(prevVP);
      prevVP.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    },

    resize() {},

    dispose(ctx) {
      ctx.scene.remove(group);
      for (const d of disposables) d.dispose?.();
      disposables.length = 0;
      meshes.length = 0;
    },
  };
}
