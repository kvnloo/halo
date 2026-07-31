#!/usr/bin/env node
/**
 * reportgate — the report-side rules, at the one moment every report passes a machine.
 *
 *   node tools/reportgate.mjs           # the reports/*.md in THIS commit (called by .githooks/pre-commit)
 *   node tools/reportgate.mjs --all     # every report on disk
 *   node tools/reportgate.mjs --json
 *
 * ALWAYS EXITS 0. It cannot block a commit, and it must not: a wave's reports landing on
 * disk is more valuable than any header, and `2651d8c` is this repo's own precedent for
 * committing deliberately half-finished work.
 *
 * WHY
 * ---
 * The pre-measurement rules were prose in a long brief, adherence 9 of 26. They were
 * bundled into `tools/preflight.mjs` and wired to npm `pre` hooks, and they became
 * automatic. The report-side rules (R7 provenance, R9 `NEEDS:` routing) got their command
 * in round 8 — `tools/postflight.mjs` — but no trigger: nothing runs it, and by the
 * project's own diagnosis ("the failure mode is not 'the check was wrong', it is 'nobody
 * ran it'") that predicts adherence 0 all over again. Measured today: R7 present in
 * **0 of 28** reports, `NEEDS:` headings in **0 of 28** against 26 cross-file handoffs
 * written in prose in 18 reports.
 *
 * An agent finishing a subsystem may or may not remember `postflight`. But every report
 * this project keeps passes through exactly one machine gate: the orchestrator's commit —
 * `tools/checkpoint.md`, "the orchestrator should commit after every wave, and on any
 * signal that a wave is dying. git is the real checkpoint." `.githooks/pre-commit` was
 * already there, inspecting staged `src/*.js` and (as of this wave) staged instruments.
 * This adds the third staged artefact class — the reports — and it is the first automatic
 * trigger the report-side rules have ever had.
 *
 * It re-uses `reportlint` and `needscheck` rather than re-implementing their regexes, so
 * there is exactly one definition of each rule and this cannot drift from it. ~120 ms.
 *
 * Silence it for one commit: `HALO_NO_REPORT_GATE=1 git commit …`. Remove it: delete the
 * last two lines of `.githooks/pre-commit`. Nothing else invokes it.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const all = argv.includes('--all');
const asJson = argv.includes('--json');
const SKIP = new Set(['reports/README.md', 'reports/blind.md']);

const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const json = (args) => { try { return JSON.parse(run(args).stdout); } catch { return null; } };

try {
  let targets = [];
  if (all) {
    targets = (json(['tools/reportlint.mjs', '--json'])?.rows || []).map((r) => r.file);
  } else {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', 'reports'],
      { cwd: ROOT, encoding: 'utf8' });
    targets = out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.md'));
  }
  targets = targets.filter((f) => !SKIP.has(f));
  if (!targets.length) { if (asJson) console.log(JSON.stringify({ ok: true, targets: [] })); process.exit(0); }

  const lint = json(['tools/reportlint.mjs', '--json']);
  const needs = json(['tools/needscheck.mjs', '--json']);

  const findings = [];
  for (const f of targets) {
    const row = (lint?.rows || []).find((r) => r.file === f);
    if (row && !row.hasBlock) findings.push({ file: f, rule: 'R7', detail: `no provenance block (missing ${row.missing.join(', ')}) — node tools/postflight.mjs --provenance prints it filled in` });
    const prose = (needs?.prose || []).filter((p) => p.report === f);
    const routed = (needs?.needs || []).some((p) => p.report === f);
    if (prose.length && !routed) findings.push({ file: f, rule: 'R9', detail: `${prose.length} cross-file handoff(s) in prose, no NEEDS: heading (line ${prose.map((p) => p.line).slice(0, 4).join(', ')}) — the orchestrator cannot enumerate them` });
  }

  if (asJson) { console.log(JSON.stringify({ ok: findings.length === 0, targets, findings }, null, 2)); process.exit(0); }
  if (findings.length) {
    // Capped. A gate whose output nobody reads is the failure this layer exists to stop
    // (round 4: pixelcheck's loudest line was a false positive, "and that is how a gate
    // gets ignored"). Twelve lines is a glance; forty-six is wallpaper.
    const CAP = 12;
    console.log(`\n[reportgate] ${findings.length} advisory item(s) in ${targets.length} ${all ? '' : 'staged '}report(s) — ${all ? 'advisory only' : 'COMMITTING ANYWAY'}:`);
    for (const x of findings.slice(0, CAP)) console.log(`[reportgate]   ${x.rule} ${x.file}: ${x.detail}`);
    if (findings.length > CAP) console.log(`[reportgate]   … ${findings.length - CAP} more — node tools/reportgate.mjs --all`);
    console.log(`[reportgate] Full check: node tools/postflight.mjs <report>   [HALO_NO_REPORT_GATE=1 to silence]\n`);
  }
} catch { /* an advisory gate that throws must still let the commit through */ }

process.exit(0);
