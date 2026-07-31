#!/usr/bin/env node
/**
 * Steady-state per-pose perf + verbatim console capture.
 *
 * Why this exists: `capture.mjs` reports `engine.stats.ms`, which is an EMA that is
 * (a) seeded on a cold page so a single-pose run still carries shader-compile cost, and
 * (b) read once at the end of an --all run, so `scores/*.json` records the LAST pose's
 * number and calls it the run's. Neither is a per-pose steady state.
 *
 * Here: one page, one pose at a time, WARM warm-up frames discarded, then SAMPLES
 * individually-timed frames -> p50/p95/mean. Also drains every console message,
 * pageerror and failed request so shader errors are reported verbatim rather than
 * swallowed into the daemon's `warnings[]`.
 *
 *   node tools/_perfprobe.mjs
 *   node tools/_perfprobe.mjs --warm 30 --samples 90
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = +arg('w', 1920), H = +arg('h', 1080);
const WARM = +arg('warm', 30), SAMPLES = +arg('samples', 90);
const TIME = arg('time', '12.0'), SEED = +arg('seed', 1337);

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

await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=${SEED}`, { waitUntil: 'load' });

const boot = await page.evaluate(async () => {
  try { await globalThis.__HALO__.ready; } catch (e) { return { ok: false, err: String(e?.stack || e) }; }
  return { ok: true, missing: globalThis.__HALO_MISSING__ || [], failed: globalThis.__HALO__.failedModules() };
});

const poses = await page.evaluate(() => Object.keys(globalThis.__HALO__.poses).filter((k) => k.startsWith('ref_') || k.startsWith('shot_')));

const rows = [];
for (const pose of poses) {
  const r = await page.evaluate(async (pose, t, warm, n) => {
    const H = globalThis.__HALO__;
    H.setSize(innerWidth, innerHeight);
    H.setPose(pose); H.setTime(Number(t));
    H.advance(warm);                                   // discard: compiles + TAA converge
    const ms = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      H.advance(1);
      ms.push(performance.now() - t0);
    }
    const s = H.stats();
    ms.sort((a, b) => a - b);
    const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
    return {
      pose, p50: q(0.5), p95: q(0.95), mean: ms.reduce((a, b) => a + b, 0) / ms.length,
      max: ms[ms.length - 1], draws: s.drawCalls, tris: s.triangles, programs: s.programs,
    };
  }, pose, TIME, WARM, SAMPLES);
  rows.push(r);
  process.stderr.write(`probed ${pose}\n`);
}

console.log(JSON.stringify({ boot, rows, logs }, null, 2));
await browser.close();
cleanup();
process.exit(0);
