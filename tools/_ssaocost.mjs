#!/usr/bin/env node
/**
 * What do GTAO + SSR actually cost, now that they render pixels for the first time?
 *
 * One page, one pose at a time. For each variant the passes are toggled via
 * `__HALO__.togglePass()`, WARM frames are discarded (so any recompile settles), then
 * SAMPLES individually-timed frames -> p50/p95. Same method as `_perfprobe.mjs`, so the
 * numbers are directly comparable to KNOWN_ISSUES §13/§22/§23 tables.
 *
 * Caveat inherited from §22: `performance.now()` around `advance()` measures CPU submit
 * cost, not GPU frame time. Comparable to each other; not frame times.
 *
 *   node tools/_ssaocost.mjs --poses ref_00000,ref_00600,shot_stack_gauntlet
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = +arg('w', 1920), H = +arg('h', 1080);
const WARM = +arg('warm', 24), SAMPLES = +arg('samples', 60);
const POSES = String(arg('poses', 'ref_00000,ref_00600,ref_02220,shot_stack_gauntlet')).split(',');

const VARIANTS = [
  { name: 'baseline (ssao+ssr on)', off: [] },
  { name: 'ssao off',               off: ['ssao'] },
  { name: 'ssr off',                off: ['ssr'] },
  { name: 'both off (= waveG)',     off: ['ssao', 'ssr'] },
];

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitForServer(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite did not come up');
}

const port = await freePort();
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development', HALO_NO_HMR: '1' } });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
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
  protocolTimeout: 900000,
});
const page = await browser.newPage();
page.setDefaultTimeout(900000);
await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=1337`, { waitUntil: 'load' });
await page.evaluate(async () => { await globalThis.__HALO__.ready; });

const out = [];
for (const pose of POSES) {
  for (const v of VARIANTS) {
    const r = await page.evaluate(async (pose, off, warm, n) => {
      const H = globalThis.__HALO__;
      for (const p of ['ssao', 'ssr']) H.togglePass(p, !off.includes(p));
      H.setSize(innerWidth, innerHeight);
      H.setPose(pose); H.setTime(12.0);
      H.advance(warm);
      const ms = [];
      for (let i = 0; i < n; i++) { const t0 = performance.now(); H.advance(1); ms.push(performance.now() - t0); }
      ms.sort((a, b) => a - b);
      const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
      return { p50: q(0.5), p95: q(0.95), mean: ms.reduce((a, b) => a + b, 0) / ms.length };
    }, pose, v.off, WARM, SAMPLES);
    out.push({ pose, variant: v.name, ...r });
    process.stderr.write(`${pose.padEnd(22)} ${v.name.padEnd(24)} p50=${r.p50.toFixed(2)}\n`);
  }
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
