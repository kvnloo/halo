#!/usr/bin/env node
/**
 * Capture daemon — one vite, one Chrome, shared by every agent.
 *
 * Without this, each `capture.mjs` invocation spawns its own vite server and its own
 * headless Chrome with a 1080p WebGL context. With a dozen agents building concurrently
 * that is ~1 GB each and it exhausted system memory (measured 14 GB of 15 GB used, 0 GB
 * available, at 17 agents). A semaphore bounds it, but bounding still means N browsers.
 *
 * This holds ONE browser and ONE vite for the whole machine and serves capture requests
 * over a local HTTP socket, so memory is O(1) in the number of agents instead of O(N).
 * `capture.mjs` auto-starts it, delegates to it, and silently falls back to standalone
 * if it is unreachable — so nothing breaks if it dies.
 *
 *   node tools/captured.mjs           # run in foreground (it self-daemonises from capture.mjs)
 *   node tools/captured.mjs --stop
 *   curl localhost:$(cat /tmp/halo-captured.port)/health
 *
 * Pages are NOT cached across requests: agents are editing shaders continuously, and a
 * cached page would silently serve a stale build. A fresh page per request still saves
 * the browser process, which is the part that costs a gigabyte.
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import net from 'node:net';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT_FILE = '/tmp/halo-captured.port';
const argv = process.argv.slice(2);

if (argv.includes('--stop')) {
  if (existsSync(PORT_FILE)) {
    const p = readFileSync(PORT_FILE, 'utf8').trim();
    try { await fetch(`http://127.0.0.1:${p}/stop`); } catch { }
    try { unlinkSync(PORT_FILE); } catch { }
    console.log('stopped');
  }
  process.exit(0);
}

const IDLE_SHUTDOWN_MS = 20 * 60 * 1000;
/** How many pages may render at once. Each is a live WebGL context; the GPU saturates
 *  around 3-4 concurrent 1080p contexts, so more buys nothing and costs memory. */
const MAX_INFLIGHT = Number(process.env.HALO_DAEMON_INFLIGHT || 3);

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitForServer(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('vite did not start');
}

/* ------------------------------------------------------------ start vite + chrome */
const vitePort = await freePort();
const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(vitePort),
  '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HALO_NO_HMR: '1' } });
const BASE = `http://127.0.0.1:${vitePort}`;
await waitForServer(BASE + '/index.html');

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/google-chrome-stable',
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
    '--use-angle=vulkan', '--enable-features=Vulkan',
    '--disable-frame-rate-limit', '--disable-gpu-vsync',
    '--force-device-scale-factor=1', '--hide-scrollbars',
    '--js-flags=--max-old-space-size=2048',
  ],
  protocolTimeout: 300000,
});

let inflight = 0;
const queue = [];
function acquire() {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise((res) => queue.push(res));
}
function release() {
  inflight--;
  const next = queue.shift();
  if (next) { inflight++; next(); }
}

let lastUse = Date.now();
let served = 0;

/**
 * Render one request. `poses` may hold many names — they are captured in a SINGLE page
 * load, which is the batching that makes a nine-pose preview cost one init instead of nine.
 */
async function doCapture(req) {
  const { poses: reqPoses, all = false, w = 1920, h = 1080, settle = 48, time = 12.0, seed = 1337, only, skip, video = 0, config = null } = req;
  await acquire();
  const page = await browser.newPage();
  const logs = [];
  try {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    page.setDefaultTimeout(300000);
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));

    const q = new URLSearchParams({ capture: '1', w: String(w), h: String(h), seed: String(seed) });
    if (only) q.set('only', only);
    if (skip) q.set('skip', skip);
    // cache-buster: agents edit shaders continuously and a warm module graph would
    // silently serve a stale build
    q.set('_t', String(served++));

    await page.goto(`${BASE}/index.html?${q}`, { waitUntil: 'load', timeout: 300000 });
    const ready = await page.evaluate(async () => {
      try { await globalThis.__HALO__.ready; return { ok: true, missing: globalThis.__HALO_MISSING__ || [] }; }
      catch (e) { return { ok: false, err: String(e && e.stack || e), missing: globalThis.__HALO_MISSING__ || [] }; }
    });
    if (!ready.ok) return { ok: false, err: ready.err, logs: logs.slice(-40) };

    // Resolving --all here means nine poses share ONE page init - the module graph,
    // procedural textures, LUTs and cloud noise are all built once instead of nine times.
    const poses = all
      ? await page.evaluate(() => Object.keys(globalThis.__HALO__.poses).filter((k) => k.startsWith('ref_')))
      : reqPoses;

    const out = {};
    for (const pose of poses) {
      out[pose] = await page.evaluate(async (pose, settle, t, nvid, cfg) => {
        const H = globalThis.__HALO__;
        if (cfg) for (const kv of cfg.split(',')) { const [k,v]=kv.split('='); H.setConfig(k, isNaN(+v)? v : +v); }
        H.setSize(innerWidth, innerHeight);
        H.setPose(pose);
        H.setTime(Number(t));
        H.advance(settle);
        if (nvid > 0) {
          const a = [];
          for (let i = 0; i < nvid; i++) { H.advance(1); a.push(H.screenshot()); }
          return a;
        }
        return [H.screenshot()];
      }, pose, settle, time, video, config);
    }
    const stats = await page.evaluate(() => globalThis.__HALO__.stats());
    return { ok: true, shots: out, stats, missing: ready.missing,
             warnings: logs.filter((l) => /warn|error|THREE|Shader/i.test(l)).slice(0, 25) };
  } catch (e) {
    return { ok: false, err: String(e && e.stack || e), logs: logs.slice(-40) };
  } finally {
    try { await page.close(); } catch { }
    release();
    lastUse = Date.now();
  }
}

/* ------------------------------------------------------------------- http surface */
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, inflight, queued: queue.length, served, base: BASE }));
  }
  if (req.url === '/stop') { res.end('bye'); shutdown(); return; }
  if (req.url !== '/capture') { res.writeHead(404); return res.end(); }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    lastUse = Date.now();
    let out;
    try { out = await doCapture(JSON.parse(body)); }
    catch (e) { out = { ok: false, err: String(e) }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

async function shutdown() {
  try { unlinkSync(PORT_FILE); } catch { }
  try { await browser.close(); } catch { }
  try { vite.kill('SIGKILL'); } catch { }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setInterval(() => {
  if (inflight === 0 && queue.length === 0 && Date.now() - lastUse > IDLE_SHUTDOWN_MS) shutdown();
}, 30000).unref?.();

const port = await freePort();
server.listen(port, '127.0.0.1', () => {
  mkdirSync(dirname(PORT_FILE), { recursive: true });
  writeFileSync(PORT_FILE, String(port));
  process.stderr.write(`[captured] ready on ${port}, vite ${vitePort}, max ${MAX_INFLIGHT} concurrent\n`);
});
