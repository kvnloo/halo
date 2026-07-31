#!/usr/bin/env node
/**
 * gatecheck — does a refusal gate in a consumer script check a field the producer script
 * actually emits?
 *
 *   node tools/gatecheck.mjs            # check the real tools/blind.mjs against the real
 *                                        # tools/capture.mjs stdout contract
 *   node tools/gatecheck.mjs --json
 *   node tools/gatecheck.mjs --selftest # prove the detector itself works, entirely under
 *                                        # /tmp — never reads or writes the real blind.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * `tools/blind.mjs` is this project's own words "the only instrument in this project that
 * has ever told the truth" — the human blind A/B. Its `--capture` mode is supposed to
 * refuse to build a blind sheet when the scene it just captured is missing a subsystem:
 *
 *     const info = JSON.parse(cap.stdout);
 *     if (info.failedModules?.length) {
 *       console.error('REFUSING: capture reported failedModules ...');
 *       process.exit(2);
 *     }
 *
 * `tools/capture.mjs` never puts `failedModules` at the top level. Its real stdout
 * contract (verified against the source, both the daemon and standalone code paths) is
 * `{ ok, via, files, stats, integrity, warnings, criticalWarnings }`, and the three real
 * integrity channels — `missing`, `failedModules`, `missingPasses` — live under
 * `integrity`. So `info.failedModules` is always `undefined`, `undefined?.length` is
 * always `undefined` (falsy), and the branch has never fired. The surrounding
 * `catch { /* capture printed something else; the parsecheck above is the real guard * / }`
 * documents an assumption that is now the only guard left standing — this is the T1/§28
 * shape (a check with no instrument behind it) inside the project's own acceptance gate.
 *
 * `tools/blind.mjs` is owned by a concurrent wave and is on this round's do-not-touch
 * list, so the two one-line fixes this calls for cannot be applied here (see the FIX note
 * in the finding this tool was built from). This is the recommendation made checkable
 * instead: a standing, read-only detector that (a) states the live finding on every run
 * against the real files, so it does not go quiet the moment someone forgets it, and
 * (b) will report clean automatically the moment blind.mjs's owner applies the fix, with
 * no further action from anyone.
 *
 * It checks two things, both static, both read-only, no GPU, no capture, ~20 ms:
 *
 *   1. UNREACHABLE GATE — every `<parsedVar>.<field>` access blind.mjs performs on the
 *      JSON.parse'd capture stdout is checked against capture.mjs's actual top-level
 *      keys. A field that is real but only exists NESTED (e.g. under `integrity`) is
 *      flagged by name, because that is exactly this bug's signature: a condition that
 *      can never be true, sitting where a real refusal used to be.
 *   2. PARTIAL TALLY — `--score` counts only the poses a judge typed (`n++` inside the
 *      tally loop) and is flagged if the file never compares that count against
 *      `Object.keys(key.pairs).length`, the total the judge was actually shown. A judge
 *      who submits 5 of 9 picks currently gets a clean `n:5` row with nothing marking it
 *      partial.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not run tools/blind.mjs, does not edit it, and does not invoke a capture. It
 * reads two source files as text and reasons about the object-literal shapes they
 * construct. That is deliberately shallow — a parser would need to track the whole
 * project's field vocabulary and would start inventing findings, which is the failure
 * mode this repo's other static checkers (apicheck.mjs, knobcheck.mjs) were written to
 * avoid.
 *
 * Exit: 0 clean (or the file(s) could not be checked)
 *       1 a finding is present (advisory — this never blocks a wave; see preflight.mjs)
 *       2 gatecheck itself broke, or --selftest's own detector logic failed to
 *         distinguish the broken shape from the fixed one
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const asJson = argv.includes('--json');
const selftest = argv.includes('--selftest');

/* ---------------------------------------------------------------- tiny brace/paren-safe
 * splitter. The object literals this file inspects contain `||`, ternaries and function
 * calls but (in the specific spots gatecheck looks at) no nested `{ }`, so top-level comma
 * splitting only needs to respect `(` `)` and `[` `]` depth. */
function splitTopLevel(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function objectLiteralKeys(body) {
  const keys = [];
  for (const raw of splitTopLevel(body)) {
    const tok = raw.trim();
    if (!tok) continue;
    const colon = tok.indexOf(':');
    const k = (colon === -1 ? tok : tok.slice(0, colon)).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k);
  }
  return keys;
}

/* ---------------------------------------------------- capture.mjs's real stdout contract
 * Reads BOTH `console.log(JSON.stringify({ ok: ..., ... }, null, 2))` call sites (daemon
 * path and standalone path) and unions their keys, so a future path-specific drift between
 * the two is absorbed rather than flagged as a false gap. */
function extractTopLevelShape(capSrc) {
  const keys = new Set();
  let sites = 0;
  for (const m of capSrc.matchAll(/console\.log\(JSON\.stringify\(\{([^{}]*)\}\s*,\s*null\s*,\s*2\)\)/gs)) {
    if (!/\bok\s*:/.test(m[1])) continue; // only the integrity-gate stdout, not other JSON.stringify calls
    sites++;
    for (const k of objectLiteralKeys(m[1])) keys.add(k);
  }
  return sites ? keys : null;
}

/* --------------------------------------------------- the nested `integrity` sub-shape
 * `integrityReport()`'s return object literal is where `missing` / `failedModules` /
 * `missingPasses` actually live. */
function extractIntegrityKeys(capSrc) {
  const fn = /function\s+integrityReport\s*\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(capSrc);
  if (!fn) return null;
  const ret = /return\s*\{([\s\S]*?)\};/.exec(fn[0]);
  if (!ret) return null;
  return new Set(objectLiteralKeys(ret[1]));
}

/* ------------------------------------------------------------------------ check 1: gate */
function checkUnreachableGate(capSrc, blindSrc) {
  const topKeys = extractTopLevelShape(capSrc);
  if (!topKeys || !topKeys.size)
    return { ran: false, reason: 'could not find a `console.log(JSON.stringify({ ok: ... }, null, 2))` call in the capture source — its stdout shape may have changed; update gatecheck.mjs' };

  const integrityKeys = extractIntegrityKeys(capSrc); // may be null; degrade gracefully

  const varMatch = /const\s+(\w+)\s*=\s*JSON\.parse\(\s*cap\.stdout\s*\)/.exec(blindSrc);
  if (!varMatch)
    return { ran: false, reason: 'no `const X = JSON.parse(cap.stdout)` in the blind source — nothing to check' };
  const varName = varMatch[1];

  // Look only in the block right after the parse (up to the enclosing try/catch's rough
  // extent) so an unrelated later use of a variable with the same name is not mistaken
  // for a refusal-gate field access.
  const window = blindSrc.slice(varMatch.index, varMatch.index + 800);
  const accessRe = new RegExp(`\\b${varName}\\??\\.(\\w+)`, 'g');
  const seen = new Set();
  const findings = [];
  for (const m of window.matchAll(accessRe)) {
    const field = m[1];
    if (seen.has(field)) continue;
    seen.add(field);
    if (topKeys.has(field)) continue; // real top-level field — fine
    const nestedUnder = integrityKeys && integrityKeys.has(field) ? 'integrity' : null;
    findings.push({ field, varName, nestedUnder });
  }
  return { ran: true, topKeys: [...topKeys], integrityKeys: integrityKeys ? [...integrityKeys] : null, findings };
}

/* --------------------------------------------------------------- check 2: partial tally */
function checkPartialTally(blindSrc) {
  const hasLoop = /for\s*\(\s*const\s*\[\s*pose\s*,\s*pick\s*\]\s*of\s*Object\.entries\(\s*picks\s*\)\s*\)/.test(blindSrc);
  if (!hasLoop)
    return { ran: false, reason: 'no `for (const [pose, pick] of Object.entries(picks))` tally loop found — the --score shape may have changed; update gatecheck.mjs' };
  const guarded = /Object\.keys\(\s*key\.pairs\s*\)\.length/.test(blindSrc);
  return { ran: true, guarded };
}

function runChecks(capSrc, blindSrc) {
  return { gate: checkUnreachableGate(capSrc, blindSrc), tally: checkPartialTally(blindSrc) };
}

function findingsOf(result) {
  const out = [];
  if (result.gate.ran) {
    for (const f of result.gate.findings) {
      out.push(f.nestedUnder
        ? `UNREACHABLE GATE: reads \`${f.varName}.${f.field}\` but capture.mjs only puts "${f.field}" ` +
          `under \`${f.varName}.${f.nestedUnder}.${f.field}\` — this condition can never be true.`
        : `UNKNOWN FIELD: reads \`${f.varName}.${f.field}\`, which is not in capture.mjs's stdout shape ` +
          `at all (top-level or nested under integrity) — verify this is intentional.`);
    }
  }
  if (result.tally.ran && !result.tally.guarded) {
    out.push('PARTIAL TALLY: the --score tally loop never compares its count `n` against ' +
      '`Object.keys(key.pairs).length` — a judge who submits fewer picks than pairs shown ' +
      'gets a clean row with nothing marking it partial.');
  }
  return out;
}

/* ---------------------------------------------------------------------------- --selftest
 * Proves the detector actually distinguishes the broken shape from the fixed one, entirely
 * under /tmp. Never reads or writes the repository's own tools/blind.mjs beyond a read to
 * seed the scratch copies (read-only on the real file, matching every other check here). */
function runSelftest() {
  const capPath = join(ROOT, 'tools/capture.mjs');
  const blindPath = join(ROOT, 'tools/blind.mjs');
  if (!existsSync(capPath) || !existsSync(blindPath)) {
    console.error('gatecheck --selftest: tools/capture.mjs or tools/blind.mjs not found — cannot seed fixtures');
    process.exit(2);
  }
  const capSrc = readFileSync(capPath, 'utf8');
  const brokenBlind = readFileSync(blindPath, 'utf8');

  // Apply the exact two-part fix the finding prescribes, on a STRING in memory. Nothing
  // under the repo is touched.
  let fixedBlind = brokenBlind.replace(
    /if \(info\.failedModules\?\.length\) \{\s*\n\s*console\.error\('REFUSING: capture reported failedModules ' \+ JSON\.stringify\(info\.failedModules\)\s*\n\s*\+ ' — a blind test with a missing subsystem is not a fair fight\.'\);\s*\n\s*process\.exit\(2\);\s*\n\s*\}/,
    `const bad = [...(info.integrity?.missing || []), ...(info.integrity?.failedModules || []), ...(info.integrity?.missingPasses || [])];\n` +
    `    if (bad.length) {\n` +
    `      console.error('REFUSING: capture reported ' + JSON.stringify(bad)\n` +
    `        + ' — a blind test with a missing subsystem is not a fair fight.');\n` +
    `      process.exit(2);\n` +
    `    }`
  );
  fixedBlind = fixedBlind.replace(
    /(const rate = n \? \+\(ours \/ n\)\.toFixed\(3\) : 0;)/,
    `const totalPairs = Object.keys(key.pairs).length;\n` +
    `  if (n < totalPairs) console.error(\`PARTIAL: \${n} of \${totalPairs} pairs judged\`);\n` +
    `  $1`
  );
  const patchedGate = fixedBlind !== brokenBlind && !fixedBlind.includes('info.failedModules?.length');
  const patchedTally = fixedBlind.includes('Object.keys(key.pairs).length');

  const scratch = mkdtempSync(join(tmpdir(), 'halo-gatecheck-'));
  try {
    writeFileSync(join(scratch, 'capture.mjs'), capSrc);
    writeFileSync(join(scratch, 'blind-broken.mjs'), brokenBlind);
    writeFileSync(join(scratch, 'blind-fixed.mjs'), fixedBlind);

    const brokenResult = runChecks(capSrc, brokenBlind);
    const fixedResult = runChecks(capSrc, fixedBlind);
    const brokenFindings = findingsOf(brokenResult);
    const fixedFindings = findingsOf(fixedResult);

    const brokenCaughtGate = brokenResult.gate.ran && brokenResult.gate.findings.some((f) => f.field === 'failedModules' && f.nestedUnder === 'integrity');
    const brokenCaughtTally = brokenResult.tally.ran && !brokenResult.tally.guarded;
    const fixApplied = patchedGate && patchedTally;
    const fixedClean = fixedFindings.length === 0;

    const ok = brokenCaughtGate && brokenCaughtTally && fixApplied && fixedClean;

    const report = {
      selftest: true,
      scratchDir: scratch,
      brokenSourceFrom: 'tools/blind.mjs (read-only, unmodified)',
      broken: { findings: brokenFindings, caughtGate: brokenCaughtGate, caughtTally: brokenCaughtTally },
      fixApplied: { gate: patchedGate, tally: patchedTally },
      fixed: { findings: fixedFindings, clean: fixedClean },
      ok,
    };
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('gatecheck --selftest');
      console.log(`  scratch dir: ${scratch}  (left on disk for inspection; not under the repo)`);
      console.log(`  broken (current tools/blind.mjs, unmodified, read-only):`);
      for (const f of brokenFindings) console.log(`    - ${f}`);
      console.log(`    caught unreachable gate: ${brokenCaughtGate}   caught missing partial guard: ${brokenCaughtTally}`);
      console.log(`  fix applied to scratch copy in memory: gate=${patchedGate} tally=${patchedTally}`);
      console.log(`  fixed scratch copy findings: ${fixedFindings.length ? fixedFindings.join(' | ') : '(none)'}`);
      console.log(`\nSELFTEST ${ok ? 'PASSED' : 'FAILED'} — detector ${ok ? 'correctly distinguishes broken from fixed' : 'did NOT behave as expected'}`);
    }
    process.exit(ok ? 0 : 2);
  } finally {
    // Scratch is left on disk deliberately for inspection when run interactively; a CI
    // run would want it gone, so clean up unless a human is clearly reading the console.
    if (asJson) rmSync(scratch, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------------------------- main */
if (selftest) {
  runSelftest();
} else {
  const capPath = resolve(ROOT, arg('capture', 'tools/capture.mjs'));
  const blindPath = resolve(ROOT, arg('blind', 'tools/blind.mjs'));
  if (!existsSync(capPath) || !existsSync(blindPath)) {
    console.error(`gatecheck: could not find ${!existsSync(capPath) ? capPath : blindPath}`);
    process.exit(2);
  }
  try {
    const capSrc = readFileSync(capPath, 'utf8');
    const blindSrc = readFileSync(blindPath, 'utf8');
    const result = runChecks(capSrc, blindSrc);
    const findings = findingsOf(result);
    if (asJson) {
      console.log(JSON.stringify({ ok: findings.length === 0, findings, detail: result }, null, 2));
    } else if (findings.length) {
      console.error(`gatecheck: ${findings.length} finding(s) in ${arg('blind', 'tools/blind.mjs')}:\n`);
      for (const f of findings) console.error('  ' + f);
      console.error('\nAdvisory: this never blocks a wave. tools/blind.mjs is owned by a concurrent wave; see');
      console.error('the finding this tool was built from for the exact one-line fixes.');
    } else {
      console.log('gatecheck ok — no unreachable refusal gates or unguarded partial tallies detected'
        + (!result.gate.ran ? ` (gate check did not run: ${result.gate.reason})` : '')
        + (!result.tally.ran ? ` (tally check did not run: ${result.tally.reason})` : ''));
    }
    process.exit(findings.length ? 1 : 0);
  } catch (e) {
    console.error('gatecheck BROKE: ' + (e?.stack || e));
    process.exit(2);
  }
}
