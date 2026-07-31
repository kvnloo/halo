#!/usr/bin/env node
/**
 * depthfx probe — what `dof.js` and `motionBlur.js` actually see now that
 * KNOWN_ISSUES §18 is closed (reports/depth.md).
 *
 * Structure copied from `tools/_depthprobe.mjs` (a DepthTexture cannot be a colour
 * attachment, so it is resolved through an RGBA32F full-screen copy and read back after
 * `H.advance()` has completed a frame — i.e. at the moment the post chain samples it).
 *
 * What it reports, per pose:
 *
 *  DoF
 *   - the linear-z distribution of `pipe.depthTex` under the MAIN camera's near/far,
 *   - `cocAt(z)` evaluated exactly as `dof.js` does, over the whole frame: how much of
 *     the frame lands in the near ramp, the far ramp, and how much actually clears the
 *     composite's own blend floors (far: smoothstep(0.20,1.10); near: dofNearFadeLo),
 *   - the CoC the WEAPON pixels now receive from the world path. The gun is no longer in
 *     `pipe.depthTex`, so `cocAtUv` reads the terrain/sky BEHIND it — a leak that did not
 *     exist while §18 was open.
 *
 *  motionBlur
 *   - per-matId velocity magnitude in px/frame from MRT1.rg,
 *   - a CPU re-implementation of tileMax(K) -> neighbourMax(3x3) so the pass's own gate
 *     (`lenVN = |vN| * uRes * 0.5*shutter >= mbMinPx`) can be evaluated exactly, whole
 *     frame, over AI pixels (matId 7) and over weapon pixels,
 *   - so: is the blur near-zero at rest, and is it non-zero on the moving AI?
 *
 *   node tools/_dfxprobe.mjs --pose ref_00000 --settle 48
 *   node tools/_dfxprobe.mjs --poses all --settle 48
 *   node tools/_dfxprobe.mjs --pose ref_01500 --settle 48 --config mbShutter=1
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OPT = {
  pose: arg('pose', 'ref_00000'),
  poses: arg('poses', null),
  w: +arg('w', 1920), h: +arg('h', 1080),
  settle: +arg('settle', 48),
  time: arg('time', '12.0'),
  seed: +arg('seed', 1337),
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
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.setDefaultTimeout(600000);
page.on('console', (m) => { if (/error/i.test(m.text())) console.error('  [page]', m.text().slice(0, 300)); });

const q = new URLSearchParams({ capture: '1', w: String(OPT.w), h: String(OPT.h), seed: String(OPT.seed) });
await page.goto(`${base}/index.html?${q}`, { waitUntil: 'load' });
await page.evaluate(() => globalThis.__HALO__.ready);

const out = await page.evaluate(async (poseArg, settle, t, cfgStr) => {
  const H = globalThis.__HALO__;
  const THREE = H.THREE;
  const RP = await import('/src/render/RenderPipeline.js');

  const poseList = poseArg === 'all'
    ? Object.keys(H.poses).filter((k) => k.startsWith('ref_') || k.startsWith('shot_'))
    : String(poseArg).split(',');

  H.setSize(innerWidth, innerHeight);
  H.setTime(Number(t));
  const applied = {};
  if (cfgStr) {
    for (const kv of cfgStr.split(',')) {
      const [k, v] = kv.split('=');
      applied[k.trim()] = H.setConfig(k.trim(), isNaN(Number(v)) ? v : Number(v));
    }
  }
  H.setPose(poseList[0]);
  H.advance(2);

  const eng = H.engine;
  const pipeMod = eng.ctx.get('pipeline');
  const pipe = pipeMod.pipe || pipeMod;
  const r = eng.renderer;
  const gl = r.getContext();
  const W = pipe.w, Hh = pipe.h, N = W * Hh;

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

  const readDepth = (tex) => {
    resolveMat.uniforms.tSrc.value = tex;
    r.setRenderTarget(resolveRT);
    resolveQuad.render(r);
    r.setRenderTarget(null);
    const buf = new Float32Array(N * 4);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      r.properties.get(resolveRT.texture).__webglTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.FLOAT, buf);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    r.setRenderTarget(null); r.resetState();
    const o = new Float32Array(N);
    for (let i = 0; i < N; i++) o[i] = buf[i * 4];
    return o;
  };

  // MRT1 as half-float: rg = velocity (UV/frame), b = matId/255, a = coverage.
  const readG1 = () => {
    const buf = new Uint16Array(N * 4);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      r.properties.get(pipe.gbuffer.textures[1]).__webglTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.HALF_FLOAT, buf);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    r.setRenderTarget(null); r.resetState();
    return buf;
  };
  const h2f = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 5.9604644775390625e-8;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
  };

  const cam = eng.ctx.camera;
  const near = cam.near, far = cam.far;
  const lin = (dv) => (2 * near * far) / (far + near - (dv * 2 - 1) * (far - near));
  const ss = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

  const all = [];
  for (const pose of poseList) {
    H.setPose(pose);
    H.advance(settle);
    const c = eng.ctx.config;
    const res = { pose, W, H: Hh, near, far, config: applied };

    const wd = readDepth(pipe.depthTex);
    const vd = pipe.viewDepthTex ? readDepth(pipe.viewDepthTex) : null;
    const g1 = readG1();

    /* ---------------- DoF ---------------- */
    const nearEnd = c.dofNearEnd, nearStart = c.dofNearStart;
    const farStart = c.dofFarStart, farEnd = c.dofFarEnd;
    const strength = ({ off: 0, low: 1, medium: 1.8, high: 3 })[String(c.dofStrength)] ?? 1;
    const resScale = Hh / 1080;
    const nearMax = c.dofNearMaxCoC * strength * resScale;
    const farMax = c.dofFarMaxCoC * strength * resScale;
    const cocAt = (z) => farMax * ss(farStart, farEnd, z) - nearMax * (1 - ss(nearEnd, nearStart, z));

    const zs = [];
    let nNear = 0, nFar = 0, nFarVis = 0, nNearVis = 0, nSky = 0, maxFarCoC = 0;
    const nearFloor = c.dofNearFadeLo;
    for (let i = 0; i < N; i++) {
      const d = wd[i];
      if (!(d < 1.0)) { nSky++; continue; }
      const z = lin(d);
      if ((i & 31) === 0) zs.push(z);
      const k = cocAt(z);
      if (k < 0) { nNear++; if (-k > nearFloor) nNearVis++; }
      else if (k > 0) { nFar++; if (k > 0.20) nFarVis++; if (k > maxFarCoC) maxFarCoC = k; }
    }
    // `mbNearSuppressM` is a motionBlur constant, but it is a DEPTH constant: it was
    // written when the shared buffer held only the gun, where it caught nothing. Now it
    // catches world geometry, and every pixel it catches is bypassed by motion blur.
    let nSuppress = 0;
    for (let i = 0; i < N; i++) { const d = wd[i]; if (d < 1.0 && lin(d) < c.mbNearSuppressM) nSuppress++; }
    zs.sort((a, b) => a - b);
    const pc = (x) => (zs.length ? +zs[Math.floor(x * (zs.length - 1))].toFixed(3) : null);
    res.dof = {
      curve: { nearEnd, nearStart, farStart, farEnd, nearMax: +nearMax.toFixed(3), farMax: +farMax.toFixed(3) },
      worldZ: { p01: pc(0.01), p05: pc(0.05), p10: pc(0.10), p25: pc(0.25), p50: pc(0.50), p75: pc(0.75), p90: pc(0.90), p99: pc(0.99), max: pc(1) },
      skyFrac: +(nSky / N).toFixed(5),
      nearBandFrac: +(nNear / N).toFixed(5),      // z < dofNearStart  (any near CoC)
      nearVisFrac: +(nNearVis / N).toFixed(5),    // near CoC above the composite's floor
      farBandFrac: +(nFar / N).toFixed(5),        // z > dofFarStart   (any far CoC)
      farVisFrac: +(nFarVis / N).toFixed(5),      // far CoC > 0.20 px, i.e. farBlend > 0
      maxFarCoC: +maxFarCoC.toFixed(3),
      worldInsideNearSuppressFrac: +(nSuppress / N).toFixed(5),
    };

    /* --------------- is the decoded distance TRUE? raycast witness -------------
     * The near cluster in worldZ is surprising enough that it needs a witness that does
     * not go through the depth buffer at all. Raycast the same scene graph from the same
     * camera through a grid of pixels and compare the hit distance, projected onto the
     * view axis, against the decoded depth at that pixel. If the decode is wrong the two
     * disagree by a systematic factor; if the scene really is that close they agree. */
    {
      const rc = new THREE.Raycaster();
      rc.layers.set(0); rc.layers.enable(1);        // LAYER.DEFAULT + LAYER.OPAQUE only
      rc.far = 20000;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      const rows = [];
      for (let gy = 0; gy < 5; gy++) {
        const row = [];
        for (let gx = 0; gx < 5; gx++) {
          const fx = (gx + 0.5) / 5, fy = (gy + 0.5) / 5;
          const px = Math.floor(fx * W), py = Math.floor(fy * Hh);
          const d = wd[py * W + px];                       // readPixels is bottom-up
          const zdec = d < 1.0 ? lin(d) : null;
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, fy * 2 - 1), cam);
          const hits = rc.intersectObject(eng.scene, true)
            .filter((h) => h.object.visible && h.object.material
              && h.object.material.depthWrite !== false
              && !h.object.layers.isEnabled(5) && !h.object.layers.isEnabled(4));
          let zray = null, name = null;
          if (hits.length) {
            zray = hits[0].point.clone().sub(cam.position).dot(fwd);   // view-axis distance
            name = hits[0].object.name || hits[0].object.type;
          }
          row.push({ px, py, zdec: zdec == null ? null : +zdec.toFixed(3), zray: zray == null ? null : +zray.toFixed(3), hit: name });
        }
        rows.push(row);
      }
      res.raycast = rows;
    }

    /* --------------- is `drawnAfterPrepass` empty, or just small? --------------
     * Both files identify the weapon as "depth written, no G-buffer coverage". depth.md
     * shows the two MASK FRACTIONS now agree to five decimals, which is not the same as
     * the two SETS being equal. Count the symmetric difference directly. */
    {
      let depthNoCov = 0, covNoDepth = 0, both = 0;
      for (let i = 0; i < N; i++) {
        const cov = h2f(g1[i * 4 + 3]) > 0.5, dep = wd[i] < 0.999999;
        if (dep && !cov) depthNoCov++;
        else if (cov && !dep) covNoDepth++;
        else if (cov && dep) both++;
      }
      res.guard = { drawnAfterPrepassPx: depthNoCov, coverageWithoutDepthPx: covNoDepth, bothPx: both };
    }

    /* --------------- per-matId depth --------------- */
    {
      const byMatZ = new Map();
      for (let i = 0; i < N; i++) {
        const cov = h2f(g1[i * 4 + 3]);
        if (!(cov > 0.5)) continue;
        const d = wd[i]; if (!(d < 1.0)) continue;
        const m = Math.round(h2f(g1[i * 4 + 2]) * 255);
        let a = byMatZ.get(m); if (!a) { a = []; byMatZ.set(m, a); }
        if ((i & 15) === 0) a.push(lin(d));
      }
      res.matZ = [...byMatZ.entries()].map(([m, a]) => {
        a.sort((x, y) => x - y);
        const q = (t) => +a[Math.floor(t * (a.length - 1))].toFixed(3);
        return { matId: m, n: a.length, p05: q(0.05), p50: q(0.5), p95: q(0.95) };
      }).sort((x, y) => y.n - x.n);
    }

    /* --------------- weapon leak --------------- */
    if (vd) {
      let n = 0, overSky = 0, leakFar = 0, leakNear = 0, sumCoC = 0, maxLeak = 0;
      const behind = [];
      for (let i = 0; i < N; i++) {
        if (!(vd[i] < 1.0)) continue;
        n++;
        const d = wd[i];
        if (!(d < 1.0)) { overSky++; continue; }
        const z = lin(d);
        if ((n & 7) === 0) behind.push(z);
        const k = cocAt(z);
        sumCoC += k;
        if (k > 0.20) leakFar++;
        if (-k > nearFloor) leakNear++;
        if (Math.abs(k) > Math.abs(maxLeak)) maxLeak = k;
      }
      behind.sort((a, b) => a - b);
      res.weapon = {
        px: n, frac: +(n / N).toFixed(5),
        overSkyFrac: n ? +(overSky / n).toFixed(4) : null,
        behindZ_p50: behind.length ? +behind[behind.length >> 1].toFixed(2) : null,
        behindZ_p90: behind.length ? +behind[Math.floor(0.9 * (behind.length - 1))].toFixed(2) : null,
        // The CoC the gun pixels get from the WORLD behind them (the §18-closure leak).
        leakFarFrac: n ? +(leakFar / n).toFixed(4) : null,
        leakNearFrac: n ? +(leakNear / n).toFixed(4) : null,
        meanLeakCoC: n ? +(sumCoC / n).toFixed(4) : null,
        maxLeakCoC: +maxLeak.toFixed(3),
      };
    }

    /* ---------------- motionBlur ---------------- */
    // Per-pixel velocity in px/frame, exactly as velocityUV() would produce it for
    // covered pixels (static camera => the sky/uncovered path is identically zero).
    const vpx = new Float32Array(N * 2);
    const byMat = new Map();
    for (let i = 0; i < N; i++) {
      const cov = h2f(g1[i * 4 + 3]);
      let vx = 0, vy = 0;
      if (cov > 0.5) { vx = h2f(g1[i * 4]) * W; vy = h2f(g1[i * 4 + 1]) * Hh; }
      vpx[i * 2] = vx; vpx[i * 2 + 1] = vy;
      const mat = cov > 0.5 ? Math.round(h2f(g1[i * 4 + 2]) * 255) : -1;
      let e = byMat.get(mat);
      if (!e) { e = { matId: mat, px: 0, sum: 0, max: 0, over: 0 }; byMat.set(mat, e); }
      const l = Math.hypot(vx, vy);
      e.px++; e.sum += l; if (l > e.max) e.max = l;
    }

    const K = Math.max(4, Math.min(64, (c.mbTileSize | 0) || 20));
    const shutter = Math.max(0, Math.min(1, c.mbShutter));
    const halfShut = shutter * 0.5;
    const minPx = c.mbMinPx;
    const TW = Math.ceil(W / K), TH = Math.ceil(Hh / K);
    // tileMax: keep the VECTOR of largest magnitude (separable, as the shader does).
    const tx = new Float32Array(TW * Hh * 2);
    for (let y = 0; y < Hh; y++) for (let tX = 0; tX < TW; tX++) {
      let bx = 0, by = 0, bl = -1;
      for (let i = 0; i < K; i++) {
        const x = tX * K + i; if (x >= W) break;
        const o = (y * W + x) * 2, vx = vpx[o], vy = vpx[o + 1], l = vx * vx + vy * vy;
        if (l > bl) { bl = l; bx = vx; by = vy; }
      }
      const o = (y * TW + tX) * 2; tx[o] = bx; tx[o + 1] = by;
    }
    const ty = new Float32Array(TW * TH * 2);
    for (let tY = 0; tY < TH; tY++) for (let tX = 0; tX < TW; tX++) {
      let bx = 0, by = 0, bl = -1;
      for (let i = 0; i < K; i++) {
        const y = tY * K + i; if (y >= Hh) break;
        const o = (y * TW + tX) * 2, vx = tx[o], vy = tx[o + 1], l = vx * vx + vy * vy;
        if (l > bl) { bl = l; bx = vx; by = vy; }
      }
      const o = (tY * TW + tX) * 2; ty[o] = bx; ty[o + 1] = by;
    }
    const nb = new Float32Array(TW * TH * 2);
    for (let tY = 0; tY < TH; tY++) for (let tX = 0; tX < TW; tX++) {
      let bx = 0, by = 0, bl = -1;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const sx = Math.min(TW - 1, Math.max(0, tX + i)), sy = Math.min(TH - 1, Math.max(0, tY + j));
        const o = (sy * TW + sx) * 2, vx = ty[o], vy = ty[o + 1], l = vx * vx + vy * vy;
        if (l > bl) { bl = l; bx = vx; by = vy; }
      }
      const o = (tY * TW + tX) * 2; nb[o] = bx; nb[o + 1] = by;
    }

    // The pass's own gate, per pixel: lenVN = |vN| * halfShutter >= mbMinPx.
    let active = 0, aiPx = 0, aiActive = 0, aiSum = 0, aiMax = 0, wpnActive = 0, wpnPx = 0;
    let tilesActive = 0, tileMaxLen = 0, nbGain = 0;
    for (let tY = 0; tY < TH; tY++) for (let tX = 0; tX < TW; tX++) {
      const o = (tY * TW + tX) * 2;
      const ln = Math.hypot(nb[o], nb[o + 1]) * halfShut;
      const lt = Math.hypot(ty[o], ty[o + 1]) * halfShut;
      if (ln >= minPx) tilesActive++;
      if (ln > tileMaxLen) tileMaxLen = ln;
      if (ln > lt + 1e-9) nbGain++;                 // neighbourMax > this tile's own max
    }
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = ((y / K | 0) * TW + (x / K | 0)) * 2;
      const ln = Math.hypot(nb[o], nb[o + 1]) * halfShut;
      const on = ln >= minPx;
      if (on) active++;
      const cov = h2f(g1[i * 4 + 3]);
      const mat = cov > 0.5 ? Math.round(h2f(g1[i * 4 + 2]) * 255) : -1;
      if (mat === 7) {
        aiPx++; const l = Math.hypot(vpx[i * 2], vpx[i * 2 + 1]) * halfShut;
        aiSum += l; if (l > aiMax) aiMax = l;
        if (on) aiActive++;
      }
      if (vd && vd[i] < 1.0) { wpnPx++; if (on) wpnActive++; }
    }

    const mats = [...byMat.values()].sort((a, b) => b.px - a.px).map((e) => ({
      matId: e.matId, px: e.px, meanPx: +(e.sum / e.px).toFixed(4), maxPx: +e.max.toFixed(3),
    }));
    res.mb = {
      tile: K, shutter, halfShutter: halfShut, minPx,
      tiles: TW * TH, tilesActive, tilesActiveFrac: +(tilesActive / (TW * TH)).toFixed(5),
      maxNeighbourHalfExtentPx: +tileMaxLen.toFixed(4),
      tilesWhereNeighbourExceedsOwn: nbGain,
      activePxFrac: +(active / N).toFixed(5),
      ai: { px: aiPx, activeFrac: aiPx ? +(aiActive / aiPx).toFixed(4) : null, meanHalfExtentPx: aiPx ? +(aiSum / aiPx).toFixed(4) : null, maxHalfExtentPx: +aiMax.toFixed(3) },
      weapon: vd ? { px: wpnPx, activeFrac: wpnPx ? +(wpnActive / wpnPx).toFixed(4) : null } : null,
      byMat: mats,
    };

    all.push(res);
  }

  resolveQuad.dispose();
  resolveRT.dispose();
  return all.length > 1 ? { poses: all } : all[0];
}, OPT.poses || OPT.pose, OPT.settle, OPT.time, OPT.config);

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.kill('SIGKILL');
process.exit(0);
