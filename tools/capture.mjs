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
import { writeFileSync, readFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join as pjoin } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';

/**
 * Global capture semaphore.
 *
 * A dozen-plus agents build concurrently, and each capture spawns its own vite + Chrome
 * with a 1080p WebGL context. Unbounded, that exhausts system memory long before it
 * saturates the GPU — measured 14 GB of 15 GB used with 17 agents in flight. The GPU is
 * the real bottleneck anyway (89% busy at 4 concurrent), so serialising past that point
 * costs nothing in throughput and buys back all the headroom.
 *
 * Slots are lock files in a shared tmp dir, taken with O_EXCL and released on exit.
 * Stale slots (holder died) are reaped by age.
 */
const SEM_DIR = pjoin(tmpdir(), 'halo-capture-sem');
const SEM_SLOTS = Number(process.env.HALO_CAPTURE_SLOTS || 4);
const SEM_STALE_MS = 8 * 60 * 1000;
let heldSlot = null;

async function acquireSlot() {
  mkdirSync(SEM_DIR, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    // reap stale holders
    for (const f of readdirSync(SEM_DIR)) {
      try {
        if (Date.now() - statSync(pjoin(SEM_DIR, f)).mtimeMs > SEM_STALE_MS) unlinkSync(pjoin(SEM_DIR, f));
      } catch { }
    }
    for (let i = 0; i < SEM_SLOTS; i++) {
      const p = pjoin(SEM_DIR, `slot${i}.lock`);
      try { closeSync(openSync(p, 'wx')); heldSlot = p; return; } catch { }
    }
    if (Date.now() - t0 > 15 * 60 * 1000) return;   // never deadlock a build
    await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 900)));
  }
}
function releaseSlot() {
  if (heldSlot) { try { unlinkSync(heldSlot); } catch { } heldSlot = null; }
}
process.on('exit', releaseSlot);
process.on('SIGINT', () => { releaseSlot(); process.exit(1); });
process.on('SIGTERM', () => { releaseSlot(); process.exit(1); });

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


/* ------------------------------------------------------------ capture daemon --- */
/**
 * Delegate to the shared capture daemon when one is up (or can be started). It holds a
 * single vite + Chrome for the whole machine, so memory stays O(1) in the number of
 * concurrent agents instead of O(N). Any failure falls through to the standalone path
 * below, so this is strictly an optimisation - it can never be the reason a build fails.
 */
const PORT_FILE = '/tmp/halo-captured.port';

async function daemonPort() {
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(PORT_FILE)) {
      const p = readFileSync(PORT_FILE, 'utf8').trim();
      try {
        const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(2500) });
        if (r.ok) return p;
      } catch { }
      try { unlinkSync(PORT_FILE); } catch { }   // stale
    }
    if (attempt === 0 && !process.env.HALO_NO_DAEMON) {
      // start it detached and wait briefly for it to publish its port
      try {
        const child = spawn('node', ['tools/captured.mjs'],
          { cwd: ROOT, detached: true, stdio: 'ignore' });
        child.unref();
      } catch { return null; }
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (existsSync(PORT_FILE)) break;
      }
    } else return null;
  }
  return null;
  } catch { return null; }
}

async function viaDaemon(poses, all = false) {
  const port = await daemonPort();
  if (!port) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        poses, all, w: OPT.w, h: OPT.h, settle: OPT.settle, time: OPT.time,
        seed: OPT.seed, only: OPT.only, skip: OPT.skip, video: OPT.video,
      }),
      // nine poses in one page load legitimately takes minutes under load
      signal: AbortSignal.timeout(Math.max(OPT.timeout, (all ? 9 : (poses?.length || 1)) * 120000)),
    });
    if (!r.ok) return null;
    const out = await r.json();
    return out.ok ? out : null;
  } catch { return null; }
}

async function main() {
  // Fast path: a shared daemon already holds a vite + Chrome. No semaphore needed -
  // the daemon bounds its own concurrency.
  if (!OPT.port && !process.env.HALO_NO_DAEMON) {
    {
      const d = await viaDaemon(OPT.all ? null : [OPT.pose], OPT.all);
      if (d) {
        const files = [];
        for (const [pose, urls] of Object.entries(d.shots)) {
          urls.forEach((du, i) => {
            const file = OPT.out && urls.length === 1
              ? OPT.out
              : `${OPT.outdir}/${pose}${urls.length > 1 ? '_' + String(i).padStart(4, '0') : ''}.png`;
            const abs = resolve(ROOT, file);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, Buffer.from(du.split(',')[1], 'base64'));
            files.push(file);
          });
          process.stderr.write(`captured ${pose} (daemon)\n`);
        }
        if (d.missing?.length) console.error('[capture] modules not loaded: ' + d.missing.join(' | '));
        console.log(JSON.stringify({ ok: true, via: 'daemon', files, stats: d.stats, warnings: d.warnings || [] }, null, 2));
        return;
      }
    }
  }

  await acquireSlot();          // bounded concurrency: see the semaphore above
  const port = OPT.port || await freePort();
  const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: OPT.verbose ? 'inherit' : 'ignore', env: { ...process.env, NODE_ENV: 'development', HALO_NO_HMR: '1' } });
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
      '--js-flags=--max-old-space-size=2048',
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
  releaseSlot();
}

main().catch((e) => { console.error(e); process.exit(1); });
