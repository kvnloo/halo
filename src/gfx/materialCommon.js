import * as THREE from 'three';

/**
 * The coherence layer.
 *
 * Every opaque world surface — terrain, rock, structures, vegetation, props — goes
 * through `applyWorldMaterial`. That is what guarantees they agree about sunlight,
 * shadows, aerial perspective and the G-buffer, no matter who wrote them.
 *
 *   const mat = new THREE.MeshStandardMaterial({ ... });
 *   applyWorldMaterial(mat, ctx, {
 *     matId: MAT_ID.ROCK,
 *     inject: { uniforms: {...}, common: `...`, fragment: `...` },
 *   });
 *
 * `inject.fragment` runs right before three's lighting, with `diffuseColor`,
 * `roughnessFactor`, `metalnessFactor`, `normal`, `vWorldPosition` and
 * `vViewPosition` all in scope — write to them to author your surface.
 *
 * Aerial perspective is injected here, not in a post pass, because it has to blend
 * with the *sky the sky module actually renders*. The reference dissolves distant
 * sea stacks into a pale warm band; that is the single biggest cue that a scene has
 * real depth, and getting it consistent across every surface matters more than
 * getting it physically exact.
 */

const AERIAL_PARS = /* glsl */`
uniform vec3  uAerialSunDir;
uniform vec3  uAerialSunColor;
uniform vec3  uAerialSkyColor;
uniform vec3  uAerialGroundColor;
uniform float uAerialDensity;
uniform float uAerialHeightFalloff;
uniform float uAerialSunAmount;
uniform float uAerialStart;
uniform vec3  uCameraPos;
varying vec3 vWorldPositionWM;

/** Henyey-Greenstein phase, the forward-scatter lobe that makes haze glow near the sun. */
float wmHG(float c, float g){
  float g2 = g*g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5));
}

/** Exponential height fog with an analytic integral along the view ray. */
vec3 wmAerial(vec3 color, vec3 worldPos, vec3 camPos){
  vec3 v = worldPos - camPos;
  float dist = length(v);
  if (dist < uAerialStart) return color;
  v /= max(dist, 1e-4);

  float hf = uAerialHeightFalloff;
  float c0 = uAerialDensity * exp(-hf * max(camPos.y, 0.0));
  float fy = hf * v.y;
  // integral of density along the ray, stable as v.y -> 0
  float integral = abs(fy) > 1e-4
      ? c0 * (1.0 - exp(-fy * (dist - uAerialStart))) / fy
      : c0 * (dist - uAerialStart);

  float t = 1.0 - exp(-integral);

  float cosT = dot(v, uAerialSunDir);
  // two lobes: a tight forward glow plus a broad ambient wash
  float phase = mix(0.42, wmHG(cosT, 0.76) * 2.6, uAerialSunAmount);
  vec3 inscatter = mix(uAerialGroundColor, uAerialSkyColor, clamp(v.y * 0.5 + 0.5, 0.0, 1.0));
  inscatter += uAerialSunColor * phase * uAerialSunAmount;

  return mix(color, inscatter, clamp(t, 0.0, 1.0));
}
`;

/** Uniform block shared by every world material; `lighting` refreshes it each frame. */
export function createAerialUniforms() {
  return {
    uAerialSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.5) },
    uAerialSunColor: { value: new THREE.Color(1.0, 0.94, 0.82) },
    uAerialSkyColor: { value: new THREE.Color(0.52, 0.66, 0.86) },
    uAerialGroundColor: { value: new THREE.Color(0.62, 0.60, 0.55) },
    uAerialDensity: { value: 0.0062 },
    uAerialHeightFalloff: { value: 0.021 },
    uAerialSunAmount: { value: 0.55 },
    uAerialStart: { value: 6.0 },
    uCameraPos: { value: new THREE.Vector3() },
  };
}

/** Process-wide singleton so a single per-frame update reaches every material. */
let _shared = null;
export function sharedAerialUniforms() {
  if (!_shared) _shared = createAerialUniforms();
  return _shared;
}

/** Called once per frame by `lighting`. */
export function updateAerialUniforms(ctx) {
  const u = sharedAerialUniforms();
  const time = ctx.get('time');
  if (time) {
    u.uAerialSunDir.value.copy(time.sunDir);
    u.uAerialSunColor.value.copy(time.sunColor).multiplyScalar(0.55);
    u.uAerialSkyColor.value.copy(time.skyColor).multiplyScalar(1.05);
  }
  u.uCameraPos.value.copy(ctx.camera.position);
  const c = ctx.config;
  if (c.aerialDensity !== undefined) u.uAerialDensity.value = c.aerialDensity;
  if (c.aerialSunAmount !== undefined) u.uAerialSunAmount.value = c.aerialSunAmount;
}

/**
 * @param {THREE.Material} mat
 * @param {object} ctx engine context
 * @param {object} o   { matId, roughnessHint, inject:{uniforms, pars, fragment, vertexPars, vertex}, aerial }
 */
/** Monotonic id for materials that supply no explicit `inject.key`. Deterministic by
 *  construction, so two identical runs produce identical program cache keys. */
let _anonKeySeq = 0;

export function applyWorldMaterial(mat, ctx, o = {}) {
  const aerialU = sharedAerialUniforms();
  const extra = o.inject?.uniforms || {};
  const useAerial = o.aerial !== false;

  mat.userData.worldMaterial = true;
  mat.userData.matId = o.matId ?? 0;

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, extra);
    if (useAerial) Object.assign(shader.uniforms, aerialU);

    // --- vertex: always publish world position -----------------------------
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vWorldPositionWM;\n${o.inject?.vertexPars || ''}`)
      .replace('#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         {
           vec4 wmWorld = vec4(transformed, 1.0);
           #ifdef USE_BATCHING
             wmWorld = batchingMatrix * wmWorld;
           #endif
           #ifdef USE_INSTANCING
             wmWorld = instanceMatrix * wmWorld;
           #endif
           vWorldPositionWM = (modelMatrix * wmWorld).xyz;
         }
         ${o.inject?.vertex || ''}`);

    // --- fragment ----------------------------------------------------------
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\n${useAerial ? AERIAL_PARS : 'varying vec3 vWorldPositionWM;'}\n${o.inject?.pars || ''}`);

    if (o.inject?.fragment) {
      // after normals are resolved, before lighting accumulates
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        `{\n${o.inject.fragment}\n}\n#include <lights_fragment_begin>`);
    }

    if (useAerial) {
      // after opaque colour is final, before three's own fog/tonemap chunks
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
         gl_FragColor.rgb = wmAerial(gl_FragColor.rgb, vWorldPositionWM, uCameraPos);`);
    }

    mat.userData.shader = shader;
  };

  // Materials that share a program must not share a cache key, or three will hand
  // the second one the first one's compiled shader.
  //
  // The anonymous fallback used to be Math.random(), which made every capture
  // non-deterministic: the program cache keyed differently each run, so `programs`
  // drifted (106 vs 107) and terrain/sand shading differed frame-for-frame at the
  // harness's settle count. A monotonic counter gives the identical uniqueness
  // guarantee — no two anonymous materials ever collide — but is reproducible,
  // because module init order and per-module material creation order are both fixed.
  const key = `wm:${o.matId ?? 0}:${o.inject?.key || `anon${_anonKeySeq++}`}`;
  mat.customProgramCacheKey = () => key;

  // CSM must patch the material or it will only ever see cascade 0.
  ctx.get('lighting')?.registerMaterial?.(mat);
  return mat;
}

/** Anisotropic, mip-mapped, repeating — the defaults every surface texture wants. */
export function configureTexture(tex, ctx, { srgb = false, repeat = true, aniso = null } = {}) {
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso ?? ctx.caps.maxAnisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
