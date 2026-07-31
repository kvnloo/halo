#!/usr/bin/env node
/**
 * Per-pass frame-time profile for the four postfx passes, using the Engine.advance()
 * instrumentation from KNOWN_ISSUES 13 (which is the first instrumentation in this
 * project that is not a structural zero).
 *
 * There is no per-pass GPU timer in RenderPipeline, so a pass is priced by toggling it
 * off and differencing whole-frame ms. Each configuration is sampled in an INTERLEAVED
 * round-robin rather than in a block, and the whole round is repeated, so a slow patch of
 * GPU contention lands on every configuration equally instead of on whichever one
 * happened to run during it. Report the median of the per-round differences.
 *
 *   node tools/_pfxprof.mjs --pose ref_00120 --rounds 12
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const W = 1920, H = 1080, POSE = arg('pose', 'ref_00120');
const ROUNDS = +arg('rounds', 12), SAMPLES = +arg('samples', 40);

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
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const base = `http://127.0.0.1:${port}`;
await waitForServer(base + '/index.html');

const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--enable-gpu',
    '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-device-scale-factor=1',
    '--hide-scrollbars', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 900000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=1337`, { waitUntil: 'load', timeout: 600000 });

const out = await page.evaluate(async (pose, rounds, samples) => {
  const A = globalThis.__HALO__;
  await A.ready;
  A.setSize(innerWidth, innerHeight); A.setPose(pose); A.setTime(12.0); A.advance(48);

  const PASSES = ['bloom', 'dof', 'sharpen', 'grain'];
  const CONFIGS = ['all', 'none'].concat(PASSES.map((p) => 'no_' + p));
  const acc = {}; for (const c of CONFIGS) acc[c] = [];

  const measure = () => {
    for (let i = 0; i < 8; i++) A.advance(1);                 // warm this configuration
    const s = [];
    for (let i = 0; i < samples; i++) { const t = performance.now(); A.advance(1); s.push(performance.now() - t); }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.5)];
  };

  for (let r = 0; r < rounds; r++) {
    for (const c of CONFIGS) {
      for (const p of PASSES) A.togglePass(p, true);
      if (c === 'none') { for (const p of PASSES) A.togglePass(p, false); }
      else if (c !== 'all') A.togglePass(c.slice(3), false);
      acc[c].push(measure());
    }
  }
  for (const p of PASSES) A.togglePass(p, true);

  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const res = { rounds, samples, p50: {}, perPassMs: {} };
  for (const c of CONFIGS) res.p50[c] = +med(acc[c]).toFixed(3);
  { const diffs = acc.all.map((v, i) => v - acc.none[i]);
    const b = diffs.slice().sort((x,y)=>x-y);
    res.perPassMs.ALL_FOUR = { median: +b[Math.floor(b.length/2)].toFixed(3), min: +Math.min(...diffs).toFixed(3), max: +Math.max(...diffs).toFixed(3) }; }
  for (const p of PASSES) {
    const diffs = acc.all.map((v, i) => v - acc['no_' + p][i]);   // paired within a round
    res.perPassMs[p] = { median: +med(diffs).toFixed(3), min: +Math.min(...diffs).toFixed(3), max: +Math.max(...diffs).toFixed(3) };
  }
  res.stats = A.stats ? A.stats() : {};
  return res;
}, POSE, ROUNDS, SAMPLES);

console.log(JSON.stringify({ pose: POSE, rounds: out.rounds, samples: out.samples, p50: out.p50, perPassMs: out.perPassMs }, null, 2));
console.log('draws=' + (out.stats?.drawCalls ?? '?') + ' tris=' + (out.stats?.triangles ?? '?'));
await browser.close();
