#!/usr/bin/env node
/**
 * TAA convergence probe: does `--settle 48` actually converge?
 *
 * A plain "capture twice and cmp" cannot answer this. Between two settles the world
 * simulation has advanced (waves, wind, AI, particles), so any difference is a mixture
 * of TAA residual and real animation, and during a live wave it is also a mixture of
 * whatever other agents committed in between.
 *
 * Here the world is pinned: `__HALO__.freeze(true)` stops player/physics/ai/particles/
 * vegetation-wind/props/weapons/time, and `setTime(t)` is re-applied before every single
 * frame so `clock.t` never advances and the clock-driven surfaces (ocean, clouds) cannot
 * move either. The ONLY thing that changes between frames is the Halton jitter phase.
 * Every difference measured is therefore TAA and nothing else.
 *
 *   node tools/_convprobe.mjs --pose ref_01500 --skip volumetricFog \
 *     --frames "16,32,40,47,48,49,56,64,80,96,128" --outdir shots/mv/conv
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OPT = {
  pose: arg('pose', 'ref_01500'),
  outdir: arg('outdir', 'shots/mv/conv'),
  w: +arg('w', 1920), h: +arg('h', 1080),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  skip: arg('skip', null),
  config: arg('config', null),
  off: arg('off', null),          // comma-separated pass/module names to disable

  frames: (arg('frames', '16,32,40,47,48,49,56,64,80,96,128')).split(',').map(Number),
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
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.setDefaultTimeout(600000);
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed) });
if (OPT.skip) q.set('skip', OPT.skip);
await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load' });
await page.evaluate(() => globalThis.__HALO__.ready);
// A pass that fails to load is swallowed by pipeline.js and silently removes the jitter.
// Every measurement below would then be meaningless, so refuse to take it.
const missing = await page.evaluate(() => globalThis.__HALO_MISSING_PASSES__ || []);
if (missing.length) { console.error('PASSES FAILED TO LOAD: ' + missing.join(' | ')); await browser.close(); cleanup(); process.exit(3); }

const shots = await page.evaluate(async (pose, t, wanted, cfg, off) => {
  const H = globalThis.__HALO__;
  if (cfg) for (const kv of cfg.split(',')) { const [k, v] = kv.split('='); H.setConfig(k, isNaN(+v) ? v : +v); }
  if (off) for (const n of off.split(',')) H.togglePass(n, false);
  H.setSize(innerWidth, innerHeight);
  H.setTime(Number(t));
  H.freeze(true);
  H.setPose(pose);            // fires camera:teleport -> every temporal buffer resets
  const want = new Set(wanted);
  const max = Math.max(...wanted);
  const out = {};
  for (let n = 1; n <= max; n++) {
    H.setTime(Number(t));     // re-pin the clock so nothing clock-driven can advance
    H.advance(1);
    if (want.has(n)) out[n] = H.screenshot();
  }
  return out;
}, OPT.pose, OPT.time, OPT.frames, OPT.config, OPT.off);

mkdirSync(resolve(ROOT, OPT.outdir), { recursive: true });
const files = [];
for (const [n, du] of Object.entries(shots)) {
  const f = join(OPT.outdir, `f${String(n).padStart(4, '0')}.png`);
  writeFileSync(resolve(ROOT, f), Buffer.from(du.split(',')[1], 'base64'));
  files.push(f);
}
console.log(JSON.stringify({ ok: true, files, errors: errs.slice(0, 5) }, null, 2));
await browser.close();
cleanup();
process.exit(0);
