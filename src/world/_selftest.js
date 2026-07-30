import * as THREE from 'three';
import { applyWorldMaterial } from '../gfx/materialCommon.js';
import { patchForGBuffer, MAT_ID } from '../gfx/GBufferMaterial.js';
import { LAYER } from '../render/RenderPipeline.js';
import { SURFACE_GLSL } from '../gfx/glsl/noise.js';

/** Self-test of the shared material layer. Not part of the game. */
export function create() {
  const group = new THREE.Group();
  return {
    name: '_selftest', order: 56, enabled: true,
    async init(ctx) {
      // 1. plain shared material + CSM + aerial
      const a = new THREE.MeshStandardMaterial({ color: 0x9a8f7e, roughness: 0.75 });
      applyWorldMaterial(a, ctx, { matId: MAT_ID.ROCK });
      const s = new THREE.Mesh(new THREE.SphereGeometry(3, 64, 32), a);
      s.position.set(-6, 3.2, -12); s.castShadow = s.receiveShadow = true;
      s.layers.set(LAYER.OPAQUE); patchForGBuffer(s, { matId: MAT_ID.ROCK, roughness: 0.75 });

      // 2. injected procedural surface using the shared noise library
      const b = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
      applyWorldMaterial(b, ctx, {
        matId: MAT_ID.TERRAIN_SAND,
        inject: {
          key: 'selftest-noise',
          uniforms: { uScale: { value: 1.6 } },
          pars: SURFACE_GLSL + '\nuniform float uScale;',
          fragment: `
            vec3 wp = vWorldPositionWM * uScale;
            float n = fbm3(wp, 5) * 0.5 + 0.5;
            float r = ridged3(wp * 0.5, 4);
            diffuseColor.rgb = mix(vec3(0.72,0.62,0.46), vec3(0.34,0.30,0.26), n);
            diffuseColor.rgb *= 0.75 + 0.5 * r;
            roughnessFactor = clamp(0.45 + 0.4 * n, 0.05, 1.0);
          `,
        },
      });
      const s2 = new THREE.Mesh(new THREE.SphereGeometry(3, 96, 48), b);
      s2.position.set(6, 3.2, -12); s2.castShadow = s2.receiveShadow = true;
      s2.layers.set(LAYER.OPAQUE); patchForGBuffer(s2, { matId: MAT_ID.TERRAIN_SAND, roughness: 0.6 });

      // 3. ground plane to catch shadows
      const g = new THREE.MeshStandardMaterial({ color: 0xc2b294, roughness: 0.9 });
      applyWorldMaterial(g, ctx, { matId: MAT_ID.TERRAIN_SAND });
      const gp = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 1, 1), g);
      gp.rotation.x = -Math.PI / 2; gp.receiveShadow = true;
      gp.layers.set(LAYER.OPAQUE); patchForGBuffer(gp, { matId: MAT_ID.TERRAIN_SAND, roughness: 0.9 });

      group.add(s, s2, gp); ctx.scene.add(group);
    },
    dispose(ctx) { ctx.scene.remove(group); },
  };
}
