#!/usr/bin/env node
/**
 * Boot-only probe. Fresh vite + Chrome (no daemon), loads the page, awaits
 * __HALO__.ready, and dumps VERBATIM: failedModules(), __HALO_MISSING__, every
 * console message, every pageerror, every failed request. Renders one frame at
 * ref_00000 so shader compiles actually happen and their logs are drained.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = 1920, H = 1080;

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitForServer(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('vite did not come up');
}

const port = await freePort();
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development', HALO_NO_HMR: '1' } });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

const base = `http://127.0.0.1:${port}`;
await waitForServer(base + '/index.html');

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-device-scale-factor=1',
    '--hide-scrollbars', `--window-size=${W},${H}`, '--js-flags=--max-old-space-size=2048'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});

const page = await browser.newPage();
page.setDefaultTimeout(600000);
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));

await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=1337`, { waitUntil: 'load' });

const boot = await page.evaluate(async () => {
  const out = { ok: false, err: null, missing: [], failed: [] };
  try { await globalThis.__HALO__.ready; out.ok = true; }
  catch (e) { out.err = String(e?.stack || e); }
  out.missing = globalThis.__HALO_MISSING__ || [];
  try { out.failed = globalThis.__HALO__.failedModules(); } catch (e) { out.failed = 'THREW: ' + String(e); }
  return out;
});

// force a real frame so every program compiles and any GLSL log is emitted
let frame = null;
try {
  frame = await page.evaluate(async () => {
    const H = globalThis.__HALO__;
    H.setSize(innerWidth, innerHeight);
    H.setPose('ref_00000'); H.setTime(12.0);
    H.advance(8);
    return H.stats();
  });
} catch (e) { frame = 'THREW: ' + String(e); }

console.log(JSON.stringify({ boot, frame, logs }, null, 2));
await browser.close();
cleanup();
process.exit(0);
