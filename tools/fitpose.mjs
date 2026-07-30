#!/usr/bin/env node
/**
 * Camera-pose fitting.
 *
 * The `structure` and `perceptual` axes only mean something when our camera is framing
 * the same thing the reference frame is framing. The poses in src/world/poses.js were
 * authored by hand from the world spec, so they are close but not exact — and a few
 * degrees of yaw is worth far more score than most rendering work.
 *
 * This drives the live game in one browser session and searches (x, y, z, pitch, yaw,
 * fov) for the pose that best matches a reference frame. Evaluation is done at low
 * resolution on a cheap structural objective (multi-scale gradient correlation), which
 * is ~30 ms per sample, so a few hundred samples is seconds rather than hours. The
 * winner is then verified at full resolution with the real metric suite.
 *
 *   node tools/fitpose.mjs --pose ref_00000                 # fit one pose
 *   node tools/fitpose.mjs --all --iters 260                # fit every ref pose
 *   node tools/fitpose.mjs --pose ref_01500 --apply         # rewrite poses.js
 *
 * Without --apply it only reports; poses.js is the substrate of the score history, so
 * changing it is an explicit act.
 */
import puppeteer from 'puppeteer';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const OPT = {
  pose: arg('pose', 'ref_00000'),
  all: has('all'),
  iters: +arg('iters', 220),
  settle: +arg('settle', 6),      // low, because the objective is structural not tonal
  evalW: +arg('evalw', 480),
  evalH: +arg('evalh', 270),
  apply: has('apply'),
  seed: +arg('seed', 12345),
  verbose: has('verbose'),
};

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitForServer(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('vite did not start');
}

/** Deterministic RNG so a fit is reproducible. */
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The objective, evaluated entirely in the page so we never pay a screenshot round-trip
 * during the search. Multi-scale normalised gradient correlation: robust to the large
 * brightness/colour differences that still exist between our render and the reference,
 * and sensitive to exactly what we care about — where edges and silhouettes sit.
 */
const PAGE_EVAL = /* js */`
(function(){
  window.__FIT__ = {
    refData: null,
    prepare(dataUrl, w, h){
      return new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, w, h);
          window.__FIT__.refData = window.__FIT__.pyramid(g.getImageData(0,0,w,h), w, h);
          res(true);
        };
        img.src = dataUrl;
      });
    },
    grayOf(imgData, w, h){
      const d = imgData.data, out = new Float32Array(w*h);
      for (let i=0,p=0;i<out.length;i++,p+=4) out[i] = (0.299*d[p] + 0.587*d[p+1] + 0.114*d[p+2])/255;
      return out;
    },
    /** downsample by 2 with a box filter */
    half(src, w, h){
      const nw = w>>1, nh = h>>1, out = new Float32Array(nw*nh);
      for (let y=0;y<nh;y++) for (let x=0;x<nw;x++){
        const i = (y*2)*w + x*2;
        out[y*nw+x] = (src[i] + src[i+1] + src[i+w] + src[i+w+1]) * 0.25;
      }
      return { data: out, w: nw, h: nh };
    },
    /** sobel magnitude, mean-subtracted and unit-normalised */
    edges(src, w, h){
      const out = new Float32Array(w*h);
      for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++){
        const i = y*w+x;
        const gx = -src[i-w-1] - 2*src[i-1] - src[i+w-1] + src[i-w+1] + 2*src[i+1] + src[i+w+1];
        const gy = -src[i-w-1] - 2*src[i-w] - src[i-w+1] + src[i+w-1] + 2*src[i+w] + src[i+w+1];
        out[i] = Math.sqrt(gx*gx + gy*gy);
      }
      let m = 0; for (let i=0;i<out.length;i++) m += out[i]; m /= out.length;
      let s = 0; for (let i=0;i<out.length;i++){ out[i] -= m; s += out[i]*out[i]; }
      s = Math.sqrt(s) || 1;
      for (let i=0;i<out.length;i++) out[i] /= s;
      return out;
    },
    pyramid(imgData, w, h){
      let g = { data: this.grayOf(imgData, w, h), w, h };
      const levels = [];
      for (let l=0;l<3;l++){
        levels.push({ e: this.edges(g.data, g.w, g.h), w: g.w, h: g.h });
        if (g.w < 64 || g.h < 64) break;
        g = this.half(g.data, g.w, g.h);
      }
      return levels;
    },
    /** score the current canvas against the prepared reference */
    score(w, h){
      const src = document.getElementById('view');
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, w, h);
      const cur = this.pyramid(g.getImageData(0,0,w,h), w, h);
      const ref = this.refData;
      let total = 0, wsum = 0;
      for (let l=0;l<Math.min(cur.length, ref.length);l++){
        const a = cur[l].e, b = ref[l].e;
        let dot = 0;
        for (let i=0;i<a.length;i++) dot += a[i]*b[i];
        const weight = 1 / (l + 1);
        total += dot * weight; wsum += weight;
      }
      return total / wsum;
    },
  };
  return true;
})()
`;

async function main() {
  const port = await freePort();
  const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const cleanup = () => { try { server.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(1); });
  await waitForServer(base + '/index.html');

  const browser = await puppeteer.launch({
    headless: 'new', executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
      '--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    protocolTimeout: 600000,
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 200)));
  await page.goto(`${base}/index.html?capture=1&w=1280&h=720`, { waitUntil: 'load', timeout: 180000 });
  const ok = await page.evaluate(async () => {
    try { await globalThis.__HALO__.ready; return true; } catch (e) { return String(e); }
  });
  if (ok !== true) { console.error('boot failed:', ok); await browser.close(); cleanup(); process.exit(2); }
  await page.evaluate(PAGE_EVAL);

  const poses = OPT.all
    ? await page.evaluate(() => Object.keys(globalThis.__HALO__.poses).filter((k) => k.startsWith('ref_')))
    : [OPT.pose];

  const results = {};
  for (const poseName of poses) {
    const idx = poseName.split('_')[1];
    const refPath = join(ROOT, `ref/keyframes/kf_${idx}.png`);
    if (!existsSync(refPath)) { console.error(`no reference for ${poseName}`); continue; }

    const refDataUrl = 'data:image/png;base64,' + readFileSync(refPath).toString('base64');
    await page.evaluate((du, w, h) => globalThis.__FIT__.prepare(du, w, h), refDataUrl, OPT.evalW, OPT.evalH);

    const start = await page.evaluate((p) => {
      const q = globalThis.__HALO__.poses[p];
      return { pos: q.pos.slice(), rot: q.rot.slice(), fov: q.fov ?? 78 };
    }, poseName);

    const evalPose = async (p) => page.evaluate((p, settle, w, h) => {
      const H = globalThis.__HALO__;
      H.setPose({ pos: p.pos, rot: p.rot, fov: p.fov });
      H.setTime(12.0);
      H.advance(settle);
      return globalThis.__FIT__.score(w, h);
    }, p, OPT.settle, OPT.evalW, OPT.evalH);

    // ---- pattern search with shrinking steps -----------------------------
    const rnd = mulberry(OPT.seed);
    let best = { ...start, pos: start.pos.slice(), rot: start.rot.slice() };
    let bestScore = await evalPose(best);
    const startScore = bestScore;

    // step sizes: metres for position, degrees for rotation, degrees for fov
    let step = { pos: [3.0, 0.6, 3.0], rot: [3.0, 6.0], fov: 3.0 };
    let sinceImprove = 0;

    for (let it = 0; it < OPT.iters; it++) {
      const cand = { pos: best.pos.slice(), rot: best.rot.slice(), fov: best.fov };
      // perturb a random subset — coordinate descent stalls on this objective because
      // yaw and x-position trade off against each other almost exactly
      const k = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < k; j++) {
        const which = Math.floor(rnd() * 6);
        const g = () => (rnd() * 2 - 1);
        if (which === 0) cand.pos[0] += g() * step.pos[0];
        else if (which === 1) cand.pos[1] += g() * step.pos[1];
        else if (which === 2) cand.pos[2] += g() * step.pos[2];
        else if (which === 3) cand.rot[0] += g() * step.rot[0];
        else if (which === 4) cand.rot[1] += g() * step.rot[1];
        else cand.fov += g() * step.fov;
      }
      cand.pos[1] = Math.max(0.4, Math.min(60, cand.pos[1]));
      cand.rot[0] = Math.max(-85, Math.min(85, cand.rot[0]));
      cand.fov = Math.max(50, Math.min(105, cand.fov));

      const s = await evalPose(cand);
      if (s > bestScore) { bestScore = s; best = cand; sinceImprove = 0; }
      else if (++sinceImprove > 18) {
        step = { pos: step.pos.map((v) => v * 0.62), rot: step.rot.map((v) => v * 0.62), fov: step.fov * 0.62 };
        sinceImprove = 0;
        if (step.rot[1] < 0.08) break;
      }
      if (OPT.verbose && it % 25 === 0) process.stderr.write(`  ${poseName} it${it} ${bestScore.toFixed(4)}\n`);
    }

    // ---- verify at full resolution with the real metrics -----------------
    await page.evaluate((p) => { globalThis.__HALO__.setSize(1920, 1080); globalThis.__HALO__.setPose(p); }, best);
    const shot = await page.evaluate((p, settle) => {
      const H = globalThis.__HALO__;
      H.setPose({ pos: p.pos, rot: p.rot, fov: p.fov });
      H.setTime(12.0); H.advance(settle);
      return H.screenshot();
    }, best, 48);
    mkdirSync(join(ROOT, 'shots/fitpose'), { recursive: true });
    const outPng = `shots/fitpose/${poseName}.png`;
    writeFileSync(join(ROOT, outPng), Buffer.from(shot.split(',')[1], 'base64'));
    await page.evaluate(() => globalThis.__HALO__.setSize(1280, 720));

    const m = spawnSync(join(ROOT, '.venv/bin/python'),
      ['tools/metrics.py', `ref/keyframes/kf_${idx}.png`, outPng, '--quiet', '--json', `scores/_fit_${poseName}.json`],
      { cwd: ROOT, encoding: 'utf8' });
    let metrics = null;
    try { metrics = JSON.parse(readFileSync(join(ROOT, `scores/_fit_${poseName}.json`), 'utf8')); } catch {}

    results[poseName] = {
      start, best,
      objective: { start: +startScore.toFixed(5), fitted: +bestScore.toFixed(5),
                   gain: +(bestScore - startScore).toFixed(5) },
      metrics: metrics ? { score: metrics.score, axes: metrics.axes } : null,
      preview: outPng,
    };
    process.stderr.write(`${poseName}: objective ${startScore.toFixed(4)} -> ${bestScore.toFixed(4)}`
      + (metrics ? `  |  score ${metrics.score} structure ${metrics.axes.structure} perceptual ${metrics.axes.perceptual}` : '') + '\n');
  }

  await browser.close();
  cleanup();

  /* ---- optionally rewrite poses.js -------------------------------------- */
  if (OPT.apply) {
    const p = join(ROOT, 'src/world/poses.js');
    let src = readFileSync(p, 'utf8');
    for (const [name, r] of Object.entries(results)) {
      const b = r.best;
      const line = `  ${name}: { pos: [${b.pos.map((v) => +v.toFixed(2)).join(', ')}], `
        + `rot: [${b.rot.map((v) => +v.toFixed(2)).join(', ')}, 0], fov: ${+b.fov.toFixed(1)} },`;
      const re = new RegExp(`^\\s*${name}:\\s*\\{[^}]*\\},?$`, 'm');
      if (re.test(src)) src = src.replace(re, line);
      else console.error(`could not locate ${name} in poses.js`);
    }
    writeFileSync(p, src);
    console.error(`\nposes.js updated. Every recorded score before this point was keyed on the OLD poses — re-baseline.`);
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
