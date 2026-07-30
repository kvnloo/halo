import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { updateAerialUniforms } from '../gfx/materialCommon.js';

/**
 * `lighting` — sun, cascaded shadows and the ambient fill.
 *
 * Two things here matter more than anything else for the reference look:
 *
 *  1. Shadows are never black. The clip measures shadow_frac 0.050 and p01 17, i.e.
 *     the darkest 1% of pixels still sit at code value 17. That comes from a strong
 *     blue sky fill plus a warm bounce off the sand. A hemisphere light alone gets
 *     the blue but misses the upward warm bounce, so there are two fills.
 *  2. Contact detail. Four cascades over 340 m with a tight first cascade is what
 *     keeps pebble and ripple shadows crisp in the near field, which is a large part
 *     of why the reference reads as high detail (lap_var 463).
 */
export function create() {
  let csm = null;
  let hemi = null;
  let bounce = null;
  const shadowSize = 2048;

  return {
    name: 'lighting',
    order: 12,
    csm: null,

    async init(ctx) {
      const time = ctx.get('time', true);

      csm = new CSM({
        maxFar: 340,
        cascades: 4,
        mode: 'practical',
        parent: ctx.scene,
        shadowMapSize: shadowSize,
        lightDirection: time.sunDir.clone().negate(),
        camera: ctx.camera,
        lightIntensity: time.state.sunIntensity,
        lightNear: 1,
        lightFar: 900,
        shadowBias: -0.00018,
        lightMargin: 220,
      });
      csm.fade = true;
      for (const l of csm.lights) {
        l.color.copy(time.sunColor);
        l.shadow.normalBias = 0.035;
        l.shadow.bias = -0.00016;
        l.shadow.blurSamples = 12;
      }
      this.csm = csm;

      // Sky fill: blue, from above. The dominant term inside shadow.
      hemi = new THREE.HemisphereLight(0x87b5e8, 0x2a2a26, 0.0);
      ctx.scene.add(hemi);

      // Sand bounce: warm, from below. Small but it is what stops rock undersides
      // and the viewmodel from reading as cut-outs.
      bounce = new THREE.DirectionalLight(0xffd9a8, 0.0);
      bounce.position.set(0, -1, 0.25);
      bounce.castShadow = false;
      ctx.scene.add(bounce);
      ctx.scene.add(bounce.target);

      this.applyIntensities(ctx);
    },

    applyIntensities(ctx) {
      const time = ctx.get('time', true);
      const alt = Math.max(0.02, time.sunDir.y);
      for (const l of csm.lights) {
        l.color.copy(time.sunColor);
        l.intensity = time.state.sunIntensity * (ctx.config.sunScale ?? 1);
      }
      hemi.intensity = 1.35 * Math.pow(alt, 0.35) * (ctx.config.skyFill ?? 1);
      hemi.color.copy(time.skyColor);
      bounce.intensity = 0.42 * alt * (ctx.config.bounceFill ?? 1);
    },

    /** Materials must be registered so CSM can inject its cascade selection. */
    registerMaterial(m) { if (csm && m) csm.setupMaterial(m); },

    update(dt, ctx) {
      const time = ctx.get('time', true);
      csm.lightDirection.copy(time.sunDir).negate().normalize();
      this.applyIntensities(ctx);
    },

    prerender(ctx) {
      csm.update();
      updateAerialUniforms(ctx);
    },

    dispose(ctx) {
      csm?.dispose();
      if (hemi) ctx.scene.remove(hemi);
      if (bounce) { ctx.scene.remove(bounce); ctx.scene.remove(bounce.target); }
    },
  };
}
