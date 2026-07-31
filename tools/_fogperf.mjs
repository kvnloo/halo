#!/usr/bin/env node
/**
 * Interleaved same-page cost A/B for the fog pass.
 *
 * One page, one pose, alternating `ctx.config` arms in blocks of individually-timed
 * frames. Two captures would compare different GPU states and page ages — reports/depth.md
 * 6 measured 2.7 ms of block-to-block drift *within one arm*, which is larger than
 * anything this pass costs, so the arms have to be interleaved on one page.
 *
 *   node tools/_fogperf.mjs --pose ref_00000 --arms "on=;off=fog=false" --block 90 --blocks 2
 *
 * Caveat (KNOWN_ISSUES 22): performance.now() around step() is CPU submit cost, not GPU
 * frame time.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = +arg('w', 1920), H = +arg('h', 1080);
const POSE = arg('pose', 'ref_00000');
const BLOCK = +arg('block', 90), BLOCKS = +arg('blocks', 2), DISCARD = +arg('discard', 20);
const TIME = arg('time', '12.0'), SEED = +arg('seed', 1337);
const ARMS = arg('arms', 'on=;off=fog=false').split(';').map((s) => {
  const i = s.indexOf('=');
  return { label: s.slice(0, i), cfg: s.slice(i + 1) };
});

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
await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=${SEED}`, { waitUntil: 'load' });
await page.evaluate(async () => { await globalThis.__HALO__.ready; });

const out = await page.evaluate(async (pose, t, arms, block, blocks, discard) => {
  const H = globalThis.__HALO__;
  H.setSize(innerWidth, innerHeight);
  H.setPose(pose); H.setTime(Number(t));
  const applied = [];
  const rows = [];
  for (let b = 0; b < blocks; b++) {
    for (const a of arms) {
      // Reset every key any arm touches, then apply this arm's.
      for (const other of arms) for (const kv of other.cfg.split(',')) {
        const k = kv.split('=')[0]; if (k) H.setConfig(k, undefined);
      }
      const seen = {};
      for (const kv of a.cfg.split(',')) {
        if (!kv) continue;
        const [k, v] = kv.split('=');
        const val = v === 'true' ? true : v === 'false' ? false : (isNaN(+v) ? v : +v);
        H.setConfig(k, val); seen[k] = val;
      }
      applied.push({ block: b, arm: a.label, applied: seen });
      H.advance(discard);
      const ms = [];
      for (let i = 0; i < block; i++) { const t0 = performance.now(); H.advance(1); ms.push(performance.now() - t0); }
      ms.sort((x, y) => x - y);
      const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
      rows.push({ block: b, arm: a.label, p50: q(0.5), p95: q(0.95), mean: ms.reduce((x, y) => x + y, 0) / ms.length });
    }
  }
  return { rows, applied };
}, POSE, TIME, ARMS, BLOCK, BLOCKS, DISCARD);

console.log(JSON.stringify({ pose: POSE, ...out, logs: logs.slice(-20) }, null, 1));
await browser.close();
cleanup();
process.exit(0);
