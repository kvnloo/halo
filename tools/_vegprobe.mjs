#!/usr/bin/env node
/** Vegetation placement probe: where are the landmarks, and where do they land on screen? */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = 1920, H = 1080, POSE = arg('pose', 'ref_00720');

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitForServer(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('vite did not come up');
}

const port = await freePort();
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development' } });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { } });
const base = `http://127.0.0.1:${port}`;
await waitForServer(base + '/index.html');

const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--enable-gpu',
    '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-device-scale-factor=1',
    '--hide-scrollbars', `--window-size=${W},${H}`, '--js-flags=--max-old-space-size=6144'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 600000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));
await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=1337`, { waitUntil: 'load', timeout: 600000 });
await page.evaluate(async () => { await globalThis.__HALO__.ready; });

const out = await page.evaluate(async () => {
  const HA = globalThis.__HALO__;
  HA.setSize(innerWidth, innerHeight); HA.setTime(12.0);
  const ctx = HA.engine.ctx;
  const rocks = ctx.get('rocks');
  const terrain = ctx.get('terrain');
  const THREE = HA.THREE;
  const cam = ctx.camera;
  const poses = Object.keys(HA.poses).filter((k) => k.startsWith('ref_'));
  const res = {};
  for (const pose of poses) {
    HA.setPose(pose); HA.advance(1);
    cam.updateMatrixWorld(true);
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const proj = (x, y, z) => {
      const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(vp);
      if (v.w <= 0) return null;
      return { sx: +((v.x / v.w * 0.5 + 0.5) * 1920).toFixed(0), sy: +((0.5 - v.y / v.w * 0.5) * 1080).toFixed(0), d: +v.w.toFixed(0) };
    };
    const list = [];
    for (const [id, L] of rocks.landmarks) {
      if (!L.crown) continue;
      const p = proj(L.crown.center.x, L.crown.center.y, L.crown.center.z);
      const px = p ? +(L.crown.radius / p.d * 1080 / (2 * Math.tan(cam.fov * Math.PI / 360))).toFixed(0) : 0;
      list.push({ id, p: p ? `${p.sx},${p.sy} d=${p.d} r=${px}px` : 'behind',
        inFrame: !!(p && p.sx > -50 && p.sx < 1970 && p.sy > -50 && p.sy < 1130) });
    }
    res[pose] = list;
  }
  return res;
}, POSE);

console.log(JSON.stringify(out, null, 1));
for (const l of logs) if (/veg|error|Error/i.test(l)) console.log(l);
await browser.close();
process.exit(0);
