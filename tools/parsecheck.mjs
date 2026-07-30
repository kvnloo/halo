#!/usr/bin/env node
/**
 * Parse gate over src/**.js, plus the one hazard that keeps getting past `node --check`
 * reviewers: a backtick inside a /* glsl *\/` ... ` template literal.
 *
 * This bug has now shipped THREE times — noise.js, ocean.js, rocks.js. It is not
 * carelessness, it is structural: agents write careful prose comments inside GLSL template
 * literals and reach for backticks to quote code, exactly as they would in markdown. The
 * backtick ends the template. The file stops parsing, `src/modules.js` skips the module,
 * and the subsystem vanishes from every capture *silently* — no error in the frame, just a
 * scene with no ocean in it. Agents then measure that scene and report the numbers.
 *
 * That silence is the real cost. Run this before any measurement you intend to believe.
 *
 *   node tools/parsecheck.mjs          # exits non-zero if anything is broken
 *   node tools/parsecheck.mjs --quiet  # only print failures
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const quiet = process.argv.includes('--quiet');
const files = globSync('src/**/*.js', { cwd: ROOT }).sort();

let bad = 0;

for (const rel of files) {
  const abs = resolve(ROOT, rel);

  // 1. does it actually parse?
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  } catch (e) {
    const msg = String(e.stderr || e).split('\n').filter(Boolean).slice(0, 4).join('\n    ');
    console.error(`FAIL ${rel}\n    ${msg}`);
    bad++;
    continue;
  }

  // 2. the backtick-in-GLSL hazard. A `/* glsl */` template that ends somewhere other than
  //    a statement boundary or a `+ CONCAT` almost certainly ended early, on a comment quote.
  const src = readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/\/\*\s*glsl\s*\*\/`/g)) {
    const end = src.indexOf('`', m.index + m[0].length);
    if (end < 0) continue;
    const tail = src.slice(end + 1, end + 40);
    if (/^\s*([;,)\]]|\+)/.test(tail)) continue;         // legitimate end, or concatenation
    const line = src.slice(0, end).split('\n').length;
    const ctx = src.slice(Math.max(0, end - 55), end + 12).replace(/\n/g, '\\n');
    console.error(`WARN ${rel}:${line}  backtick inside a GLSL template — use 'quotes' instead`);
    console.error(`    ...${ctx}...`);
    bad++;
  }
}

if (bad === 0) { if (!quiet) console.log(`ok — ${files.length} files parse, no GLSL template hazards`); }
else console.error(`\n${bad} problem(s) across ${files.length} files`);

process.exit(bad === 0 ? 0 : 1);
