#!/usr/bin/env node
/**
 * ABLATE — switch one thing off at a time and measure what actually changed.
 *
 * Why this exists
 * ---------------
 * The same two failures keep happening, wave after wave, and both are answered by the
 * same one-line experiment that nobody has a tool for.
 *
 * 1. **Passes that render nothing get tuned anyway.** KNOWN_ISSUES §28: `ssao` and `ssr`
 *    both early-out on `d >= 1.0` ("sky, nothing to do"), and under §18 that was true of
 *    *every world pixel*. Both passes produced zero output through Waves E, F and G, and
 *    `aoStrength`, `aoRadius`, `aoPower` and `ssrStrength` were all tuned against them.
 *    §21 is the same shape: `dof` was a shipped no-op for two waves. In both cases the
 *    build was healthy — nothing failed to load, so the capture integrity gate would not
 *    have fired. The only detectable signature is that switching the pass off produces a
 *    **byte-identical frame**. That is what this tool reports.
 *
 * 2. **The `--skip rocks` / `--skip props` A/B has still not been run**, called out in
 *    §23 (Wave F), §25 (Wave G) and §29b (Wave H) — "the single highest-value measurement
 *    nobody has taken", four waves running. Reason given each time: it is a multi-step
 *    manual procedure and `src/` was never quiescent long enough to trust it.
 *
 * Every ablation so far was hand-rolled: `_blackab.mjs`, `_fogab.mjs`, `_ssaocost.mjs`,
 * `_chab.sh`, `_wpnab.sh` — five one-off harnesses, each hard-coding its pose and target
 * list. This is that harness with the constants taken out.
 *
 * What it reports, and why those columns
 * --------------------------------------
 *   meanAbs / changed% / max   image delta vs baseline. `max == 0` means INERT.
 *   tris / draws               deterministic counters. §29 established that every
 *                              frame-time number in this project was a CPU stopwatch on a
 *                              box at load average 24; §29b: "triangle and draw counts
 *                              remain trustworthy — use them." So cost is reported in
 *                              geometry, never in milliseconds.
 *   exact-black                KNOWN_ISSUES §24 bisection, for free.
 *
 * Everything is captured in ONE page load with `__HALO__.togglePass()`, so it needs no
 * source edit, cannot be invalidated by another agent writing `src/` mid-run (§19: config
 * and toggle overrides work independently of the source tree), and costs one vite + one
 * Chrome for the whole sweep rather than one per variant.
 *
 * Guard: refuses to start if `src/` was written in the last 10 minutes (§16 — concurrent
 * writes produced findings that "look real and are not", twice inside one session, and
 * are the stated reason the §23 A/B never ran). Override with --allow-churn.
 *
 * Usage
 * -----
 *   node tools/ablate.mjs --pose ref_00000 --targets ssao,ssr,dof,taa,bloom
 *   node tools/ablate.mjs --pose shot_stack_gauntlet --targets rocks,props,vegetation
 *   node tools/ablate.mjs --pose shot_sky_ring --targets taa,grain --settle 48
 *
 * `--targets` accepts anything `__HALO__.togglePass()` accepts: a pipeline pass name or a
 * world module name. Exits non-zero if any target is INERT (byte-identical when removed),
 * or if a target cannot be toggled at all.
 *
 * This tool only reads `src/`. It writes PNGs under shots/ablate/<pose>/ and nothing else.
 */
import puppeteer from 'puppeteer';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const POSE = arg('pose', 'ref_00000');
const SETTLE = +arg('settle', 48);
const TIME = parseFloat(arg('time', '12.0'));
const W = +arg('w', 1920), H = +arg('h', 1080);
const OUTDIR = arg('outdir', join('shots/ablate', POSE));
const TARGETS = String(arg('targets', '')).split(',').map((s) => s.trim()).filter(Boolean);

if (!TARGETS.length) {
  console.error('usage: node tools/ablate.mjs --pose <pose> --targets a,b,c [--settle 48]');
  process.exit(2);
}

/* ---- §16 quiescence guard ------------------------------------------------------- */
if (!has('allow-churn')) {
  let recent = [];
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'src'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    recent = out.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
      .filter((f) => { try { return Date.now() - statSync(resolve(ROOT, f)).mtimeMs < 10 * 60 * 1000; } catch { return false; } });
  } catch { /* no git, no guard */ }
  if (recent.length) {
    console.error('!!! src/ is not quiescent — this measurement would not be trustworthy !!!\n');
    for (const f of recent) console.error('    written in the last 10 min: ' + f);
    console.error('\n    KNOWN_ISSUES §16: captures taken while agents write src/ produce findings');
    console.error('    that look real and are not. Wait, or re-run with --allow-churn.\n');
    process.exit(3);
  }
}

/* ---- one vite + one Chrome for the whole sweep ----------------------------------- */
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const port = await freePort();
const server = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(port),
  '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development', HALO_NO_HMR: '1' } });
const cleanup = () => { try { server.kill('SIGKILL'); } catch { } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 400; i++) {
  try { const r = await fetch(base + '/index.html'); if (r.ok || r.status === 404) break; } catch { }
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
await page.goto(`${base}/index.html?capture=1&w=${W}&h=${H}&seed=1337`, { waitUntil: 'load' });
const boot = await page.evaluate(async () => {
  try { await globalThis.__HALO__.ready; } catch (e) { return { ok: false, err: String(e?.stack || e) }; }
  let failed = [];
  try { failed = globalThis.__HALO__.failedModules() || []; } catch { }
  return { ok: true, missing: globalThis.__HALO_MISSING__ || [], failed: failed.map((f) => f.name) };
});
if (!boot.ok) { console.error('BOOT FAILED\n' + boot.err); await browser.close(); cleanup(); process.exit(2); }
if (boot.missing.length || boot.failed.length) {
  console.error('!!! incomplete scene — ablations against it mean nothing !!!');
  for (const m of boot.missing) console.error('    module not loaded : ' + m);
  for (const m of boot.failed) console.error('    module init threw : ' + m);
  console.error('    run `node tools/parsecheck.mjs` first (KNOWN_ISSUES §20, §11).');
  await browser.close(); cleanup(); process.exit(4);
}

mkdirSync(resolve(ROOT, OUTDIR), { recursive: true });
const variants = [['baseline', null], ...TARGETS.map((t) => [`${t}_off`, t])];
const stats = [];
const untoggleable = [];

for (const [name, off] of variants) {
  const r = await page.evaluate(async (pose, off, all, settle, t) => {
    const H = globalThis.__HALO__;
    let toggled = null;
    for (const n of all) H.togglePass(n, true);          // restore everything first
    if (off) toggled = H.togglePass(off, false);         // then switch exactly one off
    H.setSize(innerWidth, innerHeight);
    H.setPose(pose); H.setTime(t);
    H.advance(settle);
    const s = H.stats();
    return { du: H.screenshot(), toggled,
             tris: s.tris ?? s.triangles ?? null, draws: s.drawCalls ?? s.draws ?? null };
  }, POSE, off, TARGETS, SETTLE, TIME);

  if (off && r.toggled === null) untoggleable.push(off);
  writeFileSync(resolve(ROOT, OUTDIR, `${name}.png`), Buffer.from(r.du.split(',')[1], 'base64'));
  stats.push({ name, off, tris: r.tris, draws: r.draws, toggled: r.toggled });
  process.stderr.write(`captured ${name}\n`);
}
await browser.close();
cleanup();

/* ---- report ---------------------------------------------------------------------- */
const py = existsSync(resolve(ROOT, '.venv/bin/python')) ? resolve(ROOT, '.venv/bin/python') : 'python3';
const files = variants.map(([n]) => resolve(ROOT, OUTDIR, `${n}.png`));
let diffOut = '';
try {
  diffOut = execFileSync(py, [resolve(ROOT, 'tools/pixelcheck.py'), '--diff', ...files],
    { encoding: 'utf8' });
} catch (e) { diffOut = String(e.stdout || '') + String(e.stderr || ''); }

console.log(`\npose ${POSE}   settle ${SETTLE}   t ${TIME}   ${W}x${H}`);
console.log(diffOut.trimEnd());

const b = stats[0];
console.log(`\n${'variant'.padEnd(28)}${'tris'.padStart(14)}${'Δtris'.padStart(14)}${'draws'.padStart(8)}${'Δdraws'.padStart(9)}`);
for (const s of stats) {
  const dt = (s.tris != null && b.tris != null) ? s.tris - b.tris : null;
  const dd = (s.draws != null && b.draws != null) ? s.draws - b.draws : null;
  console.log(s.name.padEnd(28) +
    String(s.tris ?? '-').padStart(14) + String(dt ?? '-').padStart(14) +
    String(s.draws ?? '-').padStart(8) + String(dd ?? '-').padStart(9));
}
console.log('\ntris/draws are deterministic counters and are the only cost numbers this project');
console.log('can currently trust (KNOWN_ISSUES §29/§29b). Do NOT price a subsystem in ms here.');

let bad = 0;
if (untoggleable.length) {
  console.error(`\nNOT TOGGLEABLE (no such pass or module): ${untoggleable.join(', ')}`);
  bad += untoggleable.length;
}
const inert = (diffOut.match(/^(\S+)\s.*INERT/gm) || []).map((l) => l.split(/\s+/)[0]);
if (inert.length) {
  console.error(`\nINERT (byte-identical when switched off): ${inert.join(', ')}`);
  console.error('Any constant tuned against one of these was tuned against nothing at all.');
  console.error('This is KNOWN_ISSUES §28 (ssao/ssr, three waves) and §21 (dof, two waves).');
  bad += inert.length;
}
process.exit(bad ? 1 : 0);
