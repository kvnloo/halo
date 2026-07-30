import * as THREE from 'three';

/**
 * `player` — first-person controller, head bob, camera authority.
 *
 * Feel notes (this is the part players judge in the first three seconds):
 *
 *  - Movement is a Quake-lineage friction/accelerate pair rather than a lerp to a
 *    target velocity. That is what produces Halo's weight: you keep sliding for
 *    ~0.6 m after releasing the stick at a walk and ~1.3 m from a sprint, and the
 *    stop is a decaying glide, not a snap. Instant-stop movement is the single most
 *    common way to get this wrong.
 *  - Air control is *bounded*, not scaled. `accelerate()` only adds velocity while
 *    the projection of the current velocity onto the wish direction is below a small
 *    cap (2.2 m/s), so you can meaningfully steer a jump but can never redirect or
 *    accelerate one. Reduced but non-zero, and it cannot be abused.
 *  - View bob is a 1:2 Lissajous — lateral once per stride, vertical twice — driven
 *    off a step-phase accumulator that is integrated from *distance travelled*, not
 *    from wall time. Footfalls therefore land exactly on the vertical minima at every
 *    speed, and the footstep events cannot drift out of sync with the picture.
 *
 * CAMERA AUTHORITY. In `deterministic` (capture) mode this module never writes to the
 * camera: `__HALO__.setPose` owns it, and every measurement in the project depends on
 * that. It instead reads the camera each frame so `position` / `eye` / `yaw` / `pitch`
 * stay meaningful for consumers (audio listener, LOD, AI) at the harness's pose.
 *
 * Collision is `physics.moveCharacter` — this file contains no collision code. The
 * environment modules are landing concurrently, so every cross-module call is guarded
 * and there is a flat-ground degraded path for the window where `terrain` is a stub.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const { clamp, lerp } = THREE.MathUtils;

/** Frame-rate independent exponential approach factor. */
const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Movement / feel constants. docs/WORLD.md owns the first block; the rest is tuning. */
export const TUNE = {
  /* --- from docs/WORLD.md, do not drift ---------------------------------- */
  eyeStand: 1.72,
  eyeCrouch: 1.05,
  radius: 0.42,
  stepHeight: 0.55,
  walk: 3.6,
  sprint: 6.4,
  crouchSpeed: 1.9,
  gravity: 19.6,
  jumpApex: 1.05,
  spawn: { x: 6, z: 16, yawDeg: 288 },

  /* --- capsule ------------------------------------------------------------ */
  standHeight: 1.86,        // eye 1.72 + skull; moveCharacter puts spheres at r and h-r
  crouchHeight: 1.20,
  maxSlopeDeg: 52,
  terminal: 58,

  /* --- acceleration ------------------------------------------------------- */
  groundAccel: 6.5,         // × wishSpeed = m/s² ; 23 m/s² at a walk, 0.22 s to 90%
  friction: 4.5,            // exponential above stopSpeed, linear below
  stopSpeed: 1.35,
  airAccel: 4.0,
  airMaxWish: 2.2,          // hard bound on how much velocity air control can add
  airFriction: 0.06,

  coyote: 0.11,             // late jump after walking off a lip
  jumpBufferTime: 0.13,     // early jump before landing
  jumpGrace: 0.09,          // ignore ground contact right after launch

  /* --- look --------------------------------------------------------------- */
  sensitivity: 0.0021,      // radians per pixel (~0.12°/px)
  pitchLimit: 89 * DEG,
  recoilRetain: 0.18,       // Halo recovers most of a kick, not all of it
  recoilSnap: 17,           // rate back onto the retained line
  recoilBleed: 1.25,        // rate the retained part drifts back to the aim
  recoilMaxPitch: 14 * DEG,
  strafeTilt: 1.2 * DEG,

  /* --- fov ---------------------------------------------------------------- */
  fovBase: 78,
  fovSprint: 5.5,
  fovRate: 6.0,

  /* --- bob ---------------------------------------------------------------- */
  strideBase: 1.50,         // metres per stride at a standstill…
  strideSlope: 0.245,       // …+ this per m/s  (walk 2.38 m, sprint 3.07 m)
  bobVert: 0.017,
  bobVertSprint: 0.008,
  bobLat: 0.021,
  bobLatSprint: 0.010,
  bobFore: 0.009,
  bobRoll: 0.55 * DEG,
  bobRollSprint: 0.35 * DEG,
  bobPitch: 0.30 * DEG,
  bobYaw: 0.22 * DEG,

  /* --- landing ------------------------------------------------------------ */
  landDipPerMS: 0.0088,     // metres of dip per m/s of impact
  landDipMax: 0.17,
  landSpringK: 150,         // ω ≈ 12.2 rad/s
  landSpringC: 10.4,        // ζ ≈ 0.42 — one small overshoot, then settled
  landPitchPerM: 1.15,      // radians of nose-down per metre of dip

  /* --- damage ------------------------------------------------------------- */
  shieldDelay: 4.0,
  shieldTime: 2.4,
  shieldRampTime: 0.42,
  healthDelay: 8.0,
  healthRate: 0.05,
  fallSafe: 9.0,            // m/s — below this, landing is free
  fallLethal: 24.0,
  respawnTime: 2.6,

  /* --- water -------------------------------------------------------------- */
  wadeFull: 1.30,           // depth at which the wade penalty saturates
  wadeSlow: 0.50,
  wadeSprintCut: 0.45,
  swimSpeed: 2.5,
  swimDrag: 2.2,
};

export function create(opts = {}) {
  const T = TUNE;
  const JUMP_V = Math.sqrt(2 * T.gravity * T.jumpApex);   // 6.4156 m/s

  /* ------------------------------------------------------------------ state */
  const pos = new THREE.Vector3(T.spawn.x, 0, T.spawn.z);       // FEET
  const eye = new THREE.Vector3();                              // camera position
  const vel = new THREE.Vector3();
  const viewBobOffset = new THREE.Vector3();                    // camera-local metres
  const viewBobAngles = new THREE.Euler(0, 0, 0, 'YXZ');        // radians
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

  let coyote = 0, jumpBuffer = 0, jumpGrace = 0;
  let stepPhase = 0, stepIndex = 0, bobBlend = 0, sprintBlend = 0, crouchBlend = 0;
  let strafeRoll = 0, sprintLean = 0;
  let dipPos = 0, dipVel = 0, stepOffset = 0;
  let fov = T.fovBase;
  let physicsFailFrame = 0;
  let captureMode = false, boundInput = false;

  /* --------------------------------------------------------------- scratch */
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _p = new THREE.Vector3();
  const _bobW = new THREE.Vector3(), _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _fallback = { position: new THREE.Vector3(), grounded: false,
                      groundNormal: new THREE.Vector3(0, 1, 0), surface: 'sand' };
  const _moveOpts = { radius: T.radius, height: T.standHeight, stepHeight: T.stepHeight,
                      maxSlopeDeg: T.maxSlopeDeg, mask: 1 };

  /* ------------------------------------------------------------------ input */
  const keys = Object.create(null);
  let mouseDX = 0, mouseDY = 0;
  let wantJump = false, locked = false;
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

    on(document, 'mousemove', (e) => {
      if (!locked) return;
      mouseDX += e.movementX || 0;
      mouseDY += e.movementY || 0;
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

    // physics.moveCharacter calls terrain.height() unguarded, so a registered-but-stub
    // terrain would throw there; a *missing* terrain is fine (physics skips that leg)
    // but then nothing holds the player up, so we add the y=0 sea-level floor.
    if (!physicsFailFrame && (hasHeight || !terr) && ph && typeof ph.moveCharacter === 'function') {
      try {
        _moveOpts.height = crouching ? T.crouchHeight : T.standHeight;
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
      // Cheap reject: most of the level is metres above the sea. `isSubmerged` may
      // evaluate the wave sum, so do not call it 6 times a frame up on the berm.
      if (typeof ocean.level === 'number' && pos.y > ocean.level + 2.0) return 0;
      if (typeof ocean.isSubmerged === 'function') {
        _p.set(pos.x, pos.y + 0.06, pos.z);
        if (!ocean.isSubmerged(_p)) return 0;
        let lo = 0.06, hi = T.eyeStand + 0.35;
        _p.y = pos.y + hi;
        if (ocean.isSubmerged(_p)) return hi;
        for (let i = 0; i < 5; i++) {          // 5 bisections ⇒ ~6 cm resolution
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
   * Quake-style accelerate: only ever adds velocity along `dir`, and only while the
   * projection of the current velocity onto `dir` is under `wishSpeed`. This is what
   * bounds air control without making it feel dead, and it makes ground steady-state
   * speed exactly `wishSpeed` regardless of friction.
   */
  function accelerate(dir, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    const cur = vel.x * dir.x + vel.z * dir.z;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const a = Math.min(accel * wishSpeed * dt, add);
    vel.x += dir.x * a;
    vel.z += dir.z * a;
  }

  function applyFriction(dt, scale) {
    const sp = Math.hypot(vel.x, vel.z);
    if (sp < 1e-4) { vel.x = 0; vel.z = 0; return; }
    const control = Math.max(sp, T.stopSpeed);
    const ns = Math.max(0, sp - control * T.friction * scale * dt) / sp;
    vel.x *= ns; vel.z *= ns;
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
    dipPos = dipVel = stepOffset = 0;
    stepPhase = 0; stepIndex = 0; bobBlend = 0;
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
     * and `damage(1.0)` strips the shield entirely. It is NOT a 0..100 hit-point
     * scale — callers passing 6 or 58 will one-shot the player.
     */
    damage(amount, direction) {
      if (api._ctx && Number.isFinite(amount)) applyDamage(api._ctx, amount, direction);
    },
    applyRecoil(p, y) {
      // radians. Kicks the view immediately; `recoilRetain` of it becomes the new
      // settled line, which then bleeds back to the aim over ~1.5 s.
      recoilP = clamp(recoilP + (p || 0), -T.recoilMaxPitch, T.recoilMaxPitch);
      recoilY = clamp(recoilY + (y || 0), -T.recoilMaxPitch, T.recoilMaxPitch);
      settleP = clamp(settleP + (p || 0) * T.recoilRetain, -T.recoilMaxPitch, T.recoilMaxPitch);
      settleY = clamp(settleY + (y || 0) * T.recoilRetain, -T.recoilMaxPitch, T.recoilMaxPitch);
    },
    /**
     * Head bob as a CAMERA-LOCAL offset in metres, three.js axes: +x right, +y up,
     * +z *backward* (so a forward lunge is negative z). Verified: this offset dotted
     * with `player.right` / `player.forward` reproduces the camera's world-space
     * displacement exactly. Typical magnitude 0.02 m walking, 0.05 m sprinting.
     *
     * It is ALREADY applied to the camera. A viewmodel parented to the camera should
     * use it for counter-sway (e.g. `-k * viewBobOffset`), not add it again.
     */
    viewBobOffset,

    /* --- extras consumers may find useful -------------------------------- */
    /** Additive view rotation the controller applied on top of the aim this frame:
     *  bob roll/pitch/yaw + strafe tilt + landing dip + sprint lean, radians, YXZ.
     *  Also already applied to the camera — for a viewmodel that is NOT a child of
     *  the camera, or for counter-rotation. */
    viewBobAngles,
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
    get stepPhase() { return stepPhase; },
    get fov() { return fov; },
    get pointerLocked() { return locked; },
    get captureMode() { return captureMode; },
    heal(a = 1) { health = clamp(health + a, 0, 1); },
    teleport(p, yawDeg) {
      pos.set(p.x, p.y, p.z);
      if (yawDeg != null) yaw = yawDeg * DEG;
      vel.set(0, 0, 0);
      dipPos = dipVel = stepOffset = 0;
      recoilP = recoilY = settleP = settleY = 0;
      stepPhase = 0; stepIndex = 0; bobBlend = 0;
      viewBobOffset.set(0, 0, 0);
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
      updateBasis();

      ctx.config.sensitivity ??= T.sensitivity;
      ctx.config.fov ??= T.fovBase;
      ctx.config.invertY ??= false;
      ctx.config.godMode ??= false;
      ctx.config.noclip ??= false;

      if (!captureMode) {
        bindInput(ctx);
        // Place the camera once so the first frame is not at the origin.
        writeCamera(ctx, true);
      } else {
        // The harness owns the camera. Mirror it so consumers still see a pose.
        syncFromCamera(ctx);
      }

      // `__HALO__.setPose` must keep working in the live build too, or every agent
      // inspecting their subsystem in the browser fights the controller for the
      // camera. In capture mode we mirror the pose; live, we move the player to it.
      ctx.on('camera:teleport', () => {
        if (captureMode) { syncFromCamera(ctx); return; }
        const cam = ctx.camera;
        _euler.setFromQuaternion(cam.quaternion, 'YXZ');
        pitch = clamp(_euler.x, -T.pitchLimit, T.pitchLimit);
        yaw = _euler.y;
        recoilP = recoilY = settleP = settleY = 0;
        pos.set(cam.position.x, cam.position.y - eyeHeight, cam.position.z);
        vel.set(0, 0, 0);
        dipPos = dipVel = stepOffset = 0;
        grounded = false;
        updateBasis();
      });
    },

    update(dt, ctx) {
      api._ctx = ctx;
      // Re-read every frame: the harness can flip this after init.
      captureMode = !!(ctx.engine?.opts?.deterministic || opts.capture);
      if (captureMode) { syncFromCamera(ctx); return; }
      if (!api.enabled) return;
      if (ctx.config.frozen) return;
      if (!boundInput) bindInput(ctx);

      dt = Math.min(dt, 0.05);        // a hitch must not teleport the player
      simulate(dt, ctx);
      writeCamera(ctx, false);
    },

    dispose() { unbindInput(); },
    _ctx: null,
  };

  /* ------------------------------------------------------------- simulation */

  function updateBasis() {
    const sy = Math.sin(yaw + recoilY), cy = Math.cos(yaw + recoilY);
    forward.set(-sy, 0, -cy);
    right.set(cy, 0, -sy);
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
    vel.set(0, 0, 0);
    viewBobOffset.set(0, 0, 0);
    viewBobAngles.set(0, 0, 0);
    lookDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    grounded = true; sprinting = false; crouching = false; swimming = false;
    bobBlend = 0; stepPhase = 0; dipPos = 0; dipVel = 0; stepOffset = 0;
    fov = cam.fov;
  }

  function simulate(dt, ctx) {
    const t = ctx.clock.t;

    /* ---------------------------------------------------------------- look */
    const sens = (ctx.config.sensitivity ?? T.sensitivity);
    const invert = ctx.config.invertY ? -1 : 1;
    let dYaw = -mouseDX * sens;
    let dPitch = -mouseDY * sens * invert;
    mouseDX = 0; mouseDY = 0;

    // Pulling against the settled recoil cancels it instead of double-counting —
    // this is what makes a recoiling weapon controllable rather than a random walk.
    if (dPitch < 0 && settleP > 0) { const e = Math.min(settleP, -dPitch); settleP -= e; recoilP -= e; dPitch += e; }
    else if (dPitch > 0 && settleP < 0) { const e = Math.min(-settleP, dPitch); settleP += e; recoilP += e; dPitch -= e; }
    if (dYaw < 0 && settleY > 0) { const e = Math.min(settleY, -dYaw); settleY -= e; recoilY -= e; dYaw += e; }
    else if (dYaw > 0 && settleY < 0) { const e = Math.min(-settleY, dYaw); settleY += e; recoilY += e; dYaw -= e; }

    if (!dead) { yaw += dYaw; pitch = clamp(pitch + dPitch, -T.pitchLimit, T.pitchLimit); }
    if (yaw > Math.PI) yaw -= TAU; else if (yaw < -Math.PI) yaw += TAU;

    // Recoil snaps back onto the retained line, which then bleeds toward the aim.
    const snap = approach(T.recoilSnap, dt);
    recoilP += (settleP - recoilP) * snap;
    recoilY += (settleY - recoilY) * snap;
    const bleed = Math.exp(-T.recoilBleed * dt);
    settleP *= bleed; settleY *= bleed;
    updateBasis();

    /* --------------------------------------------------------------- death */
    if (dead) {
      vel.x *= 1 - approach(6, dt); vel.z *= 1 - approach(6, dt);
      vel.y -= T.gravity * dt;
      const r = moveCapsule(ctx, pos, _v.copy(vel).multiplyScalar(dt));
      pos.copy(r.position);
      if (r.grounded) vel.y = 0;
      eyeHeight += (0.42 - eyeHeight) * approach(5, dt);
      bobBlend *= 1 - approach(8, dt);
      viewBobOffset.multiplyScalar(1 - approach(8, dt));
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
    const inZ = down(KEY_F) - down(KEY_B);
    const inX = down(KEY_R) - down(KEY_L);
    const wantCrouch = !!(keys.ControlLeft || keys.ControlRight || keys.KeyC);
    const wantSprint = !!(keys.ShiftLeft || keys.ShiftRight);

    // Crouch: refuse to stand up under an overhang.
    if (crouching && !wantCrouch && !canStand(ctx)) { /* stay down */ }
    else crouching = wantCrouch && !swimming;
    crouchBlend += ((crouching ? 1 : 0) - crouchBlend) * approach(13, dt);

    _w.set(0, 0, 0).addScaledVector(forward, inZ).addScaledVector(right, inX);
    const wl = Math.hypot(_w.x, _w.z);
    if (wl > 1e-5) { _w.x /= wl; _w.z /= wl; } else { _w.set(0, 0, 0); }
    const fdot = wl > 1e-5 ? _w.x * forward.x + _w.z * forward.z : 1;

    sprinting = wantSprint && !crouching && !swimming && wl > 1e-5 && fdot > 0.55
                && wade < T.wadeSprintCut;
    sprintBlend += ((sprinting && Math.hypot(vel.x, vel.z) > T.walk * 0.9 ? 1 : 0) - sprintBlend)
                   * approach(5.5, dt);

    // Backpedalling and strafing are slower — continuous in the wish angle.
    const dirScale = fdot >= 0 ? lerp(0.93, 1.0, fdot) : lerp(0.93, 0.80, -fdot);
    const wadeMul = 1 - T.wadeSlow * wade;
    let wishSpeed = (crouching ? T.crouchSpeed : sprinting ? T.sprint : T.walk) * dirScale * wadeMul;
    if (wl < 1e-5) wishSpeed = 0;

    /* -------------------------------------------------------------- noclip */
    if (ctx.config.noclip) {
      const fly = _v.set(0, 0, 0).addScaledVector(lookDir, inZ).addScaledVector(right, inX);
      fly.y += (keys.Space ? 1 : 0) - (wantCrouch ? 1 : 0);
      if (fly.lengthSq() > 1e-6) fly.normalize();
      vel.copy(fly).multiplyScalar(wantSprint ? 26 : 9);
      pos.addScaledVector(vel, dt);
      grounded = false; bobBlend = 0; viewBobOffset.set(0, 0, 0);
      eyeHeight += (T.eyeStand - eyeHeight) * approach(12, dt);
      return;
    }

    /* ----------------------------------------------------------- integrate */
    const wasGrounded = grounded;
    jumpGrace = Math.max(0, jumpGrace - dt);
    jumpBuffer = Math.max(0, jumpBuffer - dt);

    if (swimming) {
      // Buoyant, draggy, and steered by the look vector.
      const swimDir = _v.set(0, 0, 0).addScaledVector(lookDir, inZ).addScaledVector(right, inX);
      if (keys.Space) swimDir.y += 0.9;
      if (swimDir.lengthSq() > 1e-6) swimDir.normalize();
      vel.addScaledVector(swimDir, T.swimSpeed * 3.2 * dt);
      const drag = 1 - approach(T.swimDrag, dt);
      vel.multiplyScalar(drag);
      const sink = clamp((waterDepth - eyeHeight) / 0.8, 0, 1);
      vel.y += (T.gravity * 0.18 * sink - T.gravity * 0.06) * dt;
    } else if (grounded) {
      applyFriction(dt, 1 + 0.55 * wade);
      accelerate(_w, wishSpeed, T.groundAccel, dt);
      vel.y = Math.min(vel.y, 0);
      // Coyote time and buffered jumps. The buffer is armed by the key*down* only, so
      // a press that was released before landing still fires (that is the whole point
      // of a buffer) while holding the key never auto-repeats into a bunny hop.
      coyote = T.coyote;
      if (jumpBuffer > 0) {
        vel.y = JUMP_V * (1 - 0.30 * wade);
        grounded = false; jumpBuffer = 0; jumpGrace = T.jumpGrace; coyote = 0;
        ctx.emit('player:jump', { position: pos.clone(), speed: Math.hypot(vel.x, vel.z) });
      }
    } else {
      coyote = Math.max(0, coyote - dt);
      if (jumpBuffer > 0 && coyote > 0) {
        vel.y = JUMP_V; jumpBuffer = 0; jumpGrace = T.jumpGrace; coyote = 0;
        ctx.emit('player:jump', { position: pos.clone(), speed: Math.hypot(vel.x, vel.z) });
      }
      // Reduced but non-zero air control, bounded by airMaxWish.
      accelerate(_w, Math.min(wishSpeed, T.airMaxWish), T.airAccel, dt);
      if (T.airFriction) { const f = 1 - T.airFriction * dt; vel.x *= f; vel.z *= f; }
    }

    // Velocity-Verlet on the vertical axis: half a step of gravity either side of the
    // position integration. Exact for constant acceleration, so the jump apex is
    // 1.05 m at any frame rate — plain semi-implicit Euler lands 0.997 m at 60 Hz and
    // 0.89 m at 30 Hz, and "the jump is shorter on a slow machine" is a real bug.
    if (!swimming) {
      vel.y -= T.gravity * 0.5 * dt;
      if (vel.y < -T.terminal) vel.y = -T.terminal;
    }
    const prevVy = vel.y;

    /* ------------------------------------------------------------- collide */
    let res = moveCapsule(ctx, pos, _v.copy(vel).multiplyScalar(dt));
    let hitGround = res.grounded && jumpGrace <= 0;

    // Ground snap: walking down a slope or a small step must not un-ground us, or
    // the controller flickers between air and ground physics every other frame.
    if (!hitGround && wasGrounded && vel.y <= 0.02 && jumpGrace <= 0) {
      const hs = Math.hypot(vel.x, vel.z);
      const probe = Math.min(T.stepHeight, 0.07 + hs * dt * 1.5);
      const r2 = moveCapsule(ctx, res.position, _v.set(0, -probe, 0));
      if (r2.grounded) { res = r2; hitGround = true; }
    }

    const dy = res.position.y - pos.y;
    pos.copy(res.position);
    groundNormal.copy(res.groundNormal || groundNormal);
    if (res.surface) surface = res.surface;

    /* -------------------------------------------------------------- ground */
    if (hitGround) {
      if (!wasGrounded) {
        const impact = Math.max(0, -prevVy);
        onLand(ctx, impact);
      }
      if (vel.y < 0) vel.y = 0;
      grounded = true;
    } else {
      grounded = false;
      if (!swimming) {
        vel.y -= T.gravity * 0.5 * dt;                 // second Verlet half-step
        if (vel.y < -T.terminal) vel.y = -T.terminal;
      }
    }

    // Step smoothing: only for discrete step-ups/downs, never for slopes — the
    // threshold is above anything a 52° slope can produce in one frame at sprint.
    if (grounded && wasGrounded && Math.abs(dy) > 0.06 && Math.abs(dy) < T.stepHeight + 0.05) {
      stepOffset = clamp(stepOffset - dy, -0.5, 0.5);
    }
    stepOffset *= 1 - approach(11, dt);

    /* ------------------------------------------------------- eye + landing */
    const targetEye = lerp(T.eyeStand, T.eyeCrouch, crouchBlend);
    eyeHeight += (targetEye - eyeHeight) * approach(14, dt);

    dipVel += (-T.landSpringK * dipPos - T.landSpringC * dipVel) * dt;
    dipPos += dipVel * dt;
    if (Math.abs(dipPos) < 1e-5 && Math.abs(dipVel) < 1e-4) { dipPos = 0; dipVel = 0; }

    /* ------------------------------------------------------------ head bob */
    updateBob(dt, ctx);

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

    /* ------------------------------------------------------------ fov push */
    const fovScale = ctx.config.fovScale ?? 1;
    const target = ((ctx.config.fov ?? T.fovBase) + T.fovSprint * sprintBlend) * fovScale;
    fov += (target - fov) * approach(T.fovRate, dt);

    /* --------------------------------------------------------- strafe tilt */
    const tiltTarget = -T.strafeTilt * inX * (grounded ? 1 : 0.55) * (1 - 0.4 * crouchBlend);
    strafeRoll += (tiltTarget - strafeRoll) * approach(6.5, dt);
    sprintLean += ((sprinting ? 1.4 * DEG : 0) - sprintLean) * approach(4.5, dt);
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

  function onLand(ctx, impact) {
    const dip = -Math.min(T.landDipMax, impact * T.landDipPerMS);
    dipVel += dip * 11.5;                       // impulse → the spring does the rest
    if (impact > 1.6) emitFootstep(ctx, impact > 5.5);
    ctx.emit('player:land', { position: pos.clone(), impact, surface, wade: waterDepth });
    if (impact > T.fallSafe) {
      const f = (impact - T.fallSafe) / (T.fallLethal - T.fallSafe);
      applyDamage(ctx, Math.pow(clamp(f, 0, 2), 1.5) * 1.6, null);
    }
  }

  /**
   * Figure-of-eight head bob on a distance-integrated step phase.
   *
   *   lateral  =  Ax·sin(p)        one cycle per stride
   *   vertical = −Ay·cos(2p)       two cycles per stride, minima exactly at p = 0, π
   *
   * so the head is lowest precisely when a foot plants, and the footstep event fires
   * on the same crossing. Sprint adds a stride-rate lope term (cos p) on top of the
   * step-rate term, which changes the shape of the cycle and not merely its size.
   */
  function updateBob(dt, ctx) {
    const hs = Math.hypot(vel.x, vel.z);
    const active = (grounded && !swimming) ? clamp(hs / 1.2, 0, 1) : 0;
    bobBlend += (active - bobBlend) * approach(active > bobBlend ? 8 : 5.5, dt);

    if (grounded && !swimming && hs > 0.35) {
      const stride = clamp(T.strideBase + T.strideSlope * hs, 1.35, 3.2)
                     * (crouching ? 0.86 : 1) * (1 + 0.25 * wade);
      stepPhase += TAU * (hs / stride) * dt;
      const idx = Math.floor(stepPhase / Math.PI);
      if (idx !== stepIndex) {
        stepIndex = idx;
        if (bobBlend > 0.22) emitFootstep(ctx, false);
      }
    }
    if (stepPhase > TAU * 1024) { stepPhase -= TAU * 1024; stepIndex -= 2048; }

    const spd01 = clamp(hs / T.walk, 0, 1.85);
    const amp = clamp(bobBlend * (0.55 + 0.62 * spd01), 0, 1.55)
                * (1 - 0.40 * crouchBlend) * (1 - 0.45 * wade);
    const p = stepPhase;
    const sB = sprintBlend;

    const Ay = T.bobVert + T.bobVertSprint * sB;
    const Ax = T.bobLat + T.bobLatSprint * sB;

    viewBobOffset.x = Ax * amp * Math.sin(p);
    viewBobOffset.y = -Ay * amp * Math.cos(2 * p) - 0.0085 * amp * sB * Math.cos(p);
    viewBobOffset.z = -T.bobFore * amp * Math.sin(2 * p);

    // Airborne float: the head lags the body a little, scaled by vertical speed.
    if (!grounded) viewBobOffset.y += clamp(-vel.y * 0.0125, -0.055, 0.055);

    viewBobAngles.z = -(T.bobRoll + T.bobRollSprint * sB) * amp * Math.sin(p) + strafeRoll;
    viewBobAngles.x = T.bobPitch * amp * Math.cos(2 * p) + dipPos * T.landPitchPerM - sprintLean;
    viewBobAngles.y = T.bobYaw * amp * Math.sin(p + 0.6);
  }

  /* --------------------------------------------------------- camera output */

  function writeCamera(ctx, snap) {
    const cam = ctx.camera;
    if (!cam) return;

    // Bob is applied in a yaw-only frame so that looking up or down does not swing
    // the vertical component sideways. (`viewBobOffset` itself stays camera-local:
    // the viewmodel is a child of the camera and wants it in that space.)
    const sy = Math.sin(yaw + recoilY), cy = Math.cos(yaw + recoilY);
    _bobW.set(
      viewBobOffset.x * cy + viewBobOffset.z * sy,
      viewBobOffset.y,
      viewBobOffset.z * cy - viewBobOffset.x * sy);

    eye.set(pos.x, pos.y + eyeHeight + dipPos + stepOffset, pos.z).add(_bobW);
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
