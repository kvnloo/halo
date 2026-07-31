/**
 * Camera poses matched to specific frames of reference.mp4.
 *
 * Key `ref_NNNNN` <-> `ref/keyframes/kf_NNNNN.png`.
 * rot is [pitch, yaw, roll] in degrees, applied YXZ (three.js first-person order).
 * fov is vertical, degrees.
 *
 * These numbers are the substrate of the whole score history. Only a deliberate
 * pose-refit task may change them, and it must re-baseline every recorded score.
 *
 * ---------------------------------------------------------------------------
 * REFIT 2026-07-31 (Wave I, reports/posefit.md) — the ref_* poses HAVE been refitted.
 * Everything in scores/history.jsonl above the `poses-refit-discontinuity` marker was
 * measured on the old hand-authored framing and is NOT comparable to anything below it.
 *
 * x/z/pitch/yaw/fov come from `tools/fitpose.mjs --all`; `pos[1]` does NOT. It is
 * pinned to `terrain.height(x,z) + EYE_STAND` instead, because the fitter searches
 * absolute Y against a floor clamp of 0.4 m and will happily lie the camera on the
 * sand: unconstrained it put ref_01800 0.19 m above the beach, which scored the single
 * best MS-SSIM in the whole experiment (0.3324) while losing the shot's subject
 * entirely. Framing improved and the picture got worse. The reference is a *standing*
 * Chief, so eye height is not a free parameter — constraining it beat the raw fit on
 * every comparative axis (structure 24.15 vs 23.73, score_comparative 15.32 vs 15.27).
 *
 * If you re-run the fitter, re-apply that constraint afterwards; fitpose.mjs does not
 * know about the ground.
 * ---------------------------------------------------------------------------
 * GROUND CONTRACT — read this before you move a pose.
 *
 * `pos[1]` is an ABSOLUTE world Y, not a height above the ground. `terrain.js` is
 * re-profiled almost every wave, so a pose that was 1.7 m above the sand when it was
 * written can end up *inside* the hill later, and nothing complains: the frame just
 * fills with the underside of the terrain and 50% flat void (KNOWN_ISSUES 17.1 —
 * `shot_beach_establishing` at -0.21 m and `shot_cliff_vegetation` at -0.30 m).
 *
 * So every pose carries a baked `groundY` in POSE_GROUND below, and `auditPoses()`
 * re-derives it from the live `terrain.height()` — the same analytic field
 * `physics.raycast` / `physics.moveCharacter` use — and fails if the eye has sunk.
 * Gate:  node tools/_posecheck.mjs      (no GPU, ~2 s, exit 1 on any FAIL)
 * Rebake after a deliberate move:  node tools/_posecheck.mjs --rebake
 *
 * Yaw convention, because two showcase poses were aimed 180 deg away from the thing
 * they were named for: forward = (-sin(yaw), sin(pitch), -cos(yaw)). yaw 0 looks
 * down -Z, yaw 90 looks down -X, yaw 180 looks down +Z, yaw 270 looks down +X.
 * ---------------------------------------------------------------------------
 */
export const POSES = {
  // Opening: standing on damp sand, bridge cantilevered out of the cliff ahead-right,
  // shallow water and low rocks to the left.
  ref_00000: { pos: [10.5, 2.98, 17.39], rot: [-2.78, 285.04, 0], fov: 74.3 },

  // Slight push forward, bridge fills the right third, dust haze under the deck.
  ref_00120: { pos: [4.62, 2.71, 15.65], rot: [0.21, 280.27, 0], fov: 68.3 },

  // Hero sea stack with its flat-crowned tree comes into frame left of the bridge.
  ref_00450: { pos: [-0.23, 2.07, 1.91], rot: [-0.9, 316.49, 0], fov: 79.8 },

  // Look up: Halo ring band and Threshold across the sky, cliff edge lower-left.
  ref_00600: { pos: [-7.56, 2.2, 1.21], rot: [26.06, 329.83, 0], fov: 78.8 },

  // The sky frame: Threshold fills the upper right, two Halo ring bands rise from
  // the horizon, stars in the zenith, cliff left, hero sea stack centre.
  ref_00720: { pos: [-12.34, 2.4, 6.68], rot: [11.52, 318.75, 0], fov: 73.5 },

  // Down among the tide-pool shelf, big stacks close and towering.
  ref_00840: { pos: [-24.41, 2.22, 2.59], rot: [5.02, 338.46, 0], fov: 77.7 },

  // Wide: stacks standing in the shallows, wet sand foreground taking the sky.
  ref_01500: { pos: [-30, 1.95, -1.5], rot: [-3.5, 352, 0], fov: 78 },

  // Waterline, low sun glitter across the swash, distant islets in haze.
  ref_01800: { pos: [-40.4, 1.93, -10.01], rot: [-4.88, 10, 0], fov: 72.1 },

  // Turning back east: bridge silhouette against bright sky, cliff on the right.
  ref_02220: { pos: [-28.63, 2.34, 4.06], rot: [1.43, 73.71, 0], fov: 82.5 },

  /* -------------------------------------------------------- showcase poses */
  // A curated tour of the level, one pose per thing worth looking at. These are for
  // `tools/previewsheet.mjs`; they are NOT scored, so they can be retuned freely as the
  // scene fills in. Keep the names semantic — they become the captions on the sheet.
  //
  // Every one of these stands at `terrain.height(x,z) + EYE_STAND` (see POSE_GROUND).
  // If you move one in X/Z you must move Y with it and rebake.

  // Berm above the swash, whole beach running away west, bridge across the middle
  // distance, cliffs both sides. Was 1.93 m UNDER the sand (KNOWN_ISSUES 17.1).
  shot_beach_establishing: { pos: [12.0, 3.67, 24.0], rot: [-3.0, 296.0, 0], fov: 78 },

  // The span, side on, from the wet sand west of it. Was aimed at yaw 78 — i.e. down
  // -X — while the deck runs (80,21.5,42.7) -> (57.8,21.5,-87.4), entirely in +X.
  // The cell contained no bridge at all.
  shot_forerunner_bridge:  { pos: [14.0, 2.14, 6.0], rot: [18.0, 288.0, 0], fov: 78 },

  // Directly under mid-span looking along the soffit ribs toward the sea end. Same
  // 180-degree aiming error as above; also 84 m short of the deck.
  shot_bridge_underside:   { pos: [70.0, 2.52, -16.0], rot: [42.0, 10.0, 0], fov: 82 },

  shot_hero_stack:         { pos: [-16.0, 1.74, -8.0], rot: [6.0, 332.0, 0], fov: 74 },
  shot_stack_gauntlet:     { pos: [-34.0, 1.74, -34.0], rot: [12.0, 348.0, 0], fov: 78 },
  shot_shoreline:          { pos: [-22.0, 1.30, -4.0], rot: [-11.0, 318.0, 0], fov: 70 },
  shot_tide_pools:         { pos: [-44.0, 1.55, -2.0], rot: [-22.0, 300.0, 0], fov: 72 },

  // Standing in 0.2-0.8 m of water on the inner shelf, looking down through the
  // surface at the bed. The old pose was 30 m away with 6% of the frame on water,
  // so "refraction + caustics" had nothing to show (KNOWN_ISSUES 17.5); this one
  // measures 59% of pixels on water shallower than 1.5 m.
  shot_water_edge:         { pos: [-45.0, 1.84, -10.0], rot: [-28.0, 45.0, 0], fov: 66 },

  // The east headland's undercut face, with the ivy curtains and the moss drape on
  // it and the tree line on the rim. The only slope > 0.78 that vegetation.js will
  // scatter cliff growth onto is x 96..300, z 47..62 — the old pose stood on the
  // beach at (24,·,30) aimed at yaw 40, i.e. out to sea, 0.30 m under the ground.
  shot_cliff_vegetation:   { pos: [86.0, 8.99, 6.0], rot: [18.0, 218.0, 0], fov: 74 },

  shot_sky_ring:           { pos: [-10.0, 1.74, 4.0], rot: [30.0, 326.0, 0], fov: 82 },

  // NOTE: `fov` cannot make the viewmodel bigger. passes/scene.js draws it through
  // `pipe.viewCamera`, a hard-coded 55 deg camera (RenderPipeline.js:131), so the gun
  // covers 10.0% of the frame at EVERY pose — measured 207311 px at fov 58 vs 207503
  // px at fov 95, a 0.09% difference. The old fov 58 therefore did the opposite of
  // what it intended: it magnified the *world* while the gun stayed put. All a pose
  // can do is choose the backdrop; this one puts the receiver against bright water
  // and sky (gun luminance 51.7 against a 87.2 surround) instead of mid-tone shingle.
  shot_weapon_detail:      { pos: [8.0, 1.74, 18.0], rot: [10.0, 292.0, 0], fov: 88 },

  shot_overview:           { pos: [30.0, 46.0, 62.0], rot: [-26.0, 318.0, 0], fov: 72 },

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

/** Standing eye height. Mirrors `T.eyeStand` in `src/game/player.js`. */
export const EYE_STAND = 1.72;

/**
 * Ground contract, per pose.
 *
 *   groundY  `terrain.height(pos[0], pos[2])` when the pose was last verified.
 *   minClear the smallest eye-above-ground the pose is allowed to have.
 *
 * Since the Wave I refit, EVERY pose here — showcase and `ref_*` alike — is authored
 * as `groundY + EYE_STAND`, so they all stand. This closes reports/poses.md section 5,
 * which measured the old `ref_*` cameras at 0.26-1.18 m off the sand (ref_00000, the
 * pose the whole score history is anchored on, was effectively lying down) and flagged
 * it for the next refit. Raising them alone — no reframing at all — is worth
 * ms_ssim +0.0067 of the refit's +0.0130, i.e. half the structural gain of this wave
 * came from simply standing the camera up.
 *
 * `minClear` is 1.20 for the `ref_*` set rather than the showcase 1.40: they must not
 * be allowed to sink (that is the failure this gate exists for), but terrain.js is
 * re-profiled most waves and a hard FAIL has a blast radius across every agent, so
 * there is 0.52 m of headroom below the authored 1.72 and the 0.60 m drift WARN fires
 * first.
 *
 * `null` groundY = the pose is deliberately airborne (overview, diagnostics) and
 * only the clearance floor is checked.
 */
export const POSE_GROUND = {
  ref_00000:               { groundY: 1.26, minClear: 1.20 },
  ref_00120:               { groundY: 0.99, minClear: 1.20 },
  ref_00450:               { groundY: 0.35, minClear: 1.20 },
  ref_00600:               { groundY: 0.48, minClear: 1.20 },
  ref_00720:               { groundY: 0.68, minClear: 1.20 },
  ref_00840:               { groundY: 0.50, minClear: 1.20 },
  ref_01500:               { groundY: 0.23, minClear: 1.20 },
  ref_01800:               { groundY: 0.21, minClear: 1.20 },
  ref_02220:               { groundY: 0.62, minClear: 1.20 },

  shot_beach_establishing: { groundY: 1.95, minClear: 1.40 },
  shot_forerunner_bridge:  { groundY: 0.42, minClear: 1.40 },
  shot_bridge_underside:   { groundY: 0.80, minClear: 1.40 },
  shot_hero_stack:         { groundY: 0.07, minClear: 1.40 },
  shot_stack_gauntlet:     { groundY: -0.78, minClear: 1.40 },
  shot_shoreline:          { groundY: -0.25, minClear: 1.20 },
  shot_tide_pools:         { groundY: -0.17, minClear: 1.20 },
  shot_water_edge:         { groundY: 0.12, minClear: 1.40 },
  shot_cliff_vegetation:   { groundY: 7.27, minClear: 1.40 },
  shot_sky_ring:           { groundY: 0.58, minClear: 1.00 },
  shot_weapon_detail:      { groundY: 1.19, minClear: 0.40 },
  shot_overview:           { groundY: null, minClear: 20.0 },

  diag_sky:    { groundY: null, minClear: 4.0 },
  diag_zenith: { groundY: null, minClear: 4.0 },
  diag_water:  { groundY: null, minClear: 1.0 },
  diag_terrain:{ groundY: null, minClear: 4.0 },
  diag_bridge: { groundY: null, minClear: 1.0 },
  diag_stack:  { groundY: null, minClear: 1.0 },
  diag_gun:    { groundY: 1.48, minClear: 0.10 },
};

/**
 * How far the baked `groundY` may drift before the pose is called stale. A terrain
 * edit that raises the ground under a showcase pose by more than this has changed
 * the shot even if the camera is still technically above the surface.
 */
export const GROUND_DRIFT_TOL = 0.60;

/* --------------------------------------------------------------- self-check */

/**
 * Structural check, run at import. Cheap, needs no terrain, and fires in the browser
 * as well as in node — so a malformed pose is loud instead of silently producing a
 * black frame. (KNOWN_ISSUES 20: silence is the whole problem.)
 */
function selfCheck() {
  const bad = [];
  for (const [name, p] of Object.entries(POSES)) {
    if (!Array.isArray(p.pos) || p.pos.length !== 3 || !p.pos.every(Number.isFinite))
      bad.push(`${name}: pos must be 3 finite numbers`);
    if (!Array.isArray(p.rot) || p.rot.length < 2 || !p.rot.slice(0, 2).every(Number.isFinite))
      bad.push(`${name}: rot must be [pitch, yaw, roll]`);
    if (!Number.isFinite(p.fov) || p.fov < 20 || p.fov > 130)
      bad.push(`${name}: fov ${p.fov} out of range`);
    if (!POSE_GROUND[name])
      bad.push(`${name}: no POSE_GROUND entry — add one and run tools/_posecheck.mjs`);
  }
  for (const name of Object.keys(POSE_GROUND))
    if (!POSES[name]) bad.push(`POSE_GROUND has a stale entry for ${name}`);
  if (bad.length) {
    const msg = '[poses] MALFORMED POSE TABLE:\n  ' + bad.join('\n  ');
    console.error(msg);
    throw new Error(msg);
  }
}
selfCheck();

/**
 * Ground-clearance audit against a live terrain module.
 *
 * `terrain` is anything exposing `height(x, z)` — i.e. the module returned by
 * `src/world/terrain.js`, which is the same field `physics.raycast` marches and the
 * same one `FIELD_GLSL` evaluates on the GPU. Pass `terrain.raycast` too and it is
 * used as a second, independent witness: `terrain.raycast` returns null outright when
 * the origin is below the surface, so a pose that fails both is definitely buried.
 *
 * @returns {Array<{name,eyeY,groundY,bakedY,drift,clearance,minClearance,status,note}>}
 *          sorted worst-first. status is 'FAIL' | 'WARN' | 'ok'.
 */
/**
 * Straight-down direction in the shape `terrain.raycast` expects (it calls
 * `dir.clone().normalize()`). Written by hand so `poses.js` stays dependency-free —
 * every tool in `tools/` imports this module, several of them without three.
 */
function downVec() {
  const v = { x: 0, y: -1, z: 0 };
  v.normalize = () => v;
  v.clone = () => downVec();
  return v;
}

export function auditPoses(terrain, { drift = GROUND_DRIFT_TOL } = {}) {
  if (!terrain || typeof terrain.height !== 'function')
    throw new Error('auditPoses(terrain): needs a terrain module with height(x,z)');

  const rows = [];
  for (const [name, p] of Object.entries(POSES)) {
    const [x, eyeY, z] = p.pos;
    const groundY = terrain.height(x, z);
    const g = POSE_GROUND[name] || { groundY: null, minClear: 0.10 };
    const clearance = eyeY - groundY;
    const bakedY = g.groundY;
    const d = bakedY == null ? 0 : groundY - bakedY;

    let status = 'ok', note = '';
    if (!Number.isFinite(groundY)) {
      status = 'FAIL'; note = 'terrain.height() returned non-finite';
    } else if (clearance <= 0) {
      status = 'FAIL'; note = `camera is ${(-clearance).toFixed(2)} m UNDER the terrain`;
    } else if (clearance < g.minClear) {
      status = 'FAIL'; note = `clearance ${clearance.toFixed(2)} m < required ${g.minClear.toFixed(2)} m`;
    } else if (bakedY != null && Math.abs(d) > drift) {
      status = 'WARN'; note = `ground moved ${d > 0 ? '+' : ''}${d.toFixed(2)} m since this pose was verified — recheck the framing, then rebake`;
    }

    // Second witness: terrain.raycast bails out immediately when the origin is below
    // the surface, so it fails a buried pose for a completely different reason than
    // the height comparison above does.
    if (status !== 'FAIL' && typeof terrain.raycast === 'function') {
      const probe = terrain.raycast({ x, y: eyeY, z }, downVec(), 60);
      if (probe === null && clearance > 0.05 && clearance < 50) {
        status = 'WARN';
        note = note || 'terrain.raycast could not find ground straight down — check for a hole in the field';
      }
    }

    rows.push({ name, eyeY, groundY, bakedY, drift: d, clearance,
                minClearance: g.minClear, status, note });
  }
  const rank = { FAIL: 0, WARN: 1, ok: 2 };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || a.clearance - b.clearance);
  return rows;
}

/**
 * Hard assertion for callers that would rather crash than render a buried camera.
 * Throws on any FAIL; logs WARNs.
 */
export function assertPosesAboveGround(terrain, opts) {
  const rows = auditPoses(terrain, opts);
  const fails = rows.filter((r) => r.status === 'FAIL');
  const warns = rows.filter((r) => r.status === 'WARN');
  for (const w of warns) console.warn(`[poses] ${w.name}: ${w.note}`);
  if (fails.length) {
    const msg = '[poses] camera below terrain:\n  '
      + fails.map((r) => `${r.name}: eye ${r.eyeY.toFixed(2)}, ground ${r.groundY.toFixed(2)}, ${r.note}`).join('\n  ');
    console.error(msg);
    throw new Error(msg);
  }
  return rows;
}

/** Poses that have a reference frame to score against. */
export const REF_POSES = Object.keys(POSES).filter((k) => k.startsWith('ref_'));

/** The curated preview-sheet tour, in sheet order. */
export const SHOWCASE_POSES = Object.keys(POSES).filter((k) => k.startsWith('shot_'));

/** ref_00450 -> ref/keyframes/kf_00450.png */
export function refFrameFor(poseName) {
  const m = /^ref_(\d+)$/.exec(poseName);
  return m ? `ref/keyframes/kf_${m[1]}.png` : null;
}
