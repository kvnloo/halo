#!/usr/bin/env node
/**
 * ONE command every agent runs before it finishes — the mirror of `tools/preflight.mjs`.
 *
 *   node tools/postflight.mjs                      # auto-detects your report
 *   node tools/postflight.mjs reports/rocks.md
 *   node tools/postflight.mjs --provenance         # just print the block, ready to paste
 *   node tools/postflight.mjs --strict             # exit 1 if the report-side rules fail
 *   node tools/postflight.mjs --json
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `preflight` worked. The pre-measurement rules used to be prose in a long brief and were
 * followed by 9 of 26 agents; they were bundled into one command and became automatic. The
 * brief says so itself, about R3: "Not carelessness: it was one more line of prose in a long
 * brief with nothing enforcing it. It is a gate now."
 *
 * The *report-side* rules never got that treatment, and their adherence is the number you
 * would predict:
 *
 *   R7  provenance block            0 of 28 reports  (`node tools/reportlint.mjs`)
 *   R9  `NEEDS: <path>` handoff     0 of 28 reports, against 26 handoffs written in prose
 *                                   (`node tools/needscheck.mjs`)
 *   blind gate cited                0 of 28 subsystem reports (`node tools/tells.mjs`)
 *
 * Every one of those checks already existed as its own command, and an agent finishing a
 * subsystem would have to remember five of them: reportlint, citecheck, claimcheck,
 * refstamp, needscheck. The failure mode of this project is not "the check was wrong", it
 * is "nobody ran it" — so this is one command, like preflight.
 *
 * It also *writes the provenance block for you* from the `_capture.json` your capture
 * already produced. R7 has 0% adherence partly because it asks an agent to reconstruct five
 * facts by hand at the end of a session; the machine already knows all five.
 *
 * Advisory by default: it never fails a build, never edits a report, never captures.
 * Exit codes: 0 ok/advisory • 1 --strict and something failed • 2 postflight itself broke
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const provOnly = argv.includes('--provenance');
const flagVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const results = [];
const add = (name, ok, detail, hard = false) => { results.push({ name, ok, hard, detail }); };

/* ---------------------------------------------------------------- which report is yours */
let report = flagVal('--report') || argv.find((a) => a.endsWith('.md') && !a.startsWith('-'));
if (!report) {
  const dir = join(ROOT, 'reports');
  const cands = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.md') && !['README.md', 'blind.md'].includes(f))
        .map((f) => ({ f: 'reports/' + f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : [];
  report = cands.length ? cands[0].f : null;
}
const reportText = report && existsSync(join(ROOT, report)) ? readFileSync(join(ROOT, report), 'utf8') : '';
const key = report ? report.replace(/^reports\//, '').replace(/\.md$/, '').replace(/_?wave[A-Z]$/i, '') : '';

/* ------------------------------------------------- the provenance block, filled in for you
 * Sources, in order: --capture <path>, the newest `_capture.json` under shots/, then the
 * last line of scores/provenance.jsonl (tracked, so it survives a wiped shots/). */
function latestCapture() {
  const explicit = flagVal('--capture');
  if (explicit && existsSync(resolve(ROOT, explicit))) {
    return { rec: JSON.parse(readFileSync(resolve(ROOT, explicit), 'utf8')), from: explicit };
  }
  let best = null;
  const shots = join(ROOT, 'shots');
  if (existsSync(shots)) {
    for (const d of readdirSync(shots)) {
      const p = join(shots, d, '_capture.json');
      try {
        const t = statSync(p).mtimeMs;
        if (!best || t > best.t) best = { t, p };
      } catch { }
    }
  }
  if (best) {
    try { return { rec: JSON.parse(readFileSync(best.p, 'utf8')), from: 'shots/' + best.p.slice(shots.length + 1) }; }
    catch { }
  }
  const jl = join(ROOT, 'scores/provenance.jsonl');
  if (existsSync(jl)) {
    const lines = readFileSync(jl, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const rec = JSON.parse(lines[i]); return { rec, from: `scores/provenance.jsonl:${i + 1}` }; } catch { }
    }
  }
  return null;
}

function provenanceBlock() {
  const cap = latestCapture();
  const pre = run(['tools/preflight.mjs', '--json']);
  let pf = null;
  try { pf = JSON.parse(pre.stdout); } catch { }
  const quiet = pf?.checks?.find((c) => c.name === 'src-quiescent');
  const rec = cap?.rec;
  const poses = rec?.files?.length
    ? [...new Set(rec.files.map((f) => f.split('/').pop().replace(/\.png$/, '').replace(/_\d{4}$/, '')))].join(', ')
    : '(name the pose(s) you measured)';
  const owner = rec?.git?.srcEditedWithin10min?.[0] || `src/…/${key || 'yourfile'}.js`;
  const capPath = rec ? (cap.from.startsWith('scores/') ? `${rec.outdir || '?'}/_capture.json` : cap.from) : '(path to your _capture.json)';
  return [
    '<!-- provenance',
    `owner:         ${owner}`,
    `pose(s):       ${poses}`,
    `settle:        ${rec?.opts?.settle ?? '(the --settle you used; §26 — never compare across values)'}`,
    `preflight:     ${pf ? (pf.ok ? 'pass' : 'FAIL — do not publish these numbers') : '(run node tools/preflight.mjs)'}`,
    `shadercheck:   (run node tools/shadercheck.mjs — preflight is CPU-only and cannot see a link failure)`,
    `src-quiescent: ${quiet ? (quiet.ok ? 'yes' : 'NO — ' + quiet.detail) : '(unknown)'}`,
    `capture:       ${capPath}`,
    `-->`,
    rec ? `<!-- filled from ${cap.from} at ${new Date().toISOString()} -->` : '',
  ].filter(Boolean).join('\n');
}

if (provOnly) { console.log(provenanceBlock()); process.exit(0); }

if (!report) {
  console.error('postflight — no reports/*.md found. R1: write your report FIRST, then measure.');
  process.exit(strict ? 1 : 0);
}

/* 1 ------------------------------------------------------------------ R7 provenance block */
{
  const head = reportText.slice(0, 4000);
  const has = /<!--\s*provenance[\s\S]*?-->/i.test(head);
  add('R7 provenance block', has, has ? 'present' :
    `${report} carries numbers with no provenance header — see the filled-in block printed below`);
}

/* 2 -------------------------------------------------------- R9b MEASURED / INFERRED tags */
{
  const m = (reportText.match(/\bMEASURED\b/g) || []).length;
  const i = (reportText.match(/\bINFERRED\b/g) || []).length;
  add('R9b MEASURED/INFERRED', m > 0, m > 0 ? `${m} MEASURED, ${i} INFERRED`
    : 'no load-bearing sentence is marked. The next agent cannot tell your digits from your reasoning');
}

/* 3 ------------------------------------------------ R8 did you look at one whole frame */
{
  const looked = /whole frame|full size|full-size|entire frame|opened .{0,30}with the Read tool/i.test(reportText);
  add('R8 whole frame', looked, looked ? 'the report says so'
    : 'no sentence says you opened one entire frame. blind.md T10: a whole building was missing and 26 ROI-measuring reports did not notice');
}

/* 4 ------------------------------------------------- the acceptance gate names your file */
{
  const t = run(['tools/tells.mjs', key || 'zzz', '--json']);
  let tells = [];
  try { tells = JSON.parse(t.stdout).tells || []; } catch { }
  const uncited = tells.filter((x) => !new RegExp(`\\b${x.id}\\b`).test(reportText));
  add('blind gate (tools/tells.mjs)', tells.length === 0 || uncited.length === 0,
    tells.length === 0 ? 'no tell names this subsystem'
      : uncited.length === 0 ? `cites ${tells.map((x) => x.id).join(' ')}`
      : `reports/blind.md decides the project and names your file: ${uncited.map((x) => `${x.id} (decided ${x.decided}/9)`).join(', ')} — not cited in ${report}. Run: node tools/tells.mjs ${key}`);
}

/* 5 ------------------------------------------------------------- R9 cross-file handoffs */
{
  const n = run(['tools/needscheck.mjs', '--json']);
  let out = null;
  try { out = JSON.parse(n.stdout); } catch { }
  const mine = (out?.prose || []).filter((p) => p.report === report);
  const routed = (out?.needs || []).some((p) => p.report === report);
  add('R9 NEEDS: routing', mine.length === 0 || routed,
    mine.length === 0 ? 'no cross-file handoff in this report'
      : routed ? `${mine.length} handoff line(s), NEEDS: heading present`
      : `${mine.length} line(s) hand work to another file's owner with no NEEDS: heading (lines ${mine.map((p) => p.line).join(', ')}) — the orchestrator cannot enumerate them`);
}

/* 6 ------------------------------------------------- shader errors in your own capture
 * The fourth integrity channel. G1 made a module that fails to LOAD fatal; a module that
 * loads, inits, and whose shaders then fail to LINK is invisible to it. That is not
 * hypothetical: `reports/terrain.md` §1 — `patch` is a reserved word in ESSL 3.00, so all
 * three terrain materials failed to link and the "sand" in the showcase contact sheet was
 * the clear colour. That frame was captured, scored, committed (`65da9df`) and reviewed
 * before anyone read the browser console. KNOWN_ISSUES §19: "capture warnings do get
 * swallowed into `warnings[]`" — and no caller prints them. `score.mjs:104` runs capture
 * with `stdio: ['ignore','pipe','inherit']` and JSON.parses stdout into a variable, so
 * during a scored run those lines are literally read into memory and never shown.
 *
 * R3 tells the agent to run `tools/shadercheck.mjs` instead. It is named in 0 of 30
 * reports. The lines are already on disk in `_capture.json` / `scores/provenance.jsonl`
 * (G2). This just reads them. It does not change what capture does. */
{
  const cap = latestCapture();
  const w = cap?.rec?.warnings || [];
  const SHADER = /shader error|VALIDATE_STATUS|compil(e|ation) (error|failed)|ERROR:\s*\d+:\d+|reserved word|link(ing)? (error|failed)|WebGLProgram/i;
  const hits = w.filter((l) => SHADER.test(String(l)));
  add('shader errors in capture', hits.length === 0,
    hits.length === 0
      ? (cap ? `none in ${cap.from} (${w.length} warning line(s) total)` : 'no capture record found')
      : `${hits.length} GLSL error line(s) in ${cap.from} — a material that fails to LINK passes every integrity gate and renders the clear colour: ${hits.slice(0, 2).map((l) => String(l).slice(0, 110)).join(' | ')}`);
}

/* 7 ------------------------------------------- the written record: citations and claims */
{
  const c = run(['tools/citecheck.mjs']);
  const all = ((c.stdout || '') + (c.stderr || '')).split('\n');
  const summary = all.filter((l) => /^citecheck —/.test(l)).pop() || `exit ${c.status}`;
  // Scope to YOUR report. The repo-wide count is mostly history that was rewritten at
  // a9c1e8a/b92decf and is nobody's to fix; a dangling cite in your own file is yours.
  const mine = all.filter((l) => l.includes(report));
  add('citecheck (this report)', mine.length === 0,
    mine.length === 0 ? `no dead citation in ${report} — repo-wide: ${summary.replace(/^citecheck — /, '')}`
      : `${mine.length} citation(s) in ${report} do not resolve; a command that cannot fail has verified nothing (R9b): ${mine.slice(0, 2).map((l) => l.trim().slice(0, 100)).join(' | ')}`);
}
{
  const c = run(['tools/claimcheck.mjs']);
  const mine = ((c.stdout || '') + (c.stderr || '')).split('\n').filter((l) => l.includes(report));
  add('claimcheck', mine.length === 0, mine.length === 0 ? 'this report repeats no refuted claim'
    : `${mine.length} line(s) in ${report} repeat a claim in tools/refuted.json: ${mine.slice(0, 3).map((l) => l.trim().split(/\s+/)[0]).join(' ')}`);
}
{
  const c = run(['tools/refstamp.mjs', '--verify']);
  add('refstamp', c.status === 0, ((c.stdout || c.stderr || '').split('\n')[0] || '').trim());
}

/* 8 ------------------------------------------------- the gate that decides the project
 * `docs/LOOP.md` §5.7: "The blind test is the score. Everything in scores/history.jsonl is
 * a proxy that was picked for being cheap. When a proxy and the blind test disagree, the
 * proxy is wrong. It has disagreed once, by 9 pairs to nil." §5.6: "Run the blind test
 * every wave, not at the end ... Five waves were spent optimising proxies that a single
 * 30-minute blind test would have invalidated on day one."
 *
 * Measured: one human judgement (`waveH`, backfilled) against 14 scored runs. Neither
 * `docs/AGENT_BRIEF.md` nor any tool ever named `docs/LOOP.md`'s standing rules, and
 * nothing compared the two ledgers — so "every wave" had no reader and no counter.
 * Advisory and repo-wide (not per-report): whether the wave's gate has been run is the
 * orchestrator's call, but the last agent to finish is the one who can still say it. */
{
  const b = run(['tools/blindcheck.mjs', '--json']);
  let out = null;
  try { out = JSON.parse(b.stdout); } catch { }
  add('blind gate is current (LOOP §5.6)', out ? out.ok : true,
    out ? (out.ok ? out.summary : `${out.summary}. Unjudged: ${out.sinceTags.join(' ')} — node tools/blind.mjs --capture --contact`)
        : 'blindcheck did not report (skipped)');
}

/* ------------------------------------------------------------------------------ verdict */
const fails = results.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({ ok: fails.length === 0, report, checks: results }, null, 2));
  process.exit(strict && fails.length ? 1 : 0);
}

console.log(`postflight — ${report}\n`);
for (const r of results) {
  console[r.ok ? 'log' : 'error'](`${r.ok ? 'ok  ' : 'MISS'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}

if (!results.find((r) => r.name === 'R7 provenance block')?.ok) {
  console.log('\nPaste this at the top of your report (R7). Every field is filled from the capture');
  console.log('you already took; correct anything the machine guessed wrong:\n');
  console.log(provenanceBlock());
}

console.log(`\n${fails.length ? fails.length + ' advisory item(s)' : 'clean'} — postflight is advisory; it has never failed a build.`);
process.exit(strict && fails.length ? 1 : 0);
