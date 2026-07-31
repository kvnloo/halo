#!/usr/bin/env node
/**
 * stagedcheck — the staged-blob parse gate, applied to the INSTRUMENTS and the RECORDS.
 *
 * `.githooks/pre-commit` already runs `tools/parsecheck-staged.mjs`, which inspects staged
 * `src/**.js` only. Everything else in this repository commits unchecked, including the
 * files the measurements are made *with* and the file the measurements are recorded *in*:
 *
 *   tools/*.mjs   the gates themselves. `node --check`.
 *   tools/*.py    metrics.py, pixelcheck.py, silhouette.py. `python -m py_compile`.
 *   *.json        tools/refuted.json, tools/contracts.json, tools/ref_manifest.json,
 *                 scores/*.json, package.json — several are hand-maintained.
 *   *.jsonl       scores/history.jsonl, scores/provenance.jsonl, scores/blind_ledger.jsonl.
 *
 * WHY THESE
 * ---------
 * `scores/history.jsonl` is the project's only longitudinal record and 17 files under
 * `tools/` and `docs/` read it. It is also hand-edited: its last row is a hand-typed
 * `{"tag": "== POSE REFIT LINE ==", ...}` marker somebody added after the fact to warn that
 * the series is discontinuous. A hand-typed row is one keystroke from being unparseable,
 * and one truncated append leaves it that way for every reader at once.
 *
 * `tools/refuted.json` and `tools/contracts.json` are hand-written registries whose whole
 * job is to make a gate fire. A malformed one does not make the gate loud; it makes the gate
 * *crash*, which — until `tools/advisory.mjs` — CI printed and then discarded with `|| true`.
 *
 * And KNOWN_ISSUES §16 is about a tree a dozen agents write continuously: "an agent killed
 * mid-edit can leave a file that does not parse... it took the whole build down twice here"
 * (tools/checkpoint.md). That hazard was never specific to `src/`. `tools/metrics.py`'s
 * content hash changed three times inside the 30 minutes that produced the last three rows
 * of the history.
 *
 * SAME TECHNIQUE, SAME REASON
 * ---------------------------
 * It reads `git show :<path>` — the exact bytes about to become a commit — not the working
 * tree, because with a dozen agents sharing one checkout the working copy of an unrelated
 * file is routinely mid-write (§16). It never inspects a file you are not committing.
 *
 * Fail-open on its own errors: a broken hook must never be the reason a wave cannot commit.
 * Salvage commit of deliberately half-finished work (as in `2651d8c`)? `git commit --no-verify`.
 *
 * Exit codes:  0 ok  •  1 a staged blob does not parse
 */
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';

const ROOT = (() => {
  try { return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim(); }
  catch { return resolve(new URL('..', import.meta.url).pathname); }
})();

let staged = [];
try {
  staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch { process.exit(0); }        // never block a commit because the hook itself broke

const isJs = (f) => f.startsWith('tools/') && (f.endsWith('.mjs') || f.endsWith('.js'));
const isPy = (f) => f.startsWith('tools/') && f.endsWith('.py');
const isJson = (f) => f.endsWith('.json');
const isJsonl = (f) => f.endsWith('.jsonl');

const targets = staged.filter((f) => isJs(f) || isPy(f) || isJson(f) || isJsonl(f));
if (!targets.length) process.exit(0);

/** py_compile needs an interpreter; the repo ships a .venv but a fresh clone may not have it. */
const PY = [join(ROOT, '.venv/bin/python'), 'python3', 'python'].find((p) => {
  if (p.startsWith('/') && !existsSync(p)) return false;
  try { execFileSync(p, ['-c', ''], { stdio: 'ignore' }); return true; } catch { return false; }
});

const tmp = mkdtempSync(join(tmpdir(), 'halo-stagedcheck-'));
const fails = [];

for (const rel of targets) {
  let src;
  try { src = execFileSync('git', ['show', `:${rel}`], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }); }
  catch { continue; }               // deleted / unreadable blob: not ours to judge

  if (isJs(rel)) {
    const scratch = join(tmp, basename(rel).replace(/\.js$/, '.mjs'));   // force ESM parse
    writeFileSync(scratch, src);
    try { execFileSync(process.execPath, ['--check', scratch], { stdio: 'pipe' }); }
    catch (e) {
      fails.push(`${rel}\n    ${String(e.stderr || e).split('\n').filter(Boolean).slice(0, 3)
        .join('\n    ').split(scratch).join(rel)}`);
    }
  } else if (isPy(rel)) {
    if (!PY) continue;              // no interpreter here: skip, do not invent a failure
    const scratch = join(tmp, basename(rel));
    writeFileSync(scratch, src);
    try { execFileSync(PY, ['-m', 'py_compile', scratch], { stdio: 'pipe' }); }
    catch (e) {
      fails.push(`${rel}\n    ${String(e.stderr || e).split('\n').filter(Boolean).slice(-3)
        .join('\n    ').split(scratch).join(rel)}`);
    }
  } else if (isJson(rel)) {
    try { JSON.parse(src); }
    catch (e) { fails.push(`${rel}\n    ${e.message}`); }
  } else if (isJsonl(rel)) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try { JSON.parse(lines[i]); }
      catch (e) {
        fails.push(`${rel}:${i + 1}\n    ${e.message}\n    ${lines[i].slice(0, 120)}`);
        break;                      // one report per file is enough to stop the commit
      }
    }
    if (src.length && !src.endsWith('\n')) {
      fails.push(`${rel}\n    last line has no trailing newline — the next append lands on ` +
                 `the same line and corrupts both rows`);
    }
  }
}

if (fails.length) {
  console.error('pre-commit: staged file(s) that do not parse\n');
  for (const f of fails) console.error(`FAIL ${f}\n`);
  console.error(`These are the instruments and the record, not the renderer: a tools/ script`);
  console.error(`that does not parse is a gate that cannot fire, and a malformed row in`);
  console.error(`scores/*.jsonl breaks every one of the 17 readers at once (KNOWN_ISSUES §16).`);
  console.error(`Deliberate salvage commit of half-finished work: git commit --no-verify`);
  process.exit(1);
}
process.exit(0);
