import * as THREE from 'three';

/**
 * `time` — the single authority for sun direction, sky tint drivers and wind.
 *
 * Every other subsystem reads from here rather than deriving its own sun vector;
 * that is the only way shadows, sky, water specular, cloud lighting and the
 * viewmodel rim light stay in agreement.
 */
export function create() {
  const sunDir = new THREE.Vector3();      // *toward* the sun, normalised
  const sunColor = new THREE.Color();
  const skyColor = new THREE.Color();
  const wind = new THREE.Vector3();

  // Reference clip: sun high and slightly seaward, strong but not noon-flat.
  const state = {
    azimuthDeg: 118,
    elevationDeg: 41,
    /** Radiance of the sun disc, W/m²/sr-ish. Tuned so the tonemap pass lands the
     *  clip's measured p99 of 221 on wet sand highlights. */
    sunIntensity: 6.2,
    /** Angular radius of the sun in radians — drives penumbra width and the disc size. */
    sunAngularRadius: 0.0047,
    turbidity: 3.1,
    windDir: 236,          // degrees, from which the wind blows
    windSpeed: 5.4,        // m/s
    gust: 0,
  };

  function recompute() {
    const az = THREE.MathUtils.degToRad(state.azimuthDeg);
    const el = THREE.MathUtils.degToRad(state.elevationDeg);
    const ce = Math.cos(el);
    // azimuth 0 = +Z(inland), increasing toward +X(east)
    sunDir.set(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)).normalize();

    // Colour temperature falls off as the sun approaches the horizon.
    const t = THREE.MathUtils.clamp(Math.sin(el), 0.02, 1.0);
    const warm = Math.pow(1.0 - t, 2.1);
    sunColor.setRGB(
      1.0,
      THREE.MathUtils.lerp(1.0, 0.66, warm),
      THREE.MathUtils.lerp(0.985, 0.36, warm));
    skyColor.setRGB(
      THREE.MathUtils.lerp(0.36, 0.62, warm),
      THREE.MathUtils.lerp(0.56, 0.66, warm),
      THREE.MathUtils.lerp(0.94, 0.82, warm));
  }

  return {
    name: 'time',
    order: 10,
    state,
    sunDir, sunColor, skyColor, wind,

    /** Scalar 0..1: how much sunlight reaches the ground (drives exposure adaptation). */
    get sunAltitudeFactor() { return THREE.MathUtils.clamp(sunDir.y, 0, 1); },

    async init(ctx) {
      recompute();
      ctx.config.timeOfDay = state.elevationDeg;
      ctx.on('config', ({ k, v }) => {
        if (k === 'sunElevation') { state.elevationDeg = v; recompute(); }
        if (k === 'sunAzimuth') { state.azimuthDeg = v; recompute(); }
        if (k === 'sunIntensity') { state.sunIntensity = v; }
      });
    },

    update(dt, ctx) {
      if (ctx.config.frozen) dt = 0;
      // Gusts modulate every wind consumer (grass, trees, spray, cloud advection)
      // from one place, so foliage and particles never disagree about the weather.
      const t = ctx.clock.t;
      state.gust = 0.62 + 0.38 * Math.sin(t * 0.21) * Math.sin(t * 0.077 + 1.7);
      const wd = THREE.MathUtils.degToRad(state.windDir);
      const s = state.windSpeed * state.gust;
      wind.set(-Math.sin(wd) * s, 0, -Math.cos(wd) * s);
    },
  };
}
