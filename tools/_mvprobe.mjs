#!/usr/bin/env node
/**
 * Motion-vector invariant probe.
 *
 * The one experiment that settles KNOWN_ISSUES §1 on its own, with no dependence on
 * tonemap/fog/grade (which other agents are editing): read the G-buffer velocity
 * texture back off the GPU with a STATIC camera and check the invariant
 *
 *     static camera + static geometry  =>  motion vector is bit-exact ZERO.
 *
 * Prediction with the bug present (uCurrViewProj jittered, uPrevViewProj not):
 *     MRT1.rg == -0.5 * pipe.jitter   for every opaque pixel.
 * Prediction after the fix:
 *     MRT1.rg == 0.
 *
 *   node tools/_mvprobe.mjs --pose ref_01500 --settle 48
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OPT = {
  pose: arg('pose', 'ref_01500'),
  w: +arg('w', 1920), h: +arg('h', 1080),
  settle: +arg('settle', 48),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  skip: arg('skip', null),
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
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
page.on('console', (m) => { if (/error|Error/.test(m.text())) console.error('  [page]', m.text().slice(0, 200)); });

const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed) });
if (OPT.skip) q.set('skip', OPT.skip);
await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load' });
await page.evaluate(() => globalThis.__HALO__.ready);

const out = await page.evaluate(async (pose, settle, t) => {
  const H = globalThis.__HALO__;
  const THREE = H.THREE;
  H.setSize(innerWidth, innerHeight);
  H.setPose(pose);
  H.setTime(Number(t));
  H.advance(settle);

  const eng = H.engine;
  const pipeMod = eng.ctx.get('pipeline');
  const pipe = pipeMod.pipe || pipeMod;
  const r = eng.renderer;
  const gl = r.getContext();

  const W = pipe.w, Hh = pipe.h;
  // Read MRT1 (motion.xy, matId, mask) as half-float.
  const buf = new Uint16Array(W * Hh * 4);
  const fb = gl.createFramebuffer();
  const props = r.properties.get(pipe.gbuffer.textures[1]);
  const tex = props.__webglTexture;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  let readOk = false;
  if (status === gl.FRAMEBUFFER_COMPLETE) {
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.HALF_FLOAT, buf);
    readOk = gl.getError() === gl.NO_ERROR;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  r.setRenderTarget(null);
  r.resetState();

  const h2f = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 5.960464477539063e-8;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
  };

  let n = 0, maxX = 0, maxY = 0, sumX = 0, sumY = 0, exactZero = 0;
  const hist = new Map();
  const byMat = new Map();      // matId -> { n, zero, sumY, maxAbs }
  for (let i = 0; i < W * Hh; i++) {
    if (buf[i * 4 + 3] === 0) continue;          // mask: only opaque G-buffer fragments
    const x = h2f(buf[i * 4]), y = h2f(buf[i * 4 + 1]);
    const mid = Math.round(h2f(buf[i * 4 + 2]) * 255);
    n++;
    const z = (x === 0 && y === 0);
    if (z) exactZero++;
    maxX = Math.max(maxX, Math.abs(x)); maxY = Math.max(maxY, Math.abs(y));
    sumX += x; sumY += y;
    let e = byMat.get(mid);
    if (!e) byMat.set(mid, e = { n: 0, zero: 0, sumX: 0, sumY: 0, maxAbs: 0, gate: 0, sumPx: 0 });
    e.n++; if (z) e.zero++; e.sumX += x; e.sumY += y;
    e.maxAbs = Math.max(e.maxAbs, Math.abs(x), Math.abs(y));
    // taa.js trusts gb1.rg only where it disagrees with the depth-derived mv by >1.5 px.
    // Static camera => depth-derived mv is exactly 0, so |mv| in px IS the disagreement.
    const px = Math.hypot(x * W, y * Hh);
    e.sumPx += px;
    if (px > 1.5) e.gate++;
    if (n < 400000) {
      const k = buf[i * 4] + ':' + buf[i * 4 + 1];
      hist.set(k, (hist.get(k) || 0) + 1);
    }
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, c]) => {
      const [a, b] = k.split(':').map(Number);
      return { x: h2f(a), y: h2f(b), count: c };
    });
  const mats = [...byMat.entries()].sort((a, b) => b[1].n - a[1].n).map(([mid, e]) => ({
    matId: mid, px: e.n, zeroFrac: +(e.zero / e.n).toFixed(4),
    meanX: e.sumX / e.n, meanY: e.sumY / e.n, maxAbs: e.maxAbs,
    meanPx: +(e.sumPx / e.n).toFixed(4),
    gateFrac: +(e.gate / e.n).toFixed(6),   // fraction taa.js would actually consume
  }));

  return {
    missingPasses: globalThis.__HALO_MISSING_PASSES__ || [],
    taaPass: !!(pipeMod.pass && pipeMod.pass('taa') && pipeMod.pass('taa').enabled),
    readOk, status, W, H: Hh,
    frameIndex: pipe.frameIndex,
    jitter: [pipe.jitter.x, pipe.jitter.y],
    predictedBuggy: [-0.5 * pipe.jitter.x, -0.5 * pipe.jitter.y],
    opaquePixels: n,
    exactZeroFrac: n ? exactZero / n : 0,
    maxAbs: [maxX, maxY],
    mean: n ? [sumX / n, sumY / n] : [0, 0],
    maxAbsPixels: [maxX * 0.5 * 2 * W / 2, maxY * 0.5 * 2 * Hh / 2], // mv is (dNDC)*0.5 => px = mv*W
    topValues: top,
    byMat: mats,
  };
}, OPT.pose, OPT.settle, OPT.time);

console.log(JSON.stringify(out, null, 2));
await browser.close();
cleanup();
process.exit(0);
