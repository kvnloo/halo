#!/usr/bin/env node
/** Integration probe: real frame ms, draw calls, collider accept/reject per source. */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = 1920, H = 1080, POSE = arg('pose', 'ref_00000'), SETTLE = +arg('settle', 48);

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitForServer(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('vite did not come up');
}

const port = await freePort();
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development' } });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
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
page.on('requestfailed', (r) => logs.push('[reqfail] ' + r.url()));

const SKIP = arg('skip', null);
await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=1337${SKIP ? '&skip=' + SKIP : ''}`, { waitUntil: 'load', timeout: 600000 });
const boot = await page.evaluate(async () => {
  try { await globalThis.__HALO__.ready; return { ok: true, missing: globalThis.__HALO_MISSING__ || [] }; }
  catch (e) { return { ok: false, err: String(e && e.stack || e), missing: globalThis.__HALO_MISSING__ || [] }; }
});

const out = await page.evaluate(async (pose, settle) => {
  const H = globalThis.__HALO__;
  H.setSize(innerWidth, innerHeight); H.setPose(pose); H.setTime(12.0); H.advance(settle);

  // ---- collider census -------------------------------------------------
  const ctx = H.ctx;
  const isV3 = (v) => !!(v && v.isVector3);
  const valid = (c) => {
    if (!c || typeof c !== 'object') return false;
    switch (c.type) {
      case 'sphere': return isV3(c.center) && Number.isFinite(c.radius);
      case 'box': return !!(c.box && c.box.isBox3);
      case 'capsule': case 'cylinder': return isV3(c.a) && isV3(c.b) && Number.isFinite(c.radius);
      default: return false;
    }
  };
  const census = {};
  for (const src of ['rocks', 'structures', 'props', 'vegetation', 'terrain']) {
    const m = ctx && ctx.get ? ctx.get(src) : null;
    const cs = (m && m.colliders) || [];
    const rec = { total: cs.length, ok: 0, bad: 0, byType: {} };
    for (const c of cs) {
      const t = String(c && c.type);
      rec.byType[t] = rec.byType[t] || { ok: 0, bad: 0 };
      if (valid(c)) { rec.ok++; rec.byType[t].ok++; } else { rec.bad++; rec.byType[t].bad++; }
    }
    census[src] = rec;
  }
  const phys = ctx && ctx.get ? ctx.get('physics') : null;
  const registered = phys && phys.debugStats ? phys.debugStats() : (phys && phys.staticCount ? phys.staticCount() : null);

  // ---- real frame timing ----------------------------------------------
  for (let i = 0; i < 20; i++) H.advance(1);           // warm
  const samples = [];
  for (let i = 0; i < 90; i++) {
    const t0 = performance.now(); H.advance(1); samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const pct = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  const stats = H.stats ? H.stats() : {};
  return {
    census, registered,
    frame: { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p50: pct(0.5), p95: pct(0.95), min: samples[0], max: samples[samples.length - 1] },
    stats,
  };
}, POSE, SETTLE);

console.log(JSON.stringify({ boot, ...out, logs: logs.filter((l) => /warn|error|fail|THREE|shader|not loaded|404/i.test(l)) }, null, 2));
await browser.close(); cleanup();
