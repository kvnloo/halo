import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { buildModules } from './modules.js';
import { POSES } from './world/poses.js';

const canvas = document.getElementById('view');
const bootEl = document.getElementById('boot');
const barEl = document.getElementById('barfill');
const msgEl = document.getElementById('bootmsg');

const qs = new URLSearchParams(location.search);
const num = (k, d) => (qs.has(k) ? Number(qs.get(k)) : d);
const flag = (k, d = false) => (qs.has(k) ? qs.get(k) !== '0' && qs.get(k) !== 'false' : d);

/** Capture mode: fixed size, fixed timestep, no input, no auto-start. */
const CAPTURE = flag('capture', false);

const engine = new Engine(canvas, {
  seed: num('seed', 1337),
  deterministic: CAPTURE || flag('det', false),
  pixelRatio: CAPTURE ? 1 : Math.min(devicePixelRatio || 1, 2),
  width: num('w', 0),
  height: num('h', 0),
});

// Expose early so a harness attached before load can observe failures.
const api = {
  engine,
  THREE,
  ready: null,
  error: null,
  poses: POSES,
  capture: CAPTURE,
};
globalThis.__HALO__ = api;

api.ready = (async () => {
  for (const m of await buildModules({ capture: CAPTURE, qs })) engine.add(m);
  await engine.init((p, name) => {
    barEl.style.width = `${Math.round(p * 100)}%`;
    msgEl.textContent = name;
  });

  bootEl.classList.add('hidden');
  setTimeout(() => bootEl.remove(), 800);

  if (!CAPTURE) {
    engine.start();
  } else {
    // Render one frame so the canvas has valid contents even before advance().
    engine.step(engine.opts.fixedDt);
  }
  return true;
})().catch((e) => {
  api.error = String(e && e.stack || e);
  msgEl.textContent = 'ERROR — see console';
  msgEl.style.color = '#ff6a6a';
  console.error(e);
  throw e;
});

/* ------------------------------------------------------------- capture API */

/** Place the camera at an absolute pose. Angles in degrees. */
api.setPose = (p) => {
  const cam = engine.camera;
  if (typeof p === 'string') p = POSES[p];
  if (!p) throw new Error('unknown pose');
  cam.position.set(p.pos[0], p.pos[1], p.pos[2]);
  if (p.quat) cam.quaternion.fromArray(p.quat);
  else {
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(p.rot[0]),
      THREE.MathUtils.degToRad(p.rot[1]),
      THREE.MathUtils.degToRad(p.rot[2] || 0), 'YXZ');
    cam.quaternion.setFromEuler(e);
  }
  cam.fov = p.fov ?? 78;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  engine.ctx.emit('camera:teleport', p);
  return true;
};

api.setSize = (w, h) => {
  engine.opts.width = w; engine.opts.height = h;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  engine.resize(w, h);
  return true;
};

/** Advance n deterministic frames (lets TAA / temporal buffers converge). */
api.advance = (n = 1) => { engine.advance(n); return engine.clock.frame; };

/** Freeze all animated content so two captures of the same pose are identical. */
api.setTime = (t) => { engine.clock.t = t; return t; };

api.freeze = (v = true) => { engine.ctx.config.frozen = !!v; return v; };

api.screenshot = () => canvas.toDataURL('image/png');

api.stats = () => ({
  ...engine.stats,
  frame: engine.clock.frame,
  t: engine.clock.t,
  gpu: engine.caps.renderer,
  modules: engine.modules.map((m) => ({ name: m.name, ms: Math.round((m._initMs || 0) * 10) / 10 })),
});

api.setConfig = (k, v) => { engine.ctx.config[k] = v; engine.ctx.emit('config', { k, v }); return v; };

/** Hot toggle for A/B verification of an individual pass or module. */
api.togglePass = (name, on) => {
  const pipe = engine.ctx.get('pipeline');
  const p = pipe?.pass(name);
  if (p) { p.enabled = on ?? !p.enabled; return p.enabled; }
  const m = engine.ctx.get(name);
  if (m) { m.enabled = on ?? !m.enabled; return m.enabled; }
  return null;
};
