#!/usr/bin/env node
/**
 * Deterministic frame capture.
 *
 * Boots the game headless on the real GPU (ANGLE/Vulkan -> RTX), places the camera at
 * a named pose, advances a fixed number of frames so every temporal buffer converges,
 * and writes a PNG. Same seed + same pose + same frame count => identical bytes.
 *
 *   node tools/capture.mjs --pose ref_00000 --out shots/a.png
 *   node tools/capture.mjs --all --outdir shots/latest
 *   node tools/capture.mjs --pose diag_sky --only sky,pipeline --settle 8
 *   node tools/capture.mjs --pose ref_00000 --video 120 --outdir shots/anim
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : d; };
const has = (k) => argv.includes('--' + k);

const OPT = {
  pose: arg('pose', 'ref_00000'),
  out: arg('out', null),
  outdir: arg('outdir', 'shots/latest'),
  w: +arg('w', 1920),
  h: +arg('h', 1080),
  settle: +arg('settle', 48),      // frames to converge TAA + temporal reprojection
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  only: arg('only', null),
  skip: arg('skip', null),
  all: has('all'),
  video: +arg('video', 0),         // capture N sequential frames instead of one
  port: +arg('port', 0),
  keepServer: has('keep-server'),
  timeout: +arg('timeout', 180000),
  verbose: has('verbose'),
  cfg: arg('config', null),
};

const ROOT = resolve(new URL('..', import.meta.url).pathname);

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function waitForServer(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url, { method: 'GET' }); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('vite did not come up at ' + url);
}

async function main() {
  const port = OPT.port || await freePort();
  const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: OPT.verbose ? 'inherit' : 'ignore', env: { ...process.env, NODE_ENV: 'development' } });
  const base = `http://127.0.0.1:${port}`;
  const cleanup = () => { try { server.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(1); });

  await waitForServer(base + '/index.html');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
      '--use-angle=vulkan', '--enable-features=Vulkan',
      '--disable-frame-rate-limit', '--disable-gpu-vsync',
      '--force-device-scale-factor=1', '--hide-scrollbars',
      `--window-size=${OPT.w},${OPT.h}`,
      '--js-flags=--max-old-space-size=6144',
    ],
    defaultViewport: { width: OPT.w, height: OPT.h, deviceScaleFactor: 1 },
    protocolTimeout: OPT.timeout,
  });

  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); logs.push(`[${m.type()}] ${t}`); if (OPT.verbose) console.error(' ', t.slice(0, 300)); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  page.on('requestfailed', (r) => logs.push('[404] ' + r.url()));

  const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed) });
  if (OPT.only) q.set('only', OPT.only);
  if (OPT.skip) q.set('skip', OPT.skip);

  await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load', timeout: OPT.timeout });

  const ok = await page.evaluate(async () => {
    try { await globalThis.__HALO__.ready; return { ok: true, missing: globalThis.__HALO_MISSING__ || [] }; }
    catch (e) { return { ok: false, err: String(e && e.stack || e), missing: globalThis.__HALO_MISSING__ || [] }; }
  });
  if (!ok.ok) {
    console.error('BOOT FAILED\n' + ok.err + '\n--- console ---\n' + logs.slice(-40).join('\n'));
    await browser.close(); cleanup(); process.exit(2);
  }
  if (ok.missing?.length) console.error('[capture] modules not loaded: ' + ok.missing.join(' | '));

  
  const cfg = OPT.cfg;
  const res = await page.evaluate(async (cfg) => {
    const H = globalThis.__HALO__;
    H.setSize(1920, 1080);
    H.setPose('ref_00720');
    H.setTime(12.0);
    if (cfg) for (const kv of cfg.split(',')) { const [k, v] = kv.split('='); H.setConfig(k, isNaN(+v) ? v : +v); }
    H.advance(4);
    const ctx = H.engine.ctx;
    const sky = ctx.get('sky');
    const env = ctx.get('env');
    const time = ctx.get('time');
    const sun = time.sunDir.clone().normalize();
    const l = Math.hypot(sun.x, sun.z) || 1;
    const perp = { x: -sun.z / l, z: sun.x / l };
    const dirs = {};
    const D = (n, x, y, z) => { const m = Math.hypot(x, y, z); dirs[n] = [x / m, y / m, z / m]; };
    D('zenith', 0, 1, 0);
    for (const el of [5, 10, 20, 30, 45, 60, 75]) {
      const ce = Math.cos(el * Math.PI / 180), se = Math.sin(el * Math.PI / 180);
      D('perp' + el, perp.x * ce, se, perp.z * ce);
      D('sunaz' + el, sun.x / l * ce, se, sun.z / l * ce);
      D('anti' + el, -sun.x / l * ce, se, -sun.z / l * ce);
    }
    const out = {};
    const c = new (Object.getPrototypeOf(time.sunColor).constructor)();
    for (const k of Object.keys(dirs)) {
      const d = dirs[k];
      sky.radiance({ x: d[0], y: d[1], z: d[2] }, c);
      out[k] = [c.r, c.g, c.b];
    }
    /* term attribution: toggle the shared uniforms radiance() reads and re-evaluate */
    const U = sky.skyMaterialUniforms;
    const save = { ms: U.uMsScale.value, mie: U.uMieScale.value,
                   ht: [U.uHazeTint.value.x, U.uHazeTint.value.y, U.uHazeTint.value.z] };
    const probeDirs = ['perp30', 'perp10', 'zenith', 'sunaz10'];
    const terms = {};
    const grab = (tag) => { for (const k of probeDirs) {
      const d = dirs[k]; sky.radiance({ x: d[0], y: d[1], z: d[2] }, c);
      (terms[k] = terms[k] || {})[tag] = [c.r, c.g, c.b]; } };
    grab('total');
    U.uMsScale.value = 0; grab('noMS');
    U.uMieScale.value = 0; grab('noMS_noMie');
    U.uHazeTint.value.set(0, 0, 0); grab('rayleighOnly');
    U.uMsScale.value = save.ms; U.uMieScale.value = save.mie;
    U.uHazeTint.value.set(save.ht[0], save.ht[1], save.ht[2]);
    return {
      radiance: out,
      terms,
      sunDisc: sky.sunDiscDebug ? sky.sunDiscDebug() : null,
      sunTint: [time.sunColor.r, time.sunColor.g, time.sunColor.b],
      sunDir: [sun.x, sun.y, sun.z],
      env: { groundIrradiance: env && env.groundIrradiance, intensity: env && env.settings && env.settings.intensity },
      cfg: { exposure: ctx.config.exposure, ev: ctx.config.exposureEV, tm: ctx.config.tonemapper },
    };
  }, cfg);
  console.log(JSON.stringify(res, null, 1));
  await browser.close();
  if (!OPT.keepServer) cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
