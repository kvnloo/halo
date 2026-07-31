#!/usr/bin/env node
/**
 * Depth-buffer probe — the experiment for KNOWN_ISSUES §18.
 *
 * `pipe.depthTex` is a DepthTexture and cannot be a colour attachment, so it cannot be
 * read with `readPixels` directly. This resolves it through a full-screen R32F copy
 * (the same trick `ssao.js` and `world/particles.js` already use mid-frame) and then
 * reads THAT back, at the moment the post chain would sample it — i.e. after
 * `H.advance()` has finished a frame.
 *
 * What it settles, with no dependence on tonemap / fog / grade:
 *
 *   1. `depth.geoFrac`   — fraction of the frame whose *shared* depth carries real world
 *                          geometry (d < 1). Before the fix this is the WEAPON only,
 *                          because `scene.js` step 7 clears the shared buffer.
 *   2. `gbufferGeoFrac`  — the same fraction taken from MRT1.a, the G-buffer's own opaque
 *                          mask. This is an INDEPENDENT witness: it comes from a different
 *                          attachment written by a different pass. After the fix
 *                          `depth.geoFrac` must agree with it; before, it does not.
 *   3. `viewmodel.frac`  — fraction covered by the viewmodel, from `pipe.viewDepthTex`
 *                          (only exists after the fix). The prediction is that this equals
 *                          the BEFORE value of `depth.geoFrac` exactly: the gun rasterises
 *                          identically, it just no longer does so into the world's buffer.
 *   4. `agree`           — `pipe.depthTex` vs `pipe.opaqueDepthTex` (ssao's mid-frame
 *                          snapshot), compared bit-for-bit. These two must not be able to
 *                          drift apart.
 *
 *   node tools/_depthprobe.mjs --pose ref_00000 --settle 48
 *   node tools/_depthprobe.mjs --pose ref_01500 --settle 48
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OPT = {
  pose: arg('pose', 'ref_00000'),
  poses: arg('poses', null),          // 'all' or 'a,b,c' — loop in ONE page
  w: +arg('w', 1920), h: +arg('h', 1080),
  settle: +arg('settle', 48),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
  skip: arg('skip', null),
  config: arg('config', null),
  perf: +arg('perf', 0),
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

const out = await page.evaluate(async (poseArg, settle, t, cfgStr, perfN) => {
  const H = globalThis.__HALO__;
  const THREE = H.THREE;
  const RP = await import('/src/render/RenderPipeline.js');

  const poseList = poseArg === 'all'
    ? Object.keys(H.poses).filter((k) => k.startsWith('ref_') || k.startsWith('shot_'))
    : String(poseArg).split(',');

  H.setSize(innerWidth, innerHeight);
  H.setTime(Number(t));
  // NOTE: `__HALO__.setConfig` is `(key, value)`, NOT `(object)`. `tools/_ssprobe.mjs:88`
  // and its `--config` flag pass an object, so that probe's `--config` has never applied
  // anything — it sets `ctx.config['[object Object]'] = undefined` and returns quietly.
  const applied = {};
  if (cfgStr) {
    for (const kv of cfgStr.split(',')) {
      const [k, v] = kv.split('=');
      applied[k.trim()] = H.setConfig(k.trim(), isNaN(Number(v)) ? v : Number(v));
    }
  }
  H.setPose(poseList[0]);
  H.advance(2);                       // ensure the pipeline has resized before sizing buffers

  const eng = H.engine;
  const pipeMod = eng.ctx.get('pipeline');
  const pipe = pipeMod.pipe || pipeMod;
  const r = eng.renderer;
  const gl = r.getContext();
  const W = pipe.w, Hh = pipe.h, N = W * Hh;

  /* ---- resolve a DepthTexture (or any texture) into RGBA32F, then read it back ---- */
  const resolveRT = RP.makeRT(W, Hh, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const resolveMat = RP.fsMaterial(
    'in vec2 vUv; uniform sampler2D tSrc; out vec4 oCol;\n'
    + 'void main(){ oCol = vec4(texture(tSrc, vUv).r, 0.0, 0.0, 1.0); }',
    { tSrc: { value: null } });
  resolveMat.blending = THREE.NoBlending;
  const resolveQuad = new RP.FullScreenQuad(resolveMat);

  const readRGBA32F = (tex) => {
    resolveMat.uniforms.tSrc.value = tex;
    r.setRenderTarget(resolveRT);
    resolveQuad.render(r);
    r.setRenderTarget(null);
    const buf = new Float32Array(N * 4);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      r.properties.get(resolveRT.texture).__webglTexture, 0);
    let ok = false;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.FLOAT, buf);
      ok = gl.getError() === gl.NO_ERROR;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    r.setRenderTarget(null); r.resetState();
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = buf[i * 4];
    return { d: out, ok };
  };

  const readHalfRGBA = (tex) => {
    const buf = new Uint16Array(N * 4);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      r.properties.get(tex).__webglTexture, 0);
    let ok = false;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.HALF_FLOAT, buf);
      ok = gl.getError() === gl.NO_ERROR;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    r.setRenderTarget(null); r.resetState();
    return { buf, ok };
  };

  const cam = eng.ctx.camera;
  const near = cam.near, far = cam.far;
  const lin = (dv) => (2 * near * far) / (far + near - (dv * 2 - 1) * (far - near));

  const stats = (d) => {
    let geo = 0, zero = 0;
    const dists = [];
    const hist = new Array(12).fill(0);
    for (let i = 0; i < N; i++) {
      const v = d[i];
      if (v <= 0) zero++;
      hist[Math.max(0, Math.min(11, Math.floor(v * 12)))]++;
      if (v < 1.0) { geo++; if ((i & 63) === 0) dists.push(lin(v)); }
    }
    dists.sort((a, b) => a - b);
    const p = (x) => (dists.length ? +dists[Math.floor(x * (dists.length - 1))].toFixed(3) : null);
    return {
      geoFrac: +(geo / N).toFixed(5), geoPx: geo, zeroFrac: +(zero / N).toFixed(5),
      distM: { p01: p(0.01), p10: p(0.10), p50: p(0.50), p90: p(0.90), p99: p(0.99) },
      hist12: hist.map((x) => +(x / N).toFixed(4)),
    };
  };

  const all = [];
  for (const pose of poseList) {
  H.setPose(pose);
  H.advance(settle);
  const res = {
    pose, W, H: Hh, near, far, reversed: !!r.reversedDepth, config: applied,
    missingPasses: globalThis.__HALO_MISSING_PASSES__ || [],
  };

  // ---- 1. the SHARED depth texture, as every post pass sees it -------------------
  const shared = readRGBA32F(pipe.depthTex);
  res.depth = Object.assign({ readOk: shared.ok }, stats(shared.d));

  // ---- 2. independent witness: the G-buffer's own opaque mask (MRT1.a) -----------
  {
    const g1 = readHalfRGBA(pipe.gbuffer.textures[1]);
    let m = 0;
    for (let i = 0; i < N; i++) if (g1.buf[i * 4 + 3] !== 0) m++;
    res.gbufferGeoFrac = +(m / N).toFixed(5);
    res.gbufferReadOk = g1.ok;
  }

  // ---- 3. the viewmodel's own depth attachment (post-fix only) -------------------
  if (pipe.viewDepthTex) {
    const vm = readRGBA32F(pipe.viewDepthTex);
    // How exposed is the weapon to depth-driven post now that the shared buffer reports
    // the WORLD behind it instead of the gun? `overSkyFrac` is the fraction of weapon
    // pixels whose world depth is the far plane — those are the ones a pass that keys on
    // `d >= 1.0` (clouds, fog sky classification) will now treat as open sky and paint
    // over. `behindMedianM` is the distance a fog march would integrate in front of the
    // gun if nobody masks it.
    let n = 0, overSky = 0;
    const behind = [];
    for (let i = 0; i < N; i++) {
      if (!(vm.d[i] < 1.0)) continue;
      n++;
      const w = shared.d[i];
      if (w >= 1.0) overSky++; else if ((n & 15) === 0) behind.push(lin(w));
    }
    behind.sort((a, b) => a - b);
    res.viewmodel = {
      present: true, readOk: vm.ok, frac: +(n / N).toFixed(5), px: n,
      overSkyFrac: n ? +(overSky / n).toFixed(5) : null,
      behindMedianM: behind.length ? +behind[behind.length >> 1].toFixed(3) : null,
    };
  } else res.viewmodel = { present: false };

  // ---- 4. does ssao's snapshot agree with the shared buffer, bit for bit? --------
  if (pipe.opaqueDepthTex) {
    const snap = readRGBA32F(pipe.opaqueDepthTex);
    let diff = 0, maxAbs = 0, sgeo = 0;
    for (let i = 0; i < N; i++) {
      const a = shared.d[i], b = snap.d[i];
      if (b < 1.0) sgeo++;
      if (a !== b) { diff++; const e = Math.abs(a - b); if (e > maxAbs) maxAbs = e; }
    }
    res.agree = {
      snapshotGeoFrac: +(sgeo / N).toFixed(5),
      differingPx: diff, differingFrac: +(diff / N).toFixed(6), maxAbsDiff: maxAbs,
      identical: diff === 0,
    };
  } else res.agree = { snapshotPresent: false };
  all.push(res);
  }
  const res = all[0];

  // ---- 5. cost, as an interleaved same-page A/B ----------------------------------
  // The whole fix is two extra `framebufferTexture2D` calls a frame, so the honest way to
  // price it is not two captures (GPU state, thermals and page age all differ) but one
  // page alternating `vmLegacyDepth` in blocks and reporting p50 of each arm.
  if (perfN > 0) {
    const run = (legacy, n) => {
      H.setConfig('vmLegacyDepth', legacy ? 1 : 0);
      H.advance(20);
      const ms = [];
      for (let i = 0; i < n; i++) { const t0 = performance.now(); H.advance(1); ms.push(performance.now() - t0); }
      ms.sort((a, b) => a - b);
      return { p50: +ms[ms.length >> 1].toFixed(3), p95: +ms[Math.floor(0.95 * ms.length)].toFixed(3), mean: +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(3) };
    };
    const arms = { newA: null, oldA: null, newB: null, oldB: null };
    arms.newA = run(false, perfN); arms.oldA = run(true, perfN);
    arms.oldB = run(true, perfN); arms.newB = run(false, perfN);
    H.setConfig('vmLegacyDepth', 0);
    res.perf = arms;
  }

  resolveQuad.dispose();
  resolveRT.dispose();
  return all.length > 1 ? { poses: all, perf: res.perf } : res;
}, OPT.poses || OPT.pose, OPT.settle, OPT.time, OPT.config, OPT.perf);

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.kill('SIGKILL');
process.exit(0);
