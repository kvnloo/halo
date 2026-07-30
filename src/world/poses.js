/**
 * Camera poses matched to specific frames of reference.mp4.
 *
 * Key `ref_NNNNN` <-> `ref/keyframes/kf_NNNNN.png`.
 * rot is [pitch, yaw, roll] in degrees, applied YXZ (three.js first-person order).
 * fov is vertical, degrees.
 *
 * These numbers are the substrate of the whole score history. Only a deliberate
 * pose-refit task may change them, and it must re-baseline every recorded score.
 */
export const POSES = {
  // Opening: standing on damp sand, bridge cantilevered out of the cliff ahead-right,
  // shallow water and low rocks to the left.
  ref_00000: { pos: [10.5, 1.74, 20.0], rot: [-4.0, 292.0, 0], fov: 78 },

  // Slight push forward, bridge fills the right third, dust haze under the deck.
  ref_00120: { pos: [7.2, 1.74, 15.4], rot: [-3.0, 288.0, 0], fov: 78 },

  // Hero sea stack with its flat-crowned tree comes into frame left of the bridge.
  ref_00450: { pos: [-1.0, 1.74, 6.5], rot: [-2.0, 313.0, 0], fov: 78 },

  // Look up: Halo ring band and Threshold across the sky, cliff edge lower-left.
  ref_00600: { pos: [-6.0, 1.74, 2.0], rot: [26.0, 330.0, 0], fov: 78 },

  // The sky frame: Threshold fills the upper right, two Halo ring bands rise from
  // the horizon, stars in the zenith, cliff left, hero sea stack centre.
  ref_00720: { pos: [-14.0, 1.74, 8.0], rot: [8.0, 320.0, 0], fov: 78 },

  // Down among the tide-pool shelf, big stacks close and towering.
  ref_00840: { pos: [-24.0, 1.74, -3.0], rot: [2.0, 342.0, 0], fov: 78 },

  // Wide: stacks standing in the shallows, wet sand foreground taking the sky.
  ref_01500: { pos: [-30.0, 1.72, -1.5], rot: [-3.5, 352.0, 0], fov: 78 },

  // Waterline, low sun glitter across the swash, distant islets in haze.
  ref_01800: { pos: [-42.0, 1.70, -6.5], rot: [-5.0, 8.0, 0], fov: 78 },

  // Turning back east: bridge silhouette against bright sky, cliff on the right.
  ref_02220: { pos: [-30.0, 1.74, 4.0], rot: [-1.0, 96.0, 0], fov: 78 },

  /* ------------------------------------------------------------ diagnostics */
  // Not matched to the reference; used to isolate one subsystem at a time.
  diag_sky:    { pos: [0, 12, 0], rot: [18, 300, 0], fov: 78 },
  diag_zenith: { pos: [0, 12, 0], rot: [78, 0, 0], fov: 78 },
  diag_water:  { pos: [-20, 2.2, -14], rot: [-8, 350, 0], fov: 78 },
  diag_terrain:{ pos: [0, 26, 60], rot: [-24, 320, 0], fov: 70 },
  diag_bridge: { pos: [-8, 6.0, -14], rot: [16, 118, 0], fov: 78 },
  diag_stack:  { pos: [-38, 3.0, -55], rot: [14, 0, 0], fov: 78 },
  diag_gun:    { pos: [10.5, 1.74, 20.0], rot: [-8.0, 292.0, 0], fov: 78 },
};

/** Poses that have a reference frame to score against. */
export const REF_POSES = Object.keys(POSES).filter((k) => k.startsWith('ref_'));

/** ref_00450 -> ref/keyframes/kf_00450.png */
export function refFrameFor(poseName) {
  const m = /^ref_(\d+)$/.exec(poseName);
  return m ? `ref/keyframes/kf_${m[1]}.png` : null;
}
