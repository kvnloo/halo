#!/usr/bin/env node
/**
 * advisory — run advisory checks without letting a *broken* one look like a passing one.
 *
 *   node tools/advisory.mjs "node tools/citecheck.mjs --warn" "node tools/claimcheck.mjs"
 *   node tools/advisory.mjs --list                 # the default set
 *
 * WHY
 * ---
 * `.github/workflows/preflight.yml` ran its advisory checks as:
 *
 *     node tools/citecheck.mjs --warn || true
 *     node tools/claimcheck.mjs       || true
 *     node tools/provcheck.mjs        || true
 *
 * `|| true` throws away the one bit that says whether the check ran at all. A tool that
 * crashes on startup — a hand-edited `tools/refuted.json` that no longer parses, a renamed
 * input, a stray `await` — is swallowed exactly like a clean pass, and the job stays green.
 *
 * That is this project's signature failure, not a hypothetical. META_LEDGER round 5 ("the
 * check that cannot fail"): `citecheck` "had a SECOND way of never measuring anything", and
 * KNOWN_ISSUES §28's own reproduction runs `git show <bad> | grep -c`, which prints `0` for
 * a dangling SHA — "indistinguishable from a true negative". The whole loop exists because
 * a silent no-op reads like evidence. Wrapping the guardrails in `|| true` rebuilds it.
 *
 * WHAT IT DISCRIMINATES
 * ---------------------
 * The tools here share a convention, stated in the docblocks of `provcheck`, `dupcheck`,
 * `scalecheck`, `shotcheck`, `axischeck` and `contracts`:
 *
 *     0 = ok        1 = findings (advisory)        >= 2 = the tool itself broke
 *
 * So: exit 0 or 1 is a result and stays advisory. Exit >= 2, death by signal, or an
 * uncaught-exception stack trace on stderr (Node exits 1 for those, colliding with
 * "findings", so the trace is matched directly) means the check did not run — and that is
 * reported as BROKE and exits non-zero.
 *
 * Exit codes:  0 every check produced a result  •  1 at least one check BROKE
 *
 * It adds no dependency, makes no network call, and runs nothing at capture time.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);

/* Every job runs in its NATIVE exit mode — no `--warn`, no `|| true`.
 *
 * This file was first written with `citecheck --warn` and `shotcheck --warn` in the list,
 * reasoning that findings must not redden CI. They cannot: the only thing that reddens this
 * wrapper is BROKE. What `--warn` actually did was force those two tools to exit 0, which
 * collapses `findings (advisory)` into `ok` in the summary below — so a run printing ten
 * `DANGLING` citations and `FAIL shots/latest — 9 frames span 57184s; this is not one
 * capture` reported `ok  node tools/citecheck.mjs --warn` / `ok  node tools/shotcheck.mjs
 * --warn` beside them. That is the same green-line-over-a-hole this wrapper was built to
 * remove (round 10 G15, `|| true`) and that round 11's T4 removed from preflight, rebuilt
 * one layer in, inside the tool that exists to prevent it.
 *
 * Native exit codes keep all three states distinguishable: 0 ok, 1 findings, >=2 BROKE. */
const DEFAULT = [
  'node tools/citecheck.mjs',
  'node tools/claimcheck.mjs',
  // claimcheck prints tools/refuted.json's prose back to an agent as authority, and nothing
  // checked that prose: the fog entry's `refutedBy` still cites the `--skip volumetricFog`
  // experiment that this same registry refutes (skip-flag-can-disable-a-pass).
  'node tools/registrycheck.mjs',
  'node tools/provcheck.mjs',
  'node tools/shotcheck.mjs',
];

if (argv.includes('--list')) { console.log(DEFAULT.join('\n')); process.exit(0); }

const cmds = argv.filter((a) => a !== '--');
const jobs = cmds.length ? cmds : DEFAULT;

/** A Node uncaught exception / unhandled rejection always prints frames in this shape. */
const STACK = /^\s+at\s.+\((?:file:\/\/|\/|node:)/m;

let broke = 0;
const summary = [];

for (const cmd of jobs) {
  const parts = cmd.split(/\s+/).filter(Boolean);
  console.log(`\n──── ${cmd}`);
  const r = spawnSync(parts[0], parts.slice(1), {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });

  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);

  const both = `${r.stdout || ''}\n${r.stderr || ''}`;
  let verdict;
  if (r.error) verdict = `BROKE — could not run (${r.error.code || r.error.message})`;
  else if (r.signal) verdict = `BROKE — killed by ${r.signal}`;
  else if (r.status === null || r.status >= 2) verdict = `BROKE — exit ${r.status}`;
  else if (STACK.test(both)) verdict = `BROKE — uncaught exception (exit ${r.status})`;
  else verdict = r.status === 1 ? 'findings (advisory)' : 'ok';

  if (verdict.startsWith('BROKE')) broke++;
  summary.push(`${verdict.startsWith('BROKE') ? 'BROKE   ' : verdict === 'ok' ? 'ok      ' : 'findings'}  ${cmd}${verdict.startsWith('BROKE') ? `  — ${verdict.slice(8)}` : ''}`);
}

console.log('\n──── advisory summary');
for (const s of summary) console.log('  ' + s);

if (broke) {
  console.error(
    `\nadvisory: ${broke} check(s) did not run to completion.\n` +
    `A guardrail that crashes is not a guardrail that passed — under \`|| true\` these two\n` +
    `are the same colour, which is the failure this wrapper exists to separate. Fix the\n` +
    `tool (or its inputs); findings themselves never turn this red.\n`);
  process.exit(1);
}
// "ok" here means every check RAN, which is the only thing this wrapper asserts. Say the
// findings count out loud too, so the last line of the CI step is never a bare green claim
// printed over a check that just failed in advisory mode.
const withFindings = summary.filter((s) => s.startsWith('findings')).length;
console.log(`\nadvisory ok — ${jobs.length} check(s) produced a result`
  + (withFindings ? `; ${withFindings} reported FINDINGS (advisory, read above)` : ''));
process.exit(0);
