import * as THREE from 'three';

/**
 * G-buffer pre-pass material.
 *
 * Used as `scene.overrideMaterial` for the depth/normal/velocity pass. It writes
 *   MRT0 = view-space normal (xyz), perceptual roughness (w)
 *   MRT1 = motion vector in NDC (xy), material id (z), unused (w)
 *
 * Per-object data (roughness, material id, alpha-cutout map, previous transform) is
 * pushed in `onBeforeRender`, which three calls before the draw's uniform upload.
 *
 * Objects opt in by carrying a `userData.gbuffer` block:
 *   { roughness: number, matId: number, alphaMap: Texture|null, alphaTest: number,
 *     doubleSided: bool, skip: bool }
 * `patchForGBuffer(mesh, opts)` sets that up and is the only supported way in.
 */

const WHITE_1X1 = (() => {
  const d = new Uint8Array([255, 255, 255, 255]);
  const t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
})();

export function patchForGBuffer(obj, opts = {}) {
  obj.traverse?.((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const m0 = mats[0] || {};
    o.userData.gbuffer = Object.assign({
      roughness: m0.roughness ?? 0.6,
      matId: 0,
      alphaMap: (m0.alphaTest > 0 ? (m0.map || null) : null),
      alphaTest: m0.alphaTest ?? 0,
      doubleSided: m0.side === THREE.DoubleSide,
      skip: false,
    }, opts);
    o.userData.prevMatrixWorld = o.matrixWorld.clone();
  });
  return obj;
}

/** Material ids, so post passes can treat surfaces differently. */
export const MAT_ID = {
  DEFAULT: 0,
  TERRAIN_SAND: 1,
  TERRAIN_WET: 2,
  ROCK: 3,
  FORERUNNER: 4,
  FOLIAGE: 5,
  WATER: 6,
  SKIN: 7,
  VIEWMODEL: 8,
  METAL: 9,
};

export function createGBufferMaterial() {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uPrevModelMatrix: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCurrViewProj: { value: new THREE.Matrix4() },
      uRoughness: { value: 0.6 },
      uMatId: { value: 0 },
      uAlphaMap: { value: WHITE_1X1 },
      uAlphaTest: { value: 0 },
      uUseAlphaMap: { value: 0 },
      uJitter: { value: new THREE.Vector2() },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <batching_pars_vertex>
      #include <uv_pars_vertex>
      #include <skinning_pars_vertex>
      #include <morphtarget_pars_vertex>

      uniform mat4 uPrevModelMatrix;
      uniform mat4 uPrevViewProj;
      uniform mat4 uCurrViewProj;

      out vec3 vViewNormal;
      out vec4 vCurClip;
      out vec4 vPrevClip;

      void main() {
        #include <uv_vertex>
        #include <beginnormal_vertex>
        #include <morphinstance_vertex>
        #include <morphnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        vViewNormal = normalize( transformedNormal );

        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>

        vec4 localPos = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          localPos = batchingMatrix * localPos;
        #endif
        #ifdef USE_INSTANCING
          localPos = instanceMatrix * localPos;
        #endif

        vec4 worldPos = modelMatrix * localPos;
        vec4 prevWorld = uPrevModelMatrix * localPos;

        vCurClip  = uCurrViewProj * worldPos;
        vPrevClip = uPrevViewProj * prevWorld;

        gl_Position = projectionMatrix * ( viewMatrix * worldPos );
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      #include <common>
      #include <uv_pars_fragment>

      uniform float uRoughness;
      uniform float uMatId;
      uniform sampler2D uAlphaMap;
      uniform float uAlphaTest;
      uniform float uUseAlphaMap;

      in vec3 vViewNormal;
      in vec4 vCurClip;
      in vec4 vPrevClip;

      layout(location = 0) out vec4 oNormalRough;
      layout(location = 1) out vec4 oMotionId;

      void main() {
        if ( uUseAlphaMap > 0.5 ) {
          #if defined( USE_MAP ) || defined( USE_UV )
            float a = texture( uAlphaMap, vMapUv ).a;
          #else
            float a = 1.0;
          #endif
          if ( a < uAlphaTest ) discard;
        }

        vec3 n = normalize( vViewNormal );
        if ( !gl_FrontFacing ) n = -n;

        vec2 cur  = vCurClip.xy  / max( vCurClip.w,  1e-6 );
        vec2 prev = vPrevClip.xy / max( vPrevClip.w, 1e-6 );

        oNormalRough = vec4( n * 0.5 + 0.5, uRoughness );
        oMotionId    = vec4( ( cur - prev ) * 0.5, uMatId / 255.0, 1.0 );
      }
    `,
    side: THREE.FrontSide,
  });

  const _prev = new THREE.Matrix4();

  mat.onBeforeRender = function (_renderer, _scene, _camera, _geometry, object) {
    const g = object.userData.gbuffer;
    const u = mat.uniforms;
    if (g) {
      u.uRoughness.value = g.roughness;
      u.uMatId.value = g.matId;
      if (g.alphaMap && g.alphaTest > 0) {
        u.uAlphaMap.value = g.alphaMap;
        u.uAlphaTest.value = g.alphaTest;
        u.uUseAlphaMap.value = 1;
      } else {
        u.uUseAlphaMap.value = 0;
      }
      mat.side = g.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    } else {
      u.uRoughness.value = 0.6;
      u.uMatId.value = 0;
      u.uUseAlphaMap.value = 0;
      mat.side = THREE.FrontSide;
    }
    _prev.copy(object.userData.prevMatrixWorld || object.matrixWorld);
    u.uPrevModelMatrix.value.copy(_prev);
    mat.uniformsNeedUpdate = true;
  };

  /** Call once per frame after the pre-pass to roll the transform history forward. */
  mat.captureHistory = (scene) => {
    scene.traverse((o) => {
      if (o.userData.gbuffer) {
        (o.userData.prevMatrixWorld ||= new THREE.Matrix4()).copy(o.matrixWorld);
      }
    });
  };

  return mat;
}
