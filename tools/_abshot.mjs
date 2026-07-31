#!/usr/bin/env node
/**
 * Config A/B inside ONE page load.
 *
 * `tools/capture.mjs` re-boots vite+Chrome per request, so two captures minutes apart
 * are separated by whatever the other agents committed in between — during a live wave
 * that is six world files and up to 159 code values of unrelated drift, which swamps
 * any effect worth measuring. Here every variant shares one module graph, one set of
 * procedural textures and one RNG stream; the ONLY difference is `__HALO__.setConfig`.
 *
 * Each variant does a full setPose (which fires camera:teleport and resets every
 * temporal buffer) + settle, so variants do not contaminate each other. Repeat a
 * variant name to check within-page repeatability.
 *
 *   node tools/_abshot.mjs --pose ref_01500 --skip volumetricFog \
 *     --variants "new:,old:mvLegacyJitter=1,new2:" --outdir shots/mv/ab
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
  outdir: arg('outdir', 'shots/mv/ab'),
  w: +arg('w', 1920), h: +arg('h', 1080),
  settle: +arg('settle', 48),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  skip: arg('skip', null),
  // name:k=v;k=v , comma separated
  variants: arg('variants', 'new:,old:mvLegacyJitter=1'),
  pan: +arg('pan', 0),          // degrees of yaw per frame after settle (0 = static)
  panFrames: +arg('panFrames', 24),
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
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed) });
if (OPT.skip) q.set('skip', OPT.skip);
await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load' });
await page.evaluate(() => globalThis.__HALO__.ready);
// A pass that fails to load is swallowed by pipeline.js and silently removes the jitter.
// Every measurement below would then be meaningless, so refuse to take it.
const missing = await page.evaluate(() => globalThis.__HALO_MISSING_PASSES__ || []);
if (missing.length) { console.error('PASSES FAILED TO LOAD: ' + missing.join(' | ')); await browser.close(); cleanup(); process.exit(3); }

mkdirSync(resolve(ROOT, OPT.outdir), { recursive: true });
const out = [];
for (const spec of OPT.variants.split(',')) {
  const [name, kvs = ''] = spec.split(':');
  const r = await page.evaluate(async (kvs, pose, settle, t, pan, panFrames) => {
    const H = globalThis.__HALO__;
    const THREE = H.THREE;
    // reset every knob this tool touches to its default first, so variant order
    // cannot leak state between runs
    H.setConfig('mvLegacyJitter', 0);
    H.setConfig('mbShutter', 0.5);
    for (const kv of kvs.split(';')) {
      if (!kv) continue;
      const [k, v] = kv.split('=');
      H.setConfig(k, isNaN(+v) ? v : +v);
    }
    H.setSize(innerWidth, innerHeight);
    // Pin the world so the only difference between variants is the config under test.
    // freeze() stops player/physics/ai/particles/props/weapons/wind/time-of-day, and
    // re-applying setTime() before every single frame stops everything clock-driven.
    // Without this, variant N starts from variant N-1's simulation state and the
    // between-variant noise (mean 1.78 code values, measured) buries the effect.
    H.freeze(true);
    H.setTime(Number(t));
    H.setPose(pose);
    H.setTime(Number(t));
    for (let i = 0; i < settle; i++) { H.setTime(Number(t)); H.advance(1); }
    if (pan) {
      const cam = H.engine.camera;
      const p = H.poses[pose];
      const e = new THREE.Euler(0, 0, 0, 'YXZ');
      for (let i = 1; i <= panFrames; i++) {
        e.set(THREE.MathUtils.degToRad(p.rot[0]),
              THREE.MathUtils.degToRad(p.rot[1] + pan * i),
              THREE.MathUtils.degToRad(p.rot[2] || 0));
        cam.quaternion.setFromEuler(e);
        cam.updateMatrixWorld(true);
        H.setTime(Number(t));
        H.advance(1);
      }
    }
    const pipe = (H.engine.ctx.get('pipeline').pipe) || null;
    return { du: H.screenshot(), frameIndex: pipe ? pipe.frameIndex : -1,
             ms: H.stats().ms };
  }, kvs, OPT.pose, OPT.settle, OPT.time, OPT.pan, OPT.panFrames);

  const file = join(OPT.outdir, `${name}.png`);
  writeFileSync(resolve(ROOT, file), Buffer.from(r.du.split(',')[1], 'base64'));
  out.push({ name, file, frameIndex: r.frameIndex, ms: +r.ms.toFixed(2) });
  process.stderr.write(`captured ${name} (frameIndex ${r.frameIndex}, ${r.ms.toFixed(2)} ms/frame)\n`);
}

console.log(JSON.stringify({ ok: true, shots: out, errors: errs.slice(0, 10) }, null, 2));
await browser.close();
cleanup();
process.exit(0);
