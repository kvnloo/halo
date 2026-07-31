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
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve, join as pjoin } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir, loadavg, cpus, totalmem } from 'node:os';
import net from 'node:net';

/* --------------------------------------------------------------- machine state ---
 * KNOWN_ISSUES §29: `ref_00600` was measured four times on ONE identical build in one
 * session and spread 10.23 -> 18.80 ms p50 — 1.84x, no source change — because the box
 * was at load average 24 with 1 GB of 15 GB free while the GPU sat 27% idle. That
 * voided §23's and §25's conclusions ("rocks is over 11 ms", "19 of 21 poses regressed")
 * and probably §25b's "~400 ms frame hitch on 11 poses", which is a scheduler stall on a
 * swapping box, not a renderer. It is the THIRD time every frame-time number on record
 * was invalidated at once: §13 (structural zero), §22 (EMA of the last pose only), §29.
 *
 * §29's own remedy — "record `uptime` and `free` alongside every frame-time table from
 * now on" — was never wired to anything. This is that, taken automatically at the moment
 * the number is produced and joined to the score row by outdir, exactly as G2 does for
 * the git tree. Two syscalls, no subprocess, inside the existing try/catch: it cannot
 * slow or fail a capture.
 */
const LOAD_AT_START = (() => { try { return loadavg().map((n) => +n.toFixed(2)); } catch { return null; } })();
function memAvailableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Math.round(+m[1] / 1024) : null;
  } catch { return null; }
}
function machineState() {
  try {
    const la = loadavg().map((n) => +n.toFixed(2));
    const n = cpus().length || 1;
    return {
      loadAtStart: LOAD_AT_START, load: la, cpus: n,
      loadPerCpu: +(la[0] / n).toFixed(2),
      memAvailMb: memAvailableMb(), memTotalMb: Math.round(totalmem() / 1048576),
      note: 'KNOWN_ISSUES §29: a frame-time number taken at loadPerCpu > 1 is a CPU ' +
            'stopwatch on an oversubscribed box and is not comparable to one taken idle. ' +
            'Triangle and draw counts are deterministic counters and stay trustworthy.',
    };
  } catch { return null; }
}

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
  config: arg('config', null),   // "k=v,k=v" poked via __HALO__.setConfig before capture
  allowMissing: has('allow-missing') || process.env.HALO_ALLOW_MISSING === '1',
  strictWarn: has('strict-warn') || process.env.HALO_STRICT_WARN === '1',
};

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/* --------------------------------------------------------------- argument hygiene ---
 * `arg()` and `has()` just index into argv, so this file has always accepted any flag at
 * all and silently ignored it. A typo, or a flag borrowed from another tool, produced a
 * perfectly normal *default* capture that the caller believed was something else.
 *
 * KNOWN_ISSUES §27 caught one in flight: `node tools/capture.mjs --beauty --placement
 * --chrome --label loop-r27` — four flags this file does not define, running for hours.
 *
 * The `--only` / `--skip` case is the dangerous one, because the project's dominant
 * measurement method is built on it: `reports/structures.md`, `reports/clouds.md` and
 * `reports/ocean_waveH.md` all measure by differencing a `--skip <module>` capture against
 * a full one, and call that difference "an exact semantic segmentation of this subsystem".
 * `src/modules.js` matches those names by EXACT STRING against its manifest, so `--skip
 * rock` (for `rocks`) skips nothing at all and the difference mask is pure noise — while
 * the capture succeeds, the integrity gate passes, and the report reads as rigorous.
 *
 * Unknown flags warn. A bad module name is fatal, because there is no reading of that
 * capture which is correct. Names are read from `src/modules.js` so they cannot drift.
 */
{
  const KNOWN_FLAGS = new Set(['pose', 'out', 'outdir', 'w', 'h', 'settle', 'time', 'seed',
    'only', 'skip', 'all', 'video', 'port', 'keep-server', 'timeout', 'verbose', 'config',
    'allow-missing', 'selftest-integrity', 'strict-warn', 'allow-stale']);
  const unknown = [], eqForm = [];
  for (const tok of argv) {
    if (!tok.startsWith('--')) continue;
    const name = tok.slice(2);
    if (name.includes('=')) eqForm.push(tok);          // arg() has no --k=v form; it reads as unset
    else if (!KNOWN_FLAGS.has(name)) unknown.push(tok);
  }
  if (eqForm.length) process.stderr.write(
    `[capture] WARNING: --key=value is not supported here and was IGNORED: ${eqForm.join(' ')}\n` +
    `[capture]          use a space: --settle 96, not --settle=96\n`);
  if (unknown.length) process.stderr.write(
    `[capture] WARNING: unknown flag(s) IGNORED, this capture used defaults instead: ${unknown.join(' ')}\n` +
    `[capture]          known flags: ${[...KNOWN_FLAGS].map((f) => '--' + f).join(' ')}\n`);

  /* An unknown flag that CONTAINS WHITESPACE is not a typo, it is a shell quoting bug, and
   * it is fatal because there is no reading of the resulting capture that is correct.
   *
   * `reports/ocean_waveH.md` §1: "zsh does not word-split an unquoted `$args`, so a scripted
   * sweep silently passes `"--skip ocean"` as ONE token and every variant comes back
   * byte-identical." Every arm of that battery was the shipped build. Byte-identical is also
   * the signature of an inert pass (`skip-flag-can-disable-a-pass` in tools/refuted.json,
   * KNOWN_ISSUES §28/§9/§21), and this project has confused the two at least four times.
   * The `--only`/`--skip` name check below cannot see it: `arg('skip')` never matched, so
   * OPT.skip is null and the module list is untouched.
   *
   * Zero false positives by construction: no flag this file defines contains a space. */
  const glued = unknown.filter((t) => /\s/.test(t));
  if (glued.length) {
    process.stderr.write(
      `\n[capture] FATAL: a single argv token contains whitespace: ${glued.map((t) => JSON.stringify(t)).join(' ')}\n` +
      `[capture]   That is a shell quoting bug, not a flag. The flag was IGNORED and this\n` +
      `[capture]   capture would have been the DEFAULT build — indistinguishable from a\n` +
      `[capture]   correct arm, and byte-identical to every other arm of the same sweep\n` +
      `[capture]   (reports/ocean_waveH.md §1: zsh does not word-split an unquoted $args).\n` +
      `[capture]   Write the flags out literally: --skip ocean, not "$args".\n\n`);
    process.exit(2);
  }

  /* --settle must be a multiple of 16, or you are comparing TAA phases.
   *
   * reports/taa.md §4, measured: with a fixed alpha = 0.09 the converged still is PERIODIC
   * WITH PERIOD 16, not a fixed point. Phase-matched frames (48/64/96/128) agree to 3 code
   * values; frame 48 vs 49 differs by up to 53 code values on exactly the high-contrast
   * rock/sky silhouettes the `detail` and `structure` axes look at. That report's own
   * conclusion: "Anyone who just bumps the settle to 50 will move scores and blame their
   * own subsystem." KNOWN_ISSUES §26 priced the same class at 0.52 composite points
   * (`waveG` vs `waveG-settle96`, identical code) and -3.55 on `ref_01500` alone.
   *
   * It has already happened at least three times, and every one of those numbers is still
   * quoted as a result: `reports/characters.md:73` and `:141` (the whole character A/B at
   * `--settle 24`), `reports/sky.md:167` (`--settle 24`), `docs/KNOWN_ISSUES.md:308-309`
   * (§9's exposureEV A/B at `--settle 40`). 24 and 40 are both phase 8 — the worst case,
   * half a period from the settle-48 baseline every other number in the project uses.
   *
   * Advisory only: it is a comparability hazard, not a broken capture. Values under 16 are
   * left silent — they have not completed one TAA period at all, so they are obviously a
   * smoke capture (`--settle 8` is this repo's own smoke command) and not a measurement. */
  if (OPT.settle >= 16 && OPT.settle % 16 !== 0) process.stderr.write(
    `[capture] WARNING: --settle ${OPT.settle} is not a multiple of 16 (phase ${OPT.settle % 16}).\n` +
    `[capture]          TAA's converged still is periodic with period 16 (reports/taa.md §4):\n` +
    `[capture]          an off-phase settle is a different picture by up to 53 code values on\n` +
    `[capture]          high-contrast edges. Comparable to another --settle ${OPT.settle} capture only;\n` +
    `[capture]          NOT to the --settle 48 baseline every score in history.jsonl uses.\n`);

  let names = null;
  try {
    const man = readFileSync(resolve(ROOT, 'src/modules.js'), 'utf8');
    names = new Set([...man.matchAll(/\bname:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  } catch { /* if the manifest cannot be read, do not invent a reason to fail */ }
  if (names && names.size) {
    for (const k of ['only', 'skip']) {
      const v = OPT[k];
      if (!v || v === true) continue;
      const bad = String(v).split(',').map((s) => s.trim()).filter((s) => s && !names.has(s));
      if (bad.length) {
        process.stderr.write(
          `\n[capture] FATAL: --${k} names no such module: ${bad.join(', ')}\n` +
          `[capture]   known modules: ${[...names].join(' ')}\n` +
          `[capture]   src/modules.js matches these by exact string, so this capture would\n` +
          `[capture]   have silently ${k === 'skip' ? 'skipped nothing' : 'loaded the wrong subset'} and any A/B built on it\n` +
          `[capture]   would be meaningless (KNOWN_ISSUES §27).\n\n`);
        process.exit(2);
      }
    }
  }
}

/* --------------------------------------------- was this tree gated before measuring? ---
 * `tools/preflight.mjs` calls itself "ONE command every agent and workflow runs before it
 * measures anything". It is wired only to `npm run capture` / `npm run score`
 * (package.json `precapture` / `prescore`) — and nobody invokes it that way. Counted
 * across `reports/` and `docs/`: 31 sites run `node tools/capture.mjs` or
 * `node tools/score.mjs` directly, 3 mention the npm form. `docs/LOOP.md` §4 — the
 * per-wave recipe — runs `node tools/score.mjs --tag waveX`, and every proof-of-no-harm
 * in `docs/META_LEDGER.md` runs `node tools/capture.mjs --pose ref_00000`. Both bypass
 * every preflight check, and always have: posecheck (§17.1 — a pose sunk under the
 * terrain), reference coverage (a smaller `n` written to history.jsonl with no warning),
 * §16 quiescence, §27's wedged daemon, §29's oversubscribed box.
 *
 * So preflight leaves `.preflight-stamp.json` and this says whether it is still valid for
 * the tree about to be captured. ADVISORY by design: the §20 outcome preflight's hard
 * check exists to stop is already fatal here through the integrity channels, so this is
 * a receipt, not a second gate. It runs no subprocess, launches nothing, and cannot fail
 * a capture — it stats `src/**.js` and prints to stderr.
 *
 * Silence it: `HALO_NO_PREFLIGHT_NOTE=1`. Make it stop being true: `node tools/preflight.mjs`. */
if (!has('selftest-integrity') && process.env.HALO_NO_PREFLIGHT_NOTE !== '1') {
  try {
    const stampPath = resolve(ROOT, '.preflight-stamp.json');
    const stamp = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, 'utf8')) : null;
    let newest = 0, newestFile = '';
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = pjoin(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          const m = statSync(p).mtimeMs;
          if (m > newest) { newest = m; newestFile = p.slice(ROOT.length + 1); }
        }
      }
    };
    walk(resolve(ROOT, 'src'));

    let why = null;
    if (!stamp) why = 'preflight has never been run against this working tree';
    else if (!stamp.ok) why = `the last preflight FAILED (${(stamp.hardFails || []).join(', ') || 'hard gate'}) at ${stamp.at}`;
    else if (newest > stamp.t) why = `preflight last ran ${stamp.at}, before src/ changed (${newestFile})`;

    if (why) process.stderr.write(
      `[capture] NOTE: ${why}.\n` +
      `[capture]       This capture is ungated: nothing has checked that every src/*.js parses\n` +
      `[capture]       (§20), that no pose has sunk under the terrain (§17.1), that a reference\n` +
      `[capture]       keyframe exists for every scored pose, or that src/ is quiescent (§16).\n` +
      `[capture]       Run:  node tools/preflight.mjs      (~2 s, no GPU)   [HALO_NO_PREFLIGHT_NOTE=1 to silence]\n`);
  } catch { /* a receipt that cannot be read must never fail the capture that read it */ }
}

/* ------------------------------------------------- a scored outdir must hold ONE run ---
 * This file never clears `--outdir`, and `tools/score.mjs:115` measures *every* `ref_*.png`
 * it finds there:
 *
 *     const shots = readdirSync(join(ROOT, outdir)).filter((f) => /^ref_\d+\.png$/.test(f));
 *
 * So `node tools/score.mjs --pose ref_00450` — the second invocation in score.mjs's own
 * docblock — captures ONE pose into `shots/latest` and then averages it with eight frames
 * from whenever that directory was last full. Every existing gate passes while it happens:
 * the capture exits 0, all three integrity channels are clean (the stale frames came from a
 * build that was also complete), `n` is still 9 so historycheck's pose-count check is
 * satisfied, and the row in history.jsonl is indistinguishable from a real one. It is on
 * disk right now — `shots/latest` holds frames five hours and an unknown number of `src/`
 * edits apart, and `scores/rescore_latest.json` was written from that mixture with `"n": 9`.
 *
 * `tools/shotcheck.mjs` diagnoses this after the fact and is wired into nothing. This is
 * the same rule at the only moment the mixture can be prevented instead of explained.
 *
 * Deliberately narrow, because `shots/latest` is also the machine's junk drawer (ab_*.png,
 * ch_*.png, probe output): it fires ONLY when a single `ref_NNNNN` pose is written into a
 * directory that already holds a *different* `ref_NNNNN.png`. `--all` rewrites all of them,
 * `--out` writes one named file, and a non-`ref_` probe pose is not scored — none of those
 * can produce the mixture, and none of them trips this.
 */
if (!OPT.out && !OPT.all && !OPT.video && !has('selftest-integrity') &&
    !(has('allow-stale') || process.env.HALO_ALLOW_STALE === '1') &&
    /^ref_\d+$/.test(String(OPT.pose))) {
  let stale = [];
  try {
    stale = readdirSync(resolve(ROOT, OPT.outdir))
      .filter((f) => /^ref_\d+\.png$/.test(f) && f !== `${OPT.pose}.png`);
  } catch { /* directory does not exist yet: nothing stale by construction */ }
  if (stale.length) {
    stale.sort();
    process.stderr.write(
      `\n[capture] FATAL: ${OPT.outdir}/ already holds ${stale.length} other ref_ frame(s) that\n` +
      `[capture]   this single-pose capture will NOT rewrite:\n` +
      `[capture]     ${stale.join(' ')}\n` +
      `[capture]   tools/score.mjs measures every ref_*.png in the directory, so those frames\n` +
      `[capture]   would be averaged into this run's score as if they belonged to it, with the\n` +
      `[capture]   full pose count n and no way to tell afterwards (tools/shotcheck.mjs).\n` +
      `[capture]   Fix, either:\n` +
      `[capture]     node tools/capture.mjs --all --outdir ${OPT.outdir} ...   # re-take the set\n` +
      `[capture]     --outdir shots/<something-new>                            # a fresh directory\n` +
      `[capture]   Really want one pose beside older ones? --allow-stale (or HALO_ALLOW_STALE=1)\n\n`);
    process.exit(6);
  }
}

/* ---------------------------------------------------------------- integrity gate ---
 * A capture used to succeed — exit 0, `"ok": true` — against a scene that was missing
 * whole subsystems. Three independent channels report that, and NONE of them was checked
 * by any caller:
 *
 *   __HALO_MISSING__          module failed to import / create()   (src/modules.js:76)
 *   stats.failedModules       module imported but init() threw     (src/core/Engine.js:147)
 *   __HALO_MISSING_PASSES__   post pass failed to load             (src/render/pipeline.js:61)
 *
 * The damage is in KNOWN_ISSUES: §20 — ocean.js and rocks.js were dead through Waves F and
 * G and every capture in both waves was scored against a scene with no ocean in it; a Wave E
 * critic wrote a full 12/100 review of a subsystem that was not in the build. §11 — physics
 * threw in init() and was "dead in every capture and every score on record", for the whole
 * project, because nobody read `failedModules`. §19 — the fog agent misdiagnosed a pass that
 * had stopped *loading* as a stale-code daemon bug, and shipped a workaround that cost a vite
 * + Chrome per agent.
 *
 * `tools/parsecheck.mjs` catches only the syntax half of this, and only if someone runs it.
 * This catches all three, at the one moment that matters — the moment a number is produced —
 * and makes the process exit non-zero, which is what `score.mjs` already checks. Scoring a
 * broken tree is now impossible by default.
 *
 * Escape hatch, for deliberately partial builds:  --allow-missing  /  HALO_ALLOW_MISSING=1
 */
function integrityReport(missing, stats, missingPasses) {
  return {
    missing: missing || [],
    failedModules: (stats?.failedModules || []).map((f) => `${f.name}: ${String(f.error).split('\n')[0]}`),
    missingPasses: missingPasses || [],
  };
}

function integrityGate(rep, via) {
  const n = rep.missing.length + rep.failedModules.length + rep.missingPasses.length;
  if (!n) return 0;
  const lines = [
    '',
    '!!! CAPTURE INTEGRITY FAILURE — this scene is incomplete, do not measure it !!!',
    `    via: ${via}`,
  ];
  for (const m of rep.missing) lines.push(`    module not loaded : ${m}`);
  for (const m of rep.failedModules) lines.push(`    module init threw : ${m}`);
  for (const m of rep.missingPasses) lines.push(`    pass not loaded   : ${m}`);
  lines.push('',
    '    Run `node tools/parsecheck.mjs` first; a broken file is skipped silently and its',
    '    subsystem simply vanishes from the frame (KNOWN_ISSUES §20, §11, §19).',
    '    The PNGs were still written, so you can look at what broke.',
    '    Deliberately partial build? re-run with --allow-missing (or HALO_ALLOW_MISSING=1).',
    '');
  process.stderr.write(lines.join('\n') + '\n');
  return n;
}

/* ------------------------------------------------ warnings that mean "nothing drew" ---
 * Both capture paths already collect a `warnings[]` array (daemon: `captured.mjs:165`,
 * standalone: the `logs.filter(...)` below) and G2 now writes it into `_capture.json` and
 * `scores/provenance.jsonl`. Nothing has ever *printed* it. It reaches stdout only inside a
 * ~100-line JSON blob, and `score.mjs:106` parses that blob and reads `capInfo.stats` and
 * nothing else — so a capture warning has never once appeared next to a score.
 *
 * That array is where the fourth integrity channel lives. `__HALO_MISSING__`,
 * `stats.failedModules` and `__HALO_MISSING_PASSES__` all catch a module that failed to
 * LOAD. A module that loads and then draws nothing shows up only here:
 *
 *   - GLSL compile/link failure. `reports/terrain.md` §1: all three terrain materials failed
 *     to link ("'patch' : Illegal use of reserved word"), every integrity channel said the
 *     scene was complete, and the "sand" in the committed showcase sheet was the clear
 *     colour. Also `reports/integration_waveE.md` (3x VALIDATE_STATUS false) and §16.
 *   - `GL_INVALID_OPERATION` — the driver refuses the draw call and returns normally.
 *     `scores/provenance.jsonl` is carrying five of these right now, from a `--only pipeline`
 *     capture, seen by nobody.
 *   - A subsystem's own "I placed nothing" diagnostic. `src/world/vegetation.js:2071` warns
 *     when the ivy band underfills; a `--skip rocks` capture in provenance.jsonl reports
 *     `ivy drape underfilled: 0/3200 cards`, i.e. ablating *rocks* silently also ablates
 *     3200 vegetation cards and the resulting delta is attributed entirely to rocks.
 *
 * Ledger round 5 deferred making any of this fatal because "benign and real are genuinely
 * mixed in there, and someone must separate them before any of it can be made to exit
 * non-zero." This is that separation: a narrow list matched against the already-filtered
 * warnings, printed to stderr on every capture. It does NOT change the exit code — the
 * default behaviour of this file is unchanged — unless you opt in with `--strict-warn`.
 */
const CRITICAL_WARN = [
  /Shader Error|VALIDATE_STATUS|Illegal use of reserved word|ERROR: \d+:/i,
  /GL_INVALID_(OPERATION|FRAMEBUFFER_OPERATION|VALUE|ENUM)/,
  /\[pageerror\]/,
  /underfilled|\b0\s*\/\s*\d+\b/,
  /\bno-?op\b|not loaded|\bdisabled\b|feedback loop|\bNaN\b/i,
];
function reportCriticalWarnings(warnings, via) {
  let crit = [];
  try {
    crit = [...new Set((warnings || []).filter((w) => CRITICAL_WARN.some((re) => re.test(w))))];
    if (crit.length) {
      const lines = ['',
        `!! ${crit.length} capture warning(s) that mean something did not compile, did not draw,`,
        `   or placed nothing (via: ${via}). The scene loaded; that is not the same as complete.`];
      for (const w of crit) lines.push('     ' + String(w).slice(0, 300));
      lines.push('   Exit code is unchanged. `--strict-warn` / HALO_STRICT_WARN=1 makes these fatal (exit 4).', '');
      process.stderr.write(lines.join('\n') + '\n');
    }
  } catch { /* never let the reporter break a capture */ }
  return crit;
}

/* -------------------------------------------------------------- provenance stamp ---
 * Every capture drops a `_capture.json` beside its PNGs recording what produced them.
 *
 * Nothing in `scores/*.json` or `scores/history.jsonl` says which git tree, which pose
 * table, which settle count or which of the two capture code paths made a number. That has
 * already cost real time: §3/`ba09973` — poses are refittable and "applying a fit invalidates
 * every previously recorded score", with no stamp on a score to say which pose set it used;
 * §26 — `waveG` and `waveG-settle96` are the same code and differ by 0.52, and `--settle` is
 * not recorded anywhere in the history row; §16 — six `src/` files were rewritten *while*
 * captures were running, producing findings that "look real and are not", and the prescribed
 * check is a `find -newermt` incantation in a doc that nobody runs.
 *
 * This is a stamp, not a gate: it never fails a capture, and it changes no measurement.
 */
function sha256File(rel) {
  try { return createHash('sha256').update(readFileSync(resolve(ROOT, rel))).digest('hex').slice(0, 16); }
  catch { return null; }
}
function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
function writeProvenance(dir, extra) {
  try {
    const abs = resolve(ROOT, dir);
    mkdirSync(abs, { recursive: true });
    // §16: src/ must be quiescent for a run to be trustworthy. Report anything touched
    // in the last 10 minutes rather than telling people to run `find` by hand.
    let recent = [];
    try {
      recent = (git('status', '--porcelain', '--', 'src') || '').split('\n').filter(Boolean)
        .map((l) => l.slice(3).trim())
        .filter((f) => { try { return Date.now() - statSync(resolve(ROOT, f)).mtimeMs < 10 * 60 * 1000; } catch { return false; } });
    } catch { }
    const rec = {
      ts: new Date().toISOString(),
      git: { sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
             dirtySrc: (git('status', '--porcelain', '--', 'src') || '').split('\n').filter(Boolean).length,
             srcEditedWithin10min: recent },
      poses: { file: 'src/world/poses.js', sha256: sha256File('src/world/poses.js') },
      tools: { capture: sha256File('tools/capture.mjs'), metrics: sha256File('tools/metrics.py'),
               score: sha256File('tools/score.mjs'), node: process.version },
      opts: { settle: OPT.settle, time: OPT.time, seed: OPT.seed, w: OPT.w, h: OPT.h,
              only: OPT.only, skip: OPT.skip, video: OPT.video, config: OPT.config },
      machine: machineState(),   // §29 — see the machine-state block at the top of this file
      ...extra,
    };
    writeFileSync(pjoin(abs, '_capture.json'), JSON.stringify(rec, null, 2));
    // `shots/` is gitignored, so the sidecar alone would never reach a reviewer. Mirror one
    // line into `scores/provenance.jsonl`, which IS tracked, keyed by outdir + timestamp —
    // `score.mjs` writes its frames to `shots/<tag>/`, so the tag is the join key back to
    // `scores/<tag>.json` and to the matching row of `scores/history.jsonl`.
    mkdirSync(resolve(ROOT, 'scores'), { recursive: true });
    appendFileSync(resolve(ROOT, 'scores/provenance.jsonl'),
      JSON.stringify({ outdir: dir, ...rec }) + '\n');
  } catch { /* provenance must never be the reason a capture fails */ }
}

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

/* ------------------------------------------------------- the daemon serves ONE tree ---
 * The daemon is machine-wide: it holds a vite rooted at whatever directory it was STARTED
 * from, and it answers every request from that tree no matter who asks. So a capture taken
 * inside a second checkout — a scratch copy, a git worktree, a bisect — is answered from
 * the ORIGINAL tree and comes back `"ok": true` with all three integrity channels empty.
 * It is indistinguishable from a genuine null result, and every two-tree operation
 * (ablation, bisecting a regression, verifying a fix) is exposed to it. A reviewer hit this
 * live: three deliberately broken files under /tmp scored clean, and they "nearly recorded
 * the gate as failing" (META_LEDGER round 5, "Noticed, not done").
 *
 * That note asked for exactly this: "a daemon /health field carrying its own repo root so
 * capture.mjs can refuse a daemon whose root != process.cwd()". G12 added the field and a
 * preflight check — but preflight resolves ROOT from its own file, so running it inside the
 * scratch copy is the only way it can ever fire, and the documented workflow is to run
 * preflight in the main tree and then capture elsewhere. The refusal has to live at the
 * fetch, which is here.
 *
 * Cost: one string compare on a response this function already awaited. It cannot fire on
 * the main tree (roots match) and it cannot fire on a daemon built before G12 (no `root`).
 */
function refuseForeignDaemon(health) {
  if (process.env.HALO_ALLOW_FOREIGN_DAEMON === '1') return;
  const theirs = health && typeof health.root === 'string' ? health.root : null;
  if (!theirs) return;                     // pre-G12 daemon: cannot know, do not cry wolf
  let a, b;
  try { a = realpathSync(theirs); b = realpathSync(ROOT); } catch { return; }
  if (a === b) return;
  process.stderr.write(
    `\n[capture] FATAL: the shared capture daemon serves a DIFFERENT tree.\n` +
    `[capture]   daemon root : ${a}${health.pid ? `  (pid ${health.pid})` : ''}\n` +
    `[capture]   this tree   : ${b}\n` +
    `[capture]   Every frame it returns would be rendered from the other tree, and the\n` +
    `[capture]   integrity channels would come back empty — a confident null result that\n` +
    `[capture]   measured none of your changes (META_LEDGER round 5 / G12).\n` +
    `[capture]   Fix, either:\n` +
    `[capture]     HALO_NO_DAEMON=1 node tools/capture.mjs ...     # capture this tree standalone\n` +
    `[capture]     curl -s localhost:$(cat ${PORT_FILE})/stop      # stop the foreign daemon\n` +
    `[capture]   Deliberate? HALO_ALLOW_FOREIGN_DAEMON=1\n\n`);
  process.exit(5);
}

async function daemonPort() {
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(PORT_FILE)) {
      const p = readFileSync(PORT_FILE, 'utf8').trim();
      try {
        const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(2500) });
        if (r.ok) {
          let health = null;
          try { health = await r.json(); } catch { }
          refuseForeignDaemon(health);
          return p;
        }
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

/* ---------------------------------------------------- why did we fall back to standalone? ---
 * `viaDaemon()` used to flatten three distinct outcomes — no daemon running, an HTTP/timeout
 * error hitting it, and a daemon that ran and answered `{ok:false, err, logs}` — to the same
 * `null`, and `main()` silently took the standalone path. `captured.mjs`'s own header records
 * what that costs at scale: standalone is ~1 GB per agent and exhausted system memory at 17
 * agents, which is the entire reason the daemon exists. §19 is the precedent for the diagnostic
 * cost of a discarded reason: a pass that had stopped loading was misdiagnosed as "a stale-code
 * daemon bug" because nothing said why the daemon path was skipped.
 *
 * Now every non-success exit carries a `reason` string instead of collapsing to `null`, and
 * `main()` reads it off the return value directly (no module-level mutable state to stomp).
 * This changes no behaviour and no exit code — it is a return shape and a stderr line.
 */
async function viaDaemon(poses, all = false) {
  const port = await daemonPort();
  if (!port) return { ok: false, reason: 'no daemon' };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        poses, all, w: OPT.w, h: OPT.h, settle: OPT.settle, time: OPT.time,
        seed: OPT.seed, only: OPT.only, skip: OPT.skip, video: OPT.video, config: OPT.config,
      }),
      // nine poses in one page load legitimately takes minutes under load
      signal: AbortSignal.timeout(Math.max(OPT.timeout, (all ? 9 : (poses?.length || 1)) * 120000)),
    });
    if (!r.ok) return { ok: false, reason: `daemon error: HTTP ${r.status}` };
    const out = await r.json();
    if (!out.ok) return { ok: false, reason: `daemon returned ok:false: ${String(out.err || '').slice(0, 300)}` };
    return out;
  } catch (e) { return { ok: false, reason: `daemon error: ${e.message}` }; }
}

async function main() {
  // Self-test for the integrity gate above, with the three real historical failures as
  // input. No GPU, no browser, ~30 ms — so CI and a reviewer can both confirm the gate
  // still fires without having to break a src/ file to find out.
  if (has('selftest-integrity')) {
    const rep = integrityReport(
      ['ocean: Unexpected identifier — KNOWN_ISSUES §20'],
      { failedModules: [{ name: 'physics', error: 'ReferenceError: addStatic is not defined — §11' }] },
      ['tonemap: no create() — §19']);
    const n = integrityGate(rep, 'selftest');
    console.log(JSON.stringify({ selftest: true, detected: n, expected: 3 }, null, 2));
    process.exit(n === 3 ? 0 : 1);
  }

  // Fast path: a shared daemon already holds a vite + Chrome. No semaphore needed -
  // the daemon bounds its own concurrency.
  let daemonFallback = null;
  if (!OPT.port && !process.env.HALO_NO_DAEMON) {
    {
      const d = await viaDaemon(OPT.all ? null : [OPT.pose], OPT.all);
      if (d.ok) {
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
        const rep = integrityReport(d.missing, d.stats, d.missingPasses);
        const dir = OPT.out ? dirname(OPT.out) : OPT.outdir;
        writeProvenance(dir, { via: 'daemon', files, integrity: rep, warnings: d.warnings || [] });
        const bad = OPT.allowMissing ? 0 : integrityGate(rep, 'daemon');
        const crit = reportCriticalWarnings(d.warnings, 'daemon');
        console.log(JSON.stringify({ ok: bad === 0, via: 'daemon', files, stats: d.stats,
          integrity: rep, warnings: d.warnings || [], criticalWarnings: crit }, null, 2));
        if (bad) process.exit(3);
        if (OPT.strictWarn && crit.length) process.exit(4);
        return;
      }
      daemonFallback = d.reason || null;
      process.stderr.write(
        `[capture] DAEMON UNAVAILABLE (${daemonFallback}) — falling back to standalone; ` +
        `this spawns its own vite + Chrome (~1 GB). See tools/captured.mjs header.\n`);
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
    try { await globalThis.__HALO__.ready; return { ok: true, missing: globalThis.__HALO_MISSING__ || [], missingPasses: globalThis.__HALO_MISSING_PASSES__ || [] }; }
    catch (e) { return { ok: false, err: String(e && e.stack || e), missing: globalThis.__HALO_MISSING__ || [], missingPasses: globalThis.__HALO_MISSING_PASSES__ || [] }; }
  });
  if (!ok.ok) {
    console.error('BOOT FAILED\n' + ok.err + '\n--- console ---\n' + logs.slice(-40).join('\n'));
    await browser.close(); cleanup(); process.exit(2);
  }

  const poses = OPT.all
    ? await page.evaluate(() => Object.keys(globalThis.__HALO__.poses).filter((k) => k.startsWith('ref_')))
    : [OPT.pose];

  const results = [];
  for (const pose of poses) {
    const dataUrls = await page.evaluate(async (pose, settle, t, nvid, cfg) => {
      const H = globalThis.__HALO__;
      if (cfg) for (const kv of cfg.split(',')) { const [k,v]=kv.split('='); H.setConfig(k, isNaN(+v)? v : +v); }
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
    }, pose, OPT.settle, OPT.time, OPT.video, OPT.config, { timeout: OPT.timeout });

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
  const warnings = logs.filter((l) => /warn|error|404|THREE/i.test(l)).slice(0, 25);
  const rep = integrityReport(ok.missing, stats, ok.missingPasses);
  const dir = OPT.out ? dirname(OPT.out) : OPT.outdir;
  writeProvenance(dir, { via: 'standalone', files: results, integrity: rep, warnings, daemonFallback });
  const bad = OPT.allowMissing ? 0 : integrityGate(rep, 'standalone');
  const crit = reportCriticalWarnings(warnings, 'standalone');
  console.log(JSON.stringify({ ok: bad === 0, via: 'standalone', files: results, stats,
    integrity: rep, warnings, criticalWarnings: crit, daemonFallback }, null, 2));

  await browser.close();
  if (!OPT.keepServer) cleanup();
  releaseSlot();
  if (bad) process.exit(3);
  if (OPT.strictWarn && crit.length) process.exit(4);
}

main().catch((e) => { console.error(e); process.exit(1); });
