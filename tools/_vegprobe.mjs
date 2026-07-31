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

const out = await page.evaluate(async (pose) => {
  const HA = globalThis.__HALO__;
  HA.setSize(innerWidth, innerHeight); HA.setTime(12.0); HA.setPose(pose); HA.advance(2);
  const ctx = HA.engine.ctx;
  const THREE = HA.THREE;
  const cam = ctx.camera; cam.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const veg = ctx.get('vegetation');
  const rows = [];
  veg.group.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry;
    const ap = g.getAttribute('aPos');
    const ao = g.getAttribute('aOri');
    const info = { mat: m.material.userData?.veg ? (m.material.name || '') : '', n: g.instanceCount,
      key: m.material.type, tris: g.index ? g.index.count / 3 : 0,
      bs: g.boundingSphere ? [+g.boundingSphere.center.x.toFixed(1), +g.boundingSphere.center.y.toFixed(1), +g.boundingSphere.center.z.toFixed(1), +g.boundingSphere.radius.toFixed(1)] : null,
      visible: m.visible, frustumCulled: m.frustumCulled };
    // project first few instances
    const pts = [];
    for (let i = 0; i < Math.min(ap.count, 40); i++) {
      const x = ap.getX(i), y = ap.getY(i), z = ap.getZ(i);
      const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(vp);
      if (v.w <= 0) continue;
      const sx = (v.x / v.w * 0.5 + 0.5) * 1920, sy = (0.5 - v.y / v.w * 0.5) * 1080;
      if (sx > -200 && sx < 2100 && sy > -200 && sy < 1300) {
        pts.push(`${sx.toFixed(0)},${sy.toFixed(0)} d${v.w.toFixed(0)} sY${ao ? ao.getZ(i).toFixed(2) : '?'}`);
      }
    }
    info.onscreen = pts.slice(0, 10);
    rows.push(info);
  });
  return { rows, stats: veg.stats };
}, POSE);

console.log(JSON.stringify(out, null, 1));
for (const l of logs) if (/veg|error|Error/i.test(l)) console.log(l);
await browser.close();
process.exit(0);
