#!/usr/bin/env node
/**
 * `tools/parsecheck.mjs`, applied to the STAGED blobs instead of the working tree.
 *
 * Driven by `.githooks/pre-commit`. See that file for why. Short version: the working
 * tree is never quiescent here (a dozen agents write it continuously, KNOWN_ISSUES §16),
 * so checking the worktree would both miss the thing being committed and fail on files
 * that some other agent happens to be halfway through saving. `git show :<path>` gives
 * exactly the bytes that are about to become a commit.
 *
 * Exit 1 blocks the commit. `git commit --no-verify` bypasses it.
 */
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

let staged = [];
try {
  staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' })
    .split('\n').map((s) => s.trim())
    .filter((f) => f.startsWith('src/') && f.endsWith('.js'));
} catch { process.exit(0); }        // never block a commit because the hook itself broke

if (!staged.length) process.exit(0);

const tmp = mkdtempSync(join(tmpdir(), 'halo-precommit-'));
let bad = 0;

for (const rel of staged) {
  let src;
  try { src = execFileSync('git', ['show', `:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { continue; }

  const scratch = join(tmp, basename(rel));
  writeFileSync(scratch, src);

  // 1. does the staged blob parse?
  //
  //    AS A MODULE. `node --check <name>.js` exits 0 on a file that does not parse whenever
  //    that file contains ESM syntax (measured on Node v26.5.0; every file under `src/` is
  //    ESM). This hook is the §20 gate, and with the old file-mode check a staged
  //    `ocean.js` with a stray backtick — the exact bug it was written for — committed
  //    clean. Same one-argument fix as `tools/parsecheck.mjs`; `tools/stagedcheck.mjs`
  //    already forces `.mjs` on its own scratch copies for this reason.
  try { execFileSync(process.execPath, ['--input-type=module', '--check', '-'], { stdio: 'pipe', input: src }); }
  catch (e) {
    const msg = String(e.stderr || e).split('\n').filter(Boolean).slice(0, 4).join('\n    ')
      .split(scratch).join(rel).replace(/\[stdin\]/g, rel);
    console.error(`FAIL ${rel}\n    ${msg}`);
    bad++;
    continue;
  }

  // 2. the backtick-in-GLSL hazard — same rule as tools/parsecheck.mjs step 2
  for (const m of src.matchAll(/\/\*\s*glsl\s*\*\/`/g)) {
    const end = src.indexOf('`', m.index + m[0].length);
    if (end < 0) continue;
    const tail = src.slice(end + 1, end + 40);
    if (/^\s*([;,)\]]|\+)/.test(tail)) continue;
    const line = src.slice(0, end).split('\n').length;
    console.error(`FAIL ${rel}:${line}  backtick inside a GLSL template — use 'single quotes' in GLSL comments`);
    console.error(`    ...${src.slice(Math.max(0, end - 55), end + 12).replace(/\n/g, '\\n')}...`);
    bad++;
  }
}

if (bad) {
  console.error(`\npre-commit: ${bad} staged src/ file(s) would not parse.`);
  console.error('A file that does not parse is skipped silently by src/modules.js and its');
  console.error('subsystem disappears from every capture (KNOWN_ISSUES §20). Fix it, or if this');
  console.error('is a deliberate salvage commit of half-finished work: git commit --no-verify');
  process.exit(1);
}
process.exit(0);
