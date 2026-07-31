/**
 * Headless movement probe for src/game/player.js.
 *
 * player.js is INERT under tools/capture.mjs — in `deterministic` mode it takes the
 * `syncFromCamera` early-return and never writes the camera, and every ref_* pose
 * hard-codes fov 78 in src/world/poses.js. So no image metric can validate this module.
 * The right instrument for a physics/feel file is a simulator, not a screenshot: this
 * runs the real module against a mocked ctx (flat ground at y=0, no physics module, so
 * moveCapsule takes its documented degraded path) and measures the quantities
 * research/feel.md specifies targets for.
 *
 *   node tools/_playerprobe.mjs [path/to/player.js] [--hz 60]
 */
import * as url from 'node:url';

const MOD = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2] : new URL('../src/game/player.js', import.meta.url).pathname;
const HZ = Number((process.argv.find((a) => a.startsWith('--hz')) || '--hz=60').split('=')[1] || 60);

/* ------------------------------------------------------------------ DOM stub */
const H = { win: {}, doc: {}, canvas: {} };
globalThis.window = {
  addEventListener: (ev, fn) => { H.win[ev] = fn; },
  removeEventListener: () => {},
};
globalThis.document = {
  getElementById: () => null,
  addEventListener: (ev, fn) => { H.doc[ev] = fn; },
  removeEventListener: () => {},
  pointerLockElement: null,
};

const THREE = await import('three');
const { create } = await import(url.pathToFileURL(MOD).href);

/* ------------------------------------------------------------------ ctx stub */
function makeCtx() {
  const events = [];
  const camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.1, 1000);
  return {
    camera,
    renderer: { domElement: { addEventListener: (e, f) => { H.canvas[e] = f; },
                              requestPointerLock: () => {} } },
    clock: { t: 0, frame: 0 },
    config: {},
    engine: { opts: { deterministic: false } },
    scene: null,
    get: () => null,
    emit: (n, p) => events.push({ n, p }),
    on: () => {},
    events,
  };
}

const key = (code, dn) => H.win[dn ? 'keydown' : 'keyup']?.({ code, repeat: false,
  preventDefault() {}, });

async function boot() {
  const ctx = makeCtx();
  const p = create();
  await p.init(ctx);
  const dt = 1 / HZ;
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      ctx.clock.t += dt; ctx.clock.frame++;
      p.update(dt, ctx);
    }
  };
  return { ctx, p, dt, step };
}

const R = {};
const f3 = (x) => Number(x.toFixed(3));
const f4 = (x) => Number(x.toFixed(4));

/* camera-local vertical offset: dip + step + bob + anything else the module adds */
const camOff = (p, ctx) => ctx.camera.position.y - p.position.y - p.eyeHeight;

/* ---------------------------------------------------- 1. jump: apex + hang */
{
  const { ctx, p, dt, step } = await boot();
  step(30);
  const y0 = p.position.y;
  let prevOff = camOff(p, ctx);
  key('Space', true);
  let apex = y0, frames = 0, air = false, landed = false, popTake = 0, popLand = 0;
  let dip = 0, impact = 0, tLand = 0, recover = 0;
  for (let i = 0; i < 600; i++) {
    const vyBefore = p.velocity.y;
    step(1);
    if (i === 0) key('Space', false);
    const off = camOff(p, ctx);
    const d = Math.abs(off - prevOff);
    if (!p.grounded) { if (!air) popTake = Math.max(popTake, d); air = true; frames++; }
    else if (air && !landed) { landed = true; impact = -vyBefore; popLand = Math.max(popLand, d); }
    else if (landed) {
      tLand += dt;
      const o = off - p.viewBobOffset.y;
      dip = Math.min(dip, o);
      if (o < 0.1 * dip) recover = tLand;
      if (tLand > 2.5) break;
    }
    prevOff = off;
    apex = Math.max(apex, p.position.y);
  }
  R.jumpV = f3(p.jumpVelocity);
  R.apex = f3(apex - y0);
  R.hang_s = f3(frames * dt);
  R.hang_frames60 = Math.round(frames * dt * 60);
  R.pop_takeoff_m = f4(popTake);
  R.pop_landing_m = f4(popLand);
  R.jump_land = { impact: f3(impact), dip: f4(-dip), recover: f3(recover) };
}

/* ------------------------------- 1b. camera-local pop, in the right reference frame
 * The camera may render an INTERPOLATED position (one tick behind at alpha 0), so
 * `camera.y - position.y` picks up a constant v·dt lag that is not a pop. Sampling at
 * exactly the sim rate makes the lag exactly one tick, so we evaluate the camera-local
 * offset against both the current and the previous tick's feet and keep whichever is
 * coherent (the wrong frame turns free flight into a constant 5 cm "pop" every frame). */
{
  const ctx = makeCtx();
  const p = create();
  await p.init(ctx);
  const hz = 120, sdt = 1 / hz;
  const st = (n = 1) => { for (let i = 0; i < n; i++) { ctx.clock.t += sdt; ctx.clock.frame++; p.update(sdt, ctx); } };
  st(60);
  let prevY = p.position.y;
  let offA = ctx.camera.position.y - p.position.y - p.eyeHeight;
  let offB = offA;
  let popA = 0, popB = 0, air = false, done = false, after = 0;
  key('Space', true);
  for (let i = 0; i < 600 && !done; i++) {
    st(1);
    if (i === 0) key('Space', false);
    const a = ctx.camera.position.y - p.position.y - p.eyeHeight;
    const b = ctx.camera.position.y - prevY - p.eyeHeight;
    popA = Math.max(popA, Math.abs(a - offA));
    popB = Math.max(popB, Math.abs(b - offB));
    offA = a; offB = b; prevY = p.position.y;
    if (!p.grounded) air = true; else if (air) { if (++after > 30) done = true; }
  }
  R.pop_camera_local_m = f4(Math.min(popA, popB));
}

/* -------------------------------------------------- 2. landing dip profile */
async function dipFor(dropH) {
  const { ctx, p, dt, step } = await boot();
  step(30);
  p.teleport({ x: p.position.x, y: dropH, z: p.position.z });
  let peak = 0, impact = 0, air = true, settle = 0, t = 0;
  for (let i = 0; i < 900; i++) {
    const vy = p.velocity.y;
    step(1);
    if (air && p.grounded) { air = false; impact = -vy; t = 0; }
    if (!air) {
      t += dt;
      const off = camOff(p, ctx) - p.viewBobOffset.y;
      peak = Math.min(peak, off);
      if (Math.abs(off) > 0.1 * Math.abs(peak) && peak < 0) settle = t;
      if (t > 3) break;
    }
  }
  return { impact: f3(impact), dip: f4(-peak), recover: f3(settle) };
}
R.land_plainjump = await dipFor(2.13);     // ≈ what a normal jump lands at
R.land_4m = await dipFor(4.0);
R.land_10m = await dipFor(10.0);

/* ------------------------------------------------- 3. steady speed envelope */
async function envelope(codes) {
  const { ctx, p, step } = await boot();
  step(20);
  for (const c of codes) key(c, true);
  step(180);
  const s = Math.hypot(p.velocity.x, p.velocity.z);
  for (const c of codes) key(c, false);
  return s;
}
const eF = await envelope(['KeyW']);
const eD = await envelope(['KeyW', 'KeyD']);
const eS = await envelope(['KeyD']);
const eB = await envelope(['KeyS']);
const eSp = await envelope(['KeyW', 'ShiftLeft']);
const eCr = await envelope(['KeyW', 'ControlLeft']);
const eWk = await envelope(['KeyW', 'AltLeft']);
R.speed = { fwd: f3(eF), diag45: f3(eD), strafe: f3(eS), back: f3(eB),
            sprint: f3(eSp), crouch: f3(eCr), slowwalk: f3(eWk) };
R.speed_ratio = { diag: f3(eD / eF), strafe: f3(eS / eF), back: f3(eB / eF) };

/* ------------------------------------------------------ 4. ramp + coast */
{
  const { ctx, p, dt, step } = await boot();
  step(20);
  key('KeyW', true);
  let ramp = 0;
  for (let i = 0; i < 600; i++) { step(1); if (Math.hypot(p.velocity.x, p.velocity.z) >= 0.95 * eF) { ramp = (i + 1) * dt; break; } }
  step(120);
  key('KeyW', false);
  const x0 = p.position.x, z0 = p.position.z;
  let stop = 0;
  for (let i = 0; i < 900; i++) {
    step(1);
    if (Math.hypot(p.velocity.x, p.velocity.z) < 1e-4) { stop = (i + 1) * dt; break; }
  }
  R.ramp95_s = f3(ramp);
  R.coast_m = f3(Math.hypot(p.position.x - x0, p.position.z - z0));
  R.stop_s = f3(stop);
}

/* --------------------------------------------------------------- 5. bob */
{
  const { ctx, p, step } = await boot();
  step(20);
  key('KeyW', true);
  step(180);
  let ay = 0, ax = 0, ar = 0, hy = 0;
  for (let i = 0; i < 240; i++) {
    step(1);
    ay = Math.max(ay, Math.abs(p.viewBobOffset.y));
    ax = Math.max(ax, Math.abs(p.viewBobOffset.x));
    ar = Math.max(ar, Math.abs(p.viewBobAngles.z));
    if (p.handBobOffset) hy = Math.max(hy, Math.abs(p.handBobOffset.y));
  }
  key('KeyW', false);
  R.bob_run = { vert_m: f4(ay), pct_eye: f3(100 * ay / p.eyeHeight), lat_m: f4(ax),
                roll_deg: f3(ar * 180 / Math.PI), hand_vert_m: f4(hy) };
}
/* sprint-speed bob (the speed the old file called "sprint" = Halo's actual run) */
{
  const { ctx, p, step } = await boot();
  step(20);
  key('KeyW', true); key('ShiftLeft', true);
  step(240);
  let ay = 0, ax = 0, ar = 0;
  for (let i = 0; i < 240; i++) {
    step(1);
    ay = Math.max(ay, Math.abs(p.viewBobOffset.y));
    ax = Math.max(ax, Math.abs(p.viewBobOffset.x));
    ar = Math.max(ar, Math.abs(p.viewBobAngles.z));
  }
  R.bob_sprint = { vert_m: f4(ay), pct_eye: f3(100 * ay / p.eyeHeight), lat_m: f4(ax),
                   roll_deg: f3(ar * 180 / Math.PI) };
}

/* ------------------------------------------------------------- 6. camera */
{
  const { ctx, p, step } = await boot();
  step(10);
  const v = ctx.camera.fov;
  R.fov_vert = f3(v);
  R.fov_horiz_16x9 = f3(2 * Math.atan(Math.tan(v * Math.PI / 360) * 16 / 9) * 180 / Math.PI);
  R.sens_rad_per_count = p.TUNE.sensitivity;
  R.cm_per_360_at_800dpi = f3(2.54 * 360 / (800 * (p.TUNE.sensitivity * 180 / Math.PI)));
  R.stepHeight = f3(p.TUNE.stepHeight);
  R.maxSlopeDeg = p.TUNE.maxSlopeDeg;
  R.gravity = p.TUNE.gravity;
}

/* ------------------------------------------------- 7. slope velocity scaling
 * Needs a physics module that reports a real ground normal, so mock one: an infinite
 * ramp y = tan(θ)·x, walking +x is uphill. feel.md §2.7's visual tell for getting this
 * wrong is "running up a 30° ramp at unchanged speed makes the level feel like a flat
 * plane with painted-on relief". */
async function onSlope(deg, yawDeg) {
  const th = deg * Math.PI / 180, tn = Math.tan(th);
  const n = new THREE.Vector3(-Math.sin(th), Math.cos(th), 0);
  const ctx = makeCtx();
  const res = { position: new THREE.Vector3(), grounded: false,
                groundNormal: n.clone(), surface: 'sand' };
  ctx.get = (name) => name === 'terrain' ? { height: (x) => tn * x } : name === 'physics' ? {
    MASK: { WORLD: 1 },
    moveCharacter(from, delta) {
      res.position.copy(from).add(delta);
      const gy = tn * res.position.x;
      res.grounded = res.position.y <= gy + 0.06;
      if (res.position.y < gy) res.position.y = gy;
      res.groundNormal.copy(n);
      return res;
    },
  } : null;
  const p = create();
  await p.init(ctx);
  const dt = 1 / 60;
  const st = (k) => { for (let i = 0; i < k; i++) { ctx.clock.t += dt; ctx.clock.frame++; p.update(dt, ctx); } };
  st(30);
  p.teleport({ x: 0, y: 0, z: 0 }, yawDeg);
  key('KeyW', true);
  st(300);
  const s = Math.hypot(p.velocity.x, p.velocity.z);
  key('KeyW', false);
  return f3(s);
}
// forward = (-sin yaw, 0, -cos yaw): yaw 270° faces +x (uphill), yaw 90° faces -x.
R.slope = {};
for (const deg of [0, 15, 30, 45]) {
  R.slope[`up_${deg}`] = await onSlope(deg, 270);
  R.slope[`down_${deg}`] = await onSlope(deg, 90);
}

/* ------------------------------------------------- 8. hard-landing input lock */
{
  const { ctx, p, dt, step } = await boot();
  step(20);
  p.teleport({ x: p.position.x, y: 12, z: p.position.z });
  let locked = 0, sawLock = false;
  for (let i = 0; i < 400; i++) {
    step(1);
    if (p.inputLocked) { locked += dt; sawLock = true; }
    else if (sawLock) break;
  }
  R.hard_land_lock_s = f3(locked);
}

console.log(JSON.stringify(R, null, 2));
