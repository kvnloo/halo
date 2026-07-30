#!/usr/bin/env node
/* Dev harness for the clouds module: capture with ctx.config pokes + module toggles
 * + optional numeric probes. Scratch tooling, not part of the build. */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : d; };
const all = (k) => argv.reduce((a, v, i) => (v === '--' + k ? a.concat(argv[i + 1]) : a), []);
const has = (k) => argv.includes('--' + k);

const OPT = {
  pose: arg('pose', 'ref_00720'),
  out: arg('out', 'shots/probe.png'),
  w: +arg('w', 1920), h: +arg('h', 1080),
  settle: +arg('settle', 44),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  only: arg('only', 'time,lighting,sky,clouds,pipeline'),
  cfg: all('cfg'),
  off: all('off'),
  probe: has('probe'),
  timeout: 240000,
};

const ROOT = resolve(new URL('..', import.meta.url).pathname);

async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
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
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development' } });
const base = `http://127.0.0.1:${port}`;
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
await waitForServer(base + '/index.html');

const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--enable-gpu',
    '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
    '--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-device-scale-factor=1',
    '--hide-scrollbars', `--window-size=${OPT.w},${OPT.h}`],
  defaultViewport: { width: OPT.w, height: OPT.h, deviceScaleFactor: 1 },
  protocolTimeout: OPT.timeout,
});
const page = await browser.newPage();
page.setDefaultTimeout(OPT.timeout);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));

const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed), only: OPT.only });
await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load', timeout: OPT.timeout });
const ok = await page.evaluate(async () => {
  try { await globalThis.__HALO__.ready; return { ok: true, missing: globalThis.__HALO_MISSING__ || [] }; }
  catch (e) { return { ok: false, err: String(e && e.stack || e) }; }
});
if (!ok.ok) { console.error('BOOT FAILED\n' + ok.err + '\n' + logs.slice(-30).join('\n')); await browser.close(); cleanup(); process.exit(2); }

const res = await page.evaluate(async (o) => {
  const H = globalThis.__HALO__;
  H.setSize(innerWidth, innerHeight);
  for (const m of o.off) H.togglePass(m, false);
  for (const c of o.cfg) {
    const i = c.indexOf('=');
    let v = c.slice(i + 1);
    try { v = JSON.parse(v); } catch {}
    H.setConfig(c.slice(0, i), v);
  }
  H.setPose(o.pose);
  H.setTime(Number(o.time));
  H.advance(o.settle);
  const out = { shot: H.screenshot(), stats: H.stats() };
  if (o.probe) {
    const ctx = H.engine.ctx;
    const cl = ctx.get('clouds');
    const sky = ctx.get('sky');
    const r = ctx.renderer;
    const THREE = H.THREE;
    const info = { exposure: ctx.config.exposure };
    // wall-clock timing: N frames with clouds on vs off, each terminated by a
    // 1-pixel readback so the GPU is actually flushed.
    {
      const r = ctx.renderer;
      const gl = r.getContext();
      const px = new Uint8Array(4);
      const flush = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const run = (n) => { H.advance(n); flush(); };
      const timeIt = (n) => {
        run(8); const t0 = performance.now(); run(n); return (performance.now() - t0) / n;
      };
      const cl = ctx.get('clouds');
      const withC = Math.min(timeIt(40), timeIt(40));
      if (cl) cl.enabled = false;
      const without = Math.min(timeIt(40), timeIt(40));
      if (cl) cl.enabled = true;
      run(48);
      info.msWith = Math.round(withC * 1000) / 1000;
      info.msWithout = Math.round(without * 1000) / 1000;
      info.msClouds = Math.round((withC - without) * 1000) / 1000;
    }
    if (sky) {
      const z = sky.zenithRadiance(new THREE.Color());
      const hz = sky.horizonRadiance(new THREE.Color());
      info.skyZenith = [z.r, z.g, z.b];
      info.skyHorizon = [hz.r, hz.g, hz.b];
      info.solarIrradiance = sky.skyMaterialUniforms.uSolarIrradiance.value;
    }
    if (cl && cl.buffer) {
      // read a grid of the half-res cloud buffer
      const rt = cl._debugRT ? cl._debugRT() : null;
      if (rt) {
        const W = rt.width, Hh = rt.height;
        const buf = new Uint16Array(W * Hh * 4);
        r.readRenderTargetPixels(rt, 0, 0, W, Hh, buf);
        const f = (h) => {  // half float decode
          const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
          if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
          if (e === 31) return m ? NaN : s * Infinity;
          return s * Math.pow(2, e - 15) * (1 + m / 1024);
        };
        const rows = [];
        for (let yy = 0; yy < 9; yy++) {
          const row = [];
          for (let xx = 0; xx < 9; xx++) {
            const px = Math.floor((xx + 0.5) / 9 * W), py = Math.floor((yy + 0.5) / 9 * Hh);
            const i = ((Hh - 1 - py) * W + px) * 4;
            row.push([f(buf[i]), f(buf[i + 1]), f(buf[i + 2]), f(buf[i + 3])].map((v) => Math.round(v * 1000) / 1000));
          }
          rows.push(row);
        }
        info.cloudGrid = rows;
        info.cloudSize = [W, Hh];
      }
      info.coverage = cl.coverage;
      info.settings = cl.settings;
    }
    out.info = info;
  }
  return out;
}, OPT);

const abs = resolve(ROOT, OPT.out);
mkdirSync(dirname(abs), { recursive: true });
writeFileSync(abs, Buffer.from(res.shot.split(',')[1], 'base64'));
console.log(JSON.stringify({ file: OPT.out, drawCalls: res.stats.drawCalls, info: res.info || null }, null, 1));
const warn = logs.filter((l) => /error|warn|THREE|pageerror/i.test(l)).slice(0, 20);
if (warn.length) console.error(warn.join('\n'));
await browser.close(); cleanup();
