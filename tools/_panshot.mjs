#!/usr/bin/env node
/**
 * Moving-camera capture. `tools/capture.mjs` only ever shoots a static camera, so TAA
 * ghosting and velocity errors are invisible to it by construction. This settles at a
 * pose, then yaws the camera a fixed number of degrees per frame WITHOUT re-issuing
 * setPose (which would fire camera:teleport and reset the TAA history), and writes the
 * final frame — i.e. a frame taken in the middle of sustained motion.
 *
 *   node tools/_panshot.mjs --pose ref_01500 --deg 1.5 --frames 24 --out shots/pan.png
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OPT = {
  pose: arg('pose', 'ref_01500'),
  out: arg('out', 'shots/pan.png'),
  w: +arg('w', 1920), h: +arg('h', 1080),
  settle: +arg('settle', 48),
  deg: +arg('deg', 1.5),           // yaw degrees per frame
  frames: +arg('frames', 24),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  skip: arg('skip', null),
  config: arg('config', null),     // "k=v,k=v" poked through __HALO__.setConfig
};
const ROOT = resolve(new URL('..', import.meta.url).pathname);

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitForServer(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite did not come up');
}

const port = await freePort();
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development', HALO_NO_HMR: '1' } });
const cleanup = () => { try { server.kill('SIGKILL'); } catch { } };
process.on('exit', cleanup);
const base = `http://127.0.0.1:${port}`;
await waitForServer(base + '/index.html');

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--enable-gpu',
    '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-device-scale-factor=1',
    `--window-size=${OPT.w},${OPT.h}`],
  defaultViewport: { width: OPT.w, height: OPT.h, deviceScaleFactor: 1 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);

const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed) });
if (OPT.skip) q.set('skip', OPT.skip);
await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load' });
await page.evaluate(() => globalThis.__HALO__.ready);

const du = await page.evaluate(async (pose, settle, t, deg, frames, cfg) => {
  const H = globalThis.__HALO__;
  const THREE = H.THREE;
  if (cfg) for (const kv of cfg.split(',')) { const [k, v] = kv.split('='); H.setConfig(k, isNaN(+v) ? v : +v); }
  H.setSize(innerWidth, innerHeight);
  H.setPose(pose);
  H.setTime(Number(t));
  H.advance(settle);

  const cam = H.engine.camera;
  const p = H.poses[pose];
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  for (let i = 1; i <= frames; i++) {
    e.set(THREE.MathUtils.degToRad(p.rot[0]),
          THREE.MathUtils.degToRad(p.rot[1] + deg * i),
          THREE.MathUtils.degToRad(p.rot[2] || 0));
    cam.quaternion.setFromEuler(e);
    cam.updateMatrixWorld(true);
    H.advance(1);
  }
  return H.screenshot();
}, OPT.pose, OPT.settle, OPT.time, OPT.deg, OPT.frames, OPT.config);

const abs = resolve(ROOT, OPT.out);
mkdirSync(dirname(abs), { recursive: true });
writeFileSync(abs, Buffer.from(du.split(',')[1], 'base64'));
console.log(OPT.out);
await browser.close();
cleanup();
process.exit(0);
