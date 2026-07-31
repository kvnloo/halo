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
  //
  //    2a. AND: any backtick on a COMMENT line inside the template is a stray, full stop.
  //    The tail test above has an exemption list (`; , ) ] +`) and an even number of strays
  //    re-closes the template, so `node --check` passes too. Both holes are live and they
  //    intersect: a comment quoting a term that begins with one of those characters —
  //    e.g. this project's own house phrase, "carried a `+ 0.5 * uJitter` fudge"
  //    (src/render/passes/taa.js:67) — is read as a legitimate `+ CONCAT` end, the loop
  //    moves to the next template, and the REST OF THIS ONE IS NEVER SCANNED. The file
  //    parses, the module throws `uJitter is not defined` on import, and the subsystem
  //    vanishes from the frame exactly as in §20. reports/ocean_waveH.md §1a is the
  //    fifth and sixth occurrence of this bug ("it happened to me too, twice ... the
  //    second time it got past `node --check`") and asks for precisely this scan:
  //    "two guards, both cheap, neither of which has an owner in tools/".
  //
  //    Zero false positives by construction: nothing legitimate puts a backtick on a
  //    comment line inside a shader. Measured over all 137 `/* glsl */` templates in
  //    src/ on the day this landed: 0.
  const src = readFileSync(abs, 'utf8');
  const lineAt = (i) => {
    const a = src.lastIndexOf('\n', i) + 1;
    let b = src.indexOf('\n', i); if (b < 0) b = src.length;
    return { text: src.slice(a, b), col: i - a };
  };
  const onCommentLine = (i) => {
    const { text, col } = lineAt(i);
    const t = text.trimStart();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return true;
    const before = text.slice(0, col);
    return before.includes('//') || before.includes('/*');
  };
  for (const m of src.matchAll(/\/\*\s*glsl\s*\*\/`/g)) {
    let p = m.index + m[0].length;
    let lastLine = -1;
    for (;;) {
      const end = src.indexOf('`', p);
      if (end < 0) break;
      const line = src.slice(0, end).split('\n').length;
      const ctx = src.slice(Math.max(0, end - 55), end + 12).replace(/\n/g, '\\n');
      if (onCommentLine(end)) {                          // 2a — a stray, whatever follows it
        if (line !== lastLine) {                         // one report per line, not per backtick
          console.error(`WARN ${rel}:${line}  backtick in a comment inside a GLSL template — use 'quotes' instead`);
          console.error(`    ...${ctx}...`);
          bad++; lastLine = line;
        }
        p = end + 1;
        continue;                                        // keep scanning THIS template
      }
      const tail = src.slice(end + 1, end + 40);
      if (/^\s*([;,)\]]|\+)/.test(tail)) break;          // legitimate end, or concatenation
      console.error(`WARN ${rel}:${line}  backtick inside a GLSL template — use 'quotes' instead`);
      console.error(`    ...${ctx}...`);
      bad++;
      break;
    }
  }
}

if (bad === 0) { if (!quiet) console.log(`ok — ${files.length} files parse, no GLSL template hazards`); }
else console.error(`\n${bad} problem(s) across ${files.length} files`);

process.exit(bad === 0 ? 0 : 1);
