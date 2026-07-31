#!/usr/bin/env node
/**
 * Bisect the exact-rgb(0,0,0) corruption on the ocean in `shot_sky_ring`.
 *
 * Captures the same pose under several `ctx.config` variants in ONE page load and reports
 * the exact-black pixel count for each, so the pass that produces the NaN is identified by
 * elimination rather than by reading shaders. Config overrides work independently of the
 * source tree (KNOWN_ISSUES 19), so this needs no edits and cannot be invalidated by
 * another agent writing `src/` mid-run.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'shots/blackab');
const W = 1920, H = 1080, SETTLE = 48, POSE = 'shot_sky_ring';

// name -> the pipeline pass or world module to switch off via __HALO__.togglePass()
const OFFABLE = ['ssr', 'ssao', 'cloudComposite', 'volumetricFog', 'taa', 'motionBlur',
  'bloom', 'sharpen', 'grain', 'ocean'];
const VARIANTS = [['baseline', null], ...OFFABLE.map((n) => [`${n}_off`, n])];

mkdirSync(OUT, { recursive: true });
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const port = await freePort();
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development', HALO_NO_HMR: '1' } });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 400; i++) {
  try { const r = await fetch(base + '/index.html'); if (r.ok || r.status === 404) break; } catch {}
  await new Promise((r) => setTimeout(r, 150));
}

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

for (const [name, off] of VARIANTS) {
  const r = await page.evaluate(async (pose, off, all, settle) => {
    const H = globalThis.__HALO__;
    const state = {};
    for (const n of all) state[n] = H.togglePass(n, true);      // restore everything
    if (off) state[off] = H.togglePass(off, false);             // then switch one off
    H.setSize(innerWidth, innerHeight);
    H.setPose(pose); H.setTime(12.0);
    H.advance(settle);
    return { du: H.screenshot(), state };
  }, POSE, off, OFFABLE, SETTLE);
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.du.split(',')[1], 'base64'));
  process.stderr.write(`captured ${name} (toggle -> ${JSON.stringify(r.state[off] ?? 'n/a')})\n`);
}
await browser.close();
cleanup();
process.exit(0);
