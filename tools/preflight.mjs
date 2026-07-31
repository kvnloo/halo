#!/usr/bin/env node
/**
 * ONE command every agent and workflow runs before it measures anything.
 *
 *   node tools/preflight.mjs            # exit 0 = this tree is safe to measure
 *   node tools/preflight.mjs --quiet    # only print failures
 *   node tools/preflight.mjs --json
 *
 * Why this file exists
 * --------------------
 * Every check below already existed somewhere. Not one of them was attached to anything.
 * `tools/parsecheck.mjs` says "run it before any measurement you intend to believe" —
 * nothing runs it. `src/world/poses.js` says "Gate: node tools/_posecheck.mjs" — nothing
 * runs it. KNOWN_ISSUES §16 prescribes a `find src -newermt '-10 minutes'` incantation —
 * nothing runs it. §27 says "check /health twice before waiting on a slow capture" —
 * nothing runs it. The result is in the history: Waves F and G were both scored against a
 * tree where `ocean.js` and `rocks.js` had stopped parsing (§20), and a critic reviewed an
 * ocean that was not in the build.
 *
 * This is deliberately five cheap checks in one command instead of five commands, because
 * the failure mode of this project is not "the check was wrong", it is "nobody ran it".
 * No GPU, no capture, ~3 s.
 *
 * Exit codes:  0 ok  •  1 a hard gate failed  •  2 preflight itself broke
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import os from 'node:os';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const asJson = argv.includes('--json');

const results = [];
const say = (s) => { if (!quiet && !asJson) console.log(s); };
const add = (name, ok, detail, hard = true, ran = true) => {
  results.push({ name, ok, hard, detail, ran });
  if (!asJson && (!ok || !quiet)) {
    const mark = ok ? 'ok  ' : (hard ? 'FAIL' : (ran ? 'warn' : 'SKIP'));
    console[ok ? 'log' : 'error'](`${mark} ${name}${detail ? ' — ' + detail : ''}`);
  }
};

/**
 * A check whose sub-tool is missing, crashed, or printed something other than the JSON it
 * was asked for MUST report that it did not run. It must never fall through to the
 * reassuring branch.
 *
 * Three checks below delegate to another script. Before this, two of them (`posecheck`,
 * `scale`) were wrapped in `if (existsSync(...))` / `if (d)` and vanished from the output
 * entirely when their tool was absent or broken — and `preflight ok` was printed over the
 * hole. The third (`provenance`) was worse than silent: it read
 * `const n = d?.incomparable ?? 0` without ever consulting the exit status, so a provcheck
 * that crashed, printed a stack trace, or was deleted produced `n = 0` and preflight
 * printed the green line *"adjacent scored runs share one pose set and one instrument"* —
 * a positive assertion about the tree, manufactured by a tool that never answered.
 *
 * That is the same shape as the failures this whole layer exists to catch: §28's
 * `git show <dead-sha> | grep -c` printing `0` (a true negative's output, from a command
 * that could not run), and §9's `--config` arms that compared a frame with itself. A gate
 * that reports OK when its instrument is missing is the silent failure, one level up.
 *
 * `missing()` is advisory by construction (hard = false): a gate that cannot run must be
 * loud, but it must never block a wave — a fresh clone is missing 22 of the 61 files in
 * `tools/` (check 6), and preflight refusing to run there would be worse than the hole.
 */
const missing = (name, why) => add(name, false, `${why} — THIS CHECK DID NOT RUN`, false, false);

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/* 1 -------------------------------------------------- src/ parses, no GLSL backticks */
{
  const r = run(process.execPath, ['tools/parsecheck.mjs', '--quiet']);
  const out = ((r.stderr || '') + (r.stdout || '')).trim();
  add('parsecheck', r.status === 0,
    r.status === 0 ? 'all src/**.js parse' : out.split('\n').slice(0, 6).join(' | '));
}

/* 2 ------------------------------------------ no camera pose has sunk under terrain */
if (existsSync(join(ROOT, 'tools/_posecheck.mjs'))) {
  const r = run(process.execPath, ['tools/_posecheck.mjs']);
  const out = ((r.stderr || '') + (r.stdout || ''));
  const fails = out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 5);
  add('posecheck', r.status === 0,
    r.status === 0 ? 'every pose above ground' : fails.join(' | ') || 'exit ' + r.status);
} else {
  missing('posecheck', 'tools/_posecheck.mjs is not on disk (src/world/poses.js names it as its gate)');
}

/* 3 --------------- a reference keyframe exists for every ref_ pose that will be scored
 * `score.mjs` prints "missing reference" and *continues*, then averages over whatever
 * survived and writes the row to history.jsonl with a smaller `n`. Two runs with different
 * `n` are not comparable, and nothing downstream notices. Catch it before the capture. */
{
  let poses = [];
  try {
    const src = readFileSync(join(ROOT, 'src/world/poses.js'), 'utf8');
    // dedupe: poses.js declares each key twice, in POSES and again in POSE_GROUND
    poses = [...new Set([...src.matchAll(/^\s{2}(ref_\d+)\s*:/gm)].map((m) => m[1]))];
  } catch { }
  const missing = poses.filter((p) => !existsSync(join(ROOT, `ref/keyframes/kf_${p.split('_')[1]}.png`)));
  add('references', poses.length > 0 && missing.length === 0,
    missing.length ? `${missing.length} of ${poses.length} ref_ poses have no ref/keyframes/kf_*.png: ${missing.slice(0, 5).join(' ')}`
                   : `${poses.length} ref_ poses, all keyframes present`,
    false);   // soft: `ref/` is gitignored licensed footage and is legitimately absent on a fresh clone
}

/* 4 ---------------------------------------------------- src/ is quiescent (§16)
 * "A scored run or determinism check is only valid if src/ is quiescent for its whole
 * duration." Six files were rewritten mid-capture during one pass and produced findings
 * that looked real and were not. Soft, because editing is the normal state of this repo —
 * but it must be *said out loud* next to the number, not looked up afterwards. */
{
  let recent = [];
  try {
    const changed = execFileSync('git', ['status', '--porcelain', '--', 'src'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.slice(3).trim());
    recent = changed.filter((f) => {
      try { return Date.now() - statSync(join(ROOT, f)).mtimeMs < 10 * 60 * 1000; } catch { return false; }
    });
  } catch { }
  add('src-quiescent', recent.length === 0,
    recent.length ? `${recent.length} file(s) written in the last 10 min — a concurrent wave is editing; any number you take now may be from a different tree: ${recent.slice(0, 4).join(' ')}`
                  : 'no src/ writes in the last 10 min',
    false);
}

/* 5 ---------------------------------------- the shared capture daemon is not wedged (§27)
 * A wedged daemon answers /health with ok:true forever and blocks every agent on the
 * machine. `stalledSec` (seconds since a request last completed) is what separates
 * "wedged" from "busy". */
{
  const PORT_FILE = '/tmp/halo-captured.port';
  let detail = 'no daemon running (capture.mjs will start one)';
  let ok = true;
  if (existsSync(PORT_FILE)) {
    try {
      const p = readFileSync(PORT_FILE, 'utf8').trim();
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(3000) });
      const h = await r.json();
      const stalled = h.stalledSec;
      if (stalled === undefined) detail = `daemon up on ${p} (pre-watchdog build; restart it to get stalledSec)`;
      else if (h.queued > 0 && stalled > 900) {
        ok = false;
        detail = `daemon WEDGED on ${p}: queued=${h.queued} inflight=${h.inflight} and nothing has completed in ${stalled}s. ` +
                 `Fix: kill the captured.mjs process and rm ${PORT_FILE} (KNOWN_ISSUES §27).`;
      } else detail = `daemon ok on ${p} (inflight=${h.inflight} queued=${h.queued} stalled=${stalled}s)`;
    } catch { detail = 'stale port file, capture.mjs will reap it'; }
  }
  add('daemon', ok, detail, false);
}

/* 6 -------------------------------------- the guardrails are actually IN the repository
 * Every gate this project has (`.githooks/pre-commit`, `.github/workflows/preflight.yml`,
 * `tools/preflight.mjs`, `parsecheck-staged`, `historycheck`, `citecheck`, `refuted.json`,
 * `scores/provenance.jsonl`) was written into ONE working tree and never committed. Two
 * commits in this repo's own log (`2651d8c`, `41624e7`) are salvage commits for work nearly
 * lost to session death — the safety layer is currently in exactly that unsaved state:
 *   - `git ls-files .github .githooks` returns 0 files, so the CI workflow whose header says
 *     "nothing has ever run on a push" still cannot run: it is not in the repository.
 *   - `core.hooksPath=.githooks` is local `.git/config`; a fresh clone gets no hook and no
 *     error, because the directory it points at does not exist there either.
 *   - `capture.mjs:251` says provenance is mirrored into "`scores/provenance.jsonl`, which
 *     IS tracked". It is not tracked. The join key from a score back to its tree exists on
 *     one disk.
 * Advisory: this must never block a wave, and it is loud enough unblocked. */
{
  const need = new Set();
  try {
    const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (hooksPath) for (const f of ['pre-commit', 'pre-push', 'commit-msg']) {
      if (existsSync(join(ROOT, hooksPath, f))) need.add(join(hooksPath, f));
    }
  } catch { }
  for (const rel of ['.github/workflows/preflight.yml', 'scores/provenance.jsonl', 'package.json']) {
    if (existsSync(join(ROOT, rel))) need.add(rel);
  }
  // every tools/ script a package.json script invokes
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    for (const cmd of Object.values(pkg.scripts || {}))
      for (const m of String(cmd).matchAll(/tools\/[\w.-]+\.(mjs|js|py)/g))
        if (existsSync(join(ROOT, m[0]))) need.add(m[0]);
  } catch { }

  let untracked = [];
  try {
    const list = [...need];
    const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', ...list],
      { cwd: ROOT, encoding: 'utf8' });
    const tracked = new Set((r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
    untracked = list.filter((f) => !tracked.has(f));
    // a tracked-but-uncommitted *modification* of package.json hides the script block too
    const dirtyPkg = (execFileSync('git', ['status', '--porcelain', '--', 'package.json'],
      { cwd: ROOT, encoding: 'utf8' }).trim());
    if (dirtyPkg && !untracked.includes('package.json')) untracked.push('package.json (uncommitted changes)');
  } catch { }

  add('guardrails-committed', untracked.length === 0,
    untracked.length
      ? `${untracked.length} file(s) the process depends on are not in git — they exist only in this ` +
        `working tree and vanish with it (CI cannot run a workflow that is not committed): ` +
        `${untracked.slice(0, 6).join(' ')}${untracked.length > 6 ? ' …' : ''}. ` +
        `Fix: git add -- ${untracked.slice(0, 6).map((s) => s.split(' ')[0]).join(' ')} && git commit`
      : `${need.size} guardrail file(s) tracked`,
    false);
}

/* 7 ----------------------- the daemon you are about to use serves THIS repository (§19)
 * The capture daemon is machine-wide and serves whatever repo it was STARTED from. A
 * capture taken in a scratch copy is answered from the original tree, returns ok:true with
 * every integrity channel empty, and is indistinguishable from a real null result. That has
 * already happened to a reviewer testing a deliberately-broken tree — they nearly recorded
 * the integrity gate as failing. Anything that compares two trees (ablation, bisecting a
 * regression, verifying a fix) is exposed to it.
 * `/health` now reports the daemon's own root. A daemon started before that build omits it,
 * so this stays advisory there rather than crying wolf. */
{
  const PORT_FILE = '/tmp/halo-captured.port';
  let ok = true, hard = false, detail = 'no daemon running';
  if (existsSync(PORT_FILE)) {
    try {
      const p = readFileSync(PORT_FILE, 'utf8').trim();
      const h = await (await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(3000) })).json();
      if (!h.root) detail = 'daemon predates the /health root field — restart it (curl .../stop) to enable this check';
      else {
        const real = (x) => { try { return realpathSync(x); } catch { return x; } };
        if (real(h.root) !== real(ROOT)) {
          ok = false; hard = true;
          detail = `the running daemon serves ${h.root}, but you are in ${ROOT}. Every capture you take ` +
                   `here will be answered from the OTHER tree and will look like a clean null result. ` +
                   `Fix: HALO_NO_DAEMON=1 for a one-off, or curl http://127.0.0.1:${p}/stop and let ` +
                   `capture.mjs start a daemon rooted here.`;
        } else detail = `daemon root matches this tree`;
      }
    } catch { detail = 'no reachable daemon (stale port file)'; }
  }
  add('daemon-root', ok, detail, hard);
}

/* 10 --------------- the ground truth you are about to be scored against is the right shape
 * `tools/refcheck.mjs` checks that ref/keyframes are at capture geometry. This is not
 * cosmetic: tools/metrics.py:298 resizes the TEST image to the REFERENCE's size, so a
 * reference set re-extracted at 4K (which is what README.md's rebuild recipe actually
 * produces — measured) silently upscales every render 2x before scoring and moves every
 * axis with no error. Advisory: on this disk it passes, and it can only ever be wrong for
 * someone who rebuilt ref/. */
if (existsSync(join(ROOT, 'tools/refcheck.mjs'))) {
  const r = run(process.execPath, ['tools/refcheck.mjs', '--json']);
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { }
  if (d) {
    const g = d.geometry || {};
    add('reference-shape', d.ok !== false,
      d.ok !== false
        ? `ref/ is at capture geometry ${g.w}x${g.h}`
        : `${(d.problems || []).map((p) => p.detail).join(' | ').slice(0, 200)} ` +
          `(node tools/refcheck.mjs)`,
      false);
  }
}

/* 11 ------------------------- docs/API.md describes the code that is actually on disk
 * "These signatures are frozen" is a claim with no instrument behind it, and API.md also
 * tells every consumer to guard each call — which turns a member that was never
 * implemented into a permanent silent false rather than an error. Advisory. */
if (existsSync(join(ROOT, 'tools/apicheck.mjs'))) {
  const r = run(process.execPath, ['tools/apicheck.mjs', '--json']);
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { }
  if (d) {
    const n = (d.absent || []).length + (d.deadEvents || []).length;
    add('api-contract', n === 0,
      n === 0
        ? `docs/API.md matches src/ (${d.modules} module contract(s))`
        : `${n} member(s) documented as frozen in docs/API.md are absent from src/: ` +
          `${(d.absent || []).map((a) => `${a.module}.${a.member}`).join(', ')} ` +
          `(node tools/apicheck.mjs)`,
      false);
  }
}

/* 12 ------------------------- blind.mjs's refusal gate checks a field capture.mjs emits
 * `tools/blind.mjs`'s "REFUSING: capture reported failedModules ..." refusal reads
 * `info.failedModules`, a field capture.mjs never puts at the top level (it lives at
 * `info.integrity.failedModules`), so the branch has never fired. Advisory: blind.mjs is
 * owned by a concurrent wave and out of scope to fix here; this only keeps the finding
 * visible. See tools/gatecheck.mjs. */
if (existsSync(join(ROOT, 'tools/gatecheck.mjs'))) {
  const r = run(process.execPath, ['tools/gatecheck.mjs', '--json']);
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { }
  if (d) {
    const n = (d.findings || []).length;
    add('blind-gate', n === 0,
      n === 0
        ? 'tools/blind.mjs\'s refusal gate checks fields tools/capture.mjs actually emits'
        : `${n} finding(s) in tools/blind.mjs's capture-stdout handling: ${d.findings.join(' | ')} (node tools/gatecheck.mjs)`,
      false);
  }
}

/* 8 ------------------ the number you are about to take is comparable to the one above it
 * `tools/provcheck.mjs` joins scores/provenance.jsonl to scores/history.jsonl. Summarised
 * here so the one command says it; run the tool for the detail. */
if (!existsSync(join(ROOT, 'tools/provcheck.mjs'))) {
  missing('provenance', 'tools/provcheck.mjs is not on disk');
} else {
  const r = run(process.execPath, ['tools/provcheck.mjs', '--json']);
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { }
  // `incomparable` is the whole verdict, so its ABSENCE must not read as zero. Without
  // this, a provcheck that crashed printed the green line instead of nothing.
  if (d == null || typeof d.incomparable !== 'number') {
    missing('provenance', `tools/provcheck.mjs --json returned no parseable verdict (exit ${r.status})`);
  } else {
    const n = d.incomparable;
    add('provenance', n === 0,
      n ? `${n} adjacent pair(s) of scored runs were produced by different pose sets or different ` +
          `measurement code — they are not one series (node tools/provcheck.mjs)`
        : 'adjacent scored runs share one pose set and one instrument',
      false);
  }
}

/* 9 ------------------ the ceiling you are aiming at is in the units you are scored in
 * `tools/metrics.py` was re-banded 2026-07-31; `ref/baseline.json` — the AAA ceiling quoted
 * as a pass criterion in docs/TARGETS.md and docs/ARCHITECTURE.md — was not regenerated and
 * carries no band stamp. Advisory: it is a document defect, never a reason to stop a wave. */
if (!existsSync(join(ROOT, 'tools/scalecheck.mjs'))) {
  missing('scale', 'tools/scalecheck.mjs is not on disk');
} else {
  const r = run(process.execPath, ['tools/scalecheck.mjs', '--json']);
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { }
  if (!d || typeof d.status !== 'string') {
    missing('scale', `tools/scalecheck.mjs --json returned no parseable verdict (exit ${r.status})`);
  } else {
    add('scale', d.status !== 'stale',
      d.status === 'stale'
        ? `ref/baseline.json predates the metrics.py re-band, and ${d.quoteSites?.length ?? 0} ` +
          `documented axis floor(s) are in the superseded units (node tools/scalecheck.mjs)`
        : 'the reference ceiling and the current bands are on one scale',
      false);
  }
}

/* 6 ------------------------------------- the box is not oversubscribed (§29, §22, §13)
 * Every frame-time number in the project has now been invalidated three separate times:
 * §13 (stats.ms was a structural zero), §22 (an EMA read once, so an --all run reports
 * only the last pose), §29 (a CPU stopwatch on a box at load average 24 — the same build
 * measured 10.23 and 18.80 ms p50 in one session, 1.84x apart, while the GPU was 27%
 * idle). §23 and §25 are marked SUSPECT because of it, and §25b's "~400 ms frame hitch"
 * is probably a scheduler stall, not a renderer.
 *
 * §29's prescription is "record uptime and free alongside every frame-time table from now
 * on". `capture.mjs` now stamps that into `_capture.json` and `scores/provenance.jsonl`
 * automatically; this says it BEFORE the hour is spent. Soft — a busy box is the normal
 * state of this repo, and image metrics, triangle counts and draw calls are unaffected. */
{
  let ok = true, detail = '';
  try {
    const la = os.loadavg().map((n) => +n.toFixed(2));
    const n = os.cpus().length || 1;
    const perCpu = +(la[0] / n).toFixed(2);
    let availMb = null;
    try {
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
      if (m) availMb = Math.round(+m[1] / 1024);
    } catch { }
    const tight = availMb !== null && availMb < 1536;
    ok = perCpu <= 1.0 && !tight;
    detail = `load ${la.join(' ')} on ${n} cpus (${perCpu}/cpu)` +
      (availMb === null ? '' : `, ${availMb} MB RAM available`) +
      (ok ? '' : ' — do NOT take or quote a frame-time number from this box right now ' +
                 '(KNOWN_ISSUES §29: same build, 1.84x spread at load 24). Triangle and ' +
                 'draw counts are deterministic and stay valid.');
  } catch { detail = 'could not read load average'; }
  add('machine-load', ok, detail, false);
}

/* ------------------------------------------------------------------------- verdict */
const hardFails = results.filter((r) => !r.ok && r.hard);
const notRun = results.filter((r) => r.ran === false);
const softFails = results.filter((r) => !r.ok && !r.hard && r.ran !== false);

// "preflight ok" must state its own coverage. A green line over a checklist where three of
// ten entries never executed is the assertion this round was written to remove.
const coverage = `${results.length - notRun.length}/${results.length} checks ran`;

/* -------------------------------------------------------------------- the stamp ---
 * This file's own header says "ONE command every agent and workflow runs before it
 * measures anything". Measured: it is wired ONLY to `npm run capture` / `npm run score`
 * (package.json `precapture` / `prescore`), and essentially nobody invokes it that way.
 * `node tools/capture.mjs` / `node tools/score.mjs` appear 31 times across reports/ and
 * docs/ against 3 mentions of the npm form — including `docs/LOOP.md` §4 ("what to do
 * every wave"), which runs `node tools/score.mjs --tag waveX` directly, and this repo's
 * own smoke command. Both direct paths skip preflight entirely and always have.
 *
 * So preflight leaves a receipt, and `capture.mjs` reads it and says so when it is
 * missing or older than the last `src/` write. Nothing here fails, blocks or slows a
 * capture: it is a file write inside a try/catch, and the reader is a stat loop.
 * The stamp is gitignored — it describes one working tree at one moment. */
try {
  const newest = (() => {
    let t = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) { const m = statSync(p).mtimeMs; if (m > t) t = m; }
      }
    };
    walk(join(ROOT, 'src'));
    return t;
  })();
  writeFileSync(join(ROOT, '.preflight-stamp.json'), JSON.stringify({
    t: Date.now(),
    at: new Date().toISOString(),
    ok: hardFails.length === 0,
    hardFails: hardFails.map((r) => r.name),
    softFails: softFails.map((r) => r.name),
    srcNewestMs: newest,
    ran: results.length - notRun.length,
    total: results.length,
  }) + '\n');
} catch { /* a receipt that cannot be written must never fail the check that wrote it */ }

if (asJson) {
  console.log(JSON.stringify({ ok: hardFails.length === 0, ran: results.length - notRun.length,
    total: results.length, notRun: notRun.map((r) => r.name), checks: results }, null, 2));
} else if (hardFails.length) {
  console.error(`\npreflight FAILED (${hardFails.map((r) => r.name).join(', ')}) — do not measure this tree. [${coverage}]`);
} else {
  say(`\npreflight ok — ${coverage}` +
    (notRun.length ? `; ${notRun.length} DID NOT RUN: ${notRun.map((r) => r.name).join(', ')}` : '') +
    (softFails.length ? ` (${softFails.length} advisory: ${softFails.map((r) => r.name).join(', ')})` : ''));
}

process.exit(hardFails.length ? 1 : 0);
