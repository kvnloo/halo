#!/usr/bin/env node
/**
 * Capture the twelve showcase poses in ONE page load, bypassing the shared daemon.
 *
 * Why: the daemon is machine-wide and other agents can bury a request behind hundreds of
 * queued captures (observed: `queued: 449`). This is the same twelve frames
 * `previewsheet.mjs` wants, written to the same paths, so afterwards:
 *
 *     node tools/previewsheet.mjs --no-capture
 *
 * composites them without re-capturing. One vite + one Chrome, torn down on exit, so the
 * memory cost is bounded and transient (KNOWN_ISSUES 19).
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'shots/preview');
const W = 1920, H = 1080, SETTLE = +arg('settle', 48), TIME = '12.0', SEED = 1337;

const POSES = ['shot_beach_establishing', 'ref_00000', 'shot_forerunner_bridge',
  'shot_bridge_underside', 'shot_hero_stack', 'shot_stack_gauntlet',
  'shot_shoreline', 'shot_water_edge', 'shot_tide_pools',
  'shot_cliff_vegetation', 'shot_sky_ring', 'shot_weapon_detail'];

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
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e.message)));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));

await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=${SEED}`, { waitUntil: 'load' });
const boot = await page.evaluate(async () => {
  try { await globalThis.__HALO__.ready; } catch (e) { return { ok: false, err: String(e?.stack || e) }; }
  return { ok: true, missing: globalThis.__HALO_MISSING__ || [], failed: globalThis.__HALO__.failedModules() };
});
if (!boot.ok) { console.error('BOOT FAILED', boot.err, logs.join('\n')); process.exit(2); }

for (const pose of POSES) {
  const du = await page.evaluate(async (pose, t, settle) => {
    const H = globalThis.__HALO__;
    H.setSize(innerWidth, innerHeight);
    H.setPose(pose); H.setTime(Number(t));
    H.advance(settle);
    return H.screenshot();
  }, pose, TIME, SETTLE);
  writeFileSync(join(OUT, `${pose}.png`), Buffer.from(du.split(',')[1], 'base64'));
  process.stderr.write(`captured ${pose}\n`);
}

const stats = await page.evaluate(() => globalThis.__HALO__.stats());
console.log(JSON.stringify({ boot, drawCalls: stats.drawCalls, triangles: stats.triangles, logs }, null, 2));
await browser.close();
cleanup();
process.exit(0);
