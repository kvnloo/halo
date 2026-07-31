import * as THREE from 'three';

/**
 * `player` — first-person controller, head bob, camera authority.
 *
 * Everything here is derived from `research/feel.md` (Halo CE / H2EK tag values, Quake 3
 * and Source SDK source, GDC 2016 "Building a Better Jump"). Section numbers below refer
 * to that document. Where a constant is [VERIFIED] there it is [VERIFIED] here.
 *
 * SCALE. Halo's biped is 2.134 m; this one is 1.86 m. Feel is preserved under *dynamic
 * (Froude) similarity* — lengths × k, times × √k, speeds × √k, **accelerations and
 * gravity unchanged** (feel.md §1.4). k = 1.86/2.134 = 0.8716, √k = 0.93359. Shrinking
 * the body and keeping the speeds gives a sprinting gnome; shrinking the jump and
 * keeping gravity gives "heavy but can't climb anything", which breaks the level metrics.
 *
 * The five things that make this read as Halo rather than as a generic FPS:
 *
 *  - **Velocity-targeted acceleration** (feel.md §2.2), i.e. the branch id shipped
 *    `#if`-ed out of `PM_Accelerate` with the comment "proper way … but feels bad".
 *    Feels bad for an arena shooter *is* feels grounded for Halo. Separate ACCEL/DECEL
 *    (the biped tag has separate fields), and a snap to zero under 0.15 m/s, so the
 *    coast after releasing the stick is 0.44 m and not the 0.60 m that multiplicative
 *    Quake friction gives. Multiplicative friction as the only brake is the #1 cause of
 *    "the character slides".
 *  - **An elliptical speed envelope** (feel.md §2.1): forward 2.25 wu/s, back and side
 *    2.00 wu/s, clamped to an ellipse and not to a circle, so a diagonal is 6% down on
 *    straight and a strafe is 11% down. Both cross-verified against the H2EK metrics
 *    page and community measurement.
 *  - **Halo's jump**: near-Earth gravity (10.14 m/s², 1.03 g), an *enormous* apex
 *    (2.12 m here, 2.44 m at Spartan scale — taller than the character), 1.29 s of hang,
 *    and air control that is a nudge and not a steering wheel. Every other shooter
 *    raises gravity to 1.5–2 g to buy a short airtime; Halo does not, and buys the
 *    float back with commitment instead. This is the single most identifiable movement
 *    signature in the game (feel.md §2.5–2.6).
 *  - **Bob lives in the hands, not the head** (feel.md §3.1). HL2's player camera does
 *    not bob at all and the CE biped tag has no bob fields; all of it is viewmodel. The
 *    camera here gets ~20% of the energy (0.35 cm vertical = 0.20% of eye height, well
 *    under the 2% nausea ceiling) and `handBobOffset` / `handBobAngles` carry the other
 *    80% for the viewmodel.
 *  - **A two-tier landing** (feel.md §3.3) on a damped spring with ζ = 0.67, plus a
 *    brief input lock on the hard tier — the strongest "you have mass" signal available.
 *
 * TIMESTEP. `simulate()` runs on a fixed 1/120 s accumulator owned by this module, with
 * render-time interpolation of position / dip / step / bob phase, because `Engine.js`
 * hands us a variable render-rate dt outside capture (see docs/KNOWN_ISSUES.md). View
 * angles are integrated at *render* rate, outside the tick — mouse input is displacement,
 * never a rate, and must never be multiplied by dt (feel.md §5.1, §6.1).
 *
 * CAMERA AUTHORITY. In `deterministic` (capture) mode this module never writes to the
 * camera: `__HALO__.setPose` owns it, and every measurement in the project depends on
 * that. It instead reads the camera each frame so `position` / `eye` / `yaw` / `pitch`
 * stay meaningful for consumers (audio listener, LOD, AI) at the harness's pose. That
 * also means **nothing in this file can move a scored capture**: `TUNE.fovBase` governs
 * live play only, `src/world/poses.js` governs capture and is immutable substrate.
 *
 * Collision is `physics.moveCharacter` — this file contains no collision code. The
 * environment modules land concurrently, so every cross-module call is guarded and there
 * is a flat-ground degraded path for the window where `terrain` is a stub.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const { clamp, lerp } = THREE.MathUtils;

/** Frame-rate independent exponential approach factor. */
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);
/** smoothstep on an already-clamped 0..1 parameter. */
const sstep = (u) => u * u * (3 - 2 * u);

/* Froude similarity to Halo's 2.134 m biped — see the header. */
const K = 1.86 / 2.134;          // 0.87160  — length scale
const KS = Math.sqrt(K);         // 0.93359  — time / speed scale

/** Movement / feel constants. Tags marked [V] are verified primary-source values
 *  (H2EK metrics page / c20 biped+globals / Q3 + Source SDK), scaled by K or KS where
 *  they are lengths or speeds. See research/feel.md for every citation. */
export const TUNE = {
  /* --- body --------------------------------------------------------------- */
  eyeStand: 1.72,
  eyeCrouch: 1.05,
  radius: 0.42,
  standHeight: 1.86,
  crouchHeight: 1.20,
  stepHeight: 0.366 * K,          // 0.319 [V] H2EK ground step height, standing
  stepCrouch: 0.244 * K,          // 0.213 [V] H2EK ground step height, crouched
  maxSlopeDeg: 45,                // [V] H2EK max walkable slope
  terminal: 58,
  spawn: { x: 6, z: 16, yawDeg: 288 },

  /* --- ground speeds (m/s) ------------------------------------------------ */
  // [V] globals/player information, NTSC: 2.25 / 2.00 / 2.00 / 0.512 wu/s × 3.048 × KS
  walk: 6.858 * KS,               // 6.403 — the DEFAULT. No modifier held.
  runBack: 6.096 * KS,            // 5.691
  runSide: 6.096 * KS,            // 5.691
  slowWalk: 1.561 * KS,           // 1.457 — held walk modifier (Alt)
  crouchSpeed: 0.45 * 6.858 * KS, // 2.881
  sprint: 1.30 * 6.858 * KS,      // 8.324 — Campaign Evolved only, "not drastically
                                  // faster than the original movement speed"
  /* --- acceleration (m/s², Froude-invariant) ------------------------------ */
  groundAccel: 29.3,              // [V-ish] 0.32 wu/s/tick × 30 → 0 to top in 0.234 s
  decel: 44.0,                    // 1.5 × accel → measured 0.150 s stop, 0.440 m coast
  airAccel: 5.5,                  // 19% of ground: redirect only, no speed gain
  stopSnap: 0.15,                 // below this, velocity snaps to zero

  /* --- jump / gravity ----------------------------------------------------- */
  gravity: 10.14,                 // 1.03 g. Halo is the outlier; do NOT "fix" this.
  gravityFallMul: 1.0,            // 1.4–1.6 shortens the descent without losing apex
  jumpApex: 2.438 * K,            // 2.125 m — a ledge taller than the player
  coyote: 0.11,
  jumpBufferTime: 0.13,
  jumpGrace: 0.09,

  /* --- slopes (feel.md §2.7, biped tag falloff/cutoff pairs) --------------- */
  slopeUpFalloff: 15, slopeUpCutoff: 45, slopeUpScale: 0.65,
  slopeDownFalloff: 10, slopeDownCutoff: 40, slopeDownScale: 1.15,

  /* --- look --------------------------------------------------------------- */
  mouseDPI: 800,
  cm360: 35,                      // user-facing unit. 20–60 competitive, 30–45 Halo pace
  sensitivity: 360 / (800 * 35 / 2.54) * DEG,   // 5.700e-4 rad/count
  pitchLimit: 89 * DEG,
  recoilRetain: 0.18,
  recoilSnap: 17,
  recoilBleed: 1.25,
  recoilMaxPitch: 14 * DEG,

  /* --- stick (feel.md §5.2 — five stages) --------------------------------- */
  padDeadzone: 0.15,              // scaled radial (Sutphin)
  padMaxInput: 0.05,              // saturation shelf
  padExp: 2,                      // response curve
  padYawRate: 120 * DEG,          // per second at full deflection
  padPitchRate: 90 * DEG,         // 0.75 × yaw, the near-universal convention
  lookPegThreshold: 0.90,
  lookAccelTime: 0.35,
  lookAccelScale: 2.5,            // 120 → 300 °/s after 0.35 s pegged

  /* --- fov ---------------------------------------------------------------- */
  // 70° horizontal at 4:3 [V] = 55.41° vertical. three.js fov is VERTICAL; keeping it
  // fixed and letting aspect widen the horizontal is Hor+ (86.1° at 16:9).
  fovBase: 2 * Math.atan(Math.tan(35 * DEG) / (4 / 3)) / DEG,
  fovSprint: 4.0,
  fovRate: 6.0,

  /* --- bob (camera: ~20% of the energy, feel.md §3.1/§3.2) ---------------- */
  strideBase: 1.10,               // metres per STRIDE (= 2 steps) at a standstill…
  strideSlope: 0.38,              // …+ this per m/s ⇒ 1.77 m/step, 3.6 steps/s at run
  bobVert: 0.0035,                // 0.20% of eye height (ceiling is 2%)
  bobLat: 0.0030,
  bobFore: 0.0018,
  bobRoll: 0.12 * DEG,            // ceiling is 1.5°
  bobPitch: 0.08 * DEG,
  bobYaw: 0.05 * DEG,
  handBobMul: 4.0,                // the other 80%, for the viewmodel
  airLagTau: 0.15,                // first-order lag on the airborne hand float

  /* --- landing (feel.md §3.3, two tiers) ---------------------------------- */
  minSoftLand: 4.6 * KS,          // 4.294 m/s
  minHardLand: 9.1 * KS,          // 8.496
  maxHardLand: 15.2 * KS,         // 14.191
  deathLand: 19.8 * KS,           // 18.485
  softDip: 0.06 * K,              // 0.0523 m — 3% of eye height
  hardDip: 0.20 * K,              // 0.1743 m — 10%
  extremeDip: 0.38 * K,           // 0.3312 m — 19%
  landZeta: 0.67,                 // Source PUNCH k=35/c=9 territory: ~6% overshoot
  landOmegaSoft: 12.0,            // 10%-recovery 0.29 s ≈ "maximum soft landing time"
  landOmegaHard: 6.71,            // 0.51 s / settle 0.89 s ≈ "maximum hard landing time"
  landLockTime: 0.25,             // input lock on the hard tier
  landPitchPerM: 0.35,            // radians of nose-down per metre of dip

  /* --- step smoothing (feel.md §3.4) -------------------------------------- */
  stepSmoothT: 0.18 * KS,         // 0.168 s, smoothstep — no velocity jump at either end
  stepSmoothMax: 0.65,

  /* --- crouch (feel.md §3.5 — Source TIME_TO_DUCK/UNDUCK) ----------------- */
  crouchDownTime: 0.25,
  crouchUpTime: 0.20,

  /* --- damage ------------------------------------------------------------- */
  shieldDelay: 4.0,
  shieldTime: 2.4,
  shieldRampTime: 0.42,
  healthDelay: 8.0,
  healthRate: 0.05,
  fallSafe: 9.1 * KS,             // = minHardLand: a hard landing is where damage starts
  fallLethal: 19.8 * KS,          // = deathLand
  respawnTime: 2.6,

  /* --- water -------------------------------------------------------------- */
  wadeFull: 1.30,
  wadeSlow: 0.50,
  wadeSprintCut: 0.45,
  swimSpeed: 2.5,
  swimDrag: 2.2,
};

/* Fixed simulation step. feel.md §6.1: DT, MAX_FRAME, MAX_STEPS, render interpolation. */
const SIM_DT = 1 / 120;      // 2x the usual display rate: halves the interpolation lag
const MAX_FRAME = 0.25;
const MAX_STEPS = 16;

export function create(opts = {}) {
  const T = TUNE;
  const JUMP_V = Math.sqrt(2 * T.gravity * T.jumpApex);   // 6.5634 m/s
  // Peak of an underdamped spring kicked with velocity v0 is (v0/ω)·exp(−ζ·acos ζ/√(1−ζ²)).
  // Invert it so the *nominal* dip is the *achieved* dip instead of ~48% of it.
  const zt = T.landZeta;
  const PEAK_GAIN = Math.exp(-zt * Math.acos(zt) / Math.sqrt(1 - zt * zt));  // 0.4705

  /* ------------------------------------------------------------------ state */
  const pos = new THREE.Vector3(T.spawn.x, 0, T.spawn.z);       // FEET
  const eye = new THREE.Vector3();                              // camera position
  const vel = new THREE.Vector3();
  const viewBobOffset = new THREE.Vector3();                    // camera-local metres
  const viewBobAngles = new THREE.Euler(0, 0, 0, 'YXZ');        // radians
  const handBobOffset = new THREE.Vector3();                    // viewmodel channel
  const handBobAngles = new THREE.Euler(0, 0, 0, 'YXZ');
  const lookDir = new THREE.Vector3(0, 0, -1);
  const forward = new THREE.Vector3(0, 0, -1);                  // horizontal
  const right = new THREE.Vector3(1, 0, 0);
  const groundNormal = new THREE.Vector3(0, 1, 0);

  let yaw = T.spawn.yawDeg * DEG, pitch = 0;
  let recoilP = 0, recoilY = 0, settleP = 0, settleY = 0;
  let grounded = false, crouching = false, sprinting = false, swimming = false;
  let dead = false, respawnAt = 0;
  let health = 1, shield = 1, lastHitT = -1e3;
  let eyeHeight = T.eyeStand;
  let surface = 'sand';
  let wade = 0, waterDepth = 0;

  let coyote = 0, jumpBuffer = 0, jumpGrace = 0, landLock = 0;
  let stepPhase = 0, stepIndex = 0, bobBlend = 0, sprintBlend = 0, crouchBlend = 0;
  let sprintLean = 0;
  let dipPos = 0, dipVel = 0, dipOmega = T.landOmegaHard;
  let stepAmp = 0, stepT = -10, stepOffset = 0;
  let airLag = 0;
  let fov = T.fovBase;
  let simT = 0, accum = 0;
  let physicsFailFrame = 0;
  let captureMode = false, boundInput = false;

  /* Previous-tick state for render interpolation (feel.md §6.1). */
  const prevPos = new THREE.Vector3();
  let prevDip = 0, prevStepOffset = 0, prevEyeHeight = T.eyeStand, prevPhase = 0,
      prevBob = 0, prevAirLag = 0, snapNext = true;

  /* --------------------------------------------------------------- scratch */
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _p = new THREE.Vector3();
  const _bobW = new THREE.Vector3(), _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _fallback = { position: new THREE.Vector3(), grounded: false,
                      groundNormal: new THREE.Vector3(0, 1, 0), surface: 'sand' };
  const _moveOpts = { radius: T.radius, height: T.standHeight, stepHeight: T.stepHeight,
                      maxSlopeDeg: T.maxSlopeDeg, mask: 1 };
  const _ip = new THREE.Vector3();

  /* ------------------------------------------------------------------ input */
  const keys = Object.create(null);
  let mouseDX = 0, mouseDY = 0;
  let wantJump = false, locked = false;
  let padMoveX = 0, padMoveZ = 0, padLookX = 0, padLookY = 0;
  let padJump = false, padJumpEdge = false, padCrouch = false, padSprint = false, padWalk = false;
  let pegRamp = 0, padActive = false, padLookMag = 0;
  const listeners = [];
  let clickEl = null, canvasEl = null;

  const KEY_F = ['KeyW', 'ArrowUp'], KEY_B = ['KeyS', 'ArrowDown'];
  const KEY_L = ['KeyA', 'ArrowLeft'], KEY_R = ['KeyD', 'ArrowRight'];
  const down = (list) => list.some((k) => keys[k]) ? 1 : 0;

  function bindInput(ctx) {
    if (boundInput || typeof document === 'undefined') return;
    canvasEl = ctx.renderer?.domElement || null;
    if (!canvasEl) return;
    clickEl = document.getElementById('click');
    boundInput = true;

    const on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); listeners.push([el, ev, fn]); };

    on(window, 'keydown', (e) => {
      if (e.repeat) return;
      keys[e.code] = true;
      if (e.code === 'Space') { wantJump = true; jumpBuffer = T.jumpBufferTime; }
      if (locked && (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab')) e.preventDefault();
    });
    on(window, 'keyup', (e) => { keys[e.code] = false; if (e.code === 'Space') wantJump = false; });
    on(window, 'blur', () => { for (const k in keys) keys[k] = false; wantJump = false; mouseDX = mouseDY = 0; });

    // Mouse is DISPLACEMENT. Accumulate raw counts here, apply once per render frame,
    // never scale by dt. getCoalescedEvents recovers the sub-frame samples a 1000 Hz
    // mouse produced that the browser batched into one event (feel.md §5.1).
    const moveEv = (typeof window !== 'undefined' && window.PointerEvent) ? 'pointermove' : 'mousemove';
    on(document, moveEv, (e) => {
      if (!locked) return;
      const evs = (moveEv === 'pointermove' && e.getCoalescedEvents) ? e.getCoalescedEvents() : null;
      if (evs && evs.length) {
        for (const ev of evs) { mouseDX += ev.movementX || 0; mouseDY += ev.movementY || 0; }
      } else {
        mouseDX += e.movementX || 0; mouseDY += e.movementY || 0;
      }
    });
    on(document, 'pointerlockchange', () => {
      locked = document.pointerLockElement === canvasEl;
      mouseDX = mouseDY = 0;
      if (clickEl) clickEl.classList.toggle('hidden', locked);
    });
    const grab = () => { if (!locked) canvasEl.requestPointerLock?.(); };
    on(canvasEl, 'click', grab);
    if (clickEl) { on(clickEl, 'click', grab); clickEl.style.pointerEvents = 'auto'; clickEl.classList.remove('hidden'); }
  }

  function unbindInput() {
    for (const [el, ev, fn] of listeners) el.removeEventListener(ev, fn);
    listeners.length = 0;
    boundInput = false;
  }

  /**
   * Stick shaping, stages 1–3 of feel.md §5.2: scaled-radial deadzone (Sutphin — keeps
   * the full 0..1 output range with no jump at the boundary), a max-input saturation
   * shelf, then the response curve. Returns magnitude in `out[2]`.
   */
  const _stick = [0, 0, 0];
  function stickShape(x, y, exp) {
    const m = Math.hypot(x, y);
    if (m < T.padDeadzone) { _stick[0] = _stick[1] = _stick[2] = 0; return _stick; }
    const t = Math.min((m - T.padDeadzone) / (1 - T.padDeadzone - T.padMaxInput), 1);
    const c = exp === 1 ? t : Math.pow(t, exp);
    _stick[0] = x / m * c; _stick[1] = y / m * c; _stick[2] = t;
    return _stick;
  }

  /** Poll the gamepad once per render frame. Never runs in capture mode. */
  function pollPad() {
    padActive = false;
    padMoveX = padMoveZ = padLookX = padLookY = 0;
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') return;
    let gp = null;
    const pads = nav.getGamepads();
    for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
    if (!gp) { padJump = false; return; }
    padActive = true;
    const a = gp.axes, b = gp.buttons;
    const mv = stickShape(a[0] || 0, a[1] || 0, 1);          // movement: linear
    padMoveX = mv[0]; padMoveZ = -mv[1];
    const lk = stickShape(a[2] || 0, a[3] || 0, T.padExp);   // look: curved
    padLookX = lk[0]; padLookY = lk[1];
    padLookMag = lk[2];
    const pressed = (i) => !!(b && b[i] && b[i].pressed);
    const j = pressed(0);
    padJumpEdge = j && !padJump;
    padJump = j;
    padCrouch = pressed(1);
    padSprint = pressed(10);                                  // L3, Campaign Evolved
    padWalk = pressed(11);
  }

  /* --------------------------------------------------- world query helpers */

  /** Ground height under (x,z) for the degraded path. Never throws. */
  function groundY(ctx, x, z) {
    const t = ctx.get('terrain');
    if (t && typeof t.height === 'function') {
      const h = t.height(x, z);
      if (Number.isFinite(h)) return h;
    }
    return 0;
  }

  const stepH = () => (crouching ? T.stepCrouch : T.stepHeight);

  /**
   * Move the capsule. Uses `physics.moveCharacter` — no collision is implemented here.
   * While the environment agents are mid-flight `terrain` can be a stub without
   * `height()`, which makes physics throw; that is caught once, logged, and retried
   * every two seconds so we pick the real thing up the moment it lands.
   */
  function moveCapsule(ctx, from, delta) {
    const ph = ctx.get('physics');
    const terr = ctx.get('terrain');
    const hasHeight = !!(terr && typeof terr.height === 'function');
    if (physicsFailFrame && ctx.clock.frame - physicsFailFrame > 120) physicsFailFrame = 0;

    if (!physicsFailFrame && (hasHeight || !terr) && ph && typeof ph.moveCharacter === 'function') {
      try {
        _moveOpts.height = crouching ? T.crouchHeight : T.standHeight;
        _moveOpts.stepHeight = stepH();
        _moveOpts.maxSlopeDeg = T.maxSlopeDeg;
        _moveOpts.mask = ph.MASK ? ph.MASK.WORLD : 1;
        const r = ph.moveCharacter(from, delta, _moveOpts);
        if (!hasHeight) {
          if (r.position.y <= 0) { r.position.y = 0; r.grounded = true; r.groundNormal.set(0, 1, 0); }
          else if (r.position.y < 0.06) r.grounded = true;
        }
        return r;
      } catch (e) {
        physicsFailFrame = ctx.clock.frame || 1;
        console.warn('[player] physics.moveCharacter threw, using flat ground for now:', e.message);
      }
    }

    // Degraded path: no collision world yet. Sit on terrain height (or y=0).
    const r = _fallback;
    r.position.copy(from).add(delta);
    const gy = groundY(ctx, r.position.x, r.position.z);
    r.grounded = false;
    r.groundNormal.set(0, 1, 0);
    r.surface = 'sand';
    if (r.position.y <= gy) { r.position.y = gy; r.grounded = true; }
    else if (r.position.y - gy < 0.06) r.grounded = true;
    return r;
  }

  /** Water depth above the feet, 0 when dry. `ocean` may be null or a stub. */
  function measureWater(ctx) {
    const ocean = ctx.get('ocean');
    if (!ocean) return 0;
    try {
      if (typeof ocean.level === 'number' && pos.y > ocean.level + 2.0) return 0;
      if (typeof ocean.isSubmerged === 'function') {
        _p.set(pos.x, pos.y + 0.06, pos.z);
        if (!ocean.isSubmerged(_p)) return 0;
        let lo = 0.06, hi = T.eyeStand + 0.35;
        _p.y = pos.y + hi;
        if (ocean.isSubmerged(_p)) return hi;
        for (let i = 0; i < 5; i++) {
          const m = (lo + hi) * 0.5;
          _p.y = pos.y + m;
          if (ocean.isSubmerged(_p)) lo = m; else hi = m;
        }
        return lo;
      }
      if (typeof ocean.level === 'number') return Math.max(0, ocean.level - pos.y);
    } catch { /* half-built ocean — treat as dry */ }
    return 0;
  }

  /* ------------------------------------------------------------- locomotion */

  /**
   * feel.md §2.1. Halo's max speed is an ELLIPSE — forward 2.25 wu/s, back and side
   * 2.00 wu/s — not a circle with a fudge factor. Writes the wish direction into `_w`
   * and returns the wish speed.
   *
   *   v_max(θ) = 1 / hypot(cosθ / v_along, sinθ / v_side)
   *
   * Verified ratios: forward 1.000, 45° 0.940 (community-measured "5% slower"),
   * strafe and backpedal 0.889 (measured "12% slower").
   */
  function wishVelocity(inZ, inX, sMul) {
    const m = Math.hypot(inZ, inX);
    if (m < 1e-5) { _w.set(0, 0, 0); return 0; }
    const uz = inZ / m, ux = inX / m;
    const vAlong = (uz > 0 ? T.walk : T.runBack) * sMul;
    const vSide = T.runSide * sMul;
    const r = 1 / Math.hypot(ux / vSide, uz / vAlong);
    _w.set(0, 0, 0).addScaledVector(forward, uz).addScaledVector(right, ux);
    const wl = Math.hypot(_w.x, _w.z);
    if (wl > 1e-6) { _w.x /= wl; _w.z /= wl; } else { _w.set(0, 0, 0); return 0; }
    return Math.min(m, 1) * r;
  }

  /**
   * feel.md §2.2 — velocity-targeted acceleration. This is the branch id shipped
   * `#if`-ed out of Q3's `PM_Accelerate` ("proper way (avoids strafe jump maxspeed
   * bug), but feels bad"). It cannot be exploited by turning, and it unifies
   * acceleration and braking: a zero wish decelerates at the same call site.
   */
  function accelerateToward(wx, wz, rate, dt) {
    const dx = wx - vel.x, dz = wz - vel.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const step = Math.min(rate * dt, len);
    vel.x += dx / len * step;
    vel.z += dz / len * step;
  }

  /**
   * feel.md §2.7 — the biped tag's slope model, as a multiplier on wish speed.
   * Below `falloff` the scale is 1; between falloff and cutoff it lerps to the
   * velocity scale; above cutoff it stays there. Without this, running up a 30° ramp
   * at unchanged speed makes the level read as a flat plane with painted-on relief.
   */
  function slopeScale(dx, dz) {
    if (!grounded) return 1;
    const nh = Math.hypot(groundNormal.x, groundNormal.z);
    if (nh < 1e-4) return 1;
    const ang = Math.acos(clamp(groundNormal.y, -1, 1)) / DEG;
    const ux = -groundNormal.x / nh, uz = -groundNormal.z / nh;   // horizontal uphill dir
    const s = dx * ux + dz * uz;                                  // +1 straight uphill
    if (s >= 0) {
      const u = clamp((ang - T.slopeUpFalloff) / (T.slopeUpCutoff - T.slopeUpFalloff), 0, 1);
      return lerp(1, lerp(1, T.slopeUpScale, u), s);
    }
    const u = clamp((ang - T.slopeDownFalloff) / (T.slopeDownCutoff - T.slopeDownFalloff), 0, 1);
    return lerp(1, lerp(1, T.slopeDownScale, u), -s);
  }

  /* ----------------------------------------------------------------- damage */

  function emitDamaged(ctx, amount, direction) {
    lastHitT = ctx.clock.t;
    ctx.emit('player:damaged', { amount, direction: direction || null,
                                 shield, health, dead });
    const hud = ctx.get('hud');
    if (hud && typeof hud.flashDamage === 'function') { try { hud.flashDamage(direction); } catch {} }
  }

  function applyDamage(ctx, amount, direction) {
    if (dead || amount <= 0 || ctx.config.godMode) return;
    let a = amount;
    if (shield > 0) {
      const s = Math.min(shield, a);
      shield -= s; a -= s;
      if (shield <= 1e-4) { shield = 0; ctx.emit('player:shieldBroken', { direction: direction || null }); }
    }
    if (a > 0) health = Math.max(0, health - a);
    emitDamaged(ctx, amount, direction);
    if (health <= 0 && !dead) {
      dead = true;
      respawnAt = ctx.clock.t + T.respawnTime;
      ctx.emit('player:died', { position: pos.clone() });
    }
  }

  function respawn(ctx) {
    dead = false; health = 1; shield = 1;
    vel.set(0, 0, 0);
    pos.set(T.spawn.x, groundY(ctx, T.spawn.x, T.spawn.z), T.spawn.z);
    yaw = T.spawn.yawDeg * DEG; pitch = 0;
    recoilP = recoilY = settleP = settleY = 0;
    dipPos = dipVel = stepAmp = stepOffset = airLag = 0;
    stepPhase = 0; stepIndex = 0; bobBlend = 0; landLock = 0;
    snapNext = true;
    ctx.emit('player:respawn', { position: pos.clone() });
  }

  /* ------------------------------------------------------------- footsteps */

  function emitFootstep(ctx, hard) {
    const foot = (stepIndex & 1) ? 1 : -1;
    const mat = waterDepth > 0.12 ? 'water' : surface;
    _p.copy(pos).addScaledVector(right, foot * T.radius * 0.55);
    ctx.emit('player:footstep', {
      position: _p.clone(),
      material: mat,
      surface: mat,
      running: sprinting,
      foot: foot > 0 ? 'r' : 'l',
      speed: Math.hypot(vel.x, vel.z),
      wade: waterDepth,
      volume: clamp((hard ? 1.25 : 0.42 + 0.58 * bobBlend) * (crouching ? 0.35 : 1), 0, 1.4),
      hard: !!hard,
    });
  }

  /* ------------------------------------------------------------------- api */

  const api = {
    name: 'player',
    order: 70,
    enabled: true,

    /* --- docs/API.md surface -------------------------------------------- */
    position: pos,          // feet
    eye,                    // camera position
    velocity: vel,
    get yaw() { return yaw + recoilY; },
    get pitch() { return pitch + recoilP; },
    get grounded() { return grounded; },
    get crouching() { return crouching; },
    get sprinting() { return sprinting; },
    get health() { return health; },
    get shield() { return shield; },
    /**
     * `amount` is in the SAME UNITS as `health` and `shield`, which docs/API.md
     * defines as 0..1. A full shield is 1.0, so `damage(0.25)` takes a quarter of it
     * and `damage(1.0)` strips the shield entirely.
     */
    damage(amount, direction) {
      if (api._ctx && Number.isFinite(amount)) applyDamage(api._ctx, amount, direction);
    },
    applyRecoil(p, y) {
      recoilP = clamp(recoilP + (p || 0), -T.recoilMaxPitch, T.recoilMaxPitch);
      recoilY = clamp(recoilY + (y || 0), -T.recoilMaxPitch, T.recoilMaxPitch);
      settleP = clamp(settleP + (p || 0) * T.recoilRetain, -T.recoilMaxPitch, T.recoilMaxPitch);
      settleY = clamp(settleY + (y || 0) * T.recoilRetain, -T.recoilMaxPitch, T.recoilMaxPitch);
    },
    /**
     * Head bob as a CAMERA-LOCAL offset in metres, three.js axes: +x right, +y up,
     * +z *backward*. It is ALREADY applied to the camera, and it is deliberately TINY
     * — 0.35 cm vertical at a full run, 0.20% of eye height, ~20% of the total bob
     * energy (feel.md §3.1: HL2's player camera does not bob at all and the CE biped
     * tag has no bob fields; the bob belongs in the hands).
     *
     * A viewmodel must NOT drive itself from this. Use `handBobOffset` /
     * `handBobAngles`, which carry the other 80% at full amplitude and are NOT applied
     * to the camera, and use `stepPhase` for the cadence.
     */
    viewBobOffset,
    /** Additive view rotation applied on top of the aim this frame: bob roll/pitch/yaw
     *  + landing dip + sprint lean, radians, YXZ. Already applied to the camera. */
    viewBobAngles,
    /** Full-amplitude bob for the VIEWMODEL, camera-local metres. Not applied to the
     *  camera. Includes the airborne float (first-order lagged, so it is continuous
     *  across takeoff and touchdown — never gate a camera term on `grounded`). */
    handBobOffset,
    /** Full-amplitude bob rotation for the viewmodel, radians, YXZ. */
    handBobAngles,

    lookDir,                // unit world aim direction (includes recoil)
    forward, right,         // horizontal basis
    groundNormal,
    get eyeHeight() { return eyeHeight; },
    get speed() { return Math.hypot(vel.x, vel.z); },
    get surface() { return waterDepth > 0.12 ? 'water' : surface; },
    get wade() { return wade; },
    get waterDepth() { return waterDepth; },
    get swimming() { return swimming; },
    get dead() { return dead; },
    get moving() { return bobBlend > 0.08; },
    /** True during the brief input lock after a hard landing (feel.md §4.7). */
    get inputLocked() { return landLock > 0; },
    /** Step-cycle phase in radians. 2π = one stride = two footfalls; a footfall is
     *  emitted at every multiple of π, which is also where the vertical bob bottoms
     *  out. A viewmodel that keeps its own bob accumulator MUST drive it from this
     *  (or from `stepRate`) rather than from wall time, otherwise the two cycles beat
     *  against each other and the gun visibly detaches from the walk. */
    get stepPhase() { return stepPhase; },
    /** Current d(stepPhase)/dt in rad/s — 0 when not walking. */
    get stepRate() {
      if (!grounded || swimming) return 0;
      const hs = Math.hypot(vel.x, vel.z);
      if (hs <= 0.35) return 0;
      return TAU * hs / strideLen(hs);
    },
    get bobAmount() { return bobBlend; },
    get fov() { return fov; },
    get pointerLocked() { return locked; },
    get captureMode() { return captureMode; },
    heal(a = 1) { health = clamp(health + a, 0, 1); },
    teleport(p, yawDeg) {
      pos.set(p.x, p.y, p.z);
      if (yawDeg != null) yaw = yawDeg * DEG;
      vel.set(0, 0, 0);
      dipPos = dipVel = stepAmp = stepOffset = airLag = 0;
      recoilP = recoilY = settleP = settleY = 0;
      stepPhase = 0; stepIndex = 0; bobBlend = 0; landLock = 0;
      viewBobOffset.set(0, 0, 0); handBobOffset.set(0, 0, 0);
      snapNext = true;
      updateBasis();
    },
    TUNE: T,
    jumpVelocity: JUMP_V,

    /* ------------------------------------------------------------ lifecycle */
    async init(ctx) {
      api._ctx = ctx;
      captureMode = !!(ctx.engine?.opts?.deterministic || opts.capture);

      pos.set(T.spawn.x, groundY(ctx, T.spawn.x, T.spawn.z), T.spawn.z);
      yaw = T.spawn.yawDeg * DEG;
      eyeHeight = T.eyeStand;
      eye.set(pos.x, pos.y + eyeHeight, pos.z);
      prevPos.copy(pos); prevEyeHeight = eyeHeight;
      updateBasis();

      ctx.config.sensitivity ??= T.sensitivity;
      ctx.config.fov ??= T.fovBase;
      ctx.config.invertY ??= false;
      ctx.config.godMode ??= false;
      ctx.config.noclip ??= false;

      if (!captureMode) {
        bindInput(ctx);
        writeCamera(ctx, 1, true);
      } else {
        syncFromCamera(ctx);
      }

      // `__HALO__.setPose` must keep working in the live build too, or every agent
      // inspecting their subsystem in the browser fights the controller for the camera.
      ctx.on('camera:teleport', (p) => {
        if (captureMode) { syncFromCamera(ctx); return; }
        const cam = ctx.camera;
        // A named pose carries its own fov (poses.js pins 78 on every ref_*). Adopt it
        // in the live build too, or an agent inspecting their subsystem through
        // `__HALO__.setPose` in a browser sees a different lens from the capture they
        // are comparing against. Plain gameplay keeps TUNE.fovBase.
        if (p && Number.isFinite(p.fov)) { ctx.config.fov = p.fov; fov = p.fov; }
        _euler.setFromQuaternion(cam.quaternion, 'YXZ');
        pitch = clamp(_euler.x, -T.pitchLimit, T.pitchLimit);
        yaw = _euler.y;
        recoilP = recoilY = settleP = settleY = 0;
        pos.set(cam.position.x, cam.position.y - eyeHeight, cam.position.z);
        vel.set(0, 0, 0);
        dipPos = dipVel = stepAmp = stepOffset = airLag = 0;
        grounded = false; landLock = 0;
        snapNext = true;
        updateBasis();
      });
    },

    /**
     * Render frame. View angles are integrated HERE, at render rate — mouse input is
     * displacement, and burying it in a fixed tick is what produces "my aim feels
     * laggy". The world sim runs on a fixed 1/60 accumulator underneath, and the camera
     * is written from interpolated tick state (feel.md §6.1).
     */
    update(dt, ctx) {
      api._ctx = ctx;
      captureMode = !!(ctx.engine?.opts?.deterministic || opts.capture);
      if (captureMode) { syncFromCamera(ctx); return; }
      if (!api.enabled) return;
      if (ctx.config.frozen) return;
      if (!boundInput) bindInput(ctx);

      const rdt = Math.min(Math.max(dt, 1e-5), MAX_FRAME);
      pollPad();
      updateLook(rdt, ctx);

      accum += rdt;
      let steps = 0;
      while (accum >= SIM_DT && steps < MAX_STEPS) {
        savePrev();
        simulate(SIM_DT, ctx);
        accum -= SIM_DT; steps++; simT += SIM_DT;
      }
      if (steps >= MAX_STEPS) accum = 0;      // give up rather than spiral
      if (steps === 0 && snapNext) savePrev();

      const alpha = snapNext ? 1 : clamp(accum / SIM_DT, 0, 1);
      updateRender(rdt, alpha, ctx);
      snapNext = false;
    },

    dispose() { unbindInput(); },
    _ctx: null,
  };

  /* ------------------------------------------------------------- simulation */

  function savePrev() {
    prevPos.copy(pos);
    prevDip = dipPos; prevStepOffset = stepOffset; prevEyeHeight = eyeHeight;
    prevPhase = stepPhase; prevBob = bobBlend; prevAirLag = airLag;
  }

  function updateBasis() {
    const sy = Math.sin(yaw + recoilY), cy = Math.cos(yaw + recoilY);
    forward.set(-sy, 0, -cy);
    right.set(cy, 0, -sy);
  }

  function strideLen(hs) {
    return clamp(T.strideBase + T.strideSlope * hs, 1.2, 4.2)
           * (crouching ? 0.86 : 1) * (1 + 0.25 * wade);
  }

  /** Capture mode: read the harness pose, write nothing. */
  function syncFromCamera(ctx) {
    const cam = ctx.camera;
    if (!cam) return;
    _euler.setFromQuaternion(cam.quaternion, 'YXZ');
    pitch = _euler.x; yaw = _euler.y;
    recoilP = recoilY = settleP = settleY = 0;
    updateBasis();
    eye.copy(cam.position);
    eyeHeight = T.eyeStand;
    pos.set(cam.position.x, cam.position.y - eyeHeight, cam.position.z);
    prevPos.copy(pos);
    vel.set(0, 0, 0);
    viewBobOffset.set(0, 0, 0);
    viewBobAngles.set(0, 0, 0);
    handBobOffset.set(0, 0, 0);
    handBobAngles.set(0, 0, 0);
    lookDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    grounded = true; sprinting = false; crouching = false; swimming = false;
    bobBlend = 0; stepPhase = 0; dipPos = 0; dipVel = 0; stepAmp = 0; stepOffset = 0;
    airLag = 0; landLock = 0; snapNext = true;
    fov = cam.fov;
  }

  /**
   * Look, at render rate. Mouse: raw counts × rad/count, no dt anywhere. Stick: the
   * five-stage model of feel.md §5.2, of which stage 4 — turn ACCELERATION, ramping to
   * `lookAccelScale` × the base rate over `lookAccelTime` once the stick passes
   * `lookPegThreshold` — is ranked the #3 contributor to Halo's weight. Twitch shooters
   * snap to max turn rate instantly; Halo winds up.
   */
  function updateLook(dt, ctx) {
    const sens = (ctx.config.sensitivity ?? T.sensitivity);
    const invert = ctx.config.invertY ? -1 : 1;
    let dYaw = -mouseDX * sens;
    let dPitch = -mouseDY * sens * invert;
    mouseDX = 0; mouseDY = 0;

    if (padActive) {
      const pegged = padLookMag > T.lookPegThreshold;
      pegRamp = pegged ? Math.min(1, pegRamp + dt / T.lookAccelTime)
                       : Math.max(0, pegRamp - dt / (T.lookAccelTime * 0.5));
      const mul = 1 + (T.lookAccelScale - 1) * pegRamp;
      dYaw += -padLookX * T.padYawRate * mul * dt;
      dPitch += -padLookY * T.padPitchRate * mul * dt * invert;
    } else if (pegRamp > 0) {
      pegRamp = Math.max(0, pegRamp - dt / (T.lookAccelTime * 0.5));
    }

    // Pulling against the settled recoil cancels it instead of double-counting —
    // this is what makes a recoiling weapon controllable rather than a random walk.
    if (dPitch < 0 && settleP > 0) { const e = Math.min(settleP, -dPitch); settleP -= e; recoilP -= e; dPitch += e; }
    else if (dPitch > 0 && settleP < 0) { const e = Math.min(-settleP, dPitch); settleP += e; recoilP += e; dPitch -= e; }
    if (dYaw < 0 && settleY > 0) { const e = Math.min(settleY, -dYaw); settleY -= e; recoilY -= e; dYaw += e; }
    else if (dYaw > 0 && settleY < 0) { const e = Math.min(-settleY, dYaw); settleY += e; recoilY += e; dYaw -= e; }

    if (!dead) { yaw += dYaw; pitch = clamp(pitch + dPitch, -T.pitchLimit, T.pitchLimit); }
    if (yaw > Math.PI) yaw -= TAU; else if (yaw < -Math.PI) yaw += TAU;

    const snap = approach(T.recoilSnap, dt);
    recoilP += (settleP - recoilP) * snap;
    recoilY += (settleY - recoilY) * snap;
    const bleed = Math.exp(-T.recoilBleed * dt);
    settleP *= bleed; settleY *= bleed;
    updateBasis();
  }

  function simulate(dt, ctx) {
    const t = ctx.clock.t;

    /* --------------------------------------------------------------- death */
    if (dead) {
      accelerateToward(0, 0, T.decel, dt);
      vel.y -= T.gravity * dt;
      const r = moveCapsule(ctx, pos, _v.copy(vel).multiplyScalar(dt));
      pos.copy(r.position);
      if (r.grounded) vel.y = 0;
      eyeHeight += (0.42 - eyeHeight) * approach(5, dt);
      bobBlend *= 1 - approach(8, dt);
      stepDecay(dt);
      if (t >= respawnAt) respawn(ctx);
      return;
    }

    /* ---------------------------------------------------------- water state */
    waterDepth = measureWater(ctx);
    wade = clamp(waterDepth / T.wadeFull, 0, 1);
    const wasSwimming = swimming;
    swimming = waterDepth > eyeHeight * 0.92;
    if (swimming !== wasSwimming) ctx.emit(swimming ? 'player:submerged' : 'player:surfaced', { depth: waterDepth });

    /* --------------------------------------------------------------- input */
    landLock = Math.max(0, landLock - dt);
    const locking = landLock > 0;

    let inZ = down(KEY_F) - down(KEY_B);
    let inX = down(KEY_R) - down(KEY_L);
    if (padActive && (padMoveX || padMoveZ)) { inZ = padMoveZ; inX = padMoveX; }
    if (locking) { inZ = 0; inX = 0; }

    const wantCrouch = !!(keys.ControlLeft || keys.ControlRight || keys.KeyC || padCrouch);
    const wantSprint = !!(keys.ShiftLeft || keys.ShiftRight || padSprint) && !locking;
    const wantWalk = !!(keys.AltLeft || keys.AltRight || padWalk);

    if (crouching && !wantCrouch && !canStand(ctx)) { /* stay down under an overhang */ }
    else crouching = wantCrouch && !swimming;
    // Source's TIME_TO_DUCK / TIME_TO_UNDUCK, smoothstepped at the eye (feel.md §3.5).
    const cRate = crouching ? dt / T.crouchDownTime : -dt / T.crouchUpTime;
    crouchBlend = clamp(crouchBlend + cRate, 0, 1);

    const mag = Math.hypot(inZ, inX);
    const fdot = mag > 1e-5 ? inZ / mag : 0;
    sprinting = wantSprint && !crouching && !swimming && mag > 1e-5 && fdot > 0.55
                && wade < T.wadeSprintCut;
    sprintBlend += ((sprinting && Math.hypot(vel.x, vel.z) > T.walk * 0.75 ? 1 : 0) - sprintBlend)
                   * approach(5.5, dt);

    let sMul = 1;
    if (crouching) sMul = T.crouchSpeed / T.walk;
    else if (sprinting) sMul = T.sprint / T.walk;
    else if (wantWalk) sMul = T.slowWalk / T.walk;
    sMul *= (1 - T.wadeSlow * wade);

    let wishSpeed = wishVelocity(inZ, inX, sMul);
    if (wishSpeed > 0) wishSpeed *= slopeScale(_w.x, _w.z);

    /* -------------------------------------------------------------- noclip */
    if (ctx.config.noclip) {
      const fly = _v.set(0, 0, 0).addScaledVector(lookDir, inZ).addScaledVector(right, inX);
      fly.y += (keys.Space || padJump ? 1 : 0) - (wantCrouch ? 1 : 0);
      if (fly.lengthSq() > 1e-6) fly.normalize();
      vel.copy(fly).multiplyScalar(wantSprint ? 26 : 9);
      pos.addScaledVector(vel, dt);
      grounded = false; bobBlend = 0;
      eyeHeight += (T.eyeStand - eyeHeight) * approach(12, dt);
      return;
    }

    /* ----------------------------------------------------------- integrate */
    const wasGrounded = grounded;
    jumpGrace = Math.max(0, jumpGrace - dt);
    jumpBuffer = Math.max(0, jumpBuffer - dt);
    if (padActive && padJumpEdge) { jumpBuffer = T.jumpBufferTime; padJumpEdge = false; }

    if (swimming) {
      const swimDir = _v.set(0, 0, 0).addScaledVector(lookDir, inZ).addScaledVector(right, inX);
      if (keys.Space || padJump) swimDir.y += 0.9;
      if (swimDir.lengthSq() > 1e-6) swimDir.normalize();
      vel.addScaledVector(swimDir, T.swimSpeed * 3.2 * dt);
      const drag = 1 - approach(T.swimDrag, dt);
      vel.multiplyScalar(drag);
      const sink = clamp((waterDepth - eyeHeight) / 0.8, 0, 1);
      vel.y += (T.gravity * 0.36 * sink - T.gravity * 0.12) * dt;
    } else if (grounded) {
      // ONE call site accelerates and brakes; the rate selector is the whole difference
      // between Halo's crisp stop and Quake's asymptotic slide (feel.md §2.2).
      const cur = Math.hypot(vel.x, vel.z);
      const rate = (wishSpeed > cur + 1e-4) ? T.groundAccel : T.decel;
      accelerateToward(_w.x * wishSpeed, _w.z * wishSpeed, rate, dt);
      if (wishSpeed <= 0 && Math.hypot(vel.x, vel.z) < T.stopSnap) { vel.x = 0; vel.z = 0; }
      vel.y = Math.min(vel.y, 0);
      coyote = T.coyote;
      if (jumpBuffer > 0 && !locking) {
        vel.y = JUMP_V * (1 - 0.30 * wade);
        grounded = false; jumpBuffer = 0; jumpGrace = T.jumpGrace; coyote = 0;
        ctx.emit('player:jump', { position: pos.clone(), speed: Math.hypot(vel.x, vel.z) });
      }
    } else {
      coyote = Math.max(0, coyote - dt);
      if (jumpBuffer > 0 && coyote > 0 && !locking) {
        vel.y = JUMP_V; jumpBuffer = 0; jumpGrace = T.jumpGrace; coyote = 0;
        ctx.emit('player:jump', { position: pos.clone(), speed: Math.hypot(vel.x, vel.z) });
      }
      // feel.md §2.4: redirect, never gain. Source uses a big air accel with a hard
      // wish cap; the CAP is what does the work. A 1.29 s hang with real air control
      // would feel like a jetpack — with the cap it feels like commitment.
      const before = Math.hypot(vel.x, vel.z);
      accelerateToward(_w.x * wishSpeed, _w.z * wishSpeed, T.airAccel, dt);
      const after = Math.hypot(vel.x, vel.z);
      const cap = Math.max(before, T.walk * sMul);
      if (after > cap && after > 1e-6) { const s = cap / after; vel.x *= s; vel.z *= s; }
    }

    // Velocity-Verlet on the vertical axis: half a step of gravity either side of the
    // position integration. Exact for constant acceleration, so the apex is 2.125 m at
    // any frame rate — plain semi-implicit Euler loses 1.4 cm at 60 Hz and 5.5 cm at
    // 30 Hz, and "the jump is shorter on a slow machine" is a real bug.
    const impactVy = vel.y;               // BEFORE the half-kick: the true contact speed
    if (!swimming) {
      vel.y -= gAt(vel.y) * 0.5 * dt;
      if (vel.y < -T.terminal) vel.y = -T.terminal;
    }

    /* ------------------------------------------------------------- collide */
    let res = moveCapsule(ctx, pos, _v.copy(vel).multiplyScalar(dt));
    let hitGround = res.grounded && jumpGrace <= 0;

    // Ground snap: walking down a slope or a small step must not un-ground us, or the
    // controller flickers between air and ground physics every other frame.
    if (!hitGround && wasGrounded && vel.y <= 0.02 && jumpGrace <= 0) {
      const hs = Math.hypot(vel.x, vel.z);
      const probe = Math.min(stepH(), 0.07 + hs * dt * 1.5);
      const r2 = moveCapsule(ctx, res.position, _v.set(0, -probe, 0));
      if (r2.grounded) { res = r2; hitGround = true; }
    }

    const dy = res.position.y - pos.y;
    pos.copy(res.position);
    groundNormal.copy(res.groundNormal || groundNormal);
    if (res.surface) surface = res.surface;

    /* -------------------------------------------------------------- ground */
    if (hitGround) {
      if (!wasGrounded) onLand(ctx, Math.max(0, -impactVy));
      if (vel.y < 0) vel.y = 0;
      grounded = true;
    } else {
      grounded = false;
      if (!swimming) {
        vel.y -= gAt(vel.y) * 0.5 * dt;                 // second Verlet half-step
        if (vel.y < -T.terminal) vel.y = -T.terminal;
      }
    }

    // Step smoothing (feel.md §3.4): accumulate onto any in-progress step so running a
    // staircase does not ratchet, handle DOWN-steps too, and decay on a smoothstep so
    // there is no velocity discontinuity at either end (Q3's linear ramp has one).
    if (grounded && wasGrounded && Math.abs(dy) > 0.06 && Math.abs(dy) < stepH() + 0.06) {
      const cur = stepOffset;
      stepAmp = clamp(cur - dy, -T.stepSmoothMax, T.stepSmoothMax);
      stepT = simT;
    }
    stepDecay(dt);

    /* ------------------------------------------------------- eye + landing */
    const targetEye = lerp(T.eyeStand, T.eyeCrouch, sstep(crouchBlend));
    eyeHeight += (targetEye - eyeHeight) * approach(20, dt);

    // Damped spring, substepped so ζ does not drift with dt (feel.md §3.3).
    const sub = 8, sdt = dt / sub;
    const kk = dipOmega * dipOmega, cc = 2 * T.landZeta * dipOmega;
    for (let i = 0; i < sub; i++) {
      dipVel += (-kk * dipPos - cc * dipVel) * sdt;
      dipPos += dipVel * sdt;
    }
    if (Math.abs(dipPos) < 1e-5 && Math.abs(dipVel) < 1e-4) { dipPos = 0; dipVel = 0; }

    /* ------------------------------------------------------------ bob phase */
    updateBobPhase(dt, ctx);

    // Airborne hand float — first-order lag with the SAME tau on both sides of the
    // ground transition, so it decays continuously instead of popping. Gating a camera
    // term on `grounded` is what produced a 5.5 cm one-frame teleport at every takeoff
    // and every touchdown; HL2's rule is freeze the phase, FADE the amplitude.
    const lagTarget = grounded ? 0 : clamp(-vel.y * 0.0125, -0.055, 0.055);
    airLag += (lagTarget - airLag) * approach(1 / T.airLagTau, dt);

    /* ---------------------------------------------------------- shield/hp */
    const quiet = t - lastHitT;
    if (shield < 1 && quiet > T.shieldDelay) {
      const ramp = clamp((quiet - T.shieldDelay) / T.shieldRampTime, 0, 1);
      shield = Math.min(1, shield + (dt / T.shieldTime) * (0.25 + 0.75 * ramp));
      if (shield >= 1) ctx.emit('player:shieldFull', {});
    }
    if (shield >= 1 && health < 1 && quiet > T.healthDelay) {
      health = Math.min(1, health + T.healthRate * dt);
    }

    sprintLean += ((sprinting ? 1.0 * DEG : 0) - sprintLean) * approach(4.5, dt);
  }

  /** Asymmetric gravity hook. Halo is symmetric (mul = 1); 1.4–1.6 is the documented
   *  modernisation that keeps apex height and reachability and only shortens the fall. */
  function gAt(vy) { return vy > 0 ? T.gravity : T.gravity * T.gravityFallMul; }

  function stepDecay() {
    const u = clamp((simT - stepT) / T.stepSmoothT, 0, 1);
    stepOffset = stepAmp * (1 - sstep(u));
    if (u >= 1) { stepAmp = 0; stepOffset = 0; }
  }

  function canStand(ctx) {
    const ph = ctx.get('physics');
    if (!ph || typeof ph.clearance !== 'function') return true;
    try {
      const r = T.radius * 0.92;
      _p.set(pos.x, pos.y + T.standHeight - r, pos.z);
      return ph.clearance(_p, r, ph.MASK ? ph.MASK.WORLD : 1).dist > 0.02;
    } catch { return true; }
  }

  /**
   * feel.md §3.3 — the two-tier landing. Below `minSoftLand` nothing happens. Across
   * the soft band the dip scales 0 → `softDip` and recovers fast; across the hard band
   * it scales `softDip` → `hardDip` → `extremeDip`, recovers slowly, and takes a brief
   * input lock, which is the strongest "you have mass" signal available.
   */
  function onLand(ctx, impact) {
    let dip = 0, tier = 0;
    if (impact > T.minSoftLand) {
      if (impact < T.minHardLand) {
        dip = lerp(0, T.softDip, (impact - T.minSoftLand) / (T.minHardLand - T.minSoftLand));
      } else if (impact < T.maxHardLand) {
        tier = clamp((impact - T.minHardLand) / (T.maxHardLand - T.minHardLand), 0, 1);
        dip = lerp(T.softDip, T.hardDip, tier);
      } else {
        tier = 1;
        dip = lerp(T.hardDip, T.extremeDip,
                   clamp((impact - T.maxHardLand) / Math.max(1e-3, T.deathLand - T.maxHardLand), 0, 1));
      }
    }
    if (dip > 0) {
      // Recovery time is the tier's, not one fixed spring: ~0.30 s soft, ~0.84 s hard.
      dipOmega = lerp(T.landOmegaSoft, T.landOmegaHard,
                      clamp((impact - T.minSoftLand) / (T.maxHardLand - T.minSoftLand), 0, 1));
      // Solve the impulse so the achieved peak IS `dip`, instead of ~48% of it.
      dipVel -= dip * dipOmega / PEAK_GAIN;
    }
    if (impact >= T.minHardLand) landLock = T.landLockTime * (0.6 + 0.4 * tier);
    if (impact > 1.6) emitFootstep(ctx, impact > T.minHardLand);
    ctx.emit('player:land', { position: pos.clone(), impact, surface, wade: waterDepth,
                              hard: impact >= T.minHardLand, dip });
    if (impact > T.fallSafe) {
      const f = (impact - T.fallSafe) / (T.fallLethal - T.fallSafe);
      applyDamage(ctx, Math.pow(clamp(f, 0, 2), 1.5) * 1.6, null);
    }
  }

  /**
   * Step phase, integrated from DISTANCE TRAVELLED and not from wall time, so the
   * cadence is automatically right at every speed and the footstep events cannot drift
   * out of sync with the picture (feel.md §3.2). 2π = one stride = two footfalls.
   * The phase FREEZES in the air; the amplitude is faded separately.
   */
  function updateBobPhase(dt, ctx) {
    const hs = Math.hypot(vel.x, vel.z);
    const active = (grounded && !swimming) ? clamp(hs / 1.2, 0, 1) : 0;
    bobBlend += (active - bobBlend) * approach(active > bobBlend ? 8 : 6.7, dt);

    if (grounded && !swimming && hs > 0.35) {
      stepPhase += TAU * (hs / strideLen(hs)) * dt;
      const idx = Math.floor(stepPhase / Math.PI);
      if (idx !== stepIndex) {
        stepIndex = idx;
        if (bobBlend > 0.22) emitFootstep(ctx, false);
      }
    }
    if (stepPhase > TAU * 1024) { stepPhase -= TAU * 1024; stepIndex -= 2048; prevPhase -= TAU * 1024; }
  }

  /* --------------------------------------------------- render-rate output */

  /**
   * Everything the eye sees, evaluated once per RENDER frame from interpolated tick
   * state. Simulating the offsets in the tick *and* interpolating them would
   * double-smooth and cost the dip its snap (feel.md §6.3).
   */
  function updateRender(dt, alpha, ctx) {
    const dip = lerp(prevDip, dipPos, alpha);
    const stepOff = lerp(prevStepOffset, stepOffset, alpha);
    const eyeH = lerp(prevEyeHeight, eyeHeight, alpha);
    const p = lerp(prevPhase, stepPhase, alpha);
    const blend = lerp(prevBob, bobBlend, alpha);
    const lag = lerp(prevAirLag, airLag, alpha);
    _ip.lerpVectors(prevPos, pos, alpha);

    // Amplitude scales ONCE, with speed, as a fraction of the run speed.
    const hs = Math.hypot(vel.x, vel.z);
    const amp = blend * clamp(hs / T.walk, 0, 1) * (1 - 0.40 * crouchBlend) * (1 - 0.45 * wade);

    const sp = Math.sin(p), c2p = Math.cos(2 * p), s2p = Math.sin(2 * p);

    viewBobOffset.x = T.bobLat * amp * sp;
    viewBobOffset.y = -T.bobVert * amp * c2p;
    viewBobOffset.z = -T.bobFore * amp * s2p;

    viewBobAngles.z = -T.bobRoll * amp * sp;
    viewBobAngles.x = T.bobPitch * amp * c2p + dip * T.landPitchPerM - sprintLean;
    viewBobAngles.y = T.bobYaw * amp * sp;

    // The other 80%, for the viewmodel. Never applied to the camera.
    const hm = T.handBobMul;
    handBobOffset.set(viewBobOffset.x * hm, viewBobOffset.y * hm + lag, viewBobOffset.z * hm);
    handBobAngles.set(viewBobAngles.x * hm, viewBobAngles.y * hm, viewBobAngles.z * hm, 'YXZ');

    const fovScale = ctx.config.fovScale ?? 1;
    const target = ((ctx.config.fov ?? T.fovBase) + T.fovSprint * sprintBlend) * fovScale;
    fov += (target - fov) * approach(T.fovRate, dt);

    writeCamera(ctx, 1, false, _ip, eyeH, dip, stepOff);
  }

  function writeCamera(ctx, _unused, snap, ipos, eyeH, dip, stepOff) {
    const cam = ctx.camera;
    if (!cam) return;
    const P = ipos || pos;
    const H = eyeH ?? eyeHeight, D = dip ?? dipPos, S = stepOff ?? stepOffset;

    // Bob is applied in a yaw-only frame so that looking up or down does not swing the
    // vertical component sideways. (`viewBobOffset` itself stays camera-local: the
    // viewmodel is a child of the camera and wants it in that space.)
    const sy = Math.sin(yaw + recoilY), cy = Math.cos(yaw + recoilY);
    _bobW.set(
      viewBobOffset.x * cy + viewBobOffset.z * sy,
      viewBobOffset.y,
      viewBobOffset.z * cy - viewBobOffset.x * sy);

    eye.set(P.x, P.y + H + D + S, P.z).add(_bobW);
    cam.position.copy(eye);

    const vp = clamp(pitch + recoilP + viewBobAngles.x, -T.pitchLimit, T.pitchLimit);
    _euler.set(vp, yaw + recoilY + viewBobAngles.y, viewBobAngles.z, 'YXZ');
    cam.quaternion.setFromEuler(_euler);
    lookDir.set(0, 0, -1).applyQuaternion(cam.quaternion);

    if (Math.abs(cam.fov - fov) > 1e-3 || snap) { cam.fov = fov; cam.updateProjectionMatrix(); }
    if (snap) cam.updateMatrixWorld(true);
  }

  return api;
}
