#!/usr/bin/env node
/**
 * Screen-space subsystem probe.
 *
 * Reads `ssao.aoTexture`, `ssr.ssrTexture` and the opaque-depth snapshot straight off the
 * GPU, so every number below is independent of tonemap / grade / fog — all of which other
 * agents are editing while this runs, and all of which sit between the AO buffer and any
 * pixel a `metrics.py` run could see.
 *
 * It answers four questions that a PNG cannot:
 *   1. Does the opaque depth snapshot actually contain the world?  (`depth.geoFrac`)
 *   2. Is the AO buffer non-trivial?                               (`ao.std`, `ao.p01`)
 *   3. Where is the AO — near field or far field?                  (`ao.byDepth`)
 *   4. Is SSR finding anything?                                    (`ssr.confMean`, `hitFrac`)
 *
 *   node tools/_ssprobe.mjs --pose ref_00000 --settle 48
 *   node tools/_ssprobe.mjs --pose ref_01500 --config aoRadius=0.6
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OPT = {
  pose: arg('pose', 'ref_00000'),
  w: +arg('w', 1920), h: +arg('h', 1080),
  settle: +arg('settle', 48),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  skip: arg('skip', null),
  config: arg('config', null),
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
page.on('console', (m) => { if (/error/i.test(m.text())) console.error('  [page]', m.text().slice(0, 300)); });

const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed) });
if (OPT.skip) q.set('skip', OPT.skip);
await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load' });
await page.evaluate(() => globalThis.__HALO__.ready);

const out = await page.evaluate(async (pose, settle, t, cfgStr) => {
  const H = globalThis.__HALO__;
  H.setSize(innerWidth, innerHeight);
  H.setPose(pose);
  H.setTime(Number(t));
  if (cfgStr) {
    const o = {};
    for (const kv of cfgStr.split(',')) {
      const [k, v] = kv.split('=');
      o[k.trim()] = isNaN(Number(v)) ? v : Number(v);
    }
    H.setConfig(o);
  }
  H.advance(settle);

  const eng = H.engine;
  const pipeMod = eng.ctx.get('pipeline');
  const pipe = pipeMod.pipe || pipeMod;
  const r = eng.renderer;
  const gl = r.getContext();

  const h2f = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 5.960464477539063e-8;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
  };

  const read = (tex, w, h, type) => {
    const buf = type === 'half' ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
    const fb = gl.createFramebuffer();
    const wt = r.properties.get(tex).__webglTexture;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, wt, 0);
    let ok = false;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, w, h, gl.RGBA, type === 'half' ? gl.HALF_FLOAT : gl.FLOAT, buf);
      ok = gl.getError() === gl.NO_ERROR;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    r.setRenderTarget(null); r.resetState();
    return { buf, ok, get: type === 'half' ? h2f : ((x) => x) };
  };

  const res = { missingPasses: globalThis.__HALO_MISSING_PASSES__ || [], W: pipe.w, H: pipe.h };
  {
    const csm = eng.ctx.get('lighting')?.csm;
    res.csm = {
      present: !!csm,
      lights: csm?.lights?.length ?? 0,
      mapsReady: (csm?.lights || []).filter((l) => l?.shadow?.map?.depthTexture).length,
    };
    const ap = pipeMod.pass ? pipeMod.pass('ssao') : null;
    if (ap && ap._applyMat) res.csm.uNumCasc = ap._applyMat.uniforms.uNumCasc.value;
  }

  // ---- 1. opaque depth snapshot ------------------------------------------------
  if (pipe.opaqueDepthTex) {
    const d = read(pipe.opaqueDepthTex, pipe.w, pipe.h, 'float');
    let geo = 0, n = pipe.w * pipe.h, sum = 0, zero = 0;
    const hist = new Array(12).fill(0);
    for (let i = 0; i < n; i++) {
      const v = d.buf[i * 4];
      if (v <= 0) zero++;
      if (v < 1.0) { geo++; sum += v; }
      hist[Math.min(11, Math.floor(v * 12))]++;
    }
    const cam0 = eng.ctx.camera;
    res.depth = {
      readOk: d.ok, geoFrac: +(geo / n).toFixed(5), meanNonSky: geo ? +(sum / geo).toFixed(6) : null,
      zeroFrac: +(zero / n).toFixed(5),
      near: cam0.near, far: cam0.far, reversed: !!r.reversedDepth,
      hist12: hist.map((h2) => +(h2 / n).toFixed(4)),
    };
  } else res.depth = { present: false };

  // ---- 1b. DOES THE DEPTH BUFFER CONTAIN ANY RELIEF AT AO SCALE? -----------------
  //
  // The question this settles: an AO pass can only darken relief that exists in the depth
  // buffer. If the beach's pebbles and ripples are normal-mapped rather than displaced,
  // GTAO returning ~1.0 on the sand is the CORRECT answer and no amount of retuning will
  // produce a contact shadow. So measure the signal GTAO actually integrates: the
  // out-of-plane deviation |dot(P_neighbour − P_centre, N_centre)| in metres, at several
  // pixel separations, over foreground pixels only.
  if (pipe.opaqueDepthTex) {
    const d = read(pipe.opaqueDepthTex, pipe.w, pipe.h, 'float');
    const cam = eng.ctx.camera;
    const pe = pipe.unjitteredProj.elements;
    const tanX = 1 / Math.abs(pe[0]), tanY = 1 / Math.abs(pe[5]);
    const near = cam.near, far = cam.far;
    const W = pipe.w, Hh = pipe.h;
    const lin = (dv) => (2 * near * far) / (far + near - (dv * 2 - 1) * (far - near));
    const vp = (x, y, lz) => {
      const nx = ((x + 0.5) / W) * 2 - 1, ny = ((y + 0.5) / Hh) * 2 - 1;
      return [nx * tanX * lz, ny * tanY * lz, -lz];
    };
    const at = (x, y) => d.buf[(y * W + x) * 4];
    const offs = [2, 4, 8, 16, 32];
    // Bucket by view distance rather than by screen row: readPixels returns row 0 at the
    // BOTTOM of the image, so "the lower half of the frame" is not a safe way to say
    // "the near ground", and getting that backwards measures the cliffs instead.
    const bandsDef = [[0, 4], [4, 10], [10, 25], [25, 80]];
    const acc = bandsDef.map(() => offs.map(() => []));
    const counts = bandsDef.map(() => 0);
    let tried = 0;
    for (let y = 4; y < Hh - 40; y += 3) {
      for (let x = 40; x < W - 40; x += 7) {
        const dc = at(x, y);
        if (dc >= 1.0) continue;
        const lz = lin(dc);
        let bi = -1;
        for (let k = 0; k < bandsDef.length; k++) if (lz >= bandsDef[k][0] && lz < bandsDef[k][1]) bi = k;
        if (bi < 0) continue;
        const dr = at(x + 2, y), du = at(x, y + 2);
        if (dr >= 1.0 || du >= 1.0) continue;
        const P = vp(x, y, lz), R = vp(x + 2, y, lin(dr)), U = vp(x, y + 2, lin(du));
        const a = [R[0] - P[0], R[1] - P[1], R[2] - P[2]];
        const b = [U[0] - P[0], U[1] - P[1], U[2] - P[2]];
        let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const nl = Math.hypot(n[0], n[1], n[2]);
        if (nl < 1e-9) continue;
        n = [n[0] / nl, n[1] / nl, n[2] / nl];
        tried++; counts[bi]++;
        for (let k = 0; k < offs.length; k++) {
          const o = offs[k];
          const ds = at(Math.min(W - 1, x + o), y);
          if (ds >= 1.0) continue;
          const S = vp(Math.min(W - 1, x + o), y, lin(ds));
          acc[bi][k].push(Math.abs((S[0] - P[0]) * n[0] + (S[1] - P[1]) * n[1] + (S[2] - P[2]) * n[2]));
        }
      }
    }
    const q = (arr, p2) => { arr.sort((a2, b2) => a2 - b2); return arr.length ? +arr[Math.floor(p2 * (arr.length - 1))].toFixed(5) : null; };
    res.relief = {
      samples: tried,
      note: 'out-of-plane deviation in METRES at N px separation, bucketed by view distance',
      bands: bandsDef.map((bd, bi) => ({
        band: bd[0] + '-' + bd[1] + 'm', px: counts[bi],
        byOffsetPx: offs.map((o, k) => ({ px: o, p50: q(acc[bi][k].slice(), 0.5), p90: q(acc[bi][k].slice(), 0.9), p99: q(acc[bi][k].slice(), 0.99) })),
      })),
    };
  }

  // ---- 1c. G-buffer material ids + roughness actually written ---------------------
  // SSR's per-material gain and its wet-roughness clamp are both keyed on MRT1.b. If the
  // terrain never writes MAT_ID.TERRAIN_WET (2) there is no wet sand for this pass to
  // reflect off no matter how the trace is tuned, and the shoreline's reflection has to
  // come from somewhere else.
  {
    const g0 = read(pipe.gbuffer.textures[0], pipe.w, pipe.h, 'half');
    const g1 = read(pipe.gbuffer.textures[1], pipe.w, pipe.h, 'half');
    const byMat = new Map();
    const n = pipe.w * pipe.h;
    for (let i = 0; i < n; i++) {
      if (g1.get(g1.buf[i * 4 + 3]) < 0.5) continue;
      const mid = Math.round(g1.get(g1.buf[i * 4 + 2]) * 255);
      const rg = g0.get(g0.buf[i * 4 + 3]);
      let e = byMat.get(mid);
      if (!e) byMat.set(mid, e = { px: 0, sumR: 0, minR: 9, maxR: -9 });
      e.px++; e.sumR += rg; if (rg < e.minR) e.minR = rg; if (rg > e.maxR) e.maxR = rg;
    }
    res.gbuffer = [...byMat.entries()].sort((a, b) => b[1].px - a[1].px).map(([mid, e]) => ({
      matId: mid, frac: +(e.px / n).toFixed(4),
      roughMean: +(e.sumR / e.px).toFixed(3), roughMin: +e.minR.toFixed(3), roughMax: +e.maxR.toFixed(3),
    }));
  }

  // ---- 2. AO ---------------------------------------------------------------------
  const ssao = pipeMod.pass ? pipeMod.pass('ssao') : null;
  if (ssao && ssao.aoTexture && ssao.aoTexture.image && ssao.aoTexture.image.width > 4) {
    const w = Math.ceil(pipe.w / 2), h = Math.ceil(pipe.h / 2);
    const a = read(ssao.aoTexture, w, h, 'half');
    const SKY = 5.0e4;
    let n = 0, sum = 0, sum2 = 0, min = 9, dark = 0, deep = 0;
    const vals = [];
    const bands = [[0, 5], [5, 15], [15, 40], [40, 1e9]].map(() => ({ n: 0, sum: 0, min: 9 }));
    for (let i = 0; i < w * h; i++) {
      const lz = a.get(a.buf[i * 4 + 3]);
      if (!(lz < SKY)) continue;
      const v = a.get(a.buf[i * 4]);
      n++; sum += v; sum2 += v * v; if (v < min) min = v;
      if (v < 0.90) dark++;
      if (v < 0.70) deep++;
      if ((i & 7) === 0) vals.push(v);
      const bi = lz < 5 ? 0 : lz < 15 ? 1 : lz < 40 ? 2 : 3;
      bands[bi].n++; bands[bi].sum += v; if (v < bands[bi].min) bands[bi].min = v;
    }
    vals.sort((x, y) => x - y);
    const pct = (p) => vals.length ? +vals[Math.floor(p * (vals.length - 1))].toFixed(4) : null;
    res.ao = {
      px: n, mean: +(sum / n).toFixed(4), std: +Math.sqrt(sum2 / n - (sum / n) ** 2).toFixed(4),
      min: +min.toFixed(4), p01: pct(0.01), p05: pct(0.05), p25: pct(0.25), p50: pct(0.50),
      fracBelow090: +(dark / n).toFixed(5), fracBelow070: +(deep / n).toFixed(5),
      byDepth: bands.map((b, i) => ({
        band: ['0-5m', '5-15m', '15-40m', '40m+'][i],
        px: b.n, mean: b.n ? +(b.sum / b.n).toFixed(4) : null, min: b.n ? +b.min.toFixed(4) : null,
      })),
    };
  } else res.ao = { present: false };

  // ---- 3. SSR --------------------------------------------------------------------
  const ssr = pipeMod.pass ? pipeMod.pass('ssr') : null;
  if (ssr && ssr.ssrTexture && ssr.ssrTexture.image && ssr.ssrTexture.image.width > 4) {
    const w = Math.ceil(pipe.w / 2), h = Math.ceil(pipe.h / 2);
    const s = read(ssr.ssrTexture, w, h, 'half');
    let n = 0, hit = 0, sumC = 0, sumL = 0, strong = 0;
    for (let i = 0; i < w * h; i++) {
      const c = s.get(s.buf[i * 4 + 3]);
      n++;
      if (c > 0.02) { hit++; sumC += c; sumL += s.get(s.buf[i * 4]) * 0.2126 + s.get(s.buf[i * 4 + 1]) * 0.7152 + s.get(s.buf[i * 4 + 2]) * 0.0722; }
      if (c > 0.5) strong++;
    }
    res.ssr = {
      px: n, hitFrac: +(hit / n).toFixed(5), strongFrac: +(strong / n).toFixed(5),
      confMeanOverHits: hit ? +(sumC / hit).toFixed(4) : null,
      lumMeanOverHits: hit ? +(sumL / hit).toFixed(4) : null,
    };
  } else res.ssr = { present: false };

  return res;
}, OPT.pose, OPT.settle, OPT.time, OPT.config);

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.kill('SIGKILL');
process.exit(0);
