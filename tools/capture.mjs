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

  // Several agents capture concurrently, so a handful of Chrome instances can be
  // contending for the GPU at the same moment. Launch is the step that loses that race
  // (GPU process startup, shader cache locks); retry it rather than failing a whole
  // measurement run on a transient.
  const launchWithRetry = async (opts, tries = 4) => {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await puppeteer.launch(opts); }
      catch (e) {
        lastErr = e;
        const wait = 800 * (i + 1) + Math.floor(Math.random() * 700);
        process.stderr.write(`[capture] browser launch failed (${i + 1}/${tries}): ${e.message.slice(0, 120)} — retrying in ${wait}ms\n`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  };

  const browser = await launchWithRetry({
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
  page.setDefaultTimeout(OPT.timeout);
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

  const poses = OPT.all
    ? await page.evaluate(() => Object.keys(globalThis.__HALO__.poses).filter((k) => k.startsWith('ref_')))
    : [OPT.pose];

  const results = [];
  for (const pose of poses) {
    const dataUrls = await page.evaluate(async (pose, settle, t, nvid) => {
      const H = globalThis.__HALO__;
      H.setSize(innerWidth, innerHeight);
      H.setPose(pose);
      H.setTime(Number(t));
      H.advance(settle);
      if (nvid > 0) {
        const out = [];
        for (let i = 0; i < nvid; i++) { H.advance(1); out.push(H.screenshot()); }
        return out;
      }
      return [H.screenshot()];
    }, pose, OPT.settle, OPT.time, OPT.video, { timeout: OPT.timeout });

    dataUrls.forEach((du, i) => {
      const file = OPT.out && dataUrls.length === 1
        ? OPT.out
        : `${OPT.outdir}/${pose}${dataUrls.length > 1 ? '_' + String(i).padStart(4, '0') : ''}.png`;
      const abs = resolve(ROOT, file);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.from(du.split(',')[1], 'base64'));
      results.push(file);
    });
    if (!OPT.verbose) process.stderr.write(`captured ${pose}\n`);
  }

  const stats = await page.evaluate(() => globalThis.__HALO__.stats());
  console.log(JSON.stringify({ ok: true, files: results, stats,
    warnings: logs.filter((l) => /warn|error|404|THREE/i.test(l)).slice(0, 25) }, null, 2));

  await browser.close();
  if (!OPT.keepServer) cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
