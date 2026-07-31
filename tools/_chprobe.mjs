#!/usr/bin/env node
/**
 * Character ground-contact probe.
 *
 * For every actor, walks the skinned rig, finds the LOWEST vertex of the bound mesh in
 * world space (that is the sole of the boot, not the ankle bone), and compares it to
 * both `terrain.height()` and a downward `physics.raycast()` at the same xz.
 *
 * Eyeballing this in a capture is hopeless: the encounter stands in ankle-deep water on
 * a wet shelf, so "the legs are cut off" is indistinguishable from "the legs are
 * underwater". The number is not ambiguous.
 *
 *   node tools/_chprobe.mjs --pose shot_tide_pools --settle 24
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = 1280, H = 720, POSE = arg('pose', 'shot_tide_pools'), SETTLE = +arg('settle', 16);

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
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development', HALO_NO_HMR: '1' } });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { } });
const base = `http://127.0.0.1:${port}`;
await waitForServer(base + '/index.html');

const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--enable-gpu',
    '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-device-scale-factor=1',
    '--hide-scrollbars', `--window-size=${W},${H}`, '--js-flags=--max-old-space-size=3072'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 600000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));
await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=1337`, { waitUntil: 'load', timeout: 600000 });
await page.evaluate(async () => { await globalThis.__HALO__.ready; });

const out = await page.evaluate(async (pose, settle) => {
  const HA = globalThis.__HALO__;
  const THREE = HA.THREE;
  HA.setTime(12.0); HA.setPose(pose); HA.advance(settle);
  const ctx = HA.engine.ctx;
  const ai = ctx.get('ai'), terrain = ctx.get('terrain'), physics = ctx.get('physics'), ocean = ctx.get('ocean');
  if (!ai) return { err: 'no ai module' };

  const rows = [];
  const down = new THREE.Vector3(0, -1, 0);
  const v = new THREE.Vector3();
  const sk = new THREE.Vector3();

  for (const a of ai.actors) {
    a.mesh.updateMatrixWorld(true);
    const g = a.mesh.geometry;
    const pos = g.getAttribute('position');
    // Skin the bind-pose vertices by hand: one bone per vertex, weight 1.
    const si = g.getAttribute('skinIndex');
    const bones = a.mesh.skeleton.bones;
    const bindInv = a.mesh.skeleton.boneInverses;
    let minY = Infinity, minX = 0, minZ = 0;
    for (let i = 0; i < pos.count; i++) {
      const b = si.getX(i);
      v.fromBufferAttribute(pos, i);
      sk.copy(v).applyMatrix4(bindInv[b]).applyMatrix4(bones[b].matrixWorld);
      // bones live under mesh which lives under group; matrixWorld is already world
      if (sk.y < minY) { minY = sk.y; minX = sk.x; minZ = sk.z; }
    }
    const th = terrain ? terrain.height(minX, minZ) : 0;
    let ph = null;
    if (physics && physics.raycast) {
      const hit = physics.raycast(new THREE.Vector3(minX, minY + 6, minZ), down, 20, physics.MASK ? physics.MASK.WORLD : undefined);
      ph = hit ? hit.point.y : null;
    }
    const sea = ocean && Number.isFinite(ocean.seaLevel) ? ocean.seaLevel : (ctx.config?.seaLevel ?? null);
    rows.push({
      id: a.id, type: a.type, major: a.major,
      px: +a.position.x.toFixed(2), pz: +a.position.z.toFixed(2),
      rootY: +a.position.y.toFixed(3),
      soleY: +minY.toFixed(3), soleX: +minX.toFixed(2), soleZ: +minZ.toFixed(2),
      terrY: +th.toFixed(3),
      physY: ph === null ? null : +ph.toFixed(3),
      gapTerr: +(minY - th).toFixed(3),
      gapPhys: ph === null ? null : +(minY - ph).toFixed(3),
      sea,
    });
  }
  return { rows, n: rows.length };
}, POSE, SETTLE);

console.log(JSON.stringify(out, null, 1));
for (const l of logs) if (/error|Error|fail/i.test(l)) console.log(l);
await browser.close();
process.exit(0);
